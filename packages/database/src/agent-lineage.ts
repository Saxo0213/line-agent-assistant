import type { Pool, PoolClient } from 'pg';

type Queryable = Pick<Pool, 'query'> | Pick<PoolClient, 'query'>;

export interface AgentLineage {
  /** The account holding product_role AGENT, or null when no Agent exists (or the lineage has only retired accounts). */
  currentAccountId: string | null;
  /** Current account first, then retired accounts newest first. */
  accountIds: string[];
}

/** The single aggregation key for every feature that treats former Agent accounts as one Agent identity. */
export async function resolveAgentLineage(queryable: Queryable): Promise<AgentLineage> {
  const result = await queryable.query<{ account_id: string; retired_at: Date | null }>(
    `SELECT account_id,retired_at FROM (
       SELECT account_id,sequence,retired_at FROM agent_account_lineage
       UNION ALL
       SELECT a.account_id,2147483647,NULL::timestamptz FROM line_accounts a
       WHERE a.product_role='AGENT' AND NOT EXISTS (SELECT 1 FROM agent_account_lineage l WHERE l.account_id=a.account_id)
     ) x ORDER BY (retired_at IS NULL) DESC, sequence DESC`);
  const current = result.rows.find((row) => row.retired_at === null);
  return { currentAccountId: current?.account_id ?? null, accountIds: result.rows.map((row) => row.account_id) };
}

/** Inserts the lineage row for a new Agent account; caller holds the account_control lock inside its transaction. */
export async function appendAgentLineage(queryable: Queryable, accountId: string): Promise<void> {
  await queryable.query(
    `INSERT INTO agent_account_lineage(account_id,sequence,became_agent_at)
     SELECT $1,COALESCE(max(sequence),0)+1,now() FROM agent_account_lineage ON CONFLICT(account_id) DO NOTHING`, [accountId]);
}

/** Marks the lineage row of an account that stops being the Agent. */
export async function retireAgentLineage(queryable: Queryable, accountId: string): Promise<void> {
  await queryable.query(
    `UPDATE agent_account_lineage SET retired_at=GREATEST(now(),became_agent_at) WHERE account_id=$1 AND retired_at IS NULL`, [accountId]);
}

export interface LineageConversationLike { accountId: string; chatType: string; chatId: string; title?: string | null }

/**
 * Merges conversations of lineage accounts (`accountIds`, current first) by (chatType, chatId). The highest-ranked account
 * wins, so the current account's title and key are kept. Items of accounts outside the lineage pass through unchanged.
 */
export function mergeLineageConversations<T extends LineageConversationLike>(items: T[], accountIds: string[]): T[] {
  const rank = new Map(accountIds.map((id, index) => [id, index] as const));
  const best = new Map<string, T>();
  const order: string[] = [];
  for (const [index, item] of items.entries()) {
    // Accounts outside the lineage are never merged with anything.
    const key = rank.has(item.accountId) ? `${item.chatType}\u0000${item.chatId}` : `solo\u0000${index}`;
    const held = best.get(key);
    if (!held) { best.set(key, item); order.push(key); continue; }
    if ((rank.get(item.accountId) ?? Infinity) < (rank.get(held.accountId) ?? Infinity)) best.set(key, item);
  }
  return order.map((key) => best.get(key)!);
}

/**
 * Creates the LINE session row for (account, chat, provider, sourceType) when missing. For the current Agent account the
 * new row adopts the provider session id and workspace path of the most recent predecessor row for the same chat, so
 * Agent memory survives an account swap. The predecessor row is only read. An existing row is never changed, so a later
 * "new conversation" on the current account stays in force.
 */
export async function ensureLineageSessionRow(queryable: Queryable, key: {
  accountId: string; chatType: string; chatId: string; provider: string; sourceType?: 'line' | 'ui' }): Promise<void> {
  const lineage = await resolveAgentLineage(queryable);
  const predecessors = lineage.currentAccountId === key.accountId ? lineage.accountIds.filter((id) => id !== key.accountId) : [];
  await queryable.query(
    `INSERT INTO agent_sessions (account_id,chat_type,chat_id,provider,source_type,external_session_id,workspace_path)
     SELECT $1,$2,$3,$4,$5,p.external_session_id,p.workspace_path
     FROM (SELECT 1) one LEFT JOIN LATERAL (
       SELECT s.external_session_id,s.workspace_path FROM agent_sessions s
       WHERE s.account_id=ANY($6::text[]) AND s.chat_type=$2 AND s.chat_id=$3 AND s.provider=$4 AND s.source_type=$5
       ORDER BY array_position($6::text[],s.account_id) LIMIT 1) p ON true
     ON CONFLICT DO NOTHING`,
    [key.accountId, key.chatType, key.chatId, key.provider, key.sourceType ?? 'line', predecessors]);
}

/**
 * Read-side expansion for the authorized account list: when the current Agent account is authorized, every lineage
 * account is read with it. `order` ranks accounts for dedupe (empty when no lineage account is involved), and
 * `scopeAccountIds` is the account set a conversation scope on the current Agent account covers (null without a scope).
 */
export async function expandAgentLineage(queryable: Queryable, authorized: readonly string[], scopeAccountId?: string | null):
  Promise<{ accountIds: string[]; order: string[]; scopeAccountIds: string[] | null }> {
  const lineage = await resolveAgentLineage(queryable);
  const expands = lineage.currentAccountId !== null && authorized.includes(lineage.currentAccountId) && lineage.accountIds.length > 1;
  const accountIds = expands ? [...new Set([...authorized, ...lineage.accountIds])] : [...authorized];
  const scopeAccountIds = scopeAccountId == null ? null
    : expands && scopeAccountId === lineage.currentAccountId ? lineage.accountIds : [scopeAccountId];
  return { accountIds, order: expands ? lineage.accountIds : [], scopeAccountIds };
}

/**
 * Maps a stored conversation key to the current Agent account: a key of any lineage account (current or former) is returned
 * with `accountId` set to the current Agent account; chatType, chatId and other fields are kept. Any other key, or any key when
 * no Agent exists, is returned unchanged.
 */
export function resolveCurrentAgentKey<T extends { accountId: string; chatType: string; chatId: string }>(lineage: AgentLineage, key: T): T {
  if (lineage.currentAccountId === null || key.accountId === lineage.currentAccountId || !lineage.accountIds.includes(key.accountId)) return key;
  return { ...key, accountId: lineage.currentAccountId };
}
