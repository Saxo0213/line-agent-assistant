import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Pool } from 'pg';
import { AccountRepository } from './account-repository.js';
import { ATTACHMENT_STORED_STATUS, MessageRepository } from './message-repository.js';
import { createTestDatabase } from './test-database.js';

const database = process.env.TEST_DATABASE_URL ? describe : describe.skip;

database('Agent LINE send persistence (real database)', () => {
  let pool: Pool;
  let close: () => Promise<void>;
  let repo: MessageRepository;
  const att: Record<string, string> = {};

  const conversation = (account: string, type: string, id: string, title: string | null, updatedAt: string) =>
    pool.query('INSERT INTO conversations (account_id, chat_type, chat_id, title, updated_at) VALUES ($1,$2,$3,$4,$5)', [account, type, id, title, updatedAt]);
  const member = (account: string, type: string, id: string, mid: string, name: string | null) =>
    pool.query('INSERT INTO conversation_members (account_id, chat_type, chat_id, member_id, display_name) VALUES ($1,$2,$3,$4,$5)', [account, type, id, mid, name]);
  const message = (account: string, type: string, id: string, messageId: string, kind: string, text: string | null, raw: object = {}, content: object = {}) =>
    pool.query(
      `INSERT INTO messages (account_id, message_id, event_id, chat_id, chat_type, sender_id, kind, text_content, ingestion_source, occurred_at, raw, content)
       VALUES ($1,$2,$3,$4,$5,'mid-x',$6,$7,'live',now(),$8::jsonb,$9::jsonb)`,
      [account, messageId, `ev-${messageId}`, id, type, kind, text, JSON.stringify(raw), JSON.stringify(content)]);
  const attachment = async (name: string, account: string, type: string, chatId: string, messageId: string) => {
    const result = await pool.query<{ attachment_id: string }>(
      `INSERT INTO attachments (external_attachment_id, account_id, chat_type, chat_id, message_id, kind, name, mime_type, size_bytes, status, relative_path, sha256)
       VALUES ($1,$2,$3,$4,$5,'file',$6,'application/pdf',2048,$7,'a/b/spec.pdf',repeat('a',64)) RETURNING attachment_id`,
      [`ext-${name}`, account, type, chatId, messageId, `${name}.pdf`, ATTACHMENT_STORED_STATUS]);
    att[name] = result.rows[0]!.attachment_id;
  };

  beforeAll(async () => {
    ({ pool, close } = await createTestDatabase());
    repo = new MessageRepository(pool);
    const accounts = new AccountRepository(pool);
    await accounts.ensureAccount('acc-agent');
    await accounts.ensureAccount('acc-other');
    await accounts.ensureAccount('acc-admin');
    await pool.query("UPDATE line_accounts SET product_role = 'AGENT' WHERE account_id = 'acc-agent'");
    await pool.query("UPDATE line_accounts SET product_role = 'PRIMARY_ADMIN' WHERE account_id = 'acc-admin'");
    await conversation('acc-agent', 'direct', 'u-alice', 'Alice Direct', '2026-10-01T00:00:00Z');
    await conversation('acc-agent', 'group', 'g-team', 'Team Chat', '2026-10-03T00:00:00Z');
    await conversation('acc-agent', 'room', 'r-room', 'Old Room', '2026-10-02T00:00:00Z');
    await conversation('acc-agent', 'community', 'c-comm', 'Team Community', '2026-10-05T00:00:00Z');
    await conversation('acc-agent', 'thread', 't-thread', 'Team Thread', '2026-10-06T00:00:00Z');
    // ensureAccount already created the local room; make it the newest and match the query.
    await pool.query("UPDATE conversations SET title = 'Team Local', updated_at = '2026-10-07T00:00:00Z' WHERE account_id = 'acc-agent' AND chat_id = '__local_agent_room__'");
    await conversation('acc-other', 'group', 'g-other', 'Team Other', '2026-10-08T00:00:00Z');
    for (let i = 1; i <= 7; i++) await member('acc-agent', 'group', 'g-team', `mid-m${i}`, `Member ${i}`);
    await member('acc-agent', 'room', 'r-room', 'mid-zed', 'Zed Zebra');
    await pool.query("INSERT INTO line_contacts(account_id,mid,display_name,nickname) VALUES ('acc-agent','u-alice','Alice','Sweetheart')");
    await message('acc-agent', 'group', 'g-team', 'm-normal', 'file', 'hello');
    await message('acc-agent', 'group', 'g-team', 'm-recalled', 'text', 'secret recalled', {}, { type: 'unsent' });
    await message('acc-agent', 'group', 'g-team', 'm-deleted', 'text', 'secret deleted', { sourceDeleted: { detectedAt: '2026-10-01T00:00:00Z' } });
    await attachment('normal', 'acc-agent', 'group', 'g-team', 'm-normal');
    await attachment('recalled', 'acc-agent', 'group', 'g-team', 'm-recalled');
    await attachment('deleted', 'acc-agent', 'group', 'g-team', 'm-deleted');
  });
  afterAll(async () => { await close?.(); });

  describe('migration 052', () => {
    const row = (overrides: Record<string, unknown> = {}) => {
      const value = { job: randomUUID(), chatType: 'group', kind: 'text', status: 'sent', code: null, bytes: 0, ...overrides };
      return pool.query(
        `INSERT INTO agent_line_sends (job_id, account_id, principal_id, chat_type, chat_id, item_index, item_kind, byte_size, status, error_code)
         VALUES ($1,'acc-agent','internal:ui',$2,'g-team',0,$3,$4,$5,$6)`,
        [value.job, value.chatType, value.kind, value.bytes, value.status, value.code]);
    };

    it('rejects UPDATE, DELETE and TRUNCATE', async () => {
      await row();
      await expect(pool.query("UPDATE agent_line_sends SET status = 'failed'")).rejects.toThrow(/append-only/);
      await expect(pool.query('DELETE FROM agent_line_sends')).rejects.toThrow(/append-only/);
      await expect(pool.query('TRUNCATE agent_line_sends')).rejects.toThrow(/append-only/);
    });

    it('rejects community, thread, a bad error_code, a bad kind/status and a negative size', async () => {
      await expect(row({ chatType: 'community' })).rejects.toThrow();
      await expect(row({ chatType: 'thread' })).rejects.toThrow();
      await expect(row({ code: 'Bad-Code' })).rejects.toThrow();
      await expect(row({ code: 'x'.repeat(65) })).rejects.toThrow();
      await expect(row({ kind: 'sticker' })).rejects.toThrow();
      await expect(row({ status: 'skipped' })).rejects.toThrow();
      await expect(row({ bytes: -1 })).rejects.toThrow();
      await expect(row({ code: 'send_failed', status: 'failed' })).resolves.toBeTruthy();
    });

    it('widens the audit tool-name check with both tools', async () => {
      const def = await pool.query<{ def: string }>(
        "SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE conname = 'mcp_agent_audit_tool_name_check' AND conrelid = 'mcp_agent_audit'::regclass");
      expect(def.rows[0]?.def).toContain('list_send_targets');
      expect(def.rows[0]?.def).toContain('send_to_target');
      expect(def.rows[0]?.def).toContain('query_agent_room_history');
    });
  });

  it('finds the single Agent system-login account, or null', async () => {
    expect(await repo.findAgentSendAccount()).toBe('acc-agent');
    await pool.query("UPDATE line_accounts SET connection_mode = 'OFFLINE' WHERE account_id = 'acc-agent'");
    expect(await repo.findAgentSendAccount()).toBeNull();
    await pool.query("UPDATE line_accounts SET connection_mode = 'SYSTEM_LOGIN' WHERE account_id = 'acc-agent'");
  });

  describe('listSendTargets', () => {
    it('never returns community, thread, the local room or another account, newest first with numbers', async () => {
      const targets = await repo.listSendTargets({ accountId: 'acc-agent', query: 'team' });
      expect(targets.map((t) => t.chatId)).toEqual(['g-team']);
      const all = await repo.listSendTargets({ accountId: 'acc-agent' });
      expect(all.map((t) => [t.no, t.chatType, t.chatId])).toEqual([[1, 'group', 'g-team'], [2, 'room', 'r-room'], [3, 'direct', 'u-alice']]);
      expect(JSON.stringify(all)).not.toContain('__local_agent_room__');
      expect(JSON.stringify(all)).not.toContain('g-other');
    });

    it('matches by title, member name and nickname, case-insensitively', async () => {
      expect((await repo.listSendTargets({ accountId: 'acc-agent', query: 'ALICE DIRECT' })).map((t) => t.chatId)).toEqual(['u-alice']);
      expect((await repo.listSendTargets({ accountId: 'acc-agent', query: 'zebra' })).map((t) => t.chatId)).toEqual(['r-room']);
      expect((await repo.listSendTargets({ accountId: 'acc-agent', query: 'sweetHEART' })).map((t) => t.chatId)).toEqual(['u-alice']);
      expect(await repo.listSendTargets({ accountId: 'acc-agent', query: 'nobody-here' })).toEqual([]);
    });

    it('returns at most five member names plus the member count, and follows the limit', async () => {
      const [group] = await repo.listSendTargets({ accountId: 'acc-agent', query: 'Team Chat' });
      expect(group).toMatchObject({ title: 'Team Chat', memberCount: 7 });
      expect(group?.members).toHaveLength(5);
      expect(await repo.listSendTargets({ accountId: 'acc-agent', limit: 2 })).toHaveLength(2);
    });
  });

  it('getSendTarget is null for community, thread, the local room and unknown chats', async () => {
    expect(await repo.getSendTarget('acc-agent', 'group', 'g-team')).toEqual({ accountId: 'acc-agent', chatType: 'group', chatId: 'g-team' });
    expect(await repo.getSendTarget('acc-agent', 'community', 'c-comm')).toBeNull();
    expect(await repo.getSendTarget('acc-agent', 'thread', 't-thread')).toBeNull();
    expect(await repo.getSendTarget('acc-agent', 'direct', '__local_agent_room__')).toBeNull();
    expect(await repo.getSendTarget('acc-agent', 'group', 'missing')).toBeNull();
    expect(await repo.getSendTarget('acc-other', 'group', 'g-team')).toBeNull();
  });

  it('resolveSendSourceMessage masks recalled and source-deleted messages', async () => {
    const key = { accountId: 'acc-agent', chatType: 'group', chatId: 'g-team' };
    const normal = await repo.resolveSendSourceMessage({ ...key, messageId: 'm-normal' });
    expect(normal).toMatchObject({ kind: 'file', text: 'hello', masked: false });
    expect(normal?.attachments).toEqual([{
      attachmentId: att.normal, kind: 'file', name: 'normal.pdf', status: ATTACHMENT_STORED_STATUS, relativePath: 'a/b/spec.pdf', sha256: 'a'.repeat(64), sizeBytes: 2048,
    }]);
    for (const messageId of ['m-recalled', 'm-deleted']) {
      expect(await repo.resolveSendSourceMessage({ ...key, messageId })).toEqual({ kind: 'text', text: null, masked: true, attachments: [] });
    }
    expect(await repo.resolveSendSourceMessage({ ...key, messageId: 'nope' })).toBeNull();
  });

  it('getSendAttachment returns the attachment with the masked flag', async () => {
    expect(await repo.getSendAttachment(att.normal!)).toMatchObject({ attachmentId: att.normal, masked: false, status: 'ready', sizeBytes: 2048 });
    expect(await repo.getSendAttachment(att.recalled!)).toMatchObject({ masked: true });
    expect(await repo.getSendAttachment(att.deleted!)).toMatchObject({ masked: true });
    expect(await repo.getSendAttachment(randomUUID())).toBeNull();
    expect(await repo.getSendAttachment('not-a-uuid')).toBeNull();
  });

  it('recordLineSend stores no content columns and countJobLineSends counts sent, unknown and failed', async () => {
    const columns = await pool.query<{ column_name: string }>("SELECT column_name FROM information_schema.columns WHERE table_name = 'agent_line_sends' AND table_schema = current_schema()");
    expect(columns.rows.map((r) => r.column_name).sort()).toEqual([
      'account_id', 'byte_size', 'chat_id', 'chat_type', 'created_at', 'error_code', 'item_index', 'item_kind', 'job_id', 'principal_id', 'send_id', 'status',
    ]);
    const jobId = randomUUID();
    const base = { jobId, accountId: 'acc-agent', principalId: 'internal:ui', chatType: 'group', chatId: 'g-team', itemKind: 'text', byteSize: 5 } as const;
    expect(await repo.countJobLineSends(jobId)).toBe(0);
    await repo.recordLineSend({ ...base, itemIndex: 0, status: 'sent' });
    await repo.recordLineSend({ ...base, itemIndex: 1, status: 'unknown', errorCode: 'send_unknown' });
    await repo.recordLineSend({ ...base, itemIndex: 2, status: 'failed', errorCode: 'send_failed' });
    await repo.recordLineSend({ ...base, itemIndex: 3, status: 'denied', errorCode: 'send_target_invalid' });
    expect(await repo.countJobLineSends(jobId)).toBe(3);
    expect(await repo.countJobLineSends(randomUUID())).toBe(0);
  });
});
