import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import { createTestDatabase } from '../../../../../packages/database/src/test-database.js';
import { AccountRepository, AgentRepository, MessageRepository, SettingsRepository } from '../../../../../packages/database/src/index.js';
import { AppSnapshotSchema } from '@line-agent/contracts';
import { boundedNotificationProjectionSql, HealthService, mapConversation } from './health-service.js';

describe('localized preview metadata', () => {
  const row: Parameters<typeof mapConversation>[0] = {
    account_id: 'account', chat_type: 'direct', chat_id: 'chat', title: '原始客戶名稱', agent_enabled: false, default_provider: 'codex',
    unread_count: 0, latest_text: null, latest_kind: 'image', latest_occurred_at: new Date('2026-10-23T00:00:00Z'),
    latest_attachment_name: null, latest_attachment_kind: null, latest_attachment_status: null,
  };
  it('separates generated media labels from original message prose', () => {
    expect(mapConversation(row)).toMatchObject({ title: '原始客戶名稱', latestMessageDisplay: { kind: 'image' } });
    const userText = mapConversation({ ...row, latest_text: '圖片' });
    expect(userText.latestMessagePreview).toBe('圖片');
    expect(userText.latestMessageDisplay).toBeUndefined();
    expect(AppSnapshotSchema.shape.conversations.element.parse(userText)).toEqual(userText);
  });
  it('retains real filenames separately from attachment state', () => {
    expect(mapConversation({ ...row, latest_attachment_kind: 'file', latest_attachment_name: '圖片', latest_attachment_status: 'failed' }).latestMessageDisplay)
      .toEqual({ kind: 'file', name: '圖片', status: 'failed' });
    expect(mapConversation({ ...row, latest_attachment_kind: 'file', latest_attachment_status: 'queued' }).latestMessageDisplay)
      .toEqual({ kind: 'file', status: 'queued' });
  });
  it('passes the block reason of a queued non-image attachment to the preview and ignores other errors', () => {
    const queued = { ...row, latest_attachment_kind: 'file' as const, latest_attachment_status: 'queued' as const };
    expect(mapConversation({ ...queued, latest_attachment_error: 'ATTACHMENT_WORKER_UNAVAILABLE' }).latestMessageDisplay)
      .toEqual({ kind: 'file', status: 'queued', blockReason: 'ATTACHMENT_WORKER_UNAVAILABLE' });
    expect(mapConversation({ ...queued, latest_attachment_error: 'LINE_NATIVE_DOWNLOAD_FAILED' }).latestMessageDisplay)
      .toEqual({ kind: 'file', status: 'queued' });
    expect(mapConversation({ ...queued, latest_attachment_status: 'failed', latest_attachment_error: 'ATTACHMENT_WORKER_NOT_READY' }).latestMessageDisplay)
      .toEqual({ kind: 'file', status: 'failed' });
    expect(mapConversation({ ...queued, latest_attachment_kind: 'image', latest_attachment_error: 'ATTACHMENT_WORKER_NOT_READY' }).latestMessageDisplay)
      .toEqual({ kind: 'image' });
    expect(AppSnapshotSchema.shape.conversations.element.parse(mapConversation({ ...queued, latest_attachment_error: 'EXTERNAL_SOURCE_DOWNLOAD_UNAVAILABLE' })))
      .toMatchObject({ latestMessageDisplay: { blockReason: 'EXTERNAL_SOURCE_DOWNLOAD_UNAVAILABLE' } });
  });
  it('preserves native event prose while identifying generated fallback states', () => {
    const event = { format: 1 as const, type: 'event' as const, nativeContentType: 18, text: '原始群組事件' };
    expect(mapConversation({ ...row, latest_content: event }).latestMessageDisplay).toBeUndefined();
    expect(mapConversation({ ...row, latest_content: { ...event, text: null } }).latestMessageDisplay).toEqual({ kind: 'chat_event' });
    expect(mapConversation({ ...row, latest_source_deleted: true, latest_text: '原始文字' }).latestMessageDisplay).toEqual({ kind: 'deleted' });
  });
  it('replaces raw call prose with call facts for the chat-list preview', () => {
    const raw = 'Call History : 138000 millisecs, ...';
    const call = { media: 'audio' as const, result: 'NORMAL', durationMs: 138000 };
    const event = { format: 1 as const, type: 'event' as const, nativeContentType: 6, text: raw, call };
    const mapped = mapConversation({ ...row, latest_text: raw, latest_content: event, latest_is_own: true });
    expect(mapped.latestMessageDisplay).toEqual({ kind: 'call', call: { ...call, direction: 'outbound' } });
    expect(mapped.latestMessagePreview).not.toContain('millisecs');
    expect(mapped.latestSticonRanges).toEqual([]);
    expect(AppSnapshotSchema.shape.conversations.element.parse(mapped)).toEqual(mapped);
    expect(mapConversation({ ...row, latest_text: raw, latest_content: event }).latestMessageDisplay)
      .toEqual({ kind: 'call', call: { ...call, direction: 'inbound' } });
    const noFacts = mapConversation({ ...row, latest_text: raw, latest_content: { ...event, call: null } });
    expect(noFacts.latestMessageDisplay).toEqual({ kind: 'call' });
    expect(noFacts.latestMessagePreview).toBe('通話');
  });
  it('projects Note and Album notification labels from stored metadata and keeps recall priority', () => {
    const event = { format: 1 as const, type: 'event' as const, nativeContentType: 16, text: 'POSTNOTIFICATION' };
    const note = mapConversation({ ...row, latest_text: 'POSTNOTIFICATION', latest_content: event, latest_notification_projection: { serviceType: 'GB' } });
    const album = mapConversation({ ...row, latest_text: 'POSTNOTIFICATION', latest_content: event, latest_notification_projection: { serviceType: 'AB' } });
    expect(note).toMatchObject({ latestMessagePreview: '記事本通知', latestMessageDisplay: { kind: 'post_note' } });
    expect(album).toMatchObject({ latestMessagePreview: '相簿通知', latestMessageDisplay: { kind: 'post_album' } });
    expect(mapConversation({ ...row, latest_text: 'POSTNOTIFICATION', latest_content: event, latest_notification_projection: { serviceType: 'UNKNOWN' } }))
      .toMatchObject({ latestMessagePreview: '貼文通知', latestMessageDisplay: { kind: 'post' } });
    expect(mapConversation({ ...row, latest_content: event, latest_notification_projection: { serviceType: 'GB' }, latest_source_deleted: true }))
      .toMatchObject({ latestMessagePreview: '已刪除訊息', latestMessageDisplay: { kind: 'deleted' } });
    expect(mapConversation({ ...row, latest_text: 'POSTNOTIFICATION', latest_content: event,
      latest_notification_projection: { contentType: 16, metadataText: '{"serviceType":"AB"}' } }))
      .toMatchObject({ latestMessagePreview: '相簿通知', latestMessageDisplay: { kind: 'post_album' } });
    expect(mapConversation({ ...row, latest_text: 'POSTNOTIFICATION', latest_content: event,
      latest_notification_projection: { contentType: 16, metadataText: '{bad' } }))
      .toMatchObject({ latestMessagePreview: '貼文通知', latestMessageDisplay: { kind: 'post' } });
    expect(mapConversation({ ...row, latest_text: 'POSTNOTIFICATION', latest_content: event,
      latest_notification_projection: { contentType: 16, metadataText: 'base64:/w==' } }))
      .toMatchObject({ latestMessagePreview: '貼文通知', latestMessageDisplay: { kind: 'post' } });
  });
});

const database = process.env.TEST_DATABASE_URL ? describe : describe.skip;

describe('snapshot hot path', () => {
  it('queries all task history with bound filters and projects a bounded keyset page', async () => {
    const createdAt = new Date('2026-10-20T10:00:00.000Z');
    const query = vi.fn().mockResolvedValue({ rows: [{ job_id: 'job-a', account_id: null, chat_type: null, chat_id: null,
      provider: 'claude', prompt: 'needle prompt', status: 'completed', created_at: createdAt, cursor_created_at: '2026-10-20T10:00:00.123456Z', reply_preview: 'needle reply',
      origin: 'agent_room', attachments: [] }, { job_id: 'job-b', account_id: null, chat_type: null, chat_id: null,
      provider: 'claude', prompt: 'needle second', status: 'completed', created_at: new Date('2026-10-20T09:00:00.000Z'), cursor_created_at: '2026-10-20T09:00:00.000000Z', reply_preview: null,
      origin: 'agent_room', attachments: [] }] });
    const page = await new HealthService({ query } as unknown as Pool).searchAgentJobs({ keyword: 'needle', searchPrompt: true,
      searchReply: true, provider: 'claude', status: 'completed', createdFrom: '2026-10-20T00:00:00.000Z',
      createdToExclusive: '2026-10-21T00:00:00.000Z', limit: 1 });
    const sql = String(query.mock.calls[0]?.[0]);
    expect(sql).toContain('FROM agent_jobs j');
    expect(sql).toContain('ORDER BY j.created_at DESC, j.job_id DESC');
    expect(sql).toContain('LIMIT $');
    expect(sql).toContain('output.final_text ILIKE');
    expect(query.mock.calls[0]?.[1]).toContain('%needle%');
    expect(page.jobs).toMatchObject([{ jobId: 'job-a', replyPreview: 'needle reply', origin: 'agent_room' }]);
    expect(page.nextCursor).toEqual({ createdAt: '2026-10-20T10:00:00.123456Z', jobId: 'job-a' });
    expect(page.jobs).toHaveLength(1);
  });

  it('searches only the selected text source and binds creation and tie-break cursor filters', async () => {
    const query = vi.fn().mockResolvedValue({ rows: [] });
    await new HealthService({ query } as unknown as Pool).searchAgentJobs({ keyword: 'a%_b', searchPrompt: true, searchReply: false,
      provider: 'codex', status: 'failed', createdFrom: '2026-10-01T00:00:00.000Z', createdToExclusive: '2026-10-02T00:00:00.000Z',
      limit: 40, cursor: { createdAt: '2026-10-01T12:00:00.000Z', jobId: '11111111-1111-4111-8111-111111111111' } });
    const sql = String(query.mock.calls[0]?.[0]);
    const values = query.mock.calls[0]?.[1] as unknown[];
    expect(sql).toContain('j.prompt ILIKE');
    expect(sql).not.toContain('output.final_text ILIKE');
    expect(sql).toContain('(j.created_at, j.job_id) < (');
    expect(sql).toContain('j.created_at >=');
    expect(sql).toContain('j.created_at <');
    expect(values).toContain('%a!%!_b%');
    expect(values).toContain('codex');
    expect(values).toContain('failed');
    expect(values).toContain('2026-10-01T00:00:00.000Z');
    expect(values).toContain('2026-10-02T00:00:00.000Z');
    expect(values).toContain('2026-10-01T12:00:00.000Z');
    expect(values).toContain('11111111-1111-4111-8111-111111111111');
    expect(values.at(-1)).toBe(41);
  });

  it('projects bounded optional reply previews in the single jobs query', async () => {
    const longPreview = '🟢'.repeat(240);
    const query = vi.fn()
      .mockResolvedValueOnce({ rows: [] }) // Agent lineage
      .mockResolvedValueOnce({ rows: [{ control_epoch: '0', active_account_id: null }] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [
        { job_id: 'job-with-reply', account_id: null, chat_type: null, chat_id: null, provider: 'codex', prompt: 'with output', status: 'completed',
          created_at: new Date('2026-10-16T00:00:00.000Z'), origin: 'agent_room', reply_preview: longPreview },
        { job_id: 'job-without-reply', account_id: null, chat_type: null, chat_id: null, provider: 'claude', prompt: 'without output', status: 'completed',
          created_at: new Date('2026-10-16T00:00:01.000Z'), origin: 'agent_room', reply_preview: null },
      ] })
      .mockResolvedValueOnce({ rows: [{ count: '0' }] })
      .mockResolvedValueOnce({ rows: [{ provider: 'claude' }] });

    const snapshot = await new HealthService({ query } as unknown as Pool).snapshot();
    const withReply = snapshot.jobs.find((job) => job.jobId === 'job-with-reply')!;
    const withoutReply = snapshot.jobs.find((job) => job.jobId === 'job-without-reply')!;
    const jobQuery = String(query.mock.calls[4]?.[0]);

    expect(withReply.replyPreview).toBe(longPreview);
    expect(Array.from(withReply.replyPreview ?? '')).toHaveLength(240);
    expect(withoutReply).not.toHaveProperty('replyPreview');
    expect(jobQuery).toContain('LEFT JOIN agent_outputs output ON output.job_id = recent.job_id');
    expect(jobQuery).toContain('char_length(output.final_text) > 240');
    expect(query).toHaveBeenCalledTimes(7);
    expect(AppSnapshotSchema.parse(snapshot).jobs.find((job) => job.jobId === 'job-with-reply')?.replyPreview).toBe(longPreview);
  });

  it('returns the persisted global default Agent provider', async () => {
    const query = vi.fn()
      .mockResolvedValueOnce({ rows: [] }) // Agent lineage
      .mockResolvedValueOnce({ rows: [{ control_epoch: '0', active_account_id: null }] })
      .mockResolvedValueOnce({ rows: [] }).mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] }).mockResolvedValueOnce({ rows: [{ count: '0' }] })
      .mockResolvedValueOnce({ rows: [{ provider: 'codex' }] });
    const snapshot = await new HealthService({ query } as unknown as Pool).snapshot();

    expect(snapshot.defaultProvider).toBe('codex');
    expect(query).toHaveBeenCalledWith(expect.stringContaining("key = 'default_provider'"));
  });

  it('does not inspect provider login state', async () => {
    const query = vi.fn()
      .mockResolvedValueOnce({ rows: [] }) // Agent lineage
      .mockResolvedValueOnce({ rows: [{ control_epoch: '0', active_account_id: null }] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ account_id: 'a', chat_type: 'group', chat_id: 'g', title: '工程群組',
        agent_enabled: false, default_provider: 'codex', unread_count: 1, latest_text: null,
        latest_occurred_at: new Date('2026-10-16T00:00:00.000Z'), latest_attachment_name: '圖面.pdf',
        latest_attachment_kind: 'file', latest_attachment_status: 'downloading' }] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ count: '0' }] });
    query.mockResolvedValueOnce({ rows: [{ provider: 'claude' }] });
    const status = vi.fn(async (provider: 'codex' | 'claude') => ({
      provider, status: 'logged_out' as const, detail: null,
    }));
    const health = new HealthService({ query } as unknown as Pool);

    const snapshot = await health.snapshot();

    expect(status).not.toHaveBeenCalled();
    const conversationSql = String(query.mock.calls[3]?.[0]);
    expect(conversationSql).toContain("m.content->>'nativeContentType'='16'");
    expect(conversationSql).toContain("THEN jsonb_build_object('serviceType', m.raw#>>'{message,contentMetadata,serviceType}')");
    expect(conversationSql).toContain('latest.notification_projection latest_notification_projection');
    expect(conversationSql).not.toContain('latest.notification_raw latest_raw');
    expect(conversationSql).not.toContain('m.kind, m.raw,');
    expect(snapshot.providers.map((provider) => provider.status)).toEqual(['unknown', 'unknown']);
    expect(snapshot.conversations).toContainEqual(expect.objectContaining({ chatId: 'g',
      latestMessagePreview: '圖面.pdf（下載中）', latestAttachmentStatus: 'downloading' }));
  });
  it('labels a latest sticker (no text, attachment or content) instead of leaving the preview empty', async () => {
    const conversation = (chat_id: string, latest_kind: string) => ({ account_id: 'a', chat_type: 'group', chat_id, title: 'G',
      agent_enabled: false, default_provider: 'codex', unread_count: 0, latest_text: null, latest_content: null, latest_kind,
      latest_occurred_at: new Date('2026-10-16T00:00:00.000Z'), latest_attachment_name: null, latest_attachment_kind: null,
      latest_attachment_status: null });
    const query = vi.fn()
      .mockResolvedValueOnce({ rows: [] }) // Agent lineage
      .mockResolvedValueOnce({ rows: [{ control_epoch: '0', active_account_id: null }] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [conversation('g-sticker', 'sticker'), conversation('g-image', 'image'), conversation('g-text', 'text')] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ count: '0' }] })
      .mockResolvedValueOnce({ rows: [{ provider: 'codex' }] });

    const snapshot = await new HealthService({ query } as unknown as Pool).snapshot();

    const preview = (chatId: string) => snapshot.conversations.find((item) => item.chatId === chatId)?.latestMessagePreview;
    expect(preview('g-sticker')).toBe('貼圖');
    expect(preview('g-image')).toBe('圖片');
    expect(preview('g-text')).toBeNull();
  });
  it('previews a source-deleted latest message as deleted and a recalled one as recalled', async () => {
    const conversation = (chat_id: string, latest_content: unknown, latest_source_deleted: boolean) => ({ account_id: 'a', chat_type: 'group', chat_id,
      title: 'G', agent_enabled: false, default_provider: 'codex', unread_count: 0, latest_text: 'original', latest_content, latest_source_deleted,
      latest_kind: 'text', latest_occurred_at: new Date('2026-10-22T00:00:00.000Z'), latest_attachment_name: null, latest_attachment_kind: null,
      latest_attachment_status: null });
    const query = vi.fn()
      .mockResolvedValueOnce({ rows: [] }) // Agent lineage
      .mockResolvedValueOnce({ rows: [{ control_epoch: '0', active_account_id: null }] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [conversation('g-deleted', null, true), conversation('g-recalled', { format: 1, type: 'unsent' }, false),
        conversation('g-plain', null, false)] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ count: '0' }] })
      .mockResolvedValueOnce({ rows: [{ provider: 'codex' }] });

    const snapshot = await new HealthService({ query } as unknown as Pool).snapshot();

    const preview = (chatId: string) => snapshot.conversations.find((item) => item.chatId === chatId)?.latestMessagePreview;
    expect(preview('g-deleted')).toBe('已刪除訊息');
    expect(preview('g-recalled')).toBe('已收回訊息');
    expect(preview('g-plain')).toBe('original');
  });
  it('previews a type-0 member-removal event with its text and keeps unlabelled events generic', async () => {
    const conversation = (chat_id: string, latest_content: unknown) => ({ account_id: 'a', chat_type: 'group', chat_id, title: 'G',
      agent_enabled: false, default_provider: 'codex', unread_count: 0, latest_text: null, latest_content, latest_kind: 'event',
      latest_occurred_at: new Date('2026-10-22T00:00:00.000Z'), latest_attachment_name: null, latest_attachment_kind: null,
      latest_attachment_status: null });
    const query = vi.fn()
      .mockResolvedValueOnce({ rows: [] }) // Agent lineage
      .mockResolvedValueOnce({ rows: [{ control_epoch: '0', active_account_id: null }] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [
        conversation('g-removal', { format: 1, type: 'event', nativeContentType: 0, text: '甲已將乙強制退出社群。' }),
        conversation('g-chat-event', { format: 1, type: 'event', nativeContentType: 18, text: '小薪已新增徐佳誠至群組。' }),
        conversation('g-chat-event-bare', { format: 1, type: 'event', nativeContentType: 18, text: null }),
        conversation('g-gift', { format: 1, type: 'event', nativeContentType: 9, text: null }),
        conversation('g-empty', { format: 1, type: 'event', nativeContentType: 0, text: null })] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ count: '0' }] })
      .mockResolvedValueOnce({ rows: [{ provider: 'codex' }] });

    const snapshot = await new HealthService({ query } as unknown as Pool).snapshot();

    const preview = (chatId: string) => snapshot.conversations.find((item) => item.chatId === chatId)?.latestMessagePreview;
    expect(preview('g-removal')).toBe('甲已將乙強制退出社群。');
    expect(preview('g-chat-event')).toBe('小薪已新增徐佳誠至群組。');
    expect(preview('g-chat-event-bare')).toBe('聊天事件');
    expect(preview('g-gift')).toBe('禮物');
    expect(preview('g-empty')).toBe('系統訊息');
  });
  it('reflects provider auth health after an explicit check without probing during snapshots', async () => {
    const query = vi.fn()
      .mockResolvedValueOnce({ rows: [] }).mockResolvedValueOnce({ rows: [] }).mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] }).mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ count: '0' }] });
    query.mockResolvedValueOnce({ rows: [{ provider: 'claude' }] });
    const health = new HealthService({ query } as unknown as Pool);
    health.setProviderAuthStatus('claude', { status: 'logged_in', detail: null });

    const snapshot = await health.snapshot();

    expect(snapshot.providers).toContainEqual({ provider: 'claude', status: 'logged_in', detail: null });
    expect(snapshot.components).toContainEqual(expect.objectContaining({ name: 'claude', status: 'ready', message: null }));
    expect(snapshot.providers.find((provider) => provider.provider === 'codex')?.status).toBe('unknown');
  });
});

const SICON_PRODUCT = '0123456789abcdef01234567';
const privateUse = (...codePoints: number[]) => String.fromCodePoint(...codePoints);
/** The 「小密秘🥰」 latest message of 千年沉睡之旅: text 5c0f 5bc6 79d8 100103 1001c5 5feb 6a02 10ffff. */
const SICON_TEXT = `小密秘${privateUse(0x100103, 0x1001c5)}快樂${privateUse(0x10ffff)}`;
const sicon = (start: number, end: number, sticonId: string) => ({ S: start, E: end, productId: SICON_PRODUCT, sticonId, resourceType: 'STATIC' });
const sticonRaw = (text: string, resources: unknown[]) => ({ message: { text, contentMetadata: { REPLACE: JSON.stringify({ sticon: { resources } }) } } });
const hasPrivateUse = (value: string) => /[\u{F0000}-\u{10FFFF}]/u.test(value);

describe('chat-list preview sticons', () => {
  const latestRow = (chat_id: string, latest_text: string, latest_sticon_raw: unknown) => ({ account_id: 'a', chat_type: 'group', chat_id, title: 'G',
    agent_enabled: false, default_provider: 'codex', unread_count: 0, latest_message_id: `m-${chat_id}`, latest_text, latest_sticon_raw, latest_content: null,
    latest_kind: 'text', latest_occurred_at: new Date('2026-10-22T00:00:00.000Z'), latest_attachment_name: null, latest_attachment_kind: null,
    latest_attachment_status: null });
  const snapshotFor = async (rows: unknown[]) => {
    const query = vi.fn()
      .mockResolvedValueOnce({ rows: [] }) // Agent lineage
      .mockResolvedValueOnce({ rows: [{ control_epoch: '0', active_account_id: null }] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ count: '0' }] })
      .mockResolvedValueOnce({ rows: [{ provider: 'codex' }] });
    return await new HealthService({ query } as unknown as Pool).snapshot();
  };

  it('projects the latest message sticons with the shared projection and keeps private-use characters out of the preview', async () => {
    const snapshot = await snapshotFor([latestRow('g-sticon', SICON_TEXT,
      sticonRaw(SICON_TEXT, [sicon(3, 5, '1'), sicon(5, 7, '2'), sicon(9, 11, '3')]))]);
    const summary = snapshot.conversations[0]!;
    expect(summary.latestMessageId).toBe('m-g-sticon');
    expect(summary.latestMessagePreview).toBe('小密秘￼￼快樂￼');
    expect(hasPrivateUse(summary.latestMessagePreview ?? '')).toBe(false);
    expect(summary.latestSticonRanges).toEqual([
      { start: 3, end: 4, productId: SICON_PRODUCT, sticonId: '1', animated: false },
      { start: 4, end: 5, productId: SICON_PRODUCT, sticonId: '2', animated: false },
      { start: 7, end: 8, productId: SICON_PRODUCT, sticonId: '3', animated: false },
    ]);
    expect(AppSnapshotSchema.safeParse(snapshot).success).toBe(true);
  });
  it('yields no ranges and strips private-use characters from masked text', async () => {
    const masked = `[REDACTED] ${privateUse(0x100103)} 快樂`;
    const snapshot = await snapshotFor([latestRow('g-masked', masked, sticonRaw(masked, [sicon(11, 13, '1')]))]);
    const summary = snapshot.conversations[0]!;
    expect(summary.latestSticonRanges).toEqual([]);
    expect(summary.latestMessagePreview).toBe('[REDACTED]  快樂');
    expect(AppSnapshotSchema.safeParse(snapshot).success).toBe(true);
  });
  it('caps the preview at 16 sticon ranges and drops the private-use characters of the rest', async () => {
    const text = Array.from({ length: 20 }, (_, index) => privateUse(0x100100 + index)).join('');
    const snapshot = await snapshotFor([latestRow('g-many', text, sticonRaw(text,
      Array.from({ length: 20 }, (_, index) => sicon(index * 2, index * 2 + 2, String(index + 1)))))]);
    const summary = snapshot.conversations[0]!;
    expect(summary.latestSticonRanges).toHaveLength(16);
    expect(hasPrivateUse(summary.latestMessagePreview ?? '')).toBe(false);
    expect(AppSnapshotSchema.safeParse(snapshot).success).toBe(true);
  });
  it('strips private-use characters when the message has no sticon metadata', async () => {
    const snapshot = await snapshotFor([latestRow('g-plain', `hi ${privateUse(0x100103)}`, { message: { text: 'x' } })]);
    expect(snapshot.conversations[0]).toMatchObject({ latestMessagePreview: 'hi', latestSticonRanges: [] });
  });
});

database('authoritative health snapshot', () => {
  let pool: Pool; let close: () => Promise<void>;
  beforeAll(async () => { ({ pool, close } = await createTestDatabase()); });
  afterAll(async () => { await close?.(); });
  it('bounds notification SQL projections before oversized raw cells leave PostgreSQL', async () => {
    const live = { message: { contentType: 16, contentMetadata: { serviceType: 'GB', extra: 'x'.repeat(100_000) } }, unrelated: 'y'.repeat(100_000) };
    const nativeRaw = (metadata: unknown, typeCell: unknown = { sqliteType: 'integer', value: '16' }) => ({ native: { format: 2, encoding: 'plain', table: '_message', row: {
      columns: ['_contentType', '_contentMetadata'], cells: [typeCell, metadata],
    } } });
    const hugeAncillary = 'oversized-ancillary-field-' + 'z'.repeat(100_000);
    const noteMetadata = '{"serviceType":"GB"}';
    const inputs = [
      { name: 'live', raw: live, content: { format: 1, type: 'event', nativeContentType: 16 } },
      { name: 'native-oversized-string', raw: nativeRaw('x'.repeat(16_385)), content: { format: 1, type: 'event', nativeContentType: 16 } },
      { name: 'native-oversized-base64', raw: nativeRaw({ sqliteType: 'blob', encoding: 'base64', data: 'eA=='.repeat(6_000) }), content: { format: 1, type: 'event', nativeContentType: 16 } },
      { name: 'native-note', raw: nativeRaw('{"serviceType":"GB"}'), content: { format: 1, type: 'event', nativeContentType: 16 } },
      { name: 'native-album', raw: nativeRaw('{"serviceType":"AB"}'), content: { format: 1, type: 'event', nativeContentType: 16 } },
      { name: 'native-huge-type-cell-ancillary', raw: nativeRaw(noteMetadata, { sqliteType: 'integer', value: '16', data: hugeAncillary }), content: { format: 1, type: 'event', nativeContentType: 16 } },
      { name: 'native-huge-metadata-cell-ancillary', raw: nativeRaw({ sqliteType: 'text', encoding: 'base64', data: Buffer.from(noteMetadata).toString('base64'), extra: hugeAncillary }), content: { format: 1, type: 'event', nativeContentType: 16 } },
    ];
    const projections = await Promise.all(inputs.map(async ({ raw, content }) => {
      const result = await pool.query<{ projected: unknown; bytes: number | null }>(
        `SELECT projection.projected, octet_length(projection.projected::text) AS bytes
         FROM (SELECT 'event'::text AS kind, $2::jsonb AS content, $1::jsonb AS raw) m
         CROSS JOIN LATERAL (SELECT
           (SELECT (m.raw#>'{native,row,cells}') -> (c.ordinality - 1)::int
            FROM jsonb_array_elements_text(m.raw#>'{native,row,columns}') WITH ORDINALITY c(value, ordinality)
            WHERE c.value='_contentType' LIMIT 1) AS content_type,
           (SELECT (m.raw#>'{native,row,cells}') -> (c.ordinality - 1)::int
            FROM jsonb_array_elements_text(m.raw#>'{native,row,columns}') WITH ORDINALITY c(value, ordinality)
            WHERE c.value='_contentMetadata' LIMIT 1) AS metadata) native_fields
         CROSS JOIN LATERAL (SELECT ${boundedNotificationProjectionSql} AS projected) projection`, [raw, content]);
      return result.rows[0]!;
    }));
    expect(projections[0]!.bytes).toBeLessThan(200);
    expect(projections[0]!.projected).toEqual({ serviceType: 'GB' });
    expect(projections[1]!.projected).toBeNull();
    expect(projections[2]!.projected).toBeNull();
    expect(projections[3]!.bytes).toBeLessThan(200);
    expect(projections[4]!.bytes).toBeLessThan(200);
    expect(projections[5]!.projected).toEqual({ contentType: 16, metadataText: noteMetadata });
    expect(projections[6]!.projected).toEqual({ contentType: 16, metadataText: `base64:${Buffer.from(noteMetadata).toString('base64')}` });
    expect(projections[5]!.bytes).toBeLessThan(200);
    expect(projections[6]!.bytes).toBeLessThan(200);
    expect(JSON.stringify(projections[5]!.projected)).not.toContain(hugeAncillary);
    expect(JSON.stringify(projections[6]!.projected)).not.toContain(hugeAncillary);
    expect(projections[5]!.projected).not.toHaveProperty('native');
    expect(projections[5]!.projected).not.toHaveProperty('cells');
    for (const [index, expected] of [[3, 'note'], [4, 'album'], [5, 'note'], [6, 'note']] as const) {
      expect(mapConversation({ account_id: 'a', chat_type: 'group', chat_id: 'g', title: 'G', agent_enabled: false, default_provider: 'codex',
        unread_count: 0, latest_text: 'POSTNOTIFICATION', latest_content: inputs[index]!.content as never, latest_notification_projection: projections[index]!.projected,
        latest_occurred_at: null, latest_attachment_name: null, latest_attachment_kind: null, latest_attachment_status: null }))
        .toMatchObject({ latestMessageDisplay: { kind: expected === 'note' ? 'post_note' : 'post_album' } });
    }
  });
  it('finds old task matches beyond snapshot limits, respects sources and filters, and pages ties without duplicates', async () => {
    const rows = Array.from({ length: 105 }, (_, index) => ({ jobId: randomUUID(), at: new Date(Date.UTC(2010, 0, index + 1)),
      prompt: index === 0 ? 'target prompt' : `bulk ${index}`, provider: index === 0 ? 'codex' as const : 'claude' as const,
      status: index === 0 ? 'failed' as const : 'completed' as const }));
    rows[2]!.jobId = '00000000-0000-4000-8000-000000000002';
    rows[3]!.jobId = '00000000-0000-4000-8000-000000000003';
    rows[2]!.at = new Date('2010-01-03T10:00:00.000Z'); rows[3]!.at = new Date('2010-01-03T10:00:00.000Z');
    rows[2]!.prompt = 'tie target'; rows[3]!.prompt = 'tie target';
    const requestIds = rows.map(() => randomUUID());
    try {
      for (let index = 0; index < rows.length; index += 1) {
        const item = rows[index]!;
        await pool.query(`INSERT INTO agent_jobs (job_id, provider, source_type, source_request_id, prompt, workspace_path, generation, creation_epoch, status, created_at)
          VALUES ($1,$2,'ui',$3,$4,'C:\\work',0,NULL,$5,$6)`,
        [item.jobId, item.provider, requestIds[index], item.prompt, item.status, item.at]);
      }
      await pool.query('INSERT INTO agent_outputs (job_id, final_text) VALUES ($1, $2)', [rows[1]!.jobId, `${'x'.repeat(260)} target reply`]);
      const health = new HealthService(pool);
      const recent = await health.snapshot();
      expect(recent.jobs.some((job) => job.jobId === rows[0]!.jobId)).toBe(false);
      const promptMatches = await health.searchAgentJobs({ keyword: 'target', searchPrompt: true, searchReply: false, limit: 10 });
      expect(promptMatches.jobs.map((job) => job.jobId)).toEqual([rows[3]!.jobId, rows[2]!.jobId, rows[0]!.jobId]);
      const replyMatches = await health.searchAgentJobs({ keyword: 'target', searchPrompt: false, searchReply: true, limit: 10 });
      expect(replyMatches.jobs.map((job) => job.jobId)).toEqual([rows[1]!.jobId]);
      expect(Array.from(replyMatches.jobs[0]!.replyPreview ?? '')).toHaveLength(240);
      expect(replyMatches.jobs[0]!.replyPreview).not.toContain('target');
      const filtered = await health.searchAgentJobs({ keyword: 'target', searchPrompt: true, searchReply: true, provider: 'codex', status: 'failed',
        createdFrom: '2010-01-01T00:00:00.000Z', createdToExclusive: '2010-01-02T00:00:00.000Z', limit: 5 });
      expect(filtered.jobs.map((job) => job.jobId)).toEqual([rows[0]!.jobId]);
      const firstTie = await health.searchAgentJobs({ keyword: 'tie', searchPrompt: true, searchReply: false, limit: 1 });
      expect(firstTie.jobs.map((job) => job.jobId)).toEqual([rows[3]!.jobId > rows[2]!.jobId ? rows[3]!.jobId : rows[2]!.jobId]);
      expect(firstTie.nextCursor?.jobId).toBe(firstTie.jobs[0]?.jobId);
      const secondTie = await health.searchAgentJobs({ keyword: 'tie', searchPrompt: true, searchReply: false, limit: 1, cursor: firstTie.nextCursor! });
      expect(secondTie.jobs.map((job) => job.jobId)).toEqual([rows[3]!.jobId > rows[2]!.jobId ? rows[2]!.jobId : rows[3]!.jobId]);
      expect(secondTie.nextCursor).toBeNull();
    } finally {
      await pool.query('DELETE FROM agent_jobs WHERE job_id = ANY($1::uuid[])', [rows.map((item) => item.jobId)]);
    }
  });
  it('preserves microseconds across page-size-one cursors and orders exact timestamp ties by UUID both ways', async () => {
    const cases = [
      ['00000000-0000-4000-8000-000000000011', '2020-01-01 00:00:00.123900+00'],
      ['00000000-0000-4000-8000-000000000012', '2020-01-01 00:00:00.123900+00'],
      ['00000000-0000-4000-8000-000000000021', '2020-01-01 00:00:00.123800+00'],
      ['00000000-0000-4000-8000-000000000022', '2020-01-01 00:00:00.123800+00'],
    ] as const;
    const ids = cases.map(([id]) => id);
    try {
      for (const [id, at] of cases) {
        await pool.query(`INSERT INTO agent_jobs (job_id, provider, source_type, source_request_id, prompt, workspace_path, generation, creation_epoch, status, created_at)
          VALUES ($1,'claude','ui',$2,'precision target','C:\\work',0,NULL,'completed',$3::timestamptz)`, [id, randomUUID(), at]);
      }
      const health = new HealthService(pool);
      const collected: string[] = [];
      let cursor: NonNullable<Parameters<typeof health.searchAgentJobs>[0]['cursor']> | undefined;
      do {
        const page = await health.searchAgentJobs({ keyword: 'precision target', searchPrompt: true, searchReply: false, limit: 1, ...(cursor ? { cursor } : {}) });
        collected.push(...page.jobs.map((job) => job.jobId));
        cursor = page.nextCursor ?? undefined;
      } while (cursor);
      expect(collected).toEqual([ids[1], ids[0], ids[3], ids[2]]);
      expect(new Set(collected).size).toBe(ids.length);
    } finally {
      await pool.query('DELETE FROM agent_jobs WHERE job_id = ANY($1::uuid[])', [ids]);
    }
  });
  it('returns the globally saved Codex default from app_settings', async () => {
    const settings = new SettingsRepository(pool);
    const previous = await settings.getAppSetting('default_provider') as string | null;
    try {
      await settings.setAppSetting('default_provider', 'codex');
      expect((await new HealthService(pool).snapshot()).defaultProvider).toBe('codex');
    } finally {
      if (previous === null) await pool.query("DELETE FROM app_settings WHERE key='default_provider'");
      else await settings.setAppSetting('default_provider', previous);
    }
  });
  it('reads control epoch, accounts, conversations and queue depth from PostgreSQL', async () => {
    const accounts = new AccountRepository(pool); const messages = new MessageRepository(pool);
    await accounts.ensureAccount('a', 'Account A'); await accounts.setOwnMid('a', 'agent-mid');
    await pool.query("UPDATE line_accounts SET product_role='AGENT' WHERE account_id='a'");
    await accounts.activateControl('a', 1);
    await messages.ingestAndRoute({ eventId: 'e', accountId: 'a', chatType: 'direct', chatId: 'c', senderId: 'u', messageId: 'm',
      kind: 'text', text: 'work', mentionIds: [], mentionRanges: [], replyToMessageId: null,
      ingestion: { source: 'live', cursor: null }, occurredAt: '2026-10-15T00:00:00.000Z', attachments: [], raw: {} },
      { eligible: true, provider: 'codex', prompt: 'work', workspacePath: 'C:\\trusted' });
    const health = new HealthService(pool);
    const snapshot = await health.snapshot();
    expect(snapshot.control).toEqual({ epoch: 1, activeAccountId: 'a', phase: 'idle', targetAccountId: null });
    expect(snapshot.queueDepth).toBe(1);
    expect(snapshot.accounts).toMatchObject([{ accountId: 'a', mode: 'ACTIVE_CONTROL' }]);
    expect(snapshot.accounts[0]?.productRole).toBe('AGENT');
    expect(snapshot.conversations).toContainEqual(expect.objectContaining({ accountId: 'a', chatType: 'direct', chatId: 'c' }));
    // The per-account legacy local-room rows are hidden: the shared Agent room is not an account conversation.
    expect(snapshot.conversations.some((conversation) => conversation.chatId === '__local_agent_room__')).toBe(false);
    expect(snapshot.jobs).toContainEqual(expect.objectContaining({ prompt: 'work' }));
    expect(snapshot.providers).toHaveLength(2);
  });
  it('projects only a selected completed Primary Admin monitor checkpoint while preserving Agent sync time', async () => {
    const accounts = new AccountRepository(pool);
    await accounts.ensureAccount('monitor-complete', 'Monitor complete');
    const selectedSourceId = randomUUID();
    const incompleteSourceId = randomUUID();
    const completedAt = new Date('2026-10-25T04:05:06.000Z');
    const agentSyncedAt = new Date('2026-10-24T03:02:01.000Z');
    await accounts.ensureAccount('a', 'Agent');
    await pool.query(`INSERT INTO line_account_sources(source_id,account_id,source_type,generation,identity_digest,verified_account_mid)
      VALUES ($1,'monitor-complete','EXTERNAL_MONITOR',7,$3,'admin-mid'),($2,'monitor-complete','EXTERNAL_MONITOR',8,$3,'admin-mid')`,
      [selectedSourceId, incompleteSourceId, 'a'.repeat(64)]);
    await pool.query(`UPDATE line_accounts SET product_role='PRIMARY_ADMIN',connection_mode='EXTERNAL_MONITOR',
      selected_source_id=$1,selected_source_generation=7 WHERE account_id='monitor-complete'`, [selectedSourceId]);
    await pool.query(`INSERT INTO external_source_checkpoints(source_id,account_id,generation,cursor,initial_import_complete,updated_at)
      VALUES ($1,'monitor-complete',7,'{}',true,$2)`, [selectedSourceId, completedAt]);
    // The completed source remains unselected after switching to the incomplete source.
    await pool.query(`INSERT INTO external_source_checkpoints(source_id,account_id,generation,cursor,initial_import_complete)
      VALUES ($1,'monitor-complete',8,'{}',false)`, [incompleteSourceId]);
    await pool.query("UPDATE line_accounts SET product_role='AGENT',last_synced_at=$1 WHERE account_id='a'", [agentSyncedAt]);

    const health = new HealthService(pool);
    const selectedSnapshot = await health.snapshot();
    expect(selectedSnapshot.accounts.find((account) => account.accountId === 'monitor-complete')?.lastSyncedAt).toBe(completedAt.toISOString());
    expect(selectedSnapshot.accounts.find((account) => account.accountId === 'a')?.lastSyncedAt).toBe(agentSyncedAt.toISOString());

    await pool.query(`UPDATE line_accounts SET selected_source_id=$1,selected_source_generation=8 WHERE account_id='monitor-complete'`,
      [incompleteSourceId]);
    const changedSelectionSnapshot = await health.snapshot();

    expect(changedSelectionSnapshot.accounts.find((account) => account.accountId === 'monitor-complete')?.lastSyncedAt).toBeNull();
    expect(changedSelectionSnapshot.accounts.find((account) => account.accountId === 'a')?.lastSyncedAt).toBe(agentSyncedAt.toISOString());
    await pool.query("DELETE FROM line_accounts WHERE account_id='monitor-complete'");
  });
  it('uses the account picture for its own direct conversation avatar', async () => {
    await pool.query("UPDATE line_accounts SET picture_path='https://profile.line-scdn.net/own-avatar' WHERE account_id='a'");
    await pool.query("INSERT INTO conversations(account_id,chat_type,chat_id,title) VALUES('a','direct','agent-mid','Primary Admin') ON CONFLICT DO NOTHING");
    const snapshot = await new HealthService(pool).snapshot();
    expect(snapshot.conversations.find((conversation) => conversation.accountId === 'a' && conversation.chatType === 'direct' && conversation.chatId === 'agent-mid')?.avatarAvailable).toBe(true);
    expect(snapshot.conversations.find((conversation) => conversation.accountId === 'a' && conversation.chatType === 'direct' && conversation.chatId === 'c')?.avatarAvailable).toBe(false);
  });
  it('lists shared Agent room jobs with no account next to LINE jobs, even when busy LINE traffic fills the recent window', async () => {
    const agents = new AgentRepository(pool);
    const room = await agents.enqueueUiJob({ provider: 'codex', requestId: 'snapshot-room', prompt: 'room prompt', workspacePath: 'C:\\trusted' });
    await pool.query(`INSERT INTO messages (account_id, message_id, event_id, chat_id, chat_type, sender_id, kind, text_content, ingestion_source, occurred_at, raw)
      SELECT 'a', 'busy-' || n, 'busy-event-' || n, 'c', 'direct', 'u', 'text', 'busy', 'live', now(), '{}'::jsonb FROM generate_series(1, 120) n`);
    await pool.query(`INSERT INTO agent_jobs (job_id, account_id, chat_type, chat_id, provider, source_type, source_message_id, prompt, workspace_path, generation, creation_epoch, status, created_at)
      SELECT gen_random_uuid(), 'a', 'direct', 'c', 'codex', 'line', 'busy-' || n, 'busy line', 'C:\\trusted', 0, 1, 'cancelled', now() + (n || ' seconds')::interval
      FROM generate_series(1, 120) n`);
    const jobs = (await new HealthService(pool).snapshot()).jobs;
    expect(jobs).toContainEqual(expect.objectContaining({ jobId: room.jobId, accountId: null, chatType: null, chatId: null, prompt: 'room prompt' }));
  });
  it('projects completed replies as bounded optional job previews', async () => {
    const agents = new AgentRepository(pool);
    const long = await agents.enqueueUiJob({ provider: 'codex', requestId: 'snapshot-reply-long', prompt: 'long reply', workspacePath: 'C:\\trusted' });
    const empty = await agents.enqueueUiJob({ provider: 'claude', requestId: 'snapshot-reply-empty', prompt: 'missing reply', workspacePath: 'C:\\trusted' });
    const longText = '🟢'.repeat(320);
    await pool.query("UPDATE agent_jobs SET status='completed' WHERE job_id = ANY($1::uuid[])", [[long.jobId, empty.jobId]]);
    await pool.query('INSERT INTO agent_outputs (job_id, final_text) VALUES ($1, $2)', [long.jobId, longText]);

    const snapshot = await new HealthService(pool).snapshot();
    const projectedLong = snapshot.jobs.find((job) => job.jobId === long.jobId)!;
    const projectedEmpty = snapshot.jobs.find((job) => job.jobId === empty.jobId)!;

    expect(projectedLong.replyPreview).toBe(`${Array.from(longText).slice(0, 239).join('')}…`);
    expect(Array.from(projectedLong.replyPreview ?? '')).toHaveLength(240);
    expect(projectedEmpty).not.toHaveProperty('replyPreview');
    expect(Array.from(AppSnapshotSchema.parse(snapshot).jobs.find((job) => job.jobId === long.jobId)?.replyPreview ?? '')).toHaveLength(240);
  });
  it('keeps provider state unknown until an Agent operation requires authentication', async () => {
    const health = new HealthService(pool);
    const snapshot = await health.snapshot();
    expect(snapshot.control.activeAccountId).toBe('a');
    expect(snapshot.accounts).toMatchObject([{ accountId: 'a' }]);
    expect(snapshot.providers).toMatchObject([
      { provider: 'codex', status: 'unknown' },
      { provider: 'claude', status: 'unknown' },
    ]);
    expect(snapshot.components).toContainEqual(expect.objectContaining({ name: 'codex', status: 'stopped' }));
  });
  it('does not expose a conversation whose archive contains only protocol events', async () => {
    const messages = new MessageRepository(pool);
    await messages.ingestAndRoute({ eventId: 'read-event', accountId: 'a', chatType: 'direct', chatId: 'event-only',
      senderId: 'u', messageId: 'read-message', kind: 'event', text: null, mentionIds: [], mentionRanges: [],
      replyToMessageId: null, ingestion: { source: 'live', cursor: 'event-cursor' },
      occurredAt: '2026-10-15T00:01:00.000Z', attachments: [], raw: { type: 'NOTIFIED_READ_MESSAGE' } },
      { eligible: false });
    const health = new HealthService(pool);

    const snapshot = await health.snapshot();

    expect(snapshot.conversations.some((conversation) => conversation.chatId === 'event-only')).toBe(false);
  });
  it('serves real latest-message sticon ranges that the strict snapshot schema accepts', async () => {
    const messages = new MessageRepository(pool);
    const text = SICON_TEXT;
    await messages.ingestAndRoute({ eventId: 'sticon-preview-event', accountId: 'a', chatType: 'group', chatId: 'sticon-preview',
      senderId: 'u', messageId: 'sticon-preview-message', kind: 'text', text, mentionIds: [], mentionRanges: [],
      replyToMessageId: null, ingestion: { source: 'live', cursor: 'sticon-preview-cursor' },
      occurredAt: '2026-10-22T00:00:00.000Z', attachments: [],
      raw: sticonRaw(text, [sicon(3, 5, '1'), sicon(5, 7, '2'), sicon(9, 11, '3')]) }, { eligible: false });

    const snapshot = await new HealthService(pool).snapshot();

    const summary = snapshot.conversations.find((item) => item.chatId === 'sticon-preview')!;
    expect(summary.latestMessageId).toBe('sticon-preview-message');
    expect(summary.latestSticonRanges).toHaveLength(3);
    expect(hasPrivateUse(summary.latestMessagePreview ?? '')).toBe(false);
    expect(AppSnapshotSchema.parse(snapshot).conversations.find((item) => item.chatId === 'sticon-preview')?.latestSticonRanges).toHaveLength(3);
  });
  it.each([
    ['CALL', 6, '通話'], ['GIFT', 9, '禮物'], ['POSTNOTIFICATION', 16, '貼文通知'], ['CHATEVENT', 18, '聊天事件'],
    ['LOCATION', 15, '位置'], ['RICH', 17, '圖文訊息'], ['LINK', 12, '此訊息類型尚未支援'],
  ])('shows a label as the conversation preview when the latest message is a text-less %s content', async (name, type, label) => {
    const messages = new MessageRepository(pool);
    const kind = type === 15 ? 'location' : type === 17 ? 'rich' : 'event';
    await messages.ingestAndRoute({ eventId: `preview-${name}`, accountId: 'a', chatType: 'direct', chatId: `preview-${name}`,
      senderId: 'u', messageId: `preview-message-${name}`, kind, text: null, mentionIds: [], mentionRanges: [],
      replyToMessageId: null, ingestion: { source: 'live', cursor: `preview-cursor-${name}` },
      occurredAt: '2026-10-15T00:02:00.000Z', attachments: [], raw: { message: { contentType: type } } }, { eligible: false });

    const snapshot = await new HealthService(pool).snapshot();

    expect(snapshot.conversations).toContainEqual(expect.objectContaining({ chatId: `preview-${name}`, latestMessagePreview: label }));
  });
  it('exposes a LINE catalog conversation before it receives a new message', async () => {
    const messages = new MessageRepository(pool);
    await messages.upsertConversationCatalog('a', [{ chatType: 'group', chatId: 'catalog-chat', title: '工程群組',
      members: [{ memberId: 'u-member', displayName: '王小明' }] }]);
    const health = new HealthService(pool);

    const snapshot = await health.snapshot();

    expect(snapshot.conversations).toContainEqual(expect.objectContaining({ chatId: 'catalog-chat', title: '工程群組' }));
  });

  it('titles an untitled 1:1 conversation from the account contact nickname, then profile name, per account', async () => {
    const accounts = new AccountRepository(pool);
    await accounts.ensureAccount('names-a');
    await accounts.ensureAccount('names-b');
    await pool.query(`INSERT INTO line_contacts(account_id,mid,display_name,nickname) VALUES
      ('names-a','u-nick','Real Name','張襄君'),('names-a','u-plain','Plain Name',NULL),('names-b','u-nick','Real Name','Other Nick')`);
    await pool.query(`INSERT INTO conversations(account_id,chat_type,chat_id,title) VALUES
      ('names-a','direct','u-nick',''),('names-a','direct','u-plain',''),('names-a','direct','u-stored','Stored Title'),
      ('names-b','direct','u-nick','Other Nick'),('names-a','group','u-nick','Group Named u-nick')`);
    const snapshot = await new HealthService(pool).snapshot();
    const title = (accountId: string, chatType: string, chatId: string) =>
      snapshot.conversations.find((item) => item.accountId === accountId && item.chatType === chatType && item.chatId === chatId)?.title;
    expect(title('names-a', 'direct', 'u-nick')).toBe('張襄君');
    expect(title('names-a', 'direct', 'u-plain')).toBe('Plain Name');
    expect(title('names-a', 'direct', 'u-stored')).toBe('Stored Title');
    expect(title('names-b', 'direct', 'u-nick')).toBe('Other Nick');
    // Only direct chats take the contact rule; a group keeps its own stored name.
    expect(title('names-a', 'group', 'u-nick')).toBe('Group Named u-nick');
  });

  it('does not display a legacy room toggle as confirmed Agent authority', async () => {
    const accounts = new AccountRepository(pool);
    await accounts.ensureAccount('legacy-account');
    const messages = new MessageRepository(pool);
    await messages.upsertConversationCatalog('legacy-account', [{ chatType: 'group', chatId: 'legacy-enabled-room', title: 'Legacy room', members: [] }]);
    await pool.query("UPDATE conversations SET agent_enabled=true WHERE account_id='legacy-account' AND chat_type='group' AND chat_id='legacy-enabled-room'");
    const snapshot = await new HealthService(pool).snapshot();
    expect(snapshot.conversations.find((conversation) => conversation.chatId === 'legacy-enabled-room')?.agentEnabled).toBe(false);
  });
  it('never probes provider login state while building snapshots', async () => {
    const calls: string[] = [];
    const health = new HealthService(pool);

    const first = await health.snapshot();
    const second = await health.snapshot();

    expect(calls).toEqual([]);
    expect(first.providers.map((provider) => provider.status)).toEqual(['unknown', 'unknown']);
    expect(second.providers.map((provider) => provider.status)).toEqual(['unknown', 'unknown']);
  });
  it('reflects a provider status only after an explicit authentication check', async () => {
    const health = new HealthService(pool);
    health.setProviderAuthStatus('claude', { status: 'logged_in', detail: null });

    const snapshot = await health.snapshot();

    expect(snapshot.providers.find((provider) => provider.provider === 'claude')).toEqual({
      provider: 'claude', status: 'logged_in', detail: null,
    });
    expect(snapshot.components.find((component) => component.name === 'claude')).toMatchObject({ status: 'ready', message: null });
    expect(snapshot.providers.find((provider) => provider.provider === 'codex')?.status).toBe('unknown');
  });
});
