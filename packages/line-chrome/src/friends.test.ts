import { describe, expect, it } from 'vitest';
import { FriendCache, FriendListShapeError, FriendListStaleError, FRIEND_LOAD_RETRY_MS } from './friends.js';

const mid = (c: string): string => `u${c.repeat(32)}`;
const A = mid('a');
const B = mid('b');
const C = mid('c');
const op = (type: number, param1: string) => ({ revision: 1, type, param1 });

function loaders(contacts: unknown, blocked: unknown = []) {
  const calls = { contacts: 0, blocked: 0 };
  return { calls, loaders: {
    contactIds: async () => { calls.contacts += 1; return contacts; },
    blockedContactIds: async () => { calls.blocked += 1; return blocked; },
  } };
}

describe('FriendCache stale load (op 49 during the load)', () => {
  it('throws FriendListStaleError without a cooldown, and the next load starts at once', async () => {
    const cache = new FriendCache();
    let contactCalls = 0;
    const l = {
      contactIds: async () => {
        contactCalls += 1;
        await Promise.resolve(); // the load is registered now
        if (contactCalls === 1) cache.observe([op(49, A)]);
        return [A];
      },
    };
    await expect(cache.ensureLoaded(l)).rejects.toBeInstanceOf(FriendListStaleError);
    expect(cache.loaded).toBe(false);
    await cache.ensureLoaded(l); // no "failed recently" error: the stale load set no failedAt
    expect(contactCalls).toBe(2);
    expect(cache.relation(A)).toBe('friend');
  });
});

describe('FriendCache reset during a load', () => {
  it('discards the load, leaves failedAt null and lets the next check load again', async () => {
    const cache = new FriendCache();
    let contactCalls = 0;
    const l = {
      contactIds: async () => {
        contactCalls += 1;
        await Promise.resolve();
        if (contactCalls === 1) cache.reset();
        return contactCalls === 1 ? [A] : [B];
      },
    };
    await expect(cache.ensureLoaded(l)).rejects.toBeInstanceOf(FriendListStaleError);
    expect(cache.loaded).toBe(false);
    await cache.ensureLoaded(l); // no "failed recently" error: failedAt stayed null
    expect(contactCalls).toBe(2);
    expect(cache.relation(A)).toBe('not_friend');
    expect(cache.relation(B)).toBe('friend');
  });
});

describe('FriendCache', () => {
  it('loads once and answers from memory', async () => {
    const cache = new FriendCache();
    const { calls, loaders: l } = loaders([A, B], [B]);
    await cache.ensureLoaded(l);
    await cache.ensureLoaded(l);
    expect(cache.relation(A)).toBe('friend');
    expect(cache.relation(B)).toBe('not_friend');
    expect(cache.relation(C)).toBe('not_friend');
    expect(calls).toEqual({ contacts: 1, blocked: 1 });
    expect(cache.loadCount).toBe(1);
  });

  it('skips the blocked list when the endpoint is not provided', async () => {
    const cache = new FriendCache();
    await cache.ensureLoaded({ contactIds: async () => [A] });
    expect(cache.relation(A)).toBe('friend');
  });

  it('applies add, block, unblock and unregister operations (OkLine OpType 4, 6/68, 7/69, 33)', async () => {
    const cache = new FriendCache();
    await cache.ensureLoaded(loaders([A]).loaders);
    cache.observe([op(4, B), op(4, C)]);
    expect([cache.relation(B), cache.relation(C)]).toEqual(['friend', 'friend']);
    cache.observe([op(6, A), op(68, B)]);
    expect([cache.relation(A), cache.relation(B)]).toEqual(['not_friend', 'not_friend']);
    cache.observe([op(7, A), op(69, B)]);
    expect([cache.relation(A), cache.relation(B)]).toEqual(['friend', 'friend']);
    cache.observe([op(33, C)]);
    expect(cache.relation(C)).toBe('not_friend');
    cache.observe([{ type: 25, param1: A }, { type: 4, param1: 'not-a-mid' }, { type: '4', param1: 5 }]);
    expect(cache.relation(A)).toBe('friend');
  });

  it('ignores op 5: it is not an add', async () => {
    const cache = new FriendCache();
    await cache.ensureLoaded(loaders([A]).loaders);
    cache.observe([op(5, B)]);
    expect(cache.relation(B)).toBe('not_friend');
    expect(cache.relation(A)).toBe('friend');
    expect(cache.loaded).toBe(true);
  });

  it('op 49 resets the cache and the next check loads the lists once more', async () => {
    const cache = new FriendCache();
    const { calls, loaders: l } = loaders([A]);
    await cache.ensureLoaded(l);
    cache.observe([op(49, A), op(4, B)]); // the add after the reset in the same batch must not throw
    expect(cache.loaded).toBe(false);
    await cache.ensureLoaded(l);
    await cache.ensureLoaded(l);
    expect(calls.contacts).toBe(2);
    expect(cache.loadCount).toBe(2);
    expect(cache.relation(A)).toBe('friend');
  });

  it('keeps operations that arrive while the lists are loading', async () => {
    const cache = new FriendCache();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const loading = cache.ensureLoaded({ contactIds: async () => { await gate; return [A]; } });
    cache.observe([op(4, B), op(6, A)]);
    release();
    await loading;
    expect([cache.relation(A), cache.relation(B)]).toEqual(['not_friend', 'friend']);
  });

  it('ignores operations before any load (the load will include them)', () => {
    const cache = new FriendCache();
    cache.observe([op(4, A)]);
    expect(cache.loaded).toBe(false);
    expect(() => cache.relation(A)).toThrow();
  });

  it('rejects malformed lists and does not cache the failure beyond the retry window', async () => {
    let now = 1000;
    const cache = new FriendCache(() => now);
    await expect(cache.ensureLoaded({ contactIds: async () => ({}) })).rejects.toBeInstanceOf(FriendListShapeError);
    await expect(cache.ensureLoaded({ contactIds: async () => [A, 5] })).rejects.toThrow(/recently/); // inside the window: no request
    now += FRIEND_LOAD_RETRY_MS;
    await expect(cache.ensureLoaded({ contactIds: async () => [A, 5] })).rejects.toBeInstanceOf(FriendListShapeError);
    now += FRIEND_LOAD_RETRY_MS;
    await cache.ensureLoaded({ contactIds: async () => [A] });
    expect(cache.relation(A)).toBe('friend');
  });

  it('reset drops the cache so the next session loads again', async () => {
    const cache = new FriendCache();
    const { calls, loaders: l } = loaders([A]);
    await cache.ensureLoaded(l);
    cache.reset();
    expect(cache.loaded).toBe(false);
    await cache.ensureLoaded(l);
    expect(calls.contacts).toBe(2);
  });
});
