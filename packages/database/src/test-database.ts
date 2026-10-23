import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { migrate } from './migrate.js';

export async function createTestDatabase(migrationDirectory?: string): Promise<{ pool: Pool; close: () => Promise<void> }> {
  const url = process.env.TEST_DATABASE_URL;
  if (!url) throw new Error('TEST_DATABASE_URL is required');
  const schema = `test_${randomUUID().replaceAll('-', '')}`;
  const admin = new Pool({ connectionString: url });
  await admin.query(`CREATE SCHEMA "${schema}"`);
  const pool = new Pool({ connectionString: url, options: `-c search_path=${schema}` });
  try {
    await migrate(pool, migrationDirectory);
  } catch (error) {
    await pool.end();
    await admin.query(`DROP SCHEMA "${schema}" CASCADE`);
    await admin.end();
    throw error;
  }
  return {
    pool,
    close: async () => {
      await pool.end();
      await admin.query(`DROP SCHEMA "${schema}" CASCADE`);
      await admin.end();
    },
  };
}
