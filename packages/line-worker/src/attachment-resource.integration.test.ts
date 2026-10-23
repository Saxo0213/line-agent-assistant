import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { afterEach, expect, it, vi } from 'vitest';
import { createLinejsAdapter } from './linejs-adapter.js';
import { LineWorkerLoop, type LineTransport } from './worker-loop.js';

const lease = { accountId: 'resource-account', workerInstanceId: 'resource-worker', controlEpoch: 1 };
const protocolVersion = 4 as const;
const cursor = { version: 1 as const, revision: '0', globalRev: '0', individualRev: '0' };
const ownMid = `u${'a'.repeat(32)}`;
const peerMid = `u${'b'.repeat(32)}`;
const chatId = `c${'c'.repeat(32)}`;
const jwt = [Buffer.from('{"alg":"HS256"}').toString('base64url'),
  Buffer.from(JSON.stringify({ sub: ownMid })).toString('base64url'), 'signature'].join('.');
const temporary: string[] = [];
const nativeSetTimeout = globalThis.setTimeout.bind(globalThis);
const nativeClearTimeout = globalThis.clearTimeout.bind(globalThis);
afterEach(async () => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  for (const path of temporary.splice(0)) await rm(path, { recursive: true, force: true });
});

type Scenario = 'success' | 'retry' | 'cancel';
type ScenarioState = { scenario: Scenario; preflights: number; waitingForRetry: boolean };

function makeTrackedResponse(bytes: Uint8Array, stats: { activeReaders: number; streamsOpened: number; streamsClosed: number },
  status = 200, holdOpen = false): Response {
  stats.activeReaders += 1;
  stats.streamsOpened += 1;
  let open = true;
  const close = () => {
    if (!open) return;
    open = false;
    stats.activeReaders -= 1;
    stats.streamsClosed += 1;
  };
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      if (holdOpen) return;
      controller.enqueue(bytes);
      controller.close();
      close();
    },
    cancel() { close(); },
  });
  return new Response(body, { status });
}

function uuid(counter: number): string {
  return `00000000-0000-4000-8000-${String(counter).padStart(12, '0')}`;
}

async function yieldUntil(predicate: () => boolean, realSetTimeout: typeof setTimeout): Promise<void> {
  for (let attempt = 0; attempt < 2_000; attempt += 1) {
    if (predicate()) return;
    await new Promise<void>((resolve) => realSetTimeout(resolve, 1));
  }
  throw new Error('offline attachment resource workload did not make progress');
}

it('returns offline production-adapter resources to baseline after idle, repeated bursts, retry, and cancellation', async () => {
  const activeTimers = new Set<ReturnType<typeof setTimeout>>();
  const setTimerSpy = vi.spyOn(globalThis, 'setTimeout').mockImplementation(((callback: TimerHandler,
    timeout?: number, ...args: unknown[]) => {
    let handle: ReturnType<typeof setTimeout>;
    const wrapped = () => {
      activeTimers.delete(handle);
      if (typeof callback === 'function') callback(...args);
    };
    handle = nativeSetTimeout(wrapped, timeout, ...args);
    activeTimers.add(handle);
    return handle;
  }) as typeof globalThis.setTimeout);
  const clearTimerSpy = vi.spyOn(globalThis, 'clearTimeout').mockImplementation(((handle: ReturnType<typeof setTimeout>) => {
    activeTimers.delete(handle);
    return nativeClearTimeout(handle);
  }) as typeof globalThis.clearTimeout);
  const tokenModule = await import(new URL('../../../node_modules/@evex/linejs/base/service/talk/mod.js', import.meta.url).href) as {
    TalkService: { prototype: { acquireEncryptedAccessToken: (...args: any[]) => Promise<string> } };
  };
  const tokenRpc = vi.spyOn(tokenModule.TalkService.prototype, 'acquireEncryptedAccessToken')
    .mockResolvedValue('3600\u001eoffline-resource-token');
  const root = await mkdtemp(join(tmpdir(), 'linejs-resource-workload-'));
  temporary.push(root);

  const stats = { activeRequests: 0, peakRequests: 0, activeReaders: 0, streamsOpened: 0, streamsClosed: 0,
    activeAdapterDownloads: 0, peakAdapterDownloads: 0, abortListeners: 0, commandsSubmitted: 0, commandsSettled: 0,
    pendingQueueCommands: 0, retryResumes: 0 };
  const scenarios = new Map<string, ScenarioState>();
  const adapter = await createLinejsAdapter({ ...lease, mode: 'MONITOR_ONLY', validateLease: () => false,
    physicalTransport: async (request) => {
      stats.activeRequests += 1;
      stats.peakRequests = Math.max(stats.peakRequests, stats.activeRequests);
      try {
        await Promise.resolve();
        const url = new URL(request.url);
        const match = url.pathname.match(/\/m\/([^/]+)/);
        if (!match) throw new Error('unexpected controlled request path');
        const state = scenarios.get(match[1]!);
        if (!state) throw new Error('request missing offline scenario binding');
        if (url.pathname.endsWith('/object_info.obs')) {
          if (state.waitingForRetry) { state.waitingForRetry = false; stats.retryResumes += 1; }
          state.preflights += 1;
          if (state.scenario === 'retry' && state.preflights === 1) {
            state.waitingForRetry = true;
            return makeTrackedResponse(Buffer.from('{"status":"exist","encodeStatus":"ing"}'), stats);
          }
          if (state.scenario === 'retry' && state.preflights === 2) {
            state.waitingForRetry = true;
            return makeTrackedResponse(new Uint8Array([0]), stats, 202, true);
          }
          if (state.scenario === 'cancel' && state.preflights === 1) {
            state.waitingForRetry = true;
            return makeTrackedResponse(Buffer.from('{"status":"exist","encodeStatus":"ing"}'), stats);
          }
          return makeTrackedResponse(Buffer.from('{"status":"exist","encodeStatus":"done"}'), stats);
        }
        return makeTrackedResponse(Buffer.from(`offline-bytes-${match[1]}`), stats);
      } finally { stats.activeRequests -= 1; }
    } });
  await adapter.installSecrets({ token: jwt, qrCert: null, e2eeStorage: null });

  const transport = new Proxy(adapter as LineTransport, { get(target, property) {
    if (property === 'loginQr') return async () => ({ ownMid, displayName: 'Offline fixture' });
    if (property === 'download') return async (...args: Parameters<LineTransport['download']>) => {
      const options = args[4];
      stats.activeAdapterDownloads += 1;
      stats.peakAdapterDownloads = Math.max(stats.peakAdapterDownloads, stats.activeAdapterDownloads);
      const signal = options.signal;
      const add = signal.addEventListener.bind(signal);
      const remove = signal.removeEventListener.bind(signal);
      const trackedListeners = new Map<EventListenerOrEventListenerObject, EventListener>();
      const addSpy = vi.spyOn(signal, 'addEventListener').mockImplementation(((type: string,
        listener: EventListenerOrEventListenerObject | null, eventOptions?: boolean | AddEventListenerOptions) => {
        if (type !== 'abort' || typeof listener !== 'function' || listener.name !== 'onAbort') return add(type, listener, eventOptions);
        const wrapped: EventListener = (event) => {
          if (trackedListeners.delete(listener)) stats.abortListeners -= 1;
          if (typeof listener === 'function') listener.call(signal, event);
          else listener.handleEvent(event);
        };
        trackedListeners.set(listener, wrapped);
        stats.abortListeners += 1;
        return add(type, wrapped, eventOptions);
      }) as typeof signal.addEventListener);
      const removeSpy = vi.spyOn(signal, 'removeEventListener').mockImplementation(((type: string,
        listener: EventListenerOrEventListenerObject | null, eventOptions?: boolean | EventListenerOptions) => {
        if (type !== 'abort' || listener === null) return remove(type, listener, eventOptions);
        const wrapped = trackedListeners.get(listener);
        if (wrapped && trackedListeners.delete(listener)) stats.abortListeners -= 1;
        return remove(type, wrapped ?? listener, eventOptions);
      }) as typeof signal.removeEventListener);
      try { return await adapter.download(...args); }
      finally {
        stats.activeAdapterDownloads -= 1;
        addSpy.mockRestore();
        removeSpy.mockRestore();
      }
    };
    const value = Reflect.get(target, property, target) as unknown;
    return typeof value === 'function' ? value.bind(target) : value;
  } });

  const events: any[] = [];
  const worker = new LineWorkerLoop({ transport, emit: (event) => { events.push(event); }, validateLease: () => false,
    attachmentRoot: root, minFreeBytes: 0,
    attachmentRuntime: { unsafeAllowPortableFilesystemOnWindowsForTests: true } });
  const binding = { ...lease, protocolVersion, mode: 'MONITOR_ONLY' as const, durableCursor: cursor };
  await worker.handle({ type: 'init', ...binding });
  await worker.handle({ type: 'loginQr', ...lease, loginAttemptId: 'offline-resource-login' });

  const childProcessesBefore = process.getActiveResourcesInfo?.().filter((resource) => resource === 'ChildProcess').length ?? 0;
  const useGc = (globalThis as typeof globalThis & { gc?: () => void }).gc;
  const collect = async () => { useGc?.(); await Promise.resolve(); };
  await collect();
  const heapSamples: number[] = [];
  const submittedIds: string[] = [];
  let idCounter = 1_000;

  const submit = (scenario: Scenario): { id: string; promise: Promise<void> } => {
    const sequence = idCounter++;
    const messageId = String(sequence);
    scenarios.set(messageId, { scenario, preflights: 0, waitingForRetry: false });
    stats.commandsSubmitted += 1;
    stats.pendingQueueCommands += 1;
    submittedIds.push(messageId);
    const promise = worker.handle({ type: 'downloadAttachment', ...lease, chatType: 'group', chatId,
      requestId: `offline-resource-${sequence}`, attemptToken: uuid(100_000 + sequence),
      attachmentId: uuid(200_000 + sequence), messageId, externalAttachmentId: messageId,
      kind: 'image', occurredAt: '2026-10-18T00:00:00.000Z', originalFileName: 'offline.png',
      lineMessage: { id: messageId, from: peerMid, to: chatId, toType: 2, contentType: 1, contentMetadata: {} },
      maxBytes: 1024, timeoutMs: 30_000 }).then(() => {
      stats.commandsSettled += 1;
      stats.pendingQueueCommands -= 1;
    });
    return { id: messageId, promise };
  };

  const idleSample = async () => {
    await delay(75);
    await collect();
    heapSamples.push(process.memoryUsage().heapUsed);
    expect(stats.activeRequests).toBe(0);
    expect(stats.activeReaders).toBe(0);
    expect(stats.activeAdapterDownloads).toBe(0);
    expect(stats.abortListeners).toBe(0);
    expect(stats.commandsSettled).toBe(stats.commandsSubmitted);
    expect(stats.pendingQueueCommands).toBe(0);
    expect(activeTimers.size).toBe(0);
    expect(process.getActiveResourcesInfo?.().filter((resource) => resource === 'ChildProcess').length ?? 0)
      .toBe(childProcessesBefore);
  };

  try {
    await idleSample();
    for (let burst = 0; burst < 4; burst += 1) {
      const tasks = [submit('success'), submit('retry'), submit('success'), submit('success'), submit('success'), submit('success')];
      const retryTarget = stats.retryResumes + 2;
      while (stats.retryResumes < retryTarget) {
        const resumedBefore = stats.retryResumes;
        await yieldUntil(() => [...scenarios.values()].some((state) => state.waitingForRetry), nativeSetTimeout);
        await delay(2_100);
        await yieldUntil(() => stats.retryResumes > resumedBefore, nativeSetTimeout);
      }
      await Promise.all(tasks.map((task) => task.promise));

      const cancelled = submit('cancel');
      await yieldUntil(() => scenarios.get(cancelled.id)!.waitingForRetry, nativeSetTimeout);
      const cancelCommand = worker.handle({ type: 'cancelAttachmentDownload', ...lease,
        attachmentId: uuid(200_000 + Number(cancelled.id)), attemptToken: uuid(100_000 + Number(cancelled.id)) });
      await Promise.all([cancelled.promise, cancelCommand]);
      await idleSample();
    }

    expect(stats.commandsSubmitted).toBe(28);
    expect(stats.commandsSettled).toBe(28);
    expect(stats.pendingQueueCommands).toBe(0);
    expect(stats.retryResumes).toBe(8);
    expect(stats.peakAdapterDownloads).toBeLessThanOrEqual(2);
    expect(stats.peakRequests).toBeLessThanOrEqual(2);
    expect(stats.streamsOpened).toBe(stats.streamsClosed);
    expect(events.filter((event) => event.type === 'attachmentResult' && event.status === 'ready')).toHaveLength(24);
    expect(events.filter((event) => event.type === 'attachmentResult' && event.error === 'LINE_DOWNLOAD_CANCELLED')).toHaveLength(4);
    expect(submittedIds).toHaveLength(28);
    const allowance = useGc ? 12 * 1024 * 1024 : 32 * 1024 * 1024;
    expect(heapSamples.at(-1)! - heapSamples[0]!).toBeLessThanOrEqual(allowance);
    expect(heapSamples).toHaveLength(5);
    console.info('ATTACHMENT_RESOURCE_EVIDENCE', JSON.stringify({ batches: 4, attempts: 28, attemptsPerBatch: 7,
      postDrainSamples: heapSamples, heapDeltaBytes: heapSamples.at(-1)! - heapSamples[0]!,
      heapAllowanceBytes: allowance, explicitGcAvailable: Boolean(useGc), idleWindowMsPerSample: 75,
      peakPhysicalRequests: stats.peakRequests, peakActiveAdapterDownloads: stats.peakAdapterDownloads,
      streamsOpened: stats.streamsOpened, streamsClosed: stats.streamsClosed,
      activeRequestsAfterDrain: stats.activeRequests, activeReadersAfterDrain: stats.activeReaders,
      activeDownloadsAfterDrain: stats.activeAdapterDownloads, workerQueueAfterDrain: stats.pendingQueueCommands,
      trackedAbortListenersAfterDrain: stats.abortListeners, activeTimersAfterDrain: activeTimers.size,
      childProcessesBeforeAndAfter: childProcessesBefore }));
  } finally {
    await worker.handle({ type: 'stop', ...lease });
    tokenRpc.mockRestore();
    setTimerSpy.mockRestore();
    clearTimerSpy.mockRestore();
  }
}, 30_000);
