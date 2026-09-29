/**
 * Slot contracts this package registers into but cannot import.
 *
 * `settings.section` (ui-settings), `sidebar.footer.action` (ui-sidebar), and
 * `sidebar.workspaces.session.menu.item` (ui-workspace) all arrive through
 * type-only imports of the declaring package's `/client` entry, which is why
 * those packages are peer dependencies and `dsh.client.inject` entries.
 *
 * `shell.overlay` is declared by ui-layout, which this package does not
 * depend on: a third-party plugin's package graph carries only what it
 * itself consumes, and ui-workspace's own type-only import of ui-layout is
 * unresolved here (harmless under `skipLibCheck`). The declaration below
 * restates that one slot so `ctx.slots.inject('shell.overlay', …)` is typed,
 * exactly as `client/api.ts` restates the host's route literals. The shape is
 * copied verbatim from ui-layout's `SlotMap` (`{ kind: 'list', scope: 'root'
 * }`); interface merging admits two identical declarations, so this stays
 * compatible with a program that loads ui-layout's own declaration too.
 *
 * Runtime behavior does not depend on this file: slot registration travels
 * as the ordinary `name` string, and this module emits nothing.
 * @module @linbin-mk/dsh-client-ui-settings-sync/client/slot-contract
 */

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface SlotMap {
    /**
     * Frame-wide floating layer, above every column and outside their scroll
     * containers (declared by ui-layout's client half). Click-through: an
     * occupant opts back into pointer events itself, which the records dialog
     * does through the ui-primitives `Modal`.
     */
    'shell.overlay': { kind: 'list'; scope: 'root' }
  }
}

export {}
