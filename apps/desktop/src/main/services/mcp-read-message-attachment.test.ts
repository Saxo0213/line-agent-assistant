import { createHash, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Pool } from 'pg';
import { AGENT_ROOM_KEY } from '@line-agent/contracts';
import { AccountRepository, AgentRepository, McpTokenRepository, MessageRepository } from '@line-agent/database';
import { createTestDatabase } from '../../../../../packages/database/src/test-database.js';
import { McpService } from './mcp-service.js';
import { McpHttpServer } from './mcp-http-server.js';

const database = process.env.TEST_DATABASE_URL ? describe : describe.skip;
const bytes = Buffer.from('attachment bytes');
const sha256 = createHash('sha256').update(bytes).digest('hex');

database('read_message_attachment (internal Agent MCP tool)', () => {
  let pool: Pool;
  let closeDatabase: () => Promise<void>;
  let root: string;
  let workspace: string;
  const accountId = `acct-att-${randomUUID().slice(0, 8)}`;
  const pausedId = `acct-pau-${randomUUID().slice(0, 8)}`;
  const recoverable = new Set<string>();
  const stored = new Map<string, string>();

  async function addAttachment(account: string, status: string): Promise<string> {
    const id = randomUUID();
    const messageId = `m-${id}`;
    await pool.query("INSERT INTO conversations (account_id, chat_type, chat_id, title) VALUES ($1, 'group', 'g1', 'Group') ON CONFLICT DO NOTHING", [account]);
    await pool.query(`INSERT INTO messages (account_id, message_id, event_id, chat_id, chat_type, sender_id, kind, text_content, ingestion_source, occurred_at, raw)
      VALUES ($1, $2, $2, 'g1', 'group', 'u-1', 'file', NULL, 'live', now(), '{}'::jsonb)`, [account, messageId]);
    const ready = status === 'ready';
    if (ready) { const file = join(root, id); await writeFile(file, bytes); stored.set(id, file); }
    await pool.query(`INSERT INTO attachments(attachment_id, external_attachment_id, account_id, chat_type, chat_id, message_id, kind, name, size_bytes, status, relative_path, sha256)
      VALUES ($1::uuid, $2, $3, 'group', 'g1', $4, 'file', 'report.pdf', $5, $6, $7, $8)`,
    [id, `ext-${id}`, account, messageId, bytes.length, status, ready ? `managed/${id}` : null, ready ? sha256 : null]);
    return id;
  }

  beforeAll(async () => {
    ({ pool, close: closeDatabase } = await createTestDatabase());
    root = await mkdtemp(join(tmpdir(), 'mcp-read-attachment-'));
    workspace = join(root, 'workspace');
    await mkdir(workspace);
    const accounts = new AccountRepository(pool);
    await accounts.ensureAccount(accountId);
    await accounts.ensureAccount(pausedId);
    await pool.query("UPDATE line_accounts SET mode = 'MONITOR_ONLY' WHERE account_id = $1", [accountId]);
    await pool.query("UPDATE line_accounts SET mode = 'PAUSED' WHERE account_id = $1", [pausedId]);
  });
  afterAll(async () => { await closeDatabase?.(); await rm(root, { recursive: true, force: true }); });

  async function call(attachmentId: string) {
    const tokens = new McpTokenRepository(pool);
    const messages = new MessageRepository(pool);
    const service = new McpService({ pool, tokens, messages, jobFileAccess: () => ({ workspacePath: workspace, fileRead: true }), attachments: {
      recoverFromLocalDownloads: async (id) => {
        if (!recoverable.has(id)) return 'not_found';
        const file = join(root, id); await writeFile(file, bytes); stored.set(id, file);
        await pool.query("UPDATE attachments SET status = 'ready', relative_path = $2, sha256 = $3 WHERE attachment_id = $1", [id, `managed/${id}`, sha256]);
        return 'recovered';
      },
      resolveReadyPath: async (id) => stored.get(id) ?? null,
    } });
    const server = new McpHttpServer(service, { port: 0 });
    await server.start();
    try {
      await pool.query("UPDATE agent_jobs SET status = 'cancelled' WHERE source_type = 'ui' AND status IN ('queued', 'running')");
      const { jobId } = await new AgentRepository(pool).enqueueUiJob({ provider: 'codex', requestId: randomUUID(), prompt: 'p', workspacePath: workspace });
      const job = await new AgentRepository(pool).claimNext(AGENT_ROOM_KEY);
      expect(job?.jobId).toBe(jobId);
      const token = service.internalCapabilities.mint({ jobId, generation: job!.generation, accountId: null, approval: null, endpointInstance: server.endpointInstance }).token;
      const rpc = async (method: string, params?: unknown) => {
        const response = await fetch(server.status().endpoint!, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
          body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, ...(params === undefined ? {} : { params }) }) });
        return { status: response.status, body: await response.json() as Record<string, any> };
      };
      const listed = await rpc('tools/list');
      const result = await rpc('tools/call', { name: 'read_message_attachment', arguments: { attachmentId } });
      return { listed, result };
    } finally { await server.shutdown(); await service.shutdown(); }
  }

  it('copies a ready attachment into the job workspace and lists the tool', async () => {
    const id = await addAttachment(accountId, 'ready');
    const { listed, result } = await call(id);
    expect(listed.body.result.tools.map((tool: { name: string }) => tool.name)).toContain('read_message_attachment');
    expect(result.status).toBe(200);
    const data = result.body.result.structuredContent;
    expect(data).toMatchObject({ attachmentId: id, available: true, status: 'ready', name: 'report.pdf' });
    expect(await readFile(data.absolutePath)).toEqual(bytes);
  });

  it('recovers an expired attachment, or reports available=false when no same file exists', async () => {
    const recovered = await addAttachment(accountId, 'expired');
    recoverable.add(recovered);
    expect((await call(recovered)).result.body.result.structuredContent).toMatchObject({ available: true, status: 'ready' });
    const missing = await addAttachment(accountId, 'expired');
    const data = (await call(missing)).result.body.result.structuredContent;
    expect(data).toMatchObject({ available: false, status: 'expired', absolutePath: null });
    expect(data.reason).toContain('Downloads folder');
  });

  it('answers a hidden attachment and an unknown id with the same error', async () => {
    const hidden = await addAttachment(pausedId, 'ready');
    const forHidden = (await call(hidden)).result;
    const forUnknown = (await call(randomUUID())).result;
    expect(forHidden.status).toBe(403);
    expect(forUnknown.status).toBe(403);
    expect(forHidden.body.error).toEqual(forUnknown.body.error);
  });
});
