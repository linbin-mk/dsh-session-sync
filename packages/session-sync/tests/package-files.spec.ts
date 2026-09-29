/**
 * The published file list is a hand-written allowlist, and the Host entry is a
 * tree of sibling modules (`lib/index.js` imports `./engine.js`,
 * `./format.js`, …). v0.6.0 shipped `lib/index.js` without those siblings: the
 * entry threw ERR_MODULE_NOT_FOUND inside the harness, the row's fiber failed,
 * and the browser half never registered either — a defect no source-level test
 * could see, because every sibling exists locally after a build.
 *
 * These assertions therefore ask npm itself what the tarball holds and walk the
 * emitted entry's relative imports against that list.
 */
import { describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, relative as relativePath, resolve } from 'node:path'

/** This package's directory. */
const ROOT = join(import.meta.dirname, '..')

/**
 * Every repo-relative path npm would put in the published tarball.
 *
 * `npm pack --dry-run --json` applies the same `files` matching the registry
 * does, which is the point: a locally present `lib/engine.js` proves nothing.
 * @returns the packed paths, `/`-separated.
 */
function packedFiles(): string[] {
  const cache = mkdtempSync(join(tmpdir(), 'dsh-sync-pack-'))
  try {
    const raw = execFileSync('npm', ['pack', '--dry-run', '--json', '--cache', cache], {
      cwd: ROOT,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    })
    const parsed = JSON.parse(raw) as { files: { path: string }[] }[]
    return parsed[0]?.files.map(entry => entry.path) ?? []
  } finally {
    rmSync(cache, { recursive: true, force: true })
  }
}

/** The relative specifiers a module imports, in their emitted `.js` spelling. */
function relativeImports(source: string): string[] {
  const specifiers: string[] = []
  for (const match of source.matchAll(/(?:from|import)\s*\(?\s*["'](\.[^"']+)["']/g)) {
    const specifier = match[1]
    /* v8 ignore next -- the capture group always exists when the pattern matched */
    if (specifier !== undefined) specifiers.push(specifier)
  }
  return specifiers
}

describe('published tarball', () => {
  it('carries the browser bundle and the whole Host entry tree', () => {
    const packed = new Set(packedFiles())
    expect(packed.has('lib/client.js')).toBe(true)
    expect(packed.has('lib/index.js')).toBe(true)
    expect(packed.has('cordis.patch.yml')).toBe(true)

    // Walk from the Host entry: every module it reaches, directly or through
    // another module, must be in the tarball.
    const visited = new Set<string>()
    const walk = (rel: string): void => {
      if (visited.has(rel)) return
      visited.add(rel)
      expect(packed.has(rel), `${rel} is imported by the Host entry but not published`).toBe(true)
      const source = readFileSync(join(ROOT, rel), 'utf8')
      for (const specifier of relativeImports(source)) {
        if (!specifier.endsWith('.js')) continue
        walk(relativePath(ROOT, resolve(join(ROOT, dirname(rel)), specifier)))
      }
    }
    walk('lib/index.js')

    // The entry is a tree, not one file: an allowlist that lists only
    // `lib/index.js` would satisfy a shallower check and still be broken.
    expect(visited.size).toBeGreaterThan(5)
    // `npm pack` spawns npm and walks the tree; under a parallel suite that
    // outruns the 5s default, and the check is worth the wait.
  }, 60_000)
})
