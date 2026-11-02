import { describe, expect, it } from 'vitest';
import { AgentScheduleCreateInputSchema, AgentScheduleForwardTaskSchema, AgentScheduleTaskSchema, CreateScheduleToolInputSchema, matchesScheduleForward, scheduleExecutionKind, scheduleMayUseLlm } from './agent-schedule.js';

const source = { accountId: 'admin', chatType: 'group', chatId: 'source', title: 'Source' };
const destination = { accountId: 'agent', chatType: 'group', chatId: 'destination', title: 'Destination' };
const task = { type: 'message_forward', match: { mode: 'contains', keywords: ['Urgent'] } };
const input = { title: 'Forward urgent', provider: 'claude', recurrence: { kind: 'message' }, targets: [source], task,
  delivery: { mode: 'line_target', target: destination } };

describe('message forwarding shared App and MCP contracts', () => {
  it('matches original text literally and distinguishes sender MID and source account', () => {
    const source = { accountId: 'admin', senderId: 'u1', text: ' Urgent [a] ' };
    const cases: Array<[unknown, boolean]> = [
      [{ match: { mode: 'contains', keywords: ['missing', '[a]'] } }, true],
      [{ match: { mode: 'contains', keywords: ['urgent'] } }, false],
      [{ match: { mode: 'exact', text: ' Urgent [a] ' } }, true],
      [{ match: { mode: 'exact', text: 'Urgent [a]' } }, false],
      [{ match: { mode: 'sender' }, sender: { accountId: 'admin', mid: 'u1' } }, true],
      [{ match: { mode: 'sender' }, sender: { accountId: 'agent', mid: 'u1' } }, false],
      [{ match: { mode: 'contains', keywords: ['Urgent'] }, sender: { accountId: 'admin', mid: 'u2' } }, false],
    ];
    for (const [value, expected] of cases) expect(matchesScheduleForward(AgentScheduleForwardTaskSchema.parse({ type: 'message_forward', ...(value as object) }), source)).toBe(expected);
  });
  it('accepts literal contains, exact and sender-only with optional sender restrictions', () => {
    for (const match of [{ mode: 'contains', keywords: ['Urgent'] }, { mode: 'exact', text: ' exact ' }, { mode: 'sender' }]) {
      const parsed = AgentScheduleTaskSchema.safeParse({ type: 'message_forward', match,
        sender: { accountId: 'admin', mid: 'u123', label: 'Alice' } });
      expect(parsed.success).toBe(true);
      if (parsed.success) {
        expect(scheduleExecutionKind(parsed.data)).toBe('program');
        expect(scheduleMayUseLlm(parsed.data)).toBe(false);
      }
    }
    expect(AgentScheduleTaskSchema.safeParse(task).success).toBe(true);
  });

  it('requires a nonempty literal condition and stable sender identity', () => {
    for (const invalid of [
      { match: { mode: 'sender' } },
      { match: { mode: 'contains', keywords: ['  '] } },
      { match: { mode: 'exact', text: '' } },
      { match: { mode: 'sender' }, sender: { accountId: 'admin', mid: '', label: 'Alice' } },
      { match: { mode: 'regex', text: '.*' } },
    ]) expect(AgentScheduleTaskSchema.safeParse({ type: 'message_forward', ...invalid }).success).toBe(false);
  });

  it('uses the same event, explicit source and destination validation in App and MCP', () => {
    for (const schema of [AgentScheduleCreateInputSchema, CreateScheduleToolInputSchema]) {
      expect(schema.safeParse(input).success).toBe(true);
      for (const patch of [
        { targets: [] }, { delivery: { mode: 'primary_admin' } }, { recurrence: { kind: 'daily', time: '09:00' } },
        { task: { type: 'message', text: 'hello' } }, { delivery: { mode: 'line_target', target: source } },
      ]) expect(schema.safeParse({ ...input, ...patch }).success).toBe(false);
    }
  });
});
