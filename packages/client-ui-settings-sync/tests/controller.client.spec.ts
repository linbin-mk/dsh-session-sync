/** Sync page controller behavior: snapshot loads, generation guard, and the write/sync paths. */
import { describe, expect, it, vi } from 'vitest'
import { SyncSectionController } from '../src/client/controller.ts'
import type { SyncApi } from '../src/client/api.ts'
import { FakeConfigForm, writtenPatch } from './helpers.ts'
import type { SyncSettingsDraft } from '../src/client/controller.ts'


const baseStatus = {
  configured: false,
  repoReady: false,
  running: false,
  lastRun: { imported: 0, pushed: 0, archived: 0, deleted: 0, conflicts: [] },
}

const baseSettingsValue = {
  enabled: true,
  remote: 'git@example.com:team/repo.git',
  branch: 'main',
  intervalMinutes: 5,
  mappings: [{ key: 'demo', path: '/work/demo' }],
}

interface FakeApi {
  getSettings: ReturnType<typeof vi.fn>
  updateSettings: ReturnType<typeof vi.fn>
  status: ReturnType<typeof vi.fn>
  syncNow: ReturnType<typeof vi.fn>
  cleanupNow: ReturnType<typeof vi.fn>
  logs: ReturnType<typeof vi.fn>
}

function fakeApi(options: {
  settingsValue?: unknown
  writable?: boolean
  settingsThrows?: boolean
  updateThrows?: string
  statusValue?: object
  syncNowResult?: object
  syncNowThrows?: boolean
  cleanupNowResult?: object
  cleanupNowThrows?: boolean
  logsValue?: unknown[]
  logsThrows?: boolean
} = {}): FakeApi {
  return {
    getSettings: vi.fn(() => options.settingsThrows === true
      ? Promise.reject(new Error('settings down'))
      : Promise.resolve({ writable: options.writable ?? true, settings: options.settingsValue ?? baseSettingsValue })),
    updateSettings: vi.fn(() => options.updateThrows === undefined
      ? Promise.resolve()
      : Promise.reject(new Error(options.updateThrows))),
    status: vi.fn(() => Promise.resolve(options.statusValue ?? baseStatus)),
    syncNow: vi.fn(() => options.syncNowThrows === true
      ? Promise.reject(new Error('sync transport down'))
      : Promise.resolve(options.syncNowResult ?? baseStatus)),
    cleanupNow: vi.fn(() => options.cleanupNowThrows === true
      ? Promise.reject(new Error('cleanup transport down'))
      : Promise.resolve(options.cleanupNowResult ?? baseStatus)),
    logs: vi.fn(() => options.logsThrows === true
      ? Promise.reject(new Error('logs transport down'))
      : Promise.resolve(options.logsValue ?? [])),
  }
}

/** A controller over one API double and one configuration-form double. */
function bench(api: FakeApi, form: FakeConfigForm<SyncSettingsDraft>): SyncSectionController {
  return new SyncSectionController(api as SyncApi, form)
}

describe('SyncSectionController.load', () => {
  it('loads the section from the shared form with its writability', async () => {
    const api = fakeApi({ statusValue: { ...baseStatus, configured: true, repoReady: true } })
    const form = new FakeConfigForm<SyncSettingsDraft>({ value: baseSettingsValue })
    const controller = bench(api, form)
    await controller.load()

    expect(controller.store.getSnapshot()).toMatchObject({
      status: 'ready',
      error: null,
      writable: true,
      settings: { enabled: true, remote: 'git@example.com:team/repo.git', branch: 'main', intervalMinutes: 5, mappings: [{ key: 'demo', path: '/work/demo' }] },
      sync: { configured: true, repoReady: true },
    })
    // The shared form served the section: the plugin's own route was not read.
    expect(api.getSettings).not.toHaveBeenCalled()
  })

  it('reads the resolved section from the plugin route while the form serves nothing', async () => {
    const api = fakeApi({ statusValue: { ...baseStatus, configured: true, repoReady: true } })
    const controller = bench(api, new FakeConfigForm<SyncSettingsDraft>())
    await controller.load()

    expect(controller.store.getSnapshot()).toMatchObject({
      status: 'ready',
      writable: true,
      settings: { remote: 'git@example.com:team/repo.git' },
    })
    expect(api.getSettings).toHaveBeenCalled()
  })

  it('keeps a process-local page read-only even when the route reports writable', async () => {
    const api = fakeApi({ statusValue: { ...baseStatus, configured: true } })
    const controller = bench(api, new FakeConfigForm<SyncSettingsDraft>({ mode: 'memory' }))
    await controller.load()

    expect(controller.store.getSnapshot().status).toBe('ready')
    expect(controller.store.getSnapshot().settings).toBeDefined()
    expect(controller.store.getSnapshot().writable).toBe(false)
  })

  it('keeps a page read-only while the form reports the Host document unwritable', async () => {
    const api = fakeApi()
    const controller = bench(api, new FakeConfigForm<SyncSettingsDraft>({ value: baseSettingsValue, writable: false }))
    await controller.load()
    expect(controller.store.getSnapshot().writable).toBe(false)
  })

  it('adopts a published form section without another round-trip', async () => {
    const api = fakeApi()
    const form = new FakeConfigForm<SyncSettingsDraft>({ value: baseSettingsValue })
    const controller = bench(api, form)
    await controller.load()
    const reads = api.getSettings.mock.calls.length

    form.publish({ ...baseSettingsValue, intervalMinutes: 30 })
    controller.adoptSettings()
    expect(controller.store.getSnapshot().settings?.intervalMinutes).toBe(30)
    expect(api.getSettings.mock.calls.length).toBe(reads)
  })

  it('ignores a published snapshot while the form serves no section', async () => {
    const api = fakeApi()
    const form = new FakeConfigForm<SyncSettingsDraft>({ value: baseSettingsValue })
    const controller = bench(api, form)
    await controller.load()

    form.publish(undefined)
    controller.adoptSettings()
    expect(controller.store.getSnapshot().settings?.intervalMinutes).toBe(5)
  })

  it('fills defaults for absent fields and skips malformed mapping entries', async () => {
    const api = fakeApi({
      settingsValue: { enabled: false, mappings: [{ key: 'demo', path: '/a' }, 'garbage', { key: 7, path: '/b' }, { key: 'x' }] },
    })
    const controller = bench(api, new FakeConfigForm<SyncSettingsDraft>())
    await controller.load()

    expect(controller.store.getSnapshot().settings).toEqual({
      enabled: false,
      remote: '',
      branch: 'main',
      intervalMinutes: 5,
      mappings: [{ key: 'demo', path: '/a' }],
      cleanup: { enabled: false, periodHours: 24, keepCommits: 200 },
    })
  })

  it('decodes cleanup fields with fallbacks and clamps sub-minimum values', async () => {
    const api = fakeApi({
      settingsValue: {
        enabled: true,
        cleanup: { enabled: true, periodHours: 72, keepCommits: 50 },
      },
    })
    const controller = bench(api, new FakeConfigForm<SyncSettingsDraft>())
    await controller.load()
    expect(controller.store.getSnapshot().settings?.cleanup).toEqual({ enabled: true, periodHours: 72, keepCommits: 50 })

    const clamped = fakeApi({ settingsValue: { enabled: false, cleanup: { enabled: 'yes', periodHours: 0, keepCommits: -3 } } })
    const second = bench(clamped, new FakeConfigForm<SyncSettingsDraft>())
    await second.load()
    expect(second.store.getSnapshot().settings?.cleanup).toEqual({ enabled: false, periodHours: 24, keepCommits: 200 })
  })

  it('treats a non-object section value and a non-array mappings field as absent', async () => {
    const api = fakeApi({ settingsValue: 'not-an-object' })
    const controller = bench(api, new FakeConfigForm<SyncSettingsDraft>())
    await controller.load()
    expect(controller.store.getSnapshot().settings).toBeUndefined()

    const weird = fakeApi({ settingsValue: { enabled: false, mappings: 'nope' } })
    const second = bench(weird, new FakeConfigForm<SyncSettingsDraft>())
    await second.load()
    expect(second.store.getSnapshot().settings?.mappings).toEqual([])
  })

  it('surfaces a rejected sync status during load', async () => {
    const api = fakeApi()
    api.status = vi.fn(() => Promise.reject(new Error('status absent')))
    const controller = bench(api, new FakeConfigForm<SyncSettingsDraft>())
    await controller.load()
    expect(controller.store.getSnapshot().status).toBe('error')
    expect(controller.store.getSnapshot().error).toBe('status absent')
  })

  it('drops a stale failing load after a newer one landed', async () => {
    let rejectSlow!: (reason: unknown) => void
    const slow = new Promise<never>((_resolve, reject) => { rejectSlow = reject })
    const api = fakeApi()
    api.status = vi.fn()
      .mockReturnValueOnce(slow)
      .mockReturnValueOnce(Promise.resolve(baseStatus))
    const controller = bench(api, new FakeConfigForm<SyncSettingsDraft>())

    const first = controller.load()
    await controller.load()
    expect(controller.store.getSnapshot().status).toBe('ready')
    rejectSlow('stale status failure')
    await first.catch(() => undefined)

    expect(controller.store.getSnapshot().status).toBe('ready')
  })

  it('stays ready without settings when the section is absent', async () => {
    const api = fakeApi()
    api.getSettings = vi.fn(() => Promise.resolve({ writable: true, settings: undefined }))
    const controller = bench(api, new FakeConfigForm<SyncSettingsDraft>())
    await controller.load()

    expect(controller.store.getSnapshot().status).toBe('ready')
    expect(controller.store.getSnapshot().settings).toBeUndefined()
  })

  it('surfaces a settings failure as an error snapshot', async () => {
    const api = fakeApi()
    api.getSettings = vi.fn(() => Promise.reject(new Error('settings down')))
    const controller = bench(api, new FakeConfigForm<SyncSettingsDraft>())
    await controller.load()

    expect(controller.store.getSnapshot().status).toBe('error')
    expect(controller.store.getSnapshot().error).toBe('settings down')
  })

  it('surfaces a thrown non-Error transport failure', async () => {
    const api = fakeApi()
    api.status = vi.fn(() => { throw 'status transport down' })
    const controller = bench(api, new FakeConfigForm<SyncSettingsDraft>())
    await controller.load()
    expect(controller.store.getSnapshot().status).toBe('error')
    expect(controller.store.getSnapshot().error).toBe('status transport down')
  })

  it('surfaces a thrown transport failure and keeps last good values on a later success', async () => {
    const api = fakeApi()
    api.status = vi.fn(() => Promise.reject(new Error('status transport down')))
    const controller = bench(api, new FakeConfigForm<SyncSettingsDraft>())
    await controller.load()
    expect(controller.store.getSnapshot().status).toBe('error')
    expect(controller.store.getSnapshot().error).toBe('status transport down')

    api.status = vi.fn(() => Promise.resolve(baseStatus))
    await controller.load()
    expect(controller.store.getSnapshot().status).toBe('ready')
  })

  it('never lets an older load overwrite a newer one', async () => {
    let resolveSlow!: (value: object) => void
    const slow = new Promise<object>((resolve) => { resolveSlow = resolve })
    const api = fakeApi()
    api.status = vi.fn()
      .mockReturnValueOnce(slow)
      .mockReturnValueOnce(Promise.resolve(baseStatus))
    const controller = bench(api, new FakeConfigForm<SyncSettingsDraft>())

    const first = controller.load()
    await controller.load()
    resolveSlow({ ...baseStatus, configured: true })
    await first

    expect(controller.store.getSnapshot().sync?.configured).toBe(false)
  })

  it('loads the cycle log into the snapshot', async () => {
    const api = fakeApi({ logsValue: [{ time: '2026-08-29T08:00:00.000Z', kind: 'start' }] })
    const controller = bench(api, new FakeConfigForm<SyncSettingsDraft>())
    await controller.load()

    expect(controller.store.getSnapshot().logs).toEqual([{ time: '2026-08-29T08:00:00.000Z', kind: 'start' }])
    expect(api.logs).toHaveBeenCalled()
  })

  it('keeps the page ready when only the log read fails', async () => {
    const api = fakeApi({ logsThrows: true })
    const controller = bench(api, new FakeConfigForm<SyncSettingsDraft>())
    await controller.load()

    expect(controller.store.getSnapshot().status).toBe('ready')
    expect(controller.store.getSnapshot().logs).toBeUndefined()
  })
})

describe('SyncSectionController.update', () => {
  it('writes one path op per field through the shared form and reloads', async () => {
    const api = fakeApi()
    const form = new FakeConfigForm<SyncSettingsDraft>({ value: { enabled: false, remote: '', branch: 'main', intervalMinutes: 5, mappings: [] } })
    const controller = bench(api, form)
    await controller.load()

    expect(await controller.update({ enabled: true, intervalMinutes: 10 })).toBeUndefined()
    expect(form.writes).toHaveLength(1)
    expect(writtenPatch(form)).toEqual({ enabled: true, intervalMinutes: 10 })
    // The reload serves the committed section.
    expect(controller.store.getSnapshot().settings).toMatchObject({ enabled: true, intervalMinutes: 10 })
  })

  it('returns the host rejection message without a reload on a refused write', async () => {
    const api = fakeApi()
    const form = new FakeConfigForm<SyncSettingsDraft>({ value: baseSettingsValue })
    form.writeError = 'remote is required when the plugin is enabled'
    const controller = bench(api, form)
    await controller.load()
    const reads = api.getSettings.mock.calls.length

    expect(await controller.update({ enabled: true, remote: '' })).toBe('remote is required when the plugin is enabled')
    expect(form.writes).toHaveLength(0)
    expect(api.getSettings.mock.calls.length).toBe(reads)
    expect(controller.store.getSnapshot().settings).toMatchObject(baseSettingsValue)
  })

  it('returns the transport message when the write throws', async () => {
    const api = fakeApi()
    const form = new FakeConfigForm<SyncSettingsDraft>({ value: baseSettingsValue })
    form.writeError = 'update transport down'
    const controller = bench(api, form)
    await controller.load()

    expect(await controller.update({ enabled: false })).toBe('update transport down')
  })

  it('answers a form refusal with the host message from the validated route', async () => {
    const api = fakeApi({ updateThrows: 'session-sync: remote is required when the plugin is enabled' })
    const form = new FakeConfigForm<SyncSettingsDraft>({ value: baseSettingsValue })
    form.refuseWrites = true
    const controller = bench(api, form)
    await controller.load()

    expect(await controller.update({ enabled: true, remote: '' }))
      .toBe('session-sync: remote is required when the plugin is enabled')
    expect(api.updateSettings).toHaveBeenCalledWith({ enabled: true, remote: '' })
    expect(controller.store.getSnapshot().settings?.remote).toBe('git@example.com:team/repo.git')
  })

  it('re-reads the persisted section after a skipped write', async () => {
    const api = fakeApi()
    const form = new FakeConfigForm<SyncSettingsDraft>({ value: baseSettingsValue })
    form.skipWrites = true
    const controller = bench(api, form)
    await controller.load()

    expect(await controller.update({ enabled: false })).toBeUndefined()
    expect(form.writes).toHaveLength(0)
    expect(controller.store.getSnapshot().settings?.enabled).toBe(true)
  })
})

describe('SyncSectionController.syncNow', () => {
  it('runs a cycle and accepts the answered status view', async () => {
    const api = fakeApi({
      syncNowResult: { ...baseStatus, configured: true, lastSyncAt: '2026-08-16T00:00:00.000Z', lastRun: { imported: 2, pushed: 1, archived: 1, deleted: 1, conflicts: ['c'] } },
      logsValue: [{ time: '2026-08-29T08:00:00.000Z', kind: 'success' }],
    })
    const controller = bench(api, new FakeConfigForm<SyncSettingsDraft>())
    await controller.load()

    expect(await controller.syncNow()).toBeUndefined()
    expect(controller.store.getSnapshot()).toMatchObject({
      syncing: false,
      syncError: null,
      sync: { configured: true, lastRun: { imported: 2, pushed: 1, archived: 1, deleted: 1, conflicts: ['c'] } },
      logs: [{ time: '2026-08-29T08:00:00.000Z', kind: 'success' }],
    })
    // The manual cycle appended records: the log panel refreshed after it.
    expect(api.logs).toHaveBeenCalled()
  })

  it('surfaces a rejected sync as syncError and stops syncing', async () => {
    const api = fakeApi()
    api.syncNow = vi.fn(() => Promise.reject(new Error('session sync is disabled or has no configured remote')))
    const controller = bench(api, new FakeConfigForm<SyncSettingsDraft>())
    await controller.load()

    expect(await controller.syncNow()).toBe('session sync is disabled or has no configured remote')
    expect(controller.store.getSnapshot().syncing).toBe(false)
    expect(controller.store.getSnapshot().syncError).toBe('session sync is disabled or has no configured remote')
  })

  it('surfaces a thrown transport failure as syncError', async () => {
    const api = fakeApi({ syncNowThrows: true })
    const controller = bench(api, new FakeConfigForm<SyncSettingsDraft>())
    await controller.load()

    expect(await controller.syncNow()).toBe('sync transport down')
    expect(controller.store.getSnapshot().syncing).toBe(false)
  })
})

describe('SyncSectionController.cleanupNow', () => {
  it('runs a cleanup pass and accepts the answered status view', async () => {
    const api = fakeApi({
      cleanupNowResult: { ...baseStatus, lastCleanup: { at: '2026-08-29T08:00:00.000Z', dropped: 5 } },
      logsValue: [{ time: '2026-08-29T08:00:00.000Z', kind: 'success' }],
    })
    const controller = bench(api, new FakeConfigForm<SyncSettingsDraft>())
    await controller.load()

    expect(await controller.cleanupNow()).toBeUndefined()
    expect(controller.store.getSnapshot()).toMatchObject({
      cleaning: false,
      syncError: null,
      sync: { lastCleanup: { at: '2026-08-29T08:00:00.000Z', dropped: 5 } },
      logs: [{ time: '2026-08-29T08:00:00.000Z', kind: 'success' }],
    })
    expect(api.logs).toHaveBeenCalled()
  })

  it('surfaces a rejected cleanup as syncError and stops cleaning', async () => {
    const api = fakeApi()
    api.cleanupNow = vi.fn(() => Promise.reject(new Error('session sync is disabled or has no configured remote')))
    const controller = bench(api, new FakeConfigForm<SyncSettingsDraft>())
    await controller.load()

    expect(await controller.cleanupNow()).toBe('session sync is disabled or has no configured remote')
    expect(controller.store.getSnapshot().cleaning).toBe(false)
    expect(controller.store.getSnapshot().syncError).toBe('session sync is disabled or has no configured remote')
  })

  it('surfaces a thrown transport failure as syncError', async () => {
    const api = fakeApi({ cleanupNowThrows: true })
    const controller = bench(api, new FakeConfigForm<SyncSettingsDraft>())
    await controller.load()

    expect(await controller.cleanupNow()).toBe('cleanup transport down')
    expect(controller.store.getSnapshot().cleaning).toBe(false)
  })
})
