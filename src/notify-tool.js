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
import fs from 'node:fs'
import path from 'node:path'

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

  // Any session's agent can push a local file (image/video/document) to the
  // user's WeChat. Extension decides the WeChat media kind.
  ctx.tools.register(defineTool({
    name: 'wechat_send_file',
    description: 'Send a local file to the user\'s WeChat as an image, video, or file message. '
      + 'Use it when the user asked for a deliverable on WeChat, or to hand over a report/artifact generated in the workspace. '
      + 'Absolute or workspace-relative path; the extension decides how WeChat renders it.',
    parameters: {
      path: {
        type: 'string',
        required: true,
        description: 'Path to the local file to send (png/jpg/gif/webp render as images; mp4 as video; anything else as a file).',
      },
      fileName: {
        type: 'string',
        description: 'Optional display name; defaults to the file\'s basename.',
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
          ? `File delivered to WeChat (${value.conversation}).`
          : `File not sent: ${value.reason}`,
      }],
    },
    async execute(args) {
      const filePath = (args.path ?? '').trim()
      if (!filePath) throw new Error('wechat_send_file requires a non-empty path')
      if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
        throw new Error(`wechat_send_file: not a readable file: ${filePath}`)
      }
      const conversation = getPrimary()
      if (!conversation) {
        return {
          sent: false,
          reason: 'WeChat channel is not active yet: the user has not messaged the bot since startup.',
        }
      }
      const fileName = (args.fileName ?? '').trim() || path.basename(filePath)
      const kind = kindForFileName(fileName)
      const queued = transport.sendMedia({ conversationId: conversation, path: filePath, kind, fileName })
      return queued
        ? { sent: true, conversation }
        : { sent: false, reason: 'transport child is not running' }
    },
  }))
}

const IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp'])
const VIDEO_EXTENSIONS = new Set(['.mp4', '.mov', '.m4v'])

function kindForFileName(fileName) {
  const extension = path.extname(fileName).toLowerCase()
  if (IMAGE_EXTENSIONS.has(extension)) return 'image'
  if (VIDEO_EXTENSIONS.has(extension)) return 'video'
  return 'file'
}
