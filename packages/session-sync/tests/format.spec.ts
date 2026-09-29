import { describe, expect, it } from 'vitest'
import { SESSION_FORMAT_VERSION, SessionId, SessionLogOffset } from '@deepseek-ai/dsh-session'
import type { SessionEvent, SessionHeader } from '@deepseek-ai/dsh-session'
import {
  ARCHIVE_NAME, MANIFEST_NAME, SYNC_ARTIFACT_VERSION, SYNC_LOCAL_SELECTION_VERSION, SYNC_MANIFEST_VERSION,
  SYNC_RECORD_LIMIT, SYNC_RECORDS_VERSION, SYNC_SELECTION_VERSION, SYNC_STATE_VERSION, WORKSPACES_DIR,
  archiveRepoPath, conflictRepoPath, decodeArtifact, encodeArtifact, manifestRepoPath,
  mergeRecords, parseArchiveList, parseLocalSelection, parseManifest, parsePortableSession,
  parseRecords, parseSelection, parseState, recordsRepoPath, selectionRepoPath,
  serializeArchiveList, serializeLocalSelection, serializeManifest, serializePortableSession,
  serializeRecords, serializeSelection, serializeState, sessionIdFromFilename, sessionRepoPath,
  workspaceRepoDir,
} from '../src/format.ts'
import type {
  LocalSelection, SessionSyncRecord, SyncSelection, SyncSelectionEntry, SyncState, WorkspaceManifest,
} from '../src/format.ts'

function headerLine(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    type: 'dsh-session-sync',
    version: SYNC_ARTIFACT_VERSION,
    workspace: 'ws-demo',
    inheritedEventCount: 0,
    session: {
      version: SESSION_FORMAT_VERSION,
      id: 'session-test',
      createdAt: 1000,
      isSeeded: false,
      delegationDepth: 0,
    },
    ...overrides,
  })
}

function artifact(header: string, rows: string[] = []): string {
  return [header, ...rows].join('\n') + '\n'
}

function eventRow(seq: number, turn: number): string {
  return JSON.stringify({ type: 'turn/start', seq, time: turn, data: { turn } })
}

const MANIFEST: WorkspaceManifest = {
  key: 'ws-demo',
  name: 'demo',
  updatedAt: '2026-09-01T00:00:00.000Z',
}

function selectionEntry(id: string, overrides: Partial<SyncSelectionEntry> = {}): SyncSelectionEntry {
  return {
    id: SessionId(id),
    key: 'ws-demo',
    workspaceName: 'demo',
    title: 'A session',
    addedAt: '2026-09-01T00:00:00.000Z',
    addedBy: 'machine-a',
    ...overrides,
  }
}

function record(overrides: Partial<SessionSyncRecord> = {}): SessionSyncRecord {
  return { host: 'machine-a', at: '2026-09-01T00:00:00.000Z', direction: 'push', events: 3, result: 'ok', ...overrides }
}

describe('serializePortableSession', () => {
  it('serializes a backend-independent header carrying the workspace key, one event per line', () => {
    const meta: SessionHeader = {
      version: SESSION_FORMAT_VERSION,
      id: SessionId('session-test'),
      createdAt: 1000,
      cwd: '/work/demo',
      isSeeded: false,
      delegationDepth: 0,
    }
    const events = [
      { type: 'turn/start', seq: 0, time: 1, data: { turn: 1 } } as SessionEvent,
      { type: 'turn/start', seq: 1, time: 2, data: { turn: 2 } } as SessionEvent,
    ]
    const text = serializePortableSession({ meta, inheritedEventCount: SessionLogOffset(0), events }, 'ws-demo')
    expect(text).toBe(artifact(headerLine(), events.map(event => JSON.stringify(event))))
    // The local path never travels: the header carries the stable workspace key.
    expect(text).not.toContain('/work/demo')
  })

  it('round-trips a serialized artifact through the parser', () => {
    const meta: SessionHeader = {
      version: SESSION_FORMAT_VERSION,
      id: SessionId('session-test'),
      createdAt: 1000,
      cwd: '/work/demo',
      parentSession: SessionId('session-parent'),
      isSeeded: false,
      origin: 'subagent',
      delegationDepth: 1,
      agentPreset: 'web',
    }
    const events = [{ type: 'turn/start', seq: 0, time: 1, data: { turn: 1 } } as SessionEvent]
    const text = serializePortableSession({ meta, inheritedEventCount: SessionLogOffset(0), events }, 'ws-demo')
    const parsed = parsePortableSession(text, '/local/demo')
    expect(parsed.meta).toMatchObject({
      id: SessionId('session-test'),
      createdAt: 1000,
      cwd: '/local/demo',
      parentSession: SessionId('session-parent'),
      isSeeded: false,
      origin: 'subagent',
      delegationDepth: 1,
      agentPreset: 'web',
    })
    expect(parsed.events).toEqual(events)
  })

  it('rejects a nonzero inherited cut for an unseeded session', () => {
    const meta: SessionHeader = {
      version: SESSION_FORMAT_VERSION,
      id: SessionId('session-test'),
      createdAt: 1000,
      isSeeded: false,
    }
    expect(() => serializePortableSession({ meta, inheritedEventCount: SessionLogOffset(1), events: [] }, 'ws-demo'))
      .toThrow(/unseeded session inheritedEventCount/)
  })
})

describe('parsePortableSession', () => {
  it('parses a full header and a contiguous event log, stamping the local path', () => {
    const text = artifact(
      headerLine({
        inheritedEventCount: 1,
        session: {
          version: SESSION_FORMAT_VERSION,
          id: 'session-test',
          createdAt: 1000,
          parentSession: 'session-parent',
          isSeeded: true,
          origin: 'subagent',
          delegationDepth: 1,
          agentPreset: 'web',
        },
      }),
      [eventRow(0, 1), eventRow(1, 2)],
    )
    const parsed = parsePortableSession(text, '/local/demo')

    expect(parsed.meta).toMatchObject({
      version: SESSION_FORMAT_VERSION,
      id: SessionId('session-test'),
      createdAt: 1000,
      cwd: '/local/demo',
      parentSession: SessionId('session-parent'),
      isSeeded: true,
      origin: 'subagent',
      delegationDepth: 1,
      agentPreset: 'web',
    })
    expect(parsed.inheritedEventCount).toBe(1)
    expect(parsed.events).toHaveLength(2)
    expect(parsed.events[1]).toMatchObject({ type: 'turn/start', seq: 1, data: { turn: 2 } })
  })

  it('defaults delegationDepth to 0 and drops absent optional fields', () => {
    const parsed = parsePortableSession(artifact(headerLine({
      session: { version: SESSION_FORMAT_VERSION, id: 'session-test', createdAt: 1000, isSeeded: false },
    })), '/local/demo')
    expect(parsed.meta.delegationDepth).toBe(0)
    expect(parsed.meta.parentSession).toBeUndefined()
    expect(parsed.meta.isSeeded).toBe(false)
    expect(parsed.meta.origin).toBeUndefined()
    expect(parsed.meta.agentPreset).toBeUndefined()
  })

  it('rejects a seq gap in the event rows', () => {
    const text = artifact(headerLine(), [eventRow(0, 1), eventRow(5, 6)])
    expect(() => parsePortableSession(text, '/local/demo')).toThrow(/seq gap/)
  })

  it('rejects an unparsable event row', () => {
    const text = artifact(headerLine(), ['{not json', eventRow(0, 1)])
    expect(() => parsePortableSession(text, '/local/demo')).toThrow(/unparsable event row/)
  })

  it('rejects an artifact without a header newline', () => {
    expect(() => parsePortableSession('just-one-line', '/local/demo')).toThrow(/missing header newline/)
  })

  it('rejects invalid JSON and invalid header shapes', () => {
    expect(() => parsePortableSession(artifact('{broken'), '/local/demo')).toThrow()
    expect(() => parsePortableSession(artifact('"a string"'), '/local/demo')).toThrow(/not a JSON object/)
    expect(() => parsePortableSession(artifact('[1,2]'), '/local/demo')).toThrow(/not a session-sync header/)
    expect(() => parsePortableSession(artifact(headerLine({ type: 'event' })), '/local/demo')).toThrow(/not a session-sync header/)
    expect(() => parsePortableSession(artifact(headerLine({ workspace: '' })), '/local/demo')).toThrow(/workspace key is invalid/)
    expect(() => parsePortableSession(artifact(headerLine({ inheritedEventCount: -1 })), '/local/demo')).toThrow(/inheritedEventCount is invalid/)
    expect(() => parsePortableSession(artifact(headerLine({ session: null })), '/local/demo')).toThrow(/session header is invalid/)
    expect(() => parsePortableSession(artifact(headerLine({ session: [1] })), '/local/demo')).toThrow(/session header is invalid/)
    const invalidSession = (overrides: Record<string, unknown>): string => headerLine({
      session: { version: SESSION_FORMAT_VERSION, id: 'session-test', createdAt: 1000, isSeeded: false, ...overrides },
    })
    expect(() => parsePortableSession(artifact(invalidSession({ version: 2 })), '/local/demo')).toThrow(/unsupported session version/)
    expect(() => parsePortableSession(artifact(invalidSession({ id: '../evil' })), '/local/demo')).toThrow(/id is invalid/)
    expect(() => parsePortableSession(artifact(invalidSession({ createdAt: -1 })), '/local/demo')).toThrow(/createdAt is invalid/)
    expect(() => parsePortableSession(artifact(invalidSession({ parentSession: 7 })), '/local/demo')).toThrow(/parentSession is invalid/)
    expect(() => parsePortableSession(artifact(invalidSession({ parentSession: '../evil' })), '/local/demo')).toThrow(/parentSession is invalid/)
    expect(() => parsePortableSession(artifact(invalidSession({ isSeeded: 'yes' })), '/local/demo')).toThrow(/isSeeded is invalid/)
    expect(() => parsePortableSession(artifact(headerLine({ inheritedEventCount: 1 })), '/local/demo')).toThrow(/unseeded session inheritedEventCount/)
    expect(() => parsePortableSession(artifact(invalidSession({ origin: 'forked' })), '/local/demo')).toThrow(/origin is invalid/)
    expect(() => parsePortableSession(artifact(invalidSession({ delegationDepth: -1 })), '/local/demo')).toThrow(/delegationDepth is invalid/)
    expect(() => parsePortableSession(artifact(invalidSession({ agentPreset: 9 })), '/local/demo')).toThrow(/agentPreset is invalid/)
  })

  it('rejects an artifact version this plugin does not write', () => {
    expect(() => parsePortableSession(artifact(headerLine({ version: 1 })), '/local/demo'))
      .toThrow(/unsupported artifact version 1/)
    expect(() => parsePortableSession(artifact(headerLine({ version: 3 })), '/local/demo'))
      .toThrow(/unsupported artifact version 3/)
    // The v1 header spelled the workspace `project`; there is no migration.
    expect(() => parsePortableSession(artifact(JSON.stringify({
      type: 'dsh-session-sync',
      version: 1,
      project: 'demo',
      inheritedEventCount: 0,
      session: { version: SESSION_FORMAT_VERSION, id: 'session-test', createdAt: 1000, isSeeded: false },
    })), '/local/demo')).toThrow(/unsupported artifact version 1/)
  })

  it('rejects invalid event envelopes and inherited cuts beyond the log', () => {
    expect(() => parsePortableSession(artifact(headerLine(), [JSON.stringify({ type: 'turn/start', seq: 0, data: { turn: 1 } })]), '/local/demo'))
      .toThrow(/event envelope is invalid/)
    expect(() => parsePortableSession(artifact(headerLine(), [JSON.stringify(['turn/start'])]), '/local/demo'))
      .toThrow(/event row is not a JSON object/)
    expect(() => parsePortableSession(artifact(headerLine(), [JSON.stringify({ type: 'foreign/required', seq: 0, time: 1, data: {} })]), '/local/demo'))
      .toThrow(/unknown required event type/)
    expect(() => parsePortableSession(artifact(headerLine(), [JSON.stringify({ type: 'foreign/optional', seq: 0, time: 1, data: {}, ignorable: true })]), '/local/demo'))
      .not.toThrow()
    expect(() => parsePortableSession(artifact(headerLine({
      inheritedEventCount: 1,
      session: { version: SESSION_FORMAT_VERSION, id: 'session-test', createdAt: 1000, isSeeded: true },
    })), '/local/demo')).toThrow(/exceeds the event log/)
  })
})

describe('repo path helpers', () => {
  it('builds workspace, records, manifest, archive, and conflict paths with unsafe characters encoded', () => {
    expect(workspaceRepoDir('ws-demo')).toBe(`${WORKSPACES_DIR}/ws-demo`)
    expect(sessionRepoPath('ws-demo', SessionId('session-a'))).toBe('workspaces/ws-demo/session-a.jsonl')
    expect(sessionRepoPath('ws de mo', SessionId('session-a'))).toBe('workspaces/ws~0020de~0020mo/session-a.jsonl')
    expect(recordsRepoPath('ws-demo', SessionId('session-a'))).toBe('workspaces/ws-demo/session-a.records.json')
    expect(manifestRepoPath('ws-demo')).toBe(`workspaces/ws-demo/${MANIFEST_NAME}`)
    expect(archiveRepoPath('ws-demo')).toBe(`workspaces/ws-demo/${ARCHIVE_NAME}`)
    expect(archiveRepoPath('ws de mo')).toBe('workspaces/ws~0020de~0020mo/archived.json')
    expect(conflictRepoPath('ws-demo', SessionId('session-a'), 'host-1')).toBe(
      'conflicts/ws-demo/session-a-host-1.jsonl',
    )
  })

  it('puts the selection at the worktree root', () => {
    expect(selectionRepoPath()).toBe('sync.json')
  })

  it('decodes session ids from file names and rejects foreign names', () => {
    expect(sessionIdFromFilename('session-abc-123.jsonl')).toBe(SessionId('session-abc-123'))
    expect(sessionIdFromFilename('README.md')).toBeUndefined()
    expect(sessionIdFromFilename('session-../x.jsonl')).toBeUndefined()
    expect(sessionIdFromFilename('session-x.txt')).toBeUndefined()
    expect(sessionIdFromFilename('session-x.records.json')).toBeUndefined()
  })
})

describe('workspace manifests', () => {
  it('serializes a versioned manifest and parses it back', () => {
    expect(serializeManifest(MANIFEST)).toBe(JSON.stringify({
      version: SYNC_MANIFEST_VERSION,
      key: 'ws-demo',
      name: 'demo',
      updatedAt: '2026-09-01T00:00:00.000Z',
    }) + '\n')
    expect(parseManifest(serializeManifest(MANIFEST), 'ws-demo')).toEqual(MANIFEST)
  })

  it('rejects a manifest whose key disagrees with its directory', () => {
    const text = serializeManifest(MANIFEST)
    expect(() => parseManifest(text, 'ws-other')).toThrow(/key "ws-demo" does not match its directory "ws-other"/)
  })

  it('rejects malformed manifests instead of guessing a name', () => {
    expect(() => parseManifest('{broken', 'ws-demo')).toThrow(/not valid JSON/)
    expect(() => parseManifest('"a string"', 'ws-demo')).toThrow(/not a JSON object/)
    expect(() => parseManifest('[1]', 'ws-demo')).toThrow(/not a JSON object/)
    expect(() => parseManifest('{ "key": "ws-demo", "name": "demo", "updatedAt": "2026-09-01T00:00:00.000Z" }', 'ws-demo'))
      .toThrow(/unsupported version undefined/)
    expect(() => parseManifest('{ "version": 1, "key": "ws-demo", "name": "demo", "updatedAt": "2026-09-01T00:00:00.000Z" }', 'ws-demo'))
      .toThrow(/unsupported version 1/)
    expect(() => parseManifest('{ "version": 2, "key": "ws-demo", "name": "", "updatedAt": "2026-09-01T00:00:00.000Z" }', 'ws-demo'))
      .toThrow(/name is not a non-empty string/)
    expect(() => parseManifest('{ "version": 2, "key": "ws-demo", "name": "demo", "updatedAt": 7 }', 'ws-demo'))
      .toThrow(/updatedAt is not an ISO-8601 instant/)
    expect(() => parseManifest('{ "version": 2, "key": "ws-demo", "name": "demo", "updatedAt": "not a date" }', 'ws-demo'))
      .toThrow(/updatedAt is not an ISO-8601 instant/)
  })
})

describe('selection snapshot', () => {
  const selection: SyncSelection = {
    host: 'machine-a',
    updatedAt: '2026-09-01T00:00:00.000Z',
    entries: [selectionEntry('session-b'), selectionEntry('session-a', { title: 'Other' })],
  }

  it('round-trips a whole-snapshot selection, sorted canonically by id', () => {
    const text = serializeSelection(selection)
    expect(text).toBe(JSON.stringify({
      version: SYNC_SELECTION_VERSION,
      updatedAt: '2026-09-01T00:00:00.000Z',
      host: 'machine-a',
      entries: [
        {
          id: 'session-a', key: 'ws-demo', workspaceName: 'demo', title: 'Other',
          addedAt: '2026-09-01T00:00:00.000Z', addedBy: 'machine-a',
        },
        {
          id: 'session-b', key: 'ws-demo', workspaceName: 'demo', title: 'A session',
          addedAt: '2026-09-01T00:00:00.000Z', addedBy: 'machine-a',
        },
      ],
    }) + '\n')
    expect(parseSelection(text)).toEqual({
      host: 'machine-a',
      updatedAt: '2026-09-01T00:00:00.000Z',
      entries: [selectionEntry('session-a', { title: 'Other' }), selectionEntry('session-b')],
    })
  })

  it('round-trips an empty snapshot: a selection can close every session', () => {
    const text = serializeSelection({ host: 'machine-a', updatedAt: '2026-09-01T00:00:00.000Z', entries: [] })
    expect(parseSelection(text)).toEqual({ host: 'machine-a', updatedAt: '2026-09-01T00:00:00.000Z', entries: [] })
  })

  it('rejects a malformed snapshot instead of silently emptying the selection', () => {
    expect(() => parseSelection('{broken')).toThrow(/not valid JSON/)
    expect(() => parseSelection('"a string"')).toThrow(/not a JSON object/)
    expect(() => parseSelection('[1]')).toThrow(/not a JSON object/)
    expect(() => parseSelection('{ "host": "h", "updatedAt": "t", "entries": [] }')).toThrow(/unsupported version undefined/)
    expect(() => parseSelection('{ "version": 1, "host": "h", "updatedAt": "t", "entries": [] }')).toThrow(/unsupported version 1/)
    expect(() => parseSelection('{ "version": 2, "updatedAt": "t", "entries": [] }')).toThrow(/host is not a string/)
    expect(() => parseSelection('{ "version": 2, "host": "h", "entries": [] }')).toThrow(/updatedAt is not an ISO-8601 instant/)
    expect(() => parseSelection('{ "version": 2, "host": "h", "updatedAt": "2026-09-01T00:00:00.000Z" }')).toThrow(/entries is not an array/)
  })

  it('rejects a malformed entry, naming what is wrong', () => {
    const wrap = (entry: unknown): string => JSON.stringify({
      version: 2, host: 'h', updatedAt: '2026-09-01T00:00:00.000Z', entries: [entry],
    })
    const valid = { id: 'session-a', key: 'ws-demo', workspaceName: 'demo', title: 'T', addedAt: '2026-09-01T00:00:00.000Z', addedBy: 'h' }
    expect(() => parseSelection(wrap('nope'))).toThrow(/entry is not a JSON object/)
    expect(() => parseSelection(wrap([1]))).toThrow(/entry is not a JSON object/)
    expect(() => parseSelection(wrap({ ...valid, id: '../evil' }))).toThrow(/invalid session id/)
    expect(() => parseSelection(wrap({ ...valid, key: '' }))).toThrow(/invalid workspace key/)
    expect(() => parseSelection(wrap({ ...valid, workspaceName: '' }))).toThrow(/invalid workspace name/)
    expect(() => parseSelection(wrap({ ...valid, title: 7 }))).toThrow(/invalid title/)
    expect(() => parseSelection(wrap({ ...valid, addedAt: 'not a date' }))).toThrow(/invalid addedAt/)
    expect(() => parseSelection(wrap({ ...valid, addedBy: '' }))).toThrow(/invalid addedBy/)
  })

  it('rejects a snapshot carrying the same session twice', () => {
    const entry = { id: 'session-a', key: 'ws-demo', workspaceName: 'demo', title: 'T', addedAt: '2026-09-01T00:00:00.000Z', addedBy: 'h' }
    const text = JSON.stringify({
      version: 2, host: 'h', updatedAt: '2026-09-01T00:00:00.000Z', entries: [entry, { ...entry }],
    })
    expect(() => parseSelection(text)).toThrow(/duplicate session id session-a/)
  })
})

describe('session records', () => {
  it('round-trips records in stored order', () => {
    const records = { records: [record(), record({ at: '2026-09-02T00:00:00.000Z', direction: 'pull', result: 'conflict', events: 0 })] }
    const text = serializeRecords(records)
    expect(text).toBe(JSON.stringify({
      version: SYNC_RECORDS_VERSION,
      records: [
        { host: 'machine-a', at: '2026-09-01T00:00:00.000Z', direction: 'push', events: 3, result: 'ok' },
        { host: 'machine-a', at: '2026-09-02T00:00:00.000Z', direction: 'pull', events: 0, result: 'conflict' },
      ],
    }) + '\n')
    expect(parseRecords(text)).toEqual(records)
  })

  it('caps the file at SYNC_RECORD_LIMIT, keeping the newest', () => {
    const many: SessionSyncRecord[] = []
    for (let index = 0; index < SYNC_RECORD_LIMIT + 5; index++) {
      many.push(record({ at: `2026-09-${String(index + 1).padStart(2, '0')}T00:00:00.000Z`, events: index }))
    }
    const parsed = parseRecords(serializeRecords({ records: many }))
    expect(parsed.records).toHaveLength(SYNC_RECORD_LIMIT)
    expect(parsed.records[0]?.events).toBe(5)
    expect(parsed.records[parsed.records.length - 1]?.events).toBe(SYNC_RECORD_LIMIT + 4)
  })

  it('rejects malformed records for the caller to report', () => {
    expect(() => parseRecords('{broken')).toThrow(/not valid JSON/)
    expect(() => parseRecords('[1]')).toThrow(/not a JSON object/)
    expect(() => parseRecords('{ "version": 1, "records": [] }')).toThrow(/unsupported version 1/)
    expect(() => parseRecords('{ "version": 2 }')).toThrow(/records is not an array/)
    const wrap = (entry: unknown): string => JSON.stringify({ version: 2, records: [entry] })
    const valid = { host: 'machine-a', at: '2026-09-01T00:00:00.000Z', direction: 'push', events: 3, result: 'ok' }
    expect(() => parseRecords(wrap('nope'))).toThrow(/record is not a JSON object/)
    expect(() => parseRecords(wrap({ ...valid, host: '' }))).toThrow(/invalid host/)
    expect(() => parseRecords(wrap({ ...valid, at: 'nope' }))).toThrow(/invalid at/)
    expect(() => parseRecords(wrap({ ...valid, direction: 'sideways' }))).toThrow(/invalid direction/)
    expect(() => parseRecords(wrap({ ...valid, events: -1 }))).toThrow(/invalid events/)
    expect(() => parseRecords(wrap({ ...valid, result: 'maybe' }))).toThrow(/invalid result/)
  })

  it('merges by host, instant, and direction, so re-reading a file never duplicates', () => {
    const existing = [record({ at: '2026-09-01T00:00:00.000Z' }), record({ host: 'machine-b', at: '2026-09-02T00:00:00.000Z' })]
    const merged = mergeRecords(existing, [record({ at: '2026-09-01T00:00:00.000Z' }), record({ host: 'machine-c', at: '2026-09-03T00:00:00.000Z' })])
    expect(merged.map(item => item.host)).toEqual(['machine-a', 'machine-b', 'machine-c'])
  })

  it('keeps a later observation of the same key and caps the merged list', () => {
    const replaced = mergeRecords([record({ events: 1 })], [record({ events: 9 })])
    expect(replaced).toEqual([record({ events: 9 })])

    const many: SessionSyncRecord[] = []
    for (let index = 0; index < SYNC_RECORD_LIMIT + 3; index++) {
      many.push(record({ at: `2026-09-${String(index + 1).padStart(2, '0')}T00:00:00.000Z`, events: index }))
    }
    const merged = mergeRecords([], many)
    expect(merged).toHaveLength(SYNC_RECORD_LIMIT)
    expect(merged[0]?.events).toBe(3)
  })
})

describe('workspace archive lists', () => {
  it('serializes a sorted, deduplicated, versioned list', () => {
    expect(serializeArchiveList([SessionId('session-z'), SessionId('session-a'), SessionId('session-z')])).toBe(
      JSON.stringify({ version: 1, sessionIds: ['session-a', 'session-z'] }) + '\n',
    )
    expect(serializeArchiveList([])).toBe(JSON.stringify({ version: 1, sessionIds: [] }) + '\n')
  })

  it('parses a valid list back into branded ids, and unions are grow-only sets', () => {
    const text = serializeArchiveList([SessionId('session-b'), SessionId('session-a')])
    expect(parseArchiveList(text)).toEqual([SessionId('session-a'), SessionId('session-b')])
    // The union a machine writes is the repo's marks plus its own additions.
    const union = new Set([...parseArchiveList(text).map(String), 'session-c'])
    expect([...union].sort()).toEqual(['session-a', 'session-b', 'session-c'])
  })

  it('rejects malformed lists instead of silently hiding sessions', () => {
    expect(() => parseArchiveList('{broken')).toThrow(/not valid JSON/)
    expect(() => parseArchiveList('"a string"')).toThrow(/not a JSON object/)
    expect(() => parseArchiveList('[1,2]')).toThrow(/not a JSON object/)
    expect(() => parseArchiveList('{ "version": 2, "sessionIds": [] }')).toThrow(/unsupported version 2/)
    expect(() => parseArchiveList('{ "version": 1 }')).toThrow(/sessionIds is not an array/)
    expect(() => parseArchiveList('{ "version": 1, "sessionIds": [42] }')).toThrow(/invalid session id 42/)
    expect(() => parseArchiveList('{ "version": 1, "sessionIds": ["../evil"] }')).toThrow(/invalid session id/)
  })
})

describe('machine-local selection mirror', () => {
  const selection: LocalSelection = { sessionIds: [SessionId('session-b'), SessionId('session-a')] }

  it('round-trips a sorted, deduplicated mirror', () => {
    const text = serializeLocalSelection(selection)
    expect(text).toBe(JSON.stringify({
      version: SYNC_LOCAL_SELECTION_VERSION,
      sessionIds: ['session-a', 'session-b'],
    }) + '\n')
    expect(parseLocalSelection(text)).toEqual({
      sessionIds: [SessionId('session-a'), SessionId('session-b')],
    })
  })

  it('rejects a malformed mirror instead of silently dropping the user\'s edits', () => {
    expect(() => parseLocalSelection('{broken')).toThrow(/not valid JSON/)
    expect(() => parseLocalSelection('[1]')).toThrow(/not a JSON object/)
    expect(() => parseLocalSelection('{ "sessionIds": [] }')).toThrow(/unsupported version undefined/)
    expect(() => parseLocalSelection('{ "version": 1, "sessionIds": [] }')).toThrow(/unsupported version 1/)
    expect(() => parseLocalSelection('{ "version": 2 }')).toThrow(/sessionIds is not an array/)
    expect(() => parseLocalSelection('{ "version": 2, "sessionIds": ["../evil"] }')).toThrow(/invalid session id/)
  })
})

describe('machine-local sync anchor', () => {
  const state: SyncState = {
    firstSeen: true,
    syncedIds: [SessionId('session-b'), SessionId('session-a')],
    ownedIds: [SessionId('session-a')],
    workspaceKeys: [{ workspaceId: 'local-b', key: 'ws-b' }, { workspaceId: 'local-a', key: 'ws-a' }],
    host: 'machine-a',
    updatedAt: '2026-09-01T00:00:00.000Z',
  }

  it('round-trips the applied selection, the owned set, and the workspace-key table', () => {
    const text = serializeState(state)
    expect(text).toBe(JSON.stringify({
      version: SYNC_STATE_VERSION,
      firstSeen: true,
      updatedAt: '2026-09-01T00:00:00.000Z',
      host: 'machine-a',
      syncedIds: ['session-a', 'session-b'],
      ownedIds: ['session-a'],
      workspaceKeys: [{ workspaceId: 'local-a', key: 'ws-a' }, { workspaceId: 'local-b', key: 'ws-b' }],
    }) + '\n')
    expect(parseState(text)).toEqual({
      firstSeen: true,
      syncedIds: [SessionId('session-a'), SessionId('session-b')],
      ownedIds: [SessionId('session-a')],
      workspaceKeys: [{ workspaceId: 'local-a', key: 'ws-a' }, { workspaceId: 'local-b', key: 'ws-b' }],
      host: 'machine-a',
      updatedAt: '2026-09-01T00:00:00.000Z',
    })
  })

  it('rejects a malformed anchor instead of guessing which side won', () => {
    expect(() => parseState('{broken')).toThrow(/not valid JSON/)
    expect(() => parseState('{ "version": 1, "firstSeen": true }')).toThrow(/unsupported version 1/)
    expect(() => parseState('{ "version": 2 }')).toThrow(/firstSeen is not a boolean/)
    expect(() => parseState('{ "version": 2, "firstSeen": true }')).toThrow(/syncedIds is not an array/)
    expect(() => parseState('{ "version": 2, "firstSeen": true, "syncedIds": [] }')).toThrow(/ownedIds is not an array/)
    expect(() => parseState('{ "version": 2, "firstSeen": true, "syncedIds": [], "ownedIds": [] }'))
      .toThrow(/workspaceKeys is not an array/)
    expect(() => parseState('{ "version": 2, "firstSeen": true, "syncedIds": [], "ownedIds": [], "workspaceKeys": [] }'))
      .toThrow(/host is not a string/)
    expect(() => parseState('{ "version": 2, "firstSeen": true, "syncedIds": [], "ownedIds": [], "workspaceKeys": [], "host": "h" }'))
      .toThrow(/updatedAt is not an ISO-8601 instant/)
    const wrap = (patch: Record<string, unknown>): string => JSON.stringify({
      version: 2, firstSeen: true, syncedIds: [], ownedIds: [], workspaceKeys: [],
      host: 'h', updatedAt: '2026-09-01T00:00:00.000Z', ...patch,
    })
    expect(() => parseState(wrap({ syncedIds: ['../evil'] }))).toThrow(/invalid synced id/)
    expect(() => parseState(wrap({ ownedIds: ['../evil'] }))).toThrow(/invalid owned id/)
    expect(() => parseState(wrap({ workspaceKeys: ['nope'] }))).toThrow(/workspace key entry is not a JSON object/)
    expect(() => parseState(wrap({ workspaceKeys: [{ key: 'ws-a' }] }))).toThrow(/has no workspaceId/)
    expect(() => parseState(wrap({ workspaceKeys: [{ workspaceId: 'local-a' }] }))).toThrow(/has no key/)
  })
})

describe('artifact encoding', () => {
  it('round-trips UTF-8 text through buffers', () => {
    const text = artifact(headerLine(), [eventRow(0, 1)])
    expect(decodeArtifact(encodeArtifact(text))).toBe(text)
  })
})
