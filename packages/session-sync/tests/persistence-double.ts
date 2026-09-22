/**
 * Persistence double for the host specs: sessions held in memory, every
 * read/write path recorded. Only the port surface the sync engine consumes —
 * `stat`, `open`, `create`, `list` and the handle's `read`/`append`/`flush`/
 * `close` — is implemented, because that is the whole contract
 * `SyncPersistence` names.
 */

import { parsePortableSession } from '../src/format.ts'
import { SessionLogOffset } from '@deepseek-ai/dsh-session'
import type { SessionEvent, SessionHeader } from '@deepseek-ai/dsh-session'

/** A persistence double: no sessions stored, all read/write paths recorded. */
export function fakePersistence(options: {
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
