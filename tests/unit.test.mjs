/**
 * Unit tests for the pure, DSH-free parts of dsh-wechat-remote.
 * Run: node --test tests/
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { parseCommand } from '../src/router.js'
import { matchAnswer, formatQuestion } from '../src/answerer.js'
import { summarizeEvent, assistantText } from '../src/progress.js'
import { PointerStore } from '../src/pointer.js'

// ---------------------------------------------------------------- commands
test('parseCommand: slash commands vs free text', () => {
  assert.deepEqual(parseCommand('/ws'), { name: '/ws', arg: '' })
  assert.deepEqual(parseCommand('  /ss 3 '), { name: '/ss', arg: '3' })
  assert.deepEqual(parseCommand('/new 我的标题'), { name: '/new', arg: '我的标题' })
  assert.equal(parseCommand('普通消息'), null)
  assert.equal(parseCommand('  '), null)
})

// ---------------------------------------------------------------- answerer
const question = {
  id: 'q1',
  header: '确认',
  question: '执行该操作？',
  options: [
    { label: '批准执行', description: '立即运行' },
    { label: '取消', description: '不执行' },
  ],
}

test('matchAnswer: numeric / label / approve shorthand / custom', () => {
  assert.deepEqual(matchAnswer('1', question), { selected: ['批准执行'] })
  assert.deepEqual(matchAnswer('取消', question), { selected: ['取消'] })
  assert.deepEqual(matchAnswer('Y', { ...question, intent: { kind: 'x', approve: '批准执行' } }), { selected: ['批准执行'] })
  assert.deepEqual(matchAnswer('改成只读模式', question), { selected: [], custom: '改成只读模式' })
})

test('formatQuestion renders header, options and guidance', () => {
  const text = formatQuestion(question)
  assert.ok(text.includes('【确认】'))
  assert.ok(text.includes('1. 批准执行'))
  assert.ok(text.includes('回复序号或选项文字'))
})

// ---------------------------------------------------------------- progress
test('summarizeEvent: tool begin with several name fields', () => {
  assert.equal(summarizeEvent({ type: 'tool/begin', data: { toolName: 'bash' } }), '🔧 bash')
  assert.equal(summarizeEvent({ type: 'tool/begin', data: { name: 'edit' } }), '🔧 edit')
  assert.equal(summarizeEvent({ type: 'tool/end', data: { toolName: 'bash' } }), null)
  assert.equal(summarizeEvent({ type: 'assistant/message' }), null)
  assert.equal(summarizeEvent(null), null)
})

test('assistantText: string and content-block shapes (assistant events only)', () => {
  assert.equal(assistantText({ type: 'assistant/message', data: { text: 'hi' } }), 'hi')
  assert.equal(assistantText({ type: 'assistant/message', data: { content: [{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }] } }), 'a\nb')
  assert.equal(assistantText({ type: 'assistant/message', data: {} }), null)
  assert.equal(assistantText({ type: 'user/message', data: { text: 'x' } }), null)
})

// ---------------------------------------------------------------- pointers
test('PointerStore: persist, reset, reload across instances', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-wx-'))
  const file = path.join(dir, 'pointers.json')
  const store = new PointerStore(file)
  const p = store.get('wxid_a')
  p.workspaceId = 'ws1'
  p.sessionId = 's1'
  store.save()
  const reloaded = new PointerStore(file)
  assert.deepEqual(reloaded.get('wxid_a'), { workspaceId: 'ws1', sessionId: 's1' })
  reloaded.reset('wxid_a')
  assert.deepEqual(reloaded.get('wxid_a'), {})
  // corruption does not throw
  fs.writeFileSync(file, '{not json')
  assert.doesNotThrow(() => new PointerStore(file))
})
