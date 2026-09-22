/**
 * Portable repository format for session sync. The git worktree stores one
 * plaintext JSONL artifact per session under `projects/<key>/`. The first
 * line is this plugin's own versioned envelope; every remaining line is one
 * logical Session event. The envelope stores a portable project key instead
 * of a machine path. Machines replace it with their mapped local path on
 * import, so one repo serves hosts whose projects live at different absolute
 * paths and remains independent of a persistence backend's physical files.
 *
 * Layout:
 * ```text
 * manifest.json                    { "version": 1, "projects": ["demo", ...] }
 * projects/<key>/session-<id>.jsonl
 * projects/<key>/archived.json     { "version": 1, "sessionIds": ["session-...", ...] }
 * conflicts/<key>/<stem>-<host>.jsonl
 * ```
 *
 * An archived session is retired from git: the engine deletes its
 * `session-<id>.jsonl` (the local log is untouched) while its id stays in the
 * project's grow-only `archived.json`, which is how machines that still hold
 * the session learn to hide it. The artifact may therefore exist only
 * transiently for an archived id — until the archiving machine's next cycle.
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
export const SYNC_ARTIFACT_VERSION = 1

/** Manifest version this plugin writes and accepts. */
export const SYNC_MANIFEST_VERSION = 1

/** File name of the repo manifest. */
export const MANIFEST_NAME = 'manifest.json'

/** Repo directory holding per-project session artifacts. */
export const PROJECTS_DIR = 'projects'

/** Repo directory holding divergent-log copies (never imported). */
export const CONFLICTS_DIR = 'conflicts'

/** Archive-list version this plugin writes and accepts. */
export const SYNC_ARCHIVE_VERSION = 1

/** File name of one project's archived-session list inside its directory. */
export const ARCHIVE_NAME = 'archived.json'

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
  project: string
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
    throw new Error(`portable session artifact: unsupported artifact version ${String(line.version)}`)
  }
  if (typeof line.project !== 'string' || line.project.length === 0) {
    throw new Error('portable session artifact: project key is invalid')
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
 * @param key - portable project key stored in place of the local cwd.
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
    project: key,
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
 * directory — so the public persistence service creates it in the right
 * workspace. Event rows contain logical events; invalid envelopes, unknown
 * required event types, seq gaps, duplicates, or a broken tail reject the
 * whole artifact instead of importing a corrupt log.
 * @param text - raw artifact text (header line first).
 * @param path - local directory to stamp into the header.
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

/** Repo-relative path of one session artifact, `projects/<key>/<id>.jsonl`. */
export function sessionRepoPath(key: string, id: SessionId): string {
  return `${PROJECTS_DIR}/${encodeRepoSegment(key)}/${encodeRepoSegment(String(id))}.jsonl`
}

/** Repo-relative path of one conflict copy, `conflicts/<key>/<id>-<host>.jsonl`. */
export function conflictRepoPath(key: string, id: SessionId, host: string): string {
  return `${CONFLICTS_DIR}/${encodeRepoSegment(key)}/${encodeRepoSegment(String(id))}-${encodeRepoSegment(host)}.jsonl`
}

/** Repo-relative path of one project's archive list, `projects/<key>/archived.json`. */
export function archiveRepoPath(key: string): string {
  return `${PROJECTS_DIR}/${encodeRepoSegment(key)}/${ARCHIVE_NAME}`
}

/**
 * Decode the session id from a repo artifact file name (`<id>.jsonl`, with
 * `id` carrying its own `session-` prefix).
 * @param filename - the artifact's base name inside a project directory.
 * @returns the branded id, or `undefined` when the name does not carry one.
 */
export function sessionIdFromFilename(filename: string): SessionId | undefined {
  const match = /^(session-[A-Za-z0-9-]+)\.jsonl$/.exec(filename)
  if (match === null) return undefined
  const id = match[1]
  /* v8 ignore next -- the capture group always exists when the pattern matched */
  return id === undefined ? undefined : SessionId(id)
}

/** Serialize the repo manifest. */
export function serializeManifest(projects: readonly string[]): string {
  return JSON.stringify({ version: SYNC_MANIFEST_VERSION, projects: [...projects].sort() }) + '\n'
}

/**
 * Parse a project archive-list artifact into branded session ids. The list is
 * the repo's record of which project sessions were archived on any machine —
 * a grow-only set (the harness archive has no unarchive path), so readers
 * union it into their own registry set. Malformed shapes reject instead of
 * silently hiding sessions.
 * @param text - raw archive-list artifact text.
 * @returns the archived session ids in stored order.
 */
export function parseArchiveList(text: string): SessionId[] {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    throw new Error('project archive list: not valid JSON')
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error('project archive list: not a JSON object')
  }
  const list = parsed as Partial<{ version: unknown; sessionIds: unknown }>
  if (list.version !== SYNC_ARCHIVE_VERSION) {
    throw new Error(`project archive list: unsupported version ${String(list.version)}`)
  }
  if (!Array.isArray(list.sessionIds)) {
    throw new Error('project archive list: sessionIds is not an array')
  }
  const ids: SessionId[] = []
  for (const entry of list.sessionIds) {
    if (typeof entry !== 'string' || !SESSION_ID_PATTERN.test(entry)) {
      throw new Error(`project archive list: invalid session id ${JSON.stringify(entry)}`)
    }
    ids.push(SessionId(entry))
  }
  return ids
}

/** Serialize a project archive list canonically: sorted, deduplicated, versioned. */
export function serializeArchiveList(ids: readonly SessionId[]): string {
  const unique = [...new Set(ids.map(String))].sort()
  return JSON.stringify({ version: SYNC_ARCHIVE_VERSION, sessionIds: unique }) + '\n'
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
