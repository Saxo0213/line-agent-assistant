import { describe, expect, it } from 'vitest';
import { RECEIVE_BATCH_LIMIT, RECEIVE_BUFFER_OVERFLOW, ReceiveBuffer, type ReceiverControl } from './receive-buffer.js';
import type { ReceiverState } from './sse.js';
import { ManualClock, flush, op } from './receive.testkit.js';

class FakeControl implements ReceiverControl {
  state: ReceiverState = { kind: 'idle' };
  readonly calls: string[] = [];
  start(localRev: string): void {
    this.calls.push(`start:${localRev}`);
    this.state = { kind: 'open' };
  }
  reopen(localRev: string): void {
    this.calls.push(`reopen:${localRev}`);
    this.state = { kind: 'open' };
  }
  stop(): void {
    this.calls.push('stop');
    this.state = { kind: 'stopped' };
  }
}

function setup(epoch?: string) {
  const clock = new ManualClock();
  const control = new FakeControl();
  const buffer = new ReceiveBuffer({ clock });
  buffer.attach(control);
  if (epoch !== undefined) {
    control.state = { kind: 'open' };
    buffer.onEpoch(epoch);
  }
  return { clock, control, buffer };
}

const range = (from: number, to: number) => Array.from({ length: to - from + 1 }, (_, i) => op(from + i));
const revs = (r: { operations: Array<{ revision?: number | string }> }) => r.operations.map((o) => Number(o.revision));

describe('drain / ack', () => {
  it('starts the stream at the cursor on the first drain', async () => {
    const { control, buffer } = setup();
    const r = await buffer.drain('42');
    expect(control.calls).toEqual(['start:42']);
    expect(r).toMatchObject({ operations: [], cursorAfter: '42', reopened: true });
  });

  it('hands out operations above the cursor in order; the cursor is the ack', async () => {
    const { buffer } = setup('10');
    buffer.onOperations(range(11, 13));
    const first = await buffer.drain('10');
    expect(revs(first)).toEqual([11, 12, 13]);
    expect(first.cursorAfter).toBe('13');
    expect(buffer.size).toBe(3); // not removed until acknowledged
    const second = await buffer.drain('13');
    expect(second.operations).toEqual([]);
    expect(second.cursorAfter).toBe('13');
    expect(buffer.size).toBe(0);
  });

  it('limit takes fewer operations; limit 0 takes none and leaves the cursor; the limit is clamped to 0..100', async () => {
    const { buffer } = setup('10');
    buffer.onOperations(range(11, 130));
    const few = await buffer.drain('10', { limit: 80 });
    expect(revs(few)).toEqual(range(11, 90).map((o) => Number(o.revision)));
    expect(few.cursorAfter).toBe('90');
    const none = await buffer.drain('90', { limit: 0 });
    expect(none.operations).toEqual([]);
    expect(none.cursorAfter).toBe('90');
    expect((await buffer.drain('90', { limit: 5000 })).operations).toHaveLength(40);
    expect((await buffer.drain('90', { limit: -3 })).operations).toEqual([]);
  });

  it('a retry with the same cursor (batch not persisted) returns the same operations', async () => {
    const { buffer } = setup('10');
    buffer.onOperations(range(11, 12));
    expect(revs(await buffer.drain('10'))).toEqual([11, 12]);
    expect(revs(await buffer.drain('10'))).toEqual([11, 12]);
  });

  it('drops operations at or below the cursor', async () => {
    const { buffer } = setup('10');
    buffer.onOperations(range(11, 25));
    const r = await buffer.drain('20');
    expect(revs(r)).toEqual([21, 22, 23, 24, 25]);
    expect(buffer.size).toBe(5);
  });

  it('takes at most 100 per drain and walks the rest on later cursors', async () => {
    const { buffer } = setup('0');
    buffer.onOperations(range(1, 250));
    const a = await buffer.drain('0');
    expect(a.operations).toHaveLength(RECEIVE_BATCH_LIMIT);
    expect(a.cursorAfter).toBe('100');
    const b = await buffer.drain(a.cursorAfter);
    expect(revs(b)[0]).toBe(101);
    expect(b.operations).toHaveLength(100);
    const c = await buffer.drain(b.cursorAfter);
    expect(c.operations).toHaveLength(50);
    expect(c.cursorAfter).toBe('250');
  });

  it('orders out-of-order arrivals and ignores duplicates and revision-less operations', async () => {
    const { buffer } = setup('10');
    buffer.onOperations([op(13), op(11)]);
    buffer.onOperations([op(12), op(11), { type: 26 }, op(0)]);
    expect(revs(await buffer.drain('10'))).toEqual([11, 12, 13]);
  });

  it('compares revisions beyond 2^53 exactly', async () => {
    const { buffer } = setup('9007199254740992');
    buffer.onOperations([op('9007199254740994'), op('9007199254740993')]);
    const r = await buffer.drain('9007199254740992');
    expect(r.operations.map((o) => o.revision)).toEqual(['9007199254740993', '9007199254740994']);
    expect(r.cursorAfter).toBe('9007199254740994');
    expect((await buffer.drain('9007199254740993')).operations).toHaveLength(1);
  });

  it('rejects a malformed cursor', async () => {
    const { buffer } = setup('1');
    await expect(buffer.drain('abc')).rejects.toThrow(RangeError);
    await expect(buffer.drain('-1')).rejects.toThrow(RangeError);
  });
});

describe('first sighting (cursor 0)', () => {
  it('does not treat the seeded floor as a gap; the cursor leaps to it', async () => {
    const { control, buffer } = setup('5000');
    const r = await buffer.drain('0');
    expect(control.calls).toEqual([]);
    expect(r).toMatchObject({ operations: [], cursorAfter: '5000', jumped: false, reopened: false });
  });

  it('delivers operations that arrive after the seeded floor', async () => {
    const { buffer } = setup('5000');
    buffer.onOperations([op(5001)]);
    const r = await buffer.drain('0');
    expect(revs(r)).toEqual([5001]);
    expect(r.cursorAfter).toBe('5001');
  });
});

describe('gap and overflow reopen the stream at the cursor', () => {
  it('reopens at cursor.revision when the cursor is behind the stream epoch', async () => {
    const { control, buffer } = setup('100');
    buffer.onOperations(range(101, 103));
    const r = await buffer.drain('50');
    expect(control.calls).toEqual(['reopen:50']);
    expect(r).toMatchObject({ operations: [], cursorAfter: '50', reopened: true });
    expect(buffer.size).toBe(0);
    // the receiver announces the new epoch and redelivers from the cursor
    buffer.onEpoch('50');
    buffer.onOperations(range(51, 52));
    expect(revs(await buffer.drain('50'))).toEqual([51, 52]);
    expect(control.calls).toEqual(['reopen:50']);
  });

  it('a cursor at or above the epoch floor is continuous', async () => {
    const { control, buffer } = setup('100');
    await buffer.drain('100');
    await buffer.drain('150');
    expect(control.calls).toEqual([]);
  });

  it('closes the stream on overflow and reopens at the durable cursor on the next drain', async () => {
    const { control, buffer } = setup('10');
    buffer.onOperations(range(11, 11 + RECEIVE_BUFFER_OVERFLOW)); // 1001 operations
    expect(control.calls).toEqual(['stop']);
    expect(buffer.size).toBe(0);
    expect(buffer.overflows).toBe(1);
    const r = await buffer.drain('10');
    expect(control.calls).toEqual(['stop', 'reopen:10']);
    expect(r).toMatchObject({ operations: [], cursorAfter: '10', reopened: true });
    buffer.onEpoch('10');
    buffer.onOperations(range(11, 12));
    expect(revs(await buffer.drain('10'))).toEqual([11, 12]);
  });

  it('exactly the limit does not overflow', () => {
    const { control, buffer } = setup('10');
    buffer.onOperations(range(11, 10 + RECEIVE_BUFFER_OVERFLOW));
    expect(control.calls).toEqual([]);
    expect(buffer.size).toBe(RECEIVE_BUFFER_OVERFLOW);
  });

  it('does not restart a receiver that was stopped from outside (revoke)', async () => {
    const { control, buffer } = setup('10');
    control.state = { kind: 'stopped' };
    const r = await buffer.drain('10');
    expect(control.calls).toEqual([]);
    expect(r.reopened).toBe(false);
  });

  it('never revives a terminally disconnected receiver, and says so', async () => {
    const { control, buffer } = setup('10');
    buffer.onOperations(range(11, 11));
    control.state = { kind: 'disconnected', failures: 144, error: 'x', authRejected: false };
    const r = await buffer.drain('5');
    expect(control.calls).toEqual([]);
    expect(r.disconnected).toBe(true);
    expect(revs(r)).toEqual([11]);
  });
});

describe('fullSync / partialFullSync jump', () => {
  it('moves the cursor past history that was never received', async () => {
    const { buffer } = setup('10');
    buffer.onFullSync('500');
    const r = await buffer.drain('10');
    expect(r).toMatchObject({ operations: [], cursorAfter: '500', jumped: true });
    // retry before the ack: same answer; after the ack the jump is spent
    expect((await buffer.drain('10')).cursorAfter).toBe('500');
    const acked = await buffer.drain('500');
    expect(acked).toMatchObject({ cursorAfter: '500', jumped: false });
  });

  it('hands out buffered operations below the jump first, then jumps', async () => {
    const { buffer } = setup('10');
    buffer.onOperations(range(11, 12));
    buffer.onFullSync('500');
    buffer.onOperations([op(501)]);
    const r = await buffer.drain('10');
    expect(revs(r)).toEqual([11, 12, 501]);
    expect(r.cursorAfter).toBe('501');
  });

  it('defers the jump while earlier operations remain beyond the batch limit', async () => {
    const { buffer } = setup('0');
    buffer.onOperations(range(1, 150));
    buffer.onFullSync('500');
    const a = await buffer.drain('0');
    expect(a.cursorAfter).toBe('100');
    expect(a.jumped).toBe(false);
    const b = await buffer.drain('100');
    expect(b.operations).toHaveLength(50);
    expect(b).toMatchObject({ cursorAfter: '500', jumped: true });
  });

  it('keeps only the highest jump and ignores garbage', async () => {
    const { buffer } = setup('10');
    buffer.onFullSync('300');
    buffer.onFullSync('200');
    buffer.onFullSync('nope');
    expect((await buffer.drain('10')).cursorAfter).toBe('300');
  });

  it('a new epoch discards a pending jump', async () => {
    const { buffer } = setup('10');
    buffer.onFullSync('500');
    buffer.onEpoch('10');
    expect((await buffer.drain('10')).cursorAfter).toBe('10');
  });
});

describe('bounded waiting', () => {
  it('returns as soon as something arrives', async () => {
    const { buffer } = setup('10');
    const pending = buffer.drain('10', { waitMs: 1000 });
    await flush();
    buffer.onOperations([op(11)]);
    expect(revs(await pending)).toEqual([11]);
  });

  it('gives up after the wait', async () => {
    const { clock, buffer } = setup('10');
    let done = false;
    const pending = buffer.drain('10', { waitMs: 400 }).then((r) => {
      done = true;
      return r;
    });
    await clock.advance(399);
    expect(done).toBe(false);
    await clock.advance(1);
    expect((await pending).operations).toEqual([]);
  });

  it('never waits longer than 1 s whatever the caller asks', async () => {
    const { clock, buffer } = setup('10');
    let done = false;
    const pending = buffer.drain('10', { waitMs: 60_000 }).then((r) => {
      done = true;
      return r;
    });
    await clock.advance(1000);
    await pending;
    expect(done).toBe(true);
  });

  it('does not wait when there is already something to hand out', async () => {
    const { clock, buffer } = setup('10');
    buffer.onOperations([op(11)]);
    expect(revs(await buffer.drain('10', { waitMs: 1000 }))).toEqual([11]);
    expect(clock.pending).toBe(0);
  });

  it('wakes for a jump too', async () => {
    const { buffer } = setup('10');
    const pending = buffer.drain('10', { waitMs: 1000 });
    await flush();
    buffer.onFullSync('99');
    expect((await pending).cursorAfter).toBe('99');
  });
});
