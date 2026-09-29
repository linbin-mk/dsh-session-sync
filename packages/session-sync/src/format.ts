/**
 * Portable repository format (v2) for session sync. The git worktree stores
 * one plaintext JSONL artifact per session under `workspaces/<key>/`. The
 * first line is this plugin's own versioned envelope; every remaining line is
 * one logical Session event. The envelope stores the workspace's stable repo
 * key instead of a machine path: importing machines resolve that key's
 * manifest name to a local workspace and stamp its directory into the header,
 * so one repo serves hosts whose projects live at different absolute paths.
 *
 * Layout:
 * ```text
 * sync.json                                  { version, updatedAt, host, entries: [...] }
 * workspaces/<key>/manifest.json             { version, key, name, updatedAt }
 * workspaces/<key>/session-<id>.jsonl
 * workspaces/<key>/session-<id>.records.json { version, records: [...] }
 * workspaces/<key>/archived.json             { version, sessionIds: [...] }
 * conflicts/<key>/<stem>-<host>.jsonl
 * ```
 *
 * `sync.json` is the cross-machine synchronization selection: exactly the
 * sessions listed there are exported, on every machine. It is written as a
 * whole snapshot rather than merged, because closing sync has to propagate and
 * a union could never express a removal. Entries carry the workspace key, the
 * workspace **name** (the only join key machines match on), a display title,
 * and the adding host/time, so any machine can render the full selection tree
 * without importing anything first — the artifact header itself carries no
 * title.
 *
 * `manifest.json` is where a workspace's stable key meets its current display
 * name. Machines match a repo workspace to a local one by comparing
 * `manifest.name` with the local workspace title; the key never changes, so a
 * rename only rewrites the name here.
 *
 * An archived session is retired from git: the engine deletes its
 * `session-<id>.jsonl` (the local log is untouched) while its id stays in the
 * workspace's grow-only `archived.json`, which is how machines that still hold
 * the session learn to hide it.
 *
 * The artifact deliberately does not copy the JSONL backend's header, packed
 * rows, compression, or generation layout. Those are private storage choices;
 * this format uses only the public logical Session types.
 * @module @linbin-mk/dsh-session-sync/format
 */

import {
  KNOWN_SESSION_EVENT_TYPES,
  SESSION_FORMAT_VERSION,
  SessionId,
  SessionLogOffset,
  snapshotSessionEvent,
} from '@deepseek-ai/dsh-session'
import type { SessionEvent, SessionHeader } from '@deepseek-ai/dsh-session'

/** Version of the per-session portable artifact written by this plugin. */
export const SYNC_ARTIFACT_VERSION = 2

/** Selection-snapshot version this plugin writes and accepts (`sync.json`). */
export const SYNC_SELECTION_VERSION = 2

/** Per-workspace manifest version this plugin writes and accepts. */
export const SYNC_MANIFEST_VERSION = 2

/** Per-session sync-record version this plugin writes and accepts. */
export const SYNC_RECORDS_VERSION = 2

/** Machine-local sync-anchor version this plugin writes and accepts. */
export const SYNC_STATE_VERSION = 2

/** Machine-local selection-mirror version this plugin writes and accepts. */
export const SYNC_LOCAL_SELECTION_VERSION = 2

/** Repo directory holding per-workspace session artifacts. */
export const WORKSPACES_DIR = 'workspaces'

/** File name of one workspace's manifest inside its directory. */
export const MANIFEST_NAME = 'manifest.json'

/** Repo directory holding divergent-log copies (never imported). */
export const CONFLICTS_DIR = 'conflicts'

/** Archive-list version this plugin writes and accepts. */
export const SYNC_ARCHIVE_VERSION = 1

/** File name of one workspace's archived-session list inside its directory. */
export const ARCHIVE_NAME = 'archived.json'

/** File name of the repo-level synchronization selection. */
export const SELECTION_NAME = 'sync.json'

/** How many sync records one session keeps; the oldest are dropped. */
export const SYNC_RECORD_LIMIT = 20

/** One workspace manifest: the stable repo key and the current display name. */
export interface WorkspaceManifest {
  /** Stable repo directory key, minted once and never rewritten. */
  key: string
  /** Display name the local workspace title is matched against. */
  name: string
  /** ISO-8601 instant this manifest was last written. */
  updatedAt: string
}

/** One session selected for synchronization, as the repo snapshot records it. */
export interface SyncSelectionEntry {
  /** Selected session id. */
  id: SessionId
  /** Repo key of the workspace the session belongs to. */
  key: string
  /** Workspace display name on the adding machine — the matching join key. */
  workspaceName: string
  /** Session title at the last publish, for rendering without an import. */
  title: string
  /** ISO-8601 instant the session was added to the selection. */
  addedAt: string
  /** Hostname that added it (diagnostics and display). */
  addedBy: string
}

/** Decoded `sync.json`: the authoritative cross-machine synchronization selection. */
export interface SyncSelection {
  /** Hostname that published this revision (diagnostics only). */
  host: string
  /** ISO-8601 instant that machine published it (diagnostics only). */
  updatedAt: string
  /** Selected sessions, in stored order. */
  entries: SyncSelectionEntry[]
}

/** Direction of one recorded synchronization of a session. */
export type SyncRecordDirection = 'push' | 'pull'

/** Outcome of one recorded synchronization of a session. */
export type SyncRecordResult = 'ok' | 'conflict'

/** One machine's record of synchronizing one session. */
export interface SessionSyncRecord {
  /** Hostname that performed the synchronization. */
  host: string
  /** ISO-8601 instant it happened. */
  at: string
  /** Whether that machine uploaded its log or downloaded one. */
  direction: SyncRecordDirection
  /** Logical events carried by that transfer. */
  events: number
  /** How the transfer ended. */
  result: SyncRecordResult
}

/** Decoded `session-<id>.records.json`: one session's sync history, newest kept. */
export interface SessionSyncRecords {
  /** Records in stored order (oldest first). */
  records: SessionSyncRecord[]
}

/**
 * Machine-local synchronization anchor. `syncedIds` is the selection this
 * machine last agreed with the repo, and `ownedIds` the entries it may remove;
 * together they separate "you edited the selection here" from "another machine
 * edited the repo". `firstSeen` records whether this machine ever completed a
 * cycle: before that, an empty local selection means a fresh machine, not a
 * deliberate "close everything", so nothing may be published or swept.
 * `workspaceKeys` is the local workspace-id → repo-key table that keeps a repo
 * directory stable when its workspace is renamed.
 */
export interface SyncState {
  /** Whether this machine has completed at least one cycle. */
  firstSeen: boolean
  /** Session ids of the last synced selection (sorted on write). */
  syncedIds: SessionId[]
  /** Session ids this machine may drop from the selection (sorted on write). */
  ownedIds: SessionId[]
  /** Local workspace-id → repo key assignments. */
  workspaceKeys: WorkspaceKeyAssignment[]
  /** ISO-8601 instant this state was written. */
  updatedAt: string
  /** Hostname that wrote it (diagnostics only). */
  host: string
}

/** One local workspace's stable repo directory key. */
export interface WorkspaceKeyAssignment {
  /** Local workspace id (a stable uuid). */
  workspaceId: string
  /** Repo directory key holding that workspace's artifacts. */
  key: string
}

/** Machine-local mirror of the selection this machine currently holds. */
export interface LocalSelection {
  /** Selected session ids (sorted on write). */
  sessionIds: SessionId[]
}

/** Parsed portable artifact: the header plus its decoded event log. */
export interface PortableSession {
  /** Header with `cwd` already rewritten to the importing machine's path. */
  meta: SessionHeader
  /** Exact number of leading events inherited from a fork parent. */
  inheritedEventCount: SessionLogOffset
  /** Contiguous decoded events in seq order starting at 0. */
  events: SessionEvent[]
}

/** Parse the first line of a portable artifact into a header-line shape. */
interface ParsedArtifactLine {
  type: 'dsh-session-sync'
  version: typeof SYNC_ARTIFACT_VERSION
  workspace: string
  inheritedEventCount: number
  session: {
    version: typeof SESSION_FORMAT_VERSION
    id: string
    createdAt: number
    parentSession?: string
    isSeeded: boolean
    origin?: 'subagent'
    delegationDepth?: number
    agentPreset?: string
  }
}

/** Text encoding used for repo artifacts. */
const TEXT_ENCODING = 'utf8' as const

/** Session ids in the repo must satisfy this pattern before any import. */
const SESSION_ID_PATTERN = /^session-[A-Za-z0-9-]+$/

/** Whether a value is a non-negative safe integer. */
function isNonNegativeSafeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && !Object.is(value, -0)
}

/** Whether a value is a non-empty string. */
function isNonBlankString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0
}

/** Whether a value is an ISO-8601 instant string. */
function isIsoInstant(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && !Number.isNaN(Date.parse(value))
}

/** Shape-check one parsed header line, rejecting anything a persistence backend would refuse. */
function parseHeaderLine(parsed: unknown): ParsedArtifactLine {
  if (typeof parsed !== 'object' || parsed === null) {
    throw new Error('portable session artifact: first line is not a JSON object')
  }
  const line = parsed as Partial<ParsedArtifactLine>
  if (line.type !== 'dsh-session-sync') {
    throw new Error('portable session artifact: first line is not a session-sync header')
  }
  if (line.version !== SYNC_ARTIFACT_VERSION) {
    throw new Error(
      `portable session artifact: unsupported artifact version ${String(line.version)} (this plugin writes version ${SYNC_ARTIFACT_VERSION})`,
    )
  }
  if (!isNonBlankString(line.workspace)) {
    throw new Error('portable session artifact: workspace key is invalid')
  }
  if (!isNonNegativeSafeInteger(line.inheritedEventCount)) {
    throw new Error('portable session artifact: inheritedEventCount is invalid')
  }
  if (typeof line.session !== 'object' || line.session === null || Array.isArray(line.session)) {
    throw new Error('portable session artifact: session header is invalid')
  }
  const session = line.session as Partial<ParsedArtifactLine['session']>
  if (session.version !== SESSION_FORMAT_VERSION) {
    throw new Error(`portable session artifact: unsupported session version ${String(session.version)}`)
  }
  if (typeof session.id !== 'string' || !SESSION_ID_PATTERN.test(session.id)) {
    throw new Error('portable session artifact: header id is invalid')
  }
  if (!isNonNegativeSafeInteger(session.createdAt)) {
    throw new Error('portable session artifact: header createdAt is invalid')
  }
  if (session.parentSession !== undefined
    && (typeof session.parentSession !== 'string' || !SESSION_ID_PATTERN.test(session.parentSession))) {
    throw new Error('portable session artifact: header parentSession is invalid')
  }
  if (typeof session.isSeeded !== 'boolean') {
    throw new Error('portable session artifact: header isSeeded is invalid')
  }
  if (!session.isSeeded && line.inheritedEventCount !== 0) {
    throw new Error('portable session artifact: unseeded session inheritedEventCount must be 0')
  }
  if (session.origin !== undefined && session.origin !== 'subagent') {
    throw new Error('portable session artifact: header origin is invalid')
  }
  if (session.delegationDepth !== undefined && !isNonNegativeSafeInteger(session.delegationDepth)) {
    throw new Error('portable session artifact: header delegationDepth is invalid')
  }
  if (session.agentPreset !== undefined && typeof session.agentPreset !== 'string') {
    throw new Error('portable session artifact: header agentPreset is invalid')
  }
  return line as ParsedArtifactLine
}

/** Build a persistence header from a parsed header line with the target `cwd`. */
function headerFromLine(line: ParsedArtifactLine, cwd: string): SessionHeader {
  const session = line.session
  return {
    version: SESSION_FORMAT_VERSION,
    id: SessionId(session.id),
    createdAt: session.createdAt,
    cwd,
    ...session.parentSession !== undefined ? { parentSession: SessionId(session.parentSession) } : {},
    isSeeded: session.isSeeded,
    ...session.origin !== undefined ? { origin: session.origin } : {},
    delegationDepth: session.delegationDepth ?? 0,
    ...session.agentPreset !== undefined ? { agentPreset: session.agentPreset } : {},
  }
}

/** Split artifact text into its header line and the remaining rows. */
function splitArtifact(text: string): { headerText: string; rowsText: string } {
  const newline = text.indexOf('\n')
  if (newline === -1) throw new Error('portable session artifact: missing header newline')
  return { headerText: text.slice(0, newline), rowsText: text.slice(newline + 1) }
}

/**
 * Serialize one logical Session into the portable JSONL format.
 * @param session - current logical header, inherited cut, and events.
 * @param key - stable workspace key stored in place of the local cwd.
 * @returns canonical artifact text with one event per line.
 */
export function serializePortableSession(session: PortableSession, key: string): string {
  const { meta, inheritedEventCount, events } = session
  if (!meta.isSeeded && inheritedEventCount !== 0) {
    throw new Error('portable session artifact: unseeded session inheritedEventCount must be 0')
  }
  const header = {
    type: 'dsh-session-sync',
    version: SYNC_ARTIFACT_VERSION,
    workspace: key,
    inheritedEventCount,
    session: {
      version: meta.version,
      id: meta.id,
      createdAt: meta.createdAt,
      ...meta.parentSession !== undefined ? { parentSession: meta.parentSession } : {},
      isSeeded: meta.isSeeded,
      ...meta.origin !== undefined ? { origin: meta.origin } : {},
      delegationDepth: meta.delegationDepth ?? 0,
      ...meta.agentPreset !== undefined ? { agentPreset: meta.agentPreset } : {},
    },
  }
  return [header, ...events].map(value => JSON.stringify(value)).join('\n') + '\n'
}

/**
 * Parse a portable artifact into a header and a contiguous decoded event log.
 * The header `cwd` is replaced with `path` — the importing machine's local
 * workspace directory — so the public persistence service creates the session
 * in the right workspace. Event rows contain logical events; invalid
 * envelopes, unknown required event types, seq gaps, duplicates, or a broken
 * tail reject the whole artifact instead of importing a corrupt log.
 * @param text - raw artifact text (header line first).
 * @param path - local workspace directory to stamp into the header.
 * @returns the parsed portable session.
 */
export function parsePortableSession(text: string, path: string): PortableSession {
  const { headerText, rowsText } = splitArtifact(text)
  const line = parseHeaderLine(JSON.parse(headerText))
  const events: SessionEvent[] = []
  if (rowsText.length > 0) {
    for (const rowText of rowsText.split('\n')) {
      if (rowText.length === 0) continue // the artifact's trailing newline, not a row
      let parsed: unknown
      try {
        parsed = JSON.parse(rowText)
      } catch {
        throw new Error(`portable session artifact: unparsable event row (${rowText.slice(0, 64)}…)`)
      }
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
        throw new Error('portable session artifact: event row is not a JSON object')
      }
      const record = parsed as Record<string, unknown>
      if (typeof record.type !== 'string'
        || !isNonNegativeSafeInteger(record.seq)
        || typeof record.time !== 'number' || !Number.isSafeInteger(record.time)
        || record.data === undefined) {
        throw new Error('portable session artifact: event envelope is invalid')
      }
      if (!KNOWN_SESSION_EVENT_TYPES.has(record.type) && record.ignorable !== true) {
        throw new Error(`portable session artifact: unknown required event type ${record.type}`)
      }
      if (record.seq !== events.length) {
        throw new Error(
          `portable session artifact: seq gap in event rows (expected ${events.length}, got ${String(record.seq)})`,
        )
      }
      try {
        events.push(snapshotSessionEvent(record as unknown as SessionEvent))
      } catch {
        throw new Error(`portable session artifact: invalid event row at seq ${String(record.seq)}`)
      }
    }
  }
  if (line.inheritedEventCount > events.length) {
    throw new Error('portable session artifact: inheritedEventCount exceeds the event log')
  }
  return {
    meta: headerFromLine(line, path),
    inheritedEventCount: SessionLogOffset(line.inheritedEventCount),
    events,
  }
}

/** Encode a raw string as one safe repo path segment. */
function encodeRepoSegment(raw: string): string {
  let out = ''
  for (let i = 0; i < raw.length; i++) {
    const code = raw.charCodeAt(i)
    const ch = String.fromCharCode(code)
    if (ch !== '~' && /^[A-Za-z0-9._-]$/.test(ch)) {
      out += ch
    } else {
      out += '~' + code.toString(16).toUpperCase().padStart(4, '0')
    }
  }
  return out
}

/** Repo-relative directory of one workspace. */
export function workspaceRepoDir(key: string): string {
  return `${WORKSPACES_DIR}/${encodeRepoSegment(key)}`
}

/** Repo-relative path of one session artifact, `workspaces/<key>/session-<id>.jsonl`. */
export function sessionRepoPath(key: string, id: SessionId): string {
  return `${workspaceRepoDir(key)}/${encodeRepoSegment(String(id))}.jsonl`
}

/** Repo-relative path of one session's sync records, `workspaces/<key>/session-<id>.records.json`. */
export function recordsRepoPath(key: string, id: SessionId): string {
  return `${workspaceRepoDir(key)}/${encodeRepoSegment(String(id))}.records.json`
}

/** Repo-relative path of one conflict copy, `conflicts/<key>/<id>-<host>.jsonl`. */
export function conflictRepoPath(key: string, id: SessionId, host: string): string {
  return `${CONFLICTS_DIR}/${encodeRepoSegment(key)}/${encodeRepoSegment(String(id))}-${encodeRepoSegment(host)}.jsonl`
}

/** Repo-relative path of one workspace's archive list, `workspaces/<key>/archived.json`. */
export function archiveRepoPath(key: string): string {
  return `${workspaceRepoDir(key)}/${ARCHIVE_NAME}`
}

/** Repo-relative path of one workspace's manifest, `workspaces/<key>/manifest.json`. */
export function manifestRepoPath(key: string): string {
  return `${workspaceRepoDir(key)}/${MANIFEST_NAME}`
}

/** Repo-relative path of the synchronization selection, `sync.json` at the worktree root. */
export function selectionRepoPath(): string {
  return SELECTION_NAME
}

/**
 * Decode the session id from a repo artifact file name (`<id>.jsonl`, with
 * `id` carrying its own `session-` prefix).
 * @param filename - the artifact's base name inside a workspace directory.
 * @returns the branded id, or `undefined` when the name does not carry one.
 */
export function sessionIdFromFilename(filename: string): SessionId | undefined {
  const match = /^(session-[A-Za-z0-9-]+)\.jsonl$/.exec(filename)
  if (match === null) return undefined
  const id = match[1]
  /* v8 ignore next -- the capture group always exists when the pattern matched */
  return id === undefined ? undefined : SessionId(id)
}

/** Serialize one workspace manifest. */
export function serializeManifest(manifest: WorkspaceManifest): string {
  return JSON.stringify({
    version: SYNC_MANIFEST_VERSION,
    key: manifest.key,
    name: manifest.name,
    updatedAt: manifest.updatedAt,
  }) + '\n'
}

/**
 * Parse one workspace manifest. The name is the only join key machines match
 * on, so a manifest that cannot supply it rejects rather than importing the
 * workspace's sessions into an arbitrary local workspace.
 * @param text - raw manifest text.
 * @param expectedKey - the directory key the manifest was read from.
 * @returns the decoded manifest.
 */
export function parseManifest(text: string, expectedKey: string): WorkspaceManifest {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    throw new Error('workspace manifest: not valid JSON')
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error('workspace manifest: not a JSON object')
  }
  const manifest = parsed as Partial<{ version: unknown; key: unknown; name: unknown; updatedAt: unknown }>
  if (manifest.version !== SYNC_MANIFEST_VERSION) {
    throw new Error(`workspace manifest: unsupported version ${String(manifest.version)}`)
  }
  if (manifest.key !== expectedKey) {
    throw new Error(`workspace manifest: key ${JSON.stringify(manifest.key)} does not match its directory ${JSON.stringify(expectedKey)}`)
  }
  if (!isNonBlankString(manifest.name)) {
    throw new Error('workspace manifest: name is not a non-empty string')
  }
  if (!isIsoInstant(manifest.updatedAt)) {
    throw new Error('workspace manifest: updatedAt is not an ISO-8601 instant')
  }
  return { key: manifest.key, name: manifest.name, updatedAt: manifest.updatedAt }
}

/**
 * Parse the repo synchronization selection. Malformed shapes reject instead of
 * silently emptying the selection: an empty selection would stop every sync
 * and retire every artifact.
 * @param text - raw `sync.json` text.
 * @returns the decoded selection.
 */
export function parseSelection(text: string): SyncSelection {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    throw new Error('selection: not valid JSON')
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error('selection: not a JSON object')
  }
  const selection = parsed as Partial<{ version: unknown; host: unknown; updatedAt: unknown; entries: unknown }>
  if (selection.version !== SYNC_SELECTION_VERSION) {
    throw new Error(`selection: unsupported version ${String(selection.version)}`)
  }
  if (!isNonBlankString(selection.host)) {
    throw new Error('selection: host is not a string')
  }
  if (!isIsoInstant(selection.updatedAt)) {
    throw new Error('selection: updatedAt is not an ISO-8601 instant')
  }
  if (!Array.isArray(selection.entries)) {
    throw new Error('selection: entries is not an array')
  }
  const entries: SyncSelectionEntry[] = []
  const seen = new Set<string>()
  for (const raw of selection.entries) {
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
      throw new Error('selection: entry is not a JSON object')
    }
    const entry = raw as Partial<Record<keyof SyncSelectionEntry, unknown>>
    if (typeof entry.id !== 'string' || !SESSION_ID_PATTERN.test(entry.id)) {
      throw new Error(`selection: invalid session id ${JSON.stringify(entry.id)}`)
    }
    if (!isNonBlankString(entry.key)) throw new Error(`selection: invalid workspace key for ${entry.id}`)
    if (!isNonBlankString(entry.workspaceName)) throw new Error(`selection: invalid workspace name for ${entry.id}`)
    if (typeof entry.title !== 'string') throw new Error(`selection: invalid title for ${entry.id}`)
    if (!isIsoInstant(entry.addedAt)) throw new Error(`selection: invalid addedAt for ${entry.id}`)
    if (!isNonBlankString(entry.addedBy)) throw new Error(`selection: invalid addedBy for ${entry.id}`)
    if (seen.has(entry.id)) throw new Error(`selection: duplicate session id ${entry.id}`)
    seen.add(entry.id)
    entries.push({
      id: SessionId(entry.id),
      key: entry.key,
      workspaceName: entry.workspaceName,
      title: entry.title,
      addedAt: entry.addedAt,
      addedBy: entry.addedBy,
    })
  }
  return { host: selection.host, updatedAt: selection.updatedAt, entries }
}

/** Serialize the repo selection canonically: stable id order, versioned, attributed. */
export function serializeSelection(selection: SyncSelection): string {
  const entries = [...selection.entries]
    .sort((left, right) => String(left.id) < String(right.id) ? -1 : String(left.id) > String(right.id) ? 1 : 0)
    .map(entry => ({
      id: String(entry.id),
      key: entry.key,
      workspaceName: entry.workspaceName,
      title: entry.title,
      addedAt: entry.addedAt,
      addedBy: entry.addedBy,
    }))
  return JSON.stringify({
    version: SYNC_SELECTION_VERSION,
    updatedAt: selection.updatedAt,
    host: selection.host,
    entries,
  }) + '\n'
}

/**
 * Parse one session's sync records. Records are display data — the dialog the
 * menu opens — so a malformed file rejects for the caller to report rather
 * than silently dropping history.
 * @param text - raw records text.
 * @returns the decoded records, oldest first.
 */
export function parseRecords(text: string): SessionSyncRecords {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    throw new Error('session records: not valid JSON')
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error('session records: not a JSON object')
  }
  const records = parsed as Partial<{ version: unknown; records: unknown }>
  if (records.version !== SYNC_RECORDS_VERSION) {
    throw new Error(`session records: unsupported version ${String(records.version)}`)
  }
  if (!Array.isArray(records.records)) {
    throw new Error('session records: records is not an array')
  }
  const decoded: SessionSyncRecord[] = []
  for (const raw of records.records) {
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
      throw new Error('session records: record is not a JSON object')
    }
    const record = raw as Partial<Record<keyof SessionSyncRecord, unknown>>
    if (!isNonBlankString(record.host)) throw new Error('session records: invalid host')
    if (!isIsoInstant(record.at)) throw new Error('session records: invalid at')
    if (record.direction !== 'push' && record.direction !== 'pull') {
      throw new Error(`session records: invalid direction ${JSON.stringify(record.direction)}`)
    }
    if (!isNonNegativeSafeInteger(record.events)) throw new Error('session records: invalid events')
    if (record.result !== 'ok' && record.result !== 'conflict') {
      throw new Error(`session records: invalid result ${JSON.stringify(record.result)}`)
    }
    decoded.push({
      host: record.host,
      at: record.at,
      direction: record.direction,
      events: record.events,
      result: record.result,
    })
  }
  return { records: decoded }
}

/** Serialize one session's records canonically, keeping the newest entries up to the cap. */
export function serializeRecords(records: SessionSyncRecords): string {
  const kept = records.records.slice(Math.max(0, records.records.length - SYNC_RECORD_LIMIT))
  return JSON.stringify({
    version: SYNC_RECORDS_VERSION,
    records: kept.map(record => ({
      host: record.host,
      at: record.at,
      direction: record.direction,
      events: record.events,
      result: record.result,
    })),
  }) + '\n'
}

/**
 * Merge freshly observed records into the ones already stored, newest last.
 * The key is `(host, at, direction)`: a record is something a machine did, and
 * re-reading the same file must not duplicate it. `conflict`/`skipped` results
 * are not pre-empted by a later `ok` — both are real history.
 * @param existing - records already stored.
 * @param incoming - records observed this cycle.
 * @returns the merged list, oldest first, capped at {@link SYNC_RECORD_LIMIT}.
 */
export function mergeRecords(
  existing: readonly SessionSyncRecord[],
  incoming: readonly SessionSyncRecord[],
): SessionSyncRecord[] {
  const key = (record: SessionSyncRecord): string => `${record.host}\u0000${record.at}\u0000${record.direction}`
  const byKey = new Map<string, SessionSyncRecord>()
  for (const record of [...existing, ...incoming]) byKey.set(key(record), record)
  const merged = [...byKey.values()].sort((left, right) => {
    if (left.at === right.at) return 0
    return left.at < right.at ? -1 : 1
  })
  return merged.slice(Math.max(0, merged.length - SYNC_RECORD_LIMIT))
}

/**
 * Parse a workspace archive-list artifact into branded session ids. The list is
 * the repo's record of which workspace sessions were archived on any machine —
 * a grow-only set, so readers union it into their own registry set. Malformed
 * shapes reject instead of silently hiding sessions.
 * @param text - raw archive-list artifact text.
 * @returns the archived session ids in stored order.
 */
export function parseArchiveList(text: string): SessionId[] {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    throw new Error('workspace archive list: not valid JSON')
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error('workspace archive list: not a JSON object')
  }
  const list = parsed as Partial<{ version: unknown; sessionIds: unknown }>
  if (list.version !== SYNC_ARCHIVE_VERSION) {
    throw new Error(`workspace archive list: unsupported version ${String(list.version)}`)
  }
  if (!Array.isArray(list.sessionIds)) {
    throw new Error('workspace archive list: sessionIds is not an array')
  }
  const ids: SessionId[] = []
  for (const entry of list.sessionIds) {
    if (typeof entry !== 'string' || !SESSION_ID_PATTERN.test(entry)) {
      throw new Error(`workspace archive list: invalid session id ${JSON.stringify(entry)}`)
    }
    ids.push(SessionId(entry))
  }
  return ids
}

/** Serialize a workspace archive list canonically: sorted, deduplicated, versioned. */
export function serializeArchiveList(ids: readonly SessionId[]): string {
  const unique = [...new Set(ids.map(String))].sort()
  return JSON.stringify({ version: SYNC_ARCHIVE_VERSION, sessionIds: unique }) + '\n'
}

/**
 * Parse this machine's synchronization anchor. Unlike the repo artifacts this
 * file is machine-local recovery state, not shared data: a missing file is the
 * ordinary fresh state (handled by the caller), but an unreadable one is a
 * real fault, because guessing it would decide between publishing this
 * machine's edits and adopting the repo's.
 * @param text - raw state text.
 * @returns the decoded state.
 */
export function parseState(text: string): SyncState {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    throw new Error('sync state: not valid JSON')
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error('sync state: not a JSON object')
  }
  const state = parsed as Partial<{
    version: unknown; firstSeen: unknown; syncedIds: unknown; ownedIds: unknown
    workspaceKeys: unknown; host: unknown; updatedAt: unknown
  }>
  if (state.version !== SYNC_STATE_VERSION) {
    throw new Error(`sync state: unsupported version ${String(state.version)}`)
  }
  if (typeof state.firstSeen !== 'boolean') {
    throw new Error('sync state: firstSeen is not a boolean')
  }
  if (!Array.isArray(state.syncedIds)) {
    throw new Error('sync state: syncedIds is not an array')
  }
  if (!Array.isArray(state.ownedIds)) {
    throw new Error('sync state: ownedIds is not an array')
  }
  if (!Array.isArray(state.workspaceKeys)) {
    throw new Error('sync state: workspaceKeys is not an array')
  }
  if (!isNonBlankString(state.host)) {
    throw new Error('sync state: host is not a string')
  }
  if (!isIsoInstant(state.updatedAt)) {
    throw new Error('sync state: updatedAt is not an ISO-8601 instant')
  }
  const ids = (value: unknown[], label: string): SessionId[] =>
    value.map(entry => {
      if (typeof entry !== 'string' || !SESSION_ID_PATTERN.test(entry)) {
        throw new Error(`sync state: invalid ${label} id ${JSON.stringify(entry)}`)
      }
      return SessionId(entry)
    })
  const workspaceKeys: WorkspaceKeyAssignment[] = state.workspaceKeys.map(raw => {
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
      throw new Error('sync state: workspace key entry is not a JSON object')
    }
    const assignment = raw as Partial<Record<keyof WorkspaceKeyAssignment, unknown>>
    if (!isNonBlankString(assignment.workspaceId)) {
      throw new Error('sync state: workspace key entry has no workspaceId')
    }
    if (!isNonBlankString(assignment.key)) {
      throw new Error('sync state: workspace key entry has no key')
    }
    return { workspaceId: assignment.workspaceId, key: assignment.key }
  })
  return {
    firstSeen: state.firstSeen,
    syncedIds: ids(state.syncedIds, 'synced'),
    ownedIds: ids(state.ownedIds, 'owned'),
    workspaceKeys,
    host: state.host,
    updatedAt: state.updatedAt,
  }
}

/** Serialize the machine-local synchronization anchor canonically. */
export function serializeState(state: SyncState): string {
  const unique = (values: readonly SessionId[]): string[] => [...new Set(values.map(String))].sort()
  return JSON.stringify({
    version: SYNC_STATE_VERSION,
    firstSeen: state.firstSeen,
    updatedAt: state.updatedAt,
    host: state.host,
    syncedIds: unique(state.syncedIds),
    ownedIds: unique(state.ownedIds),
    workspaceKeys: [...state.workspaceKeys]
      .map(entry => ({ workspaceId: entry.workspaceId, key: entry.key }))
      .sort((left, right) => left.workspaceId < right.workspaceId ? -1 : left.workspaceId > right.workspaceId ? 1 : 0),
  }) + '\n'
}

/**
 * Parse this machine's selection mirror. Machine-local and disposable: losing
 * it is safe (the next cycle adopts the repo's selection), but an unreadable
 * one rejects so the caller can report instead of silently dropping edits.
 * @param text - raw selection-mirror text.
 * @returns the decoded mirror.
 */
export function parseLocalSelection(text: string): LocalSelection {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    throw new Error('local selection: not valid JSON')
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error('local selection: not a JSON object')
  }
  const selection = parsed as Partial<{ version: unknown; sessionIds: unknown }>
  if (selection.version !== SYNC_LOCAL_SELECTION_VERSION) {
    throw new Error(`local selection: unsupported version ${String(selection.version)}`)
  }
  if (!Array.isArray(selection.sessionIds)) {
    throw new Error('local selection: sessionIds is not an array')
  }
  const sessionIds = selection.sessionIds.map(entry => {
    if (typeof entry !== 'string' || !SESSION_ID_PATTERN.test(entry)) {
      throw new Error(`local selection: invalid session id ${JSON.stringify(entry)}`)
    }
    return SessionId(entry)
  })
  return { sessionIds }
}

/** Serialize the machine-local selection mirror canonically: sorted and deduplicated. */
export function serializeLocalSelection(selection: LocalSelection): string {
  return JSON.stringify({
    version: SYNC_LOCAL_SELECTION_VERSION,
    sessionIds: [...new Set(selection.sessionIds.map(String))].sort(),
  }) + '\n'
}

/**
 * Decode artifact text to a buffer.
 * @param text - UTF-8 artifact text.
 * @returns the encoded bytes.
 */
export function encodeArtifact(text: string): Buffer {
  return Buffer.from(text, TEXT_ENCODING)
}

/**
 * Decode artifact bytes back to text.
 * @param buffer - UTF-8 artifact bytes.
 * @returns the decoded text.
 */
export function decodeArtifact(buffer: Buffer): string {
  return buffer.toString(TEXT_ENCODING)
}
