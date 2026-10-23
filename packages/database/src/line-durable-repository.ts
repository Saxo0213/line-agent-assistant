import { createHash, randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';

export type MutationTerminalState = 'SENT' | 'REJECTED';
export type MutationState = 'PREPARED' | 'ATTEMPT_RESERVED' | 'IN_FLIGHT' | MutationTerminalState | 'UNKNOWN';

export interface RequestSequenceReservation {
  reservationId: string;
  accountId: string;
  sequence: number;
}

export interface PreparedMutationInput {
  accountId: string;
  chatType: 'direct' | 'group' | 'room';
  chatId: string;
  payloadDigest: string;
  authorityEpoch: number;
  grantVersion: number;
  capability: string;
}

export interface MutationAttemptIdentity {
  attemptId: string;
  ownerId: string;
  workerInstanceId: string;
  credentialVersion: number;
  reservationId: string;
  effectPermitId: string;
}

export interface MutationIntent extends PreparedMutationInput {
  intentId: string;
  state: MutationState;
  attemptId: string | null;
  ownerId: string | null;
  workerInstanceId: string | null;
  credentialVersion: number | null;
  requestSequence: number | null;
  effectPermitId: string | null;
  outcome: unknown;
}

export interface ReceiveEventInput {
  sourceEventId: string;
  chatType: 'direct' | 'group' | 'room';
  chatId: string;
  order: number;
  dispatchKind: string;
  payload: unknown;
  raw: unknown;
}

export interface ReceiveBatchInput {
  accountId: string;
  ownerId: string;
  transportGeneration: number;
  batchId: string;
  cursorBefore: Record<string, unknown>;
  cursorAfter: Record<string, unknown>;
  events: readonly ReceiveEventInput[];
  gap?: { sourceId: string; kind: string; details: unknown };
}

export interface DurableDispatch {
  dispatchId: string;
  accountId: string;
  chatType: ReceiveEventInput['chatType'];
  chatId: string;
  sourceEventId: string;
  dispatchKind: string;
  payload: unknown;
  attemptCount: number;
  leaseOwner: string | null;
  leaseToken: string | null;
}

function jsonObject(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error('Cursor must be an object');
  return value as Record<string, unknown>;
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    return `{${Object.entries(value).sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => `${JSON.stringify(key)}:${stableJson(child)}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

export class LineDurableRepository {
  constructor(private readonly pool: Pool) {}

  private async transaction<T>(operation: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const result = await operation(client);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  async reserveRequestSequence(accountId: string): Promise<RequestSequenceReservation> {
    return this.transaction(async (client) => {
      await client.query('INSERT INTO line_request_sequence_counters(account_id) VALUES ($1) ON CONFLICT DO NOTHING', [accountId]);
      const next = await client.query<{ sequence: string }>(
        `UPDATE line_request_sequence_counters SET next_sequence = next_sequence + 1, updated_at = now()
         WHERE account_id = $1 AND next_sequence <= 2147483647
         RETURNING (next_sequence - 1)::text AS sequence`, [accountId]);
      const sequence = next.rows[0]?.sequence;
      if (!sequence) throw new Error('LINE request sequence exhausted');
      const reservationId = randomUUID();
      await client.query(
        'INSERT INTO line_request_sequence_reservations(reservation_id, account_id, sequence) VALUES ($1,$2,$3)',
        [reservationId, accountId, Number(sequence)],
      );
      return { reservationId, accountId, sequence: Number(sequence) };
    });
  }

  async prepareMutation(input: PreparedMutationInput): Promise<{ intentId: string }> {
    if (!/^[0-9a-f]{64}$/.test(input.payloadDigest)) throw new Error('Payload digest must be a lowercase SHA-256 hex string');
    if (!Number.isSafeInteger(input.authorityEpoch) || input.authorityEpoch < 0
      || !Number.isSafeInteger(input.grantVersion) || input.grantVersion < 0) throw new Error('Mutation authority versions must be non-negative integers');
    const intentId = randomUUID();
    await this.pool.query(
      `INSERT INTO line_mutation_intents(intent_id,account_id,chat_type,chat_id,payload_digest,authority_epoch,grant_version,capability)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [intentId, input.accountId, input.chatType, input.chatId, input.payloadDigest, input.authorityEpoch, input.grantVersion, input.capability],
    );
    return { intentId };
  }

  async reserveMutationAttempt(intentId: string, identity: MutationAttemptIdentity): Promise<{ sequence: number; effectPermitId: string }> {
    return this.transaction(async (client) => {
      const reservation = await client.query<{ account_id: string; sequence: number }>(
        'SELECT account_id, sequence FROM line_request_sequence_reservations WHERE reservation_id=$1', [identity.reservationId]);
      const row = reservation.rows[0];
      if (!row) throw new Error('Unknown LINE request sequence reservation');
      const updated = await client.query(
        `UPDATE line_mutation_intents SET state='ATTEMPT_RESERVED',attempt_id=$3,owner_id=$4,worker_instance_id=$5,
           credential_version=$6,reservation_id=$7,effect_permit_id=$8,updated_at=now()
         WHERE intent_id=$1 AND account_id=$2 AND state='PREPARED' AND payload_digest ~ '^[0-9a-f]{64}$'
         RETURNING intent_id`,
        [intentId, row.account_id, identity.attemptId, identity.ownerId, identity.workerInstanceId,
          identity.credentialVersion, identity.reservationId, identity.effectPermitId],
      );
      if (updated.rowCount !== 1) throw new Error('Mutation intent is not PREPARED');
      await client.query(
        `INSERT INTO line_mutation_attempts(account_id,intent_id,attempt_id,owner_id,worker_instance_id,credential_version,
           reservation_id,effect_permit_id,state) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'ATTEMPT_RESERVED')`,
        [row.account_id, intentId, identity.attemptId, identity.ownerId, identity.workerInstanceId,
          identity.credentialVersion, identity.reservationId, identity.effectPermitId],
      );
      return { sequence: row.sequence, effectPermitId: identity.effectPermitId };
    });
  }

  async markMutationInFlight(intentId: string, identity: MutationAttemptIdentity): Promise<boolean> {
    return this.transaction(async (client) => {
      const updated = await client.query(
        `UPDATE line_mutation_intents SET state='IN_FLIGHT',updated_at=now()
         WHERE intent_id=$1 AND state='ATTEMPT_RESERVED' AND attempt_id=$2 AND owner_id=$3
           AND worker_instance_id=$4 AND credential_version=$5 AND reservation_id=$6
           AND effect_permit_id=$7 RETURNING account_id`,
        [intentId, identity.attemptId, identity.ownerId, identity.workerInstanceId, identity.credentialVersion,
          identity.reservationId, identity.effectPermitId],
      );
      if (!updated.rowCount) return false;
      const attempt = await client.query(
        `UPDATE line_mutation_attempts SET state='IN_FLIGHT',updated_at=now()
         WHERE account_id=$1 AND intent_id=$2 AND attempt_id=$3 AND owner_id=$4 AND worker_instance_id=$5
           AND credential_version=$6 AND reservation_id=$7`,
        [updated.rows[0]!.account_id, intentId, identity.attemptId, identity.ownerId,
          identity.workerInstanceId, identity.credentialVersion, identity.reservationId],
      );
      if (attempt.rowCount !== 1) throw new Error('Mutation attempt identity is inconsistent');
      return true;
    });
  }

  async markMutationUnknown(intentId: string, identity: MutationAttemptIdentity, reason: string): Promise<boolean> {
    return this.transaction(async (client) => {
      const updated = await client.query<{ account_id: string }>(
        `UPDATE line_mutation_intents SET state='UNKNOWN',outcome=jsonb_build_object('reason',$8::text,'recordedAt',now()),updated_at=now()
         WHERE intent_id=$1 AND state='IN_FLIGHT' AND attempt_id=$2 AND owner_id=$3 AND worker_instance_id=$4
           AND credential_version=$5 AND reservation_id=$6 AND effect_permit_id=$7 RETURNING account_id`,
        [intentId, identity.attemptId, identity.ownerId, identity.workerInstanceId, identity.credentialVersion,
          identity.reservationId, identity.effectPermitId, reason]);
      if (!updated.rowCount) return false;
      const attempt = await client.query(
        `UPDATE line_mutation_attempts SET state='UNKNOWN',updated_at=now()
         WHERE account_id=$1 AND intent_id=$2 AND attempt_id=$3 AND owner_id=$4 AND worker_instance_id=$5
           AND credential_version=$6 AND reservation_id=$7 AND effect_permit_id=$8 AND state='IN_FLIGHT'`,
        [updated.rows[0]!.account_id, intentId, identity.attemptId, identity.ownerId,
          identity.workerInstanceId, identity.credentialVersion, identity.reservationId, identity.effectPermitId]);
      if (attempt.rowCount !== 1) throw new Error('Mutation attempt identity is inconsistent');
      return true;
    });
  }

  async recoverMutationAttempts(accountId: string, retiredOwnerId: string): Promise<{ prepared: number; unknown: number }> {
    return this.transaction(async (client) => {
      const reserved = await client.query<{ account_id: string; intent_id: string; attempt_id: string }>(
        `SELECT account_id,intent_id,attempt_id FROM line_mutation_intents
         WHERE account_id=$1 AND owner_id=$2 AND state='ATTEMPT_RESERVED' FOR UPDATE`, [accountId, retiredOwnerId]);
      for (const row of reserved.rows) {
        const attempt = await client.query(
          `UPDATE line_mutation_attempts SET state='ABANDONED',updated_at=now()
           WHERE account_id=$1 AND intent_id=$2 AND attempt_id=$3 AND owner_id=$4 AND state='ATTEMPT_RESERVED'`,
          [row.account_id, row.intent_id, row.attempt_id, retiredOwnerId]);
        if (attempt.rowCount !== 1) throw new Error('Mutation attempt identity is inconsistent');
        const intent = await client.query(
          `UPDATE line_mutation_intents SET state='PREPARED',attempt_id=NULL,owner_id=NULL,worker_instance_id=NULL,
             credential_version=NULL,reservation_id=NULL,effect_permit_id=NULL,updated_at=now()
           WHERE account_id=$1 AND intent_id=$2 AND attempt_id=$3 AND owner_id=$4 AND state='ATTEMPT_RESERVED'`,
          [row.account_id, row.intent_id, row.attempt_id, retiredOwnerId]);
        if (intent.rowCount !== 1) throw new Error('Mutation recovery fence changed');
      }
      const inflight = await client.query<{ account_id: string; intent_id: string; attempt_id: string }>(
        `SELECT account_id,intent_id,attempt_id FROM line_mutation_intents
         WHERE account_id=$1 AND owner_id=$2 AND state='IN_FLIGHT' FOR UPDATE`, [accountId, retiredOwnerId]);
      for (const row of inflight.rows) {
        const attempt = await client.query(
          `UPDATE line_mutation_attempts SET state='UNKNOWN',updated_at=now()
           WHERE account_id=$1 AND intent_id=$2 AND attempt_id=$3 AND owner_id=$4 AND state='IN_FLIGHT'`,
          [row.account_id, row.intent_id, row.attempt_id, retiredOwnerId]);
        if (attempt.rowCount !== 1) throw new Error('Mutation attempt identity is inconsistent');
        const intent = await client.query(
          `UPDATE line_mutation_intents SET state='UNKNOWN',outcome='{"reason":"PROCESS_RECOVERY"}'::jsonb,updated_at=now()
           WHERE account_id=$1 AND intent_id=$2 AND attempt_id=$3 AND owner_id=$4 AND state='IN_FLIGHT'`,
          [row.account_id, row.intent_id, row.attempt_id, retiredOwnerId]);
        if (intent.rowCount !== 1) throw new Error('Mutation recovery fence changed');
      }
      return { prepared: reserved.rowCount ?? 0, unknown: inflight.rowCount ?? 0 };
    });
  }

  async reconcileMutation(intentId: string, identity: MutationAttemptIdentity, outcome: MutationTerminalState, resultPayload: unknown = null): Promise<boolean> {
    return this.transaction(async (client) => {
      const updated = await client.query<{ account_id: string }>(
        `UPDATE line_mutation_intents SET state=$8::text,
           outcome=jsonb_build_object('state',$8::text,'result',$9::jsonb,'recordedAt',now()),updated_at=now()
         WHERE intent_id=$1 AND state IN ('IN_FLIGHT','UNKNOWN') AND attempt_id=$2 AND owner_id=$3
           AND worker_instance_id=$4 AND credential_version=$5 AND reservation_id=$6
           AND effect_permit_id=$7 RETURNING account_id`,
        [intentId, identity.attemptId, identity.ownerId, identity.workerInstanceId, identity.credentialVersion,
          identity.reservationId, identity.effectPermitId, outcome, JSON.stringify(resultPayload)],
      );
      if (!updated.rowCount) return false;
      const attempt = await client.query(
        `UPDATE line_mutation_attempts SET state=$4,updated_at=now()
         WHERE account_id=$1 AND intent_id=$2 AND attempt_id=$3 AND owner_id=$5 AND worker_instance_id=$6
           AND credential_version=$7 AND reservation_id=$8 AND effect_permit_id=$9 AND state IN ('IN_FLIGHT','UNKNOWN')`,
        [updated.rows[0]!.account_id, intentId, identity.attemptId, outcome, identity.ownerId, identity.workerInstanceId,
          identity.credentialVersion, identity.reservationId, identity.effectPermitId],
      );
      if (attempt.rowCount !== 1) throw new Error('Mutation attempt identity is inconsistent');
      return true;
    });
  }

  async getMutationIntent(intentId: string): Promise<MutationIntent | null> {
    const result = await this.pool.query<Record<string, unknown>>(
      `SELECT i.intent_id,i.account_id,i.chat_type,i.chat_id,i.payload_digest,i.authority_epoch,i.grant_version,
         i.capability,i.state,i.attempt_id,i.owner_id,i.worker_instance_id,i.credential_version,
         r.sequence AS request_sequence,i.effect_permit_id,i.outcome
       FROM line_mutation_intents i LEFT JOIN line_request_sequence_reservations r
         ON r.account_id=i.account_id AND r.reservation_id=i.reservation_id WHERE i.intent_id=$1`, [intentId]);
    const row = result.rows[0];
    if (!row) return null;
    return {
      intentId: String(row.intent_id), accountId: String(row.account_id), chatType: row.chat_type as PreparedMutationInput['chatType'],
      chatId: String(row.chat_id), payloadDigest: String(row.payload_digest), authorityEpoch: Number(row.authority_epoch),
      grantVersion: Number(row.grant_version), capability: String(row.capability), state: row.state as MutationState,
      attemptId: row.attempt_id === null ? null : String(row.attempt_id), ownerId: row.owner_id === null ? null : String(row.owner_id),
      workerInstanceId: row.worker_instance_id === null ? null : String(row.worker_instance_id),
      credentialVersion: row.credential_version === null ? null : Number(row.credential_version),
      requestSequence: row.request_sequence === null ? null : Number(row.request_sequence),
      effectPermitId: row.effect_permit_id === null ? null : String(row.effect_permit_id), outcome: row.outcome,
    };
  }

  async persistReceiveBatch(batch: ReceiveBatchInput): Promise<void> {
    if (!Number.isSafeInteger(batch.transportGeneration) || batch.transportGeneration < 0) throw new Error('Invalid transport generation');
    const before = jsonObject(batch.cursorBefore);
    const after = jsonObject(batch.cursorAfter);
    const events = [...batch.events].sort((left, right) => left.order - right.order);
    for (const event of events) if (!Number.isSafeInteger(event.order) || event.order < 0) throw new Error('Invalid receive event order');
    if (batch.gap && !batch.gap.sourceId) throw new Error('A sync gap requires a stable source ID');
    const batchDigest = createHash('sha256').update(stableJson({
      cursorBefore: before, cursorAfter: after, events, gap: batch.gap ?? null,
    })).digest('hex');
    await this.transaction(async (client) => {
      // Materialize the account cursor row before locking it. Concurrent first
      // batches then serialize on the same row just like later batches.
      await client.query(
        `INSERT INTO line_receive_cursors(account_id,owner_id,transport_generation,cursor)
         VALUES ($1,$2,$3,$4::jsonb) ON CONFLICT(account_id) DO NOTHING`,
        [batch.accountId, batch.ownerId, batch.transportGeneration, JSON.stringify(before)]);
      const cursor = await client.query<{ owner_id: string; transport_generation: string; cursor: Record<string, unknown> }>(
        'SELECT owner_id,transport_generation,cursor FROM line_receive_cursors WHERE account_id=$1 FOR UPDATE', [batch.accountId]);
      const current = cursor.rows[0];
      if (current && (Number(current.transport_generation) > batch.transportGeneration
        || (Number(current.transport_generation) === batch.transportGeneration && current.owner_id !== batch.ownerId))) {
        throw new Error('Stale LINE receive owner');
      }
      const insertedBatch = await client.query<{ batch_record_id: string }>(
        `INSERT INTO line_inbox_batches(account_id,owner_id,transport_generation,batch_id,batch_digest,cursor_before,cursor_after)
         VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7::jsonb)
         ON CONFLICT (account_id,owner_id,transport_generation,batch_id) DO NOTHING
         RETURNING batch_record_id`,
        [batch.accountId, batch.ownerId, batch.transportGeneration, batch.batchId,
          batchDigest, JSON.stringify(before), JSON.stringify(after)]);
      const batchRow = insertedBatch.rows[0];
      if (!batchRow) {
        const prior = await client.query<{ batch_record_id: string; batch_digest: string }>(
          `SELECT batch_record_id,batch_digest FROM line_inbox_batches
           WHERE account_id=$1 AND owner_id=$2 AND transport_generation=$3 AND batch_id=$4`,
          [batch.accountId, batch.ownerId, batch.transportGeneration, batch.batchId]);
        if (!prior.rows[0] || prior.rows[0].batch_digest !== batchDigest) throw new Error('LINE batch replay changed its durable content');
        return;
      }
      if (current && stableJson(current.cursor) !== stableJson(before)) throw new Error('Stale LINE cursor predecessor');
      for (const event of events) {
        const inserted = await client.query<{ inbox_event_id: string }>(
          `INSERT INTO line_inbox_events(account_id,source_event_id,batch_record_id,chat_type,chat_id,event_order,raw)
           VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb) ON CONFLICT(account_id,source_event_id) DO NOTHING RETURNING inbox_event_id`,
          [batch.accountId, event.sourceEventId, batchRow.batch_record_id, event.chatType, event.chatId, event.order, JSON.stringify(event.raw)]);
        if (!inserted.rowCount) {
          const duplicate = await client.query<{ inbox_event_id: string; chat_type: string; chat_id: string; event_order: string; raw: unknown; dispatch_kind: string | null; payload: unknown }>(
            `SELECT e.inbox_event_id,e.chat_type,e.chat_id,e.event_order,e.raw,d.dispatch_kind,d.payload
             FROM line_inbox_events e LEFT JOIN line_dispatch_outbox d
               ON d.account_id=e.account_id AND d.source_event_id=e.source_event_id
             WHERE e.account_id=$1 AND e.source_event_id=$2`, [batch.accountId, event.sourceEventId]);
          const prior = duplicate.rows[0];
          if (!prior || prior.dispatch_kind !== event.dispatchKind || prior.chat_type !== event.chatType || prior.chat_id !== event.chatId
            || Number(prior.event_order) !== event.order || stableJson(prior.raw) !== stableJson(event.raw)
            || stableJson(prior.payload) !== stableJson(event.payload)) {
            throw new Error('LINE source event replay changed its durable content');
          }
          continue;
        }
        await client.query(
          `INSERT INTO line_dispatch_outbox(account_id,chat_type,chat_id,source_event_id,dispatch_kind,payload,inbox_event_id)
           VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7) ON CONFLICT(account_id,source_event_id,dispatch_kind) DO NOTHING`,
          [batch.accountId, event.chatType, event.chatId, event.sourceEventId, event.dispatchKind,
            JSON.stringify(event.payload), inserted.rows[0]!.inbox_event_id]);
      }
      if (batch.gap) {
        const insertedGap = await client.query<{ gap_id: string }>(
          `INSERT INTO line_sync_gaps(account_id,owner_id,transport_generation,source_id,kind,details)
           VALUES ($1,$2,$3,$4,$5,$6::jsonb) ON CONFLICT(account_id,owner_id,transport_generation,source_id) DO NOTHING
           RETURNING gap_id`,
          [batch.accountId, batch.ownerId, batch.transportGeneration, batch.gap.sourceId, batch.gap.kind, JSON.stringify(batch.gap.details)]);
        if (!insertedGap.rowCount) {
          const priorGap = await client.query<{ kind: string; details: unknown }>(
            `SELECT kind,details FROM line_sync_gaps WHERE account_id=$1 AND owner_id=$2
             AND transport_generation=$3 AND source_id=$4`,
            [batch.accountId, batch.ownerId, batch.transportGeneration, batch.gap.sourceId]);
          if (priorGap.rows[0]?.kind !== batch.gap.kind || stableJson(priorGap.rows[0]?.details) !== stableJson(batch.gap.details)) {
            throw new Error('LINE sync gap replay changed its durable content');
          }
        }
      }
      await client.query(
        `INSERT INTO line_receive_cursors(account_id,owner_id,transport_generation,cursor) VALUES ($1,$2,$3,$4::jsonb)
         ON CONFLICT(account_id) DO UPDATE SET owner_id=EXCLUDED.owner_id,transport_generation=EXCLUDED.transport_generation,
           cursor=EXCLUDED.cursor,updated_at=now()`,
        [batch.accountId, batch.ownerId, batch.transportGeneration, JSON.stringify(after)]);
    });
  }

  async getReceiveCursor(accountId: string): Promise<Record<string, unknown> | null> {
    const result = await this.pool.query<{ cursor: Record<string, unknown> }>('SELECT cursor FROM line_receive_cursors WHERE account_id=$1', [accountId]);
    return result.rows[0]?.cursor ?? null;
  }

  async listOpenSyncGaps(accountId: string): Promise<Array<{ gapId: string; kind: string; details: unknown }>> {
    const result = await this.pool.query<{ gap_id: string; kind: string; details: unknown }>(
      `SELECT gap_id,kind,details FROM line_sync_gaps WHERE account_id=$1 AND status='OPEN' ORDER BY gap_id`, [accountId]);
    return result.rows.map((row) => ({ gapId: row.gap_id, kind: row.kind, details: row.details }));
  }

  async resolveSyncGap(accountId: string, gapId: string): Promise<boolean> {
    const result = await this.pool.query(
      `UPDATE line_sync_gaps SET status='RESOLVED',resolved_at=now()
       WHERE account_id=$1 AND gap_id=$2 AND status='OPEN' RETURNING gap_id`, [accountId, gapId]);
    return result.rowCount === 1;
  }

  private async findReadyDispatches(client: Pool | PoolClient, accountId: string | undefined, limit: number, lock: boolean): Promise<Array<Record<string, unknown>>> {
    const result = await client.query<Record<string, unknown>>(
      `SELECT d.dispatch_id,d.account_id,d.chat_type,d.chat_id,d.source_event_id,d.dispatch_kind,d.payload,d.attempt_count,
         d.lease_owner,d.lease_token
       FROM line_dispatch_outbox d
       WHERE ($2::text IS NULL OR d.account_id=$2)
         AND (d.state='READY' OR (d.state='LEASED' AND d.lease_until <= now()))
         AND NOT EXISTS (
           SELECT 1 FROM line_dispatch_outbox prior
           WHERE prior.account_id=d.account_id AND prior.chat_type=d.chat_type AND prior.chat_id=d.chat_id
             AND prior.dispatch_id<d.dispatch_id AND prior.state<>'DONE')
       ORDER BY d.dispatch_id LIMIT $1${lock ? ' FOR UPDATE OF d SKIP LOCKED' : ''}`,
      [limit, accountId ?? null]);
    return result.rows;
  }

  private mapDispatch(row: Record<string, unknown>): DurableDispatch {
    return {
      dispatchId: String(row.dispatch_id), accountId: String(row.account_id),
      chatType: row.chat_type as DurableDispatch['chatType'], chatId: String(row.chat_id),
      sourceEventId: String(row.source_event_id), dispatchKind: String(row.dispatch_kind), payload: row.payload,
      attemptCount: Number(row.attempt_count), leaseOwner: row.lease_owner === null ? null : String(row.lease_owner),
      leaseToken: row.lease_token === null ? null : String(row.lease_token),
    };
  }

  async listReadyDispatches(input: { limit: number; accountId?: string }): Promise<DurableDispatch[]> {
    if (!Number.isSafeInteger(input.limit) || input.limit < 1 || input.limit > 1000) throw new Error('Invalid dispatch scan limit');
    const rows = await this.findReadyDispatches(this.pool, input.accountId, input.limit, false);
    return rows.map((row) => this.mapDispatch(row));
  }

  async claimReadyDispatches(input: { ownerId: string; limit: number; leaseSeconds: number; accountId?: string }): Promise<DurableDispatch[]> {
    if (!Number.isSafeInteger(input.limit) || input.limit < 1 || input.limit > 1000
      || !Number.isSafeInteger(input.leaseSeconds) || input.leaseSeconds < 1 || input.leaseSeconds > 3600) throw new Error('Invalid dispatch claim bounds');
    return this.transaction(async (client) => {
      const rows = await this.findReadyDispatches(client, input.accountId, input.limit, true);
      const claimed: DurableDispatch[] = [];
      for (const row of rows) {
        const leaseToken = randomUUID();
        const updated = await client.query<Record<string, unknown>>(
          `UPDATE line_dispatch_outbox SET state='LEASED',attempt_count=attempt_count+1,lease_owner=$2,lease_token=$3,
             lease_until=now()+($4::text || ' seconds')::interval
           WHERE dispatch_id=$1 RETURNING dispatch_id,account_id,chat_type,chat_id,source_event_id,dispatch_kind,payload,attempt_count,lease_owner,lease_token`,
          [row.dispatch_id, input.ownerId, leaseToken, input.leaseSeconds]);
        claimed.push(this.mapDispatch(updated.rows[0]!));
      }
      return claimed;
    });
  }

  async completeDispatch(dispatch: DurableDispatch): Promise<boolean> {
    if (!dispatch.leaseOwner || !dispatch.leaseToken) return false;
    const result = await this.pool.query(
      `UPDATE line_dispatch_outbox SET state='DONE',completed_at=now(),lease_owner=NULL,lease_token=NULL,lease_until=NULL
       WHERE dispatch_id=$1 AND state='LEASED' AND lease_owner=$2 AND lease_token=$3 RETURNING dispatch_id`,
      [dispatch.dispatchId, dispatch.leaseOwner, dispatch.leaseToken]);
    return result.rowCount === 1;
  }

  async releaseDispatchForRetry(dispatch: DurableDispatch): Promise<boolean> {
    if (!dispatch.leaseOwner || !dispatch.leaseToken) return false;
    const result = await this.pool.query(
      `UPDATE line_dispatch_outbox SET state='READY',lease_owner=NULL,lease_token=NULL,lease_until=NULL
       WHERE dispatch_id=$1 AND state='LEASED' AND lease_owner=$2 AND lease_token=$3 RETURNING dispatch_id`,
      [dispatch.dispatchId, dispatch.leaseOwner, dispatch.leaseToken]);
    return result.rowCount === 1;
  }
}
