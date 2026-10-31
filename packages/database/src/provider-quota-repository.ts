import type { Pool } from 'pg';

export type StoredQuotaState = {
  provider: 'codex' | 'claude'; blocked: boolean; observedAt: string | null; recoveryAt: string | null;
  evidenceSource: string | null; evidence: string | null; snapshot: unknown; snapshotFetchedAt: string | null; snapshotStale: boolean;
};

export class ProviderQuotaRepository {
  constructor(private readonly pool: Pool) {}

  async get(provider: 'codex' | 'claude'): Promise<StoredQuotaState | null> {
    const row = (await this.pool.query<{
      provider: 'codex' | 'claude'; blocked: boolean; observed_at: Date | null; recovery_at: Date | null;
      evidence_source: string | null; evidence: string | null; snapshot: unknown; snapshot_fetched_at: Date | null; snapshot_stale: boolean;
    }>(`SELECT * FROM provider_quota_state WHERE provider=$1`, [provider])).rows[0];
    return row ? { provider: row.provider, blocked: row.blocked, observedAt: row.observed_at?.toISOString() ?? null,
      recoveryAt: row.recovery_at?.toISOString() ?? null, evidenceSource: row.evidence_source, evidence: row.evidence,
      snapshot: row.snapshot, snapshotFetchedAt: row.snapshot_fetched_at?.toISOString() ?? null, snapshotStale: row.snapshot_stale } : null;
  }

  async recordFailure(input: { provider: 'codex' | 'claude'; observedAt: string; recoveryAt: string | null; source: string; evidence: string }): Promise<void> {
    await this.pool.query(`INSERT INTO provider_quota_state(provider,blocked,observed_at,recovery_at,evidence_source,evidence)
      VALUES($1,true,$2::timestamptz,$3::timestamptz,$4,$5)
      ON CONFLICT(provider) DO UPDATE SET blocked=true,observed_at=EXCLUDED.observed_at,recovery_at=EXCLUDED.recovery_at,
        evidence_source=EXCLUDED.evidence_source,evidence=EXCLUDED.evidence,updated_at=now()
      WHERE provider_quota_state.observed_at IS NULL OR EXCLUDED.observed_at >= provider_quota_state.observed_at`,
    [input.provider, input.observedAt, input.recoveryAt, input.source, input.evidence.slice(0, 500)]);
  }

  async saveSnapshot(input: { provider: 'codex' | 'claude'; requestedAt: string; fetchedAt: string | null; stale: boolean; snapshot: unknown }): Promise<void> {
    const data = input.snapshot && typeof input.snapshot === 'object' ? input.snapshot as { availabilityKnown?: boolean; windows?: Array<{ usedPercent?: number; resetsAt?: string | null; blocksProvider?: boolean }> } : {};
    const windows = data.windows ?? [];
    const availabilityKnown = data.availabilityKnown ?? windows.some((window) => window.blocksProvider !== false);
    const blocking = input.fetchedAt !== null && !input.stale
      ? windows.filter((window) => window.usedPercent === 100 && window.blocksProvider !== false) : [];
    const exhausted = blocking.length > 0;
    const recoveryAt = exhausted && blocking.every((window) => typeof window.resetsAt === 'string')
      ? blocking.map((window) => window.resetsAt!).sort().at(-1) ?? null : null;
    const valid = input.fetchedAt !== null && !input.stale;
    const reconcileAvailability = valid && availabilityKnown;
    await this.pool.query(`INSERT INTO provider_quota_state(provider,blocked,observed_at,recovery_at,evidence_source,evidence,snapshot,snapshot_fetched_at,snapshot_stale)
      VALUES($1,CASE WHEN $10::boolean THEN $5::boolean ELSE false END,
        CASE WHEN $10::boolean THEN $2::timestamptz ELSE NULL END,CASE WHEN $10::boolean THEN $6::timestamptz ELSE NULL END,
        'provider quota snapshot',CASE WHEN $10::boolean THEN $7 ELSE 'Provider-wide availability is unknown' END,$8::jsonb,$3::timestamptz,$4)
      ON CONFLICT(provider) DO UPDATE SET
        snapshot=CASE WHEN $9::boolean AND (provider_quota_state.snapshot_fetched_at IS NULL OR EXCLUDED.snapshot_fetched_at >= provider_quota_state.snapshot_fetched_at) THEN EXCLUDED.snapshot ELSE provider_quota_state.snapshot END,
        snapshot_fetched_at=CASE WHEN $9::boolean THEN GREATEST(COALESCE(provider_quota_state.snapshot_fetched_at,EXCLUDED.snapshot_fetched_at),EXCLUDED.snapshot_fetched_at) ELSE provider_quota_state.snapshot_fetched_at END,
        snapshot_stale=CASE WHEN $9::boolean THEN EXCLUDED.snapshot_stale ELSE provider_quota_state.snapshot_stale END,
        blocked=CASE WHEN $10::boolean AND $2::timestamptz >= COALESCE(provider_quota_state.observed_at,'-infinity'::timestamptz)
          THEN $5::boolean ELSE provider_quota_state.blocked END,
        observed_at=CASE WHEN $10::boolean AND $2::timestamptz >= COALESCE(provider_quota_state.observed_at,'-infinity'::timestamptz) THEN $2::timestamptz ELSE provider_quota_state.observed_at END,
        recovery_at=CASE WHEN $10::boolean AND $2::timestamptz >= COALESCE(provider_quota_state.observed_at,'-infinity'::timestamptz) THEN $6::timestamptz ELSE provider_quota_state.recovery_at END,
        evidence_source=CASE WHEN $10::boolean AND $2::timestamptz >= COALESCE(provider_quota_state.observed_at,'-infinity'::timestamptz) THEN 'provider quota snapshot' ELSE provider_quota_state.evidence_source END,
        evidence=CASE WHEN $10::boolean AND $2::timestamptz >= COALESCE(provider_quota_state.observed_at,'-infinity'::timestamptz) THEN $7 ELSE provider_quota_state.evidence END,
        updated_at=now()`, [input.provider,input.requestedAt,input.fetchedAt,input.stale,exhausted,recoveryAt,
        exhausted?'Provider reports one or more exhausted usage windows':'Provider reports available usage',JSON.stringify(input.snapshot),valid,reconcileAvailability]);
  }

  async createProposal(jobId: string, targetProvider: 'codex' | 'claude', expiresAt: string): Promise<boolean> {
    const result = await this.pool.query(`INSERT INTO provider_quota_proposals
      (job_id,account_id,chat_type,chat_id,source_message_id,source_sender_id,control_epoch,failed_provider,target_provider,
       direct_grant_id,direct_grant_version,room_grant_id,room_grant_version,expires_at)
      SELECT j.job_id,j.account_id,j.chat_type,j.chat_id,j.source_message_id,j.source_sender_id,j.creation_epoch,j.provider,$2,
        j.direct_friend_grant_id,j.direct_friend_grant_version,j.room_agent_grant_id,j.room_agent_grant_version,$3::timestamptz
      FROM agent_jobs j
      WHERE j.job_id=$1 AND j.source_type='line' AND j.status='failed' AND j.source_message_id IS NOT NULL
        AND j.source_sender_id IS NOT NULL AND j.creation_epoch IS NOT NULL AND j.provider<>$2
        AND EXISTS(SELECT 1 FROM account_administrators aa WHERE aa.account_id=j.account_id AND aa.user_id=j.source_sender_id AND aa.role='PRIMARY_ADMIN')
        AND EXISTS(SELECT 1 FROM agent_events e WHERE e.job_id=j.job_id AND e.event->>'type'='failed' AND e.event->>'code'='PROVIDER_LIMIT')
        AND NOT EXISTS(SELECT 1 FROM agent_outputs o WHERE o.job_id=j.job_id)
      ON CONFLICT(job_id) DO UPDATE SET expires_at=EXCLUDED.expires_at
        WHERE provider_quota_proposals.state='pending' AND provider_quota_proposals.target_provider=EXCLUDED.target_provider`, [jobId, targetProvider, expiresAt]);
    return result.rowCount === 1;
  }

  async createNotice(jobId: string): Promise<void> {
    await this.pool.query(`INSERT INTO provider_quota_notices(job_id) VALUES($1) ON CONFLICT(job_id) DO NOTHING`,[jobId]);
  }

  async skipNotice(jobId:string): Promise<void> {
    await this.pool.query(`INSERT INTO provider_quota_notices(job_id,notification_state) VALUES($1,'skipped')
      ON CONFLICT(job_id) DO UPDATE SET notification_state='skipped',updated_at=now()
      WHERE provider_quota_notices.notification_state IN ('pending','claimed')`,[jobId]);
  }

  /** Revalidates the original LINE authority and active SYSTEM_LOGIN binding, not just the current chat address. */
  async validateFailureNoticeAuthority(input:{jobId:string;accountId:string;workerInstanceId:string;controlEpoch:number}):Promise<boolean> {
    const result=await this.pool.query(`SELECT 1 FROM agent_jobs j
      JOIN line_accounts a ON a.account_id=j.account_id CROSS JOIN account_control c
      WHERE j.job_id=$1 AND j.account_id=$2 AND j.source_type='line' AND j.status='failed'
        AND j.creation_epoch=$4 AND c.singleton=true AND c.control_epoch=$4
        AND a.mode='ACTIVE_CONTROL' AND a.connection_mode='SYSTEM_LOGIN' AND a.worker_instance_id=$3 AND a.worker_binding_epoch=$4
        AND (j.direct_friend_grant_id IS NULL OR EXISTS(SELECT 1 FROM line_friend_whitelist_grants f
          WHERE f.grant_id=j.direct_friend_grant_id AND f.account_id=j.account_id AND f.target_mid=j.source_sender_id
            AND f.version=j.direct_friend_grant_version AND f.state='ACTIVE'))
        AND (j.room_agent_grant_id IS NULL OR EXISTS(SELECT 1 FROM room_agent_grants r
          WHERE r.grant_id=j.room_agent_grant_id AND r.account_id=j.account_id AND r.chat_type=j.chat_type AND r.chat_id=j.chat_id
            AND r.version=j.room_agent_grant_version AND r.state='ACTIVE'))
        AND ((j.direct_friend_grant_id IS NOT NULL OR j.room_agent_grant_id IS NOT NULL)
          OR EXISTS(SELECT 1 FROM account_administrators aa WHERE aa.account_id=j.account_id AND aa.user_id=j.source_sender_id AND aa.role='PRIMARY_ADMIN'))`,
      [input.jobId,input.accountId,input.workerInstanceId,input.controlEpoch]);
    return result.rowCount===1;
  }

  async recoverableFailures(accountId:string): Promise<Array<{jobId:string;provider:'codex'|'claude';event:Record<string,unknown>;observedAt:string}>> {
    const rows=await this.pool.query<{job_id:string;provider:'codex'|'claude';event:Record<string,unknown>;observed_at:Date}>(`SELECT j.job_id,j.provider,e.event,e.created_at AS observed_at
      FROM agent_jobs j JOIN LATERAL (SELECT event,created_at FROM agent_events WHERE job_id=j.job_id AND event->>'type'='failed'
        AND event->>'code'='PROVIDER_LIMIT' ORDER BY created_at DESC LIMIT 1) e ON true
        WHERE j.status='failed' AND j.source_type IN ('line','ui','schedule') AND (j.source_type<>'line' OR j.account_id=$1)
        AND NOT EXISTS(SELECT 1 FROM agent_outputs o WHERE o.job_id=j.job_id)
        AND ((j.source_type='line' AND NOT EXISTS(SELECT 1 FROM provider_quota_notices n WHERE n.job_id=j.job_id AND n.notification_state<>'pending'))
          OR (j.source_type<>'line' AND NOT EXISTS(SELECT 1 FROM provider_quota_state q WHERE q.provider=j.provider AND q.observed_at>=e.created_at)))`,[accountId]);
    return rows.rows.map(row=>({jobId:row.job_id,provider:row.provider,event:row.event,observedAt:row.observed_at.toISOString()}));
  }

  async pendingProposal(input: { accountId: string; chatType: 'direct'|'group'|'room'; chatId: string; senderId: string;
    targetProvider: 'codex'|'claude' }): Promise<string | null> {
    const row=await this.pool.query<{job_id:string}>(`SELECT p.job_id FROM provider_quota_proposals p JOIN agent_jobs j ON j.job_id=p.job_id
      WHERE p.account_id=$1 AND p.chat_type=$2 AND p.chat_id=$3 AND p.source_sender_id=$4 AND p.target_provider=$5
        AND p.state='pending' AND p.expires_at>now() AND j.status='failed' ORDER BY p.created_at DESC LIMIT 1`,
      [input.accountId,input.chatType,input.chatId,input.senderId,input.targetProvider]);
    return row.rows[0]?.job_id??null;
  }

  /** Durable send claim: a claimed or unknown notice is never automatically retransmitted. */
  async claimNotice(jobId: string): Promise<boolean> {
    const result = await this.pool.query(`UPDATE provider_quota_notices SET notification_state='claimed',updated_at=now()
      WHERE job_id=$1 AND notification_state='pending'`, [jobId]);
    return result.rowCount === 1;
  }
  async finishNotice(jobId: string, state: 'sent' | 'unknown' | 'failed' | 'skipped'): Promise<void> {
    await this.pool.query(`UPDATE provider_quota_notices SET notification_state=$2,updated_at=now() WHERE job_id=$1 AND notification_state='claimed'`, [jobId, state]);
  }
}
