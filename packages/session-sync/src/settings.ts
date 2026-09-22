/**
 * Settings contract of the session-sync plugin: the `session-sync` namespace
 * schema, resolved value type, and the cross-field validation a schema cannot
 * express. The namespace is the plugin's complete durable configuration —
 * the git remote, branch, sync cadence, the project-key-to-local-path
 * mappings that decide which projects export and which imported sessions are
 * admitted into this machine's DSH, and the periodic git-space cleanup that
 * truncates the shared history to the newest commits.
 * @module @linbin-mk/dsh-session-sync/settings
 */

import z from '@deepseek-ai/schemastery'

/** Settings namespace registered by the session-sync service. */
export const SESSION_SYNC_NAMESPACE = 'session-sync'

/** Default interval between automatic sync cycles, in minutes. */
export const DEFAULT_INTERVAL_MINUTES = 5

/** Default remote branch the repo pushes to and pulls from. */
export const DEFAULT_BRANCH = 'main'

/** Default period between automatic git-space cleanups, in hours. */
export const DEFAULT_CLEANUP_PERIOD_HOURS = 24

/** Default number of newest commits the rewritten history keeps. */
export const DEFAULT_CLEANUP_KEEP_COMMITS = 200

/** One project relationship: the portable key used in the git repo and the machine-local directory. */
export interface SessionSyncMapping {
  /** Portable project identity inside the git repo (`projects/<key>/...`). */
  key: string
  /** Local directory whose sessions export under `key` and receive imports for it. */
  path: string
}

/**
 * Git-space cleanup contract. Git never forgets: a deleted session file only
 * stops consuming space once the history that carried it is rewritten. The
 * periodic cleanup truncates the shared repo history to the newest
 * `keepCommits` commits and force-pushes, so every commit dropped from the
 * window also drops its blobs from the repository (other machines re-sync
 * from the rewritten history on their next cycle).
 */
export interface SessionSyncCleanupSettings {
  /** Master switch for the periodic history truncation. */
  enabled: boolean
  /** Period between automatic cleanups, in hours (minimum 1). */
  periodHours: number
  /** Number of newest commits the rewritten history keeps (minimum 1). */
  keepCommits: number
}

/** Resolved settings value for the `session-sync` namespace. */
export interface SessionSyncSettings {
  /** Master switch; a disabled plugin never touches git or the repo. */
  enabled: boolean
  /** Git remote URL (SSH); required once `enabled`. */
  remote: string
  /** Remote branch to synchronize. */
  branch: string
  /** Automatic sync cadence in minutes (minimum 1). */
  intervalMinutes: number
  /** Project relationships: the sync whitelist in both directions. */
  mappings: SessionSyncMapping[]
  /** Periodic git-space cleanup. */
  cleanup: SessionSyncCleanupSettings
}

/** Schema for the `session-sync` settings namespace. */
export const SessionSyncSettingsSchema: z<SessionSyncSettings> = z.object({
  enabled: z.boolean().default(false),
  remote: z.string().default(''),
  branch: z.string().default(DEFAULT_BRANCH),
  intervalMinutes: z.number().step(1).min(1).default(DEFAULT_INTERVAL_MINUTES),
  mappings: z.array(z.object({
    key: z.string(),
    path: z.string(),
  })).default([]),
  cleanup: z.object({
    enabled: z.boolean().default(false),
    periodHours: z.number().step(1).min(1).default(DEFAULT_CLEANUP_PERIOD_HOURS),
    keepCommits: z.number().step(1).min(1).default(DEFAULT_CLEANUP_KEEP_COMMITS),
  }).default({ enabled: false, periodHours: DEFAULT_CLEANUP_PERIOD_HOURS, keepCommits: DEFAULT_CLEANUP_KEEP_COMMITS }),
})

/** Trimmed, non-empty form of a mapping key or path; `undefined` when blank. */
function trimmed(value: string): string | undefined {
  const text = value.trim()
  return text.length === 0 ? undefined : text
}

/** First duplicate value in `values`, or `undefined` when all are distinct. */
function firstDuplicate(values: readonly string[]): string | undefined {
  const seen = new Set<string>()
  for (const value of values) {
    if (seen.has(value)) return value
    seen.add(value)
  }
  return undefined
}

/**
 * Cross-field validation the schema cannot express. Refusing the write keeps
 * a misconfigured section from being stored in the first place: an enabled
 * plugin without a remote would silently skip every cycle, and mapping keys
 * or paths that collide would let one relationship shadow another.
 * @param value - the schema-valid resolved section.
 */
export function validateSessionSyncSettings(value: SessionSyncSettings): void {
  if (value.enabled && trimmed(value.remote) === undefined) {
    throw new Error('session-sync: remote is required when the plugin is enabled')
  }
  if (trimmed(value.branch) === undefined) {
    throw new Error('session-sync: branch must not be blank')
  }
  const keys = value.mappings.map(mapping => trimmed(mapping.key))
  const paths = value.mappings.map(mapping => trimmed(mapping.path))
  const blankKey = keys.findIndex(key => key === undefined)
  if (blankKey !== -1) {
    throw new Error(`session-sync: mappings[${blankKey}].key must not be blank`)
  }
  const blankPath = paths.findIndex(path => path === undefined)
  if (blankPath !== -1) {
    throw new Error(`session-sync: mappings[${blankPath}].path must not be blank`)
  }
  const duplicateKey = firstDuplicate(keys as string[])
  if (duplicateKey !== undefined) {
    throw new Error(`session-sync: duplicate mapping key "${duplicateKey}"`)
  }
  const duplicatePath = firstDuplicate(paths as string[])
  if (duplicatePath !== undefined) {
    throw new Error(`session-sync: duplicate mapping path "${duplicatePath}"`)
  }
}
