/**
 * Switch-notice injection: the first user chat in a session whose log this
 * machine just extended from the sync repo gets one plugin-attributed notice
 * telling the model that the history came from another machine and that the
 * local working directory is authoritative from here on.
 *
 * The notice follows the agent-instructions pattern: it is a durable
 * `user/message` folded right after the claimed batch in the pre-step
 * waterfall, so the direct prompt precedes it and the driver-appended runtime
 * context follows it. Because it is durable, every later turn on the same
 * machine sees it in history — the "以本机为准" stance persists — and the
 * one-shot mark (armed per imported session by the engine, consumed here)
 * guarantees the same machine never injects it again. The message is
 * machine-neutral on purpose: it travels with the log through git like any
 * other event, and the machine that imports it later arms its own notice
 * for its own first chat.
 * @module @linbin-mk/dsh-session-sync/switch-notice
 */

import type { Agent, PreStepDecision } from '@deepseek-ai/dsh-agent'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { UserMessage } from '@deepseek-ai/dsh-session'

/** Plugin attribution of the injected notice (source kind `plugin`). */
export const SWITCH_NOTICE_PLUGIN = 'session-sync'

/**
 * Model-facing notice injected on the first chat after a machine switch.
 * Deliberately machine-neutral: it names no absolute path, because the
 * harness already tells the model the current working directory in every
 * turn's runtime context, and the message itself syncs to the repo verbatim.
 */
export const SWITCH_NOTICE_TEXT = '本会话的历史记录是从另一台电脑经会话同步导入的：'
  + '历史消息中出现的文件路径与目录结构以那台电脑为准，可能与当前电脑不一致。'
  + '请以当前运行环境所提供的工作目录（cwd）和本机文件系统的实际状态为准；'
  + '涉及历史路径时先在本机核实其是否存在。后续请始终以本机为准继续工作。'

/** One-line transcript-row summary of the notice (well under the 120-char bound). */
export const SWITCH_NOTICE_SUMMARY = '会话已切换到本机：路径以本机工作目录为准'

/** Build the durable switch-notice message (plugin source, `notice` form). */
export function createSwitchNoticeMessage(): UserMessage {
  return createUserMessage({
    content: [{ type: 'text', text: SWITCH_NOTICE_TEXT }],
    source: {
      kind: 'plugin',
      plugin: SWITCH_NOTICE_PLUGIN,
      form: 'notice',
      summary: SWITCH_NOTICE_SUMMARY,
    },
  })
}

/** Outcome of one pre-step decision review. */
export interface SwitchNoticeDecision {
  /** The decision to return from the pre-step listener. */
  decision: PreStepDecision
  /** Whether the notice was injected (and the one-shot mark should be consumed). */
  consumed: boolean
}

/**
 * Inject the switch notice into a pre-step decision when the session carries
 * a pending mark (imported from the repo) and the claimed batch holds a real
 * user message — the first chat after the machine switch. Non-user activity
 * (wakes, tool continuations) neither injects nor consumes the mark, and a
 * decision another listener emptied is left untouched so the notice cannot
 * fabricate a model turn on its own.
 * @param pending - session ids this machine imported and has not noticed yet.
 * @param agent - the agent driving the session.
 * @param claimed - this step's claimed messages (the payload's `messages`).
 * @param decision - the post-waterfall decision of this pre-step.
 * @returns the possibly-updated decision and whether the mark was consumed.
 */
export function withSwitchNotice(
  pending: ReadonlySet<string>,
  agent: Agent,
  claimed: readonly UserMessage[],
  decision: PreStepDecision,
): SwitchNoticeDecision {
  if (decision.kind === 'reject' || decision.messages.length === 0) return { decision, consumed: false }
  if (!pending.has(String(agent.session.id))) return { decision, consumed: false }
  if (!claimed.some(message => message.source.kind === 'user')) return { decision, consumed: false }
  const notice = createSwitchNoticeMessage()
  const lastClaimedIndex = decision.messages.findLastIndex(message => claimed.includes(message))
  const entered = lastClaimedIndex === -1
    ? [...decision.messages, notice]
    : decision.messages.toSpliced(lastClaimedIndex + 1, 0, notice)
  return { decision: { kind: 'enter', messages: entered }, consumed: true }
}
