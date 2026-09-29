/**
 * The published browser bundle is a build artifact, so nothing in the tracked
 * tree reveals what it carries. These assertions read the built `lib/client.js`
 * — the exact file the package publishes — and fail if it embeds something that
 * belongs to the machine that built it, or if it stops satisfying the module
 * loader contract the harness evaluates it with.
 */
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import vm from 'node:vm'

/** The published bundle, relative to this package. */
const BUNDLE = join(import.meta.dirname, '..', 'lib', 'client.js')

const source = readFileSync(BUNDLE, 'utf8')

/**
 * Evaluate the bundle the way the harness does: a page defines
 * `window.__ModuleLoader__`, the bundle registers one entry, and the shell
 * later calls the factory with the platform module table's `require`.
 * @returns the registered entry and the plugin the factory produced.
 */
function loadBundle(): { entry: { id: string; factory: (require: (id: string) => unknown) => unknown }; asked: Set<string> } {
  let entry: { id: string; factory: (require: (id: string) => unknown) => unknown } | undefined
  const sandbox: Record<string, unknown> = {
    window: { __ModuleLoader__: { load: (value: never) => { entry = value } } },
    document: {
      querySelector: () => null,
      createElement: () => ({ dataset: {}, appendChild: () => {} }),
      head: { appendChild: () => {} },
    },
    console,
  }
  sandbox.globalThis = sandbox
  vm.createContext(sandbox)
  vm.runInContext(source, sandbox)
  if (entry === undefined) throw new Error('the bundle registered no module')
  const asked = new Set<string>()
  const require = (id: string): unknown => {
    asked.add(id)
    if (id === 'react') {
      return { createElement: () => null, useState: () => [undefined, () => {}], useEffect: () => {}, useCallback: (fn: unknown) => fn, useRef: () => ({ current: undefined }) }
    }
    if (id === 'react/jsx-runtime') return { jsx: () => null, jsxs: () => null, Fragment: 'fragment' }
    if (id === 'react-dom') return { createPortal: () => null }
    if (id.startsWith('@deepseek-ai/')) {
      // A platform module the harness table answers; a stub is enough to reach
      // the plugin object without reproducing the harness.
      return new Proxy({}, { get: (_target, key) => (key === '__esModule' ? true : () => null) })
    }
    throw new Error(`module table cannot answer "${id}"`)
  }
  entry.factory(require)
  return { entry, asked }
}

/** The platform specifiers the harness module table can answer. */
const PLATFORM = /^(react(-dom)?(\/.*)?|@deepseek-ai\/)/

describe('built browser bundle', () => {
  it('embeds no absolute build path', () => {
    // A `//#region` comment is named after the module id, and lightningcss folds
    // the filename into its CSS-modules hash: an absolute id or filename puts
    // `/Users/<name>/...` (or the CI runner's path) into the published tarball.
    expect(source.match(/\/(?:Users|home)\/[A-Za-z0-9._/-]+/g)).toBeNull()
  })

  it('registers under the package name, which is how the harness keys its module table', () => {
    const registered = source.match(/__ModuleLoader__\.load\(\{\s*id:\s*"([^"]+)"/)?.[1]
    expect(registered).toBe(JSON.parse(readFileSync(join(import.meta.dirname, '..', 'package.json'), 'utf8')).name)
  })

  it('satisfies the loader contract: one entry, a factory, and a plugin with an apply', () => {
    // This is what makes the merged layout legal — the same row that loads the
    // Host half loads this bundle, keyed by the bare package name.
    const { entry } = loadBundle()
    const name = JSON.parse(readFileSync(join(import.meta.dirname, '..', 'package.json'), 'utf8')).name
    expect(entry.id).toBe(name)
    expect(typeof entry.factory).toBe('function')
    const plugin = entry.factory(() => ({})) as { apply?: unknown } | undefined
    expect(typeof plugin?.apply).toBe('function')
  })

  it('requires only specifiers the platform module table can answer', () => {
    const { asked } = loadBundle()
    expect(asked.size).toBeGreaterThan(0)
    for (const id of asked) expect(PLATFORM.test(id), `bundle required "${id}"`).toBe(true)
  })
})
