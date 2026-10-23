import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { LOCAL_AGENT_ROOM_CHAT_ID } from '@line-agent/contracts';
import { AccountRepository } from './account-repository.js';
import { createTestDatabase, type TestDatabase } from './test-database.js';

const database = process.env.TEST_DATABASE_URL ? describe : describe.skip;

database('local Agent room invariant', () => {
  let db: TestDatabase;
  beforeAll(async () => { db = await createTestDatabase(); });
  afterAll(async () => { await db?.close(); });

  it('creates the reserved local-only conversation with every account', async () => {
    await new AccountRepository(db.pool).ensureAccount('account-a', 'Account A');
    const result = await db.pool.query<{ title: string; agent_enabled: boolean }>(
      `SELECT title, agent_enabled FROM conversations
       WHERE account_id=$1 AND chat_type='direct' AND chat_id=$2`,
      ['account-a', LOCAL_AGENT_ROOM_CHAT_ID],
    );
    expect(result.rows).toEqual([{ title: 'Agent 室', agent_enabled: true }]);
  });
});
