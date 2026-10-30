import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Pool } from 'pg';
import { McpListTargetsInputSchema, McpQueryTargetMessagesByTimeInputSchema, McpQueryTargetMessagesInputSchema, MCP_TOOL_EFFECTS, SEND_TO_TARGET_TOOL_NAME, type AgentEvent, type AgentRunRequest } from '@line-agent/contracts';
import { AccountRepository, AdminRepository, FriendWhitelistRepository, McpTokenRepository, MessageRepository } from '@line-agent/database';
import { createTestDatabase } from '../../../../../packages/database/src/test-database.js';
import { MCP_TOOL_DEFINITIONS, McpService, numberMcpTargets } from './mcp-service.js';
import { McpHttpServer } from './mcp-http-server.js';
import { createConnectedFacade, type IntegratedAgent, type IntegratedWorkerGateway } from '../connected-facade.js';

const database = process.env.TEST_DATABASE_URL ? describe : describe.skip;

database('McpService, McpHttpServer loopback transport, ConnectedFacade IPC, and internal Agent integration', () => {
  let pool: Pool;
  let closeDatabase: () => Promise<void>;
  let tokens: McpTokenRepository;
  let messages: MessageRepository;
  let accounts: AccountRepository;
  let admins: AdminRepository;

  beforeAll(async () => {
    ({ pool, close: closeDatabase } = await createTestDatabase());
    tokens = new McpTokenRepository(pool);
    messages = new MessageRepository(pool);
    accounts = new AccountRepository(pool);
    admins = new AdminRepository(pool);

    await accounts.ensureAccount('account-admin');
    await accounts.setOwnMid('account-admin', 'mid-admin-1');
    await pool.query(
      "UPDATE line_accounts SET display_name = 'Admin Monitored LINE', mode = 'MONITOR_ONLY', product_role = 'PRIMARY_ADMIN' WHERE account_id = 'account-admin'",
    );

    await accounts.ensureAccount('account-agent');
    await accounts.setOwnMid('account-agent', 'mid-agent-1');
    await pool.query(
      "UPDATE line_accounts SET display_name = 'Agent LINE', mode = 'ACTIVE_CONTROL', product_role = 'AGENT' WHERE account_id = 'account-agent'",
    );

    await admins.bindPrimary('account-agent', 'chat-admin', 'mid-admin-1');

    await messages.upsertConversationCatalog('account-admin', [
      {
        chatType: 'direct',
        chatId: 'direct-a',
        title: 'A direct',
        members: [],
      },
      {
        chatType: 'room',
        chatId: 'room-a',
        title: 'A room',
        members: [],
      },
      {
        chatType: 'group',
        chatId: 'group-ops',
        title: 'Engineering Room',
        members: [{ memberId: 'u-alice', displayName: 'Alice' }],
      },
      {
        chatType: 'group',
        chatId: 'group-alpha',
        title: 'Alpha Group',
        members: [],
      },
      {
        chatType: 'community',
        chatId: 'community-a',
        title: 'A community',
        members: [],
      },
    ]);

    await pool.query(
      `INSERT INTO messages (account_id, message_id, event_id, chat_id, chat_type, sender_id, kind, text_content, ingestion_source, occurred_at, raw)
       VALUES
         ('account-admin', 'm-1', 'e-1', 'group-ops', 'group', 'u-alice', 'text', 'Deploy status ok with secret api_key=sk-secretvalue12345', 'live', '2026-10-16T08:00:00.000Z', '{}'::jsonb),
         ('account-admin', 'm-2', 'e-2', 'group-ops', 'group', 'u-alice', 'text', 'Follow-up on Oct 17', 'live', '2026-10-17T11:00:00.000Z', '{}'::jsonb),
         ('account-admin', 'm-community', 'e-community', 'community-a', 'community', 'u-alice', 'text', 'Community archived message', 'live', '2026-10-16T09:00:00.000Z', '{}'::jsonb)`,
    );
  });

  afterAll(async () => {
    await closeDatabase?.();
  });

  it('serves MCP JSON-RPC 2.0 over 127.0.0.1 loopback HTTP with scoped tools/list, tools/call, redaction, and auth checks', async () => {
    const service = new McpService({ pool, tokens, messages });
    const server = new McpHttpServer(service, { port: 0 });
    await server.start();
    const status = await service.getStatus(server.status());
    expect(status.running).toBe(true);
    expect(status.host).toBe('127.0.0.1');
    expect(status.endpoint).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/mcp$/);
    const endpoint = status.endpoint!;

    try {
      // 1. No bearer token is needed: ping works.
      const noAuthResp = await fetch(endpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' }),
      });
      expect(noAuthResp.status).toBe(200);

      // 2. A cross-site request (Origin header) is refused before the service runs.
      const originResp = await fetch(endpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/json', origin: 'https://evil.example' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' }),
      });
      expect(originResp.status).toBe(403);

      // 3. An old client config can still send a la_mcp_ bearer value. The server ignores it.
      const headers = {
        'content-type': 'application/json',
        authorization: 'Bearer la_mcp_legacy-value-is-ignored',
      };

      // 4. initialize & tools/list return every external tool (the chat resource tools are off in this service)
      const initResp = await fetch(endpoint, {
        method: 'POST',
        headers,
        body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'initialize', params: {} }),
      });
      expect(initResp.status).toBe(200);
      const initBody = (await initResp.json()) as { result: { serverInfo: { name: string } } };
      expect(initBody.result.serverInfo.name).toBe('line-agent-mcp');

      const listToolsResp = await fetch(endpoint, {
        method: 'POST',
        headers,
        body: JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'tools/list' }),
      });
      const listToolsBody = (await listToolsResp.json()) as {
        result: { tools: Array<{ name: string }> };
      };
      expect(listToolsBody.result.tools.map((t) => t.name)).toEqual([
        'list_targets',
        'query_target_messages',
        'query_target_messages_by_time',
      ]);
      const listTargetsResp = await fetch(endpoint, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 31,
          method: 'tools/call',
          params: { name: 'list_targets', arguments: {} },
        }),
      });
      const listed = (await listTargetsResp.json()) as {
        result: { structuredContent: { targets: Array<{ no: number; accountId: string; chatType: string; conversationTitle: string | null; chatId: string }> } };
      };
      // The local client sees the AGENT and PRIMARY_ADMIN accounts; the catalog rows belong to the admin account.
      expect(listed.result.structuredContent.targets.filter((target) => target.accountId === 'account-admin')
        .map(({ chatType, conversationTitle }) => [chatType, conversationTitle])).toEqual([
        ['community', 'A community'],
        ['group', 'Alpha Group'],
        ['group', 'Engineering Room'],
        ['room', 'A room'],
        ['direct', 'A direct'],
      ]);
      const community = listed.result.structuredContent.targets.find((target) => target.chatType === 'community')!;
      const communityKey = { accountId: 'account-admin', chatType: community.chatType, chatId: community.chatId };
      expect(McpListTargetsInputSchema.safeParse({ chatType: community.chatType }).success).toBe(true);
      expect(McpQueryTargetMessagesInputSchema.safeParse(communityKey).success).toBe(true);
      expect(McpQueryTargetMessagesByTimeInputSchema.safeParse({ ...communityKey, from: '2026-10-16' }).success).toBe(true);
      const listDescription = MCP_TOOL_DEFINITIONS.find((tool) => tool.name === 'list_targets')!.description;
      expect(listDescription).toContain('numbered list using no');
      expect(listDescription).toContain('most recent list_targets result');
      const filteredListResp = await fetch(endpoint, {
        method: 'POST', headers,
        body: JSON.stringify({ jsonrpc: '2.0', id: 32, method: 'tools/call', params: { name: 'list_targets', arguments: { query: 'Engineering', limit: 1 } } }),
      });
      const filteredList = await filteredListResp.json() as { result: { structuredContent: { targets: Array<{ no: number; conversationTitle: string | null }> } } };
      expect(filteredList.result.structuredContent.targets.map(({ no, conversationTitle }) => [no, conversationTitle])).toEqual([[1, 'Engineering Room']]);
      const tiedTargets = [
        { accountId: 'account-admin', chatType: 'group', chatId: 'same-chat', conversationTitle: 'Same' },
        { accountId: 'account-admin', chatType: 'community', chatId: 'same-chat', conversationTitle: 'Same' },
      ];
      expect(numberMcpTargets(tiedTargets).map(({ chatType, no }) => [chatType, no]))
        .toEqual(numberMcpTargets([...tiedTargets].reverse()).map(({ chatType, no }) => [chatType, no]));
      for (const toolName of ['list_targets', 'query_target_messages', 'query_target_messages_by_time'] as const) {
        const definition = MCP_TOOL_DEFINITIONS.find((tool) => tool.name === toolName)!;
        const properties = definition.inputSchema.properties as Record<string, { enum?: string[] }>;
        expect(properties.chatType?.enum).toContain('community');
      }

      // 4. tools/call query_target_messages returns redacted message text
      const callResp = await fetch(endpoint, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 4,
          method: 'tools/call',
          params: {
            name: 'query_target_messages',
            arguments: { target: 'Alice' },
          },
        }),
      });
      expect(callResp.status).toBe(200);
      const callBody = (await callResp.json()) as {
        result: { structuredContent: { messages: Array<{ messageId: string; text: string }> } };
      };
      const m1 = callBody.result.structuredContent.messages.find((m) => m.messageId === 'm-1')!;
      expect(m1.text).toContain('[REDACTED]');
      expect(m1.text).not.toContain('sk-secretvalue12345');

      for (const [id, name, args] of [
        [41, 'query_target_messages', communityKey],
        [42, 'query_target_messages_by_time', { ...communityKey, from: '2026-10-16', to: '2026-10-16' }],
      ] as const) {
        const communityResp = await fetch(endpoint, {
          method: 'POST', headers,
          body: JSON.stringify({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } }),
        });
        expect(communityResp.status).toBe(200);
        const communityBody = await communityResp.json() as { result: { structuredContent: { messages: Array<{ messageId: string }> } } };
        expect(communityBody.result.structuredContent.messages.map((message) => message.messageId)).toContain('m-community');
      }

      // 5. An internal-only tool (LINE send) is not an external tool: refused, never executed.
      const internalOnlyResp = await fetch(endpoint, {
        method: 'POST', headers,
        body: JSON.stringify({ jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: SEND_TO_TARGET_TOOL_NAME, arguments: {} } }),
      });
      expect(internalOnlyResp.status).toBe(400);

      // 6. A tool without the 'read' effect needs operator approval, so the external endpoint refuses it.
      const effects = MCP_TOOL_EFFECTS as Record<string, 'read' | 'effect'>;
      effects.list_targets = 'effect';
      try {
        const approvalResp = await fetch(endpoint, {
          method: 'POST', headers,
          body: JSON.stringify({ jsonrpc: '2.0', id: 6, method: 'tools/call', params: { name: 'list_targets', arguments: {} } }),
        });
        expect(approvalResp.status).toBe(403);
        expect(await approvalResp.json()).toMatchObject({ error: { data: { code: 'APPROVAL_REQUIRED' } } });
      } finally {
        effects.list_targets = 'read';
      }
      const auditRows = await tokens.listAuditRecords(50);
      expect(auditRows.some((row) => row.principalId === 'local-client' && row.tokenId === null && row.action === 'TOOL_CALLED' && row.disposition === 'ALLOWED')).toBe(true);
      expect(auditRows.some((row) => row.principalId === 'local-client' && row.tokenId === null && row.disposition === 'APPROVAL_REQUIRED')).toBe(true);

      // 7. The repository refuses an internal-only tool name on its own.
      await expect(tokens.executeLocalClientRead({
        toolName: SEND_TO_TARGET_TOOL_NAME,
        execute: async () => ({ data: true }),
      })).rejects.toMatchObject({ code: 'SCOPE_DENIED' });
    } finally {
      await server.shutdown();
      await service.shutdown();
    }
  });

  it('enforces 64 KiB body limit (413), MAX_CONCURRENT_MCP_REQUESTS = 8 (429), and per-token rate limit', async () => {
    const service = new McpService({
      pool,
      tokens,
      messages,
      maxConcurrentRequests: 8,
      rateLimitPerMinute: 3,
    });
    const server = new McpHttpServer(service, { port: 0 });
    await server.start();
    const endpoint = server.status().endpoint!;

    try {
      const headers = { 'content-type': 'application/json' };

      // 1. Oversized body (> 64 KiB) returns 413
      const hugePayload = JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: { name: 'list_targets', arguments: { query: 'x'.repeat(70_000) } },
      });
      const oversizeResp = await fetch(endpoint, {
        method: 'POST',
        headers,
        body: hugePayload,
      });
      expect(oversizeResp.status).toBe(413);

      // 2. One shared rate limit for all external requests (configured at 3 requests/minute for this test)
      for (let i = 0; i < 3; i++) {
        const okResp = await fetch(endpoint, {
          method: 'POST',
          headers,
          body: JSON.stringify({
            jsonrpc: '2.0',
            id: 10 + i,
            method: 'tools/call',
            params: { name: 'list_targets', arguments: {} },
          }),
        });
        expect(okResp.status).toBe(200);
      }
      const rateLimitedResp = await fetch(endpoint, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 99,
          method: 'tools/call',
          params: { name: 'list_targets', arguments: {} },
        }),
      });
      expect(rateLimitedResp.status).toBe(429);
    } finally {
      await server.shutdown();
      await service.shutdown();
    }
  });

  it('wires MCP IPC and internal Agent /mcp prompt enrichment in ConnectedFacade while blocking non-admin friend jobs', async () => {
    const attachmentRoot = await mkdtemp(join(tmpdir(), 'mcp-facade-test-'));
    await mkdir(join(attachmentRoot, 'client-config'), { recursive: true });
    const capturedPrompts: string[] = [];
    const workers: IntegratedWorkerGateway = {
      onEvent() {},
      async start(_id, binding) {
        return binding;
      },
      async binding() {
        return null;
      },
      isCurrentActiveControlBinding() {
        return false;
      },
      isCurrentManualSendBinding() {
        return false;
      },
      async send(command) {
        return {
          type: 'sendResult',
          accountId: command.accountId,
          workerInstanceId: command.workerInstanceId,
          controlEpoch: command.controlEpoch,
          requestId: 'r-1',
          status: 'sent',
          messageId: 'm-out',
          error: null,
        };
      },
      async sendManual(command) {
        return {
          type: 'sendResult',
          accountId: command.accountId,
          workerInstanceId: command.workerInstanceId,
          controlEpoch: command.controlEpoch,
          requestId: command.requestId,
          status: 'sent',
          messageId: 'm-out',
          error: null,
        };
      },
      async checkFriendRelation(command) {
        return {
          type: 'friendRelationResult',
          accountId: command.accountId,
          workerInstanceId: command.workerInstanceId,
          controlEpoch: command.controlEpoch,
          requestId: command.requestId,
          targetMid: command.targetMid,
          status: 'friend',
          error: null,
        };
      },
      async addFriendByMid(command) {
        return {
          type: 'addFriendResult',
          accountId: command.accountId,
          workerInstanceId: command.workerInstanceId,
          controlEpoch: command.controlEpoch,
          requestId: command.requestId,
          targetMid: command.targetMid,
          status: 'added',
          error: null,
        };
      },
      async download(command) {
        return {
          type: 'attachmentResult',
          attachmentId: command.attachmentId,
          attemptToken: command.attemptToken,
          accountId: command.accountId,
          chatType: command.chatType,
          chatId: command.chatId,
          workerInstanceId: command.workerInstanceId,
          status: 'failed',
          error: 'not used',
        };
      },
      async waitModeAck() {
        return true;
      },
      async stop() {},
      async stopBinding() {},
      async shutdown() {},
    };

    const agent: IntegratedAgent = {
      async *run(request: AgentRunRequest): AsyncIterable<AgentEvent> {
        capturedPrompts.push(request.prompt);
        yield {
          type: 'started',
          externalSessionId: 'sess-1',
          workspacePath: request.workspacePath,
        };
        yield { type: 'completed', finalText: 'Analyzed MCP data.' };
      },
      async cancel() {},
      async getAuthStatus() {
        return { status: 'authenticated' };
      },
      async agentRefreshStatus() {
        return { status: 'authenticated' };
      },
      async openLogin() {
        return { ok: true };
      },
      async logout() {
        return { ok: true };
      },
      async shutdown() {},
    };

    const facade = await createConnectedFacade({
      pool,
      workers,
      agent,
      attachmentRoot,
      runMigrations: false,
      mcpHttpPort: 0,
      mcpLocalClientPaths: { claudeDesktop: join(attachmentRoot, 'client-config', 'claude_desktop_config.json'), codex: join(attachmentRoot, 'client-config', 'config.toml') },
    });

    try {
      await facade.dispatch({
        type: 'setWorkspace',
        requestId: 'ws-1',
        workspacePath: attachmentRoot,
      });

      // 1. IPC mcpGetStatus
      const statusRes = await facade.dispatch({ type: 'mcpGetStatus', requestId: 'status-1' });
      expect(statusRes).toMatchObject({
        type: 'mcpGetStatus',
        ok: true,
        status: { running: true, host: '127.0.0.1' },
      });

      // 2. Local client connect writes a token-less entry.
      const localConnect = await facade.dispatch({ type: 'mcpLocalClientConnect', requestId: 'local-connect', client: 'claude-desktop' });
      expect(localConnect.type).toBe('mcpLocalClientConnect');
      if (localConnect.type !== 'mcpLocalClientConnect') throw new Error('Expected local MCP client connection');
      expect(localConnect.status).toEqual({ client: 'claude-desktop', installed: true, connected: true });
      const localConfigPath = join(attachmentRoot, 'client-config', 'claude_desktop_config.json');
      const localEntry = JSON.parse(await readFile(localConfigPath, 'utf8')).mcpServers.linejs;
      expect(localEntry.env).toEqual({ ELECTRON_RUN_AS_NODE: '1', LINEJS_MCP_URL: expect.stringMatching(/^http:\/\/127\.0\.0\.1:\d+\/mcp$/) });
      const localDisconnect = await facade.dispatch({ type: 'mcpLocalClientDisconnect', requestId: 'local-disconnect', client: 'claude-desktop' });
      expect(localDisconnect).toMatchObject({ type: 'mcpLocalClientDisconnect', ok: true });
      expect(JSON.parse(await readFile(localConfigPath, 'utf8')).mcpServers).toBeUndefined();

      // 3. Direct internal Agent tool call via mcpCallInternalTool IPC (no bearer token needed)
      const internalCallRes = await facade.dispatch({
        type: 'mcpCallInternalTool',
        requestId: 'int-1',
        tool: {
          name: 'query_target_messages_by_time',
          arguments: {
            target: 'Alice',
            from: '2026-10-16',
            to: '2026-10-16',
          },
        },
      });
      expect(internalCallRes.type).toBe('mcpCallInternalTool');
      if (internalCallRes.type !== 'mcpCallInternalTool') throw new Error('Expected mcpCallInternalTool');
      if (internalCallRes.result.toolName !== 'query_target_messages_by_time') {
        throw new Error('Expected query_target_messages_by_time result');
      }
      expect(internalCallRes.result.messages.map((m) => m.messageId)).toEqual(['m-1']);

      const internalCommunityQuery = await facade.dispatch({
        type: 'mcpCallInternalTool', requestId: 'int-community-query',
        tool: { name: 'query_target_messages', arguments: { accountId: 'account-admin', chatType: 'community', chatId: 'community-a' } },
      });
      const internalCommunityTimeQuery = await facade.dispatch({
        type: 'mcpCallInternalTool', requestId: 'int-community-time',
        tool: { name: 'query_target_messages_by_time', arguments: { accountId: 'account-admin', chatType: 'community', chatId: 'community-a', from: '2026-10-16', to: '2026-10-16' } },
      });
      for (const [communityResult, name] of [
        [internalCommunityQuery, 'query_target_messages'],
        [internalCommunityTimeQuery, 'query_target_messages_by_time'],
      ] as const) {
        expect(communityResult.type).toBe('mcpCallInternalTool');
        if (communityResult.type !== 'mcpCallInternalTool') throw new Error('Expected mcpCallInternalTool');
        expect(communityResult.result).toMatchObject({ toolName: name, messages: [expect.objectContaining({ messageId: 'm-community', chatType: 'community', chatId: 'community-a' })] });
      }

      // 4. Submit UI prompt with /mcp query_target_messages -> AgentService enriches prompt with MCP data
      const submitRes = await facade.dispatch({
        type: 'submitAgentRoomPrompt',
        requestId: 'ui-mcp-1',
        provider: 'claude',
        prompt: '/mcp query_target_messages {"target":"Alice"} 請總結訊息',
      });
      expect(submitRes.type).toBe('submitAgentRoomPrompt');

      const deadline = Date.now() + 3000;
      while (capturedPrompts.length === 0 && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 25));
      }
      expect(capturedPrompts[0]).toContain('m-1');
      expect(capturedPrompts[0]).toContain('Engineering Room');

      // 5. Non-admin whitelisted friend LINE job using /mcp is chat-scoped to its own conversation
      const friendMsgId = `friend-msg-${randomUUID()}`;
      const friendJobId = randomUUID();
      await pool.query("UPDATE account_control SET control_epoch = 1 WHERE singleton = true");
      await pool.query("UPDATE line_accounts SET mode = 'ACTIVE_CONTROL' WHERE account_id = 'account-agent'");
      await pool.query(
        `INSERT INTO conversations (account_id, chat_type, chat_id, title)
         VALUES ('account-agent', 'direct', 'chat-friend', 'Friend')
         ON CONFLICT DO NOTHING`,
      );
      await pool.query(
        `INSERT INTO messages (account_id, message_id, event_id, chat_id, chat_type, sender_id, kind, text_content, ingestion_source, occurred_at, raw)
         VALUES ('account-agent', $1, $2, 'chat-friend', 'direct', 'u-friend', 'text', '/mcp list_targets', 'live', now(), '{}'::jsonb)`,
        [friendMsgId, `ev-${friendMsgId}`],
      );
      await pool.query(
        `INSERT INTO agent_sessions (account_id, chat_type, chat_id, provider, source_type)
         VALUES ('account-agent', 'direct', 'chat-friend', 'claude', 'line')
         ON CONFLICT DO NOTHING`,
      );
      // Real ACTIVE whitelist grant: MCP revalidates it at call time (a fake grant id would be denied).
      const friendGrant = await new FriendWhitelistRepository(pool).activate('account-agent', 'u-friend', 'test-admin');
      await pool.query(
        `INSERT INTO agent_jobs (job_id, account_id, chat_type, chat_id, provider, source_type, source_message_id, prompt, workspace_path, generation, creation_epoch, status, direct_friend_grant_id, direct_friend_grant_version)
         VALUES ($1, 'account-agent', 'direct', 'chat-friend', 'claude', 'line', $2, '/mcp list_targets', $3, 0, 1, 'failed', $4, $5)`,
        [friendJobId, friendMsgId, attachmentRoot, friendGrant.grantId, friendGrant.version],
      );

      // Trigger retry/kick or wait for recovery
      await facade.dispatch({
        type: 'retryJob',
        requestId: 'retry-friend',
        accountId: 'account-agent',
        chatType: 'direct',
        chatId: 'chat-friend',
        jobId: friendJobId,
      });
      // Wait for queued friend job to be processed
      const friendDeadline = Date.now() + 3000;
      let friendStatus = 'queued';
      while (Date.now() < friendDeadline) {
        const row = await pool.query<{ status: string }>(
          'SELECT status FROM agent_jobs WHERE job_id = $1',
          [friendJobId],
        );
        friendStatus = row.rows[0]?.status ?? 'queued';
        if (friendStatus === 'failed' || friendStatus === 'completed') break;
        await new Promise((r) => setTimeout(r, 25));
      }
      // Changed from the old fail-closed expectation: a granted friend job now runs, but its /mcp
      // list_targets result is limited to its own chat (no other conversation or account leaks).
      expect(friendStatus).toBe('completed');
      expect(capturedPrompts).toHaveLength(2);
      expect(capturedPrompts[1]).toContain('chat-friend');
      expect(capturedPrompts[1]).not.toContain('Engineering Room');
      expect(capturedPrompts[1]).not.toContain('account-admin');
    } finally {
      await facade.shutdown();
      await rm(attachmentRoot, { recursive: true, force: true });
    }
  });
});
