/**
 * Session-sync settings plugin, browser half. It registers the Sync page
 * under the settings shell's section ledger; the settings section itself
 * comes from the shared configuration form of the `session-sync` Host entry
 * (reads and revision-fenced writes), while status, manual actions, and the
 * cycle log arrive through the plugin's own same-origin HTTP API (registered
 * Host-side on the open `webServer` seam). Workspace choices come from the
 * useWorkspaces standard hook, so this package owns no host state of its own
 * and needs no harness core changes.
 */
import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type { HostObservable } from '@deepseek-ai/dsh-client-ui-slots'
// Type-only: the settings shell's configForms service plus its SlotMap merge
// (the 'settings.section' entry). Cross-plugin collaboration goes through the
// service, never a value import (client bundle purity gate).
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
// Type-only: pulls the sidebar foot's SlotMap merge (the 'sidebar.footer.action' entry).
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
// Type-only: pulls the locale plugin's Context merge (ctx.locale).
import type {} from '@deepseek-ai/dsh-client-locale/client'
// Type-only: pulls the renderer's Context merge (ctx.slots), the remotes
// Context merge (ctx.remote), and the connection's event merge
// ('connection/reset').
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-api-remotes/client'
import type {} from '@deepseek-ai/dsh-client-connection/client'
import { SyncSection } from './SyncSection.tsx'
import type { SyncSectionInjected } from './SyncSection.tsx'
import { SyncStatusFooter } from './SyncStatusFooter.tsx'
import type { SyncStatusFooterInjected } from './SyncStatusFooter.tsx'
import { SyncSectionController, SESSION_SYNC_SETTINGS_NAMESPACE } from './controller.ts'
import type { SyncSectionState, SyncSettingsDraft } from './controller.ts'
import { FetchSyncApi } from './api.ts'
import { en, zh, type SyncKey } from './locales.ts'

export type { SyncSectionInjected, SyncSectionProps } from './SyncSection.tsx'
export type { SyncStatusFooterInjected, SyncStatusFooterProps } from './SyncStatusFooter.tsx'
export type { SyncKey } from './locales.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** The Sync page + its status copy. */
    'settings.sync': SyncKey
  }
}

/** Dictionary namespace owned by this plugin. */
const NS = 'settings.sync'

/**
 * Required services (cordis fiber inject). The target slot is declared by
 * ui-settings' apply, whose activation order relative to this one is NOT
 * constrained; registration depends on that slot through `slots.inject()`.
 * `configForms` owns the `session-sync` entry's section reads and writes.
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
 * Register the Sync section once the `settings.section` declaration is on
 * the ledger, and keep it fresh on pushed invalidation.
 * @param ctx - client root context.
 */
export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'ui-settings-sync: copy dictionaries')

  // The shared form of this plugin's own Host entry: the section reads, the
  // accepted values, and the revision-fenced write queue live there.
  const form = ctx.configForms.get<SyncSettingsDraft>(SESSION_SYNC_SETTINGS_NAMESPACE)
  const controller = new SyncSectionController(new FetchSyncApi(), form)
  // One stable bare source declared in the reserved inject `hooks`
  // compartment; the renderer binds it into the `useSnapshot` selector hook
  // the components receive (the platform retired the web-react package and
  // binds observables itself now).
  const snapshotSource: HostObservable<SyncSectionState> = controller.store
  // Registration-time text (the nav label thunk) and the inject face share
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

  ctx.effect(() => {
    const disposers = [
      // The form publishes every accepted section (this page's own writes and
      // any other editor's); the page adopts it without another round-trip.
      form.subscribe(() => { controller.adoptSettings() }),
      ctx.remote.$on('settings/document-updated', (ns: string) => {
        if (ns === SESSION_SYNC_SETTINGS_NAMESPACE) refreshIfLoaded(controller)
      }),
      ctx.on('connection/reset', () => { refreshIfLoaded(controller) }),
    ]
    return () => { for (const dispose of disposers) dispose() }
  }, 'ui-settings-sync: pushed invalidations')

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
}
