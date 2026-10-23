import { copyFile, readFile, rename, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { MCP_TOOL_NAMES } from '@line-agent/contracts';
import type { McpService } from './mcp-service.js';

export type LocalClientKind = 'claude-desktop' | 'codex';
export interface LocalClientStatus { client: LocalClientKind; installed: boolean; connected: boolean; tokenId: string | null; accountScopes: string[] }
export class LocalMcpConfigError extends Error {
  constructor(public readonly code: 'LOCAL_MCP_CONFIG_CONFLICT' | 'LOCAL_MCP_CONFIG_INVALID', message: string) { super(message); this.name = 'LocalMcpConfigError'; }
}

export const CODEX_BLOCK_START = '# >>> LINEJS MCP (managed by LINE Agent Assistant; do not edit)';
export const CODEX_BLOCK_END = '# <<< LINEJS MCP';

function block(port: number, token: string): string {
  return `${CODEX_BLOCK_START}\n[mcp_servers.linejs]\nurl = "http://127.0.0.1:${port}/mcp"\nhttp_headers = { Authorization = "Bearer ${token}" }\n${CODEX_BLOCK_END}`;
}
export function addCodexManagedBlock(contents: string, port: number, token: string): string {
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
  const next = block(port, token);
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
  tokens: McpService;
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
    const tokens = await this.options.tokens.listTokens();
    return Promise.all((['claude-desktop', 'codex'] as const).map(async (client) => {
      const file = this.file(client);
      const installed = await stat(path.dirname(file)).then(() => true, () => false);
      let managed = false;
      if (installed) {
        try {
          const contents = await readClientConfig(file);
          managed = client === 'codex' ? contents.includes(CODEX_BLOCK_START) && contents.includes(CODEX_BLOCK_END)
            : JSON.parse(contents || '{}')?.mcpServers?.linejs !== undefined;
        } catch { managed = false; }
      }
      const principal = `local-client:${client}`;
      const token = tokens.find((item) => item.principalId === principal && item.state === 'ACTIVE' && item.expiresAt === null);
      return { client, installed, connected: managed && Boolean(token), tokenId: managed ? token?.tokenId ?? null : null,
        accountScopes: managed ? [...(token?.accountScopes ?? [])] : [] };
    }));
  }
  connect(client: LocalClientKind, accountScopes: readonly string[]): Promise<LocalClientStatus> {
    return this.serialize(client, async () => {
      const filePath = this.file(client);
      if (!await stat(path.dirname(filePath)).then(() => true, () => false)) throw new Error('Local MCP client is not installed.');
      const port = this.options.getPort();
      if (!port || !Number.isInteger(port) || port < 1 || port > 65535) throw new Error('MCP server is not running.');
      const current = await readClientConfig(filePath);
      if (client === 'codex') addCodexManagedBlock(current, port, 'validation-token');
      else updateClaudeManagedEntry(current, { command: this.options.execPath, args: [this.options.bridgePath], env: { LINEJS_MCP_TOKEN: 'validation-token' } });
      const principalId = `local-client:${client}`;
      const deviceLabel = client === 'codex' ? 'Codex（本機）' : 'Claude Desktop（本機）';
      for (const old of (await this.options.tokens.listTokens()).filter((item) => item.principalId === principalId && item.state === 'ACTIVE')) await this.options.tokens.revokeToken(old.tokenId);
      const issued = await this.options.tokens.issueToken({ deviceLabel, principalId, accountScopes,
        toolScopes: [...MCP_TOOL_NAMES], expiration: { mode: 'never' } });
      try {
        if (client === 'codex') {
          await writeClientConfig(client, filePath, addCodexManagedBlock(current, port, issued.plaintextToken));
        } else {
          const next = updateClaudeManagedEntry(current, { command: this.options.execPath, args: [this.options.bridgePath],
            env: { ELECTRON_RUN_AS_NODE: '1', LINEJS_MCP_URL: `http://127.0.0.1:${port}/mcp`, LINEJS_MCP_TOKEN: issued.plaintextToken } });
          await writeClientConfig(client, filePath, next);
        }
      } catch (error) {
        await this.options.tokens.revokeToken(issued.token.tokenId).catch(() => false);
        throw error;
      }
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
      const principal = `local-client:${client}`;
      for (const token of await this.options.tokens.listTokens()) if (token.principalId === principal && token.state === 'ACTIVE') await this.options.tokens.revokeToken(token.tokenId);
    });
  }
}
