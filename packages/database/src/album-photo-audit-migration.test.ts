import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { loadMigrations, migrate } from './migrate.js';
import { createTestDatabase } from './test-database.js';
import { AuditRepository } from './audit-repository.js';

const migrationDirectory = fileURLToPath(new URL('../migrations/', import.meta.url));
const temporaryDirectories: string[] = [];
const database = process.env.TEST_DATABASE_URL ? describe : describe.skip;

async function copyMigrationsThrough058(): Promise<string> {
  const target = await mkdtemp(join(tmpdir(), 'line-agent-logging-058-'));
  temporaryDirectories.push(target);
  const files = (await readdir(migrationDirectory)).filter((name) => /^\d+_.*\.sql$/.test(name) && name < '059_');
  for (const name of files) {
    await writeFile(join(target, name), await readFile(join(migrationDirectory, name)));
  }
  return target;
}

async function expectAuditActions(pool: Pool): Promise<void> {
  const audit = new AuditRepository(pool);
  await audit.append({ action: 'album_photo_download', phase: 'succeeded', initiator: 'user',
    correlationId: 'album-success-1', accountId: 'account-a', requestId: 'album-success-1',
    createdAt: '2026-10-24T10:00:00.000Z' });
  await audit.append({ action: 'album_photo_download', phase: 'failed', initiator: 'user',
    correlationId: 'album-failure-1', accountId: 'account-a', requestId: 'album-failure-1',
    errorCode: 'CHAT_RESOURCE_READ_FAILED', createdAt: '2026-10-24T10:00:01.000Z' });

  await pool.query(`INSERT INTO audit_logs(action, actor, details) VALUES
    ('runtime_error', 'system', '{"phase":"observed","correlation_id":"runtime-error-1","diagnostic":{"operation":"database","stage":"write","category":"persistence_failed","recovery":"retry","outcome":"failed","statusCode":500}}'),
    ('friend_enrollment', 'user', '{"phase":"requested","correlation_id":"previous-action-1"}'),
    ('worker_operation_error', 'worker', '{"phase":"observed","correlation_id":"previous-action-2","error_code":"HISTORY_READ_FAILED"}')`);

  const rows = await pool.query<{ action: string; phase: string }>(
    "SELECT action, details->>'phase' AS phase FROM audit_logs ORDER BY created_at, audit_id");
  expect(rows.rows.map(({ action, phase }) => [action, phase])).toEqual([
    ['album_photo_download', 'succeeded'], ['album_photo_download', 'failed'],
    ['runtime_error', 'observed'], ['friend_enrollment', 'requested'], ['worker_operation_error', 'observed'],
  ]);
  await expect(pool.query(`INSERT INTO audit_logs(action, actor, details) VALUES
    ('runtime_error', 'system', '{"phase":"observed","correlation_id":"bad-diagnostic-1","diagnostic":{"operation":"database","stage":"write","category":"unknown","recovery":"none","unsafe":"private"}}')`))
    .rejects.toThrow();
  await expect(pool.query(`INSERT INTO audit_logs(action, actor, details) VALUES
    ('album_photo_download', 'user', '{"phase":"requested","correlation_id":"bad-top-level-1","token":"private"}')`))
    .rejects.toThrow('unsupported fields');
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

database('album photo audit migration', () => {
  it('supports fresh install and idempotent migration reruns', async () => {
    const { pool, close } = await createTestDatabase();
    try {
      await migrate(pool);
      await migrate(pool);
      await expectAuditActions(pool);
    } finally { await close(); }
  });

  it('upgrades a database already migrated through logging 058', async () => {
    const through058 = await copyMigrationsThrough058();
    const { pool, close } = await createTestDatabase(through058);
    try {
      const priorChecksum = await pool.query<{ checksum: string }>(
        "SELECT checksum FROM schema_migrations WHERE name = '058_operational_diagnostics.sql'");
      const loggingMigration = (await loadMigrations(through058)).find(({ name }) => name === '058_operational_diagnostics.sql');
      expect(priorChecksum.rows[0]?.checksum).toBe(loggingMigration?.checksum);
      await migrate(pool);
      await migrate(pool);
      const afterChecksum = await pool.query<{ checksum: string }>(
        "SELECT checksum FROM schema_migrations WHERE name = '058_operational_diagnostics.sql'");
      expect(afterChecksum.rows[0]?.checksum).toBe(priorChecksum.rows[0]?.checksum);
      await expectAuditActions(pool);
    } finally { await close(); }
  });

  it('rolls back a failed 059 application and preserves the logging validator', async () => {
    const through058 = await copyMigrationsThrough058();
    const failedDirectory = await mkdtemp(join(tmpdir(), 'line-agent-failed-059-'));
    temporaryDirectories.push(failedDirectory);
    const albumMigration = await readFile(join(migrationDirectory, '059_album_photo_activity.sql'), 'utf8');
    await writeFile(join(failedDirectory, '059_album_photo_activity.sql'), `${albumMigration}\nTHIS IS NOT VALID SQL;\n`);

    const url = process.env.TEST_DATABASE_URL!;
    const schema = `test_album_migration_${Math.random().toString(16).slice(2)}`;
    const admin = new Pool({ connectionString: url });
    await admin.query(`CREATE SCHEMA "${schema}"`);
    const pool = new Pool({ connectionString: url, options: `-c search_path=${schema}` });
    try {
      await migrate(pool, through058);
      const priorChecksum = await pool.query<{ checksum: string }>(
        "SELECT checksum FROM schema_migrations WHERE name = '058_operational_diagnostics.sql'");
      await expect(migrate(pool, failedDirectory)).rejects.toThrow();
      const afterChecksum = await pool.query<{ checksum: string }>(
        "SELECT checksum FROM schema_migrations WHERE name = '058_operational_diagnostics.sql'");
      expect(afterChecksum.rows[0]?.checksum).toBe(priorChecksum.rows[0]?.checksum);
      await pool.query(`INSERT INTO audit_logs(action, actor, details) VALUES
        ('runtime_error', 'system', '{"phase":"observed","correlation_id":"rollback-runtime-1","diagnostic":{"operation":"database","stage":"write","category":"persistence_failed","recovery":"retry","outcome":"failed"}}')`);
      await expect(pool.query(`INSERT INTO audit_logs(action, actor, details) VALUES
        ('album_photo_download', 'user', '{"phase":"succeeded","correlation_id":"rollback-album-1"}')`))
        .rejects.toThrow('invalid audit action');
      const applied = await pool.query("SELECT name FROM schema_migrations WHERE name = '059_album_photo_activity.sql'");
      expect(applied.rowCount).toBe(0);
    } finally {
      await pool.end();
      await admin.query(`DROP SCHEMA "${schema}" CASCADE`);
      await admin.end();
    }
  });
});
