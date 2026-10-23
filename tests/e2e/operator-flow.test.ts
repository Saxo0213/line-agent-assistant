import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Pool } from 'pg';
import type { AgentEvent, AgentRunRequest, LineWorkerCommand, LineWorkerEvent, WorkerBinding } from '@line-agent/contracts';
import { WORKER_PROTOCOL_VERSION } from '@line-agent/contracts';
import { createTestDatabase } from '../../packages/database/src/test-database.js';
import { createConnectedFacade, type IntegratedWorkerGateway } from '../../apps/desktop/src/main/connected-facade.js';
import { SecretStore } from '../../apps/desktop/src/main/services/secret-store.js';
import { createUtilityWorkerGateway } from '../../apps/desktop/src/main/utility-worker-gateway.js';
import { releaseRoleSlots, seedRoleAccount } from './fixed-roles.js';

class FakeWorkers implements IntegratedWorkerGateway {
  readonly commands: LineWorkerCommand[] = [];
  readonly bindings = new Map<string, WorkerBinding & { mode: 'ACTIVE_CONTROL' | 'MONITOR_ONLY' | 'PAUSED' }>();
  private listener: ((instanceId: string, event: LineWorkerEvent) => Promise<void>) | undefined;
  private bindingListener: ((binding: WorkerBinding & { mode: 'ACTIVE_CONTROL' | 'MONITOR_ONLY' | 'PAUSED' }, signal: AbortSignal) => Promise<void> | void) | undefined;
  onEvent(listener: (instanceId: string, event: LineWorkerEvent) => Promise<void>): void { this.listener = listener; }
  onBinding(listener: (binding: WorkerBinding & { mode: 'ACTIVE_CONTROL' | 'MONITOR_ONLY' | 'PAUSED' }, signal: AbortSignal) => Promise<void> | void): void { this.bindingListener = listener; }
  async start(accountId: string, binding: WorkerBinding & { mode: 'ACTIVE_CONTROL' | 'MONITOR_ONLY' | 'PAUSED' }) { this.bindings.set(accountId, binding); await this.bindingListener?.(binding, new AbortController().signal); return binding; }
  async binding(accountId: string) { return this.bindings.get(accountId) ?? null; }
  async send(command: LineWorkerCommand): Promise<Extract<LineWorkerEvent, { type: 'sendResult' }>> {
    this.commands.push(command);
    if (command.type === 'revokeControl') this.bindings.set(command.accountId, { ...command, mode: 'MONITOR_ONLY' });
    return { type: 'sendResult', accountId: command.accountId, workerInstanceId: command.workerInstanceId,
      controlEpoch: command.controlEpoch, requestId: 'requestId' in command ? command.requestId : 'control',
      status: 'sent', messageId: `line-${this.commands.length}`, error: null };
  }
  async download(): Promise<never> { throw new Error('No attachment fixture queued'); }
  async waitModeAck(accountId: string, mode: 'ACTIVE_CONTROL' | 'MONITOR_ONLY') { return this.bindings.get(accountId)?.mode === mode; }
  async stop(accountId: string) { this.bindings.delete(accountId); }
  async stopBinding(binding: WorkerBinding) {
    if (this.bindings.get(binding.accountId)?.workerInstanceId === binding.workerInstanceId) this.bindings.delete(binding.accountId);
  }
  async emit(accountId: string, event: LineWorkerEvent) { await this.listener?.(this.bindings.get(accountId)!.workerInstanceId, event); }
  async shutdown() { this.bindings.clear(); }
}

class FakeAgent {
  readonly runs: AgentRunRequest[] = [];
  authChecks = 0;
  async *run(request: AgentRunRequest): AsyncIterable<AgentEvent> {
    this.runs.push(request);
    yield { type: 'started', externalSessionId: `session-${request.jobId}` };
    yield { type: 'text_delta', text: 'demo' };
    yield { type: 'completed', finalText: `完成：${request.prompt}` };
  }
  async cancel() {}
  async getAuthStatus(_provider: 'codex' | 'claude') { this.authChecks++;
    return { status: 'authenticated' as const }; }
  async openLogin() { return { ok: true }; }
  async logout() { return { ok: true }; }
  async shutdown() {}
}

async function waitUntil(check: () => boolean) {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('Timed out waiting for operator flow');
}

// Manual sends are admitted only for an authenticated, ready worker; the snapshot projects exactly that as
// canSendManually (refreshed at most once per second), so wait on it instead of sleeping.
async function waitForManualSend(facade: { dispatch(request: never): Promise<unknown> }, accountId: string): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt++) {
    const snapshot = await facade.dispatch({ type: 'getSnapshot', requestId: `manual-send-ready-${attempt}` } as never) as
      { type: string; ok: boolean; snapshot?: { accounts: Array<{ accountId: string; canSendManually?: boolean }> } };
    if (snapshot.type === 'getSnapshot' && snapshot.ok
      && snapshot.snapshot?.accounts.find((account) => account.accountId === accountId)?.canSendManually === true) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`Timed out waiting for ${accountId} to become manually sendable`);
}

// After a worker restart the cached snapshot may still describe the previous worker, so also retry a refused send until
// the replacement is authenticated and ready.
async function sendWhenReady(send: (requestId: string) => Promise<{ ok: boolean }>, label: string): Promise<{ ok: boolean }> {
  let result: { ok: boolean } = { ok: false };
  for (let attempt = 0; attempt < 100; attempt++) {
    result = await send(`${label}-${attempt}`);
    if (result.ok) return result;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return result;
}

describe('operator flow composition root', () => {
  let pool: Pool; let close: () => Promise<void>;
  beforeAll(async () => { ({ pool, close } = await createTestDatabase()); });
  afterAll(async () => { await close?.(); });

  // Fixed roles (a1c2969): the first reserved slot is the AGENT, which owns control; the second is the Primary Admin
  // monitor and is only reserved after the Agent has a verified identity and a bound primary admin.
  it('reserves the fixed Agent then Primary Admin slots and publishes a local QR/PIN/login flow', async () => {
    const workers = new FakeWorkers(); const events: unknown[] = [];
    const facade = await createConnectedFacade({ pool, workers, agent: new FakeAgent(), attachmentRoot: process.cwd(), publish: (event) => events.push(event) });
    try {
      expect((await facade.dispatch({ type: 'lineAddAccountQr', requestId: 'first-login' })).ok).toBe(true);
      const binding = [...workers.bindings.values()].find((item) => item.mode === 'ACTIVE_CONTROL');
      expect(binding).toBeTruthy();
      const login = workers.commands.findLast((command) => command.type === 'loginQr');
      expect(login).toMatchObject({ type: 'loginQr', accountId: binding!.accountId });
      if (login?.type !== 'loginQr') throw new Error('QR login command missing');
      await expect(workers.emit(binding!.accountId, { type: 'qr', ...binding!, loginAttemptId: login.loginAttemptId,
        code: 'x'.repeat(2049) })).rejects.toThrow(/QR payload/i);
      await workers.emit(binding!.accountId, { type: 'qr', ...binding!, loginAttemptId: login.loginAttemptId, code: 'qr-code' });
      await workers.emit(binding!.accountId, { type: 'pin', ...binding!, loginAttemptId: login.loginAttemptId, pin: '1234' });
      await workers.emit(binding!.accountId, { type: 'login', ...binding!, loginAttemptId: login.loginAttemptId, displayName: 'Agent', ownMid: 'u-agent' });
      expect(events).toEqual(expect.arrayContaining([
        expect.objectContaining({ type: 'lineQr', accountId: binding!.accountId, loginAttemptId: login.loginAttemptId,
          imageDataUrl: expect.stringMatching(/^data:image\/png;base64,/) }),
        expect.objectContaining({ type: 'linePin', accountId: binding!.accountId, loginAttemptId: login.loginAttemptId, pin: '1234' }),
        expect.objectContaining({ type: 'lineLoginState', accountId: binding!.accountId, loginAttemptId: login.loginAttemptId, state: 'connected' }),
      ]));
      expect((await pool.query('SELECT status,display_name,own_mid FROM line_accounts WHERE account_id=$1', [binding!.accountId])).rows[0])
        .toEqual({ status: 'connected', display_name: 'Agent', own_mid: 'u-agent' });
      expect(await facade.controlState()).toMatchObject({ activeAccountId: binding!.accountId });
      expect((await facade.dispatch({ type: 'lineAddAccountQr', requestId: 'blocked-second-login' })).ok).toBe(false);
      await pool.query("INSERT INTO account_administrators(account_id,chat_type,chat_id,user_id,role) VALUES ($1,'direct','admin-chat','u-admin','PRIMARY_ADMIN')",
        [binding!.accountId]);

      expect((await facade.dispatch({ type: 'lineAddAccountQr', requestId: 'second-login' })).ok).toBe(true);
      const second = [...workers.bindings.values()].find((item) => item.accountId !== binding!.accountId);
      const secondLogin = workers.commands.findLast((command) => command.type === 'loginQr');
      expect(second).toBeTruthy();
      expect(second!.accountId).not.toBe(binding!.accountId);
      expect(workers.bindings.get(binding!.accountId)?.mode).toBe('ACTIVE_CONTROL');
      expect(second!.mode).toBe('MONITOR_ONLY');
      expect(secondLogin).toMatchObject({ type: 'loginQr', accountId: second!.accountId });
      if (secondLogin?.type !== 'loginQr') throw new Error('Second QR login command missing');
      expect(secondLogin.loginAttemptId).not.toBe(login.loginAttemptId);

      expect((await facade.dispatch({ type: 'lineLoginQr', requestId: 'second-relogin', accountId: second!.accountId })).ok).toBe(true);
      const relogin = workers.commands.findLast((command) => command.type === 'loginQr');
      expect(relogin).toMatchObject({ type: 'loginQr', accountId: second!.accountId });
      if (relogin?.type !== 'loginQr') throw new Error('Relogin command missing');
      expect(relogin.loginAttemptId).not.toBe(secondLogin.loginAttemptId);
      expect([...workers.bindings.keys()]).toHaveLength(2);
    } finally { await facade.shutdown(); }
  });

  it('dispatches an explicit conversation history request to the authenticated LINE worker', async () => {
    const accountId = `history-${randomUUID()}`;
    await releaseRoleSlots(pool);
    await seedRoleAccount(pool, { accountId, role: 'AGENT', mode: 'ACTIVE_CONTROL', ownMid: 'u-self' });
    const workers = new FakeWorkers(); const events: unknown[] = [];
    const facade = await createConnectedFacade({ pool, workers, agent: new FakeAgent(), attachmentRoot: process.cwd(),
      publish: (event) => events.push(event) });
    try {
      expect((await facade.dispatch({ type: 'lineStart', requestId: 'history-start', accountId })).ok).toBe(true);

      const result = await facade.dispatch({ type: 'lineSyncHistory', requestId: 'history-request', accountId,
        chatType: 'direct', chatId: 'u-peer', cursor: null, limit: 50 } as never);

      expect(result).toEqual({ type: 'accepted', requestId: 'history-request', ok: true });
      expect(workers.commands).toContainEqual(expect.objectContaining({ type: 'history', requestId: 'history-request',
        accountId, chatType: 'direct', chatId: 'u-peer', cursor: null, limit: 50 }));
      const binding = workers.bindings.get(accountId)!;
      await workers.emit(accountId, { type: 'historyResult', ...binding, requestId: 'history-request', chatType: 'direct',
        chatId: 'u-peer', nextCursor: 'next-history-cursor', envelopes: [{ eventId: 'history-event', accountId,
          chatType: 'direct', chatId: 'u-peer', senderId: 'u-peer', messageId: 'history-message', kind: 'text',
          text: 'older text', mentionIds: [], mentionRanges: [], replyToMessageId: null, attachments: [], raw: {},
          occurredAt: '2026-10-16T00:00:00.000Z', ingestion: { source: 'history', cursor: null } }] });
      expect(events).toContainEqual({ type: 'lineHistorySynced', requestId: 'history-request', accountId,
        chatType: 'direct', chatId: 'u-peer', nextCursor: 'next-history-cursor' });
      expect((await pool.query('SELECT text_content FROM messages WHERE account_id=$1 AND message_id=$2',
        [accountId, 'history-message'])).rows[0]?.text_content).toBe('older text');
    } finally { await facade.shutdown(); }
  });

  it('returns authoritative timeline direction, replies and attachment metadata', async () => {
    const accountId = `timeline-${randomUUID()}`; const chatId = 'chat';
    await pool.query('INSERT INTO line_accounts(account_id,own_mid) VALUES ($1,$2)', [accountId, 'self-mid']);
    await pool.query("INSERT INTO conversations(account_id,chat_type,chat_id,title) VALUES ($1,'direct',$2,'Timeline')", [accountId, chatId]);
    await pool.query("INSERT INTO messages(account_id,chat_type,chat_id,message_id,event_id,sender_id,kind,text_content,reply_to_message_id,ingestion_source,occurred_at,raw) VALUES ($1,'direct',$2,'m1','e1','member','text','hello',NULL,'live',now()-interval '1 second','{}'),($1,'direct',$2,'m2','e2','self-mid','text','reply','m1','live',now(),'{}')", [accountId, chatId]);
    const attachmentId = randomUUID(); const bytes = Buffer.from('%PDF-1.7\npreview');
    const attachmentRoot = await mkdtemp(join(tmpdir(), 'facade-preview-'));
    const relativePath = `accounts/a/att-${createHash('sha256').update(bytes).digest('hex')}.blob`;
    await mkdir(join(attachmentRoot, 'accounts', 'a'), { recursive: true }); await writeFile(join(attachmentRoot, relativePath), bytes);
    await pool.query("INSERT INTO attachments(attachment_id,external_attachment_id,account_id,chat_type,chat_id,message_id,kind,name,mime_type,status,size_bytes,relative_path,sha256) VALUES ($1,'ext',$2,'direct',$3,'m2','file','invoice.pdf','application/pdf','ready',$4,$5,$6)", [attachmentId, accountId, chatId, bytes.byteLength, relativePath, createHash('sha256').update(bytes).digest('hex')]);
    let opened = '';
    const managedPath = join(attachmentRoot, relativePath);
    const facade = await createConnectedFacade({ pool, workers: new FakeWorkers(), agent: new FakeAgent(), attachmentRoot,
      openAttachmentPath: async (file) => { opened = file; return ''; } });
    try {
      const timeline = await facade.listMessages({ accountId, chatType: 'direct', chatId }, null, 10);
      expect(timeline.messages.find((item) => item.messageId === 'm2')).toMatchObject({ direction: 'outbound', replyToMessageId: 'm1', attachments: [expect.objectContaining({ id: attachmentId, name: 'invoice.pdf', status: 'ready' })] });
      await expect(facade.openAttachment(attachmentId, 7)).resolves.toBe(true);
      expect(opened).toBe(managedPath);
      expect(await readFile(managedPath, 'utf8')).toBe(bytes.toString());
    } finally { await facade.shutdown(); await rm(attachmentRoot, { recursive: true, force: true }); }
  });

  it('keeps manual sends available after an active utility worker automatically restarts', async () => {
    class Child {
      private message?: (value?: unknown) => void;
      private exit?: (value?: unknown) => void;
      private owner: Record<string, unknown> = {};
      on(event: 'message' | 'exit', listener: (value?: unknown) => void) {
        if (event === 'message') this.message = listener; else this.exit = listener;
      }
      kill() { this.exit?.(); }
      postMessage(value: unknown) {
        const command = value as LineWorkerCommand;
        const identity = { accountId: command.accountId, workerInstanceId: command.workerInstanceId, controlEpoch: command.controlEpoch };
        if (command.type === 'init') {
          this.owner = { transportOwnerId: command.transportOwnerId, transportGeneration: command.transportGeneration,
            writeGrantVersion: command.writeGrantVersion };
          queueMicrotask(() => {
            this.message?.({ type: 'workerProtocolAck', ...identity, ...this.owner, protocolVersion: WORKER_PROTOCOL_VERSION, manualSend: true });
            this.message?.({ type: 'modeAck', ...identity, ...this.owner, mode: command.mode, drained: true });
          });
        }
        // Manual sends need native login and connection readiness (LineService.isAuthenticatedReady). The facade restores
        // the saved session with loginToken, and a real worker answers it with login followed by status ready.
        if (command.type === 'loginToken') setTimeout(() => {
          this.message?.({ type: 'login', ...identity, ...this.owner, loginAttemptId: command.loginAttemptId, displayName: 'Auto', ownMid: 'auto-restart-mid' });
          // Readiness is only granted to an already authenticated worker, so the status follows the login write.
          setTimeout(() => this.message?.({ type: 'status', ...identity, ...this.owner, state: 'ready', message: null }), 40);
        }, 20);
        if (command.type === 'sendText' || command.type === 'manualSendText') queueMicrotask(() => this.message?.({ type: 'sendResult', ...identity, ...this.owner,
          requestId: command.requestId, operationId: command.operationId, attemptId: command.attemptId,
          status: 'sent', messageId: 'sent-message', error: null }));
      }
    }
    const children: Child[] = [];
    const workers = createUtilityWorkerGateway({
      spawn: () => { const child = new Child(); children.push(child); return child; },
      restartDelayMs: 5, pollIntervalMs: 60_000,
    });
    const secretRoot = await mkdtemp(join(tmpdir(), 'line-e2e-restart-secret-'));
    const secretStore = new SecretStore(secretRoot, { async protect(value) { return value; }, async unprotect(value) { return value; } });
    const facade = await createConnectedFacade({ pool, workers, agent: new FakeAgent(), attachmentRoot: process.cwd(), secretStore });
    try {
      await releaseRoleSlots(pool);
      await seedRoleAccount(pool, { accountId: 'auto-restart', role: 'AGENT', mode: 'ACTIVE_CONTROL', ownMid: 'auto-restart-mid' });
      secretStore.beginLogin('auto-restart', 'seed-worker', 'seed-attempt');
      expect(await secretStore.saveRotation('auto-restart', 'seed-worker', 'seed-attempt',
        { token: 'saved-token', qrCert: null, e2eeStorage: null })).toBe(true);
      expect((await facade.dispatch({ type: 'lineStart', requestId: 'auto-start', accountId: 'auto-restart' })).ok).toBe(true);
      const send = (requestId: string) => facade.dispatch({ type: 'sendText', requestId,
        accountId: 'auto-restart', chatType: 'group', chatId: 'chat', text: 'hello' });
      await waitForManualSend(facade, 'auto-restart');
      const before = await send('before-crash');
      expect(before.ok, JSON.stringify(before)).toBe(true);
      children[0]!.kill();
      await waitUntil(() => children.length === 2);
      expect(await workers.waitModeAck('auto-restart', 'ACTIVE_CONTROL', 1000)).toBe(true);
      await waitForManualSend(facade, 'auto-restart');
      const after = await sendWhenReady(send, 'after-crash');
      expect(after.ok, JSON.stringify(after)).toBe(true);
    } finally {
      await facade.shutdown();
      await rm(secretRoot, { recursive: true, force: true });
    }
  });

  // switchControl is disabled for fixed roles (CONTROL_SWITCH_DISABLED), so the same-account switch can no longer be the
  // lifecycle operation that races a restarted worker. A manual send is queued on the same lifecycle lane and must
  // neither deadlock behind the pending adoption nor replace the restarted worker once it acknowledges.
  it('queues lifecycle work behind a restarted worker that is awaiting its first ack without replacing it', async () => {
    class DelayedAckChild {
      private message?: (value?: unknown) => void;
      private exit?: (value?: unknown) => void;
      private init?: Extract<LineWorkerCommand, { type: 'init' }>;
      killed = false;
      constructor(private readonly autoAck: boolean) {}
      on(event: 'message' | 'exit', listener: (value?: unknown) => void) {
        if (event === 'message') this.message = listener; else this.exit = listener;
      }
      kill() { this.killed = true; this.exit?.(); }
      postMessage(value: unknown) {
        const command = value as LineWorkerCommand;
        if (command.type === 'init') { this.init = command; if (this.autoAck) queueMicrotask(() => this.ack()); }
        // The facade restores the saved session with loginToken; a real worker answers with login, then status ready.
        if (command.type === 'loginToken') setTimeout(() => {
          const identity = { accountId: command.accountId, workerInstanceId: command.workerInstanceId, controlEpoch: command.controlEpoch,
            transportOwnerId: command.transportOwnerId, transportGeneration: command.transportGeneration,
            writeGrantVersion: command.writeGrantVersion };
          this.message?.({ type: 'login', ...identity, loginAttemptId: command.loginAttemptId, displayName: 'Restart', ownMid: 'restart-switch-mid' });
          setTimeout(() => this.message?.({ type: 'status', ...identity, state: 'ready', message: null }), 40);
        }, 20);
        if (command.type === 'sendText' || command.type === 'manualSendText') queueMicrotask(() => this.message?.({ type: 'sendResult', accountId: command.accountId,
          workerInstanceId: command.workerInstanceId, controlEpoch: command.controlEpoch,
          transportOwnerId: command.transportOwnerId, transportGeneration: command.transportGeneration,
          writeGrantVersion: command.writeGrantVersion, requestId: command.requestId,
          operationId: command.operationId, attemptId: command.attemptId,
          status: 'sent', messageId: 'after-reconcile', error: null }));
      }
      ack() {
        if (!this.init) throw new Error('Worker was not initialized');
        this.message?.({ type: 'workerProtocolAck', accountId: this.init.accountId, workerInstanceId: this.init.workerInstanceId,
          controlEpoch: this.init.controlEpoch, transportOwnerId: this.init.transportOwnerId,
          transportGeneration: this.init.transportGeneration, writeGrantVersion: this.init.writeGrantVersion,
          protocolVersion: WORKER_PROTOCOL_VERSION, manualSend: true });
        this.message?.({ type: 'modeAck', accountId: this.init.accountId, workerInstanceId: this.init.workerInstanceId,
          controlEpoch: this.init.controlEpoch, transportOwnerId: this.init.transportOwnerId,
          transportGeneration: this.init.transportGeneration, writeGrantVersion: this.init.writeGrantVersion,
          mode: this.init.mode, drained: true });
      }
    }
    const children: DelayedAckChild[] = [];
    const workers = createUtilityWorkerGateway({
      spawn: () => { const child = new DelayedAckChild(children.length === 0); children.push(child); return child; },
      restartDelayMs: 5, pollIntervalMs: 60_000,
    });
    const secretRoot = await mkdtemp(join(tmpdir(), 'line-e2e-restart-switch-secret-'));
    const secretStore = new SecretStore(secretRoot, { async protect(value) { return value; }, async unprotect(value) { return value; } });
    const facade = await createConnectedFacade({ pool, workers, agent: new FakeAgent(), attachmentRoot: process.cwd(), secretStore });
    try {
      await releaseRoleSlots(pool);
      await seedRoleAccount(pool, { accountId: 'restart-switch', role: 'AGENT', mode: 'ACTIVE_CONTROL', ownMid: 'restart-switch-mid' });
      secretStore.beginLogin('restart-switch', 'seed-worker', 'seed-attempt');
      expect(await secretStore.saveRotation('restart-switch', 'seed-worker', 'seed-attempt',
        { token: 'saved-token', qrCert: null, e2eeStorage: null })).toBe(true);
      expect((await facade.dispatch({ type: 'lineStart', requestId: 'restart-switch-start', accountId: 'restart-switch' })).ok).toBe(true);
      await waitForManualSend(facade, 'restart-switch');
      const before = await facade.controlState();
      expect(await facade.dispatch({ type: 'switchControl', requestId: 'restart-switch-same',
        accountId: 'restart-switch', expectedEpoch: before.epoch })).toMatchObject({ ok: false, code: 'CONTROL_SWITCH_DISABLED' });
      children[0]!.kill();
      await waitUntil(() => children.length === 2);
      let settled = false;
      const queued = facade.dispatch({ type: 'sendText', requestId: 'restart-switch-queued', accountId: 'restart-switch',
        chatType: 'group', chatId: 'chat', text: 'queued behind adoption' }).finally(() => { settled = true; });
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(settled).toBe(false);
      children[1]!.ack();
      const queuedResult = await Promise.race([queued,
        new Promise((_, reject) => setTimeout(() => reject(new Error('lifecycle work deadlocked behind restart adoption')), 2000))]);
      // The worker has acknowledged but not yet re-authenticated, so this early send is refused rather than sent.
      expect(queuedResult, JSON.stringify(queuedResult)).toMatchObject({ ok: false, code: 'LINE_SEND_NOT_STARTED' });
      expect(children.length).toBe(2);
      expect(children[1]!.killed).toBe(false);
      expect((await facade.controlState()).activeAccountId).toBe('restart-switch');
      expect(before.epoch).toBe((await facade.controlState()).epoch);
      await waitForManualSend(facade, 'restart-switch');
      expect(await sendWhenReady((requestId) => facade.dispatch({ type: 'sendText', requestId, accountId: 'restart-switch',
        chatType: 'group', chatId: 'chat', text: 'still active' }), 'restart-switch-send')).toMatchObject({ ok: true });
    } finally {
      await facade.shutdown();
      await rm(secretRoot, { recursive: true, force: true });
    }
  });

  // Control is fixed to the AGENT slot, so it can no longer move to another account. The remaining way a restored active
  // worker loses authority is an explicit logout, which must revoke control and leave no usable send authority.
  it('refuses a control switch and revokes a restored active worker on logout', async () => {
    const workers = new FakeWorkers();
    const facade = await createConnectedFacade({ pool, workers, agent: new FakeAgent(), attachmentRoot: process.cwd() });
    try {
      // Reproduce persisted authority from a previous desktop process. The new supervisor has no in-memory active worker.
      await releaseRoleSlots(pool);
      await seedRoleAccount(pool, { accountId: 'restore-a', role: 'AGENT', mode: 'ACTIVE_CONTROL', ownMid: 'restore-a-mid' });
      await seedRoleAccount(pool, { accountId: 'restore-b', role: 'PRIMARY_ADMIN', ownMid: 'restore-b-mid' });
      const before = await facade.controlState();
      expect((await facade.dispatch({ type: 'lineStart', requestId: 'restore-start', accountId: 'restore-a' })).ok).toBe(true);
      expect(await facade.dispatch({ type: 'switchControl', requestId: 'restore-switch', accountId: 'restore-b', expectedEpoch: before.epoch }))
        .toMatchObject({ ok: false, code: 'CONTROL_SWITCH_DISABLED' });
      expect((await facade.controlState()).activeAccountId).toBe('restore-a');
      expect(await facade.dispatch({ type: 'lineLogout', requestId: 'restore-logout', accountId: 'restore-a' })).toMatchObject({ ok: true });
      // The fixed Agent keeps its control slot after logout, but its worker is stopped and nothing can be sent through it.
      expect(await workers.binding('restore-a')).toBeNull();
      // The logged-out account must not retain usable send authority.
      expect(await facade.dispatch({ type: 'sendText', requestId: 'restore-forbidden-send', accountId: 'restore-a',
        chatType: 'group', chatId: 'shared-chat', text: 'must not send' })).toMatchObject({ ok: false, code: 'LINE_SEND_NOT_STARTED' });
    } finally {
      await facade.shutdown();
    }
  });

  it('boots two accounts, fences control, archives a live message, runs an agent, and exposes search', async () => {
    const workers = new FakeWorkers(); const agent = new FakeAgent(); const events: unknown[] = [];
    const secretRoot = await mkdtemp(join(tmpdir(), 'line-e2e-secret-'));
    const secretStore = new SecretStore(secretRoot, { async protect(value) { return value; }, async unprotect(value) { return value; } });
    // Fixed roles: account-a is the AGENT (owns control), account-b the Primary Admin monitor bound to account-a.
    await releaseRoleSlots(pool);
    await seedRoleAccount(pool, { accountId: 'account-a', role: 'AGENT' });
    await seedRoleAccount(pool, { accountId: 'account-b', role: 'PRIMARY_ADMIN' });
    await pool.query("INSERT INTO account_administrators(account_id,chat_type,chat_id,user_id,role) VALUES ('account-a','direct','admin-chat','account-b-mid','PRIMARY_ADMIN')");
    const facade = await createConnectedFacade({ pool, workers, agent, attachmentRoot: process.cwd(), secretStore,
      publish: (event) => events.push(event) });
    // The startup probe (c9f846f) reports each provider's CLI login once; nothing re-checks it afterwards.
    const initialSnapshot = await facade.dispatch({ type: 'getSnapshot', requestId: 'initial-snapshot' });
    expect(initialSnapshot.type === 'getSnapshot' ? initialSnapshot.snapshot.providers.map((item) => item.status) : [])
      .toEqual(['logged_in', 'logged_in']);
    const startupAuthChecks = agent.authChecks;
    expect(startupAuthChecks).toBe(2);
    expect((await facade.dispatch({ type: 'lineStart', requestId: 'start-a', accountId: 'account-a' })).ok).toBe(true);
    expect((await facade.dispatch({ type: 'lineStart', requestId: 'start-b', accountId: 'account-b' })).ok).toBe(true);
    const initial = await facade.controlState();
    expect(initial.activeAccountId).toBe('account-a');
    const switchResult = await facade.dispatch({ type: 'switchControl', requestId: 'switch-a', accountId: 'account-a', expectedEpoch: initial.epoch });
    expect(switchResult).toMatchObject({ ok: false, code: 'CONTROL_SWITCH_DISABLED' });
    let active = await workers.binding('account-a');
    expect(active?.mode).toBe('ACTIVE_CONTROL');
    expect((await facade.dispatch({ type: 'lineLoginQr', requestId: 'qr-a', accountId: 'account-a' })).ok).toBe(true);
    active = await workers.binding('account-a');
    const qrA = workers.commands.findLast((command) => command.type === 'loginQr');
    expect(qrA?.type).toBe('loginQr');
    if (qrA?.type === 'loginQr') {
      await workers.emit('account-a', { type: 'secretRotation', ...active!, loginAttemptId: 'stale-attempt', secrets: { token: 'wrong', qrCert: null, e2eeStorage: null } });
      await workers.emit('account-a', { type: 'secretRotation', ...active!, loginAttemptId: qrA.loginAttemptId, secrets: { token: 'token-a', qrCert: 'cert-a', e2eeStorage: null } });
      await workers.emit('account-a', { type: 'login', ...active!, loginAttemptId: qrA.loginAttemptId,
        displayName: 'Agent A', ownMid: 'account-a-mid' });
      expect((await secretStore.load('account-a'))?.token).toBe('token-a');
    }

    await pool.query("INSERT INTO conversations(account_id,chat_type,chat_id,agent_enabled,default_provider) VALUES ('account-a','group','shared-chat',true,'codex') ON CONFLICT(account_id,chat_type,chat_id) DO UPDATE SET agent_enabled=true");
    expect((await facade.dispatch({ type: 'setWorkspace', requestId: 'workspace-live', workspacePath: process.cwd() })).ok).toBe(true);
    await pool.query("UPDATE line_accounts SET own_mid='agent-mid' WHERE account_id='account-a'");
    const cursor = { version: 1 as const, revision: '1', globalRev: '1', individualRev: '1' };
    await workers.emit('account-a', { type: 'batch', ...active!, batchId: 'batch-1', cursorBefore: { ...cursor, revision: '0', globalRev: '0', individualRev: '0' }, cursorAfter: cursor,
      envelopes: [{ accountId: 'account-a', eventId: 'event-1', messageId: 'message-1', chatId: 'shared-chat', chatType: 'group', senderId: 'member-1', kind: 'text', text: '@agent help', replyToMessageId: null,
        mentionIds: ['agent-mid'], mentionRanges: [{ start: 0, end: 6, userId: 'agent-mid' }], ingestion: { source: 'live', cursor: null }, occurredAt: new Date().toISOString(), attachments: [], raw: {} }] });
    expect(agent.authChecks).toBe(startupAuthChecks);
    expect(events).toContainEqual(expect.objectContaining({ type: 'messageStored', messageId: 'message-1',
      conversation: expect.objectContaining({ chatId: 'shared-chat', latestMessagePreview: '@agent help' }) }));
    expect(workers.commands.filter((command) => command.type === 'sendText' && command.chatId === 'shared-chat')).toHaveLength(0);
    expect(agent.runs.filter((run) => run.source.type === 'line' && run.source.chatId === 'shared-chat')).toHaveLength(0);
    expect((await pool.query("SELECT unread_count FROM conversations WHERE account_id='account-a' AND chat_type='group' AND chat_id='shared-chat'")).rows[0]!.unread_count).toBe(1);
    const result = await facade.dispatch({ type: 'searchMessages', requestId: 'search', query: { accountId: 'account-a', text: 'help', limit: 10 } });
    expect(result.type).toBe('searchMessages');
    if (result.type === 'searchMessages') expect(result.messages.map((item) => item.messageId)).toEqual(['message-1']);
    expect(workers.commands.some((command) => command.type === 'ackBatch' && command.batchId === 'batch-1')).toBe(true);
    await workers.emit('account-a', { type: 'batch', ...active!, batchId: 'batch-1', cursorBefore: { ...cursor, revision: '0', globalRev: '0', individualRev: '0' }, cursorAfter: cursor,
      envelopes: [{ accountId: 'account-a', eventId: 'event-1', messageId: 'message-1', chatId: 'shared-chat', chatType: 'group', senderId: 'member-1', kind: 'text', text: '@agent help', replyToMessageId: null,
        mentionIds: ['agent-mid'], mentionRanges: [{ start: 0, end: 6, userId: 'agent-mid' }], ingestion: { source: 'live', cursor: null }, occurredAt: new Date().toISOString(), attachments: [], raw: {} }] });
    expect((await pool.query("SELECT count(*)::int AS count FROM messages WHERE account_id='account-a' AND message_id='message-1'")).rows[0]!.count).toBe(1);
    expect((await pool.query("SELECT unread_count FROM conversations WHERE account_id='account-a' AND chat_type='group' AND chat_id='shared-chat'")).rows[0]!.unread_count).toBe(1);

    const beforeSwitch = await facade.controlState();
    expect(await facade.dispatch({ type: 'switchControl', requestId: 'switch-b', accountId: 'account-b', expectedEpoch: beforeSwitch.epoch }))
      .toMatchObject({ ok: false, code: 'CONTROL_SWITCH_DISABLED' });
    expect(await facade.controlState()).toMatchObject({ activeAccountId: 'account-a', epoch: beforeSwitch.epoch });
    expect((await facade.dispatch({ type: 'lineLoginQr', requestId: 'qr-b', accountId: 'account-b' })).ok).toBe(true);
    const activeB = await workers.binding('account-b'); const qrB = workers.commands.findLast((command) => command.type === 'loginQr');
    if (activeB && qrB?.type === 'loginQr') await workers.emit('account-b', { type: 'secretRotation', ...activeB, loginAttemptId: qrB.loginAttemptId,
      secrets: { token: 'token-b', qrCert: null, e2eeStorage: { key: 'b' } } });
    if (activeB && qrB?.type === 'loginQr') await workers.emit('account-b', { type: 'login', ...activeB,
      loginAttemptId: qrB.loginAttemptId, displayName: 'Agent B', ownMid: 'account-b-mid' });
    expect((await secretStore.load('account-a'))?.token).toBe('token-a');
    expect((await secretStore.load('account-b'))?.token).toBe('token-b');
    const restoreStart = workers.commands.length;
    expect((await facade.dispatch({ type: 'lineStart', requestId: 'restart-b', accountId: 'account-b' })).ok).toBe(true);
    expect(workers.commands.slice(restoreStart).map((command) => command.type)).toEqual(['setSecretState', 'loginToken']);
    const restored = await workers.binding('account-b');
    const tokenLogin = workers.commands.slice(restoreStart).find((command) => command.type === 'loginToken');
    if (!restored || tokenLogin?.type !== 'loginToken') throw new Error('Token login was not restored');
    await workers.emit('account-b', { type: 'login', ...restored, loginAttemptId: tokenLogin.loginAttemptId,
      displayName: 'Restored B', ownMid: 'account-b-mid' });
    expect((await pool.query("SELECT status FROM line_accounts WHERE account_id='account-b'")).rows[0]?.status).toBe('connected');
    expect((await facade.controlState()).activeAccountId).toBe('account-a');
    const lineSendCount = workers.commands.filter((command) => command.type === 'sendText').length;
    const ui = await facade.dispatch({ type: 'submitAgentRoomPrompt', requestId: 'ui-analysis', provider: 'codex', prompt: 'local only' });
    expect(ui.type).toBe('submitAgentRoomPrompt');
    await waitUntil(() => agent.runs.some((run) => run.source.type === 'ui' && run.source.requestId === 'ui-analysis'));
    expect(workers.commands.filter((command) => command.type === 'sendText')).toHaveLength(lineSendCount);
    const workRecordId = randomUUID();
    await pool.query("INSERT INTO work_records(work_record_id,title,account_id,chat_type,chat_id) VALUES ($1,'Follow up','account-a','group','shared-chat')", [workRecordId]);
    await expect(facade.listWorkRecords()).resolves.toContainEqual(expect.objectContaining({ id: workRecordId, title: 'Follow up', status: 'todo' }));
    await facade.shutdown();
    await rm(secretRoot, { recursive: true, force: true });
  });
});
