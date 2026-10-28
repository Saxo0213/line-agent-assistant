import { randomUUID } from 'node:crypto';
import {
  AGENT_MCP_MAX_SERVERS, AGENT_MCP_SECRET_MASK, AgentExtensionToolsSchema, AgentMcpServerDefinitionSchema, AgentMcpServerInputSchema,
  DEFAULT_AGENT_EXTENSION_TOOLS,
  type AgentExtensionTools, type AgentMcpServerDefinition, type AgentMcpServerInput, type AgentMcpServerSummary, type AgentMcpSource, type AgentRunExtensions,
} from '@line-agent/contracts';
import type { Pool } from 'pg';

export const AGENT_EXTENSION_TOOLS_KEY = 'agent_extension_tools';

/** Seals and opens secret text. Main supplies an OS-bound implementation (Windows DPAPI); tests supply a fake. */
export interface SecretCodec {
  seal(plain: string): Promise<string>;
  open(sealed: string): Promise<string>;
}

export type AgentExtensionsErrorCode = 'NAME_TAKEN' | 'NOT_FOUND' | 'LIMIT' | 'INVALID';
export class AgentExtensionsError extends Error {
  constructor(public readonly code: AgentExtensionsErrorCode, message: string) { super(message); this.name = 'AgentExtensionsError'; }
}

interface Row {
  id: string; name: string; transport: 'stdio' | 'http'; command: string | null; args: string[]; url: string | null;
  env_keys: string[]; header_keys: string[]; secrets_cipher: string | null; enabled: boolean; source: AgentMcpSource; providers: ('claude' | 'codex')[];
}
interface Secrets { env: Record<string, string>; headers: Record<string, string> }
const COLUMNS = 'id, name, transport, command, args, url, env_keys, header_keys, secrets_cipher, enabled, source, providers';

const mask = (keys: string[]): Record<string, typeof AGENT_MCP_SECRET_MASK> => Object.fromEntries(keys.map((key) => [key, AGENT_MCP_SECRET_MASK]));
function summarize(row: Row): AgentMcpServerSummary {
  return {
    id: row.id, name: row.name, transport: row.transport, ...(row.command === null ? {} : { command: row.command }), args: row.args,
    env: mask(row.env_keys), ...(row.url === null ? {} : { url: row.url }), headers: mask(row.header_keys),
    enabled: row.enabled, source: row.source, providers: row.providers,
  };
}

export class AgentExtensionsRepository {
  constructor(private readonly pool: Pool, private readonly codec: SecretCodec) {}

  async list(): Promise<AgentMcpServerSummary[]> {
    const result = await this.pool.query<Row>(`SELECT ${COLUMNS} FROM agent_mcp_servers ORDER BY name`);
    return result.rows.map(summarize);
  }

  async names(): Promise<Set<string>> {
    const result = await this.pool.query<{ name: string }>('SELECT name FROM agent_mcp_servers');
    return new Set(result.rows.map((row) => row.name));
  }

  /** Creates a server (no `id`) or edits one (`id`). On edit, an empty env/header value keeps the stored value. */
  async save(rawInput: AgentMcpServerInput, source: AgentMcpSource = 'manual'): Promise<AgentMcpServerSummary> {
    const parsed = AgentMcpServerInputSchema.safeParse(rawInput);
    if (!parsed.success) throw new AgentExtensionsError('INVALID', 'The MCP server definition is invalid.');
    const input = parsed.data;
    if (input.id) return this.update(input.id, input);
    const count = Number((await this.pool.query<{ count: string }>('SELECT count(*) FROM agent_mcp_servers')).rows[0]?.count ?? 0);
    if (count >= AGENT_MCP_MAX_SERVERS) throw new AgentExtensionsError('LIMIT', 'Too many MCP servers.');
    const secrets: Secrets = { env: input.env, headers: input.headers };
    const id = randomUUID();
    try {
      const result = await this.pool.query<Row>(
        `INSERT INTO agent_mcp_servers (id, name, transport, command, args, url, env_keys, header_keys, secrets_cipher, enabled, source, providers)
         VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7::jsonb, $8::jsonb, $9, $10, $11, $12::jsonb) RETURNING ${COLUMNS}`,
        [id, input.name, input.transport, input.command ?? null, JSON.stringify(input.args), input.url ?? null,
          JSON.stringify(Object.keys(input.env)), JSON.stringify(Object.keys(input.headers)), await this.seal(secrets), input.enabled, source,
          JSON.stringify(input.providers)]);
      return summarize(result.rows[0]!);
    } catch (error) { throw this.translate(error); }
  }

  private async update(id: string, input: AgentMcpServerInput): Promise<AgentMcpServerSummary> {
    const current = (await this.pool.query<Row>(`SELECT ${COLUMNS} FROM agent_mcp_servers WHERE id = $1`, [id])).rows[0];
    if (!current) throw new AgentExtensionsError('NOT_FOUND', 'The MCP server no longer exists.');
    const stored = await this.open(current);
    const merge = (next: Record<string, string>, previous: Record<string, string>): Record<string, string> => {
      const merged: Record<string, string> = {};
      for (const [key, value] of Object.entries(next)) {
        if (value !== '') merged[key] = value;
        else if (previous[key] !== undefined) merged[key] = previous[key];
        else throw new AgentExtensionsError('INVALID', 'A value is required for a new key.');
      }
      return merged;
    };
    const secrets: Secrets = { env: merge(input.env, stored.env), headers: merge(input.headers, stored.headers) };
    try {
      const result = await this.pool.query<Row>(
        `UPDATE agent_mcp_servers SET name = $2, transport = $3, command = $4, args = $5::jsonb, url = $6, env_keys = $7::jsonb, header_keys = $8::jsonb,
           secrets_cipher = $9, enabled = $10, providers = $11::jsonb, updated_at = now() WHERE id = $1 RETURNING ${COLUMNS}`,
        [id, input.name, input.transport, input.command ?? null, JSON.stringify(input.args), input.url ?? null,
          JSON.stringify(Object.keys(secrets.env)), JSON.stringify(Object.keys(secrets.headers)), await this.seal(secrets), input.enabled,
          JSON.stringify(input.providers)]);
      return summarize(result.rows[0]!);
    } catch (error) { throw this.translate(error); }
  }

  async setEnabled(id: string, enabled: boolean): Promise<AgentMcpServerSummary> {
    const result = await this.pool.query<Row>(`UPDATE agent_mcp_servers SET enabled = $2, updated_at = now() WHERE id = $1 RETURNING ${COLUMNS}`, [id, enabled]);
    if (!result.rows[0]) throw new AgentExtensionsError('NOT_FOUND', 'The MCP server no longer exists.');
    return summarize(result.rows[0]);
  }

  async delete(id: string): Promise<void> {
    const result = await this.pool.query('DELETE FROM agent_mcp_servers WHERE id = $1', [id]);
    if (result.rowCount === 0) throw new AgentExtensionsError('NOT_FOUND', 'The MCP server no longer exists.');
  }

  async getTools(): Promise<AgentExtensionTools> {
    const row = (await this.pool.query<{ value: unknown }>('SELECT value FROM app_settings WHERE key = $1', [AGENT_EXTENSION_TOOLS_KEY])).rows[0];
    const parsed = AgentExtensionToolsSchema.safeParse(row?.value);
    return parsed.success ? parsed.data : { ...DEFAULT_AGENT_EXTENSION_TOOLS };
  }

  async setTools(tools: AgentExtensionTools): Promise<AgentExtensionTools> {
    const value = AgentExtensionToolsSchema.parse(tools);
    await this.pool.query(
      'INSERT INTO app_settings (key, value) VALUES ($1, $2::jsonb) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()',
      [AGENT_EXTENSION_TOOLS_KEY, JSON.stringify(value)]);
    return value;
  }

  /**
   * Decrypted servers and tool additions for one run, or null when nothing is enabled. The caller must already have decided the job is
   * eligible. A server whose secrets cannot be opened is left out rather than started without its credentials.
   */
  async resolveForRun(): Promise<AgentRunExtensions | null> {
    const tools = await this.getTools();
    const rows = (await this.pool.query<Row>(`SELECT ${COLUMNS} FROM agent_mcp_servers WHERE enabled ORDER BY name`)).rows;
    const servers: AgentMcpServerDefinition[] = [];
    for (const row of rows) {
      try {
        const secrets = await this.open(row);
        const parsed = AgentMcpServerDefinitionSchema.safeParse({
          name: row.name, transport: row.transport, ...(row.command === null ? {} : { command: row.command }), args: row.args,
          env: secrets.env, ...(row.url === null ? {} : { url: row.url }), headers: secrets.headers, providers: row.providers });
        if (parsed.success) servers.push(parsed.data);
      } catch { /* unreadable secrets: skip this server only */ }
    }
    return servers.length === 0 && !Object.values(tools).some(Boolean) ? null : { servers, tools };
  }

  private async seal(secrets: Secrets): Promise<string | null> {
    if (Object.keys(secrets.env).length === 0 && Object.keys(secrets.headers).length === 0) return null;
    return this.codec.seal(JSON.stringify(secrets));
  }

  private async open(row: Row): Promise<Secrets> {
    if (row.secrets_cipher === null) return { env: {}, headers: {} };
    const parsed = JSON.parse(await this.codec.open(row.secrets_cipher)) as Partial<Secrets>;
    return { env: parsed.env ?? {}, headers: parsed.headers ?? {} };
  }

  private translate(error: unknown): unknown {
    return (error as { code?: unknown }).code === '23505' ? new AgentExtensionsError('NAME_TAKEN', 'A server with this name already exists.') : error;
  }
}
