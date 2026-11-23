import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Pool } from 'pg';
import { createTestDatabase } from './test-database.js';
import { MessageRepository } from './message-repository.js';

const database = process.env.TEST_DATABASE_URL ? describe : describe.skip;
database('message and attachment pagination', () => {
  let pool: Pool; let close: () => Promise<void>; let repo: MessageRepository;
  const key = { accountId: 'a', chatType: 'direct' as const, chatId: 'c' };
  beforeAll(async () => {
    ({ pool, close } = await createTestDatabase()); repo = new MessageRepository(pool);
    for (const number of [1, 2, 3]) await repo.ingestAndRoute({ eventId: `e${number}`, ...key, senderId: 'u', messageId: `m${number}`,
      kind: 'text', text: `item ${number}`, mentionIds: [], mentionRanges: [], replyToMessageId: null,
      ingestion: { source: 'live', cursor: null }, occurredAt: `2026-10-15T00:00:0${number}.000Z`, raw: {},
      attachments: [{ id: `attachment-${number}`, kind: 'image', name: `${number}.jpg`, mimeType: 'image/jpeg', sizeBytes: number }] }, { eligible: false });
  });
  afterAll(async () => { await close?.(); });
  it('pages by opaque message and attachment IDs without skipping records', async () => {
    const first = await repo.listMessages(key, null, 2);
    expect(first.messages.map((message) => message.messageId)).toEqual(['m2', 'm3']);
    const second = await repo.listMessages(key, first.nextCursor, 2);
    expect(second.messages.map((message) => message.messageId)).toEqual(['m1']);
    const attachments = await repo.listAttachments(key, null, 2);
    expect(attachments.attachments).toHaveLength(2);
    expect((await repo.listAttachments(key, attachments.nextCursor, 2)).attachments).toHaveLength(1);
  });
  it('reads an exact older message with the same projection as timeline pages', async () => {
    const oldMessage = await repo.getMessage(key, 'm1');
    expect(oldMessage).toMatchObject({ messageId: 'm1', text: 'item 1', kind: 'text', content: null });
    expect(await repo.getMessage(key, 'missing')).toBeNull();
  });
  it('projects live chat event names from contacts and the account owner without exposing MIDs', async () => {
    const eventKey = { accountId: 'chat-event-names', chatType: 'group' as const, chatId: `c${'8'.repeat(32)}` };
    const actor = `u${'1'.repeat(32)}`; const own = `u${'2'.repeat(32)}`;
    await pool.query("INSERT INTO line_accounts(account_id,display_name,own_mid) VALUES ($1,'Account Owner',$2)", [eventKey.accountId, own]);
    await pool.query("INSERT INTO line_contacts(account_id,mid,display_name) VALUES ($1,$2,'Contact Actor')", [eventKey.accountId, actor]);
    await repo.ingestAndRoute({ eventId: 'chat-event-name-event', ...eventKey, senderId: 'sender-safe', messageId: 'chat-event-name-row',
      kind: 'event', text: null, mentionIds: [], mentionRanges: [], replyToMessageId: null,
      ingestion: { source: 'live', cursor: null }, occurredAt: '2026-10-15T00:00:05.000Z',
      raw: { message: { contentType: 18, text: '', contentMetadata: { LOC_KEY: 'C_MI', LOC_ARGS: `${actor}\u001e${own}` } } }, attachments: [] }, { eligible: false });
    const row = (await repo.listMessages(eventKey, null, 10)).messages[0]!;
    expect(row.content).toMatchObject({ type: 'event', text: 'Contact Actor已新增Account Owner至群組。' });
    expect(JSON.stringify(row)).not.toContain(actor);
    expect(JSON.stringify(row)).not.toContain(own);
  });
  it('shows the event line as text and finds an event row by line text, member id and member name', async () => {
    const eventKey = { accountId: 'event-text', chatType: 'community' as const, chatId: 'event-chat' };
    const admin = `u${'3'.repeat(32)}`; const member = `u${'4'.repeat(32)}`;
    await pool.query("INSERT INTO line_accounts(account_id,display_name,own_mid) VALUES ($1,$1,'event-own')", [eventKey.accountId]);
    await pool.query("INSERT INTO conversations (account_id, chat_type, chat_id, title, updated_at) VALUES ($1,$2,$3,'Community',now())",
      [eventKey.accountId, eventKey.chatType, eventKey.chatId]);
    await pool.query(
      `INSERT INTO messages (account_id, message_id, event_id, chat_id, chat_type, sender_id, kind, text_content, ingestion_source, occurred_at, raw, content)
       VALUES ($1,'event-row','event-row-ev',$2,$3,$4,'event','','live',now(),$5::jsonb,$6::jsonb)`,
      [eventKey.accountId, eventKey.chatId, eventKey.chatType, admin, JSON.stringify({ midList: [member] }),
        JSON.stringify({ format: 1, type: 'event', nativeContentType: 0, text: 'Admin已將Member強制退出社群。' })]);
    const find = (extra: object) => repo.queryTargetMessages({ accountIds: [eventKey.accountId], chatType: eventKey.chatType, chatId: eventKey.chatId, limit: 20, ...extra });
    expect((await find({}))[0]).toMatchObject({ messageId: 'event-row', kind: 'event', text: 'Admin已將Member強制退出社群。' });
    expect((await find({ text: '強制退出' })).map((row) => row.messageId)).toEqual(['event-row']);
    expect((await find({ senderId: member })).map((row) => row.messageId)).toEqual(['event-row']);
    expect((await find({ senderName: 'Member' })).map((row) => row.messageId)).toEqual(['event-row']);
    await pool.query(
      `INSERT INTO messages (account_id, message_id, event_id, chat_id, chat_type, sender_id, kind, text_content, ingestion_source, occurred_at, raw, content)
       VALUES ($1,'note-row','note-row-ev',$2,$3,$4,'event','','live',now(),$5::jsonb,$6::jsonb)`,
      [eventKey.accountId, eventKey.chatId, eventKey.chatType, admin, JSON.stringify({ midList: [member] }),
        JSON.stringify({ format: 1, type: 'event', nativeContentType: 16, text: 'Member posted a note.' })]);
    // A note is free user text: member filters do not match it, but it still shows its line.
    expect((await find({ senderName: 'Member' })).map((row) => row.messageId)).toEqual(['event-row']);
    expect((await find({ target: 'Member' })).map((row) => row.messageId)).toEqual(['event-row']);
    expect((await find({ text: 'posted a note' })).map((row) => row.messageId)).toEqual(['note-row']);
    // A 2-character target that occurs only in the raw JSON (inside the member id) does not match through the raw id rule.
    expect(await find({ target: '44' })).toEqual([]);
    expect((await find({ target: member })).map((row) => row.messageId)).toEqual(['event-row']);
  });
  it('filters search by account, date and attachment presence', async () => {
    expect((await repo.searchMessages({ accountId: 'a', from: '2026-10-15T00:00:02Z', hasAttachment: true, limit: 10 })).map((row) => row.messageId)).toEqual(['m3', 'm2']);
    expect(await repo.searchMessages({ accountId: 'other', limit: 10 })).toHaveLength(0);
  });
  it('uses the same attachment display names in state, list and MCP projections', async () => {
    const displayKey = { accountId: 'display-names', chatType: 'group' as const, chatId: 'display-chat' };
    await pool.query("INSERT INTO line_accounts(account_id,display_name,own_mid) VALUES ($1,$1,'display-own')", [displayKey.accountId]);
    const kinds = ['image', 'video', 'audio', 'file'] as const;
    const names = [null, '  ', 'real-name.ext'] as const;
    const expected = { image: '圖片', video: '影片', audio: '語音', file: '檔案' } as const;
    const ids: string[] = [];
    const attachmentKinds = new Map<string, typeof kinds[number]>();
    for (const kind of kinds) {
      const attachments = names.map((name, index) => ({ id: `display-${kind}-${index}`, kind,
        name, mimeType: null, sizeBytes: 1 }));
      await repo.ingestAndRoute({ eventId: `display-event-${kind}`, ...displayKey, senderId: 'display-sender',
        messageId: `display-message-${kind}`, kind: 'text', text: kind, mentionIds: [], mentionRanges: [], replyToMessageId: null,
        ingestion: { source: 'live', cursor: null }, occurredAt: `2026-10-16T00:00:0${kinds.indexOf(kind)}.000Z`, raw: {}, attachments }, { eligible: false });
    }
    const listed = await repo.listAttachments(displayKey, null, 20);
    for (const item of listed.attachments) { ids.push(item.attachmentId); attachmentKinds.set(item.attachmentId, item.kind); }
    const unnamed = listed.attachments.find((item) => item.name === '圖片')!;
    await pool.query("UPDATE attachments SET status='ready',relative_path='managed/completed.bin',sha256=$2,size_bytes=1 WHERE attachment_id=$1",
      [unnamed.attachmentId, 'a'.repeat(64)]);
    const completedList = await repo.listAttachments(displayKey, null, 20);

    const states = await repo.listAttachmentStates(displayKey, ids);
    const mcp = await repo.queryTargetMessages({ accountIds: [displayKey.accountId], chatType: displayKey.chatType, chatId: displayKey.chatId, limit: 20 });
    const mcpNames = new Map(mcp.flatMap((message) => message.attachments.map((item) => [item.attachmentId, item.name] as const)));
    const assertNames = (projection: Map<string, string | null | undefined>) => {
      for (const item of listed.attachments) {
        const kind = attachmentKinds.get(item.attachmentId)!;
        const index = item.name === expected[kind] ? (names.indexOf(null)) : item.name === 'real-name.ext' ? 2 : 1;
        const want = names[index] === null || names[index] === '  ' ? expected[kind] : 'real-name.ext';
        expect(projection.get(item.attachmentId)).toBe(want);
      }
    };
    assertNames(new Map(completedList.attachments.map((item) => [item.attachmentId, item.name])));
    assertNames(new Map(states.map((item) => [item.attachmentId, item.name])));
    assertNames(mcpNames);
    expect(states.find((item) => item.attachmentId === unnamed.attachmentId)).toMatchObject({ name: '圖片', status: 'ready' });
    expect([...states.map((item) => item.name), ...mcpNames.values()]).not.toContain(unnamed.attachmentId);
    expect([null, '  ']).toContain((await repo.getAttachment(unnamed.attachmentId))?.name);
  });
});
