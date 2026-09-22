/**
 * Wire contract of the session-sync HTTP API: the status view, the settings
 * view, and the request/response shapes the plugin's own web routes serve.
 * The browser half (`@linbin-mk/dsh-client-ui-settings-sync`) imports these
 * types type-only; the runtime values travel as JSON over the routes
 * registered in {@link ./routes.ts}.
 * @module @linbin-mk/dsh-session-sync/api
 */

import type { SessionSyncSettings } from './settings.ts'
import type { SyncLogEntry } from './log.ts'

export type { SyncLogEntry, SyncLogKind } from './log.ts'

/** Read-only status view the settings page and the sidebar status dot render. */
export interface SessionSyncStatusView {
  /** Settings hold an enabled plugin with a remote. */
  configured: boolean
  /** The local git worktree exists. */
  repoReady: boolean
  /** A cycle is currently running. */
  running: boolean
  /** ISO-8601 instant the last cycle finished successfully, when one did. */
  lastSyncAt?: string
  /** Message of the last cycle-level failure, when one occurred. */
  lastError?: string
  /** ISO-8601 instant the last cycle-level failure occurred, when one did. */
  lastErrorAt?: string
  /** Outcome of the last completed cycle. */
  lastRun: { imported: number; pushed: number; archived: number; deleted: number; conflicts: string[] }
  /** Outcome of the last completed git-space cleanup pass, when one ran. */
  lastCleanup?: { at: string; dropped: number }
  /** Message of the last cleanup failure, when one occurred. */
  cleanupError?: string
  /** ISO-8601 instant the last cleanup failure occurred, when one did. */
  cleanupErrorAt?: string
}

/** Response of `GET /session-sync/settings`. */
export interface SessionSyncSettingsView {
  /** Whether the mounted settings provider accepts writes. */
  writable: boolean
  /** The resolved `session-sync` settings section. */
  settings: SessionSyncSettings
}

/** Response of `GET /session-sync/logs`. */
export interface SessionSyncLogsView {
  /** Cycle records within the retention window, newest first. */
  entries: SyncLogEntry[]
}

/** Response of a rejected settings write. */
export interface SessionSyncErrorView {
  /** Failure message (settings validation or provider error). */
  error: string
}

/** Whether a JSON-parsed body is a settings patch (a non-array object). */
export function isSettingsPatch(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
