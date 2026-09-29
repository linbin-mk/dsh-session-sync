// @vitest-environment node
/**
 * Browser wire client: the v2 route set (selection, per-session records, the
 * two session mutations) alongside the surviving status/actions/settings/log
 * routes, the verbs and paths each one uses, and the decoding fallbacks that
 * keep a malformed answer from corrupting the page.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { FetchSyncApi } from '../src/client/api.ts'

afterEach(() => { vi.unstubAllGlobals() })

/** One fetch answer with a JSON body. */
function ok(body: unknown): unknown {
  return { ok: true, status: 200, text: async () => JSON.stringify(body) }
}

/** One failing answer carrying the host's message, as the routes send it. */
function fail(status: number, message: string): unknown {
  return { ok: false, status, text: async () => JSON.stringify({ error: message }) }
}

/** Install one fetch double and hand it back. */
function stubFetch(answer: unknown): ReturnType<typeof vi.fn> {
  const fetchMock = vi.fn(async () => answer)
  vi.stubGlobal('fetch', fetchMock)
  return fetchMock
}

describe('FetchSyncApi routes', () => {
  const api = new FetchSyncApi()

  it('reads the status view', async () => {
    const fetchMock = stubFetch(ok({
      configured: true,
      repoReady: true,
      running: false,
      syncedCount: 2,
      pending: [{ key: 'ws-2', name: 'other', sessionIds: ['s9'], matches: 0 }],
      lastRun: { imported: 1, adopted: 2, dropped: 3, deletedUnselected: 4, conflicts: ['c'] },
    }))
    const view = await api.status()

    expect(fetchMock.mock.calls[0]![0]).toBe('/session-sync/status')
    expect(view.syncedCount).toBe(2)
    expect(view.pending).toEqual([{ key: 'ws-2', name: 'other', sessionIds: ['s9'], matches: 0 }])
    expect(view.lastRun).toEqual({
      imported: 1, pushed: 0, archived: 0, deleted: 0, deletedUnselected: 4,
      adopted: 2, dropped: 3, conflicts: ['c'],
    })
  })

  it('reads the selection tree', async () => {
    const fetchMock = stubFetch(ok({
      workspaces: [{
        key: 'ws-1',
        name: 'demo',
        matched: true,
        matches: 1,
        sessions: [{ id: 's1', title: 'Demo', present: true, addedAt: 'a', conflicts: 0 }],
      }],
      pending: [],
      total: 1,
    }))
    const view = await api.getSelection()
    expect(fetchMock.mock.calls[0]![0]).toBe('/session-sync/selection')
    expect(view.total).toBe(1)
    expect(view.workspaces[0]!.sessions[0]).toEqual({ id: 's1', title: 'Demo', present: true, addedAt: 'a', conflicts: 0 })
  })

  it('selects a session with POST and closes it with DELETE', async () => {
    const fetchMock = stubFetch(ok({ workspaces: [], pending: [], total: 0 }))
    await api.selectSession('s 1/2')
    await api.closeSession('s 1/2')

    expect(fetchMock.mock.calls[0]).toEqual(['/session-sync/sessions/s%201%2F2', { method: 'POST' }])
    expect(fetchMock.mock.calls[1]).toEqual(['/session-sync/sessions/s%201%2F2', { method: 'DELETE' }])
  })

  it('reads one session\u2019s records and decodes them', async () => {
    const fetchMock = stubFetch(ok({
      records: [
        { host: 'machine-b', at: '2026-09-29T10:20:00.000Z', direction: 'pull', events: 12, result: 'ok' },
        { host: 'machine-a', at: '2026-09-29T09:00:00.000Z', direction: 'push', events: 3, result: 'conflict' },
      ],
    }))
    const records = await api.getRecords('s1')

    expect(fetchMock.mock.calls[0]![0]).toBe('/session-sync/sessions/s1/records')
    expect(records).toEqual([
      { host: 'machine-b', at: '2026-09-29T10:20:00.000Z', direction: 'pull', events: 12, result: 'ok' },
      { host: 'machine-a', at: '2026-09-29T09:00:00.000Z', direction: 'push', events: 3, result: 'conflict' },
    ])
  })

  it('runs the manual actions with POST', async () => {
    const fetchMock = stubFetch(ok({ configured: true, repoReady: true, running: false, syncedCount: 0, pending: [], lastRun: {} }))
    await api.syncNow()
    await api.cleanupNow()

    expect(fetchMock.mock.calls[0]).toEqual(['/session-sync/sync-now', { method: 'POST' }])
    expect(fetchMock.mock.calls[1]).toEqual(['/session-sync/cleanup-now', { method: 'POST' }])
  })

  it('reads the cycle log with its limit and reads/writes the settings view', async () => {
    const fetchMock = stubFetch(ok({ entries: [], writable: true, settings: { enabled: true } }))
    await api.logs(25)
    await api.getSettings()
    await api.updateSettings({ enabled: false })

    expect(fetchMock.mock.calls[0]![0]).toBe('/session-sync/logs?limit=25')
    expect(fetchMock.mock.calls[1]![0]).toBe('/session-sync/settings')
    expect(fetchMock.mock.calls[2]).toEqual([
      '/session-sync/settings',
      { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ enabled: false }) },
    ])
  })

  it('keeps the host\u2019s message on a refused call', async () => {
    stubFetch(fail(400, 'unknown session'))
    await expect(api.closeSession('s1')).rejects.toThrow('unknown session')

    stubFetch(fail(403, 'cross-origin request refused'))
    await expect(api.selectSession('s1')).rejects.toThrow('cross-origin request refused')
  })

  it('answers a transport failure with the status code when no message rides along', async () => {
    stubFetch({ ok: false, status: 500, text: async () => '' })
    await expect(api.getSelection()).rejects.toThrow('request failed (500)')
  })

  it('refuses a malformed body instead of half-decoding it', async () => {
    stubFetch({ ok: true, status: 200, text: async () => 'not json' })
    await expect(api.getRecords('s1')).rejects.toThrow('session-sync: malformed response from /session-sync/sessions/s1/records')
  })
})

describe('FetchSyncApi decoding fallbacks', () => {
  const api = new FetchSyncApi()

  it('drops malformed selection rows and falls back to the counted total', async () => {
    stubFetch(ok({
      workspaces: [
        'garbage',
        { name: 'demo', sessions: ['garbage', { id: 7 }, { id: 's1' }] },
      ],
      pending: 'nope',
    }))
    const view = await api.getSelection()
    expect(view.workspaces).toEqual([{ name: 'demo', matched: false, matches: 0, sessions: [{ id: 's1', title: '', present: false, conflicts: 0 }] }])
    expect(view.pending).toEqual([])
    expect(view.total).toBe(1)
  })

  it('drops malformed records and labels an unclassified one conservatively', async () => {
    stubFetch(ok({
      records: [
        'garbage',
        { host: 'machine-a' },
        { host: 'machine-b', at: '2026-09-29T10:20:00.000Z', direction: 'sideways', result: 'weird' },
      ],
    }))
    expect(await api.getRecords('s1')).toEqual([
      { host: 'machine-b', at: '2026-09-29T10:20:00.000Z', direction: 'pull', events: 0, result: 'ok' },
    ])
  })

  it('defaults an absent status body to an unconfigured, empty view', async () => {
    // An empty body (204-style) is not malformed; it decodes to the zeroes.
    stubFetch({ ok: true, status: 200, text: async () => '' })
    const view = await api.status()
    expect(view).toMatchObject({ configured: false, repoReady: false, running: false, syncedCount: 0, pending: [] })
    expect(view.lastRun.adopted).toBe(0)
  })

  it('drops malformed log entries', async () => {
    stubFetch(ok({ entries: ['garbage', { time: 'now', kind: 'nope' }, { time: 'now', kind: 'start' }] }))
    expect(await api.logs()).toEqual([{ time: 'now', kind: 'start' }])
  })
})
