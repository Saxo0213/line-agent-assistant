export interface OwnAvatarRefreshScheduler {
  start(initialAccounts?: readonly { accountId: string; productRole: string | null }[]): void;
  noteConnected(accountId: string, productRole: string | null): void;
  shutdown(): Promise<void>;
}

export async function runOwnAvatarRefreshes<T extends { accountId: string; productRole: string | null }>(
  accounts: readonly T[],
  refresh: (accountId: string) => Promise<unknown>,
  shouldContinue: () => boolean = () => true,
): Promise<void> {
  const visitedRoles = new Set<string>();
  for (const account of accounts) {
    if (!shouldContinue()) return;
    if (account.productRole !== 'AGENT' && account.productRole !== 'PRIMARY_ADMIN') continue;
    if (visitedRoles.has(account.productRole)) continue;
    visitedRoles.add(account.productRole);
    await refresh(account.accountId);
  }
}

/** Owns the single process-wide periodic own-avatar refresh timer. */
export function createOwnAvatarRefreshScheduler(
  refreshEligibleAccounts: (accounts: readonly { accountId: string; productRole: string }[]) => Promise<void>,
  intervalMs = 30 * 60_000,
  timers: Pick<typeof globalThis, 'setTimeout' | 'clearTimeout'> = globalThis,
  now: () => number = Date.now,
): OwnAvatarRefreshScheduler {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let active: Promise<void> | undefined;
  let stopped = false;
  const dueByRole = new Map<'AGENT' | 'PRIMARY_ADMIN', { accountId: string; productRole: 'AGENT' | 'PRIMARY_ADMIN'; dueAt: number }>();

  const schedule = () => {
    if (stopped || active) return;
    if (timer !== undefined) timers.clearTimeout(timer);
    timer = undefined;
    const nextDue = Math.min(...[...dueByRole.values()].map((entry) => entry.dueAt));
    if (!Number.isFinite(nextDue)) return;
    timer = timers.setTimeout(() => {
      timer = undefined;
      const due = [...dueByRole.values()].filter((entry) => entry.dueAt <= now());
      for (const entry of due) {
        const current = dueByRole.get(entry.productRole);
        if (current?.accountId === entry.accountId && current.dueAt <= now()) {
          dueByRole.set(entry.productRole, { ...current, dueAt: now() + intervalMs });
        }
      }
      if (!due.length) { schedule(); return; }
      active = Promise.resolve().then(() => refreshEligibleAccounts(due.map(({ dueAt: _dueAt, ...account }) => account))).catch(() => undefined).finally(() => {
        active = undefined;
        schedule();
      });
    }, Math.max(0, nextDue - now()));
  };

  const assign = (accountId: string, productRole: string | null, dueAt: number) => {
    if (productRole !== 'AGENT' && productRole !== 'PRIMARY_ADMIN') return;
    dueByRole.set(productRole, { accountId, productRole, dueAt });
  };

  return {
    start(initialAccounts = []) {
      if (stopped) return;
      const dueAt = now() + intervalMs;
      for (const account of initialAccounts) {
        if ((account.productRole === 'AGENT' || account.productRole === 'PRIMARY_ADMIN') && !dueByRole.has(account.productRole)) {
          assign(account.accountId, account.productRole, dueAt);
        }
      }
      schedule();
    },
    noteConnected(accountId, productRole) {
      if (stopped) return;
      assign(accountId, productRole, now() + intervalMs);
      schedule();
    },
    async shutdown() {
      stopped = true;
      if (timer !== undefined) timers.clearTimeout(timer);
      timer = undefined;
      await active;
    },
  };
}
