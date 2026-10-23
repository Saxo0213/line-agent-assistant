import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Pool } from 'pg';

const defaultDirectory = fileURLToPath(new URL('../migrations/', import.meta.url));

function canonicalSql(sql: string): string {
  return sql.replace(/\r\n/g, '\n');
}

function checksum(sql: string): string {
  return createHash('sha256').update(sql).digest('hex');
}

export async function loadMigrations(directory = defaultDirectory): Promise<Array<{ name: string; sql: string; checksum: string }>> {
  const files = (await readdir(directory)).filter((name) => /^\d+_.*\.sql$/.test(name)).sort();
  return Promise.all(files.map(async (name) => {
    const sql = await readFile(join(directory, name), 'utf8');
    if (/\r(?!\n)/.test(sql)) throw new Error(`Invalid standalone carriage return in migration: ${name}`);
    return { name, sql, checksum: checksum(canonicalSql(sql)) };
  }));
}

export async function migrate(pool: Pool, directory = defaultDirectory): Promise<void> {
  const migrations = await loadMigrations(directory);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query("SELECT pg_advisory_xact_lock(hashtext(current_schema()), hashtext('line_agent_migrations'))");
    await client.query('CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, checksum text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now())');
    for (const { name, sql, checksum } of migrations) {
      const prior = await client.query<{ checksum: string }>('SELECT checksum FROM schema_migrations WHERE name = $1', [name]);
      if (prior.rowCount) {
        const legacyCrLfChecksum = checksumForCrLf(canonicalSql(sql));
        if (prior.rows[0]?.checksum !== checksum && prior.rows[0]?.checksum !== legacyCrLfChecksum) {
          throw new Error(`Migration checksum mismatch: ${name}`);
        }
        continue;
      }
      await client.query(sql);
      await client.query('INSERT INTO schema_migrations (name, checksum) VALUES ($1, $2)', [name, checksum]);
    }
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

function checksumForCrLf(sql: string): string {
  return checksum(sql.replace(/\n/g, '\r\n'));
}
