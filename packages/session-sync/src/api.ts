/**
 * Wire contract of the session-sync HTTP API: the status view, the selection
 * tree, one session's sync records, the settings view, and the request and
 * response shapes the plugin's own web routes serve. The browser half
 * (this package's `./client` half) imports these types type-only;
 * the runtime values travel as JSON over the routes registered in
 * {@link ./routes.ts}.
 * @module @linbin-mk/dsh-session-sync/api
 */

import type { SessionSyncSettings } from './settings.ts'
import type { SyncLogEntry } from './log.ts'
import type { SessionSyncRecord } from './format.ts'

export type { SyncLogEntry, SyncLogKind } from './log.ts'
export type { SessionSyncRecord, SyncRecordDirection, SyncRecordResult } from './format.ts'

/** One repo workspace whose selected sessions this machine could not place. */
export interface SessionSyncPendingView {
  /** Stable repo key of the workspace. */
  key: string
  /** Workspace display name no local workspace matched. */
  name: string
  /** Selected session ids waiting under that workspace. */
  sessionIds: string[]
  /** Local workspaces carrying that title; 0 means none, more than 1 is ambiguous. */
  matches: number
}

/** One session row of the selection tree. */
export interface SessionSyncSelectionSessionView {
  /** Session id. */
  id: string
  /** Best-known title: the local log's when this machine holds it, else the repo snapshot's. */
  title: string
  /** Whether this machine holds the session (it can be opened) or only the repo does. */
  present: boolean
  /** ISO-8601 instant the session entered the selection, when the repo records one. */
  addedAt?: string
  /** Hostname that added it to the selection, when the repo records one. */
  addedBy?: string
  /** ISO-8601 instant of its latest recorded synchronization. */
  lastSyncAt?: string
  /** Hostname of that synchronization. */
  lastSyncHost?: string
  /** Direction of that synchronization. */
  lastSyncDirection?: 'push' | 'pull'
  /** Logical events that synchronization carried. */
  lastSyncEvents?: number
  /** Number of recorded conflict outcomes. */
  conflicts: number
}

/** One workspace group of the selection tree. */
export interface SessionSyncSelectionWorkspaceView {
  /** Repo key when the group comes from a repo manifest; absent for a selection this machine has not published yet. */
  key?: string
  /** Workspace display name — the join key every machine matches on. */
  name: string
  /** Whether a local workspace carries that name exactly once. */
  matched: boolean
  /** Local workspaces carrying that name (0 = none, more than 1 = ambiguous). */
  matches: number
  /** Sessions in this group, newest addition first. */
  sessions: SessionSyncSelectionSessionView[]
}

/** The selection tree the Sync settings page renders: workspaces → sessions. */
export interface SessionSyncSelectionView {
  /** Groups in repo-stored order, then groups that only exist locally. */
  workspaces: SessionSyncSelectionWorkspaceView[]
  /** Repo workspaces whose sessions wait for a same-named local workspace. */
  pending: SessionSyncPendingView[]
  /** Total selected sessions across every group. */
  total: number
}

/** Read-only status view the settings page and the sidebar status dot render. */
export interface SessionSyncStatusView {
  /** Settings hold an enabled plugin with a remote. */
  configured: boolean
  /** The local git worktree exists. */
  repoReady: boolean
  /** A cycle is currently running. */
  running: boolean
  /** Sessions this machine currently selects for synchronization. */
  syncedCount: number
  /** Repo workspaces whose selected sessions this machine could not place. */
  pending: SessionSyncPendingView[]
  /** ISO-8601 instant the last cycle finished successfully, when one did. */
  lastSyncAt?: string
  /** Message of the last cycle-level failure, when one occurred. */
  lastError?: string
  /** ISO-8601 instant the last cycle-level failure occurred, when one did. */
  lastErrorAt?: string
  /** Outcome of the last completed cycle. */
  lastRun: {
    imported: number
    pushed: number
    archived: number
    deleted: number
    /** Repo artifacts the cycle retired because the selection no longer covers them. */
    deletedUnselected: number
    /** Repo selection entries the cycle mirrored into this machine's selection. */
    adopted: number
    /** Local entries the cycle removed because the repo's selection dropped them. */
    dropped: number
    conflicts: string[]
  }
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

/** Response of `GET /session-sync/sessions/<id>/records`. */
export interface SessionSyncRecordsView {
  /** That session's synchronization records, newest first. */
  records: SessionSyncRecord[]
}

/** Response of a rejected settings write or session action. */
export interface SessionSyncErrorView {
  /** Failure message (settings validation, unknown session, provider error). */
  error: string
}

/** Whether a JSON-parsed body is a settings patch (a non-array object). */
export function isSettingsPatch(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
