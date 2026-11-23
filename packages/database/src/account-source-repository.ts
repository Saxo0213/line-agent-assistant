import { randomBytes } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';

export type AccountSourceProvider = 'claude' | 'codex';
export type AccountSourceKind = 'system' | 'managed';

export interface AccountSource {
  sourceId: string;
  provider: AccountSourceProvider;
  kind: AccountSourceKind;
  label: string;
  isDefault: boolean;
  fallbackEnabled: boolean;
  fallbackPosition: number | null;
  createdAt: string;
  updatedAt: string;
}

export type AccountSourceErrorCode = 'not_found' | 'system_source' | 'invalid_label' | 'invalid_provider' | 'provider_mismatch' | 'not_in_rotation';

export class AccountSourceError extends Error {
  constructor(readonly code: AccountSourceErrorCode, message: string) {
    super(message);
    this.name = 'AccountSourceError';
  }
}

export type RemoveAccountSourceResult = 'removed' | 'system' | 'in_use' | 'not_found';

const PROVIDERS: readonly AccountSourceProvider[] = ['claude', 'codex'];
const LABEL_MAX = 80;

/** The system source id of a provider. It equals the provider name. */
export function systemSourceId(provider: AccountSourceProvider): string { return provider; }

const compareIds = (a: string, b: string): number => a < b ? -1 : a > b ? 1 : 0;

const byCreatedThenId = (a: AccountSource, b: AccountSource): number => {
  const delta = Date.parse(a.createdAt) - Date.parse(b.createdAt);
  return delta !== 0 ? delta : compareIds(a.sourceId, b.sourceId);
};

/** The source id that a provider uses when it has no explicit choice: the explicit default, else the system source. */
export function effectiveDefaultId(rows: readonly AccountSource[], provider: AccountSourceProvider): string {
  return rows.find((row) => row.provider === provider && row.isDefault)?.sourceId ?? systemSourceId(provider);
}

/**
 * A stable, valid rotation order (port of CliTalkAgent normalized_fallback_order). Explicit positions keep their relative order.
 * Then each provider (claude, then codex) adds its effective default and its other eligible rows by creation time.
 */
export function normalizedFallbackOrder(rows: readonly AccountSource[]): string[] {
  const eligible = rows.filter((row) => row.fallbackEnabled);
  const eligibleIds = new Set(eligible.map((row) => row.sourceId));
  const seen = new Set<string>();
  const order: string[] = [];
  const explicit = eligible.filter((row) => row.fallbackPosition !== null)
    .sort((a, b) => (a.fallbackPosition! - b.fallbackPosition!) || compareIds(a.sourceId, b.sourceId));
  for (const row of explicit) if (!seen.has(row.sourceId)) { seen.add(row.sourceId); order.push(row.sourceId); }
  for (const provider of PROVIDERS) {
    const defaultId = effectiveDefaultId(rows, provider);
    if (eligibleIds.has(defaultId) && !seen.has(defaultId)) { seen.add(defaultId); order.push(defaultId); }
    const remaining = eligible.filter((row) => row.provider === provider && !seen.has(row.sourceId)).sort(byCreatedThenId);
    for (const row of remaining) { seen.add(row.sourceId); order.push(row.sourceId); }
  }
  return order;
}

interface SourceRow {
  source_id: string; provider: AccountSourceProvider; kind: AccountSourceKind; label: string; is_default: boolean;
  fallback_enabled: boolean; fallback_position: number | null; created_at: Date; updated_at: Date;
}

const COLUMNS = 'source_id, provider, kind, label, is_default, fallback_enabled, fallback_position, created_at, updated_at';

function toSource(row: SourceRow): AccountSource {
  return { sourceId: row.source_id, provider: row.provider, kind: row.kind, label: row.label, isDefault: row.is_default,
    fallbackEnabled: row.fallback_enabled, fallbackPosition: row.fallback_position,
    createdAt: row.created_at.toISOString(), updatedAt: row.updated_at.toISOString() };
}

function checkLabel(label: string): string {
  const trimmed = label.trim();
  if (trimmed.length < 1 || [...trimmed].length > LABEL_MAX) throw new AccountSourceError('invalid_label', 'The account label must have 1 to 80 characters.');
  return trimmed;
}

/** `acct-` plus 10 lowercase hex characters (CliTalkAgent new_source_id). */
function newManagedSourceId(): string { return `acct-${randomBytes(5).toString('hex')}`; }

export class AccountSourceRepository {
  constructor(private readonly pool: Pool) {}

  private async transaction<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const result = await fn(client);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  /** System rows first, then managed rows by creation time. */
  async list(): Promise<AccountSource[]> {
    const rows = await this.pool.query<SourceRow>(`SELECT ${COLUMNS} FROM agent_account_sources ORDER BY created_at, source_id`);
    return rows.rows.map(toSource);
  }

  async get(sourceId: string): Promise<AccountSource | null> {
    const row = (await this.pool.query<SourceRow>(`SELECT ${COLUMNS} FROM agent_account_sources WHERE source_id = $1`, [sourceId])).rows[0];
    return row ? toSource(row) : null;
  }

  async effectiveDefault(provider: AccountSourceProvider): Promise<AccountSource> {
    const rows = await this.list();
    const id = effectiveDefaultId(rows, provider);
    const source = rows.find((row) => row.sourceId === id);
    if (!source) throw new AccountSourceError('not_found', `The system account source is missing: ${provider}`);
    return source;
  }

  async add(input: { provider: AccountSourceProvider; label: string }): Promise<AccountSource> {
    if (!PROVIDERS.includes(input.provider)) throw new AccountSourceError('invalid_provider', 'The provider must be claude or codex.');
    const label = checkLabel(input.label);
    for (let attempt = 0; ; attempt += 1) {
      try {
        const row = (await this.pool.query<SourceRow>(
          `INSERT INTO agent_account_sources (source_id, provider, kind, label) VALUES ($1, $2, 'managed', $3) RETURNING ${COLUMNS}`,
          [newManagedSourceId(), input.provider, label])).rows[0]!;
        return toSource(row);
      } catch (error) {
        if ((error as { code?: string }).code === '23505' && attempt < 3) continue;
        throw error;
      }
    }
  }

  async rename(sourceId: string, label: string): Promise<AccountSource> {
    const next = checkLabel(label);
    const current = await this.get(sourceId);
    if (!current) throw new AccountSourceError('not_found', 'The account source does not exist.');
    if (current.kind === 'system') throw new AccountSourceError('system_source', 'A system account source cannot be renamed.');
    const row = (await this.pool.query<SourceRow>(
      `UPDATE agent_account_sources SET label = $2, updated_at = now() WHERE source_id = $1 AND kind = 'managed' RETURNING ${COLUMNS}`,
      [sourceId, next])).rows[0];
    if (!row) throw new AccountSourceError('not_found', 'The account source does not exist.');
    return toSource(row);
  }

  /** The system id clears every explicit default of the provider. A managed id must belong to the provider. */
  async setDefault(provider: AccountSourceProvider, sourceId: string): Promise<void> {
    await this.transaction(async (client) => {
      const rows = (await client.query<SourceRow>(
        `SELECT ${COLUMNS} FROM agent_account_sources WHERE provider = $1 ORDER BY source_id FOR UPDATE`, [provider])).rows;
      const target = rows.find((row) => row.source_id === sourceId);
      if (!target) {
        const other = await client.query('SELECT 1 FROM agent_account_sources WHERE source_id = $1', [sourceId]);
        throw other.rowCount
          ? new AccountSourceError('provider_mismatch', 'The account source belongs to another provider.')
          : new AccountSourceError('not_found', 'The account source does not exist.');
      }
      await client.query(
        'UPDATE agent_account_sources SET is_default = false, updated_at = now() WHERE provider = $1 AND is_default AND source_id <> $2', [provider, sourceId]);
      if (target.kind === 'managed' && !target.is_default) {
        await client.query('UPDATE agent_account_sources SET is_default = true, updated_at = now() WHERE source_id = $1', [sourceId]);
      }
    });
  }

  /** Swaps the source with its neighbour of the same provider in the normalized rotation, then stores the whole order. */
  async move(sourceId: string, direction: 'up' | 'down'): Promise<void> {
    if (direction !== 'up' && direction !== 'down') throw new AccountSourceError('not_in_rotation', 'The direction must be up or down.');
    await this.transaction(async (client) => {
      const rows = (await client.query<SourceRow>(`SELECT ${COLUMNS} FROM agent_account_sources ORDER BY source_id FOR UPDATE`)).rows.map(toSource);
      const source = rows.find((row) => row.sourceId === sourceId);
      if (!source) throw new AccountSourceError('not_found', 'The account source does not exist.');
      if (!source.fallbackEnabled) throw new AccountSourceError('not_in_rotation', 'The account source is not in the rotation.');
      const order = normalizedFallbackOrder(rows);
      const index = order.indexOf(sourceId);
      if (index < 0) throw new AccountSourceError('not_in_rotation', 'The account source is not in the rotation.');
      const sameProvider = (id: string): boolean => rows.find((row) => row.sourceId === id)?.provider === source.provider;
      let target = -1;
      if (direction === 'up') {
        for (let i = index - 1; i >= 0; i -= 1) if (sameProvider(order[i]!)) { target = i; break; }
      } else {
        for (let i = index + 1; i < order.length; i += 1) if (sameProvider(order[i]!)) { target = i; break; }
      }
      if (target >= 0) [order[index], order[target]] = [order[target]!, order[index]!];
      await client.query(
        `UPDATE agent_account_sources s SET fallback_position = o.position, updated_at = now()
         FROM unnest($1::text[]) WITH ORDINALITY AS o(id, position) WHERE s.source_id = o.id`, [order]);
      await client.query('UPDATE agent_account_sources SET fallback_position = NULL WHERE source_id <> ALL($1::text[]) AND fallback_position IS NOT NULL', [order]);
    });
  }

  async setFallbackEnabled(sourceId: string, enabled: boolean): Promise<AccountSource> {
    const row = (await this.pool.query<SourceRow>(
      `UPDATE agent_account_sources SET fallback_enabled = $2::boolean, fallback_position = CASE WHEN $2::boolean THEN fallback_position ELSE NULL END,
         updated_at = now() WHERE source_id = $1 RETURNING ${COLUMNS}`, [sourceId, enabled])).rows[0];
    if (!row) throw new AccountSourceError('not_found', 'The account source does not exist.');
    return toSource(row);
  }

  /**
   * Removes a managed source. A source with a queued or running job stays. Chat sessions of the source lose their binding and
   * their provider session id, because the account directory is gone. Quota rows go by cascade; job rows keep a NULL source.
   */
  async remove(sourceId: string): Promise<RemoveAccountSourceResult> {
    return this.transaction(async (client) => {
      const row = (await client.query<{ kind: AccountSourceKind }>('SELECT kind FROM agent_account_sources WHERE source_id = $1 FOR UPDATE', [sourceId])).rows[0];
      if (!row) return 'not_found';
      if (row.kind === 'system') return 'system';
      const busy = await client.query("SELECT 1 FROM agent_jobs WHERE account_source_id = $1 AND status IN ('queued','running') LIMIT 1", [sourceId]);
      if (busy.rowCount) return 'in_use';
      await client.query('UPDATE agent_sessions SET account_source_id = NULL, external_session_id = NULL, updated_at = now() WHERE account_source_id = $1', [sourceId]);
      await client.query('DELETE FROM agent_account_sources WHERE source_id = $1', [sourceId]);
      return 'removed';
    });
  }
}
