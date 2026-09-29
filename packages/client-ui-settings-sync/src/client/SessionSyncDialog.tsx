/**
 * The `shell.overlay` entry (id `session-sync.dialog`, order 0): one session's
 * synchronization records, raised when the row menu's 「会话同步中」 is chosen.
 *
 * The dialog lives in the frame-wide overlay because the row menu — and the
 * row with it — unmount the moment the menu closes; the request reaches this
 * entry through the plugin's own apply-closure observable, the same pattern
 * ui-workspace uses for its rename dialog (no React context crosses the slot
 * boundary, and no state outlives the apply).
 *
 * `shell.overlay` is click-through, so the surface opts back into pointer
 * events through the ui-primitives `Modal`, whose full-viewport layer sets
 * `pointer-events: auto` on its own root.
 */

import { useCallback, useEffect, useState } from 'react'
import { Button, Modal } from '@deepseek-ai/dsh-client-ui-primitives'
import type { HostObservable, PropsHooks, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { SessionSyncRecord } from '@linbin-mk/dsh-session-sync'
import type { SyncSectionController } from './controller.ts'
import type { en } from './locales.ts'
import css from './SessionSyncDialog.module.css'

/** One records dialog the row menu asked for. */
export interface SyncRecordsRequest {
  /** Session whose records the dialog shows. */
  sessionId: string
  /** Row title; an empty one falls back to the session id as the heading. */
  displayTitle: string
}

/** Injected dependencies of {@link SessionSyncDialog} (slot `inject`). */
export interface SessionSyncDialogInjected {
  /** The page controller: records, 立即同步, and 关闭同步 ride its wire face. */
  controller: SyncSectionController
  /** Bare request source; the renderer binds it into the `useRequest` prop. */
  hooks: { request: HostObservable<SyncRecordsRequest | null> }
  /** Take the pending request down (the dialog's own 关闭). */
  settleRequest: () => void
  /** Dialog copy. */
  t: (key: keyof typeof en, params?: Record<string, unknown>) => string
}

/**
 * Props delivered by the slot outlet: the runtime share, the inject face, and
 * its bound `useRequest` selector hook.
 */
export type SessionSyncDialogProps = Partial<PropsRuntime<'shell.overlay'>>
  & Partial<Omit<SessionSyncDialogInjected, 'hooks'>>
  & Partial<PropsHooks<SessionSyncDialogInjected['hooks']>>

/** Error message from any thrown value. */
function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** A human-readable local instant for one record. */
function displayTime(iso: string): string {
  const parsed = new Date(iso)
  if (Number.isNaN(parsed.getTime())) return iso
  return parsed.toLocaleString()
}

/**
 * Render the sync-records dialog.
 * @param props - composed slot props (runtime share + injected face).
 * @returns the open dialog, or nothing while no request is pending.
 */
export function SessionSyncDialog(props: SessionSyncDialogProps) {
  const { useRequest, settleRequest, controller, t } = props
  // Nothing renders while the inject face is incomplete: an unraised dialog
  // and a dialog without its actions look the same (nothing on screen).
  if (useRequest === undefined || settleRequest === undefined || controller === undefined || t === undefined) {
    return null
  }
  return (
    <RequestedRecords
      useRequest={useRequest}
      settleRequest={settleRequest}
      controller={controller}
      t={t}
    />
  )
}

/** The mounted entry: reads the pending request and keys one dialog per session. */
function RequestedRecords({
  useRequest, settleRequest, controller, t,
}: {
  useRequest: NonNullable<SessionSyncDialogProps['useRequest']>
  settleRequest: SessionSyncDialogInjected['settleRequest']
  controller: SyncSectionController
  t: SessionSyncDialogInjected['t']
}) {
  const request = useRequest((current: SyncRecordsRequest | null) => current)
  if (request === null) return null
  // One instance per request: a different session starts a fresh read, and a
  // repeated request for the same one still remounts through the key.
  return (
    <SessionRecords
      key={`${request.sessionId}:${request.displayTitle}`}
      request={request}
      settleRequest={settleRequest}
      controller={controller}
      t={t}
    />
  )
}

/** One request's dialog: records, in-flight actions, and the local error lines. */
function SessionRecords({
  request, settleRequest, controller, t,
}: {
  request: SyncRecordsRequest
  settleRequest: SessionSyncDialogInjected['settleRequest']
  controller: SyncSectionController
  t: SessionSyncDialogInjected['t']
}) {
  const [records, setRecords] = useState<SessionSyncRecord[] | undefined>(undefined)
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [actionError, setActionError] = useState<string | null>(null)
  const [running, setRunning] = useState(false)
  const [closing, setClosing] = useState(false)
  const { sessionId } = request

  /** Read this session's records; the route answers newest first already. */
  const load = useCallback(async (): Promise<void> => {
    setLoading(true)
    setLoadError(null)
    try {
      setRecords(await controller.loadRecords(sessionId))
    } catch (error) {
      setLoadError(messageOf(error))
    } finally {
      setLoading(false)
    }
  }, [controller, sessionId])

  useEffect(() => { void load() }, [load])

  const busy = running || closing
  const title = request.displayTitle.length > 0 ? request.displayTitle : sessionId
  // Newest first, defying a hypothetical out-of-order answer: the record list
  // is a timeline, and the newest transfer is the one a user opens it for.
  const ordered = records === undefined
    ? undefined
    : [...records].sort((left, right) => (left.at < right.at ? 1 : left.at > right.at ? -1 : 0))

  /** Run one cycle now, then re-read the records it may have appended. */
  async function syncNow(): Promise<void> {
    setRunning(true)
    setActionError(null)
    try {
      const failure = await controller.syncNow()
      if (failure !== undefined) {
        setActionError(t('syncFailed', { message: failure }))
        return
      }
      await load()
    } catch (error) {
      setActionError(t('syncFailed', { message: messageOf(error) }))
    } finally {
      setRunning(false)
    }
  }

  /** Close sync for this session: the local session file itself is never touched. */
  async function closeSync(): Promise<void> {
    setClosing(true)
    setActionError(null)
    try {
      const failure = await controller.closeSession(sessionId)
      if (failure !== undefined) {
        setActionError(t('closeSyncFailed', { message: failure }))
        return
      }
      settleRequest()
    } catch (error) {
      setActionError(t('closeSyncFailed', { message: messageOf(error) }))
    } finally {
      setClosing(false)
    }
  }

  return (
    <Modal
      open
      onClose={settleRequest}
      closeLabel={t('close')}
      title={title}
      contentClassName={css.content}
      footer={(
        <>
          <Button variant="outline" disabled={busy} onClick={settleRequest}>{t('close')}</Button>
          <Button variant="outline" disabled={busy} onClick={() => { void closeSync() }}>
            {closing ? t('closingSync') : t('closeSync')}
          </Button>
          <Button variant="primary" disabled={busy} onClick={() => { void syncNow() }}>
            {running ? t('syncing') : t('syncNow')}
          </Button>
        </>
      )}
    >
      {actionError !== null && <p className={css.error} role="alert">{actionError}</p>}
      {loading && <p className={css.hint}>{t('dialogLoading')}</p>}
      {!loading && loadError !== null && (
        <div className={css.errorBlock}>
          <p className={css.error}>{t('dialogRecordsFailed', { message: loadError })}</p>
          <Button variant="outline" onClick={() => { void load() }}>{t('retry')}</Button>
        </div>
      )}
      {!loading && loadError === null && ordered !== undefined && (
        ordered.length === 0
          ? <p className={css.hint}>{t('dialogRecordsEmpty')}</p>
          : (
            <ul className={css.records}>
              {ordered.map((record, index) => (
                // Records are (host, at, direction)-unique in the host's own
                // merge; the index only breaks a tie a malformed file could carry.
                <li className={css.record} key={`${record.host}\u0000${record.at}\u0000${record.direction}\u0000${index}`}>
                  <span className={css.recordHost}>{record.host}</span>
                  <span className={css.recordTime}>{displayTime(record.at)}</span>
                  <span className={css.recordDirection}>
                    {record.direction === 'push' ? t('recordPush') : t('recordPull')}
                  </span>
                  <span className={css.recordEvents}>{t('recordEvents', { count: record.events })}</span>
                  {record.result === 'conflict' && (
                    <span className={css.recordConflict}>{t('recordConflict')}</span>
                  )}
                </li>
              ))}
            </ul>
          )
      )}
    </Modal>
  )
}
