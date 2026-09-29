// @vitest-environment node
/**
 * Draft-and-save model of the sync settings form: the patch holds exactly the
 * changed fields, and validation names the mistake the old immediate-commit
 * form used to send to the host. v2 removed the project-mapping list, so the
 * mapping rules that used to live here are gone with it.
 */
import { describe, expect, it } from 'vitest'
import {
  draftFromSettings, isDirty, settingsPatch, settingsSignature, validateDraft,
} from '../src/client/settings-form.ts'
import type { ValidationCopy } from '../src/client/settings-form.ts'
import type { SyncSettingsDraft } from '../src/client/controller.ts'

const copy: ValidationCopy = {
  remoteRequired: 'remote required',
  branchBlank: 'branch blank',
  intervalInvalid: 'interval invalid',
}

function settings(overrides: Partial<SyncSettingsDraft> = {}): SyncSettingsDraft {
  return {
    enabled: true,
    remote: 'git@example.com:team/repo.git',
    branch: 'main',
    intervalMinutes: 5,
    cleanup: { enabled: false, periodHours: 24, keepCommits: 200 },
    ...overrides,
  }
}

describe('settingsSignature and isDirty', () => {
  it('treats an identical section as clean and any change as dirty', () => {
    const base = settings()
    expect(isDirty(settings(), base)).toBe(false)
    expect(isDirty(settings({ branch: 'dev' }), base)).toBe(true)
    expect(isDirty(settings({ enabled: false }), base)).toBe(true)
    expect(isDirty(settings({ cleanup: { enabled: true, periodHours: 24, keepCommits: 200 } }), base)).toBe(true)
  })

  it('canonicalizes nested values so a re-created section stays clean', () => {
    expect(settingsSignature(settings())).toBe(settingsSignature(draftFromSettings(settings())))
  })

  it('ignores surrounding whitespace, which the host trims before storing', () => {
    const padded = settings({ remote: ' git@example.com:team/repo.git ', branch: ' main ' })
    expect(isDirty(padded, settings())).toBe(false)
  })
})

describe('settingsPatch', () => {
  it('returns undefined when nothing changed', () => {
    expect(settingsPatch(settings(), settings())).toBeUndefined()
  })

  it('holds only the changed fields', () => {
    expect(settingsPatch(settings({ branch: 'dev' }), settings())).toEqual({ branch: 'dev' })
  })

  it('sends a nested cleanup patch for one changed cleanup field', () => {
    const draft = settings({ cleanup: { enabled: true, periodHours: 24, keepCommits: 200 } })
    expect(settingsPatch(draft, settings())).toEqual({ cleanup: { enabled: true } })
  })

  it('trims the text fields before writing', () => {
    const draft = settings({ remote: ' git@example.com:team/repo.git ', branch: ' dev ' })
    expect(settingsPatch(draft, settings())).toEqual({ branch: 'dev' })
  })

  it('treats a whitespace-only edit as no change at all', () => {
    const draft = settings({ branch: ' main ' })
    expect(isDirty(draft, settings())).toBe(false)
    expect(settingsPatch(draft, settings())).toBeUndefined()
  })

  it('carries no mapping field, whatever the section used to hold', () => {
    // A stray legacy key on the resolved section is not part of the draft any
    // more, so an old document cannot smuggle one into a write.
    const host = settings() as SyncSettingsDraft & { mappings?: unknown }
    host.mappings = [{ key: 'demo', path: '/work/demo' }]
    expect(settingsPatch(settings({ branch: 'dev' }), host)).toEqual({ branch: 'dev' })
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

  it('names every issue at once, in field order', () => {
    expect(validateDraft(settings({ remote: '', branch: '', intervalMinutes: -1 }), copy)).toEqual([
      { field: 'remote', message: 'remote required' },
      { field: 'branch', message: 'branch blank' },
      { field: 'interval', message: 'interval invalid' },
    ])
  })
})

describe('draftFromSettings', () => {
  it('copies the section so edits never mutate what the host holds', () => {
    const host = settings()
    const draft = draftFromSettings(host)
    expect(draft).toEqual(host)

    draft.cleanup.keepCommits = 5
    expect(host.cleanup.keepCommits).toBe(200)
    expect(draft.cleanup.keepCommits).toBe(5)
  })
})
