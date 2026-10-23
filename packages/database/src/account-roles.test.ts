import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Pool } from 'pg';
import { AccountRepository } from './account-repository.js';
import { createTestDatabase } from './test-database.js';
import { loadMigrations } from './migrate.js';

const database = process.env.TEST_DATABASE_URL ? describe : describe.skip;

describe('Primary Admin login binding guard', () => {
  it('rejects a different MID before committing the pending credential rotation', async () => {
    const statements: string[] = [];
    const client = {
      async query(sql: string) {
        statements.push(sql);
        if (sql.includes('SELECT product_role')) return { rowCount: 1, rows: [{ product_role: 'PRIMARY_ADMIN' }] };
        if (sql.includes("SELECT account_id FROM line_accounts WHERE product_role='AGENT'")) return { rowCount: 1, rows: [{ account_id: 'agent' }] };
        if (sql.includes('SELECT version FROM account_administrator_versions')) return { rowCount: 1, rows: [{ version: '1' }] };
        if (sql.includes('FROM account_administrators')) return { rowCount: 0, rows: [] };
        return { rowCount: 1, rows: [] };
      }, release() {},
    };
    const pool = { connect: async () => client } as unknown as Pool;
    const accounts = new AccountRepository(pool);
    let committed = false;
    await expect(accounts.applyWorkerLogin({ accountId: 'admin', workerInstanceId: 'worker', controlEpoch: 1 },
      'wrong-mid', null, undefined, async () => { committed = true; })).resolves.toBe(false);
    expect(committed).toBe(false);
    expect(statements.some((sql) => sql.startsWith('UPDATE line_accounts'))).toBe(false);
  });
});

database('fixed account role slots', () => {
  let pool: Pool;
  let close: () => Promise<void>;
  let accounts: AccountRepository;
  beforeAll(async () => {
    ({ pool, close } = await createTestDatabase());
    accounts = new AccountRepository(pool);
  });
  afterAll(async () => { await close?.(); });

  it('reserves Agent once, then reuses its pending slot after restart', async () => {
    const first = await accounts.reserveAccountSlot();
    const retry = await new AccountRepository(pool).reserveAccountSlot();
    expect(first).toMatchObject({ productRole: 'AGENT', ownMid: null });
    expect(retry).toEqual(first);
    expect((await pool.query('SELECT count(*) FROM line_accounts')).rows[0].count).toBe('1');
  });

  it('serializes concurrent first reservations to one Agent slot', async () => {
    const slots = await Promise.all(Array.from({ length: 8 }, () => accounts.reserveAccountSlot()));
    expect(new Set(slots.map((slot) => slot.accountId)).size).toBe(1);
    expect(new Set(slots.map((slot) => slot.productRole))).toEqual(new Set(['AGENT']));
    expect((await pool.query('SELECT count(*) FROM line_accounts')).rows[0].count).toBe('1');
  });

  it('rejects reserving a third account after both roles are assigned', async () => {
    await accounts.reserveAccountSlot();
    await pool.query("UPDATE line_accounts SET own_mid='agent-mid' WHERE product_role='AGENT'");
    await expect(accounts.reserveAccountSlot()).rejects.toThrow(/verified primary admin binding/i);
    await pool.query("INSERT INTO account_administrators(account_id,chat_type,chat_id,user_id,role) VALUES ((SELECT account_id FROM line_accounts WHERE product_role='AGENT'),'direct','admin-chat','admin-mid','PRIMARY_ADMIN')");
    const admin = await accounts.reserveAccountSlot();
    expect(admin.productRole).toBe('PRIMARY_ADMIN');
    await pool.query("UPDATE line_accounts SET own_mid='admin-mid' WHERE product_role='PRIMARY_ADMIN'");
    await expect(accounts.reserveAccountSlot()).rejects.toThrow(/both fixed line account slots are occupied/i);
    expect((await pool.query('SELECT count(*) FROM line_accounts')).rows[0].count).toBe('2');
  });

  it('backfills roles only for the exact verified binding pair, regardless of connection status', async () => {
    const migration = (await loadMigrations()).find(({ name }) => name === '026_fixed_account_roles.sql')!;
    const backfill = migration.sql.slice(0, migration.sql.indexOf('CREATE UNIQUE INDEX'));
    await pool.query('TRUNCATE line_accounts CASCADE');
    await pool.query(backfill);
    expect((await pool.query('SELECT count(*) FROM line_accounts WHERE product_role IS NOT NULL')).rows[0].count).toBe('0');
    await pool.query("INSERT INTO line_accounts(account_id,own_mid) VALUES ('legacy-agent','agent-mid')");
    await pool.query("INSERT INTO account_administrators(account_id,chat_type,chat_id,user_id,role) VALUES ('legacy-agent','direct','admin-chat','admin-mid','PRIMARY_ADMIN')");
    await pool.query(backfill);
    expect((await pool.query('SELECT count(*) FROM line_accounts WHERE product_role IS NOT NULL')).rows[0].count).toBe('0');
    await pool.query('TRUNCATE line_accounts CASCADE');
    await pool.query("INSERT INTO line_accounts(account_id,own_mid) VALUES ('legacy-agent','agent-mid'),('legacy-admin','admin-mid'),('ambiguous','other-mid')");
    await pool.query("INSERT INTO account_administrators(account_id,chat_type,chat_id,user_id,role) VALUES ('legacy-agent','direct','admin-chat','admin-mid','PRIMARY_ADMIN')");
    await pool.query(backfill);
    expect((await pool.query('SELECT count(*) FROM line_accounts WHERE product_role IS NOT NULL')).rows[0].count).toBe('0');
    await pool.query('TRUNCATE line_accounts CASCADE');
    await pool.query("INSERT INTO line_accounts(account_id,own_mid,status) VALUES ('legacy-agent','agent-mid','disconnected'),('legacy-admin','admin-mid','reauth_required')");
    await pool.query("INSERT INTO account_administrators(account_id,chat_type,chat_id,user_id,role) VALUES ('legacy-agent','direct','admin-chat','admin-mid','PRIMARY_ADMIN')");
    await pool.query(backfill);
    expect((await pool.query("SELECT account_id,product_role FROM line_accounts WHERE account_id LIKE 'legacy-%' ORDER BY account_id")).rows)
      .toEqual([{ account_id: 'legacy-admin', product_role: 'PRIMARY_ADMIN' }, { account_id: 'legacy-agent', product_role: 'AGENT' }]);
  });
});

database('External Monitor primary admin display name', () => {
  let pool: Pool;
  let close: () => Promise<void>;
  let accounts: AccountRepository;
  const mid = `u${'a'.repeat(32)}`;
  beforeAll(async () => {
    ({ pool, close } = await createTestDatabase());
    accounts = new AccountRepository(pool);
  });
  afterAll(async () => { await close?.(); });

  it('uses the supplied name for a new slot, preserves or updates an existing name, and excludes names from audit details', async () => {
    await pool.query('TRUNCATE line_accounts CASCADE');
    const created = await accounts.bindPrimaryAdminFromExternalMonitor({ mid, correlationId: 'name-create', displayName: '  Admin LINE  ', picturePath: '/admin-photo' });
    expect(created.ok).toBe(true);
    let row = (await pool.query("SELECT display_name,picture_path FROM line_accounts WHERE product_role='PRIMARY_ADMIN'")).rows[0];
    expect(row).toEqual({ display_name: 'Admin LINE', picture_path: 'https://profile.line-scdn.net/admin-photo' });
    expect(JSON.stringify((await pool.query("SELECT details FROM audit_logs WHERE action='primary_admin_bound_external_monitor'")).rows))
      .not.toContain('Admin LINE');

    await pool.query('TRUNCATE line_accounts CASCADE');
    await accounts.bindPrimaryAdminFromExternalMonitor({ mid, correlationId: 'name-default', displayName: null });
    row = (await pool.query("SELECT display_name FROM line_accounts WHERE product_role='PRIMARY_ADMIN'")).rows[0];
    expect(row.display_name).toBe('Primary Admin');

    await pool.query('TRUNCATE line_accounts CASCADE');
    await pool.query("INSERT INTO line_accounts(account_id,display_name,product_role,picture_path) VALUES ('existing-admin','Existing Name','PRIMARY_ADMIN','https://profile.line-scdn.net/existing')");
    await accounts.bindPrimaryAdminFromExternalMonitor({ mid, correlationId: 'name-preserve', displayName: null });
    row = (await pool.query("SELECT display_name,picture_path FROM line_accounts WHERE product_role='PRIMARY_ADMIN'")).rows[0];
    expect(row).toEqual({ display_name: 'Existing Name', picture_path: 'https://profile.line-scdn.net/existing' });

    await pool.query('TRUNCATE line_accounts CASCADE');
    await pool.query("INSERT INTO line_accounts(account_id,display_name,product_role) VALUES ('existing-admin','Existing Name','PRIMARY_ADMIN')");
    await accounts.bindPrimaryAdminFromExternalMonitor({ mid, correlationId: 'name-update', displayName: 'New Name' });
    row = (await pool.query("SELECT display_name FROM line_accounts WHERE product_role='PRIMARY_ADMIN'")).rows[0];
    expect(row.display_name).toBe('New Name');
  });
});
