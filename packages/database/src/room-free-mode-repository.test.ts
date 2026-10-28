import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Pool } from 'pg';
import { createTestDatabase } from './test-database.js';
import { AccountRepository } from './account-repository.js';
import { AdminRepository } from './admin-repository.js';
import { MessageRepository } from './message-repository.js';
import { AgentRepository } from './agent-repository.js';
import { FREE_MODE_MEMBER_ID, resolveJobPolicy } from './agent-permissions.js';
import { RoomFreeModeRepository, type FreeModeKey } from './room-free-mode-repository.js';

const database = process.env.TEST_DATABASE_URL ? describe : describe.skip;
const ACCOUNT = 'acc';
const KEY: FreeModeKey = { accountId: ACCOUNT, chatType: 'group', chatId: 'g1' };

database('Group free mode repository (real database)', () => {
  let pool: Pool;
  let close: () => Promise<void>;
  let repo: RoomFreeModeRepository;
  let agents: AgentRepository;
  let grant: { grantId: string; version: number };
  const messageIds: string[] = [];

  beforeAll(async () => {
    ({ pool, close } = await createTestDatabase());
    repo = new RoomFreeModeRepository(pool);
    agents = new AgentRepository(pool);
    const accounts = new AccountRepository(pool);
    await accounts.ensureAccount(ACCOUNT);
    await accounts.setOwnMid(ACCOUNT, 'mid-bot');
    await pool.query("UPDATE line_accounts SET display_name = 'Agent LINE', mode = 'ACTIVE_CONTROL', product_role = 'AGENT' WHERE account_id = $1", [ACCOUNT]);
    await new AdminRepository(pool).bindPrimary(ACCOUNT, 'admin-direct', 'mid-admin');
    await new MessageRepository(pool).upsertConversationCatalog(ACCOUNT, [
      { chatType: 'group', chatId: 'g1', title: 'Group One', members: [{ memberId: 'user-a', displayName: 'Alice LINE', nickname: 'Alice' }] },
      { chatType: 'direct', chatId: 'admin-direct', title: 'Admin', members: [{ memberId: 'mid-admin', displayName: 'Boss' }] },
    ]);
    for (const sender of ['mid-admin', 'mid-admin', 'user-a']) {
      const id = `m-${randomUUID()}`;
      messageIds.push(id);
      await pool.query(
        `INSERT INTO messages (account_id, message_id, event_id, chat_id, chat_type, sender_id, kind, text_content, ingestion_source, occurred_at, raw)
         VALUES ($1, $2, $3, 'g1', 'group', $4, 'text', 'hi', 'live', now(), '{}'::jsonb)`, [ACCOUNT, id, `ev-${id}`, sender]);
    }
    const requestId = randomUUID();
    await pool.query(
      `INSERT INTO room_activation_requests(request_id, account_id, chat_type, chat_id, source_message_id, requester_id,
         admin_chat_id, admin_user_id, admin_version, room_authority_version, state, wait_expires_at)
       VALUES ($1,$2,'group','g1',$3,'member','admin-direct','mid-admin',1,1,'CONSUMED',clock_timestamp())`, [requestId, ACCOUNT, randomUUID()]);
    await pool.query("INSERT INTO room_agent_policies(account_id, chat_type, chat_id, state, authority_version) VALUES ($1,'group','g1','ENABLED',1)", [ACCOUNT]);
    const grantId = randomUUID();
    await pool.query(
      `INSERT INTO room_agent_grants(grant_id, account_id, chat_type, chat_id, capability, version, state, request_id)
       VALUES ($1,$2,'group','g1','AGENT_USE_ROOM',1,'ACTIVE',$3)`, [grantId, ACCOUNT, requestId]);
    grant = { grantId, version: 1 };
  });
  afterAll(async () => { await close(); });

  it('creates the table and the job flag (migration 073)', async () => {
    const table = await pool.query("SELECT 1 FROM information_schema.tables WHERE table_name = 'room_free_mode' AND table_schema = current_schema()");
    const column = await pool.query("SELECT 1 FROM information_schema.columns WHERE table_name = 'agent_jobs' AND column_name = 'free_mode' AND table_schema = current_schema()");
    expect([table.rowCount, column.rowCount]).toEqual([1, 1]);
  });

  it('activates, resets, lists, expires only the matching window and deactivates', async () => {
    const first = new Date(Date.now() + 5 * 60_000);
    const row = await repo.activate(KEY, 'mid-admin', first);
    expect(row).toMatchObject({ ...KEY, enabledBy: 'mid-admin' });
    const reset = new Date(Date.now() + 30 * 60_000);
    await repo.activate(KEY, 'mid-admin', reset);
    expect((await repo.get(KEY))?.expiresAt.getTime()).toBe(reset.getTime());
    expect(await repo.list()).toHaveLength(1);
    expect(await repo.expire(KEY, first)).toBe(false);
    expect(await repo.expire(KEY, reset)).toBe(true);
    expect(await repo.get(KEY)).toBeNull();
    await repo.activate(KEY, 'mid-admin', reset);
    expect(await repo.deactivate(KEY)).toBe(true);
    expect(await repo.deactivate(KEY)).toBe(false);
  });

  it('resolves member display names', async () => {
    expect((await repo.memberNames(KEY, ['user-a', 'nobody'])).get('user-a')).toBe('Alice');
  });

  it('runs a free-mode job as the room member even when its source message is the administrator\'s, and honors [[NO_REPLY]]', async () => {
    const input = { key: KEY, provider: 'claude' as const, prompt: 'batch', workspacePath: 'C:\w', roomGrant: grant };
    const job = await repo.enqueueJob({ ...input, sourceMessageId: messageIds[0]! });
    expect(job).not.toBeNull();
    expect(await repo.enqueueJob({ ...input, sourceMessageId: messageIds[0]! })).toBeNull(); // one job per source message
    expect(await repo.isFreeModeJob(job!.jobId)).toBe(true);
    expect(await repo.isJobActive(job!.jobId)).toBe(true);
    const policy = (await resolveJobPolicy(pool, job!.jobId))!;
    expect(policy.principal).toEqual({ kind: 'user', senderMid: FREE_MODE_MEMBER_ID });
    const epoch = Number((await pool.query<{ control_epoch: string }>('SELECT control_epoch FROM account_control')).rows[0]!.control_epoch);
    const claimed = await agents.claimNext(KEY);
    expect(claimed?.jobId).toBe(job!.jobId);
    await agents.completeJob(job!.jobId, ' [[NO_REPLY]]\n', ['[[NO_REPLY]]'], epoch);
    expect((await pool.query('SELECT 1 FROM agent_deliveries WHERE job_id = $1', [job!.jobId])).rowCount).toBe(0);
    expect((await pool.query('SELECT status FROM agent_jobs WHERE job_id = $1', [job!.jobId])).rows[0]!.status).toBe('completed');

    const second = await repo.enqueueJob({ ...input, sourceMessageId: messageIds[1]! });
    await agents.claimNext(KEY);
    await agents.completeJob(second!.jobId, '好的', ['好的'], epoch);
    expect((await pool.query('SELECT 1 FROM agent_deliveries WHERE job_id = $1', [second!.jobId])).rowCount).toBe(1);
  });

  it('refuses a stale room grant', async () => {
    await pool.query("UPDATE room_agent_policies SET authority_version = 2 WHERE account_id = $1 AND chat_id = 'g1'", [ACCOUNT]);
    expect(await repo.enqueueJob({ key: KEY, sourceMessageId: messageIds[2]!, provider: 'claude', prompt: 'x', workspacePath: 'C:\w', roomGrant: grant })).toBeNull();
  });
});
