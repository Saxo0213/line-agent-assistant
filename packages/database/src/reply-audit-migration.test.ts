import { describe, expect, it } from 'vitest';
import { AuditRepository } from './audit-repository.js';
import { createTestDatabase } from './test-database.js';

const database = process.env.TEST_DATABASE_URL ? describe : describe.skip;

database('agent_reply_audit audit action', () => {
  it('accepts the action with its result codes and a hits detail, and still rejects other result codes', async () => {
    const { pool, close } = await createTestDatabase();
    try {
      const audit = new AuditRepository(pool);
      for (const [index, resultCode] of ['allowed', 'blocked', 'judge_unavailable'].entries()) {
        await audit.append({ action: 'agent_reply_audit', phase: 'observed', initiator: 'system', correlationId: `reply-audit-${index}`,
          accountId: 'account-a', jobId: `job-${index}`, resultCode, createdAt: `2026-11-28T10:00:0${index}.000Z`,
          diagnostic: { operation: 'agent', stage: 'execute', category: 'denied', recovery: 'none', outcome: 'recovered',
            detail: 'hits:version.tool:category:system_info' } });
      }
      const rows = await pool.query<{ code: string }>("SELECT details->>'result_code' AS code FROM audit_logs WHERE action = 'agent_reply_audit' ORDER BY audit_id");
      expect(rows.rows.map((row) => row.code)).toEqual(['allowed', 'blocked', 'judge_unavailable']);
      const freeModeCodes = [['free_mode_judge', 'free_mode_judge_reply'], ['free_mode_judge', 'free_mode_judge_no_reply'],
        ['free_mode_interrupt', 'free_mode_interrupted'], ['free_mode_interrupt', 'free_mode_interrupt_refused_urgency'],
        ['free_mode_interrupt', 'free_mode_interrupt_refused_limit'], ['free_mode_interrupt', 'free_mode_interrupt_refused_not_running']] as const;
      for (const [index, [action, resultCode]] of freeModeCodes.entries()) {
        await audit.append({ action, phase: 'observed', initiator: 'system', correlationId: `free-mode-${index}`, accountId: 'account-a',
          resultCode, createdAt: `2026-11-28T11:00:0${index}.000Z` });
      }
      const free = await pool.query<{ action: string; code: string }>("SELECT action, details->>'result_code' AS code FROM audit_logs WHERE action LIKE 'free_mode_%' ORDER BY audit_id");
      expect(free.rows.map((row) => [row.action, row.code])).toEqual(freeModeCodes.map((pair) => [...pair]));
      await expect(pool.query(`INSERT INTO audit_logs(action, actor, details) VALUES
        ('agent_reply_audit', 'system', '{"phase":"observed","correlation_id":"bad-code-1","result_code":"leaked"}')`)).rejects.toThrow('invalid audit result code');
    } finally { await close(); }
  });
});
