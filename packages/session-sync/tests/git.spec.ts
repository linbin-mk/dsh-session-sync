import { afterEach, describe, expect, it } from 'vitest'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { GitError, GitRepository } from '../src/git.ts'

const execFileAsync = promisify(execFile)

/** Retry policy the deterministic tests use: exactly one attempt, no backoff. */
const NO_RETRY = { attempts: 1, baseDelayMs: 0 }

let roots: string[] = []

afterEach(async () => {
  // A repository a cycle just touched can still hold open handles while the
  // suite runs in parallel, and macOS then reports ENOTEMPTY for a recursive
  // rm. Retrying is the documented remedy; the removal stays unconditional.
  await Promise.all(roots.map(root => rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })))
  roots = []
})

async function newRoot(prefix: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), prefix))
  roots.push(root)
  return root
}

/**
 * A bare remote whose default branch is pinned to `main`.
 *
 * `git init --bare` otherwise inherits the ambient `init.defaultBranch`, which
 * is `main` on a machine that sets it and unset (`master`) on a fresh CI runner.
 * The plugin is always configured with branch `main`, so an inherited `master`
 * HEAD leaves the bare remote pointing at a ref that never materializes and a
 * later plain `git clone` checks nothing out.
 * @param dir - directory to initialize.
 * @returns the same directory, for chaining.
 */
async function initBare(dir: string): Promise<string> {
  await execFileAsync('git', ['init', '--bare', '-b', 'main', dir])
  return dir
}

describe('GitRepository', () => {
  it('reports absence before ensure and presence after', async () => {
    const root = await newRoot('dsh-sync-git-exists-')
    const repo = new GitRepository(join(root, 'work'), NO_RETRY)
    expect(await repo.exists()).toBe(false)
    await repo.ensure('file:///nonexistent-remote.git', 'main')
    expect(await repo.exists()).toBe(true)
  })

  it('runs a full first cycle against an empty bare remote, then syncs a second worktree', async () => {
    const root = await newRoot('dsh-sync-git-cycle-')
    const remote = await initBare(join(root, 'remote.git'))

    const first = new GitRepository(join(root, 'first'), NO_RETRY)
    await first.ensure(remote, 'main')
    await first.ensure(remote, 'main') // idempotent on an existing worktree
    await first.fetch('main') // empty remote: tolerated no-op
    expect(await first.remoteBranchExists('main')).toBe(false)
    await first.resetHard() // no fetch ran: no-op

    const artifact = join(root, 'first', 'projects', 'demo', 'session-a.jsonl')
    await mkdir(join(root, 'first', 'projects', 'demo'), { recursive: true })
    await writeFile(artifact, 'hello\n')
    await first.addAll()
    await first.commit('first export')
    await first.commit('nothing new') // nothing staged: no-op
    await first.push('main')

    expect(await first.remoteBranchExists('main')).toBe(true)

    const second = new GitRepository(join(root, 'second'), NO_RETRY)
    await second.ensure(remote, 'main')
    await second.fetch('main')
    await second.resetHard()
    const content = await readFile(join(root, 'second', 'projects', 'demo', 'session-a.jsonl'), 'utf8')
    expect(content).toBe('hello\n')
  })

  it('re-points origin when the configured remote changes', async () => {
    const root = await newRoot('dsh-sync-git-remote-switch-')
    const firstRemote = await initBare(join(root, 'first.git'))
    const secondRemote = await initBare(join(root, 'second.git'))
    const work = join(root, 'work')
    const repo = new GitRepository(work, NO_RETRY)

    await repo.ensure(firstRemote, 'main')
    await writeFile(join(work, 'a.txt'), 'a\n')
    await repo.addAll()
    await repo.commit('first export')
    await repo.push('main')
    const firstHead = (await execFileAsync('git', ['ls-remote', '--heads', firstRemote, 'main'])).stdout.trim()
    expect(firstHead).not.toBe('')

    await repo.ensure(secondRemote, 'main') // configured remote changed: origin follows
    await writeFile(join(work, 'b.txt'), 'b\n')
    await repo.addAll()
    await repo.commit('second export')
    await repo.push('main')

    // The switch redirects every later push away from the old remote.
    const firstAfter = (await execFileAsync('git', ['ls-remote', '--heads', firstRemote, 'main'])).stdout.trim()
    const secondAfter = (await execFileAsync('git', ['ls-remote', '--heads', secondRemote, 'main'])).stdout.trim()
    expect(firstAfter).toBe(firstHead)
    expect(secondAfter).not.toBe('')
    expect(secondAfter).not.toBe(firstHead)
  })

  it('re-adds a missing origin remote', async () => {
    const root = await newRoot('dsh-sync-git-missing-origin-')
    const remote = await initBare(join(root, 'remote.git'))
    const work = join(root, 'work')
    const repo = new GitRepository(work, NO_RETRY)
    await repo.ensure(remote, 'main')
    await execFileAsync('git', ['remote', 'remove', 'origin'], { cwd: work })
    await repo.ensure(remote, 'main')
    const { stdout } = await execFileAsync('git', ['remote', 'get-url', 'origin'], { cwd: work })
    expect(stdout.trim()).toBe(remote)
  })

  it('rejects a failed command as a GitError carrying the exit code', async () => {
    const root = await newRoot('dsh-sync-git-error-')
    const remote = await initBare(join(root, 'remote.git'))
    const repo = new GitRepository(join(root, 'work'), NO_RETRY)
    await repo.ensure(remote, 'main')
    await expect(repo.push('no-such-branch')).rejects.toBeInstanceOf(GitError)
    const failure = await repo.push('no-such-branch').then(
      () => { throw new Error('push unexpectedly resolved') },
      (error: unknown) => error,
    )
    expect(failure).toBeInstanceOf(GitError)
    expect((failure as GitError).message).toContain('git push -u failed')
  })

  it('resetHard is a no-op when no fetch ran before it', async () => {
    const root = await newRoot('dsh-sync-git-reset-guard-')
    const repo = new GitRepository(join(root, 'work'), NO_RETRY)
    await repo.ensure(join(root, 'remote.git'), 'main')
    // No fetch: resetHard must not touch a missing FETCH_HEAD.
    await repo.resetHard()
    expect(await repo.exists()).toBe(true)
  })

  it('retries a transient remote failure until the remote answers', async () => {
    const root = await newRoot('dsh-sync-git-retry-transient-')
    const remote = join(root, 'late-remote.git')
    const repo = new GitRepository(join(root, 'work'), { attempts: 3, baseDelayMs: 300 })
    await repo.ensure(remote, 'main')
    // The remote appears only after the first attempt has failed.
    setTimeout(() => { void initBare(remote) }, 30)
    await expect(repo.remoteBranchExists('main')).resolves.toBe(false)
  })

  it('gives up after the configured attempts with the last GitError', async () => {
    const root = await newRoot('dsh-sync-git-retry-exhaust-')
    const repo = new GitRepository(join(root, 'work'), { attempts: 3, baseDelayMs: 10 })
    await repo.ensure(join(root, 'never.git'), 'main')
    await expect(repo.remoteBranchExists('main')).rejects.toBeInstanceOf(GitError)
  })

  it('counts commits and reports zero for an unborn branch', async () => {
    const root = await newRoot('dsh-sync-git-count-')
    const remote = await initBare(join(root, 'remote.git'))
    const work = join(root, 'work')
    const repo = new GitRepository(work, NO_RETRY)
    await repo.ensure(remote, 'main')
    expect(await repo.commitCount()).toBe(0)

    await writeFile(join(work, 'a.txt'), 'a\n')
    await repo.addAll()
    await repo.commit('one')
    expect(await repo.commitCount()).toBe(1)
  })

  it('truncateHistory is a no-op within budget and rewrites the rest away', async () => {
    const root = await newRoot('dsh-sync-git-truncate-')
    const remote = await initBare(join(root, 'remote.git'))
    const work = join(root, 'work')
    const repo = new GitRepository(work, NO_RETRY)
    await repo.ensure(remote, 'main')
    for (const name of ['a', 'b', 'c', 'd']) {
      await writeFile(join(work, `${name}.txt`), `${name}\n`)
      await repo.addAll()
      await repo.commit(`add ${name}`)
    }
    expect(await repo.commitCount()).toBe(4)

    expect(await repo.truncateHistory(4)).toBe(0) // within budget: no-op
    expect(await repo.commitCount()).toBe(4)

    expect(await repo.truncateHistory(2)).toBe(2)
    expect(await repo.commitCount()).toBe(2)

    // The newest tree kept every file: the rewritten tip carries the same worktree.
    for (const name of ['a', 'b', 'c', 'd']) {
      expect(await readFile(join(work, `${name}.txt`), 'utf8')).toBe(`${name}\n`)
    }
    // The oldest kept commit became the new root with its own message; the dropped ones are gone.
    const { stdout } = await execFileAsync('git', ['log', '--format=%s', '--reverse'], { cwd: work })
    const messages = stdout.trim().split('\n')
    expect(messages).toEqual(['add c', 'add d'])
  })

  it('pushes a truncated history to the remote and a second worktree re-syncs from it', async () => {
    const root = await newRoot('dsh-sync-git-truncate-push-')
    const remote = await initBare(join(root, 'remote.git'))
    const work = join(root, 'work')
    const repo = new GitRepository(work, NO_RETRY)
    await repo.ensure(remote, 'main')
    for (const name of ['a', 'b', 'c']) {
      await writeFile(join(work, `${name}.txt`), `${name}\n`)
      await repo.addAll()
      await repo.commit(`add ${name}`)
    }
    await repo.push('main')

    expect(await repo.truncateHistory(1)).toBe(2)
    await repo.pushForce('main')

    const remoteCount = (await execFileAsync('git', ['--git-dir', remote, 'rev-list', '--count', 'main'])).stdout.trim()
    expect(remoteCount).toBe('1')
    // The single kept commit carries the complete newest tree.
    const clone = join(root, 'clone')
    await execFileAsync('git', ['clone', remote, clone])
    for (const name of ['a', 'b', 'c']) {
      expect(await readFile(join(clone, `${name}.txt`), 'utf8')).toBe(`${name}\n`)
    }

    // Another machine's worktree recovers from the rewritten remote on its next fetch+reset.
    const second = new GitRepository(join(root, 'second'), NO_RETRY)
    await second.ensure(remote, 'main')
    await second.fetch('main')
    await second.resetHard()
    expect(await second.commitCount()).toBe(1)
    expect(await readFile(join(root, 'second', 'c.txt'), 'utf8')).toBe('c\n')
  })
})
