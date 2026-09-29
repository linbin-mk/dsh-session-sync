// @vitest-environment jsdom
/**
 * Client registrations: the four slot entries (settings section, sidebar
 * footer status, session row-menu toggle, overlay records dialog), their
 * inject faces, the startup selection read, and the pushed invalidations.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { resolveSlotLabel } from '@deepseek-ai/dsh-client-ui-slots'
import { apply, inject, refreshIfLoaded } from '../src/client/index.ts'
import { SyncSection } from '../src/client/SyncSection.tsx'
import type { SyncSectionInjected } from '../src/client/SyncSection.tsx'
import { SyncStatusFooter } from '../src/client/SyncStatusFooter.tsx'
import type { SyncStatusFooterInjected } from '../src/client/SyncStatusFooter.tsx'
import { SessionSyncMenuItem } from '../src/client/SessionSyncMenuItem.tsx'
import type { SessionSyncMenuItemInjected } from '../src/client/SessionSyncMenuItem.tsx'
import { SessionSyncDialog } from '../src/client/SessionSyncDialog.tsx'
import type { SessionSyncDialogInjected } from '../src/client/SessionSyncDialog.tsx'
import { FakeConfigForms, FakeLocale, FakeRemote, FakeSlots, selectionSession, selectionView } from './helpers.ts'

afterEach(() => { vi.unstubAllGlobals() })

/** One JSON answer for the plugin's own routes (the controller fetches on start). */
function jsonResponse(body: unknown): unknown {
  return { ok: true, status: 200, text: async () => JSON.stringify(body) }
}

async function bench(answers: { selection?: unknown; status?: unknown } = {}) {
  const ctx = new Context()
  const slots = new FakeSlots()
  ctx.provide('slots', slots as never)
  const locale = new FakeLocale()
  ctx.provide('locale', locale as never)
  const remote = new FakeRemote()
  ctx.provide('remote', remote as never)
  const configForms = new FakeConfigForms()
  ctx.provide('configForms', configForms as never)
  // The plugin's client half reads the selection at apply time; the routes
  // themselves are exercised by the host's own specs.
  const fetchMock = vi.fn(async (path: string) => {
    if (path === '/session-sync/selection') return jsonResponse(answers.selection ?? { workspaces: [], pending: [], total: 0 })
    if (path === '/session-sync/status') return jsonResponse(answers.status ?? { configured: false })
    return jsonResponse({})
  })
  vi.stubGlobal('fetch', fetchMock)
  /** How many times a route was read (every read is one `fetch(path, init)`). */
  const readsOf = (path: string): number => fetchMock.mock.calls.filter(call => call[0] === path).length
  return { ctx, slots, locale, remote, configForms, fetchMock, readsOf }
}

function declare(slots: FakeSlots): void {
  slots.declare('settings.section')
  slots.declare('sidebar.footer.action')
  slots.declare('sidebar.workspaces.session.menu.item')
  slots.declare('shell.overlay')
}

describe('session-sync apply', () => {
  it('declares the services it uses', () => {
    expect(inject).toEqual(['slots', 'locale', 'remote', 'configForms'])
  })

  it('registers every entry for declarations before apply', async () => {
    const before = await bench()
    declare(before.slots)
    await before.ctx.plugin({ inject: [...inject], apply }).await()

    const entry = before.slots.entries('settings.section')[0]!
    expect(entry.component).toBe(SyncSection)
    expect(entry).toMatchObject({ id: 'sync', order: 30 })
    // The nav label is a locale-following thunk; owners resolve at read time.
    expect(resolveSlotLabel(entry.label!)).toBe('会话同步')
    const injected = entry.inject!() as unknown as SyncSectionInjected
    expect(injected.t('nav')).toBe('会话同步')
    expect(injected.t('imported', { count: 2 })).toBe('导入 2 个会话')
    expect(typeof injected.controller.load).toBe('function')
    // The apply face declares the bare store in the reserved hooks
    // compartment; the renderer binds it into the component's useSnapshot.
    expect(injected.hooks.snapshot).toBe(injected.controller.store)

    const footer = before.slots.entries('sidebar.footer.action')[0]!
    expect(footer.component).toBe(SyncStatusFooter)
    expect(footer).toMatchObject({ id: 'session-sync-status', order: 0 })
    const footerInjected = footer.inject!() as unknown as SyncStatusFooterInjected
    expect(footerInjected.t('statusNormal')).toBe('会话同步正常')
    expect(footerInjected.controller).toBe(injected.controller)
    expect(footerInjected.hooks.snapshot).toBe(injected.controller.store)
  })

  it('registers the session row-menu entry at order 500 with the menu source', async () => {
    const { ctx, slots } = await bench()
    declare(slots)
    await ctx.plugin({ inject: [...inject], apply }).await()

    const menu = slots.entries('sidebar.workspaces.session.menu.item')[0]!
    expect(menu.component).toBe(SessionSyncMenuItem)
    expect(menu).toMatchObject({ id: 'session-sync.toggle', order: 500 })
    const menuInjected = menu.inject!() as unknown as SessionSyncMenuItemInjected
    expect(menuInjected.t('menuSync')).toBe('同步会话')
    expect(menuInjected.t('menuSyncing')).toBe('会话同步中')
    // The menu reads the selection projection through a bound selector hook.
    expect(menuInjected.hooks.menu).toBe(
      (slots.entries('settings.section')[0]!.inject!() as unknown as SyncSectionInjected).controller.menu,
    )
    // The click path is fire-and-forget against the controller and the request
    // store; neither may throw here.
    expect(() => { menuInjected.selectSession('s1') }).not.toThrow()
    expect(() => { menuInjected.requestRecords('s1', 'Demo') }).not.toThrow()
  })

  it('registers the records dialog in the frame-wide overlay', async () => {
    const { ctx, slots } = await bench()
    declare(slots)
    await ctx.plugin({ inject: [...inject], apply }).await()

    const dialog = slots.entries('shell.overlay')[0]!
    expect(dialog.component).toBe(SessionSyncDialog)
    expect(dialog).toMatchObject({ id: 'session-sync.dialog', order: 0 })
    const dialogInjected = dialog.inject!() as unknown as SessionSyncDialogInjected
    expect(dialogInjected.t('closeSync')).toBe('关闭同步')
    expect(dialogInjected.hooks.request.getSnapshot()).toBeNull()
    // The row menu raises what the dialog answers, through the same request
    // store: no React context crosses the slot boundary.
    const menuInjected = slots.entries('sidebar.workspaces.session.menu.item')[0]!.inject!() as unknown as SessionSyncMenuItemInjected
    menuInjected.requestRecords('s1', 'Demo session')
    expect(dialogInjected.hooks.request.getSnapshot()).toEqual({ sessionId: 's1', displayTitle: 'Demo session' })
    dialogInjected.settleRequest()
    expect(dialogInjected.hooks.request.getSnapshot()).toBeNull()
  })

  it('waits on the declarations when apply runs first', async () => {
    const after = await bench()
    await after.ctx.plugin({ inject: [...inject], apply }).await()
    expect(after.slots.entries('settings.section')).toHaveLength(0)
    expect(after.slots.entries('shell.overlay')).toHaveLength(0)

    declare(after.slots)
    expect(after.slots.entries('settings.section')).toHaveLength(1)
    expect(after.slots.entries('sidebar.footer.action')).toHaveLength(1)
    expect(after.slots.entries('sidebar.workspaces.session.menu.item')).toHaveLength(1)
    expect(after.slots.entries('shell.overlay')).toHaveLength(1)
  })

  it('reads the status and the selection once at client start, before any page is opened', async () => {
    const selection = selectionView({
      workspaces: [{ name: 'demo', matched: true, matches: 1, sessions: [selectionSession({ id: 's1' })] }],
      total: 1,
    })
    const { ctx, slots, readsOf } = await bench({ selection, status: { configured: true, syncedCount: 1 } })
    declare(slots)
    await ctx.plugin({ inject: [...inject], apply }).await()

    expect(readsOf('/session-sync/status')).toBe(1)
    expect(readsOf('/session-sync/selection')).toBe(1)
    const injected = slots.entries('settings.section')[0]!.inject!() as unknown as SyncSectionInjected
    await vi.waitFor(() => { expect(injected.controller.store.getSnapshot().selection).toEqual(selection) })
    await vi.waitFor(() => { expect(injected.controller.store.getSnapshot().sync?.configured).toBe(true) })
    // The row menu is armed without any page ever opening.
    expect(injected.controller.menu.getSnapshot()).toMatchObject({ configured: true })
    expect([...injected.controller.menu.getSnapshot().selected]).toEqual(['s1'])
    // The page itself was never loaded: these reads are not a page open.
    expect(injected.controller.store.getSnapshot().status).toBe('idle')
  })

  it('routes pushed invalidations through the ns check and the reset event', async () => {
    const { ctx, remote, slots } = await bench()
    declare(slots)
    await ctx.plugin({ inject: [...inject], apply }).await()
    expect(() => {
      remote.$dispatch('settings/document-updated', ['session-sync'])
      remote.$dispatch('settings/document-updated', ['other-namespace'])
      ctx.emit('connection/reset')
    }).not.toThrow()
  })

  it('refreshes the selection on the settings invalidation and the connection reset', async () => {
    const { ctx, remote, slots, readsOf } = await bench()
    declare(slots)
    await ctx.plugin({ inject: [...inject], apply }).await()
    const reads = readsOf('/session-sync/selection')
    const statusReads = readsOf('/session-sync/status')

    remote.$dispatch('settings/document-updated', ['other-namespace'])
    expect(readsOf('/session-sync/selection')).toBe(reads)
    expect(readsOf('/session-sync/status')).toBe(statusReads)
    remote.$dispatch('settings/document-updated', ['session-sync'])
    expect(readsOf('/session-sync/selection')).toBe(reads + 1)
    expect(readsOf('/session-sync/status')).toBe(statusReads + 1)
    ctx.emit('connection/reset')
    expect(readsOf('/session-sync/selection')).toBe(reads + 2)
    expect(readsOf('/session-sync/status')).toBe(statusReads + 2)
  })

  it('reads the session-sync section through the shared configuration form and adopts its publishes', async () => {
    const { ctx, slots, configForms } = await bench()
    declare(slots)
    await ctx.plugin({ inject: [...inject], apply }).await()
    expect(configForms.requested).toContain('session-sync')

    const injected = slots.entries('settings.section')[0]!.inject!() as unknown as SyncSectionInjected
    configForms.form('session-sync').publish({
      enabled: true, remote: 'git@example.com:team/repo.git', branch: 'main', intervalMinutes: 5,
    })
    // The accepted section reached the page without a route round-trip.
    expect(injected.controller.store.getSnapshot().settings).toMatchObject({
      enabled: true, remote: 'git@example.com:team/repo.git',
    })
    expect(injected.controller.store.getSnapshot().writable).toBe(true)
  })

  it('refreshes only a loaded page on invalidation', async () => {
    const { ctx, slots } = await bench()
    declare(slots)
    await ctx.plugin({ inject: [...inject], apply }).await()
    const entry = slots.entries('settings.section')[0]!
    const injected = entry.inject!() as unknown as SyncSectionInjected
    // The injected controller is real; spy through a load-counting wrapper.
    const controller = injected.controller
    let loads = 0
    const original = controller.load.bind(controller)
    controller.load = async () => { loads += 1; return original() }
    refreshIfLoaded(controller)
    expect(loads).toBe(0) // unopened page: no fetch on background invalidation
    await controller.load()
    loads = 0
    refreshIfLoaded(controller)
    expect(loads).toBe(1)
  })
})
