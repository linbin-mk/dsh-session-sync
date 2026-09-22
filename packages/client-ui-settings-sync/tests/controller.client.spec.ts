/** Sync page controller behavior: snapshot loads, generation guard, and the write/sync paths. */
import { describe, expect, it, vi } from 'vitest'
import { SyncSectionController } from '../src/client/controller.ts'
import type { SyncApi } from '../src/client/api.ts'


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
  statusValue?: object
  updateThrows?: boolean
  syncNowResult?: object
  syncNowThrows?: boolean
  cleanupNowResult?: object
  cleanupNowThrows?: boolean
  logsValue?: unknown[]
  logsThrows?: boolean
} = {}): FakeApi {
  return {
    getSettings: vi.fn(() => Promise.resolve({ writable: true, settings: options.settingsValue ?? baseSettingsValue })),
    updateSettings: vi.fn(() => options.updateThrows === true
      ? Promise.reject(new Error('update transport down'))
      : Promise.resolve()),
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

describe('SyncSectionController.load', () => {
  it('loads settings and status into a ready snapshot', async () => {
    const api = fakeApi({ statusValue: { ...baseStatus, configured: true, repoReady: true } })
    const controller = new SyncSectionController(api as SyncApi)
    await controller.load()

    expect(controller.store.getSnapshot()).toMatchObject({
      status: 'ready',
      error: null,
      writable: true,
      settings: { enabled: true, remote: 'git@example.com:team/repo.git', branch: 'main', intervalMinutes: 5, mappings: [{ key: 'demo', path: '/work/demo' }] },
      sync: { configured: true, repoReady: true },
    })
  })

  it('fills defaults for absent fields and skips malformed mapping entries', async () => {
    const api = fakeApi({
      settingsValue: { enabled: false, mappings: [{ key: 'demo', path: '/a' }, 'garbage', { key: 7, path: '/b' }, { key: 'x' }] },
    })
    const controller = new SyncSectionController(api as SyncApi)
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
    const controller = new SyncSectionController(api as SyncApi)
    await controller.load()
    expect(controller.store.getSnapshot().settings?.cleanup).toEqual({ enabled: true, periodHours: 72, keepCommits: 50 })

    const clamped = fakeApi({ settingsValue: { enabled: false, cleanup: { enabled: 'yes', periodHours: 0, keepCommits: -3 } } })
    const second = new SyncSectionController(clamped as SyncApi)
    await second.load()
    expect(second.store.getSnapshot().settings?.cleanup).toEqual({ enabled: false, periodHours: 24, keepCommits: 200 })
  })

  it('treats a non-object section value and a non-array mappings field as absent', async () => {
    const api = fakeApi({ settingsValue: 'not-an-object' })
    const controller = new SyncSectionController(api as SyncApi)
    await controller.load()
    expect(controller.store.getSnapshot().settings).toBeUndefined()

    const weird = fakeApi({ settingsValue: { enabled: false, mappings: 'nope' } })
    const second = new SyncSectionController(weird as SyncApi)
    await second.load()
    expect(second.store.getSnapshot().settings?.mappings).toEqual([])
  })

  it('surfaces a rejected sync status during load', async () => {
    const api = fakeApi()
    api.status = vi.fn(() => Promise.reject(new Error('status absent')))
    const controller = new SyncSectionController(api as SyncApi)
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
    const controller = new SyncSectionController(api as SyncApi)

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
    const controller = new SyncSectionController(api as SyncApi)
    await controller.load()

    expect(controller.store.getSnapshot().status).toBe('ready')
    expect(controller.store.getSnapshot().settings).toBeUndefined()
  })

  it('surfaces a settings failure as an error snapshot', async () => {
    const api = fakeApi()
    api.getSettings = vi.fn(() => Promise.reject(new Error('settings down')))
    const controller = new SyncSectionController(api as SyncApi)
    await controller.load()

    expect(controller.store.getSnapshot().status).toBe('error')
    expect(controller.store.getSnapshot().error).toBe('settings down')
  })

  it('surfaces a thrown non-Error transport failure', async () => {
    const api = fakeApi()
    api.status = vi.fn(() => { throw 'status transport down' })
    const controller = new SyncSectionController(api as SyncApi)
    await controller.load()
    expect(controller.store.getSnapshot().status).toBe('error')
    expect(controller.store.getSnapshot().error).toBe('status transport down')
  })

  it('surfaces a thrown transport failure and keeps last good values on a later success', async () => {
    const api = fakeApi()
    api.status = vi.fn(() => Promise.reject(new Error('status transport down')))
    const controller = new SyncSectionController(api as SyncApi)
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
    const controller = new SyncSectionController(api as SyncApi)

    const first = controller.load()
    await controller.load()
    resolveSlow({ ...baseStatus, configured: true })
    await first

    expect(controller.store.getSnapshot().sync?.configured).toBe(false)
  })

  it('loads the cycle log into the snapshot', async () => {
    const api = fakeApi({ logsValue: [{ time: '2026-08-29T08:00:00.000Z', kind: 'start' }] })
    const controller = new SyncSectionController(api as SyncApi)
    await controller.load()

    expect(controller.store.getSnapshot().logs).toEqual([{ time: '2026-08-29T08:00:00.000Z', kind: 'start' }])
    expect(api.logs).toHaveBeenCalled()
  })

  it('keeps the page ready when only the log read fails', async () => {
    const api = fakeApi({ logsThrows: true })
    const controller = new SyncSectionController(api as SyncApi)
    await controller.load()

    expect(controller.store.getSnapshot().status).toBe('ready')
    expect(controller.store.getSnapshot().logs).toBeUndefined()
  })
})

describe('SyncSectionController.update', () => {
  it('writes through the wire and reloads the snapshot', async () => {
    const api = fakeApi()
    const controller = new SyncSectionController(api as SyncApi)
    await controller.load()

    expect(await controller.update({ enabled: false })).toBeUndefined()
    expect(api.updateSettings).toHaveBeenCalledWith({ enabled: false })
  })

  it('returns the host rejection message without reloading on a refused write', async () => {
    const api = fakeApi()
    api.updateSettings = vi.fn(() => Promise.reject(new Error('remote is required when the plugin is enabled')))
    const controller = new SyncSectionController(api as SyncApi)
    await controller.load()
    const loads = api.getSettings.mock.calls.length

    expect(await controller.update({ enabled: true, remote: '' })).toBe('remote is required when the plugin is enabled')
    expect(api.getSettings.mock.calls.length).toBe(loads)
  })

  it('returns the transport message when the write throws', async () => {
    const api = fakeApi({ updateThrows: true })
    const controller = new SyncSectionController(api as SyncApi)
    await controller.load()

    expect(await controller.update({ enabled: false })).toBe('update transport down')
  })
})

describe('SyncSectionController.syncNow', () => {
  it('runs a cycle and accepts the answered status view', async () => {
    const api = fakeApi({
      syncNowResult: { ...baseStatus, configured: true, lastSyncAt: '2026-08-16T00:00:00.000Z', lastRun: { imported: 2, pushed: 1, archived: 1, deleted: 1, conflicts: ['c'] } },
      logsValue: [{ time: '2026-08-29T08:00:00.000Z', kind: 'success' }],
    })
    const controller = new SyncSectionController(api as SyncApi)
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
    const controller = new SyncSectionController(api as SyncApi)
    await controller.load()

    expect(await controller.syncNow()).toBe('session sync is disabled or has no configured remote')
    expect(controller.store.getSnapshot().syncing).toBe(false)
    expect(controller.store.getSnapshot().syncError).toBe('session sync is disabled or has no configured remote')
  })

  it('surfaces a thrown transport failure as syncError', async () => {
    const api = fakeApi({ syncNowThrows: true })
    const controller = new SyncSectionController(api as SyncApi)
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
    const controller = new SyncSectionController(api as SyncApi)
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
    const controller = new SyncSectionController(api as SyncApi)
    await controller.load()

    expect(await controller.cleanupNow()).toBe('session sync is disabled or has no configured remote')
    expect(controller.store.getSnapshot().cleaning).toBe(false)
    expect(controller.store.getSnapshot().syncError).toBe('session sync is disabled or has no configured remote')
  })

  it('surfaces a thrown transport failure as syncError', async () => {
    const api = fakeApi({ cleanupNowThrows: true })
    const controller = new SyncSectionController(api as SyncApi)
    await controller.load()

    expect(await controller.cleanupNow()).toBe('cleanup transport down')
    expect(controller.store.getSnapshot().cleaning).toBe(false)
  })
})
