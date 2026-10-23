import { isAbsolute } from 'node:path';
import type { DatabaseConnectionInput, DatabaseSetupStatus } from '../../setup-protocol.js';
import type { BootstrapConfiguration } from './bootstrap-settings.js';
import { validateWorkspace } from './workspace-authority.js';

type QueryResult = { rows: Array<Record<string, unknown>> };
type SetupPool = { query(sql: string, parameters?: unknown[]): Promise<QueryResult>; end(): Promise<void> };

type Dependencies = {
  createPool(url: string): SetupPool;
  migrate(pool: SetupPool, directory: string): Promise<void>;
  save(configuration: BootstrapConfiguration): Promise<void>;
  ensureDirectory(path: string): Promise<unknown>;
  migrationDirectory: string;
  load?: () => Promise<BootstrapConfiguration | null>;
  defaultAttachmentRoot?: string;
  defaultAgentWorkspace?: string;
};

function databaseName(value: string): string {
  if (!/^[A-Za-z][A-Za-z0-9_-]{0,62}$/.test(value)) throw new Error('Invalid database name');
  return value;
}

export function buildDatabaseUrl(connection: DatabaseConnectionInput, database: string): string {
  const url = new URL('postgresql://localhost');
  url.hostname = connection.host;
  url.port = String(connection.port);
  url.username = connection.username;
  url.password = connection.password;
  url.pathname = `/${databaseName(database)}`;
  url.searchParams.set('sslmode', connection.ssl);
  return url.toString();
}

export class DatabaseSetupService {
  constructor(private readonly dependencies: Dependencies) {}

  async status(): Promise<DatabaseSetupStatus> {
    const configuration = await this.dependencies.load?.() ?? null;
    if (!configuration) return { configured: false, attachmentRoot: this.dependencies.defaultAttachmentRoot ?? null,
      agentWorkspace: this.dependencies.defaultAgentWorkspace ?? null, connection: null };
    const url = new URL(configuration.databaseUrl);
    let agentWorkspace = this.dependencies.defaultAgentWorkspace ?? null;
    const pool = this.dependencies.createPool(configuration.databaseUrl);
    try {
      const result = await pool.query("SELECT value FROM app_settings WHERE key='workspace_path'");
      if (typeof result.rows[0]?.value === 'string') agentWorkspace = result.rows[0].value;
    } catch { /* keep the safe application-owned default while the database is unavailable */ }
    finally { await pool.end(); }
    return { configured: true, attachmentRoot: configuration.attachmentRoot, connection: {
      host: url.hostname, port: Number(url.port || 5432), username: decodeURIComponent(url.username),
      ssl: url.searchParams.get('sslmode') === 'require' ? 'require' : 'disable',
      database: decodeURIComponent(url.pathname.slice(1)),
    }, agentWorkspace, ...(configuration.embedded ? { embedded: configuration.embedded } : {}) };
  }

  async listDatabases(connection: DatabaseConnectionInput): Promise<string[]> {
    const pool = this.dependencies.createPool(buildDatabaseUrl(connection, 'postgres'));
    try {
      const result = await pool.query("SELECT datname FROM pg_database WHERE datallowconn AND NOT datistemplate ORDER BY datname");
      return result.rows.map((row) => String(row.datname));
    } finally { await pool.end(); }
  }

  async createDatabase(connection: DatabaseConnectionInput, requestedName: string): Promise<string[]> {
    const name = databaseName(requestedName);
    const pool = this.dependencies.createPool(buildDatabaseUrl(connection, 'postgres'));
    try {
      await pool.query(`CREATE DATABASE "${name}"`);
      const result = await pool.query("SELECT datname FROM pg_database WHERE datallowconn AND NOT datistemplate ORDER BY datname");
      return result.rows.map((row) => String(row.datname));
    } finally { await pool.end(); }
  }

  async saveConfiguration(connection: DatabaseConnectionInput, selectedDatabase: string, attachmentRoot: string, agentWorkspace: string): Promise<void> {
    if (!isAbsolute(attachmentRoot) || !isAbsolute(agentWorkspace)) throw new Error('Managed folders must be absolute paths');
    await this.persist(buildDatabaseUrl(connection, selectedDatabase), attachmentRoot, agentWorkspace);
  }

  /** Step 3 of the automatic flow: the embedded server was provisioned and saved earlier; add folders and migrate. */
  async saveEmbeddedConfiguration(attachmentRoot: string, agentWorkspace: string): Promise<void> {
    if (!isAbsolute(attachmentRoot) || !isAbsolute(agentWorkspace)) throw new Error('Managed folders must be absolute paths');
    const configuration = await this.dependencies.load?.() ?? null;
    if (!configuration?.embedded) throw new Error('Embedded PostgreSQL is not provisioned');
    await this.persist(configuration.databaseUrl, attachmentRoot, agentWorkspace, configuration.embedded);
  }

  private async persist(databaseUrl: string, attachmentRoot: string, agentWorkspace: string, embedded?: BootstrapConfiguration['embedded']): Promise<void> {
    const pool = this.dependencies.createPool(databaseUrl);
    try {
      await pool.query('SELECT 1 AS ok');
      await this.dependencies.ensureDirectory(attachmentRoot);
      await this.dependencies.ensureDirectory(agentWorkspace);
      const canonicalAgentWorkspace = await validateWorkspace(agentWorkspace);
      await this.dependencies.migrate(pool, this.dependencies.migrationDirectory);
      await pool.query("INSERT INTO app_settings(key,value) VALUES ('workspace_path',$1::jsonb) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
        [JSON.stringify(canonicalAgentWorkspace)]);
      await this.dependencies.save({ databaseUrl, attachmentRoot, ...(embedded ? { embedded } : {}) });
    } finally { await pool.end(); }
  }
}
