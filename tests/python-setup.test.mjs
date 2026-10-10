/**
 * Unit tests for the Python environment bootstrap resolution.
 * Run: node --test tests/
 */

import test from 'node:test'
import assert from 'node:assert/strict'

import { resolvePythonBin } from '../src/python-setup.js'

const config = (over = {}) => ({ pythonBin: 'python3', autoSetupPython: true, pipIndexUrl: '', ...over })

test('uses the managed venv when it exists', () => {
  const bin = resolvePythonBin(config(), () => {}, () => true, () => {})
  assert.equal(bin.endsWith('/.venv/bin/python'), true)
})

test('explicit pythonBin is used verbatim without setup', () => {
  const runs = []
  const bin = resolvePythonBin(config({ pythonBin: '/usr/local/bin/python3.12' }), () => {}, () => false,
    (file, args) => runs.push([file, ...args]))
  assert.equal(bin, '/usr/local/bin/python3.12')
  assert.equal(runs.length, 0)
})

test('bootstraps the venv on first start and uses it afterwards', () => {
  const runs = []
  const logs = []
  let venvExists = false
  const bin = resolvePythonBin(config(), (m) => logs.push(m), () => venvExists, (file, args, options) => {
    runs.push({ file, args, indexUrl: options.env.PIP_INDEX_URL })
    venvExists = true
  })
  assert.equal(runs.length, 1)
  assert.equal(runs[0].file, 'bash')
  assert.equal(runs[0].args[0].endsWith('setup-python.sh'), true)
  assert.equal(runs[0].indexUrl, undefined)
  assert.equal(bin.endsWith('/.venv/bin/python'), true)
  assert.ok(logs.some((m) => m.includes('自动创建')))
})

test('passes the pip mirror through PIP_INDEX_URL', () => {
  const runs = []
  resolvePythonBin(config({ pipIndexUrl: 'https://pypi.tuna.tsinghua.edu.cn/simple' }), () => {}, () => false,
    (file, args, options) => runs.push(options.env.PIP_INDEX_URL))
  assert.equal(runs[0], 'https://pypi.tuna.tsinghua.edu.cn/simple')
})

test('autoSetupPython=false skips bootstrap and falls back to python3', () => {
  const runs = []
  const bin = resolvePythonBin(config({ autoSetupPython: false }), () => {}, () => false,
    (file, args) => runs.push(file))
  assert.equal(runs.length, 0)
  assert.equal(bin, 'python3')
})

test('a failed setup degrades to python3 with guidance', () => {
  const logs = []
  const bin = resolvePythonBin(config(), (m) => logs.push(m), () => false,
    () => { throw new Error('network unreachable') })
  assert.equal(bin, 'python3')
  assert.ok(logs.some((m) => m.includes('setup-python.sh')))
})
