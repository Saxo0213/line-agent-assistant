import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Pool } from 'pg';
import { AgentRepository } from './agent-repository.js';
import { createTestDatabase } from './test-database.js';

const database = process.env.TEST_DATABASE_URL ? describe : describe.skip;

database('AgentRepository.listTranscriptEvents (real database)', () => {
  let pool: Pool;
  let close: () => Promise<void>;
  let agents: AgentRepository;
  let sequence = 0;

  /** Inserts an Agent room (account-less ui) job. created_at grows with the sequence, so the order is the insert order. */
  async function insert(prompt: string, status: string, finalText: string | null, generation = 0, provider = 'claude'): Promise<string> {
    sequence += 1;
    const jobId = `00000000-0000-4000-8000-${String(sequence).padStart(12, '0')}`;
    await pool.query(
      `INSERT INTO agent_jobs (job_id, provider, source_type, source_request_id, prompt, workspace_path, generation, status, created_at)
       VALUES ($1, $2, 'ui', $3, $4, 'C:\\work', $5, $6, now() + ($7 || ' seconds')::interval)`,
      [jobId, provider, `transcript-${sequence}`, prompt, generation, status, String(sequence)]);
    if (finalText !== null) await pool.query('INSERT INTO agent_outputs (job_id, final_text) VALUES ($1, $2)', [jobId, finalText]);
    return jobId;
  }

  beforeAll(async () => {
    ({ pool, close } = await createTestDatabase());
    agents = new AgentRepository(pool);
  });
  afterAll(async () => { await close(); });

  it('returns earlier jobs of the same queue key, provider and generation, oldest first', async () => {
    await insert('other generation', 'completed', 'x', 1);
    await insert('other provider', 'completed', 'x', 0, 'codex');
    await insert('first', 'completed', 'first answer');
    await insert('failed one', 'failed', null);
    await insert('second', 'completed', 'second answer');
    const lead = await insert('lead', 'completed', 'group answer');
    for (const text of ['follower one', 'follower two']) {
      const follower = await insert(text, 'completed', 'group answer');
      await pool.query('UPDATE agent_jobs SET folded_into = $1 WHERE job_id = $2', [lead, follower]);
    }
    const current = await insert('current', 'completed', null);
    await insert('later', 'queued', null);
    expect(await agents.listTranscriptEvents({ jobId: current, generation: 0 })).toEqual([
      { role: 'user', text: 'first' }, { role: 'assistant', text: 'first answer' },
      { role: 'user', text: 'failed one' },
      { role: 'user', text: 'second' }, { role: 'assistant', text: 'second answer' },
      { role: 'user', text: 'lead' }, { role: 'user', text: 'follower one' }, { role: 'user', text: 'follower two' },
      { role: 'assistant', text: 'group answer' },
    ]);
  });

  it('limits the rows to the newest 24 jobs', async () => {
    for (let index = 0; index < 30; index += 1) await insert(`bulk ${index}`, 'completed', `answer ${index}`, 5);
    const current = await insert('bulk current', 'completed', null, 5);
    const events = await agents.listTranscriptEvents({ jobId: current, generation: 5 });
    expect(events).toHaveLength(48);
    expect(events[0]).toEqual({ role: 'user', text: 'bulk 6' });
    expect(events.at(-1)).toEqual({ role: 'assistant', text: 'answer 29' });
  });
});
