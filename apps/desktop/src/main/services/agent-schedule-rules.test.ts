import { describe, expect, it } from 'vitest';
import type { AgentScheduleCondition, AgentScheduleRule } from '@line-agent/contracts';
import {
  NEW_MESSAGES_INCOMPLETE_LINE,
  NEW_MESSAGES_LIST_CHARS_CAP,
  evaluateNewMessages,
  listedText,
  messagePasses,
  type NewMessagesConfig,
  type ScheduleMessage,
} from './agent-schedule-rules.js';

// 2026-10-01 08:00-09:00 in Asia/Taipei.
const WINDOW = { from: new Date('2026-10-01T00:00:00Z'), to: new Date('2026-10-01T01:00:00Z') };
const RANGE = '10/1 08:00–09:00';
let counter = 0;
let idCounter = 0;
const msg = (chatId: string, minute: number, overrides: Partial<ScheduleMessage> = {}): ScheduleMessage => ({
  accountId: 'acc', chatType: 'group', chatId, messageId: `m${++idCounter}`, conversationTitle: `群組${chatId}`, senderId: `u-${overrides.senderName ?? '小明'}`, senderName: '小明', direction: 'inbound', kind: 'text',
  text: `訊息${++counter}`, recalled: false, occurredAt: new Date(Date.UTC(2026, 9, 1, 0, minute)).toISOString(), ...overrides,
});
const task = (extra: Partial<NewMessagesConfig> = {}): NewMessagesConfig => ({ ...extra });
const run = (messages: ScheduleMessage[], extra: Partial<NewMessagesConfig> = {}) => evaluateNewMessages({ task: task(extra), messages, window: WINDOW });
const num = (metric: string, op: string, value: number) => ({ metric, op, value }) as AgentScheduleCondition;

describe('formatter', () => {
  it('writes the exact text: header, bullets, unknown sender, labels and recalled messages', () => {
    const result = run([
      msg('a', 5, { senderName: '小明', text: '早安' }),
      msg('a', 10, { senderName: null, senderId: 'u2', kind: 'image', text: null }),
      msg('a', 20, { senderName: '小華', senderId: 'u3', text: 'secret', recalled: true }),
    ]);
    expect(result.chats).toHaveLength(1);
    expect(result.chats[0]!.text).toBe(`【群組a】${RANGE} · 3 則\n• 08:05 [小明]：早安\n• 08:10 [未知]：圖片\n• 08:20 [小華]：已收回`);
    expect(result.chats[0]).toMatchObject({ title: '群組a', messageCount: 3, senderCount: 3, action: 'list' });
  });

  it('uses the label of the kind for a message without text and 訊息 for the rest', () => {
    const kinds: Array<[ScheduleMessage['kind'], string]> = [['image', '圖片'], ['video', '影片'], ['audio', '語音'], ['file', '檔案'], ['sticker', '貼圖'],
      ['contact', '聯絡人'], ['location', '位置'], ['event', '事件'], ['text', '訊息'], ['rich', '訊息']];
    for (const [kind, label] of kinds) {
      expect(run([msg('a', 1, { kind, text: null })]).chats[0]!.text).toBe(`【群組a】${RANGE} · 1 則\n• 08:01 [小明]：${label}`);
    }
    expect(run([msg('a', 1, { kind: 'file', text: '   ' })]).chats[0]!.text).toContain('：檔案');
    expect(run([msg('a', 1, { kind: 'image', text: '看這張' })]).chats[0]!.text).toContain('：看這張');
  });

  it('puts the newest chat first and the messages oldest first', () => {
    const result = run([msg('old', 30, { text: 'o2' }), msg('new', 50, { text: 'n2' }), msg('old', 10, { text: 'o1' }), msg('new', 40, { text: 'n1' })]);
    expect(result.chats.map((chat) => chat.chatId)).toEqual(['new', 'old']);
    expect(result.chats[0]!.text).toBe(`【群組new】${RANGE} · 2 則\n• 08:40 [小明]：n1\n• 08:50 [小明]：n2`);
    expect(result.chats[1]!.text).toBe(`【群組old】${RANGE} · 2 則\n• 08:10 [小明]：o1\n• 08:30 [小明]：o2`);
  });

  it('cuts text longer than maxTextChars and ends it with （略）', () => {
    const text = 'a'.repeat(25);
    expect(run([msg('a', 1, { text })], { maxTextChars: 20 }).chats[0]!.text).toContain(`：${'a'.repeat(20)}（略）`);
    expect(run([msg('a', 1, { text: 'a'.repeat(20) })], { maxTextChars: 20 }).chats[0]!.text).not.toContain('（略）');
    expect(run([msg('a', 1, { text })], { maxTextChars: 20 }).chats[0]!.text).not.toContain('a'.repeat(21));
    // Default 200.
    expect(run([msg('a', 1, { text: 'b'.repeat(201) })]).chats[0]!.text).toContain(`${'b'.repeat(200)}（略）`);
    // A cut never splits a surrogate pair.
    const emoji = run([msg('a', 1, { text: `${'x'.repeat(19)}😀😀😀` })], { maxTextChars: 20 }).chats[0]!.text;
    expect(emoji).toContain(`：${'x'.repeat(19)}（略）`);
  });

  it('keeps a message on one line', () => {
    expect(run([msg('a', 1, { text: '第一行\n第二行\r\n第三行' })]).chats[0]!.text).toBe(`【群組a】${RANGE} · 1 則\n• 08:01 [小明]：第一行 第二行 第三行`);
  });

  it('lists the first maxMessagesPerChat messages and ends with 另有 N 則', () => {
    const messages = Array.from({ length: 5 }, (_, i) => msg('a', i + 1, { text: `m${i + 1}` }));
    expect(run(messages, { maxMessagesPerChat: 2 }).chats[0]!.text).toBe(`【群組a】${RANGE} · 5 則\n• 08:01 [小明]：m1\n• 08:02 [小明]：m2\n另有 3 則`);
    expect(run(messages, { maxMessagesPerChat: 5 }).chats[0]!.text).not.toContain('另有');
    expect(run(Array.from({ length: 21 }, (_, i) => msg('a', i + 1))).chats[0]!.text.split('\n').at(-1)).toBe('另有 1 則');
  });

  it('falls back to the chat id for a missing title and crosses days in the header', () => {
    const result = evaluateNewMessages({ task: task(), messages: [msg('c9', 1, { conversationTitle: null })],
      window: { from: new Date('2026-09-30T15:00:00Z'), to: new Date('2026-10-01T01:00:00Z') } });
    expect(result.chats[0]!.text.split('\n')[0]).toBe('【c9】9/30 23:00–10/1 09:00 · 1 則');
  });

  it('adds the incomplete line to the listed text only, and only when something is listed', () => {
    const result = run([msg('a', 1), msg('b', 2)], { rules: [{ when: { metric: 'chat.id', op: '==', value: 'a' }, then: 'skip' }] });
    expect(listedText(result.chats, false)).toBe(result.chats.find((chat) => chat.chatId === 'b')!.text);
    expect(listedText(result.chats, true)).toBe(`${result.chats.find((chat) => chat.chatId === 'b')!.text}\n\n${NEW_MESSAGES_INCOMPLETE_LINE}`);
    expect(NEW_MESSAGES_INCOMPLETE_LINE).toBe('（已達單次上限 10000 則，以上結果不完整）');
    expect(listedText([], true)).toBe('');
    expect(listedText(run([msg('a', 1)], { rules: [{ when: num('chat.messageCount', '>', 0) as never, then: 'llm' }] }).chats, true)).toBe('');
    // Two listed chats are separated by one blank line.
    expect(listedText(run([msg('a', 1), msg('b', 2)]).chats, false).split('\n\n')).toHaveLength(2);
  });
});

describe('chat metrics and ops', () => {
  // One chat: 4 messages, 2 senders, texts of 3 + 5 + 11 + 0 characters (the last has no text), 2 messages with the keyword "hello".
  const chat = () => [
    msg('a', 1, { senderId: 'u1', senderName: 'A', text: 'abc' }),
    msg('a', 2, { senderId: 'u2', senderName: 'B', text: 'hello' }),
    msg('a', 3, { senderId: 'u1', senderName: 'A', text: 'say HELLO!!' }),
    msg('a', 4, { senderId: 'u2', senderName: 'B', kind: 'image', text: null }),
  ];
  const decide = (when: AgentScheduleCondition, messages = chat()) => run(messages, { rules: [{ when, then: 'skip' } as AgentScheduleRule] }).chats[0]!.action;
  const holds = (when: AgentScheduleCondition) => decide(when) === 'skip';

  it('compares chat.messageCount with every op', () => {
    const cases: Array<[string, number, boolean]> = [['>', 3, true], ['>', 4, false], ['>=', 4, true], ['>=', 5, false], ['<', 5, true], ['<', 4, false],
      ['<=', 4, true], ['<=', 3, false], ['==', 4, true], ['==', 3, false], ['!=', 3, true], ['!=', 4, false]];
    for (const [op, value, expected] of cases) expect(holds(num('chat.messageCount', op, value))).toBe(expected);
  });

  it('computes chat.senderCount as the number of distinct senders', () => {
    expect(holds(num('chat.senderCount', '==', 2))).toBe(true);
    expect(holds(num('chat.senderCount', '>', 2))).toBe(false);
    expect(holds(num('chat.senderCount', '>=', 2))).toBe(true);
    expect(holds(num('chat.senderCount', '<', 2))).toBe(false);
    expect(holds(num('chat.senderCount', '<=', 1))).toBe(false);
    expect(holds(num('chat.senderCount', '!=', 2))).toBe(false);
  });

  it('computes chat.textChars as the sum of the text length', () => {
    // abc (3) + hello (5) + say HELLO!! (11) + no text (0) = 19.
    expect(holds(num('chat.textChars', '==', 19))).toBe(true);
    expect(holds(num('chat.textChars', '>', 18))).toBe(true);
    expect(holds(num('chat.textChars', '>', 19))).toBe(false);
    expect(holds(num('chat.textChars', '<=', 19))).toBe(true);
    expect(holds(num('chat.textChars', '<', 19))).toBe(false);
    expect(holds(num('chat.textChars', '>=', 20))).toBe(false);
    expect(holds(num('chat.textChars', '!=', 19))).toBe(false);
  });

  it('counts the messages that contain a keyword in chat.keywordHits, ignoring case', () => {
    const hits = (op: string, value: number, keywords: string[]) => holds({ metric: 'chat.keywordHits', op, value, keywords } as AgentScheduleCondition);
    expect(hits('==', 2, ['hello'])).toBe(true);
    expect(hits('==', 2, ['HeLLo'])).toBe(true);
    // A message with two keywords counts once.
    expect(hits('==', 3, ['hello', 'abc'])).toBe(true);
    expect(hits('==', 1, ['hello', 'say'])).toBe(false);
    expect(hits('>', 0, ['nothing'])).toBe(false);
    expect(hits('==', 0, ['nothing'])).toBe(true);
    expect(hits('>=', 3, ['abc', 'hello'])).toBe(true);
    expect(hits('<', 3, ['hello'])).toBe(true);
    expect(hits('<=', 1, ['hello'])).toBe(false);
    expect(hits('!=', 2, ['hello'])).toBe(false);
  });

  it('compares chat.id and chat.type with == != in not_in', () => {
    const text = (metric: string, op: string, value: string | string[]) => holds({ metric, op, value } as AgentScheduleCondition);
    expect(text('chat.id', '==', 'a')).toBe(true);
    expect(text('chat.id', '==', 'b')).toBe(false);
    expect(text('chat.id', '!=', 'b')).toBe(true);
    expect(text('chat.id', '!=', 'a')).toBe(false);
    expect(text('chat.id', 'in', ['x', 'a'])).toBe(true);
    expect(text('chat.id', 'in', ['x', 'y'])).toBe(false);
    expect(text('chat.id', 'not_in', ['x', 'y'])).toBe(true);
    expect(text('chat.id', 'not_in', ['a'])).toBe(false);
    expect(text('chat.type', '==', 'group')).toBe(true);
    expect(text('chat.type', '==', 'direct')).toBe(false);
    expect(text('chat.type', '!=', 'direct')).toBe(true);
    expect(text('chat.type', 'in', ['direct', 'group'])).toBe(true);
    expect(text('chat.type', 'not_in', ['group', 'room'])).toBe(false);
  });

  it('evaluates all and any, nested groups, and the first true rule wins', () => {
    const yes = num('chat.messageCount', '==', 4);
    const no = num('chat.messageCount', '==', 9);
    expect(decide({ all: [yes, yes] })).toBe('skip');
    expect(decide({ all: [yes, no] })).toBe('list');
    expect(decide({ any: [no, yes] })).toBe('skip');
    expect(decide({ any: [no, no] })).toBe('list');
    expect(decide({ any: [no, { all: [yes, yes] }] })).toBe('skip');
    expect(decide({ any: [no, { all: [yes, no] }] })).toBe('list');
    expect(decide({ all: [yes, { any: [no, yes] }, { all: [yes] }] })).toBe('skip');
    expect(decide({ all: [yes, { any: [no, no] }] })).toBe('list');
    const rules: AgentScheduleRule[] = [{ when: no as never, then: 'skip' }, { when: yes as never, then: 'llm' }, { when: yes as never, then: 'skip' }];
    expect(run(chat(), { rules }).chats[0]!.action).toBe('llm');
    expect(run(chat(), { rules: [rules[2]!, rules[1]!] }).chats[0]!.action).toBe('skip');
  });

  it('lists a chat when no rule is true or there are no rules', () => {
    expect(run(chat()).chats[0]!.action).toBe('list');
    expect(run(chat(), { rules: [] }).chats[0]!.action).toBe('list');
    expect(run(chat(), { rules: [{ when: num('chat.messageCount', '>', 100) as never, then: 'skip' }] }).chats[0]!.action).toBe('list');
  });

  it('treats an unknown metric as false and never runs text as code', () => {
    expect(holds({ metric: 'chat.unknown', op: '>', value: 0 } as never)).toBe(false);
    expect(holds({ metric: 'message.kind', op: '==', value: 'text' } as never)).toBe(false);
    expect(holds({ metric: 'chat.id', op: 'eval', value: 'a' } as never)).toBe(false);
    expect(holds({ sql: 'select 1' } as never)).toBe(false);
  });
});

describe('run metrics', () => {
  it('computes run.messageCount, run.chatCount and run.listedChars from the filtered messages', () => {
    const messages = [msg('a', 1, { text: 'x' }), msg('a', 2, { text: 'y' }), msg('b', 3, { text: 'z' }), msg('c', 4, { text: 'own', direction: 'outbound' })];
    const filter = { metric: 'message.direction', op: '==', value: 'inbound' } as AgentScheduleCondition;
    const base = run(messages, { messageFilter: filter as never });
    expect(base).toMatchObject({ messageCount: 3, chatCount: 2 });
    expect(base.listedChars).toBe(base.chats.map((chat) => chat.text).join('\n\n').length);
    const decide = (when: AgentScheduleCondition) => run(messages, { messageFilter: filter as never, rules: [{ when: when as never, then: 'skip' }] }).chats.map((chat) => chat.action);
    expect(decide(num('run.messageCount', '==', 3))).toEqual(['skip', 'skip']);
    expect(decide(num('run.messageCount', '>', 3))).toEqual(['list', 'list']);
    expect(decide(num('run.chatCount', '==', 2))).toEqual(['skip', 'skip']);
    expect(decide(num('run.chatCount', '<', 2))).toEqual(['list', 'list']);
    expect(decide(num('run.listedChars', '==', base.listedChars))).toEqual(['skip', 'skip']);
    expect(decide(num('run.listedChars', '>', base.listedChars))).toEqual(['list', 'list']);
    expect(decide(num('run.listedChars', '<=', base.listedChars - 1))).toEqual(['list', 'list']);
    expect(decide(num('run.listedChars', '>=', base.listedChars))).toEqual(['skip', 'skip']);
    expect(decide(num('run.listedChars', '!=', base.listedChars))).toEqual(['list', 'list']);
    expect(decide(num('run.messageCount', '<=', 3))).toEqual(['skip', 'skip']);
    expect(decide(num('run.chatCount', '!=', 2))).toEqual(['list', 'list']);
    expect(decide(num('run.chatCount', '>=', 3))).toEqual(['list', 'list']);
  });

  it('counts run.listedChars before any skip or llm action and includes the cut of long chats', () => {
    const messages = Array.from({ length: 30 }, (_, i) => msg('a', i + 1, { text: 'x'.repeat(50) }));
    const result = run(messages, { rules: [{ when: num('run.listedChars', '>', 0) as never, then: 'skip' }] });
    expect(result.chats[0]!.action).toBe('skip');
    expect(result.listedChars).toBe(result.chats[0]!.text.length);
    expect(result.chats[0]!.text).toContain('另有 10 則');
  });

  it('returns no chats for no messages', () => {
    expect(run([])).toEqual({ chats: [], messageCount: 0, chatCount: 0, listedChars: 0 });
  });
});

describe('messageFilter', () => {
  const sample = [
    msg('a', 1, { text: 'Hello World' }), msg('a', 2, { direction: 'outbound', text: 'mine' }), msg('a', 3, { kind: 'sticker', text: null }),
    msg('a', 4, { kind: 'event', text: null }), msg('b', 5, { text: 'plain' }),
  ];
  const kept = (filter: AgentScheduleCondition | undefined) => run(sample, filter ? { messageFilter: filter as never } : {}).messageCount;

  it('keeps every message without a filter', () => { expect(kept(undefined)).toBe(5); });

  it('filters by direction, kind and text with every op', () => {
    const leaf = (metric: string, op: string, value: unknown) => ({ metric, op, value }) as AgentScheduleCondition;
    expect(kept(leaf('message.direction', '==', 'inbound'))).toBe(4);
    expect(kept(leaf('message.direction', '!=', 'inbound'))).toBe(1);
    expect(kept(leaf('message.direction', 'in', ['inbound', 'outbound']))).toBe(5);
    expect(kept(leaf('message.direction', 'not_in', ['outbound']))).toBe(4);
    expect(kept(leaf('message.kind', '==', 'sticker'))).toBe(1);
    expect(kept(leaf('message.kind', '!=', 'sticker'))).toBe(4);
    expect(kept(leaf('message.kind', 'in', ['sticker', 'event']))).toBe(2);
    expect(kept(leaf('message.kind', 'not_in', ['sticker', 'event']))).toBe(3);
    expect(kept(leaf('message.textContains', 'any_of', ['WORLD']))).toBe(1);
    expect(kept(leaf('message.textContains', 'any_of', ['nothing', 'plain']))).toBe(1);
    expect(kept(leaf('message.textContains', 'none_of', ['hello']))).toBe(4);
    // A message without text matches none_of and never any_of.
    expect(kept(leaf('message.textContains', 'none_of', ['zzz']))).toBe(5);
  });

  it('combines leaves with all, any and nested groups', () => {
    const dir = { metric: 'message.direction', op: '==', value: 'inbound' };
    const kind = { metric: 'message.kind', op: 'not_in', value: ['sticker', 'event'] };
    expect(kept({ all: [dir, kind] } as never)).toBe(2);
    expect(kept({ any: [{ metric: 'message.kind', op: '==', value: 'event' }, { metric: 'message.direction', op: '==', value: 'outbound' }] } as never)).toBe(2);
    expect(kept({ all: [dir, { any: [{ metric: 'message.kind', op: '==', value: 'sticker' }, { metric: 'message.textContains', op: 'any_of', value: ['plain'] }] }] } as never)).toBe(2);
  });

  it('applies the filter before grouping, so a chat without passing messages disappears', () => {
    const only = run(sample, { messageFilter: { metric: 'message.textContains', op: 'any_of', value: ['plain'] } as never });
    expect(only.chats.map((chat) => chat.chatId)).toEqual(['b']);
    expect(messagePasses(undefined, sample[0]!)).toBe(true);
    expect(messagePasses({ metric: 'chat.messageCount', op: '>', value: 0 } as never, sample[0]!)).toBe(false);
  });
});

describe('the real case', () => {
  // Skip two chats; llm when chat.messageCount > 20 or run.listedChars > 2000 or (chat.senderCount >= 5 and keyword hits > 0);
  // drop own messages, stickers and events.
  const realTask = (): NewMessagesConfig => ({
    messageFilter: { all: [{ metric: 'message.direction', op: '==', value: 'inbound' }, { metric: 'message.kind', op: 'not_in', value: ['sticker', 'event'] }] },
    rules: [
      { when: { metric: 'chat.id', op: 'in', value: ['noise1', 'noise2'] }, then: 'skip' },
      { when: { any: [
        { metric: 'chat.messageCount', op: '>', value: 20 },
        { metric: 'run.listedChars', op: '>', value: 2000 },
        { all: [{ metric: 'chat.senderCount', op: '>=', value: 5 }, { metric: 'chat.keywordHits', op: '>', value: 0, keywords: ['急', '重要'] }] },
      ] }, then: 'llm' },
    ],
  });
  const crowd = (chatId: string, count: number) => Array.from({ length: count }, (_, i) => msg(chatId, (i % 55) + 1, { senderName: `人${i % 3}`, senderId: `p${i % 3}`, text: `嗨${i}` }));
  const voices = (chatId: string, senders: number, keyword: string) => Array.from({ length: senders }, (_, i) => msg(chatId, i + 1, { senderName: `S${i}`, senderId: `s${i}`, text: i === 0 ? `${keyword}事項` : '好' }));

  it('decides each chat as the user described', () => {
    const messages = [
      ...crowd('noise1', 40), ...crowd('noise2', 3),
      ...crowd('busy', 21),
      ...voices('team', 5, '重要'),
      ...voices('nokeyword', 5, '閒聊'),
      ...voices('fewpeople', 4, '急'),
      msg('quiet', 7, { text: '收到' }), msg('quiet', 8, { direction: 'outbound', text: '我的回覆' }),
      msg('onlynoise', 9, { kind: 'sticker', text: null }), msg('onlynoise', 10, { kind: 'event', text: null }),
      msg('mine', 11, { direction: 'outbound', text: 'only me' }),
    ];
    const result = run(messages, realTask());
    const actions = Object.fromEntries(result.chats.map((chat) => [chat.chatId, chat.action]));
    expect(actions).toEqual({ noise1: 'skip', noise2: 'skip', busy: 'llm', team: 'llm', nokeyword: 'list', fewpeople: 'list', quiet: 'list' });
    // Own messages, stickers and events do not count: quiet has one message; onlynoise and mine are gone.
    expect(result.chats.find((chat) => chat.chatId === 'quiet')!.messageCount).toBe(1);
    expect(result.chats.some((chat) => ['onlynoise', 'mine'].includes(chat.chatId))).toBe(false);
    expect(result.chats.find((chat) => chat.chatId === 'busy')!.messageCount).toBe(21);
    // 20 messages are not enough for the count rule.
    const twenty = run(crowd('busy', 20), realTask());
    expect(twenty.chats[0]!.action).toBe('list');
  });

  it('sends everything that is not skipped to the LLM when the listed text is longer than 2000 characters', () => {
    const long = Array.from({ length: 12 }, (_, i) => msg(`big${i}`, i + 1, { text: 'x'.repeat(190) }));
    const result = run(long, realTask());
    expect(result.listedChars).toBeGreaterThan(2000);
    expect(result.chats.every((chat) => chat.action === 'llm')).toBe(true);
    const small = run(long.slice(0, 3), realTask());
    expect(small.listedChars).toBeLessThanOrEqual(2000);
    expect(small.chats.every((chat) => chat.action === 'list')).toBe(true);
    // The skip rule comes first, so a skipped chat stays skipped although the run is long.
    const withNoise = run([...long, msg('noise1', 30, { text: 'hi' })], realTask());
    expect(withNoise.chats.find((chat) => chat.chatId === 'noise1')!.action).toBe('skip');
  });
});

describe('own list messages', () => {
  const own = { accountId: 'agent', chatType: 'direct' as const, chatId: 'admin' };
  const runOwn = (messages: ScheduleMessage[], extra: Partial<NewMessagesConfig> = {}) =>
    evaluateNewMessages({ task: task(extra), messages, window: WINDOW, ownDelivery: own });

  it('removes the sent list in the delivery chat and its copy in another account and chat', () => {
    const sent = msg('admin', 5, { accountId: 'agent', chatType: 'direct', direction: 'outbound', messageId: 'list-1', text: '清單' });
    const seen = msg('g1', 5, { accountId: 'second', direction: 'inbound', messageId: 'list-1', text: '清單' });
    const real = msg('g1', 6, { accountId: 'second', messageId: 'real-1' });
    const result = runOwn([sent, seen, real]);
    expect(result.messageCount).toBe(1);
    expect(result.chats.map((chat) => chat.chatId)).toEqual(['g1']);
    expect(result.chats[0]!.messageCount).toBe(1);
  });

  it('keeps everything when there is no ownDelivery, and keeps inbound messages of the delivery chat', () => {
    const sent = msg('admin', 5, { accountId: 'agent', chatType: 'direct', direction: 'outbound', messageId: 'list-1' });
    const seen = msg('g1', 5, { accountId: 'second', messageId: 'list-1' });
    expect(evaluateNewMessages({ task: task(), messages: [sent, seen], window: WINDOW }).messageCount).toBe(2);
    expect(evaluateNewMessages({ task: task(), messages: [sent, seen], window: WINDOW, ownDelivery: null }).messageCount).toBe(2);
    const inboundReply = msg('admin', 6, { accountId: 'agent', chatType: 'direct', direction: 'inbound', messageId: 'reply-1' });
    expect(runOwn([inboundReply]).messageCount).toBe(1);
  });
});

describe('copies of a group message in several accounts', () => {
  it('gives one block and correct counts for a group that two accounts store', () => {
    const a = msg('g1', 1, { accountId: 'one', messageId: 'x1', senderId: 'u9', senderName: '小華' });
    const b = { ...a, accountId: 'two' };
    const c = msg('g1', 2, { accountId: 'one', messageId: 'x2', senderId: 'u9', senderName: '小華' });
    const d = { ...c, accountId: 'two' };
    const result = run([a, b, c, d]);
    expect(result.chatCount).toBe(1);
    expect(result.messageCount).toBe(2);
    expect(result.chats[0]).toMatchObject({ accountId: 'one', messageCount: 2, senderCount: 1 });
    expect(result.chats[0]!.text.startsWith(`【群組g1】${RANGE} · 2 則`)).toBe(true);
  });

  it('keeps the outbound copy so that a direction filter treats the message as outbound', () => {
    const inbound = msg('g1', 1, { accountId: 'one', messageId: 'x1', direction: 'inbound' });
    const outbound = { ...inbound, accountId: 'two', direction: 'outbound' as const };
    const dir = (value: string) => ({ metric: 'message.direction', op: '==', value }) as never;
    expect(run([inbound, outbound], { messageFilter: dir('outbound') }).messageCount).toBe(1);
    expect(run([outbound, inbound], { messageFilter: dir('outbound') }).messageCount).toBe(1);
    expect(run([inbound, outbound], { messageFilter: dir('inbound') }).messageCount).toBe(0);
  });

  it('merges the identical copies of a direct message of one account (the key has no counter)', () => {
    const one = msg('d1', 1, { accountId: 'one', chatType: 'direct', messageId: 'x1' });
    expect(run([one, { ...one }, { ...one }]).messageCount).toBe(1);
  });

  it('does not merge direct chats, and does not merge different message ids or chats', () => {
    const one = msg('d1', 1, { accountId: 'one', chatType: 'direct', messageId: 'x1' });
    const two = { ...one, accountId: 'two' };
    const result = run([one, two]);
    expect(result.chatCount).toBe(2);
    expect(result.messageCount).toBe(2);
    expect(run([msg('g1', 1, { messageId: 'x1' }), msg('g2', 1, { messageId: 'x1' }), msg('g1', 2, { messageId: 'x2' })]).messageCount).toBe(3);
  });
});

describe('cap of one list', () => {
  // 20 chats, 20 messages each, 200 characters each: one chat is about 4.5k characters.
  const manyChats = (count: number): ScheduleMessage[] => Array.from({ length: count }, (_, index) => Array.from({ length: 20 }, (_, i) =>
    msg(`c${String(index).padStart(2, '0')}`, 0, { text: 'a'.repeat(200), occurredAt: new Date(Date.UTC(2026, 9, 1, 0, 59 - index, i)).toISOString() }))).flat();

  it('stops at a chat boundary and counts the chats and messages that it did not list', () => {
    const result = run(manyChats(20), { maxTextChars: 200 });
    const parts = listedText(result.chats, false).split('\n\n');
    const last = parts[parts.length - 1]!;
    const listed = parts.length - 1;
    expect(listed).toBeGreaterThan(0);
    expect(listed).toBeLessThan(20);
    expect(last).toBe(`（已達單次傳送上限，另有 ${20 - listed} 個聊天室、${(20 - listed) * 20} 則未列出）`);
    expect(parts.slice(0, listed).join('\n\n').length).toBeLessThanOrEqual(NEW_MESSAGES_LIST_CHARS_CAP);
    expect(parts.slice(0, listed)).toEqual(result.chats.slice(0, listed).map((chat) => chat.text));
    expect(result.listedChars).toBeGreaterThan(NEW_MESSAGES_LIST_CHARS_CAP);
  });

  it('puts the incomplete line after the cap line', () => {
    const parts = listedText(run(manyChats(20), { maxTextChars: 200 }).chats, true).split('\n\n');
    expect(parts[parts.length - 1]).toBe(NEW_MESSAGES_INCOMPLETE_LINE);
    expect(parts[parts.length - 2]).toMatch(/^（已達單次傳送上限，另有 \d+ 個聊天室、\d+ 則未列出）$/);
  });

  it('cuts one oversize first chat without splitting a surrogate pair and counts only the other chats', () => {
    const lines = Array.from({ length: 200 }, (_, index) => msg('huge', 59, { text: '😀'.repeat(250), occurredAt: new Date(Date.UTC(2026, 9, 1, 0, 59, index)).toISOString() }));
    const result = run([...lines, msg('small', 1, { text: 'x' })], { maxMessagesPerChat: 200, maxTextChars: 2000 });
    expect(result.chats[0]!.chatId).toBe('huge');
    expect(result.chats[0]!.text.length).toBeGreaterThan(NEW_MESSAGES_LIST_CHARS_CAP);
    const text = listedText(result.chats, false);
    const split = text.lastIndexOf('\n\n');
    const head = text.slice(0, split);
    expect(head.length).toBeLessThanOrEqual(NEW_MESSAGES_LIST_CHARS_CAP);
    expect(head.length).toBeGreaterThan(NEW_MESSAGES_LIST_CHARS_CAP - 2);
    const lastCode = head.charCodeAt(head.length - 1);
    expect(lastCode >= 0xd800 && lastCode <= 0xdbff).toBe(false);
    expect(text.slice(split + 2)).toBe('（已達單次傳送上限，此聊天室其餘內容與另外 1 個聊天室、1 則未列出）');
  });

  it('says only that the rest of the chat is not listed when the first chat is cut and no other chat is listed', () => {
    const lines = Array.from({ length: 200 }, (_, index) => msg('huge', 59, { text: 'a'.repeat(300), occurredAt: new Date(Date.UTC(2026, 9, 1, 0, 59, index)).toISOString() }));
    const result = run(lines, { maxMessagesPerChat: 200, maxTextChars: 2000 });
    expect(result.chats[0]!.text.length).toBeGreaterThan(NEW_MESSAGES_LIST_CHARS_CAP);
    const text = listedText(result.chats, false);
    expect(text.endsWith('\n\n（已達單次傳送上限，此聊天室其餘內容未列出）')).toBe(true);
    expect(text).not.toContain('另有 0');
  });

  it('keeps the plain cap line when the first chat is not cut', () => {
    const text = listedText(run(manyChats(20), { maxTextChars: 200 }).chats, false);
    expect(text).not.toContain('此聊天室其餘內容');
  });

  it('adds no cap line when everything fits', () => {
    expect(listedText(run([msg('a', 1), msg('b', 2)]).chats, false)).not.toContain('已達單次傳送上限');
    expect(NEW_MESSAGES_LIST_CHARS_CAP).toBe(49000);
  });
});
