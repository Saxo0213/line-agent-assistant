import { describe, expect, it } from 'vitest';
import { AFTER_SELF_HEAL_DETAIL, decideSelfHeal, emptyReplyFailure, isBlankCompletion, markAfterSelfHeal, needsLineSendCheck } from './agent-self-heal.js';

const open = { deadlineExceeded: false, committedLineSends: 0 as const };

describe('self-heal decision', () => {
  it.each(['CLI_EXIT', 'TIMEOUT', 'TURN_STALLED', 'EMPTY_REPLY', 'MISSING_TERMINAL', 'PROVIDER_FAILED', 'CLI_IO'])('heals %s', (code) => {
    expect(decideSelfHeal({ code }, open)).toEqual({ heal: true });
  });
  it.each(['PROVIDER_LIMIT', 'AUTH_REQUIRED'])('stops at %s', (code) => {
    expect(decideSelfHeal({ code }, open)).toEqual({ heal: false, reason: 'stop_code' });
  });
  it.each(['CANCELLATION_FAILED', 'NOT_INSTALLED', 'ATTACHMENT_MISSING', 'DUPLICATE_JOB', 'BRIDGE_ERROR',
    'AGENT_DISABLED', 'AGENT_X', 'INVALID_SESSION', 'INVALID_WORKSPACE', 'INVALID_REQUEST'])('does not heal %s', (code) => {
    expect(decideSelfHeal({ code }, open)).toEqual({ heal: false, reason: 'no_heal_code' });
  });
  it('does not heal after the deadline backstop', () => {
    expect(decideSelfHeal({ code: 'CLI_EXIT' }, { ...open, deadlineExceeded: true })).toEqual({ heal: false, reason: 'deadline' });
  });
  it('D1: does not heal when the job has a committed LINE send', () => {
    expect(decideSelfHeal({ code: 'CLI_EXIT' }, { deadlineExceeded: false, committedLineSends: 1 })).toEqual({ heal: false, reason: 'line_send_committed' });
  });
  it('D1: does not heal when the send check is missing or failed', () => {
    expect(decideSelfHeal({ code: 'CLI_EXIT' }, { deadlineExceeded: false, committedLineSends: undefined }).heal).toBe(false);
    expect(decideSelfHeal({ code: 'CLI_EXIT' }, { deadlineExceeded: false, committedLineSends: 'error' }).heal).toBe(false);
  });
  it('asks for the send count only when the code rules allow a heal', () => {
    expect(needsLineSendCheck({ code: 'CLI_EXIT' })).toBe(true);
    expect(needsLineSendCheck({ code: 'PROVIDER_LIMIT' })).toBe(false);
    expect(needsLineSendCheck({ code: 'INVALID_SESSION' })).toBe(false);
  });
  it('treats a blank completion as EMPTY_REPLY', () => {
    expect(isBlankCompletion({ type: 'completed', finalText: ' \n\t' })).toBe(true);
    expect(isBlankCompletion({ type: 'completed', finalText: 'ok' })).toBe(false);
    expect(isBlankCompletion({ type: 'failed', code: 'X', message: 'm', retryable: false })).toBe(false);
    expect(emptyReplyFailure()).toMatchObject({ type: 'failed', code: 'EMPTY_REPLY', message: 'The CLI returned an empty reply.' });
  });
  it('marks the final failure after a heal only when it has no detail', () => {
    const base = { type: 'failed' as const, code: 'CLI_EXIT', message: 'm', retryable: false };
    expect(markAfterSelfHeal(base).detail).toBe(AFTER_SELF_HEAL_DETAIL);
    expect(markAfterSelfHeal({ ...base, detail: 'other' }).detail).toBe('other');
  });
});
