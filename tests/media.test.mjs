/**
 * Media contract tests: WeChat attachments become session prompt content
 * parts (images inline as base64, other files saved and referenced by path),
 * and agents can push local files back to WeChat via the wechat_send_file
 * tool.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { registerNotifyTool } from '../src/notify-tool.js'
import { Router } from '../src/router.js'
import { PointerStore } from '../src/pointer.js'

const PNG_BASE64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=='

function writeTempFile(name, buffer) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-wx-m-'))
  const filePath = path.join(dir, name)
  fs.writeFileSync(filePath, buffer)
  return filePath
}

test('inbound image becomes an inline image content part on the prompt', async () => {
  const imagePath = writeTempFile('photo.png', Buffer.from(PNG_BASE64, 'base64'))
  const fakeCtx = makeCtxWithSession()
  const { router } = buildMediaHarness(fakeCtx)
  await router.handle({ conversationId: 'wxid_me', text: '/ss' })
  await router.handle({ conversationId: 'wxid_me', text: '/ss 1' })
  await router.handle({
    conversationId: 'wxid_me',
    text: '这张图里是什么？',
    media: [{ path: imagePath, fileName: 'photo.png', kind: 'image', mediaType: 'image/png', bytes: 70 }],
  })
  const prompt = fakeCtx.prompts.at(-1)
  const imagePart = prompt.content.find((part) => part.type === 'image')
  assert.ok(imagePart, 'image content part present')
  assert.equal(imagePart.mediaType, 'image/png')
  assert.equal(imagePart.data, PNG_BASE64)
  assert.equal(imagePart.name, 'photo.png')
  assert.ok(prompt.content.some((p) => p.type === 'text' && p.text.includes('这张图里是什么')))
})

test('inbound file is referenced by saved path in the text part', async () => {
  const filePath = writeTempFile('data.csv', Buffer.from('a,b\n1,2'))
  const fakeCtx = makeCtxWithSession()
  const { router } = buildMediaHarness(fakeCtx)
  await router.handle({ conversationId: 'wxid_me', text: '/ss' })
  await router.handle({ conversationId: 'wxid_me', text: '/ss 1' })
  await router.handle({
    conversationId: 'wxid_me',
    text: '分析这个文件',
    media: [{ path: filePath, fileName: 'data.csv', kind: 'file', mediaType: 'text/csv', bytes: 7 }],
  })
  const prompt = fakeCtx.prompts.at(-1)
  const textPart = prompt.content.find((p) => p.type === 'text')
  assert.ok(textPart.text.includes('分析这个文件'))
  assert.ok(textPart.text.includes(filePath), 'file path included for fs tools')
  assert.ok(!prompt.content.some((p) => p.type === 'file'), 'no receipt parts without fileUploads')
})

test('wechat_send_file tool pushes a local file through the transport', async () => {
  const filePath = writeTempFile('out.png', Buffer.from(PNG_BASE64, 'base64'))
  const sent = []
  const ctx = { tools: { register: (t) => registered.push(t) } }
  const registered = []
  registerNotifyTool(ctx, {
    transport: { send: () => {}, sendMedia: async (op) => { sent.push(op); return true } },
    getPrimary: () => 'wxid_boss',
  })
  const tool = registered.find((t) => t.name === 'wechat_send_file')
  assert.ok(tool, 'tool registered')
  const result = await tool.execute({ path: filePath })
  assert.equal(result.sent, true)
  assert.equal(sent[0].conversationId, 'wxid_boss')
  assert.equal(sent[0].path, filePath)
  assert.equal(sent[0].kind, 'image')
  assert.equal(sent[0].fileName, 'out.png')
})

test('wechat_send_file surfaces a transport failure instead of claiming success', async () => {
  const filePath = writeTempFile('broken.png', Buffer.from(PNG_BASE64, 'base64'))
  const notices = []
  const ctx = { tools: { register: (t) => registered.push(t) } }
  const registered = []
  registerNotifyTool(ctx, {
    transport: {
      send: (conversationId, text) => notices.push({ conversationId, text }),
      sendMedia: async () => { throw new Error('CDN upload failed: 400 Bad Request') },
    },
    getPrimary: () => 'wxid_boss',
  })
  const tool = registered.find((t) => t.name === 'wechat_send_file')
  const result = await tool.execute({ path: filePath })
  assert.equal(result.sent, false, 'failure must not report sent:true')
  assert.match(result.reason, /CDN upload failed/)
  assert.equal(notices.length, 1, 'fallback WeChat text notice sent')
  assert.match(notices[0].text, /文件发送到微信失败/)
  assert.match(notices[0].text, /broken\.png/, 'notice carries the local path')
})

test('wechat_send_file reports sent:false when the transport child is down', async () => {
  const filePath = writeTempFile('offline.png', Buffer.from(PNG_BASE64, 'base64'))
  const ctx = { tools: { register: (t) => registered.push(t) } }
  const registered = []
  registerNotifyTool(ctx, {
    transport: { send: () => {}, sendMedia: async () => false },
    getPrimary: () => 'wxid_boss',
  })
  const tool = registered.find((t) => t.name === 'wechat_send_file')
  const result = await tool.execute({ path: filePath })
  assert.equal(result.sent, false)
  assert.match(result.reason, /not running/)
})

test('failed media download surfaces an explicit note in the prompt text', async () => {
  const fakeCtx = makeCtxWithSession()
  const { router } = buildMediaHarness(fakeCtx)
  await router.handle({
    conversationId: 'wxid_me',
    text: '看看这张',
    media: [{ kind: 'failed', fileName: 'photo.jpg', mediaType: 'image', bytes: 0, error: 'HTTPStatusError: 400 Bad Request' }],
  })
  const prompt = fakeCtx.prompts.at(-1)
  const textPart = prompt.content.find((part) => part.type === 'text')
  assert.ok(textPart.text.includes('photo.jpg接收失败'), 'failure note names the file')
  assert.ok(textPart.text.includes('400'), 'failure note carries the error')
  assert.ok(!prompt.content.some((p) => p.type === 'image'), 'no image part for a failed download')
})

test('handleInbound: the production entry forwards media into the session prompt', async () => {
  const imagePath = writeTempFile('inbound.png', Buffer.from(PNG_BASE64, 'base64'))
  const fakeCtx = makeCtxWithSession()
  const { router, transport } = buildMediaHarness(fakeCtx)
  router.inbound = {
    allowed: () => ['wxid_me'],
    bootstrap: () => false,
    allowGroups: () => false,
    setPrimary: () => {},
  }
  await router.handleInbound({
    conversationId: 'wxid_me', senderId: 'wxid_me', senderName: 'me',
    groupId: null, isAtBot: false, text: '[图片]', messageId: 'm1',
    media: [{ path: imagePath, fileName: 'inbound.png', kind: 'image', mediaType: 'image/png', bytes: 70 }],
  })
  const prompt = fakeCtx.prompts.at(-1)
  assert.ok(prompt, 'prompt submitted through the production entry')
  const imagePart = prompt.content.find((part) => part.type === 'image')
  assert.ok(imagePart, 'media descriptor survived the index->router seam')
  assert.equal(imagePart.data, PNG_BASE64)
})

test('handleInbound: unauthorized senders are rejected without prompting', async () => {
  const fakeCtx = makeCtxWithSession()
  const { router, transport } = buildMediaHarness(fakeCtx)
  router.inbound = { allowed: () => ['wxid_me'], bootstrap: () => false, allowGroups: () => false, setPrimary: () => {} }
  await router.handleInbound({ conversationId: 'wxid_stranger', senderId: 'wxid_stranger', groupId: null, isAtBot: false, text: 'hi' })
  assert.equal(fakeCtx.prompts.length, 0, 'no prompt for unauthorized sender')
  assert.ok(transport.sent.some((s) => s.t === '⛔ 未授权。'))
})

test('handleInbound: group messages are ignored entirely', async () => {
  const fakeCtx = makeCtxWithSession()
  const { router, transport } = buildMediaHarness(fakeCtx)
  router.inbound = { allowed: () => ['wxid_me'], bootstrap: () => false, setPrimary: () => {} }
  await router.handleInbound({ conversationId: 'group-123', senderId: 'wxid_me', groupId: 'group-123', isAtBot: true, text: 'hi' })
  assert.equal(fakeCtx.prompts.length, 0, 'no prompt from a group')
  assert.equal(transport.sent.length, 0, 'no reply from a group')
})

test('handleInbound: bootstrap mode replies with the conversation id', async () => {
  const fakeCtx = makeCtxWithSession()
  const { router, transport } = buildMediaHarness(fakeCtx)
  router.inbound = { allowed: () => [], bootstrap: () => true, allowGroups: () => false, setPrimary: () => {} }
  await router.handleInbound({ conversationId: 'wxid_new', senderId: 'wxid_new', groupId: null, isAtBot: false, text: 'hi' })
  assert.equal(fakeCtx.prompts.length, 0)
  const reply = transport.sent.find((s) => s.t.includes('引导模式'))
  assert.ok(reply, 'bootstrap reply sent')
  assert.ok(reply.t.includes('wxid_new'), 'reply carries the conversation id')
})

test('/config: reads current values and writes one volatile field through the settings service', async () => {
  const fakeCtx = makeCtxWithSession()
  const { router, transport } = buildMediaHarness(fakeCtx)
  const written = []
  const current = { allowWxids: ['wxid_me'], allowGroups: false, bootstrap: false, approvalMode: 'wechat-driven', idleAwayMinutes: 5, answerTimeoutMs: 600_000 }
  router.configWriter = {
    read: () => current,
    update: async (patch) => { written.push(patch); Object.assign(current, patch) },
  }
  const list = await router.handle({ conversationId: 'wxid_me', text: '/config' })
  assert.match(list, /allowWxids: \["wxid_me"\]/)
  assert.match(list, /approvalMode: "wechat-driven"/)

  const add = await router.handle({ conversationId: 'wxid_me', text: '/config allowWxids +wxid_friend' })
  assert.match(add, /✅/)
  assert.deepEqual(written[0], { allowWxids: ['wxid_me', 'wxid_friend'] })

  const mode = await router.handle({ conversationId: 'wxid_me', text: '/config approvalMode all' })
  assert.deepEqual(written[1], { approvalMode: 'all' })

  const minutes = await router.handle({ conversationId: 'wxid_me', text: '/config idleAwayMinutes 10' })
  assert.deepEqual(written[2], { idleAwayMinutes: 10 })

  const bad = await router.handle({ conversationId: 'wxid_me', text: '/config nope 1' })
  assert.match(bad, /未知配置键/)
})

// ---------------------------------------------------------------- helpers
function makeCtxWithSession() {
  const prompts = []
  return {
    prompts,
    logger: { info() {}, warn() {}, error() {} },
    on() { /* no waterfall in this harness */ },
    sessionController: {
      list: async () => ({ items: [{ sessionId: 's1', updatedAt: Date.now(), running: false, blank: false, projections: { kind: 'sequenced', asOfSeq: 1, values: { title: 'T' } } }] }),
      create: async () => ({ sessionId: 's-created' }),
      rename: async () => ({}),
      prompt: async (request) => { prompts.push(request); return { accepted: true } },
      follow: async function* () { await new Promise(() => {}) },
    },
    workspaceController: {
      follow: async function* () {
        yield { type: 'baseline', value: { items: [{ workspaceId: 'ws1', title: 'W', sessionIds: ['s1'] }], archivedSessionIds: [] } }
      },
    },
  }
}

function buildMediaHarness(fakeCtx) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-wx-p-'))
  const pointers = new PointerStore(path.join(dir, 'p.json'))
  const sent = []
  const transport = { sent, send: (c, t) => sent.push({ c, t }), sendMedia: (op) => sent.push(op) }
  const router = new Router({ ctx: fakeCtx, pointers, transport, noteSession: () => {} })
  return { router, transport }
}
