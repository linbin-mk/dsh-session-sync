/**
 * Session sync service (`ctx.sessionSync`): keeps this machine's sessions
 * for the mapped projects in a git repo and imports the other machines'
 * sessions from it, including each project's archived-session marks (a
 * session archived on one machine is hidden on every machine). An archived
 * session is retired from git — its repo artifact is deleted so archived
 * sessions stop consuming repo space — while only the grow-only mark in
 * `archived.json` keeps travelling. Configuration is the `session-sync`
 * profile entry's live Config (remote, branch, cadence, project mappings);
 * the worktree lives under `<harness home>/session-sync/repo`. Automatic cycles run on a timer
 * driven by `intervalMinutes`, once shortly after startup, and on demand via
 * `syncNow()` (the web settings page's button). Every cycle is contained:
 * session-level failures are reported on the status view, and only git
 * failures reject the call. Imported sessions bypass the live session store,
 * so the engine pre-warms the harness projection cache (when composed) after
 * every import — list rows then carry their title and other projection values
 * immediately instead of only after the session is opened. After a successful cycle the
 * `session-sync/completed` event publishes the outcome so transports can
 * refresh the client's session list. When the composition mounts a
 * `webServer`, the plugin also registers its own same-origin HTTP API
 * (`/session-sync/*`, see {@link ./routes.ts}) for the browser settings
 * page — no harness core package needs modification.
 *
 * Switch notice: every cycle that imports foreign events into a session arms
 * a one-shot mark for that session (persisted under the harness home, so a
 * restart keeps it). A `agent/pre-step` listener then folds this package's
 * `notice` message into the first user chat of a marked session — the first
 * chat after the machine switch — telling the model that the history came
 * from another machine and the local working directory is authoritative.
 * The mark is consumed on injection, so the same machine never injects
 * twice; the notice itself is a durable event that travels with the log, and
 * the next machine switch arms its own notice for its own first chat.
 *
 * Git-space cleanup: git never forgets deleted files — archived-session
 * artifacts stop occupying repo space only once the history carrying them is
 * rewritten. The optional cleanup truncates the shared history to the newest
 * `keepCommits` commits every `periodHours` hours (checked after each cycle,
 * so the sync cadence is the granularity) and right after a manual
 * `cleanupNow()` from the settings page. A synthetic-free rewrite replays
 * the kept commits onto a new root, so the newest tree — every current file
 * — is preserved exactly; other machines re-sync from the rewritten history
 * on their next cycle.
 * @module @linbin-mk/dsh-session-sync
 */

import { Service } from '@deepseek-ai/cordis'
import type { Context, Fiber } from '@deepseek-ai/cordis'
import type { PreStepDecision } from '@deepseek-ai/dsh-agent'
import z from '@deepseek-ai/schemastery'
import { mkdir, readFile, readdir, unlink, writeFile } from 'node:fs/promises'
import { hostname } from 'node:os'
import { dirname, join } from 'node:path'
import { dshHomePath } from '@deepseek-ai/dsh-home-paths'
// Type-only: applies the `ctx.settings` Context merge.
import type {} from '@deepseek-ai/dsh-settings'
// Type-only: applies the Loader's `loader/volatile-update` event merge.
import type {} from '@deepseek-ai/cordis-plugin-loader'
// Type-only: applies the `ctx.sessionPersistence` Context merge.
import type {} from '@deepseek-ai/dsh-session-persistence'
// Type-only: applies the `ctx.workspaceRegistry` Context merge.
import type {} from '@deepseek-ai/dsh-workspace'
// Type-only: applies the `ctx.sessionProjectionCache` Context merge.
import type {} from '@deepseek-ai/dsh-session-projection-cache'
import { runSyncCycle } from './engine.ts'
import type { SyncEngineDeps, SyncFilesystem, SyncPersistence, SyncProjectionCache, SyncWorkspaceRegistry } from './engine.ts'
import { GitRepository } from './git.ts'
import { SyncLog } from './log.ts'
import type { SyncLogEntry } from './log.ts'
import {
  Config, DEFAULT_STARTUP_SYNC_DELAY_MS, SESSION_SYNC_NAMESPACE, readSettings, validateSessionSyncSettings,
} from './settings.ts'
import type { ConfigInput, SessionSyncSettings } from './settings.ts'
import { withSwitchNotice } from './switch-notice.ts'
import { registerSessionSyncRoutes } from './routes.ts'
import type { SessionSyncWebServer } from './routes.ts'

export {
  Config, DEFAULT_BRANCH, DEFAULT_CLEANUP_KEEP_COMMITS, DEFAULT_CLEANUP_PERIOD_HOURS,
  DEFAULT_INTERVAL_MINUTES, DEFAULT_STARTUP_SYNC_DELAY_MS,
  SESSION_SYNC_NAMESPACE, readSettings, validateSessionSyncSettings,
} from './settings.ts'
export type { ConfigInput, SessionSyncCleanupSettings, SessionSyncMapping, SessionSyncSettings } from './settings.ts'
export { compareLogs, runSyncCycle } from './engine.ts'
export type {
  LogRelation, SyncEngineDeps, SyncFilesystem, SyncGit, SyncPersistence,
  SyncProjectionCache, SyncRunResult, SyncWorkspace, SyncWorkspaceRegistry,
} from './engine.ts'
export { DEFAULT_GIT_RETRY, GitError, GitRepository } from './git.ts'
export type { GitRetryPolicy } from './git.ts'
export { SYNC_LOG_RETENTION_DAYS, SyncLog } from './log.ts'
export type { SyncLogEntry, SyncLogKind } from './log.ts'
export { CLEANUP_NOW_PATH, LOGS_PATH, STATUS_PATH, SYNC_NOW_PATH, SETTINGS_PATH, registerSessionSyncRoutes } from './routes.ts'
export type { SessionSyncWebServer, SessionSyncRoutesService } from './routes.ts'
export { isSettingsPatch } from './api.ts'
export type { SessionSyncLogsView, SessionSyncSettingsView, SessionSyncStatusView, SessionSyncErrorView } from './api.ts'
export {
  SWITCH_NOTICE_PLUGIN, SWITCH_NOTICE_SUMMARY, SWITCH_NOTICE_TEXT,
  createSwitchNoticeMessage, withSwitchNotice,
} from './switch-notice.ts'
export type { SwitchNoticeDecision } from './switch-notice.ts'

/** Payload of the `session-sync/completed` event. */
export interface SessionSyncCompleted {
  /** Sessions imported (created or extended) by the completed cycle. */
  imported: number
  /** Sessions whose repo artifact the completed cycle updated. */
  pushed: number
  /** Sessions this machine newly marked archived from the repo's archive lists. */
  archived: number
  /** Archived sessions' repo artifacts deleted by the completed cycle. */
  deleted: number
  /** Repo-relative conflict-copy paths written by the completed cycle. */
  conflicts: string[]
  /** ISO-8601 instant the cycle finished. */
  lastSyncAt: string
}

declare module '@deepseek-ai/cordis' {
  interface Events {
    'session-sync/completed'(completed: SessionSyncCompleted): void
  }

  interface Context {
    sessionSync: SessionSyncService
  }
}

/** Error message from any thrown value. */
function messageOf(error: unknown): string {
  /* v8 ignore next 2 -- cycle failures are always Error instances (git and engine both throw them); the fallback guards foreign throws */
  if (!(error instanceof Error)) return String(error)
  return error.message
}

/** Whether a settings value holds an enabled plugin with a remote. */
function configuredSettings(settings: SessionSyncSettings): boolean {
  return settings.enabled && settings.remote.trim().length > 0
}

/** Whether a value is a plain data object the settings document merges field by field. */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const proto: unknown = Object.getPrototypeOf(value)
  return proto === Object.prototype || proto === null
}

/** Layer `over` onto `under` the way the settings document does: plain objects merge, every other value replaces. */
function mergeLayers(under: unknown, over: unknown): unknown {
  if (!isPlainObject(under) || !isPlainObject(over)) return over
  const merged: Record<string, unknown> = { ...under }
  for (const [key, value] of Object.entries(over)) merged[key] = mergeLayers(merged[key], value)
  return merged
}

/**
 * The service. Reads its live configuration from the `session-sync` profile
 * entry's Config, reschedules the automatic timer on every committed config
 * change, and serializes cycles through a single in-flight promise so a timer
 * tick and a manual request can never interleave two git sessions.
 */
export class SessionSyncService extends Service {
  static inject = ['settings', 'sessionPersistence']

  static Config: z<ConfigInput, Config> = Config

  private timer: ReturnType<typeof setInterval> | undefined
  private inflight: Promise<void> | undefined
  /** In-flight git-space cleanup pass; cycles skip their due check while one runs. */
  private cleanupInflight: Promise<number> | undefined
  private repoReady = false
  private lastSyncAt: string | undefined
  private lastError: string | undefined
  private lastErrorAt: string | undefined
  private lastRun: import('./api.ts').SessionSyncStatusView['lastRun'] = { imported: 0, pushed: 0, archived: 0, deleted: 0, conflicts: [] }
  /** Epoch ms of the last completed cleanup pass (drives the period check). */
  private lastCleanupAt: number | undefined
  /** Outcome of the last completed cleanup pass. */
  private lastCleanup: { at: string; dropped: number } | undefined
  /** Message of the last cleanup failure, when one occurred. */
  private cleanupError: string | undefined
  /** ISO-8601 instant the last cleanup failure occurred, when one did. */
  private cleanupErrorAt: string | undefined
  /**
   * This machine's session-sync directory under the harness home, resolved
   * once: the repository, the switch-notice marks, and the cycle log all live
   * under it, and a running service keeps the home it started in.
   */
  private readonly home = dshHomePath('session-sync')
  /** The cycle log (per-day JSONL under the harness home, 3-day window). */
  private readonly syncLog = new SyncLog(join(this.home, 'logs'))
  /** Session ids this machine imported and has not noticed yet (switch-notice marks). */
  private readonly pendingSwitchNotices = new Set<string>()
  /** Lazy one-time load of the persisted marks file (awaited before the first review). */
  private marksLoaded: Promise<void> | undefined
  /** Serialized marks persistence so concurrent writes cannot interleave. */
  private marksWrite: Promise<void> = Promise.resolve()

  /** @param ctx - plugin context. */
  constructor(ctx: Context, public config: Config) {
    super(ctx, 'sessionSync')
  }

  /** Validate the resolved config, arm the timer plus startup pull, and serve the web API when a web server exists. */
  protected [Service.init](): void {
    const fiber = this.ctx.fiber
    // A stored section the schema accepts but these rules reject fails the
    // plugin at load, the way the removed namespace registration did.
    validateSessionSyncSettings(this.getSettings())
    // This plugin ships its own settings page; suppress the generated one.
    this.ctx.effect(() => this.ctx.settings.configure({ auto: false }, fiber), 'sessionSync.settingsPage')
    // The browser page reaches status, manual actions, and the cycle log over
    // this plugin's own routes. `inject` waits for the optional web server, so
    // a composition that mounts one after this row still gets them; a headless
    // composition simply never runs the callback.
    this.ctx.inject(['webServer'], (child) => {
      const webServer = child.get('webServer') as SessionSyncWebServer | undefined
      /* v8 ignore next -- the injected fiber is created only while the service is available */
      if (webServer === undefined) return
      child.effect(() => registerSessionSyncRoutes(webServer, this), 'sessionSync.webApi')
    })
    // Switch notice: review every pre-step for the first real user chat of a
    // session this machine imported. The listener is disposed with the context.
    this.ctx.on('agent/pre-step', async ({ agent, messages, signal }, next): Promise<PreStepDecision> => {
      const decision = await next()
      if (decision.kind === 'reject' || signal.aborted) return decision
      await this.marksReady()
      const reviewed = withSwitchNotice(this.pendingSwitchNotices, agent, messages, decision)
      if (reviewed.consumed) {
        this.pendingSwitchNotices.delete(String(agent.session.id))
        await this.persistSwitchMarks()
      }
      return reviewed.decision
    })
    // The Loader commits a live edit into the Config references without
    // remounting this plugin; the recomputed section re-arms the timer.
    this.ctx.on('loader/volatile-update', () => { this.reschedule(this.getSettings()) })
    // Every write path (the settings page, the profile document, the legacy
    // settings.yaml import) resolves the candidate config before persisting
    // it; the rules a schema cannot express are enforced here, so a refused
    // write never reaches the profile document.
    this.ctx.on('internal/config', function (this: Fiber, _raw: unknown, next: () => unknown): unknown {
      const candidate = next()
      if (this !== fiber) return candidate
      validateSessionSyncSettings(readSettings(Config(candidate as never)))
      return candidate
    })
    this.ctx.effect(() => {
      // Enforce the log retention window once at startup; later accesses re-prune.
      void this.syncLog.prune().catch(error => {
        /* v8 ignore next -- real prune faults warn and leave the window to the next access */
        this.ctx.logger.warn(`session sync: log prune failed: ${messageOf(error)}`)
      })
      this.reschedule(this.getSettings())
      const startup = setTimeout(() => {
        if (configuredSettings(this.getSettings())) this.launchIfIdle()
      }, this.config.startupSyncDelayMs)
      return () => {
        clearInterval(this.timer)
        clearTimeout(startup)
      }
    }, 'sessionSync.lifecycle')
  }

  /** Whether the mounted settings provider accepts writes (web API surface). */
  get settingsWritable(): boolean {
    return this.ctx.settings.writable
  }

  /** The resolved settings section (web API surface). */
  getSettings(): SessionSyncSettings {
    return readSettings(this.config)
  }

  /** Merge one plain-object patch into the settings section; the host re-validates and a refused write rejects (web API surface). */
  async updateSettings(patch: object): Promise<void> {
    // Schema first (types, ranges, defaults), then the cross-field rules, so a
    // malformed patch is refused with the schema's own message.
    const merged = mergeLayers(this.getSettings(), patch)
    validateSessionSyncSettings(readSettings(Config(merged as never)))
    await this.ctx.settings.update(SESSION_SYNC_NAMESPACE, patch)
  }

  /** Current status view (no I/O). */
  status(): import('./api.ts').SessionSyncStatusView {
    const settings = this.getSettings()
    return {
      configured: configuredSettings(settings),
      repoReady: this.repoReady,
      running: this.inflight !== undefined,
      ...this.lastSyncAt !== undefined ? { lastSyncAt: this.lastSyncAt } : {},
      ...this.lastError !== undefined ? { lastError: this.lastError } : {},
      ...this.lastErrorAt !== undefined ? { lastErrorAt: this.lastErrorAt } : {},
      lastRun: { ...this.lastRun, conflicts: [...this.lastRun.conflicts] },
      ...this.lastCleanup !== undefined ? { lastCleanup: { ...this.lastCleanup } } : {},
      ...this.cleanupError !== undefined ? { cleanupError: this.cleanupError } : {},
      ...this.cleanupErrorAt !== undefined ? { cleanupErrorAt: this.cleanupErrorAt } : {},
    }
  }

  /**
   * Recent cycle-log records, newest first. Reading prunes the retention
   * window, so expired days never contribute records.
   * @param limit - maximum record count (web API surface).
   */
  async logs(limit = 200): Promise<SyncLogEntry[]> {
    return this.syncLog.read(limit)
  }

  /**
   * Run one cycle on demand. A cycle already in flight is awaited, not
   * duplicated; an unconfigured plugin records the reason on the status view
   * instead of running.
   * @returns the status view after the cycle settles.
   */
  async syncNow(): Promise<import('./api.ts').SessionSyncStatusView> {
    if (!configuredSettings(this.getSettings())) {
      this.lastError = 'session sync is disabled or has no configured remote'
      this.lastErrorAt = new Date().toISOString()
      await this.logEntry({ time: this.lastErrorAt, kind: 'failure', error: this.lastError })
      return this.status()
    }
    this.launchIfIdle()
    await this.inflight
    return this.status()
  }

  /**
   * Run one git-space cleanup pass on demand, answering the fresh status
   * view. A sync cycle in flight is awaited first (both drive the same
   * worktree); an unconfigured plugin records the reason instead of running.
   * @returns the status view after the pass settles.
   */
  async cleanupNow(): Promise<import('./api.ts').SessionSyncStatusView> {
    if (!configuredSettings(this.getSettings())) {
      this.cleanupError = 'session sync is disabled or has no configured remote'
      this.cleanupErrorAt = new Date().toISOString()
      await this.logEntry({ time: this.cleanupErrorAt, kind: 'failure', error: `git-space cleanup failed: ${this.cleanupError}` })
      return this.status()
    }
    if (this.inflight !== undefined) await this.inflight
    await this.runCleanupPass()
    return this.status()
  }

  /** Re-arm the automatic timer from the current settings. */
  private reschedule(settings: SessionSyncSettings): void {
    clearInterval(this.timer)
    this.timer = undefined
    if (!configuredSettings(settings)) return
    this.timer = setInterval(() => { this.launchIfIdle() }, settings.intervalMinutes * 60_000)
  }

  /**
   * Run the periodic git-space cleanup when enabled and due. Called after
   * every completed cycle, so the sync cadence is the check granularity; a
   * cleanup pass already in flight is skipped (the next cycle re-checks).
   * @param settings - the resolved settings of the just-finished cycle.
   * @returns the number of commits the pass dropped (0 when it skipped or dropped nothing).
   */
  private async cleanupIfDue(settings: SessionSyncSettings): Promise<number> {
    if (!settings.cleanup.enabled) return 0
    /* v8 ignore next -- a pass in flight settles into the same fields; the next cycle's check observes them */
    if (this.cleanupInflight !== undefined) return 0
    const now = Date.now()
    if (this.lastCleanupAt !== undefined && now - this.lastCleanupAt < settings.cleanup.periodHours * 3_600_000) return 0
    return this.runCleanupPass()
  }

  /**
   * Serialized cleanup entry: concurrent requests (manual button, cycle-end
   * checks) share the single in-flight pass instead of racing on the
   * worktree.
   * @returns the number of commits the pass dropped.
   */
  private runCleanupPass(): Promise<number> {
    if (this.cleanupInflight !== undefined) return this.cleanupInflight
    const promise = this.cleanupPass()
    this.cleanupInflight = promise
    void promise.finally(() => {
      /* v8 ignore next -- a new pass cannot replace an unsettled one: callers share the in-flight promise */
      if (this.cleanupInflight === promise) this.cleanupInflight = undefined
    })
    return promise
  }

  /**
   * One cleanup pass: truncate the local history to the configured commit
   * budget, force-push when commits were dropped, and record the outcome on
   * the status view. Failures are contained — a sync already succeeded, and
   * a failed cleanup retries on the next due check — so the pass never
   * rejects.
   * @returns the number of commits dropped (0 when within budget or failed).
   */
  private async cleanupPass(): Promise<number> {
    const settings = this.getSettings()
    const repository = new GitRepository(this.repoDir())
    const startedAt = Date.now()
    try {
      await repository.ensure(settings.remote, settings.branch)
      const dropped = await repository.truncateHistory(settings.cleanup.keepCommits)
      if (dropped > 0) await repository.pushForce(settings.branch)
      const at = new Date().toISOString()
      this.lastCleanupAt = Date.now()
      this.lastCleanup = { at, dropped }
      this.cleanupError = undefined
      this.cleanupErrorAt = undefined
      if (dropped > 0) this.ctx.logger.info(`session sync: git-space cleanup dropped ${dropped} commit(s)`)
      return dropped
    } catch (error) {
      const at = new Date().toISOString()
      this.cleanupError = messageOf(error)
      this.cleanupErrorAt = at
      this.ctx.logger.warn(`session sync: git-space cleanup failed: ${this.cleanupError}`)
      await this.logEntry({
        time: at,
        kind: 'failure',
        durationMs: Date.now() - startedAt,
        error: `git-space cleanup failed: ${this.cleanupError}`,
      })
      return 0
    }
  }

  /** Marks file under the harness home (same directory as the repo worktree). */
  private switchMarksPath(): string {
    return join(this.home, 'switch-notices.json')
  }

  /** Await the lazily-started marks load (one small file read at boot). */
  private marksReady(): Promise<void> {
    if (this.marksLoaded === undefined) this.marksLoaded = this.loadSwitchMarks()
    return this.marksLoaded
  }

  /** Load persisted switch-notice marks; a missing or broken file leaves the set empty (fail-soft). */
  private async loadSwitchMarks(): Promise<void> {
    try {
      const parsed: unknown = JSON.parse(await readFile(this.switchMarksPath(), 'utf8'))
      const ids = (parsed as { sessionIds?: unknown }).sessionIds
      if (!Array.isArray(ids)) throw new Error('switch-notices file: sessionIds is not an array')
      for (const id of ids) {
        if (typeof id === 'string' && id.length > 0) this.pendingSwitchNotices.add(id)
      }
    } catch (error) {
      /* v8 ignore next 2 -- a missing file is the common healthy case; only real faults warn */
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        this.ctx.logger.warn(`session sync: failed to load switch notices: ${messageOf(error)}`)
      }
    }
  }

  /** Persist the pending-notice set, serializing concurrent writes (fail-soft). */
  private persistSwitchMarks(): Promise<void> {
    const path = this.switchMarksPath()
    const snapshot = JSON.stringify({ sessionIds: [...this.pendingSwitchNotices].sort() }) + '\n'
    this.marksWrite = this.marksWrite.then(async () => {
      try {
        await mkdir(dirname(path), { recursive: true })
        await writeFile(path, snapshot, 'utf8')
      } catch (error) {
        /* v8 ignore next -- real filesystem faults warn and leave the mark in memory only */
        this.ctx.logger.warn(`session sync: failed to persist switch notices: ${messageOf(error)}`)
      }
    })
    return this.marksWrite
  }

  /** Launch a cycle unless one is already in flight (timer, startup, and manual entry share this guard). */
  private launchIfIdle(): void {
    if (this.inflight === undefined) this.startCycle()
  }

  /** Begin one cycle, tracking its promise and settlement. */
  private startCycle(): void {
    const promise = this.cycle()
    this.inflight = promise
    void promise.finally(() => {
      /* v8 ignore next -- a new cycle cannot replace an unsettled in-flight promise: launch guards on it */
      if (this.inflight === promise) this.inflight = undefined
    })
  }

  /** One contained cycle: engine over real services, status update, event emission. */
  private async cycle(): Promise<void> {
    const settings = this.getSettings()
    /* v8 ignore next 2 -- every launch path checks the settings first; the guard backs launchIfIdle against misuse */
    if (!configuredSettings(settings)) return
    const startedAt = Date.now()
    await this.logEntry({ time: new Date().toISOString(), kind: 'start' })

    const repository = new GitRepository(this.repoDir())
    const workspacePort = this.workspacePort()
    const projectionCachePort = this.projectionCachePort()
    const deps: SyncEngineDeps = {
      settings,
      persistence: this.persistencePort(),
      ...workspacePort === undefined ? {} : { workspaces: workspacePort },
      ...projectionCachePort === undefined ? {} : { projectionCache: projectionCachePort },
      fs: new RepoFilesystem(this.repoDir()),
      git: {
        ensure: () => repository.ensure(settings.remote, settings.branch),
        fetch: () => repository.fetch(settings.branch),
        resetHard: () => repository.resetHard(),
        addAll: () => repository.addAll(),
        commit: message => repository.commit(message),
        push: () => repository.push(settings.branch),
      },
      logger: this.ctx.logger,
    }
    try {
      const result = await runSyncCycle(deps)
      const finishedAt = new Date().toISOString()
      this.repoReady = true
      this.lastSyncAt = finishedAt
      this.lastError = undefined
      this.lastErrorAt = undefined
      this.lastRun = { imported: result.imported, pushed: result.pushed, archived: result.archived, deleted: result.deleted, conflicts: result.conflicts }
      // The periodic cleanup rides on the successful cycle: the worktree is
      // clean and freshly pushed, so the rewrite starts from the remote state.
      const cleanupDropped = await this.cleanupIfDue(settings)
      await this.logEntry({
        time: finishedAt,
        kind: 'success',
        durationMs: Date.now() - startedAt,
        imported: result.imported,
        pushed: result.pushed,
        archived: result.archived,
        deleted: result.deleted,
        conflicts: result.conflicts,
        ...result.errors.length > 0 ? { errors: result.errors } : {},
        ...cleanupDropped > 0 ? { cleanupDropped } : {},
      })
      if (result.importedIds.length > 0) {
        for (const id of result.importedIds) this.pendingSwitchNotices.add(id)
        await this.persistSwitchMarks()
      }
      this.ctx.emit('session-sync/completed', {
        imported: result.imported,
        pushed: result.pushed,
        archived: result.archived,
        deleted: result.deleted,
        conflicts: result.conflicts,
        lastSyncAt: this.lastSyncAt,
      })
      if (result.errors.length > 0) {
        this.ctx.logger.warn(`session sync: cycle completed with ${result.errors.length} contained failure(s)`)
      }
    } catch (error) {
      const failedAt = new Date().toISOString()
      this.lastError = messageOf(error)
      this.lastErrorAt = failedAt
      this.repoReady = await repository.exists()
      this.ctx.logger.warn(`session sync: cycle failed: ${this.lastError}`)
      await this.logEntry({ time: failedAt, kind: 'failure', durationMs: Date.now() - startedAt, error: this.lastError })
    }
  }

  /** Append one record to the cycle log (fail-soft: logging never fails a cycle). */
  private async logEntry(entry: SyncLogEntry): Promise<void> {
    try {
      await this.syncLog.append(entry)
    } catch (error) {
      /* v8 ignore next -- real append faults warn and drop the record */
      this.ctx.logger.warn(`session sync: log append failed: ${messageOf(error)}`)
    }
  }

  /** Worktree directory under the harness home. */
  private repoDir(): string {
    return join(this.home, 'repo')
  }

  /** Persistence port over `ctx.sessionPersistence`. */
  private persistencePort(): SyncPersistence {
    const persistence = this.ctx.sessionPersistence
    return {
      inspect: async (id) => {
        if (await persistence.stat(id) === undefined) return undefined
        const handle = await persistence.open(id, 'read')
        try {
          const { events } = await handle.read()
          return {
            meta: handle.header,
            inheritedEventCount: handle.inheritedEventCount,
            events: [...events],
          }
        } finally {
          await handle.close()
        }
      },
      create: async (session) => {
        const handle = await persistence.create(session.meta, {
          inheritedEventCount: session.inheritedEventCount,
        })
        try {
          if (session.events.length > 0) await handle.append(session.events)
          await handle.flush()
        } finally {
          await handle.close()
        }
      },
      append: async (id, events) => {
        const handle = await persistence.open(id, 'write')
        try {
          await handle.append(events)
          await handle.flush()
        } finally {
          await handle.close()
        }
      },
      list: async () => (await persistence.list()).map(snapshot => snapshot.header),
    }
  }

  /** Workspace registry port; `undefined` when the composition mounts none. */
  private workspacePort(): SyncWorkspaceRegistry | undefined {
    const registry = this.ctx.get('workspaceRegistry')
    if (registry === undefined) return undefined
    return {
      resolveByPath: path => registry.resolveByPath(path),
      create: (path, title) => registry.create(path, title),
      archivedSessionIds: () => registry.archivedSessionIds,
      archiveSession: id => registry.archiveSession(id),
    }
  }

  /** Projection-cache port; `undefined` when the composition mounts none. */
  private projectionCachePort(): SyncProjectionCache | undefined {
    const cache = this.ctx.get('sessionProjectionCache')
    if (cache === undefined) return undefined
    const persistence = this.ctx.sessionPersistence
    return {
      warm: async (id) => {
        const handle = await persistence.open(id, 'read')
        try {
          const { events } = await handle.read()
          cache.coldSnapshot(handle.header, handle.inheritedEventCount, events)
        } finally {
          await handle.close()
        }
      },
    }
  }
}

/** Filesystem port over the repo worktree. */
class RepoFilesystem implements SyncFilesystem {
  readonly hostname: string

  /** @param root - absolute worktree directory. */
  constructor(private readonly root: string) {
    this.hostname = hostname()
  }

  /** Absolute path of a repo-relative path (repo paths use `/`). */
  private abs(rel: string): string {
    return join(this.root, ...rel.split('/'))
  }

  async readRepoFile(rel: string): Promise<string | undefined> {
    try {
      return await readFile(this.abs(rel), 'utf8')
    } catch (error) {
      /* v8 ignore next 2 -- non-ENOENT read failures surface only under real permission/IO faults */
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      return undefined
    }
  }

  async writeRepoFile(rel: string, content: string): Promise<void> {
    const abs = this.abs(rel)
    await mkdir(dirname(abs), { recursive: true })
    await writeFile(abs, content, 'utf8')
  }

  async deleteRepoFile(rel: string): Promise<boolean> {
    try {
      await unlink(this.abs(rel))
      return true
    } catch (error) {
      /* v8 ignore next 2 -- non-ENOENT failures surface only under real permission/IO faults */
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      return false
    }
  }

  async listDirs(rel: string): Promise<string[]> {
    return this.listEntries(rel, true)
  }

  async listFiles(rel: string): Promise<string[]> {
    return this.listEntries(rel, false)
  }

  /** Directory or file names inside one repo-relative directory. */
  private async listEntries(rel: string, directories: boolean): Promise<string[]> {
    let entries
    try {
      entries = await readdir(this.abs(rel), { withFileTypes: true })
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
      throw error
    }
    return entries
      .filter(entry => entry.isDirectory() === directories)
      .map(entry => entry.name)
  }
}

export default SessionSyncService
