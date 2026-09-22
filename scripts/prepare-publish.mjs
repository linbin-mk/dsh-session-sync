#!/usr/bin/env node
/**
 * Rewrite pnpm's `workspace:` protocol into real semver ranges for one package
 * manifest, so the manifest `npm publish` sends is readable outside a pnpm
 * workspace.
 *
 * `workspace:^` is a pnpm-only spelling: npm understands nothing about it and
 * would publish the literal string, leaving consumers with an unresolvable
 * range. This mirrors what `pnpm publish` does — resolve each `workspace:` range
 * against the version of the workspace package it names.
 *
 * Usage: node scripts/prepare-publish.mjs packages/session-sync
 *
 * The rewrite is deliberately in-place; the caller restores the committed
 * manifest afterwards (`git checkout -- <manifest>`), so the repository never
 * carries a rewritten range.
 */
import { readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { join, resolve } from 'node:path'

/** Every dependency section npm may carry; only these ever hold a range. */
const DEPENDENCY_SECTIONS = ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies']

/**
 * Map every workspace package name to its version.
 * @param root - the repository root.
 * @returns name → version for each readable `packages/` manifest.
 */
function workspaceVersions(root) {
  const versions = new Map()
  for (const entry of readdirSync(join(root, 'packages'))) {
    let manifest
    try {
      manifest = JSON.parse(readFileSync(join(root, 'packages', entry, 'package.json'), 'utf8'))
    } catch {
      continue // Not a package directory (no manifest, or unreadable JSON).
    }
    if (typeof manifest.name === 'string' && typeof manifest.version === 'string') {
      versions.set(manifest.name, manifest.version)
    }
  }
  return versions
}

/**
 * Resolve one `workspace:` range against a concrete version.
 *
 * `workspace:*` pins the exact version, `workspace:^` and `workspace:~` prefix
 * it, and a range like `workspace:^1.2.3` already carries its own specifier.
 * @param range - the range as written in the manifest.
 * @param version - the version of the package the range names.
 * @returns the range to publish.
 */
function resolveRange(range, version) {
  const spec = range.slice('workspace:'.length)
  if (spec === '' || spec === '*') return version
  if (spec === '^' || spec === '~') return `${spec}${version}`
  return spec
}

const target = process.argv[2]
if (target === undefined) {
  console.error('usage: prepare-publish.mjs <package-dir>')
  process.exit(2)
}

const root = resolve(fileURLToPath(new URL('..', import.meta.url)))
const manifestPath = join(resolve(target), 'package.json')
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
const versions = workspaceVersions(root)

let rewritten = 0
for (const section of DEPENDENCY_SECTIONS) {
  for (const [dependency, range] of Object.entries(manifest[section] ?? {})) {
    if (typeof range !== 'string' || !range.startsWith('workspace:')) continue
    const version = versions.get(dependency)
    if (version === undefined) {
      console.error(`${manifest.name}: ${section}.${dependency} is "${range}" but no workspace package provides it`)
      process.exit(1)
    }
    const resolved = resolveRange(range, version)
    manifest[section][dependency] = resolved
    console.log(`  ${section}.${dependency}: ${range} → ${resolved}`)
    rewritten += 1
  }
}

if (rewritten === 0) {
  console.log(`${manifest.name}: no workspace-protocol ranges to rewrite`)
} else {
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`)
  console.log(`${manifest.name}: rewrote ${rewritten} range(s)`)
}
