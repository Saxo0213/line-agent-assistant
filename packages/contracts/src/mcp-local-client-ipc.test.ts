import { describe, expect, it } from 'vitest';
import { IpcRequestSchema, IpcResultSchema } from './ipc.js';

describe('local MCP client IPC', () => {
  const status = { client: 'codex', installed: true, connected: true };
  it('accepts status, connect, and disconnect requests with only the client kind', () => {
    expect(IpcRequestSchema.parse({ type: 'mcpLocalClientStatus', requestId: 'status' })).toMatchObject({ type: 'mcpLocalClientStatus' });
    expect(IpcRequestSchema.parse({ type: 'mcpLocalClientConnect', client: 'codex', requestId: 'connect' })).toMatchObject({ client: 'codex' });
    expect(IpcRequestSchema.safeParse({ type: 'mcpLocalClientConnect', client: 'codex', accountScopes: ['role:AGENT'], requestId: 'scope' }).success).toBe(false);
    expect(IpcRequestSchema.parse({ type: 'mcpLocalClientDisconnect', client: 'claude-desktop', requestId: 'disconnect' })).toMatchObject({ client: 'claude-desktop' });
    expect(IpcRequestSchema.safeParse({ type: 'mcpLocalClientConnect', client: 'codex', configPath: 'C:/private', requestId: 'bad' }).success).toBe(false);
  });
  it('returns client status only and rejects any plaintext token field', () => {
    expect(IpcResultSchema.parse({ type: 'mcpLocalClientConnect', requestId: 'connect', ok: true, status })).toMatchObject({ status });
    expect(IpcResultSchema.safeParse({ type: 'mcpLocalClientConnect', requestId: 'connect', ok: true, status: { ...status, token: 'la_mcp_secret' } }).success).toBe(false);
    expect(IpcResultSchema.safeParse({ type: 'mcpLocalClientConnect', requestId: 'connect', ok: true, status: { ...status, tokenId: '11111111-1111-4111-8111-111111111111', accountScopes: [] } }).success).toBe(false);
    expect(IpcResultSchema.parse({ type: 'mcpLocalClientStatus', requestId: 'status', ok: true, clients: [status] })).toMatchObject({ clients: [status] });
    expect(IpcResultSchema.parse({ type: 'mcpLocalClientDisconnect', requestId: 'disconnect', ok: true })).toMatchObject({ ok: true });
  });
});
