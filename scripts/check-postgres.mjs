import pg from 'pg';

const connectionString = process.env.LINE_AGENT_PREREQ_DATABASE_URL;
if (!connectionString) process.exit(2);
const client = new pg.Client({ connectionString, connectionTimeoutMillis: 5_000 });
try {
  await client.connect();
  const result = await client.query('SELECT 1 AS ready');
  if (result.rows[0]?.ready !== 1) process.exitCode = 1;
} catch {
  process.exitCode = 1;
} finally {
  await client.end().catch(() => undefined);
}
