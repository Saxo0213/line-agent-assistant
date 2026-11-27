import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Pool } from 'pg';
import { createTestDatabase } from './test-database.js';
import { AccountRepository } from './account-repository.js';
import { MessageRepository } from './message-repository.js';
import { plainEnvelope } from './content-bridge/test-support.js';
import { ExternalMonitorRepository, type ExternalObservationBatch } from './external-monitor-repository.js';

const database = process.env.TEST_DATABASE_URL ? describe : describe.skip;
type Observation = ExternalObservationBatch['observations'][number];
const EDITED_AT = 1_764_124_800_000;

database('message revisions', () => {
  let pool: Pool;
  let close: () => Promise<void>;
  let repository: ExternalMonitorRepository;
  let messages: MessageRepository;

  beforeAll(async () => {
    ({ pool, close } = await createTestDatabase());
    repository = new ExternalMonitorRepository(pool);
    messages = new MessageRepository(pool);
  });
  afterAll(async () => { await close?.(); });

  async function createSource(accountId: string, initialImport?: { snapshotDigest: string; schemaVersion: string; highWater: Record<string, unknown> | null; eligibleCount: string | null }) {
    const accounts = new AccountRepository(pool);
    await accounts.ensureAccount(accountId);
    await accounts.setOwnMid(accountId, `verified-mid-${accountId}`);
    await pool.query("UPDATE line_accounts SET product_role=NULL WHERE product_role='PRIMARY_ADMIN'");
    await pool.query("UPDATE line_accounts SET product_role='PRIMARY_ADMIN' WHERE account_id=$1", [accountId]);
    return repository.bindVerifiedExternalSource({ accountId, ownMid: `verified-mid-${accountId}`,
      sourceIdentity: `official-db-profile-${accountId}`, ...(initialImport ? { initialImport } : {}) });
  }

  // The monitor ignores direct-chat rows whose ID is not a LINE int64, so each test name maps to a numeric ID.
  const NUMERIC_IDS: Record<string, string> = { 'rev-native': '9100000000000000001', 'rev-live': '9100000000000000002',
    'rev-plain': '9100000000000000003', 'rev-recall': '9100000000000000004', 'rev-page-msg': '9100000000000000005' };
  const lineId = (name: string) => NUMERIC_IDS[name]!;
  const nativeText = (name: string, text: string, metadata: Record<string, unknown> | null): Observation => ((id: string) => ({
    observationId: `obs:${id}`, canonicalMessageId: id, nativeMessageId: id, chatType: 'direct', chatId: 'rev-chat', senderId: 'rev-sender',
    kind: 'text', text, nativeContentType: 0, occurredAt: '2026-11-26T06:00:00Z',
    nativePayload: plainEnvelope({ _id: id, _contentType: 0, _text: text, _contentMetadata: metadata === null ? '{}' : JSON.stringify(metadata) }),
  }) as unknown as Observation)(lineId(name));
  const liveText = (name: string, text: string, metadata: Record<string, unknown> | null): Observation => ((id: string) => ({
    observationId: `obs:${id}`, canonicalMessageId: id, nativeMessageId: id, chatType: 'direct', chatId: 'rev-chat', senderId: 'rev-sender',
    kind: 'text', text, occurredAt: '2026-11-26T06:00:00Z',
    livePayload: { raw: { message: { id, contentType: 'NONE', text, ...(metadata === null ? {} : { contentMetadata: metadata }) } } },
  }) as unknown as Observation)(lineId(name));

  async function revisions(accountId: string, name: string) {
    return (await pool.query<{ text_content: string; raw: unknown; revised_at: Date }>(
      'SELECT text_content,raw,revised_at FROM message_revisions WHERE account_id=$1 AND message_id=$2 ORDER BY revised_at,revision_id', [accountId, lineId(name)])).rows;
  }
  const listed = async (accountId: string, name: string) =>
    (await messages.listMessages({ accountId, chatType: 'direct', chatId: 'rev-chat' }, null, 20)).messages.find((row) => row.messageId === lineId(name))!;

  it('keeps the earlier text through the tail write path (native and live raw) only for a marked, different, non-recall edit', async () => {
    const accountId = 'rev-poll';
    const { sourceId, generation, modeRevision } = await createSource(accountId);
    let step = 0;
    const commit = async (forward: Observation[], tail: Observation[]) => {
      // A poll that changes nothing writes no receipt, so the stored checkpoint is the only reliable predecessor.
      const fence = await repository.readBatchFence({ accountId, sourceId, generation });
      return repository.commitDirectPoll({ accountId, sourceId, generation, expectedModeRevision: modeRevision,
        expectedCheckpoint: fence.expectedCheckpoint, batchId: `rev-batch-${++step}`, cursor: { id: `rev-cursor-${step}` },
        forwardObservations: forward, tailObservations: tail });
    };
    await commit([nativeText('rev-native', 'first', null), liveText('rev-live', 'live first', null),
      nativeText('rev-plain', 'plain first', null), nativeText('rev-recall', 'recall first', null)], []);
    expect((await listed(accountId, 'rev-native')).edited).toBeNull();

    // Edit with marker: old text and old raw are kept; revised_at is UPDATED_TIME.
    await commit([], [nativeText('rev-native', 'second', { UPDATED_TIME: String(EDITED_AT), EDITED: 'true' })]);
    const first = await revisions(accountId, 'rev-native');
    expect(first).toHaveLength(1);
    expect(first[0]).toMatchObject({ text_content: 'first' });
    expect(first[0]!.revised_at.getTime()).toBe(EDITED_AT);
    expect(first[0]!.raw).toMatchObject({ native: { encoding: 'plain' } });
    expect((await listed(accountId, 'rev-native')).edited).toEqual({ editedAt: new Date(EDITED_AT).toISOString(),
      versions: [{ text: 'first', until: new Date(EDITED_AT).toISOString() }] });

    // The same version again writes nothing.
    await commit([], [nativeText('rev-native', 'second', { UPDATED_TIME: String(EDITED_AT), EDITED: 'true' })]);
    expect(await revisions(accountId, 'rev-native')).toHaveLength(1);

    // Live raw shape: marker in message.contentMetadata.
    await commit([], [liveText('rev-live', 'live second', { EDITED: 'true' })]);
    expect(await revisions(accountId, 'rev-live')).toMatchObject([{ text_content: 'live first' }]);
    expect((await listed(accountId, 'rev-live')).edited).toMatchObject({ versions: [{ text: 'live first' }] });

    // Text change without a marker: no row, no edited mark.
    await commit([], [nativeText('rev-plain', 'plain second', null)]);
    expect(await revisions(accountId, 'rev-plain')).toHaveLength(0);
    expect((await listed(accountId, 'rev-plain')).edited).toBeNull();

    // Recall (unsent) with a marker is not an edit.
    await commit([], [nativeText('rev-recall', 'recall second', { UNSENT: 'true', UPDATED_TIME: String(EDITED_AT) })]);
    expect(await revisions(accountId, 'rev-recall')).toHaveLength(0);
  });

  it('keeps the earlier text through the history page write path', async () => {
    const accountId = 'rev-page';
    const { sourceId, generation, modeRevision } = await createSource(accountId, {
      snapshotDigest: 'a'.repeat(64), schemaVersion: 'line-schema-v1', highWater: { createdTime: '2', id: 'p2' }, eligibleCount: '2' });
    const page = (batchId: string, expectedCheckpoint: Record<string, unknown>, cursor: Record<string, unknown>, observations: Observation[]) =>
      repository.stageAndProjectBatch({ accountId, sourceId, generation, expectedModeRevision: modeRevision, expectedCheckpoint,
        batchId, cursor, initialImport: true, observations });
    await page('rev-page-1', {}, { createdTime: '1', id: 'p1' }, [nativeText('rev-page-msg', 'page first', null)]);
    await page('rev-page-2', { createdTime: '1', id: 'p1' }, { createdTime: '2', id: 'p2' },
      [nativeText('rev-page-msg', 'page second', { UPDATED_TIME: String(EDITED_AT) })]);
    expect(await revisions(accountId, 'rev-page-msg')).toMatchObject([{ text_content: 'page first' }]);
    expect((await listed(accountId, 'rev-page-msg')).edited).toMatchObject({ versions: [{ text: 'page first' }] });
    expect((await listed(accountId, 'rev-page-msg')).text).toBe('page second');
  });
});
