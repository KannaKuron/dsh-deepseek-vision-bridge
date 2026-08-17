// Smoke tests for dsh-vision-bridge: worker protocol surface + build outputs.
// Run: npm test  (node --test tests/)
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')

function runWorker(args, stdin) {
  return new Promise((resolve, reject) => {
    const argv = Buffer.from(JSON.stringify(args)).toString('base64')
    const child = spawn(process.execPath, [join(root, 'src/worker.mjs'), argv], { stdio: ['pipe', 'pipe', 'pipe'] })
    let out = ''
    let err = ''
    child.stdout.on('data', c => { out += c })
    child.stderr.on('data', c => { err += c })
    child.on('close', () => {
      const lines = out.split('\n').filter(l => l.trim().startsWith('{'))
      if (!lines.length) return reject(new Error('no json output; stderr=' + err))
      try { resolve(JSON.parse(lines[lines.length - 1])) } catch (e) { reject(e) }
    })
    if (stdin !== undefined) child.stdin.end(stdin)
    else child.stdin.end()
  })
}

test('worker reports not-logged-in without a token', async () => {
  const r = await runWorker({ op: 'check' })
  assert.equal(r.ok, true)
  assert.equal(r.loggedIn, false)
})

test('worker rejects a fake token as not logged in', async () => {
  const r = await runWorker({ op: 'check', token: '0'.repeat(64) })
  assert.equal(r.ok, true)
  assert.equal(r.loggedIn, false)
})

test('worker rejects an unknown op', async () => {
  const r = await runWorker({ op: 'definitely-not-an-op' })
  assert.equal(r.ok, false)
  assert.match(r.error, /unknown op/)
})

test('worker rejects analyze without login', async () => {
  const r = await runWorker({ op: 'analyze' })
  assert.equal(r.ok, false)
  assert.match(r.error, /not logged in/)
})

test('worker rejects analyze with empty stdin images', async () => {
  const r = await runWorker({ op: 'analyze', token: '0'.repeat(64), imagesStdin: true }, '[]')
  assert.equal(r.ok, false)
})

test('pow wasm asset ships next to the worker', () => {
  assert.ok(existsSync(join(root, 'src/sha3.wasm')), 'src/sha3.wasm missing')
  const bytes = readFileSync(join(root, 'src/sha3.wasm'))
  assert.equal(bytes[0], 0x00)
  assert.equal(bytes[1], 0x61) // "\0asm" magic
})

test('manifest and package agree on identity', async () => {
  const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
  const manifest = JSON.parse(readFileSync(join(root, 'dsh.plugin.json'), 'utf8'))
  assert.equal(pkg.name, 'dsh-vision-bridge')
  assert.equal(manifest.id, 'dsh-external/dsh-vision-bridge')
  assert.equal(manifest.version, pkg.version)
  const patch = readFileSync(join(root, 'cordis.patch.yml'), 'utf8')
  assert.match(patch, /name: 'dsh-vision-bridge'/, 'cordis.patch.yml must mount the package name')
})

test('built artifacts exist after a build', async () => {
  const t = (p) => existsSync(join(root, p))
  if (!t('lib/index.js')) return // build not run in this checkout — skip
  assert.ok(t('lib/client.js'))
  assert.ok(t('lib/client-registry.js'))
  assert.ok(t('lib/worker.mjs'))
  assert.ok(t('lib/sha3.wasm'))
})
