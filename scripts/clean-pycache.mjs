/** Remove __pycache__/ and *.pyc so they never enter the npm tarball. */
import { readdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'

const SKIP = new Set(['node_modules', '.venv', '.git'])

function clean(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (SKIP.has(entry.name)) continue
    const full = join(dir, entry.name)
    if (entry.isDirectory()) {
      if (entry.name === '__pycache__') {
        rmSync(full, { recursive: true, force: true })
      } else {
        clean(full)
      }
    } else if (entry.name.endsWith('.pyc')) {
      rmSync(full, { force: true })
    }
  }
}

for (const target of ['tests', 'python']) clean(target)
console.log('pycache cleaned for npm pack')
