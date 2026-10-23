import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Pool } from 'pg';
import type { InboundEnvelope } from '@line-agent/contracts';
import { AccountRepository, ExternalMonitorRepository } from '@line-agent/database';
import { createTestDatabase } from '../../../../../packages/database/src/test-database.js';
import { sanitizeInbound } from './sensitive-message-sanitizer.js';
import { sanitizeRoomControlEnvelope } from './room-control.js';

const database = process.env.TEST_DATABASE_URL ? describe : describe.skip;

/** The live path stores what line-service hands to ingest: room-control then verification-code sanitizing. */
function liveStored(envelope: InboundEnvelope) {
  const safe = sanitizeInbound(sanitizeRoomControlEnvelope(envelope), { ownMid: 'u-self' }).envelope;
  return { kind: safe.kind, text: safe.text, mentionRanges: safe.mentionRanges };
}

database('live and native writers store the same message text', () => {
  let pool: Pool;
  let close: () => Promise<void>;
  let repository: ExternalMonitorRepository;
  let source: { sourceId: string; generation: number; modeRevision: number };
  let checkpoint: Record<string, unknown> | null = null;
  const accountId = 'parity-account';

  beforeAll(async () => {
    ({ pool, close } = await createTestDatabase());
    repository = new ExternalMonitorRepository(pool);
    const accounts = new AccountRepository(pool);
    await accounts.ensureAccount(accountId);
    await accounts.setOwnMid(accountId, 'parity-mid');
    await accounts.ensureAccount('parity-agent');
    await accounts.setOwnMid('parity-agent', 'parity-agent-mid');
    await pool.query("UPDATE line_accounts SET product_role='AGENT' WHERE account_id='parity-agent'");
    await pool.query("UPDATE line_accounts SET product_role='PRIMARY_ADMIN' WHERE account_id=$1", [accountId]);
    await pool.query(`INSERT INTO account_administrators(account_id,chat_type,chat_id,user_id,role)
      VALUES ('parity-agent','direct','parity-admin-chat','parity-mid','PRIMARY_ADMIN')`);
    source = await repository.bindVerifiedExternalSource({ accountId, ownMid: 'parity-mid', sourceIdentity: 'parity-source' });
  });
  afterAll(async () => { await close?.(); });

  const cases: Array<{ name: string; kind: InboundEnvelope['kind']; text: string | null; ranges: Array<{ start: number; end: number; userId: string }> }> = [
    { name: 'plain text', kind: 'text', text: 'hello world', ranges: [] },
    { name: 'verification code between words', kind: 'text', text: 'please use LW-ABCDEFGH now', ranges: [] },
    { name: 'room token', kind: 'text', text: 'join RA-a1b2_c3-d4 today', ranges: [] },
    { name: 'both secrets with mentions on each side', kind: 'text',
      text: '@Bob LW-ABCDEFGH then RA-tok-1 @Cy', ranges: [{ start: 0, end: 4, userId: 'bob' }, { start: 30, end: 34, userId: 'cy' }] },
    { name: 'mention overlapping a secret', kind: 'text', text: 'LW-ABCDEFGH hi', ranges: [{ start: 3, end: 8, userId: 'x' }] },
    { name: 'image caption-less message', kind: 'image', text: '', ranges: [] },
    { name: 'sticker with text payload', kind: 'sticker', text: '(sticker)', ranges: [] },
    { name: 'contact share', kind: 'contact', text: 'Shared Friend', ranges: [] },
    { name: 'file message', kind: 'file', text: 'report.pdf', ranges: [] },
  ];

  it.each(cases)('$name', async ({ name, kind, text, ranges }) => {
    const id = `parity-${name.replaceAll(' ', '-')}`;
    const envelope: InboundEnvelope = {
      eventId: `event-${id}`, accountId, chatId: 'parity-chat', chatType: 'group', senderId: 'u-friend', messageId: id, kind, text,
      mentionIds: ranges.map((range) => range.userId), mentionRanges: ranges, replyToMessageId: null,
      ingestion: { source: 'history', cursor: null }, occurredAt: '2026-10-20T00:00:00.000Z', attachments: [], raw: {},
      ...(kind === 'contact' ? { contact: { mid: `u${'a'.repeat(32)}`, displayName: 'Shared Friend' } } : {}),
    };
    const live = liveStored(envelope);
    const next = { accountId, sourceId: source.sourceId, generation: source.generation, expectedModeRevision: source.modeRevision,
      expectedCheckpoint: checkpoint, batchId: `batch-${id}`, cursor: { rowid: id }, observations: [{
        observationId: id, canonicalMessageId: id, nativeMessageId: id, chatType: 'group' as const, chatId: 'parity-chat',
        senderId: 'u-friend', kind, text, mentionRanges: ranges, occurredAt: '2026-10-20T00:00:00.000Z' }] };
    await repository.stageAndProjectBatch(next);
    checkpoint = next.cursor;
    const stored = (await pool.query<{ kind: string; text_content: string | null; mention_ranges: unknown }>(
      'SELECT kind,text_content,mention_ranges FROM messages WHERE account_id=$1 AND message_id=$2', [accountId, id])).rows[0]!;
    expect(stored).toEqual({ kind: live.kind, text_content: live.text, mention_ranges: live.mentionRanges });
    for (const secret of ['LW-ABCDEFGH', 'RA-a1b2_c3-d4', 'RA-tok-1']) expect(stored.text_content ?? '').not.toContain(secret);
  });

  it('redacts attachment name and mime type identically in both writers', async () => {
    const id = 'parity-attachment-file';
    const attachment = { id: 'parity-att-1', kind: 'file' as const, name: 'LW-ABCDEFGH RA-tok.pdf', mimeType: 'application/RA-x', sizeBytes: 5 };
    const envelope: InboundEnvelope = {
      eventId: `event-${id}`, accountId, chatId: 'parity-chat', chatType: 'group', senderId: 'u-friend', messageId: id, kind: 'file', text: null,
      mentionIds: [], mentionRanges: [], replyToMessageId: null, ingestion: { source: 'history', cursor: null },
      occurredAt: '2026-10-20T00:00:00.000Z', attachments: [attachment], raw: {},
    };
    const live = sanitizeInbound(sanitizeRoomControlEnvelope(envelope), { ownMid: 'u-self' }).envelope.attachments[0]!;
    const next = { accountId, sourceId: source.sourceId, generation: source.generation, expectedModeRevision: source.modeRevision,
      expectedCheckpoint: checkpoint, batchId: `batch-${id}`, cursor: { rowid: id }, observations: [{
        observationId: id, canonicalMessageId: id, nativeMessageId: id, chatType: 'group' as const, chatId: 'parity-chat',
        senderId: 'u-friend', kind: 'file', text: null, occurredAt: '2026-10-20T00:00:00.000Z',
        attachments: [{ id: attachment.id, kind: 'file' as const, name: attachment.name, mimeType: attachment.mimeType, sizeBytes: 5, expiresAt: null }] }] };
    await repository.stageAndProjectBatch(next);
    checkpoint = next.cursor;
    const stored = (await pool.query<{ name: string | null; mime_type: string | null }>(
      'SELECT name,mime_type FROM attachments WHERE account_id=$1 AND message_id=$2', [accountId, id])).rows[0]!;
    expect(stored).toEqual({ name: live.name, mime_type: live.mimeType });
    for (const secret of ['LW-ABCDEFGH', 'RA-tok', 'RA-x']) expect(JSON.stringify(stored)).not.toContain(secret);
  });
});
