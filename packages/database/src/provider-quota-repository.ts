import type { Pool, PoolClient } from 'pg';
import {
  NORMAL_USAGE_REFRESH_MS, applyResetTimeRecovery, applyUsageObservation, blockSource, redactSensitiveDetail,
  type FailureClass, type FailureKind, type SourceFailoverState, type UsageObservationInput,
} from './provider-failover.js';

export type StoredQuotaState = {
  sourceId: string; provider: 'codex' | 'claude'; blocked: boolean; observedAt: string | null; recoveryAt: string | null;
  evidenceSource: string | null; evidence: string | null; snapshot: unknown; snapshotFetchedAt: string | null; snapshotStale: boolean;
  blockedAt: string | null; failureKind: FailureKind; failureCount: number; lastUsageFetchedAt: string | null; lastProbeAt: string | null;
};

type QuotaRow = {
  source_id: string; provider: 'codex' | 'claude'; blocked: boolean; observed_at: Date | null; recovery_at: Date | null;
  evidence_source: string | null; evidence: string | null; snapshot: unknown; snapshot_fetched_at: Date | null; snapshot_stale: boolean;
  blocked_at: Date | null; failure_kind: FailureKind; failure_count: number; last_usage_fetched_at: Date | null; last_probe_at: Date | null;
};

/** The usage snapshot that `observe` reads. ProviderQuotaSnapshot fits. The whole object is stored as the snapshot column. */
export type ObservedQuotaSnapshot = {
  fetchedAt: string | null; stale: boolean; error?: string | null; availabilityKnown?: boolean;
  windows?: Array<{ usedPercent?: number; resetsAt?: string | null; blocksProvider?: boolean }>;
};

const iso = (value: Date | null): string | null => value?.toISOString() ?? null;
const ms = (value: Date | null): number | null => value ? value.getTime() : null;
const date = (value: number | null): Date | null => value === null ? null : new Date(value);

function toStored(row: QuotaRow): StoredQuotaState {
  return { sourceId: row.source_id, provider: row.provider, blocked: row.blocked, observedAt: iso(row.observed_at), recoveryAt: iso(row.recovery_at),
    evidenceSource: row.evidence_source, evidence: row.evidence, snapshot: row.snapshot, snapshotFetchedAt: iso(row.snapshot_fetched_at),
    snapshotStale: row.snapshot_stale, blockedAt: iso(row.blocked_at), failureKind: row.failure_kind, failureCount: row.failure_count,
    lastUsageFetchedAt: iso(row.last_usage_fetched_at), lastProbeAt: iso(row.last_probe_at) };
}

/**
 * A row that never held a failure (not blocked, no count, no block time) is the same as "no failover record" in CTA.
 * That distinction matters: fresh exhausted usage creates a block only for a source with no record.
 */
function toFailoverState(row: QuotaRow): SourceFailoverState | null {
  if (!row.blocked && row.failure_count === 0 && row.blocked_at === null) return null;
  return { sourceId: row.source_id, blocked: row.blocked, blockedAt: ms(row.blocked_at) ?? ms(row.observed_at), recoveryAt: ms(row.recovery_at),
    failureKind: row.failure_kind, failureCount: row.failure_count, lastUsageFetchedAt: ms(row.last_usage_fetched_at),
    lastProbeAt: ms(row.last_probe_at), evidence: row.evidence };
}

/** Normalizes an untrusted snapshot object to the structural usage input. Only windows that block the source stay. */
function toUsageInput(snapshot: ObservedQuotaSnapshot): UsageObservationInput {
  const windows = (Array.isArray(snapshot.windows) ? snapshot.windows : []).filter((window) => window && typeof window.usedPercent === 'number')
    .map((window) => ({ usedPercent: window.usedPercent as number, resetsAt: typeof window.resetsAt === 'string' ? window.resetsAt : null,
      blocksProvider: window.blocksProvider !== false }));
  return { fetchedAt: snapshot.fetchedAt, stale: snapshot.stale === true, error: snapshot.error ?? null,
    availabilityKnown: snapshot.availabilityKnown ?? windows.some((window) => window.blocksProvider), windows };
}

export class ProviderQuotaRepository {
  constructor(private readonly pool: Pool) {}

  async get(sourceId: string): Promise<StoredQuotaState | null> {
    const row = (await this.pool.query<QuotaRow>(`SELECT * FROM provider_quota_state WHERE source_id=$1`, [sourceId])).rows[0];
    return row ? toStored(row) : null;
  }

  async list(): Promise<StoredQuotaState[]> {
    return (await this.pool.query<QuotaRow>(`SELECT * FROM provider_quota_state ORDER BY source_id`)).rows.map(toStored);
  }

  /** Inserts the row when the source exists, then locks it. Returns null when the source does not exist. */
  private async lockRow(client: PoolClient, sourceId: string): Promise<QuotaRow | null> {
    await client.query(`INSERT INTO provider_quota_state(source_id,provider,snapshot_stale)
      SELECT s.source_id,s.provider,true FROM agent_account_sources s WHERE s.source_id=$1 ON CONFLICT(source_id) DO NOTHING`, [sourceId]);
    return (await client.query<QuotaRow>(`SELECT * FROM provider_quota_state WHERE source_id=$1 FOR UPDATE`, [sourceId])).rows[0] ?? null;
  }

  private async inTransaction<T>(work: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const result = await work(client);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  private async writeState(client: PoolClient, state: SourceFailoverState, observedAt: Date | null, evidenceSource: string | null): Promise<void> {
    await client.query(`UPDATE provider_quota_state SET blocked=$2,blocked_at=$3::timestamptz,recovery_at=$4::timestamptz,failure_kind=$5,
      failure_count=$6,last_usage_fetched_at=$7::timestamptz,last_probe_at=$8::timestamptz,evidence=$9,
      observed_at=COALESCE($10::timestamptz,observed_at),evidence_source=COALESCE($11::text,evidence_source),updated_at=now() WHERE source_id=$1`,
    [state.sourceId, state.blocked, date(state.blockedAt), date(state.recoveryAt), state.failureKind, state.failureCount,
      date(state.lastUsageFetchedAt), date(state.lastProbeAt), state.evidence, observedAt, evidenceSource]);
  }

  /**
   * Records a failed turn of one source. Only a quota failure blocks the source (CTA block_source).
   * A transient rate limit and a non-quota failure change nothing (D23): CTA never blocks for them.
   */
  async recordQuotaFailure(input: { sourceId: string; kind: FailureClass; observedAt: string; recoveryAt: string | null; evidence: string }): Promise<{ blocked: boolean }> {
    return this.inTransaction(async (client) => {
      const row = await this.lockRow(client, input.sourceId);
      if (!row) return { blocked: false };
      if (input.kind !== 'quota_exhausted') return { blocked: row.blocked };
      const observed = new Date(input.observedAt);
      const recovery = input.recoveryAt === null ? null : Date.parse(input.recoveryAt);
      const next = blockSource(toFailoverState(row), { sourceId: input.sourceId, now: observed.getTime(),
        recoveryAt: recovery !== null && Number.isFinite(recovery) ? recovery : null, evidence: input.evidence });
      await this.writeState(client, next, observed, 'provider failure');
      return { blocked: true };
    });
  }

  /**
   * Stores a usage snapshot and applies the CTA recovery rules to the failover state, in one transaction.
   * `unblocked` is true when the row went from blocked to not blocked.
   */
  async observe(input: { sourceId: string; snapshot: ObservedQuotaSnapshot; requestedAt: string; now: Date }): Promise<{ blocked: boolean; unblocked: boolean }> {
    return this.inTransaction(async (client) => {
      const row = await this.lockRow(client, input.sourceId);
      if (!row) return { blocked: false, unblocked: false };
      const { snapshot } = input;
      const valid = snapshot.fetchedAt !== null && !snapshot.stale;
      if (valid || row.snapshot === null) {
        const incoming = snapshot.fetchedAt === null ? null : new Date(snapshot.fetchedAt);
        const replace = !valid || row.snapshot_fetched_at === null || (incoming !== null && incoming >= row.snapshot_fetched_at);
        const fetched = valid ? new Date(Math.max(row.snapshot_fetched_at?.getTime() ?? 0, incoming!.getTime())) : incoming;
        await client.query(`UPDATE provider_quota_state SET snapshot=$2::jsonb,snapshot_fetched_at=$3::timestamptz,snapshot_stale=$4::boolean,updated_at=now() WHERE source_id=$1`,
          [input.sourceId, replace ? JSON.stringify(snapshot) : JSON.stringify(row.snapshot), fetched, snapshot.stale === true]);
      }
      const before = toFailoverState(row);
      const usage = toUsageInput(snapshot);
      const observed = applyUsageObservation(before, input.sourceId, usage);
      const recovered = applyResetTimeRecovery(observed.state, usage, input.now.getTime());
      const after = recovered.state;
      if (after) {
        const created = before === null && after.blocked;
        await this.writeState(client, after, created ? date(after.blockedAt) : null, created ? 'provider quota snapshot' : null);
      }
      return { blocked: after?.blocked ?? false, unblocked: before?.blocked === true && after?.blocked === false };
    });
  }

  /** Thin wrapper of `observe` for the callers that pass the snapshot fields beside the snapshot. */
  async saveSnapshot(input: { sourceId: string; requestedAt: string; fetchedAt: string | null; stale: boolean; snapshot: unknown }): Promise<void> {
    const base = input.snapshot && typeof input.snapshot === 'object' ? input.snapshot as Record<string, unknown> : {};
    await this.observe({ sourceId: input.sourceId, requestedAt: input.requestedAt, now: new Date(),
      snapshot: { ...base, fetchedAt: input.fetchedAt, stale: input.stale } as ObservedQuotaSnapshot });
  }

  /**
   * Atomic markUsageProbe. It sets last_probe_at only when the source is blocked and due
   * (the sourcesDueForUsageRefresh rule for one source). Returns true when this caller won.
   */
  async claimProbe(sourceId: string, now: Date): Promise<boolean> {
    const result = await this.pool.query(`UPDATE provider_quota_state SET last_probe_at=$2::timestamptz,updated_at=now()
      WHERE source_id=$1 AND blocked AND CASE
        WHEN last_probe_at IS NOT NULL THEN $2::timestamptz - last_probe_at >= make_interval(secs => $3::double precision)
        WHEN recovery_at IS NOT NULL THEN $2::timestamptz >= recovery_at
        ELSE blocked_at IS NOT NULL AND $2::timestamptz - blocked_at >= make_interval(secs => $3::double precision) END`,
    [sourceId, now, NORMAL_USAGE_REFRESH_MS / 1000]);
    return result.rowCount === 1;
  }

  /** Revalidates the original LINE authority and active SYSTEM_LOGIN binding, not just the current chat address. */
  async validateJobNoticeAuthority(input:{jobId:string;accountId:string;workerInstanceId:string;controlEpoch:number}):Promise<boolean> {
    const result=await this.pool.query(`SELECT 1 FROM agent_jobs j
      JOIN line_accounts a ON a.account_id=j.account_id CROSS JOIN account_control c
      WHERE j.job_id=$1 AND j.account_id=$2 AND j.source_type='line'
        AND j.creation_epoch=$4 AND c.singleton=true AND c.control_epoch=$4
        AND a.mode='ACTIVE_CONTROL' AND a.connection_mode='SYSTEM_LOGIN' AND a.worker_instance_id=$3 AND a.worker_binding_epoch=$4
        AND (j.direct_friend_grant_id IS NULL OR EXISTS(SELECT 1 FROM line_friend_whitelist_grants f
          WHERE f.grant_id=j.direct_friend_grant_id AND f.account_id=j.account_id AND f.target_mid=j.source_sender_id
            AND f.version=j.direct_friend_grant_version AND f.state='ACTIVE'))
        AND ((j.direct_friend_grant_id IS NOT NULL OR j.free_mode)
          OR EXISTS(SELECT 1 FROM account_administrators aa WHERE aa.account_id=j.account_id AND aa.user_id=j.source_sender_id AND aa.role='PRIMARY_ADMIN'))`,
      [input.jobId,input.accountId,input.workerInstanceId,input.controlEpoch]);
    return result.rowCount===1;
  }
}
