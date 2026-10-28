import { describe, expect, it } from 'vitest';
import {
  AGENT_MCP_SECRET_MASK, AgentMcpServerDefinitionSchema, AgentMcpServerInputSchema, AgentMcpServerNameSchema, AgentMcpServerSummarySchema,
  AgentRunRequestSchema, IpcRequestSchema, agentExtensionToolsGrantedByLevel,
} from './index.js';

const stdio = { name: 'files', transport: 'stdio' as const, command: 'node', args: ['server.js'], env: { TOKEN: 'secret' }, enabled: true, providers: ['claude' as const] };
const http = { name: 'remote', transport: 'http' as const, url: 'https://example.com/mcp', headers: { Authorization: 'Bearer x' }, enabled: true, providers: ['claude' as const, 'codex' as const] };

describe('agent MCP extension contracts', () => {
  it('accepts slug names and rejects reserved or malformed names', () => {
    for (const name of ['a', 'files', 'my_server-2', 'a'.repeat(40)]) expect(AgentMcpServerNameSchema.safeParse(name).success).toBe(true);
    for (const name of ['', 'Files', '-a', '_a', 'a b', 'a.b', 'a'.repeat(41), 'linejs', 'claude_ai', 'claude_ai_Gmail', 'claude_ai-x']) expect(AgentMcpServerNameSchema.safeParse(name).success).toBe(false);
    expect(AgentMcpServerNameSchema.safeParse('claude-ai').success).toBe(true);
  });

  it('requires the fields of the chosen transport and rejects the other transport fields', () => {
    expect(AgentMcpServerInputSchema.safeParse(stdio).success).toBe(true);
    expect(AgentMcpServerInputSchema.safeParse(http).success).toBe(true);
    expect(AgentMcpServerInputSchema.safeParse({ ...stdio, command: undefined }).success).toBe(false);
    expect(AgentMcpServerInputSchema.safeParse({ ...stdio, command: '  ' }).success).toBe(false);
    expect(AgentMcpServerInputSchema.safeParse({ ...stdio, url: 'https://example.com' }).success).toBe(false);
    expect(AgentMcpServerInputSchema.safeParse({ ...stdio, headers: { A: 'b' } }).success).toBe(false);
    expect(AgentMcpServerInputSchema.safeParse({ ...http, url: undefined }).success).toBe(false);
    expect(AgentMcpServerInputSchema.safeParse({ ...http, url: 'ftp://example.com' }).success).toBe(false);
    expect(AgentMcpServerInputSchema.safeParse({ ...http, url: 'not a url' }).success).toBe(false);
    expect(AgentMcpServerInputSchema.safeParse({ ...http, command: 'node' }).success).toBe(false);
    expect(AgentMcpServerInputSchema.safeParse({ ...http, args: ['x'] }).success).toBe(false);
    expect(AgentMcpServerInputSchema.safeParse({ ...http, env: { A: 'b' } }).success).toBe(false);
    expect(AgentMcpServerInputSchema.safeParse({ ...stdio, args: [1] }).success).toBe(false);
  });

  it('validates provider list, env and header keys and values', () => {
    expect(AgentMcpServerInputSchema.safeParse({ ...stdio, providers: [] }).success).toBe(false);
    expect(AgentMcpServerInputSchema.safeParse({ ...stdio, providers: ['claude', 'claude'] }).success).toBe(false);
    expect(AgentMcpServerInputSchema.safeParse({ ...stdio, providers: ['other'] }).success).toBe(false);
    expect(AgentMcpServerInputSchema.safeParse({ ...stdio, env: { '1BAD': 'x' } }).success).toBe(false);
    expect(AgentMcpServerInputSchema.safeParse({ ...stdio, env: { LINEJS_INTERNAL_MCP_TOKEN: 'x' } }).success).toBe(false);
    expect(AgentMcpServerInputSchema.safeParse({ ...http, headers: { 'Bad Header': 'x' } }).success).toBe(false);
    expect(AgentMcpServerInputSchema.safeParse({ ...http, headers: { A: 'x\r\nB: y' } }).success).toBe(false);
  });

  it('requires non-empty values on create but allows empty (keep) values on edit', () => {
    expect(AgentMcpServerInputSchema.safeParse({ ...stdio, env: { TOKEN: '' } }).success).toBe(false);
    expect(AgentMcpServerInputSchema.safeParse({ ...http, headers: { Authorization: '' } }).success).toBe(false);
    const id = '8f1b6f5e-6b0a-4c3a-9d49-2c2f5c9f9f10';
    expect(AgentMcpServerInputSchema.safeParse({ ...stdio, id, env: { TOKEN: '' } }).success).toBe(true);
    expect(AgentMcpServerInputSchema.safeParse({ ...http, id, headers: { Authorization: '' } }).success).toBe(true);
  });

  it('fills defaults for args, env and headers', () => {
    const parsed = AgentMcpServerDefinitionSchema.parse({ name: 'x', transport: 'stdio', command: 'node', providers: ['codex'] });
    expect(parsed.args).toEqual([]); expect(parsed.env).toEqual({}); expect(parsed.headers).toEqual({});
  });

  it('only lets the renderer see masked secret values', () => {
    const summary = { id: '8f1b6f5e-6b0a-4c3a-9d49-2c2f5c9f9f10', name: 'files', transport: 'stdio', command: 'node', args: [], env: { TOKEN: AGENT_MCP_SECRET_MASK }, headers: {}, enabled: true, source: 'manual', providers: ['claude'] };
    expect(AgentMcpServerSummarySchema.safeParse(summary).success).toBe(true);
    expect(AgentMcpServerSummarySchema.safeParse({ ...summary, env: { TOKEN: 'secret' } }).success).toBe(false);
    expect(AgentMcpServerSummarySchema.safeParse({ ...summary, headers: { A: 'secret' } }).success).toBe(false);
  });

  it('extends the run request with optional extensions and the IPC with the extension actions', () => {
    const base = { jobId: 'j', provider: 'claude', source: { type: 'ui', requestId: 'r' }, prompt: 'p', workspacePath: 'C:\w',
      tools: { localTools: true, fileRead: true, fileWrite: true, linkedReadDirs: [], workspaceRootDir: null, level: 'workspace_write', interactiveApproval: true } };
    expect(AgentRunRequestSchema.safeParse(base).success).toBe(true);
    const tools = { webSearch: true, webFetch: false, bash: false, fileRead: false, fileWrite: false };
    expect(AgentRunRequestSchema.safeParse({ ...base, extensions: { servers: [{ ...stdio, enabled: undefined }].map(({ enabled: _e, ...rest }) => rest), tools } }).success).toBe(true);
    expect(AgentRunRequestSchema.safeParse({ ...base, extensions: { servers: [], tools: { webSearch: true } } }).success).toBe(false);
    expect(IpcRequestSchema.safeParse({ type: 'saveAgentMcpServer', requestId: 'r', server: stdio }).success).toBe(true);
    expect(IpcRequestSchema.safeParse({ type: 'saveAgentMcpServer', requestId: 'r', server: { ...stdio, name: 'linejs' } }).success).toBe(false);
  });

  it('describes which tools the execution level already grants', () => {
    expect(agentExtensionToolsGrantedByLevel('read_only')).toEqual({ fileRead: true, fileWrite: false, webSearch: false, webFetch: false, bash: false });
    expect(agentExtensionToolsGrantedByLevel('workspace_write')).toMatchObject({ fileWrite: true, webSearch: false, bash: true });
    expect(agentExtensionToolsGrantedByLevel('trust')).toMatchObject({ webSearch: true, webFetch: true });
  });
});
