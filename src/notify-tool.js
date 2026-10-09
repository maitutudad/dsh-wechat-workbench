/**
 * `wechat_notify` — model-facing tool that lets ANY session's agent push a
 * proactive message to the user's WeChat approval channel (the last
 * authorized DM conversation). Complements the approval waterfall: questions
 * route through `user-questions/request`; this tool covers unprompted
 * notifications such as task completion, failures, or requested progress.
 *
 * The channel is available whenever the user has messaged the bot at least
 * once (that conversation becomes the notification target).
 */

import { defineTool } from '@deepseek-ai/dsh-tools'

/**
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {object} args
 * @param {import('./transport.js').WeChatTransportChild} args.transport
 * @param {() => string | null} args.getPrimary - notification target conversation.
 */
export function registerNotifyTool(ctx, { transport, getPrimary }) {
  ctx.tools.register(defineTool({
    name: 'wechat_notify',
    description: 'Send a proactive push notification to the user\'s WeChat. '
      + 'Use it when the user asked to be notified about something, or when a long-running task reaches a milestone, finishes, or fails and the user may be away from the computer. '
      + 'Keep the message self-contained: the user sees it on a phone, without this conversation\'s context.',
    parameters: {
      message: {
        type: 'string',
        required: true,
        description: 'Self-contained notification text for the user. Include the outcome and any decision they need to make.',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          sent: { type: 'boolean', required: true },
          conversation: { type: 'string' },
          reason: { type: 'string' },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: value.sent
          ? `WeChat notification delivered to ${value.conversation}.`
          : `WeChat notification not sent: ${value.reason}`,
      }],
    },
    async execute(args) {
      const message = (args.message ?? '').trim()
      if (!message) {
        throw new Error('wechat_notify requires a non-empty message')
      }
      const conversation = getPrimary()
      if (!conversation) {
        return {
          sent: false,
          reason: 'WeChat channel is not active yet: the user has not messaged the bot since startup.',
        }
      }
      transport.send(conversation, `📩 ${message}`)
      return { sent: true, conversation }
    },
  }))
}
