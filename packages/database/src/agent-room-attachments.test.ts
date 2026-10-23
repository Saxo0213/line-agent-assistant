import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Pool } from 'pg';
import { AGENT_ROOM_KEY, type AgentStoredAttachment } from '@line-agent/contracts';
import { AccountRepository } from './account-repository.js';
import { AgentRepository } from './agent-repository.js';
import { createTestDatabase } from './test-database.js';

const database = process.env.TEST_DATABASE_URL ? describe : describe.skip;

const stored = (jobId: string, name: string): AgentStoredAttachment => ({ name, size: 3, kind: 'image', mime: 'image/png', sha256: 'a'.repeat(64), relativePath: `.agent-attachments/${jobId}/${name}` });

database('migration 041: Agent room attachments', () => {
  let pool: Pool;
  let close: () => Promise<void>;
  let agents: AgentRepository;
  beforeAll(async () => {
    const created = await createTestDatabase();
    pool = created.pool; close = created.close; agents = new AgentRepository(pool);
    await new AccountRepository(pool).ensureAccount('att-A');
  });
  afterAll(async () => { await close?.(); });

  it('defaults to an empty array for existing and plain UI rows', async () => {
    const result = await agents.enqueueUiJob({ provider: 'codex', requestId: 'plain', prompt: 'p', workspacePath: 'C:\\w' });
    const row = await pool.query('SELECT attachments FROM agent_jobs WHERE job_id = $1', [result.jobId]);
    expect(row.rows[0].attachments).toEqual([]);
    expect((await agents.getJob(result.jobId))?.attachments).toBeUndefined();
  });

  it('stores caller-chosen job id and metadata for a UI job and returns it when claimed', async () => {
    const jobId = randomUUID();
    const result = await agents.enqueueUiJob({ provider: 'claude', requestId: 'with-files', prompt: 'p', workspacePath: 'C:\\w', jobId, attachments: [stored(jobId, 'a.png')] });
    expect(result).toEqual({ disposition: 'inserted', jobId });
    expect((await agents.getJob(jobId))?.attachments).toEqual([stored(jobId, 'a.png')]);
    // Repeating the request id keeps the first job and its files.
    const repeat = await agents.enqueueUiJob({ provider: 'claude', requestId: 'with-files', prompt: 'p', workspacePath: 'C:\\w', jobId: randomUUID(), attachments: [] });
    expect(repeat).toEqual({ disposition: 'duplicate', jobId });
    const claimed = await agents.claimNext(AGENT_ROOM_KEY);
    expect(claimed?.jobId).toBeDefined();
  });

  it('the database rejects attachments on a LINE job (row 9) and accepts the empty default', async () => {
    await pool.query(`INSERT INTO conversations (account_id, chat_type, chat_id) VALUES ('att-A','group','g1')`);
    await pool.query(
      `INSERT INTO messages (account_id, message_id, event_id, chat_id, chat_type, sender_id, kind, text_content, ingestion_source, occurred_at, raw)
       VALUES ('att-A','line-msg','line-event','g1','group','sender','text','hi','live',now(),'{}'::jsonb)`);
    await pool.query(`INSERT INTO agent_sessions (account_id, chat_type, chat_id, provider, source_type, generation) VALUES ('att-A','group','g1','codex','line',0)`);
    const insert = (attachments: unknown, messageId: string) => pool.query(
      `INSERT INTO agent_jobs (job_id, account_id, chat_type, chat_id, provider, source_type, source_message_id, prompt, workspace_path, generation, creation_epoch, attachments)
       VALUES ($1,'att-A','group','g1','codex','line',$2,'p','C:\\w',0,0,$3::jsonb)`, [randomUUID(), messageId, JSON.stringify(attachments)]);
    await expect(insert([stored('x', 'a.png')], 'line-msg')).rejects.toThrow(/agent_jobs_attachments_ui_only_check/);
    await expect(insert([], 'line-msg')).resolves.toBeDefined();
  });

  it('the database rejects a non-array or an oversized attachments value on any job', async () => {
    const update = (value: unknown) => pool.query(`UPDATE agent_jobs SET attachments = $1::jsonb WHERE source_type = 'ui'`, [JSON.stringify(value)]);
    await expect(update({ not: 'array' })).rejects.toThrow(/agent_jobs_attachments_shape_check/);
    await expect(update(Array.from({ length: 11 }, (_, i) => stored('x', `f${i}.png`)))).rejects.toThrow(/agent_jobs_attachments_shape_check/);
  });

  it('the migration is idempotent', async () => {
    const sql = await readFile(fileURLToPath(new URL('../migrations/041_agent_room_attachments.sql', import.meta.url)), 'utf8');
    await pool.query(sql);
    await pool.query(sql);
    const constraints = await pool.query(`SELECT conname FROM pg_constraint WHERE conrelid = 'agent_jobs'::regclass AND conname LIKE 'agent_jobs_attachments_%' ORDER BY conname`);
    expect(constraints.rows.map((row) => row.conname)).toEqual(['agent_jobs_attachments_shape_check', 'agent_jobs_attachments_ui_only_check']);
  });
});
