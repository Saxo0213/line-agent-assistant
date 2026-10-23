import { describe, expect, it, vi } from 'vitest';
import { StartupCleanup } from './startup-cleanup.js';

describe('StartupCleanup', () => {
  it('unwinds activated owners in reverse order and attempts all cleanup after a rejection', async () => {
    const cleanup = new StartupCleanup();
    const calls: string[] = [];
    cleanup.add(async () => { calls.push('pool'); });
    cleanup.add(async () => { calls.push('bridge'); throw new Error('bridge cleanup'); });
    cleanup.add(async () => { calls.push('workers'); });

    await expect(cleanup.unwind()).rejects.toMatchObject({
      errors: [expect.objectContaining({ message: 'bridge cleanup' })],
    });
    expect(calls).toEqual(['workers', 'bridge', 'pool']);
  });

  it('is idempotent across repeated failure and drain attempts', async () => {
    const cleanup = new StartupCleanup();
    const close = vi.fn();
    cleanup.add(close);

    await cleanup.unwind();
    await cleanup.unwind();
    expect(close).toHaveBeenCalledTimes(1);
  });

  it('transfers cleanup ownership after successful startup', async () => {
    const cleanup = new StartupCleanup();
    const close = vi.fn();
    cleanup.add(close);
    cleanup.commit();

    await cleanup.unwind();
    expect(close).not.toHaveBeenCalled();
  });

  it('preserves the startup failure alongside cleanup failures', async () => {
    const cleanup = new StartupCleanup();
    const original = new Error('settings failed');
    cleanup.add(async () => { throw new Error('pool close failed'); });

    await expect(cleanup.unwind(original)).rejects.toMatchObject({
      errors: [original, expect.objectContaining({ message: 'pool close failed' })],
    });
  });

  it('fences producers and drains paused callbacks before releasing startup owners', async () => {
    const cleanup = new StartupCleanup();
    const calls: string[] = [];
    let finishCallback!: () => void;
    const callback = new Promise<void>((resolve) => { finishCallback = resolve; });
    cleanup.beforeUnwind(async () => {
      calls.push('fence');
      await callback;
      calls.push('room-effects-idle');
    });
    cleanup.add(async () => { calls.push('pool-close'); });

    const failure = cleanup.unwind(new Error('bind failed'));
    await Promise.resolve();
    expect(calls).toEqual(['fence']);
    finishCallback();
    await expect(failure).rejects.toThrow('bind failed');
    expect(calls).toEqual(['fence', 'room-effects-idle', 'pool-close']);
  });

  it('runs ordered shutdown actions sequentially and keeps going after a rejection', async () => {
    const { runCleanupInOrder } = await import('./startup-cleanup.js');
    const calls: string[] = [];
    let releaseRoomEffect!: () => void;
    const roomEffect = new Promise<void>((resolve) => { releaseRoomEffect = resolve; });
    const closing = runCleanupInOrder([
      async () => { calls.push('room-effects-start'); await roomEffect; calls.push('room-effects-done'); throw new Error('room effect drain failed'); },
      async () => { calls.push('audit-flush'); throw new Error('audit flush failed'); },
      async () => { calls.push('pool-close'); throw new Error('pool close failed'); },
    ]);
    await Promise.resolve();
    expect(calls).toEqual(['room-effects-start']);
    releaseRoomEffect();
    await expect(closing).resolves.toEqual([
      expect.objectContaining({ message: 'room effect drain failed' }),
      expect.objectContaining({ message: 'audit flush failed' }),
      expect.objectContaining({ message: 'pool close failed' }),
    ]);
    expect(calls).toEqual(['room-effects-start', 'room-effects-done', 'audit-flush', 'pool-close']);
  });

  it('returns to baseline after repeated failures with a paused tracked callback', async () => {
    let live = 0;
    for (let attempt = 0; attempt < 20; attempt++) {
      const cleanup = new StartupCleanup();
      let finishCallback!: () => void;
      const callback = new Promise<void>((resolve) => { finishCallback = resolve; });
      let accepting = true;
      live++;
      cleanup.beforeUnwind(async () => {
        accepting = false;
        await callback;
      });
      cleanup.add(() => { live--; });
      const failure = cleanup.unwind(new Error('simulated bind failure'));
      await Promise.resolve();
      expect(accepting).toBe(false);
      expect(live).toBe(1);
      finishCallback();
      await expect(failure).rejects.toThrow('simulated bind failure');
      expect(live).toBe(0);
    }
  });

  it('returns to the same resource baseline after repeated prepare and drain bursts', async () => {
    const baseline = 0;
    let live = baseline;
    for (let burst = 0; burst < 20; burst++) {
      const cleanup = new StartupCleanup();
      for (let owner = 0; owner < 5; owner++) {
        live++;
        cleanup.add(() => { live--; });
      }
      await cleanup.unwind();
      expect(live).toBe(baseline);
    }
  });
});
