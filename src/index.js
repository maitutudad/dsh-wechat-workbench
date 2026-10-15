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
import { resolvePythonBin } from './python-setup.js'

export const name = 'dsh-wechat-workbench'

// The loader reads `Config` (capital C) from the plugin module
// (vendor/cordis registry.ts: `Config: plugin.Config`); without it the raw
// row config passes through unvalidated and schema defaults never fill.
// `config` stays as an alias for readers.
const schema = Schema.object({
  allowWxids: Schema.array(Schema.string())
    .default([])
    .volatile()
    .description('允许使用的微信 ID 列表，空格分隔；只有名单里的微信能操作机器人，空 = 全部拒绝'),
  bootstrap: Schema.boolean()
    .default(false)
    .volatile()
    .description('首次绑定助手：开启后不执行任何指令，只回复来信号的微信 ID，便于填入 allowWxids；配置完请关闭'),
  approvalMode: Schema.string()
    .default('wechat-driven')
    .volatile()
    .description("哪些提问推到微信：'wechat-driven' 仅微信里发起的会话；'all' 离开电脑后全部会话（配合 /atdesk 开关）"),
  idleAwayMinutes: Schema.number()
    .default(5)
    .volatile()
    .description('自动判定：键鼠空闲超过该分钟数 = 不在电脑，审批自动转微信（approvalMode=all 时生效）'),
  pythonBin: Schema.string()
    .default('python3')
    .description('运行 iLink 传输子进程的 Python 解释器；默认 python3 时自动使用/创建插件自带的 .venv（改动需重启生效）'),
  autoSetupPython: Schema.boolean()
    .default(true)
    .description('pythonBin 为默认值且 .venv 不存在时，首次启动自动创建虚拟环境并从 PyPI 安装依赖（改动需重启生效）'),
  pipIndexUrl: Schema.string()
    .default('')
    .description('自动安装 Python 依赖时使用的 pip 镜像（如 https://pypi.tuna.tsinghua.edu.cn/simple；留空用官方 PyPI；改动需重启生效）'),
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

export const inject = ['sessionController', 'workspaceController', 'userQuestions', 'sessionQuery', 'tools', 'connection']

/**
 * Sessions currently driven from WeChat (for the answerer's claim rule).
 * Durable-backed: a plugin reload (hot config edit) must not silently hand
 * WeChat-driven sessions' questions back to the GUI, so the set hydrates
 * from disk at startup and persists on every mark.
 */
class DrivenSessions {
  /** @param {string} file */
  constructor(file) {
    this.file = file
    /** @type {Set<string>} */
    this.sessions = new Set()
    try {
      const parsed = JSON.parse(fs.readFileSync(file, 'utf8'))
      for (const id of Array.isArray(parsed) ? parsed : []) this.sessions.add(id)
    } catch { /* missing or corrupt file: start empty */ }
  }

  has(id) { return this.sessions.has(id) }

  add(id) {
    if (this.sessions.has(id)) return
    this.sessions.add(id)
    try {
      fs.writeFileSync(this.file, JSON.stringify([...this.sessions], null, 2))
    } catch { /* best-effort persistence */ }
  }
}

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
  const wechatDrivenSessions = new DrivenSessions(path.join(storeDir, 'driven-sessions.json'))

  const transport = new WeChatTransportChild(ctx, {
    pythonBin: resolvePythonBin({
      pythonBin: config.pythonBin,
      autoSetupPython: config.autoSetupPython,
      pipIndexUrl: config.pipIndexUrl,
    }, (m) => logger.warn(m)),
    accountId: config.accountId,
  })

  /** The approval channel: last authorized DM conversation that messaged us. */
  let primaryConversationId = null

  /** Login/connection state for the Web detail panel's status route. */
  const loginState = { state: 'connecting', qrUrl: null, qrSvg: null, qrAt: 0, message: null }

  // Authenticated same-origin status endpoint for the client companion's
  // detail panel (the connection carrier applies browser auth before fetch).
  const statusBody = () => JSON.stringify({
    state: loginState.state,
    qrUrl: loginState.qrUrl,
    qrSvg: loginState.qrSvg,
      qrAt: loginState.qrAt,
    message: loginState.message,
    allowWxids: wxids(),
    approvalMode: live(config.approvalMode) ?? 'wechat-driven',
    atDesk: atDeskController.current(),
  })
  const json = (body, status = 200) => new Response(body, { status, headers: { 'content-type': 'application/json' } })
  ctx.effect(() => ctx.connection.fetch.register({
    path: '/api/wechat-workbench/status',
    methods: ['GET', 'POST'],
    requestBody: 'buffered',
    fetch: async (request) => {
      if (request.method === 'GET') return json(statusBody())
      let action = ''
      try {
        action = String((await request.json()).action ?? '')
      } catch { /* empty body: refuse below */ }
      if (action === 'reconnect') {
        loginState.state = 'connecting'
        loginState.message = null
        transport.restart()
        return json(statusBody())
      }
      if (action === 'logout') {
        // The child clears the stored token and exits; the automatic restart
        // then requires a fresh QR scan.
        loginState.state = 'connecting'
        loginState.message = '已清除令牌，等待重新扫码'
        transport.write({ op: 'logout' })
        return json(statusBody())
      }
      return json(JSON.stringify({ error: 'unknown action' }), 400)
    },
  }), 'wechat-workbench: status route')

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

  // Host settings service (same layer the workbench would write): /config
  // edits persist to the profile patch and hot-apply through volatile fields.
  const settings = ctx.get('settings')

  const router = new Router({
    ctx,
    pointers,
    transport,
    noteSession: (sessionId) => wechatDrivenSessions.add(sessionId),
    answerer,
    atDeskController,
    channelState: () => `审批通道: ${(live(config.approvalMode) ?? 'wechat-driven') === 'all' ? '所有会话（离席时）' : '仅微信驱动的会话'}；${atDeskController.describe()}`,
    inbound: {
      allowed: wxids,
      bootstrap: () => Boolean(live(config.bootstrap)),
      setPrimary: (id) => { primaryConversationId = id },
    },
    configWriter: settings === undefined ? undefined : {
      read: () => ({
        allowWxids: wxids(),
        bootstrap: Boolean(live(config.bootstrap)),
        approvalMode: live(config.approvalMode) ?? 'wechat-driven',
        idleAwayMinutes: live(config.idleAwayMinutes) ?? 5,
        answerTimeoutMs: live(config.answerTimeoutMs) ?? 600_000,
      }),
      update: (patch) => settings.update('wechat-workbench', patch),
    },
  })

  transport.on('login', ({ qrUrl, qrSvg }) => {
    loginState.state = 'login'
    loginState.qrUrl = qrUrl ?? null
    loginState.qrSvg = qrSvg ?? null
    loginState.qrAt = Date.now()
    logger.warn(`wechat-workbench: 请用微信扫码登录 iLink：${qrUrl}`)
    // Direct write: guaranteed visible even if the host filters logger output.
    process.stderr.write(
      `\n[wechat-workbench] 请用微信扫码登录（或用微信打开链接）：\n${qrUrl}\n\n`,
    )
  })
  transport.on('ready', () => {
    loginState.state = 'ready'
    loginState.qrUrl = null
    loginState.qrSvg = null
    loginState.qrAt = 0
    loginState.message = null
    logger.info('wechat-workbench: iLink 长连接已建立，微信工作台就绪')
  })
  transport.on('error', ({ message }) => {
    loginState.state = 'error'
    loginState.message = message ?? null
    logger.error(`wechat-workbench: 传输错误：${message}`)
  })

  transport.on('message', (message) => {
    // The full op object flows through one tested entry point (Router
    // .handleInbound); wiring here must not drop fields.
    void router.handleInbound(message)
  })

  ctx.effect(() => {
    transport.start()
    return () => {
      transport.kill()
      // wechatDrivenSessions intentionally survives: it is durable-backed so
      // a hot plugin reload keeps WeChat-driven sessions' questions claimed
      // here instead of silently falling back to the GUI.
    }
  })
}
