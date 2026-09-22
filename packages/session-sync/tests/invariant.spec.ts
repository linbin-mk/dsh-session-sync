import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import InvariantRegistry from '@deepseek-ai/dsh-invariants'
import * as SessionSyncInvariant from '../src/invariant.ts'

/** Boot the invariant service plus the companion over optional settings/sessionSync stubs. */
async function setup(options: { settings?: unknown; sessionSync?: unknown } = {}): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(InvariantRegistry)
  if (options.settings !== undefined) ctx.provide('settings', options.settings)
  ctx.provide('sessionSync', options.sessionSync ?? {})
  return ctx
}

describe('session-sync invariant', () => {
  it('registers cleanly when the settings namespace is present', async () => {
    const ctx = await setup({
      settings: { get: () => ({}) },
    })
    await expect(ctx.plugin(SessionSyncInvariant)).resolves.toBeTruthy()
  })

  it('fails when the settings service is absent', async () => {
    const ctx = await setup()
    await expect(ctx.plugin(SessionSyncInvariant)).rejects.toThrow(/not registered/)
  })

  it('fails when the namespace is missing from a present settings service', async () => {
    const ctx = await setup({
      settings: { get: () => undefined },
    })
    await expect(ctx.plugin(SessionSyncInvariant)).rejects.toThrow(/not registered/)
  })
})
