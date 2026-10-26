import type { PoolClient } from 'pg';

export const LOCAL_CLIENT_PRINCIPALS = new Set(['local-client:codex', 'local-client:claude-desktop']);
export const PRODUCT_ROLES = ['AGENT', 'PRIMARY_ADMIN'] as const;
export type ProductRole = typeof PRODUCT_ROLES[number];
export const roleScope = (role: ProductRole): string => `role:${role}`;
export const parseRoleScope = (scope: string): ProductRole | null =>
  scope === 'role:AGENT' ? 'AGENT' : scope === 'role:PRIMARY_ADMIN' ? 'PRIMARY_ADMIN' : null;

/** Locks legacy managed tokens before account/control locks; caller owns the transaction. */
export async function normalizeManagedMcpScopes(client: PoolClient): Promise<void> {
  const tokens = await client.query<{ token_id: string; account_scopes: string[] }>(
    `SELECT token_id,account_scopes FROM mcp_agent_tokens
     WHERE principal_id=ANY($1::text[]) AND state='ACTIVE' AND revoked_at IS NULL
       AND EXISTS (SELECT 1 FROM unnest(account_scopes) scope WHERE scope<>ALL($2::text[]))
     ORDER BY token_id FOR UPDATE`, [[...LOCAL_CLIENT_PRINCIPALS], PRODUCT_ROLES.map(roleScope)]);
  if (tokens.rowCount === 0) return;
  const holders = await client.query<{ account_id: string; product_role: ProductRole }>(
    `SELECT account_id,COALESCE(product_role,'AGENT') product_role FROM line_accounts
     WHERE product_role=ANY($1::text[]) OR (product_role IS NULL AND role_revision>=1 AND own_mid IS NOT NULL
       AND mode='MONITOR_ONLY' AND status='disconnected' AND connection_mode='OFFLINE'
       AND worker_instance_id IS NULL AND worker_binding_epoch IS NULL
       AND selected_source_id IS NULL AND selected_source_generation IS NULL)
     ORDER BY account_id`, [[...PRODUCT_ROLES]]);
  // Only Agent replacement clears a product role and increments its revision. Fresh role rows start at zero;
  // migration-026 holders start at one. An arbitrary historical administrator binding supplies no role provenance.
  const roles = new Map(holders.rows.map((holder) => [holder.account_id, holder.product_role]));
  for (const token of tokens.rows) {
    const scopes = [...new Set(token.account_scopes.flatMap((scope) => {
      const role = parseRoleScope(scope) ?? roles.get(scope);
      return role ? [roleScope(role)] : [];
    }))];
    if (scopes.length === 0) {
      await client.query(`UPDATE mcp_agent_tokens SET state='REVOKED',revoked_at=clock_timestamp(),
        grant_version=grant_version+1 WHERE token_id=$1`, [token.token_id]);
    } else {
      await client.query(`UPDATE mcp_agent_tokens SET account_scopes=$2::text[],grant_version=grant_version+1
        WHERE token_id=$1`, [token.token_id, scopes]);
    }
  }
}
