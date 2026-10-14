/**
 * Session-sync settings page: four cards over one read-only bottom bar.
 *
 * The page is organized by what each group is for rather than by the order the
 * fields were added — sync settings (the switch, the repository, the branch and
 * cadence), the synced-session collection, git-space cleanup, and the runtime
 * status with the cycle log. Each card owns the actions that act on its own
 * subject: 立即清理 sits in the cleanup card's header, 立即同步 in the status
 * card's header, and 保存 lives in the bar that appears only while a draft is
 * dirty. Failures render where their subject is: write failures in the save
 * bar, selection failures in the collection card, cycle failures in the status
 * card.
 *
 * Edits stay in a draft: the Save button writes exactly the changed fields,
 * Reset drops them, and the local validation mirrors the host's cross-field
 * rules so a mistake is named beside its field. Nothing is committed merely
 * because a field lost focus, and the cleanup controls stay visibly disabled
 * while periodic cleanup is off — the draft can hold values the host is not
 * acting on, but the page never pretends they are live.
 *
 * The collection tree is read-only here by design and lives in
 * {@link SyncSelectionTree}: sessions join it from the sidebar row menu, and a
 * row's only verbs are its records and leaving the selection.
 */

import { useEffect, useId, useState } from 'react'
import { Button, Input, Switch } from '@deepseek-ai/dsh-client-ui-primitives'
import type { HostObservable, PropsHooks, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { SyncLogEntry } from '../api.ts'
import type { SyncSectionController, SyncSectionState, SyncSettingsDraft } from './controller.ts'
import { CLEANUP_PERIOD_CHOICES, SYNC_INTERVAL_CHOICES } from './controller.ts'
import type { en } from './locales.ts'
import {
  draftFromSettings, isDirty, settingsPatch, validateDraft,
} from './settings-form.ts'
import type { ValidationIssue } from './settings-form.ts'
import { SyncSelectionTree } from './SyncSelectionTree.tsx'
import css from './SyncSection.module.css'

/** Injected dependencies of {@link SyncSection} (slot `inject`). */
export interface SyncSectionInjected {
  /** The page controller (loaded on mount, refreshed on pushed invalidations). */
  controller: SyncSectionController
  /** Bare snapshot source; the renderer binds it into the `useSnapshot` prop. */
  hooks: { snapshot: HostObservable<SyncSectionState> }
  /** Raise the per-session sync records dialog the collection rows open. */
  requestRecords: (sessionId: string, displayTitle: string) => void
  /** Section copy. */
  t: (key: keyof typeof en, params?: Record<string, unknown>) => string
}

/**
 * Props delivered by the slot outlet: the runtime share spread flat plus the
 * inject face, whose reserved `hooks` compartment arrives as the bound
 * `useSnapshot` hook.
 */
export type SyncSectionProps = Partial<PropsRuntime<'settings.section'>>
  & Partial<Omit<SyncSectionInjected, 'hooks'>>
  & Partial<PropsHooks<SyncSectionInjected['hooks']>>

/** The interval options, always including the current non-standard value. */
function intervalOptions(current: number): number[] {
  return [...new Set([...SYNC_INTERVAL_CHOICES, current])].sort((a, b) => a - b)
}

/** The cleanup period options, always including the current non-standard value. */
function cleanupPeriodOptions(current: number): number[] {
  return [...new Set([...CLEANUP_PERIOD_CHOICES, current])].sort((a, b) => a - b)
}

/** A human-readable local instant for the status grid and log rows. */
function displayTime(iso: string): string {
  const parsed = new Date(iso)
  if (Number.isNaN(parsed.getTime())) return iso
  return parsed.toLocaleString()
}

/**
 * One cycle's counters, in a fixed order so the same run always reads the same
 * way — the status grid's last-run line and the cycle log share this summary.
 * @param counters - a completed cycle's outcome (status `lastRun` or a log record).
 * @param t - section copy.
 * @returns the joined counters, or the no-change line.
 */
function runSummary(
  counters: {
    imported?: number
    pushed?: number
    archived?: number
    deleted?: number
    deletedUnselected?: number
    adopted?: number
    dropped?: number
    cleanupDropped?: number
    conflicts?: readonly string[]
  },
  t: (key: keyof typeof en, params?: Record<string, unknown>) => string,
): string {
  const parts: string[] = []
  if ((counters.imported ?? 0) > 0) parts.push(t('imported', { count: counters.imported }))
  if ((counters.pushed ?? 0) > 0) parts.push(t('pushed', { count: counters.pushed }))
  if ((counters.archived ?? 0) > 0) parts.push(t('archived', { count: counters.archived }))
  if ((counters.deleted ?? 0) > 0) parts.push(t('deleted', { count: counters.deleted }))
  if ((counters.deletedUnselected ?? 0) > 0) {
    parts.push(t('deletedUnselected', { count: counters.deletedUnselected }))
  }
  if ((counters.adopted ?? 0) > 0) parts.push(t('adopted', { count: counters.adopted }))
  if ((counters.dropped ?? 0) > 0) parts.push(t('dropped', { count: counters.dropped }))
  if ((counters.cleanupDropped ?? 0) > 0) {
    parts.push(t('cleanupDropped', { count: counters.cleanupDropped }))
  }
  if ((counters.conflicts?.length ?? 0) > 0) parts.push(t('conflicts', { count: counters.conflicts!.length }))
  return parts.length > 0 ? parts.join(' · ') : t('syncLogNoChange')
}

/** The one-line text of a cycle-log record (counters, duration, or failure). */
function logEntryText(
  entry: SyncLogEntry,
  t: (key: keyof typeof en, params?: Record<string, unknown>) => string,
): string {
  if (entry.kind === 'start') return t('syncLogStart')
  if (entry.kind === 'failure') return t('syncLogFailure', { message: entry.error ?? '' })
  const duration = entry.durationMs === undefined
    ? ''
    : t('syncLogDuration', { seconds: (entry.durationMs / 1000).toFixed(1) })
  return `${t('syncLogSuccess')} · ${runSummary(entry, t)}${duration.length > 0 ? ` · ${duration}` : ''}`
}

/**
 * Render the sync settings page.
 * @param props - composed slot props (runtime share + injected face).
 * @returns the section element tree.
 */
export function SyncSection({
  controller,
  useSnapshot,
  requestRecords,
  t,
}: SyncSectionProps) {
  // The outlet can render before the slot's inject face lands; a partial
  // mount paints nothing (the sibling settings sections share this posture).
  if (controller === undefined || useSnapshot === undefined || requestRecords === undefined || t === undefined) {
    return null
  }
  // Narrowed aliases: TS does not carry the guard's narrowing into nested
  // handler functions, and the JSX reads the same snapshot below.
  const sectionController = controller
  const openRecords = requestRecords
  const state = useSnapshot((selection: SyncSectionState) => selection)
  const [draft, setDraft] = useState<SyncSettingsDraft | undefined>(undefined)
  const [writeError, setWriteError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [closingSession, setClosingSession] = useState<string | null>(null)
  // Validation stays quiet until the first Save attempt: a brand-new page with
  // an empty remote is not an error the user made.
  const [validated, setValidated] = useState(false)
  const headingId = useId()

  useEffect(() => { void sectionController.load() }, [sectionController])
  useEffect(() => {
    if (state.settings === undefined) return
    // A committed write (or a pushed invalidation) re-seeds the draft, so the
    // form always shows what the host actually holds.
    setDraft(draftFromSettings(state.settings))
  }, [state.settings])

  if (draft === undefined || state.status !== 'ready') {
    return (
      <div className={css.section}>
        <h2 className={css.title}>{t('title')}</h2>
        {state.status === 'error'
          ? <p className={css.error}>{t('loadFailed')}: {state.error}</p>
          : <p className={css.intro}>{t('intro')}</p>}
      </div>
    )
  }

  // Narrowed alias: TS does not carry the guard's narrowing into nested
  // handler functions, and the JSX reads the same snapshot below.
  const settingsDraft = draft
  const saved = state.settings
  const issues = validateDraft(settingsDraft, {
    remoteRequired: t('errorRemoteRequired'),
    branchBlank: t('errorBranchBlank'),
    intervalInvalid: t('errorIntervalInvalid'),
  })
  const dirty = saved !== undefined && isDirty(settingsDraft, saved)
  const issuesFor = (field: ValidationIssue['field']): ValidationIssue[] =>
    issues.filter(issue => issue.field === field)
  const readOnly = !state.writable
  // The manual actions read the *saved* section, not the draft: an unsaved
  // switch or repository cannot sync anything yet, and a saved configuration
  // must not lose its buttons merely because the user is mid-edit.
  const configured = saved !== undefined && saved.enabled && saved.remote.trim().length > 0
  const cleanupOn = settingsDraft.cleanup.enabled
  const selection = state.selection
  const sync = state.sync

  /** Persist the whole draft as one patch of exactly the changed fields. */
  async function save(): Promise<void> {
    setValidated(true)
    if (saved === undefined) return
    // A draft that fails local validation never reaches the host: the write
    // would be refused anyway, and the messages now say which field to fix.
    if (issues.length > 0) return
    const patch = settingsPatch(settingsDraft, saved)
    // Nothing changed is still a successful save: the user asked for the form
    // to match the host, and it does.
    if (patch === undefined) {
      setWriteError(null)
      return
    }
    setWriteError(null)
    setSaving(true)
    const failure = await sectionController.update(patch)
    setSaving(false)
    if (failure !== undefined) setWriteError(failure)
  }

  /** Drop every uncommitted edit and show the host's section again. */
  function reset(): void {
    if (saved === undefined) return
    setDraft(draftFromSettings(saved))
    setValidated(false)
    setWriteError(null)
  }

  function setEnabled(enabled: boolean): void {
    setDraft({ ...settingsDraft, enabled })
  }

  function setCleanupEnabled(enabled: boolean): void {
    setDraft({ ...settingsDraft, cleanup: { ...settingsDraft.cleanup, enabled } })
  }

  async function runSync(): Promise<void> {
    await sectionController.syncNow()
  }

  async function runCleanup(): Promise<void> {
    await sectionController.cleanupNow()
  }

  /** Close sync for one session, holding that row's menu until it settles. */
  async function closeSync(id: string): Promise<void> {
    setClosingSession(id)
    await sectionController.closeSession(id)
    setClosingSession(null)
  }

  return (
    <div className={css.section}>
      <h2 className={css.title}>{t('title')}</h2>
      <p className={css.intro}>{t('intro')}</p>
      {readOnly && <p className={css.hint}>{t('readOnly')}</p>}

      {/* ① Sync settings: the switch and everything the automatic cycle needs. */}
      <section className={css.card} aria-labelledby={`${headingId}-basic`}>
        <h3 className={css.cardTitle} id={`${headingId}-basic`}>{t('basicTitle')}</h3>
        <div className={css.row}>
          <div className={css.rowText}>
            <div className={css.rowTitle}>{t('enabled')}</div>
            {/* The scope is the plugin's central rule, so it sits with the switch. */}
            <p className={css.rowDesc}>{t('scopeHint')}</p>
          </div>
          <div className={css.rowControl}>
            <Switch
              checked={settingsDraft.enabled}
              label={t('enabled')}
              disabled={readOnly}
              onChange={setEnabled}
            />
          </div>
        </div>

        <div className={css.field}>
          <label className={css.label} htmlFor="sync-remote">{t('remote')}</label>
          <Input
            id="sync-remote"
            value={settingsDraft.remote}
            disabled={readOnly}
            placeholder="git@example.com:team/repo.git"
            onChange={(event) => { setDraft({ ...settingsDraft, remote: event.target.value }) }}
          />
          <p className={css.hint}>{t('remoteHint')}</p>
          {validated && issuesFor('remote').map(issue => (
            <p className={css.fieldError} key={issue.message}>{issue.message}</p>
          ))}
        </div>

        {/* Two narrow controls share one row: the branch text and the cadence
            picker read as one fact ("which line, how often"), and the card's
            other rows keep their full-width fields. */}
        <div className={css.fieldRow}>
          <div className={css.field}>
            <label className={css.label} htmlFor="sync-branch">{t('branch')}</label>
            <Input
              id="sync-branch"
              value={settingsDraft.branch}
              disabled={readOnly}
              onChange={(event) => { setDraft({ ...settingsDraft, branch: event.target.value }) }}
            />
            {validated && issuesFor('branch').map(issue => (
              <p className={css.fieldError} key={issue.message}>{issue.message}</p>
            ))}
          </div>
          <div className={css.field}>
            <label className={css.label} htmlFor="sync-interval">{t('interval')}</label>
            <select
              id="sync-interval"
              className={css.select}
              value={settingsDraft.intervalMinutes}
              disabled={readOnly}
              onChange={(event) => { setDraft({ ...settingsDraft, intervalMinutes: Number(event.target.value) }) }}
            >
              {intervalOptions(settingsDraft.intervalMinutes).map(minutes => (
                <option key={minutes} value={minutes}>{t('intervalUnit', { minutes })}</option>
              ))}
            </select>
            {validated && issuesFor('interval').map(issue => (
              <p className={css.fieldError} key={issue.message}>{issue.message}</p>
            ))}
          </div>
        </div>
      </section>

      {/* ② The shared selection, read with the sidebar tree's own anatomy. */}
      <section className={css.card} aria-labelledby={`${headingId}-selection`}>
        <div className={css.cardHead}>
          <h3 className={css.cardTitle} id={`${headingId}-selection`}>{t('selectionTitle')}</h3>
          {selection !== undefined && selection.total > 0 && (
            <span className={css.cardMeta}>
              {t('selectionTotal', { count: selection.total, workspaces: selection.workspaces.length })}
            </span>
          )}
        </div>
        {state.selectionError !== null && (
          <p className={css.error}>{t('selectionFailed', { message: state.selectionError })}</p>
        )}
        {state.sessionError !== null && (
          <p className={css.error}>{t('sessionActionFailed', { message: state.sessionError })}</p>
        )}
        {/* A selection that never loaded stays unknown: the card names the
            failure above instead of claiming the selection is empty. */}
        {selection === undefined
          ? (state.selectionError === null && <p className={css.hint}>{t('selectionEmptyHint')}</p>)
          : (
            <SyncSelectionTree
              selection={selection}
              closing={closingSession}
              onCloseSync={(id) => { void closeSync(id) }}
              onOpenRecords={openRecords}
              t={t}
            />
          )}
      </section>

      {/* ③ Git-space cleanup: its verb lives in this card's header. */}
      <section className={css.card} aria-labelledby={`${headingId}-cleanup`}>
        <div className={css.cardHead}>
          <h3 className={css.cardTitle} id={`${headingId}-cleanup`}>{t('cleanupTitle')}</h3>
          <Button
            variant="outline"
            size="sm"
            disabled={readOnly || !configured || state.cleaning}
            onClick={() => { void runCleanup() }}
          >
            {state.cleaning ? t('cleaning') : t('cleanupNow')}
          </Button>
        </div>
        <div className={css.row}>
          <div className={css.rowText}>
            <div className={css.rowTitle}>{t('cleanupEnabled')}</div>
            <p className={css.rowDesc}>{t('cleanupHint')}</p>
          </div>
          <div className={css.rowControl}>
            <Switch
              checked={cleanupOn}
              label={t('cleanupEnabled')}
              disabled={readOnly}
              onChange={setCleanupEnabled}
            />
          </div>
        </div>
        {/* Disabled, not hidden: the values are still part of the draft, and a
            control that vanished would hide what the host would apply. */}
        <div className={css.row} data-disabled={!cleanupOn || undefined}>
          <div className={css.rowText}>
            <div className={css.rowTitle}>{t('cleanupPeriod')}</div>
          </div>
          <div className={css.rowControl}>
            <select
              id="sync-cleanup-period"
              className={css.select}
              aria-label={t('cleanupPeriod')}
              value={settingsDraft.cleanup.periodHours}
              disabled={readOnly || !cleanupOn}
              onChange={(event) => {
                setDraft({ ...settingsDraft, cleanup: { ...settingsDraft.cleanup, periodHours: Number(event.target.value) } })
              }}
            >
              {cleanupPeriodOptions(settingsDraft.cleanup.periodHours).map(hours => (
                <option key={hours} value={hours}>{t('cleanupPeriodUnit', { hours })}</option>
              ))}
            </select>
          </div>
        </div>
        <div className={css.row} data-disabled={!cleanupOn || undefined}>
          <div className={css.rowText}>
            <div className={css.rowTitle}>
              <label htmlFor="sync-cleanup-keep">{t('cleanupKeep')}</label>
            </div>
            <p className={css.rowDesc}>{t('cleanupKeepHint')}</p>
          </div>
          <div className={css.rowControl}>
            <input
              id="sync-cleanup-keep"
              className={css.numberInput}
              type="number"
              min={1}
              step={1}
              value={settingsDraft.cleanup.keepCommits}
              disabled={readOnly || !cleanupOn}
              onChange={(event) => {
                const parsed = Number(event.target.value)
                if (!Number.isFinite(parsed) || parsed < 1) return
                const cleanup = { ...settingsDraft.cleanup, keepCommits: Math.floor(parsed) }
                setDraft({ ...settingsDraft, cleanup })
              }}
            />
          </div>
        </div>
      </section>

      {/* ④ Runtime status: the manual cycle and the log of what the cycles did. */}
      <section className={css.card} aria-labelledby={`${headingId}-status`}>
        <div className={css.cardHead}>
          <h3 className={css.cardTitle} id={`${headingId}-status`}>{t('statusTitle')}</h3>
          <Button
            variant="primary"
            size="sm"
            disabled={readOnly || !configured || state.syncing}
            onClick={() => { void runSync() }}
          >
            {state.syncing ? t('syncing') : t('syncNow')}
          </Button>
        </div>
        {configured
          ? (
            <>
              <dl className={css.details}>
                <dt>{t('statusRepo')}</dt>
                <dd>{sync?.repoReady === true ? t('repoReady') : t('repoMissing')}</dd>
                <dt>{t('statusLastSync')}</dt>
                <dd>{sync?.lastSyncAt !== undefined ? displayTime(sync.lastSyncAt) : t('neverSynced')}</dd>
                <dt>{t('statusLastRun')}</dt>
                <dd>{sync !== undefined ? runSummary(sync.lastRun, t) : t('neverSynced')}</dd>
                {sync?.lastCleanup !== undefined && (
                  <>
                    <dt>{t('statusLastCleanup')}</dt>
                    <dd>{t('lastCleanupAt', {
                      time: displayTime(sync.lastCleanup.at),
                      dropped: sync.lastCleanup.dropped,
                    })}</dd>
                  </>
                )}
                {sync !== undefined && sync.lastRun.conflicts.length > 0 && (
                  <>
                    <dt>{t('statusConflicts')}</dt>
                    <dd>{t('conflicts', { count: sync.lastRun.conflicts.length })}</dd>
                  </>
                )}
              </dl>
              {/* Failures stay below the facts and keep their own instant, so a
                  stale error cannot read as part of the last successful run. */}
              {sync?.lastError !== undefined && (
                <p className={css.error}>
                  {sync.lastErrorAt !== undefined
                    ? t('syncFailedAt', { time: displayTime(sync.lastErrorAt), message: sync.lastError })
                    : t('syncFailed', { message: sync.lastError })}
                </p>
              )}
              {sync?.cleanupError !== undefined && (
                <p className={css.error}>
                  {sync.cleanupErrorAt !== undefined
                    ? t('cleanupFailedAt', { time: displayTime(sync.cleanupErrorAt), message: sync.cleanupError })
                    : t('cleanupFailed', { message: sync.cleanupError })}
                </p>
              )}
              {state.syncError !== null && <p className={css.error}>{t('syncFailed', { message: state.syncError })}</p>}
            </>
          )
          : <p className={css.hint}>{t('notConfigured')}</p>}
        <details className={css.disclosure}>
          <summary className={css.logSummary}>{t('syncLogTitle')}</summary>
          {state.logs === undefined || state.logs.length === 0
            ? <p className={css.hint}>{t('syncLogEmpty')}</p>
            : (
              <ul className={css.logList}>
                {state.logs.map((entry: SyncLogEntry, index: number) => (
                  <li className={css.logEntry} key={index}>
                    <span className={css.logTime}>{displayTime(entry.time)}</span>
                    <span className={entry.kind === 'failure' ? css.logError : undefined}>{logEntryText(entry, t)}</span>
                  </li>
                ))}
              </ul>
            )}
        </details>
      </section>

      {/* The page's primary verb, pinned to the bottom of the scrolling column
          so it stays reachable from anywhere in a long section. */}
      {dirty && (
        <div className={css.saveBar}>
          <span className={css.saveBarText}>
            {writeError !== null
              ? <span className={css.error}>{t('writeFailed', { message: writeError })}</span>
              : t('unsavedChanges')}
          </span>
          <div className={css.saveBarActions}>
            <Button variant="outline" size="sm" disabled={saving} onClick={reset}>{t('reset')}</Button>
            {/* Deliberately not disabled by `issues`: the messages that
                explain a blocked save only appear after a Save attempt, so a
                disabled button would be a dead end with no way to learn what
                is wrong. */}
            <Button
              variant="primary"
              size="sm"
              disabled={readOnly || saving}
              onClick={() => { void save() }}
            >
              {saving ? t('saving') : t('save')}
            </Button>
          </div>
        </div>
      )}
    </div>
  )
}
