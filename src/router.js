/**
 * WeChat command router: workbench navigation + free-text prompts.
 *
 * Commands mirror the Web workbench navigation model. A conversation holds a
 * pointer {workspaceId, sessionId}; free text is admitted as an ordinary
 * follow-up prompt on the pointed session via ctx.sessionController.prompt,
 * exactly like typing into the Web composer.
 */

import fs from 'node:fs'
import { SessionFollower } from './progress.js'

const HELP = [
  '📖 WeChat 工作台命令：',
  '  /ws — 列出工作区',
  '  /cd <n> — 切换当前工作区',
  '  /ss — 列出当前工作区的会话',
  '  /ss <n> — 切换到该会话继续对话',
  '  /new [标题] — 在当前工作区新建会话',
  '  /tail [n] — 查看当前会话最近 n 条记录',
  '  /info — 当前指针与运行状态',
  '  直接发文字 = 向当前会话发送消息（与 GUI 同一条时间线）',
].join('\n')

/**
 * @param {string} text
 */
export function parseCommand(text) {
  const trimmed = text.trim()
  if (!trimmed.startsWith('/')) return null
  const [head, ...rest] = trimmed.split(/\s+/)
  return { name: head.toLowerCase(), arg: rest.join(' ') }
}

export class Router {
  /**
   * @param {object} args
   * @param {import('@deepseek-ai/cordis').Context} args.ctx
   * @param {import('./pointer.js').PointerStore} args.pointers
   * @param {import('./transport.js').WeChatTransportChild} args.transport
   * @param {(sessionId: string) => void} args.noteSession - track WeChat-driven sessions
   */
  constructor({ ctx, pointers, transport, noteSession, answerer, atDeskController }) {
    this.ctx = ctx
    this.pointers = pointers
    this.transport = transport
    this.noteSession = noteSession
    this.answerer = answerer ?? null
    this.atDeskController = atDeskController ?? null
    /** @type {Map<string, SessionFollower>} sessionId -> follower */
    this.followers = new Map()
    /** @type {Map<string, Set<string>>} sessionId -> conversation ids */
    this.subscribers = new Map()
    /** In-flight prompts per conversation for /status style feedback. */
    this.busy = new Set()
  }

  // ------------------------------------------------------------------
  // Entry point: one parsed WeChat message.
  // ------------------------------------------------------------------
  /**
   * @param {{conversationId: string, text: string, groupId: string | null, isAtBot: boolean}} message
   */
  async handle(message) {
    const command = parseCommand(message.text)
    try {
      if (command) return await this.dispatch(message, command)
      return await this.prompt(message)
    } catch (error) {
      return `⚠️ ${error}`
    }
  }

  /**
   * @param {{conversationId: string}} message
   * @param {{name: string, arg: string}} command
   */
  async dispatch(message, command) {
    switch (command.name) {
      case '/help': case '/？': case '/h':
        return HELP
      case '/ws':
        return this.listWorkspaces(message.conversationId)
      case '/cd':
        return this.switchWorkspace(message.conversationId, command.arg)
      case '/ss':
        return command.arg ? this.switchSession(message.conversationId, command.arg) : this.listSessions(message.conversationId)
      case '/new':
        return this.createSession(message.conversationId, command.arg)
      case '/tail':
        return this.tail(message.conversationId, command.arg)
      case '/info':
        return this.info(message.conversationId)
      case '/atdesk': {
        const ctl = this.atDeskController
        if (!ctl) return '审批通道不可用。'
        if (command.arg === 'on' || command.arg === 'off') {
          ctl.setManual(command.arg === 'on')
          return command.arg === 'on'
            ? '✅ 已手动固定：在电脑前，电脑端会话的问题由 GUI 处理。'
            : '✅ 已手动固定：微信审批通道开启，所有会话的问题都会发到这里。'
        }
        if (command.arg === 'auto') {
          ctl.clearManual()
          return `✅ 已恢复自动判断（当前判定：${ctl.current() ? '在电脑前' : '不在电脑'}）。`
        }
        const mode = ctl.manualOverride === null ? '自动' : '手动固定'
        return `当前：${ctl.current() ? '在电脑前' : '不在电脑'}（${mode}；${ctl.describe()}）\n/atdesk on|off 手动固定，/atdesk auto 恢复自动。`
      }
      default:
        return `未知命令 ${command.name}。\n${HELP}`
    }
  }

  // ------------------------------------------------------------------
  // Workspace / session navigation
  // ------------------------------------------------------------------

  /** Read the workspace-controller baseline projection (first follow frame). */
  async baseline() {
    const controller = new AbortController()
    try {
      const stream = this.ctx.workspaceController.follow(controller.signal)
      // The stream may never yield in some compositions; fail fast so the
      // command degrades instead of hanging the whole message handler.
      const timeout = new Promise((resolve) => setTimeout(resolve, 8_000, 'timeout'))
      const first = await Promise.race([stream[Symbol.asyncIterator]().next(), timeout])
      if (first === 'timeout' || first?.done) {
        throw new Error('workspaceController.follow 未在超时内给出 baseline')
      }
      return first.value
    } finally {
      controller.abort()
    }
  }

  /**
   * Extract [{id, name, sessionIds}] from a baseline frame.
   * Documented shape (dsh-api-workspace-controller types.ts):
   *   frame = { type: 'baseline', value: { items: WorkspaceView[] } }
   *   WorkspaceView = { workspaceId, path, title, sessionIds, ... }
   */
  workspacesFrom(frame) {
    const unwrapped = frame?.type === 'baseline' ? frame.value : frame
    const rows = unwrapped?.items ?? unwrapped?.workspaces
      ?? (Array.isArray(unwrapped) ? unwrapped : null)
    if (!Array.isArray(rows)) throw new Error('无法读取工作区投影（baseline 形状未知）')
    return rows.map((/** @type {any} */ row, /** @type {number} */ index) => ({
      id: row.workspaceId ?? row.id ?? String(index),
      name: row.title ?? row.name ?? row.path ?? `workspace-${index + 1}`,
      sessionIds: Array.isArray(row.sessionIds) ? row.sessionIds : [],
    }))
  }

  async listWorkspaces(conversationId) {
    let workspaces
    try {
      workspaces = this.workspacesFrom(await this.baseline())
    } catch (error) {
      // Degrade: derive a pseudo-workspace list from session cwds so /ws and
      // /cd still work when the projection stream is unavailable.
      const list = await this.ctx.sessionController.list({})
      const byCwd = new Map()
      for (const s of list.items ?? []) {
        const key = s.cwd ?? '(未知工作区)'
        if (!byCwd.has(key)) byCwd.set(key, [])
        byCwd.get(key).push(s)
      }
      const rows = [...byCwd.entries()]
      if (rows.length === 0) return '没有任何工作区或会话，请先在 GUI 里创建。'
      // Cache for /cd resolution.
      this.degradedWorkspaces = rows.map(([cwd, sessions]) => ({
        id: `cwd:${cwd}`,
        name: cwd,
        sessionIds: sessions.map((/** @type {any} */ s) => s.sessionId),
      }))
      const pointer = this.pointers.get(conversationId)
      const lines = rows.map((/** @type {[string, any[]]} */ [cwd, sessions], /** @type {number} */ i) => {
        const current = pointer.workspaceId === `cwd:${cwd}` ? ' ← 当前' : ''
        return `${i + 1}. ${cwd}（${sessions.length} 个会话）${current}`
      })
      return `🗂 工作区（降级模式：${error}）：\n${lines.join('\n')}\n用 /cd <序号> 切换`
    }
    const pointer = this.pointers.get(conversationId)
    const lines = workspaces.map((/** @type {any} */ ws, /** @type {number} */ i) => {
      const current = pointer.workspaceId === ws.id ? ' ← 当前' : ''
      return `${i + 1}. ${ws.name}（${ws.sessionIds.length} 个会话）${current}`
    })
    return `🗂 工作区：\n${lines.join('\n')}\n用 /cd <序号> 切换`
  }

  async switchWorkspace(conversationId, arg) {
    const index = Number.parseInt(arg, 10)
    if (!Number.isInteger(index) || index < 1) return '用法：/cd <序号>（先 /ws 查看）'
    let workspaces
    if (this.degradedWorkspaces) {
      workspaces = this.degradedWorkspaces
    } else {
      workspaces = this.workspacesFrom(await this.baseline())
    }
    const target = workspaces[index - 1]
    if (!target) return `没有第 ${index} 个工作区`
    const pointer = this.pointers.get(conversationId)
    pointer.workspaceId = target.id
    pointer.sessionId = undefined
    this.pointers.save()
    return `✅ 已切换到工作区「${target.name}」，会话指针已清空。/ss 查看会话`
  }

  async listSessions(conversationId) {
    const pointer = this.pointers.get(conversationId)
    const frame = await this.baseline()
    const workspaces = this.workspacesFrom(frame)
    const workspace = workspaces.find((/** @type {any} */ ws) => ws.id === pointer.workspaceId)
      ?? workspaces[0]
    if (!workspace) return '没有任何工作区，请先在 GUI 里创建。'
    const list = await this.ctx.sessionController.list({})
    const inWorkspace = (list.items ?? [])
      .filter((/** @type {any} */ s) => workspace.sessionIds.length === 0 || workspace.sessionIds.includes(s.sessionId))
      .sort((/** @type {any} */ a, /** @type {any} */ b) => b.updatedAt - a.updatedAt)
      .slice(0, 15)
    if (inWorkspace.length === 0) return `工作区「${workspace.name}」暂无会话，/new 新建一个。`
    const lines = inWorkspace.map((/** @type {any} */ s, /** @type {number} */ i) => {
      const current = pointer.sessionId === s.sessionId ? ' ← 当前' : ''
      const state = s.running ? '🏃运行中' : s.blank ? '空白' : relativeTime(s.updatedAt)
      return `${i + 1}. ${sessionTitle(s)}（${state}）${current}`
    })
    // Remember for /ss <n> resolution.
    this.lastListed = { conversationId, sessionIds: inWorkspace.map((/** @type {any} */ s) => s.sessionId), workspaceId: workspace.id }
    return `💬 工作区「${workspace.name}」的会话：\n${lines.join('\n')}\n/ss <序号> 切换续聊`
  }

  async switchSession(conversationId, arg) {
    const index = Number.parseInt(arg, 10)
    if (!Number.isInteger(index) || index < 1) return '用法：/ss <序号>（先 /ss 查看列表）'
    const listed = this.lastListed?.conversationId === conversationId ? this.lastListed : null
    if (!listed) return '请先 /ss 查看会话列表'
    const sessionId = listed.sessionIds[index - 1]
    if (!sessionId) return `列表里没有第 ${index} 个会话`
    const pointer = this.pointers.get(conversationId)
    pointer.workspaceId = listed.workspaceId
    pointer.sessionId = sessionId
    this.pointers.save()
    this.noteSession(sessionId)
    this.ensureFollower(sessionId, conversationId)
    return '✅ 已切换。现在直接发消息即可续聊（GUI 同步可见）'
  }

  async createSession(conversationId, title) {
    const pointer = this.pointers.get(conversationId)
    let workspaceId = pointer.workspaceId
    if (!workspaceId) {
      const workspaces = this.workspacesFrom(await this.baseline())
      if (workspaces.length === 0) return '没有工作区，请先在 GUI 里创建。'
      workspaceId = workspaces[0].id
      pointer.workspaceId = workspaceId
    }
    const created = await this.ctx.sessionController.create({ workspaceId })
    pointer.sessionId = created.sessionId
    this.pointers.save()
    this.noteSession(created.sessionId)
    this.ensureFollower(created.sessionId, conversationId)
    let reply = `🆕 已在工作区创建新会话，直接发消息开始。${title ? `\n（建议标题：${title}，可用 GUI 重命名）` : ''}`
    if (title) {
      try {
        await this.ctx.sessionController.rename({ sessionId: created.sessionId, title })
        reply = `🆕 已创建并命名会话「${title}」，直接发消息开始。`
      } catch { /* rename optional */ }
    }
    return reply
  }

  async tail(conversationId, arg) {
    const pointer = this.pointers.get(conversationId)
    if (!pointer.sessionId) return '当前没有选中会话，/ss 选择或 /new 新建。'
    const limit = Math.min(Math.max(Number.parseInt(arg, 10) || 5, 1), 20)
    // ctx.sessionQuery.readSession returns the whole durable log; filter the
    // tail of text-bearing user/assistant events.
    const snapshot = await this.ctx.sessionQuery.readSession(pointer.sessionId)
    const records = snapshot?.events ?? []
    const lines = []
    for (const event of records) {
      if (event?.type === 'assistant/message' || event?.type === 'user/message' || event?.type === 'user/turn') {
        const role = event.type.startsWith('assistant') ? '🤖' : '👤'
        const text = extractAnyText(event)
        if (text) lines.push(`${role} ${truncate(text, 200)}`)
      }
    }
    return lines.length ? `📜 最近记录：\n${lines.slice(-limit).join('\n')}` : '（没有可显示的文本记录）'
  }

  info(conversationId) {
    const pointer = this.pointers.get(conversationId)
    const busy = pointer.sessionId && this.busy.has(conversationId) ? '\n⏳ 上一条消息仍在处理中' : ''
    return `ℹ️ 工作区: ${pointer.workspaceId ?? '（未选择）'}\n会话: ${pointer.sessionId ?? '（未选择）'}${busy}`
  }

  // ------------------------------------------------------------------
  // Prompt flow
  // ------------------------------------------------------------------
  async prompt(message) {
    const conversationId = message.conversationId
    const pointer = this.pointers.get(conversationId)
    if (!pointer.sessionId) {
      // No session selected yet: create one in the current workspace and
      // continue sending the original text into it.
      const created = await this.createSession(conversationId, '')
      if (typeof created === 'string' && (created.startsWith('⚠️') || /没有.*工作区/.test(created))) {
        return created
      }
    }

    const requestId = `wx-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    const follower = this.ensureFollower(pointer.sessionId, conversationId)
    try {
      await this.ctx.sessionController.prompt(
        {
          requestId,
          sessionId: pointer.sessionId,
          mode: 'queue',
          content: buildContentParts(message.text, message.media),
        },
        new AbortController().signal,
      )
    } catch (error) {
      if (String(error).includes('requestId')) return '（该消息已在队列中）'
      throw error
    }
    this.noteSession(pointer.sessionId)
    follower.beginWechatTurn() // only WeChat-initiated turns push replies
    return null // replies arrive via the follower push
  }

  /**
   * One follower per session; multiple conversations may share it.
   */
  ensureFollower(sessionId, conversationId) {
    let set = this.subscribers.get(sessionId)
    if (!set) {
      set = new Set()
      this.subscribers.set(sessionId, set)
    }
    set.add(conversationId)
    let follower = this.followers.get(sessionId)
    if (!follower) {
      follower = new SessionFollower({
        ctx: this.ctx,
        sessionId,
        push: (text) => {
          for (const cid of this.subscribers.get(sessionId) ?? []) {
            this.transport.send(cid, text)
          }
        },
      })
      this.followers.set(sessionId, follower)
      void follower.run()
    }
    return follower
  }
}

// ----------------------------------------------------------------------
// Small display helpers
// ----------------------------------------------------------------------

const MAX_INLINE_IMAGE_BYTES = 20 * 1024 * 1024 // DSH image intake limit

/**
 * Build PromptContentPart[] from a WeChat message: images become inline
 * base64 image parts (DSH intake limit applies), other files are referenced
 * by their on-disk path so the agent's fs tools can read them.
 * @param {string} text
 * @param {Array<{path: string, fileName?: string, kind?: string, mediaType?: string, bytes?: number}> | undefined} media
 */
function buildContentParts(text, media) {
  const parts = [{ type: 'text', text }]
  const notes = []
  for (const entry of media ?? []) {
    try {
      if (entry.kind === 'image' && (entry.bytes ?? 0) <= MAX_INLINE_IMAGE_BYTES) {
        const data = fs.readFileSync(entry.path)
        parts.push({
          type: 'image',
          mediaType: entry.mediaType || 'image/png',
          data: data.toString('base64'),
          name: entry.fileName,
        })
        continue
      }
      notes.push(`[附件已保存: ${entry.path}${entry.fileName ? `（文件名 ${entry.fileName}）` : ''}]`)
    } catch (error) {
      notes.push(`[附件读取失败: ${entry.path}: ${error}]`)
    }
  }
  if (notes.length > 0) parts[0].text = `${text}\n${notes.join('\n')}`
  return parts
}


function sessionTitle(summary) {
  const hint = summary?.projections?.title?.text ?? summary?.projections?.title
  ?? summary?.title
  return typeof hint === 'string' && hint.trim() ? truncate(hint, 30) : truncate(summary.sessionId, 12)
}

function extractAnyText(event) {
  const data = event?.data ?? {}
  if (typeof data.text === 'string') return data.text
  if (typeof data.content === 'string') return data.content
  if (Array.isArray(data.content)) {
    return data.content.map((/** @type {any} */ b) => (b?.type === 'text' ? b.text : '')).join('')
  }
  return null
}

function truncate(text, max) {
  return text.length > max ? `${text.slice(0, max)}…` : text
}

function relativeTime(ms) {
  const delta = Date.now() - ms
  if (delta < 60_000) return '刚刚活跃'
  if (delta < 3_600_000) return `${Math.floor(delta / 60_000)} 分钟前`
  if (delta < 86_400_000) return `${Math.floor(delta / 3_600_000)} 小时前`
  return `${Math.floor(delta / 86_400_000)} 天前`
}
