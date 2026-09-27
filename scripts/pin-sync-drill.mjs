/**
 * Two-machine drill over the built host artifact (`packages/session-sync/lib`)
 * with real git repositories: pins flow to the repo selection, artifacts
 * follow the selection, and unpinning retires them without touching either
 * machine's local session copy.
 *
 * Run it after `pnpm build`:
 *
 * ```sh
 * node scripts/pin-sync-drill.mjs
 * ```
 *
 * It prints one PASS/FAIL line per check and exits non-zero on any failure.
 * The workspace suite (`pnpm -r test`) covers the same rules at unit and
 * composition level; this drill is the whole-cycle view over the shipped
 * JavaScript, and it is what caught a publish rule that re-added a locally
 * unpinned session.
 * Machine A pins a session -> repo gains pinned.json + the artifact.
 * Machine B (different project path) adopts the pin and imports it.
 * A unpins -> the artifact leaves the repo; B drops its pin, keeps its copy.
 */
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdir, mkdtemp, readdir, readFile, rm, unlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

/** Built package directory, resolved from this script so it runs from anywhere. */
const here = dirname(fileURLToPath(import.meta.url))
const built = resolve(here, '..', 'packages', 'session-sync', 'lib')
const { runSyncCycle } = await import(`file://${built}/engine.js`)

const execFileAsync = promisify(execFile)
const git = (...args) => execFileAsync('git', args, { env: { ...process.env, GIT_AUTHOR_NAME: 'drill', GIT_AUTHOR_EMAIL: 'd@e', GIT_COMMITTER_NAME: 'drill', GIT_COMMITTER_EMAIL: 'd@e' } })

class Machine {
  constructor(name, root, project, pinned = []) {
    this.name = name
    this.root = root
    this.project = project
    this.pinned = [...pinned]
    this.archived = []
    this.sessions = new Map()
    this.baseline = undefined
    this.work = join(root, 'repo')
  }
  fs() {
    const root = this.work
    const self = this
    return {
      hostname: this.name,
      async readRepoFile(rel) { try { return await readFile(join(root, ...rel.split('/')), 'utf8') } catch (e) { if (e.code === 'ENOENT') return undefined; throw e } },
      async writeRepoFile(rel, content) { const abs = join(root, ...rel.split('/')); await mkdir(join(abs, '..'), { recursive: true }); await writeFile(abs, content) },
      async deleteRepoFile(rel) { try { await unlink(join(root, ...rel.split('/'))); return true } catch (e) { if (e.code === 'ENOENT') return false; throw e } },
      async listDirs(rel) { try { const es = await readdir(join(root, ...rel.split('/')), { withFileTypes: true }); return es.filter(e => e.isDirectory()).map(e => e.name) } catch (e) { if (e.code === 'ENOENT') return []; throw e } },
      async listFiles(rel) { try { const es = await readdir(join(root, ...rel.split('/')), { withFileTypes: true }); return es.filter(e => e.isFile()).map(e => e.name) } catch (e) { if (e.code === 'ENOENT') return []; throw e } },
      async readPinBaseline() { return self.baseline ? { firstSeen: true, sessionIds: [...self.baseline.sessionIds], ownedIds: [...self.baseline.ownedIds] } : undefined },
      async writePinBaseline(snapshot) { self.baseline = { firstSeen: true, sessionIds: [...snapshot.sessionIds], ownedIds: [...snapshot.ownedIds] } },
    }
  }
  persistence() {
    const self = this
    return {
      async inspect(id) { return self.sessions.get(String(id)) },
      async create(session) { self.sessions.set(String(session.meta.id), { ...session, events: [...session.events] }) },
      async append(id, batch) { const s = self.sessions.get(String(id)); s.events.push(...batch) },
      async list() { return [...self.sessions.values()].map(s => s.meta) },
    }
  }
  workspaces() {
    const self = this
    return {
      async resolveByPath() { return undefined },
      async create() { return { attachSession: async () => {} } },
      archivedSessionIds: () => self.archived,
      async archiveSession(id) { self.archived.push(String(id)) },
      pinnedSessionIds: () => [...self.pinned],
      async pinSession(id) { const raw = String(id); if (!self.pinned.includes(raw)) self.pinned.unshift(raw) },
      async unpinSession(id) { const raw = String(id); self.pinned = self.pinned.filter(x => x !== raw) },
    }
  }
  async gitPort(remote) {
    const dir = this.work
    const run = (args) => git('-C', dir, ...args)
    return {
      ensure: async () => {
        const first = await (async () => { try { await execFileAsync('git', ['-C', dir, 'rev-parse', '--git-dir']); return false } catch { return true } })()
        if (!first) return
        await mkdir(dir, { recursive: true })
        await git('init', dir)
        await run(['remote', 'add', 'origin', remote])
        await run(['checkout', '-b', 'main'])
      },
      fetch: async () => {
        // The real port probes the branch first and treats an empty remote as a no-op.
        const { stdout } = await git('-C', dir, 'ls-remote', '--heads', 'origin', 'main')
        if (stdout.trim().length === 0) return
        await run(['fetch', 'origin', 'main'])
      },
      resetHard: async () => {
        try { await run(['reset', '--hard', 'FETCH_HEAD']) } catch { /* nothing fetched yet */ }
      },
      addAll: async () => { await run(['add', '-A']) },
      commit: async (message) => { await run(['commit', '--allow-empty', '-m', message]) },
      push: async () => { await run(['push', '-u', 'origin', 'main']) },
    }
  }
  async cycle(remote) {
    return runSyncCycle({
      settings: { enabled: true, remote, branch: 'main', intervalMinutes: 5, mappings: [{ key: 'demo', path: this.project }], cleanup: { enabled: false, periodHours: 24, keepCommits: 200 } },
      persistence: this.persistence(),
      workspaces: this.workspaces(),
      fs: await this.fs(),
      git: await this.gitPort(remote),
      logger: { warn: (m) => console.log(`  [${this.name}] warn: ${m}`) },
    })
  }
  async inspectRepoArtifacts() {
    try { return (await readdir(join(this.work, 'projects', 'demo'))).sort() } catch { return [] }
  }
}

const report = []
const check = (label, actual, expected) => {
  const ok = JSON.stringify(actual) === JSON.stringify(expected)
  report.push(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `\n      expected ${JSON.stringify(expected)}\n      actual   ${JSON.stringify(actual)}`}`)
}

const base = await mkdtemp(join(tmpdir(), 'dsh-sync-drill-'))
const remote = join(base, 'remote.git')
const projA = join(base, 'workA')
const projB = join(base, 'workB')
await mkdir(projA, { recursive: true })
await mkdir(projB, { recursive: true })
await git('init', '--bare', '-b', 'main', remote)

const A = new Machine('machine-a', join(base, 'homeA'), projA, ['session-one'])
const B = new Machine('machine-b', join(base, 'homeB'), projB, [])
const header = (id, cwd) => ({ version: 4, id, createdAt: 1, cwd, isSeeded: false, delegationDepth: 0 })
const events = [
  { type: 'turn/start', seq: 0, time: 1, data: { turn: 1 } },
  { type: 'turn/end', seq: 1, time: 2, data: { turn: 1, reason: { kind: 'completed' } } },
]
A.sessions.set('session-one', { meta: header('session-one', projA), inheritedEventCount: 0, events: [...events] })

let r = await A.cycle(remote)
check('A: first cycle publishes the pin list', r.publishedPins, ['session-one'])
check('A: artifact pushed', r.pushed, 1)
check('A: repo holds the artifact', await A.inspectRepoArtifacts(), ['session-one.jsonl'])
const pinnedText = await readFile(join(A.work, 'pinned.json'), 'utf8')
check('A: repo pin list selects the session', JSON.parse(pinnedText).sessionIds, ['session-one'])
check('A: baseline written', A.baseline.sessionIds, ['session-one'])

r = await A.cycle(remote)
check('A: second cycle publishes nothing again', r.publishedPins, undefined)

r = await B.cycle(remote)
check('B: imports the pinned session', r.imported, 1)
check('B: mirrors the pin locally', B.pinned, ['session-one'])
check('B: no push of its own', r.pushed, 0)

// A unpins: the artifact retires, the pin leaves the list.
A.pinned = []
r = await A.cycle(remote)
check('A: unpin retires the artifact', r.deletedUnpinned, 1)
check('A: repo artifact gone', await A.inspectRepoArtifacts(), [])
check('A: pin list is now empty', JSON.parse(await readFile(join(A.work, 'pinned.json'), 'utf8')).sessionIds, [])

r = await B.cycle(remote)
check('B: drops the pin it no longer sees', r.unpinned, ['session-one'])
check('B: keeps its local copy', B.sessions.has('session-one'), true)

// B pins it back: the selection returns and the artifact is republished.
B.pinned = []
await B.workspaces().pinSession('session-one')
r = await B.cycle(remote)
// B's copy already equals the artifact (it was imported from it), so there is
// nothing to push; the selection is what comes back.
check('B: republishes the selection', r.publishedPins, ['session-one'])
check('B: repo selection carries it again', JSON.parse(await readFile(join(B.work, 'pinned.json'), 'utf8')).sessionIds, ['session-one'])

r = await A.cycle(remote)
check('A: re-imports nothing (its local copy is the newest)', r.imported, 0)
check('A: artifact is back in the repo', await A.inspectRepoArtifacts(), ['session-one.jsonl'])

console.log(report.join('\n'))
console.log(`\n${report.filter(l => l.startsWith('PASS')).length}/${report.length} checks passed`)
await rm(base, { recursive: true, force: true })
process.exit(report.some(l => l.startsWith('FAIL')) ? 1 : 0)
