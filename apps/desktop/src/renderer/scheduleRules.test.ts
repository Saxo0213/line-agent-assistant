import { describe, expect, it } from 'vitest';
import {
  AGENT_SCHEDULE_CHAT_NUMBER_METRICS, AGENT_SCHEDULE_LEAVES_MAX, AGENT_SCHEDULE_MESSAGE_DIRECTIONS, AGENT_SCHEDULE_MESSAGE_KINDS, AGENT_SCHEDULE_NUMBER_OPS, AGENT_SCHEDULE_RULES_MAX,
  AgentScheduleNewMessagesTaskSchema, ChatTypeSchema, type AgentScheduleNewMessagesTask, type AgentScheduleTask,
} from '@line-agent/contracts';
import { scheduleTextFor, type ScheduleCopyKey } from '../desktop-schedule-copy.js';
import {
  KIND_TASKS, LEAVES_MAX, MESSAGE_METRICS, RULES_MAX, RULE_METRICS, buildNewMessagesTask, countDraftLeaves, defaultNewMessagesDraft, describeCondition, describeLlmRules, draftFromTask,
  hasLlmRule, isSingleOp, kindOfTask, leafForMetric, leafWithOp, metricKind, moveItem, newGroup, newLeaf, newRule, opsOf, type DraftGroup, type DraftLeaf, type NewMessagesDraft,
} from './scheduleRules.js';

const parse = (task: unknown): AgentScheduleNewMessagesTask => AgentScheduleNewMessagesTaskSchema.parse(task);
/** A stored task goes into the editor and comes back out with no change by the user. */
const roundTrip = (stored: unknown): AgentScheduleNewMessagesTask | undefined => buildNewMessagesTask(draftFromTask(parse(stored))).task;
const text = (key: ScheduleCopyKey, values?: Record<string, unknown>) => scheduleTextFor('zh-TW', key, values);

const leaf = (metric: string, op: string, value: unknown, extra: Record<string, unknown> = {}) => ({ metric, op, value, ...extra });
const num = (metric: string, op: string, value: number, extra: Record<string, unknown> = {}) => leaf(metric, op, value, extra);

describe('round trip of a stored new_messages task', () => {
  const same = (stored: unknown) => expect(roundTrip(stored)).toEqual(parse(stored));

  it('keeps a task with no filter and no rules, and does not become another task type', () => {
    same({ type: 'new_messages' });
    expect(roundTrip({ type: 'new_messages' })!.type).toBe('new_messages');
  });

  it('keeps a bare leaf as the root of a rule and of the message filter', () => {
    same({ type: 'new_messages', rules: [{ when: num('chat.messageCount', '>=', 5), then: 'skip' }] });
    same({ type: 'new_messages', messageFilter: leaf('message.direction', '==', 'inbound') });
    const built = roundTrip({ type: 'new_messages', rules: [{ when: num('chat.messageCount', '>=', 5), then: 'skip' }] })!;
    expect('metric' in built.rules![0]!.when).toBe(true);
  });

  it('shows a bare root leaf as a one-row group and builds it back to a leaf', () => {
    const draft = draftFromTask(parse({ type: 'new_messages', rules: [{ when: num('run.chatCount', '<', 3), then: 'list' }] }));
    expect(draft.rules[0]!.when.children).toHaveLength(1);
    expect(draft.rules[0]!.when.children[0]!.type).toBe('leaf');
    expect(buildNewMessagesTask(draft).task!.rules![0]!.when).toEqual(num('run.chatCount', '<', 3));
  });

  it('keeps a root all, a root any and a stored one-row group', () => {
    same({ type: 'new_messages', rules: [
      { when: { all: [num('chat.messageCount', '>', 1), num('chat.senderCount', '<=', 4)] }, then: 'llm' },
      { when: { any: [num('chat.textChars', '==', 10), leaf('chat.type', '==', 'group')] }, then: 'skip' },
      { when: { all: [num('chat.messageCount', '>', 1)] }, then: 'list' },
    ] });
    const built = roundTrip({ type: 'new_messages', rules: [{ when: { all: [num('chat.messageCount', '>', 1)] }, then: 'list' }] })!;
    expect(built.rules![0]!.when).toEqual({ all: [num('chat.messageCount', '>', 1)] });
  });

  it('keeps a nested group, in the filter and in rules', () => {
    same({
      type: 'new_messages',
      messageFilter: { all: [leaf('message.direction', '==', 'inbound'), { any: [leaf('message.kind', 'in', ['text', 'sticker']), leaf('message.textContains', 'any_of', ['請款'])] }] },
      rules: [{ when: { any: [{ all: [num('chat.messageCount', '>=', 3), num('chat.senderCount', '>=', 2)] }, leaf('chat.id', 'in', ['c1'])] }, then: 'llm' }],
    });
  });

  it('keeps every number metric with every operator, including the keywords of chat.keywordHits', () => {
    for (const metric of [...AGENT_SCHEDULE_CHAT_NUMBER_METRICS, 'chat.keywordHits']) {
      for (const op of AGENT_SCHEDULE_NUMBER_OPS) {
        const extra = metric === 'chat.keywordHits' ? { keywords: ['請款', 'invoice'] } : {};
        same({ type: 'new_messages', rules: [{ when: num(metric, op, 7, extra), then: 'list' }] });
      }
    }
    const built = roundTrip({ type: 'new_messages', rules: [{ when: num('chat.keywordHits', '>=', 2, { keywords: ['a', 'b'] }), then: 'llm' }] })!;
    expect(built.rules![0]!.when).toEqual(num('chat.keywordHits', '>=', 2, { keywords: ['a', 'b'] }));
  });

  it('keeps every text metric with every operator', () => {
    const values: Record<string, string[]> = { 'chat.type': [...ChatTypeSchema.options], 'chat.id': ['chat-1', 'chat-2'], 'message.direction': [...AGENT_SCHEDULE_MESSAGE_DIRECTIONS], 'message.kind': [...AGENT_SCHEDULE_MESSAGE_KINDS] };
    for (const [metric, all] of Object.entries(values)) {
      for (const op of ['==', '!=', 'in', 'not_in']) {
        const value = isSingleOp(op) ? all[0] : all.slice(0, 2);
        const condition = leaf(metric, op, value);
        same(metric.startsWith('message.') ? { type: 'new_messages', messageFilter: condition } : { type: 'new_messages', rules: [{ when: condition, then: 'skip' }] });
      }
    }
    for (const op of ['any_of', 'none_of']) same({ type: 'new_messages', messageFilter: leaf('message.textContains', op, ['a', 'b']) });
  });

  it('keeps a chat.id leaf with == or != editable: the operator and the single id stay', () => {
    const stored = { type: 'new_messages', rules: [{ when: leaf('chat.id', '!=', 'chat-9'), then: 'skip' }] };
    const draft = draftFromTask(parse(stored));
    const row = draft.rules[0]!.when.children[0] as DraftLeaf;
    expect(row).toMatchObject({ metric: 'chat.id', op: '!=', list: ['chat-9'] });
    same(stored);
    const edited = { ...draft, rules: [{ ...draft.rules[0]!, when: { ...draft.rules[0]!.when, children: [{ ...row, list: ['chat-10'] }] } }] };
    expect(buildNewMessagesTask(edited).task!.rules![0]!.when).toEqual(leaf('chat.id', '!=', 'chat-10'));
  });

  it('keeps the parameters, sendWhenEmpty, the order and the actions of the rules', () => {
    same({
      type: 'new_messages', maxMessagesPerChat: 200, maxTextChars: 2000, sendWhenEmpty: true,
      rules: [{ when: num('chat.messageCount', '>', 1), then: 'skip' }, { when: num('chat.messageCount', '>', 0), then: 'llm' }, { when: num('chat.messageCount', '>=', 0), then: 'list' }],
    });
    same({ type: 'new_messages', maxMessagesPerChat: 1, maxTextChars: 20 });
    expect(roundTrip({ type: 'new_messages' })).toMatchObject({ maxMessagesPerChat: 20, maxTextChars: 200, sendWhenEmpty: false });
  });

  it('shows the title of a known chat and the id of an unknown chat (display only, never sent)', () => {
    const task = parse({ type: 'new_messages', rules: [{ when: leaf('chat.id', 'in', ['c1', 'c2']), then: 'list' }] });
    const draft = draftFromTask(task, [{ accountId: 'a', chatType: 'group', chatId: 'c1', title: '客戶群' }]);
    const row = draft.rules[0]!.when.children[0] as DraftLeaf;
    expect(row.chats).toEqual({ c1: { accountId: 'a', chatType: 'group', title: '客戶群' } });
    expect(JSON.stringify(buildNewMessagesTask(draft).task)).not.toContain('客戶群');
  });
});

describe('draft editing helpers', () => {
  it('starts every new rule with a one-row group that builds to a bare leaf', () => {
    const draft: NewMessagesDraft = { ...defaultNewMessagesDraft(), rules: [newRule()] };
    expect(draft.rules[0]!.when.children).toHaveLength(1);
    expect(buildNewMessagesTask(draft).task!.rules![0]).toEqual({ when: num('chat.messageCount', '>=', 1), then: 'list' });
  });

  it('adds a row and a child group and builds a group', () => {
    const rule = newRule();
    const child: DraftGroup = { ...newGroup('rule', false), mode: 'any' };
    const draft: NewMessagesDraft = { ...defaultNewMessagesDraft(), rules: [{ ...rule, then: 'skip', when: { ...rule.when, children: [...rule.when.children, newLeaf('rule'), child] } }] };
    expect(buildNewMessagesTask(draft).task!.rules![0]).toEqual({
      when: { all: [num('chat.messageCount', '>=', 1), num('chat.messageCount', '>=', 1), { any: [num('chat.messageCount', '>=', 1)] }] }, then: 'skip',
    });
  });

  it('resets the operator and the value when the metric changes, and keeps one value when the operator becomes single', () => {
    expect(leafForMetric('chat.type')).toMatchObject({ op: '==', list: ['direct'] });
    expect(leafForMetric('chat.id')).toMatchObject({ op: 'in', list: [] });
    expect(leafForMetric('message.textContains')).toMatchObject({ op: 'any_of', list: [] });
    expect(leafForMetric('run.listedChars')).toMatchObject({ op: '>=', value: '1' });
    const many = { ...leafForMetric('chat.type'), op: 'in', list: ['group', 'room'] };
    expect(leafWithOp(many, '==').list).toEqual(['group']);
    expect(leafWithOp(many, 'not_in').list).toEqual(['group', 'room']);
  });

  it('offers the operators of the contract for each metric', () => {
    expect(opsOf('chat.messageCount')).toEqual(['>', '>=', '<', '<=', '==', '!=']);
    expect(opsOf('chat.type')).toEqual(['==', '!=', 'in', 'not_in']);
    expect(opsOf('message.textContains')).toEqual(['any_of', 'none_of']);
    expect(MESSAGE_METRICS.map(metricKind)).toEqual(['enum', 'enum', 'textContains']);
    expect(RULE_METRICS).toHaveLength(9);
  });

  it('moves a rule up and down and stays put at the ends', () => {
    expect(moveItem([1, 2, 3], 1, -1)).toEqual([2, 1, 3]);
    expect(moveItem([1, 2, 3], 1, 1)).toEqual([1, 3, 2]);
    expect(moveItem([1, 2, 3], 0, -1)).toEqual([1, 2, 3]);
    expect(moveItem([1, 2, 3], 2, 1)).toEqual([1, 2, 3]);
  });

  it('derives the schedule kind from the task type', () => {
    expect(KIND_TASKS.program).toEqual(['message', 'new_messages']);
    expect(KIND_TASKS.agent).toEqual(['custom', 'summary', 'keyword_digest']);
    for (const type of KIND_TASKS.program) expect(kindOfTask(type)).toBe('program');
    for (const type of KIND_TASKS.agent) expect(kindOfTask(type)).toBe('agent');
  });

  it('detects a rule that hands a chat to the LLM', () => {
    const draft = draftFromTask(parse({ type: 'new_messages', rules: [{ when: num('chat.messageCount', '>', 1), then: 'skip' }] }));
    expect(hasLlmRule(draft)).toBe(false);
    expect(hasLlmRule({ ...draft, rules: [...draft.rules, { ...newRule(), then: 'llm' }] })).toBe(true);
  });
});

describe('limits', () => {
  it('uses the limits of the contract', () => {
    expect(RULES_MAX).toBe(AGENT_SCHEDULE_RULES_MAX);
    expect(LEAVES_MAX).toBe(AGENT_SCHEDULE_LEAVES_MAX);
  });

  it('counts the leaves of the filter and all rules', () => {
    const draft = draftFromTask(parse({
      type: 'new_messages', messageFilter: { all: [leaf('message.direction', '==', 'inbound'), leaf('message.kind', '==', 'text')] },
      rules: [{ when: { all: [num('chat.messageCount', '>', 1), { any: [num('chat.senderCount', '>', 1), num('chat.textChars', '>', 1)] }] }, then: 'list' }, { when: num('run.chatCount', '>', 1), then: 'skip' }],
    }));
    expect(countDraftLeaves(draft)).toBe(6);
    expect(countDraftLeaves(defaultNewMessagesDraft())).toBe(0);
  });

  it('does not build more rules or more conditions than the contract allows', () => {
    const rules = Array.from({ length: RULES_MAX + 1 }, () => newRule());
    expect(buildNewMessagesTask({ ...defaultNewMessagesDraft(), rules }).errors?.general?.key).toBe('errRulesInvalid');
    expect(buildNewMessagesTask({ ...defaultNewMessagesDraft(), rules: rules.slice(0, RULES_MAX) }).task?.rules).toHaveLength(RULES_MAX);
    const wide = newRule();
    wide.when.children = Array.from({ length: LEAVES_MAX }, () => newLeaf('rule'));
    expect(buildNewMessagesTask({ ...defaultNewMessagesDraft(), rules: [wide] }).task).toBeDefined();
    expect(buildNewMessagesTask({ ...defaultNewMessagesDraft(), rules: [wide, newRule()] }).errors?.general?.key).toBe('errRulesInvalid');
  });
});

describe('validation errors', () => {
  const withLeaf = (change: Partial<DraftLeaf>, scope: 'rule' | 'message' = 'rule') => {
    const base = scope === 'rule' ? leafForMetric('chat.messageCount') : leafForMetric('message.textContains');
    const row = { ...base, ...change };
    const group: DraftGroup = { ...newGroup(scope, true), children: [row] };
    const draft: NewMessagesDraft = scope === 'rule' ? { ...defaultNewMessagesDraft(), rules: [{ ...newRule(), when: group }] } : { ...defaultNewMessagesDraft(), messageFilter: group };
    return { row, result: buildNewMessagesTask(draft) };
  };

  it('reports an empty number on the field', () => {
    const { row, result } = withLeaf({ value: '  ' });
    expect(result.task).toBeUndefined();
    expect(result.errors!.fields[row.key]).toEqual({ key: 'errRuleValueRequired' });
    expect(result.errors!.general).toEqual({ key: 'errRulesFix' });
  });

  it('reports a number that is not a whole number from 0 to 1,000,000,000', () => {
    for (const value of ['1.5', '-1', 'abc', '1000000001', '1e3']) {
      const { row, result } = withLeaf({ value });
      expect(result.errors!.fields[row.key], value).toEqual({ key: 'errRuleNumber', values: { arg0: 0, arg1: 1_000_000_000 } });
    }
    expect(withLeaf({ value: '0' }).result.task).toBeDefined();
    expect(withLeaf({ value: '1000000000' }).result.task).toBeDefined();
  });

  it('reports an empty value list, empty keywords and an empty group', () => {
    const empty = withLeaf({ list: [] }, 'message');
    expect(empty.result.errors!.fields[empty.row.key]).toEqual({ key: 'errRuleValueRequired' });
    const hits = withLeaf({ ...leafForMetric('chat.keywordHits'), keywords: [] });
    expect(hits.result.errors!.fields[`${hits.row.key}.keywords`]).toEqual({ key: 'errRuleValueRequired' });
    const group: DraftGroup = { ...newGroup('rule', true), children: [] };
    const result = buildNewMessagesTask({ ...defaultNewMessagesDraft(), rules: [{ ...newRule(), when: group }] });
    expect(result.errors!.fields[group.key]).toEqual({ key: 'errRuleGroupEmpty' });
    const chat = withLeaf({ ...leafForMetric('chat.id'), list: [] });
    expect(chat.result.errors!.fields[chat.row.key]).toEqual({ key: 'errRuleValueRequired' });
  });

  it('reports the parameters that are empty or out of range', () => {
    const build = (patch: Partial<NewMessagesDraft>) => buildNewMessagesTask({ ...defaultNewMessagesDraft(), ...patch });
    expect(build({ maxMessagesPerChat: '' }).errors!.fields.maxMessagesPerChat).toEqual({ key: 'errRuleValueRequired' });
    expect(build({ maxMessagesPerChat: '0' }).errors!.fields.maxMessagesPerChat).toEqual({ key: 'errRuleNumber', values: { arg0: 1, arg1: 200 } });
    expect(build({ maxMessagesPerChat: '201' }).errors!.fields.maxMessagesPerChat).toBeDefined();
    expect(build({ maxTextChars: '19' }).errors!.fields.maxTextChars).toEqual({ key: 'errRuleNumber', values: { arg0: 20, arg1: 2000 } });
    expect(build({ maxTextChars: '2001' }).errors!.fields.maxTextChars).toBeDefined();
    expect(build({ maxMessagesPerChat: '200', maxTextChars: '2000' }).task).toMatchObject({ maxMessagesPerChat: 200, maxTextChars: 2000 });
  });

  it('reports every bad field at once', () => {
    const a = withLeaf({ value: '' });
    const second = leafForMetric('chat.senderCount');
    second.value = 'x';
    const group: DraftGroup = { ...newGroup('rule', true), children: [a.row, second] };
    const result = buildNewMessagesTask({ ...defaultNewMessagesDraft(), maxTextChars: '5', rules: [{ ...newRule(), when: group }] });
    expect(Object.keys(result.errors!.fields).sort()).toEqual([a.row.key, second.key, 'maxTextChars'].sort());
  });

  it('gives a general error for a schema failure that has no field (a group nested three levels deep)', () => {
    const inner: DraftGroup = { ...newGroup('rule', false) };
    const middle: DraftGroup = { ...newGroup('rule', false), children: [inner] };
    const root: DraftGroup = { ...newGroup('rule', true), children: [middle] };
    const result = buildNewMessagesTask({ ...defaultNewMessagesDraft(), rules: [{ ...newRule(), when: root }] });
    expect(result.task).toBeUndefined();
    expect(result.errors).toEqual({ fields: {}, general: { key: 'errRulesInvalid' } });
  });

  it('gives a general error when a value is not allowed by the contract', () => {
    const { result } = withLeaf({ ...leafForMetric('chat.type'), list: ['planet'] });
    expect(result.errors).toEqual({ fields: {}, general: { key: 'errRulesInvalid' } });
  });
});

describe('describeCondition', () => {
  it('describes a number leaf, a keyword leaf and a text leaf in the language of the page', () => {
    expect(describeCondition(num('chat.messageCount', '>=', 5) as never, text)).toBe('聊天室訊息數 ≥ 5');
    expect(describeCondition(num('chat.keywordHits', '>', 0, { keywords: ['請款', '發票'] }) as never, text)).toBe('含關鍵字的訊息數 (請款、發票) > 0');
    expect(describeCondition(leaf('chat.type', 'in', ['group', 'room']) as never, text)).toBe('聊天室類型 屬於 群組、多人聊天室');
    expect(describeCondition(leaf('message.direction', '==', 'inbound') as never, text)).toBe('訊息方向 是 收到');
    expect(describeCondition(leaf('message.textContains', 'none_of', ['a']) as never, text)).toBe('訊息文字 不包含任何 "a"');
  });

  it('describes groups with 且 / 或 and brackets only for a child group', () => {
    const condition = { any: [num('chat.messageCount', '>', 9), { all: [num('chat.senderCount', '>', 1), leaf('chat.type', '==', 'group')] }] };
    expect(describeCondition(condition as never, text)).toBe('聊天室訊息數 > 9 或 (聊天室發言人數 > 1 且 聊天室類型 是 群組)');
    expect(describeCondition({ all: [num('chat.messageCount', '>', 9)] } as never, text)).toBe('聊天室訊息數 > 9');
  });

  it('shows the title of a known chat, the id of an unknown chat and never raw JSON', () => {
    const condition = leaf('chat.id', 'in', ['c1', 'c2']) as never;
    expect(describeCondition(condition, text, { chatTitle: (id) => id === 'c1' ? '客戶群' : undefined })).toBe('聊天室 屬於 客戶群、c2');
    const out = describeCondition({ all: [num('chat.messageCount', '>', 9), leaf('chat.id', '!=', 'c9')] } as never, text);
    expect(out).not.toMatch(/[{}\[\]]|metric|"op"/);
  });

  it('describes in every language', () => {
    for (const locale of ['en', 'zh-TW', 'ja', 'ko'] as const) {
      const out = describeCondition({ all: [num('run.listedChars', '>', 100), leaf('message.kind', 'in', ['image', 'video'])] } as never, (key, values) => scheduleTextFor(locale, key, values));
      expect(out).toContain('100');
      expect(out).not.toContain('{arg');
    }
    expect(describeCondition(leaf('message.kind', 'in', ['image']) as never, (key, values) => scheduleTextFor('en', key, values))).toBe('Message type is one of Image');
  });

  it('lists only the conditions of the rules that say llm', () => {
    const task = parse({ type: 'new_messages', rules: [
      { when: num('chat.messageCount', '>', 50), then: 'llm' }, { when: num('chat.senderCount', '>', 1), then: 'skip' }, { when: leaf('chat.type', '==', 'direct'), then: 'llm' },
    ] });
    expect(describeLlmRules(task, text)).toBe('聊天室訊息數 > 50 / 聊天室類型 是 一對一');
    expect(describeLlmRules(parse({ type: 'new_messages' }), text)).toBe('');
    expect(describeLlmRules({ type: 'custom' } as AgentScheduleTask, text)).toBe('');
  });
});
