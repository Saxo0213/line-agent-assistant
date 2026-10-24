import { createHash } from 'node:crypto';
import { getEventListeners } from 'node:events';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { Pool } from 'pg';
import type { InboundEnvelope, MessageContent } from '@line-agent/contracts';
import { createTestDatabase } from '../test-database.js';
import { MessageRepository } from '../message-repository.js';
import { CONTENT_BRIDGE_RULES, type BridgeRule } from './index.js';
import { reprojectContent } from './reproject.js';
import { dpapiEnvelope, plainEnvelope } from './test-support.js';

const database = process.env.TEST_DATABASE_URL ? describe : describe.skip;
const ACCOUNT = 'account-bridge';

database('content bridge write-time conversion and re-projection (PostgreSQL)', () => {
  let pool: Pool;
  let close: () => Promise<void>;
  let sequence = 0;

  beforeAll(async () => {
    ({ pool, close } = await createTestDatabase());
    await pool.query('INSERT INTO line_accounts (account_id) VALUES ($1)', [ACCOUNT]);
    await pool.query("INSERT INTO conversations (account_id, chat_type, chat_id) VALUES ($1,'direct','chat-1')", [ACCOUNT]);
  });
  afterAll(async () => { await close?.(); });

  async function insertRow(id: string, raw: Record<string, unknown>, extra: { version?: number; content?: MessageContent | null } = {}): Promise<void> {
    await pool.query(`INSERT INTO messages (account_id,message_id,event_id,chat_type,chat_id,sender_id,kind,text_content,content,content_rule_version,
      mention_ids,mention_ranges,ingestion_source,occurred_at,raw)
      VALUES ($1,$2,$3,'direct','chat-1','sender','event',NULL,$4::jsonb,$5,'[]','[]','history',now() + ($6 || ' seconds')::interval,$7::jsonb)`,
    [ACCOUNT, id, `event-${id}`, extra.content ? JSON.stringify(extra.content) : null, extra.version ?? 0, String(++sequence), JSON.stringify(raw)]);
  }
  const nativeRaw = (fields: Record<string, string | number | null>) =>
    ({ message: { id: 'x', contentType: fields._contentType }, native: plainEnvelope({ _id: 'x', ...fields }) });
  const liveRaw = (message: Record<string, unknown>) => ({ revision: 1, message: { id: 'x', ...message } });
  const state = async () => (await pool.query<{ message_id: string; content: MessageContent | null; content_rule_version: number; reply_to_message_id: string | null }>(
    'SELECT message_id,content,content_rule_version,reply_to_message_id FROM messages WHERE account_id=$1 ORDER BY message_id', [ACCOUNT])).rows;
  const layerOneHash = async () => createHash('sha256').update(JSON.stringify((await pool.query(
    'SELECT message_id,raw,raw->\'native\' AS native,text_content FROM messages WHERE account_id=$1 ORDER BY message_id', [ACCOUNT])).rows)).digest('hex');
  const byId = async (id: string) => (await state()).find((row) => row.message_id === id)!;

  it('C2/C3: converts only rows below the rule version, and a version bump re-converts only the matching source and type', async () => {
    await insertRow('n-contact', nativeRaw({ _contentType: 13, _contentMetadata: JSON.stringify({ mid: 'u1', displayName: 'Friend' }) }));
    await insertRow('n-call', nativeRaw({ _contentType: 6, _text: 'call' }));
    await insertRow('n-text', nativeRaw({ _contentType: 0, _text: 'hello' }));
    await insertRow('n-dpapi', { message: { id: 'x', contentType: 13 }, native: dpapiEnvelope('1'.repeat(64)) });
    await insertRow('l-call', liveRaw({ contentType: 'CALL', text: 'live call' }));
    await insertRow('l-text', liveRaw({ contentType: 'NONE', text: 'hi' }));
    await insertRow('l-failed', { contentState: 'decrypt_failed', message: { contentType: 6 } });
    await insertRow('l-contact', {});
    await insertRow('l-current', liveRaw({ contentType: 17, contentMetadata: { ALT_TEXT: 'kept' } }),
      { version: 1, content: { format: 1, type: 'rich', variant: 'rich', altText: 'already current' } });

    const hashBefore = await layerOneHash();
    const first = await reprojectContent(pool);
    expect(first).toMatchObject({ cancelled: false, rows: 4 });
    expect((await byId('n-contact'))).toMatchObject({ content: { type: 'contact', mid: 'u1', displayName: 'Friend' }, content_rule_version: 1 });
    expect((await byId('n-call'))).toMatchObject({ content: { type: 'event', nativeContentType: 6, text: 'call' }, content_rule_version: 1 });
    expect((await byId('l-call'))).toMatchObject({ content: { type: 'event', nativeContentType: 6, text: 'live call' }, content_rule_version: 1 });
    // Untouched: text rules have no projection, dpapi / decrypt-failed / contact-only raws are unreadable, current rows stay.
    expect(await byId('n-text')).toMatchObject({ content: null, content_rule_version: 1 });
    for (const id of ['n-dpapi', 'l-text', 'l-failed', 'l-contact']) {
      expect(await byId(id)).toMatchObject({ content: null, content_rule_version: 0 });
    }
    expect(await byId('l-current')).toMatchObject({ content: { altText: 'already current' }, content_rule_version: 1 });
    expect(await layerOneHash()).toBe(hashBefore);
    expect(await reprojectContent(pool)).toMatchObject({ rows: 0, batches: 0 });

    // Bump only the native CALL rule to version 2.
    const bumped: readonly BridgeRule[] = CONTENT_BRIDGE_RULES.map((rule) => rule.source === 'native' && rule.contentType === 6
      ? { ...rule, version: 2, convert: (fields) => ({ format: 1, type: 'event', nativeContentType: 6, text: `v2:${fields.text}` }) } : rule);
    const before = await state();
    const second = await reprojectContent(pool, { rules: bumped });
    expect(second.rows).toBe(1);
    const after = await state();
    expect(after.find((row) => row.message_id === 'n-call')).toMatchObject({ content: { text: 'v2:call' }, content_rule_version: 2 });
    for (const row of before.filter((item) => item.message_id !== 'n-call')) {
      expect(after.find((item) => item.message_id === row.message_id)).toEqual(row);
    }
    expect(await layerOneHash()).toBe(hashBefore);
    expect(await reprojectContent(pool, { rules: bumped })).toMatchObject({ rows: 0 });
  });

  it('C4: a cancel keeps the committed batches, a restart resumes, and no timer or listener remains after the drain', async () => {
    for (let index = 0; index < 7; index++) await insertRow(`resume-${index}`, nativeRaw({ _contentType: 9, _text: `gift ${index}` }));
    const hashBefore = await layerOneHash();
    const controller = new AbortController();
    const quietPool = new Pool({ ...(pool as unknown as { options: ConstructorParameters<typeof Pool>[0] }).options, max: 1 });
    const timers = vi.spyOn(globalThis, 'setTimeout');
    const intervals = vi.spyOn(globalThis, 'setInterval');
    const batches: number[] = [];
    try {
      const first = await reprojectContent(quietPool, { signal: controller.signal, batchSize: 2,
        onBatchCommitted: (batch) => { batches.push(batch.rows); controller.abort(); } });
      expect(first).toEqual({ rows: 2, batches: 1, cancelled: true });
      const committed = (await state()).filter((row) => row.message_id.startsWith('resume-') && row.content_rule_version === 1);
      expect(committed).toHaveLength(2);

      const second = await reprojectContent(quietPool, { batchSize: 2, onBatchCommitted: (batch) => batches.push(batch.rows) });
      expect(second).toEqual({ rows: 5, batches: 3, cancelled: false });
      expect(batches).toEqual([2, 2, 2, 1]);
    } finally {
      // The pg pool's own idle-client timer is not the job's; any other timer or interval would be.
      const timerCalls = [...timers.mock.calls, ...intervals.mock.calls]
        .filter(([callback]) => !String(callback).includes('remove idle client')).length;
      timers.mockRestore();
      intervals.mockRestore();
      await quietPool.end();
      expect(timerCalls).toBe(0);
    }
    expect(getEventListeners(controller.signal, 'abort')).toHaveLength(0);
    expect((await state()).filter((row) => row.message_id.startsWith('resume-') && row.content_rule_version === 1)).toHaveLength(7);
    expect(await layerOneHash()).toBe(hashBefore);
  });

  it('never exceeds the 500-row hard batch limit and stamps reply ids only when missing', async () => {
    await insertRow('reply-keep', nativeRaw({ _contentType: 16, _text: 'post', _messageRelationType: 3, _relatedMessageId: 'new-parent' }));
    await pool.query("UPDATE messages SET reply_to_message_id='old-parent' WHERE account_id=$1 AND message_id='reply-keep'", [ACCOUNT]);
    await insertRow('reply-set', nativeRaw({ _contentType: 18, _text: 'ev', _messageRelationType: 3, _relatedMessageId: 'parent' }));
    const sizes: number[] = [];
    await reprojectContent(pool, { batchSize: 100_000, onBatchCommitted: (batch) => sizes.push(batch.rows) });
    expect(Math.max(...sizes)).toBeLessThanOrEqual(500);
    expect(await byId('reply-keep')).toMatchObject({ reply_to_message_id: 'old-parent', content: { nativeContentType: 16 } });
    expect(await byId('reply-set')).toMatchObject({ reply_to_message_id: 'parent', content: { nativeContentType: 18 } });
  });

  it('C8: neither the IPC message DTO nor the MCP message tool exposes raw, raw.native or catalog payloads', async () => {
    const repository = new MessageRepository(pool);
    const key = { accountId: ACCOUNT, chatType: 'direct' as const, chatId: 'chat-1' };
    const listed = (await repository.listMessages(key, null, 200)).messages;
    expect(listed.length).toBeGreaterThan(0);
    const mcp = await repository.queryTargetMessages({ accountIds: [ACCOUNT], chatType: 'direct', chatId: 'chat-1', limit: 200 });
    expect(mcp.length).toBeGreaterThan(0);
    for (const row of [...listed, ...mcp]) {
      expect(Object.keys(row)).not.toContain('raw');
      const json = JSON.stringify(row);
      expect(json).not.toContain('"native"');
      expect(json).not.toContain('sourceDigest');
      expect(json).not.toContain('"sqliteType"');
    }
    expect(listed.some((row) => row.content !== null && row.content !== undefined)).toBe(true);
  });

  it('C1: live inserts store content, rule version and the reply id in the insert transaction', async () => {
    const repository = new MessageRepository(pool);
    const envelope = (id: string, overrides: Partial<InboundEnvelope>): InboundEnvelope => ({
      eventId: `ev-${id}`, accountId: ACCOUNT, chatId: 'chat-live', chatType: 'direct', senderId: 'peer', messageId: id, kind: 'event',
      text: null, mentionIds: [], mentionRanges: [], replyToMessageId: null, ingestion: { source: 'live', cursor: `c-${id}` },
      occurredAt: '2026-10-20T00:00:00.000Z', attachments: [], raw: {}, ...overrides });
    await repository.ingestAndRoute(envelope('live-gift', { raw: liveRaw({ contentType: 9, text: 'a gift', messageRelationType: 3, relatedMessageId: 'live-parent' }) }), { eligible: false });
    await repository.ingestAndRoute(envelope('live-loc', { kind: 'location', raw: liveRaw({ contentType: 15, location: { title: 'T', latitude: 1, longitude: 2 } }) }), { eligible: false });
    await repository.ingestAndRoute(envelope('live-contact', { kind: 'contact', contact: { mid: `u${'a'.repeat(32)}`, displayName: 'Bob' } }), { eligible: false });
    await repository.ingestAndRoute(envelope('live-text', { kind: 'text', text: 'hello', raw: liveRaw({ contentType: 'NONE', text: 'hello' }) }), { eligible: false });
    await repository.ingestAndRoute(envelope('live-failed', { raw: { contentState: 'decrypt_failed', message: { contentType: 6 } } }), { eligible: false });
    expect(await byId('live-gift')).toMatchObject({ content: { type: 'event', nativeContentType: 9, text: 'a gift' }, content_rule_version: 1, reply_to_message_id: 'live-parent' });
    expect(await byId('live-loc')).toMatchObject({ content: { type: 'location', title: 'T', latitude: 1, longitude: 2 }, content_rule_version: 1 });
    expect(await byId('live-contact')).toMatchObject({ content: { type: 'contact', displayName: 'Bob' }, content_rule_version: 1 });
    expect(await byId('live-text')).toMatchObject({ content: null, content_rule_version: 0 });
    expect(await byId('live-failed')).toMatchObject({ content: null, content_rule_version: 0 });
  });

  it('B1: adding an exact rule re-projects rows the * fallback already stamped, and leaves every other row alone', async () => {
    await insertRow('b1-link-1', liveRaw({ contentType: 'LINK', text: 'first' }));
    await insertRow('b1-link-2', liveRaw({ contentType: 12, text: 'second' }));
    await insertRow('b1-call', liveRaw({ contentType: 'CALL', text: 'ring' }));
    await reprojectContent(pool);
    expect(await byId('b1-link-1')).toMatchObject({ content: { type: 'unsupported', nativeContentType: 12, fallbackText: 'first' }, content_rule_version: 1 });
    const hashBefore = await layerOneHash();
    const before = await state();
    const added: BridgeRule = { source: 'live', contentType: 12, version: 1,
      convert: (fields) => ({ format: 1, type: 'event', nativeContentType: 12, text: `link:${fields.text}` }) };
    const rules = [added, ...CONTENT_BRIDGE_RULES];
    expect((await reprojectContent(pool, { rules })).rows).toBe(2);
    const after = await state();
    expect(after.find((row) => row.message_id === 'b1-link-1')).toMatchObject({ content: { type: 'event', text: 'link:first' }, content_rule_version: 1 });
    expect(after.find((row) => row.message_id === 'b1-link-2')).toMatchObject({ content: { type: 'event', text: 'link:second' } });
    const changed = new Set(['b1-link-1', 'b1-link-2']);
    expect(after.filter((row) => !changed.has(row.message_id))).toEqual(before.filter((row) => !changed.has(row.message_id)));
    expect(await layerOneHash()).toBe(hashBefore);
    expect(await reprojectContent(pool, { rules })).toMatchObject({ rows: 0 });
  });

  it('re-projects a stored native type-15 member-removal row to event content and kind, and leaves plain text rows null with kind text', async () => {
    const names = { ua: '甲', ub: '乙' };
    await insertRow('ev-removal', nativeRaw({ _contentType: 0, _text: '', _contentMetadata: '',
      _eventInfo: JSON.stringify({ type: 15, fromId: 'ua', midList: ['ub'], displayNameMap: names, param: '' }) }));
    await insertRow('ev-text', nativeRaw({ _contentType: 0, _text: 'plain words', _eventInfo: '' }));
    await insertRow('ev-14', nativeRaw({ _contentType: 0, _text: '', _eventInfo: JSON.stringify({ type: 14, fromId: 'ua', midList: [], displayNameMap: names }) }));
    await pool.query("UPDATE messages SET kind='text' WHERE account_id=$1 AND message_id IN ('ev-removal','ev-text','ev-14')", [ACCOUNT]);
    expect((await byId('ev-removal')).content_rule_version).toBe(0);
    const hashBefore = await layerOneHash();
    await reprojectContent(pool);
    expect(await byId('ev-removal')).toMatchObject({ content: { format: 1, type: 'event', nativeContentType: 0, text: '甲已將乙強制退出社群。' }, content_rule_version: 2 });
    expect(await byId('ev-text')).toMatchObject({ content: null, content_rule_version: 2 });
    expect(await byId('ev-14')).toMatchObject({ content: { format: 1, type: 'event', nativeContentType: 0, text: '甲加入聊天' }, content_rule_version: 2 });
    const kinds = await pool.query<{ message_id: string; kind: string }>(
      "SELECT message_id,kind FROM messages WHERE account_id=$1 AND message_id IN ('ev-removal','ev-text','ev-14') ORDER BY message_id", [ACCOUNT]);
    expect(kinds.rows).toEqual([{ message_id: 'ev-14', kind: 'event' }, { message_id: 'ev-removal', kind: 'event' }, { message_id: 'ev-text', kind: 'text' }]);
    expect(await layerOneHash()).toBe(hashBefore);
    expect(await reprojectContent(pool)).toMatchObject({ rows: 0 });
  });

  it('N1/N2: live rule 15 reaches legacy contentType-0 location rows, and native rows get the bridge kind while live keeps its kind', async () => {
    await insertRow('n1-legacy-loc', liveRaw({ contentType: 'NONE', text: 'pin', location: { title: 'Pin', latitude: 1, longitude: 2 } }));
    await insertRow('n2-native-loc', nativeRaw({ _contentType: 15, _text: 'Native pin' }));
    await pool.query("UPDATE messages SET kind='event' WHERE account_id=$1 AND message_id IN ('n1-legacy-loc','n2-native-loc')", [ACCOUNT]);
    await reprojectContent(pool);
    expect(await byId('n1-legacy-loc')).toMatchObject({ content: { type: 'location', title: 'Pin', latitude: 1 }, content_rule_version: 1 });
    expect(await byId('n2-native-loc')).toMatchObject({ content: { type: 'location', title: 'Native pin' } });
    const kinds = await pool.query<{ message_id: string; kind: string }>(
      "SELECT message_id,kind FROM messages WHERE account_id=$1 AND message_id IN ('n1-legacy-loc','n2-native-loc') ORDER BY message_id", [ACCOUNT]);
    expect(kinds.rows).toEqual([{ message_id: 'n1-legacy-loc', kind: 'event' }, { message_id: 'n2-native-loc', kind: 'location' }]);
  });
  it('re-projects a version-1 native chat event (type 18) with names from contacts and the account owner', async () => {
    const owner = 'ua'.padEnd(33, 'a');
    const friend = 'ub'.padEnd(33, 'b');
    const stranger = 'uc'.padEnd(33, 'c');
    await pool.query("UPDATE line_accounts SET own_mid=$2, display_name='小薪' WHERE account_id=$1", [ACCOUNT, owner]);
    await pool.query("INSERT INTO line_contacts(account_id,mid,display_name,nickname) VALUES ($1,$2,'徐佳誠 (profile)','徐佳誠')", [ACCOUNT, friend]);
    const event = (locKey: string, locArgs: string) => nativeRaw({ _contentType: 18, _text: '', _contentMetadata: JSON.stringify({ LOC_KEY: locKey, LOC_ARGS: locArgs }) });
    const oldContent: MessageContent = { format: 1, type: 'event', nativeContentType: 18, text: null };
    await insertRow('ce-added', event('C_MI', owner + '' + friend + '' + stranger), { version: 1, content: oldContent });
    await insertRow('ce-unknown', event('NOT_KNOWN', owner), { version: 1, content: oldContent });
    await insertRow('ce-current', event('C_MJ', friend), { version: 2, content: oldContent });
    const hashBefore = await layerOneHash();
    await reprojectContent(pool);
    expect(await byId('ce-added')).toMatchObject({ content_rule_version: 2,
      content: { type: 'event', nativeContentType: 18, text: '小薪已新增徐佳誠, 成員至群組。' } });
    expect(await byId('ce-unknown')).toMatchObject({ content_rule_version: 2, content: { type: 'event', nativeContentType: 18, text: null } });
    expect(await byId('ce-current')).toMatchObject({ content_rule_version: 2, content: { text: null } });
    expect(await layerOneHash()).toBe(hashBefore);
    expect(await reprojectContent(pool)).toMatchObject({ rows: 0 });
  });
});
