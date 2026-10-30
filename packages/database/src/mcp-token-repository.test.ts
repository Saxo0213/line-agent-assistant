import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { MCP_TOOL_EFFECTS, MCP_TOOL_NAMES } from '@line-agent/contracts';
import type { Pool } from 'pg';
import { createTestDatabase } from './test-database.js';
import { AccountRepository } from './account-repository.js';
import { AdminRepository } from './admin-repository.js';
import { MessageRepository } from './message-repository.js';
import { FriendWhitelistRepository } from './friend-whitelist-repository.js';
import { RoomActivationRepository } from './room-activation-repository.js';
import { McpDomainError, McpTokenRepository } from './mcp-token-repository.js';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadMigrations, migrate } from './migrate.js';

const database = process.env.TEST_DATABASE_URL ? describe : describe.skip;

database('managed MCP scopes across real Agent replacement', () => {
  let pool: Pool;
  let close: () => Promise<void>;
  let accounts: AccountRepository;
  let tokens: McpTokenRepository;
  let agentId: string;
  beforeEach(async () => {
    ({ pool, close } = await createTestDatabase());
    accounts = new AccountRepository(pool);
    tokens = new McpTokenRepository(pool);
    agentId = (await accounts.reserveAccountSlot()).accountId;
    await accounts.setOwnMid(agentId, `u${'a'.repeat(32)}`);
    const adminMid = `u${'b'.repeat(32)}`;
    await accounts.bindPrimaryAdministrator(agentId, adminMid, adminMid);
  });
  afterEach(async () => { await close?.(); });
  const read = (requestedAccountId?: string) => tokens.executeLocalClientRead({
    toolName: 'list_targets', ...(requestedAccountId ? { requestedAccountId } : {}),
    execute: async ({ authorizedAccountIds }) => ({ data: authorizedAccountIds }),
  });
  const replace = async () => {
    const replaced = await accounts.replaceAgentAccount(agentId, (await accounts.getControlState()).controlEpoch);
    if (!replaced.ok) throw new Error(replaced.code);
    expect((await pool.query('SELECT count(*) FROM account_administrators WHERE account_id=$1', [agentId])).rows[0].count).toBe('0');
    return replaced.account.accountId;
  };

  it.each(['request-first', 'replacement-first'] as const)('resolves the AGENT role to the replacement account without a token (%s)', async (order) => {
    if (order === 'request-first') expect(await read()).toContain(agentId);
    const replacementId = await replace();
    expect(await read(replacementId)).toEqual([replacementId]);
    await expect(read(agentId)).rejects.toMatchObject({ code: 'SCOPE_DENIED' });
    const afterReplace = await read();
    expect(afterReplace).toContain(replacementId);
    expect(afterReplace).not.toContain(agentId);
  });

  it('rejects an obsolete result when a real replacement commits before the final authorization fence', async () => {
    await expect(tokens.executeLocalClientRead({ toolName: 'list_targets',
      execute: async ({ authorizedAccountIds }) => {
        expect(authorizedAccountIds).toContain(agentId);
        await replace();
        return { data: 'obsolete account data' };
      } })).rejects.toMatchObject({ code: 'CONTROL_CHANGED' });
  });

  it('finishes both-role MCP fencing alongside an Admin-source-Agent writer when the Agent ID sorts first', async () => {
    await pool.query('TRUNCATE line_accounts CASCADE');
    const adminMid = `u${'b'.repeat(32)}`;
    await pool.query(`INSERT INTO line_accounts(account_id,product_role,own_mid,connection_mode)
      VALUES('a-agent','AGENT',$1,'SYSTEM_LOGIN'),('z-admin','PRIMARY_ADMIN',$2,'EXTERNAL_MONITOR')`,
    [`u${'a'.repeat(32)}`, adminMid]);
    await accounts.bindPrimaryAdministrator('a-agent', adminMid, adminMid);
    const sourceId = randomUUID();
    await pool.query(`INSERT INTO line_account_sources(source_id,account_id,source_type,generation,identity_digest,
      verified_account_mid,state,read_capability,write_capability)
      VALUES($1,'z-admin','EXTERNAL_MONITOR',1,repeat('a',64),$2,'ACTIVE',true,false)`, [sourceId, adminMid]);
    const writer = await pool.connect();
    let request: Promise<unknown> | undefined;
    try {
      await writer.query('BEGIN');
      await writer.query("SET LOCAL lock_timeout='500ms'");
      // ExternalMonitorRepository writes in Primary Admin -> source -> Agent order.
      await writer.query("SELECT account_id FROM line_accounts WHERE account_id='z-admin' FOR UPDATE");
      let reached!: (pid: number) => void;
      const executed = new Promise<number>((resolve) => { reached = resolve; });
      request = tokens.executeLocalClientRead({ toolName: 'list_targets',
        execute: async ({ client, authorizedAccountIds }) => {
          reached((await client.query<{ pid: number }>('SELECT pg_backend_pid() pid')).rows[0]!.pid);
          return { data: authorizedAccountIds };
        } });
      void request.catch(() => undefined);
      const pid = await executed;
      await vi.waitFor(async () => {
        const state = (await pool.query('SELECT wait_event_type,query FROM pg_stat_activity WHERE pid=$1', [pid])).rows[0];
        expect(state.wait_event_type).toBe('Lock');
        expect(state.query).toContain('SELECT account_id,product_role,mode');
      });
      await writer.query('SELECT source_id FROM line_account_sources WHERE source_id=$1 FOR UPDATE', [sourceId]);
      // This succeeds only if the waiting MCP fence has not already locked the lexically earlier Agent.
      await writer.query("SELECT account_id FROM line_accounts WHERE account_id='a-agent' FOR UPDATE");
      await writer.query("UPDATE line_accounts SET last_synced_at=now() WHERE account_id='z-admin'");
      await writer.query('COMMIT');
      await expect(request).resolves.toEqual(['a-agent', 'z-admin']);
    } finally {
      await writer.query('ROLLBACK').catch(() => undefined);
      writer.release();
      await request?.catch(() => undefined);
    }
  });
});

database('MCP control and approval disposition migration', () => {
  it('applies migration 042 with existing audit rows and accepts both new dispositions', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'mcp-control-migration-'));
    let close: (() => Promise<void>) | undefined;
    try {
      for (const migration of await loadMigrations()) {
        if (migration.name !== '042_mcp_control_approval_dispositions.sql') await writeFile(join(directory, migration.name), migration.sql);
      }
      const database = await createTestDatabase(directory);
      close = database.close;
      await database.pool.query(`INSERT INTO mcp_agent_audit
        (principal_id, initiator, action, disposition) VALUES ('existing', 'external_agent', 'AUTH_REJECTED', 'SCOPE_DENIED')`);
      await migrate(database.pool);
      for (const disposition of ['CONTROL_CHANGED', 'APPROVAL_REQUIRED']) {
        await database.pool.query(`INSERT INTO mcp_agent_audit
          (principal_id, initiator, action, disposition) VALUES ('new', 'external_agent', 'AUTH_REJECTED', $1)`, [disposition]);
      }
      expect((await database.pool.query('SELECT disposition FROM mcp_agent_audit ORDER BY audit_id')).rows.map((row) => row.disposition))
        .toEqual(['SCOPE_DENIED', 'CONTROL_CHANGED', 'APPROVAL_REQUIRED']);
    } finally {
      await close?.();
      await rm(directory, { recursive: true, force: true });
    }
  });
});

database('MCP token & audit repository and target/time message queries', () => {
  let pool: Pool;
  let close: () => Promise<void>;
  let tokens: McpTokenRepository;
  let messages: MessageRepository;
  let accounts: AccountRepository;
  let admins: AdminRepository;

  beforeAll(async () => {
    ({ pool, close } = await createTestDatabase());
    tokens = new McpTokenRepository(pool);
    messages = new MessageRepository(pool);
    accounts = new AccountRepository(pool);
    admins = new AdminRepository(pool);

    // Seed two LINE accounts: account-admin (PRIMARY_ADMIN monitored) and account-agent (AGENT active control)
    await accounts.ensureAccount('account-admin');
    await accounts.setOwnMid('account-admin', 'mid-primary-admin');
    await pool.query(
      "UPDATE line_accounts SET display_name = 'Admin Monitored LINE', mode = 'MONITOR_ONLY', product_role = 'PRIMARY_ADMIN' WHERE account_id = 'account-admin'",
    );

    await accounts.ensureAccount('account-agent');
    await accounts.setOwnMid('account-agent', 'mid-agent-bot');
    await pool.query(
      "UPDATE line_accounts SET display_name = 'Agent LINE', mode = 'ACTIVE_CONTROL', product_role = 'AGENT' WHERE account_id = 'account-agent'",
    );

    // Bind primary administrator on account-agent to mid-primary-admin
    await admins.bindPrimary('account-agent', 'chat-admin-direct', 'mid-primary-admin');

    // Seed conversations and members in account-admin
    await messages.upsertConversationCatalog('account-admin', [
      {
        chatType: 'group',
        chatId: 'group-alpha',
        title: 'Alpha Operations',
        members: [
          { memberId: 'user-alice', displayName: 'Alice Chen' },
          { memberId: 'user-bob', displayName: 'Bob Lin' },
        ],
      },
      {
        chatType: 'direct',
        chatId: 'chat-alice-direct',
        title: 'Alice Direct',
        members: [{ memberId: 'user-alice', displayName: 'Alice Chen' }],
      },
    ]);

    // Seed conversations and members in account-agent
    await messages.upsertConversationCatalog('account-agent', [
      {
        chatType: 'group',
        chatId: 'group-alpha',
        title: 'Alpha Operations',
        members: [{ memberId: 'user-alice', displayName: 'Alice Chen' }],
      },
      {
        chatType: 'direct',
        chatId: 'chat-admin-direct',
        title: 'Primary Admin',
        members: [{ memberId: 'mid-primary-admin', displayName: 'Boss Admin' }],
      },
      {
        chatType: 'direct',
        chatId: 'chat-friend-direct',
        title: 'Friend User',
        members: [{ memberId: 'user-friend', displayName: 'Whitelisted Friend' }],
      },
    ]);

    // Insert messages across accounts, time windows, plus local agent room and system event
    await pool.query(
      `INSERT INTO conversations (account_id, chat_type, chat_id, title)
       VALUES ('account-agent', 'direct', '__local_agent_room__', 'Agent Room')
       ON CONFLICT DO NOTHING`,
    );

    const seededMessages = [
      {
        accountId: 'account-admin',
        messageId: 'msg-admin-1',
        chatType: 'group',
        chatId: 'group-alpha',
        senderId: 'user-alice',
        kind: 'text',
        text: 'Alpha milestone report from Alice on Oct 15',
        occurredAt: '2026-10-15T09:30:00.000Z',
      },
      {
        accountId: 'account-admin',
        messageId: 'msg-admin-2',
        chatType: 'group',
        chatId: 'group-alpha',
        senderId: 'mid-primary-admin',
        kind: 'text',
        text: 'Admin outbound reply on Oct 16',
        occurredAt: '2026-10-16T14:00:00.000Z',
      },
      {
        accountId: 'account-admin',
        messageId: 'msg-admin-event',
        chatType: 'group',
        chatId: 'group-alpha',
        senderId: 'user-alice',
        kind: 'event',
        text: 'member joined event',
        occurredAt: '2026-10-16T15:00:00.000Z',
      },
      {
        accountId: 'account-agent',
        messageId: 'msg-agent-1',
        chatType: 'group',
        chatId: 'group-alpha',
        senderId: 'user-alice',
        kind: 'text',
        text: 'Agent account message in same-named group-alpha',
        occurredAt: '2026-10-16T18:00:00.000Z',
      },
      {
        accountId: 'account-agent',
        messageId: 'msg-local-room',
        chatType: 'direct',
        chatId: '__local_agent_room__',
        senderId: 'user-alice',
        kind: 'text',
        text: 'Secret local agent room message',
        occurredAt: '2026-10-16T19:00:00.000Z',
      },
    ];

    for (const item of seededMessages) {
      await pool.query(
        `INSERT INTO messages (account_id, message_id, event_id, chat_id, chat_type, sender_id, kind, text_content, ingestion_source, occurred_at, raw)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'live', $9::timestamptz, '{"secretRaw":"never-expose"}'::jsonb)`,
        [
          item.accountId,
          item.messageId,
          `ev-${item.messageId}`,
          item.chatId,
          item.chatType,
          item.senderId,
          item.kind,
          item.text,
          item.occurredAt,
        ],
      );
    }

    await pool.query(
      `INSERT INTO attachments (external_attachment_id, account_id, chat_type, chat_id, message_id, kind, name, mime_type, size_bytes, status, relative_path, sha256)
       VALUES ('ext-att-1', 'account-admin', 'group', 'group-alpha', 'msg-admin-1', 'file', 'spec.pdf', 'application/pdf', 2048, 'ready', 'account-admin/secret/spec.pdf', repeat('a', 64))`,
    );
  });

  afterAll(async () => {
    await close?.();
  });

  it('keeps mcp_agent_audit append-only', async () => {
    await tokens.recordAudit({ tokenId: null, principalId: 'local-client', initiator: 'external_agent', action: 'AUTH_REJECTED',
      toolName: null, accountScopes: [], grantVersion: null, disposition: 'SCOPE_DENIED', resultCount: null });
    await expect(pool.query("UPDATE mcp_agent_audit SET disposition = 'REVOKED'")).rejects.toThrow(/append-only/i);
    await expect(pool.query('DELETE FROM mcp_agent_audit')).rejects.toThrow(/append-only/i);
    await expect(pool.query('TRUNCATE mcp_agent_audit')).rejects.toThrow(/append-only/i);
  });

  it('reads as the fixed local-client principal over the AGENT and PRIMARY_ADMIN accounts with no token and audits the call', async () => {
    const seen = await tokens.executeLocalClientRead({ toolName: 'list_targets',
      execute: async ({ principalId, authorizedAccountIds, toolScopes }) => ({ data: { principalId, authorizedAccountIds, toolScopes }, resultCount: 2 }) });
    expect(seen).toEqual({ principalId: 'local-client', authorizedAccountIds: ['account-admin', 'account-agent'], toolScopes: [...MCP_TOOL_NAMES] });
    const row = (await tokens.listAuditRecords(10)).find((entry) => entry.principalId === 'local-client' && entry.action === 'TOOL_CALLED');
    expect(row).toMatchObject({ tokenId: null, initiator: 'external_agent', toolName: 'list_targets',
      accountScopes: ['account-admin', 'account-agent'], grantVersion: null, disposition: 'ALLOWED', resultCount: 2 });
    // A handshake method (toolName null) reads no tool and writes no TOOL_CALLED row.
    const before = (await tokens.listAuditRecords(1000)).length;
    await expect(tokens.executeLocalClientRead({ toolName: null, execute: async () => ({ data: true }) })).resolves.toBe(true);
    expect((await tokens.listAuditRecords(1000)).length).toBe(before);
  });

  it('applies one shared rate limit and audits the refusal with a null token', async () => {
    let allowed = 2;
    const limiter = () => allowed-- > 0;
    for (let index = 0; index < 2; index += 1) {
      await expect(tokens.executeLocalClientRead({ toolName: 'list_targets', rateLimiter: limiter, execute: async () => ({ data: 'ok' }) })).resolves.toBe('ok');
    }
    const execute = vi.fn(async () => ({ data: 'unreachable' }));
    await expect(tokens.executeLocalClientRead({ toolName: 'list_targets', rateLimiter: limiter, execute })).rejects.toMatchObject({ code: 'RATE_LIMITED' });
    expect(execute).not.toHaveBeenCalled();
    expect((await tokens.listAuditRecords(10)).some((row) => row.principalId === 'local-client' && row.tokenId === null
      && row.action === 'AUTH_REJECTED' && row.disposition === 'RATE_LIMITED')).toBe(true);
  });

  it('classifies target and time queries by composite (accountId, chatType, chatId) and speaker without exposing raw or local room', async () => {
    const targets = await messages.listConversationTargets({
      accountIds: ['account-admin', 'account-agent'],
      query: 'Alpha',
    });
    expect(targets.some((item) => item.chatId === '__local_agent_room__')).toBe(false);
    expect(targets.filter((item) => item.chatId === 'group-alpha')).toHaveLength(2);

    // Query by target conversation/speaker in account-admin
    const targetRecords = await messages.queryTargetMessages({
      accountIds: ['account-admin'],
      target: 'Alice',
    });
    expect(targetRecords.map((item) => item.messageId)).toEqual(['msg-admin-2', 'msg-admin-1']);
    const msg1 = targetRecords.find((item) => item.messageId === 'msg-admin-1')!;
    const msg2 = targetRecords.find((item) => item.messageId === 'msg-admin-2')!;
    expect(msg1).toMatchObject({
      accountId: 'account-admin',
      accountDisplayName: 'Admin Monitored LINE',
      chatType: 'group',
      chatId: 'group-alpha',
      conversationTitle: 'Alpha Operations',
      senderId: 'user-alice',
      senderName: 'Alice Chen',
      direction: 'inbound',
      kind: 'text',
    });
    expect(msg1.attachments).toHaveLength(1);
    expect(msg1.recalled).toBe(false);
    expect('relativePath' in (msg1.attachments[0] as Record<string, unknown>)).toBe(false);
    expect('raw' in (msg1 as Record<string, unknown>)).toBe(false);
    await pool.query("UPDATE messages SET content='{\"format\":1,\"type\":\"unsent\"}'::jsonb WHERE account_id='account-admin' AND message_id='msg-admin-1'");
    const recalled = (await messages.queryTargetMessages({ accountIds: ['account-admin'], target: 'Alice' }))
      .find((item) => item.messageId === 'msg-admin-1');
    expect(recalled).toMatchObject({ recalled: true, text: null, attachments: [] });
    // A message deleted at the LINE source is masked exactly like a recalled one.
    await pool.query(`UPDATE messages SET raw=COALESCE(raw,'{}'::jsonb) || '{"sourceDeleted":{"detectedAt":"2026-10-22T00:00:00.000Z"}}'::jsonb
      WHERE account_id='account-admin' AND message_id='msg-admin-2'`);
    const sourceDeleted = (await messages.queryTargetMessages({ accountIds: ['account-admin'], target: 'Alice' }))
      .find((item) => item.messageId === 'msg-admin-2');
    expect(sourceDeleted).toMatchObject({ recalled: true, text: null, attachments: [] });
    // The text filter must not confirm hidden content: masked rows never match their original text.
    await pool.query(`INSERT INTO messages(account_id,message_id,event_id,chat_type,chat_id,sender_id,kind,text_content,ingestion_source,occurred_at,raw)
      SELECT account_id,'msg-admin-visible-copy','evt-visible-copy',chat_type,chat_id,sender_id,kind,text_content,ingestion_source,occurred_at,'{}'::jsonb
      FROM messages WHERE account_id='account-admin' AND message_id='msg-admin-1'`);
    const recalledHit = await messages.queryTargetMessages({ accountIds: ['account-admin'], target: 'Alice', text: 'milestone report' });
    expect(recalledHit.map((item) => item.messageId)).toEqual(['msg-admin-visible-copy']);
    expect(recalledHit[0]?.text).toContain('milestone report');
    expect(await messages.queryTargetMessages({ accountIds: ['account-admin'], target: 'Alice', text: 'outbound reply' })).toEqual([]);
    await pool.query("DELETE FROM messages WHERE account_id='account-admin' AND message_id='msg-admin-visible-copy'");
    expect(msg2.direction).toBe('outbound');
    expect(msg2.senderName).toBe('Admin Monitored LINE');

    // Query by target + time window
    const oct15Only = await messages.queryTargetMessages({
      accountIds: ['account-admin'],
      target: 'Alpha Operations',
      from: '2026-10-15T00:00:00.000Z',
      to: '2026-10-15T23:59:59.999Z',
    });
    expect(oct15Only.map((item) => item.messageId)).toEqual(['msg-admin-1']);
  });

  it('rejects an account outside the fixed role scopes, internal-only and unknown tools, and commits AUTH_REJECTED audit rows', async () => {
    await accounts.ensureAccount('account-outside-roles');
    const execute = vi.fn(async () => ({ data: 'unreachable' }));
    await expect(tokens.executeLocalClientRead({ toolName: 'query_target_messages', requestedAccountId: 'account-outside-roles', execute }))
      .rejects.toMatchObject({ code: 'SCOPE_DENIED' });
    await expect(tokens.executeLocalClientRead({ toolName: 'query_target_messages', requestedAccountId: 'no-such-account', execute }))
      .rejects.toMatchObject({ code: 'SCOPE_DENIED' });
    for (const toolName of ['list_send_targets', 'send_to_target', 'query_agent_room_history', 'future_tool'] as const) {
      await expect(tokens.executeLocalClientRead({ toolName: toolName as never, execute })).rejects.toMatchObject({ code: 'SCOPE_DENIED' });
    }
    expect(execute).not.toHaveBeenCalled();

    // Omitting accountId resolves to the role accounts, never to an account without a role.
    const result = await tokens.executeLocalClientRead({
      toolName: 'query_target_messages',
      execute: async ({ client, authorizedAccountIds }) => {
        const rows = await messages.queryTargetMessages({ accountIds: authorizedAccountIds, target: 'group-alpha' }, client);
        return { data: rows, resultCount: rows.length };
      },
    });
    expect(new Set(result.map((row) => row.accountId))).toEqual(new Set(['account-admin', 'account-agent']));
    // A requested account narrows the read to that account.
    const narrowed = await tokens.executeLocalClientRead({
      toolName: 'query_target_messages', requestedAccountId: 'account-admin',
      execute: async ({ client, authorizedAccountIds }) => ({ data: await messages.queryTargetMessages({ accountIds: authorizedAccountIds, target: 'group-alpha' }, client) }),
    });
    expect(narrowed.every((row) => row.accountId === 'account-admin')).toBe(true);
    expect(narrowed.some((row) => row.messageId === 'msg-agent-1')).toBe(false);

    const audits = await tokens.listAuditRecords(30);
    expect(audits.some((row) => row.tokenId === null && row.principalId === 'local-client' && row.action === 'AUTH_REJECTED'
      && row.disposition === 'SCOPE_DENIED' && row.toolName === 'send_to_target')).toBe(true);
    expect(audits.some((row) => row.tokenId === null && row.principalId === 'local-client' && row.action === 'AUTH_REJECTED'
      && row.disposition === 'SCOPE_DENIED' && row.accountScopes.join() === 'account-outside-roles')).toBe(true);
  });

  it('resolves the AGENT role to the replacement account before the protected read', async () => {
    await accounts.ensureAccount('account-agent-replacement');
    try {
      await pool.query("UPDATE line_accounts SET product_role = NULL, mode = 'MONITOR_ONLY' WHERE account_id = 'account-agent'");
      await pool.query("UPDATE line_accounts SET product_role = 'AGENT', mode = 'ACTIVE_CONTROL' WHERE account_id = 'account-agent-replacement'");
      const resolved = await tokens.executeLocalClientRead({ toolName: 'list_targets',
        requestedAccountId: 'account-agent-replacement', execute: async ({ authorizedAccountIds }) => ({ data: authorizedAccountIds }) });
      expect(resolved).toEqual(['account-agent-replacement']);
      await expect(tokens.executeLocalClientRead({ toolName: 'list_targets',
        requestedAccountId: 'account-agent', execute: async () => ({ data: 'unreachable' }) })).rejects.toMatchObject({ code: 'SCOPE_DENIED' });
    } finally {
      await pool.query("UPDATE line_accounts SET product_role = NULL, mode = 'MONITOR_ONLY' WHERE account_id = 'account-agent-replacement'");
      await pool.query("UPDATE line_accounts SET product_role = 'AGENT', mode = 'ACTIVE_CONTROL' WHERE account_id = 'account-agent'");
    }
  });

  it('discards a role-scoped read when its holder changes before the final authorization fence', async () => {
    await accounts.ensureAccount('role-fence-replacement');
    try {
      await expect(tokens.executeLocalClientRead({ toolName: 'list_targets',
        execute: async ({ authorizedAccountIds }) => {
          expect(authorizedAccountIds).toEqual(['account-admin', 'account-agent']);
          await pool.query("UPDATE line_accounts SET product_role=NULL,mode='MONITOR_ONLY' WHERE account_id='account-agent'");
          await pool.query("UPDATE line_accounts SET product_role='AGENT',mode='ACTIVE_CONTROL' WHERE account_id='role-fence-replacement'");
          return { data: 'obsolete holder result' };
        } })).rejects.toMatchObject({ code: 'CONTROL_CHANGED' });
    } finally {
      await pool.query("UPDATE line_accounts SET product_role=NULL,mode='MONITOR_ONLY' WHERE account_id='role-fence-replacement'");
      await pool.query("UPDATE line_accounts SET product_role='AGENT',mode='ACTIVE_CONTROL' WHERE account_id='account-agent'");
    }
  });

  it('completes 6 concurrent external queries without a 40P01 deadlock', async () => {
    const parallelResults = await Promise.all(
      Array.from({ length: 6 }, () =>
        tokens.executeLocalClientRead({
          toolName: 'query_target_messages',
          requestedAccountId: 'account-admin',
          execute: async ({ client, authorizedAccountIds }) => {
            const rows = await messages.queryTargetMessages({ accountIds: authorizedAccountIds, target: 'Alice' }, client);
            return { data: rows, resultCount: rows.length };
          },
        }),
      ),
    );
    for (const rows of parallelResults) {
      expect(rows).toHaveLength(2);
    }
  });

  it('fences control epoch and account pause changes, excludes paused accounts, and requires approval for unclassified tools', async () => {
    const auditDisposition = async (disposition: string) => (await tokens.listAuditRecords(30))
      .some((entry) => entry.tokenId === null && entry.principalId === 'local-client' && entry.disposition === disposition);

    // Acceptance 1: active accounts and stable epoch return data and record ALLOWED.
    await expect(tokens.executeLocalClientRead({ toolName: 'list_targets',
      execute: async () => ({ data: ['ok'], resultCount: 1 }) })).resolves.toEqual(['ok']);
    expect(await auditDisposition('ALLOWED')).toBe(true);

    // Acceptance 2: changing the control epoch while execute is in flight discards the result.
    let reached!: () => void;
    let resume!: () => void;
    const atExecute = new Promise<void>((resolve) => { reached = resolve; });
    const paused = new Promise<void>((resolve) => { resume = resolve; });
    const changedEpoch = tokens.executeLocalClientRead({ toolName: 'list_targets',
      execute: async () => { reached(); await paused; return { data: ['must discard'] }; } });
    await atExecute;
    const controlState = await pool.query<{ control_epoch: number }>('SELECT control_epoch FROM account_control WHERE singleton = true');
    const savedControlEpoch = controlState.rows[0]!.control_epoch;
    try {
      await pool.query('UPDATE account_control SET control_epoch = control_epoch + 1 WHERE singleton = true');
      resume();
      await expect(changedEpoch).rejects.toMatchObject({ code: 'CONTROL_CHANGED' });
      expect(await auditDisposition('CONTROL_CHANGED')).toBe(true);
    } finally {
      resume();
      await pool.query('UPDATE account_control SET control_epoch = $1 WHERE singleton = true', [savedControlEpoch]);
    }

    // Acceptance 3: a paused account is excluded; when every role account is paused, reject SCOPE_DENIED.
    await pool.query("UPDATE line_accounts SET mode = 'PAUSED' WHERE account_id = 'account-admin'");
    try {
      expect(await tokens.executeLocalClientRead({ toolName: 'list_targets', execute: async ({ authorizedAccountIds }) => ({ data: authorizedAccountIds }) }))
        .toEqual(['account-agent']);
      await pool.query("UPDATE line_accounts SET mode = 'PAUSED' WHERE account_id = 'account-agent'");
      await expect(tokens.executeLocalClientRead({ toolName: 'list_targets',
        execute: async () => ({ data: ['unreachable'] }) })).rejects.toMatchObject({ code: 'SCOPE_DENIED' });
    } finally {
      await pool.query("UPDATE line_accounts SET mode = 'MONITOR_ONLY' WHERE account_id = 'account-admin'");
      await pool.query("UPDATE line_accounts SET mode = 'ACTIVE_CONTROL' WHERE account_id = 'account-agent'");
    }

    // Acceptance 4: pausing after resolution but before the fence rejects and discards data.
    let pauseReached!: () => void;
    let unpauseGate!: () => void;
    const atPause = new Promise<void>((resolve) => { pauseReached = resolve; });
    const pauseWait = new Promise<void>((resolve) => { unpauseGate = resolve; });
    const changedPause = tokens.executeLocalClientRead({ toolName: 'list_targets',
      execute: async () => { pauseReached(); await pauseWait; return { data: ['must discard'] }; } });
    await atPause;
    await pool.query("UPDATE line_accounts SET mode = 'PAUSED' WHERE account_id = 'account-admin'");
    unpauseGate();
    await expect(changedPause).rejects.toMatchObject({ code: 'CONTROL_CHANGED' });
    await pool.query("UPDATE line_accounts SET mode = 'MONITOR_ONLY' WHERE account_id = 'account-admin'");

    // Acceptance 6: effect or missing classification is denied before execute.
    const execute = vi.fn(async () => ({ data: ['unreachable'] }));
    const effects = MCP_TOOL_EFFECTS as Record<string, 'read' | 'effect'>;
    effects.list_targets = 'effect';
    try {
      await expect(tokens.executeLocalClientRead({ toolName: 'list_targets', execute })).rejects.toMatchObject({ code: 'APPROVAL_REQUIRED' });
    } finally {
      effects.list_targets = 'read';
    }
    const readClassification = effects.list_targets;
    delete effects.list_targets;
    try {
      await expect(tokens.executeLocalClientRead({ toolName: 'list_targets', execute })).rejects.toMatchObject({ code: 'APPROVAL_REQUIRED' });
    } finally {
      effects.list_targets = readClassification;
    }
    expect(execute).not.toHaveBeenCalled();
    expect(await auditDisposition('APPROVAL_REQUIRED')).toBe(true);
  });

  it('allows UI and verified Primary Admin internal Agent queries across non-paused accounts and denies unclassifiable LINE jobs', async () => {
    // 1. UI caller can query across both account-admin and account-agent without a bearer token
    const uiRows = await tokens.executeForInternalAgent({
      context: { sourceType: 'ui', requestId: 'ui-req-1' },
      toolName: 'query_target_messages',
      execute: async ({ client, authorizedAccountIds }) => {
        const rows = await messages.queryTargetMessages(
          { accountIds: authorizedAccountIds, target: 'group-alpha' },
          client,
        );
        return { data: rows, resultCount: rows.length };
      },
    });
    expect(new Set(uiRows.map((row) => row.accountId))).toEqual(
      new Set(['account-admin', 'account-agent']),
    );

    // 2. Seed a Primary Admin LINE job (direct_friend_grant_id IS NULL) on account-agent
    const adminMsgId = `msg-admin-cmd-${randomUUID()}`;
    const adminJobId = randomUUID();
    await pool.query(
      `INSERT INTO messages (account_id, message_id, event_id, chat_id, chat_type, sender_id, kind, text_content, ingestion_source, occurred_at, raw)
       VALUES ('account-agent', $1, $2, 'chat-admin-direct', 'direct', 'mid-primary-admin', 'text', '/mcp query', 'live', now(), '{}'::jsonb)`,
      [adminMsgId, `ev-${adminMsgId}`],
    );
    await pool.query(
      `INSERT INTO agent_jobs (job_id, account_id, chat_type, chat_id, provider, source_type, source_message_id, prompt, workspace_path, generation, creation_epoch, status, direct_friend_grant_id, room_agent_grant_id)
       VALUES ($1, 'account-agent', 'direct', 'chat-admin-direct', 'claude', 'line', $2, '/mcp query', 'C:\\workspace', 1, 1, 'running', NULL, NULL)`,
      [adminJobId, adminMsgId],
    );

    const adminRows = await tokens.executeForInternalAgent({
      context: { sourceType: 'line', jobId: adminJobId },
      toolName: 'query_target_messages',
      requestedAccountId: 'account-admin',
      execute: async ({ client, authorizedAccountIds }) => {
        const rows = await messages.queryTargetMessages(
          { accountIds: authorizedAccountIds, target: 'Alice' },
          client,
        );
        return { data: rows, resultCount: rows.length };
      },
    });
    expect(adminRows.every((row) => row.accountId === 'account-admin')).toBe(true);
    expect(adminRows).toHaveLength(2);

    // 3. Seed a LINE job whose sender is not the Primary Admin and which carries no grant (unclassifiable): rejected with SCOPE_DENIED.
    // (Granted friend/group jobs are no longer rejected; they are chat-scoped, see the next test.)
    const friendMsgId = `msg-friend-cmd-${randomUUID()}`;
    const friendJobId = randomUUID();
    await pool.query(
      `INSERT INTO messages (account_id, message_id, event_id, chat_id, chat_type, sender_id, kind, text_content, ingestion_source, occurred_at, raw)
       VALUES ('account-agent', $1, $2, 'chat-friend-direct', 'direct', 'user-friend', 'text', '/mcp query', 'live', now(), '{}'::jsonb)`,
      [friendMsgId, `ev-${friendMsgId}`],
    );
    await pool.query(
      `INSERT INTO agent_jobs (job_id, account_id, chat_type, chat_id, provider, source_type, source_message_id, prompt, workspace_path, generation, creation_epoch, status)
       VALUES ($1, 'account-agent', 'direct', 'chat-friend-direct', 'claude', 'line', $2, '/mcp query', 'C:\\workspace', 1, 1, 'running')`,
      [friendJobId, friendMsgId],
    );

    await expect(
      tokens.executeForInternalAgent({
        context: { sourceType: 'line', jobId: friendJobId },
        toolName: 'query_target_messages',
        execute: async () => ({ data: 'unreachable' }),
      }),
    ).rejects.toMatchObject({ code: 'SCOPE_DENIED' });

    const audits = await tokens.listAuditRecords(10);
    expect(
      audits.some(
        (row) =>
          row.initiator === 'internal_agent' &&
          row.action === 'AUTH_REJECTED' &&
          row.disposition === 'SCOPE_DENIED',
      ),
    ).toBe(true);
  });

  it('scopes LINE-origin Agent jobs by origin: chat-only for granted friends and group members, full for the Primary Admin and UI, deny when unclassifiable or stale', async () => {
    const seedJob = async (input: {
      chatType: 'direct' | 'group'; chatId: string; senderId: string;
      direct?: { grantId: string; version: number }; room?: { grantId: string; version: number };
      status?: string; generation?: number; accountId?: string;
    }): Promise<string> => {
      const accountId = input.accountId ?? 'account-agent';
      const messageId = `msg-scope-${randomUUID()}`;
      const jobId = randomUUID();
      // Only one running job per chat is allowed; retire earlier ones (line-context checks do not require running).
      await pool.query(
        `UPDATE agent_jobs SET status = 'completed', completed_at = now()
         WHERE account_id = $1 AND chat_type = $2 AND chat_id = $3 AND status = 'running'`,
        [accountId, input.chatType, input.chatId],
      );
      await pool.query(
        `INSERT INTO messages (account_id, message_id, event_id, chat_id, chat_type, sender_id, kind, text_content, ingestion_source, occurred_at, raw)
         VALUES ($1, $2, $3, $4, $5, $6, 'text', 'scope trigger', 'live', now(), '{}'::jsonb)`,
        [accountId, messageId, `ev-${messageId}`, input.chatId, input.chatType, input.senderId],
      );
      await pool.query(
        `INSERT INTO agent_jobs (job_id, account_id, chat_type, chat_id, provider, source_type, source_message_id, prompt, workspace_path, generation, creation_epoch, status,
           direct_friend_grant_id, direct_friend_grant_version, room_agent_grant_id, room_agent_grant_version)
         VALUES ($1, $2, $3, $4, 'claude', 'line', $5, 'scope', 'C:\\workspace', $6, 1, $7, $8, $9, $10, $11)`,
        [jobId, accountId, input.chatType, input.chatId, messageId, input.generation ?? 1, input.status ?? 'running',
          input.direct?.grantId ?? null, input.direct?.version ?? null, input.room?.grantId ?? null, input.room?.version ?? null],
      );
      return jobId;
    };
    const friends = new FriendWhitelistRepository(pool);
    const rooms = new RoomActivationRepository(pool);
    const friendGrant = async (mid: string) => {
      const g = await friends.activate('account-agent', mid, 'test-admin');
      return { grantId: g.grantId, version: g.version };
    };
    // Real ENABLED room policy + ACTIVE room grant (authority_version == grant version, as admission requires).
    const roomGrant = async (chatType: 'group', chatId: string) => {
      await pool.query(
        `UPDATE room_agent_grants SET state = 'REVOKED', revoked_at = clock_timestamp()
         WHERE account_id = 'account-agent' AND chat_type = $1 AND chat_id = $2 AND state = 'ACTIVE'`, [chatType, chatId]);
      const requestId = randomUUID();
      await pool.query(
        `INSERT INTO room_activation_requests(request_id, account_id, chat_type, chat_id, source_message_id, requester_id,
           admin_chat_id, admin_user_id, admin_version, room_authority_version, state, wait_expires_at)
         VALUES ($1,'account-agent',$2,$3,$4,'member','admin','mid-primary-admin',1,1,'CONSUMED',clock_timestamp())`,
        [requestId, chatType, chatId, randomUUID()]);
      const policy = await pool.query<{ authority_version: string }>(
        `INSERT INTO room_agent_policies(account_id, chat_type, chat_id, state, authority_version)
         VALUES ('account-agent',$1,$2,'ENABLED',1)
         ON CONFLICT (account_id, chat_type, chat_id) DO UPDATE
           SET state = 'ENABLED', authority_version = room_agent_policies.authority_version + 1
         RETURNING authority_version`, [chatType, chatId]);
      const version = Number(policy.rows[0]!.authority_version);
      const grantId = randomUUID();
      await pool.query(
        `INSERT INTO room_agent_grants(grant_id, account_id, chat_type, chat_id, capability, version, state, request_id)
         VALUES ($1,'account-agent',$2,$3,'AGENT_USE_ROOM',$4,'ACTIVE',$5)`, [grantId, chatType, chatId, version, requestId]);
      return { grantId, version };
    };
    const run = (context: Parameters<McpTokenRepository['executeForInternalAgent']>[0]['context'], opts: {
      toolName?: 'list_targets' | 'query_target_messages' | 'query_target_messages_by_time';
      requestedAccountId?: string; requestedChat?: { chatType?: 'direct' | 'group'; chatId?: string };
      args?: { target?: string; from?: string };
    } = {}) => tokens.executeForInternalAgent({
      context,
      toolName: opts.toolName ?? 'query_target_messages',
      ...(opts.requestedAccountId ? { requestedAccountId: opts.requestedAccountId } : {}),
      ...(opts.requestedChat ? { requestedChat: opts.requestedChat } : {}),
      execute: async ({ client, authorizedAccountIds, conversationScope }) => {
        if (opts.toolName === 'list_targets') {
          const targets = await messages.listConversationTargets(
            { accountIds: authorizedAccountIds, ...(conversationScope ? { conversationScope } : {}) }, client);
          return { data: { targets, messages: [] as Awaited<ReturnType<MessageRepository['queryTargetMessages']>> }, resultCount: targets.length };
        }
        const rows = await messages.queryTargetMessages(
          { accountIds: authorizedAccountIds, ...(conversationScope ? { conversationScope } : {}), ...opts.args }, client);
        return { data: { targets: [] as Awaited<ReturnType<MessageRepository['listConversationTargets']>>, messages: rows }, resultCount: rows.length };
      },
    });

    await pool.query(
      `INSERT INTO messages (account_id, message_id, event_id, chat_id, chat_type, sender_id, kind, text_content, ingestion_source, occurred_at, raw)
       VALUES ('account-agent', 'msg-friend-hello', 'ev-msg-friend-hello', 'chat-friend-direct', 'direct', 'user-friend', 'text', 'friend hello', 'live', '2026-10-17T01:00:00Z', '{}'::jsonb)
       ON CONFLICT DO NOTHING`,
    );

    // Whitelisted friend 1:1 job: only its own chat.
    const friendJob = await seedJob({ chatType: 'direct', chatId: 'chat-friend-direct', senderId: 'user-friend', direct: await friendGrant('user-friend') });
    const friendCtx = { sourceType: 'line' as const, jobId: friendJob };
    const friendTargets = (await run(friendCtx, { toolName: 'list_targets' })).targets;
    expect(friendTargets.map((t) => `${t.accountId}/${t.chatType}/${t.chatId}`)).toEqual(['account-agent/direct/chat-friend-direct']);
    expect(friendTargets[0]?.members.map((m) => m.memberId)).toEqual(['user-friend']);
    const friendMessages = (await run(friendCtx)).messages;
    expect(friendMessages.length).toBeGreaterThan(0);
    expect(friendMessages.every((m) => m.accountId === 'account-agent' && m.chatType === 'direct' && m.chatId === 'chat-friend-direct')).toBe(true);
    const friendByTime = (await run(friendCtx, { toolName: 'query_target_messages_by_time', args: { from: '2020-01-01T00:00:00Z' } })).messages;
    expect(friendByTime.every((m) => m.chatId === 'chat-friend-direct')).toBe(true);
    // Text filters cannot widen the scope.
    expect((await run(friendCtx, { args: { target: 'Alice' } })).messages).toEqual([]);
    // Cross-account and cross-chat requests are denied.
    await expect(run(friendCtx, { requestedAccountId: 'account-admin' })).rejects.toMatchObject({ code: 'SCOPE_DENIED' });
    await expect(run(friendCtx, { requestedChat: { chatType: 'direct', chatId: 'chat-admin-direct' } })).rejects.toMatchObject({ code: 'SCOPE_DENIED' });
    await expect(run(friendCtx, { requestedChat: { chatType: 'group', chatId: 'chat-friend-direct' } })).rejects.toMatchObject({ code: 'SCOPE_DENIED' });
    await expect(run(friendCtx, { toolName: 'list_targets', requestedAccountId: 'account-admin' })).rejects.toMatchObject({ code: 'SCOPE_DENIED' });
    // Explicitly asking for its own chat is fine.
    expect((await run(friendCtx, { requestedAccountId: 'account-agent', requestedChat: { chatType: 'direct', chatId: 'chat-friend-direct' } })).messages.length).toBeGreaterThan(0);

    // Agent-enabled group member job: only that group on that account, even though account-admin has a same-named group.
    // An ACCOUNT-scoped friend grant triggered inside a group: the job carries both a direct and a room grant; scope is that group only.
    const aliceGrant = await friendGrant('user-alice');
    const groupRoom = await roomGrant('group', 'group-alpha');
    const groupJob = await seedJob({ chatType: 'group', chatId: 'group-alpha', senderId: 'user-alice', direct: aliceGrant, room: groupRoom });
    const groupCtx = { sourceType: 'line' as const, jobId: groupJob };
    const groupTargets = (await run(groupCtx, { toolName: 'list_targets' })).targets;
    expect(groupTargets.map((t) => `${t.accountId}/${t.chatType}/${t.chatId}`)).toEqual(['account-agent/group/group-alpha']);
    const groupMessages = (await run(groupCtx)).messages;
    expect(groupMessages.map((m) => m.messageId)).toContain('msg-agent-1');
    expect(groupMessages.every((m) => m.accountId === 'account-agent' && m.chatId === 'group-alpha')).toBe(true);
    expect(groupMessages.some((m) => m.messageId === 'msg-admin-1')).toBe(false);
    await expect(run(groupCtx, { requestedChat: { chatId: 'chat-admin-direct' } })).rejects.toMatchObject({ code: 'SCOPE_DENIED' });
    await expect(run(groupCtx, { requestedAccountId: 'account-admin' })).rejects.toMatchObject({ code: 'SCOPE_DENIED' });

    // Primary Admin sender in a group (no grant): full scope across accounts and chats.
    const adminGroupJob = await seedJob({ chatType: 'group', chatId: 'group-alpha', senderId: 'mid-primary-admin' });
    const adminTargets = (await run({ sourceType: 'line', jobId: adminGroupJob }, { toolName: 'list_targets' })).targets;
    expect(new Set(adminTargets.map((t) => t.accountId))).toEqual(new Set(['account-admin', 'account-agent']));
    expect(adminTargets.length).toBeGreaterThan(2);
    const adminMsgs = (await run({ sourceType: 'line', jobId: adminGroupJob })).messages;
    expect(new Set(adminMsgs.map((m) => m.chatId)).size).toBeGreaterThan(1);
    // A granted job whose sender is the Primary Admin is still full.
    const adminGrantJob = await seedJob({ chatType: 'group', chatId: 'group-alpha', senderId: 'mid-primary-admin', room: groupRoom });
    expect(new Set((await run({ sourceType: 'line', jobId: adminGrantJob })).messages.map((m) => m.accountId))).toEqual(new Set(['account-admin', 'account-agent']));

    // UI: full scope.
    const uiTargets = (await run({ sourceType: 'ui' }, { toolName: 'list_targets' })).targets;
    expect(new Set(uiTargets.map((t) => t.accountId))).toEqual(new Set(['account-admin', 'account-agent']));

    // Agent LINE send tools: only the Primary Admin (also inside a group) and the desktop operator; never a granted
    // friend, a room-grant user or an external token. Re-derived from durable state on every call.
    const sendCall = (context: Parameters<McpTokenRepository['executeForInternalAgent']>[0]['context'], toolName: 'list_send_targets' | 'send_to_target') =>
      tokens.executeForInternalAgent({ context, toolName, execute: async () => ({ data: 'authorized', resultCount: 2 }) });
    const adminDirectJob = await seedJob({ chatType: 'direct', chatId: 'chat-admin-direct', senderId: 'mid-primary-admin' });
    const adminDirectCtx = { sourceType: 'line' as const, jobId: adminDirectJob };
    for (const toolName of ['list_send_targets', 'send_to_target'] as const) {
      expect(await sendCall(adminDirectCtx, toolName)).toBe('authorized');
      expect(await sendCall({ sourceType: 'line', jobId: adminGroupJob }, toolName)).toBe('authorized');
      expect(await sendCall({ sourceType: 'line', jobId: adminGrantJob }, toolName)).toBe('authorized');
      expect(await sendCall({ sourceType: 'ui' }, toolName)).toBe('authorized');
      await expect(sendCall(friendCtx, toolName)).rejects.toMatchObject({ code: 'PERMISSION_DENIED' });
      await expect(sendCall(groupCtx, toolName)).rejects.toMatchObject({ code: 'PERMISSION_DENIED' });
    }
    expect((await tokens.verifyInternalAgentAccess({ context: adminDirectCtx })).lineSend).toBe(true);
    expect((await tokens.verifyInternalAgentAccess({ context: { sourceType: 'line', jobId: adminGroupJob } })).lineSend).toBe(true);
    expect((await tokens.verifyInternalAgentAccess({ context: { sourceType: 'ui' } })).lineSend).toBe(true);
    expect((await tokens.verifyInternalAgentAccess({ context: friendCtx })).lineSend).toBe(false);
    expect((await tokens.verifyInternalAgentAccess({ context: groupCtx })).lineSend).toBe(false);
    const sendAudits = (await tokens.listAuditRecords(500)).filter((row) => row.toolName === 'send_to_target');
    expect(sendAudits.filter((row) => row.action === 'TOOL_CALLED' && row.disposition === 'ALLOWED' && row.resultCount === 2)).toHaveLength(4);
    expect(sendAudits.filter((row) => row.action === 'AUTH_REJECTED' && row.disposition === 'PERMISSION_DENIED'
      && row.principalId.startsWith('internal:chat_scoped:'))).toHaveLength(2);
    // The external local client can never call the send tools.
    for (const toolName of ['list_send_targets', 'send_to_target'] as const) {
      await expect(tokens.executeLocalClientRead({ toolName, execute: async () => ({ data: 'unreachable' }) }))
        .rejects.toMatchObject({ code: 'SCOPE_DENIED' });
    }

    // Missing job, non-running job, stale generation, and capability context mismatch are all denied.
    await expect(run({ sourceType: 'line', jobId: randomUUID() })).rejects.toMatchObject({ code: 'SCOPE_DENIED' });
    await expect(run({ sourceType: 'job', jobId: randomUUID(), generation: 1, accountId: 'account-agent' })).rejects.toMatchObject({ code: 'SCOPE_DENIED' });
    const friendGrantNow = await friendGrant('user-friend');
    const doneJob = await seedJob({ chatType: 'direct', chatId: 'chat-friend-direct', senderId: 'user-friend', direct: friendGrantNow, status: 'completed' });
    await expect(run({ sourceType: 'job', jobId: doneJob, generation: 1, accountId: 'account-agent' })).rejects.toMatchObject({ code: 'SCOPE_DENIED' });
    const liveJob = await seedJob({ chatType: 'direct', chatId: 'chat-friend-direct', senderId: 'user-friend', direct: friendGrantNow });
    await expect(run({ sourceType: 'job', jobId: liveJob, generation: 2, accountId: 'account-agent' })).rejects.toMatchObject({ code: 'SCOPE_DENIED' });
    await expect(run({ sourceType: 'job', jobId: liveJob, generation: 1, accountId: 'account-admin' })).rejects.toMatchObject({ code: 'SCOPE_DENIED' });
    // The valid capability context resolves to the same chat-only scope.
    const capMessages = (await run({ sourceType: 'job', jobId: liveJob, generation: 1, accountId: 'account-agent' })).messages;
    expect(capMessages.every((m) => m.chatId === 'chat-friend-direct')).toBe(true);

    // Error text must not reveal whether another account exists.
    const unknownAccountError = await run(friendCtx, { requestedAccountId: 'no-such-account' }).catch((e: Error) => e.message);
    const otherAccountError = await run(friendCtx, { requestedAccountId: 'account-admin' }).catch((e: Error) => e.message);
    expect(unknownAccountError).toBe(otherAccountError);

    // Fake grant ids that point at no row are denied.
    const fakeJob = await seedJob({ chatType: 'direct', chatId: 'chat-friend-direct', senderId: 'user-friend', direct: { grantId: randomUUID(), version: 1 } });
    await expect(run({ sourceType: 'line', jobId: fakeJob })).rejects.toMatchObject({ code: 'SCOPE_DENIED' });
    await expect(run({ sourceType: 'job', jobId: fakeJob, generation: 1, accountId: 'account-agent' })).rejects.toMatchObject({ code: 'SCOPE_DENIED' });
    // Restore a job bound to the real grant, then revoke it: both contexts must be denied and audited.
    const revokableJob = await seedJob({ chatType: 'direct', chatId: 'chat-friend-direct', senderId: 'user-friend', direct: friendGrantNow });
    expect((await run({ sourceType: 'job', jobId: revokableJob, generation: 1, accountId: 'account-agent' })).messages.length).toBeGreaterThan(0);
    const rejectedBefore = (await tokens.listAuditRecords(1000)).filter((r) => r.action === 'AUTH_REJECTED').length;
    expect(await friends.revoke('account-agent', 'user-friend', 'test-admin')).toBe(true);
    await expect(run({ sourceType: 'line', jobId: revokableJob })).rejects.toMatchObject({ code: 'SCOPE_DENIED' });
    await expect(run({ sourceType: 'job', jobId: revokableJob, generation: 1, accountId: 'account-agent' })).rejects.toMatchObject({ code: 'SCOPE_DENIED' });
    await expect(run({ sourceType: 'job', jobId: revokableJob, generation: 1, accountId: 'account-agent' }, { toolName: 'list_targets' })).rejects.toMatchObject({ code: 'SCOPE_DENIED' });
    expect((await tokens.listAuditRecords(1000)).filter((r) => r.action === 'AUTH_REJECTED').length).toBeGreaterThanOrEqual(rejectedBefore + 3);

    // Group: still valid, then revokeRoom() denies the same job.
    await run(groupCtx);
    expect(await rooms.revokeRoom({ accountId: 'account-agent', chatType: 'group', chatId: 'group-alpha' }, 'test-admin')).toBe(true);
    await expect(run(groupCtx)).rejects.toMatchObject({ code: 'SCOPE_DENIED' });
    // Revoking only the sender's friend grant also kills a group job even if the room is re-enabled.
    const reRoom = await roomGrant('group', 'group-alpha');
    const aliceNow = await friendGrant('user-alice');
    const groupJob2 = await seedJob({ chatType: 'group', chatId: 'group-alpha', senderId: 'user-alice', direct: aliceNow, room: reRoom });
    await run({ sourceType: 'line', jobId: groupJob2 });
    await friends.revoke('account-agent', 'user-alice', 'test-admin');
    await expect(run({ sourceType: 'line', jobId: groupJob2 })).rejects.toMatchObject({ code: 'SCOPE_DENIED' });

    // Audit: scope-denied rows exist and allowed rows record the chat scope in the principal.
    const audits = await tokens.listAuditRecords(200);
    expect(audits.some((r) => r.initiator === 'internal_agent' && r.action === 'AUTH_REJECTED' && r.disposition === 'SCOPE_DENIED'
      && r.principalId === 'internal:chat_scoped:direct:chat-friend-direct' && r.accountScopes.join() === 'account-agent')).toBe(true);
    expect(audits.some((r) => r.action === 'TOOL_CALLED' && r.principalId === 'internal:chat_scoped:group:group-alpha'
      && r.accountScopes.join() === 'account-agent')).toBe(true);
  });

  it('destroys an MCP database client on request abort and releases the pool for later work', async () => {
    const controller = new AbortController();
    const startedAt = Date.now();
    const operation = tokens.executeForInternalAgent({
      context: { sourceType: 'ui' },
      toolName: 'list_targets',
      signal: controller.signal,
      execute: async ({ client }) => {
        await client.query('SELECT pg_sleep(10)');
        return { data: 'should not escape' };
      },
    });
    setTimeout(() => controller.abort(new Error('client disconnected')), 50);
    await expect(operation).rejects.toThrow();
    expect(Date.now() - startedAt).toBeLessThan(1500);
    await expect(pool.query('SELECT 1')).resolves.toMatchObject({ rows: [{ '?column?': 1 }] });
  });
});
