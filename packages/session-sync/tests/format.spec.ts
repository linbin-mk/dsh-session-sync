import { describe, expect, it } from 'vitest'
import { SESSION_FORMAT_VERSION, SessionId, SessionLogOffset } from '@deepseek-ai/dsh-session'
import type { SessionEvent, SessionHeader } from '@deepseek-ai/dsh-session'
import {
  archiveRepoPath, conflictRepoPath, decodeArtifact, encodeArtifact,
  parseArchiveList, parsePortableSession, serializeArchiveList,
  serializeManifest, serializePortableSession, sessionIdFromFilename, sessionRepoPath,
} from '../src/format.ts'

function headerLine(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    type: 'dsh-session-sync',
    version: 1,
    project: 'demo',
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

describe('serializePortableSession', () => {
  it('serializes a backend-independent header and one logical event per line', () => {
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
    const text = serializePortableSession({ meta, inheritedEventCount: SessionLogOffset(0), events }, 'demo')
    expect(text).toBe(artifact(headerLine(), events.map(event => JSON.stringify(event))))
  })

  it('rejects a nonzero inherited cut for an unseeded session', () => {
    const meta: SessionHeader = {
      version: SESSION_FORMAT_VERSION,
      id: SessionId('session-test'),
      createdAt: 1000,
      isSeeded: false,
    }
    expect(() => serializePortableSession({ meta, inheritedEventCount: SessionLogOffset(1), events: [] }, 'demo'))
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
    expect(() => parsePortableSession(artifact(headerLine({ version: 2 })), '/local/demo')).toThrow(/unsupported artifact version/)
    expect(() => parsePortableSession(artifact(headerLine({ project: '' })), '/local/demo')).toThrow(/project key is invalid/)
    expect(() => parsePortableSession(artifact(headerLine({ inheritedEventCount: -1 })), '/local/demo')).toThrow(/inheritedEventCount is invalid/)
    expect(() => parsePortableSession(artifact(headerLine({ session: null })), '/local/demo')).toThrow(/session header is invalid/)
    const invalidSession = (overrides: Record<string, unknown>): string => headerLine({
      session: { version: SESSION_FORMAT_VERSION, id: 'session-test', createdAt: 1000, isSeeded: false, ...overrides },
    })
    expect(() => parsePortableSession(artifact(invalidSession({ version: 2 })), '/local/demo')).toThrow(/unsupported session version/)
    expect(() => parsePortableSession(artifact(invalidSession({ id: '../evil' })), '/local/demo')).toThrow(/id is invalid/)
    expect(() => parsePortableSession(artifact(invalidSession({ createdAt: -1 })), '/local/demo')).toThrow(/createdAt is invalid/)
    expect(() => parsePortableSession(artifact(invalidSession({ parentSession: 7 })), '/local/demo')).toThrow(/parentSession is invalid/)
    expect(() => parsePortableSession(artifact(invalidSession({ isSeeded: 'yes' })), '/local/demo')).toThrow(/isSeeded is invalid/)
    expect(() => parsePortableSession(artifact(headerLine({ inheritedEventCount: 1 })), '/local/demo')).toThrow(/unseeded session inheritedEventCount/)
    expect(() => parsePortableSession(artifact(invalidSession({ origin: 'forked' })), '/local/demo')).toThrow(/origin is invalid/)
    expect(() => parsePortableSession(artifact(invalidSession({ delegationDepth: -1 })), '/local/demo')).toThrow(/delegationDepth is invalid/)
    expect(() => parsePortableSession(artifact(invalidSession({ agentPreset: 9 })), '/local/demo')).toThrow(/agentPreset is invalid/)
  })

  it('rejects invalid event envelopes and inherited cuts beyond the log', () => {
    expect(() => parsePortableSession(artifact(headerLine(), [JSON.stringify({ type: 'turn/start', seq: 0, data: { turn: 1 } })]), '/local/demo'))
      .toThrow(/event envelope is invalid/)
    expect(() => parsePortableSession(artifact(headerLine(), [JSON.stringify({ type: 'foreign/required', seq: 0, time: 1, data: {} })]), '/local/demo'))
      .toThrow(/unknown required event type/)
    expect(() => parsePortableSession(artifact(headerLine({
      inheritedEventCount: 1,
      session: { version: SESSION_FORMAT_VERSION, id: 'session-test', createdAt: 1000, isSeeded: true },
    })), '/local/demo')).toThrow(/exceeds the event log/)
  })
})

describe('repo path helpers', () => {
  it('builds project and conflict paths with unsafe characters encoded', () => {
    expect(sessionRepoPath('demo', SessionId('session-a'))).toBe('projects/demo/session-a.jsonl')
    expect(sessionRepoPath('da ily', SessionId('session-a'))).toBe('projects/da~0020ily/session-a.jsonl')
    expect(conflictRepoPath('demo', SessionId('session-a'), 'host-1')).toBe(
      'conflicts/demo/session-a-host-1.jsonl',
    )
  })

  it('decodes session ids from file names and rejects foreign names', () => {
    expect(sessionIdFromFilename('session-abc-123.jsonl')).toBe(SessionId('session-abc-123'))
    expect(sessionIdFromFilename('README.md')).toBeUndefined()
    expect(sessionIdFromFilename('session-../x.jsonl')).toBeUndefined()
    expect(sessionIdFromFilename('session-x.txt')).toBeUndefined()
  })

  it('serializes a sorted manifest', () => {
    expect(serializeManifest(['zeta', 'alpha'])).toBe(
      JSON.stringify({ version: 1, projects: ['alpha', 'zeta'] }) + '\n',
    )
  })
})

describe('project archive lists', () => {
  it('builds the archive-list path with unsafe characters encoded', () => {
    expect(archiveRepoPath('demo')).toBe('projects/demo/archived.json')
    expect(archiveRepoPath('da ily')).toBe('projects/da~0020ily/archived.json')
  })

  it('serializes a sorted, deduplicated, versioned list', () => {
    expect(serializeArchiveList([SessionId('session-z'), SessionId('session-a'), SessionId('session-z')])).toBe(
      JSON.stringify({ version: 1, sessionIds: ['session-a', 'session-z'] }) + '\n',
    )
    expect(serializeArchiveList([])).toBe(JSON.stringify({ version: 1, sessionIds: [] }) + '\n')
  })

  it('parses a valid list back into branded ids', () => {
    const text = serializeArchiveList([SessionId('session-b'), SessionId('session-a')])
    expect(parseArchiveList(text)).toEqual([SessionId('session-a'), SessionId('session-b')])
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

describe('artifact encoding', () => {
  it('round-trips UTF-8 text through buffers', () => {
    const text = artifact(headerLine(), [eventRow(0, 1)])
    expect(decodeArtifact(encodeArtifact(text))).toBe(text)
  })
})
