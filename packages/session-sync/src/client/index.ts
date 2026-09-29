/**
 * Session-sync settings plugin, browser half. It registers the Sync page
 * under the settings shell's section ledger, the plugin's own entry in the
 * session row's "..." menu, and the records dialog that entry raises into the
 * frame-wide overlay; the settings section itself comes from the shared
 * configuration form of the `session-sync` Host entry (reads and
 * revision-fenced writes), while the status, the selection tree, the
 * per-session records, the manual actions, and the cycle log arrive through
 * the plugin's own same-origin HTTP API (registered Host-side on the open
 * `webServer` seam). No harness core package is modified, and no host state
 * of this package's own exists client-side.
 *
 * The selection tree is the v2 currency shared by all three surfaces: the
 * page renders it, and the row menu reads a derived projection of it to label
 * itself. It is therefore loaded once at client start — before any settings
 * page is opened — and refreshed after every mutation, on the pushed
 * invalidations, and after a manual cycle.
 */
import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type { HostObservable } from '@deepseek-ai/dsh-client-ui-slots'
// Type-only: the settings shell's configForms service plus its SlotMap merge
// (the 'settings.section' entry). Cross-plugin collaboration goes through the
// service, never a value import (client bundle purity gate).
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
// Type-only: pulls the sidebar foot's SlotMap merge (the 'sidebar.footer.action' entry).
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
// Type-only: pulls the row-menu SlotMap merge (the
// 'sidebar.workspaces.session.menu.item' entry and its owner share).
import type {} from '@deepseek-ai/dsh-client-ui-workspace/client'
// Type-only: pulls the locale plugin's Context merge (ctx.locale).
import type {} from '@deepseek-ai/dsh-client-locale/client'
// Type-only: pulls the renderer's Context merge (ctx.slots), the remotes
// Context merge (ctx.remote), and the connection's event merge
// ('connection/reset').
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-api-remotes/client'
import type {} from '@deepseek-ai/dsh-client-connection/client'
// Type-only: the local `shell.overlay` SlotMap restatement (ui-layout is not
// a dependency of this package; see slot-contract.ts).
import type {} from './slot-contract.ts'
import { SyncSection } from './SyncSection.tsx'
import type { SyncSectionInjected } from './SyncSection.tsx'
import { SyncStatusFooter } from './SyncStatusFooter.tsx'
import type { SyncStatusFooterInjected } from './SyncStatusFooter.tsx'
import { SessionSyncMenuItem } from './SessionSyncMenuItem.tsx'
import type { SessionSyncMenuItemInjected } from './SessionSyncMenuItem.tsx'
import { SessionSyncDialog } from './SessionSyncDialog.tsx'
import type { SessionSyncDialogInjected, SyncRecordsRequest } from './SessionSyncDialog.tsx'
import { SyncSectionController, SESSION_SYNC_SETTINGS_NAMESPACE } from './controller.ts'
import type { SyncMenuState, SyncSectionState, SyncSettingsDraft } from './controller.ts'
import { createSnapshotStore } from './store.ts'
import { FetchSyncApi } from './api.ts'
import { en, zh, type SyncKey } from './locales.ts'

export type { SyncSectionInjected, SyncSectionProps } from './SyncSection.tsx'
export type { SyncStatusFooterInjected, SyncStatusFooterProps } from './SyncStatusFooter.tsx'
export type { SessionSyncMenuItemInjected, SessionSyncMenuItemProps } from './SessionSyncMenuItem.tsx'
export type { SessionSyncDialogInjected, SessionSyncDialogProps, SyncRecordsRequest } from './SessionSyncDialog.tsx'
export type { SyncKey } from './locales.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** The Sync page, its row-menu entry, and its records dialog. */
    'settings.sync': SyncKey
  }
}

/** Dictionary namespace owned by this plugin. */
const NS = 'settings.sync'

/**
 * Required services (cordis fiber inject). The target slots are declared by
 * ui-settings, ui-sidebar, ui-workspace, and ui-layout's applies, whose
 * activation order relative to this one is NOT constrained; registration
 * depends on those slots through `slots.inject()`. `configForms` owns the
 * `session-sync` entry's section reads and writes.
 */
export const inject = ['slots', 'locale', 'remote', 'configForms']

/**
 * Refetch the page snapshot only after its first load: an unopened Sync page
 * must not fetch on background invalidations.
 * @param controller - the page controller.
 */
export function refreshIfLoaded(controller: SyncSectionController): void {
  if (controller.store.getSnapshot().status === 'idle') return
  void controller.load()
}

/**
 * Register the Sync section, the session-row menu entry, and the records
 * dialog once their slot declarations are on the ledger, keep the page and
 * the selection fresh on pushed invalidation, and raise the dialog request
 * the menu entry hands to the overlay.
 * @param ctx - client root context.
 */
export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'session-sync: copy dictionaries')

  // The shared form of this plugin's own Host entry: the section reads, the
  // accepted values, and the revision-fenced write queue live there.
  const form = ctx.configForms.get<SyncSettingsDraft>(SESSION_SYNC_SETTINGS_NAMESPACE)
  const controller = new SyncSectionController(new FetchSyncApi(), form)
  // One stable bare source declared in the reserved inject `hooks`
  // compartment; the renderer binds it into the `useSnapshot` selector hook
  // the components receive (the platform retired the web-react package and
  // binds observables itself now).
  const snapshotSource: HostObservable<SyncSectionState> = controller.store
  // The row menu's projection of the same store: configuration, selection
  // membership, and holding. The controller keeps it cache-stable per
  // revision, which is what the bound selector hook requires.
  const menuSource: HostObservable<SyncMenuState> = controller.menu
  // The pending records request: raised by the row menu, answered by the
  // overlay dialog. It lives in this apply closure (the pattern ui-workspace
  // uses for its rename dialog) because the row unmounts with its menu while
  // the dialog must outlive it — no React context crosses the slot boundary.
  const recordsRequest = createSnapshotStore<SyncRecordsRequest | null>(null)
  // Registration-time text (the nav label thunk) and the inject faces share
  // one bound translate; copy freshness rides the locale revision.
  const t = ctx.locale.bind(NS) as SyncSectionInjected['t']
  const injected = (): SyncSectionInjected => ({
    controller,
    t,
    hooks: { snapshot: snapshotSource },
  })

  // The sidebar footer status dot shares the page controller and refreshes
  // on the same pushed invalidations (the footer itself polls for status).
  const footerInjected = (): SyncStatusFooterInjected => ({
    controller,
    t,
    hooks: { snapshot: snapshotSource },
  })

  const menuInjected = (): SessionSyncMenuItemInjected => ({
    hooks: { menu: menuSource },
    selectSession: (sessionId) => { void controller.selectSession(sessionId) },
    requestRecords: (sessionId, displayTitle) => { recordsRequest.set({ sessionId, displayTitle }) },
    t,
  })

  const dialogInjected = (): SessionSyncDialogInjected => ({
    controller,
    hooks: { request: recordsRequest },
    settleRequest: () => { recordsRequest.set(null) },
    t,
  })

  // The row menu decides from two facts before the Sync page is ever opened:
  // whether the plugin is configured (the status view) and which sessions this
  // machine has selected (the tree). Both are read once at client start; from
  // then on the controller refreshes them after every mutation and this
  // closure on every pushed invalidation. Both reads are fail-soft — an
  // unreachable route simply leaves the menu hidden.
  void controller.refreshStatus()
  void controller.refreshSelection()

  ctx.effect(() => {
    const disposers = [
      // The form publishes every accepted section (this page's own writes and
      // any other editor's); the page adopts it without another round-trip.
      form.subscribe(() => { controller.adoptSettings() }),
      ctx.remote.$on('settings/document-updated', (ns: string) => {
        if (ns !== SESSION_SYNC_SETTINGS_NAMESPACE) return
        refreshIfLoaded(controller)
        // Enabling the plugin (or pointing it at another repo) changes what
        // the status and the selection route answer, and the row menu reads both.
        void controller.refreshStatus()
        void controller.refreshSelection()
      }),
      ctx.on('connection/reset', () => {
        refreshIfLoaded(controller)
        void controller.refreshStatus()
        void controller.refreshSelection()
      }),
    ]
    return () => { for (const dispose of disposers) dispose() }
  }, 'session-sync: pushed invalidations')

  ctx.slots.inject('settings.section', () => ctx.slots.register({
    name: 'settings.section',
    id: 'sync',
    order: 30,
    label: () => t('nav'),
    inject: injected,
  }, SyncSection))
  ctx.slots.inject('sidebar.footer.action', () => ctx.slots.register({
    name: 'sidebar.footer.action',
    id: 'session-sync-status',
    order: 0,
    inject: footerInjected,
  }, SyncStatusFooter))
  // Order 500 places the entry after ui-workspace's shipped pin/rename/fork/
  // archive rows (100…400).
  ctx.slots.inject('sidebar.workspaces.session.menu.item', () => ctx.slots.register({
    name: 'sidebar.workspaces.session.menu.item',
    id: 'session-sync.toggle',
    order: 500,
    inject: menuInjected,
  }, SessionSyncMenuItem))
  // Order 0: the overlay is a list and this entry only occupies it while a
  // request is pending, so it never competes with a toast for the same slot.
  ctx.slots.inject('shell.overlay', () => ctx.slots.register({
    name: 'shell.overlay',
    id: 'session-sync.dialog',
    order: 0,
    inject: dialogInjected,
  }, SessionSyncDialog))
}
