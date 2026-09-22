/**
 * Session-sync settings section: the master switch, git remote, branch,
 * cadence, the git-space cleanup controls (periodic history truncation plus
 * a manual run), the project-mapping list (key + a local-workspace picker),
 * and the manual sync action with the host status. Field edits commit through
 * the wire on change (text fields on blur); the host validates and the
 * reload serves the last good section, so the page never paints a value the
 * host refused. Copy arrives through the locale seat; workspace choices come
 * from the useWorkspaces standard hook.
 */

import { useEffect, useState } from 'react'
import { Button, IconTrashOutlineRegular, Input, Tooltip } from '@deepseek-ai/dsh-client-ui-primitives'
import type { HostObservable, PropsHooks, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
// Type-only: the global `useWorkspaces` standard-hook merge (ui-workspace).
import type {} from '@deepseek-ai/dsh-client-ui-workspace/client'
import type { SyncLogEntry } from '@linbin-mk/dsh-session-sync'
import type { SyncSectionController, SyncSectionState, SyncSettingsDraft } from './controller.ts'
import { CLEANUP_PERIOD_CHOICES, SYNC_INTERVAL_CHOICES } from './controller.ts'
import type { SyncWorkspaceChoice } from './controller.ts'
import type { en } from './locales.ts'
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
 * Props delivered by the slot outlet: the runtime share (useWorkspaces for
 * the mapping picker, close) spread flat plus the inject face, whose
 * reserved `hooks` compartment arrives as the bound `useSnapshot` hook.
 */
export type SyncSectionProps = Partial<PropsRuntime<'settings.section'>>
  & Partial<Omit<SyncSectionInjected, 'hooks'>>
  & Partial<PropsHooks<SyncSectionInjected['hooks']>>

/** Workspace choices for one mapping row, derived from the live list. */
function workspaceChoices(
  workspaces: readonly { workspaceId: string; path: string; title: string }[],
): SyncWorkspaceChoice[] {
  return workspaces.map(workspace => ({
    workspaceId: workspace.workspaceId,
    path: workspace.path,
    title: workspace.title,
  }))
}

/** Default key for a new mapping row: the workspace title, de-duplicated with a numeric suffix. */
function nextDefaultKey(
  existing: readonly { key: string }[],
  title: string | undefined,
): string {
  /* v8 ignore next -- the add button disables while no workspace choice exists */
  const base = title ?? ''
  if (!existing.some(mapping => mapping.key === base)) return base
  for (let suffix = 2; ; suffix += 1) {
    const candidate = `${base}-${suffix}`
    if (!existing.some(mapping => mapping.key === candidate)) return candidate
  }
}

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

/**
 * Render the sync settings page.
 * @param props - composed slot props (runtime share + injected face).
 * @returns the section element tree.
 */
export function SyncSection({
  useWorkspaces,
  controller,
  useSnapshot,
  t,
}: SyncSectionProps) {
  // The outlet can render before the slot's inject face lands; a partial
  // mount paints nothing (the sibling settings sections share this posture).
  if (controller === undefined || useSnapshot === undefined || t === undefined || useWorkspaces === undefined) {
    return null
  }
  // Narrowed aliases: TS does not carry the guard's narrowing into nested
  // handler functions, and the JSX reads the same snapshot below.
  const sectionController = controller
  const state = useSnapshot((selection: SyncSectionState) => selection)
  const workspaceState = useWorkspaces((selection: {
    items: readonly { workspaceId: string; path: string; title: string }[]
  }) => selection)
  const [draft, setDraft] = useState<SyncSettingsDraft | undefined>(undefined)
  const [writeError, setWriteError] = useState<string | null>(null)

  useEffect(() => { void sectionController.load() }, [sectionController])
  useEffect(() => {
    if (state.settings === undefined) return
    setDraft(state.settings)
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

  /** Commit one patch through the wire and surface a rejection. */
  async function commit(patch: object): Promise<void> {
    setWriteError(null)
    const failure = await sectionController.update(patch)
    if (failure !== undefined) setWriteError(failure)
  }

  const choices = workspaceChoices(workspaceState.items.map((workspace: {
    workspaceId: string
    path: string
    title: string
  }) => ({
    workspaceId: workspace.workspaceId,
    path: workspace.path,
    title: workspace.title,
  })))
  const readOnly = !state.writable
  const configured = settingsDraft.enabled && settingsDraft.remote.trim().length > 0
  const noWorkspaces = choices.length === 0

  function setEnabled(enabled: boolean): void {
    setDraft({ ...settingsDraft, enabled })
    void commit({ enabled })
  }

  function setRemote(remote: string): void {
    setDraft({ ...settingsDraft, remote })
  }

  function commitRemote(): void {
    if (settingsDraft.remote === state.settings?.remote) return
    void commit({ remote: settingsDraft.remote.trim() })
  }

  function setBranch(branch: string): void {
    setDraft({ ...settingsDraft, branch })
  }

  function commitBranch(): void {
    if (settingsDraft.branch === state.settings?.branch) return
    void commit({ branch: settingsDraft.branch.trim() })
  }

  function setIntervalMinutes(intervalMinutes: number): void {
    setDraft({ ...settingsDraft, intervalMinutes })
    void commit({ intervalMinutes })
  }

  function setCleanupEnabled(enabled: boolean): void {
    const cleanup = { ...settingsDraft.cleanup, enabled }
    setDraft({ ...settingsDraft, cleanup })
    void commit({ cleanup })
  }

  function setCleanupPeriod(periodHours: number): void {
    const cleanup = { ...settingsDraft.cleanup, periodHours }
    setDraft({ ...settingsDraft, cleanup })
    void commit({ cleanup })
  }

  function setCleanupKeep(text: string): void {
    const parsed = Number(text)
    const keepCommits = Number.isFinite(parsed) && parsed >= 1
      ? Math.floor(parsed)
      : settingsDraft.cleanup.keepCommits
    const cleanup = { ...settingsDraft.cleanup, keepCommits }
    setDraft({ ...settingsDraft, cleanup })
  }

  function commitCleanupKeep(): void {
    if (settingsDraft.cleanup.keepCommits === state.settings?.cleanup.keepCommits) return
    void commit({ cleanup: settingsDraft.cleanup })
  }

  function setMappingKey(index: number, key: string): void {
    const mappings = settingsDraft.mappings.map((mapping, at) => (at === index ? { ...mapping, key } : mapping))
    setDraft({ ...settingsDraft, mappings })
  }

  function commitMappingKey(index: number): void {
    const mapping = settingsDraft.mappings[index]
    /* v8 ignore next -- a mapping row blurs with its own valid index */
    if (mapping === undefined || mapping.key.trim() === state.settings?.mappings[index]?.key) return
    void commit({ mappings: settingsDraft.mappings.map(entry => ({ ...entry, key: entry.key.trim() })) })
  }

  function setMappingPath(index: number, path: string): void {
    const mappings = settingsDraft.mappings.map((mapping, at) => (at === index ? { ...mapping, path } : mapping))
    setDraft({ ...settingsDraft, mappings })
    void commit({ mappings })
  }

  function addMapping(): void {
    /* v8 ignore next -- the add button disables while no workspace choice exists */
    const mappings = [...settingsDraft.mappings, {
      key: nextDefaultKey(settingsDraft.mappings, choices[0]?.title),
      path: choices[0]?.path ?? '',
    }]
    setDraft({ ...settingsDraft, mappings })
    void commit({ mappings })
  }

  function removeMapping(index: number): void {
    const mappings = settingsDraft.mappings.filter((_mapping, at) => at !== index)
    setDraft({ ...settingsDraft, mappings })
    void commit({ mappings })
  }

  async function runSync(): Promise<void> {
    await sectionController.syncNow()
  }

  async function runCleanup(): Promise<void> {
    await sectionController.cleanupNow()
  }

  return (
    <div className={css.section}>
      <h2 className={css.title}>{t('title')}</h2>
      <p className={css.hint}>{t('intro')}</p>

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

      <div className={css.field}>
        <label className={css.label} htmlFor="sync-remote">{t('remote')}</label>
        <Input
          id="sync-remote"
          value={settingsDraft.remote}
          disabled={readOnly}
          placeholder="git@example.com:team/repo.git"
          onChange={(event) => { setRemote(event.target.value) }}
          onBlur={commitRemote}
        />
        <p className={css.hint}>{t('remoteHint')}</p>
      </div>

      <div className={css.field}>
        <label className={css.label} htmlFor="sync-branch">{t('branch')}</label>
        <Input
          id="sync-branch"
          value={settingsDraft.branch}
          disabled={readOnly}
          onChange={(event) => { setBranch(event.target.value) }}
          onBlur={commitBranch}
        />
      </div>

      <div className={css.field}>
        <label className={css.label} htmlFor="sync-interval">{t('interval')}</label>
        <select
          id="sync-interval"
          className={css.select}
          value={settingsDraft.intervalMinutes}
          disabled={readOnly}
          onChange={(event) => { setIntervalMinutes(Number(event.target.value)) }}
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
          onChange={(event) => { setCleanupEnabled(event.target.checked) }}
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
          onChange={(event) => { setCleanupPeriod(Number(event.target.value)) }}
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
          onChange={(event) => { setCleanupKeep(event.target.value) }}
          onBlur={commitCleanupKeep}
        />
      </div>
      <div className={css.mappingActions}>
        <Button disabled={readOnly || !configured || state.cleaning} onClick={() => { void runCleanup() }}>
          {state.cleaning ? t('cleaning') : t('cleanupNow')}
        </Button>
      </div>

      <h3 className={css.subtitle}>{t('mappings')}</h3>
      <p className={css.hint}>{t('mappingsHint')}</p>
      {settingsDraft.mappings.length === 0 && <p className={css.hint}>{t('unmapped')}</p>}
      {noWorkspaces && <p className={css.error}>{t('noWorkspaces')}</p>}
      {settingsDraft.mappings.map((mapping, index) => (
        <div className={css.mappingRow} key={index}>
          <div className={css.field}>
            <label className={css.label} htmlFor={`sync-key-${index}`}>{t('mappingKey')}</label>
            <Input
              id={`sync-key-${index}`}
              value={mapping.key}
              disabled={readOnly}
              placeholder={t('mappingKeyPlaceholder')}
              onChange={(event) => { setMappingKey(index, event.target.value) }}
              onBlur={() => { commitMappingKey(index) }}
            />
          </div>
          <div className={css.field}>
            <label className={css.label} htmlFor={`sync-path-${index}`}>{t('mappingPath')}</label>
            <select
              id={`sync-path-${index}`}
              className={css.select}
              value={mapping.path}
              disabled={readOnly || noWorkspaces}
              onChange={(event) => { setMappingPath(index, event.target.value) }}
            >
              {!choices.some(choice => choice.path === mapping.path) && (
                <option value={mapping.path}>{mapping.path}</option>
              )}
              {choices.map(choice => (
                <option key={choice.workspaceId} value={choice.path}>{choice.title} ({choice.path})</option>
              ))}
            </select>
          </div>
          <Tooltip label={t('removeMapping', { key: mapping.key || `#${index + 1}` })} side="bottom" delayMs={500}>
            <button
              type="button"
              className={css.removeButton}
              disabled={readOnly}
              aria-label={t('removeMapping', { key: mapping.key || `#${index + 1}` })}
              onClick={() => { removeMapping(index) }}
            >
              <IconTrashOutlineRegular size={14} />
            </button>
          </Tooltip>
        </div>
      ))}
      <div className={css.mappingActions}>
        <Button disabled={readOnly || noWorkspaces} onClick={addMapping}>{t('addMapping')}</Button>
      </div>

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
