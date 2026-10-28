import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { defaultImportLocations, parseCodexMcpServers, readImportSources, slugifyServerName } from './agent-extension-import.js';

let root: string;
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), 'agent-extension-import-')); });
afterEach(async () => { await rm(root, { recursive: true, force: true }); });
const locations = () => ({ claudeCode: join(root, '.claude.json'), claudeDesktop: join(root, 'Claude', 'claude_desktop_config.json'), codex: join(root, '.codex', 'config.toml') });
const source = (results: Awaited<ReturnType<typeof readImportSources>>, name: string) => results.find((item) => item.source === name)!;

describe('Claude Code import (~/.claude.json)', () => {
  it('reads only mcpServers, tolerates duplicate keys elsewhere and excludes nothing but flags linejs', async () => {
    const file = locations().claudeCode;
    await writeFile(file, `{
      "projects": {"a": {"x": 1, "x": 2}, "oauthAccount": {"emailAddress": "private@example.com"}},
      "mcpServers": {
        "files": {"type": "stdio", "command": "npx", "args": ["-y", "server"], "env": {"API_KEY": "sk-1"}},
        "bare": {"command": "node", "args": ["a.js"]},
        "remote": {"type": "http", "url": "https://example.com/mcp", "headers": {"Authorization": "Bearer t"}},
        "legacy": {"type": "sse", "url": "https://example.com/sse"},
        "linejs": {"type": "http", "url": "http://127.0.0.1:1/mcp"},
        "My Server!": {"command": "x"}
      },
      "mcpServers": {
        "files": {"type": "stdio", "command": "npx", "args": ["-y", "server"], "env": {"API_KEY": "sk-1"}},
        "bare": {"command": "node", "args": ["a.js"]},
        "remote": {"type": "http", "url": "https://example.com/mcp", "headers": {"Authorization": "Bearer t"}},
        "legacy": {"type": "sse", "url": "https://example.com/sse"},
        "linejs": {"type": "http", "url": "http://127.0.0.1:1/mcp"},
        "My Server!": {"command": "x"},
        "claude_ai_Gmail": {"type": "http", "url": "https://example.com/g"}
      }
    }`);
    const result = source(await readImportSources(locations()), 'claude-code');
    expect(result.status).toBe('ok');
    const byName = Object.fromEntries(result.entries.map((entry) => [entry.sourceName, entry]));
    expect(byName.files).toMatchObject({ name: 'files', transport: 'stdio', command: 'npx', args: ['-y', 'server'], envKeys: ['API_KEY'], issue: undefined });
    expect(byName.files!.input).toMatchObject({ env: { API_KEY: 'sk-1' }, providers: ['claude', 'codex'], enabled: true });
    expect(byName.bare).toMatchObject({ transport: 'stdio', issue: undefined });
    expect(byName.remote).toMatchObject({ transport: 'http', url: 'https://example.com/mcp', headerKeys: ['Authorization'], issue: undefined });
    expect(byName.legacy!.issue).toBe('UNSUPPORTED_TRANSPORT');
    expect(byName.linejs!.issue).toBe('RESERVED_NAME');
    expect(byName.claude_ai_Gmail!.issue).toBe('RESERVED_NAME');
    expect(byName['My Server!']).toMatchObject({ name: 'my-server', issue: undefined });
    expect(JSON.stringify(result.entries.map(({ input: _input, ...rest }) => rest))).not.toContain('private@example.com');
  });

  it('treats a missing file as no source and a bad file as a per-source error', async () => {
    expect(source(await readImportSources(locations()), 'claude-code')).toEqual({ source: 'claude-code', status: 'missing', entries: [] });
    await writeFile(locations().claudeCode, '{ not json');
    expect(source(await readImportSources(locations()), 'claude-code')).toMatchObject({ status: 'error', error: 'INVALID_FORMAT', entries: [] });
    await writeFile(locations().claudeCode, '{"mcpServers": []}');
    expect(source(await readImportSources(locations()), 'claude-code')).toMatchObject({ status: 'error', error: 'INVALID_FORMAT' });
    await writeFile(locations().claudeCode, '{"theme": "dark"}');
    expect(source(await readImportSources(locations()), 'claude-code')).toMatchObject({ status: 'ok', entries: [] });
  });

  it('reports a directory in place of the file as a read failure', async () => {
    await mkdir(locations().claudeCode);
    expect(source(await readImportSources(locations()), 'claude-code')).toMatchObject({ status: 'error', error: 'READ_FAILED' });
  });
});

describe('Claude Desktop import', () => {
  it('reads mcpServers from claude_desktop_config.json and marks bad definitions', async () => {
    await mkdir(join(root, 'Claude'));
    await writeFile(locations().claudeDesktop, JSON.stringify({ mcpServers: {
      fs: { command: 'npx', args: ['-y', '@modelcontextprotocol/server-filesystem', 'C:\\data'] },
      broken: { command: 'node', args: [1] }, nothing: {}, badenv: { command: 'x', env: { A: { nested: true } } },
    }, preferences: { secret: 1 } }));
    const result = source(await readImportSources(locations()), 'claude-desktop');
    const byName = Object.fromEntries(result.entries.map((entry) => [entry.sourceName, entry]));
    expect(byName.fs).toMatchObject({ transport: 'stdio', issue: undefined });
    expect(byName.broken!.issue).toBe('INVALID_DEFINITION');
    expect(byName.nothing!.issue).toBe('INVALID_DEFINITION');
    expect(byName.badenv!.issue).toBe('INVALID_DEFINITION');
  });
});

describe('Codex import (config.toml)', () => {
  const toml = `
model = "gpt-6"
notes = """
[mcp_servers.fake]
command = "must-not-appear"
"""

[mcp_servers.files]
command = "npx"
args = ["-y", "server", 'literal']
startup_timeout_sec = 20
enabled = true

[mcp_servers.files.env]
API_KEY = "sk-toml"
"QUOTED_KEY" = "v"

[mcp_servers.remote]
url = "https://example.com/mcp"
http_headers = { "X-Team" = "alpha", "X-Two" = "b" }

[mcp_servers.authed]
url = "https://example.com/auth"
bearer_token_env_var = "TOKEN_VAR"

[mcp_servers.off]
command = "node"
enabled = false
args = [
  "a.js",   # comment
  "b.js",
]

[mcp_servers."has space"]
command = "node"

[mcp_servers.linejs]
url = "http://127.0.0.1:1/mcp"

[[other.array]]
name = "x"

[profiles.default]
model = "y"
`;

  it('extracts the mcp_servers tables only', () => {
    const servers = parseCodexMcpServers(toml);
    expect(Object.keys(servers).sort()).toEqual(['authed', 'files', 'has space', 'linejs', 'off', 'remote']);
    expect(servers.files).toMatchObject({ command: 'npx', args: ['-y', 'server', 'literal'], env: { API_KEY: 'sk-toml', 'QUOTED_KEY': 'v' }, startup_timeout_sec: 20 });
    expect(servers.off).toMatchObject({ args: ['a.js', 'b.js'], enabled: false });
    expect(servers.remote).toMatchObject({ http_headers: { 'X-Team': 'alpha', 'X-Two': 'b' } });
  });

  it('builds candidates with source-specific rules', async () => {
    await mkdir(join(root, '.codex'));
    await writeFile(locations().codex, toml);
    const result = source(await readImportSources(locations()), 'codex');
    expect(result.status).toBe('ok');
    const byName = Object.fromEntries(result.entries.map((entry) => [entry.sourceName, entry]));
    expect(byName.files).toMatchObject({ transport: 'stdio', envKeys: ['API_KEY', 'QUOTED_KEY'], issue: undefined });
    expect(byName.files!.input?.env).toEqual({ API_KEY: 'sk-toml', 'QUOTED_KEY': 'v' });
    expect(byName.remote).toMatchObject({ transport: 'http', headerKeys: ['X-Team', 'X-Two'], issue: undefined });
    expect(byName.authed!.issue).toBe('UNSUPPORTED_AUTH');
    expect(byName.off!.input?.enabled).toBe(false);
    expect(byName['has space']).toMatchObject({ name: 'has-space' });
    expect(byName.linejs!.issue).toBe('RESERVED_NAME');
    expect(byName.fake).toBeUndefined();
  });

  it('reports invalid TOML per source', async () => {
    await mkdir(join(root, '.codex'));
    await writeFile(locations().codex, '[mcp_servers.x]\ncommand = = "x"\n');
    expect(source(await readImportSources(locations()), 'codex')).toMatchObject({ status: 'error', error: 'INVALID_FORMAT' });
    await writeFile(locations().codex, '[mcp_servers.x\ncommand = "x"\n');
    expect(source(await readImportSources(locations()), 'codex')).toMatchObject({ status: 'ok' });
    await writeFile(locations().codex, '[mcp_servers.x]\nargs = ["unterminated\n');
    expect(source(await readImportSources(locations()), 'codex')).toMatchObject({ status: 'error', error: 'INVALID_FORMAT' });
    expect(source(await readImportSources({ ...locations(), codex: join(root, 'absent.toml') }), 'codex').status).toBe('missing');
  });
});

describe('import is read-only and helpers', () => {
  it('never modifies the source files', async () => {
    await writeFile(locations().claudeCode, '{"mcpServers":{"a":{"command":"x"}}}');
    const before = { bytes: await readFile(locations().claudeCode, 'utf8'), mtime: (await stat(locations().claudeCode)).mtimeMs };
    await readImportSources(locations());
    expect(await readFile(locations().claudeCode, 'utf8')).toBe(before.bytes);
    expect((await stat(locations().claudeCode)).mtimeMs).toBe(before.mtime);
  });
  it('slugifies names and derives default locations from the environment', () => {
    expect(slugifyServerName('GitHub MCP')).toBe('github-mcp');
    expect(slugifyServerName('###')).toBe('server');
    expect(slugifyServerName('a'.repeat(60))).toHaveLength(40);
    expect(defaultImportLocations({ APPDATA: 'C:\\Users\\u\\AppData\\Roaming', CODEX_HOME: 'D:\\codex' }, 'C:\\Users\\u'))
      .toEqual({ claudeCode: join('C:\\Users\\u', '.claude.json'), claudeDesktop: join('C:\\Users\\u\\AppData\\Roaming', 'Claude', 'claude_desktop_config.json'), codex: join('D:\\codex', 'config.toml') });
  });
});
