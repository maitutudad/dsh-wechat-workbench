/**
 * Unit tests for the pure, DSH-free parts of dsh-wechat-workbench.
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
import { Config, readLiveField } from '../src/index.js'

// ---------------------------------------------------------------- config
// Regression: the loader hands volatile fields to apply() as live
// references ({ get() }), not plain values; every read must unwrap.
test('Config resolves volatile fields into live references, readLiveField unwraps both shapes', () => {
  const resolved = Config({ allowWxids: ['wxid_a'], approvalMode: 'all', idleAwayMinutes: 7 })
  const approval = resolved.approvalMode
  assert.equal(typeof approval.get, 'function', 'volatile field is a live reference')
  assert.equal(readLiveField(approval), 'all')
  assert.deepEqual(readLiveField(resolved.allowWxids), ['wxid_a'])
  assert.equal(readLiveField(resolved.idleAwayMinutes), 7)
  // Plain values (direct mounts, tests) pass through unchanged.
  assert.equal(readLiveField('wechat-driven'), 'wechat-driven')
  assert.deepEqual(readLiveField(['a']), ['a'])
  assert.equal(readLiveField(true), true)
  assert.equal(readLiveField(null), null)
  // Live reads observe swaps inside the same reference (loader commits).
  let current = 5
  const ref = { get: () => current }
  assert.equal(readLiveField(ref), 5)
  current = 9
  assert.equal(readLiveField(ref), 9)
})

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

test('summarizeEvent: tool call lines carry a compact argument digest', () => {
  // bash prefers the UI description, falls back to the command.
  assert.equal(
    summarizeEvent({ type: 'tool/call', data: { name: 'bash', arguments: JSON.stringify({ description: '列出目录内容', command: 'ls -la' }) } }),
    '🔧 bash · 列出目录内容',
  )
  assert.equal(
    summarizeEvent({ type: 'tool/call', data: { name: 'bash', arguments: JSON.stringify({ command: 'pnpm test\nsecond line' }) } }),
    '🔧 bash · pnpm test second line',
  )
  // File tools show the path; ask_user_question shows its first question.
  assert.match(
    summarizeEvent({ type: 'tool/call', data: { name: 'write', arguments: JSON.stringify({ file_path: '/tmp/a.js', content: 'x'.repeat(500) }) } }),
    /^🔧 write · \/tmp\/a\.js$/,
  )
  assert.equal(
    summarizeEvent({ type: 'tool/call', data: { name: 'ask_user_question', arguments: JSON.stringify({ questions: [{ id: 'q', header: '数据预算', question: '选哪种方案？' }] }) } }),
    '🔧 ask_user_question · 【数据预算】选哪种方案？',
  )
  // Unknown tool, generic fields; long values are capped.
  const long = 'x'.repeat(200)
  const summary = summarizeEvent({ type: 'tool/call', data: { name: 'mystery', arguments: JSON.stringify({ description: long }) } })
  assert.ok(summary.startsWith('🔧 mystery · '), 'unknown tool still digests')
  assert.ok(summary.length <= '🔧 mystery · '.length + 91, 'digest capped')
  // Malformed arguments never break the summary.
  assert.equal(summarizeEvent({ type: 'tool/call', data: { name: 'bash', arguments: 'not-json' } }), '🔧 bash · not-json')
  assert.equal(summarizeEvent({ type: 'tool/call', data: { name: 'bash' } }), '🔧 bash')
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
