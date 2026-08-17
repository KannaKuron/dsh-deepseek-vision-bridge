// Hermetic build used by both `npm run build` and the prepare hook
// (git-source installs build here via pnpm allowBuilds).
//
// Cross-platform by construction — this runs on Windows too:
//   - fs.rmSync/cpSync instead of `rm -rf` / `cp`
//   - local bins invoked via the Windows .cmd shim with shell:true
//     (Node refuses to spawn .cmd without a shell since CVE-2024-27980)
import { rmSync, mkdirSync, cpSync, existsSync } from 'node:fs'
import { spawnSync } from 'node:child_process'

const IS_WIN = process.platform === 'win32'

/** Path of a node_modules/.bin entry that spawnSync can execute on this OS. */
function bin(name) {
  return IS_WIN ? `node_modules\\.bin\\${name}.cmd` : `node_modules/.bin/${name}`
}

function run(cmd, args) {
  const r = spawnSync(cmd, args, { stdio: 'inherit', shell: IS_WIN })
  return r.status === 0
}

rmSync('lib', { recursive: true, force: true })

if (!run(bin('tsdown'), [])) process.exit(1)
if (!run(bin('tsc'), ['-p', 'tsconfig.build.json'])) process.exit(1)

mkdirSync('lib', { recursive: true })
cpSync('src/worker.mjs', 'lib/worker.mjs')
cpSync('src/sha3.wasm', 'lib/sha3.wasm')

if (!existsSync('lib/index.js') || !existsSync('lib/sha3.wasm')) {
  console.error('[dsh-deepseek-vision-bridge build] expected artifacts missing after build')
  process.exit(1)
}
