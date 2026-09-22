/**
 * Package-owned invariant companion for `@linbin-mk/dsh-session-sync`.
 * @module @linbin-mk/dsh-session-sync/invariant
 */

/* jscpd:ignore-start */
import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'
import { SESSION_SYNC_NAMESPACE } from '@linbin-mk/dsh-session-sync'

const PACKAGE_NAME = '@linbin-mk/dsh-session-sync'

/** Cordis companion plugin name. */
export const name = 'session-sync-invariant'
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']

/**
 * Owned relationship: the service reads its whole configuration through the
 * `session-sync` settings namespace it registers during init. A mounted
 * service with the namespace absent proves some path bypassed the service's
 * own registration (a second registrant would fail loud on the duplicate
 * name, so the namespace can never be present under a different owner).
 */
const install: InvariantInstaller = Object.assign(
  (ctx: Context, fail: (message: string) => never) => {
    const settings = ctx.get('settings')
    if (settings === undefined || settings.get(SESSION_SYNC_NAMESPACE) === undefined) {
      fail(
        'session-sync service is mounted but its "session-sync" settings namespace is '
        + 'not registered — a path bypassed the service\'s own registration',
      )
    }
  },
  { inject: ['sessionSync'] },
)

/**
 * Register this package's invariant companion.
 * @param ctx - Cordis context carrying the invariant service.
 * @returns the installed registration's disposer after setup succeeds.
 */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
/* jscpd:ignore-end */
