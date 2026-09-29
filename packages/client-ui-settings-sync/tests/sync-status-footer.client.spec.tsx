// @vitest-environment jsdom
/** Sync status footer: visibility gating, health dot, and the last-sync detail. */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, render, screen, waitFor } from '@testing-library/react'
import { bindSnapshotSelector, FakeConfigForm, fakeSyncApi, makeTranslate, statusView } from './helpers.ts'
import { SyncStatusFooter } from '../src/client/SyncStatusFooter.tsx'
import type { SyncStatusFooterInjected, SyncStatusFooterProps } from '../src/client/SyncStatusFooter.tsx'
import { SyncSectionController } from '../src/client/controller.ts'
import type { SyncSettingsDraft } from '../src/client/controller.ts'
import type { SyncApi } from '../src/client/api.ts'
import { zh } from '../src/client/locales.ts'

afterEach(cleanup)

const t = makeTranslate(zh) as SyncStatusFooterInjected['t']

async function mount(options: {
  api?: ReturnType<typeof fakeSyncApi>
  wide?: boolean
} = {}) {
  const api = options.api ?? fakeSyncApi()
  const controller = new SyncSectionController(api as unknown as SyncApi, new FakeConfigForm<SyncSettingsDraft>())
  const injected: SyncStatusFooterInjected = {
    controller,
    t,
    hooks: { snapshot: controller.store },
  }
  const props: SyncStatusFooterProps = {
    ...injected,
    // The renderer binds the injected hooks compartment into this prop.
    useSnapshot: bindSnapshotSelector(controller.store),
    wide: options.wide ?? true,
  }
  const view = render(<SyncStatusFooter {...props} />)
  await waitFor(() => { expect(controller.store.getSnapshot().status).toBe('ready') })
  return { view, api, controller }
}

describe('SyncStatusFooter', () => {
  it('renders nothing before the slot injects its dependencies', () => {
    render(<SyncStatusFooter {...{}} />)
    expect(document.body.textContent).toBe('')
  })

  it('renders nothing while the plugin is unconfigured', async () => {
    await mount()
    expect(document.body.textContent).toBe('')
  })

  it('shows the normal state with the last sync instant', async () => {
    await mount({
      api: fakeSyncApi({ status: statusView({ configured: true, lastSyncAt: '2026-08-16T08:30:00.000Z' }) }),
    })
    expect(screen.getByText(t('statusNormal'), { exact: false })).toBeTruthy()
    expect(screen.getByText(new RegExp(t('lastSyncAt', { time: '' }).slice(0, 4)), { exact: false })).toBeTruthy()
  })

  it('shows the abnormal state and surfaces the failure on hover text', async () => {
    await mount({
      api: fakeSyncApi({
        status: statusView({
          configured: true,
          lastError: 'git push failed',
          lastErrorAt: '2026-08-16T08:30:00.000Z',
          lastSyncAt: '2026-08-16T08:30:00.000Z',
        }),
      }),
    })
    expect(screen.getByText(t('statusAbnormal'), { exact: false })).toBeTruthy()
    expect(screen.getByRole('button').title).toContain('git push failed')
  })

  it('names the synced session count beside the last sync instant', async () => {
    await mount({
      api: fakeSyncApi({ status: statusView({ configured: true, syncedCount: 3, lastSyncAt: '2026-08-16T08:30:00.000Z' }) }),
    })
    // The selection size is what actually syncs, so the footer names it.
    expect(screen.getByText(new RegExp(t('syncedCount', { count: 3 }).slice(0, 4)), { exact: false })).toBeTruthy()

    await mount({ api: fakeSyncApi({ status: statusView({ configured: true, lastSyncAt: 'garbage' }) }) })
    expect(screen.getByText(new RegExp('garbage'), { exact: false })).toBeTruthy()
  })

  it('shows the syncing state while a cycle runs', async () => {
    await mount({ api: fakeSyncApi({ status: statusView({ configured: true, running: true }) }) })
    expect(screen.getByText(t('syncing'), { exact: false })).toBeTruthy()
  })

  it('collapses to the rail dot without the text', async () => {
    await mount({
      api: fakeSyncApi({ status: statusView({ configured: true, lastSyncAt: '2026-08-16T08:30:00.000Z' }) }),
      wide: false,
    })
    expect(screen.queryByText(t('statusNormal'), { exact: false })).toBeNull()
    expect(screen.getByRole('button').getAttribute('aria-label')).toBe(t('statusNormal'))
  })

  it('refreshes the status view on a timer', async () => {
    vi.useFakeTimers()
    try {
      const api = fakeSyncApi({ status: statusView({ configured: true }) })
      const controller = new SyncSectionController(api as unknown as SyncApi, new FakeConfigForm<SyncSettingsDraft>())
      const injected: SyncStatusFooterInjected = {
        controller,
        t,
        hooks: { snapshot: controller.store },
      }
      render(<SyncStatusFooter {...injected} useSnapshot={bindSnapshotSelector(controller.store)} wide={true} />)
      await act(async () => {})
      await controller.load()
      const loads = api.status.mock.calls.length

      await act(async () => {
        await vi.advanceTimersByTimeAsync(60_000)
      })
      expect(api.status.mock.calls.length).toBeGreaterThan(loads)
      expect(controller.store.getSnapshot().status).toBe('ready')
    } finally {
      vi.useRealTimers()
    }
  })
})
