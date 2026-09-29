import { afterEach, describe, expect, it } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { access, mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Storage from '@deepseek-ai/dsh-storage'
import * as StorageJson from '@deepseek-ai/dsh-storage-json'
import * as StorageDomain from '@deepseek-ai/dsh-storage-domain'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import WorkspaceRegistry from '@deepseek-ai/dsh-workspace'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import SessionProjectionCache from '@deepseek-ai/dsh-session-projection-cache'
import SessionTitleService from '@deepseek-ai/dsh-session-title'
import { composeSessionSync } from './compose.ts'
import type { ComposeRow } from './compose.ts'

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

async function compose(
  prefix: string,
  home: string,
  extras: Record<string, unknown> = {},
  options: { workspaces?: boolean } = {},
): Promise<Machine> {
  const root = await mkdtemp(join(tmpdir(), prefix))
  roots.push(root)
  await mkdir(join(home, 'storages'), { recursive: true })
  await mkdir(join(home, 'sessions'), { recursive: true })

  // The storage/session services a real deployment mounts; the plugin's own
  // `session-sync` row is added by the shared composition helper. A machine
  // composed without the workspace registry models the deployments the plugin
  // supports without one — the registry is optional.
  const rows: ComposeRow[] = [
    { id: 'storage', name: 'cordis:storage' },
    { id: 'storage-json', name: 'cordis:storage-json', config: { root: join(home, 'storages') } },
    { id: 'storage-domain', name: 'cordis:storage-domain', config: { backend: 'json' } },
    { id: 'sessions', name: 'cordis:sessions' },
    { id: 'session-persistence', name: 'cordis:session-persistence', config: { root: join(home, 'sessions') } },
    ...options.workspaces === false ? [] : [{ id: 'workspaces', name: 'cordis:workspaces' }],
  ]
  const builtins: Record<string, unknown> = {
    storage: Storage,
    'storage-json': StorageJson,
    'storage-domain': StorageDomain,
    sessions: SessionStore,
    'session-persistence': JsonlSessionPersistence,
    workspaces: WorkspaceRegistry,
  }
  for (const [specifier, value] of Object.entries(extras)) {
    const extra = isExtra(value) ? value : { module: value }
    builtins[specifier] = extra.module
    rows.push({
      id: specifier,
      name: `cordis:${specifier}`,
      ...extra.config === undefined ? {} : { config: extra.config },
    })
  }

  // No automatic cycles: this spec drives every cycle through `syncNow()`, so
  // a startup timer can never race the machine the spec is exercising.
  const composed = await composeSessionSync({ home, rows, builtins, startupSyncDelayMs: 3_600_000 })
  contexts.push(composed.ctx)
  return { root, dshHome: home, context: composed.ctx }
}

async function configureSync(ctx: Context, remote: string): Promise<void> {
  await ctx.settings.update('session-sync', { enabled: true, remote })
}

/**
 * Register one directory as a workspace under an explicit title. The title is
 * the cross-machine join key: another machine's repo manifest name has to equal
 * it exactly for that machine's sessions to land here.
 * @param ctx - the machine's context.
 * @param path - an existing directory.
 * @param title - the workspace display title.
 */
async function registerWorkspace(ctx: Context, path: string, title: string): Promise<void> {
  const workspace = await ctx.workspaceRegistry.create(path)
  await workspace.setTitle(title)
}

/** The selection snapshot `sync.json` asks each machine to synchronize. */
interface SelectionSnapshot {
  entries: { id: string; key: string; workspaceName: string; title: string }[]
}

/** Clone the remote and read its `sync.json`. */
async function readSelection(bare: string, into: string): Promise<SelectionSnapshot> {
  await execFileAsync('git', ['clone', '-b', 'main', bare, into])
  return JSON.parse(await readFile(join(into, 'sync.json'), 'utf8')) as SelectionSnapshot
}

describe('session-sync Loader composition', () => {
  it('syncs a selected session between two machines with different paths, matching by workspace name', async () => {
    previousDshHome = process.env.DSH_HOME
    const setup = await mkdtemp(join(tmpdir(), 'dsh-sync-loader-'))
    roots.push(setup)
    const homeA = join(setup, 'homeA')
    const homeB = join(setup, 'homeB')
    // The two machines keep the project at DIFFERENT paths but under the SAME
    // workspace title: the name is the only join key.
    const projA = join(setup, 'projects-a', 'demo')
    const projB = join(setup, 'projects-b', 'demo')
    await mkdir(projA, { recursive: true })
    await mkdir(projB, { recursive: true })
    const bare = join(setup, 'remote.git')
    // `-b main` is load-bearing: without it the bare remote inherits the ambient
    // `init.defaultBranch` while the plugin pushes `main`.
    await execFileAsync('git', ['init', '--bare', '-b', 'main', bare])

    // Machine A: one titled session in a workspace, selected from the row menu.
    process.env.DSH_HOME = homeA
    const machineA = await compose('dsh-sync-a-', homeA)
    await registerWorkspace(machineA.context, projA, 'demo')
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
    await writerA.append(storedEvents)
    await writerA.flush()
    await writerA.close()

    await configureSync(machineA.context, bare)
    // The row menu's action: add to the shared selection. It also asks for a
    // cycle, so `syncNow` may either join that one or follow it — the repo
    // assertions below are what the test is really about.
    await machineA.context.sessionSync.selectSession('session-one')
    const statusA = await machineA.context.sessionSync.syncNow()
    expect(statusA.configured).toBe(true)
    expect(statusA.lastError).toBeUndefined()

    const checkout = join(setup, 'checkout')
    const selection = await readSelection(bare, checkout)
    expect(selection.entries.map(entry => entry.id)).toEqual(['session-one'])
    expect(selection.entries[0]?.workspaceName).toBe('demo')
    const key = selection.entries[0]!.key
    const artifact = await readFile(join(checkout, 'workspaces', key, 'session-one.jsonl'), 'utf8')
    // The artifact carries the stable workspace key, never a machine path.
    expect(artifact).toContain(`"workspace":"${key}"`)
    expect(artifact).not.toContain(projA)
    // The manifest is what the other machine matches on.
    const manifest = JSON.parse(await readFile(join(checkout, 'workspaces', key, 'manifest.json'), 'utf8')) as { key: string; name: string }
    expect(manifest.key).toBe(key)
    expect(manifest.name).toBe('demo')
    // The push was recorded with its machine and direction for the dialog.
    const records = JSON.parse(await readFile(join(checkout, 'workspaces', key, 'session-one.records.json'), 'utf8')) as {
      records: { host: string; direction: string }[]
    }
    expect(records.records.map(record => record.direction)).toEqual(['push'])

    // Machine B: same remote, same workspace TITLE, different path. The import
    // stamps B's own directory into the header and attaches the session there.
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
    await registerWorkspace(machineB.context, projB, 'demo')
    await configureSync(machineB.context, bare)
    const statusB = await machineB.context.sessionSync.syncNow()
    expect(statusB.lastError).toBeUndefined()
    expect(statusB.lastRun.imported).toBe(1)

    const importedSnapshot = (await machineB.context.sessionPersistence.list())
      .find(candidate => String(candidate.header.id) === 'session-one')
    // The registry canonicalizes (macOS resolves /var through /private), and
    // the import stamps the workspace's own canonical path.
    expect(importedSnapshot?.header.cwd).toBe(await realpath(projB))
    const workspaces = machineB.context.workspaceRegistry.list()
    expect(workspaces).toHaveLength(1)
    expect(workspaces[0]?.sessionIds ?? []).toContain(SessionId('session-one'))
    // B's own selection mirror adopted the shared one, so its row menu reads
    // 「会话同步中」 without waiting for a local click.
    expect((await machineB.context.sessionSync.selection()).total).toBe(1)

    // The import pre-warmed the projection cache: the list row's title is
    // present immediately, without opening the session.
    const importedHandle = await machineB.context.sessionPersistence.open(SessionId('session-one'), 'read')
    const titleRow = machineB.context.sessionProjectionCache.cachedSnapshot(importedHandle.header)
    await importedHandle.close()
    expect(titleRow?.values.title).toBe('cross-machine title')

    // A third machine whose workspace title does not match imports nothing and
    // reports the wait instead of guessing a location.
    const homeC = join(setup, 'homeC')
    const projC = join(setup, 'projects-c', 'renamed')
    await mkdir(projC, { recursive: true })
    process.env.DSH_HOME = homeC
    const machineC = await compose('dsh-sync-c-', homeC)
    await registerWorkspace(machineC.context, projC, 'renamed')
    await configureSync(machineC.context, bare)
    const statusC = await machineC.context.sessionSync.syncNow()
    expect(statusC.lastRun.imported).toBe(0)
    expect(statusC.pending.map(entry => entry.name)).toEqual(['demo'])
    expect(await machineC.context.sessionPersistence.list()).toEqual([])

    process.env.DSH_HOME = homeA
    // Machine A archives the session: its artifact is retired from git and the
    // grow-only mark travels to hide it on machine B.
    process.env.DSH_HOME = homeA
    await machineA.context.workspaceRegistry.archiveSession(SessionId('session-one'))
    const statusA2 = await machineA.context.sessionSync.syncNow()
    expect(statusA2.lastError).toBeUndefined()
    await execFileAsync('git', ['-C', checkout, 'pull', '--ff-only'])
    const archiveList = await readFile(join(checkout, 'workspaces', key, 'archived.json'), 'utf8')
    expect(JSON.parse(archiveList)).toEqual({ version: 1, sessionIds: ['session-one'] })
    await expect(access(join(checkout, 'workspaces', key, 'session-one.jsonl'))).rejects.toThrow()

    process.env.DSH_HOME = homeB
    const statusB2 = await machineB.context.sessionSync.syncNow()
    expect(statusB2.lastError).toBeUndefined()
    expect(statusB2.lastRun.archived).toBe(1)
    expect(machineB.context.workspaceRegistry.archivedSessionIds).toContain(SessionId('session-one'))
    // The session is still fully stored on machine B — only its visibility and
    // its git artifact changed.
    expect((await machineB.context.sessionPersistence.list()).map(candidate => String(candidate.header.id)))
      .toContain('session-one')

    // Three booted harness compositions and several real git cycles: the
    // per-test default is a load-dependent budget, not a deadlock detector.
  }, 60_000)

  it('leaves the shared selection and its artifact alone on a machine that cannot place anything', async () => {
    previousDshHome = process.env.DSH_HOME
    const setup = await mkdtemp(join(tmpdir(), 'dsh-sync-noregistry-'))
    roots.push(setup)
    const homeA = join(setup, 'homeA')
    const homeB = join(setup, 'homeB')
    const projA = join(setup, 'projects-a', 'demo')
    await mkdir(projA, { recursive: true })
    const bare = join(setup, 'remote.git')
    await execFileAsync('git', ['init', '--bare', '-b', 'main', bare])

    // Machine A selects one session and publishes it.
    process.env.DSH_HOME = homeA
    const machineA = await compose('dsh-sync-nr-a-', homeA)
    await registerWorkspace(machineA.context, projA, 'demo')
    const sessionA = machineA.context.sessions.create(SessionId('session-one'), { meta: { cwd: projA } })
    const writerA = await machineA.context.sessionPersistence.create(sessionA.header, {
      inheritedEventCount: sessionA.inheritedEventCount,
    })
    await writerA.append([
      { type: 'turn/start', seq: 0, time: 1, data: { turn: 1 } },
      { type: 'turn/end', seq: 1, time: 2, data: { turn: 1, reason: { kind: 'completed' } } },
    ] as SessionEvent[])
    await writerA.flush()
    await writerA.close()
    await configureSync(machineA.context, bare)
    await machineA.context.sessionSync.selectSession('session-one')
    expect((await machineA.context.sessionSync.syncNow()).lastError).toBeUndefined()

    // Machine B mounts no workspace registry: it can adopt the shared selection
    // but can never place a session. The adopted selection must therefore never
    // be read back as a local edit — a cycle that published it as empty would
    // retire the artifact the shared selection still names.
    process.env.DSH_HOME = homeB
    const machineB = await compose('dsh-sync-nr-b-', homeB, {}, { workspaces: false })
    await configureSync(machineB.context, bare)
    const firstB = await machineB.context.sessionSync.syncNow()
    expect(firstB.lastError).toBeUndefined()
    expect(firstB.lastRun.imported).toBe(0)
    expect(firstB.pending.map(entry => entry.name)).toEqual(['demo'])
    expect((await machineB.context.sessionSync.status()).syncedCount).toBe(1)

    const secondB = await machineB.context.sessionSync.syncNow()
    expect(secondB.lastError).toBeUndefined()
    expect(secondB.lastRun.imported).toBe(0)

    // The shared selection and its artifact are the repo's single source of
    // truth: neither changed just because B cannot place anything.
    const checkout = join(setup, 'checkout')
    const selection = await readSelection(bare, checkout)
    expect(selection.entries.map(entry => entry.id)).toEqual(['session-one'])
    const key = selection.entries[0]!.key
    const artifact = await readFile(join(checkout, 'workspaces', key, 'session-one.jsonl'), 'utf8')
    expect(artifact).toContain(`"workspace":"${key}"`)
    // B stored nothing locally: only the selection and its artifact were ever
    // at risk, and both are intact.
    expect(await machineB.context.sessionPersistence.list()).toEqual([])
  }, 60_000)

  it('removes an emptied workspace directory from the repo when its last session leaves the selection', async () => {
    previousDshHome = process.env.DSH_HOME
    const setup = await mkdtemp(join(tmpdir(), 'dsh-sync-sweep-'))
    roots.push(setup)
    const home = join(setup, 'home')
    const project = join(setup, 'projects', 'demo')
    await mkdir(project, { recursive: true })
    const bare = join(setup, 'remote.git')
    await execFileAsync('git', ['init', '--bare', '-b', 'main', bare])

    process.env.DSH_HOME = home
    const machine = await compose('dsh-sync-sweep-', home)
    await registerWorkspace(machine.context, project, 'demo')
    const session = machine.context.sessions.create(SessionId('session-one'), { meta: { cwd: project } })
    const writer = await machine.context.sessionPersistence.create(session.header, {
      inheritedEventCount: session.inheritedEventCount,
    })
    await writer.append([
      { type: 'turn/start', seq: 0, time: 1, data: { turn: 1 } },
      { type: 'turn/end', seq: 1, time: 2, data: { turn: 1, reason: { kind: 'completed' } } },
    ] as SessionEvent[])
    await writer.flush()
    await writer.close()
    await configureSync(machine.context, bare)
    await machine.context.sessionSync.selectSession('session-one')
    expect((await machine.context.sessionSync.syncNow()).lastError).toBeUndefined()

    const first = join(setup, 'checkout-first')
    const published = await readSelection(bare, first)
    const key = published.entries[0]!.key

    // Closing sync from the row menu drops the last session: its artifact is
    // retired and the emptied directory stops appearing at all. The removal
    // must be a directory operation, so `unlink`'s EPERM cannot land on the
    // cycle as a contained error.
    await machine.context.sessionSync.closeSession('session-one')
    const dropped = await machine.context.sessionSync.syncNow()
    expect(dropped.lastError).toBeUndefined()

    const checkout = join(setup, 'checkout')
    await execFileAsync('git', ['clone', '-b', 'main', bare, checkout])
    await expect(access(join(checkout, 'workspaces', key))).rejects.toThrow()

    // The cycle log is where a contained failure would surface.
    const logDir = join(home, 'session-sync', 'logs')
    const [logFile] = await readdir(logDir)
    const records = (await readFile(join(logDir, logFile!), 'utf8'))
      .trim().split('\n').map(line => JSON.parse(line) as { kind: string; errors?: string[] })
    for (const record of records.filter(entry => entry.kind === 'success')) {
      expect(record.errors).toBeUndefined()
    }
    // The local session survives: only its repo artifact is retired.
    expect((await machine.context.sessionPersistence.list()).map(candidate => String(candidate.header.id)))
      .toEqual(['session-one'])
  }, 60_000)

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
      '/session-sync/cleanup-now', '/session-sync/logs', '/session-sync/selection',
      '/session-sync/sessions', '/session-sync/settings', '/session-sync/status',
      '/session-sync/sync-now',
    ])
    expect(mounted).toBe(7)

    await machine.context.fiber.dispose()
    expect(mounted).toBe(0)
  })
})
