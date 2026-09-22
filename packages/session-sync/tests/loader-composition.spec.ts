import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import Storage from '@deepseek-ai/dsh-storage'
import * as StorageJson from '@deepseek-ai/dsh-storage-json'
import * as StorageDomain from '@deepseek-ai/dsh-storage-domain'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import SettingsFile from '@deepseek-ai/dsh-settings-file'
import JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import WorkspaceRegistry from '@deepseek-ai/dsh-workspace'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import SessionProjectionCache from '@deepseek-ai/dsh-session-projection-cache'
import SessionTitleService from '@deepseek-ai/dsh-session-title'
import SessionSyncService from '@linbin-mk/dsh-session-sync'

const execFileAsync = promisify(execFile)

let roots: string[] = []
let contexts: Context[] = []
let previousDshHome: string | undefined

afterEach(async () => {
  await Promise.all(contexts.map(async (context) => {
    try {
      await context.fiber.dispose()
    } catch {
      // A half-booted composition may reject disposal; cleanup below removes its files.
    }
  }))
  contexts = []
  // A repository a cycle just touched can still hold open handles while the
  // suite runs in parallel, and macOS then reports ENOTEMPTY for a recursive
  // rm. Retrying is the documented remedy; the removal stays unconditional.
  await Promise.all(roots.map(root => rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })))
  roots = []
  if (previousDshHome === undefined) delete process.env.DSH_HOME
  else process.env.DSH_HOME = previousDshHome
})

/** One machine: its own harness home, storage, sessions, and project dirs. */
interface Machine {
  root: string
  dshHome: string
  context: Context
}

/** An extra composed plugin: bare module or module plus a config block. */
interface Extra {
  module?: unknown
  config?: Record<string, unknown>
}

function isExtra(value: unknown): value is Extra {
  return typeof value === 'object' && value !== null && ('module' in value || 'config' in value)
}

async function compose(prefix: string, home: string, extras: Record<string, unknown> = {}): Promise<Machine> {
  const root = await mkdtemp(join(tmpdir(), prefix))
  roots.push(root)
  await mkdir(join(home, 'storages'), { recursive: true })
  await mkdir(join(home, 'sessions'), { recursive: true })

  const configPath = join(root, 'cordis.yml')
  await writeFile(configPath, [
    "- name: '@deepseek-ai/dsh-storage'",
    "- name: '@deepseek-ai/dsh-storage-json'",
    '  config:',
    `    root: ${JSON.stringify(join(home, 'storages'))}`,
    "- name: '@deepseek-ai/dsh-storage-domain'",
    '  config:',
    '    backend: json',
    "- name: '@deepseek-ai/dsh-session'",
    "- name: '@deepseek-ai/dsh-settings-file'",
    '  config:',
    `    dshHome: ${JSON.stringify(home)}`,
    '    watch: false',
    "- name: '@deepseek-ai/dsh-session-persistence-jsonl'",
    '  config:',
    `    root: ${JSON.stringify(join(home, 'sessions'))}`,
    "- name: '@deepseek-ai/dsh-workspace'",
    ...Object.entries(extras).flatMap(([name, value]) => {
      const extra = isExtra(value) ? value : { module: value }
      const config = extra.config
      return [
        `- name: ${JSON.stringify(name)}`,
        ...(config === undefined
          ? []
          : ['  config:', ...Object.entries(config).map(([key, field]) => `    ${key}: ${JSON.stringify(field)}`)]),
      ]
    }),
    "- name: '@linbin-mk/dsh-session-sync'",
    '',
  ].join('\n'))

  const context = new Context()
  contexts.push(context)
  context.baseUrl = pathToFileURL(root).href + '/'
  await context.plugin(Loader)
  context.loader.builtins.include = Include
  const modules = new Map<string, unknown>([
    ['@deepseek-ai/dsh-storage', Storage],
    ['@deepseek-ai/dsh-storage-json', StorageJson],
    ['@deepseek-ai/dsh-storage-domain', StorageDomain],
    ['@deepseek-ai/dsh-session', SessionStore],
    ['@deepseek-ai/dsh-settings-file', SettingsFile],
    ['@deepseek-ai/dsh-session-persistence-jsonl', JsonlSessionPersistence],
    ['@deepseek-ai/dsh-workspace', WorkspaceRegistry],
    ['@linbin-mk/dsh-session-sync', SessionSyncService],
    ...Object.entries(extras).map(([name, value]) => [name, isExtra(value) ? value.module : value] as const),
  ])
  context.loader.internal = {
    version: 'v2',
    async import(specifier: string) {
      if (!modules.has(specifier)) throw new Error(`unexpected Loader import: ${specifier}`)
      return modules.get(specifier)
    },
  } as unknown as NonNullable<typeof context.loader.internal>
  await context.loader.create({
    name: 'cordis:include',
    config: { path: pathToFileURL(configPath).href },
  })
  await context.loader.await()
  return { root, dshHome: home, context }
}

async function configureSync(ctx: Context, remote: string, path: string, key: string): Promise<void> {
  await ctx.settings.update('session-sync', {
    enabled: true,
    remote,
    mappings: [{ key, path }],
  })
}

describe('session-sync Loader composition', () => {
  it('syncs sessions between two machines with different project paths through a git remote', async () => {
    previousDshHome = process.env.DSH_HOME
    const setup = await mkdtemp(join(tmpdir(), 'dsh-sync-loader-'))
    roots.push(setup)
    const homeA = join(setup, 'homeA')
    const homeB = join(setup, 'homeB')
    const projA = join(setup, 'projects', 'demo-a')
    const projB = join(setup, 'projects', 'demo-b')
    await mkdir(projA, { recursive: true })
    await mkdir(projB, { recursive: true })
    const bare = join(setup, 'remote.git')
    await execFileAsync('git', ['init', '--bare', bare])

    // Machine A: create one session, configure the mapping, sync it out.
    process.env.DSH_HOME = homeA
    const machineA = await compose('dsh-sync-a-', homeA)
    const sessionA = machineA.context.sessions.create(SessionId('session-one'), { meta: { cwd: projA } })
    const writerA = await machineA.context.sessionPersistence.create(sessionA.header, {
      inheritedEventCount: sessionA.inheritedEventCount,
    })
    const storedEvents = [
      { type: 'turn/start', seq: 0, time: 1, data: { turn: 1 } },
      { type: 'turn/end', seq: 1, time: 2, data: { turn: 1, reason: { kind: 'completed' } } },
      {
        type: 'session/title', seq: 2, time: 3,
        data: { title: 'cross-machine title', messageSeqs: [], source: { kind: 'user' } },
      },
    ] as SessionEvent[]
    // A durable log-backed title: it travels verbatim in the artifact and
    // must reach machine B's list row without opening the session there.
    await writerA.append(storedEvents)
    await writerA.flush()
    await writerA.close()
    const storedA = (await machineA.context.sessionPersistence.list())
      .find(snapshot => snapshot.header.id === SessionId('session-one'))
    expect(storedA?.header.cwd).toBe(projA)
    const readerA = await machineA.context.sessionPersistence.open(SessionId('session-one'), 'read')
    expect((await readerA.read()).events).toHaveLength(3)
    await readerA.close()

    await configureSync(machineA.context, bare, projA, 'demo')
    expect(machineA.context.sessionSync.getSettings().mappings).toEqual([{ key: 'demo', path: projA }])
    const statusA = await machineA.context.sessionSync.syncNow()
    expect(statusA.configured).toBe(true)
    expect(statusA.lastError).toBeUndefined()
    expect(statusA.lastRun.pushed).toBe(1)

    // The remote now carries a portable artifact stamped with the project key.
    const checkout = join(setup, 'checkout')
    await execFileAsync('git', ['clone', '-b', 'main', bare, checkout])
    const artifact = await readFile(join(checkout, 'projects', 'demo', 'session-one.jsonl'), 'utf8')
    expect(artifact).toContain('"project":"demo"')
    expect(artifact).not.toContain(projA)

    // Machine B: same remote, different project path — pull imports the
    // session. The projection services are composed to prove the import
    // pre-warms the projection cache (the list row's title data source).
    process.env.DSH_HOME = homeB
    const machineB = await compose('dsh-sync-b-', homeB, {
      '@deepseek-ai/dsh-session-projection': SessionProjectionRegistry,
      '@deepseek-ai/dsh-session-projection-cache': {
        module: SessionProjectionCache,
        config: { writeEveryEvents: 1, writeIntervalMs: 1000 },
      },
      '@deepseek-ai/dsh-session-title': {
        module: SessionTitleService,
        config: { fallbackMaxWords: 8, fallbackMaxBytes: 200, maxTitleBytes: 200 },
      },
    })
    await configureSync(machineB.context, bare, projB, 'demo')
    const statusB = await machineB.context.sessionSync.syncNow()
    expect(statusB.lastError).toBeUndefined()
    expect(statusB.lastRun.imported).toBe(1)

    const imported = await machineB.context.sessionPersistence.list()
    const importedSnapshot = imported.find(candidate => String(candidate.header.id) === 'session-one')
    expect(importedSnapshot?.header.cwd).toBe(projB)
    const workspaces = machineB.context.workspaceRegistry.list()
    expect(workspaces).toHaveLength(1)
    expect(workspaces[0]?.sessionIds ?? []).toContain(SessionId('session-one'))

    // The import pre-warmed the projection cache: the session list row's
    // title data is present immediately, without opening the session (the
    // cold read would lazily write the same row; the pre-warm makes the very
    // first listing correct instead of falling back to the project name).
    const importedHandle = await machineB.context.sessionPersistence.open(SessionId('session-one'), 'read')
    const titleRow = machineB.context.sessionProjectionCache.cachedSnapshot(
      importedHandle.header,
      importedHandle.inheritedEventCount,
    )
    await importedHandle.close()
    expect(titleRow?.values.title).toBe('cross-machine title')

    // Machine A archives the session: its repo artifact is retired from git,
    // and the grow-only mark travels with it to hide the session on machine B.
    process.env.DSH_HOME = homeA
    await machineA.context.workspaceRegistry.archiveSession(SessionId('session-one'))
    const statusA2 = await machineA.context.sessionSync.syncNow()
    expect(statusA2.lastError).toBeUndefined()
    expect(statusA2.lastRun.deleted).toBe(1)
    await execFileAsync('git', ['-C', checkout, 'pull', '--ff-only'])
    const archiveList = await readFile(join(checkout, 'projects', 'demo', 'archived.json'), 'utf8')
    expect(JSON.parse(archiveList)).toEqual({ version: 1, sessionIds: ['session-one'] })
    await expect(access(join(checkout, 'projects', 'demo', 'session-one.jsonl'))).rejects.toThrow()

    process.env.DSH_HOME = homeB
    const statusB2 = await machineB.context.sessionSync.syncNow()
    expect(statusB2.lastError).toBeUndefined()
    expect(statusB2.lastRun.archived).toBe(1)
    expect(machineB.context.workspaceRegistry.archivedSessionIds).toContain(SessionId('session-one'))
    // The session is still fully stored on machine B — only its visibility
    // and its git artifact changed.
    expect((await machineB.context.sessionPersistence.list()).map(candidate => String(candidate.header.id)))
      .toContain('session-one')
    // Machine B's cycle must not resurrect the retired artifact.
    await execFileAsync('git', ['-C', checkout, 'pull', '--ff-only'])
    await expect(access(join(checkout, 'projects', 'demo', 'session-one.jsonl'))).rejects.toThrow()

    // Unmapped machines import nothing: a third machine with no mapping keeps its registry empty.
    const homeC = join(setup, 'homeC')
    process.env.DSH_HOME = homeC
    const machineC = await compose('dsh-sync-c-', homeC)
    await machineC.context.settings.update('session-sync', {
      enabled: true,
      remote: bare,
      mappings: [],
    })
    const statusC = await machineC.context.sessionSync.syncNow()
    expect(statusC.lastRun.imported).toBe(0)
    expect(await machineC.context.sessionPersistence.list()).toEqual([])
    expect(machineC.context.workspaceRegistry.list()).toEqual([])
  })

  it('registers its HTTP routes on a mounted webServer and removes them on disposal', async () => {
    previousDshHome = process.env.DSH_HOME
    const setup = await mkdtemp(join(tmpdir(), 'dsh-sync-web-'))
    roots.push(setup)
    const home = join(setup, 'home')
    process.env.DSH_HOME = home

    const registered: string[] = []
    let mounted = 0
    const fakeWebServer = {
      name: 'fake-webserver',
      apply: (ctx: Context) => {
        ctx.provide('webServer', {
          register(route: { kind: string; path: string }) {
            registered.push(route.path)
            mounted += 1
            return () => { mounted -= 1 }
          },
        })
      },
    }

    const machine = await compose('dsh-sync-web-', home, { 'fake-webserver': fakeWebServer })
    expect(registered.sort()).toEqual([
      '/session-sync/cleanup-now', '/session-sync/logs', '/session-sync/settings', '/session-sync/status', '/session-sync/sync-now',
    ])
    expect(mounted).toBe(5)

    await machine.context.fiber.dispose()
    expect(mounted).toBe(0)
  })
})
