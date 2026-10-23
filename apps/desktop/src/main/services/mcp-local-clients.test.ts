import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { addCodexManagedBlock, removeCodexManagedBlock, updateClaudeManagedEntry, writeClientConfig, McpLocalClients, type LocalClientKind } from './mcp-local-clients.js';

const roots: string[] = [];
async function tempFile(name: string, contents?: string): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), 'linejs-mcp-client-'));
  roots.push(root);
  const file = path.join(root, name);
  if (contents !== undefined) await writeFile(file, contents, 'utf8');
  return file;
}
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

describe('Codex managed config', () => {
  it.each([
    ['missing', undefined],
    ['empty', ''],
    ['populated', '# keep exactly\nmodel = "x"\n'],
  ])('connects with a %s config and preserves unrelated text', async (_label, initial) => {
    const file = await tempFile('config.toml', initial);
    const output = addCodexManagedBlock(initial ?? '', 38471, 'la_mcp_secret');
    await writeClientConfig('codex', file, output);
    expect(await readFile(file, 'utf8')).toBe(output);
    expect(await readFile(`${file}.linejs-backup`, 'utf8').catch(() => '')).toBe(initial ?? '');
    expect(output).toContain('http_headers = { Authorization = "Bearer la_mcp_secret" }');
    if (initial) {
      expect(output.slice(0, initial.length)).toBe(initial);
      expect(output).toContain('# keep exactly\nmodel = "x"\n');
    }
  });

  it('replaces one managed block and refuses an unmanaged linejs table', () => {
    const first = addCodexManagedBlock('', 38471, 'old');
    const second = addCodexManagedBlock(first, 38472, 'new');
    expect(second.match(/\[mcp_servers\.linejs\]/g)).toHaveLength(1);
    expect(second).toContain('38472');
    expect(() => addCodexManagedBlock('[mcp_servers.linejs]\nurl = "user"\n', 38471, 'token'))
      .toThrowError(expect.objectContaining({ code: 'LOCAL_MCP_CONFIG_CONFLICT' }));
    expect(removeCodexManagedBlock(first)).toBe('');
  });

  it.each([
    '[mcp_servers."linejs"]\nurl = "user"\n',
    '[mcp_servers]\nlinejs = { url = "user" }\n',
    '[mcp_servers.linejs.auth]\nkey = "user"\n',
  ])('rejects unmanaged Codex linejs forms', (contents) => {
    expect(() => addCodexManagedBlock(contents, 38471, 'token')).toThrowError(expect.objectContaining({ code: 'LOCAL_MCP_CONFIG_CONFLICT' }));
  });
});

describe('Claude Desktop config', () => {
  it('sets and removes only mcpServers.linejs and refuses invalid JSON', async () => {
    const file = await tempFile('claude_desktop_config.json', JSON.stringify({ other: true, mcpServers: { keep: { command: 'x' } } }));
    const result = await writeClientConfig('claude-desktop', file, updateClaudeManagedEntry(await readFile(file, 'utf8'), { command: 'node' }));
    expect(result).toBeUndefined();
    expect(JSON.parse(await readFile(file, 'utf8'))).toEqual({ other: true, mcpServers: { keep: { command: 'x' }, linejs: { command: 'node' } } });
    expect(JSON.parse(await readFile(file, 'utf8'))).toEqual({ other: true, mcpServers: { keep: { command: 'x' }, linejs: { command: 'node' } } });
    expect(() => updateClaudeManagedEntry('{ nope', { command: 'node' })).toThrowError(expect.objectContaining({ code: 'LOCAL_MCP_CONFIG_INVALID' }));
  });
});

it('types the supported local client kinds', () => {
  const kind: LocalClientKind = 'codex';
  expect(kind).toBe('codex');
});

describe('McpLocalClients lifecycle', () => {
  async function setup(client: LocalClientKind, initial: string) {
    const root = await mkdtemp(path.join(tmpdir(), 'linejs-mcp-lifecycle-'));
    roots.push(root);
    const claudeConfigPath = path.join(root, 'Claude', 'claude_desktop_config.json');
    const codexConfigPath = path.join(root, '.codex', 'config.toml');
    const file = client === 'codex' ? codexConfigPath : claudeConfigPath;
    await import('node:fs/promises').then(({ mkdir }) => Promise.all([mkdir(path.dirname(file), { recursive: true }), mkdir(path.dirname(client === 'codex' ? claudeConfigPath : codexConfigPath), { recursive: true })]));
    if (initial) await writeFile(file, initial, 'utf8');
    const rows: Array<{ token: any; plaintextToken: string }> = [];
    const tokens = {
      async listTokens() { return rows.map(({ token }) => token); },
      async issueToken(input: any) {
        const token = { tokenId: `token-${rows.length}`, principalId: input.principalId, deviceLabel: input.deviceLabel, state: 'ACTIVE', expiresAt: null, accountScopes: [...input.accountScopes] };
        rows.push({ token, plaintextToken: 'la_mcp_secret' });
        return { token, plaintextToken: 'la_mcp_secret' };
      },
      async revokeToken(tokenId: string) { const row = rows.find(({ token }) => token.tokenId === tokenId); if (row) row.token.state = 'REVOKED'; return Boolean(row); },
    };
    const service = new McpLocalClients({ tokens: tokens as any, claudeConfigPath, codexConfigPath,
      execPath: 'C:/Program Files/Electron/electron.exe', bridgePath: 'C:/app/dist/mcp-stdio-bridge.js', getPort: () => 38500 });
    return { service, file, rows };
  }

  it('reconnects by revoking the old token and replacing the single managed entry', async () => {
    const { service, file, rows } = await setup('codex', '');
    await service.connect('codex', ['account-a']);
    expect(rows[0]?.token.deviceLabel).toBe('Codex（本機）');
    await service.connect('codex', ['account-b']);
    const config = await readFile(file, 'utf8');
    expect(config.match(/\[mcp_servers\.linejs\]/g)).toHaveLength(1);
    expect(config).toContain('Bearer la_mcp_secret');
    expect(rows.map(({ token }) => token.state)).toEqual(['REVOKED', 'ACTIVE']);
    expect(rows[1]?.token.accountScopes).toEqual(['account-b']);
  });

  it('serializes concurrent connects for the same client kind', async () => {
    const { service, file, rows } = await setup('codex', '');
    await Promise.all([service.connect('codex', ['account-a']), service.connect('codex', ['account-b'])]);
    expect(rows.filter(({ token }) => token.state === 'ACTIVE')).toHaveLength(1);
    expect((await readFile(file, 'utf8')).match(/\[mcp_servers\.linejs\]/g)).toHaveLength(1);
  });

  it('validates Codex conflicts and invalid Claude JSON before issuing a token', async () => {
    const codex = await setup('codex', '[mcp_servers.linejs]\nurl = "user"\n');
    await expect(codex.service.connect('codex', ['account-a'])).rejects.toMatchObject({ code: 'LOCAL_MCP_CONFIG_CONFLICT' });
    expect(codex.rows).toEqual([]);
    expect(await readFile(codex.file, 'utf8')).toBe('[mcp_servers.linejs]\nurl = "user"\n');
    const claude = await setup('claude-desktop', '{ broken');
    await expect(claude.service.connect('claude-desktop', ['account-a'])).rejects.toMatchObject({ code: 'LOCAL_MCP_CONFIG_INVALID' });
    expect(claude.rows).toEqual([]);
    expect(await readFile(claude.file, 'utf8')).toBe('{ broken');
  });

  it('writes Claude Desktop stdio config and disconnects only the managed entry', async () => {
    const { service, file, rows } = await setup('claude-desktop', '{"other":true,"mcpServers":{"keep":{"command":"keep"}}}');
    await service.connect('claude-desktop', ['account-a']);
    expect(rows[0]?.token.deviceLabel).toBe('Claude Desktop（本機）');
    const connected = JSON.parse(await readFile(file, 'utf8'));
    expect(connected.other).toBe(true);
    expect(connected.mcpServers.keep).toEqual({ command: 'keep' });
    expect(connected.mcpServers.linejs).toMatchObject({ command: 'C:/Program Files/Electron/electron.exe', args: ['C:/app/dist/mcp-stdio-bridge.js'], env: { LINEJS_MCP_URL: 'http://127.0.0.1:38500/mcp', LINEJS_MCP_TOKEN: 'la_mcp_secret' } });
    await service.disconnect('claude-desktop');
    expect(JSON.parse(await readFile(file, 'utf8'))).toEqual({ other: true, mcpServers: { keep: { command: 'keep' } } });
    expect(rows[0]?.token.state).toBe('REVOKED');
  });

  it('connects Claude Desktop when its config file is missing', async () => {
    const { service, file } = await setup('claude-desktop', '');
    await service.connect('claude-desktop', ['account-a']);
    expect(JSON.parse(await readFile(file, 'utf8')).mcpServers.linejs.env.LINEJS_MCP_URL).toBe('http://127.0.0.1:38500/mcp');
  });

  it('keeps the active token and config when reconnect validation fails', async () => {
    const { service, file, rows } = await setup('claude-desktop', '{}');
    await service.connect('claude-desktop', ['account-a']);
    await writeFile(file, '{ broken', 'utf8');
    await expect(service.connect('claude-desktop', ['account-b'])).rejects.toMatchObject({ code: 'LOCAL_MCP_CONFIG_INVALID' });
    expect(rows.map(({ token }) => token.state)).toEqual(['ACTIVE']);
    expect(await readFile(file, 'utf8')).toBe('{ broken');
  });

  it('refuses to connect when the client config directory is absent', async () => {
    const { service, file, rows } = await setup('codex', '');
    await import('node:fs/promises').then(({ rm }) => rm(path.dirname(file), { recursive: true, force: true }));
    await expect(service.connect('codex', ['account-a'])).rejects.toThrow('not installed');
    expect(rows).toHaveLength(0);
  });
});
