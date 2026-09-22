/**
 * Build config for the browser plugin. Two artifacts:
 *
 * - the Node half (`lib/index.js`, `lib/invariant.js`): bundled from the
 *   `tsc`-emitted `lib/types` entries, so the harness Loader can import the
 *   package's node entry;
 * - the browser bundle (`lib/client.js`): a closure-factory artifact that
 *   calls `window.__ModuleLoader__.load({ id, factory })` and resolves
 *   platform modules through the injected require (the harness module table
 *   — cordis DI entities, no globals). CSS Modules are compiled by
 *   lightningcss inside the bundle and inject a `<style data-plugin>` tag at
 *   factory execution.
 *
 * The externals and purity rules mirror the harness's own client bundle
 * preset (packages/client/tsdown.client.ts): platform seed entries stay
 * external, and any value import the frozen module table cannot answer is a
 * build error.
 */
import { readFile } from 'node:fs/promises'
import { basename, dirname, relative, resolve as resolvePath } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { UserConfig } from 'tsdown'
import { transform } from 'lightningcss'

const PLUGIN_ID = '@linbin-mk/dsh-client-ui-settings-sync'

/** The platform module specifiers the harness shell shares into its frozen module table. */
const CLIENT_EXTERNALS: readonly string[] = [
  'react', 'react/jsx-runtime', 'react-dom', 'react-dom/client', '@deepseek-ai/cordis',
  '@deepseek-ai/dsh-client-ui-slots',
  '@deepseek-ai/dsh-client-ui-primitives',
  '@deepseek-ai/dsh-client-ui-attachment',
  '@deepseek-ai/dsh-client-schema-form',
  // Documented harness exemption: the snapshot-store engine lives in runtime
  // and is answered by the lazy table at runtime.
  '@deepseek-ai/dsh-client-runtime/client',
]

/** Wire/type layers a client bundle may inline (browser-safe contracts with no shared runtime identity). */
const INLINE_SAFE = /^@deepseek-ai\/dsh-(host-apiproxy|session|llm|tools|brand)(\/|$)/
/** Vendored framework libraries: ordinary libraries a browser bundle inlines. */
const VENDORED_LIBRARY = /^@deepseek-ai\/(cosmokit|schemastery)(\/|$)/
/** Generated descriptor/codec contribution with no shared runtime identity. */
const GENERATED_REMOTE = /^@deepseek-ai\/dsh-[a-z0-9]+(?:-[a-z0-9]+)*\/remote$/

const CSS_VIRTUAL_PREFIX = '\0dsh-css:'
const CSS_VIRTUAL_SUFFIX = '.mjs'

/**
 * Directory this config lives in, used as the base for the CSS virtual ids.
 *
 * The bundler names its `//#region` comments after the module id, so an
 * absolute virtual id would bake the builder's own path into the published
 * bundle (`/Users/<name>/...` locally, `/Users/runner/work/...` on CI) and make
 * the artifact differ per machine. Ids are therefore relative to this package.
 */
const BUNDLE_ROOT = dirname(fileURLToPath(import.meta.url))

/** The Node half: the loader-importable library entries from the tsc-emitted files. */
const libConfig: UserConfig = {
  name: PLUGIN_ID,
  entry: ['lib/types/index.js', 'lib/types/invariant.js'],
  outDir: 'lib',
  format: ['esm'],
  platform: 'node',
  target: 'es2024',
  dts: false,
  clean: false,
  fixedExtension: false,
}

/** The browser half: one CJS closure-factory bundle. */
const clientConfig: UserConfig = {
  name: `${PLUGIN_ID}/client`,
  entry: { client: 'src/client/index.ts' },
  outDir: 'lib',
  format: 'cjs',
  platform: 'browser',
  dts: false,
  sourcemap: true,
  clean: false,
  external: [...CLIENT_EXTERNALS],
  // tsdown auto-externalizes package dependencies; anything NOT in the
  // loader module table must inline instead. A require() the table cannot
  // answer is a guaranteed runtime throw.
  noExternal: (id: string) => (CLIENT_EXTERNALS.includes(id) ? undefined : true),
  define: {
    'process.env.NODE_ENV': JSON.stringify(process.env.NODE_ENV ?? 'production'),
    'import.meta.env.MODE': JSON.stringify(process.env.NODE_ENV ?? 'production'),
    'import.meta.env': JSON.stringify({ MODE: process.env.NODE_ENV ?? 'production' }),
  },
  plugins: [
    {
      // Bundle purity gate (mirrors the harness rule): platform seed entries
      // stay external, inline-safe wire layers inline, and every other
      // scoped value import is a build error — a cross-plugin value import
      // either inlines a duplicate runtime instance or requires a specifier
      // the frozen module table cannot answer.
      name: 'dsh-client-bundle-purity',
      resolveId(source: string) {
        if (!source.startsWith('@deepseek-ai/') && !source.startsWith('@linbin-mk/')) return null
        if (CLIENT_EXTERNALS.includes(source)) return null
        if (VENDORED_LIBRARY.test(source)) return null
        if (INLINE_SAFE.test(source) || GENERATED_REMOTE.test(source)) return null
        throw new Error(
          `client bundle purity: "${source}" is not a platform module (CLIENT_EXTERNALS), an inline-safe wire layer, or a generated /remote contribution — `
          + 'cross-plugin value imports are forbidden; collaborate through cordis services (type-only imports are erased and never reach this gate)',
        )
      },
    },
    {
      name: 'dsh-css-modules-inline',
      resolveId(source: string, importer: string | undefined) {
        if (!source.endsWith('.module.css')) return null
        const abs = importer !== undefined ? resolvePath(dirname(importer), source) : resolvePath(source)
        // Relative on purpose: this id is what the bundler prints in its
        // `//#region` comments, so an absolute one would publish the build path.
        return CSS_VIRTUAL_PREFIX + relative(BUNDLE_ROOT, abs) + CSS_VIRTUAL_SUFFIX
      },
      async load(virtualId: string) {
        if (!virtualId.startsWith(CSS_VIRTUAL_PREFIX)) return null
        const relativeId = virtualId.slice(CSS_VIRTUAL_PREFIX.length, -CSS_VIRTUAL_SUFFIX.length)
        const fileId = resolvePath(BUNDLE_ROOT, relativeId)
        this.addWatchFile(fileId)
        const source = await readFile(fileId)
        const { code, exports: cssExports } = transform({
          // The package-relative path, not the absolute one: lightningcss folds
          // the filename into its CSS-modules `[hash]`, so an absolute path
          // makes every class name depend on where the bundle was built.
          filename: relativeId,
          code: source,
          cssModules: { pattern: '[hash]_[local]' },
          minify: true,
        })
        const classMap: Record<string, string> = {}
        // Sorted, with an explicit comparator: lightningcss hands the exports
        // back in an arbitrary order, so emitting them as-is makes the bundle
        // differ between two builds of identical input. `localeCompare` is
        // avoided on purpose — it would reintroduce a machine dependency.
        const entries = Object.entries(cssExports ?? {})
          .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        for (const [local, exp] of entries) classMap[local] = exp.name
        // One <style data-plugin> per module file; idempotent under re-evaluation.
        return [
          `const css = ${JSON.stringify(code.toString())};`,
          `const tagId = ${JSON.stringify(`${PLUGIN_ID}/${basename(fileId)}`)};`,
          'if (typeof document !== \'undefined\' && document.querySelector(\'style[data-plugin-css=\' + JSON.stringify(tagId) + \']\') === null) {',
          '  const tag = document.createElement(\'style\');',
          `  tag.dataset.plugin = ${JSON.stringify(PLUGIN_ID)};`,
          '  tag.dataset.pluginCss = tagId;',
          '  tag.textContent = css;',
          '  document.head.appendChild(tag);',
          '}',
          `export default ${JSON.stringify(classMap)};`,
        ].join('\n')
      },
    },
  ],
  outputOptions: {
    entryFileNames: 'client.js',
    banner: `window.__ModuleLoader__.load({ id: ${JSON.stringify(PLUGIN_ID)}, factory: (require) => {`,
    footer: 'return module.exports; } });',
    intro: 'var module = { exports: {} }; var exports = module.exports;',
  },
}

export default [libConfig, clientConfig]
