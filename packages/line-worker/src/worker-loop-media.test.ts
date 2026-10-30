import { afterEach, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LineWorkerEventSchema } from '@line-agent/contracts';
import { FakeLineTransport } from './fake-transport.js';
import { LineServerRejection } from './line-server-error.js';
import { EffectDeniedError } from './mutation-gate.js';
import { LineWorkerLoop, MediaUploadFailedError, tagMediaStage } from './worker-loop.js';

const owner = { accountId: 'account-A', workerInstanceId: 'worker-1', controlEpoch: 7,
  transportOwnerId: 'owner-1', transportGeneration: 4, writeGrantVersion: 9 };
const cursor = { version: 1 as const, revision: '0', globalRev: '0', individualRev: '0' };
const temporary: string[] = [];
afterEach(async () => {
  await Promise.all(temporary.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function setup(mode: 'ACTIVE_CONTROL' | 'MONITOR_ONLY' = 'ACTIVE_CONTROL', content = Buffer.from('media-bytes')) {
  const dir = await mkdtemp(join(tmpdir(), 'worker-media-'));
  temporary.push(dir);
  const filePath = join(dir, 'a.png');
  await writeFile(filePath, content);
  const transport = new FakeLineTransport({ ownMid: 'u-self', displayName: 'Agent' });
  const events: any[] = [];
  let leaseValid = true;
  const worker = new LineWorkerLoop({ transport, emit: (event) => { events.push(event); }, validateLease: () => leaseValid });
  await worker.handle({ type: 'init', ...owner, protocolVersion: 4, mode, durableCursor: cursor });
  await worker.handle({ type: 'loginQr', ...owner, loginAttemptId: 'login-1' });
  const command = { type: 'sendMedia' as const, ...owner, chatType: 'direct' as const, chatId: 'u-peer', requestId: 'media-1',
    kind: 'image' as const, filePath, fileName: 'a.png', sizeBytes: content.length,
    sha256: createHash('sha256').update(content).digest('hex'), timeoutMs: 120_000,
    operationId: 'op-1', attemptId: 'attempt-1', effectPermit: 'permit-1' };
  return { worker, transport, events, command, filePath, dir, revoke: () => { leaseValid = false; } };
}

describe('worker sendMedia', () => {
  it('sends verified bytes through the transport and echoes operation identity', async () => {
    const { worker, transport, events, command } = await setup();
    await worker.handle(command);
    expect(transport.sendMediaCalls).toHaveLength(1);
    expect(transport.sendMediaCalls[0]).toMatchObject({ chatType: 'direct', chatId: 'u-peer', kind: 'image', fileName: 'a.png',
      bytes: Buffer.from('media-bytes') });
    expect(events.at(-1)).toMatchObject({ type: 'sendResult', requestId: 'media-1', operationId: 'op-1', attemptId: 'attempt-1',
      status: 'sent', messageId: 'media-1', error: null });
  });

  it('rejects a hash or size mismatch before any transport call', async () => {
    const { worker, transport, events, command } = await setup();
    await worker.handle({ ...command, sha256: 'b'.repeat(64) });
    expect(events.at(-1)).toMatchObject({ status: 'failed', error: 'FILE_CHANGED' });
    await worker.handle({ ...command, requestId: 'm2', effectPermit: 'permit-2', sizeBytes: command.sizeBytes + 1 });
    expect(events.at(-1)).toMatchObject({ status: 'failed', error: 'FILE_CHANGED' });
    await worker.handle({ ...command, requestId: 'm3', effectPermit: 'permit-3', sizeBytes: command.sizeBytes - 1 });
    expect(events.at(-1)).toMatchObject({ status: 'failed', error: 'FILE_CHANGED' });
    expect(transport.sendMediaCalls).toHaveLength(0);
  });

  it('reports an unreadable or non-regular file as FILE_UNREADABLE', async () => {
    const { worker, transport, events, command, dir } = await setup();
    await worker.handle({ ...command, filePath: join(dir, 'missing.png') });
    expect(events.at(-1)).toMatchObject({ status: 'failed', error: 'FILE_UNREADABLE' });
    await worker.handle({ ...command, requestId: 'm2', effectPermit: 'permit-2', filePath: dir });
    expect(events.at(-1)).toMatchObject({ status: 'failed', error: 'FILE_UNREADABLE' });
    expect(transport.sendMediaCalls).toHaveLength(0);
  });

  it('consumes the effect permit once', async () => {
    const { worker, transport, events, command } = await setup();
    await worker.handle(command);
    await worker.handle({ ...command, requestId: 'media-2', operationId: 'op-2', attemptId: 'attempt-2' });
    expect(transport.sendMediaCalls).toHaveLength(1);
    expect(events.at(-1)).toMatchObject({ requestId: 'media-2', status: 'failed', error: 'SIDE_EFFECT_DENIED' });
  });

  it('keeps the permit unused when the file check fails', async () => {
    const { worker, transport, events, command } = await setup();
    await worker.handle({ ...command, sha256: 'b'.repeat(64) });
    await worker.handle({ ...command, requestId: 'media-2' });
    expect(transport.sendMediaCalls).toHaveLength(1);
    expect(events.at(-1)).toMatchObject({ requestId: 'media-2', status: 'sent' });
  });

  it('maps transport outcomes to result codes', async () => {
    const { worker, transport, events, command } = await setup();
    transport.sendMediaError = new MediaUploadFailedError();
    await worker.handle(command);
    expect(events.at(-1)).toMatchObject({ status: 'failed', error: 'UPLOAD_FAILED' });
    transport.sendMediaError = new Error('sendMessage failed');
    await worker.handle({ ...command, requestId: 'm2', effectPermit: 'permit-2' });
    expect(events.at(-1)).toMatchObject({ status: 'unknown', error: 'TRANSPORT_OUTCOME_UNKNOWN' });
    transport.sendMediaError = new EffectDeniedError('denied');
    await worker.handle({ ...command, requestId: 'm3', effectPermit: 'permit-3' });
    expect(events.at(-1)).toMatchObject({ status: 'failed', error: 'SIDE_EFFECT_DENIED' });
  });

  it('sends the upload stage, error class and number as a bounded detail', async () => {
    const { worker, transport, events, command } = await setup();
    class ObsHttpError extends Error { constructor(readonly status: number) { super('OBS /private/path token=abc'); } }
    transport.sendMediaError = new MediaUploadFailedError('obs_upload', new ObsHttpError(403));
    await worker.handle(command);
    expect(events.at(-1)).toMatchObject({ status: 'failed', error: 'UPLOAD_FAILED', detail: 'obs_upload:ObsHttpError:403' });
    expect(LineWorkerEventSchema.safeParse(events.at(-1)).success).toBe(true);
    expect(JSON.stringify(events)).not.toMatch(/private|token=abc/);
    // Only a LINE code (innerCode / code) comes before an HTTP status; a class name keeps letters only.
    const lineError = Object.assign(new (class Chrome_Api$Error extends Error {})('x'), { innerCode: 10051, code: 5, status: 200 });
    transport.sendMediaError = new MediaUploadFailedError('e2ee_message', lineError);
    await worker.handle({ ...command, requestId: 'm2', effectPermit: 'permit-2' });
    expect(events.at(-1)).toMatchObject({ status: 'failed', error: 'UPLOAD_FAILED', detail: 'e2ee_message:ChromeApiError:10051' });
    transport.sendMediaError = new MediaUploadFailedError('e2ee_flow');
    await worker.handle({ ...command, requestId: 'm3', effectPermit: 'permit-3' });
    expect(events.at(-1)).toMatchObject({ error: 'UPLOAD_FAILED', detail: 'e2ee_flow' });
    transport.sendMediaError = new MediaUploadFailedError();
    await worker.handle({ ...command, requestId: 'm4', effectPermit: 'permit-4' });
    expect(events.at(-1)).toMatchObject({ error: 'UPLOAD_FAILED' });
    expect(events.at(-1)).not.toHaveProperty('detail');
  });

  it('bounds the class name and ignores unusable numbers', async () => {
    const huge = new (class extends Error {})('x');
    Object.defineProperty(huge.constructor, 'name', { value: 'A1_b'.repeat(30) });
    Object.assign(huge, { status: 2 ** 40, code: 'E_STRING' });
    const error = new MediaUploadFailedError('encrypt', huge);
    expect(error.causeClass).toBe('Ab'.repeat(30).slice(0, 40));
    expect(error.causeNumber).toBeUndefined();
    expect(error.detail).toMatch(/^encrypt:[A-Za-z]{1,40}$/);
    expect(new MediaUploadFailedError('encrypt', 'a string').detail).toBe('encrypt');
    expect(new MediaUploadFailedError('encrypt', null).detail).toBe('encrypt');
  });

  it('tags a gate denial or LINE rejection with the media step in which it happened', async () => {
    const { worker, transport, events, command } = await setup();
    transport.sendMediaError = tagMediaStage(new EffectDeniedError('media upload path is not allowlisted'), 'obs_preview');
    await worker.handle(command);
    expect(events.at(-1)).toMatchObject({ status: 'failed', error: 'SIDE_EFFECT_DENIED', detail: 'obs_preview:EffectDeniedError' });
    expect(JSON.stringify(events.at(-1))).not.toContain('allowlisted');
    transport.sendMediaError = tagMediaStage(new LineServerRejection('LINE_TALK_E2EE_UPDATE_RECEIVER_KEY', 84), 'e2ee_message');
    await worker.handle({ ...command, requestId: 'm2', effectPermit: 'permit-2' });
    expect(events.at(-1)).toMatchObject({ status: 'failed', error: 'LINE_TALK_E2EE_UPDATE_RECEIVER_KEY', detail: expect.stringMatching(/^e2ee_message:/) });
    expect(LineWorkerEventSchema.safeParse(events.at(-1)).success).toBe(true);
    transport.sendMediaError = new EffectDeniedError('untagged');
    await worker.handle({ ...command, requestId: 'm3', effectPermit: 'permit-3' });
    expect(events.at(-1)).not.toHaveProperty('detail');
  });

  it('keeps a media preparation server rejection as a fixed code without leaking server text', async () => {
    const { worker, transport, events, command } = await setup();
    const secret = 'token=private-token MID=u-private text=private-message';
    transport.sendMediaError = new LineServerRejection('LINE_TALK_E2EE_UPDATE_RECEIVER_KEY', 84);
    (transport.sendMediaError as Error & { serverMessage?: string }).serverMessage = secret;

    await worker.handle(command);

    expect(transport.sendMediaCalls).toHaveLength(1);
    expect(events.at(-1)).toMatchObject({ status: 'failed', error: 'LINE_TALK_E2EE_UPDATE_RECEIVER_KEY' });
    expect(LineWorkerEventSchema.safeParse(events.at(-1)).success).toBe(true);
    expect(JSON.stringify(events)).not.toContain(secret);
  });

  it('reports unknown on timeout and holds the send slot until the transport settles', async () => {
    const { worker, transport, events, command } = await setup();
    let release!: () => void;
    transport.sendMediaHold = new Promise<void>((resolve) => { release = resolve; });
    const sending = worker.handle({ ...command, timeoutMs: 1_000 });
    await new Promise((resolve) => setTimeout(resolve, 1_200));
    expect(events.filter((event) => event.type === 'sendResult').at(-1)).toMatchObject({ status: 'unknown', error: 'TRANSPORT_OUTCOME_UNKNOWN' });
    release();
    await sending;
    expect(events.filter((event) => event.type === 'sendResult')).toHaveLength(1);
  });

  it('denies media in monitor mode, after revocation and with a stale lease', async () => {
    const monitor = await setup('MONITOR_ONLY');
    await monitor.worker.handle(monitor.command);
    expect(monitor.events.at(-1)).toMatchObject({ status: 'failed', error: 'SIDE_EFFECT_DENIED' });
    expect(monitor.transport.sendMediaCalls).toHaveLength(0);
    const stale = await setup();
    stale.revoke();
    await stale.worker.handle(stale.command);
    expect(stale.events.at(-1)).toMatchObject({ status: 'failed', error: 'SIDE_EFFECT_DENIED' });
    const revoked = await setup();
    await revoked.worker.handle({ type: 'revokeControl', ...owner });
    await revoked.worker.handle(revoked.command);
    expect(revoked.events.at(-1)).toMatchObject({ status: 'failed', error: 'SIDE_EFFECT_DENIED' });
    expect(stale.transport.sendMediaCalls.length + revoked.transport.sendMediaCalls.length).toBe(0);
  });

  it('allows only explicit manual media for a current monitor binding', async () => {
    const monitor = await setup('MONITOR_ONLY');
    await monitor.worker.handle({ ...monitor.command, manualSend: true });
    expect(monitor.transport.sendMediaCalls).toHaveLength(1);
    expect(monitor.events.at(-1)).toMatchObject({ requestId: 'media-1', status: 'sent' });
  });
});
