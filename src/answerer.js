/**
 * WeChat answerer on the user-questions waterfall.
 *
 * DSH surfaces every human decision (ask_user_question tool calls, plan
 * reviews, permission prompts routed through ctx.userQuestions) on the
 * `user-questions/request` waterfall. The Web GUI registers its answerer
 * there; this plugin registers a second one. Claiming rule: only questions
 * from sessions currently driven by WeChat are answered from WeChat —
 * everything else falls through with `next()` so the GUI keeps working
 * exactly as before.
 */

const ANSWER_TIMEOUT_MS_DEFAULT = 10 * 60_000

/**
 * @param {any} question - one AskUserQuestionItem.
 */
export function formatQuestion(question) {
  const lines = []
  if (question.header) lines.push(`【${question.header}】`)
  lines.push(question.question ?? '')
  if (question.detail) lines.push(String(question.detail).slice(0, 1_500))
  const options = question.options ?? []
  if (options.length > 0) {
    lines.push(options.map((/** @type {any} */ o, /** @type {number} */ i) => `${i + 1}. ${o.label}${o.description ? ` — ${o.description}` : ''}`).join('\n'))
    lines.push('回复序号或选项文字；也可直接输入自定义内容。')
  } else {
    lines.push('直接回复你的答案。')
  }
  return lines.filter(Boolean).join('\n')
}

/**
 * Parse a WeChat reply against one question's options.
 * @returns {{ selected: string[], custom?: string }}
 */
export function matchAnswer(reply, question) {
  const text = reply.trim()
  const options = question.options ?? []
  const approve = question.intent?.approve
  if (/^(y|yes|好|同意|批准|approve)$/i.test(text) && approve) {
    return { selected: [approve] }
  }
  if (/^(n|no|拒绝|不同意|deny)$/i.test(text) && approve && options.length > 1) {
    const other = options.find((/** @type {any} */ o) => o.label !== approve)
    if (other) return { selected: [other.label] }
  }
  const numeric = Number.parseInt(text, 10)
  if (Number.isInteger(numeric) && numeric >= 1 && numeric <= options.length) {
    return { selected: [options[numeric - 1].label] }
  }
  const byLabel = options.find((/** @type {any} */ o) => o.label === text)
  if (byLabel) return { selected: [byLabel.label] }
  return { selected: [], custom: text }
}

export class WeChatAnswerer {
  /**
   * @param {object} args
   * @param {import('@deepseek-ai/cordis').Context} args.ctx
   * @param {import('./transport.js').WeChatTransportChild} args.transport
   * @param {(sessionId: string) => string | null} args.conversationFor -
   *        map an asking session to its bound WeChat conversation, if any.
   * @param {() => string | null} args.primaryConversation -
   *        the approval-channel conversation (last authorized active chat).
   * @param {'wechat-driven' | 'all'} [args.approvalMode] -
   *        'all' turns WeChat into the approval channel for every session.
   * @param {() => boolean} [args.isAtDesk] -
   *        live at-desk state; away + approvalMode 'all' routes approvals here.
   * @param {number} [args.timeoutMs]
   */
  constructor({ ctx, transport, conversationFor, primaryConversation, approvalMode, isAtDesk, timeoutMs }) {
    this.ctx = ctx
    this.transport = transport
    this.conversationFor = conversationFor
    this.primaryConversation = primaryConversation
    this.approvalMode = approvalMode ?? 'wechat-driven'
    /** Live provider so automatic idle detection updates instantly. */
    this.isAtDesk = isAtDesk ?? (() => true)
    this.timeoutMs = timeoutMs ?? ANSWER_TIMEOUT_MS_DEFAULT
    /** @type {Map<string, {resolve: (v: string) => void, question: any}>} pending replies by conversation */
    this.pending = new Map()
  }

  register() {
    this.ctx.on('user-questions/request', async (request, next) => {
      const agentId = request.agent?.id
      const bound = agentId ? this.conversationFor(agentId) : null
      // Claim rule:
      //  - sessions WeChat drives -> always ours.
      //  - otherwise (approvalMode 'all', user away) -> route to the primary
      //    conversation as the approval channel.
      const awayChannel = this.approvalMode === 'all' && !this.isAtDesk()
        ? this.primaryConversation() : null
      const conversationId = bound ?? awayChannel
      if (!conversationId) return next() // GUI-owned question -> GUI answers

      const question = request.questions[0]
      const previous = this.pending.get(conversationId)
      if (previous) previous.resolve('') // superseded by a newer question

      const prompt = formatQuestion(question)
      const source = bound ? '' : '（电脑端会话请求）'
      this.transport.send(conversationId, `❓ 需要你的决定${source}：\n${prompt}`)

      const reply = await new Promise((resolve) => {
        this.pending.set(conversationId, { resolve, question })
        const timer = setTimeout(() => resolve(null), this.timeoutMs)
        timer.unref?.()
      })
      this.pending.delete(conversationId)
      if (reply === null) {
        this.transport.send(conversationId, '⌛ 等待超时，该问题已回退到 GUI 处理。')
        return next()
      }
      if (reply === '') {
        // Superseded: answer with a neutral skip so the newer question wins.
        return { answers: request.questions.map((/** @type {any} */ q) => ({ id: q.id, selected: [] })) }
      }
      const answers = request.questions.map((/** @type {any} */ q) => {
        const matched = q === question ? matchAnswer(reply, q) : { selected: [] }
        return { id: q.id, ...matched }
      })
      this.transport.send(conversationId, '✅ 已提交你的回答。')
      return { answers }
    })
  }

  /** Resolve a pending question with the incoming message text. */
  answer(conversationId, text) {
    const entry = this.pending.get(conversationId)
    if (!entry) return false
    entry.resolve(text)
    return true
  }
}
