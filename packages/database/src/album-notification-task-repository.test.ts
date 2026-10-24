import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Pool } from 'pg';
import { createTestDatabase } from './test-database.js';
import { AlbumNotificationTaskRepository, walkAlbumTaskMessagePages } from './album-notification-task-repository.js';

const database = process.env.TEST_DATABASE_URL ? describe : describe.skip;

database('AlbumNotificationTaskRepository with PostgreSQL', () => {
  let pool: Pool;
  let close: () => Promise<void>;
  let repository: AlbumNotificationTaskRepository;

  beforeAll(async () => {
    ({ pool, close } = await createTestDatabase());
    repository = new AlbumNotificationTaskRepository(pool);
  });
  afterAll(async () => { await close?.(); });

  async function seedMessage(input: { accountId: string; chatType?: 'direct' | 'group' | 'room'; chatId: string; messageId: string;
    serviceType?: 'AB' | 'GB'; contentType?: 16 | 0; source?: 'live' | 'history'; sourceDeleted?: boolean; unsent?: boolean }) {
    const chatType = input.chatType ?? 'group';
    await pool.query('INSERT INTO line_accounts(account_id) VALUES($1) ON CONFLICT DO NOTHING', [input.accountId]);
    await pool.query('INSERT INTO conversations(account_id,chat_id,chat_type) VALUES($1,$2,$3) ON CONFLICT DO NOTHING',
      [input.accountId, input.chatId, chatType]);
    const raw = { ...(input.sourceDeleted ? { sourceDeleted: { detectedAt: new Date().toISOString() } } : {}), message: {
      id: input.messageId, contentType: input.contentType ?? 16,
      contentMetadata: { serviceType: input.serviceType ?? 'AB', ...(input.unsent ? { UNSENT: true } : {}) },
    } };
    await pool.query(`INSERT INTO messages(account_id,message_id,event_id,chat_id,chat_type,sender_id,kind,ingestion_source,occurred_at,raw)
      VALUES($1,$2,$3,$4,$5,'sender','event',$6,clock_timestamp(),$7::jsonb) ON CONFLICT DO NOTHING`,
    [input.accountId, input.messageId, `event-${input.messageId}`, input.chatId, chatType, input.source ?? 'live', JSON.stringify(raw)]);
  }

  async function task(accountId: string, messageId: string) {
    const result = await pool.query<{ status: string; error_stage: string | null; error_code: string | null; attempt_count: number }>(
      'SELECT status,error_stage,error_code,attempt_count FROM album_notification_tasks WHERE account_id=$1 AND message_id=$2',
      [accountId, messageId]);
    return result.rows[0];
  }

  async function activateBinding(accountId: string, workerInstanceId = 'album-task-worker') {
    await pool.query("UPDATE line_accounts SET mode='MONITOR_ONLY',worker_instance_id=NULL,worker_binding_epoch=NULL WHERE mode='ACTIVE_CONTROL'");
    const epoch = Number((await pool.query<{ control_epoch: string }>(
      'SELECT control_epoch FROM account_control WHERE singleton=true')).rows[0]!.control_epoch);
    await pool.query("UPDATE line_accounts SET mode='ACTIVE_CONTROL',worker_instance_id=$2,worker_binding_epoch=$3 WHERE account_id=$1",
      [accountId, workerInstanceId, epoch]);
    return { workerInstanceId, controlEpoch: epoch };
  }

  it('inserts exact committed live AB tasks idempotently for group and direct while excluding GB and history', async () => {
    const accountId = 'album-task-insert';
    await seedMessage({ accountId, chatId: 'group-chat', messageId: 'ab-group', chatType: 'group' });
    await seedMessage({ accountId, chatId: 'group-chat', messageId: 'ab-direct', chatType: 'direct' });
    await seedMessage({ accountId, chatId: 'group-chat', messageId: 'gb-live', serviceType: 'GB' });
    await seedMessage({ accountId, chatId: 'group-chat', messageId: 'ab-history', source: 'history' });

    await expect(repository.enqueueCommitted({ accountId, chatType: 'group', chatId: 'group-chat', messageId: 'ab-group' })).resolves.toBe(true);
    await expect(repository.enqueueCommitted({ accountId, chatType: 'group', chatId: 'group-chat', messageId: 'ab-group' })).resolves.toBe(true);
    await expect(repository.enqueueCommitted({ accountId, chatType: 'direct', chatId: 'group-chat', messageId: 'ab-direct' })).resolves.toBe(true);
    await expect(repository.enqueueCommitted({ accountId, chatType: 'group', chatId: 'group-chat', messageId: 'gb-live' })).resolves.toBe(false);
    await expect(repository.enqueueCommitted({ accountId, chatType: 'group', chatId: 'group-chat', messageId: 'ab-history' })).resolves.toBe(false);
    const rows = await pool.query<{ message_id: string; chat_type: string }>(
      'SELECT message_id,chat_type FROM album_notification_tasks WHERE account_id=$1 ORDER BY message_id', [accountId]);
    expect(rows.rows).toEqual([{ message_id: 'ab-direct', chat_type: 'direct' }, { message_id: 'ab-group', chat_type: 'group' }]);
  });

  it('backfills bounded pages of only missing live actionable AB rows', async () => {
    const accountId = 'album-task-backfill';
    for (const messageId of ['ab-a', 'ab-b', 'gb-c', 'deleted-d', 'unsent-e', 'history-f']) {
      await seedMessage({ accountId, chatId: 'g', messageId,
        ...(messageId.startsWith('gb') ? { serviceType: 'GB' as const } : {}),
        ...(messageId.startsWith('deleted') ? { sourceDeleted: true } : {}),
        ...(messageId.startsWith('unsent') ? { unsent: true } : {}),
        ...(messageId.startsWith('history') ? { source: 'history' as const } : {}) });
    }
    const first = await repository.backfillMissingPage({ accountId, limit: 1 });
    expect(first).toEqual({ count: 1, nextMessageId: 'ab-a' });
    const second = await repository.backfillMissingPage({ accountId, afterMessageId: first.nextMessageId!, limit: 1 });
    expect(second).toEqual({ count: 1, nextMessageId: 'ab-b' });
    const end = await repository.backfillMissingPage({ accountId, afterMessageId: second.nextMessageId!, limit: 1 });
    expect(end).toEqual({ count: 0, nextMessageId: null });
    expect((await pool.query<{ message_id: string }>('SELECT message_id FROM album_notification_tasks WHERE account_id=$1 ORDER BY message_id',
      [accountId])).rows).toEqual([{ message_id: 'ab-a' }, { message_id: 'ab-b' }]);
  });

  it('matches chat type across source joins and skips a task with the wrong chat type', async () => {
    const accountId = 'album-task-chat-type-identity';
    await seedMessage({ accountId, chatId: 'shared-chat-id', messageId: 'group-message', chatType: 'group' });
    await seedMessage({ accountId, chatId: 'shared-chat-id', messageId: 'direct-message', chatType: 'direct' });
    await repository.backfillMissingPage({ accountId });
    expect((await pool.query<{ chat_type: string; message_id: string }>(
      'SELECT chat_type,message_id FROM album_notification_tasks WHERE account_id=$1 ORDER BY message_id', [accountId])).rows)
      .toEqual([{ chat_type: 'direct', message_id: 'direct-message' }, { chat_type: 'group', message_id: 'group-message' }]);
    await pool.query(`INSERT INTO album_notification_tasks(account_id,chat_type,chat_id,message_id,status)
      VALUES($1,'room','shared-chat-id','group-message','pending')`, [accountId]);
    await repository.skipInvalidPage({ accountId, limit: 1 });
    expect((await pool.query<{ status: string; error_code: string | null }>(
      `SELECT status,error_code FROM album_notification_tasks WHERE account_id=$1 AND chat_type='room' AND message_id='group-message'`,
      [accountId])).rows[0]).toEqual({ status: 'skipped', error_code: 'source_deleted' });
  });

  it('backfills a committed notification after task persistence failed before dispatch', async () => {
    const accountId = 'album-task-insert-recovery';
    // The committed message is durable even when the post-commit task insert never happens.
    await seedMessage({ accountId, chatId: 'g', messageId: 'recovered-after-insert-failure' });
    await expect(repository.enqueueCommitted({ accountId, chatType: 'group', chatId: 'g', messageId: 'not-committed' }))
      .resolves.toBe(false);
    expect((await pool.query('SELECT 1 FROM album_notification_tasks WHERE account_id=$1', [accountId])).rowCount).toBe(0);
    await expect(repository.backfillMissingPage({ accountId })).resolves.toMatchObject({ count: 1,
      nextMessageId: 'recovered-after-insert-failure' });
    await expect(repository.claimChat({ accountId, chatType: 'group', chatId: 'g' })).resolves.toMatchObject({ claimed: true });
  });

  it('checks owner validity between bounded backfill and invalid-source pages', async () => {
    const page = { count: 64, nextMessageId: 'message-64' };
    let current = true;
    const isCurrent = vi.fn(() => current);
    const readPage = vi.fn(async () => { current = false; return page; });
    await expect(walkAlbumTaskMessagePages(readPage, isCurrent)).resolves.toBe(false);
    expect(readPage).toHaveBeenCalledTimes(1);
    expect(isCurrent).toHaveBeenCalledTimes(2);
  });

  it('completes only claimed tasks so a restart does not reread completed notifications', async () => {
    const accountId = 'album-task-restart';
    await seedMessage({ accountId, chatId: 'g', messageId: 'done' });
    const binding = await activateBinding(accountId);
    await repository.enqueueCommitted({ accountId, chatType: 'group', chatId: 'g', messageId: 'done' });
    await expect(repository.claimChat({ accountId, chatType: 'group', chatId: 'g' })).resolves.toMatchObject({ claimed: true });
    await expect(repository.completeClaimedChat({ accountId, chatType: 'group', chatId: 'g' }, binding)).resolves.toBe(true);
    await repository.recoverRunning(accountId);
    await expect(repository.dueChatsPage({ accountId })).resolves.toMatchObject({ chats: [], nextChat: null });
    expect(await task(accountId, 'done')).toMatchObject({ status: 'completed', error_stage: null, error_code: null });
  });

  it('fences completion across a database binding cutover and lets the new binding recover it', async () => {
    const accountId = 'album-task-binding-cutover';
    await seedMessage({ accountId, chatId: 'g', messageId: 'cutover' });
    const oldBinding = await activateBinding(accountId, 'old-worker');
    await repository.enqueueCommitted({ accountId, chatType: 'group', chatId: 'g', messageId: 'cutover' });
    await repository.claimChat({ accountId, chatType: 'group', chatId: 'g' });

    const cutover = await pool.connect();
    let completion: Promise<boolean>;
    try {
      await cutover.query('BEGIN');
      await cutover.query('UPDATE account_control SET control_epoch=control_epoch+1 WHERE singleton=true');
      await cutover.query("UPDATE line_accounts SET mode='MONITOR_ONLY',worker_instance_id=NULL,worker_binding_epoch=NULL WHERE account_id=$1", [accountId]);
      completion = repository.completeClaimedChat({ accountId, chatType: 'group', chatId: 'g' }, oldBinding);
      await new Promise((resolve) => setTimeout(resolve, 20));
      await cutover.query('COMMIT');
    } catch (error) {
      await cutover.query('ROLLBACK');
      throw error;
    } finally { cutover.release(); }
    await expect(completion!).resolves.toBe(false);
    expect(await task(accountId, 'cutover')).toMatchObject({ status: 'running' });

    const newBinding = await activateBinding(accountId, 'new-worker');
    await repository.recoverRunning(accountId);
    await expect(repository.claimChat({ accountId, chatType: 'group', chatId: 'g' })).resolves.toMatchObject({ claimed: true });
    await expect(repository.completeClaimedChat({ accountId, chatType: 'group', chatId: 'g' }, newBinding)).resolves.toBe(true);
    expect(await task(accountId, 'cutover')).toMatchObject({ status: 'completed' });
  });

  it('leaves a second AB committed during an active pass pending for the trailing pass', async () => {
    const accountId = 'album-task-trailing';
    await seedMessage({ accountId, chatId: 'g', messageId: 'first' });
    await seedMessage({ accountId, chatId: 'g', messageId: 'second' });
    const binding = await activateBinding(accountId);
    await repository.enqueueCommitted({ accountId, chatType: 'group', chatId: 'g', messageId: 'first' });
    await repository.claimChat({ accountId, chatType: 'group', chatId: 'g' });
    await repository.enqueueCommitted({ accountId, chatType: 'group', chatId: 'g', messageId: 'second' });
    await repository.completeClaimedChat({ accountId, chatType: 'group', chatId: 'g' }, binding);
    expect(await task(accountId, 'first')).toMatchObject({ status: 'completed' });
    expect(await task(accountId, 'second')).toMatchObject({ status: 'pending' });
    await expect(repository.claimChat({ accountId, chatType: 'group', chatId: 'g' })).resolves.toMatchObject({ claimed: true });
    await repository.completeClaimedChat({ accountId, chatType: 'group', chatId: 'g' }, binding);
    expect(await task(accountId, 'second')).toMatchObject({ status: 'completed' });
  });

  it('persists a retry deadline and prevents a newer task from bypassing it', async () => {
    const accountId = 'album-task-cooldown';
    await seedMessage({ accountId, chatId: 'g1', messageId: 'failed' });
    await seedMessage({ accountId, chatId: 'g2', messageId: 'newer', chatType: 'direct' });
    const binding = await activateBinding(accountId);
    await repository.enqueueCommitted({ accountId, chatType: 'group', chatId: 'g1', messageId: 'failed' });
    await repository.claimChat({ accountId, chatType: 'group', chatId: 'g1' });
    const retryAt = await repository.retryClaimedChat({ accountId, chatType: 'group', chatId: 'g1' }, binding,
      { stage: 'archive_scan', code: 'ALBUM_RECONCILIATION_FAILED' });
    expect(retryAt).toBeGreaterThan(Date.now());
    await repository.enqueueCommitted({ accountId, chatType: 'direct', chatId: 'g2', messageId: 'newer' });
    await expect(repository.claimChat({ accountId, chatType: 'direct', chatId: 'g2' })).resolves.toMatchObject({ claimed: false, retryAt });
    await pool.query("UPDATE album_notification_tasks SET next_attempt_at=clock_timestamp()-interval '1 second' WHERE account_id=$1 AND status='retry'", [accountId]);
    await expect(repository.claimChat({ accountId, chatType: 'direct', chatId: 'g2' })).resolves.toMatchObject({ claimed: true, retryAt: null });
    expect(await task(accountId, 'failed')).toMatchObject({ status: 'retry', error_stage: 'archive_scan', attempt_count: 1 });
    await pool.query("DELETE FROM messages WHERE account_id=$1 AND message_id='failed'", [accountId]);
    await repository.skipInvalidPage({ accountId });
    expect(await task(accountId, 'failed')).toMatchObject({ status: 'skipped', error_code: 'missing_source' });
  });

  it('recovers running rows after a crash and permanently skips missing, source-deleted, and unsent sources', async () => {
    const accountId = 'album-task-recovery';
    for (const messageId of ['running', 'deleted', 'unsent', 'missing', 'removed-during-run']) {
      await seedMessage({ accountId, chatId: 'g', messageId });
      await repository.enqueueCommitted({ accountId, chatType: 'group', chatId: 'g', messageId });
    }
    const binding = await activateBinding(accountId);
    await repository.claimChat({ accountId, chatType: 'group', chatId: 'g' });
    expect(await repository.recoverRunning(accountId)).toBe(5);
    expect(await task(accountId, 'running')).toMatchObject({ status: 'pending', attempt_count: 1 });

    await pool.query("UPDATE messages SET raw=raw || '{\"sourceDeleted\":true}'::jsonb WHERE account_id=$1 AND message_id='deleted'", [accountId]);
    await pool.query("UPDATE messages SET raw=jsonb_set(raw,'{message,contentMetadata,UNSENT}','true'::jsonb) WHERE account_id=$1 AND message_id='unsent'", [accountId]);
    await pool.query("DELETE FROM messages WHERE account_id=$1 AND message_id='missing'", [accountId]);
    const skipped = await repository.skipInvalidPage({ accountId, limit: 10 });
    expect(skipped.count).toBe(3);
    expect(await task(accountId, 'deleted')).toMatchObject({ status: 'skipped', error_code: 'source_deleted' });
    expect(await task(accountId, 'unsent')).toMatchObject({ status: 'skipped', error_code: 'source_deleted' });
    expect(await task(accountId, 'missing')).toMatchObject({ status: 'skipped', error_code: 'missing_source' });

    await repository.claimChat({ accountId, chatType: 'group', chatId: 'g' });
    await pool.query("UPDATE messages SET raw=raw || '{\"sourceDeleted\":true}'::jsonb WHERE account_id=$1 AND message_id='removed-during-run'", [accountId]);
    await repository.completeClaimedChat({ accountId, chatType: 'group', chatId: 'g' }, binding);
    expect(await task(accountId, 'removed-during-run')).toMatchObject({ status: 'skipped', error_code: 'source_deleted' });
  });
});
