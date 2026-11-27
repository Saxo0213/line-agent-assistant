import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Pool } from 'pg';
import { AgentRepository } from './agent-repository.js';
import { AccountRepository } from './account-repository.js';
import { createTestDatabase } from './test-database.js';

const database = process.env.TEST_DATABASE_URL ? describe : describe.skip;

database('AgentRepository.listExternalSessionIds (real database)', () => {
  let pool: Pool;
  let close: () => Promise<void>;
  let agents: AgentRepository;

  beforeAll(async () => {
    ({ pool, close } = await createTestDatabase());
    agents = new AgentRepository(pool);
    await new AccountRepository(pool).ensureAccount('account-L');
    for (const chatId of ['c1', 'c2']) {
      await pool.query("INSERT INTO conversations (account_id, chat_type, chat_id) VALUES ('account-L', 'direct', $1) ON CONFLICT DO NOTHING", [chatId]);
    }
  });
  afterAll(async () => { await close?.(); });

  it('lists each non-null provider session ID once and changes nothing', async () => {
    await pool.query("INSERT INTO agent_sessions (provider, source_type, external_session_id) VALUES ('claude','ui','ext-ui')");
    await pool.query("INSERT INTO agent_sessions (provider, source_type, external_session_id, account_id, chat_type, chat_id) VALUES ('codex','line','ext-line','account-L','direct','c1'), ('claude','line',NULL,'account-L','direct','c2')");
    const before = (await pool.query('SELECT count(*)::int AS n, max(updated_at) AS u FROM agent_sessions')).rows[0];
    expect((await agents.listExternalSessionIds()).sort()).toEqual(['ext-line', 'ext-ui']);
    expect((await pool.query('SELECT count(*)::int AS n, max(updated_at) AS u FROM agent_sessions')).rows[0]).toEqual(before);
  });
});
