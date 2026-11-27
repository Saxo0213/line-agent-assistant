import { afterEach, describe, expect, it, vi } from 'vitest';
import { FakeLineTransport } from './fake-transport.js';
import { LineWorkerLoop, type SquareSyncResult } from './worker-loop.js';
import { LineSquareRejection } from './line-server-error.js';

const binding = { accountId: 'account-A', workerInstanceId: 'worker-1', controlEpoch: 7 };
const cursor = { version: 1 as const, revision: '0', globalRev: '0', individualRev: '0' };
const CHAT_1 = `m${'1'.repeat(32)}`;
const CHAT_2 = `m${'2'.repeat(32)}`;
const MEMBER = `p${'b'.repeat(32)}`;

function squareEvent(chat: string, id: string) {
  return { type: 0, payload: { receiveMessage: { squareChatMid: chat, senderDisplayName: 'Alice',
    squareMessage: { message: { from: MEMBER, to: chat, toType: 4, id, createdTime: 1_700_000_000_000n, contentType: 0, text: `t${id}`,
      contentMetadata: {} } } } } };
}
const page = (events: unknown[], syncToken: string | null, continuationToken: string | null = null): SquareSyncResult =>
  ({ events, syncToken, continuationToken });

class SquareFakeTransport extends FakeLineTransport {
  readonly squareCalls: Array<{ syncToken?: string; continuationToken?: string }> = [];
  readonly titleCalls: string[] = [];
  readonly queue: Array<SquareSyncResult | Error> = [];
  httpStatus: number | null = null;
  titleError?: Error;
  readPhoneRegistration?: () => Promise<boolean | null>;
  async syncSquare(request: { syncToken?: string; continuationToken?: string }): Promise<SquareSyncResult> {
    this.squareCalls.push(request);
    const next = this.queue.shift() ?? page([], request.syncToken ?? null);
    if (next instanceof Error) throw next;
    return next;
  }
  async getSquareChatTitle(chatId: string): Promise<string | null> {
    this.titleCalls.push(chatId);
    if (this.titleError) throw this.titleError;
    return chatId === CHAT_1 ? 'Chat One' : null;
  }
  lastSquareHttpStatus(): number | null { return this.httpStatus; }
}

async function setup(init: Record<string, unknown> = { squareReceive: true }, phoneRegistered?: boolean) {
  const transport = new SquareFakeTransport({ ownMid: 'u-self', displayName: 'Agent' });
  if (phoneRegistered !== undefined) transport.readPhoneRegistration = async () => phoneRegistered;
  const events: any[] = [];
  const worker = new LineWorkerLoop({ transport, emit: (event) => { events.push(event); }, validateLease: async () => true });
  await worker.handle({ type: 'init', ...binding, protocolVersion: 5, mode: 'ACTIVE_CONTROL', durableCursor: cursor, ...init });
  await worker.handle({ type: 'loginQr', ...binding, loginAttemptId: 'login-1' });
  const batches = () => events.filter((event) => event.type === 'squareBatch');
  const ack = (batchId: string, tokenAfter: string) => worker.handle({ type: 'ackSquareBatch', ...binding, batchId, tokenAfter });
  const advance = (ms: number) => vi.advanceTimersByTimeAsync(ms);
  return { worker, transport, events, batches, ack, advance };
}

afterEach(() => { vi.useRealTimers(); });

describe('community receive step', () => {
  it('stays off when squareReceive is not true', async () => {
    vi.useFakeTimers();
    const { transport, advance } = await setup({});
    await advance(60_000);
    expect(transport.squareCalls).toHaveLength(0);
  });

  it('skips the community step and reports it when the account has no phone registration', async () => {
    vi.useFakeTimers();
    const { transport, events, advance } = await setup({ squareReceive: true }, false);
    await advance(60_000);
    expect(transport.squareCalls).toHaveLength(0);
    expect(events.find((event) => event.type === 'accountSettings')).toMatchObject({ phoneRegistered: false });
    expect(events.filter((event) => event.type === 'error' && event.diagnostic?.detail === 'square_receive_skipped:phone_not_registered')).toHaveLength(1);
  });

  it('fetches without a token on the first run, emits one batch with titles and waits for the ack', async () => {
    vi.useFakeTimers();
    const { transport, batches, advance, ack } = await setup();
    transport.queue.push(page([squareEvent(CHAT_1, '1'), squareEvent(CHAT_1, '2'), squareEvent(CHAT_2, '3')], 'T1'));
    await advance(1_000);
    expect(transport.squareCalls).toEqual([{}]);
    expect(batches()).toHaveLength(1);
    const batch = batches()[0];
    expect(batch).toMatchObject({ tokenBefore: null, tokenAfter: 'T1', titles: [{ chatId: CHAT_1, title: 'Chat One' }] });
    expect(batch.envelopes.map((item: any) => item.messageId)).toEqual(['1', '2', '3']);
    expect(transport.titleCalls).toEqual([CHAT_1, CHAT_2]);
    // No fetch while the batch waits; the same batch goes again, with the same id.
    await advance(60_000);
    expect(transport.squareCalls).toHaveLength(1);
    expect(batches().length).toBeGreaterThan(1);
    expect(new Set(batches().map((item) => item.batchId)).size).toBe(1);
    // The ack moves the token: the next fetch uses it and asks no title again.
    transport.queue.push(page([squareEvent(CHAT_1, '4')], 'T2'));
    await ack(batch.batchId, 'T1');
    await advance(10_000);
    expect(transport.squareCalls[1]).toEqual({ syncToken: 'T1' });
    expect(transport.titleCalls).toEqual([CHAT_1, CHAT_2]);
    expect(batches().at(-1)).toMatchObject({ tokenBefore: 'T1', tokenAfter: 'T2' });
    expect(batches().at(-1).titles).toBeUndefined();
  });

  it('marks the first-run chain as history and later caught-up batches as live', async () => {
    vi.useFakeTimers();
    const { transport, batches, advance, ack } = await setup();
    transport.queue.push(page([squareEvent(CHAT_1, '1')], 'T1', 'C1'), page([squareEvent(CHAT_1, '2')], 'T2'), page([squareEvent(CHAT_1, '3')], 'T3'));
    await advance(1_000);
    await ack(batches().at(-1).batchId, 'T1');
    await advance(1_000);
    await ack(batches().at(-1).batchId, 'T2');
    await advance(10_000);
    expect(batches().map((item) => item.envelopes[0].ingestion.source)).toEqual(['history', 'history', 'live']);
  });

  it('starts from the stored token of init', async () => {
    vi.useFakeTimers();
    const { transport, advance } = await setup({ squareReceive: true, squareCursor: 'STORED' });
    await advance(1_000);
    expect(transport.squareCalls).toEqual([{ syncToken: 'STORED' }]);
  });

  it('refuses an ack with another token and keeps the token', async () => {
    vi.useFakeTimers();
    const { transport, batches, advance, ack } = await setup();
    transport.queue.push(page([squareEvent(CHAT_1, '1')], 'T1'));
    await advance(1_000);
    const { batchId } = batches()[0];
    await expect(ack(batchId, 'OTHER')).rejects.toThrow('square token mismatch');
    await expect(ack('unknown', 'T1')).rejects.toThrow('square batch mismatch');
    await advance(30_000);
    expect(transport.squareCalls).toHaveLength(1);
    await ack(batchId, 'T1');
    await ack(batchId, 'T1');
  });

  it('emits a token-only batch when the token changed without a message and nothing when it did not', async () => {
    vi.useFakeTimers();
    const { transport, batches, advance, ack } = await setup();
    transport.queue.push(page([{ type: 6, payload: {} }], 'T1'), page([], 'T1'));
    await advance(1_000);
    expect(batches()).toHaveLength(1);
    expect(batches()[0]).toMatchObject({ tokenBefore: null, tokenAfter: 'T1', envelopes: [] });
    await ack(batches()[0].batchId, 'T1');
    await advance(10_000);
    expect(transport.squareCalls).toHaveLength(2);
    await advance(10_000);
    expect(transport.squareCalls).toHaveLength(3);
    expect(batches()).toHaveLength(1);
  });

  it('paces continuation pages at 1 s, at most 5 in a row, then 10 s', async () => {
    vi.useFakeTimers();
    const { transport, batches, advance, ack } = await setup();
    for (let index = 1; index <= 7; index += 1) transport.queue.push(page([squareEvent(CHAT_1, String(index))], `T${index}`, `C${index}`));
    await advance(1_000);
    for (let index = 1; index <= 4; index += 1) {
      expect(transport.squareCalls).toHaveLength(index);
      await ack(batches().at(-1).batchId, `T${index}`);
      await advance(1_000);
    }
    expect(transport.squareCalls).toHaveLength(5);
    expect(transport.squareCalls[4]).toEqual({ syncToken: 'T4', continuationToken: 'C4' });
    await ack(batches().at(-1).batchId, 'T5');
    await advance(9_000);
    expect(transport.squareCalls).toHaveLength(5);
    await advance(1_000);
    expect(transport.squareCalls).toHaveLength(6);
  });

  it('keeps a batch without a title when the title read fails, and asks only once', async () => {
    vi.useFakeTimers();
    const { transport, batches, advance, ack } = await setup();
    transport.titleError = new Error('title failed');
    transport.queue.push(page([squareEvent(CHAT_1, '1')], 'T1'), page([squareEvent(CHAT_1, '2')], 'T2'));
    await advance(1_000);
    expect(batches()[0].titles).toBeUndefined();
    await ack(batches()[0].batchId, 'T1');
    await advance(10_000);
    expect(batches()).toHaveLength(2);
    expect(transport.titleCalls).toEqual([CHAT_1]);
  });

  it('backs off after a failure and does not suspend on network errors', async () => {
    vi.useFakeTimers();
    const { transport, events, advance } = await setup();
    for (let index = 0; index < 8; index += 1) transport.queue.push(new Error('network down'));
    await advance(1_000);
    expect(transport.squareCalls).toHaveLength(1);
    await advance(4_900);
    expect(transport.squareCalls).toHaveLength(1);
    await advance(100);
    expect(transport.squareCalls).toHaveLength(2);
    for (let index = 0; index < 6; index += 1) await advance(300_000);
    // All 8 failures were tried (more than 5), and no suspension followed.
    expect(transport.squareCalls.length).toBeGreaterThanOrEqual(8);
    expect(events.filter((event) => event.type === 'error')).toEqual([]);
  });

  it('suspends after 5 LINE rejections with one error, keeps the upstream code and leaves the Talk poll running', async () => {
    vi.useFakeTimers();
    const { worker, transport, events, advance } = await setup();
    for (let index = 0; index < 8; index += 1) transport.queue.push(new LineSquareRejection('TRY_AGAIN_LATER', 503));
    await advance(1_000);
    for (let index = 0; index < 8; index += 1) await advance(300_000);
    expect(transport.squareCalls).toHaveLength(5);
    const errors = events.filter((event) => event.type === 'error');
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatchObject({ code: 'LINE_SQUARE_SUSPENDED', retryable: false,
      diagnostic: { detail: 'square:fetchMyEvents:TRY_AGAIN_LATER', upstreamCode: 503 } });
    expect(events.filter((event) => event.type === 'status' && event.message === 'LINE_CONNECTION_SUSPENDED')).toEqual([]);
    await worker.handle({ type: 'poll', ...binding });
    expect(transport.syncCalls).toHaveLength(1);
  });

  it('counts an HTTP status that is not 2xx as a rejection', async () => {
    vi.useFakeTimers();
    const { transport, events, advance } = await setup();
    transport.httpStatus = 502;
    for (let index = 0; index < 8; index += 1) transport.queue.push(new Error('bad gateway'));
    await advance(1_000);
    for (let index = 0; index < 8; index += 1) await advance(300_000);
    expect(transport.squareCalls).toHaveLength(5);
    expect(events.filter((event) => event.type === 'error')).toMatchObject([{ code: 'LINE_SQUARE_SUSPENDED',
      diagnostic: { upstreamStatus: 502 } }]);
  });

  it('does not delay the Talk poll', async () => {
    vi.useFakeTimers();
    const { worker, transport, advance } = await setup();
    // A Square fetch that never ends.
    transport.queue.push(new Promise<never>(() => undefined) as never);
    await advance(1_000);
    expect(transport.squareCalls).toHaveLength(1);
    await worker.handle({ type: 'poll', ...binding });
    expect(transport.syncCalls).toHaveLength(1);
  });

  it('stops the step at revoke and at stop', async () => {
    vi.useFakeTimers();
    const first = await setup();
    await first.worker.handle({ type: 'revokeControl', ...binding });
    await first.advance(60_000);
    expect(first.transport.squareCalls).toHaveLength(0);
    const second = await setup();
    second.transport.queue.push(page([squareEvent(CHAT_1, '1')], 'T1'));
    await second.advance(1_000);
    await second.worker.handle({ type: 'stop', ...binding });
    await second.advance(60_000);
    expect(second.transport.squareCalls).toHaveLength(1);
    expect(second.batches().length).toBeGreaterThanOrEqual(1);
    const count = second.batches().length;
    await second.advance(60_000);
    expect(second.batches()).toHaveLength(count);
  });
});
