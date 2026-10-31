import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Pool } from 'pg';
import { AGENT_ROOM_KEY, SEND_TO_TARGET_TOOL_NAME } from '@line-agent/contracts';
import { AccountRepository, AdminRepository, AgentRepository, allPermissions, McpDomainError, McpTokenRepository, MessageRepository } from '@line-agent/database';
import { createTestDatabase } from '../../../../../packages/database/src/test-database.js';
import { AgentLineSendService, type AgentLineSendHandler } from './agent-line-send-service.js';
import { McpHttpServer, MCP_SEND_REQUEST_TIMEOUT_MS } from './mcp-http-server.js';
import { McpService, SEND_TO_TARGET_TOOL_DEFINITION } from './mcp-service.js';

type Rpc = (method: string, params?: unknown) => Promise<{ httpStatus: number; body: Record<string, unknown> | null }>;
const toolNames = async (rpc: Rpc) =>
  ((await rpc('tools/list')).body as { result: { tools: Array<{ name: string }> } }).result.tools.map((tool) => tool.name);
const SEND_TOOLS = ['list_send_targets', 'send_to_target'];

describe('send tool visibility (mocked repository)', () => {
  const handler = { listTargets: vi.fn(), authorize: vi.fn(), run: vi.fn() } as unknown as AgentLineSendHandler;
  function harness(lineSend: boolean, withHandler = true, call?: () => never) {
    const tokens = {
      verifyInternalAgentAccess: async () => ({ permissions: allPermissions('ALLOW'), roomHistory: false, lineSend }),
      executeForInternalAgent: async () => { if (call) call(); return { toolName: 'list_targets', targets: [] }; },
      recordAudit: async () => undefined,
    } as never;
    const service = new McpService({ pool: {} as Pool, tokens, messages: {} as MessageRepository, ...(withHandler ? { lineSend: handler } : {}) });
    const { token } = service.internalCapabilities.mint({ jobId: 'job-1', generation: 1, accountId: 'a', endpointInstance: 'instance' });
    const rpc: Rpc = (method, params) => service.handleInternalJsonRpc(token, 'instance', { jsonrpc: '2.0', id: 1, method, ...(params === undefined ? {} : { params }) });
    return { rpc, service };
  }

  it('lists the send tools only for a principal that may send, and only when the service exists', async () => {
    const allowed = harness(true);
    expect(await toolNames(allowed.rpc)).toEqual(['list_targets', 'query_target_messages', 'query_target_messages_by_time', 'list_active_chats', ...SEND_TOOLS]);
    await allowed.service.shutdown();
    const denied = harness(false);
    expect(await toolNames(denied.rpc)).not.toContain('send_to_target');
    expect(await toolNames(denied.rpc)).not.toContain('list_send_targets');
    await denied.service.shutdown();
    const absent = harness(true, false);
    expect(await toolNames(absent.rpc)).not.toContain('send_to_target');
    await absent.service.shutdown();
  });

  it('answers send_not_permitted when the repository denies the principal, for both tools', async () => {
    const { rpc, service } = harness(false, true, () => { throw new McpDomainError('PERMISSION_DENIED', 'no'); });
    for (const name of SEND_TOOLS) {
      const response = await rpc('tools/call', { name, arguments: { query: 'x', chatType: 'direct', chatId: 'c', items: [{ type: 'text', text: 'x' }] } });
      expect(response.httpStatus).toBe(200);
      expect(response.body).toMatchObject({ result: { isError: true } });
      expect(JSON.stringify(response.body)).toContain('send_not_permitted');
    }
    await service.shutdown();
    const noHandler = harness(true, false);
    const response = await noHandler.rpc('tools/call', { name: 'send_to_target', arguments: {} });
    expect(JSON.stringify(response.body)).toContain('send_not_permitted');
    await noHandler.service.shutdown();
  });

  it('describes the tools so the Agent disambiguates and never repeats an unknown send', () => {
    expect(SEND_TO_TARGET_TOOL_DEFINITION.description).toMatch(/unknown/);
    expect(SEND_TO_TARGET_TOOL_DEFINITION.inputSchema.properties.items.maxItems).toBe(10);
  });
});

describe('send tool HTTP backstop', () => {
  let server: McpHttpServer | undefined;
  it('gives only an internal send_to_target call the long deadline', async () => {
    const service = { handleInternalJsonRpc: vi.fn(async () => {
      await new Promise((resolve) => setTimeout(resolve, 400));
      return { httpStatus: 200, body: { jsonrpc: '2.0', id: 1, result: {} } };
    }), handleExternalJsonRpc: vi.fn() };
    server = new McpHttpServer(service as never, { port: 0, requestTimeoutMs: 100, sendRequestTimeoutMs: 5_000, approvalRequestTimeoutMs: 5_000 });
    await server.start();
    const token = `li_job_${'T'.repeat(43)}`;
    const post = (name: string, bearer = token) => fetch(server!.status().endpoint!, { method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${bearer}` },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: {} } }) });
    expect((await post(SEND_TO_TARGET_TOOL_NAME)).status).toBe(200);
    expect((await post('list_send_targets')).status).toBe(504);
    expect((await post('query_target_messages')).status).toBe(504);
    // The long deadline is internal-only: a request without an li_job_ bearer keeps the short one.
    service.handleExternalJsonRpc.mockImplementation(async () => {
      await new Promise((resolve) => setTimeout(resolve, 400));
      return { httpStatus: 200, body: { jsonrpc: '2.0', id: 1, result: {} } };
    });
    expect((await post(SEND_TO_TARGET_TOOL_NAME, `la_mcp_${'A'.repeat(43)}`)).status).toBe(504);
    expect((await post(SEND_TO_TARGET_TOOL_NAME, '')).status).toBe(504);
    expect(MCP_SEND_REQUEST_TIMEOUT_MS).toBe(605_000);
    await server.shutdown();
    server = undefined;
  });
});

const database = process.env.TEST_DATABASE_URL ? describe : describe.skip;

database('send tools end to end (real database, fake worker)', () => {
  let pool: Pool;
  let closeDatabase: () => Promise<void>;
  let root: string;
  let workspace: string;
  let tokens: McpTokenRepository;
  let agents: AgentRepository;
  let messages: MessageRepository;
  const accountId = `acct-send-${randomUUID().slice(0, 8)}`;
  const sent: Array<{ chatType: string; chatId: string; text?: string; fileName?: string }> = [];
  const worker = {
    binding: async (account: string) => ({ accountId: account, workerInstanceId: 'w-1', controlEpoch: 1, mode: 'ACTIVE_CONTROL' as const }),
    waitModeAck: async () => true,
    send: async (command: { accountId: string; workerInstanceId: string; controlEpoch: number; requestId: string; chatType: string; chatId: string; text: string }) => {
      sent.push({ chatType: command.chatType, chatId: command.chatId, text: command.text });
      return { type: 'sendResult' as const, accountId: command.accountId, workerInstanceId: command.workerInstanceId,
        controlEpoch: command.controlEpoch, requestId: command.requestId, status: 'sent' as const, messageId: `m-${sent.length}`, error: null };
    },
    sendMedia: async (command: { accountId: string; workerInstanceId: string; controlEpoch: number; requestId: string; chatType: string; chatId: string; fileName: string }) => {
      sent.push({ chatType: command.chatType, chatId: command.chatId, fileName: command.fileName });
      return { type: 'sendResult' as const, accountId: command.accountId, workerInstanceId: command.workerInstanceId,
        controlEpoch: command.controlEpoch, requestId: command.requestId, status: 'sent' as const, messageId: `m-${sent.length}`, error: null };
    },
  };

  beforeAll(async () => {
    ({ pool, close: closeDatabase } = await createTestDatabase());
    root = await realpath(await mkdtemp(path.join(tmpdir(), 'line-send-e2e-')));
    workspace = path.join(root, 'workspace');
    await mkdir(workspace, { recursive: true });
    await mkdir(path.join(root, 'attachments'), { recursive: true });
    tokens = new McpTokenRepository(pool);
    agents = new AgentRepository(pool);
    messages = new MessageRepository(pool);
    await new AccountRepository(pool).ensureAccount(accountId);
    await pool.query("UPDATE line_accounts SET mode = 'ACTIVE_CONTROL', product_role = 'AGENT' WHERE account_id = $1", [accountId]);
    await new AdminRepository(pool).bindPrimary(accountId, 'chat-admin', 'u-admin');
    for (const [type, id, title] of [['direct', 'chat-admin', 'Admin'], ['direct', 'u-alice', 'Alice Chen'], ['group', 'g-team', 'Team Chat'],
      ['community', 'c-1', 'Team Community']] as const) {
      await pool.query('INSERT INTO conversations (account_id, chat_type, chat_id, title) VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING', [accountId, type, id, title]);
    }
    await pool.query(
      `INSERT INTO messages (account_id, message_id, event_id, chat_id, chat_type, sender_id, kind, text_content, ingestion_source, occurred_at, raw)
       VALUES ($1,'m-comm','ev-comm','c-1','community','u-x','text','community announcement','live',now(),'{}'::jsonb)`, [accountId]);
  });
  afterAll(async () => {
    await closeDatabase?.();
    await rm(root, { recursive: true, force: true });
  });

  function harness() {
    const lineSend = new AgentLineSendService({ messages, worker: worker as never, canWriteLine: async () => true, attachmentRoot: path.join(root, 'attachments') });
    const service = new McpService({ pool, tokens, messages, lineSend });
    const open = (job: { jobId: string; generation: number; accountId: string | null }) => {
      const { token } = service.internalCapabilities.mint({ jobId: job.jobId, generation: job.generation, accountId: job.accountId, endpointInstance: 'instance' });
      const rpc: Rpc = (method, params) => service.handleInternalJsonRpc(token, 'instance', { jsonrpc: '2.0', id: 1, method, ...(params === undefined ? {} : { params }) });
      const call = async (name: string, args: unknown) => {
        const response = await rpc('tools/call', { name, arguments: args });
        return { response, result: (response.body as { result?: { structuredContent?: { results?: Array<{ index: number; status: string; code?: string }>; targets?: Array<{ no: number; chatType: string; chatId: string }> }; isError?: boolean } }).result };
      };
      return { rpc, call };
    };
    return { service, lineSend, open, close: async () => { await service.shutdown(); await lineSend.shutdown(); } };
  }

  async function uiJob() {
    await pool.query("UPDATE agent_jobs SET status = 'cancelled' WHERE source_type = 'ui' AND status IN ('queued', 'running')");
    const { jobId } = await agents.enqueueUiJob({ provider: 'codex', requestId: randomUUID(), prompt: 'p', workspacePath: workspace });
    const claimed = await agents.claimNext(AGENT_ROOM_KEY);
    expect(claimed?.jobId).toBe(jobId);
    return claimed!;
  }
  async function adminJob() {
    const messageId = `m-${randomUUID()}`;
    await pool.query(
      `INSERT INTO messages (account_id, message_id, event_id, chat_id, chat_type, sender_id, kind, text_content, ingestion_source, occurred_at, raw)
       VALUES ($1,$2,$3,'chat-admin','direct','u-admin','text','please send','live',now(),'{}'::jsonb)`, [accountId, messageId, `ev-${messageId}`]);
    await pool.query("INSERT INTO agent_sessions (account_id, chat_type, chat_id, provider, source_type) VALUES ($1,'direct','chat-admin','codex','line') ON CONFLICT DO NOTHING", [accountId]);
    await pool.query("UPDATE agent_jobs SET status = 'completed' WHERE account_id = $1 AND chat_id = 'chat-admin' AND status = 'running'", [accountId]);
    const epoch = Number((await pool.query('SELECT control_epoch FROM account_control WHERE singleton = true')).rows[0].control_epoch);
    const jobId = randomUUID();
    await pool.query(
      `INSERT INTO agent_jobs (job_id, account_id, chat_type, chat_id, provider, source_type, source_message_id, prompt, workspace_path, generation, creation_epoch, status)
       VALUES ($1,$2,'direct','chat-admin','codex','line',$3,'p',$4,0,$5,'running')`, [jobId, accountId, messageId, workspace, epoch]);
    return { jobId, generation: 0, accountId };
  }
  const sendRows = async (jobId: string) => (await pool.query('SELECT * FROM agent_line_sends WHERE job_id = $1 ORDER BY created_at, item_index', [jobId])).rows;
  const auditCount = async (toolName: string, action: string) => Number((await pool.query(
    'SELECT count(*)::int AS n FROM mcp_agent_audit WHERE tool_name = $1 AND action = $2', [toolName, action])).rows[0].n);

  it('marks the administrator chat with role primary_admin in both list tools and answers admin aliases first', async () => {
    await pool.query('UPDATE line_accounts SET own_mid = $2 WHERE account_id = $1', [accountId, `u-own-${accountId}`]);
    const h = harness();
    try {
      const { call } = h.open(await uiJob());
      const named = (await call('list_send_targets', { query: 'Admin' })).result?.structuredContent?.targets as Array<{ chatId: string; role?: string }>;
      expect(named).toEqual([expect.objectContaining({ chatId: 'chat-admin', role: 'primary_admin' })]);
      const alice = (await call('list_send_targets', { query: 'Alice' })).result?.structuredContent?.targets as Array<{ chatId: string; role?: string }>;
      expect(alice.map((target) => target.role)).toEqual([undefined]);
      for (const alias of ['管理員', '主要管理者', '管理者', 'admin', 'Administrator', 'me', '我']) {
        const rows = (await call('list_send_targets', { query: alias })).result?.structuredContent?.targets as Array<{ chatId: string; role?: string; no: number }>;
        expect(rows[0], alias).toMatchObject({ chatId: 'chat-admin', role: 'primary_admin', no: 1 });
      }
      const listed = (await call('list_targets', {})).result?.structuredContent?.targets as Array<{ chatId: string; chatType: string; role?: string }>;
      expect(listed.filter((target) => target.role).map((target) => target.chatId)).toEqual(['chat-admin']);
      expect(listed.find((target) => target.chatId === 'u-alice')?.role).toBeUndefined();
    } finally {
      await h.close();
      await pool.query("UPDATE agent_jobs SET status = 'cancelled' WHERE source_type = 'ui' AND status IN ('queued', 'running')");
      await pool.query('UPDATE line_accounts SET own_mid = NULL WHERE account_id = $1', [accountId]);
    }
  });

  it('lists the send tools for the desktop operator and the Primary Admin job, and finds targets without communities', async () => {
    const h = harness();
    try {
      for (const job of [await uiJob(), await adminJob()]) {
        const { rpc, call } = h.open(job);
        expect(await toolNames(rpc)).toEqual(expect.arrayContaining(SEND_TOOLS));
        const before = await auditCount('list_send_targets', 'TOOL_CALLED');
        const { result } = await call('list_send_targets', { query: 'team' });
        expect(result?.isError).toBe(false);
        expect(result?.structuredContent?.targets?.map((target) => `${target.chatType}:${target.chatId}`)).toEqual(['group:g-team']);
        expect(result?.structuredContent?.targets?.[0]?.no).toBe(1);
        expect(await auditCount('list_send_targets', 'TOOL_CALLED')).toBe(before + 1);
        expect((await call('list_send_targets', { query: '' })).response.httpStatus).toBe(400);
      }
    } finally { await h.close(); }
  });

  it('sends text, forwards a community message and a workspace file, and audits without content', async () => {
    const h = harness();
    try {
      const job = await adminJob();
      const { call } = h.open(job);
      await writeFile(path.join(workspace, 'report.txt'), 'quarterly numbers');
      const before = await auditCount('send_to_target', 'TOOL_CALLED');
      sent.length = 0;
      const { result } = await call('send_to_target', { chatType: 'direct', chatId: 'u-alice', items: [
        { type: 'text', text: 'Hello Alice SECRET-WORD' },
        { type: 'message', accountId, chatType: 'community', chatId: 'c-1', messageId: 'm-comm' },
        { type: 'file', path: 'report.txt' },
      ] });
      expect(result?.structuredContent?.results?.map((item) => item.status)).toEqual(['sent', 'sent', 'sent']);
      expect(sent.map((entry) => entry.text ?? entry.fileName)).toEqual(['Hello Alice SECRET-WORD', 'community announcement', 'report.txt']);
      expect(await auditCount('send_to_target', 'TOOL_CALLED')).toBe(before + 1);
      const rows = await sendRows(job.jobId);
      expect(rows.map((row) => [row.item_index, row.item_kind, row.status, row.chat_id])).toEqual([
        [0, 'text', 'sent', 'u-alice'], [1, 'message', 'sent', 'u-alice'], [2, 'file', 'sent', 'u-alice']]);
      expect(rows[0].principal_id).toBe('internal:primary_admin:u-admin');
      const stored = JSON.stringify(rows);
      for (const forbidden of ['SECRET-WORD', 'report.txt', 'community announcement']) expect(stored).not.toContain(forbidden);
    } finally { await h.close(); }
  });

  it('refuses community and unknown targets, an escaping path and the per-job cap', async () => {
    const h = harness();
    try {
      const job = await uiJob();
      const { call } = h.open(job);
      sent.length = 0;
      const community = await call('send_to_target', { chatType: 'community', chatId: 'c-1', items: [{ type: 'text', text: 'x' }] });
      expect(community.result?.structuredContent?.results).toEqual([{ index: 0, status: 'failed', code: 'send_target_invalid' }]);
      const unknown = await call('send_to_target', { chatType: 'group', chatId: 'g-missing', items: [{ type: 'text', text: 'x' }] });
      expect(unknown.result?.structuredContent?.results?.[0]).toMatchObject({ status: 'failed', code: 'send_target_invalid' });
      const escape = await call('send_to_target', { chatType: 'direct', chatId: 'u-alice', items: [{ type: 'file', path: '../outside.txt' }] });
      expect(escape.result?.structuredContent?.results?.[0]).toMatchObject({ status: 'failed', code: 'send_file_invalid' });
      expect(sent).toHaveLength(0);
      expect((await sendRows(job.jobId)).map((row) => [row.status, row.error_code])).toEqual([['denied', 'send_target_invalid'], ['denied', 'send_file_invalid']]);
      for (let round = 0; round < 3; round += 1) {
        const items = Array.from({ length: 10 }, (_, index) => ({ type: 'text', text: `n${round}-${index}` }));
        expect((await call('send_to_target', { chatType: 'group', chatId: 'g-team', items })).result?.structuredContent?.results).toHaveLength(10);
      }
      const over = await call('send_to_target', { chatType: 'group', chatId: 'g-team', items: [{ type: 'text', text: 'one too many' }] });
      expect(over.result?.structuredContent?.results).toEqual([{ index: 0, status: 'failed', code: 'send_limit_exceeded' }]);
      expect(sent).toHaveLength(30);
    } finally { await h.close(); }
  });
});
