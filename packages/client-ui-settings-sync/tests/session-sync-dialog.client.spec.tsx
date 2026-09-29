// @vitest-environment jsdom
/**
 * Sync-records dialog: it renders nothing until the row menu raises a request,
 * then shows that session's records newest first with the loading and retryable
 * error states, and drives 立即同步 / 关闭同步 / 关闭.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { FakeConfigForm, fakeSyncApi, makeTranslate, statusView } from './helpers.ts'
import { SessionSyncDialog } from '../src/client/SessionSyncDialog.tsx'
import type { SessionSyncDialogProps, SyncRecordsRequest } from '../src/client/SessionSyncDialog.tsx'
import { SyncSectionController } from '../src/client/controller.ts'
import type { SyncSettingsDraft } from '../src/client/controller.ts'
import type { SyncApi } from '../src/client/api.ts'
import { zh } from '../src/client/locales.ts'

afterEach(cleanup)

const t = makeTranslate(zh) as NonNullable<SessionSyncDialogProps['t']>

const settings: SyncSettingsDraft = {
  enabled: true,
  remote: 'git@example.com:team/repo.git',
  branch: 'main',
  intervalMinutes: 5,
  cleanup: { enabled: false, periodHours: 24, keepCommits: 200 },
}

/** Mount the dialog with one pending (or absent) request over a controller double. */
function mount(options: {
  request?: SyncRecordsRequest | null
  api?: ReturnType<typeof fakeSyncApi>
  settleRequest?: () => void
} = {}) {
  const request = options.request === undefined
    ? { sessionId: 's1', displayTitle: 'Demo session' }
    : options.request
  const api = options.api ?? fakeSyncApi({ settingsValue: settings, status: statusView({ configured: true }) })
  const controller = new SyncSectionController(api as unknown as SyncApi, new FakeConfigForm<SyncSettingsDraft>({ value: settings }))
  const settleRequest = options.settleRequest ?? vi.fn()
  const props: SessionSyncDialogProps = {
    controller,
    useRequest: ((selector: (value: SyncRecordsRequest | null) => unknown) => selector(request)) as never,
    settleRequest,
    t,
  }
  const view = render(<SessionSyncDialog {...props} />)
  return { view, api, controller, settleRequest }
}

describe('SessionSyncDialog', () => {
  it('renders nothing before the slot injects its dependencies', () => {
    render(<SessionSyncDialog />)
    expect(document.body.textContent).toBe('')
  })

  it('renders nothing while no request is pending', () => {
    mount({ request: null })
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(document.body.textContent).toBe('')
  })

  it('titles itself with the row title and reads that session\u2019s records', async () => {
    const { api } = mount()
    await waitFor(() => { expect(api.getRecords).toHaveBeenCalledWith('s1') })
    expect(screen.getByRole('dialog').getAttribute('aria-label')).toBe('Demo session')
  })

  it('falls back to the session id when the row carried no title', async () => {
    mount({ request: { sessionId: 's1', displayTitle: '' } })
    await waitFor(() => { expect(screen.getByRole('dialog').getAttribute('aria-label')).toBe('s1') })
  })

  it('lists the records newest first with machine, time, direction, events, and conflicts', async () => {
    const api = fakeSyncApi({
      settingsValue: settings,
      status: statusView({ configured: true }),
      records: [
        { host: 'machine-b', at: '2026-09-29T10:20:00.000Z', direction: 'pull', events: 12, result: 'ok' },
        { host: 'machine-a', at: '2026-09-29T09:00:00.000Z', direction: 'push', events: 3, result: 'conflict' },
      ],
    })
    mount({ api })
    await waitFor(() => { expect(screen.getByText('machine-b')).toBeTruthy() })

    expect(screen.getByText(t('recordEvents', { count: 12 }))).toBeTruthy()
    expect(screen.getByText(t('recordPull'))).toBeTruthy()
    expect(screen.getByText(t('recordPush'))).toBeTruthy()
    expect(screen.getByText(t('recordConflict'))).toBeTruthy()
    // Newest first: the pull from 10:20 leads the push from 09:00.
    const rows = screen.getAllByRole('listitem')
    expect(rows[0]!.textContent).toContain('machine-b')
    expect(rows[1]!.textContent).toContain('machine-a')
  })

  it('orders an out-of-order answer newest first itself', async () => {
    const api = fakeSyncApi({
      settingsValue: settings,
      records: [
        { host: 'older', at: '2026-09-29T08:00:00.000Z', direction: 'push', events: 1, result: 'ok' },
        { host: 'newer', at: '2026-09-29T11:00:00.000Z', direction: 'pull', events: 2, result: 'ok' },
      ],
    })
    mount({ api })
    await waitFor(() => { expect(screen.getByText('newer')).toBeTruthy() })
    expect(screen.getAllByRole('listitem')[0]!.textContent).toContain('newer')
  })

  it('shows the loading state before the records land and the empty state when there are none', async () => {
    let resolveRecords!: (records: never[]) => void
    const api = fakeSyncApi({ settingsValue: settings })
    api.getRecords = vi.fn(() => new Promise((resolve) => { resolveRecords = resolve }))
    mount({ api })
    expect(screen.getByText(t('dialogLoading'))).toBeTruthy()

    resolveRecords([])
    await waitFor(() => { expect(screen.getByText(t('dialogRecordsEmpty'))).toBeTruthy() })
  })

  it('shows a retryable error when the records read fails', async () => {
    const api = fakeSyncApi({ settingsValue: settings, recordsError: 'records down' })
    mount({ api })
    await waitFor(() => {
      expect(screen.getByText(t('dialogRecordsFailed', { message: 'records down' }))).toBeTruthy()
    })

    api.getRecords = vi.fn(() => Promise.resolve([
      { host: 'machine-c', at: '2026-09-29T12:00:00.000Z', direction: 'pull', events: 1, result: 'ok' },
    ]))
    fireEvent.click(screen.getByRole('button', { name: t('retry') }))
    await waitFor(() => { expect(screen.getByText('machine-c')).toBeTruthy() })
    expect(screen.queryByText(t('dialogRecordsFailed', { message: 'records down' }))).toBeNull()
  })

  it('runs a cycle on 立即同步 and re-reads the records it may have appended', async () => {
    const api = fakeSyncApi({ settingsValue: settings, status: statusView({ configured: true }) })
    mount({ api })
    await waitFor(() => { expect(api.getRecords).toHaveBeenCalledTimes(1) })

    fireEvent.click(screen.getByRole('button', { name: t('syncNow') }))
    await waitFor(() => { expect(api.syncNow).toHaveBeenCalledWith() })
    await waitFor(() => { expect(api.getRecords).toHaveBeenCalledTimes(2) })
  })

  it('surfaces a failed 立即同步 without closing the dialog', async () => {
    const api = fakeSyncApi({ settingsValue: settings, syncNowError: 'git push failed' })
    const { settleRequest } = mount({ api })

    fireEvent.click(screen.getByRole('button', { name: t('syncNow') }))
    await waitFor(() => {
      expect(screen.getByText(t('syncFailed', { message: 'git push failed' }))).toBeTruthy()
    })
    expect(settleRequest).not.toHaveBeenCalled()
    expect(screen.getByRole('dialog')).toBeTruthy()
  })

  it('closes sync on 关闭同步 and takes the request down', async () => {
    const api = fakeSyncApi({ settingsValue: settings, status: statusView({ configured: true }) })
    const { settleRequest } = mount({ api })

    fireEvent.click(screen.getByRole('button', { name: t('closeSync') }))
    await waitFor(() => { expect(api.closeSession).toHaveBeenCalledWith('s1') })
    await waitFor(() => { expect(settleRequest).toHaveBeenCalled() })
  })

  it('keeps the dialog open and says why when 关闭同步 is refused', async () => {
    const api = fakeSyncApi({ settingsValue: settings, sessionError: 'unknown session' })
    const { settleRequest } = mount({ api })

    fireEvent.click(screen.getByRole('button', { name: t('closeSync') }))
    await waitFor(() => {
      expect(screen.getByText(t('closeSyncFailed', { message: 'unknown session' }))).toBeTruthy()
    })
    expect(settleRequest).not.toHaveBeenCalled()
  })

  it('takes the request down on 关闭 and on the modal close button', async () => {
    const first = mount()
    // The footer's own 关闭 (the modal chrome's close button has no text).
    fireEvent.click(screen.getByText(t('close')).closest('button')!)
    expect(first.settleRequest).toHaveBeenCalledTimes(1)

    cleanup()
    const second = mount()
    // The modal's accessible close button, which the fake renders first.
    fireEvent.click(screen.getAllByRole('button', { name: t('close') })[0]!)
    expect(second.settleRequest).toHaveBeenCalledTimes(1)
  })
})
