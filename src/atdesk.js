/**
 * Automatic at-desk detection.
 *
 * Polls the OS for keyboard/mouse idle time. Idle beyond the threshold means
 * the user is away from the computer, and the WeChat approval channel should
 * take over agent questions. One touch of the keyboard flips back instantly.
 *
 * Platform support: macOS (ioreg HIDIdleTime, nanoseconds); Linux with
 * xprintidle (milliseconds). Unknown platforms report `null` (unknown), and
 * the caller treats unknown as at-desk so approvals fail toward the GUI.
 */

import { execFile } from 'node:child_process'

/** @param {string} cmd @param {string[]} args @returns {Promise<string | null>} */
function run(cmd, args) {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout: 5_000 }, (error, stdout) => {
      resolve(error ? null : stdout)
    })
  })
}

export class AtDeskMonitor {
  /**
   * @param {object} args
   * @param {import('@deepseek-ai/cordis').Logger} [args.logger]
   * @param {number} [args.idleAwaySeconds] - idle beyond this = away.
   * @param {number} [args.pollMs]
   */
  constructor({ logger, idleAwaySeconds = 300, pollMs = 30_000 } = {}) {
    this.logger = logger
    // Plain value or live getter (volatile idleAwayMinutes edited in the
    // workbench form); normalized so both work.
    this.idleAwaySeconds = typeof idleAwaySeconds === 'function' ? idleAwaySeconds : () => idleAwaySeconds
    this.pollMs = pollMs
    /** @type {boolean | null} true=at desk, false=away, null=unknown */
    this.state = null
    this.timer = null
    this.inFlight = false
  }

  /** true when the user is at the desk; unknown counts as at-desk. */
  get atDesk() {
    return this.state !== false
  }

  start() {
    const tick = async () => {
      if (this.inFlight) return
      this.inFlight = true
      try {
        const idle = await this.readIdleSeconds()
        if (idle !== null) {
          const away = idle >= this.idleAwaySeconds()
          const next = !away
          if (this.state === null ? !next : next !== this.state) {
            this.state = next
            this.logger?.info(
              `wechat-workbench at-desk: ${next ? '在电脑前（审批回 GUI）' : `空闲 ${Math.round(idle / 60)} 分钟（审批转微信）`}`,
            )
          } else {
            this.state = next
          }
        }
      } finally {
        this.inFlight = false
      }
    }
    void tick()
    this.timer = setInterval(tick, this.pollMs)
    this.timer.unref?.()
  }

  stop() {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
  }

  /** Idle seconds from the platform, or null when unavailable. */
  async readIdleSeconds() {
    const platform = process.platform
    if (platform === 'darwin') {
      const out = await run('ioreg', ['-c', 'IOHIDSystem'])
      if (out === null) return null
      const match = /"HIDIdleTime"\s*=\s*(\d+)/.exec(out)
      return match ? Number(match[1]) / 1e9 : null
    }
    if (platform === 'linux') {
      const out = await run('xprintidle', [])
      if (out === null) return null
      const ms = Number.parseFloat(out.trim())
      return Number.isFinite(ms) ? ms / 1_000 : null
    }
    return null
  }
}
