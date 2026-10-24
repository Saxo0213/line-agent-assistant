import type { Pool, PoolClient, QueryResult, QueryResultRow } from 'pg';
import { parseSafeDiagnostic, type SafeDiagnostic } from '@line-agent/contracts';

const activeAuditPools = new WeakSet<Pool>();

export interface SafeAuditRecord {
  diagnostic?: SafeDiagnostic;
  action: string;
  phase: 'requested' | 'succeeded' | 'failed' | 'observed';
  initiator: 'user' | 'system' | 'worker';
  correlationId: string;
  accountId?: string;
  workerInstanceId?: string;
  loginAttemptId?: string;
  requestId?: string;
  jobId?: string;
  reasonCode?: string;
  resultCode?: string;
  errorCode?: string;
  droppedCount?: number;
  createdAt: string;
}

export class AuditRepository {
  private readonly pendingReadFences = new Set<Promise<void>>();
  constructor(private readonly pool: Pool) {}

  private async boundedRead<T extends QueryResultRow>(query: string, values: unknown[]): Promise<QueryResult<T>> {
    let client: PoolClient | undefined;
    let timedOut = false;
    let acquired = false;
    let released = false;
    const release = (destroy = false) => {
      if (!client || released) return;
      released = true;
      client.release(destroy);
    };
    const acquisition = this.pool.connect().then((value) => {
      acquired = true;
      client = value;
      if (timedOut) { release(true); throw new Error('AUDIT_READ_TIMEOUT'); }
      return value;
    });
    let timer: ReturnType<typeof setTimeout> | undefined;
    let read!: Promise<QueryResult<T>>;
    const deadline = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        timedOut = true;
        release(true);
        const fence = read.then(() => undefined, () => undefined);
        this.pendingReadFences.add(fence);
        void fence.then(() => this.pendingReadFences.delete(fence));
        reject(new Error('AUDIT_READ_TIMEOUT'));
      }, 2000);
    });
    read = (async () => {
      const connection = await acquisition;
      try {
        await connection.query('BEGIN READ ONLY');
        await connection.query("SET LOCAL statement_timeout = '2000ms'");
        const result = await connection.query<T>(query, values);
        if (timedOut) throw new Error('AUDIT_READ_TIMEOUT');
        await connection.query('COMMIT');
        return result;
      } catch (error) {
        if (!timedOut) await connection.query('ROLLBACK').catch(() => undefined);
        throw error;
      } finally { release(timedOut); }
    })();
    try { return await Promise.race([read, deadline]); }
    finally {
      if (timer) clearTimeout(timer);
      if (!acquired) void acquisition.then(() => release(true), () => undefined);
    }
  }

  async waitForReadDrain(): Promise<void> { await Promise.all([...this.pendingReadFences]); }

  async append(event: SafeAuditRecord): Promise<void> {
    if (activeAuditPools.has(this.pool)) throw new Error('AUDIT_DB_BUSY');
    activeAuditPools.add(this.pool);
    const details = {
      correlation_id: event.correlationId,
      phase: event.phase,
      ...(event.accountId ? { account_id: event.accountId } : {}),
      ...(event.workerInstanceId ? { worker_instance_id: event.workerInstanceId } : {}),
      ...(event.loginAttemptId ? { login_attempt_id: event.loginAttemptId } : {}),
      ...(event.requestId ? { request_id: event.requestId } : {}),
      ...(event.jobId ? { job_id: event.jobId } : {}),
      ...(event.reasonCode ? { reason_code: event.reasonCode } : {}),
      ...(event.resultCode ? { result_code: event.resultCode } : {}),
      ...(event.errorCode ? { error_code: event.errorCode } : {}),
      ...(event.droppedCount !== undefined ? { dropped_count: event.droppedCount } : {}),
      ...(parseSafeDiagnostic(event.diagnostic) ? { diagnostic: parseSafeDiagnostic(event.diagnostic) } : {}),
    };
    let timedOut = false;
    let acquisitionSettled = false;
    let ownershipReleased = false;
    const clientRef: { value?: PoolClient } = {};
    const releaseOwnership = () => {
      if (ownershipReleased) return;
      ownershipReleased = true;
      activeAuditPools.delete(this.pool);
    };
    let clientReleased = false;
    const releaseClient = (destroy = false) => {
      const acquiredClient = clientRef.value;
      if (!acquiredClient || clientReleased) return;
      clientReleased = true;
      acquiredClient.release(destroy);
    };
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<never>((_resolve, reject) => {
      timeout = setTimeout(() => {
        timedOut = true;
        // Destroy an in-flight client so a wedged query cannot occupy the pool after
        // the audit queue has already moved on to its fallback sink.
        releaseClient(true);
        reject(new Error('AUDIT_DB_TIMEOUT'));
      }, 2000);
    });
    const acquiring = this.pool.connect().then((acquiredClient) => {
      acquisitionSettled = true;
      clientRef.value = acquiredClient;
      if (timedOut) { releaseClient(true); throw new Error('AUDIT_DB_TIMEOUT'); }
      return acquiredClient;
    }, (error: unknown) => { acquisitionSettled = true; throw error; });
    const writing = (async () => {
      const connection = await acquiring;
      try {
        await connection.query('BEGIN');
        await connection.query('SET LOCAL statement_timeout = 2000');
        await connection.query('INSERT INTO audit_logs(action, actor, details, created_at) VALUES ($1, $2, $3::jsonb, $4)',
          [event.action, event.initiator, JSON.stringify(details), event.createdAt]);
        await connection.query('COMMIT');
      } catch (error) {
        await connection.query('ROLLBACK').catch(() => undefined);
        throw error;
      } finally { releaseClient(); }
    })();
    try {
      await Promise.race([writing, deadline]);
    } finally {
      if (timeout) clearTimeout(timeout);
      if (acquisitionSettled) releaseOwnership();
      else void acquiring.then(releaseOwnership, releaseOwnership);
    }
  }

  async list(limit = 500): Promise<SafeAuditRecord[]> {
    const result = await this.boundedRead<{ action: string; actor: SafeAuditRecord['initiator']; details: Record<string, unknown>; created_at: Date }>(
      'SELECT action, actor, details, created_at FROM audit_logs ORDER BY created_at DESC, audit_id DESC LIMIT $1',
      [Math.max(1, Math.min(500, Math.trunc(limit)))],
    );
    return result.rows.map((row) => ({
      action: row.action,
      phase: row.details.phase as SafeAuditRecord['phase'],
      initiator: row.actor,
      correlationId: String(row.details.correlation_id),
      ...(typeof row.details.account_id === 'string' ? { accountId: row.details.account_id } : {}),
      ...(typeof row.details.worker_instance_id === 'string' ? { workerInstanceId: row.details.worker_instance_id } : {}),
      ...(typeof row.details.login_attempt_id === 'string' ? { loginAttemptId: row.details.login_attempt_id } : {}),
      ...(typeof row.details.request_id === 'string' ? { requestId: row.details.request_id } : {}),
      ...(typeof row.details.job_id === 'string' ? { jobId: row.details.job_id } : {}),
      ...(typeof row.details.reason_code === 'string' ? { reasonCode: row.details.reason_code } : {}),
      ...(typeof row.details.result_code === 'string' ? { resultCode: row.details.result_code } : {}),
      ...(typeof row.details.error_code === 'string' ? { errorCode: row.details.error_code } : {}),
      ...(typeof row.details.dropped_count === 'number' ? { droppedCount: row.details.dropped_count } : {}),
      ...(parseSafeDiagnostic(row.details.diagnostic) ? { diagnostic: parseSafeDiagnostic(row.details.diagnostic)! } : {}),
      createdAt: row.created_at.toISOString(),
    }));
  }
}
