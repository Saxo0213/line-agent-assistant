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

  it('persists generations, rejects stale completion and reads only durable ready identity', async () => {
    expect(await repository.setSecondaryRoot(key, 'C:/archive-one')).toMatchObject({ secondaryRoot: 'C:/archive-one', generation: 1 });
    expect(await repository.admitReadyAttachment(key, attachmentId, 1)).toBe(true);
    const [job] = await repository.claimJobs(1);
    expect(job).toMatchObject({ attachmentId, targetKind: 'secondary', generation: 1 });
    expect(await repository.setSecondaryRoot(key, 'C:/archive-two')).toMatchObject({ secondaryRoot: 'C:/archive-two', generation: 2 });
    expect(await repository.completeClaim(job!, 'legacy/2026/10/file.pdf', 'secondary/Sender/file.pdf')).toBe(false);
    expect((await pool.query('SELECT relative_path FROM attachments WHERE attachment_id=$1',[attachmentId])).rows[0]?.relative_path)
      .toBe('legacy/2026/10/file.pdf');
    expect(await repository.listStoredAttachments(key, null)).toMatchObject({ attachments: [{ attachmentId,
      messageId: 'message-1', name: '報告.pdf', senderId: 'sender-1', senderDisplayName: 'Saved Name' }], nextCursor: null });
  });
});
