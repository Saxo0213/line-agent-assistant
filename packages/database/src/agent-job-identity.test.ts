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

  it('lists mentionable group members with history names and excludes the Agent itself', async () => {
    const mid = (n: number) => `u${String(n).repeat(32)}`;
    await pool.query("UPDATE line_accounts SET own_mid = $1 WHERE account_id = 'acc-agent'", [mid(9)]);
    for (const [member, name] of [[mid(1), '小明（成員）'], [mid(2), '小華'], [mid(3), null], [mid(9), 'Agentsaxo']] as const) {
      await pool.query("INSERT INTO conversation_members (account_id, chat_type, chat_id, member_id, display_name) VALUES ('acc-agent','group','g-team',$1,$2)", [member, name]);
    }
    await pool.query("INSERT INTO line_contacts (account_id, mid, display_name, nickname) VALUES ('acc-agent',$1,'Xiao Hua','華華')", [mid(2)]);
    const candidates = await agents.listMentionCandidates('acc-agent', 'group', 'g-team');
    expect(candidates.selfMid).toBe(mid(9));
    expect([...candidates.members].sort((a, b) => a.mid.localeCompare(b.mid))).toEqual([
      { mid: mid(1), name: '小明（成員）' }, { mid: mid(2), name: '華華' }, { mid: mid(9), name: 'Agentsaxo' }]);
    expect(await agents.listMentionCandidates('acc-agent', 'group', 'g-other')).toEqual({ members: [], selfMid: mid(9) });
    expect(await agents.listMentionCandidates('acc-missing', 'group', 'g-team')).toEqual({ members: [], selfMid: null });
  });

  it('names the asker of a group job like the history does', async () => {
    const mid = `u${'1'.repeat(32)}`;
    await pool.query("INSERT INTO messages (account_id, message_id, event_id, chat_id, chat_type, sender_id, kind, text_content, ingestion_source, occurred_at, raw) VALUES ('acc-agent','ask-1','ev-ask-1','g-team','group',$1,'text','q','live',now(),'{}'::jsonb)", [mid]);
    const jobId = '11111111-1111-4111-8111-111111111111';
    await pool.query(`INSERT INTO agent_jobs (job_id, account_id, chat_type, chat_id, provider, source_type, source_message_id, source_sender_id, prompt, workspace_path, generation, creation_epoch, status)
      VALUES ($1,'acc-agent','group','g-team','claude','line','ask-1',$2,'p','C:\workspace',1,1,'running')`, [jobId, mid]);
    const identity = await agents.describeJobIdentity({ sourceType: 'line', accountId: 'acc-agent', chatType: 'group', chatId: 'g-team', jobId });
    expect(identity.current).toMatchObject({ askerName: '小明（成員）' });
    expect((await agents.describeJobIdentity({ sourceType: 'line', accountId: 'acc-agent', chatType: 'group', chatId: 'g-team' })).current).not.toHaveProperty('askerName');
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
