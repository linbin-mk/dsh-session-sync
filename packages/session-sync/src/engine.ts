/**
 * Sync engine: the one-cycle orchestration over the persistence and
 * workspace services, the repo filesystem, and git. Every cycle follows the
 * same order — fetch and reset to the remote state, import sessions for
 * mapped projects, export this machine's sessions for mapped projects, then
 * commit and push. Per-session failures are contained and reported; only git
 * failures reject the cycle.
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
 * An archived session is retired from git: its log artifact is deleted from
 * the repo (the local copy stays untouched), so archived sessions stop
 * consuming repo space. Only the archive mark keeps travelling, and it
 * travels through `archived.json` — which is why the mark union runs before
 * the deletion sweep in each project: a mark attributed via a repo file
 * (an archived session deleted locally) is still written before that file
 * disappears.
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
  archiveRepoPath, conflictRepoPath, parseArchiveList, parsePortableSession,
  serializeArchiveList, serializeManifest, sessionIdFromFilename,
  serializePortableSession, sessionRepoPath,
} from './format.ts'
import type { PortableSession } from './format.ts'
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
  /** List directory names inside a repo-relative directory; empty when absent. */
  listDirs(rel: string): Promise<string[]>
  /** List file names inside a repo-relative directory; empty when absent. */
  listFiles(rel: string): Promise<string[]>
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
  /** Repo-relative conflict-copy paths written this cycle. */
  conflicts: string[]
  /** Contained per-session failure messages (never cycle-fatal). */
  errors: string[]
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

/** Import one repo artifact into this machine, applying the conflict policy. */
async function importSession(
  deps: SyncEngineDeps,
  key: string,
  path: string,
  id: SessionId,
  result: SyncRunResult,
  recordConflict: (path: string) => void,
): Promise<void> {
  const repoPath = sessionRepoPath(key, id)
  const remoteText = await deps.fs.readRepoFile(repoPath)
  if (remoteText === undefined) return
  let portable
  try {
    portable = parsePortableSession(remoteText, path)
  } catch (error) {
    result.errors.push(`${key}/${String(id)}: ${messageOf(error)}`)
    deps.logger.warn(`session sync: skipping unparsable artifact ${key}/${String(id)}: ${messageOf(error)}`)
    return
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
    return
  }
  const local = await deps.persistence.inspect(id)
  if (local === undefined) {
    await deps.persistence.create(portable)
    await attachSession(deps, path, id, result)
    await warmSession(deps, id)
    result.imported += 1
    recordSwitchImport(result, portable, id)
    return
  }
  const localEvents = local.events
  const relation = compareLogs(localEvents, portable.events)
  if (relation === 'divergent') {
    const conflictPath = conflictRepoPath(key, id, deps.fs.hostname)
    await deps.fs.writeRepoFile(conflictPath, remoteText)
    recordConflict(conflictPath)
    deps.logger.warn(`session sync: divergent logs for ${key}/${String(id)} preserved at ${conflictPath}`)
    return
  }
  if (relation === 'local-prefix') {
    await deps.persistence.append(id, portable.events.slice(localEvents.length))
    await attachSession(deps, path, id, result)
    await warmSession(deps, id)
    result.imported += 1
    recordSwitchImport(result, portable, id)
    return
  }
  // equal or remote-prefix: local state already carries everything the repo has.
}

/** This machine's archived-session ids, or `undefined` without a registry. */
function localArchivedIds(deps: SyncEngineDeps): Set<string> | undefined {
  if (deps.workspaces === undefined) return undefined
  const ids = deps.workspaces.archivedSessionIds()
  return ids.length === 0 ? undefined : new Set(ids.map(String))
}

/** Export one local session into the repo under its mapped project key. */
async function exportSession(
  deps: SyncEngineDeps,
  key: string,
  header: SessionHeader,
  result: SyncRunResult,
  recordConflict: (path: string) => void,
): Promise<void> {
  // An archived session is retired from git: never write its content, never
  // count a push. The deletion sweep below removes its repo artifact.
  const archived = localArchivedIds(deps)
  if (archived !== undefined && archived.has(String(header.id))) return
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
 * is written only when this machine contributes something new. This union
 * must run before {@link deleteArchivedRepoFiles}: a mark attributed purely
 * by a repo file is written here while that file still exists.
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
 * Run one complete sync cycle and report what it changed. Git failures
 * reject the cycle (the caller records them on the status view); per-session
 * failures land in {@link SyncRunResult.errors} and never stop the rest.
 * @param deps - services, settings, filesystem, and git surfaces.
 * @returns the cycle's outcome counters.
 */
export async function runSyncCycle(deps: SyncEngineDeps): Promise<SyncRunResult> {
  const result: SyncRunResult = { imported: 0, importedIds: [], pushed: 0, archived: 0, deleted: 0, conflicts: [], errors: [] }
  const conflictPaths = new Set<string>()
  const recordConflict = (path: string): void => { conflictPaths.add(path) }
  await deps.git.ensure()
  await deps.git.fetch()
  await deps.git.resetHard()

  const byKey = new Map(deps.settings.mappings.map(mapping => [mapping.key, mapping.path]))

  // Import: only mapped projects admit their sessions into this machine.
  const repoKeys = await deps.fs.listDirs(PROJECTS_DIR)
  for (const key of repoKeys) {
    const path = byKey.get(key)
    if (path === undefined) continue
    const filenames = await deps.fs.listFiles(`${PROJECTS_DIR}/${key}`)
    for (const filename of filenames) {
      if (filename === ARCHIVE_NAME) continue // the project's archive list, applied below
      const id = sessionIdFromFilename(filename)
      if (id === undefined) {
        result.errors.push(`${key}/${filename}: file name does not carry a session id`)
        continue
      }
      try {
        await importSession(deps, key, path, id, result, recordConflict)
      } catch (error) {
        result.errors.push(`${key}/${String(id)}: ${messageOf(error)}`)
        deps.logger.warn(`session sync: import ${key}/${String(id)} failed: ${messageOf(error)}`)
      }
    }
    try {
      await applyArchivedSessions(deps, key, path, result)
    } catch (error) {
      result.errors.push(`${key}/${ARCHIVE_NAME}: ${messageOf(error)}`)
      deps.logger.warn(`session sync: archive apply for ${key} failed: ${messageOf(error)}`)
    }
  }

  // Export: mapped projects only — sessions of unmapped projects never leave.
  for (const mapping of deps.settings.mappings) {
    const headers = await ownedHeaders(deps, mapping.path)
    for (const header of headers) {
      try {
        await exportSession(deps, mapping.key, header, result, recordConflict)
      } catch (error) {
        result.errors.push(`${mapping.key}/${String(header.id)}: ${messageOf(error)}`)
        deps.logger.warn(`session sync: export ${mapping.key}/${String(header.id)} failed: ${messageOf(error)}`)
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

  // Manifest: the union of mapped keys and whatever the repo already holds.
  const manifestKeys = [...new Set([...repoKeys, ...deps.settings.mappings.map(mapping => mapping.key)])]
  await deps.fs.writeRepoFile(MANIFEST_NAME, serializeManifest(manifestKeys))

  await deps.git.addAll()
  await deps.git.commit('dsh session sync')
  await deps.git.push()
  result.conflicts = [...conflictPaths]
  return result
}

/** Re-export the repo layout vocabulary for consumers of the engine's results. */
export { ARCHIVE_NAME, CONFLICTS_DIR, MANIFEST_NAME, PROJECTS_DIR }
