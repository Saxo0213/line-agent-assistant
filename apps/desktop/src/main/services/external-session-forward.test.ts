import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Pool } from 'pg';
import { AGENT_ROOM_KEY, ForwardToSessionInputSchema } from '@line-agent/contracts';
import {
  AccountRepository, AdminRepository, AgentRepository, allPermissions, ExternalSessionRepository, McpTokenRepository, MessageRepository,
  type ExternalSessionRecord, type ExternalSessionReplyRecord,
} from '@line-agent/database';
import { createTestDatabase } from '../../../../../packages/database/src/test-database.js';
import { ExternalSessionService } from './external-session-service.js';
import { McpService, FORWARD_TO_SESSION_TOOL_DEFINITION } from './mcp-service.js';

type Rpc = (method: string, params?: unknown) => Promise<{ httpStatus: number; body: Record<string, unknown> | null }>;
const toolNames = async (rpc: Rpc) =>
  ((await rpc('tools/list')).body as { result: { tools: Array<{ name: string }> } }).result.tools.map((tool) => tool.name);
const resultOf = (response: Awaited<ReturnType<Rpc>>) =>
  (response.body as { result: { isError: boolean; structuredContent?: Record<string, unknown> } }).result;
const errorOf = (response: Awaited<ReturnType<Rpc>>) =>
  (response.body as { error: { message: string; data?: { code?: string } } }).error;

const ACCOUNT = 'acct-agent';
const KEY = 'session-key-0001';
const CLOSED_KEY = 'session-key-0002';

/** In-memory stand-in for the parts of ExternalSessionRepository that forward_to_session uses. */
class FakeSessions {
  sessions: ExternalSessionRecord[] = [
    { sessionKey: KEY, accountId: ACCOUNT, seq: 1, label: 'Build', createdAt: '2026-11-28T00:00:00.000Z', lastSeenAt: '2026-11-28T00:00:00.000Z', closedAt: null },
    { sessionKey: CLOSED_KEY, accountId: ACCOUNT, seq: 2, label: 'Old', createdAt: '2026-11-28T00:00:00.000Z', lastSeenAt: '2026-11-28T00:00:00.000Z', closedAt: '2026-11-28T01:00:00.000Z' },
  ];
  replies: ExternalSessionReplyRecord[] = [];
  trigger: { accountId: string; messageId: string; text: string; attachmentIds: string[] } | null =
    { accountId: ACCOUNT, messageId: 'msg-admin-1', text: 'Use the staging server.', attachmentIds: ['11111111-1111-4111-8111-111111111111'] };
  async findAdminTriggerMessage() { return this.trigger; }
  async closeIdleSessions() { return 0; }
  async getSessionBySeq(accountId: string, seq: number) { return this.sessions.find((session) => session.accountId === accountId && session.seq === seq) ?? null; }
  async getSession(accountId: string, sessionKey: string) { return this.sessions.find((session) => session.accountId === accountId && session.sessionKey === sessionKey) ?? null; }
  async touchSession() { /* not used here */ }
  async insertReply(input: { sessionKey: string; source: 'quote' | 'agent'; inboundMessageId: string; text: string; attachmentIds: readonly string[]; note?: string | null }) {
    const existing = this.replies.find((reply) => reply.inboundMessageId === input.inboundMessageId);
    if (existing) return { reply: existing, inserted: false };
    const reply: ExternalSessionReplyRecord = { replyId: `reply-${this.replies.length + 1}`, sessionKey: input.sessionKey, source: input.source,
      inboundMessageId: input.inboundMessageId, text: input.text, attachmentIds: [...input.attachmentIds], note: input.note ?? null,
      createdAt: new Date().toISOString(), deliveredAt: null };
    this.replies.push(reply);
    return { reply, inserted: true };
  }
  async takeUndeliveredReplies(sessionKey: string) {
    const due = this.replies.filter((reply) => reply.sessionKey === sessionKey && reply.deliveredAt === null);
    const now = new Date().toISOString();
    this.replies = this.replies.map((reply) => due.includes(reply) ? { ...reply, deliveredAt: now } : reply);
    return due.map((reply) => ({ ...reply, deliveredAt: now }));
  }
  async describeAttachments() { return []; }
}

function fakeHarness(options: { forwardToSession?: boolean } = {}) {
  const sessions = new FakeSessions();
  const externalSessions = new ExternalSessionService({ sessions: sessions as never, messages: { findAgentSendAccount: async () => ACCOUNT } });
  const tokens = {
    verifyInternalAgentAccess: async () => ({ permissions: allPermissions('ALLOW'), roomHistory: false, lineSend: true, forwardToSession: options.forwardToSession ?? true }),
    executeForInternalAgent: async (input: { execute: (context: unknown) => Promise<{ data: unknown }> }) => (await input.execute({ client: {}, principalId: 'internal:primary_admin:u-admin' })).data,
    recordAudit: async () => undefined,
  } as never;
  const service = new McpService({ pool: {} as Pool, tokens, messages: {} as MessageRepository, externalSessions });
  const { token } = service.internalCapabilities.mint({ jobId: 'job-1', generation: 1, accountId: ACCOUNT, endpointInstance: 'instance' });
  const rpc: Rpc = (method, params) => service.handleInternalJsonRpc(token, 'instance', { jsonrpc: '2.0', id: 1, method, ...(params === undefined ? {} : { params }) });
  return { sessions, externalSessions, service, rpc, call: (args: unknown) => rpc('tools/call', { name: 'forward_to_session', arguments: args }) };
}

describe('forward_to_session (fake repository)', () => {
  it('describes the tool with seq and note', () => {
    expect(FORWARD_TO_SESSION_TOOL_DEFINITION.inputSchema.required).toEqual(['seq']);
    expect(ForwardToSessionInputSchema.safeParse({ seq: 1, note: 'x'.repeat(500) }).success).toBe(true);
    expect(ForwardToSessionInputSchema.safeParse({ seq: 1, note: 'x'.repeat(501) }).success).toBe(false);
    expect(ForwardToSessionInputSchema.safeParse({ seq: 0 }).success).toBe(false);
  });

  it('lists the tool only when the repository says that the job may use it', async () => {
    const allowed = fakeHarness();
    expect(await toolNames(allowed.rpc)).toContain('forward_to_session');
    await allowed.service.shutdown();
    const denied = fakeHarness({ forwardToSession: false });
    expect(await toolNames(denied.rpc)).not.toContain('forward_to_session');
    await denied.service.shutdown();
  });

  it('writes an agent reply with the message, the attachments and the note, and wakes a waiting client', async () => {
    const h = fakeHarness();
    const waiter = h.externalSessions.run({ kind: 'wait', accountId: ACCOUNT, sessionKey: KEY, timeoutSeconds: 30 }, { signal: new AbortController().signal });
    const started = Date.now();
    const response = await h.call({ seq: 1, note: 'The admin answers your question about the server.' });
    const output = await waiter;
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(resultOf(response)).toMatchObject({ isError: false, structuredContent: { forwarded: true, replyId: 'reply-1', session: '【Build #1】' } });
    expect(h.sessions.replies).toHaveLength(1);
    expect(h.sessions.replies[0]).toMatchObject({ sessionKey: KEY, source: 'agent', inboundMessageId: 'msg-admin-1', text: 'Use the staging server.',
      attachmentIds: ['11111111-1111-4111-8111-111111111111'], note: 'The admin answers your question about the server.' });
    expect('replies' in output && output.replies.map((reply) => [reply.source, reply.text, reply.note])).toEqual([['agent', 'Use the staging server.', 'The admin answers your question about the server.']]);
    await h.service.shutdown();
  });

  it('returns the first replyId for a repeated call and writes one row only', async () => {
    const h = fakeHarness();
    const first = resultOf(await h.call({ seq: 1 })).structuredContent;
    const again = resultOf(await h.call({ seq: 1, note: 'second try' })).structuredContent;
    expect(again).toEqual(first);
    expect(h.sessions.replies).toHaveLength(1);
    expect(h.sessions.replies[0]!.note).toBeNull();
    await h.service.shutdown();
  });

  it('refuses a closed session, an unknown number, invalid arguments and a job without a message of the admin', async () => {
    const h = fakeHarness();
    const closed = await h.call({ seq: 2 });
    expect(closed.httpStatus).toBe(400);
    expect(errorOf(closed)).toMatchObject({ message: 'The session is closed.', data: { code: 'INVALID_INPUT' } });
    const unknown = await h.call({ seq: 9 });
    expect(unknown.httpStatus).toBe(400);
    expect(errorOf(unknown).data?.code).toBe('INVALID_INPUT');
    for (const bad of [{}, { seq: 0 }, { seq: 1.5 }, { seq: 1, note: 'x'.repeat(501) }, { seq: 1, extra: true }]) {
      const response = await h.call(bad);
      expect(response.httpStatus, JSON.stringify(bad)).toBe(400);
      expect(errorOf(response).data?.code).toBe('INVALID_INPUT');
    }
    h.sessions.trigger = null;
    expect((await h.call({ seq: 1 })).httpStatus).toBe(400);
    expect(h.sessions.replies).toHaveLength(0);
    await h.service.shutdown();
  });
});

const database = process.env.TEST_DATABASE_URL ? describe : describe.skip;

database('forward_to_session and the waiting-session list (real database)', () => {
  let pool: Pool;
  let closeDatabase: () => Promise<void>;
  let root: string;
  let tokens: McpTokenRepository;
  let agents: AgentRepository;
  let messages: MessageRepository;
  let repo: ExternalSessionRepository;
  const accountId = `acct-fwd-${randomUUID().slice(0, 8)}`;
  const openKey = `open-${randomUUID()}`;
  const closedKey = `closed-${randomUUID()}`;
  const staleKey = `stale-${randomUUID()}`;
  const blindKey = `blind-${randomUUID()}`;

  beforeAll(async () => {
    ({ pool, close: closeDatabase } = await createTestDatabase());
    root = await realpath(await mkdtemp(path.join(tmpdir(), 'forward-session-')));
    await mkdir(path.join(root, 'workspace'), { recursive: true });
    tokens = new McpTokenRepository(pool);
    agents = new AgentRepository(pool);
    messages = new MessageRepository(pool);
    repo = new ExternalSessionRepository(pool);
    await new AccountRepository(pool).ensureAccount(accountId);
    await pool.query("UPDATE line_accounts SET mode = 'ACTIVE_CONTROL', product_role = 'AGENT', own_mid = 'u-agent-own' WHERE account_id = $1", [accountId]);
    await new AdminRepository(pool).bindPrimary(accountId, 'chat-admin', 'u-admin');
    for (const [type, id, title] of [['direct', 'chat-admin', 'Admin'], ['group', 'g-team', 'Team Chat']] as const) {
      await pool.query('INSERT INTO conversations (account_id, chat_type, chat_id, title) VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING', [accountId, type, id, title]);
    }
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      for (const [sessionKey, label] of [[openKey, 'Build'], [closedKey, 'Old'], [staleKey, 'Stale'], [blindKey, 'Blind']] as const) {
        await repo.upsertSession(client, { accountId, sessionKey, label });
      }
      await client.query('COMMIT');
    } finally { client.release(); }
    await pool.query('UPDATE external_sessions SET closed_at = now() WHERE session_key = $1', [closedKey]);
    await pool.query("UPDATE external_sessions SET last_seen_at = now() - interval '25 hours' WHERE session_key = $1", [staleKey]);
    // Messages that the Agent account sent for the sessions. The open session has an older and a newer one; the blind one is not stored.
    const sent = async (messageId: string, sessionKey: string, text: string | null, ageSeconds: number) => {
      await pool.query(
        `INSERT INTO messages (account_id, message_id, event_id, chat_id, chat_type, sender_id, kind, text_content, ingestion_source, occurred_at, raw)
         VALUES ($1,$2,$3,'chat-admin','direct','u-agent-own','text',$4,'live',now(),'{}'::jsonb)`, [accountId, messageId, `ev-${messageId}`, text]);
      await pool.query(`INSERT INTO external_session_messages (account_id, line_message_id, session_key, sent_at) VALUES ($1,$2,$3, now() - make_interval(secs => $4))`,
        [accountId, messageId, sessionKey, ageSeconds]);
    };
    await sent('sent-old', openKey, '【Build #1】older text', 60);
    await sent('sent-new', openKey, `【Build #1】${'z'.repeat(120)}`, 10);
    await sent('sent-closed', closedKey, 'closed text', 5);
    await sent('sent-stale', staleKey, 'stale text', 5);
    await pool.query("INSERT INTO external_session_messages (account_id, line_message_id, session_key) VALUES ($1,'sent-not-stored',$2)", [accountId, blindKey]);
  });
  afterAll(async () => {
    await closeDatabase?.();
    await rm(root, { recursive: true, force: true });
  });

  async function adminMessage(chatType: 'direct' | 'group', text: string, secondsFromNow = 0): Promise<string> {
    const messageId = `m-${randomUUID()}`;
    const chatId = chatType === 'direct' ? 'chat-admin' : 'g-team';
    await pool.query(
      `INSERT INTO messages (account_id, message_id, event_id, chat_id, chat_type, sender_id, kind, text_content, ingestion_source, occurred_at, raw)
       VALUES ($1,$2,$3,$4,$5,'u-admin','text',$6,'live', now() + make_interval(secs => $7),'{}'::jsonb)`, [accountId, messageId, `ev-${messageId}`, chatId, chatType, text, secondsFromNow]);
    return messageId;
  }
  async function lineJob(chatType: 'direct' | 'group', messageId: string, status: 'running' | 'queued' = 'running', foldedInto: string | null = null) {
    const chatId = chatType === 'direct' ? 'chat-admin' : 'g-team';
    await pool.query("INSERT INTO agent_sessions (account_id, chat_type, chat_id, provider, source_type) VALUES ($1,$2,$3,'codex','line') ON CONFLICT DO NOTHING", [accountId, chatType, chatId]);
    if (status === 'running') await pool.query("UPDATE agent_jobs SET status = 'completed' WHERE account_id = $1 AND chat_id = $2 AND status = 'running'", [accountId, chatId]);
    const epoch = Number((await pool.query('SELECT control_epoch FROM account_control WHERE singleton = true')).rows[0].control_epoch);
    const jobId = randomUUID();
    await pool.query(
      `INSERT INTO agent_jobs (job_id, account_id, chat_type, chat_id, provider, source_type, source_message_id, prompt, workspace_path, generation, creation_epoch, status, folded_into)
       VALUES ($1,$2,$3,$4,'codex','line',$5,'p',$6,0,$7,$8,$9)`, [jobId, accountId, chatType, chatId, messageId, path.join(root, 'workspace'), epoch, status, foldedInto]);
    return { jobId, generation: 0, accountId };
  }
  async function uiJob() {
    await pool.query("UPDATE agent_jobs SET status = 'cancelled' WHERE source_type = 'ui' AND status IN ('queued', 'running')");
    // A room job waits while the shared admin-direct chat has a running LINE job.
    await pool.query("UPDATE agent_jobs SET status = 'completed' WHERE account_id = $1 AND source_type = 'line' AND status = 'running'", [accountId]);
    const { jobId } = await agents.enqueueUiJob({ provider: 'codex', requestId: randomUUID(), prompt: 'p', workspacePath: path.join(root, 'workspace') });
    const claimed = await agents.claimNext(AGENT_ROOM_KEY);
    expect(claimed?.jobId).toBe(jobId);
    return claimed!;
  }
  function harness() {
    const externalSessions = new ExternalSessionService({ sessions: repo, messages });
    const service = new McpService({ pool, tokens, messages, externalSessions });
    const open = (job: { jobId: string; generation: number; accountId: string | null }) => {
      const { token } = service.internalCapabilities.mint({ jobId: job.jobId, generation: job.generation, accountId: job.accountId, endpointInstance: 'instance' });
      const rpc: Rpc = (method, params) => service.handleInternalJsonRpc(token, 'instance', { jsonrpc: '2.0', id: 1, method, ...(params === undefined ? {} : { params }) });
      return { rpc, call: (args: unknown) => rpc('tools/call', { name: 'forward_to_session', arguments: args }) };
    };
    return { externalSessions, service, open };
  }
  const seqOf = async (sessionKey: string) => Number((await pool.query('SELECT seq FROM external_sessions WHERE session_key = $1', [sessionKey])).rows[0].seq);
  const replyRows = async (inboundMessageId: string) => (await pool.query('SELECT * FROM external_session_replies WHERE inbound_message_id = $1', [inboundMessageId])).rows;
  const auditCount = async (action: string) => Number((await pool.query(
    "SELECT count(*)::int AS n FROM mcp_agent_audit WHERE tool_name = 'forward_to_session' AND action = $1", [action])).rows[0].n);

  it('lists the open sessions of the last 24 hours with the first 80 characters of the last sent text', async () => {
    const waiting = await repo.listWaitingSessions(accountId, 24);
    expect(waiting.map((session) => session.label)).toEqual(['Build', 'Blind']);
    expect(waiting[0]).toMatchObject({ lastText: `【Build #1】${'z'.repeat(120)}` });
    expect(waiting[1]).toMatchObject({ lastText: null });
    const service = new ExternalSessionService({ sessions: repo, messages });
    const section = await service.waitingSessionsSection(accountId);
    expect(section.split('\n').slice(-2)).toEqual([`#${await seqOf(openKey)} Build: ${'z'.repeat(80)}`, `#${await seqOf(blindKey)} Blind`]);
    expect(await service.waitingSessionsSection('acct-without-sessions')).toBe('');
  });

  it('forwards the message of the Primary Admin from the direct chat, wakes the client, audits, and repeats with the same replyId', async () => {
    const messageId = await adminMessage('direct', 'Use the staging server.');
    const attachmentId = randomUUID();
    await pool.query(
      `INSERT INTO attachments (attachment_id, external_attachment_id, account_id, chat_type, chat_id, message_id, kind, name, mime_type, size_bytes, status)
       VALUES ($1,'ext-1',$2,'direct','chat-admin',$3,'file','plan.pdf','application/pdf',10,'queued')`, [attachmentId, accountId, messageId]);
    const job = await lineJob('direct', messageId);
    const h = harness();
    try {
      const { rpc, call } = h.open(job);
      expect(await toolNames(rpc)).toContain('forward_to_session');
      const waiter = h.externalSessions.run({ kind: 'wait', accountId, sessionKey: openKey, timeoutSeconds: 30 }, { signal: new AbortController().signal });
      const started = Date.now();
      const before = await auditCount('TOOL_CALLED');
      const seq = await seqOf(openKey);
      const first = resultOf(await call({ seq, note: 'It answers your question.' }));
      expect(first).toMatchObject({ isError: false, structuredContent: { forwarded: true, session: `【Build #${seq}】` } });
      const output = await waiter;
      expect(Date.now() - started).toBeLessThan(2_000);
      expect('replies' in output && output.replies.map((reply) => [reply.source, reply.text, reply.note, reply.attachments.map((item) => item.attachmentId)]))
        .toEqual([['agent', 'Use the staging server.', 'It answers your question.', [attachmentId]]]);
      const rows = await replyRows(messageId);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ session_key: openKey, source: 'agent', text: 'Use the staging server.', note: 'It answers your question.', attachment_ids: [attachmentId] });
      expect(await auditCount('TOOL_CALLED')).toBe(before + 1);
      const again = resultOf(await call({ seq }));
      expect(again.structuredContent).toEqual(first.structuredContent);
      expect(await replyRows(messageId)).toHaveLength(1);
    } finally { await h.service.shutdown(); }
  });

  it('forwards the last message of the Primary Admin when jobs were folded into the job', async () => {
    const first = await adminMessage('direct', 'first part', -2);
    const second = await adminMessage('direct', 'second part', -1);
    const lead = await lineJob('direct', first);
    await lineJob('direct', second, 'queued', lead.jobId);
    const h = harness();
    try {
      const { call } = h.open(lead);
      expect(resultOf(await call({ seq: await seqOf(openKey) })).isError).toBe(false);
      expect(await replyRows(first)).toHaveLength(0);
      expect((await replyRows(second))[0]).toMatchObject({ text: 'second part', source: 'agent' });
    } finally { await h.service.shutdown(); }
  });

  it('refuses a closed session and an unknown number with INVALID_INPUT, and audits the refusal', async () => {
    const messageId = await adminMessage('direct', 'to a closed session');
    const job = await lineJob('direct', messageId);
    const h = harness();
    try {
      const { call } = h.open(job);
      const before = await auditCount('AUTH_REJECTED');
      const closed = await call({ seq: await seqOf(closedKey) });
      expect(closed.httpStatus).toBe(400);
      expect(errorOf(closed)).toMatchObject({ message: 'The session is closed.', data: { code: 'INVALID_INPUT' } });
      const unknown = await call({ seq: 999 });
      expect(unknown.httpStatus).toBe(400);
      expect(errorOf(unknown).data?.code).toBe('INVALID_INPUT');
      expect(await replyRows(messageId)).toHaveLength(0);
      expect(await auditCount('AUTH_REJECTED')).toBe(before + 2);
    } finally { await h.service.shutdown(); }
  });

  it('offers the tool to no other job and refuses the call: the Agent room, a group job of the admin and the external endpoint', async () => {
    const groupMessage = await adminMessage('group', 'in the group');
    const h = harness();
    try {
      const seq = await seqOf(openKey);
      for (const [name, job] of [['Agent room', await uiJob()], ['group job of the admin', await lineJob('group', groupMessage)]] as const) {
        const { rpc, call } = h.open(job);
        expect(await toolNames(rpc), name).not.toContain('forward_to_session');
        const before = await auditCount('AUTH_REJECTED');
        const response = await call({ seq });
        expect(response.httpStatus, name).toBe(403);
        expect(await auditCount('AUTH_REJECTED'), name).toBe(before + 1);
      }
      expect(await replyRows(groupMessage)).toHaveLength(0);
      const listing = await h.service.handleExternalJsonRpc({ jsonrpc: '2.0', id: 1, method: 'tools/list' });
      expect(JSON.stringify(listing.body)).not.toContain('forward_to_session');
      const external = await h.service.handleExternalJsonRpc({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'forward_to_session', arguments: { seq } } });
      expect(external.httpStatus).toBe(403);
    } finally { await h.service.shutdown(); }
  });
});
