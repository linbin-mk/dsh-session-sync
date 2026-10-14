/**
 * The synced-session collection tree: the read-only workspace → session view of
 * the shared selection, built to the sidebar session tree's anatomy (32px
 * session rows, a 16px leading slot, a trailing relative time that yields to
 * the row's "…" menu on hover, a 34px workspace row whose folder glyph swaps to
 * the expand arrow, and the same 0.5px-free hover-fill language).
 *
 * The tree is deliberately read-only: a session joins the selection from the
 * sidebar row's "…" menu, and a row's only verbs are viewing its sync records
 * and leaving the selection. Workspaces the repo records but this machine
 * cannot resolve appear in place as unmatched groups — the remedy is creating a
 * same-named workspace, so the group names the situation and states the remedy
 * instead of offering a binding action.
 *
 * `selection.pending` is the host's projection of exactly those unmatched
 * groups, so it is not rendered as a second list: one workspace appears once,
 * with its sessions, its warning, and the remedy.
 *
 * Every color resolves through a `--dsw-alias-*` token, and the primitives used
 * here (icons, StateDot, Menu, Tag, relativeTime) are the same ones the sidebar
 * tree renders with, so the two surfaces cannot drift apart by plugin-local
 * restyling.
 *
 * @module @linbin-mk/dsh-session-sync/client/SyncSelectionTree
 */

import { useEffect, useState } from 'react'
import {
  IconEllipsisOutlineRegular, IconFolderCloseRegular, IconFolderOpenRegular,
  IconTriangleRightFillRegular, Menu, StateDot, Tag, relativeTime,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { StateDotState } from '@deepseek-ai/dsh-client-ui-primitives'
import { clsx } from 'clsx'
import type {
  SessionSyncSelectionSessionView, SessionSyncSelectionView, SessionSyncSelectionWorkspaceView,
} from '../api.ts'
import type { en } from './locales.ts'
import css from './SyncSelectionTree.module.css'

/** The section's bound translate. */
type Translate = (key: keyof typeof en, params?: Record<string, unknown>) => string

/** How often the trailing relative times are re-bucketed while the page stays open. */
const CLOCK_INTERVAL_MS = 60_000

/** Relative-time bucket → the copy key naming its magnitude. */
const TIME_UNIT_KEYS = {
  minutes: 'timeMinutes',
  hours: 'timeHours',
  days: 'timeDays',
  months: 'timeMonths',
  years: 'timeYears',
} as const

/** Injected dependencies of {@link SyncSelectionTree}. */
export interface SyncSelectionTreeProps {
  /** The shared selection, already loaded. */
  selection: SessionSyncSelectionView
  /** Session id whose 关闭同步 write is in flight, if any. */
  closing: string | null
  /** Leave the selection for one session. */
  onCloseSync: (id: string) => void
  /** Open the per-session sync records dialog. */
  onOpenRecords: (id: string, displayTitle: string) => void
  /** Section copy. */
  t: Translate
}

/**
 * The current instant, refreshed once a minute so the relative labels date
 * themselves while the page stays open.
 * @returns epoch milliseconds of the latest tick.
 */
function useNow(): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const timer = setInterval(() => { setNow(Date.now()) }, CLOCK_INTERVAL_MS)
    return () => { clearInterval(timer) }
  }, [])
  return now
}

/**
 * The compact trailing label for one instant ("3min", "2d", "now").
 * @param at - ISO-8601 instant, when the repo recorded one.
 * @param now - current epoch milliseconds.
 * @param t - section copy.
 * @returns the localized label, or undefined when there is no usable instant.
 */
function relativeLabel(at: string | undefined, now: number, t: Translate): string | undefined {
  if (at === undefined) return undefined
  const parsed = Date.parse(at)
  if (Number.isNaN(parsed)) return undefined
  const bucket = relativeTime(parsed, now)
  if (bucket.unit === 'now') return t('timeNow')
  return t('timeAgo', { t: t(TIME_UNIT_KEYS[bucket.unit], { n: bucket.n }) })
}

/**
 * Every recorded fact about one session, as the row's hover text — the facts the
 * sidebar's hover card shows, kept reachable without a second surface.
 * @param session - the selected session's repo view.
 * @param t - section copy.
 * @returns the joined tooltip text.
 */
function sessionTooltip(session: SessionSyncSelectionSessionView, t: Translate): string {
  const parts: string[] = []
  if (!session.present) parts.push(t('sessionNotPresent'))
  if (session.addedAt !== undefined) parts.push(t('sessionAddedAt', { time: displayTime(session.addedAt) }))
  if (session.addedBy !== undefined) parts.push(t('sessionAddedBy', { host: session.addedBy }))
  if (session.lastSyncAt !== undefined) {
    parts.push(session.lastSyncHost !== undefined
      ? t('sessionLastSync', { host: session.lastSyncHost, time: displayTime(session.lastSyncAt) })
      : t('sessionLastSyncNoHost', { time: displayTime(session.lastSyncAt) }))
  }
  if (session.conflicts > 0) parts.push(t('sessionConflict', { count: session.conflicts }))
  return parts.join(' · ')
}

/** A human-readable local instant (the tooltip's absolute time). */
function displayTime(iso: string): string {
  const parsed = new Date(iso)
  if (Number.isNaN(parsed.getTime())) return iso
  return parsed.toLocaleString()
}

/**
 * The leading status dot of one row: a conflict outranks the not-held state,
 * and a healthy session keeps the slot empty so the title stays aligned.
 * @param session - the selected session's repo view.
 * @param t - section copy.
 * @returns the dot's state and its accessible label, or undefined for none.
 */
function sessionStatus(
  session: SessionSyncSelectionSessionView,
  t: Translate,
): { state: StateDotState; label: string } | undefined {
  if (session.conflicts > 0) return { state: 'error', label: t('sessionConflict', { count: session.conflicts }) }
  if (!session.present) return { state: 'idle', label: t('sessionNotPresent') }
  return undefined
}

/** The unmatched-workspace warning for one group (0 carriers) or its ambiguity (several). */
function matchWarning(matches: number, t: Translate): string {
  return matches > 1 ? t('workspaceAmbiguous') : t('workspaceUnmatched')
}

/**
 * One session row: status dot, title, trailing relative time that the row menu
 * replaces on hover, and the menu itself.
 */
function SessionRow({
  session, now, closing, onCloseSync, onOpenRecords, t,
}: {
  session: SessionSyncSelectionSessionView
  now: number
  closing: boolean
  onCloseSync: (id: string) => void
  onOpenRecords: (id: string, displayTitle: string) => void
  t: Translate
}) {
  const [menuOpen, setMenuOpen] = useState(false)
  // A session the repo knows but this machine never titled falls back to its
  // id: an unnamed row would look like a rendering bug.
  const title = session.title.length > 0 ? session.title : session.id
  const status = sessionStatus(session, t)
  // The trailing cell dates the newest recorded synchronization, falling back to
  // the moment the session joined the selection; a session with neither keeps
  // the cell empty rather than inventing a time.
  const time = relativeLabel(session.lastSyncAt ?? session.addedAt, now, t)
  return (
    <li
      className={css.sessionRow}
      data-present={session.present}
      data-menu-open={menuOpen ? 'true' : undefined}
      title={sessionTooltip(session, t)}
    >
      <span className={css.slot}>
        {status !== undefined && (
          // The dot is the row's only status channel, so it carries the words
          // the removed badge used to print.
          <span className={css.dot} role="img" aria-label={status.label}>
            <StateDot state={status.state} />
          </span>
        )}
      </span>
      <span className={css.sessionTitle}>{title}</span>
      {time !== undefined && <span className={css.sessionTime}>{time}</span>}
      <span className={css.sessionActions}>
        <Menu
          open={menuOpen}
          onClose={() => { setMenuOpen(false) }}
          align="end"
          portal
          closeOnPointerLeave
          items={[
            { id: 'records', label: t('viewRecords') },
            { id: 'close', label: t('closeSync'), danger: true, disabled: closing },
          ]}
          onSelect={(id) => {
            setMenuOpen(false)
            if (id === 'records') onOpenRecords(session.id, title)
            else if (id === 'close') onCloseSync(session.id)
          }}
          anchor={(
            <button
              type="button"
              className={css.iconButton}
              aria-label={t('sessionMenuAria', { name: title })}
              aria-haspopup="menu"
              aria-expanded={menuOpen}
              onClick={() => { setMenuOpen(open => !open) }}
            >
              <IconEllipsisOutlineRegular />
            </button>
          )}
        />
      </span>
    </li>
  )
}

/**
 * Render the collection tree.
 * @param props - the loaded selection, the in-flight session, its row actions, and copy.
 * @returns the empty state, or the workspace groups with their session rows.
 */
export function SyncSelectionTree({
  selection, closing, onCloseSync, onOpenRecords, t,
}: SyncSelectionTreeProps) {
  const now = useNow()
  // Groups start expanded: the card's whole purpose is showing the selection,
  // and a collapsed default would hide exactly what the page promises to list.
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(() => new Set())
  if (selection.workspaces.length === 0) {
    return (
      <div className={css.empty}>
        <p className={css.emptyTitle}>{t('selectionEmptyTitle')}</p>
        <p className={css.emptyHint}>{t('selectionEmptyHint')}</p>
      </div>
    )
  }
  const groupKey = (group: SessionSyncSelectionWorkspaceView, index: number): string =>
    group.key ?? `${group.name}#${index}`
  const toggle = (key: string): void => {
    setCollapsed((previous) => {
      const next = new Set(previous)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  }
  return (
    <div className={css.tree}>
      {selection.workspaces.map((group, index) => {
        const key = groupKey(group, index)
        const expanded = !collapsed.has(key)
        return (
          <div className={css.group} key={key}>
            <button
              type="button"
              className={css.groupRow}
              aria-expanded={expanded}
              data-unmatched={!group.matched || undefined}
              onClick={() => { toggle(key) }}
            >
              <span className={clsx(css.slot, css.folder)}>
                {expanded ? <IconFolderOpenRegular /> : <IconFolderCloseRegular />}
              </span>
              <span className={clsx(css.slot, css.chevron)}>
                <IconTriangleRightFillRegular className={clsx(css.arrow, expanded && css.arrowOpen)} />
              </span>
              <span className={css.groupTitle}>{group.name}</span>
              {/* A group that no single local workspace carries syncs nowhere:
                  the warning rides the header, the remedy under the group. */}
              <span className={css.groupTail}>
                {!group.matched && <Tag tone="warning">{matchWarning(group.matches, t)}</Tag>}
                {group.sessions.length}
              </span>
            </button>
            {!group.matched && <p className={css.groupNote}>{t('pendingHint')}</p>}
            {expanded && (
              <ul className={css.sessionList}>
                {group.sessions.map(session => (
                  <SessionRow
                    key={session.id}
                    session={session}
                    now={now}
                    closing={closing === session.id}
                    onCloseSync={onCloseSync}
                    onOpenRecords={onOpenRecords}
                    t={t}
                  />
                ))}
              </ul>
            )}
          </div>
        )
      })}
    </div>
  )
}
