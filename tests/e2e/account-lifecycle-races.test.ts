import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Pool } from 'pg';
import type { AgentEvent, AgentRunRequest, LineWorkerCommand, LineWorkerEvent, WorkerBinding } from '@line-agent/contracts';
import { createTestDatabase } from '../../packages/database/src/test-database.js';
import { createConnectedFacade, type IntegratedAgent, type IntegratedWorkerGateway } from '../../apps/desktop/src/main/connected-facade.js';
import { createUtilityWorkerGateway } from '../../apps/desktop/src/main/utility-worker-gateway.js';
import { releaseRoleSlots, seedRoleAccount } from './fixed-roles.js';

type Bound = WorkerBinding & { mode: 'ACTIVE_CONTROL' | 'MONITOR_ONLY' | 'PAUSED' };

class RaceChild {
  private message?: (value?: unknown) => void;
  private exit?: (value?: unknown) => void;
  private owner: Record<string, unknown> = {};
  holdExit = false;
  killed = false;
  constructor(readonly binding: Bound) {}
  on(event: 'message' | 'exit', listener: (value?: unknown) => void) {
    if (event === 'message') this.message = listener; else this.exit = listener;
  }
  postMessage(value: unknown) {
    const command = value as LineWorkerCommand;
    if (command.type === 'init') {
      this.owner = { transportOwnerId: command.transportOwnerId, transportGeneration: command.transportGeneration,
        writeGrantVersion: command.writeGrantVersion };
      queueMicrotask(() => {
      this.emit({ type: 'workerProtocolAck', accountId: command.accountId, workerInstanceId: command.workerInstanceId,
        controlEpoch: command.controlEpoch, protocolVersion: command.protocolVersion, manualSend: true });
      this.emit({ type: 'modeAck', accountId: command.accountId,
        workerInstanceId: command.workerInstanceId, controlEpoch: command.controlEpoch, mode: command.mode, drained: true });
      });
    }
    if (command.type === 'revokeControl') queueMicrotask(() => this.emit({ type: 'modeAck', accountId: command.accountId,
      workerInstanceId: command.workerInstanceId, controlEpoch: command.controlEpoch, mode: 'MONITOR_ONLY', drained: true }));
    // Manual UI sends are posted to the worker as manualSendText (utility-worker-gateway), agent replies as sendText.
    if (command.type === 'sendText' || command.type === 'manualSendText') queueMicrotask(() => this.emit({ type: 'sendResult', accountId: command.accountId,
      workerInstanceId: command.workerInstanceId, controlEpoch: command.controlEpoch, requestId: command.requestId,
      operationId: command.operationId, attemptId: command.attemptId,
      status: 'sent', messageId: `sent-${command.requestId}`, error: null }));
  }
  emit(event: unknown) { this.message?.({ data: { ...this.owner, ...(event as object) } }); }
  kill() { this.killed = true; if (!this.holdExit) this.exit?.(); }
  crash() { this.killed = true; this.exit?.(); }
  releaseExit() { this.holdExit = false; if (this.killed) this.exit?.(); }
}

class FakeAgent implements IntegratedAgent {
  async *run(_request: AgentRunRequest): AsyncIterable<AgentEvent> { yield { type: 'completed', finalText: 'ok' }; }
  async cancel() {}
  async getAuthStatus() { return { status: 'logged_out' as const }; }
  async openLogin() { return { ok: true }; }
  async logout() { return { ok: true }; }
  async shutdown() {}
}

async function until(predicate: () => boolean, label: string): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt++) {
    if (predicate()) return;
    await new Promise<void>((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`Timed out waiting for ${label}`);
}

async function waitForDatabaseBinding(pool: Pool, accountId: string, workerInstanceId: string): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt++) {
    const result = await pool.query('SELECT worker_instance_id FROM line_accounts WHERE account_id=$1', [accountId]);
    if (result.rows[0]?.worker_instance_id === workerInstanceId) return;
    await new Promise<void>((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`Timed out waiting for worker binding ${workerInstanceId}`);
}

async function pause(ms: number): Promise<void> { await new Promise<void>((resolve) => setTimeout(resolve, ms)); }

const database = process.env.TEST_DATABASE_URL ? describe : describe.skip;
database('account lifecycle races through production worker gateway', () => {
  let pool: Pool; let close: () => Promise<void>;
  beforeAll(async () => { ({ pool, close } = await createTestDatabase()); });
  afterAll(async () => { await close?.(); });

  // Control is fixed to the AGENT role slot (a1c2969): switchControl is rejected with CONTROL_SWITCH_DISABLED, so this race
  // now proves that a rejected switch cannot disturb a Primary Admin monitor relogin or the authoritative binding.
  it('keeps monitor relogin and the authoritative binding intact when a control switch races it', async () => {
    await releaseRoleSlots(pool);
    const accountA = `race-switch-a-${crypto.randomUUID()}`;
    const accountB = `race-switch-b-${crypto.randomUUID()}`;
    await seedRoleAccount(pool, { accountId: accountA, role: 'AGENT', mode: 'ACTIVE_CONTROL', ownMid: 'a-mid' });
    await seedRoleAccount(pool, { accountId: accountB, role: 'PRIMARY_ADMIN', ownMid: 'b-mid' });
    const children: RaceChild[] = [];
    const workers = createUtilityWorkerGateway({ spawn: (binding) => { const child = new RaceChild(binding); children.push(child); return child; },
      pollIntervalMs: 60_000, stopTimeoutMs: 2000 });
    const facade = await createConnectedFacade({ pool, workers, agent: new FakeAgent(), attachmentRoot: process.cwd() });
    try {
      const initial = await facade.controlState();
      await facade.dispatch({ type: 'lineStart', requestId: 'start-race-a', accountId: accountA });
      await facade.dispatch({ type: 'lineStart', requestId: 'start-race-b', accountId: accountB });
      const oldB = await workers.binding(accountB);
      const oldChild = children.find((child) => child.binding.workerInstanceId === oldB?.workerInstanceId)!;
      oldChild.holdExit = true;

      const relogin = facade.dispatch({ type: 'lineLoginQr', requestId: 'race-relogin-b', accountId: accountB });
      await until(() => oldChild.killed, 'old monitor worker stop');
      const switchB = facade.dispatch({ type: 'switchControl', requestId: 'race-switch-to-b', accountId: accountB,
        expectedEpoch: initial.epoch });
      await pause(25);
      oldChild.releaseExit();

      const [reloginResult, switchResult] = await Promise.all([relogin, switchB]);
      expect(reloginResult.ok, JSON.stringify(reloginResult)).toBe(true);
      expect(switchResult).toMatchObject({ ok: false, code: 'CONTROL_SWITCH_DISABLED' });
      const control = await facade.controlState();
      const binding = await workers.binding(accountB);
      await waitForDatabaseBinding(pool, accountB, binding!.workerInstanceId);
      const persisted = await pool.query<{ mode: string; worker_instance_id: string; worker_binding_epoch: string }>(
        'SELECT mode,worker_instance_id,worker_binding_epoch FROM line_accounts WHERE account_id=$1', [accountB]);
      expect(control).toMatchObject({ activeAccountId: accountA, epoch: initial.epoch });
      expect(binding).toMatchObject({ accountId: accountB, mode: 'MONITOR_ONLY', controlEpoch: control.epoch });
      expect(persisted.rows[0]).toMatchObject({ mode: 'MONITOR_ONLY', worker_instance_id: binding?.workerInstanceId,
        worker_binding_epoch: String(control.epoch) });
    } finally { await facade.shutdown(); }
  });

  it('does not let an earlier QR start failure stop a later successful same-account worker', async () => {
    await releaseRoleSlots(pool);
    const accountId = `race-qr-${crypto.randomUUID()}`;
    await seedRoleAccount(pool, { accountId, role: 'PRIMARY_ADMIN' });
    const children: RaceChild[] = [];
    const base = createUtilityWorkerGateway({ spawn: (binding) => { const child = new RaceChild(binding); children.push(child); return child; },
      pollIntervalMs: 60_000, stopTimeoutMs: 2000 });
    let holdNextStart = false;
    let releaseFirstStart!: () => void;
    let firstStartEntered!: () => void;
    const startEntered = new Promise<void>((resolve) => { firstStartEntered = resolve; });
    const startRelease = new Promise<void>((resolve) => { releaseFirstStart = resolve; });
    let firstAttempt = true;
    const workers: IntegratedWorkerGateway = {
      ...base,
      async start(id, binding) {
        const result = await base.start(id, binding);
        if (holdNextStart && firstAttempt) {
          holdNextStart = false;
          firstAttempt = false;
          firstStartEntered();
          await startRelease;
          throw new Error('delayed first QR worker startup failure');
        }
        return result;
      },
    };
    const facade = await createConnectedFacade({ pool, workers, agent: new FakeAgent(), attachmentRoot: process.cwd() });
    try {
      await facade.dispatch({ type: 'lineStart', requestId: 'start-race-qr', accountId });
      // Let the first worker finish binding before the relogin replaces it, otherwise the relogin can end early on a
      // stopping worker and never reach the gated start.
      expect(await workers.waitModeAck(accountId, 'MONITOR_ONLY', 2000)).toBe(true);
      await waitForDatabaseBinding(pool, accountId, (await workers.binding(accountId))!.workerInstanceId);
      holdNextStart = true;
      const first = facade.dispatch({ type: 'lineLoginQr', requestId: 'first-qr', accountId });
      await Promise.race([startEntered, first.then((result) => {
        throw new Error(`first QR relogin ended before its worker start: ${JSON.stringify(result)}`);
      })]);
      const second = facade.dispatch({ type: 'lineLoginQr', requestId: 'second-qr', accountId });
      await pause(75);
      releaseFirstStart();
      const [firstResult, secondResult] = await Promise.all([first, second]);
      expect(firstResult.ok).toBe(false);
      expect(secondResult.ok, JSON.stringify(secondResult)).toBe(true);
      const binding = await workers.binding(accountId);
      expect(binding?.mode).toBe('MONITOR_ONLY');
      expect(binding?.workerInstanceId).toBe(children.at(-1)?.binding.workerInstanceId);
      expect(binding?.workerInstanceId).not.toBe(children[1]?.binding.workerInstanceId);
      await waitForDatabaseBinding(pool, accountId, binding!.workerInstanceId);
      const persisted = await pool.query<{ worker_instance_id: string; mode: string }>(
        'SELECT worker_instance_id,mode FROM line_accounts WHERE account_id=$1', [accountId]);
      expect(persisted.rows[0]).toMatchObject({ worker_instance_id: binding?.workerInstanceId, mode: 'MONITOR_ONLY' });
      await workers.stopBinding(children[1]!.binding);
      expect(await workers.binding(accountId)).toMatchObject({ workerInstanceId: binding?.workerInstanceId, mode: 'MONITOR_ONLY' });
    } finally { releaseFirstStart(); await facade.shutdown(); }
  });

  it('does not let queued restart adoption overwrite a QR relogin binding', async () => {
    await releaseRoleSlots(pool);
    const accountId = `race-qr-restart-${crypto.randomUUID()}`;
    await seedRoleAccount(pool, { accountId, role: 'AGENT', mode: 'ACTIVE_CONTROL', ownMid: 'qr-restart-agent-mid' });
    const children: RaceChild[] = [];
    const base = createUtilityWorkerGateway({ spawn: (binding) => { const child = new RaceChild(binding); children.push(child); return child; },
      restartDelayMs: 0, pollIntervalMs: 60_000, stopTimeoutMs: 2000 });
    let releaseAccountRead!: () => void;
    let accountReadEntered!: () => void;
    const accountReadGate = new Promise<void>((resolve) => { releaseAccountRead = resolve; });
    const accountReadStarted = new Promise<void>((resolve) => { accountReadEntered = resolve; });
    let holdAccountRead = false;
    const gatedPool = new Proxy(pool, { get(target, key) {
      const value = Reflect.get(target, key, target);
      if (key !== 'query') return typeof value === 'function' ? value.bind(target) : value;
      return async (...args: unknown[]) => {
        const sql = typeof args[0] === 'string' ? args[0] : '';
        const params = Array.isArray(args[1]) ? args[1] as unknown[] : [];
        if (holdAccountRead && sql.startsWith('SELECT account_id, mode, own_mid, product_role FROM line_accounts WHERE account_id = $1')
          && params[0] === accountId) {
          holdAccountRead = false;
          accountReadEntered();
          await accountReadGate;
        }
        return (value as (...queryArgs: unknown[]) => Promise<unknown>).apply(target, args);
      };
    } }) as Pool;
    let restartAdoptionEntered!: () => void;
    const restartAdoptionStarted = new Promise<void>((resolve) => { restartAdoptionEntered = resolve; });
    let restartAdoptionFinished!: () => void;
    const restartAdoptionDone = new Promise<void>((resolve) => { restartAdoptionFinished = resolve; });
    const workers: IntegratedWorkerGateway = {
      ...base,
      onRestartBinding(listener) {
        base.onRestartBinding(async (binding, signal) => {
          const adoption = listener?.(binding, signal);
          restartAdoptionEntered();
          await adoption;
          restartAdoptionFinished();
        });
      },
    };
    const loginStates: Array<{ loginAttemptId?: string; state?: string }> = [];
    const facade = await createConnectedFacade({ pool: gatedPool, workers, agent: new FakeAgent(), attachmentRoot: process.cwd(),
      publish(event) { if ((event as { type?: string }).type === 'lineLoginState') loginStates.push(event as never); } });
    try {
      const started = await facade.dispatch({ type: 'lineStart', requestId: 'start-qr-restart-race', accountId });
      expect(started.ok).toBe(true);
      const initial = await workers.binding(accountId);
      const initialChild = children.find((child) => child.binding.workerInstanceId === initial?.workerInstanceId)!;

      holdAccountRead = true;
      const relogin = facade.dispatch({ type: 'lineLoginQr', requestId: 'qr-restart-relogin', accountId });
      await accountReadStarted;
      initialChild.crash();
      await restartAdoptionStarted;
      const replacementR = await workers.binding(accountId);
      expect(replacementR?.workerInstanceId).not.toBe(initial?.workerInstanceId);
      await waitForDatabaseBinding(pool, accountId, replacementR!.workerInstanceId);

      releaseAccountRead();
      const reloginResult = await relogin;
      expect(reloginResult.ok, JSON.stringify(reloginResult)).toBe(true);
      const replacementQ = await workers.binding(accountId);
      expect(replacementQ?.workerInstanceId).not.toBe(replacementR?.workerInstanceId);
      await waitForDatabaseBinding(pool, accountId, replacementQ!.workerInstanceId);

      await restartAdoptionDone;
      expect(await workers.binding(accountId)).toMatchObject({ workerInstanceId: replacementQ?.workerInstanceId, mode: 'ACTIVE_CONTROL' });
      const persisted = await pool.query<{ worker_instance_id: string; worker_binding_epoch: string }>(
        'SELECT worker_instance_id,worker_binding_epoch FROM line_accounts WHERE account_id=$1', [accountId]);
      expect(persisted.rows[0]).toMatchObject({ worker_instance_id: replacementQ?.workerInstanceId,
        worker_binding_epoch: String(replacementQ?.controlEpoch) });
      // Manual sends require the worker to have completed native login and connection readiness (isAuthenticatedReady):
      // finish the QR login on the surviving replacement, as the real worker does, before sending.
      const loginAttemptId = loginStates.findLast((item) => item.state === 'connecting')?.loginAttemptId;
      expect(loginAttemptId).toBeTruthy();
      const survivor = children.find((child) => child.binding.workerInstanceId === replacementQ!.workerInstanceId)!;
      const { mode: _survivorMode, ...survivorLease } = replacementQ!;
      survivor.emit({ type: 'login', ...survivorLease, loginAttemptId: loginAttemptId!, displayName: 'Agent', ownMid: 'qr-restart-agent-mid' } satisfies LineWorkerEvent);
      // Readiness is only granted to an already authenticated worker, so the status must follow the completed login write.
      await until(() => loginStates.some((item) => item.state === 'connected' && item.loginAttemptId === loginAttemptId), 'QR login to be applied');
      survivor.emit({ type: 'status', ...survivorLease, state: 'ready', message: null } satisfies LineWorkerEvent);
      let sent: Awaited<ReturnType<typeof facade.dispatch>> | undefined;
      for (let attempt = 0; attempt < 100; attempt++) {
        sent = await facade.dispatch({ type: 'sendText', requestId: `qr-restart-send-${attempt}`, accountId,
          chatType: 'direct', chatId: 'chat', text: 'still active after QR relogin' });
        if (sent.ok) break;
        await pause(20);
      }
      expect(sent?.ok, JSON.stringify(sent)).toBe(true);
    } finally {
      releaseAccountRead();
      await facade.shutdown();
    }
  });

  it.each(['login', 'status'] as const)('rejects a stale %s write after its worker is replaced during the database pause', async (eventType) => {
    await releaseRoleSlots(pool);
    const accountId = `race-event-${crypto.randomUUID()}`;
    // AGENT role: a Primary Admin login would also be rejected for lacking an admin link, hiding the stale-binding check.
    await seedRoleAccount(pool, { accountId, role: 'AGENT', displayName: 'Original name', status: 'disconnected' });
    const children: RaceChild[] = [];
    const workers = createUtilityWorkerGateway({ spawn: (binding) => { const child = new RaceChild(binding); children.push(child); return child; },
      pollIntervalMs: 60_000, stopTimeoutMs: 2000 });
    let releaseWrite!: () => void;
    let writeEntered!: () => void;
    const writeGate = new Promise<void>((resolve) => { releaseWrite = resolve; });
    const writeStarted = new Promise<void>((resolve) => { writeEntered = resolve; });
    // applyWorkerLogin runs on a transaction client. An Agent login locks account_control first, and a replacement's
    // bindWorker needs account_control FOR SHARE, so pausing after any lock is taken would block the replacement (by
    // design). Pause at the lock-free preRole read (no FOR UPDATE); the status write is paused at its single pool UPDATE.
    const pauseWrite = async (sql: string) => {
      const isLoginWrite = eventType === 'login' && sql.includes('SELECT product_role FROM line_accounts WHERE account_id=$1')
        && !sql.includes('FOR UPDATE');
      const isStatusWrite = eventType === 'status' && /UPDATE line_accounts SET status=/.test(sql);
      if (isLoginWrite || isStatusWrite) { writeEntered(); await writeGate; }
    };
    const gatedQuery = <T extends object>(target: T, query: (...queryArgs: unknown[]) => Promise<unknown>) =>
      async (...args: unknown[]) => { await pauseWrite(typeof args[0] === 'string' ? args[0] : ''); return query.apply(target, args); };
    const gatedPool = new Proxy(pool, { get(target, key) {
      const value = Reflect.get(target, key, target);
      if (key === 'connect') return async () => {
        const client = await (value as () => Promise<object>).call(target);
        return new Proxy(client, { get(clientTarget, clientKey) {
          const clientValue = Reflect.get(clientTarget, clientKey, clientTarget);
          if (clientKey === 'query') return gatedQuery(clientTarget, clientValue as (...queryArgs: unknown[]) => Promise<unknown>);
          return typeof clientValue === 'function' ? clientValue.bind(clientTarget) : clientValue;
        } });
      };
      if (key === 'query') return gatedQuery(target, value as (...queryArgs: unknown[]) => Promise<unknown>);
      return typeof value === 'function' ? value.bind(target) : value;
    } }) as Pool;
    const published: unknown[] = [];
    const facade = await createConnectedFacade({ pool: gatedPool, workers, agent: new FakeAgent(), attachmentRoot: process.cwd(),
      publish(event) { published.push(event); } });
    try {
      await facade.dispatch({ type: 'lineStart', requestId: 'start-race-event', accountId });
      let attemptId: string | undefined;
      if (eventType === 'login') {
        const start = await facade.dispatch({ type: 'lineLoginQr', requestId: 'login-race-event', accountId });
        expect(start.ok, JSON.stringify(start)).toBe(true);
        attemptId = (published.find((event) => (event as { type?: string }).type === 'lineLoginState'
          && (event as { state?: string }).state === 'connecting') as { loginAttemptId?: string } | undefined)?.loginAttemptId;
      }
      const binding = await workers.binding(accountId);
      const oldChild = children.find((child) => child.binding.workerInstanceId === binding?.workerInstanceId)!;
      const { mode: _mode, ...lease } = binding!;
      if (eventType === 'login') oldChild.emit({ type: 'login', ...lease, loginAttemptId: attemptId!,
        displayName: 'Stale name', ownMid: 'stale-mid' } satisfies LineWorkerEvent);
      else oldChild.emit({ type: 'status', ...lease, state: 'ready', message: null } satisfies LineWorkerEvent);
      await writeStarted;
      await facade.dispatch({ type: 'lineStart', requestId: 'replace-during-login-sql', accountId });
      const replacement = await workers.binding(accountId);
      expect(replacement?.workerInstanceId).not.toBe(binding?.workerInstanceId);
      await waitForDatabaseBinding(pool, accountId, replacement!.workerInstanceId);
      releaseWrite();
      await pause(10);
      const stored = await pool.query<{ own_mid: string | null; display_name: string; status: string; worker_instance_id: string }>(
        'SELECT own_mid,display_name,status,worker_instance_id FROM line_accounts WHERE account_id=$1', [accountId]);
      expect(stored.rows[0]).toMatchObject({ own_mid: null, display_name: 'Original name', status: 'disconnected',
        worker_instance_id: replacement?.workerInstanceId });
    } finally { releaseWrite(); await facade.shutdown(); }
  });

  it('treats a zero-row worker status update as stale: nothing persisted and the stale worker is dropped', async () => {
    await releaseRoleSlots(pool);
    const accountId = `race-zero-row-${crypto.randomUUID()}`;
    await seedRoleAccount(pool, { accountId, role: 'PRIMARY_ADMIN', displayName: 'Original name', status: 'disconnected' });
    const children: RaceChild[] = [];
    const workers = createUtilityWorkerGateway({ spawn: (binding) => { const child = new RaceChild(binding); children.push(child); return child; },
      pollIntervalMs: 60_000, stopTimeoutMs: 2000 });
    const published: unknown[] = [];
    const facade = await createConnectedFacade({ pool, workers, agent: new FakeAgent(), attachmentRoot: process.cwd(),
      publish(event) { published.push(event); } });
    try {
      await facade.dispatch({ type: 'lineStart', requestId: 'start-zero-row', accountId });
      expect(await workers.waitModeAck(accountId, 'MONITOR_ONLY', 1000)).toBe(true);
      const binding = await workers.binding(accountId);
      const child = children.find((candidate) => candidate.binding.workerInstanceId === binding?.workerInstanceId)!;
      await waitForDatabaseBinding(pool, accountId, binding!.workerInstanceId);
      expect((await pool.query('SELECT status FROM line_accounts WHERE account_id=$1', [accountId])).rows[0]?.status).toBe('disconnected');
      await pool.query('UPDATE line_accounts SET worker_instance_id=$2,worker_binding_epoch=$3 WHERE account_id=$1',
        [accountId, `external-${crypto.randomUUID()}`, binding!.controlEpoch]);
      child.emit({ type: 'status', accountId, workerInstanceId: binding!.workerInstanceId, controlEpoch: binding!.controlEpoch,
        state: 'ready', message: null } satisfies LineWorkerEvent);
      await pause(50);
      expect((await pool.query('SELECT status FROM line_accounts WHERE account_id=$1', [accountId])).rows[0]?.status).toBe('disconnected');
      // This records CURRENT product behavior, not intended design (line-service.ts enqueueComposedConnectionStatus /
      // the status case of handleWorkerEvent). Since 70e72b6 the connection status is persisted by a coalesced
      // background lane, so the first event from the stale worker is still projected to the UI (one lineLoginState
      // publish) before its zero-row result is known. What is guaranteed today: nothing is persisted, and the zero-row
      // update drops the binding so nothing the stale worker reports afterwards is published. If the product later
      // suppresses that first publish too, tighten this test.
      const loginStateCount = () => published.filter((event) => (event as { type?: string; accountId?: string }).type === 'lineLoginState'
        && (event as { accountId?: string }).accountId === accountId).length;
      const afterFirstEvent = loginStateCount();
      child.emit({ type: 'status', accountId, workerInstanceId: binding!.workerInstanceId, controlEpoch: binding!.controlEpoch,
        state: 'degraded', message: 'stale worker still talking' } satisfies LineWorkerEvent);
      await pause(50);
      expect(loginStateCount()).toBe(afterFirstEvent);
      expect((await pool.query('SELECT status FROM line_accounts WHERE account_id=$1', [accountId])).rows[0]?.status).toBe('disconnected');
    } finally { await facade.shutdown(); }
  });
});
