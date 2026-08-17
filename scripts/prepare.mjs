// prepare: build on install. pnpm gates lifecycle scripts behind allowBuilds;
// when blocked, lib/ stays absent and the market verifier flags the package
// (the "declared entry artifact is missing" state). The fix on the user side
// is to allow this package's build key in the profile's pnpm-workspace.yaml.
// This script keeps the build hermetic: local tsdown/tsc via node_modules.
import { existsSync } from 'node:fs'
import { spawnSync } from 'node:child_process'

// Git source installs (dsh plugin add <repo>) have no devDependencies
// installed, so a full build is impossible — but lib/ committed or absent,
// this script must not fail the install when tools are missing.
const hasTsdown = existsSync('node_modules/.bin/tsdown')
if (!hasTsdown) {
  console.log('[dsh-deepseek-vision-bridge prepare] devDependencies absent (source install) — skipping build')
  process.exit(0)
}
const r = spawnSync('node', ['scripts/build.mjs'], { stdio: 'inherit' })
process.exit(r.status ?? 1)
