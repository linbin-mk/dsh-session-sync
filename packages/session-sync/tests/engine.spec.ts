import { describe, expect, it } from 'vitest'
import { SESSION_FORMAT_VERSION, SessionId, SessionLogOffset } from '@deepseek-ai/dsh-session'
import type { SessionEvent, SessionHeader } from '@deepseek-ai/dsh-session'
import {
  compareLogs, runSyncCycle,
} from '../src/engine.ts'
import type { SyncEngineDeps, SyncFilesystem, SyncGit, SyncPersistence, SyncProjectionCache, SyncWorkspaceRegistry } from '../src/engine.ts'
import { ARCHIVE_NAME, MANIFEST_NAME, serializeArchiveList, serializeManifest } from '../src/format.ts'
import { DEFAULT_BRANCH, DEFAULT_INTERVAL_MINUTES } from '../src/settings.ts'
import type { SessionSyncSettings } from '../src/settings.ts'

function header(id: string, cwd: string, createdAt = 1): SessionHeader {
  return { version: SESSION_FORMAT_VERSION, id: SessionId(id), createdAt, cwd, isSeeded: false, delegationDepth: 0 }
}

function events(count: number, offset = 0): SessionEvent[] {
  const list: SessionEvent[] = []
  for (let index = 0; index < count; index++) {
    const turn = offset + index + 1
    list.push({ type: 'turn/start', seq: list.length, time: turn * 2, data: { turn } } as SessionEvent)
    list.push({ type: 'turn/end', seq: list.length, time: turn * 2 + 1, data: { turn, reason: { kind: 'completed' } } } as SessionEvent)
  }
  return list
}

/** A log left mid-turn: the turn started a step and never closed it. */
function midTurnEvents(): SessionEvent[] {
  return [
    { type: 'turn/start', seq: 0, time: 1, data: { turn: 1 } } as SessionEvent,
    { type: 'step/start', seq: 1, time: 2, data: { turn: 1, step: 1 } } as SessionEvent,
  ]
}

function artifactForEvents(id: string, key: string, list: SessionEvent[]): string {
  const meta = header(id, key)
  const lines = [
    JSON.stringify({
      type: 'dsh-session-sync', version: 1, project: key, inheritedEventCount: 0,
      session: { version: SESSION_FORMAT_VERSION, id, createdAt: meta.createdAt, isSeeded: false, delegationDepth: 0 },
    }),
    ...list.map(event => JSON.stringify(event)),
  ]
  return lines.join('\n') + '\n'
}

function artifactFor(id: string, key: string, count: number): string {
  return artifactForEvents(id, key, events(count))
}

/** Fake persistence storing one map of session id → events. */
class FakePersistence implements SyncPersistence {
  readonly sessions = new Map<string, { meta: SessionHeader; inheritedEventCount: ReturnType<typeof SessionLogOffset>; events: SessionEvent[] }>()
  readonly appendCalls: { id: string; count: number }[] = []
  created: string[] = []
  failReadFrom = false
  failAttachOn: string[] = []
  phantomList: string[] = []
  noCwdList: string[] = []
  throwStringOn?: string

  seed(id: string, cwd: string, count: number): void {
    this.sessions.set(id, { meta: header(id, cwd), inheritedEventCount: SessionLogOffset(0), events: events(count) })
  }

  seedEvents(id: string, cwd: string, list: SessionEvent[]): void {
    this.sessions.set(id, { meta: header(id, cwd), inheritedEventCount: SessionLogOffset(0), events: list })
  }

  async inspect(id: SessionId): Promise<{ meta: SessionHeader; inheritedEventCount: ReturnType<typeof SessionLogOffset>; events: SessionEvent[] } | undefined> {
    const stored = this.sessions.get(String(id))
    if (stored === undefined) return undefined
    if (this.throwStringOn === 'inspect') throw 'inspect string failure'
    if (this.failReadFrom) throw new Error('readFrom failed')
    return { meta: stored.meta, inheritedEventCount: stored.inheritedEventCount, events: [...stored.events] }
  }

  async create(session: { meta: SessionHeader; inheritedEventCount: ReturnType<typeof SessionLogOffset>; events: SessionEvent[] }): Promise<void> {
    this.created.push(String(session.meta.id))
    this.sessions.set(String(session.meta.id), {
      meta: session.meta,
      inheritedEventCount: session.inheritedEventCount,
      events: [...session.events],
    })
  }

  async append(id: SessionId, batch: readonly SessionEvent[]): Promise<void> {
    const stored = this.sessions.get(String(id))
    if (stored === undefined) throw new Error(`session "${id}" not found`)
    this.appendCalls.push({ id: String(id), count: batch.length })
    stored.events.push(...batch)
  }

  async list(): Promise<SessionHeader[]> {
    return [
      ...[...this.sessions.values()].map(stored => stored.meta),
      ...this.phantomList.map(id => header(id, '/work/demo')),
      ...this.noCwdList.map((id): SessionHeader => ({
        version: SESSION_FORMAT_VERSION,
        id: SessionId(id),
        createdAt: 1,
        isSeeded: false,
        delegationDepth: 0,
      })),
    ]
  }
}

/** Fake projection cache: `warm` records the call and, like the real cold-read write-back, makes the row served. */
class FakeProjectionCache implements SyncProjectionCache {
  readonly warmed: string[] = []
  readonly servedIds = new Set<string>()
  failOn: string[] = []

  async warm(id: SessionId): Promise<void> {
    if (this.failOn.includes(String(id))) throw new Error('warm rejected')
    this.warmed.push(String(id))
    this.servedIds.add(String(id))
  }
}

/** Fake workspace registry: one map of path → attached ids plus a grow-only archive set. */
class FakeWorkspaces implements SyncWorkspaceRegistry {
  readonly attached = new Map<string, string[]>()
  readonly archivedIds: SessionId[] = []
  createCalls: string[] = []
  failAttachOn: string[] = []
  failArchiveOn: string[] = []

  async resolveByPath(path: string): Promise<{ attachSession(id: SessionId): Promise<void> } | undefined> {
    return this.attached.has(path) ? { attachSession: id => this.attach(path, id) } : undefined
  }

  async create(path: string): Promise<{ attachSession(id: SessionId): Promise<void> }> {
    this.createCalls.push(path)
    this.attached.set(path, [])
    return { attachSession: id => this.attach(path, id) }
  }

  archivedSessionIds(): readonly SessionId[] {
    return this.archivedIds
  }

  async archiveSession(id: SessionId): Promise<void> {
    if (this.failArchiveOn.includes(String(id))) throw new Error('archive rejected')
    this.archivedIds.push(id)
  }

  private async attach(path: string, id: SessionId): Promise<void> {
    if (this.failAttachOn.includes(path)) throw new Error('attach rejected')
    this.attached.get(path)!.push(String(id))
  }
}

/** In-memory repo filesystem. */
class FakeFilesystem implements SyncFilesystem {
  readonly hostname = 'test-host'
  readonly files = new Map<string, string>()
  readonly deleted: string[] = []
  /** File names listFiles reports but readRepoFile answers undefined for. */
  phantom: string[] = []

  constructor(seed?: Record<string, string>) {
    for (const [rel, content] of Object.entries(seed ?? {})) this.files.set(rel, content)
  }

  async readRepoFile(rel: string): Promise<string | undefined> {
    if (this.phantom.includes(rel)) return undefined
    return this.files.get(rel)
  }

  async writeRepoFile(rel: string, content: string): Promise<void> {
    this.files.set(rel, content)
  }

  async deleteRepoFile(rel: string): Promise<boolean> {
    if (!this.files.has(rel)) return false
    this.files.delete(rel)
    this.deleted.push(rel)
    return true
  }

  async listDirs(rel: string): Promise<string[]> {
    const prefix = rel === '' ? '' : `${rel}/`
    const names = [
      ...[...this.files.keys()]
        .filter(key => key.startsWith(prefix))
        .map(key => key.slice(prefix.length).split('/')[0]!),
      ...this.phantom
        .filter(name => name.startsWith(prefix))
        .map(name => name.slice(prefix.length).split('/')[0]!),
    ]
    return [...new Set(names)].filter(name => !name.includes('.'))
  }

  async listFiles(rel: string): Promise<string[]> {
    const prefix = `${rel}/`
    return [
      ...[...this.files.keys()]
        .filter(key => key.startsWith(prefix))
        .map(key => key.slice(prefix.length))
        .filter(name => !name.includes('/')),
      ...this.phantom.map(name => name.slice(`${rel}/`.length)).filter(name => !name.includes('/')),
    ]
  }
}

/** Fake git recording the call order. */
class FakeGit implements SyncGit {
  readonly calls: string[] = []
  failAt?: string

  private step(name: string): void {
    this.calls.push(name)
    if (this.failAt === name) throw new Error(`git ${name} failed`)
  }

  ensure(): Promise<void> { this.step('ensure'); return Promise.resolve() }
  fetch(): Promise<void> { this.step('fetch'); return Promise.resolve() }
  resetHard(): Promise<void> { this.step('resetHard'); return Promise.resolve() }
  addAll(): Promise<void> { this.step('addAll'); return Promise.resolve() }
  commit(message: string): Promise<void> { this.step(`commit:${message}`); return Promise.resolve() }
  push(): Promise<void> { this.step('push'); return Promise.resolve() }
}

function settings(overrides: Partial<SessionSyncSettings> = {}): SessionSyncSettings {
  return {
    enabled: true,
    remote: 'git@example.com:team/repo.git',
    branch: DEFAULT_BRANCH,
    intervalMinutes: DEFAULT_INTERVAL_MINUTES,
    mappings: [{ key: 'demo', path: '/work/demo' }],
    cleanup: { enabled: false, periodHours: 24, keepCommits: 200 },
    ...overrides,
  }
}

function deps(overrides: Partial<SyncEngineDeps> = {}): {
  deps: SyncEngineDeps
  persistence: FakePersistence
  workspaces: FakeWorkspaces
  projectionCache: FakeProjectionCache
  fs: FakeFilesystem
  git: FakeGit
  warnings: string[]
} {
  const persistence = overrides.persistence as FakePersistence ?? new FakePersistence()
  const workspaces = overrides.workspaces as FakeWorkspaces ?? new FakeWorkspaces()
  const projectionCache = overrides.projectionCache as FakeProjectionCache ?? new FakeProjectionCache()
  const fs = overrides.fs as FakeFilesystem ?? new FakeFilesystem()
  const git = overrides.git as FakeGit ?? new FakeGit()
  const warnings: string[] = []
  return {
    deps: {
      settings: settings(),
      persistence,
      workspaces,
      projectionCache,
      fs,
      git,
      logger: { warn: message => warnings.push(message) },
      ...overrides,
    },
    persistence,
    workspaces,
    projectionCache,
    fs,
    git,
    warnings,
  }
}

describe('compareLogs', () => {
  it('relates equal, prefix, and divergent logs', () => {
    const a = events(3)
    const b = events(3)
    expect(compareLogs(a, b)).toBe('equal')
    expect(compareLogs(a, events(5))).toBe('local-prefix')
    expect(compareLogs(events(5), a)).toBe('remote-prefix')
    const divergent = [...events(2), { type: 'turn/start', seq: 2, data: { turn: 99 } } as SessionEvent]
    expect(compareLogs(a, divergent)).toBe('divergent')
  })
})

describe('runSyncCycle import', () => {
  it('imports a fresh session for a mapped project and attaches it to the workspace', async () => {
    const world = deps()
    world.fs.files.set('projects/demo/session-remote.jsonl', artifactFor('session-remote', 'demo', 3))
    const result = await runSyncCycle(world.deps)

    expect(result.imported).toBe(1)
    expect(world.persistence.created).toEqual(['session-remote'])
    expect(world.persistence.sessions.get('session-remote')!.events).toHaveLength(6)
    expect(world.persistence.sessions.get('session-remote')!.meta.cwd).toBe('/work/demo')
    expect(world.workspaces.createCalls).toEqual(['/work/demo'])
    expect(world.workspaces.attached.get('/work/demo')).toEqual(['session-remote'])
    expect(world.fs.files.get(MANIFEST_NAME)).toBe(serializeManifest(['demo']))
  })

  it('skips projects with no mapping', async () => {
    const world = deps()
    world.fs.files.set('projects/other/session-x.jsonl', artifactFor('session-x', 'other', 1))
    const result = await runSyncCycle(world.deps)

    expect(result.imported).toBe(0)
    expect(world.persistence.sessions.has('session-x')).toBe(false)
    expect(world.fs.files.get(MANIFEST_NAME)).toBe(serializeManifest(['demo', 'other']))
  })

  it('extends a local session when the remote log is a strict superset', async () => {
    const world = deps()
    world.persistence.seed('session-a', '/work/demo', 3)
    world.fs.files.set('projects/demo/session-a.jsonl', artifactFor('session-a', 'demo', 5))
    const result = await runSyncCycle(world.deps)

    expect(result.imported).toBe(1)
    expect(world.persistence.appendCalls).toEqual([{ id: 'session-a', count: 4 }])
    expect(world.persistence.sessions.get('session-a')!.events).toHaveLength(10)
  })

  it('imports nothing when local equals or extends the remote log', async () => {
    const world = deps()
    world.persistence.seed('session-a', '/work/demo', 5)
    world.fs.files.set('projects/demo/session-a.jsonl', artifactFor('session-a', 'demo', 5))
    let result = await runSyncCycle(world.deps)
    expect(result.imported).toBe(0)
    expect(world.persistence.appendCalls).toEqual([])

    world.fs.files.set('projects/demo/session-a.jsonl', artifactFor('session-a', 'demo', 3))
    result = await runSyncCycle(world.deps)
    expect(result.imported).toBe(0)
    expect(world.persistence.appendCalls).toEqual([])
  })

  it('preserves a divergent remote log as a conflict copy instead of merging', async () => {
    const world = deps()
    world.persistence.seed('session-a', '/work/demo', 3)
    const remote = artifactFor('session-a', 'demo', 3).replace('"turn":2', '"turn":99')
    world.fs.files.set('projects/demo/session-a.jsonl', remote)
    const result = await runSyncCycle(world.deps)

    expect(result.imported).toBe(0)
    expect(result.conflicts).toEqual(['conflicts/demo/session-a-test-host.jsonl'])
    expect(world.fs.files.get('conflicts/demo/session-a-test-host.jsonl')).toBe(remote)
    expect(world.persistence.appendCalls).toEqual([])
  })

  it('skips a repo artifact that ends mid-turn instead of importing a truncated snapshot', async () => {
    const world = deps()
    world.fs.files.set('projects/demo/session-live.jsonl', artifactForEvents('session-live', 'demo', midTurnEvents()))
    const result = await runSyncCycle(world.deps)

    expect(result.imported).toBe(0)
    expect(world.persistence.sessions.has('session-live')).toBe(false)
    expect(result.errors.some(message => message.includes('ends mid-turn'))).toBe(true)
  })

  it('records an error for unparsable artifacts and bad file names', async () => {
    const world = deps()
    world.fs.files.set('projects/demo/session-bad.jsonl', 'not json\n')
    world.fs.files.set('projects/demo/README.md', 'hello\n')
    const result = await runSyncCycle(world.deps)

    expect(result.imported).toBe(0)
    expect(result.errors).toHaveLength(2)
    expect(result.errors[0]).toContain('demo/session-bad')
    expect(result.errors[1]).toContain('README.md')
  })

  it('does not attach when the composition mounts no workspace registry', async () => {
    const world = deps()
    delete world.deps.workspaces
    world.fs.files.set('projects/demo/session-remote.jsonl', artifactFor('session-remote', 'demo', 1))
    const result = await runSyncCycle(world.deps)
    expect(result.imported).toBe(1)
  })

  it('records an attach failure and keeps the imported session', async () => {
    const world = deps()
    world.workspaces.failAttachOn = ['/work/demo']
    world.fs.files.set('projects/demo/session-remote.jsonl', artifactFor('session-remote', 'demo', 1))
    const result = await runSyncCycle(world.deps)

    expect(result.imported).toBe(1)
    expect(result.errors.some(message => message.includes('attach'))).toBe(true)
  })

  it('skips a repo file that disappears between listing and reading', async () => {
    const world = deps()
    world.fs.phantom = ['projects/demo/session-remote.jsonl']
    const result = await runSyncCycle(world.deps)
    expect(result.imported).toBe(0)
    expect(result.errors).toEqual([])
  })

  it('creates a header-only session without appending events', async () => {
    const world = deps()
    world.fs.files.set('projects/demo/session-empty.jsonl', artifactFor('session-empty', 'demo', 0))
    const result = await runSyncCycle(world.deps)

    expect(result.imported).toBe(1)
    expect(world.persistence.appendCalls).toEqual([])
    expect(world.persistence.sessions.get('session-empty')!.events).toHaveLength(0)
  })

  it('pre-warms the projection cache for created and extended sessions', async () => {
    const fresh = deps()
    fresh.fs.files.set('projects/demo/session-remote.jsonl', artifactFor('session-remote', 'demo', 3))
    const freshResult = await runSyncCycle(fresh.deps)
    expect(freshResult.imported).toBe(1)
    expect(fresh.projectionCache.warmed).toEqual(['session-remote'])

    const extended = deps()
    extended.persistence.seed('session-a', '/work/demo', 3)
    extended.fs.files.set('projects/demo/session-a.jsonl', artifactFor('session-a', 'demo', 5))
    const extendedResult = await runSyncCycle(extended.deps)
    expect(extendedResult.imported).toBe(1)
    expect(extended.projectionCache.warmed).toEqual(['session-a'])
  })

  it('does not warm sessions the cycle did not import', async () => {
    const world = deps()
    world.persistence.seed('session-a', '/work/demo', 5)
    world.projectionCache.servedIds.add('session-a')
    world.fs.files.set('projects/demo/session-a.jsonl', artifactFor('session-a', 'demo', 5))
    let result = await runSyncCycle(world.deps)
    expect(result.imported).toBe(0)
    expect(world.projectionCache.warmed).toEqual([])

    // remote-prefix: local already extends the repo, nothing appended.
    world.fs.files.set('projects/demo/session-a.jsonl', artifactFor('session-a', 'demo', 3))
    result = await runSyncCycle(world.deps)
    expect(result.imported).toBe(0)
    expect(world.projectionCache.warmed).toEqual([])
  })

  it('skips warm-up when the composition mounts no projection cache', async () => {
    const world = deps()
    delete world.deps.projectionCache
    world.fs.files.set('projects/demo/session-remote.jsonl', artifactFor('session-remote', 'demo', 1))
    const result = await runSyncCycle(world.deps)
    expect(result.imported).toBe(1)
    expect(result.errors).toEqual([])
  })

  it('contains a warm-up failure and still reports the import', async () => {
    const world = deps()
    world.projectionCache.failOn = ['session-remote']
    world.fs.files.set('projects/demo/session-remote.jsonl', artifactFor('session-remote', 'demo', 1))
    const result = await runSyncCycle(world.deps)

    expect(result.imported).toBe(1)
    expect(result.errors).toEqual([])
    expect(world.warnings.some(message => message.includes('projection warm-up'))).toBe(true)
  })

  it('reports imported ids for switch-notice arming on create and extend, skipping subagent sessions', async () => {
    const world = deps()
    world.fs.files.set('projects/demo/session-remote.jsonl', artifactFor('session-remote', 'demo', 3))
    let result = await runSyncCycle(world.deps)
    expect(result.importedIds).toEqual(['session-remote'])

    // Extend: the repo grows while local state is a prefix → imported again.
    world.fs.files.set('projects/demo/session-remote.jsonl', artifactFor('session-remote', 'demo', 5))
    result = await runSyncCycle(world.deps)
    expect(result.imported).toBe(1)
    expect(result.importedIds).toEqual(['session-remote'])
    expect(world.persistence.sessions.get('session-remote')!.events).toHaveLength(10)

    // Equal logs import nothing: no switch mark.
    result = await runSyncCycle(world.deps)
    expect(result.imported).toBe(0)
    expect(result.importedIds).toEqual([])

    // A subagent session still imports, but never arms a user-chat notice.
    const subartifact = [
      JSON.stringify({
        type: 'dsh-session-sync', version: 1, project: 'demo', inheritedEventCount: 0,
        session: {
          version: SESSION_FORMAT_VERSION, id: 'session-sub', createdAt: 1,
          isSeeded: false, origin: 'subagent', delegationDepth: 0,
        },
      }),
      ...events(1).map(event => JSON.stringify(event)),
      '',
    ].join('\n')
    world.fs.files.set('projects/demo/session-sub.jsonl', subartifact)
    result = await runSyncCycle(world.deps)
    expect(result.imported).toBe(1)
    expect(result.importedIds).toEqual([])
    expect(world.persistence.created).toContain('session-sub')
  })
})

describe('runSyncCycle export', () => {
  it('pushes a mapped session the repo does not carry yet', async () => {
    const world = deps()
    world.persistence.seed('session-local', '/work/demo', 2)
    const result = await runSyncCycle(world.deps)

    expect(result.pushed).toBe(1)
    const artifact = world.fs.files.get('projects/demo/session-local.jsonl')
    expect(artifact).toBeDefined()
    expect(artifact).toContain('"project":"demo"')
    expect(artifact).not.toContain('/work/demo')
  })

  it('skips sessions whose cwd does not map to any project', async () => {
    const world = deps()
    world.persistence.seed('session-elsewhere', '/elsewhere/project', 2)
    const result = await runSyncCycle(world.deps)
    expect(result.pushed).toBe(0)
    expect(world.fs.files.has('projects/demo/session-elsewhere.jsonl')).toBe(false)
  })

  it('leaves the repo file untouched when local equals it', async () => {
    const world = deps()
    world.persistence.seed('session-a', '/work/demo', 3)
    const remote = artifactFor('session-a', 'demo', 3)
    world.fs.files.set('projects/demo/session-a.jsonl', remote)
    const result = await runSyncCycle(world.deps)
    expect(result.pushed).toBe(0)
    expect(world.fs.files.get('projects/demo/session-a.jsonl')).toBe(remote)
  })

  it('overwrites the repo file when local extends it', async () => {
    const world = deps()
    world.persistence.seed('session-a', '/work/demo', 5)
    world.fs.files.set('projects/demo/session-a.jsonl', artifactFor('session-a', 'demo', 3))
    const result = await runSyncCycle(world.deps)
    expect(result.pushed).toBe(1)
  })

  it('preserves a divergent repo tail as a conflict copy and leaves the repo artifact untouched', async () => {
    const world = deps()
    world.persistence.seed('session-a', '/work/demo', 3)
    const remote = artifactFor('session-a', 'demo', 3).replace('"turn":2', '"turn":99')
    world.fs.files.set('projects/demo/session-a.jsonl', remote)
    const result = await runSyncCycle(world.deps)

    expect(result.pushed).toBe(0)
    expect(result.conflicts).toEqual(['conflicts/demo/session-a-test-host.jsonl'])
    expect(world.fs.files.get('conflicts/demo/session-a-test-host.jsonl')).toBe(remote)
    // The repo artifact is never overwritten by a divergent local log.
    expect(world.fs.files.get('projects/demo/session-a.jsonl')).toBe(remote)
  })

  it('skips exporting a session whose stored log ends mid-turn', async () => {
    const world = deps()
    world.persistence.seedEvents('session-live', '/work/demo', midTurnEvents())
    const result = await runSyncCycle(world.deps)

    expect(result.pushed).toBe(0)
    expect(result.errors).toEqual([])
    expect(world.fs.files.has('projects/demo/session-live.jsonl')).toBe(false)
  })

  it('overwrites an unparsable repo artifact and records the failure', async () => {
    const world = deps()
    world.persistence.seed('session-a', '/work/demo', 2)
    world.fs.files.set('projects/demo/session-a.jsonl', 'broken\n')
    const result = await runSyncCycle(world.deps)
    expect(result.pushed).toBe(1)
    expect(result.errors.some(message => message.includes('unparsable'))).toBe(true)
  })

  it('reports a contained per-session failure without failing the cycle', async () => {
    const world = deps()
    world.persistence.seed('session-a', '/work/demo', 2)
    world.fs.files.set('projects/demo/session-a.jsonl', artifactFor('session-a', 'demo', 2))
    world.persistence.failReadFrom = true
    const result = await runSyncCycle(world.deps)
    expect(result.errors.some(message => message.includes('readFrom failed'))).toBe(true)
  })

  it('ignores listed headers without a cwd', async () => {
    const world = deps()
    world.persistence.noCwdList = ['session-nocwd']
    const result = await runSyncCycle(world.deps)
    expect(result.pushed).toBe(0)
    expect(result.errors).toEqual([])
  })

  it('skips a listed session whose raw artifact is gone', async () => {
    const world = deps()
    world.persistence.phantomList = ['session-gone']
    const result = await runSyncCycle(world.deps)
    expect(result.pushed).toBe(0)
    expect(result.errors).toEqual([])
  })
})

describe('runSyncCycle archive import', () => {
  it('applies repo archive marks to locally held sessions and skips unknown ids', async () => {
    const world = deps()
    world.fs.files.set('projects/demo/session-remote.jsonl', artifactFor('session-remote', 'demo', 1))
    world.fs.files.set('projects/demo/archived.json', serializeArchiveList([
      SessionId('session-remote'), SessionId('session-ghost'),
    ]))
    const result = await runSyncCycle(world.deps)

    expect(result.imported).toBe(1)
    expect(result.archived).toBe(1)
    expect(world.workspaces.archivedIds.map(String)).toEqual(['session-remote'])
  })

  it('marks an already imported local session and skips ids already archived', async () => {
    const world = deps()
    world.persistence.seed('session-a', '/work/demo', 1)
    world.workspaces.archivedIds.push(SessionId('session-a'))
    world.fs.files.set('projects/demo/archived.json', serializeArchiveList([
      SessionId('session-a'), SessionId('session-b'),
    ]))
    const result = await runSyncCycle(world.deps)

    expect(result.archived).toBe(0)
    expect(world.workspaces.archivedIds.map(String)).toEqual(['session-a'])
  })

  it('records an unparsable archive list and skips its marks', async () => {
    const world = deps()
    world.fs.files.set('projects/demo/session-remote.jsonl', artifactFor('session-remote', 'demo', 1))
    world.fs.files.set('projects/demo/archived.json', 'broken\n')
    const result = await runSyncCycle(world.deps)

    expect(result.imported).toBe(1)
    expect(result.archived).toBe(0)
    expect(result.errors.some(message => message.includes('archived.json'))).toBe(true)
  })

  it('contains a per-id archive failure and keeps the session imported', async () => {
    const world = deps()
    world.fs.files.set('projects/demo/session-remote.jsonl', artifactFor('session-remote', 'demo', 1))
    world.fs.files.set('projects/demo/archived.json', serializeArchiveList([SessionId('session-remote')]))
    world.workspaces.failArchiveOn = ['session-remote']
    const result = await runSyncCycle(world.deps)

    expect(result.imported).toBe(1)
    expect(result.archived).toBe(0)
    expect(result.errors.some(message => message.includes('archive session-remote'))).toBe(true)
  })

  it('skips archive application when the composition mounts no workspace registry', async () => {
    const world = deps()
    delete world.deps.workspaces
    world.fs.files.set('projects/demo/session-remote.jsonl', artifactFor('session-remote', 'demo', 1))
    world.fs.files.set('projects/demo/archived.json', serializeArchiveList([SessionId('session-remote')]))
    const result = await runSyncCycle(world.deps)

    expect(result.imported).toBe(1)
    expect(result.archived).toBe(0)
    expect(result.errors).toEqual([])
  })
})

describe('runSyncCycle archive export', () => {
  it('unions locally archived owned sessions into the repo archive list', async () => {
    const world = deps()
    world.persistence.seed('session-a', '/work/demo', 1)
    world.workspaces.archivedIds.push(SessionId('session-a'))
    await runSyncCycle(world.deps)

    expect(world.fs.files.get('projects/demo/archived.json')).toBe(
      serializeArchiveList([SessionId('session-a')]),
    )
  })

  it('preserves repo marks this machine does not hold and never removes ids', async () => {
    const world = deps()
    world.persistence.seed('session-a', '/work/demo', 1)
    world.workspaces.archivedIds.push(SessionId('session-a'))
    world.fs.files.set('projects/demo/archived.json', serializeArchiveList([SessionId('session-remote')]))
    await runSyncCycle(world.deps)

    expect(world.fs.files.get('projects/demo/archived.json')).toBe(
      serializeArchiveList([SessionId('session-a'), SessionId('session-remote')]),
    )
  })

  it('propagates the mark of an archived session deleted locally and purges its repo artifact', async () => {
    const world = deps()
    world.workspaces.archivedIds.push(SessionId('session-gone'))
    // The artifact fails import (as a deleted local session's ghost would), so
    // only its repo file name attributes the mark to this project.
    world.fs.files.set('projects/demo/session-gone.jsonl', 'broken\n')
    const result = await runSyncCycle(world.deps)

    expect(result.errors.some(message => message.includes('session-gone'))).toBe(true)
    // The mark is written while the file still exists, and the sweep then
    // deletes the file: the id keeps travelling, the artifact stops.
    expect(world.fs.files.get('projects/demo/archived.json')).toBe(
      serializeArchiveList([SessionId('session-gone')]),
    )
    expect(world.fs.files.has('projects/demo/session-gone.jsonl')).toBe(false)
    expect(result.deleted).toBe(1)
  })

  it('does not export marks of sessions owned by other projects', async () => {
    const world = deps()
    world.persistence.seed('session-elsewhere', '/elsewhere/project', 1)
    world.workspaces.archivedIds.push(SessionId('session-elsewhere'))
    await runSyncCycle(world.deps)

    expect(world.fs.files.has('projects/demo/archived.json')).toBe(false)
  })

  it('leaves the repo archive list untouched when local contributes nothing', async () => {
    const world = deps()
    const existing = serializeArchiveList([SessionId('session-remote')])
    world.fs.files.set('projects/demo/archived.json', existing)
    await runSyncCycle(world.deps)

    expect(world.fs.files.get('projects/demo/archived.json')).toBe(existing)
  })

  it('overwrites an unparsable repo archive list and records the failure', async () => {
    const world = deps()
    world.persistence.seed('session-a', '/work/demo', 1)
    world.workspaces.archivedIds.push(SessionId('session-a'))
    world.fs.files.set('projects/demo/archived.json', 'broken\n')
    const result = await runSyncCycle(world.deps)

    expect(world.fs.files.get('projects/demo/archived.json')).toBe(
      serializeArchiveList([SessionId('session-a')]),
    )
    expect(result.errors.some(message => message.includes('unparsable, overwriting'))).toBe(true)
  })
})

describe('runSyncCycle archive deletion', () => {
  it('deletes the repo artifact of an archived owned session instead of rewriting it', async () => {
    const world = deps()
    world.persistence.seed('session-a', '/work/demo', 3)
    world.workspaces.archivedIds.push(SessionId('session-a'))
    world.fs.files.set('projects/demo/session-a.jsonl', artifactFor('session-a', 'demo', 3))
    const result = await runSyncCycle(world.deps)

    expect(result.pushed).toBe(0)
    expect(result.deleted).toBe(1)
    expect(world.fs.deleted).toEqual(['projects/demo/session-a.jsonl'])
    expect(world.fs.files.has('projects/demo/session-a.jsonl')).toBe(false)
    // The mark still travels; the local copy is untouched.
    expect(world.fs.files.get('projects/demo/archived.json')).toBe(
      serializeArchiveList([SessionId('session-a')]),
    )
    expect(world.persistence.sessions.get('session-a')!.events).toHaveLength(6)
  })

  it('leaves sessions of other projects and non-archived sessions alone', async () => {
    const world = deps()
    world.persistence.seed('session-a', '/work/demo', 1)
    world.persistence.seed('session-b', '/work/demo', 1)
    world.workspaces.archivedIds.push(SessionId('session-a'))
    world.fs.files.set('projects/demo/session-a.jsonl', artifactFor('session-a', 'demo', 1))
    world.fs.files.set('projects/demo/session-b.jsonl', artifactFor('session-b', 'demo', 1))
    world.fs.files.set('projects/demo/session-c.jsonl', artifactFor('session-c', 'demo', 1))
    const result = await runSyncCycle(world.deps)

    expect(result.deleted).toBe(1)
    expect(world.fs.files.has('projects/demo/session-a.jsonl')).toBe(false)
    // session-b is owned and not archived: its content is exported as usual.
    expect(world.fs.files.has('projects/demo/session-b.jsonl')).toBe(true)
    // session-c is archived nowhere on this machine: the sweep must not touch it.
    expect(world.fs.files.has('projects/demo/session-c.jsonl')).toBe(true)
  })

  it('skips the sweep when the composition mounts no workspace registry', async () => {
    const noWorkspaces = deps({ workspaces: undefined })
    noWorkspaces.persistence.seed('session-a', '/work/demo', 1)
    noWorkspaces.fs.files.set('projects/demo/session-a.jsonl', artifactFor('session-a', 'demo', 1))
    const result = await runSyncCycle(noWorkspaces.deps)

    expect(result.deleted).toBe(0)
    expect(noWorkspaces.fs.files.has('projects/demo/session-a.jsonl')).toBe(true)
  })

  it('is a no-op when the archived session has no repo artifact', async () => {
    const world = deps()
    world.persistence.seed('session-a', '/work/demo', 1)
    world.workspaces.archivedIds.push(SessionId('session-a'))
    const result = await runSyncCycle(world.deps)

    expect(result.deleted).toBe(0)
    expect(result.errors).toEqual([])
    expect(world.fs.files.get('projects/demo/archived.json')).toBe(
      serializeArchiveList([SessionId('session-a')]),
    )
  })
})

describe('runSyncCycle git flow', () => {
  it('drives ensure → fetch → reset → add → commit → push in order', async () => {
    const world = deps()
    await runSyncCycle(world.deps)
    expect(world.git.calls).toEqual(['ensure', 'fetch', 'resetHard', 'addAll', 'commit:dsh session sync', 'push'])
  })

  it('propagates git failures', async () => {
    const world = deps()
    world.git.failAt = 'push'
    await expect(runSyncCycle(world.deps)).rejects.toThrow('git push failed')
  })

  it('contains a thrown non-Error import failure', async () => {
    const world = deps()
    world.persistence.seed('session-a', '/work/demo', 2)
    world.persistence.throwStringOn = 'inspect'
    world.fs.files.set('projects/demo/session-a.jsonl', artifactFor('session-a', 'demo', 4))
    const result = await runSyncCycle(world.deps)
    expect(result.imported).toBe(0)
    expect(result.errors.some(message => message.includes('inspect string failure'))).toBe(true)
  })
})
