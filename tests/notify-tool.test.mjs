/**
 * Contract tests for the wechat_notify tool: any session's agent can
 * proactively push a message to the user's WeChat approval channel.
 */

import test from 'node:test'
import assert from 'node:assert/strict'

import { registerNotifyTool } from '../src/notify-tool.js'

function makeFakeCtx() {
  const registered = []
  return {
    registered,
    tools: { register: (tool) => registered.push(tool) },
  }
}

function makeFakeTransport() {
  const sent = []
  return { sent, send: (conversationId, text) => sent.push({ conversationId, text }) }
}

test('registers a wechat_notify tool with a required message parameter', () => {
  const ctx = makeFakeCtx()
  registerNotifyTool(ctx, { transport: makeFakeTransport(), getPrimary: () => null })
  const tool = ctx.registered[0]
  assert.equal(tool.name, 'wechat_notify')
  assert.ok(tool.description.includes('WeChat'))
  // defineTool compiles parameters into a JSON-schema object.
  assert.equal(tool.parameters.type, 'object')
  assert.ok(tool.parameters.required.includes('message'))
  assert.equal(tool.parameters.properties.message.type, 'string')
})

test('execute sends to the primary conversation and reports sent', async () => {
  const ctx = makeFakeCtx()
  const transport = makeFakeTransport()
  registerNotifyTool(ctx, { transport, getPrimary: () => 'wxid_boss' })
  const result = await ctx.registered[0].execute({ message: '构建失败：tests 3 red' })
  assert.deepEqual(result, { sent: true, conversation: 'wxid_boss' })
  assert.equal(transport.sent[0].conversationId, 'wxid_boss')
  assert.ok(transport.sent[0].text.includes('构建失败'))
})

test('execute without an active WeChat channel reports sent:false with a reason', async () => {
  const ctx = makeFakeCtx()
  const transport = makeFakeTransport()
  registerNotifyTool(ctx, { transport, getPrimary: () => null })
  const result = await ctx.registered[0].execute({ message: 'hello' })
  assert.equal(result.sent, false)
  assert.ok(result.reason)
  assert.equal(transport.sent.length, 0)
})

test('execute rejects empty messages', async () => {
  const ctx = makeFakeCtx()
  registerNotifyTool(ctx, { transport: makeFakeTransport(), getPrimary: () => 'wxid_boss' })
  await assert.rejects(
    () => ctx.registered[0].execute({ message: '   ' }),
    /message/,
  )
})
