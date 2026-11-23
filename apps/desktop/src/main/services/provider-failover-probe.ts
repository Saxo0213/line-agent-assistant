import type { AgentProvider } from '@line-agent/contracts';
import type { ObservedQuotaSnapshot } from '@line-agent/database';

/** CTA runtime tick: the blocked sources are checked every tick; the usage probe itself waits for the claimProbe due rule (300 s). */
export const PROBE_TICK_MS = 30_000;
/** CTA provider_usage.rs DEFAULT_REFRESH_SECONDS (300): the refresh of the login status and the usage of every source. */
export const REFRESH_EVERY_TICKS = 10;
/** CTA maintenance.rs: the number of exhausted pending turns that one tick replays. */
const RECOVERY_LIMIT = 8;

type AccountRef = { id: string; kind: 'system' | 'managed' };
type SourceStatus = 'logged_in' | 'logged_out' | 'not_installed' | 'error' | 'unknown';

export interface ProviderFailoverProbeDependencies {
  /** The failover switch (plan D26). While it is off, a tick does nothing. */
  enabled(): Promise<boolean>;
  isClosing(): boolean;
  quota: {
    list(): Promise<Array<{ sourceId: string; blocked: boolean }>>;
    claimProbe(sourceId: string, now: Date): Promise<boolean>;
    observe(input: { sourceId: string; snapshot: ObservedQuotaSnapshot; requestedAt: string; now: Date }): Promise<{ blocked: boolean; unblocked: boolean }>;
  };
  /** The account sources with their cached login status. */
  sources: { list(): Promise<Array<{ id: string; provider: AgentProvider; kind: 'system' | 'managed'; status: SourceStatus }>> };
  /** Checks the login status of every source, one at a time. It needs no network. Absent when the app has no account directory. */
  refreshLoginStatus?: () => Promise<void>;
  /** The usage query of one source. The tests use a fake; the app wires the real query. */
  usage: { refreshNow(provider: AgentProvider, account: AccountRef): Promise<ObservedQuotaSnapshot & { requestedAt: string }> };
  pendingTurns: { noteSourceRecovery(sourceId: string): Promise<number> };
  failoverTurns: { recoverExhausted(limit: number): Promise<number> };
  report(error: unknown, sourceId?: string): void;
  now?: () => Date;
}

/**
 * The periodic work of the automatic failover (plan D27). It ports the runtime tick of CliTalkAgent: maintenance.rs
 * refresh_due_provider_sources_with (probe of blocked sources), record_usage_observation (note_source_recovery on an unblock),
 * the periodic refresh of provider_usage.rs and resume_recoverable_pending_turns (every tick).
 * One tick runs at a time. A failed source never stops the others, and an error is a diagnostic.
 */
export class ProviderFailoverProbe {
  private timer: ReturnType<typeof setInterval> | undefined;
  private running = false;
  private stopped = false;
  private ticks = 0;
  private refreshDue = false;

  constructor(private readonly deps: ProviderFailoverProbeDependencies) {}

  /** Starts the 30 s timer. The first refresh of all sources comes 300 s later. */
  start(): void {
    if (this.timer || this.stopped) return;
    this.timer = setInterval(() => {
      this.ticks += 1;
      if (this.ticks % REFRESH_EVERY_TICKS === 0) this.refreshDue = true;
      void this.tick();
    }, PROBE_TICK_MS);
    this.timer.unref?.();
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  private get inactive(): boolean { return this.stopped || this.deps.isClosing(); }

  /** One tick. A running tick makes the next tick skip. */
  async tick(): Promise<void> {
    if (this.running || this.inactive) return;
    this.running = true;
    try {
      if (!await this.deps.enabled() || this.inactive) return;
      await this.probeBlocked();
      if (this.refreshDue && !this.inactive) { this.refreshDue = false; await this.refreshAll(); }
      // CTA runs the recovery on every tick, whether or not a source recovered.
      if (!this.inactive) await this.deps.failoverTurns.recoverExhausted(RECOVERY_LIMIT);
    } catch (error) { this.deps.report(error); }
    finally { this.running = false; }
  }

  private now(): Date { return this.deps.now?.() ?? new Date(); }

  /** Reads the usage of one source and applies it. An unblock reopens the attempted source of the pending turns. */
  private async observeSource(source: { id: string; provider: AgentProvider; kind: 'system' | 'managed' }): Promise<void> {
    const snapshot = await this.deps.usage.refreshNow(source.provider, { id: source.id, kind: source.kind });
    const result = await this.deps.quota.observe({ sourceId: source.id, snapshot, requestedAt: snapshot.requestedAt, now: this.now() });
    if (result.unblocked) await this.deps.pendingTurns.noteSourceRecovery(source.id);
  }

  /** CTA refresh_due_provider_sources_with: only a won claim probes a blocked source. */
  private async probeBlocked(): Promise<void> {
    const blocked = (await this.deps.quota.list()).filter((row) => row.blocked);
    if (blocked.length === 0) return;
    const sources = new Map((await this.deps.sources.list()).map((source) => [source.id, source]));
    for (const row of blocked) {
      if (this.inactive) return;
      const source = sources.get(row.sourceId);
      if (!source) continue;
      try {
        if (!await this.deps.quota.claimProbe(row.sourceId, this.now())) continue;
        await this.observeSource(source);
      } catch (error) { this.deps.report(error, row.sourceId); }
    }
  }

  /** CTA background refresh: the login status of all sources, then the usage of each usable source that is not blocked (one at a time). */
  private async refreshAll(): Promise<void> {
    try { await this.deps.refreshLoginStatus?.(); } catch (error) { this.deps.report(error); }
    if (this.inactive) return;
    const blocked = new Set((await this.deps.quota.list()).filter((row) => row.blocked).map((row) => row.sourceId));
    for (const source of await this.deps.sources.list()) {
      if (this.inactive) return;
      if (blocked.has(source.id) || source.status === 'logged_out' || source.status === 'not_installed' || source.status === 'error') continue;
      try { await this.observeSource(source); } catch (error) { this.deps.report(error, source.id); }
    }
  }
}
