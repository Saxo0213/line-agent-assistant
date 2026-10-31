import { describe, expect, it } from 'vitest';
import {
  AGENT_SCHEDULE_MESSAGE_DIRECTIONS,
  AGENT_SCHEDULE_MESSAGE_KINDS,
  AgentScheduleCreateInputSchema,
  AgentSchedulePreviewNewMessagesInputSchema,
  AgentScheduleRunOutcomeSchema,
  AgentScheduleSchema,
  AgentScheduleTaskSchema,
  CreateScheduleToolInputSchema,
  agentScheduleShapeError,
  countScheduleLeaves,
  scheduleExecutionKind,
  scheduleMayUseLlm,
  type AgentScheduleTask,
} from './agent-schedule.js';
import { IpcRequestSchema } from './ipc.js';
import { McpMessageDirectionSchema, McpMessageKindSchema } from './mcp.js';

const parse = (task: unknown) => AgentScheduleTaskSchema.safeParse(task);
const ok = (task: unknown) => parse(task).success;
const num = (metric: string, op = '>', value = 1) => ({ metric, op, value });
const messageLeaf = { metric: 'message.direction', op: '==', value: 'inbound' };
const recurrence = { kind: 'daily', time: '09:00' } as const;

describe('new_messages task schema', () => {
  it('applies the defaults and accepts the empty task', () => {
    expect(parse({ type: 'new_messages' }).data).toEqual({ type: 'new_messages', maxMessagesPerChat: 20, maxTextChars: 200, sendWhenEmpty: false });
  });

  it('keeps the message kinds and directions equal to the MCP values', () => {
    expect([...AGENT_SCHEDULE_MESSAGE_KINDS]).toEqual(McpMessageKindSchema.options);
    expect([...AGENT_SCHEDULE_MESSAGE_DIRECTIONS]).toEqual(McpMessageDirectionSchema.options);
  });

  it('limits maxMessagesPerChat to 1..200, maxTextChars to 20..2000 and rejects unknown fields', () => {
    for (const value of [1, 200]) expect(ok({ type: 'new_messages', maxMessagesPerChat: value })).toBe(true);
    for (const value of [0, 201, 1.5]) expect(ok({ type: 'new_messages', maxMessagesPerChat: value })).toBe(false);
    for (const value of [20, 2000]) expect(ok({ type: 'new_messages', maxTextChars: value })).toBe(true);
    for (const value of [19, 2001]) expect(ok({ type: 'new_messages', maxTextChars: value })).toBe(false);
    expect(ok({ type: 'new_messages', sendWhenEmpty: 'yes' })).toBe(false);
    expect(ok({ type: 'new_messages', extra: true })).toBe(false);
    expect(ok({ type: 'new_messages', rules: [{ when: num('chat.messageCount'), then: 'list', extra: 1 }] })).toBe(false);
  });

  it('accepts every number metric with every op and a non-negative integer value only', () => {
    for (const metric of ['chat.messageCount', 'chat.senderCount', 'chat.textChars', 'run.messageCount', 'run.chatCount', 'run.listedChars']) {
      for (const op of ['>', '>=', '<', '<=', '==', '!=']) expect(ok({ type: 'new_messages', rules: [{ when: num(metric, op, 0), then: 'skip' }] })).toBe(true);
      for (const op of ['in', 'not_in', 'any_of', '=', '=>']) expect(ok({ type: 'new_messages', rules: [{ when: num(metric, op), then: 'skip' }] })).toBe(false);
      for (const value of [-1, 1.5, '3', null]) expect(ok({ type: 'new_messages', rules: [{ when: { metric, op: '>', value }, then: 'skip' }] })).toBe(false);
    }
  });

  it('needs keywords (1..20, each 1..50 characters) for chat.keywordHits and rejects them on other metrics', () => {
    const hits = (keywords: unknown) => ok({ type: 'new_messages', rules: [{ when: { metric: 'chat.keywordHits', op: '>', value: 0, keywords }, then: 'llm' }] });
    expect(hits(['a'])).toBe(true);
    expect(hits(Array.from({ length: 20 }, (_, i) => `k${i}`))).toBe(true);
    expect(hits([])).toBe(false);
    expect(hits(Array.from({ length: 21 }, (_, i) => `k${i}`))).toBe(false);
    expect(hits(['x'.repeat(51)])).toBe(false);
    expect(hits(undefined)).toBe(false);
    expect(ok({ type: 'new_messages', rules: [{ when: { metric: 'chat.messageCount', op: '>', value: 0, keywords: ['a'] }, then: 'llm' }] })).toBe(false);
  });

  it('checks the ops and values of the text metrics', () => {
    const rule = (leaf: unknown) => ok({ type: 'new_messages', rules: [{ when: leaf, then: 'skip' }] });
    expect(rule({ metric: 'chat.id', op: '==', value: 'c1' })).toBe(true);
    expect(rule({ metric: 'chat.id', op: '!=', value: 'c1' })).toBe(true);
    expect(rule({ metric: 'chat.id', op: 'in', value: ['c1', 'c2'] })).toBe(true);
    expect(rule({ metric: 'chat.id', op: 'not_in', value: ['c1'] })).toBe(true);
    expect(rule({ metric: 'chat.id', op: 'in', value: 'c1' })).toBe(false);
    expect(rule({ metric: 'chat.id', op: '==', value: ['c1'] })).toBe(false);
    expect(rule({ metric: 'chat.id', op: 'in', value: [] })).toBe(false);
    expect(rule({ metric: 'chat.id', op: 'in', value: Array.from({ length: 101 }, (_, i) => `c${i}`) })).toBe(false);
    expect(rule({ metric: 'chat.id', op: 'in', value: Array.from({ length: 100 }, (_, i) => `c${i}`) })).toBe(true);
    expect(rule({ metric: 'chat.id', op: '>', value: 'c1' })).toBe(false);
    expect(rule({ metric: 'chat.id', op: 'any_of', value: ['c1'] })).toBe(false);
    expect(rule({ metric: 'chat.type', op: '==', value: 'group' })).toBe(true);
    expect(rule({ metric: 'chat.type', op: 'in', value: ['group', 'room', 'community', 'direct', 'thread'] })).toBe(true);
    expect(rule({ metric: 'chat.type', op: '==', value: 'channel' })).toBe(false);
    expect(rule({ metric: 'chat.type', op: 'in', value: ['group', 'channel'] })).toBe(false);
  });

  it('checks message.direction, message.kind and message.textContains in messageFilter', () => {
    const filter = (leaf: unknown) => ok({ type: 'new_messages', messageFilter: leaf });
    expect(filter(messageLeaf)).toBe(true);
    expect(filter({ metric: 'message.direction', op: '!=', value: 'outbound' })).toBe(true);
    expect(filter({ metric: 'message.direction', op: '==', value: 'sideways' })).toBe(false);
    expect(filter({ metric: 'message.kind', op: 'not_in', value: ['sticker', 'event'] })).toBe(true);
    expect(filter({ metric: 'message.kind', op: 'in', value: ['video', 'gif'] })).toBe(false);
    expect(filter({ metric: 'message.textContains', op: 'any_of', value: ['hi'] })).toBe(true);
    expect(filter({ metric: 'message.textContains', op: 'none_of', value: ['hi'] })).toBe(true);
    expect(filter({ metric: 'message.textContains', op: '==', value: ['hi'] })).toBe(false);
    expect(filter({ metric: 'message.textContains', op: 'any_of', value: 'hi' })).toBe(false);
    expect(filter({ metric: 'message.textContains', op: 'any_of', value: [] })).toBe(false);
    expect(filter({ metric: 'message.textContains', op: 'any_of', value: Array.from({ length: 21 }, (_, i) => `w${i}`) })).toBe(false);
    expect(filter({ metric: 'message.textContains', op: 'any_of', value: ['x'.repeat(51)] })).toBe(false);
  });

  it('rejects an unknown metric and a metric of the wrong scope', () => {
    expect(ok({ type: 'new_messages', messageFilter: num('chat.messageCount') })).toBe(false);
    expect(ok({ type: 'new_messages', messageFilter: { metric: 'chat.id', op: '==', value: 'x' } })).toBe(false);
    expect(ok({ type: 'new_messages', messageFilter: { all: [messageLeaf, num('run.chatCount')] } })).toBe(false);
    expect(ok({ type: 'new_messages', rules: [{ when: messageLeaf, then: 'skip' }] })).toBe(false);
    expect(ok({ type: 'new_messages', rules: [{ when: { metric: 'message.textContains', op: 'any_of', value: ['a'] }, then: 'skip' }] })).toBe(false);
    expect(ok({ type: 'new_messages', rules: [{ when: { any: [num('chat.messageCount'), messageLeaf] }, then: 'skip' }] })).toBe(false);
    expect(ok({ type: 'new_messages', rules: [{ when: num('chat.unknown'), then: 'skip' }] })).toBe(false);
    expect(ok({ type: 'new_messages', rules: [{ when: { sql: 'select 1' }, then: 'skip' }] })).toBe(false);
    expect(ok({ type: 'new_messages', rules: [{ when: num('chat.messageCount'), then: 'delete' }] })).toBe(false);
  });

  it('accepts all and any groups with one or more children and at most two group levels', () => {
    const a = num('chat.messageCount');
    const b = num('chat.senderCount');
    const rule = (when: unknown) => ok({ type: 'new_messages', rules: [{ when, then: 'llm' }] });
    expect(rule({ all: [a] })).toBe(true);
    expect(rule({ any: [a, b] })).toBe(true);
    expect(rule({ all: [] })).toBe(false);
    expect(rule({ any: [] })).toBe(false);
    expect(rule({ all: [a], any: [b] })).toBe(false);
    // Two levels of groups.
    expect(rule({ any: [a, { all: [a, b] }] })).toBe(true);
    expect(rule({ all: [{ any: [a, b] }, { all: [a] }, b] })).toBe(true);
    // Three levels are rejected.
    expect(rule({ any: [a, { all: [b, { any: [a] }] }] })).toBe(false);
    expect(ok({ type: 'new_messages', messageFilter: { all: [messageLeaf, { any: [messageLeaf, { all: [messageLeaf] }] }] } })).toBe(false);
    expect(ok({ type: 'new_messages', messageFilter: { all: [messageLeaf, { any: [messageLeaf, messageLeaf] }] } })).toBe(true);
  });

  it('allows 20 rules and rejects 21', () => {
    const rules = (count: number) => Array.from({ length: count }, () => ({ when: num('chat.messageCount'), then: 'list' }));
    expect(ok({ type: 'new_messages', rules: rules(20) })).toBe(true);
    expect(ok({ type: 'new_messages', rules: rules(21) })).toBe(false);
  });

  it('allows 50 leaves in messageFilter and rules together and rejects 51', () => {
    const leaves = (count: number, leaf: unknown) => Array.from({ length: count }, () => leaf);
    const task = (filterLeaves: number, ruleLeaves: number) => ({ type: 'new_messages',
      ...(filterLeaves > 0 ? { messageFilter: { all: leaves(filterLeaves, messageLeaf) } } : {}),
      rules: [{ when: { any: leaves(ruleLeaves, num('chat.messageCount')) }, then: 'llm' }] });
    expect(ok(task(0, 50))).toBe(true);
    expect(ok(task(25, 25))).toBe(true);
    expect(ok(task(1, 50))).toBe(false);
    expect(ok(task(26, 25))).toBe(false);
    const split = { type: 'new_messages', rules: [
      { when: { all: leaves(25, num('chat.messageCount')) }, then: 'skip' }, { when: { all: leaves(26, num('chat.senderCount')) }, then: 'llm' }] };
    expect(ok(split)).toBe(false);
    const parsed = parse({ type: 'new_messages', messageFilter: { all: [messageLeaf, { any: [messageLeaf, messageLeaf] }] }, rules: [{ when: num('run.chatCount'), then: 'skip' }] });
    expect(parsed.success && parsed.data.type === 'new_messages' && countScheduleLeaves(parsed.data.messageFilter!)).toBe(3);
  });
});

describe('new_messages helpers and shape', () => {
  const task = (rules?: Array<{ then: 'list' | 'skip' | 'llm' }>) => parse({ type: 'new_messages', ...(rules ? { rules: rules.map((rule) => ({ when: num('chat.messageCount'), ...rule })) } : {}) }).data as AgentScheduleTask;

  it('classifies the execution kind and when an LLM may run', () => {
    expect(scheduleExecutionKind({ type: 'message' })).toBe('program');
    expect(scheduleExecutionKind({ type: 'new_messages' })).toBe('program');
    for (const type of ['custom', 'summary', 'keyword_digest'] as const) expect(scheduleExecutionKind({ type })).toBe('agent');
    expect(scheduleMayUseLlm({ type: 'message', text: 'x' })).toBe(false);
    expect(scheduleMayUseLlm({ type: 'custom' })).toBe(true);
    expect(scheduleMayUseLlm({ type: 'summary' })).toBe(true);
    expect(scheduleMayUseLlm({ type: 'keyword_digest', keywords: ['a'] })).toBe(true);
    expect(scheduleMayUseLlm(task())).toBe(false);
    expect(scheduleMayUseLlm(task([{ then: 'list' }, { then: 'skip' }]))).toBe(false);
    expect(scheduleMayUseLlm(task([{ then: 'list' }, { then: 'llm' }]))).toBe(true);
  });

  it('lets a new_messages task have 0..20 targets, no prompt, and rejects record_only', () => {
    const target = (i: number) => ({ accountId: 'a', chatType: 'group' as const, chatId: `g${i}`, title: '' });
    const newMessages = task();
    expect(agentScheduleShapeError({ prompt: '', targets: [], task: newMessages })).toBeNull();
    expect(agentScheduleShapeError({ prompt: '', targets: [target(1), target(2)], task: newMessages, delivery: { mode: 'primary_admin' } })).toBeNull();
    expect(agentScheduleShapeError({ prompt: '', targets: [], task: newMessages, delivery: { mode: 'line_target', target: { accountId: 'a', chatType: 'group', chatId: 'g', title: '' } } })).toBeNull();
    expect(agentScheduleShapeError({ prompt: '', targets: [], task: newMessages, delivery: { mode: 'record_only' } })).toMatch(/delivered to LINE/);
    expect(agentScheduleShapeError({ prompt: '', targets: [target(1), target(1)], task: newMessages })).toBe('Targets must be unique');
    const create = (extra: Record<string, unknown>) => AgentScheduleCreateInputSchema.safeParse({ title: 't', provider: 'claude', recurrence, task: { type: 'new_messages' }, ...extra });
    expect(create({}).success).toBe(true);
    expect(create({ targets: Array.from({ length: 20 }, (_, i) => target(i)) }).success).toBe(true);
    expect(create({ targets: Array.from({ length: 21 }, (_, i) => target(i)) }).success).toBe(false);
    expect(create({ delivery: { mode: 'record_only' } }).success).toBe(false);
    expect(create({}).data?.task).toMatchObject({ maxMessagesPerChat: 20, maxTextChars: 200, sendWhenEmpty: false });
  });

  it('accepts the task through the create_schedule tool input and reports a bad rule as an issue', () => {
    expect(CreateScheduleToolInputSchema.safeParse({ title: 't', recurrence, task: { type: 'new_messages', rules: [{ when: num('chat.messageCount'), then: 'llm' }] } }).success).toBe(true);
    const bad = CreateScheduleToolInputSchema.safeParse({ title: 't', recurrence, task: { type: 'new_messages', rules: [{ when: messageLeaf, then: 'llm' }] } });
    expect(bad.success).toBe(false);
    expect(bad.error?.issues[0]?.message).toEqual(expect.any(String));
  });

  it('adds no_messages to the run outcomes and execution plus mayUseLlm to the stored schedule', () => {
    expect(AgentScheduleRunOutcomeSchema.safeParse('no_messages').success).toBe(true);
    const base = { scheduleId: '11111111-1111-4111-8111-111111111111', title: 't', prompt: '', provider: 'claude', recurrence, timezone: 'Asia/Taipei', targets: [],
      task: { type: 'new_messages', maxMessagesPerChat: 20, maxTextChars: 200, sendWhenEmpty: false }, window: { mode: 'since_last_run' }, delivery: { mode: 'primary_admin' },
      jitterMinutes: 0, enabled: true, nextFireAt: null, lastFireAt: null, lastOutcome: 'no_messages', createdAt: '2026-10-01T00:00:00.000Z', updatedAt: '2026-10-01T00:00:00.000Z' };
    expect(AgentScheduleSchema.safeParse({ ...base, execution: 'program', mayUseLlm: false }).success).toBe(true);
    expect(AgentScheduleSchema.safeParse(base).success).toBe(false);
    expect(AgentScheduleSchema.safeParse({ ...base, execution: 'robot', mayUseLlm: false }).success).toBe(false);
  });

  it('validates the preview request and registers the IPC action', () => {
    const preview = AgentSchedulePreviewNewMessagesInputSchema.parse({ task: { type: 'new_messages' } });
    expect(preview).toMatchObject({ targets: [], window: { mode: 'since_last_run' } });
    expect(AgentSchedulePreviewNewMessagesInputSchema.safeParse({ task: { type: 'custom' } }).success).toBe(false);
    expect(IpcRequestSchema.safeParse({ type: 'previewAgentScheduleNewMessages', requestId: 'r1', preview: { task: { type: 'new_messages' } } }).success).toBe(true);
    expect(IpcRequestSchema.safeParse({ type: 'previewAgentScheduleNewMessages', requestId: 'r1' }).success).toBe(false);
  });
});

describe('preview delivery', () => {
  it('accepts an optional delivery, rejects a wrong one, and passes it through the IPC request', () => {
    const delivery = { mode: 'line_target', target: { accountId: 'a', chatType: 'direct', chatId: 'c', title: 't' } };
    expect(AgentSchedulePreviewNewMessagesInputSchema.parse({ task: { type: 'new_messages' }, delivery }).delivery).toEqual(delivery);
    expect(AgentSchedulePreviewNewMessagesInputSchema.parse({ task: { type: 'new_messages' } }).delivery).toBeUndefined();
    expect(AgentSchedulePreviewNewMessagesInputSchema.safeParse({ task: { type: 'new_messages' }, delivery: { mode: 'nope' } }).success).toBe(false);
    const request = IpcRequestSchema.parse({ type: 'previewAgentScheduleNewMessages', requestId: '11111111-1111-4111-8111-111111111111', preview: { task: { type: 'new_messages' }, delivery: { mode: 'primary_admin' } } });
    expect(request).toMatchObject({ preview: { delivery: { mode: 'primary_admin' } } });
  });
});
