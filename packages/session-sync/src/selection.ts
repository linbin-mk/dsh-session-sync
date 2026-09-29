/**
 * Selection tree projection: the Sync settings page's "selection" view —
 * workspaces → sessions, plus the pending list of repo workspaces whose name
 * no local workspace carries. Pure and total over data the caller has already
 * read, so the grouping rules stay testable without a worktree, a registry, or
 * session logs.
 *
 * Two sources feed one tree. The repo snapshot (`sync.json`) is authoritative
 * for a session's workspace key, workspace name, and provenance; a session
 * this machine selected but has not published yet has no entry there, so it is
 * grouped by the local workspace that holds it. When a locally added session's
 * workspace name matches exactly one repo group, it joins that group rather
 * than forking a second group with the same name.
 *
 * `matched` / `matches` are derived from the local workspace titles alone:
 * a repo group with no local carrier (0) or several (more than 1) cannot be
 * imported, which is what puts its sessions on the pending list. Matching is
 * by exactly-equal title — a renamed workspace simply does not match.
 *
 * @module @linbin-mk/dsh-session-sync/selection
 */

import type { SessionSyncRecord, SyncSelectionEntry } from './format.ts'
import type {
  SessionSyncPendingView, SessionSyncSelectionSessionView, SessionSyncSelectionView,
  SessionSyncSelectionWorkspaceView,
} from './api.ts'

/** Everything the tree projection reads. */
export interface SelectionTreeInput {
  /** The repo snapshot's entries (`sync.json`). */
  entries: readonly SyncSelectionEntry[]
  /** This machine's own selection ids. */
  localIds: readonly string[]
  /** Every local workspace title (duplicates allowed — they make a match ambiguous). */
  workspaceTitles: readonly string[]
  /** Sessions this machine actually holds. */
  heldIds: ReadonlySet<string>
  /** Titles read from the projection cache for the sessions this machine holds. */
  localTitles: ReadonlyMap<string, string>
  /** Local workspace title per locally selected session that has no repo entry yet. */
  localPlacement: ReadonlyMap<string, string>
  /** Every stored record for one session. */
  records: (id: string) => readonly SessionSyncRecord[]
}

/** Build one session row. */
function sessionRow(
  id: string,
  input: SelectionTreeInput,
  entry: SyncSelectionEntry | undefined,
): SessionSyncSelectionSessionView {
  const history = [...input.records(id)]
  const latest = history.length === 0 ? undefined : history[history.length - 1]
  const title = input.localTitles.get(id) ?? entry?.title ?? ''
  return {
    id,
    title,
    present: input.heldIds.has(id),
    ...entry === undefined ? {} : { addedAt: entry.addedAt, addedBy: entry.addedBy },
    ...latest === undefined ? {} : {
      lastSyncAt: latest.at,
      lastSyncHost: latest.host,
      lastSyncDirection: latest.direction,
      lastSyncEvents: latest.events,
    },
    conflicts: history.filter(record => record.result === 'conflict').length,
  }
}

/** Newest additions first; a locally added session (no `addedAt` yet) leads. */
function byNewest(left: SessionSyncSelectionSessionView, right: SessionSyncSelectionSessionView): number {
  const leftAt = left.addedAt ?? '9999'
  const rightAt = right.addedAt ?? '9999'
  if (leftAt === rightAt) return left.id < right.id ? -1 : left.id > right.id ? 1 : 0
  return leftAt < rightAt ? 1 : -1
}

/**
 * Project the selection tree.
 * @param input - the repo snapshot, the local selection, and the local facts.
 * @returns the view the settings page renders.
 */
export function buildSelectionView(input: SelectionTreeInput): SessionSyncSelectionView {
  const matchCounts = new Map<string, number>()
  for (const title of input.workspaceTitles) {
    matchCounts.set(title, (matchCounts.get(title) ?? 0) + 1)
  }

  const groups: SessionSyncSelectionWorkspaceView[] = []
  const byKey = new Map<string, SessionSyncSelectionWorkspaceView>()
  const keyByName = new Map<string, string | undefined>()
  for (const entry of input.entries) {
    let group = byKey.get(entry.key)
    if (group === undefined) {
      group = {
        key: entry.key,
        name: entry.workspaceName,
        matched: matchCounts.get(entry.workspaceName) === 1,
        matches: matchCounts.get(entry.workspaceName) ?? 0,
        sessions: [],
      }
      byKey.set(entry.key, group)
      groups.push(group)
    }
    // A name carried by several keys can only be joined by key, never by name.
    keyByName.set(entry.workspaceName, keyByName.has(entry.workspaceName) ? undefined : entry.key)
    group.sessions.push(sessionRow(String(entry.id), input, entry))
  }

  const locallyAdded = new Set(input.localIds.filter(id => !input.entries.some(entry => String(entry.id) === id)))
  for (const id of locallyAdded) {
    const name = input.localPlacement.get(id) ?? ''
    const targetKey = keyByName.get(name)
    let group = targetKey === undefined ? undefined : byKey.get(targetKey)
    if (group === undefined) {
      group = groups.find(candidate => candidate.key === undefined && candidate.name === name)
      if (group === undefined) {
        group = { name, matched: matchCounts.get(name) === 1, matches: matchCounts.get(name) ?? 0, sessions: [] }
        groups.push(group)
      }
    }
    group.sessions.push(sessionRow(id, input, undefined))
  }

  for (const group of groups) group.sessions.sort(byNewest)

  const pending: SessionSyncPendingView[] = groups
    .filter(group => group.key !== undefined && !group.matched)
    .map(group => ({
      key: group.key ?? '',
      name: group.name,
      sessionIds: group.sessions.map(session => session.id),
      matches: group.matches,
    }))

  return {
    workspaces: groups,
    pending,
    total: groups.reduce((count, group) => count + group.sessions.length, 0),
  }
}
