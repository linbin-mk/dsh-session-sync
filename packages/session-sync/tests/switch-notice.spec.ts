import { describe, expect, it } from 'vitest'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { UserMessage } from '@deepseek-ai/dsh-session'
import type { Agent, PreStepDecision } from '@deepseek-ai/dsh-agent'
import {
  SWITCH_NOTICE_PLUGIN, SWITCH_NOTICE_SUMMARY, SWITCH_NOTICE_TEXT,
  createSwitchNoticeMessage, withSwitchNotice,
} from '../src/switch-notice.ts'

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    /** A foreign plugin's notice; declared here to prove unknown kinds fall through. */
    'other-plugin': { kind: 'other-plugin'; form: 'notice'; summary: string }
  }
}

/** Minimal live-agent fake: the notice logic only reads the session id. */
function agent(id: string): Agent {
  return { session: { id: SessionId(id) } } as unknown as Agent
}

function userMessage(text = '继续干活'): UserMessage {
  return createUserMessage({
    content: [{ type: 'text', text }],
    source: { kind: 'user' },
  })
}

function pluginMessage(summary: string): UserMessage {
  return createUserMessage({
    content: [{ type: 'text', text: 'tool continuation' }],
    source: { kind: 'other-plugin', form: 'notice', summary },
  })
}

function enter(messages: readonly UserMessage[]): PreStepDecision {
  return { kind: 'enter', messages: [...messages] }
}

describe('createSwitchNoticeMessage', () => {
  it('builds a durable plugin notice with a bounded one-line summary', () => {
    const notice = createSwitchNoticeMessage()
    expect(notice.role).toBe('user')
    expect(notice.source).toMatchObject({
      kind: SWITCH_NOTICE_PLUGIN,
      form: 'notice',
      summary: SWITCH_NOTICE_SUMMARY,
    })
    expect(SWITCH_NOTICE_SUMMARY.length).toBeLessThanOrEqual(120)
    expect(notice.content).toEqual([{ type: 'text', text: SWITCH_NOTICE_TEXT }])
  })
})

describe('withSwitchNotice', () => {
  it('leaves rejected decisions untouched', () => {
    const pending = new Set(['session-a'])
    const reviewed = withSwitchNotice(pending, agent('session-a'), [userMessage()], { kind: 'reject' })
    expect(reviewed).toEqual({ decision: { kind: 'reject' }, consumed: false })
    expect(pending.size).toBe(1)
  })

  it('ignores sessions without a pending mark', () => {
    const claimed = [userMessage()]
    const decision = enter(claimed)
    const reviewed = withSwitchNotice(new Set(), agent('session-a'), claimed, decision)
    expect(reviewed.decision).toBe(decision)
    expect(reviewed.consumed).toBe(false)
  })

  it('keeps the mark pending when the claimed batch has no real user message', () => {
    const pending = new Set(['session-a'])
    const claimed = [pluginMessage('tool wake')]
    const decision = enter(claimed)
    const reviewed = withSwitchNotice(pending, agent('session-a'), claimed, decision)
    expect(reviewed.decision).toBe(decision)
    expect(reviewed.consumed).toBe(false)
    expect(pending.has('session-a')).toBe(true)
  })

  it('leaves a decision another listener emptied untouched (no notice-only turn)', () => {
    const pending = new Set(['session-a'])
    const reviewed = withSwitchNotice(pending, agent('session-a'), [userMessage()], enter([]))
    expect(reviewed).toEqual({ decision: enter([]), consumed: false })
    expect(pending.has('session-a')).toBe(true)
  })

  it('folds the notice right after the claimed batch and consumes the mark', () => {
    const pending = new Set(['session-a'])
    const first = userMessage('第一句')
    const second = userMessage('第二句')
    const snapshot = pluginMessage('runtime snapshot')
    const decision = enter([first, second, snapshot])
    const reviewed = withSwitchNotice(pending, agent('session-a'), [first, second], decision)

    expect(reviewed.consumed).toBe(true)
    const messages = reviewed.decision.kind === 'enter' ? reviewed.decision.messages : []
    expect(messages).toHaveLength(4)
    expect(messages[0]).toBe(first)
    expect(messages[1]).toBe(second)
    expect(messages[2].source).toMatchObject({ kind: SWITCH_NOTICE_PLUGIN, form: 'notice' })
    expect(messages[2].content).toEqual([{ type: 'text', text: SWITCH_NOTICE_TEXT }])
    expect(messages[3]).toBe(snapshot)
    expect(pending.has('session-a')).toBe(true) // the caller consumes the mark
  })

  it('appends at the end when a downstream decision no longer carries the claimed batch', () => {
    const pending = new Set(['session-a'])
    const rewritten = pluginMessage('rewritten by another listener')
    const decision = enter([rewritten])
    const reviewed = withSwitchNotice(pending, agent('session-a'), [userMessage()], decision)

    expect(reviewed.consumed).toBe(true)
    expect(reviewed.decision.kind).toBe('enter')
    if (reviewed.decision.kind !== 'enter') return
    expect(reviewed.decision.messages).toHaveLength(2)
    expect(reviewed.decision.messages[0]).toBe(rewritten)
    expect(reviewed.decision.messages[1].source).toMatchObject({ kind: SWITCH_NOTICE_PLUGIN, form: 'notice' })
  })

  it('marks sessions per id, not globally', () => {
    const pending = new Set(['session-a'])
    const claimed = [userMessage()]
    const reviewed = withSwitchNotice(pending, agent('session-b'), claimed, enter(claimed))
    expect(reviewed.decision.kind).toBe('enter')
    if (reviewed.decision.kind !== 'enter') return
    expect(reviewed.decision.messages).toEqual(claimed)
    expect(reviewed.consumed).toBe(false)
  })
})
