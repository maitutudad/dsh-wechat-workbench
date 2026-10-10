/**
 * Python environment bootstrap for the iLink transport child.
 *
 * The transport's only protocol implementation (`wechat-agent-sdk`) is
 * PyPI-distributed, so a local virtual environment is unavoidable; this module
 * removes the manual step. When `pythonBin` is left at its default and the
 * plugin-managed `.venv` does not exist yet, the first start runs
 * `scripts/setup-python.sh` (optionally through a pip mirror) and the managed
 * interpreter is used afterwards. An explicit `pythonBin` is always used
 * verbatim with no setup attempt.
 */

import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

/** The plugin package root (this module lives in src/). */
export const PLUGIN_ROOT = dirname(dirname(fileURLToPath(import.meta.url)))

/**
 * Resolve the interpreter to spawn, bootstrapping the managed venv when asked.
 * @param {{pythonBin?: string, autoSetupPython?: boolean, pipIndexUrl?: string}} config - resolved plugin config.
 * @param {(message: string) => void} [log] - progress sink for the setup run.
 * @param {typeof existsSync} [exists] - fs seam for tests.
 * @param {(file: string, args: string[], options: object) => void} [run] - subprocess seam for tests.
 * @returns the interpreter path or command to spawn.
 */
export function resolvePythonBin(config, log = () => {}, exists = existsSync, run = (file, args, options) => execFileSync(file, args, options)) {
  const pythonBin = config.pythonBin ?? 'python3'
  const venvPython = join(PLUGIN_ROOT, '.venv', 'bin', 'python')
  if (pythonBin !== 'python3' || exists(venvPython)) {
    return exists(venvPython) && pythonBin === 'python3' ? venvPython : pythonBin
  }
  if (config.autoSetupPython === false) return pythonBin
  log('wechat-workbench: 首次启动，自动创建 Python 虚拟环境（需访问 PyPI）…')
  const script = join(PLUGIN_ROOT, 'scripts', 'setup-python.sh')
  try {
    run('bash', [script], {
      env: {
        ...process.env,
        ...(config.pipIndexUrl ? { PIP_INDEX_URL: config.pipIndexUrl } : {}),
      },
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 10 * 60_000,
    })
  } catch (error) {
    log(`wechat-workbench: 自动创建 Python 环境失败（${String(error?.message ?? error)}）。`
      + ' 请手工运行 scripts/setup-python.sh，或配置 pythonBin 指向已装好依赖的解释器。')
    return pythonBin
  }
  return exists(venvPython) ? venvPython : pythonBin
}
