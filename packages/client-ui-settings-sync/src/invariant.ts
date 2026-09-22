/**
 * Package-owned invariant companion for `@linbin-mk/dsh-client-ui-settings-sync`.
 * @module @linbin-mk/dsh-client-ui-settings-sync/invariant
 */

/* jscpd:ignore-start */
import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@linbin-mk/dsh-client-ui-settings-sync'

/** Cordis companion plugin name. */
export const name = 'client-ui-settings-sync-invariant'
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']

/**
 * No runtime invariant: the settings seam validates and publishes the durable
 * `session-sync` section Host-side, while slot conflicts fail loud in the
 * slot core. The page state is browser state over typed API responses and is
 * covered by controller/component tests rather than a Cordis runtime
 * relationship.
 */
const install: InvariantInstaller = () => {}

/**
 * Register this package's invariant companion.
 * @param ctx - Cordis context carrying the invariant service.
 * @returns the installed registration's disposer after setup succeeds.
 */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
/* jscpd:ignore-end */
