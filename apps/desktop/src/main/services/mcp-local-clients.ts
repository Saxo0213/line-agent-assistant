import { copyFile, readFile, rename, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';

export type LocalClientKind = 'claude-desktop' | 'codex';
export interface LocalClientStatus { client: LocalClientKind; installed: boolean; connected: boolean }
export class LocalMcpConfigError extends Error {
  constructor(public readonly code: 'LOCAL_MCP_CONFIG_CONFLICT' | 'LOCAL_MCP_CONFIG_INVALID', message: string) { super(message); this.name = 'LocalMcpConfigError'; }
}

export const CODEX_BLOCK_START = '# >>> LINEJS MCP (managed by LINE Agent Assistant; do not edit)';
export const CODEX_BLOCK_END = '# <<< LINEJS MCP';
const STATUS_PROBE_TIMEOUT_MS = 1_500;

/**
 * Reads the endpoint of the managed entry. The entry needs no token. An old entry that still has
 * LINEJS_MCP_TOKEN or http_headers is read the same way; the next connect rewrites it without them.
 */
function configuredEndpoint(client: LocalClientKind, contents: string): string | null {
  if (client === 'codex') {
    const start = contents.indexOf(CODEX_BLOCK_START);
    const end = contents.indexOf(CODEX_BLOCK_END);
    if (start < 0 || end < start) return null;
    return /^url\s*=\s*"([^"]+)"\s*$/m.exec(contents.slice(start, end))?.[1] ?? null;
  }
  const entry = parseClaudeConfig(contents).mcpServers;
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return null;
  const env = (entry as Record<string, unknown>).linejs;
  if (!env || typeof env !== 'object' || Array.isArray(env)) return null;
  const vars = (env as Record<string, unknown>).env;
  if (!vars || typeof vars !== 'object' || Array.isArray(vars)) return null;
  const url = (vars as Record<string, unknown>).LINEJS_MCP_URL;
  return typeof url === 'string' ? url : null;
}

async function probeConfiguredEndpoint(endpointUrl: string): Promise<boolean> {
  try {
    const endpoint = new URL(endpointUrl);
    if (endpoint.protocol !== 'http:' || endpoint.hostname !== '127.0.0.1' || endpoint.pathname !== '/mcp') return false;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), STATUS_PROBE_TIMEOUT_MS);
    try {
      const response = await fetch(endpoint, { method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 'local-client-status', method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'LINEJS status', version: '1' } } }),
        signal: controller.signal });
      if (!response.ok) return false;
      const body = await response.json() as { jsonrpc?: unknown; id?: unknown; result?: unknown };
      return body.jsonrpc === '2.0' && body.id === 'local-client-status' && !!body.result && typeof body.result === 'object';
    } finally { clearTimeout(timeout); }
  } catch { return false; }
}

function block(port: number): string {
  return `${CODEX_BLOCK_START}\n[mcp_servers.linejs]\nurl = "http://127.0.0.1:${port}/mcp"\n${CODEX_BLOCK_END}`;
}
export function addCodexManagedBlock(contents: string, port: number): string {
  const starts = contents.split(CODEX_BLOCK_START).length - 1;
  const ends = contents.split(CODEX_BLOCK_END).length - 1;
  const start = contents.indexOf(CODEX_BLOCK_START);
  const end = contents.indexOf(CODEX_BLOCK_END);
  if (starts > 1 || ends > 1 || (start >= 0) !== (end >= 0) || (start >= 0 && end < start)) throw new LocalMcpConfigError('LOCAL_MCP_CONFIG_CONFLICT', 'Codex MCP 管理區塊標記不完整。');
  const outside = start >= 0 ? `${contents.slice(0, start)}${contents.slice(end + CODEX_BLOCK_END.length)}` : contents;
  const hasLinejsTable = /^\s*\[mcp_servers\.(?:"linejs"|linejs)(?:\.[^\]]*)?\]\s*$/m.test(outside);
  let inRootServerTable = false;
  const hasLinejsRootKey = outside.split(/\r?\n/).some((line) => {
    const header = /^\s*\[([^\]]+)\]\s*$/.exec(line);
    if (header) { inRootServerTable = header[1] === 'mcp_servers'; return false; }
    return inRootServerTable && /^\s*linejs\s*=/.test(line);
  });
  if (hasLinejsTable || hasLinejsRootKey) throw new LocalMcpConfigError('LOCAL_MCP_CONFIG_CONFLICT', 'Codex MCP linejs config already exists outside the managed block.');
  if (/^\s*\[mcp_servers\.linejs\]\s*$/m.test(outside)) throw new LocalMcpConfigError('LOCAL_MCP_CONFIG_CONFLICT', 'Codex 設定已有自訂的 linejs MCP 項目，未變更設定檔。');
  const next = block(port);
  if (start >= 0) return `${contents.slice(0, start)}${next}${contents.slice(end + CODEX_BLOCK_END.length)}`;
  const separator = contents ? `${contents.endsWith('\n') ? '' : '\n'}\n` : '';
  return `${contents}${separator}${next}\n`;
}
export function removeCodexManagedBlock(contents: string): string {
  const starts = contents.split(CODEX_BLOCK_START).length - 1;
  const ends = contents.split(CODEX_BLOCK_END).length - 1;
  const start = contents.indexOf(CODEX_BLOCK_START);
  const end = contents.indexOf(CODEX_BLOCK_END);
  if (start < 0 && end < 0) return contents;
  if (starts !== 1 || ends !== 1 || start < 0 || end < start) throw new LocalMcpConfigError('LOCAL_MCP_CONFIG_CONFLICT', 'Codex MCP 管理區塊標記不完整。');
  const after = end + CODEX_BLOCK_END.length;
  const suffix = contents.slice(after).replace(/^\r?\n/, '');
  const prefix = contents.slice(0, start).replace(/\r?\n$/, '');
  return `${prefix}${prefix && suffix ? '\n' : ''}${suffix}`;
}

function parseClaudeConfig(contents: string): Record<string, unknown> {
  try {
    const parsed = contents.trim() ? JSON.parse(contents) as unknown : {};
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('root');
    return parsed as Record<string, unknown>;
  } catch {
    throw new LocalMcpConfigError('LOCAL_MCP_CONFIG_INVALID', 'Claude Desktop 設定檔不是有效的 JSON 物件。');
  }
}
export function updateClaudeManagedEntry(contents: string, entry: Record<string, unknown>): string {
  const config = parseClaudeConfig(contents);
  const servers = config.mcpServers && typeof config.mcpServers === 'object' && !Array.isArray(config.mcpServers)
    ? config.mcpServers as Record<string, unknown> : {};
  return `${JSON.stringify({ ...config, mcpServers: { ...servers, linejs: entry } }, null, 2)}\n`;
}
export function removeClaudeManagedEntry(contents: string): string {
  const config = parseClaudeConfig(contents);
  const servers = config.mcpServers;
  if (!servers || typeof servers !== 'object' || Array.isArray(servers) || !('linejs' in servers)) return contents;
  const nextServers = { ...(servers as Record<string, unknown>) };
  delete nextServers.linejs;
  const next = { ...config, ...(Object.keys(nextServers).length ? { mcpServers: nextServers } : {}) };
  if (!Object.keys(nextServers).length) delete next.mcpServers;
  return `${JSON.stringify(next, null, 2)}\n`;
}

export async function writeClientConfig(_client: LocalClientKind, filePath: string, contents: string): Promise<void> {
  let existing = false;
  try { await stat(filePath); existing = true; } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  if (existing) await copyFile(filePath, `${filePath}.linejs-backup`);
  const temporary = `${filePath}.linejs-tmp`;
  await writeFile(temporary, contents, 'utf8');
  await rename(temporary, filePath);
}

export async function readClientConfig(filePath: string): Promise<string> {
  try { return await readFile(filePath, 'utf8'); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return ''; throw error; }
}

export interface McpLocalClientsOptions {
  claudeConfigPath: string;
  codexConfigPath: string;
  execPath: string;
  bridgePath: string;
  getPort: () => number | null;
}

export class McpLocalClients {
  private readonly writes = new Map<LocalClientKind, Promise<unknown>>();
  constructor(private readonly options: McpLocalClientsOptions) {}
  private file(client: LocalClientKind): string { return client === 'codex' ? this.options.codexConfigPath : this.options.claudeConfigPath; }
  private serialize<T>(client: LocalClientKind, action: () => Promise<T>): Promise<T> {
    const previous = this.writes.get(client) ?? Promise.resolve();
    const next = previous.catch(() => undefined).then(action);
    this.writes.set(client, next);
    void next.finally(() => { if (this.writes.get(client) === next) this.writes.delete(client); }).catch(() => undefined);
    return next;
  }
  async status(): Promise<LocalClientStatus[]> {
    return Promise.all((['claude-desktop', 'codex'] as const).map(async (client) => {
      const file = this.file(client);
      const installed = await stat(path.dirname(file)).then(() => true, () => false);
      let endpoint: string | null = null;
      if (installed) {
        try { endpoint = configuredEndpoint(client, await readClientConfig(file)); } catch { endpoint = null; }
      }
      const activePort = this.options.getPort();
      const endpointMatches = Boolean(endpoint && activePort && endpoint === `http://127.0.0.1:${activePort}/mcp`);
      const connected = Boolean(endpoint && endpointMatches && await probeConfiguredEndpoint(endpoint));
      return { client, installed, connected };
    }));
  }
  connect(client: LocalClientKind): Promise<LocalClientStatus> {
    return this.serialize(client, async () => {
      const filePath = this.file(client);
      if (!await stat(path.dirname(filePath)).then(() => true, () => false)) throw new Error('Local MCP client is not installed.');
      const port = this.options.getPort();
      if (!port || !Number.isInteger(port) || port < 1 || port > 65535) throw new Error('MCP server is not running.');
      const current = await readClientConfig(filePath);
      const next = client === 'codex'
        ? addCodexManagedBlock(current, port)
        : updateClaudeManagedEntry(current, { command: this.options.execPath, args: [this.options.bridgePath],
          env: { ELECTRON_RUN_AS_NODE: '1', LINEJS_MCP_URL: `http://127.0.0.1:${port}/mcp` } });
      await writeClientConfig(client, filePath, next);
      return (await this.status()).find((item) => item.client === client)!;
    });
  }
  disconnect(client: LocalClientKind): Promise<void> {
    return this.serialize(client, async () => {
      const filePath = this.file(client);
      const current = await readClientConfig(filePath);
      if (current) {
        if (client === 'codex') {
          const next = removeCodexManagedBlock(current);
          if (next !== current) await writeClientConfig(client, filePath, next);
        } else {
          const next = removeClaudeManagedEntry(current);
          if (next !== current) await writeClientConfig(client, filePath, next);
        }
      }
    });
  }
}
