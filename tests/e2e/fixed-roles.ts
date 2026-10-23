import type { Pool } from 'pg';

/**
 * Migration 026 allows exactly one AGENT and one PRIMARY_ADMIN account, and the connected facade refuses to start an
 * account that has no role slot. E2E fixtures share one schema across tests, so each test releases the previous test's
 * role slots before seeding its own accounts.
 */
export async function releaseRoleSlots(pool: Pool): Promise<void> {
  await pool.query("UPDATE line_accounts SET product_role=NULL, mode='MONITOR_ONLY', auto_login_on_startup=false WHERE product_role IS NOT NULL OR mode='ACTIVE_CONTROL'");
}

/**
 * autoLogin mirrors the per-account startup opt-in (v1.0.62): a saved session is only restored at application startup
 * for accounts that enabled it.
 */
export async function seedRoleAccount(pool: Pool, input: {
  accountId: string; role: 'AGENT' | 'PRIMARY_ADMIN'; mode?: 'ACTIVE_CONTROL' | 'MONITOR_ONLY';
  ownMid?: string | null; displayName?: string | null; status?: string; autoLogin?: boolean;
}): Promise<void> {
  await pool.query(
    'INSERT INTO line_accounts(account_id,mode,own_mid,product_role,display_name,status,auto_login_on_startup) VALUES ($1,$2,$3,$4,$5,COALESCE($6,\'disconnected\'),$7)',
    [input.accountId, input.mode ?? 'MONITOR_ONLY', input.ownMid ?? null, input.role, input.displayName ?? null, input.status ?? null,
      input.autoLogin ?? false]);
}

/** Gives an account created through the repositories (ensureAccount) its fixed role slot. */
export async function assignRoleSlot(pool: Pool, accountId: string, role: 'AGENT' | 'PRIMARY_ADMIN', autoLogin = false): Promise<void> {
  await pool.query('UPDATE line_accounts SET product_role=$2, auto_login_on_startup=$3 WHERE account_id=$1', [accountId, role, autoLogin]);
}
