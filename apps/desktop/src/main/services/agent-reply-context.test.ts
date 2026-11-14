import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, readdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Pool } from 'pg';
import { AccountRepository } from '@line-agent/database';
import { createTestDatabase } from '../../../../../packages/database/src/test-database.js';
import { ATTACHMENT_DIRECTORY } from './agent-attachments.js';
import { createReplyContextResolver, formatReplyTime, type ReplyContextInput } from './agent-reply-context.js';

const database = process.env.TEST_DATABASE_URL ? describe : describe.skip;
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);
const sha = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
const OWN_MID = `u${'a'.repeat(32)}`;
const MEMBER_MID = `u${'b'.repeat(32)}`;

database('reply context of a LINE job (real database)', () => {
  let pool: Pool;
  let close: () => Promise<void>;
  let accountId = '';
  let workspace = '';
  let store = '';
  const paths = new Map<string, string>();
  const downloads: string[] = [];
  let onDownload: ((id: string) => Promise<boolean>) | null = null;
  const resolver = () => createReplyContextResolver({ database: pool, downloadWaitMs: 100, attachments: { resolveReadyPath: async (id) => paths.get(id) ?? null,
    downloadById: async (id, signal) => { downloads.push(id); return onDownload ? onDownload(id) : new Promise<boolean>((resolve) => signal?.addEventListener('abort', () => resolve(false))); } } });
  async function makeReady(id: string, bytes: Buffer): Promise<void> {
    const file = join(store, id);
    await writeFile(file, bytes);
    paths.set(id, file);
    await pool.query("UPDATE attachments SET status='ready', relative_path=$2, sha256=$3 WHERE attachment_id=$1::uuid", [id, `managed/${id}`, sha(bytes)]);
  }
  const input = (messageId: string, chatId = 'g1'): ReplyContextInput => ({ jobId: randomUUID(), accountId, chatType: 'group', chatId, messageId,
    workspacePath: workspace, provider: 'claude' });

  async function message(id: string, fields: { chatId?: string; sender?: string; kind?: string; text?: string | null; reply?: string | null;
    content?: object | null; raw?: object; at?: string } = {}): Promise<void> {
    await pool.query(`INSERT INTO messages(account_id,message_id,event_id,chat_type,chat_id,sender_id,kind,text_content,reply_to_message_id,content,
      mention_ids,mention_ranges,ingestion_source,occurred_at,raw) VALUES ($1,$2,$2,'group',$3,$4,$5,$6,$7,$8,'[]','[]','live',$9,$10)`,
    [accountId, id, fields.chatId ?? 'g1', fields.sender ?? MEMBER_MID, fields.kind ?? 'text', fields.text ?? null, fields.reply ?? null,
      fields.content ? JSON.stringify(fields.content) : null, fields.at ?? '2026-11-05T01:03:00Z', JSON.stringify(fields.raw ?? {})]);
  }
  async function attachment(messageId: string, fields: { name?: string | null; bytes?: Buffer; status?: string; error?: string | null;
    sha256?: string | null; size?: number | null; kind?: string; createdAt?: string } = {}): Promise<string> {
    const id = randomUUID();
    const bytes = fields.bytes ?? PNG;
    const ready = (fields.status ?? 'ready') === 'ready';
    if (ready) { const file = join(store, id); await writeFile(file, bytes); paths.set(id, file); }
    await pool.query(`INSERT INTO attachments(attachment_id,external_attachment_id,account_id,chat_type,chat_id,message_id,kind,name,size_bytes,status,relative_path,sha256,error,created_at)
      VALUES ($1::uuid,$12,$2,'group','g1',$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
    [id, accountId, messageId, fields.kind ?? 'image', fields.name === undefined ? 'photo.png' : fields.name, fields.size === undefined ? bytes.byteLength : fields.size,
      fields.status ?? 'ready', ready ? `managed/${id}` : null, ready ? (fields.sha256 === undefined ? sha(bytes) : fields.sha256) : null, fields.error ?? null,
      fields.createdAt ?? new Date().toISOString(), `ext-${id}`]);
    return id;
  }

  beforeAll(async () => {
    ({ pool, close } = await createTestDatabase());
    const accounts = new AccountRepository(pool);
    accountId = (await accounts.reserveAccountSlot()).accountId;
    const epoch = (await accounts.getControlState()).controlEpoch;
    await accounts.activateControl(accountId, epoch);
    await accounts.bindWorker({ accountId, workerInstanceId: 'w1', controlEpoch: epoch });
    await accounts.applyWorkerLogin({ accountId, workerInstanceId: 'w1', controlEpoch: epoch }, OWN_MID, 'Agentsaxo');
    for (const chatId of ['g1', 'g2']) await pool.query("INSERT INTO conversations(account_id,chat_type,chat_id,title) VALUES ($1,'group',$2,'群組')", [accountId, chatId]);
    await pool.query("INSERT INTO conversation_members(account_id,chat_type,chat_id,member_id,display_name) VALUES ($1,'group','g1',$2,'小明')", [accountId, MEMBER_MID]);
  });
  afterAll(async () => { await close?.(); });
  beforeEach(async () => {
    workspace = await realpath(await mkdtemp(join(tmpdir(), 'linejs-reply-ws-')));
    store = await realpath(await mkdtemp(join(tmpdir(), 'linejs-reply-store-')));
    paths.clear();
    downloads.length = 0;
    onDownload = null;
    await pool.query("UPDATE line_accounts SET connection_mode='SYSTEM_LOGIN' WHERE account_id=$1", [accountId]);
    await pool.query('DELETE FROM attachments');
    await pool.query('DELETE FROM messages');
  });
  afterEach(async () => { await rm(workspace, { recursive: true, force: true }); await rm(store, { recursive: true, force: true }); });

  it('returns null when the message is no reply or is unknown', async () => {
    await message('plain', { text: '你好' });
    expect(await resolver()(input('plain'))).toBeNull();
    expect(await resolver()(input('unknown'))).toBeNull();
  });

  it('names the quoted sender, the Taipei time and the text', async () => {
    await message('q1', { text: '今天幾點出發' });
    await message('r1', { text: '@Agentsaxo 好嗎', reply: 'q1' });
    const result = await resolver()(input('r1'));
    expect(result).toEqual({ section: '\n\n---\n這則訊息是在回覆以下訊息：\n[小明] 11/5 09:03：今天幾點出發', files: [] });
  });

  it('uses the stored Agent display name for a quoted Agent message and cuts long text', async () => {
    await message('q2', { sender: OWN_MID, text: 'x'.repeat(2500) });
    await message('r2', { reply: 'q2' });
    const section = (await resolver()(input('r2')))!.section;
    expect(section).toContain(`[Agentsaxo] 11/5 09:03：${'x'.repeat(2000)}…`);
    expect(section).not.toContain('x'.repeat(2001));
  });

  it('copies a ready quoted image into the job directory after a size and SHA-256 check', async () => {
    await message('q3', { kind: 'image' });
    await attachment('q3', { name: 'photo.png' });
    await message('r3', { reply: 'q3' });
    const request = input('r3');
    const result = (await resolver()(request))!;
    expect(result.section).toContain('[小明] 11/5 09:03：[圖片]\n[圖片] photo.png（12 B）已附上');
    expect(result.files).toHaveLength(1);
    const file = result.files[0]!;
    expect(file).toMatchObject({ name: 'photo.png', kind: 'image', mime: 'image/png', size: PNG.byteLength, sha256: sha(PNG),
      relativePath: `${ATTACHMENT_DIRECTORY}/${request.jobId}/photo.png` });
    expect(file.absolutePath).toBe(join(workspace, ATTACHMENT_DIRECTORY, request.jobId, 'photo.png'));
    expect(await readFile(file.absolutePath)).toEqual(PNG);
  });

  it('skips a file whose hash differs and removes the copy', async () => {
    await message('q4', { kind: 'image' });
    await attachment('q4', { sha256: 'f'.repeat(64) });
    await message('r4', { reply: 'q4' });
    const request = input('r4');
    const result = (await resolver()(request))!;
    expect(result.files).toEqual([]);
    expect(result.section).toContain('[圖片] photo.png（12 B）未附上：檔案驗證失敗');
    expect(await readdir(join(workspace, ATTACHMENT_DIRECTORY)).catch(() => [])).toEqual([]);
  });

  it('skips a file whose size differs from the row', async () => {
    await message('q5', { kind: 'file' });
    await attachment('q5', { kind: 'file', name: 'a.txt', bytes: Buffer.from('hello'), size: 7 });
    await message('r5', { reply: 'q5' });
    const result = (await resolver()(input('r5')))!;
    expect(result.files).toEqual([]);
    expect(result.section).toContain('[檔案] a.txt（7 B）未附上：檔案驗證失敗');
  });

  it('gives a reason line for a queued file from an External Monitor source and for a file not yet downloaded', async () => {
    await message('q6', { kind: 'image' });
    await attachment('q6', { status: 'queued', error: 'EXTERNAL_SOURCE_DOWNLOAD_UNAVAILABLE', createdAt: '2026-11-05T01:00:00Z' });
    await attachment('q6', { status: 'downloading', kind: 'video', createdAt: '2026-11-05T01:00:01Z' });
    await message('r6', { reply: 'q6' });
    const result = (await resolver()(input('r6')))!;
    expect(result.files).toEqual([]);
    expect(result.section).toContain('\n[圖片] photo.png（12 B）未附上：外部監控來源無法下載\n[影片] photo.png（12 B）未附上：尚未下載');
  });

  it('skips a file over the size limit', async () => {
    await message('q7', { kind: 'file' });
    await attachment('q7', { kind: 'file', name: 'big.bin', bytes: Buffer.from('x'), size: 20 * 1024 * 1024 + 1 });
    await message('r7', { reply: 'q7' });
    const result = (await resolver()(input('r7')))!;
    expect(result.files).toEqual([]);
    expect(result.section).toContain('[檔案] big.bin（20.0 MB）未附上：檔案過大');
  });

  it('keeps recalled text and marks it', async () => {
    await message('q8', { text: '寫錯了', content: { format: 1, type: 'unsent' } });
    await message('q9', { text: '來源已刪', raw: { sourceDeleted: true } });
    await message('r8', { reply: 'q8' });
    await message('r9', { reply: 'q9' });
    expect((await resolver()(input('r8')))!.section).toContain('：寫錯了（已收回）');
    expect((await resolver()(input('r9')))!.section).toContain('：來源已刪（已收回）');
  });

  it('labels a message without text by its kind', async () => {
    await message('q10', { kind: 'sticker' });
    await message('r10', { reply: 'q10' });
    expect((await resolver()(input('r10')))!.section).toContain('：[貼圖]');
  });

  it('gives the missing line when the quoted message is not stored', async () => {
    await message('r11', { reply: 'gone' });
    expect(await resolver()(input('r11'))).toEqual({ section: '\n\n---\n這則訊息是在回覆以下訊息：\n（被回覆的訊息不在系統紀錄中）', files: [] });
  });

  it('does not use a quoted message from another chat', async () => {
    await message('q12', { chatId: 'g2', text: '別的群組的秘密' });
    await message('r12', { reply: 'q12' });
    const result = (await resolver()(input('r12')))!;
    expect(result.section).toContain('（被回覆的訊息不在系統紀錄中）');
    expect(result.section).not.toContain('秘密');
  });

  it('adds one detail line for location, contact, rich, media, event, unsupported content', async () => {
    const cases: Array<[string, string, object, string]> = [
      ['d1', 'location', { format: 1, type: 'location', title: '高雄車站', address: '高雄市三民區', latitude: 22.639, longitude: 120.302 }, '位置：高雄車站 / 高雄市三民區（22.639, 120.302）'],
      ['d2', 'location', { format: 1, type: 'location', title: null, address: null, latitude: 1.5, longitude: 2.5 }, '位置：（1.5, 2.5）'],
      ['d3', 'contact', { format: 1, type: 'contact', mid: null, displayName: '王小美' }, '聯絡人名片：王小美'],
      ['d4', 'rich', { format: 1, type: 'rich', variant: 'flex', altText: '優惠\n活動' }, '替代文字：優惠 活動'],
      ['d5', 'video', { format: 1, type: 'media', durationMs: 75_000 }, '長度：1:15'],
      ['d6', 'event', { format: 1, type: 'event', nativeContentType: 1, text: '通話結束' }, '事件：通話結束'],
      ['d7', 'event', { format: 1, type: 'unsupported', nativeContentType: 9, fallbackText: '請更新 LINE' }, '不支援的內容：請更新 LINE'],
    ];
    for (const [id, kind, content, expected] of cases) {
      await message(id, { kind, content });
      await message(`r-${id}`, { reply: id });
      expect((await resolver()(input(`r-${id}`)))!.section).toContain(`
${expected}`);
    }
  });

  it('limits a detail value to 500 characters on one line', async () => {
    await message('d8', { kind: 'rich', content: { format: 1, type: 'rich', variant: 'rich', altText: 'y'.repeat(900) } });
    await message('r-d8', { reply: 'd8' });
    expect((await resolver()(input('r-d8')))!.section).toContain(`替代文字：${'y'.repeat(500)}…`);
  });

  it('gives the sticker text and id, and 無文字 without text', async () => {
    await message('s1', { kind: 'sticker', raw: { message: { contentMetadata: { STKID: '52002734', STKPKGID: '11537', STKTXT: '[開心]' } } } });
    await message('s2', { kind: 'sticker', raw: { message: { contentMetadata: { STKID: '99' } } } });
    await message('r-s1', { reply: 's1' });
    await message('r-s2', { reply: 's2' });
    expect((await resolver()(input('r-s1')))!.section).toContain('\n貼圖：[開心]（STKID 52002734）');
    expect((await resolver()(input('r-s2')))!.section).toContain('\n貼圖：無文字（STKID 99）');
  });

  it('names a file with its size on an attached line', async () => {
    await message('f1', { kind: 'file' });
    await attachment('f1', { kind: 'file', name: '報價單.pdf', bytes: Buffer.alloc(120 * 1024, 1) });
    await message('r-f1', { reply: 'f1' });
    expect((await resolver()(input('r-f1')))!.section).toContain('\n[檔案] 報價單.pdf（120.0 KB）已附上');
  });

  it('waits for a downloading file and attaches it when it becomes ready within the wait', async () => {
    await message('w1', { kind: 'image' });
    const id = await attachment('w1', { status: 'downloading' });
    onDownload = async (downloadId) => { await makeReady(downloadId, PNG); return true; };
    await message('r-w1', { reply: 'w1' });
    const result = (await resolver()(input('r-w1')))!;
    expect(downloads).toEqual([id]);
    expect(result.files).toHaveLength(1);
    expect(result.section).toContain('[圖片] photo.png（12 B）已附上');
  });

  it('keeps 尚未下載 when the download does not finish in the wait', async () => {
    {
      await message('w2', { kind: 'image' });
      await attachment('w2', { status: 'queued', name: null });
      await message('r-w2', { reply: 'w2' });
      const result = (await resolver()(input('r-w2')))!;
      expect(result.files).toEqual([]);
      expect(result.section).toContain('[圖片]（12 B）未附上：尚未下載');
    }
  });

  it('does not download External Monitor, failed or expired rows', async () => {
    await message('w3', { kind: 'image' });
    await attachment('w3', { status: 'queued', error: 'EXTERNAL_SOURCE_DOWNLOAD_UNAVAILABLE' });
    await attachment('w3', { status: 'failed', error: 'boom' });
    await attachment('w3', { status: 'expired' });
    await message('r-w3', { reply: 'w3' });
    await resolver()(input('r-w3'));
    expect(downloads).toEqual([]);
    await pool.query("UPDATE line_accounts SET connection_mode='EXTERNAL_MONITOR' WHERE account_id=$1", [accountId]);
    await message('w4', { kind: 'image' });
    await attachment('w4', { status: 'queued' });
    await message('r-w4', { reply: 'w4' });
    await resolver()(input('r-w4'));
    expect(downloads).toEqual([]);
  });

  it('adds one nested reply line and no further level', async () => {
    await message('n0', { text: '最早的訊息' });
    await message('n1', { text: '中間的訊息', reply: 'n0', at: '2026-11-05T01:05:00Z' });
    await message('n2', { text: 'y'.repeat(400), reply: 'n1' });
    await message('r-n', { reply: 'n2' });
    const section = (await resolver()(input('r-n')))!.section;
    expect(section).toContain('（該訊息回覆了：[小明] 11/5 09:05：中間的訊息）');
    expect(section).not.toContain('最早的訊息');
  });

  it('cuts a nested reply text at 300 characters', async () => {
    await message('n3', { text: 'z'.repeat(400) });
    await message('n4', { text: '引用', reply: 'n3' });
    await message('r-n4', { reply: 'n4' });
    expect((await resolver()(input('r-n4')))!.section).toContain(`（該訊息回覆了：[小明] 11/5 09:03：${'z'.repeat(300)}…）`);
  });

  it('formats Taipei time with a 24-hour clock', () => {
    expect(formatReplyTime(new Date('2026-11-05T16:30:00Z'))).toBe('11/6 00:30');
  });
});
