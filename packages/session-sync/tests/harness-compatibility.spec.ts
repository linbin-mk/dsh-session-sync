/**
 * The harness refuses to mount a profile row whose `@deepseek-ai/dsh-*` peers
 * do not satisfy the running dsh version: `evaluatePluginCompatibility` reports
 * it and the composition preflight sets `row.disabled`, so the plugin never
 * loads — no exception, no fallback, just a `disabling profile plugin` line on
 * stderr. v0.6.1 shipped `^0.1.7-rc.2` peers against a `0.2.1-alpha.2` harness
 * and hit exactly that, because a `0.x` caret does not cross a minor and a
 * prerelease additionally requires an identical `major.minor.patch`.
 *
 * These assertions drive the harness's own evaluator against the harness line
 * the devDependencies actually resolve to, so a half-finished version bump
 * fails here instead of silently in someone's profile.
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
  it('declares dsh peers the harness line it is built against accepts', () => {
    // A non-undefined result is the exact object that disables the row.
    expect(evaluatePluginCompatibility(manifest(), {}, getDshRuntimeVersion())).toBeUndefined()
  })

  it('names that same harness line as the declared engines.dsh floor', () => {
    // `engines.dsh` is declarative in the harness today, so it is only worth
    // declaring while it still matches the line the peers are pinned to.
    expect((manifest().engines as Record<string, string>).dsh).toBe(`^${getDshRuntimeVersion()}`)
  })
})
