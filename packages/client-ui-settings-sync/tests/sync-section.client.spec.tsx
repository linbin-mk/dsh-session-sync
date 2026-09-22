// @vitest-environment jsdom
/** Sync section presentation: field commits, mapping edits, sync action gating, and status rendering. */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { bindSnapshotSelector } from './helpers.ts'
import { makeTranslate } from './helpers.ts'
import { SyncSection } from '../src/client/SyncSection.tsx'
import type { SyncSectionInjected, SyncSectionProps } from '../src/client/SyncSection.tsx'
import { SyncSectionController } from '../src/client/controller.ts'
import type { SyncApi } from '../src/client/api.ts'

import { zh } from '../src/client/locales.ts'


afterEach(cleanup)

const t = makeTranslate(zh) as SyncSectionInjected['t']

const baseStatus = {
  configured: false,
  repoReady: false,
  running: false,
  lastRun: { imported: 0, pushed: 0, archived: 0, conflicts: [] },
}

interface WorkspaceSnapshot {
  items: { workspaceId: string; path: string; title: string }[]
  archivedSessionIds: never[]
  state: 'idle'
  phase: 'ready'
  error: null
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
  settingsValue?: object
  statusValue?: object
  writable?: boolean
  updateError?: string
  logsValue?: unknown[]
} = {}): FakeApi {
  const document = options.settingsValue ?? {
    enabled: false,
    remote: '',
    branch: 'main',
    intervalMinutes: 5,
    mappings: [],
  }
  return {
    getSettings: vi.fn(() => Promise.resolve({ writable: options.writable ?? true, settings: document })),
    updateSettings: vi.fn((patch: object) => {
      if (options.updateError !== undefined) return Promise.reject(new Error(options.updateError))
      Object.assign(document, patch)
      return Promise.resolve()
    }),
    status: vi.fn(() => Promise.resolve(options.statusValue ?? baseStatus)),
    syncNow: vi.fn(() => Promise.resolve(baseStatus)),
    cleanupNow: vi.fn(() => Promise.resolve(baseStatus)),
    logs: vi.fn(() => Promise.resolve(options.logsValue ?? [])),
  }
}

/** Test-shaped snapshot for the `useWorkspaces` standard hook. */
const workspaceList = (items: { workspaceId: string; path: string; title: string }[] = []): WorkspaceSnapshot => ({
  items: items as never,
  archivedSessionIds: [],
  state: 'idle',
  phase: 'ready',
  error: null,
})

async function mount(options: {
  api?: FakeApi
  settingsValue?: object
  statusValue?: object
  writable?: boolean
  workspaces?: { workspaceId: string; path: string; title: string }[]
  logsValue?: unknown[]
} = {}) {
  const api = options.api ?? fakeApi({
    ...options.settingsValue === undefined ? {} : { settingsValue: options.settingsValue },
    ...options.statusValue === undefined ? {} : { statusValue: options.statusValue },
    ...options.writable === undefined ? {} : { writable: options.writable },
    ...options.logsValue === undefined ? {} : { logsValue: options.logsValue },
  })
  const controller = new SyncSectionController(api as SyncApi)
  const injected: SyncSectionInjected = {
    controller,
    t,
    hooks: { snapshot: controller.store },
  }
  const props: SyncSectionProps = {
    ...injected,
    // The renderer binds the injected hooks compartment into this prop;
    // the direct-mount spec supplies the same binding itself.
    useSnapshot: bindSnapshotSelector(controller.store),
    useWorkspaces: (selector: (snapshot: WorkspaceSnapshot) => unknown) => selector(workspaceList(options.workspaces ?? [
      { workspaceId: 'w1', path: '/work/demo', title: 'demo' },
    ])),
  }
  const view = render(<SyncSection {...props} />)
  await waitFor(() => { expect(controller.store.getSnapshot().status).toBe('ready') })
  return { view, api, controller }
}

describe('SyncSection', () => {
  it('renders nothing before the slot injects its dependencies', () => {
    render(<SyncSection {...{}} />)
    expect(document.body.textContent).toBe('')
  })

  it('shows the intro while loading and the failure line when the load fails', async () => {
    const api = fakeApi()
    api.status = vi.fn(() => Promise.reject(new Error('status down')))
    const controller = new SyncSectionController(api as SyncApi)
    const view = render(<SyncSection
      controller={controller}
      useSnapshot={bindSnapshotSelector(controller.store)}
      t={t}
      useWorkspaces={(selector: (snapshot: WorkspaceSnapshot) => unknown) => selector(workspaceList())}
    />)
    expect(screen.getByText(t('intro'))).toBeTruthy()
    await waitFor(() => { expect(screen.getByText(new RegExp(t('loadFailed')))).toBeTruthy() })
    view.unmount()
  })

  it('commits the master switch and text fields through the wire', async () => {
    const { api } = await mount()
    fireEvent.click(screen.getByRole('checkbox', { name: t('enabled') }))
    await waitFor(() => {
      expect(api.updateSettings).toHaveBeenCalledWith({ enabled: true })
    })

    const remote = screen.getByLabelText(t('remote'))
    fireEvent.change(remote, { target: { value: 'git@example.com:team/repo.git' } })
    fireEvent.focusOut(remote)
    await waitFor(() => {
      expect(api.updateSettings).toHaveBeenCalledWith({ remote: 'git@example.com:team/repo.git' })
    })

    const branch = screen.getByLabelText(t('branch'))
    fireEvent.change(branch, { target: { value: 'develop' } })
    fireEvent.focusOut(branch)
    await waitFor(() => {
      expect(api.updateSettings).toHaveBeenCalledWith({ branch: 'develop' })
    })

    const interval = screen.getByLabelText(t('interval'))
    fireEvent.change(interval, { target: { value: '10' } })
    await waitFor(() => {
      expect(api.updateSettings).toHaveBeenCalledWith({ intervalMinutes: 10 })
    })
  })

  it('skips unchanged blur commits', async () => {
    const { api } = await mount({
      settingsValue: {
        enabled: false, remote: 'git@example.com:team/repo.git', branch: 'main', intervalMinutes: 5, mappings: [],
      },
    })
    const before = api.updateSettings.mock.calls.length
    const remote = screen.getByLabelText(t('remote'))
    fireEvent.focusOut(remote)
    const branch = screen.getByLabelText(t('branch'))
    fireEvent.focusOut(branch)
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(api.updateSettings.mock.calls.length).toBe(before)
  })

  it('adds, edits, and removes mapping rows with title-defaulted keys', async () => {
    const { api } = await mount({
      workspaces: [
        { workspaceId: 'w1', path: '/work/demo', title: 'demo' },
        { workspaceId: 'w2', path: '/work/server', title: 'server' },
      ],
    })
    fireEvent.click(screen.getByRole('button', { name: t('addMapping') }))
    await waitFor(() => {
      expect(api.updateSettings).toHaveBeenCalledWith({
        mappings: [{ key: 'demo', path: '/work/demo' }],
      })
    })
    // The post-write reload lands before the edit, so the draft it publishes
    // cannot clobber the typed key.
    await waitFor(() => { expect(api.getSettings.mock.calls.length).toBeGreaterThanOrEqual(2) })

    const key = screen.getByLabelText(t('mappingKey'))
    fireEvent.change(key, { target: { value: 'server' } })
    fireEvent.focusOut(key)
    await waitFor(() => {
      expect(api.updateSettings).toHaveBeenCalledWith({
        mappings: [{ key: 'server', path: '/work/demo' }],
      })
    })

    const path = screen.getByLabelText(t('mappingPath'))
    fireEvent.change(path, { target: { value: '/work/demo' } })
    await waitFor(() => {
      expect(api.updateSettings).toHaveBeenCalledWith({
        mappings: [{ key: 'server', path: '/work/demo' }],
      })
    })

    // A second row defaults to the workspace title again (no duplicate) and
    // exercises the untouched-entry arm of the mapping rewrite.
    fireEvent.click(screen.getByRole('button', { name: t('addMapping') }))
    await waitFor(() => { expect(api.getSettings.mock.calls.length).toBeGreaterThanOrEqual(3) })
    const firstKey = screen.getAllByLabelText(t('mappingKey'))[0]!
    fireEvent.change(firstKey, { target: { value: 'prod' } })
    fireEvent.focusOut(firstKey)
    await waitFor(() => {
      expect(api.updateSettings).toHaveBeenCalledWith({
        mappings: [{ key: 'prod', path: '/work/demo' }, { key: 'demo', path: '/work/demo' }],
      })
    })

    // Editing the first path rewrites its row and leaves the second untouched.
    const firstPath = screen.getAllByLabelText(t('mappingPath'))[0]!
    fireEvent.change(firstPath, { target: { value: '/work/server' } })
    await waitFor(() => {
      expect(api.updateSettings).toHaveBeenCalledWith({
        mappings: [{ key: 'prod', path: '/work/server' }, { key: 'demo', path: '/work/demo' }],
      })
    })

    fireEvent.click(screen.getAllByRole('button', { name: new RegExp(t('removeMapping', { key: 'prod' }).slice(0, 3)) })[0]!)
    await waitFor(() => {
      expect(api.updateSettings).toHaveBeenCalledWith({
        mappings: [{ key: 'demo', path: '/work/demo' }],
      })
    })
  })

  it('labels the remove button by position when a row key is blank', async () => {
    await mount({
      settingsValue: { enabled: true, remote: 'git@example.com:team/repo.git', branch: 'main', intervalMinutes: 5, mappings: [{ key: '', path: '/work/demo' }] },
    })
    expect(screen.getByRole('button', { name: t('removeMapping', { key: '#1' }) })).toBeTruthy()
  })

  it('renders the remove action as an icon-only trash button', async () => {
    await mount({
      settingsValue: { enabled: true, remote: 'git@example.com:team/repo.git', branch: 'main', intervalMinutes: 5, mappings: [{ key: 'demo', path: '/work/demo' }] },
    })
    const remove = screen.getByRole('button', { name: t('removeMapping', { key: 'demo' }) })
    // The old text label is gone: the accessible name now rides the aria-label
    // and the visible content is only the trash icon.
    expect(remove.textContent).toBe('')
    expect(remove.querySelector('svg')).toBeTruthy()
    expect(screen.queryByText(t('removeMapping', { key: 'demo' }))).toBeNull()
  })

  it('de-duplicates the title-defaulted key with a numeric suffix', async () => {
    const { api } = await mount({
      settingsValue: { enabled: true, remote: 'git@example.com:team/repo.git', branch: 'main', intervalMinutes: 5, mappings: [{ key: 'demo', path: '/work/demo' }] },
      workspaces: [
        { workspaceId: 'w1', path: '/work/demo', title: 'demo' },
        { workspaceId: 'w2', path: '/work/server', title: 'server' },
      ],
    })
    fireEvent.click(screen.getByRole('button', { name: t('addMapping') }))
    await waitFor(() => {
      expect(api.updateSettings).toHaveBeenCalledWith({
        mappings: [{ key: 'demo', path: '/work/demo' }, { key: 'demo-2', path: '/work/demo' }],
      })
    })
  })

  it('skips occupied numeric suffixes when de-duplicating the default key', async () => {
    const { api } = await mount({
      settingsValue: { enabled: true, remote: 'git@example.com:team/repo.git', branch: 'main', intervalMinutes: 5, mappings: [{ key: 'demo', path: '/work/demo' }, { key: 'demo-2', path: '/work/server' }] },
      workspaces: [
        { workspaceId: 'w1', path: '/work/demo', title: 'demo' },
        { workspaceId: 'w2', path: '/work/server', title: 'server' },
      ],
    })
    fireEvent.click(screen.getByRole('button', { name: t('addMapping') }))
    await waitFor(() => {
      expect(api.updateSettings).toHaveBeenCalledWith({
        mappings: [{ key: 'demo', path: '/work/demo' }, { key: 'demo-2', path: '/work/server' }, { key: 'demo-3', path: '/work/demo' }],
      })
    })
  })

  it('gates the sync button on configuration and runs the cycle', async () => {
    const api = fakeApi({
      settingsValue: { enabled: false, remote: '', branch: 'main', intervalMinutes: 5, mappings: [] },
    })
    const mounted = await mount({ api })
    expect(screen.getByRole('button', { name: t('syncNow') })).toHaveProperty('disabled', true)
    expect(screen.getByText(t('notConfigured'))).toBeTruthy()

    api.getSettings = vi.fn(() => Promise.resolve({
      writable: true,
      settings: {
        enabled: true, remote: 'git@example.com:team/repo.git', branch: 'main', intervalMinutes: 5, mappings: [],
      },
    }))
    await act(async () => { await mounted.controller.load() })
    fireEvent.click(screen.getByRole('button', { name: t('syncNow') }))
    await waitFor(() => { expect(api.syncNow).toHaveBeenCalledWith() })
  })

  it('shows an unparsable last-sync instant verbatim', async () => {
    await mount({
      settingsValue: { enabled: true, remote: 'git@example.com:team/repo.git', branch: 'main', intervalMinutes: 5, mappings: [] },
      statusValue: { configured: true, repoReady: true, running: false, lastSyncAt: 'garbage', lastRun: { imported: 0, pushed: 0, archived: 0, conflicts: [] } },
    })
    expect(screen.getByText(t('lastSyncAt', { time: 'garbage' }))).toBeTruthy()
  })

  it('renders the status view lines including counts, conflicts, and failures', async () => {
    await mount({
      settingsValue: { enabled: true, remote: 'git@example.com:team/repo.git', branch: 'main', intervalMinutes: 5, mappings: [] },
      statusValue: {
        configured: true,
        repoReady: true,
        running: false,
        lastSyncAt: '2026-08-16T00:00:00.000Z',
        lastError: 'git push failed',
        lastErrorAt: '2026-08-16T00:05:00.000Z',
        lastRun: { imported: 2, pushed: 1, archived: 3, conflicts: ['conflicts/demo/a-h.jsonl'] },
      },
    })
    expect(screen.getByText(t('repoReady'))).toBeTruthy()
    expect(screen.getByText(t('imported', { count: 2 }))).toBeTruthy()
    expect(screen.getByText(t('pushed', { count: 1 }))).toBeTruthy()
    expect(screen.getByText(t('archived', { count: 3 }))).toBeTruthy()
    expect(screen.getByText(t('conflicts', { count: 1 }))).toBeTruthy()
    // The failure line names its own instant so it cannot read as part of the last successful run.
    expect(screen.getByText(t('syncFailedAt', {
      time: new Date('2026-08-16T00:05:00.000Z').toLocaleString(),
      message: 'git push failed',
    }))).toBeTruthy()
  })

  it('renders the cycle log panel with records newest first', async () => {
    await mount({
      logsValue: [
        { time: '2026-08-29T08:00:02.000Z', kind: 'success', pushed: 1, durationMs: 1234 },
        { time: '2026-08-29T08:00:01.000Z', kind: 'failure', error: 'git ls-remote --heads failed' },
        { time: '2026-08-29T08:00:00.000Z', kind: 'start' },
      ],
    })
    expect(screen.getByText(t('syncLogTitle'))).toBeTruthy()
    expect(screen.getByText(t('syncLogStart'))).toBeTruthy()
    expect(screen.getByText(t('syncLogFailure', { message: 'git ls-remote --heads failed' }))).toBeTruthy()
    const entries = screen.getAllByText(/成功|Success/)
    expect(entries.length).toBeGreaterThan(0)
  })

  it('shows the empty log hint while no records exist', async () => {
    await mount()
    expect(screen.getByText(t('syncLogEmpty'))).toBeTruthy()
  })

  it('surfaces write and sync failures and the read-only posture', async () => {
    const api = fakeApi({
      settingsValue: { enabled: true, remote: 'git@example.com:team/repo.git', branch: 'main', intervalMinutes: 5, mappings: [] },
      writable: false,
      updateError: 'remote is required when the plugin is enabled',
    })
    const mounted = await mount({ api })
    expect(screen.getByText(t('readOnly'))).toBeTruthy()

    act(() => {
      mounted.controller.store.update((state) => { state.syncError = 'sync transport down' })
    })
    expect(screen.getByText(t('syncFailed', { message: 'sync transport down' }))).toBeTruthy()
    act(() => {
      mounted.controller.store.update((state) => { state.writable = true })
    })
    fireEvent.click(screen.getByRole('checkbox', { name: t('enabled') }))
    await waitFor(() => {
      expect(screen.getByText(t('writeFailed', { message: 'remote is required when the plugin is enabled' }))).toBeTruthy()
    })
  })

  it('shows a stored path that no workspace choice carries', async () => {
    await mount({
      settingsValue: { enabled: true, remote: 'git@example.com:team/repo.git', branch: 'main', intervalMinutes: 5, mappings: [{ key: 'demo', path: '/gone' }] },
      workspaces: [{ workspaceId: 'w1', path: '/work/demo', title: 'demo' }],
    })
    expect(screen.getByText('/gone')).toBeTruthy()
  })

  it('warns about missing workspaces and disables the mapping controls', async () => {
    await mount({ workspaces: [] })
    expect(screen.getByText(t('noWorkspaces'))).toBeTruthy()
    expect(screen.getByRole('button', { name: t('addMapping') })).toHaveProperty('disabled', true)
    expect(screen.getByText(t('unmapped'))).toBeTruthy()
  })

  it('commits the cleanup switch, period, and kept-commit count through the wire', async () => {
    const { api } = await mount()
    fireEvent.click(screen.getByRole('checkbox', { name: t('cleanupEnabled') }))
    await waitFor(() => {
      expect(api.updateSettings).toHaveBeenCalledWith({ cleanup: { enabled: true, periodHours: 24, keepCommits: 200 } })
    })
    // The post-write reload lands before the next edit publishes the draft.
    await waitFor(() => { expect(api.getSettings.mock.calls.length).toBeGreaterThanOrEqual(2) })

    const period = screen.getByLabelText(t('cleanupPeriod'))
    fireEvent.change(period, { target: { value: '72' } })
    await waitFor(() => {
      expect(api.updateSettings).toHaveBeenCalledWith({ cleanup: { enabled: true, periodHours: 72, keepCommits: 200 } })
    })
    await waitFor(() => { expect(api.getSettings.mock.calls.length).toBeGreaterThanOrEqual(3) })

    const keep = screen.getByLabelText(t('cleanupKeep'))
    fireEvent.change(keep, { target: { value: '50' } })
    fireEvent.focusOut(keep)
    await waitFor(() => {
      expect(api.updateSettings).toHaveBeenCalledWith({ cleanup: { enabled: true, periodHours: 72, keepCommits: 50 } })
    })
  })

  it('keeps the current cleanup values when the count input goes invalid', async () => {
    const { api } = await mount({
      settingsValue: {
        enabled: false, remote: '', branch: 'main', intervalMinutes: 5, mappings: [],
        cleanup: { enabled: true, periodHours: 24, keepCommits: 200 },
      },
    })
    const keep = screen.getByLabelText(t('cleanupKeep'))
    fireEvent.change(keep, { target: { value: '' } }) // transient while typing
    fireEvent.focusOut(keep)
    fireEvent.change(keep, { target: { value: '-3' } })
    fireEvent.focusOut(keep)
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(api.updateSettings).not.toHaveBeenCalled()
    expect((keep as HTMLInputElement).value).toBe('200')
  })

  it('gates the cleanup button on configuration and runs the pass', async () => {
    const api = fakeApi({
      settingsValue: { enabled: false, remote: '', branch: 'main', intervalMinutes: 5, mappings: [] },
    })
    const mounted = await mount({ api })
    expect(screen.getByRole('button', { name: t('cleanupNow') })).toHaveProperty('disabled', true)

    api.getSettings = vi.fn(() => Promise.resolve({
      writable: true,
      settings: {
        enabled: true, remote: 'git@example.com:team/repo.git', branch: 'main', intervalMinutes: 5, mappings: [],
      },
    }))
    await act(async () => { await mounted.controller.load() })
    fireEvent.click(screen.getByRole('button', { name: t('cleanupNow') }))
    await waitFor(() => { expect(api.cleanupNow).toHaveBeenCalledWith() })
  })

  it('renders the last cleanup outcome and a cleanup failure line', async () => {
    await mount({
      settingsValue: { enabled: true, remote: 'git@example.com:team/repo.git', branch: 'main', intervalMinutes: 5, mappings: [] },
      statusValue: {
        configured: true,
        repoReady: true,
        running: false,
        lastCleanup: { at: '2026-08-29T08:00:00.000Z', dropped: 3 },
        cleanupError: 'git push --force-with-lease failed',
        cleanupErrorAt: '2026-08-29T09:00:00.000Z',
        lastRun: { imported: 0, pushed: 0, archived: 0, conflicts: [] },
      },
    })
    expect(screen.getByText(t('lastCleanupAt', {
      time: new Date('2026-08-29T08:00:00.000Z').toLocaleString(),
      dropped: 3,
    }))).toBeTruthy()
    expect(screen.getByText(t('cleanupFailedAt', {
      time: new Date('2026-08-29T09:00:00.000Z').toLocaleString(),
      message: 'git push --force-with-lease failed',
    }))).toBeTruthy()
  })

  it('renders the cleanup count on a success log record', async () => {
    await mount({
      logsValue: [
        { time: '2026-08-29T08:00:02.000Z', kind: 'success', cleanupDropped: 7 },
      ],
    })
    expect(screen.getByText(new RegExp(t('cleanupDropped', { count: 7 })))).toBeTruthy()
  })
})
