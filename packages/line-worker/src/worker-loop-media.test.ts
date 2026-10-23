import { afterEach, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FakeLineTransport } from './fake-transport.js';
import { EffectDeniedError } from './mutation-gate.js';
import { LineWorkerLoop, MediaUploadFailedError } from './worker-loop.js';

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
});
