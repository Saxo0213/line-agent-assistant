import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { createTestDatabase } from './test-database.js';
import { RoomActivationRepository } from './room-activation-repository.js';

const database = process.env.TEST_DATABASE_URL ? describe : describe.skip;

database('primary administrator replacement', () => {
  let pool: Awaited<ReturnType<typeof createTestDatabase>>['pool'];
  let close: () => Promise<void>;
  let repository: RoomActivationRepository;
  const suffix = randomUUID();
  beforeAll(async () => {
    ({ pool, close } = await createTestDatabase());
    repository = new RoomActivationRepository(pool);
  });

  afterAll(async () => close?.());

  async function fixture() {
    const id = randomUUID();
    const scope = { accountId: `activation-${id}`, chatType: 'group' as const, chatId: `room-${id}` };
    const adminUserId = `admin-user-${id}`;
    await pool.query('INSERT INTO line_accounts(account_id) VALUES ($1)', [scope.accountId]);
    await pool.query("INSERT INTO conversations(account_id, chat_type, chat_id) VALUES ($1, 'group', $2)", [scope.accountId, scope.chatId]);
    await repository.setPrimaryAdministrator(scope.accountId, `admin-${id}`, adminUserId, null);
    return { scope, adminUserId };
  }

  it('keeps administrator version maintenance compatible with account deletion', async () => {
    const f = await fixture();
    await pool.query('DELETE FROM line_accounts WHERE account_id = $1', [f.scope.accountId]);
    expect((await pool.query('SELECT count(*) FROM account_administrator_versions WHERE account_id = $1', [f.scope.accountId])).rows[0].count).toBe('0');
  });

  it('stops the free mode of the account in the same transaction as an administrator change', async () => {
    const f = await fixture();
    await pool.query(
      `INSERT INTO room_free_mode(account_id, chat_type, chat_id, enabled_by, expires_at)
       VALUES ($1, 'group', $2, $3, clock_timestamp() + interval '1 hour')`, [f.scope.accountId, f.scope.chatId, f.adminUserId]);
    expect(await repository.setPrimaryAdministrator(f.scope.accountId, `new-admin-${suffix}`, `new-user-${suffix}`, 1)).toEqual(expect.any(Number));
    expect((await pool.query('SELECT count(*) FROM room_free_mode WHERE account_id = $1', [f.scope.accountId])).rows[0].count).toBe('0');
  });

  it('refuses a stale administrator version and keeps the free mode', async () => {
    const f = await fixture();
    await pool.query(
      `INSERT INTO room_free_mode(account_id, chat_type, chat_id, enabled_by, expires_at)
       VALUES ($1, 'group', $2, $3, clock_timestamp() + interval '1 hour')`, [f.scope.accountId, f.scope.chatId, f.adminUserId]);
    expect(await repository.setPrimaryAdministrator(f.scope.accountId, `new-admin-${suffix}`, `new-user-${suffix}`, 99)).toBeNull();
    expect((await pool.query('SELECT count(*) FROM room_free_mode WHERE account_id = $1', [f.scope.accountId])).rows[0].count).toBe('1');
  });
});
