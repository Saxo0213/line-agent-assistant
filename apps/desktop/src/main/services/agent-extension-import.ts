import { readFile, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import {
  AGENT_MCP_RESERVED_NAME, AGENT_MCP_RESERVED_PREFIX, AgentMcpServerInputSchema,
  type AgentMcpImportCandidate, type AgentMcpImportSource, type AgentMcpServerInput,
} from '@line-agent/contracts';

/** Local MCP configurations that can be imported. They are only ever read. */
export interface AgentExtensionImportLocations { claudeCode: string; claudeDesktop: string; codex: string }

export function defaultImportLocations(env: NodeJS.ProcessEnv = process.env, home: string = homedir()): AgentExtensionImportLocations {
  return {
    claudeCode: join(home, '.claude.json'),
    claudeDesktop: join(env.APPDATA ?? join(home, 'AppData', 'Roaming'), 'Claude', 'claude_desktop_config.json'),
    codex: join(env.CODEX_HOME ?? join(home, '.codex'), 'config.toml'),
  };
}

const MAX_CONFIG_BYTES = 32 * 1024 * 1024;

/** One server found in a source file. `input` carries secrets and never leaves Main. */
export interface ImportEntry {
  source: AgentMcpImportSource;
  sourceName: string;
  name: string;
  input: AgentMcpServerInput | undefined;
  issue: AgentMcpImportCandidate['issue'];
  transport: AgentMcpImportCandidate['transport'];
  command?: string;
  args: string[];
  envKeys: string[];
  url?: string;
  headerKeys: string[];
}
export interface ImportSourceResult {
  source: AgentMcpImportSource;
  status: 'ok' | 'missing' | 'error';
  error?: 'INVALID_FORMAT' | 'READ_FAILED';
  entries: ImportEntry[];
}

export function slugifyServerName(raw: string): string {
  const slug = raw.toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^[^a-z0-9]+/, '').slice(0, 40).replace(/-+$/, '');
  return slug || 'server';
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const stringMap = (value: unknown): Record<string, string> | undefined => {
  if (value === undefined) return {};
  if (!isRecord(value)) return undefined;
  const out: Record<string, string> = {};
  for (const [key, item] of Object.entries(value)) {
    if (typeof item === 'string') out[key] = item;
    else if (typeof item === 'number' || typeof item === 'boolean') out[key] = String(item);
    else return undefined;
  }
  return out;
};

interface RawServer { type?: unknown; command?: unknown; args?: unknown; env?: unknown; url?: unknown; headers?: unknown; enabled?: boolean; unsupportedAuth?: boolean }

function toEntry(source: AgentMcpImportSource, sourceName: string, raw: unknown, rawPrefix: RawServer = {}): ImportEntry {
  const name = slugifyServerName(sourceName);
  const server: RawServer = isRecord(raw) ? { ...(raw as RawServer), ...rawPrefix } : {};
  const reserved = name === AGENT_MCP_RESERVED_NAME || name.startsWith(AGENT_MCP_RESERVED_PREFIX);
  const declared = typeof server.type === 'string' ? server.type.toLowerCase() : undefined;
  const hasCommand = typeof server.command === 'string' && server.command.trim() !== '';
  const hasUrl = typeof server.url === 'string' && server.url.trim() !== '';
  const transport = declared === 'stdio' || (declared === undefined && hasCommand) ? 'stdio' : 'http';
  const argsValid = server.args === undefined || (Array.isArray(server.args) && server.args.every((item) => typeof item === 'string'));
  const args = argsValid && Array.isArray(server.args) ? server.args as string[] : [];
  const env = stringMap(server.env);
  const headers = stringMap(server.headers);
  const base = {
    source, sourceName, name, transport, args,
    ...(hasCommand ? { command: String(server.command).trim() } : {}),
    ...(hasUrl ? { url: String(server.url).trim() } : {}),
    envKeys: Object.keys(env ?? {}), headerKeys: Object.keys(headers ?? {}),
  } as const;
  const entry = (issue: ImportEntry['issue'], input?: AgentMcpServerInput): ImportEntry => ({ ...base, input, issue });
  if (reserved) return entry('RESERVED_NAME');
  if (declared !== undefined && declared !== 'stdio' && declared !== 'http' && declared !== 'streamable-http' && declared !== 'streamable_http') return entry('UNSUPPORTED_TRANSPORT');
  if (server.unsupportedAuth) return entry('UNSUPPORTED_AUTH');
  if (!isRecord(raw) || env === undefined || headers === undefined || !argsValid) return entry('INVALID_DEFINITION');
  const parsed = AgentMcpServerInputSchema.safeParse({
    name, transport, args: transport === 'stdio' ? args : [], env: transport === 'stdio' ? env : {}, headers: transport === 'http' ? headers : {},
    ...(transport === 'stdio' ? { command: base.command } : { url: base.url }),
    enabled: server.enabled !== false, providers: ['claude', 'codex'],
  });
  return parsed.success ? entry(undefined, parsed.data) : entry('INVALID_DEFINITION');
}

async function readText(file: string): Promise<{ text: string } | { missing: true } | { error: 'READ_FAILED' }> {
  try {
    const info = await stat(file);
    if (!info.isFile() || info.size > MAX_CONFIG_BYTES) return { error: 'READ_FAILED' };
    return { text: await readFile(file, 'utf8') };
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ENOENT' || (error as NodeJS.ErrnoException).code === 'ENOTDIR' ? { missing: true } : { error: 'READ_FAILED' };
  }
}

/** Claude Code (`~/.claude.json`) and Claude Desktop share the `mcpServers` object. Only that top-level key is kept. */
async function readJsonSource(source: 'claude-code' | 'claude-desktop', file: string): Promise<ImportSourceResult> {
  const read = await readText(file);
  if ('missing' in read) return { source, status: 'missing', entries: [] };
  if ('error' in read) return { source, status: 'error', error: read.error, entries: [] };
  let servers: unknown;
  try {
    // JSON.parse tolerates the duplicate keys Claude Code writes elsewhere in the file (last one wins).
    const parsed: unknown = JSON.parse(read.text.replace(/^﻿/, ''));
    if (!isRecord(parsed)) throw new Error('not an object');
    servers = parsed.mcpServers;
  } catch { return { source, status: 'error', error: 'INVALID_FORMAT', entries: [] }; }
  if (servers === undefined) return { source, status: 'ok', entries: [] };
  if (!isRecord(servers)) return { source, status: 'error', error: 'INVALID_FORMAT', entries: [] };
  return { source, status: 'ok', entries: Object.entries(servers).map(([name, raw]) => toEntry(source, name, raw)) };
}

// ---- Minimal TOML reader: just enough of the grammar for `[mcp_servers.*]` tables (strings, numbers, booleans, arrays, inline tables). ----

class TomlError extends Error {}
type TomlValue = string | number | boolean | TomlValue[] | { [key: string]: TomlValue };

class ValueReader {
  private index = 0;
  constructor(private readonly text: string) {}
  done(): boolean { this.skipSpace(false); return this.index >= this.text.length; }
  private skipSpace(newlines: boolean): void {
    for (;;) {
      const char = this.text[this.index];
      if (char === ' ' || char === '\t' || char === '\r' || (newlines && char === '\n')) this.index += 1;
      else if (char === '#' && newlines) { while (this.index < this.text.length && this.text[this.index] !== '\n') this.index += 1; }
      else if (char === '#') { this.index = this.text.length; }
      else return;
    }
  }
  value(): TomlValue {
    this.skipSpace(false);
    const char = this.text[this.index];
    if (char === '"') return this.basicString();
    if (char === "'") return this.literalString();
    if (char === '[') return this.array();
    if (char === '{') return this.inlineTable();
    const match = /^[^\s,\]}#]+/.exec(this.text.slice(this.index));
    if (!match) throw new TomlError('value expected');
    this.index += match[0].length;
    if (match[0] === 'true') return true;
    if (match[0] === 'false') return false;
    if (/^[+-]?(?:0x[0-9a-fA-F_]+|\d[\d_]*(?:\.\d[\d_]*)?(?:[eE][+-]?\d+)?)$/.test(match[0])) return Number(match[0].replaceAll('_', ''));
    throw new TomlError('unsupported value');
  }
  private basicString(): string {
    if (this.text.startsWith('"""', this.index)) throw new TomlError('multi-line strings are not supported here');
    this.index += 1;
    let out = '';
    for (;;) {
      const char = this.text[this.index];
      if (char === undefined || char === '\n') throw new TomlError('unterminated string');
      this.index += 1;
      if (char === '"') return out;
      if (char !== '\\') { out += char; continue; }
      const escape = this.text[this.index]; this.index += 1;
      const simple: Record<string, string> = { b: '\b', t: '\t', n: '\n', f: '\f', r: '\r', '"': '"', '\\': '\\' };
      if (escape !== undefined && escape in simple) { out += simple[escape]; continue; }
      const width = escape === 'u' ? 4 : escape === 'U' ? 8 : 0;
      const hex = this.text.slice(this.index, this.index + width);
      if (!width || !new RegExp(`^[0-9a-fA-F]{${width}}$`).test(hex)) throw new TomlError('bad escape');
      out += String.fromCodePoint(Number.parseInt(hex, 16)); this.index += width;
    }
  }
  private literalString(): string {
    if (this.text.startsWith("'''", this.index)) throw new TomlError('multi-line strings are not supported here');
    const end = this.text.indexOf("'", this.index + 1);
    const newline = this.text.indexOf('\n', this.index);
    if (end < 0 || (newline >= 0 && newline < end)) throw new TomlError('unterminated string');
    const out = this.text.slice(this.index + 1, end); this.index = end + 1; return out;
  }
  private array(): TomlValue[] {
    this.index += 1;
    const out: TomlValue[] = [];
    for (;;) {
      this.skipSpace(true);
      if (this.text[this.index] === ']') { this.index += 1; return out; }
      out.push(this.value());
      this.skipSpace(true);
      if (this.text[this.index] === ',') this.index += 1;
      else if (this.text[this.index] !== ']') throw new TomlError('array syntax');
    }
  }
  private inlineTable(): { [key: string]: TomlValue } {
    this.index += 1;
    const out: { [key: string]: TomlValue } = {};
    for (;;) {
      this.skipSpace(false);
      if (this.text[this.index] === '}') { this.index += 1; return out; }
      const key = this.key();
      this.skipSpace(false);
      if (this.text[this.index] !== '=') throw new TomlError('inline table syntax');
      this.index += 1;
      out[key] = this.value();
      this.skipSpace(false);
      if (this.text[this.index] === ',') this.index += 1;
      else if (this.text[this.index] !== '}') throw new TomlError('inline table syntax');
    }
  }
  key(): string {
    this.skipSpace(false);
    if (this.text[this.index] === '"') return this.basicString();
    if (this.text[this.index] === "'") return this.literalString();
    const match = /^[A-Za-z0-9_-]+/.exec(this.text.slice(this.index));
    if (!match) throw new TomlError('key expected');
    this.index += match[0].length; return match[0];
  }
  /** A dotted table name such as `mcp_servers."my server".env`. */
  dottedKey(): string[] {
    const parts = [this.key()];
    for (;;) {
      this.skipSpace(false);
      if (this.index >= this.text.length) return parts;
      if (this.text[this.index] !== '.') throw new TomlError('table name syntax');
      this.index += 1;
      parts.push(this.key());
    }
  }
  rest(): string { return this.text.slice(this.index); }
}

function headerPath(line: string): string[] | null {
  const match = /^\[(.+)\]\s*(?:#.*)?$/.exec(line);
  if (!match) return null;
  return new ValueReader(match[1]!).dottedKey();
}

/** Extracts `[mcp_servers.<name>]` (and its `env`, `http_headers`, `env_http_headers` sub-tables) from a Codex config.toml. */
export function parseCodexMcpServers(text: string): Record<string, Record<string, unknown>> {
  const servers: Record<string, Record<string, unknown>> = {};
  const lines = text.replace(/^﻿/, '').split(/\r?\n/);
  let target: Record<string, unknown> | null = null;
  let multi: string | null = null;
  for (let row = 0; row < lines.length; row += 1) {
    const line = lines[row]!;
    if (multi !== null) { if (line.includes(multi)) multi = null; continue; }
    const trimmed = line.trim();
    if (trimmed === '' || trimmed.startsWith('#')) continue;
    if (trimmed.startsWith('[')) {
      if (trimmed.startsWith('[[')) { target = null; continue; }
      const path = headerPath(trimmed);
      if (!path || path[0] !== 'mcp_servers' || path.length < 2 || path.length > 3) { target = null; continue; }
      const server = (servers[path[1]!] ??= {});
      if (path.length === 2) target = server;
      else if (['env', 'http_headers', 'env_http_headers'].includes(path[2]!)) target = (server[path[2]!] = (isRecord(server[path[2]!]) ? server[path[2]!] : {})) as Record<string, unknown>;
      else target = null;
      continue;
    }
    // Outside the tables of interest only multi-line strings can hide something that looks like a header.
    const opener = /=\s*("""|''')/.exec(line);
    if (opener && !line.slice(opener.index + opener[0].length).includes(opener[1]!)) { multi = opener[1]!; continue; }
    if (!target) continue;
    // A value may continue over several lines (arrays, inline tables): gather until it parses.
    let chunk = line;
    for (;;) {
      const reader = new ValueReader(chunk);
      try {
        const key = reader.key();
        const rest = reader.rest().trimStart();
        if (!rest.startsWith('=')) throw new TomlError('assignment expected');
        const valueReader = new ValueReader(rest.slice(1));
        target[key] = valueReader.value();
        if (!valueReader.done()) throw new TomlError('trailing data');
        break;
      } catch (error) {
        if (row + 1 < lines.length && /unterminated|array syntax|inline table|value expected/.test((error as Error).message) && /[[{]/.test(chunk)) { row += 1; chunk += `\n${lines[row]!}`; continue; }
        throw error instanceof TomlError ? error : new TomlError('parse failure');
      }
    }
  }
  return servers;
}

async function readCodexSource(file: string): Promise<ImportSourceResult> {
  const read = await readText(file);
  if ('missing' in read) return { source: 'codex', status: 'missing', entries: [] };
  if ('error' in read) return { source: 'codex', status: 'error', error: read.error, entries: [] };
  let servers: Record<string, Record<string, unknown>>;
  try { servers = parseCodexMcpServers(read.text); } catch { return { source: 'codex', status: 'error', error: 'INVALID_FORMAT', entries: [] }; }
  return {
    source: 'codex', status: 'ok',
    entries: Object.entries(servers).map(([name, raw]) => {
      const headers = { ...(isRecord(raw.http_headers) ? raw.http_headers : {}) };
      // env_http_headers / bearer_token_env_var name environment variables whose values are not in the file.
      const unsupportedAuth = typeof raw.bearer_token_env_var === 'string' || (isRecord(raw.env_http_headers) && Object.keys(raw.env_http_headers).length > 0);
      return toEntry('codex', name, { ...raw, headers }, { enabled: raw.enabled !== false, unsupportedAuth });
    }),
  };
}

export async function readImportSources(locations: AgentExtensionImportLocations): Promise<ImportSourceResult[]> {
  return [await readJsonSource('claude-code', locations.claudeCode), await readJsonSource('claude-desktop', locations.claudeDesktop), await readCodexSource(locations.codex)];
}
