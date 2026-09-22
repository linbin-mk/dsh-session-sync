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
 * @module @linbin-mk/dsh-client-ui-settings-sync/client/api
 */

import type { SessionSyncSettingsView, SessionSyncStatusView, SyncLogEntry } from '@linbin-mk/dsh-session-sync'

/** The plugin's HTTP surface as the settings page consumes it. */
export interface SyncApi {
  /** The read-only sync status view. */
  status(): Promise<SessionSyncStatusView>
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

/** Decode one status view with safe fallbacks for every field. */
function decodeStatusView(value: unknown): SessionSyncStatusView {
  const view = (typeof value === 'object' && value !== null ? value : {}) as Record<string, unknown>
  const lastRunValue = (typeof view['lastRun'] === 'object' && view['lastRun'] !== null ? view['lastRun'] : {}) as Record<string, unknown>
  const lastCleanupValue = (typeof view['lastCleanup'] === 'object' && view['lastCleanup'] !== null ? view['lastCleanup'] : undefined) as Record<string, unknown> | undefined
  return {
    configured: view['configured'] === true,
    repoReady: view['repoReady'] === true,
    running: view['running'] === true,
    ...typeof view['lastSyncAt'] === 'string' ? { lastSyncAt: view['lastSyncAt'] } : {},
    ...typeof view['lastError'] === 'string' ? { lastError: view['lastError'] } : {},
    ...typeof view['lastErrorAt'] === 'string' ? { lastErrorAt: view['lastErrorAt'] } : {},
    lastRun: {
      imported: typeof lastRunValue['imported'] === 'number' ? lastRunValue['imported'] : 0,
      pushed: typeof lastRunValue['pushed'] === 'number' ? lastRunValue['pushed'] : 0,
      archived: typeof lastRunValue['archived'] === 'number' ? lastRunValue['archived'] : 0,
      deleted: typeof lastRunValue['deleted'] === 'number' ? lastRunValue['deleted'] : 0,
      conflicts: Array.isArray(lastRunValue['conflicts'])
        ? lastRunValue['conflicts'].filter((entry): entry is string => typeof entry === 'string')
        : [],
    },
    ...lastCleanupValue !== undefined && typeof lastCleanupValue['at'] === 'string'
      ? { lastCleanup: { at: lastCleanupValue['at'], dropped: typeof lastCleanupValue['dropped'] === 'number' ? lastCleanupValue['dropped'] : 0 } }
      : {},
    ...typeof view['cleanupError'] === 'string' ? { cleanupError: view['cleanupError'] } : {},
    ...typeof view['cleanupErrorAt'] === 'string' ? { cleanupErrorAt: view['cleanupErrorAt'] } : {},
  }
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
    return decodeStatusView(await requestJson('/session-sync/status'))
  }

  async syncNow(): Promise<SessionSyncStatusView> {
    return decodeStatusView(await requestJson('/session-sync/sync-now', { method: 'POST' }))
  }

  async cleanupNow(): Promise<SessionSyncStatusView> {
    return decodeStatusView(await requestJson('/session-sync/cleanup-now', { method: 'POST' }))
  }

  async logs(limit = 200): Promise<SyncLogEntry[]> {
    return decodeLogEntries(await requestJson(`/session-sync/logs?limit=${encodeURIComponent(String(limit))}`))
  }

  async getSettings(): Promise<SessionSyncSettingsView> {
    return decodeSettingsView(await requestJson('/session-sync/settings'))
  }

  async updateSettings(patch: object): Promise<void> {
    await requestJson('/session-sync/settings', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(patch),
    })
  }
}
