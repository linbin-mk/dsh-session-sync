/**
 * Sync status footer action: a compact status dot beside the sidebar
 * Settings trigger showing the session-sync health (normal / abnormal /
 * syncing) plus the last sync instant. Rendered only while the plugin is
 * configured — an unconfigured plugin takes no sidebar space. The page
 * controller supplies the snapshot; this component owns its own periodic
 * refresh (the host pushes no periodic status frames).
 */

import { useEffect } from 'react'
import clsx from 'clsx'
import type { HostObservable, PropsHooks, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
import type { SyncSectionController, SyncSectionState } from './controller.ts'
import type { en } from './locales.ts'
import css from './SyncStatusFooter.module.css'

/** Refresh cadence for the footer status dot. */
const STATUS_REFRESH_MS = 60_000

/** Injected dependencies of {@link SyncStatusFooter} (slot `inject`). */
export interface SyncStatusFooterInjected {
  /** The page controller (the same snapshot the Sync page renders). */
  controller: SyncSectionController
  /** Bare snapshot source; the renderer binds it into the `useSnapshot` prop. */
  hooks: { snapshot: HostObservable<SyncSectionState> }
  /** Footer copy. */
  t: (key: keyof typeof en, params?: Record<string, unknown>) => string
}

/**
 * Props delivered by the slot outlet: the wide flag plus the inject face,
 * whose reserved `hooks` compartment arrives as the bound `useSnapshot` hook.
 */
export type SyncStatusFooterProps = Partial<PropsRuntime<'sidebar.footer.action'>>
  & Partial<Omit<SyncStatusFooterInjected, 'hooks'>>
  & Partial<PropsHooks<SyncStatusFooterInjected['hooks']>>

/** A human-readable clock instant for the last-sync line. */
function displayTime(iso: string): string {
  const parsed = new Date(iso)
  if (Number.isNaN(parsed.getTime())) return iso
  return parsed.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })
}

/** The health category the dot renders. */
type SyncHealth = 'normal' | 'abnormal' | 'syncing'

/** Health from the host status view. */
function healthOf(state: SyncSectionState): SyncHealth | undefined {
  if (state.sync?.configured !== true) return undefined
  if (state.sync.running) return 'syncing'
  if (state.sync.lastError !== undefined) return 'abnormal'
  return 'normal'
}

/**
 * Render the sync status beside Settings.
 * @param props - composed slot props (wide flag + injected face).
 * @returns the status row, or nothing while the plugin is unconfigured.
 */
export function SyncStatusFooter({
  wide,
  controller,
  useSnapshot,
  t,
}: SyncStatusFooterProps) {
  // The outlet can render before the slot's inject face lands.
  if (controller === undefined || useSnapshot === undefined || t === undefined) return null
  const state = useSnapshot((selection: SyncSectionState) => selection)

  useEffect(() => {
    void controller.load()
    const timer = setInterval(() => { void controller.load() }, STATUS_REFRESH_MS)
    return () => { clearInterval(timer) }
  }, [controller])

  const health = healthOf(state)
  if (health === undefined) return null

  const label = health === 'normal'
    ? t('statusNormal')
    : health === 'abnormal'
      ? t('statusAbnormal')
      : t('syncing')
  const lastSync = state.sync?.lastSyncAt
  const detail = lastSyncAtText(lastSync, t)

  return (
    <button
      type="button"
      className={clsx(css.status, !wide && css.rail)}
      aria-label={label}
      title={health === 'abnormal' && state.sync?.lastError !== undefined
        ? state.sync.lastErrorAt !== undefined
          ? `${label}（${displayTime(state.sync.lastErrorAt)}）：${state.sync.lastError}`
          : `${label}：${state.sync.lastError}`
        : detail}
    >
      <span className={clsx(css.dot, css[health])} aria-hidden="true" />
      {wide && (
        <span className={css.label}>
          {label}{detail.length > 0 ? ` · ${detail}` : ''}
        </span>
      )}
    </button>
  )
}

/** The last-sync suffix, or an empty string while unknown. */
function lastSyncAtText(
  lastSyncAt: string | undefined,
  t: (key: keyof typeof en, params?: Record<string, unknown>) => string,
): string {
  return lastSyncAt === undefined ? '' : t('lastSyncAt', { time: displayTime(lastSyncAt) })
}
