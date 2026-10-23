import { Pool } from 'pg';

export const DEFAULT_DB_CONNECTION_TIMEOUT_MS = 1_500;

export function createPool(connectionString = process.env.DATABASE_URL): Pool {
  if (!connectionString) throw new Error('DATABASE_URL is required');
  return new Pool({
    connectionString,
    connectionTimeoutMillis: DEFAULT_DB_CONNECTION_TIMEOUT_MS,
  });
}
