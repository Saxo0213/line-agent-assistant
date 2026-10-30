// Bounded receive buffer between the SSE receiver and the worker's poll/ack `sync(cursor)` (design brief, "Fitting into
// poll/ack"). It adds no LINE traffic: the receiver fills it, `drain(cursor)` empties it.
//
// Revisions are NOT contiguous (they interleave with ops this account never sees), so a gap cannot be detected by
// counting. Continuity is instead tracked per stream epoch: an epoch starts when the receiver is started or reopened at
// some localRev, and from then on every operation above that revision is delivered (reconnects inside an epoch resume
// from the highest received revision). A cursor BELOW the epoch floor, an overflow, or a stream that was never started
// therefore means the buffer cannot continue from the cursor, and the stream is reopened at `localRev = cursor.revision`.

import type { ReceiverSink, ReceiverState } from './sse.js';
import { systemClock, type ReceiveClock } from './sse.js';
import { opRevision, toRevision, type ChromeOperation } from './types.js';

export const RECEIVE_BATCH_LIMIT = 100;
export const RECEIVE_BUFFER_OVERFLOW = 1000;
export const RECEIVE_MAX_WAIT_MS = 1000;

/** What the buffer needs from the receiver. `ChromeSseReceiver` satisfies it. */
export interface ReceiverControl {
  readonly state: ReceiverState;
  start(localRev: string): void;
  reopen(localRev: string): void;
  stop(): void;
}

export interface DrainOptions {
  /** Wait at most this long for something to arrive when the buffer is empty. Clamped to 1000 ms. Default 0. */
  readonly waitMs?: number;
  /** Take at most this many operations. Clamped to 0..RECEIVE_BATCH_LIMIT. Default RECEIVE_BATCH_LIMIT. */
  readonly limit?: number;
}

export interface DrainResult {
  /** Operations above the cursor, ascending by revision, at most 100. */
  readonly operations: ChromeOperation[];
  /** Highest taken revision, or the fullSync jump target; never below the cursor. Decimal string. */
  readonly cursorAfter: string;
  /** A fullSync/partialFullSync moved the cursor past history we never received (catch-up may be needed). */
  readonly jumped: boolean;
  /** The stream was reopened at the cursor during this drain (gap, overflow, or first start). */
  readonly reopened: boolean;
  /** The receiver is terminally disconnected (degraded status); only a manual start/reopen revives it. */
  readonly disconnected: boolean;
}

interface Entry {
  readonly rev: bigint;
  readonly op: ChromeOperation;
}

export class ReceiveBuffer implements ReceiverSink {
  private entries: Entry[] = [];
  private epochFloor: bigint | null = null;
  private pendingJump: bigint | null = null;
  private needsReopen = false;
  private waiters: Array<() => void> = [];
  private readonly clock: ReceiveClock;
  private control: ReceiverControl | undefined;
  private overflowCount = 0;
  private readonly overflowLimit: number;

  constructor(options: { clock?: ReceiveClock; overflowLimit?: number } = {}) {
    this.clock = options.clock ?? systemClock;
    this.overflowLimit = options.overflowLimit ?? RECEIVE_BUFFER_OVERFLOW;
  }

  /** Late binding: the receiver needs the buffer as its sink, the buffer needs the receiver as its control. */
  attach(control: ReceiverControl): void {
    this.control = control;
  }

  get size(): number {
    return this.entries.length;
  }

  get overflows(): number {
    return this.overflowCount;
  }

  // -- ReceiverSink -------------------------------------------------------------------------------------------------

  onEpoch(localRev: string): void {
    this.epochFloor = BigInt(localRev);
    this.entries = []; // everything above localRev is about to be (re)delivered by the new stream
    this.pendingJump = null;
    this.needsReopen = false;
  }

  onOperations(operations: ChromeOperation[]): void {
    for (const op of operations) {
      const rev = opRevision(op);
      if (rev === null) continue;
      this.insert({ rev, op });
    }
    if (this.entries.length > this.overflowLimit) {
      // Overflow: drop everything, close the stream, and reopen from the durable cursor on the next sync.
      this.entries = [];
      this.pendingJump = null;
      this.needsReopen = true;
      this.overflowCount += 1;
      this.control?.stop();
    }
    this.notify();
  }

  onFullSync(nextRevision: string): void {
    const next = toRevision(nextRevision);
    if (next === null) return;
    if (this.pendingJump === null || next > this.pendingJump) this.pendingJump = next;
    this.notify();
  }

  // -- poll side ----------------------------------------------------------------------------------------------------

  async drain(cursorRevision: string, options: DrainOptions = {}): Promise<DrainResult> {
    const cursor = toRevision(cursorRevision);
    if (cursor === null) throw new RangeError(`invalid cursor revision ${JSON.stringify(cursorRevision)}`);
    const waitMs = Math.min(Math.max(options.waitMs ?? 0, 0), RECEIVE_MAX_WAIT_MS);

    const reopened = this.ensureStream(cursor);
    if (reopened) return this.result([], cursor, false, true);

    if (waitMs > 0 && !this.hasDeliverable(cursor)) await this.waitForData(waitMs);
    // A wait can race an overflow or an epoch change.
    if (this.needsReopen) return this.result([], cursor, false, this.ensureStream(cursor));
    const limit = Math.min(Math.max(Math.trunc(options.limit ?? RECEIVE_BATCH_LIMIT), 0), RECEIVE_BATCH_LIMIT);
    return this.take(cursor, limit);
  }

  /**
   * Hands out the next batch WITHOUT removing it: the cursor is the ack. A retry with the same cursor (the worker failed to
   * persist the batch) returns the same operations; operations are dropped when a later drain carries a cursor past them.
   */
  private take(cursor: bigint, limit: number): DrainResult {
    this.entries = this.entries.filter((e) => e.rev > cursor);
    if (this.pendingJump !== null && cursor >= this.pendingJump) this.pendingJump = null; // the jump has been acked
    const batch = this.entries.slice(0, limit);
    const rest = this.entries.slice(batch.length);
    let after = batch.length > 0 ? batch[batch.length - 1]!.rev : cursor;
    let jumped = false;
    // First sighting (cursor 0): the seeded stream floor is the starting point, not an unseen-history jump.
    if (cursor === 0n && this.epochFloor !== null && this.epochFloor > after) after = this.epochFloor;
    const jump = this.pendingJump;
    if (jump !== null && (rest.length === 0 || rest[0]!.rev > jump) && jump > after) {
      // Everything at or below the jump is in this batch: the cursor can leap over the history we never received.
      after = jump;
      jumped = true;
    }
    return this.result(
      batch.map((e) => e.op),
      after,
      jumped,
      false,
    );
  }

  /**
   * Makes sure a stream exists that continues from `cursor`. Returns true when it (re)opened one, in which case there is
   * nothing to hand out yet. A terminally disconnected receiver is left alone (manual reconnect only).
   */
  private ensureStream(cursor: bigint): boolean {
    const control = this.control;
    if (!control) return false;
    const kind = control.state.kind;
    if (kind === 'disconnected') return false;
    if (kind === 'idle') {
      this.entries = [];
      control.start(cursor.toString());
      return true;
    }
    // cursor 0 means "first sighting": the receiver seeds from getLastOpRevision and the cursor jumps to it.
    const behind = this.epochFloor !== null && cursor !== 0n && cursor < this.epochFloor;
    // A receiver stopped from outside (revoke) stays stopped; only our own overflow stop is reopened.
    if (this.needsReopen || behind) {
      this.entries = [];
      this.pendingJump = null;
      this.needsReopen = false;
      // Cursor 0 after a seeded start: reopen at the seed. A new seed would skip the operations that were dropped.
      const reopenAt = cursor === 0n && this.epochFloor !== null ? this.epochFloor : cursor;
      control.reopen(reopenAt.toString());
      return true;
    }
    return false;
  }

  private hasDeliverable(cursor: bigint): boolean {
    if (this.pendingJump !== null && this.pendingJump > cursor) return true;
    return this.entries.some((e) => e.rev > cursor);
  }

  private waitForData(ms: number): Promise<void> {
    return new Promise<void>((resolve) => {
      let handle: unknown;
      const done = (): void => {
        if (handle !== undefined) this.clock.clearTimeout(handle);
        this.waiters = this.waiters.filter((w) => w !== done);
        resolve();
      };
      handle = this.clock.setTimeout(done, ms);
      this.waiters.push(done);
    });
  }

  private notify(): void {
    for (const waiter of [...this.waiters]) waiter();
  }

  private insert(entry: Entry): void {
    const list = this.entries;
    const last = list[list.length - 1];
    if (!last || entry.rev > last.rev) {
      list.push(entry);
      return;
    }
    // Out-of-order arrival: keep ascending order and drop duplicates.
    let i = list.length - 1;
    while (i >= 0 && list[i]!.rev > entry.rev) i -= 1;
    if (i >= 0 && list[i]!.rev === entry.rev) return;
    list.splice(i + 1, 0, entry);
  }

  private result(operations: ChromeOperation[], after: bigint, jumped: boolean, reopened: boolean): DrainResult {
    return {
      operations,
      cursorAfter: after.toString(),
      jumped,
      reopened,
      disconnected: this.control?.state.kind === 'disconnected',
    };
  }
}
