/**
 * HTTP surface of the session-sync plugin: six same-origin routes on the
 * harness web server (registered through the open `webServer` service, so
 * this plugin needs no harness core changes):
 *
 * - `GET  /session-sync/status`      — the read-only status view
 * - `POST /session-sync/sync-now`    — run one cycle, answer the fresh view
 * - `POST /session-sync/cleanup-now` — run one git-space cleanup, answer the fresh view
 * - `GET  /session-sync/settings`    — the settings view (writable + section)
 * - `POST /session-sync/settings`    — merge a patch into the settings section
 * - `GET  /session-sync/logs`        — recent cycle-log records (newest first)
 *
 * Write routes reject cross-origin requests (the Origin header must name this
 * server's own host) and refuse malformed bodies; the settings service
 * re-validates every merged section, so a refused write answers 400 with the
 * host's validation message and nothing is persisted. The browser half calls
 * these routes with same-origin `fetch`, bypassing the apiproxy RPC table a
 * third-party plugin cannot extend.
 * @module @linbin-mk/dsh-session-sync/routes
 */

import type { IncomingMessage, ServerResponse } from 'node:http'

import { isSettingsPatch } from './api.ts'
import type { SessionSyncLogsView, SyncLogEntry } from './api.ts'

/** Maximum accepted request body size, in bytes. */
const MAX_BODY_BYTES = 1024 * 1024

/** Default and maximum record counts for the log route. */
const DEFAULT_LOG_LIMIT = 200
const MAX_LOG_LIMIT = 500

/** Route pathnames the plugin registers. */
export const STATUS_PATH = '/session-sync/status'
export const SYNC_NOW_PATH = '/session-sync/sync-now'
export const CLEANUP_NOW_PATH = '/session-sync/cleanup-now'
export const SETTINGS_PATH = '/session-sync/settings'
export const LOGS_PATH = '/session-sync/logs'

/** The `webServer` route registration face this plugin consumes (a structural slice of the service). */
export interface SessionSyncWebServer {
  /** Register one exact-path route; the disposer removes it. */
  register(route: { kind: 'exact'; path: string; handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void> }): () => void
}

/** The service face the routes call. */
export interface SessionSyncRoutesService {
  /** The read-only status view. */
  status(): import('./api.ts').SessionSyncStatusView
  /** Run one cycle on demand, answering the fresh status view. */
  syncNow(): Promise<import('./api.ts').SessionSyncStatusView>
  /** Run one git-space cleanup on demand, answering the fresh status view. */
  cleanupNow(): Promise<import('./api.ts').SessionSyncStatusView>
  /** Recent cycle-log records, newest first, bounded by `limit`. */
  logs(limit?: number): Promise<SyncLogEntry[]>
  /** Whether the mounted settings provider accepts writes. */
  readonly settingsWritable: boolean
  /** The resolved `session-sync` settings section. */
  getSettings(): import('./settings.ts').SessionSyncSettings
  /** Merge one plain-object patch into the settings section (host validates). */
  updateSettings(patch: object): Promise<void>
}

/** Write a JSON response and end the request. */
function sendJson(res: ServerResponse, code: number, value: unknown): void {
  const body = JSON.stringify(value)
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8' })
  res.end(body)
}

/** Read and parse the request body; `undefined` when absent, empty, or malformed. */
async function readJson(req: IncomingMessage): Promise<unknown | undefined> {
  let size = 0
  const chunks: Buffer[] = []
  for await (const chunk of req) {
    const buffer = chunk as Buffer
    size += buffer.byteLength
    if (size > MAX_BODY_BYTES) return undefined
    chunks.push(buffer)
  }
  if (chunks.length === 0) return undefined
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown
  } catch {
    return undefined
  }
}

/**
 * Whether a request is same-origin: an absent Origin header rides a
 * non-CORS fetch from this page, and a present one must name the Host the
 * request itself was sent to. Write routes use this to refuse cross-site
 * requests a hostile page could fire at the local server.
 */
function sameOrigin(req: IncomingMessage): boolean {
  const origin = req.headers.origin
  if (origin === undefined) return true
  try {
    const host = req.headers.host ?? ''
    return new URL(origin).host === host
  } catch {
    return false
  }
}

/**
 * Register the plugin's six routes on the active web server.
 * @param webServer - the `webServer` service slice (absent deployments register nothing).
 * @param service - the session-sync service answering the routes.
 * @returns the disposer removing every registered route.
 */
export function registerSessionSyncRoutes(
  webServer: SessionSyncWebServer,
  service: SessionSyncRoutesService,
): () => void {
  const dispose = [
    webServer.register({
      kind: 'exact',
      path: STATUS_PATH,
      handler: (_req, res) => { sendJson(res, 200, service.status()) },
    }),
    webServer.register({
      kind: 'exact',
      path: SYNC_NOW_PATH,
      handler: async (req, res) => {
        if (req.method !== 'POST') { sendJson(res, 405, { error: 'method not allowed' }); return }
        if (!sameOrigin(req)) { sendJson(res, 403, { error: 'cross-origin request refused' }); return }
        try {
          sendJson(res, 200, await service.syncNow())
        } catch (error) {
          sendJson(res, 500, { error: messageOf(error) })
        }
      },
    }),
    webServer.register({
      kind: 'exact',
      path: CLEANUP_NOW_PATH,
      handler: async (req, res) => {
        if (req.method !== 'POST') { sendJson(res, 405, { error: 'method not allowed' }); return }
        if (!sameOrigin(req)) { sendJson(res, 403, { error: 'cross-origin request refused' }); return }
        try {
          sendJson(res, 200, await service.cleanupNow())
        } catch (error) {
          sendJson(res, 500, { error: messageOf(error) })
        }
      },
    }),
    webServer.register({
      kind: 'exact',
      path: SETTINGS_PATH,
      handler: async (req, res) => {
        if (req.method === 'GET') {
          sendJson(res, 200, { writable: service.settingsWritable, settings: service.getSettings() })
          return
        }
        if (req.method !== 'POST') { sendJson(res, 405, { error: 'method not allowed' }); return }
        if (!sameOrigin(req)) { sendJson(res, 403, { error: 'cross-origin request refused' }); return }
        const body = await readJson(req)
        if (!isSettingsPatch(body)) { sendJson(res, 400, { error: 'request body must be one JSON object' }); return }
        try {
          await service.updateSettings(body)
          sendJson(res, 200, { ok: true })
        } catch (error) {
          sendJson(res, 400, { error: messageOf(error) })
        }
      },
    }),
    webServer.register({
      kind: 'exact',
      path: LOGS_PATH,
      handler: async (req, res) => {
        if (req.method !== 'GET') { sendJson(res, 405, { error: 'method not allowed' }); return }
        try {
          const parsed = Number(new URL(req.url ?? '', 'http://localhost').searchParams.get('limit') ?? Number.NaN)
          const limit = Number.isFinite(parsed)
            ? Math.min(Math.max(Math.floor(parsed), 1), MAX_LOG_LIMIT)
            : DEFAULT_LOG_LIMIT
          const view: SessionSyncLogsView = { entries: await service.logs(limit) }
          sendJson(res, 200, view)
        } catch (error) {
          sendJson(res, 500, { error: messageOf(error) })
        }
      },
    }),
  ]
  return () => { for (const remove of dispose) remove() }
}

/** Error message from any thrown value. */
function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
