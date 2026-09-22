/**
 * Real profile composition for the host half's specs. Each call materializes a
 * temporary harness home with a web bundle that inserts this plugin's
 * `session-sync` row, then boots it through the same stack a deployment runs:
 * the Loader, the config editor over the profile patch, and the settings
 * service. A settings write therefore travels the production path — the
 * volatile commit into the live Config plus the persistence into the profile
 * patch document — instead of a test double's approximation.
 */

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { onTestFinished } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { boot, initProfile, readProfilePatches, type ProfileContext } from '@deepseek-ai/dsh-app-boot'
import ConfigEditor from '@deepseek-ai/dsh-config-editor'
import Settings from '@deepseek-ai/dsh-settings'
import SessionSyncService from '../src/index.ts'
import { SESSION_SYNC_NAMESPACE } from '../src/settings.ts'
import type { SessionSyncWebServer } from '../src/routes.ts'

/** One booted machine's composition plus the handles a spec drives it with. */
export interface ComposedSessionSync {
  /** Root context of the booted tree. */
  ctx: Context
  /** Temporary harness home the profile lives under. */
  home: string
  /** The mounted service. */
  service: SessionSyncService
  /** Merge one patch through the harness settings service (the browser-facing write path). */
  write(patch: object): Promise<void>
  /** Replace fields through the Loader, as an edit of the profile document does. */
  loaderUpdate(patch: Record<string, unknown>): Promise<void>
  /** The profile patch document as currently stored. */
  patchDocument(): string
}

/** One extra bundle row a spec's composition mounts beside this plugin. */
export interface ComposeRow {
  /** Profile entry id (`configEditor` addresses it by this). */
  id: string
  /** Loader module name; `cordis:<builtin>` for a builtin registered here. */
  name: string
  /** Row configuration. */
  config?: Record<string, unknown>
}

/** Options of {@link composeSessionSync}. */
export interface ComposeOptions {
  /** Section fields the row is composed with (plus the startup delay). */
  config?: Record<string, unknown>
  /** Extra rows inserted before this plugin's row (services a spec needs). */
  rows?: readonly ComposeRow[]
  /** Extra modules registered as Loader builtins, keyed by their `cordis:` name. */
  builtins?: Record<string, unknown>
  /** Milliseconds after startup before the first automatic cycle. */
  startupSyncDelayMs?: number
  /** Value provided as `sessionPersistence` before the tree mounts; omit when a composed row provides it. */
  persistence?: unknown
  /** Value provided as `sessionProjectionCache`, when the spec wants the warm-up path. */
  projectionCache?: { coldSnapshot(meta: unknown, inheritedEventCount: unknown, events: unknown): unknown }
  /** Value provided as `webServer`, when the spec wants the plugin's HTTP routes mounted. */
  webServer?: SessionSyncWebServer
  /** Reuse a harness home instead of creating one (restart specs). */
  home?: string
}

/** Layer a patch over an object the way a profile document edit composes it. */
function merge(base: Record<string, unknown>, patch: Record<string, unknown>): Record<string, unknown> {
  const result = { ...base }
  for (const [key, value] of Object.entries(patch)) {
    const before = result[key]
    result[key] = before !== null && typeof before === 'object' && !Array.isArray(before)
      && value !== null && typeof value === 'object' && !Array.isArray(value)
      ? merge(before as Record<string, unknown>, value as Record<string, unknown>)
      : value
  }
  return result
}

/**
 * Boot one machine: a profile whose web bundle inserts `config-editor`,
 * `settings`, and this plugin's row.
 * @param options - section fields, injected services, and an optional reused home.
 * @returns the booted context and the handles a spec drives it with.
 */
export async function composeSessionSync(options: ComposeOptions = {}): Promise<ComposedSessionSync> {
  const home = options.home ?? mkdtempSync(join(tmpdir(), 'dsh-sync-compose-'))
  // The plugin writes its worktree, marks, and log under the harness home; the
  // fixture owns that home, so it also points DSH_HOME at it.
  process.env.DSH_HOME = home
  const dir = join(home, 'profiles', 'web')
  initProfile(dir, ['web-bundle'])
  const bundle = join(dir, 'node_modules', 'web-bundle')
  mkdirSync(bundle, { recursive: true })
  writeFileSync(join(home, 'package.json'), '{"name":"session-sync-spec-installation"}\n')
  writeFileSync(join(bundle, 'package.json'), JSON.stringify({
    name: 'web-bundle', version: '1.0.0', dsh: { bundle: { patch: 'cordis.patch.yml' } },
  }))
  writeFileSync(join(bundle, 'cordis.patch.yml'), JSON.stringify([{
    insert: [
      { id: 'config-editor', name: 'cordis:editor' },
      { id: 'settings', name: 'cordis:settings' },
      ...options.rows ?? [],
      {
        id: SESSION_SYNC_NAMESPACE,
        name: 'cordis:session-sync',
        config: { startupSyncDelayMs: options.startupSyncDelayMs ?? 3_000, ...options.config },
      },
    ],
  }]))
  writeFileSync(join(dir, 'cordis.yml'), '[]\n')
  const profile: ProfileContext = {
    name: 'web',
    startedBundles: ['web-bundle'],
    dir,
    patchPath: join(dir, 'cordis.patch.yml'),
    installAnchor: join(home, 'package.json'),
    cwd: home,
    home,
    overlays: [],
    telemetryDisabledEnv: undefined,
  }
  const ctx = await boot('session-sync-spec', join(dir, 'cordis.yml'), readProfilePatches('session-sync-spec', profile), (child) => {
    child.provide('profileContext', profile)
    child.provide('appReady', { onReady: (listener: () => void) => { listener(); return () => {} } })
    if (options.persistence !== undefined) child.provide('sessionPersistence', options.persistence as never)
    if (options.projectionCache !== undefined) child.provide('sessionProjectionCache', options.projectionCache as never)
    if (options.webServer !== undefined) child.provide('webServer', options.webServer)
    Object.assign(child.loader.builtins, {
      editor: ConfigEditor,
      settings: Settings,
      'session-sync': SessionSyncService,
      ...options.builtins,
    })
  })
  onTestFinished(async () => {
    try {
      await ctx.fiber.dispose()
    } catch {
      // A half-booted composition may reject disposal; the removal below still runs.
    }
    rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  })
  const entry = [...ctx.loader.entries()].find(candidate => candidate.options.id === SESSION_SYNC_NAMESPACE)
  if (entry === undefined) throw new Error(`session-sync: the "${SESSION_SYNC_NAMESPACE}" row did not mount`)
  return {
    ctx,
    home,
    service: ctx.sessionSync,
    write: async (patch) => { await ctx.settings.update(SESSION_SYNC_NAMESPACE, patch) },
    loaderUpdate: async (patch) => {
      await entry.update({ config: merge(entry.options.config as Record<string, unknown>, patch) })
      await entry.fiber?.await()
    },
    patchDocument: () => readFileSync(join(dir, 'cordis.patch.yml'), 'utf8'),
  }
}
