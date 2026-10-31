import { describe, expect, it, vi } from 'vitest';
import type { Pool } from 'pg';
import { allPermissions, McpDomainError, type McpTokenRepository, type MessageRepository } from '@line-agent/database';
import { AGENT_PERMISSION_IDS, MCP_TOOL_NAMES, type AgentPermissionId, type EffectivePermissions } from '@line-agent/contracts';
import { AGENT_ROOM_HISTORY_TOOL_DEFINITION, MCP_TOOL_DEFINITIONS, McpService } from './mcp-service.js';
import { AgentApprovalBroker, type AgentApprovalEvent } from './agent-approval-broker.js';
import { createOperationalAudit, type AuditEvent } from './operational-audit.js';

const withEffects = (overrides: Partial<Record<AgentPermissionId, 'ALLOW' | 'DENY'>>): EffectivePermissions =>
  ({ ...allPermissions('DENY'), ...overrides });

function harness(permissions: EffectivePermissions, onCall?: () => never, roomHistory = false, onDiagnostic?: ConstructorParameters<typeof McpService>[0]['onDiagnostic']) {
  const tokens = {
    verifyInternalAgent: async () => permissions,
    verifyInternalAgentAccess: async () => ({ permissions, roomHistory }),
    executeForInternalAgent: async () => { if (onCall) onCall(); return { toolName: 'list_targets', targets: [] }; },
    recordAudit: async () => undefined,
  } as unknown as McpTokenRepository;
  const service = new McpService({ pool: {} as Pool, tokens, messages: {} as MessageRepository,
    ...(onDiagnostic ? { onDiagnostic } : {}),
    chatResources: { listNotes: async () => ({ notes: [], nextCursor: null, savedAt: null }), getNote: async () => ({ note: null, savedAt: null }),
      listAlbums: async () => ({ albums: [], nextCursor: null, savedAt: null }), getAlbum: async () => ({ album: null, photos: [], savedAt: null }) } });
  const { token } = service.internalCapabilities.mint({ jobId: 'job-1', generation: 1, accountId: 'a', endpointInstance: 'instance' });
  const rpc = (method: string, params?: unknown) => service.handleInternalJsonRpc(token, 'instance',
    { jsonrpc: '2.0', id: 1, method, ...(params === undefined ? {} : { params }) });
  return { rpc, service };
}

describe('internal MCP tools/list and tools/call follow the effective permissions', () => {
  it('contains unexpected internal exception text at the JSON-RPC boundary', async () => {
    const sentinel = 'private-token-path-prompt-sentinel';
    const reports = vi.fn();
    const { rpc, service } = harness(allPermissions('ALLOW'), () => { throw new Error(sentinel); }, false, reports);
    try {
      const response = await rpc('tools/call', { name: 'list_targets', arguments: {} });
      expect(response.httpStatus).toBe(500);
      expect(response.body).toMatchObject({ error: { code: -32603, message: 'Internal MCP server error.' } });
      expect(JSON.stringify(response)).not.toContain(sentinel);
      expect(reports).toHaveBeenCalledWith(expect.objectContaining({ operation: 'mcp' }), { jobId: 'job-1', accountId: 'a', correlationId: expect.any(String) });
    } finally { await service.shutdown(); }
  });

  it('contains unexpected external exception text at the JSON-RPC boundary', async () => {
    const sentinel = 'private-token-path-prompt-sentinel';
    const tokens = { executeLocalClientRead: async () => { throw new Error(sentinel); } } as unknown as McpTokenRepository;
    const stored: AuditEvent[] = [];
    const audit = createOperationalAudit({ append: async (event) => { stored.push(event); }, appendFallback: async () => {}, logSinkState() {} });
    const service = new McpService({ pool: {} as Pool, tokens, messages: {} as MessageRepository,
      onDiagnostic: (diagnostic, identity) => { audit.failure(diagnostic, identity); } });
    try {
      const response = await service.handleExternalJsonRpc({ jsonrpc: '2.0', id: 1, method: 'tools/list' });
      expect(response.httpStatus).toBe(500);
      expect(response.body).toMatchObject({ error: { code: -32603, message: 'Internal MCP server error.' } });
      expect(JSON.stringify(response)).not.toContain(sentinel);
      await service.handleExternalJsonRpc({ jsonrpc: '2.0', id: 'private-external-id-sentinel', method: 'tools/list' });
      await audit.flush();
      expect(stored).toHaveLength(2);
      expect(stored[0]?.correlationId).not.toBe(stored[1]?.correlationId);
      expect(JSON.stringify(stored)).not.toMatch(/private-external-id-sentinel|private-token-path-prompt-sentinel/);
    } finally { await service.shutdown(); }
  });

  it('lists the record tools when either records permission resolves ALLOW', async () => {
    for (const permission of ['records.query_current_chat', 'records.query_all_chats'] as const) {
      const { rpc, service } = harness(withEffects({ [permission]: 'ALLOW' }));
      const names = ((await rpc('tools/list')).body as { result: { tools: Array<{ name: string }> } }).result.tools.map((tool) => tool.name);
      expect(names).toEqual(['list_targets', 'query_target_messages', 'query_target_messages_by_time', 'list_active_chats', 'list_chat_albums', 'get_chat_album']);
      await service.shutdown();
    }
  });

  it('lists nothing when no records permission is ALLOW, and admin/operator (all ALLOW) see everything', async () => {
    const denied = harness(withEffects({ 'chat_folder.read': 'ALLOW', 'agent.local_tools': 'ALLOW' }));
    expect(((await denied.rpc('tools/list')).body as { result: { tools: unknown[] } }).result.tools).toEqual([]);
    await denied.service.shutdown();
    const admin = harness(allPermissions('ALLOW'));
    expect(((await admin.rpc('tools/list')).body as { result: { tools: unknown[] } }).result.tools).toHaveLength(6);
    await admin.service.shutdown();
    expect(AGENT_PERMISSION_IDS).toHaveLength(7);
  });

  it('maps a denied call to PERMISSION_DENIED (HTTP 403) rather than a generic scope error', async () => {
    const { rpc, service } = harness(withEffects({}), () => { throw new McpDomainError('PERMISSION_DENIED', 'This Agent job does not have permission to use this tool.'); });
    const response = await rpc('tools/call', { name: 'query_target_messages', arguments: { target: 'x' } });
    expect(response.httpStatus).toBe(403);
    expect(response.body).toMatchObject({ error: { data: { code: 'PERMISSION_DENIED' } } });
    await service.shutdown();
  });
});

describe('Agent room history tool visibility', () => {
  const names = async (rpc: ReturnType<typeof harness>['rpc']) =>
    ((await rpc('tools/list')).body as { result: { tools: Array<{ name: string }> } }).result.tools.map((tool) => tool.name);

  it('lists the history tool only when the repository says the Agent room (or its shared chat) may use it', async () => {
    const allowed = harness(allPermissions('ALLOW'), undefined, true);
    expect(await names(allowed.rpc)).toEqual(['list_targets', 'query_target_messages', 'query_target_messages_by_time', 'list_active_chats', 'list_chat_albums', 'get_chat_album', 'query_agent_room_history']);
    await allowed.service.shutdown();
    const denied = harness(allPermissions('ALLOW'), undefined, false);
    expect(await names(denied.rpc)).toEqual(['list_targets', 'query_target_messages', 'query_target_messages_by_time', 'list_active_chats', 'list_chat_albums', 'get_chat_album']);
    await denied.service.shutdown();
  });

  it('never puts the history tool in the external definitions or lists it for the external client', async () => {
    expect(MCP_TOOL_DEFINITIONS.map((definition) => definition.name as string)).not.toContain('query_agent_room_history');
    const tokens = {
      executeLocalClientRead: async (input: { execute: (context: { toolScopes: string[] }) => Promise<{ data: unknown }> }) =>
        (await input.execute({ toolScopes: ['list_targets', 'query_agent_room_history'] })).data,
    } as unknown as McpTokenRepository;
    const service = new McpService({ pool: {} as Pool, tokens, messages: {} as MessageRepository });
    const response = await service.handleExternalJsonRpc({ jsonrpc: '2.0', id: 1, method: 'tools/list' });
    expect((response.body as { result: { tools: Array<{ name: string }> } }).result.tools.map((tool) => tool.name)).toEqual(['list_targets']);
    await service.shutdown();
  });

  it('routes an internal call through executeForInternalAgent with the history tool name and a denied call maps to HTTP 403', async () => {
    const seen: string[] = [];
    const tokens = {
      verifyInternalAgentAccess: async () => ({ permissions: allPermissions('ALLOW'), roomHistory: true }),
      executeForInternalAgent: async (input: { toolName: string }) => {
        seen.push(input.toolName);
        throw new McpDomainError('PERMISSION_DENIED', 'This Agent job does not have permission to use this tool.');
      },
      recordAudit: async () => undefined,
    } as unknown as McpTokenRepository;
    const service = new McpService({ pool: {} as Pool, tokens, messages: {} as MessageRepository });
    const { token } = service.internalCapabilities.mint({ jobId: 'job-1', generation: 1, accountId: 'a', endpointInstance: 'instance' });
    const response = await service.handleInternalJsonRpc(token, 'instance',
      { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'query_agent_room_history', arguments: { query: 'x' } } });
    expect(seen).toEqual(['query_agent_room_history']);
    expect(response.httpStatus).toBe(403);
    expect(response.body).toMatchObject({ error: { data: { code: 'PERMISSION_DENIED' } } });
    await service.shutdown();
  });

  it('describes the tool for the Agent', () => {
    expect(AGENT_ROOM_HISTORY_TOOL_DEFINITION.description).toMatch(/Agent room conversation history[\s\S]*newest first/);
    expect(AGENT_ROOM_HISTORY_TOOL_DEFINITION.description).toContain('nextCursor');
    expect(AGENT_ROOM_HISTORY_TOOL_DEFINITION.inputSchema.additionalProperties).toBe(false);
  });
});

describe('query_target_messages_by_time tool definition', () => {
  it('tells the Agent to read all chats in one call without a target', () => {
    const definition = MCP_TOOL_DEFINITIONS.find((tool) => tool.name === 'query_target_messages_by_time')!;
    for (const needle of ['omit every target field and give from', 'accountId, chatType, chatId and conversationTitle', 'Do not call this tool once per chat',
      'Do not call list_targets first', 'from is required when no target field is given', 'oldest first', 'Never report a time window as empty']) expect(definition.description).toContain(needle);
    expect((definition.inputSchema.properties as Record<string, { description?: string }>).target?.description).toContain('Omit to read all chats.');
    const plain = MCP_TOOL_DEFINITIONS.find((tool) => tool.name === 'query_target_messages')!;
    expect((plain.inputSchema.properties as Record<string, { description?: string }>).target?.description).not.toContain('Omit to read all chats.');
  });
});

describe('external MCP control and approval errors', () => {
  const externalError = async (code: 'CONTROL_CHANGED' | 'APPROVAL_REQUIRED') => {
    const tokens = {
      executeLocalClientRead: async () => { throw new McpDomainError(code, 'domain error'); },
    } as unknown as McpTokenRepository;
    const service = new McpService({ pool: {} as Pool, tokens, messages: {} as MessageRepository });
    const response = await service.handleExternalJsonRpc({
      jsonrpc: '2.0', id: 9, method: 'tools/call',
      params: { name: 'list_targets', arguments: {} },
    });
    await service.shutdown();
    return response;
  };

  it('maps control changes to HTTP 409 and the retryable JSON-RPC error', async () => {
    const response = await externalError('CONTROL_CHANGED');
    expect(response.httpStatus).toBe(409);
    expect(response.body).toMatchObject({ error: { code: -32009, data: { code: 'CONTROL_CHANGED' } } });
    expect((response.body as { error: { message: string } }).error.message).toContain('client may retry');
  });

  it('maps required approval to HTTP 403', async () => {
    const response = await externalError('APPROVAL_REQUIRED');
    expect(response.httpStatus).toBe(403);
    expect(response.body).toMatchObject({ error: { code: -32003, data: { code: 'APPROVAL_REQUIRED' } } });
  });
});

describe('internal request_permission prompt tool', () => {
  const binding = { sessionKey: '{"sessionKey":{},"sessionGeneration":1}', workspaceRoot: 'C:\\work' };
  function approvalHarness(options: { approval?: boolean; broker?: boolean } = {}) {
    const audits: Array<Record<string, unknown>> = [];
    const tokens = {
      verifyInternalAgent: async () => allPermissions('ALLOW'),
      verifyInternalAgentAccess: async () => ({ permissions: allPermissions('ALLOW'), roomHistory: false }),
      recordAudit: async (entry: Record<string, unknown>) => { audits.push(entry); },
      executeLocalClientRead: async (input: { execute: () => Promise<{ data: unknown }> }) => input.execute(),
    } as unknown as McpTokenRepository;
    const repository = {
      getExecutionPolicy: async () => ({ level: 'workspace_write', approvalTimeoutSeconds: 60, timeoutAction: 'DENY', version: 1, updatedAt: new Date(0).toISOString() }),
      listToolAllowlist: async () => [],
      addToolAllowlistEntry: async () => ({}),
      recordExecutionApproval: async () => undefined,
    };
    const brokerEvents: AgentApprovalEvent[] = [];
    const broker = new AgentApprovalBroker({ repository: repository as never, resolveWritePathEvidence: async () => null,
      publish: (event) => brokerEvents.push(event) });
    const requestSpy = vi.spyOn(broker, 'request');
    const service = new McpService({ pool: {} as Pool, tokens, messages: {} as MessageRepository,
      ...(options.broker === false ? {} : { approvalBroker: broker }) });
    const { token } = service.internalCapabilities.mint({ jobId: 'job-1', generation: 1, accountId: null, endpointInstance: 'instance',
      approval: options.approval === false ? null : binding });
    const rpc = (method: string, params?: unknown) => service.handleInternalJsonRpc(token, 'instance',
      { jsonrpc: '2.0', id: 1, method, ...(params === undefined ? {} : { params }) });
    const ask = (args: unknown) => rpc('tools/call', { name: 'request_permission', arguments: args });
    const cleanup = async () => { broker.close(); await service.shutdown(); };
    return { service, broker, brokerEvents, requestSpy, rpc, ask, audits, cleanup };
  }
  const listed = async (h: ReturnType<typeof approvalHarness>) =>
    ((await h.rpc('tools/list')).body as { result: { tools: Array<{ name: string; inputSchema: Record<string, unknown> }> } }).result.tools;
  const decisionOf = (response: { body: Record<string, unknown> | null }) => {
    const result = (response.body as { result: { content: Array<{ type: string; text: string }>; isError: boolean; structuredContent?: unknown } }).result;
    expect(result.isError).toBe(false);
    expect(result.structuredContent).toBeUndefined();
    expect(result.content).toHaveLength(1);
    expect(result.content[0]!.type).toBe('text');
    return JSON.parse(result.content[0]!.text) as Record<string, unknown>;
  };

  it('is listed only for a capability with an approval binding and a broker, and never in the public catalog', async () => {
    const interactive = approvalHarness();
    const tools = await listed(interactive);
    expect(tools.map((tool) => tool.name)).toEqual(['list_targets', 'query_target_messages', 'query_target_messages_by_time', 'list_active_chats', 'request_permission']);
    expect(tools.at(-1)!.inputSchema).toMatchObject({ type: 'object', required: ['tool_name', 'input'],
      properties: { tool_name: { type: 'string' }, input: { type: 'object' }, tool_use_id: { type: 'string' } } });
    await interactive.cleanup();
    for (const options of [{ approval: false }, { broker: false }]) {
      const h = approvalHarness(options);
      expect((await listed(h)).map((tool) => tool.name)).not.toContain('request_permission');
      await h.cleanup();
    }
    expect(MCP_TOOL_DEFINITIONS.map((tool) => tool.name as string)).not.toContain('request_permission');
    expect(MCP_TOOL_NAMES as readonly string[]).not.toContain('request_permission');
  });

  it('returns the broker decision as JSON text for allow and deny', async () => {
    const h = approvalHarness();
    const allowCall = h.ask({ tool_name: 'Bash', input: { command: 'npm test' }, tool_use_id: 'toolu_1' });
    await vi.waitFor(() => expect(h.broker.listPending()).toHaveLength(1));
    expect(h.requestSpy).toHaveBeenCalledWith(expect.objectContaining({ jobId: 'job-1', sessionKey: binding.sessionKey,
      workspaceRoot: binding.workspaceRoot, tool: 'Bash', input: { command: 'npm test' } }));
    await h.broker.decide(h.broker.listPending()[0]!.approvalId, 'once');
    const allowed = await allowCall;
    expect(allowed.httpStatus).toBe(200);
    expect(decisionOf(allowed)).toEqual({ behavior: 'allow', updatedInput: { command: 'npm test' } });

    const denyCall = h.ask({ tool_name: 'Bash', input: { command: 'rm -rf build' } });
    await vi.waitFor(() => expect(h.broker.listPending()).toHaveLength(1));
    await h.broker.decide(h.broker.listPending()[0]!.approvalId, 'deny');
    expect(decisionOf(await denyCall)).toEqual({ behavior: 'deny', message: 'The user denied this tool use.' });
    await h.cleanup();
  });

  it('denies without asking when the capability is not interactive or no broker exists', async () => {
    for (const options of [{ approval: false }, { broker: false }]) {
      const h = approvalHarness(options);
      const response = await h.ask({ tool_name: 'Bash', input: { command: 'ls' } });
      expect(response.httpStatus).toBe(200);
      expect(decisionOf(response)).toEqual({ behavior: 'deny', message: 'Interactive approval is unavailable.' });
      expect(h.requestSpy).not.toHaveBeenCalled();
      await h.cleanup();
    }
  });

  it('rejects invalid arguments with JSON-RPC -32602', async () => {
    const h = approvalHarness();
    for (const args of [
      undefined, [], { input: {} }, { tool_name: '', input: {} }, { tool_name: 'x'.repeat(129), input: {} }, { tool_name: 7, input: {} },
      { tool_name: 'Bash' }, { tool_name: 'Bash', input: [] }, { tool_name: 'Bash', input: 'ls' }, { tool_name: 'Bash', input: null },
      { tool_name: 'Bash', input: {}, tool_use_id: 5 },
    ]) {
      const response = await h.ask(args);
      expect(response.httpStatus).toBe(400);
      expect(response.body).toMatchObject({ error: { code: -32602 } });
    }
    expect(h.requestSpy).not.toHaveBeenCalled();
    // 128 characters is still a valid tool name (an unknown tool is decided by the broker, here auto-asked).
    const boundary = h.ask({ tool_name: 'x'.repeat(128), input: {} });
    await vi.waitFor(() => expect(h.broker.listPending()).toHaveLength(1));
    await h.broker.decide(h.broker.listPending()[0]!.approvalId, 'deny');
    expect((await boundary).httpStatus).toBe(200);
    await h.cleanup();
  });

  it('settles a pending approval as cancelled when the capability is released, and answers with a JSON-RPC error', async () => {
    const h = approvalHarness();
    const call = h.ask({ tool_name: 'Bash', input: { command: 'sleep 1' } });
    await vi.waitFor(() => expect(h.broker.listPending()).toHaveLength(1));
    h.service.internalCapabilities.release('job-1');
    const response = await call;
    expect(h.broker.listPending()).toEqual([]);
    expect(h.brokerEvents.at(-1)).toMatchObject({ type: 'resolved', jobId: 'job-1', outcome: 'cancelled' });
    // The broker resolves deny, then the final capability check rejects the released job: an error, never an allow.
    expect(response.httpStatus).toBe(403);
    expect(response.body).toMatchObject({ error: { data: { code: 'SCOPE_DENIED' } } });
    expect(JSON.stringify(response.body)).not.toContain('behavior');
    expect(h.audits.some((entry) => entry.principalId === 'internal:job:released')).toBe(true);
    await h.cleanup();
  });

  it('is not callable through the external MCP path', async () => {
    const h = approvalHarness();
    const response = await h.service.handleExternalJsonRpc({
      jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'request_permission', arguments: { tool_name: 'Bash', input: { command: 'ls' } } },
    });
    expect(response.httpStatus).toBe(400);
    expect(response.body).toMatchObject({ error: { code: -32602 } });
    expect(JSON.stringify(response.body)).not.toContain('behavior');
    expect(h.requestSpy).not.toHaveBeenCalled();
    await h.cleanup();
  });
});
