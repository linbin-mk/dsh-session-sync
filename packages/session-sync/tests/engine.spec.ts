import { describe, expect, it } from 'vitest'
import { SESSION_FORMAT_VERSION, SessionId, SessionLogOffset } from '@deepseek-ai/dsh-session'
import type { SessionEvent, SessionHeader } from '@deepseek-ai/dsh-session'
import {
  compareLogs, decidePinSync, runSyncCycle,
} from '../src/engine.ts'
import type { SyncEngineDeps, SyncFilesystem, SyncGit, SyncPersistence, SyncProjectionCache, SyncWorkspaceRegistry } from '../src/engine.ts'
import { ARCHIVE_NAME, MANIFEST_NAME, PIN_NAME, serializeArchiveList, serializeManifest, serializePinList } from '../src/format.ts'
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

/** Fake workspace registry: one map of path → attached ids plus grow-only archive and pin sets. */
class FakeWorkspaces implements SyncWorkspaceRegistry {
  readonly attached = new Map<string, string[]>()
  readonly archivedIds: SessionId[] = []
  /** The registry-global pin set, most recently pinned first — the sync selection. */
  readonly pinnedIds: SessionId[] = []
  createCalls: string[] = []
  failAttachOn: string[] = []
  failArchiveOn: string[] = []
  failPinOn: string[] = []
  failUnpinOn: string[] = []

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

  pinnedSessionIds(): readonly SessionId[] {
    return this.pinnedIds
  }

  async pinSession(id: SessionId): Promise<void> {
    if (this.failPinOn.includes(String(id))) throw new Error('pin rejected')
    if (!this.pinnedIds.some(candidate => String(candidate) === String(id))) this.pinnedIds.unshift(id)
  }

  async unpinSession(id: SessionId): Promise<void> {
    if (this.failUnpinOn.includes(String(id))) throw new Error('unpin rejected')
    const at = this.pinnedIds.findIndex(candidate => String(candidate) === String(id))
    if (at !== -1) this.pinnedIds.splice(at, 1)
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
  /** This machine's pin baseline; undefined is the fresh-machine state. */
  baseline: { firstSeen: boolean; sessionIds: string[]; ownedIds: string[] } | undefined
  /** Baseline writes, in order. */
  readonly baselineWrites: { firstSeen: boolean; sessionIds: string[]; ownedIds: string[] }[] = []
  /** Pin-list writes, in order (the fixture's synthesized default is not one). */
  readonly pinWrites: string[] = []

  constructor(seed?: Record<string, string>) {
    for (const [rel, content] of Object.entries(seed ?? {})) this.files.set(rel, content)
  }

  /** Every session id a repo artifact path in this worktree mentions. */
  private selectedIds(): string[] {
    const ids = new Set<string>()
    for (const rel of this.files.keys()) {
      const match = /^projects\/[^/]+\/(session-[A-Za-z0-9-]+)\.jsonl$/.exec(rel)
      if (match?.[1] !== undefined) ids.add(match[1])
    }
    return [...ids]
  }

  async readRepoFile(rel: string): Promise<string | undefined> {
    if (this.phantom.includes(rel)) return undefined
    const stored = this.files.get(rel)
    if (stored !== undefined) return stored
    // A fixture repo without an explicit pin list selects whatever artifacts
    // it carries plus this machine's pins. Real repos always carry the file
    // (the first pin edit writes it); this default keeps the mechanics suites
    // — import, export, archive — about mechanics, while the pin-selection
    // suites below set both the file and the baseline explicitly.
    if (rel === PIN_NAME) {
      return pinnedFile(this.selectedIds())
    }
    return undefined
  }

  async writeRepoFile(rel: string, content: string): Promise<void> {
    if (rel === PIN_NAME) this.pinWrites.push(content)
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

  async readPinBaseline(): Promise<{ firstSeen: boolean; sessionIds: string[]; ownedIds: string[] } | undefined> {
    return this.baseline === undefined
      ? undefined
      : { ...this.baseline, sessionIds: [...this.baseline.sessionIds], ownedIds: [...this.baseline.ownedIds] }
  }

  async writePinBaseline(snapshot: { firstSeen: boolean; sessionIds: string[]; ownedIds: string[] }): Promise<void> {
    this.baseline = { ...snapshot, sessionIds: [...snapshot.sessionIds], ownedIds: [...snapshot.ownedIds] }
    this.baselineWrites.push(this.baseline)
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

/** The repo pin list as a reader sees it, attributed for diagnostics only. */
function pinnedFile(ids: readonly string[]): string {
  return serializePinList({
    sessionIds: ids.map(id => SessionId(id)),
    host: 'other-host',
    updatedAt: '2026-01-01T00:00:00.000Z',
  })
}

function deps(overrides: Partial<SyncEngineDeps> = {}): {  deps: SyncEngineDeps
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
    delete (world.deps as { workspaces?: unknown }).workspaces
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
    // Pinned here, selected before: the publish path carries a pin the repo
    // has never seen, and the export writes its first artifact.
    await world.workspaces.pinSession(SessionId('session-local'))
    world.fs.baseline = { firstSeen: true, ownedIds: [], sessionIds: [] }
    const result = await runSyncCycle(world.deps)

    expect(result.pushed).toBe(1)
    const artifact = world.fs.files.get('projects/demo/session-local.jsonl')
    expect(artifact).toBeDefined()
    expect(artifact).toContain('"project":"demo"')
    expect(artifact).not.toContain('/work/demo')
    expect(result.publishedPins).toEqual(['session-local'])
  })

  it('skips exporting a session this machine does not pin', async () => {
    const world = deps()
    world.persistence.seed('session-local', '/work/demo', 2)
    world.fs.baseline = { firstSeen: true, ownedIds: [], sessionIds: [] }
    const result = await runSyncCycle(world.deps)

    expect(result.pushed).toBe(0)
    expect(world.fs.files.has('projects/demo/session-local.jsonl')).toBe(false)
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
  it('leaves an archived artifact unimported while marking locally held sessions', async () => {
    const world = deps()
    world.fs.files.set('projects/demo/session-remote.jsonl', artifactFor('session-remote', 'demo', 1))
    world.fs.files.set('projects/demo/session-held.jsonl', artifactFor('session-held', 'demo', 1))
    world.persistence.seed('session-held', '/work/demo', 1)
    world.fs.files.set('projects/demo/archived.json', serializeArchiveList([
      SessionId('session-remote'), SessionId('session-held'), SessionId('session-ghost'),
    ]))
    const result = await runSyncCycle(world.deps)

    // The mark lands before the selection admits artifacts: an archived
    // session is hidden here and never materializes, and an id this machine
    // does not hold at all is skipped (the registry refuses unknown ids).
    expect(result.imported).toBe(0)
    expect(world.persistence.created).toEqual([])
    expect(result.archived).toBe(1)
    expect(world.workspaces.archivedIds.map(String)).toEqual(['session-held'])
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

  it('reports a per-id archive failure and keeps the cycle working', async () => {
    const world = deps()
    // Held locally, so the mark is addressed to this machine and the
    // registry's refusal is a contained per-id failure.
    world.persistence.seed('session-held', '/work/demo', 1)
    world.fs.files.set('projects/demo/archived.json', serializeArchiveList([SessionId('session-held')]))
    world.workspaces.failArchiveOn = ['session-held']
    const result = await runSyncCycle(world.deps)

    expect(result.archived).toBe(0)
    expect(result.errors.some(message => message.includes('archive session-held'))).toBe(true)
    expect(result.errors.length).toBe(1)
  })

  it('skips archive application when the composition mounts no workspace registry', async () => {
    const world = deps()
    delete (world.deps as { workspaces?: unknown }).workspaces
    world.fs.files.set('projects/demo/session-remote.jsonl', artifactFor('session-remote', 'demo', 1))
    world.fs.files.set('projects/demo/archived.json', serializeArchiveList([SessionId('session-remote')]))
    const result = await runSyncCycle(world.deps)

    // Without a registry there is no archive set to consult, but the repo's
    // own mark still keeps the artifact out: an archived session never syncs.
    expect(result.imported).toBe(0)
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


describe('runSyncCycle pin selection', () => {
  /** The repo's pin list as an explicit file with `ids` selected. */
  function selectRepo(world: ReturnType<typeof deps>, ids: readonly string[]): void {
    world.fs.files.set(PIN_NAME, pinnedFile(ids))
  }

  /** The ids the repo's pin list carries after a cycle. */
  function selectedAfter(world: ReturnType<typeof deps>): string[] {
    const parsed = JSON.parse(world.fs.files.get(PIN_NAME)!) as { sessionIds: string[] }
    return parsed.sessionIds
  }

  /** A baseline saying this machine last synced `selection` and owns `owned`. */
  function baseline(selection: readonly string[], owned: readonly string[] = selection) {
    return { firstSeen: true, sessionIds: [...selection], ownedIds: [...owned] }
  }

  it('adopts the repo selection before its first cycle without publishing or retiring anything', async () => {
    const world = deps()
    world.persistence.seed('session-a', '/work/demo', 2)
    world.persistence.seed('session-b', '/work/demo', 2)
    world.fs.files.set('projects/demo/session-a.jsonl', artifactFor('session-a', 'demo', 2))
    world.fs.files.set('projects/demo/session-b.jsonl', artifactFor('session-b', 'demo', 2))
    // The repo already selects session-a; session-b is only local.
    selectRepo(world, ['session-a'])

    const result = await runSyncCycle(world.deps)

    // The selection mirrors into the registry, and none of this machine's
    // other sessions is published or retired on a machine that has never
    // synced (an empty baseline is a fresh machine, not an "unpin all").
    expect(world.workspaces.pinnedIds.map(String)).toEqual(['session-a'])
    expect(result.publishedPins).toBeUndefined()
    expect(result.deletedUnpinned).toBe(0)
    expect(selectedAfter(world)).toEqual(['session-a'])
    expect(world.fs.files.has('projects/demo/session-b.jsonl')).toBe(true)
    expect(world.fs.baseline).toMatchObject({ firstSeen: true, sessionIds: ['session-a'] })
  })

  it('publishes a local pin, writes its artifact, and selects it on the next cycle without republishing', async () => {
    const world = deps()
    world.persistence.seed('session-a', '/work/demo', 2)
    selectRepo(world, [])
    world.fs.baseline = { firstSeen: true, ownedIds: [], sessionIds: [] }
    await world.workspaces.pinSession(SessionId('session-a'))

    const first = await runSyncCycle(world.deps)
    expect(first.pinned).toEqual([]) // already pinned locally
    expect(first.pushed).toBe(1)
    expect(first.publishedPins).toEqual(['session-a'])
    expect(selectedAfter(world)).toEqual(['session-a'])

    const writesAfterFirst = world.fs.pinWrites.length
    const second = await runSyncCycle(world.deps)
    expect(second.publishedPins).toBeUndefined()
    expect(world.fs.pinWrites.length).toBe(writesAfterFirst)
  })

  it('adopts a repo-side removal and refuses to retire what it still pins', async () => {
    const world = deps()
    world.persistence.seed('session-a', '/work/demo', 2)
    world.persistence.seed('session-b', '/work/demo', 2)
    world.fs.files.set('projects/demo/session-a.jsonl', artifactFor('session-a', 'demo', 2))
    world.fs.files.set('projects/demo/session-b.jsonl', artifactFor('session-b', 'demo', 2))
    // The other machine dropped session-b from the selection; this machine
    // still holds both pins locally and has not touched them.
    selectRepo(world, ['session-a'])
    world.fs.baseline = baseline(['session-a', 'session-b'])
    world.workspaces.pinnedIds.push(SessionId('session-b'), SessionId('session-a'))

    const result = await runSyncCycle(world.deps)

    expect(result.unpinned).toEqual(['session-b'])
    expect(world.workspaces.pinnedIds.map(String)).toEqual(['session-a'])
    expect(result.publishedPins).toBeUndefined()
    expect(selectedAfter(world)).toEqual(['session-a'])
    // The user changed nothing here, so nothing of theirs is retired.
    expect(result.deletedUnpinned).toBe(0)
  })

  it('unpins locally, retires the artifact, and stops selecting it', async () => {
    const world = deps()
    world.persistence.seed('session-a', '/work/demo', 2)
    world.persistence.seed('session-b', '/work/demo', 2)
    world.fs.files.set('projects/demo/session-a.jsonl', artifactFor('session-a', 'demo', 2))
    world.fs.files.set('projects/demo/session-b.jsonl', artifactFor('session-b', 'demo', 2))
    selectRepo(world, ['session-a', 'session-b'])
    world.fs.baseline = baseline(['session-a', 'session-b'])
    await world.workspaces.pinSession(SessionId('session-a'))
    await world.workspaces.pinSession(SessionId('session-b'))
    await world.workspaces.unpinSession(SessionId('session-b'))

    const result = await runSyncCycle(world.deps)

    expect(selectedAfter(world)).toEqual(['session-a'])
    expect(result.deletedUnpinned).toBe(1)
    expect(world.fs.files.has('projects/demo/session-b.jsonl')).toBe(false)
    expect(world.fs.files.has('projects/demo/session-a.jsonl')).toBe(true)
    // The local session survives: only the repo artifact is retired.
    expect(world.persistence.sessions.has('session-b')).toBe(true)
  })

  it('mirrors a repo-side removal without republishing it back', async () => {
    const world = deps()
    world.persistence.seed('session-a', '/work/demo', 2)
    world.persistence.seed('session-b', '/work/demo', 2)
    world.fs.files.set('projects/demo/session-a.jsonl', artifactFor('session-a', 'demo', 2))
    world.fs.files.set('projects/demo/session-b.jsonl', artifactFor('session-b', 'demo', 2))
    // The user pinned both here (so this machine owns both); the other
    // machine then dropped b from the selection.
    world.workspaces.pinnedIds.push(SessionId('session-b'), SessionId('session-a'))
    world.fs.baseline = baseline(['session-a', 'session-b'])
    selectRepo(world, ['session-a'])

    const result = await runSyncCycle(world.deps)

    expect(result.unpinned).toEqual(['session-b'])
    expect(world.workspaces.pinnedIds.map(String)).toEqual(['session-a'])
    expect(result.publishedPins).toBeUndefined()
    expect(selectedAfter(world)).toEqual(['session-a'])
  })

  it('keeps a repo-selected id this machine cannot mirror', async () => {
    const world = deps()
    world.persistence.seed('session-b', '/work/demo', 2)
    world.fs.files.set('projects/demo/session-b.jsonl', artifactFor('session-b', 'demo', 2))
    // The repo selects a session of a project this machine does not hold, and
    // it is not one of this machine's own pins. The user pins session-b here,
    // which publishes; the foreign id survives that publish.
    selectRepo(world, ['session-elsewhere'])
    world.fs.baseline = baseline(['session-elsewhere'], [])
    await world.workspaces.pinSession(SessionId('session-b'))

    const result = await runSyncCycle(world.deps)

    // The id this machine cannot hold is not part of its own pins, so the
    // publish it triggers carries its own set; the foreign id stays reachable
    // through the repo list for the machine that owns it.
    expect(result.publishedPins).toEqual(['session-b'])
    expect(selectedAfter(world)).toEqual(['session-b'])
    // The repo's id is mirrored; the pin this machine made stays its own.
    expect(result.pinned).toEqual(['session-elsewhere'])
    expect(world.workspaces.pinnedIds.map(String)).toEqual(['session-elsewhere', 'session-b'])
  })

  it('excludes an archived session from the published selection', async () => {
    const world = deps()
    world.persistence.seed('session-a', '/work/demo', 2)
    world.fs.files.set('projects/demo/session-a.jsonl', artifactFor('session-a', 'demo', 2))
    selectRepo(world, ['session-a'])
    world.fs.baseline = { firstSeen: true, ownedIds: ['session-a'], sessionIds: ['session-a'] }
    // Locally pinned once, now archived: the host keeps the two sets
    // exclusive, so the archived id leaves the selection and its artifact.
    world.workspaces.pinnedIds.push(SessionId('session-a'))
    // The user pinned it here, which diverged this machine's set from the
    // baseline, and then archived it — the host keeps the two sets exclusive,
    // so the archived id leaves the selection and its artifact.
    world.workspaces.pinnedIds.push(SessionId('session-a'))
    world.workspaces.archivedIds.push(SessionId('session-a'))
    world.fs.baseline = { firstSeen: true, ownedIds: [], sessionIds: [] }

    const result = await runSyncCycle(world.deps)

    expect(result.publishedPins).toEqual([])
    expect(selectedAfter(world)).toEqual([])
    // The archived artifact leaves through the archive sweep, which owns that
    // count; the pin sweep reports nothing because the host already dropped
    // the pin when it archived the session.
    expect(result.deleted).toBe(1)
    expect(result.deletedUnpinned).toBe(0)
    expect(world.fs.files.has('projects/demo/session-a.jsonl')).toBe(false)
  })

  it('never delivers an unselected artifact and never retires one it does not track', async () => {
    const world = deps()
    world.fs.files.set('projects/demo/session-unpinned.jsonl', artifactFor('session-unpinned', 'demo', 2))
    selectRepo(world, [])
    world.fs.baseline = { firstSeen: true, ownedIds: [], sessionIds: ['session-other'] }

    const result = await runSyncCycle(world.deps)

    expect(result.imported).toBe(0)
    expect(world.persistence.created).toEqual([])
    // session-unpinned was never in this machine's baseline: this machine did
    // not retire it, so nothing deletes an artifact another machine owns.
    expect(result.deletedUnpinned).toBe(0)
    expect(world.fs.files.has('projects/demo/session-unpinned.jsonl')).toBe(true)
  })

  it('reports an unparsable pin list and gates no artifact on it', async () => {
    const world = deps()
    world.fs.files.set('projects/demo/session-a.jsonl', artifactFor('session-a', 'demo', 2))
    world.fs.files.set(PIN_NAME, 'broken\n')

    const result = await runSyncCycle(world.deps)

    expect(result.imported).toBe(0)
    expect(result.publishedPins).toBeUndefined()
    expect(result.errors.some(message => message.includes('pin list'))).toBe(true)
    expect(world.fs.files.get(PIN_NAME)).toBe('broken\n')
  })

  it('writes the baseline once and only again when the applied selection changes', async () => {
    const world = deps()
    world.persistence.seed('session-a', '/work/demo', 2)
    selectRepo(world, ['session-a'])
    world.workspaces.pinnedIds.push(SessionId('session-a'))

    await runSyncCycle(world.deps)
    const writes = world.fs.baselineWrites.length
    expect(writes).toBe(1)
    expect(world.fs.baselineWrites[0]).toMatchObject({ firstSeen: true, sessionIds: ['session-a'] })

    await runSyncCycle(world.deps)
    expect(world.fs.baselineWrites.length).toBe(writes)

    world.workspaces.pinnedIds.push(SessionId('session-b'))
    await runSyncCycle(world.deps)
    expect(world.fs.baselineWrites.length).toBe(writes + 1)
  })

  it('pins an adopted id whose artifact arrived in the same cycle', async () => {
    const world = deps()
    world.fs.files.set('projects/demo/session-remote.jsonl', artifactFor('session-remote', 'demo', 2))
    selectRepo(world, ['session-remote'])
    world.fs.baseline = { firstSeen: true, ownedIds: [], sessionIds: [] }

    const result = await runSyncCycle(world.deps)

    expect(result.imported).toBe(1)
    expect(result.pinned).toEqual(['session-remote'])
    expect(world.workspaces.pinnedIds.map(String)).toEqual(['session-remote'])
    // The adopted artifact is not re-exported from the log it just came from.
    expect(result.pushed).toBe(0)
  })

  it('contains a pin the host refuses and keeps the cycle going', async () => {
    const world = deps()
    world.fs.files.set('projects/demo/session-remote.jsonl', artifactFor('session-remote', 'demo', 2))
    selectRepo(world, ['session-remote'])
    world.fs.baseline = { firstSeen: true, ownedIds: [], sessionIds: [] }
    world.workspaces.failPinOn = ['session-remote']

    const result = await runSyncCycle(world.deps)

    expect(result.imported).toBe(1)
    expect(result.pinned).toEqual([])
    expect(world.warnings.some(message => message.includes('pin "session-remote" failed'))).toBe(true)
    expect(world.fs.baseline).toMatchObject({ sessionIds: ['session-remote'] })
  })
})



