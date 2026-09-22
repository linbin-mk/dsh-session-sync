import { describe, expect, it } from 'vitest'
import {
  DEFAULT_BRANCH, DEFAULT_CLEANUP_KEEP_COMMITS, DEFAULT_CLEANUP_PERIOD_HOURS,
  DEFAULT_INTERVAL_MINUTES, SessionSyncSettingsSchema, validateSessionSyncSettings,
} from '../src/settings.ts'
import type { SessionSyncSettings } from '../src/settings.ts'

function settings(overrides: Partial<SessionSyncSettings> = {}): SessionSyncSettings {
  return {
    enabled: false,
    remote: '',
    branch: DEFAULT_BRANCH,
    intervalMinutes: DEFAULT_INTERVAL_MINUTES,
    mappings: [],
    cleanup: {
      enabled: false,
      periodHours: DEFAULT_CLEANUP_PERIOD_HOURS,
      keepCommits: DEFAULT_CLEANUP_KEEP_COMMITS,
    },
    ...overrides,
  }
}

describe('SessionSyncSettingsSchema', () => {
  it('resolves defaults for every absent field', () => {
    expect(SessionSyncSettingsSchema({} as never)).toEqual(settings())
  })

  it('resolves the cleanup defaults: disabled, 24-hour period, 200 kept commits', () => {
    expect(SessionSyncSettingsSchema({ cleanup: {} } as never).cleanup).toEqual({
      enabled: false,
      periodHours: 24,
      keepCommits: 200,
    })
  })

  it('rejects an interval below one minute', () => {
    expect(() => SessionSyncSettingsSchema({ intervalMinutes: 0 } as never)).toThrow()
  })

  it('rejects a cleanup period below one hour and fewer than one kept commit', () => {
    expect(() => SessionSyncSettingsSchema({ cleanup: { periodHours: 0 } } as never)).toThrow()
    expect(() => SessionSyncSettingsSchema({ cleanup: { keepCommits: 0 } } as never)).toThrow()
  })
})

describe('validateSessionSyncSettings', () => {
  it('accepts a disabled plugin without a remote and a fully configured one', () => {
    expect(() => { validateSessionSyncSettings(settings()) }).not.toThrow()
    expect(() => {
      validateSessionSyncSettings(settings({
        enabled: true,
        remote: 'git@example.com:team/repo.git',
        mappings: [{ key: 'demo', path: '/work/demo' }],
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

  it('rejects blank mapping keys and paths', () => {
    expect(() => {
      validateSessionSyncSettings(settings({ mappings: [{ key: ' ', path: '/a' }] }))
    }).toThrow(/mappings\[0\]\.key must not be blank/)
    expect(() => {
      validateSessionSyncSettings(settings({ mappings: [{ key: 'demo', path: '' }] }))
    }).toThrow(/mappings\[0\]\.path must not be blank/)
  })

  it('rejects duplicate keys and duplicate paths', () => {
    expect(() => {
      validateSessionSyncSettings(settings({
        mappings: [{ key: 'demo', path: '/a' }, { key: 'demo', path: '/b' }],
      }))
    }).toThrow(/duplicate mapping key "demo"/)
    expect(() => {
      validateSessionSyncSettings(settings({
        mappings: [{ key: 'a', path: '/same' }, { key: 'b', path: '/same' }],
      }))
    }).toThrow(/duplicate mapping path "\/same"/)
  })
})
