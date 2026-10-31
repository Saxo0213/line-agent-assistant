import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Pool } from 'pg';
import type { AgentScheduleCreateInput, AgentScheduleNewMessagesTask } from '@line-agent/contracts';
import { AgentScheduleRepository, type AgentScheduleClaim } from '@line-agent/database';
import { createTestDatabase } from '../../../../../packages/database/src/test-database.js';
import { AgentScheduleService, type AgentScheduleStore } from './agent-schedule-service.js';
import type { AgentScheduleMessageRead, AgentScheduleMessageReader } from './agent-schedule-reader.js';
import { NEW_MESSAGES_EMPTY_LINE, NEW_MESSAGES_INCOMPLETE_LINE, type ScheduleMessage } from './agent-schedule-rules.js';

const SCHEDULE_ID = '11111111-1111-4111-8111-111111111111';
const SLOT = new Date('2026-10-01T01:00:00.000Z');
const RANGE = '10/1 08:00–09:00';
const ADMIN = { accountId: 'agent', chatId: 'u-admin', title: '管理員' };

const newTask = (extra: Partial<AgentScheduleNewMessagesTask> = {}): AgentScheduleNewMessagesTask =>
  ({ type: 'new_messages', maxMessagesPerChat: 20, maxTextChars: 200, sendWhenEmpty: false, ...extra });
const llmWhen = (chatId: string, then: 'llm' | 'skip' | 'list') => ({ when: { metric: 'chat.id' as const, op: '==' as const, value: chatId }, then });
let counter = 0;
let idCounter = 0;
const msg = (chatId: string, minute: number, overrides: Partial<ScheduleMessage> = {}): ScheduleMessage => ({
  accountId: 'agent', chatType: 'group', chatId, messageId: `m${++idCounter}`, conversationTitle: `群組${chatId}`, senderId: 'u1', senderName: '小明', direction: 'inbound', kind: 'text',
  text: `內容${++counter}`, recalled: false, occurredAt: new Date(Date.UTC(2026, 9, 1, 0, minute)).toISOString(), ...overrides,
});
const claim = (task: AgentScheduleNewMessagesTask, overrides: Partial<AgentScheduleClaim> = {}): AgentScheduleClaim => ({
  runId: 'run-1', scheduleId: SCHEDULE_ID, scheduledFor: SLOT, title: '新訊息', prompt: '', provider: 'claude', recurrence: { kind: 'daily', time: '09:00' }, timezone: 'Asia/Taipei',
  targets: [], task, window: { mode: 'lookback', minutes: 60 }, delivery: { mode: 'primary_admin' }, previousSubmittedFor: null, ...overrides,
});

function fakeStore(claims: AgentScheduleClaim[]) {
  const queue = [claims];
  return {
    list: vi.fn(async () => []), get: vi.fn(async () => null), listRuns: vi.fn(async () => []),
    create: vi.fn(async () => ({}) as never), update: vi.fn(async () => ({}) as never), delete: vi.fn(async () => true), recoverStale: vi.fn(async () => 0),
    claimDue: vi.fn(async () => { const next = queue.shift() ?? []; return { claims: next, changed: next.length > 0 }; }),
    markSubmitted: vi.fn(async () => true), markFailed: vi.fn(async () => true), markSent: vi.fn(async () => true), markSendFailed: vi.fn(async () => true),
    markSendUnknown: vi.fn(async () => true), markNoMessages: vi.fn(async () => true), previousSubmittedFor: vi.fn(async (): Promise<Date | null> => null),
  } satisfies AgentScheduleStore;
}

function harness(messages: ScheduleMessage[], c: AgentScheduleClaim, options: {
  send?: 'sent' | 'failed' | 'unknown' | Error; incomplete?: boolean; admin?: typeof ADMIN | null; reader?: AgentScheduleMessageReader | null; submitError?: Error;
} = {}) {
  const store = fakeStore([c]);
  const order: string[] = [];
  const reader = vi.fn<AgentScheduleMessageReader>(async (): Promise<AgentScheduleMessageRead> => ({ messages, incomplete: options.incomplete ?? false }));
  const sendSystemText = vi.fn(async (_input: { runId: string; target: unknown; text: string }) => {
    order.push('send');
    if (options.send instanceof Error) throw options.send;
    return { status: options.send ?? 'sent' };
  });
  const submit = vi.fn(async (_input: { provider: string; requestId: string; prompt: string }) => {
    order.push('submit');
    if (options.submitError) throw options.submitError;
    return { jobId: 'job-1' };
  });
  const onError = vi.fn();
  const publish = vi.fn();
  const service = new AgentScheduleService({
    store, submit: submit as never, sendSystemText: sendSystemText as never, ...(options.reader === null ? {} : { readMessages: options.reader ?? reader }),
    primaryAdminChat: async () => options.admin === undefined ? ADMIN : options.admin, onError, publish, now: () => SLOT,
  });
  return { store, reader, sendSystemText, submit, onError, publish, order, service };
}
const noEffects = (h: ReturnType<typeof harness>) => {
  expect(h.sendSystemText).not.toHaveBeenCalled();
  expect(h.submit).not.toHaveBeenCalled();
};

describe('new_messages run', () => {
  it('marks no_messages and sends nothing when the window has no messages', async () => {
    const h = harness([], claim(newTask()));
    await h.service.tick();
    expect(h.store.markNoMessages).toHaveBeenCalledWith('run-1');
    noEffects(h);
    for (const mark of ['markSent', 'markSendFailed', 'markSendUnknown', 'markFailed', 'markSubmitted'] as const) expect(h.store[mark]).not.toHaveBeenCalled();
    expect(h.publish).toHaveBeenCalled();
  });

  it('marks no_messages when every chat has action skip', async () => {
    const h = harness([msg('a', 1), msg('b', 2)], claim(newTask({ rules: [{ when: { metric: 'chat.messageCount', op: '>', value: 0 }, then: 'skip' }] })));
    await h.service.tick();
    expect(h.store.markNoMessages).toHaveBeenCalledWith('run-1');
    noEffects(h);
  });

  it('marks no_messages when the filter removes every message', async () => {
    const h = harness([msg('a', 1, { direction: 'outbound' })], claim(newTask({ messageFilter: { metric: 'message.direction', op: '==', value: 'inbound' } })));
    await h.service.tick();
    expect(h.store.markNoMessages).toHaveBeenCalledWith('run-1');
    noEffects(h);
  });

  it('sends one text and creates no job when every chat is listed', async () => {
    const h = harness([msg('a', 1, { text: '早' }), msg('b', 2, { text: '午' })], claim(newTask()));
    await h.service.tick();
    expect(h.sendSystemText).toHaveBeenCalledTimes(1);
    expect(h.sendSystemText).toHaveBeenCalledWith({ runId: 'run-1', target: { accountId: 'agent', chatType: 'direct', chatId: 'u-admin', title: '管理員' },
      text: `【群組b】${RANGE} · 1 則\n• 08:02 [小明]：午\n\n【群組a】${RANGE} · 1 則\n• 08:01 [小明]：早` });
    expect(h.submit).not.toHaveBeenCalled();
    expect(h.store.markSent).toHaveBeenCalledWith('run-1');
    expect(h.store.markNoMessages).not.toHaveBeenCalled();
  });

  it('sends the listed chats and creates one job for the llm chats only', async () => {
    const task = newTask({ rules: [llmWhen('big', 'llm'), llmWhen('huge', 'llm'), llmWhen('noise', 'skip')] });
    const h = harness([msg('small', 1, { text: '小聊' }), msg('big', 2), msg('huge', 3), msg('noise', 4, { text: '吵' })], claim(task));
    await h.service.tick();
    expect(h.order).toEqual(['send', 'submit']);
    const sent = h.sendSystemText.mock.calls[0]![0].text;
    expect(sent).toBe(`【群組small】${RANGE} · 1 則\n• 08:01 [小明]：小聊`);
    expect(sent).not.toContain('群組big');
    expect(sent).not.toContain('吵');
    expect(h.submit).toHaveBeenCalledTimes(1);
    expect(h.submit).toHaveBeenCalledWith({ provider: 'claude', requestId: `schedule:${SCHEDULE_ID}:2026-10-01T01:00:00.000Z`,
      prompt: `[排程] 新訊息\n任務：新訊息整理\n來源：群組huge（群組）、群組big（群組）\n範圍：${RANGE}\n輸出：傳給管理員` });
    expect(h.store.markSubmitted).toHaveBeenCalledWith('run-1', 'job-1');
    expect(h.store.markSent).not.toHaveBeenCalled();
  });

  it('creates a job and sends nothing when only llm chats remain', async () => {
    const h = harness([msg('big', 1)], claim(newTask({ rules: [llmWhen('big', 'llm')] }), { prompt: '特別注意金額' }));
    await h.service.tick();
    expect(h.sendSystemText).not.toHaveBeenCalled();
    expect(h.submit).toHaveBeenCalledTimes(1);
    expect(h.submit.mock.calls[0]![0].prompt).toBe(`[排程] 新訊息\n任務：新訊息整理\n來源：群組big（群組）\n範圍：${RANGE}\n輸出：傳給管理員\n補充：特別注意金額`);
    expect(h.store.markSubmitted).toHaveBeenCalledWith('run-1', 'job-1');
  });

  it('marks send_failed and creates no job when the send fails', async () => {
    const h = harness([msg('small', 1), msg('big', 2)], claim(newTask({ rules: [llmWhen('big', 'llm')] })), { send: 'failed' });
    await h.service.tick();
    expect(h.store.markSendFailed).toHaveBeenCalledWith('run-1');
    expect(h.submit).not.toHaveBeenCalled();
    expect(h.store.markSent).not.toHaveBeenCalled();
    expect(h.store.markSubmitted).not.toHaveBeenCalled();
  });

  it('marks send_unknown, creates no job and never retries when the result is unknown', async () => {
    const h = harness([msg('small', 1), msg('big', 2)], claim(newTask({ rules: [llmWhen('big', 'llm')] })), { send: 'unknown' });
    await h.service.tick();
    await h.service.tick();
    expect(h.store.markSendUnknown).toHaveBeenCalledWith('run-1');
    expect(h.sendSystemText).toHaveBeenCalledTimes(1);
    expect(h.submit).not.toHaveBeenCalled();
    expect(h.store.markSendFailed).not.toHaveBeenCalled();
  });

  it('marks send_failed and reports the error when the send throws', async () => {
    const boom = new Error('line queue closed');
    const h = harness([msg('small', 1)], claim(newTask()), { send: boom });
    await h.service.tick();
    expect(h.onError).toHaveBeenCalledWith(boom);
    expect(h.store.markSendFailed).toHaveBeenCalledWith('run-1');
    expect(h.store.markFailed).not.toHaveBeenCalled();
    expect(h.submit).not.toHaveBeenCalled();
  });

  it('marks failed and reports the real error when the read fails', async () => {
    const readError = Object.assign(new Error('Requested LINE account is unavailable'), { code: 'SCOPE_DENIED' });
    const h = harness([], claim(newTask()), { reader: vi.fn(async () => { throw readError; }) });
    await h.service.tick();
    expect(h.onError).toHaveBeenCalledWith(readError);
    expect(h.store.markFailed).toHaveBeenCalledWith('run-1');
    noEffects(h);
    expect(h.store.markNoMessages).not.toHaveBeenCalled();
  });

  it('marks failed when no reader is configured, and when the job cannot be created', async () => {
    const none = harness([], claim(newTask()), { reader: null });
    await none.service.tick();
    expect(none.store.markFailed).toHaveBeenCalledWith('run-1');
    expect(none.onError).toHaveBeenCalledTimes(1);
    const boom = new Error('provider closed');
    const h = harness([msg('big', 1)], claim(newTask({ rules: [llmWhen('big', 'llm')] })), { submitError: boom });
    await h.service.tick();
    expect(h.onError).toHaveBeenCalledWith(boom);
    expect(h.store.markFailed).toHaveBeenCalledWith('run-1');
  });

  it('puts the incomplete line at the end of the sent text when the read stopped at the cap', async () => {
    const h = harness([msg('a', 1, { text: '一' })], claim(newTask()), { incomplete: true });
    await h.service.tick();
    expect(h.sendSystemText.mock.calls[0]![0].text.endsWith(`\n\n${NEW_MESSAGES_INCOMPLETE_LINE}`)).toBe(true);
    expect(h.store.markSent).toHaveBeenCalled();
  });

  it('passes a long text as one call (the send service splits it)', async () => {
    const messages = Array.from({ length: 30 }, (_, i) => msg(`c${i}`, 1, { text: 'x'.repeat(190) }));
    const h = harness(messages, claim(newTask()));
    await h.service.tick();
    expect(h.sendSystemText).toHaveBeenCalledTimes(1);
    expect(h.sendSystemText.mock.calls[0]![0].text.length).toBeGreaterThan(5_000);
  });

  describe('sendWhenEmpty', () => {
    it('sends the empty line and marks sent when there are no messages', async () => {
      const h = harness([], claim(newTask({ sendWhenEmpty: true })));
      await h.service.tick();
      expect(NEW_MESSAGES_EMPTY_LINE).toBe('此時段沒有新訊息');
      expect(h.sendSystemText).toHaveBeenCalledTimes(1);
      expect(h.sendSystemText.mock.calls[0]![0].text).toBe('此時段沒有新訊息');
      expect(h.store.markSent).toHaveBeenCalledWith('run-1');
      expect(h.store.markNoMessages).not.toHaveBeenCalled();
      expect(h.submit).not.toHaveBeenCalled();
    });

    it('also sends it when every chat is skipped, and marks the send result', async () => {
      const rules = [{ when: { metric: 'chat.messageCount' as const, op: '>' as const, value: 0 }, then: 'skip' as const }];
      for (const [status, mark] of [['failed', 'markSendFailed'], ['unknown', 'markSendUnknown'], ['sent', 'markSent']] as const) {
        const h = harness([msg('a', 1)], claim(newTask({ sendWhenEmpty: true, rules })), { send: status });
        await h.service.tick();
        expect(h.sendSystemText.mock.calls[0]![0].text).toBe('此時段沒有新訊息');
        expect(h.store[mark]).toHaveBeenCalledWith('run-1');
        expect(h.submit).not.toHaveBeenCalled();
      }
    });

    it('sends no empty line when something is listed or an llm chat remains', async () => {
      const listed = harness([msg('a', 1, { text: '有' })], claim(newTask({ sendWhenEmpty: true })));
      await listed.service.tick();
      expect(listed.sendSystemText.mock.calls[0]![0].text).not.toContain('此時段沒有新訊息');
      const llm = harness([msg('big', 1)], claim(newTask({ sendWhenEmpty: true, rules: [llmWhen('big', 'llm')] })));
      await llm.service.tick();
      expect(llm.sendSystemText).not.toHaveBeenCalled();
      expect(llm.submit).toHaveBeenCalledTimes(1);
    });
  });

  describe('delivery', () => {
    it('sends to the Primary Admin direct chat by default and fails the send when there is none', async () => {
      const h = harness([msg('a', 1)], claim(newTask()));
      await h.service.tick();
      expect(h.sendSystemText.mock.calls[0]![0].target).toEqual({ accountId: 'agent', chatType: 'direct', chatId: 'u-admin', title: '管理員' });
      const none = harness([msg('a', 1)], claim(newTask()), { admin: null });
      await none.service.tick();
      expect(none.sendSystemText).not.toHaveBeenCalled();
      expect(none.store.markSendFailed).toHaveBeenCalledWith('run-1');
      expect(none.submit).not.toHaveBeenCalled();
    });

    it('sends to the chosen line_target', async () => {
      const target = { accountId: 'agent', chatType: 'group' as const, chatId: 'team', title: '團隊' };
      const h = harness([msg('a', 1)], claim(newTask(), { delivery: { mode: 'line_target', target } }));
      await h.service.tick();
      expect(h.sendSystemText.mock.calls[0]![0].target).toEqual(target);
      expect(h.store.markSent).toHaveBeenCalledWith('run-1');
    });

    it('fails the send of a record_only delivery (which a new_messages task never has)', async () => {
      const h = harness([msg('a', 1)], claim(newTask(), { delivery: { mode: 'record_only' } }));
      await h.service.tick();
      expect(h.sendSystemText).not.toHaveBeenCalled();
      expect(h.store.markSendFailed).toHaveBeenCalledWith('run-1');
    });

    it('does not need a delivery target when only llm chats remain', async () => {
      const h = harness([msg('big', 1)], claim(newTask({ rules: [llmWhen('big', 'llm')] })), { admin: null });
      await h.service.tick();
      expect(h.submit).toHaveBeenCalledTimes(1);
      expect(h.store.markSendFailed).not.toHaveBeenCalled();
    });
  });

  describe('window and scope', () => {
    it('reads the window of computeScheduleWindow with the claim targets', async () => {
      const targets = [{ accountId: 'agent', chatType: 'group' as const, chatId: 'g1', title: 'G1' }];
      const previous = new Date('2026-10-01T00:20:00.000Z');
      const h = harness([], claim(newTask(), { targets, window: { mode: 'since_last_run' }, previousSubmittedFor: previous }));
      await h.service.tick();
      expect(h.reader).toHaveBeenCalledWith({ from: previous, to: SLOT, targets });
      const lookback = harness([], claim(newTask(), { window: { mode: 'lookback', minutes: 90 } }));
      await lookback.service.tick();
      expect(lookback.reader).toHaveBeenCalledWith({ from: new Date(SLOT.getTime() - 90 * 60_000), to: SLOT, targets: [] });
    });
  });
});

describe('runContext of a new_messages schedule', () => {
  const schedule = (task: AgentScheduleNewMessagesTask, extra: Record<string, unknown> = {}) => ({
    scheduleId: SCHEDULE_ID, title: '新訊息', prompt: '', provider: 'claude', recurrence: { kind: 'daily', time: '09:00' }, timezone: 'Asia/Taipei', targets: [], task,
    window: { mode: 'lookback', minutes: 60 }, delivery: { mode: 'primary_admin' }, jitterMinutes: 0, enabled: true, execution: 'program', mayUseLlm: true,
    nextFireAt: null, lastFireAt: null, lastOutcome: null, createdAt: '2026-10-01T00:00:00.000Z', updatedAt: '2026-10-01T00:00:00.000Z', ...extra,
  });
  const requestId = `schedule:${SCHEDULE_ID}:${SLOT.toISOString()}`;

  it('evaluates the rules again and tells the Agent to read only the llm chats', async () => {
    const h = harness([msg('small', 1), msg('big', 2), msg('noise', 3)], claim(newTask()));
    h.store.get.mockResolvedValue(schedule(newTask({ rules: [llmWhen('big', 'llm'), llmWhen('noise', 'skip')] }), { prompt: '看重點' }) as never);
    const context = (await h.service.runContext(requestId))!;
    expect(h.reader).toHaveBeenCalledWith({ from: new Date(SLOT.getTime() - 60 * 60_000), to: SLOT, targets: [] });
    expect(context).toContain('【排程規則】無人值守');
    expect(context).toContain(`時間：${RANGE}（台灣時間）；查詢用 UTC from=2026-10-01T00:00:00.000Z to=2026-10-01T01:00:00.000Z`);
    expect(context).toContain('分頁規則');
    expect(context).toContain('• 群組big（accountId=agent，chatType=group，chatId=big）');
    expect(context).not.toContain('群組small');
    expect(context).not.toContain('群組noise');
    expect(context).toContain('任務：總結。每個來源一個區塊（純文字）');
    expect(context).toContain('人名規則');
    expect(context).toContain('用 send_to_target 傳給管理員（accountId=agent，chatType=direct，chatId=u-admin）');
    expect(context).toContain('補充：看重點');
    expect(h.sendSystemText).not.toHaveBeenCalled();
    expect(h.submit).not.toHaveBeenCalled();
  });

  it('uses the previous counted run for the window and keeps the other task types unchanged', async () => {
    const h = harness([msg('big', 1)], claim(newTask()));
    h.store.get.mockResolvedValue(schedule(newTask({ rules: [llmWhen('big', 'llm')] }), { window: { mode: 'since_last_run' } }) as never);
    h.store.previousSubmittedFor.mockResolvedValue(new Date('2026-10-01T00:30:00.000Z'));
    await h.service.runContext(requestId);
    expect(h.store.previousSubmittedFor).toHaveBeenCalledWith(SCHEDULE_ID, SLOT);
    expect(h.reader).toHaveBeenCalledWith({ from: new Date('2026-10-01T00:30:00.000Z'), to: SLOT, targets: [] });
    const other = harness([], claim(newTask()));
    other.store.get.mockResolvedValue(schedule({ type: 'custom' } as never, { prompt: '做事' }) as never);
    const text = (await other.service.runContext(requestId))!;
    expect(other.reader).not.toHaveBeenCalled();
    expect(text).toContain('指示：做事');
  });

  it('says there is no chat to process when no rule selects llm', async () => {
    const h = harness([msg('small', 1)], claim(newTask()));
    h.store.get.mockResolvedValue(schedule(newTask()) as never);
    const context = (await h.service.runContext(requestId))!;
    expect(context).toContain('沒有需要處理的聊天室');
    expect(context).not.toContain('chatId=small');
  });

  it('fails when the read fails, so the job runs with the unavailable note', async () => {
    const readError = new Error('db down');
    const h = harness([], claim(newTask()), { reader: vi.fn(async () => { throw readError; }) });
    h.store.get.mockResolvedValue(schedule(newTask({ rules: [llmWhen('big', 'llm')] })) as never);
    await expect(h.service.runContext(requestId)).rejects.toBe(readError);
  });
});

describe('previewNewMessages', () => {
  it('reads and evaluates the latest window that ends now, and never sends, submits or writes a run', async () => {
    const task = newTask({ rules: [llmWhen('big', 'llm'), llmWhen('noise', 'skip')] });
    const h = harness([msg('small', 1, { text: '小聊' }), msg('small', 2, { senderName: '小華', senderId: 'u2', text: '你好' }), msg('big', 3), msg('noise', 4)], claim(task));
    const result = await h.service.previewNewMessages({ task, targets: [], window: { mode: 'lookback', minutes: 60 } });
    expect(h.reader).toHaveBeenCalledWith({ from: new Date(SLOT.getTime() - 60 * 60_000), to: SLOT, targets: [] });
    expect(result).toMatchObject({ from: '2026-10-01T00:00:00.000Z', to: '2026-10-01T01:00:00.000Z', messageCount: 4, chatCount: 3, incomplete: false });
    expect(result.chats.map((chat) => [chat.chatId, chat.messageCount, chat.senderCount, chat.action])).toEqual([
      ['noise', 1, 1, 'skip'], ['big', 1, 1, 'llm'], ['small', 2, 2, 'list']]);
    expect(result.chats[2]).toMatchObject({ title: '群組small', text: `【群組small】${RANGE} · 2 則\n• 08:01 [小明]：小聊\n• 08:02 [小華]：你好` });
    expect(result.listedChars).toBeGreaterThan(0);
    noEffects(h);
    for (const mark of ['markSent', 'markSendFailed', 'markSendUnknown', 'markFailed', 'markSubmitted', 'markNoMessages', 'claimDue', 'create', 'update'] as const) {
      expect(h.store[mark]).not.toHaveBeenCalled();
    }
    expect(h.publish).not.toHaveBeenCalled();
  });

  it('reports an incomplete read, applies the default window and rejects a read failure with its error', async () => {
    const h = harness([msg('a', 1)], claim(newTask()), { incomplete: true });
    const result = await h.service.previewNewMessages({ task: newTask(), targets: [], window: { mode: 'since_last_run' } });
    expect(result.incomplete).toBe(true);
    // No schedule history: one day back (daily recurrence default).
    expect(h.reader).toHaveBeenCalledWith({ from: new Date(SLOT.getTime() - 24 * 3_600_000), to: SLOT, targets: [] });
    const failing = harness([], claim(newTask()), { reader: vi.fn(async () => { throw new Error('read broke'); }) });
    await expect(failing.service.previewNewMessages({ task: newTask(), targets: [], window: { mode: 'since_last_run' } })).rejects.toThrow('read broke');
    noEffects(failing);
  });

  it('validates the targets through the resolver and reads them', async () => {
    const h = harness([], claim(newTask()));
    const resolve = vi.fn(async (targets: readonly { accountId: string; chatType: 'group'; chatId: string; title: string }[]) => targets.map((target) => ({ ...target, title: '新標題' })));
    const service = new AgentScheduleService({ store: h.store, submit: h.submit as never, readMessages: h.reader, now: () => SLOT, targets: { resolve: resolve as never, list: async () => [] } });
    await service.previewNewMessages({ task: newTask(), targets: [{ accountId: 'agent', chatType: 'group', chatId: 'g1', title: '' }], window: { mode: 'lookback', minutes: 60 } });
    expect(resolve).toHaveBeenCalledTimes(1);
    expect(h.reader).toHaveBeenCalledWith({ from: new Date(SLOT.getTime() - 60 * 60_000), to: SLOT, targets: [{ accountId: 'agent', chatType: 'group', chatId: 'g1', title: '新標題' }] });
  });
});

const database = process.env.TEST_DATABASE_URL ? describe : describe.skip;
database('since_last_run window of a new_messages schedule with a real repository', () => {
  let pool: Pool;
  let close: () => Promise<void>;
  beforeAll(async () => { ({ pool, close } = await createTestDatabase()); });
  afterAll(async () => { await close(); });

  it('starts each window at the previous run that sent, found no messages or ended unknown', async () => {
    const repo = new AgentScheduleRepository(pool);
    const input: AgentScheduleCreateInput = { title: 't', prompt: '', provider: 'claude', recurrence: { kind: 'interval', everyMinutes: 60, anchorAt: '2026-10-01T00:00:00.000Z' },
      timezone: 'Asia/Taipei', targets: [], task: newTask({ rules: [llmWhen('big', 'llm')] }), window: { mode: 'since_last_run' }, delivery: { mode: 'primary_admin' }, jitterMinutes: 0, enabled: true };
    await repo.create(input, new Date('2026-09-30T23:50:00.000Z'));
    const hours = (n: number) => new Date(Date.UTC(2026, 9, 1, n));
    let now = hours(0);
    const rounds: Array<{ messages: ScheduleMessage[]; send: 'sent' | 'failed' | 'unknown' }> = [
      { messages: [], send: 'sent' },                                                  // hour 0: no_messages
      { messages: [msg('a', 61)], send: 'sent' },                                        // hour 1: sent
      { messages: [msg('a', 121)], send: 'unknown' },                                    // hour 2: send_unknown
      { messages: [msg('a', 181)], send: 'failed' },                                     // hour 3: send_failed (does not move the window)
      { messages: [msg('a', 241)], send: 'sent' },                                       // hour 4: sent, window starts at hour 2
    ];
    const windows: Array<[string, string]> = [];
    let round = 0;
    const service = new AgentScheduleService({
      store: repo, submit: vi.fn(async () => ({ jobId: 'j' })) as never, primaryAdminChat: async () => ADMIN, now: () => now,
      readMessages: async ({ from, to }) => { windows.push([from.toISOString(), to.toISOString()]); return { messages: rounds[round]!.messages, incomplete: false }; },
      sendSystemText: async () => ({ status: rounds[round]!.send }),
    });
    for (round = 0; round < rounds.length; round++) {
      // Round n claims the slot of hour n (the schedule was created at 23:50, so the first slot is 00:00).
      now = new Date(hours(round).getTime() + 1_000);
      await service.tick();
    }
    expect(windows).toEqual([
      ['2026-09-30T23:00:00.000Z', hours(0).toISOString()], // no earlier run: one interval back
      [hours(0).toISOString(), hours(1).toISOString()],
      [hours(1).toISOString(), hours(2).toISOString()],
      [hours(2).toISOString(), hours(3).toISOString()],
      [hours(2).toISOString(), hours(4).toISOString()],
    ]);
    const runs = await repo.listRuns((await repo.list())[0]!.scheduleId, 10);
    expect(runs.map((run) => run.outcome)).toEqual(['sent', 'send_failed', 'send_unknown', 'sent', 'no_messages']);
  });
});

describe('own list messages and the filter line', () => {
  const sentList = () => msg('u-admin', 5, { accountId: 'agent', chatType: 'direct', direction: 'outbound', messageId: 'list-1', text: '清單' });
  const seenList = () => msg('g2', 5, { accountId: 'second', messageId: 'list-1', text: '清單' });
  const schedule = (task: AgentScheduleNewMessagesTask) => ({
    scheduleId: SCHEDULE_ID, title: '新訊息', prompt: '', provider: 'claude', recurrence: { kind: 'daily', time: '09:00' }, timezone: 'Asia/Taipei', targets: [], task,
    window: { mode: 'lookback', minutes: 60 }, delivery: { mode: 'primary_admin' }, jitterMinutes: 0, enabled: true, execution: 'program', mayUseLlm: true,
    nextFireAt: null, lastFireAt: null, lastOutcome: null, createdAt: '2026-10-01T00:00:00.000Z', updatedAt: '2026-10-01T00:00:00.000Z',
  });
  const requestId = `schedule:${SCHEDULE_ID}:${SLOT.toISOString()}`;
  const filter = { metric: 'message.direction' as const, op: '==' as const, value: 'inbound' as const };

  it('does not list the own list message again in a run', async () => {
    const h = harness([sentList(), seenList(), msg('g1', 6, { text: '真訊息' })], claim(newTask()));
    await h.service.tick();
    const text = h.sendSystemText.mock.calls[0]![0].text;
    expect(text).toContain('真訊息');
    expect(text).not.toContain('清單');
    expect(text).toContain('· 1 則');
  });

  it('removes the own list from the llm chats of runContext', async () => {
    const task = newTask({ rules: [{ when: { metric: 'chat.messageCount', op: '>', value: 0 }, then: 'llm' }] });
    const h = harness([sentList(), seenList()], claim(task));
    h.store.get.mockResolvedValue(schedule(task) as never);
    const context = (await h.service.runContext(requestId))!;
    expect(context).toContain('沒有需要處理的聊天室');
    expect(context).not.toContain('g2');
  });

  it('keeps the send_failed outcome and reports the real error when the delivery lookup throws in the read step', async () => {
    const h = harness([msg('g1', 6, { text: '真訊息' })], claim(newTask()));
    const boom = new Error('lookup broke');
    const service = new AgentScheduleService({ store: h.store, submit: h.submit as never, sendSystemText: h.sendSystemText as never, readMessages: h.reader,
      primaryAdminChat: async () => { throw boom; }, onError: h.onError, now: () => SLOT });
    await service.tick();
    expect(h.onError).toHaveBeenCalledWith(boom);
    expect(h.store.markSendFailed).toHaveBeenCalledWith('run-1');
    expect(h.store.markFailed).not.toHaveBeenCalled();
  });

  it('removes the own list in the preview when it has a delivery, and keeps it when it has none', async () => {
    const h = harness([sentList(), seenList(), msg('g1', 6)], claim(newTask()));
    const base = { task: newTask(), targets: [], window: { mode: 'lookback' as const, minutes: 60 } };
    expect((await h.service.previewNewMessages({ ...base, delivery: { mode: 'primary_admin' } })).messageCount).toBe(1);
    expect((await h.service.previewNewMessages({ ...base, delivery: { mode: 'line_target', target: { accountId: 'agent', chatType: 'direct', chatId: 'u-admin', title: '' } } })).messageCount).toBe(1);
    expect((await h.service.previewNewMessages({ ...base, delivery: { mode: 'record_only' } })).messageCount).toBe(3);
    expect((await h.service.previewNewMessages(base)).messageCount).toBe(3);
  });

  it('tells the Agent about messageFilter only with a filter and an llm chat', async () => {
    const llm = [{ when: { metric: 'chat.id' as const, op: '==' as const, value: 'g1' }, then: 'llm' as const }];
    const withFilter = newTask({ messageFilter: filter, rules: llm });
    const h = harness([msg('g1', 6)], claim(withFilter));
    h.store.get.mockResolvedValue(schedule(withFilter) as never);
    const context = (await h.service.runContext(requestId))!;
    expect(context).toContain(`訊息過濾：只使用符合下列條件的訊息，其他訊息視為不存在。message.direction 的 inbound 是別人傳入、outbound 是自己傳出；message.kind 是訊息類型；message.textContains 比對文字且不分大小寫。條件：${JSON.stringify(filter)}`);
    expect(context.indexOf('訊息過濾')).toBeGreaterThan(context.indexOf('• 群組g1'));
    expect(context.indexOf('訊息過濾')).toBeLessThan(context.indexOf('任務：總結'));
    for (const task of [newTask({ rules: llm }), newTask({ messageFilter: filter }), newTask({ messageFilter: filter, rules: [llmWhen('g1', 'skip')] })]) {
      h.store.get.mockResolvedValue(schedule(task) as never);
      expect(await h.service.runContext(requestId)).not.toContain('訊息過濾');
    }
  });
});
