import { describe, expect, it, vi } from 'vitest';
import { FakeLineTransport } from './fake-transport.js';
import { LineWorkerLoop } from './worker-loop.js';
import { LineServerRejection } from './line-server-error.js';

const protocolVersion = 4 as const;
const binding = { accountId: 'account-A', workerInstanceId: 'worker-1', controlEpoch: 7 };
const cursor = { version: 1 as const, revision: '0', globalRev: '0', individualRev: '0' };
const item = (chatId: string, title: string) => ({ chatType: chatId.startsWith('r') ? 'room' as const : 'group' as const, chatId, title,
  members: [{ memberId: 'u-peer', displayName: 'Alice' }] });

function setup() {
  const transport = new FakeLineTransport({ ownMid: 'u-self', displayName: 'Agent' });
  const events: any[] = [];
  const worker = new LineWorkerLoop({ transport, emit: (event) => { events.push(event); }, validateLease: async () => true });
  const init = worker.handle({ type: 'init', ...binding, protocolVersion, mode: 'MONITOR_ONLY', durableCursor: cursor });
  let revision = 100;
  /** One poll that carries one inbound message per chat id, then an ack of the batch. */
  const receive = async (...chatIds: string[]) => {
    revision += 1;
    transport.enqueueSync({ cursorAfter: { version: 1, revision: String(revision), globalRev: '1', individualRev: '1' },
      operations: chatIds.map((chatId, index) => ({ revision: BigInt(revision * 10 + index), type: 26,
        message: { id: String(revision * 10 + index), from: 'u-peer', to: chatId, contentType: 'NONE', text: 'hi', createdTime: 1760522400000 } })) });
    await worker.handle({ type: 'poll', ...binding });
    const batch = events.filter((event) => event.type === 'batch').at(-1);
    await worker.handle({ type: 'ackBatch', ...binding, batchId: batch.batchId, cursorAfter: batch.cursorAfter,
      ...(batch.startupFinal ? { startupComplete: true } : {}) });
  };
  const poll = () => worker.handle({ type: 'poll', ...binding });
  const settle = async () => { await new Promise<void>((resolve) => setImmediate(resolve)); await worker.flushEvents(); };
  const catalogEvents = () => events.filter((event) => event.type === 'conversationCatalog');
  const login = async (catalog: ReturnType<typeof item>[] = []) => {
    await init;
    transport.enqueueConversationCatalog(catalog);
    await worker.handle({ type: 'loginQr', ...binding, loginAttemptId: 'login-1' });
    await vi.waitFor(() => expect(catalogEvents().length).toBeGreaterThan(0));
    await settle();
  };
  return { worker, transport, events, init, receive, poll, settle, login, catalogEvents };
}

describe('conversation detail read for chats the catalog has not seen', () => {
  it('reads an unknown group once on the next poll and emits one conversationCatalog event', async () => {
    const { transport, receive, poll, settle, login, catalogEvents } = setup();
    await login([item('c-known', 'Known')]);
    transport.enqueueConversationDetails([item('c-new', 'Fresh')]);
    await receive('c-new');
    expect(transport.detailCalls).toEqual([]);
    await poll();
    await vi.waitFor(() => expect(catalogEvents()).toHaveLength(2));
    await settle();
    expect(transport.detailCalls).toEqual([['c-new']]);
    expect(catalogEvents()[1]).toMatchObject({ ...binding, conversations: [item('c-new', 'Fresh')] });
  });

  it('does not ask for an id that the catalog returned', async () => {
    const { transport, receive, poll, settle, login } = setup();
    await login([item('c-known', 'Known')]);
    await receive('c-known');
    await poll();
    await settle();
    expect(transport.detailCalls).toEqual([]);
  });

  it('never asks for a direct chat', async () => {
    const { transport, receive, poll, settle, login } = setup();
    await login();
    await receive('u-friend');
    await poll();
    await settle();
    expect(transport.detailCalls).toEqual([]);
  });

  it('does not ask twice for one id in a session, also when LINE returns no chat for it', async () => {
    const { transport, receive, poll, settle, login, catalogEvents } = setup();
    await login();
    transport.enqueueConversationDetails([]);
    await receive('r-gone');
    await poll();
    await vi.waitFor(() => expect(transport.detailCalls).toHaveLength(1));
    await settle();
    await receive('r-gone');
    await poll();
    await poll();
    await settle();
    expect(transport.detailCalls).toEqual([['r-gone']]);
    expect(catalogEvents()).toHaveLength(1);
  });

  it('batches unknown ids in order and retries a failure with backoff ticks 1, 2 and no status event', async () => {
    const { transport, receive, poll, settle, login, catalogEvents, events } = setup();
    await login();
    transport.detailError = new LineServerRejection('LINE_TALK_EXCESSIVE_ACCESS', 4);
    await receive('c-a', 'r-b', 'c-a');
    await poll();
    await vi.waitFor(() => expect(transport.detailCalls).toHaveLength(1));
    await settle();
    expect(transport.detailCalls[0]).toEqual(['c-a', 'r-b']);
    // Delay 1: the next tick retries.
    await poll();
    await vi.waitFor(() => expect(transport.detailCalls).toHaveLength(2));
    await settle();
    // Delay 2: one tick waits, the second retries.
    await poll(); await settle();
    expect(transport.detailCalls).toHaveLength(2);
    transport.detailError = undefined;
    transport.enqueueConversationDetails([item('c-a', 'A'), item('r-b', 'B')]);
    await poll();
    await vi.waitFor(() => expect(transport.detailCalls).toHaveLength(3));
    await settle();
    expect(transport.detailCalls[2]).toEqual(['c-a', 'r-b']);
    await vi.waitFor(() => expect(catalogEvents()).toHaveLength(2));
    expect(events.some((event) => event.type === 'catalogRefreshStatus')).toBe(false);
    await poll(); await poll(); await settle();
    expect(transport.detailCalls).toHaveLength(3);
  });

  it('makes no detail call before the catalog completes, and not for ids that the catalog then returns', async () => {
    const { worker, transport, init, receive, poll, settle, events, catalogEvents } = setup();
    await init;
    transport.catalogError = new Error('catalog unavailable');
    await worker.handle({ type: 'loginQr', ...binding, loginAttemptId: 'login-1' });
    await vi.waitFor(() => expect(events.some((event) => event.type === 'catalogRefreshStatus')).toBe(true));
    await receive('c-early');
    await poll();
    await settle();
    expect(transport.detailCalls).toEqual([]);
    transport.catalogError = undefined;
    transport.enqueueConversationCatalog([item('c-early', 'Early')]);
    for (let tick = 0; tick < 4; tick += 1) await poll();
    await vi.waitFor(() => expect(catalogEvents()).toHaveLength(1));
    await settle();
    await poll();
    await settle();
    expect(transport.detailCalls).toEqual([]);
  });

  it('resets the known and pending sets on a new login', async () => {
    const { worker, transport, receive, poll, settle, login } = setup();
    await login([item('c-known', 'Known')]);
    await receive('c-pending');
    // Login again before the pending id is read: the pending set is dropped and the known set is rebuilt from the new catalog.
    transport.enqueueConversationCatalog([]);
    await worker.handle({ type: 'loginQr', ...binding, loginAttemptId: 'login-1' });
    await vi.waitFor(() => expect(transport.catalogCalls).toBe(2));
    await settle();
    await receive();
    await poll();
    await settle();
    expect(transport.detailCalls).toEqual([]);
    transport.enqueueConversationDetails([item('c-known', 'Known again')]);
    await receive('c-known');
    await poll();
    await vi.waitFor(() => expect(transport.detailCalls).toEqual([['c-known']]));
  });
});
