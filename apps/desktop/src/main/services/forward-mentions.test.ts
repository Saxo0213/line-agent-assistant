import { AgentScheduleCreateInputSchema, type AgentSchedule } from '@line-agent/contracts';
import { AgentScheduleError, type ForwardAgentDispatch, type ForwardNotification } from '@line-agent/database';
import { describe, expect, it, vi } from 'vitest';
import { composeForwardRunContext, composeScheduledPrompt } from './agent-schedule-prompt.js';
import { AgentScheduleService, forwardRequestId, isScheduledRunRequestId, parseForwardRequestId, type AgentScheduleStore } from './agent-schedule-service.js';
import { createForwardNotifier } from './forward-notifier.js';
import { ScheduleForwardService, FORWARD_AGENT_QUEUE_LIMIT, FORWARD_NOTIFICATIONS_PER_PASS, forwardNoticeOf } from './schedule-forward-service.js';

const SCHEDULE_ID = '11111111-1111-4111-8111-111111111111';
const WORK_ID = '22222222-2222-4222-8222-222222222222';
const agentTarget = { accountId: 'agent', chatType: 'direct' as const, chatId: 'admin-chat', title: '管理員' };

describe('forward request id', () => {
  it('builds and parses schedule:<scheduleId>:forward:<workId> and stays a schedule-run id', () => {
    const id = forwardRequestId(SCHEDULE_ID, WORK_ID);
    expect(id).toBe(`schedule:${SCHEDULE_ID}:forward:${WORK_ID}`);
    expect(parseForwardRequestId(id)).toEqual({ scheduleId: SCHEDULE_ID, workId: WORK_ID });
    expect(parseForwardRequestId(id.toUpperCase().replace('SCHEDULE', 'schedule').replace('FORWARD', 'forward'))).not.toBeNull();
    expect(isScheduledRunRequestId(id)).toBe(true);
  });
  it('rejects every other id', () => {
    expect(parseForwardRequestId(`schedule:${SCHEDULE_ID}:2026-10-02T01:00:00.000Z`)).toBeNull();
    expect(parseForwardRequestId(`schedule:${SCHEDULE_ID}:forward:not-a-uuid`)).toBeNull();
    expect(parseForwardRequestId(`schedule:${SCHEDULE_ID}:forward:${WORK_ID}:x`)).toBeNull();
    expect(parseForwardRequestId(`ui:${WORK_ID}`)).toBeNull();
    expect(parseForwardRequestId(null)).toBeNull();
    expect(parseForwardRequestId(undefined)).toBeNull();
  });
});

describe('forward Agent card and run context', () => {
  const card = (overrides: { prompt?: string; sourceTitle?: string; mention?: boolean } = {}) => composeScheduledPrompt({
    title: '提及我', prompt: overrides.prompt ?? '', task: { type: 'message_forward', match: { mode: 'sender' } }, targets: [], delivery: { mode: 'record_only' },
    window: { from: new Date(0), to: new Date(0) }, forward: { sourceTitle: overrides.sourceTitle ?? '家人群', agentTarget, mention: overrides.mention ?? true } });
  it('has no ids and no ISO times', () => {
    const text = card({ prompt: '請整理' });
    expect(text.split('\n')).toEqual(['[排程] 提及我', '任務：@ 提及處理', '來源：家人群', '輸出：傳給 管理員', '指示：請整理']);
    expect(text).not.toMatch(/accountId|chatId|T\d\d:\d\d/);
  });
  it('uses the unnamed-chat text and omits an empty instruction', () => {
    expect(card({ sourceTitle: '  ' }).split('\n')).toEqual(['[排程] 提及我', '任務：@ 提及處理', '來源：未命名聊天室', '輸出：傳給 管理員']);
  });

  const input = (over: Partial<Parameters<typeof composeForwardRunContext>[0]> = {}) => ({
    prompt: '', mention: { admin: true, members: [{ label: '小明' }], all: true }, agentTarget,
    work: { accountId: 'agent', chatType: 'group', chatId: 'g1', messageId: 'm1', senderName: '小華', sourceTitle: '家人群' },
    message: { text: '@管理員 請看一下', kind: 'text', occurredAt: new Date('2026-10-02T01:05:00.000Z'), attachments: [] }, ...over });
  it('describes trigger, source, message, context and output', () => {
    const lines = composeForwardRunContext(input()).split('\n');
    expect(lines).toEqual([
      '【排程規則】無人值守：不要提問或等待確認；資訊不足就盡力完成並註明缺少什麼。',
      '觸發：這則訊息提及了規則指定的對象（管理員、小明、全體）。',
      '來源：家人群（accountId=agent，chatType=group，chatId=g1，messageId=m1）',
      '訊息：[小華] 10/2 09:05：@管理員 請看一下',
      '上下文：需要前後文時，用 query_target_messages 帶上述 accountId、chatType、chatId 查詢這則訊息附近的訊息。',
      '指示：判斷這則訊息需要怎麼處理，整理重點與建議的回覆。',
      '輸出：完成後用 send_to_target 傳一次結果到 管理員（accountId=agent，chatType=direct，chatId=admin-chat）；不要傳到其他聊天室，也不要在來源聊天室回覆，除非來源就是這個輸出對象。',
    ]);
  });
  it('uses the rule instruction, lists attachments, clips and redacts', () => {
    const text = composeForwardRunContext(input({ prompt: ' 翻成英文 ', mention: null,
      message: { text: '', kind: 'image', occurredAt: new Date('2026-10-02T01:05:00.000Z'),
        attachments: [{ kind: 'image', name: 'a.png', status: 'ready' }, { kind: 'file', name: null, status: 'queued' }] } }));
    expect(text).toContain('觸發：這則訊息符合排程規則。');
    expect(text).toContain('訊息：[小華] 10/2 09:05：[圖片] [檔案]');
    expect(text).toContain('附件：[圖片] a.png（ready）');
    expect(text).toContain('附件：[檔案]（queued）');
    expect(text).toContain('指示：翻成英文');
    const long = composeForwardRunContext(input({ message: { text: 'x'.repeat(3000), kind: 'text', occurredAt: new Date(0), attachments: [] } }));
    expect(long.split('\n').find((line) => line.startsWith('訊息：'))!.length).toBeLessThan(2100);
    const secret = composeForwardRunContext(input({ message: { text: 'LW-ABCDEFGH', kind: 'text', occurredAt: new Date(0), attachments: [] } }));
    expect(secret).not.toContain('LW-ABCDEFGH');
  });
  it('returns a short context when the work or the message is missing', () => {
    for (const text of [composeForwardRunContext(input({ work: null })), composeForwardRunContext(input({ message: null }))]) {
      expect(text.split('\n')).toHaveLength(2);
      expect(text).toContain('來源訊息已不存在');
    }
  });
});

function forwardSchedule(over: Partial<AgentSchedule> = {}): AgentSchedule {
  return { scheduleId: SCHEDULE_ID, title: '提及', prompt: '', provider: 'claude', recurrence: { kind: 'message' }, timezone: 'Asia/Taipei', targets: [],
    task: { type: 'message_forward', match: { mode: 'mention', admin: true, members: [], all: false },
      actions: { forward: false, notify: false, agent: { prompt: '請整理', target: { ...agentTarget, accountId: 'acc-old' } } } },
    window: { mode: 'since_last_run' }, delivery: { mode: 'record_only' }, enabled: true, ...over } as never;
}
function scheduleStore(schedule: AgentSchedule | null) {
  return {
    list: vi.fn(async () => []), get: vi.fn(async () => schedule), listRuns: vi.fn(async () => []),
    create: vi.fn(async (input: unknown) => input as never), update: vi.fn(async (_id: string, patch: unknown) => patch as never), delete: vi.fn(async () => true),
    recoverStale: vi.fn(async () => 0), claimDue: vi.fn(async () => ({ claims: [], changed: false })),
    markSubmitted: vi.fn(), markFailed: vi.fn(), markSent: vi.fn(), markSendFailed: vi.fn(), markSendUnknown: vi.fn(), markNoMessages: vi.fn(),
    previousSubmittedFor: vi.fn(async () => null),
    updateExternalScoped: vi.fn(async (_id: string, patch: unknown) => patch as never),
  } satisfies AgentScheduleStore & { updateExternalScoped: unknown };
}
const lineage = async () => ({ currentAccountId: 'agent', accountIds: ['agent', 'acc-old'] });

describe('AgentScheduleService.runContext for a forward job', () => {
  const work = { workId: WORK_ID, runId: 'run-1', accountId: 'agent', chatType: 'group', chatId: 'g1', messageId: 'm1', senderId: 'u1', senderName: '小華', sourceTitle: '家人群' };
  const message = { text: '你好', kind: 'text', occurredAt: new Date('2026-10-02T01:05:00.000Z'), attachments: [] };
  it('reads the work by id and builds the context with the current Agent account', async () => {
    const forwards = { forwardWorkById: vi.fn(async () => work), forwardMessage: vi.fn(async () => message) };
    const service = new AgentScheduleService({ store: scheduleStore(forwardSchedule()), submit: vi.fn(), forwards, agentLineage: lineage });
    const context = (await service.runContext(forwardRequestId(SCHEDULE_ID, WORK_ID), 'job-1'))!;
    expect(forwards.forwardWorkById).toHaveBeenCalledWith(SCHEDULE_ID, WORK_ID);
    expect(forwards.forwardMessage).toHaveBeenCalledWith(work);
    expect(context).toContain('觸發：這則訊息提及了規則指定的對象（管理員）。');
    expect(context).toContain('指示：請整理');
    expect(context).toContain('傳一次結果到 管理員（accountId=agent，chatType=direct，chatId=admin-chat）');
    expect(context).not.toContain('acc-old');
    await service.stop();
  });
  it('gives a short context when the work row is gone', async () => {
    const forwards = { forwardWorkById: vi.fn(async () => null), forwardMessage: vi.fn(async () => null) };
    const service = new AgentScheduleService({ store: scheduleStore(forwardSchedule()), submit: vi.fn(), forwards });
    const context = (await service.runContext(forwardRequestId(SCHEDULE_ID, WORK_ID)))!;
    expect(context).toContain('來源訊息已不存在');
    expect(forwards.forwardMessage).not.toHaveBeenCalled();
    await service.stop();
  });
  it('returns null when the rule is gone or has no Agent action', async () => {
    const forwards = { forwardWorkById: vi.fn(async () => work), forwardMessage: vi.fn(async () => message) };
    const none = new AgentScheduleService({ store: scheduleStore(null), submit: vi.fn(), forwards });
    expect(await none.runContext(forwardRequestId(SCHEDULE_ID, WORK_ID))).toBeNull();
    const noAgent = new AgentScheduleService({ store: scheduleStore(forwardSchedule({ task: { type: 'message_forward', match: { mode: 'sender' }, actions: { forward: false, notify: true, agent: null } } as never })),
      submit: vi.fn(), forwards });
    expect(await noAgent.runContext(forwardRequestId(SCHEDULE_ID, WORK_ID))).toBeNull();
    await none.stop(); await noAgent.stop();
  });
});

describe('AgentScheduleService validation of the mention shapes', () => {
  const input = (task: object, targets: object[] = [], delivery: object = { mode: 'record_only' }) => AgentScheduleCreateInputSchema.parse({
    title: '提及', provider: 'claude', recurrence: { kind: 'message' }, targets, task, delivery });
  const mention = { type: 'message_forward', match: { mode: 'mention', admin: true } };
  const resolver = () => ({
    resolve: vi.fn(async (targets: readonly { accountId: string; chatType: string; chatId: string; title: string }[]) => targets.map((t) => ({ ...t, title: `${t.title}!` }))),
    list: vi.fn(async () => []), validateForward: vi.fn(async () => undefined),
  });

  it('accepts empty targets and record_only delivery when forwarding is off', async () => {
    const store = scheduleStore(null);
    const targets = resolver();
    const service = new AgentScheduleService({ store, submit: vi.fn(), targets: targets as never });
    await service.create(input({ ...mention, actions: { forward: false, notify: true } }));
    expect(store.create).toHaveBeenCalledTimes(1);
    expect(targets.resolve).not.toHaveBeenCalled();
    expect(targets.validateForward).toHaveBeenCalledWith(expect.objectContaining({ targets: [], delivery: { mode: 'record_only' } }));
    await service.stop();
  });
  it('maps the Agent target through the lineage and checks it as a delivery target', async () => {
    const store = scheduleStore(null);
    const targets = resolver();
    const service = new AgentScheduleService({ store, submit: vi.fn(), targets: targets as never, agentLineage: lineage });
    await service.create(input({ ...mention, actions: { forward: false, notify: false, agent: { prompt: 'x', target: { ...agentTarget, accountId: 'acc-old' } } } }));
    expect(targets.resolve).toHaveBeenCalledWith([{ ...agentTarget, accountId: 'agent' }], 'delivery');
    const created = store.create.mock.calls[0]![0] as { task: { actions: { agent: { target: { accountId: string; title: string } } } } };
    expect(created.task.actions.agent.target).toMatchObject({ accountId: 'agent', title: '管理員!' });
    await service.stop();
  });
  it('rejects an invalid Agent target on create and on update, and never writes', async () => {
    const store = scheduleStore(forwardSchedule({ task: { ...mention, actions: { forward: false, notify: true, agent: null } } as never }));
    const targets = resolver();
    targets.resolve.mockRejectedValue(new AgentScheduleError('SCHEDULE_INVALID_TARGET', 'bad'));
    const service = new AgentScheduleService({ store, submit: vi.fn(), targets: targets as never });
    const agent = { prompt: '', target: agentTarget };
    await expect(service.create(input({ ...mention, actions: { forward: false, notify: false, agent } }))).rejects.toMatchObject({ code: 'SCHEDULE_INVALID_TARGET' });
    await expect(service.update(SCHEDULE_ID, { task: { ...mention, actions: { forward: false, notify: false, agent } } } as never)).rejects.toMatchObject({ code: 'SCHEDULE_INVALID_TARGET' });
    expect(store.create).not.toHaveBeenCalled();
    expect(store.update).not.toHaveBeenCalled();
    await service.stop();
  });
  it('rejects forwarding without a destination and a no-forward rule with a destination', async () => {
    expect(() => input({ ...mention })).toThrow('explicit LINE destination');
    const service = new AgentScheduleService({ store: scheduleStore(forwardSchedule()), submit: vi.fn() });
    await expect(service.update(SCHEDULE_ID, { delivery: { mode: 'primary_admin' } })).rejects.toMatchObject({ code: 'SCHEDULE_INVALID' });
    await expect(service.update(SCHEDULE_ID, { delivery: { mode: 'line_target', target: agentTarget } })).rejects.toMatchObject({ code: 'SCHEDULE_INVALID' });
    await service.stop();
  });
  it('lets an external caller create only a rule with explicit sources and Agent target inside its scope', async () => {
    const store = scheduleStore(null);
    const service = new AgentScheduleService({ store, submit: vi.fn() });
    const withAgent = { ...mention, actions: { forward: false, notify: false, agent: { prompt: '', target: agentTarget } } };
    await expect(service.createExternal(input(withAgent), ['agent'])).rejects.toMatchObject({ code: 'SCHEDULE_INVALID_TARGET' });
    const source = { accountId: 'other', chatType: 'group', chatId: 'g', title: 'G' };
    await expect(service.createExternal(input(withAgent, [source]), ['other'])).rejects.toMatchObject({ code: 'SCHEDULE_INVALID_TARGET' });
    await service.createExternal(input(withAgent, [{ ...source, accountId: 'agent' }]), ['agent']);
    expect(store.create).toHaveBeenCalledTimes(1);
    await service.stop();
  });
});

describe('ScheduleForwardService mention Agent dispatch', () => {
  const row = (over: Partial<ForwardAgentDispatch> = {}): ForwardAgentDispatch => ({
    workId: WORK_ID, runId: 'run-1', scheduleId: SCHEDULE_ID, title: '提及我', matchMode: 'mention', scheduledFor: new Date('2026-10-02T01:05:00.000Z'), provider: 'claude',
    agent: { prompt: '請整理', target: { ...agentTarget, accountId: 'acc-old' } }, accountId: 'agent', chatType: 'group', chatId: 'g1', messageId: 'm1',
    senderId: 'u1', senderName: '小華', sourceTitle: '家人群', externalAccountScope: null, ...over });
  function harness(rows: ForwardAgentDispatch[] = [row()], extra: Record<string, unknown> = {}) {
    const store = {
      recover: vi.fn(async () => undefined), settle: vi.fn(async () => undefined), pending: vi.fn(async () => []), valid: vi.fn(async () => true), mark: vi.fn(async () => true),
      pendingNotifications: vi.fn(async () => [] as ForwardNotification[]), markNotification: vi.fn(async () => true),
      pendingAgentDispatches: vi.fn(async () => rows), markAgentDispatch: vi.fn(async () => true), queuedAgentJobs: vi.fn(async () => 0),
    };
    const submitAgent = vi.fn(async (_input: unknown) => ({ disposition: 'inserted' as const, jobId: 'job-1' }));
    const resolveAgentTarget = vi.fn(async (target: typeof agentTarget) => ({ ...target, accountId: 'agent' }));
    const onError = vi.fn();
    const service = new ScheduleForwardService({ store, messages: {} as never, sender: {} as never, publish: vi.fn(), onError, submitAgent, resolveAgentTarget, ...extra } as never);
    return { store, submitAgent, resolveAgentTarget, onError, service };
  }

  it('submits one job with the forward request id and a card prompt', async () => {
    const h = harness();
    await h.service.drain();
    expect(h.resolveAgentTarget).toHaveBeenCalledWith({ ...agentTarget, accountId: 'acc-old' });
    expect(h.submitAgent).toHaveBeenCalledTimes(1);
    const call = h.submitAgent.mock.calls[0]![0] as { provider: string; requestId: string; prompt: string; mcpAccountScope?: unknown };
    expect(call.provider).toBe('claude');
    expect(call.requestId).toBe(`schedule:${SCHEDULE_ID}:forward:${WORK_ID}`);
    expect(call.prompt.split('\n')).toEqual(['[排程] 提及我', '任務：@ 提及處理', '來源：家人群', '輸出：傳給 管理員', '指示：請整理']);
    expect('mcpAccountScope' in call).toBe(false);
    expect(h.store.markAgentDispatch).toHaveBeenCalledWith(WORK_ID, 'submitted', 'job-1', null);
  });
  it('treats a duplicate disposition as submitted with the existing job id', async () => {
    const h = harness();
    h.submitAgent.mockResolvedValue({ disposition: 'duplicate' as never, jobId: 'job-old' });
    await h.service.drain();
    expect(h.store.markAgentDispatch).toHaveBeenCalledWith(WORK_ID, 'submitted', 'job-old', null);
  });
  it('copies the external scope through the lineage mapping', async () => {
    const accountScope = vi.fn(async (scope: readonly string[] | null) => scope === null ? null : scope.map((id) => (id === 'acc-old' ? 'agent' : id)));
    const h = harness([row({ externalAccountScope: ['acc-old', 'other'] })], { accountScope });
    await h.service.drain();
    expect(h.submitAgent).toHaveBeenCalledWith(expect.objectContaining({ mcpAccountScope: ['agent', 'other'] }));
  });
  it('marks the row failed with send_target_invalid and does not submit', async () => {
    const h = harness();
    h.resolveAgentTarget.mockRejectedValue(new AgentScheduleError('SCHEDULE_INVALID_TARGET', 'gone'));
    await h.service.drain();
    expect(h.submitAgent).not.toHaveBeenCalled();
    expect(h.store.markAgentDispatch).toHaveBeenCalledWith(WORK_ID, 'failed', null, 'send_target_invalid');
    expect(h.onError).not.toHaveBeenCalled();
  });
  it('skips the row with agent_queue_full at the queue limit', async () => {
    const h = harness();
    h.store.queuedAgentJobs.mockResolvedValue(FORWARD_AGENT_QUEUE_LIMIT);
    await h.service.drain();
    expect(h.store.queuedAgentJobs).toHaveBeenCalledWith(SCHEDULE_ID);
    expect(h.submitAgent).not.toHaveBeenCalled();
    expect(h.store.markAgentDispatch).toHaveBeenCalledWith(WORK_ID, 'skipped', null, 'agent_queue_full');
    h.store.queuedAgentJobs.mockResolvedValue(FORWARD_AGENT_QUEUE_LIMIT - 1);
    h.store.markAgentDispatch.mockClear();
    await h.service.drain();
    expect(h.submitAgent).toHaveBeenCalledTimes(1);
  });
  it('stores a safe code, not the raw message, when the submit fails, and goes on with the next row', async () => {
    const other = row({ workId: '33333333-3333-4333-8333-333333333333' });
    const h = harness([row(), other]);
    const secret = new Error('password=hunter2 at C:\\secret');
    h.submitAgent.mockRejectedValueOnce(secret);
    await h.service.drain();
    expect(h.store.markAgentDispatch).toHaveBeenCalledWith(WORK_ID, 'failed', null, 'agent_submit_failed');
    expect(h.onError).toHaveBeenCalledWith(secret);
    expect(h.store.markAgentDispatch).toHaveBeenCalledWith(other.workId, 'submitted', 'job-1', null);
  });
  it('marks failed when no submit function is available', async () => {
    const h = harness([row()], { submitAgent: undefined });
    await h.service.drain();
    expect(h.store.markAgentDispatch).toHaveBeenCalledWith(WORK_ID, 'failed', null, 'agent_unavailable');
  });
});

describe('ScheduleForwardService notifications', () => {
  const notification = (index: number, over: Partial<ForwardNotification> = {}): ForwardNotification => ({
    workId: `work-${index}`, runId: `run-${index}`, scheduleId: SCHEDULE_ID, title: '提及我', accountId: 'agent', chatType: 'group', chatId: 'g1', messageId: `m${index}`,
    sourceTitle: '家人群', senderName: '小華', text: '你好', attachmentKinds: [], occurredAt: new Date(0), ...over });
  function harness(rows: ForwardNotification[], notify?: (notice: unknown) => Promise<boolean>) {
    const store = {
      recover: vi.fn(async () => undefined), settle: vi.fn(async () => undefined), pending: vi.fn(async () => []), valid: vi.fn(async () => true), mark: vi.fn(async () => true),
      pendingNotifications: vi.fn(async (_limit?: number) => rows), markNotification: vi.fn(async () => true),
      pendingAgentDispatches: vi.fn(async () => []), markAgentDispatch: vi.fn(async () => true), queuedAgentJobs: vi.fn(async () => 0),
    };
    const onError = vi.fn();
    const service = new ScheduleForwardService({ store, messages: {} as never, sender: {} as never, publish: vi.fn(), onError, ...(notify ? { notify } : {}) } as never);
    return { store, onError, service };
  }

  it('shows one notification per row and marks it shown', async () => {
    const notify = vi.fn(async (_notice: unknown) => true);
    const h = harness([notification(1)], notify);
    await h.service.drain();
    expect(notify).toHaveBeenCalledWith({ title: '@ 提及：提及我', body: '家人群｜小華: 你好', accountId: 'agent', chatType: 'group', chatId: 'g1' });
    expect(h.store.markNotification).toHaveBeenCalledWith('work-1', 'shown');
  });
  it('marks failed when the notification is not supported, throws, or no notifier exists', async () => {
    const unsupported = harness([notification(1)], async () => false);
    await unsupported.service.drain();
    expect(unsupported.store.markNotification).toHaveBeenCalledWith('work-1', 'failed');
    const boom = new Error('x');
    const throwing = harness([notification(1)], async () => { throw boom; });
    await throwing.service.drain();
    expect(throwing.store.markNotification).toHaveBeenCalledWith('work-1', 'failed');
    expect(throwing.onError).toHaveBeenCalledWith(boom);
    const absent = harness([notification(1)]);
    await absent.service.drain();
    expect(absent.store.markNotification).toHaveBeenCalledWith('work-1', 'failed');
  });
  it('shows at most five notifications in one pass', async () => {
    const notify = vi.fn(async (_notice: unknown) => true);
    const h = harness(Array.from({ length: 8 }, (_, index) => notification(index)), notify);
    await h.service.drain();
    expect(h.store.pendingNotifications).toHaveBeenCalledWith(FORWARD_NOTIFICATIONS_PER_PASS);
    expect(notify).toHaveBeenCalledTimes(5);
    expect(h.store.markNotification).toHaveBeenCalledTimes(5);
  });
  it('builds the body from attachment labels, clips the sizes and redacts', () => {
    expect(forwardNoticeOf(notification(1, { text: '', attachmentKinds: ['image', 'image', 'file'] })).body).toBe('家人群｜小華: [圖片×2] [檔案]');
    expect(forwardNoticeOf(notification(1, { sourceTitle: '', text: 'a\nb' })).body).toBe('未命名聊天室｜小華: a b');
    const clipped = forwardNoticeOf(notification(1, { title: 't'.repeat(200), text: 'x'.repeat(500) }));
    expect(clipped.title.length).toBeLessThanOrEqual(80);
    expect(clipped.body.length).toBeLessThanOrEqual(200);
    expect(forwardNoticeOf(notification(1, { text: 'LW-ABCDEFGH' })).body).not.toContain('LW-ABCDEFGH');
  });
});

describe('createForwardNotifier', () => {
  function electron(supported: boolean, showError?: Error) {
    const handlers: Record<string, () => void> = {};
    const created: Array<{ title: string; body: string }> = [];
    class FakeNotification {
      static isSupported() { return supported; }
      constructor(options: { title: string; body: string }) { created.push(options); }
      on(event: string, handler: () => void) { handlers[event] = handler; return this; }
      show() { if (showError) throw showError; }
    }
    return { FakeNotification, handlers, created };
  }
  const notice = { title: 'T', body: 'B', accountId: 'a', chatType: 'group', chatId: 'g' };
  it('shows the notification and focuses the window on click', async () => {
    const fake = electron(true);
    const focusWindow = vi.fn();
    const notify = createForwardNotifier({ Notification: fake.FakeNotification as never, focusWindow });
    expect(await notify(notice)).toBe(true);
    expect(fake.created).toEqual([expect.objectContaining({ title: 'T', body: 'B' })]);
    fake.handlers.click!();
    expect(focusWindow).toHaveBeenCalledTimes(1);
    expect(focusWindow).toHaveBeenCalledWith(notice);
  });
  it('returns false when unsupported or when show throws', async () => {
    const unsupported = electron(false);
    expect(await createForwardNotifier({ Notification: unsupported.FakeNotification as never, focusWindow: vi.fn() })(notice)).toBe(false);
    expect(unsupported.created).toEqual([]);
    const error = new Error('no');
    const onError = vi.fn();
    const failing = electron(true, error);
    expect(await createForwardNotifier({ Notification: failing.FakeNotification as never, focusWindow: vi.fn(), onError })(notice)).toBe(false);
    expect(onError).toHaveBeenCalledWith(error);
  });
});
