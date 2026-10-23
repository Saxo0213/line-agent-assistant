import { expect, it, vi } from 'vitest';

const OWN = `u${'a'.repeat(32)}`;
const fixture = vi.hoisted(() => ({
  operations: [] as unknown[],
  history: [] as unknown[],
}));

vi.mock('@evex/linejs/base', () => ({
  BaseClient: class {
    authToken?: string;
    profile = { mid: `u${'a'.repeat(32)}`, displayName: 'Agent' };
    readonly request: any;
    readonly talk: any;
    readonly e2ee = { async decryptE2EEMessage(message: unknown) { return message; } };
    readonly loginProcess = { async login() { return {}; } };
    readonly thrift = { writeThrift() { return new Uint8Array([1]); } };
    constructor(options: { fetch(request: Request): Promise<Response> }) {
      this.request = {
        endpoint: 'legy.line-apps.com',
        getHeader: () => ({}),
        request: async (_value: unknown, methodName: string) => {
          await options.fetch(new Request('https://gf.line.naver.jp/enc', { method: 'POST' }));
          return methodName === 'sync' ? {
            fullSyncResponse: { nextRevision: 9n },
            operationResponse: { globalEvents: { lastRevision: 2n }, individualEvents: { lastRevision: 3n },
              operations: fixture.operations },
          } : fixture.history;
        },
      };
      this.talk = {
        async sync() { return await thisClient.request.request({}, 'sync', 4, true, '/SYNC4'); },
        async getRecentMessagesV2() { return await thisClient.request.request({}, 'getRecentMessagesV2', 4, true, '/S4'); },
      };
      const thisClient = this;
    }
    on() { return this; }
  },
}));

import { LineWorkerEventSchema } from '@line-agent/contracts';
import { LineWorkerLoop } from './worker-loop.js';
import { createLinejsAdapter } from './linejs-adapter.js';

const binding = { accountId: 'account-A', workerInstanceId: 'worker-1', controlEpoch: 7 };
const cursor = { version: 1 as const, revision: '0', globalRev: '0', individualRev: '0' };
const jwt = [Buffer.from('{"alg":"HS256"}').toString('base64url'),
  Buffer.from('{"sub":"u-self"}').toString('base64url'), 'signature'].join('.');
const GROUP = `c${'1'.repeat(32)}`;
const READER = `u${'2'.repeat(32)}`;
const T = 1760522400000;
const op = (over: Record<string, unknown>) => ({ revision: 9n, type: 'NOTIFIED_READ_MESSAGE', param1: GROUP,
  param2: READER, param3: '100', createdTime: T, ...over });

async function pollOnce(operations: unknown[], history: unknown[] = []) {
  fixture.operations = operations;
  fixture.history = history;
  const adapter = await createLinejsAdapter({ ...binding, mode: 'MONITOR_ONLY', validateLease: () => false,
    physicalTransport: async () => new Response() });
  await adapter.installSecrets({ token: jwt, qrCert: null, e2eeStorage: null });
  const events: any[] = [];
  const worker = new LineWorkerLoop({ transport: adapter, emit: (event) => { events.push(event); }, validateLease: () => false });
  await worker.handle({ type: 'init', ...binding, protocolVersion: 4, mode: 'MONITOR_ONLY', durableCursor: cursor });
  await worker.handle({ type: 'setSecretState', ...binding, loginAttemptId: 'login-1',
    secrets: { token: jwt, qrCert: null, e2eeStorage: null } });
  await worker.handle({ type: 'loginToken', ...binding, loginAttemptId: 'login-1' });
  await worker.handle({ type: 'poll', ...binding });
  return { adapter, batch: events.find((event) => event.type === 'batch') };
}

it('emits a batch carrying only read receipts when the sync has no message envelopes', async () => {
  const { batch } = await pollOnce([op({})]);
  expect(batch.envelopes).toEqual([]);
  expect(batch.readReceipts).toEqual([{ chatId: GROUP, readerMid: READER, messageId: '100',
    readAt: new Date(T).toISOString() }]);
  expect(batch.cursorAfter.revision).toBe('9');
  expect(LineWorkerEventSchema.parse(batch)).toMatchObject({ readReceipts: [{ messageId: '100' }] });
});

it('drops ops with a mismatching shape, counts them, and keeps syncing', async () => {
  const { adapter, batch } = await pollOnce([
    op({ param1: 'u-admin' }), op({ param2: 'c' + '2'.repeat(32) }), op({ param3: 'abc' }), op({ param3: '1'.repeat(21) }),
    op({ createdTime: 0 }), op({ createdTime: 'x' }), op({ param3: undefined }), op({ param3: '7' }),
  ]);
  expect(adapter.readReceiptCounters).toEqual({ readReceiptShapeDropped: 7, readReceiptOverflowDropped: 0 });
  expect(batch.readReceipts).toEqual([{ chatId: GROUP, readerMid: READER, messageId: '7',
    readAt: new Date(T).toISOString() }]);
});

it('coalesces by chat and reader keeping the numerically largest message id and its time', async () => {
  const { batch } = await pollOnce([
    op({ param3: '9', createdTime: T }), op({ param3: '12345678901234567890', createdTime: T + 2000 }),
    op({ param3: '99999999999999999', createdTime: T + 3000 }),
  ]);
  expect(batch.readReceipts).toEqual([{ chatId: GROUP, readerMid: READER, messageId: '12345678901234567890',
    readAt: new Date(T + 2000).toISOString() }]);
});

it('skips receipts read by the account itself', async () => {
  const { batch, adapter } = await pollOnce([op({ param2: OWN })]);
  expect(batch.readReceipts).toBeUndefined();
  expect(adapter.readReceiptCounters.readReceiptShapeDropped).toBe(0);
});

it('caps receipts at 500 per batch and counts the overflow', async () => {
  const ops = Array.from({ length: 501 }, (_, index) =>
    op({ param2: `u${index.toString(16).padStart(32, '0')}`, revision: BigInt(index + 1) }));
  const { adapter, batch } = await pollOnce(ops);
  expect(batch.readReceipts).toHaveLength(500);
  expect(adapter.readReceiptCounters.readReceiptOverflowDropped).toBe(1);
});

it('still catches up recent history on the first sighting of a conversation', async () => {
  const { batch } = await pollOnce([op({})], [
    { id: '8', from: READER, to: OWN, contentType: 'NONE', text: 'hi', createdTime: T }]);
  expect(batch.envelopes).toHaveLength(1);
  expect(batch.envelopes[0].ingestion.source).toBe('history');
  expect(batch.readReceipts).toHaveLength(1);
});
