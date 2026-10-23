import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Pool } from 'pg';
import type { LineWorkerCommand } from '@line-agent/contracts';
import { createTestDatabase } from '../../../../../packages/database/src/test-database.js';
import { AccountRepository } from '../../../../../packages/database/src/account-repository.js';
import { AgentRepository, MessageRepository } from '../../../../../packages/database/src/index.js';
import { AccountSupervisor } from './line-service.js';
import { createUtilityWorkerGateway } from '../utility-worker-gateway.js';

const database = process.env.TEST_DATABASE_URL ? describe : describe.skip;

describe('AccountSupervisor lifecycle queue cancellation', () => {
  it('settles an aborted lifecycle operation before it starts and skips it when the queue advances', async () => {
    const supervisor = new AccountSupervisor({} as AccountRepository, { async spawn() {
      throw new Error('No worker should be spawned by this queue test');
    } });
    let releaseFirst!: () => void;
    let enterFirst!: () => void;
    const firstEntered = new Promise<void>((resolve) => { enterFirst = resolve; });
    const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve; });
    const first = supervisor.runLifecycle(async () => { enterFirst(); await firstGate; });
    await firstEntered;

    const controller = new AbortController();
    let secondStarted = false;
    const second = supervisor.runLifecycle(async () => { secondStarted = true; }, controller.signal);
    controller.abort();
    const outcome = await Promise.race([second.then(() => 'settled', () => 'rejected'),
      new Promise<'waiting'>((resolve) => setTimeout(() => resolve('waiting'), 20))]);

    releaseFirst();
    await first;
    await second.catch(() => undefined);
    expect(outcome).toBe('settled');
    expect(secondStarted).toBe(false);
  });
});

describe('AccountSupervisor revoke fallback', () => {
  it('starts physical cancellation before synchronously publishing committed revocation projections', async () => {
    let finishCancel!: () => void;
    const cancelGate = new Promise<void>((resolve) => { finishCancel = resolve; });
    const order: string[] = [];
    const projection = { accountId: 'a', chatType: 'direct' as const, chatId: 'chat', jobId: 'job', sourceType: 'line' as const,
      sourceMessageId: 'source', status: 'cancelled' as const, revision: '12345678901234567' };
    const accounts = { async revokeControl() {
      order.push('commit');
      return { controlEpoch: 2, activeAccountId: null, revoked: true, revokedAccountId: 'a',
        inFlightJobIds: ['job'], inFlightDeliveryIds: [], cancelledJobs: [projection] };
    } } as unknown as AccountRepository;
    const supervisor = new AccountSupervisor(accounts, { async spawn() { throw new Error('unused'); } }, 1000, undefined,
      async () => { order.push('physical-cancel-start'); await cancelGate; }, (row) => { order.push(`publish:${row.revision}`); });

    const revoking = supervisor.revokeControlAndCancel(1);
    await Promise.resolve();
    expect(order).toEqual(['commit', 'physical-cancel-start', 'publish:12345678901234567']);
    finishCancel();
    await revoking;
  });

  it('restarts a killed revoked worker in monitor mode before granting control elsewhere', async () => {
    let state = { activeAccountId: null as string | null, controlEpoch: 0 };
    const accounts = {
      async getControlState() { return { ...state }; },
      async revokeControl(controlEpoch: number) {
        if (controlEpoch !== state.controlEpoch) return { ...state, revoked: false,
          revokedAccountId: null, inFlightJobIds: [], inFlightDeliveryIds: [] };
        const revokedAccountId = state.activeAccountId;
        state = { activeAccountId: null, controlEpoch: state.controlEpoch + 1 };
        return { ...state, revoked: true, revokedAccountId, inFlightJobIds: [], inFlightDeliveryIds: [] };
      },
      async activateControl(accountId: string, expectedEpoch: number) {
        if (state.activeAccountId !== null || state.controlEpoch !== expectedEpoch) return { ...state, activated: false };
        state = { activeAccountId: accountId, controlEpoch: state.controlEpoch };
        return { ...state, activated: true };
      },
    } as unknown as AccountRepository;
    const starts: Array<{ accountId: string; instance: string; epoch: number; mode: string }> = [];
    const steps: string[] = [];
    const supervisor = new AccountSupervisor(accounts, { async spawn(accountId, instance, epoch, mode) {
      const startMode = mode ?? 'ACTIVE_CONTROL';
      starts.push({ accountId, instance, epoch, mode: startMode });
      steps.push(`spawn:${accountId}:${startMode}`);
      return {
        async send(command: LineWorkerCommand) {
          if (command.type === 'revokeControl') await new Promise<void>(() => undefined);
        },
        async waitModeAck(ackMode) { return ackMode === startMode; },
        async killAndWait() { steps.push(`killed:${accountId}`); },
      };
    } }, 25);
    await supervisor.switchTo('old-account');

    await expect(supervisor.switchTo('new-account')).resolves.toMatchObject({ accountId: 'new-account', mode: 'ACTIVE_CONTROL' });

    const oldActive = starts[0]!;
    const monitor = starts[1]!;
    expect(steps).toContain('killed:old-account');
    expect(monitor).toMatchObject({ accountId: 'old-account', mode: 'MONITOR_ONLY', epoch: 1 });
    expect(monitor.instance).not.toBe(oldActive.instance);
    expect(starts[2]).toMatchObject({ accountId: 'new-account', mode: 'ACTIVE_CONTROL', epoch: 1 });
  });
});

database('AccountSupervisor with PostgreSQL', () => {
  let pool: Pool; let close: () => Promise<void>; let accounts: AccountRepository;
  beforeAll(async () => { ({ pool, close } = await createTestDatabase());
    // Fixed account roles (migration 026) allow exactly one AGENT slot and activateControl only admits that slot.
    // These tests exercise the supervisor's revoke/grant protocol between two accounts, so the fixture moves the
    // AGENT slot to whichever account is being granted control; production never swaps roles this way.
    const repository = new AccountRepository(pool);
    accounts = new Proxy(repository, { get(target, property) {
      if (property === 'activateControl') return async (accountId: string, expectedEpoch: number) => {
        await pool.query("UPDATE line_accounts SET product_role=NULL WHERE product_role='AGENT' AND account_id<>$1", [accountId]);
        await pool.query("UPDATE line_accounts SET product_role='AGENT' WHERE account_id=$1", [accountId]);
        return target.activateControl(accountId, expectedEpoch);
      };
      const value = Reflect.get(target, property, target);
      return typeof value === 'function' ? value.bind(target) : value;
    } });
    await accounts.ensureAccount('a'); await accounts.ensureAccount('b'); });
  afterAll(async () => { await close?.(); });

  it('switches A→B→A with rising epoch and rejects the first A instance', async () => {
    const created: Array<{ accountId: string; instance: string; epoch: number; commands: LineWorkerCommand[]; killed: boolean }> = [];
    const supervisor = new AccountSupervisor(accounts, { async spawn(accountId, instance, epoch) {
      const state = { accountId, instance, epoch, commands: [] as LineWorkerCommand[], killed: false }; created.push(state);
      return { async send(command: LineWorkerCommand) { state.commands.push(command); },
        async waitModeAck() { return true; }, async killAndWait() { state.killed = true; } };
    } });
    const first = await supervisor.switchTo('a');
    await supervisor.switchTo('b');
    const again = await supervisor.switchTo('a');
    expect([first.controlEpoch, again.controlEpoch]).toEqual([1, 3]);
    expect(created.map((item) => [item.accountId, item.epoch])).toEqual([['a', 1], ['b', 2], ['a', 3]]);
    expect(created[0]?.commands).toMatchObject([{ type: 'revokeControl', accountId: 'a', controlEpoch: 1 }]);
    expect(supervisor.binding('a')).toMatchObject({ workerInstanceId: again.workerInstanceId, controlEpoch: 3 });
    expect(supervisor.isCurrent(first)).toBe(false);
  });

  it('kills and waits for an unresponsive old worker before granting the next account', async () => {
    const steps: string[] = [];
    const supervisor = new AccountSupervisor(accounts, { async spawn(accountId, _instance, _epoch, mode) {
      const startMode = mode ?? 'ACTIVE_CONTROL';
      steps.push(`spawn:${accountId}:${startMode}`);
      return { async send() { steps.push(`revoke:${accountId}`); },
        async waitModeAck(mode: string) { return mode === startMode; },
        async killAndWait() { steps.push(`killed:${accountId}`); } };
    } });
    const current = await accounts.getControlState();
    if (current.activeAccountId) await accounts.revokeControl(current.controlEpoch);
    const old = 'a'; const next = 'b';
    await supervisor.switchTo(old);
    await supervisor.switchTo(next);
    const killedIndex = steps.indexOf(`killed:${old}`);
    const replacementIndex = steps.indexOf(`spawn:${old}:MONITOR_ONLY`);
    const grantIndex = steps.lastIndexOf(`spawn:${next}:ACTIVE_CONTROL`);
    expect(killedIndex).toBeGreaterThanOrEqual(0);
    expect(replacementIndex).toBeGreaterThan(killedIndex);
    expect(grantIndex).toBeGreaterThan(replacementIndex);
    expect((await accounts.getControlState()).activeAccountId).toBe(next);
  });
  it('reports revoke and grant phases during an authoritative switch', async () => {
    const phases: string[] = [];
    const supervisor = new AccountSupervisor(accounts, { async spawn() { return {
      async send() {}, async waitModeAck() { return true; }, async killAndWait() {},
    }; } }, 1000, (phase) => phases.push(phase));
    const current = await accounts.getControlState();
    await supervisor.switchTo(current.activeAccountId === 'a' ? 'b' : 'a');
    expect(phases).toEqual(['revoking', 'granting', 'idle']);
  });
  it('awaits old Agent process cancellation before spawning the newly active worker', async () => {
    const state = await accounts.getControlState();
    const old = state.activeAccountId ?? 'a'; const next = old === 'a' ? 'b' : 'a';
    if (!state.activeAccountId) await accounts.activateControl(old, state.controlEpoch);
    const messages = new MessageRepository(pool); const agents = new AgentRepository(pool);
    const { jobId } = await messages.ingestAndRoute({ eventId: 'switch-job-event', accountId: old, chatType: 'direct', chatId: 'switch-job',
      senderId: 'u', messageId: 'switch-job-message', kind: 'text', text: 'work', mentionIds: [], mentionRanges: [],
      replyToMessageId: null, ingestion: { source: 'live', cursor: null }, occurredAt: '2026-10-15T00:00:00.000Z',
      attachments: [], raw: {} }, { eligible: true, provider: 'codex', prompt: 'work', workspacePath: 'C:\\trusted' });
    await agents.claimNext({ accountId: old, chatType: 'direct', chatId: 'switch-job' });
    const steps: string[] = [];
    const supervisor = new AccountSupervisor(accounts, { async spawn(accountId) { steps.push(`spawn:${accountId}`); return {
      async send() {}, async waitModeAck() { return true; }, async killAndWait() {},
    }; } }, 1000, undefined, async (cancelledJobId) => { steps.push(`cancel:${cancelledJobId}`); });
    await supervisor.switchTo(next);
    expect(steps).toEqual([`cancel:${jobId}`, `spawn:${next}`]);
  });
  it('kills a worker whose revoke send never resolves and continues the switch', async () => {
    const state = await accounts.getControlState();
    const old = state.activeAccountId ?? 'a'; const next = old === 'a' ? 'b' : 'a';
    const steps: string[] = [];
    const supervisor = new AccountSupervisor(accounts, { async spawn(accountId) {
      steps.push(`spawn:${accountId}`);
      return {
        async send(command: LineWorkerCommand) {
          if (command.type === 'revokeControl') await new Promise<void>(() => undefined);
        },
        async waitModeAck() { return true; },
        async killAndWait() { steps.push(`killed:${accountId}`); },
      };
    } }, 25);
    await supervisor.switchTo(old);
    const outcome = await Promise.race([supervisor.switchTo(next).then(() => 'switched'),
      new Promise<string>((resolve) => setTimeout(() => resolve('hung'), 500))]);
    expect(outcome).toBe('switched');
    expect(steps).toContain(`killed:${old}`);
    expect(steps.at(-1)).toBe(`spawn:${next}`);
  });


  it('retains a replacement barrier when adoption cannot acknowledge or confirm exit', async () => {
    class Child {
      private message?: (value?: unknown) => void;
      private exit?: (value?: unknown) => void;
      private owner: Record<string, unknown> = {};
      constructor(private readonly acknowledgeInit: boolean, private readonly exitOnKill: boolean) {}
      on(event: 'message' | 'exit', listener: (value?: unknown) => void) {
        if (event === 'message') this.message = listener; else this.exit = listener;
      }
      postMessage(value: unknown) {
        const command = value as LineWorkerCommand;
        if (command.type === 'init') {
          this.owner = { transportOwnerId: command.transportOwnerId, transportGeneration: command.transportGeneration,
            writeGrantVersion: command.writeGrantVersion };
          if (this.acknowledgeInit) queueMicrotask(() => {
            this.message?.({ type: 'workerProtocolAck', ...this.owner, accountId: command.accountId,
              workerInstanceId: command.workerInstanceId, controlEpoch: command.controlEpoch, protocolVersion: 4, manualSend: true });
            this.message?.({ type: 'modeAck', ...this.owner, accountId: command.accountId,
              workerInstanceId: command.workerInstanceId, controlEpoch: command.controlEpoch, mode: command.mode, drained: true });
          });
        }
      }
      kill() { if (this.exitOnKill) queueMicrotask(() => this.exit?.()); }
      confirmExit() { this.exit?.(); }
    }
    const accountA = `adopt-a-${crypto.randomUUID()}`; const accountB = `adopt-b-${crypto.randomUUID()}`;
    await pool.query("UPDATE line_accounts SET mode='MONITOR_ONLY' WHERE mode='ACTIVE_CONTROL'");
    await pool.query("INSERT INTO line_accounts(account_id,mode) VALUES ($1,'ACTIVE_CONTROL'),($2,'MONITOR_ONLY')", [accountA, accountB]);
    const children: Child[] = [];
    const starts: Array<{ accountId: string; mode: string }> = [];
    const gateway = createUtilityWorkerGateway({ spawn: (binding) => {
      starts.push({ accountId: binding.accountId, mode: binding.mode });
      const child = new Child(children.length !== 1, children.length !== 1); children.push(child); return child;
    }, stopTimeoutMs: 5, pollIntervalMs: 60_000 });
    const worker = (accountId: string) => ({
      send: async (command: LineWorkerCommand) => { await gateway.send(command); },
      waitModeAck: (mode: 'ACTIVE_CONTROL' | 'MONITOR_ONLY', timeoutMs: number) => gateway.waitRawModeAck!(accountId, mode, timeoutMs),
      killAndWait: () => gateway.stop(accountId),
    });
    const supervisor = new AccountSupervisor(accounts, { async spawn(id, instance, epoch, mode) {
      await gateway.start(id, { accountId: id, workerInstanceId: instance, controlEpoch: epoch, mode });
      return worker(id);
    } }, 5);
    const epoch = (await accounts.getControlState()).controlEpoch;
    const old = { accountId: accountA, workerInstanceId: crypto.randomUUID(), controlEpoch: epoch, mode: 'ACTIVE_CONTROL' as const };
    await gateway.start(accountA, old);
    await accounts.bindWorker(old);
    await supervisor.adopt(old, worker(accountA), true);
    await gateway.stop(accountA);
    expect(await supervisor.retire(old)).toBe(true);
    const replacement = { ...old, workerInstanceId: crypto.randomUUID() };
    await gateway.start(accountA, replacement);
    await accounts.bindWorker(replacement);
    await expect(supervisor.adopt(replacement, worker(accountA))).rejects.toThrow();

    await expect(supervisor.switchTo(accountB)).rejects.toThrow();
    expect(children).toHaveLength(2);
    expect((await accounts.getControlState()).activeAccountId).toBe(accountA);

    children[1]!.confirmExit();
    await Promise.resolve();
    await expect(supervisor.switchTo(accountB)).resolves.toMatchObject({ accountId: accountB });
    expect(children).toHaveLength(4);
    expect(starts.slice(-2)).toEqual([
      { accountId: accountA, mode: 'MONITOR_ONLY' },
      { accountId: accountB, mode: 'ACTIVE_CONTROL' },
    ]);
    for (const child of children) child.confirmExit();
    await gateway.shutdown();
  });
});
