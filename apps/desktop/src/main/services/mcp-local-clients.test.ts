import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { addCodexManagedBlock, removeCodexManagedBlock, updateClaudeManagedEntry, writeClientConfig, McpLocalClients, type LocalClientKind } from './mcp-local-clients.js';

const roots: string[] = [];
async function tempFile(name: string, contents?: string): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), 'linejs-mcp-client-'));
  roots.push(root);
  const file = path.join(root, name);
  if (contents !== undefined) await writeFile(file, contents, 'utf8');
  return file;
}
afterEach(async () => { vi.unstubAllGlobals(); await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

describe('Codex managed config', () => {
  it.each([
    ['missing', undefined],
    ['empty', ''],
    ['populated', '# keep exactly\nmodel = "x"\n'],
  ])('connects with a %s config and preserves unrelated text', async (_label, initial) => {
    const file = await tempFile('config.toml', initial);
    const output = addCodexManagedBlock(initial ?? '', 38471);
    await writeClientConfig('codex', file, output);
    expect(await readFile(file, 'utf8')).toBe(output);
    expect(await readFile(`${file}.linejs-backup`, 'utf8').catch(() => '')).toBe(initial ?? '');
    expect(output).toContain('url = "http://127.0.0.1:38471/mcp"');
    expect(output).not.toMatch(/http_headers|Authorization|Bearer|token/i);
    if (initial) {
      expect(output.slice(0, initial.length)).toBe(initial);
      expect(output).toContain('# keep exactly\nmodel = "x"\n');
    }
  });

  it('replaces one managed block and refuses an unmanaged linejs table', () => {
    const first = addCodexManagedBlock('', 38471);
    const second = addCodexManagedBlock(first, 38472);
    expect(second.match(/\[mcp_servers\.linejs\]/g)).toHaveLength(1);
    expect(second).toContain('38472');
    expect(() => addCodexManagedBlock('[mcp_servers.linejs]\nurl = "user"\n', 38471))
      .toThrowError(expect.objectContaining({ code: 'LOCAL_MCP_CONFIG_CONFLICT' }));
    expect(removeCodexManagedBlock(first)).toBe('');
  });

  it.each([
    '[mcp_servers."linejs"]\nurl = "user"\n',
    '[mcp_servers]\nlinejs = { url = "user" }\n',
    '[mcp_servers.linejs.auth]\nkey = "user"\n',
  ])('rejects unmanaged Codex linejs forms', (contents) => {
    expect(() => addCodexManagedBlock(contents, 38471)).toThrowError(expect.objectContaining({ code: 'LOCAL_MCP_CONFIG_CONFLICT' }));
  });
});

describe('Claude Desktop config', () => {
  it('sets and removes only mcpServers.linejs and refuses invalid JSON', async () => {
    const file = await tempFile('claude_desktop_config.json', JSON.stringify({ other: true, mcpServers: { keep: { command: 'x' } } }));
    const result = await writeClientConfig('claude-desktop', file, updateClaudeManagedEntry(await readFile(file, 'utf8'), { command: 'node' }));
    expect(result).toBeUndefined();
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
    const probes: Array<{ endpoint: string; headers: Record<string, string> }> = [];
    vi.stubGlobal('fetch', vi.fn(async (endpoint: URL, init: RequestInit) => {
      probes.push({ endpoint: String(endpoint), headers: init.headers as Record<string, string> });
      return { ok: true, json: async () => ({ jsonrpc: '2.0', id: 'local-client-status', result: {} }) };
    }));
    const service = new McpLocalClients({ claudeConfigPath, codexConfigPath,
      execPath: 'C:/Program Files/Electron/electron.exe', bridgePath: 'C:/app/dist/mcp-stdio-bridge.js', getPort: () => 38500 });
    return { service, file, probes };
  }

  it('reconnects by replacing the single managed entry, with no token in the config', async () => {
    const { service, file } = await setup('codex', '');
    expect(await service.connect('codex')).toEqual({ client: 'codex', installed: true, connected: true });
    await service.connect('codex');
    const config = await readFile(file, 'utf8');
    expect(config.match(/\[mcp_servers\.linejs\]/g)).toHaveLength(1);
    expect(config).toContain('url = "http://127.0.0.1:38500/mcp"');
    expect(config).not.toMatch(/http_headers|Authorization|Bearer|la_mcp_/);
  });

  it('probes the endpoint without an Authorization header', async () => {
    const { service, probes } = await setup('codex', '');
    await service.connect('codex');
    expect(probes.length).toBeGreaterThan(0);
    for (const probe of probes) {
      expect(probe.endpoint).toBe('http://127.0.0.1:38500/mcp');
      expect(Object.keys(probe.headers).map((name) => name.toLowerCase())).not.toContain('authorization');
    }
  });

  it('reads an old Codex block with http_headers as connected and rewrites it without the token', async () => {
    const old = '# >>> LINEJS MCP (managed by LINE Agent Assistant; do not edit)\n[mcp_servers.linejs]\nurl = "http://127.0.0.1:38500/mcp"\nhttp_headers = { Authorization = "Bearer la_mcp_old" }\n# <<< LINEJS MCP\n';
    const { service, file } = await setup('codex', old);
    expect((await service.status()).find((item) => item.client === 'codex')).toEqual({ client: 'codex', installed: true, connected: true });
    await service.connect('codex');
    const config = await readFile(file, 'utf8');
    expect(config).toContain('url = "http://127.0.0.1:38500/mcp"');
    expect(config).not.toMatch(/http_headers|Authorization|la_mcp_old/);
  });

  it('reads an old Claude Desktop entry with LINEJS_MCP_TOKEN as connected and rewrites it without the token', async () => {
    const old = JSON.stringify({ mcpServers: { linejs: { command: 'x', args: ['y'], env: { LINEJS_MCP_URL: 'http://127.0.0.1:38500/mcp', LINEJS_MCP_TOKEN: 'la_mcp_old' } } } });
    const { service, file } = await setup('claude-desktop', old);
    expect((await service.status()).find((item) => item.client === 'claude-desktop')).toEqual({ client: 'claude-desktop', installed: true, connected: true });
    await service.connect('claude-desktop');
    const config = JSON.parse(await readFile(file, 'utf8'));
    expect(config.mcpServers.linejs.env).toEqual({ ELECTRON_RUN_AS_NODE: '1', LINEJS_MCP_URL: 'http://127.0.0.1:38500/mcp' });
  });

  it('reports disconnected when the configured endpoint is not the active endpoint', async () => {
    const { service, file } = await setup('codex', '');
    await service.connect('codex');
    await writeFile(file, (await readFile(file, 'utf8')).replace('38500', '38501'));
    expect((await service.status()).find((item) => item.client === 'codex')).toMatchObject({ connected: false });
  });

  it('reports disconnected when the initialize probe fails', async () => {
    const { service } = await setup('claude-desktop', '{}');
    await service.connect('claude-desktop');
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, json: async () => ({}) })));
    expect((await service.status()).find((item) => item.client === 'claude-desktop')).toMatchObject({ connected: false });
  });

  it('serializes concurrent connects for the same client kind', async () => {
    const { service, file } = await setup('codex', '');
    await Promise.all([service.connect('codex'), service.connect('codex')]);
    expect((await readFile(file, 'utf8')).match(/\[mcp_servers\.linejs\]/g)).toHaveLength(1);
  });

  it('validates Codex conflicts and invalid Claude JSON without changing the config', async () => {
    const codex = await setup('codex', '[mcp_servers.linejs]\nurl = "user"\n');
    await expect(codex.service.connect('codex')).rejects.toMatchObject({ code: 'LOCAL_MCP_CONFIG_CONFLICT' });
    expect(await readFile(codex.file, 'utf8')).toBe('[mcp_servers.linejs]\nurl = "user"\n');
    const claude = await setup('claude-desktop', '{ broken');
    await expect(claude.service.connect('claude-desktop')).rejects.toMatchObject({ code: 'LOCAL_MCP_CONFIG_INVALID' });
    expect(await readFile(claude.file, 'utf8')).toBe('{ broken');
  });

  it('writes Claude Desktop stdio config with no token and disconnects only the managed entry', async () => {
    const { service, file } = await setup('claude-desktop', '{"other":true,"mcpServers":{"keep":{"command":"keep"}}}');
    await service.connect('claude-desktop');
    const connected = JSON.parse(await readFile(file, 'utf8'));
    expect(connected.other).toBe(true);
    expect(connected.mcpServers.keep).toEqual({ command: 'keep' });
    expect(connected.mcpServers.linejs).toEqual({ command: 'C:/Program Files/Electron/electron.exe', args: ['C:/app/dist/mcp-stdio-bridge.js'],
      env: { ELECTRON_RUN_AS_NODE: '1', LINEJS_MCP_URL: 'http://127.0.0.1:38500/mcp' } });
    await service.disconnect('claude-desktop');
    expect(JSON.parse(await readFile(file, 'utf8'))).toEqual({ other: true, mcpServers: { keep: { command: 'keep' } } });
  });

  it('connects Claude Desktop when its config file is missing', async () => {
    const { service, file } = await setup('claude-desktop', '');
    await service.connect('claude-desktop');
    expect(JSON.parse(await readFile(file, 'utf8')).mcpServers.linejs.env.LINEJS_MCP_URL).toBe('http://127.0.0.1:38500/mcp');
  });

  it('keeps the config when reconnect validation fails', async () => {
    const { service, file } = await setup('claude-desktop', '{}');
    await service.connect('claude-desktop');
    await writeFile(file, '{ broken', 'utf8');
    await expect(service.connect('claude-desktop')).rejects.toMatchObject({ code: 'LOCAL_MCP_CONFIG_INVALID' });
    expect(await readFile(file, 'utf8')).toBe('{ broken');
  });

  it('refuses to connect when the client config directory is absent', async () => {
    const { service, file } = await setup('codex', '');
    await import('node:fs/promises').then(({ rm }) => rm(path.dirname(file), { recursive: true, force: true }));
    await expect(service.connect('codex')).rejects.toThrow('not installed');
  });
});
