// Test doubles for the receive path: a manual clock and controllable SSE response bodies. No network.

import type { ReceiveClock } from './sse.js';
import type { ReceiverSink } from './sse.js';
import type { ChromeOperation } from './types.js';

const tick = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

/** Lets pending promise continuations and stream reads run. */
export async function flush(rounds = 8): Promise<void> {
  for (let i = 0; i < rounds; i += 1) await tick();
}

export class ManualClock implements ReceiveClock {
  private t = 1_000_000;
  private nextId = 1;
  private readonly timers = new Map<number, { at: number; callback: () => void }>();

  now(): number {
    return this.t;
  }
  setTimeout(callback: () => void, ms: number): unknown {
    const id = this.nextId++;
    this.timers.set(id, { at: this.t + ms, callback });
    return id;
  }
  clearTimeout(handle: unknown): void {
    this.timers.delete(handle as number);
  }
  get pending(): number {
    return this.timers.size;
  }

  /** Advances time, firing due timers in order and letting the code under test react between them. */
  async advance(ms: number): Promise<void> {
    const target = this.t + ms;
    await flush();
    for (;;) {
      let nextId: number | undefined;
      let nextAt = Number.POSITIVE_INFINITY;
      for (const [id, timer] of this.timers) {
        if (timer.at <= target && timer.at < nextAt) {
          nextAt = timer.at;
          nextId = id;
        }
      }
      if (nextId === undefined) break;
      const timer = this.timers.get(nextId)!;
      this.timers.delete(nextId);
      this.t = Math.max(this.t, timer.at);
      timer.callback();
      await flush();
    }
    this.t = target;
    await flush();
  }
}

/** A streaming response body the test writes to. */
export class FakeSseStream {
  private controller!: ReadableStreamDefaultController<Uint8Array>;
  closed = false;
  readonly response: Response;
  constructor(status = 200) {
    const body = new ReadableStream<Uint8Array>({
      start: (controller) => {
        this.controller = controller;
      },
      cancel: () => {
        this.closed = true;
      },
    });
    this.response = new Response(body, { status, headers: { 'content-type': 'text/event-stream' } });
  }
  write(text: string): void {
    this.controller.enqueue(new TextEncoder().encode(text));
  }
  end(): void {
    if (this.closed) return;
    this.closed = true;
    this.controller.close();
  }
}

export class RecordingSink implements ReceiverSink {
  readonly epochs: string[] = [];
  readonly batches: ChromeOperation[][] = [];
  readonly jumps: string[] = [];
  onEpoch(localRev: string): void {
    this.epochs.push(localRev);
  }
  onOperations(operations: ChromeOperation[]): void {
    this.batches.push(operations);
  }
  onFullSync(nextRevision: string): void {
    this.jumps.push(nextRevision);
  }
  get operations(): ChromeOperation[] {
    return this.batches.flat();
  }
}

export const frame = (data: unknown, event = '', id?: string): string =>
  `${event ? `event: ${event}\n` : ''}${id ? `id: ${id}\n` : ''}data: ${typeof data === 'string' ? data : JSON.stringify(data)}\n\n`;

export const op = (revision: number | string, extra: Record<string, unknown> = {}): ChromeOperation => ({
  revision,
  type: 26,
  createdTime: 1_700_000_000_000,
  ...extra,
});
