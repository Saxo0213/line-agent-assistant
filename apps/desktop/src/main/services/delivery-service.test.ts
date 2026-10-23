import { describe, expect, it } from 'vitest';
import type { ClaimedLineDelivery } from '../../../../../packages/database/src/agent-repository.js';
import { DeliveryService, splitDeliveryText } from './delivery-service.js';

describe('delivery composition', () => {
  it('splits long output deterministically and balances code fences', () => {
    const source = '```ts\n' + 'x'.repeat(120) + '\n```';
    const parts = splitDeliveryText(source, 60);
    expect(parts.length).toBeGreaterThan(1);
    expect(parts.every((part) => part.length <= 60)).toBe(true);
    expect(parts.every((part) => (part.match(/```/g) ?? []).length % 2 === 0)).toBe(true);
    expect(parts.join('').replaceAll('```ts\n', '').replaceAll('\n```', '')).toContain('x'.repeat(120));
  });
  it('balances a code fence embedded between prose sections', () => {
    const parts = splitDeliveryText('before\n```ts\n' + 'x'.repeat(120) + '\n```\nafter', 60);
    expect(parts.every((part) => part.length <= 60)).toBe(true);
    expect(parts.every((part) => (part.match(/```/g) ?? []).length % 2 === 0)).toBe(true);
  });
  it('uses authoritative delivery key, serializes sends per account and never retries unknown', async () => {
    const claimed: ClaimedLineDelivery = { deliveryId: 'd', jobId: 'j', partIndex: 0, text: 'answer', idempotencyKey: 'j:0',
      status: 'sending', lineMessageId: null, accountId: 'account', chatType: 'group', chatId: 'real-chat', controlEpoch: 4 };
    let claimCount = 0; let unknownCount = 0;
    const repository = {
      async getJob() { return { jobId: 'j', accountId: 'account', chatType: 'group' as const, chatId: 'real-chat',
        provider: 'codex' as const, prompt: 'work', workspacePath: 'C:\\trusted', generation: 0, status: 'completed' as const,
        sourceType: 'line' as const, sourceMessageId: 'm', sourceRequestId: null, creationEpoch: 4 }; },
      async listDeliveries() { return [{ ...claimed, status: 'pending' as const }]; },
      async claimLineDelivery() { claimCount++; return claimCount === 1 ? claimed : null; },
      async markDeliveryUnknown() { unknownCount++; return true; }, async markDeliverySent() { throw new Error('must not mark sent'); },
    };
    const commands: unknown[] = [];
    const service = new DeliveryService(repository, {
      async binding() { return { accountId: 'account', workerInstanceId: 'instance', controlEpoch: 4, mode: 'ACTIVE_CONTROL' as const }; },
      async send(command) { commands.push(command); return { type: 'sendResult' as const, accountId: 'account', workerInstanceId: 'instance', controlEpoch: 4,
        requestId: command.requestId, status: 'unknown' as const, messageId: null, error: null }; },
    });
    await service.deliverCompletedJob('j');
    await service.deliverCompletedJob('j');
    expect(commands).toMatchObject([{ type: 'sendText', accountId: 'account', chatType: 'group', chatId: 'real-chat', text: 'answer' }]);
    expect(unknownCount).toBe(1);
  });

  it('retries durable pending delivery after a worker binding appears', async () => {
    const claimed: ClaimedLineDelivery = { deliveryId: 'd', jobId: 'j', partIndex: 0, text: 'answer', idempotencyKey: 'j:0',
      status: 'sending', lineMessageId: null, accountId: 'account', chatType: 'group', chatId: 'real-chat', controlEpoch: 4 };
    let binding: { accountId: string; workerInstanceId: string; controlEpoch: number; mode: 'ACTIVE_CONTROL' } | null = null;
    let deliveryStatus: 'pending' | 'sent' = 'pending'; let sendCalls = 0;
    const repository = {
      async getJob() { return { jobId: 'j', accountId: 'account', chatType: 'group' as const, chatId: 'real-chat',
        provider: 'codex' as const, prompt: 'work', workspacePath: 'C:\\trusted', generation: 0, status: 'completed' as const,
        sourceType: 'line' as const, sourceMessageId: 'm', sourceRequestId: null, creationEpoch: 4 }; },
      async listDeliveries() { return [{ ...claimed, status: deliveryStatus }]; },
      async listPendingLineDeliveryJobs(accountId: string) { return accountId === 'account' && deliveryStatus === 'pending' ? ['j'] : []; },
      async claimLineDelivery() { return deliveryStatus === 'pending' ? claimed : null; },
      async markDeliveryUnknown() { throw new Error('binding recovery must not mark unknown'); },
      async markDeliverySent() { deliveryStatus = 'sent'; return true; },
    };
    const service = new DeliveryService(repository, {
      async binding() { return binding; },
      async send(command) {
        sendCalls++;
        return { type: 'sendResult' as const, accountId: 'account', workerInstanceId: command.workerInstanceId,
          controlEpoch: command.controlEpoch, requestId: command.requestId, status: 'sent' as const, messageId: 'line-message', error: null };
      },
    });

    await service.deliverCompletedJob('j');
    binding = { accountId: 'account', workerInstanceId: 'instance', controlEpoch: 4, mode: 'ACTIVE_CONTROL' };
    await service.recoverPending('account');

    expect(sendCalls).toBe(1);
    expect(deliveryStatus).toBe('sent');
  });

  it('does not claim a pending delivery until the worker acknowledges ACTIVE_CONTROL', async () => {
    const claimed: ClaimedLineDelivery = { deliveryId: 'd', jobId: 'j', partIndex: 0, text: 'answer', idempotencyKey: 'j:0',
      status: 'sending', lineMessageId: null, accountId: 'account', chatType: 'group', chatId: 'real-chat', controlEpoch: 4 };
    let acknowledged = false;
    let status: 'pending' | 'sending' | 'sent' = 'pending';
    let claimCalls = 0;
    const repository = {
      async getJob() { return { jobId: 'j', accountId: 'account', chatType: 'group' as const, chatId: 'real-chat',
        provider: 'codex' as const, prompt: 'work', workspacePath: 'C:\\trusted', generation: 0, status: 'completed' as const,
        sourceType: 'line' as const, sourceMessageId: 'm', sourceRequestId: null, creationEpoch: 4 }; },
      async listDeliveries() { return [{ ...claimed, status }]; },
      async listPendingLineDeliveryJobs() { return status === 'pending' ? ['j'] : []; },
      async claimLineDelivery() { claimCalls++; status = 'sending'; return claimed; },
      async markDeliveryUnknown() { throw new Error('pre-ack must not claim'); },
      async markDeliverySent() { status = 'sent'; return true; },
    };
    let sendCalls = 0;
    const service = new DeliveryService(repository, {
      async binding() { return { accountId: 'account', workerInstanceId: 'instance', controlEpoch: 4, mode: 'ACTIVE_CONTROL' as const }; },
      async waitModeAck() { return acknowledged; },
      async send(command) { sendCalls++; return { type: 'sendResult' as const, accountId: 'account', workerInstanceId: command.workerInstanceId,
        controlEpoch: command.controlEpoch, requestId: command.requestId, status: 'sent' as const, messageId: 'line-message', error: null }; },
    });

    await service.recoverPending('account');
    expect({ status, claimCalls, sendCalls }).toEqual({ status: 'pending', claimCalls: 0, sendCalls: 0 });
    acknowledged = true;
    await service.recoverPending('account');
    expect({ status, claimCalls, sendCalls }).toEqual({ status: 'sent', claimCalls: 1, sendCalls: 1 });
  });

  it('coalesces recovery bursts, batches scans and drains owned work on shutdown', async () => {
    let releaseA!: () => void;
    const gateA = new Promise<void>((resolve) => { releaseA = resolve; });
    const scanCalls = new Map<string, number>();
    let activeScans = 0;
    let maxActiveScans = 0;
    let releaseSend!: () => void;
    const sendGate = new Promise<void>((resolve) => { releaseSend = resolve; });
    let includeJob = false;
    let activeSends = 0;
    let maxActiveSends = 0;
    let sendCalls = 0;
    let announceSend!: () => void;
    const sendStarted = new Promise<void>((resolve) => { announceSend = resolve; });
    const repository = {
      async getJob(jobId: string) { return { jobId, accountId: jobId.startsWith('a-') ? 'a' : 'b', chatType: 'group' as const, chatId: 'chat',
        provider: 'codex' as const, prompt: 'work', workspacePath: 'C:\\trusted', generation: 0, status: 'completed' as const,
        sourceType: 'line' as const, sourceMessageId: 'm', sourceRequestId: null, creationEpoch: 4 }; },
      async listDeliveries(jobId: string) { return [{ deliveryId: jobId, jobId, partIndex: 0, text: 'answer', idempotencyKey: `${jobId}:0`,
        status: 'pending' as const, lineMessageId: null }]; },
      async listPendingLineDeliveryJobs(accountId: string, afterJobId?: string, limit = 32) {
        scanCalls.set(accountId, (scanCalls.get(accountId) ?? 0) + 1);
        activeScans++; maxActiveScans = Math.max(maxActiveScans, activeScans);
        try {
          if (accountId === 'a' && !afterJobId) await gateA;
          return afterJobId || !includeJob ? [] : [{ job_id: `${accountId}-job` }].slice(0, limit).map((row) => row.job_id);
        } finally { activeScans--; }
      },
      async claimLineDelivery(jobId: string) { return { deliveryId: jobId, jobId, partIndex: 0, text: 'answer', idempotencyKey: `${jobId}:0`,
        status: 'sending' as const, lineMessageId: null, accountId: jobId.startsWith('a-') ? 'a' : 'b', chatType: 'group' as const, chatId: 'chat', controlEpoch: 4 }; },
      async markDeliveryUnknown() { return true; }, async markDeliverySent() { return true; },
    };
    const service = new DeliveryService(repository, {
      async binding(accountId) { return { accountId, workerInstanceId: `worker-${accountId}`, controlEpoch: 4, mode: 'ACTIVE_CONTROL' as const }; },
      async send(_command, signal) {
        sendCalls++; activeSends++; maxActiveSends = Math.max(maxActiveSends, activeSends);
        announceSend();
        try {
          await new Promise<void>((resolve, reject) => {
            const abort = () => reject(new Error('cancelled'));
            signal?.addEventListener('abort', abort, { once: true });
            sendGate.then(resolve, reject);
          });
          throw new Error('send should be cancelled at shutdown');
        } finally { activeSends--; }
      },
    });

    const a = service.recoverPending('a');
    const repeated = Array.from({ length: 100 }, () => service.recoverPending('a'));
    const b = service.recoverPending('b');
    await expect(b).resolves.toBeUndefined();
    expect(scanCalls.get('b')).toBe(1);
    releaseA();
    await Promise.all([a, ...repeated]);
    expect(scanCalls.get('a')).toBe(2);
    expect(maxActiveScans).toBeLessThanOrEqual(2);

    includeJob = true;
    const shutdownScan = service.recoverPending('b');
    await sendStarted;
    const shutdown = service.shutdown();
    await Promise.all([shutdownScan, shutdown]);
    releaseSend();
    expect({ sendCalls, maxActiveSends }).toEqual({ sendCalls: 1, maxActiveSends: 1 });
  });

  it('retains overflowed distinct-account recovery with one bounded global scan', async () => {
    let releaseScans!: () => void;
    const scansGate = new Promise<void>((resolve) => { releaseScans = resolve; });
    let announceInitialScans!: () => void;
    const initialScansStarted = new Promise<void>((resolve) => { announceInitialScans = resolve; });
    const scannedAccounts = new Set<string>();
    let activeScans = 0;
    let maxActiveScans = 0;
    const repository = {
      async listPendingLineDeliveryJobs(accountId?: string) {
        scannedAccounts.add(accountId ?? '*');
        activeScans++;
        maxActiveScans = Math.max(maxActiveScans, activeScans);
        if (activeScans === 4) announceInitialScans();
        try { if (accountId !== undefined) await scansGate; return []; }
        finally { activeScans--; }
      },
    };
    const service = new DeliveryService(repository as never, {} as never);
    const requests = Array.from({ length: 100 }, (_, index) => service.recoverPending(`account-${index}`));

    await initialScansStarted;
    releaseScans();
    await Promise.all(requests);

    expect(scannedAccounts.has('*')).toBe(true);
    expect(maxActiveScans).toBeLessThanOrEqual(4);
    await service.shutdown();
  });

  it('rediscovers deferred send-account overflow after bounded per-account reservations fill', async () => {
    let releaseSends!: () => void;
    const sendsGate = new Promise<void>((resolve) => { releaseSends = resolve; });
    let announceInitialSends!: () => void;
    const initialSendsStarted = new Promise<void>((resolve) => { announceInitialSends = resolve; });
    let announceWildcardScan!: () => void;
    const wildcardScanStarted = new Promise<void>((resolve) => { announceWildcardScan = resolve; });
    const jobs = new Map<string, 'pending' | 'sent'>();
    let activeSends = 0;
    let maxActiveSends = 0;
    const repository = {
      async getJob(jobId: string) {
        return { jobId, accountId: jobId, chatType: 'direct' as const, chatId: 'chat', provider: 'codex' as const,
          prompt: 'work', workspacePath: 'C:\\trusted', generation: 0, status: 'completed' as const,
          sourceType: 'line' as const, sourceMessageId: jobId, sourceRequestId: null, creationEpoch: 4 };
      },
      async listDeliveries(jobId: string) {
        return [{ deliveryId: jobId, jobId, partIndex: 0, text: 'answer', idempotencyKey: `${jobId}:0`,
          status: jobs.get(jobId) === 'sent' ? 'sent' as const : 'pending' as const, lineMessageId: null }];
      },
      async claimLineDelivery(jobId: string) {
        if (jobs.get(jobId) === 'sent') return null;
        jobs.set(jobId, 'sent');
        return { deliveryId: jobId, jobId, partIndex: 0, text: 'answer', idempotencyKey: `${jobId}:0`, status: 'sending' as const,
          lineMessageId: null, accountId: jobId, chatType: 'direct' as const, chatId: 'chat', controlEpoch: 4 };
      },
      async markDeliverySent() { return true; },
      async markDeliveryUnknown() { return true; },
      async listPendingLineDeliveryJobs(accountId?: string) { if (!accountId) announceWildcardScan(); return []; },
    };
    const service = new DeliveryService(repository as never, {
      async binding(accountId: string) { return { accountId, workerInstanceId: `worker-${accountId}`, controlEpoch: 4, mode: 'ACTIVE_CONTROL' as const }; },
      async send(command: { accountId: string }) {
        activeSends++;
        maxActiveSends = Math.max(maxActiveSends, activeSends);
        if (activeSends === 4) announceInitialSends();
        try {
          await sendsGate;
          return { type: 'sendResult' as const, accountId: command.accountId, workerInstanceId: `worker-${command.accountId}`,
            controlEpoch: 4, requestId: 'request', status: 'sent' as const, messageId: 'line-id', error: null };
        } finally { activeSends--; }
      },
    });
    const jobsToDeliver = Array.from({ length: 100 }, (_, index) => `send-account-${index}`);
    const deliveries = Promise.all(jobsToDeliver.map((jobId) => {
      jobs.set(jobId, 'pending');
      return service.deliverCompletedJob(jobId);
    }));

    await initialSendsStarted;
    releaseSends();
    await deliveries;
    await wildcardScanStarted;

    expect(maxActiveSends).toBeLessThanOrEqual(4);
    await service.shutdown();
  });

  it('continues past offline deferred accounts and actually delivers later ready accounts', async () => {
    let releaseHeldSends!: () => void;
    const heldSends = new Promise<void>((resolve) => { releaseHeldSends = resolve; });
    let announceInitialSends!: () => void;
    const initialSendsStarted = new Promise<void>((resolve) => { announceInitialSends = resolve; });
    let announceAllReadyDelivered!: () => void;
    const allReadyDelivered = new Promise<void>((resolve) => { announceAllReadyDelivered = resolve; });
    const delivered = new Set<string>();
    const scannedAccounts: string[] = [];
    const bindingChecks = new Map<string, number>();
    let activeSends = 0;
    const repository = {
      async getJob(jobId: string) {
        return { jobId, accountId: jobId, chatType: 'direct' as const, chatId: 'chat', provider: 'codex' as const,
          prompt: 'work', workspacePath: 'C:\\trusted', generation: 0, status: 'completed' as const,
          sourceType: 'line' as const, sourceMessageId: jobId, sourceRequestId: null, creationEpoch: 4 };
      },
      async listDeliveries(jobId: string) {
        return [{ deliveryId: jobId, jobId, partIndex: 0, text: 'answer', idempotencyKey: `${jobId}:0`,
          status: 'pending' as const, lineMessageId: null }];
      },
      async claimLineDelivery(jobId: string) {
        return { deliveryId: jobId, jobId, partIndex: 0, text: 'answer', idempotencyKey: `${jobId}:0`, status: 'sending' as const,
          lineMessageId: null, accountId: jobId, chatType: 'direct' as const, chatId: 'chat', controlEpoch: 4 };
      },
      async markDeliverySent(jobId: string) {
        delivered.add(jobId);
        if ([...delivered].filter((value) => value.startsWith('ready-')).length === 4) announceAllReadyDelivered();
        return true;
      },
      async markDeliveryUnknown() { return true; },
      async listPendingLineDeliveryJobs(accountId?: string) {
        scannedAccounts.push(accountId ?? '*');
        return accountId?.startsWith('ready-') ? [accountId] : [];
      },
    };
    const service = new DeliveryService(repository as never, {
      async binding(accountId: string) {
        const checks = (bindingChecks.get(accountId) ?? 0) + 1;
        bindingChecks.set(accountId, checks);
        if (/^offline-/.test(accountId) && checks > 1) return null;
        return { accountId, workerInstanceId: `worker-${accountId}`, controlEpoch: 4, mode: 'ACTIVE_CONTROL' as const };
      },
      async send(command: { accountId: string; workerInstanceId: string; requestId: string }) {
        if (/^held-/.test(command.accountId)) {
          activeSends++;
          if (activeSends === 4) announceInitialSends();
          try { await heldSends; }
          finally { activeSends--; }
        }
        return { type: 'sendResult' as const, accountId: command.accountId, workerInstanceId: command.workerInstanceId,
          controlEpoch: 4, requestId: command.requestId, status: 'sent' as const, messageId: `line-${command.accountId}`, error: null };
      },
    });
    const jobIds = [
      ...Array.from({ length: 4 }, (_, index) => `held-${index}`),
      ...Array.from({ length: 4 }, (_, index) => `offline-${index}`),
      ...Array.from({ length: 4 }, (_, index) => `ready-${index}`),
    ];
    const heldCalls = jobIds.slice(0, 4).map((jobId) => service.deliverCompletedJob(jobId));
    await initialSendsStarted;
    for (const jobId of jobIds.slice(4)) await service.deliverCompletedJob(jobId);
    releaseHeldSends();
    await Promise.all(heldCalls);
    let readinessTimeout!: ReturnType<typeof setTimeout>;
    const readyDelivered = await Promise.race([
      allReadyDelivered.then(() => true),
      new Promise<boolean>((resolve) => { readinessTimeout = setTimeout(() => resolve(false), 1000); }),
    ]);
    clearTimeout(readinessTimeout);

    expect(scannedAccounts).toEqual(expect.arrayContaining(['offline-0', 'offline-1', 'offline-2', 'offline-3']));
    expect([...delivered].filter((jobId) => jobId.startsWith('ready-')).sort()).toEqual(['ready-0', 'ready-1', 'ready-2', 'ready-3']);
    expect(readyDelivered).toBe(true);
    await service.shutdown();
  });

  it('advances deferred account recovery past empty and unready scopes after sends drain', async () => {
    let releaseBaseSends!: () => void;
    const baseSendGate = new Promise<void>((resolve) => { releaseBaseSends = resolve; });
    let releaseReadySend!: () => void;
    const readySendGate = new Promise<void>((resolve) => { releaseReadySend = resolve; });
    let announceBaseSends!: () => void;
    const baseSendsStarted = new Promise<void>((resolve) => { announceBaseSends = resolve; });
    let announceReadySend!: () => void;
    const readySendStarted = new Promise<void>((resolve) => { announceReadySend = resolve; });
    const deferredAccounts = ['empty-first', 'unready-second', 'empty-third', 'empty-fourth', 'ready-last'];
    const jobAccount = new Map<string, string>();
    const scans: string[] = [];
    let baseSendCount = 0;
    let unready = false;
    const sentJobs = new Set<string>();
    const repository = {
      async getJob(jobId: string) {
        const accountId = jobAccount.get(jobId)!;
        return { jobId, accountId, chatType: 'direct' as const, chatId: accountId, provider: 'codex' as const,
          prompt: 'work', workspacePath: 'C:\\trusted', generation: 0, status: 'completed' as const,
          sourceType: 'line' as const, sourceMessageId: jobId, sourceRequestId: null, creationEpoch: 4 };
      },
      async listDeliveries(jobId: string) {
        return [{ deliveryId: jobId, jobId, partIndex: 0, text: 'answer', idempotencyKey: `${jobId}:0`,
          status: sentJobs.has(jobId) ? 'sent' as const : 'pending' as const, lineMessageId: null }];
      },
      async claimLineDelivery(jobId: string) {
        const accountId = jobAccount.get(jobId)!;
        if (sentJobs.has(jobId)) return null;
        sentJobs.add(jobId);
        return { deliveryId: jobId, jobId, partIndex: 0, text: 'answer', idempotencyKey: `${jobId}:0`, status: 'sending' as const,
          lineMessageId: null, accountId, chatType: 'direct' as const, chatId: accountId, controlEpoch: 4 };
      },
      async markDeliverySent() { return true; }, async markDeliveryUnknown() { return true; },
      async listPendingLineDeliveryJobs(accountId?: string) {
        if (!accountId) return [];
        scans.push(accountId);
        if (accountId.startsWith('empty-')) return [];
        return [`job-${accountId}`];
      },
    };
    const service = new DeliveryService(repository as never, {
      async binding(accountId: string) {
        if (accountId === 'unready-second' && unready) return null;
        return { accountId, workerInstanceId: `worker-${accountId}`, controlEpoch: 4, mode: 'ACTIVE_CONTROL' as const };
      },
      async send(command: { accountId: string; workerInstanceId: string; controlEpoch: number; requestId: string }) {
        if (command.accountId.startsWith('base-')) {
          baseSendCount++;
          if (baseSendCount === 4) announceBaseSends();
          await baseSendGate;
        } else if (command.accountId === 'ready-last') {
          announceReadySend();
          await readySendGate;
        }
        return { type: 'sendResult' as const, accountId: command.accountId, workerInstanceId: command.workerInstanceId,
          controlEpoch: command.controlEpoch, requestId: command.requestId, status: 'sent' as const, messageId: 'line-id', error: null };
      },
    });
    const baseJobs = Array.from({ length: 4 }, (_, index) => `job-base-${index}`);
    for (const jobId of baseJobs) jobAccount.set(jobId, jobId.replace('job-', ''));
    const basePromises = baseJobs.map((jobId) => service.deliverCompletedJob(jobId));
    const baseStartedOnTime = await Promise.race([baseSendsStarted.then(() => true), new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 250))]);
    expect({ baseStartedOnTime, baseSendCount }).toEqual({ baseStartedOnTime: true, baseSendCount: 4 });
    for (const accountId of deferredAccounts) jobAccount.set(`job-${accountId}`, accountId);
    await Promise.all(deferredAccounts.map((accountId) => service.deliverCompletedJob(`job-${accountId}`)));
    unready = true;

    releaseBaseSends();
    await Promise.all(basePromises);
    const readyStartedOnTime = await Promise.race([readySendStarted.then(() => true), new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 250))]);
    expect(readyStartedOnTime).toBe(true);
    expect(scans).toEqual(deferredAccounts);
    releaseReadySend();
    await service.shutdown();
  });

  it('does not rescan an account with an active send and resumes its deferred job when that send releases', async () => {
    let releaseA1!: () => void;
    let releaseB1!: () => void;
    let announceA1!: () => void;
    let announceB1!: () => void;
    let announceA2!: () => void;
    const a1Gate = new Promise<void>((resolve) => { releaseA1 = resolve; });
    const b1Gate = new Promise<void>((resolve) => { releaseB1 = resolve; });
    const a1Started = new Promise<void>((resolve) => { announceA1 = resolve; });
    const b1Started = new Promise<void>((resolve) => { announceB1 = resolve; });
    const a2Started = new Promise<void>((resolve) => { announceA2 = resolve; });
    const jobs = new Map([['a1', 'account-a'], ['a2', 'account-a'], ['b1', 'account-b']]);
    const sent = new Set<string>();
    let accountAScans = 0;
    const repository = {
      async getJob(jobId: string) {
        const accountId = jobs.get(jobId)!;
        return { jobId, accountId, chatType: 'direct' as const, chatId: jobId, provider: 'codex' as const,
          prompt: 'work', workspacePath: 'C:\\trusted', generation: 0, status: 'completed' as const,
          sourceType: 'line' as const, sourceMessageId: jobId, sourceRequestId: null, creationEpoch: 4 };
      },
      async listDeliveries(jobId: string) {
        return [{ deliveryId: jobId, jobId, partIndex: 0, text: 'answer', idempotencyKey: `${jobId}:0`,
          status: sent.has(jobId) ? 'sent' as const : 'pending' as const, lineMessageId: null }];
      },
      async claimLineDelivery(jobId: string) {
        if (sent.has(jobId)) return null;
        sent.add(jobId);
        const accountId = jobs.get(jobId)!;
        return { deliveryId: jobId, jobId, partIndex: 0, text: 'answer', idempotencyKey: `${jobId}:0`, status: 'sending' as const,
          lineMessageId: null, accountId, chatType: 'direct' as const, chatId: jobId, controlEpoch: 4 };
      },
      async markDeliverySent() { return true; }, async markDeliveryUnknown() { return true; },
      async listPendingLineDeliveryJobs(accountId?: string) {
        if (accountId === 'account-a') {
          accountAScans++;
          await new Promise((resolve) => setTimeout(resolve, 1));
          return sent.has('a2') ? [] : ['a2'];
        }
        return [];
      },
    };
    const service = new DeliveryService(repository as never, {
      async binding(accountId: string) { return { accountId, workerInstanceId: `worker-${accountId}`, controlEpoch: 4, mode: 'ACTIVE_CONTROL' as const }; },
      async send(command: { accountId: string; workerInstanceId: string; controlEpoch: number; requestId: string; chatId: string }) {
        if (command.chatId === 'a1') { announceA1(); await a1Gate; }
        if (command.chatId === 'b1') { announceB1(); await b1Gate; }
        if (command.chatId === 'a2') announceA2();
        return { type: 'sendResult' as const, accountId: command.accountId, workerInstanceId: command.workerInstanceId,
          controlEpoch: command.controlEpoch, requestId: command.requestId, status: 'sent' as const, messageId: 'line-id', error: null };
      },
    });

    const a1 = service.deliverCompletedJob('a1');
    await a1Started;
    await service.deliverCompletedJob('a2');
    const b1 = service.deliverCompletedJob('b1');
    await b1Started;
    releaseB1();
    await b1;
    await new Promise((resolve) => setTimeout(resolve, 25));
    const scansWhileA1Active = accountAScans;
    releaseA1();
    await a1;
    await a2Started;
    await service.shutdown();

    expect(scansWhileA1Active).toBe(0);
    expect(accountAScans).toBeGreaterThan(0);
  });
});
