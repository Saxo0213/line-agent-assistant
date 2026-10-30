import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { InboundEnvelope } from '@line-agent/contracts';
import { Pool, type PoolClient } from 'pg';
import { loadMigrations, migrate } from './migrate.js';
import { AccountRepository } from './account-repository.js';
import { AgentRepository } from './agent-repository.js';
import { MessageRepository } from './message-repository.js';
import { createTestDatabase } from './test-database.js';
import { normalizeOperation } from '../../line-worker/src/normalizer.js';
import { sanitizeInbound } from '../../../apps/desktop/src/main/services/sensitive-message-sanitizer.js';

const database = process.env.TEST_DATABASE_URL ? describe : describe.skip;
let sequence = 0;
function envelope(overrides: Partial<InboundEnvelope> = {}): InboundEnvelope {
  const id = ++sequence;
  return {
    eventId: `event-${id}`, accountId: 'account-A', chatId: 'chat-A', chatType: 'group',
    senderId: 'sender-A', messageId: `message-${id}`, kind: 'text', text: `hello ${id}`,
    mentionIds: [], mentionRanges: [], replyToMessageId: null,
    ingestion: { source: 'live', cursor: `cursor-${id}` },
    occurredAt: '2026-10-15T10:00:00.000Z', attachments: [], raw: {},
    ...overrides,
  };
}
const route = { eligible: true as const, provider: 'codex' as const, prompt: 'help', workspacePath: 'C:\\work' };

describe('bounded exact attachment state reads', () => {
  it('uses a read-only exact-scope query, limits IDs, and exposes no storage fields', async () => {
    const statements: string[] = [];
    let values: unknown[] = [];
    const client = {
      async query(sql: string, params?: unknown[]) {
        statements.push(sql);
        if (sql.startsWith('SELECT a.attachment_id')) {
          values = params ?? [];
          return { rows: [
            { attachment_id: '2a653934-7064-4d90-a9f0-e6e24cf4f93d', message_id: 'older-visible', kind: 'file', name: 'report.pdf',
              mime_type: 'application/pdf', size_bytes: '2048', status: 'ready', can_retry_manually: false },
            { attachment_id: '3b764a45-8175-4e01-9201-f7f35d5a05e1', message_id: 'retryable-failed', kind: 'file', name: 'retry.pdf',
              mime_type: 'application/pdf', size_bytes: '1024', status: 'queued', can_retry_manually: false },
          ] };
        }
        return { rows: [] };
      }, release() {},
    };
    const repository = new MessageRepository({ connect: async () => client } as unknown as Pool);
    const id = '2a653934-7064-4d90-a9f0-e6e24cf4f93d';
    const retryableId = '3b764a45-8175-4e01-9201-f7f35d5a05e1';
    const result = await repository.listAttachmentStates({ accountId: 'account-A', chatType: 'group', chatId: 'chat-A' }, [id, retryableId], 3);
    expect(result).toEqual([
      { attachmentId: id, messageId: 'older-visible', kind: 'file', name: 'report.pdf', mimeType: 'application/pdf', sizeBytes: 2048, status: 'ready', canRetryManually: false },
      { attachmentId: retryableId, messageId: 'retryable-failed', kind: 'file', name: 'retry.pdf', mimeType: 'application/pdf', sizeBytes: 1024, status: 'queued', canRetryManually: false },
    ]);
    expect(values).toEqual(['account-A', 'group', 'chat-A', [id, retryableId], 3, expect.any(Array)]);
    const select = statements.find((sql) => sql.startsWith('SELECT a.attachment_id')) ?? '';
    expect(select).toContain('a.account_id=$1 AND a.chat_type=$2 AND a.chat_id=$3 AND a.attachment_id=ANY($4::uuid[])');
    expect(select).toContain('LIMIT 225');
    expect(select).toMatch(/a\.status='expired'.*AS can_retry_manually/s);
    expect(select).toContain("m.occurred_at < now() - interval '7 days'");
    expect(select).toContain("FROM attachments a JOIN messages m");
    const projection = "CASE WHEN a.status='queued' AND a.error = ANY($6::text[]) THEN a.error END AS block_reason";
    expect(select).toContain(projection);
    expect(select.replace(projection, '')).not.toMatch(/relative_path|sha256|error|secret/i);
    expect(statements).toEqual(['BEGIN READ ONLY', "SET LOCAL statement_timeout = '2000ms'", select, 'COMMIT']);
    await expect(repository.listAttachmentStates({ accountId: 'account-A', chatType: 'group', chatId: 'chat-A' }, Array(226).fill(id))).rejects.toThrow(/225/);
    expect(statements).toHaveLength(4);
  });
});

describe('attachment transaction deadlines', () => {
  it('destroys a client when BEGIN hangs past the transaction deadline', async () => {
    let releasedWithError = false;
    const client = {
      async query(sql: string) {
        if (sql === 'BEGIN') return new Promise(() => undefined);
        return { rows: [] };
      },
      release(error?: Error | boolean) { releasedWithError = Boolean(error); },
    };
    const repository = new MessageRepository({ connect: async () => client } as unknown as Pool);
    const started = Date.now();
    await expect(Promise.race([
      repository.revokeAttachmentOwner(randomUUID()),
      new Promise<never>((_resolve, reject) => setTimeout(() => reject(new Error('transaction did not enforce a client deadline')), 1_200)),
    ])).rejects.toThrow('deadline');
    expect(Date.now() - started).toBeLessThan(1_200);
    expect(releasedWithError).toBe(true);
  });

  it.each(['SET LOCAL statement_timeout = \'500ms\'', 'COMMIT'])('destroys a client when %s hangs past the transaction deadline', async (blockedSql) => {
    let finishStage!: () => void;
    let stageStarted!: () => void;
    const stageGate = new Promise<void>((resolve) => { finishStage = resolve; });
    const stageEntered = new Promise<void>((resolve) => { stageStarted = resolve; });
    const queries: string[] = [];
    const releases: Array<Error | boolean | undefined> = [];
    const client = {
      async query(sql: string) {
        queries.push(sql);
        if (sql === blockedSql) { stageStarted(); await stageGate; }
        return { rows: [] };
      },
      release(error?: Error | boolean) { releases.push(error); },
    } as unknown as PoolClient;
    const repository = new MessageRepository({ connect: async () => client } as unknown as Pool);
    const transaction = repository.revokeAttachmentOwner(randomUUID());
    await stageEntered;
    await expect(transaction).rejects.toThrow('deadline');
    finishStage();
    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(releases).toEqual([true]);
    if (blockedSql.startsWith('SET ')) expect(queries).not.toContain('COMMIT');
  });

  it('destroys a client acquired after the transaction deadline exactly once', async () => {
    let acquireLate!: (client: PoolClient) => void;
    const queries: string[] = [];
    const releases: Array<Error | boolean | undefined> = [];
    const client = {
      async query(sql: string) { queries.push(sql); return { rows: [] }; },
      release(error?: Error | boolean) { releases.push(error); },
    } as unknown as PoolClient;
    const pool = { connect: () => new Promise<PoolClient>((resolve) => { acquireLate = resolve; }) } as unknown as Pool;
    const repository = new MessageRepository(pool);

    await expect(repository.revokeAttachmentOwner(randomUUID())).rejects.toThrow('deadline');
    acquireLate(client);
    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(releases).toEqual([true]);
    expect(queries).toEqual([]);
  });

  it('does not commit after an operation resumes beyond the transaction deadline', async () => {
    const queries: string[] = [];
    const releases: Array<Error | boolean | undefined> = [];
    let finishOperation!: () => void;
    let operationStarted!: () => void;
    const operationGate = new Promise<void>((resolve) => { finishOperation = resolve; });
    const operationEntered = new Promise<void>((resolve) => { operationStarted = resolve; });
    const client = {
      async query(sql: string) {
        queries.push(sql);
        if (sql.startsWith('INSERT INTO attachment_execution_owners')) {
          operationStarted();
          await operationGate;
        }
        return { rows: [] };
      },
      release(error?: Error | boolean) { releases.push(error); },
    } as unknown as PoolClient;
    const repository = new MessageRepository({ connect: async () => client } as unknown as Pool);
    const transaction = repository.revokeAttachmentOwner(randomUUID());
    await operationEntered;
    await expect(transaction).rejects.toThrow('deadline');
    finishOperation();
    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(queries).not.toContain('COMMIT');
    expect(queries).not.toContain('ROLLBACK');
    expect(releases).toEqual([true]);
  });

  it('rolls back an operation error before releasing a healthy client', async () => {
    const queries: string[] = [];
    const releases: Array<Error | boolean | undefined> = [];
    const client = {
      async query(sql: string) {
        queries.push(sql);
        if (sql.startsWith('INSERT INTO attachment_execution_owners')) throw new Error('operation failed');
        return { rows: [] };
      },
      release(error?: Error | boolean) { releases.push(error); },
    } as unknown as PoolClient;
    const repository = new MessageRepository({ connect: async () => client } as unknown as Pool);

    await expect(repository.revokeAttachmentOwner(randomUUID())).rejects.toThrow('operation failed');
    expect(queries).toContain('ROLLBACK');
    expect(queries).not.toContain('COMMIT');
    expect(releases).toEqual([false]);
  });
});

database('043 conversation title placeholder cleanup', () => {
  it('clears all three placeholder titles, preserves real titles, and resolves a direct peer name in the conversation list', async () => {
    const database = await createTestDatabase();
    try {
      const { pool } = database;
      const accountId = `title-placeholders-${randomUUID()}`;
      await pool.query('INSERT INTO line_accounts(account_id) VALUES ($1)', [accountId]);
      await pool.query(`INSERT INTO conversations(account_id,chat_type,chat_id,title) VALUES
        ($1,'direct','placeholder-direct','個人聊天室'),
        ($1,'group','placeholder-group','群組聊天室'),
        ($1,'room','placeholder-room','多人聊天室'),
        ($1,'direct','real-title','Friend real title')`, [accountId]);
      await pool.query('INSERT INTO line_contacts(account_id,mid,display_name) VALUES ($1,$2,$3)',
        [accountId, 'placeholder-direct', 'Peer LINE name']);

      const migrationSql = await readFile(new URL('../migrations/043_clear_conversation_title_placeholders.sql', import.meta.url), 'utf8');
      await pool.query(migrationSql);
      const titles = await pool.query<{ chat_id: string; title: string }>(
        'SELECT chat_id,title FROM conversations WHERE account_id=$1 ORDER BY chat_id', [accountId]);
      expect(titles.rows).toEqual([
        { chat_id: 'placeholder-direct', title: '' },
        { chat_id: 'placeholder-group', title: '' },
        { chat_id: 'placeholder-room', title: '' },
        { chat_id: 'real-title', title: 'Friend real title' },
      ]);

      const conversationList = await new MessageRepository(pool).listConversationTargets({ accountIds: [accountId] });
      expect(conversationList.find((row) => row.chatId === 'placeholder-direct')?.conversationTitle).toBe('Peer LINE name');
    } finally {
      await database.close();
    }
  });
});

database('migration coordination with PostgreSQL', () => {
  it('does not serialize migrations across separate schemas', async () => {
    const connectionString = process.env.TEST_DATABASE_URL!;
    const admin = new Pool({ connectionString });
    const suffix = randomUUID().replaceAll('-', '');
    const gateKey = `migration_lock_test_${suffix}`;
    const firstApplication = `migration_first_${suffix}`;
    const secondApplication = `migration_second_${suffix}`;
    const firstDirectory = await mkdtemp(join(tmpdir(), 'line-agent-migration-lock-'));
    const secondDirectory = await mkdtemp(join(tmpdir(), 'line-agent-migration-lock-'));
    await writeFile(join(firstDirectory, '001_block.sql'), `SELECT pg_advisory_xact_lock(hashtextextended('${gateKey}', 0));`);
    let secondPool: Pool | undefined;
    let firstPool: Pool | undefined;
    let gatePool: Pool | undefined;
    let gateClient: PoolClient | undefined;
    let firstMigration: Promise<void> | undefined;
    let secondMigration: Promise<void> | undefined;
    let unlockGate: (() => Promise<void>) | undefined;
    try {
      firstPool = new Pool({ connectionString, application_name: firstApplication, options: '-c search_path=pg_temp', max: 1 });
      secondPool = new Pool({ connectionString, application_name: secondApplication, options: '-c search_path=pg_temp', max: 1 });
      gatePool = new Pool({ connectionString });
      await firstPool.query('CREATE TEMP TABLE migration_test_marker (id integer)');
      await secondPool.query('CREATE TEMP TABLE migration_test_marker (id integer)');
      gateClient = await gatePool.connect();
      await gateClient.query('SELECT pg_advisory_lock(hashtextextended($1, 0))', [gateKey]);
      unlockGate = async () => {
        try { await gateClient!.query('SELECT pg_advisory_unlock(hashtextextended($1, 0))', [gateKey]); }
        finally { gateClient!.release(); gateClient = undefined; }
      };

      let firstSettled = false;
      firstMigration = migrate(firstPool, firstDirectory).finally(() => { firstSettled = true; });
      const waitForAdvisoryBlock = async (applicationName: string, settled: () => boolean): Promise<boolean> => {
        while (!settled()) {
          const activity = await admin.query<{ wait_event_type: string | null; wait_event: string | null }>(
            'SELECT wait_event_type, wait_event FROM pg_stat_activity WHERE application_name = $1', [applicationName],
          );
          if (activity.rows.some((row) => row.wait_event_type === 'Lock' && row.wait_event === 'advisory')) return true;
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
        return false;
      };
      expect(await waitForAdvisoryBlock(firstApplication, () => firstSettled)).toBe(true);

      let secondSettled = false;
      secondMigration = migrate(secondPool, secondDirectory).finally(() => { secondSettled = true; });
      expect(await waitForAdvisoryBlock(secondApplication, () => secondSettled)).toBe(false);
      await secondMigration;
    } finally {
      await unlockGate?.();
      await Promise.all([firstMigration?.catch(() => undefined), secondMigration?.catch(() => undefined)]);
      gateClient?.release();
      await Promise.all([firstPool?.end(), secondPool?.end(), gatePool?.end()]);
      await admin.end();
      await rm(firstDirectory, { recursive: true, force: true });
      await rm(secondDirectory, { recursive: true, force: true });
    }
  });
});

describe('migration discovery without PostgreSQL', () => {
  it('loads numbered SQL files in order and ignores unrelated files', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'line-agent-migrations-'));
    try {
      await writeFile(join(directory, '010_later.sql'), 'SELECT 10;');
      await writeFile(join(directory, '002_first.sql'), 'SELECT 2;');
      await writeFile(join(directory, 'notes.txt'), 'ignore');
      const migrations = await loadMigrations(directory);
      expect(migrations.map((item) => [item.name, item.sql])).toEqual([['002_first.sql', 'SELECT 2;'], ['010_later.sql', 'SELECT 10;']]);
      expect(migrations.every((item) => /^[a-f0-9]{64}$/.test(item.checksum))).toBe(true);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});

database('002 migration upgrade from existing 001 data', () => {
  it('preserves the recorded 001 checksum while backfilling scoped identity', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'line-agent-upgrade-'));
    let close: (() => Promise<void>) | undefined;
    try {
      const migrations = await loadMigrations();
      const initial = migrations.find((item) => item.name === '001_initial.sql')!;
      const second = migrations.find((item) => item.name === '002_multi_account_domain.sql')!;
      await writeFile(join(directory, initial.name), initial.sql);
      const database = await createTestDatabase(directory);
      close = database.close;
      const { pool } = database;
      await pool.query("INSERT INTO line_accounts (account_id) VALUES ('legacy-account')");
      await pool.query("INSERT INTO conversations (account_id, chat_id, chat_type) VALUES ('legacy-account', 'legacy-chat', 'group')");
      await pool.query("INSERT INTO messages (account_id, message_id, event_id, chat_id, sender_id, kind, mention_ids, mention_ranges, ingestion_source, occurred_at, raw) VALUES ('legacy-account', 'legacy-message', 'legacy-event', 'legacy-chat', 'legacy-sender', 'text', '[]', '[]', 'live', now(), '{}')");
      await pool.query("INSERT INTO messages (account_id, message_id, event_id, chat_id, sender_id, kind, mention_ids, mention_ranges, ingestion_source, occurred_at, raw) VALUES ('legacy-account', 'legacy-message-2', 'legacy-event-2', 'legacy-chat', 'legacy-sender', 'text', '[]', '[]', 'live', now(), '{}'), ('legacy-account', 'legacy-message-3', 'legacy-event-3', 'legacy-chat', 'legacy-sender', 'text', '[]', '[]', 'live', now(), '{}'), ('legacy-account', 'legacy-message-4', 'legacy-event-4', 'legacy-chat', 'legacy-sender', 'text', '[]', '[]', 'live', now(), '{}')");
      await pool.query("INSERT INTO attachments (attachment_id, account_id, message_id, kind) VALUES ('legacy-attachment', 'legacy-account', 'legacy-message', 'image')");
      await pool.query("INSERT INTO agent_sessions (account_id, chat_id, provider) VALUES ('legacy-account', 'legacy-chat', 'codex')");
      await pool.query(`INSERT INTO agent_jobs (job_id, account_id, chat_id, provider, source_type, source_message_id, source_request_id, prompt, workspace_path, generation, status) VALUES
        ('11111111-1111-4111-8111-111111111111', 'legacy-account', 'legacy-chat', 'codex', 'line', 'legacy-message', NULL, 'queued', 'C:\\work', 0, 'queued'),
        ('22222222-2222-4222-8222-222222222222', 'legacy-account', 'legacy-chat', 'codex', 'line', 'legacy-message-2', NULL, 'pending', 'C:\\work', 0, 'completed'),
        ('33333333-3333-4333-8333-333333333333', 'legacy-account', 'legacy-chat', 'codex', 'line', 'legacy-message-3', NULL, 'sending', 'C:\\work', 0, 'completed'),
        ('66666666-6666-4666-8666-666666666666', 'legacy-account', 'legacy-chat', 'codex', 'line', 'legacy-message-4', NULL, 'running', 'C:\\work', 0, 'running'),
        ('44444444-4444-4444-8444-444444444444', 'legacy-account', 'legacy-chat', 'codex', 'ui', NULL, 'legacy-ui-pending', 'ui pending', 'C:\\work', 0, 'completed'),
        ('55555555-5555-4555-8555-555555555555', 'legacy-account', 'legacy-chat', 'codex', 'ui', NULL, 'legacy-ui-sent', 'ui sent', 'C:\\work', 0, 'completed')`);
      await pool.query(`INSERT INTO agent_deliveries (delivery_id, job_id, part_index, text_content, idempotency_key, status) VALUES
        ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', '22222222-2222-4222-8222-222222222222', 0, 'pending', 'legacy-line-pending', 'pending'),
        ('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', '33333333-3333-4333-8333-333333333333', 0, 'sending', 'legacy-line-sending', 'sending'),
        ('cccccccc-cccc-4ccc-8ccc-cccccccccccc', '44444444-4444-4444-8444-444444444444', 0, 'ui pending', 'legacy-ui-pending', 'pending'),
        ('dddddddd-dddd-4ddd-8ddd-dddddddddddd', '55555555-5555-4555-8555-555555555555', 0, 'ui sent', 'legacy-ui-sent', 'sent')`);
      await writeFile(join(directory, second.name), second.sql);
      await migrate(pool, directory);
      const state = await pool.query(
        `SELECT
          (SELECT checksum FROM schema_migrations WHERE name = '001_initial.sql') AS checksum,
          (SELECT count(*) FROM schema_migrations) AS migrations,
          (SELECT mode FROM line_accounts WHERE account_id = 'legacy-account') AS mode,
          (SELECT chat_type FROM agent_jobs WHERE job_id = '11111111-1111-4111-8111-111111111111') AS job_chat_type,
          (SELECT external_attachment_id FROM attachments WHERE account_id = 'legacy-account') AS external_attachment_id,
          (SELECT control_epoch FROM account_control WHERE singleton = true) AS control_epoch,
          (SELECT status FROM agent_jobs WHERE job_id = '11111111-1111-4111-8111-111111111111') AS queued_status,
          (SELECT status FROM agent_jobs WHERE job_id = '66666666-6666-4666-8666-666666666666') AS running_status,
          (SELECT status FROM agent_deliveries WHERE delivery_id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa') AS line_pending,
          (SELECT status FROM agent_deliveries WHERE delivery_id = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb') AS line_sending,
          (SELECT status FROM agent_deliveries WHERE delivery_id = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc') AS ui_pending,
          (SELECT status FROM agent_deliveries WHERE delivery_id = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd') AS ui_sent,
          (SELECT count(*) FROM agent_deliveries WHERE job_id IN ('44444444-4444-4444-8444-444444444444', '55555555-5555-4555-8555-555555555555')) AS ui_audit_rows`,
      );
      expect(state.rows[0]).toEqual({ checksum: initial.checksum, migrations: '2', mode: 'MONITOR_ONLY', job_chat_type: 'group', external_attachment_id: 'legacy-attachment', control_epoch: '1', queued_status: 'cancelled', running_status: 'cancelled', line_pending: 'cancelled', line_sending: 'unknown', ui_pending: 'cancelled', ui_sent: 'sent', ui_audit_rows: '2' });
      for (const migration of migrations.filter((item) => item.name > second.name)) {
        await writeFile(join(directory, migration.name), migration.sql);
      }
      await migrate(pool, directory);
      const accounts = new AccountRepository(pool);
      const agents = new AgentRepository(pool);
      expect((await pool.query("SELECT count(*) FROM schema_migrations WHERE name = '009_agent_delivery_job_route.sql'")).rows[0]?.count).toBe('1');
      await expect(pool.query(`INSERT INTO agent_deliveries
        (delivery_id, job_id, part_index, text_content, idempotency_key, account_id, chat_type, chat_id, creation_epoch)
        VALUES ('eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee', '22222222-2222-4222-8222-222222222222', 0,
          'mismatch', 'invalid-route', 'other-account', 'group', 'legacy-chat', 0)`)).rejects.toThrow();
      await expect(pool.query(`INSERT INTO agent_deliveries
        (delivery_id, job_id, part_index, text_content, idempotency_key, account_id, chat_type, chat_id, creation_epoch)
        VALUES ('ffffffff-ffff-4fff-8fff-ffffffffffff', '22222222-2222-4222-8222-222222222222', 1,
          'missing epoch', 'invalid-null-epoch', 'legacy-account', 'group', 'legacy-chat', NULL)`)).rejects.toThrow();
      await expect(pool.query(`INSERT INTO agent_deliveries
        (delivery_id, job_id, part_index, text_content, idempotency_key, account_id, chat_type, chat_id, creation_epoch)
        VALUES ('99999999-9999-4999-8999-999999999999', '22222222-2222-4222-8222-222222222222', 2,
          'stale epoch', 'invalid-stale-epoch', 'legacy-account', 'group', 'legacy-chat', 1)`)).rejects.toThrow();
      await pool.query(`INSERT INTO agent_deliveries
        (delivery_id, job_id, part_index, text_content, idempotency_key, account_id, chat_type, chat_id, creation_epoch)
        VALUES ('eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee', '44444444-4444-4444-8444-444444444444', 1,
          'ui audit', 'ui-null-epoch', 'legacy-account', 'direct', 'ui-only-route', NULL)`);
      await pool.query("UPDATE line_accounts SET product_role = 'AGENT' WHERE account_id = 'legacy-account'");
      expect((await accounts.activateControl('legacy-account', 1)).activated).toBe(true);
      expect(await agents.claimNext({ accountId: 'legacy-account', chatType: 'group', chatId: 'legacy-chat' })).toBeNull();
      expect(await agents.createLineDelivery('22222222-2222-4222-8222-222222222222', 1, ['resurrect'])).toBe(false);
      expect(await agents.claimLineDelivery('22222222-2222-4222-8222-222222222222', 0, 1)).toBeNull();
      expect(await agents.claimLineDelivery('44444444-4444-4444-8444-444444444444', 0, 1)).toBeNull();
    } finally {
      await close?.();
      await rm(directory, { recursive: true, force: true });
    }
  });
});

database('035 attachment chat-type expansion from 034', () => {
  it('preserves ready attachment data and accepts all five native chat types while rejecting unknown types', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'line-agent-attachment-chat-type-upgrade-'));
    let close: (() => Promise<void>) | undefined;
    try {
      const migrations = await loadMigrations();
      const before = migrations.filter((item) => item.name < '035_external_attachment_chat_types.sql');
      const final = migrations.find((item) => item.name === '035_external_attachment_chat_types.sql');
      expect(final).toBeDefined();
      for (const migration of before) await writeFile(join(directory, migration.name), migration.sql);
      const database = await createTestDatabase(directory);
      close = database.close;
      const { pool } = database;
      await pool.query("INSERT INTO line_accounts(account_id) VALUES ('attachment-type-account')");
      await pool.query("INSERT INTO conversations(account_id,chat_type,chat_id) VALUES ('attachment-type-account','group','legacy-chat')");
      await pool.query(`INSERT INTO messages(account_id,message_id,event_id,chat_type,chat_id,sender_id,kind,mention_ids,mention_ranges,
        ingestion_source,occurred_at,raw) VALUES ('attachment-type-account','ready-message','ready-event','group','legacy-chat',
        'sender','file','[]','[]','history','2026-10-18T00:00:00Z','{}')`);
      await pool.query(`INSERT INTO attachments(account_id,chat_type,chat_id,message_id,external_attachment_id,kind,name,status,relative_path,sha256,size_bytes)
        VALUES ('attachment-type-account','group','legacy-chat','ready-message','ready-file','file','ready.bin','ready','managed/ready.bin',$1,17)`, ['a'.repeat(64)]);
      await writeFile(join(directory, final!.name), final!.sql);
      await migrate(pool, directory);
      await migrate(pool, directory);

      for (const chatType of ['direct', 'group', 'room', 'community', 'thread']) {
        const chatId = `chat-${chatType}`;
        const messageId = `message-${chatType}`;
        await pool.query('INSERT INTO conversations(account_id,chat_type,chat_id) VALUES ($1,$2,$3)', ['attachment-type-account', chatType, chatId]);
        await pool.query(`INSERT INTO messages(account_id,message_id,event_id,chat_type,chat_id,sender_id,kind,mention_ids,mention_ranges,
          ingestion_source,occurred_at,raw) VALUES ($1,$2,$3,$4,$5,'sender','file','[]','[]','history','2026-10-18T00:00:00Z','{}')`,
        ['attachment-type-account', messageId, `event-${chatType}`, chatType, chatId]);
        await pool.query(`INSERT INTO attachments(account_id,chat_type,chat_id,message_id,external_attachment_id,kind,name,status)
          VALUES ($1,$2,$3,$4,$5,'file',$6,'queued')`, ['attachment-type-account', chatType, chatId, messageId, `file-${chatType}`, `${chatType}.bin`]);
      }
      await expect(pool.query(`INSERT INTO attachments(account_id,chat_type,chat_id,message_id,external_attachment_id,kind,name,status)
        VALUES ('attachment-type-account','unsupported','chat-community','message-community','unknown-file','file','unknown.bin','queued')`)).rejects.toThrow();
      await expect(pool.query(`SELECT chat_type,chat_id,message_id,external_attachment_id,status,relative_path,sha256,size_bytes
        FROM attachments WHERE account_id='attachment-type-account' AND external_attachment_id='ready-file'`)).resolves.toMatchObject({ rows: [
        { chat_type: 'group', chat_id: 'legacy-chat', message_id: 'ready-message', external_attachment_id: 'ready-file',
          status: 'ready', relative_path: 'managed/ready.bin', sha256: 'a'.repeat(64), size_bytes: '17' },
      ] });
      expect((await pool.query("SELECT count(*) FROM schema_migrations WHERE name='035_external_attachment_chat_types.sql'")).rows[0]?.count).toBe('1');
    } finally {
      await close?.();
      await rm(directory, { recursive: true, force: true });
    }
  });
});

database('MessageRepository with PostgreSQL (set TEST_DATABASE_URL to run)', () => {
  let pool: Pool;
  let close: () => Promise<void>;
  let repository: MessageRepository;
  beforeAll(async () => {
    ({ pool, close } = await createTestDatabase());
    repository = new MessageRepository(pool);
    const accounts = new AccountRepository(pool);
    await accounts.ensureAccount('account-A');
    await pool.query("UPDATE line_accounts SET product_role = 'AGENT' WHERE account_id = 'account-A'");
    await accounts.activateControl('account-A', (await accounts.getControlState()).controlEpoch);
  });
  afterAll(async () => { await close?.(); });

  it('leaves blank names for localized renderer fallbacks and preserves named filenames', async () => {
    const input = envelope({ accountId: `attachment-label-${randomUUID()}`, attachments: [
      { id: `image-${randomUUID()}`, kind: 'image', name: null, mimeType: 'image/jpeg', sizeBytes: 1 },
      { id: `video-${randomUUID()}`, kind: 'video', name: '  ', mimeType: 'video/mp4', sizeBytes: 1 },
      { id: `file-${randomUUID()}`, kind: 'file', name: 'report.pdf', mimeType: 'application/pdf', sizeBytes: 1 },
    ] });
    await repository.ingestAndRoute(input, { eligible: false });
    const attachments = await pool.query<{ attachment_id: string }>('SELECT attachment_id FROM attachments WHERE account_id=$1 AND message_id=$2', [input.accountId, input.messageId]);
    const states = await repository.listAttachmentStates({ accountId: input.accountId, chatType: input.chatType, chatId: input.chatId }, attachments.rows.map((row) => row.attachment_id));
    expect(states.map(({ kind, name }) => [kind, name])).toEqual([['image', ''], ['video', ''], ['file', 'report.pdf']]);
  });

  it('keeps a ready attachment readable beside a retryable failure with NULL retry_after', async () => {
    const input = envelope({ accountId: `attachment-state-null-${randomUUID()}`, attachments: [
      { id: `ready-${randomUUID()}`, kind: 'file', name: 'ready.pdf', mimeType: 'application/pdf', sizeBytes: 12 },
      { id: `retry-${randomUUID()}`, kind: 'file', name: 'retry.pdf', mimeType: 'application/pdf', sizeBytes: 8 },
    ] });
    await repository.ingestAndRoute(input, { eligible: false });
    const key = { accountId: input.accountId, chatType: input.chatType, chatId: input.chatId };
    const ready = await repository.getAttachmentBySource(key, input.messageId, input.attachments[0]!.id);
    const failed = await repository.getAttachmentBySource(key, input.messageId, input.attachments[1]!.id);
    await pool.query("UPDATE attachments SET status='ready', relative_path='safe/id-only', sha256=$2, size_bytes=12 WHERE attachment_id=$1",
      [ready!.attachmentId, 'a'.repeat(64)]);
    await pool.query("UPDATE attachments SET status='failed', retry_count=1, retry_after=NULL WHERE attachment_id=$1", [failed!.attachmentId]);

    const states = await repository.listAttachmentStates(key, [ready!.attachmentId, failed!.attachmentId], 3);

    expect(states).toEqual(expect.arrayContaining([
      expect.objectContaining({ attachmentId: ready!.attachmentId, status: 'ready', canRetryManually: false }),
      expect.objectContaining({ attachmentId: failed!.attachmentId, status: 'queued', canRetryManually: false }),
    ]));
    expect(states).toHaveLength(2);
  });

  it('allows a manual retry only while the owning LINE account is connected', async () => {
    const accountId = `attachment-connected-${randomUUID()}`;
    const input = envelope({ accountId, attachments: [{ id: `retry-${randomUUID()}`, kind: 'file', name: 'retry.pdf', mimeType: 'application/pdf', sizeBytes: 8 }] });
    await repository.ingestAndRoute(input, { eligible: false });
    const key = { accountId, chatType: input.chatType, chatId: input.chatId };
    const attachment = await repository.getAttachmentBySource(key, input.messageId, input.attachments[0]!.id);
    await pool.query("UPDATE attachments SET status='failed', retry_count=3, retry_after='infinity'::timestamptz WHERE attachment_id=$1", [attachment!.attachmentId]);
    await pool.query("UPDATE line_accounts SET status='connected' WHERE account_id=$1", [accountId]);
    await expect(repository.listAttachmentStates(key, [attachment!.attachmentId])).resolves.toMatchObject([
      { attachmentId: attachment!.attachmentId, canRetryManually: true },
    ]);
    await pool.query("UPDATE line_accounts SET status='disconnected' WHERE account_id=$1", [accountId]);
    await expect(repository.listAttachmentStates(key, [attachment!.attachmentId])).resolves.toMatchObject([
      { attachmentId: attachment!.attachmentId, canRetryManually: false },
    ]);
  });

  it('commits message, cursor, and eligible live job in one ingest', async () => {
    const input = envelope();
    const result = await repository.ingestAndRoute(input, route);
    expect(result).toMatchObject({ disposition: 'inserted', durableCursor: input.ingestion.cursor, jobId: expect.any(String) });
    const rows = await pool.query("SELECT (SELECT count(*) FROM messages WHERE account_id = $1 AND message_id = $2) AS messages, (SELECT cursor FROM sync_cursors WHERE account_id = $1 AND source = 'live') AS cursor, (SELECT count(*) FROM agent_jobs WHERE source_message_id = $2) AS jobs", [input.accountId, input.messageId]);
    expect(rows.rows[0]).toEqual({ messages: '1', cursor: input.ingestion.cursor, jobs: '1' });
  });

  it('commits an unavailable workspace prompt as a terminal failed job and event with the cursor', async () => {
    const input = envelope({ messageId: 'workspace-unavailable-message', eventId: 'workspace-unavailable-event' });
    const control = await pool.query('SELECT control_epoch FROM account_control WHERE singleton=true');
    const controlEpoch = Number(control.rows[0].control_epoch);
    const accounts = new AccountRepository(pool);
    await accounts.bindWorker({ accountId: 'account-A', workerInstanceId: 'workspace-worker', controlEpoch });
    await accounts.applyWorkerLogin({ accountId: 'account-A', workerInstanceId: 'workspace-worker', controlEpoch }, 'account-A-own-mid', 'Account A');
    await pool.query("DELETE FROM sync_cursors WHERE account_id='account-A' AND source='live'");
    const batch = {
      type: 'batch', accountId: 'account-A', workerInstanceId: 'workspace-worker', controlEpoch,
      batchId: 'workspace-unavailable-batch', cursorBefore: { version: 1, revision: '0', globalRev: '0', individualRev: '0' },
      cursorAfter: { version: 1, revision: '901', globalRev: '901', individualRev: '901' },
      envelopes: [input],
    } as Extract<import('@line-agent/contracts').LineWorkerEvent, { type: 'batch' }>;
    const decisions = [{
      eligible: false, workspaceFailure: { provider: 'codex', prompt: 'run me', workspacePath: 'D:\\missing',
        code: 'INVALID_WORKSPACE', reason: 'Configured workspace is unavailable' },
    }] as const;
    await pool.query("CREATE FUNCTION fail_workspace_event() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'forced workspace event failure'; END $$");
    await pool.query('CREATE TRIGGER fail_workspace_event BEFORE INSERT ON agent_events FOR EACH ROW EXECUTE FUNCTION fail_workspace_event()');
    await expect(repository.ingestBatchAndRoute(batch, decisions)).rejects.toThrow('forced workspace event failure');
    const rollback = await pool.query(`SELECT (SELECT count(*) FROM messages WHERE message_id=$1) messages,
      (SELECT count(*) FROM agent_jobs WHERE source_message_id=$1) jobs,
      (SELECT count(*) FROM sync_cursors WHERE account_id='account-A' AND source='live') cursors`, [input.messageId]);
    expect(rollback.rows[0]).toEqual({ messages: '1', jobs: '0', cursors: '1' });
    await pool.query('DROP TRIGGER fail_workspace_event ON agent_events');
    const result = await repository.ingestBatchAndRoute(batch, decisions);
    const replay = await repository.ingestBatchAndRoute(batch, decisions);
    expect(replay.jobIds).toEqual(result.jobIds);
    expect(result.jobMessageIds).toEqual([]);
    expect(result.jobIds).toHaveLength(1);
    const rows = await pool.query(`SELECT j.status, j.workspace_path, c.cursor,
      (SELECT count(*) FROM agent_events e WHERE e.job_id=j.job_id) AS events,
      (SELECT e.event FROM agent_events e WHERE e.job_id=j.job_id ORDER BY e.event_id LIMIT 1) AS event
      FROM agent_jobs j CROSS JOIN sync_cursors c WHERE j.source_message_id=$1 AND c.account_id=$2 AND c.source='live'`,
    ['workspace-unavailable-message', 'account-A']);
    expect(rows.rows[0]).toMatchObject({ status: 'failed', workspace_path: 'D:\\missing', events: '1',
      event: { type: 'failed', code: 'INVALID_WORKSPACE', message: 'Configured workspace is unavailable', retryable: false } });
    expect(JSON.parse(rows.rows[0].cursor).revision).toBe('901');
    expect(rows.rows).toHaveLength(1);
  });

  it('rolls back a failed enqueue and replay creates exactly one job', async () => {
    const input = envelope();
    await pool.query("CREATE FUNCTION fail_agent_job() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'forced enqueue failure'; END $$");
    await pool.query('CREATE TRIGGER fail_agent_job BEFORE INSERT ON agent_jobs FOR EACH ROW EXECUTE FUNCTION fail_agent_job()');
    await expect(repository.ingestAndRoute(input, route)).rejects.toThrow('forced enqueue failure');
    const absent = await pool.query('SELECT (SELECT count(*) FROM messages WHERE message_id = $1) AS messages, (SELECT count(*) FROM agent_jobs WHERE source_message_id = $1) AS jobs', [input.messageId]);
    expect(absent.rows[0]).toEqual({ messages: '0', jobs: '0' });
    await pool.query('DROP TRIGGER fail_agent_job ON agent_jobs');
    await pool.query('DROP FUNCTION fail_agent_job()');
    const first = await repository.ingestAndRoute(input, route);
    const replay = await repository.ingestAndRoute(input, route);
    expect(first.disposition).toBe('inserted');
    expect(replay).toMatchObject({ disposition: 'duplicate', jobId: first.jobId });
    const count = await pool.query('SELECT count(*) FROM agent_jobs WHERE source_message_id = $1', [input.messageId]);
    expect(count.rows[0].count).toBe('1');
  });

  it('does not rewind a newer cursor when an older message is replayed', async () => {
    const older = envelope();
    const newer = envelope();
    await repository.ingestAndRoute(older, { eligible: false });
    await repository.ingestAndRoute(newer, { eligible: false });
    const replay = await repository.ingestAndRoute(older, { eligible: false });
    expect(replay).toMatchObject({ disposition: 'duplicate', durableCursor: newer.ingestion.cursor });
    const changedReplay = await repository.ingestAndRoute({ ...older, ingestion: { source: 'live', cursor: 'different-stale-cursor' } }, { eligible: false });
    expect(changedReplay).toMatchObject({ disposition: 'duplicate', durableCursor: newer.ingestion.cursor });
    const cursor = await pool.query("SELECT cursor FROM sync_cursors WHERE account_id = $1 AND source = 'live'", [older.accountId]);
    expect(cursor.rows[0].cursor).toBe(newer.ingestion.cursor);
  });

  it('archives history and ineligible live messages without jobs', async () => {
    const history = envelope({ chatId: 'catch-up-history', ingestion: { source: 'history', cursor: 'history-cursor' } });
    const live = envelope();
    expect((await repository.ingestAndRoute(history, route)).jobId).toBeUndefined();
    expect((await repository.ingestAndRoute(live, { eligible: false })).jobId).toBeUndefined();
    const count = await pool.query('SELECT count(*) FROM agent_jobs WHERE source_message_id = ANY($1)', [[history.messageId, live.messageId]]);
    expect(count.rows[0].count).toBe('0');
    const historyUnread = await pool.query<{ unread_count: number }>(
      'SELECT unread_count FROM conversations WHERE account_id=$1 AND chat_type=$2 AND chat_id=$3',
      [history.accountId, history.chatType, history.chatId]);
    expect(historyUnread.rows[0]?.unread_count).toBe(0);
  });

  it('archives a live event and advances its cursor without increasing unread', async () => {
    const event = envelope({ chatId: 'event-only-chat', kind: 'event', text: null,
      ingestion: { source: 'live', cursor: 'event-cursor' }, raw: { type: 'NOTIFIED_READ_MESSAGE' } });

    const result = await repository.ingestAndRoute(event, { eligible: false });

    expect(result).toMatchObject({ disposition: 'inserted', durableCursor: 'event-cursor' });
    const state = await pool.query(
      `SELECT
         (SELECT count(*) FROM messages WHERE account_id=$1 AND message_id=$2 AND kind='event') AS archived,
         (SELECT unread_count FROM conversations WHERE account_id=$1 AND chat_type=$3 AND chat_id=$4) AS unread,
         (SELECT cursor FROM sync_cursors WHERE account_id=$1 AND source='live') AS cursor`,
      [event.accountId, event.messageId, event.chatType, event.chatId],
    );
    expect(state.rows[0]).toEqual({ archived: '1', unread: 0, cursor: 'event-cursor' });
    const visibleEvent = envelope({ accountId: 'account-A', chatId: 'event-only-chat', kind: 'event', text: null,
      raw: { message: { contentType: 6, text: null, messageRelationType: 3, relatedMessageId: 'reply-target' } } });
    await repository.ingestAndRoute(visibleEvent, { eligible: false });
    const projected = await pool.query('SELECT content,reply_to_message_id FROM messages WHERE account_id=$1 AND message_id=$2',
      [visibleEvent.accountId, visibleEvent.messageId]);
    expect(projected.rows[0]).toEqual({ content: { format: 1, type: 'event', nativeContentType: 6, text: null, call: null }, reply_to_message_id: 'reply-target' });
    expect((await repository.listMessages({ accountId: visibleEvent.accountId, chatType: 'group', chatId: 'event-only-chat' }, null, 20).then((page) => page.messages))
      .map((row) => row.messageId)).toContain(visibleEvent.messageId);
    const migration = await pool.query("SELECT data_type FROM information_schema.columns WHERE table_schema=current_schema() AND table_name='messages' AND column_name='content'");
    expect(migration.rows[0]?.data_type).toBe('jsonb');
  });

  it('archives only the redacted code placeholder and excludes the code from search', async () => {
    const rawEnvelope = envelope({ accountId: 'sanitized-code', chatType: 'direct', chatId: 'sanitized-code-chat',
      messageId: 'sanitized-code-message',
      text: 'LW-ABCDEFGH', raw: { message: { text: 'LW-ABCDEFGH', unrelated: 'private contact payload' } } });
    const sanitized = sanitizeInbound(rawEnvelope, { ownMid: 'u-self' });
    expect(sanitized.secretCandidate).toEqual({ code: 'LW-ABCDEFGH', exact: true });
    await repository.ingestAndRoute(sanitized.envelope, { eligible: false });

    const archived = await pool.query<{ text_content: string; raw: unknown }>(
      'SELECT text_content, raw FROM messages WHERE account_id=$1 AND message_id=$2',
      [rawEnvelope.accountId, rawEnvelope.messageId]);
    expect(archived.rows[0]).toEqual({ text_content: '[REDACTED_VERIFICATION_CODE]', raw: {
      message: { text: '[REDACTED_VERIFICATION_CODE]', unrelated: 'private contact payload' },
    } });
    expect(await repository.searchMessages({ accountId: rawEnvelope.accountId, text: 'LW-ABCDEFGH', limit: 10 })).toEqual([]);
    expect(await repository.searchMessages({ accountId: rawEnvelope.accountId, text: 'REDACTED_VERIFICATION_CODE', limit: 10 }))
      .toMatchObject([{ text: '[REDACTED_VERIFICATION_CODE]' }]);
  });

  it('keeps native filename codes out of the archive and attachment read model', async () => {
    const normalized = normalizeOperation({ revision: 22, message: {
      id: 'native-file-22', from: 'sender-A', to: 'u-self', contentType: 'FILE', text: 'file',
      contentMetadata: { FILE_NAME: 'report-LW-ABCDEFGH.pdf', MIME_TYPE: 'application/x-LW-ABCDEFGH', FILE_SIZE: '23' },
      createdTime: 1760522400000,
    } }, { accountId: 'sanitized-file', ownMid: 'u-self', source: 'live', cursor: 'file-cursor' });
    const sanitized = sanitizeInbound(normalized, { ownMid: 'u-self' });
    expect(sanitized.secretCandidate).toBeNull();
    await repository.ingestAndRoute(sanitized.envelope, { eligible: false });

    const archived = await pool.query<{ kind: string; text_content: string | null; raw: unknown }>(
      'SELECT kind, text_content, raw FROM messages WHERE account_id=$1 AND message_id=$2',
      [sanitized.envelope.accountId, sanitized.envelope.messageId]);
    expect(JSON.stringify(archived.rows[0])).not.toContain('LW-ABCDEFGH');
    const attachment = await repository.getAttachmentBySource({ accountId: 'sanitized-file', chatType: 'direct', chatId: 'sender-A' },
      'native-file-22', 'native-file-22');
    expect(attachment).toMatchObject({ name: 'report-[REDACTED_VERIFICATION_CODE].pdf',
      mimeType: 'application/x-[REDACTED_VERIFICATION_CODE]' });
    expect(JSON.stringify(attachment)).not.toContain('LW-ABCDEFGH');
    expect(await repository.searchMessages({ accountId: 'sanitized-file', text: 'LW-ABCDEFGH', limit: 10 })).toEqual([]);
  });

  it('returns the persisted checkpoint when a monitor event has no incoming cursor', async () => {
    const seeded = envelope({ accountId: 'monitor-cursor', ingestion: { source: 'live', cursor: 'persisted-cursor' } });
    await repository.ingestAndRoute(seeded, { eligible: false });
    const result = await repository.ingestAndRoute(envelope({ accountId: 'monitor-cursor', ingestion: { source: 'live', cursor: null } }), route);
    expect(result).toMatchObject({ disposition: 'inserted', durableCursor: 'persisted-cursor' });
    expect(result.jobId).toBeUndefined();
  });

  it('filters search by chat, sender, text and dates', async () => {
    const wanted = envelope({ chatId: 'chat-search', senderId: 'alice', text: 'distinctive kiwi', occurredAt: '2026-10-12T12:00:00.000Z' });
    await repository.ingestAndRoute(wanted, { eligible: false });
    await repository.upsertConversationCatalog('account-A', [{ chatType: 'group', chatId: 'chat-search', title: '工程群組',
      members: [{ memberId: 'alice', displayName: '王小明' }] }]);
    await repository.ingestAndRoute(envelope({ chatId: 'chat-search', senderId: 'bob', text: 'distinctive kiwi', occurredAt: '2026-10-12T12:00:00.000Z' }), { eligible: false });
    await repository.ingestAndRoute(envelope({ chatId: 'another', senderId: 'alice', text: 'distinctive kiwi', occurredAt: '2026-10-12T12:00:00.000Z' }), { eligible: false });
    const results = await repository.searchMessages({ key: { accountId: 'account-A', chatType: 'group', chatId: 'chat-search' }, senderId: 'alice', text: 'kiwi', from: '2026-10-12T00:00:00.000Z', to: '2026-10-13T00:00:00.000Z', limit: 10 });
    expect(results.map((row) => row.messageId)).toEqual([wanted.messageId]);
    expect(results[0]).toMatchObject({ senderName: '王小明', conversationTitle: '工程群組' });
  });

  it('persists attachment state transitions and metadata', async () => {
    const input = envelope({ attachments: [{ id: 'attachment-A', kind: 'image', name: 'photo.png', mimeType: 'image/png', sizeBytes: null }] });
    const storedPath = `accounts/id-${Buffer.from(input.accountId).toString('hex')}/${input.chatType}/id-${Buffer.from(input.chatId).toString('hex')}/2026/10/id-${Buffer.from(input.messageId).toString('hex')}/${createHash('sha256').update('attachment-A').digest('hex')}/photo.png`;
    await repository.ingestAndRoute(input, { eligible: false });
    const key = { accountId: input.accountId, chatType: input.chatType, chatId: input.chatId };
    const attachmentA = await repository.getAttachmentBySource(key, input.messageId, 'attachment-A');
    expect(attachmentA).toMatchObject({ status: 'queued', kind: 'image', name: 'photo.png', mimeType: 'image/png' });
    const accounts = new AccountRepository(pool);
    await accounts.bindWorker({ accountId: 'account-A', workerInstanceId: 'worker-new', controlEpoch: 1 });
    const owner = { ...key, attachmentId: attachmentA!.attachmentId, workerInstanceId: 'worker-new', controlEpoch: 1, ownerId: randomUUID() };
    await pool.query("UPDATE attachments SET created_at = now() - interval '11 seconds' WHERE attachment_id = $1", [owner.attachmentId]);
    const token = await repository.claimAttachmentDownload(owner);
    expect(token).toEqual(expect.any(String));
    expect((await repository.getAttachment(attachmentA!.attachmentId))?.status).toBe('downloading');
    const attempt = { ...owner, attemptToken: token! };
    expect(await repository.markAttachmentReady({ ...attempt, accountId: 'wrong-account' }, { relativePath: 'wrong/photo.png', sha256: 'b'.repeat(64), sizeBytes: 1 })).toBe(false);
    expect(await repository.markAttachmentReady({ ...attempt, chatType: 'room' }, { relativePath: 'wrong/photo.png', sha256: 'b'.repeat(64), sizeBytes: 1 })).toBe(false);
    expect(await repository.markAttachmentReady({ ...attempt, chatId: 'wrong-chat' }, { relativePath: 'wrong/photo.png', sha256: 'b'.repeat(64), sizeBytes: 1 })).toBe(false);
    expect(await repository.markAttachmentReady({ ...attempt, workerInstanceId: 'worker-old' }, { relativePath: 'late/photo.png', sha256: 'b'.repeat(64), sizeBytes: 1 })).toBe(false);
    expect(await repository.markAttachmentReady(attempt, { relativePath: storedPath, sha256: 'a'.repeat(64), sizeBytes: 123 })).toBe(true);
    expect(await repository.getAttachment(attachmentA!.attachmentId)).toMatchObject({ status: 'ready', relativePath: storedPath, sizeBytes: 123 });
    const inputB = envelope({ attachments: [{ id: 'attachment-B', kind: 'file', name: null, mimeType: null, sizeBytes: null }] });
    await repository.ingestAndRoute(inputB, { eligible: false });
    const attachmentB = await repository.getAttachmentBySource({ accountId: inputB.accountId, chatType: inputB.chatType, chatId: inputB.chatId }, inputB.messageId, 'attachment-B');
    await accounts.bindWorker({ accountId: 'account-A', workerInstanceId: 'worker-B', controlEpoch: 1 });
    const ownerB = { accountId: inputB.accountId, chatType: inputB.chatType, chatId: inputB.chatId, attachmentId: attachmentB!.attachmentId,
      workerInstanceId: 'worker-B', controlEpoch: 1, ownerId: randomUUID() };
    await pool.query("UPDATE attachments SET created_at = now() - interval '11 seconds' WHERE attachment_id = $1", [attachmentB!.attachmentId]);
    const tokenB = await repository.claimAttachmentDownload(ownerB);
    expect(tokenB).toEqual(expect.any(String));
    expect(await repository.markAttachmentFailed({ ...ownerB, attemptToken: tokenB! }, 'network')).toBe(true);
    expect((await repository.getAttachment(attachmentB!.attachmentId))?.status).toBe('failed');
    await pool.query("UPDATE attachments SET retry_after = now() - interval '1 second' WHERE attachment_id = $1", [attachmentB!.attachmentId]);
    const tokenB2 = await repository.claimAttachmentDownload(ownerB);
    expect(tokenB2).toEqual(expect.any(String));
    expect(await repository.markAttachmentExpired({ ...ownerB, attemptToken: tokenB2! }, 'unavailable')).toBe(true);
    expect((await repository.getAttachment(attachmentB!.attachmentId))?.status).toBe('expired');
  });

  it('enforces ten second initial eligibility, ten and twenty second retry delays, and three automatic attempts', async () => {
    const input = envelope({ accountId: 'attachment-retry-policy', attachments: [
      { id: `retry-policy-${randomUUID()}`, kind: 'file', name: null, mimeType: null, sizeBytes: null },
    ] });
    await repository.ingestAndRoute(input, { eligible: false });
    const externalId = input.attachments[0]!.id;
    const key = { accountId: input.accountId, chatType: input.chatType, chatId: input.chatId };
    const attachment = await repository.getAttachmentBySource(key, input.messageId, externalId);
    const accounts = new AccountRepository(pool); await accounts.ensureAccount(input.accountId);
    await accounts.bindWorker({ accountId: input.accountId, workerInstanceId: 'retry-worker', controlEpoch: 1 });
    const owner = { ...key, attachmentId: attachment!.attachmentId, workerInstanceId: 'retry-worker', controlEpoch: 1,
      ownerId: randomUUID() };
    expect(await repository.recoverAttachments(input.accountId)).toContain(owner.attachmentId);
    expect(await repository.recoverAttachments(input.accountId)).toContain(owner.attachmentId);
    const first = await repository.claimAttachmentDownload(owner);
    expect(first).toEqual(expect.any(String));
    expect(await repository.markAttachmentFailed({ ...owner, attemptToken: first! }, 'LINE_NATIVE_DOWNLOAD_FAILED')).toBe(true);
    const firstDelay = await pool.query<{ seconds: number }>("SELECT extract(epoch FROM retry_after - now())::float AS seconds FROM attachments WHERE attachment_id = $1", [owner.attachmentId]);
    expect(firstDelay.rows[0]!.seconds).toBeGreaterThan(8);
    expect(firstDelay.rows[0]!.seconds).toBeLessThanOrEqual(10);
    expect(await repository.recoverAttachments(input.accountId)).not.toContain(owner.attachmentId);

    await pool.query("UPDATE attachments SET retry_after = now() WHERE attachment_id = $1", [owner.attachmentId]);
    const second = await repository.claimAttachmentDownload(owner);
    expect(second).toEqual(expect.any(String));
    expect(await repository.markAttachmentFailed({ ...owner, attemptToken: second! }, 'LINE_NATIVE_DOWNLOAD_FAILED')).toBe(true);
    const secondDelay = await pool.query<{ seconds: number }>("SELECT extract(epoch FROM retry_after - now())::float AS seconds FROM attachments WHERE attachment_id = $1", [owner.attachmentId]);
    expect(secondDelay.rows[0]!.seconds).toBeGreaterThan(18);
    expect(secondDelay.rows[0]!.seconds).toBeLessThanOrEqual(20);
    await pool.query("UPDATE attachments SET retry_after = now() WHERE attachment_id = $1", [owner.attachmentId]);
    const third = await repository.claimAttachmentDownload(owner);
    expect(third).toEqual(expect.any(String));
    expect(await repository.markAttachmentFailed({ ...owner, attemptToken: third! }, 'LINE_NATIVE_DOWNLOAD_FAILED')).toBe(true);
    await pool.query("UPDATE attachments SET retry_after = now() WHERE attachment_id = $1", [owner.attachmentId]);
    expect(await repository.recoverAttachments(input.accountId)).not.toContain(owner.attachmentId);
    expect(await repository.getAttachment(owner.attachmentId)).toMatchObject({ status: 'failed', retryCount: 3, error: 'LINE_NATIVE_DOWNLOAD_FAILED' });
    expect(await repository.claimAttachmentDownload(owner)).toBeNull();
    const manual = await repository.claimAttachmentDownload(owner, { manual: true });
    expect(manual).toEqual(expect.any(String));
    expect(await repository.getAttachment(owner.attachmentId)).toMatchObject({ status: 'downloading', retryCount: 4 });
    expect(await repository.markAttachmentFailed({ ...owner, attemptToken: manual! }, 'manual failure')).toBe(true);
    await pool.query("UPDATE attachments SET retry_after = now() WHERE attachment_id = $1", [owner.attachmentId]);
    expect(await repository.recoverAttachments(input.accountId)).not.toContain(owner.attachmentId);
    expect(await repository.getAttachment(owner.attachmentId)).toMatchObject({ status: 'failed', retryCount: 4 });
  });

  it('binds configurable failure and cancellation caps independently from the worker epoch', async () => {
    const originalEpoch = await pool.query<{ control_epoch: string }>('SELECT control_epoch FROM account_control WHERE singleton=true');
    for (const [cap, epoch] of [[3, 31], [7, 47], [10, 70]] as const) {
      const accountId = `attachment-cap-${cap}-${randomUUID()}`;
      const input = envelope({ accountId, attachments: [{ id: `cap-${cap}-${randomUUID()}`, kind: 'file', name: null, mimeType: null, sizeBytes: null }] });
      await repository.ingestAndRoute(input, { eligible: false });
      const key = { accountId: input.accountId, chatType: input.chatType, chatId: input.chatId };
      const attachment = await repository.getAttachmentBySource(key, input.messageId, input.attachments[0]!.id);
      await new AccountRepository(pool).ensureAccount(accountId);
      await pool.query('UPDATE account_control SET control_epoch=$1 WHERE singleton=true', [epoch]);
      await new AccountRepository(pool).bindWorker({ accountId, workerInstanceId: `cap-worker-${cap}`, controlEpoch: epoch });
      const owner = { ...key, attachmentId: attachment!.attachmentId, workerInstanceId: `cap-worker-${cap}`, controlEpoch: epoch, ownerId: randomUUID() };
      await pool.query("UPDATE attachments SET created_at=now()-interval '11 seconds', updated_at=now()-interval '11 seconds' WHERE attachment_id=$1", [owner.attachmentId]);
      for (let attempt = 1; attempt <= cap; attempt++) {
        const token = await repository.claimAttachmentDownload(owner, { automaticAttemptLimit: cap });
        expect(token, `automatic attempt ${attempt} at cap ${cap}`).toEqual(expect.any(String));
        const failed = await repository.markAttachmentFailed({ ...owner, attemptToken: token! }, 'cap failure', cap);
        expect(failed, `failure settlement at cap ${cap}`).toBe(true);
        if (attempt < cap) await pool.query("UPDATE attachments SET retry_after=now() WHERE attachment_id=$1", [owner.attachmentId]);
      }
      expect(await repository.claimAttachmentDownload(owner, { automaticAttemptLimit: cap })).toBeNull();
      expect(await repository.getAttachment(owner.attachmentId)).toMatchObject({ status: 'failed', retryCount: cap });
      if (cap === 3) {
        await pool.query("UPDATE attachments SET updated_at=now()-interval '5 seconds' WHERE attachment_id=$1", [owner.attachmentId]);
        expect(await repository.recoverAttachments(accountId, undefined, 5)).not.toContain(owner.attachmentId);
        await pool.query("UPDATE attachments SET updated_at=now()-interval '41 seconds' WHERE attachment_id=$1", [owner.attachmentId]);
        expect(await repository.recoverAttachments(accountId, undefined, 5)).toContain(owner.attachmentId);
      }
      if (cap === 7) {
        const manual = await repository.claimAttachmentDownload(owner, { manual: true, automaticAttemptLimit: cap });
        expect(manual).toEqual(expect.any(String));
        expect(await repository.cancelAttachmentDownload({ ...owner, attemptToken: manual! }, cap)).toBe(true);
        expect(await repository.getAttachment(owner.attachmentId)).toMatchObject({ status: 'failed', retryCount: 8 });
      }
    }
    await pool.query('UPDATE account_control SET control_epoch=$1 WHERE singleton=true', [originalEpoch.rows[0]!.control_epoch]);
  });

  it('allows only exact-scope manual retry for terminal rows and restores prior state on proven pre-dispatch cancellation', async () => {
    const input = envelope({ accountId: 'attachment-manual-policy', attachments: [
      { id: `manual-policy-${randomUUID()}`, kind: 'file', name: null, mimeType: null, sizeBytes: null },
    ] });
    await repository.ingestAndRoute(input, { eligible: false });
    const externalId = input.attachments[0]!.id;
    const key = { accountId: input.accountId, chatType: input.chatType, chatId: input.chatId };
    const attachment = await repository.getAttachmentBySource(key, input.messageId, externalId);
    const accounts = new AccountRepository(pool); await accounts.ensureAccount(input.accountId);
    await accounts.bindWorker({ accountId: input.accountId, workerInstanceId: 'manual-worker', controlEpoch: 1 });
    const owner = { ...key, attachmentId: attachment!.attachmentId, workerInstanceId: 'manual-worker', controlEpoch: 1,
      ownerId: randomUUID() };
    expect(await repository.claimAttachmentDownload(owner, { manual: true })).toBeNull();

    await pool.query("UPDATE attachments SET status = 'expired', retry_count = 2, retry_after = now() + interval '3 minutes', error = 'LINE_OBS_HTTP_404' WHERE attachment_id = $1", [owner.attachmentId]);
    const prior = await repository.getAttachment(owner.attachmentId);
    expect(prior).toMatchObject({ status: 'expired', retryCount: 2 });
    const wrongScope = await repository.claimAttachmentDownload({ ...owner, chatId: 'other-chat' }, { manual: true });
    expect(wrongScope).toBeNull();
    const manual = await repository.claimAttachmentDownload(owner, { manual: true });
    expect(manual).toEqual(expect.any(String));
    expect(await repository.getAttachment(owner.attachmentId)).toMatchObject({ status: 'downloading', retryCount: 3 });
    expect(await repository.cancelAttachmentDownloadBeforeDispatch({ ...owner, attemptToken: manual! }, prior!)).toBe(true);
    expect(await repository.getAttachment(owner.attachmentId)).toMatchObject({ status: 'expired', retryCount: 2, error: 'LINE_OBS_HTTP_404' });
    const restored = await pool.query<{ retry_after: Date }>('SELECT retry_after FROM attachments WHERE attachment_id = $1', [owner.attachmentId]);
    expect(restored.rows[0]!.retry_after.toISOString()).toBe(new Date(prior!.retryAfter!).toISOString());
    const failedManual = await repository.claimAttachmentDownload(owner, { manual: true });
    expect(failedManual).toEqual(expect.any(String));
    expect(await repository.markAttachmentFailed({ ...owner, attemptToken: failedManual! }, 'ATTACHMENT_ATTEMPT_FAILED')).toBe(true);
    expect(await repository.getAttachment(owner.attachmentId)).toMatchObject({ status: 'failed', retryCount: 3 });
    expect(await repository.recoverAttachments(input.accountId)).not.toContain(owner.attachmentId);
  });

  it('chooses the earliest future wake despite overdue offline work', async () => {
    const ids: string[] = [];
    for (const suffix of ['offline-overdue', 'online-retry', 'live-lease']) {
      const input = envelope({ accountId: `wake-${suffix}`, attachments: [{ id: `${suffix}-${randomUUID()}`, kind: 'file', name: null, mimeType: null, sizeBytes: null }] });
      await repository.ingestAndRoute(input, { eligible: false });
      const row = await repository.getAttachmentBySource({ accountId: input.accountId, chatType: input.chatType, chatId: input.chatId }, input.messageId, input.attachments[0]!.id);
      ids.push(row!.attachmentId);
    }
    await pool.query("UPDATE attachments SET created_at=now()-interval '11 seconds', expires_at=now()+interval '7 days' WHERE attachment_id=$1", [ids[0]]);
    await pool.query("UPDATE attachments SET status='failed', retry_count=1, retry_after=now()+interval '10 seconds' WHERE attachment_id=$1", [ids[1]]);
    await pool.query("UPDATE attachments SET status='downloading', retry_count=1, download_lease_expires_at=now()+interval '5 seconds' WHERE attachment_id=$1", [ids[2]]);

    const wakeAt = await repository.nextAttachmentWakeAt();

    expect(wakeAt).not.toBeNull();
    expect(wakeAt!).toBeGreaterThan(Date.now());
    expect(wakeAt!).toBeLessThanOrEqual(Date.now() + 5_000);

    await pool.query("UPDATE attachments SET expires_at='infinity' WHERE attachment_id=$1", [ids[0]]);
    await pool.query("UPDATE attachments SET retry_after='infinity', expires_at='infinity' WHERE attachment_id=$1", [ids[1]]);
    await pool.query("UPDATE attachments SET download_lease_expires_at='infinity' WHERE attachment_id=$1", [ids[2]]);
    await pool.query("UPDATE attachments SET status='expired', retry_after=NULL, download_lease_expires_at=NULL WHERE attachment_id <> ALL($1::uuid[])", [ids]);
    const sentinel = await pool.query(`SELECT attachment_id, status, expires_at::text, retry_after::text, download_lease_expires_at::text
      FROM attachments WHERE attachment_id = ANY($1::uuid[]) ORDER BY status`, [ids]);
    expect(sentinel.rows.map((row) => [row.status, row.expires_at, row.retry_after, row.download_lease_expires_at])).toEqual([
      ['downloading', null, null, 'infinity'], ['failed', 'infinity', 'infinity', null], ['queued', 'infinity', null, null],
    ]);
    expect(await repository.nextAttachmentWakeAt()).toBeNull();
  });

  it('does not auto-retry a manual expired attempt recovered after a crash', async () => {
    const input = envelope({ accountId: `expired-crash-${randomUUID()}`, attachments: [
      { id: `expired-crash-${randomUUID()}`, kind: 'file', name: null, mimeType: null, sizeBytes: null },
    ] });
    await repository.ingestAndRoute(input, { eligible: false });
    const externalId = input.attachments[0]!.id;
    const key = { accountId: input.accountId, chatType: input.chatType, chatId: input.chatId };
    const attachment = await repository.getAttachmentBySource(key, input.messageId, externalId);
    await new AccountRepository(pool).ensureAccount(input.accountId);
    await new AccountRepository(pool).bindWorker({ accountId: input.accountId, workerInstanceId: 'expired-worker', controlEpoch: 1 });
    const owner = { ...key, attachmentId: attachment!.attachmentId, workerInstanceId: 'expired-worker', controlEpoch: 1,
      ownerId: randomUUID() };
    await pool.query("UPDATE attachments SET created_at=now()-interval '11 seconds' WHERE attachment_id=$1", [owner.attachmentId]);
    const automatic = await repository.claimAttachmentDownload(owner);
    expect(automatic).toEqual(expect.any(String));
    expect(await repository.markAttachmentExpired({ ...owner, attemptToken: automatic! }, 'LINE_OBS_HTTP_404')).toBe(true);

    const manual = await repository.claimAttachmentDownload(owner, { manual: true });
    expect(manual).toEqual(expect.any(String));
    expect(await repository.getAttachment(owner.attachmentId)).toMatchObject({ status: 'downloading', retryCount: 2 });
    await pool.query("UPDATE attachments SET download_lease_expires_at=now()-interval '1 second' WHERE attachment_id=$1", [owner.attachmentId]);

    expect(await repository.recoverAttachments(input.accountId)).not.toContain(owner.attachmentId);
    expect(await repository.getAttachment(owner.attachmentId)).toMatchObject({ status: 'failed', retryCount: 2 });
    expect(await repository.claimAttachmentDownload(owner)).toBeNull();
  });

  it('keeps manual-only infinity terminal across cap increases and crash recovery, then clears it on ready', async () => {
    const input = envelope({ accountId: `manual-infinity-${randomUUID()}`, attachments: [
      { id: `manual-infinity-${randomUUID()}`, kind: 'file', name: null, mimeType: null, sizeBytes: null },
    ] });
    await repository.ingestAndRoute(input, { eligible: false });
    const key = { accountId: input.accountId, chatType: input.chatType, chatId: input.chatId };
    const attachment = await repository.getAttachmentBySource(key, input.messageId, input.attachments[0]!.id);
    const accounts = new AccountRepository(pool);
    await accounts.ensureAccount(input.accountId);
    const epoch = (await accounts.getControlState()).controlEpoch;
    await accounts.bindWorker({ accountId: input.accountId, workerInstanceId: 'manual-infinity-worker', controlEpoch: epoch });
    const owner = { ...key, attachmentId: attachment!.attachmentId, workerInstanceId: 'manual-infinity-worker', controlEpoch: epoch, ownerId: randomUUID() };
    await pool.query("UPDATE attachments SET status='failed', retry_count=3, retry_after='infinity', updated_at=now() WHERE attachment_id=$1", [owner.attachmentId]);
    const manual = await repository.claimAttachmentDownload(owner, { manual: true, automaticAttemptLimit: 10 });
    expect(manual).toEqual(expect.any(String));
    await pool.query("UPDATE attachments SET download_lease_expires_at=now()-interval '1 second' WHERE attachment_id=$1", [owner.attachmentId]);
    expect(await repository.recoverAttachments(input.accountId, undefined, 10)).not.toContain(owner.attachmentId);
    expect(await repository.claimAttachmentDownload(owner, { automaticAttemptLimit: 10 })).toBeNull();
    expect(await repository.listTerminalAttachmentErrors(100, 10)).toEqual(expect.arrayContaining([
      expect.objectContaining({ accountId: input.accountId, chatId: input.chatId, status: 'failed', retryCount: 4 }),
    ]));
    const readyAttempt = await repository.claimAttachmentDownload(owner, { manual: true, automaticAttemptLimit: 10 });
    expect(readyAttempt).toEqual(expect.any(String));
    expect(await repository.markAttachmentReady({ ...owner, attemptToken: readyAttempt! },
      { relativePath: `${input.accountId}/ready.blob`, sha256: 'a'.repeat(64), sizeBytes: 1 })).toBe(true);
    const row = await pool.query<{ retry_after: string | null }>('SELECT retry_after::text FROM attachments WHERE attachment_id=$1', [owner.attachmentId]);
    expect(row.rows[0]?.retry_after).toBeNull();
  });

  it('fences late attachment results and delays a recovered attempt', async () => {
    const input = envelope({ attachments: [{ id: 'attempt-fence', kind: 'file', name: null, mimeType: null, sizeBytes: null }] });
    await repository.ingestAndRoute(input, { eligible: false });
    const key = { accountId: input.accountId, chatType: input.chatType, chatId: input.chatId };
    const attachment = await repository.getAttachmentBySource(key, input.messageId, 'attempt-fence');
    const owner = { ...key, attachmentId: attachment!.attachmentId, workerInstanceId: 'worker-current', controlEpoch: 1,
      ownerId: randomUUID() };
    await new AccountRepository(pool).bindWorker({ accountId: 'account-A', workerInstanceId: 'worker-current', controlEpoch: 1 });
    await pool.query("UPDATE attachments SET created_at = now() - interval '11 seconds' WHERE attachment_id = $1", [attachment!.attachmentId]);
    const claim = repository.claimAttachmentDownload.bind(repository) as unknown as (mutation: typeof owner) => Promise<string | null>;
    const claimOld = await claim(owner);
    expect(claimOld).toEqual(expect.any(String));
    const restarted = new MessageRepository(pool);
    expect(await restarted.recoverAttachments('account-A')).not.toContain(owner.attachmentId);
    expect(await restarted.getAttachment(owner.attachmentId)).toMatchObject({ status: 'downloading', retryCount: 1 });
    await pool.query("UPDATE attachments SET download_lease_expires_at = now() - interval '1 second' WHERE attachment_id = $1", [owner.attachmentId]);
    expect(await repository.recoverAttachments('account-A')).not.toContain(owner.attachmentId);
    expect(await repository.getAttachment(owner.attachmentId)).toMatchObject({ status: 'failed', retryCount: 1 });
    await pool.query("UPDATE attachments SET retry_after = now() WHERE attachment_id = $1", [owner.attachmentId]);
    expect(await repository.recoverAttachments('account-A')).toContain(owner.attachmentId);
    const claimNew = await claim(owner);
    expect(claimNew).toEqual(expect.any(String));
    expect(claimNew).not.toBe(claimOld);
    await pool.query('UPDATE attachments SET retry_count = 5 WHERE attachment_id = $1', [owner.attachmentId]);
    expect(await repository.recoverAttachments('account-A')).not.toContain(owner.attachmentId);
    expect(await repository.getAttachment(owner.attachmentId)).toMatchObject({ status: 'downloading' });
    const markReady = repository.markAttachmentReady.bind(repository) as unknown as (attempt: typeof owner & { attemptToken: string }, data: { relativePath: string; sha256: string; sizeBytes: number }) => Promise<boolean>;
    expect(await markReady({ ...owner, attemptToken: claimOld! }, { relativePath: 'late/old.blob', sha256: 'a'.repeat(64), sizeBytes: 1 })).toBe(false);
    expect(await markReady({ ...owner, attemptToken: claimNew!, controlEpoch: 99 }, { relativePath: 'current/new.blob', sha256: 'b'.repeat(64), sizeBytes: 2 })).toBe(true);
  });

  it('serializes attachment completion against authoritative worker rebind', async () => {
    const input = envelope({ attachments: [{ id: 'attempt-rebind-lock', kind: 'file', name: null, mimeType: null, sizeBytes: null }] });
    await repository.ingestAndRoute(input, { eligible: false });
    const key = { accountId: input.accountId, chatType: input.chatType, chatId: input.chatId };
    const attachment = await repository.getAttachmentBySource(key, input.messageId, 'attempt-rebind-lock');
    const accounts = new AccountRepository(pool);
    await accounts.bindWorker({ accountId: input.accountId, workerInstanceId: 'worker-before-rebind', controlEpoch: 1 });
    const owner = { ...key, attachmentId: attachment!.attachmentId, workerInstanceId: 'worker-before-rebind', controlEpoch: 1,
      ownerId: randomUUID() };
    await pool.query("UPDATE attachments SET created_at = now() - interval '11 seconds' WHERE attachment_id = $1", [owner.attachmentId]);
    const token = await repository.claimAttachmentDownload(owner);
    expect(token).toEqual(expect.any(String));

    const locker = await pool.connect();
    await locker.query('BEGIN');
    try {
      await locker.query("UPDATE attachments SET error = 'test row lock' WHERE attachment_id = $1", [owner.attachmentId]);
      const ready = repository.markAttachmentReady({ ...owner, attemptToken: token! },
        { relativePath: 'late/after-rebind.blob', sha256: 'c'.repeat(64), sizeBytes: 3 }).then(() => false, () => false);
      await new Promise((resolve) => setTimeout(resolve, 50));
      await accounts.bindWorker({ accountId: input.accountId, workerInstanceId: 'worker-after-rebind', controlEpoch: 1 });
      await locker.query('COMMIT');
      expect(await ready).toBe(false);
      expect(await repository.getAttachment(owner.attachmentId)).toMatchObject({ status: 'downloading' });
    } finally {
      await locker.query('ROLLBACK').catch(() => undefined);
      locker.release();
    }
  });

  it('bounds attachment transaction connection acquisition when the pool is exhausted', async () => {
    const maximum = pool.options.max ?? 10;
    const held: PoolClient[] = [];
    let settled = 0;
    try {
      for (let index = 0; index < maximum; index++) held.push(await pool.connect());
      const attempts = Array.from({ length: 100 }, () => repository.revokeAttachmentOwner(randomUUID()).then(() => { settled += 1; }, () => { settled += 1; }));
      await new Promise((resolve) => setTimeout(resolve, 650));
      expect(settled).toBe(100);
      expect(pool.waitingCount).toBeLessThanOrEqual(4);
      const released = held.splice(0);
      released.forEach((client) => client.release());
      await Promise.all(attempts);
      expect(pool.waitingCount).toBe(0);
    } finally { held.forEach((client) => client.release()); }
  });

  it('pages one attachment per account so 256 offline accounts cannot starve the next account', async () => {
    const prefix = `fair-${randomUUID().replaceAll('-', '')}`;
    const online = `${prefix}-zzz-online`;
    await pool.query(`INSERT INTO line_accounts(account_id) SELECT $1 || '-' || lpad(i::text, 3, '0') FROM generate_series(0,255) i
      UNION ALL SELECT $2`, [prefix, online]);
    await pool.query(`INSERT INTO conversations(account_id, chat_type, chat_id) SELECT account_id, 'group', 'chat'
      FROM line_accounts WHERE account_id LIKE $1 || '-%'`, [prefix]);
    await pool.query(`INSERT INTO messages(account_id, message_id, event_id, chat_type, chat_id, sender_id, kind, ingestion_source, occurred_at, raw)
      SELECT account_id, 'message', 'event-' || account_id, 'group', 'chat', 'sender', 'file', 'live', now(), '{}'::jsonb
      FROM line_accounts WHERE account_id LIKE $1 || '-%'`, [prefix]);
    await pool.query(`INSERT INTO attachments(external_attachment_id, account_id, message_id, chat_type, chat_id, kind, created_at)
      SELECT 'external', account_id, 'message', 'group', 'chat', 'file', now() - interval '11 seconds'
      FROM line_accounts WHERE account_id LIKE $1 || '-%'`, [prefix]);
    let cursor: string | null = null;
    let found = false;
    for (let pageNumber = 0; pageNumber < 18 && !found; pageNumber += 1) {
      const page = await repository.recoverAttachmentPage(cursor, 16);
      found = page.items.some((item) => item.accountId === online);
      cursor = page.hasMore ? page.items.at(-1)?.accountId ?? null : null;
      if (!page.hasMore) break;
    }
    expect(found).toBe(true);
  });

  it('returns recent external-monitor attachments with native envelopes in newest-first order regardless of download status', async () => {
    const accountId = 'probe-account';
    const now = Date.now();
    const nativePayload = {
      format: 1 as const,
      table: '_message' as const,
      sourceDigest: 'd'.repeat(64),
      encoding: 'dpapi' as const,
      data: 'AQID',
    };
    const olderEvent = {
      ...envelope({
        accountId,
        messageId: 'msg-older',
        eventId: 'evt-older',
        occurredAt: new Date(now - 60_000).toISOString(),
        attachments: [{ id: 'att-older-ready', kind: 'file', name: 'older.bin', mimeType: null, sizeBytes: 12 }],
      }),
      raw: { native: nativePayload },
    };
    const newerEvent = {
      ...envelope({
        accountId,
        messageId: 'msg-newer',
        eventId: 'evt-newer',
        occurredAt: new Date(now - 5_000).toISOString(),
        attachments: [{ id: 'att-newer-pending', kind: 'image', name: 'newer.png', mimeType: 'image/png', sizeBytes: 24 }],
      }),
      raw: { native: nativePayload },
    };
    const liveEvent = envelope({
      accountId,
      messageId: 'msg-live',
      eventId: 'evt-live',
      occurredAt: new Date(now - 1_000).toISOString(),
      attachments: [{ id: 'att-live', kind: 'file', name: 'live.bin', mimeType: null, sizeBytes: 8 }],
    });
    await repository.ingestAndRoute(olderEvent, { eligible: false });
    await repository.ingestAndRoute(newerEvent, { eligible: false });
    await repository.ingestAndRoute(liveEvent, { eligible: false });
    const sourceId = randomUUID();
    const staleEvent = {
      ...envelope({
        accountId,
        messageId: 'msg-stale',
        eventId: 'evt-stale',
        occurredAt: new Date(now - 8 * 24 * 60 * 60 * 1_000).toISOString(),
        attachments: [{ id: 'att-stale', kind: 'file', name: 'stale.bin', mimeType: null, sizeBytes: 3 }],
      }),
      raw: { native: nativePayload },
    };
    await repository.ingestAndRoute(staleEvent, { eligible: false });
    await pool.query(
      `INSERT INTO line_account_sources(account_id, source_id, generation, source_type, state, identity_digest, verified_account_mid)
       VALUES ($1, $2, 1, 'EXTERNAL_MONITOR', 'ACTIVE', repeat('a', 64), 'own-probe')`,
      [accountId, sourceId],
    );
    await pool.query(
      `INSERT INTO external_source_batches(source_id,account_id,generation,batch_id,payload_digest,result)
       VALUES ($1,$2,1,'probe-batch',repeat('b',64),'{}'::jsonb)`, [sourceId, accountId]);
    await pool.query(
      `INSERT INTO external_source_observations(source_id,account_id,generation,observation_id,batch_id,canonical_message_id,normalized_digest,normalized_payload,status)
       SELECT $1,$2,1,o.obs,'probe-batch',o.msg,repeat('c',64),'{}'::jsonb,'PROJECTED'
       FROM (VALUES ('obs-older','msg-older'),('obs-newer','msg-newer'),('obs-stale','msg-stale')) AS o(obs,msg)`, [sourceId, accountId]);
    await pool.query(
      `INSERT INTO message_source_provenance(account_id, message_id, source_id, generation, observation_id, origin, redacted)
       VALUES ($1, 'msg-older', $2, 1, 'obs-older', 'EXTERNAL_MONITOR', true),
              ($1, 'msg-newer', $2, 1, 'obs-newer', 'EXTERNAL_MONITOR', true),
              ($1, 'msg-stale', $2, 1, 'obs-stale', 'EXTERNAL_MONITOR', true)`,
      [accountId, sourceId],
    );
    await pool.query("UPDATE attachments SET status = 'ready', relative_path = 'safe/older', sha256 = repeat('d', 64) WHERE external_attachment_id = 'att-older-ready'");

    const probes = await repository.getRecentExternalAttachmentsForDownloadProbe(accountId, 5);
    expect(probes.map((item) => item.externalAttachmentId)).toEqual(['att-newer-pending', 'att-older-ready']);
    expect(await repository.getRecentExternalAttachmentsForDownloadProbe(accountId, 0)).toHaveLength(1);
    expect(await repository.getRecentExternalAttachmentsForDownloadProbe(accountId, 1000)).toHaveLength(2);
    await pool.query("INSERT INTO conversations(account_id, chat_id, chat_type) VALUES ($1,'community-chat','community')", [accountId]);
    await pool.query(`INSERT INTO messages(account_id,message_id,event_id,chat_type,chat_id,sender_id,kind,ingestion_source,occurred_at,raw)
      VALUES ($1,'msg-community','evt-community','community','community-chat','person','file','live',now(),$2::jsonb)`,
    [accountId, JSON.stringify({ native: nativePayload })]);
    await pool.query(`INSERT INTO attachments(external_attachment_id, account_id, message_id, chat_type, chat_id, kind)
      VALUES ('att-community',$1,'msg-community','community','community-chat','file')`, [accountId]);
    await pool.query(`INSERT INTO external_source_observations(source_id,account_id,generation,observation_id,batch_id,canonical_message_id,normalized_digest,normalized_payload,status)
      VALUES ($1,$2,1,'obs-community','probe-batch','msg-community',repeat('c',64),'{}'::jsonb,'PROJECTED')`, [sourceId, accountId]);
    await pool.query(`INSERT INTO message_source_provenance(account_id,message_id,source_id,generation,observation_id,origin,redacted)
      VALUES ($1,'msg-community',$2,1,'obs-community','EXTERNAL_MONITOR',true)`, [accountId, sourceId]);
    expect((await repository.getRecentExternalAttachmentsForDownloadProbe(accountId, 5)).map((item) => item.externalAttachmentId))
      .toEqual(['att-newer-pending', 'att-older-ready']);
    expect(await repository.getRecentExternalAttachmentsForDownloadProbe(accountId, Number.NaN)).toHaveLength(2);
    expect(probes[0]?.nativePayload).toEqual(nativePayload);
    expect(probes[1]?.status).toBe('ready');
  });

  it('reapplies migrations safely and rejects changed history', async () => {
    await migrate(pool);
    const rows = await pool.query('SELECT count(*) FROM schema_migrations');
    expect(rows.rows[0].count).toBe(String((await loadMigrations()).length));
    const headIndexMigration = await pool.query("SELECT count(*) FROM schema_migrations WHERE name = '013_agent_queue_head_index.sql'");
    expect(headIndexMigration.rows[0].count).toBe('1');
    await pool.query("UPDATE schema_migrations SET checksum = 'corrupt' WHERE name = '001_initial.sql'");
    await expect(migrate(pool)).rejects.toThrow('Migration checksum mismatch');
  });
});
