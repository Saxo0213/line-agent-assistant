import { getEventListeners } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import type { Pool } from 'pg';
import type { ReprojectionOptions, ReprojectionResult } from '@line-agent/database';
import { ContentReprojectionService } from './content-reprojection-service.js';

const pool = {} as Pool;
const result: ReprojectionResult = { rows: 3, batches: 1, cancelled: false };
const deferred = () => { let resolve!: (value: ReprojectionResult) => void; const promise = new Promise<ReprojectionResult>((r) => { resolve = r; }); return { promise, resolve }; };

describe('content re-projection service lifecycle', () => {
  it('runs one job per process: a second start, even from another service instance, is a no-op', async () => {
    const gate = deferred();
    const run = vi.fn(() => gate.promise);
    const first = new ContentReprojectionService(pool, { run });
    const second = new ContentReprojectionService(pool, { run });
    first.start(); first.start(); second.start();
    expect(run).toHaveBeenCalledTimes(1);
    gate.resolve(result);
    await first.shutdown();
    // Once the run has drained, the process-wide guard is released.
    const third = new ContentReprojectionService(pool, { run: vi.fn(async () => result) });
    third.start();
    await third.shutdown();
  });

  it('hands the job a signal that shutdown aborts, and waits for the batch in flight to finish', async () => {
    const gate = deferred();
    let signal: AbortSignal | undefined;
    const finished = vi.fn();
    const service = new ContentReprojectionService(pool, { onFinished: finished,
      run: async (_pool: Pool, options: ReprojectionOptions) => { signal = options.signal; await gate.promise; return { rows: 2, batches: 1, cancelled: options.signal?.aborted === true }; } });
    service.start();
    const stopping = service.shutdown();
    expect(signal?.aborted).toBe(true);
    let drained = false;
    void stopping.then(() => { drained = true; });
    await new Promise((resolve) => setImmediate(resolve));
    expect(drained).toBe(false);
    gate.resolve(result);
    await stopping;
    expect(finished).toHaveBeenCalledWith({ rows: 2, batches: 1, cancelled: true });
    expect(getEventListeners(signal!, 'abort')).toHaveLength(0);
  });

  it('bounds the shutdown wait when a batch never finishes, and leaves no timer behind', async () => {
    const hung = new Promise<ReprojectionResult>(() => undefined);
    const service = new ContentReprojectionService(pool, { run: () => hung, drainMs: 20 });
    service.start();
    const before = process.getActiveResourcesInfo().filter((name) => name === 'Timeout').length;
    await service.shutdown();
    expect(process.getActiveResourcesInfo().filter((name) => name === 'Timeout').length).toBeLessThanOrEqual(before);
  });

  it('reports a failed run without throwing, and never starts after shutdown', async () => {
    const onError = vi.fn();
    const failing = new ContentReprojectionService(pool, { run: async () => { throw new Error('boom'); }, onError });
    failing.start();
    await failing.shutdown();
    expect(onError).toHaveBeenCalledTimes(1);
    const run = vi.fn(async () => result);
    const stopped = new ContentReprojectionService(pool, { run });
    await stopped.shutdown();
    stopped.start();
    expect(run).not.toHaveBeenCalled();
  });
});
