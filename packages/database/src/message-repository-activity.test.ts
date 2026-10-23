import { describe, expect, it, vi } from 'vitest';
import type { Pool } from 'pg';
import { MessageRepository } from './message-repository.js';
import { createTestDatabase } from './test-database.js';

describe('bounded attachment activity reads', () => {
  it('uses separately capped current-state and terminal-error queries with safe projections', async () => {
    const statements: string[] = [];
    const pool = { async connect() { return {
      async query(sql: string) {
        statements.push(sql);
        if (sql.includes("a.status = 'expired'")) return { rows: [{ account_id: 'account-B', chat_type: 'direct', chat_id: 'peer-B', kind: 'file', status: 'failed',
          retry_count: 3, updated_at: new Date('2026-10-17T10:01:00.000Z') }] };
        if (sql.startsWith('SELECT a.account_id')) return { rows: [{ account_id: 'account-A', chat_type: 'group', chat_id: 'chat-A',
          kind: 'image', status: 'queued', retry_count: 0, updated_at: new Date('2026-10-17T10:00:00.000Z') }] };
        return { rows: [] };
      }, release() {},
    }; } } as unknown as Pool;
    const repository = new MessageRepository(pool);
    await expect(repository.listAttachmentActivity(500)).resolves.toEqual([{ accountId: 'account-A', chatType: 'group', chatId: 'chat-A',
      kind: 'image', status: 'queued', retryCount: 0, updatedAt: '2026-10-17T10:00:00.000Z' }]);
    await expect(repository.listTerminalAttachmentErrors(500)).resolves.toEqual([{ accountId: 'account-B', chatType: 'direct', chatId: 'peer-B',
      kind: 'file', status: 'failed', retryCount: 3, updatedAt: '2026-10-17T10:01:00.000Z' }]);
    const selects = statements.filter((sql) => sql.startsWith('SELECT a.account_id'));
    expect(selects).toHaveLength(2);
    expect(selects[0]).toContain('LIMIT 100');
    expect(selects[0]).toContain('c.chat_type = a.chat_type');
    expect(selects[1]).toContain("a.status = 'expired' OR (a.status = 'failed' AND (a.retry_count >= $1 OR a.retry_after = 'infinity'::timestamptz))");
    expect(selects[1]).toContain('LIMIT 100');
    expect(selects[1]).toContain('c.chat_type = a.chat_type');
    expect(selects.map((sql) => sql.slice(0, sql.indexOf('FROM'))).join(' ')).not.toMatch(/a\.(?:attachment_id|name|relative_path|error|text_content|raw)\b/);
  });

  it('destroys a client that arrives after acquisition timed out exactly once and drains the fence', async () => {
    vi.useFakeTimers();
    try {
      let finishConnect!: (client: { query: () => Promise<{ rows: never[] }>; release: (destroy?: boolean) => void }) => void;
      const release = vi.fn();
      const pool = { connect: () => new Promise<{ query: () => Promise<{ rows: never[] }>; release: (destroy?: boolean) => void }>((resolve) => { finishConnect = resolve; }) } as unknown as Pool;
      const repository = new MessageRepository(pool);
      const result = repository.listAttachmentActivity().catch((error: unknown) => error);
      await vi.advanceTimersByTimeAsync(2000);
      expect(String(await result)).toContain('ATTACHMENT_READ_TIMEOUT');
      let drained = false;
      const drain = repository.waitForReadDrain().then(() => { drained = true; });
      await Promise.resolve();
      expect(drained).toBe(false);
      finishConnect({ query: async () => ({ rows: [] }), release });
      await drain;
      expect(release).toHaveBeenCalledTimes(1);
      expect(release).toHaveBeenCalledWith(true);
      expect(vi.getTimerCount()).toBe(0);
    } finally { vi.useRealTimers(); }
  });

  it('keeps a timed out query in the read fence until it settles, then destroys the client once', async () => {
    vi.useFakeTimers();
    try {
      let finishQuery!: (value: { rows: never[] }) => void;
      let queryCount = 0;
      const release = vi.fn();
      const pool = { async connect() { return { query(sql: string) {
        queryCount += 1;
        return sql.startsWith('SELECT') ? new Promise<{ rows: never[] }>((resolve) => { finishQuery = resolve; }) : Promise.resolve({ rows: [] });
      }, release }; } } as unknown as Pool;
      const repository = new MessageRepository(pool);
      const result = repository.listAttachmentActivity().catch((error: unknown) => error);
      for (let attempt = 0; attempt < 10 && queryCount < 3; attempt += 1) await Promise.resolve();
      expect(queryCount).toBe(3);
      await vi.advanceTimersByTimeAsync(2000);
      expect(String(await result)).toContain('ATTACHMENT_READ_TIMEOUT');
      let drained = false;
      const drain = repository.waitForReadDrain().then(() => { drained = true; });
      await Promise.resolve();
      expect(drained).toBe(false);
      finishQuery({ rows: [] });
      await drain;
      expect(release).toHaveBeenCalledTimes(1);
      expect(release).toHaveBeenCalledWith(true);
      expect(vi.getTimerCount()).toBe(0);
    } finally { vi.useRealTimers(); }
  });
});

const database = process.env.TEST_DATABASE_URL ? describe : describe.skip;
database('attachments of accounts without download capability', () => {
  it('hides EXTERNAL_MONITOR attachments from activity and errors, restores them on mode change, and keeps the page full', async () => {
    const { pool, close } = await createTestDatabase();
    try {
      for (const [accountId, mode] of [['hide-monitor', 'EXTERNAL_MONITOR'], ['hide-active', 'SYSTEM_LOGIN']] as const) {
        await pool.query('INSERT INTO line_accounts(account_id, connection_mode) VALUES ($1, $2)', [accountId, mode]);
        await pool.query("INSERT INTO conversations(account_id, chat_type, chat_id) VALUES ($1, 'group', 'chat')", [accountId]);
        await pool.query(`INSERT INTO messages(account_id,message_id,event_id,chat_type,chat_id,sender_id,kind,ingestion_source,occurred_at,raw)
          SELECT $1, 'message-'||i, 'event-'||i, 'group', 'chat', 'sender', 'text', 'live', now(), '{}' FROM generate_series(1,205) i`, [accountId]);
      }
      // Monitor rows are newer than every visible row, so a page filled before filtering would be empty.
      await pool.query(`INSERT INTO attachments(external_attachment_id,account_id,message_id,chat_type,chat_id,kind,status,updated_at)
        SELECT 'mon-'||i, 'hide-monitor', 'message-'||i, 'group', 'chat', 'file', 'queued', now() - (i::text||' seconds')::interval
        FROM generate_series(1,150) i`);
      await pool.query(`INSERT INTO attachments(external_attachment_id,account_id,message_id,chat_type,chat_id,kind,status,updated_at)
        SELECT 'act-'||i, 'hide-active', 'message-'||i, 'group', 'chat', 'file', 'queued', now() - interval '1 hour' - (i::text||' seconds')::interval
        FROM generate_series(1,5) i`);
      await pool.query(`INSERT INTO attachments(external_attachment_id,account_id,message_id,chat_type,chat_id,kind,status,retry_count,updated_at)
        VALUES ('mon-exp','hide-monitor','message-201','group','chat','image','expired',0,now()),
               ('act-exp','hide-active','message-201','group','chat','image','expired',0,now()-interval '2 hours')`);
      const repository = new MessageRepository(pool);

      const activity = await repository.listAttachmentActivity(100);
      expect(activity).toHaveLength(6);
      expect(new Set(activity.map((row) => row.accountId))).toEqual(new Set(['hide-active']));
      const errors = await repository.listTerminalAttachmentErrors(100);
      expect(errors.map((row) => row.accountId)).toEqual(['hide-active']);

      await pool.query("UPDATE line_accounts SET connection_mode='SYSTEM_LOGIN' WHERE account_id='hide-monitor'");
      const restored = await repository.listAttachmentActivity(100);
      expect(restored).toHaveLength(100);
      expect(restored.every((row) => row.accountId === 'hide-monitor')).toBe(true);
      expect((await repository.listTerminalAttachmentErrors(100)).map((row) => row.accountId).sort()).toEqual(['hide-active', 'hide-monitor']);
    } finally { await close(); }
  });
});
database('terminal attachment query ordering', () => {
  it('finds old terminal errors beyond 100 newer ready attachments and applies the bounded indexes', async () => {
    const { pool, close } = await createTestDatabase();
    try {
      await pool.query("INSERT INTO line_accounts(account_id) VALUES ('work-activity-account')");
      await pool.query("INSERT INTO conversations(account_id, chat_type, chat_id) VALUES ('work-activity-account', 'group', 'work-activity-chat')");
      await pool.query(`INSERT INTO messages(account_id,message_id,event_id,chat_type,chat_id,sender_id,kind,ingestion_source,occurred_at,raw)
        SELECT 'work-activity-account', 'message-'||i, 'event-'||i, 'group', 'work-activity-chat', 'sender', 'text', 'live', now(), '{}'
        FROM generate_series(1,10002) i`);
      await pool.query(`INSERT INTO attachments(external_attachment_id,account_id,message_id,chat_type,chat_id,kind,status,relative_path,sha256,updated_at)
        SELECT 'ext-ready-'||i, 'work-activity-account', 'message-'||i, 'group', 'work-activity-chat', 'file', 'ready', 'safe/path', repeat('a',64), now() - (i::text||' seconds')::interval
        FROM generate_series(1,10000) i`);
      await pool.query(`INSERT INTO attachments(external_attachment_id,account_id,message_id,chat_type,chat_id,kind,status,retry_count,updated_at)
        VALUES ('ext-error-1','work-activity-account','message-10001','group','work-activity-chat','file','failed',3,now()-interval '1 day'),
               ('ext-error-2','work-activity-account','message-10002','group','work-activity-chat','image','expired',0,now()-interval '2 days')`);

      const rows = await new MessageRepository(pool).listTerminalAttachmentErrors(100);
      expect(rows.map((row) => row.status)).toEqual(['failed', 'expired']);
      expect(rows.map((row) => row.retryCount)).toEqual([3, 0]);
      const indexes = await pool.query<{ indexname: string; indexdef: string }>("SELECT indexname,indexdef FROM pg_indexes WHERE schemaname=current_schema() AND indexname IN ('attachments_work_activity_idx','attachments_terminal_error_activity_idx')");
      expect(indexes.rows).toHaveLength(2);
      expect(indexes.rows.map((index) => index.indexname).sort()).toEqual(['attachments_terminal_error_activity_idx', 'attachments_work_activity_idx']);
      expect(indexes.rows.find((index) => index.indexname === 'attachments_terminal_error_activity_idx')?.indexdef).toMatch(/WHERE .*expired.*failed.*retry_count.*3/is);

      await pool.query('ANALYZE attachments');
      await pool.query('ANALYZE conversations');
      const activityPlan = await pool.query(`EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON)
        SELECT a.account_id, c.chat_type, a.chat_id, a.kind, a.status, a.retry_count, a.updated_at
        FROM attachments a JOIN conversations c ON c.account_id = a.account_id AND c.chat_type = a.chat_type AND c.chat_id = a.chat_id
        ORDER BY a.updated_at DESC, a.attachment_id DESC LIMIT 100`);
      const terminalPlan = await pool.query(`EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON)
        SELECT a.account_id, c.chat_type, a.chat_id, a.kind, a.status, a.retry_count, a.updated_at
        FROM attachments a JOIN conversations c ON c.account_id = a.account_id AND c.chat_type = a.chat_type AND c.chat_id = a.chat_id
        WHERE a.status = 'expired' OR (a.status = 'failed' AND a.retry_count >= 3)
        ORDER BY a.updated_at DESC, a.attachment_id DESC LIMIT 100`);
      const activityExplain = JSON.stringify(activityPlan.rows[0]?.['QUERY PLAN']);
      const terminalExplain = JSON.stringify(terminalPlan.rows[0]?.['QUERY PLAN']);
      expect(activityExplain).toContain('attachments_work_activity_idx');
      expect(activityExplain).toContain('"Node Type":"Limit"');
      expect(activityExplain).toContain('"Actual Rows":100');
      expect(terminalExplain).toContain('attachments_terminal_error_activity_idx');
      expect(terminalExplain).toContain('"Node Type":"Limit"');
      expect(terminalExplain).toContain('"Actual Rows":2');
    } finally { await close(); }
  });
});
