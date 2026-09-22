import { afterEach, describe, expect, it } from 'vitest'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SyncLog } from '../src/log.ts'
import type { SyncLogEntry } from '../src/log.ts'

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

/** A fixed local instant: 2026-08-29 10:00 local time. */
const FIXED_NOW = () => new Date(2026, 7, 29, 10, 0, 0)

function entry(time: string, kind: SyncLogEntry['kind'], extra: Partial<SyncLogEntry> = {}): SyncLogEntry {
  return { time, kind, ...extra }
}

describe('SyncLog', () => {
  it('appends records to one per-day file and reads them newest first', async () => {
    const root = await newRoot('dsh-sync-log-append-')
    const log = new SyncLog(root, 3, FIXED_NOW)

    await log.append(entry('2026-08-29T08:00:00.000Z', 'start'))
    await log.append(entry('2026-08-29T08:00:02.000Z', 'success', { imported: 1, pushed: 2 }))

    const entries = await log.read()
    expect(entries.map(record => record.kind)).toEqual(['success', 'start'])
    expect(entries[0]).toMatchObject({ imported: 1, pushed: 2 })

    const dayFile = join(root, 'sync-2026-08-29.jsonl')
    const text = await readFile(dayFile, 'utf8')
    expect(text.trim().split('\n')).toHaveLength(2)
  })

  it('bounds the read with a limit', async () => {
    const root = await newRoot('dsh-sync-log-limit-')
    const log = new SyncLog(root, 3, FIXED_NOW)

    for (let at = 0; at < 5; at += 1) {
      await log.append(entry(`2026-08-29T0${at}:00:00.000Z`, 'start'))
    }

    const entries = await log.read(2)
    expect(entries).toHaveLength(2)
    expect(entries[0]?.time).toBe('2026-08-29T04:00:00.000Z')
    expect(entries[1]?.time).toBe('2026-08-29T03:00:00.000Z')
  })

  it('skips malformed records while reading', async () => {
    const root = await newRoot('dsh-sync-log-malformed-')
    const log = new SyncLog(root, 3, FIXED_NOW)
    await mkdir(root, { recursive: true })
    await writeFile(join(root, 'sync-2026-08-29.jsonl'), [
      JSON.stringify(entry('2026-08-29T08:00:00.000Z', 'start')),
      'not json at all',
      JSON.stringify({ time: '2026-08-29T08:00:02.000Z', kind: 'weird' }),
      '',
    ].join('\n') + '\n')

    const entries = await log.read()
    expect(entries).toHaveLength(1)
    expect(entries[0]?.kind).toBe('start')
  })

  it('prunes day files outside the 3-day retention window and keeps the window', async () => {
    const root = await newRoot('dsh-sync-log-prune-')
    const log = new SyncLog(root, 3, FIXED_NOW)
    await mkdir(root, { recursive: true })
    await writeFile(join(root, 'sync-2026-08-25.jsonl'), '\n')
    await writeFile(join(root, 'sync-2026-08-26.jsonl'), '\n')
    await writeFile(join(root, 'sync-2026-08-27.jsonl'), '\n')
    await writeFile(join(root, 'sync-2026-08-29.jsonl'), '\n')
    await writeFile(join(root, 'unrelated.txt'), '\n')

    await log.prune()

    // The 3-day window on 08-29 covers 08-27, 08-28, 08-29; older days go away.
    await expect(readFile(join(root, 'sync-2026-08-25.jsonl'), 'utf8')).rejects.toThrow()
    await expect(readFile(join(root, 'sync-2026-08-26.jsonl'), 'utf8')).rejects.toThrow()
    await expect(readFile(join(root, 'sync-2026-08-27.jsonl'), 'utf8')).resolves.toBe('\n')
    await expect(readFile(join(root, 'unrelated.txt'), 'utf8')).resolves.toBe('\n')
  })

  it('prunes the window before reading, so expired days never contribute records', async () => {
    const root = await newRoot('dsh-sync-log-read-prunes-')
    const log = new SyncLog(root, 3, FIXED_NOW)
    await mkdir(root, { recursive: true })
    await writeFile(join(root, 'sync-2026-08-25.jsonl'), JSON.stringify(entry('2026-08-25T08:00:00.000Z', 'start')) + '\n')
    await log.append(entry('2026-08-29T08:00:00.000Z', 'success'))

    const entries = await log.read()
    expect(entries.map(record => record.kind)).toEqual(['success'])
    await expect(readFile(join(root, 'sync-2026-08-25.jsonl'), 'utf8')).rejects.toThrow()
  })

  it('reads an absent log directory as empty', async () => {
    const root = await newRoot('dsh-sync-log-empty-')
    const log = new SyncLog(join(root, 'logs'), 3, FIXED_NOW)
    expect(await log.read()).toEqual([])
  })
})
