type WorkerHandle = { stop: () => void | Promise<void>; onExit?: (listener: () => void) => void };
export function createWorkerSupervisor(options: { spawn: (accountId: string) => WorkerHandle; maxRestarts?: number; delayMs?: number }) {
  const workers = new Map<string, WorkerHandle>();
  const restarts = new Map<string, number>();
  const timers = new Set<ReturnType<typeof setTimeout>>();
  let stopping = false;
  function start(accountId: string) {
    if (stopping || workers.has(accountId)) return;
    const worker = options.spawn(accountId);
    workers.set(accountId, worker);
    worker.onExit?.(() => {
      if (workers.get(accountId) !== worker) return;
      workers.delete(accountId);
      if (stopping) return;
      const attempts = restarts.get(accountId) ?? 0;
      if (attempts >= (options.maxRestarts ?? 3)) return;
      restarts.set(accountId, attempts + 1);
      const timer = setTimeout(() => { timers.delete(timer); start(accountId); }, (options.delayMs ?? 500) * 2 ** attempts);
      timers.add(timer);
    });
  }
  return {
    start,
    async shutdown() {
      stopping = true;
      for (const timer of timers) clearTimeout(timer);
      timers.clear();
      await Promise.allSettled([...workers.values()].map((worker) => worker.stop()));
      workers.clear();
    },
  };
}
