import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { SESSION_FORMAT_VERSION, SessionId, SessionLogOffset } from '@deepseek-ai/dsh-session'
import type { SessionEvent, SessionHeader } from '@deepseek-ai/dsh-session'
import {
  assignWorkspaceKey, compareLogs, decideSelectionSync, foldTitle, runSyncCycle,
} from '../src/engine.ts'
import type {
  SelectionDecision, SelectionInput, SyncEngineDeps, SyncFilesystem, SyncGit, SyncPersistence,
  SyncProjectionCache, SyncWorkspace, SyncWorkspaceRegistry,
} from '../src/engine.ts'
import {
  ARCHIVE_NAME, MANIFEST_NAME, SYNC_RECORD_LIMIT, WORKSPACES_DIR,
  archiveRepoPath, manifestRepoPath, mergeRecords, parsePortableSession, parseRecords, parseSelection,
  recordsRepoPath, selectionRepoPath, serializeArchiveList, serializeManifest, serializePortableSession,
  serializeSelection, sessionRepoPath, workspaceRepoDir,
} from '../src/format.ts'
import type { SessionSyncRecord, SyncSelectionEntry, SyncState } from '../src/format.ts'
import { DEFAULT_BRANCH, DEFAULT_INTERVAL_MINUTES } from '../src/settings.ts'
import type { SessionSyncSettings } from '../src/settings.ts'

const NOW_ISO = '2026-09-29T10:00:00.000Z'
const NOW = (): Date => new Date(NOW_ISO)

function header(id: string, cwd: string | undefined, createdAt = 1): SessionHeader {
  return {
    version: SESSION_FORMAT_VERSION,
    id: SessionId(id),
    createdAt,
    ...cwd === undefined ? {} : { cwd },
    isSeeded: false,
    delegationDepth: 0,
  }
}

/** `count` closed turns, so the log never ends mid-turn. */
function events(count: number, offset = 0): SessionEvent[] {
  const list: SessionEvent[] = []
  for (let index = 0; index < count; index++) {
    const turn = offset + index + 1
    list.push({ type: 'turn/start', seq: list.length, time: turn * 2, data: { turn } } as SessionEvent)
    list.push({ type: 'turn/end', seq: list.length, time: turn * 2 + 1, data: { turn, reason: { kind: 'completed' } } } as SessionEvent)
  }
  return list
}

/** One `session/title` event, the harness way of storing a title. */
function titleEvent(title: string, seq = 0): SessionEvent {
  // `seq` is a branded SessionSeq in the event map; a literal number keeps the
  // fixture readable, so the cast goes through `unknown`.
  return {
    type: 'session/title', seq, time: seq + 1, data: { title, messageSeqs: [], source: { kind: 'user' } },
  } as unknown as SessionEvent
}

/** A log left mid-turn: the turn started a step and never closed it. */
function midTurnEvents(): SessionEvent[] {
  return [
    { type: 'turn/start', seq: 0, time: 1, data: { turn: 1 } } as SessionEvent,
    { type: 'step/start', seq: 1, time: 2, data: { turn: 1, step: 1 } } as SessionEvent,
  ]
}

/** One repo artifact text for a session whose header carries no local path. */
function artifactForEvents(id: string, key: string, list: SessionEvent[], overrides: Partial<SessionHeader> = {}): string {
  return serializePortableSession({
    meta: { ...header(id, undefined), ...overrides },
    inheritedEventCount: SessionLogOffset(0),
    events: list,
  }, key)
}

function artifactFor(id: string, key: string, count: number): string {
  return artifactForEvents(id, key, events(count))
}

/** One repo selection entry with stable provenance. */
function entry(id: string, key = 'ws-a', workspaceName = 'demo', title = 'A session'): SyncSelectionEntry {
  return {
    id: SessionId(id),
    key,
    workspaceName,
    title,
    addedAt: '2026-09-01T00:00:00.000Z',
    addedBy: 'seed',
  }
}

function selectionFile(entries: readonly SyncSelectionEntry[]): string {
  return serializeSelection({ host: 'seed', updatedAt: '2026-09-01T00:00:00.000Z', entries: [...entries] })
}

/** A repo workspace directory: its manifest plus its artifact files. */
function repoWorkspace(key: string, name: string, artifacts: Readonly<Record<string, string>> = {}): Record<string, string> {
  const files: Record<string, string> = {
    [manifestRepoPath(key)]: serializeManifest({ key, name, updatedAt: '2026-09-01T00:00:00.000Z' }),
  }
  for (const [id, text] of Object.entries(artifacts)) files[sessionRepoPath(key, SessionId(id))] = text
  return files
}

/** The name-derived key a fresh machine mints for a workspace. */
function mintedKey(name: string): string {
  return `ws-${createHash('sha1').update(name).digest('hex').slice(0, 10)}`
}

/** Fake persistence storing one map of session id → events. */
class FakePersistence implements SyncPersistence {
  readonly sessions = new Map<string, { meta: SessionHeader; inheritedEventCount: ReturnType<typeof SessionLogOffset>; events: SessionEvent[] }>()
  readonly appendCalls: { id: string; count: number }[] = []
  created: string[] = []
  /** Sessions `inspect` rejects for, standing in for a read fault. */
  failReadFrom = false
  /** A foreign throw (not an Error) from `inspect`. */
  throwStringOn?: string
  /** Headers `list` reports that `inspect` answers undefined for. */
  phantomList: string[] = []
  /** Headers `list` reports without a cwd. */
  noCwdList: string[] = []

  seed(id: string, cwd: string, count: number, options: { title?: string } = {}): void {
    const list = events(count)
    if (options.title !== undefined) list.push(titleEvent(options.title, list.length))
    this.seedEvents(id, cwd, list)
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
      ...this.noCwdList.map(id => header(id, undefined)),
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

/** Fake workspace registry: the local title table plus attach accounting and a grow-only archive set. */
class FakeWorkspaces implements SyncWorkspaceRegistry {
  readonly attached = new Map<string, string[]>()
  readonly archivedIds: SessionId[] = []
  readonly entries: { id: string; title: string; path: string }[] = []
  failAttachOn: string[] = []
  failArchiveOn: string[] = []

  /** Register one local workspace: the row a repo manifest name is matched against. */
  add(path: string, title: string, id = path): this {
    this.entries.push({ id, title, path })
    this.attached.set(path, [])
    return this
  }

  list(): SyncWorkspace[] {
    return this.entries.map(entry => ({
      id: entry.id,
      title: entry.title,
      path: entry.path,
      attachSession: (id: SessionId) => this.attach(entry.path, id),
    }))
  }

  async resolveByPath(path: string): Promise<SyncWorkspace | undefined> {
    const entry = this.entries.find(candidate => candidate.path === path)
    if (entry === undefined) return undefined
    return { id: entry.id, title: entry.title, path: entry.path, attachSession: id => this.attach(entry.path, id) }
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

/** In-memory repo worktree plus this machine's selection mirror and anchor. */
class FakeFilesystem implements SyncFilesystem {
  readonly hostname = 'test-host'
  readonly files = new Map<string, string>()
  readonly deleted: string[] = []
  /** Directories removed by the empty-workspace sweep, in order. */
  readonly deletedDirs: string[] = []
  /** Directory entries the fixture has listed; they outlive their last file. */
  private readonly dirs = new Set<string>()
  /** File names listFiles reports but readRepoFile answers undefined for. */
  phantom: string[] = []
  /** This machine's selection mirror; undefined before the plugin ever ran. */
  localSelection: string[] | undefined
  /** Selection-mirror writes, in order. */
  readonly localSelectionWrites: string[][] = []
  /** This machine's sync anchor; undefined before its first cycle. */
  syncState: SyncState | undefined
  /** Anchor writes, in order. */
  readonly stateWrites: SyncState[] = []

  constructor(seed: Record<string, string> = {}) {
    this.seed(seed)
  }

  /** Add repo files (a fixture's workspace directory) to the worktree. */
  seed(files: Readonly<Record<string, string>>): void {
    for (const [rel, content] of Object.entries(files)) this.files.set(rel, content)
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

  async deleteRepoDir(rel: string): Promise<boolean> {
    const prefix = `${rel}/`
    // `rmdir` semantics: a directory still holding anything (a manifest, an
    // archive list) cannot be removed.
    if ([...this.files.keys()].some(key => key.startsWith(prefix))) return false
    // A directory survives its last file until something removes the entry
    // itself, so only one this fixture has listed can be removed.
    if (!this.dirs.delete(rel)) return false
    this.deletedDirs.push(rel)
    return true
  }

  async listDirs(rel: string): Promise<string[]> {
    const prefix = rel === '' ? '' : `${rel}/`
    const names = [...this.files.keys(), ...this.phantom]
      .filter(key => key.startsWith(prefix))
      .map(key => key.slice(prefix.length).split('/')[0]!)
    const listed = [...new Set(names)].filter(name => name.length > 0 && !name.includes('.'))
    for (const name of listed) this.dirs.add(rel === '' ? name : `${rel}/${name}`)
    return listed
  }

  async listFiles(rel: string): Promise<string[]> {
    const prefix = `${rel}/`
    return [...this.files.keys(), ...this.phantom]
      .filter(key => key.startsWith(prefix))
      .map(key => key.slice(prefix.length))
      .filter(name => !name.includes('/'))
  }

  async readState(): Promise<SyncState | undefined> {
    return this.syncState
  }

  async writeState(state: SyncState): Promise<void> {
    const stored: SyncState = {
      ...state,
      syncedIds: [...state.syncedIds],
      ownedIds: [...state.ownedIds],
      workspaceKeys: state.workspaceKeys.map(entry => ({ ...entry })),
    }
    this.syncState = stored
    this.stateWrites.push(stored)
  }

  async readLocalSelection(): Promise<{ sessionIds: SessionId[] } | undefined> {
    if (this.localSelection === undefined) return undefined
    return { sessionIds: this.localSelection.map(id => SessionId(id)) }
  }

  async writeLocalSelection(selection: { sessionIds: readonly SessionId[] }): Promise<void> {
    this.localSelection = selection.sessionIds.map(String)
    this.localSelectionWrites.push([...this.localSelection])
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
    cleanup: { enabled: false, periodHours: 24, keepCommits: 200 },
    ...overrides,
  }
}

/** One anchor saying this machine last synced `syncedIds` and may drop `ownedIds`. */
function anchor(syncedIds: readonly string[], ownedIds: readonly string[] = syncedIds): SyncState {
  return {
    firstSeen: true,
    syncedIds: syncedIds.map(id => SessionId(id)),
    ownedIds: ownedIds.map(id => SessionId(id)),
    workspaceKeys: [],
    updatedAt: '2026-09-01T00:00:00.000Z',
    host: 'other-host',
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
  const workspaces = overrides.workspaces as FakeWorkspaces ?? new FakeWorkspaces().add('/work/demo', 'demo', 'local-1')
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
      now: NOW,
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

/** The same fixture without a workspace registry (the optional-service deployment shape). */
function unregistered(world: ReturnType<typeof deps>): SyncEngineDeps {
  const clone: SyncEngineDeps = { ...world.deps }
  delete (clone as { workspaces?: unknown }).workspaces
  return clone
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
    expect(compareLogs([], [])).toBe('equal')
    expect(compareLogs([], events(1))).toBe('local-prefix')
  })
})

describe('decideSelectionSync', () => {
  function input(overrides: Partial<SelectionInput> = {}): SelectionInput {
    return { localIds: [], repoIds: undefined, anchor: undefined, archivedIds: [], repoArchivedIds: [], ...overrides }
  }

  function decision(overrides: Partial<SelectionInput> = {}): SelectionDecision {
    return decideSelectionSync(input(overrides))
  }

  it('lets a fresh machine adopt the repo selection without publishing or sweeping', () => {
    expect(decision({ repoIds: ['session-a'] })).toEqual({
      publish: false,
      canSweep: false,
      selectedIds: ['session-a'],
      adoptedIds: ['session-a'],
      droppedIds: [],
      publishedIds: ['session-a'],
      retiredIds: [],
      ownedIds: ['session-a'],
    })
  })

  it('publishes a selection a never-synced machine already holds, still sweeping nothing', () => {
    expect(decision({ localIds: ['session-local'], repoIds: ['session-a'] })).toEqual({
      publish: true,
      canSweep: false,
      selectedIds: ['session-a'],
      adoptedIds: ['session-a'],
      droppedIds: [],
      publishedIds: ['session-a', 'session-local'],
      retiredIds: [],
      ownedIds: ['session-local', 'session-a'],
    })
  })

  it('publishes nothing when a fresh machine already matches the repo', () => {
    const selection = decision({ localIds: ['session-a'], repoIds: ['session-a'] })
    expect(selection.publish).toBe(false)
    expect(selection.publishedIds).toEqual(['session-a'])
    expect(selection.adoptedIds).toEqual([])
    expect(selection.canSweep).toBe(false)
  })

  it('never publishes an id archived on either side', () => {
    const selection = decision({
      localIds: ['session-a', 'session-b', 'session-c'],
      repoIds: [],
      archivedIds: ['session-a'],
      repoArchivedIds: ['session-b'],
    })
    expect(selection.publish).toBe(true)
    expect(selection.publishedIds).toEqual(['session-c'])
    expect(selection.retiredIds).toEqual([])
    expect(selection.ownedIds).toEqual(['session-a', 'session-b', 'session-c'])
  })

  it('adopts a repo-side move when the local set still equals the anchor', () => {
    expect(decision({ localIds: ['session-a', 'session-b'], repoIds: ['session-a'], anchor: anchor(['session-a', 'session-b']) }))
      .toEqual({
        publish: false,
        canSweep: true,
        selectedIds: ['session-a'],
        adoptedIds: [],
        droppedIds: ['session-b'],
        publishedIds: ['session-a'],
        retiredIds: [],
        ownedIds: ['session-a', 'session-b'],
      })
  })

  it('does not drop a repo-removed id this machine never owned', () => {
    const selection = decision({
      localIds: ['session-a', 'session-b'],
      repoIds: ['session-a'],
      anchor: anchor(['session-a', 'session-b'], ['session-a']),
    })
    expect(selection.droppedIds).toEqual([])
    expect(selection.publish).toBe(false)
    expect(selection.retiredIds).toEqual([])
  })

  it('needs no local drop for an archived id: the sweep owns its artifact', () => {
    const selection = decision({
      localIds: ['session-a', 'session-b'],
      repoIds: ['session-a'],
      anchor: anchor(['session-a', 'session-b']),
      archivedIds: ['session-b'],
    })
    expect(selection.droppedIds).toEqual([])
    expect(selection.retiredIds).toEqual([])
    expect(selection.publishedIds).toEqual(['session-a'])
  })

  it('refuses to sweep an empty repo selection: it may be a fresh repo, not a removal', () => {
    const selection = decision({ localIds: ['session-a', 'session-b'], repoIds: [], anchor: anchor(['session-a', 'session-b']) })
    expect(selection.canSweep).toBe(false)
    expect(selection.droppedIds).toEqual(['session-a', 'session-b'])
    expect(selection.retiredIds).toEqual([])
    expect(selection.publishedIds).toEqual([])
  })

  it('publishes a local edit and retires exactly the ids it owned', () => {
    const selection = decision({
      localIds: ['session-a'],
      repoIds: ['session-a', 'session-b'],
      anchor: anchor(['session-a', 'session-b']),
    })
    expect(selection.publish).toBe(true)
    expect(selection.canSweep).toBe(true)
    expect(selection.selectedIds).toEqual(['session-a', 'session-b'])
    // The repo's entries this machine does not hold are mirrored into its own
    // selection; the engine applies that mirror after the import pass, which is
    // why a locally dropped id re-enters the mirror until the next cycle reads
    // the removal it published.
    expect(selection.adoptedIds).toEqual(['session-b'])
    expect(selection.droppedIds).toEqual([])
    expect(selection.publishedIds).toEqual(['session-a'])
    expect(selection.retiredIds).toEqual(['session-b'])
    expect(selection.ownedIds).toEqual(['session-a', 'session-b'])
  })

  it('excludes an archived id from the publication and from retirement', () => {
    const selection = decision({
      localIds: ['session-a'],
      repoIds: ['session-a', 'session-b'],
      anchor: anchor(['session-a', 'session-b']),
      archivedIds: ['session-b'],
    })
    expect(selection.publishedIds).toEqual(['session-a'])
    expect(selection.retiredIds).toEqual([])
  })

  it('keeps another machine\'s entries a local edit never held, retiring only the ids it owned', () => {
    const selection = decision({
      localIds: ['session-a'],
      repoIds: ['session-a', 'session-c'],
      anchor: anchor(['session-a', 'session-d']),
    })
    expect(selection.publish).toBe(true)
    expect(selection.publishedIds).toEqual(['session-a', 'session-c'])
    expect(selection.retiredIds).toEqual(['session-d'])
    expect(selection.ownedIds).toEqual(['session-a', 'session-d'])
  })

  it('excludes a repo-archived id from the publication a fresh machine makes', () => {
    const selection = decision({
      localIds: ['session-a'],
      repoIds: ['session-a', 'session-b'],
      repoArchivedIds: ['session-b'],
    })
    expect(selection.publish).toBe(false)
    expect(selection.publishedIds).toEqual(['session-a'])
    expect(selection.adoptedIds).toEqual(['session-b'])
  })

  it('treats a missing repo selection as empty, so a fresh machine only adopts what it holds', () => {
    const selection = decision({ localIds: [], repoIds: undefined })
    expect(selection.publish).toBe(false)
    expect(selection.selectedIds).toEqual([])
    expect(selection.publishedIds).toEqual([])
    expect(selection.canSweep).toBe(false)
    expect(selection.ownedIds).toEqual([])
  })
})

describe('assignWorkspaceKey', () => {
  const base = mintedKey('demo')
  const input = {
    workspaceId: 'local-1',
    name: 'demo',
    remembered: new Map<string, string>(),
    repoKeysByName: new Map<string, string>(),
    claimed: new Set<string>(),
    existing: new Set<string>(),
  }

  it('returns the key this workspace was assigned before, even when the repo publishes another', () => {
    expect(assignWorkspaceKey({
      ...input,
      remembered: new Map([['local-1', 'ws-remembered']]),
      repoKeysByName: new Map([['demo', 'ws-repo']]),
      claimed: new Set(['ws-repo']),
      existing: new Set(['ws-repo']),
    })).toBe('ws-remembered')
  })

  it('converges on the key the repo already publishes under the same name', () => {
    expect(assignWorkspaceKey({
      ...input,
      repoKeysByName: new Map([['demo', 'ws-repo']]),
      existing: new Set(['ws-repo']),
    })).toBe('ws-repo')
  })

  it('does not reuse a published key another workspace claimed this cycle, minting a fresh one instead', () => {
    expect(assignWorkspaceKey({
      ...input,
      repoKeysByName: new Map([['demo', 'ws-repo']]),
      claimed: new Set(['ws-repo']),
      existing: new Set(['ws-repo']),
    })).toBe(base)
  })

  it('mints a name-derived key when the repo carries none', () => {
    expect(base).toMatch(/^ws-[0-9a-f]{10}$/)
    expect(assignWorkspaceKey({ ...input })).toBe(base)
  })

  it('suffixes a minted key that is already claimed or already in the repo', () => {
    expect(assignWorkspaceKey({ ...input, claimed: new Set([base]) })).toBe(`${base}-2`)
    expect(assignWorkspaceKey({ ...input, claimed: new Set([base, `${base}-2`]) })).toBe(`${base}-3`)
    expect(assignWorkspaceKey({ ...input, existing: new Set([base]) })).toBe(`${base}-2`)
  })
})

describe('foldTitle', () => {
  it('reads the latest session/title event of the log', () => {
    expect(foldTitle([...events(1), titleEvent('first', 2), ...events(1, 1), titleEvent('second', 4)]))
      .toBe('second')
  })

  it('keeps the previous title when a later title event carries no text', () => {
    expect(foldTitle([titleEvent('first'), { type: 'session/title', seq: 1, time: 2, data: {} } as SessionEvent]))
      .toBe('first')
  })

  it('answers an empty title for a log that carries none', () => {
    expect(foldTitle([])).toBe('')
    expect(foldTitle(events(1))).toBe('')
    expect(foldTitle([{ type: 'session/title', seq: 0, time: 1 } as SessionEvent])).toBe('')
    expect(foldTitle([{ type: 'session/title', seq: 0, time: 1, data: { title: 7 } } as unknown as SessionEvent])).toBe('')
  })
})

describe('runSyncCycle import', () => {
  it('imports a selected artifact into the uniquely named local workspace', async () => {
    const world = deps()
    world.fs.seed(repoWorkspace('ws-a', 'demo', { 'session-remote': artifactFor('session-remote', 'ws-a', 3) }))
    world.fs.files.set(selectionRepoPath(), selectionFile([entry('session-remote')]))
    const result = await runSyncCycle(world.deps)

    expect(result.imported).toBe(1)
    expect(result.pending).toEqual([])
    expect(result.errors).toEqual([])
    expect(world.persistence.created).toEqual(['session-remote'])
    expect(world.persistence.sessions.get('session-remote')!.events).toHaveLength(6)
    expect(world.persistence.sessions.get('session-remote')!.meta.cwd).toBe('/work/demo')
    expect(world.workspaces.attached.get('/work/demo')).toEqual(['session-remote'])
    expect(world.projectionCache.warmed).toEqual(['session-remote'])
    expect(result.importedIds).toEqual(['session-remote'])
    // The machine adopts the repo's entry and mirrors it locally.
    expect(result.adopted).toEqual(['session-remote'])
    expect(world.fs.localSelection).toEqual(['session-remote'])
  })

  it('defers a workspace no local workspace is named after to the pending list', async () => {
    const world = deps()
    world.fs.seed(repoWorkspace('ws-a', 'renamed', { 'session-remote': artifactFor('session-remote', 'ws-a', 1) }))
    world.fs.files.set(selectionRepoPath(), selectionFile([entry('session-remote')]))
    const result = await runSyncCycle(world.deps)

    expect(result.imported).toBe(0)
    expect(world.persistence.created).toEqual([])
    expect(result.pending).toEqual([{ key: 'ws-a', name: 'renamed', sessionIds: ['session-remote'], matches: 0 }])
    expect(result.errors).toEqual([])
  })

  it('defers a workspace several local workspaces share, importing nothing into a guess', async () => {
    const world = deps()
    world.workspaces.add('/work/demo-copy', 'demo', 'local-2')
    world.fs.seed(repoWorkspace('ws-a', 'demo', { 'session-remote': artifactFor('session-remote', 'ws-a', 1) }))
    world.fs.files.set(selectionRepoPath(), selectionFile([entry('session-remote')]))
    const result = await runSyncCycle(world.deps)

    expect(result.imported).toBe(0)
    expect(world.persistence.created).toEqual([])
    expect(result.pending).toEqual([{ key: 'ws-a', name: 'demo', sessionIds: ['session-remote'], matches: 2 }])
  })

  it('lists the pending sessions in id order and only the selected ones', async () => {
    const world = deps()
    world.fs.seed(repoWorkspace('ws-a', 'renamed', {
      'session-b': artifactFor('session-b', 'ws-a', 1),
      'session-a': artifactFor('session-a', 'ws-a', 1),
      'session-c': artifactFor('session-c', 'ws-a', 1),
    }))
    world.fs.files.set(selectionRepoPath(), selectionFile([entry('session-b'), entry('session-a')]))
    const result = await runSyncCycle(world.deps)

    expect(result.pending).toEqual([{ key: 'ws-a', name: 'renamed', sessionIds: ['session-a', 'session-b'], matches: 0 }])
  })

  it('imports nothing from a workspace whose artifacts the selection does not cover', async () => {
    const world = deps()
    world.fs.seed(repoWorkspace('ws-a', 'demo', { 'session-remote': artifactFor('session-remote', 'ws-a', 1) }))
    world.fs.files.set(selectionRepoPath(), selectionFile([]))
    const result = await runSyncCycle(world.deps)

    expect(result.imported).toBe(0)
    expect(world.persistence.created).toEqual([])
    expect(result.pending).toEqual([])
  })

  it('extends a local session when the repo artifact is a strict superset', async () => {
    const world = deps()
    world.persistence.seed('session-a', '/work/demo', 3)
    world.fs.seed(repoWorkspace('ws-a', 'demo', { 'session-a': artifactFor('session-a', 'ws-a', 5) }))
    world.fs.files.set(selectionRepoPath(), selectionFile([entry('session-a')]))
    const result = await runSyncCycle(world.deps)

    expect(result.imported).toBe(1)
    expect(world.persistence.appendCalls).toEqual([{ id: 'session-a', count: 4 }])
    expect(world.persistence.sessions.get('session-a')!.events).toHaveLength(10)
    expect(world.workspaces.attached.get('/work/demo')).toEqual(['session-a'])
  })

  it('imports nothing when local equals or extends the repo log', async () => {
    const world = deps()
    world.persistence.seed('session-a', '/work/demo', 5)
    world.fs.seed(repoWorkspace('ws-a', 'demo', { 'session-a': artifactFor('session-a', 'ws-a', 5) }))
    world.fs.files.set(selectionRepoPath(), selectionFile([entry('session-a')]))
    let result = await runSyncCycle(world.deps)
    expect(result.imported).toBe(0)
    expect(world.persistence.appendCalls).toEqual([])

    world.fs.files.set(sessionRepoPath('ws-a', SessionId('session-a')), artifactFor('session-a', 'ws-a', 3))
    result = await runSyncCycle(world.deps)
    expect(result.imported).toBe(0)
    expect(world.persistence.appendCalls).toEqual([])
  })

  it('preserves a divergent remote log as a conflict copy instead of merging', async () => {
    const world = deps()
    world.persistence.seed('session-a', '/work/demo', 3)
    const remote = artifactFor('session-a', 'ws-a', 3).replace('"turn":2', '"turn":99')
    world.fs.seed(repoWorkspace('ws-a', 'demo', { 'session-a': remote }))
    world.fs.files.set(selectionRepoPath(), selectionFile([entry('session-a')]))
    const result = await runSyncCycle(world.deps)

    expect(result.imported).toBe(0)
    expect(result.conflicts).toEqual(['conflicts/ws-a/session-a-test-host.jsonl'])
    expect(world.fs.files.get('conflicts/ws-a/session-a-test-host.jsonl')).toBe(remote)
    expect(world.persistence.appendCalls).toEqual([])
    // The divergence is recorded against the session's own history.
    const records = parseRecords(world.fs.files.get(recordsRepoPath('ws-a', SessionId('session-a')))!).records
    expect(records).toEqual([{ host: 'test-host', at: NOW_ISO, direction: 'pull', events: 0, result: 'conflict' }])
  })

  it('skips a repo artifact that ends mid-turn instead of importing a truncated snapshot', async () => {
    const world = deps()
    world.fs.seed(repoWorkspace('ws-a', 'demo', { 'session-live': artifactForEvents('session-live', 'ws-a', midTurnEvents()) }))
    world.fs.files.set(selectionRepoPath(), selectionFile([entry('session-live')]))
    const result = await runSyncCycle(world.deps)

    expect(result.imported).toBe(0)
    expect(world.persistence.sessions.has('session-live')).toBe(false)
    expect(result.importedIds).toEqual([])
    expect(result.errors.some(message => message.includes('ends mid-turn'))).toBe(true)
    // Nothing was transferred, so nothing is recorded either.
    expect(world.fs.files.has(recordsRepoPath('ws-a', SessionId('session-live')))).toBe(false)
  })

  it('records an error for an unparsable artifact and skips foreign file names', async () => {
    const world = deps()
    world.fs.seed(repoWorkspace('ws-a', 'demo', { 'session-bad': 'not json\n' }))
    world.fs.files.set(`${workspaceRepoDir('ws-a')}/README.md`, 'hello\n')
    world.fs.files.set(selectionRepoPath(), selectionFile([entry('session-bad')]))
    const result = await runSyncCycle(world.deps)

    expect(result.imported).toBe(0)
    expect(result.errors).toHaveLength(1)
    expect(result.errors[0]).toContain('ws-a/session-bad')
    expect(result.errors[0]).toContain('not valid JSON')
  })

  it('creates a header-only session without appending events', async () => {
    const world = deps()
    world.fs.seed(repoWorkspace('ws-a', 'demo', { 'session-empty': artifactFor('session-empty', 'ws-a', 0) }))
    world.fs.files.set(selectionRepoPath(), selectionFile([entry('session-empty')]))
    const result = await runSyncCycle(world.deps)

    expect(result.imported).toBe(1)
    expect(world.persistence.appendCalls).toEqual([])
    expect(world.persistence.sessions.get('session-empty')!.events).toHaveLength(0)
  })

  it('imports nothing without a workspace registry, reporting every repo workspace as pending', async () => {
    const world = deps()
    world.fs.seed(repoWorkspace('ws-a', 'demo', { 'session-remote': artifactFor('session-remote', 'ws-a', 1) }))
    world.fs.files.set(selectionRepoPath(), selectionFile([entry('session-remote')]))
    const result = await runSyncCycle(unregistered(world))

    expect(result.imported).toBe(0)
    expect(result.pending).toEqual([{ key: 'ws-a', name: 'demo', sessionIds: ['session-remote'], matches: 0 }])
    expect(result.errors).toEqual([])
  })

  it('records an attach failure and keeps the imported session', async () => {
    const world = deps()
    world.workspaces.failAttachOn = ['/work/demo']
    world.fs.seed(repoWorkspace('ws-a', 'demo', { 'session-remote': artifactFor('session-remote', 'ws-a', 1) }))
    world.fs.files.set(selectionRepoPath(), selectionFile([entry('session-remote')]))
    const result = await runSyncCycle(world.deps)

    expect(result.imported).toBe(1)
    expect(result.errors.some(message => message.includes('attach'))).toBe(true)
    expect(world.warnings.some(message => message.includes('attach'))).toBe(true)
  })

  it('skips a repo file that disappears between listing and reading', async () => {
    const world = deps()
    world.fs.phantom = [sessionRepoPath('ws-a', SessionId('session-remote'))]
    world.fs.seed(repoWorkspace('ws-a', 'demo'))
    world.fs.files.set(selectionRepoPath(), selectionFile([entry('session-remote')]))
    const result = await runSyncCycle(world.deps)
    expect(result.imported).toBe(0)
    expect(result.errors).toEqual([])
  })

  it('pre-warms the projection cache for created and extended sessions', async () => {
    const fresh = deps()
    fresh.fs.seed(repoWorkspace('ws-a', 'demo', { 'session-remote': artifactFor('session-remote', 'ws-a', 3) }))
    fresh.fs.files.set(selectionRepoPath(), selectionFile([entry('session-remote')]))
    expect((await runSyncCycle(fresh.deps)).imported).toBe(1)
    expect(fresh.projectionCache.warmed).toEqual(['session-remote'])

    const extended = deps()
    extended.persistence.seed('session-a', '/work/demo', 3)
    extended.fs.seed(repoWorkspace('ws-a', 'demo', { 'session-a': artifactFor('session-a', 'ws-a', 5) }))
    extended.fs.files.set(selectionRepoPath(), selectionFile([entry('session-a')]))
    expect((await runSyncCycle(extended.deps)).imported).toBe(1)
    expect(extended.projectionCache.warmed).toEqual(['session-a'])
  })

  it('does not warm sessions the cycle did not import', async () => {
    const world = deps()
    world.persistence.seed('session-a', '/work/demo', 5)
    world.projectionCache.servedIds.add('session-a')
    world.fs.seed(repoWorkspace('ws-a', 'demo', { 'session-a': artifactFor('session-a', 'ws-a', 5) }))
    world.fs.files.set(selectionRepoPath(), selectionFile([entry('session-a')]))
    let result = await runSyncCycle(world.deps)
    expect(result.imported).toBe(0)
    expect(world.projectionCache.warmed).toEqual([])

    // remote-prefix: local already extends the repo, nothing appended.
    world.fs.files.set(sessionRepoPath('ws-a', SessionId('session-a')), artifactFor('session-a', 'ws-a', 3))
    result = await runSyncCycle(world.deps)
    expect(result.imported).toBe(0)
    expect(world.projectionCache.warmed).toEqual([])
  })

  it('contains a warm-up failure and still reports the import', async () => {
    const world = deps()
    world.projectionCache.failOn = ['session-remote']
    world.fs.seed(repoWorkspace('ws-a', 'demo', { 'session-remote': artifactFor('session-remote', 'ws-a', 1) }))
    world.fs.files.set(selectionRepoPath(), selectionFile([entry('session-remote')]))
    const result = await runSyncCycle(world.deps)

    expect(result.imported).toBe(1)
    expect(result.errors).toEqual([])
    expect(world.warnings.some(message => message.includes('projection warm-up'))).toBe(true)
  })

  it('reports imported ids for switch-notice arming on create and extend, skipping subagent sessions', async () => {
    const world = deps()
    world.fs.seed(repoWorkspace('ws-a', 'demo', { 'session-remote': artifactFor('session-remote', 'ws-a', 3) }))
    world.fs.files.set(selectionRepoPath(), selectionFile([entry('session-remote')]))
    let result = await runSyncCycle(world.deps)
    expect(result.importedIds).toEqual(['session-remote'])

    // Extend: the repo grows while local state is a prefix → imported again.
    world.fs.files.set(sessionRepoPath('ws-a', SessionId('session-remote')), artifactFor('session-remote', 'ws-a', 5))
    result = await runSyncCycle(world.deps)
    expect(result.imported).toBe(1)
    expect(result.importedIds).toEqual(['session-remote'])
    expect(world.persistence.sessions.get('session-remote')!.events).toHaveLength(10)

    // Equal logs import nothing: no switch mark.
    result = await runSyncCycle(world.deps)
    expect(result.imported).toBe(0)
    expect(result.importedIds).toEqual([])

    // A subagent session still imports, but never arms a user-chat notice.
    world.fs.files.set(
      sessionRepoPath('ws-a', SessionId('session-sub')),
      artifactForEvents('session-sub', 'ws-a', events(1), { origin: 'subagent' }),
    )
    world.fs.files.set(selectionRepoPath(), selectionFile([entry('session-remote'), entry('session-sub')]))
    result = await runSyncCycle(world.deps)
    expect(result.imported).toBe(1)
    expect(result.importedIds).toEqual([])
    expect(world.persistence.created).toContain('session-sub')
  })

  it('writes one pull record per imported session, merged into an existing history', async () => {
    const world = deps()
    world.fs.seed(repoWorkspace('ws-a', 'demo', { 'session-remote': artifactFor('session-remote', 'ws-a', 2) }))
    world.fs.files.set(selectionRepoPath(), selectionFile([entry('session-remote')]))
    world.fs.files.set(recordsRepoPath('ws-a', SessionId('session-remote')), JSON.stringify({
      version: 2,
      records: [{ host: 'other-host', at: '2026-09-01T00:00:00.000Z', direction: 'push', events: 2, result: 'ok' }],
    }) + '\n')
    await runSyncCycle(world.deps)

    const records = parseRecords(world.fs.files.get(recordsRepoPath('ws-a', SessionId('session-remote')))!).records
    expect(records).toEqual([
      { host: 'other-host', at: '2026-09-01T00:00:00.000Z', direction: 'push', events: 2, result: 'ok' },
      { host: 'test-host', at: NOW_ISO, direction: 'pull', events: 4, result: 'ok' },
    ])
  })

  it('replaces an unparsable records file with the fresh record and reports it', async () => {
    const world = deps()
    world.fs.seed(repoWorkspace('ws-a', 'demo', { 'session-remote': artifactFor('session-remote', 'ws-a', 1) }))
    world.fs.files.set(selectionRepoPath(), selectionFile([entry('session-remote')]))
    world.fs.files.set(recordsRepoPath('ws-a', SessionId('session-remote')), 'broken\n')
    const result = await runSyncCycle(world.deps)

    expect(result.errors.some(message => message.includes('records unparsable'))).toBe(true)
    expect(parseRecords(world.fs.files.get(recordsRepoPath('ws-a', SessionId('session-remote')))!).records)
      .toHaveLength(1)
  })

  it('reports an unparsable manifest and imports nothing from that workspace', async () => {
    const world = deps()
    world.fs.seed(repoWorkspace('ws-a', 'demo', { 'session-remote': artifactFor('session-remote', 'ws-a', 1) }))
    world.fs.files.set(manifestRepoPath('ws-a'), 'broken\n')
    world.fs.files.set(selectionRepoPath(), selectionFile([entry('session-remote')]))
    const result = await runSyncCycle(world.deps)

    expect(result.imported).toBe(0)
    expect(result.errors).toEqual(['workspaces/ws-a/manifest.json: workspace manifest: not valid JSON'])
  })
})

describe('runSyncCycle export', () => {
  it('exports a locally selected session, creating its manifest, artifact, records, and selection entry', async () => {
    const world = deps()
    world.persistence.seed('session-a', '/work/demo', 2, { title: 'My session' })
    world.fs.localSelection = ['session-a']
    const result = await runSyncCycle(world.deps)
    const key = mintedKey('demo')

    expect(result.pushed).toBe(1)
    expect(result.publishedSelection).toEqual(['session-a'])
    expect(result.errors).toEqual([])
    expect(world.fs.files.get(manifestRepoPath(key))).toBe(
      serializeManifest({ key, name: 'demo', updatedAt: NOW_ISO }),
    )

    const artifact = world.fs.files.get(sessionRepoPath(key, SessionId('session-a')))!
    expect(artifact).toContain(`"workspace":"${key}"`)
    expect(artifact).not.toContain('/work/demo')
    expect(parsePortableSession(artifact, '/local').events).toEqual(events(2).concat(titleEvent('My session', 4)))
    // The old `projects/` layout is gone: nothing may land outside `workspaces/`.
    expect([...world.fs.files.keys()].every(rel => !rel.startsWith('projects/'))).toBe(true)

    const records = parseRecords(world.fs.files.get(recordsRepoPath(key, SessionId('session-a')))!).records
    expect(records).toEqual([{ host: 'test-host', at: NOW_ISO, direction: 'push', events: 5, result: 'ok' }])

    const selection = parseSelection(world.fs.files.get(selectionRepoPath())!)
    expect(selection).toEqual({
      host: 'test-host',
      updatedAt: NOW_ISO,
      entries: [{
        id: SessionId('session-a'),
        key,
        workspaceName: 'demo',
        title: 'My session',
        addedAt: NOW_ISO,
        addedBy: 'test-host',
      }],
    })

    expect(world.fs.localSelection).toEqual(['session-a'])
    expect(world.fs.localSelectionWrites).toEqual([])
    expect(world.fs.stateWrites.at(-1)).toEqual({
      firstSeen: true,
      syncedIds: [SessionId('session-a')],
      ownedIds: [SessionId('session-a')],
      workspaceKeys: [{ workspaceId: 'local-1', key }],
      updatedAt: NOW_ISO,
      host: 'test-host',
    })
  })

  it('keeps the remembered key and rewrites only the manifest name when a workspace is renamed', async () => {
    const world = deps()
    world.workspaces.entries[0]!.title = 'renamed'
    world.fs.syncState = { ...anchor(['session-a']), workspaceKeys: [{ workspaceId: 'local-1', key: 'ws-old' }] }
    world.fs.localSelection = ['session-a']
    world.persistence.seed('session-a', '/work/demo', 1)
    world.fs.seed(repoWorkspace('ws-old', 'demo'))
    world.fs.files.set(selectionRepoPath(), selectionFile([entry('session-a', 'ws-old')]))

    const result = await runSyncCycle(world.deps)

    expect(result.pushed).toBe(1)
    expect(world.fs.files.has(sessionRepoPath('ws-old', SessionId('session-a')))).toBe(true)
    expect(world.fs.files.get(manifestRepoPath('ws-old'))).toBe(
      serializeManifest({ key: 'ws-old', name: 'renamed', updatedAt: NOW_ISO }),
    )
    // The key never moves, so the renamed machine still publishes under it.
    expect(world.fs.localSelectionWrites).toEqual([])
  })

  it('converges on the key the repo publishes under the same workspace name', async () => {
    const world = deps()
    world.persistence.seed('session-a', '/work/demo', 1)
    world.fs.localSelection = ['session-a']
    world.fs.seed(repoWorkspace('ws-published', 'demo'))
    world.fs.files.set(selectionRepoPath(), selectionFile([]))

    const result = await runSyncCycle(world.deps)
    expect(result.pushed).toBe(1)
    expect(world.fs.files.has(sessionRepoPath('ws-published', SessionId('session-a')))).toBe(true)
    // The manifest already carried the right name: it is not rewritten.
    expect(world.fs.files.get(manifestRepoPath('ws-published'))).toBe(serializeManifest({
      key: 'ws-published', name: 'demo', updatedAt: '2026-09-01T00:00:00.000Z',
    }))
    expect(result.publishedSelection).toEqual(['session-a'])
  })

  it('skips exporting a session this machine has not selected', async () => {
    const world = deps()
    world.persistence.seed('session-local', '/work/demo', 2)
    const result = await runSyncCycle(world.deps)

    expect(result.pushed).toBe(0)
    expect(result.publishedSelection).toBeUndefined()
    expect([...world.fs.files.keys()].some(rel => rel.endsWith('.jsonl'))).toBe(false)
  })

  it('reports a selected session that is not in any local workspace instead of guessing a placement', async () => {
    const world = deps()
    world.persistence.seed('session-elsewhere', '/elsewhere/project', 2)
    world.fs.localSelection = ['session-elsewhere']
    const result = await runSyncCycle(world.deps)

    expect(result.pushed).toBe(0)
    expect(result.publishedSelection).toEqual([])
    expect(result.errors).toEqual([
      'export session-elsewhere: session is not in any local workspace',
      'selection: cannot publish session-elsewhere — this machine cannot describe its workspace',
    ])
    expect([...world.fs.files.keys()].some(rel => rel.endsWith('.jsonl'))).toBe(false)
  })

  it('reports a selected session whose header carries no cwd', async () => {
    const world = deps()
    world.persistence.noCwdList = ['session-nocwd']
    world.fs.localSelection = ['session-nocwd']
    const result = await runSyncCycle(world.deps)

    expect(result.pushed).toBe(0)
    expect(result.errors).toEqual([
      'export session-nocwd: session header carries no cwd',
      'selection: cannot publish session-nocwd — this machine cannot describe its workspace',
    ])
  })

  it('skips a listed session whose log is gone and exports nothing for it', async () => {
    const world = deps()
    world.persistence.phantomList = ['session-gone']
    world.fs.localSelection = ['session-gone']
    // The workspace registry resolves the path, but the log read answers undefined.
    const result = await runSyncCycle(world.deps)
    expect(result.pushed).toBe(0)
    expect(result.errors).toEqual([
      'selection: cannot publish session-gone — this machine cannot describe its workspace',
    ])
    expect(result.publishedSelection).toEqual([])
  })

  it('leaves the repo artifact untouched when local equals it', async () => {
    const world = deps()
    world.persistence.seed('session-a', '/work/demo', 3)
    const remote = artifactFor('session-a', 'ws-a', 3)
    world.fs.seed(repoWorkspace('ws-a', 'demo', { 'session-a': remote }))
    world.fs.localSelection = ['session-a']
    const result = await runSyncCycle(world.deps)

    expect(result.pushed).toBe(0)
    expect(world.fs.files.get(sessionRepoPath('ws-a', SessionId('session-a')))).toBe(remote)
  })

  it('overwrites the repo artifact when local extends it', async () => {
    const world = deps()
    world.persistence.seed('session-a', '/work/demo', 5)
    world.fs.seed(repoWorkspace('ws-a', 'demo', { 'session-a': artifactFor('session-a', 'ws-a', 3) }))
    world.fs.localSelection = ['session-a']
    const result = await runSyncCycle(world.deps)

    expect(result.pushed).toBe(1)
    const written = world.fs.files.get(sessionRepoPath('ws-a', SessionId('session-a')))!
    expect(parsePortableSession(written, '/x').events).toEqual(events(5))
    expect(parseRecords(world.fs.files.get(recordsRepoPath('ws-a', SessionId('session-a')))!).records)
      .toEqual([{ host: 'test-host', at: NOW_ISO, direction: 'push', events: 10, result: 'ok' }])
  })

  it('preserves a divergent repo tail as a conflict copy and leaves the repo artifact untouched', async () => {
    const world = deps()
    world.persistence.seed('session-a', '/work/demo', 3)
    const remote = artifactFor('session-a', 'ws-a', 3).replace('"turn":2', '"turn":99')
    world.fs.seed(repoWorkspace('ws-a', 'demo', { 'session-a': remote }))
    world.fs.localSelection = ['session-a']
    const result = await runSyncCycle(world.deps)

    expect(result.pushed).toBe(0)
    expect(result.conflicts).toEqual(['conflicts/ws-a/session-a-test-host.jsonl'])
    expect(world.fs.files.get('conflicts/ws-a/session-a-test-host.jsonl')).toBe(remote)
    // The repo artifact is never overwritten by a divergent local log.
    expect(world.fs.files.get(sessionRepoPath('ws-a', SessionId('session-a')))).toBe(remote)
  })

  it('skips exporting a session whose stored log ends mid-turn', async () => {
    const world = deps()
    world.persistence.seedEvents('session-live', '/work/demo', midTurnEvents())
    world.fs.localSelection = ['session-live']
    const result = await runSyncCycle(world.deps)

    expect(result.pushed).toBe(0)
    expect(result.errors).toEqual([
      'selection: cannot publish session-live — this machine cannot describe its workspace',
    ])
    expect(world.fs.files.has(sessionRepoPath('ws-a', SessionId('session-live')))).toBe(false)
    expect(result.publishedSelection).toEqual([])
  })

  it('overwrites an unparsable repo artifact and records the failure', async () => {
    const world = deps()
    world.persistence.seed('session-a', '/work/demo', 2)
    world.fs.seed(repoWorkspace('ws-a', 'demo', { 'session-a': 'broken\n' }))
    world.fs.localSelection = ['session-a']
    const result = await runSyncCycle(world.deps)

    expect(result.pushed).toBe(1)
    expect(result.errors.some(message => message.includes('unparsable, overwriting'))).toBe(true)
  })

  it('reports a contained per-session failure without failing the cycle', async () => {
    const world = deps()
    world.persistence.seed('session-a', '/work/demo', 2)
    world.fs.localSelection = ['session-a']
    world.persistence.failReadFrom = true
    const result = await runSyncCycle(world.deps)

    expect(result.errors).toEqual([
      'export session-a: reading the local log failed (readFrom failed)',
      'selection: cannot publish session-a — this machine cannot describe its workspace',
    ])
    expect(result.pushed).toBe(0)
    expect(world.git.calls).toContain('push')
  })

  it('never re-exports a session the same cycle imported', async () => {
    const world = deps()
    world.fs.seed(repoWorkspace('ws-a', 'demo', { 'session-remote': artifactFor('session-remote', 'ws-a', 2) }))
    world.fs.files.set(selectionRepoPath(), selectionFile([entry('session-remote')]))
    const result = await runSyncCycle(world.deps)

    expect(result.imported).toBe(1)
    expect(result.pushed).toBe(0)
  })

  it('skips an archived session in the export pass', async () => {
    const world = deps()
    world.persistence.seed('session-a', '/work/demo', 2)
    world.fs.localSelection = ['session-a']
    world.workspaces.archivedIds.push(SessionId('session-a'))
    const result = await runSyncCycle(world.deps)

    expect(result.pushed).toBe(0)
    expect(result.deleted).toBe(0)
    expect(world.fs.files.has(sessionRepoPath('ws-a', SessionId('session-a')))).toBe(false)
  })

  it('gives every session of one workspace the same repo key inside a single cycle', async () => {
    const world = deps()
    // Both sessions belong to the same workspace and this machine has never
    // exported it before: the key is minted once and reused, not re-minted (and
    // therefore suffixed `-2`) for the second session in the same pass.
    world.persistence.seed('session-a', '/work/demo', 2)
    world.persistence.seed('session-b', '/work/demo', 2)
    world.fs.localSelection = ['session-a', 'session-b']

    const result = await runSyncCycle(world.deps)

    const key = mintedKey('demo')
    expect(result.errors).toEqual([])
    expect(result.pushed).toBe(2)
    expect(result.publishedSelection).toEqual(['session-a', 'session-b'])
    for (const id of ['session-a', 'session-b']) {
      expect(world.fs.files.has(sessionRepoPath(key, SessionId(id)))).toBe(true)
    }
    // Exactly two artifacts and one manifest: a second directory for the same
    // workspace would be a `ws-…-2` sibling.
    expect([...world.fs.files.keys()].filter(rel => rel.endsWith('.jsonl'))).toHaveLength(2)
    expect([...world.fs.files.keys()].filter(rel => rel.endsWith('manifest.json'))).toEqual([manifestRepoPath(key)])
    expect(world.fs.stateWrites.at(-1)?.workspaceKeys).toEqual([{ workspaceId: 'local-1', key }])
  })
})

describe('runSyncCycle selection convergence', () => {
  it('mirrors an adopted selection into this machine\'s own files and anchors it', async () => {
    const world = deps()
    world.fs.seed(repoWorkspace('ws-a', 'demo', { 'session-remote': artifactFor('session-remote', 'ws-a', 2) }))
    world.fs.files.set(selectionRepoPath(), selectionFile([entry('session-remote')]))
    const result = await runSyncCycle(world.deps)

    expect(result.adopted).toEqual(['session-remote'])
    expect(result.dropped).toEqual([])
    expect(result.publishedSelection).toBeUndefined()
    expect(world.fs.localSelectionWrites).toEqual([['session-remote']])
    expect(world.fs.stateWrites).toHaveLength(1)
    expect(world.fs.stateWrites[0]).toMatchObject({
      firstSeen: true,
      syncedIds: [SessionId('session-remote')],
      ownedIds: [SessionId('session-remote')],
      host: 'test-host',
      updatedAt: NOW_ISO,
    })
  })

  it('publishes a local removal, retires the artifact with its records, and converges the mirror', async () => {
    const world = deps()
    world.persistence.seed('session-a', '/work/demo', 2)
    world.persistence.seed('session-b', '/work/demo', 2)
    world.fs.seed(repoWorkspace('ws-a', 'demo', {
      'session-a': artifactFor('session-a', 'ws-a', 2),
      'session-b': artifactFor('session-b', 'ws-a', 2),
    }))
    world.fs.files.set(recordsRepoPath('ws-a', SessionId('session-b')), JSON.stringify({ version: 2, records: [] }) + '\n')
    world.fs.files.set(selectionRepoPath(), selectionFile([entry('session-a'), entry('session-b')]))
    world.fs.syncState = anchor(['session-a', 'session-b'])
    world.fs.localSelection = ['session-a']

    const first = await runSyncCycle(world.deps)

    expect(first.publishedSelection).toEqual(['session-a'])
    expect(parseSelection(world.fs.files.get(selectionRepoPath())!).entries.map(item => String(item.id)))
      .toEqual(['session-a'])
    // The retired session's repo files are gone from every workspace directory,
    // and its local log is untouched.
    expect(world.fs.files.has(sessionRepoPath('ws-a', SessionId('session-b')))).toBe(false)
    expect(world.fs.files.has(recordsRepoPath('ws-a', SessionId('session-b')))).toBe(false)
    expect(world.fs.files.has(sessionRepoPath('ws-a', SessionId('session-a')))).toBe(true)
    expect(world.persistence.sessions.has('session-b')).toBe(true)

    // The next cycle converges the local mirror on the published selection.
    const second = await runSyncCycle(world.deps)
    expect(second.publishedSelection).toBeUndefined()
    expect(world.fs.localSelection).toEqual(['session-a'])
  })

  it('adopts a repo-side removal only for the ids this machine owns', async () => {
    const world = deps()
    world.persistence.seed('session-a', '/work/demo', 2)
    world.persistence.seed('session-b', '/work/demo', 2)
    world.fs.seed(repoWorkspace('ws-a', 'demo', {
      'session-a': artifactFor('session-a', 'ws-a', 2),
      'session-b': artifactFor('session-b', 'ws-a', 2),
    }))
    world.fs.files.set(selectionRepoPath(), selectionFile([entry('session-a')]))
    // session-b was never this machine's to retire: it never owned it.
    world.fs.syncState = anchor(['session-a', 'session-b'], ['session-a'])
    world.fs.localSelection = ['session-a', 'session-b']

    const first = await runSyncCycle(world.deps)

    expect(first.dropped).toEqual([])
    expect(first.deletedUnselected).toBe(0)
    expect(world.fs.files.has(sessionRepoPath('ws-a', SessionId('session-b')))).toBe(true)

    // Owning it one cycle later is what lets the mirror drop it.
    const second = await runSyncCycle(world.deps)
    expect(second.dropped).toEqual(['session-b'])
    expect(world.fs.localSelection).toEqual(['session-a'])
  })

  it('adopts a repo-side removal without retiring the artifact it still holds', async () => {
    const world = deps()
    world.persistence.seed('session-a', '/work/demo', 2)
    world.persistence.seed('session-b', '/work/demo', 2)
    world.fs.seed(repoWorkspace('ws-a', 'demo', {
      'session-a': artifactFor('session-a', 'ws-a', 2),
      'session-b': artifactFor('session-b', 'ws-a', 2),
    }))
    world.fs.files.set(selectionRepoPath(), selectionFile([entry('session-a')]))
    world.fs.syncState = anchor(['session-a', 'session-b'])
    world.fs.localSelection = ['session-a', 'session-b']

    const result = await runSyncCycle(world.deps)

    expect(result.dropped).toEqual(['session-b'])
    expect(result.publishedSelection).toBeUndefined()
    expect(result.deletedUnselected).toBe(0)
    expect(world.fs.localSelection).toEqual(['session-a'])
    // Another machine still holds the artifact; this cycle does not touch it.
    expect(world.fs.files.has(sessionRepoPath('ws-a', SessionId('session-b')))).toBe(true)
  })

  it('republishes a local selection whose cycle failed before the push', async () => {
    const world = deps()
    world.persistence.seed('session-a', '/work/demo', 2)
    world.fs.localSelection = ['session-a']
    world.fs.syncState = anchor([], [])
    world.fs.files.set(selectionRepoPath(), selectionFile([]))
    world.git.failAt = 'push'

    await expect(runSyncCycle(world.deps)).rejects.toThrow('git push failed')
    // The remote never accepted the selection, so the anchor stays untouched.
    expect(world.fs.stateWrites).toEqual([])

    // The next cycle starts from the remote state (`resetHard` discarded the
    // unpublished write), where the selection still reads as a local edit.
    world.git.failAt = undefined
    world.fs.files.set(selectionRepoPath(), selectionFile([]))
    const second = await runSyncCycle(world.deps)

    expect(second.publishedSelection).toEqual(['session-a'])
    expect(parseSelection(world.fs.files.get(selectionRepoPath())!).entries.map(item => String(item.id)))
      .toEqual(['session-a'])
    expect(world.fs.stateWrites).toHaveLength(1)
  })

  it('writes the anchor once and only again when the applied selection changes', async () => {
    const world = deps()
    world.persistence.seed('session-a', '/work/demo', 2)
    world.fs.seed(repoWorkspace('ws-a', 'demo', { 'session-a': artifactFor('session-a', 'ws-a', 2) }))
    world.fs.files.set(selectionRepoPath(), selectionFile([entry('session-a')]))
    world.fs.localSelection = ['session-a']

    await runSyncCycle(world.deps)
    expect(world.fs.stateWrites).toHaveLength(1)

    await runSyncCycle(world.deps)
    expect(world.fs.stateWrites).toHaveLength(1)

    world.persistence.seed('session-b', '/work/demo', 2)
    world.fs.localSelection = ['session-a', 'session-b']
    await runSyncCycle(world.deps)
    expect(world.fs.stateWrites).toHaveLength(2)
    expect(world.fs.stateWrites[1]!.syncedIds.map(String)).toEqual(['session-a', 'session-b'])
  })

  it('records an unparsable selection, gates no artifact on it, and leaves the file alone', async () => {
    const world = deps()
    world.fs.seed(repoWorkspace('ws-a', 'demo', { 'session-a': artifactFor('session-a', 'ws-a', 2) }))
    world.fs.files.set(selectionRepoPath(), 'broken\n')
    // A machine whose local selection still matches its anchor has nothing to
    // publish, so the unreadable snapshot survives the cycle.
    world.fs.syncState = anchor([])
    world.fs.localSelection = []

    const result = await runSyncCycle(world.deps)

    expect(result.imported).toBe(0)
    expect(result.pushed).toBe(0)
    expect(result.publishedSelection).toBeUndefined()
    expect(result.errors).toEqual(['sync.json: selection: not valid JSON'])
    expect(world.fs.files.get(selectionRepoPath())).toBe('broken\n')
    expect(world.fs.stateWrites).toEqual([])
  })

  it('refuses to publish over an unreadable selection when this machine has a local edit', async () => {
    const world = deps()
    world.fs.files.set(selectionRepoPath(), 'broken\n')
    // The anchor says this machine held nothing, and the local selection now
    // names a session: the decision wants to publish. What it would overwrite
    // is a snapshot this machine failed to read, so it must not.
    world.fs.syncState = anchor([])
    world.fs.localSelection = ['session-a']
    world.persistence.seed('session-a', '/work/demo', 2)

    const result = await runSyncCycle(world.deps)

    expect(result.publishedSelection).toBeUndefined()
    expect(world.fs.files.get(selectionRepoPath())).toBe('broken\n')
    expect(result.errors).toContain('sync.json: refusing to publish over an unreadable selection')
  })

  it('still publishes when the repository simply has no selection yet', async () => {
    const world = deps()
    // Absence is not corruption: this is how the first machine creates the
    // shared selection, and the guard above must not block it.
    world.fs.localSelection = ['session-a']
    world.persistence.seed('session-a', '/work/demo', 2)

    const result = await runSyncCycle(world.deps)

    expect(result.publishedSelection).toEqual(['session-a'])
    expect(result.errors.filter(message => message.includes('refusing to publish'))).toEqual([])
  })
})

describe('runSyncCycle archive import', () => {
  it('marks locally held sessions from the repo list and never imports their artifacts', async () => {
    const world = deps()
    world.persistence.seed('session-held', '/work/demo', 1)
    world.fs.seed(repoWorkspace('ws-a', 'demo', {
      'session-remote': artifactFor('session-remote', 'ws-a', 1),
      'session-held': artifactFor('session-held', 'ws-a', 1),
    }))
    world.fs.files.set(archiveRepoPath('ws-a'), serializeArchiveList([
      SessionId('session-remote'), SessionId('session-held'), SessionId('session-ghost'),
    ]))
    world.fs.files.set(selectionRepoPath(), selectionFile([entry('session-remote'), entry('session-held')]))
    const result = await runSyncCycle(world.deps)

    // An archived id is excluded from the selection before the import runs: it
    // never materializes here, and an id this machine does not hold is skipped
    // (the registry refuses unknown ids).
    expect(result.imported).toBe(0)
    expect(world.persistence.created).toEqual([])
    expect(result.archived).toBe(1)
    expect(world.workspaces.archivedIds.map(String)).toEqual(['session-held'])
  })

  it('skips ids already archived', async () => {
    const world = deps()
    world.persistence.seed('session-a', '/work/demo', 1)
    world.workspaces.archivedIds.push(SessionId('session-a'))
    world.fs.seed(repoWorkspace('ws-a', 'demo', { 'session-a': artifactFor('session-a', 'ws-a', 1) }))
    world.fs.files.set(archiveRepoPath('ws-a'), serializeArchiveList([SessionId('session-a'), SessionId('session-b')]))
    const result = await runSyncCycle(world.deps)

    expect(result.archived).toBe(0)
    expect(world.workspaces.archivedIds.map(String)).toEqual(['session-a'])
  })

  it('records an unparsable archive list and skips its marks', async () => {
    const world = deps()
    world.fs.seed(repoWorkspace('ws-a', 'demo', { 'session-remote': artifactFor('session-remote', 'ws-a', 1) }))
    world.fs.files.set(archiveRepoPath('ws-a'), 'broken\n')
    world.fs.files.set(selectionRepoPath(), selectionFile([entry('session-remote')]))
    const result = await runSyncCycle(world.deps)

    expect(result.imported).toBe(1)
    expect(result.archived).toBe(0)
    expect(result.errors.some(message => message.includes('archived.json'))).toBe(true)
  })

  it('reports a per-id archive failure and keeps the cycle working', async () => {
    const world = deps()
    world.persistence.seed('session-held', '/work/demo', 1)
    world.fs.seed(repoWorkspace('ws-a', 'demo', { 'session-held': artifactFor('session-held', 'ws-a', 1) }))
    world.fs.files.set(archiveRepoPath('ws-a'), serializeArchiveList([SessionId('session-held')]))
    world.workspaces.failArchiveOn = ['session-held']
    const result = await runSyncCycle(world.deps)

    expect(result.archived).toBe(0)
    expect(result.errors).toEqual(['archive session-held in "/work/demo" failed: archive rejected'])
    expect(world.warnings.some(message => message.includes('archive "session-held" failed'))).toBe(true)
  })

  it('skips archive application when the composition mounts no workspace registry', async () => {
    const world = deps()
    world.fs.seed(repoWorkspace('ws-a', 'demo', { 'session-remote': artifactFor('session-remote', 'ws-a', 1) }))
    world.fs.files.set(archiveRepoPath('ws-a'), serializeArchiveList([SessionId('session-remote')]))
    world.fs.files.set(selectionRepoPath(), selectionFile([entry('session-remote')]))
    const result = await runSyncCycle(unregistered(world))

    // Without a registry there is no archive set to consult, but the repo's
    // own mark still keeps the artifact out: an archived session never syncs.
    expect(result.imported).toBe(0)
    expect(result.archived).toBe(0)
    // The only artifact under the workspace is archived, so nothing waits for a
    // matching local workspace.
    expect(result.pending).toEqual([])
    expect(result.errors).toEqual([])
  })
})

describe('runSyncCycle archive export', () => {
  it('unions locally archived sessions into the repo archive list', async () => {
    const world = deps()
    world.persistence.seed('session-a', '/work/demo', 1)
    world.workspaces.archivedIds.push(SessionId('session-a'))
    // The workspace already has a repo directory, which is what attributes the
    // mark to its key; the local session is what proves this machine holds it.
    world.fs.seed(repoWorkspace('ws-a', 'demo'))
    const result = await runSyncCycle(world.deps)

    expect(result.errors).toEqual([])
    expect(world.fs.files.get(archiveRepoPath('ws-a'))).toBe(serializeArchiveList([SessionId('session-a')]))
  })

  it('preserves repo marks this machine does not hold and never removes ids', async () => {
    const world = deps()
    world.persistence.seed('session-a', '/work/demo', 1)
    world.workspaces.archivedIds.push(SessionId('session-a'))
    world.fs.seed(repoWorkspace('ws-a', 'demo', {}))
    world.fs.files.set(archiveRepoPath('ws-a'), serializeArchiveList([SessionId('session-remote')]))
    await runSyncCycle(world.deps)

    expect(world.fs.files.get(archiveRepoPath('ws-a'))).toBe(
      serializeArchiveList([SessionId('session-a'), SessionId('session-remote')]),
    )
  })

  it('propagates the mark of an archived session deleted locally and purges its repo files', async () => {
    const world = deps()
    world.workspaces.archivedIds.push(SessionId('session-gone'))
    // The artifact fails import (as a deleted local session's ghost would), so
    // only its repo file name attributes the mark to this workspace.
    world.fs.seed(repoWorkspace('ws-a', 'demo', { 'session-gone': 'broken\n' }))
    world.fs.files.set(recordsRepoPath('ws-a', SessionId('session-gone')), JSON.stringify({ version: 2, records: [] }) + '\n')
    const result = await runSyncCycle(world.deps)

    // The mark is written while the file still exists, and the sweep then
    // deletes the file: the id keeps travelling, the artifact stops.
    expect(world.fs.files.get(archiveRepoPath('ws-a'))).toBe(serializeArchiveList([SessionId('session-gone')]))
    expect(world.fs.files.has(sessionRepoPath('ws-a', SessionId('session-gone')))).toBe(false)
    expect(world.fs.files.has(recordsRepoPath('ws-a', SessionId('session-gone')))).toBe(false)
    expect(result.deleted).toBe(1)
  })

  it('does not export marks of sessions owned by another workspace', async () => {
    const world = deps()
    world.persistence.seed('session-elsewhere', '/elsewhere/project', 1)
    world.workspaces.archivedIds.push(SessionId('session-elsewhere'))
    await runSyncCycle(world.deps)

    expect(world.fs.files.has(archiveRepoPath('ws-a'))).toBe(false)
  })

  it('leaves the repo archive list untouched when local contributes nothing', async () => {
    const world = deps()
    const existing = serializeArchiveList([SessionId('session-remote')])
    world.fs.seed(repoWorkspace('ws-a', 'demo', {}))
    world.fs.files.set(archiveRepoPath('ws-a'), existing)
    await runSyncCycle(world.deps)

    expect(world.fs.files.get(archiveRepoPath('ws-a'))).toBe(existing)
  })

  it('overwrites an unparsable repo archive list and records the failure', async () => {
    const world = deps()
    world.persistence.seed('session-a', '/work/demo', 1)
    world.workspaces.archivedIds.push(SessionId('session-a'))
    world.fs.seed(repoWorkspace('ws-a', 'demo', {}))
    world.fs.files.set(archiveRepoPath('ws-a'), 'broken\n')
    const result = await runSyncCycle(world.deps)

    expect(world.fs.files.get(archiveRepoPath('ws-a'))).toBe(serializeArchiveList([SessionId('session-a')]))
    expect(result.errors.some(message => message.includes('unparsable, overwriting'))).toBe(true)
  })

  it('skips archive export when the composition mounts no workspace registry', async () => {
    const world = deps()
    world.persistence.seed('session-a', '/work/demo', 1)
    world.workspaces.archivedIds.push(SessionId('session-a'))
    await runSyncCycle(unregistered(world))

    expect(world.fs.files.has(archiveRepoPath('ws-a'))).toBe(false)
  })
})

describe('runSyncCycle archive deletion', () => {
  it('deletes the repo artifact and records of an archived session, keeping the local copy', async () => {
    const world = deps()
    world.persistence.seed('session-a', '/work/demo', 3)
    world.workspaces.archivedIds.push(SessionId('session-a'))
    world.fs.seed(repoWorkspace('ws-a', 'demo', { 'session-a': artifactFor('session-a', 'ws-a', 3) }))
    world.fs.files.set(recordsRepoPath('ws-a', SessionId('session-a')), JSON.stringify({ version: 2, records: [] }) + '\n')
    const result = await runSyncCycle(world.deps)

    expect(result.pushed).toBe(0)
    expect(result.deleted).toBe(1)
    expect(world.fs.deleted).toEqual([
      sessionRepoPath('ws-a', SessionId('session-a')),
      recordsRepoPath('ws-a', SessionId('session-a')),
    ])
    expect(world.fs.files.has(sessionRepoPath('ws-a', SessionId('session-a')))).toBe(false)
    // The mark still travels; the local copy is untouched.
    expect(world.fs.files.get(archiveRepoPath('ws-a'))).toBe(serializeArchiveList([SessionId('session-a')]))
    expect(world.persistence.sessions.get('session-a')!.events).toHaveLength(6)
  })

  it('leaves non-archived artifacts of the same workspace alone', async () => {
    const world = deps()
    world.persistence.seed('session-a', '/work/demo', 1)
    world.persistence.seed('session-b', '/work/demo', 1)
    world.workspaces.archivedIds.push(SessionId('session-a'))
    world.fs.seed(repoWorkspace('ws-a', 'demo', {
      'session-a': artifactFor('session-a', 'ws-a', 1),
      'session-b': artifactFor('session-b', 'ws-a', 1),
      'session-c': artifactFor('session-c', 'ws-a', 1),
    }))
    const result = await runSyncCycle(world.deps)

    expect(result.deleted).toBe(1)
    expect(world.fs.files.has(sessionRepoPath('ws-a', SessionId('session-a')))).toBe(false)
    // session-b is held and not archived: its content is exported as usual.
    expect(world.fs.files.has(sessionRepoPath('ws-a', SessionId('session-b')))).toBe(true)
    // session-c is archived nowhere on this machine: the sweep must not touch it.
    expect(world.fs.files.has(sessionRepoPath('ws-a', SessionId('session-c')))).toBe(true)
  })

  it('is a no-op when the archived session has no repo artifact', async () => {
    const world = deps()
    world.persistence.seed('session-a', '/work/demo', 1)
    world.workspaces.archivedIds.push(SessionId('session-a'))
    world.fs.seed(repoWorkspace('ws-a', 'demo'))
    const result = await runSyncCycle(world.deps)

    expect(result.deleted).toBe(0)
    expect(result.errors).toEqual([])
    expect(world.fs.files.get(archiveRepoPath('ws-a'))).toBe(serializeArchiveList([SessionId('session-a')]))
  })

  it('retires the artifact and the records of a de-selected session this machine no longer holds', async () => {
    const world = deps()
    // The session's repo files exist, but this machine holds no local log for
    // it any more: the retirement is driven by the selection alone.
    world.fs.seed(repoWorkspace('ws-a', 'demo', { 'session-a': artifactFor('session-a', 'ws-a', 2) }))
    world.fs.files.set(recordsRepoPath('ws-a', SessionId('session-a')), JSON.stringify({ version: 2, records: [] }) + '\n')
    world.fs.files.set(selectionRepoPath(), selectionFile([entry('session-a')]))
    world.fs.syncState = anchor(['session-a'])
    world.fs.localSelection = []

    const result = await runSyncCycle(world.deps)

    expect(result.deletedUnselected).toBe(1)
    expect(result.errors).toEqual([])
    expect(world.fs.deleted).toEqual([
      sessionRepoPath('ws-a', SessionId('session-a')),
      recordsRepoPath('ws-a', SessionId('session-a')),
      manifestRepoPath('ws-a'),
    ])
    // Nothing but the manifest was left, and a manifest describing a workspace
    // with no artifacts must not keep the directory alive: `rmdir` refuses a
    // non-empty directory, so the sweep removes the manifest first and the
    // emptied workspace leaves the repo entirely. A later re-selection reuses
    // the key remembered in the sync anchor.
    expect(world.fs.files.has(manifestRepoPath('ws-a'))).toBe(false)
    expect(world.fs.deletedDirs).toEqual(['workspaces/ws-a'])
  })

  it('keeps a workspace directory that still carries archive marks', async () => {
    const world = deps()
    // The last selected session leaves, but the workspace still holds the
    // grow-only archive marks of sessions archived elsewhere — those must keep
    // travelling, so the directory stays.
    world.fs.seed(repoWorkspace('ws-a', 'demo', { 'session-a': artifactFor('session-a', 'ws-a', 2) }))
    world.fs.files.set(archiveRepoPath('ws-a'), serializeArchiveList([SessionId('session-archived')]))
    world.fs.files.set(selectionRepoPath(), selectionFile([entry('session-a')]))
    world.fs.syncState = anchor(['session-a'])
    world.fs.localSelection = []

    const result = await runSyncCycle(world.deps)

    expect(result.deletedUnselected).toBe(1)
    expect(world.fs.files.has(archiveRepoPath('ws-a'))).toBe(true)
    expect(world.fs.files.has(manifestRepoPath('ws-a'))).toBe(true)
    expect(world.fs.deletedDirs).toEqual([])
  })

  it('removes a workspace directory once the retirement leaves it without files', async () => {
    const world = deps()
    // A manifest-less directory (the fixture's stand-in for a repo written
    // elsewhere): the sweep reports it and still removes it when it empties.
    world.fs.files.set(sessionRepoPath('ws-a', SessionId('session-a')), artifactFor('session-a', 'ws-a', 2))
    world.fs.files.set(selectionRepoPath(), selectionFile([entry('session-a')]))
    world.fs.syncState = anchor(['session-a'])
    world.fs.localSelection = []

    const result = await runSyncCycle(world.deps)

    expect(result.deletedUnselected).toBe(1)
    expect(result.errors).toEqual(['workspaces/ws-a: no manifest.json; skipping this workspace'])
    expect(world.fs.files.has(sessionRepoPath('ws-a', SessionId('session-a')))).toBe(false)
    // The empty workspace leaves the repo through a directory removal: `unlink`
    // cannot remove one, and the EPERM it answers with would land on the cycle
    // as a spurious error.
    expect(world.fs.deletedDirs).toEqual(['workspaces/ws-a'])
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

  it('contains a thrown non-Error export failure', async () => {
    const world = deps()
    world.persistence.seed('session-a', '/work/demo', 2)
    world.fs.localSelection = ['session-a']
    world.persistence.throwStringOn = 'inspect'
    const result = await runSyncCycle(world.deps)
    expect(result.pushed).toBe(0)
    expect(result.errors.some(message => message.includes('inspect string failure'))).toBe(true)
  })
})
