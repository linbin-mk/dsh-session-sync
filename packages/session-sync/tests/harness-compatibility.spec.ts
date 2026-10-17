/**
 * The harness refuses to mount a profile row whose declared compatibility
 * requirements do not cover the running dsh version: `evaluatePluginCompatibility`
 * reports it and the composition preflight sets `row.disabled`, so the plugin
 * never loads — no exception, no fallback, just a `disabling profile plugin`
 * line on stderr. v0.6.1 shipped `^0.1.7-rc.2` peers against a `0.2.1-alpha.2`
 * harness and hit exactly that, because a `0.x` caret does not cross a minor
 * and a prerelease additionally requires an identical `major.minor.patch`.
 *
 * Harness 0.2.1-rc.2 changed which requirement decides: a declared
 * `engines.dsh` now decides ALONE and `peerDependencies` are ignored (earlier
 * 0.2.1 prereleases evaluated the peers only). The declared floor therefore is
 * the real gate, and a half-finished peer bump would no longer be noticed by
 * the evaluator — so these assertions drive the harness's own evaluator AND
 * pin every `@deepseek-ai/dsh*` peer to the line the devDependencies resolve
 * to, which is what a consumer install reads.
 */
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { evaluatePluginCompatibility, getDshRuntimeVersion } from '@deepseek-ai/dsh-app-boot'

/** This package's directory. */
const ROOT = join(import.meta.dirname, '..')

/** The published manifest, as the harness preflight would read it. */
function manifest(): Record<string, unknown> {
  return JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as Record<string, unknown>
}

describe('harness compatibility', () => {
  it('declares requirements the harness line it is built against accepts', () => {
    // A non-undefined result is the exact object that disables the row.
    expect(evaluatePluginCompatibility(manifest(), {}, getDshRuntimeVersion())).toBeUndefined()
  })

  it('names that same harness line as the declared engines.dsh floor', () => {
    // In rc.2 this field is the gate, not a comment: a declared engines.dsh
    // decides alone, so it has to name the line this plugin is verified
    // against.
    expect((manifest().engines as Record<string, string>).dsh).toBe(`^${getDshRuntimeVersion()}`)
  })

  it('tracks that line in every dsh peer, which the evaluator no longer reads', () => {
    // The compatibility evaluator ignores peers once engines.dsh is declared;
    // npm and installers still read them, so a half-finished bump has to fail
    // here instead of silently in someone's profile.
    const peers = manifest().peerDependencies as Record<string, string>
    const dshPeers = Object.entries(peers).filter(([name]) => name.startsWith('@deepseek-ai/dsh'))
    expect(dshPeers.length).toBeGreaterThan(10)
    for (const [name, range] of dshPeers) {
      expect(range, `${name} must track the ${getDshRuntimeVersion()} harness line`).toBe(`^${getDshRuntimeVersion()}`)
    }
  })
})
