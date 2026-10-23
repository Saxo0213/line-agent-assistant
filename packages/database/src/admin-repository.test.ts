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
});
