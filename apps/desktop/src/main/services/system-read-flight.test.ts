import { describe, expect, it, vi } from 'vitest';
import { createSingleFlightRead } from './system-read-flight.js';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

describe('single-flight system reads', () => {
  it('shares an overlapping burst and returns to an idle timer baseline after drain', async () => {
    vi.useFakeTimers();
    try {
      const source = deferred<void>();
      let reads = 0;
      const read = createSingleFlightRead({ createState: () => ({ ready: false }), timeoutMs: 5000,
        start: async (state) => { reads += 1; await source.promise; state.ready = true; }, drain: async () => undefined });
      const baselineTimers = vi.getTimerCount();
      const burst = Array.from({ length: 40 }, () => read());
      expect(reads).toBe(1);
      source.resolve();
      await expect(Promise.all(burst)).resolves.toEqual(Array.from({ length: 40 }, () => ({ ready: true })));
      await Promise.resolve();
      expect(vi.getTimerCount()).toBe(baselineTimers);
      await expect(read()).resolves.toEqual({ ready: true });
      expect(reads).toBe(2);
    } finally { vi.useRealTimers(); }
  });

  it('keeps an unabortable source fenced after the caller deadline until source and drain settle', async () => {
    vi.useFakeTimers();
    try {
      const source = deferred<void>();
      const drain = deferred<void>();
      let reads = 0;
      const read = createSingleFlightRead({ createState: () => ({ completed: false }), timeoutMs: 5000,
        start: async (state) => { reads += 1; await source.promise; state.completed = true; }, drain: () => drain.promise });
      const first = read();
      const burst = Array.from({ length: 20 }, () => read());
      await vi.advanceTimersByTimeAsync(5000);
      await expect(first).resolves.toEqual({ completed: false });
      await expect(Promise.all(burst)).resolves.toEqual(Array.from({ length: 20 }, () => ({ completed: false })));
      await read();
      expect(reads).toBe(1);

      source.resolve();
      for (let attempt = 0; attempt < 10; attempt += 1) await Promise.resolve();
      await read();
      expect(reads).toBe(1);
      drain.resolve();
      for (let attempt = 0; attempt < 10; attempt += 1) await Promise.resolve();
      await read();
      expect(reads).toBe(2);
      expect(vi.getTimerCount()).toBe(0);
    } finally { vi.useRealTimers(); }
  });
});
