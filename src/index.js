/**
 * dsh-wechat-workbench — WeChat remote workbench plugin for DeepSeek Harness.
 *
 * Turns one bound WeChat conversation into a second client of the same
 * workbench the Web GUI serves: browse workspaces, switch sessions, continue
 * conversations, watch progress, and answer agent questions — all through the
 * iLink Bot long connection (community wechat-agent-sdk transport child).
 *
 * Composition:
 *   WeChat ⇄ python/transport.py (child) ⇄ this plugin (Cordis, in-process)
 *     ├─ ctx.workspaceController  — workspace navigation projection
 *     ├─ ctx.sessionController    — list / create / prompt / page / follow
 *     └─ ctx.userQuestions        — 'user-questions/request' answerer
 *
 * @module dsh-wechat-workbench
 */

import Schema from '@deepseek-ai/schemastery'
import path from 'node:path'
import fs from 'node:fs'
import os from 'node:os'
import { PointerStore } from './pointer.js'
import { Router } from './router.js'
import { WeChatAnswerer } from './answerer.js'
import { WeChatTransportChild } from './transport.js'
import { AtDeskMonitor } from './atdesk.js'
import { registerNotifyTool } from './notify-tool.js'

export const name = 'dsh-wechat-workbench'

// The loader reads `Config` (capital C) from the plugin module
// (vendor/cordis registry.ts: `Config: plugin.Config`); without it the raw
// row config passes through unvalidated and schema defaults never fill.
// `config` stays as an alias for readers.
const schema = Schema.object({
  allowWxids: Schema.array(Schema.string())
    .default([])
    .volatile()
    .description('允许操控本机的微信 wxid 白名单；空 = 拒绝所有人（fail-closed）'),
  allowGroups: Schema.boolean()
    .default(false)
    .volatile()
    .description('是否响应群聊消息（需 @机器人；发送者需在白名单）'),
  bootstrap: Schema.boolean()
    .default(false)
    .volatile()
    .description('引导模式：不执行任何指令，只回复来信号的 wxid，便于配置 allowWxids'),
  approvalMode: Schema.string()
    .default('wechat-driven')
    .volatile()
    .description("审批通道范围：'wechat-driven' 只接管微信驱动会话的问题；'all' 把微信作为所有会话的审批通道（配合 /atdesk 开关）"),
  idleAwayMinutes: Schema.number()
    .default(5)
    .volatile()
    .description('自动判定：键鼠空闲超过该分钟数 = 不在电脑，审批自动转微信（approvalMode=all 时生效）'),
  pythonBin: Schema.string()
    .default('python3')
    .description('运行 iLink 传输子进程的 Python 解释器（改动需重启生效）'),
  accountId: Schema.string()
    .default('dsh')
    .description('wechat-agent-sdk 的 iLink 账号 id（token 持久化键；改动需重启生效）'),
  answerTimeoutMs: Schema.number()
    .default(600_000)
    .volatile()
    .description('等待微信端回答审批/问题的超时（毫秒），超时回退 GUI'),
})

export const Config = schema
export const config = schema

/**
 * Read a config field that may be a live volatile reference (`{ get() }`,
 * swapped in place by the loader on form edits) or a plain value (direct
 * mounts, tests).
 * @param {unknown} field - one Config field's runtime value.
 * @returns the field's current value.
 */
export function readLiveField(field) {
  return field !== null && typeof field === 'object' && typeof field.get === 'function' ? field.get() : field
}

export const inject = ['sessionController', 'workspaceController', 'userQuestions', 'sessionQuery', 'tools']

/** Sessions currently driven from WeChat (for the answerer's claim rule). */
const wechatDrivenSessions = new Set()

export function apply(ctx, config) {
  const logger = ctx.logger
  // The loader validates through Config and later commits volatile updates
  // into this same object; re-normalizing would fork the reference and lose
  // them. Normalize only when mounted without the loader (tests, direct use).
  if (typeof config !== 'object' || config.allowWxids === undefined) config = schema(config ?? {})

  // Volatile fields arrive as live references ({ get() }) whose values the
  // loader swaps in place; plain values otherwise (direct mounts, tests).
  const live = readLiveField
  const wxids = () => live(config.allowWxids) ?? []

  if (wxids().length === 0 && !live(config.bootstrap)) {
    logger.warn(
      'wechat-workbench: allowWxids 为空且未开 bootstrap，所有微信消息都会被拒绝。'
      + ' 在工作台「插件」页的表单里配置 wechat-workbench.allowWxids（保存即生效），'
      + ' 或临时设 bootstrap: true 查看你的 wxid。',
    )
  }
  if (wxids().length === 0) {
    logger.warn('wechat-workbench: 引导模式（bootstrap）——只回复 wxid，不执行任何指令。')
  }

  // Pointer persistence under the DSH home (falls back to a dotdir).
  const home = process.env.DSH_HOME
    ?? path.join(os.homedir(), '.dsh')
  const storeDir = path.join(home, 'wechat-workbench')
  fs.mkdirSync(storeDir, { recursive: true })
  const pointers = new PointerStore(path.join(storeDir, 'pointers.json'))

  const transport = new WeChatTransportChild(ctx, {
    pythonBin: config.pythonBin,
    accountId: config.accountId,
  })

  /** The approval channel: last authorized DM conversation that messaged us. */
  let primaryConversationId = null

  // Automatic at-desk detection: keyboard/mouse idle beyond the threshold
  // means the user is away and approvals route to WeChat. A manual override
  // (via /atdesk on|off) wins until /atdesk auto clears it.
  const monitor = new AtDeskMonitor({
    logger,
    idleAwaySeconds: () => Math.max(1, live(config.idleAwayMinutes) ?? 5) * 60,
  })
  let manualAtDesk = null // null = automatic
  const atDeskController = {
    get manualOverride() { return manualAtDesk },
    current: () => manualAtDesk !== null ? manualAtDesk : monitor.atDesk,
    setManual: (value) => { manualAtDesk = value },
    clearManual: () => { manualAtDesk = null },
    describe: () => (manualAtDesk !== null
      ? '手动固定'
      : `键鼠空闲 ${live(config.idleAwayMinutes) ?? 5} 分钟自动切换${monitor.state === null ? '（当前平台不支持，默认判定在电脑前）' : ''}`),
  }
  monitor.start()
  ctx.effect(() => () => monitor.stop())

  const answerer = new WeChatAnswerer({
    ctx,
    transport,
    conversationFor: (sessionId) => {
      if (!wechatDrivenSessions.has(sessionId)) return null
      for (const [conversationId, pointer] of pointers.pointers) {
        if (pointer.sessionId === sessionId) return conversationId
      }
      return null
    },
    primaryConversation: () => primaryConversationId,
    approvalMode: () => live(config.approvalMode) ?? 'wechat-driven',
    isAtDesk: () => atDeskController.current(),
    timeoutMs: () => live(config.answerTimeoutMs) ?? 600_000,
  })
  answerer.register()

  // Any session's agent can proactively push a message to the user's WeChat
  // approval channel (the last authorized DM conversation).
  registerNotifyTool(ctx, {
    transport,
    getPrimary: () => primaryConversationId,
  })

  const router = new Router({
    ctx,
    pointers,
    transport,
    noteSession: (sessionId) => wechatDrivenSessions.add(sessionId),
    answerer,
    atDeskController,
    channelState: () => `审批通道: ${(live(config.approvalMode) ?? 'wechat-driven') === 'all' ? '所有会话（离席时）' : '仅微信驱动的会话'}；${atDeskController.describe()}`,
  })

  transport.on('login', ({ qrUrl }) => {
    logger.warn(`wechat-workbench: 请用微信扫码登录 iLink：${qrUrl}`)
    // Direct write: guaranteed visible even if the host filters logger output.
    process.stderr.write(
      `\n[wechat-workbench] 请用微信扫码登录（或用微信打开链接）：\n${qrUrl}\n\n`,
    )
  })
  transport.on('ready', () => {
    logger.info('wechat-workbench: iLink 长连接已建立，微信工作台就绪')
  })
  transport.on('error', ({ message }) => {
    logger.error(`wechat-workbench: 传输错误：${message}`)
  })

  transport.on('message', async (message) => {
    const { conversationId, senderId, senderName, groupId, isAtBot, text } = message
    // Guaranteed-visibility receipt marker: distinguishes "message never
    // arrived" from "arrived but processing failed".
    process.stderr.write(
      `[wechat-workbench] 收到微信消息 from=${conversationId} text=${JSON.stringify((text ?? '').slice(0, 50))}\n`,
    )
    try {
      if (live(config.bootstrap) && wxids().length === 0) {
        logger.warn(
          `wechat-workbench: [bootstrap] 收到消息 conversation=${conversationId} sender=${senderId} (${senderName})`,
        )
        transport.send(conversationId,
          `🧭 引导模式：你的会话标识是 ${conversationId}${groupId !== null ? `（群内发送者 ${senderId}）` : ''}。`
          + '把它配置到 wechat-workbench.allowWxids 并关闭 bootstrap 即可启用。')
        return
      }
      // Fail-closed authorization (read live: allowWxids/allowGroups are
      // volatile and may change through the workbench form at any time).
      const peerAllowed = conversationId !== null && wxids().includes(conversationId)
      const groupAllowed = live(config.allowGroups) && groupId !== null
        && (wxids().includes(senderId) || wxids().includes(senderName))
      if (!peerAllowed && !groupAllowed) {
        logger.warn(`wechat-workbench: 拒绝未授权消息 from=${conversationId} sender=${senderId}`)
        transport.send(conversationId, '⛔ 未授权。')
        return
      }
      if (groupId !== null && !isAtBot) return
      if (groupId === null) primaryConversationId = conversationId // approval channel
      const trimmed = (text ?? '').trim()
      if (!trimmed) return

      // Pending questions take precedence over commands/prompts.
      if (answerer.answer(conversationId, trimmed)) return

      const reply = await router.handle({ conversationId, text: trimmed, groupId, isAtBot })
      if (reply) transport.send(conversationId, reply)
    } catch (error) {
      logger.error(`wechat-workbench: message handling failed: ${error}`)
      transport.send(conversationId, `⚠️ 处理失败：${error}`)
    }
  })

  ctx.effect(() => {
    transport.start()
    return () => {
      transport.kill()
      wechatDrivenSessions.clear()
    }
  })
}
