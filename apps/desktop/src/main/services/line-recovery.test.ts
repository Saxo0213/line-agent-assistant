import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Pool } from 'pg';
import type { LineWorkerEvent } from '@line-agent/contracts';
import { createTestDatabase } from '../../../../../packages/database/src/test-database.js';
import { AccountRepository, AdminRepository, MessageRepository, SettingsRepository } from '../../../../../packages/database/src/index.js';
import { LineService } from './line-service.js';

const database = process.env.TEST_DATABASE_URL ? describe : describe.skip;
type Batch = Extract<LineWorkerEvent, { type: 'batch' }>;
const cursor = (revision: string) => ({ version: 1 as const, revision, globalRev: '0', individualRev: '0' });
const commandBatch = (messageId: string, revision: string, workerInstanceId: string): Batch => ({
  type: 'batch', accountId: 'a', workerInstanceId, controlEpoch: 1, batchId: `batch-${messageId}`,
  cursorBefore: cursor(String(Number(revision) - 1)), cursorAfter: cursor(revision),
  envelopes: [{ eventId: `event-${messageId}`, accountId: 'a', chatType: 'direct', chatId: 'chat', senderId: 'user',
    messageId, kind: 'text', text: '/new', mentionIds: [], mentionRanges: [], replyToMessageId: null,
    ingestion: { source: 'live', cursor: null }, occurredAt: '2026-10-15T00:00:00.000Z', raw: {},
    attachments: [{ id: `attachment-${messageId}`, kind: 'image', name: null, mimeType: null, sizeBytes: null }] }],
});
const cursorOnly = (revision: string, workerInstanceId: string): Batch => ({
  ...commandBatch('unused', revision, workerInstanceId), batchId: `cursor-${revision}`, envelopes: [],
});

database('pending LINE control effect recovery on PostgreSQL', () => {
  let pool: Pool; let close: () => Promise<void>;
  let accounts: AccountRepository; let messages: MessageRepository; let settings: SettingsRepository; let admins: AdminRepository;
  beforeAll(async () => {
    ({ pool, close } = await createTestDatabase());
    accounts = new AccountRepository(pool); messages = new MessageRepository(pool); settings = new SettingsRepository(pool);
    admins = new AdminRepository(pool);
    await accounts.ensureAccount('a');
    await pool.query("UPDATE line_accounts SET product_role='AGENT' WHERE account_id='a'");
    await accounts.activateControl('a', 1); await accounts.setOwnMid('a', 'own-mid');
    await messages.ingestAndRoute({ ...commandBatch('seed', '1', 'seed-worker').envelopes[0]!, eventId: 'seed-event',
      messageId: 'seed-message', text: 'seed', attachments: [] }, { eligible: false });
    await settings.setAppSetting('workspace_path', 'C:\\trusted');
    await settings.setConversationAgent({ accountId: 'a', chatType: 'direct', chatId: 'chat', enabled: true, provider: 'codex' });
    await admins.bindPrimary('a', 'chat', 'user');
  });
  afterAll(async () => { await close?.(); });

  async function commitWithoutEffect(messageId: string, revision: string, workerInstanceId: string): Promise<void> {
    const service = new LineService(accounts, messages, settings, { async send() {} },
      { kick() {}, async stopChat() {}, async resetChat() { throw new Error('process crashed before effect'); } }, undefined,
      { async downloadById() { return true; } }, undefined, admins);
    service.bind({ accountId: 'a', workerInstanceId, controlEpoch: 1, mode: 'ACTIVE_CONTROL' });
    await expect(service.handleWorkerEvent(workerInstanceId, commandBatch(messageId, revision, workerInstanceId)))
      .rejects.toThrow('process crashed before effect');
    expect(await messages.pendingRouteAction({ accountId: 'a', chatType: 'direct', chatId: 'chat' }, messageId)).toBe('new');
  }

  it('drains a committed /new after restart even when only a later cursor-only batch arrives', async () => {
    await commitWithoutEffect('crash-new', '100', 'old-worker');
    let resets = 0;
    const service = new LineService(accounts, messages, settings, { async send() {} },
      { kick() {}, async stopChat() {}, async resetChat() { resets++; } }, undefined, undefined, undefined, admins);
    service.bind({ accountId: 'a', workerInstanceId: 'new-worker', controlEpoch: 1, mode: 'ACTIVE_CONTROL' });
    await service.handleWorkerEvent('new-worker', cursorOnly('101', 'new-worker'));
    expect(resets).toBe(1);
    expect(await messages.pendingRouteAction({ accountId: 'a', chatType: 'direct', chatId: 'chat' }, 'crash-new')).toBeNull();
  });

  it('lets only one of two concurrent recovery services apply the pending /new', async () => {
    await commitWithoutEffect('concurrent-new', '200', 'crashed-worker');
    let resets = 0; let entered!: () => void; let release!: () => void;
    const started = new Promise<void>((resolve) => { entered = resolve; });
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const agents = { kick() {}, async stopChat() {}, async resetChat() { resets++; entered(); await gate; } };
    const first = new LineService(accounts, messages, settings, { async send() {} }, agents,
      undefined, undefined, undefined, admins);
    const second = new LineService(accounts, messages, settings, { async send() {} }, agents,
      undefined, undefined, undefined, admins);
    first.bind({ accountId: 'a', workerInstanceId: 'recovery-worker', controlEpoch: 1, mode: 'ACTIVE_CONTROL' });
    try {
      expect(await Promise.race([started.then(() => 'started'),
        new Promise<string>((resolve) => setTimeout(() => resolve('not recovered'), 500))])).toBe('started');
      second.bind({ accountId: 'a', workerInstanceId: 'recovery-worker', controlEpoch: 1, mode: 'ACTIVE_CONTROL' });
      const firstBatch = first.handleWorkerEvent('recovery-worker', cursorOnly('201', 'recovery-worker'));
      const secondBatch = second.handleWorkerEvent('recovery-worker', cursorOnly('201', 'recovery-worker'));
      release(); await Promise.all([firstBatch, secondBatch]);
      expect(resets).toBe(1);
      expect(await messages.pendingRouteAction({ accountId: 'a', chatType: 'direct', chatId: 'chat' }, 'concurrent-new')).toBeNull();
    } finally { release(); }
  });

  it('retries a failed startup recovery on the next cursor-only batch', async () => {
    await commitWithoutEffect('retry-new', '300', 'failed-worker');
    let attempts = 0;
    const service = new LineService(accounts, messages, settings, { async send() {} },
      { kick() {}, async stopChat() {}, async resetChat() {
        attempts++;
        if (attempts === 1) throw new Error('transient reset failure');
      } }, undefined, undefined, undefined, admins);
    service.bind({ accountId: 'a', workerInstanceId: 'retry-worker', controlEpoch: 1, mode: 'ACTIVE_CONTROL' });
    await expect(service.handleWorkerEvent('retry-worker', cursorOnly('301', 'retry-worker')))
      .rejects.toThrow('transient reset failure');
    await service.handleWorkerEvent('retry-worker', cursorOnly('301', 'retry-worker'));
    expect(attempts).toBe(2);
    expect(await messages.pendingRouteAction({ accountId: 'a', chatType: 'direct', chatId: 'chat' }, 'retry-new')).toBeNull();
  });
});
