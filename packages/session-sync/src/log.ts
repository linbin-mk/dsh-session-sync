/**
 * Cycle log for session sync: append-only JSONL records under one file per
 * local calendar day (`sync-YYYY-MM-DD.jsonl`), pruned to a rolling retention
 * window (3 days by default) whenever the log is appended or read. Records
 * describe one sync cycle's lifecycle — start, success (with counters and
 * contained failures), or failure (with the cycle-level error) — so the
 * settings page can show the recent history behind the status line.
 * @module @linbin-mk/dsh-session-sync/log
 */

import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

/** Lifecycle stage of the cycle a record belongs to. */
export type SyncLogKind = 'start' | 'success' | 'failure'

/** One sync-log record (one line of one day file). */
export interface SyncLogEntry {
  /** ISO-8601 instant the record was written. */
  time: string
  /** Cycle stage. */
  kind: SyncLogKind
  /** Cycle duration in milliseconds (success and failure records). */
  durationMs?: number
  /** Sessions imported by the completed cycle (success). */
  imported?: number
  /** Sessions whose repo artifact the completed cycle updated (success). */
  pushed?: number
  /** Sessions the completed cycle marked archived (success). */
  archived?: number
  /** Archived repo artifacts the completed cycle deleted (success). */
  deleted?: number
  /** Commits the git-space cleanup dropped right after the cycle (success). */
  cleanupDropped?: number
  /** Conflict-copy paths the completed cycle wrote (success). */
  conflicts?: string[]
  /** Contained per-session failure messages (success). */
  errors?: string[]
  /** Cycle-level failure message (failure). */
  error?: string
}

/** Rolling retention window for sync log files, in calendar days. */
export const SYNC_LOG_RETENTION_DAYS = 3

/** Log file name shape: `sync-YYYY-MM-DD.jsonl` (local calendar date). */
const LOG_FILE_PATTERN = /^sync-(\d{4})-(\d{2})-(\d{2})\.jsonl$/

/** Zero-padded two-digit field. */
function pad2(value: number): string {
  return String(value).padStart(2, '0')
}

/** Local calendar date of an instant as `YYYY-MM-DD`. */
function localDay(instant: Date): string {
  return `${instant.getFullYear()}-${pad2(instant.getMonth() + 1)}-${pad2(instant.getDate())}`
}

/** Local midnight `daysAgo` days before the given instant, in epoch ms. */
function startOfDayDaysAgo(instant: Date, daysAgo: number): number {
  return new Date(instant.getFullYear(), instant.getMonth(), instant.getDate() - daysAgo).getTime()
}

/** Whether a parsed JSON value is a well-shaped log record. */
function isSyncLogEntry(value: unknown): value is SyncLogEntry {
  if (typeof value !== 'object' || value === null) return false
  const entry = value as Partial<SyncLogEntry>
  return typeof entry.time === 'string'
    && (entry.kind === 'start' || entry.kind === 'success' || entry.kind === 'failure')
}

/**
 * Append-only cycle log under one directory, with a rolling retention window.
 * Day files make the window cheap to enforce: pruning only has to compare
 * file names against the cutoff day.
 */
export class SyncLog {
  /**
   * @param dir - log directory (created on first append).
   * @param retentionDays - calendar days kept (today plus the previous days).
   * @param now - clock override for tests.
   */
  constructor(
    private readonly dir: string,
    private readonly retentionDays: number = SYNC_LOG_RETENTION_DAYS,
    private readonly now: () => Date = () => new Date(),
  ) {}

  /** Append one record to today's file, then enforce the retention window. */
  async append(entry: SyncLogEntry): Promise<void> {
    await mkdir(this.dir, { recursive: true })
    await writeFile(this.dayFilePath(this.now()), JSON.stringify(entry) + '\n', { encoding: 'utf8', flag: 'a' })
    await this.pruneQuiet()
  }

  /**
   * Delete log files outside the retention window. A missing directory is
   * the healthy empty state; unrecognized files are left alone.
   */
  async prune(): Promise<void> {
    const cutoff = startOfDayDaysAgo(this.now(), this.retentionDays - 1)
    let names: string[]
    try {
      names = await readdir(this.dir)
    } catch (error) {
      /* v8 ignore next 2 -- non-ENOENT read faults surface to the caller */
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
      throw error
    }
    await Promise.all(names.map(async (name) => {
      const match = LOG_FILE_PATTERN.exec(name)
      if (match === null) return
      const year = Number(match[1])
      const month = Number(match[2])
      const day = Number(match[3])
      if (new Date(year, month - 1, day).getTime() < cutoff) {
        await rm(join(this.dir, name), { force: true })
      }
    }))
  }

  /**
   * Read recent records, newest first, bounded by `limit`. Malformed lines
   * are skipped, never fatal; the read prunes the window first so expired
   * days never contribute records.
   * @param limit - maximum record count.
   * @returns the newest records within the window.
   */
  async read(limit = 200): Promise<SyncLogEntry[]> {
    await this.pruneQuiet()
    let names: string[]
    try {
      names = await readdir(this.dir)
    } catch (error) {
      /* v8 ignore next 2 -- non-ENOENT read faults surface to the caller */
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
      throw error
    }
    const files = names
      .filter(name => LOG_FILE_PATTERN.test(name))
      .sort((left, right) => right.localeCompare(left))
    const entries: SyncLogEntry[] = []
    for (const file of files) {
      if (entries.length >= limit) break
      const text = await readFile(join(this.dir, file), 'utf8')
      for (const line of text.split('\n').reverse()) {
        if (line.trim().length === 0) continue
        if (entries.length >= limit) break
        try {
          const parsed = JSON.parse(line) as unknown
          if (isSyncLogEntry(parsed)) entries.push(parsed)
        } catch {
          // A malformed record is skipped; the rest of the file still reads.
        }
      }
    }
    return entries
  }

  /** Prune without failing: retention is best-effort next to the access it guards. */
  private async pruneQuiet(): Promise<void> {
    try {
      await this.prune()
    } catch {
      // Best-effort: the window is enforced on the next successful prune.
    }
  }

  /** Today's log file absolute path. */
  private dayFilePath(instant: Date): string {
    return join(this.dir, `sync-${localDay(instant)}.jsonl`)
  }
}
