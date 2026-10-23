import { describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { FakeLineTransport } from './fake-transport.js';
import { LineWorkerLoop } from './worker-loop.js';
import { createLinejsAdapter } from './linejs-adapter.js';
import { decodeHistoryCursor, encodeHistoryCursor } from './cursor.js';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SafeAttachmentError } from './attachment-error.js';
import { InternalError } from '@evex/linejs/base';

const binding = { accountId: 'account-A', workerInstanceId: 'worker-1', controlEpoch: 7 };
const protocolVersion = 4 as const;
const cursor = { version: 1 as const, revision: '0', globalRev: '0', individualRev: '0' };
const next = { version: 1 as const, revision: '9', globalRev: '2', individualRev: '3' };
const selfMid = `u${'a'.repeat(32)}`;
const attachmentChat = `c${'b'.repeat(32)}`;
const senderMid = `u${'c'.repeat(32)}`;
function workerAttachmentMessage(kind: 'image' | 'video' | 'audio' | 'file' = 'image') {
  const contentType = { image: 1, video: 2, audio: 3, file: 14 }[kind];
  const sid = { image: 'emi', video: 'emv', audio: 'ema', file: 'emf' }[kind];
  return { id: '9', from: senderMid, to: attachmentChat, toType: 2, contentType,
    contentMetadata: { OID: 'OID_123', SID: sid }, chunks: [{ encoding: 'base64', data: 'AQID' }] };
}
const message = { revision: 9n, type: 26, message: { id: '9', from: 'u-peer', to: 'c-group', contentType: 'NONE', text: 'hello', createdTime: 1760522400000 } };

function setup(mode: 'MONITOR_ONLY' | 'ACTIVE_CONTROL' = 'MONITOR_ONLY') {
  const transport = new FakeLineTransport({ ownMid: 'u-self', displayName: 'Agent' });
  const events: any[] = [];
  let validLease = true;
  const worker = new LineWorkerLoop({ transport, emit: (event) => { events.push(event); }, validateLease: async () => validLease });
  const init = worker.handle({ type: 'init', ...binding, protocolVersion, mode, durableCursor: cursor });
  return { worker, transport, events, init, revokeLease: () => { validLease = false; } };
}

async function authenticate(worker: LineWorkerLoop): Promise<void> {
  await worker.handle({ type: 'loginQr', ...binding, loginAttemptId: 'login-1' });
}

async function runAttachmentAttempt(transport: FakeLineTransport, attachmentRoot?: string) {
  const events: any[] = [];
  const worker = new LineWorkerLoop({ transport, emit: (event) => { events.push(event); },
    validateLease: () => false, ...(attachmentRoot ? { attachmentRoot } : {}), minFreeBytes: 0,
    attachmentRuntime: { unsafeAllowPortableFilesystemOnWindowsForTests: true } });
  await worker.handle({ type: 'init', ...binding, protocolVersion, mode: 'MONITOR_ONLY', durableCursor: cursor });
  await worker.handle({ type: 'loginQr', ...binding, loginAttemptId: 'attachment-test-login' });
  await worker.handle({ type: 'downloadAttachment', ...binding, chatType: 'group', chatId: attachmentChat,
    requestId: 'diagnostic-download', attemptToken: 'b7c252f7-8b1e-4fac-a9cc-69bc206c09a1', messageId: '9',
    attachmentId: '11111111-1111-4111-8111-111111111111', externalAttachmentId: 'OID_123', kind: 'image',
    occurredAt: '2026-10-15T10:00:00.000Z', originalFileName: 'display.png', lineMessage: workerAttachmentMessage(),
    maxBytes: 1024, timeoutMs: 1000 });
  return events.at(-1);
}

describe('one-account worker loop', () => {
  it('adopts official auth via download probe in download-only purpose without login events or receive', async () => {
    const transport = new FakeLineTransport({ ownMid: selfMid, displayName: 'Official' });
    const adoptionCalls: unknown[] = [];
    Object.assign(transport, { async adoptDownloadAuth(token: string, application: string, options?: { expectedMid?: string; probe?: unknown }) {
      adoptionCalls.push({ token, application, expectedMid: options?.expectedMid, probe: options?.probe });
      return { ownMid: token === 'right-token' ? selfMid : `u${'b'.repeat(32)}`, displayName: null };
    }, clearDownloadAuth() {} });
    const events: any[] = [];
    const worker = new LineWorkerLoop({ transport, emit: (event) => { events.push(event); }, validateLease: () => false });
    const downloadPurpose = { ...binding, purpose: 'DOWNLOAD_ONLY' as const, expectedMid: selfMid,
      application: 'DESKTOPWIN\t26.4.2.3957\tWINDOWS\t10.0.0-NT-x64' };
    const probe = {
      chatType: 'group' as const,
      chatId: attachmentChat,
      messageId: '9',
      externalAttachmentId: 'OID_123',
      kind: 'image' as const,
      lineMessage: workerAttachmentMessage(),
    };
    await worker.handle({ type: 'init', ...downloadPurpose, protocolVersion, mode: 'MONITOR_ONLY', durableCursor: cursor });
    await expect(worker.handle({ type: 'poll', ...binding })).rejects.toThrow(/download-only/i);
    await worker.handle({ type: 'adoptDownloadAuth', ...binding, requestId: 'auth-1', token: 'wrong-token',
      application: downloadPurpose.application, expectedMid: selfMid, probe });
    await worker.handle({ type: 'adoptDownloadAuth', ...binding, requestId: 'auth-2', token: 'right-token',
      application: 'DESKTOPWIN\t26.5.1.4180\tWINDOWS\t10.0.0-NT-x64', expectedMid: selfMid, probe });
    expect(adoptionCalls).toHaveLength(2);
    expect(adoptionCalls).toContainEqual({ token: 'right-token',
      application: 'DESKTOPWIN\t26.5.1.4180\tWINDOWS\t10.0.0-NT-x64', expectedMid: selfMid, probe });
    expect(events).toContainEqual(expect.objectContaining({ type: 'downloadAuthResult', requestId: 'auth-1', accepted: false, error: 'PROFILE_MISMATCH' }));
    expect(events).toContainEqual(expect.objectContaining({ type: 'downloadAuthResult', requestId: 'auth-2', accepted: true, error: null }));
    expect(events).toContainEqual(expect.objectContaining({ type: 'downloadReady', ownMid: selfMid }));
    expect(events.map((event) => event.type)).not.toContain('login');
    expect(events.map((event) => event.type)).not.toContain('status');
    expect(events.map((event) => event.type)).not.toContain('secretRotation');
    expect(transport.loginCalls).toEqual([]);
  });

  it('keeps a timed-out download-auth transport quarantined until its owner is replaced', async () => {
    vi.useFakeTimers();
    let releaseAdoption!: () => void;
    let adoptionStarted!: () => void;
    const started = new Promise<void>((resolve) => { adoptionStarted = resolve; });
    const pending = new Promise<void>((resolve) => { releaseAdoption = resolve; });
    const transport = new FakeLineTransport({ ownMid: selfMid, displayName: 'Official' });
    let adoptionCalls = 0;
    Object.assign(transport, { async adoptDownloadAuth() { adoptionCalls++; adoptionStarted(); await pending;
      return { ownMid: selfMid, displayName: null }; }, clearDownloadAuth() {} });
    const events: any[] = [];
    const worker = new LineWorkerLoop({ transport, emit: (event) => { events.push(event); }, validateLease: () => false });
    const downloadBinding = { ...binding, purpose: 'DOWNLOAD_ONLY' as const, expectedMid: selfMid,
      application: 'DESKTOPWIN\t26.4.2.3957\tWINDOWS\t10.0.0-NT-x64' };
    try {
      await worker.handle({ type: 'init', ...downloadBinding, protocolVersion, mode: 'MONITOR_ONLY', durableCursor: cursor });
      const timedOut = worker.handle({ type: 'adoptDownloadAuth', ...binding, requestId: 'auth-timeout', token: 'candidate-one',
        application: downloadBinding.application, expectedMid: selfMid });
      await started;
      await vi.advanceTimersByTimeAsync(10_000);
      await timedOut;
      await worker.handle({ type: 'adoptDownloadAuth', ...binding, requestId: 'auth-after-timeout', token: 'candidate-two',
        application: downloadBinding.application, expectedMid: selfMid });
      expect(adoptionCalls).toBe(1);
      expect(events).toContainEqual(expect.objectContaining({ type: 'downloadAuthResult', requestId: 'auth-timeout',
        accepted: false, error: 'AUTH_UNAVAILABLE' }));
      expect(events).toContainEqual(expect.objectContaining({ type: 'downloadAuthResult', requestId: 'auth-after-timeout',
        accepted: false, error: 'AUTH_UNAVAILABLE' }));
      expect(events).toContainEqual(expect.objectContaining({ type: 'status', state: 'degraded' }));
    } finally { releaseAdoption(); vi.useRealTimers(); }
  });

  it('serializes candidate adoption behind a pending download and rejects adoption after stop', async () => {
    const transport = new FakeLineTransport({ ownMid: selfMid, displayName: 'Official' });
    let releaseDownload!: (value: { name: string; source: AsyncIterable<Uint8Array> }) => void;
    let signalDownloadStarted!: () => void;
    const downloadStarted = new Promise<void>((resolve) => { signalDownloadStarted = resolve; });
    const credentialAdoptions: string[] = [];
    Object.assign(transport, {
      async adoptDownloadAuth(token: string) {
        credentialAdoptions.push(token);
        if (token !== 'initial') throw new Error('stopped adoption must not touch transport credentials');
        return { ownMid: selfMid, displayName: null };
      },
      async download() { signalDownloadStarted(); return await new Promise<{ name: string; source: AsyncIterable<Uint8Array> }>((resolve) => { releaseDownload = resolve; }); },
      clearDownloadAuth() {}, revoke() {},
    });
    const events: any[] = [];
    const root = await mkdtemp(join(tmpdir(), 'line-worker-download-adoption-race-'));
    const worker = new LineWorkerLoop({ transport, emit: (event) => { events.push(event); }, validateLease: () => false,
      attachmentRoot: root, minFreeBytes: 0,
      attachmentRuntime: { unsafeAllowPortableFilesystemOnWindowsForTests: true } });
    const extBinding = { ...binding, purpose: 'DOWNLOAD_ONLY' as const, expectedMid: selfMid,
      application: 'DESKTOPWIN\t26.4.2.3957\tWINDOWS\t10.0.0-NT-x64' };
    try {
      await worker.handle({ type: 'init', ...extBinding, protocolVersion, mode: 'MONITOR_ONLY', durableCursor: cursor });
      await worker.handle({ type: 'adoptDownloadAuth', ...binding, requestId: 'initial-auth', token: 'initial',
        application: extBinding.application, expectedMid: selfMid });
      const download = worker.handle({ type: 'downloadAttachment', ...binding, requestId: 'download-race',
        attemptToken: '22222222-2222-4222-8222-222222222222', attachmentId: '33333333-3333-4333-8333-333333333333',
        messageId: '9', externalAttachmentId: 'OID_123', kind: 'image', occurredAt: '2026-10-18T00:00:00.000Z',
        originalFileName: 'image.png', chatType: 'group', chatId: attachmentChat,
        lineMessage: workerAttachmentMessage(), maxBytes: 1024, timeoutMs: 5000 });
      const started = await Promise.race([downloadStarted.then(() => true), new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 250))]);
      if (!started) throw new Error(`download did not start: ${events.map((event) => event.type + ':' + (event.error ?? '')).join(',')}`);
      const adoption = worker.handle({ type: 'adoptDownloadAuth', ...binding, requestId: 'racing-auth', token: 'next',
        application: 'DESKTOPWIN\t26.5.1.4180\tWINDOWS\t10.0.0-NT-x64', expectedMid: selfMid });
      await worker.handle({ type: 'stop', ...binding });
      releaseDownload({ name: 'image.png', source: (async function* () { yield new Uint8Array([1]); })() });
      await Promise.all([download, adoption]);
      expect(credentialAdoptions).toEqual(['initial']);
      expect(events).toContainEqual(expect.objectContaining({ type: 'downloadAuthResult', requestId: 'racing-auth',
        accepted: false, error: 'AUTH_UNAVAILABLE' }));
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it('reports an uncoded preparation failure with a fixed safe stage code', async () => {
    const transport = new FakeLineTransport({ ownMid: selfMid, displayName: 'Agent' });
    const result = await runAttachmentAttempt(transport);
    expect(result).toMatchObject({ type: 'attachmentResult', status: 'failed', error: 'ATTACHMENT_PREPARE_FAILED' });
    expect(transport.downloadCalls).toHaveLength(0);
  });

  it('reports a native ObsError HTTP status without exposing its message or data', async () => {
    const transport = new FakeLineTransport({ ownMid: selfMid, displayName: 'Agent' });
    const secretUrl = 'https://obs.example/signed?key=private';
    const root = await mkdtemp(join(tmpdir(), 'line-worker-native-error-'));
    Object.defineProperty(transport, 'download', { value: async () => {
      throw new SafeAttachmentError('LINE_OBS_HTTP_404');
    } });
    try {
      const result = await runAttachmentAttempt(transport, root);
      expect(result).toMatchObject({ type: 'attachmentResult', status: 'failed', error: 'LINE_OBS_HTTP_404' });
      expect(JSON.stringify(result)).not.toContain('secret');
      expect(JSON.stringify(result)).not.toContain(secretUrl);
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it.each([399, 600, 404.5, '404', null])('does not accept invalid native OBS status %s', async (status) => {
    const transport = new FakeLineTransport({ ownMid: selfMid, displayName: 'Agent' });
    Object.defineProperty(transport, 'download', { value: async () => {
      throw new InternalError('ObsError', 'sensitive native failure', { status, url: 'https://secret.invalid/path' });
    } });
    const root = await mkdtemp(join(tmpdir(), 'line-worker-native-invalid-status-'));
    try {
      const result = await runAttachmentAttempt(transport, root);
      expect(result).toMatchObject({ type: 'attachmentResult', status: 'failed', error: 'LINE_NATIVE_DOWNLOAD_FAILED' });
      expect(JSON.stringify(result)).not.toContain('sensitive');
      expect(JSON.stringify(result)).not.toContain('secret.invalid');
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it('reports an uncoded attachment store failure with a fixed safe code', async () => {
    const root = await mkdtemp(join(tmpdir(), 'line-worker-store-failure-'));
    try {
      const transport = new FakeLineTransport({ ownMid: selfMid, displayName: 'Agent' });
      Object.defineProperty(transport, 'download', { value: async () => ({ name: 'display.png', source: (async function* () {
        throw new Error('sensitive store source detail');
      })() }) });
      const result = await runAttachmentAttempt(transport, root);
      expect(result).toMatchObject({ type: 'attachmentResult', status: 'failed', error: 'ATTACHMENT_STORE_FAILED' });
      expect(JSON.stringify(result)).not.toContain('sensitive store source detail');
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it('uses the detected native image format when source metadata has no original filename', async () => {
    const root = await mkdtemp(join(tmpdir(), 'line-worker-native-image-extension-'));
    const transport = new FakeLineTransport({ ownMid: selfMid, displayName: 'Agent' });
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00]);
    Object.defineProperty(transport, 'download', { value: async () => ({ name: null, source: (async function* () { yield png; })() }) });
    const events: any[] = [];
    const worker = new LineWorkerLoop({ transport, emit: (event) => { events.push(event); }, validateLease: () => false,
      attachmentRoot: root, minFreeBytes: 0,
      attachmentRuntime: { unsafeAllowPortableFilesystemOnWindowsForTests: true } });
    try {
      await worker.handle({ type: 'init', ...binding, protocolVersion, mode: 'MONITOR_ONLY', durableCursor: cursor });
      await worker.handle({ type: 'loginQr', ...binding, loginAttemptId: 'native-image-login' });
      await worker.handle({ type: 'downloadAttachment', ...binding, requestId: 'native-image-download',
        attemptToken: '44444444-4444-4444-8444-444444444444', attachmentId: '55555555-5555-4555-8555-555555555555',
        messageId: '9', externalAttachmentId: '9', kind: 'image', occurredAt: '2026-10-18T00:00:00.000Z',
        originalFileName: '9', chatType: 'group', chatId: attachmentChat, lineMessage: {},
        nativeAttachment: { messageId: '9', chatId: attachmentChat, from: null, to: null, toType: 2, contentType: 1,
          contentMetadata: { OID: null, SID: null, OBS_POP: null, FILE_SIZE: null, MEDIA_CONTENT_INFO: null, DOWNLOAD_URL: null },
          keyMaterial: null, fileName: null, sizeBytes: null }, maxBytes: 1024, timeoutMs: 5000 });
      const result = events.find((event) => event.type === 'attachmentResult');
      expect(result).toMatchObject({ status: 'ready', name: '9.png' });
      expect(await readFile(join(root, result.relativePath))).toEqual(png);
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it('does not forward an arbitrary error.code into the attachment result', async () => {
    const transport = new FakeLineTransport({ ownMid: selfMid, displayName: 'Agent' });
    Object.defineProperty(transport, 'download', { value: async () => {
      throw Object.assign(new Error('private timeout details'), { code: 'TIMEOUT' });
    } });
    const root = await mkdtemp(join(tmpdir(), 'line-worker-coded-error-'));
    try {
      const result = await runAttachmentAttempt(transport, root);
      expect(result).toMatchObject({ type: 'attachmentResult', status: 'failed', error: 'LINE_NATIVE_DOWNLOAD_FAILED' });
      expect(JSON.stringify(result)).not.toContain('private timeout details');
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it.each([
    'LINE_E2EE_KEY_MISMATCH', 'LINE_E2EE_SELF_KEY_MISSING', 'LINE_E2EE_PEER_KEY_UNAVAILABLE',
    'LINE_E2EE_UNSUPPORTED', 'LINE_MEDIA_AUTH_FAILED', 'LINE_RPC_FAILED', 'LINE_NETWORK_FAILED',
    'LINE_E2EE_METADATA_RPC_FAILED', 'LINE_E2EE_METADATA_DECRYPT_FAILED',
    'LINE_OBS_TOKEN_RPC_FAILED', 'LINE_OBS_TOKEN_INVALID',
  ])('preserves allowlisted adapter category %s without exposing exception payload', async (safeCode) => {
    const transport = new FakeLineTransport({ ownMid: selfMid, displayName: 'Agent' });
    Object.defineProperty(transport, 'download', { value: async () => {
      throw Object.assign(new SafeAttachmentError(safeCode), { data: { key: 'secret-key' } });
    } });
    const root = await mkdtemp(join(tmpdir(), 'line-worker-native-code-'));
    try {
      const result = await runAttachmentAttempt(transport, root);
      expect(result).toMatchObject({ type: 'attachmentResult', status: 'failed', error: safeCode });
      expect(JSON.stringify(result)).not.toContain('secret');
      expect(JSON.stringify(result)).not.toContain('RAW_NATIVE_CODE');
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it('allows an authenticated manual text send in MONITOR_ONLY without granting other writes', async () => {
    const monitor = setup('MONITOR_ONLY');
    await monitor.init;
    await authenticate(monitor.worker);
    await monitor.worker.handle({ type: 'manualSendText', ...binding, chatType: 'direct', chatId: 'u-peer',
      requestId: 'manual-send-1', text: 'human message', replyToMessageId: null } as never);
    expect(monitor.transport.sendCalls).toEqual([{ chatType: 'direct', chatId: 'u-peer', text: 'human message', replyToMessageId: null,
      lease: expect.objectContaining(binding), manual: true }]);
    await monitor.worker.handle({ type: 'reactMessage', ...binding, chatType: 'direct', chatId: 'u-peer',
      requestId: 'manual-reaction-1', messageId: '9', reaction: 'LOVE' });
    expect(monitor.transport.reactCalls).toHaveLength(0);
  });

  it('routes a source-message reaction through the active LINE transport owner only', async () => {
    const active = setup('ACTIVE_CONTROL');
    await active.init;
    await active.worker.handle({ type: 'reactMessage', ...binding, chatType: 'direct', chatId: 'u-peer',
      requestId: 'reaction-1', messageId: '9', reaction: 'AMAZING' });
    expect(active.transport.reactCalls).toEqual([{ chatType: 'direct', chatId: 'u-peer', messageId: '9', reaction: 'AMAZING' }]);

    const monitor = setup('MONITOR_ONLY');
    await monitor.init;
    await monitor.worker.handle({ type: 'reactMessage', ...binding, chatType: 'direct', chatId: 'u-peer',
      requestId: 'reaction-2', messageId: '9', reaction: 'LOVE' });
    expect(monitor.transport.reactCalls).toEqual([]);
  });

  it('parses every Agent reaction, including OMG, through the strict command schema into the transport', async () => {
    const active = setup('ACTIVE_CONTROL');
    await active.init;
    for (const reaction of ['AMAZING', 'NICE', 'FUN', 'LOVE', 'SAD', 'OMG'] as const) {
      await active.worker.handle({ type: 'reactMessage', ...binding, chatType: 'direct', chatId: 'u-peer',
        requestId: `reaction-${reaction}`, messageId: '9', reaction });
    }
    expect(active.transport.reactCalls.map((call) => call.reaction)).toEqual(['AMAZING', 'NICE', 'FUN', 'LOVE', 'SAD', 'OMG']);
  });

  it('stops polling after the trusted LINEJS authentication invalidation signal', async () => {
    const transport = new FakeLineTransport({ ownMid: 'u-self', displayName: 'Agent' });
    let invalidate!: () => void;
    const register = transport.on.bind(transport);
    transport.on = ((event: string, listener: (value: unknown) => void) => {
      if (event === 'authInvalidated') invalidate = listener as () => void;
      else register(event as never, listener as never);
    }) as typeof transport.on;
    const events: any[] = [];
    const worker = new LineWorkerLoop({ transport, emit: (event) => { events.push(event); }, validateLease: () => false });
    await worker.handle({ type: 'init', ...binding, protocolVersion, mode: 'MONITOR_ONLY', durableCursor: cursor });
    await worker.handle({ type: 'loginQr', ...binding, loginAttemptId: 'auth-invalid-attempt' });
    expect(invalidate).toEqual(expect.any(Function));
    invalidate();
    await worker.flushEvents();
    expect(events).toContainEqual(expect.objectContaining({ type: 'authInvalidated', accountId: binding.accountId }));
    await worker.handle({ type: 'poll', ...binding });
    expect(transport.syncCalls).toHaveLength(0);
  });
  it('propagates the attachment deadline into LINEJS acquisition and stays responsive when it stalls', async () => {
    const root = await mkdtemp(join(tmpdir(), 'line-worker-stalled-download-'));
    try {
      const transport = new FakeLineTransport({ ownMid: selfMid, displayName: 'Agent' });
      const acquire = vi.fn(async (...args: unknown[]) => {
        const options = args[4] as { signal?: AbortSignal; maxBytes?: number } | undefined;
        return await new Promise<never>((_resolve, reject) => {
          options?.signal?.addEventListener('abort', () => reject(options.signal!.reason), { once: true });
        });
      });
      Object.defineProperty(transport, 'download', { value: acquire });
      const events: any[] = [];
      const worker = new LineWorkerLoop({ transport, emit: (event) => { events.push(event); },
        validateLease: () => false, attachmentRoot: root, minFreeBytes: 0 });
      await worker.handle({ type: 'init', ...binding, protocolVersion, mode: 'MONITOR_ONLY', durableCursor: cursor });
      await worker.handle({ type: 'loginQr', ...binding, loginAttemptId: 'stalled-login' });
      const result = worker.handle({ type: 'downloadAttachment', ...binding, chatType: 'group', chatId: attachmentChat,
        requestId: 'stalled-download', attemptToken: 'b7c252f7-8b1e-4fac-a9cc-69bc206c09a1', messageId: '9', attachmentId: '11111111-1111-4111-8111-111111111111',
        externalAttachmentId: 'OID_123', kind: 'file', occurredAt: '2026-10-15T10:00:00.000Z',
        originalFileName: 'display.bin', lineMessage: workerAttachmentMessage('file'), maxBytes: 32, timeoutMs: 25 });
      const outcome = await Promise.race([result.then(() => 'completed'), new Promise<string>((resolve) => setTimeout(() => resolve('stalled'), 100))]);
      expect(outcome).toBe('completed');
      expect(acquire).toHaveBeenCalledOnce();
      expect(acquire.mock.calls[0]?.[4]).toMatchObject({ maxBytes: 32, signal: expect.any(AbortSignal) });
      expect(events.at(-1)).toMatchObject({ type: 'attachmentResult', attachmentId: '11111111-1111-4111-8111-111111111111', status: 'failed' });
      expect((await readdir(root, { recursive: true })).some((name) => String(name).endsWith('.part'))).toBe(false);
      await expect(worker.handle({ type: 'poll', ...binding })).resolves.toBeUndefined();
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it('stops an attempt-scoped transport on cancel acknowledgement before emitting its result', async () => {
    const root = await mkdtemp(join(tmpdir(), 'line-worker-cancel-download-'));
    try {
      const transport = new FakeLineTransport({ ownMid: selfMid, displayName: 'Agent' });
      let entered!: () => void;
      let aborted!: () => void;
      const downloadStarted = new Promise<void>((resolve) => { entered = resolve; });
      const transportAborted = new Promise<void>((resolve) => { aborted = resolve; });
      Object.defineProperty(transport, 'download', { value: async (_kind: unknown, _messageId: unknown, _externalId: unknown,
        _message: unknown, options: { signal: AbortSignal }) => {
        entered();
        return await new Promise<never>((_resolve, reject) => options.signal.addEventListener('abort', () => {
          aborted(); reject(options.signal.reason);
        }, { once: true }));
      } });
      const events: any[] = [];
      const worker = new LineWorkerLoop({ transport, emit: (event) => { events.push(event); }, validateLease: () => true,
        attachmentRoot: root, minFreeBytes: 0 });
      await worker.handle({ type: 'init', ...binding, protocolVersion, mode: 'MONITOR_ONLY', durableCursor: cursor });
      await worker.handle({ type: 'loginQr', ...binding, loginAttemptId: 'cancel-login' });
      const attachmentId = '11111111-1111-4111-8111-111111111111';
      const attemptToken = 'b7c252f7-8b1e-4fac-a9cc-69bc206c09a1';
      const download = worker.handle({ type: 'downloadAttachment', ...binding, chatType: 'group', chatId: attachmentChat,
        requestId: 'cancel-download', attemptToken, messageId: '9', attachmentId, externalAttachmentId: 'OID_123',
        kind: 'file', occurredAt: '2026-10-15T10:00:00.000Z', originalFileName: 'display.bin', lineMessage: workerAttachmentMessage('file'),
        maxBytes: 32, timeoutMs: 2_000 });
      await downloadStarted;
      await worker.handle({ type: 'cancelAttachmentDownload', ...binding, attachmentId, attemptToken });
      await Promise.all([transportAborted, download]);
      expect(events).toContainEqual(expect.objectContaining({ type: 'attachmentCancelAck', attachmentId, attemptToken, cancelled: true }));
      expect(events).toContainEqual(expect.objectContaining({ type: 'attachmentResult', attachmentId, attemptToken, status: 'failed', error: 'LINE_DOWNLOAD_CANCELLED' }));
      expect((await readdir(root, { recursive: true })).some((name) => String(name).endsWith('.part'))).toBe(false);
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  // 18 real files are written and fsynced two at a time; with the whole suite running in parallel that exceeds the 15 s default.
  it('bounds an attachment burst at two active downloads and sixteen queued waiters, then drains to idle', { timeout: 90_000 }, async () => {
    const root = await mkdtemp(join(tmpdir(), 'line-worker-attachment-burst-'));
    try {
      const transport = new FakeLineTransport({ ownMid: selfMid, displayName: 'Agent' });
      let active = 0;
      let maximumActive = 0;
      let started = 0;
      const releases: Array<() => void> = [];
      Object.defineProperty(transport, 'download', { value: async () => {
        active += 1;
        maximumActive = Math.max(maximumActive, active);
        started += 1;
        await new Promise<void>((resolve) => releases.push(resolve));
        active -= 1;
        return { name: 'burst.bin', source: (async function* () { yield new Uint8Array([1]); })() };
      } });
      const events: any[] = [];
      const worker = new LineWorkerLoop({ transport, emit: (event) => { events.push(event); }, validateLease: () => false,
        attachmentRoot: root, minFreeBytes: 0, attachmentRuntime: { unsafeAllowPortableFilesystemOnWindowsForTests: true } });
      await worker.handle({ type: 'init', ...binding, protocolVersion, mode: 'MONITOR_ONLY', durableCursor: cursor });
      await worker.handle({ type: 'loginQr', ...binding, loginAttemptId: 'burst-login' });
      const commands = Array.from({ length: 19 }, (_, index) => worker.handle({ type: 'downloadAttachment', ...binding,
        chatType: 'group', chatId: attachmentChat, requestId: `burst-${index}`,
        attemptToken: `b7c252f7-8b1e-4fac-a9cc-${String(index).padStart(12, '0')}`,
        attachmentId: `11111111-1111-4111-8111-${String(index).padStart(12, '0')}`,
        messageId: '9', externalAttachmentId: 'OID_123', kind: 'image', occurredAt: '2026-10-15T10:00:00.000Z',
        originalFileName: 'burst.bin', lineMessage: workerAttachmentMessage(), maxBytes: 32, timeoutMs: 10_000 }));
      // Release until all 18 admitted downloads have finished. A fixed 9 batches of two assumed both active downloads
      // were always registered together; under load only one may be, which left a download unreleased and hung the test.
      let released = 0;
      while (released < 18) {
        await vi.waitFor(() => expect(releases.length).toBeGreaterThan(0), { timeout: 20_000, interval: 10 });
        const release = releases.splice(0);
        released += release.length;
        release.forEach((finish) => finish());
      }
      await Promise.all(commands);
      expect(maximumActive).toBe(2);
      expect(started).toBe(18);
      expect(active).toBe(0);
      const results = events.filter((event) => event.type === 'attachmentResult');
      expect(results).toHaveLength(19);
      expect(results.filter((event) => event.status === 'ready')).toHaveLength(18);
      expect(results.filter((event) => event.status === 'failed')).toHaveLength(1);
      expect(releases).toEqual([]);
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it('does not poll LINE before authentication has completed', async () => {
    const { worker, init, transport } = setup();
    await init;
    await worker.handle({ type: 'poll', ...binding });
    expect(transport.syncCalls).toHaveLength(0);
  });

  it('preserves catch-up history provenance through the worker batch so routing ignores commands', async () => {
    const { worker, transport, events, init } = setup();
    await init;
    await authenticate(worker);
    transport.enqueueSync({ cursorAfter: next, operations: [{ source: 'history', operation: {
      revision: 9n, type: 26, message: { id: '9', from: 'admin', to: 'u-self', contentType: 'NONE',
        text: '/new', createdTime: 1760522400000 },
    } }] });

    await worker.handle({ type: 'poll', ...binding });

    const batch = events.find((event) => event.type === 'batch') as Extract<typeof events[number], { type: 'batch' }>;
    const recovered = batch.envelopes[0] as import('@line-agent/contracts').InboundEnvelope;
    expect(recovered.ingestion.source).toBe('history');
    const { routeTrigger } = await import('../../../apps/desktop/src/main/services/trigger-router.js');
    expect(routeTrigger(recovered, { ownMid: 'u-self', agentEnabled: true, senderIsPrimaryAdmin: true,
      workspaceConfigured: true, defaultProvider: 'codex' })).toEqual({ type: 'ignore' });
    expect(transport.sendCalls).toEqual([]);
  });

  it('binds the first initialization immutably and rejects another account or instance', async () => {
    const { worker, init, transport } = setup();
    await init;
    await expect(worker.handle({ type: 'init', ...binding, accountId: 'account-B', protocolVersion, mode: 'ACTIVE_CONTROL', durableCursor: cursor })).rejects.toThrow();
    await expect(worker.handle({ type: 'loginQr', ...binding, accountId: 'account-B', loginAttemptId: 'login-1' })).rejects.toThrow();
    await expect(worker.handle({ type: 'loginQr', ...binding, workerInstanceId: 'forged', loginAttemptId: 'login-1' })).rejects.toThrow();
    expect(transport.loginCalls).toHaveLength(0);
  });

  it('registers QR/PIN listeners before login and correlates secret rotations', async () => {
    const { worker, transport, events, init } = setup();
    await init;
    await worker.handle({ type: 'setSecretState', ...binding, loginAttemptId: 'login-1', secrets: { token: null, qrCert: 'certificate', e2eeStorage: {} } });
    await worker.handle({ type: 'loginQr', ...binding, loginAttemptId: 'login-1' });
    expect(events).toContainEqual({ type: 'qr', ...binding, loginAttemptId: 'login-1', code: 'qr-url' });
    expect(events).toContainEqual({ type: 'pin', ...binding, loginAttemptId: 'login-1', pin: '1234' });
    transport.rotateToken('new-token');
    await worker.flushEvents();
    expect(events).toContainEqual({ type: 'secretRotation', ...binding, loginAttemptId: 'login-1',
      secrets: { token: 'new-token', qrCert: 'certificate', e2eeStorage: {} } });
  });

  it.each(['qr', 'pin'] as const)('keeps native %s login pending beyond the former application deadline', async (stage) => {
    vi.useFakeTimers();
    try {
      const { worker, transport, events, init } = setup();
      await init;
      let release!: () => void;
      let started!: () => void;
      const pending = new Promise<void>((resolve) => { release = resolve; });
      const began = new Promise<void>((resolve) => { started = resolve; });
      const nativeLogin = transport.loginQr.bind(transport);
      transport.loginQr = async () => {
        const identity = await nativeLogin();
        started();
        await pending;
        return identity;
      };
      const loggingIn = worker.handle({ type: 'loginQr', ...binding, loginAttemptId: `login-${stage}` });
      await began;
      await vi.advanceTimersByTimeAsync(10_001);
      expect(events).not.toContainEqual(expect.objectContaining({ type: 'status', state: 'degraded' }));
      expect(events.some((event) => event.type === stage)).toBe(true);
      let settled = false;
      void loggingIn.then(() => { settled = true; }, () => { settled = true; });
      await Promise.resolve();
      expect(settled).toBe(false);
      release();
      await loggingIn;
      expect(events).toContainEqual(expect.objectContaining({ type: 'login', loginAttemptId: `login-${stage}` }));
    } finally { vi.useRealTimers(); }
  });

  it('keeps native token login pending beyond the former application deadline', async () => {
    vi.useFakeTimers();
    try {
      const { worker, transport, events, init } = setup();
      await init;
      await worker.handle({ type: 'setSecretState', ...binding, loginAttemptId: 'token-deadline',
        secrets: { token: 'saved-token', qrCert: null, e2eeStorage: null } });
      let release!: () => void;
      let started!: () => void;
      const pending = new Promise<void>((resolve) => { release = resolve; });
      const began = new Promise<void>((resolve) => { started = resolve; });
      transport.loginToken = async () => {
        started();
        await pending;
        return { ownMid: 'u-self', displayName: 'Agent' };
      };
      const loggingIn = worker.handle({ type: 'loginToken', ...binding, loginAttemptId: 'token-deadline' });
      await began;
      await vi.advanceTimersByTimeAsync(10_001);
      expect(events).not.toContainEqual(expect.objectContaining({ type: 'status', state: 'degraded' }));
      let settled = false;
      void loggingIn.then(() => { settled = true; }, () => { settled = true; });
      await Promise.resolve();
      expect(settled).toBe(false);
      release();
      await loggingIn;
      expect(events).toContainEqual(expect.objectContaining({ type: 'login', loginAttemptId: 'token-deadline' }));
    } finally { vi.useRealTimers(); }
  });

  it('retains the 10 second deadline for secret installation', async () => {
    vi.useFakeTimers();
    try {
      const { worker, transport, init } = setup();
      await init;
      transport.installSecrets = async () => await new Promise<void>(() => undefined);
      const restoring = worker.handle({ type: 'setSecretState', ...binding, loginAttemptId: 'secret-deadline',
        secrets: { token: 'token', qrCert: null, e2eeStorage: null } });
      const rejected = expect(restoring).rejects.toThrow('LINE credential operation deadline exceeded');
      await vi.advanceTimersByTimeAsync(10_000);
      await rejected;
    } finally { vi.useRealTimers(); }
  });

  it('suppresses login and secret callbacks after stop while allowing revokeControl refreshes', async () => {
    const { worker, transport, events, init } = setup();
    await init;
    let release!: () => void;
    let started!: () => void;
    const pending = new Promise<void>((resolve) => { release = resolve; });
    const began = new Promise<void>((resolve) => { started = resolve; });
    transport.loginQr = async () => {
      started();
      await pending;
      return { ownMid: 'u-late', displayName: 'Late' };
    };
    const loggingIn = worker.handle({ type: 'loginQr', ...binding, loginAttemptId: 'stopped-login' });
    await began;
    await worker.handle({ type: 'stop', ...binding });
    transport.rotateToken('late-token');
    release();
    await loggingIn;
    await worker.flushEvents();
    expect(events).not.toContainEqual(expect.objectContaining({ type: 'secretRotation', loginAttemptId: 'stopped-login' }));
    expect(events).not.toContainEqual(expect.objectContaining({ type: 'login', loginAttemptId: 'stopped-login' }));
    expect(events).not.toContainEqual(expect.objectContaining({ type: 'status', state: 'ready' }));

    const monitor = setup();
    await monitor.init;
    await monitor.worker.handle({ type: 'revokeControl', ...binding });
    let installed = false;
    monitor.transport.installSecrets = async () => { installed = true; };
    await monitor.worker.handle({ type: 'setSecretState', ...binding, loginAttemptId: 'monitor-refresh',
      secrets: { token: 'refreshed-token', qrCert: null, e2eeStorage: null } });
    expect(installed).toBe(true);
  });

  it('emits the LINE conversation catalog immediately after a successful login', async () => {
    const { worker, transport, events, init } = setup();
    await init;
    transport.enqueueConversationCatalog([{ chatType: 'direct', chatId: 'u-peer', title: 'Alice',
      members: [{ memberId: 'u-peer', displayName: 'Alice' }] }]);
    await worker.handle({ type: 'loginQr', ...binding, loginAttemptId: 'login-1' });
    expect(transport.catalogCalls).toBe(1);
    await vi.waitFor(() => expect(events).toContainEqual({ type: 'conversationCatalog', ...binding,
      conversations: [{ chatType: 'direct', chatId: 'u-peer', title: 'Alice',
        members: [{ memberId: 'u-peer', displayName: 'Alice' }] }] }));
  });

  it('keeps a successful login ready when optional catalog enumeration fails', async () => {
    const { worker, transport, events, init } = setup();
    await init;
    transport.catalogError = new Error('catalog unavailable');
    await expect(worker.handle({ type: 'loginQr', ...binding, loginAttemptId: 'login-1' })).resolves.toBeUndefined();
    expect(events).toContainEqual({ type: 'status', ...binding, state: 'ready', message: null });
    expect(events.some((event) => event.type === 'conversationCatalog')).toBe(false);
  });

  it('reports catalog failure safely and retries by bounded poll-tick backoff until recovery', async () => {
    const { worker, transport, events, init } = setup();
    await init;
    transport.catalogError = new Error('token=secret https://profile.line-scdn.net/private/u-peer');
    await worker.handle({ type: 'loginQr', ...binding, loginAttemptId: 'login-1' });
    await vi.waitFor(() => expect(events).toContainEqual(expect.objectContaining({ type: 'catalogRefreshStatus',
      state: 'degraded', code: 'CATALOG_REFRESH_FAILED' })));
    expect(JSON.stringify(events)).not.toMatch(/token=secret|profile\.line-scdn\.net|u-peer/);

    await worker.handle({ type: 'poll', ...binding });
    await vi.waitFor(() => expect(transport.catalogCalls).toBe(2));
    await vi.waitFor(() => expect(events.filter((event) => event.type === 'catalogRefreshStatus' && event.state === 'degraded')).toHaveLength(1));
    await worker.handle({ type: 'poll', ...binding });
    expect(transport.catalogCalls).toBe(2);
    await worker.handle({ type: 'poll', ...binding });
    await vi.waitFor(() => expect(transport.catalogCalls).toBe(3));

    transport.catalogError = undefined;
    transport.enqueueConversationCatalog([{ chatType: 'direct', chatId: 'u-peer', title: 'Alice',
      members: [{ memberId: 'u-peer', displayName: 'Alice' }] }]);
    for (let tick = 0; tick < 3; tick += 1) await worker.handle({ type: 'poll', ...binding });
    expect(transport.catalogCalls).toBe(3);
    await worker.handle({ type: 'poll', ...binding });
    await vi.waitFor(() => expect(transport.catalogCalls).toBe(4));
    await vi.waitFor(() => expect(events).toContainEqual(expect.objectContaining({ type: 'catalogRefreshStatus',
      state: 'ready', code: 'CATALOG_REFRESH_RECOVERED' })));
    expect(events).toContainEqual(expect.objectContaining({ type: 'conversationCatalog', conversations: [
      expect.objectContaining({ chatId: 'u-peer' }),
    ] }));
  });

  it('keeps a stalled catalog request independent and coalesces concurrent poll ticks into one retry', async () => {
    const { worker, transport, events, init } = setup('ACTIVE_CONTROL');
    await init;
    let start!: () => void;
    let release!: () => void;
    const started = new Promise<void>((resolve) => { start = resolve; });
    const held = new Promise<void>((resolve) => { release = resolve; });
    let catalogCalls = 0;
    transport.listConversations = async () => {
      catalogCalls += 1;
      if (catalogCalls === 1) { start(); await held; throw new Error('catalog unavailable'); }
      return [];
    };
    await expect(Promise.race([worker.handle({ type: 'loginQr', ...binding, loginAttemptId: 'login-1' }).then(() => 'ready'),
      new Promise<string>((resolve) => setTimeout(() => resolve('blocked'), 100))])).resolves.toBe('ready');
    await started;
    transport.enqueueSync({ cursorAfter: next, operations: [{ operation: message }] });
    await worker.handle({ type: 'poll', ...binding });
    await worker.handle({ type: 'poll', ...binding });
    const batch = events.find((event) => event.type === 'batch') as Extract<typeof events[number], { type: 'batch' }>;
    await worker.handle({ type: 'ackBatch', ...binding, batchId: batch.batchId, cursorAfter: next });
    await worker.handle({ type: 'sendText', ...binding, chatType: 'direct', chatId: 'u-peer', requestId: 'send-1',
      text: 'still responsive', replyToMessageId: null });
    expect(transport.syncCalls).toHaveLength(1);
    expect(worker.durableCursor).toEqual(next);
    expect(transport.sendCalls).toHaveLength(1);
    expect(catalogCalls).toBe(1);
    release();
    await vi.waitFor(() => expect(events).toContainEqual(expect.objectContaining({ type: 'catalogRefreshStatus', state: 'degraded' })));
    await worker.handle({ type: 'poll', ...binding });
    await vi.waitFor(() => expect(events).toContainEqual(expect.objectContaining({ type: 'conversationCatalog' })));
    expect(catalogCalls).toBe(2);
    for (let tick = 0; tick < 3; tick += 1) await worker.handle({ type: 'poll', ...binding });
    expect(catalogCalls).toBe(2);
  });

  it.each(['stop', 'revokeControl'] as const)('discards an in-flight catalog result after %s fences its generation', async (fence) => {
    const { worker, transport, events, init } = setup();
    await init;
    let start!: () => void;
    let release!: () => void;
    const started = new Promise<void>((resolve) => { start = resolve; });
    const held = new Promise<void>((resolve) => { release = resolve; });
    transport.listConversations = async () => { start(); await held; return []; };
    await worker.handle({ type: 'loginQr', ...binding, loginAttemptId: 'login-1' });
    await started;
    await worker.handle({ type: fence, ...binding });
    release();
    await new Promise<void>((resolve) => setImmediate(resolve));
    await worker.flushEvents();
    expect(events.some((event) => event.type === 'conversationCatalog')).toBe(false);
    expect(events.some((event) => event.type === 'catalogRefreshStatus')).toBe(false);
  });

  it('discards an in-flight catalog result after LINE authentication invalidation', async () => {
    const transport = new FakeLineTransport({ ownMid: 'u-self', displayName: 'Agent' });
    let invalidate!: () => void;
    const register = transport.on.bind(transport);
    transport.on = ((event: string, listener: (value: unknown) => void) => {
      if (event === 'authInvalidated') invalidate = listener as () => void;
      else register(event as never, listener as never);
    }) as typeof transport.on;
    let start!: () => void;
    let release!: () => void;
    const started = new Promise<void>((resolve) => { start = resolve; });
    const held = new Promise<void>((resolve) => { release = resolve; });
    transport.listConversations = async () => { start(); await held; return []; };
    const events: any[] = [];
    const worker = new LineWorkerLoop({ transport, emit: (event) => { events.push(event); }, validateLease: () => false });
    await worker.handle({ type: 'init', ...binding, protocolVersion, mode: 'MONITOR_ONLY', durableCursor: cursor });
    await worker.handle({ type: 'loginQr', ...binding, loginAttemptId: 'login-1' });
    await started;
    invalidate();
    release();
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(events).toContainEqual(expect.objectContaining({ type: 'authInvalidated' }));
    expect(events.some((event) => event.type === 'conversationCatalog' || event.type === 'catalogRefreshStatus')).toBe(false);
  });

  it('cannot relabel pending login A callbacks with secret restore B; restart can inject B', async () => {
    const { worker, transport, events, init } = setup();
    await init;
    let startLogin: (() => void) | undefined;
    let finishLogin: (() => void) | undefined;
    const started = new Promise<void>((resolve) => { startLogin = resolve; });
    const hold = new Promise<void>((resolve) => { finishLogin = resolve; });
    transport.loginQr = async () => {
      startLogin?.();
      await hold;
      return { ownMid: 'u-self', displayName: 'Agent' };
    };
    await worker.handle({ type: 'setSecretState', ...binding, loginAttemptId: 'login-A',
      secrets: { token: null, qrCert: null, e2eeStorage: {} } });
    const loggingIn = worker.handle({ type: 'loginQr', ...binding, loginAttemptId: 'login-A' });
    await started;
    await expect(worker.handle({ type: 'setSecretState', ...binding, loginAttemptId: 'login-B',
      secrets: { token: 'wrong-token', qrCert: null, e2eeStorage: {} } })).rejects.toThrow('login attempt mismatch');
    transport.rotateToken('A-token');
    await worker.flushEvents();
    expect(events).toContainEqual({ type: 'secretRotation', ...binding, loginAttemptId: 'login-A',
      secrets: { token: 'A-token', qrCert: null, e2eeStorage: {} } });
    finishLogin?.();
    await loggingIn;
    expect(events).toContainEqual({ type: 'login', ...binding, loginAttemptId: 'login-A',
      ownMid: 'u-self', displayName: 'Agent' });

    const restarted = setup();
    await restarted.init;
    await restarted.worker.handle({ type: 'setSecretState', ...binding, loginAttemptId: 'login-B',
      secrets: { token: 'B-token', qrCert: null, e2eeStorage: {} } });
    await restarted.worker.handle({ type: 'loginToken', ...binding, loginAttemptId: 'login-B' });
    expect(restarted.events).toContainEqual({ type: 'login', ...binding, loginAttemptId: 'login-B',
      ownMid: 'u-self', displayName: 'Agent' });
  });

  it('does not restore even same-attempt secrets while login is in flight', async () => {
    const { worker, transport, init } = setup();
    await init;
    let start: (() => void) | undefined;
    const started = new Promise<void>((resolve) => { start = resolve; });
    let release: (() => void) | undefined;
    const hold = new Promise<void>((resolve) => { release = resolve; });
    transport.loginQr = async () => { start?.(); await hold; return { ownMid: 'u-self', displayName: 'Agent' }; };
    const loggingIn = worker.handle({ type: 'loginQr', ...binding, loginAttemptId: 'login-A' });
    await started;
    await expect(worker.handle({ type: 'setSecretState', ...binding, loginAttemptId: 'login-A',
      secrets: { token: 'stale-token', qrCert: null, e2eeStorage: {} } })).rejects.toThrow('login in progress');
    release?.();
    await loggingIn;
  });

  it('does not start login until private secret restore completes', async () => {
    const { worker, transport, init } = setup();
    await init;
    let start: (() => void) | undefined;
    const started = new Promise<void>((resolve) => { start = resolve; });
    let release: (() => void) | undefined;
    const hold = new Promise<void>((resolve) => { release = resolve; });
    transport.installSecrets = async () => { start?.(); await hold; };
    const restoring = worker.handle({ type: 'setSecretState', ...binding, loginAttemptId: 'login-A',
      secrets: { token: 'A-token', qrCert: null, e2eeStorage: {} } });
    await started;
    await expect(worker.handle({ type: 'loginToken', ...binding, loginAttemptId: 'login-A' }))
      .rejects.toThrow('secret restore in progress');
    expect(transport.loginCalls).toHaveLength(0);
    release?.();
    await restoring;
    await worker.handle({ type: 'loginToken', ...binding, loginAttemptId: 'login-A' });
    expect(transport.loginCalls).toEqual(['token']);
  });

  it('holds composite cursor until matching batch/cursor ack and replays on timeout', async () => {
    const { worker, transport, events, init } = setup();
    await init;
    await authenticate(worker);
    transport.enqueueSync({ cursorAfter: next, operations: [message] });
    await worker.handle({ type: 'poll', ...binding });
    const batch = events.find((event) => event.type === 'batch');
    expect(batch).toMatchObject({ cursorBefore: cursor, cursorAfter: next, envelopes: [{ messageId: '9' }] });
    expect(worker.durableCursor).toEqual(cursor);
    await expect(worker.handle({ type: 'ackBatch', ...binding, batchId: batch.batchId, cursorAfter: cursor })).rejects.toThrow();
    await worker.handle({ type: 'poll', ...binding });
    expect(events.at(-1)).toEqual(batch);
    expect(transport.syncCalls).toHaveLength(1);
    await worker.handle({ type: 'ackBatch', ...binding, batchId: batch.batchId, cursorAfter: next });
    expect(worker.durableCursor).toEqual(next);
  });

  it('checkpoints cursor-only sync and resumes from the durable value', async () => {
    const { worker, transport, events, init } = setup();
    await init;
    await authenticate(worker);
    transport.enqueueSync({ cursorAfter: next, operations: [] });
    await worker.handle({ type: 'poll', ...binding });
    expect(events.at(-1)).toMatchObject({ type: 'batch', envelopes: [], cursorAfter: next });
    expect(worker.durableCursor).toEqual(cursor);
  });

  it('keeps monitor sync read-only and emits safe decrypt failure without mention trigger', async () => {
    const { worker, transport, events, init } = setup();
    await init;
    await authenticate(worker);
    transport.enqueueSync({ cursorAfter: next, operations: [{ operation: { ...message, message: { ...message.message,
      text: '@Agent', contentMetadata: { MENTION: '{"MENTIONEES":[{"S":"0","E":"6","M":"u-agent"}]}' } } },
      decryptionError: { code: 'SIDE_EFFECT_DENIED', retryable: false } }] });
    await worker.handle({ type: 'poll', ...binding });
    expect(events.at(-1).envelopes[0]).toMatchObject({ kind: 'event', text: null, mentionIds: [],
      raw: { contentState: 'decrypt_failed', error: { code: 'SIDE_EFFECT_DENIED' } } });
    await worker.handle({ type: 'sendText', ...binding, chatType: 'group', chatId: 'c-group', requestId: 'send-1', text: 'no', replyToMessageId: null });
    expect(transport.sendCalls).toHaveLength(0);
    expect(events.at(-1)).toMatchObject({ type: 'sendResult', status: 'failed' });
  });

  it('sends exactly once with the current lease; stale and revoked sends never dispatch', async () => {
    const { worker, transport, events, init, revokeLease } = setup('ACTIVE_CONTROL');
    await init;
    const send = { type: 'sendText', ...binding, chatType: 'group', chatId: 'c-group', requestId: 'send-1', text: 'hi', replyToMessageId: 'previous' };
    await worker.handle(send);
    expect(transport.sendCalls).toEqual([{ chatType: 'group', chatId: 'c-group', text: 'hi', replyToMessageId: 'previous', lease: binding, manual: false }]);
    expect(events.at(-1)).toMatchObject({ status: 'sent' });
    await expect(worker.handle({ ...send, controlEpoch: 6 })).rejects.toThrow();
    revokeLease();
    await worker.handle({ ...send, requestId: 'send-2' });
    expect(transport.sendCalls).toHaveLength(1);
    await worker.handle({ type: 'revokeControl', ...binding });
    await worker.handle({ ...send, requestId: 'send-3' });
    expect(transport.sendCalls).toHaveLength(1);
  });

  it('consumes a one-shot effect permit under the current transport owner and echoes operation identity', async () => {
    const transport = new FakeLineTransport({ ownMid: 'u-self', displayName: 'Agent' });
    const events: any[] = [];
    const ownerBinding = { ...binding, transportOwnerId: 'owner-1', transportGeneration: 4, writeGrantVersion: 9 };
    const worker = new LineWorkerLoop({ transport, emit: (event) => { events.push(event); }, validateLease: () => true });
    await worker.handle({ type: 'init', ...ownerBinding, protocolVersion, mode: 'ACTIVE_CONTROL', durableCursor: cursor });
    await worker.handle({ type: 'loginQr', ...ownerBinding, loginAttemptId: 'login-1' });
    const permit = { type: 'sendText' as const, ...ownerBinding, chatType: 'direct' as const, chatId: 'u-peer',
      requestId: 'request-1', operationId: 'operation-1', attemptId: 'attempt-1', effectPermit: 'permit-1',
      text: 'hello', replyToMessageId: null };
    await worker.handle(permit);
    await worker.handle({ ...permit, requestId: 'request-2', operationId: 'operation-2', attemptId: 'attempt-2' });
    expect(transport.sendCalls).toHaveLength(1);
    expect(events).toContainEqual(expect.objectContaining({ type: 'sendResult', requestId: 'request-1',
      transportOwnerId: 'owner-1', transportGeneration: 4, writeGrantVersion: 9,
      operationId: 'operation-1', attemptId: 'attempt-1', status: 'sent' }));
    expect(events).toContainEqual(expect.objectContaining({ type: 'sendResult', requestId: 'request-2',
      status: 'failed', error: 'SIDE_EFFECT_DENIED' }));
  });

  it('continues polling and emits archivable batches after control is revoked', async () => {
    const { worker, transport, events, init } = setup('ACTIVE_CONTROL');
    await init;
    await authenticate(worker);
    await worker.handle({ type: 'revokeControl', ...binding });
    transport.enqueueSync({ cursorAfter: next, operations: [message] });

    await worker.handle({ type: 'poll', ...binding });

    expect(transport.syncCalls).toHaveLength(1);
    expect(events.at(-1)).toMatchObject({ type: 'batch', cursorAfter: next,
      envelopes: [{ kind: 'text', messageId: '9', text: 'hello' }] });
    await worker.handle({ type: 'sendText', ...binding, chatType: 'group', chatId: 'c-group',
      requestId: 'after-revoke', text: 'must not send', replyToMessageId: null });
    expect(transport.sendCalls).toHaveLength(0);
  });

  it('delivers a send result while the receive batch callback is still pending', async () => {
    const transport = new FakeLineTransport({ ownMid: 'u-self', displayName: 'Agent' });
    let releaseBatch!: () => void;
    let signalBatchStarted!: () => void;
    let signalSendResult!: () => void;
    const batchStarted = new Promise<void>((resolve) => { signalBatchStarted = resolve; });
    const batchHold = new Promise<void>((resolve) => { releaseBatch = resolve; });
    const sendResultEmitted = new Promise<void>((resolve) => { signalSendResult = resolve; });
    const worker = new LineWorkerLoop({ transport, validateLease: () => true, emit: async (event) => {
      if (event.type === 'batch') { signalBatchStarted(); await batchHold; }
      if (event.type === 'sendResult') signalSendResult();
    } });
    await worker.handle({ type: 'init', ...binding, protocolVersion, mode: 'ACTIVE_CONTROL', durableCursor: cursor });
    await authenticate(worker);
    transport.enqueueSync({ cursorAfter: next, operations: [message] });
    const polling = worker.handle({ type: 'poll', ...binding });
    let sending: Promise<void> | undefined;
    try {
      await batchStarted;
      sending = worker.handle({ type: 'sendText', ...binding, chatType: 'direct', chatId: 'u-peer',
        requestId: 'independent-send', text: 'hello', replyToMessageId: null });
      const emittedBeforeReceiveRelease = await Promise.race([sendResultEmitted.then(() => true),
        new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 50))]);
      expect(emittedBeforeReceiveRelease).toBe(true);
    } finally {
      releaseBatch();
      await Promise.all([polling, ...(sending ? [sending] : [])]);
    }
  });

  it('rejects the reserved local Agent room before reaching LINE transport', async () => {
    const { worker, transport, events, init } = setup('ACTIVE_CONTROL');
    await init;
    await worker.handle({ type: 'sendText', ...binding, chatType: 'direct', chatId: '__local_agent_room__',
      requestId: 'local-send', text: 'never send this to LINE', replyToMessageId: null });
    expect(transport.sendCalls).toHaveLength(0);
    expect(events.at(-1)).toMatchObject({ type: 'sendResult', requestId: 'local-send', status: 'failed', error: 'LOCAL_ROUTE_DENIED' });
  });

  it('marks a post-dispatch timeout unknown and does not retry', async () => {
    const { worker, transport, events, init } = setup('ACTIVE_CONTROL');
    await init;
    transport.sendError = new Error('timeout');
    await worker.handle({ type: 'sendText', ...binding, chatType: 'direct', chatId: 'u-peer', requestId: 'send-1', text: 'hello', replyToMessageId: null });
    expect(transport.sendCalls).toHaveLength(1);
    expect(events.at(-1)).toMatchObject({ status: 'unknown' });
  });

  it('checks the requested MID through the active relation transport and echoes the full binding', async () => {
    const { worker, transport, events, init } = setup('ACTIVE_CONTROL');
    await init;
    await authenticate(worker);
    const targetMid = `u${'a'.repeat(32)}`;
    Object.defineProperty(transport, 'checkFriendRelation', { value: vi.fn(async (mid: string) => mid === targetMid ? 'friend' : 'not_friend') });
    await worker.handle({ type: 'checkFriendRelation', ...binding, requestId: 'check-1', targetMid });
    expect(events.at(-1)).toMatchObject({ type: 'friendRelationResult', ...binding, requestId: 'check-1', targetMid,
      status: 'friend', error: null });
    await worker.handle({ type: 'checkFriendRelation', ...binding, requestId: 'check-2', targetMid: `u${'b'.repeat(32)}` });
    expect(events.at(-1)).toMatchObject({ requestId: 'check-2', targetMid: `u${'b'.repeat(32)}`, status: 'not_friend' });
  });

  it('returns unknown for malformed relation data and when the exact requested MID is missing', async () => {
    const { worker, transport, events, init } = setup('ACTIVE_CONTROL');
    await init;
    await authenticate(worker);
    const targetMid = `u${'a'.repeat(32)}`;
    const check = vi.fn().mockResolvedValueOnce('unknown').mockResolvedValueOnce('unknown');
    Object.defineProperty(transport, 'checkFriendRelation', { value: check });
    await worker.handle({ type: 'checkFriendRelation', ...binding, requestId: 'malformed', targetMid });
    await worker.handle({ type: 'checkFriendRelation', ...binding, requestId: 'mismatch', targetMid });
    expect(events.filter((event) => event.type === 'friendRelationResult').map((event) => event.status)).toEqual(['unknown', 'unknown']);
    expect(events).not.toContainEqual(expect.objectContaining({ type: 'status', state: 'degraded' }));
  });

  it('denies relation commands without active control, login, or a current lease', async () => {
    const monitor = setup('MONITOR_ONLY');
    await monitor.init;
    const targetMid = `u${'a'.repeat(32)}`;
    await monitor.worker.handle({ type: 'addFriendByMid', ...binding, requestId: 'monitor-add', targetMid });
    expect(monitor.events.at(-1)).toMatchObject({ type: 'addFriendResult', requestId: 'monitor-add', status: 'failed', error: 'SIDE_EFFECT_DENIED' });
    expect(monitor.transport.friendAddCalls).toHaveLength(0);

    const active = setup('ACTIVE_CONTROL');
    await active.init;
    await active.worker.handle({ type: 'addFriendByMid', ...binding, requestId: 'not-logged-in', targetMid });
    expect(active.events.at(-1)).toMatchObject({ type: 'addFriendResult', requestId: 'not-logged-in', status: 'failed', error: 'NOT_READY' });
    expect(active.transport.friendAddCalls).toHaveLength(0);

    await authenticate(active.worker);
    active.revokeLease();
    await expect(active.worker.handle({ type: 'addFriendByMid', ...binding, controlEpoch: binding.controlEpoch - 1,
      requestId: 'stale-binding', targetMid })).rejects.toThrow('worker binding mismatch');
    await active.worker.handle({ type: 'addFriendByMid', ...binding, requestId: 'stale-lease', targetMid });
    expect(active.events.at(-1)).toMatchObject({ type: 'addFriendResult', requestId: 'stale-lease', status: 'failed', error: 'SIDE_EFFECT_DENIED' });
    expect(active.transport.friendAddCalls).toHaveLength(0);
  });

  it('runs an allowed friend add once, reports post-start failure unknown, and coalesces request IDs', async () => {
    const { worker, transport, events, init } = setup('ACTIVE_CONTROL');
    await init;
    await authenticate(worker);
    const targetMid = `u${'a'.repeat(32)}`;
    let release!: () => void;
    const wait = new Promise<void>((resolve) => { release = resolve; });
    const add = vi.fn(async (_mid: string, _lease: unknown, onPhysicalStart: () => void) => { onPhysicalStart(); await wait; throw new Error('timeout'); });
    Object.defineProperty(transport, 'addFriendByMid', { value: add });
    const command = { type: 'addFriendByMid', ...binding, requestId: 'add-1', targetMid };
    const first = worker.handle(command);
    const duplicate = worker.handle(command);
    await vi.waitFor(() => expect(add).toHaveBeenCalledTimes(1));
    release();
    await Promise.all([first, duplicate]);
    expect(add).toHaveBeenCalledTimes(1);
    expect(events.filter((event) => event.type === 'addFriendResult')).toHaveLength(2);
    expect(events.at(-1)).toMatchObject({ type: 'addFriendResult', ...binding, requestId: 'add-1', targetMid,
      status: 'unknown', error: 'TRANSPORT_OUTCOME_UNKNOWN' });
    await worker.handle(command);
    expect(add).toHaveBeenCalledTimes(1);
    expect(events.filter((event) => event.type === 'addFriendResult')).toHaveLength(3);
  });

  it('rejects an add request ID reused for a different MID without a second physical call', async () => {
    const { worker, transport, events, init } = setup('ACTIVE_CONTROL');
    await init;
    await authenticate(worker);
    const add = vi.fn(async (_mid: string, _lease: unknown, onPhysicalStart: () => void) => {
      onPhysicalStart(); return { status: 'added' as const, error: null };
    });
    Object.defineProperty(transport, 'addFriendByMid', { value: add });
    await worker.handle({ type: 'addFriendByMid', ...binding, requestId: 'same-id', targetMid: `u${'a'.repeat(32)}` });
    expect(events.find((event) => event.type === 'addFriendResult')).toMatchObject({ requestId: 'same-id', status: 'added', error: null });
    await worker.handle({ type: 'addFriendByMid', ...binding, requestId: 'same-id', targetMid: `u${'b'.repeat(32)}` });
    expect(add).toHaveBeenCalledTimes(1);
    expect(events.at(-1)).toMatchObject({ type: 'addFriendResult', requestId: 'same-id',
      targetMid: `u${'b'.repeat(32)}`, status: 'failed', error: 'REQUEST_ID_CONFLICT' });
  });

  it('keeps a timed-out started add unknown and reserved until its underlying call settles', async () => {
    vi.useFakeTimers();
    const { worker, transport, events, init } = setup('ACTIVE_CONTROL');
    let release!: () => void;
    let signalStarted!: () => void;
    const started = new Promise<void>((resolve) => { signalStarted = resolve; });
    const wait = new Promise<void>((resolve) => { release = resolve; });
    Object.defineProperty(transport, 'addFriendByMid', { value: vi.fn(async (_mid: string, _lease: unknown,
      onPhysicalStart: () => void) => { onPhysicalStart(); signalStarted(); await wait; return { status: 'added', error: null }; }) });
    try {
      await init;
      await authenticate(worker);
      const command = { type: 'addFriendByMid', ...binding, requestId: 'timed-add', targetMid: `u${'a'.repeat(32)}` };
      const first = worker.handle(command);
      await started;
      await vi.advanceTimersByTimeAsync(30_000);
      await first;
      expect(events.at(-1)).toMatchObject({ type: 'addFriendResult', requestId: 'timed-add', status: 'unknown' });
      release();
      await Promise.resolve();
      await Promise.resolve();
      await worker.handle(command);
      expect(transport.friendAddCalls).toHaveLength(0);
      expect((transport as any).addFriendByMid).toHaveBeenCalledTimes(1);
    } finally { release?.(); vi.useRealTimers(); }
  });

  it('never starts a queued add after its NOT_STARTED deadline has elapsed', async () => {
    vi.useFakeTimers();
    const { worker, transport, events, init } = setup('ACTIVE_CONTROL');
    let releaseRead!: () => void;
    let readStarted!: () => void;
    const readEntered = new Promise<void>((resolve) => { readStarted = resolve; });
    const heldRead = new Promise<void>((resolve) => { releaseRead = resolve; });
    const check = vi.fn(async () => { readStarted(); await heldRead; return 'friend' as const; });
    const add = vi.fn(async (_mid: string, _lease: unknown, started: () => void) => {
      started(); return { status: 'added' as const, error: null };
    });
    Object.defineProperty(transport, 'checkFriendRelation', { value: check });
    Object.defineProperty(transport, 'addFriendByMid', { value: add });
    try {
      await init; await authenticate(worker);
      const first = worker.handle({ type: 'checkFriendRelation', ...binding, requestId: 'held-read', targetMid: `u${'a'.repeat(32)}` });
      await readEntered;
      const queued = worker.handle({ type: 'addFriendByMid', ...binding, requestId: 'late-add', targetMid: `u${'b'.repeat(32)}` });
      await vi.advanceTimersByTimeAsync(30_000);
      await queued;
      expect(events.find((event) => event.type === 'addFriendResult' && event.requestId === 'late-add'))
        .toMatchObject({ status: 'failed', error: 'NOT_STARTED' });
      releaseRead(); await first;
      await Promise.resolve(); await Promise.resolve();
      expect(add).not.toHaveBeenCalled();
    } finally { releaseRead?.(); vi.useRealTimers(); }
  });

  it('holds credential swap until an in-flight Relation transport call really settles', async () => {
    const { worker, transport, init } = setup('ACTIVE_CONTROL');
    let releaseRead!: () => void;
    let readStarted!: () => void;
    let readActive = false;
    const entered = new Promise<void>((resolve) => { readStarted = resolve; });
    const held = new Promise<void>((resolve) => { releaseRead = resolve; });
    Object.defineProperty(transport, 'checkFriendRelation', { value: async () => {
      readActive = true; readStarted(); await held; readActive = false; return 'friend';
    } });
    const install = vi.fn(async () => { expect(readActive).toBe(false); });
    Object.defineProperty(transport, 'installSecrets', { value: install });
    try {
      await init; await authenticate(worker);
      const checking = worker.handle({ type: 'checkFriendRelation', ...binding, requestId: 'swap-overlap', targetMid: `u${'a'.repeat(32)}` });
      await entered;
      const swapping = worker.handle({ type: 'setSecretState', ...binding, loginAttemptId: 'login-1',
        secrets: { token: null, qrCert: null, e2eeStorage: null } });
      await Promise.resolve();
      expect(install).not.toHaveBeenCalled();
      releaseRead();
      await Promise.all([checking, swapping]);
      expect(install).toHaveBeenCalledOnce();
    } finally { releaseRead?.(); }
  });

  it('acknowledges revoke only after an in-flight send settles', async () => {
    const { worker, transport, events, init } = setup('ACTIVE_CONTROL');
    await init;
    const release = transport.pauseSend();
    const sending = worker.handle({ type: 'sendText', ...binding, chatType: 'direct', chatId: 'u-peer', requestId: 'send-1', text: 'hello', replyToMessageId: null });
    await transport.sendStarted;
    const revoking = worker.handle({ type: 'revokeControl', ...binding });
    await Promise.resolve();
    expect(events.filter((event) => event.type === 'modeAck' && event.mode === 'MONITOR_ONLY')).toHaveLength(0);
    release();
    await Promise.all([sending, revoking]);
    expect(events.at(-1)).toMatchObject({ type: 'modeAck', ...binding, mode: 'MONITOR_ONLY', drained: true });
  });

  it('revokes real adapter writes during held E2EE preparation while preserving read capabilities', async () => {
    const { E2EE } = await import(new URL('../../../node_modules/@evex/linejs/base/e2ee/mod.js', import.meta.url).href) as {
      E2EE: { prototype: object };
    };
    let releaseEncryption!: () => void;
    let signalEncryptionStarted!: () => void;
    const encryptionStarted = new Promise<void>((resolve) => { signalEncryptionStarted = resolve; });
    const encryptionHold = new Promise<void>((resolve) => { releaseEncryption = resolve; });
    const encrypt = vi.spyOn(E2EE.prototype as any, 'encryptE2EEMessage').mockImplementation(async () => {
      signalEncryptionStarted();
      await encryptionHold;
      return [Buffer.from([1, 2, 3])];
    });
    const physicalTransport = vi.fn(async () => { throw new Error('read fixture reached physical transport'); });
    const adapter = await createLinejsAdapter({ ...binding, mode: 'ACTIVE_CONTROL', validateLease: () => true, physicalTransport });
    await adapter.installSecrets({ token: ['{"alg":"HS256"}', '{"sub":"u-self"}', 'signature']
      .map((part) => Buffer.from(part).toString('base64url')).join('.'), qrCert: null, e2eeStorage: null });
    const events: any[] = [];
    const worker = new LineWorkerLoop({ transport: adapter, validateLease: () => true,
      emit: (event) => { events.push(event); } });
    await worker.handle({ type: 'init', ...binding, protocolVersion, mode: 'ACTIVE_CONTROL', durableCursor: cursor });
    const sending = worker.handle({ type: 'sendText', ...binding, chatType: 'direct', chatId: 'u-peer',
      requestId: 'revoke-during-encryption', text: 'hello', replyToMessageId: null });
    try {
      await encryptionStarted;
      const revoking = worker.handle({ type: 'revokeControl', ...binding });
      releaseEncryption();
      await Promise.all([sending, revoking]);
      expect(events.at(-1)).toMatchObject({ type: 'modeAck', mode: 'MONITOR_ONLY', drained: true });
      expect(events.find((event) => event.type === 'sendResult')).toMatchObject({ status: 'failed' });
      expect(physicalTransport).not.toHaveBeenCalled();
      await expect(adapter.sync(cursor)).rejects.toThrow('read fixture reached physical transport');
      await expect(adapter.history({ chatType: 'group', chatId: 'c-group' }, null, 10))
        .rejects.toThrow('read fixture reached physical transport');
      expect(physicalTransport).toHaveBeenCalledTimes(2);
    } finally {
      releaseEncryption();
      encrypt.mockRestore();
    }
  });

  it('rejects a concurrent send without losing the in-flight revoke drain', async () => {
    const { worker, transport, events, init } = setup('ACTIVE_CONTROL');
    await init;
    const release = transport.pauseSend();
    const first = worker.handle({ type: 'sendText', ...binding, chatType: 'direct', chatId: 'u-peer', requestId: 'send-1', text: 'first', replyToMessageId: null });
    await transport.sendStarted;
    await worker.handle({ type: 'sendText', ...binding, chatType: 'direct', chatId: 'u-peer', requestId: 'send-2', text: 'second', replyToMessageId: null });
    const revoking = worker.handle({ type: 'revokeControl', ...binding });
    await Promise.resolve();
    expect(transport.sendCalls).toHaveLength(1);
    expect(events).not.toContainEqual({ type: 'modeAck', ...binding, mode: 'MONITOR_ONLY', drained: true });
    release();
    await Promise.all([first, revoking]);
    expect(events.at(-1)).toMatchObject({ type: 'modeAck', mode: 'MONITOR_ONLY', drained: true });
  });

  it('emits secret rotations sequentially before accepting later commands', async () => {
    const transport = new FakeLineTransport({ ownMid: 'u-self', displayName: 'Agent' });
    const seen: string[] = [];
    let releaseFirst: (() => void) | undefined;
    const first = new Promise<void>((resolve) => { releaseFirst = resolve; });
    const worker = new LineWorkerLoop({ transport, validateLease: () => false,
      emit: async (event) => {
        if (event.type !== 'secretRotation') return;
        seen.push(event.secrets.token ?? 'null');
        if (seen.length === 1) await first;
      } });
    await worker.handle({ type: 'init', ...binding, protocolVersion, mode: 'MONITOR_ONLY', durableCursor: cursor });
    await worker.handle({ type: 'setSecretState', ...binding, loginAttemptId: 'login-1',
      secrets: { token: null, qrCert: null, e2eeStorage: {} } });
    transport.rotateToken('first');
    transport.rotateToken('second');
    await Promise.resolve();
    expect(seen).toEqual(['first']);
    releaseFirst?.();
    await worker.flushEvents();
    expect(seen).toEqual(['first', 'second']);
  });

  it('fails closed when the private secret event sink rejects', async () => {
    const transport = new FakeLineTransport({ ownMid: 'u-self', displayName: 'Agent' });
    const worker = new LineWorkerLoop({ transport, validateLease: () => false,
      emit: async (event) => { if (event.type === 'secretRotation') throw new Error('private IPC down'); } });
    await worker.handle({ type: 'init', ...binding, protocolVersion, mode: 'MONITOR_ONLY', durableCursor: cursor });
    await worker.handle({ type: 'setSecretState', ...binding, loginAttemptId: 'login-1',
      secrets: { token: null, qrCert: null, e2eeStorage: {} } });
    transport.rotateToken('new-token');
    await expect(worker.flushEvents()).rejects.toThrow('private IPC down');
    await expect(worker.handle({ type: 'poll', ...binding })).rejects.toThrow('private IPC down');
    expect(transport.syncCalls).toHaveLength(0);
  });

  it('uses an application-owned scoped history cursor with no live Agent ingestion', async () => {
    const { worker, transport, events, init } = setup();
    await init;
    transport.enqueueHistory([{ id: '9223372036854775807', from: 'u-peer', to: 'c-group',
      contentType: 'NONE', text: 'older', createdTime: 1760522400000, deliveredTime: 1760522400000n }]);
    await worker.handle({ type: 'history', ...binding, chatType: 'group', chatId: 'c-group', requestId: 'history-1', cursor: null, limit: 10 });
    const result = events.at(-1);
    expect(result).toMatchObject({ type: 'historyResult', requestId: 'history-1', envelopes: [{ ingestion: { source: 'history' } }] });
    expect(decodeHistoryCursor(result.nextCursor)).toEqual({ version: 1, accountId: 'account-A', chatType: 'group',
      chatId: 'c-group', messageId: '9223372036854775807', deliveredTime: '1760522400000' });
    const forged = encodeHistoryCursor({ version: 1, accountId: 'account-B', chatType: 'group', chatId: 'c-group',
      messageId: '5', deliveredTime: '1760522400000' });
    await expect(worker.handle({ type: 'history', ...binding, chatType: 'group', chatId: 'c-group', requestId: 'history-2',
      cursor: forged, limit: 10 })).rejects.toThrow();
    expect(transport.historyCalls).toHaveLength(1);
  });

  it.each(['image', 'video', 'audio', 'file'] as const)('stores %s with an authoritative scoped attachment ID', async (kind) => {
    const root = await mkdtemp(join(tmpdir(), 'line-worker-attachment-'));
    try {
      const transport = new FakeLineTransport({ ownMid: selfMid, displayName: 'Agent' });
      transport.enqueueDownload(new Uint8Array([1, 2, 3]), '原始附件.txt');
      const events: any[] = [];
      const ownerBinding = { ...binding, transportOwnerId: 'owner-attachment', transportGeneration: 1, writeGrantVersion: 1 };
      const worker = new LineWorkerLoop({ transport, emit: (event) => { events.push(event); },
        validateLease: () => false, attachmentRoot: root,
        attachmentRuntime: { unsafeAllowPortableFilesystemOnWindowsForTests: true }, minFreeBytes: 0 });
      await worker.handle({ type: 'init', ...ownerBinding, protocolVersion, mode: 'MONITOR_ONLY', durableCursor: cursor });
      await worker.handle({ type: 'loginQr', ...ownerBinding, loginAttemptId: 'ready-login' });
      const message = workerAttachmentMessage(kind);
      await worker.handle({ type: 'downloadAttachment', ...ownerBinding, chatType: 'group', chatId: attachmentChat,
        requestId: 'download-1', attemptToken: 'b7c252f7-8b1e-4fac-a9cc-69bc206c09a1', messageId: '9', attachmentId: '11111111-1111-4111-8111-111111111111',
        externalAttachmentId: 'OID_123', kind, occurredAt: '2026-10-15T10:00:00.000Z',
        originalFileName: 'display.bin', lineMessage: message,
        maxBytes: 1024, timeoutMs: 1000 });
      expect(events.at(-1), JSON.stringify(events.at(-1))).toMatchObject({ type: 'attachmentResult', accountId: 'account-A',
        workerInstanceId: ownerBinding.workerInstanceId, controlEpoch: ownerBinding.controlEpoch,
        transportOwnerId: ownerBinding.transportOwnerId, transportGeneration: ownerBinding.transportGeneration,
        writeGrantVersion: ownerBinding.writeGrantVersion,
        chatType: 'group', chatId: attachmentChat, attachmentId: '11111111-1111-4111-8111-111111111111',
        status: 'ready', sizeBytes: 3, name: '原始附件.txt' });
      expect(events.at(-1).relativePath).not.toContain('\\');
      expect(events.at(-1).relativePath).toBe(`accounts/id-6163636f756e742d41/group/id-${Buffer.from(attachmentChat).toString('hex')}/2026/10/id-39/${createHash('sha256').update('OID_123').digest('hex')}/${events.at(-1).name}`);
      expect(transport.downloadCalls).toEqual([{ kind, messageId: '9', externalAttachmentId: 'OID_123',
        lineMessage: message }]);
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it('falls back to the recorded LINE name when the native filename is unsafe', async () => {
    const root = await mkdtemp(join(tmpdir(), 'line-worker-attachment-fallback-'));
    try {
      const transport = new FakeLineTransport({ ownMid: selfMid, displayName: 'Agent' });
      transport.enqueueDownload(new Uint8Array([1, 2, 3]), '../unsafe.jpg');
      const events: any[] = [];
      const worker = new LineWorkerLoop({ transport, emit: (event) => { events.push(event); }, validateLease: () => false,
        attachmentRoot: root, attachmentRuntime: { unsafeAllowPortableFilesystemOnWindowsForTests: true }, minFreeBytes: 0 });
      await worker.handle({ type: 'init', ...binding, protocolVersion, mode: 'MONITOR_ONLY', durableCursor: cursor });
      await worker.handle({ type: 'loginQr', ...binding, loginAttemptId: 'filename-fallback-login' });
      await worker.handle({ type: 'downloadAttachment', ...binding, chatType: 'group', chatId: attachmentChat,
        requestId: 'fallback-download', attemptToken: 'b7c252f7-8b1e-4fac-a9cc-69bc206c09a1', messageId: '9',
        attachmentId: '11111111-1111-4111-8111-111111111111', externalAttachmentId: 'OID_123', kind: 'image',
        occurredAt: '2026-10-15T10:00:00.000Z', originalFileName: 'recorded.jpg', lineMessage: workerAttachmentMessage(), maxBytes: 1024, timeoutMs: 1000 });
      expect(events.at(-1)).toMatchObject({ status: 'ready', name: 'recorded.jpg' });
      expect(events.at(-1).relativePath).toMatch(/\/recorded\.jpg$/);
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it('reports repeated sync failures as degraded and recovers on a later poll without a worker restart', async () => {
    const { worker, transport, events, init } = setup();
    await init;
    await authenticate(worker);
    transport.syncError = new Error('network unavailable');
    for (let attempt = 0; attempt < 5; attempt++) {
      await expect(worker.handle({ type: 'poll', ...binding })).resolves.toBeUndefined();
    }
    expect(events.at(-1)).toMatchObject({ type: 'status', ...binding, state: 'degraded', message: null });
    transport.syncError = undefined;
    await expect(worker.handle({ type: 'poll', ...binding })).resolves.toBeUndefined();
    expect(transport.syncCalls).toHaveLength(6);
    expect(events.at(-1)).toMatchObject({ type: 'status', ...binding, state: 'ready', message: null });
  });

  it('keeps a PAUSED binding offline', async () => {
    const { worker, transport, init } = setup('PAUSED');
    await init;
    await expect(worker.handle({ type: 'loginQr', ...binding, loginAttemptId: 'login-1' })).rejects.toThrow('paused');
    await expect(worker.handle({ type: 'poll', ...binding })).rejects.toThrow('paused');
    expect(transport.loginCalls).toHaveLength(0);
    expect(transport.syncCalls).toHaveLength(0);
  });
});
