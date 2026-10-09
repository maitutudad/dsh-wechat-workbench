/**
 * Session follower: progress summaries + final reply for WeChat.
 *
 * Subscribes to `ctx.sessionController.follow()` for one session and forwards
 * two kinds of pushes to the WeChat conversations bound to it:
 *  - rate-limited progress lines for tool activity (event `type` starting
 *    with `tool/`), and
 *  - the final assistant text once the turn ends (`turn/end` + the last
 *    committed `assistant/message`).
 *
 * The same durable session is simultaneously visible in the Web GUI; this
 * module only observes, it never mutates session state.
 */

const PROGRESS_MIN_INTERVAL_MS = 15_000
const MAX_PROGRESS_QUEUED = 5

/**
 * @param {any} event - one SessionWireEvent.
 * @returns {string | null} one-line human summary, or null if not summarizable.
 */
export function summarizeEvent(event) {
  if (!event || typeof event.type !== 'string') return null
  const data = (event.data ?? {})
  if (event.type.startsWith('tool/')) {
    const name = data.toolName ?? data.name ?? data.title ?? data.tool ?? null
    if (event.type === 'tool/begin' || event.type === 'tool/start' || event.type === 'tool/call') {
      return name ? `🔧 ${name}` : '🔧 工具调用'
    }
    return null
  }
  return null
}

/** Extract assistant text from an assistant message event, best effort. */
export function assistantText(event) {
  if (event?.type !== 'assistant/message' && event?.type !== 'assistant/attempt') return null
  const data = event?.data ?? {}
  // Canonical durable shape: data.message.content = content blocks.
  if (Array.isArray(data.message?.content)) {
    const text = data.message.content
      .filter((/** @type {any} */ block) => block?.type === 'text' && typeof block.text === 'string')
      .map((/** @type {any} */ block) => block.text)
      .join('')
    if (text) return text
  }
  if (typeof data.text === 'string') return data.text
  if (typeof data.content === 'string') return data.content
  if (Array.isArray(data.content)) {
    return data.content
      .filter((/** @type {any} */ block) => block?.type === 'text' && typeof block.text === 'string')
      .map((/** @type {any} */ block) => block.text)
      .join('\n')
  }
  return null
}

export class SessionFollower {
  /**
   * @param {object} args
   * @param {import('@deepseek-ai/cordis').Context} args.ctx
   * @param {string} args.sessionId
   * @param {(text: string) => void} args.push - deliver one WeChat message
   */
  constructor({ ctx, sessionId, push }) {
    this.ctx = ctx
    this.sessionId = sessionId
    this.push = push
    this.controller = new AbortController()
    this.lastProgressAt = 0
    this.queuedProgress = 0
    this.lastAssistantText = null
    this.running = false
    /** True while the current turn was initiated from WeChat. */
    this.wechatTurn = false
  }

  /** Mark the current turn WeChat-initiated: its replies are pushed. */
  beginWechatTurn() {
    this.wechatTurn = true
  }

  stop() {
    this.controller.abort()
  }

  async run() {
    this.running = true
    try {
      const follow = this.ctx.sessionController.follow(
        // SessionFollowRequest requires a SessionAddress, not a bare id.
        { address: { kind: 'session', sessionId: this.sessionId }, maxMessages: 500 },
        this.controller.signal,
      )
      for await (const frame of follow) {
        if (this.controller.signal.aborted) break
        this.handleFrame(frame)
      }
    } catch (error) {
      if (this.controller.signal.aborted) return
      // Full stack to the terminal: message text alone hides which host
      // internal actually threw.
      process.stderr.write(
        `[wechat-remote] 会话跟随中断，回退为轮询模式。stack:\n${error?.stack ?? String(error)}\n`,
      )
      await this.pollLoop()
    } finally {
      this.running = false
    }
  }

  /**
   * Fallback delivery: poll the durable log via ctx.sessionQuery.readSession
   * and process only events beyond the last seen seq. Keeps final-reply
   * delivery working even when the follow stream is unavailable.
   */
  async pollLoop() {
    this.push('ℹ️ 实时跟随不可用，已切换为轮询模式（最终回复仍会送达）。')
    while (!this.controller.signal.aborted) {
      try {
        const snapshot = await this.ctx.sessionQuery.readSession(this.sessionId)
        for (const event of snapshot?.events ?? []) {
          const seq = typeof event?.seq === 'number' ? event.seq : 0
          if (seq <= (this.lastPolledSeq ?? 0)) continue
          this.handleEvent(event)
          this.lastPolledSeq = Math.max(this.lastPolledSeq ?? 0, seq)
        }
      } catch (error) {
        process.stderr.write(`[wechat-remote] 轮询读取失败（继续重试）：${error}\n`)
      }
      await new Promise((resolve) => {
        const timer = setTimeout(resolve, 3_000)
        timer.unref?.()
      })
    }
  }

  /** Accept both `{event}` frames and opening snapshots carrying event records. */
  handleFrame(frame) {
    const records = []
    if (frame && typeof frame === 'object') {
      if (frame.event) records.push(frame.event)
      if (Array.isArray(frame.events)) records.push(...frame.events)
      if (Array.isArray(frame.records)) records.push(...frame.records)
    }
    for (const event of records) this.handleEvent(event)
  }

  handleEvent(event) {
    if (!event || typeof event.type !== 'string') return
    if (event.type === 'assistant/message' || event.type === 'assistant/attempt') {
      const text = assistantText(event)
      if (typeof text === 'string' && text.trim()) this.lastAssistantText = text
      return
    }
    if (event.type === 'turn/end') {
      const reason = event.data?.reason?.kind ?? 'completed'
      const fromWechat = this.wechatTurn
      this.wechatTurn = false
      const text = (this.lastAssistantText ?? '').trim()
      this.lastAssistantText = null
      this.queuedProgress = 0
      if (!fromWechat) return // GUI-initiated turn: keep WeChat quiet
      this.push(text || `（本轮结束：${reason}，无文本输出）`)
      return
    }
    const summary = summarizeEvent(event)
    if (summary && this.wechatTurn) this.pushThrottled(summary)
  }

  pushThrottled(text) {
    const now = Date.now()
    if (this.queuedProgress >= MAX_PROGRESS_QUEUED) return
    if (now - this.lastProgressAt >= PROGRESS_MIN_INTERVAL_MS) {
      this.lastProgressAt = now
      this.queuedProgress += 1
      this.push(text)
    }
  }
}
