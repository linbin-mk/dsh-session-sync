/**
 * Configuration contract of the session-sync plugin: the live `session-sync`
 * profile entry's section — the git remote, branch, sync cadence, and the
 * periodic git-space cleanup that truncates the shared history to the newest
 * commits — plus the cross-field validation a schema cannot express.
 *
 * There is no mapping field in v2. What synchronizes is the explicit session
 * selection the user builds from the session row's "..." menu, and an imported
 * session lands in the local workspace whose title matches the repo
 * workspace's `manifest.json` name. Machines therefore carry no per-project
 * configuration at all.
 *
 * The section is the plugin's Cordis Config, so it arrives as the Loader
 * row's config and every editable field is a `.volatile()` reference: the
 * harness commits a live edit into these references and the settings page
 * addresses the entry by its id (`session-sync`), which is exported here as
 * {@link SESSION_SYNC_NAMESPACE}.
 * @module @linbin-mk/dsh-session-sync/settings
 */

import type { Volatile } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'

/** Profile entry id of the host row, and the settings namespace the browser half addresses. */
export const SESSION_SYNC_NAMESPACE = 'session-sync'

/** Default interval between automatic sync cycles, in minutes. */
export const DEFAULT_INTERVAL_MINUTES = 5

/** Default remote branch the repo pushes to and pulls from. */
export const DEFAULT_BRANCH = 'main'

/** Default period between automatic git-space cleanups, in hours. */
export const DEFAULT_CLEANUP_PERIOD_HOURS = 24

/** Default number of newest commits the rewritten history keeps. */
export const DEFAULT_CLEANUP_KEEP_COMMITS = 200

/** Default delay between startup and the first automatic cycle (lets cold loads settle). */
export const DEFAULT_STARTUP_SYNC_DELAY_MS = 3_000

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

/** Resolved settings value for the `session-sync` profile entry. */
export interface SessionSyncSettings {
  /** Master switch; a disabled plugin never touches git or the repo. */
  enabled: boolean
  /** Git remote URL (SSH); required once `enabled`. */
  remote: string
  /** Remote branch to synchronize. */
  branch: string
  /** Automatic sync cadence in minutes (minimum 1). */
  intervalMinutes: number
  /** Periodic git-space cleanup. */
  cleanup: SessionSyncCleanupSettings
}

/**
 * Plugin configuration. The settings section is live — the plugin re-reads it
 * for every cycle and every settings write commits into these references —
 * while the startup delay is a deployment choice fixed by the composition.
 */
export interface Config {
  /** Milliseconds after startup before the first automatic cycle. */
  startupSyncDelayMs: number
  /** Master switch; a disabled plugin never touches git or the repo. */
  enabled: Volatile<boolean>
  /** Git remote URL (SSH); required once `enabled`. */
  remote: Volatile<string>
  /** Remote branch to synchronize. */
  branch: Volatile<string>
  /** Automatic sync cadence in minutes (minimum 1). */
  intervalMinutes: Volatile<number>
  /** Periodic git-space cleanup. */
  cleanup: Volatile<SessionSyncCleanupSettings>
}

/**
 * Raw configuration a composition supplies: live fields take ordinary values
 * and every field may be absent (defaults fill it).
 */
export interface ConfigInput {
  /** Milliseconds after startup before the first automatic cycle. */
  startupSyncDelayMs?: number
  /** Master switch; a disabled plugin never touches git or the repo. */
  enabled?: boolean
  /** Git remote URL (SSH); required once `enabled`. */
  remote?: string
  /** Remote branch to synchronize. */
  branch?: string
  /** Automatic sync cadence in minutes (minimum 1). */
  intervalMinutes?: number
  /** Periodic git-space cleanup. */
  cleanup?: Partial<SessionSyncCleanupSettings>
}

/** Config schema. Every user-editable field is volatile; only they appear in settings forms. */
export const Config: z<ConfigInput, Config> = z.object({
  startupSyncDelayMs: z.number().step(1).min(0).default(DEFAULT_STARTUP_SYNC_DELAY_MS),
  enabled: z.boolean().default(false).volatile(),
  remote: z.string().default('').volatile(),
  branch: z.string().default(DEFAULT_BRANCH).volatile(),
  intervalMinutes: z.number().step(1).min(1).default(DEFAULT_INTERVAL_MINUTES).volatile(),
  cleanup: z.object({
    enabled: z.boolean().default(false),
    periodHours: z.number().step(1).min(1).default(DEFAULT_CLEANUP_PERIOD_HOURS),
    keepCommits: z.number().step(1).min(1).default(DEFAULT_CLEANUP_KEEP_COMMITS),
  }).default({ enabled: false, periodHours: DEFAULT_CLEANUP_PERIOD_HOURS, keepCommits: DEFAULT_CLEANUP_KEEP_COMMITS }).volatile(),
})

/**
 * Read the settings section out of a resolved configuration.
 * @param config - the plugin's resolved Cordis config.
 * @returns the section's ordinary values, detached from the live references.
 */
export function readSettings(config: Config): SessionSyncSettings {
  const cleanup = config.cleanup.get()
  return {
    enabled: config.enabled.get(),
    remote: config.remote.get(),
    branch: config.branch.get(),
    intervalMinutes: config.intervalMinutes.get(),
    cleanup: {
      enabled: cleanup.enabled,
      periodHours: cleanup.periodHours,
      keepCommits: cleanup.keepCommits,
    },
  }
}

/** Trimmed, non-empty form of a configured string; `undefined` when blank. */
function trimmed(value: string): string | undefined {
  const text = value.trim()
  return text.length === 0 ? undefined : text
}

/**
 * Cross-field validation the schema cannot express. Refusing the write keeps
 * a misconfigured section from being stored in the first place: an enabled
 * plugin without a remote would silently skip every cycle.
 * @param value - the schema-valid resolved section.
 */
export function validateSessionSyncSettings(value: SessionSyncSettings): void {
  if (value.enabled && trimmed(value.remote) === undefined) {
    throw new Error('session-sync: remote is required when the plugin is enabled')
  }
  if (trimmed(value.branch) === undefined) {
    throw new Error('session-sync: branch must not be blank')
  }
}
