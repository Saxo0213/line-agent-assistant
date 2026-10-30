import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Pool } from 'pg';
import { AGENT_ROOM_KEY } from '@line-agent/contracts';
import { AccountRepository, AdminRepository, AgentRepository, McpTokenRepository, MessageRepository } from '@line-agent/database';
import { createTestDatabase } from '../../../../../packages/database/src/test-database.js';
import { McpService, type McpServiceOptions } from './mcp-service.js';
import { McpHttpServer } from './mcp-http-server.js';
import type { InternalMcpObservation } from './internal-mcp-capabilities.js';

const database = process.env.TEST_DATABASE_URL ? describe : describe.skip;

database('internal Agent MCP capability transport', () => {
  let pool: Pool;
  let closeDatabase: () => Promise<void>;
  let agents: AgentRepository;
  let tokens: McpTokenRepository;
  const accountId = `acct-int-${randomUUID().slice(0, 8)}`;
  const otherAccountId = `acct-oth-${randomUUID().slice(0, 8)}`;

  beforeAll(async () => {
    ({ pool, close: closeDatabase } = await createTestDatabase());
    agents = new AgentRepository(pool);
    tokens = new McpTokenRepository(pool);
    const accounts = new AccountRepository(pool);
    for (const id of [accountId, otherAccountId]) {
      await accounts.ensureAccount(id);
      await pool.query("UPDATE line_accounts SET mode = 'MONITOR_ONLY' WHERE account_id = $1", [id]);
    }
    await new MessageRepository(pool).upsertConversationCatalog(accountId, [
      { chatType: 'group', chatId: 'group-int', title: 'Internal Room', members: [{ memberId: 'u-1', displayName: 'Alice' }] },
    ]);
  });
  afterAll(async () => { await closeDatabase?.(); });

  /** A running job of the shared Agent room (account-less); the room runs one job at a time, so earlier ones are retired. */
  async function runningJob() {
    await pool.query("UPDATE agent_jobs SET status = 'cancelled' WHERE source_type = 'ui' AND status IN ('queued', 'running')");
    const requestId = randomUUID();
    const { jobId } = await agents.enqueueUiJob({ provider: 'codex', requestId, prompt: 'p', workspacePath: 'C:\\w' });
    const claimed = await agents.claimNext(AGENT_ROOM_KEY);
    expect(claimed?.jobId).toBe(jobId);
    return claimed!;
  }
  const unclaimedJob = () => ({ jobId: randomUUID(), generation: 0, accountId: null });

  async function harness(options: { max?: number; broker?: McpServiceOptions['approvalBroker']; requestTimeoutMs?: number } = {}) {
    const observed: Array<[string, InternalMcpObservation]> = [];
    const service = new McpService({ pool, tokens, messages: new MessageRepository(pool),
      ...(options.max === undefined ? {} : { maxInternalCapabilities: options.max }),
      ...(options.broker === undefined ? {} : { approvalBroker: options.broker }),
      onInternalObservation: (jobId, observation) => observed.push([jobId, observation]) });
    const server = new McpHttpServer(service, { port: 0, ...(options.requestTimeoutMs === undefined ? {} : { requestTimeoutMs: options.requestTimeoutMs }) });
    await server.start();
    const endpoint = server.status().endpoint!;
    const rpc = async (token: string | null, method: string, params?: unknown, id: number | undefined = 1) => {
      const response = await fetch(endpoint, { method: 'POST',
        headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
        body: JSON.stringify({ jsonrpc: '2.0', ...(id === undefined ? {} : { id }), method, ...(params === undefined ? {} : { params }) }) });
      const text = await response.text();
      return { status: response.status, body: text ? JSON.parse(text) : null };
    };
    const mint = (job: { jobId: string; generation: number; accountId: string | null }, approval: { sessionKey: string; workspaceRoot: string } | null = null) =>
      service.internalCapabilities.mint({ jobId: job.jobId, generation: job.generation, accountId: job.accountId, approval, endpointInstance: server.endpointInstance }).token;
    return { service, server, endpoint, rpc, mint, observed, close: async () => { await server.shutdown(); await service.shutdown(); } };
  }

  const auditCount = async (disposition: string, toolName: string | null) => Number((await pool.query(
    "SELECT count(*)::int AS n FROM mcp_agent_audit WHERE initiator = 'internal_agent' AND disposition = $1 AND tool_name IS NOT DISTINCT FROM $2",
    [disposition, toolName])).rows[0].n);

  it('serves handshake, only the read-only tools, and audits tool calls', async () => {
    const h = await harness();
    try {
      const job = await runningJob();
      const token = h.mint(job);
      const init = await h.rpc(token, 'initialize', { protocolVersion: '2025-03-26' });
      expect(init.body.result.protocolVersion).toBe('2025-03-26');
      expect(h.observed.some(([, o]) => o === 'available')).toBe(false);
      const initialized = await h.rpc(token, 'notifications/initialized', undefined, undefined);
      expect(initialized.status).toBe(202);
      const list = await h.rpc(token, 'tools/list');
      expect(list.body.result.tools.map((tool: { name: string }) => tool.name))
        .toEqual(['list_targets', 'query_target_messages', 'query_target_messages_by_time', 'query_agent_room_history']);
      expect(h.observed).toContainEqual([job.jobId, 'available']);
      const before = await auditCount('ALLOWED', 'list_targets');
      const call = await h.rpc(token, 'tools/call', { name: 'list_targets', arguments: { query: 'Internal' } });
      expect(call.status).toBe(200);
      expect(call.body.result.structuredContent.toolName).toBe('list_targets');
      expect(await auditCount('ALLOWED', 'list_targets')).toBe(before + 1);
      const unsupported = await h.rpc(token, 'tools/call', { name: 'issue_token', arguments: {} });
      expect(unsupported.status).toBe(400);
      expect((await h.rpc(token, 'resources/list')).status).toBe(404);
    } finally { await h.close(); }
  });

  it('allows a LINE-source job only while its message sender is the bound Primary Admin', async () => {
    const h = await harness();
    try {
      const account = `acct-line-${randomUUID().slice(0, 8)}`;
      const accounts = new AccountRepository(pool);
      await accounts.ensureAccount(account);
      await pool.query("UPDATE line_accounts SET mode = 'ACTIVE_CONTROL' WHERE account_id = $1", [account]);
      await new AdminRepository(pool).bindPrimary(account, 'chat-admin', 'u-admin');
      const chatId = 'chat-admin';
      await pool.query(`INSERT INTO conversations (account_id, chat_type, chat_id, title) VALUES ($1, 'direct', $2, 'Admin') ON CONFLICT DO NOTHING`, [account, chatId]);
      const messageId = `m-${randomUUID()}`;
      await pool.query(
        `INSERT INTO messages (account_id, message_id, event_id, chat_id, chat_type, sender_id, kind, text_content, ingestion_source, occurred_at, raw)
         VALUES ($1, $2, $3, $4, 'direct', 'u-admin', 'text', 'hi', 'live', now(), '{}'::jsonb)`, [account, messageId, `ev-${messageId}`, chatId]);
      await pool.query(`INSERT INTO agent_sessions (account_id, chat_type, chat_id, provider, source_type) VALUES ($1, 'direct', $2, 'codex', 'line') ON CONFLICT DO NOTHING`, [account, chatId]);
      const epoch = Number((await pool.query('SELECT control_epoch FROM account_control WHERE singleton = true')).rows[0].control_epoch);
      const jobId = randomUUID();
      await pool.query(
        `INSERT INTO agent_jobs (job_id, account_id, chat_type, chat_id, provider, source_type, source_message_id, prompt, workspace_path, generation, creation_epoch, status)
         VALUES ($1, $2, 'direct', $3, 'codex', 'line', $4, 'p', 'C:\\w', 0, $5, 'running')`, [jobId, account, chatId, messageId, epoch]);
      const token = h.mint({ jobId, generation: 0, accountId: account });
      const allowed = await h.rpc(token, 'tools/call', { name: 'list_targets', arguments: {} });
      expect(allowed.status).toBe(200);
      const before = await auditCount('SCOPE_DENIED', 'list_targets');
      await pool.query('DELETE FROM account_administrators WHERE account_id = $1', [account]);
      const denied = await h.rpc(token, 'tools/call', { name: 'list_targets', arguments: {} });
      expect(denied.status).toBe(403);
      expect(await auditCount('SCOPE_DENIED', 'list_targets')).toBe(before + 1);
      expect((await h.rpc(token, 'tools/list')).status).toBe(403);
    } finally { await h.close(); }
  });

  it('rejects unknown, wrong-instance, and spoofed li_job_ capabilities and routes other bearer values to the external handler', async () => {
    const h = await harness();
    try {
      const job = await runningJob();
      // No bearer value goes to the external handler. This fixture has no AGENT or PRIMARY_ADMIN account, so it refuses with 403, not 401.
      expect((await h.rpc(null, 'tools/list')).status).toBe(403);
      const unknownBefore = await auditCount('AUTH_INVALID', null);
      const unknown = 'li_job_' + 'A'.repeat(43);
      expect((await h.rpc(unknown, 'tools/list')).status).toBe(401);
      expect(await auditCount('AUTH_INVALID', null)).toBe(unknownBefore + 1);
      const leaked = await pool.query("SELECT count(*)::int AS n FROM mcp_agent_audit WHERE principal_id LIKE '%AAAAAAAA%'");
      expect(leaked.rows[0].n).toBe(0);
      const foreign = h.service.internalCapabilities.mint({ ...job, endpointInstance: 'another-listener' }).token;
      expect((await h.rpc(foreign, 'tools/list')).status).toBe(401);
      // An old la_mcp_ bearer value is ignored: the request goes to the external handler (403 here), never to the internal one.
      const legacy = await h.rpc('la_mcp_' + 'A'.repeat(43), 'tools/list');
      expect(legacy.status).toBe(403);
      expect(JSON.stringify(legacy.body)).not.toMatch(/request_permission|query_agent_room_history|send_to_target/);
    } finally { await h.close(); }
  });

  it('denies and audits stale generation, wrong account, and non-running jobs on every request', async () => {
    const h = await harness();
    try {
      const job = await runningJob();
      const stale = h.mint({ ...job, generation: job.generation + 1 });
      const before = await auditCount('SCOPE_DENIED', 'list_targets');
      const staleResult = await h.rpc(stale, 'tools/call', { name: 'list_targets', arguments: {} });
      expect(staleResult.status).toBe(403);
      expect(await auditCount('SCOPE_DENIED', 'list_targets')).toBe(before + 1);
      expect((await h.rpc(stale, 'tools/list')).status).toBe(403);

      const wrongAccount = h.mint({ ...job, accountId: otherAccountId });
      expect((await h.rpc(wrongAccount, 'initialize', {})).status).toBe(403);

      const good = h.mint(job);
      expect((await h.rpc(good, 'tools/list')).status).toBe(200);
      await agents.cancelJob(job.jobId);
      expect((await h.rpc(good, 'tools/list')).status).toBe(403);
      expect((await h.rpc(good, 'tools/call', { name: 'list_targets', arguments: {} })).status).toBe(403);
    } finally { await h.close(); }
  });

  it('keeps a permission prompt open past the short request deadline and aborts it when the client disconnects', async () => {
    let release!: () => void;
    const signals: AbortSignal[] = [];
    const broker = { request: async (input: { signal: AbortSignal; input: Record<string, unknown> }) => {
      signals.push(input.signal);
      await new Promise<void>((resolve) => { release = resolve; input.signal.addEventListener('abort', () => resolve(), { once: true }); });
      return input.signal.aborted ? { behavior: 'deny' as const, message: 'cancelled' } : { behavior: 'allow' as const, updatedInput: input.input };
    } };
    const h = await harness({ broker: broker as never, requestTimeoutMs: 100 });
    try {
      const job = await runningJob();
      const token = h.mint(job, { sessionKey: 's', workspaceRoot: 'C:\\w' });
      const list = await h.rpc(token, 'tools/list');
      expect(list.body.result.tools.map((tool: { name: string }) => tool.name)).toContain('request_permission');
      const pending = h.rpc(token, 'tools/call', { name: 'request_permission', arguments: { tool_name: 'Bash', input: { command: 'ls' } } });
      await new Promise((resolve) => setTimeout(resolve, 400));
      expect(signals).toHaveLength(1);
      expect(signals[0]!.aborted).toBe(false);
      release();
      const answered = await pending;
      expect(answered.status).toBe(200);
      expect(JSON.parse(answered.body.result.content[0].text)).toEqual({ behavior: 'allow', updatedInput: { command: 'ls' } });

      // A disconnected client aborts the pending prompt, so the broker can settle it.
      const client = new AbortController();
      const abandoned = fetch(h.endpoint, { method: 'POST', signal: client.signal,
        headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
        body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'request_permission', arguments: { tool_name: 'Bash', input: { command: 'pwd' } } } }) });
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(signals).toHaveLength(2);
      client.abort();
      await expect(abandoned).rejects.toThrow();
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(signals[1]!.aborted).toBe(true);
    } finally { await h.close(); }
  });

  it('closes admission at release and shutdown, and the registry stays bounded and drains', async () => {
    const h = await harness({ max: 2 });
    try {
      const jobs = [unclaimedJob(), await runningJob()];
      const tokens2 = jobs.map((job) => h.mint(job));
      const third = unclaimedJob();
      expect(() => h.mint(third)).toThrow(/limit/);
      expect(h.service.internalCapabilities.size).toBe(2);
      h.service.internalCapabilities.release(jobs[0]!.jobId);
      expect((await h.rpc(tokens2[0]!, 'tools/list')).status).toBe(401);
      expect((await h.rpc(tokens2[1]!, 'tools/list')).status).toBe(200);
      // Re-minting replaces rather than accumulates.
      h.mint(jobs[1]!);
      expect(h.service.internalCapabilities.size).toBe(1);
      expect((await h.rpc(tokens2[1]!, 'tools/list')).status).toBe(401);
      h.service.internalCapabilities.release(jobs[1]!.jobId);
      expect(h.service.internalCapabilities.size).toBe(0);
      const last = h.mint(jobs[1]!);
      await h.service.shutdown();
      expect(h.service.internalCapabilities.size).toBe(0);
      expect((await h.rpc(last, 'tools/list')).status).toBeGreaterThanOrEqual(400);
    } finally { await h.close(); }
  });
});
