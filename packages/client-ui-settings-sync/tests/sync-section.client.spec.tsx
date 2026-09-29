// @vitest-environment jsdom
/**
 * Sync section presentation: draft-and-save field commits, the cleanup and
 * manual-sync actions, the status/log rendering, and the v2 selection tree
 * (workspace → session), its pending list, and 关闭同步 on a row. The
 * project-mapping editor this page used to carry is gone: what synchronizes
 * is the session selection, which is read-only here.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import {
  bindSnapshotSelector, FakeConfigForm, fakeSyncApi, makeTranslate, selectionSession, selectionView,
  statusView, writtenPatch,
} from './helpers.ts'
import { SyncSection } from '../src/client/SyncSection.tsx'
import type { SyncSectionInjected, SyncSectionProps } from '../src/client/SyncSection.tsx'
import { SyncSectionController } from '../src/client/controller.ts'
import type { SyncSettingsDraft } from '../src/client/controller.ts'
import type { SyncApi } from '../src/client/api.ts'
import { zh } from '../src/client/locales.ts'

afterEach(cleanup)

const t = makeTranslate(zh) as SyncSectionInjected['t']

const baseSettings: SyncSettingsDraft = {
  enabled: false,
  remote: '',
  branch: 'main',
  intervalMinutes: 5,
  cleanup: { enabled: false, periodHours: 24, keepCommits: 200 },
}

/** Mount the section over one API double and one shared-form double. */
async function mount(options: {
  api?: ReturnType<typeof fakeSyncApi>
  settingsValue?: SyncSettingsDraft
  form?: FakeConfigForm<SyncSettingsDraft>
} = {}) {
  const api = options.api ?? fakeSyncApi({ settingsValue: options.settingsValue ?? baseSettings })
  // The shared form of the `session-sync` entry serves the section by
  // default; a spec that wants the plugin's own route read passes no form.
  const form = options.form ?? new FakeConfigForm<SyncSettingsDraft>({
    value: options.settingsValue ?? baseSettings,
  })
  const controller = new SyncSectionController(api as unknown as SyncApi, form)
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
  }
  const view = render(<SyncSection {...props} />)
  await waitFor(() => { expect(controller.store.getSnapshot().status).toBe('ready') })
  return { view, api, form, controller }
}

/** The configured section most tree/status specs start from. */
const configured: SyncSettingsDraft = {
  enabled: true,
  remote: 'git@example.com:team/repo.git',
  branch: 'main',
  intervalMinutes: 5,
  cleanup: { enabled: false, periodHours: 24, keepCommits: 200 },
}

describe('SyncSection', () => {
  it('renders nothing before the slot injects its dependencies', () => {
    render(<SyncSection {...{}} />)
    expect(document.body.textContent).toBe('')
  })

  it('shows the intro while loading and the failure line when the load fails', async () => {
    const api = fakeSyncApi()
    api.status = vi.fn(() => Promise.reject(new Error('status down')))
    const controller = new SyncSectionController(api as unknown as SyncApi, new FakeConfigForm())
    const view = render(<SyncSection
      controller={controller}
      useSnapshot={bindSnapshotSelector(controller.store)}
      t={t}
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
    const { form } = await mount({ settingsValue: { ...baseSettings, remote: 'git@example.com:team/repo.git' } })
    expect(screen.queryByRole('button', { name: t('save') })).toBeNull()

    fireEvent.change(screen.getByLabelText(t('branch')), { target: { value: 'develop' } })
    fireEvent.click(screen.getByRole('button', { name: t('reset') }))
    expect((screen.getByLabelText(t('branch')) as HTMLInputElement).value).toBe('main')
    expect(screen.queryByRole('button', { name: t('save') })).toBeNull()
    expect(form.writes).toHaveLength(0)
  })

  it('keeps the cleanup controls in the draft and writes them on save', async () => {
    const mounted = await mount()
    const { form } = mounted
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
      settingsValue: { ...baseSettings, cleanup: { enabled: true, periodHours: 24, keepCommits: 200 } },
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

  it('gates the sync and cleanup buttons on configuration and runs them', async () => {
    const api = fakeSyncApi({ settingsValue: baseSettings })
    const mounted = await mount({ api })
    expect(screen.getByRole('button', { name: t('syncNow') })).toHaveProperty('disabled', true)
    expect(screen.getByRole('button', { name: t('cleanupNow') })).toHaveProperty('disabled', true)
    expect(screen.getByText(t('notConfigured'))).toBeTruthy()

    mounted.form.publish({ ...configured })
    await act(async () => { await mounted.controller.load() })
    fireEvent.click(screen.getByRole('button', { name: t('syncNow') }))
    await waitFor(() => { expect(api.syncNow).toHaveBeenCalledWith() })
    fireEvent.click(screen.getByRole('button', { name: t('cleanupNow') }))
    await waitFor(() => { expect(api.cleanupNow).toHaveBeenCalledWith() })
  })

  it('shows an unparsable last-sync instant verbatim', async () => {
    await mount({
      settingsValue: configured,
      api: fakeSyncApi({
        settingsValue: configured,
        status: statusView({ configured: true, repoReady: true, lastSyncAt: 'garbage' }),
      }),
    })
    expect(screen.getByText(t('lastSyncAt', { time: 'garbage' }))).toBeTruthy()
  })

  it('renders the v2 status view lines including counts, conflicts, and failures', async () => {
    await mount({
      settingsValue: configured,
      api: fakeSyncApi({
        settingsValue: configured,
        status: statusView({
          configured: true,
          repoReady: true,
          lastSyncAt: '2026-08-16T00:00:00.000Z',
          lastError: 'git push failed',
          lastErrorAt: '2026-08-16T00:05:00.000Z',
          lastRun: {
            imported: 2, pushed: 1, archived: 3, deleted: 0, deletedUnselected: 4,
            adopted: 5, dropped: 6, conflicts: ['conflicts/demo/a-h.jsonl'],
          },
        }),
      }),
    })
    expect(screen.getByText(t('repoReady'))).toBeTruthy()
    expect(screen.getByText(t('imported', { count: 2 }))).toBeTruthy()
    expect(screen.getByText(t('pushed', { count: 1 }))).toBeTruthy()
    expect(screen.getByText(t('archived', { count: 3 }))).toBeTruthy()
    expect(screen.getByText(t('deletedUnselected', { count: 4 }))).toBeTruthy()
    expect(screen.getByText(t('adopted', { count: 5 }))).toBeTruthy()
    expect(screen.getByText(t('dropped', { count: 6 }))).toBeTruthy()
    expect(screen.getByText(t('conflicts', { count: 1 }))).toBeTruthy()
    // The failure line names its own instant so it cannot read as part of the last successful run.
    expect(screen.getByText(t('syncFailedAt', {
      time: new Date('2026-08-16T00:05:00.000Z').toLocaleString(),
      message: 'git push failed',
    }))).toBeTruthy()
  })

  it('renders the last cleanup outcome and a cleanup failure line', async () => {
    await mount({
      settingsValue: configured,
      api: fakeSyncApi({
        settingsValue: configured,
        status: statusView({
          configured: true,
          repoReady: true,
          lastCleanup: { at: '2026-08-29T08:00:00.000Z', dropped: 3 },
          cleanupError: 'git push --force-with-lease failed',
          cleanupErrorAt: '2026-08-29T09:00:00.000Z',
        }),
      }),
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

  it('renders the cycle log panel with records newest first and its empty hint', async () => {
    await mount({
      api: fakeSyncApi({
        settingsValue: baseSettings,
        logs: [
          { time: '2026-08-29T08:00:02.000Z', kind: 'success', pushed: 1, durationMs: 1234 },
          { time: '2026-08-29T08:00:01.000Z', kind: 'failure', error: 'git ls-remote --heads failed' },
          { time: '2026-08-29T08:00:00.000Z', kind: 'start' },
        ],
      }),
    })
    expect(screen.getByText(t('syncLogTitle'))).toBeTruthy()
    expect(screen.getByText(t('syncLogStart'))).toBeTruthy()
    expect(screen.getByText(t('syncLogFailure', { message: 'git ls-remote --heads failed' }))).toBeTruthy()

    cleanup()
    await mount()
    expect(screen.getByText(t('syncLogEmpty'))).toBeTruthy()
  })

  it('surfaces write and sync failures and the read-only posture', async () => {
    const form = new FakeConfigForm<SyncSettingsDraft>({ value: { ...configured }, writable: false })
    const mounted = await mount({
      api: fakeSyncApi({ settingsValue: configured, writable: false }),
      settingsValue: configured,
      form,
    })
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
})

describe('SyncSection selection tree', () => {
  it('shows the empty state while nothing is selected', async () => {
    await mount({ settingsValue: configured, api: fakeSyncApi({ settingsValue: configured, selection: selectionView() }) })
    expect(screen.getByText(t('selectionTitle'))).toBeTruthy()
    expect(screen.getByText(t('selectionEmpty'))).toBeTruthy()
    expect(screen.queryByText(t('pendingTitle'))).toBeNull()
  })

  it('renders a matched group with its provenance, last sync, and badges', async () => {
    await mount({
      settingsValue: configured,
      api: fakeSyncApi({
        settingsValue: configured,
        selection: selectionView({
          workspaces: [{
            key: 'ws-1',
            name: 'dsh-session-sync',
            matched: true,
            matches: 1,
            sessions: [
              selectionSession({
                id: 's1',
                title: '置顶功能插槽点分析',
                addedAt: '2026-09-29T09:59:00.000Z',
                addedBy: 'machine-a',
                lastSyncAt: '2026-09-29T10:20:00.000Z',
                lastSyncHost: 'machine-b',
                lastSyncDirection: 'pull',
                lastSyncEvents: 12,
                conflicts: 2,
              }),
              selectionSession({ id: 's2', title: 'only-in-repo', present: false }),
            ],
          }],
          total: 2,
        }),
      }),
    })
    expect(screen.getByText(t('selectionTitle'))).toBeTruthy()
    expect(screen.getByText(t('selectionTotal', { count: 2 }))).toBeTruthy()
    expect(screen.getByText('dsh-session-sync')).toBeTruthy()
    expect(screen.getByText('置顶功能插槽点分析')).toBeTruthy()
    expect(screen.getByText(t('sessionAddedAt', { time: new Date('2026-09-29T09:59:00.000Z').toLocaleString() }))).toBeTruthy()
    expect(screen.getByText(t('sessionAddedBy', { host: 'machine-a' }))).toBeTruthy()
    expect(screen.getByText(t('sessionLastSync', {
      host: 'machine-b',
      time: new Date('2026-09-29T10:20:00.000Z').toLocaleString(),
    }))).toBeTruthy()
    expect(screen.getByText(t('sessionConflict', { count: 2 }))).toBeTruthy()
    // The repo knows s2 but this machine never imported it.
    expect(screen.getByText(t('sessionNotPresent'))).toBeTruthy()
    // No match warning on a group a single local workspace carries.
    expect(screen.queryByText(t('workspaceUnmatched'))).toBeNull()
    expect(screen.getAllByRole('button', { name: t('closeSync') })).toHaveLength(2)
  })

  it('warns on a group no local workspace carries, and on an ambiguous name', async () => {
    await mount({
      settingsValue: configured,
      api: fakeSyncApi({
        settingsValue: configured,
        selection: selectionView({
          workspaces: [
            { key: 'ws-1', name: 'renamed-locally', matched: false, matches: 0, sessions: [selectionSession({ id: 's1' })] },
            { key: 'ws-2', name: 'twice', matched: false, matches: 2, sessions: [selectionSession({ id: 's2' })] },
          ],
          total: 2,
        }),
      }),
    })
    expect(screen.getByText(t('workspaceUnmatched'))).toBeTruthy()
    expect(screen.getByText(t('workspaceAmbiguous'))).toBeTruthy()
  })

  it('falls back to the session id when the repo carries no title', async () => {
    await mount({
      settingsValue: configured,
      api: fakeSyncApi({
        settingsValue: configured,
        selection: selectionView({
          workspaces: [{ key: 'ws-1', name: 'demo', matched: true, matches: 1, sessions: [selectionSession({ id: 's-un titled', title: '' })] }],
          total: 1,
        }),
      }),
    })
    expect(screen.getByText('s-un titled')).toBeTruthy()
  })

  it('renders the pending workspaces with their waiting counts and the remedy', async () => {
    await mount({
      settingsValue: configured,
      api: fakeSyncApi({
        settingsValue: configured,
        selection: selectionView({
          workspaces: [{
            key: 'ws-1',
            name: 'not-here',
            matched: false,
            matches: 0,
            sessions: [selectionSession({ id: 's1', present: false }), selectionSession({ id: 's2', present: false })],
          }],
          pending: [{ key: 'ws-1', name: 'not-here', sessionIds: ['s1', 's2'], matches: 0 }],
          total: 2,
        }),
      }),
    })
    expect(screen.getByText(t('pendingTitle'))).toBeTruthy()
    expect(screen.getByText(t('pendingHint'))).toBeTruthy()
    expect(screen.getByText(t('pendingCount', { count: 2 }))).toBeTruthy()
    // No binding affordance exists on purpose: creating a same-named workspace
    // is the whole remedy.
    expect(screen.queryByRole('button', { name: /绑定|bind/i })).toBeNull()
  })

  it('closes sync from a row and re-renders the answered tree', async () => {
    const before = selectionView({
      workspaces: [{ key: 'ws-1', name: 'demo', matched: true, matches: 1, sessions: [selectionSession({ id: 's1', title: 'Demo session' })] }],
      total: 1,
    })
    const after = selectionView()
    const api = fakeSyncApi({ settingsValue: configured, selection: before, status: statusView({ configured: true }) })
    const mounted = await mount({ settingsValue: configured, api })
    expect(screen.getByText('Demo session')).toBeTruthy()

    api.closeSession.mockImplementation(() => Promise.resolve(after))
    fireEvent.click(screen.getByRole('button', { name: t('closeSync') }))
    await waitFor(() => { expect(api.closeSession).toHaveBeenCalledWith('s1') })
    // The row is gone and the page refreshes the routed selection it answered.
    await waitFor(() => { expect(screen.queryByText('Demo session')).toBeNull() })
    expect(screen.getByText(t('selectionEmpty'))).toBeTruthy()
    expect(mounted.controller.store.getSnapshot().selection).toBe(after)
    expect(api.getSelection).toHaveBeenCalled()
  })

  it('reports a refused close beside the tree', async () => {
    const api = fakeSyncApi({
      settingsValue: configured,
      selection: selectionView({
        workspaces: [{ key: 'ws-1', name: 'demo', matched: true, matches: 1, sessions: [selectionSession({ id: 's1' })] }],
        total: 1,
      }),
      sessionError: 'unknown session',
    })
    await mount({ settingsValue: configured, api })
    fireEvent.click(screen.getByRole('button', { name: t('closeSync') }))
    await waitFor(() => {
      expect(screen.getByText(t('sessionActionFailed', { message: 'unknown session' }))).toBeTruthy()
    })
    // The row stays: nothing was closed.
    expect(screen.getByRole('button', { name: t('closeSync') })).toBeTruthy()
  })

  it('reports a failed selection read without hiding the saved settings', async () => {
    await mount({
      settingsValue: configured,
      api: fakeSyncApi({ settingsValue: configured, selectionError: 'selection down' }),
    })
    expect(screen.getByText(t('selectionFailed', { message: 'selection down' }))).toBeTruthy()
    expect(screen.getByText(t('selectionEmpty'))).toBeTruthy()
    // The section itself is still the host's resolved one and stays editable.
    expect(screen.getByRole('button', { name: t('syncNow') })).toBeTruthy()
  })

  it('renders no mapping editor and no mapping copy', async () => {
    await mount({ settingsValue: configured })
    for (const key of ['mappings', 'addMapping', 'mappingKey', 'mappingPath'] as const) {
      // The keys are gone from the dictionary entirely; nothing renders them.
      expect(Object.hasOwn(zh, key)).toBe(false)
    }
    expect(screen.queryByText(/项目映射|Project mappings/)).toBeNull()
  })
})
