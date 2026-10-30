import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Pool } from 'pg';
import {
  AGENT_ROOM_HISTORY_PAGE_MAX_BYTES, McpAgentRoomHistoryPageSchema, encodeAgentRoomHistoryCursor,
} from '@line-agent/contracts';
import { AccountRepository } from './account-repository.js';
import { AdminRepository } from './admin-repository.js';
import { FriendWhitelistRepository } from './friend-whitelist-repository.js';
import { AgentRepository, findSharedAdminChat } from './agent-repository.js';
import { queryAgentRoomHistory } from './agent-room-history.js';
import { McpTokenRepository } from './mcp-token-repository.js';
import { createTestDatabase } from './test-database.js';

const database = process.env.TEST_DATABASE_URL ? describe : describe.skip;
const TOOL = 'query_agent_room_history' as const;

database('Agent room history (real database)', () => {
  let pool: Pool;
  let close: () => Promise<void>;
  let tokens: McpTokenRepository;
  const shared = () => findSharedAdminChat(pool);
  const history = async (input: unknown = {}) => queryAgentRoomHistory(pool, input, await shared());
  const ids: Record<string, string> = {};

  const uiJob = async (name: string, at: string, prompt: string, reply: string | null, extra: { provider?: string; status?: string } = {}) => {
    const jobId = randomUUID();
    ids[name] = jobId;
    await pool.query(
      `INSERT INTO agent_jobs (job_id, provider, source_type, source_request_id, prompt, workspace_path, generation, status, created_at, updated_at)
       VALUES ($1,$2,'ui',$3,$4,'C:\\work',0,$5,$6,$6)`,
      [jobId, extra.provider ?? 'codex', `req-${name}`, prompt, extra.status ?? 'completed', at]);
    if (reply !== null) await pool.query('INSERT INTO agent_outputs (job_id, final_text) VALUES ($1,$2)', [jobId, reply]);
    return jobId;
  };
  const lineJob = async (name: string, chatType: 'direct' | 'group', chatId: string, senderId: string, at: string, prompt: string, reply: string | null,
    extra: { status?: string; generation?: number } = {}) => {
    const jobId = randomUUID();
    ids[name] = jobId;
    const messageId = `msg-${name}`;
    await pool.query(
      `INSERT INTO messages (account_id, message_id, event_id, chat_id, chat_type, sender_id, kind, text_content, ingestion_source, occurred_at, raw)
       VALUES ('acc-agent',$1,$2,$3,$4,$5,'text','trigger','live',now(),'{}'::jsonb)`, [messageId, `ev-${name}`, chatId, chatType, senderId]);
    await pool.query(
      `INSERT INTO agent_jobs (job_id, account_id, chat_type, chat_id, provider, source_type, source_message_id, prompt, workspace_path, generation, creation_epoch, status, created_at, updated_at)
       VALUES ($1,'acc-agent',$2,$3,'claude','line',$4,$5,'C:\\work',$6,1,$7,$8,$8)`,
      [jobId, chatType, chatId, messageId, prompt, extra.generation ?? 1, extra.status ?? 'completed', at]);
    if (reply !== null) await pool.query('INSERT INTO agent_outputs (job_id, final_text) VALUES ($1,$2)', [jobId, reply]);
    return jobId;
  };
  const setStatus = (names: string[], status: string) =>
    pool.query('UPDATE agent_jobs SET status = $2 WHERE job_id = ANY($1::uuid[])', [names.map((name) => ids[name]), status]);
  const jobContext = (name: string, generation = 1, accountId: string | null = 'acc-agent') => ({ sourceType: 'job' as const, jobId: ids[name]!, generation, accountId });
  const call = (context: Parameters<McpTokenRepository['executeForInternalAgent']>[0]['context'], input: unknown = {}) =>
    tokens.executeForInternalAgent({ context, toolName: TOOL, execute: async ({ client, sharedAdminChat }) => {
      const page = await queryAgentRoomHistory(client, input, sharedAdminChat ?? null);
      return { data: page, resultCount: page.items.length };
    } });
  const audits = async () => (await tokens.listAuditRecords(500)).filter((row) => row.toolName === TOOL);

  beforeAll(async () => {
    ({ pool, close } = await createTestDatabase());
    tokens = new McpTokenRepository(pool);
    const accounts = new AccountRepository(pool);
    await accounts.ensureAccount('acc-agent');
    await accounts.setOwnMid('acc-agent', 'mid-agent');
    await pool.query("UPDATE line_accounts SET mode = 'ACTIVE_CONTROL', product_role = 'AGENT' WHERE account_id = 'acc-agent'");
    await new AdminRepository(pool).bindPrimary('acc-agent', 'chat-admin', 'mid-admin');
    for (const [type, id] of [['direct', 'chat-admin'], ['group', 'g1'], ['direct', 'chat-friend']] as const) {
      await pool.query('INSERT INTO conversations (account_id, chat_type, chat_id) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING', ['acc-agent', type, id]);
    }
    // Room rows (microsecond created_at; three rows share one instant to exercise the job_id tie-break).
    await uiJob('r1', '2026-10-20T10:00:00.123456Z', 'alpha room 100% sure', 'reply one');
    await uiJob('r2', '2026-10-20T10:00:05.000000Z', 'beta question', 'the answer has under_score', { provider: 'claude' });
    await uiJob('r3', '2026-10-20T10:00:05.000000Z', 'gamma tie', null, { status: 'failed' });
    await uiJob('r4', '2026-10-20T10:00:05.000000Z', 'delta tie', 'back\\slash reply');
    // LINE rows.
    await lineJob('adm1', 'direct', 'chat-admin', 'mid-admin', '2026-10-20T10:00:02.000000Z', 'line hello', 'line reply');
    await lineJob('grp1', 'group', 'g1', 'mid-admin', '2026-10-20T10:00:03.000000Z', 'secret group prompt', 'secret group reply');
    await lineJob('fr1', 'direct', 'chat-friend', 'mid-friend', '2026-10-20T10:00:04.000000Z', 'friend prompt', null);
  });
  afterAll(async () => { await close?.(); });

  it('returns room rows plus the shared admin-direct chat only, newest first, with origin, and parses the strict schema', async () => {
    const page = await history();
    expect(McpAgentRoomHistoryPageSchema.parse(page)).toEqual(page);
    expect(new Set(page.items.map((item) => item.jobId))).toEqual(new Set([ids.r1, ids.r2, ids.r3, ids.r4, ids.adm1]));
    expect(page.items.map((item) => item.createdAt)).toEqual([...page.items.map((item) => item.createdAt)].sort().reverse());
    expect(page.items[page.items.length - 1]).toMatchObject({ jobId: ids.r1, origin: 'agent_room' });
    const line = page.items.find((item) => item.jobId === ids.adm1)!;
    expect(line).toMatchObject({ origin: 'line_admin_direct', provider: 'claude', status: 'completed', prompt: 'line hello', reply: 'line reply', promptTruncated: false, replyTruncated: false });
    expect(page.items.find((item) => item.jobId === ids.r3)).toMatchObject({ reply: null, status: 'failed', replyTruncated: false });
    expect(page.nextCursor).toBeNull();
    const text = JSON.stringify(page);
    expect(text).not.toContain('secret group');
    expect(text).not.toContain('friend prompt');
  });

  it('pages with no gap or duplicate across equal created_at and sub-millisecond timestamps', async () => {
    const full = (await history()).items.map((item) => item.jobId);
    const seen: string[] = [];
    let cursor: string | undefined;
    for (let guard = 0; guard < 20; guard++) {
      const page = await history({ limit: 1, ...(cursor ? { cursor } : {}) });
      seen.push(...page.items.map((item) => item.jobId));
      if (!page.nextCursor) break;
      cursor = page.nextCursor;
    }
    expect(seen).toEqual(full);
    expect(new Set(seen).size).toBe(seen.length);
    const sizeTwo: string[] = [];
    cursor = undefined;
    do {
      const page = await history({ limit: 2, ...(cursor ? { cursor } : {}) });
      sizeTwo.push(...page.items.map((item) => item.jobId));
      cursor = page.nextCursor ?? undefined;
    } while (cursor);
    expect(sizeTwo).toEqual(full);
  });

  it('matches keywords over prompt and reply case-insensitively and treats LIKE wildcards literally', async () => {
    const found = async (input: unknown) => (await history(input)).items.map((item) => item.jobId).sort();
    expect(await found({ query: 'ALPHA' })).toEqual([ids.r1]);
    expect(await found({ query: 'ANSWER has' })).toEqual([ids.r2]);
    expect(await found({ query: 'line reply' })).toEqual([ids.adm1]);
    expect(await found({ query: '100%' })).toEqual([ids.r1]);
    expect(await found({ query: '%' })).toEqual([ids.r1]);
    expect(await found({ query: '_' })).toEqual([ids.r2]);
    expect(await found({ query: 'under_score' })).toEqual([ids.r2]);
    expect(await found({ query: 'under-score' })).toEqual([]);
    expect(await found({ query: '\\' })).toEqual([ids.r4]);
    expect(await found({ query: 'nothing matches this' })).toEqual([]);
  });

  it('filters by provider and an inclusive time window', async () => {
    const found = async (input: unknown) => (await history(input)).items.map((item) => item.jobId).sort();
    expect(await found({ provider: 'claude' })).toEqual([ids.r2, ids.adm1].sort());
    expect(await found({ provider: 'codex' })).toEqual([ids.r1, ids.r3, ids.r4].sort());
    expect(await found({ from: '2026-10-20T10:00:05Z' })).toEqual([ids.r2, ids.r3, ids.r4].sort());
    expect(await found({ to: '2026-10-20T10:00:00.123Z' })).toEqual([ids.r1]);
    expect(await found({ to: '2026-10-20T10:00:00.122Z' })).toEqual([]);
    expect(await found({ from: '2026-10-20T10:00:01Z', to: '2026-10-20T10:00:04Z' })).toEqual([ids.adm1]);
  });

  it('rejects invalid input with INVALID_INPUT', async () => {
    const b64 = (text: string) => Buffer.from(text).toString('base64url');
    const bad = [
      { extra: 1 }, { limit: 0 }, { limit: 51 }, { limit: 1.5 }, { query: '' }, { query: 'x'.repeat(201) }, { provider: 'gemini' },
      { from: '2026-10-21T00:00:00Z', to: '2026-10-20T00:00:00Z' }, { from: 'yesterday' }, { cursor: 'garbage' },
      { cursor: b64('{"t":"2026-10-20T10:00:00.000000Z"}') },
      { cursor: b64('{"t":"2026-10-20T10:00:00.000000Z","i":"not-a-uuid"}') },
      { cursor: b64(`{"t":"2026-13-45T10:00:00.000000Z","i":"${randomUUID()}"}`) },
      { cursor: b64(`{"t":"2026-10-20T10:00:00.000Z","i":"${randomUUID()}"}`) },
      { cursor: b64(`{"t":"2026-10-20T10:00:00.000000Z","i":"${randomUUID()}","x":1}`) },
      { cursor: b64('[1,2]') },
      { cursor: `${encodeAgentRoomHistoryCursor({ createdAt: '2026-10-20T10:00:00.000000Z', jobId: randomUUID() })}=` },
    ];
    for (const input of bad) await expect(history(input), JSON.stringify(input)).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    await expect(history({ cursor: encodeAgentRoomHistoryCursor({ createdAt: '2026-10-20T10:00:05.000000Z', jobId: ids.r4! }) })).resolves.toBeDefined();
  });

  it('truncates long text with flags and keeps the serialized page within 256 KB across pages', async () => {
    await uiJob('long', '2026-10-21T00:00:00.000000Z', `LONGROW${'p'.repeat(5000)}`, 'r'.repeat(9000));
    const long = (await history({ query: 'LONGROW' })).items[0]!;
    expect(long.prompt).toHaveLength(4000);
    expect(long.reply).toHaveLength(8000);
    expect(long).toMatchObject({ promptTruncated: true, replyTruncated: true });
    await uiJob('exact', '2026-10-21T00:00:01.000000Z', `EXACTROW${'p'.repeat(3992)}`, 'r'.repeat(8000));
    expect((await history({ query: 'EXACTROW' })).items[0]).toMatchObject({ promptTruncated: false, replyTruncated: false });
    for (let index = 0; index < 30; index++) {
      await uiJob(`cap${index}`, `2026-10-22T00:00:${String(index).padStart(2, '0')}.000000Z`, `CAPTEST${'提'.repeat(3990)}`, '答'.repeat(8000));
    }
    const collected: string[] = [];
    let cursor: string | undefined;
    let pages = 0;
    do {
      const page = await history({ query: 'CAPTEST', limit: 50, ...(cursor ? { cursor } : {}) });
      expect(Buffer.byteLength(JSON.stringify(page), 'utf8')).toBeLessThanOrEqual(AGENT_ROOM_HISTORY_PAGE_MAX_BYTES);
      expect(page.items.length).toBeGreaterThan(0);
      collected.push(...page.items.map((item) => item.jobId));
      cursor = page.nextCursor ?? undefined;
      pages++;
    } while (cursor);
    expect(pages).toBeGreaterThan(1);
    expect(collected).toHaveLength(30);
    expect(new Set(collected).size).toBe(30);
  });

  it('lets the Agent room job and the shared admin-direct job call the tool; both see both origins; each call is audited', async () => {
    await setStatus(['r4', 'adm1'], 'running');
    try {
      const fromRoom = await call(jobContext('r4', 0, null), { query: 'line' });
      expect(fromRoom.items.map((item) => item.origin)).toEqual(['line_admin_direct']);
      const fromLine = await call(jobContext('adm1'), { query: 'alpha' });
      expect(fromLine.items.map((item) => item.origin)).toEqual(['agent_room']);
      const uiContext = await call({ sourceType: 'ui' }, { query: 'line hello' });
      expect(uiContext.items.some((item) => item.origin === 'line_admin_direct')).toBe(true);
      const rows = (await audits()).filter((row) => row.action === 'TOOL_CALLED');
      expect(rows.some((row) => row.principalId === 'internal:ui' && row.resultCount === fromRoom.items.length && row.disposition === 'ALLOWED')).toBe(true);
      expect(rows.some((row) => row.principalId.startsWith('internal:primary_admin:') && row.resultCount === fromLine.items.length)).toBe(true);
      expect((await tokens.verifyInternalAgentAccess({ context: jobContext('adm1') })).roomHistory).toBe(true);
      expect((await tokens.verifyInternalAgentAccess({ context: jobContext('r4', 0, null) })).roomHistory).toBe(true);
    } finally {
      await setStatus(['r4', 'adm1'], 'completed');
    }
  });

  it('denies and audits the primary admin in a group, a whitelisted friend, and released or stale-generation jobs', async () => {
    const grant = await new FriendWhitelistRepository(pool).activate('acc-agent', 'mid-friend', 'test-admin');
    await pool.query('UPDATE agent_jobs SET direct_friend_grant_id = $2, direct_friend_grant_version = $3 WHERE job_id = $1', [ids.fr1, grant.grantId, grant.version]);
    await setStatus(['fr1', 'grp1', 'adm1'], 'running');
    const before = (await audits()).length;
    try {
      await expect(call(jobContext('grp1'))).rejects.toMatchObject({ code: 'PERMISSION_DENIED' });
      expect((await tokens.verifyInternalAgentAccess({ context: jobContext('grp1') })).roomHistory).toBe(false);
      await expect(call(jobContext('fr1'))).rejects.toMatchObject({ code: 'PERMISSION_DENIED' });
      expect((await tokens.verifyInternalAgentAccess({ context: jobContext('fr1') })).roomHistory).toBe(false);
      await expect(call(jobContext('adm1', 99))).rejects.toMatchObject({ code: 'SCOPE_DENIED' });
      await setStatus(['adm1'], 'completed');
      await expect(call(jobContext('adm1'))).rejects.toMatchObject({ code: 'SCOPE_DENIED' });
      const added = (await audits()).slice(0, (await audits()).length - before);
      expect(added.every((row) => row.action === 'AUTH_REJECTED')).toBe(true);
      expect(added).toHaveLength(4);
      expect(added.filter((row) => row.disposition === 'PERMISSION_DENIED' && row.principalId.startsWith('internal:primary_admin:'))).toHaveLength(1);
      expect(added.filter((row) => row.disposition === 'PERMISSION_DENIED' && row.principalId.startsWith('internal:chat_scoped:'))).toHaveLength(1);
      expect(added.filter((row) => row.disposition === 'SCOPE_DENIED')).toHaveLength(2);
    } finally {
      await setStatus(['fr1', 'grp1', 'adm1'], 'completed');
    }
  });

  it('drops the admin-direct rows and denies the admin-direct job when the shared condition no longer holds', async () => {
    await setStatus(['adm1', 'r4'], 'running');
    const saved = await pool.query('SELECT account_id, chat_type, chat_id, user_id, role FROM account_administrators');
    try {
      await pool.query('DELETE FROM account_administrators');
      expect(await shared()).toBeNull();
      const roomOnly = await call(jobContext('r4', 0, null));
      expect(roomOnly.items.length).toBeGreaterThan(0);
      expect(roomOnly.items.every((item) => item.origin === 'agent_room')).toBe(true);
      await expect(call(jobContext('adm1'))).rejects.toMatchObject({ code: expect.stringMatching(/SCOPE_DENIED|PERMISSION_DENIED/) });
      // A different bound administrator chat also drops the old admin-direct rows.
      await pool.query("INSERT INTO account_administrators (account_id, chat_type, chat_id, user_id, role) VALUES ('acc-agent','direct','chat-friend','mid-friend','PRIMARY_ADMIN')");
      expect((await call({ sourceType: 'ui' }, { query: 'line hello' })).items).toEqual([]);
      await expect(call(jobContext('adm1'))).rejects.toMatchObject({ code: expect.stringMatching(/SCOPE_DENIED|PERMISSION_DENIED/) });
    } finally {
      await pool.query('DELETE FROM account_administrators');
      for (const row of saved.rows) {
        await pool.query('INSERT INTO account_administrators (account_id, chat_type, chat_id, user_id, role) VALUES ($1,$2,$3,$4,$5)',
          [row.account_id, row.chat_type, row.chat_id, row.user_id, row.role]);
      }
      await setStatus(['adm1', 'r4'], 'completed');
    }
    expect(await shared()).not.toBeNull();
  });

  it('decides the new-session hint eligibility from the live shared condition', async () => {
    const agents = new AgentRepository(pool);
    const direct = { sourceType: 'line' as const, accountId: 'acc-agent', chatType: 'direct', chatId: 'chat-admin' };
    expect(await agents.sharesAgentRoomHistory({ sourceType: 'ui', accountId: null, chatType: null, chatId: null })).toBe(true);
    expect(await agents.sharesAgentRoomHistory(direct)).toBe(true);
    expect(await agents.sharesAgentRoomHistory({ ...direct, chatType: 'group', chatId: 'g1' })).toBe(false);
    expect(await agents.sharesAgentRoomHistory({ ...direct, chatId: 'chat-friend' })).toBe(false);
    const saved = await pool.query('SELECT account_id, chat_type, chat_id, user_id, role FROM account_administrators');
    try {
      await pool.query('DELETE FROM account_administrators');
      expect(await agents.sharesAgentRoomHistory(direct)).toBe(false);
      expect(await agents.sharesAgentRoomHistory({ sourceType: 'ui', accountId: null, chatType: null, chatId: null })).toBe(true);
    } finally {
      for (const row of saved.rows) {
        await pool.query('INSERT INTO account_administrators (account_id, chat_type, chat_id, user_id, role) VALUES ($1,$2,$3,$4,$5)',
          [row.account_id, row.chat_type, row.chat_id, row.user_id, row.role]);
      }
    }
  });

  it('keeps the history tool out of stored token scopes and denies an external call with an audit row', async () => {
    await expect(pool.query(
      "INSERT INTO mcp_agent_tokens (token_id, token_digest, principal_id, device_label, account_scopes, tool_scopes, expires_at) VALUES ($1, $2, 'x', 'x', ARRAY['acc-agent'], ARRAY['query_agent_room_history'], now() + interval '1 day')",
      [randomUUID(), Buffer.alloc(32, 7)])).rejects.toThrow();
    const before = (await audits()).length;
    await expect(tokens.executeLocalClientRead({ toolName: TOOL, execute: async () => ({ data: 'unreachable' }) }))
      .rejects.toMatchObject({ code: 'SCOPE_DENIED' });
    const after = await audits();
    expect(after.length).toBe(before + 1);
    expect(after[0]).toMatchObject({ initiator: 'external_agent', action: 'AUTH_REJECTED', disposition: 'SCOPE_DENIED', toolName: TOOL, tokenId: null, principalId: 'local-client' });
  });
});
