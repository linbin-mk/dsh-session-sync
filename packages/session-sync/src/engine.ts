/**
 * Sync engine: the one-cycle orchestration over the persistence and workspace
 * services, the repo filesystem, and git. Every cycle follows the same order —
 * fetch and reset to the remote state, read the repo selection (`sync.json`),
 * mirror it into this machine's own selection, import the selected artifacts
 * for workspaces this machine can match, export this machine's selected
 * sessions, publish the selection, sweep what it retired, then commit and
 * push. Per-session failures are contained and reported; only git failures
 * reject the cycle.
 *
 * Selection policy: **a session synchronizes because the user selected it in
 * the session row's "..." menu.** The selection is the plugin's own state — no
 * harness pin set is read or written — and `sync.json` carries it across
 * machines as a whole snapshot. Both directions run through that one gate: a
 * session the snapshot lists is exported by the machine that holds it and
 * imported by every machine that can place it.
 *
 * Placement policy: **a repo workspace is matched to a local one by name.**
 * Each `workspaces/<key>/manifest.json` records a stable key and the
 * workspace's display name; a machine resolves that name against its own
 * workspace titles and stamps the matched workspace's directory into the
 * imported session header, which is the only way the harness will attach a
 * session to a workspace (it validates the stored header `cwd` against the
 * workspace path, and neither is rewritable afterwards). Exactly one match
 * imports; zero matches (including a rename on either side — renames are not
 * adapted to) and several matches both defer the workspace's sessions to the
 * pending list, where they wait for the user to create a matching local
 * workspace. Nothing is ever imported without a placement.
 *
 * Selection convergence: `sync.json` is a whole-set snapshot, not a grow-only
 * union like `archived.json`, because a union could never express closing
 * sync. Two rules make the snapshot convergent without any oscillation:
 *
 * - **A local edit publishes; otherwise this machine adopts.** Each machine
 *   keeps a sync anchor (the selection it actually applied last cycle plus the
 *   ids it owns, under the harness home). When the local selection differs
 *   from that anchor the user edited it here, so this machine publishes its own
 *   set; when the local set still equals the anchor the repo changed
 *   elsewhere, so this machine adopts the repo's set. The publish keeps every
 *   id the repo holds that this machine never tracked — another machine's
 *   selection for a workspace this one does not have must not fall to a local
 *   edit — while the ids it did own and just dropped are exactly what leaves
 *   the repo. The anchor records what was applied and only after the push: a
 *   selection the remote never accepted is not held state, so the next cycle
 *   republishes it instead of reading its absence as a local removal.
 * - **Before its first completed cycle a machine only adopts.** An empty local
 *   selection on a fresh machine is not a deliberate "close everything", so it
 *   publishes nothing and sweeps nothing: the repo's selection stays
 *   authoritative until this machine has actually seen it. A selection such a
 *   machine already holds is the exception — it is a real local edit made
 *   before the plugin ever ran, so it publishes.
 *
 * Conflict policy: session logs are append-only event streams, so two
 * machines that both extended one session can diverge. When one log is a
 * prefix of the other the longer log wins (the append-only contract makes
 * the shared prefix authoritative); a true divergence preserves the remote
 * tail as a conflict copy and continues — no data is silently dropped.
 * A divergent export never overwrites the repo artifact: alternating
 * overwrites would destroy the repo's one stable log each cycle, so the
 * repo keeps the artifact it already holds and the divergent local tail
 * travels only into the conflict copy.
 *
 * Open-turn policy: a log that ends mid-turn (no closing `turn/end`) is
 * either live on its owning machine right now, or crashed and awaiting the
 * harness's interrupted-turn repair the next time it is loaded. Neither is a
 * safe artifact to publish or to consume: an exported mid-turn snapshot is a
 * truncated copy that a remote machine imports, loads, and has the harness
 * REPAIR (synthetic `step/end` + `turn/end {interrupted}` closers) —
 * permanently diverging its local log from the real continuation the owning
 * machine keeps writing. Exports therefore skip mid-turn logs (the closed
 * log ships on a later cycle), and imports skip mid-turn artifacts (they
 * are stale snapshots from an older plugin; the owning machine replaces them
 * with its closed log).
 *
 * Archive policy: the harness archive set (sessions hidden from every
 * grouping surface) is machine-local and grow-only, so each workspace's
 * `archived.json` carries the union of every machine's archive marks.
 * Imports apply the repo's marks to locally held sessions; exports union
 * this machine's marks back. The grow-only contract on both sides makes the
 * union convergent — the repo file is a CRDT, never a merge conflict. An
 * archived session is retired from git: its artifact is deleted from the repo
 * (the local copy stays untouched). The archive list stays separate from
 * `sync.json` because it only decides what is hidden, while the selection
 * decides what is synchronized, and an id can be marked archived by a machine
 * that never selected it.
 *
 * Record policy: every real transfer appends one record to the session's
 * `records.json` — which machine, when, which direction, how many events, how
 * it ended — so the dialog the row menu opens can show a per-session history
 * that includes other machines' transfers. Records are merged by
 * `(host, at, direction)` and capped, so re-reading a file never duplicates
 * them and the file stays a convergent CRDT like the archive list.
 *
 * Projection policy: session list rows render projection values (title,
 * subagent grouping, …) from the harness projection cache, which folds only
 * on live events and cold reads — the import path triggers neither. Every
 * import (create and extend) therefore pre-warms the cache for that session.
 * Warm-up is fail-soft: a lost warm-up costs a fallback title, never data.
 * @module @linbin-mk/dsh-session-sync/engine
 */

import { createHash } from 'node:crypto'
import { realpath } from 'node:fs/promises'
import { SessionId, interruptedTurnClosers } from '@deepseek-ai/dsh-session'
import type { SessionEvent, SessionHeader } from '@deepseek-ai/dsh-session'
import {
  ARCHIVE_NAME, MANIFEST_NAME, SYNC_RECORD_LIMIT, WORKSPACES_DIR,
  archiveRepoPath, conflictRepoPath, manifestRepoPath, mergeRecords,
  parseArchiveList, parseManifest, parsePortableSession, parseRecords, parseSelection,
  recordsRepoPath, selectionRepoPath, serializeArchiveList, serializeManifest,
  serializePortableSession, serializeRecords, serializeSelection, sessionIdFromFilename,
  sessionRepoPath, workspaceRepoDir,
} from './format.ts'
import type {
  LocalSelection, PortableSession, SessionSyncRecord, SyncSelectionEntry, SyncState,
} from './format.ts'
import type { SessionSyncSettings } from './settings.ts'

/** Persistence service surface the engine drives. */
export interface SyncPersistence {
  /** Inspect one complete logical session, or `undefined` when absent. */
  inspect(id: SessionId): Promise<PortableSession | undefined>
  /** Create and durably materialize one complete logical session. */
  create(session: PortableSession): Promise<void>
  /** Durably append one contiguous event batch. */
  append(id: SessionId, events: readonly SessionEvent[]): Promise<void>
  /** List every materialized session header. */
  list(): Promise<SessionHeader[]>
}

/** Workspace entity surface the engine attaches imported sessions to. */
export interface SyncWorkspace {
  /** Stable local workspace id (the key-assignment table's join key). */
  readonly id: string
  /** Display title — the name a repo manifest is matched against. */
  readonly title: string
  /** Canonical directory path (stamped into an imported session's header). */
  readonly path: string
  /** Account one session in this workspace's durable order. */
  attachSession(id: SessionId): Promise<void>
}

/** Workspace registry surface the engine matches repo workspaces against. */
export interface SyncWorkspaceRegistry {
  /** Every locally registered workspace. */
  list(): SyncWorkspace[]
  /** Resolve an existing workspace by canonical path without creating one. */
  resolveByPath(path: string): Promise<SyncWorkspace | undefined>
  /** The registry-global archived-session ids (the hide-from-every-surface set). */
  archivedSessionIds(): readonly SessionId[]
  /** Durably archive one session (idempotent; rejects sessions the machine does not hold). */
  archiveSession(id: SessionId): Promise<void>
}

/**
 * Projection-cache surface the engine pre-warms. Session list rows render
 * projection values (title, subagent grouping, …) from the harness
 * projection cache — a cold session's row reads the cache table only, never
 * the log. Imported sessions bypass the live session store, so nothing
 * folds their projections and no cache row exists until the session is
 * opened (cold read) — the list would show the fallback title. Pre-warming
 * after import folds the stored log into the cache so list rows carry the
 * values immediately.
 */
export interface SyncProjectionCache {
  /** Fold one persisted session's projections from its stored log and write the cache back. */
  warm(id: SessionId): Promise<void>
}

/** Repo worktree and machine-local filesystem surface. Repo paths use `/` separators. */
export interface SyncFilesystem {
  /** Hostname of this machine (names conflict copies, records, and publications). */
  hostname: string
  /** Read a repo-relative file's text; `undefined` when absent. */
  readRepoFile(rel: string): Promise<string | undefined>
  /** Write a repo-relative file's text, creating parent directories. */
  writeRepoFile(rel: string, content: string): Promise<void>
  /** Delete a repo-relative file; resolves whether a file was actually removed. */
  deleteRepoFile(rel: string): Promise<boolean>
  /** Delete a repo-relative directory; resolves whether a directory was actually removed. */
  deleteRepoDir(rel: string): Promise<boolean>
  /** List directory names inside a repo-relative directory; empty when absent. */
  listDirs(rel: string): Promise<string[]>
  /** List file names inside a repo-relative directory; empty when absent. */
  listFiles(rel: string): Promise<string[]>
  /** Read this machine's sync anchor; `undefined` before its first cycle. */
  readState(): Promise<SyncState | undefined>
  /** Persist this machine's sync anchor (written after a successful push). */
  writeState(state: SyncState): Promise<void>
  /** Read this machine's selection mirror; `undefined` before the plugin ever ran. */
  readLocalSelection(): Promise<LocalSelection | undefined>
  /** Persist this machine's selection mirror (the user's own selection). */
  writeLocalSelection(selection: LocalSelection): Promise<void>
}

/** Git surface of one cycle: ensure → fetch → reset → add → commit → push. */
export interface SyncGit {
  /** Clone or initialize the worktree. */
  ensure(): Promise<void>
  /** Fetch the remote branch (empty remote is a no-op). */
  fetch(): Promise<void>
  /** Reset the worktree to the fetched remote state. */
  resetHard(): Promise<void>
  /** Stage every worktree change. */
  addAll(): Promise<void>
  /** Commit staged changes (nothing staged is a no-op). */
  commit(message: string): Promise<void>
  /** Push the branch, creating it upstream on the first push. */
  push(): Promise<void>
}

/** Everything one cycle needs. */
export interface SyncEngineDeps {
  /** Resolved plugin settings. */
  settings: SessionSyncSettings
  /** Session persistence service. */
  persistence: SyncPersistence
  /** Workspace registry; without it nothing can be placed or exported. */
  workspaces?: SyncWorkspaceRegistry
  /** Projection cache; imports warm it when present (fail-soft either way). */
  projectionCache?: SyncProjectionCache
  /** Repo worktree and machine-local filesystem. */
  fs: SyncFilesystem
  /** Git command surface. */
  git: SyncGit
  /** Warning sink for contained failures. */
  logger: { warn(message: string): void }
  /** Clock, for selection timestamps and records; defaults to the system clock. */
  now?: () => Date
}

/** One repo workspace whose sessions this machine could not place. */
export interface PendingWorkspace {
  /** Stable repo key of the workspace. */
  key: string
  /** Workspace display name no local workspace matched. */
  name: string
  /** Selected session ids waiting under that workspace. */
  sessionIds: string[]
  /** Local workspaces carrying that title; 0 means none, more than 1 is ambiguous. */
  matches: number
}

/** Outcome counters of one completed cycle. */
export interface SyncRunResult {
  /** Sessions imported (created or extended) this cycle. */
  imported: number
  /**
   * Sessions whose log gained foreign events this cycle — the machine-switch
   * boundary. The service arms a one-shot switch notice for each (subagent
   * sessions excluded): the first user chat after this import tells the model
   * that history came from another machine and the local working directory is
   * authoritative.
   */
  importedIds: string[]
  /** Sessions whose repo artifact was updated from local state. */
  pushed: number
  /** Sessions this machine newly marked archived from the repo's archive lists. */
  archived: number
  /** Archived sessions' repo artifacts deleted this cycle (git space reclaim). */
  deleted: number
  /** Repo artifacts deleted this cycle because the selection no longer covers them. */
  deletedUnselected: number
  /** Repo workspaces whose selected sessions this machine could not place. */
  pending: PendingWorkspace[]
  /** Repo entries this cycle mirrored into the local selection. */
  adopted: string[]
  /** Local entries this cycle removed from the local selection because the repo dropped them. */
  dropped: string[]
  /** Selection entries this cycle published to the repo (defined only when it published). */
  publishedSelection?: string[]
  /** Repo-relative conflict-copy paths written this cycle. */
  conflicts: string[]
  /** Contained per-session failure messages (never cycle-fatal). */
  errors: string[]
}

/** One cycle's selection decision: what this machine mirrors, publishes, and retires. */
export interface SelectionDecision {
  /** Whether this machine's own selection edits are published this cycle. */
  publish: boolean
  /** Whether this cycle retires artifacts from the repo. */
  canSweep: boolean
  /** The repo's selection (its whole entry list; empty when the repo has none). */
  selectedIds: string[]
  /** Session ids this machine mirrors into its local selection. */
  adoptedIds: string[]
  /** Session ids this machine drops from its local selection. */
  droppedIds: string[]
  /** Session ids the repo's selection holds after this cycle. */
  publishedIds: string[]
  /** Artifact session ids this cycle retires from git. */
  retiredIds: string[]
  /** Session ids this machine owns after this cycle (the next anchor's `ownedIds`). */
  ownedIds: string[]
}

/** What a cycle knows about the selection when it decides. */
export interface SelectionInput {
  /** This machine's current selection. */
  localIds: readonly string[]
  /** The repo's selected session ids, or `undefined` when the worktree carries none yet. */
  repoIds: readonly string[] | undefined
  /** This machine's anchor, or `undefined` before its first cycle. */
  anchor: SyncState | undefined
  /** Registry-global archived ids. */
  archivedIds: readonly string[]
  /** Archived ids the repo's archive lists mark. */
  repoArchivedIds: readonly string[]
}

/** Ids from `ids` that are absent from `known`, in their original order. */
function absentFrom(ids: readonly string[], known: ReadonlySet<string>): string[] {
  return ids.filter(id => !known.has(id))
}

/** Ids from `ids` that this machine's anchor says it may remove. */
function removableOf(ids: readonly string[], owned: ReadonlySet<string>): string[] {
  return ids.filter(id => owned.has(id))
}

/** Compare two id lists as sets. */
function sameIds(left: readonly string[], right: readonly string[]): boolean {
  const unique = new Set(right)
  if (unique.size !== new Set(left).size) return false
  return left.every(id => unique.has(id))
}

/**
 * Decide one cycle's selection work from the repo's snapshot, this machine's
 * selection, and the anchor they last agreed on. Pure and total: the cycle
 * feeds the decision to the mirror write and the repo writes, so the
 * convergence rules stay testable on their own.
 * @param input - the repo's ids, the local set, the anchor, and both archive sets.
 * @returns the selection this cycle mirrors, publishes, and retires.
 */
export function decideSelectionSync(input: SelectionInput): SelectionDecision {
  const repoIds = input.repoIds === undefined ? [] : [...input.repoIds]
  const repoSet = new Set(repoIds)
  const localIds = [...input.localIds]
  const localSet = new Set(localIds)
  const anchorIds = input.anchor?.syncedIds.map(String) ?? []
  const anchorKnown = input.anchor !== undefined
  const owned = new Set(input.anchor?.ownedIds.map(String) ?? [])
  const repoArchived = new Set(input.repoArchivedIds.map(String))
  const archived = new Set([...input.archivedIds.map(String), ...repoArchived])
  // Selections this machine added here; after the cycle it owns them and may
  // drop them again (that is what makes a later "close sync" a publishable
  // removal).
  const ownedNext = [...new Set([...owned, ...localIds])]

  if (!anchorKnown) {
    // This machine has never completed a cycle, so an empty local selection is
    // not a statement about the repo's selection: it adopts the repo's list
    // and retires nothing. A selection it already holds, though, is a real
    // local edit made before the plugin ran — publishing it selects that
    // session everywhere instead of leaving it out of the selection this very
    // cycle would adopt.
    const unselected = absentFrom(localIds, repoSet)
    const adoptedIds = absentFrom(repoIds, localSet)
    const published = [...repoIds, ...unselected].filter(id => !archived.has(id))
    return {
      publish: unselected.length > 0 && !sameIds(published, repoIds),
      canSweep: false,
      selectedIds: repoIds,
      adoptedIds,
      droppedIds: [],
      publishedIds: published,
      retiredIds: [],
      ownedIds: [...new Set([...ownedNext, ...repoIds])],
    }
  }

  const touchedLocally = !sameIds(localIds, anchorIds)
  // Mirroring only ever drops what the repo dropped: an id this machine still
  // selects stays until this machine is the one that drops it (then it
  // publishes instead), and an id it never owned is not its to drop.
  const droppedByRepo = removableOf(absentFrom(anchorIds, repoSet), owned)
  if (!touchedLocally) {
    // The local set still equals the anchor, so whatever moved, moved in the
    // repo: adopt it, and an id this machine cannot mirror stays in the repo's
    // selection for the machine that can.
    return {
      publish: false,
      canSweep: repoIds.length > 0,
      selectedIds: repoIds,
      adoptedIds: absentFrom(repoIds, localSet),
      // An archived id needs no local drop: the host keeps archival and the
      // selection exclusive, and the sweep owns its artifact.
      droppedIds: droppedByRepo.filter(id => localSet.has(id) && !archived.has(id)),
      publishedIds: repoIds,
      retiredIds: [],
      ownedIds: [...new Set([...ownedNext, ...repoIds])],
    }
  }

  // A local edit publishes: this machine's selections, plus the repo entries it
  // never held (another machine's, which a local edit must not remove), minus
  // anything archived. The entries it did hold and just dropped are exactly
  // what leaves the repo — recomputing them from the repo would undo the edit.
  const droppedLocally = removableOf(absentFrom(anchorIds, localSet), owned)
  const keptElsewhere = absentFrom(repoIds, new Set(anchorIds))
  const addedLocally = absentFrom(localIds, repoSet)
  const published = [...new Set([...localIds, ...keptElsewhere, ...addedLocally])]
    .filter(id => !archived.has(id))
  return {
    publish: true,
    canSweep: true,
    selectedIds: repoIds,
    adoptedIds: absentFrom(repoIds, localSet),
    droppedIds: [],
    publishedIds: published,
    // Retiring is exactly "this machine had it and dropped it": an id that
    // never entered the anchor was never this machine's to retire, and the
    // archive sweep owns the ids archived here.
    retiredIds: droppedLocally.filter(id => !archived.has(id)),
    ownedIds: ownedNext,
  }
}

/** Relation between two candidate logs of one session. */
export type LogRelation = 'equal' | 'local-prefix' | 'remote-prefix' | 'divergent'

/** Whether two decoded events carry identical content at one seq. */
function sameEvent(left: SessionEvent, right: SessionEvent): boolean {
  return JSON.stringify(left) === JSON.stringify(right)
}

/**
 * Compare two candidate logs of one session by the append-only contract.
 * @param local - this machine's decoded log.
 * @param remote - the repo artifact's decoded log.
 * @returns their relation.
 */
export function compareLogs(local: readonly SessionEvent[], remote: readonly SessionEvent[]): LogRelation {
  const shared = Math.min(local.length, remote.length)
  for (let index = 0; index < shared; index++) {
    const left = local[index]
    const right = remote[index]
    /* v8 ignore next -- the loop indexes below both lengths */
    if (left === undefined || right === undefined) break
    if (!sameEvent(left, right)) return 'divergent'
  }
  if (local.length === remote.length) return 'equal'
  return local.length > remote.length ? 'remote-prefix' : 'local-prefix'
}

/** Error message from any thrown value. */
function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** Whether two directory spellings canonicalize to the same directory. */
async function samePath(left: string, right: string): Promise<boolean> {
  try {
    return await realpath(left) === await realpath(right)
  } catch {
    // A path that does not exist on this machine can only match by spelling.
    return left === right
  }
}

/**
 * This machine's most recent session title, folded from its own log. The
 * harness stores titles as `session/title` events rather than header fields,
 * so a selection entry's display title is derived here (structurally, without
 * importing the title package). Subagent sessions and sessions that were never
 * titled simply carry no title.
 * @param events - the session's logical log.
 * @returns the latest title text, or an empty string when the log carries none.
 */
export function foldTitle(events: readonly SessionEvent[]): string {
  for (let index = events.length - 1; index >= 0; index--) {
    const event = events[index] as { type?: unknown; data?: unknown } | undefined
    if (event === undefined || event.type !== 'session/title') continue
    const data = event.data as { title?: unknown } | undefined
    if (data !== undefined && typeof data.title === 'string') return data.title
  }
  return ''
}

/**
 * Build the stable repo key of one local workspace. The key is minted once and
 * then remembered per workspace id, so renaming a workspace rewrites only its
 * manifest name and never moves its artifacts. A workspace this machine has
 * never exported either reuses the key the repo already publishes under its
 * current name (which is how two machines converge on one directory) or mints
 * a fresh, name-derived key.
 * @param input - local workspace id and title, remembered assignments, repo keys by name, the keys claimed by other workspaces this cycle, and every key the repo already holds.
 * @returns the key to use.
 */
export function assignWorkspaceKey(input: {
  workspaceId: string
  name: string
  remembered: ReadonlyMap<string, string>
  repoKeysByName: ReadonlyMap<string, string>
  claimed: ReadonlySet<string>
  existing: ReadonlySet<string>
}): string {
  const remembered = input.remembered.get(input.workspaceId)
  if (remembered !== undefined) return remembered
  // An existing repo directory carrying this name is the one to converge on —
  // `existing` holds it, so only a key another workspace claimed this cycle
  // disqualifies it.
  const published = input.repoKeysByName.get(input.name)
  if (published !== undefined && !input.claimed.has(published)) return published
  const base = `ws-${createHash('sha1').update(input.name).digest('hex').slice(0, 10)}`
  const free = (candidate: string): boolean => !input.claimed.has(candidate) && !input.existing.has(candidate)
  if (free(base)) return base
  for (let suffix = 2; ; suffix++) {
    const candidate = `${base}-${String(suffix)}`
    if (free(candidate)) return candidate
  }
}

/**
 * Attach one imported session to the workspace its name matched (fail-soft).
 * @param deps - services, settings, filesystem, and git surfaces.
 * @param workspace - the matched local workspace.
 * @param id - the imported session id.
 * @param result - the cycle outcome.
 */
async function attachSession(
  deps: SyncEngineDeps,
  workspace: SyncWorkspace,
  id: SessionId,
  result: SyncRunResult,
): Promise<void> {
  try {
    await workspace.attachSession(id)
  } catch (error) {
    result.errors.push(`attach ${String(id)} to "${workspace.path}" failed: ${messageOf(error)}`)
    deps.logger.warn(`session sync: attach "${id}" failed: ${messageOf(error)}`)
  }
}

/**
 * Pre-warm one session's projection cache from its stored log (fail-soft).
 * The cache row is display data, never part of import correctness: a failed
 * warm-up leaves the list row on its fallback title until the session is
 * opened (the cold read then writes the row back), so the failure is a
 * warning, not a reported error. Called after every actual import — create
 * AND extend — because a cache row that exists from an earlier log tail
 * cannot know about a title event the newly appended tail carries.
 * @param deps - services, settings, filesystem, and git surfaces.
 * @param id - the imported session id.
 */
async function warmSession(deps: SyncEngineDeps, id: SessionId): Promise<void> {
  if (deps.projectionCache === undefined) return
  try {
    await deps.projectionCache.warm(id)
  } catch (error) {
    deps.logger.warn(`session sync: projection warm-up for "${id}" failed: ${messageOf(error)}`)
  }
}

/**
 * Append one transfer record to a session's repo-side history (fail-soft).
 * Records are display data for the dialog the row menu opens; a failed write
 * must never fail the transfer it describes.
 * @param deps - services, settings, filesystem, and git surfaces.
 * @param key - workspace key owning the session.
 * @param id - the session id.
 * @param record - the transfer to record.
 * @param result - the cycle outcome.
 */
async function recordTransfer(
  deps: SyncEngineDeps,
  key: string,
  id: SessionId,
  record: SessionSyncRecord,
  result: SyncRunResult,
): Promise<void> {
  const path = recordsRepoPath(key, id)
  try {
    let existing: SessionSyncRecord[] = []
    const text = await deps.fs.readRepoFile(path)
    if (text !== undefined) {
      try {
        existing = parseRecords(text).records
      } catch (error) {
        result.errors.push(`${path}: repo records unparsable, replacing (${messageOf(error)})`)
        deps.logger.warn(`session sync: replacing unparsable records ${path}: ${messageOf(error)}`)
      }
    }
    const merged = mergeRecords(existing, [record])
    /* v8 ignore next -- mergeRecords always returns at least the new record */
    if (merged.length === 0) return
    await deps.fs.writeRepoFile(path, serializeRecords({ records: merged }))
  } catch (error) {
    result.errors.push(`${path}: ${messageOf(error)}`)
    deps.logger.warn(`session sync: recording ${record.direction} for ${key}/${String(id)} failed: ${messageOf(error)}`)
  }
}

/**
 * Arm a switch notice for one session this machine just imported. The notice
 * targets the user's own chat, so subagent sessions (whose turns carry no
 * real user message) are skipped.
 * @param result - the cycle outcome collecting imported ids.
 * @param portable - the imported artifact (its header carries the origin).
 * @param id - the imported session's id.
 */
function recordSwitchImport(result: SyncRunResult, portable: PortableSession, id: SessionId): void {
  if (portable.meta.origin === 'subagent') return
  result.importedIds.push(String(id))
}

/**
 * Import one repo artifact into this machine, applying the conflict policy.
 * The artifact's header `cwd` is stamped with the matched local workspace's
 * path, which is what lets the harness attach the session to it.
 * @param deps - services, settings, filesystem, and git surfaces.
 * @param key - repo key owning the artifact.
 * @param workspace - the local workspace its manifest name matched.
 * @param id - the artifact's session id.
 * @param result - the cycle outcome.
 * @param recordConflict - conflict-path collector.
 * @returns whether the artifact was actually imported (created or extended).
 */
async function importSession(
  deps: SyncEngineDeps,
  key: string,
  workspace: SyncWorkspace,
  id: SessionId,
  result: SyncRunResult,
  recordConflict: (path: string) => void,
): Promise<boolean> {
  const repoPath = sessionRepoPath(key, id)
  const remoteText = await deps.fs.readRepoFile(repoPath)
  if (remoteText === undefined) return false
  let portable
  try {
    portable = parsePortableSession(remoteText, workspace.path)
  } catch (error) {
    result.errors.push(`${key}/${String(id)}: ${messageOf(error)}`)
    deps.logger.warn(`session sync: skipping unparsable artifact ${key}/${String(id)}: ${messageOf(error)}`)
    return false
  }
  // Open-turn guard: an artifact ending mid-turn is a stale snapshot an older
  // plugin exported from a live session. Importing it would leave this
  // machine with a log the harness repairs on load (synthetic interrupted
  // closers), diverging it from the real continuation — the exact corruption
  // this policy prevents. Skip until the owning machine publishes its closed
  // log; meanwhile this machine's own closed log, when longer, still heals
  // the artifact on export.
  if (interruptedTurnClosers(portable.events).length > 0) {
    result.errors.push(`${key}/${String(id)}: artifact ends mid-turn; skipping until the owning machine publishes a closed log`)
    deps.logger.warn(`session sync: skipping mid-turn artifact ${key}/${String(id)}`)
    return false
  }
  const now = (deps.now?.() ?? new Date()).toISOString()
  const host = deps.fs.hostname
  const local = await deps.persistence.inspect(id)
  if (local === undefined) {
    await deps.persistence.create(portable)
    await attachSession(deps, workspace, id, result)
    await warmSession(deps, id)
    result.imported += 1
    recordSwitchImport(result, portable, id)
    await recordTransfer(deps, key, id, {
      host, at: now, direction: 'pull', events: portable.events.length, result: 'ok',
    }, result)
    return true
  }
  const localEvents = local.events
  const relation = compareLogs(localEvents, portable.events)
  if (relation === 'divergent') {
    const conflictPath = conflictRepoPath(key, id, deps.fs.hostname)
    await deps.fs.writeRepoFile(conflictPath, remoteText)
    recordConflict(conflictPath)
    deps.logger.warn(`session sync: divergent logs for ${key}/${String(id)} preserved at ${conflictPath}`)
    await recordTransfer(deps, key, id, {
      host, at: now, direction: 'pull', events: 0, result: 'conflict',
    }, result)
    return false
  }
  if (relation === 'local-prefix') {
    const appended = portable.events.slice(localEvents.length)
    await deps.persistence.append(id, appended)
    await attachSession(deps, workspace, id, result)
    await warmSession(deps, id)
    result.imported += 1
    recordSwitchImport(result, portable, id)
    await recordTransfer(deps, key, id, {
      host, at: now, direction: 'pull', events: appended.length, result: 'ok',
    }, result)
    return true
  }
  // equal or remote-prefix: local state already carries everything the repo has.
  return false
}

/** Session headers this machine holds under one directory. */
async function heldIdsAtPath(deps: SyncEngineDeps, path: string): Promise<Set<string>> {
  const held = new Set<string>()
  for (const header of await deps.persistence.list()) {
    if (header.cwd === undefined) continue
    if (!(await samePath(header.cwd, path))) continue
    held.add(String(header.id))
  }
  return held
}

/**
 * Apply one repo workspace's archive list to this machine: every id the repo
 * marks archived that this machine stores under the matched path joins the
 * registry-global archive set, hiding it from every grouping surface. The
 * harness archive set is grow-only, so applying a mark can never resurrect a
 * session another machine hid. Ids this machine does not hold are skipped —
 * the registry rejects archiving unknown sessions — and per-id failures are
 * contained exactly like attach failures.
 * @param deps - services, settings, filesystem, and git surfaces.
 * @param key - repo workspace key.
 * @param workspace - the matched local workspace.
 * @param result - the cycle outcome.
 */
async function applyArchivedSessions(
  deps: SyncEngineDeps,
  key: string,
  workspace: SyncWorkspace,
  result: SyncRunResult,
): Promise<void> {
  if (deps.workspaces === undefined) return
  const text = await deps.fs.readRepoFile(archiveRepoPath(key))
  if (text === undefined) return
  let archived
  try {
    archived = parseArchiveList(text)
  } catch (error) {
    result.errors.push(`${key}/${ARCHIVE_NAME}: ${messageOf(error)}`)
    deps.logger.warn(`session sync: skipping unparsable archive list ${key}: ${messageOf(error)}`)
    return
  }
  if (archived.length === 0) return
  const held = await heldIdsAtPath(deps, workspace.path)
  const already = new Set(deps.workspaces.archivedSessionIds().map(String))
  for (const id of archived) {
    const raw = String(id)
    if (!held.has(raw) || already.has(raw)) continue
    try {
      await deps.workspaces.archiveSession(id)
      result.archived += 1
    } catch (error) {
      result.errors.push(`archive ${raw} in "${workspace.path}" failed: ${messageOf(error)}`)
      deps.logger.warn(`session sync: archive "${raw}" failed: ${messageOf(error)}`)
    }
  }
}

/**
 * Union this machine's archived marks for one workspace into the repo archive
 * list. Membership is attributed two ways: the session is stored under the
 * matched path, or its repo artifact still sits under this key — an archived
 * session deleted locally keeps its repo file, so its mark must keep
 * travelling. Matching the harness archive set, the repo list only ever grows,
 * so a plain union is convergent and conflict-free; the file is written only
 * when this machine contributes something new.
 * @param deps - services, settings, filesystem, and git surfaces.
 * @param key - repo workspace key.
 * @param held - session ids this machine stores under the matched path.
 * @param result - the cycle outcome.
 */
async function exportArchivedSessions(
  deps: SyncEngineDeps,
  key: string,
  held: ReadonlySet<string>,
  result: SyncRunResult,
): Promise<void> {
  if (deps.workspaces === undefined) return
  const localArchived = new Set(deps.workspaces.archivedSessionIds().map(String))
  if (localArchived.size === 0) return
  const repoIds = new Set(
    (await deps.fs.listFiles(workspaceRepoDir(key)))
      .flatMap(filename => {
        const id = sessionIdFromFilename(filename)
        return id === undefined ? [] : [String(id)]
      }),
  )
  const additions = [...localArchived].filter(id => held.has(id) || repoIds.has(id))
  if (additions.length === 0) return

  const archivePath = archiveRepoPath(key)
  let remote: SessionId[] = []
  const remoteText = await deps.fs.readRepoFile(archivePath)
  if (remoteText !== undefined) {
    try {
      remote = parseArchiveList(remoteText)
    } catch (error) {
      result.errors.push(`${key}/${ARCHIVE_NAME}: repo archive list unparsable, overwriting (${messageOf(error)})`)
    }
  }
  const merged = new Set([...remote.map(String), ...additions])
  if (remoteText !== undefined && remote.length === merged.size && remote.every(id => merged.has(String(id)))) {
    return
  }
  await deps.fs.writeRepoFile(archivePath, serializeArchiveList([...merged].map(raw => SessionId(raw))))
}

/**
 * Delete one repo workspace's artifacts for sessions this machine archived,
 * together with their record files. The local session copy is never touched —
 * only the git worktree file goes away, reclaiming repo space on the next
 * push. Attribution is by file name alone: `listFiles` reports what sits under
 * this key, and every archived id found there is deleted. Missing files are a
 * no-op; per-file failures are contained like every other session-level
 * failure.
 * @param deps - services, settings, filesystem, and git surfaces.
 * @param key - repo workspace key.
 * @param result - the cycle outcome.
 */
async function deleteArchivedRepoFiles(
  deps: SyncEngineDeps,
  key: string,
  result: SyncRunResult,
): Promise<void> {
  if (deps.workspaces === undefined) return
  const archived = new Set(deps.workspaces.archivedSessionIds().map(String))
  if (archived.size === 0) return
  for (const filename of await deps.fs.listFiles(workspaceRepoDir(key))) {
    const id = sessionIdFromFilename(filename)
    if (id === undefined || !archived.has(String(id))) continue
    await removeArtifact(deps, key, id, result, 'deleted')
  }
}

/**
 * Delete one session's repo files: its artifact and its record history.
 * @param deps - services, settings, filesystem, and git surfaces.
 * @param key - repo workspace key.
 * @param id - the session id.
 * @param result - the cycle outcome.
 * @param counter - which counter a successful artifact delete increments.
 */
async function removeArtifact(
  deps: SyncEngineDeps,
  key: string,
  id: SessionId,
  result: SyncRunResult,
  counter: 'deleted' | 'deletedUnselected',
): Promise<void> {
  try {
    if (await deps.fs.deleteRepoFile(sessionRepoPath(key, id))) result[counter] += 1
    await deps.fs.deleteRepoFile(recordsRepoPath(key, id))
  } catch (error) {
    result.errors.push(`${key}/${String(id)}: ${messageOf(error)}`)
    deps.logger.warn(`session sync: delete ${key}/${String(id)} failed: ${messageOf(error)}`)
  }
}

/**
 * Export one local session into the repo under its workspace key. Only called
 * for sessions the selection covers and this machine holds: an unselected
 * session never publishes, which is what keeps it out of git.
 * @param deps - services, settings, filesystem, and git surfaces.
 * @param key - repo workspace key.
 * @param header - the local session header.
 * @param local - the local session's decoded log.
 * @param result - the cycle outcome.
 * @param recordConflict - conflict-path collector.
 * @returns whether the repo artifact was written this cycle.
 */
async function exportSession(
  deps: SyncEngineDeps,
  key: string,
  header: SessionHeader,
  local: PortableSession,
  result: SyncRunResult,
  recordConflict: (path: string) => void,
): Promise<boolean> {
  const localEvents = local.events
  const repoPath = sessionRepoPath(key, header.id)
  const remoteText = await deps.fs.readRepoFile(repoPath)
  const localText = serializePortableSession(local, key)
  if (remoteText === undefined) {
    await deps.fs.writeRepoFile(repoPath, localText)
    result.pushed += 1
    return true
  }
  let remoteEvents: SessionEvent[] | undefined
  try {
    remoteEvents = parsePortableSession(remoteText, key).events
  } catch (error) {
    result.errors.push(`${key}/${String(header.id)}: repo artifact unparsable, overwriting (${messageOf(error)})`)
    remoteEvents = undefined
  }
  if (remoteEvents === undefined) {
    await deps.fs.writeRepoFile(repoPath, localText)
    result.pushed += 1
    return true
  }
  const relation = compareLogs(localEvents, remoteEvents)
  switch (relation) {
    case 'equal':
    case 'local-prefix':
      // The repo already equals or extends local state; nothing to write.
      return false
    case 'remote-prefix':
      await deps.fs.writeRepoFile(repoPath, localText)
      result.pushed += 1
      return true
    case 'divergent': {
      // Never overwrite the repo artifact on divergence: alternating
      // overwrites would destroy the repo's one stable log every cycle, and
      // a divergent local that merely carries the harness's interrupted-turn
      // repair tail would keep replacing the real continuation. Preserve the
      // remote tail as this machine's conflict copy and leave the repo file
      // as it is; the local tail stays on this machine.
      const conflictPath = conflictRepoPath(key, header.id, deps.fs.hostname)
      await deps.fs.writeRepoFile(conflictPath, remoteText)
      recordConflict(conflictPath)
      return false
    }
  }
}

/**
 * Record this machine's selection edit in the repo. The decision is reported
 * whenever this machine published (that is the user-visible outcome), while
 * the file itself is written only when it would actually differ — a selection
 * that already matches, including an empty one, needs no commit.
 *
 * Entries this machine already saw keep their original key, workspace name,
 * title, and `addedAt`/`addedBy`: republishing must not restamp another
 * machine's addition. Entries this machine added take the metadata the export
 * pass resolved; an id that could not be described is dropped from the
 * publication with an error rather than published unplaceable.
 * @param deps - services, settings, filesystem, and git surfaces.
 * @param decision - this cycle's selection decision.
 * @param repoEntries - the repo's entries as read, when it had a selection.
 * @param described - workspace placement resolved per exported session.
 * @param result - the cycle outcome.
 * @param nowIso - this cycle's timestamp.
 */
async function publishSelection(
  deps: SyncEngineDeps,
  decision: SelectionDecision,
  repoEntries: readonly SyncSelectionEntry[] | undefined,
  described: ReadonlyMap<string, DescribedSession>,
  result: SyncRunResult,
  nowIso: string,
): Promise<void> {
  if (!decision.publish) return
  const known = new Map((repoEntries ?? []).map(entry => [String(entry.id), entry]))
  const entries: SyncSelectionEntry[] = []
  for (const raw of decision.publishedIds) {
    const existing = known.get(raw)
    if (existing !== undefined) {
      // Republishing another machine's entry must not restamp its provenance.
      entries.push(existing)
      continue
    }
    const placement = described.get(raw)
    if (placement === undefined) {
      result.errors.push(`selection: cannot publish ${raw} — this machine cannot describe its workspace`)
      continue
    }
    entries.push({
      id: SessionId(raw),
      key: placement.key,
      workspaceName: placement.name,
      title: placement.title,
      addedAt: nowIso,
      addedBy: deps.fs.hostname,
    })
  }
  result.publishedSelection = entries.map(entry => String(entry.id))
  const repoIds = repoEntries?.map(entry => String(entry.id))
  if (repoIds !== undefined && sameIds(result.publishedSelection, repoIds)) return
  await deps.fs.writeRepoFile(selectionRepoPath(), serializeSelection({
    host: deps.fs.hostname,
    updatedAt: nowIso,
    entries,
  }))
}

/** One exported session's resolved placement, used to publish its entry. */
interface DescribedSession {
  /** Repo workspace key holding its artifact. */
  key: string
  /** Local workspace title, matched by name on other machines. */
  name: string
  /** Latest local title, for rendering the selection tree without a local read. */
  title: string
  /** The local workspace the session was placed in this cycle. */
  workspace: SyncWorkspace
}

/**
 * Retire the artifacts the selection dropped: for every workspace directory,
 * delete the artifact of each session this machine stopped selecting, and
 * delete the now-empty workspace directory. The local sessions are untouched.
 * This runs after the export pass so a session that is still selected has
 * already been (re)written; a failed delete is contained.
 * @param deps - services, settings, filesystem, and git surfaces.
 * @param decision - this cycle's selection decision.
 * @param archived - every archived id (local and repo-marked).
 * @param result - the cycle outcome.
 */
async function sweepRetiredArtifacts(
  deps: SyncEngineDeps,
  decision: SelectionDecision,
  archived: ReadonlySet<string>,
  result: SyncRunResult,
): Promise<void> {
  const retired = new Set(decision.retiredIds)
  if (retired.size === 0) return
  for (const key of await deps.fs.listDirs(WORKSPACES_DIR)) {
    for (const filename of await deps.fs.listFiles(workspaceRepoDir(key))) {
      const id = sessionIdFromFilename(filename)
      if (id === undefined) continue
      const raw = String(id)
      if (!retired.has(raw) || archived.has(raw)) {
        // Archived ids are deleted by their own sweep, which owns that count.
        continue
      }
      await removeArtifact(deps, key, id, result, 'deletedUnselected')
    }
    // Decide emptiness from a fresh listing, not from the loop's snapshot: the
    // deletes above removed files that the snapshot still lists.
    const files = await deps.fs.listFiles(workspaceRepoDir(key))
    // A workspace that still carries archive marks keeps its directory: those
    // marks are grow-only shared state and must keep travelling even after the
    // last session left the selection.
    if (files.includes(ARCHIVE_NAME)) continue
    // Nothing but the manifest is left, and the manifest describes a workspace
    // with no artifacts; remove it so the directory can actually go. `rmdir`
    // refuses a non-empty directory, so leaving the manifest behind would make
    // the sweep a silent no-op.
    if (!files.every(name => name === MANIFEST_NAME)) continue
    try {
      await deps.fs.deleteRepoFile(manifestRepoPath(key))
      // The directory, not a file: `unlink` cannot remove one.
      await deps.fs.deleteRepoDir(workspaceRepoDir(key))
    } catch (error) {
      result.errors.push(`${workspaceRepoDir(key)}: ${messageOf(error)}`)
      deps.logger.warn(`session sync: remove empty workspace ${key} failed: ${messageOf(error)}`)
    }
  }
}

/**
 * Run one complete sync cycle and report what it changed. Git failures
 * reject the cycle (the caller records them on the status view); per-session
 * failures land in {@link SyncRunResult.errors} and never stop the rest.
 * @param deps - services, settings, filesystem, and git surfaces.
 * @returns the cycle's outcome counters.
 */
export async function runSyncCycle(deps: SyncEngineDeps): Promise<SyncRunResult> {
  const result: SyncRunResult = {
    imported: 0, importedIds: [], pushed: 0, archived: 0, deleted: 0, deletedUnselected: 0,
    pending: [], adopted: [], dropped: [], conflicts: [], errors: [],
  }
  const conflictPaths = new Set<string>()
  const recordConflict = (path: string): void => { conflictPaths.add(path) }
  const nowIso = (deps.now?.() ?? new Date()).toISOString()
  const host = deps.fs.hostname
  await deps.git.ensure()
  await deps.git.fetch()
  await deps.git.resetHard()

  // The repo selection is read before anything else, so this cycle's imports
  // and exports both gate on the same set. An unparsable snapshot is treated
  // as absent for gating but kept out of the publish decision — a machine that
  // cannot read the selection must not overwrite it.
  const selectionText = await deps.fs.readRepoFile(selectionRepoPath())
  let repoEntries: SyncSelectionEntry[] | undefined
  // An absent file and an unreadable one are NOT the same thing: absence is a
  // repository that has no selection yet (publishing one is how the first
  // machine creates it), while an unreadable file is a selection this machine
  // must neither converge on nor overwrite.
  let selectionReadable = selectionText === undefined
  if (selectionText !== undefined) {
    try {
      repoEntries = parseSelection(selectionText).entries
      selectionReadable = true
    } catch (error) {
      result.errors.push(`${selectionRepoPath()}: ${messageOf(error)}`)
      deps.logger.warn(`session sync: skipping unparsable selection: ${messageOf(error)}`)
    }
  }
  const repoIds = repoEntries === undefined ? undefined : repoEntries.map(entry => String(entry.id))
  // A v1 repository carries `pinned.json` and `projects/` instead of `sync.json`
  // and `workspaces/`. Say so once instead of silently syncing nothing: the
  // formats are deliberately not compatible.
  if (repoEntries === undefined && await deps.fs.readRepoFile('pinned.json') !== undefined) {
    result.errors.push('this repository holds a v1 layout (pinned.json/projects/) — v0.5 requires a new repository and does not migrate')
    deps.logger.warn('session sync: v1 repository layout detected; refusing to guess')
  }

  // Repo workspaces: every directory carrying a manifest, with the name that
  // decides where its sessions land on this machine.
  const repoWorkspaces: { key: string; name: string }[] = []
  const repoKeysByName = new Map<string, string>()
  for (const key of await deps.fs.listDirs(WORKSPACES_DIR)) {
    const text = await deps.fs.readRepoFile(manifestRepoPath(key))
    if (text === undefined) {
      // Every workspace directory this plugin writes carries a manifest; one
      // without it is foreign or truncated, and guessing a name would place its
      // sessions in an arbitrary local workspace.
      result.errors.push(`${workspaceRepoDir(key)}: no ${MANIFEST_NAME}; skipping this workspace`)
      deps.logger.warn(`session sync: workspace ${key} has no manifest; skipping`)
      continue
    }
    try {
      const manifest = parseManifest(text, key)
      repoWorkspaces.push({ key, name: manifest.name })
      if (!repoKeysByName.has(manifest.name)) repoKeysByName.set(manifest.name, key)
    } catch (error) {
      result.errors.push(`${manifestRepoPath(key)}: ${messageOf(error)}`)
      deps.logger.warn(`session sync: skipping unparsable manifest ${key}: ${messageOf(error)}`)
    }
  }

  // Local workspaces grouped by title: the matching table.
  const byName = new Map<string, SyncWorkspace[]>()
  for (const workspace of deps.workspaces?.list() ?? []) {
    const bucket = byName.get(workspace.title)
    if (bucket === undefined) byName.set(workspace.title, [workspace])
    else bucket.push(workspace)
  }

  const repoArchivedIds: string[] = []
  for (const { key } of repoWorkspaces) {
    const text = await deps.fs.readRepoFile(archiveRepoPath(key))
    if (text === undefined) continue
    try {
      for (const id of parseArchiveList(text)) repoArchivedIds.push(String(id))
    } catch (error) {
      result.errors.push(`${key}/${ARCHIVE_NAME}: ${messageOf(error)}`)
      deps.logger.warn(`session sync: skipping unparsable archive list ${key}: ${messageOf(error)}`)
    }
  }

  const state = await deps.fs.readState()
  const localSelection = await deps.fs.readLocalSelection()
  const localIds = (localSelection?.sessionIds ?? []).map(String)
  const decision = decideSelectionSync({
    localIds,
    repoIds,
    anchor: state,
    archivedIds: deps.workspaces === undefined ? [] : deps.workspaces.archivedSessionIds().map(String),
    repoArchivedIds,
  })

  const selected = new Set(repoIds ?? [])
  const repoArchived = new Set(repoArchivedIds)
  /** Sessions this cycle actually imported; they are never re-exported. */
  const importedIds = new Set<string>()
  /** Repo workspaces that matched a local workspace, with the held ids under it. */
  const matched = new Map<string, { workspace: SyncWorkspace; held: Set<string> }>()

  // Import: a selected artifact is admitted only through a workspace this
  // machine can place by name. A workspace with no match (or an ambiguous one)
  // contributes its waiting ids to the pending list instead — nothing is
  // imported into a guessed location, because the header cwd is not rewritable
  // after creation.
  for (const { key, name } of repoWorkspaces) {
    const candidates = byName.get(name) ?? []
    const workspace = candidates.length === 1 ? candidates[0] : undefined
    if (workspace === undefined) {
      const waiting: string[] = []
      for (const filename of await deps.fs.listFiles(workspaceRepoDir(key))) {
        const id = sessionIdFromFilename(filename)
        if (id === undefined) continue
        const raw = String(id)
        if (!selected.has(raw) || repoArchived.has(raw)) continue
        waiting.push(raw)
      }
      if (waiting.length > 0) {
        result.pending.push({ key, name, sessionIds: waiting.sort(), matches: candidates.length })
      }
      continue
    }
    const held = await heldIdsAtPath(deps, workspace.path)
    matched.set(key, { workspace, held })
    try {
      await applyArchivedSessions(deps, key, workspace, result)
    } catch (error) {
      result.errors.push(`${key}/${ARCHIVE_NAME}: ${messageOf(error)}`)
      deps.logger.warn(`session sync: archive apply for ${key} failed: ${messageOf(error)}`)
    }
    for (const filename of await deps.fs.listFiles(workspaceRepoDir(key))) {
      if (filename === ARCHIVE_NAME || filename === MANIFEST_NAME) continue
      const id = sessionIdFromFilename(filename)
      if (id === undefined) continue
      const raw = String(id)
      if (!selected.has(raw)) continue // not selected anywhere: stays out of this machine
      if (repoArchived.has(raw)) continue // archived: selection and archival are exclusive
      try {
        if (await importSession(deps, key, workspace, id, result, recordConflict)) importedIds.add(raw)
      } catch (error) {
        result.errors.push(`${key}/${raw}: ${messageOf(error)}`)
        deps.logger.warn(`session sync: import ${key}/${raw} failed: ${messageOf(error)}`)
      }
    }
  }

  // Mirror the selection into this machine's own selection before exporting:
  // an id the repo adopted is this machine's to keep and to close later. The
  // deltas are applied to the mirror as it stands NOW, not to the snapshot this
  // cycle read: the user can select or close a session from the row menu while
  // a cycle runs, and a whole-set write would silently discard that click.
  const current = (await deps.fs.readLocalSelection())?.sessionIds.map(String) ?? localIds
  const dropped = new Set(decision.droppedIds)
  const appliedIds = [...new Set([...current.filter(id => !dropped.has(id)), ...decision.adoptedIds])]
  result.adopted = [...decision.adoptedIds]
  result.dropped = [...decision.droppedIds]
  if (!sameIds(appliedIds, current)) {
    await deps.fs.writeLocalSelection({ sessionIds: appliedIds.map(raw => SessionId(raw)) })
  }

  // Export: this machine's selected sessions, placed by their own header cwd.
  // A session whose content this cycle just imported is skipped — its artifact
  // is already the source it came from, so re-writing it would only risk a
  // divergence.
  const exportIds = new Set([...appliedIds, ...selected])
  const headers = await deps.persistence.list()
  const headerById = new Map(headers.map(header => [String(header.id), header]))
  const archivedAll = new Set([
    ...(deps.workspaces === undefined ? [] : deps.workspaces.archivedSessionIds().map(String)),
    ...repoArchivedIds,
  ])
  const described = new Map<string, DescribedSession>()
  const remembered = new Map((state?.workspaceKeys ?? []).map(entry => [entry.workspaceId, entry.key]))
  const assignments = new Map(remembered)
  const existingKeys = new Set(repoWorkspaces.map(entry => entry.key))
  const claimedKeys = new Set<string>()
  const manifestNames = new Map(repoWorkspaces.map(entry => [entry.key, entry.name]))

  for (const raw of exportIds) {
    if (archivedAll.has(raw)) continue // an archived session leaves the repo
    if (importedIds.has(raw)) continue // just imported: the artifact is the source
    const header = headerById.get(raw)
    if (header === undefined) continue // not held here: nothing to export
    if (header.cwd === undefined) {
      result.errors.push(`export ${raw}: session header carries no cwd`)
      continue
    }
    const workspace = deps.workspaces === undefined
      ? undefined
      : await deps.workspaces.resolveByPath(header.cwd)
    if (workspace === undefined) {
      result.errors.push(`export ${raw}: session is not in any local workspace`)
      continue
    }
    const key = assignWorkspaceKey({
      workspaceId: workspace.id,
      name: workspace.title,
      // `assignments`, not the anchor's table: a workspace exported earlier in
      // THIS cycle must keep the key it was just given, or its second session
      // would mint a second directory for the same workspace.
      remembered: assignments,
      repoKeysByName,
      claimed: claimedKeys,
      existing: existingKeys,
    })
    assignments.set(workspace.id, key)
    claimedKeys.add(key)
    let local
    try {
      local = await deps.persistence.inspect(header.id)
    } catch (error) {
      result.errors.push(`export ${raw}: reading the local log failed (${messageOf(error)})`)
      continue
    }
    if (local === undefined) continue
    // Open-turn guard: a log ending mid-turn is either live on this machine
    // right now or crashed and awaiting the harness's interrupted-turn repair.
    // Publishing it would export a truncated snapshot that poisons the repo
    // and every importing machine. The closed log ships on a later cycle.
    if (interruptedTurnClosers(local.events).length > 0) continue
    described.set(raw, { key, name: workspace.title, title: foldTitle(local.events), workspace })

    const manifest = serializeManifest({ key, name: workspace.title, updatedAt: nowIso })
    if (manifestNames.get(key) !== workspace.title) {
      await deps.fs.writeRepoFile(manifestRepoPath(key), manifest)
      manifestNames.set(key, workspace.title)
    }
    const pushed = await exportSession(deps, key, header, local, result, recordConflict)
    if (pushed) {
      await recordTransfer(deps, key, header.id, {
        host, at: nowIso, direction: 'push', events: local.events.length, result: 'ok',
      }, result)
    }
  }

  // Archive exchange runs for every workspace this machine participates in: a
  // matched repo workspace (so marks it never selected still travel) and every
  // workspace it exported into (so a mark whose artifacts are gone still
  // reaches the repo).
  const participating = new Map<string, SyncWorkspace>()
  for (const [key, entry] of matched) participating.set(key, entry.workspace)
  for (const placement of described.values()) {
    if (!participating.has(placement.key)) participating.set(placement.key, placement.workspace)
  }
  for (const [key, workspace] of participating) {
    const held = matched.get(key)?.held ?? await heldIdsAtPath(deps, workspace.path)
    try {
      await exportArchivedSessions(deps, key, held, result)
    } catch (error) {
      result.errors.push(`${key}/${ARCHIVE_NAME}: ${messageOf(error)}`)
      deps.logger.warn(`session sync: archive export for ${key} failed: ${messageOf(error)}`)
    }
    try {
      await deleteArchivedRepoFiles(deps, key, result)
    } catch (error) {
      result.errors.push(`${key}/${ARCHIVE_NAME}: ${messageOf(error)}`)
      deps.logger.warn(`session sync: archive deletion for ${key} failed: ${messageOf(error)}`)
    }
  }

  // Publish this machine's selection edits, then retire what it dropped. An
  // unreadable repo snapshot blocks the publish (not the retirement): the
  // sweep only acts on ids this machine itself dropped, but writing a whole
  // snapshot would destroy a selection this machine failed to understand.
  if (selectionReadable) {
    await publishSelection(deps, decision, repoEntries, described, result, nowIso)
  } else if (decision.publish) {
    result.errors.push(`${selectionRepoPath()}: refusing to publish over an unreadable selection`)
    deps.logger.warn('session sync: refusing to publish over an unreadable selection')
  }
  if (decision.canSweep) {
    await sweepRetiredArtifacts(deps, decision, archivedAll, result)
  }

  await deps.git.addAll()
  await deps.git.commit('dsh session sync')
  await deps.git.push()

  // The anchor for the next cycle: the selection this machine actually holds
  // after mirroring the repo's, plus the ids it now owns (so a later close
  // reads as a local removal). Writing only after the push keeps a selection
  // the remote never accepted out of the anchor too, so the next cycle
  // republishes it instead of adopting the missing ids as repo-side removals.
  const applied = (await deps.fs.readLocalSelection())?.sessionIds.map(String) ?? appliedIds
  const workspaceKeys = [...assignments].map(([workspaceId, key]) => ({ workspaceId, key }))
  const stale = state === undefined
    || !sameIds(state.syncedIds.map(String), applied)
    || !sameIds(state.ownedIds.map(String), decision.ownedIds)
    || !sameAssignments(state.workspaceKeys, workspaceKeys)
  if (stale) {
    await deps.fs.writeState({
      firstSeen: true,
      syncedIds: applied.map(raw => SessionId(raw)),
      ownedIds: decision.ownedIds.map(raw => SessionId(raw)),
      workspaceKeys,
      updatedAt: nowIso,
      host,
    })
  }

  result.conflicts = [...conflictPaths]
  return result
}

/** Whether two workspace-key tables agree, ignoring order. */
function sameAssignments(
  left: readonly { workspaceId: string; key: string }[],
  right: readonly { workspaceId: string; key: string }[],
): boolean {
  if (left.length !== right.length) return false
  const table = new Map(right.map(entry => [entry.workspaceId, entry.key]))
  return left.every(entry => table.get(entry.workspaceId) === entry.key)
}

/** Re-export the repo layout vocabulary for consumers of the engine's results. */
export { ARCHIVE_NAME, MANIFEST_NAME, SYNC_RECORD_LIMIT, WORKSPACES_DIR } from './format.ts'
