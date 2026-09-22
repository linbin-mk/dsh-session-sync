/**
 * Git transport for session sync: a thin, testable wrapper over the `git`
 * binary. Every command runs with a bounded timeout and a
 * first-use-accepting SSH command so an unattended clone of a new host key
 * records it into `~/.ssh/known_hosts` instead of prompting on stdin. The
 * repository is a pure sync medium: each cycle fetches, hard-resets the
 * worktree to the remote state, rewrites it from this machine's DSH truth,
 * then commits and pushes — so no git merge conflict can ever arise.
 *
 * Remote-touching commands (`ls-remote`, `fetch`, `push`) run through a
 * bounded retry with exponential backoff, so a transient transport failure
 * (a corrupted SSH packet, a dropped connection) no longer blanks a whole
 * cycle. The branch-existence probe runs once per cycle — `fetch` records
 * whether it actually fetched, and `resetHard` trusts that flag instead of
 * probing the remote a second time.
 *
 * Git-space cleanup lives here too: {@link GitRepository.truncateHistory}
 * rewrites the branch to its newest commits (preserving their trees and
 * metadata), {@link GitRepository.gc} prunes the dropped objects, and
 * {@link GitRepository.pushForce} publishes the truncated history through a
 * lease-guarded force push.
 * @module @linbin-mk/dsh-session-sync/git
 */

import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdir, stat } from 'node:fs/promises'
import { join } from 'node:path'

const execFileAsync = promisify(execFile)

/** Longest a single git command may run before it is killed. */
const DEFAULT_TIMEOUT_MS = 60_000

/** Longest a cleanup command may run: history rewrites and gc scale with repo size. */
const CLEANUP_TIMEOUT_MS = 10 * 60_000

/** Temporary branch the history rewrite works on before re-pointing the real branch. */
const CLEANUP_TMP_BRANCH = '__dsh-session-sync-cleanup__'

/** Retry policy for remote-touching git commands. */
export interface GitRetryPolicy {
  /** Total attempts per command (1 disables retries). */
  attempts: number
  /** Backoff base: the delay before retry n is `baseDelayMs * 2^(n-1)` with ±25% jitter. */
  baseDelayMs: number
}

/** Default retry policy: up to two retries with exponential backoff. */
export const DEFAULT_GIT_RETRY: GitRetryPolicy = { attempts: 3, baseDelayMs: 500 }

/** Resolve after `ms` milliseconds. */
function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

/** SSH invocation used for remote commands: record unknown host keys, never prompt. */
const SSH_COMMAND = 'ssh -o StrictHostKeyChecking=accept-new -o BatchMode=yes'

/** Commit identity used for the plugin's own commits. */
const COMMIT_USER_NAME = 'dsh-session-sync'
const COMMIT_USER_EMAIL = 'dsh-session-sync@localhost'

/** A git command failed: exit code plus the captured stderr. */
export class GitError extends Error {
  /** Exit code of the failed command. */
  readonly code: number

  /** @param command - the git argv that failed (for the message). */
  constructor(
    command: string,
    code: number,
    stderr: string,
  ) {
    super(`git ${command} failed (exit ${code}): ${stderr.trim()}`)
    this.code = code
  }
}

/** Run one git command with the shared environment and timeout. */
async function runGit(
  dir: string,
  args: readonly string[],
  timeoutMs = DEFAULT_TIMEOUT_MS,
): Promise<{ stdout: string; stderr: string }> {
  try {
    return await execFileAsync('git', args, {
      cwd: dir,
      timeout: timeoutMs,
      env: {
        ...process.env,
        GIT_SSH_COMMAND: SSH_COMMAND,
      },
      maxBuffer: 16 * 1024 * 1024,
    })
  } catch (error) {
    const failure = error as { code?: unknown; stderr?: unknown }
    /* v8 ignore start -- execFile rejections always carry an exit code and stderr; the fallbacks guard non-child-process throws */
    const code = Number(failure.code ?? -1)
    const stderr = typeof failure.stderr === 'string' ? failure.stderr : ''
    /* v8 ignore stop */
    throw new GitError(args.slice(0, 2).join(' '), code, stderr)
  }
}

/** A local git worktree under one directory. */
export class GitRepository {
  /**
   * Whether the most recent {@link fetch} actually fetched (a remote branch
   * existed). `resetHard` resets only when this is true — the engine calls
   * fetch immediately before it, so no second remote probe is needed.
   */
  private fetched = false

  /**
   * @param dir - worktree directory (created by {@link ensure} when absent).
   * @param retry - retry policy for remote-touching commands.
   */
  constructor(
    private readonly dir: string,
    private readonly retry: GitRetryPolicy = DEFAULT_GIT_RETRY,
  ) {}

  /**
   * Run one remote-touching command with the retry policy: a failed attempt
   * retries after an exponential, jittered backoff until the attempt budget
   * runs out. Non-git failures (missing binary, spawn faults) are never
   * retried.
   * @param args - git argv.
   * @returns the command output.
   */
  private async runRemote(args: readonly string[]): Promise<{ stdout: string; stderr: string }> {
    const attempts = Math.max(1, Math.floor(this.retry.attempts))
    for (let attempt = 1; ; attempt += 1) {
      try {
        return await runGit(this.dir, args)
      } catch (error) {
        /* v8 ignore next -- only foreign throws (spawn faults) skip the retry path */
        if (!(error instanceof GitError) || attempt >= attempts) throw error
        await sleep(this.backoffMs(attempt))
      }
    }
  }

  /** Jittered exponential backoff before retry `attempt` (1-based). */
  private backoffMs(attempt: number): number {
    const base = this.retry.baseDelayMs * 2 ** (attempt - 1)
    const jitter = 0.75 + Math.random() * 0.5
    return Math.max(0, Math.round(base * jitter))
  }

  /** Whether a `.git` directory exists at the worktree root. */
  async exists(): Promise<boolean> {
    try {
      return (await stat(join(this.dir, '.git'))).isDirectory()
    } catch {
      return false
    }
  }

  /**
   * Prepare the worktree. An absent worktree is initialized: the configured
   * URL becomes the `origin` remote, the configured branch is created
   * locally (a freshly fetched empty remote has no branch at all), and the
   * commit identity is set for the plugin's own commits. A present worktree
   * is reused and its `origin` is re-pointed to the configured URL, so a
   * `remote` edit in settings takes effect on the next cycle instead of
   * silently pushing to the old remote.
   * @param url - git remote URL.
   * @param branch - configured remote branch.
   */
  async ensure(url: string, branch: string): Promise<void> {
    if (await this.exists()) {
      await this.reconcileRemote(url)
      return
    }
    await mkdir(this.dir, { recursive: true })
    await runGit(this.dir, ['init'], 10_000)
    await runGit(this.dir, ['remote', 'add', 'origin', url], 10_000)
    await runGit(this.dir, ['config', 'user.name', COMMIT_USER_NAME], 10_000)
    await runGit(this.dir, ['config', 'user.email', COMMIT_USER_EMAIL], 10_000)
    // `git fetch` below materializes the remote state; the local branch
    // exists so a later `push -u` has a source name on an empty remote.
    await runGit(this.dir, ['checkout', '-b', branch], 10_000)
  }

  /** Point `origin` at the configured URL, creating the remote when absent. */
  private async reconcileRemote(url: string): Promise<void> {
    let current: string
    try {
      const { stdout } = await runGit(this.dir, ['remote', 'get-url', 'origin'], 10_000)
      current = stdout.trim()
    } catch (error) {
      // `remote get-url` exits 2 when the worktree lost its origin remote; re-add it.
      /* v8 ignore next -- the rethrow guards foreign exec failures (IO faults, missing git) that no test fabricates */
      if (!(error instanceof GitError) || error.code !== 2) throw error
      await runGit(this.dir, ['remote', 'add', 'origin', url], 10_000)
      return
    }
    if (current !== url) await runGit(this.dir, ['remote', 'set-url', 'origin', url], 10_000)
  }

  /**
   * Fetch the configured branch. An empty remote (no such ref) is a no-op,
   * not an error — the first push will create the branch. The ref existence
   * probe keeps this decision independent of git's localized stderr. The
   * fetch records its own outcome so {@link resetHard} resets exactly when a
   * fetch actually ran.
   * @param branch - remote branch to fetch.
   */
  async fetch(branch: string): Promise<void> {
    this.fetched = false
    if (!(await this.remoteBranchExists(branch))) return
    await this.runRemote(['fetch', 'origin', branch])
    this.fetched = true
  }

  /** Whether the remote already carries the configured branch. */
  async remoteBranchExists(branch: string): Promise<boolean> {
    const { stdout } = await this.runRemote(['ls-remote', '--heads', 'origin', branch])
    return stdout.trim().length > 0
  }

  /**
   * Reset the worktree to the state the preceding {@link fetch} materialized
   * as `FETCH_HEAD`. A no-op when that fetch skipped (empty remote) or never
   * ran — the engine always calls fetch immediately before, so the fetch
   * outcome flag is authoritative and no second remote probe is needed.
   */
  async resetHard(): Promise<void> {
    if (!this.fetched) return
    await runGit(this.dir, ['reset', '--hard', 'FETCH_HEAD'])
  }

  /** Stage every worktree change. */
  async addAll(): Promise<void> {
    await runGit(this.dir, ['add', '-A'])
  }

  /**
   * Commit staged changes. A worktree with nothing staged is a no-op,
   * decided from `status --porcelain` so git's localized commit output never
   * needs parsing.
   * @param message - commit message.
   */
  async commit(message: string): Promise<void> {
    const { stdout } = await runGit(this.dir, ['status', '--porcelain'])
    if (stdout.trim().length === 0) return
    await runGit(this.dir, ['commit', '-m', message])
  }

  /**
   * Push the configured branch. The first push sets upstream so later pushes
   * run without `-u`; a non-fast-forward rejection surfaces as a GitError and
   * the next cycle refetches and retries.
   * @param branch - branch to push.
   */
  async push(branch: string): Promise<void> {
    await this.runRemote(['push', '-u', 'origin', branch])
  }

  /**
   * Force-push the configured branch after a history rewrite. The lease
   * (`--force-with-lease`) still guards the push: when another machine pushed
   * between this worktree's last fetch and the rewrite, the push fails
   * instead of clobbering that machine's newer commits, and the next cleanup
   * retries from the refetched state.
   * @param branch - branch to push.
   */
  async pushForce(branch: string): Promise<void> {
    await this.runRemote(['push', '--force-with-lease', 'origin', branch])
  }

  /** How many commits the current branch holds (0 for an unborn branch). */
  async commitCount(): Promise<number> {
    let stdout: string
    try {
      ;({ stdout } = await runGit(this.dir, ['rev-list', '--count', 'HEAD'], 10_000))
    } catch (error) {
      // An unborn branch (a fresh worktree before its first commit) has no HEAD.
      if (error instanceof GitError) return 0
      throw error
    }
    const parsed = Number(stdout.trim())
    return Number.isFinite(parsed) ? parsed : 0
  }

  /**
   * Rewrite the current branch to keep only the newest `keep` commits,
   * dropping every older commit from history (and therefore their blobs from
   * the object store). The newest commit's tree — the full current worktree
   * state — is preserved exactly: the kept commits replay their own diffs
   * onto the identical base trees, so the rewritten tip carries the same
   * files as before the rewrite. The dropped history is pruned from the local
   * object store immediately; the remote follows once {@link pushForce} runs.
   * @param keep - number of newest commits to keep (minimum 1).
   * @returns the number of commits dropped (0 when history is already within budget).
   */
  async truncateHistory(keep: number): Promise<number> {
    const count = await this.commitCount()
    if (count <= keep) return 0
    const { stdout: keptList } = await runGit(this.dir, ['rev-list', `--max-count=${keep}`, 'HEAD'], CLEANUP_TIMEOUT_MS)
    const kept = keptList.trim().split('\n').filter(line => line.length > 0)
    const oldestKept = kept[kept.length - 1]
    /* v8 ignore next -- count > keep guarantees at least one kept commit */
    if (oldestKept === undefined) return 0
    const { stdout: headOut } = await runGit(this.dir, ['rev-parse', 'HEAD'], 10_000)
    const head = headOut.trim()
    const { stdout: branchOut } = await runGit(this.dir, ['symbolic-ref', '--short', 'HEAD'], 10_000)
    const branch = branchOut.trim()
    const { stdout: messageOut } = await runGit(this.dir, ['log', '-1', '--format=%s', oldestKept], 10_000)
    // The oldest kept commit becomes the new root with its tree and message;
    // the remaining kept commits replay onto it via cherry-pick, so all
    // metadata (authors, dates) stays intact.
    await runGit(this.dir, ['checkout', '--orphan', CLEANUP_TMP_BRANCH, oldestKept], CLEANUP_TIMEOUT_MS)
    await runGit(this.dir, ['commit', '-m', messageOut.trim() || 'dsh session sync'], CLEANUP_TIMEOUT_MS)
    if (head !== oldestKept) {
      await runGit(this.dir, ['cherry-pick', '--allow-empty', `${oldestKept}..${head}`], CLEANUP_TIMEOUT_MS)
    }
    await runGit(this.dir, ['branch', '-f', branch, 'HEAD'], 10_000)
    await runGit(this.dir, ['checkout', branch], CLEANUP_TIMEOUT_MS)
    await runGit(this.dir, ['branch', '-D', CLEANUP_TMP_BRANCH], 10_000)
    await this.gc()
    return count - keep
  }

  /**
   * Expire every reflog entry and prune all unreachable objects, so a
   * rewritten history actually shrinks the local object store instead of
   * only the branch pointer.
   */
  async gc(): Promise<void> {
    await runGit(this.dir, ['reflog', 'expire', '--expire=now', '--expire-unreachable=now', '--all'], CLEANUP_TIMEOUT_MS)
    await runGit(this.dir, ['gc', '--prune=now'], CLEANUP_TIMEOUT_MS)
  }
}
