import type { AppSnapshot, IpcEvent } from '@line-agent/contracts';

export function createDomainEventPublisher(send: (channel: string, event: IpcEvent) => void) {
  return (event: IpcEvent): void => send('line-agent:event', event);
}

export type CoalescedSnapshotPublisher = (() => Promise<void>) & { read(): Promise<AppSnapshot>; shutdown(): void };

export function createCoalescedSnapshotPublisher(snapshot: () => Promise<AppSnapshot>, publish: (event: IpcEvent) => void,
  maxFrequencyMs = 1_000): CoalescedSnapshotPublisher {
  let dirty = false;
  let pending: Promise<AppSnapshot> | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let lastStartedAt: number | null = null;
  let closed = false;
  let latest: AppSnapshot | null = null;
  const readWaiters = new Set<{ resolve(value: AppSnapshot): void; reject(error: Error): void }>();
  const settleColdReaders = (task: Promise<AppSnapshot>): void => {
    for (const waiter of readWaiters) void task.then(waiter.resolve, waiter.reject);
    readWaiters.clear();
  };
  const start = (): Promise<AppSnapshot> => {
    if (pending) return pending;
    if (closed || !dirty) return latest ? Promise.resolve(latest) : Promise.reject(new Error('Snapshot is unavailable'));
    dirty = false;
    lastStartedAt = Date.now();
    pending = Promise.resolve().then(snapshot).then((value) => {
      if (!closed) {
        latest = value;
        publish({ type: 'snapshotChanged', snapshot: value });
      }
      return value;
    }).catch((error) => {
      if (!closed) dirty = true;
      throw error;
    }).finally(() => {
      pending = null;
      schedule();
    });
    settleColdReaders(pending);
    return pending;
  };
  const schedule = (): void => {
    if (!dirty || timer || closed) return;
    const delay = Math.max(0, (lastStartedAt ?? 0) + Math.max(0, maxFrequencyMs) - Date.now());
    if (delay === 0) {
      void start().catch(() => undefined);
      return;
    }
    timer = setTimeout(() => { timer = null; void start().catch(() => undefined); }, delay);
  };
  const request = (() => {
    if (closed) return Promise.resolve();
    dirty = true;
    if (pending || timer) return Promise.resolve();
    if (lastStartedAt !== null && Date.now() < lastStartedAt + Math.max(0, maxFrequencyMs)) {
      schedule();
      return Promise.resolve();
    }
    return start().then(() => undefined);
  }) as CoalescedSnapshotPublisher;
  request.read = () => {
    if (closed) return latest ? Promise.resolve(latest) : Promise.reject(new Error('Snapshot publisher is closed'));
    if (latest) {
      void request().catch(() => undefined);
      return Promise.resolve(latest);
    }
    if (pending) return pending;
    const result = new Promise<AppSnapshot>((resolve, reject) => readWaiters.add({ resolve, reject }));
    void request().catch(() => undefined);
    return result;
  };
  request.shutdown = () => {
    closed = true;
    dirty = false;
    if (timer) clearTimeout(timer);
    timer = null;
    for (const waiter of readWaiters) waiter.reject(new Error('Snapshot publisher is closed'));
    readWaiters.clear();
  };
  return request;
}
