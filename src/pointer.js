/**
 * Per-conversation workbench pointer: { workspaceId, sessionId }.
 *
 * A bound WeChat conversation behaves like one open browser tab of the Web
 * workbench: it remembers which workspace is active and which session is
 * selected, but owns no session data. Pointers persist across restarts in a
 * small JSON file under the DSH home.
 */

import fs from 'node:fs'
import path from 'node:path'

export class PointerStore {
  /**
   * @param {string} filePath - JSON persistence path.
   */
  constructor(filePath) {
    this.filePath = filePath
    /** @type {Map<string, { workspaceId?: string, sessionId?: string }>} */
    this.pointers = new Map()
    try {
      if (fs.existsSync(filePath)) {
        const loaded = JSON.parse(fs.readFileSync(filePath, 'utf8'))
        for (const [key, value] of Object.entries(loaded ?? {})) {
          if (value && typeof value === 'object') this.pointers.set(key, value)
        }
      }
    } catch (error) {
      console.warn(`[wechat-workbench] failed to load pointers: ${error}`)
    }
  }

  /** @param {string} conversationId */
  get(conversationId) {
    let pointer = this.pointers.get(conversationId)
    if (!pointer) {
      pointer = {}
      this.pointers.set(conversationId, pointer)
    }
    return pointer
  }

  save() {
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true })
    const plain = Object.fromEntries(this.pointers)
    fs.writeFileSync(this.filePath, `${JSON.stringify(plain, null, 2)}\n`)
  }

  /** @param {string} conversationId */
  reset(conversationId) {
    this.pointers.set(conversationId, {})
    this.save()
  }
}
