/**
 * Display-metadata contract for the Harness Plugin Manager, bundle details,
 * and the Settings plugin inventory. Harness 0.2.1 resolves these resources
 * through Node's ESM resolver without activating the plugin (`readPluginMeta`
 * in `dsh-app-boot`): `<specifier>/locale/en.json` plus every sibling language
 * dictionary supplies `meta.title`/`meta.description`, and `<specifier>/icon`
 * supplies the icon. A missing export, a malformed dictionary, or a resource
 * left out of `package.json#files` degrades the row to package-name fallback
 * text and generic artwork with no error at runtime — so the contract is
 * asserted here instead.
 *
 * Harness rule: locale filenames are language ids (`en`, `zh`, `pt-BR`); icons
 * are SVG, PNG, JPEG, or WebP up to 256 KiB.
 */
import { describe, expect, it } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { dirname, extname, isAbsolute, join, relative, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

/** This package's directory. */
const PACKAGE_ROOT = join(import.meta.dirname, '..')
/** The published manifest, as the harness preflight reads it. */
const MANIFEST = JSON.parse(readFileSync(join(PACKAGE_ROOT, 'package.json'), 'utf8')) as {
  name: string
  exports: Record<string, unknown>
  files: string[]
}

/** Language ids the harness accepts as locale filenames. */
const LANGUAGE_ID = /^[A-Za-z]{2,8}(?:-[A-Za-z0-9]{1,8})*$/u
/** Media types the harness accepts as a plugin icon. */
const ICON_MEDIA_TYPES = new Set(['.svg', '.png', '.jpg', '.jpeg', '.webp'])
/** Harness cap on the icon's raw bytes. */
const MAX_ICON_BYTES = 256 * 1024
/** Any CJK Unified Ideograph is enough to identify the Chinese dictionary. */
const CJK = /[\u3400-\u9fff]/u

/** Resolve an exported resource the way the harness's ESM resolver does. */
function resolveExport(specifier: string): string {
  let url: string
  try {
    url = import.meta.resolve(`${MANIFEST.name}/${specifier}`)
  } catch (cause) {
    throw new Error(`exports["${specifier}"] does not resolve: ${String(cause)}`)
  }
  const file = fileURLToPath(url)
  const local = relative(PACKAGE_ROOT, file)
  expect(isAbsolute(local), `${specifier} must resolve inside the package`).toBe(false)
  expect(local === '..' || local.startsWith(`..${sep}`), `${specifier} resolved outside the package: ${file}`)
    .toBe(false)
  return file
}

/** One language dictionary's display fields, as the harness would read them. */
function dictionaryOf(language: string, file: string): { title: string; description: string } {
  const parsed = JSON.parse(readFileSync(file, 'utf8')) as { meta?: { title?: unknown; description?: unknown } }
  const title = parsed.meta?.title
  const description = parsed.meta?.description
  expect(typeof title, `locale/${language}.json: meta.title must be a string`).toBe('string')
  expect(typeof description, `locale/${language}.json: meta.description must be a string`).toBe('string')
  expect((title as string).trim(), `locale/${language}.json: meta.title must be non-empty`).not.toBe('')
  expect((description as string).trim(), `locale/${language}.json: meta.description must be non-empty`).not.toBe('')
  return { title: title as string, description: description as string }
}

describe('plugin display metadata', () => {
  it('ships English and Chinese dictionaries that resolve through the locale export', () => {
    const english = resolveExport('locale/en.json')
    expect(dirname(english)).toBe(join(PACKAGE_ROOT, 'locale'))

    const localeDirectory = dirname(english)
    const dictionaries = new Map<string, { title: string; description: string }>()
    for (const entry of readdirSync(localeDirectory, { withFileTypes: true })) {
      if (!entry.name.endsWith('.json')) continue
      const language = entry.name.slice(0, -5)
      expect(LANGUAGE_ID.test(language), `locale/${entry.name} must use a language id as its filename`).toBe(true)
      const file = resolveExport(`locale/${entry.name}`)
      expect(dirname(file), `locale/${entry.name} must share the English locale directory`).toBe(localeDirectory)
      dictionaries.set(language, dictionaryOf(language, file))
    }

    expect(dictionaries.has('en'), 'locale/en.json is the dictionary the harness reads first').toBe(true)
    expect(dictionaries.has('zh'), 'the plugin ships a Chinese dictionary').toBe(true)
    const en = dictionaries.get('en')
    const zh = dictionaries.get('zh')
    expect(en).toBeDefined()
    expect(zh).toBeDefined()
    expect(CJK.test(zh?.title ?? ''), 'locale/zh.json: meta.title must be Chinese text').toBe(true)
    expect(CJK.test(zh?.description ?? ''), 'locale/zh.json: meta.description must be Chinese text').toBe(true)
    expect(zh?.title).not.toBe(en?.title)
    expect(zh?.description).not.toBe(en?.description)
  })

  it('ships an icon the harness accepts through the ./icon export', () => {
    const icon = resolveExport('icon')
    expect(dirname(icon)).toBe(PACKAGE_ROOT)
    expect(ICON_MEDIA_TYPES.has(extname(icon).toLowerCase()), `unexpected icon media type: ${icon}`).toBe(true)
    const bytes = readFileSync(icon)
    expect(bytes.length, 'the icon must stay within 256 KiB').toBeLessThanOrEqual(MAX_ICON_BYTES)
    expect(statSync(icon).isFile()).toBe(true)
    // An SVG without a viewBox does not scale into the plugin row's square slot.
    if (extname(icon).toLowerCase() === '.svg') {
      expect(bytes.toString('utf8')).toContain('viewBox')
    }
  })

  it('lists the metadata resources in the manifest allowlists', () => {
    expect(MANIFEST.exports).toHaveProperty('./icon')
    expect(MANIFEST.exports).toHaveProperty('./locale/*.json')
    expect(MANIFEST.files).toContain('icon.png')
    expect(MANIFEST.files).toContain('locale/*.json')
    // The runtime exports the harness composes from stay unchanged.
    expect(MANIFEST.exports).toHaveProperty('.')
    expect(MANIFEST.exports).toHaveProperty('./client')
    expect(MANIFEST.exports).toHaveProperty('./cordis.patch.yml')
  })
})
