import { describe, expect, it } from 'vitest';
import type { QrLoginE2ee } from '../auth/qr-login.js';
import { FakeE2eeBridge, FakeKeyApi, FakeStore } from '../e2ee/e2ee.testkit.js';
import type { ChromeMessage } from '../e2ee/framing.js';
import { ChromeE2ee } from '../e2ee/manager.js';
import { buildCatchupItems, buildChromeSyncResult, chromeCursor, operationType, type ChromeMessageDecryptor, type ReadReceiptCounters } from './op-normalize.js';
import type { ChromeOperation } from './types.js';

const ME = `u${'a'.repeat(32)}`;
const PEER = `u${'b'.repeat(32)}`;
const CHAT = `c${'1'.repeat(32)}`;

const passthrough: ChromeMessageDecryptor = {
  async decrypt(message) {
    return { ...message, text: 'decrypted', chunks: [] };
  },
};
const failing: ChromeMessageDecryptor = {
  async decrypt() {
    throw new Error('no key');
  },
};

const sealed = (extra: ChromeMessage = {}): ChromeMessage => ({
  id: '500',
  from: PEER,
  to: ME,
  toType: 0,
  contentType: 0,
  chunks: ['a', 'b', 'c', 'd', 'e'],
  contentMetadata: { e2eeVersion: '2' },
  ...extra,
});

const receipt = (extra: Record<string, unknown> = {}): ChromeOperation => ({
  revision: 700,
  type: 55,
  createdTime: 1_700_000_000_000,
  param1: CHAT,
  param2: PEER,
  param3: '12345',
  ...extra,
});

function run(operations: ChromeOperation[], decryptor: ChromeMessageDecryptor = passthrough, seen = new Set<string>(), counters?: ReadReceiptCounters) {
  return buildChromeSyncResult({ operations, cursorAfter: '9', decryptor, ownMid: ME, seenConversationIds: seen, ...(counters ? { counters } : {}) });
}

describe('message operations', () => {
  it('keeps the operation and decrypts the sealed message (types 25 and 26)', async () => {
    const result = await run([
      { revision: 1, type: 26, message: sealed() },
      { revision: 2, type: 25, message: sealed({ from: ME, to: PEER }) },
    ]);
    expect(result.operations).toHaveLength(2);
    expect(result.operations[0]).toMatchObject({ revision: 1, type: 26, message: { id: '500', text: 'decrypted', chunks: [] } });
    expect(result.cursorAfter).toEqual({ version: 1, revision: '9', globalRev: '0', individualRev: '0' });
    expect(result.readReceipts).toBeUndefined();
    expect(result.catchupChatIds).toEqual([]);
  });

  it('passes a plain (unsealed) message through without touching the decryptor', async () => {
    const message = { id: '1', from: PEER, to: ME, contentType: 7, text: 'plain', chunks: [] };
    const result = await run([{ revision: 1, type: 26, message }], failing);
    expect(result.operations).toEqual([{ revision: 1, type: 26, message }]);
  });

  it('turns a decrypt failure into MISSING_E2EE_KEY, not retryable, keeping the operation', async () => {
    const op: ChromeOperation = { revision: 3, type: 26, message: sealed() };
    const result = await run([op], failing);
    expect(result.operations).toEqual([{ operation: op, decryptionError: { code: 'MISSING_E2EE_KEY', retryable: false } }]);
  });

  it('keeps ids and revisions beyond 2^53 as strings', async () => {
    const result = await run([{ revision: '9007199254740993', type: 26, message: { id: '9007199254740995', from: PEER, to: ME, text: 'x' } }]);
    expect(result.operations[0]).toMatchObject({ revision: '9007199254740993', message: { id: '9007199254740995' } });
  });

  it('normalises every operation that carries a message, whatever its type', async () => {
    const result = await run([
      { revision: 1, type: 133, message: sealed() },
      { revision: 2, type: 3 },
      { revision: 3 },
    ]);
    expect(result.operations).toHaveLength(1);
    expect(result.operations[0]).toMatchObject({ revision: 1, type: 133, message: { id: '500', text: 'decrypted', chunks: [] } });
  });

  it('turns a decrypt failure of a message in an unusual operation type into MISSING_E2EE_KEY', async () => {
    const op: ChromeOperation = { revision: 4, type: 133, message: sealed() };
    const result = await run([op], failing);
    expect(result.operations).toEqual([{ operation: op, decryptionError: { code: 'MISSING_E2EE_KEY', retryable: false } }]);
  });

  it('accepts a numeric string or a name as the type', () => {
    expect(operationType({ type: '26' })).toBe(26);
    expect(operationType({ type: 'NOTIFIED_READ_MESSAGE' })).toBe(55);
    expect(operationType({ type: 'SOMETHING' })).toBeNull();
    expect(operationType({})).toBeNull();
  });

  it('records the conversation as seen (direct chat = the other party)', async () => {
    const seen = new Set<string>();
    await run([{ revision: 1, type: 26, message: sealed() }, { revision: 2, type: 25, message: sealed({ from: ME, to: CHAT, toType: 2 }) }], passthrough, seen);
    expect([...seen].sort()).toEqual([CHAT, PEER].sort());
  });

  it('does not record a conversation for a failed decrypt', async () => {
    const seen = new Set<string>();
    await run([{ revision: 1, type: 26, message: sealed() }], failing, seen);
    expect(seen.size).toBe(0);
  });
});

describe('read receipts (op 55)', () => {
  it('turns NOTIFIED_READ_MESSAGE into a receipt with an ISO readAt', async () => {
    const result = await run([receipt()]);
    expect(result.operations).toEqual([]);
    expect(result.readReceipts).toEqual([{ chatId: CHAT, readerMid: PEER, messageId: '12345', readAt: '2023-11-14T22:13:20.000Z' }]);
  });

  it('accepts a string createdTime of digits', async () => {
    const result = await run([receipt({ createdTime: '1700000000000' })]);
    expect(result.readReceipts).toHaveLength(1);
  });

  it('drops malformed receipts and counts them', async () => {
    const counters = { readReceiptShapeDropped: 0, readReceiptOverflowDropped: 0 };
    const result = await run(
      [
        receipt({ param1: 'x'.repeat(33) }),
        receipt({ param2: `c${'b'.repeat(32)}` }),
        receipt({ param3: 12345 }),
        receipt({ param3: 'abc' }),
        receipt({ createdTime: 0 }),
        receipt({ createdTime: 8.64e15 + 1 }),
        receipt({ createdTime: undefined }),
        receipt({ param1: `U${'A'.repeat(32)}` }),
      ],
      passthrough,
      new Set(),
      counters,
    );
    expect(result.readReceipts).toBeUndefined();
    expect(counters.readReceiptShapeDropped).toBe(8);
  });

  it('ignores our own read receipt', async () => {
    const result = await run([receipt({ param2: ME })]);
    expect(result.readReceipts).toBeUndefined();
  });

  it('keeps the highest message id per (chat, reader), compared exactly beyond 2^53', async () => {
    const result = await run([
      receipt({ param3: '9007199254740993' }),
      receipt({ param3: '9007199254740994', createdTime: 1_700_000_001_000 }),
      receipt({ param3: '9007199254740992' }),
      receipt({ param2: `u${'c'.repeat(32)}`, param3: '5' }),
    ]);
    expect(result.readReceipts).toHaveLength(2);
    expect(result.readReceipts![0]).toMatchObject({ readerMid: PEER, messageId: '9007199254740994', readAt: '2023-11-14T22:13:21.000Z' });
  });

  it('caps receipts at 500 and counts the overflow', async () => {
    const counters = { readReceiptShapeDropped: 0, readReceiptOverflowDropped: 0 };
    const ops = Array.from({ length: 501 }, (_, i) => receipt({ revision: 1000 + i, param2: `u${i.toString(16).padStart(32, '0')}` }));
    const result = await run(ops, passthrough, new Set(), counters);
    expect(result.readReceipts).toHaveLength(500);
    expect(counters.readReceiptOverflowDropped).toBe(1);
  });
});

describe('catch-up chats', () => {
  it('names a chat first sighted through a receipt once', async () => {
    const seen = new Set<string>();
    const first = await run([receipt(), receipt({ param3: '99' })], passthrough, seen);
    expect(first.catchupChatIds).toEqual([CHAT]);
    expect(seen.has(CHAT)).toBe(true);
    expect((await run([receipt()], passthrough, seen)).catchupChatIds).toEqual([]);
  });

  it('does not name a chat already seen through a message in the same batch', async () => {
    const result = await run([{ revision: 1, type: 26, message: sealed({ from: PEER, to: CHAT, toType: 2 }) }, receipt()]);
    expect(result.catchupChatIds).toEqual([]);
  });

  it('only for u/c/r mids', async () => {
    const result = await run([receipt({ param1: `s${'1'.repeat(32)}` })]);
    expect(result.catchupChatIds).toEqual([]);
    expect(result.readReceipts).toBeUndefined();
  });

  it('catch-up rows become oldest-first history items; undecryptable ones are skipped', async () => {
    const rows = [
      { id: '3', from: PEER, to: ME, text: 'newest', chunks: [] },
      { id: '2', from: PEER, to: ME, chunks: ['a', 'b', 'c'] },
      { id: '1', from: PEER, to: ME, text: 'oldest', chunks: [] },
    ];
    const decryptor: ChromeMessageDecryptor = {
      async decrypt(m) {
        if (m.id === '2') throw new Error('no key');
        return m;
      },
    };
    const items = await buildCatchupItems(rows, decryptor);
    expect(items).toEqual([
      { source: 'history', operation: { revision: '1', message: rows[2] } },
      { source: 'history', operation: { revision: '3', message: rows[0] } },
    ]);
  });
});

describe('end to end with the E2EE manager', () => {
  it('decrypts a sealed message sent by the peer', async () => {
    const bridge = new FakeE2eeBridge();
    bridge.pubs.set(1, 'pub-me');
    bridge.pubs.set(2, 'pub-peer');
    const api = new FakeKeyApi();
    api.publicKeys.set(`${ME}:11`, { keyData: 'pub-me', keyId: 11 });
    api.publicKeys.set(`${PEER}:22`, { keyData: 'pub-peer', keyId: 22 });
    api.negotiation.set(ME, { publicKey: { keyData: 'pub-me', keyId: 11 }, specVersion: 2 });
    const login = (h: number, k: number): QrLoginE2ee => ({ handles: { [k]: h }, exported: { mid: null, latestKeyId: k, keys: { [k]: `b${h}` } } });
    const peer = new ChromeE2ee({ bridge, api, store: new FakeStore(PEER) });
    peer.adoptLogin(login(2, 22));
    const me = new ChromeE2ee({ bridge, api, store: new FakeStore(ME) });
    me.adoptLogin(login(1, 11));

    const wire = await peer.encrypt({ to: ME, toType: 0, contentType: 0, contentMetadata: {}, text: 'hi there' });
    const message = { ...wire, id: '9007199254740993', from: PEER };
    const result = await run([{ revision: '9007199254740994', type: 26, message }], me);
    expect(result.operations).toHaveLength(1);
    expect(result.operations[0]).toMatchObject({ revision: '9007199254740994', message: { id: '9007199254740993', text: 'hi there', from: PEER } });
  });

  it('chromeCursor keeps the revision a decimal string', () => {
    expect(chromeCursor('9007199254740993')).toEqual({ version: 1, revision: '9007199254740993', globalRev: '0', individualRev: '0' });
  });
});
