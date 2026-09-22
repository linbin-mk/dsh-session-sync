// @vitest-environment jsdom
/** Sync status footer: visibility gating, health dot, and the last-sync detail. */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, render, screen, waitFor } from '@testing-library/react'
import { bindSnapshotSelector, FakeConfigForm, makeTranslate } from './helpers.ts'
import { SyncStatusFooter } from '../src/client/SyncStatusFooter.tsx'
import type { SyncStatusFooterInjected, SyncStatusFooterProps } from '../src/client/SyncStatusFooter.tsx'
import { SyncSectionController } from '../src/client/controller.ts'
import type { SyncSettingsDraft } from '../src/client/controller.ts'
import type { SyncApi } from '../src/client/api.ts'

import { zh } from '../src/client/locales.ts'


afterEach(cleanup)

const t = makeTranslate(zh) as SyncStatusFooterInjected['t']

const baseStatus = {
  configured: false,
  repoReady: false,
  running: false,
  lastRun: { imported: 0, pushed: 0, archived: 0, conflicts: [] },
}

interface FakeApi {
  getSettings: ReturnType<typeof vi.fn>
  updateSettings: ReturnType<typeof vi.fn>
  status: ReturnType<typeof vi.fn>
  syncNow: ReturnType<typeof vi.fn>
  cleanupNow: ReturnType<typeof vi.fn>
  logs: ReturnType<typeof vi.fn>
}

function fakeApi(options: { configured?: boolean; running?: boolean; lastError?: string; lastSyncAt?: string } = {}): FakeApi {
  return {
    getSettings: vi.fn(() => Promise.resolve({
      writable: true,
      settings: { enabled: options.configured ?? false, remote: '', branch: 'main', intervalMinutes: 5, mappings: [] },
    })),
    updateSettings: vi.fn(() => Promise.resolve()),
    status: vi.fn(() => Promise.resolve({
      ...baseStatus,
      configured: options.configured ?? false,
      running: options.running ?? false,
      ...options.lastError === undefined ? {} : { lastError: options.lastError },
      ...options.lastSyncAt === undefined ? {} : { lastSyncAt: options.lastSyncAt },
    })),
    syncNow: vi.fn(() => Promise.resolve(baseStatus)),
    cleanupNow: vi.fn(() => Promise.resolve(baseStatus)),
    logs: vi.fn(() => Promise.resolve([])),
  }
}

async function mount(options: {
  api?: FakeApi
  wide?: boolean
} = {}) {
  const api = options.api ?? fakeApi()
  const controller = new SyncSectionController(api as SyncApi, new FakeConfigForm<SyncSettingsDraft>())
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
    const now = '2026-08-16T08:30:00.000Z'
    await mount({ api: fakeApi({ configured: true, lastSyncAt: now }) })
    expect(screen.getByText(t('statusNormal'), { exact: false })).toBeTruthy()
    expect(screen.getByText(new RegExp(t('lastSyncAt', { time: '' }).slice(0, 4)), { exact: false })).toBeTruthy()
  })

  it('shows the abnormal state and surfaces the failure on hover text', async () => {
    await mount({ api: fakeApi({ configured: true, lastError: 'git push failed', lastSyncAt: '2026-08-16T08:30:00.000Z' }) })
    expect(screen.getByText(t('statusAbnormal'), { exact: false })).toBeTruthy()
    expect(screen.getByRole('button').title).toContain('git push failed')
  })

  it('shows an unparsable last-sync instant verbatim', async () => {
    await mount({ api: fakeApi({ configured: true, lastSyncAt: 'garbage' }) })
    expect(screen.getByText(new RegExp('garbage'), { exact: false })).toBeTruthy()
  })

  it('shows the syncing state while a cycle runs', async () => {
    await mount({ api: fakeApi({ configured: true, running: true }) })
    expect(screen.getByText(t('syncing'), { exact: false })).toBeTruthy()
  })

  it('collapses to the rail dot without the text', async () => {
    await mount({ api: fakeApi({ configured: true, lastSyncAt: '2026-08-16T08:30:00.000Z' }), wide: false })
    expect(screen.queryByText(t('statusNormal'), { exact: false })).toBeNull()
    expect(screen.getByRole('button').getAttribute('aria-label')).toBe(t('statusNormal'))
  })

  it('refreshes the status view on a timer', async () => {
    vi.useFakeTimers()
    try {
      const api = fakeApi({ configured: true })
      const controller = new SyncSectionController(api as SyncApi, new FakeConfigForm<SyncSettingsDraft>())
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
