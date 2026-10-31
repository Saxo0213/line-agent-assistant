import type { AgentScheduleCreateInput } from '@line-agent/contracts';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AgentScheduleClaim } from '@line-agent/database';
import { AgentScheduleService, scheduleRequestId, type AgentScheduleStore } from './agent-schedule-service.js';

const SCHEDULE_ID = '11111111-1111-4111-8111-111111111111';
const claim = (overrides: Partial<AgentScheduleClaim> = {}): AgentScheduleClaim => ({
  runId: 'run-1', scheduleId: SCHEDULE_ID, scheduledFor: new Date('2026-10-01T01:00:00.000Z'), title: '早報', prompt: '整理昨天的訊息並傳給我', provider: 'claude',
  recurrence: { kind: 'daily', time: '09:00' }, timezone: 'Asia/Taipei', targets: [], task: { type: 'custom' }, window: { mode: 'since_last_run' },
  delivery: { mode: 'record_only' }, previousSubmittedFor: null, ...overrides,
});

function fakeStore(claims: AgentScheduleClaim[][] = [[claim()]]) {
  const queue = [...claims];
  const store = {
    list: vi.fn(async () => []), get: vi.fn(async () => null), listRuns: vi.fn(async () => []),
    create: vi.fn(async () => ({ scheduleId: SCHEDULE_ID }) as never), update: vi.fn(async () => ({ scheduleId: SCHEDULE_ID }) as never),
    delete: vi.fn(async () => true),
    recoverStale: vi.fn(async () => 0),
    claimDue: vi.fn(async () => { const next = queue.shift() ?? []; return { claims: next, changed: next.length > 0 }; }),
    markSubmitted: vi.fn(async () => true), markFailed: vi.fn(async () => true),
    markSent: vi.fn(async () => true), markSendFailed: vi.fn(async () => true), markSendUnknown: vi.fn(async () => true),
    markNoMessages: vi.fn(async () => true),
    previousSubmittedFor: vi.fn(async (): Promise<Date | null> => null),
  };
  return store satisfies AgentScheduleStore;
}

afterEach(() => { vi.useRealTimers(); });

describe('AgentScheduleService', () => {
  it('submits each Agent claim as an isolated schedule job with the deterministic request id and a prefixed prompt', async () => {
    const store = fakeStore();
    const submit = vi.fn(async () => ({ jobId: 'job-1' }));
    const publish = vi.fn();
    const service = new AgentScheduleService({ store, submit, publish });
    await service.start();
    await service.stop();
    expect(submit).toHaveBeenCalledTimes(1);
    expect(submit).toHaveBeenCalledWith({
      provider: 'claude',
      requestId: `schedule:${SCHEDULE_ID}:2026-10-01T01:00:00.000Z`,
      prompt: '[排程] 早報\n任務：自訂\n輸出：只存排程紀錄\n指示：整理昨天的訊息並傳給我',
    });
    expect(store.markSubmitted).toHaveBeenCalledWith('run-1', 'job-1');
    expect(store.markFailed).not.toHaveBeenCalled();
    expect(publish).toHaveBeenCalled();
    expect(scheduleRequestId(SCHEDULE_ID, new Date('2026-10-01T01:00:00Z'))).toBe(`schedule:${SCHEDULE_ID}:2026-10-01T01:00:00.000Z`);
  });

  it('does not double-fire when ticks run concurrently', async () => {
    const store = fakeStore([[]]);
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    store.claimDue.mockImplementationOnce(async () => { await gate; return { claims: [claim()], changed: true }; });
    const submit = vi.fn(async () => ({ jobId: 'job-1' }));
    const service = new AgentScheduleService({ store, submit });
    const first = service.tick();
    const second = service.tick();
    const third = service.tick();
    expect(store.claimDue).toHaveBeenCalledTimes(1);
    release();
    await Promise.all([first, second, third]);
    expect(store.claimDue).toHaveBeenCalledTimes(1);
    expect(submit).toHaveBeenCalledTimes(1);
    await service.tick();
    expect(store.claimDue).toHaveBeenCalledTimes(2);
  });

  it('marks a claim failed when the submission throws and keeps going', async () => {
    const store = fakeStore([[claim({ runId: 'run-a' }), claim({ runId: 'run-b', scheduledFor: new Date('2026-10-01T01:00:30.000Z') })]]);
    const submit = vi.fn()
      .mockRejectedValueOnce(new Error('workspace unavailable'))
      .mockResolvedValueOnce({ jobId: 'job-2' });
    const onError = vi.fn();
    const service = new AgentScheduleService({ store, submit, onError });
    await service.tick();
    expect(store.markFailed).toHaveBeenCalledWith('run-a');
    expect(store.markSubmitted).toHaveBeenCalledWith('run-b', 'job-2');
    expect(onError).toHaveBeenCalledTimes(1);
  });

  it('survives a claim error and ticks again on the 30 s timer until stopped', async () => {
    vi.useFakeTimers();
    const store = fakeStore([[]]);
    store.claimDue.mockRejectedValueOnce(new Error('db down'));
    const onError = vi.fn();
    const service = new AgentScheduleService({ store, submit: vi.fn(async () => ({ jobId: 'j' })), onError });
    await service.start();
    expect(onError).toHaveBeenCalledTimes(1);
    expect(store.recoverStale).toHaveBeenCalledTimes(1);
    expect(store.claimDue).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(29_000);
    expect(store.claimDue).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(store.claimDue).toHaveBeenCalledTimes(2);
    await service.stop();
    await vi.advanceTimersByTimeAsync(120_000);
    expect(store.claimDue).toHaveBeenCalledTimes(2);
    await service.tick();
    expect(store.claimDue).toHaveBeenCalledTimes(2);
  });

  it('stop waits for the tick in flight so nothing is submitted afterwards', async () => {
    const store = fakeStore([[claim()]]);
    let finish: () => void = () => undefined;
    const submit = vi.fn(() => new Promise<{ jobId: string }>((resolve) => { finish = () => resolve({ jobId: 'job-1' }); }));
    const service = new AgentScheduleService({ store, submit });
    const pass = service.tick();
    await vi.waitFor(() => expect(submit).toHaveBeenCalledTimes(1));
    let stopped = false;
    const stopping = service.stop().then(() => { stopped = true; });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(stopped).toBe(false);
    finish();
    await Promise.all([pass, stopping]);
    expect(stopped).toBe(true);
    expect(store.markSubmitted).toHaveBeenCalledWith('run-1', 'job-1');
  });

  it('publishes and ticks immediately after create and update, and publishes on delete', async () => {
    const store = fakeStore([[], []]);
    const publish = vi.fn();
    const service = new AgentScheduleService({ store, submit: vi.fn(async () => ({ jobId: 'j' })), publish, now: () => new Date('2026-10-01T00:00:00Z') });
    const input: AgentScheduleCreateInput = { title: 't', prompt: 'p', provider: 'claude', recurrence: { kind: 'daily', time: '09:00' }, timezone: 'Asia/Taipei', targets: [],
      task: { type: 'custom' }, window: { mode: 'since_last_run' }, delivery: { mode: 'record_only' }, jitterMinutes: 0, enabled: true };
    await service.create(input);
    expect(store.create).toHaveBeenCalledWith(input, new Date('2026-10-01T00:00:00Z'));
    await vi.waitFor(() => expect(store.claimDue).toHaveBeenCalledTimes(1));
    store.get.mockResolvedValueOnce({ prompt: 'p', targets: [], task: { type: 'custom' } } as never);
    await service.update(SCHEDULE_ID, { enabled: false });
    expect(store.update).toHaveBeenCalledWith(SCHEDULE_ID, { enabled: false }, new Date('2026-10-01T00:00:00Z'));
    expect(publish).toHaveBeenCalledTimes(2);
    await service.delete(SCHEDULE_ID);
    expect(publish).toHaveBeenCalledTimes(3);
    store.delete.mockResolvedValueOnce(false);
    await service.delete(SCHEDULE_ID);
    expect(publish).toHaveBeenCalledTimes(3);
  });

  it('rebuilds the hidden run context of a schedule-sourced job from the schedule row', async () => {
    const store = fakeStore([[]]);
    const schedule = { scheduleId: SCHEDULE_ID, title: '社群', prompt: '', provider: 'claude' as const, recurrence: { kind: 'daily' as const, time: '09:00' }, timezone: 'Asia/Taipei',
      targets: [{ accountId: 'acc-2', chatType: 'community' as const, chatId: 'cm-1', title: '開放社群' }], task: { type: 'summary' as const }, window: { mode: 'since_last_run' as const },
      delivery: { mode: 'primary_admin' as const }, enabled: true, nextFireAt: null, lastFireAt: null, lastOutcome: null, createdAt: '2026-10-01T00:00:00.000Z', updatedAt: '2026-10-01T00:00:00.000Z' };
    store.get.mockResolvedValue(schedule as never);
    store.previousSubmittedFor.mockResolvedValue(new Date('2026-10-01T01:00:00.000Z'));
    const service = new AgentScheduleService({ store, submit: async () => ({ jobId: 'j' }), primaryAdminChat: async () => ({ accountId: 'acc-1', chatId: 'uadmin', title: '徐佳誠' }) });
    const context = await service.runContext(`schedule:${SCHEDULE_ID}:2026-10-02T01:00:00.000Z`);
    expect(context).toMatchInlineSnapshot(`
      "【排程規則】無人值守：不要提問或等待確認；資訊不足就盡力完成並註明缺少什麼。
      時間：10/1 09:00–10/2 09:00（台灣時間）；查詢用 UTC from=2026-10-01T01:00:00.000Z to=2026-10-02T01:00:00.000Z
      分頁規則：訊息查詢工具每頁最多 200 則，結果含 hasMore 與 nextCursor；hasMore 為 true 時，用相同條件加上 cursor=nextCursor 再查下一頁，直到 hasMore 為 false，逐頁整理後再合併。不要自行指定超過 200 的 limit，也不要因為單頁筆數上限而放棄或重試；只有最後一頁（hasMore=false）仍無訊息，才能寫該時段無訊息。
      來源（用 query_target_messages_by_time 逐一查到 hasMore=false，只查上述時間）：
      • 開放社群（accountId=acc-2，chatType=community，chatId=cm-1）
      任務：總結。每個來源一個區塊（純文字）：
      【<聊天室名稱>】<M/D HH:mm–HH:mm> · <N> 則
      重點：• …（最多 5 點）
      決議／待辦：• [名稱]－事項－期限（沒有就省略）
      未解問題：• …（沒有就省略）
      每區塊最多 15 行；沒有訊息時只寫一行「<名稱>：此時段無訊息」。
      人名規則：結果中每個人的顯示名稱一律寫成 [名稱]（半形方括號），例如「• 01:31 [紅點點] 分享因搬出國與規則限制而停卡」；不明發言者寫 [未知]；非人名的詞不加括號；聊天室標題維持【】，人名不用【】。
      輸出：用 send_to_target 傳給管理員（accountId=acc-1，chatType=direct，chatId=uadmin）。只傳結果本身（純文字、不要 Markdown、不加說明）；你的回覆貼同一份文字。傳送失敗或結果不明時不要重試，在回覆說明原因（此規則只適用於傳送與真正的錯誤，分頁不算錯誤，必須繼續查下一頁）。"
    `);
    expect(await service.runContext('ui:something')).toBeNull();
    expect(await service.runContext(`schedule:${SCHEDULE_ID}:not-a-date`)).toBeNull();
    store.get.mockResolvedValue(null);
    expect(await service.runContext(`schedule:${SCHEDULE_ID}:2026-10-02T01:00:00.000Z`)).toBeNull();
    await service.stop();
  });

  describe('Agent lineage', () => {
    const lineage = async () => ({ currentAccountId: 'acc-new', accountIds: ['acc-new', 'acc-old'] });

    it('shows the current account in the run context for delivery and read targets', async () => {
      const store = fakeStore([[]]);
      store.get.mockResolvedValue({ scheduleId: SCHEDULE_ID, title: '群組', prompt: '', provider: 'claude', recurrence: { kind: 'daily', time: '09:00' }, timezone: 'Asia/Taipei',
        targets: [{ accountId: 'acc-old', chatType: 'group', chatId: 'g1', title: '家人' }], task: { type: 'summary' }, window: { mode: 'since_last_run' },
        delivery: { mode: 'line_target', target: { accountId: 'acc-old', chatType: 'direct', chatId: 'u1', title: '甲' } }, enabled: true } as never);
      const service = new AgentScheduleService({ store, submit: async () => ({ jobId: 'j' }), agentLineage: lineage });
      const context = (await service.runContext(`schedule:${SCHEDULE_ID}:2026-10-02T01:00:00.000Z`))!;
      expect(context).toContain('accountId=acc-new，chatType=group，chatId=g1');
      expect(context).toContain('accountId=acc-new，chatType=direct，chatId=u1');
      expect(context).not.toContain('acc-old');
      await service.stop();
    });

    it('sends a message schedule through the current account when line_target holds a former account', async () => {
      const target = { accountId: 'acc-old', chatType: 'group' as const, chatId: 'g1', title: '家人' };
      const store = fakeStore([[claim({ runId: 'run-l', prompt: '', task: { type: 'message', text: '通知' }, delivery: { mode: 'line_target', target } })]]);
      const sendSystemText = vi.fn(async () => ({ status: 'sent' as const }));
      await new AgentScheduleService({ store, submit: vi.fn(), sendSystemText, agentLineage: lineage }).tick();
      expect(sendSystemText).toHaveBeenCalledWith({ runId: 'run-l', text: '通知', target: { ...target, accountId: 'acc-new' } });
    });

    it('remaps an Agent claim and validates an edited old delivery against the current account', async () => {
      const target = { accountId: 'acc-old', chatType: 'group' as const, chatId: 'g1', title: '家人' };
      const store = fakeStore([[claim({ task: { type: 'summary' }, targets: [target], delivery: { mode: 'line_target', target } })]]);
      const submit = vi.fn(async () => ({ jobId: 'job' }));
      const resolve = vi.fn(async (targets: readonly never[]) => [...targets]);
      const service = new AgentScheduleService({ store, submit, agentLineage: lineage, targets: { resolve, list: vi.fn() } as never });
      await service.tick();
      expect(JSON.stringify(submit.mock.calls)).not.toContain('acc-old');
      await service.create({ title: 'x', prompt: 'p', provider: 'claude', recurrence: { kind: 'daily', time: '09:00' }, targets: [], task: { type: 'custom' },
        window: { mode: 'since_last_run' }, delivery: { mode: 'line_target', target }, enabled: true } as never);
      expect(resolve).toHaveBeenCalledWith([{ ...target, accountId: 'acc-new' }], 'delivery');
      await service.stop();
    });
  });

  describe('system message runs', () => {
    const NOON = new Date('2026-10-04T04:00:00.000Z');
    const message = (overrides: Partial<AgentScheduleClaim> = {}) => claim({
      runId: 'run-m', scheduledFor: NOON, prompt: '', task: { type: 'message', text: '{{date}} {{weekday}} {{time}} 吃藥' }, delivery: { mode: 'primary_admin' }, ...overrides });
    const admin = async () => ({ accountId: 'acc-1', chatId: 'uadmin', title: '徐佳誠' });

    it('sends the resolved text itself, records sent, and never creates an Agent job', async () => {
      const store = fakeStore([[message()]]);
      const submit = vi.fn(async () => ({ jobId: 'job' }));
      const sendSystemText = vi.fn(async () => ({ status: 'sent' as const }));
      const publish = vi.fn();
      const service = new AgentScheduleService({ store, submit, sendSystemText, primaryAdminChat: admin, publish });
      await service.tick();
      expect(sendSystemText).toHaveBeenCalledTimes(1);
      expect(sendSystemText).toHaveBeenCalledWith({ runId: 'run-m', text: '2026-10-04 星期日 12:00 吃藥',
        target: { accountId: 'acc-1', chatType: 'direct', chatId: 'uadmin', title: '徐佳誠' } });
      expect(store.markSent).toHaveBeenCalledWith('run-m');
      expect(submit).not.toHaveBeenCalled();
      expect(store.markSubmitted).not.toHaveBeenCalled();
      expect(publish).toHaveBeenCalled();
    });

    it('sends to the chosen LINE chat for line_target', async () => {
      const target = { accountId: 'acc-1', chatType: 'group' as const, chatId: 'g1', title: '家人' };
      const store = fakeStore([[message({ delivery: { mode: 'line_target', target }, task: { type: 'message', text: '固定通知' } })]]);
      const sendSystemText = vi.fn(async () => ({ status: 'sent' as const }));
      await new AgentScheduleService({ store, submit: vi.fn(), sendSystemText }).tick();
      expect(sendSystemText).toHaveBeenCalledWith({ runId: 'run-m', text: '固定通知', target });
    });

    it('records send_failed, and send_unknown without any retry', async () => {
      const store = fakeStore([[message({ runId: 'run-f' }), message({ runId: 'run-u' })], [], []]);
      const sendSystemText = vi.fn()
        .mockResolvedValueOnce({ status: 'failed', code: 'send_line_unavailable' })
        .mockResolvedValueOnce({ status: 'unknown', code: 'send_unknown' });
      const service = new AgentScheduleService({ store, submit: vi.fn(), sendSystemText, primaryAdminChat: admin });
      await service.tick();
      expect(store.markSendFailed).toHaveBeenCalledWith('run-f');
      expect(store.markSendUnknown).toHaveBeenCalledWith('run-u');
      expect(store.markSent).not.toHaveBeenCalled();
      await service.tick();
      await service.tick();
      expect(sendSystemText).toHaveBeenCalledTimes(2);
    });

    it('records send_failed when there is no administrator chat, no sender or the sender throws', async () => {
      const noAdmin = fakeStore([[message({ runId: 'run-1' })]]);
      const send = vi.fn(async () => ({ status: 'sent' as const }));
      await new AgentScheduleService({ store: noAdmin, submit: vi.fn(), sendSystemText: send, primaryAdminChat: async () => null }).tick();
      expect(noAdmin.markSendFailed).toHaveBeenCalledWith('run-1');
      expect(send).not.toHaveBeenCalled();
      const noSender = fakeStore([[message({ runId: 'run-2' })]]);
      await new AgentScheduleService({ store: noSender, submit: vi.fn(), primaryAdminChat: admin }).tick();
      expect(noSender.markSendFailed).toHaveBeenCalledWith('run-2');
      const throwing = fakeStore([[message({ runId: 'run-3' })]]);
      const onError = vi.fn();
      await new AgentScheduleService({ store: throwing, submit: vi.fn(), sendSystemText: vi.fn(async () => { throw new Error('boom'); }), primaryAdminChat: admin, onError }).tick();
      expect(throwing.markSendFailed).toHaveBeenCalledWith('run-3');
      expect(onError).toHaveBeenCalledTimes(1);
    });

    it('rejects a message with record_only delivery or chats to read, and an Agent task still submits', async () => {
      const service = new AgentScheduleService({ store: fakeStore([[]]), submit: vi.fn(), now: () => NOON });
      const input: AgentScheduleCreateInput = { title: '鬧鐘', prompt: '', provider: 'claude', recurrence: { kind: 'daily', time: '07:00' }, timezone: 'Asia/Taipei', targets: [],
        task: { type: 'message', text: 'x' }, window: { mode: 'since_last_run' }, delivery: { mode: 'record_only' }, jitterMinutes: 0, enabled: true };
      await expect(service.create(input)).rejects.toMatchObject({ code: 'SCHEDULE_INVALID' });
      await expect(service.create({ ...input, delivery: { mode: 'primary_admin' }, targets: [{ accountId: 'a', chatType: 'group', chatId: 'g', title: '' }] }))
        .rejects.toMatchObject({ code: 'SCHEDULE_INVALID' });
      await expect(service.create({ ...input, delivery: { mode: 'primary_admin' } })).resolves.toBeDefined();
    });
  });

});
