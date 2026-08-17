/**
 * tsdown build for dsh-vision-bridge:
 *
 * - lib/index.js — the host-half ESM bundle (node). Every runtime import is
 *   a node builtin; services arrive through the Cordis context, so there are
 *   no package externals to manage.
 * - lib/client.js + lib/client-registry.js — the browser client bundle,
 *   compiled twice with only the registered id differing (the official
 *   bundle channel registers under the package name, the plugin-registry
 *   channel under the dsh.plugin.json manifest id). Both replicate the
 *   official DSH client-bundle shape: externals resolve through the module
 *   table (react, cordis, ...), everything else inlines, and each artifact
 *   registers itself via window.__ModuleLoader__.load({id, factory}) with
 *   the (require) => exports CJS closure shape.
 *
 * worker.mjs and sha3.wasm are plain assets copied next to the bundles by
 * the package build script (`cp` in `npm run build`).
 */
import type { UserConfig } from 'tsdown'

/** Module specifiers the web shell shares into the frozen module table. */
const CLIENT_EXTERNALS = [
  'react',
  'react/jsx-runtime',
  'react-dom',
  'react-dom/client',
  'cordis',
  '@deepseek-ai/cordis',
  '@deepseek-ai/dsh-client-ui-slots',
  '@deepseek-ai/dsh-client-web-react',
  '@deepseek-ai/dsh-client-ui-primitives',
  '@deepseek-ai/dsh-client-runtime/client',
]

/** One client bundle build for a plugin id. */
function clientBundle(pluginId: string, entryFile: string): UserConfig {
  return {
    entry: { client: 'src/client/index.tsx' },
    outDir: 'lib',
    format: 'cjs',
    platform: 'browser',
    dts: false,
    sourcemap: true,
    clean: false,
    external: [...CLIENT_EXTERNALS],
    define: {
      'process.env.NODE_ENV': JSON.stringify(process.env.NODE_ENV ?? 'production'),
      'import.meta.env.MODE': JSON.stringify(process.env.NODE_ENV ?? 'production'),
      'import.meta.env': JSON.stringify({ MODE: process.env.NODE_ENV ?? 'production' }),
      'import.meta.resolve': 'undefined',
    },
    inputOptions: {
      resolve: {
        conditionNames: ['browser', 'import', 'require', 'default'],
      },
    },
    noExternal: (id: string) => (CLIENT_EXTERNALS.includes(id) ? undefined : true),
    outputOptions: {
      entryFileNames: entryFile,
      banner: `window.__ModuleLoader__.load({ id: ${JSON.stringify(pluginId)}, factory: (require) => {`,
      footer: `return module.exports; } });`,
      intro: 'var module = { exports: {} }; var exports = module.exports;',
      codeSplitting: false,
    },
  } as UserConfig
}

export default [
  // host half (node ESM)
  {
    entry: { index: 'src/index.ts' },
    outDir: 'lib',
    format: ['esm'],
    platform: 'node',
    fixedExtension: false,
    target: 'es2024',
    dts: false,
    sourcemap: true,
    clean: false,
  },
  // client half (browser, module-loader registration) — official bundle channel
  clientBundle('dsh-vision-bridge', 'client.js'),
  // client half — plugin-registry channel (dsh.plugin.json manifest id)
  clientBundle('dsh-external/dsh-vision-bridge', 'client-registry.js'),
] as UserConfig[]
