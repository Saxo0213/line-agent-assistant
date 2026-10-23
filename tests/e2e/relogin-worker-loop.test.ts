import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Pool } from 'pg';
import type { AgentEvent, AgentRunRequest, InboundEnvelope, LineWorkerCommand, LineWorkerEvent, WorkerBinding } from '@line-agent/contracts';
import { WORKER_PROTOCOL_VERSION } from '@line-agent/contracts';
import { createTestDatabase } from '../../packages/database/src/test-database.js';
import { AccountRepository, MessageRepository, SettingsRepository } from '../../packages/database/src/index.js';
import { FakeLineTransport } from '../../packages/line-worker/src/fake-transport.js';
import { LineWorkerLoop } from '../../packages/line-worker/src/worker-loop.js';
import { createConnectedFacade, type IntegratedWorkerGateway } from '../../apps/desktop/src/main/connected-facade.js';
import { SecretStore } from '../../apps/desktop/src/main/services/secret-store.js';
import { createUtilityWorkerGateway } from '../../apps/desktop/src/main/utility-worker-gateway.js';
import { assignRoleSlot, releaseRoleSlots, seedRoleAccount } from './fixed-roles.js';

type Bound = WorkerBinding & { mode: 'ACTIVE_CONTROL' | 'MONITOR_ONLY' | 'PAUSED' };

// Attachment downloads validate the native LINE message identity, so MIDs must have the real u + 32 hex shape.
const SELF_MID = `u${'a'.repeat(32)}`;
const PEER_MID = `u${'b'.repeat(32)}`;
const HISTORY_PEER_MID = `u${'c'.repeat(32)}`;

class UtilityLoopChild {
  private message?: (value?: unknown) => void;
  private exit?: (value?: unknown) => void;
  private resolveReady!: () => void;
  readonly ready: Promise<void>;
  private pending: Promise<void> = Promise.resolve();
  private exited = false;
  readonly transport: FakeLineTransport;
  readonly loop: LineWorkerLoop;

  constructor(readonly binding: Bound, options: { attachmentRoot: string; dropMonitorAck?: boolean; displayName: string; modeAckGate?: Promise<void> }) {
    this.ready = new Promise<void>((resolve) => { this.resolveReady = resolve; });
    this.transport = new FakeLineTransport({ ownMid: SELF_MID, displayName: options.displayName });
    this.loop = new LineWorkerLoop({ transport: this.transport, attachmentRoot: options.attachmentRoot,
      attachmentRuntime: { unsafeAllowPortableFilesystemOnWindowsForTests: true },
      validateLease: () => true, emit: async (event) => {
      if (options.dropMonitorAck && event.type === 'modeAck' && event.mode === 'MONITOR_ONLY') return;
      if (event.type === 'modeAck' && options.modeAckGate) await options.modeAckGate;
      await this.message?.(event);
      if (event.type === 'status' && event.state === 'ready') this.resolveReady();
    } });
  }

  on(event: 'message' | 'exit', listener: (value?: unknown) => void): void {
    if (event === 'message') this.message = listener;
    else this.exit = listener;
  }
  postMessage(value: unknown): void {
    this.pending = this.pending.then(async () => await this.loop.handle(value));
  }
  emitLate(value: unknown): void { this.message?.(value); }
  async flush(): Promise<void> {
    while (true) {
      const current = this.pending;
      await current;
      if (current === this.pending) return;
    }
  }
  kill(): void {
    if (this.exited) return;
    this.exited = true;
    this.exit?.();
  }
}

async function waitForValue<T>(read: () => Promise<T>, predicate: (value: T) => boolean): Promise<T> {
  for (let attempt = 0; attempt < 100; attempt++) {
    const value = await read();
    if (predicate(value)) return value;
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('Timed out waiting for the expected database state');
}

class LoopWorkers implements IntegratedWorkerGateway {
  readonly transports: FakeLineTransport[] = [];
  readonly stoppedInstances: string[] = [];
  readonly downloadCalls: Array<Extract<LineWorkerCommand, { type: 'downloadAttachment' }>> = [];
  readonly bindings = new Map<string, Bound>();
  failStop = false;
  failNextQr = false;
  failNextQrCleanupStop = false;
  private readonly stopping = new Set<string>();
  private readonly loops = new Map<string, LineWorkerLoop>();
  private listener?: (workerInstanceId: string, event: LineWorkerEvent) => Promise<void>;
  private bindingListener?: (binding: Bound, signal: AbortSignal) => Promise<void> | void;
  private modeListener?: (binding: Bound, signal: AbortSignal) => Promise<void> | void;
  onEvent(listener: (workerInstanceId: string, event: LineWorkerEvent) => Promise<void>): void { this.listener = listener; }
  onBinding(listener: (binding: Bound, signal: AbortSignal) => Promise<void> | void): void { this.bindingListener = listener; }
  onModeChange(listener: (binding: Bound, signal: AbortSignal) => Promise<void> | void): void { this.modeListener = listener; }
  async start(accountId: string, binding: Bound) {
    const transport = new FakeLineTransport({ ownMid: 'saved-mid', displayName: `LINE ${this.transports.length}` });
    if (this.failNextQr || this.failNextQrCleanupStop) {
      const failCleanup = this.failNextQrCleanupStop;
      this.failNextQr = false;
      this.failNextQrCleanupStop = false;
      transport.loginQr = async () => {
        if (failCleanup) this.failStop = true;
        throw new Error('QR transport failed');
      };
    }
    this.transports.push(transport); this.bindings.set(accountId, binding);
    const loop = new LineWorkerLoop({ transport, validateLease: () => true, emit: async (event) => {
      if (event.type === 'modeAck') {
        const next = { ...binding, mode: event.mode }; this.bindings.set(accountId, next); await this.modeListener?.(next, new AbortController().signal);
      }
      await this.listener?.(binding.workerInstanceId, event);
    } });
    this.loops.set(accountId, loop);
    await loop.handle({ type: 'init', ...binding, protocolVersion: WORKER_PROTOCOL_VERSION, durableCursor: { version: 1, revision: '0', globalRev: '0', individualRev: '0' } });
    await this.bindingListener?.(binding, new AbortController().signal);
    return binding;
  }
  async binding(accountId: string) { return this.bindings.get(accountId) ?? null; }
  async send(command: LineWorkerCommand): Promise<Extract<LineWorkerEvent, { type: 'sendResult' }>> {
    if (this.stopping.has(command.accountId)) throw new Error('Worker is stopping');
    const loop = this.loops.get(command.accountId); if (!loop) throw new Error('Worker unavailable');
    await loop.handle(command);
    return { type: 'sendResult', accountId: command.accountId, workerInstanceId: command.workerInstanceId,
      controlEpoch: command.controlEpoch, requestId: 'requestId' in command ? command.requestId : 'control',
      status: 'sent', messageId: null, error: null };
  }
  async download(command: Extract<LineWorkerCommand, { type: 'downloadAttachment' }>) {
    this.downloadCalls.push(command);
    return { type: 'attachmentResult' as const, accountId: command.accountId, chatType: command.chatType,
      chatId: command.chatId, workerInstanceId: command.workerInstanceId, attachmentId: command.attachmentId,
      attemptToken: command.attemptToken,
      status: 'ready' as const, relativePath: `${command.accountId}/${command.attachmentId}.bin`,
      sha256: 'a'.repeat(64), sizeBytes: 1, name: command.originalFileName };
  }
  async waitModeAck(accountId: string, mode: 'ACTIVE_CONTROL' | 'MONITOR_ONLY') { return this.bindings.get(accountId)?.mode === mode; }
  async stop(accountId: string) {
    const binding = this.bindings.get(accountId); if (binding) this.stoppedInstances.push(binding.workerInstanceId);
    if (this.failStop) { this.stopping.add(accountId); throw new Error('Worker did not confirm exit'); }
    this.bindings.delete(accountId); this.loops.delete(accountId);
    this.stopping.delete(accountId);
  }
  async stopBinding(binding: WorkerBinding) {
    if (this.bindings.get(binding.accountId)?.workerInstanceId === binding.workerInstanceId) await this.stop(binding.accountId);
  }
  async rotateLatestToken(token: string) { const transport = this.transports.at(-1)!; transport.rotateToken(token); await this.loops.values().next().value?.flushEvents(); }
  async shutdown() { this.bindings.clear(); this.loops.clear(); }
}

class FakeAgent {
  async *run(_request: AgentRunRequest): AsyncIterable<AgentEvent> { yield { type: 'completed', finalText: 'done' }; }
  async cancel() {}
  async getAuthStatus() { return { status: 'subscription' as const }; }
  async openLogin() { return { ok: true }; }
  async logout() { return { ok: true }; }
  async shutdown() {}
}

describe('fresh worker relogin composition', () => {
  let pool: Pool; let close: () => Promise<void>;
  beforeAll(async () => { ({ pool, close } = await createTestDatabase()); });
  afterAll(async () => { await close?.(); });

  it('automatically restores a saved authenticated account and token worker on application startup', async () => {
    await releaseRoleSlots(pool);
    const accountId = `startup-${crypto.randomUUID()}`;
    await seedRoleAccount(pool, { accountId, role: 'AGENT', mode: 'ACTIVE_CONTROL', ownMid: 'saved-mid', displayName: 'Saved LINE', status: 'connected', autoLogin: true });
    const secretRoot = await mkdtemp(join(tmpdir(), 'line-startup-secret-'));
    const secretStore = new SecretStore(secretRoot, { protect: async (value) => value, unprotect: async (value) => value });
    secretStore.beginLogin(accountId, 'seed-worker', 'seed-attempt');
    await secretStore.saveRotation(accountId, 'seed-worker', 'seed-attempt', {
      token: 'persisted-token', qrCert: null, e2eeStorage: null,
    });
    const workers = new LoopWorkers();

    const facade = await createConnectedFacade({ pool, workers, agent: new FakeAgent(), attachmentRoot: process.cwd(), secretStore });
    try {
      expect(workers.transports).toHaveLength(1);
      expect(workers.transports[0]?.loginCalls).toEqual(['token']);
      expect(await workers.binding(accountId)).toMatchObject({ accountId, mode: 'ACTIVE_CONTROL' });
      expect((await pool.query('SELECT status FROM line_accounts WHERE account_id=$1', [accountId])).rows[0]?.status).toBe('connected');
    } finally {
      await facade.shutdown();
      await rm(secretRoot, { recursive: true, force: true });
    }
  });

  it('delivers a pending LINE reply once an explicit lineStart restores the account worker', async () => {
    await releaseRoleSlots(pool);
    const accountId = `startup-delivery-${crypto.randomUUID()}`;
    const accounts = new AccountRepository(pool);
    await accounts.ensureAccount(accountId);
    await assignRoleSlot(pool, accountId, 'AGENT', true);
    await accounts.setOwnMid(accountId, 'saved-mid');
    await accounts.setConnectionStatus(accountId, 'connected');
    const before = await accounts.getControlState();
    const control = await accounts.activateControl(accountId, before.controlEpoch);
    const chatId = `chat-${crypto.randomUUID()}`;
    // LINE message ids are decimal strings; the Agent reaction command (reactMessage) validates that.
    const messageId = `${Date.now()}${Math.floor(Math.random() * 1_000_000)}`;
    const envelope: InboundEnvelope = { eventId: messageId, accountId, chatType: 'direct', chatId, senderId: 'peer', messageId,
      kind: 'text', text: 'work', mentionIds: [], mentionRanges: [], replyToMessageId: null,
      ingestion: { source: 'live', cursor: null }, occurredAt: new Date().toISOString(), attachments: [], raw: {} };
    const messages = new MessageRepository(pool);
    const input = await messages.ingestAndRoute(envelope, { eligible: true, provider: 'codex', prompt: 'work', workspacePath: process.cwd() });
    expect(input.jobId).toBeDefined();
    const secretRoot = await mkdtemp(join(tmpdir(), 'line-startup-delivery-secret-'));
    const secretStore = new SecretStore(secretRoot, { protect: async (value) => value, unprotect: async (value) => value });
    secretStore.beginLogin(accountId, 'seed-worker', 'seed-attempt');
    await secretStore.saveRotation(accountId, 'seed-worker', 'seed-attempt', { token: 'persisted-token', qrCert: null, e2eeStorage: null });
    const workers = new LoopWorkers();
    const realSend = workers.send.bind(workers);
    workers.send = async (command) => {
      const result = await realSend(command);
      return command.type === 'sendText' ? { ...result, messageId: 'outbound-message' } : result;
    };
    // Startup now reclaims queued jobs only after the account restore loop and the MCP listener (7fb860c), so a job can
    // no longer finish while a startup restore is still in flight. The remaining race is a job that completes while
    // its account has no worker (startup auto-login is off): the delivery stays pending, then a later worker binding
    // must retry it.
    await pool.query('UPDATE line_accounts SET auto_login_on_startup=false WHERE account_id=$1', [accountId]);
    // Agent jobs run in per-chat folders under the configured workspace root (995e25a); point it at a private directory.
    const workspaceRoot = await mkdtemp(join(tmpdir(), 'line-startup-delivery-workspace-'));
    await new SettingsRepository(pool).setAppSetting('workspace_path', workspaceRoot);
    const facade = await createConnectedFacade({ pool, workers, agent: new FakeAgent(), attachmentRoot: process.cwd(), secretStore });
    try {
      await waitForValue(async () => await pool.query('SELECT status FROM agent_jobs WHERE job_id=$1', [input.jobId]),
        (result) => result.rows[0]?.status === 'completed');
      await waitForValue(async () => await pool.query('SELECT status FROM agent_deliveries WHERE job_id=$1', [input.jobId]),
        (result) => result.rows[0]?.status === 'pending');
      expect(workers.transports).toHaveLength(0);
      expect(await facade.dispatch({ type: 'lineStart', requestId: 'start-after-pending-delivery', accountId })).toMatchObject({ ok: true });
      const delivery = await waitForValue(async () => await pool.query('SELECT status FROM agent_deliveries WHERE job_id=$1', [input.jobId]),
        (result) => result.rows[0]?.status === 'sent');
      expect(delivery.rows[0]?.status).toBe('sent');
    } finally {
      await facade.shutdown();
      await rm(secretRoot, { recursive: true, force: true });
      await rm(workspaceRoot, { recursive: true, force: true });
    }
    expect(control.activated).toBe(true);
  });

  it('keeps startup recovery pending until the utility gateway acknowledges ACTIVE_CONTROL', async () => {
    await releaseRoleSlots(pool);
    const accountId = `startup-delivery-ack-${crypto.randomUUID()}`;
    const accounts = new AccountRepository(pool);
    await accounts.ensureAccount(accountId);
    await assignRoleSlot(pool, accountId, 'AGENT', true);
    // The utility child's fake transport logs in as SELF_MID; a login whose MID differs from the stored one is rejected.
    await accounts.setOwnMid(accountId, SELF_MID);
    await accounts.setConnectionStatus(accountId, 'connected');
    const before = await accounts.getControlState();
    const control = await accounts.activateControl(accountId, before.controlEpoch);
    const chatId = `chat-${crypto.randomUUID()}`;
    // LINE message ids are decimal strings; the Agent reaction command (reactMessage) validates that.
    const messageId = `${Date.now()}${Math.floor(Math.random() * 1_000_000)}`;
    const envelope: InboundEnvelope = { eventId: messageId, accountId, chatType: 'direct', chatId, senderId: 'peer', messageId,
      kind: 'text', text: 'work', mentionIds: [], mentionRanges: [], replyToMessageId: null,
      ingestion: { source: 'live', cursor: null }, occurredAt: new Date().toISOString(), attachments: [], raw: {} };
    const input = await new MessageRepository(pool).ingestAndRoute(envelope,
      { eligible: true, provider: 'codex', prompt: 'work', workspacePath: process.cwd() });
    expect(input.jobId).toBeDefined();
    const secretRoot = await mkdtemp(join(tmpdir(), 'line-startup-delivery-ack-secret-'));
    const attachmentRoot = await mkdtemp(join(tmpdir(), 'line-startup-delivery-ack-files-'));
    const secretStore = new SecretStore(secretRoot, { protect: async (value) => value, unprotect: async (value) => value });
    secretStore.beginLogin(accountId, 'seed-worker', 'seed-attempt');
    await secretStore.saveRotation(accountId, 'seed-worker', 'seed-attempt', { token: 'persisted-token', qrCert: null, e2eeStorage: null });
    let releaseAck!: () => void;
    const ackGate = new Promise<void>((resolve) => { releaseAck = resolve; });
    const children: UtilityLoopChild[] = [];
    const workers = createUtilityWorkerGateway({
      spawn: (binding) => {
        const child = new UtilityLoopChild(binding, { attachmentRoot, modeAckGate: ackGate, displayName: 'delayed-ack' });
        children.push(child);
        return child;
      },
      pollIntervalMs: 60_000,
      // lifecycleTimeoutMs defaults to stopTimeoutMs; the gated ack must not be cut off by a 100 ms lifecycle deadline.
      stopTimeoutMs: 100, lifecycleTimeoutMs: 30_000,
    });
    // Agent jobs run in per-chat folders under the configured workspace root (995e25a); point it at a private directory.
    const workspaceRoot = await mkdtemp(join(tmpdir(), 'line-startup-delivery-ack-workspace-'));
    await new SettingsRepository(pool).setAppSetting('workspace_path', workspaceRoot);
    const creating = createConnectedFacade({ pool, workers, agent: new FakeAgent(), attachmentRoot, secretStore });
    let facade: Awaited<typeof creating> | undefined;
    try {
      // Queued jobs are reclaimed only after the startup account restore has acknowledged ACTIVE_CONTROL (7fb860c), so
      // while the ACTIVE_CONTROL ack is withheld nothing may run, complete or be sent.
      await waitForValue(async () => children.length, (count) => count === 1);
      await waitForValue(async () => await workers.binding(accountId), (binding) => binding !== null);
      await new Promise<void>((resolve) => setTimeout(resolve, 100));
      expect(children[0]?.transport.sendCalls).toHaveLength(0);
      expect((await pool.query('SELECT status FROM agent_jobs WHERE job_id=$1', [input.jobId])).rows[0]?.status).toBe('queued');
      expect((await pool.query('SELECT count(*)::int AS count FROM agent_deliveries WHERE job_id=$1', [input.jobId])).rows[0]?.count).toBe(0);

      releaseAck();
      facade = await creating;
      const delivery = await waitForValue(async () => await pool.query('SELECT status FROM agent_deliveries WHERE job_id=$1', [input.jobId]),
        (result) => result.rows[0]?.status === 'sent');
      expect(delivery.rows[0]?.status).toBe('sent');
      expect(children[0]?.transport.sendCalls).toHaveLength(1);
    } finally {
      releaseAck();
      await facade?.shutdown();
      await creating.catch(() => undefined);
      await rm(secretRoot, { recursive: true, force: true });
      await rm(attachmentRoot, { recursive: true, force: true });
      await rm(workspaceRoot, { recursive: true, force: true });
    }
    expect(control.activated).toBe(true);
  });

  // Control is fixed to the AGENT role, so an account is never demoted to a monitor by a control switch any more. The
  // monitor path that remains is the Primary Admin account: restored at startup with its saved token, archiving through
  // polls, and fenced from late events once its worker is replaced.
  it('restores the Primary Admin as a token-authenticated monitor and fences late events from its replaced worker', async () => {
    await releaseRoleSlots(pool);
    const accountA = `monitor-recovery-${crypto.randomUUID()}`;
    // A Primary Admin worker can only bind and log in while an Agent account exists and links its MID as primary admin.
    const agentAccountId = `monitor-recovery-agent-${crypto.randomUUID()}`;
    await seedRoleAccount(pool, { accountId: agentAccountId, role: 'AGENT', ownMid: 'monitor-recovery-agent-mid' });
    await pool.query("INSERT INTO account_administrators(account_id,chat_type,chat_id,user_id,role) VALUES ($1,'direct','admin-chat',$2,'PRIMARY_ADMIN')", [agentAccountId, SELF_MID]);
    await seedRoleAccount(pool, { accountId: accountA, role: 'PRIMARY_ADMIN', ownMid: SELF_MID, displayName: 'Recovered LINE',
      status: 'connected', autoLogin: true });
    const secretRoot = await mkdtemp(join(tmpdir(), 'line-monitor-recovery-secret-'));
    const attachmentRoot = await mkdtemp(join(tmpdir(), 'line-monitor-recovery-files-'));
    const secretStore = new SecretStore(secretRoot, { protect: async (value) => value, unprotect: async (value) => value });
    secretStore.beginLogin(accountA, 'seed-worker', 'seed-attempt');
    await secretStore.saveRotation(accountA, 'seed-worker', 'seed-attempt', { token: 'saved-token', qrCert: null, e2eeStorage: null });
    const children: UtilityLoopChild[] = [];
    const workers = createUtilityWorkerGateway({
      spawn: (binding) => {
        const child = new UtilityLoopChild(binding, { attachmentRoot,
          displayName: `${binding.accountId}:${binding.mode}` });
        if (children.length === 0) {
          child.transport.enqueueConversationCatalog([{ chatType: 'direct', chatId: 'u-catalog-peer',
            title: 'Catalog Peer', members: [{ memberId: 'u-catalog-peer', displayName: 'Catalog Peer' }] }]);
          child.transport.enqueueSync({ cursorAfter: { version: 1, revision: '1', globalRev: '1', individualRev: '1' },
            operations: [{ revision: 1n, type: 26, message: { id: '1760522400002', from: PEER_MID,
              to: SELF_MID, toType: 0, contentType: 14, contentMetadata: { FILE_NAME: 'monitor.bin', FILE_SIZE: '3' },
              createdTime: 1760522400000 } }] });
          child.transport.enqueueDownload(new Uint8Array([1, 2, 3]), 'monitor.bin');
        }
        children.push(child);
        return child;
      },
      pollIntervalMs: 60_000,
      // lifecycleTimeoutMs defaults to stopTimeoutMs; binding callbacks can take longer than 50 ms on a loaded machine.
      stopTimeoutMs: 50, lifecycleTimeoutMs: 5_000,
    });
    const facade = await createConnectedFacade({ pool, workers, agent: new FakeAgent(), attachmentRoot, secretStore });
    try {
      const before = await facade.controlState();
      const oldBinding = await workers.binding(accountA);
      const oldChild = children[0]!;
      await oldChild.flush();
      expect(oldBinding).toMatchObject({ accountId: accountA, mode: 'MONITOR_ONLY', controlEpoch: before.epoch });
      expect(oldChild.transport.loginCalls).toEqual(['token']);
      expect(before.activeAccountId).toBeNull();

      const monitorChild = oldChild;
      const monitorBinding = oldBinding;
      await waitForValue(async () => await pool.query(
        'SELECT 1 FROM conversations WHERE account_id=$1 AND chat_id=$2', [accountA, 'u-catalog-peer']),
      (result) => result.rowCount === 1);
      await monitorChild.ready;

      const { mode: _mode, ...monitorLease } = (await workers.binding(accountA))!;
      await workers.send({ type: 'poll', ...monitorLease });
      await monitorChild.flush();
      // Queued attachments are retried automatically only once they are 10 s old (02b24dd). Age the archived one, then
      // let the worker report ready again, which is what triggers attachment recovery for the account.
      await waitForValue(async () => await pool.query(
        'SELECT status FROM attachments WHERE account_id=$1 AND message_id=$2', [accountA, '1760522400002']),
      (value) => value.rowCount === 1);
      await pool.query("UPDATE attachments SET created_at=now()-interval '1 minute', updated_at=now()-interval '1 minute' WHERE account_id=$1 AND message_id=$2",
        [accountA, '1760522400002']);
      monitorChild.emitLate({ type: 'status', ...monitorLease, state: 'ready', message: null });
      const result = await waitForValue(async () => await pool.query(
        'SELECT status, error FROM attachments WHERE account_id=$1 AND message_id=$2', [accountA, '1760522400002']),
      (value) => value.rows[0]?.status === 'ready' || value.rows[0]?.status === 'failed');
      expect(result.rows[0], JSON.stringify(result.rows[0])).toEqual({ status: 'ready', error: null });
      expect(monitorChild.transport.syncCalls).toHaveLength(1);
      expect((await pool.query('SELECT ingestion_source FROM messages WHERE account_id=$1 AND message_id=$2',
        [accountA, '1760522400002'])).rows[0]?.ingestion_source).toBe('live');
      expect(monitorChild.transport.downloadCalls).toHaveLength(1);

      monitorChild.transport.enqueueHistory([{ id: '1001', from: HISTORY_PEER_MID, to: SELF_MID, toType: 0,
        contentType: 'NONE', text: 'archived history', createdTime: 1760522401000 }]);
      await facade.dispatch({ type: 'lineSyncHistory', requestId: 'monitor-history', accountId: accountA,
        chatType: 'direct', chatId: HISTORY_PEER_MID, cursor: null, limit: 10 });
      await monitorChild.flush();
      expect(monitorChild.transport.historyCalls).toHaveLength(1);
      await waitForValue(async () => await pool.query('SELECT ingestion_source FROM messages WHERE account_id=$1 AND message_id=$2',
        [accountA, '1001']), (result) => result.rows[0]?.ingestion_source === 'history');

      // Replace the worker with an explicit restart; whatever the superseded worker still reports must be fenced.
      expect(await facade.dispatch({ type: 'lineStart', requestId: 'replace-monitor', accountId: accountA })).toMatchObject({ ok: true });
      expect(children).toHaveLength(2);
      expect((await workers.binding(accountA))?.workerInstanceId).not.toBe(oldBinding?.workerInstanceId);
      oldChild.emitLate({ type: 'batch', ...oldBinding!, batchId: 'late-old-batch',
        cursorBefore: { version: 1, revision: '0', globalRev: '0', individualRev: '0' },
        cursorAfter: { version: 1, revision: '99', globalRev: '99', individualRev: '99' },
        envelopes: [{ accountId: accountA, eventId: 'late-old-event', messageId: 'late-old-message',
          chatType: 'direct', chatId: 'u-late-peer', senderId: 'u-late-peer', kind: 'text', text: 'stale',
          mentionIds: [], mentionRanges: [], replyToMessageId: null, ingestion: { source: 'live', cursor: null },
          occurredAt: new Date(1760522402000).toISOString(), attachments: [], raw: {} }] });
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
      expect((await pool.query('SELECT count(*)::int AS count FROM messages WHERE account_id=$1 AND message_id=$2',
        [accountA, 'late-old-message'])).rows[0]?.count).toBe(0);
    } finally {
      await facade.shutdown();
      await rm(secretRoot, { recursive: true, force: true });
      await rm(attachmentRoot, { recursive: true, force: true });
    }
  });

  it('recovers queued attachments only after the persisted account worker is restored', async () => {
    await releaseRoleSlots(pool);
    const accountId = `attachment-startup-${crypto.randomUUID()}`;
    const chatId = `chat-${crypto.randomUUID()}`;
    // LINE message ids are decimal strings; the Agent reaction command (reactMessage) validates that.
    const messageId = `${Date.now()}${Math.floor(Math.random() * 1_000_000)}`;
    const attachmentId = crypto.randomUUID();
    await seedRoleAccount(pool, { accountId, role: 'AGENT', mode: 'ACTIVE_CONTROL', ownMid: 'saved-mid', displayName: 'Saved LINE', status: 'connected', autoLogin: true });
    await pool.query("INSERT INTO conversations(account_id,chat_type,chat_id,title) VALUES ($1,'direct',$2,'Peer')", [accountId, chatId]);
    await pool.query("INSERT INTO messages(account_id,message_id,event_id,chat_type,chat_id,sender_id,kind,ingestion_source,occurred_at,raw) VALUES ($1,$2,$2,'direct',$3,'peer-mid','file','live',now(),'{}')", [accountId, messageId, chatId]);
    // Queued attachments are only retried automatically once they are 10 s old (attachment retry queue, 02b24dd).
    await pool.query("INSERT INTO attachments(attachment_id,external_attachment_id,account_id,chat_type,chat_id,message_id,kind,name,status,created_at,updated_at) VALUES ($1,'external-file',$2,'direct',$3,$4,'file','resume.bin','queued',now()-interval '1 minute',now()-interval '1 minute')", [attachmentId, accountId, chatId, messageId]);
    const secretRoot = await mkdtemp(join(tmpdir(), 'line-attachment-recovery-secret-'));
    const secretStore = new SecretStore(secretRoot, { protect: async (value) => value, unprotect: async (value) => value });
    secretStore.beginLogin(accountId, 'seed-worker', 'seed-attempt');
    await secretStore.saveRotation(accountId, 'seed-worker', 'seed-attempt', { token: 'persisted-token', qrCert: null, e2eeStorage: null });
    const workers = new LoopWorkers();

    const facade = await createConnectedFacade({ pool, workers, agent: new FakeAgent(), attachmentRoot: process.cwd(), secretStore });
    try {
      await vi.waitFor(() => expect(workers.downloadCalls).toHaveLength(1));
      expect(workers.downloadCalls).toHaveLength(1);
      expect(workers.downloadCalls[0]).toMatchObject({ accountId, chatId, messageId, attachmentId });
      const recovered = await waitForValue(async () => await pool.query('SELECT status FROM attachments WHERE attachment_id=$1', [attachmentId]),
        (result) => result.rows[0]?.status === 'ready' || result.rows[0]?.status === 'failed');
      expect(recovered.rows[0]?.status).toBe('ready');
    } finally {
      await facade.shutdown();
      await rm(secretRoot, { recursive: true, force: true });
    }
  });

  it('recovers queued attachments when an existing account completes QR relogin', async () => {
    await releaseRoleSlots(pool);
    const accountId = `attachment-qr-${crypto.randomUUID()}`;
    const chatId = `chat-${crypto.randomUUID()}`;
    // LINE message ids are decimal strings; the Agent reaction command (reactMessage) validates that.
    const messageId = `${Date.now()}${Math.floor(Math.random() * 1_000_000)}`;
    const attachmentId = crypto.randomUUID();
    await seedRoleAccount(pool, { accountId, role: 'AGENT', mode: 'ACTIVE_CONTROL', ownMid: 'saved-mid', displayName: 'Relogin LINE', status: 'disconnected' });
    await pool.query("INSERT INTO conversations(account_id,chat_type,chat_id,title) VALUES ($1,'direct',$2,'Peer')", [accountId, chatId]);
    await pool.query("INSERT INTO messages(account_id,message_id,event_id,chat_type,chat_id,sender_id,kind,ingestion_source,occurred_at,raw) VALUES ($1,$2,$2,'direct',$3,'peer-mid','file','live',now(),'{}')", [accountId, messageId, chatId]);
    await pool.query("INSERT INTO attachments(attachment_id,external_attachment_id,account_id,chat_type,chat_id,message_id,kind,name,status,created_at,updated_at) VALUES ($1,'external-file',$2,'direct',$3,$4,'file','resume-after-qr.bin','queued',now()-interval '1 minute',now()-interval '1 minute')", [attachmentId, accountId, chatId, messageId]);
    const workers = new LoopWorkers();
    const facade = await createConnectedFacade({ pool, workers, agent: new FakeAgent(), attachmentRoot: process.cwd() });
    try {
      expect(workers.downloadCalls).toHaveLength(0);
      expect(await facade.dispatch({ type: 'lineStart', requestId: 'start-for-qr', accountId })).toMatchObject({ ok: true });
      expect(workers.downloadCalls).toHaveLength(0);
      expect(await facade.dispatch({ type: 'lineLoginQr', requestId: 'complete-qr', accountId })).toMatchObject({ ok: true });
      await vi.waitFor(() => expect(workers.downloadCalls).toHaveLength(1));
      expect(workers.downloadCalls).toHaveLength(1);
      expect(workers.downloadCalls[0]).toMatchObject({ accountId, attachmentId });
    } finally { await facade.shutdown(); }
  });

  // The first reserved account is the fixed AGENT, which owns control from its first QR login (a1c2969).
  it('replaces the Agent worker for a second QR attempt keeping control and its epoch', async () => {
    await pool.query('DELETE FROM line_accounts');
    const workers = new LoopWorkers();
    const facade = await createConnectedFacade({ pool, workers, agent: new FakeAgent(), attachmentRoot: process.cwd() });
    try {
      expect(await facade.dispatch({ type: 'lineAddAccountQr', requestId: 'first' })).toMatchObject({ ok: true });
      const accountId = [...workers.bindings.keys()][0]!;
      const first = await workers.binding(accountId);
      expect(first).toMatchObject({ accountId, mode: 'ACTIVE_CONTROL' });
      expect(workers.transports[0]?.loginCalls).toEqual(['qr']);
      const before = await facade.controlState();
      expect(before.activeAccountId).toBe(accountId);
      const secondAttempt = await facade.dispatch({ type: 'lineLoginQr', requestId: 'again', accountId });
      expect(secondAttempt, JSON.stringify(secondAttempt)).toMatchObject({ ok: true });
      const second = await workers.binding(accountId);
      expect(second).toMatchObject({ accountId, mode: 'ACTIVE_CONTROL', controlEpoch: first?.controlEpoch });
      expect(second?.workerInstanceId).not.toBe(first?.workerInstanceId);
      expect(workers.stoppedInstances).toEqual([first?.workerInstanceId]);
      expect(workers.transports).toHaveLength(2);
      expect(workers.transports.map((transport) => transport.loginCalls)).toEqual([['qr'], ['qr']]);
      expect(await facade.controlState()).toMatchObject({ activeAccountId: accountId, epoch: before.epoch });
    } finally { await facade.shutdown(); }
  });

  it('keeps persisted token restore on Agent startup and uses a fresh QR worker', async () => {
    await pool.query('DELETE FROM line_accounts');
    const secretRoot = await mkdtemp(join(tmpdir(), 'line-relogin-secret-'));
    const secretStore = new SecretStore(secretRoot, { protect: async (value) => value, unprotect: async (value) => value });
    const firstWorkers = new LoopWorkers();
    const firstFacade = await createConnectedFacade({ pool, workers: firstWorkers, agent: new FakeAgent(), attachmentRoot: process.cwd(), secretStore });
    let accountId = '';
    try {
      expect(await firstFacade.dispatch({ type: 'lineAddAccountQr', requestId: 'seed' })).toMatchObject({ ok: true });
      accountId = [...firstWorkers.bindings.keys()][0]!;
      await firstWorkers.rotateLatestToken('persisted-token');
      expect((await secretStore.load(accountId))?.token).toBe('persisted-token');
      // Startup only restores accounts that opted in to automatic login (v1.0.62).
      await pool.query("UPDATE line_accounts SET own_mid='saved-mid', auto_login_on_startup=true WHERE account_id=$1", [accountId]);
    } finally { await firstFacade.shutdown(); }

    const workers = new LoopWorkers();
    const facade = await createConnectedFacade({ pool, workers, agent: new FakeAgent(), attachmentRoot: process.cwd(), secretStore });
    try {
      expect(workers.transports[0]?.loginCalls).toEqual(['token']);
      const binding = await workers.binding(accountId);
      expect(binding?.mode).toBe('ACTIVE_CONTROL');
      const secondAttempt = await facade.dispatch({ type: 'lineLoginQr', requestId: 'fresh-qr', accountId });
      expect(secondAttempt, JSON.stringify(secondAttempt)).toMatchObject({ ok: true });
      const replacement = await workers.binding(accountId);
      expect(replacement).toMatchObject({ accountId, mode: 'ACTIVE_CONTROL', controlEpoch: binding?.controlEpoch });
      expect(replacement?.workerInstanceId).not.toBe(binding?.workerInstanceId);
      expect(workers.transports).toHaveLength(2);
      expect(workers.transports.map((transport) => transport.loginCalls)).toEqual([['token'], ['qr']]);
    } finally { await facade.shutdown(); await rm(secretRoot, { recursive: true, force: true }); }
  });

  it('keeps active control and its epoch when QR relogin fails', async () => {
    await releaseRoleSlots(pool);
    const accountId = `failed-active-qr-${crypto.randomUUID()}`;
    await seedRoleAccount(pool, { accountId, role: 'AGENT', mode: 'ACTIVE_CONTROL', ownMid: 'saved-mid' });
    const workers = new LoopWorkers();
    const facade = await createConnectedFacade({ pool, workers, agent: new FakeAgent(), attachmentRoot: process.cwd() });
    try {
      expect(await facade.dispatch({ type: 'lineStart', requestId: 'start-active', accountId })).toMatchObject({ ok: true });
      const before = await facade.controlState();
      const binding = await workers.binding(accountId);
      workers.failNextQr = true;
      expect(await facade.dispatch({ type: 'lineLoginQr', requestId: 'failed-relogin', accountId })).toMatchObject({ ok: false });
      const replacement = await workers.binding(accountId);
      expect(replacement).toMatchObject({ accountId, mode: 'ACTIVE_CONTROL', controlEpoch: binding?.controlEpoch });
      expect(replacement?.workerInstanceId).not.toBe(binding?.workerInstanceId);
      expect(await facade.controlState()).toMatchObject({ activeAccountId: accountId, epoch: before.epoch });
      expect(workers.stoppedInstances).toEqual([binding?.workerInstanceId]);
    } finally { workers.failStop = false; await facade.shutdown(); }
  });

  it('keeps a failed monitor QR attempt independent of active control transfer', async () => {
    await releaseRoleSlots(pool);
    const accountA = `qr-monitor-a-${crypto.randomUUID()}`; const accountB = `qr-monitor-b-${crypto.randomUUID()}`;
    await seedRoleAccount(pool, { accountId: accountA, role: 'AGENT', mode: 'ACTIVE_CONTROL', ownMid: 'saved-a' });
    await seedRoleAccount(pool, { accountId: accountB, role: 'PRIMARY_ADMIN', ownMid: 'saved-b' });
    const workers = new LoopWorkers();
    const facade = await createConnectedFacade({ pool, workers, agent: new FakeAgent(), attachmentRoot: process.cwd() });
    try {
      await facade.dispatch({ type: 'lineStart', requestId: 'start-a', accountId: accountA });
      await facade.dispatch({ type: 'lineStart', requestId: 'start-b', accountId: accountB });
      const before = await facade.controlState();
      const bindingA = await workers.binding(accountA);
      const bindingB = await workers.binding(accountB);
      workers.failNextQr = true;
      expect(await facade.dispatch({ type: 'lineLoginQr', requestId: 'failed-monitor-relogin', accountId: accountB })).toMatchObject({ ok: false });
      expect(await facade.controlState()).toMatchObject({ activeAccountId: accountA, epoch: before.epoch });
      expect(await workers.binding(accountA)).toEqual(bindingA);
      const replacementB = await workers.binding(accountB);
      expect(replacementB).toMatchObject({ accountId: accountB, mode: 'MONITOR_ONLY', controlEpoch: bindingB?.controlEpoch });
      expect(replacementB?.workerInstanceId).not.toBe(bindingB?.workerInstanceId);
      expect(workers.stoppedInstances).toEqual([bindingB?.workerInstanceId]);
    } finally { await facade.shutdown(); }
  });

  // Control can no longer be switched between accounts (a1c2969), so the barrier is exercised through the remaining
  // operation that replaces the active worker: a QR relogin of the Agent.
  it('keeps the old supervisor barrier until a retained gateway child confirms exit', async () => {
    class RetainedChild {
      private message?: (value?: unknown) => void;
      private exit?: (value?: unknown) => void;
      private owner: Record<string, unknown> = {};
      on(event: 'message' | 'exit', listener: (value?: unknown) => void) {
        if (event === 'message') this.message = listener; else this.exit = listener;
      }
      postMessage(value: unknown) {
        const command = value as LineWorkerCommand;
        if (command.type === 'init') {
          this.owner = { transportOwnerId: command.transportOwnerId, transportGeneration: command.transportGeneration,
            writeGrantVersion: command.writeGrantVersion };
          queueMicrotask(() => {
            this.message?.({ type: 'workerProtocolAck', accountId: command.accountId, workerInstanceId: command.workerInstanceId,
              controlEpoch: command.controlEpoch, ...this.owner, protocolVersion: WORKER_PROTOCOL_VERSION, manualSend: true });
            this.message?.({ type: 'modeAck', accountId: command.accountId, ...this.owner,
              workerInstanceId: command.workerInstanceId, controlEpoch: command.controlEpoch, mode: command.mode, drained: true });
          });
        }
      }
      kill() { /* retained until the test confirms the process exit */ }
      confirmExit() { this.exit?.(); }
    }
    const accountA = `retained-a-${crypto.randomUUID()}`;
    await releaseRoleSlots(pool);
    await seedRoleAccount(pool, { accountId: accountA, role: 'AGENT', mode: 'ACTIVE_CONTROL', ownMid: 'retained-a-mid' });
    const children: RetainedChild[] = [];
    const starts: Bound[] = [];
    const workers = createUtilityWorkerGateway({ spawn: (binding) => { starts.push(binding); const child = new RetainedChild(); children.push(child); return child; },
      // lifecycleTimeoutMs defaults to stopTimeoutMs; the fixed-role binding callbacks need more than 5 ms of database work.
      stopTimeoutMs: 5, lifecycleTimeoutMs: 5_000, pollIntervalMs: 60_000 });
    const facade = await createConnectedFacade({ pool, workers, agent: new FakeAgent(), attachmentRoot: process.cwd() });
    try {
      const started = await facade.dispatch({ type: 'lineStart', requestId: 'start-a', accountId: accountA });
      expect(started, JSON.stringify(started)).toMatchObject({ ok: true });
      const epoch = (await facade.controlState()).epoch;
      expect(await facade.dispatch({ type: 'lineLoginQr', requestId: 'blocked-relogin', accountId: accountA })).toMatchObject({ ok: false });
      expect(children).toHaveLength(1);
      expect(starts).toHaveLength(1);
      expect(await facade.controlState()).toMatchObject({ activeAccountId: accountA, epoch });

      children[0]!.confirmExit();
      await Promise.resolve();
      expect(await facade.dispatch({ type: 'lineLoginQr', requestId: 'retry-relogin', accountId: accountA })).toMatchObject({ ok: true });
      expect(children).toHaveLength(2);
      expect(starts).toMatchObject([
        { accountId: accountA, mode: 'ACTIVE_CONTROL' },
        { accountId: accountA, mode: 'ACTIVE_CONTROL' },
      ]);
      expect(await facade.controlState()).toMatchObject({ activeAccountId: accountA, epoch });
    } finally {
      for (const child of children) child.confirmExit();
      await facade.shutdown();
    }
  });
});
