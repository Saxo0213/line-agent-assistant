import { describe, expect, it } from 'vitest';
import {
  AGENT_SCHEDULE_JITTER_MAX_MINUTES,
  AgentScheduleCreateInputSchema,
  AgentScheduleDeliverySchema,
  AgentScheduleTaskSchema,
  AgentScheduleUpdatePatchSchema,
  AgentScheduleWindowSchema,
  AgentScheduleRunOutcomeSchema,
  CreateScheduleToolInputSchema,
  ListSchedulesToolInputSchema,
  agentScheduleShapeError,
  resolveScheduleMessagePlaceholders,
  AgentScheduleRecurrenceSchema,
  McpInternalToolNameSchema,
  McpToolNameSchema,
  SCHEDULE_TOOL_NAMES,
  nextFireAfter,
  validateCron,
  type AgentScheduleRecurrence,
} from './index.js';

const TPE = 'Asia/Taipei';
const next = (recurrence: AgentScheduleRecurrence, after: string, tz = TPE) => nextFireAfter(recurrence, tz, new Date(after))?.toISOString() ?? null;

describe('nextFireAfter', () => {
  it('once returns at only while it is in the future', () => {
    const once = { kind: 'once', at: '2026-10-01T03:00:00.000Z' } as const;
    expect(next(once, '2026-10-01T02:59:59Z')).toBe('2026-10-01T03:00:00.000Z');
    expect(next(once, '2026-10-01T03:00:00Z')).toBeNull();
  });

  it('daily uses the schedule timezone (Asia/Taipei is UTC+8)', () => {
    const daily = { kind: 'daily', time: '09:00' } as const;
    expect(next(daily, '2026-10-01T00:59:59Z')).toBe('2026-10-01T01:00:00.000Z');
    expect(next(daily, '2026-10-01T01:00:00Z')).toBe('2026-10-02T01:00:00.000Z');
    // 17:30 UTC is already 01:30 the next local day.
    expect(next(daily, '2026-10-01T17:30:00Z')).toBe('2026-10-02T01:00:00.000Z');
    expect(next(daily, '2026-10-01T00:00:00Z', 'UTC')).toBe('2026-10-01T09:00:00.000Z');
  });

  it('weekly picks the next listed day and wraps across the week', () => {
    // 2026-10-01 is a Thursday (4) in Taipei.
    const weekly = { kind: 'weekly', days: [1, 5], time: '08:00' } as const;
    expect(next(weekly, '2026-10-01T00:00:00Z')).toBe('2026-10-02T00:00:00.000Z');
    // Friday 08:00 passed: wraps to Monday 2026-10-05.
    expect(next(weekly, '2026-10-02T00:00:00Z')).toBe('2026-10-05T00:00:00.000Z');
    expect(next({ kind: 'weekly', days: [0], time: '23:59' }, '2026-10-04T15:59:00Z')).toBe('2026-10-11T15:59:00.000Z');
  });

  it('interval counts from the anchor and never fires on or before `after`', () => {
    const interval = { kind: 'interval', everyMinutes: 30, anchorAt: '2026-10-01T00:10:00.000Z' } as const;
    expect(next(interval, '2026-09-30T00:00:00Z')).toBe('2026-10-01T00:10:00.000Z');
    expect(next(interval, '2026-10-01T00:10:00Z')).toBe('2026-10-01T00:40:00.000Z');
    expect(next(interval, '2026-10-01T05:41:00Z')).toBe('2026-10-01T06:10:00.000Z');
  });

  it('cron supports steps, ranges and lists', () => {
    expect(next({ kind: 'cron', expression: '*/15 * * * *' }, '2026-10-01T00:07:00Z')).toBe('2026-10-01T00:15:00.000Z');
    expect(next({ kind: 'cron', expression: '0 9-17/4 * * *' }, '2026-10-01T02:00:00Z', 'UTC')).toBe('2026-10-01T09:00:00.000Z');
    expect(next({ kind: 'cron', expression: '0 9-17/4 * * *' }, '2026-10-01T09:00:00Z', 'UTC')).toBe('2026-10-01T13:00:00.000Z');
    expect(next({ kind: 'cron', expression: '5,35 8 * * *' }, '2026-10-01T00:06:00Z')).toBe('2026-10-01T00:35:00.000Z');
    expect(next({ kind: 'cron', expression: '30 6 1 */3 *' }, '2026-10-02T00:00:00Z', 'UTC')).toBe('2027-01-01T06:30:00.000Z');
    // Taipei offset: 00:00 local on weekdays only.
    expect(next({ kind: 'cron', expression: '0 0 * * 1-5' }, '2026-10-02T16:00:00Z')).toBe('2026-10-04T16:00:00.000Z');
  });

  it('cron day-of-month and day-of-week use OR when both are restricted', () => {
    // 2026-10-01 is a Thursday. "1st OR Friday": Friday 10-02 comes before 11-01.
    const orRule = { kind: 'cron', expression: '0 12 1 * 5' } as const;
    expect(next(orRule, '2026-10-01T12:00:00Z', 'UTC')).toBe('2026-10-02T12:00:00.000Z');
    expect(next(orRule, '2026-10-23T12:00:00Z', 'UTC')).toBe('2026-10-30T12:00:00.000Z');
    expect(next(orRule, '2026-10-30T12:00:00Z', 'UTC')).toBe('2026-11-01T12:00:00.000Z');
    // Only day-of-month restricted: the wildcard day-of-week does not widen it.
    expect(next({ kind: 'cron', expression: '0 12 15 * *' }, '2026-10-01T00:00:00Z', 'UTC')).toBe('2026-10-15T12:00:00.000Z');
    // 7 is Sunday.
    expect(next({ kind: 'cron', expression: '0 12 * * 7' }, '2026-10-01T00:00:00Z', 'UTC')).toBe('2026-10-04T12:00:00.000Z');
  });

  it('returns null for a cron that cannot match within a year', () => {
    expect(next({ kind: 'cron', expression: '0 0 31 2 *' }, '2026-01-01T00:00:00Z', 'UTC')).toBeNull();
  });

  it('does not crash on DST zones and stays strictly increasing', () => {
    const daily = { kind: 'daily', time: '02:30' } as const;
    let cursor = new Date('2026-03-07T00:00:00Z');
    for (let i = 0; i < 6; i++) {
      const found = nextFireAfter(daily, 'America/New_York', cursor);
      expect(found).not.toBeNull();
      expect(found!.getTime()).toBeGreaterThan(cursor.getTime());
      cursor = found!;
    }
    // Ordinary day: 09:00 New York in winter is 14:00 UTC, in summer 13:00 UTC.
    expect(next({ kind: 'daily', time: '09:00' }, '2026-01-10T00:00:00Z', 'America/New_York')).toBe('2026-01-10T14:00:00.000Z');
    expect(next({ kind: 'daily', time: '09:00' }, '2026-07-10T00:00:00Z', 'America/New_York')).toBe('2026-07-10T13:00:00.000Z');
  });
});

describe('schedule validation', () => {
  it('validateCron accepts valid expressions and rejects malformed ones', () => {
    expect(validateCron('*/5 0-6 1,15 * 1-5').valid).toBe(true);
    for (const bad of ['', '* * * *', '* * * * * *', '60 * * * *', '* 24 * * *', '* * 0 * *', '* * * 13 *', '*/0 * * * *', '5-1 * * * *', 'a * * * *', '1,,2 * * * *', '* * * * 8']) {
      expect(validateCron(bad).valid, bad).toBe(false);
    }
  });

  it('rejects intervals under 5 minutes, bad times, days and cron', () => {
    const anchorAt = '2026-10-01T00:00:00.000Z';
    expect(AgentScheduleRecurrenceSchema.safeParse({ kind: 'interval', everyMinutes: 4, anchorAt }).success).toBe(false);
    expect(AgentScheduleRecurrenceSchema.safeParse({ kind: 'interval', everyMinutes: 5, anchorAt }).success).toBe(true);
    expect(AgentScheduleRecurrenceSchema.safeParse({ kind: 'interval', everyMinutes: 10_081, anchorAt }).success).toBe(false);
    expect(AgentScheduleRecurrenceSchema.safeParse({ kind: 'daily', time: '24:00' }).success).toBe(false);
    expect(AgentScheduleRecurrenceSchema.safeParse({ kind: 'weekly', days: [], time: '09:00' }).success).toBe(false);
    expect(AgentScheduleRecurrenceSchema.safeParse({ kind: 'weekly', days: [1, 1], time: '09:00' }).success).toBe(false);
    expect(AgentScheduleRecurrenceSchema.safeParse({ kind: 'weekly', days: [7], time: '09:00' }).success).toBe(false);
    expect(AgentScheduleRecurrenceSchema.safeParse({ kind: 'cron', expression: '* * *' }).success).toBe(false);
    expect(AgentScheduleRecurrenceSchema.safeParse({ kind: 'once', at: 'tomorrow' }).success).toBe(false);
  });

  it('create input defaults timezone and enabled and bounds text', () => {
    const parsed = AgentScheduleCreateInputSchema.parse({ title: 'A', prompt: 'B', provider: 'claude', recurrence: { kind: 'daily', time: '08:00' } });
    expect(parsed).toMatchObject({ timezone: 'Asia/Taipei', enabled: true });
    const base = { prompt: 'B', provider: 'claude', recurrence: { kind: 'daily', time: '08:00' } };
    expect(AgentScheduleCreateInputSchema.safeParse({ ...base, title: 'x'.repeat(81) }).success).toBe(false);
    expect(AgentScheduleCreateInputSchema.safeParse({ ...base, title: 'A', prompt: 'x'.repeat(4001) }).success).toBe(false);
    expect(AgentScheduleCreateInputSchema.safeParse({ ...base, title: 'A', timezone: 'Mars/Base' }).success).toBe(false);
  });

  it('jitterMinutes accepts integers 0..5, defaults to 0 on create and is optional on update and the tools', () => {
    expect(AGENT_SCHEDULE_JITTER_MAX_MINUTES).toBe(5);
    const base = { title: 'A', prompt: 'B', provider: 'claude', recurrence: { kind: 'daily', time: '08:00' } };
    expect(AgentScheduleCreateInputSchema.parse(base).jitterMinutes).toBe(0);
    for (const ok of [0, 1, 5]) expect(AgentScheduleCreateInputSchema.parse({ ...base, jitterMinutes: ok }).jitterMinutes).toBe(ok);
    for (const bad of [6, -1, 1.5, '3', null]) expect(AgentScheduleCreateInputSchema.safeParse({ ...base, jitterMinutes: bad }).success).toBe(false);
    expect(AgentScheduleUpdatePatchSchema.parse({ jitterMinutes: 3 })).toEqual({ jitterMinutes: 3 });
    expect(AgentScheduleUpdatePatchSchema.safeParse({ jitterMinutes: 6 }).success).toBe(false);
    expect(CreateScheduleToolInputSchema.parse({ ...base, jitterMinutes: 2 }).jitterMinutes).toBe(2);
    expect(CreateScheduleToolInputSchema.safeParse({ ...base, jitterMinutes: 9 }).success).toBe(false);
  });

  it('schedule tools are internal-only', () => {
    for (const name of SCHEDULE_TOOL_NAMES) {
      expect(McpToolNameSchema.safeParse(name).success).toBe(false);
      expect(McpInternalToolNameSchema.safeParse(name).success).toBe(true);
    }
  });
});

describe('task, window, delivery and targets', () => {
  const target = (chatId: string) => ({ accountId: 'acc', chatType: 'group' as const, chatId, title: chatId });
  const base = { title: 'T', provider: 'claude' as const, recurrence: { kind: 'daily' as const, time: '08:00' } };

  it('validates every task variant', () => {
    expect(AgentScheduleTaskSchema.safeParse({ type: 'custom' }).success).toBe(true);
    expect(AgentScheduleTaskSchema.safeParse({ type: 'summary' }).success).toBe(true);
    expect(AgentScheduleTaskSchema.safeParse({ type: 'summary', focus: 'x'.repeat(500) }).success).toBe(true);
    expect(AgentScheduleTaskSchema.safeParse({ type: 'summary', focus: 'x'.repeat(501) }).success).toBe(false);
    expect(AgentScheduleTaskSchema.safeParse({ type: 'keyword_digest', keywords: ['a'] }).success).toBe(true);
    expect(AgentScheduleTaskSchema.safeParse({ type: 'keyword_digest', keywords: [] }).success).toBe(false);
    expect(AgentScheduleTaskSchema.safeParse({ type: 'keyword_digest', keywords: Array.from({ length: 21 }, (_, i) => `k${i}`) }).success).toBe(false);
    expect(AgentScheduleTaskSchema.safeParse({ type: 'keyword_digest', keywords: ['x'.repeat(51)] }).success).toBe(false);
    expect(AgentScheduleTaskSchema.safeParse({ type: 'other' }).success).toBe(false);
  });

  it('validates window and delivery', () => {
    expect(AgentScheduleWindowSchema.safeParse({ mode: 'since_last_run' }).success).toBe(true);
    expect(AgentScheduleWindowSchema.safeParse({ mode: 'lookback', minutes: 5 }).success).toBe(true);
    expect(AgentScheduleWindowSchema.safeParse({ mode: 'lookback', minutes: 4 }).success).toBe(false);
    expect(AgentScheduleWindowSchema.safeParse({ mode: 'lookback', minutes: 10_081 }).success).toBe(false);
    expect(AgentScheduleDeliverySchema.safeParse({ mode: 'record_only' }).success).toBe(true);
    expect(AgentScheduleDeliverySchema.safeParse({ mode: 'agent_room' }).success).toBe(false);
    expect(AgentScheduleDeliverySchema.safeParse({ mode: 'line_target', target: target('g1') }).success).toBe(true);
    expect(AgentScheduleDeliverySchema.safeParse({ mode: 'line_target', target: { ...target('g1'), chatType: 'community' } }).success).toBe(false);
    expect(AgentScheduleDeliverySchema.safeParse({ mode: 'line_target' }).success).toBe(false);
  });

  it('applies defaults and the cross-field rules on create', () => {
    const custom = AgentScheduleCreateInputSchema.parse({ ...base, prompt: 'do it' });
    expect(custom).toMatchObject({ targets: [], task: { type: 'custom' }, window: { mode: 'since_last_run' }, delivery: { mode: 'primary_admin' } });
    expect(AgentScheduleCreateInputSchema.safeParse({ ...base }).success).toBe(false);
    expect(AgentScheduleCreateInputSchema.safeParse({ ...base, task: { type: 'summary' } }).success).toBe(false);
    expect(AgentScheduleCreateInputSchema.safeParse({ ...base, task: { type: 'summary' }, targets: [target('g1')] }).success).toBe(true);
    expect(AgentScheduleCreateInputSchema.safeParse({ ...base, task: { type: 'keyword_digest', keywords: ['k'] }, targets: [target('g1')], prompt: '' }).success).toBe(true);
    expect(AgentScheduleCreateInputSchema.safeParse({ ...base, task: { type: 'summary' }, targets: [target('g1'), target('g1')] }).success).toBe(false);
    expect(AgentScheduleCreateInputSchema.safeParse({ ...base, prompt: 'x', targets: Array.from({ length: 21 }, (_, i) => target(`g${i}`)) }).success).toBe(false);
    expect(AgentScheduleCreateInputSchema.safeParse({ ...base, prompt: 'x'.repeat(4001) }).success).toBe(false);
  });

  it('accepts the new fields in update patches and MCP tool input', () => {
    expect(AgentScheduleUpdatePatchSchema.safeParse({ window: { mode: 'lookback', minutes: 60 } }).success).toBe(true);
    expect(AgentScheduleUpdatePatchSchema.safeParse({ delivery: { mode: 'line_target', target: target('g') } }).success).toBe(true);
    expect(AgentScheduleUpdatePatchSchema.safeParse({}).success).toBe(false);
    const tool = { title: 'T', recurrence: base.recurrence, task: { type: 'summary' }, targets: [{ accountId: 'a', chatType: 'direct', chatId: 'u1' }] };
    expect(CreateScheduleToolInputSchema.safeParse(tool).success).toBe(true);
    expect(CreateScheduleToolInputSchema.safeParse({ ...tool, targets: [] }).success).toBe(false);
    expect(CreateScheduleToolInputSchema.safeParse({ title: 'T', recurrence: base.recurrence }).success).toBe(false);
  });
});

describe('read targets, delivery and tool input', () => {
  const chat = (chatType: string) => ({ accountId: 'a', chatType, chatId: 'c1' });
  const daily = { kind: 'daily', time: '09:00' } as const;

  it('read targets accept communities and threads; delivery targets reject them', () => {
    for (const chatType of ['direct', 'group', 'room', 'community', 'thread']) {
      expect(AgentScheduleCreateInputSchema.safeParse({ title: 't', provider: 'claude', recurrence: daily, task: { type: 'summary' }, targets: [chat(chatType)] }).success, chatType).toBe(true);
    }
    expect(AgentScheduleDeliverySchema.safeParse({ mode: 'line_target', target: chat('group') }).success).toBe(true);
    expect(AgentScheduleDeliverySchema.safeParse({ mode: 'line_target', target: chat('community') }).success).toBe(false);
    expect(AgentScheduleDeliverySchema.safeParse({ mode: 'line_target', target: chat('thread') }).success).toBe(false);
  });

  it('primary_admin parses and is the create default', () => {
    expect(AgentScheduleDeliverySchema.parse({ mode: 'primary_admin' })).toEqual({ mode: 'primary_admin' });
    expect(AgentScheduleDeliverySchema.safeParse({ mode: 'primary_admin', extra: 1 }).success).toBe(false);
    const created = AgentScheduleCreateInputSchema.parse({ title: 't', prompt: 'p', provider: 'claude', recurrence: daily });
    expect(created.delivery).toEqual({ mode: 'primary_admin' });
  });

  it('the tool accepts once.inMinutes within 1..10080 and a summary default for targets without a task', () => {
    const parse = (recurrence: unknown) => CreateScheduleToolInputSchema.safeParse({ title: 't', prompt: 'p', recurrence }).success;
    expect(parse({ kind: 'once', inMinutes: 1 })).toBe(true);
    expect(parse({ kind: 'once', inMinutes: 10_080 })).toBe(true);
    expect(parse({ kind: 'once', inMinutes: 0 })).toBe(false);
    expect(parse({ kind: 'once', inMinutes: 10_081 })).toBe(false);
    expect(parse({ kind: 'once', inMinutes: 1.5 })).toBe(false);
    expect(parse({ kind: 'once', at: '2026-10-01T00:00:00Z', inMinutes: 5 })).toBe(false);
    expect(parse({ kind: 'once', at: '2026-10-01T00:00:00Z' })).toBe(true);
    expect(CreateScheduleToolInputSchema.safeParse({ title: 't', recurrence: { kind: 'once', inMinutes: 5 }, targets: [chat('community')] }).success).toBe(true);
    expect(CreateScheduleToolInputSchema.safeParse({ title: 't', recurrence: { kind: 'once', inMinutes: 5 } }).success).toBe(false);
  });
});

describe('system message schedules', () => {
  const base = { title: 'alarm', recurrence: { kind: 'daily', time: '07:00' }, provider: 'claude' } as const;

  it('accepts a message task of 1..5000 characters and nothing else on it', () => {
    expect(AgentScheduleTaskSchema.safeParse({ type: 'message', text: '起床了' }).success).toBe(true);
    expect(AgentScheduleTaskSchema.safeParse({ type: 'message', text: '  ' }).success).toBe(false);
    expect(AgentScheduleTaskSchema.safeParse({ type: 'message', text: 'x'.repeat(5000) }).success).toBe(true);
    expect(AgentScheduleTaskSchema.safeParse({ type: 'message', text: 'x'.repeat(5001) }).success).toBe(false);
    expect(AgentScheduleTaskSchema.safeParse({ type: 'message' }).success).toBe(false);
    expect(AgentScheduleTaskSchema.safeParse({ type: 'message', text: 'x', focus: 'y' }).success).toBe(false);
  });

  it('record_only replaces agent_room and a message cannot use it, read chats or need a prompt', () => {
    expect(AgentScheduleDeliverySchema.safeParse({ mode: 'record_only' }).success).toBe(true);
    expect(AgentScheduleDeliverySchema.safeParse({ mode: 'agent_room' }).success).toBe(false);
    const ok = AgentScheduleCreateInputSchema.safeParse({ ...base, task: { type: 'message', text: 'hi' } });
    expect(ok.success).toBe(true);
    if (ok.success) expect(ok.data).toMatchObject({ prompt: '', targets: [], delivery: { mode: 'primary_admin' } });
    expect(AgentScheduleCreateInputSchema.safeParse({ ...base, task: { type: 'message', text: 'hi' }, delivery: { mode: 'record_only' } }).success).toBe(false);
    expect(AgentScheduleCreateInputSchema.safeParse({ ...base, task: { type: 'message', text: 'hi' }, delivery: { mode: 'agent_room' } }).success).toBe(false);
    expect(AgentScheduleCreateInputSchema.safeParse({ ...base, task: { type: 'message', text: 'hi' },
      targets: [{ accountId: 'a', chatType: 'group', chatId: 'g', title: 't' }] }).success).toBe(false);
    expect(AgentScheduleCreateInputSchema.safeParse({ ...base, task: { type: 'custom' }, prompt: 'p', delivery: { mode: 'record_only' } }).success).toBe(true);
    expect(agentScheduleShapeError({ prompt: '', targets: [], task: { type: 'message', text: 'x' }, delivery: { mode: 'record_only' } })).toMatch(/LINE/);
    expect(agentScheduleShapeError({ prompt: '', targets: [], task: { type: 'message', text: 'x' }, delivery: { mode: 'primary_admin' } })).toBeNull();
  });

  it('the create tool takes a message task and rejects agent_room and record_only for it', () => {
    const tool = { title: 'alarm', recurrence: { kind: 'once', inMinutes: 5 }, task: { type: 'message', text: '時間到' } };
    expect(CreateScheduleToolInputSchema.safeParse(tool).success).toBe(true);
    expect(CreateScheduleToolInputSchema.safeParse({ ...tool, delivery: { mode: 'record_only' } }).success).toBe(false);
    expect(CreateScheduleToolInputSchema.safeParse({ ...tool, delivery: { mode: 'agent_room' } }).success).toBe(false);
    expect(CreateScheduleToolInputSchema.safeParse({ title: 't', prompt: 'p', recurrence: { kind: 'once', inMinutes: 5 }, delivery: { mode: 'record_only' } }).success).toBe(true);
  });

  it('run outcomes include sent, send_failed and send_unknown', () => {
    for (const outcome of ['sent', 'send_failed', 'send_unknown', 'submitted', 'skipped_overlap']) expect(AgentScheduleRunOutcomeSchema.safeParse(outcome).success).toBe(true);
    expect(AgentScheduleRunOutcomeSchema.safeParse('agent_room').success).toBe(false);
  });

  it('fills {{date}}, {{time}} and {{weekday}} in Asia/Taipei', () => {
    // 2026-10-04T16:30:00Z is Monday 2026-10-05 00:30 in Taipei.
    const at = new Date('2026-10-04T16:30:00Z');
    expect(resolveScheduleMessagePlaceholders('{{date}} {{time}} {{weekday}} | {{date}}', at)).toBe('2026-10-05 00:30 星期一 | 2026-10-05');
    expect(resolveScheduleMessagePlaceholders('{{unknown}} {date} plain', at)).toBe('{{unknown}} {date} plain');
    expect(resolveScheduleMessagePlaceholders('{{weekday}}', new Date('2026-10-04T04:00:00Z'))).toBe('星期日');
    expect(resolveScheduleMessagePlaceholders('{{weekday}}', new Date('2026-10-03T04:00:00Z'))).toBe('星期六');
    expect(resolveScheduleMessagePlaceholders('{{time}}', new Date('2026-10-01T15:59:00Z'))).toBe('23:59');
  });
});

describe('ListSchedulesToolInputSchema', () => {
  it('defaults to active and accepts only known statuses', () => {
    expect(ListSchedulesToolInputSchema.parse({}).status).toBe('active');
    for (const status of ['active', 'disabled', 'all']) expect(ListSchedulesToolInputSchema.parse({ status }).status).toBe(status);
    expect(ListSchedulesToolInputSchema.safeParse({ status: 'bogus' }).success).toBe(false);
    expect(ListSchedulesToolInputSchema.safeParse({ extra: 1 }).success).toBe(false);
  });
});
