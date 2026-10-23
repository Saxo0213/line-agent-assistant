import { describe, expect, it, vi } from 'vitest';
import { createDomainEventPublisher } from './domain-event-publisher.js';
import { createCoalescedSnapshotPublisher } from './domain-event-publisher.js';

describe('domain event publisher', () => {
  it('forwards one event without requesting a full snapshot', () => {
    const send = vi.fn();
    const requestSnapshot = vi.fn();
    const publish = createDomainEventPublisher(send);

    publish({ type: 'attachmentChanged', attachmentId: 'attachment-1' });

    expect(send).toHaveBeenCalledOnce();
    expect(send).toHaveBeenCalledWith('line-agent:event', { type: 'attachmentChanged', attachmentId: 'attachment-1' });
    expect(requestSnapshot).not.toHaveBeenCalled();
  });

  it('coalesces concurrent durable-state refresh requests into one snapshot publication', async () => {
    const snapshot = vi.fn(async () => ({ control: { epoch: 1, activeAccountId: 'a', phase: 'idle' as const, targetAccountId: null }, defaultProvider: 'claude' as const,
      components: [], queueDepth: 0, accounts: [], conversations: [], jobs: [], providers: [] }));
    const publish = vi.fn();
    const update = createCoalescedSnapshotPublisher(snapshot, publish);

    await Promise.all([update(), update(), update()]);

    expect(snapshot).toHaveBeenCalledOnce();
    expect(publish).toHaveBeenCalledWith({ type: 'snapshotChanged', snapshot: expect.objectContaining({ control: expect.objectContaining({ epoch: 1 }) }) });
  });

  it('keeps sequential zero-delay snapshot requests behind the same frequency gate', async () => {
    vi.useFakeTimers();
    const snapshot = vi.fn(async () => ({ control: { epoch: 1, activeAccountId: 'a', phase: 'idle' as const, targetAccountId: null }, defaultProvider: 'claude' as const,
      components: [], queueDepth: 0, accounts: [], conversations: [], jobs: [], providers: [] }));
    const publish = vi.fn();
    const update = createCoalescedSnapshotPublisher(snapshot, publish, 100);

    try {
      await update();
      await Promise.all(Array.from({ length: 4 }, () => update()));
      expect(snapshot).toHaveBeenCalledOnce();
      expect(vi.getTimerCount()).toBe(1);
      update.shutdown();
      expect(vi.getTimerCount()).toBe(0);
    } finally { update.shutdown(); vi.useRealTimers(); }
  });

  it('lets repeated dirty requests return promptly while a snapshot is stalled and limits refresh frequency', async () => {
    vi.useFakeTimers();
    const makeSnapshot = async () => ({ control: { epoch: 1, activeAccountId: 'a', phase: 'idle' as const, targetAccountId: null }, defaultProvider: 'claude' as const,
      components: [], queueDepth: 0, accounts: [], conversations: [], jobs: [], providers: [] });
    let finish!: (value: Awaited<ReturnType<typeof makeSnapshot>>) => void;
    let calls = 0;
    const snapshot = vi.fn(() => calls++ === 0
      ? new Promise<Awaited<ReturnType<typeof makeSnapshot>>>((resolve) => { finish = resolve; })
      : makeSnapshot());
    const publish = vi.fn();
    const update = createCoalescedSnapshotPublisher(snapshot, publish, 100);

    try {
      const first = update();
      await vi.advanceTimersByTimeAsync(0);
      await Promise.all(Array.from({ length: 100 }, () => update()));
      expect(snapshot).toHaveBeenCalledOnce();

      finish(await makeSnapshot());
      await first;
      await vi.advanceTimersByTimeAsync(99);
      expect(snapshot).toHaveBeenCalledOnce();
      await vi.advanceTimersByTimeAsync(1);
      expect(snapshot).toHaveBeenCalledTimes(2);
      update.shutdown();
    } finally { update.shutdown(); vi.useRealTimers(); }
  });

  it('returns the cached snapshot immediately while a refresh is busy', async () => {
    vi.useFakeTimers();
    const makeSnapshot = async () => ({ control: { epoch: 1, activeAccountId: 'a', phase: 'idle' as const, targetAccountId: null }, defaultProvider: 'claude' as const,
      components: [], queueDepth: 0, accounts: [], conversations: [], jobs: [], providers: [] });
    let finish!: (value: Awaited<ReturnType<typeof makeSnapshot>>) => void;
    let calls = 0;
    const snapshot = vi.fn(() => calls++ === 0 ? makeSnapshot()
      : new Promise<Awaited<ReturnType<typeof makeSnapshot>>>((resolve) => { finish = resolve; }));
    const update = createCoalescedSnapshotPublisher(snapshot, vi.fn(), 100);

    try {
      await update();
      await update();
      await vi.advanceTimersByTimeAsync(100);
      expect(snapshot).toHaveBeenCalledTimes(2);
      const read = update.read();
      expect(await read).toEqual(await makeSnapshot());
      expect(snapshot).toHaveBeenCalledTimes(2);
      expect(vi.getTimerCount()).toBe(0);
      finish(await makeSnapshot());
      await vi.advanceTimersByTimeAsync(0);
      update.shutdown();
    } finally { update.shutdown(); vi.useRealTimers(); }
  });

  it('does not publish or replace the cache when a query finishes after shutdown', async () => {
    let finish!: (value: Awaited<ReturnType<typeof makeSnapshot>>) => void;
    async function makeSnapshot() {
      return { control: { epoch: 1, activeAccountId: 'a', phase: 'idle' as const, targetAccountId: null }, defaultProvider: 'claude' as const,
        components: [], queueDepth: 0, accounts: [], conversations: [], jobs: [], providers: [] };
    }
    const snapshot = vi.fn(() => new Promise<Awaited<ReturnType<typeof makeSnapshot>>>((resolve) => { finish = resolve; }));
    const publish = vi.fn();
    const update = createCoalescedSnapshotPublisher(snapshot, publish);
    const task = update.read();
    await Promise.resolve();
    update.shutdown();
    finish(await makeSnapshot());
    await expect(task).resolves.toMatchObject({ control: { epoch: 1 } });
    await expect(update.read()).rejects.toThrow('closed');
    expect(publish).not.toHaveBeenCalled();
  });
});
