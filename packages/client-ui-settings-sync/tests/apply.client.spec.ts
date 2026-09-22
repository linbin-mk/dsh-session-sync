// @vitest-environment jsdom
/** Sync section registration: slot declaration injection, the locale-following label thunk, and pushed invalidations. */
import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it } from 'vitest'
import { resolveSlotLabel } from '@deepseek-ai/dsh-client-ui-slots'
import { apply, inject, refreshIfLoaded } from '@linbin-mk/dsh-client-ui-settings-sync/client'
import { SyncSection } from '../src/client/SyncSection.tsx'
import { SyncStatusFooter } from '../src/client/SyncStatusFooter.tsx'
import { FakeLocale, FakeRemote, FakeSlots } from './helpers.ts'

async function bench() {
  const ctx = new Context()
  const slots = new FakeSlots()
  ctx.provide('slots', slots as never)
  const locale = new FakeLocale()
  ctx.provide('locale', locale as never)
  const remote = new FakeRemote()
  ctx.provide('remote', remote as never)
  return { ctx, slots, locale, remote }
}

function declare(slots: FakeSlots): void {
  slots.declare('settings.section')
  slots.declare('sidebar.footer.action')
}

describe('ui-settings-sync apply', () => {
  it('declares the services it uses', () => {
    expect(inject).toEqual(['slots', 'locale', 'remote'])
  })

  it('registers the sync nav entry for declarations before or after apply', async () => {
    const before = await bench()
    declare(before.slots)
    await before.ctx.plugin({ inject: [...inject], apply }).await()
    const entry = before.slots.entries('settings.section')[0]!

    expect(entry.component).toBe(SyncSection)
    expect(entry).toMatchObject({ id: 'sync', order: 30 })
    // The nav label is a locale-following thunk; owners resolve at read time.
    expect(resolveSlotLabel(entry.label!)).toBe('会话同步')
    const injected = entry.inject!() as unknown as import('../src/client/SyncSection.tsx').SyncSectionInjected
    expect(injected.t('nav')).toBe('会话同步')
    expect(injected.t('imported', { count: 2 })).toBe('导入 2 个会话')
    expect(typeof injected.controller.load).toBe('function')
    // The apply face declares the bare store in the reserved hooks
    // compartment; the renderer binds it into the component's useSnapshot.
    expect(injected.hooks.snapshot).toBe(injected.controller.store)

    const footer = before.slots.entries('sidebar.footer.action')[0]!
    expect(footer.component).toBe(SyncStatusFooter)
    expect(footer).toMatchObject({ id: 'session-sync-status', order: 0 })
    const footerInjected = footer.inject!() as unknown as import('../src/client/SyncStatusFooter.tsx').SyncStatusFooterInjected
    expect(footerInjected.t('statusNormal')).toBe('会话同步正常')
    expect(footerInjected.controller).toBe(injected.controller)
    expect(footerInjected.hooks.snapshot).toBe(injected.controller.store)
  })

  it('waits on the declaration when apply runs first', async () => {
    const after = await bench()
    await after.ctx.plugin({ inject: [...inject], apply }).await()
    expect(after.slots.entries('settings.section')).toHaveLength(0)
    declare(after.slots)
    expect(after.slots.entries('settings.section')).toHaveLength(1)
    expect(after.slots.entries('sidebar.footer.action')).toHaveLength(1)
  })

  it('routes pushed invalidations through the ns check and the reset event', async () => {
    const { ctx, remote } = await bench()
    declare((ctx.get('slots') as unknown as FakeSlots))
    await ctx.plugin({ inject: [...inject], apply }).await()
    expect(() => {
      remote.$dispatch('settings/document-updated', ['session-sync'])
      remote.$dispatch('settings/document-updated', ['other-namespace'])
      ctx.emit('connection/reset')
    }).not.toThrow()
  })

  it('refreshes only a loaded page on invalidation', async () => {
    const { ctx, slots } = await bench()
    declare(slots)
    await ctx.plugin({ inject: [...inject], apply }).await()
    const entry = slots.entries('settings.section')[0]!
    const injected = entry.inject!() as unknown as import('../src/client/SyncSection.tsx').SyncSectionInjected
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
