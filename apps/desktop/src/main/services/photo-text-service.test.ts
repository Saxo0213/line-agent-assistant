import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Pool } from 'pg';
import { randomUUID } from 'node:crypto';
import { AgentScheduleCreateInputSchema } from '@line-agent/contracts';
import { AccountRepository, AgentScheduleRepository, MessageRepository, ScheduleForwardRepository } from '@line-agent/database';
import { createTestDatabase } from '../../../../../packages/database/src/test-database.js';
import { PhotoTextService } from './photo-text-service.js';
import type { PhotoOcrEngine, PhotoOcrResult } from './photo-ocr.js';

const database = process.env.TEST_DATABASE_URL ? describe : describe.skip;
const destination = { accountId: 'agent', chatType: 'group' as const, chatId: 'destination', title: 'Destination' };
const pass = (text: string): PhotoOcrResult => ({ ok: true, width: 100, height: 100, passes: [{ rotation: 0, text }] });

database('photo text rules: capture, OCR outcomes and settle', () => {
  let pool: Pool, close: () => Promise<void>, schedules: AgentScheduleRepository, forwards: ScheduleForwardRepository, messages: MessageRepository;
  let revision = 0;
  const errors: unknown[] = [];
  const results = new Map<string, PhotoOcrResult>();
  const ocr: PhotoOcrEngine = { recognize: vi.fn(async (path: string) => results.get(path) ?? { ok: false as const, code: 'OCR_FAILED' }), stop: vi.fn(async () => undefined) };
  const service = () => new PhotoTextService({ store: forwards, ocr, resolveImage: async (relativePath) => `C:\\fake\\${relativePath}`, publish: () => undefined,
    onError: (error) => { errors.push(error); } });
  beforeAll(async () => {
    ({ pool, close } = await createTestDatabase());
    schedules = new AgentScheduleRepository(pool); forwards = new ScheduleForwardRepository(pool); messages = new MessageRepository(pool);
    const accounts = new AccountRepository(pool);
    await accounts.ensureAccount('agent');
    await pool.query("UPDATE line_accounts SET product_role='AGENT' WHERE account_id='agent'");
    await accounts.activateControl('agent', 1);
    await accounts.bindWorker({ accountId: 'agent', workerInstanceId: 'w1', controlEpoch: 1 });
    await accounts.applyWorkerLogin({ accountId: 'agent', workerInstanceId: 'w1', controlEpoch: 1 }, 'u-agent', 'Agent');
  });
  afterAll(async () => { await close?.(); });

  const rule = async (match: object = {}, actions: object = { forward: true, agent: { prompt: '', target: destination } }) => {
    await pool.query('DELETE FROM agent_schedules');
    return (await schedules.create(AgentScheduleCreateInputSchema.parse({ title: 'Photo text', provider: 'claude', recurrence: { kind: 'message' },
      targets: [{ accountId: 'agent', chatType: 'group', chatId: 'source', title: 'Source' }],
      task: { type: 'message_forward', match: { mode: 'image_text', keywords: ['王小明', '張三豐'], ...match }, actions },
      delivery: { mode: 'line_target', target: destination } }))).scheduleId;
  };
  const cursor = (value: number) => ({ version: 1 as const, revision: String(value), globalRev: '0', individualRev: '0' });
  /** One message of u-alice in the source group; `images` are the external attachment ids. */
  const send = async (id: string, images: string[] = [`${id}-1`], kind: 'image' | 'text' = 'image') => {
    const next = ++revision;
    const batch = { type: 'batch' as const, accountId: 'agent', workerInstanceId: 'w1', controlEpoch: 1, batchId: `p${next}`,
      cursorBefore: cursor(next - 1), cursorAfter: cursor(next),
      envelopes: [{ accountId: 'agent', eventId: id, chatType: 'group' as const, chatId: 'source', senderId: 'u-alice', messageId: id, kind, text: kind === 'text' ? '王小明' : '',
        mentionIds: [], mentionRanges: [], replyToMessageId: null, ingestion: { source: 'live' as const, cursor: null }, occurredAt: new Date(Date.now() + 1000).toISOString(), raw: {},
        attachments: kind === 'text' ? [] : images.map((image) => ({ id: image, kind: 'image' as const, name: `${image}.png`, mimeType: 'image/png', sizeBytes: 4 }))}] };
    await messages.prepareBatchConversations(batch);
    await messages.ingestBatchSource(batch, new Set(), true);
  };
  /** Marks an attachment as downloaded; OCR of it returns `result`. */
  const ready = async (externalId: string, result: PhotoOcrResult) => {
    await pool.query("UPDATE attachments SET status='ready',relative_path=$2,sha256='x' WHERE external_attachment_id=$1", [externalId, `${externalId}.blob`]);
    results.set(`C:\\fake\\${externalId}.blob`, result);
  };
  const row = async (messageId: string) => (await pool.query(`SELECT w.work_id,w.ocr_state,w.ocr_detail,w.notify_state,w.agent_state,r.outcome,
    (SELECT json_agg(json_build_object('kind',p.kind,'state',p.state,'text',p.text) ORDER BY p.part_index) FROM agent_schedule_forward_parts p WHERE p.work_id=w.work_id) parts
    FROM agent_schedule_forward_work w JOIN agent_schedule_runs r USING(run_id) WHERE w.message_id=$1`, [messageId])).rows[0];

  it('captures a photo as a pending OCR row without parts, and does not touch a text message', async () => {
    await rule();
    await send('cap-1');
    await send('cap-text', [], 'text');
    expect(await row('cap-text')).toBeUndefined();
    expect(await row('cap-1')).toMatchObject({ ocr_state: 'pending', ocr_detail: null, notify_state: null, agent_state: null, outcome: 'submitting', parts: null });
    // The photo still downloads (and the row is young): the processor leaves it alone and the run stays open.
    await service().drain();
    await forwards.settle();
    expect(await row('cap-1')).toMatchObject({ ocr_state: 'pending', outcome: 'submitting' });
    expect(ocr.recognize).not.toHaveBeenCalled();
  });

  it('hit: the text part and every ready photo are queued for forwarding, with the notice when it is on', async () => {
    await rule({}, { forward: true, notify: true, agent: { prompt: '', target: destination } });
    await send('hit-1', ['hit-1-a', 'hit-1-b']);
    await ready('hit-1-a', pass('完全無關'));
    await ready('hit-1-b', pass('本日簽到 王 小 明'));
    await service().drain();
    const hit = await row('hit-1');
    expect(hit).toMatchObject({ ocr_state: 'hit', ocr_detail: '王小明', notify_state: 'pending', agent_state: null, outcome: 'submitting' });
    expect(hit.parts).toHaveLength(3);
    expect(hit.parts[0]).toMatchObject({ kind: 'text', state: 'pending' });
    expect(hit.parts[0].text).toMatch(/^【照片文字比對】Source｜.+｜\d\d:\d\d｜命中：王小明$/);
    expect(hit.parts.slice(1)).toEqual([{ kind: 'image', state: 'pending', text: null }, { kind: 'image', state: 'pending', text: null }]);
    expect(errors).toEqual([]);
  });

  it('unclear with verification: the Agent copy is queued and settles as submitted', async () => {
    await rule();
    await send('unclear-1');
    await ready('unclear-1-1', pass('本日 張二豐 簽到'));
    await service().drain();
    const unclear = await row('unclear-1');
    expect(unclear).toMatchObject({ ocr_state: 'unclear', ocr_detail: '張三豐', notify_state: null, agent_state: 'pending', outcome: 'submitting', parts: null });
    expect(await forwards.markAgentDispatch(unclear.work_id, 'submitted', randomUUID(), null)).toBe(true);
    expect((await row('unclear-1')).outcome).toBe('submitted');
  });

  it('miss, and unclear without verification, end as no_messages with nothing to send', async () => {
    await rule({ verifyUnclear: false }, { forward: true });
    await send('miss-1');
    await send('near-1');
    await ready('miss-1-1', pass('abc'));
    await ready('near-1-1', pass('張二豐'));
    await service().drain();
    expect(await row('miss-1')).toMatchObject({ ocr_state: 'miss', ocr_detail: null, notify_state: null, agent_state: null, outcome: 'no_messages', parts: null });
    expect(await row('near-1')).toMatchObject({ ocr_state: 'unclear', ocr_detail: '張三豐', notify_state: null, agent_state: null, outcome: 'no_messages', parts: null });
  });

  it('unavailable: a failed download, an OCR error and a download timeout each insert one text part and keep only codes', async () => {
    await rule();
    await send('bad-download');
    await pool.query("UPDATE attachments SET status='failed' WHERE external_attachment_id='bad-download-1'");
    await send('bad-ocr');
    await ready('bad-ocr-1', { ok: false, code: 'OCR_TIMEOUT' });
    await send('slow');
    await pool.query("UPDATE agent_schedule_forward_work SET created_at=now()-interval '20 minutes' WHERE message_id='slow'");
    await service().drain();
    const download = await row('bad-download');
    expect(download).toMatchObject({ ocr_state: 'unavailable', ocr_detail: 'failed', outcome: 'submitting' });
    expect(download.parts).toHaveLength(1);
    expect(download.parts[0].text).toMatch(/^【照片文字比對】無法下載照片，未比對：Source｜.+｜\d\d:\d\d$/);
    const failed = await row('bad-ocr');
    expect(failed).toMatchObject({ ocr_state: 'unavailable', ocr_detail: 'OCR_TIMEOUT' });
    expect(failed.parts[0].text).toMatch(/^【照片文字比對】照片文字辨識失敗，未比對：/);
    expect(await row('slow')).toMatchObject({ ocr_state: 'unavailable', ocr_detail: 'download_timeout' });
    // The text part is sent as usual and the run settles with the parts.
    await pool.query("UPDATE agent_schedule_forward_parts SET state='sent' WHERE work_id=$1", [download.work_id]);
    await forwards.settle();
    expect((await row('bad-download')).outcome).toBe('sent');
  });

  it('settle: a disabled rule closes a row that waits for OCR as unavailable and fails the run', async () => {
    const scheduleId = await rule();
    await send('cancel-1');
    await forwards.settle();
    expect(await row('cancel-1')).toMatchObject({ ocr_state: 'pending', outcome: 'submitting' });
    await schedules.update(scheduleId, { enabled: false });
    await service().drain();
    await forwards.settle();
    expect(await row('cancel-1')).toMatchObject({ ocr_state: 'unavailable', ocr_detail: 'forwarding_cancelled', outcome: 'failed', parts: null });
  });
});
