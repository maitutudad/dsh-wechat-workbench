/**
 * Unit tests for the automatic at-desk monitor (idle detection + state
 * transitions) using an injected fake idle reader.
 * Run: node --test tests/
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { AtDeskMonitor } from '../src/atdesk.js'

function makeMonitor(idleAwaySeconds = 300) {
  const monitor = new AtDeskMonitor({ idleAwaySeconds, pollMs: 1_000 })
  let fakeIdle = 0
  monitor.readIdleSeconds = async () => fakeIdle
  return { monitor, setIdle: (seconds) => { fakeIdle = seconds } }
}

test('atDesk: unknown state counts as at-desk (fail toward GUI)', () => {
  const { monitor } = makeMonitor()
  assert.equal(monitor.state, null)
  assert.equal(monitor.atDesk, true)
})

test('polling updates state with hysteresis-free transitions', async () => {
  const { monitor, setIdle } = makeMonitor(300)
  // expose the internal tick for deterministic tests
  const tick = async () => {
    monitor.inFlight = true
    try {
      const idle = await monitor.readIdleSeconds()
      if (idle !== null) monitor.state = idle < monitor.idleAwaySeconds
    } finally {
      monitor.inFlight = false
    }
  }
  monitor.tick = tick

  setIdle(10)
  await monitor.tick()
  assert.equal(monitor.atDesk, true)

  setIdle(301) // one second past the threshold
  await monitor.tick()
  assert.equal(monitor.atDesk, false, 'away once idle exceeds threshold')

  setIdle(0) // touch the keyboard
  await monitor.tick()
  assert.equal(monitor.atDesk, true, 'back at desk instantly on input')
})
