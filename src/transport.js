/**
 * Supervised Python transport child process.
 *
 * Owns the iLink long-connection child (python/transport.py, built on
 * wechat-agent-sdk). Speaks one JSON object per line over stdio; the child's
 * stderr is surfaced through the plugin logger. Crashes are restarted with
 * backoff for the plugin's lifetime.
 */

import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const require = createRequire(import.meta.url)
const here = path.dirname(fileURLToPath(import.meta.url))
const script = path.join(here, '..', 'python', 'transport.py')

/** @import { Context, Logger } from '@deepseek-ai/cordis' */

export class WeChatTransportChild {
  /**
   * @param {Context} ctx - plugin Context; disposers stop the child.
   * @param {{ pythonBin?: string, accountId?: string }} [options]
   */
  constructor(ctx, options = {}) {
    this.ctx = ctx
    this.logger = ctx.logger
    this.pythonBin = options.pythonBin ?? process.env.WECHAT_PYTHON ?? 'python3'
    this.accountId = options.accountId ?? 'dsh'
    /** @type {import('node:child_process').ChildProcess | null} */
    this.child = null
    /** @type {Map<string, (line: any) => void>} op -> listener */
    this.listeners = new Map()
    this.buffer = ''
    this.stopping = false
    this.restartDelayMs = 2_000
    this.logger.info(`wechat transport script: ${script}`)
  }

  /** @param {'message' | 'ready' | 'login' | 'error'} op @param {(line: any) => void} handler */
  on(op, handler) {
    this.listeners.set(op, handler)
  }

  start() {
    this.stopping = false
    this.spawnOnce()
    this.ctx.effect(() => () => { this.kill() })
  }

  spawnOnce() {
    if (this.stopping) return
    /** @type {any} */
    let child
    try {
      child = spawn(this.pythonBin, [script], {
        // stderr inherits the host terminal so the login QR art and any
        // python tracebacks are visible regardless of host log levels.
        stdio: ['pipe', 'pipe', 'inherit'],
        env: { ...process.env },
      })
    } catch (error) {
      this.logger.error(`failed to spawn ${this.pythonBin}: ${error}`)
      this.scheduleRestart()
      return
    }
    this.child = child
    this.logger.info(`wechat transport spawned (pid ${child.pid})`)

    child.on('error', (error) => {
      this.logger.error(`wechat transport error: ${error}`)
      this.scheduleRestart()
    })
    const died = () => {
      if (this.child === child) this.child = null
      if (!this.stopping) {
        this.logger.warn('wechat transport exited; restarting with backoff')
        this.scheduleRestart()
      }
    }
    child.once('exit', died)
    if (child.stdout) {
      child.stdout.setEncoding('utf8')
      child.stdout.on('data', (/** @type {string} */ chunk) => this.feed(chunk))
    }
    this.write({ op: 'start', accountId: this.accountId })
  }

  scheduleRestart() {
    if (this.stopping) return
    const delay = this.restartDelayMs
    this.restartDelayMs = Math.min(this.restartDelayMs * 2, 60_000)
    const timer = setTimeout(() => this.spawnOnce(), delay)
    if (typeof timer.unref === 'function') timer.unref()
  }

  /** Parse newline-framed JSON from the child stdout stream. */
  feed(chunk) {
    this.buffer += chunk
    let index = this.buffer.indexOf('\n')
    while (index >= 0) {
      const line = this.buffer.slice(0, index).trim()
      this.buffer = this.buffer.slice(index + 1)
      if (line) {
        try {
          const message = JSON.parse(line)
          const handler = this.listeners.get(message.op)
          if (handler) handler(message)
          else this.logger.debug(`unhandled transport op: ${message.op}`)
        } catch (error) {
          this.logger.warn(`bad transport line: ${String(line.slice(0, 200))}: ${error}`)
        }
      }
      index = this.buffer.indexOf('\n')
    }
  }

  /** @param {any} payload */
  write(payload) {
    const child = this.child
    if (child?.stdin && !child.killed) {
      child.stdin.write(`${JSON.stringify(payload)}\n`)
      return true
    }
    return false
  }

  /** Send a text reply into one WeChat conversation. */
  send(conversationId, text) {
    this.write({ op: 'send', conversationId, text })
  }

  /** Push a local file to one WeChat conversation as image/video/file/voice. */
  sendMedia(op) {
    return this.write({ op: 'sendMedia', ...op })
  }

  kill() {
    this.stopping = true
    const child = this.child
    this.child = null
    if (child && !child.killed) {
      this.write({ op: 'stop' })
      setTimeout(() => { if (!child.killed) child.kill('SIGTERM') }, 1_000).unref?.()
      setTimeout(() => { if (!child.killed) child.kill('SIGKILL') }, 5_000).unref?.()
    }
  }
}
