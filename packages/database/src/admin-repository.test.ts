import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Pool } from 'pg';
import { createTestDatabase } from './test-database.js';
import { AccountRepository } from './account-repository.js';
import { AdminRepository } from './admin-repository.js';

const database = process.env.TEST_DATABASE_URL ? describe : describe.skip;

describe('primary administrator direct identity lookup', () => {
  it('reads only the account primary direct chat and sender identity', async () => {
    const query = vi.fn(async () => ({ rows: [{ chat_id: 'primary-chat', user_id: 'primary-user' }] }));
    const admins = new AdminRepository({ query } as never);
    await expect(admins.getPrimaryAdministrator('account-a')).resolves.toEqual({ chatId: 'primary-chat', userId: 'primary-user' });
    expect(query).toHaveBeenCalledWith(expect.stringContaining("chat_type='direct' AND role='PRIMARY_ADMIN'"), ['account-a']);
  });

  it('returns no direct recipient when there is no primary record', async () => {
    const admins = new AdminRepository({ query: vi.fn(async () => ({ rows: [] })) } as never);
    await expect(admins.getPrimaryAdministrator('account-a')).resolves.toBeNull();
  });

  it('guards a confirmation write in one statement against the current MID and binding version', async () => {
    const query = vi.fn(async () => ({ rowCount: 0, rows: [] }));
    const admins = new AdminRepository({ query } as never);
    await expect(admins.confirmPrimaryAdministratorFriendship('account-a', 'user-a', 7)).resolves.toBe(false);
    const [sql, parameters] = query.mock.calls[0]!;
    expect(sql).toContain('INSERT INTO primary_administrator_friend_confirmations');
    expect(sql).toContain('WHERE EXISTS');
    expect(sql).toContain('administrator.user_id=$2');
    expect(sql).toContain('version_row.version=$3');
    expect(sql).toContain('ON CONFLICT (account_id) DO UPDATE');
    expect(parameters).toEqual(['account-a', 'user-a', 7]);
  });
});

database('primary administrator identity', () => {
  let pool: Pool; let close: () => Promise<void>; let admins: AdminRepository;
  beforeAll(async () => {
    ({ pool, close } = await createTestDatabase());
    await new AccountRepository(pool).ensureAccount('account-a');
    admins = new AdminRepository(pool);
  });
  afterAll(async () => { await close?.(); });

  it('binds only one primary administrator by immutable chat and sender IDs', async () => {
    expect(await admins.hasPrimary('account-a')).toBe(false);
    expect(await admins.bindPrimary('account-a', 'direct-chat-a', 'user-a')).toBe(true);
    expect(await admins.bindPrimary('account-a', 'direct-chat-b', 'user-b')).toBe(false);
    expect(await admins.hasPrimary('account-a')).toBe(true);
    expect(await admins.isPrimaryAdministrator('account-a', 'direct-chat-a', 'user-a')).toBe(true);
    expect(await admins.isPrimaryAdministrator('account-a', 'direct-chat-a', 'user-b')).toBe(false);
    expect(await admins.isPrimaryAdministrator('account-a', 'direct-chat-b', 'user-a')).toBe(false);
    expect(await admins.getPrimaryAdministrator('account-a')).toEqual({ chatId: 'direct-chat-a', userId: 'user-a' });
    expect(await admins.getPrimaryAdministrator('missing-account')).toBeNull();
    const stored = await pool.query('SELECT chat_type,chat_id,user_id,role FROM account_administrators WHERE account_id=$1', ['account-a']);
    expect(stored.rows).toEqual([{ chat_type: 'direct', chat_id: 'direct-chat-a', user_id: 'user-a', role: 'PRIMARY_ADMIN' }]);
  });

  it('stores confirmation only for the current administrator and version', async () => {
    await new AccountRepository(pool).ensureAccount('account-confirmation');
    expect(await admins.bindPrimary('account-confirmation', 'direct-a', 'user-a')).toBe(true);
    const version = await admins.getPrimaryAdministratorVersion('account-confirmation');
    expect(version).toBe(1);
    expect(await admins.confirmPrimaryAdministratorFriendship('account-confirmation', 'user-a', version!)).toBe(true);
    expect(await admins.hasPrimaryAdministratorFriendConfirmation('account-confirmation', 'user-a', version!)).toBe(true);

    await pool.query('DELETE FROM account_administrators WHERE account_id=$1', ['account-confirmation']);
    expect(await admins.bindPrimary('account-confirmation', 'direct-b', 'user-b')).toBe(true);
    expect(await admins.confirmPrimaryAdministratorFriendship('account-confirmation', 'user-a', version!)).toBe(false);
    expect(await admins.hasPrimaryAdministratorFriendConfirmation('account-confirmation', 'user-a', version!)).toBe(false);
    const currentVersion = await admins.getPrimaryAdministratorVersion('account-confirmation');
    expect(await admins.hasPrimaryAdministratorFriendConfirmation('account-confirmation', 'user-b', currentVersion!)).toBe(false);
  });
});
