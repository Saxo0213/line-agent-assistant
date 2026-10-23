import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import { createTestDatabase } from './test-database.js';
import { AccountRepository } from './account-repository.js';
import { MessageRepository } from './message-repository.js';
import { dpapiEnvelope, plainEnvelope } from './content-bridge/test-support.js';
import { ExternalMonitorRepository, type ExternalObservationBatch } from './external-monitor-repository.js';

const database = process.env.TEST_DATABASE_URL ? describe : describe.skip;

database('external monitor foundation', () => {
  let pool: Pool;
  let close: () => Promise<void>;
  let repository: ExternalMonitorRepository;
  const sourceModeRevisions = new Map<string, number>();

  beforeAll(async () => {
    ({ pool, close } = await createTestDatabase());
    repository = new ExternalMonitorRepository(pool);
  });

  async function createSource(accountId: string, initialImport?: { snapshotDigest: string; schemaVersion: string; highWater: Record<string, unknown> | null; eligibleCount: string | null }) {
    const accounts = new AccountRepository(pool);
    const agentAccountId = 'external-test-agent';
    await accounts.ensureAccount(accountId);
    await accounts.setOwnMid(accountId, `verified-mid-${accountId}`);
    await accounts.ensureAccount(agentAccountId);
    await accounts.setOwnMid(agentAccountId, 'external-test-agent-mid');
    await pool.query("UPDATE line_accounts SET product_role=NULL WHERE product_role='PRIMARY_ADMIN'");
    await pool.query("UPDATE line_accounts SET product_role='AGENT' WHERE account_id=$1", [agentAccountId]);
    await pool.query("UPDATE line_accounts SET product_role='PRIMARY_ADMIN' WHERE account_id=$1", [accountId]);
    await pool.query("DELETE FROM account_administrators WHERE account_id=$1 AND role='PRIMARY_ADMIN'", [agentAccountId]);
    await pool.query(`INSERT INTO account_administrators(account_id,chat_type,chat_id,user_id,role)
      VALUES ($1,'direct','external-admin-chat',$2,'PRIMARY_ADMIN')`, [agentAccountId, `verified-mid-${accountId}`]);
    const binding = await repository.bindVerifiedExternalSource({
      accountId, ownMid: `verified-mid-${accountId}`, sourceIdentity: `official-db-profile-${accountId}`,
      ...(initialImport ? { initialImport } : {}),
    });
    sourceModeRevisions.set(binding.sourceId, binding.modeRevision);
    return binding;
  }

  async function stageBatch(input: Omit<ExternalObservationBatch, 'expectedModeRevision'>, expectedModeRevision?: number) {
    const modeRevision = expectedModeRevision ?? sourceModeRevisions.get(input.sourceId);
    if (modeRevision === undefined) throw new Error('Test source mode revision is missing');
    return repository.stageAndProjectBatch({ ...input, expectedModeRevision: modeRevision });
  }

  afterAll(async () => { await close?.(); });

  it('binds only to the already verified account MID and fences prior source generations', async () => {
    const accountId = 'external-binding';
    const { sourceId, generation } = await createSource(accountId);
    expect(await new AccountRepository(pool).resolveCapabilities(accountId)).toMatchObject({
      connectionMode: 'EXTERNAL_MONITOR', selectedSourceId: sourceId, selectedSourceGeneration: generation, canWriteLine: false,
    });
    await expect(repository.bindVerifiedExternalSource({
      accountId, ownMid: 'another-mid', sourceIdentity: 'official-db-profile-b',
    })).rejects.toThrow('Verified LINE account identity mismatch');

    const next = await repository.bindVerifiedExternalSource({
      accountId, ownMid: `verified-mid-${accountId}`, sourceIdentity: 'official-db-profile-b',
    });
    expect(next.generation).toBe(generation + 1);
    await expect(stageBatch({
      accountId, sourceId, generation, expectedCheckpoint: null, batchId: 'stale', cursor: { rowid: '1' },
      observations: [],
    })).rejects.toThrow('External source generation is stale');
  });

  it('reads the authoritative mode revision and exact persisted predecessor checkpoint for the adapter', async () => {
    const accountId = 'external-batch-fence-read';
    const { sourceId, generation, modeRevision } = await createSource(accountId);
    await expect(repository.readBatchFence({ accountId, sourceId, generation }))
      .resolves.toEqual({ expectedModeRevision: modeRevision, expectedCheckpoint: null });
    await stageBatch({ accountId, sourceId, generation, expectedCheckpoint: null, batchId: 'fence-read-first', cursor: { rowid: '8' }, observations: [] });
    await expect(repository.readBatchFence({ accountId, sourceId, generation }))
      .resolves.toEqual({ expectedModeRevision: modeRevision, expectedCheckpoint: { rowid: '8' } });
    await pool.query("UPDATE line_accounts SET source_transition_state='CANDIDATE_CHECKED' WHERE account_id=$1", [accountId]);
    await expect(repository.readBatchFence({ accountId, sourceId, generation })).rejects.toThrow('External source authority is stale');
  });

  it('commits strict initial pages once and replays a committed page without double-counting', async () => {
    const accountId = 'external-initial-replay';
    const { sourceId, generation, modeRevision } = await createSource(accountId, {
      snapshotDigest: 'a'.repeat(64), schemaVersion: 'line-schema-v1', highWater: { createdTime: '123', id: 'row-1' }, eligibleCount: '1',
    });
    const page = { accountId, sourceId, generation, expectedModeRevision: modeRevision, expectedCheckpoint: {}, batchId: 'first-page',
      cursor: { createdTime: '123', id: 'row-1' }, initialImport: true as const, observations: [{ observationId: 'row-1',
        canonicalMessageId: 'native-row-1', chatType: 'direct' as const, chatId: 'chat', senderId: 'person', kind: 'text',
        text: 'hello', occurredAt: '2026-10-17T00:00:00Z' }] };
    expect(await repository.stageAndProjectBatch(page)).toMatchObject({ projected: 1, conflicts: 0, replayed: false });
    expect(await repository.stageAndProjectBatch(page)).toMatchObject({ projected: 1, conflicts: 0, replayed: true });
    await expect(repository.getInitialImportState({ accountId, sourceId, generation })).resolves.toMatchObject({
      initialImportComplete: false, committedCount: '1', eligibleCount: '1', snapshotDigest: 'a'.repeat(64),
    });
  });

  it('projects external attachments older than seven days as expired and refuses manual claims', async () => {
    const accountId = 'external-attachment-seven-day-cutoff';
    const oldOccurredAt = new Date(Date.now() - 8 * 24 * 60 * 60 * 1_000).toISOString();
    const { sourceId, generation, modeRevision } = await createSource(accountId, {
      snapshotDigest: 'e'.repeat(64), schemaVersion: 'line-schema-v1',
      highWater: { createdTime: String(Date.parse(oldOccurredAt)), id: 'old-native-message' }, eligibleCount: '1',
    });
    await stageBatch({ accountId, sourceId, generation, expectedModeRevision: modeRevision, expectedCheckpoint: {},
      batchId: 'old-native-attachment', cursor: { createdTime: String(Date.parse(oldOccurredAt)), id: 'old-native-message' },
      initialImport: true, observations: [{ observationId: 'old-native-message', canonicalMessageId: 'old-native-message', nativeMessageId: 'old-native-message',
        chatType: 'direct', chatId: 'old-native-chat', senderId: 'native-sender', kind: 'image', text: null,
        occurredAt: oldOccurredAt, nativeContentType: 1,
        attachments: [{ id: 'old-native-message', kind: 'image', name: 'old.png', mimeType: null, sizeBytes: 25, expiresAt: null }] }] });
    const messages = new MessageRepository(pool);
    const attachment = await messages.getAttachmentBySource({ accountId, chatType: 'direct', chatId: 'old-native-chat' },
      'old-native-message', 'old-native-message');
    expect(attachment).toMatchObject({ status: 'expired', externalSource: true, name: 'old.png', sizeBytes: 25 });
    const states = await messages.listAttachmentStates({ accountId, chatType: 'direct', chatId: 'old-native-chat' }, [attachment!.attachmentId]);
    expect(states).toEqual([{ attachmentId: attachment!.attachmentId, messageId: 'old-native-message', kind: 'image',
      name: 'old.png', mimeType: 'application/octet-stream', sizeBytes: 25, status: 'expired', canRetryManually: false }]);
    const control = await new AccountRepository(pool).getControlState();
    await new AccountRepository(pool).bindWorker({ accountId, workerInstanceId: 'old-source-worker', controlEpoch: control.controlEpoch });
    expect(await messages.claimAttachmentDownload({ accountId, chatType: 'direct', chatId: 'old-native-chat',
      attachmentId: attachment!.attachmentId, workerInstanceId: 'old-source-worker', controlEpoch: control.controlEpoch,
      ownerId: randomUUID() }, { manual: true, expected: attachment! })).toBeNull();
    const retained = await pool.query('SELECT status,name,size_bytes FROM attachments WHERE attachment_id=$1', [attachment!.attachmentId]);
    expect(retained.rows[0]).toEqual({ status: 'queued', name: 'old.png', size_bytes: '25' });
  });

  it('allows explicit retry of a recent external attachment after its first failed attempt', async () => {
    const accountId = 'external-attachment-first-failure-retry';
    const occurredAt = new Date(Date.now() - 60 * 60 * 1_000).toISOString();
    const { sourceId, generation, modeRevision } = await createSource(accountId, {
      snapshotDigest: 'f'.repeat(64), schemaVersion: 'line-schema-v1',
      highWater: { createdTime: String(Date.parse(occurredAt)), id: 'retry-native-message' }, eligibleCount: '1',
    });
    await stageBatch({ accountId, sourceId, generation, expectedModeRevision: modeRevision, expectedCheckpoint: {},
      batchId: 'recent-native-attachment-retry', cursor: { createdTime: String(Date.parse(occurredAt)), id: 'retry-native-message' },
      initialImport: true, observations: [{ observationId: 'retry-native-message', canonicalMessageId: 'retry-native-message', nativeMessageId: 'retry-native-message',
        chatType: 'direct', chatId: 'retry-native-chat', senderId: 'native-sender', kind: 'image', text: null,
        occurredAt, nativeContentType: 1,
        attachments: [{ id: 'retry-native-message', kind: 'image', name: 'retry.png', mimeType: null, sizeBytes: 25, expiresAt: null }] }] });
    const messages = new MessageRepository(pool);
    const attachment = await messages.getAttachmentBySource({ accountId, chatType: 'direct', chatId: 'retry-native-chat' },
      'retry-native-message', 'retry-native-message');
    await pool.query("UPDATE attachments SET status='failed',retry_count=1,retry_after=now()+interval '60 seconds' WHERE attachment_id=$1",
      [attachment!.attachmentId]);
    const control = await new AccountRepository(pool).getControlState();
    await new AccountRepository(pool).bindWorker({ accountId, workerInstanceId: 'retry-source-worker', controlEpoch: control.controlEpoch });
    await pool.query("UPDATE line_accounts SET status='connected' WHERE account_id=$1", [accountId]);
    const failed = await messages.getAttachment(attachment!.attachmentId);
    expect(failed).toMatchObject({ status: 'failed', retryCount: 1, externalSource: true });
    await expect(messages.listAttachmentStates({ accountId, chatType: 'direct', chatId: 'retry-native-chat' }, [attachment!.attachmentId]))
      .resolves.toMatchObject([{ status: 'failed', canRetryManually: true }]);
    const attemptToken = await messages.claimAttachmentDownload({ accountId, chatType: 'direct', chatId: 'retry-native-chat',
      attachmentId: attachment!.attachmentId, workerInstanceId: 'retry-source-worker', controlEpoch: control.controlEpoch,
      ownerId: randomUUID() }, { manual: true, expected: failed! });
    expect(attemptToken).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('bridges plain native envelopes at write time and replaces a dpapi envelope with the same digest', async () => {
    const accountId = 'external-bridge-plain';
    const { sourceId, generation, modeRevision } = await createSource(accountId, {
      snapshotDigest: 'e'.repeat(64), schemaVersion: 'line-schema-v1', highWater: { createdTime: '300', id: 'bridge-dpapi' }, eligibleCount: '3',
    });
    const base = { chatType: 'direct' as const, chatId: 'bridge-chat', senderId: 'bridge-sender', occurredAt: '2026-10-20T00:00:00Z' };
    const contact = { ...base, observationId: 'official-line-db:bridge-contact', canonicalMessageId: 'bridge-contact', nativeMessageId: 'bridge-contact',
      kind: 'contact', text: null, nativeContentType: 13, nativePayload: plainEnvelope({ _id: 'bridge-contact', _contentType: 13,
        _contentMetadata: JSON.stringify({ mid: 'u-bridge', displayName: 'Bridge Friend' }), _messageRelationType: 3, _relatedMessageId: 'bridge-parent' }) };
    const location = { ...base, observationId: 'official-line-db:bridge-location', canonicalMessageId: 'bridge-location', nativeMessageId: 'bridge-location',
      kind: 'event', text: 'Bridge cafe', nativeContentType: 15, nativePayload: plainEnvelope({ _id: 'bridge-location', _contentType: 15, _text: 'Bridge cafe' }) };
    const legacyDigest = 'f'.repeat(64);
    const legacy = { ...base, observationId: 'official-line-db:bridge-dpapi', canonicalMessageId: 'bridge-dpapi', nativeMessageId: 'bridge-dpapi',
      kind: 'event', text: 'ring', nativeContentType: 6, nativePayload: dpapiEnvelope(legacyDigest) };
    await repository.stageAndProjectBatch({ accountId, sourceId, generation, expectedModeRevision: modeRevision, expectedCheckpoint: {},
      batchId: 'bridge-initial', cursor: { createdTime: '300', id: 'bridge-dpapi' }, initialImport: true,
      observations: [contact, location, legacy] as unknown as ExternalObservationBatch['observations'] });
    const read = async (id: string) => (await pool.query<{ kind: string; content: unknown; content_rule_version: number; reply_to_message_id: string | null; native: unknown }>(
      "SELECT kind,content,content_rule_version,reply_to_message_id,raw->'native' AS native FROM messages WHERE account_id=$1 AND message_id=$2", [accountId, id])).rows[0];

    // C1 (native): content, rule version, kind and reply id come from the bridge in the insert transaction.
    expect(await read('bridge-contact')).toMatchObject({ kind: 'contact', content_rule_version: 1, reply_to_message_id: 'bridge-parent',
      content: { format: 1, type: 'contact', mid: 'u-bridge', displayName: 'Bridge Friend' }, native: contact.nativePayload });
    expect(await read('bridge-location')).toMatchObject({ kind: 'location', content_rule_version: 1,
      content: { type: 'location', title: 'Bridge cafe', latitude: null } });
    // C7: a dpapi envelope is accepted and skipped by the bridge.
    expect(await read('bridge-dpapi')).toMatchObject({ kind: 'event', content: null, content_rule_version: 0, native: legacy.nativePayload });

    // C7: the same row's plain envelope replaces the dpapi one although sourceDigest is equal.
    const checkpoint = { createdTime: '300', id: 'bridge-dpapi' };
    const plainLegacy = { ...legacy, nativePayload: { ...plainEnvelope({ _id: 'bridge-dpapi', _contentType: 6, _text: 'ring' }), sourceDigest: legacyDigest } };
    const replaced = await repository.commitDirectPoll({ accountId, sourceId, generation, expectedModeRevision: modeRevision,
      expectedCheckpoint: checkpoint, batchId: 'bridge-backfill', cursor: checkpoint, forwardObservations: [],
      tailObservations: [plainLegacy as unknown as ExternalObservationBatch['observations'][number]] });
    expect(replaced.changedMessages).toEqual([{ chatType: 'direct', chatId: 'bridge-chat', messageId: 'bridge-dpapi' }]);
    expect(await read('bridge-dpapi')).toMatchObject({ kind: 'event', content_rule_version: 1, native: plainLegacy.nativePayload,
      content: { type: 'event', nativeContentType: 6, text: 'ring' } });

    // An unchanged plain digest stays a no-op (Layer 1 is write-once per source row).
    const noop = await repository.commitDirectPoll({ accountId, sourceId, generation, expectedModeRevision: modeRevision,
      expectedCheckpoint: checkpoint, batchId: 'bridge-replay', cursor: checkpoint, forwardObservations: [],
      tailObservations: [plainLegacy as unknown as ExternalObservationBatch['observations'][number]] });
    expect(noop.changedMessages).toEqual([]);
    // A dpapi envelope arriving after a plain one never downgrades it.
    const downgrade = await repository.commitDirectPoll({ accountId, sourceId, generation, expectedModeRevision: modeRevision,
      expectedCheckpoint: checkpoint, batchId: 'bridge-no-downgrade', cursor: checkpoint, forwardObservations: [],
      tailObservations: [legacy as unknown as ExternalObservationBatch['observations'][number]] });
    expect(downgrade.changedMessages).toEqual([]);
    expect((await read('bridge-dpapi'))?.native).toEqual(plainLegacy.nativePayload);
  });

  it('updates projected content when the same official row becomes unsent', async () => {
    const accountId = 'external-projected-unsent-update';
    const occurredAt = '2026-10-21T00:00:00Z';
    const { sourceId, generation, modeRevision } = await createSource(accountId, {
      snapshotDigest: 'a'.repeat(64), schemaVersion: 'line-schema-v1', highWater: { id: 'unsent-file' }, eligibleCount: '1',
    });
    const base = { observationId: 'official-line-db:unsent-file', canonicalMessageId: 'unsent-file', nativeMessageId: 'unsent-file',
      chatType: 'direct' as const, chatId: 'unsent-chat', senderId: 'unsent-sender', kind: 'file', text: null,
      occurredAt, nativeContentType: 3 };
    const original = { ...base, nativePayload: plainEnvelope({ _id: 'unsent-file', _contentType: 3, _text: '' }) };
    await repository.stageAndProjectBatch({ accountId, sourceId, generation, expectedModeRevision: modeRevision, expectedCheckpoint: {},
      batchId: 'unsent-initial', cursor: { id: 'unsent-file' }, initialImport: true, observations: [original] as unknown as ExternalObservationBatch['observations'] });
    await expect(pool.query<{ content: unknown }>('SELECT content FROM messages WHERE account_id=$1 AND message_id=$2', [accountId, 'unsent-file']))
      .resolves.toMatchObject({ rows: [{ content: { type: 'media' } }] });
    const changed = { ...base, nativePayload: { ...plainEnvelope({ _id: 'unsent-file', _contentType: 3, _text: '',
      _contentMetadata: JSON.stringify({ UNSENT: true }) }), sourceDigest: 'b'.repeat(64) } };
    await repository.commitDirectPoll({ accountId, sourceId, generation, expectedModeRevision: modeRevision,
      expectedCheckpoint: { id: 'unsent-file' }, batchId: 'unsent-refresh', cursor: { id: 'unsent-file' }, forwardObservations: [],
      tailObservations: [changed as unknown as ExternalObservationBatch['observations'][number]] });
    await expect(pool.query<{ content: unknown }>('SELECT content FROM messages WHERE account_id=$1 AND message_id=$2', [accountId, 'unsent-file']))
      .resolves.toMatchObject({ rows: [{ content: { format: 1, type: 'unsent' } }] });
  });

  it('keeps the original text when a text message is later observed as unsent', async () => {
    const accountId = 'external-unsent-keep-text';
    const { sourceId, generation, modeRevision } = await createSource(accountId, {
      snapshotDigest: 'a'.repeat(64), schemaVersion: 'line-schema-v1', highWater: { id: 'unsent-text' }, eligibleCount: '2',
    });
    const base = { chatType: 'direct' as const, chatId: 'unsent-text-chat', senderId: 'unsent-sender', kind: 'text',
      occurredAt: '2026-10-22T00:00:00Z', nativeContentType: 0 };
    const keptBase = { ...base, observationId: 'official-line-db:unsent-text', canonicalMessageId: 'unsent-text', nativeMessageId: 'unsent-text' };
    const original = { ...keptBase, text: 'original words', nativePayload: plainEnvelope({ _id: 'unsent-text', _contentType: 0, _text: 'original words' }) };
    await repository.stageAndProjectBatch({ accountId, sourceId, generation, expectedModeRevision: modeRevision, expectedCheckpoint: {},
      batchId: 'unsent-text-initial', cursor: { id: 'unsent-text' }, initialImport: true, observations: [original] as unknown as ExternalObservationBatch[observations] });
    const recalled = { ...keptBase, text: null, nativePayload: { ...plainEnvelope({ _id: 'unsent-text', _contentType: 0, _text: '',
      _contentMetadata: JSON.stringify({ UNSENT: true }) }), sourceDigest: 'b'.repeat(64) } };
    await repository.commitDirectPoll({ accountId, sourceId, generation, expectedModeRevision: modeRevision,
      expectedCheckpoint: { id: 'unsent-text' }, batchId: 'unsent-text-refresh', cursor: { id: 'unsent-text' }, forwardObservations: [],
      tailObservations: [recalled as unknown as ExternalObservationBatch[observations][number]] });
    const read = (id: string) => pool.query<{ content: { type: string }; text_content: string | null }>(
      'SELECT content,text_content FROM messages WHERE account_id=$1 AND message_id=$2', [accountId, id]);
    await expect(read('unsent-text')).resolves.toMatchObject({ rows: [{ content: { type: 'unsent' }, text_content: 'original words' }] });
    // First seen already recalled: nothing original exists to keep.
    const lateBase = { ...base, observationId: 'official-line-db:unsent-late', canonicalMessageId: 'unsent-late', nativeMessageId: 'unsent-late', text: null,
      nativePayload: plainEnvelope({ _id: 'unsent-late', _contentType: 0, _text: '', _contentMetadata: JSON.stringify({ UNSENT: true }) }) };
    await repository.commitDirectPoll({ accountId, sourceId, generation, expectedModeRevision: modeRevision,
      expectedCheckpoint: { id: 'unsent-text' }, batchId: 'unsent-late-first', cursor: { id: 'unsent-late' }, forwardObservations: [],
      tailObservations: [lateBase as unknown as ExternalObservationBatch[observations][number]] });
    const late = await read('unsent-late');
    expect(late.rows[0]?.content.type).toBe('unsent');
    expect(late.rows[0]?.text_content ?? '').toBe('');
  });

  it('mirrors LINE unread counts atomically, writes only changed rows, and never touches other accounts', async () => {
    const accountId = 'external-unread-mirror';
    const otherId = 'external-unread-other';
    const { sourceId, generation, modeRevision } = await createSource(accountId);
    await new AccountRepository(pool).ensureAccount(otherId);
    for (const [owner, type, chat, unread] of [[accountId, 'direct', 'u-a', 7], [accountId, 'group', 'u-b', 5], [accountId, 'group', 'u-c', 0],
      [accountId, 'group', 'u-d', 2], [otherId, 'direct', 'u-a', 9]] as const) {
      await pool.query(`INSERT INTO conversations(account_id,chat_type,chat_id,title,unread_count) VALUES ($1,$2,$3,'',$4)`, [owner, type, chat, unread]);
    }
    const unreadOf = async (owner: string) => Object.fromEntries((await pool.query<{ chat_id: string; unread_count: number }>(
      "SELECT chat_id,unread_count FROM conversations WHERE account_id=$1 AND chat_id LIKE 'u-%' ORDER BY chat_id", [owner])).rows.map((row) => [row.chat_id, row.unread_count]));
    const poll = (batchId: string, unreadCounts?: { entries: [string, number][] }) => repository.commitDirectPoll({
      accountId, sourceId, generation, expectedModeRevision: modeRevision, expectedCheckpoint: null, batchId, cursor: {},
      forwardObservations: [], tailObservations: [], ...(unreadCounts === undefined ? {} : { unreadCounts }) });

    // Absent unreadCounts changes nothing.
    expect(await poll('unread-absent')).toMatchObject({ unreadChanged: 0 });
    expect(await unreadOf(accountId)).toEqual({ 'u-a': 7, 'u-b': 5, 'u-c': 0, 'u-d': 2 });

    // Listed chats take LINE's count, unlisted ones become 0, unknown chats are ignored, other accounts are untouched.
    const entries: [string, number][] = [['u-a', 3], ['u-c', 12], ['no-such-chat', 4]];
    expect(await poll('unread-apply', { entries })).toMatchObject({ unreadChanged: 4, replayed: false });
    expect(await unreadOf(accountId)).toEqual({ 'u-a': 3, 'u-b': 0, 'u-c': 12, 'u-d': 0 });
    expect(await unreadOf(otherId)).toEqual({ 'u-a': 9 });

    // An unchanged value is not rewritten, and replaying a committed batch is idempotent.
    expect(await poll('unread-same', { entries })).toMatchObject({ unreadChanged: 0 });
    expect(await poll('unread-apply', { entries })).toMatchObject({ unreadChanged: 0, replayed: true });
    expect(await unreadOf(accountId)).toEqual({ 'u-a': 3, 'u-b': 0, 'u-c': 12, 'u-d': 0 });

    // An empty list clears everything for this account only.
    expect(await poll('unread-clear', { entries: [] })).toMatchObject({ unreadChanged: 2 });
    expect(await unreadOf(accountId)).toEqual({ 'u-a': 0, 'u-b': 0, 'u-c': 0, 'u-d': 0 });
    expect(await unreadOf(otherId)).toEqual({ 'u-a': 9 });

    for (const [index, bad] of [
      { entries: [['u-a', 1], ['u-a', 2]] }, { entries: [['u-a', 0]] }, { entries: [['u-a', 1_000_001]] }, { entries: [['u-a', 1.5]] },
      { entries: [['', 1]] }, { entries: [['x'.repeat(513), 1]] }, { entries: Array.from({ length: 2001 }, (_, i) => [`c-${i}`, 1]) },
    ].entries()) {
      await expect(poll(`unread-bad-${index}`, bad as unknown as { entries: [string, number][] })).rejects.toThrow('Invalid external unread counts');
    }
    expect(await unreadOf(accountId)).toEqual({ 'u-a': 0, 'u-b': 0, 'u-c': 0, 'u-d': 0 });
  });

  it('stores protected native message envelopes and safe sticker metadata, and refreshes source-only changes', async () => {
    const accountId = 'external-native-source-message';
    const { sourceId, generation, modeRevision } = await createSource(accountId, {
      snapshotDigest: 'c'.repeat(64), schemaVersion: 'line-schema-v1', highWater: { createdTime: '123', id: 'native-source-message' }, eligibleCount: '1',
    });
    const nativePayload = { format: 1 as const, table: '_message' as const, sourceDigest: '1'.repeat(64), encoding: 'dpapi' as const, data: 'AAAA' };
    const observation = { observationId: 'official-line-db:native-source-message', canonicalMessageId: 'native-source-message',
      nativeMessageId: 'native-source-message', chatType: 'direct' as const, chatId: 'native-chat', senderId: 'native-sender',
      kind: 'sticker', text: null, occurredAt: '2026-10-17T00:00:00Z', nativeContentType: 7,
      nativePayload, nativeStickerMetadata: { STKID: '123456', STKPKGID: '456789', STKVER: '12', STKTXT: ' safe sticker ', STKOPT: 'A' },
      attachments: [{ id: 'native-source-message', kind: 'image' as const, name: 'native.png', mimeType: null, sizeBytes: 25, expiresAt: null }] };
    const first = await repository.stageAndProjectBatch({ accountId, sourceId, generation, expectedModeRevision: modeRevision, expectedCheckpoint: {},
      batchId: 'native-source-initial', cursor: { createdTime: '123', id: 'native-source-message' }, initialImport: true,
      observations: [observation as unknown as ExternalObservationBatch['observations'][number]] });
    expect(first.changedMessages).toEqual([{ chatType: 'direct', chatId: 'native-chat', messageId: 'native-source-message' }]);
    const normalizedFields = await pool.query<{ content: unknown; reply_to_message_id: string | null }>(
      'SELECT content,reply_to_message_id FROM messages WHERE account_id=$1 AND message_id=$2', [accountId, 'native-source-message']);
    // A dpapi envelope cannot be read by the bridge: the projection stays empty.
    expect(normalizedFields.rows[0]).toEqual({ content: null, reply_to_message_id: null });
    const inserted = await pool.query<{ raw: Record<string, unknown> }>(
      'SELECT raw FROM messages WHERE account_id=$1 AND message_id=$2', [accountId, 'native-source-message']);
    expect(inserted.rows[0]?.raw).toEqual({ message: { id: 'native-source-message', from: 'native-sender', contentType: 7,
      createdTime: new Date('2026-10-17T00:00:00.000Z').getTime(), text: null, contentMetadata: { STKID: '123456', STKPKGID: '456789', STKVER: '12', STKTXT: 'safe sticker', STKOPT: 'A' } }, native: nativePayload });
    const attachment = await pool.query<{ status: string; name: string; mime_type: string | null; size_bytes: string | null }>(
      'SELECT status,name,mime_type,size_bytes FROM attachments WHERE account_id=$1 AND message_id=$2', [accountId, 'native-source-message']);
    expect(attachment.rows).toEqual([{ status: 'queued', name: 'native.png', mime_type: null, size_bytes: '25' }]);
    await pool.query("UPDATE attachments SET status='ready',relative_path='native/hash/native.png',sha256=$3 WHERE account_id=$1 AND message_id=$2",
      [accountId, 'native-source-message', 'd'.repeat(64)]);

    const rotatedCiphertext = { ...nativePayload, data: 'BBBB' };
    const sparseAttachment = { ...observation, attachments: [{ id: 'native-source-message', kind: 'image' as const,
      name: null, mimeType: null, sizeBytes: null, expiresAt: null }] };
    const noop = await repository.commitDirectPoll({ accountId, sourceId, generation, expectedModeRevision: modeRevision,
      expectedCheckpoint: { createdTime: '123', id: 'native-source-message' }, batchId: 'native-source-cipher-rotation',
      cursor: { createdTime: '123', id: 'native-source-message' }, forwardObservations: [],
      tailObservations: [{ ...sparseAttachment, nativePayload: rotatedCiphertext } as unknown as ExternalObservationBatch['observations'][number]] });
    expect(noop).toMatchObject({ tailRepaired: 0, changedMessages: [] });
    expect((await pool.query("SELECT status,name,size_bytes,relative_path FROM attachments WHERE account_id=$1 AND message_id=$2",
      [accountId, 'native-source-message'])).rows[0]).toEqual({ status: 'ready', name: 'native.png', size_bytes: '25', relative_path: 'native/hash/native.png' });
    expect((await pool.query('SELECT raw->\'native\' AS native FROM messages WHERE account_id=$1 AND message_id=$2',
      [accountId, 'native-source-message'])).rows[0]?.native).toEqual(nativePayload);

    const updatedPayload = { ...rotatedCiphertext, sourceDigest: '2'.repeat(64) };
    const refreshed = await repository.commitDirectPoll({ accountId, sourceId, generation, expectedModeRevision: modeRevision,
      expectedCheckpoint: { createdTime: '123', id: 'native-source-message' }, batchId: 'native-source-data-refresh',
      cursor: { createdTime: '123', id: 'native-source-message' }, forwardObservations: [],
      tailObservations: [{ ...observation, nativePayload: updatedPayload } as unknown as ExternalObservationBatch['observations'][number]] });
    expect(refreshed.changedMessages).toEqual([{ chatType: 'direct', chatId: 'native-chat', messageId: 'native-source-message' }]);
    expect((await pool.query('SELECT raw->\'native\' AS native FROM messages WHERE account_id=$1 AND message_id=$2',
      [accountId, 'native-source-message'])).rows[0]?.native).toEqual(updatedPayload);

    const legacyObservation = { ...observation, nativePayload: undefined, nativeStickerMetadata: undefined };
    const legacyReplay = await repository.commitDirectPoll({ accountId, sourceId, generation, expectedModeRevision: modeRevision,
      expectedCheckpoint: { createdTime: '123', id: 'native-source-message' }, batchId: 'native-source-legacy-omission',
      cursor: { createdTime: '123', id: 'native-source-message' }, forwardObservations: [],
      tailObservations: [legacyObservation as unknown as ExternalObservationBatch['observations'][number]] });
    expect(legacyReplay.changedMessages).toEqual([]);
    expect((await pool.query('SELECT raw FROM messages WHERE account_id=$1 AND message_id=$2',
      [accountId, 'native-source-message'])).rows[0]?.raw).toMatchObject({ native: updatedPayload,
      message: { contentMetadata: { STKID: '123456', STKPKGID: '456789', STKVER: '12', STKTXT: 'safe sticker', STKOPT: 'A' } } });

    const changedIdentity = { ...observation, observationId: 'native-source-sticker-identity-change',
      nativeStickerMetadata: { STKID: '654321' } };
    await repository.commitDirectPoll({ accountId, sourceId, generation, expectedModeRevision: modeRevision,
      expectedCheckpoint: { createdTime: '123', id: 'native-source-message' }, batchId: 'native-source-sticker-identity-change',
      cursor: { createdTime: '123', id: 'native-source-message' }, forwardObservations: [],
      tailObservations: [changedIdentity as unknown as ExternalObservationBatch['observations'][number]] });
    const changedRaw = await pool.query<{ raw: Record<string, unknown> }>(
      'SELECT raw FROM messages WHERE account_id=$1 AND message_id=$2', [accountId, 'native-source-message']);
    expect((changedRaw.rows[0]?.raw.message as Record<string, unknown>).contentMetadata).toEqual({ STKID: '654321' });

    const invalidObservation: unknown = { ...observation, observationId: 'invalid-source', nativePayload: { ...nativePayload, table: '_chat' } };
    await expect(repository.commitDirectPoll({ accountId, sourceId, generation, expectedModeRevision: modeRevision,
      expectedCheckpoint: { createdTime: '123', id: 'native-source-message' }, batchId: 'native-source-invalid-envelope',
      cursor: { createdTime: '124', id: 'native-source-message' }, forwardObservations: [],
      tailObservations: [invalidObservation as ExternalObservationBatch['observations'][number]] }))
      .rejects.toThrow('Invalid external native message payload table');

    const invalidStickerObservation: unknown = { ...observation, observationId: 'native-source-invalid-sticker',
      canonicalMessageId: 'native-source-invalid-sticker', nativeMessageId: 'native-source-invalid-sticker', kind: 'text', text: 'private LW-ABCDEFGH',
      nativePayload: { ...nativePayload, sourceDigest: '4'.repeat(64) }, nativeStickerMetadata: { STKID: 'not-a-sticker-id' } };
    await repository.commitDirectPoll({ accountId, sourceId, generation, expectedModeRevision: modeRevision,
      expectedCheckpoint: { createdTime: '123', id: 'native-source-message' }, batchId: 'native-source-redacted-text',
      cursor: { createdTime: '124', id: 'native-source-message' }, forwardObservations: [
        invalidStickerObservation as ExternalObservationBatch['observations'][number],
      ], tailObservations: [] });
    const redacted = await pool.query<{ text_content: string | null; raw: Record<string, unknown> }>(
      'SELECT text_content,raw FROM messages WHERE account_id=$1 AND message_id=$2', [accountId, 'native-source-invalid-sticker']);
    expect(redacted.rows[0]?.text_content).toBe('private [REDACTED_VERIFICATION_CODE]');
    expect(redacted.rows[0]?.raw).toMatchObject({ message: { text: 'private [REDACTED_VERIFICATION_CODE]' },
      native: { sourceDigest: '4'.repeat(64) } });
    expect((redacted.rows[0]?.raw.message as Record<string, unknown>).contentMetadata).toBeUndefined();
  });

  it('stores catalog source rows by scoped key, idempotently retains equal source data, and fences checkpoint changes', async () => {
    const accountId = 'external-native-source-catalog';
    const snapshotDigest = 'd'.repeat(64);
    const { sourceId, generation, modeRevision } = await createSource(accountId, {
      snapshotDigest, schemaVersion: 'line-schema-v1', highWater: null, eligibleCount: '0',
    });
    const records = [{ tableName: '_squareMember' as const, recordKey: 'pk:["square","member"]',
      nativePayload: { format: 1 as const, table: '_squareMember' as const, sourceDigest: '3'.repeat(64), encoding: 'dpapi' as const, data: 'CCCC' } }];
    const result = await (repository as unknown as { storeNativeCatalogPage(input: unknown): Promise<unknown> }).storeNativeCatalogPage({
      accountId, sourceId, generation, expectedModeRevision: modeRevision, expectedCheckpoint: {}, snapshotDigest,
      batchId: 'catalog:request:1:digest', records: [records[0]!, records[0]!],
    });
    expect(result).toMatchObject({ stored: 1, replayed: false });
    const initial = await pool.query('SELECT account_id,source_digest,native_payload FROM native_source_catalog_records WHERE source_id=$1', [sourceId]);
    expect(initial.rows).toEqual([{ account_id: accountId, source_digest: '3'.repeat(64), native_payload: records[0]?.nativePayload }]);
    await expect((repository as unknown as { storeNativeCatalogPage(input: unknown): Promise<unknown> }).storeNativeCatalogPage({
      accountId, sourceId, generation, expectedModeRevision: modeRevision, expectedCheckpoint: {}, snapshotDigest,
      batchId: 'catalog:request:1:digest', records: [records[0]!, records[0]!],
    })).resolves.toMatchObject({ stored: 1, replayed: true });
    await expect((repository as unknown as { storeNativeCatalogPage(input: unknown): Promise<unknown> }).storeNativeCatalogPage({
      accountId, sourceId, generation, expectedModeRevision: modeRevision, expectedCheckpoint: {}, snapshotDigest,
      batchId: 'catalog:request:1:digest', records: [{ ...records[0]!, nativePayload: { ...records[0]!.nativePayload, data: 'ZZZZ' } }],
    })).rejects.toThrow('External batch replay digest mismatch');

    const changedCiphertext = [{ ...records[0]!, nativePayload: { ...records[0]!.nativePayload, data: 'DDDD' } }];
    await (repository as unknown as { storeNativeCatalogPage(input: unknown): Promise<unknown> }).storeNativeCatalogPage({
      accountId, sourceId, generation, expectedModeRevision: modeRevision, expectedCheckpoint: {}, snapshotDigest,
      batchId: 'catalog:request:2:digest', records: changedCiphertext,
    });
    expect((await pool.query('SELECT native_payload FROM native_source_catalog_records WHERE source_id=$1', [sourceId])).rows[0]?.native_payload)
      .toEqual(records[0]?.nativePayload);

    const plainRecord = { tableName: '_contact' as const, recordKey: 'pk:["contact","plain"]',
      nativePayload: { format: 2 as const, table: '_contact' as const, sourceDigest: '4'.repeat(64), encoding: 'plain' as const,
        row: { columns: ['mid', 'displayName'], cells: ['contact-mid', 'Contact Name'] } } };
    await expect((repository as unknown as { storeNativeCatalogPage(input: unknown): Promise<unknown> }).storeNativeCatalogPage({
      accountId, sourceId, generation, expectedModeRevision: modeRevision, expectedCheckpoint: {}, snapshotDigest,
      batchId: 'catalog:plain-envelope', records: [plainRecord],
    })).resolves.toMatchObject({ stored: 1, changed: 1, replayed: false });
    expect((await pool.query('SELECT native_payload FROM native_source_catalog_records WHERE source_id=$1 AND table_name=$2', [sourceId, '_contact']))
      .rows[0]?.native_payload).toEqual(plainRecord.nativePayload);
    await expect(pool.query(`INSERT INTO native_source_catalog_records(
        account_id,source_id,generation,table_name,record_key,source_digest,native_payload)
      VALUES ($1,$2,$3,'_contact','malformed-plain',$4,$5::jsonb)`,
    [accountId, sourceId, generation, '5'.repeat(64), JSON.stringify({ ...plainRecord.nativePayload,
      sourceDigest: '5'.repeat(64), row: { columns: ['mid'], cells: [] } })])).rejects.toThrow();

    await expect((repository as unknown as { storeNativeCatalogPage(input: unknown): Promise<unknown> }).storeNativeCatalogPage({
      accountId, sourceId, generation, expectedModeRevision: modeRevision, expectedCheckpoint: { changed: true }, snapshotDigest,
      batchId: 'catalog:stale-checkpoint', records,
    })).rejects.toThrow('predecessor checkpoint mismatch');
    await expect((repository as unknown as { storeNativeCatalogPage(input: unknown): Promise<unknown> }).storeNativeCatalogPage({
      accountId, sourceId, generation, expectedModeRevision: modeRevision, expectedCheckpoint: {}, snapshotDigest: 'e'.repeat(64),
      batchId: 'catalog:stale-snapshot', records,
    })).rejects.toThrow('predecessor checkpoint mismatch');
    await expect((repository as unknown as { storeNativeCatalogPage(input: unknown): Promise<unknown> }).storeNativeCatalogPage({
      accountId: 'different-catalog-account', sourceId, generation, expectedModeRevision: modeRevision, expectedCheckpoint: {}, snapshotDigest,
      batchId: 'catalog:cross-account', records,
    })).rejects.toThrow('External source authority is stale');
    await expect((repository as unknown as { storeNativeCatalogPage(input: unknown): Promise<unknown> }).storeNativeCatalogPage({
      accountId, sourceId, generation, expectedModeRevision: modeRevision, expectedCheckpoint: {}, snapshotDigest,
      batchId: 'catalog:empty-page', records: [],
    })).resolves.toMatchObject({ stored: 0, changed: 0, replayed: false });
    await expect(pool.query('SELECT cursor,committed_count FROM external_source_checkpoints WHERE source_id=$1', [sourceId]))
      .resolves.toMatchObject({ rows: [{ cursor: {}, committed_count: '0' }] });
    await expect(pool.query('SELECT count(*) AS count FROM native_source_catalog_records WHERE source_id=$1', [sourceId]))
      .resolves.toMatchObject({ rows: [{ count: '2' }] });
  });

  it('keeps native source digest and ciphertext synchronized through initial, ordinary, forward, and tail replay', async () => {
    const accountId = 'external-native-source-replay-matrix';
    const { sourceId, generation, modeRevision } = await createSource(accountId, {
      snapshotDigest: 'a'.repeat(64), schemaVersion: 'line-schema-v1', highWater: { head: 1 }, eligibleCount: '1',
    });
    const payload = (sourceDigest: string, data: string) => ({ format: 1 as const, table: '_message' as const,
      sourceDigest, encoding: 'dpapi' as const, data });
    const initialPayload = payload('5'.repeat(64), 'AAAA');
    const observation: ExternalObservationBatch['observations'][number] = {
      observationId: 'official-line-db:native-replay-message', canonicalMessageId: 'native-replay-message',
      nativeMessageId: 'native-replay-message', chatType: 'direct', chatId: 'native-replay-chat', senderId: 'native-sender',
      kind: 'text', text: 'source core', occurredAt: '2026-10-17T00:00:00Z', nativePayload: initialPayload,
    };
    const persistedSource = async () => pool.query<{ observation: Record<string, unknown>; raw: Record<string, unknown>; status: string }>(
      `SELECT o.normalized_payload AS observation,m.raw,o.status FROM external_source_observations o
       JOIN messages m ON m.account_id=o.account_id AND m.message_id=o.canonical_message_id
       WHERE o.source_id=$1 AND o.observation_id=$2`, [sourceId, observation.observationId]);
    await repository.stageAndProjectBatch({ accountId, sourceId, generation, expectedModeRevision: modeRevision,
      expectedCheckpoint: {}, batchId: 'native-replay-initial', cursor: { head: 1 }, initialImport: true, observations: [observation] });
    await expect(repository.stageAndProjectBatch({ accountId, sourceId, generation, expectedModeRevision: modeRevision,
      expectedCheckpoint: {}, batchId: 'native-replay-initial', cursor: { head: 1 }, initialImport: true,
      observations: [{ ...observation, nativePayload: payload('a'.repeat(64), 'ZZZZ') }] }))
      .rejects.toThrow('External batch replay digest mismatch');

    const initialRefreshPayload = payload('6'.repeat(64), 'BBBB');
    const initialRefresh = await repository.stageAndProjectBatch({ accountId, sourceId, generation, expectedModeRevision: modeRevision,
      expectedCheckpoint: { head: 1 }, batchId: 'native-replay-initial-refresh', cursor: { head: 1 }, initialImport: true,
      observations: [{ ...observation, nativePayload: initialRefreshPayload }] });
    expect(initialRefresh.changedMessages).toEqual([{ chatType: 'direct', chatId: 'native-replay-chat', messageId: 'native-replay-message' }]);
    await expect(persistedSource()).resolves.toMatchObject({ rows: [{
      observation: { nativePayload: initialRefreshPayload }, raw: { native: initialRefreshPayload },
    }] });

    await pool.query(`UPDATE external_source_observations SET normalized_payload=jsonb_set(
      normalized_payload,'{nativePayload,data}',to_jsonb($3::text),false)
      WHERE source_id=$1 AND observation_id=$2`, [sourceId, observation.observationId, 'GGGG']);
    const rotatedCiphertext = payload('6'.repeat(64), 'CCCC');
    const ordinaryNoop = await repository.stageAndProjectBatch({ accountId, sourceId, generation, expectedModeRevision: modeRevision,
      expectedCheckpoint: { head: 1 }, batchId: 'native-replay-cipher-rotation', cursor: { head: 1 },
      observations: [{ ...observation, nativePayload: rotatedCiphertext }] });
    expect(ordinaryNoop).toMatchObject({ conflicts: 0, changedMessages: [] });
    await expect(persistedSource()).resolves.toMatchObject({ rows: [{
      observation: { nativePayload: initialRefreshPayload }, raw: { native: initialRefreshPayload },
    }] });

    const ordinaryRefreshPayload = payload('7'.repeat(64), 'DDDD');
    const ordinaryRefresh = await repository.stageAndProjectBatch({ accountId, sourceId, generation, expectedModeRevision: modeRevision,
      expectedCheckpoint: { head: 1 }, batchId: 'native-replay-ordinary-refresh', cursor: { head: 1 },
      observations: [{ ...observation, nativePayload: ordinaryRefreshPayload }] });
    expect(ordinaryRefresh).toMatchObject({ conflicts: 0, changedMessages: [{ messageId: 'native-replay-message' }] });
    await expect(persistedSource()).resolves.toMatchObject({ rows: [{
      observation: { nativePayload: ordinaryRefreshPayload }, raw: { native: ordinaryRefreshPayload },
    }] });

    const coreOnly = await repository.stageAndProjectBatch({ accountId, sourceId, generation, expectedModeRevision: modeRevision,
      expectedCheckpoint: { head: 1 }, batchId: 'native-replay-core-only', cursor: { head: 1 },
      observations: [{ ...observation, text: 'updated core', nativePayload: undefined }] });
    expect(coreOnly).toMatchObject({ conflicts: 0, changedMessages: [{ messageId: 'native-replay-message' }] });
    await expect(persistedSource()).resolves.toMatchObject({ rows: [{
      observation: { nativePayload: ordinaryRefreshPayload }, raw: { native: ordinaryRefreshPayload, message: { text: 'updated core' } },
    }] });
    await expect(pool.query('SELECT committed_count FROM external_source_checkpoints WHERE source_id=$1', [sourceId]))
      .resolves.toMatchObject({ rows: [{ committed_count: '1' }] });

    const forwardPayload = payload('8'.repeat(64), 'EEEE');
    const forward = await repository.commitDirectPoll({ accountId, sourceId, generation, expectedModeRevision: modeRevision,
      expectedCheckpoint: { head: 1 }, batchId: 'native-replay-direct-forward', cursor: { head: 2 },
      forwardObservations: [{ ...observation, text: 'updated core', nativePayload: forwardPayload }], tailObservations: [] });
    expect(forward).toMatchObject({ conflicts: 0, changedMessages: [{ messageId: 'native-replay-message' }] });
    await expect(persistedSource()).resolves.toMatchObject({ rows: [{
      observation: { nativePayload: forwardPayload }, raw: { native: forwardPayload },
    }] });

    const tailPayload = payload('9'.repeat(64), 'FFFF');
    const tail = await repository.commitDirectPoll({ accountId, sourceId, generation, expectedModeRevision: modeRevision,
      expectedCheckpoint: { head: 2 }, batchId: 'native-replay-direct-tail', cursor: { head: 2 },
      forwardObservations: [], tailObservations: [{ ...observation, text: 'updated core', nativePayload: tailPayload }] });
    expect(tail).toMatchObject({ tailRepaired: 1, changedMessages: [{ messageId: 'native-replay-message' }] });
    await expect(persistedSource()).resolves.toMatchObject({ rows: [{
      observation: { nativePayload: tailPayload }, raw: { native: tailPayload },
    }] });

    await pool.query(`UPDATE external_source_observations SET normalized_payload=jsonb_set(
      normalized_payload,'{nativePayload,data}',to_jsonb($3::text),false)
      WHERE source_id=$1 AND observation_id=$2`, [sourceId, observation.observationId, 'GGGG']);
    const tailCipherReconcile = await repository.commitDirectPoll({ accountId, sourceId, generation,
      expectedModeRevision: modeRevision, expectedCheckpoint: { head: 2 }, batchId: 'native-replay-tail-cipher-reconcile',
      cursor: { head: 2 }, forwardObservations: [], tailObservations: [{ ...observation, text: 'updated core', nativePayload: tailPayload }] });
    expect(tailCipherReconcile).toMatchObject({ tailRepaired: 1, changedMessages: [] });
    await expect(persistedSource()).resolves.toMatchObject({ rows: [{ status: 'PROJECTED',
      observation: { nativePayload: tailPayload }, raw: { native: tailPayload },
    }] });
    await expect(pool.query(`SELECT count(*) AS count FROM external_source_batches
      WHERE source_id=$1 AND generation=$2 AND batch_id=$3`, [sourceId, generation, 'native-replay-tail-cipher-reconcile']))
      .resolves.toMatchObject({ rows: [{ count: '1' }] });

    const tailNoop = await repository.commitDirectPoll({ accountId, sourceId, generation, expectedModeRevision: modeRevision,
      expectedCheckpoint: { head: 2 }, batchId: 'native-replay-tail-cipher-noop', cursor: { head: 2 },
      forwardObservations: [], tailObservations: [{ ...observation, text: 'updated core', nativePayload: tailPayload }] });
    expect(tailNoop).toMatchObject({ tailRepaired: 0, changedMessages: [] });
  });

  it('rejects native catalog envelopes with missing required fields at the database boundary', async () => {
    const accountId = 'external-native-catalog-shape-check';
    const { sourceId, generation } = await createSource(accountId, {
      snapshotDigest: 'f'.repeat(64), schemaVersion: 'line-schema-v1', highWater: null, eligibleCount: '0',
    });
    const invalidPayloads = [
      {},
      { format: '1', table: '_chat', sourceDigest: 'a'.repeat(64), encoding: 'dpapi', data: 'AAAA' },
      { format: 1, table: '_chat', sourceDigest: 'a'.repeat(64), encoding: 'dpapi', data: 'AAAA', unexpected: true },
      { format: 1, table: '_chat', sourceDigest: 'a'.repeat(64), encoding: 'dpapi', data: 'A' },
    ];
    for (const [index, nativePayload] of invalidPayloads.entries()) {
      await expect(pool.query(`INSERT INTO native_source_catalog_records(
          account_id,source_id,generation,table_name,record_key,source_digest,native_payload)
        VALUES ($1,$2,$3,'_chat',$4,$5,$6::jsonb)`,
      [accountId, sourceId, generation, `pk:["chat",${index}]`, 'a'.repeat(64), JSON.stringify(nativePayload)])).rejects.toThrow();
    }
  });

  it('refreshes a projected community sender nickname without changing canonical message identity', async () => {
    const accountId = 'external-community-sender-name';
    const { sourceId, generation, modeRevision } = await createSource(accountId, {
      snapshotDigest: 'b'.repeat(64), schemaVersion: 'line-schema-v1', highWater: { createdTime: '123', id: 'community-row' }, eligibleCount: '1',
    });
    const observation = { observationId: 'community-row', canonicalMessageId: 'native-community-row', nativeMessageId: 'native-community-row', chatType: 'community' as const,
      chatId: 'community-chat', senderId: 'square-member', senderPicturePath: 'abcdefghijklmnop', nativeConversationKind: 'midType:4',
      nativeConversationId: 'community-chat', nativeMetadata: { midType: 4, parentChatId: null, communityId: 'square-id' },
      kind: 'text', text: 'hello', occurredAt: '2026-10-17T00:00:00Z' };
    const first = await stageBatch({ accountId, sourceId, generation, expectedCheckpoint: {}, batchId: 'community-name-first',
      cursor: { createdTime: '123', id: 'community-row' }, initialImport: true, observations: [observation] }, modeRevision);
    const firstDigest = (await pool.query<{ normalized_digest: string }>(
      'SELECT normalized_digest FROM external_source_observations WHERE source_id=$1 AND observation_id=$2', [sourceId, 'community-row'])).rows[0]?.normalized_digest;
    expect(first.changedMessages).toContainEqual({ chatType: 'community', chatId: 'community-chat', messageId: 'native-community-row' });
    await expect(pool.query('SELECT display_name,picture_path FROM conversation_members WHERE account_id=$1 AND chat_type=$2 AND chat_id=$3 AND member_id=$4',
      [accountId, 'community', 'community-chat', 'square-member'])).resolves.toMatchObject({ rows: [{ display_name: null, picture_path: 'https://obs.line-scdn.net/abcdefghijklmnop' }] });

    const messageBeforePictureRefresh = await pool.query('SELECT text_content,raw,occurred_at FROM messages WHERE account_id=$1 AND message_id=$2',
      [accountId, 'native-community-row']);
    const pictureRefresh = await stageBatch({ accountId, sourceId, generation, expectedCheckpoint: { createdTime: '123', id: 'community-row' },
      batchId: 'community-picture-refresh', cursor: { createdTime: '123', id: 'community-row' }, initialImport: true,
      observations: [{ ...observation, senderPicturePath: 'qrstuvwxyzABCDEF' }] }, modeRevision);
    expect(pictureRefresh).toMatchObject({ projected: 1, conflicts: 0 });
    await expect(pool.query('SELECT text_content,raw,occurred_at FROM messages WHERE account_id=$1 AND message_id=$2',
      [accountId, 'native-community-row'])).resolves.toEqual(messageBeforePictureRefresh);
    await expect(pool.query('SELECT picture_path FROM conversation_members WHERE account_id=$1 AND chat_type=$2 AND chat_id=$3 AND member_id=$4',
      [accountId, 'community', 'community-chat', 'square-member'])).resolves.toMatchObject({ rows: [{ picture_path: 'https://obs.line-scdn.net/qrstuvwxyzABCDEF' }] });

    const refreshed = await stageBatch({ accountId, sourceId, generation, expectedCheckpoint: { createdTime: '123', id: 'community-row' },
      batchId: 'community-name-refresh', cursor: { createdTime: '123', id: 'community-row' }, initialImport: true,
      observations: [{ ...observation, senderName: 'Second Alias', senderPicturePath: 'qrstuvwxyzABCDEF' }] }, modeRevision);
    expect(refreshed).toMatchObject({ projected: 1, conflicts: 0, replayed: false,
      changedMessages: [{ chatType: 'community', chatId: 'community-chat', messageId: 'native-community-row' }] });
    const rows = await pool.query<{ display_name: string; messages: string; normalized_digest: string }>(
      `SELECT cm.display_name,(SELECT count(*) FROM messages m WHERE m.account_id=cm.account_id AND m.chat_type=cm.chat_type AND m.chat_id=cm.chat_id AND m.message_id='native-community-row') AS messages,
        (SELECT normalized_digest FROM external_source_observations WHERE source_id=$1 AND observation_id='community-row') AS normalized_digest
       FROM conversation_members cm WHERE cm.account_id=$2 AND cm.chat_type='community' AND cm.chat_id='community-chat' AND cm.member_id='square-member'`,
      [sourceId, accountId]);
    expect(rows.rows).toEqual([{ display_name: 'Second Alias', messages: '1', normalized_digest: firstDigest }]);

    const noop = await stageBatch({ accountId, sourceId, generation, expectedCheckpoint: { createdTime: '123', id: 'community-row' },
      batchId: 'community-name-noop', cursor: { createdTime: '123', id: 'community-row' }, initialImport: true,
      observations: [{ ...observation, senderName: 'Second Alias', senderPicturePath: 'qrstuvwxyzABCDEF' }] }, modeRevision);
    expect(noop).toMatchObject({ projected: 1, conflicts: 0, replayed: false, changedMessages: [] });
    await expect(stageBatch({ accountId, sourceId, generation, expectedCheckpoint: { createdTime: '123', id: 'community-row' },
      batchId: 'community-name-noop', cursor: { createdTime: '123', id: 'community-row' }, initialImport: true,
      observations: [{ ...observation, senderName: 'Second Alias', senderPicturePath: 'qrstuvwxyzABCDEF' }] }, modeRevision))
      .resolves.toMatchObject({ replayed: true, changedMessages: [] });

    const malformed = await stageBatch({ accountId, sourceId, generation, expectedCheckpoint: { createdTime: '123', id: 'community-row' },
      batchId: 'community-name-malformed', cursor: { createdTime: '123', id: 'community-row' }, initialImport: true,
      observations: [{ ...observation, senderName: 'Second Alias', senderPicturePath: 'https://evil.invalid/avatar' }] }, modeRevision);
    expect(malformed.conflicts).toBe(0);
    await expect(pool.query('SELECT display_name,picture_path FROM conversation_members WHERE account_id=$1 AND chat_type=$2 AND chat_id=$3 AND member_id=$4',
      [accountId, 'community', 'community-chat', 'square-member'])).resolves.toMatchObject({ rows: [{ display_name: 'Second Alias', picture_path: 'https://obs.line-scdn.net/qrstuvwxyzABCDEF' }] });
    await stageBatch({ accountId, sourceId, generation, expectedCheckpoint: { createdTime: '123', id: 'community-row' },
      batchId: 'community-picture-invalid', cursor: { createdTime: '123', id: 'community-row' }, initialImport: true,
      observations: [{ ...observation, senderPicturePath: 'https://evil.invalid/avatar' }] }, modeRevision);
    await expect(pool.query('SELECT picture_path FROM conversation_members WHERE account_id=$1 AND chat_type=$2 AND chat_id=$3 AND member_id=$4',
      [accountId, 'community', 'community-chat', 'square-member'])).resolves.toMatchObject({ rows: [{ picture_path: 'https://obs.line-scdn.net/qrstuvwxyzABCDEF' }] });
  });

  it('batch-upserts scoped community and thread names, refreshes an unchanged tail, and ignores malformed or non-community names', async () => {
    const accountId = 'external-community-name-batch';
    const { sourceId, generation, modeRevision } = await createSource(accountId);
    const threadOne = { observationId: 'thread-name-row-1', canonicalMessageId: 'thread-name-message-1', nativeMessageId: 'thread-name-message-1', chatType: 'thread' as const,
      chatId: 'thread-name-chat', senderId: 'shared-member', senderName: 'Thread Alias', kind: 'text', text: 'one', occurredAt: '2026-10-17T00:00:00Z' };
    const threadTwo = { ...threadOne, observationId: 'thread-name-row-2', canonicalMessageId: 'thread-name-message-2', nativeMessageId: 'thread-name-message-2', text: 'two',
      occurredAt: '2026-10-17T00:00:01Z' };
    const community = { ...threadOne, observationId: 'community-name-row', canonicalMessageId: 'community-name-message', nativeMessageId: 'community-name-message', chatType: 'community' as const,
      chatId: 'community-name-chat', senderName: 'Community Alias' };
    const group = { ...threadOne, observationId: 'group-name-row', canonicalMessageId: 'group-name-message', nativeMessageId: 'group-name-message', chatType: 'group' as const,
      chatId: 'group-name-chat', senderName: 'Group Alias' };
    const first = await repository.commitDirectPoll({ accountId, sourceId, generation, expectedModeRevision: modeRevision,
      expectedCheckpoint: null, batchId: 'community-name-live-first', cursor: { rowid: '4' },
      forwardObservations: [threadOne, threadTwo, community, group], tailObservations: [] });
    expect(first.changedMessages).toHaveLength(4);
    const scopedNames = await pool.query<{ chat_type: string; chat_id: string; display_name: string }>(
      `SELECT chat_type,chat_id,display_name FROM conversation_members WHERE account_id=$1 AND member_id='shared-member' ORDER BY chat_type,chat_id`,
      [accountId]);
    expect(scopedNames.rows).toEqual([
      { chat_type: 'community', chat_id: 'community-name-chat', display_name: 'Community Alias' },
      { chat_type: 'thread', chat_id: 'thread-name-chat', display_name: 'Thread Alias' },
    ]);
    await expect(pool.query('SELECT count(*) FROM conversation_members WHERE account_id=$1 AND chat_type=$2 AND chat_id=$3',
      [accountId, 'group', 'group-name-chat'])).resolves.toMatchObject({ rows: [{ count: '0' }] });

    const refreshed = await repository.commitDirectPoll({ accountId, sourceId, generation, expectedModeRevision: modeRevision,
      expectedCheckpoint: { rowid: '4' }, batchId: 'community-name-live-tail-refresh', cursor: { rowid: '4' }, forwardObservations: [],
      tailObservations: [{ ...threadOne, senderName: 'Updated Thread Alias' }] });
    expect(refreshed).toMatchObject({ tailRepaired: 0, changedMessages: [
      { chatType: 'thread', chatId: 'thread-name-chat', messageId: 'thread-name-message-1' },
    ] });
    const noop = await repository.commitDirectPoll({ accountId, sourceId, generation, expectedModeRevision: modeRevision,
      expectedCheckpoint: { rowid: '4' }, batchId: 'community-name-live-tail-noop', cursor: { rowid: '4' }, forwardObservations: [],
      tailObservations: [{ ...threadOne, senderName: 'Updated Thread Alias' }] });
    expect(noop).toMatchObject({ tailRepaired: 0, changedMessages: [], replayed: false });

    const malformed = await repository.commitDirectPoll({ accountId, sourceId, generation, expectedModeRevision: modeRevision,
      expectedCheckpoint: { rowid: '4' }, batchId: 'community-name-live-tail-malformed', cursor: { rowid: '4' }, forwardObservations: [],
      tailObservations: [{ ...threadOne, senderName: { unexpected: true } as unknown as string }] });
    expect(malformed).toMatchObject({ tailRepaired: 0, conflicts: 0, changedMessages: [] });
    await expect(pool.query('SELECT display_name FROM conversation_members WHERE account_id=$1 AND chat_type=$2 AND chat_id=$3 AND member_id=$4',
      [accountId, 'thread', 'thread-name-chat', 'shared-member'])).resolves.toMatchObject({ rows: [{ display_name: 'Updated Thread Alias' }] });
  });

  it('projects, refreshes, preserves, and clears external mention ranges without changing canonical message identity', async () => {
    const accountId = 'external-tag-range-projection';
    const { sourceId, generation, modeRevision } = await createSource(accountId, {
      snapshotDigest: 'c'.repeat(64), schemaVersion: 'line-schema-v1', highWater: { createdTime: '123', id: 'tag-row' }, eligibleCount: '1',
    });
    const foreignAccountId = 'external-tag-range-foreign';
    await new AccountRepository(pool).ensureAccount(foreignAccountId);
    await pool.query(`INSERT INTO conversations(account_id,chat_type,chat_id,title,native_metadata)
      VALUES ($1,'group','foreign-tag-chat','', '{"midType":null,"parentChatId":null,"communityId":null}'::jsonb)`, [foreignAccountId]);
    await pool.query(`INSERT INTO messages(account_id,message_id,event_id,chat_type,chat_id,sender_id,kind,text_content,reply_to_message_id,
      mention_ids,mention_ranges,ingestion_source,occurred_at,raw)
      VALUES ($1,'native-tag-scoped','foreign-event','group','foreign-tag-chat','foreign-sender','text','foreign text',NULL,
        '["foreign-user"]'::jsonb,'[{"start":0,"end":7,"userId":"foreign-user"}]'::jsonb,'live','2026-10-17T00:00:00Z','{}'::jsonb)`,
    [foreignAccountId]);

    const observation = { observationId: 'tag-row', canonicalMessageId: 'native-tag-scoped', nativeMessageId: 'native-tag-scoped',
      chatType: 'group' as const, chatId: 'tag-chat', senderId: 'tag-sender', kind: 'text', text: '😀 @Agent @all',
      occurredAt: '2026-10-17T00:00:00Z', mentionRanges: [
        { start: 3, end: 9, userId: 'tag-user' }, { start: 10, end: 14, userId: '@all' },
      ] };
    const first = await stageBatch({ accountId, sourceId, generation, expectedCheckpoint: {}, batchId: 'tag-range-first',
      cursor: { createdTime: '123', id: 'tag-row' }, initialImport: true, observations: [observation] }, modeRevision);
    expect(first.changedMessages).toEqual([{ chatType: 'group', chatId: 'tag-chat', messageId: 'native-tag-scoped' }]);
    const initial = await pool.query<{ mention_ids: string[]; mention_ranges: unknown; normalized_digest: string }>(
      `SELECT m.mention_ids,m.mention_ranges,o.normalized_digest FROM messages m JOIN external_source_observations o
        ON o.account_id=m.account_id AND o.canonical_message_id=m.message_id
       WHERE m.account_id=$1 AND m.message_id='native-tag-scoped' AND o.source_id=$2 AND o.observation_id='tag-row'`,
      [accountId, sourceId]);
    expect(initial.rows[0]).toEqual({ mention_ids: ['tag-user', '@all'], mention_ranges: observation.mentionRanges,
      normalized_digest: expect.any(String) });
    const originalDigest = initial.rows[0]!.normalized_digest;

    const invalid = await stageBatch({ accountId, sourceId, generation, expectedCheckpoint: { createdTime: '123', id: 'tag-row' },
      batchId: 'tag-range-invalid', cursor: { createdTime: '123', id: 'tag-row' }, initialImport: true,
      observations: [{ ...observation, mentionRanges: [{ start: -1, end: 9, userId: 'bad-user' }] }] }, modeRevision);
    expect(invalid).toMatchObject({ conflicts: 0, changedMessages: [] });
    const absent = await stageBatch({ accountId, sourceId, generation, expectedCheckpoint: { createdTime: '123', id: 'tag-row' },
      batchId: 'tag-range-absent', cursor: { createdTime: '123', id: 'tag-row' }, initialImport: true,
      observations: [{ ...observation, mentionRanges: undefined }] }, modeRevision);
    expect(absent).toMatchObject({ conflicts: 0, changedMessages: [] });
    await expect(pool.query('SELECT mention_ids,mention_ranges FROM messages WHERE account_id=$1 AND message_id=$2',
      [accountId, 'native-tag-scoped'])).resolves.toMatchObject({ rows: [{ mention_ids: ['tag-user', '@all'], mention_ranges: observation.mentionRanges }] });

    const updatedRanges = [{ start: 3, end: 9, userId: 'renamed-tag-user' }];
    const refreshed = await stageBatch({ accountId, sourceId, generation, expectedCheckpoint: { createdTime: '123', id: 'tag-row' },
      batchId: 'tag-range-refresh', cursor: { createdTime: '123', id: 'tag-row' }, initialImport: true,
      observations: [{ ...observation, mentionRanges: updatedRanges }] }, modeRevision);
    expect(refreshed).toMatchObject({ conflicts: 0, replayed: false,
      changedMessages: [{ chatType: 'group', chatId: 'tag-chat', messageId: 'native-tag-scoped' }] });
    const refreshedRow = await pool.query<{ mention_ids: string[]; mention_ranges: unknown; normalized_digest: string }>(
      `SELECT m.mention_ids,m.mention_ranges,o.normalized_digest FROM messages m JOIN external_source_observations o
        ON o.account_id=m.account_id AND o.canonical_message_id=m.message_id
       WHERE m.account_id=$1 AND m.message_id='native-tag-scoped' AND o.source_id=$2 AND o.observation_id='tag-row'`,
      [accountId, sourceId]);
    expect(refreshedRow.rows[0]).toEqual({ mention_ids: ['renamed-tag-user'], mention_ranges: updatedRanges, normalized_digest: originalDigest });

    const noop = await stageBatch({ accountId, sourceId, generation, expectedCheckpoint: { createdTime: '123', id: 'tag-row' },
      batchId: 'tag-range-noop', cursor: { createdTime: '123', id: 'tag-row' }, initialImport: true,
      observations: [{ ...observation, mentionRanges: updatedRanges }] }, modeRevision);
    expect(noop).toMatchObject({ conflicts: 0, replayed: false, changedMessages: [] });
    const cleared = await stageBatch({ accountId, sourceId, generation, expectedCheckpoint: { createdTime: '123', id: 'tag-row' },
      batchId: 'tag-range-clear', cursor: { createdTime: '123', id: 'tag-row' }, initialImport: true,
      observations: [{ ...observation, mentionRanges: [] }] }, modeRevision);
    expect(cleared).toMatchObject({ conflicts: 0, changedMessages: [
      { chatType: 'group', chatId: 'tag-chat', messageId: 'native-tag-scoped' },
    ] });
    await expect(pool.query('SELECT mention_ids,mention_ranges FROM messages WHERE account_id=$1 AND message_id=$2',
      [accountId, 'native-tag-scoped'])).resolves.toMatchObject({ rows: [{ mention_ids: [], mention_ranges: [] }] });
    await expect(pool.query('SELECT mention_ids,mention_ranges FROM messages WHERE account_id=$1 AND message_id=$2',
      [foreignAccountId, 'native-tag-scoped'])).resolves.toMatchObject({ rows: [{ mention_ids: ['foreign-user'],
        mention_ranges: [{ start: 0, end: 7, userId: 'foreign-user' }] }] });
  });

  it('recomputes mention ranges against text redacted in place and drops ranges that overlap a secret', async () => {
    const accountId = 'external-tag-range-redaction';
    const { sourceId, generation, modeRevision } = await createSource(accountId);
    const original = { observationId: 'redacted-tag-row', canonicalMessageId: 'native-redacted-tag', nativeMessageId: 'native-redacted-tag',
      chatType: 'group' as const, chatId: 'redacted-tag-chat', senderId: 'tag-sender', kind: 'text', text: 'hello @Agent',
      occurredAt: '2026-10-17T00:00:00Z', mentionRanges: [{ start: 6, end: 12, userId: 'tag-user' }] };
    await stageBatch({ accountId, sourceId, generation, expectedCheckpoint: null, batchId: 'tag-redaction-first',
      cursor: { rowid: '1' }, observations: [original] });
    const redacted = await repository.commitDirectPoll({ accountId, sourceId, generation, expectedModeRevision: modeRevision,
      expectedCheckpoint: { rowid: '1' }, batchId: 'tag-redaction-update', cursor: { rowid: '2' }, forwardObservations: [],
      tailObservations: [{ ...original, text: 'LW-ABCDEFGH @Agent', mentionRanges: [{ start: 12, end: 18, userId: 'tag-user' }] }] });
    expect(redacted).toMatchObject({ conflicts: 0, changedMessages: [
      { chatType: 'group', chatId: 'redacted-tag-chat', messageId: 'native-redacted-tag' },
    ] });
    await expect(pool.query('SELECT text_content,mention_ranges FROM messages WHERE account_id=$1 AND message_id=$2',
      [accountId, 'native-redacted-tag'])).resolves.toMatchObject({ rows: [{ text_content: '[REDACTED_VERIFICATION_CODE] @Agent',
      mention_ranges: [{ start: 29, end: 35, userId: 'tag-user' }] }] });
    const overlapping = await repository.commitDirectPoll({ accountId, sourceId, generation, expectedModeRevision: modeRevision,
      expectedCheckpoint: { rowid: '1' }, batchId: 'tag-redaction-overlap', cursor: { rowid: '1' }, forwardObservations: [],
      tailObservations: [{ ...original, text: 'LW-ABCDEFGH @Agent', mentionRanges: [{ start: 3, end: 8, userId: 'tag-user' }] }] });
    expect(overlapping.conflicts).toBe(0);
    await expect(pool.query('SELECT mention_ranges FROM messages WHERE account_id=$1 AND message_id=$2',
      [accountId, 'native-redacted-tag'])).resolves.toMatchObject({ rows: [{ mention_ranges: [] }] });
  });

  it('refreshes mention-only metadata on an unchanged projected tail without reporting a tail repair', async () => {
    const accountId = 'external-tag-range-tail';
    const { sourceId, generation, modeRevision } = await createSource(accountId);
    const original = { observationId: 'tag-tail-row', canonicalMessageId: 'native-tag-tail', nativeMessageId: 'native-tag-tail',
      chatType: 'group' as const, chatId: 'tag-tail-chat', senderId: 'tag-sender', kind: 'text', text: 'hello @Agent',
      occurredAt: '2026-10-17T00:00:00Z' };
    await stageBatch({ accountId, sourceId, generation, expectedCheckpoint: null, batchId: 'tag-tail-first',
      cursor: { rowid: '1' }, observations: [original] });

    const withRanges = { ...original, mentionRanges: [{ start: 6, end: 12, userId: 'tag-user' }] };
    const refreshed = await repository.commitDirectPoll({ accountId, sourceId, generation, expectedModeRevision: modeRevision,
      expectedCheckpoint: { rowid: '1' }, batchId: 'tag-tail-mention-only', cursor: { rowid: '1' }, forwardObservations: [],
      tailObservations: [withRanges] });
    expect(refreshed).toMatchObject({ projected: 0, tailRepaired: 0, conflicts: 0, changedMessages: [
      { chatType: 'group', chatId: 'tag-tail-chat', messageId: 'native-tag-tail' },
    ] });
    await expect(pool.query('SELECT mention_ids,mention_ranges FROM messages WHERE account_id=$1 AND message_id=$2',
      [accountId, 'native-tag-tail'])).resolves.toMatchObject({ rows: [{ mention_ids: ['tag-user'], mention_ranges: withRanges.mentionRanges }] });

    const noop = await repository.commitDirectPoll({ accountId, sourceId, generation, expectedModeRevision: modeRevision,
      expectedCheckpoint: { rowid: '1' }, batchId: 'tag-tail-mention-noop', cursor: { rowid: '1' }, forwardObservations: [],
      tailObservations: [withRanges] });
    expect(noop).toMatchObject({ projected: 0, tailRepaired: 0, conflicts: 0, changedMessages: [] });
  });

  it('writes a fresh 2,000-row initial page with representative bodies and at most 20 PostgreSQL client queries', async () => {
    const accountId = 'external-initial-bulk-query-count';
    const observations = Array.from({ length: 2000 }, (_, index) => ({
      observationId: `bulk-row-${index}`,
      canonicalMessageId: `native-bulk-row-${index}`,
      chatType: 'direct' as const,
      chatId: 'bulk-chat',
      senderId: 'person',
      kind: 'text',
      text: `message ${index} ${'x'.repeat(490)}`,
      occurredAt: new Date(Date.UTC(2026, 9, 17, 0, index)).toISOString(),
    }));
    const { sourceId, generation, modeRevision } = await createSource(accountId, {
      snapshotDigest: 'e'.repeat(64), schemaVersion: 'line-schema-v1', highWater: { id: 'bulk-row-1999' }, eligibleCount: '2000',
    });
    const originalConnect = pool.connect.bind(pool);
    let counting = false;
    let queryCalls = 0;
    Object.defineProperty(pool, 'connect', { configurable: true, value: async () => {
      const client = await originalConnect();
      const originalQuery = client.query.bind(client);
      client.query = ((...args: Parameters<Pool['query']>) => {
        if (counting) queryCalls++;
        return originalQuery(...args);
      }) as typeof client.query;
      return client;
    } });
    const started = performance.now();
    counting = true;
    let result: Awaited<ReturnType<ExternalMonitorRepository['stageAndProjectBatch']>>;
    try {
      result = await repository.stageAndProjectBatch({ accountId, sourceId, generation, expectedModeRevision: modeRevision,
        expectedCheckpoint: {}, batchId: 'bulk-query-count-page', cursor: { id: 'bulk-row-1999' }, initialImport: true, observations });
    } finally {
      counting = false;
      Object.defineProperty(pool, 'connect', { configurable: true, value: originalConnect });
    }
    const elapsedMs = performance.now() - started;
    console.info(`initial_import_batch_sample rows=2000 bodyBytes=490-500 queryCalls=${queryCalls} elapsedMs=${elapsedMs.toFixed(1)}`);
    expect(result!).toMatchObject({ staged: 2000, projected: 2000, conflicts: 0, replayed: false });
    expect(queryCalls, `2,000-row sample: ${queryCalls} PostgreSQL queries, ${elapsedMs.toFixed(1)} ms`).toBeLessThanOrEqual(20);
    await expect(repository.getInitialImportState({ accountId, sourceId, generation }))
      .resolves.toMatchObject({ committedCount: '2000', cursor: { id: 'bulk-row-1999' } });
    expect((await pool.query('SELECT count(*) FROM messages WHERE account_id=$1', [accountId])).rows[0]?.count).toBe('2000');
    expect((await pool.query('SELECT count(*) FROM message_source_provenance WHERE source_id=$1', [sourceId])).rows[0]?.count).toBe('2000');
    expect((await pool.query("SELECT count(*) FROM external_source_observations WHERE source_id=$1 AND status='PROJECTED'", [sourceId])).rows[0]?.count)
      .toBe('2000');
    const oversizedPayload = Array.from({ length: 2000 }, (_, index) => ({ ...observations[index]!, text: 'x'.repeat(4500) }));
    await expect(repository.stageAndProjectBatch({ accountId, sourceId, generation, expectedModeRevision: modeRevision,
      expectedCheckpoint: { id: 'bulk-row-1999' }, batchId: 'bulk-over-8mib', cursor: { id: 'over-8mib' },
      initialImport: true, observations: oversizedPayload })).rejects.toThrow('External observation batch exceeds limit');
    await expect(repository.getInitialImportState({ accountId, sourceId, generation }))
      .resolves.toMatchObject({ committedCount: '2000', cursor: { id: 'bulk-row-1999' } });
  });

  it('bulk projects empty archive senders and preserves them through direct tail repair and message reads', async () => {
    const accountId = 'external-empty-sender-bulk-tail';
    const { sourceId, generation, modeRevision } = await createSource(accountId, {
      snapshotDigest: 'd'.repeat(64), schemaVersion: 'line-schema-v1', highWater: { id: 'empty-bulk-99' }, eligibleCount: '100',
    });
    const observations: ExternalObservationBatch['observations'] = Array.from({ length: 100 }, (_, index) => ({
      observationId: `empty-bulk-${index}`,
      canonicalMessageId: `native-empty-bulk-${index}`,
      chatType: index === 1 ? 'community' as const : 'direct' as const,
      chatId: index === 1 ? 'native-community' : 'native-direct',
      senderId: index < 2 ? '' : 'native-sender',
      kind: 'text',
      text: index === 0 ? '' : index === 1 ? 'community text without a sender' : `message ${index}`,
      occurredAt: new Date(Date.UTC(2026, 9, 17, 0, index)).toISOString(),
    }));

    await expect(repository.stageAndProjectBatch({ accountId, sourceId, generation, expectedModeRevision: modeRevision, expectedCheckpoint: {},
      batchId: 'empty-sender-bulk-page', cursor: { id: 'empty-bulk-99' }, initialImport: true, observations }))
      .resolves.toMatchObject({ staged: 100, projected: 100, conflicts: 0, replayed: false });

    const persisted = await pool.query<{ observation_id: string; sender_id: string; text_content: string | null }>(
      `SELECT p.observation_id,m.sender_id,m.text_content FROM messages m
       JOIN message_source_provenance p ON p.account_id=m.account_id AND p.message_id=m.message_id
       WHERE m.account_id=$1 AND p.source_id=$2 AND p.observation_id=ANY($3::text[]) ORDER BY p.observation_id`,
      [accountId, sourceId, ['empty-bulk-0', 'empty-bulk-1']]);
    expect(persisted.rows).toEqual([
      { observation_id: 'empty-bulk-0', sender_id: '', text_content: '' },
      { observation_id: 'empty-bulk-1', sender_id: '', text_content: 'community text without a sender' },
    ]);

    const tailObservation = { ...observations[1]!, text: 'tail refreshed community text' };
    const tailMessageId = (await pool.query<{ canonical_message_id: string }>(
      'SELECT canonical_message_id FROM external_source_observations WHERE source_id=$1 AND observation_id=$2', [sourceId, tailObservation.observationId]))
      .rows[0]!.canonical_message_id;
    await expect(repository.commitDirectPoll({ accountId, sourceId, generation, expectedModeRevision: modeRevision,
      expectedCheckpoint: { id: 'empty-bulk-99' }, batchId: 'empty-sender-tail', cursor: { id: 'empty-bulk-99' },
      forwardObservations: [], tailObservations: [tailObservation] }))
      .resolves.toMatchObject({ tailRepaired: 1, conflicts: 0 });
    await expect(pool.query<{ sender_id: string; text_content: string }>(
      'SELECT sender_id,text_content FROM messages WHERE account_id=$1 AND message_id=$2', [accountId, tailMessageId]))
      .resolves.toMatchObject({ rows: [{ sender_id: '', text_content: 'tail refreshed community text' }] });

    const messages = new MessageRepository(pool);
    await expect(messages.searchMessages({ accountId, key: { accountId, chatType: 'community', chatId: 'native-community' }, limit: 10 }))
      .resolves.toEqual([expect.objectContaining({ messageId: tailMessageId, senderId: '', text: 'tail refreshed community text' })]);
    await expect(messages.listMessages({ accountId, chatType: 'community', chatId: 'native-community' }, null, 10))
      .resolves.toMatchObject({ messages: [expect.objectContaining({ messageId: tailMessageId, senderId: '', text: 'tail refreshed community text' })] });
    await expect(repository.getInitialImportState({ accountId, sourceId, generation }))
      .resolves.toMatchObject({ committedCount: '100', cursor: { id: 'empty-bulk-99' } });
  });

  it('bulk projects mixed rows while preserving existing canonical fields and applying shared metadata once', async () => {
    const accountId = 'external-initial-bulk-mixed-metadata';
    const { sourceId, generation, modeRevision } = await createSource(accountId, {
      snapshotDigest: 'f'.repeat(64), schemaVersion: 'line-schema-v1', highWater: { id: 'bulk-meta-3' }, eligibleCount: '4',
    });
    await pool.query(`INSERT INTO conversations(account_id,chat_type,chat_id,title,native_metadata)
      VALUES ($1,'community','bulk-community','old title','{"midType":4,"parentChatId":null,"communityId":"old"}'::jsonb)`, [accountId]);
    await pool.query(`INSERT INTO messages(account_id,message_id,event_id,chat_type,chat_id,sender_id,kind,text_content,reply_to_message_id,
      mention_ids,mention_ranges,ingestion_source,occurred_at,raw)
      VALUES ($1,'bulk-existing-message','operator-event','community','bulk-community','sender','text','same body','local-reply',
        '["local-mention"]'::jsonb,'[]'::jsonb,'live','2026-10-17T00:00:00Z','{"local":true}'::jsonb)`, [accountId]);
    const observations: ExternalObservationBatch['observations'] = Array.from({ length: 4 }, (_, index) => ({
      observationId: `bulk-meta-${index}`, canonicalMessageId: index === 0 ? 'bulk-existing-message' : `bulk-meta-message-${index}`,
      ...(index === 0 ? { nativeMessageId: 'bulk-existing-message' } : {}),
      chatType: 'community', chatId: 'bulk-community', senderId: 'sender', kind: 'text',
      text: index === 0 ? 'same body' : `body ${index}`, occurredAt: `2026-10-17T00:00:0${index}Z`,
      ...(index % 2 === 0 ? { conversationTitle: 'new title', nativeMetadata: { midType: 4, parentChatId: null, communityId: 'community' } } : {}),
    }));
    const result = await repository.stageAndProjectBatch({ accountId, sourceId, generation, expectedModeRevision: modeRevision,
      expectedCheckpoint: {}, batchId: 'bulk-mixed-metadata', cursor: { id: 'bulk-meta-3' }, initialImport: true, observations });
    const canonical = await pool.query<{ canonical_message_id: string }>(`SELECT canonical_message_id FROM external_source_observations
      WHERE source_id=$1 ORDER BY observation_id`, [sourceId]);
    expect(result).toMatchObject({ projected: 4, conflicts: 0, changedMessages: canonical.rows.map((row) => ({
      chatType: 'community', chatId: 'bulk-community', messageId: row.canonical_message_id,
    })) });
    const saved = await pool.query(`SELECT c.title,c.native_metadata,m.event_id,m.ingestion_source,m.reply_to_message_id,m.mention_ids,m.raw
      FROM conversations c JOIN messages m ON m.account_id=c.account_id AND m.chat_type=c.chat_type AND m.chat_id=c.chat_id
      WHERE c.account_id=$1 AND m.message_id='bulk-existing-message'`, [accountId]);
    expect(saved.rows[0]).toMatchObject({ title: 'new title', native_metadata: { midType: 4, parentChatId: null, communityId: 'community' },
      event_id: 'operator-event', ingestion_source: 'live', reply_to_message_id: 'local-reply', mention_ids: ['local-mention'], raw: { local: true } });
  });

  it('retains ordered metadata writes when a repeated conversation changes A to B to A', async () => {
    const accountId = 'external-initial-bulk-metadata-fallback';
    const { sourceId, generation, modeRevision } = await createSource(accountId, {
      snapshotDigest: '1'.repeat(64), schemaVersion: 'line-schema-v1', highWater: { id: 'fallback-2' }, eligibleCount: '3',
    });
    const oldUpdatedAt = new Date('2020-01-01T00:00:00Z');
    await pool.query(`INSERT INTO conversations(account_id,chat_type,chat_id,title,native_metadata,updated_at)
      VALUES ($1,'thread','fallback-thread','A','{"midType":7,"parentChatId":"parent-a","communityId":"community"}'::jsonb,$2)`,
    [accountId, oldUpdatedAt]);
    await pool.query(`INSERT INTO messages(account_id,message_id,event_id,chat_type,chat_id,sender_id,kind,text_content,reply_to_message_id,
      mention_ids,mention_ranges,ingestion_source,occurred_at,raw) VALUES
      ($1,'fallback-message-0','event-0','thread','fallback-thread','sender','text','A1',NULL,'[]'::jsonb,'[]'::jsonb,'history','2026-10-17T00:00:00Z','{}'::jsonb),
      ($1,'fallback-message-1','event-1','thread','fallback-thread','sender','text','B',NULL,'[]'::jsonb,'[]'::jsonb,'history','2026-10-17T00:00:01Z','{}'::jsonb),
      ($1,'fallback-message-2','event-2','thread','fallback-thread','sender','text','A2',NULL,'[]'::jsonb,'[]'::jsonb,'history','2026-10-17T00:00:02Z','{}'::jsonb)`, [accountId]);
    const rows: ExternalObservationBatch['observations'] = [
      { observationId: 'fallback-0', canonicalMessageId: 'fallback-message-0', nativeMessageId: 'fallback-message-0', chatType: 'thread', chatId: 'fallback-thread',
        conversationTitle: 'A', nativeMetadata: { midType: 7, parentChatId: 'parent-a', communityId: 'community' },
        senderId: 'sender', kind: 'text', text: 'A1', occurredAt: '2026-10-17T00:00:00Z' },
      { observationId: 'fallback-1', canonicalMessageId: 'fallback-message-1', nativeMessageId: 'fallback-message-1', chatType: 'thread', chatId: 'fallback-thread',
        conversationTitle: 'B', nativeMetadata: { midType: 7, parentChatId: 'parent-b', communityId: 'community' },
        senderId: 'sender', kind: 'text', text: 'B', occurredAt: '2026-10-17T00:00:01Z' },
      { observationId: 'fallback-2', canonicalMessageId: 'fallback-message-2', nativeMessageId: 'fallback-message-2', chatType: 'thread', chatId: 'fallback-thread',
        conversationTitle: 'A', nativeMetadata: { midType: 7, parentChatId: 'parent-a', communityId: 'community' },
        senderId: 'sender', kind: 'text', text: 'A2', occurredAt: '2026-10-17T00:00:02Z' },
    ];
    const result = await repository.stageAndProjectBatch({ accountId, sourceId, generation, expectedModeRevision: modeRevision,
      expectedCheckpoint: {}, batchId: 'ordered-metadata-fallback', cursor: { id: 'fallback-2' }, initialImport: true, observations: rows });
    const canonical = await pool.query<{ canonical_message_id: string }>(`SELECT canonical_message_id FROM external_source_observations
      WHERE source_id=$1 ORDER BY observation_id`, [sourceId]);
    expect(result.changedMessages.map((row) => row.messageId)).toEqual(canonical.rows.slice(1).map((row) => row.canonical_message_id));
    await expect(pool.query('SELECT title,native_metadata,updated_at FROM conversations WHERE account_id=$1 AND chat_type=$2 AND chat_id=$3',
      [accountId, 'thread', 'fallback-thread'])).resolves.toMatchObject({ rows: [{ title: 'A', native_metadata: {
        midType: 7, parentChatId: 'parent-a', communityId: 'community',
      } }] });
    const savedConversation = await pool.query<{ updated_at: Date }>(
      'SELECT updated_at FROM conversations WHERE account_id=$1 AND chat_type=$2 AND chat_id=$3', [accountId, 'thread', 'fallback-thread']);
    expect(savedConversation.rows[0]!.updated_at.getTime()).toBeGreaterThan(oldUpdatedAt.getTime());
  });

  it('bulk writes repeated conversations with absent metadata and keeps duplicate canonical IDs ordered', async () => {
    const accountId = 'external-initial-bulk-null-and-duplicate';
    const { sourceId, generation, modeRevision } = await createSource(accountId, {
      snapshotDigest: '3'.repeat(64), schemaVersion: 'line-schema-v1', highWater: { id: 'duplicate-1' }, eligibleCount: '4',
    });
    const firstPage = await repository.stageAndProjectBatch({ accountId, sourceId, generation, expectedModeRevision: modeRevision,
      expectedCheckpoint: {}, batchId: 'null-metadata-page', cursor: { id: 'null-1' }, initialImport: true, observations: [
        { observationId: 'null-0', canonicalMessageId: 'null-native-0', nativeMessageId: 'null-native-0', chatType: 'direct',
          chatId: 'null-chat', senderId: 'sender', kind: 'text', text: 'first', occurredAt: '2026-10-17T00:00:00Z' },
        { observationId: 'null-1', canonicalMessageId: 'null-native-1', nativeMessageId: 'null-native-1', chatType: 'direct',
          chatId: 'null-chat', senderId: 'sender', kind: 'text', text: 'second', occurredAt: '2026-10-17T00:00:01Z' },
      ] });
    expect(firstPage).toMatchObject({ projected: 2, conflicts: 0 });
    await expect(pool.query('SELECT title,native_metadata FROM conversations WHERE account_id=$1 AND chat_id=$2', [accountId, 'null-chat']))
      .resolves.toMatchObject({ rows: [{ title: '', native_metadata: { midType: null, parentChatId: null, communityId: null } }] });
    const duplicatePage = await repository.stageAndProjectBatch({ accountId, sourceId, generation, expectedModeRevision: modeRevision,
      expectedCheckpoint: { id: 'null-1' }, batchId: 'duplicate-canonical-page', cursor: { id: 'duplicate-1' }, initialImport: true,
      observations: [
        { observationId: 'duplicate-0', canonicalMessageId: 'same-native-id', nativeMessageId: 'same-native-id', chatType: 'direct',
          chatId: 'duplicate-chat', senderId: 'sender-a', kind: 'text', text: 'before', occurredAt: '2026-10-17T00:00:02Z' },
        { observationId: 'duplicate-1', canonicalMessageId: 'same-native-id', nativeMessageId: 'same-native-id', chatType: 'direct',
          chatId: 'duplicate-chat', senderId: 'sender-b', kind: 'event', text: 'after', occurredAt: '2026-10-17T00:00:03Z' },
      ] });
    expect(duplicatePage).toMatchObject({ projected: 2, conflicts: 0 });
    expect(duplicatePage.changedMessages.map((row) => row.messageId)).toEqual(['same-native-id', 'same-native-id']);
    await expect(pool.query(`SELECT count(*) AS messages,max(sender_id) AS sender_id,max(kind) AS kind,max(text_content) AS text_content
      FROM messages WHERE account_id=$1 AND message_id=$2`, [accountId, 'same-native-id']))
      .resolves.toMatchObject({ rows: [{ messages: '1', sender_id: 'sender-b', kind: 'event', text_content: 'after' }] });
    await expect(repository.getInitialImportState({ accountId, sourceId, generation })).resolves.toMatchObject({ committedCount: '4' });
  });

  it('rolls back a failed later set write while keeping the previous initial page committed', async () => {
    const accountId = 'external-initial-bulk-late-failure';
    const { sourceId, generation, modeRevision } = await createSource(accountId, {
      snapshotDigest: '2'.repeat(64), schemaVersion: 'line-schema-v1', highWater: { id: 'late-row' }, eligibleCount: '2',
    });
    const first = { accountId, sourceId, generation, expectedModeRevision: modeRevision, expectedCheckpoint: {}, batchId: 'bulk-first-page',
      cursor: { id: 'first-row' }, initialImport: true as const, observations: [{ observationId: 'first-row', canonicalMessageId: 'first-message',
        chatType: 'direct' as const, chatId: 'atomic-chat', senderId: 'person', kind: 'text', text: 'first',
        occurredAt: '2026-10-17T00:00:00Z' }] };
    await repository.stageAndProjectBatch(first);
    await pool.query(`CREATE FUNCTION reject_late_initial_projection() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN IF NEW.observation_id='late-row' AND NEW.status='PROJECTED' THEN RAISE EXCEPTION 'forced late projection failure'; END IF; RETURN NEW; END $$`);
    await pool.query(`CREATE TRIGGER reject_late_initial_projection BEFORE UPDATE ON external_source_observations
      FOR EACH ROW EXECUTE FUNCTION reject_late_initial_projection()`);
    try {
      await expect(repository.stageAndProjectBatch({ ...first, batchId: 'bulk-second-page', expectedCheckpoint: first.cursor,
        cursor: { id: 'late-row' }, observations: [{ ...first.observations[0]!, observationId: 'late-row',
          canonicalMessageId: 'late-message', text: 'late' }] })).rejects.toThrow('forced late projection failure');
    } finally {
      await pool.query('DROP TRIGGER reject_late_initial_projection ON external_source_observations');
      await pool.query('DROP FUNCTION reject_late_initial_projection()');
    }
    const state = await pool.query(`SELECT c.cursor,c.committed_count,
      (SELECT count(*) FROM external_source_batches WHERE source_id=$1) AS batches,
      (SELECT count(*) FROM external_source_observations WHERE source_id=$1) AS observations,
      (SELECT count(*) FROM messages WHERE account_id=$2) AS messages,
      (SELECT count(*) FROM message_source_provenance WHERE source_id=$1) AS provenance
      FROM external_source_checkpoints c WHERE c.source_id=$1`, [sourceId, accountId]);
    expect(state.rows[0]).toEqual({ cursor: first.cursor, committed_count: '1', batches: '1', observations: '1', messages: '1', provenance: '1' });
  });

  it('rejects duplicate rows within a strict page and counts an observation only once across pages', async () => {
    const accountId = 'external-initial-distinct-count';
    const { sourceId, generation, modeRevision } = await createSource(accountId, {
      snapshotDigest: 'd'.repeat(64), schemaVersion: 'line-schema-v1', highWater: { id: 'row-2', createdTime: '2' }, eligibleCount: '1',
    });
    const observation = { observationId: 'same-row', canonicalMessageId: 'native-same-row', chatType: 'direct' as const,
      chatId: 'chat', senderId: 'person', kind: 'text', text: 'same', occurredAt: '2026-10-17T00:00:00Z' };
    await expect(repository.stageAndProjectBatch({ accountId, sourceId, generation, expectedModeRevision: modeRevision, expectedCheckpoint: {},
      batchId: 'duplicate-within-page', cursor: { createdTime: '1', id: 'same-row' }, initialImport: true,
      observations: [observation, observation] })).rejects.toThrow('duplicate observation');
    await repository.stageAndProjectBatch({ accountId, sourceId, generation, expectedModeRevision: modeRevision, expectedCheckpoint: {},
      batchId: 'first-occurrence', cursor: { createdTime: '1', id: 'same-row' }, initialImport: true, observations: [observation] });
    await repository.stageAndProjectBatch({ accountId, sourceId, generation, expectedModeRevision: modeRevision,
      expectedCheckpoint: { createdTime: '1', id: 'same-row' }, batchId: 'repeat-on-next-page',
      cursor: { createdTime: '2', id: 'row-2' }, initialImport: true, observations: [observation] });
    await expect(repository.getInitialImportState({ accountId, sourceId, generation })).resolves.toMatchObject({ committedCount: '1' });
  });

  it('destroys an import transaction when cancellation arrives while its account row is locked', async () => {
    const accountId = 'external-import-cancel-lock';
    const { sourceId, generation, modeRevision } = await createSource(accountId, {
      snapshotDigest: 'e'.repeat(64), schemaVersion: 'line-schema-v1', highWater: null, eligibleCount: '0',
    });
    const blocker = await pool.connect();
    await blocker.query('BEGIN');
    await blocker.query('SELECT account_id FROM line_accounts WHERE account_id=$1 FOR UPDATE', [accountId]);
    const controller = new AbortController();
    const query = repository.stageAndProjectBatch({ accountId, sourceId, generation, expectedModeRevision: modeRevision, expectedCheckpoint: {},
      batchId: 'cancelled-under-lock', cursor: {}, initialImport: true, signal: controller.signal, observations: [] });
    await new Promise((resolve) => setTimeout(resolve, 150));
    controller.abort();
    await expect(query).rejects.toThrow('cancelled');
    await blocker.query('ROLLBACK');
    blocker.release();
    const state = await pool.query(`SELECT c.cursor,c.committed_count,
      (SELECT count(*) FROM external_source_batches b WHERE b.source_id=c.source_id) AS batches
      FROM external_source_checkpoints c WHERE c.source_id=$1`, [sourceId]);
    expect(state.rows[0]).toEqual({ cursor: {}, committed_count: '0', batches: '0' });
  });

  it('resets scan progress on changed copy, retains archive relations, and upserts duplicate LINE IDs', async () => {
    const accountId = 'external-import-snapshot-reset';
    const { sourceId, generation, modeRevision } = await createSource(accountId, {
      snapshotDigest: 'f'.repeat(64), schemaVersion: 'schema-a', highWater: { id: 'old-2', createdTime: '2' }, eligibleCount: '2',
    });
    const first = { observationId: 'same-native-row', canonicalMessageId: 'native-same-row', chatType: 'direct' as const,
      chatId: 'chat', senderId: 'person', kind: 'text', text: 'first', occurredAt: '2026-10-17T00:00:00Z' };
    await repository.stageAndProjectBatch({ accountId, sourceId, generation, expectedModeRevision: modeRevision,
      expectedCheckpoint: {}, batchId: 'old-first-page', cursor: { createdTime: '1', id: 'old-1' }, initialImport: true,
      observations: [first] });
    const firstMessageId = (await pool.query<{ canonical_message_id: string }>(
      'SELECT canonical_message_id FROM external_source_observations WHERE source_id=$1 AND observation_id=$2', [sourceId, first.observationId])).rows[0]!.canonical_message_id;
    await pool.query(`UPDATE messages SET event_id='app-owned-event',ingestion_source='live',reply_to_message_id='local-reply',
      mention_ids='["local-mention"]'::jsonb,mention_ranges='[{"start":0,"length":4}]'::jsonb,raw='{"local":true}'::jsonb
      WHERE account_id=$1 AND message_id=$2`, [accountId, firstMessageId]);
    await pool.query(`INSERT INTO message_revisions(revision_id,account_id,message_id,text_content,raw)
      VALUES (gen_random_uuid(),$1,$2,'local revision','{"local":true}'::jsonb)`, [accountId, firstMessageId]);
    await pool.query(`INSERT INTO message_reactions(account_id,message_id,reactor_id,reaction)
      VALUES ($1,$2,'local-reactor','LIKE')`, [accountId, firstMessageId]);
    const oldState = await repository.getInitialImportState({ accountId, sourceId, generation });
    await repository.resetUnfinishedInitialImport({ accountId, sourceId, generation, expectedModeRevision: modeRevision,
      expectedCheckpoint: oldState!.cursor, sourceIdentityDigest: oldState!.sourceIdentityDigest,
      snapshotDigest: '1'.repeat(64), schemaVersion: 'schema-b', highWater: { id: 'new-2', createdTime: '2' }, eligibleCount: '2' });
    const resetState = await repository.getInitialImportState({ accountId, sourceId, generation });
    expect(resetState).toMatchObject({ cursor: {}, committedCount: '0', snapshotDigest: '1'.repeat(64) });
    const retained = await pool.query(`SELECT m.event_id,m.ingestion_source,m.reply_to_message_id,m.mention_ids,m.mention_ranges,m.raw,
      (SELECT count(*) FROM message_revisions r WHERE r.account_id=m.account_id AND r.message_id=m.message_id) AS revisions,
      (SELECT count(*) FROM message_reactions r WHERE r.account_id=m.account_id AND r.message_id=m.message_id) AS reactions,
      (SELECT count(*) FROM message_source_provenance p WHERE p.account_id=m.account_id AND p.message_id=m.message_id) AS provenance
      FROM messages m WHERE m.account_id=$1 AND m.message_id=$2`, [accountId, firstMessageId]);
    expect(retained.rows[0]).toMatchObject({ event_id: 'app-owned-event', ingestion_source: 'live', reply_to_message_id: 'local-reply',
      mention_ids: ['local-mention'], mention_ranges: [{ start: 0, length: 4 }], raw: { local: true }, revisions: '1', reactions: '1', provenance: '0' });
    const changed = { ...first, senderId: 'new-sender', kind: 'event', text: 'updated in new copy', occurredAt: '2026-10-18T00:00:00Z' };
    await repository.stageAndProjectBatch({ accountId, sourceId, generation, expectedModeRevision: modeRevision,
      expectedCheckpoint: {}, batchId: 'new-first-page', cursor: { createdTime: '1', id: 'new-1' }, initialImport: true,
      observations: [changed] });
    const overwritten = await pool.query(`SELECT event_id,ingestion_source,reply_to_message_id,mention_ids,mention_ranges,raw,
      sender_id,kind,text_content,occurred_at FROM messages WHERE account_id=$1 AND message_id=$2`, [accountId, firstMessageId]);
    expect(overwritten.rows[0]).toMatchObject({ event_id: 'app-owned-event', ingestion_source: 'live', reply_to_message_id: 'local-reply',
      mention_ids: ['local-mention'], mention_ranges: [{ start: 0, length: 4 }], raw: { local: true },
      sender_id: 'new-sender', kind: 'event', text_content: 'updated in new copy', occurred_at: new Date('2026-10-18T00:00:00Z') });
    await repository.stageAndProjectBatch({ accountId, sourceId, generation, expectedModeRevision: modeRevision,
      expectedCheckpoint: { createdTime: '1', id: 'new-1' }, batchId: 'new-second-page',
      cursor: { createdTime: '2', id: 'new-2' }, initialImport: true,
      observations: [{ ...changed, observationId: 'second-row', canonicalMessageId: 'native-second-row', text: 'second' }] });
    await expect(repository.getInitialImportState({ accountId, sourceId, generation })).resolves.toMatchObject({
      cursor: { createdTime: '2', id: 'new-2' }, committedCount: '2', snapshotDigest: '1'.repeat(64),
    });
  });

  it('rolls back an initial page that contains a changed digest conflict', async () => {
    const accountId = 'external-initial-conflict';
    const { sourceId, generation, modeRevision } = await createSource(accountId, {
      snapshotDigest: 'b'.repeat(64), schemaVersion: 'line-schema-v1', highWater: { createdTime: '2', id: 'row-2' }, eligibleCount: '2',
    });
    const first = { accountId, sourceId, generation, expectedModeRevision: modeRevision, expectedCheckpoint: {}, batchId: 'first-page',
      cursor: { createdTime: '1', id: 'row-1' }, initialImport: true as const, observations: [{ observationId: 'row-1',
        canonicalMessageId: 'native-row-1', chatType: 'direct' as const, chatId: 'chat', senderId: 'person', kind: 'text',
        text: 'first', occurredAt: '2026-10-17T00:00:00Z' }] };
    await repository.stageAndProjectBatch(first);
    await expect(repository.stageAndProjectBatch({ ...first, batchId: 'conflicting-page', expectedCheckpoint: first.cursor,
      cursor: { createdTime: '2', id: 'row-2' }, observations: [{ ...first.observations[0]!, text: 'changed' }] }))
      .rejects.toThrow('External initial import page contains a conflict');
    const persisted = await pool.query(`SELECT c.cursor,c.committed_count,
      (SELECT count(*) FROM external_source_batches b WHERE b.source_id=c.source_id) AS batches,
      (SELECT count(*) FROM external_source_conflicts f WHERE f.source_id=c.source_id) AS conflicts
      FROM external_source_checkpoints c WHERE c.source_id=$1`, [sourceId]);
    expect(persisted.rows[0]).toEqual({ cursor: first.cursor, committed_count: '1', batches: '1', conflicts: '0' });
  });

  it('atomically completes an empty initial import and rejects a stale binding', async () => {
    const accountId = 'external-initial-empty';
    const emptySource = await createSource(accountId, { snapshotDigest: 'c'.repeat(64), schemaVersion: 'line-schema-v1', highWater: null, eligibleCount: '0' });
    await repository.completeInitialImport({ accountId, sourceId: emptySource.sourceId, generation: emptySource.generation,
      expectedModeRevision: emptySource.modeRevision, expectedCheckpoint: {}, finalCursor: {}, highWater: null });
    await expect(repository.getInitialImportState({ accountId, sourceId: emptySource.sourceId, generation: emptySource.generation }))
      .resolves.toMatchObject({ initialImportComplete: true, committedCount: '0', eligibleCount: '0' });

    const staleAccount = 'external-initial-stale';
    const stale = await createSource(staleAccount, { snapshotDigest: 'd'.repeat(64), schemaVersion: 'line-schema-v1', highWater: null, eligibleCount: '0' });
    await repository.bindVerifiedExternalSource({ accountId: staleAccount, ownMid: `verified-mid-${staleAccount}`, sourceIdentity: 'replacement-source' });
    await expect(repository.completeInitialImport({ accountId: staleAccount, sourceId: stale.sourceId, generation: stale.generation,
      expectedModeRevision: stale.modeRevision, expectedCheckpoint: {}, finalCursor: {}, highWater: null }))
      .rejects.toThrow('External initial import authority is stale');
  });

  it('rejects staged and conflict observations, then completes when all initial observations are projected', async () => {
    const accountId = 'external-initial-completion-statuses';
    const { sourceId, generation, modeRevision } = await createSource(accountId, {
      snapshotDigest: 'e'.repeat(64), schemaVersion: 'line-schema-v1', highWater: { id: 'status-row' }, eligibleCount: '1',
    });
    const cursor = { id: 'status-row' };
    await repository.stageAndProjectBatch({ accountId, sourceId, generation, expectedModeRevision: modeRevision,
      expectedCheckpoint: {}, batchId: 'status-page', cursor, initialImport: true, observations: [{ observationId: 'status-row',
        canonicalMessageId: 'native-status-row', chatType: 'direct', chatId: 'status-chat', senderId: 'person', kind: 'text',
        text: 'status fixture', occurredAt: '2026-10-17T00:00:00Z' }] });
    const complete = () => repository.completeInitialImport({ accountId, sourceId, generation, expectedModeRevision: modeRevision,
      expectedCheckpoint: cursor, finalCursor: cursor, highWater: cursor });
    await pool.query("UPDATE external_source_observations SET status='STAGED' WHERE source_id=$1 AND generation=$2 AND observation_id='status-row'", [sourceId, generation]);
    await expect(complete()).rejects.toThrow('External initial import has unprojected observations');
    await pool.query("UPDATE external_source_observations SET status='CONFLICT' WHERE source_id=$1 AND generation=$2 AND observation_id='status-row'", [sourceId, generation]);
    await expect(complete()).rejects.toThrow('External initial import has unprojected observations');

    await pool.query("UPDATE external_source_observations SET status='PROJECTED' WHERE source_id=$1 AND generation=$2 AND observation_id='status-row'", [sourceId, generation]);
    await complete();
    await expect(repository.getInitialImportState({ accountId, sourceId, generation }))
      .resolves.toMatchObject({ initialImportComplete: true, committedCount: '1', eligibleCount: '1', cursor });
  });

  it('fences authority changes under lock, including mode away-and-back before an exact replay', async () => {
    const accountId = 'external-authority-fence';
    const { sourceId, generation } = await createSource(accountId);
    const original = { accountId, sourceId, generation, expectedCheckpoint: null, batchId: 'authority-baseline', cursor: { head: 1 },
      observations: [{ observationId: 'authority-row', canonicalMessageId: 'native-authority', chatType: 'direct' as const,
        chatId: 'chat', senderId: 'person', kind: 'text', text: 'authority', occurredAt: '2026-10-17T00:00:00Z' }] };
    expect(await stageBatch(original)).toMatchObject({ replayed: false, projected: 1 });

    await pool.query("UPDATE line_accounts SET source_transition_state='CANDIDATE_CHECKED' WHERE account_id=$1", [accountId]);
    await expect(stageBatch({ ...original, batchId: 'transition-fenced', expectedCheckpoint: { head: 1 } }))
      .rejects.toThrow('External source authority is stale');
    await pool.query("UPDATE line_accounts SET source_transition_state='STABLE' WHERE account_id=$1", [accountId]);

    await pool.query("UPDATE line_accounts SET connection_mode='OFFLINE',mode_revision=mode_revision+1 WHERE account_id=$1", [accountId]);
    await expect(stageBatch({ ...original, batchId: 'mode-fenced', expectedCheckpoint: { head: 1 } }))
      .rejects.toThrow('External source generation is stale');
    await pool.query("UPDATE line_accounts SET connection_mode='EXTERNAL_MONITOR',mode_revision=mode_revision+1 WHERE account_id=$1", [accountId]);
    await expect(stageBatch(original)).rejects.toThrow('External source authority is stale');
    const currentModeRevision = Number((await pool.query<{ mode_revision: string }>(
      'SELECT mode_revision FROM line_accounts WHERE account_id=$1', [accountId])).rows[0]!.mode_revision);

    await pool.query("UPDATE line_accounts SET own_mid='changed-verified-mid' WHERE account_id=$1", [accountId]);
    await expect(stageBatch({ ...original, batchId: 'identity-fenced', expectedCheckpoint: { head: 1 } }, currentModeRevision))
      .rejects.toThrow('External source generation is stale');
    await pool.query('UPDATE line_accounts SET own_mid=$2 WHERE account_id=$1', [accountId, `verified-mid-${accountId}`]);

    await pool.query("UPDATE line_accounts SET product_role=NULL WHERE account_id=$1", [accountId]);
    await expect(stageBatch({ ...original, batchId: 'role-fenced', expectedCheckpoint: { head: 1 } }, currentModeRevision))
      .rejects.toThrow('External source authority is stale');
  });

  it('fences imports after the captured Agent administrator MID or version changes', async () => {
    const accountId = 'external-admin-binding-fence';
    const { sourceId, generation } = await createSource(accountId);
    const observation = { observationId: 'admin-row', canonicalMessageId: 'native-admin', chatType: 'direct' as const,
      chatId: 'chat', senderId: 'person', kind: 'text', text: 'must not project', occurredAt: '2026-10-17T00:00:00Z' };
    await pool.query("UPDATE account_administrators SET chat_id='replacement-admin-chat' WHERE account_id='external-test-agent' AND role='PRIMARY_ADMIN'");
    await expect(stageBatch({ accountId, sourceId, generation, expectedCheckpoint: null, batchId: 'admin-version-changed', cursor: { head: 1 },
      observations: [observation] })).rejects.toThrow('External administrator binding is stale');
    await pool.query("UPDATE account_administrators SET user_id='replacement-admin-mid' WHERE account_id='external-test-agent' AND role='PRIMARY_ADMIN'");
    await expect(stageBatch({ accountId, sourceId, generation, expectedCheckpoint: null, batchId: 'admin-mid-changed', cursor: { head: 1 },
      observations: [observation] }))
      .rejects.toThrow('External administrator binding is stale');
    expect((await pool.query('SELECT count(*) FROM external_source_batches WHERE source_id=$1', [sourceId])).rows[0]?.count).toBe('0');
  });

  it('replays an exact bounded batch once and upserts changed LINE fields by canonical message ID', async () => {
    const accountId = 'external-projection';
    const { sourceId, generation } = await createSource(accountId);
    const batch = {
      accountId, sourceId, generation, expectedCheckpoint: null, batchId: 'batch-1', cursor: { rowid: '10' },
      observations: [{ observationId: 'row-1', canonicalMessageId: 'line-message-1', chatType: 'direct' as const,
        chatId: 'chat-1', senderId: 'person-1', kind: 'text', text: 'hello LW-ABCDEFGH RA-a1b2', occurredAt: '2026-10-17T00:00:00Z' }],
    };
    expect(await stageBatch(batch)).toMatchObject({ staged: 1, projected: 1, conflicts: 0, replayed: false });
    expect(await stageBatch(batch)).toMatchObject({ staged: 1, projected: 1, conflicts: 0, replayed: true });
    expect(await stageBatch({
      ...batch, expectedCheckpoint: { rowid: '10' }, batchId: 'batch-2', cursor: { rowid: '11' },
      observations: [{ ...batch.observations[0], observationId: 'row-2', senderId: 'person-2', kind: 'event', text: 'changed payload' }],
    })).toMatchObject({ staged: 1, projected: 1, conflicts: 0, replayed: false });

    const rows = await pool.query(`SELECT
      (SELECT count(*) FROM messages WHERE account_id=$2) AS messages,
      (SELECT count(*) FROM external_source_observations WHERE source_id=$1) AS observations,
      (SELECT status FROM external_source_observations WHERE source_id=$1 AND observation_id='row-2') AS second_status,
      (SELECT sender_id FROM messages WHERE account_id=$2 AND message_id=(SELECT canonical_message_id FROM external_source_observations WHERE source_id=$1 AND observation_id='row-2')) AS sender_id,
      (SELECT kind FROM messages WHERE account_id=$2 AND message_id=(SELECT canonical_message_id FROM external_source_observations WHERE source_id=$1 AND observation_id='row-2')) AS kind,
      (SELECT text_content FROM messages WHERE account_id=$2 AND message_id=(SELECT canonical_message_id FROM external_source_observations WHERE source_id=$1 AND observation_id='row-2')) AS text_content,
      (SELECT cursor FROM external_source_checkpoints WHERE source_id=$1) AS checkpoint,
      (SELECT unread_count FROM conversations WHERE account_id=$2 AND chat_type='direct' AND chat_id='chat-1') AS unread,
      (SELECT count(*) FROM agent_jobs WHERE account_id=$2) AS jobs,
      (SELECT count(*) FROM autoresponder_reply_effects WHERE account_id=$2) AS autoresponder_effects`, [sourceId, accountId]);
    expect(rows.rows[0]).toMatchObject({ messages: '1', observations: '2', second_status: 'PROJECTED', sender_id: 'person-2', kind: 'event',
      text_content: 'changed payload', unread: 0, jobs: '0', autoresponder_effects: '0' });
    expect(rows.rows[0]?.checkpoint).toEqual({ rowid: '11' });
    expect((await pool.query('SELECT count(*) FROM message_source_provenance WHERE source_id=$1', [sourceId])).rows[0]?.count).toBe('2');
    const staged = await pool.query<{ normalized_payload: { text: string } }>(
      "SELECT normalized_payload FROM external_source_observations WHERE source_id=$1 AND observation_id='row-1'", [sourceId]);
    expect(staged.rows[0]?.normalized_payload.text).toBe('hello [REDACTED_VERIFICATION_CODE] [REDACTED]');
  });

  it('keeps the projected observation and provenance while recording changed-digest conflict evidence once', async () => {
    const accountId = 'external-observation-conflict';
    const { sourceId, generation } = await createSource(accountId);
    const original = { observationId: 'reused-row', canonicalMessageId: 'stable-line-id', chatType: 'direct' as const,
      chatId: 'chat-1', senderId: 'person-1', kind: 'text', text: 'original', occurredAt: '2026-10-17T00:00:00Z' };
    await stageBatch({ accountId, sourceId, generation, expectedCheckpoint: null, batchId: 'original-batch', cursor: { rowid: '10' }, observations: [original] });
    const changedBatch = { accountId, sourceId, generation, batchId: 'changed-batch', cursor: { rowid: '11' }, observations: [
      { ...original, text: 'changed LW-ABCDEFGH RA-private-token' },
    ] };
    expect(await stageBatch({ ...changedBatch, expectedCheckpoint: { rowid: '10' } })).toMatchObject({ conflicts: 1, replayed: false });
    expect(await stageBatch({ ...changedBatch, expectedCheckpoint: { rowid: '10' } })).toMatchObject({ conflicts: 1, replayed: true });

    const evidence = await pool.query(`SELECT o.status,o.normalized_digest,o.normalized_payload,o.batch_id,o.canonical_message_id,
      (SELECT count(*) FROM message_source_provenance p WHERE p.source_id=o.source_id AND p.observation_id=o.observation_id) AS provenance_count,
      (SELECT text_content FROM messages WHERE account_id=o.account_id AND message_id=o.canonical_message_id) AS canonical_text,
      (SELECT count(*) FROM external_source_conflicts c WHERE c.source_id=o.source_id AND c.generation=o.generation) AS conflicts,
      (SELECT batch_id FROM external_source_conflicts c WHERE c.source_id=o.source_id AND c.generation=o.generation) AS conflict_batch,
      (SELECT normalized_digest FROM external_source_conflicts c WHERE c.source_id=o.source_id AND c.generation=o.generation) AS conflict_digest,
      (SELECT normalized_payload FROM external_source_conflicts c WHERE c.source_id=o.source_id AND c.generation=o.generation) AS conflict_payload,
      (SELECT cursor FROM external_source_checkpoints WHERE source_id=o.source_id) AS checkpoint
      FROM external_source_observations o WHERE o.source_id=$1 AND o.observation_id='reused-row'`, [sourceId]);
    expect(evidence.rows[0]).toMatchObject({ status: 'PROJECTED', batch_id: 'original-batch', provenance_count: '1',
      canonical_text: 'original', conflicts: '1', conflict_batch: 'changed-batch', checkpoint: { rowid: '11' } });
    expect(evidence.rows[0]?.canonical_message_id).toMatch(/^ext1:[a-f0-9]{64}$/);
    expect(evidence.rows[0]?.conflict_digest).not.toBe(evidence.rows[0]?.normalized_digest);
    expect(evidence.rows[0]?.conflict_payload.text).toBe('changed [REDACTED_VERIFICATION_CODE] [REDACTED]');
  });

  it('keeps legacy MONITOR_ONLY distinct from EXTERNAL_MONITOR', async () => {
    const accounts = new AccountRepository(pool);
    await accounts.ensureAccount('legacy-monitor');
    await pool.query("UPDATE line_accounts SET mode='MONITOR_ONLY' WHERE account_id='legacy-monitor'");
    expect(await accounts.resolveCapabilities('legacy-monitor')).toMatchObject({ connectionMode: 'SYSTEM_LOGIN', canWriteLine: true });
  });

  it('fences legacy live single and batch ingress after the external source becomes selected', async () => {
    const accountId = 'external-live-fence';
    await createSource(accountId);
    const accounts = new AccountRepository(pool);
    await accounts.bindWorker({ accountId, workerInstanceId: 'legacy-worker', controlEpoch: 1 });
    const messages = new MessageRepository(pool);
    const envelope = { eventId: 'legacy-event', accountId, chatType: 'direct' as const, chatId: 'legacy-chat',
      senderId: 'sender', messageId: 'legacy-message', kind: 'text', text: 'must not project', mentionIds: [], mentionRanges: [],
      replyToMessageId: null, ingestion: { source: 'live' as const, cursor: 'legacy-cursor' },
      occurredAt: '2026-10-17T00:00:00Z', attachments: [], raw: {} };
    await expect(messages.ingestAndRoute(envelope, { eligible: true, provider: 'codex', prompt: 'send', workspacePath: 'C:\\safe' }))
      .rejects.toThrow('External monitor is read-only');
    await expect(messages.ingestBatchAndRoute({ type: 'batch', accountId, workerInstanceId: 'legacy-worker', controlEpoch: 1,
      batchId: 'legacy-batch', cursorBefore: { version: 1, revision: '0', globalRev: '0', individualRev: '0' },
      cursorAfter: { version: 1, revision: '1', globalRev: '0', individualRev: '0' }, envelopes: [envelope] },
    [{ eligible: true, provider: 'codex', prompt: 'send', workspacePath: 'C:\\safe' }])).rejects.toThrow('External monitor is read-only');
    expect((await pool.query("SELECT count(*) FROM messages WHERE account_id=$1", [accountId])).rows[0]?.count).toBe('0');
    expect((await pool.query("SELECT unread_count FROM conversations WHERE account_id=$1 AND chat_id='legacy-chat'", [accountId])).rows).toHaveLength(0);
    expect((await pool.query("SELECT count(*) FROM agent_jobs WHERE account_id=$1", [accountId])).rows[0]?.count).toBe('0');
  });

  it('rolls back staging and checkpoint when the batch exceeds its configured bound', async () => {
    const accountId = 'external-bounded';
    const { sourceId, generation } = await createSource(accountId);
    await stageBatch({ accountId, sourceId, generation, expectedCheckpoint: null, batchId: 'baseline', cursor: { rowid: '11' }, observations: [] });
    await expect(stageBatch({
      accountId, sourceId, generation, expectedCheckpoint: { rowid: '11' }, batchId: 'too-many', cursor: { rowid: '20' },
      observations: Array.from({ length: 101 }, (_, index) => ({ observationId: `row-${index}`, canonicalMessageId: `m-${index}`,
        chatType: 'direct' as const, chatId: 'chat-1', senderId: 'person-1', kind: 'text', text: 'x', occurredAt: '2026-10-17T00:00:00Z' })),
    })).rejects.toThrow('External observation batch exceeds limit');
    const checkpoint = await pool.query('SELECT cursor FROM external_source_checkpoints WHERE source_id=$1', [sourceId]);
    expect(checkpoint.rows[0]?.cursor).toEqual({ rowid: '11' });
  });

  it('rejects a complete oversized mention batch without stripping ranges or mutating import state', async () => {
    const accountId = 'external-oversized-mentions';
    const { sourceId, generation, modeRevision } = await createSource(accountId);
    const mentionRanges = Array.from({ length: 32 }, (_, index) => ({ start: index * 2, end: index * 2 + 1,
      userId: 'u'.repeat(128) }));
    const observations: ExternalObservationBatch['observations'] = Array.from({ length: 100 }, (_, index) => ({
      observationId: `oversized-mention-${index}`, canonicalMessageId: `native-oversized-mention-${index}`,
      chatType: 'direct' as const, chatId: 'oversized-mention-chat', senderId: 'sender', kind: 'text',
      text: 'x'.repeat(8_000), occurredAt: new Date(Date.UTC(2026, 9, 17, 0, index)).toISOString(), mentionRanges,
    }));

    await expect(stageBatch({ accountId, sourceId, generation, expectedCheckpoint: null,
      batchId: 'oversized-mention-batch', cursor: { rowid: '100' }, observations }))
      .rejects.toThrow('External observation batch exceeds limit');
    await expect(repository.commitDirectPoll({ accountId, sourceId, generation, expectedModeRevision: modeRevision,
      expectedCheckpoint: null, batchId: 'oversized-mention-direct-poll', cursor: { rowid: '100' },
      forwardObservations: observations, tailObservations: [] }))
      .rejects.toThrow('External observation batch exceeds limit');
    await expect(pool.query('SELECT count(*) FROM external_source_observations WHERE source_id=$1', [sourceId]))
      .resolves.toMatchObject({ rows: [{ count: '0' }] });
    await expect(pool.query('SELECT count(*) FROM messages WHERE account_id=$1', [accountId]))
      .resolves.toMatchObject({ rows: [{ count: '0' }] });
    await expect(pool.query('SELECT count(*) FROM external_source_checkpoints WHERE source_id=$1', [sourceId]))
      .resolves.toMatchObject({ rows: [{ count: '0' }] });
  });

  it('rejects a 2,001-row initial page while leaving its checkpoint untouched', async () => {
    const accountId = 'external-initial-over-2000';
    const { sourceId, generation, modeRevision } = await createSource(accountId);
    const observations: ExternalObservationBatch['observations'] = Array.from({ length: 2001 }, (_, index) => ({
      observationId: `initial-over-${index}`, canonicalMessageId: `native-initial-over-${index}`,
      chatType: 'direct' as const, chatId: 'chat', senderId: 'person', kind: 'text', text: 'x',
      occurredAt: new Date(Date.UTC(2026, 9, 17, 0, index)).toISOString(),
    }));
    await expect(repository.stageAndProjectBatch({ accountId, sourceId, generation, expectedModeRevision: modeRevision,
      expectedCheckpoint: {}, batchId: 'initial-over-2000', cursor: { rowid: '2001' }, initialImport: true, observations }))
      .rejects.toThrow('External observation batch exceeds limit');
    const state = await pool.query('SELECT count(*) FROM external_source_checkpoints WHERE source_id=$1', [sourceId]);
    expect(state.rows[0]?.count).toBe('0');
  });

  it('rolls back stage, projection, and checkpoint together after a canonical write fails', async () => {
    const accountId = 'external-atomic';
    const { sourceId, generation } = await createSource(accountId);
    await pool.query(`CREATE FUNCTION reject_external_projection() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN IF NEW.text_content='fail' THEN RAISE EXCEPTION 'forced projection failure'; END IF; RETURN NEW; END $$`);
    await pool.query(`CREATE TRIGGER reject_external_projection BEFORE INSERT ON messages
      FOR EACH ROW EXECUTE FUNCTION reject_external_projection()`);
    try {
      await expect(stageBatch({ accountId, sourceId, generation, expectedCheckpoint: null, batchId: 'atomic-failure', cursor: { rowid: '99' },
        observations: [
          { observationId: 'atomic-good', canonicalMessageId: 'would-have-projected', chatType: 'direct', chatId: 'chat', senderId: 'sender',
            kind: 'text', text: 'ok', occurredAt: '2026-10-17T00:00:00Z' },
          { observationId: 'atomic-bad', canonicalMessageId: 'force-failure', chatType: 'direct', chatId: 'chat', senderId: 'sender',
            kind: 'text', text: 'fail', occurredAt: '2026-10-17T00:00:00Z' },
        ] })).rejects.toThrow('forced projection failure');
      const state = await pool.query(`SELECT
        (SELECT count(*) FROM messages WHERE account_id=$1) AS messages,
        (SELECT count(*) FROM external_source_observations WHERE source_id=$2) AS observations,
        (SELECT count(*) FROM external_source_batches WHERE source_id=$2) AS batches,
        (SELECT count(*) FROM external_source_checkpoints WHERE source_id=$2) AS checkpoints`, [accountId, sourceId]);
      expect(state.rows[0]).toEqual({ messages: '0', observations: '0', batches: '0', checkpoints: '0' });
    } finally {
      await pool.query('DROP TRIGGER reject_external_projection ON messages');
      await pool.query('DROP FUNCTION reject_external_projection()');
    }
  });

  it('repairs several missing tail rows and provenance, keeps earlier rows, and makes a second fresh pass a no-op', async () => {
    const accountId = 'external-tail-repair';
    const { sourceId, generation } = await createSource(accountId);
    const earlier = { observationId: 'earlier-row', canonicalMessageId: 'native-earlier', chatType: 'direct' as const,
      chatId: 'native-chat-1', senderId: 'person', kind: 'text', text: 'earlier payload', occurredAt: '2026-10-16T00:00:00Z' };
    const tailRows = [
      { observationId: 'tail-row-1', canonicalMessageId: 'native-mid-7', chatType: 'direct' as const,
        chatId: 'native-chat-2', senderId: 'person', kind: 'text', text: 'tail payload one', occurredAt: '2026-10-17T00:00:00Z' },
      { observationId: 'tail-row-2', canonicalMessageId: 'native-mid-8', chatType: 'direct' as const,
        chatId: 'native-chat-2', senderId: 'person', kind: 'text', text: 'tail payload two', occurredAt: '2026-10-17T00:00:00Z' },
      { observationId: 'tail-row-3', canonicalMessageId: 'native-mid-9', chatType: 'direct' as const,
        chatId: 'native-chat-2', senderId: 'person', kind: 'text', text: 'tail payload three', occurredAt: '2026-10-17T00:00:00Z' },
    ];
    await stageBatch({ accountId, sourceId, generation, expectedCheckpoint: null, batchId: 'first', cursor: {
      history: { row: 40 }, highWater: { row: 70 },
    }, observations: [earlier, ...tailRows] });
    const checkpoint = { history: { row: 40 }, highWater: { row: 70 } };
    const canonicalIds = (await pool.query<{ observation_id: string; canonical_message_id: string }>(
      "SELECT observation_id,canonical_message_id FROM external_source_observations WHERE source_id=$1 AND observation_id LIKE 'tail-row-%' ORDER BY observation_id", [sourceId])).rows;
    const earlyBefore = await pool.query('SELECT * FROM messages WHERE account_id=$1 AND message_id=(SELECT canonical_message_id FROM external_source_observations WHERE source_id=$2 AND observation_id=$3)',
      [accountId, sourceId, earlier.observationId]);
    await pool.query('DELETE FROM message_source_provenance WHERE source_id=$1 AND observation_id=$2', [sourceId, 'tail-row-3']);
    await pool.query('DELETE FROM messages WHERE account_id=$1 AND message_id = ANY($2::text[])',
      [accountId, canonicalIds.slice(0, 2).map((row) => row.canonical_message_id)]);
    const tail = { accountId, sourceId, generation, expectedCheckpoint: checkpoint, batchId: 'fresh-tail-1', cursor: { ignored: true },
      tail: { marker: { capturedHead: 80, next: 2 } }, observations: tailRows };
    expect(await stageBatch(tail)).toMatchObject({ projected: 3, conflicts: 0, replayed: false });
    const expectedIds = canonicalIds.map((row) => row.canonical_message_id).sort();
    const repairedIds = (await pool.query<{ message_id: string }>(
      "SELECT message_id FROM messages WHERE account_id=$1 AND message_id=ANY($2::text[]) ORDER BY message_id", [accountId, expectedIds])).rows.map((row) => row.message_id);
    expect(repairedIds).toEqual(expectedIds);
    expect((await pool.query('SELECT * FROM messages WHERE account_id=$1 AND message_id=$2',
      [accountId, earlyBefore.rows[0].message_id])).rows[0]).toEqual(earlyBefore.rows[0]);
    expect((await pool.query("SELECT count(*) FROM message_source_provenance WHERE source_id=$1 AND observation_id=ANY($2::text[])",
      [sourceId, tailRows.map((row) => row.observationId)])).rows[0]?.count).toBe('3');
    await expect(stageBatch({ accountId, sourceId, generation, expectedCheckpoint: checkpoint, batchId: 'stale-ordinary-after-tail',
      cursor: { history: { row: 41 } }, observations: [] })).rejects.toThrow('predecessor checkpoint mismatch');
    const afterFirstTail = { ...checkpoint, tail: { capturedHead: 80, next: 2 } };
    expect(await stageBatch({ ...tail, expectedCheckpoint: afterFirstTail, batchId: 'fresh-tail-2',
      tail: { marker: { capturedHead: 80, next: 3 } } })).toMatchObject({ projected: 3, conflicts: 0, replayed: false });
    const restored = await pool.query(`SELECT c.cursor,
      (SELECT count(*) FROM messages WHERE account_id=$2 AND message_id=ANY($3::text[])) AS messages,
      (SELECT count(*) FROM message_source_provenance WHERE source_id=$1 AND observation_id=ANY($4::text[])) AS provenance
      FROM external_source_checkpoints c WHERE c.source_id=$1`, [sourceId, accountId, expectedIds, tailRows.map((row) => row.observationId)]);
    expect(restored.rows[0]).toEqual({ cursor: { ...checkpoint, tail: { capturedHead: 80, next: 3 } }, messages: '3', provenance: '3' });
  });

  it('rejects a stale tail predecessor and repairs a missing archive by upserting LINE fields', async () => {
    const accountId = 'external-tail-conflict';
    const { sourceId, generation } = await createSource(accountId);
    const observation = { observationId: 'tail-row', canonicalMessageId: 'native-mid-8', chatType: 'direct' as const,
      chatId: 'native-chat-3', senderId: 'person', kind: 'text', text: 'original', occurredAt: '2026-10-17T00:00:00Z' };
    await stageBatch({ accountId, sourceId, generation, expectedCheckpoint: null, batchId: 'first', cursor: { head: 10 }, observations: [observation] });
    await expect(stageBatch({ accountId, sourceId, generation, expectedCheckpoint: { head: 9 }, batchId: 'stale-tail', cursor: {},
      tail: { marker: { next: 1 } }, observations: [observation] })).rejects.toThrow('predecessor checkpoint mismatch');
    const id = (await pool.query<{ canonical_message_id: string }>(
      'SELECT canonical_message_id FROM external_source_observations WHERE source_id=$1 AND observation_id=$2', [sourceId, observation.observationId])).rows[0]!.canonical_message_id;
    await pool.query(`UPDATE messages SET event_id='app-owned-event',ingestion_source='live',reply_to_message_id='local-reply',
      mention_ids='["local-mention"]'::jsonb,raw='{"local":true}'::jsonb,text_content='operator-edited' WHERE account_id=$1 AND message_id=$2`, [accountId, id]);
    expect(await stageBatch({ accountId, sourceId, generation, expectedCheckpoint: { head: 10 }, batchId: 'fresh-tail', cursor: {},
      tail: { marker: { next: 1 } }, observations: [observation] })).toMatchObject({ conflicts: 0, projected: 1 });
    const state = await pool.query(`SELECT m.text_content,m.event_id,m.ingestion_source,m.reply_to_message_id,m.mention_ids,m.raw,
      (SELECT count(*) FROM external_source_conflicts c WHERE c.account_id=m.account_id AND c.canonical_message_id=m.message_id) AS conflicts
      FROM messages m WHERE m.account_id=$1 AND m.message_id=$2`, [accountId, id]);
    expect(state.rows[0]).toEqual({ text_content: 'original', event_id: 'app-owned-event', ingestion_source: 'live',
      reply_to_message_id: 'local-reply', mention_ids: ['local-mention'], raw: { local: true }, conflicts: '0' });
  });

  it('refreshes changed live content for the same stable LINE ID without conflicts and preserves app-owned fields', async () => {
    const accountId = 'external-live-changed-content';
    const { sourceId, generation } = await createSource(accountId);
    const original = { observationId: 'stable-source-row', canonicalMessageId: 'stable-native-id', chatType: 'direct' as const,
      chatId: 'stable-chat', senderId: 'sender-a', kind: 'text', text: 'before', occurredAt: '2026-10-17T00:00:00Z' };
    await stageBatch({ accountId, sourceId, generation, expectedCheckpoint: null, batchId: 'live-first',
      cursor: { rowid: '1' }, observations: [original] });
    const canonicalId = (await pool.query<{ canonical_message_id: string }>(
      'SELECT canonical_message_id FROM external_source_observations WHERE source_id=$1 AND observation_id=$2', [sourceId, original.observationId])).rows[0]!.canonical_message_id;
    await pool.query(`UPDATE messages SET event_id='operator-event',ingestion_source='live',reply_to_message_id='local-reply',
      mention_ids='["local"]'::jsonb,raw='{"local":true}'::jsonb WHERE account_id=$1 AND message_id=$2`, [accountId, canonicalId]);
    const updated = { ...original, senderId: 'sender-b', kind: 'event', text: 'after', occurredAt: '2026-10-18T00:00:00Z' };
    const modeRevision = sourceModeRevisions.get(sourceId)!;
    const second = await repository.commitDirectPoll({ accountId, sourceId, generation, expectedModeRevision: modeRevision,
      expectedCheckpoint: { rowid: '1' }, batchId: 'live-second', cursor: { rowid: '2' },
      forwardObservations: [updated], tailObservations: [] });
    expect(second).toMatchObject({ conflicts: 0, replayed: false, changedMessages: [{ chatType: 'direct', chatId: 'stable-chat', messageId: canonicalId }] });
    expect(await repository.commitDirectPoll({ accountId, sourceId, generation, expectedModeRevision: modeRevision,
      expectedCheckpoint: { rowid: '1' }, batchId: 'live-second', cursor: { rowid: '2' },
      forwardObservations: [updated], tailObservations: [] })).toMatchObject({ replayed: true, changedMessages: [] });
    const persisted = await pool.query(`SELECT m.sender_id,m.kind,m.text_content,m.occurred_at,m.event_id,m.ingestion_source,
      m.reply_to_message_id,m.mention_ids,m.raw,o.normalized_payload,o.batch_id,
      (SELECT count(*) FROM external_source_conflicts WHERE source_id=$1) AS conflicts
      FROM messages m JOIN external_source_observations o ON o.account_id=m.account_id AND o.canonical_message_id=m.message_id
      WHERE m.account_id=$2 AND m.message_id=$3`, [sourceId, accountId, canonicalId]);
    expect(persisted.rows[0]).toMatchObject({ sender_id: 'sender-b', kind: 'event', text_content: 'after', event_id: 'operator-event',
      ingestion_source: 'live', reply_to_message_id: 'local-reply', mention_ids: ['local'], raw: { local: true },
      normalized_payload: expect.objectContaining({ text: 'after', senderId: 'sender-b' }), batch_id: 'live-second', conflicts: '0' });
    expect(new Date(persisted.rows[0]!.occurred_at).toISOString()).toBe('2026-10-18T00:00:00.000Z');
  });

  it('keeps the native message ID stable when chat classification and native metadata change', async () => {
    const accountId = 'external-native-archive-stability';
    const { sourceId, generation, modeRevision } = await createSource(accountId);
    const original = {
      observationId: 'official-line-db:native-stable-message', canonicalMessageId: null,
      nativeConversationKind: 'midType:0', nativeConversationId: 'native-direct-chat', nativeMessageId: 'native-stable-message',
      chatType: 'direct', chatId: 'native-direct-chat', senderId: 'sender', kind: 'text', text: 'same body',
      occurredAt: '2026-10-17T00:00:00Z', conversationTitle: 'Direct title',
      nativeMetadata: { midType: 0, parentChatId: null, communityId: null }, nativeContentType: 0,
    };
    await stageBatch({ accountId, sourceId, generation, expectedCheckpoint: null, batchId: 'native-archive-initial',
      cursor: { rowid: '1' }, observations: [original as unknown as ExternalObservationBatch['observations'][number]] });

    const changed = { ...original, nativeConversationKind: 'midType:4', chatType: 'community',
      attachments: [{ id: 'native-community-file', kind: 'file' as const, name: 'community.txt', mimeType: 'text/plain', sizeBytes: 12, expiresAt: null }],
      conversationTitle: 'Community title', nativeMetadata: { midType: 4, parentChatId: null, communityId: 'native-community' } };
    await expect(repository.commitDirectPoll({ accountId, sourceId, generation, expectedModeRevision: modeRevision,
      expectedCheckpoint: { rowid: '1' }, batchId: 'native-archive-classification-update', cursor: { rowid: '2' },
      forwardObservations: [changed as unknown as ExternalObservationBatch['observations'][number]], tailObservations: [] }))
      .resolves.toMatchObject({ projected: 1, conflicts: 0 });

    const persisted = await pool.query(`SELECT m.message_id,m.chat_type,m.chat_id,c.title,c.native_metadata
      FROM messages m JOIN conversations c ON c.account_id=m.account_id AND c.chat_type=m.chat_type AND c.chat_id=m.chat_id
      WHERE m.account_id=$1 AND m.message_id=$2`, [accountId, 'native-stable-message']);
    expect(persisted.rows).toEqual([{ message_id: 'native-stable-message', chat_type: 'community',
      chat_id: 'native-direct-chat', title: 'Community title',
      native_metadata: { midType: 4, parentChatId: null, communityId: 'native-community' } }]);
    await expect(pool.query(`SELECT chat_type,chat_id,message_id,external_attachment_id,name,status
      FROM attachments WHERE account_id=$1 AND message_id='native-stable-message'`, [accountId]))
      .resolves.toMatchObject({ rows: [{ chat_type: 'community', chat_id: 'native-direct-chat',
        external_attachment_id: 'native-community-file', name: 'community.txt', status: 'queued' }] });
    expect((await pool.query('SELECT count(*) FROM messages WHERE account_id=$1 AND sender_id=$2', [accountId, 'sender'])).rows[0]?.count).toBe('1');

    const metadataOnly = { ...changed, conversationTitle: 'Updated community title',
      nativeMetadata: { midType: 4, parentChatId: 'parent-community', communityId: 'native-community' } };
    await expect(repository.commitDirectPoll({ accountId, sourceId, generation, expectedModeRevision: modeRevision,
      expectedCheckpoint: { rowid: '2' }, batchId: 'native-archive-metadata-only-tail', cursor: { rowid: '2' },
      forwardObservations: [], tailObservations: [metadataOnly as unknown as ExternalObservationBatch['observations'][number]] }))
      .resolves.toMatchObject({ tailRepaired: 1, changedMessages: [{ chatType: 'community', chatId: 'native-direct-chat', messageId: 'native-stable-message' }] });
    const messages = new MessageRepository(pool);
    await expect(messages.searchMessages({ accountId, key: { accountId, chatType: 'community', chatId: 'native-direct-chat' }, limit: 10 }))
      .resolves.toEqual([expect.objectContaining({ messageId: 'native-stable-message', chatType: 'community',
        chatId: 'native-direct-chat', conversationTitle: 'Updated community title', text: 'same body' })]);
    expect((await pool.query('SELECT count(*) FROM messages WHERE account_id=$1 AND message_id=$2', [accountId, 'native-stable-message']))
      .rows[0]?.count).toBe('1');
  });

  it('projects a mixed community and thread page with native metadata and a committed checkpoint', async () => {
    const accountId = 'external-native-mixed-page';
    const { sourceId, generation, modeRevision } = await createSource(accountId, {
      snapshotDigest: 'f'.repeat(64), schemaVersion: 'line-schema-v1', highWater: { createdTime: '2', id: 'native-thread-message' }, eligibleCount: '2',
    });
    const rows: ExternalObservationBatch['observations'] = [
      { observationId: 'official-line-db:native-community-message', canonicalMessageId: null,
        nativeConversationKind: 'midType:4', nativeConversationId: 'native-community', nativeMessageId: 'native-community-message',
        chatType: 'community', chatId: 'native-community', conversationTitle: 'Community',
        nativeMetadata: { midType: 4, parentChatId: null, communityId: 'native-community' }, nativeContentType: 0,
        senderId: 'sender', kind: 'text', text: 'community row', occurredAt: '2026-10-17T00:00:00Z',
        attachments: [{ id: 'native-community-attachment', kind: 'image', name: 'community.png', mimeType: 'image/png', sizeBytes: 32, expiresAt: null }] },
      { observationId: 'official-line-db:native-thread-message', canonicalMessageId: null,
        nativeConversationKind: 'midType:7', nativeConversationId: 'native-thread', nativeMessageId: 'native-thread-message',
        chatType: 'thread', chatId: 'native-thread', conversationTitle: 'Thread',
        nativeMetadata: { midType: 7, parentChatId: 'native-community', communityId: 'native-community' }, nativeContentType: 0,
        senderId: 'sender', kind: 'text', text: 'thread row', occurredAt: '2026-10-17T00:00:01Z',
        attachments: [{ id: 'native-thread-attachment', kind: 'file', name: 'thread.bin', mimeType: null, sizeBytes: null, expiresAt: null }] },
    ];
    await expect(repository.stageAndProjectBatch({ accountId, sourceId, generation, expectedModeRevision: modeRevision, expectedCheckpoint: {},
      batchId: 'native-mixed-first-page', cursor: { createdTime: '2', id: 'native-thread-message' }, initialImport: true, observations: rows }))
      .resolves.toMatchObject({ projected: 2, conflicts: 0, replayed: false });
    await expect(repository.getInitialImportState({ accountId, sourceId, generation }))
      .resolves.toMatchObject({ committedCount: '2', eligibleCount: '2', cursor: { createdTime: '2', id: 'native-thread-message' } });
    await expect(pool.query(`SELECT chat_type,chat_id,message_id,external_attachment_id,name,mime_type,size_bytes
      FROM attachments WHERE account_id=$1 ORDER BY chat_type`, [accountId])).resolves.toMatchObject({ rows: [
      { chat_type: 'community', chat_id: 'native-community', message_id: 'native-community-message',
        external_attachment_id: 'native-community-attachment', name: 'community.png', mime_type: 'image/png', size_bytes: '32' },
      { chat_type: 'thread', chat_id: 'native-thread', message_id: 'native-thread-message',
        external_attachment_id: 'native-thread-attachment', name: 'thread.bin', mime_type: null, size_bytes: null },
    ] });
    await expect(repository.stageAndProjectBatch({ accountId, sourceId, generation, expectedModeRevision: modeRevision, expectedCheckpoint: {},
      batchId: 'native-mixed-first-page', cursor: { createdTime: '2', id: 'native-thread-message' }, initialImport: true, observations: rows }))
      .resolves.toMatchObject({ replayed: true });
    expect((await pool.query('SELECT count(*) FROM attachments WHERE account_id=$1', [accountId])).rows[0]?.count).toBe('2');
    await expect(pool.query(`INSERT INTO attachments
      (account_id,chat_type,chat_id,message_id,external_attachment_id,kind,name,mime_type,size_bytes)
      VALUES ($1,'unsupported','native-thread','native-thread-message','bad-type','file','bad.bin','application/octet-stream',1)`, [accountId]))
      .rejects.toThrow();
    const messages = new MessageRepository(pool);
    await expect(messages.listMessages({ accountId, chatType: 'community', chatId: 'native-community' }, null, 10))
      .resolves.toMatchObject({ messages: [{ messageId: 'native-community-message', chatType: 'community', chatId: 'native-community' }] });
    await expect(messages.listMessages({ accountId, chatType: 'thread', chatId: 'native-thread' }, null, 10))
      .resolves.toMatchObject({ messages: [{ messageId: 'native-thread-message', chatType: 'thread', chatId: 'native-thread' }] });
    await expect(messages.searchMessages({ accountId, key: { accountId, chatType: 'community', chatId: 'native-community' }, limit: 10 }))
      .resolves.toEqual([expect.objectContaining({ conversationTitle: 'Community', text: 'community row' })]);
    await expect(messages.searchMessages({ accountId, key: { accountId, chatType: 'thread', chatId: 'native-thread' }, limit: 10 }))
      .resolves.toEqual([expect.objectContaining({ conversationTitle: 'Thread', text: 'thread row' })]);
  });

  it('keeps an unchanged live tail poll read-only and records changed tail fields without receipts', async () => {
    const accountId = 'external-live-tail-noop';
    const { sourceId, generation, modeRevision } = await createSource(accountId);
    const original = { observationId: 'tail-stable-row', canonicalMessageId: 'tail-stable-id', chatType: 'group' as const,
      chatId: 'tail-chat', senderId: 'sender-a', kind: 'text', text: 'tail-before', occurredAt: '2026-10-17T00:00:00Z' };
    await stageBatch({ accountId, sourceId, generation, expectedCheckpoint: null, batchId: 'tail-baseline', cursor: { rowid: '5' }, observations: [original] });
    const checkpoint = { rowid: '5' };
    const initialCounts = await pool.query(`SELECT
      (SELECT count(*) FROM external_source_batches WHERE source_id=$1) AS batches,
      (SELECT count(*) FROM external_source_observations WHERE source_id=$1) AS observations`, [sourceId]);
    const unchanged = await repository.commitDirectPoll({ accountId, sourceId, generation, expectedModeRevision: modeRevision,
      expectedCheckpoint: checkpoint, batchId: 'tail-idle', cursor: checkpoint, forwardObservations: [], tailObservations: [original] });
    expect(unchanged).toMatchObject({ staged: 0, tailRepaired: 0, changedMessages: [], replayed: false });
    const afterNoop = await pool.query(`SELECT c.cursor,
      (SELECT count(*) FROM external_source_batches WHERE source_id=$1) AS batches,
      (SELECT count(*) FROM external_source_observations WHERE source_id=$1) AS observations
      FROM external_source_checkpoints c WHERE c.source_id=$1`, [sourceId]);
    expect(afterNoop.rows[0]).toEqual({ cursor: checkpoint, batches: initialCounts.rows[0]?.batches, observations: initialCounts.rows[0]?.observations });

    const changed = { ...original, senderId: 'sender-b', kind: 'event', text: 'tail-after' };
    const liveResult = await repository.commitDirectPoll({ accountId, sourceId, generation, expectedModeRevision: modeRevision,
      expectedCheckpoint: checkpoint, batchId: 'tail-changed', cursor: checkpoint, forwardObservations: [], tailObservations: [changed] });
    expect(liveResult).toMatchObject({ tailRepaired: 1, changedMessages: [{ chatType: 'group', chatId: 'tail-chat' }] });
    const afterChange = await pool.query(`SELECT m.sender_id,m.kind,m.text_content,o.normalized_payload,c.cursor,
      (SELECT count(*) FROM external_source_batches WHERE source_id=$1) AS batches
      FROM messages m JOIN external_source_observations o ON o.account_id=m.account_id AND o.canonical_message_id=m.message_id
      JOIN external_source_checkpoints c ON c.source_id=$1 WHERE m.account_id=$2 AND o.observation_id=$3`,
    [sourceId, accountId, original.observationId]);
    expect(afterChange.rows[0]).toMatchObject({ sender_id: 'sender-b', kind: 'event', text_content: 'tail-after',
      normalized_payload: expect.objectContaining({ senderId: 'sender-b', text: 'tail-after' }), cursor: checkpoint,
      batches: String(Number(initialCounts.rows[0]?.batches) + 1) });
    expect(await repository.commitDirectPoll({ accountId, sourceId, generation, expectedModeRevision: modeRevision,
      expectedCheckpoint: checkpoint, batchId: 'tail-still-idle', cursor: checkpoint, forwardObservations: [], tailObservations: [changed] }))
      .toMatchObject({ tailRepaired: 0, changedMessages: [] });
  });

  it('imports an unseen backdated tail row with a receipt while keeping the forward cursor fixed', async () => {
    const accountId = 'external-live-backdated-tail';
    const { sourceId, generation, modeRevision } = await createSource(accountId);
    const checkpoint = { rowid: '200' };
    await stageBatch({ accountId, sourceId, generation, expectedCheckpoint: null, batchId: 'backdated-baseline', cursor: checkpoint, observations: [] });
    const backdated = { observationId: 'row-75', canonicalMessageId: 'native-row-75', chatType: 'direct' as const,
      chatId: 'backdated-chat', senderId: 'person', kind: 'text', text: 'arrived late', occurredAt: '2026-10-17T00:00:00Z' };
    const poll = { accountId, sourceId, generation, expectedModeRevision: modeRevision, expectedCheckpoint: checkpoint,
      batchId: 'backdated-tail-poll', cursor: checkpoint, forwardObservations: [], tailObservations: [backdated] };
    const result = await repository.commitDirectPoll(poll);
    expect(result).toMatchObject({ staged: 0, tailRepaired: 1, replayed: false, changedMessages: [{ chatId: 'backdated-chat' }] });
    const persisted = await pool.query(`SELECT c.cursor,
      (SELECT count(*) FROM messages WHERE account_id=$2 AND message_id=o.canonical_message_id) AS archive,
      (SELECT count(*) FROM message_source_provenance WHERE source_id=$1 AND observation_id=$3) AS provenance,
      o.batch_id FROM external_source_observations o JOIN external_source_checkpoints c ON c.source_id=o.source_id
      WHERE o.source_id=$1 AND o.observation_id=$3`, [sourceId, accountId, backdated.observationId]);
    expect(persisted.rows[0]).toEqual({ cursor: checkpoint, archive: '1', provenance: '1', batch_id: 'backdated-tail-poll' });
    expect(await repository.commitDirectPoll(poll)).toMatchObject({ replayed: true, changedMessages: [] });
  });

  it('tail-imports arrivals beyond page one, then advances through them without duplicate notifications', async () => {
    const accountId = 'external-live-over-100';
    const { sourceId, generation, modeRevision } = await createSource(accountId);
    const base = { rowid: '0' };
    await stageBatch({ accountId, sourceId, generation, expectedCheckpoint: null, batchId: 'over-100-baseline', cursor: base, observations: [] });
    const observations = Array.from({ length: 150 }, (_, index) => ({ observationId: `arrival-${index + 1}`,
      canonicalMessageId: `native-arrival-${index + 1}`, chatType: 'group' as const, chatId: 'arrival-chat',
      senderId: 'person', kind: 'text', text: `message-${index + 1}`, occurredAt: '2026-10-18T00:00:00Z' }));
    const firstPage = await repository.commitDirectPoll({ accountId, sourceId, generation, expectedModeRevision: modeRevision,
      expectedCheckpoint: base, batchId: 'over-100-page-one', cursor: { rowid: '100' },
      forwardObservations: observations.slice(0, 100), tailObservations: observations.slice(100) });
    expect(firstPage).toMatchObject({ staged: 100, tailRepaired: 50, conflicts: 0, changedMessages: expect.any(Array) });
    expect((await pool.query('SELECT cursor FROM external_source_checkpoints WHERE source_id=$1', [sourceId])).rows[0]?.cursor)
      .toEqual({ rowid: '100' });
    const secondPage = await repository.commitDirectPoll({ accountId, sourceId, generation, expectedModeRevision: modeRevision,
      expectedCheckpoint: { rowid: '100' }, batchId: 'over-100-page-two', cursor: { rowid: '150' },
      forwardObservations: observations.slice(100), tailObservations: observations.slice(100) });
    expect(secondPage).toMatchObject({ staged: 50, tailRepaired: 0, conflicts: 0, changedMessages: [] });
    const persisted = await pool.query(`SELECT c.cursor,
      (SELECT count(*) FROM external_source_observations WHERE source_id=$1) AS observations,
      (SELECT count(*) FROM messages WHERE account_id=$2) AS messages,
      (SELECT count(*) FROM message_source_provenance WHERE source_id=$1) AS provenance
      FROM external_source_checkpoints c WHERE c.source_id=$1`, [sourceId, accountId]);
    expect(persisted.rows[0]).toEqual({ cursor: { rowid: '150' }, observations: '150', messages: '150', provenance: '150' });
  });

  it('upserts attachments in the forward poll transaction for first and changed observations', async () => {
    const accountId = 'external-live-attachments-first-and-changed';
    const { sourceId, generation, modeRevision } = await createSource(accountId);
    await stageBatch({ accountId, sourceId, generation, expectedCheckpoint: null,
      batchId: 'live-attachments-baseline', cursor: { rowid: '0' }, observations: [] });
    const observations = Array.from({ length: 55 }, (_, index) => ({ observationId: `attachment-forward-${index}`,
      canonicalMessageId: `attachment-native-${index}`, nativeMessageId: `attachment-native-${index}`, chatType: 'group' as const, chatId: 'attachment-room',
      senderId: 'person', kind: index === 0 ? 'image' : 'text', text: null, occurredAt: '2026-10-18T00:00:00Z',
      ...(index === 0 ? { attachments: [{ id: 'attachment-native-0', kind: 'image' as const,
        name: 'first.png', mimeType: null, sizeBytes: 12, expiresAt: null }] } : {}) }));
    const first = await repository.commitDirectPoll({ accountId, sourceId, generation, expectedModeRevision: modeRevision,
      expectedCheckpoint: { rowid: '0' }, batchId: 'live-attachments-forward-first', cursor: { rowid: '55' },
      forwardObservations: observations, tailObservations: [] });
    expect(first).toMatchObject({ staged: 55, projected: 55, tailRepaired: 0 });
    const messages = new MessageRepository(pool);
    const firstAttachment = await messages.getAttachmentBySource({ accountId, chatType: 'group', chatId: 'attachment-room' },
      'attachment-native-0', 'attachment-native-0');
    expect(firstAttachment).toMatchObject({ status: 'queued', name: 'first.png', sizeBytes: 12, externalSource: true });

    const changed = { ...observations[0]!, attachments: [{ id: 'attachment-native-0', kind: 'image' as const,
      name: 'changed.png', mimeType: null, sizeBytes: 22, expiresAt: null }] };
    await repository.commitDirectPoll({ accountId, sourceId, generation, expectedModeRevision: modeRevision,
      expectedCheckpoint: { rowid: '55' }, batchId: 'live-attachments-forward-changed', cursor: { rowid: '56' },
      forwardObservations: [changed], tailObservations: [] });
    await expect(messages.getAttachmentBySource({ accountId, chatType: 'group', chatId: 'attachment-room' },
      'attachment-native-0', 'attachment-native-0')).resolves.toMatchObject({ name: 'changed.png', sizeBytes: 22 });
  });

  it('rolls back the live forward page and cursor when tail reconciliation fails', async () => {
    const accountId = 'external-live-poll-atomic';
    const { sourceId, generation, modeRevision } = await createSource(accountId);
    const tail = { observationId: 'atomic-tail-row', canonicalMessageId: 'atomic-tail-id', chatType: 'direct' as const,
      chatId: 'atomic-chat', senderId: 'person', kind: 'text', text: 'tail-before', occurredAt: '2026-10-17T00:00:00Z' };
    await stageBatch({ accountId, sourceId, generation, expectedCheckpoint: null, batchId: 'atomic-baseline', cursor: { rowid: '1' }, observations: [tail] });
    const forward = { observationId: 'atomic-forward-row', canonicalMessageId: 'atomic-forward-id', chatType: 'direct' as const,
      chatId: 'atomic-chat', senderId: 'person', kind: 'text', text: 'forward-insert', occurredAt: '2026-10-18T00:00:00Z' };
    const unseenTail = { observationId: 'atomic-unseen-tail', canonicalMessageId: 'atomic-unseen-tail-id', chatType: 'direct' as const,
      chatId: 'atomic-chat', senderId: 'person', kind: 'text', text: 'tail-fail', occurredAt: '2026-10-17T00:00:00Z' };
    await pool.query(`CREATE FUNCTION reject_live_tail_update() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN IF NEW.text_content='tail-fail' THEN RAISE EXCEPTION 'forced live tail failure'; END IF; RETURN NEW; END $$`);
    await pool.query('CREATE TRIGGER reject_live_tail_update BEFORE INSERT OR UPDATE ON messages FOR EACH ROW EXECUTE FUNCTION reject_live_tail_update()');
    try {
      await expect(repository.commitDirectPoll({ accountId, sourceId, generation, expectedModeRevision: modeRevision,
        expectedCheckpoint: { rowid: '1' }, batchId: 'atomic-live-poll', cursor: { rowid: '2' }, forwardObservations: [forward],
        tailObservations: [unseenTail] })).rejects.toThrow('forced live tail failure');
      const state = await pool.query(`SELECT c.cursor,
        (SELECT count(*) FROM messages WHERE account_id=$2 AND message_id=(SELECT canonical_message_id FROM external_source_observations WHERE source_id=$1 AND observation_id=$3)) AS forward_message,
        (SELECT count(*) FROM external_source_observations WHERE source_id=$1 AND observation_id=$3) AS forward_observation,
        (SELECT count(*) FROM external_source_batches WHERE source_id=$1 AND batch_id='atomic-live-poll') AS batch,
        (SELECT count(*) FROM external_source_observations WHERE source_id=$1 AND observation_id=$4) AS unseen_tail_observation,
        (SELECT text_content FROM messages WHERE account_id=$2 AND message_id=(SELECT canonical_message_id FROM external_source_observations WHERE source_id=$1 AND observation_id=$5)) AS tail_text
        FROM external_source_checkpoints c WHERE c.source_id=$1`, [sourceId, accountId, forward.observationId, unseenTail.observationId, tail.observationId]);
      expect(state.rows[0]).toEqual({ cursor: { rowid: '1' }, forward_message: '0', forward_observation: '0', batch: '0', unseen_tail_observation: '0', tail_text: 'tail-before' });
    } finally {
      await pool.query('DROP TRIGGER reject_live_tail_update ON messages');
      await pool.query('DROP FUNCTION reject_live_tail_update()');
    }
  });

  it('rolls back a partially attempted tail repair when a later canonical insert fails', async () => {
    const accountId = 'external-tail-atomic';
    const { sourceId, generation, modeRevision } = await createSource(accountId);
    const observations = [
      { observationId: 'repair-first', canonicalMessageId: 'native-first', chatType: 'direct' as const,
        chatId: 'tail-chat', senderId: 'person', kind: 'text', text: 'restorable', occurredAt: '2026-10-17T00:00:00Z' },
      { observationId: 'repair-fail', canonicalMessageId: 'native-fail', chatType: 'direct' as const,
        chatId: 'tail-chat', senderId: 'person', kind: 'text', text: 'force-failure', occurredAt: '2026-10-17T00:00:00Z' },
    ];
    await stageBatch({ accountId, sourceId, generation, expectedCheckpoint: null, batchId: 'initial', cursor: { head: 12 }, observations });
    const ids = (await pool.query<{ canonical_message_id: string }>(
      "SELECT canonical_message_id FROM external_source_observations WHERE source_id=$1 AND observation_id=ANY($2::text[]) ORDER BY observation_id",
      [sourceId, observations.map((row) => row.observationId)])).rows.map((row) => row.canonical_message_id);
    await pool.query('DELETE FROM messages WHERE account_id=$1 AND message_id=ANY($2::text[])', [accountId, ids]);
    await pool.query(`CREATE FUNCTION reject_second_tail_repair() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN IF NEW.text_content='force-failure' THEN RAISE EXCEPTION 'forced tail repair failure'; END IF; RETURN NEW; END $$`);
    await pool.query('CREATE TRIGGER reject_second_tail_repair BEFORE INSERT ON messages FOR EACH ROW EXECUTE FUNCTION reject_second_tail_repair()');
    try {
      await expect(stageBatch({ accountId, sourceId, generation, expectedCheckpoint: { head: 12 }, batchId: 'repair-attempt', cursor: {},
        tail: { marker: { capturedHead: 13, next: 2 } }, observations })).rejects.toThrow('forced tail repair failure');
      const state = await pool.query(`SELECT
        (SELECT count(*) FROM messages WHERE account_id=$1 AND message_id=ANY($2::text[])) AS messages,
        (SELECT count(*) FROM message_source_provenance WHERE source_id=$3 AND observation_id=ANY($4::text[])) AS provenance,
        (SELECT count(*) FROM external_source_batches WHERE source_id=$3 AND batch_id='repair-attempt') AS batch,
        (SELECT cursor FROM external_source_checkpoints WHERE source_id=$3) AS cursor`,
      [accountId, ids, sourceId, observations.map((row) => row.observationId)]);
      expect(state.rows[0]).toEqual({ messages: '0', provenance: '0', batch: '0', cursor: { head: 12 } });
    } finally {
      await pool.query('DROP TRIGGER reject_second_tail_repair ON messages');
      await pool.query('DROP FUNCTION reject_second_tail_repair()');
    }
  });

  it('keeps ext1 IDs stable across source reselection, separates accounts, and distinguishes reused native IDs by conversation', async () => {
    const firstAccount = 'external-key-account-a';
    const firstSource = await createSource(firstAccount);
    const firstConversation = { observationId: 'same-native-a', canonicalMessageId: 'reused-native-mid', chatType: 'direct' as const,
      chatId: 'conversation-a', senderId: 'person', kind: 'text', text: 'same timestamp', occurredAt: '2026-10-17T00:00:00Z' };
    const secondConversation = { ...firstConversation, observationId: 'same-native-b', chatId: 'conversation-b' };
    await stageBatch({ accountId: firstAccount, sourceId: firstSource.sourceId, generation: firstSource.generation,
      expectedCheckpoint: null, batchId: 'initial-key-batch', cursor: { head: 1 }, observations: [firstConversation, secondConversation] });
    const firstIds = (await pool.query<{ observation_id: string; canonical_message_id: string }>(
      'SELECT observation_id,canonical_message_id FROM external_source_observations WHERE source_id=$1 ORDER BY observation_id',
      [firstSource.sourceId])).rows;
    expect(firstIds[0]?.canonical_message_id).not.toBe(firstIds[1]?.canonical_message_id);
    expect(firstIds.every((row) => /^ext1:[a-f0-9]{64}$/.test(row.canonical_message_id))).toBe(true);

    const secondAccount = 'external-key-account-b';
    const secondSource = await createSource(secondAccount);
    await stageBatch({ accountId: secondAccount, sourceId: secondSource.sourceId, generation: secondSource.generation,
      expectedCheckpoint: null, batchId: 'account-b-key-batch', cursor: { head: 1 }, observations: [firstConversation] });
    const accountBId = (await pool.query<{ canonical_message_id: string }>(
      'SELECT canonical_message_id FROM external_source_observations WHERE source_id=$1 AND observation_id=$2',
      [secondSource.sourceId, firstConversation.observationId])).rows[0]?.canonical_message_id;
    expect(accountBId).toBe(firstIds.find((row) => row.observation_id === firstConversation.observationId)?.canonical_message_id);
    expect((await pool.query('SELECT count(*) FROM messages WHERE message_id=$1', [accountBId])).rows[0]?.count).toBe('2');
    expect((await pool.query('SELECT count(*) FROM messages WHERE account_id=$1 AND message_id=$2', [firstAccount, accountBId])).rows[0]?.count).toBe('1');
    expect((await pool.query('SELECT count(*) FROM messages WHERE account_id=$1 AND message_id=$2', [secondAccount, accountBId])).rows[0]?.count).toBe('1');

    const agentAccountId = 'external-test-agent';
    await pool.query("UPDATE line_accounts SET product_role=NULL WHERE account_id=$1", [secondAccount]);
    await pool.query("UPDATE line_accounts SET product_role='PRIMARY_ADMIN' WHERE account_id=$1", [firstAccount]);
    await pool.query("DELETE FROM account_administrators WHERE account_id=$1 AND role='PRIMARY_ADMIN'", [agentAccountId]);
    await pool.query(`INSERT INTO account_administrators(account_id,chat_type,chat_id,user_id,role)
      VALUES ($1,'direct','external-admin-chat',$2,'PRIMARY_ADMIN')`, [agentAccountId, `verified-mid-${firstAccount}`]);
    const reselected = await repository.bindVerifiedExternalSource({
      accountId: firstAccount, ownMid: `verified-mid-${firstAccount}`, sourceIdentity: 'official-db-profile-a-reselected',
    });
    sourceModeRevisions.set(reselected.sourceId, reselected.modeRevision);
    await stageBatch({ accountId: firstAccount, sourceId: reselected.sourceId, generation: reselected.generation,
      expectedCheckpoint: null, batchId: 'reselected-source-batch', cursor: { head: 1 }, observations: [firstConversation] });
    const reselectedEvidence = await pool.query(`SELECT
      (SELECT count(*) FROM messages WHERE account_id=$1 AND message_id=$2) AS archive_rows,
      (SELECT count(*) FROM message_source_provenance WHERE account_id=$1 AND message_id=$2) AS source_proofs`,
    [firstAccount, firstIds.find((row) => row.observation_id === firstConversation.observationId)?.canonical_message_id]);
    expect(reselectedEvidence.rows[0]).toEqual({ archive_rows: '1', source_proofs: '2' });
  });

  describe('native directory pages (friend names and conversation titles)', () => {
    const metadata = { midType: 0, parentChatId: null, communityId: null };
    const contact = (mid: string, displayName: string | null, nickname: string | null) =>
      ({ kind: 'contact' as const, mid, displayName, nickname, type: 0, status: 1 });
    const chat = (chatId: string, title: string | null, chatType: 'direct' | 'group' = 'direct', picturePath?: string | null) =>
      ({ kind: 'conversation' as const, chatId, chatType, title, ...(picturePath === undefined ? {} : { picturePath }), nativeMetadata: metadata });

    it('stores native pictures on contacts and conversations while keeping known pictures on null refreshes', async () => {
      const accountId = 'external-directory-pictures';
      const { sourceId, generation, modeRevision } = await createSource(accountId);
      const input = { accountId, sourceId, generation, expectedModeRevision: modeRevision, rows: [
        { ...contact('u-photo', 'Photo Friend', null), picturePath: '/friend-photo' },
        chat('u-photo', 'Photo Friend', 'direct'), chat('g-photo', 'Photo Group', 'group', 'abcdefghijklmnop'),
      ] };
      await repository.storeNativeDirectoryPage(input);
      expect((await pool.query('SELECT mid,picture_path FROM line_contacts WHERE account_id=$1', [accountId])).rows)
        .toEqual([{ mid: 'u-photo', picture_path: 'https://profile.line-scdn.net/friend-photo' }]);
      expect((await pool.query("SELECT chat_id,picture_path FROM conversations WHERE account_id=$1 AND chat_id IN ('u-photo','g-photo') ORDER BY chat_id", [accountId])).rows)
        .toEqual([{ chat_id: 'g-photo', picture_path: 'https://obs.line-scdn.net/abcdefghijklmnop' },
          { chat_id: 'u-photo', picture_path: 'https://profile.line-scdn.net/friend-photo' }]);
      await repository.storeNativeDirectoryPage({ ...input, rows: [contact('u-photo', 'Photo Friend', null), chat('u-photo', null), chat('g-photo', null, 'group')] });
      expect((await pool.query('SELECT mid,picture_path FROM line_contacts WHERE account_id=$1', [accountId])).rows[0]?.picture_path)
        .toBe('https://profile.line-scdn.net/friend-photo');
      expect((await pool.query("SELECT chat_id,picture_path FROM conversations WHERE account_id=$1 AND chat_id IN ('u-photo','g-photo') ORDER BY chat_id", [accountId])).rows.map((row) => row.picture_path))
        .toEqual(['https://obs.line-scdn.net/abcdefghijklmnop', 'https://profile.line-scdn.net/friend-photo']);
    });

    it('resolves direct pictures from persisted contacts across pages and updates them after more than 500 contact rows', async () => {
      const accountId = 'external-directory-cross-page-picture';
      const { sourceId, generation, modeRevision } = await createSource(accountId);
      await repository.storeNativeDirectoryPage({ accountId, sourceId, generation, expectedModeRevision: modeRevision,
        rows: [contact('u-late', null, null), ...Array.from({ length: 500 }, (_, index) => contact(`u-${index}`, null, null))]
          .map((row) => row.mid === 'u-late' ? { ...row, picturePath: '/late-picture' } : row) });
      await repository.storeNativeDirectoryPage({ accountId, sourceId, generation, expectedModeRevision: modeRevision,
        rows: [chat('u-late', null)] });
      expect((await pool.query('SELECT picture_path FROM conversations WHERE account_id=$1 AND chat_id=$2', [accountId, 'u-late'])).rows[0]?.picture_path)
        .toBe('https://profile.line-scdn.net/late-picture');
      await repository.storeNativeDirectoryPage({ accountId, sourceId, generation, expectedModeRevision: modeRevision,
        rows: [{ ...contact('u-late', null, null), picturePath: '/updated-picture' }] });
      await repository.storeNativeDirectoryPage({ accountId, sourceId, generation, expectedModeRevision: modeRevision,
        rows: [chat('u-late', null)] });
      expect((await pool.query('SELECT picture_path FROM conversations WHERE account_id=$1 AND chat_id=$2', [accountId, 'u-late'])).rows[0]?.picture_path)
        .toBe('https://profile.line-scdn.net/updated-picture');
    });

    it('stores contacts and computed titles in one idempotent transaction, creating conversations that have no messages yet', async () => {
      const accountId = 'external-directory-page';
      const { sourceId, generation, modeRevision } = await createSource(accountId);
      const input = { accountId, sourceId, generation, expectedModeRevision: modeRevision, rows: [
        contact('u-nick', 'Real Name', '張襄君'), contact('u-plain', 'Plain', null), chat('u-nick', '張襄君'),
        chat('u-plain', 'Plain'), chat('u-unknown', null), chat('g-1', 'Group One', 'group'),
      ] };
      expect(await repository.storeNativeDirectoryPage(input)).toEqual({ contacts: 2, contactsChanged: 2, conversationsChanged: 4 });
      expect((await pool.query('SELECT mid,display_name,nickname,native_type,native_status FROM line_contacts WHERE account_id=$1 ORDER BY mid', [accountId])).rows)
        .toEqual([{ mid: 'u-nick', display_name: 'Real Name', nickname: '張襄君', native_type: 0, native_status: 1 },
          { mid: 'u-plain', display_name: 'Plain', nickname: null, native_type: 0, native_status: 1 }]);
      expect((await pool.query("SELECT chat_id,chat_type,title FROM conversations WHERE account_id=$1 AND chat_id <> '__local_agent_room__' ORDER BY chat_id", [accountId])).rows)
        .toEqual([{ chat_id: 'g-1', chat_type: 'group', title: 'Group One' }, { chat_id: 'u-nick', chat_type: 'direct', title: '張襄君' },
          { chat_id: 'u-plain', chat_type: 'direct', title: 'Plain' }, { chat_id: 'u-unknown', chat_type: 'direct', title: '' }]);
      // Replaying the same page changes nothing.
      expect(await repository.storeNativeDirectoryPage(input)).toEqual({ contacts: 2, contactsChanged: 0, conversationsChanged: 0 });
      // A rename overwrites the stale title for a chat that has no new message; an empty title never blanks it.
      expect(await repository.storeNativeDirectoryPage({ ...input, rows: [contact('u-plain', 'Plain', 'Pal'), chat('u-plain', 'Pal'), chat('u-nick', null)] }))
        .toMatchObject({ contactsChanged: 1, conversationsChanged: 1 });
      expect((await pool.query("SELECT title FROM conversations WHERE account_id=$1 AND chat_id IN ('u-plain','u-nick') ORDER BY chat_id", [accountId])).rows)
        .toEqual([{ title: '張襄君' }, { title: 'Pal' }]);
      // Page one keeps its message progress untouched.
      await expect(repository.readBatchFence({ accountId, sourceId, generation })).resolves.toEqual({ expectedModeRevision: modeRevision, expectedCheckpoint: null });
    });

    it('rejects a directory page without source authority and writes nothing', async () => {
      const accountId = 'external-directory-stale';
      const { sourceId, generation, modeRevision } = await createSource(accountId);
      const rows = [contact('u-stale', 'Stale', null), chat('u-stale', 'Stale')];
      await expect(repository.storeNativeDirectoryPage({ accountId, sourceId, generation, expectedModeRevision: modeRevision + 1, rows }))
        .rejects.toThrow('External source authority is stale');
      await pool.query("UPDATE line_accounts SET source_transition_state='CANDIDATE_CHECKED' WHERE account_id=$1", [accountId]);
      await expect(repository.storeNativeDirectoryPage({ accountId, sourceId, generation, expectedModeRevision: modeRevision, rows }))
        .rejects.toThrow('External source authority is stale');
      await pool.query("UPDATE line_accounts SET source_transition_state='STABLE',connection_mode='SYSTEM_LOGIN' WHERE account_id=$1", [accountId]);
      await expect(repository.storeNativeDirectoryPage({ accountId, sourceId, generation, expectedModeRevision: modeRevision, rows }))
        .rejects.toThrow('External source authority is stale');
      expect((await pool.query('SELECT count(*) FROM line_contacts WHERE account_id=$1', [accountId])).rows[0]?.count).toBe('0');
      expect((await pool.query("SELECT count(*) FROM conversations WHERE account_id=$1 AND chat_id <> '__local_agent_room__'", [accountId])).rows[0]?.count).toBe('0');
    });

    it('rejects malformed or oversized pages before touching the database', async () => {
      const accountId = 'external-directory-invalid';
      const { sourceId, generation, modeRevision } = await createSource(accountId);
      await expect(repository.storeNativeDirectoryPage({ accountId, sourceId, generation, expectedModeRevision: modeRevision,
        rows: [{ kind: 'contact', mid: '', displayName: 'x', nickname: null, type: 0, status: 1 }] as never })).rejects.toThrow();
      await expect(repository.storeNativeDirectoryPage({ accountId, sourceId, generation, expectedModeRevision: modeRevision,
        rows: Array.from({ length: 2001 }, (_, index) => contact(`u-${index}`, 'x', null)) })).rejects.toThrow('row limit');
    });

    it('keeps the same MID under two accounts with independent nicknames', async () => {
      const first = await createSource('external-directory-iso-a');
      await repository.storeNativeDirectoryPage({ accountId: 'external-directory-iso-a', sourceId: first.sourceId, generation: first.generation,
        expectedModeRevision: first.modeRevision, rows: [contact('u-same', 'Same', 'Nick A')] });
      const second = await createSource('external-directory-iso-b');
      await repository.storeNativeDirectoryPage({ accountId: 'external-directory-iso-b', sourceId: second.sourceId, generation: second.generation,
        expectedModeRevision: second.modeRevision, rows: [contact('u-same', 'Same', 'Nick B')] });
      expect((await pool.query("SELECT account_id,nickname FROM line_contacts WHERE mid='u-same' AND account_id LIKE 'external-directory-iso-%' ORDER BY account_id")).rows)
        .toEqual([{ account_id: 'external-directory-iso-a', nickname: 'Nick A' }, { account_id: 'external-directory-iso-b', nickname: 'Nick B' }]);
    });
  });
  describe('recall snapshot and source-deletion detection', () => {
    const T0 = Date.parse('2026-10-22T00:00:00Z');
    const obs = (id: string, index: number, text: string | null = `text ${id}`, extra: Record<string, unknown> = {}) => ({
      observationId: `official-line-db:${id}`, canonicalMessageId: id, nativeMessageId: id, chatType: 'direct' as const,
      chatId: 'del-chat', senderId: 'del-sender', kind: 'text', text, occurredAt: new Date(T0 + index * 1000).toISOString(),
      nativeContentType: 0, ...extra });
    const cur = (id: string, index: number) => ({ createdTime: String(T0 + index * 1000), id });
    const raw = async (accountId: string, id: string) => (await pool.query<{ raw: Record<string, unknown> }>(
      'SELECT raw FROM messages WHERE account_id=$1 AND message_id=$2', [accountId, id])).rows[0]!.raw;
    type Obs = ExternalObservationBatch['observations'];
    async function seed(accountId: string, count: number) {
      const source = await createSource(accountId);
      const observations = Array.from({ length: count }, (_, i) => obs(`m${i + 1}`, i + 1));
      await stageBatch({ accountId, sourceId: source.sourceId, generation: source.generation, expectedCheckpoint: null,
        batchId: `${accountId}-seed`, cursor: { rowid: String(count) }, observations: observations as unknown as Obs });
      let batch = 0;
      const poll = (tailWindow: unknown, tail: unknown[] = []) => repository.commitDirectPoll({ accountId, sourceId: source.sourceId,
        generation: source.generation, expectedModeRevision: source.modeRevision, expectedCheckpoint: { rowid: String(count) },
        batchId: `${accountId}-poll-${++batch}`, cursor: { rowid: String(count) }, forwardObservations: [],
        tailObservations: tail as unknown as Obs,
        ...(tailWindow === undefined ? {} : { tailWindow: tailWindow as never }) });
      return { ...source, poll, deleted: async () => (await pool.query<{ message_id: string }>(
        "SELECT message_id FROM messages WHERE account_id=$1 AND raw ? 'sourceDeleted' ORDER BY message_id", [accountId])).rows.map((r) => r.message_id) };
    }

    it('keeps the pre-recall native snapshot once and never overwrites it', async () => {
      const accountId = 'recall-original-snapshot';
      const { sourceId, generation, modeRevision } = await createSource(accountId);
      const original = obs('r1', 1, 'before', { nativePayload: plainEnvelope({ _id: 'r1', _contentType: 0, _text: 'before' }) });
      await stageBatch({ accountId, sourceId, generation, expectedCheckpoint: null, batchId: 'recall-seed', cursor: { rowid: '1' },
        observations: [original] as unknown as Obs });
      const recalled = (digest: string) => ({ ...obs('r1', 1, null), nativePayload: { ...plainEnvelope({ _id: 'r1', _contentType: 0,
        _text: '', _contentMetadata: JSON.stringify({ UNSENT: true }) }), sourceDigest: digest } });
      const run = (batchId: string, row: unknown) => repository.commitDirectPoll({ accountId, sourceId, generation,
        expectedModeRevision: modeRevision, expectedCheckpoint: { rowid: '1' }, batchId, cursor: { rowid: '1' }, forwardObservations: [],
        tailObservations: [row] as unknown as Obs });
      await run('recall-1', recalled('b'.repeat(64)));
      const first = await raw(accountId, 'r1');
      expect(first.recall).toMatchObject({ original: original.nativePayload, recalledAt: expect.any(String) });
      expect((first.native as { sourceDigest: string }).sourceDigest).toBe('b'.repeat(64));
      await run('recall-2', recalled('c'.repeat(64)));
      const second = await raw(accountId, 'r1');
      expect(second.recall).toEqual(first.recall);
      expect((second.native as { sourceDigest: string }).sourceDigest).toBe('c'.repeat(64));
      expect(await run('recall-3', recalled('c'.repeat(64)))).toMatchObject({ tailRepaired: 0, changedMessages: [] });
    });

    it('does not capture a snapshot for a first-seen recalled row or a dpapi envelope', async () => {
      const accountId = 'recall-no-capture';
      const { sourceId, generation, modeRevision } = await createSource(accountId);
      const late = obs('n1', 1, null, { nativePayload: plainEnvelope({ _id: 'n1', _contentType: 0, _text: '', _contentMetadata: JSON.stringify({ UNSENT: true }) }) });
      const legacy = obs('n2', 2, 'x', { nativePayload: dpapiEnvelope('d'.repeat(64)) });
      await stageBatch({ accountId, sourceId, generation, expectedCheckpoint: null, batchId: 'nocap-seed', cursor: { rowid: '2' },
        observations: [late, legacy] as unknown as Obs });
      const recalledPlain = { ...obs('n2', 2, null), nativePayload: plainEnvelope({ _id: 'n2', _contentType: 0, _text: '',
        _contentMetadata: JSON.stringify({ UNSENT: true }) }) };
      await repository.commitDirectPoll({ accountId, sourceId, generation, expectedModeRevision: modeRevision, expectedCheckpoint: { rowid: '2' },
        batchId: 'nocap-poll', cursor: { rowid: '2' }, forwardObservations: [], tailObservations: [recalledPlain] as unknown as Obs });
      expect((await raw(accountId, 'n1')).recall).toBeUndefined();
      expect((await raw(accountId, 'n2')).recall).toBeUndefined();
    });

    it('marks only in-range missing rows, never the lower-boundary millisecond, and is idempotent', async () => {
      const seeded = await seed('del-range', 6);
      // Range (m2, m5]: m1 and m2 are outside (m2 sits on the lower ms); m6 is above the bound. Missing in range: m3 and m4.
      const window = { upper: cur('m5', 5), lower: cur('m2', 2), ids: ['m5'] };
      const first = await seeded.poll(window);
      expect(await seeded.deleted()).toEqual(['m3', 'm4']);
      expect(first.changedMessages.map((m) => m.messageId).sort()).toEqual(['m3', 'm4']);
      const marked = (await raw('del-range', 'm3')).sourceDeleted as { detectedAt: string };
      expect(typeof marked.detectedAt).toBe('string');
      const again = await seeded.poll(window);
      expect(again.changedMessages).toEqual([]);
      expect(((await raw('del-range', 'm3')).sourceDeleted as { detectedAt: string }).detectedAt).toBe(marked.detectedAt);
      const content = await pool.query("SELECT text_content FROM messages WHERE account_id='del-range' AND message_id='m3'");
      expect(content.rows[0]?.text_content).toBe('text m3');
    });

    it('treats a null lower as the table start and marks nothing without a tail window', async () => {
      const none = await seed('del-none', 3);
      await none.poll(undefined);
      expect(await none.deleted()).toEqual([]);
      const full = await seed('del-start', 3);
      await full.poll({ upper: cur('m3', 3), lower: null, ids: ['m3'] });
      expect(await full.deleted()).toEqual(['m1', 'm2']);
    });

    it('clears the mark of a row that reappears and never judges another source', async () => {
      const seeded = await seed('del-clear', 3);
      await seeded.poll({ upper: cur('m3', 3), lower: null, ids: ['m3'] });
      expect(await seeded.deleted()).toEqual(['m1', 'm2']);
      const back = await seeded.poll({ upper: cur('m3', 3), lower: null, ids: ['m1', 'm3'] }, [obs('m1', 1)]);
      expect(await seeded.deleted()).toEqual(['m2']);
      expect(back.changedMessages.map((m) => m.messageId)).toContain('m1');
      // A message in range without provenance for this source is never judged by this source's window.
      await pool.query(`INSERT INTO messages(account_id,message_id,event_id,chat_type,chat_id,sender_id,kind,text_content,ingestion_source,occurred_at,raw)
        SELECT account_id,'foreign','foreign-event',chat_type,chat_id,sender_id,kind,text_content,ingestion_source,occurred_at + interval '500 ms',raw - 'sourceDeleted'
        FROM messages WHERE account_id='del-clear' AND message_id='m2'`);
      await seeded.poll({ upper: cur('m3', 3), lower: null, ids: ['m1', 'm3'] });
      expect(await seeded.deleted()).toEqual(['m2']);
    });

    it('rejects a malformed tail window before any write', async () => {
      const seeded = await seed('del-invalid', 2);
      await expect(seeded.poll({ upper: cur('m2', 2), lower: null, ids: ['m2', 'm2'] })).rejects.toThrow();
      await expect(seeded.poll({ upper: cur('m2', 2), lower: null, ids: Array.from({ length: 51 }, (_, i) => `x${i}`) })).rejects.toThrow();
      await expect(seeded.poll({ upper: { createdTime: 'x', id: 'm2' }, lower: null, ids: [] })).rejects.toThrow();
      expect(await seeded.deleted()).toEqual([]);
    });
  });

});
