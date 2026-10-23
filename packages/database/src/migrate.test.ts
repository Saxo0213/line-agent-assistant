import { createHash } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { Pool } from 'pg';
import { loadMigrations, migrate } from './migrate.js';

const temporaryDirectories: string[] = [];

async function migrationDirectory(sql: string): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'line-agent-migration-checksum-'));
  temporaryDirectories.push(directory);
  await writeFile(join(directory, '001_initial.sql'), sql, 'utf8');
  return directory;
}

function checksum(sql: string): string {
  return createHash('sha256').update(sql).digest('hex');
}

function migrationPool(priorChecksum: string | null = null) {
  let recordedChecksum = priorChecksum;
  const insertedChecksums: string[] = [];
  const client = {
    async query(sql: string, parameters: unknown[] = []) {
      if (sql.startsWith('SELECT checksum FROM schema_migrations')) {
        return { rows: recordedChecksum === null ? [] : [{ checksum: recordedChecksum }], rowCount: recordedChecksum === null ? 0 : 1 };
      }
      if (sql.startsWith('INSERT INTO schema_migrations')) {
        const inserted = String(parameters[1]);
        insertedChecksums.push(inserted);
        recordedChecksum = inserted;
      }
      return { rows: [], rowCount: 0 };
    },
    release() {},
  };
  const pool = { async connect() { return client; } };
  return { pool: pool as unknown as Pool, insertedChecksums };
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe('migration checksums', () => {
  it.each([
    { fileSql: 'SELECT 1;\r\n', recordedSql: 'SELECT 1;\n' },
    { fileSql: 'SELECT 1;\n', recordedSql: 'SELECT 1;\r\n' },
  ])('accepts existing LF/CRLF checksum variants', async ({ fileSql, recordedSql }) => {
    const directory = await migrationDirectory(fileSql);
    const { pool } = migrationPool(checksum(recordedSql));

    await expect(migrate(pool, directory)).resolves.toBeUndefined();
  });

  it('rejects a checksum for SQL with a real content change', async () => {
    const directory = await migrationDirectory('SELECT 2;\r\n');
    const { pool } = migrationPool(checksum('SELECT 1;\n'));

    await expect(migrate(pool, directory)).rejects.toThrow('Migration checksum mismatch: 001_initial.sql');
  });

  it.each([
    { fileSql: 'SELECT 1;\r\r\n', recordedSql: 'SELECT 1;\r\n' },
    { fileSql: 'SELECT 1;\r', recordedSql: 'SELECT 1;\r' },
  ])('rejects standalone CR before checksum compatibility', async ({ fileSql, recordedSql }) => {
    const directory = await migrationDirectory(fileSql);
    const { pool } = migrationPool(checksum(recordedSql));

    await expect(migrate(pool, directory)).rejects.toThrow('Invalid standalone carriage return in migration: 001_initial.sql');
  });

  it('does not accept a mixed-EOL checksum as a legacy variant', async () => {
    const directory = await migrationDirectory('SELECT 1;\r\nSELECT 2;\n');
    const { pool } = migrationPool(checksum('SELECT 1;\r\nSELECT 2;\n'));

    await expect(migrate(pool, directory)).rejects.toThrow('Migration checksum mismatch: 001_initial.sql');
  });

  it('records a canonical LF checksum for new migrations', async () => {
    const directory = await migrationDirectory('SELECT 1;\r\n');
    const { pool, insertedChecksums } = migrationPool();

    await migrate(pool, directory);

    await expect(loadMigrations(directory)).resolves.toEqual([
      { name: '001_initial.sql', sql: 'SELECT 1;\r\n', checksum: checksum('SELECT 1;\n') },
    ]);
    expect(insertedChecksums).toEqual([checksum('SELECT 1;\n')]);
  });
});
