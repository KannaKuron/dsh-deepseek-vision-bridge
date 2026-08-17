// Hermetic build used by both `npm run build` and the prepare hook.
import { spawnSync } from 'node:child_process'

const steps = [
  ['rm -rf lib', { shell: true }],
  [['node_modules/.bin/tsdown'], { stdio: 'inherit' }],
  [['node_modules/.bin/tsc', '-p', 'tsconfig.build.json'], { stdio: 'inherit' }],
  [['cp', 'src/worker.mjs', 'src/sha3.wasm', 'lib/'], { stdio: 'inherit' }],
]
let failed = false
for (const [cmd, opts] of steps) {
  const r = Array.isArray(cmd)
    ? spawnSync(cmd[0], cmd.slice(1), opts)
    : spawnSync(cmd, opts)
  if (r.status !== 0) { failed = true; break }
}
process.exit(failed ? 1 : 0)
