/**
 * Protocol self-test: drive the REAL python/transport.py against the fake SDK.
 *
 * Covers the exact bugs found in live testing:
 *   1. saved-token reuse (no QR) -> straight to ready   [regression: empty-QR loop]
 *   2. QR flow only when no stored token
 *   3. inbound message -> {"op":"message"} on stdout with parsed fields
 *   4. {"op":"send"} -> transport.send_text with echoed context token
 * Run: node --test tests/  (spawns python with PYTHONPATH pointing at the fake)
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const pluginRoot = path.join(here, '..')
const script = path.join(pluginRoot, 'python', 'transport.py')
const fakeSdk = path.join(here, 'fake_sdk_path')

function runTransport(state, ops = [], timeoutMs = 8_000) {
  return new Promise((resolve) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-wx-t-'))
    const fakeLog = path.join(dir, 'fake-log.jsonl')
    const lines = []
    const child = spawn('python3', [script], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: {
        ...process.env,
        PYTHONPATH: fakeSdk,
        FAKE_STATE: JSON.stringify(state),
        FAKE_LOG: fakeLog,
      },
    })
    let buffer = ''
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk) => {
      buffer += chunk
      let i = buffer.indexOf('\n')
      while (i >= 0) {
        const line = buffer.slice(0, i).trim()
        buffer = buffer.slice(i + 1)
        if (line) lines.push(JSON.parse(line))
        i = buffer.indexOf('\n')
      }
    })
    let stderrText = ''
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', (c) => { stderrText += c })
    child.stdin.write(`${JSON.stringify({ op: 'start', accountId: 'dsh' })}\n`)
    for (const op of ops) child.stdin.write(`${JSON.stringify(op)}\n`)
    const readEvents = () => {
      try {
        return fs.readFileSync(fakeLog, 'utf8').trim().split('\n')
          .filter(Boolean).map((l) => JSON.parse(l))
      } catch {
        return []
      }
    }
    const finish = () => {
      resolve({ lines, events: readEvents(), stderrText })
    }
    const done = setTimeout(() => {
      child.kill('SIGKILL')
      finish()
    }, timeoutMs)
    // Finish early once we have enough signal.
    const poll = setInterval(() => {
      const hasReady = lines.some((l) => l.op === 'ready')
      const wantedSend = ops.some((o) => o.op === 'send')
      const gotSend = readEvents().some((e) => e.event === 'send_text')
      if (hasReady && (!wantedSend || gotSend)) {
        clearTimeout(done)
        clearInterval(poll)
        child.kill('SIGKILL')
        finish()
      }
    }, 100)
  })
}

test('saved token: skips QR entirely and goes straight to ready', async () => {
  const { lines } = await runTransport({ needsLogin: false })
  assert.equal(lines.filter((l) => l.op === 'login').length, 0, 'no QR when token stored')
  assert.ok(lines.some((l) => l.op === 'ready'), 'ready emitted')
})

test('no token: emits QR login then ready after CONFIRMED', async () => {
  const { lines } = await runTransport({ needsLogin: true })
  const login = lines.find((l) => l.op === 'login')
  assert.ok(login, 'login op emitted')
  assert.equal(login.qrUrl, 'https://fake.weixin.qq.com/qr/xyz')
  assert.ok(lines.some((l) => l.op === 'ready'), 'ready after CONFIRMED')
})

test('inbound message is forwarded with parsed fields; reply echoes context token', async () => {
  const message = {
    conversationId: 'wxid_test',
    text: '/ws',
    contextToken: 'ctx-9',
    messageId: 'm-42',
  }
  const { lines, events } = await runTransport({ needsLogin: false, messages: [message] }, [
    { op: 'send', conversationId: 'wxid_test', text: '🗂 工作区列表' },
  ])
  const forwarded = lines.find((l) => l.op === 'message')
  assert.ok(forwarded, 'message op emitted')
  assert.equal(forwarded.conversationId, 'wxid_test')
  assert.equal(forwarded.text, '/ws')
  const sent = events.find((e) => e.event === 'send_text')
  assert.ok(sent, 'send_text invoked')
  assert.equal(sent.text, '🗂 工作区列表')
  assert.equal(sent.token, 'ctx-9', 'context token echoed back')
})
