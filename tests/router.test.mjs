/**
 * Integration tests for the plugin's message flow with a fake DSH Context:
 * no real runtime, no Python child, no WeChat. Exercises Router + follower +
 * answerer wiring exactly as src/index.js composes them.
 * Run: node --test tests/
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { Router } from '../src/router.js'
import { WeChatAnswerer } from '../src/answerer.js'

/**
 * Build a fake DSH Context with one workspace, two sessions, and scripted
 * session-event streams. Records every prompt for assertions.
 */
function makeFakeCtx({ events = [] } = {}) {
  const prompts = []
  const streams = new Map()
  const sessions = [
    { sessionId: 's-old', updatedAt: Date.now() - 3_600_000, running: false, blank: false, projections: { title: { text: '昨天的重构任务' } } },
    { sessionId: 's-new', updatedAt: Date.now() - 60_000, running: false, blank: false, projections: { title: { text: '今天的调研' } } },
  ]
  const sleep = (ms) => new Promise((resolve) => {
    const timer = setTimeout(resolve, ms)
    timer.unref?.()
  })
  const followSession = async function* (request, signal) {
    // Poll a shared queue: appended frames are delivered to live followers,
    // and the initial 25ms delay mirrors real runtimes where a turn's events
    // arrive only after the prompt is admitted.
    await sleep(25)
    let i = 0
    const sid = request.address?.sessionId ?? request.sessionId
    while (!signal?.aborted) {
      const queue = streams.has(sid) ? streams.get(sid) : events
      if (i < queue.length) {
        yield queue[i]
        i += 1
        continue
      }
      await sleep(10)
    }
  }
  const handlers = new Map()
  return {
    prompts,
    sessions,
    streams,
    handlers,
    on(name, fn) {
      if (!handlers.has(name)) handlers.set(name, [])
      handlers.get(name).push(fn)
    },
    sessionController: {
      list: async () => ({ items: sessions }),
      create: async () => ({ sessionId: 's-created' }),
      rename: async () => ({}),
      prompt: async (request) => {
        prompts.push(request)
        return { accepted: true }
      },
      page: async () => ({ records: [] }),
      follow: followSession,
    },
    workspaceController: {
      follow: async function* () {
        yield {
          type: 'baseline',
          value: {
            items: [{ workspaceId: 'ws1', title: 'DSH_Plugins', sessionIds: ['s-old', 's-new'] }],
            archivedSessionIds: [],
          },
        }
      },
    },
  }
}

/** Fake transport child: records sends instead of touching WeChat. */
function makeFakeTransport() {
  const sent = []
  return { sent, send: (conversationId, text) => sent.push({ conversationId, text }), write() { return true } }
}

function buildHarness(fakeCtx, events) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-wx-i-'))
  const pointers = new PointerStoreLike(path.join(dir, 'p.json'))
  const transport = makeFakeTransport()
  const driven = new Set()
  let primary = null
  const router = new Router({ ctx: fakeCtx, pointers, transport, noteSession: (id) => driven.add(id) })
  const answerer = new WeChatAnswerer({
    ctx: fakeCtx,
    transport,
    conversationFor: (sessionId) => (driven.has(sessionId) ? 'wxid_me' : null),
    primaryConversation: () => primary,
    isAtDesk: () => true, // at desk by default in tests
    timeoutMs: 1_000,
  })
  answerer.register()
  answerer.setPrimary = (id) => { primary = id }
  return { router, answerer, transport, pointers }
}

// minimal PointerStore import shim (same class, re-imported to keep harness small)
import { PointerStore as PointerStoreLike } from '../src/pointer.js'

test('navigation flow: /ws -> /cd -> /ss -> /ss <n> -> prompt pushes final reply', async () => {
  const events = [
    { event: { type: 'tool/begin', data: { toolName: 'bash' } } },
    { event: { type: 'assistant/message', data: { text: '重构完成，测试全绿。' } } },
    { event: { type: 'turn/end', data: { reason: { kind: 'completed' } } } },
  ]
  const fakeCtx = makeFakeCtx({ events })
  const { router, transport } = buildHarness(fakeCtx)

  const ws = await router.handle({ conversationId: 'wxid_me', text: '/ws' })
  assert.match(ws, /DSH_Plugins/)

  const cd = await router.handle({ conversationId: 'wxid_me', text: '/cd 1' })
  assert.match(cd, /已切换到工作区/)

  const list = await router.handle({ conversationId: 'wxid_me', text: '/ss' })
  assert.match(list, /昨天的重构任务/)
  assert.match(list, /今天的调研/)

  // list is sorted most-recent first: index 1 = s-new
  const pick = await router.handle({ conversationId: 'wxid_me', text: '/ss 1' })
  assert.match(pick, /已切换/)

  const ack = await router.handle({ conversationId: 'wxid_me', text: '继续调研并总结' })
  assert.equal(ack, null) // replies arrive via follower pushes
  assert.equal(fakeCtx.prompts.length, 1)
  assert.equal(fakeCtx.prompts[0].sessionId, 's-new')
  assert.equal(fakeCtx.prompts[0].content[0].text, '继续调研并总结')

  // follower pushes final reply to the bound conversation
  await waitFor(() => transport.sent.some((s) => s.text.includes('重构完成')))
  const final = transport.sent.find((s) => s.text.includes('重构完成'))
  assert.equal(final.conversationId, 'wxid_me')
})

test('free text without pointer auto-creates a session in first workspace', async () => {
  const events = [{ event: { type: 'assistant/message', data: { text: '好的。' } } }, { event: { type: 'turn/end', data: {} } }]
  const fakeCtx = makeFakeCtx({ events })
  const { router, transport, pointers } = buildHarness(fakeCtx)
  const reply = await router.handle({ conversationId: 'wxid_me', text: '开始新任务' })
  assert.equal(reply, null) // session auto-created, original text sent, replies arrive via follower
  assert.equal(pointers.get('wxid_me').sessionId, 's-created')
  await waitFor(() => transport.sent.some((s) => s.text === '好的。'))
})

test('answerer claims wechat-driven sessions and maps the reply', async () => {
  const fakeCtx = makeFakeCtx()
  const { answerer, transport, router } = buildHarness(fakeCtx)
  // bind wxid_me to a real listed session via navigation, which also marks it
  // WeChat-driven (noteSession)
  await router.handle({ conversationId: 'wxid_me', text: '/ss' })
  await router.handle({ conversationId: 'wxid_me', text: '/ss 1' })
  // sorted most-recent first: /ss 1 binds s-new
  const boundSession = 's-new'

  const question = {
    questions: [{
      id: 'q1',
      question: '执行删除？',
      options: [{ label: '批准' }, { label: '取消' }],
      intent: { kind: 'op', approve: '批准' },
    }],
    agent: { id: boundSession },
  }
  let fellThrough = false
  const answerPromise = fakeCtx.handlers.get('user-questions/request')[0](question, async () => {
    fellThrough = true
    return { answers: [] }
  })

  await waitFor(() => transport.sent.some((s) => s.text.includes('需要你的决定')))
  assert.ok(answerer.answer('wxid_me', 'y'), 'pending answer consumed the reply')
  const answer = await answerPromise
  assert.equal(fellThrough, false)
  assert.deepEqual(answer.answers, [{ id: 'q1', selected: ['批准'] }])
})

test('answerer falls through for GUI-owned sessions in wechat-driven mode', async () => {
  const fakeCtx = makeFakeCtx()
  const { answerer } = buildHarness(fakeCtx)
  let fellThrough = false
  const result = await fakeCtx.handlers.get('user-questions/request')[0](
    { questions: [{ id: 'q1', question: '?', options: [] }], agent: { id: 'gui-session' } },
    async () => {
      fellThrough = true
      return { answers: [] }
    },
  )
  assert.ok(fellThrough)
  assert.equal(answerer.answer('wxid_me', 'y'), false)
})

test('approvalMode all: GUI session questions route to the primary conversation when away', async () => {
  const fakeCtx = makeFakeCtx()
  const { answerer, transport } = buildHarness(fakeCtx)
  answerer.approvalMode = 'all'
  answerer.setPrimary('wxid_me')
  answerer.isAtDesk = () => false // idle detector says away
  const question = {
    questions: [{ id: 'q1', question: '允许执行？', options: [{ label: '允许' }, { label: '拒绝' }] }],
    agent: { id: 'gui-session-not-bound-to-wechat' },
  }
  let fellThrough = false
  const answerPromise = fakeCtx.handlers.get('user-questions/request')[0](question, async () => {
    fellThrough = true
    return { answers: [] }
  })
  await waitFor(() => transport.sent.some((s) => s.text.includes('电脑端会话请求')))
  assert.ok(answerer.answer('wxid_me', '1'))
  const answer = await answerPromise
  assert.equal(fellThrough, false)
  assert.deepEqual(answer.answers, [{ id: 'q1', selected: ['允许'] }])
})

test('approvalMode all + at desk: GUI questions fall through to the GUI', async () => {
  const fakeCtx = makeFakeCtx()
  const { answerer, transport } = buildHarness(fakeCtx)
  answerer.approvalMode = 'all'
  answerer.setPrimary('wxid_me')
  answerer.isAtDesk = () => true // idle detector says at desk
  let fellThrough = false
  await fakeCtx.handlers.get('user-questions/request')[0](
    { questions: [{ id: 'q1', question: '?', options: [] }], agent: { id: 'gui-session' } },
    async () => {
      fellThrough = true
      return { answers: [] }
    },
  )
  assert.ok(fellThrough)
  assert.equal(transport.sent.filter((s) => s.text.includes('需要你的决定')).length, 0)
})

test('GUI-initiated turns are not pushed to WeChat; WeChat-initiated turns are', async () => {
  const events = [
    { event: { type: 'tool/begin', data: { toolName: 'bash' } } },
    { event: { type: 'assistant/message', data: { text: 'GUI 的回复' } } },
    { event: { type: 'turn/end', data: { reason: { kind: 'completed' } } } },
  ]
  const fakeCtx = makeFakeCtx({ events })
  const { router, transport } = buildHarness(fakeCtx)
  // Subscribe via navigation only (no WeChat prompt => turn is GUI-initiated)
  await router.handle({ conversationId: 'wxid_me', text: '/ss' })
  await router.handle({ conversationId: 'wxid_me', text: '/ss 1' })
  await new Promise((resolve) => setTimeout(resolve, 150))
  assert.equal(transport.sent.filter((s) => s.text.includes('GUI 的回复')).length, 0,
    'GUI-initiated turn must not push the final reply')

  // A WeChat prompt marks the turn and pushes (append to the same queue the
  // follower is polling by index)
  events.push(
    { event: { type: 'assistant/message', data: { text: '微信看到的回复' } } },
    { event: { type: 'turn/end', data: {} } },
  )
  await router.handle({ conversationId: 'wxid_me', text: '帮我看下结果' })
  await waitFor(() => transport.sent.some((s) => s.text === '微信看到的回复'))
})

test('follow stream failure falls back to readSession polling and still pushes the final reply', async () => {
  const events = [
    { event: { type: 'assistant/message', seq: 1, data: { message: { content: [{ type: 'text', text: '轮询拿到的回复' }] } } } },
    { event: { type: 'turn/end', seq: 2, data: { reason: { kind: 'completed' } } } },
  ]
  const fakeCtx = makeFakeCtx({ events })
  // Simulate the host follow path throwing (e.g. the live '.kind' TypeError).
  fakeCtx.sessionController.follow = function* () {
    throw new TypeError("Cannot read properties of undefined (reading 'kind')")
  }
  fakeCtx.sessionQuery = {
    readSession: async (sessionId) => ({
      session: { id: sessionId },
      events: events.map((e) => e.event),
    }),
  }
  const { router, transport } = buildHarness(fakeCtx)
  await router.handle({ conversationId: 'wxid_me', text: '/ss' })
  await router.handle({ conversationId: 'wxid_me', text: '/ss 1' })
  // A WeChat prompt marks the turn; polling fallback must still deliver.
  await router.handle({ conversationId: 'wxid_me', text: '再试一次' })
  // The turn's durable events land after admission; append to the same log
  // the poller reads.
  events.push(
    { event: { type: 'assistant/message', seq: 3, data: { message: { content: [{ type: 'text', text: '轮询拿到的回复' }] } } } },
    { event: { type: 'turn/end', seq: 4, data: { reason: { kind: 'completed' } } } },
  )
  await waitFor(() => transport.sent.some((s) => s.text === '轮询拿到的回复'), 8_000)
  // And it must NOT push the GUI-turn replay from the initial /ss selection.
  assert.equal(transport.sent.filter((s) => s.text.includes('昨天的')).length, 0)
})

function waitFor(predicate, timeoutMs = 2_000) {
  const start = Date.now()
  return new Promise((resolve, reject) => {
    const tick = () => {
      if (predicate()) resolve(undefined)
      else if (Date.now() - start > timeoutMs) reject(new Error('waitFor timeout'))
      else setTimeout(tick, 20)
    }
    tick()
  })
}
