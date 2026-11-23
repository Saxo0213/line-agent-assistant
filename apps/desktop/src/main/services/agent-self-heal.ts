import type { AgentEvent } from '@line-agent/contracts';

/** Port of CliTalkAgent `self_heal_once` (chat.rs). Decision logic only; AgentService runs the attempts. */

export type FailedAgentEvent = Extract<AgentEvent, { type: 'failed' }>;

/** The failure of a turn that completed with a blank reply (CliTalkAgent: a blank reply is a failed attempt). */
export const EMPTY_REPLY_CODE = 'EMPTY_REPLY';
export const EMPTY_REPLY_MESSAGE = 'The CLI returned an empty reply.';
/** Detail of the failed event of a job that failed after the self-heal attempt. */
export const AFTER_SELF_HEAL_DETAIL = 'after_self_heal';

/** Stop codes: the user reached a limit or must sign in. A new process cannot change this. */
const STOP_CODES: ReadonlySet<string> = new Set(['PROVIDER_LIMIT', 'AUTH_REQUIRED']);
/** Codes of a run that did not start, or that was stopped on purpose. A second attempt would not change the result. */
const NO_HEAL_CODES: ReadonlySet<string> = new Set([
  'CANCELLATION_FAILED', 'NOT_INSTALLED', 'ATTACHMENT_MISSING', 'DUPLICATE_JOB', 'BRIDGE_ERROR', 'ACCOUNT_NOT_LOGGED_IN',
]);
const NO_HEAL_PREFIXES: readonly string[] = ['AGENT_', 'INVALID_'];

export type SelfHealDecision =
  | { heal: true }
  | { heal: false; reason: 'stop_code' | 'no_heal_code' | 'deadline' | 'line_send_committed' | 'line_send_unknown' };

export interface SelfHealContext {
  /** True when the deadline backstop of AgentService fired. */
  deadlineExceeded: boolean;
  /**
   * The number of committed LINE sends of the job (decision D1).
   * `undefined`: the check is not available. `'error'`: the check threw. Both stop the heal, because a replay could send twice.
   */
  committedLineSends: number | undefined | 'error';
}

/** True when a completed event has no text after trim. */
export function isBlankCompletion(event: AgentEvent): boolean {
  return event.type === 'completed' && event.finalText.trim() === '';
}

/** The failed event for a blank reply. */
export function emptyReplyFailure(): FailedAgentEvent {
  return { type: 'failed', code: EMPTY_REPLY_CODE, message: EMPTY_REPLY_MESSAGE, retryable: false };
}

/** Decides whether the failure of attempt 1 gets one more attempt. A cancelled event is never a failure and never reaches this function. */
export function decideSelfHeal(failure: Pick<FailedAgentEvent, 'code'>, context: SelfHealContext): SelfHealDecision {
  if (STOP_CODES.has(failure.code)) return { heal: false, reason: 'stop_code' };
  if (NO_HEAL_CODES.has(failure.code) || NO_HEAL_PREFIXES.some((prefix) => failure.code.startsWith(prefix))) {
    return { heal: false, reason: 'no_heal_code' };
  }
  if (context.deadlineExceeded) return { heal: false, reason: 'deadline' };
  if (context.committedLineSends === undefined || context.committedLineSends === 'error') return { heal: false, reason: 'line_send_unknown' };
  if (context.committedLineSends > 0) return { heal: false, reason: 'line_send_committed' };
  return { heal: true };
}

/** True when the decision needs the LINE send count: every code check passed. */
export function needsLineSendCheck(failure: Pick<FailedAgentEvent, 'code'>): boolean {
  return decideSelfHeal(failure, { deadlineExceeded: false, committedLineSends: 0 }).heal;
}

/** The failed event of the final attempt of a healed job: it gets the detail when it has none. */
export function markAfterSelfHeal(event: FailedAgentEvent): FailedAgentEvent {
  return event.detail === undefined ? { ...event, detail: AFTER_SELF_HEAL_DETAIL } : event;
}
