// @vitest-environment node
/**
 * Draft-and-save model of the sync settings form: the patch holds exactly the
 * changed fields, and validation names the mistake the old immediate-commit
 * form used to send to the host (adding a second project with the first row's
 * path was refused there with `duplicate mapping path`).
 */
import { describe, expect, it } from 'vitest'
import {
  cleanMappings, draftFromSettings, isDirty, settingsPatch, settingsSignature, validateDraft,
} from '../src/client/settings-form.ts'
import type { ValidationCopy } from '../src/client/settings-form.ts'
import type { SyncSettingsDraft } from '../src/client/controller.ts'

const copy: ValidationCopy = {
  remoteRequired: 'remote required',
  branchBlank: 'branch blank',
  intervalInvalid: 'interval invalid',
  mappingKeyBlank: (row: number) => `key blank ${row}`,
  mappingPathBlank: (row: number) => `path blank ${row}`,
  mappingKeyDuplicate: (key: string) => `key dup ${key}`,
  mappingPathDuplicate: (path: string) => `path dup ${path}`,
}

function settings(overrides: Partial<SyncSettingsDraft> = {}): SyncSettingsDraft {
  return {
    enabled: true,
    remote: 'git@example.com:team/repo.git',
    branch: 'main',
    intervalMinutes: 5,
    mappings: [{ key: 'demo', path: '/work/demo' }],
    cleanup: { enabled: false, periodHours: 24, keepCommits: 200 },
    ...overrides,
  }
}

describe('settingsSignature and isDirty', () => {
  it('treats an identical section as clean and any change as dirty', () => {
    const base = settings()
    expect(isDirty(settings(), base)).toBe(false)
    expect(isDirty(settings({ branch: 'dev' }), base)).toBe(true)
    expect(isDirty(settings({ mappings: [{ key: 'demo', path: '/work/other' }] }), base)).toBe(true)
    expect(isDirty(settings({ cleanup: { enabled: true, periodHours: 24, keepCommits: 200 } }), base)).toBe(true)
  })

  it('canonicalizes nested values so a re-created section stays clean', () => {
    expect(settingsSignature(settings())).toBe(settingsSignature(draftFromSettings(settings())))
  })

  it('is order-sensitive for the mapping list, because the order is stored', () => {
    const two = settings({ mappings: [{ key: 'a', path: '/a' }, { key: 'b', path: '/b' }] })
    const swapped = settings({ mappings: [{ key: 'b', path: '/b' }, { key: 'a', path: '/a' }] })
    expect(isDirty(swapped, two)).toBe(true)
  })
})

describe('settingsPatch', () => {
  it('returns undefined when nothing changed', () => {
    expect(settingsPatch(settings(), settings())).toBeUndefined()
  })

  it('holds only the changed fields', () => {
    const patch = settingsPatch(settings({ branch: 'dev' }), settings())
    expect(patch).toEqual({ branch: 'dev' })
  })

  it('sends a nested cleanup patch for one changed cleanup field', () => {
    const draft = settings({ cleanup: { enabled: true, periodHours: 24, keepCommits: 200 } })
    expect(settingsPatch(draft, settings())).toEqual({ cleanup: { enabled: true } })
  })

  it('trims mapping text and remote/branch before writing', () => {
    const draft = settings({
      remote: ' git@example.com:team/repo.git ',
      branch: ' dev ',
      mappings: [{ key: ' demo ', path: ' /work/demo ' }],
    })
    expect(settingsPatch(draft, settings())).toEqual({ branch: 'dev' })
  })

  it('writes the mapping list for a structural change', () => {
    const draft = settings({
      mappings: [{ key: 'demo', path: '/work/demo' }, { key: 'server', path: '/work/server' }],
    })
    expect(settingsPatch(draft, settings())).toEqual({
      mappings: [{ key: 'demo', path: '/work/demo' }, { key: 'server', path: '/work/server' }],
    })
  })

  it('treats a whitespace-only edit as no change at all', () => {
    const draft = settings({ branch: ' main ', mappings: [{ key: ' demo', path: '/work/demo ' }] })
    // The host stores trimmed values, so the draft is not dirty and there is
    // no patch to write.
    expect(isDirty(draft, settings())).toBe(false)
    expect(settingsPatch(draft, settings())).toBeUndefined()
  })
})

describe('cleanMappings', () => {
  it('trims every row and leaves the order alone', () => {
    expect(cleanMappings([{ key: ' a ', path: ' /a ' }, { key: 'b', path: '/b' }]))
      .toEqual([{ key: 'a', path: '/a' }, { key: 'b', path: '/b' }])
  })
})

describe('validateDraft', () => {
  it('accepts a complete section', () => {
    expect(validateDraft(settings(), copy)).toEqual([])
  })

  it('requires a remote only while the switch is on', () => {
    expect(validateDraft(settings({ remote: '' }), copy))
      .toEqual([{ field: 'remote', message: 'remote required' }])
    expect(validateDraft(settings({ enabled: false, remote: '' }), copy)).toEqual([])
  })

  it('rejects a blank branch and an unusable cadence', () => {
    expect(validateDraft(settings({ branch: '  ' }), copy))
      .toEqual([{ field: 'branch', message: 'branch blank' }])
    expect(validateDraft(settings({ intervalMinutes: 0 }), copy))
      .toEqual([{ field: 'interval', message: 'interval invalid' }])
    expect(validateDraft(settings({ intervalMinutes: 1.5 }), copy))
      .toEqual([{ field: 'interval', message: 'interval invalid' }])
  })

  it('names the row of an incomplete mapping — the "add project" dead end', () => {
    const draft = settings({
      mappings: [{ key: 'demo', path: '/work/demo' }, { key: '', path: '' }],
    })
    expect(validateDraft(draft, copy)).toEqual([
      { field: 'mappings', message: 'key blank 2' },
      { field: 'mappings', message: 'path blank 2' },
    ])
  })

  it('catches the duplicate path the host used to refuse after the fact', () => {
    const draft = settings({
      mappings: [{ key: 'demo', path: '/work/demo' }, { key: 'other', path: '/work/demo' }],
    })
    expect(validateDraft(draft, copy)).toEqual([
      { field: 'mappings', message: 'path dup /work/demo' },
    ])
  })

  it('catches duplicate keys and ignores whitespace-only differences', () => {
    const draft = settings({
      mappings: [{ key: 'demo', path: '/a' }, { key: ' demo ', path: '/b' }],
    })
    expect(validateDraft(draft, copy)).toEqual([
      { field: 'mappings', message: 'key dup demo' },
    ])
  })
})
