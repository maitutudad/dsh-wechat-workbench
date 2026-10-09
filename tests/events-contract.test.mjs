/**
 * TDD contract tests against SOURCE-VERIFIED event shapes
 * (packages/api/session-controller/tests/event-script.client.ts is canonical):
 *
 *   assistant/message → data.message.content = [{type:'text', text}, ...]
 *   tool/call         → data.{turn, step, callId, name, arguments}
 *   user/message      → data.content (content blocks)
 *   turn/end          → data.reason.{kind}
 *
 * These encode the vocabulary + field layout of the real durable log.
 */

import test from 'node:test'
import assert from 'node:assert/strict'

import { summarizeEvent, assistantText } from '../src/progress.js'

// Canonical builders (mirroring event-script.client.ts)
const assistantMessage = (body) => ({
  type: 'assistant/message',
  seq: 7,
  time: 1_700_000_000_000,
  data: {
    turn: 1,
    step: 0,
    stream: [],
    message: {
      role: 'assistant',
      content: [
        { type: 'text', text: body },
        { type: 'tool_use', id: 't1', name: 'x', input: {} },
      ],
    },
  },
})

const toolCall = (name) => ({
  type: 'tool/call',
  seq: 8,
  time: 1_700_000_000_001,
  data: { turn: 1, step: 0, callId: 'c1', name, arguments: '{}' },
})

test('TDD-red: assistant text lives in data.message.content blocks', () => {
  assert.equal(assistantText(assistantMessage('重构完成，测试全绿。')), '重构完成，测试全绿。')
})

test('TDD-red: tool/call summary uses data.name', () => {
  assert.equal(summarizeEvent(toolCall('bash')), '🔧 bash')
  assert.equal(summarizeEvent(toolCall('str-replace-editor')), '🔧 str-replace-editor')
})

test('non-text events do not summarize', () => {
  assert.equal(summarizeEvent({ type: 'tool/result', data: { name: 'bash' } }), null)
  assert.equal(summarizeEvent({ type: 'step/end', data: {} }), null)
  assert.equal(assistantText({ type: 'user/message', data: { content: [{ type: 'text', text: 'x' }] } }), null)
})
