import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { InboundEnvelope } from '@line-agent/contracts';
import type { Pool } from 'pg';
import { AccountRepository } from './account-repository.js';
import { MessageRepository } from './message-repository.js';
import { createTestDatabase } from './test-database.js';

const database = process.env.TEST_DATABASE_URL ? describe : describe.skip;
const DAY_MS = 24 * 60 * 60 * 1_000;
let sequence = 0;

function envelope(accountId: string, overrides: Partial<InboundEnvelope> = {}): InboundEnvelope {
  const id = ++sequence;
  return {
    eventId: `block-event-${id}`, accountId, chatId: 'chat-block', chatType: 'group',
    senderId: 'sender-block', messageId: `block-message-${id}`, kind: 'file', text: null,
    mentionIds: [], mentionRanges: [], replyToMessageId: null,
    ingestion: { source: 'live', cursor: `block-cursor-${id}` },
    occurredAt: new Date().toISOString(), attachments: [{ id: `block-att-${id}`, kind: 'file', name: 'a.bin', mimeType: null, sizeBytes: 1 }],
    raw: {}, ...overrides,
  };
}

database('attachment block reasons', () => {
  let pool: Pool;
  let close: (() => Promise<void>) | undefined;
  let repository: MessageRepository;
  beforeAll(async () => {
    ({ pool, close } = await createTestDatabase());
    repository = new MessageRepository(pool);
  });
  afterAll(async () => { await close?.(); });

  async function ingest(accountId: string, overrides: Partial<InboundEnvelope> = {}) {
    const input = envelope(accountId, overrides);
    await repository.ingestAndRoute(input, { eligible: false });
    const attachment = await repository.getAttachmentBySource({ accountId, chatType: input.chatType, chatId: input.chatId },
      input.messageId, input.attachments[0]!.id);
    return { input, attachmentId: attachment!.attachmentId };
  }

  /** Give the message the External Monitor provenance, as the External Monitor import does. */
  async function markExternal(accountId: string, messageIds: string[]) {
    const sourceId = randomUUID();
    await pool.query(`INSERT INTO line_account_sources(account_id, source_id, generation, source_type, state, identity_digest, verified_account_mid)
      VALUES ($1, $2, 1, 'EXTERNAL_MONITOR', 'ACTIVE', repeat('a', 64), 'own-block')`, [accountId, sourceId]);
    await pool.query(`INSERT INTO external_source_batches(source_id,account_id,generation,batch_id,payload_digest,result)
      VALUES ($1,$2,1,'block-batch',repeat('b',64),'{}'::jsonb)`, [sourceId, accountId]);
    for (const messageId of messageIds) {
      await pool.query(`INSERT INTO external_source_observations(source_id,account_id,generation,observation_id,batch_id,canonical_message_id,normalized_digest,normalized_payload,status)
        VALUES ($1,$2,1,$3,'block-batch',$4,repeat('c',64),'{}'::jsonb,'PROJECTED')`, [sourceId, accountId, `obs-${messageId}`, messageId]);
      await pool.query(`INSERT INTO message_source_provenance(account_id, message_id, source_id, generation, observation_id, origin, redacted)
        VALUES ($1, $2, $3, 1, $4, 'EXTERNAL_MONITOR', true)`, [accountId, messageId, sourceId, `obs-${messageId}`]);
    }
  }

  const row = async (attachmentId: string) => (await pool.query<{ status: string; error: string | null; retry_count: number; updated_at: Date }>(
    'SELECT status, error, retry_count, updated_at FROM attachments WHERE attachment_id=$1', [attachmentId])).rows[0]!;

  it('writes a reason on a queued row only when the value changes and keeps the row unclaimed', async () => {
    const { attachmentId } = await ingest('block-write');
    const before = await row(attachmentId);
    expect(before).toMatchObject({ status: 'queued', error: null, retry_count: 0 });
    expect(await repository.setAttachmentBlockReason(attachmentId, 'ATTACHMENT_WORKER_UNAVAILABLE')).toBe(true);
    expect(await repository.setAttachmentBlockReason(attachmentId, 'ATTACHMENT_WORKER_UNAVAILABLE')).toBe(false);
    const written = await row(attachmentId);
    expect(written).toMatchObject({ status: 'queued', error: 'ATTACHMENT_WORKER_UNAVAILABLE', retry_count: 0 });
    expect(written.updated_at.getTime()).toBe(before.updated_at.getTime());
    expect(await repository.setAttachmentBlockReason(attachmentId, 'ATTACHMENT_WORKER_NOT_READY')).toBe(true);
    expect((await row(attachmentId)).error).toBe('ATTACHMENT_WORKER_NOT_READY');
    expect((await repository.getAttachment(attachmentId))?.error).toBe('ATTACHMENT_WORKER_NOT_READY');
  });

  it('keeps a real error and writes nothing on a row that is not queued', async () => {
    const { attachmentId } = await ingest('block-real');
    await pool.query("UPDATE attachments SET error='LINE_NATIVE_DOWNLOAD_FAILED' WHERE attachment_id=$1", [attachmentId]);
    expect(await repository.setAttachmentBlockReason(attachmentId, 'ATTACHMENT_WORKER_NOT_READY')).toBe(false);
    expect((await row(attachmentId)).error).toBe('LINE_NATIVE_DOWNLOAD_FAILED');
    await pool.query("UPDATE attachments SET status='failed', error='LINE_NATIVE_DOWNLOAD_FAILED' WHERE attachment_id=$1", [attachmentId]);
    expect(await repository.setAttachmentBlockReason(attachmentId, 'ATTACHMENT_WORKER_NOT_READY')).toBe(false);
    expect((await row(attachmentId)).error).toBe('LINE_NATIVE_DOWNLOAD_FAILED');
  });

  it('clears the reason when the download starts and when it succeeds', async () => {
    const { input, attachmentId } = await ingest('block-clear');
    const accounts = new AccountRepository(pool);
    await accounts.ensureAccount(input.accountId);
    await accounts.bindWorker({ accountId: input.accountId, workerInstanceId: 'block-worker', controlEpoch: 1 });
    await pool.query("UPDATE attachments SET created_at = now() - interval '11 seconds' WHERE attachment_id=$1", [attachmentId]);
    await repository.setAttachmentBlockReason(attachmentId, 'ATTACHMENT_WORKER_UNAVAILABLE');
    const owner = { accountId: input.accountId, chatType: input.chatType, chatId: input.chatId, attachmentId,
      workerInstanceId: 'block-worker', controlEpoch: 1, ownerId: randomUUID() };
    const token = await repository.claimAttachmentDownload(owner);
    expect(token).toEqual(expect.any(String));
    expect(await row(attachmentId)).toMatchObject({ status: 'downloading', error: null });
    expect(await repository.setAttachmentBlockReason(attachmentId, 'ATTACHMENT_WORKER_NOT_READY')).toBe(false);
    expect(await repository.markAttachmentReady({ ...owner, attemptToken: token! },
      { relativePath: 'safe/block', sha256: 'e'.repeat(64), sizeBytes: 1 })).toBe(true);
    expect(await row(attachmentId)).toMatchObject({ status: 'ready', error: null });
  });

  it('projects the reason of a queued row to the state list and hides it for other rows', async () => {
    const queued = await ingest('block-state');
    const failed = await ingest('block-state');
    await repository.setAttachmentBlockReason(queued.attachmentId, 'ATTACHMENT_WORKER_NOT_READY');
    await pool.query("UPDATE attachments SET status='failed', retry_count=1, error='LINE_NATIVE_DOWNLOAD_FAILED' WHERE attachment_id=$1", [failed.attachmentId]);
    const key = { accountId: 'block-state', chatType: queued.input.chatType, chatId: queued.input.chatId };
    const states = await repository.listAttachmentStates(key, [queued.attachmentId, failed.attachmentId]);
    expect(states.find((item) => item.attachmentId === queued.attachmentId)).toMatchObject({ status: 'queued', blockReason: 'ATTACHMENT_WORKER_NOT_READY' });
    expect(states.find((item) => item.attachmentId === failed.attachmentId)).not.toHaveProperty('blockReason');
  });

  it('backfills old External Monitor rows in bounded passes and leaves other rows alone', async () => {
    const accountId = 'block-backfill';
    const external = [await ingest(accountId), await ingest(accountId), await ingest(accountId)];
    const live = await ingest(accountId);
    await markExternal(accountId, external.map((item) => item.input.messageId));
    expect(await repository.backfillExternalAttachmentBlockReasons(2)).toBe(2);
    expect(await repository.backfillExternalAttachmentBlockReasons(2)).toBe(1);
    expect(await repository.backfillExternalAttachmentBlockReasons(2)).toBe(0);
    for (const item of external) expect(await row(item.attachmentId)).toMatchObject({ status: 'queued', error: 'EXTERNAL_SOURCE_DOWNLOAD_UNAVAILABLE', retry_count: 0 });
    expect((await row(live.attachmentId)).error).toBeNull();
  });

  it('keeps the specific reason when a row expires and expires External Monitor rows by message time', async () => {
    const accountId = 'block-expiry';
    const old = new Date(Date.now() - 8 * DAY_MS).toISOString();
    const external = await ingest(accountId, { occurredAt: old });
    const recentExternal = await ingest(accountId);
    const worker = await ingest(accountId);
    const plain = await ingest(accountId);
    const failed = await ingest(accountId);
    await markExternal(accountId, [external.input.messageId, recentExternal.input.messageId]);
    await repository.backfillExternalAttachmentBlockReasons(10);
    await repository.setAttachmentBlockReason(worker.attachmentId, 'ATTACHMENT_WORKER_UNAVAILABLE');
    await pool.query("UPDATE attachments SET created_at = now() - interval '8 days' WHERE attachment_id = ANY($1::uuid[])",
      [[worker.attachmentId, plain.attachmentId, failed.attachmentId]]);
    await pool.query("UPDATE attachments SET status='failed', retry_count=1, error='LINE_NATIVE_DOWNLOAD_FAILED' WHERE attachment_id=$1", [failed.attachmentId]);
    await repository.recoverAttachments(accountId);
    expect(await row(external.attachmentId)).toMatchObject({ status: 'expired', error: 'EXTERNAL_SOURCE_DOWNLOAD_UNAVAILABLE' });
    expect(await row(recentExternal.attachmentId)).toMatchObject({ status: 'queued', error: 'EXTERNAL_SOURCE_DOWNLOAD_UNAVAILABLE' });
    expect(await row(worker.attachmentId)).toMatchObject({ status: 'expired', error: 'ATTACHMENT_WORKER_UNAVAILABLE' });
    expect(await row(plain.attachmentId)).toMatchObject({ status: 'expired', error: 'Attachment retry expired' });
    expect(await row(failed.attachmentId)).toMatchObject({ status: 'expired', error: 'LINE_NATIVE_DOWNLOAD_FAILED' });
  });
});
