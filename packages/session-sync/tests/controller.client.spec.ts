/**
 * Sync page controller behavior: snapshot loads, generation guards, the
 * selection tree (load, fail-soft, refresh, optimistic session mutations),
 * and the write/sync paths.
 */
import { describe, expect, it, vi } from 'vitest'
import { SyncSectionController, menuStateOf, SESSION_SYNC_SETTINGS_NAMESPACE, SYNC_INTERVAL_CHOICES } from '../src/client/controller.ts'
import type { SyncSettingsDraft } from '../src/client/controller.ts'
import type { SyncApi } from '../src/client/api.ts'
import {
  FakeConfigForm, fakeSyncApi, selectionSession, selectionView, statusView, writtenPatch,
} from './helpers.ts'

const baseSettingsValue: SyncSettingsDraft = {
  enabled: true,
  remote: 'git@example.com:team/repo.git',
  branch: 'main',
  intervalMinutes: 5,
  cleanup: { enabled: false, periodHours: 24, keepCommits: 200 },
}

/** A controller over one API double and one configuration-form double. */
function bench(
  api: ReturnType<typeof fakeSyncApi>,
  form: FakeConfigForm<SyncSettingsDraft> = new FakeConfigForm<SyncSettingsDraft>(),
): SyncSectionController {
  return new SyncSectionController(api as unknown as SyncApi, form)
}

describe('SyncSectionController.load', () => {
  it('loads the section from the shared form with its writability', async () => {
    const api = fakeSyncApi({ status: statusView({ configured: true, repoReady: true }) })
    const form = new FakeConfigForm<SyncSettingsDraft>({ value: { ...baseSettingsValue } })
    const controller = bench(api, form)
    await controller.load()

    expect(controller.store.getSnapshot()).toMatchObject({
      status: 'ready',
      error: null,
      writable: true,
      settings: baseSettingsValue,
      sync: { configured: true, repoReady: true },
    })
    // The shared form served the section: the plugin's own route was not read.
    expect(api.getSettings).not.toHaveBeenCalled()
  })

  it('loads the selection tree and the cycle log alongside the section', async () => {
    const selection = selectionView({
      workspaces: [{ name: 'demo', matched: true, matches: 1, sessions: [selectionSession({ id: 's1' })] }],
      total: 1,
    })
    const api = fakeSyncApi({ selection, logs: [{ time: '2026-08-29T08:00:00.000Z', kind: 'start' }] })
    const controller = bench(api, new FakeConfigForm<SyncSettingsDraft>({ value: { ...baseSettingsValue } }))
    await controller.load()

    expect(controller.store.getSnapshot().selection).toBe(selection)
    expect(controller.store.getSnapshot().selectionError).toBeNull()
    expect(controller.store.getSnapshot().logs).toEqual([{ time: '2026-08-29T08:00:00.000Z', kind: 'start' }])
    expect(api.getSelection).toHaveBeenCalled()
  })

  it('names the settings namespace it addresses', () => {
    expect(SESSION_SYNC_SETTINGS_NAMESPACE).toBe('session-sync')
    expect(SYNC_INTERVAL_CHOICES).toContain(5)
  })

  it('reads the resolved section from the plugin route while the form serves nothing', async () => {
    const api = fakeSyncApi({
      status: statusView({ configured: true, repoReady: true }),
      settingsValue: { enabled: true, remote: 'git@example.com:team/repo.git', branch: 'main', intervalMinutes: 5 },
    })
    const controller = bench(api)
    await controller.load()

    expect(controller.store.getSnapshot()).toMatchObject({
      status: 'ready',
      writable: true,
      settings: { remote: 'git@example.com:team/repo.git' },
    })
    expect(api.getSettings).toHaveBeenCalled()
  })

  it('keeps a process-local page read-only even when the route reports writable', async () => {
    const api = fakeSyncApi({ status: statusView({ configured: true }) })
    const controller = bench(api, new FakeConfigForm<SyncSettingsDraft>({ mode: 'memory' }))
    await controller.load()

    expect(controller.store.getSnapshot().status).toBe('ready')
    expect(controller.store.getSnapshot().settings).toBeDefined()
    expect(controller.store.getSnapshot().writable).toBe(false)
  })

  it('keeps a page read-only while the form reports the Host document unwritable', async () => {
    const api = fakeSyncApi()
    const controller = bench(api, new FakeConfigForm<SyncSettingsDraft>({ value: { ...baseSettingsValue }, writable: false }))
    await controller.load()
    expect(controller.store.getSnapshot().writable).toBe(false)
  })

  it('adopts a published form section without another round-trip', async () => {
    const api = fakeSyncApi()
    const form = new FakeConfigForm<SyncSettingsDraft>({ value: { ...baseSettingsValue } })
    const controller = bench(api, form)
    await controller.load()
    const reads = api.getSettings.mock.calls.length

    form.publish({ ...baseSettingsValue, intervalMinutes: 30 })
    controller.adoptSettings()
    expect(controller.store.getSnapshot().settings?.intervalMinutes).toBe(30)
    expect(api.getSettings.mock.calls.length).toBe(reads)
  })

  it('ignores a published snapshot while the form serves no section', async () => {
    const api = fakeSyncApi()
    const form = new FakeConfigForm<SyncSettingsDraft>({ value: { ...baseSettingsValue } })
    const controller = bench(api, form)
    await controller.load()

    form.publish(undefined)
    controller.adoptSettings()
    expect(controller.store.getSnapshot().settings?.intervalMinutes).toBe(5)
  })

  it('fills defaults for absent fields without inventing a mapping list', async () => {
    const api = fakeSyncApi({ settingsValue: { enabled: false } })
    const controller = bench(api)
    await controller.load()

    expect(controller.store.getSnapshot().settings).toEqual({
      enabled: false,
      remote: '',
      branch: 'main',
      intervalMinutes: 5,
      cleanup: { enabled: false, periodHours: 24, keepCommits: 200 },
    })
  })

  it('decodes cleanup fields with fallbacks and clamps sub-minimum values', async () => {
    const api = fakeSyncApi({
      settingsValue: { enabled: true, cleanup: { enabled: true, periodHours: 72, keepCommits: 50 } },
    })
    const controller = bench(api)
    await controller.load()
    expect(controller.store.getSnapshot().settings?.cleanup).toEqual({ enabled: true, periodHours: 72, keepCommits: 50 })

    const clamped = fakeSyncApi({ settingsValue: { enabled: false, cleanup: { enabled: 'yes', periodHours: 0, keepCommits: -3 } } })
    const second = bench(clamped)
    await second.load()
    expect(second.store.getSnapshot().settings?.cleanup).toEqual({ enabled: false, periodHours: 24, keepCommits: 200 })
  })

  it('treats a non-object section value as absent', async () => {
    const api = fakeSyncApi({ settingsValue: 'not-an-object' })
    const controller = bench(api)
    await controller.load()
    expect(controller.store.getSnapshot().settings).toBeUndefined()
  })

  it('surfaces a rejected sync status during load', async () => {
    const api = fakeSyncApi()
    api.status = vi.fn(() => Promise.reject(new Error('status absent')))
    const controller = bench(api)
    await controller.load()
    expect(controller.store.getSnapshot().status).toBe('error')
    expect(controller.store.getSnapshot().error).toBe('status absent')
  })

  it('surfaces a settings failure as an error snapshot', async () => {
    const api = fakeSyncApi()
    api.getSettings = vi.fn(() => Promise.reject(new Error('settings down')))
    const controller = bench(api)
    await controller.load()

    expect(controller.store.getSnapshot().status).toBe('error')
    expect(controller.store.getSnapshot().error).toBe('settings down')
  })

  it('surfaces a thrown non-Error transport failure', async () => {
    const api = fakeSyncApi()
    api.status = vi.fn(() => { throw 'status transport down' })
    const controller = bench(api)
    await controller.load()
    expect(controller.store.getSnapshot().status).toBe('error')
    expect(controller.store.getSnapshot().error).toBe('status transport down')
  })

  it('drops a stale failing load after a newer one landed', async () => {
    let rejectSlow!: (reason: unknown) => void
    const slow = new Promise<never>((_resolve, reject) => { rejectSlow = reject })
    const api = fakeSyncApi()
    api.status = vi.fn()
      .mockReturnValueOnce(slow)
      .mockReturnValueOnce(Promise.resolve(statusView()))
    const controller = bench(api)

    const first = controller.load()
    await controller.load()
    expect(controller.store.getSnapshot().status).toBe('ready')
    rejectSlow('stale status failure')
    await first.catch(() => undefined)

    expect(controller.store.getSnapshot().status).toBe('ready')
  })

  it('never lets an older load overwrite a newer one', async () => {
    let resolveSlow!: (value: object) => void
    const slow = new Promise<object>((resolve) => { resolveSlow = resolve })
    const api = fakeSyncApi()
    api.status = vi.fn()
      .mockReturnValueOnce(slow)
      .mockReturnValueOnce(Promise.resolve(statusView()))
    const controller = bench(api)

    const first = controller.load()
    await controller.load()
    resolveSlow(statusView({ configured: true }))
    await first

    expect(controller.store.getSnapshot().sync?.configured).toBe(false)
  })

  it('keeps the page ready when only the log read fails', async () => {
    const api = fakeSyncApi()
    api.logs = vi.fn(() => Promise.reject(new Error('logs down')))
    const controller = bench(api)
    await controller.load()

    expect(controller.store.getSnapshot().status).toBe('ready')
    expect(controller.store.getSnapshot().logs).toBeUndefined()
  })

  it('keeps the page ready when only the selection read fails, and says so', async () => {
    const api = fakeSyncApi({ selectionError: 'selection down' })
    const controller = bench(api, new FakeConfigForm<SyncSettingsDraft>({ value: { ...baseSettingsValue } }))
    await controller.load()

    expect(controller.store.getSnapshot().status).toBe('ready')
    expect(controller.store.getSnapshot().selection).toBeUndefined()
    expect(controller.store.getSnapshot().selectionError).toBe('selection down')
  })
})

describe('SyncSectionController.refreshSelection', () => {
  it('keeps the last good tree when a later read fails', async () => {
    const good = selectionView({ workspaces: [{ name: 'demo', matched: true, matches: 1, sessions: [selectionSession({ id: 's1' })] }], total: 1 })
    const api = fakeSyncApi({ selection: good })
    const controller = bench(api)
    await controller.refreshSelection()
    expect(controller.store.getSnapshot().selection).toBe(good)

    api.getSelection = vi.fn(() => Promise.reject(new Error('selection down')))
    expect(await controller.refreshSelection()).toBe('selection down')
    expect(controller.store.getSnapshot().selection).toBe(good)
    expect(controller.store.getSnapshot().selectionError).toBe('selection down')
  })

  it('drops a stale failing read after a newer one landed', async () => {
    let rejectSlow!: (reason: unknown) => void
    const slow = new Promise<never>((_resolve, reject) => { rejectSlow = reject })
    const api = fakeSyncApi()
    api.getSelection = vi.fn()
      .mockReturnValueOnce(slow)
      .mockReturnValueOnce(Promise.resolve(selectionView({ total: 3 })))
    const controller = bench(api)

    const first = controller.refreshSelection()
    await controller.refreshSelection()
    rejectSlow('stale selection failure')
    await first
    expect(controller.store.getSnapshot().selectionError).toBeNull()
    expect(controller.store.getSnapshot().selection?.total).toBe(3)
  })

  it('never lets an older tree overwrite a newer one', async () => {
    let resolveSlow!: (value: unknown) => void
    const slow = new Promise((resolve) => { resolveSlow = resolve })
    const api = fakeSyncApi()
    api.getSelection = vi.fn()
      .mockReturnValueOnce(slow)
      .mockReturnValueOnce(Promise.resolve(selectionView({ total: 2 })))
    const controller = bench(api)

    const first = controller.refreshSelection()
    await controller.refreshSelection()
    resolveSlow(selectionView({ total: 99 }))
    await first
    expect(controller.store.getSnapshot().selection?.total).toBe(2)
  })
})

describe('menuStateOf', () => {
  it('reads configuration, selection, and holding out of one snapshot', () => {
    const state = {
      ...bench(fakeSyncApi()).store.getSnapshot(),
      sync: statusView({ configured: true }),
      selection: selectionView({
        workspaces: [
          {
            key: 'ws-1',
            name: 'demo',
            matched: true,
            matches: 1,
            sessions: [selectionSession({ id: 'held' }), selectionSession({ id: 'away', present: false })],
          },
        ],
        pending: [{ key: 'ws-2', name: 'other', sessionIds: ['pending'], matches: 0 }],
        total: 2,
      }),
    }
    const menu = menuStateOf(state)
    expect(menu.configured).toBe(true)
    expect([...menu.selected].sort()).toEqual(['away', 'held', 'pending'])
    expect([...menu.unheld]).toEqual(['away'])
  })

  it('projects the optimistic deltas over the host tree', () => {
    const state = {
      ...bench(fakeSyncApi()).store.getSnapshot(),
      sync: statusView({ configured: true }),
      selection: selectionView({
        workspaces: [{ name: 'demo', matched: true, matches: 1, sessions: [selectionSession({ id: 's1' })] }],
        total: 1,
      }),
      optimistic: { added: ['s2'], removed: ['s1'] },
    }
    const menu = menuStateOf(state)
    expect([...menu.selected]).toEqual(['s2'])
  })

  it('reports an unconfigured plugin even while a tree is loaded', () => {
    const state = {
      ...bench(fakeSyncApi()).store.getSnapshot(),
      sync: statusView({ configured: false }),
      selection: selectionView({
        workspaces: [{ name: 'demo', matched: true, matches: 1, sessions: [selectionSession({ id: 's1' })] }],
        total: 1,
      }),
    }
    expect(menuStateOf(state).configured).toBe(false)
  })
})

describe('SyncSectionController.menu projection', () => {
  it('is identity-stable per snapshot revision, which the bound hook requires', async () => {
    const api = fakeSyncApi({ status: statusView({ configured: true }) })
    const controller = bench(api)
    const first = controller.menu.getSnapshot()
    expect(controller.menu.getSnapshot()).toBe(first)

    await controller.refreshSelection()
    const second = controller.menu.getSnapshot()
    expect(second).not.toBe(first)
    expect(controller.menu.getSnapshot()).toBe(second)
  })

  it('notifies subscribers through the store', () => {
    const controller = bench(fakeSyncApi())
    const listener = vi.fn()
    const unsubscribe = controller.menu.subscribe(listener)
    controller.store.update((state) => { state.selectionError = 'later' })
    expect(listener).toHaveBeenCalled()
    unsubscribe()
  })
})

describe('SyncSectionController.selectSession', () => {
  it('lands the optimistic delta first and accepts the answered tree', async () => {
    const answered = selectionView({
      workspaces: [{ name: 'demo', matched: true, matches: 1, sessions: [selectionSession({ id: 's1' })] }],
      total: 1,
    })
    const api = fakeSyncApi({ selection: answered, status: statusView({ configured: true, syncedCount: 1 }) })
    const controller = bench(api)

    const pending = controller.selectSession('s1')
    // Before the host answers, the label already reads 「会话同步中」.
    expect(menuStateOf(controller.store.getSnapshot()).selected.has('s1')).toBe(true)
    expect(await pending).toBeUndefined()

    expect(api.selectSession).toHaveBeenCalledWith('s1')
    expect(controller.store.getSnapshot().selection).toBe(answered)
    expect(controller.store.getSnapshot().optimistic).toEqual({ added: [], removed: [] })
    // The host starts a cycle with the request, so the counts follow.
    expect(api.status).toHaveBeenCalled()
    expect(controller.store.getSnapshot().sync?.syncedCount).toBe(1)
  })

  it('retracts the optimistic delta when the host refuses', async () => {
    const api = fakeSyncApi({ sessionError: 'unknown session' })
    const controller = bench(api)

    expect(await controller.selectSession('s1')).toBe('unknown session')
    expect(menuStateOf(controller.store.getSnapshot()).selected.size).toBe(0)
    expect(controller.store.getSnapshot().sessionError).toBe('unknown session')
  })

  it('swallows a failing status re-read after an accepted selection', async () => {
    const api = fakeSyncApi()
    api.status = vi.fn(() => Promise.reject(new Error('status down')))
    const controller = bench(api)
    expect(await controller.selectSession('s1')).toBeUndefined()
    expect(controller.store.getSnapshot().selection).toBeDefined()
  })
})

describe('SyncSectionController.closeSession', () => {
  it('drops the session optimistically and accepts the answered tree', async () => {
    const answered = selectionView()
    const api = fakeSyncApi({ selection: answered, status: statusView({ configured: true }) })
    const controller = bench(api)
    await controller.refreshSelection()

    const pending = controller.closeSession('s1')
    expect(controller.store.getSnapshot().optimistic.removed).toEqual(['s1'])
    expect(await pending).toBeUndefined()

    expect(api.closeSession).toHaveBeenCalledWith('s1')
    expect(controller.store.getSnapshot().selection).toBe(answered)
    expect(controller.store.getSnapshot().optimistic).toEqual({ added: [], removed: [] })
  })

  it('restores the entry when the host refuses to close it', async () => {
    const api = fakeSyncApi({ sessionError: 'not in the selection' })
    const controller = bench(api)

    expect(await controller.closeSession('s1')).toBe('not in the selection')
    expect(controller.store.getSnapshot().optimistic).toEqual({ added: [], removed: [] })
    expect(controller.store.getSnapshot().sessionError).toBe('not in the selection')
  })
})

describe('SyncSectionController.loadRecords', () => {
  it('passes the session id to the route and answers its records', async () => {
    const records = [{ host: 'machine-b', at: '2026-08-29T08:00:00.000Z', direction: 'pull', events: 2, result: 'ok' } as const]
    const api = fakeSyncApi({ records: [...records] })
    const controller = bench(api)

    expect(await controller.loadRecords('s1')).toEqual(records)
    expect(api.getRecords).toHaveBeenCalledWith('s1')
  })

  it('rejects so the dialog can render its own error state', async () => {
    const api = fakeSyncApi({ recordsError: 'records down' })
    const controller = bench(api)
    await expect(controller.loadRecords('s1')).rejects.toThrow('records down')
  })
})

describe('SyncSectionController.update', () => {
  it('writes one path op per field through the shared form and reloads', async () => {
    const api = fakeSyncApi()
    const form = new FakeConfigForm<SyncSettingsDraft>({
      value: { enabled: false, remote: '', branch: 'main', intervalMinutes: 5, cleanup: { enabled: false, periodHours: 24, keepCommits: 200 } },
    })
    const controller = bench(api, form)
    await controller.load()

    expect(await controller.update({ enabled: true, intervalMinutes: 10 })).toBeUndefined()
    expect(form.writes).toHaveLength(1)
    expect(writtenPatch(form)).toEqual({ enabled: true, intervalMinutes: 10 })
    // The reload serves the committed section.
    expect(controller.store.getSnapshot().settings).toMatchObject({ enabled: true, intervalMinutes: 10 })
  })

  it('returns the host rejection message without a reload on a refused write', async () => {
    const api = fakeSyncApi()
    const form = new FakeConfigForm<SyncSettingsDraft>({ value: { ...baseSettingsValue } })
    form.writeError = 'remote is required when the plugin is enabled'
    const controller = bench(api, form)
    await controller.load()
    const reads = api.getSettings.mock.calls.length

    expect(await controller.update({ enabled: true, remote: '' })).toBe('remote is required when the plugin is enabled')
    expect(form.writes).toHaveLength(0)
    expect(api.getSettings.mock.calls.length).toBe(reads)
    expect(controller.store.getSnapshot().settings).toMatchObject(baseSettingsValue)
  })

  it('answers a form refusal with the host message from the validated route', async () => {
    const api = fakeSyncApi()
    api.updateSettings = vi.fn(() => Promise.reject(new Error('session-sync: remote is required when the plugin is enabled')))
    const form = new FakeConfigForm<SyncSettingsDraft>({ value: { ...baseSettingsValue } })
    form.refuseWrites = true
    const controller = bench(api, form)
    await controller.load()

    expect(await controller.update({ enabled: true, remote: '' }))
      .toBe('session-sync: remote is required when the plugin is enabled')
    expect(api.updateSettings).toHaveBeenCalledWith({ enabled: true, remote: '' })
    expect(controller.store.getSnapshot().settings?.remote).toBe('git@example.com:team/repo.git')
  })

  it('re-reads the persisted section after a skipped write', async () => {
    const api = fakeSyncApi()
    const form = new FakeConfigForm<SyncSettingsDraft>({ value: { ...baseSettingsValue } })
    form.skipWrites = true
    const controller = bench(api, form)
    await controller.load()

    expect(await controller.update({ enabled: false })).toBeUndefined()
    expect(form.writes).toHaveLength(0)
    expect(controller.store.getSnapshot().settings?.enabled).toBe(true)
  })
})

describe('SyncSectionController.syncNow', () => {
  it('runs a cycle, accepts the answered status, and refreshes the log and tree', async () => {
    const answered = statusView({
      configured: true,
      lastSyncAt: '2026-08-16T00:00:00.000Z',
      lastRun: {
        imported: 2, pushed: 1, archived: 1, deleted: 1, deletedUnselected: 1,
        adopted: 1, dropped: 1, conflicts: ['c'],
      },
    })
    const api = fakeSyncApi({
      status: answered,
      logs: [{ time: '2026-08-29T08:00:00.000Z', kind: 'success' }],
    })
    const controller = bench(api)
    await controller.load()
    api.getSelection.mockClear()

    expect(await controller.syncNow()).toBeUndefined()
    expect(controller.store.getSnapshot()).toMatchObject({
      syncing: false,
      syncError: null,
      sync: { configured: true, lastRun: { adopted: 1, dropped: 1, deletedUnselected: 1 } },
      logs: [{ time: '2026-08-29T08:00:00.000Z', kind: 'success' }],
    })
    // The manual cycle may import, adopt, or drop selection entries.
    expect(api.getSelection).toHaveBeenCalled()
  })

  it('surfaces a rejected sync as syncError and stops syncing', async () => {
    const api = fakeSyncApi({ syncNowError: 'session sync is disabled or has no configured remote' })
    const controller = bench(api)
    await controller.load()

    expect(await controller.syncNow()).toBe('session sync is disabled or has no configured remote')
    expect(controller.store.getSnapshot().syncing).toBe(false)
    expect(controller.store.getSnapshot().syncError).toBe('session sync is disabled or has no configured remote')
  })
})

describe('SyncSectionController.cleanupNow', () => {
  it('runs a cleanup pass and accepts the answered status view', async () => {
    const api = fakeSyncApi({
      status: statusView({ lastCleanup: { at: '2026-08-29T08:00:00.000Z', dropped: 5 } }),
      logs: [{ time: '2026-08-29T08:00:00.000Z', kind: 'success' }],
    })
    const controller = bench(api)
    await controller.load()

    expect(await controller.cleanupNow()).toBeUndefined()
    expect(controller.store.getSnapshot()).toMatchObject({
      cleaning: false,
      syncError: null,
      sync: { lastCleanup: { at: '2026-08-29T08:00:00.000Z', dropped: 5 } },
    })
    expect(api.logs).toHaveBeenCalled()
  })

  it('surfaces a thrown transport failure as syncError', async () => {
    const api = fakeSyncApi()
    api.cleanupNow = vi.fn(() => Promise.reject(new Error('cleanup transport down')))
    const controller = bench(api)
    await controller.load()

    expect(await controller.cleanupNow()).toBe('cleanup transport down')
    expect(controller.store.getSnapshot().cleaning).toBe(false)
    expect(controller.store.getSnapshot().syncError).toBe('cleanup transport down')
  })
})
