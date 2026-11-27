import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AttachmentStorageRepository } from './attachment-storage-repository.js';
import { createTestDatabase } from './test-database.js';

const database = process.env.TEST_DATABASE_URL ? describe : describe.skip;
const attachmentId = '1d0e75be-1e96-4b65-9a08-8b804d4f4af1';

database('attachment storage repository (isolated PostgreSQL)', () => {
  let pool: Awaited<ReturnType<typeof createTestDatabase>>['pool'];
  let close: () => Promise<void>;
  let repository: AttachmentStorageRepository;
  const key = { accountId: 'storage-account', chatType: 'group' as const, chatId: 'storage-chat' };

  beforeAll(async () => {
    ({ pool, close } = await createTestDatabase());
    repository = new AttachmentStorageRepository(pool);
    await pool.query("INSERT INTO line_accounts(account_id) VALUES ('storage-account')");
    await pool.query("INSERT INTO conversations(account_id,chat_id,chat_type,title) VALUES ('storage-account','storage-chat','group','Test')");
    await pool.query(`INSERT INTO messages(account_id,message_id,event_id,chat_id,chat_type,sender_id,kind,ingestion_source,occurred_at,raw)
      VALUES ('storage-account','message-1','event-1','storage-chat','group','sender-1','file','live','2026-10-31T23:30:00Z','{}'::jsonb)`);
    await pool.query(`INSERT INTO attachments(attachment_id,external_attachment_id,account_id,chat_type,chat_id,message_id,kind,name,mime_type,size_bytes,status,relative_path,sha256)
      VALUES ($1,'external-1','storage-account','group','storage-chat','message-1','file','報告.pdf','application/pdf',4,'ready','legacy/2026/10/file.pdf',repeat('a',64))`, [attachmentId]);
    await pool.query("INSERT INTO line_contacts(account_id,mid,display_name,nickname) VALUES ('storage-account','sender-1','Profile','Saved Name')");
  });
  afterAll(async () => { await close?.(); });

  it('rejects completion for a removed folder and reads only durable ready identity', async () => {
    const first = (await repository.addFolder(key, 'C:/archive-one', 'invoices')).folder;
    expect(first).toMatchObject({ root: 'C:/archive-one', kind: 'classified', description: 'invoices' });
    await expect(repository.addFolder(key, 'c:/ARCHIVE-one/')).rejects.toMatchObject({ code: 'DUPLICATE_FOLDER' });
    expect(await repository.admitReadyAttachment(key, attachmentId, first.folderId)).toBe(true);
    const [job] = await repository.claimJobs(1);
    expect(job).toMatchObject({ attachmentId, targetKind: 'secondary', folderId: first.folderId });
    await repository.removeFolder(key, first.folderId);
    await repository.addFolder(key, 'C:/archive-two');
    expect(await repository.completeClaim(job!, 'legacy/2026/10/file.pdf', 'secondary/Sender/file.pdf')).toBe(false);
    expect((await pool.query('SELECT relative_path FROM attachments WHERE attachment_id=$1',[attachmentId])).rows[0]?.relative_path)
      .toBe('legacy/2026/10/file.pdf');
    expect(await repository.listStoredAttachments(key, null)).toMatchObject({ attachments: [{ attachmentId,
      messageId: 'message-1', name: '報告.pdf', senderId: 'sender-1', senderDisplayName: 'Saved Name' }], nextCursor: null });
  });

  it('lists senders with counts, filters by sender and shows the kind for the placeholder name "undefined"', async () => {
    const otherId = '2d0e75be-1e96-4b65-9a08-8b804d4f4af2';
    await pool.query(`INSERT INTO messages(account_id,message_id,event_id,chat_id,chat_type,sender_id,kind,ingestion_source,occurred_at,raw)
      VALUES ('storage-account','message-2','event-2','storage-chat','group','sender-2','image','live','2026-11-01T01:00:00Z','{}'::jsonb)`);
    await pool.query(`INSERT INTO attachments(attachment_id,external_attachment_id,account_id,chat_type,chat_id,message_id,kind,name,mime_type,size_bytes,status,relative_path,sha256)
      VALUES ($1,'external-2','storage-account','group','storage-chat','message-2','image','undefined','image/jpeg',4,'ready','legacy/2026/11/attachment.jpg',repeat('b',64))`, [otherId]);
    expect(await repository.listStoredAttachmentSenders(key)).toEqual([
      { senderId: 'sender-1', senderDisplayName: 'Saved Name', count: 1 },
      { senderId: 'sender-2', senderDisplayName: '未知發言人', count: 1 },
    ]);
    const all = await repository.listStoredAttachments(key, null);
    expect(all.attachments.find((entry) => entry.attachmentId === otherId)?.name).toBe('image');
    const filtered = await repository.listStoredAttachments(key, null, 50, 'sender-2');
    expect(filtered.attachments.map((entry) => entry.attachmentId)).toEqual([otherId]);
  });
});
