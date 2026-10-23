import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { createTestDatabase } from './test-database.js';
import { loadMigrations, migrate } from './migrate.js';
import { FriendWhitelistRepository } from './friend-whitelist-repository.js';
import { ExternalMonitorRepository } from './external-monitor-repository.js';
import { RoomActivationRepository } from './room-activation-repository.js';

const database = process.env.TEST_DATABASE_URL ? describe : describe.skip;

database('friend whitelist authorization grants', () => {
  let pool: Awaited<ReturnType<typeof createTestDatabase>>['pool'];
  let close: () => Promise<void>;
  let repository: FriendWhitelistRepository;

  beforeAll(async () => {
    ({ pool, close } = await createTestDatabase());
    repository = new FriendWhitelistRepository(pool);
  });
  afterAll(async () => close?.());

  async function enrollmentFixture() {
    const accountId = `enrollment-${randomUUID()}`;
    const control = await pool.query('SELECT control_epoch FROM account_control WHERE singleton=true');
    const controlEpoch = Number(control.rows[0].control_epoch);
    await pool.query("INSERT INTO line_accounts(account_id,mode,worker_instance_id,worker_binding_epoch) VALUES ($1,'ACTIVE_CONTROL','enrollment-worker',$2)", [accountId, controlEpoch]);
    await pool.query("INSERT INTO account_administrators(account_id,chat_type,chat_id,user_id,role) VALUES ($1,'direct','admin-chat','admin-mid','PRIMARY_ADMIN')", [accountId]);
    const version = await pool.query('SELECT version FROM account_administrator_versions WHERE account_id=$1', [accountId]);
    return { accountId, workerInstanceId: 'enrollment-worker', controlEpoch,
      selectedSourceId: null, selectedSourceGeneration: null, adminChatId: 'admin-chat', adminUserId: 'admin-mid',
      adminVersion: Number(version.rows[0].version), targetMid: 'u' + 'a'.repeat(32),
      scope: { kind: 'CHAT' as const, chatType: 'group' as const, chatId: 'original-group' } };
  }

  async function bindExternalSource(accountId: string, ownMid: string, sourceIdentity: string) {
    const agentAccountId = 'external-monitor-fixture-agent';
    await pool.query(`INSERT INTO line_accounts(account_id,own_mid,product_role) VALUES ($1,'external-fixture-agent-mid','AGENT')
      ON CONFLICT (account_id) DO UPDATE SET own_mid=EXCLUDED.own_mid,product_role='AGENT'`, [agentAccountId]);
    await pool.query("DELETE FROM account_administrators WHERE account_id=$1 AND role='PRIMARY_ADMIN'", [agentAccountId]);
    await pool.query(`INSERT INTO account_administrators(account_id,chat_type,chat_id,user_id,role)
      VALUES ($1,'direct','external-fixture-admin-chat',$2,'PRIMARY_ADMIN')`, [agentAccountId, ownMid]);
    return new ExternalMonitorRepository(pool).bindVerifiedExternalSource({ accountId, ownMid, sourceIdentity });
  }

  function pauseBefore(fragment: string) {
    let reached!: () => void; let resume!: () => void;
    const waiting = new Promise<void>((resolve) => { reached = resolve; });
    const released = new Promise<void>((resolve) => { resume = resolve; });
    const wrapped = { connect: async () => {
      const client = await pool.connect();
      return { query: async (sql: string, values?: unknown[]) => {
        if (sql.includes(fragment)) { reached(); await released; }
        const result = await client.query(sql, values);
        if (sql === 'BEGIN') await client.query("SET LOCAL statement_timeout='4000ms'");
        return result;
      }, release: () => client.release() };
    } } as unknown as typeof pool;
    return { repository: new FriendWhitelistRepository(wrapped), waiting, resume };
  }

  it('finishes enrollment and concurrent management activation without deadlock or duplicate audit', async () => {
    const input = await enrollmentFixture();
    const gate = pauseBefore('SELECT a.connection_mode');
    const enrollment = gate.repository.activateForEnrollment(input);
    await gate.waiting;
    const management = repository.activate(input.accountId, input.targetMid, 'manager', input.scope);
    gate.resume();
    try {
      const [first, second] = await Promise.all([enrollment, management]);
      expect(first.grantId).toBe(second.grantId);
      expect((await pool.query('SELECT count(*) FROM line_friend_whitelist_audit WHERE account_id=$1', [input.accountId])).rows[0].count).toBe('1');
    } finally { await pool.query("UPDATE line_accounts SET mode='PAUSED' WHERE account_id=$1", [input.accountId]); }
  });

  it.each(['update', 'delete', 'room-activation'] as const)('denies enrollment after committed administrator %s without deadlock', async (mutation) => {
    const input = await enrollmentFixture();
    const gate = pauseBefore('SELECT version FROM account_administrator_versions');
    const enrollment = gate.repository.activateForEnrollment(input);
    const outcome = enrollment.catch((error: Error) => error);
    await gate.waiting;
    try {
      if (mutation === 'room-activation') {
        await new RoomActivationRepository(pool).setPrimaryAdministrator(input.accountId, 'new-chat', 'new-admin', input.adminVersion);
      } else if (mutation === 'delete') {
        await pool.query('DELETE FROM account_administrators WHERE account_id=$1', [input.accountId]);
      } else {
        await pool.query("UPDATE account_administrators SET user_id='replacement-admin' WHERE account_id=$1", [input.accountId]);
      }
      gate.resume();
      expect(await outcome).toMatchObject({ message: 'ENROLLMENT_AUTHORITY_CHANGED' });
      expect(await repository.getActiveAuthorization(input.accountId, input.targetMid, input.scope)).toBeNull();
      expect((await pool.query('SELECT count(*) FROM line_friend_whitelist_audit WHERE account_id=$1', [input.accountId])).rows[0].count).toBe('0');
    } finally { gate.resume(); await outcome; await pool.query("UPDATE line_accounts SET mode='PAUSED',product_role=NULL WHERE account_id=$1", [input.accountId]); }
  });

  it('denies enrollment after a committed control switch before the locked check', async () => {
    const input = await enrollmentFixture();
    const gate = pauseBefore('SELECT control_epoch FROM account_control');
    const enrollment = gate.repository.activateForEnrollment(input);
    const outcome = enrollment.catch((error: Error) => error);
    await gate.waiting;
    try {
      await pool.query('UPDATE account_control SET control_epoch=control_epoch+1 WHERE singleton=true');
      gate.resume();
      expect(await outcome).toMatchObject({ message: 'ENROLLMENT_AUTHORITY_CHANGED' });
    } finally {
      gate.resume(); await outcome;
      await pool.query('UPDATE account_control SET control_epoch=$1 WHERE singleton=true', [input.controlEpoch]);
      await pool.query("UPDATE line_accounts SET mode='PAUSED' WHERE account_id=$1", [input.accountId]);
    }
  });

  it('denies enrollment after committed external source selection with no grant or audit', async () => {
    const input = await enrollmentFixture();
    const ownMid = 'u' + 'b'.repeat(32);
    await pool.query("UPDATE line_accounts SET own_mid=$2,product_role='PRIMARY_ADMIN' WHERE account_id=$1", [input.accountId, ownMid]);
    const gate = pauseBefore('SELECT control_epoch FROM account_control');
    const outcome = gate.repository.activateForEnrollment(input).catch((error: Error) => error);
    await gate.waiting;
    try {
      await bindExternalSource(input.accountId, ownMid, `source-${randomUUID()}`);
      gate.resume();
      expect(await outcome).toMatchObject({ message: 'EXTERNAL_MONITOR_READ_ONLY' });
      expect(await repository.getActiveAuthorization(input.accountId, input.targetMid, input.scope)).toBeNull();
      expect((await pool.query('SELECT count(*) FROM line_friend_whitelist_audit WHERE account_id=$1', [input.accountId])).rows[0].count).toBe('0');
    } finally { gate.resume(); await outcome; await pool.query("UPDATE line_accounts SET mode='PAUSED',product_role=NULL WHERE account_id=$1", [input.accountId]); }
  });

  it('rejects enrollment when the captured administrator version is stale', async () => {
    const input = await enrollmentFixture();
    const { accountId } = input;
    await expect(repository.activateForEnrollment({ ...input, adminVersion: -1 }))
      .rejects.toThrow('ENROLLMENT_AUTHORITY_CHANGED');
    expect(await repository.getActiveAuthorization(accountId, 'u' + 'a'.repeat(32), { kind: 'CHAT', chatType: 'group', chatId: 'original-group' })).toBeNull();
    await pool.query("UPDATE line_accounts SET mode='PAUSED' WHERE account_id=$1", [accountId]);
  });

  it('activates an account-scoped grant and advances its version after revocation', async () => {
    const id = randomUUID();
    const accountId = `whitelist-${id}`;
    const targetMid = `target-${id}`;
    await pool.query('INSERT INTO line_accounts(account_id) VALUES ($1)', [accountId]);

    const first = await repository.activate(accountId, targetMid, 'admin-a');
    expect(first).toMatchObject({ accountId, targetMid, state: 'ACTIVE', version: 1 });
    expect(await repository.getActiveAuthorization(accountId, targetMid)).toEqual(first);
    expect(await repository.getActiveAuthorization(`other-${id}`, targetMid)).toBeNull();

    expect(await repository.revoke(accountId, targetMid, 'admin-a')).toBe(true);
    expect(await repository.getActiveAuthorization(accountId, targetMid)).toBeNull();
    const second = await repository.activate(accountId, targetMid, 'admin-a');
    expect(second).toMatchObject({ accountId, targetMid, state: 'ACTIVE', version: 3 });
    expect(second.grantId).not.toBe(first.grantId);
  });

  it('keeps only one current grant when activation races', async () => {
    const id = randomUUID();
    const accountId = `whitelist-race-${id}`;
    const targetMid = `target-${id}`;
    await pool.query('INSERT INTO line_accounts(account_id) VALUES ($1)', [accountId]);

    const grants = await Promise.all([
      repository.activate(accountId, targetMid, 'admin-a'),
      repository.activate(accountId, targetMid, 'admin-b'),
    ]);

    expect(grants[0]?.grantId).toBe(grants[1]?.grantId);
    expect((await pool.query("SELECT count(*) FROM line_friend_whitelist_grants WHERE account_id=$1 AND target_mid=$2 AND state='ACTIVE'", [accountId, targetMid])).rows[0]?.count).toBe('1');
  });

  it('rechecks write capability after a blocked activation resumes behind external source selection', async () => {
    const id = randomUUID();
    const accountId = `whitelist-source-fence-${id}`;
    const targetMid = `target-${id}`;
    await pool.query('INSERT INTO line_accounts(account_id,own_mid,product_role) VALUES ($1,$2,\'PRIMARY_ADMIN\')',
      [accountId, `own-${id}`]);

    const gate = pauseBefore('SELECT a.connection_mode');
    const activation = gate.repository.activate(accountId, targetMid, 'admin');
    await gate.waiting;
    await bindExternalSource(accountId, `own-${id}`, `source-${id}`);
    gate.resume();

    try { await expect(activation).rejects.toThrow('EXTERNAL_MONITOR_READ_ONLY'); }
    finally { gate.resume(); }
    expect((await pool.query('SELECT count(*) FROM line_friend_whitelist_grants WHERE account_id=$1', [accountId])).rows[0]?.count).toBe('0');
    expect((await pool.query('SELECT count(*) FROM line_friend_whitelist_audit WHERE account_id=$1', [accountId])).rows[0]?.count).toBe('0');
  });

  it('keeps account and chat grants in independent scopes with independent versions', async () => {
    const id = randomUUID();
    const accountId = `whitelist-scope-${id}`;
    const targetMid = `target-${id}`;
    await pool.query('INSERT INTO line_accounts(account_id) VALUES ($1)', [accountId]);

    const groupA = await repository.activate(accountId, targetMid, 'admin-a', { kind: 'CHAT', chatType: 'group', chatId: 'group-a' });
    const groupB = await repository.activate(accountId, targetMid, 'admin-a', { kind: 'CHAT', chatType: 'group', chatId: 'group-b' });
    const account = await repository.activate(accountId, targetMid, 'admin-a');

    expect(groupA).toMatchObject({ scopeKind: 'CHAT', chatType: 'group', chatId: 'group-a', version: 1 });
    expect(groupB).toMatchObject({ scopeKind: 'CHAT', chatType: 'group', chatId: 'group-b', version: 1 });
    expect(account).toMatchObject({ scopeKind: 'ACCOUNT', chatType: null, chatId: null, version: 1 });
    expect(await repository.activate(accountId, targetMid, 'admin-b', { kind: 'CHAT', chatType: 'group', chatId: 'group-a' }))
      .toEqual(groupA);
    expect((await pool.query(`SELECT grant_id FROM line_friend_whitelist_grants
      WHERE account_id=$1 AND target_mid=$2 AND scope_kind='CHAT' AND chat_type='group' AND chat_id='group-a' AND state='ACTIVE'`,
    [accountId, targetMid])).rows).toEqual([{ grant_id: groupA.grantId }]);
    expect(await repository.getActiveAuthorization(accountId, targetMid, { kind: 'CHAT', chatType: 'group', chatId: 'group-c' }))
      .toMatchObject({ grantId: account.grantId, scopeKind: 'ACCOUNT' });
    expect(await repository.getActiveAuthorization(accountId, targetMid, { kind: 'CHAT', chatType: 'group', chatId: 'group-a' }))
      .toMatchObject({ grantId: groupA.grantId, scopeKind: 'CHAT', chatId: 'group-a' });
  });

  it('creates an exact chat grant when account authorization already exists', async () => {
    const id = randomUUID();
    const accountId = `whitelist-account-first-${id}`;
    const targetMid = `target-${id}`;
    await pool.query('INSERT INTO line_accounts(account_id) VALUES ($1)', [accountId]);
    const account = await repository.activate(accountId, targetMid);

    const group = await repository.activate(accountId, targetMid, null, { kind: 'CHAT', chatType: 'room', chatId: 'room-a' });

    expect(group).toMatchObject({ scopeKind: 'CHAT', chatType: 'room', chatId: 'room-a' });
    expect(group.grantId).not.toBe(account.grantId);
    expect((await pool.query('SELECT scope_kind FROM line_friend_whitelist_grants WHERE account_id=$1 AND target_mid=$2 ORDER BY scope_kind',
      [accountId, targetMid])).rows).toEqual([{ scope_kind: 'ACCOUNT' }, { scope_kind: 'CHAT' }]);
  });

  it('revokes and advances only the selected chat scope', async () => {
    const id = randomUUID();
    const accountId = `whitelist-chat-revoke-${id}`;
    const targetMid = `target-${id}`;
    const groupA = { kind: 'CHAT' as const, chatType: 'group' as const, chatId: 'group-a' };
    const groupB = { kind: 'CHAT' as const, chatType: 'group' as const, chatId: 'group-b' };
    await pool.query('INSERT INTO line_accounts(account_id) VALUES ($1)', [accountId]);
    const firstA = await repository.activate(accountId, targetMid, 'admin', groupA);
    const firstB = await repository.activate(accountId, targetMid, 'admin', groupB);

    expect(await repository.revoke(accountId, targetMid, 'admin', groupA)).toBe(true);
    const secondA = await repository.activate(accountId, targetMid, 'admin', groupA);

    expect(secondA).toMatchObject({ scopeKind: 'CHAT', chatId: 'group-a', version: 3 });
    expect(await repository.getActiveAuthorization(accountId, targetMid, groupB)).toEqual(firstB);
    expect(await repository.getActiveAuthorization(accountId, targetMid, groupA)).toEqual(secondA);
    expect((await pool.query(`SELECT scope_kind, chat_type, chat_id, action, grant_version FROM line_friend_whitelist_audit
      WHERE account_id=$1 AND target_mid=$2 ORDER BY audit_id`, [accountId, targetMid])).rows).toEqual([
      { scope_kind: 'CHAT', chat_type: 'group', chat_id: 'group-a', action: 'ACTIVATED', grant_version: '1' },
      { scope_kind: 'CHAT', chat_type: 'group', chat_id: 'group-b', action: 'ACTIVATED', grant_version: '1' },
      { scope_kind: 'CHAT', chat_type: 'group', chat_id: 'group-a', action: 'REVOKED', grant_version: '2' },
      { scope_kind: 'CHAT', chat_type: 'group', chat_id: 'group-a', action: 'ACTIVATED', grant_version: '3' },
    ]);
    expect(firstA.grantId).not.toBe(secondA.grantId);
  });

  it('serializes chat activations behind the account row and completes each chat without deadlock', async () => {
    const id = randomUUID();
    const accountId = `whitelist-lock-chat-${id}`;
    const targetMid = `target-${id}`;
    await pool.query('INSERT INTO line_accounts(account_id) VALUES ($1)', [accountId]);
    const lockClient = await pool.connect();
    const scopeA = JSON.stringify([accountId, targetMid, 'CHAT', 'group', 'group-a']);
    await lockClient.query('BEGIN');
    await lockClient.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [scopeA]);
    let aDone = false;
    let sameScopeDone = false;
    let otherScope!: Promise<Awaited<ReturnType<typeof repository.activate>>>;
    const a = repository.activate(accountId, targetMid, 'admin-a', { kind: 'CHAT', chatType: 'group', chatId: 'group-a' })
      .then((grant) => { aDone = true; return grant; });
    const sameScope = repository.activate(accountId, targetMid, 'admin-b', { kind: 'CHAT', chatType: 'group', chatId: 'group-a' })
      .then((grant) => { sameScopeDone = true; return grant; });
    let otherScopeCompletedBeforeRelease = false;
    try {
      const b = otherScope = repository.activate(accountId, targetMid, 'admin-b', { kind: 'CHAT', chatType: 'group', chatId: 'group-b' });
      otherScopeCompletedBeforeRelease = await Promise.race([
        b.then((grant) => grant.scopeKind === 'CHAT' && grant.chatId === 'group-b' && grant.version === 1),
        new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 250)),
      ]);
    } finally {
      await lockClient.query('COMMIT');
      lockClient.release();
    }
    const [firstA, sameA, firstB] = await Promise.all([a, sameScope, otherScope]);
    expect(otherScopeCompletedBeforeRelease).toBe(false);
    expect(aDone).toBe(true);
    expect(sameScopeDone).toBe(true);
    expect(firstA.grantId).toBe(sameA.grantId);
    expect(firstB).toMatchObject({ scopeKind: 'CHAT', chatId: 'group-b', version: 1 });
    expect((await repository.getActiveAuthorization(accountId, targetMid,
      { kind: 'CHAT', chatType: 'group', chatId: 'group-b' }))?.scopeKind).toBe('CHAT');
  });

  it('serializes concurrent account and chat enrollment and retains both exact scopes', async () => {
    const id = randomUUID();
    const accountId = `whitelist-lock-account-${id}`;
    const targetMid = `target-${id}`;
    await pool.query('INSERT INTO line_accounts(account_id) VALUES ($1)', [accountId]);
    let releaseAccountLock!: () => void;
    let accountLockTaken!: () => void;
    const releaseGate = new Promise<void>((resolve) => { releaseAccountLock = resolve; });
    const accountLocked = new Promise<void>((resolve) => { accountLockTaken = resolve; });
    const guardedPool = {
      query: pool.query.bind(pool),
      connect: async () => {
        const client = await pool.connect();
        let paused = false;
        return {
          query: async (sql: string, values?: unknown[]) => {
            const result = await client.query(sql, values);
            if (!paused && sql === 'SELECT pg_advisory_xact_lock(hashtextextended($1, 0))'
              && values?.[0] === JSON.stringify([accountId, targetMid, 'ACCOUNT'])) {
              paused = true;
              accountLockTaken();
              await releaseGate;
            }
            return result;
          },
          release: () => client.release(),
        };
      },
    } as unknown as typeof pool;
    const accountRepository = new FriendWhitelistRepository(guardedPool);
    const accountEnrollment = accountRepository.activate(accountId, targetMid, 'admin');
    const accountLockOutcome = await Promise.race([
      accountLocked.then(() => 'expected-lock'),
      accountEnrollment.then(() => 'account-finished-before-chat'),
    ]);
    expect(accountLockOutcome).toBe('expected-lock');
    const chatEnrollment = repository.activate(accountId, targetMid, 'admin', { kind: 'CHAT', chatType: 'group', chatId: 'group-a' });
    releaseAccountLock();

    const [account, chat] = await Promise.all([accountEnrollment, chatEnrollment]);
    expect(account.scopeKind).toBe('ACCOUNT');
    expect(chat).toMatchObject({ scopeKind: 'CHAT', chatType: 'group', chatId: 'group-a' });
    expect((await pool.query(`SELECT count(*) FROM line_friend_whitelist_grants
      WHERE account_id=$1 AND target_mid=$2 AND state='ACTIVE'`, [accountId, targetMid])).rows[0]?.count).toBe('2');
  });

  it('records activation and revocation in append-only audit history', async () => {
    const id = randomUUID();
    const accountId = `whitelist-audit-${id}`;
    const targetMid = `target-${id}`;
    await pool.query('INSERT INTO line_accounts(account_id) VALUES ($1)', [accountId]);
    const grant = await repository.activate(accountId, targetMid, 'admin-a');
    await repository.revoke(accountId, targetMid, 'admin-b');

    const audit = await pool.query('SELECT action, actor_id, grant_version FROM line_friend_whitelist_audit WHERE account_id=$1 AND target_mid=$2 ORDER BY audit_id', [accountId, targetMid]);
    expect(audit.rows).toEqual([
      { action: 'ACTIVATED', actor_id: 'admin-a', grant_version: '1' },
      { action: 'REVOKED', actor_id: 'admin-b', grant_version: '2' },
    ]);
    await expect(pool.query('DELETE FROM line_friend_whitelist_audit WHERE account_id=$1', [accountId]))
      .rejects.toThrow('line_friend_whitelist_audit is append-only');
    expect(grant.state).toBe('ACTIVE');
  });
});

database('friend whitelist scope migration', () => {
  it('preserves legacy grant and audit history and separates account and chat versions', async () => {
    const url = process.env.TEST_DATABASE_URL!;
    const schema = `test_whitelist_migration_${randomUUID().replaceAll('-', '')}`;
    const admin = new Pool({ connectionString: url });
    await admin.query(`CREATE SCHEMA "${schema}"`);
    const pool = new Pool({ connectionString: url, options: `-c search_path=${schema}` });
    try {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        await client.query("CREATE TABLE schema_migrations (name text PRIMARY KEY, checksum text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now())");
        for (const migration of (await loadMigrations()).filter((item) => item.name < '022_friend_whitelist_scopes.sql')) {
          await client.query(migration.sql);
          await client.query('INSERT INTO schema_migrations (name, checksum) VALUES ($1, $2)', [migration.name, migration.checksum]);
        }
        await client.query('COMMIT');
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      } finally { client.release(); }

      const accountId = `legacy-${randomUUID()}`;
      const targetMid = `target-${randomUUID()}`;
      const oldGrantId = randomUUID();
      const oldRevokedGrantId = randomUUID();
      const revokedAt = '2026-10-15T12:34:56.000Z';
      await pool.query('INSERT INTO line_accounts(account_id) VALUES ($1)', [accountId]);
      await pool.query(`INSERT INTO line_friend_whitelist_grants(grant_id, account_id, target_mid, capability, version, state, revoked_at)
        VALUES ($1,$2,$3,'AGENT_USE_DIRECT',1,'ACTIVE',NULL), ($4,$2,$3,'AGENT_USE_DIRECT',2,'REVOKED',$5)`,
      [oldGrantId, accountId, targetMid, oldRevokedGrantId, revokedAt]);
      await pool.query(`INSERT INTO line_friend_whitelist_audit(grant_id, account_id, target_mid, action, actor_id, grant_version)
        VALUES ($1,$2,$3,'ACTIVATED','old-admin',1), ($4,$2,$3,'REVOKED','old-admin',2)`,
      [oldGrantId, accountId, targetMid, oldRevokedGrantId]);

      await migrate(pool);
      const legacy = await pool.query(`SELECT grant_id, capability, scope_kind, chat_type, chat_id, state, version, revoked_at
        FROM line_friend_whitelist_grants WHERE account_id=$1 AND target_mid=$2 ORDER BY version`, [accountId, targetMid]);
      expect(legacy.rows.map((row) => ({ ...row, revoked_at: row.revoked_at?.toISOString() ?? null }))).toEqual([
        { grant_id: oldGrantId, capability: 'AGENT_USE', scope_kind: 'ACCOUNT', chat_type: null, chat_id: null, state: 'ACTIVE', version: '1', revoked_at: null },
        { grant_id: oldRevokedGrantId, capability: 'AGENT_USE', scope_kind: 'ACCOUNT', chat_type: null, chat_id: null, state: 'REVOKED', version: '2', revoked_at: new Date(revokedAt).toISOString() },
      ]);
      expect((await pool.query(`SELECT scope_kind, chat_type, chat_id, action, actor_id, grant_version
        FROM line_friend_whitelist_audit WHERE account_id=$1 AND target_mid=$2 ORDER BY audit_id`, [accountId, targetMid])).rows)
        .toEqual([
          { scope_kind: 'ACCOUNT', chat_type: null, chat_id: null, action: 'ACTIVATED', actor_id: 'old-admin', grant_version: '1' },
          { scope_kind: 'ACCOUNT', chat_type: null, chat_id: null, action: 'REVOKED', actor_id: 'old-admin', grant_version: '2' },
        ]);

      await expect(pool.query(`INSERT INTO line_friend_whitelist_grants
        (grant_id, account_id, target_mid, capability, scope_kind, chat_type, chat_id, version, state)
        VALUES ($1,$2,$3,'AGENT_USE','CHAT',NULL,'invalid-chat',1,'ACTIVE')`, [randomUUID(), accountId, 'null-chat-grant']))
        .rejects.toThrow();
      await expect(pool.query(`INSERT INTO line_friend_whitelist_audit
        (grant_id, account_id, target_mid, scope_kind, chat_type, chat_id, action, grant_version)
        VALUES ($1,$2,$3,'CHAT',NULL,'invalid-chat','ACTIVATED',1)`, [randomUUID(), accountId, 'null-chat-audit']))
        .rejects.toThrow();

      const versionedMid = `versioned-${randomUUID()}`;
      await pool.query(`INSERT INTO line_friend_whitelist_grants(grant_id, account_id, target_mid, capability, scope_kind, chat_type, chat_id, version, state)
        VALUES ($1,$2,$3,'AGENT_USE','ACCOUNT',NULL,NULL,1,'ACTIVE'),
               ($4,$2,$3,'AGENT_USE','CHAT','group','group-a',1,'ACTIVE'),
               ($5,$2,$3,'AGENT_USE','CHAT','group','group-b',1,'ACTIVE'),
               ($6,$2,$3,'AGENT_USE','CHAT','room','room-a',1,'ACTIVE')`,
      [randomUUID(), accountId, versionedMid, randomUUID(), randomUUID(), randomUUID()]);
      await expect(pool.query(`INSERT INTO line_friend_whitelist_grants(grant_id, account_id, target_mid, capability, scope_kind, chat_type, chat_id, version, state)
        VALUES ($1,$2,$3,'AGENT_USE','CHAT','group','group-a',2,'ACTIVE')`, [randomUUID(), accountId, versionedMid]))
        .rejects.toThrow();
      await expect(pool.query(`INSERT INTO line_friend_whitelist_grants(grant_id, account_id, target_mid, capability, scope_kind, chat_type, chat_id, version, state, revoked_at)
        VALUES ($1,$2,$3,'AGENT_USE','CHAT','group','group-a',1,'REVOKED',clock_timestamp())`, [randomUUID(), accountId, versionedMid]))
        .rejects.toMatchObject({ code: '23505', constraint: 'line_friend_whitelist_chat_history_version_idx' });
    } finally {
      await pool.end();
      await admin.query(`DROP SCHEMA "${schema}" CASCADE`);
      await admin.end();
    }
  });
});
