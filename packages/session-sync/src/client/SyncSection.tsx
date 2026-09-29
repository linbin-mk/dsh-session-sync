/**
 * Session-sync settings section: the scope note, the master switch, git
 * remote, branch, cadence, the git-space cleanup controls (periodic history
 * truncation plus a manual run), the read-only selection tree (workspace →
 * session), the read-only pending-workspace list, and the manual sync action
 * with the host status. Edits stay in a draft: the Save button writes exactly
 * the changed fields, Reset drops them, and the local validation mirrors the
 * host's cross-field rules so a mistake is named beside its field. Nothing is
 * committed merely because a field lost focus.
 *
 * v2 removed the project-mapping editor: what synchronizes is the explicit
 * session selection, built from the session row's "..." menu and rendered
 * here for reading only. The pending list deliberately offers no binding
 * action — creating a same-named workspace locally is the whole remedy.
 */

import { useEffect, useState } from 'react'
import { Button, Input } from '@deepseek-ai/dsh-client-ui-primitives'
import type { HostObservable, PropsHooks, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type {
  SessionSyncSelectionSessionView, SessionSyncSelectionView, SyncLogEntry,
} from '../api.ts'
import type { SyncSectionController, SyncSectionState, SyncSettingsDraft } from './controller.ts'
import { CLEANUP_PERIOD_CHOICES, SYNC_INTERVAL_CHOICES } from './controller.ts'
import type { en } from './locales.ts'
import {
  draftFromSettings, isDirty, settingsPatch, validateDraft,
} from './settings-form.ts'
import type { ValidationIssue } from './settings-form.ts'
import css from './SyncSection.module.css'

/** Injected dependencies of {@link SyncSection} (slot `inject`). */
export interface SyncSectionInjected {
  /** The page controller (loaded on mount, refreshed on pushed invalidations). */
  controller: SyncSectionController
  /** Bare snapshot source; the renderer binds it into the `useSnapshot` prop. */
  hooks: { snapshot: HostObservable<SyncSectionState> }
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

/** A human-readable local instant for the last-sync line. */
function displayTime(iso: string): string {
  const parsed = new Date(iso)
  if (Number.isNaN(parsed.getTime())) return iso
  return parsed.toLocaleString()
}

/** The one-line text of a cycle-log record (counters, duration, or failure). */
function logEntryText(
  entry: SyncLogEntry,
  t: (key: keyof typeof en, params?: Record<string, unknown>) => string,
): string {
  if (entry.kind === 'start') return t('syncLogStart')
  if (entry.kind === 'failure') return t('syncLogFailure', { message: entry.error ?? '' })
  const parts: string[] = []
  if ((entry.imported ?? 0) > 0) parts.push(t('imported', { count: entry.imported }))
  if ((entry.pushed ?? 0) > 0) parts.push(t('pushed', { count: entry.pushed }))
  if ((entry.archived ?? 0) > 0) parts.push(t('archived', { count: entry.archived }))
  if ((entry.deleted ?? 0) > 0) parts.push(t('deleted', { count: entry.deleted }))
  if ((entry.cleanupDropped ?? 0) > 0) parts.push(t('cleanupDropped', { count: entry.cleanupDropped }))
  if ((entry.conflicts?.length ?? 0) > 0) parts.push(t('conflicts', { count: entry.conflicts!.length }))
  const changeText = parts.length > 0 ? parts.join(' · ') : t('syncLogNoChange')
  const duration = entry.durationMs === undefined
    ? ''
    : t('syncLogDuration', { seconds: (entry.durationMs / 1000).toFixed(1) })
  return `${t('syncLogSuccess')} · ${changeText}${duration.length > 0 ? ` · ${duration}` : ''}`
}

/** The unmatched-workspace warning for one group (0 carriers) or its ambiguity (several). */
function matchWarning(
  matches: number,
  t: (key: keyof typeof en, params?: Record<string, unknown>) => string,
): string {
  return matches > 1 ? t('workspaceAmbiguous') : t('workspaceUnmatched')
}

/** One session row: title, provenance, last sync, badges, and 关闭同步. */
function SessionRow({
  session, closing, onClose, t,
}: {
  session: SessionSyncSelectionSessionView
  closing: boolean
  onClose: (id: string) => void
  t: (key: keyof typeof en, params?: Record<string, unknown>) => string
}) {
  return (
    <li className={css.sessionRow}>
      <div className={css.sessionMain}>
        {/* A session the repo knows but this machine never titled falls back
            to its id: an unnamed row would look like a rendering bug. */}
        <span className={css.sessionTitle}>{session.title.length > 0 ? session.title : session.id}</span>
        <span className={css.sessionMeta}>
          {session.addedAt !== undefined && (
            <span className={css.sessionMetaItem}>{t('sessionAddedAt', { time: displayTime(session.addedAt) })}</span>
          )}
          {session.addedBy !== undefined && (
            <span className={css.sessionMetaItem}>{t('sessionAddedBy', { host: session.addedBy })}</span>
          )}
          {session.lastSyncAt !== undefined && (
            <span className={css.sessionMetaItem}>
              {session.lastSyncHost !== undefined
                ? t('sessionLastSync', { host: session.lastSyncHost, time: displayTime(session.lastSyncAt) })
                : t('sessionLastSyncNoHost', { time: displayTime(session.lastSyncAt) })}
            </span>
          )}
        </span>
      </div>
      <div className={css.sessionBadges}>
        {session.conflicts > 0 && (
          <span className={css.badgeConflict}>{t('sessionConflict', { count: session.conflicts })}</span>
        )}
        {!session.present && <span className={css.badgeMuted}>{t('sessionNotPresent')}</span>}
        {/* Closing sync is a session action against the plugin's own routes,
            not a settings write: a read-only settings document does not gate it. */}
        <Button disabled={closing} onClick={() => { onClose(session.id) }}>{t('closeSync')}</Button>
      </div>
    </li>
  )
}

/**
 * Render the sync settings page.
 * @param props - composed slot props (runtime share + injected face).
 * @returns the section element tree.
 */
export function SyncSection({
  controller,
  useSnapshot,
  t,
}: SyncSectionProps) {
  // The outlet can render before the slot's inject face lands; a partial
  // mount paints nothing (the sibling settings sections share this posture).
  if (controller === undefined || useSnapshot === undefined || t === undefined) {
    return null
  }
  // Narrowed aliases: TS does not carry the guard's narrowing into nested
  // handler functions, and the JSX reads the same snapshot below.
  const sectionController = controller
  const state = useSnapshot((selection: SyncSectionState) => selection)
  const [draft, setDraft] = useState<SyncSettingsDraft | undefined>(undefined)
  const [writeError, setWriteError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [closingSession, setClosingSession] = useState<string | null>(null)
  // Validation stays quiet until the first Save attempt: a brand-new page with
  // an empty remote is not an error the user made.
  const [validated, setValidated] = useState(false)

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
          : <p className={css.hint}>{t('intro')}</p>}
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
  const selection: SessionSyncSelectionView | undefined = state.selection

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

  const configured = settingsDraft.enabled && settingsDraft.remote.trim().length > 0

  function setEnabled(enabled: boolean): void {
    setDraft({ ...settingsDraft, enabled })
  }

  async function runSync(): Promise<void> {
    await sectionController.syncNow()
  }

  async function runCleanup(): Promise<void> {
    await sectionController.cleanupNow()
  }

  /** Close sync for one session, holding the row's button until it settles. */
  async function closeSync(id: string): Promise<void> {
    setClosingSession(id)
    await sectionController.closeSession(id)
    setClosingSession(null)
  }

  return (
    <div className={css.section}>
      <h2 className={css.title}>{t('title')}</h2>
      <p className={css.hint}>{t('intro')}</p>

      {dirty && (
        <div className={css.saveBar}>
          <span className={css.saveBarText}>{t('unsavedChanges')}</span>
          <div className={css.saveBarActions}>
            <Button variant="outline" disabled={saving} onClick={reset}>{t('reset')}</Button>
            {/* Deliberately not disabled by `issues`: the messages that
                explain a blocked save only appear after a Save attempt, so a
                disabled button would be a dead end with no way to learn what
                is wrong. */}
            <Button
              variant="primary"
              disabled={readOnly || saving}
              onClick={() => { void save() }}
            >
              {saving ? t('saving') : t('save')}
            </Button>
          </div>
        </div>
      )}

      <label className={css.row}>
        <input
          type="checkbox"
          className={css.checkbox}
          checked={settingsDraft.enabled}
          disabled={readOnly}
          onChange={(event) => { setEnabled(event.target.checked) }}
        />
        <span>{t('enabled')}</span>
      </label>

      {/* The scope is the plugin's central rule, so it sits with the switch. */}
      <p className={css.hint}>{t('scopeHint')}</p>

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
      </div>

      <h3 className={css.subtitle}>{t('cleanupTitle')}</h3>
      <label className={css.row}>
        <input
          type="checkbox"
          className={css.checkbox}
          checked={settingsDraft.cleanup.enabled}
          disabled={readOnly}
          onChange={(event) => {
            setDraft({ ...settingsDraft, cleanup: { ...settingsDraft.cleanup, enabled: event.target.checked } })
          }}
        />
        <span>{t('cleanupEnabled')}</span>
      </label>
      <p className={css.hint}>{t('cleanupHint')}</p>
      <div className={css.field}>
        <label className={css.label} htmlFor="sync-cleanup-period">{t('cleanupPeriod')}</label>
        <select
          id="sync-cleanup-period"
          className={css.select}
          value={settingsDraft.cleanup.periodHours}
          disabled={readOnly}
          onChange={(event) => {
            setDraft({ ...settingsDraft, cleanup: { ...settingsDraft.cleanup, periodHours: Number(event.target.value) } })
          }}
        >
          {cleanupPeriodOptions(settingsDraft.cleanup.periodHours).map(hours => (
            <option key={hours} value={hours}>{t('cleanupPeriodUnit', { hours })}</option>
          ))}
        </select>
      </div>
      <div className={css.field}>
        <label className={css.label} htmlFor="sync-cleanup-keep">{t('cleanupKeep')}</label>
        <input
          id="sync-cleanup-keep"
          className={css.numberInput}
          type="number"
          min={1}
          step={1}
          value={settingsDraft.cleanup.keepCommits}
          disabled={readOnly}
          onChange={(event) => {
            const parsed = Number(event.target.value)
            if (!Number.isFinite(parsed) || parsed < 1) return
            const cleanup = { ...settingsDraft.cleanup, keepCommits: Math.floor(parsed) }
            setDraft({ ...settingsDraft, cleanup })
          }}
        />
      </div>
      <div className={css.formActions}>
        <Button disabled={readOnly || !configured || state.cleaning} onClick={() => { void runCleanup() }}>
          {state.cleaning ? t('cleaning') : t('cleanupNow')}
        </Button>
      </div>

      {/* The selection tree is read-only here by design: sessions join it from
          the row menu, and a row's only action is leaving it. */}
      <h3 className={css.subtitle}>{t('selectionTitle')}</h3>
      <p className={css.hint}>{t('selectionHint')}</p>
      {state.selectionError !== null && (
        <p className={css.error}>{t('selectionFailed', { message: state.selectionError })}</p>
      )}
      {state.sessionError !== null && (
        <p className={css.error}>{t('sessionActionFailed', { message: state.sessionError })}</p>
      )}
      {selection === undefined || selection.total === 0
        ? <p className={css.hint}>{t('selectionEmpty')}</p>
        : (
          <div className={css.tree}>
            <p className={css.hint}>{t('selectionTotal', { count: selection.total })}</p>
            {selection.workspaces.map((group, index) => (
              // A group only exists locally (this machine selected a session
              // it has not published yet) and so carries no repo key.
              <div className={css.workspaceGroup} key={group.key ?? `${group.name}#${index}`}>
                <div className={css.workspaceHead}>
                  <span className={css.workspaceName}>{group.name}</span>
                  {!group.matched && (
                    <span className={css.badgeWarning} role="status">{matchWarning(group.matches, t)}</span>
                  )}
                </div>
                <ul className={css.sessionList}>
                  {group.sessions.map(session => (
                    <SessionRow
                      key={session.id}
                      session={session}
                      closing={closingSession === session.id}
                      onClose={(id) => { void closeSync(id) }}
                      t={t}
                    />
                  ))}
                </ul>
              </div>
            ))}
          </div>
        )}

      {/* Read-only on purpose: the remedy is creating a same-named workspace,
          never binding a repo workspace to a local one. */}
      {selection !== undefined && selection.pending.length > 0 && (
        <div className={css.pendingBlock}>
          <h3 className={css.subtitle}>{t('pendingTitle')}</h3>
          <p className={css.hint}>{t('pendingHint')}</p>
          <ul className={css.pendingList}>
            {selection.pending.map(entry => (
              <li className={css.pendingRow} key={entry.key}>
                <span className={css.pendingName}>{entry.name}</span>
                <span className={css.badgeWarning} role="status">{matchWarning(entry.matches, t)}</span>
                <span className={css.pendingCount}>{t('pendingCount', { count: entry.sessionIds.length })}</span>
              </li>
            ))}
          </ul>
        </div>
      )}

      <div className={css.statusBlock}>
        <div className={css.statusActions}>
          <Button disabled={readOnly || !configured || state.syncing} onClick={() => { void runSync() }}>
            {state.syncing ? t('syncing') : t('syncNow')}
          </Button>
        </div>
        {configured
          ? (
            <dl className={css.statusList}>
              <dt>{state.sync?.repoReady === true ? t('repoReady') : t('repoMissing')}</dt>
              <dd>{state.sync?.lastSyncAt !== undefined
                ? t('lastSyncAt', { time: displayTime(state.sync.lastSyncAt) })
                : t('neverSynced')}</dd>
              {state.sync !== undefined && state.sync.lastRun.imported > 0 && (
                <dd>{t('imported', { count: state.sync.lastRun.imported })}</dd>
              )}
              {state.sync !== undefined && state.sync.lastRun.pushed > 0 && (
                <dd>{t('pushed', { count: state.sync.lastRun.pushed })}</dd>
              )}
              {state.sync !== undefined && state.sync.lastRun.archived > 0 && (
                <dd>{t('archived', { count: state.sync.lastRun.archived })}</dd>
              )}
              {state.sync !== undefined && state.sync.lastRun.deletedUnselected > 0 && (
                <dd>{t('deletedUnselected', { count: state.sync.lastRun.deletedUnselected })}</dd>
              )}
              {state.sync !== undefined && state.sync.lastRun.adopted > 0 && (
                <dd>{t('adopted', { count: state.sync.lastRun.adopted })}</dd>
              )}
              {state.sync !== undefined && state.sync.lastRun.dropped > 0 && (
                <dd>{t('dropped', { count: state.sync.lastRun.dropped })}</dd>
              )}
              {state.sync !== undefined && state.sync.lastRun.deleted > 0 && (
                <dd>{t('deleted', { count: state.sync.lastRun.deleted })}</dd>
              )}
              {state.sync?.lastCleanup !== undefined && (
                <dd>{t('lastCleanupAt', {
                  time: displayTime(state.sync.lastCleanup.at),
                  dropped: state.sync.lastCleanup.dropped,
                })}</dd>
              )}
              {state.sync !== undefined && state.sync.lastRun.conflicts.length > 0 && (
                <dd>{t('conflicts', { count: state.sync.lastRun.conflicts.length })}</dd>
              )}
              {state.sync?.lastError !== undefined && (
                <dd className={css.error}>
                  {state.sync.lastErrorAt !== undefined
                    ? t('syncFailedAt', { time: displayTime(state.sync.lastErrorAt), message: state.sync.lastError })
                    : t('syncFailed', { message: state.sync.lastError })}
                </dd>
              )}
              {state.sync?.cleanupError !== undefined && (
                <dd className={css.error}>
                  {state.sync.cleanupErrorAt !== undefined
                    ? t('cleanupFailedAt', { time: displayTime(state.sync.cleanupErrorAt), message: state.sync.cleanupError })
                    : t('cleanupFailed', { message: state.sync.cleanupError })}
                </dd>
              )}
            </dl>
          )
          : <p className={css.hint}>{t('notConfigured')}</p>}
        {state.syncError !== null && <p className={css.error}>{t('syncFailed', { message: state.syncError })}</p>}
        {writeError !== null && <p className={css.error}>{t('writeFailed', { message: writeError })}</p>}
        {!dirty && writeError === null && state.writable && (
          <p className={css.hint}>{t('savedState')}</p>
        )}
        {readOnly && <p className={css.hint}>{t('readOnly')}</p>}
      </div>

      <details className={css.logBlock}>
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
    </div>
  )
}
