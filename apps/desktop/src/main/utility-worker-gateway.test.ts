import { describe, expect, it, vi } from 'vitest';
import type { LineWorkerCommand } from '@line-agent/contracts';
import { LineWorkerCommandSchema, WORKER_PROTOCOL_VERSION } from '@line-agent/contracts';
import { createUtilityWorkerGateway } from './utility-worker-gateway.js';

class FakeChild {
  readonly posted: unknown[] = [];
  autoExitOnKill = true;
  killCount = 0;
  private message?: (value: unknown) => void;
  private exit?: () => void;
  private owner: Record<string, unknown> = {};
  postMessage(value: unknown) {
    this.posted.push(value);
    if ((value as { type?: string })?.type === 'init') {
      const init = value as Record<string, unknown>;
      this.owner = { transportOwnerId: init.transportOwnerId, transportGeneration: init.transportGeneration,
        writeGrantVersion: init.writeGrantVersion };
    }
  }
  kill() { this.killCount += 1; if (this.autoExitOnKill) this.exit?.(); }
  on(event: 'message' | 'exit', listener: (value?: unknown) => void) {
    if (event === 'message') this.message = listener;
    else this.exit = listener;
  }
  emit(value: unknown) {
    if ((value as { type?: string })?.type === 'modeAck') {
      const { accountId, workerInstanceId, controlEpoch } = value as { accountId: string; workerInstanceId: string; controlEpoch: number };
      this.emitRaw({ type: 'workerProtocolAck', accountId, workerInstanceId, controlEpoch, protocolVersion: 4, manualSend: true });
    }
    this.emitRaw(value);
  }
  emitRaw(value: unknown) {
    const event = value as { requestId?: string };
    const sent = event.requestId && [...this.posted].reverse().find((item) =>
      ['sendText', 'manualSendText'].includes((item as { type?: string; requestId?: string }).type ?? '')
      && (item as { requestId?: string }).requestId === event.requestId) as Record<string, unknown> | undefined;
    this.message?.({ data: { ...this.owner, ...(sent ? { operationId: sent.operationId, attemptId: sent.attemptId } : {}),
      ...(value as object) }, ports: [] });
  }
  emitUnowned(value: unknown) { this.message?.({ data: value, ports: [] }); }
  crash() { this.exit?.(); }
}

function trackedAbortSignal() {
  const listeners = new Set<EventListenerOrEventListenerObject>();
  let aborted = false;
  const signal = {
    get aborted() { return aborted; },
    addEventListener(type: string, listener: EventListenerOrEventListenerObject) {
      if (type === 'abort') listeners.add(listener);
    },
    removeEventListener(type: string, listener: EventListenerOrEventListenerObject) {
      if (type === 'abort') listeners.delete(listener);
    },
  } as unknown as AbortSignal;
  return {
    signal,
    listenerCount: () => listeners.size,
    abort() {
      aborted = true;
      for (const listener of [...listeners]) {
        if (typeof listener === 'function') listener(new Event('abort'));
        else listener.handleEvent(new Event('abort'));
      }
    },
  };
}

describe('utility worker gateway', () => {
  it('keeps a replacement download worker unready until restart adoption completes after auth events', async () => {
    vi.useFakeTimers();
    const children: FakeChild[] = [];
    const gateway = createUtilityWorkerGateway({ spawn: () => { const child = new FakeChild(); children.push(child); return child; },
      restartDelayMs: 5, pollIntervalMs: 60_000 });
    const initial = { accountId: 'download-restart-ready', workerInstanceId: 'download-old', controlEpoch: 1,
      mode: 'MONITOR_ONLY' as const, purpose: 'DOWNLOAD_ONLY' as const, expectedMid: 'verified-mid' };
    let releaseRestart!: () => void;
    let restartStarted!: () => void;
    const restartStart = new Promise<void>((resolve) => { restartStarted = resolve; });
    const restartHold = new Promise<void>((resolve) => { releaseRestart = resolve; });
    gateway.onRestartBinding!(async () => { restartStarted(); await restartHold; });
    try {
      const started = await gateway.start(initial.accountId, initial);
      children[0]!.emit({ type: 'modeAck', accountId: started.accountId, workerInstanceId: started.workerInstanceId,
        controlEpoch: started.controlEpoch, transportOwnerId: started.transportOwnerId,
        transportGeneration: started.transportGeneration, writeGrantVersion: started.writeGrantVersion,
        mode: 'MONITOR_ONLY', drained: true });
      children[0]!.crash();
      await vi.advanceTimersByTimeAsync(5);
      const restarted = await gateway.binding(initial.accountId);
      expect(restarted).toMatchObject({ purpose: 'DOWNLOAD_ONLY', expectedMid: 'verified-mid' });
      children[1]!.emit({ type: 'modeAck', accountId: initial.accountId, workerInstanceId: restarted!.workerInstanceId,
        controlEpoch: initial.controlEpoch, mode: 'MONITOR_ONLY', drained: true });
      await restartStart;
      const { mode: _mode, purpose: _purpose, expectedMid: _expectedMid, application: _application, ...fields } = restarted!;
      const command = { type: 'adoptDownloadAuth' as const, ...fields, requestId: 'restart-auth', token: 'verified-token',
        application: 'DESKTOPWIN\t26.4.2.3957\tWINDOWS\t10.0.0-NT-x64', expectedMid: 'verified-mid' };
      const adopted = gateway.adoptDownloadAuth!(command);
      children[1]!.emitRaw({ type: 'downloadAuthResult', accountId: command.accountId, workerInstanceId: command.workerInstanceId,
        controlEpoch: command.controlEpoch, transportOwnerId: command.transportOwnerId, transportGeneration: command.transportGeneration,
        writeGrantVersion: command.writeGrantVersion, requestId: command.requestId, accepted: true, error: null });
      await expect(adopted).resolves.toMatchObject({ accepted: true });
      children[1]!.emitRaw({ type: 'downloadReady', accountId: command.accountId, workerInstanceId: command.workerInstanceId,
        controlEpoch: command.controlEpoch, transportOwnerId: command.transportOwnerId, transportGeneration: command.transportGeneration,
        writeGrantVersion: command.writeGrantVersion, ownMid: 'verified-mid' });
      expect(gateway.isDownloadReady!(restarted!)).toBe(false);
      releaseRestart();
      await vi.waitFor(() => expect(gateway.isDownloadReady!(restarted!)).toBe(true));
    } finally {
      releaseRestart();
      for (const child of children) child.crash();
      await gateway.shutdown();
      vi.useRealTimers();
    }
  });

  it.each([
    ['welcome Agent', false, 'ACTIVE_CONTROL', 'sendText'],
    ['manual Agent', true, 'ACTIVE_CONTROL', 'manualSendText'],
    ['manual Primary Admin', true, 'MONITOR_ONLY', 'manualSendText'],
  ] as const)('projects %s requests carrying mode into strict worker packets', async (_label, manual, mode, wireType) => {
    const child = new FakeChild();
    const gateway = createUtilityWorkerGateway({ spawn: () => child, pollIntervalMs: 60_000 });
    try {
      const current = await gateway.start('send-boundary', {
        accountId: 'send-boundary', workerInstanceId: 'send-boundary-worker', controlEpoch: 1, mode,
      });
      child.emit({ type: 'modeAck', ...current, mode, drained: true });
      const request = { type: 'sendText' as const, ...current, requestId: 'welcome-or-manual',
        chatType: 'direct' as const, chatId: 'u-peer', text: 'Welcome', replyToMessageId: null };
      const result = manual ? gateway.sendManual(request) : gateway.send(request);
      const outcome = expect(result).resolves.toMatchObject({ status: 'sent', messageId: 'boundary-sent' });
      const packet = child.posted.at(-1);
      const { mode: _mode, ...binding } = current;
      child.emit({ type: 'sendResult', ...binding, requestId: request.requestId,
        status: 'sent', messageId: 'boundary-sent', error: null });
      await outcome;
      expect(LineWorkerCommandSchema.safeParse(packet).success).toBe(true);
      expect(packet).not.toHaveProperty('mode');
      expect(packet).toMatchObject({ type: wireType, requestId: request.requestId, text: 'Welcome',
        transportOwnerId: current.transportOwnerId, transportGeneration: current.transportGeneration,
        writeGrantVersion: current.writeGrantVersion, operationId: request.requestId,
        attemptId: expect.any(String), effectPermit: expect.any(String) });
    } finally { await gateway.shutdown(); }
  });

  it.each([false, true])('rejects malformed send fields before pending registration or posting (manual=%s)', async (manual) => {
    const child = new FakeChild();
    const gateway = createUtilityWorkerGateway({ spawn: () => child, pollIntervalMs: 60_000 });
    try {
      const current = await gateway.start('invalid-send', {
        accountId: 'invalid-send', workerInstanceId: 'invalid-send-worker', controlEpoch: 1, mode: 'ACTIVE_CONTROL',
      });
      child.emit({ type: 'modeAck', ...current, drained: true });
      const before = gateway.inventory?.();
      const postedBefore = child.posted.length;
      const request = { type: 'sendText' as const, ...current, requestId: 'reusable-after-invalid',
        chatType: 'direct' as const, chatId: 'u-peer', text: 42, replyToMessageId: null } as unknown as Extract<LineWorkerCommand, { type: 'sendText' }>;
      const invalid = manual ? gateway.sendManual(request) : gateway.send(request);
      // Handle the pre-fix pending promise during shutdown without hiding admission failure.
      void invalid.catch(() => undefined);
      expect(gateway.inventory?.()).toEqual(before);
      expect(child.posted).toHaveLength(postedBefore);
      await expect(invalid).rejects.toThrow();
      const valid = { ...request, text: 'valid after rejection' };
      const result = manual ? gateway.sendManual(valid) : gateway.send(valid);
      expect(LineWorkerCommandSchema.safeParse(child.posted.at(-1)).success).toBe(true);
      const { mode: _mode, ...binding } = current;
      child.emit({ type: 'sendResult', ...binding, requestId: request.requestId,
        status: 'sent', messageId: 'valid-sent', error: null });
      await expect(result).resolves.toMatchObject({ status: 'sent' });
      expect(gateway.inventory?.()).toEqual(before);
    } finally { await gateway.shutdown(); }
  });

  it('admits the dedicated manual-send command for an acknowledged MONITOR_ONLY worker', async () => {
    const child = new FakeChild();
    const gateway = createUtilityWorkerGateway({ spawn: () => child, pollIntervalMs: 60_000 });
    const binding = { accountId: 'admin-manual', workerInstanceId: 'admin-manual-worker', controlEpoch: 8, mode: 'MONITOR_ONLY' as const };
    const current = await gateway.start(binding.accountId, binding);
    child.emit({ type: 'modeAck', ...current, mode: 'MONITOR_ONLY', drained: true });
    expect(gateway.isCurrentManualSendBinding(current)).toBe(true);
    const send = gateway.sendManual({ type: 'sendText', ...current, requestId: 'admin-manual-1', chatType: 'direct',
      chatId: 'u-peer', text: 'hello', replyToMessageId: null });
    expect(child.posted.at(-1)).toMatchObject({ type: 'manualSendText', accountId: binding.accountId, chatId: 'u-peer' });
    const command = child.posted.at(-1) as { requestId: string };
    child.emit({ type: 'sendResult', accountId: current.accountId, workerInstanceId: current.workerInstanceId,
      controlEpoch: current.controlEpoch, transportOwnerId: current.transportOwnerId,
      transportGeneration: current.transportGeneration, writeGrantVersion: current.writeGrantVersion,
      requestId: command.requestId, status: 'sent', messageId: 'sent-1', error: null });
    await expect(send).resolves.toMatchObject({ status: 'sent', messageId: 'sent-1' });
    await gateway.shutdown();
  });

  it('keeps manual sends bounded and never retries an unknown gateway attempt', async () => {
    const child = new FakeChild();
    const gateway = createUtilityWorkerGateway({ spawn: () => child, pollIntervalMs: 60_000,
      responseTimeoutMs: 5, maxSendsGlobal: 2 });
    const binding = { accountId: 'admin-manual-bound', workerInstanceId: 'admin-manual-bound-worker', controlEpoch: 9,
      mode: 'MONITOR_ONLY' as const };
    try {
      const current = await gateway.start(binding.accountId, binding);
      child.emit({ type: 'modeAck', ...current, mode: 'MONITOR_ONLY', drained: true });
      const timedOut = gateway.sendManual({ type: 'sendText', ...current, requestId: 'manual-unknown-once',
        chatType: 'direct', chatId: 'u-peer', text: 'no retry', replyToMessageId: null });
      await expect(timedOut).resolves.toMatchObject({ status: 'unknown', error: 'TRANSPORT_OUTCOME_UNKNOWN' });
      expect(child.posted.filter((item) => (item as { type?: string }).type === 'manualSendText')).toHaveLength(1);
      await expect(gateway.sendManual({ type: 'sendText', ...current, requestId: 'manual-unknown-once',
        chatType: 'direct', chatId: 'u-peer', text: 'duplicate', replyToMessageId: null })).rejects.toThrow(/Duplicate worker request ID/);

      const next = gateway.sendManual({ type: 'sendText', ...current, requestId: 'manual-next',
        chatType: 'direct', chatId: 'u-peer', text: 'bounded', replyToMessageId: null });
      await expect(gateway.sendManual({ type: 'sendText', ...current, requestId: 'manual-overflow',
        chatType: 'direct', chatId: 'u-peer', text: 'overflow', replyToMessageId: null })).rejects.toThrow('QUEUE_FULL');
      expect(child.posted.filter((item) => (item as { type?: string }).type === 'manualSendText')).toHaveLength(1);
      const queuedOutcome = expect(next).rejects.toThrow('Worker stopped');
      await gateway.shutdown();
      await queuedOutcome;
    } finally { await gateway.shutdown(); }
  });

  it('reports an observed worker exit with its safe binding identifiers', async () => {
    const child = new FakeChild();
    const gateway = createUtilityWorkerGateway({ spawn: () => child, pollIntervalMs: 60_000 });
    const exited = vi.fn();
    gateway.onWorkerExit?.(exited);
    const binding = { accountId: 'audit-account', workerInstanceId: 'audit-worker', controlEpoch: 1, mode: 'MONITOR_ONLY' as const };
    await gateway.start(binding.accountId, binding);
    child.crash();
    expect(exited).toHaveBeenCalledWith(expect.objectContaining({ accountId: binding.accountId, workerInstanceId: binding.workerInstanceId }));
    await gateway.shutdown();
  });

  it('validates the full current active-control binding and readiness snapshot', async () => {
    const child = new FakeChild();
    const gateway = createUtilityWorkerGateway({ spawn: () => child, pollIntervalMs: 60_000 });
    const desired = { accountId: 'exact-authority', workerInstanceId: 'exact-authority-worker', controlEpoch: 7, mode: 'ACTIVE_CONTROL' as const };
    await gateway.start(desired.accountId, desired);
    const binding = await gateway.binding(desired.accountId);
    expect(binding).not.toBeNull();
    expect(await gateway.isCurrentActiveControlBinding(binding!)).toBe(false);
    child.emit({ type: 'modeAck', ...desired, drained: true });
    expect(await gateway.isCurrentActiveControlBinding(binding!)).toBe(true);
    expect(await gateway.isCurrentActiveControlBinding({ ...binding!, writeGrantVersion: binding!.writeGrantVersion! + 1 })).toBe(false);
    expect(await gateway.isCurrentActiveControlBinding({ ...binding!, transportGeneration: binding!.transportGeneration! + 1 })).toBe(false);
    await gateway.stopBinding(binding!);
    expect(await gateway.isCurrentActiveControlBinding(binding!)).toBe(false);
    await gateway.shutdown();
  });

  it('rejects ownerless protocol and mode acknowledgements, then accepts the current owner', async () => {
    const child = new FakeChild();
    const gateway = createUtilityWorkerGateway({ spawn: () => child, pollIntervalMs: 60_000 });
    const binding = { accountId: 'owner-fence', workerInstanceId: 'owner-fence-worker', controlEpoch: 1, mode: 'ACTIVE_CONTROL' as const };
    await gateway.start(binding.accountId, binding);
    child.emitUnowned({ type: 'workerProtocolAck', accountId: binding.accountId, workerInstanceId: binding.workerInstanceId,
      controlEpoch: binding.controlEpoch, protocolVersion: WORKER_PROTOCOL_VERSION, manualSend: true });
    child.emitUnowned({ type: 'modeAck', ...binding, drained: true });
    await expect(gateway.waitModeAck(binding.accountId, 'ACTIVE_CONTROL', 0)).resolves.toBe(false);

    child.emitRaw({ type: 'workerProtocolAck', accountId: binding.accountId, workerInstanceId: binding.workerInstanceId,
      controlEpoch: binding.controlEpoch, protocolVersion: WORKER_PROTOCOL_VERSION, manualSend: true });
    child.emitRaw({ type: 'modeAck', ...binding, drained: true });
    await expect(gateway.waitModeAck(binding.accountId, 'ACTIVE_CONTROL', 1000)).resolves.toBe(true);
    await gateway.shutdown();
  });

  it('correlates Relation results by type, request, MID, and complete binding; ignores late or mismatched events', async () => {
    const child = new FakeChild();
    const gateway = createUtilityWorkerGateway({ spawn: () => child, pollIntervalMs: 60_000, responseTimeoutMs: 5_000 });
    const binding = { accountId: 'relation-gateway', workerInstanceId: 'relation-worker', controlEpoch: 4,
      mode: 'ACTIVE_CONTROL' as const };
    await gateway.start(binding.accountId, binding);
    child.emit({ type: 'modeAck', ...binding, drained: true });
    await gateway.waitModeAck(binding.accountId, 'ACTIVE_CONTROL', 1_000);
    const { mode: _mode, ...current } = (await gateway.binding(binding.accountId))!;
    const command = { type: 'checkFriendRelation' as const, ...current, requestId: 'relation-check', targetMid: `u${'a'.repeat(32)}` };
    const result = gateway.checkFriendRelation(command);
    const base = { type: 'friendRelationResult', accountId: current.accountId, workerInstanceId: current.workerInstanceId,
      controlEpoch: current.controlEpoch, transportOwnerId: current.transportOwnerId,
      transportGeneration: current.transportGeneration, writeGrantVersion: current.writeGrantVersion,
      requestId: command.requestId, targetMid: command.targetMid, status: 'friend', error: null };
    child.emitRaw({ ...base, type: 'addFriendResult', status: 'added' });
    child.emitRaw({ ...base, targetMid: `u${'b'.repeat(32)}` });
    child.emitRaw({ ...base, workerInstanceId: 'stale-worker' });
    child.emitRaw({ ...base, transportGeneration: (current.transportGeneration ?? 0) + 1 });
    await Promise.resolve();
    expect(gateway.inventory?.().pendingTasks).toBe(1);
    child.emitRaw(base);
    await expect(result).resolves.toMatchObject({ status: 'friend', requestId: command.requestId, targetMid: command.targetMid });
    await expect(gateway.checkFriendRelation(command)).rejects.toThrow(/Duplicate worker Relation request ID/);
    child.emitRaw(base); // A completed ID cannot be reopened by a late duplicate.
    expect(gateway.inventory?.().pendingTasks).toBe(0);
    await gateway.shutdown();
  });

  it('resolves pending checks unknown on revoke and ignores a later friend result', async () => {
    const child = new FakeChild();
    const gateway = createUtilityWorkerGateway({ spawn: () => child, pollIntervalMs: 60_000 });
    const binding = { accountId: 'relation-revoke', workerInstanceId: 'relation-revoke-worker', controlEpoch: 5, mode: 'ACTIVE_CONTROL' as const };
    await gateway.start(binding.accountId, binding);
    child.emit({ type: 'modeAck', ...binding, drained: true });
    await gateway.waitModeAck(binding.accountId, 'ACTIVE_CONTROL', 1_000);
    const { mode: _mode, ...current } = (await gateway.binding(binding.accountId))!;
    const command = { type: 'checkFriendRelation' as const, ...current, requestId: 'revoke-check', targetMid: `u${'d'.repeat(32)}` };
    const pending = gateway.checkFriendRelation(command);
    await gateway.send({ type: 'revokeControl', ...current });
    await expect(pending).resolves.toMatchObject({ status: 'unknown', error: 'RELATION_BINDING_REVOKED' });
    child.emitRaw({ type: 'friendRelationResult', ...current, requestId: command.requestId,
      targetMid: command.targetMid, status: 'friend', error: null });
    expect(gateway.inventory?.().pendingTasks).toBe(0);
    await gateway.shutdown();
  });

  it('fences Relation admission on a PAUSED acknowledgement and ignores the late friend result', async () => {
    const child = new FakeChild();
    const gateway = createUtilityWorkerGateway({ spawn: () => child, pollIntervalMs: 60_000 });
    const binding = { accountId: 'relation-paused', workerInstanceId: 'relation-paused-worker', controlEpoch: 8,
      mode: 'ACTIVE_CONTROL' as const };
    await gateway.start(binding.accountId, binding);
    child.emit({ type: 'modeAck', ...binding, drained: true });
    await gateway.waitModeAck(binding.accountId, 'ACTIVE_CONTROL', 1_000);
    const { mode: _mode, ...current } = (await gateway.binding(binding.accountId))!;
    const command = { type: 'checkFriendRelation' as const, ...current, requestId: 'paused-check', targetMid: `u${'f'.repeat(32)}` };
    const pending = gateway.checkFriendRelation(command);
    child.emit({ type: 'modeAck', ...binding, mode: 'PAUSED', drained: true });
    await expect(pending).resolves.toMatchObject({ status: 'unknown', error: 'RELATION_BINDING_REVOKED' });
    await vi.waitFor(async () => expect((await gateway.binding(binding.accountId))?.mode).toBe('PAUSED'));
    const { mode: _pausedMode, ...pausedBinding } = (await gateway.binding(binding.accountId))!;
    await expect(gateway.checkFriendRelation({ type: 'checkFriendRelation', ...pausedBinding,
      requestId: 'paused-check-new', targetMid: command.targetMid })).rejects.toThrow(/mode not acknowledged/i);
    await expect(gateway.addFriendByMid({ type: 'addFriendByMid', ...pausedBinding,
      requestId: 'paused-add-new', targetMid: command.targetMid })).rejects.toThrow(/mode not acknowledged/i);
    child.emitRaw({ type: 'friendRelationResult', ...pausedBinding, requestId: command.requestId,
      targetMid: command.targetMid, status: 'friend', error: null });
    expect(gateway.inventory?.().pendingTasks).toBe(0);
    await gateway.shutdown();
  });

  it('settles a posted Relation add as unknown when its worker exits', async () => {
    const child = new FakeChild();
    const gateway = createUtilityWorkerGateway({ spawn: () => child, pollIntervalMs: 60_000 });
    const binding = { accountId: 'relation-stop', workerInstanceId: 'relation-stop-worker', controlEpoch: 2, mode: 'ACTIVE_CONTROL' as const };
    await gateway.start(binding.accountId, binding);
    child.emit({ type: 'modeAck', ...binding, drained: true });
    const { mode: _mode, ...current } = (await gateway.binding(binding.accountId))!;
    const pending = gateway.addFriendByMid({ type: 'addFriendByMid', ...current, requestId: 'add-stop', targetMid: `u${'c'.repeat(32)}` });
    await vi.waitFor(() => expect(child.posted.some((value) => (value as { type?: string }).type === 'addFriendByMid')).toBe(true));
    await gateway.stop(binding.accountId);
    await expect(pending).resolves.toMatchObject({ type: 'addFriendResult', status: 'unknown', requestId: 'add-stop' });
  });

  it('does not reopen a completed add ID where its previous result could satisfy a new operation', async () => {
    const child = new FakeChild();
    const gateway = createUtilityWorkerGateway({ spawn: () => child, pollIntervalMs: 60_000 });
    const binding = { accountId: 'relation-add-replay', workerInstanceId: 'relation-add-worker', controlEpoch: 6, mode: 'ACTIVE_CONTROL' as const };
    await gateway.start(binding.accountId, binding);
    child.emit({ type: 'modeAck', ...binding, drained: true });
    await gateway.waitModeAck(binding.accountId, 'ACTIVE_CONTROL', 1_000);
    const { mode: _mode, ...current } = (await gateway.binding(binding.accountId))!;
    const command = { type: 'addFriendByMid' as const, ...current, requestId: 'single-add-id', targetMid: `u${'e'.repeat(32)}` };
    const pending = gateway.addFriendByMid(command);
    await vi.waitFor(() => expect(child.posted.some((value) => (value as { type?: string }).type === 'addFriendByMid')).toBe(true));
    const addCount = child.posted.filter((value) => (value as { type?: string }).type === 'addFriendByMid').length;
    child.emitRaw({ type: 'addFriendResult', ...current, requestId: command.requestId,
      targetMid: command.targetMid, status: 'added', error: null });
    await expect(pending).resolves.toMatchObject({ status: 'added', requestId: command.requestId });
    await expect(gateway.addFriendByMid(command)).rejects.toThrow(/Duplicate worker Relation request ID/);
    child.emitRaw({ type: 'addFriendResult', ...current, requestId: command.requestId,
      targetMid: command.targetMid, status: 'added', error: null });
    expect(child.posted.filter((value) => (value as { type?: string }).type === 'addFriendByMid')).toHaveLength(addCount);
    await gateway.shutdown();
  });

  it('enforces a global worker cap before spawning another account process', async () => {
    const children: FakeChild[] = [];
    const gateway = createUtilityWorkerGateway({ maxWorkers: 2, spawn: () => {
      const child = new FakeChild(); children.push(child); return child;
    } });
    for (const accountId of ['cap-a', 'cap-b']) {
      await gateway.start(accountId, { accountId, workerInstanceId: `worker-${accountId}`, controlEpoch: 1, mode: 'MONITOR_ONLY' });
    }

    await expect(gateway.start('cap-c', { accountId: 'cap-c', workerInstanceId: 'worker-cap-c', controlEpoch: 1, mode: 'MONITOR_ONLY' }))
      .rejects.toThrow(/global worker limit/i);
    expect(children).toHaveLength(2);
    expect(gateway.inventory?.()).toMatchObject({ activeWorkers: 2, launchingWorkers: 0, restartTimers: 0 });
    await gateway.shutdown();
  });

  it('reports only live gateway timers after protocol acknowledgement and shutdown', async () => {
    const child = new FakeChild();
    const gateway = createUtilityWorkerGateway({ spawn: () => child, pollIntervalMs: 60_000 });
    const binding = { accountId: 'timer-inventory', workerInstanceId: 'timer-inventory-worker', controlEpoch: 1, mode: 'MONITOR_ONLY' as const };
    await gateway.start(binding.accountId, binding);
    child.emit({ type: 'modeAck', ...binding, drained: true });
    expect(gateway.inventory?.().ownedTimers).toBe(1);
    await gateway.shutdown();
    expect(gateway.inventory?.()).toMatchObject({ activeWorkers: 0, ownedTimers: 0, ownedListeners: 0, pendingTasks: 0 });
  });

  it('reserves global worker capacity while a launch awaits its durable cursor', async () => {
    let release!: (value: null) => void;
    const cursor = new Promise<null>((resolve) => { release = resolve; });
    const children: FakeChild[] = [];
    const gateway = createUtilityWorkerGateway({ maxWorkers: 1, durableCursor: () => cursor, spawn: () => {
      const child = new FakeChild(); children.push(child); return child;
    } });
    const first = gateway.start('reserve-a', { accountId: 'reserve-a', workerInstanceId: 'worker-a', controlEpoch: 1, mode: 'MONITOR_ONLY' });
    await expect(gateway.start('reserve-b', { accountId: 'reserve-b', workerInstanceId: 'worker-b', controlEpoch: 1, mode: 'MONITOR_ONLY' }))
      .rejects.toThrow(/global worker limit/i);
    release(null);
    await first;
    expect(children).toHaveLength(1);
    await gateway.shutdown();
  });

  it('permanently rejects starts after shutdown including a late cursor lookup', async () => {
    let release!:()=>void;const gate=new Promise<void>(resolve=>{release=resolve;});const children:FakeChild[]=[];
    const gateway=createUtilityWorkerGateway({spawn:()=>{const child=new FakeChild();children.push(child);return child;},durableCursor:async()=>{await gate;return null;}});
    const binding={accountId:'late',workerInstanceId:'late-worker',controlEpoch:1,mode:'MONITOR_ONLY' as const};
    const start=gateway.start('late',binding).catch(()=>undefined);await Promise.resolve();await Promise.resolve();
    const shutdown=gateway.shutdown();release();await Promise.all([start,shutdown]);
    await expect(gateway.start('late',binding)).rejects.toThrow();expect(children).toHaveLength(0);
  });
  it('fails closed when the worker sends mode acknowledgement without the protocol handshake', async () => {
    const child = new FakeChild();
    const gateway = createUtilityWorkerGateway({ spawn: () => child, pollIntervalMs: 60_000 });
    const binding = { accountId: 'legacy-worker', workerInstanceId: 'legacy-instance', controlEpoch: 1, mode: 'ACTIVE_CONTROL' as const };
    await gateway.start(binding.accountId, binding);
    child.emitRaw({ type: 'modeAck', ...binding, drained: true });
    await expect(gateway.download({ type: 'downloadAttachment', ...binding, requestId: 'legacy',
      attemptToken: 'b7c252f7-8b1e-4fac-a9cc-69bc206c09a1', chatType: 'direct', chatId: 'chat', messageId: 'm',
      attachmentId: '2a653934-7064-4d90-a9f0-e6e24cf4f93d', externalAttachmentId: 'e', kind: 'file',
      occurredAt: '2026-10-15T00:00:00.000Z', originalFileName: 'x', lineMessage: {}, maxBytes: 1, timeoutMs: 1 })).rejects.toThrow(/protocol/i);
    await gateway.shutdown();
  });

  it('cancels an in-flight cursor lookup before stop returns and never spawns the retired account', async () => {
    let release!: (value: null) => void;
    const cursor = new Promise<null>((resolve) => { release = resolve; });
    const children: FakeChild[] = [];
    const gateway = createUtilityWorkerGateway({ durableCursor: () => cursor, spawn: () => { const child = new FakeChild(); children.push(child); return child; } });
    const start = gateway.start('account-a', { accountId: 'account-a', workerInstanceId: 'old', controlEpoch: 1, mode: 'ACTIVE_CONTROL' });
    const stopped = gateway.stop('account-a');
    release(null);
    await stopped;
    await expect(start).rejects.toThrow(/cancel/i);
    expect(children).toHaveLength(0);
    expect(await gateway.binding('account-a')).toBeNull();
  });

  it('shutdown cancels a start before its launch is registered', async () => {
    let release!: (value: null) => void;
    const cursor = new Promise<null>((resolve) => { release = resolve; });
    const children: FakeChild[] = [];
    const gateway = createUtilityWorkerGateway({ durableCursor: () => cursor, spawn: () => { const child = new FakeChild(); children.push(child); return child; } });
    const start = gateway.start('shutdown-account', { accountId: 'shutdown-account', workerInstanceId: 'old', controlEpoch: 1, mode: 'ACTIVE_CONTROL' });
    const shutdown = gateway.shutdown(); release(null);
    await shutdown;
    await expect(start).rejects.toThrow(/cancel/i);
    expect(children).toHaveLength(0);
  });

  it('uses the strict zero-cursor fallback when durableCursor resolves null', async () => {
    const child = new FakeChild();
    const gateway = createUtilityWorkerGateway({ durableCursor: async () => null, spawn: () => child });
    const binding = { accountId: 'null-cursor', workerInstanceId: 'null-worker', controlEpoch: 1, mode: 'ACTIVE_CONTROL' as const };
    await gateway.start(binding.accountId, binding);
    expect(child.posted[0]).toMatchObject({ type: 'init', durableCursor: { version: 1, revision: '0', globalRev: '0', individualRev: '0' } });
    await gateway.shutdown();
  });

  it('preserves a newer explicit start intent when a stale stop targets the old child', async () => {
    vi.useFakeTimers();
    const children: FakeChild[] = [];
    const gateway = createUtilityWorkerGateway({ spawn: () => { const child = new FakeChild(); children.push(child); return child; },
      pollIntervalMs: 60_000, stopTimeoutMs: 100 });
    const oldBinding = { accountId: 'intent-owner', workerInstanceId: 'intent-old', controlEpoch: 1, mode: 'ACTIVE_CONTROL' as const };
    const nextBinding = { accountId: oldBinding.accountId, workerInstanceId: 'intent-new', controlEpoch: 2, mode: 'MONITOR_ONLY' as const };
    try {
      await gateway.start(oldBinding.accountId, oldBinding);
      const oldChild = children[0]!;
      oldChild.autoExitOnKill = false;
      const starting = gateway.start(nextBinding.accountId, nextBinding);
      const stoppingOld = gateway.stopBinding(oldBinding);
      oldChild.crash();
      await stoppingOld;
      await starting;
      expect(children).toHaveLength(2);
      expect((await gateway.binding(nextBinding.accountId))?.workerInstanceId).toBe(nextBinding.workerInstanceId);
      expect(children[1]!.killCount).toBe(0);
    } finally {
      for (const child of children) child.crash();
      await gateway.shutdown();
      vi.useRealTimers();
    }
  });

  it('aborts and quarantines a never-returning cursor without late spawn side effects', async () => {
    vi.useFakeTimers();
    let releaseCursor!: (value: null) => void;
    const cursorPromise = new Promise<null>((resolve) => { releaseCursor = resolve; });
    const signals: AbortSignal[] = [];
    const children: FakeChild[] = [];
    let cursorCalls = 0;
    const gateway = createUtilityWorkerGateway({ lifecycleTimeoutMs: 5,
      durableCursor: (_accountId, signal) => { cursorCalls += 1; signals.push(signal!); return cursorPromise; },
      spawn: () => { const child = new FakeChild(); children.push(child); return child; } });
    const binding = { accountId: 'cursor-quarantine', workerInstanceId: 'quarantine-worker', controlEpoch: 1, mode: 'ACTIVE_CONTROL' as const };
    try {
      const starting = gateway.start(binding.accountId, binding);
      const rejected = expect(starting).rejects.toThrow(/deadline|cancel|quarantin/i);
      await vi.advanceTimersByTimeAsync(12);
      await rejected;
      expect(signals).toHaveLength(1);
      expect(signals[0]!.aborted).toBe(true);
      await expect(gateway.start(binding.accountId, { ...binding, workerInstanceId: 'quarantine-second' })).rejects.toThrow(/quarantin/i);
      expect(cursorCalls).toBe(1);
      releaseCursor(null);
      await vi.runAllTimersAsync();
      expect(children).toHaveLength(0);
      expect((await gateway.health!()).status).not.toBe('ready');
    } finally {
      releaseCursor(null);
      for (const child of children) child.crash();
      await gateway.shutdown();
      vi.useRealTimers();
    }
  });

  it('keeps never-returning binding callbacks quarantined and health degraded until child exit', async () => {
    vi.useFakeTimers();
    let releaseBinding!: () => void;
    const bindingTask = new Promise<void>((resolve) => { releaseBinding = resolve; });
    let receivedSignal: AbortSignal | undefined;
    const child = new FakeChild();
    child.autoExitOnKill = false;
    const gateway = createUtilityWorkerGateway({ lifecycleTimeoutMs: 5, stopTimeoutMs: 5, pollIntervalMs: 60_000,
      spawn: () => child });
    gateway.onBinding!(async (_binding, signal) => { receivedSignal = signal; await bindingTask; });
    const binding = { accountId: 'binding-quarantine', workerInstanceId: 'binding-worker', controlEpoch: 1, mode: 'ACTIVE_CONTROL' as const };
    try {
      const starting = gateway.start(binding.accountId, binding);
      const rejected = expect(starting).rejects.toThrow(/deadline|cancel|quarantin/i);
      await vi.advanceTimersByTimeAsync(12);
      await rejected;
      expect(receivedSignal?.aborted).toBe(true);
      expect(child.killCount).toBe(1);
      expect((await gateway.health!()).status).toBe('degraded');

      const firstShutdown = gateway.shutdown();
      const secondShutdown = gateway.shutdown();
      await vi.advanceTimersByTimeAsync(6);
      expect(await Promise.allSettled([firstShutdown, secondShutdown])).toMatchObject([{ status: 'rejected' }, { status: 'rejected' }]);
      expect(child.killCount).toBe(1);
      expect((await gateway.health!()).status).toBe('degraded');
      child.crash();
      releaseBinding();
      await vi.runAllTimersAsync();
      expect((await gateway.health!()).status).toBe('stopped');
    } finally {
      child.crash();
      releaseBinding();
      await gateway.shutdown();
      vi.useRealTimers();
    }
  });

  it('keeps the receive worker alive and polling after a send outcome becomes unknown', async () => {
    vi.useFakeTimers();
    const child = new FakeChild();
    const gateway = createUtilityWorkerGateway({ spawn: () => child, responseTimeoutMs: 5, pollIntervalMs: 1 });
    const binding = { accountId: 'send-timeout-receive', workerInstanceId: 'worker', controlEpoch: 1, mode: 'ACTIVE_CONTROL' as const };
    try {
      await gateway.start(binding.accountId, binding);
      child.emit({ type: 'modeAck', ...binding, mode: 'ACTIVE_CONTROL', drained: true });
      await Promise.resolve();
      const send = gateway.send({ type: 'sendText', ...binding, requestId: 'stuck-send', chatType: 'direct',
        chatId: 'peer', text: 'possibly sent', replyToMessageId: null });
      const unknown = expect(send).resolves.toMatchObject({ status: 'unknown', error: 'TRANSPORT_OUTCOME_UNKNOWN' });
      await vi.advanceTimersByTimeAsync(5);
      await unknown;
      expect(child.killCount).toBe(0);
      expect((await gateway.health!()).status).toBe('degraded');
      const pollsBefore = child.posted.filter((value) => (value as { type?: string }).type === 'poll').length;
      await vi.advanceTimersByTimeAsync(3);
      expect(child.posted.filter((value) => (value as { type?: string }).type === 'poll').length).toBeGreaterThan(pollsBefore);
      expect(await gateway.binding(binding.accountId)).toMatchObject({ workerInstanceId: binding.workerInstanceId });
    } finally {
      await gateway.shutdown();
      vi.useRealTimers();
    }
  });

  it('does not let a stale old-child stop cancel a send owned by the replacement generation', async () => {
    vi.useFakeTimers();
    const children: FakeChild[] = [];
    const gateway = createUtilityWorkerGateway({ spawn: () => { const child = new FakeChild(); children.push(child); return child; },
      pollIntervalMs: 60_000, stopTimeoutMs: 100 });
    const oldBinding = { accountId: 'handoff-send', workerInstanceId: 'old', controlEpoch: 1, mode: 'ACTIVE_CONTROL' as const };
    const newBinding = { accountId: oldBinding.accountId, workerInstanceId: 'new', controlEpoch: 2, mode: 'ACTIVE_CONTROL' as const };
    try {
      await gateway.start(oldBinding.accountId, oldBinding);
      children[0]!.autoExitOnKill = false;
      const startingNewAuthority = gateway.start(newBinding.accountId, newBinding);
      const staleStop = gateway.stopBinding(oldBinding);
      expect(children).toHaveLength(1);
      children[0]!.crash();
      await Promise.all([startingNewAuthority, staleStop]);
      expect(children).toHaveLength(2);
      children[1]!.emit({ type: 'modeAck', ...newBinding, mode: 'ACTIVE_CONTROL', drained: true });
      await Promise.resolve();

      const send = gateway.send({ type: 'sendText', ...newBinding, requestId: 'new-authority-send',
        chatType: 'direct', chatId: 'peer', text: 'new authority', replyToMessageId: null });
      await gateway.stopBinding(oldBinding);
      expect(children[1]!.killCount).toBe(0);
      children[1]!.emitRaw({ type: 'sendResult', accountId: newBinding.accountId, workerInstanceId: newBinding.workerInstanceId,
        controlEpoch: newBinding.controlEpoch, requestId: 'new-authority-send',
        status: 'sent', messageId: 'new-message', error: null });
      await expect(send).resolves.toMatchObject({ status: 'sent', messageId: 'new-message' });
    } finally {
      for (const child of children) child.crash();
      await gateway.shutdown();
      vi.useRealTimers();
    }
  });

  it('coalesces duplicate mode acknowledgement callbacks and settles their owner once', async () => {
    const child = new FakeChild();
    const gateway = createUtilityWorkerGateway({ spawn: () => child, lifecycleTimeoutMs: 1000, pollIntervalMs: 60_000 });
    const binding = { accountId: 'mode-control-lane', workerInstanceId: 'mode-worker', controlEpoch: 1, mode: 'MONITOR_ONLY' as const };
    let releaseCallback!: () => void;
    const callbackStarted = new Promise<void>((resolve) => { releaseCallback = resolve; });
    let started = 0;
    gateway.onModeChange!(async () => {
      started += 1;
      await callbackStarted;
    });
    try {
      await gateway.start(binding.accountId, binding);
      for (let index = 0; index < 4; index += 1) child.emit({ type: 'modeAck', ...binding, mode: 'MONITOR_ONLY', drained: true });
      await vi.waitFor(() => expect(started).toBe(1));
      await Promise.resolve();
      expect(started).toBe(1);
      releaseCallback();
      await vi.waitFor(async () => expect((await gateway.health!()).status).toBe('ready'));
      expect(started).toBe(1);
    } finally {
      releaseCallback();
      await gateway.shutdown();
    }
  });

  it('coalesces duplicate restart acknowledgements onto one owner-bound adoption callback', async () => {
    vi.useFakeTimers();
    const children: FakeChild[] = [];
    const gateway = createUtilityWorkerGateway({ spawn: () => { const child = new FakeChild(); children.push(child); return child; },
      restartDelayMs: 5, lifecycleTimeoutMs: 1000, pollIntervalMs: 60_000 });
    const binding = { accountId: 'restart-ack-coalesce', workerInstanceId: 'old', controlEpoch: 4, mode: 'MONITOR_ONLY' as const };
    let releaseAdoption!: () => void;
    let signalAdoption!: () => void;
    const adoptionStarted = new Promise<void>((resolve) => { signalAdoption = resolve; });
    const adoptionHold = new Promise<void>((resolve) => { releaseAdoption = resolve; });
    let adoptionCalls = 0;
    gateway.onRestartBinding!(async () => { adoptionCalls += 1; signalAdoption(); await adoptionHold; });
    try {
      await gateway.start(binding.accountId, binding);
      children[0]!.crash();
      await vi.advanceTimersByTimeAsync(5);
      const restarted = await gateway.binding(binding.accountId);
      for (let index = 0; index < 4; index += 1) children[1]!.emit({ type: 'modeAck',
        accountId: binding.accountId, workerInstanceId: restarted!.workerInstanceId, controlEpoch: binding.controlEpoch,
        mode: 'MONITOR_ONLY', drained: true });
      await adoptionStarted;
      await Promise.resolve();
      expect(adoptionCalls).toBe(1);
      releaseAdoption();
      await vi.waitFor(async () => expect((await gateway.health!()).status).toBe('ready'));
      expect(adoptionCalls).toBe(1);
    } finally {
      releaseAdoption();
      await gateway.shutdown();
      vi.useRealTimers();
    }
  });

  it('fences writes and carries revoked authority into replacement before mode acknowledgement', async () => {
    vi.useFakeTimers();
    const children: FakeChild[] = [];
    const gateway = createUtilityWorkerGateway({ spawn: () => { const child = new FakeChild(); children.push(child); return child; },
      restartDelayMs: 5, pollIntervalMs: 60_000 });
    const binding = { accountId: 'revoke-authority-before-ack', workerInstanceId: 'active-owner', controlEpoch: 9,
      mode: 'ACTIVE_CONTROL' as const };
    try {
      await gateway.start(binding.accountId, binding);
      children[0]!.emit({ type: 'modeAck', ...binding, mode: 'ACTIVE_CONTROL', drained: true });
      await Promise.resolve();
      await gateway.send({ type: 'revokeControl', accountId: binding.accountId,
        workerInstanceId: binding.workerInstanceId, controlEpoch: binding.controlEpoch });
      expect((await gateway.binding(binding.accountId))?.mode).toBe('MONITOR_ONLY');
      await expect(gateway.send({ type: 'sendText', ...binding, requestId: 'before-revoke-ack', chatType: 'direct',
        chatId: 'peer', text: 'blocked', replyToMessageId: null })).rejects.toThrow(/acknowledged|stale/i);
      children[0]!.emit({ type: 'modeAck', ...binding, mode: 'ACTIVE_CONTROL', drained: true });
      await Promise.resolve();
      expect((await gateway.binding(binding.accountId))?.mode).toBe('MONITOR_ONLY');
      children[0]!.crash();
      children[0]!.emit({ type: 'modeAck', ...binding, mode: 'ACTIVE_CONTROL', drained: true });
      await vi.advanceTimersByTimeAsync(5);
      expect(children).toHaveLength(2);
      expect(children[1]!.posted[0]).toMatchObject({ type: 'init', mode: 'MONITOR_ONLY' });
      children[1]!.emit({ type: 'modeAck', ...children[1]!.posted[0] as object, mode: 'ACTIVE_CONTROL', drained: true });
      await Promise.resolve();
      expect((await gateway.binding(binding.accountId))?.mode).toBe('MONITOR_ONLY');
      await expect(gateway.send({ type: 'sendText', ...binding, requestId: 'revoked-write', chatType: 'direct',
        chatId: 'peer', text: 'blocked', replyToMessageId: null })).rejects.toThrow(/acknowledged|stale/i);
    } finally {
      for (const child of children) child.crash();
      await gateway.shutdown();
      vi.useRealTimers();
    }
  });

  it('aborts restart adoption on stop and ignores its late completion', async () => {
    vi.useFakeTimers();
    const children: FakeChild[] = [];
    const gateway = createUtilityWorkerGateway({ spawn: () => { const child = new FakeChild(); children.push(child); return child; },
      restartDelayMs: 5, lifecycleTimeoutMs: 1000, pollIntervalMs: 60_000 });
    const binding = { accountId: 'restart-stop-adoption', workerInstanceId: 'old', controlEpoch: 3,
      mode: 'MONITOR_ONLY' as const };
    let releaseAdoption!: () => void;
    let signalAdoption!: () => void;
    let adoptionSignal: AbortSignal | undefined;
    const adoptionStarted = new Promise<void>((resolve) => { signalAdoption = resolve; });
    const adoptionHold = new Promise<void>((resolve) => { releaseAdoption = resolve; });
    gateway.onRestartBinding!(async (_binding, signal) => {
      adoptionSignal = signal;
      signalAdoption();
      await adoptionHold;
    });
    try {
      await gateway.start(binding.accountId, binding);
      children[0]!.crash();
      await vi.advanceTimersByTimeAsync(5);
      const restarted = await gateway.binding(binding.accountId);
      children[1]!.emit({ type: 'modeAck', accountId: binding.accountId,
        workerInstanceId: restarted!.workerInstanceId, controlEpoch: binding.controlEpoch,
        mode: 'MONITOR_ONLY', drained: true });
      await adoptionStarted;
      const stopping = gateway.stop(binding.accountId);
      await vi.runAllTimersAsync();
      await stopping;
      expect(adoptionSignal?.aborted).toBe(true);
      releaseAdoption();
      await Promise.resolve();
      expect((await gateway.health!()).status).not.toBe('ready');
      expect(children).toHaveLength(2);
    } finally {
      releaseAdoption();
      await gateway.shutdown();
      vi.useRealTimers();
    }
  });

  it('caps repeated start-stop cursor work to one quarantined task per account', async () => {
    vi.useFakeTimers();
    let releaseCursor!: (value: null) => void;
    const cursorPromise = new Promise<null>((resolve) => { releaseCursor = resolve; });
    let cursorCalls = 0;
    let activeCursorCalls = 0;
    let maxActiveCursorCalls = 0;
    const children: FakeChild[] = [];
    const gateway = createUtilityWorkerGateway({ lifecycleTimeoutMs: 5,
      durableCursor: async () => { cursorCalls += 1; activeCursorCalls += 1; maxActiveCursorCalls = Math.max(maxActiveCursorCalls, activeCursorCalls);
        try { return await cursorPromise; } finally { activeCursorCalls -= 1; } },
      spawn: () => { const child = new FakeChild(); children.push(child); return child; } });
    const binding = { accountId: 'repeated-intents', workerInstanceId: 'repeat-one', controlEpoch: 1, mode: 'ACTIVE_CONTROL' as const };
    try {
      const first = gateway.start(binding.accountId, binding);
      const firstRejected = expect(first).rejects.toThrow(/cancel|deadline|quarantin/i);
      await Promise.resolve();
      await gateway.stop(binding.accountId);
      await vi.advanceTimersByTimeAsync(6);
      await firstRejected;
      await expect(gateway.start(binding.accountId, { ...binding, workerInstanceId: 'repeat-two' })).rejects.toThrow(/quarantin/i);
      await expect(gateway.start(binding.accountId, { ...binding, workerInstanceId: 'repeat-three' })).rejects.toThrow(/quarantin/i);
      expect(cursorCalls).toBe(1);
      expect(maxActiveCursorCalls).toBe(1);
      releaseCursor(null);
      await vi.runAllTimersAsync();
      expect(children).toHaveLength(0);
      expect((await gateway.health!()).status).not.toBe('ready');
    } finally {
      releaseCursor(null);
      for (const child of children) child.crash();
      await gateway.shutdown();
      vi.useRealTimers();
    }
  });

  it('settles and removes a pending attachment request when its owner cancels it', async () => {
    const child = new FakeChild();
    const gateway = createUtilityWorkerGateway({ spawn: () => child, pollIntervalMs: 60_000 });
    const binding = { accountId: 'cancel-account', workerInstanceId: 'cancel-worker', controlEpoch: 1, mode: 'ACTIVE_CONTROL' as const };
    await gateway.start(binding.accountId, binding);
    child.emit({ type: 'modeAck', ...binding, drained: true }); await Promise.resolve();
    const controller = new AbortController();
    const command = { type: 'downloadAttachment' as const, ...binding, requestId: 'cancel-download', attemptToken: 'b7c252f7-8b1e-4fac-a9cc-69bc206c09a1', chatType: 'direct' as const,
      chatId: 'chat', messageId: 'm', attachmentId: '2a653934-7064-4d90-a9f0-e6e24cf4f93d', externalAttachmentId: 'e',
      kind: 'file' as const, occurredAt: '2026-10-15T00:00:00.000Z', originalFileName: 'x', lineMessage: {}, maxBytes: 1, timeoutMs: 10_000 };
    const download = (gateway.download as (command: LineWorkerCommand, signal?: AbortSignal) => Promise<unknown>)(command, controller.signal);
    controller.abort();
    const cancelCommand = child.posted.find((value) => (value as { type?: string }).type === 'cancelAttachmentDownload');
    expect(cancelCommand).toMatchObject({ type: 'cancelAttachmentDownload', attachmentId: command.attachmentId,
      attemptToken: command.attemptToken, workerInstanceId: binding.workerInstanceId });
    const early = await Promise.race([download.then(() => 'settled', () => 'settled'), new Promise<string>((resolve) => setTimeout(() => resolve('waiting'), 10))]);
    expect(early).toBe('waiting');
    child.emit({ type: 'attachmentCancelAck', accountId: binding.accountId, workerInstanceId: binding.workerInstanceId,
      controlEpoch: binding.controlEpoch, attachmentId: command.attachmentId, attemptToken: command.attemptToken, cancelled: true });
    await expect(download).rejects.toThrow('Worker download cancelled');
    await gateway.shutdown();
  });

  it('routes download timeout through worker cancellation and retains the slot until acknowledgement', async () => {
    vi.useFakeTimers();
    const child = new FakeChild();
    const gateway = createUtilityWorkerGateway({ spawn: () => child, pollIntervalMs: 60_000, stopTimeoutMs: 100 });
    const binding = { accountId: 'timeout-account', workerInstanceId: 'timeout-worker', controlEpoch: 1, mode: 'ACTIVE_CONTROL' as const };
    try {
      await gateway.start(binding.accountId, binding);
      child.emit({ type: 'modeAck', ...binding, drained: true }); await Promise.resolve();
      const command = { type: 'downloadAttachment' as const, ...binding, requestId: 'timeout-download', attemptToken: 'b7c252f7-8b1e-4fac-a9cc-69bc206c09a1', chatType: 'direct' as const,
        chatId: 'chat', messageId: 'm', attachmentId: '2a653934-7064-4d90-a9f0-e6e24cf4f93d', externalAttachmentId: 'e',
        kind: 'file' as const, occurredAt: '2026-10-15T00:00:00.000Z', originalFileName: 'x', lineMessage: {}, maxBytes: 1, timeoutMs: 5 };
      const download = gateway.download(command);
      let settled = false; void download.finally(() => { settled = true; }).catch(() => undefined);
      await vi.advanceTimersByTimeAsync(5);
      expect(child.posted.some((value) => (value as { type?: string }).type === 'cancelAttachmentDownload')).toBe(true);
      expect(settled).toBe(false);
      child.emit({ type: 'attachmentCancelAck', accountId: binding.accountId, workerInstanceId: binding.workerInstanceId,
        controlEpoch: binding.controlEpoch, attachmentId: command.attachmentId, attemptToken: command.attemptToken, cancelled: true });
      await expect(download).rejects.toThrow(/timed out/i);
    } finally { await gateway.shutdown(); vi.useRealTimers(); }
  });

  it('does not release a pending download when stop has neither cancel acknowledgement nor confirmed exit', async () => {
    vi.useFakeTimers();
    class HangingChild extends FakeChild { override kill() {} }
    const child = new HangingChild();
    const gateway = createUtilityWorkerGateway({ spawn: () => child, pollIntervalMs: 60_000, stopTimeoutMs: 5 });
    const binding = { accountId: 'stop-download-account', workerInstanceId: 'stop-download-worker', controlEpoch: 1, mode: 'ACTIVE_CONTROL' as const };
    try {
      await gateway.start(binding.accountId, binding);
      child.emit({ type: 'modeAck', ...binding, drained: true }); await Promise.resolve();
      const command = { type: 'downloadAttachment' as const, ...binding, requestId: 'stop-download', attemptToken: 'b7c252f7-8b1e-4fac-a9cc-69bc206c09a1', chatType: 'direct' as const,
        chatId: 'chat', messageId: 'm', attachmentId: '2a653934-7064-4d90-a9f0-e6e24cf4f93d', externalAttachmentId: 'e',
        kind: 'file' as const, occurredAt: '2026-10-15T00:00:00.000Z', originalFileName: 'x', lineMessage: {}, maxBytes: 1, timeoutMs: 60_000 };
      const download = gateway.download(command);
      let settled = false; void download.finally(() => { settled = true; }).catch(() => undefined);
      const stop = gateway.stop(binding.accountId).catch(() => undefined);
      await Promise.resolve();
      expect(child.posted.some((value) => (value as { type?: string }).type === 'cancelAttachmentDownload')).toBe(true);
      expect(settled).toBe(false);
      await vi.advanceTimersByTimeAsync(5);
      expect(settled).toBe(false);
      child.crash();
      await stop;
      await expect(download).rejects.toThrow(/exit/i);
    } finally { vi.useRealTimers(); }
  });

  it('retains a fenced degraded state when a killed child never confirms exit', async () => {
    class HangingChild extends FakeChild { override kill() {} }
    const child = new HangingChild();
    const gateway = createUtilityWorkerGateway({ spawn: () => child, stopTimeoutMs: 5, pollIntervalMs: 60_000 });
    const binding = { accountId: 'account-a', workerInstanceId: 'old', controlEpoch: 2, mode: 'ACTIVE_CONTROL' as const };
    await gateway.start('account-a', binding);
    await expect(gateway.stop('account-a')).rejects.toThrow('did not confirm exit');
    child.emit({ type: 'modeAck', ...binding, mode: 'ACTIVE_CONTROL', drained: true });
    await Promise.resolve();
    expect(await gateway.binding('account-a')).toMatchObject({ workerInstanceId: 'old', mode: 'PAUSED' });
    expect(await gateway.health?.()).toMatchObject({ status: 'degraded' });
    await expect(gateway.send({ type: 'sendText', ...binding, requestId: 'late', chatType: 'direct', chatId: 'chat', text: 'blocked', replyToMessageId: null })).rejects.toThrow(/stopping|stale/i);
    await expect(gateway.download({ type: 'downloadAttachment', ...binding, requestId: 'download', attemptToken: 'b7c252f7-8b1e-4fac-a9cc-69bc206c09a1', chatType: 'direct', chatId: 'chat', messageId: 'm', attachmentId: '2a653934-7064-4d90-a9f0-e6e24cf4f93d', externalAttachmentId: 'e', kind: 'file', occurredAt: '2026-10-15T00:00:00.000Z', originalFileName: 'x', lineMessage: {}, maxBytes: 1, timeoutMs: 1 })).rejects.toThrow(/stopping|stale/i);
  });

  it('ignores a late acknowledgement after confirmed exit', async () => {
    const child = new FakeChild(); const gateway = createUtilityWorkerGateway({ spawn: () => child, pollIntervalMs: 60_000 });
    const binding = { accountId: 'gone', workerInstanceId: 'gone-worker', controlEpoch: 3, mode: 'ACTIVE_CONTROL' as const };
    await gateway.start('gone', binding); await gateway.stop('gone');
    child.emit({ type: 'modeAck', ...binding, mode: 'ACTIVE_CONTROL', drained: true }); await Promise.resolve();
    expect(await gateway.binding('gone')).toBeNull();
    await expect(gateway.send({ type: 'sendText', ...binding, requestId: 'late', chatType: 'direct', chatId: 'chat', text: 'blocked', replyToMessageId: null })).rejects.toThrow(/stale/i);
  });

  it('does not restore ACTIVE authority when a demoted worker crashes', async () => {
    vi.useFakeTimers();
    const children: FakeChild[] = [];
    const gateway = createUtilityWorkerGateway({
      spawn: () => { const child = new FakeChild(); children.push(child); return child; },
      restartDelayMs: 5, pollIntervalMs: 60_000,
    });
    const binding = { accountId: 'revoked-account', workerInstanceId: 'old-worker', controlEpoch: 7, mode: 'ACTIVE_CONTROL' as const };
    try {
      await gateway.start(binding.accountId, binding);
      children[0]!.emit({ type: 'modeAck', accountId: binding.accountId, workerInstanceId: binding.workerInstanceId,
        controlEpoch: binding.controlEpoch, mode: 'MONITOR_ONLY', drained: true });
      await vi.advanceTimersByTimeAsync(0);
      expect((await gateway.binding(binding.accountId))?.mode).toBe('MONITOR_ONLY');
      children[0]!.crash();
      await vi.advanceTimersByTimeAsync(5);
      expect(children).toHaveLength(2);
      expect((await gateway.binding(binding.accountId))?.mode).toBe('MONITOR_ONLY');
    } finally {
      await gateway.shutdown();
      vi.useRealTimers();
    }
  });

  it('initializes, polls and correlates send results without accepting a stale binding', async () => {
    vi.useFakeTimers();
    const child = new FakeChild();
    const gateway = createUtilityWorkerGateway({ spawn: () => child, pollIntervalMs: 100 });
    const binding = { accountId: 'account-a', workerInstanceId: 'worker-a', controlEpoch: 7, mode: 'ACTIVE_CONTROL' as const };
    await gateway.start('account-a', binding);
    expect(child.posted[0]).toMatchObject({ type: 'init', protocolVersion: 4, ...binding });
    await vi.advanceTimersByTimeAsync(100);
    expect(child.posted[1]).toMatchObject({ type: 'poll', accountId: 'account-a', workerInstanceId: 'worker-a',
      controlEpoch: 7, transportOwnerId: expect.any(String), transportGeneration: 1, writeGrantVersion: 1 });
    child.emit({ type: 'modeAck', accountId: 'account-a', workerInstanceId: 'worker-a', controlEpoch: 7, mode: 'ACTIVE_CONTROL', drained: true });
    await Promise.resolve();
    const command: Extract<LineWorkerCommand, { type: 'sendText' }> = { type: 'sendText', ...binding, requestId: 'send-1', chatType: 'group', chatId: 'chat', text: 'hello', replyToMessageId: null };
    const pending = gateway.send(command);
    const sentCount = child.posted.length;
    await expect(gateway.send(command)).rejects.toThrow('Duplicate worker request ID');
    expect(child.posted).toHaveLength(sentCount);
    child.emit({ type: 'sendResult', accountId: 'account-a', workerInstanceId: 'worker-a', controlEpoch: 7,
      requestId: 'send-1', status: 'sent', messageId: 'line-1', error: null });
    await expect(pending).resolves.toMatchObject({ status: 'sent', messageId: 'line-1' });
    await expect(gateway.send({ ...command, workerInstanceId: 'stale', requestId: 'send-2' })).rejects.toThrow('Stale worker binding');
    await gateway.shutdown();
    vi.useRealTimers();
  });

  it('removes a pending send abort listener when the worker is stopped', async () => {
    const child = new FakeChild();
    const gateway = createUtilityWorkerGateway({ spawn: () => child, pollIntervalMs: 60_000 });
    const binding = { accountId: 'stop-send', workerInstanceId: 'stop-send-worker', controlEpoch: 1, mode: 'ACTIVE_CONTROL' as const };
    await gateway.start(binding.accountId, binding);
    child.emit({ type: 'modeAck', ...binding, drained: true });
    const tracked = trackedAbortSignal();
    const pending = gateway.send({ type: 'sendText', ...binding, requestId: 'stop-send-request', chatType: 'direct', chatId: 'chat', text: 'hello', replyToMessageId: null }, tracked.signal);
    expect(tracked.listenerCount()).toBe(1);

    const stopped = gateway.stop(binding.accountId);
    await expect(pending).resolves.toMatchObject({ status: 'unknown', error: 'TRANSPORT_OUTCOME_UNKNOWN' });
    await stopped;
    expect(tracked.listenerCount()).toBe(0);
  });

  it('removes a pending send abort listener after a successful result', async () => {
    const child = new FakeChild();
    const gateway = createUtilityWorkerGateway({ spawn: () => child, pollIntervalMs: 60_000 });
    const binding = { accountId: 'success-send', workerInstanceId: 'success-send-worker', controlEpoch: 1, mode: 'ACTIVE_CONTROL' as const };
    await gateway.start(binding.accountId, binding);
    child.emit({ type: 'modeAck', ...binding, drained: true });
    const tracked = trackedAbortSignal();
    const pending = gateway.send({ type: 'sendText', ...binding, requestId: 'success-send-request', chatType: 'direct', chatId: 'chat', text: 'hello', replyToMessageId: null }, tracked.signal);
    child.emit({ type: 'sendResult', accountId: binding.accountId, workerInstanceId: binding.workerInstanceId, controlEpoch: binding.controlEpoch,
      requestId: 'success-send-request', status: 'sent', messageId: 'line-1', error: null });
    await expect(pending).resolves.toMatchObject({ status: 'sent' });
    expect(tracked.listenerCount()).toBe(0);
    await gateway.shutdown();
  });

  it('removes a pending send abort listener after caller cancellation', async () => {
    const child = new FakeChild();
    const gateway = createUtilityWorkerGateway({ spawn: () => child, pollIntervalMs: 60_000 });
    const binding = { accountId: 'abort-send', workerInstanceId: 'abort-send-worker', controlEpoch: 1, mode: 'ACTIVE_CONTROL' as const };
    await gateway.start(binding.accountId, binding);
    child.emit({ type: 'modeAck', ...binding, drained: true });
    const tracked = trackedAbortSignal();
    const pending = gateway.send({ type: 'sendText', ...binding, requestId: 'abort-send-request', chatType: 'direct', chatId: 'chat', text: 'hello', replyToMessageId: null }, tracked.signal);
    expect(tracked.listenerCount()).toBe(1);
    tracked.abort();
    await expect(pending).rejects.toThrow('Worker send cancelled');
    expect(tracked.listenerCount()).toBe(0);
    await gateway.shutdown();
  });

  it('returns an unknown outcome and removes the abort listener when a posted send times out', async () => {
    vi.useFakeTimers();
    const child = new FakeChild();
    const gateway = createUtilityWorkerGateway({ spawn: () => child, pollIntervalMs: 60_000, responseTimeoutMs: 5 });
    const binding = { accountId: 'timeout-send-listener', workerInstanceId: 'timeout-send-worker', controlEpoch: 1, mode: 'ACTIVE_CONTROL' as const };
    try {
      await gateway.start(binding.accountId, binding);
      child.emit({ type: 'modeAck', ...binding, drained: true });
      const tracked = trackedAbortSignal();
      const pending = gateway.send({ type: 'sendText', ...binding, requestId: 'timeout-send-request', chatType: 'direct', chatId: 'chat', text: 'hello', replyToMessageId: null }, tracked.signal);
      const outcome = expect(pending).resolves.toMatchObject({ status: 'unknown', error: 'TRANSPORT_OUTCOME_UNKNOWN' });
      await vi.advanceTimersByTimeAsync(5);
      await outcome;
      expect(tracked.listenerCount()).toBe(0);
    } finally {
      await gateway.shutdown();
      vi.useRealTimers();
    }
  });

  it('keeps one physical send owner after UNKNOWN and starts queued sends only after reconciliation', async () => {
    vi.useFakeTimers();
    const children: FakeChild[] = [];
    const gateway = createUtilityWorkerGateway({
      spawn: () => { const child = new FakeChild(); children.push(child); return child; },
      pollIntervalMs: 1, responseTimeoutMs: 5, restartDelayMs: 5,
    });
    const binding = { accountId: 'retired-send', workerInstanceId: 'retired-instance', controlEpoch: 4, mode: 'ACTIVE_CONTROL' as const };
    const received: string[] = [];
    gateway.onEvent(async (_workerInstanceId, event) => { received.push(event.type); });
    try {
      await gateway.start(binding.accountId, binding);
      const child = children[0]!;
      child.autoExitOnKill = false;
      child.emit({ type: 'modeAck', ...binding, mode: 'ACTIVE_CONTROL', drained: true });
      const trackedFirst = trackedAbortSignal();
      const trackedSecond = trackedAbortSignal();
      const first = gateway.send({ type: 'sendText', ...binding, requestId: 'first-timeout', chatType: 'direct',
        chatId: 'chat', text: 'one', replyToMessageId: null }, trackedFirst.signal);
      const second = gateway.send({ type: 'sendText', ...binding, requestId: 'second-timeout', chatType: 'direct',
        chatId: 'chat', text: 'two', replyToMessageId: null }, trackedSecond.signal);
      const firstOutcome = expect(first).resolves.toMatchObject({ requestId: 'first-timeout', status: 'unknown', error: 'TRANSPORT_OUTCOME_UNKNOWN' });
      const secondOutcome = expect(second).resolves.toMatchObject({ requestId: 'second-timeout', status: 'unknown', error: 'TRANSPORT_OUTCOME_UNKNOWN' });
      await vi.advanceTimersByTimeAsync(5);
      await firstOutcome;

      expect(child.killCount).toBe(0);
      expect(trackedFirst.listenerCount()).toBe(0);
      expect(trackedSecond.listenerCount()).toBe(1);
      expect((await gateway.binding(binding.accountId))?.mode).toBe('ACTIVE_CONTROL');
      expect(child.posted.filter((value) => (value as { type?: string }).type === 'sendText')).toHaveLength(1);
      await expect(gateway.send({ type: 'sendText', ...binding, requestId: 'first-timeout', chatType: 'direct',
        chatId: 'chat', text: 'must not duplicate', replyToMessageId: null })).rejects.toThrow('Duplicate worker request ID');
      child.emitRaw({ type: 'sendResult', accountId: binding.accountId, workerInstanceId: binding.workerInstanceId,
        controlEpoch: binding.controlEpoch, requestId: 'first-timeout', status: 'sent', messageId: 'late', error: null });
      // Send pacing holds the queued message for a random gap; step until it is dispatched.
      for (let step = 0; step < 4_000 && child.posted.filter((value) => (value as { type?: string }).type === 'sendText').length < 2; step += 1) {
        await vi.advanceTimersByTimeAsync(1);
      }
      expect(child.posted.filter((value) => (value as { type?: string }).type === 'sendText')).toHaveLength(2);
      await vi.advanceTimersByTimeAsync(5);
      await secondOutcome;
      expect(trackedSecond.listenerCount()).toBe(0);
      await vi.advanceTimersByTimeAsync(20);
      expect(children).toHaveLength(1);
      expect(child.killCount).toBe(0);
      expect(received).not.toContain('status');

      child.crash();
      await vi.advanceTimersByTimeAsync(5);
      expect(children).toHaveLength(2);
    } finally {
      for (const child of children) child.crash();
      await gateway.shutdown();
      vi.useRealTimers();
    }
  });

  it('caps queued plus active sends per account and globally before posting', async () => {
    const children = new Map<string, FakeChild>();
    const gateway = createUtilityWorkerGateway({
      spawn: (binding) => { const child = new FakeChild(); children.set(binding.accountId, child); return child; },
      pollIntervalMs: 60_000, maxSendsGlobal: 160,
    });
    const bindings = Array.from({ length: 4 }, (_, index) => ({ accountId: `send-cap-${index}`,
      workerInstanceId: `worker-${index}`, controlEpoch: 1, mode: 'ACTIVE_CONTROL' as const }));
    const accepted: Promise<unknown>[] = [];
    try {
      for (const binding of bindings) await gateway.start(binding.accountId, binding);
      for (const binding of bindings) children.get(binding.accountId)!.emit({ type: 'modeAck', ...binding, drained: true });
      await Promise.resolve();
      for (let account = 0; account < 2; account += 1) {
        const binding = bindings[account]!;
        for (let index = 0; index < 64; index += 1) accepted.push(gateway.send({ type: 'sendText', ...binding,
          requestId: `request-${account}-${index}`, chatType: 'direct', chatId: 'peer', text: 'queued', replyToMessageId: null }));
      }
      const overflow = bindings[2]!;
      for (let index = 0; index < 32; index += 1) accepted.push(gateway.send({ type: 'sendText', ...overflow,
        requestId: `request-2-${index}`, chatType: 'direct', chatId: 'peer', text: 'queued', replyToMessageId: null }));
      await expect(gateway.send({ type: 'sendText', ...overflow, requestId: 'global-overflow', chatType: 'direct',
        chatId: 'peer', text: 'must not post', replyToMessageId: null })).rejects.toThrow('QUEUE_FULL');
      await expect(gateway.send({ type: 'sendText', ...bindings[0]!, requestId: 'account-overflow', chatType: 'direct',
        chatId: 'peer', text: 'must not post', replyToMessageId: null })).rejects.toThrow('QUEUE_FULL');
      for (const binding of bindings.slice(0, 3)) {
        expect(children.get(binding.accountId)!.posted.filter((value) => (value as { type?: string }).type === 'sendText')).toHaveLength(1);
      }
    } finally {
      const outcomes = Promise.allSettled(accepted);
      await gateway.shutdown();
      await outcomes;
    }
  });

  it('keeps ACTIVE authority after UNKNOWN and permits later sends after the old outcome is reconciled', async () => {
    vi.useFakeTimers();
    const children: FakeChild[] = [];
    const spawnModes: string[] = [];
    const gateway = createUtilityWorkerGateway({
      spawn: (spawnBinding) => { const child = new FakeChild(); children.push(child); spawnModes.push(spawnBinding.mode); return child; },
      pollIntervalMs: 60_000, responseTimeoutMs: 5, restartDelayMs: 5,
    });
    const binding = { accountId: 'active-recovery', workerInstanceId: 'active-old', controlEpoch: 9, mode: 'ACTIVE_CONTROL' as const };
    let activeReady = false;
    let monitorReady = false;
    gateway.onRestartBinding?.((nextBinding) => {
      activeReady = nextBinding.mode === 'ACTIVE_CONTROL';
      monitorReady = nextBinding.mode === 'MONITOR_ONLY';
    });
    try {
      await gateway.start(binding.accountId, binding);
      const oldChild = children[0]!;
      oldChild.emit({ type: 'modeAck', ...binding, mode: 'ACTIVE_CONTROL', drained: true });
      const timedOutSend = gateway.send({ type: 'sendText', ...binding, requestId: 'uncertain-before-restart',
        chatType: 'direct', chatId: 'chat', text: 'possibly sent', replyToMessageId: null });
      const uncertain = expect(timedOutSend).resolves.toMatchObject({ status: 'unknown', error: 'TRANSPORT_OUTCOME_UNKNOWN' });
      await vi.advanceTimersByTimeAsync(5);
      await uncertain;
      expect((await gateway.health?.())?.status).toBe('degraded');
      await vi.advanceTimersByTimeAsync(10);
      expect(children).toHaveLength(1);
      expect(spawnModes).toEqual(['ACTIVE_CONTROL']);
      oldChild.emitRaw({ type: 'sendResult', accountId: binding.accountId, workerInstanceId: binding.workerInstanceId,
        controlEpoch: binding.controlEpoch, requestId: 'uncertain-before-restart', status: 'sent', messageId: 'late-id', error: null });
      await vi.waitFor(async () => expect((await gateway.health?.())?.status).toBe('ready'));
      expect(activeReady).toBe(false);
      expect(monitorReady).toBe(false);
      expect((await gateway.binding(binding.accountId))?.mode).toBe('ACTIVE_CONTROL');

      const pendingDelivery = gateway.send({ type: 'sendText', ...binding, requestId: 'pending-after-restart',
        chatType: 'direct', chatId: 'chat', text: 'deliver after restart', replyToMessageId: null });
      // Send pacing holds the message for a random gap; step until it is dispatched.
      for (let step = 0; step < 4_000 && oldChild.posted.filter((value) => (value as { requestId?: string }).requestId === 'pending-after-restart').length === 0; step += 1) {
        await vi.advanceTimersByTimeAsync(1);
      }
      oldChild.emitRaw({ type: 'sendResult', accountId: binding.accountId, workerInstanceId: binding.workerInstanceId,
        controlEpoch: binding.controlEpoch, requestId: 'pending-after-restart',
        status: 'sent', messageId: 'line-message-1', error: null });
      await expect(pendingDelivery).resolves.toMatchObject({ status: 'sent', messageId: 'line-message-1' });
    } finally {
      for (const child of children) child.crash();
      await gateway.shutdown();
      vi.useRealTimers();
    }
  });

  it('keeps a concurrent monitor-only control change authoritative over automatic restart', async () => {
    vi.useFakeTimers();
    const children: FakeChild[] = [];
    const spawnModes: string[] = [];
    const gateway = createUtilityWorkerGateway({
      spawn: (spawnBinding) => { const child = new FakeChild(); children.push(child); spawnModes.push(spawnBinding.mode); return child; },
      pollIntervalMs: 60_000, responseTimeoutMs: 5, restartDelayMs: 5,
    });
    const binding = { accountId: 'control-change', workerInstanceId: 'control-old', controlEpoch: 3, mode: 'ACTIVE_CONTROL' as const };
    try {
      await gateway.start(binding.accountId, binding);
      const oldChild = children[0]!;
      oldChild.autoExitOnKill = false;
      oldChild.emit({ type: 'modeAck', ...binding, mode: 'ACTIVE_CONTROL', drained: true });
      const send = gateway.send({ type: 'sendText', ...binding, requestId: 'uncertain-control',
        chatType: 'direct', chatId: 'chat', text: 'possibly sent', replyToMessageId: null });
      const uncertain = expect(send).resolves.toMatchObject({ status: 'unknown' });
      await vi.advanceTimersByTimeAsync(5);
      await uncertain;

      const monitorBinding = { accountId: binding.accountId, workerInstanceId: 'monitor-new',
        controlEpoch: binding.controlEpoch + 1, mode: 'MONITOR_ONLY' as const };
      const startMonitor = gateway.start(binding.accountId, monitorBinding);
      oldChild.crash();
      await startMonitor;
      const replacement = children[1]!;
      const replacementInit = replacement.posted.find((value) => (value as { type?: string }).type === 'init') as
        { accountId: string; workerInstanceId: string; controlEpoch: number };
      const replacementLease = { accountId: replacementInit.accountId,
        workerInstanceId: replacementInit.workerInstanceId, controlEpoch: replacementInit.controlEpoch };
      replacement.emit({ type: 'modeAck', ...replacementLease, mode: 'MONITOR_ONLY', drained: true });
      await vi.advanceTimersByTimeAsync(10);
      expect(children).toHaveLength(2);
      expect(spawnModes).toEqual(['ACTIVE_CONTROL', 'MONITOR_ONLY']);
      expect((await gateway.binding(binding.accountId))?.mode).toBe('MONITOR_ONLY');
      expect(replacement.posted.filter((value) => (value as { type?: string }).type === 'sendText')).toHaveLength(0);
    } finally {
      for (const child of children) child.crash();
      await gateway.shutdown();
      vi.useRealTimers();
    }
  });

  it('does not automatically restart or reauthorize after stopBinding wins a send-timeout race', async () => {
    vi.useFakeTimers();
    const children: FakeChild[] = [];
    const gateway = createUtilityWorkerGateway({
      spawn: () => { const child = new FakeChild(); children.push(child); return child; },
      pollIntervalMs: 60_000, responseTimeoutMs: 5, restartDelayMs: 5,
    });
    const binding = { accountId: 'stopped-recovery', workerInstanceId: 'stopped-old', controlEpoch: 2, mode: 'ACTIVE_CONTROL' as const };
    try {
      await gateway.start(binding.accountId, binding);
      const oldChild = children[0]!;
      oldChild.autoExitOnKill = false;
      oldChild.emit({ type: 'modeAck', ...binding, mode: 'ACTIVE_CONTROL', drained: true });
      const send = gateway.send({ type: 'sendText', ...binding, requestId: 'uncertain-stop',
        chatType: 'direct', chatId: 'chat', text: 'possibly sent', replyToMessageId: null });
      const uncertain = expect(send).resolves.toMatchObject({ status: 'unknown' });
      await vi.advanceTimersByTimeAsync(5);
      await uncertain;

      const stopping = gateway.stopBinding(binding);
      oldChild.crash();
      await stopping;
      await vi.advanceTimersByTimeAsync(20);
      expect(children).toHaveLength(1);
      expect(await gateway.binding(binding.accountId)).toBeNull();
    } finally {
      for (const child of children) child.crash();
      await gateway.shutdown();
      vi.useRealTimers();
    }
  });

  it('cancels a scheduled restart when stopBinding arrives after the timed-out worker exits', async () => {
    vi.useFakeTimers();
    const children: FakeChild[] = [];
    const gateway = createUtilityWorkerGateway({
      spawn: () => { const child = new FakeChild(); children.push(child); return child; },
      pollIntervalMs: 60_000, responseTimeoutMs: 5, restartDelayMs: 10,
    });
    const binding = { accountId: 'stop-restart-gap', workerInstanceId: 'gap-old', controlEpoch: 5, mode: 'ACTIVE_CONTROL' as const };
    try {
      await gateway.start(binding.accountId, binding);
      const oldChild = children[0]!;
      oldChild.autoExitOnKill = false;
      oldChild.emit({ type: 'modeAck', ...binding, mode: 'ACTIVE_CONTROL', drained: true });
      const send = gateway.send({ type: 'sendText', ...binding, requestId: 'gap-unknown', chatType: 'direct',
        chatId: 'chat', text: 'possibly sent', replyToMessageId: null });
      const uncertain = expect(send).resolves.toMatchObject({ status: 'unknown' });
      await vi.advanceTimersByTimeAsync(5);
      await uncertain;

      oldChild.crash();
      await gateway.stopBinding(binding);
      await vi.advanceTimersByTimeAsync(20);
      expect(children).toHaveLength(1);
      expect(await gateway.binding(binding.accountId)).toBeNull();
    } finally {
      for (const child of children) child.crash();
      await gateway.shutdown();
      vi.useRealTimers();
    }
  });

  it('cancels a scheduled restart while replacement cursor lookup is pending', async () => {
    vi.useFakeTimers();
    const children: FakeChild[] = [];
    let cursorCalls = 0;
    let signalRestartCursor!: () => void;
    const restartCursorStarted = new Promise<void>((resolve) => { signalRestartCursor = resolve; });
    let releaseRestartCursor!: () => void;
    const restartCursorWait = new Promise<void>((resolve) => { releaseRestartCursor = resolve; });
    const cursor = { version: 1 as const, revision: '0', globalRev: '0', individualRev: '0' };
    const gateway = createUtilityWorkerGateway({
      spawn: () => { const child = new FakeChild(); children.push(child); return child; },
      durableCursor: async () => {
        cursorCalls += 1;
        if (cursorCalls === 1) return cursor;
        signalRestartCursor();
        await restartCursorWait;
        return cursor;
      },
      pollIntervalMs: 60_000, responseTimeoutMs: 5, restartDelayMs: 5,
    });
    const binding = { accountId: 'stop-launch-gap', workerInstanceId: 'launch-old', controlEpoch: 6, mode: 'ACTIVE_CONTROL' as const };
    try {
      await gateway.start(binding.accountId, binding);
      const oldChild = children[0]!;
      oldChild.autoExitOnKill = false;
      oldChild.emit({ type: 'modeAck', ...binding, mode: 'ACTIVE_CONTROL', drained: true });
      const send = gateway.send({ type: 'sendText', ...binding, requestId: 'launch-unknown', chatType: 'direct',
        chatId: 'chat', text: 'possibly sent', replyToMessageId: null });
      const uncertain = expect(send).resolves.toMatchObject({ status: 'unknown' });
      await vi.advanceTimersByTimeAsync(5);
      await uncertain;
      oldChild.crash();
      await vi.advanceTimersByTimeAsync(5);
      await restartCursorStarted;
      const stopping = gateway.stopBinding(binding);
      releaseRestartCursor();
      await stopping;
      await vi.advanceTimersByTimeAsync(20);
      expect(children).toHaveLength(1);
      expect(await gateway.binding(binding.accountId)).toBeNull();
    } finally {
      releaseRestartCursor();
      for (const child of children) child.crash();
      await gateway.shutdown();
      vi.useRealTimers();
    }
  });

  it('allows stopBinding for a spawned replacement while its binding callback is pending', async () => {
    vi.useFakeTimers();
    const children: FakeChild[] = [];
    let replacementCallbackStarted!: () => void;
    const callbackStarted = new Promise<void>((resolve) => { replacementCallbackStarted = resolve; });
    let releaseReplacementCallback!: () => void;
    const replacementCallback = new Promise<void>((resolve) => { releaseReplacementCallback = resolve; });
    let bindingCalls = 0;
    const gateway = createUtilityWorkerGateway({
      spawn: () => { const child = new FakeChild(); children.push(child); return child; },
      pollIntervalMs: 60_000, restartDelayMs: 5,
    });
    const binding = { accountId: 'stop-spawned-replacement', workerInstanceId: 'source-old', controlEpoch: 7, mode: 'ACTIVE_CONTROL' as const };
    gateway.onBinding!(async () => {
      bindingCalls += 1;
      if (bindingCalls > 1) { replacementCallbackStarted(); await replacementCallback; }
    });
    try {
      await gateway.start(binding.accountId, binding);
      const oldChild = children[0]!;
      oldChild.crash();
      await vi.advanceTimersByTimeAsync(10);
      await callbackStarted;
      const replacement = await gateway.binding(binding.accountId);
      expect(replacement).not.toBeNull();
      expect(replacement?.workerInstanceId).not.toBe(binding.workerInstanceId);

      const stopping = gateway.stopBinding(replacement!);
      await stopping;
      expect(children[1]!.killCount).toBe(1);
      expect(await gateway.binding(binding.accountId)).toBeNull();
      releaseReplacementCallback();
      await vi.runAllTimersAsync();
      expect(children).toHaveLength(2);
    } finally {
      releaseReplacementCallback();
      for (const child of children) child.crash();
      await gateway.shutdown();
      vi.useRealTimers();
    }
  });

  it('bounds stopBinding while a restart cursor lookup never resolves and fences a late result', async () => {
    vi.useFakeTimers();
    const children: FakeChild[] = [];
    const cursor = { version: 1 as const, revision: '0', globalRev: '0', individualRev: '0' };
    let cursorCalls = 0;
    let releaseRestartCursor!: (value: typeof cursor) => void;
    const restartCursor = new Promise<typeof cursor>((resolve) => { releaseRestartCursor = resolve; });
    const gateway = createUtilityWorkerGateway({
      spawn: () => { const child = new FakeChild(); children.push(child); return child; },
      durableCursor: async () => ++cursorCalls === 1 ? cursor : restartCursor,
      pollIntervalMs: 60_000, responseTimeoutMs: 5, restartDelayMs: 5, stopTimeoutMs: 5,
    });
    const binding = { accountId: 'stop-hung-restart-cursor', workerInstanceId: 'cursor-source', controlEpoch: 8, mode: 'ACTIVE_CONTROL' as const };
    try {
      await gateway.start(binding.accountId, binding);
      const oldChild = children[0]!;
      oldChild.autoExitOnKill = false;
      oldChild.emit({ type: 'modeAck', ...binding, mode: 'ACTIVE_CONTROL', drained: true });
      const send = gateway.send({ type: 'sendText', ...binding, requestId: 'cursor-stop-unknown', chatType: 'direct',
        chatId: 'chat', text: 'possibly sent', replyToMessageId: null });
      const uncertain = expect(send).resolves.toMatchObject({ status: 'unknown' });
      await vi.advanceTimersByTimeAsync(5);
      await uncertain;
      oldChild.crash();
      await vi.advanceTimersByTimeAsync(10);

      const stopping = gateway.stopBinding(binding);
      const settled = expect(stopping).resolves.toBeUndefined();
      await vi.advanceTimersByTimeAsync(6);
      await settled;
      releaseRestartCursor(cursor);
      await vi.runAllTimersAsync();
      expect(children).toHaveLength(1);
      expect(await gateway.binding(binding.accountId)).toBeNull();
    } finally {
      releaseRestartCursor(cursor);
      for (const child of children) child.crash();
      await gateway.shutdown();
      vi.useRealTimers();
    }
  });

  it('bounds shutdown while a durable cursor lookup never resolves and fences a late result', async () => {
    vi.useFakeTimers();
    let releaseCursor!: (value: null) => void;
    const cursor = new Promise<null>((resolve) => { releaseCursor = resolve; });
    const children: FakeChild[] = [];
    const gateway = createUtilityWorkerGateway({ durableCursor: () => cursor,
      spawn: () => { const child = new FakeChild(); children.push(child); return child; }, stopTimeoutMs: 5 });
    const binding = { accountId: 'shutdown-hung-cursor', workerInstanceId: 'cursor-old', controlEpoch: 1, mode: 'ACTIVE_CONTROL' as const };
    try {
      const start = gateway.start(binding.accountId, binding);
      const startCancelled = expect(start).rejects.toThrow(/cancel/i);
      const shutdown = gateway.shutdown();
      const settled = expect(shutdown).resolves.toBeUndefined();
      await vi.advanceTimersByTimeAsync(6);
      await settled;
      await startCancelled;
      releaseCursor(null);
      await vi.runAllTimersAsync();
      expect(children).toHaveLength(0);
      expect(await gateway.binding(binding.accountId)).toBeNull();
    } finally {
      releaseCursor(null);
      for (const child of children) child.crash();
      await gateway.shutdown();
      vi.useRealTimers();
    }
  });

  it('does not let a stale stopBinding cancel a newer explicit binding launch', async () => {
    vi.useFakeTimers();
    const children: FakeChild[] = [];
    let cursorCalls = 0;
    let signalNewCursor!: () => void;
    const newCursorStarted = new Promise<void>((resolve) => { signalNewCursor = resolve; });
    let releaseNewCursor!: () => void;
    const newCursorWait = new Promise<void>((resolve) => { releaseNewCursor = resolve; });
    const cursor = { version: 1 as const, revision: '0', globalRev: '0', individualRev: '0' };
    const gateway = createUtilityWorkerGateway({
      spawn: () => { const child = new FakeChild(); children.push(child); return child; },
      durableCursor: async () => {
        cursorCalls += 1;
        if (cursorCalls === 1) return cursor;
        signalNewCursor();
        await newCursorWait;
        return cursor;
      },
      pollIntervalMs: 60_000, responseTimeoutMs: 5, restartDelayMs: 20,
    });
    const binding = { accountId: 'stale-stop', workerInstanceId: 'stale-old', controlEpoch: 1, mode: 'ACTIVE_CONTROL' as const };
    const newer = { accountId: binding.accountId, workerInstanceId: 'explicit-new', controlEpoch: 2, mode: 'MONITOR_ONLY' as const };
    try {
      await gateway.start(binding.accountId, binding);
      const oldChild = children[0]!;
      oldChild.autoExitOnKill = false;
      oldChild.emit({ type: 'modeAck', ...binding, mode: 'ACTIVE_CONTROL', drained: true });
      const send = gateway.send({ type: 'sendText', ...binding, requestId: 'stale-stop-unknown', chatType: 'direct',
        chatId: 'chat', text: 'possibly sent', replyToMessageId: null });
      const uncertain = expect(send).resolves.toMatchObject({ status: 'unknown' });
      await vi.advanceTimersByTimeAsync(5);
      await uncertain;
      oldChild.crash();
      const launchNew = gateway.start(newer.accountId, newer);
      await newCursorStarted;
      await gateway.stopBinding(binding);
      releaseNewCursor();
      await launchNew;
      expect(children).toHaveLength(2);
      expect((await gateway.binding(newer.accountId))?.workerInstanceId).toBe('explicit-new');
      const newChild = children[1]!;
      const init = newChild.posted.find((value) => (value as { type?: string }).type === 'init') as
        { accountId: string; workerInstanceId: string; controlEpoch: number };
      const lease = { accountId: init.accountId, workerInstanceId: init.workerInstanceId, controlEpoch: init.controlEpoch };
      newChild.emit({ type: 'modeAck', ...lease, mode: 'MONITOR_ONLY', drained: true });
      await vi.advanceTimersByTimeAsync(25);
      expect(children).toHaveLength(2);
      expect((await gateway.binding(newer.accountId))?.mode).toBe('MONITOR_ONLY');
      expect(newChild.killCount).toBe(0);
    } finally {
      releaseNewCursor();
      for (const child of children) child.crash();
      await gateway.shutdown();
      vi.useRealTimers();
    }
  });

  it('removes a pending send abort listener when posting the command throws', async () => {
    const child = new FakeChild();
    const gateway = createUtilityWorkerGateway({ spawn: () => child, pollIntervalMs: 60_000 });
    const binding = { accountId: 'post-error-send', workerInstanceId: 'post-error-worker', controlEpoch: 1, mode: 'ACTIVE_CONTROL' as const };
    await gateway.start(binding.accountId, binding);
    child.emit({ type: 'modeAck', ...binding, drained: true });
    child.postMessage = (value: unknown) => {
      if ((value as { type?: string }).type === 'sendText') throw new Error('post failed');
      child.posted.push(value);
    };
    const tracked = trackedAbortSignal();
    await expect(gateway.send({ type: 'sendText', ...binding, requestId: 'post-error-request', chatType: 'direct', chatId: 'chat', text: 'hello', replyToMessageId: null }, tracked.signal)).rejects.toThrow('post failed');
    expect(tracked.listenerCount()).toBe(0);
    await gateway.shutdown();
  });

  it('does not physically send before the worker acknowledges ACTIVE mode', async () => {
    const child = new FakeChild();
    const gateway = createUtilityWorkerGateway({ spawn: () => child, pollIntervalMs: 60_000, responseTimeoutMs: 5 });
    const binding = { accountId: 'a', workerInstanceId: 'wa', controlEpoch: 1, mode: 'ACTIVE_CONTROL' as const };
    await gateway.start('a', binding);
    const before = child.posted.length;
    await expect(gateway.send({ type: 'sendText', ...binding, requestId: 'too-early', chatType: 'direct', chatId: 'chat', text: 'blocked', replyToMessageId: null })).rejects.toThrow('Worker mode not acknowledged');
    expect(child.posted).toHaveLength(before);
    await gateway.shutdown();
  });

  it('forwards Reaction only with the full current active-control authority', async () => {
    const child = new FakeChild();
    const gateway = createUtilityWorkerGateway({ spawn: () => child, pollIntervalMs: 60_000 });
    const desired = { accountId: 'reaction-authority', workerInstanceId: 'reaction-worker', controlEpoch: 4,
      mode: 'ACTIVE_CONTROL' as const };
    await gateway.start(desired.accountId, desired);
    const binding = await gateway.binding(desired.accountId);
    expect(binding).not.toBeNull();
    const reaction = (owner: Record<string, unknown> = {}) => ({ type: 'reactMessage' as const,
      ...binding!, ...owner, requestId: 'reaction-request', chatType: 'direct' as const,
      chatId: 'u-peer', messageId: '42', reaction: 'NICE' as const });
    const before = child.posted.filter((item) => (item as { type?: string }).type === 'reactMessage').length;

    await expect(gateway.send(reaction())).rejects.toThrow(/acknowledged|active-control/i);
    child.emit({ type: 'modeAck', ...desired, mode: 'ACTIVE_CONTROL', drained: true });
    await Promise.resolve();
    const readyBinding = await gateway.binding(desired.accountId);
    expect(readyBinding).not.toBeNull();

    const { transportOwnerId: _owner, transportGeneration: _generation, writeGrantVersion: _grant, ...ownerless } = reaction();
    await expect(gateway.send(ownerless as unknown as LineWorkerCommand)).rejects.toThrow(/binding/i);
    await expect(gateway.send(reaction({ transportOwnerId: 'wrong-owner' }))).rejects.toThrow(/binding/i);
    await expect(gateway.send(reaction({ writeGrantVersion: readyBinding!.writeGrantVersion! + 1 }))).rejects.toThrow(/binding/i);

    await expect(gateway.send(reaction())).resolves.toMatchObject({ status: 'unknown' });
    expect(child.posted.filter((item) => (item as { type?: string }).type === 'reactMessage')).toHaveLength(before + 1);
    expect(child.posted.at(-1)).toMatchObject({ type: 'reactMessage', transportOwnerId: readyBinding!.transportOwnerId,
      transportGeneration: readyBinding!.transportGeneration, writeGrantVersion: readyBinding!.writeGrantVersion });

    await gateway.send({ type: 'revokeControl', accountId: desired.accountId,
      workerInstanceId: desired.workerInstanceId, controlEpoch: desired.controlEpoch });
    await expect(gateway.send(reaction())).rejects.toThrow(/active-control|acknowledged/i);
    expect(child.posted.filter((item) => (item as { type?: string }).type === 'reactMessage')).toHaveLength(before + 1);
    await gateway.shutdown();
  });

  it('keeps receiving on the same worker when a LINE send never returns', async () => {
    vi.useFakeTimers();
    const children: FakeChild[] = [];
    const gateway = createUtilityWorkerGateway({
      spawn: () => { const child = new FakeChild(); children.push(child); return child; },
      pollIntervalMs: 60_000, responseTimeoutMs: 5, restartDelayMs: 5,
    });
    const binding = { accountId: 'a', workerInstanceId: 'wa', controlEpoch: 1, mode: 'ACTIVE_CONTROL' as const };
    try {
      await gateway.start('a', binding);
      children[0]!.emit({ type: 'modeAck', ...binding, mode: 'ACTIVE_CONTROL', drained: true });
      await vi.advanceTimersByTimeAsync(0);
      const outcome = expect(gateway.send({ type: 'sendText', ...binding, requestId: 'stalled', chatType: 'direct',
        chatId: 'u-peer', text: 'hello', replyToMessageId: null })).resolves.toMatchObject({
          status: 'unknown', error: 'TRANSPORT_OUTCOME_UNKNOWN' });

      await vi.advanceTimersByTimeAsync(5);
      await outcome;
      await vi.advanceTimersByTimeAsync(5);

      expect(children).toHaveLength(1);
      expect((await gateway.binding('a'))?.workerInstanceId).toBe('wa');
    } finally {
      await gateway.shutdown();
      vi.useRealTimers();
    }
  });

  it('never forwards the reserved local Agent room to a LINE worker', async () => {
    const child = new FakeChild();
    const gateway = createUtilityWorkerGateway({ spawn: () => child, pollIntervalMs: 60_000 });
    const binding = { accountId: 'a', workerInstanceId: 'wa', controlEpoch: 1, mode: 'ACTIVE_CONTROL' as const };
    await gateway.start('a', binding);
    child.emit({ type: 'modeAck', ...binding, mode: 'ACTIVE_CONTROL', drained: true });
    await Promise.resolve();
    const before = child.posted.length;
    await expect(gateway.send({ type: 'sendText', ...binding, requestId: 'local', chatType: 'direct',
      chatId: '__local_agent_room__', text: 'local prompt', replyToMessageId: null })).rejects.toThrow('Local-only route');
    expect(child.posted).toHaveLength(before);
    await gateway.shutdown();
  });

  it('forwards only validated, binding-correlated events and resolves mode acknowledgement', async () => {
    const child = new FakeChild();
    const gateway = createUtilityWorkerGateway({ spawn: () => child, pollIntervalMs: 60_000 });
    const events: string[] = [];
    const launches: string[] = []; const modes: string[] = [];
    gateway.onEvent(async (_instance, event) => { events.push(event.type); });
    gateway.onBinding!((binding) => { launches.push(binding.workerInstanceId); });
    gateway.onModeChange!((binding) => { modes.push(binding.mode); });
    const binding = { accountId: 'account-a', workerInstanceId: 'worker-a', controlEpoch: 2, mode: 'MONITOR_ONLY' as const };
    await gateway.start('account-a', binding);
    const acknowledged = gateway.waitModeAck('account-a', 'MONITOR_ONLY', 1000);
    let settled = false; void acknowledged.then(() => { settled = true; });
    await Promise.resolve();
    expect(settled).toBe(false);
    child.emit({ type: 'modeAck', accountId: 'account-a', workerInstanceId: 'worker-a', controlEpoch: 2, mode: 'MONITOR_ONLY', drained: true });
    await expect(acknowledged).resolves.toBe(true);
    child.emit({ type: 'status', accountId: 'other', workerInstanceId: 'worker-a', controlEpoch: 2, state: 'ready', message: null });
    await Promise.resolve();
    expect(events).toEqual(['modeAck']);
    expect(launches).toEqual(['worker-a']);
    expect(modes).toEqual(['MONITOR_ONLY']);
    await gateway.shutdown();
  });

  it('serializes durable domain event handling in worker arrival order', async () => {
    const child = new FakeChild();
    const gateway = createUtilityWorkerGateway({ spawn: () => child, pollIntervalMs: 60_000 });
    const started: string[] = []; const finished: string[] = [];
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve; });
    gateway.onEvent(async (_instance, event) => {
      if (event.type !== 'status') return;
      started.push(event.state);
      if (event.state === 'connecting') await firstGate;
      finished.push(event.state);
    });
    const binding = { accountId: 'ordered', workerInstanceId: 'ordered-worker', controlEpoch: 1, mode: 'MONITOR_ONLY' as const };
    await gateway.start('ordered', binding);
    child.emit({ type: 'status', accountId: binding.accountId, workerInstanceId: binding.workerInstanceId,
      controlEpoch: binding.controlEpoch, state: 'connecting', message: null });
    child.emit({ type: 'status', accountId: binding.accountId, workerInstanceId: binding.workerInstanceId,
      controlEpoch: binding.controlEpoch, state: 'ready', message: null });
    await Promise.resolve();
    expect(started).toEqual(['connecting']);
    releaseFirst();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(started).toEqual(['connecting', 'ready']);
    expect(finished).toEqual(['connecting', 'ready']);
    await gateway.shutdown();
  });

  it('delivers catalog events on an isolated coalesced lane so a blocked catalog cannot hold batch ACK or retire the worker', async () => {
    const child = new FakeChild();
    const gateway = createUtilityWorkerGateway({ spawn: () => child, pollIntervalMs: 60_000 });
    const effects: string[] = [];
    let releaseCatalog!: () => void;
    const catalogGate = new Promise<void>((resolve) => { releaseCatalog = resolve; });
    let catalogCalls = 0;
    const catalogTitles: string[] = [];
    gateway.onEvent(async (_instance, event) => {
      if (event.type === 'conversationCatalog') {
        catalogCalls += 1;
        catalogTitles.push(event.conversations[0]?.title ?? 'empty');
        if (catalogCalls === 1) {
          await catalogGate;
          throw new Error('catalog persistence unavailable');
        }
        return;
      }
      if (event.type === 'catalogRefreshStatus') {
        effects.push(`catalog:${event.state}`);
        return;
      }
      if (event.type === 'batch') {
        effects.push('archive');
        effects.push('kick');
        await gateway.send({ type: 'ackBatch', accountId: event.accountId, workerInstanceId: event.workerInstanceId,
          controlEpoch: event.controlEpoch, batchId: event.batchId, cursorAfter: event.cursorAfter });
        effects.push('ack');
      }
    });
    const binding = { accountId: 'catalog-lane', workerInstanceId: 'catalog-worker', controlEpoch: 1, mode: 'ACTIVE_CONTROL' as const };
    await gateway.start(binding.accountId, binding);
    const owner = await gateway.binding(binding.accountId);
    const eventBase = { accountId: binding.accountId, workerInstanceId: binding.workerInstanceId, controlEpoch: binding.controlEpoch };
    const catalog = (title: string) => ({ type: 'conversationCatalog', ...eventBase, conversations: [
      { chatType: 'direct', chatId: 'catalog-chat', title, members: [] },
    ] });
    child.emit(catalog('slow-first'));
    child.emit(catalog('latest-second'));
    child.emit({ type: 'batch', ...eventBase, batchId: 'catalog-blocked-batch',
      cursorBefore: { version: 1, revision: '0', globalRev: '0', individualRev: '0' },
      cursorAfter: { version: 1, revision: '1', globalRev: '1', individualRev: '0' }, envelopes: [] });

    await vi.waitFor(() => expect(effects).toEqual(['archive', 'kick', 'ack']));
    expect(child.posted).toContainEqual(expect.objectContaining({ type: 'ackBatch', batchId: 'catalog-blocked-batch' }));
    expect(owner).toMatchObject({ workerInstanceId: binding.workerInstanceId });
    releaseCatalog();
    await vi.waitFor(() => expect(effects).toContain('catalog:degraded'));
    expect(catalogCalls).toBe(2);
    expect(catalogTitles).toEqual(['slow-first', 'latest-second']);
    expect(await gateway.binding(binding.accountId)).not.toBeNull();
    expect(child.killCount).toBe(0);
    await gateway.shutdown();
  });

  it('isolates identical request IDs across accounts and rejects only the crashed workers request', async () => {
    const children = new Map<string, FakeChild>();
    const gateway = createUtilityWorkerGateway({ spawn: (binding) => { const child = new FakeChild(); children.set(binding.accountId, child); return child; }, pollIntervalMs: 60_000 });
    const a = { accountId: 'a', workerInstanceId: 'wa', controlEpoch: 1, mode: 'ACTIVE_CONTROL' as const };
    const b = { accountId: 'b', workerInstanceId: 'wb', controlEpoch: 1, mode: 'ACTIVE_CONTROL' as const };
    await gateway.start('a', a); await gateway.start('b', b);
    children.get('a')!.emit({ type: 'modeAck', ...a, mode: 'ACTIVE_CONTROL', drained: true });
    children.get('b')!.emit({ type: 'modeAck', ...b, mode: 'ACTIVE_CONTROL', drained: true });
    await Promise.resolve();
    const command = (binding: typeof a | typeof b) => ({ type: 'sendText' as const, ...binding, requestId: 'same', chatType: 'group' as const, chatId: 'chat', text: 'hello', replyToMessageId: null });
    const pendingA = gateway.send(command(a)); const pendingB = gateway.send(command(b));
    children.get('a')!.crash();
    await expect(pendingA).resolves.toMatchObject({ status: 'unknown', error: 'TRANSPORT_OUTCOME_UNKNOWN' });
    children.get('b')!.emit({ type: 'sendResult', accountId: 'b', workerInstanceId: 'wb', controlEpoch: 1, requestId: 'same', status: 'sent', messageId: 'b-line', error: null });
    await expect(pendingB).resolves.toMatchObject({ messageId: 'b-line' });
    await gateway.shutdown();
  });

  it('resolves raw mode acknowledgement while restart adoption is still pending', async () => {
    vi.useFakeTimers();
    const children: FakeChild[] = [];
    const gateway = createUtilityWorkerGateway({ spawn: () => { const child = new FakeChild(); children.push(child); return child; },
      restartDelayMs: 5, pollIntervalMs: 60_000 });
    let releaseAdoption!: () => void;
    gateway.onRestartBinding!(async () => new Promise<void>((resolve) => { releaseAdoption = resolve; }));
    try {
      await gateway.start('restart-ack', { accountId: 'restart-ack', workerInstanceId: 'old', controlEpoch: 1, mode: 'MONITOR_ONLY' });
      children[0]!.crash();
      await vi.advanceTimersByTimeAsync(5);
      const restartedBinding = await gateway.binding('restart-ack');
      const raw = gateway.waitRawModeAck!('restart-ack', 'MONITOR_ONLY', 1000);
      const adopted = gateway.waitModeAck('restart-ack', 'MONITOR_ONLY', 1000);
      children[1]!.emit({ type: 'modeAck', accountId: 'restart-ack', workerInstanceId: restartedBinding!.workerInstanceId,
        controlEpoch: 1, mode: 'MONITOR_ONLY', drained: true });
      await expect(raw).resolves.toBe(true);
      let adoptionSettled = false; void adopted.then(() => { adoptionSettled = true; });
      await Promise.resolve();
      expect(adoptionSettled).toBe(false);
      releaseAdoption();
      await expect(adopted).resolves.toBe(true);
    } finally {
      await gateway.shutdown();
      vi.useRealTimers();
    }
  });

  it('discards queued domain events when their worker instance is retired', async () => {
    const children: FakeChild[] = [];
    const gateway = createUtilityWorkerGateway({ spawn: () => { const child = new FakeChild(); children.push(child); return child; }, pollIntervalMs: 60_000 });
    const events: string[] = [];
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve; });
    gateway.onEvent(async (_instance, event) => {
      if (event.type !== 'status') return;
      events.push(`${event.workerInstanceId}:${event.state}`);
      if (event.workerInstanceId === 'old' && event.state === 'connecting') await firstGate;
    });
    await gateway.start('fenced', { accountId: 'fenced', workerInstanceId: 'old', controlEpoch: 1, mode: 'MONITOR_ONLY' });
    children[0]!.emit({ type: 'status', accountId: 'fenced', workerInstanceId: 'old', controlEpoch: 1, state: 'connecting', message: null });
    children[0]!.emit({ type: 'status', accountId: 'fenced', workerInstanceId: 'old', controlEpoch: 1, state: 'ready', message: null });
    await Promise.resolve();
    await gateway.start('fenced', { accountId: 'fenced', workerInstanceId: 'new', controlEpoch: 1, mode: 'MONITOR_ONLY' });
    releaseFirst();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(events).toEqual(['old:connecting']);
    await gateway.shutdown();
  });

  it('retires a worker when its bounded domain event queue overflows', async () => {
    const child = new FakeChild();
    const gateway = createUtilityWorkerGateway({ spawn: () => child, pollIntervalMs: 60_000 });
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve; });
    gateway.onEvent(async (_instance, event) => { if (event.type === 'status' && event.state === 'connecting') await firstGate; });
    await gateway.start('bounded', { accountId: 'bounded', workerInstanceId: 'bounded-worker', controlEpoch: 1, mode: 'MONITOR_ONLY' });
    for (let index = 0; index < 257; index += 1) child.emit({ type: 'status', accountId: 'bounded', workerInstanceId: 'bounded-worker',
      controlEpoch: 1, state: index === 0 ? 'connecting' : 'ready', message: null });
    await new Promise((resolve) => setTimeout(resolve, 0));
    await expect(gateway.binding('bounded')).resolves.toBeNull();
    releaseFirst();
    await gateway.shutdown();
  });

  it('restarts a crashed worker with its persisted nonzero cursor and ignores the retired child', async () => {
    vi.useFakeTimers();
    const children: FakeChild[] = [];
    const gateway = createUtilityWorkerGateway({ spawn: () => { const child = new FakeChild(); children.push(child); return child; },
      durableCursor: async () => ({ version: 1, revision: '9', globalRev: '8', individualRev: '7' }), restartDelayMs: 50, pollIntervalMs: 60_000 });
    const events: string[] = [];
    gateway.onEvent(async (_instance, event) => { events.push(event.type); });
    const binding = { accountId: 'a', workerInstanceId: 'wa', controlEpoch: 3, mode: 'MONITOR_ONLY' as const };
    await gateway.start('a', binding);
    children[0]!.crash();
    await vi.advanceTimersByTimeAsync(50);
    expect(children).toHaveLength(2);
    expect(children[1]!.posted[0]).toMatchObject({ type: 'init', durableCursor: { revision: '9', globalRev: '8', individualRev: '7' } });
    children[0]!.emit({ type: 'status', accountId: 'a', workerInstanceId: 'wa', controlEpoch: 3, state: 'ready', message: null });
    await Promise.resolve();
    expect(events).toEqual([]);
    await gateway.shutdown();
    vi.useRealTimers();
  });

  it('kills a worker when persistence rejects its binding', async () => {
    const child = new FakeChild();
    const gateway = createUtilityWorkerGateway({ spawn: () => child, pollIntervalMs: 60_000 });
    gateway.onBinding!(async () => { throw new Error('binding rejected'); });
    await expect(gateway.start('a', { accountId: 'a', workerInstanceId: 'wa', controlEpoch: 1, mode: 'MONITOR_ONLY' })).rejects.toThrow('binding rejected');
    await expect(gateway.binding('a')).resolves.toBeNull();
  });

  it('fails closed when the persisted event handler rejects', async () => {
    const child = new FakeChild();
    const gateway = createUtilityWorkerGateway({ spawn: () => child, pollIntervalMs: 60_000 });
    gateway.onEvent(async () => { throw new Error('database unavailable'); });
    await gateway.start('a', { accountId: 'a', workerInstanceId: 'wa', controlEpoch: 1, mode: 'MONITOR_ONLY' });
    child.emit({ type: 'status', accountId: 'a', workerInstanceId: 'wa', controlEpoch: 1, state: 'ready', message: null });
    await new Promise((resolve) => setTimeout(resolve, 0));
    await expect(gateway.binding('a')).resolves.toBeNull();
  });

  it('restarts under the configured policy after a transient event persistence failure', async () => {
    vi.useFakeTimers();
    const children: FakeChild[] = [];
    const gateway = createUtilityWorkerGateway({
      spawn: () => { const child = new FakeChild(); children.push(child); return child; },
      restartDelayMs: 5, maxRestarts: 1, pollIntervalMs: 60_000,
    });
    gateway.onEvent(async () => { throw new Error('temporary database outage'); });
    try {
      await gateway.start('a', { accountId: 'a', workerInstanceId: 'wa', controlEpoch: 1, mode: 'MONITOR_ONLY' });
      children[0]!.emit({ type: 'status', accountId: 'a', workerInstanceId: 'wa', controlEpoch: 1, state: 'ready', message: null });
      await vi.advanceTimersByTimeAsync(0);
      expect(await gateway.binding('a')).toBeNull();
      expect(await gateway.health?.()).toMatchObject({ status: 'degraded', message: 'LINE worker restarting' });
      await vi.advanceTimersByTimeAsync(5);
      expect(children).toHaveLength(2);
      expect((await gateway.binding('a'))?.mode).toBe('MONITOR_ONLY');
      expect(await gateway.health?.()).toMatchObject({ status: 'degraded', message: 'LINE worker awaiting acknowledgement' });
    } finally {
      await gateway.shutdown();
      vi.useRealTimers();
    }
  });
});
