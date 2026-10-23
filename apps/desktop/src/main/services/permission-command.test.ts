import { describe, expect, it } from 'vitest';
import type { AgentExecutionLevel, AgentExecutionPolicy, InboundEnvelope, LineWorkerCommand, LineWorkerEvent,
  SetAgentExecutionPolicyInput, WorkerBinding } from '@line-agent/contracts';
import { AgentPermissionError } from '@line-agent/database';
import { AccountRepository } from '@line-agent/database';
import type { PoolClient } from 'pg';
import { claimed, PermissionCommandService, type PermissionCommandTransport, type PermissionTicket } from './permission-command.js';
import { createTestDatabase } from '../../../../../packages/database/src/test-database.js';
import type { Locale } from '../../locale.js';
import { linePrompt } from './line-prompts.js';

type SendTextCommand = Extract<LineWorkerCommand, { type: 'sendText' }>;
type SendResult = Extract<LineWorkerEvent, { type: 'sendResult' }>;

const listText = (current: AgentExecutionLevel) => {
  const names: Array<[AgentExecutionLevel, string]> = [['read_only', '唯讀'], ['workspace_write', '工作區可寫'], ['trust', '信任'], ['full', '全部放行']];
  return `目前 Agent 執行權限：${names.find(([level]) => level === current)![1]}\n回覆數字變更（2 分鐘內有效）：\n${names
    .map(([level, name], index) => `${index + 1}. ${name}${level === current ? '（目前）' : ''}`).join('\n')}`;
};
const LIST_WORKSPACE_WRITE = '目前 Agent 執行權限：工作區可寫\n回覆數字變更（2 分鐘內有效）：\n1. 唯讀\n2. 工作區可寫（目前）\n3. 信任\n4. 全部放行';
const CONFLICT = '權限已在其他地方變更，請重新輸入 /權限';
const FAILURE = '權限變更失敗，請稍後再試';
const STALE = '這個選項已失效，請重新輸入 /權限';
const LOOSEN_FULL = '確定要放寬為 全部放行？回覆「確認」套用，回覆其他內容取消（2 分鐘內有效）';

const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
};
const flush = async () => { for (let index = 0; index < 50; index += 1) await Promise.resolve(); };
/** Drains microtasks until `done()` holds (bounded). */
const until = async (done: () => boolean) => { for (let index = 0; index < 5000 && !done(); index += 1) await Promise.resolve(); };

/** Counts underlying repository and transport operations that have started but not yet settled. */
class Outstanding {
  current = 0;
  max = 0;
  async track<T>(work: () => Promise<T>): Promise<T> {
    this.current += 1;
    this.max = Math.max(this.max, this.current);
    try { return await work(); } finally { this.current -= 1; }
  }
}

/** Stateful fake: `policy` and `audit` only change when a write commits. */
class FakeRepository {
  policy: AgentExecutionPolicy = { level: 'workspace_write', approvalTimeoutSeconds: 60, timeoutAction: 'DENY', version: 5, updatedAt: '2026-10-21T00:00:00.000Z' };
  /** Every attempted write, committed or not. */
  writes: Array<{ input: SetAgentExecutionPolicyInput; actor: string | undefined }> = [];
  /** Committed writes, like agent_permission_audit EXECUTION_POLICY rows. */
  audit: Array<{ version: number; level: AgentExecutionLevel; actor: string | undefined }> = [];
  reads = 0;
  getError: Error | null = null;
  setError: Error | null = null;
  /** Each read waits for the next queued gate, if any, before answering. */
  gates: Array<Promise<void>> = [];
  writeGate: Promise<void> | null = null;
  /** Awaited at the start of every read when set. */
  readHook: (() => Promise<void>) | null = null;
  constructor(readonly outstanding = new Outstanding()) {}
  getExecutionPolicy(): Promise<AgentExecutionPolicy> {
    return this.outstanding.track(async () => {
      this.reads += 1;
      if (this.readHook) await this.readHook();
      const gate = this.gates.shift();
      if (gate) await gate;
      if (this.getError) throw this.getError;
      return { ...this.policy };
    });
  }
  setExecutionPolicy(input: SetAgentExecutionPolicyInput, actor?: string): Promise<number> {
    return this.outstanding.track(async () => {
      this.writes.push({ input, actor });
      if (this.writeGate) await this.writeGate;
      if (this.setError) throw this.setError;
      if (input.expectedVersion !== this.policy.version) throw new AgentPermissionError('PERMISSION_VERSION_CONFLICT', 'changed');
      this.policy = { ...this.policy, level: input.level, approvalTimeoutSeconds: input.approvalTimeoutSeconds, timeoutAction: input.timeoutAction, version: this.policy.version + 1 };
      this.audit.push({ version: this.policy.version, level: input.level, actor });
      return this.policy.version;
    });
  }
}

const sentResult = (command: SendTextCommand, overrides: Partial<SendResult> = {}): SendResult => ({ type: 'sendResult',
  accountId: command.accountId, workerInstanceId: command.workerInstanceId, controlEpoch: command.controlEpoch,
  requestId: command.requestId, status: 'sent', messageId: `sent-${command.requestId}`, error: null, ...overrides } as SendResult);

class FakeTransport implements PermissionCommandTransport {
  binding: WorkerBinding | null = { accountId: 'a', workerInstanceId: 'w1', controlEpoch: 1 };
  current = true;
  /** Every attempted send, in order. */
  commands: SendTextCommand[] = [];
  /** The signal passed with each send. */
  signals: Array<AbortSignal | undefined> = [];
  respond: (command: SendTextCommand, signal?: AbortSignal) => Promise<SendResult> = async (command) => sentResult(command);
  constructor(readonly outstanding = new Outstanding()) {}
  isAgentAccount(): Promise<boolean> { return this.outstanding.track(async () => true); }
  activeBinding(): Promise<WorkerBinding | null> { return this.outstanding.track(async () => this.binding); }
  isCurrentControl(): Promise<boolean> { return this.outstanding.track(async () => this.current); }
  send(command: SendTextCommand, signal?: AbortSignal): Promise<SendResult> {
    return this.outstanding.track(async () => {
      this.commands.push(command);
      this.signals.push(signal);
      return this.respond(command, signal);
    });
  }
}
/** A send that stays pending until its signal aborts, then resolves `unknown` like a cancelled gateway send. */
const sendUntilAborted = (command: SendTextCommand, signal?: AbortSignal) => new Promise<SendResult>((resolve) => {
  signal?.addEventListener('abort', () => resolve(sentResult(command, { status: 'unknown', messageId: null, error: 'cancelled' })), { once: true });
});

let sequence = 0;
const envelope = (text: string | null, overrides: Partial<InboundEnvelope> = {}): InboundEnvelope => {
  sequence += 1;
  return { eventId: `e${sequence}`, accountId: 'a', chatType: 'direct', chatId: 'c', senderId: 'admin', messageId: `m${sequence}`,
    kind: 'text', text, mentionIds: [], mentionRanges: [], replyToMessageId: null, ingestion: { source: 'live', cursor: null },
    occurredAt: '2026-10-21T00:00:00.000Z', attachments: [], raw: {}, ...overrides } as InboundEnvelope;
};

function setup(level: AgentExecutionLevel = 'workspace_write', locale: Locale | string = 'zh-TW') {
  const outstanding = new Outstanding();
  const repository = new FakeRepository(outstanding);
  repository.policy.level = level;
  const transport = new FakeTransport(outstanding);
  const clock = { now: 0 };
  let changed = 0;
  const service = new PermissionCommandService(repository, transport, { now: () => clock.now, onPolicyChanged: () => { changed += 1; }, locale });
  /** Texts of every attempted reply. */
  const replies = () => transport.commands.map((command) => command.text);
  const idle = async () => { for (let index = 0; index < 1000 && service.sizes().runners; index += 1) await Promise.resolve(); };
  /** Classifies, enqueues and drains one admitted message as LineService does for a direct admin message. */
  const say = async (text: string, overrides: Partial<InboundEnvelope> = {}) => {
    const source = envelope(text, overrides);
    const ticket = service.classify(source, true);
    if (ticket) service.enqueue(source, ticket);
    await idle();
    return claimed(ticket);
  };
  const run = async (source: InboundEnvelope, ticket: PermissionTicket) => { service.enqueue(source, ticket); await idle(); };
  return { repository, transport, outstanding, clock, service, replies, say, run, idle, changed: () => changed };
}


describe('PermissionCommandService', () => {
  it('composes permission prompts in all supported locales and falls back to English for unknown locales', async () => {
    const cases: Array<[Locale | string, string]> = [
      ['en', 'Current Agent permission: Workspace write'],
      ['zh-TW', '目前 Agent 執行權限：工作區可寫'],
      ['ja', '現在のAgent権限：ワークスペース書き込み'],
      ['ko', '현재 Agent 권한: 작업 공간 쓰기'],
      ['xx-YY', 'Current Agent permission: Workspace write'],
    ];
    for (const [locale, prefix] of cases) {
      const flow = setup('workspace_write', locale);
      expect(await flow.say('/permissions')).toBe(true);
      expect(flow.replies()[0]).toContain(prefix);
    }
    expect(linePrompt('unsupported', 'permissionFailure')).toBe('Unable to change permissions. Please try again later.');
  });

  (process.env.TEST_DATABASE_URL ? it : it.skip)('close settles after a locked capability lookup times out without sending a gateway reply', async () => {
    const { pool, close } = await createTestDatabase();
    const blocker: PoolClient = await pool.connect();
    const accountId = `permission-capability-${Date.now()}`;
    const accounts = new AccountRepository(pool);
    const { repository, transport, service } = setup();
    let lookupStarted!: () => void;
    const started = new Promise<void>((resolve) => { lookupStarted = resolve; });
    let gatewaySends = 0;
    try {
      await accounts.ensureAccount(accountId);
      await blocker.query('BEGIN');
      await blocker.query('LOCK TABLE line_accounts IN ACCESS EXCLUSIVE MODE');
      transport.binding = { accountId, workerInstanceId: 'w1', controlEpoch: 1 };
      transport.respond = async (command) => {
        lookupStarted();
        await accounts.resolveCapabilities(accountId);
        gatewaySends += 1;
        return sentResult(command);
      };
      const source = envelope('/permissions', { accountId });
      const ticket = service.classify(source, true)!;
      service.enqueue(source, ticket);
      await started;
      const startedAt = Date.now();
      await service.close();
      expect(Date.now() - startedAt).toBeLessThanOrEqual(3_500);
      expect(gatewaySends).toBe(0);
      expect(service.sizes()).toEqual({ queued: 0, runners: 0, pending: 0 });
      expect(repository.reads).toBe(1);
    } finally {
      await service.close();
      await blocker.query('ROLLBACK');
      blocker.release();
      await close();
    }
  });

  it('lists the levels verbatim with the current level marked', async () => {
    const { say, replies, transport } = setup();
    expect(await say('/權限')).toBe(true);
    expect(replies()).toEqual([LIST_WORKSPACE_WRITE]);
    expect(transport.commands[0]).toMatchObject({ type: 'sendText', accountId: 'a', workerInstanceId: 'w1', controlEpoch: 1,
      chatType: 'direct', chatId: 'c' });
    expect(transport.commands[0]!.replyToMessageId).toMatch(/^m\d+$/);
    const full = setup('full');
    await full.say('/權限');
    expect(full.replies()).toEqual(['目前 Agent 執行權限：全部放行\n回覆數字變更（2 分鐘內有效）：\n1. 唯讀\n2. 工作區可寫\n3. 信任\n4. 全部放行（目前）']);
  });

  it('accepts /permissions in any case and surrounding whitespace', async () => {
    for (const text of ['/permissions', '/PERMISSIONS', '/Permissions', '  /權限  ', '\n/permissions\t']) {
      const { say, replies } = setup();
      expect(await say(text)).toBe(true);
      expect(replies()).toEqual([LIST_WORKSPACE_WRITE]);
    }
    const { say } = setup();
    expect(await say('/權限 1')).toBe(false);
    expect(await say('/permission')).toBe(false);
  });

  it('claims list and reply tickets only', () => {
    expect(claimed({ kind: 'list' })).toBe(true);
    expect(claimed({ kind: 'reply', pendingId: 1 })).toBe(true);
    expect(claimed({ kind: 'clear', pendingId: 1 })).toBe(false);
    expect(claimed(null)).toBe(false);
  });

  it('replies without writing when the same level is chosen and clears pending', async () => {
    const { say, replies, repository, changed } = setup();
    await say('/權限');
    expect(await say('2')).toBe(true);
    expect(replies().at(-1)).toBe('已經是 工作區可寫，未變更');
    expect(repository.writes).toEqual([]);
    expect(changed()).toBe(0);
    expect(await say('1')).toBe(false);
  });

  it('applies a tighter level immediately with the list-time version and the LINE admin actor', async () => {
    const { say, replies, repository, changed } = setup('trust');
    await say('/權限');
    expect(await say('1')).toBe(true);
    expect(repository.writes).toEqual([{ input: { level: 'read_only', approvalTimeoutSeconds: 60, timeoutAction: 'DENY', expectedVersion: 5 }, actor: 'line_primary_admin' }]);
    expect(replies().at(-1)).toBe('已改為 唯讀');
    expect(changed()).toBe(1);
    expect(await say('1')).toBe(false);
  });

  it('asks before loosening and applies only on 確認, 是, yes or YES', async () => {
    for (const answer of ['確認', '是', 'yes', 'YES', ' yes ']) {
      const { say, replies, repository, changed } = setup();
      await say('/權限');
      expect(await say('4')).toBe(true);
      expect(replies().at(-1)).toBe(LOOSEN_FULL);
      expect(repository.writes).toEqual([]);
      expect(await say(answer)).toBe(true);
      expect(repository.writes).toEqual([{ input: { level: 'full', approvalTimeoutSeconds: 60, timeoutAction: 'DENY', expectedVersion: 5 }, actor: 'line_primary_admin' }]);
      expect(replies().at(-1)).toBe('已放寬為 全部放行');
      expect(changed()).toBe(1);
      expect(await say('確認')).toBe(false);
    }
  });

  it('cancels a loosening confirmation on any other text and keeps it from the Agent', async () => {
    for (const answer of ['不要', 'no', '4', '確認一下']) {
      const { say, replies, repository } = setup();
      await say('/權限');
      await say('3');
      expect(await say(answer)).toBe(true);
      expect(replies().at(-1)).toBe('已取消');
      expect(repository.writes).toEqual([]);
      expect(await say('確認')).toBe(false);
    }
  });

  it('releases a non-number at the choose stage to the Agent and clears pending', async () => {
    const { say, replies, service } = setup();
    await say('/權限');
    expect(service.classify(envelope('hello'), true)).toEqual({ kind: 'clear', pendingId: expect.any(Number) });
    expect(await say('hello')).toBe(false);
    expect(await say('5')).toBe(false);
    expect(await say('1')).toBe(false);
    expect(replies()).toEqual([LIST_WORKSPACE_WRITE]);
  });

  it('accepts full-width digits', async () => {
    const { say, replies, repository } = setup('full');
    await say('/權限');
    expect(await say('１')).toBe(true);
    expect(replies().at(-1)).toBe('已改為 唯讀');
    expect(repository.writes).toHaveLength(1);
    const loosen = setup();
    await loosen.say('/權限');
    expect(await loosen.say('３')).toBe(true);
    expect(loosen.replies().at(-1)).toBe('確定要放寬為 信任？回覆「確認」套用，回覆其他內容取消（2 分鐘內有效）');
  });

  it('expires the choose stage at 120 seconds', async () => {
    const early = setup('full');
    await early.say('/權限');
    early.clock.now = 119_999;
    expect(await early.say('1')).toBe(true);
    const late = setup('full');
    await late.say('/權限');
    late.clock.now = 120_000;
    expect(await late.say('1')).toBe(false);
    expect(late.repository.writes).toEqual([]);
    expect(await late.say('1')).toBe(false);
  });

  it('expires the confirm stage at 120 seconds', async () => {
    const early = setup();
    await early.say('/權限');
    early.clock.now = 10_000;
    await early.say('4');
    early.clock.now = 129_999;
    expect(await early.say('確認')).toBe(true);
    expect(early.repository.writes).toHaveLength(1);
    const late = setup();
    await late.say('/權限');
    late.clock.now = 10_000;
    await late.say('4');
    late.clock.now = 130_000;
    expect(await late.say('確認')).toBe(false);
    expect(late.repository.writes).toEqual([]);
  });

  it('(f) measures expiry from arming, not from classification or creation', async () => {
    const { service, repository, clock, say, replies, idle } = setup('full');
    const read = deferred();
    repository.gates.push(read.promise);
    const list = envelope('/權限');
    service.enqueue(list, service.classify(list, true)!);
    clock.now = 50_000;
    await flush();
    expect(service.classify(envelope('1'), true)).toBeNull();
    read.resolve();
    await idle();
    expect(replies()).toEqual([listText('full')]);
    clock.now = 169_999;
    expect(service.classify(envelope('1'), true)).toEqual({ kind: 'reply', pendingId: expect.any(Number) });
    clock.now = 170_000;
    expect(service.classify(envelope('1'), true)).toBeNull();
    expect(await say('1')).toBe(false);
    expect(repository.writes).toEqual([]);

    // The confirm question is likewise armed when its send resolves as sent.
    const confirm = setup();
    await confirm.say('/權限');
    const sendGate = deferred();
    confirm.transport.respond = async (command) => { await sendGate.promise; return sentResult(command); };
    const choice = envelope('4');
    confirm.service.enqueue(choice, confirm.service.classify(choice, true)!);
    await flush();
    confirm.clock.now = 30_000;
    expect(confirm.service.classify(envelope('確認'), true)).toBeNull();
    sendGate.resolve();
    await confirm.idle();
    expect(confirm.replies().at(-1)).toBe(LOOSEN_FULL);
    confirm.clock.now = 149_999;
    expect(await confirm.say('確認')).toBe(true);
    expect(confirm.replies().at(-1)).toBe('已放寬為 全部放行');
  });

  it('replies with the conflict text only for a version conflict', async () => {
    const tighten = setup('trust');
    await tighten.say('/權限');
    tighten.repository.policy.version = 6;
    await tighten.say('1');
    expect(tighten.replies().at(-1)).toBe(CONFLICT);
    expect(tighten.changed()).toBe(0);

    const loosen = setup();
    await loosen.say('/權限');
    await loosen.say('4');
    loosen.repository.policy.version = 6;
    await loosen.say('確認');
    expect(loosen.replies().at(-1)).toBe(CONFLICT);
    expect(loosen.changed()).toBe(0);
  });

  it.each(['en', 'zh-TW', 'ja', 'ko'] as const)('localizes conflict and failure outcomes in %s without changing authorization', async (locale) => {
    const conflict = setup('trust', locale);
    await conflict.say('/permissions');
    conflict.repository.policy.version += 1;
    await conflict.say('1');
    expect(conflict.replies().at(-1)).toBe(linePrompt(locale, 'permissionConflict'));
    expect(conflict.repository.policy.level).toBe('trust');
    expect(conflict.repository.audit).toEqual([]);

    const failure = setup('trust', locale);
    await failure.say('/permissions');
    failure.repository.setError = new Error('write failed');
    await failure.say('1');
    expect(failure.replies().at(-1)).toBe(linePrompt(locale, 'permissionFailure'));
    expect(failure.repository.policy.level).toBe('trust');
    expect(failure.repository.audit).toEqual([]);
  });

  it('replies with the generic failure text for any other error', async () => {
    const write = setup('trust');
    await write.say('/權限');
    write.repository.setError = new AgentPermissionError('INVALID_POLICY', 'bad');
    await write.say('1');
    expect(write.replies().at(-1)).toBe(FAILURE);

    const plain = setup('trust');
    await plain.say('/權限');
    plain.repository.setError = new Error('PERMISSION_VERSION_CONFLICT');
    await plain.say('1');
    expect(plain.replies().at(-1)).toBe(FAILURE);

    const list = setup();
    list.repository.getError = new Error('database down');
    expect(await list.say('/權限')).toBe(true);
    expect(list.replies()).toEqual([FAILURE]);
    list.repository.getError = null;
    // The list was never shown, so the choice is not armed and goes to the Agent.
    expect(await list.say('1')).toBe(false);
    expect(list.replies()).toEqual([FAILURE]);
    expect(list.repository.writes).toEqual([]);
    expect(write.changed() + plain.changed() + list.changed()).toBe(0);
  });

  it('(a) arms only the last list of /permissions, 4, /permissions and then applies a tighter level', async () => {
    const { service, repository, replies, say, idle } = setup('trust');
    const firstRead = deferred(), secondRead = deferred();
    repository.gates.push(firstRead.promise, secondRead.promise);
    const batch = [envelope('/permissions'), envelope('4'), envelope('/permissions')];
    const tickets = batch.map((source) => service.classify(source, true));
    expect(tickets).toEqual([{ kind: 'list' }, null, { kind: 'list' }]);
    expect(tickets.map(claimed)).toEqual([true, false, true]);
    service.enqueue(batch[0]!, tickets[0]!);
    service.enqueue(batch[2]!, tickets[2]!);
    await flush();
    expect(replies()).toEqual([]);
    expect(service.classify(envelope('1'), true)).toBeNull();
    firstRead.resolve();
    await flush();
    expect(replies()).toEqual([listText('trust')]);
    // The second list replaced the first with a new, still unarmed entry before its read resolved.
    expect(service.classify(envelope('1'), true)).toBeNull();
    secondRead.resolve();
    await idle();
    expect(replies()).toEqual([listText('trust'), listText('trust')]);
    expect(service.classify(envelope('1'), true)).toEqual({ kind: 'reply', pendingId: expect.any(Number) });
    expect(await say('1')).toBe(true);
    expect(repository.writes).toEqual([{ input: { level: 'read_only', approvalTimeoutSeconds: 60, timeoutAction: 'DENY', expectedVersion: 5 }, actor: 'line_primary_admin' }]);
    expect(replies().at(-1)).toBe('已改為 唯讀');
  });

  it('(b) does not claim 4 or yes classified in the same batch as /permissions', async () => {
    const { service, repository, replies, run } = setup();
    const batch = [envelope('/permissions'), envelope('4'), envelope('yes')];
    const tickets = batch.map((source) => service.classify(source, true));
    expect(tickets).toEqual([{ kind: 'list' }, null, null]);
    for (const [index, ticket] of tickets.entries()) if (ticket) await run(batch[index]!, ticket);
    expect(repository.writes).toEqual([]);
    expect(replies()).toEqual([LIST_WORKSPACE_WRITE]);
    expect(service.classify(envelope('4'), true)).toEqual({ kind: 'reply', pendingId: expect.any(Number) });
  });

  it('(c) answers a stale reply ticket with the expired text and writes nothing', async () => {
    const { service, repository, replies, say, run } = setup('full');
    await say('/權限');
    const choice = envelope('3');
    const stale = service.classify(choice, true)!;
    expect(stale.kind).toBe('reply');
    const stop = envelope('hello');
    const staleClear = service.classify(stop, true)!;
    expect(staleClear.kind).toBe('clear');
    const list = envelope('/權限');
    await run(list, service.classify(list, true)!);
    await run(choice, stale);
    expect(replies().at(-1)).toBe(STALE);
    // A stale clear does not remove the newer list either.
    await run(stop, staleClear);
    expect(replies().at(-1)).toBe(STALE);
    expect(repository.writes).toEqual([]);
    expect(await say('1')).toBe(true);
    expect(replies().at(-1)).toBe('已改為 唯讀');

    // Applying the same reply ticket twice writes once; the second is stale.
    const twice = setup('trust');
    await twice.say('/權限');
    const one = envelope('1');
    const ticket = twice.service.classify(one, true)!;
    await twice.run(one, ticket);
    await twice.run(one, ticket);
    expect(twice.repository.writes).toHaveLength(1);
    expect(twice.replies().slice(1)).toEqual(['已改為 唯讀', STALE]);
  });

  it('(d) leaves an entry unarmed when its prompt send throws', async () => {
    const { repository, transport, say } = setup('trust');
    transport.respond = async () => { throw new Error('LINE send failed'); };
    expect(await say('/權限')).toBe(true);
    transport.respond = async (command) => sentResult(command);
    expect(await say('1')).toBe(false);
    expect(repository.writes).toEqual([]);

    // A failed confirm prompt consumes the choice and leaves the confirmation unarmed.
    const loosen = setup();
    await loosen.say('/權限');
    loosen.transport.respond = async () => { throw new Error('LINE send failed'); };
    expect(await loosen.say('4')).toBe(true);
    loosen.transport.respond = async (command) => sentResult(command);
    expect(await loosen.say('確認')).toBe(false);
    expect(loosen.repository.writes).toEqual([]);
    expect(await loosen.say('/權限')).toBe(true);
    expect(await loosen.say('4')).toBe(true);
    expect(loosen.replies().at(-1)).toBe(LOOSEN_FULL);
  });

  it('keeps the list and confirm prompts unarmed when the send resolves failed or unknown', async () => {
    for (const status of ['failed', 'unknown'] as const) {
      const list = setup('trust');
      list.transport.respond = async (command) => sentResult(command, { status, messageId: null, error: 'not sent' });
      expect(await list.say('/權限')).toBe(true);
      expect(list.replies()).toEqual([listText('trust')]);
      expect(list.service.classify(envelope('1'), true)).toBeNull();
      expect(await list.say('1')).toBe(false);
      expect(await list.say('確認')).toBe(false);
      expect(list.repository.writes).toEqual([]);
      expect(list.replies()).toHaveLength(1);

      const confirm = setup();
      await confirm.say('/權限');
      confirm.transport.respond = async (command) => sentResult(command, { status, messageId: null, error: 'not sent' });
      expect(await confirm.say('4')).toBe(true);
      expect(confirm.replies().at(-1)).toBe(LOOSEN_FULL);
      expect(confirm.service.classify(envelope('確認'), true)).toBeNull();
      expect(await confirm.say('確認')).toBe(false);
      expect(await confirm.say('yes')).toBe(false);
      expect(confirm.repository.writes).toEqual([]);
      expect(confirm.service.sizes()).toEqual({ queued: 0, runners: 0, pending: 1 });
    }
  });

  it('treats a requestId, account, worker, epoch or messageId mismatch and an inactive binding as not sent', async () => {
    const variants: Array<[string, (command: SendTextCommand) => Partial<SendResult>]> = [
      ['requestId', () => ({ requestId: 'other-request' })],
      ['accountId', () => ({ accountId: 'other-account' })],
      ['workerInstanceId', () => ({ workerInstanceId: 'other-worker' })],
      ['controlEpoch', (command) => ({ controlEpoch: command.controlEpoch + 1 })],
      ['messageId', () => ({ messageId: null })],
    ];
    for (const [, mismatch] of variants) {
      const { transport, say, repository } = setup('trust');
      transport.respond = async (command) => sentResult(command, mismatch(command));
      expect(await say('/權限')).toBe(true);
      expect(transport.commands).toHaveLength(1);
      expect(await say('1')).toBe(false);
      expect(repository.writes).toEqual([]);
    }
    const unbound = setup('trust');
    unbound.transport.binding = null;
    expect(await unbound.say('/權限')).toBe(true);
    expect(unbound.transport.commands).toEqual([]);
    expect(await unbound.say('1')).toBe(false);
    const stale = setup('trust');
    stale.transport.current = false;
    expect(await stale.say('/權限')).toBe(true);
    expect(stale.transport.commands).toEqual([]);
    expect(await stale.say('1')).toBe(false);
    const otherAccount = setup('trust');
    otherAccount.transport.binding = { accountId: 'b', workerInstanceId: 'w1', controlEpoch: 1 };
    expect(await otherAccount.say('/權限')).toBe(true);
    expect(otherAccount.transport.commands).toEqual([]);
    expect(await otherAccount.say('1')).toBe(false);
  });

  it('(e) classify has no side effects when repeated or out of order', async () => {
    const { service, repository, replies, say } = setup();
    for (let index = 0; index < 3; index += 1) {
      expect(service.classify(envelope('/權限'), true)).toEqual({ kind: 'list' });
      expect(service.classify(envelope('1'), true)).toBeNull();
    }
    expect(repository.reads).toBe(0);
    expect(replies()).toEqual([]);
    expect(service.sizes()).toEqual({ queued: 0, runners: 0, pending: 0 });
    await say('/權限');
    const tickets = ['hello', '3', '/權限', '確認', '3', 'hello'].map((text) => service.classify(envelope(text), true));
    const id = (tickets[1] as Extract<PermissionTicket, { kind: 'reply' }>).pendingId;
    expect(tickets).toEqual([{ kind: 'clear', pendingId: id }, { kind: 'reply', pendingId: id }, { kind: 'list' },
      { kind: 'clear', pendingId: id }, { kind: 'reply', pendingId: id }, { kind: 'clear', pendingId: id }]);
    expect(repository.reads).toBe(1);
    expect(replies()).toEqual([LIST_WORKSPACE_WRITE]);
    expect(await say('3')).toBe(true);
    expect(replies().at(-1)).toBe('確定要放寬為 信任？回覆「確認」套用，回覆其他內容取消（2 分鐘內有效）');
  });

  it('does not classify non-admin, group, non-live or non-text messages', () => {
    const { service } = setup();
    expect(service.classify(envelope('/權限'), false)).toBeNull();
    expect(service.classify(envelope('/權限', { chatType: 'group', chatId: 'g' }), true)).toBeNull();
    expect(service.classify(envelope('/權限', { ingestion: { source: 'history', cursor: null } }), true)).toBeNull();
    expect(service.classify(envelope(null, { kind: 'image' }), true)).toBeNull();
    expect(service.classify(envelope('/權限', { kind: 'image' }), true)).toBeNull();
    expect(service.classify(envelope('/權限'), true)).toEqual({ kind: 'list' });
    expect(service.classify(envelope('1'), false)).toBeNull();
  });

  it('keeps at most 64 pending chats and evicts the oldest', async () => {
    const { say, service } = setup();
    for (let index = 0; index <= 64; index += 1) expect(await say('/權限', { chatId: `c${index}` })).toBe(true);
    expect(service.sizes().pending).toBe(64);
    expect(service.classify(envelope('2', { chatId: 'c0' }), true)).toBeNull();
    expect(service.classify(envelope('2', { chatId: 'c1' }), true)?.kind).toBe('reply');
    expect(service.classify(envelope('2', { chatId: 'c64' }), true)?.kind).toBe('reply');
  });

  it('expires unarmed entries 120 seconds after creation and prunes them before evicting live ones', async () => {
    const { service, repository, transport, clock, say, idle } = setup();
    const read = deferred();
    repository.gates.push(read.promise);
    const keep = envelope('/權限', { chatId: 'keep' });
    service.enqueue(keep, service.classify(keep, true)!);
    await flush();
    transport.respond = async (command) => sentResult(command, { status: 'failed', messageId: null });
    for (let index = 0; index < 63; index += 1) await say('/權限', { chatId: `unarmed${index}` });
    transport.respond = async (command) => sentResult(command);
    clock.now = 100_000;
    read.resolve();
    await idle();
    clock.now = 130_000;
    expect(await say('/權限', { chatId: 'new' })).toBe(true);
    expect(service.classify(envelope('2', { chatId: 'keep' }), true)?.kind).toBe('reply');
    expect(service.classify(envelope('2', { chatId: 'new' }), true)?.kind).toBe('reply');
  });

  it('bounds queued tickets to 4 per chat and 64 overall and drops overflow without a reply or write', async () => {
    const { service, repository, replies, idle } = setup('trust');
    const read = deferred();
    repository.gates.push(read.promise);
    for (let index = 0; index < 10; index += 1) {
      const source = envelope('/權限');
      service.enqueue(source, service.classify(source, true)!);
    }
    expect(service.sizes()).toMatchObject({ queued: 4, runners: 1 });
    for (let index = 0; index < 70; index += 1) {
      const source = envelope('/權限', { chatId: `burst${index}` });
      service.enqueue(source, service.classify(source, true)!);
    }
    expect(service.sizes()).toMatchObject({ queued: 64, runners: 61 });
    await until(() => service.sizes().runners === 1);
    expect(replies()).toEqual(Array(60).fill(listText('trust')));
    expect(service.sizes()).toMatchObject({ queued: 4, runners: 1 });
    read.resolve();
    await idle();
    expect(replies()).toHaveLength(64);
    expect(repository.reads).toBe(64);
    expect(repository.writes).toEqual([]);
    expect(service.sizes()).toEqual({ queued: 0, runners: 0, pending: 61 });

    // A held send keeps the backlog bounded too; overflow choices are neither answered nor written.
    const held = setup('full');
    await held.say('/權限');
    const sendGate = deferred();
    held.transport.respond = async (command) => { await sendGate.promise; return sentResult(command); };
    const first = envelope('1');
    const ticket = held.service.classify(first, true)!;
    for (let index = 0; index < 8; index += 1) held.service.enqueue(index ? envelope('1') : first, ticket);
    expect(held.service.sizes()).toMatchObject({ queued: 4, runners: 1 });
    sendGate.resolve();
    await held.idle();
    expect(held.repository.writes).toHaveLength(1);
    expect(held.replies().slice(1)).toEqual(['已改為 唯讀', STALE, STALE, STALE]);
  });

  it('removes a runner once its queue is empty and starts a fresh one later', async () => {
    const { service, say } = setup('trust');
    await say('/權限');
    expect(service.sizes()).toEqual({ queued: 0, runners: 0, pending: 1 });
    await say('4');
    expect(service.sizes()).toEqual({ queued: 0, runners: 0, pending: 1 });
    await say('確認');
    expect(service.sizes()).toEqual({ queued: 0, runners: 0, pending: 0 });
  });

  it('notifies a policy change only after a successful write', async () => {
    const { say, repository, changed } = setup('trust');
    await say('/權限'); await say('3');
    await say('/權限'); await say('4'); await say('不要');
    await say('/權限'); repository.setError = new Error('boom'); await say('1');
    expect(changed()).toBe(0);
    repository.setError = null;
    await say('/權限'); await say('1');
    expect(changed()).toBe(1);
  });

  it('holds the slot through a stalled write without a failure reply, then reports the committed result', async () => {
    const { service, repository, replies, say, idle, outstanding, changed } = setup('trust');
    await say('/權限');
    const gate = deferred();
    repository.writeGate = gate.promise;
    const choice = envelope('1');
    service.enqueue(choice, service.classify(choice, true)!);
    await until(() => repository.writes.length === 1);
    await flush();
    expect(replies()).toEqual([listText('trust')]);
    expect(service.sizes()).toMatchObject({ queued: 1, runners: 1 });
    expect(outstanding.current).toBe(1);
    // The in-flight write keeps its slot, so only 3 more tickets fit in this chat.
    for (let index = 0; index < 6; index += 1) service.enqueue(envelope('/權限'), { kind: 'list' });
    expect(service.sizes()).toMatchObject({ queued: 4, runners: 1 });
    expect(repository.policy).toMatchObject({ level: 'trust', version: 5 });
    expect(repository.audit).toEqual([]);
    gate.resolve();
    await idle();
    expect(replies()).toEqual([listText('trust'), '已改為 唯讀', listText('read_only'), listText('read_only'), listText('read_only')]);
    expect(repository.policy).toMatchObject({ level: 'read_only', approvalTimeoutSeconds: 60, version: 6 });
    expect(repository.audit).toEqual([{ version: 6, level: 'read_only', actor: 'line_primary_admin' }]);
    expect(changed()).toBe(1);
    expect(service.sizes()).toEqual({ queued: 0, runners: 0, pending: 1 });
    expect(outstanding.current).toBe(0);
  });

  it('close() waits for a stalled write, keeps its committed result and sends nothing afterwards', async () => {
    const { service, repository, transport, replies, say, outstanding } = setup('trust');
    await say('/權限');
    const gate = deferred();
    repository.writeGate = gate.promise;
    const choice = envelope('1');
    service.enqueue(choice, service.classify(choice, true)!);
    service.enqueue(envelope('/權限'), { kind: 'list' });
    await until(() => repository.writes.length === 1);
    let closed = false;
    const closing = service.close().then(() => { closed = true; });
    await flush();
    expect(closed).toBe(false);
    expect(service.sizes()).toMatchObject({ queued: 1, runners: 1, pending: 0 });
    gate.resolve();
    await closing;
    expect(repository.policy).toMatchObject({ level: 'read_only', version: 6 });
    expect(repository.audit).toEqual([{ version: 6, level: 'read_only', actor: 'line_primary_admin' }]);
    expect(replies()).toEqual([listText('trust')]);
    expect(repository.reads).toBe(2);
    expect(service.sizes()).toEqual({ queued: 0, runners: 0, pending: 0 });
    expect(outstanding.current).toBe(0);
    // After close resolves no repository or transport call happens.
    const calls = { reads: repository.reads, writes: repository.writes.length, sends: transport.commands.length };
    service.enqueue(envelope('/權限'), { kind: 'list' });
    expect(service.classify(envelope('/權限'), true)).toBeNull();
    await flush();
    expect({ reads: repository.reads, writes: repository.writes.length, sends: transport.commands.length }).toEqual(calls);
    expect(service.sizes()).toEqual({ queued: 0, runners: 0, pending: 0 });

    // A stalled write that fails during close is not answered either.
    const conflict = setup('trust');
    await conflict.say('/權限');
    const conflictGate = deferred();
    conflict.repository.writeGate = conflictGate.promise;
    const late = envelope('1');
    conflict.service.enqueue(late, conflict.service.classify(late, true)!);
    await until(() => conflict.repository.writes.length === 1);
    conflict.repository.policy.version = 9;
    const conflictClosing = conflict.service.close();
    conflictGate.resolve();
    await conflictClosing;
    expect(conflict.repository.policy).toMatchObject({ level: 'trust', version: 9 });
    expect(conflict.repository.audit).toEqual([]);
    expect(conflict.replies()).toEqual([listText('trust')]);
  });

  it('close() aborts a stalled send through its signal and leaves the entry unarmed', async () => {
    const { service, transport, repository, outstanding } = setup('trust');
    transport.respond = sendUntilAborted;
    const list = envelope('/權限');
    service.enqueue(list, service.classify(list, true)!);
    await until(() => transport.commands.length === 1);
    expect(transport.signals[0]).toBeInstanceOf(AbortSignal);
    expect(transport.signals[0]!.aborted).toBe(false);
    expect(service.classify(envelope('1'), true)).toBeNull();
    await service.close();
    expect(transport.signals[0]!.aborted).toBe(true);
    expect(service.sizes()).toEqual({ queued: 0, runners: 0, pending: 0 });
    expect(outstanding.current).toBe(0);
    expect(transport.commands).toHaveLength(1);
    expect(repository.writes).toEqual([]);

    // A cancelled (unknown) send result alone also leaves the prompt unarmed.
    const cancelled = setup('trust');
    cancelled.transport.respond = async (command) => sentResult(command, { status: 'unknown', messageId: null, error: 'cancelled' });
    expect(await cancelled.say('/權限')).toBe(true);
    expect(cancelled.service.classify(envelope('1'), true)).toBeNull();
  });

  it('close() waits for a stalled read and then sends nothing', async () => {
    const { service, repository, replies, outstanding } = setup('trust');
    const gate = deferred();
    repository.gates.push(gate.promise);
    const list = envelope('/權限');
    service.enqueue(list, service.classify(list, true)!);
    await flush();
    let closed = false;
    const closing = service.close().then(() => { closed = true; });
    await flush();
    expect(closed).toBe(false);
    gate.resolve();
    await closing;
    expect(replies()).toEqual([]);
    expect(repository.reads).toBe(1);
    expect(service.sizes()).toEqual({ queued: 0, runners: 0, pending: 0 });
    expect(outstanding.current).toBe(0);
  });

  it('never exceeds the caps in outstanding operations across repeated stall and release cycles', async () => {
    const { service, repository, transport, outstanding, replies } = setup('trust');
    const held: Array<() => void> = [];
    const hold = () => new Promise<void>((resolve) => { held.push(resolve); });
    repository.readHook = hold;
    transport.respond = async (command) => { await hold(); return sentResult(command); };
    let accepted = 0;
    for (let round = 0; round < 12; round += 1) {
      for (let index = 0; index < 120; index += 1) {
        const before = service.sizes().queued;
        const source = envelope('/權限', { chatId: `cycle${(round * 7 + index) % 90}` });
        service.enqueue(source, service.classify(source, true)!);
        accepted += service.sizes().queued - before;
      }
      expect(service.sizes().queued).toBeLessThanOrEqual(64);
      expect(service.sizes().runners).toBeLessThanOrEqual(64);
      await flush();
      expect(outstanding.current).toBeLessThanOrEqual(64);
      for (const release of held.splice(0, Math.ceil(held.length / 2))) release();
      await flush();
    }
    for (let index = 0; index < 200 && (service.sizes().runners || held.length); index += 1) {
      for (const release of held.splice(0)) release();
      await flush();
    }
    expect(service.sizes()).toMatchObject({ queued: 0, runners: 0 });
    expect(outstanding.max).toBeLessThanOrEqual(64);
    expect(outstanding.max).toBeGreaterThan(4);
    expect(outstanding.current).toBe(0);
    expect(replies()).toHaveLength(accepted);
    expect(repository.reads).toBe(accepted);
    expect(repository.writes).toEqual([]);
  });
});
