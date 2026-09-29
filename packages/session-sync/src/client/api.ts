/**
 * Browser wire client for the plugin's own HTTP API. Plain same-origin
 * `fetch` — the host registers these routes through the open `webServer`
 * service, so no harness RPC table entry is required. Responses are decoded
 * with light shape checks: the host owns validation, and a malformed
 * response surfaces as a load failure instead of corrupting the page state.
 *
 * The settings section itself rides the shared configuration form of the
 * `session-sync` Host entry (reads, pushed updates, revision-fenced writes).
 * This client still serves two settings cases the form does not: `getSettings`
 * for a page the Host keeps process-local (`mode: 'memory'`), which displays
 * the resolved section read-only, and `updateSettings` as the only path that
 * answers the Host's refusal message — the shared form reports a refusal as a
 * plain `false` and drops the reason.
 *
 * The selection tree, the per-session records, and the two session mutations
 * are the v2 additions: `sync.json`'s selection is what the row menu and the
 * settings page both read, and closing sync is the same route pair the host
 * engine uses.
 * @module @linbin-mk/dsh-session-sync/client/api
 */

import type {
  SessionSyncPendingView, SessionSyncRecord, SessionSyncSelectionSessionView, SessionSyncSelectionView,
  SessionSyncSelectionWorkspaceView, SessionSyncSettingsView, SessionSyncStatusView, SyncLogEntry,
} from '../api.ts'

/**
 * Route pathnames the host registers. The host package exports the same
 * paths as values (`STATUS_PATH`, `SELECTION_PATH`, …, see its `routes.ts`),
 * but this bundle is built behind the client-purity gate: a value import from
 * another plugin package is a build error, and the module table cannot answer
 * `@linbin-mk/*` requires at runtime. The literals are restated here instead;
 * the wire contract itself still comes from the host's exported types.
 */
const STATUS_PATH = '/session-sync/status'
const SELECTION_PATH = '/session-sync/selection'
const SESSIONS_PATH = '/session-sync/sessions'
const SYNC_NOW_PATH = '/session-sync/sync-now'
const CLEANUP_NOW_PATH = '/session-sync/cleanup-now'
const SETTINGS_PATH = '/session-sync/settings'
const LOGS_PATH = '/session-sync/logs'

/** The plugin's HTTP surface as the page, the row menu, and the dialog consume it. */
export interface SyncApi {
  /** The read-only sync status view. */
  status(): Promise<SessionSyncStatusView>
  /** The selection tree (workspaces → sessions) plus the pending workspaces. */
  getSelection(): Promise<SessionSyncSelectionView>
  /** Add one session to the shared selection; answers the fresh selection tree. */
  selectSession(id: string): Promise<SessionSyncSelectionView>
  /** Close sync for one session; answers the fresh selection tree. */
  closeSession(id: string): Promise<SessionSyncSelectionView>
  /** One session's synchronization records, newest first. */
  getRecords(id: string): Promise<SessionSyncRecord[]>
  /** Run one cycle now, answering the fresh status view. */
  syncNow(): Promise<SessionSyncStatusView>
  /** Run one git-space cleanup now, answering the fresh status view. */
  cleanupNow(): Promise<SessionSyncStatusView>
  /** Recent cycle-log records, newest first. */
  logs(limit?: number): Promise<SyncLogEntry[]>
  /** The settings view (writable flag + resolved section). */
  getSettings(): Promise<SessionSyncSettingsView>
  /** Merge one plain-object patch through the plugin's validated settings route. */
  updateSettings(patch: object): Promise<void>
}

/** Fetch one plugin endpoint and decode the JSON body; non-ok answers reject with the host's message. */
async function requestJson(path: string, init?: RequestInit): Promise<unknown> {
  const response = await fetch(path, init)
  const text = await response.text()
  let body: unknown
  try {
    body = text.length > 0 ? JSON.parse(text) : undefined
  } catch {
    throw new Error(`session-sync: malformed response from ${path}`)
  }
  if (!response.ok) {
    const message = typeof body === 'object' && body !== null
      && typeof (body as Record<string, unknown>)['error'] === 'string'
      ? (body as Record<string, unknown>)['error'] as string
      : `request failed (${response.status})`
    throw new Error(message)
  }
  return body
}

/** One route carrying a session id, with the id encoded into the path segment. */
function sessionPath(id: string): string {
  return `${SESSIONS_PATH}/${encodeURIComponent(id)}`
}

/** Decode the pending list shared by the status view and the selection view. */
function decodePendingViews(value: unknown): SessionSyncPendingView[] {
  if (!Array.isArray(value)) return []
  const pending: SessionSyncPendingView[] = []
  for (const item of value) {
    if (typeof item !== 'object' || item === null) continue
    const row = item as Record<string, unknown>
    if (typeof row['name'] !== 'string') continue
    pending.push({
      key: typeof row['key'] === 'string' ? row['key'] : '',
      name: row['name'],
      sessionIds: Array.isArray(row['sessionIds'])
        ? row['sessionIds'].filter((id): id is string => typeof id === 'string')
        : [],
      matches: typeof row['matches'] === 'number' ? row['matches'] : 0,
    })
  }
  return pending
}

/** Decode the last-run counters with safe fallbacks for every field. */
function decodeLastRun(value: unknown): SessionSyncStatusView['lastRun'] {
  const lastRun = (typeof value === 'object' && value !== null ? value : {}) as Record<string, unknown>
  const count = (field: string): number => typeof lastRun[field] === 'number' ? lastRun[field] as number : 0
  return {
    imported: count('imported'),
    pushed: count('pushed'),
    archived: count('archived'),
    deleted: count('deleted'),
    deletedUnselected: count('deletedUnselected'),
    adopted: count('adopted'),
    dropped: count('dropped'),
    conflicts: Array.isArray(lastRun['conflicts'])
      ? lastRun['conflicts'].filter((entry): entry is string => typeof entry === 'string')
      : [],
  }
}

/** Decode one status view with safe fallbacks for every field. */
function decodeStatusView(value: unknown): SessionSyncStatusView {
  const view = (typeof value === 'object' && value !== null ? value : {}) as Record<string, unknown>
  const lastCleanupValue = (typeof view['lastCleanup'] === 'object' && view['lastCleanup'] !== null ? view['lastCleanup'] : undefined) as Record<string, unknown> | undefined
  return {
    configured: view['configured'] === true,
    repoReady: view['repoReady'] === true,
    running: view['running'] === true,
    syncedCount: typeof view['syncedCount'] === 'number' ? view['syncedCount'] : 0,
    pending: decodePendingViews(view['pending']),
    ...typeof view['lastSyncAt'] === 'string' ? { lastSyncAt: view['lastSyncAt'] } : {},
    ...typeof view['lastError'] === 'string' ? { lastError: view['lastError'] } : {},
    ...typeof view['lastErrorAt'] === 'string' ? { lastErrorAt: view['lastErrorAt'] } : {},
    lastRun: decodeLastRun(view['lastRun']),
    ...lastCleanupValue !== undefined && typeof lastCleanupValue['at'] === 'string'
      ? { lastCleanup: { at: lastCleanupValue['at'], dropped: typeof lastCleanupValue['dropped'] === 'number' ? lastCleanupValue['dropped'] : 0 } }
      : {},
    ...typeof view['cleanupError'] === 'string' ? { cleanupError: view['cleanupError'] } : {},
    ...typeof view['cleanupErrorAt'] === 'string' ? { cleanupErrorAt: view['cleanupErrorAt'] } : {},
  }
}

/** Decode one session row; a row without an id drops out. */
function decodeSelectionSession(value: unknown): SessionSyncSelectionSessionView | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const row = value as Record<string, unknown>
  const id = row['id']
  if (typeof id !== 'string') return undefined
  const direction = row['lastSyncDirection']
  return {
    id,
    // The title is what a row renders; an empty one is the id (page-side).
    title: typeof row['title'] === 'string' ? row['title'] : '',
    present: row['present'] === true,
    ...typeof row['addedAt'] === 'string' ? { addedAt: row['addedAt'] } : {},
    ...typeof row['addedBy'] === 'string' ? { addedBy: row['addedBy'] } : {},
    ...typeof row['lastSyncAt'] === 'string' ? { lastSyncAt: row['lastSyncAt'] } : {},
    ...typeof row['lastSyncHost'] === 'string' ? { lastSyncHost: row['lastSyncHost'] } : {},
    ...direction === 'push' || direction === 'pull' ? { lastSyncDirection: direction } : {},
    ...typeof row['lastSyncEvents'] === 'number' ? { lastSyncEvents: row['lastSyncEvents'] } : {},
    conflicts: typeof row['conflicts'] === 'number' ? row['conflicts'] : 0,
  }
}

/** Decode the selection tree; malformed group and session rows drop out. */
function decodeSelectionView(value: unknown): SessionSyncSelectionView {
  const view = (typeof value === 'object' && value !== null ? value : {}) as Record<string, unknown>
  const rawGroups = Array.isArray(view['workspaces']) ? view['workspaces'] : []
  const workspaces: SessionSyncSelectionWorkspaceView[] = []
  for (const item of rawGroups) {
    if (typeof item !== 'object' || item === null) continue
    const group = item as Record<string, unknown>
    const sessions: SessionSyncSelectionSessionView[] = []
    for (const entry of Array.isArray(group['sessions']) ? group['sessions'] : []) {
      const session = decodeSelectionSession(entry)
      if (session !== undefined) sessions.push(session)
    }
    workspaces.push({
      ...typeof group['key'] === 'string' ? { key: group['key'] } : {},
      name: typeof group['name'] === 'string' ? group['name'] : '',
      matched: group['matched'] === true,
      matches: typeof group['matches'] === 'number' ? group['matches'] : 0,
      sessions,
    })
  }
  return {
    workspaces,
    pending: decodePendingViews(view['pending']),
    // A host answer always carries the total; the fallback keeps the page's
    // empty state honest if one ever omits it.
    total: typeof view['total'] === 'number'
      ? view['total']
      : workspaces.reduce((count, group) => count + group.sessions.length, 0),
  }
}

/** Decode one session's records; malformed entries drop out. */
function decodeRecords(value: unknown): SessionSyncRecord[] {
  const view = (typeof value === 'object' && value !== null ? value : {}) as Record<string, unknown>
  const raw = Array.isArray(view['records']) ? view['records'] : []
  const records: SessionSyncRecord[] = []
  for (const item of raw) {
    if (typeof item !== 'object' || item === null) continue
    const record = item as Record<string, unknown>
    const host = record['host']
    const at = record['at']
    if (typeof host !== 'string' || typeof at !== 'string') continue
    const direction = record['direction']
    records.push({
      host,
      at,
      // A record the decoder cannot classify still names its machine and
      // instant: 'pull'/'ok' are the least surprising labels for one.
      direction: direction === 'push' || direction === 'pull' ? direction : 'pull',
      events: typeof record['events'] === 'number' ? record['events'] : 0,
      result: record['result'] === 'conflict' ? 'conflict' : 'ok',
    })
  }
  return records
}

/** Decode one settings view; the section itself stays raw for the controller's draft decoder. */
function decodeSettingsView(value: unknown): SessionSyncSettingsView {
  const view = (typeof value === 'object' && value !== null ? value : {}) as Record<string, unknown>
  return {
    writable: view['writable'] === true,
    // The wire value is the host's resolved section; the controller re-decodes
    // it field by field, so this cast only names the type the host owns.
    settings: view['settings'] as SessionSyncSettingsView['settings'],
  }
}

/** Decode one log record with safe fallbacks; malformed entries drop out. */
function decodeLogEntries(value: unknown): SyncLogEntry[] {
  const view = (typeof value === 'object' && value !== null ? value : {}) as Record<string, unknown>
  const raw = Array.isArray(view['entries']) ? view['entries'] : []
  const entries: SyncLogEntry[] = []
  for (const item of raw) {
    if (typeof item !== 'object' || item === null) continue
    const record = item as Record<string, unknown>
    if (typeof record['time'] !== 'string') continue
    if (record['kind'] !== 'start' && record['kind'] !== 'success' && record['kind'] !== 'failure') continue
    entries.push({
      time: record['time'],
      kind: record['kind'],
      ...typeof record['durationMs'] === 'number' ? { durationMs: record['durationMs'] } : {},
      ...typeof record['imported'] === 'number' ? { imported: record['imported'] } : {},
      ...typeof record['pushed'] === 'number' ? { pushed: record['pushed'] } : {},
      ...typeof record['archived'] === 'number' ? { archived: record['archived'] } : {},
      ...typeof record['deleted'] === 'number' ? { deleted: record['deleted'] } : {},
      ...Array.isArray(record['conflicts'])
        ? { conflicts: record['conflicts'].filter((entry): entry is string => typeof entry === 'string') }
        : {},
      ...Array.isArray(record['errors'])
        ? { errors: record['errors'].filter((entry): entry is string => typeof entry === 'string') }
        : {},
      ...typeof record['error'] === 'string' ? { error: record['error'] } : {},
    })
  }
  return entries
}

/** The production client: same-origin fetch against the plugin's host routes. */
export class FetchSyncApi implements SyncApi {
  async status(): Promise<SessionSyncStatusView> {
    return decodeStatusView(await requestJson(STATUS_PATH))
  }

  async getSelection(): Promise<SessionSyncSelectionView> {
    return decodeSelectionView(await requestJson(SELECTION_PATH))
  }

  async selectSession(id: string): Promise<SessionSyncSelectionView> {
    return decodeSelectionView(await requestJson(sessionPath(id), { method: 'POST' }))
  }

  async closeSession(id: string): Promise<SessionSyncSelectionView> {
    return decodeSelectionView(await requestJson(sessionPath(id), { method: 'DELETE' }))
  }

  async getRecords(id: string): Promise<SessionSyncRecord[]> {
    // The route answers `{ records: [...] }` (see SessionSyncRecordsView).
    return decodeRecords(await requestJson(`${sessionPath(id)}/records`))
  }

  async syncNow(): Promise<SessionSyncStatusView> {
    return decodeStatusView(await requestJson(SYNC_NOW_PATH, { method: 'POST' }))
  }

  async cleanupNow(): Promise<SessionSyncStatusView> {
    return decodeStatusView(await requestJson(CLEANUP_NOW_PATH, { method: 'POST' }))
  }

  async logs(limit = 200): Promise<SyncLogEntry[]> {
    return decodeLogEntries(await requestJson(`${LOGS_PATH}?limit=${encodeURIComponent(String(limit))}`))
  }

  async getSettings(): Promise<SessionSyncSettingsView> {
    return decodeSettingsView(await requestJson(SETTINGS_PATH))
  }

  async updateSettings(patch: object): Promise<void> {
    await requestJson(SETTINGS_PATH, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(patch),
    })
  }
}
