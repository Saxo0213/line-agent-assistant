import { afterEach, describe, expect, it, vi } from 'vitest';
import { FakeLineTransport } from './fake-transport.js';
import { LineWorkerLoop } from './worker-loop.js';
import { LineServerRejection } from './line-server-error.js';

const binding = { accountId: 'account-A', workerInstanceId: 'worker-1', controlEpoch: 7 };
const cursor = { version: 1 as const, revision: '0', globalRev: '0', individualRev: '0' };

async function setup() {
  const transport = new FakeLineTransport({ ownMid: 'u-self', displayName: 'Agent' });
  const events: any[] = [];
  const worker = new LineWorkerLoop({ transport, emit: (event) => { events.push(event); }, validateLease: async () => true });
  await worker.handle({ type: 'init', ...binding, protocolVersion: 4, mode: 'ACTIVE_CONTROL', durableCursor: cursor });
  await worker.handle({ type: 'loginQr', ...binding, loginAttemptId: 'login-1' });
  const poll = () => worker.handle({ type: 'poll', ...binding });
  return { worker, transport, events, poll };
}
const suspendedEvents = (events: any[]) => events.filter((event) =>
  (event.type === 'status' && event.message === 'LINE_CONNECTION_SUSPENDED') || (event.type === 'error' && event.code === 'LINE_CONNECTION_SUSPENDED'));

afterEach(() => { vi.useRealTimers(); });

describe('poll backoff and connection suspension', () => {
  it('skips polls during the backoff window and polls again after it', async () => {
    vi.useFakeTimers();
    const { transport, poll } = await setup();
    transport.syncError = new Error('network down');
    await poll();
    expect(transport.syncCalls).toHaveLength(1);
    await poll();
    vi.advanceTimersByTime(4_000);
    await poll();
    expect(transport.syncCalls).toHaveLength(1);
    vi.advanceTimersByTime(1_500);
    await poll();
    expect(transport.syncCalls).toHaveLength(2);
  });

  it('does not suspend after network failures', async () => {
    vi.useFakeTimers();
    const { transport, events, poll } = await setup();
    transport.syncError = new Error('network down');
    for (let index = 0; index < 8; index += 1) { await poll(); vi.advanceTimersByTime(300_000); }
    expect(transport.syncCalls).toHaveLength(8);
    expect(suspendedEvents(events)).toEqual([]);
  });

  it('suspends after 5 HTTP rejections, emits the events once and stops all LINE requests', async () => {
    vi.useFakeTimers();
    const { worker, transport, events, poll } = await setup();
    transport.syncError = new Error('HTTP 404');
    transport.syncHttpStatus = 404;
    for (let index = 0; index < 8; index += 1) { await poll(); vi.advanceTimersByTime(300_000); }
    expect(transport.syncCalls).toHaveLength(5);
    expect(suspendedEvents(events)).toMatchObject([
      { type: 'status', state: 'degraded', message: 'LINE_CONNECTION_SUSPENDED' },
      { type: 'error', code: 'LINE_CONNECTION_SUSPENDED', retryable: false },
    ]);
    await worker.handle({ type: 'sendText', ...binding, chatType: 'direct', chatId: 'u-peer', requestId: 'send-1',
      text: 'hello', replyToMessageId: null });
    await worker.handle({ type: 'history', ...binding, chatType: 'direct', chatId: 'u-peer', requestId: 'history-1',
      cursor: null, limit: 10 }).catch(() => undefined);
    expect(transport.sendCalls).toHaveLength(0);
    expect(transport.historyCalls).toHaveLength(0);
    expect(events.filter((event) => event.type === 'sendResult')).toMatchObject([
      { requestId: 'send-1', status: 'failed', messageId: null, error: 'LINE_CONNECTION_SUSPENDED' }]);
  });

  it('suspends after 5 LINE server rejections', async () => {
    vi.useFakeTimers();
    const { transport, events, poll } = await setup();
    transport.syncError = new LineServerRejection('LINE_TALK_INTERNAL_ERROR', 20);
    for (let index = 0; index < 6; index += 1) { await poll(); vi.advanceTimersByTime(300_000); }
    expect(transport.syncCalls).toHaveLength(5);
    expect(suspendedEvents(events)).toHaveLength(2);
  });

  it('does not count HTTP 410 as a rejection', async () => {
    vi.useFakeTimers();
    const { transport, events, poll } = await setup();
    transport.syncError = new Error('HTTP 410');
    transport.syncHttpStatus = 410;
    for (let index = 0; index < 8; index += 1) { await poll(); vi.advanceTimersByTime(300_000); }
    expect(transport.syncCalls).toHaveLength(8);
    expect(suspendedEvents(events)).toEqual([]);
  });
});
