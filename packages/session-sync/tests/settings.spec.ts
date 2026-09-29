import { describe, expect, it } from 'vitest'
import {
  Config, DEFAULT_BRANCH, DEFAULT_CLEANUP_KEEP_COMMITS, DEFAULT_CLEANUP_PERIOD_HOURS,
  DEFAULT_INTERVAL_MINUTES, DEFAULT_STARTUP_SYNC_DELAY_MS, readSettings, validateSessionSyncSettings,
} from '../src/settings.ts'
import type { SessionSyncSettings } from '../src/settings.ts'

function settings(overrides: Partial<SessionSyncSettings> = {}): SessionSyncSettings {
  return {
    enabled: false,
    remote: '',
    branch: DEFAULT_BRANCH,
    intervalMinutes: DEFAULT_INTERVAL_MINUTES,
    cleanup: {
      enabled: false,
      periodHours: DEFAULT_CLEANUP_PERIOD_HOURS,
      keepCommits: DEFAULT_CLEANUP_KEEP_COMMITS,
    },
    ...overrides,
  }
}

/** One field's schema metadata, as the settings page reads it. */
function fieldMeta(field: string): { volatile?: boolean } {
  const node = Config.dict?.[field]
  if (node === undefined) throw new Error(`no schema for field "${field}"`)
  return node.meta
}

describe('Config', () => {
  it('resolves defaults for every absent field', () => {
    expect(readSettings(Config({}))).toEqual(settings())
  })

  it('carries exactly the stored settings fields plus the deployment startup delay', () => {
    expect(Object.keys(Config.dict ?? {})).toEqual([
      'startupSyncDelayMs', 'enabled', 'remote', 'branch', 'intervalMinutes', 'cleanup',
    ])
  })

  it('has no project-mapping field: v2 selects sessions individually', () => {
    expect(Object.keys(Config.dict ?? {})).not.toContain('mappings')
    expect(readSettings(Config({}))).not.toHaveProperty('mappings')
  })

  it('exposes every user-editable field as a live reference and the startup delay as an ordinary value', () => {
    const config = Config({
      startupSyncDelayMs: 1_234,
      enabled: true,
      remote: 'git@example.com:team/repo.git',
      branch: 'trunk',
      intervalMinutes: 30,
      cleanup: { enabled: true, periodHours: 48, keepCommits: 20 },
    })
    expect(config.startupSyncDelayMs).toBe(1_234)
    expect(config.enabled.get()).toBe(true)
    expect(config.remote.get()).toBe('git@example.com:team/repo.git')
    expect(config.branch.get()).toBe('trunk')
    expect(config.intervalMinutes.get()).toBe(30)
    expect(config.cleanup.get()).toEqual({ enabled: true, periodHours: 48, keepCommits: 20 })
    expect(readSettings(config)).toEqual(settings({
      enabled: true,
      remote: 'git@example.com:team/repo.git',
      branch: 'trunk',
      intervalMinutes: 30,
      cleanup: { enabled: true, periodHours: 48, keepCommits: 20 },
    }))
  })

  it('marks exactly the user-editable fields volatile, so only they make a settings form', () => {
    expect(['enabled', 'remote', 'branch', 'intervalMinutes', 'cleanup']
      .every(field => fieldMeta(field).volatile === true)).toBe(true)
    expect(fieldMeta('startupSyncDelayMs').volatile).toBeUndefined()
  })

  it('detaches the section it returns from later live changes', () => {
    const config = Config({})
    const before = readSettings(config)
    before.cleanup.periodHours = 1
    before.remote = 'mutated'
    expect(readSettings(config)).toEqual(settings())
  })

  it('resolves the cleanup defaults: disabled, 24-hour period, 200 kept commits', () => {
    expect(readSettings(Config({ cleanup: {} })).cleanup).toEqual({
      enabled: false,
      periodHours: 24,
      keepCommits: 200,
    })
  })

  it('rejects an interval below one minute', () => {
    expect(() => Config({ intervalMinutes: 0 })).toThrow()
  })

  it('rejects a cleanup period below one hour and fewer than one kept commit', () => {
    expect(() => Config({ cleanup: { periodHours: 0 } })).toThrow()
    expect(() => Config({ cleanup: { keepCommits: 0 } })).toThrow()
  })
})

describe('validateSessionSyncSettings', () => {
  it('accepts a disabled plugin without a remote and a fully configured one', () => {
    expect(() => { validateSessionSyncSettings(settings()) }).not.toThrow()
    expect(() => {
      validateSessionSyncSettings(settings({
        enabled: true,
        remote: 'git@example.com:team/repo.git',
      }))
    }).not.toThrow()
  })

  it('rejects an enabled plugin without a remote', () => {
    expect(() => { validateSessionSyncSettings(settings({ enabled: true })) }).toThrow(/remote is required/)
    expect(() => {
      validateSessionSyncSettings(settings({ enabled: true, remote: '  ' }))
    }).toThrow(/remote is required/)
  })

  it('rejects a blank branch', () => {
    expect(() => { validateSessionSyncSettings(settings({ branch: ' ' })) }).toThrow(/branch must not be blank/)
  })

  it('imposes no per-project configuration rules, because it stores none', () => {
    // v1 rejected blank and duplicate mapping keys and paths. v2 has no such
    // field, so the only cross-field rules left are the remote and the branch.
    expect(() => {
      validateSessionSyncSettings(settings({ enabled: true, remote: 'git@x:y/z.git', branch: 'main' }))
    }).not.toThrow()
  })
})
