export type ManualMediaLease = Readonly<{ signal: AbortSignal; release(): void }>;

/** Synchronous admission keeps burst requests bounded before they enter the lifecycle queue. */
export function createManualMediaAdmission(options: { globalLimit?: number; perAccountLimit?: number } = {}) {
  const globalLimit = options.globalLimit ?? 2;
  const perAccountLimit = options.perAccountLimit ?? 1;
  const active = new Map<symbol, { accountId: string; controller: AbortController; parent?: AbortSignal; onParentAbort?: () => void }>();
  let closed = false;

  return {
    acquire(accountId: string, parent?: AbortSignal): ManualMediaLease | null {
      if (closed || parent?.aborted || active.size >= globalLimit) return null;
      let accountCount = 0;
      for (const item of active.values()) if (item.accountId === accountId) accountCount++;
      if (accountCount >= perAccountLimit) return null;

      const controller = new AbortController();
      const owner: { accountId: string; controller: AbortController; parent?: AbortSignal; onParentAbort?: () => void } = {
        accountId, controller, ...(parent ? { parent } : {}),
      };
      if (parent) {
        owner.onParentAbort = () => controller.abort();
        parent.addEventListener('abort', owner.onParentAbort, { once: true });
      }
      const key = Symbol('manual-media');
      active.set(key, owner);
      let released = false;
      return {
        signal: controller.signal,
        release() {
          if (released) return;
          released = true;
          if (owner.parent && owner.onParentAbort) owner.parent.removeEventListener('abort', owner.onParentAbort);
          active.delete(key);
        },
      };
    },
    shutdown() {
      if (closed) return;
      closed = true;
      for (const owner of active.values()) owner.controller.abort();
    },
  };
}
