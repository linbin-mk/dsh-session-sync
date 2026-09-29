/**
 * Session-sync page controller: one snapshot joining the `session-sync`
 * settings section, the host sync service status, the shared selection tree,
 * and the recent cycle log. The Host stays the single fact source — the
 * section comes from the shared configuration form of the `session-sync`
 * profile entry, every field edit is one revision-fenced form write, and
 * status, the selection, the per-session records, and the cycle log ride the
 * plugin's own same-origin HTTP API. A page the Host keeps process-local
 * (`mode: 'memory'`) reads the resolved section from that API but never
 * writes. Shape checks stay light here: the Host re-validates every write,
 * and this page's inputs come from the same schema the Host owns.
 *
 * The selection is the v2 currency: the settings page renders it as the
 * workspace → session tree, and the session row's "..." menu reads a derived
 * projection of it to decide between 「同步会话」 and 「会话同步中」. That
 * projection is loaded at client start (before any page is opened) and
 * refreshed after every mutation, on the pushed invalidations, and after a
 * manual cycle.
 */

import type { SnapshotStore } from './store.ts'
import { createSnapshotStore, deriveSnapshot } from './store.ts'
import type { ObservableSnapshot } from './store.ts'
// Type-only: the shared configuration form of one Host plugin entry.
import type { ConfigForm, ConfigFormSnapshot } from '@deepseek-ai/dsh-client-ui-settings/client'
import type {
  SessionSyncRecord, SessionSyncSelectionView, SessionSyncStatusView, SyncLogEntry,
} from '@linbin-mk/dsh-session-sync'
import type { SyncApi } from './api.ts'

/** Settings namespace owned by the host session-sync plugin. */
export const SESSION_SYNC_SETTINGS_NAMESPACE = 'session-sync'

/** Interval choices the page offers (minutes). */
export const SYNC_INTERVAL_CHOICES = [1, 5, 10, 30] as const

/** Cleanup period choices the page offers (hours). */
export const CLEANUP_PERIOD_CHOICES = [24, 48, 72, 168] as const

/** Fallback cleanup values the decoder applies when the section omits them. */
const CLEANUP_DEFAULT_PERIOD_HOURS = 24
const CLEANUP_DEFAULT_KEEP_COMMITS = 200

/** The `session-sync` section shape the page edits (v2: no mapping field). */
export interface SyncSettingsDraft {
  /** Master switch; remote is required while enabled (host validates). */
  enabled: boolean
  /** Git remote URL (SSH). */
  remote: string
  /** Remote branch. */
  branch: string
  /** Automatic cadence in minutes. */
  intervalMinutes: number
  /** Periodic git-space cleanup. */
  cleanup: { enabled: boolean; periodHours: number; keepCommits: number }
}

/** Session ids this browser changed locally, ahead of the host's fresh tree. */
export interface SyncSessionDelta {
  /** Ids the user just selected (the label flips before the POST answers). */
  added: string[]
  /** Ids the user just closed. */
  removed: string[]
}

/** Page snapshot. */
export interface SyncSectionState {
  status: 'idle' | 'loading' | 'ready' | 'error'
  /** Whole-load failure text; field writes surface through their own path. */
  error: string | null
  /** Whether the settings provider accepts writes. */
  writable: boolean
  /** Resolved settings section; undefined until the first successful load. */
  settings: SyncSettingsDraft | undefined
  /** Host sync status view; undefined until the first successful load. */
  sync: SessionSyncStatusView | undefined
  /** The shared selection tree; undefined until the first successful read. */
  selection: SessionSyncSelectionView | undefined
  /** Failure of the last selection read (the tree keeps its last good value). */
  selectionError: string | null
  /** Local session edits not yet reflected by the host's tree. */
  optimistic: SyncSessionDelta
  /** Recent cycle-log records, newest first; undefined until the first load. */
  logs: SyncLogEntry[] | undefined
  /** A manual sync is awaiting the host cycle. */
  syncing: boolean
  /** Failure of the last manual sync, when one occurred. */
  syncError: string | null
  /** Failure of the last session action (select / close sync). */
  sessionError: string | null
  /** A manual git-space cleanup is awaiting the host pass. */
  cleaning: boolean
}

/** What one session-row menu entry decides from. */
export interface SyncMenuState {
  /** The plugin is enabled with a git remote; otherwise no entry renders at all. */
  configured: boolean
  /** Sessions in this machine's selection (the host tree plus local adds). */
  selected: ReadonlySet<string>
  /**
   * Selected sessions this machine does not hold: the repo has their artifact,
   * but their row is not local, so there is nothing to sync from here.
   */
  unheld: ReadonlySet<string>
}

/** Error message from any thrown value. */
function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** Decode one resolved section value into the draft shape with safe fallbacks. */
function decodeSettings(value: unknown): SyncSettingsDraft | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const section = value as Record<string, unknown>
  const cleanupValue = typeof section['cleanup'] === 'object' && section['cleanup'] !== null
    ? section['cleanup'] as Record<string, unknown>
    : {}
  const periodHours = typeof cleanupValue['periodHours'] === 'number'
    ? cleanupValue['periodHours']
    : CLEANUP_DEFAULT_PERIOD_HOURS
  const keepCommits = typeof cleanupValue['keepCommits'] === 'number'
    ? cleanupValue['keepCommits']
    : CLEANUP_DEFAULT_KEEP_COMMITS
  return {
    enabled: section['enabled'] === true,
    remote: typeof section['remote'] === 'string' ? section['remote'] : '',
    branch: typeof section['branch'] === 'string' && section['branch'].length > 0 ? section['branch'] : 'main',
    intervalMinutes: typeof section['intervalMinutes'] === 'number' ? section['intervalMinutes'] : 5,
    cleanup: {
      enabled: cleanupValue['enabled'] === true,
      periodHours: periodHours >= 1 ? periodHours : CLEANUP_DEFAULT_PERIOD_HOURS,
      keepCommits: keepCommits >= 1 ? keepCommits : CLEANUP_DEFAULT_KEEP_COMMITS,
    },
  }
}

/**
 * Project one page snapshot into the row-menu facts. A session absent from
 * the tree is a local row this machine obviously holds — only a selection
 * row that reports `present: false` can prove otherwise, which is why the
 * unheld set is built from the tree and not from absence.
 * @param state - the current page snapshot.
 * @returns the menu's configuration, selection, and holding facts.
 */
export function menuStateOf(state: SyncSectionState): SyncMenuState {
  const selected = new Set<string>()
  const unheld = new Set<string>()
  for (const group of state.selection?.workspaces ?? []) {
    for (const session of group.sessions) {
      selected.add(session.id)
      if (!session.present) unheld.add(session.id)
    }
  }
  // The pending summary repeats ids the groups already carry; unioning it
  // keeps the label right even if a view ever carries only the summary.
  for (const pending of state.selection?.pending ?? []) {
    for (const id of pending.sessionIds) selected.add(id)
  }
  for (const id of state.optimistic.added) selected.add(id)
  for (const id of state.optimistic.removed) selected.delete(id)
  return { configured: state.sync?.configured === true, selected, unheld }
}

/**
 * Whether the page may persist an edit. The Host must accept writes AND serve
 * the section to this client: a page the Host keeps process-local
 * (`mode: 'memory'`, a non-loopback browser) never writes, whatever the
 * plugin's own route reports.
 * @param snapshot - the shared configuration form's current snapshot.
 * @param routeWritable - the plugin's own settings view writable flag, used
 * until the form has an answer of its own.
 * @returns whether write controls are live.
 */
function writableFrom(snapshot: ConfigFormSnapshot<SyncSettingsDraft>, routeWritable: boolean): boolean {
  if (snapshot.mode !== 'host') return false
  return snapshot.status === 'ready' ? snapshot.writable : routeWritable
}

/**
 * The page controller (one per settings surface). Loads are generation-
 * guarded so an older response never overwrites a newer one.
 */
export class SyncSectionController {
  /** The snapshot the section renders from (uSES-safe store). */
  readonly store: SnapshotStore<SyncSectionState> = createSnapshotStore<SyncSectionState>({
    status: 'idle',
    error: null,
    writable: false,
    settings: undefined,
    sync: undefined,
    selection: undefined,
    selectionError: null,
    optimistic: { added: [], removed: [] },
    logs: undefined,
    syncing: false,
    syncError: null,
    sessionError: null,
    cleaning: false,
  })

  /**
   * The row menu's projection of the snapshot. Stable per source revision,
   * which is what the renderer's bound selector hook needs.
   */
  readonly menu: ObservableSnapshot<SyncMenuState> = deriveSnapshot(this.store, menuStateOf)

  private generation = 0
  private selectionGeneration = 0

  /**
   * @param api - the plugin's HTTP wire face (status, selection, records,
   * manual actions, log).
   * @param form - the shared configuration form of the `session-sync` Host
   * entry, which owns the settings section's reads and writes.
   */
  constructor(
    private readonly api: SyncApi,
    private readonly form: ConfigForm<SyncSettingsDraft>,
  ) {}

  /**
   * Refresh the page snapshot: the sync status, then the settings section
   * (the shared form when the Host serves it, otherwise the plugin's own
   * route), then the cycle log and the selection tree (both fail-soft — the
   * page renders without them). A failure of the first two keeps the last
   * good values and surfaces the error.
   * @returns nothing; the snapshot carries the outcome.
   */
  async load(): Promise<void> {
    const generation = ++this.generation
    this.store.update((state) => { state.status = 'loading'; state.error = null })
    let sync: SessionSyncStatusView
    try {
      sync = await this.api.status()
    } catch (error) {
      if (generation !== this.generation) return
      this.store.update((state) => {
        state.status = 'error'
        state.error = messageOf(error)
      })
      return
    }
    const snapshot = this.form.getSnapshot()
    let writable = writableFrom(snapshot, true)
    let settings = snapshot.status === 'ready' ? decodeSettings(snapshot.value) : undefined
    if (settings === undefined) {
      // The form has no section for this client yet (loading, or a
      // process-local page): the plugin's own route still serves the resolved
      // section read-only.
      let view: { writable: boolean; settings: unknown }
      try {
        view = await this.api.getSettings()
      } catch (error) {
        if (generation !== this.generation) return
        this.store.update((state) => {
          state.status = 'error'
          state.error = messageOf(error)
        })
        return
      }
      writable = writableFrom(snapshot, view.writable)
      settings = decodeSettings(view.settings)
    }
    if (generation !== this.generation) return
    this.store.update((state) => {
      state.status = 'ready'
      state.error = null
      state.writable = writable
      state.settings = settings
      state.sync = sync
    })
    await this.refreshLogs()
    await this.refreshSelection()
  }

  /**
   * Adopt the shared form's accepted section into the snapshot. The form
   * publishes on every accepted write and Host document change, so this
   * refreshes the visible section without another round-trip.
   * @returns nothing; the snapshot carries the accepted section.
   */
  adoptSettings(): void {
    const snapshot = this.form.getSnapshot()
    if (snapshot.status !== 'ready') return
    const settings = decodeSettings(snapshot.value)
    const writable = writableFrom(snapshot, true)
    this.store.update((state) => {
      state.writable = writable
      if (settings !== undefined) state.settings = settings
    })
  }

  /** Reload the cycle log into the snapshot (fail-soft: keeps the last good list). */
  private async refreshLogs(): Promise<void> {
    let logs: SyncLogEntry[]
    try {
      logs = await this.api.logs()
    } catch {
      return
    }
    this.store.update((state) => { state.logs = logs })
  }

  /**
   * Read the shared selection tree into the snapshot. Fail-soft on purpose:
   * the row menu and the page keep their last good tree, and the failure is
   * rendered beside it.
   * @returns the failure message, or undefined once the tree landed.
   */
  async refreshSelection(): Promise<string | undefined> {
    const generation = ++this.selectionGeneration
    let selection: SessionSyncSelectionView
    try {
      selection = await this.api.getSelection()
    } catch (error) {
      const message = messageOf(error)
      // A newer read owns the field now; this answer is only history.
      if (generation === this.selectionGeneration) {
        this.store.update((state) => { state.selectionError = message })
      }
      return message
    }
    if (generation !== this.selectionGeneration) return undefined
    this.acceptSelection(selection)
    return undefined
  }

  /** Accept one fresh tree as the newest answer and drop the local deltas. */
  private acceptSelection(selection: SessionSyncSelectionView): void {
    // Anything already in flight is older than this answer.
    this.selectionGeneration += 1
    this.store.update((state) => {
      state.selection = selection
      state.selectionError = null
      state.optimistic = { added: [], removed: [] }
    })
  }

  /**
   * Read the status view into the snapshot without disturbing the page's load
   * state (the field the page's own empty state reads stays untouched). The
   * row menu needs it before the Sync page was ever opened: `configured` is
   * what decides whether the entries render at all.
   * @returns nothing; a failure leaves the last good view in place and the
   * next load, invalidation, or footer poll retries.
   */
  async refreshStatus(): Promise<void> {
    let sync: SessionSyncStatusView
    try {
      sync = await this.api.status()
    } catch {
      return
    }
    this.store.update((state) => { state.sync = sync })
  }

  /**
   * Add one session to the shared selection ("同步会话" in the row menu). The
   * local delta lands first so a reopened menu already reads 「会话同步中」;
   * the host starts a cycle with the request, so the status is re-read too.
   * @param id - session to select.
   * @returns the failure message, or undefined once the host accepted it.
   */
  async selectSession(id: string): Promise<string | undefined> {
    this.store.update((state) => {
      state.sessionError = null
      state.optimistic = {
        added: state.optimistic.added.includes(id) ? state.optimistic.added : [...state.optimistic.added, id],
        removed: state.optimistic.removed.filter(entry => entry !== id),
      }
    })
    let selection: SessionSyncSelectionView
    try {
      selection = await this.api.selectSession(id)
    } catch (error) {
      const message = messageOf(error)
      this.store.update((state) => {
        state.sessionError = message
        state.optimistic = {
          ...state.optimistic,
          added: state.optimistic.added.filter(entry => entry !== id),
        }
      })
      return message
    }
    this.acceptSelection(selection)
    await this.refreshStatus()
    return undefined
  }

  /**
   * Close sync for one session (the row's 关闭同步 and the dialog's action).
   * The local file is never deleted — only the shared selection entry is.
   * @param id - session to drop from the selection.
   * @returns the failure message, or undefined once the host accepted it.
   */
  async closeSession(id: string): Promise<string | undefined> {
    this.store.update((state) => {
      state.sessionError = null
      state.optimistic = {
        added: state.optimistic.added.filter(entry => entry !== id),
        removed: state.optimistic.removed.includes(id) ? state.optimistic.removed : [...state.optimistic.removed, id],
      }
    })
    let selection: SessionSyncSelectionView
    try {
      selection = await this.api.closeSession(id)
    } catch (error) {
      const message = messageOf(error)
      this.store.update((state) => {
        state.sessionError = message
        state.optimistic = {
          ...state.optimistic,
          removed: state.optimistic.removed.filter(entry => entry !== id),
        }
      })
      return message
    }
    this.acceptSelection(selection)
    await this.refreshStatus()
    return undefined
  }

  /**
   * One session's synchronization records, newest first. Unlike the page
   * reads this rejects: the dialog renders its own loading and error states.
   * @param id - session whose records to read.
   * @returns the records the host stores for that session.
   */
  async loadRecords(id: string): Promise<SessionSyncRecord[]> {
    return await this.api.getRecords(id)
  }

  /**
   * Merge one patch into the `session-sync` settings section through the
   * shared configuration form and reload the snapshot. The Host validates the
   * merged section and refuses an invalid one; the reload then serves the
   * last good value.
   * @param patch - plain-object patch over the section.
   * @returns the failure message, or undefined once the write and reload landed.
   */
  async update(patch: object): Promise<string | undefined> {
    const ops = Object.entries(patch).map(([field, value]) => ({ op: 'set' as const, path: [field], value }))
    let accepted: boolean
    try {
      accepted = await this.form.mutate(ops)
    } catch (error) {
      return messageOf(error)
    }
    if (!accepted && this.hostServed()) {
      // The shared form reports a Host refusal as a plain `false` and drops
      // the reason; the plugin's own validated route answers the same refusal
      // with its message, so the page can still say why the value was kept.
      try {
        await this.api.updateSettings(patch)
      } catch (error) {
        return messageOf(error)
      }
    }
    // The reload serves what the Host actually holds: the committed section
    // after an accepted write, and the persisted section plus its read-only
    // posture after a skipped one (a process-local page, or a disposed form).
    await this.load()
    return undefined
  }

  /** Whether a live, writable Host-served form owns this page's writes. */
  private hostServed(): boolean {
    const snapshot = this.form.getSnapshot()
    return snapshot.status === 'ready' && snapshot.writable && snapshot.mode === 'host'
  }

  /**
   * Run one sync cycle now and accept the answered status view.
   * @returns the failure message, or undefined once the cycle settled.
   */
  async syncNow(): Promise<string | undefined> {
    this.store.update((state) => { state.syncing = true; state.syncError = null })
    let status: SessionSyncStatusView
    try {
      status = await this.api.syncNow()
    } catch (error) {
      const message = messageOf(error)
      this.store.update((state) => { state.syncing = false; state.syncError = message })
      return message
    }
    this.store.update((state) => {
      state.syncing = false
      state.syncError = null
      state.sync = status
    })
    // The manual cycle appended records and may have imported, adopted, or
    // dropped selection entries: the log and the tree follow it.
    await this.refreshLogs()
    await this.refreshSelection()
    return undefined
  }

  /**
   * Run one git-space cleanup now and accept the answered status view.
   * @returns the failure message, or undefined once the pass settled.
   */
  async cleanupNow(): Promise<string | undefined> {
    this.store.update((state) => { state.cleaning = true; state.syncError = null })
    let status: SessionSyncStatusView
    try {
      status = await this.api.cleanupNow()
    } catch (error) {
      const message = messageOf(error)
      this.store.update((state) => { state.cleaning = false; state.syncError = message })
      return message
    }
    this.store.update((state) => {
      state.cleaning = false
      state.syncError = null
      state.sync = status
    })
    // A cleanup pass may have appended a log record; the panel follows it.
    await this.refreshLogs()
    return undefined
  }
}
