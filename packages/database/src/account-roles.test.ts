import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
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
  beforeEach(async () => {
    await pool.query('TRUNCATE line_accounts CASCADE');
    await pool.query('UPDATE account_control SET control_epoch=1 WHERE singleton=true');
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

  it('replaces a stopped Agent in isolation and advances the control fence once', async () => {
    const old = await accounts.reserveAccountSlot();
    const mid = `u${'a'.repeat(32)}`;
    await accounts.activateControl(old.accountId, 0);
    await accounts.bindWorker({ accountId: old.accountId, workerInstanceId: 'old-worker', controlEpoch: 0 });
    expect(await accounts.applyWorkerLogin({ accountId: old.accountId, workerInstanceId: 'old-worker', controlEpoch: 0 }, mid, 'Old Agent')).toBe(true);
    await pool.query(`INSERT INTO conversations(account_id,chat_type,chat_id,title) VALUES ($1,'direct','old-chat','Old archive')`, [old.accountId]);
    await pool.query(`INSERT INTO messages(account_id,message_id,event_id,chat_type,chat_id,sender_id,kind,text_content,ingestion_source,occurred_at,raw)
      VALUES ($1,'old-message','old-event','direct','old-chat','friend-mid','text','Archived message','history',now(),'{}')`, [old.accountId]);
    await pool.query(`INSERT INTO attachments(attachment_id,external_attachment_id,account_id,message_id,chat_type,chat_id,kind,name,mime_type,size_bytes,status,relative_path,sha256)
      VALUES ('00000000-0000-4000-8000-000000000001','old-external',$1,'old-message','direct','old-chat','file','archive.txt','text/plain',12,'ready','old/archive.txt',repeat('a',64))`, [old.accountId]);
    await pool.query(`INSERT INTO account_administrators(account_id,chat_type,chat_id,user_id,role)
      VALUES ($1,'direct','admin-mid','admin-mid','PRIMARY_ADMIN')`, [old.accountId]);
    const epoch = await accounts.getControlState();
    await accounts.revokeControl(epoch.controlEpoch);
    await accounts.clearStoppedWorkerBinding({ accountId: old.accountId, workerInstanceId: 'old-worker', controlEpoch: 0 });
    await accounts.setConnectionStatus(old.accountId, 'disconnected');
    const stoppedEpoch = await accounts.getControlState();

    const replaced = await accounts.replaceAgentAccount(old.accountId, stoppedEpoch.controlEpoch);
    expect(replaced.ok).toBe(true);
    if (!replaced.ok) return;
    expect(replaced.account.accountId).not.toBe(old.accountId);
    expect(replaced.account).toMatchObject({ ownMid: null, productRole: 'AGENT' });
    expect(await accounts.getControlState()).toMatchObject({ activeAccountId: null, controlEpoch: stoppedEpoch.controlEpoch + 1 });
    expect((await pool.query('SELECT account_id,own_mid,product_role,status FROM line_accounts WHERE account_id=ANY($1)', [[old.accountId, replaced.account.accountId]])).rows)
      .toEqual(expect.arrayContaining([
        expect.objectContaining({ account_id: old.accountId, own_mid: mid, product_role: null, status: 'disconnected' }),
        expect.objectContaining({ account_id: replaced.account.accountId, own_mid: null, product_role: 'AGENT' }),
      ]));
    expect((await pool.query("SELECT account_id,chat_id FROM conversations WHERE account_id=$1 AND chat_id='old-chat'", [old.accountId])).rows)
      .toEqual([{ account_id: old.accountId, chat_id: 'old-chat' }]);
    expect((await pool.query("SELECT count(*) FROM conversations WHERE account_id=$1 AND chat_id='old-chat'", [replaced.account.accountId])).rows[0].count).toBe('0');
    expect((await pool.query("SELECT message_id,text_content FROM messages WHERE account_id=$1 AND chat_id='old-chat'", [old.accountId])).rows)
      .toEqual([{ message_id: 'old-message', text_content: 'Archived message' }]);
    expect((await pool.query("SELECT attachment_id,relative_path,sha256 FROM attachments WHERE account_id=$1 AND message_id='old-message'", [old.accountId])).rows)
      .toEqual([{ attachment_id: '00000000-0000-4000-8000-000000000001', relative_path: 'old/archive.txt', sha256: 'a'.repeat(64) }]);
    expect(await accounts.resolveCapabilities(old.accountId)).toMatchObject({ productRole: null, connectionMode: 'OFFLINE', canWriteLine: false });
    expect(await accounts.applyWorkerLogin({ accountId: old.accountId, workerInstanceId: 'old-worker', controlEpoch: stoppedEpoch.controlEpoch }, mid, 'Old Agent')).toBe(false);
    expect((await pool.query('SELECT account_id FROM account_administrators WHERE account_id=ANY($1)', [[old.accountId, replaced.account.accountId]])).rows)
      .toEqual([{ account_id: old.accountId }]);
  });

  it('does not retire the old Agent or create a second slot on a failed or duplicate replacement', async () => {
    const old = await accounts.reserveAccountSlot();
    const mid = `u${'b'.repeat(32)}`;
    const initialState = await accounts.getControlState();
    expect((await accounts.activateControl(old.accountId, initialState.controlEpoch)).activated).toBe(true);
    await accounts.bindWorker({ accountId: old.accountId, workerInstanceId: 'old-worker', controlEpoch: initialState.controlEpoch });
    expect(await accounts.applyWorkerLogin({ accountId: old.accountId, workerInstanceId: 'old-worker', controlEpoch: initialState.controlEpoch }, mid, 'Old Agent')).toBe(true);
    const epoch = await accounts.getControlState();
    const activeControl = await accounts.replaceAgentAccount(old.accountId, epoch.controlEpoch);
    expect(activeControl).toMatchObject({ ok: false, code: 'AGENT_CONTROL_ACTIVE' });
    await accounts.revokeControl(epoch.controlEpoch);
    const notStopped = await accounts.replaceAgentAccount(old.accountId, epoch.controlEpoch + 1);
    expect(notStopped).toMatchObject({ ok: false, code: 'AGENT_WORKER_ACTIVE' });
    expect(await accounts.getAccount(old.accountId)).toMatchObject({ productRole: 'AGENT', ownMid: mid });
    await accounts.clearStoppedWorkerBinding({ accountId: old.accountId, workerInstanceId: 'old-worker', controlEpoch: epoch.controlEpoch });
    await accounts.setConnectionStatus(old.accountId, 'disconnected');
    const stoppedEpoch = await accounts.getControlState();
    const first = await accounts.replaceAgentAccount(old.accountId, stoppedEpoch.controlEpoch);
    expect(first.ok).toBe(true);
    const duplicate = await accounts.replaceAgentAccount(old.accountId, stoppedEpoch.controlEpoch);
    expect(duplicate).toMatchObject({ ok: false, code: 'AGENT_REPLACEMENT_STALE' });
    expect((await pool.query("SELECT count(*) FROM line_accounts WHERE product_role='AGENT'")).rows[0].count).toBe('1');
  });

  it('keeps same-MID login on its original account', async () => {
    const original = await accounts.reserveAccountSlot();
    const mid = `u${'c'.repeat(32)}`;
    await accounts.activateControl(original.accountId, 0);
    await accounts.bindWorker({ accountId: original.accountId, workerInstanceId: 'worker-one', controlEpoch: 0 });
    expect(await accounts.applyWorkerLogin({ accountId: original.accountId, workerInstanceId: 'worker-one', controlEpoch: 0 }, mid, 'Agent')).toBe(true);
    await pool.query("UPDATE line_accounts SET worker_instance_id=NULL,worker_binding_epoch=NULL,status='disconnected' WHERE account_id=$1", [original.accountId]);
    await accounts.bindWorker({ accountId: original.accountId, workerInstanceId: 'worker-two', controlEpoch: 0 });
    expect(await accounts.applyWorkerLogin({ accountId: original.accountId, workerInstanceId: 'worker-two', controlEpoch: 0 }, mid, 'Agent'))
      .toBe(true);
    expect((await pool.query("SELECT count(*) FROM line_accounts WHERE product_role='AGENT'")).rows[0].count).toBe('1');
    expect((await accounts.getAccount(original.accountId))?.ownMid).toBe(mid);
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
