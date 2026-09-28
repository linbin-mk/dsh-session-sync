/**
 * Sync engine: the one-cycle orchestration over the persistence and
 * workspace services, the repo filesystem, and git. Every cycle follows the
 * same order — fetch and reset to the remote state, read the repo pin list
 * (the synchronization selection) and mirror it locally, import the selected
 * artifacts for mapped projects, export this machine's pinned sessions for
 * mapped projects, publish the pin list, sweep the artifacts the selection
 * retired, then commit and push. Per-session failures are contained and
 * reported; only git failures reject the cycle.
 *
 * Selection policy: **a session synchronizes because it is pinned.** The
 * pinned set is the harness's registry-global pin set — machine-local state
 * (`workspaceRegistry.pinnedSessionIds`), surfaced in the sidebar, where the
 * user toggles it with the pin action. The repo's `pinned.json` carries that
 * set across machines, and each machine mirrors it into its own registry, so a
 * pin made anywhere selects the session everywhere. Imports and exports both
 * run through that one gate: a mapped project is the outer whitelist (nothing
 * from an unmapped project ever travels) and the pin set is the inner one
 * (an unpinned session of a mapped project stays home). Unpinning therefore
 * retires the session's artifact from git on the next cycle — the local copy
 * is never touched — and an archived session is retired the same way, since
 * archival and pinning are mutually exclusive on the host.
 *
 * Pin-list convergence: the file is a whole-set snapshot, not a grow-only
 * union like `archived.json`, because a union could never express a removal
 * (an unpin would be undone by the next machine's union). Two rules make the
 * snapshot convergent without any oscillation:
 *
 * - **A local edit publishes; otherwise this machine adopts.** Each machine
 *   keeps a pin baseline (the pin set it actually applied last cycle plus the
 *   pins it owns, under the harness home). When the local pin set differs from
 *   that baseline the user changed it here, so this machine publishes its own
 *   set; when the local set still equals the baseline the repo changed
 *   elsewhere, so this machine adopts the repo's set. The publish keeps every
 *   pin the repo holds that this machine never tracked — another machine's pin
 *   for a project this one does not have must not fall to a local edit — while
 *   the ids it did own and just dropped are exactly what leaves the repo. The
 *   baseline records what was applied and only after the push: a pin this
 *   machine could not mirror (no registry mounted yet, a refused pin) and a
 *   selection the remote never accepted are not held state, so the next cycle
 *   retries them instead of reading their absence as a local unpin.
 * - **Before its first completed cycle a machine only adopts.** An empty
 *   local pin set on a fresh machine is not a deliberate "unpin everything",
 *   so it publishes nothing and sweeps nothing: the repo's selection stays
 *   authoritative until this machine has actually seen it. A pin such a
 *   machine already holds is the exception — it is a real local edit made
 *   before the plugin ever ran, so it publishes (and the machine mirrors the
 *   repo's set as usual). The same guard covers every later cycle that cannot
 *   mirror the selection.
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
 * grouping surface) is machine-local and grow-only, so each mapped project's
 * `archived.json` carries the union of every machine's archive marks.
 * Imports apply the repo's marks to locally held sessions; exports union
 * this machine's marks back. The grow-only contract on both sides makes the
 * union convergent — the repo file is a CRDT, never a merge conflict.
 * An archived session is retired from git, like an unpinned one: its log
 * artifact is deleted from the repo (the local copy stays untouched), and its
 * id leaves the pin list. Why the two lists stay separate: `archived.json`
 * only decides what is hidden, while `pinned.json` decides what is
 * synchronized, and an id can be marked archived by a machine that never
 * selected it.
 *
 * Projection policy: session list rows render projection values (title,
 * subagent grouping, …) from the harness projection cache, which folds only
 * on live events and cold reads — the import path triggers neither. Every
 * import (create and extend) therefore pre-warms the cache for that session.
 * Warm-up is fail-soft: a lost warm-up costs a fallback title, never data.
 * @module @linbin-mk/dsh-session-sync/engine
 */

import { realpath } from 'node:fs/promises'
import { SessionId, interruptedTurnClosers } from '@deepseek-ai/dsh-session'
import type { SessionEvent, SessionHeader } from '@deepseek-ai/dsh-session'
import {
  ARCHIVE_NAME, CONFLICTS_DIR, MANIFEST_NAME, PROJECTS_DIR,
  archiveRepoPath, conflictRepoPath, parseArchiveList, parsePinList,
  parsePortableSession, pinRepoPath, serializeArchiveList, serializeManifest,
  serializePinList, sessionIdFromFilename, serializePortableSession, sessionRepoPath,
} from './format.ts'
import type { PinList, PortableSession } from './format.ts'
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
  /** Account one session in this workspace's durable order. */
  attachSession(id: SessionId): Promise<void>
}

/** Workspace registry surface resolving mapped paths to workspace entities. */
export interface SyncWorkspaceRegistry {
  /** Resolve an existing workspace by canonical path without creating one. */
  resolveByPath(path: string): Promise<SyncWorkspace | undefined>
  /** Create or reuse a workspace for an existing directory. */
  create(path: string, title?: string): Promise<SyncWorkspace>
  /** The registry-global archived-session ids (the hide-from-every-surface set). */
  archivedSessionIds(): readonly SessionId[]
  /** Durably archive one session (idempotent; rejects sessions the machine does not hold). */
  archiveSession(id: SessionId): Promise<void>
  /** The registry-global pin set in pin order (most recently pinned first) — the sync selection. */
  pinnedSessionIds(): readonly SessionId[]
  /** Pin one session (rejects a session this machine does not hold, or an archived one). */
  pinSession(id: SessionId): Promise<void>
  /** Unpin one session without changing its saved position. */
  unpinSession(id: SessionId): Promise<void>
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

/**
 * Machine-local pin baseline: the last synced pin state plus the pins this
 * machine may remove from the repo's selection. It lives under the harness
 * home next to the worktree — losing it is safe but costs one adopt cycle
 * (the machine then re-publishes what it sees instead of trusting its own
 * set).
 */
export interface SyncPinBaseline {
  /** Whether this machine has completed at least one cycle. */
  firstSeen: boolean
  /** Session ids of the last synced pin state. */
  sessionIds: string[]
  /**
   * Session ids this machine may drop from the selection: the pins it held or
   * published. An id the repo selects but this machine never owned — a project
   * it does not have, a session it never received — is absent here, so another
   * machine's pin cannot be treated as a local removal.
   */
  ownedIds: string[]
}

/** Repo worktree filesystem surface. Repo paths use `/` separators. */
export interface SyncFilesystem {
  /** Hostname of this machine (names conflict copies). */
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
  /** Read this machine's pin baseline; `undefined` before its first cycle. */
  readPinBaseline(): Promise<SyncPinBaseline | undefined>
  /**
   * Persist this machine's pin baseline. Called once per cycle that changed
   * the local pin state or the selection, so a machine always records what it
   * has actually applied — the anchor the next cycle diffs against.
   * @param snapshot - the baseline to store.
   */
  writePinBaseline(snapshot: SyncPinBaseline): Promise<void>
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
  /** Workspace registry; imports skip attach when absent. */
  workspaces?: SyncWorkspaceRegistry
  /** Projection cache; imports warm it when present (fail-soft either way). */
  projectionCache?: SyncProjectionCache
  /** Repo worktree filesystem. */
  fs: SyncFilesystem
  /** Git command surface. */
  git: SyncGit
  /** Warning sink for contained failures. */
  logger: { warn(message: string): void }
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
  deletedUnpinned: number
  /** Pin-set entries this cycle published to the repo (defined only when it published). */
  publishedPins?: string[]
  /** Sessions this machine pinned to mirror the repo's selection. */
  pinned: string[]
  /** Sessions this machine unpinned because the repo's selection dropped them. */
  unpinned: string[]
  /** Repo-relative conflict-copy paths written this cycle. */
  conflicts: string[]
  /** Contained per-session failure messages (never cycle-fatal). */
  errors: string[]
}

/** One cycle's pin decision: what this machine mirrors, publishes, and retires. */
export interface PinSelection {
  /** Whether this machine's own pin edits are published this cycle. */
  publish: boolean
  /** Whether this cycle retires artifacts from the repo. */
  canSweep: boolean
  /** The repo's selection (its whole pin list; empty when the repo has none). */
  selectedIds: string[]
  /** Session ids this machine mirrors into its local pin set. */
  pinnedIds: string[]
  /** Session ids this machine drops from its local pin set. */
  unpinnedIds: string[]
  /** Session ids the repo's pin list holds after this cycle. */
  publishedIds: string[]
  /** Artifact session ids this cycle retires from git. */
  sweepIds: string[]
  /** Session ids this machine owns after this cycle (the next baseline's `ownedIds`). */
  ownedIds: string[]
}

/** What a cycle knows about pins when it decides. */
export interface PinSyncInput {
  /** This machine's current pin set, in pin order. */
  localIds: readonly string[]
  /** The repo's pin list, or `undefined` when the worktree carries none yet. */
  repoIds: readonly string[] | undefined
  /** This machine's baseline, or `undefined` before its first cycle. */
  baseline: SyncPinBaseline | undefined
  /** Registry-global archived ids. */
  archivedIds: readonly string[]
  /** Archived ids the repo's archive lists mark. */
  repoArchivedIds: readonly string[]
}

/** Ids from `ids` that are absent from `known`, in their original order. */
function absentFrom(ids: readonly string[], known: ReadonlySet<string>): string[] {
  return ids.filter(id => !known.has(id))
}

/** Ids from `ids` that this machine's baseline says it may remove. */
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
 * Decide one cycle's pin work from the repo's pin list, this machine's pin
 * set, and the baseline they last agreed on. Pure and total: the cycle feeds
 * the decision to the registry calls and the repo writes, so the convergence
 * rules stay testable on their own.
 * @param input - the repo's list, the local set, the baseline, and both archive sets.
 * @returns the selection this cycle mirrors, publishes, and retires.
 */
export function decidePinSync(input: PinSyncInput): PinSelection {
  const repoIds = input.repoIds === undefined ? [] : [...input.repoIds]
  const repoSet = new Set(repoIds)
  const localIds = [...input.localIds]
  const localSet = new Set(localIds)
  const baselineIds = input.baseline?.sessionIds ?? []
  const baselineKnown = input.baseline !== undefined
  const owned = new Set(input.baseline?.ownedIds ?? [])
  const repoArchived = new Set(input.repoArchivedIds.map(String))
  const archived = new Set([...input.archivedIds.map(String), ...repoArchived])
  // Pins this machine added here; after the cycle it owns them and may drop
  // them again (that is what makes a later unpin a publishable removal).
  const ownedNext = [...new Set([...owned, ...localIds])]

  if (!baselineKnown) {
    // This machine has never completed a cycle, so an empty local pin set is
    // not a statement about the repo's selection: it adopts the repo's list
    // and retires nothing. A pin it already holds, though, is a real local
    // edit made before the plugin ran — publishing it selects that session
    // everywhere instead of leaving it out of the selection this very cycle
    // would adopt.
    const unselected = absentFrom(localIds, repoSet)
    const pinnedIds = absentFrom(repoIds, localSet)
    const published = [...repoIds, ...unselected].filter(id => !archived.has(id))
    return {
      publish: unselected.length > 0 && !sameIds(published, repoIds),
      canSweep: false,
      selectedIds: repoIds,
      pinnedIds,
      unpinnedIds: [],
      publishedIds: published,
      sweepIds: [],
      ownedIds: [...new Set([...ownedNext, ...repoIds])],
    }
  }

  const touchedLocally = !sameIds(localIds, baselineIds)
  // Mirroring only ever drops what the repo dropped: an id this machine still
  // pins stays until this machine is the one that unpins it (then it
  // publishes instead), and an id it never owned is not its to drop.
  const droppedByRepo = removableOf(absentFrom(baselineIds, repoSet), owned)
  if (!touchedLocally) {
    // The local set still equals the baseline, so whatever moved, moved in the
    // repo: adopt it, and an id this machine cannot mirror stays in the repo's
    // selection for the machine that can.
    return {
      publish: false,
      canSweep: repoIds.length > 0,
      selectedIds: repoIds,
      pinnedIds: absentFrom(repoIds, localSet),
      // An archived id needs no unpin: the host dropped its pin in the same
      // durable write that archived it, and refuses the operation now.
      unpinnedIds: droppedByRepo.filter(id => localSet.has(id) && !archived.has(id)),
      publishedIds: repoIds,
      sweepIds: [],
      ownedIds: [...new Set([...ownedNext, ...repoIds])],
    }
  }

  // A local edit publishes: this machine's pins, plus the repo pins it never
  // held (another machine's, which a local edit must not remove), minus
  // anything archived. The pins it did hold and just dropped are exactly what
  // leaves the repo — recomputing them from the repo would undo the unpin.
  const droppedLocally = removableOf(absentFrom(baselineIds, localSet), owned)
  const keptElsewhere = absentFrom(repoIds, new Set(baselineIds))
  const addedLocally = absentFrom(localIds, repoSet)
  const published = [...new Set([...localIds, ...keptElsewhere, ...addedLocally])]
    .filter(id => !archived.has(id))
  return {
    publish: true,
    canSweep: true,
    selectedIds: repoIds,
    pinnedIds: absentFrom(repoIds, localSet),
    unpinnedIds: [],
    publishedIds: published,
    // Retiring is exactly "this machine had it and dropped it": an id that
    // never entered the baseline was never this machine's to retire, and the
    // archive sweep owns the ids archived here.
    sweepIds: droppedLocally.filter(id => !archived.has(id)),
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
 * Compare two decoded logs. The shared prefix must match event-for-event —
 * the append-only contract makes any mismatch a true divergence, which is
 * preserved instead of resolved by dropping one side.
 * @param local - this machine's stored events.
 * @param remote - the repo artifact's decoded events.
 * @returns the relation between the two logs.
 */
export function compareLogs(
  local: readonly SessionEvent[],
  remote: readonly SessionEvent[],
): LogRelation {
  const common = Math.min(local.length, remote.length)
  for (let index = 0; index < common; index++) {
    const leftEvent = local[index]
    const rightEvent = remote[index]
    /* v8 ignore next -- index stays below both lengths by the Math.min bound */
    if (leftEvent === undefined || rightEvent === undefined) return 'divergent'
    if (!sameEvent(leftEvent, rightEvent)) return 'divergent'
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

/** Attach one imported session to the workspace owning its mapped path (fail-soft). */
async function attachSession(
  deps: SyncEngineDeps,
  path: string,
  id: SessionId,
  result: SyncRunResult,
): Promise<void> {
  if (deps.workspaces === undefined) return
  try {
    const workspace = await deps.workspaces.resolveByPath(path)
      ?? await deps.workspaces.create(path)
    await workspace.attachSession(id)
  } catch (error) {
    result.errors.push(`attach ${String(id)} to "${path}" failed: ${messageOf(error)}`)
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
 * @param deps - services, settings, filesystem, and git surfaces.
 * @param key - mapped project key owning the artifact.
 * @param path - this machine's directory for that key.
 * @param id - the artifact's session id.
 * @param result - the cycle outcome.
 * @param recordConflict - conflict-path collector.
 * @returns whether the artifact was actually imported (created or extended).
 */
async function importSession(
  deps: SyncEngineDeps,
  key: string,
  path: string,
  id: SessionId,
  result: SyncRunResult,
  recordConflict: (path: string) => void,
): Promise<boolean> {
  const repoPath = sessionRepoPath(key, id)
  const remoteText = await deps.fs.readRepoFile(repoPath)
  if (remoteText === undefined) return false
  let portable
  try {
    portable = parsePortableSession(remoteText, path)
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
  const local = await deps.persistence.inspect(id)
  if (local === undefined) {
    await deps.persistence.create(portable)
    await attachSession(deps, path, id, result)
    await warmSession(deps, id)
    result.imported += 1
    recordSwitchImport(result, portable, id)
    return true
  }
  const localEvents = local.events
  const relation = compareLogs(localEvents, portable.events)
  if (relation === 'divergent') {
    const conflictPath = conflictRepoPath(key, id, deps.fs.hostname)
    await deps.fs.writeRepoFile(conflictPath, remoteText)
    recordConflict(conflictPath)
    deps.logger.warn(`session sync: divergent logs for ${key}/${String(id)} preserved at ${conflictPath}`)
    return false
  }
  if (relation === 'local-prefix') {
    await deps.persistence.append(id, portable.events.slice(localEvents.length))
    await attachSession(deps, path, id, result)
    await warmSession(deps, id)
    result.imported += 1
    recordSwitchImport(result, portable, id)
    return true
  }
  // equal or remote-prefix: local state already carries everything the repo has.
  return false
}

/**
 * Mirror the repo's pin selection into this machine's registry (fail-soft per
 * id). A pin the machine cannot take — the session is not held yet, or the
 * host refuses it — is a warning, not a cycle failure: the import that
 * materializes the session in this same cycle runs first, and a session whose
 * artifact is missing on this machine simply takes its pin on a later cycle.
 * @param deps - services, settings, filesystem, and git surfaces.
 * @param selection - this cycle's pin decision.
 * @param result - the cycle outcome collecting the applied ids.
 */
async function syncLocalPins(
  deps: SyncEngineDeps,
  selection: PinSelection,
  result: SyncRunResult,
): Promise<void> {
  const registry = deps.workspaces
  if (registry === undefined) return
  for (const raw of selection.pinnedIds) {
    try {
      await registry.pinSession(SessionId(raw))
      result.pinned.push(raw)
    } catch (error) {
      deps.logger.warn(`session sync: pin "${raw}" failed: ${messageOf(error)}`)
    }
  }
  for (const raw of selection.unpinnedIds) {
    try {
      await registry.unpinSession(SessionId(raw))
      result.unpinned.push(raw)
    } catch (error) {
      deps.logger.warn(`session sync: unpin "${raw}" failed: ${messageOf(error)}`)
    }
  }
}

/** This machine's archived-session ids, or `undefined` without a registry. */
function localArchivedIds(deps: SyncEngineDeps): Set<string> | undefined {
  if (deps.workspaces === undefined) return undefined
  const ids = deps.workspaces.archivedSessionIds()
  return ids.length === 0 ? undefined : new Set(ids.map(String))
}

/**
 * Export one local session into the repo under its mapped project key. Only
 * called for sessions the selection covers: an unpinned session never
 * publishes, which is what keeps an unselected session out of git.
 */
async function exportSession(
  deps: SyncEngineDeps,
  key: string,
  header: SessionHeader,
  result: SyncRunResult,
  recordConflict: (path: string) => void,
): Promise<void> {
  const local = await deps.persistence.inspect(header.id)
  if (local === undefined) return
  const localEvents = local.events
  // Open-turn guard: a log ending mid-turn is either live on this machine
  // right now or crashed and awaiting the harness's interrupted-turn repair.
  // Publishing it would export a truncated snapshot that poisons the repo
  // and every importing machine. The closed log ships on a later cycle —
  // the running turn closes naturally, or the first local load commits the
  // repair closers and closes it.
  if (interruptedTurnClosers(localEvents).length > 0) return
  const repoPath = sessionRepoPath(key, header.id)
  const remoteText = await deps.fs.readRepoFile(repoPath)
  const localText = serializePortableSession(local, key)
  if (remoteText === undefined) {
    await deps.fs.writeRepoFile(repoPath, localText)
    result.pushed += 1
    return
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
    return
  }
  const relation = compareLogs(localEvents, remoteEvents)
  switch (relation) {
    case 'equal':
    case 'local-prefix':
      // The repo already equals or extends local state; nothing to write.
      return
    case 'remote-prefix':
      await deps.fs.writeRepoFile(repoPath, localText)
      result.pushed += 1
      return
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
      return
    }
  }
}

/** Session headers a mapping owns: stored cwd canonicalizes to the mapped path. */
async function ownedHeaders(
  deps: SyncEngineDeps,
  path: string,
): Promise<SessionHeader[]> {
  const owned: SessionHeader[] = []
  for (const header of await deps.persistence.list()) {
    if (header.cwd === undefined) continue
    if (!(await samePath(header.cwd, path))) continue
    owned.push(header)
  }
  return owned
}

/**
 * Apply one mapped project's repo archive list to this machine: every id the
 * repo marks archived that this machine stores under the mapped path joins
 * the registry-global archive set, hiding it from every grouping surface.
 * The harness archive set is grow-only (no unarchive path), so applying a
 * mark can never resurrect a session another machine hid. Ids this machine
 * does not hold are skipped — the registry rejects archiving unknown
 * sessions — and per-id failures are contained exactly like attach failures.
 */
async function applyArchivedSessions(
  deps: SyncEngineDeps,
  key: string,
  path: string,
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
  const owned = new Set((await ownedHeaders(deps, path)).map(header => String(header.id)))
  const already = new Set(deps.workspaces.archivedSessionIds().map(String))
  for (const id of archived) {
    const raw = String(id)
    if (!owned.has(raw) || already.has(raw)) continue
    try {
      await deps.workspaces.archiveSession(id)
      result.archived += 1
    } catch (error) {
      result.errors.push(`archive ${raw} in "${path}" failed: ${messageOf(error)}`)
      deps.logger.warn(`session sync: archive "${raw}" failed: ${messageOf(error)}`)
    }
  }
}

/**
 * Union this machine's archived marks for one mapped project into the repo
 * archive list. Membership is attributed two ways: the session is stored
 * under the mapped path (`headers`), or its repo artifact still sits under
 * this key — an archived session deleted locally keeps its repo file, so its
 * mark must keep travelling. Matching the harness archive set, the repo list
 * only ever grows, so a plain union is convergent and conflict-free; the file
 * is written only when this machine contributes something new.
 */
async function exportArchivedSessions(
  deps: SyncEngineDeps,
  key: string,
  headers: readonly SessionHeader[],
  result: SyncRunResult,
): Promise<void> {
  if (deps.workspaces === undefined) return
  const localArchived = new Set(deps.workspaces.archivedSessionIds().map(String))
  if (localArchived.size === 0) return
  const owned = new Set(headers.map(header => String(header.id)))
  const repoIds = new Set(
    (await deps.fs.listFiles(`${PROJECTS_DIR}/${key}`))
      .flatMap(filename => {
        const id = sessionIdFromFilename(filename)
        return id === undefined ? [] : [String(id)]
      }),
  )
  const additions = [...localArchived].filter(id => owned.has(id) || repoIds.has(id))
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
 * Delete one mapped project's repo artifacts for sessions this machine
 * archived. The local session copy is never touched — only the git worktree
 * file goes away, reclaiming repo space on the next push. Attribution is by
 * file name alone: `listFiles` reports what sits under this key, and every
 * archived id found there is deleted, so both held archived sessions and
 * archived sessions deleted locally are purged. Missing files are a no-op;
 * per-file failures are contained like every other session-level failure.
 */
async function deleteArchivedRepoFiles(
  deps: SyncEngineDeps,
  key: string,
  result: SyncRunResult,
): Promise<void> {
  const archived = localArchivedIds(deps)
  if (archived === undefined) return
  for (const filename of await deps.fs.listFiles(`${PROJECTS_DIR}/${key}`)) {
    const id = sessionIdFromFilename(filename)
    if (id === undefined || !archived.has(String(id))) continue
    try {
      if (await deps.fs.deleteRepoFile(`${PROJECTS_DIR}/${key}/${filename}`)) {
        result.deleted += 1
      }
    } catch (error) {
      result.errors.push(`${key}/${filename}: ${messageOf(error)}`)
      deps.logger.warn(`session sync: delete ${key}/${filename} failed: ${messageOf(error)}`)
    }
  }
}

/**
 * Record this machine's pin edit in the repo. The decision is reported
 * whenever this machine published (that is the user-visible outcome), while
 * the file itself is written only when it would actually differ — a
 * selection that already matches, including an empty one, needs no commit.
 */
async function publishPins(
  deps: SyncEngineDeps,
  selection: PinSelection,
  repoIds: readonly string[] | undefined,
  result: SyncRunResult,
): Promise<void> {
  if (!selection.publish) return
  result.publishedPins = [...selection.publishedIds]
  if (repoIds !== undefined && sameIds(selection.publishedIds, repoIds)) return
  const pinned: PinList = {
    sessionIds: selection.publishedIds.map(raw => SessionId(raw)),
    host: deps.fs.hostname,
    updatedAt: new Date().toISOString(),
  }
  await deps.fs.writeRepoFile(pinRepoPath(), serializePinList(pinned))
}

/**
 * Retire the artifacts the selection dropped: for every project directory,
 * delete the artifact of each session this machine stopped selecting, and
 * delete the now-empty project directory so a project that only ever held
 * unpinned sessions stops appearing in the repo. The local sessions are
 * untouched. This runs after the export pass so a session that is still
 * selected has already been (re)written; a failed delete is contained.
 */
async function sweepRetiredArtifacts(
  deps: SyncEngineDeps,
  selection: PinSelection,
  archived: ReadonlySet<string>,
  result: SyncRunResult,
): Promise<void> {
  const retired = new Set(selection.sweepIds)
  if (retired.size === 0) return
  for (const key of await deps.fs.listDirs(PROJECTS_DIR)) {
    let remaining = 0
    for (const filename of await deps.fs.listFiles(`${PROJECTS_DIR}/${key}`)) {
      if (filename === ARCHIVE_NAME) {
        remaining += 1
        continue
      }
      const id = sessionIdFromFilename(filename)
      if (id === undefined) {
        remaining += 1
        continue
      }
      const raw = String(id)
      if (!retired.has(raw) || archived.has(raw)) {
        // Archived ids are deleted by their own sweep, which owns that count.
        remaining += 1
        continue
      }
      try {
        if (await deps.fs.deleteRepoFile(`${PROJECTS_DIR}/${key}/${filename}`)) {
          result.deletedUnpinned += 1
        }
      } catch (error) {
        remaining += 1
        result.errors.push(`${key}/${filename}: ${messageOf(error)}`)
        deps.logger.warn(`session sync: retire ${key}/${filename} failed: ${messageOf(error)}`)
      }
    }
    if (remaining === 0) {
      try {
        // The directory, not a file: `unlink` cannot remove one.
        await deps.fs.deleteRepoDir(`${PROJECTS_DIR}/${key}`)
      } catch (error) {
        result.errors.push(`${PROJECTS_DIR}/${key}: ${messageOf(error)}`)
        deps.logger.warn(`session sync: remove empty project ${key} failed: ${messageOf(error)}`)
      }
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
    imported: 0, importedIds: [], pushed: 0, archived: 0, deleted: 0, deletedUnpinned: 0,
    pinned: [], unpinned: [], conflicts: [], errors: [],
  }
  const conflictPaths = new Set<string>()
  const recordConflict = (path: string): void => { conflictPaths.add(path) }
  await deps.git.ensure()
  await deps.git.fetch()
  await deps.git.resetHard()

  const byKey = new Map(deps.settings.mappings.map(mapping => [mapping.key, mapping.path]))

  // The repo pin list is the selection: read it before anything else, so this
  // cycle's imports and exports both gate on the same set. An unparsable list
  // is treated as absent for gating but kept out of the publish decision — a
  // machine that cannot read the selection must not overwrite it.
  const pinText = await deps.fs.readRepoFile(pinRepoPath())
  let repoPins: PinList | undefined
  if (pinText !== undefined) {
    try {
      repoPins = parsePinList(pinText)
    } catch (error) {
      result.errors.push(`${pinRepoPath()}: ${messageOf(error)}`)
      deps.logger.warn(`session sync: skipping unparsable pin list: ${messageOf(error)}`)
    }
  }
  const repoIds = repoPins === undefined ? undefined : repoPins.sessionIds.map(String)
  const baseline = await deps.fs.readPinBaseline()
  const registry = deps.workspaces
  const localIds = registry === undefined ? [] : registry.pinnedSessionIds().map(String)
  const repoKeys = await deps.fs.listDirs(PROJECTS_DIR)

  // Import: only mapped projects admit their sessions into this machine, and
  // only the ones the pin selection covers.
  const projectArchived = new Map<string, SessionId[]>()
  const repoArchivedIds: string[] = []
  for (const key of repoKeys) {
    const text = await deps.fs.readRepoFile(archiveRepoPath(key))
    if (text === undefined) continue
    try {
      const ids = parseArchiveList(text)
      projectArchived.set(key, ids)
      for (const id of ids) repoArchivedIds.push(String(id))
    } catch (error) {
      result.errors.push(`${key}/${ARCHIVE_NAME}: ${messageOf(error)}`)
      deps.logger.warn(`session sync: skipping unparsable archive list ${key}: ${messageOf(error)}`)
    }
  }

  const selection = decidePinSync({
    localIds,
    repoIds,
    baseline,
    // Read after the archive pass applied the repo's marks, so a session
    // archived on any machine leaves the selection in the cycle that archived
    // it — and so an id archived here is excluded from the published set by
    // the same rule that keeps its artifact out.
    archivedIds: registry === undefined ? [] : registry.archivedSessionIds().map(String),
    repoArchivedIds,
  })
  // The gate is the repo's selection as read (not the published one): a
  // selection this machine just published cannot have artifacts yet, and an
  // adopted pin must not make this machine re-export what it just imported.
  const selected = new Set(repoIds ?? [])
  const repoArchived = new Set(repoArchivedIds)
  /** Sessions this cycle actually imported; they are never re-exported. */
  const importedIds = new Set<string>()

  for (const key of repoKeys) {
    const path = byKey.get(key)
    if (path === undefined) continue
    const filenames = await deps.fs.listFiles(`${PROJECTS_DIR}/${key}`)
    // Archive marks land before the selection admits artifacts: a repo that
    // marks an artifact archived must not deliver it, and a session that is
    // archived here must not be imported at all (the host keeps the archive
    // set and the pin set exclusive).
    try {
      await applyArchivedSessions(deps, key, path, result)
    } catch (error) {
      result.errors.push(`${key}/${ARCHIVE_NAME}: ${messageOf(error)}`)
      deps.logger.warn(`session sync: archive apply for ${key} failed: ${messageOf(error)}`)
    }
    for (const filename of filenames) {
      if (filename === ARCHIVE_NAME) continue // the project's archive list, applied above
      const id = sessionIdFromFilename(filename)
      if (id === undefined) {
        result.errors.push(`${key}/${filename}: file name does not carry a session id`)
        continue
      }
      if (!selected.has(String(id))) continue // not pinned anywhere: stays out of this machine
      if (repoArchived.has(String(id))) continue // archived: pinning and archival are exclusive
      try {
        if (await importSession(deps, key, path, id, result, recordConflict)) importedIds.add(String(id))
      } catch (error) {
        result.errors.push(`${key}/${String(id)}: ${messageOf(error)}`)
        deps.logger.warn(`session sync: import ${key}/${String(id)} failed: ${messageOf(error)}`)
      }
    }
  }

  // Mirror the selection into this machine's registry. Ids that arrived by
  // import in this loop are pinnable here; an id whose artifact is missing on
  // this machine takes its pin on a later cycle (or stays a repo-only pin).
  await syncLocalPins(deps, selection, result)

  // Export: mapped projects only, and only sessions the selection covers. A
  // session whose content this cycle just imported is skipped — its artifact
  // is already the source it came from, so re-writing it would only risk a
  // divergence. Everything else the selection names is exported: a session
  // pinned here (the publish path) and a session this machine already held
  // when an adopted pin named it (the pre-existing-content path).
  const localPins = new Set(localIds)
  for (const mapping of deps.settings.mappings) {
    const headers = await ownedHeaders(deps, mapping.path)
    const archivedHere = new Set([
      ...(localArchivedIds(deps) ?? []),
      ...(projectArchived.get(mapping.key) ?? []).map(String),
    ])
    for (const header of headers) {
      const raw = String(header.id)
      if (archivedHere.has(raw)) continue // an archived session leaves the repo
      if (importedIds.has(raw)) continue // just imported: the artifact is the source
      if (!localPins.has(raw) && !selected.has(raw)) continue // not selected anywhere
      try {
        await exportSession(deps, mapping.key, header, result, recordConflict)
      } catch (error) {
        result.errors.push(`${mapping.key}/${raw}: ${messageOf(error)}`)
        deps.logger.warn(`session sync: export ${mapping.key}/${raw} failed: ${messageOf(error)}`)
      }
    }
    try {
      await exportArchivedSessions(deps, mapping.key, headers, result)
    } catch (error) {
      result.errors.push(`${mapping.key}/${ARCHIVE_NAME}: ${messageOf(error)}`)
      deps.logger.warn(`session sync: archive export for ${mapping.key} failed: ${messageOf(error)}`)
    }
    try {
      await deleteArchivedRepoFiles(deps, mapping.key, result)
    } catch (error) {
      result.errors.push(`${mapping.key}/${ARCHIVE_NAME}: ${messageOf(error)}`)
      deps.logger.warn(`session sync: archive deletion for ${mapping.key} failed: ${messageOf(error)}`)
    }
  }

  // Publish this machine's pin edits, then retire what the selection dropped.
  await publishPins(deps, selection, repoIds, result)
  if (selection.canSweep) {
    await sweepRetiredArtifacts(
      deps,
      selection,
      new Set([...(localArchivedIds(deps) ?? []), ...repoArchived]),
      result,
    )
  }

  // Manifest: the union of mapped keys and the project directories the repo
  // still holds — re-listed, because this cycle's sweeps may have removed one.
  const manifestKeys = [
    ...new Set([...(await deps.fs.listDirs(PROJECTS_DIR)), ...deps.settings.mappings.map(mapping => mapping.key)]),
  ]
  await deps.fs.writeRepoFile(MANIFEST_NAME, serializeManifest(manifestKeys))

  await deps.git.addAll()
  await deps.git.commit('dsh session sync')
  await deps.git.push()

  // The anchor for the next cycle: the pin set this machine actually holds
  // after mirroring the selection, plus the pins it now owns (so a later unpin
  // reads as a local removal). The applied set — never the intended publish —
  // is what gets recorded: a cycle that could not mirror an adopted pin (no
  // registry mounted yet, or a pin the host refused) must not record it as
  // held, or the next cycle reads its absence as a local unpin and publishes
  // that removal while sweeping the artifact the pin still selects. Writing
  // only after the push keeps a selection the remote never accepted out of the
  // anchor too, so the next cycle republishes it instead of adopting the
  // missing pins as repo-side removals.
  const appliedIds = registry === undefined ? [] : registry.pinnedSessionIds().map(String)
  const baselineStale = baseline === undefined
    || !sameIds(baseline.sessionIds, appliedIds)
    || !sameIds(baseline.ownedIds, selection.ownedIds)
  if (baselineStale) {
    await deps.fs.writePinBaseline({
      firstSeen: true,
      sessionIds: appliedIds,
      ownedIds: selection.ownedIds,
    })
  }

  result.conflicts = [...conflictPaths]
  return result
}

/** Re-export the repo layout vocabulary for consumers of the engine's results. */
export { ARCHIVE_NAME, CONFLICTS_DIR, MANIFEST_NAME, PIN_NAME, PROJECTS_DIR } from './format.ts'
