import { afterEach, expect, it, vi } from 'vitest';
import { createOwnAvatarRefreshScheduler, runOwnAvatarRefreshes } from './own-avatar-refresh-scheduler.js';

afterEach(() => vi.useRealTimers());

it('refreshes the two configured account roles serially with a bounded pass', async () => {
  const accounts = [
    { accountId: 'agent', productRole: 'AGENT' },
    { accountId: 'admin', productRole: 'PRIMARY_ADMIN' },
    { accountId: 'duplicate-agent', productRole: 'AGENT' },
    { accountId: 'unassigned', productRole: null },
  ];
  const order: string[] = [];
  let active = 0;
  let maxActive = 0;

  await runOwnAvatarRefreshes(accounts, async (accountId) => {
    active++;
    maxActive = Math.max(maxActive, active);
    order.push(`${accountId}:start`);
    await Promise.resolve();
    order.push(`${accountId}:end`);
    active--;
  });

  expect(order).toEqual(['agent:start', 'agent:end', 'admin:start', 'admin:end']);
  expect(maxActive).toBe(1);
});

it('runs one owned periodic callback and clears it at shutdown', async () => {
  vi.useFakeTimers();
  const refresh = vi.fn(async () => undefined);
  const scheduler = createOwnAvatarRefreshScheduler(refresh, 30 * 60_000);
  scheduler.start([{ accountId: 'agent', productRole: 'AGENT' }]);

  await vi.advanceTimersByTimeAsync(30 * 60_000);

  expect(refresh).toHaveBeenCalledTimes(1);
  expect(vi.getTimerCount()).toBe(1);
  scheduler.shutdown();
  expect(vi.getTimerCount()).toBe(0);
});

it('waits a full interval after an account connects while keeping one shared timer', async () => {
  vi.useFakeTimers();
  const refresh = vi.fn(async () => undefined);
  const scheduler = createOwnAvatarRefreshScheduler(refresh, 30 * 60_000);
  scheduler.start([{ accountId: 'agent', productRole: 'AGENT' }]);

  await vi.advanceTimersByTimeAsync(20 * 60_000);
  scheduler.noteConnected('admin', 'PRIMARY_ADMIN');
  expect(vi.getTimerCount()).toBe(1);
  await vi.advanceTimersByTimeAsync(10 * 60_000);
  expect(refresh).toHaveBeenCalledWith([{ accountId: 'agent', productRole: 'AGENT' }]);
  expect(vi.getTimerCount()).toBe(1);
  await vi.advanceTimersByTimeAsync(20 * 60_000);
  expect(refresh).toHaveBeenLastCalledWith([{ accountId: 'admin', productRole: 'PRIMARY_ADMIN' }]);
  scheduler.shutdown();
  expect(vi.getTimerCount()).toBe(0);
});

it('does not overlap periodic callbacks while a previous pass is pending', async () => {
  vi.useFakeTimers();
  let release!: () => void;
  const wait = new Promise<void>((resolve) => { release = resolve; });
  const refresh = vi.fn(async () => wait);
  const scheduler = createOwnAvatarRefreshScheduler(refresh, 30 * 60_000);
  scheduler.start([{ accountId: 'agent', productRole: 'AGENT' }]);

  await vi.advanceTimersByTimeAsync(60 * 60_000);

  expect(refresh).toHaveBeenCalledTimes(1);
  release();
  await vi.waitFor(() => expect(refresh).toHaveBeenCalledTimes(1));
  scheduler.shutdown();
});

it('keeps a failed pass silent and retries at the next interval', async () => {
  vi.useFakeTimers();
  const refresh = vi.fn().mockRejectedValueOnce(new Error('offline')).mockResolvedValueOnce(undefined);
  const scheduler = createOwnAvatarRefreshScheduler(refresh, 30 * 60_000);
  scheduler.start([{ accountId: 'agent', productRole: 'AGENT' }]);

  await vi.advanceTimersByTimeAsync(30 * 60_000);
  expect(refresh).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(30 * 60_000);
  expect(refresh).toHaveBeenCalledTimes(2);
  scheduler.shutdown();
});

it('cancels the timer and drains an active bounded refresh during shutdown', async () => {
  vi.useFakeTimers();
  let release!: () => void;
  const pending = new Promise<void>((resolve) => { release = resolve; });
  const scheduler = createOwnAvatarRefreshScheduler(async () => pending, 30 * 60_000);
  scheduler.start([{ accountId: 'agent', productRole: 'AGENT' }]);
  await vi.advanceTimersByTimeAsync(30 * 60_000);
  let shutdownFinished = false;
  const shutdown = scheduler.shutdown().then(() => { shutdownFinished = true; });

  await Promise.resolve();
  expect(shutdownFinished).toBe(false);
  expect(vi.getTimerCount()).toBe(0);
  release();
  await shutdown;
  expect(shutdownFinished).toBe(true);
  expect(vi.getTimerCount()).toBe(0);
});
