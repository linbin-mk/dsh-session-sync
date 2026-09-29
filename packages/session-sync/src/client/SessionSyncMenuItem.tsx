/**
 * The session row's "..." menu entry (slot
 * `sidebar.workspaces.session.menu.item`, id `session-sync.toggle`, order
 * 500, i.e. after ui-workspace's shipped pin/rename/fork/archive rows).
 *
 * 「同步会话」 for a session this machine has not selected: the click lands an
 * optimistic local delta, POSTs the selection, and closes the menu — the host
 * starts a cycle with the request. 「会话同步中」 for a session already in the
 * shared selection: the click asks the frame-wide overlay for that session's
 * records instead.
 *
 * The entry renders nothing at all when the plugin is not configured, and
 * nothing for a selected session this machine does not hold: the repo
 * snapshot names it, but there is no local log to sync from.
 */

import { MenuItemButton } from '@deepseek-ai/dsh-client-ui-primitives'
import type { HostObservable, PropsHooks, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
// Type-only: pulls the row-menu SlotMap merge (the owner share and the
// slot-level `useMenuOpenState` hook a row supplies as its hookContext).
import type {} from '@deepseek-ai/dsh-client-ui-workspace/client'
// The shared menu-state contract this entry selects from.
import type { SyncMenuState } from './controller.ts'
import type { en } from './locales.ts'

/** Injected dependencies of {@link SessionSyncMenuItem} (slot `inject`). */
export interface SessionSyncMenuItemInjected {
  /** Bare menu-state source; the renderer binds it into the `useMenu` prop. */
  hooks: { menu: HostObservable<SyncMenuState> }
  /** Add one session to the shared selection and start a cycle (optimistic locally). */
  selectSession: (sessionId: string) => void
  /** Ask the frame-wide overlay for one session's sync records. */
  requestRecords: (sessionId: string, displayTitle: string) => void
  /** Menu copy. */
  t: (key: keyof typeof en, params?: Record<string, unknown>) => string
}

/**
 * Props delivered by the slot outlet: the owner share (`sessionId`,
 * `displayTitle`), the slot-level `useMenuOpenState`, the inject face, and its
 * bound `useMenu` selector hook.
 */
export type SessionSyncMenuItemProps = Partial<PropsRuntime<'sidebar.workspaces.session.menu.item'>>
  & Partial<Omit<SessionSyncMenuItemInjected, 'hooks'>>
  & Partial<PropsHooks<SessionSyncMenuItemInjected['hooks']>>

/**
 * Render the session-sync row menu entry.
 * @param props - composed slot props (owner share + inject face).
 * @returns the menu row, or nothing when it does not apply to this session.
 */
export function SessionSyncMenuItem(props: SessionSyncMenuItemProps) {
  const { sessionId, displayTitle, useMenuOpenState, useMenu, selectSession, requestRecords, t } = props
  // The outlet can render before the inject face lands; a partial mount paints
  // nothing. The hooks live in the body below so this guard runs no Hook.
  if (sessionId === undefined || useMenuOpenState === undefined || useMenu === undefined
    || selectSession === undefined || requestRecords === undefined || t === undefined) {
    return null
  }
  return (
    <SessionSyncMenuItemBody
      sessionId={sessionId}
      displayTitle={displayTitle ?? ''}
      useMenuOpenState={useMenuOpenState}
      useMenu={useMenu}
      selectSession={selectSession}
      requestRecords={requestRecords}
      t={t}
    />
  )
}

/** The mounted row: every hook of this entry runs here, unconditionally. */
function SessionSyncMenuItemBody({
  sessionId, displayTitle, useMenuOpenState, useMenu, selectSession, requestRecords, t,
}: {
  sessionId: string
  displayTitle: string
  useMenuOpenState: NonNullable<SessionSyncMenuItemProps['useMenuOpenState']>
  useMenu: NonNullable<SessionSyncMenuItemProps['useMenu']>
  selectSession: SessionSyncMenuItemInjected['selectSession']
  requestRecords: SessionSyncMenuItemInjected['requestRecords']
  t: SessionSyncMenuItemInjected['t']
}) {
  // Rows only render while the menu is open, so the entry reads the pair for
  // its setter: closing the menu is the entry's own job after acting.
  const [, setMenuOpen] = useMenuOpenState()
  const menu = useMenu((state: SyncMenuState) => state)
  if (!menu.configured || menu.unheld.has(sessionId)) return null
  const selected = menu.selected.has(sessionId)
  return (
    // MenuItemButton already renders `role="menuitem"` on its button, which is
    // what makes the row join the menu's keyboard walk.
    <MenuItemButton
      onSelect={() => {
        // The row (and with it this button) unmounts as the menu closes; the
        // dialog a selected row raises lives in the frame-wide overlay.
        setMenuOpen(false)
        if (selected) requestRecords(sessionId, displayTitle)
        else selectSession(sessionId)
      }}
    >
      {selected ? t('menuSyncing') : t('menuSync')}
    </MenuItemButton>
  )
}
