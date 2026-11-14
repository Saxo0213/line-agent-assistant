import { describe, expect, it } from 'vitest';
import { agentScheduleShapeError, AgentScheduleCreateInputSchema, AgentScheduleForwardTaskSchema, AgentScheduleTaskSchema, CreateScheduleToolInputSchema, matchesScheduleForward, scheduleExecutionKind, scheduleMayUseLlm } from './agent-schedule.js';

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

  it('uses the same event and destination validation in App and MCP', () => {
    for (const schema of [AgentScheduleCreateInputSchema, CreateScheduleToolInputSchema]) {
      expect(schema.safeParse(input).success).toBe(true);
      for (const patch of [
        { delivery: { mode: 'primary_admin' } }, { recurrence: { kind: 'daily', time: '09:00' } },
        { task: { type: 'message', text: 'hello' } }, { delivery: { mode: 'line_target', target: source } },
      ]) expect(schema.safeParse({ ...input, ...patch }).success).toBe(false);
    }
  });
});

const mention = (extra: object = {}, match: object = {}) => ({ type: 'message_forward' as const, match: { mode: 'mention', members: [], ...match }, ...extra });
const agentTarget = { accountId: 'agent', chatType: 'group', chatId: 'agent-room', title: '' };
describe('mention rules and rule actions', () => {
  const parse = (value: unknown) => AgentScheduleForwardTaskSchema.safeParse(value);
  const issue = (value: unknown) => { const r = parse(value); return r.success ? null : r.error.issues.map((i) => i.message).join('|'); };
  it('needs at least one mention target and unique member MIDs', () => {
    expect(issue(mention())).toContain('A mention rule needs at least one mention target');
    expect(parse(mention({}, { admin: true })).success).toBe(true);
    expect(parse(mention({}, { all: true })).success).toBe(true);
    expect(parse(mention({}, { members: [{ accountId: 'admin', mid: ' u1 ' }] })).success).toBe(true);
    expect(issue(mention({}, { members: [{ accountId: 'admin', mid: 'u1' }, { accountId: 'agent', mid: 'u1' }] }))).toContain('unique');
    expect(parse(mention({}, { members: Array.from({ length: 21 }, (_, i) => ({ accountId: 'admin', mid: 'u' + i })) })).success).toBe(false);
    expect(parse(mention({}, { members: [{ accountId: 'admin', mid: '  ' }] })).success).toBe(false);
    const parsed = AgentScheduleForwardTaskSchema.parse(mention({}, { members: [{ accountId: 'admin', mid: ' u1 ' }] }));
    expect(parsed.match).toMatchObject({ mode: 'mention', admin: false, all: false, members: [{ mid: 'u1', label: '' }] });
  });
  it('matches the member MID, the admin MID and the everyone mention', () => {
    const base = { accountId: 'admin', senderId: 's1', text: 'hi' };
    const make = (match: object, extra: object = {}) => AgentScheduleForwardTaskSchema.parse(mention(extra, match));
    const member = make({ members: [{ accountId: 'admin', mid: 'u1' }] });
    expect(matchesScheduleForward(member, { ...base, mentionIds: ['x', 'u1'], adminMid: null })).toBe(true);
    expect(matchesScheduleForward(member, { ...base, mentionIds: ['x'], adminMid: 'u1' })).toBe(false);
    expect(matchesScheduleForward(member, { ...base, mentionIds: [], adminMid: null })).toBe(false);
    const admin = make({ admin: true });
    expect(matchesScheduleForward(admin, { ...base, mentionIds: ['boss'], adminMid: 'boss' })).toBe(true);
    expect(matchesScheduleForward(admin, { ...base, mentionIds: ['boss'], adminMid: null })).toBe(false);
    expect(matchesScheduleForward(admin, { ...base, mentionIds: ['@all'], adminMid: 'boss' })).toBe(false);
    const all = make({ all: true });
    expect(matchesScheduleForward(all, { ...base, mentionIds: ['@all'], adminMid: null })).toBe(true);
    expect(matchesScheduleForward(all, { ...base, mentionIds: ['u1'], adminMid: null })).toBe(false);
    const restricted = make({ all: true }, { sender: { accountId: 'admin', mid: 's2' } });
    expect(matchesScheduleForward(restricted, { ...base, mentionIds: ['@all'], adminMid: null })).toBe(false);
    expect(matchesScheduleForward(restricted, { ...base, senderId: 's2', mentionIds: ['@all'], adminMid: null })).toBe(true);
    // Other modes ignore the mention inputs.
    const contains = AgentScheduleForwardTaskSchema.parse({ type: 'message_forward', match: { mode: 'contains', keywords: ['hi'] } });
    expect(matchesScheduleForward(contains, { ...base, mentionIds: [], adminMid: null })).toBe(true);
    expect(matchesScheduleForward(contains, base)).toBe(true);
  });
  it('validates actions', () => {
    expect(issue(mention({ actions: { forward: false } }, { all: true }))).toContain('A forwarding rule needs at least one action');
    const ok = AgentScheduleForwardTaskSchema.parse(mention({ actions: { notify: true } }, { all: true }));
    expect(ok.actions).toEqual({ forward: true, notify: true, agent: null });
    const agent = AgentScheduleForwardTaskSchema.parse(mention({ actions: { forward: false, agent: { target: agentTarget } } }, { all: true }));
    expect(agent.actions).toMatchObject({ forward: false, notify: false, agent: { prompt: '', target: agentTarget } });
    expect(parse(mention({ actions: { forward: false, agent: { prompt: 'x'.repeat(4001), target: agentTarget } } }, { all: true })).success).toBe(false);
    expect(parse(mention({ actions: { forward: false, agent: { target: { ...agentTarget, chatType: 'community' } } } }, { all: true })).success).toBe(false);
    expect(parse(mention({ actions: { forward: false, notify: true, extra: 1 } }, { all: true })).success).toBe(false);
    expect(parse({ type: 'message_forward', match: { mode: 'sender' }, sender: { accountId: 'a', mid: 'u' } }).success).toBe(true);
  });
  it('checks the shape: empty targets, forward needs a destination, no forward needs record_only', () => {
    const line = { mode: 'line_target' as const, target: destination };
    const shape = (value: object, delivery: unknown, targets: object[] = []) => agentScheduleShapeError({ prompt: '', targets: targets as never,
      task: AgentScheduleTaskSchema.parse(value), delivery: delivery as never, recurrence: { kind: 'message' } });
    expect(shape(mention({}, { all: true }), line)).toBeNull();
    expect(shape(mention({ actions: { forward: true } }, { all: true }), { mode: 'record_only' })).toBe('Message forwarding requires an explicit LINE destination');
    expect(shape(mention({ actions: { forward: false, notify: true } }, { all: true }), { mode: 'record_only' })).toBeNull();
    expect(shape(mention({ actions: { forward: false, notify: true } }, { all: true }), line)).toBe('A rule without forwarding must use record-only delivery');
    expect(shape(mention({ actions: { forward: false, notify: true } }, { all: true }), { mode: 'primary_admin' })).toBe('A rule without forwarding must use record-only delivery');
    expect(shape(mention({ actions: { forward: false, agent: { target: agentTarget } } }, { all: true }), { mode: 'record_only' })).toBeNull();
    expect(shape(mention({}, { all: true }), { ...line, target: { ...destination, chatType: 'room' } })).toContain('original images and files');
    expect(shape(mention({}, { all: true }), line, [destination])).toBe('Forwarding source and destination must differ');
    // A sender with empty targets is allowed; with targets its account must be one of them.
    const senderTask = { type: 'message_forward', match: { mode: 'sender' }, sender: { accountId: 'other', mid: 'u1' } };
    expect(shape(senderTask, line)).toBeNull();
    expect(shape(senderTask, line, [source])).toBe('Sender account must belong to the selected sources');
    // Old tasks keep the old behavior; empty targets are now allowed.
    for (const schema of [AgentScheduleCreateInputSchema, CreateScheduleToolInputSchema]) {
      expect(schema.safeParse({ ...input, targets: [] }).success).toBe(true);
      expect(schema.safeParse({ ...input, targets: [], delivery: { mode: 'record_only' } }).success).toBe(false);
      expect(schema.safeParse({ ...input, targets: [], task: mention({ actions: { forward: false, notify: true } }, { admin: true }), delivery: { mode: 'record_only' } }).success).toBe(true);
    }
  });
});
