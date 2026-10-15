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

function runTransport(state, ops = [], timeoutMs = 8_000, startExtra = {}) {
  return new Promise((resolve) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-wx-t-'))
    const fakeLog = path.join(dir, 'fake-log.jsonl')
    const lines = []
    const child = spawn('python3', [script], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: {
        ...process.env,
        PYTHONPATH: fakeSdk,
        PYTHONDONTWRITEBYTECODE: '1', // keep __pycache__ out of the npm tarball
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
    child.stdin.write(`${JSON.stringify({ op: 'start', accountId: 'dsh', ...startExtra })}\n`)
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
      clearInterval(poll)
      child.kill('SIGKILL')
      finish()
    }, timeoutMs)
    // Finish early once we have enough signal: ready, any expected reply,
    // every scripted inbound message forwarded, and acks for ops that carry
    // an id (send/sendMedia now answer sendResult/sendMediaResult).
    const expectedMessages = Array.isArray(state.messages) ? state.messages.length : 0
    const poll = setInterval(() => {
      const hasReady = lines.some((l) => l.op === 'ready')
      const wantedSend = ops.some((o) => o.op === 'send')
      const gotSend = readEvents().some((e) => e.event === 'send_text')
      const gotMessages = lines.filter((l) => l.op === 'message').length >= expectedMessages
      const wantedAcks = ops.filter((o) => o.id).length
      const acksArrived = (op) => lines.some((l) => l.id === op.id
        && (op.op === 'send' ? l.op === 'sendResult' : l.op === 'sendMediaResult'))
      const gotAcks = ops.filter((o) => o.id).every(acksArrived)
      if (hasReady && gotMessages && (!wantedSend || gotSend) && (!wantedAcks || gotAcks)) {
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

test('inbound image is downloaded to the media dir and reported on the message op', async () => {
  // 1x1 transparent PNG
  const pngBase64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=='
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-wx-media-'))
  const message = {
    conversationId: 'wxid_test',
    text: '',
    contextToken: 'ctx-m',
    messageId: 'm-img',
    media: [{ type: 'image', cdnParam: 'c', aesKey: 'k', fileName: 'photo.png' }],
  }
  const { lines, events } = await runTransport(
    { needsLogin: false, messages: [message], mediaBytes: pngBase64 },
    [],
    8_000,
    { mediaDir: dir },
  )
  const forwarded = lines.find((l) => l.op === 'message')
  assert.ok(forwarded, 'message op emitted')
  assert.ok(Array.isArray(forwarded.media) && forwarded.media.length === 1, 'media array on message op')
  const media = forwarded.media[0]
  assert.equal(media.kind, 'image')
  assert.equal(media.fileName, 'photo.png')
  assert.equal(media.mediaType, 'image/png')
  assert.ok(fs.existsSync(media.path), 'downloaded file exists on disk')
  assert.equal(fs.readFileSync(media.path).toString('base64'), pngBase64, 'bytes round-trip')
  assert.ok(events.some((e) => e.event === 'download_media'))
})

test('sendMedia op uploads and builds a file item with len/md5 and the hex32 aes_key; acks by id', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-wx-media-'))
  const filePath = path.join(dir, 'report.pdf')
  fs.writeFileSync(filePath, '%PDF-fake')
  const { events, lines } = await runTransport({ needsLogin: false }, [
    { op: 'sendMedia', id: 'ack-1', conversationId: 'wxid_test', path: filePath, kind: 'file', fileName: 'report.pdf' },
  ])
  const uploaded = events.find((e) => e.event === 'upload_media')
  assert.ok(uploaded, 'upload_media invoked')
  assert.equal(uploaded.mediaType, 3, 'file upload uses integer media type 3')
  assert.equal(uploaded.fileName, 'report.pdf')
  assert.equal(uploaded.bytes, 9)
  const sent = events.find((e) => e.event === 'send_media_message')
  assert.ok(sent, 'send_media_message invoked')
  assert.equal(sent.conversationId, 'wxid_test')
  assert.equal(sent.item.type, 4)
  assert.equal(sent.item.file_item.file_name, 'report.pdf')
  assert.equal(sent.item.file_item.len, '9', 'len carries the plaintext size as a string')
  assert.match(sent.item.file_item.md5, /^[0-9a-f]{32}$/, 'md5 of the raw bytes')
  // Protocol (per working reference implementations): aes_key = base64(hex 32)
  // for EVERY type — base64(raw 16) is what SDK 0.2.1 emits and files then
  // arrive but never download.
  const rawKey = Buffer.from([...Array(16).keys()])
  assert.equal(sent.item.file_item.media.aes_key, Buffer.from(rawKey.toString('hex')).toString('base64'),
    'file aes_key is base64(hex32) — the encoding the receiving client can decode')
  assert.notEqual(sent.item.file_item.media.aes_key, rawKey.toString('base64'))
  assert.equal(sent.token, '', 'no inbound context yet, empty token is fine')
  const ack = lines.find((l) => l.op === 'sendMediaResult')
  assert.ok(ack, 'sendMediaResult ack emitted')
  assert.equal(ack.id, 'ack-1', 'ack echoes the caller id')
  assert.equal(ack.ok, true)
})

test('sendMedia image kind uses hex32 aes_key plus aeskey/mid_size like real inbound items', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-wx-media-'))
  const filePath = path.join(dir, 'pic.png')
  fs.writeFileSync(filePath, 'png-bytes')
  const { events } = await runTransport({ needsLogin: false }, [
    { op: 'sendMedia', id: 'ack-img', conversationId: 'wxid_test', path: filePath, kind: 'image', fileName: 'pic.png' },
  ])
  const uploaded = events.find((e) => e.event === 'upload_media')
  assert.equal(uploaded.mediaType, 1, 'image upload uses integer media type 1')
  const sent = events.find((e) => e.event === 'send_media_message')
  assert.equal(sent.item.type, 2)
  const rawKey = Buffer.from([...Array(16).keys()])
  assert.equal(sent.item.image_item.media.aes_key, Buffer.from(rawKey.toString('hex')).toString('base64'),
    'image aes_key is base64(hex32) — matching the reference implementations, not base64(raw16)')
  assert.equal(sent.item.image_item.aeskey, rawKey.toString('hex'),
    'image_item carries the top-level hex aeskey like real inbound messages')
  assert.equal(typeof sent.item.image_item.mid_size, 'number', 'mid_size (ciphertext size) present')
})

test('sendMedia failure acks ok=false with the error (no more silent stderr-only failures)', async () => {
  const { lines } = await runTransport({ needsLogin: false }, [
    { op: 'sendMedia', id: 'ack-2', conversationId: 'wxid_test', path: '/nonexistent/gone.pdf', kind: 'file', fileName: 'gone.pdf' },
  ])
  const ack = lines.find((l) => l.op === 'sendMediaResult' && l.id === 'ack-2')
  assert.ok(ack, 'failure ack emitted')
  assert.equal(ack.ok, false)
  assert.ok(typeof ack.error === 'string' && ack.error.length > 0, 'error text carried')
})

test('send op with an id acks sendResult', async () => {
  const { lines } = await runTransport({ needsLogin: false }, [
    { op: 'send', id: 'ack-3', conversationId: 'wxid_test', text: 'hi' },
  ])
  const ack = lines.find((l) => l.op === 'sendResult' && l.id === 'ack-3')
  assert.ok(ack, 'sendResult ack emitted')
  assert.equal(ack.ok, true)
})
