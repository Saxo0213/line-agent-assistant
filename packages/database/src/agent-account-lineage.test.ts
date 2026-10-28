import { cp, mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Pool } from 'pg';
import { AccountRepository } from './account-repository.js';
import { AgentRepository } from './agent-repository.js';
import { ensureLineageSessionRow, mergeLineageConversations, resolveAgentLineage } from './agent-lineage.js';
import { queryAgentRoomHistory } from './agent-room-history.js';
import { AgentPermissionRepository } from './agent-permissions.js';
import { MessageRepository } from './message-repository.js';
import { migrate } from './migrate.js';
import { createTestDatabase } from './test-database.js';

const database = process.env.TEST_DATABASE_URL ? describe : describe.skip;
const migrationsDirectory = fileURLToPath(new URL('../migrations/', import.meta.url));
const mid = (letter: string) => `u${letter.repeat(32)}`;
const ADMIN_MID = mid('d');
const WORKSPACE = 'C:\\work';

async function login(accounts: AccountRepository, accountId: string, ownMid: string): Promise<void> {
  const epoch = (await accounts.getControlState()).controlEpoch;
  await accounts.activateControl(accountId, epoch);
  await accounts.bindWorker({ accountId, workerInstanceId: `w-${accountId}`, controlEpoch: epoch });
  expect(await accounts.applyWorkerLogin({ accountId, workerInstanceId: `w-${accountId}`, controlEpoch: epoch }, ownMid, 'Agent')).toBe(true);
}
async function retire(accounts: AccountRepository, oldId: string): Promise<string> {
  const epoch = (await accounts.getControlState()).controlEpoch;
  await accounts.revokeControl(epoch);
  await accounts.clearStoppedWorkerBinding({ accountId: oldId, workerInstanceId: `w-${oldId}`, controlEpoch: epoch });
  await accounts.setConnectionStatus(oldId, 'disconnected');
  const stopped = await accounts.getControlState();
  const replaced = await accounts.replaceAgentAccount(oldId, stopped.controlEpoch);
  if (!replaced.ok) throw new Error(`replace failed: ${replaced.code}`);
  return replaced.account.accountId;
}

database('Agent account lineage', () => {
  let pool: Pool;
  let close: () => Promise<void>;
  let accounts: AccountRepository;
  let messages: MessageRepository;
  let agents: AgentRepository;
  let first = '';
  let second = '';
  let third = '';
  const legacy = 'legacy-account';
  let tempDirectory = '';
  const addMessage = async (accountId: string, chatId: string, messageId: string, text: string, at: string, chatType = 'group') => {
    await pool.query('INSERT INTO conversations(account_id,chat_type,chat_id,title) VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING',
      [accountId, chatType, chatId, `title-${accountId}`]);
    await pool.query(`INSERT INTO messages(account_id,message_id,event_id,chat_type,chat_id,sender_id,kind,text_content,ingestion_source,occurred_at,raw)
      VALUES ($1,$2,$3,$4,$5,'friend-mid','text',$6,'history',$7,'{}')`,
    [accountId, messageId, `ev-${accountId}-${messageId}`, chatType, chatId, text, at]);
  };

  beforeAll(async () => {
    ({ pool, close } = await createTestDatabase());
    accounts = new AccountRepository(pool);
    messages = new MessageRepository(pool);
    agents = new AgentRepository(pool);
    // An unclassified legacy account: no role history, never an Agent.
    first = (await accounts.reserveAccountSlot()).accountId;
    await pool.query('INSERT INTO line_accounts(account_id,own_mid) VALUES ($1,$2)', [legacy, mid('9')]);
    await login(accounts, first, mid('a'));
    // Admin binding so the room shares the admin-direct chat across swaps.
    await pool.query("INSERT INTO account_administrators(account_id,chat_type,chat_id,user_id,role) VALUES ($1,'direct',$2,$2,'PRIMARY_ADMIN')", [first, ADMIN_MID]);
    second = await retire(accounts, first);
    await login(accounts, second, mid('b'));
    third = await retire(accounts, second);
    await login(accounts, third, mid('c'));
    tempDirectory = await mkdtemp(join(tmpdir(), 'lineage-migrations-'));
  });
  afterAll(async () => {
    await close?.();
    if (tempDirectory) await rm(tempDirectory, { recursive: true, force: true });
  });

  it('writes lineage rows in replacement order and resolves current first, then newest retired first', async () => {
    const rows = (await pool.query<{ account_id: string; sequence: number; retired_at: Date | null }>(
      'SELECT account_id,sequence,retired_at FROM agent_account_lineage ORDER BY sequence')).rows;
    expect(rows.map((row) => [row.account_id, row.sequence, row.retired_at === null])).toEqual([
      [first, 1, false], [second, 2, false], [third, 3, true]]);
    expect(await resolveAgentLineage(pool)).toEqual({ currentAccountId: third, accountIds: [third, second, first] });
  });

  it('backfills a database that already holds retired Agents and ignores unclassified accounts', async () => {
    const before = (await pool.query<{ became_agent_at: Date }>('SELECT became_agent_at FROM agent_account_lineage ORDER BY sequence')).rows;
    await pool.query('DROP TABLE agent_account_lineage');
    await pool.query("DELETE FROM schema_migrations WHERE name = '071_agent_account_lineage.sql'");
    await migrate(pool);
    const after = (await pool.query<{ account_id: string; sequence: number; retired_at: Date | null; became_agent_at: Date }>(
      'SELECT account_id,sequence,became_agent_at,retired_at FROM agent_account_lineage ORDER BY sequence')).rows;
    expect(after.map((row) => [row.account_id, row.sequence, row.retired_at === null])).toEqual([[first, 1, false], [second, 2, false], [third, 3, true]]);
    expect(after.some((row) => row.account_id === legacy)).toBe(false);
    expect(after.every((row) => row.retired_at === null || row.retired_at >= row.became_agent_at)).toBe(true);
    expect(before).toHaveLength(3);
    expect(await resolveAgentLineage(pool)).toEqual({ currentAccountId: third, accountIds: [third, second, first] });
  });

  it('applies migration 071 on a database migrated only before it and on a fresh database', async () => {
    const files = (await readdir(migrationsDirectory)).filter((name) => /^\d+_.*\.sql$/.test(name) && name < '071');
    for (const name of files) await cp(join(migrationsDirectory, name), join(tempDirectory, name));
    const old = await createTestDatabase(tempDirectory);
    try {
      await old.pool.query("INSERT INTO line_accounts(account_id,own_mid,product_role,role_revision) VALUES ('cur',$1,'AGENT',0)", [mid('1')]);
      await old.pool.query(`INSERT INTO line_accounts(account_id,own_mid,role_revision,mode,status,connection_mode,created_at)
        VALUES ('former',$1,1,'MONITOR_ONLY','disconnected','OFFLINE', now() - interval '2 days')`, [mid('2')]);
      await old.pool.query('INSERT INTO line_accounts(account_id,own_mid) VALUES ($1,$2)', ['plain', mid('3')]);
      await migrate(old.pool);
      expect(await resolveAgentLineage(old.pool)).toEqual({ currentAccountId: 'cur', accountIds: ['cur', 'former'] });
    } finally { await old.close(); }
    const fresh = await createTestDatabase();
    try { expect(await resolveAgentLineage(fresh.pool)).toEqual({ currentAccountId: null, accountIds: [] }); } finally { await fresh.close(); }
  });

  it('searches the whole lineage with scope agent and one account with scope account', async () => {
    await addMessage(first, 'g1', 'm-first', 'hello from first', '2026-10-01T00:00:00Z');
    await addMessage(second, 'g1', 'm-second', 'hello from second', '2026-10-02T00:00:00Z');
    await addMessage(third, 'g1', 'm-third', 'hello from third', '2026-10-03T00:00:00Z');
    await addMessage(legacy, 'g1', 'm-legacy', 'hello from legacy', '2026-10-04T00:00:00Z');
    const agent = await messages.searchMessages({ text: 'hello', scope: { kind: 'agent' }, limit: 50 });
    expect(agent.map((row) => row.messageId)).toEqual(['m-third', 'm-second', 'm-first']);
    expect(agent.every((row) => row.lineage === 'agent')).toBe(true);
    const one = await messages.searchMessages({ text: 'hello', scope: { kind: 'account', accountId: second }, limit: 50 });
    expect(one.map((row) => row.messageId)).toEqual(['m-second']);
    const all = await messages.searchMessages({ text: 'hello', scope: { kind: 'all' }, limit: 50 });
    expect(all.map((row) => [row.messageId, row.lineage ?? null])).toEqual([['m-legacy', null], ['m-third', 'agent'], ['m-second', 'agent'], ['m-first', 'agent']]);
    const byAccount = await messages.searchMessages({ text: 'hello', accountId: legacy, limit: 50 });
    expect(byAccount.map((row) => row.messageId)).toEqual(['m-legacy']);
  });

  it('merges MCP reads across the lineage, dedupes message ids and leaves send targets current-only', async () => {
    await addMessage(first, 'g2', 'dup-1', 'shared old copy', '2026-10-05T00:00:00Z');
    await addMessage(third, 'g2', 'dup-1', 'shared current copy', '2026-10-05T00:00:00Z');
    await addMessage(second, 'g2', 'only-old', 'old only', '2026-10-06T00:00:00Z');
    await addMessage(third, 'g2', 'only-new', 'new only', '2026-10-07T00:00:00Z');
    await addMessage(first, 'g-old-only', 'oo-1', 'old chat', '2026-10-08T00:00:00Z');
    const rows = await messages.queryTargetMessages({ accountIds: [third], chatType: 'group', chatId: 'g2' });
    expect(rows.map((row) => [row.messageId, row.accountId, row.text])).toEqual([
      ['only-new', third, 'new only'], ['only-old', second, 'old only'], ['dup-1', third, 'shared current copy']]);
    const limited = await messages.queryTargetMessages({ accountIds: [third], chatType: 'group', chatId: 'g2', limit: 2 });
    expect(limited.map((row) => row.messageId)).toEqual(['only-new', 'only-old']);
    const scoped = await messages.queryTargetMessages({ accountIds: [third], conversationScope: { accountId: third, chatType: 'group', chatId: 'g2' } });
    expect(scoped).toHaveLength(3);
    const outsideScope = await messages.queryTargetMessages({
      accountIds: [third], conversationScope: { accountId: third, chatType: 'group', chatId: 'g2' }, chatId: 'g-old-only' });
    expect(outsideScope).toHaveLength(0);
    const timed = await messages.queryTargetMessages({ accountIds: [third], chatId: 'g2', from: '2026-10-06T00:00:00Z', to: '2026-10-07T00:00:00Z' });
    expect(timed.map((row) => row.messageId)).toEqual(['only-new', 'only-old']);

    const targets = await messages.listConversationTargets({ accountIds: [third], chatType: 'group' });
    const g2 = targets.filter((target) => target.chatId === 'g2');
    expect(g2).toHaveLength(1);
    expect(g2[0]).toMatchObject({ accountId: third, conversationTitle: `title-${third}` });
    expect(targets.find((target) => target.chatId === 'g-old-only')).toMatchObject({ accountId: first });
    expect(targets.filter((target) => target.chatId === 'g1')).toHaveLength(1);
    expect(targets.find((target) => target.chatId === 'g1')).toMatchObject({ accountId: third });
    const sendIds = (await messages.listSendTargets({ accountId: third })).map((target) => target.chatId);
    expect(sendIds).toEqual(expect.arrayContaining(['g1', 'g2']));
    expect(sendIds).not.toContain('g-old-only');
    expect(await messages.getSendTarget(third, 'group', 'g-old-only')).toBeNull();
    // A non-lineage account is read alone.
    expect((await messages.queryTargetMessages({ accountIds: [legacy], chatId: 'g1' })).map((row) => row.messageId)).toEqual(['m-legacy']);
  });

  it('merges conversation lists with the current account winning', () => {
    const merged = mergeLineageConversations([
      { accountId: 'old', chatType: 'group', chatId: 'g', title: 'old title' },
      { accountId: 'new', chatType: 'group', chatId: 'g', title: 'new title' },
      { accountId: 'old', chatType: 'direct', chatId: 'g', title: 'direct' },
    ], ['new', 'old']);
    expect(merged.map((item) => [item.accountId, item.chatType, item.title])).toEqual([['new', 'group', 'new title'], ['old', 'direct', 'direct']]);
  });

  it('inherits the predecessor provider session for the same chat only, without touching the old row', async () => {
    for (const [accountId, chatId] of [[first, 'gs'], [second, 'gs'], [third, 'gs'], [first, 'gt'], [third, 'gt'], [second, 'gt']] as const) {
      await pool.query("INSERT INTO conversations(account_id,chat_type,chat_id,title) VALUES ($1,'group',$2,'S') ON CONFLICT DO NOTHING", [accountId, chatId]);
    }
    const bind = (accountId: string, chatId: string, externalSessionId: string, generation = 0) => agents.bindSession({
      accountId, chatType: 'group', chatId, provider: 'codex', sourceType: 'line', externalSessionId, generation, workspacePath: WORKSPACE });
    await bind(first, 'gs', 'ext-first');
    await bind(second, 'gs', 'ext-second');
    await bind(first, 'gt', 'ext-gt-first');

    const key = { accountId: third, chatType: 'group' as const, chatId: 'gs', provider: 'codex' as const, workspacePath: WORKSPACE };
    expect(await agents.lookupSession(key)).toBeNull();
    await ensureLineageSessionRow(pool, { ...key, sourceType: 'line' });
    expect(await agents.lookupSession(key)).toMatchObject({ externalSessionId: 'ext-second' });
    // The older predecessor is used when the newer one never had this chat.
    await ensureLineageSessionRow(pool, { accountId: third, chatType: 'group', chatId: 'gt', provider: 'codex' });
    expect(await agents.lookupSession({ ...key, chatId: 'gt' })).toMatchObject({ externalSessionId: 'ext-gt-first' });
    // A different provider or a chat without a predecessor row does not inherit.
    await ensureLineageSessionRow(pool, { accountId: third, chatType: 'group', chatId: 'gs', provider: 'claude' });
    expect(await agents.lookupSession({ ...key, provider: 'claude' })).toBeNull();
    // Old rows are unchanged and still belong to their accounts.
    const rows = (await pool.query("SELECT account_id,external_session_id FROM agent_sessions WHERE chat_id='gs' AND provider='codex'")).rows;
    expect(rows.find((row) => row.account_id === first)?.external_session_id).toBe('ext-first');
    expect(rows.find((row) => row.account_id === second)?.external_session_id).toBe('ext-second');
    // An existing row is never overwritten; a retired account does not inherit from older accounts.
    const generation = (await pool.query("SELECT generation FROM agent_sessions WHERE account_id=$1 AND chat_id='gs' AND provider='codex'", [third])).rows[0].generation as number;
    await bind(third, 'gs', 'ext-third', generation);
    await ensureLineageSessionRow(pool, { ...key, sourceType: 'line' });
    expect(await agents.lookupSession(key)).toMatchObject({ externalSessionId: 'ext-third' });
    await ensureLineageSessionRow(pool, { accountId: second, chatType: 'group', chatId: 'gt', provider: 'codex' });
    expect(await agents.lookupSession({ ...key, accountId: second, chatId: 'gt' })).toBeNull();
  });

  it('continues the shared Agent room session and history after a swap', async () => {
    await pool.query("UPDATE line_accounts SET mode='ACTIVE_CONTROL' WHERE account_id=$1", [third]);
    for (const accountId of [second, third]) {
      await pool.query("INSERT INTO conversations(account_id,chat_type,chat_id,title,agent_enabled) VALUES ($1,'direct',$2,'Admin',true) ON CONFLICT DO NOTHING", [accountId, ADMIN_MID]);
    }
    await agents.bindSession({ accountId: second, chatType: 'direct', chatId: ADMIN_MID, provider: 'codex', sourceType: 'line',
      externalSessionId: 'room-memory', generation: 0, workspacePath: WORKSPACE });
    const queued = await agents.enqueueUiJob({ provider: 'codex', requestId: 'lineage-room', prompt: 'continue', workspacePath: WORKSPACE });
    const claimed = (await agents.claimNext({ accountId: null, chatType: null, chatId: null } as never))!;
    expect(claimed.jobId).toBe(queued.jobId);
    expect(claimed.sessionKey).toMatchObject({ accountId: third, chatType: 'direct', chatId: ADMIN_MID, provider: 'codex', sourceType: 'line' });
    expect(await agents.lookupSession({ ...claimed.sessionKey!, workspacePath: WORKSPACE } as never)).toMatchObject({ externalSessionId: 'room-memory' });
    await pool.query("UPDATE agent_jobs SET status='cancelled' WHERE status IN ('queued','running')");

    await pool.query(`INSERT INTO messages(account_id,message_id,event_id,chat_type,chat_id,sender_id,kind,text_content,ingestion_source,occurred_at,raw)
      VALUES ($1,'room-old','room-old-ev','direct',$2,$2,'text','old admin ask','history',now(),'{}')`, [second, ADMIN_MID]);
    await pool.query(`INSERT INTO agent_jobs(job_id,account_id,chat_type,chat_id,provider,source_type,source_message_id,prompt,workspace_path,generation,status,creation_epoch)
      VALUES (gen_random_uuid(),$1,'direct',$2,'codex','line','room-old','old admin ask',$3,1,'completed',0)`, [second, ADMIN_MID, WORKSPACE]);
    const page = await queryAgentRoomHistory(pool, { limit: 20 }, { accountId: third, adminMid: ADMIN_MID });
    expect(page.items.map((item) => item.prompt)).toEqual(expect.arrayContaining(['old admin ask', 'continue']));
  });

  it('reuses the predecessor chat folder for the current Agent only', async () => {
    const permissions = new AgentPermissionRepository(pool);
    const oldFolder = await permissions.ensureChatFolder(second, 'group', 'gs', 'test');
    const current = await permissions.ensureChatFolder(third, 'group', 'gs', 'test');
    expect(current.folderId).toBe(oldFolder.folderId);
    expect((await pool.query("SELECT count(*) FROM chat_folders WHERE chat_id='gs' AND account_id=$1", [third])).rows[0].count).toBe('0');
    expect((await permissions.getChatFolderForConversation(third, 'group', 'gs'))?.folderId).toBe(oldFolder.folderId);
    // A retired account never resolves through the lineage, and a chat without a predecessor folder gets its own.
    expect(await permissions.getChatFolderForConversation(first, 'group', 'gs')).toBeNull();
    const fresh = await permissions.ensureChatFolder(third, 'group', 'g2', 'test');
    expect(fresh.accountId).toBe(third);
  });

  it('keeps retired accounts unable to send', async () => {
    expect(await accounts.resolveCapabilities(first)).toMatchObject({ productRole: null, canWriteLine: false });
    expect(await accounts.resolveCapabilities(second)).toMatchObject({ productRole: null, canWriteLine: false });
    expect(await messages.findAgentSendAccount()).not.toBe(first);
  });
});
