/**
 * The published browser bundle is a build artifact, so nothing in the tracked
 * tree reveals what it carries. These assertions read the built `lib/client.js`
 * — the exact file the package publishes — and fail if it embeds something that
 * belongs to the machine that built it.
 */
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

/** The published bundle, relative to this package. */
const BUNDLE = join(import.meta.dirname, '..', 'lib', 'client.js')

const source = readFileSync(BUNDLE, 'utf8')

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
})
