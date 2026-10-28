import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Pool } from 'pg';
import { AccountRepository } from './account-repository.js';
import { AgentRepository } from './agent-repository.js';
import { createTestDatabase } from './test-database.js';

const database = process.env.TEST_DATABASE_URL ? describe : describe.skip;

database('AgentRepository.describeJobIdentity (real database)', () => {
  let pool: Pool;
  let close: () => Promise<void>;
  let agents: AgentRepository;

  beforeAll(async () => {
    ({ pool, close } = await createTestDatabase());
    agents = new AgentRepository(pool);
    await new AccountRepository(pool).ensureAccount('acc-agent');
    await pool.query("UPDATE line_accounts SET product_role = 'AGENT', display_name = 'Agentsaxo', own_mid = 'u-own' WHERE account_id = 'acc-agent'");
    for (const [type, id, title] of [['direct', 'u-admin', '徐佳誠'], ['group', 'g-team', '專案群']] as const) {
      await pool.query('INSERT INTO conversations (account_id, chat_type, chat_id, title) VALUES ($1,$2,$3,$4)', ['acc-agent', type, id, title]);
    }
  });
  afterAll(async () => { await close(); });

  it('reports no administrator before one is bound', async () => {
    expect(await agents.describeJobIdentity({ sourceType: 'ui', accountId: null, chatType: null, chatId: null }))
      .toEqual({ agent: { accountId: 'acc-agent', name: 'Agentsaxo' }, admin: null, current: null });
  });

  it('describes the administrator chat for room jobs and the current chat for LINE jobs', async () => {
    await pool.query("INSERT INTO account_administrators (account_id, chat_type, chat_id, user_id, role) VALUES ('acc-agent','direct','u-admin','u-admin','PRIMARY_ADMIN')");
    const admin = { accountId: 'acc-agent', chatId: 'u-admin', name: '徐佳誠' };
    expect(await agents.describeJobIdentity({ sourceType: 'ui', accountId: null, chatType: null, chatId: null })).toMatchObject({ admin, current: null });
    expect(await agents.describeJobIdentity({ sourceType: 'line', accountId: 'acc-agent', chatType: 'direct', chatId: 'u-admin' }))
      .toMatchObject({ admin, current: { chatId: 'u-admin', title: '徐佳誠', isAdmin: true } });
    expect(await agents.describeJobIdentity({ sourceType: 'line', accountId: 'acc-agent', chatType: 'group', chatId: 'g-team' }))
      .toMatchObject({ admin, current: { chatType: 'group', chatId: 'g-team', title: '專案群', isAdmin: false } });
  });
});
