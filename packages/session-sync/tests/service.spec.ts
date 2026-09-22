import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { Agent, PreStepDecision } from '@deepseek-ai/dsh-agent'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { readFileSync } from 'node:fs'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SettingsProvider } from '@deepseek-ai/dsh-settings'
import type { SettingsNamespace } from '@deepseek-ai/dsh-settings'
import { SESSION_FORMAT_VERSION, SessionId, SessionLogOffset } from '@deepseek-ai/dsh-session'
import type { SessionEvent, SessionHeader, UserMessage } from '@deepseek-ai/dsh-session'
import SessionSyncService from '../src/index.ts'
import type { SessionSyncCompleted } from '../src/index.ts'
import { parsePortableSession } from '../src/format.ts'

const execFileAsync = promisify(execFile)

let roots: string[] = []
let contexts: Context[] = []
let previousDshHome: string | undefined

function sessionHeader(id: string, cwd: string): SessionHeader {
  return {
    version: SESSION_FORMAT_VERSION,
    id: SessionId(id),
    createdAt: 1,
    cwd,
    isSeeded: false,
    delegationDepth: 0,
  }
}

function sessionArtifact(id = 'session-a', project = 'demo'): string {
  return [
    JSON.stringify({
      type: 'dsh-session-sync', version: 1, project, inheritedEventCount: 0,
      session: { version: SESSION_FORMAT_VERSION, id, createdAt: 1, isSeeded: false, delegationDepth: 0 },
    }),
    JSON.stringify({ type: 'turn/start', seq: 0, time: 1, data: { turn: 1 } }),
    JSON.stringify({ type: 'turn/end', seq: 1, time: 2, data: { turn: 1, reason: { kind: 'completed' } } }),
    '',
  ].join('\n')
}

/** A settings provider storing its document in memory (the seam's test double shape). */
class MemorySettingsProvider extends SettingsProvider {
  override readonly writable = true
  private ownDocument: Record<string, unknown>

  constructor(ctx: Context, document: Record<string, unknown> = {}) {
    super(ctx)
    this.ownDocument = document
  }

  protected override load(): Promise<Record<string, unknown>> {
    return Promise.resolve(this.ownDocument)
  }

  protected override persist(ns: SettingsNamespace, section: Record<string, unknown>): Promise<void> {
    this.ownDocument = { ...this.ownDocument, [String(ns)]: section }
    return Promise.resolve()
  }
}

/** A persistence double: no sessions stored, all read/write paths recorded. */
function fakePersistence(options: {
  headers?: SessionHeader[]
  rawFor?: Map<string, string>
  readFromThrows?: boolean
} = {}) {
  const created: SessionHeader[] = []
  const appended: { id: string; count: number }[] = []
  const sessions = new Map<string, { meta: SessionHeader; inheritedEventCount: ReturnType<typeof SessionLogOffset>; events: SessionEvent[] }>()
  for (const header of options.headers ?? []) {
    const raw = options.rawFor?.get(String(header.id))
    const parsed = raw === undefined ? undefined : parsePortableSession(raw, header.cwd ?? '/tmp')
    sessions.set(String(header.id), {
      meta: header,
      inheritedEventCount: parsed?.inheritedEventCount ?? SessionLogOffset(0),
      events: parsed?.events ?? [],
    })
  }
  function handleFor(id: { toString(): string }, access: 'read' | 'write') {
    const stored = sessions.get(String(id))
    if (stored === undefined) throw new Error('session not found')
    return {
      id: stored.meta.id,
      header: stored.meta,
      inheritedEventCount: stored.inheritedEventCount,
      access,
      async read(): Promise<{ eventState: 'shared-frozen'; events: readonly SessionEvent[] }> {
        if (options.readFromThrows === true) throw new Error('readFrom rejected')
        return { eventState: 'shared-frozen', events: [...stored.events] }
      },
      async append(events: readonly SessionEvent[]): Promise<void> {
        appended.push({ id: String(id), count: events.length })
        stored.events.push(...events)
      },
      async flush(): Promise<void> {},
      async close(): Promise<void> {},
    }
  }
  return {
    async stat(id: { toString(): string }): Promise<object | undefined> {
      const stored = sessions.get(String(id))
      return stored === undefined ? undefined : { header: stored.meta, revision: 'test' }
    },
    async open(id: { toString(): string }, access: 'read' | 'write') {
      return handleFor(id, access)
    },
    async create(meta: SessionHeader, createOptions?: { inheritedEventCount?: ReturnType<typeof SessionLogOffset> }) {
      created.push(meta)
      sessions.set(String(meta.id), {
        meta,
        inheritedEventCount: createOptions?.inheritedEventCount ?? SessionLogOffset(0),
        events: [],
      })
      return handleFor(meta.id, 'write')
    },
    async list(): Promise<{ header: SessionHeader; revision: string }[]> {
      return [...sessions.values()].map(stored => ({ header: stored.meta, revision: 'test' }))
    },
    created,
    appended,
  }
}

/** Poll until a predicate turns true or the timeout expires. */
async function waitFor(predicate: () => boolean, what: string, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) return
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  throw new Error(`timed out waiting for ${what}`)
}

async function compose(
  options: {
    document?: Record<string, unknown>
    delayMs?: number
    headers?: SessionHeader[]
    rawFor?: Map<string, string>
    readFromThrows?: boolean
    dshHome?: string
    projectionCache?: {
      coldSnapshot(meta: unknown, inheritedEventCount: unknown, events: unknown): unknown
    }
  } = {},
): Promise<{ ctx: Context; persistence: ReturnType<typeof fakePersistence>; service: SessionSyncService }> {
  const root = options.dshHome ?? await mkdtemp(join(tmpdir(), 'dsh-sync-service-'))
  if (options.dshHome === undefined) roots.push(root)
  process.env.DSH_HOME = root

  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(MemorySettingsProvider, options.document ?? {})
  const persistence = fakePersistence({
    ...options.headers === undefined ? {} : { headers: options.headers },
    ...options.rawFor === undefined ? {} : { rawFor: options.rawFor },
    ...options.readFromThrows === undefined ? {} : { readFromThrows: options.readFromThrows },
  })
  ctx.provide('sessionPersistence', persistence as never)
  if (options.projectionCache !== undefined) {
    ctx.provide('sessionProjectionCache', options.projectionCache as never)
  }
  await ctx.plugin(SessionSyncService, { startupSyncDelayMs: options.delayMs ?? 20 })
  return { ctx, persistence, service: ctx.sessionSync }
}

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

/**
 * Every bare fixture in this file is created with an explicit `-b main`.
 *
 * `git init --bare` otherwise inherits the ambient `init.defaultBranch`, which
 * is `main` on a machine that sets it and unset (`master`) on a fresh CI runner.
 * The plugin is always configured with branch `main`, so an inherited `master`
 * HEAD leaves the bare remote pointing at a ref that never materializes and a
 * later plain `git clone` checks nothing out — this suite passed locally and
 * failed on CI for exactly that reason.
 */
describe('SessionSyncService', () => {
  it('reports an unconfigured plugin and records the reason on manual sync', async () => {
    previousDshHome = process.env.DSH_HOME
    const { service } = await compose()

    expect(service.status()).toMatchObject({
      configured: false,
      repoReady: false,
      running: false,
      lastRun: { imported: 0, pushed: 0, archived: 0, deleted: 0, conflicts: [] },
    })

    // Let the startup timer fire once: an unconfigured plugin takes no action.
    await new Promise(resolve => setTimeout(resolve, 50))

    const after = await service.syncNow()
    expect(after.configured).toBe(false)
    expect(after.lastError).toContain('disabled or has no configured remote')
  })

  it('runs the startup pull when configured at boot, publishes the completion event, and reschedules on updates', async () => {
    previousDshHome = process.env.DSH_HOME
    const root = await mkdtemp(join(tmpdir(), 'dsh-sync-service-remote-'))
    roots.push(root)
    const bare = join(root, 'remote.git')
    await execFileAsync('git', ['init', '--bare', '-b', 'main', bare])
    const project = join(root, 'project')
    await mkdir(project, { recursive: true })

    const completed: SessionSyncCompleted[] = []
    const { ctx, service } = await compose({
      document: {
        'session-sync': {
          enabled: true,
          remote: bare,
          branch: 'main',
          intervalMinutes: 5,
          mappings: [{ key: 'demo', path: project }],
        },
      },
    })
    ctx.on('session-sync/completed', (payload) => { completed.push(payload) })

    await waitFor(() => completed.length > 0, 'startup cycle completion event')

    expect(service.status().configured).toBe(true)
    expect(service.status().repoReady).toBe(true)
    expect(service.status().lastRun).toEqual({ imported: 0, pushed: 0, archived: 0, deleted: 0, conflicts: [] })
    expect(completed).toHaveLength(1)
    expect(completed[0]).toMatchObject({ imported: 0, pushed: 0, archived: 0, deleted: 0, conflicts: [] })

    // The cycle log records the start and the successful outcome.
    const entries = await service.logs()
    expect(entries.some(entry => entry.kind === 'start')).toBe(true)
    expect(entries.some(entry => entry.kind === 'success' && entry.durationMs !== undefined)).toBe(true)

    // Two concurrent manual requests share one cycle: the second call sees
    // the first's in-flight promise, and the running flag flips synchronously.
    const first = service.syncNow()
    expect(service.status().running).toBe(true)
    const second = service.syncNow()
    await Promise.all([first, second])
    expect(service.status().running).toBe(false)
    expect(completed).toHaveLength(2)

    // A settings commit re-arms the timer through the watch path.
    await ctx.settings.update('session-sync', { intervalMinutes: 2 })
    expect(service.status().lastError).toBeUndefined()
  })

  it('ticks the interval timer into an automatic cycle', async () => {
    previousDshHome = process.env.DSH_HOME
    vi.useFakeTimers()
    try {
      const root = await mkdtemp(join(tmpdir(), 'dsh-sync-service-interval-'))
      roots.push(root)
      const bare = join(root, 'remote.git')
      await execFileAsync('git', ['init', '--bare', '-b', 'main', bare])
      const project = join(root, 'project')
      await mkdir(project, { recursive: true })

      const completed: SessionSyncCompleted[] = []
      const { ctx, service } = await compose({
        document: {
          'session-sync': {
            enabled: true,
            remote: bare,
            branch: 'main',
            intervalMinutes: 1,
            mappings: [{ key: 'demo', path: project }],
          },
        },
        delayMs: 20,
      })
      ctx.on('session-sync/completed', (payload) => { completed.push(payload) })

      const first = service.syncNow() // a cycle starts before the startup timer fires
      expect(service.status().running).toBe(true)
      await vi.advanceTimersByTimeAsync(20) // startup timer: configured but busy → no second cycle
      await first
      expect(completed).toHaveLength(1)

      await vi.advanceTimersByTimeAsync(60_000) // interval tick launches the next cycle
      expect(service.status().running).toBe(true)
      await service.syncNow() // join it
      expect(completed).toHaveLength(2)
    } finally {
      vi.useRealTimers()
    }
  })

  it('runs a cycle through the logical persistence API', async () => {
    previousDshHome = process.env.DSH_HOME
    const root = await mkdtemp(join(tmpdir(), 'dsh-sync-service-noraw-'))
    roots.push(root)
    const bare = join(root, 'remote.git')
    await execFileAsync('git', ['init', '--bare', '-b', 'main', bare])
    const project = join(root, 'project')
    await mkdir(project, { recursive: true })

    const { service } = await compose({
      document: {
        'session-sync': {
          enabled: true,
          remote: bare,
          branch: 'main',
          intervalMinutes: 5,
          mappings: [{ key: 'demo', path: project }],
        },
      },
      delayMs: 20,
      headers: [sessionHeader('session-a', project)],
    })
    await waitFor(() => service.status().lastSyncAt !== undefined, 'startup cycle without raw artifacts')
    expect(service.status().lastError).toBeUndefined()
  })

  it('completes a cycle with contained per-session failures', async () => {
    previousDshHome = process.env.DSH_HOME
    const root = await mkdtemp(join(tmpdir(), 'dsh-sync-service-contained-'))
    roots.push(root)
    const bare = join(root, 'remote.git')
    await execFileAsync('git', ['init', '--bare', '-b', 'main', bare])
    const project = join(root, 'project')
    await mkdir(project, { recursive: true })

    const artifact = sessionArtifact()
    const { service } = await compose({
      document: {
        'session-sync': {
          enabled: true,
          remote: bare,
          branch: 'main',
          intervalMinutes: 5,
          mappings: [{ key: 'demo', path: project }],
        },
      },
      delayMs: 20,
      dshHome: root,
      headers: [sessionHeader('session-a', project)],
      rawFor: new Map([['session-a', artifact]]),
      readFromThrows: true,
    })
    // A repo artifact exists, so both the import and export paths reach the
    // failing readFrom and record contained errors instead of failing.
    const repoArtifact = join(root, 'session-sync', 'repo', 'projects', 'demo', 'session-a.jsonl')
    await mkdir(join(root, 'session-sync', 'repo', 'projects', 'demo'), { recursive: true })
    await writeFile(repoArtifact, artifact.replace('"cwd":"demo"', '"cwd":"demo"'))

    await waitFor(() => service.status().lastSyncAt !== undefined, 'contained-failure cycle')
    expect(service.status().lastError).toBeUndefined()
    expect(service.status().lastRun.pushed).toBe(0)
  })

  it('records a repo filesystem failure on the status view', async () => {
    previousDshHome = process.env.DSH_HOME
    const root = await mkdtemp(join(tmpdir(), 'dsh-sync-service-fs-'))
    roots.push(root)
    const bare = join(root, 'remote.git')
    await execFileAsync('git', ['init', '--bare', '-b', 'main', bare])
    const project = join(root, 'project')
    await mkdir(project, { recursive: true })

    const { service } = await compose({
      document: {
        'session-sync': {
          enabled: true,
          remote: bare,
          branch: 'main',
          intervalMinutes: 5,
          mappings: [{ key: 'demo', path: project }],
        },
      },
      delayMs: 200,
      dshHome: root,
    })
    // A file squatting on the `projects` directory makes the listing fail with ENOTDIR.
    const repo = join(root, 'session-sync', 'repo')
    await mkdir(repo, { recursive: true })
    await writeFile(join(repo, 'projects'), 'not a directory')

    await waitFor(() => service.status().lastError !== undefined, 'filesystem failure')
    expect(service.status().lastError).toContain('ENOTDIR')
  })

  it('pre-warms the projection cache for imported sessions', async () => {
    previousDshHome = process.env.DSH_HOME
    const root = await mkdtemp(join(tmpdir(), 'dsh-sync-service-warm-'))
    roots.push(root)
    const bare = join(root, 'remote.git')
    await execFileAsync('git', ['init', '--bare', '-b', 'main', bare])
    const project = join(root, 'project')
    await mkdir(project, { recursive: true })

    const coldSnapshot = vi.fn((_meta: unknown, _inheritedEventCount: unknown, _events: unknown) => undefined)
    const { service } = await compose({
      document: {
        'session-sync': {
          enabled: true,
          remote: bare,
          branch: 'main',
          intervalMinutes: 5,
          mappings: [{ key: 'demo', path: project }],
        },
      },
      delayMs: 20,
      dshHome: root,
      projectionCache: { coldSnapshot },
    })

    const artifact = sessionArtifact()
    const repoArtifact = join(root, 'session-sync', 'repo', 'projects', 'demo', 'session-a.jsonl')
    await mkdir(join(root, 'session-sync', 'repo', 'projects', 'demo'), { recursive: true })
    await writeFile(repoArtifact, artifact)

    await waitFor(() => service.status().lastSyncAt !== undefined && !service.status().running, 'warm-up cycle')
    expect(service.status().lastError).toBeUndefined()
    // The import warms the cache from the complete logical stored log.
    expect(coldSnapshot).toHaveBeenCalledTimes(1)
    expect(coldSnapshot.mock.calls.every(call => String((call[0] as { id: unknown }).id) === 'session-a')).toBe(true)
    expect(coldSnapshot.mock.calls.every(call => (call[2] as unknown[]).length > 0)).toBe(true)
  })

  it('records a cycle failure on the status view and keeps serving status', async () => {
    previousDshHome = process.env.DSH_HOME
    const { service } = await compose({
      document: {
        'session-sync': {
          enabled: true,
          remote: '/nonexistent/remote.git',
          branch: 'main',
          intervalMinutes: 5,
          mappings: [],
        },
      },
    })

    await waitFor(() => service.status().lastError !== undefined, 'failed startup cycle')
    await waitFor(() => !service.status().running, 'cycle settlement')
    expect(service.status().lastError).toContain('git ls-remote --heads failed')
    expect(service.status().lastErrorAt).toBeDefined()
    expect(service.status().configured).toBe(true)
    expect(service.status().running).toBe(false)

    // The failed cycle is on the log with its error and a duration.
    const entries = await service.logs()
    expect(entries.some(entry => entry.kind === 'start')).toBe(true)
    expect(entries.some(entry => entry.kind === 'failure'
      && entry.error?.includes('git ls-remote --heads failed')
      && entry.durationMs !== undefined)).toBe(true)
  })

  it('arms a switch notice on import and injects it exactly once on the first user chat', async () => {
    previousDshHome = process.env.DSH_HOME
    const root = await mkdtemp(join(tmpdir(), 'dsh-sync-service-notice-'))
    roots.push(root)
    const bare = join(root, 'remote.git')
    await execFileAsync('git', ['init', '--bare', '-b', 'main', bare])
    const project = join(root, 'project')
    await mkdir(project, { recursive: true })

    const { ctx, service } = await compose({
      document: {
        'session-sync': {
          enabled: true,
          remote: bare,
          branch: 'main',
          intervalMinutes: 5,
          mappings: [{ key: 'demo', path: project }],
        },
      },
      delayMs: 20,
      dshHome: root,
    })

    const artifact = sessionArtifact()
    const repoArtifact = join(root, 'session-sync', 'repo', 'projects', 'demo', 'session-a.jsonl')
    await mkdir(join(root, 'session-sync', 'repo', 'projects', 'demo'), { recursive: true })
    await writeFile(repoArtifact, artifact)

    await waitFor(() => service.status().lastSyncAt !== undefined, 'import cycle')

    // The import armed a mark, persisted under the harness home.
    const marksFile = join(root, 'session-sync', 'switch-notices.json')
    await waitFor(() => {
      try { return readFileSync(marksFile, 'utf8').includes('session-a') } catch { return false }
    }, 'marks file write')
    const armed = JSON.parse(readFileSync(marksFile, 'utf8')) as { sessionIds: string[] }
    expect(armed.sessionIds).toEqual(['session-a'])

    const fakeAgent = (sessionId: string): Agent => (
      { session: { id: SessionId(sessionId) } } as unknown as Agent
    )
    const driver = (
      sessionId: string,
      claimed: UserMessage[],
    ): Promise<PreStepDecision> => ctx.waterfall(
      'agent/pre-step',
      { agent: fakeAgent(sessionId), messages: claimed, turn: 1, step: 1, signal: new AbortController().signal },
      async () => ({ kind: 'enter', messages: [...claimed] }),
    )

    const userTurn = () => [createUserMessage({
      content: [{ type: 'text', text: '继续' }],
      source: { kind: 'user' },
    })]

    // First user chat after the switch: the notice folds in after the claim.
    const first = await driver('session-a', userTurn())
    expect(first.kind).toBe('enter')
    if (first.kind !== 'enter') return
    expect(first.messages).toHaveLength(2)
    expect(first.messages[1].source).toMatchObject({ kind: 'plugin', plugin: 'session-sync', form: 'notice' })

    // Later chats on the same machine: no second notice.
    const second = await driver('session-a', userTurn())
    if (second.kind !== 'enter') throw new Error('expected enter decision')
    expect(second.messages).toHaveLength(1)

    // Other sessions without a mark: untouched.
    const other = await driver('session-b', userTurn())
    if (other.kind !== 'enter') throw new Error('expected enter decision')
    expect(other.messages).toHaveLength(1)

    // The consumed mark left the persisted file.
    const consumed = JSON.parse(readFileSync(marksFile, 'utf8')) as { sessionIds: string[] }
    expect(consumed.sessionIds).toEqual([])
  })

  it('keeps an armed switch notice for non-user activity and survives a service restart', async () => {
    previousDshHome = process.env.DSH_HOME
    const root = await mkdtemp(join(tmpdir(), 'dsh-sync-service-notice-restart-'))
    roots.push(root)
    const bare = join(root, 'remote.git')
    await execFileAsync('git', ['init', '--bare', '-b', 'main', bare])
    const project = join(root, 'project')
    await mkdir(project, { recursive: true })

    const first = await compose({
      document: {
        'session-sync': {
          enabled: true,
          remote: bare,
          branch: 'main',
          intervalMinutes: 5,
          mappings: [{ key: 'demo', path: project }],
        },
      },
      delayMs: 20,
      dshHome: root,
    })

    const artifact = sessionArtifact()
    const repoArtifact = join(root, 'session-sync', 'repo', 'projects', 'demo', 'session-a.jsonl')
    await mkdir(join(root, 'session-sync', 'repo', 'projects', 'demo'), { recursive: true })
    await writeFile(repoArtifact, artifact)

    const marksFile = join(root, 'session-sync', 'switch-notices.json')
    await waitFor(() => {
      try { return readFileSync(marksFile, 'utf8').includes('session-a') } catch { return false }
    }, 'first import marks')

    const wakeClaim = createUserMessage({
      content: [{ type: 'text', text: 'tool wake' }],
      source: { kind: 'plugin', plugin: 'other', form: 'notice', summary: 'wake' },
    })
    // A plugin-only wake neither injects nor consumes the mark.
    const wake = await first.ctx.waterfall(
      'agent/pre-step',
      {
        agent: { session: { id: SessionId('session-a') } } as unknown as Agent,
        messages: [wakeClaim],
        turn: 1,
        step: 1,
        signal: new AbortController().signal,
      },
      async () => ({ kind: 'enter', messages: [wakeClaim] }),
    )
    expect(wake.kind).toBe('enter')
    if (wake.kind !== 'enter') return
    expect(wake.messages).toHaveLength(1)

    // Restart the service over the same home (long startup delay: no cycle).
    await first.ctx.fiber.dispose()
    const second = await compose({
      document: {
        'session-sync': {
          enabled: true,
          remote: bare,
          branch: 'main',
          intervalMinutes: 5,
          mappings: [{ key: 'demo', path: project }],
        },
      },
      delayMs: 60_000,
      dshHome: root,
    })

    const userClaimed = createUserMessage({
      content: [{ type: 'text', text: '继续' }],
      source: { kind: 'user' },
    })
    const decision = await second.ctx.waterfall(
      'agent/pre-step',
      {
        agent: { session: { id: SessionId('session-a') } } as unknown as Agent,
        messages: [userClaimed],
        turn: 1,
        step: 1,
        signal: new AbortController().signal,
      },
      async () => ({ kind: 'enter', messages: [userClaimed] }),
    )
    expect(decision.kind).toBe('enter')
    if (decision.kind !== 'enter') return
    expect(decision.messages).toHaveLength(2)
    expect(decision.messages[1].source).toMatchObject({ kind: 'plugin', plugin: 'session-sync', form: 'notice' })
  })

  it('cleans git space on demand, truncating the remote history to the configured budget', async () => {
    previousDshHome = process.env.DSH_HOME
    const root = await mkdtemp(join(tmpdir(), 'dsh-sync-service-cleanup-'))
    roots.push(root)
    const bare = join(root, 'remote.git')
    await execFileAsync('git', ['init', '--bare', '-b', 'main', bare])

    const { service } = await compose({
      document: {
        'session-sync': {
          enabled: true,
          remote: bare,
          branch: 'main',
          intervalMinutes: 5,
          mappings: [],
          cleanup: { enabled: false, periodHours: 24, keepCommits: 1 },
        },
      },
      // No startup cycle: the worktree below is prepared by hand.
      delayMs: 60_000,
      dshHome: root,
    })

    // A worktree with four pushed commits, standing in for a grown history.
    const work = join(root, 'session-sync', 'repo')
    await mkdir(work, { recursive: true })
    await execFileAsync('git', ['init'], { cwd: work })
    await execFileAsync('git', ['config', 'user.name', 'test'], { cwd: work })
    await execFileAsync('git', ['config', 'user.email', 'test@localhost'], { cwd: work })
    await execFileAsync('git', ['remote', 'add', 'origin', bare], { cwd: work })
    await execFileAsync('git', ['checkout', '-b', 'main'], { cwd: work })
    for (const name of ['a', 'b', 'c', 'd']) {
      await writeFile(join(work, `${name}.txt`), `${name}\n`)
      await execFileAsync('git', ['add', '-A'], { cwd: work })
      await execFileAsync('git', ['commit', '-m', `add ${name}`], { cwd: work })
    }
    await execFileAsync('git', ['push', '-u', 'origin', 'main'], { cwd: work })
    const before = (await execFileAsync('git', ['--git-dir', bare, 'rev-list', '--count', 'main'])).stdout.trim()
    expect(before).toBe('4')

    const status = await service.cleanupNow()
    expect(status.lastCleanup).toMatchObject({ dropped: 3 })
    expect(status.cleanupError).toBeUndefined()

    const after = (await execFileAsync('git', ['--git-dir', bare, 'rev-list', '--count', 'main'])).stdout.trim()
    expect(after).toBe('1')
    // The newest tree kept every file; only the history shrank.
    const clone = join(root, 'clone')
    await execFileAsync('git', ['clone', bare, clone])
    for (const name of ['a', 'b', 'c', 'd']) {
      expect(readFileSync(join(clone, `${name}.txt`), 'utf8')).toBe(`${name}\n`)
    }

    // A second pass within budget drops nothing and still records the outcome.
    const again = await service.cleanupNow()
    expect(again.lastCleanup).toMatchObject({ dropped: 0 })
  })

  it('records an unconfigured manual cleanup on the status view', async () => {
    previousDshHome = process.env.DSH_HOME
    const { service } = await compose()

    const status = await service.cleanupNow()
    expect(status.cleanupError).toContain('disabled or has no configured remote')
  })

  it('runs the periodic cleanup after cycles once the configured period elapses', async () => {
    previousDshHome = process.env.DSH_HOME
    vi.useFakeTimers()
    try {
      const root = await mkdtemp(join(tmpdir(), 'dsh-sync-service-cleanup-period-'))
      roots.push(root)
      const bare = join(root, 'remote.git')
      await execFileAsync('git', ['init', '--bare', '-b', 'main', bare])

      const { service } = await compose({
        document: {
          'session-sync': {
            enabled: true,
            remote: bare,
            branch: 'main',
            intervalMinutes: 1,
            mappings: [],
            cleanup: { enabled: true, periodHours: 1, keepCommits: 200 },
          },
        },
        delayMs: 20,
        dshHome: root,
      })

      await vi.advanceTimersByTimeAsync(20) // startup cycle
      await service.syncNow() // join it; its cleanup check runs right after
      const first = service.status()
      expect(first.lastCleanup).toMatchObject({ dropped: 0 })
      const firstAt = first.lastCleanup!.at

      await vi.advanceTimersByTimeAsync(60_000) // next cycle: within the hour → no new pass
      await service.syncNow()
      expect(service.status().lastCleanup!.at).toBe(firstAt)

      await vi.advanceTimersByTimeAsync(3_660_000) // cycles pass the hour → a new pass runs
      await service.syncNow()
      expect(service.status().lastCleanup!.at).not.toBe(firstAt)
    } finally {
      vi.useRealTimers()
    }
  })
})
