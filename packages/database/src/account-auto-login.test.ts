import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Pool } from 'pg';
import { AccountRepository } from './account-repository.js';
import { createTestDatabase } from './test-database.js';

const database = process.env.TEST_DATABASE_URL ? describe : describe.skip;

database('startup auto-login opt-in column', () => {
  let pool: Pool;
  let close: () => Promise<void>;
  let accounts: AccountRepository;
  beforeAll(async () => {
    ({ pool, close } = await createTestDatabase());
    accounts = new AccountRepository(pool);
  });
  afterAll(async () => { await close?.(); });

  it('defaults to false and persists the setter', async () => {
    await pool.query("INSERT INTO line_accounts(account_id,display_name,own_mid,product_role) VALUES ('auto-a','A','mid-a','AGENT')");
    expect(await accounts.listAuthenticatedAccounts()).toMatchObject([{ accountId: 'auto-a', autoLoginOnStartup: false }]);
    await accounts.setAutoLoginOnStartup('auto-a', true);
    expect((await accounts.listAuthenticatedAccounts())[0]?.autoLoginOnStartup).toBe(true);
    await accounts.setAutoLoginOnStartup('auto-a', false);
    expect((await accounts.listAuthenticatedAccounts())[0]?.autoLoginOnStartup).toBe(false);
  });

  it('rejects unknown accounts', async () => {
    await expect(accounts.setAutoLoginOnStartup('missing', true)).rejects.toThrow('Unknown LINE account');
  });
});
