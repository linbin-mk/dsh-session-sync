/** HTTP route layer: method gating, origin checks, body parsing, and service wiring. */
import { describe, expect, it, vi } from 'vitest'
import type { IncomingMessage, ServerResponse } from 'node:http'
import {
  CLEANUP_NOW_PATH, LOGS_PATH, SETTINGS_PATH, STATUS_PATH, SYNC_NOW_PATH, registerSessionSyncRoutes,
} from '../src/routes.ts'
import type { SessionSyncRoutesService, SessionSyncWebServer } from '../src/routes.ts'
import type { SessionSyncSettings } from '../src/settings.ts'
import type { SessionSyncStatusView, SyncLogEntry } from '../src/api.ts'

/** A request the handlers can read: method, headers, and an async body. */
function request(options: {
  method?: string
  origin?: string
  host?: string
  body?: string
  url?: string
} = {}): IncomingMessage {
  const chunks = options.body === undefined ? [] : [Buffer.from(options.body)]
  return {
    method: options.method ?? 'GET',
    url: options.url,
    headers: {
      ...options.origin === undefined ? {} : { origin: options.origin },
      ...options.host === undefined ? {} : { host: options.host },
    },
    [Symbol.asyncIterator]: async function* () {
      for (const chunk of chunks) yield chunk
    },
  } as unknown as IncomingMessage
}

/** A response the handlers write into. */
function response(): ServerResponse & { statusCode: number; body: string } {
  const res = {
    statusCode: 0,
    body: '',
    writeHead(code: number) { res.statusCode = code },
    end(chunk: string) { res.body = chunk },
  }
  return res as never
}

/** A route ledger standing in for the webServer service. */
function fakeWebServer() {
  const routes = new Map<string, { handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void>; dispose: () => void }>()
  const webServer: SessionSyncWebServer = {
    register: vi.fn((route) => {
      const record = { handler: route.handler, dispose: vi.fn() }
      routes.set(route.path, record)
      return record.dispose
    }),
  }
  return { webServer, routes }
}

const statusView: SessionSyncStatusView = {
  configured: true,
  repoReady: true,
  running: false,
  lastSyncAt: '2026-08-16T00:00:00.000Z',
  lastRun: { imported: 1, pushed: 2, archived: 1, deleted: 1, conflicts: [] },
}

const settingsValue: SessionSyncSettings = {
  enabled: true,
  remote: 'git@example.com:team/repo.git',
  branch: 'main',
  intervalMinutes: 5,
  mappings: [{ key: 'demo', path: '/work/demo' }],
  cleanup: { enabled: false, periodHours: 24, keepCommits: 200 },
}

function fakeService(overrides: Partial<SessionSyncRoutesService> = {}): SessionSyncRoutesService {
  return {
    status: vi.fn(() => statusView),
    syncNow: vi.fn(() => Promise.resolve(statusView)),
    cleanupNow: vi.fn(() => Promise.resolve(statusView)),
    logs: vi.fn(() => Promise.resolve([])),
    settingsWritable: true,
    getSettings: vi.fn(() => settingsValue),
    updateSettings: vi.fn(() => Promise.resolve()),
    ...overrides,
  }
}

async function call(handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void>, req: IncomingMessage) {
  const res = response()
  await handler(req, res)
  return res
}

function json(res: ServerResponse & { body: string }): unknown {
  return JSON.parse(res.body)
}

describe('registerSessionSyncRoutes', () => {
  it('registers one exact route per endpoint', () => {
    const { webServer } = fakeWebServer()
    const dispose = registerSessionSyncRoutes(webServer, fakeService())
    const calls = (webServer.register as ReturnType<typeof vi.fn>).mock.calls
    expect(calls.map(call => (call[0] as { kind: string; path: string }).path).sort()).toEqual([
      CLEANUP_NOW_PATH, LOGS_PATH, SETTINGS_PATH, STATUS_PATH, SYNC_NOW_PATH,
    ])
    expect(calls.every(call => (call[0] as { kind: string }).kind === 'exact')).toBe(true)

    dispose()
    expect(calls.every(call => call[0].handler)).toBe(true) // routes stayed mounted; the disposer owns removal
  })

  it('answers the status view on GET status', async () => {
    const { webServer } = fakeWebServer()
    registerSessionSyncRoutes(webServer, fakeService())
    const handler = (webServer.register as ReturnType<typeof vi.fn>).mock.calls
      .find(call => (call[0] as { path: string }).path === STATUS_PATH)![0].handler
    const res = await call(handler, request())
    expect(res.statusCode).toBe(200)
    expect(json(res)).toEqual(statusView)
  })

  it('runs a cycle and answers the fresh view on POST sync-now, rejecting other methods', async () => {
    const { webServer } = fakeWebServer()
    const service = fakeService()
    registerSessionSyncRoutes(webServer, service)
    const handler = (webServer.register as ReturnType<typeof vi.fn>).mock.calls
      .find(call => (call[0] as { path: string }).path === SYNC_NOW_PATH)![0].handler

    const res = await call(handler, request({ method: 'POST', host: 'localhost:3080' }))
    expect(res.statusCode).toBe(200)
    expect(service.syncNow).toHaveBeenCalled()
    expect(json(res)).toEqual(statusView)

    const refused = await call(handler, request({ method: 'GET' }))
    expect(refused.statusCode).toBe(405)
  })

  it('runs a cleanup and answers the fresh view on POST cleanup-now, rejecting other methods', async () => {
    const { webServer } = fakeWebServer()
    const service = fakeService()
    registerSessionSyncRoutes(webServer, service)
    const handler = (webServer.register as ReturnType<typeof vi.fn>).mock.calls
      .find(call => (call[0] as { path: string }).path === CLEANUP_NOW_PATH)![0].handler

    const res = await call(handler, request({ method: 'POST', host: 'localhost:3080' }))
    expect(res.statusCode).toBe(200)
    expect(service.cleanupNow).toHaveBeenCalled()
    expect(json(res)).toEqual(statusView)

    const refused = await call(handler, request({ method: 'GET' }))
    expect(refused.statusCode).toBe(405)
  })

  it('refuses cross-origin writes on sync-now, cleanup-now, and settings', async () => {
    const { webServer } = fakeWebServer()
    registerSessionSyncRoutes(webServer, fakeService())
    const syncNow = (webServer.register as ReturnType<typeof vi.fn>).mock.calls
      .find(call => (call[0] as { path: string }).path === SYNC_NOW_PATH)![0].handler
    const cleanupNow = (webServer.register as ReturnType<typeof vi.fn>).mock.calls
      .find(call => (call[0] as { path: string }).path === CLEANUP_NOW_PATH)![0].handler
    const settings = (webServer.register as ReturnType<typeof vi.fn>).mock.calls
      .find(call => (call[0] as { path: string }).path === SETTINGS_PATH)![0].handler

    const evil = await call(syncNow, request({ method: 'POST', origin: 'https://evil.example', host: 'localhost:3080' }))
    expect(evil.statusCode).toBe(403)

    const evilCleanup = await call(cleanupNow, request({ method: 'POST', origin: 'https://evil.example', host: 'localhost:3080' }))
    expect(evilCleanup.statusCode).toBe(403)

    const evilSettings = await call(settings, request({
      method: 'POST', origin: 'https://evil.example', host: 'localhost:3080', body: '{"enabled":true}',
    }))
    expect(evilSettings.statusCode).toBe(403)
  })

  it('answers the settings view on GET settings', async () => {
    const { webServer } = fakeWebServer()
    registerSessionSyncRoutes(webServer, fakeService())
    const handler = (webServer.register as ReturnType<typeof vi.fn>).mock.calls
      .find(call => (call[0] as { path: string }).path === SETTINGS_PATH)![0].handler
    const res = await call(handler, request())
    expect(res.statusCode).toBe(200)
    expect(json(res)).toEqual({ writable: true, settings: settingsValue })
  })

  it('merges a patch through the service on POST settings', async () => {
    const { webServer } = fakeWebServer()
    const service = fakeService()
    registerSessionSyncRoutes(webServer, service)
    const handler = (webServer.register as ReturnType<typeof vi.fn>).mock.calls
      .find(call => (call[0] as { path: string }).path === SETTINGS_PATH)![0].handler
    const res = await call(handler, request({ method: 'POST', host: 'localhost:3080', body: '{"enabled":true}' }))
    expect(res.statusCode).toBe(200)
    expect(json(res)).toEqual({ ok: true })
    expect(service.updateSettings).toHaveBeenCalledWith({ enabled: true })
  })

  it('answers 400 with the host message when the service refuses a write', async () => {
    const { webServer } = fakeWebServer()
    const service = fakeService({
      updateSettings: vi.fn(() => Promise.reject(new Error('session-sync: remote is required when the plugin is enabled'))),
    })
    registerSessionSyncRoutes(webServer, service)
    const handler = (webServer.register as ReturnType<typeof vi.fn>).mock.calls
      .find(call => (call[0] as { path: string }).path === SETTINGS_PATH)![0].handler
    const res = await call(handler, request({ method: 'POST', host: 'localhost:3080', body: '{"enabled":true}' }))
    expect(res.statusCode).toBe(400)
    expect(json(res)).toEqual({ error: 'session-sync: remote is required when the plugin is enabled' })
  })

  it('rejects malformed bodies with 400', async () => {
    const { webServer } = fakeWebServer()
    const service = fakeService()
    registerSessionSyncRoutes(webServer, service)
    const handler = (webServer.register as ReturnType<typeof vi.fn>).mock.calls
      .find(call => (call[0] as { path: string }).path === SETTINGS_PATH)![0].handler

    for (const body of ['not json', '"string"', '[]']) {
      const res = await call(handler, request({ method: 'POST', host: 'localhost:3080', body }))
      expect(res.statusCode).toBe(400)
    }
    expect(service.updateSettings).not.toHaveBeenCalled()
  })

  it('answers the cycle log on GET logs, defaulting the limit', async () => {
    const { webServer } = fakeWebServer()
    const service = fakeService({
      logs: vi.fn(() => Promise.resolve([{ time: '2026-08-29T08:00:00.000Z', kind: 'start' } satisfies SyncLogEntry])),
    })
    registerSessionSyncRoutes(webServer, service)
    const handler = (webServer.register as ReturnType<typeof vi.fn>).mock.calls
      .find(call => (call[0] as { path: string }).path === LOGS_PATH)![0].handler

    const res = await call(handler, request())
    expect(res.statusCode).toBe(200)
    expect(json(res)).toEqual({ entries: [{ time: '2026-08-29T08:00:00.000Z', kind: 'start' }] })
    expect(service.logs).toHaveBeenCalledWith(200)
  })

  it('parses and clamps the limit query, and rejects other methods', async () => {
    const { webServer } = fakeWebServer()
    const service = fakeService()
    registerSessionSyncRoutes(webServer, service)
    const handler = (webServer.register as ReturnType<typeof vi.fn>).mock.calls
      .find(call => (call[0] as { path: string }).path === LOGS_PATH)![0].handler

    const res = await call(handler, request({ url: '/session-sync/logs?limit=50' }))
    expect(res.statusCode).toBe(200)
    expect(service.logs).toHaveBeenCalledWith(50)

    await call(handler, request({ url: '/session-sync/logs?limit=99999' }))
    expect(service.logs).toHaveBeenCalledWith(500)

    await call(handler, request({ url: '/session-sync/logs?limit=garbage' }))
    expect(service.logs).toHaveBeenCalledWith(200)

    const refused = await call(handler, request({ method: 'POST' }))
    expect(refused.statusCode).toBe(405)
  })

  it('answers 500 when the log read fails', async () => {
    const { webServer } = fakeWebServer()
    const service = fakeService({ logs: vi.fn(() => Promise.reject(new Error('log read fault'))) })
    registerSessionSyncRoutes(webServer, service)
    const handler = (webServer.register as ReturnType<typeof vi.fn>).mock.calls
      .find(call => (call[0] as { path: string }).path === LOGS_PATH)![0].handler

    const res = await call(handler, request())
    expect(res.statusCode).toBe(500)
    expect(json(res)).toEqual({ error: 'log read fault' })
  })
})
