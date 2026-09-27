// @vitest-environment jsdom
/** Sync section presentation: field commits, mapping edits, sync action gating, and status rendering. */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { bindSnapshotSelector, FakeConfigForm, writtenPatch } from './helpers.ts'
import { makeTranslate } from './helpers.ts'
import { SyncSection } from '../src/client/SyncSection.tsx'
import type { SyncSectionInjected, SyncSectionProps } from '../src/client/SyncSection.tsx'
import { SyncSectionController } from '../src/client/controller.ts'
import type { SyncSettingsDraft } from '../src/client/controller.ts'
import type { SyncApi } from '../src/client/api.ts'

import { zh } from '../src/client/locales.ts'


afterEach(cleanup)

const t = makeTranslate(zh) as SyncSectionInjected['t']

const baseStatus = {
  configured: false,
  repoReady: false,
  running: false,
  pinnedCount: 0,
  lastRun: {
    imported: 0, pushed: 0, archived: 0, deleted: 0, deletedUnpinned: 0,
    pinned: 0, unpinned: 0, conflicts: [],
  },
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
  settingsValue?: Record<string, unknown>
  statusValue?: object
  writable?: boolean
  logsValue?: unknown[]
} = {}): FakeApi {
  return {
    getSettings: vi.fn(() => Promise.resolve({
      writable: options.writable ?? true,
      settings: options.settingsValue ?? {
        enabled: false,
        remote: '',
        branch: 'main',
        intervalMinutes: 5,
        mappings: [],
      },
    })),
    updateSettings: vi.fn(() => Promise.resolve()),
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
  settingsValue?: Record<string, unknown>
  statusValue?: object
  writable?: boolean
  workspaces?: { workspaceId: string; path: string; title: string }[]
  logsValue?: unknown[]
  form?: FakeConfigForm<SyncSettingsDraft>
} = {}) {
  const api = options.api ?? fakeApi({
    ...options.settingsValue === undefined ? {} : { settingsValue: options.settingsValue },
    ...options.statusValue === undefined ? {} : { statusValue: options.statusValue },
    ...options.writable === undefined ? {} : { writable: options.writable },
    ...options.logsValue === undefined ? {} : { logsValue: options.logsValue },
  })
  // The shared form of the `session-sync` entry serves the section by
  // default; a spec that wants the plugin's own route read passes no form.
  const form = options.form ?? new FakeConfigForm<SyncSettingsDraft>({
    value: options.settingsValue ?? {
      enabled: false, remote: '', branch: 'main', intervalMinutes: 5, mappings: [],
    },
  })
  const controller = new SyncSectionController(api as SyncApi, form)
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
  return { view, api, form, controller }
}

describe('SyncSection', () => {
  it('renders nothing before the slot injects its dependencies', () => {
    render(<SyncSection {...{}} />)
    expect(document.body.textContent).toBe('')
  })

  it('shows the intro while loading and the failure line when the load fails', async () => {
    const api = fakeApi()
    api.status = vi.fn(() => Promise.reject(new Error('status down')))
    const controller = new SyncSectionController(api as SyncApi, new FakeConfigForm())
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

  it('holds every field edit in the draft and writes them as one patch on save', async () => {
    const { form } = await mount()
    const save = () => screen.getByRole('button', { name: t('save') })

    fireEvent.click(screen.getByRole('checkbox', { name: t('enabled') }))
    fireEvent.change(screen.getByLabelText(t('remote')), { target: { value: 'git@example.com:team/repo.git' } })
    fireEvent.change(screen.getByLabelText(t('branch')), { target: { value: 'develop' } })
    fireEvent.change(screen.getByLabelText(t('interval')), { target: { value: '10' } })

    // Nothing reaches the host while the user is still editing.
    expect(screen.getByText(t('unsavedChanges'))).toBeTruthy()
    expect(form.writes).toHaveLength(0)

    fireEvent.click(save())
    await waitFor(() => {
      expect(writtenPatch(form)).toEqual({
        enabled: true,
        remote: 'git@example.com:team/repo.git',
        branch: 'develop',
        intervalMinutes: 10,
      })
    })
  })

  it('offers no save action until something actually changes, and Reset drops the edits', async () => {
    const { form } = await mount({
      settingsValue: {
        enabled: false, remote: 'git@example.com:team/repo.git', branch: 'main', intervalMinutes: 5, mappings: [],
      },
    })
    expect(screen.queryByRole('button', { name: t('save') })).toBeNull()

    fireEvent.change(screen.getByLabelText(t('branch')), { target: { value: 'develop' } })
    fireEvent.click(screen.getByRole('button', { name: t('reset') }))
    expect((screen.getByLabelText(t('branch')) as HTMLInputElement).value).toBe('main')
    expect(screen.queryByRole('button', { name: t('save') })).toBeNull()
    expect(form.writes).toHaveLength(0)
  })

  it('adds a second project without a duplicate and writes both rows only on save', async () => {
    const { form, controller } = await mount({
      settingsValue: {
        enabled: true,
        remote: 'git@example.com:team/repo.git',
        branch: 'main',
        intervalMinutes: 5,
        mappings: [{ key: 'UmamiForMK', path: '/work/demo' }],
      },
      workspaces: [
        { workspaceId: 'w1', path: '/work/demo', title: 'demo' },
        { workspaceId: 'w2', path: '/work/server', title: 'server' },
      ],
    })

    // The new row starts empty — this is the fix for "adding a project always
    // collides with the first one".
    fireEvent.click(screen.getByRole('button', { name: t('addMapping') }))
    expect(form.writes).toHaveLength(0)
    const paths = screen.getAllByLabelText(t('mappingPath')) as HTMLSelectElement[]
    expect(paths).toHaveLength(2)
    expect(paths[1]!.value).toBe('')

    // An incomplete row blocks the save and says which row it is.
    fireEvent.click(screen.getByRole('button', { name: t('save') }))
    expect(screen.getByText(t('errorMappingKeyBlank', { row: 2 }))).toBeTruthy()
    expect(screen.getByText(t('errorMappingPathBlank', { row: 2 }))).toBeTruthy()
    expect(form.writes).toHaveLength(0)

    fireEvent.change(screen.getAllByLabelText(t('mappingKey'))[1]!, { target: { value: 'server' } })
    fireEvent.change(paths[1]!, { target: { value: '/work/server' } })
    fireEvent.click(screen.getByRole('button', { name: t('save') }))
    await waitFor(() => {
      expect(writtenPatch(form)).toEqual({
        mappings: [{ key: 'UmamiForMK', path: '/work/demo' }, { key: 'server', path: '/work/server' }],
      })
    })
    await waitFor(() => {
      expect(controller.store.getSnapshot().settings?.mappings)
        .toEqual([{ key: 'UmamiForMK', path: '/work/demo' }, { key: 'server', path: '/work/server' }])
    })
  })

  it('refuses a duplicate path locally instead of letting the host reject the write', async () => {
    const { form } = await mount({
      settingsValue: {
        enabled: true,
        remote: 'git@example.com:team/repo.git',
        branch: 'main',
        intervalMinutes: 5,
        mappings: [{ key: 'UmamiForMK', path: '/work/demo' }],
      },
      workspaces: [
        { workspaceId: 'w1', path: '/work/demo', title: 'demo' },
        { workspaceId: 'w2', path: '/work/server', title: 'server' },
      ],
    })

    fireEvent.click(screen.getByRole('button', { name: t('addMapping') }))
    fireEvent.change(screen.getAllByLabelText(t('mappingKey'))[1]!, { target: { value: 'other' } })
    // Same directory as row 1: exactly the mistake the old form sent to the host.
    fireEvent.change((screen.getAllByLabelText(t('mappingPath')) as HTMLSelectElement[])[1]!, {
      target: { value: '/work/demo' },
    })
    fireEvent.click(screen.getByRole('button', { name: t('save') }))

    expect(screen.getByText(t('errorMappingPathDuplicate', { path: '/work/demo' }))).toBeTruthy()
    // Save stays clickable so the message is reachable; it just writes nothing.
    expect(screen.getByRole('button', { name: t('save') })).toHaveProperty('disabled', false)
    expect(form.writes).toHaveLength(0)
  })

  it('removes a row and saves the shortened list', async () => {
    const { form } = await mount({
      settingsValue: {
        enabled: true,
        remote: 'git@example.com:team/repo.git',
        branch: 'main',
        intervalMinutes: 5,
        mappings: [{ key: 'demo', path: '/work/demo' }, { key: 'server', path: '/work/server' }],
      },
      workspaces: [
        { workspaceId: 'w1', path: '/work/demo', title: 'demo' },
        { workspaceId: 'w2', path: '/work/server', title: 'server' },
      ],
    })
    fireEvent.click(screen.getByRole('button', { name: t('removeMapping', { key: 'demo' }) }))
    expect(form.writes).toHaveLength(0)
    fireEvent.click(screen.getByRole('button', { name: t('save') }))
    await waitFor(() => {
      expect(writtenPatch(form)).toEqual({ mappings: [{ key: 'server', path: '/work/server' }] })
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

  it('gates the sync button on configuration and runs the cycle', async () => {
    const api = fakeApi({
      settingsValue: { enabled: false, remote: '', branch: 'main', intervalMinutes: 5, mappings: [] },
    })
    const mounted = await mount({ api })
    expect(screen.getByRole('button', { name: t('syncNow') })).toHaveProperty('disabled', true)
    expect(screen.getByText(t('notConfigured'))).toBeTruthy()

    mounted.form.publish({
      enabled: true, remote: 'git@example.com:team/repo.git', branch: 'main', intervalMinutes: 5, mappings: [],
    })
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
    })
    const form = new FakeConfigForm<SyncSettingsDraft>({
      value: { enabled: true, remote: 'git@example.com:team/repo.git', branch: 'main', intervalMinutes: 5, mappings: [] },
      writable: false,
    })
    const mounted = await mount({ api, form })
    expect(screen.getByText(t('readOnly'))).toBeTruthy()

    act(() => {
      mounted.controller.store.update((state) => { state.syncError = 'sync transport down' })
    })
    expect(screen.getByText(t('syncFailed', { message: 'sync transport down' }))).toBeTruthy()
    act(() => {
      mounted.controller.store.update((state) => { state.writable = true })
    })
    form.writeError = 'remote is required when the plugin is enabled'
    fireEvent.click(screen.getByRole('checkbox', { name: t('enabled') }))
    fireEvent.click(screen.getByRole('button', { name: t('save') }))
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

  it('holds the cleanup controls in the draft and writes them on save', async () => {
    const mounted = await mount()
    const form = mounted.form
    fireEvent.click(screen.getByRole('checkbox', { name: t('cleanupEnabled') }))
    fireEvent.change(screen.getByLabelText(t('cleanupPeriod')), { target: { value: '72' } })
    fireEvent.change(screen.getByLabelText(t('cleanupKeep')), { target: { value: '50' } })
    expect(form.writes).toHaveLength(0)

    fireEvent.click(screen.getByRole('button', { name: t('save') }))
    await waitFor(() => {
      expect(writtenPatch(form)).toEqual({
        cleanup: { enabled: true, periodHours: 72, keepCommits: 50 },
      })
    })
    await waitFor(() => {
      expect(mounted.controller.store.getSnapshot().settings?.cleanup)
        .toEqual({ enabled: true, periodHours: 72, keepCommits: 50 })
    })
  })

  it('keeps the current cleanup values when the count input goes invalid', async () => {
    const { form } = await mount({
      settingsValue: {
        enabled: false, remote: '', branch: 'main', intervalMinutes: 5, mappings: [],
        cleanup: { enabled: true, periodHours: 24, keepCommits: 200 },
      },
    })
    const keep = screen.getByLabelText(t('cleanupKeep'))
    fireEvent.change(keep, { target: { value: '' } }) // transient while typing
    fireEvent.change(keep, { target: { value: '-3' } })
    // The unusable value never enters the draft, so there is nothing to save:
    // the host keeps 200, no write is offered, and the field still shows 200.
    expect((keep as HTMLInputElement).value).toBe('200')
    expect(screen.queryByRole('button', { name: t('save') })).toBeNull()
    expect(form.writes).toHaveLength(0)
  })

  it('gates the cleanup button on configuration and runs the pass', async () => {
    const api = fakeApi({
      settingsValue: { enabled: false, remote: '', branch: 'main', intervalMinutes: 5, mappings: [] },
    })
    const mounted = await mount({ api })
    expect(screen.getByRole('button', { name: t('cleanupNow') })).toHaveProperty('disabled', true)

    mounted.form.publish({
      enabled: true, remote: 'git@example.com:team/repo.git', branch: 'main', intervalMinutes: 5, mappings: [],
    })
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
