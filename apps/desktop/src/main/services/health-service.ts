import { CONVERSATION_PICTURE_SQL, CONVERSATION_TITLE_SQL, PEER_CONTACT_JOIN, resolveAgentLineage, sharedAdminChatSql } from '@line-agent/database';
import type { Pool } from 'pg';
import { boundedSticonRawSql, previewWithSticons, projectSticons } from '../sticon-projection.js';
import { isLocalOnlyConversation, type AgentJobSearchQuery, type AgentJobSummary, type AgentProvider, type AppSnapshot, type ComponentHealth, type ControlSnapshot,
  type ConversationKey, type ConversationSummary, type GeneratedPreview, type MessageContent, type ProviderStatus } from '@line-agent/contracts';

interface LineWorkerProbe {
  status(): Promise<ComponentHealth> | ComponentHealth;
}

type ConversationRow = {
  account_id: string;
  chat_type: ConversationKey['chatType'];
  chat_id: string;
  title: string;
  agent_enabled: boolean;
  default_provider: AgentProvider;
  unread_count: number;
  latest_text: string | null;
  latest_message_id?: string | null;
  latest_sticon_raw?: unknown;
  latest_source_deleted?: boolean | null;
  latest_content?: MessageContent | null;
  latest_kind?: string | null;
  latest_notification_projection?: unknown;
  latest_occurred_at: Date | null;
  latest_attachment_name: string | null;
  latest_attachment_kind: 'image' | 'video' | 'audio' | 'file' | null;
  latest_attachment_status: 'queued' | 'downloading' | 'ready' | 'failed' | 'expired' | null;
  picture_path?: string | null;
};

const attachmentKindLabel = { image: '圖片', video: '影片', audio: '語音', file: '檔案' } as const;
const attachmentStatusLabel = { queued: '等待下載', downloading: '下載中', ready: '', failed: '下載失敗', expired: '已過期' } as const;

const systemEventLabel: Readonly<Record<number, string>> = { 6: '通話', 9: '禮物', 16: '貼文通知', 18: '聊天事件' };
export const boundedNotificationProjectionSql = `CASE WHEN m.kind='event' AND m.content->>'type'='event' AND m.content->>'nativeContentType'='16'
      AND jsonb_typeof(m.raw->'message')='object'
      AND m.raw#>>'{message,contentType}' IN ('16','POSTNOTIFICATION')
      AND m.raw->'contentState' IS NULL
      AND NOT (m.raw ? 'sourceDeleted')
      AND m.raw#>>'{message,contentMetadata,serviceType}' IN ('GB','AB','SN')
      THEN jsonb_build_object('serviceType', m.raw#>>'{message,contentMetadata,serviceType}')
      WHEN m.kind='event' AND m.content->>'type'='event' AND m.content->>'nativeContentType'='16'
        AND m.raw#>>'{native,encoding}'='plain' AND m.raw#>>'{native,table}'='_message'
        AND NOT (m.raw ? 'sourceDeleted') AND native_fields.content_type IS NOT NULL AND native_fields.metadata IS NOT NULL
        AND (native_fields.content_type=to_jsonb(16) OR native_fields.content_type=to_jsonb('16'::text)
          OR (native_fields.content_type->>'sqliteType'='integer' AND native_fields.content_type->>'value'='16'))
        AND ((jsonb_typeof(native_fields.metadata)='string' AND octet_length(native_fields.metadata #>> '{}')<=16384)
          OR (jsonb_typeof(native_fields.metadata)='object' AND native_fields.metadata->>'sqliteType' IN ('text','blob')
            AND native_fields.metadata->>'encoding'='base64' AND jsonb_typeof(native_fields.metadata->'data')='string'
            AND octet_length(native_fields.metadata->>'data')<=21848
            AND native_fields.metadata->>'data' ~ '^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$'
            AND ((length(native_fields.metadata->>'data') / 4) * 3
              - CASE WHEN right(native_fields.metadata->>'data',2)='==' THEN 2
                WHEN right(native_fields.metadata->>'data',1)='=' THEN 1 ELSE 0 END)<=16384))
      THEN jsonb_build_object('contentType', 16, 'metadataText', CASE WHEN jsonb_typeof(native_fields.metadata)='string'
        THEN native_fields.metadata #>> '{}' ELSE 'base64:' || (native_fields.metadata->>'data') END)
      ELSE NULL END`;
/** Conversation-list label for a projected content type that has no text body. */
function contentPreview(content: MessageContent | null | undefined, postNotificationType?: 'note' | 'album' | null): string | null {
  switch (content?.type) {
    case undefined: return null;
    case 'event': return (content.nativeContentType === 16 && postNotificationType === 'note' ? '記事本通知' : undefined)
      ?? (content.nativeContentType === 16 && postNotificationType === 'album' ? '相簿通知' : undefined)
      ?? (content.nativeContentType === 18 ? content.text?.trim() || undefined : undefined)
      ?? (content.nativeContentType === null ? undefined : systemEventLabel[content.nativeContentType])
      ?? (content.nativeContentType === 0 ? content.text?.trim() || null : null) ?? '系統訊息';
    case 'unsent': return '已收回訊息';
    case 'rich': return '圖文訊息';
    case 'contact': return 'LINE 聯絡人';
    case 'location': return '位置';
    case 'unsupported': return '此訊息類型尚未支援';
    case 'media': return null;
  }
}

/** Conversation-list label for a media-only message (no text, attachment row or projected content), e.g. a native sticker. */
export function kindPreview(kind: string | null | undefined): string | null {
  switch (kind) {
    case 'sticker': return '貼圖';
    case 'image': return '圖片';
    case 'video': return '影片';
    case 'audio': return '語音';
    case 'file': return '檔案';
    case 'contact': return 'LINE 聯絡人';
    case 'location': return '位置';
    default: return null;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function postNotificationSubtypeFromProjection(value: unknown): 'note' | 'album' | null {
  if (!isRecord(value)) return null;
  let metadata: unknown;
  if (Object.keys(value).length === 1 && (value.serviceType === 'GB' || value.serviceType === 'AB' || value.serviceType === 'SN')) {
    metadata = value;
  } else if (Object.keys(value).length === 2 && value.contentType === 16 && typeof value.metadataText === 'string') {
    let metadataText = value.metadataText;
    if (metadataText.startsWith('base64:')) {
      const encoded = metadataText.slice('base64:'.length);
      if (encoded.length > 21_848 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(encoded)) return null;
      const decoded = Buffer.from(encoded, 'base64');
      if (decoded.byteLength > 16_384) return null;
      try { metadataText = new TextDecoder('utf-8', { fatal: true }).decode(decoded); } catch { return null; }
    } else if (Buffer.byteLength(metadataText, 'utf8') > 16_384) return null;
    try { metadata = JSON.parse(metadataText); } catch { return null; }
  } else return null;
  if (!isRecord(metadata)) return null;
  return metadata.serviceType === 'GB' || metadata.serviceType === 'SN' ? 'note' : metadata.serviceType === 'AB' ? 'album' : null;
}

export function mapConversation(row: ConversationRow): ConversationSummary {
  const postNotificationType = row.latest_content?.type === 'event' && row.latest_content.nativeContentType === 16
    && !row.latest_source_deleted
    ? postNotificationSubtypeFromProjection(row.latest_notification_projection) : null;
  // Same projection as the timeline; sticon characters become placeholders and other private-use code points are dropped.
  const projected = row.latest_text ? projectSticons(isRecord(row.latest_sticon_raw) ? row.latest_sticon_raw : {}, row.latest_text) : [];
  const previewed = row.latest_text ? previewWithSticons(row.latest_text, projected) : { text: '', ranges: [] };
  const postPlaceholder = row.latest_content?.type === 'event' && row.latest_content.nativeContentType === 16
    && row.latest_text?.trim().toUpperCase() === 'POSTNOTIFICATION';
  const text = postPlaceholder ? '' : previewed.text;
  const attachment = row.latest_attachment_kind
    ? row.latest_attachment_kind === 'image' ? attachmentKindLabel.image : row.latest_attachment_name?.trim() || attachmentKindLabel[row.latest_attachment_kind]
    : null;
  const status = row.latest_attachment_kind !== 'image' && row.latest_attachment_status ? attachmentStatusLabel[row.latest_attachment_status] : '';
  const preview = row.latest_source_deleted ? '已刪除訊息' : row.latest_content?.type === 'unsent' ? '已收回訊息' : text || (attachment ? `${attachment}${status ? `（${status}）` : ''}` : null) || contentPreview(row.latest_content, postNotificationType) || kindPreview(row.latest_kind);
  let display: GeneratedPreview | undefined;
  if (row.latest_source_deleted) display = { kind: 'deleted' };
  else if (row.latest_content?.type === 'unsent') display = { kind: 'unsent' };
  else if (!text && row.latest_attachment_kind) display = { kind: row.latest_attachment_kind,
    ...(row.latest_attachment_kind !== 'image' && row.latest_attachment_name?.trim() ? { name: row.latest_attachment_name.trim() } : {}),
    ...(row.latest_attachment_kind !== 'image' && row.latest_attachment_status ? { status: row.latest_attachment_status } : {}) };
  else if (!text && preview) {
    const content = row.latest_content;
    if (content?.type === 'event') {
      // Native event prose is historical content; only generated fallback labels are localized.
      if (!((content.nativeContentType === 18 || content.nativeContentType === 0) && content.text?.trim())) {
        const kinds: Record<number, GeneratedPreview['kind']> = { 6: 'call', 9: 'gift', 16: 'post', 18: 'chat_event' };
        display = { kind: content.nativeContentType === 16 && postNotificationType === 'note' ? 'post_note'
          : content.nativeContentType === 16 && postNotificationType === 'album' ? 'post_album' : kinds[content.nativeContentType ?? -1] ?? 'system' };
      }
    } else {
      const kind = content && content.type !== 'media' ? content.type : row.latest_kind;
      if (kind && ['image', 'video', 'audio', 'file', 'sticker', 'contact', 'location', 'rich', 'unsupported'].includes(kind)) display = { kind: kind as GeneratedPreview['kind'] };
    }
  }
  return { accountId: row.account_id, chatType: row.chat_type, chatId: row.chat_id,
    title: row.title, agentEnabled: row.agent_enabled, defaultProvider: row.default_provider,
    unreadCount: row.unread_count, localOnly: isLocalOnlyConversation({ chatType: row.chat_type, chatId: row.chat_id }),
    latestMessagePreview: preview,
    ...(display ? { latestMessageDisplay: display } : {}),
    latestMessageId: row.latest_message_id ?? null,
    latestSticonRanges: text && preview === text && row.latest_message_id ? previewed.ranges : [],
latestMessageAt: row.latest_occurred_at?.toISOString() ?? null,
    latestAttachmentStatus: row.latest_attachment_status, avatarAvailable: Boolean(row.picture_path) };
}

const conversationSelect = `SELECT c.account_id, c.chat_type, c.chat_id, COALESCE(${CONVERSATION_TITLE_SQL}, '') AS title,
    CASE WHEN c.chat_type IN ('group','room') THEN COALESCE(room_policy.state = 'ENABLED', false) ELSE c.agent_enabled END AS agent_enabled,
    c.default_provider,
    c.unread_count, ${CONVERSATION_PICTURE_SQL} picture_path, latest.message_id latest_message_id, latest.sticon_raw latest_sticon_raw, latest.text_content latest_text, latest.content latest_content, latest.source_deleted latest_source_deleted, latest.kind latest_kind, latest.notification_projection latest_notification_projection, latest.occurred_at latest_occurred_at,
    latest.attachment_name latest_attachment_name, latest.attachment_kind latest_attachment_kind,
    latest.attachment_status latest_attachment_status
  FROM conversations c
  JOIN line_accounts la ON la.account_id=c.account_id
  ${PEER_CONTACT_JOIN}
  LEFT JOIN room_agent_policies room_policy ON room_policy.account_id=c.account_id
    AND room_policy.chat_type=c.chat_type AND room_policy.chat_id=c.chat_id
  LEFT JOIN LATERAL (
    SELECT m.message_id, m.text_content, ${boundedSticonRawSql('m.raw')} AS sticon_raw, m.content, (m.raw ? 'sourceDeleted') AS source_deleted, m.kind,
      ${boundedNotificationProjectionSql} AS notification_projection,
      m.occurred_at, attachment.name attachment_name,
      attachment.kind attachment_kind, attachment.status attachment_status
    FROM messages m
    LEFT JOIN LATERAL (
      SELECT NULLIF(BTRIM(a.name), '') AS name, a.kind, a.status FROM attachments a
      WHERE a.account_id=m.account_id AND a.chat_type=m.chat_type AND a.chat_id=m.chat_id AND a.message_id=m.message_id
      ORDER BY a.created_at, a.attachment_id LIMIT 1
    ) attachment ON true
    LEFT JOIN LATERAL (
      SELECT
        (SELECT (m.raw#>'{native,row,cells}') -> (column_cell.ordinality - 1)::int
          FROM jsonb_array_elements_text(m.raw#>'{native,row,columns}') WITH ORDINALITY column_cell(value, ordinality)
          WHERE column_cell.value='_contentType' LIMIT 1) AS content_type,
        (SELECT (m.raw#>'{native,row,cells}') -> (column_cell.ordinality - 1)::int
          FROM jsonb_array_elements_text(m.raw#>'{native,row,columns}') WITH ORDINALITY column_cell(value, ordinality)
          WHERE column_cell.value='_contentMetadata' LIMIT 1) AS metadata
    ) native_fields ON true
    WHERE m.account_id=c.account_id AND m.chat_type=c.chat_type AND m.chat_id=c.chat_id AND (m.kind <> 'event' OR m.content IS NOT NULL)
    ORDER BY m.occurred_at DESC, m.message_id DESC LIMIT 1
  ) latest ON true`;

export class HealthService {
  private phase: ControlSnapshot['phase'] = 'idle';
  private targetAccountId: string | null = null;
  private readonly providerStatuses = new Map<AgentProvider, ProviderStatus>();
  constructor(private readonly pool: Pool, private readonly lineWorker?: LineWorkerProbe) {}

  setProviderAuthStatus(provider: AgentProvider, status: Omit<ProviderStatus, 'provider'>): void {
    this.providerStatuses.set(provider, { provider, ...status });
  }

  setSwitchPhase(phase: ControlSnapshot['phase'], targetAccountId: string | null): void {
    this.phase = phase;
    this.targetAccountId = targetAccountId;
  }

  async snapshot(): Promise<AppSnapshot> {
    const lineage = await resolveAgentLineage(this.pool);
    const [control, accounts, conversations, jobs, count, defaultAgentSetting, workerHealth] = await Promise.all([
      this.pool.query<{ control_epoch: string; active_account_id: string | null }>(
        `SELECT c.control_epoch, a.account_id AS active_account_id FROM account_control c
         LEFT JOIN line_accounts a ON a.mode = 'ACTIVE_CONTROL' WHERE c.singleton = true`,
      ),
      this.pool.query<{ account_id: string; display_name: string | null; status: 'connected' | 'disconnected' | 'degraded' | 'reauth_required'; last_synced_at: Date | null; mode: 'ACTIVE_CONTROL' | 'MONITOR_ONLY' | 'PAUSED'; product_role: 'AGENT' | 'PRIMARY_ADMIN' | null; has_primary_admin: boolean; auto_login_on_startup: boolean; picture_path: string | null }>(
        `SELECT la.account_id,la.display_name,la.status,
         CASE WHEN la.product_role='PRIMARY_ADMIN' AND la.connection_mode='EXTERNAL_MONITOR'
           THEN monitor_checkpoint.updated_at ELSE la.last_synced_at END AS last_synced_at,
         la.mode,la.picture_path,la.product_role,la.auto_login_on_startup,
         EXISTS(SELECT 1 FROM account_administrators aa WHERE aa.account_id=la.account_id AND aa.role='PRIMARY_ADMIN') has_primary_admin
         FROM line_accounts la
         LEFT JOIN LATERAL (
           SELECT c.updated_at FROM line_account_sources s
           JOIN external_source_checkpoints c ON c.source_id=s.source_id AND c.account_id=s.account_id AND c.generation=s.generation
           WHERE s.account_id=la.account_id AND s.source_id=la.selected_source_id AND s.generation=la.selected_source_generation
             AND s.source_type='EXTERNAL_MONITOR' AND s.state='ACTIVE' AND c.initial_import_complete=true
             AND la.source_transition_state='STABLE'
           LIMIT 1
         ) monitor_checkpoint ON true
         ORDER BY CASE la.product_role WHEN 'AGENT' THEN 0 WHEN 'PRIMARY_ADMIN' THEN 1 ELSE 2 END,la.account_id`,
      ),
      this.pool.query<ConversationRow>(
        `${conversationSelect}
         WHERE NOT (c.chat_type='direct' AND c.chat_id='__local_agent_room__')
           AND (${CONVERSATION_TITLE_SQL} IS NOT NULL OR EXISTS (SELECT 1 FROM messages m WHERE m.account_id=c.account_id AND m.chat_type=c.chat_type
             AND m.chat_id=c.chat_id AND (m.kind <> 'event' OR m.content IS NOT NULL)))
         ORDER BY c.account_id, c.chat_type, c.chat_id`,
      ),
      // The shared Agent room's history (account-less UI jobs) is selected separately so busy LINE traffic cannot push it out.
      // While the shared admin-direct chat exists, that chat's LINE jobs are a third group (own limit, no overlap with the
      // generic LINE group) so the room can show them; Main stamps `origin`, the renderer never decides sharing itself.
      this.pool.query<{ job_id: string; account_id: string | null; chat_type: 'direct' | 'group' | 'room' | null; chat_id: string | null; provider: AgentProvider; prompt: string; status: AppSnapshot['jobs'][number]['status']; created_at: Date;
        attachments?: Array<{ name: string; size: number; kind: 'image' | 'file' }> | null; origin: 'agent_room' | 'line_admin_direct' | 'schedule' | null; reply_preview: string | null }>(
        `WITH shared AS (${sharedAdminChatSql} LIMIT 1)
         SELECT recent.job_id, recent.account_id, recent.chat_type, recent.chat_id, recent.provider, recent.prompt, recent.status, recent.created_at, recent.attachments, recent.origin,
           CASE WHEN char_length(output.final_text) > 240 THEN left(output.final_text, 239) || '…' ELSE output.final_text END AS reply_preview
         FROM (
           (SELECT j.*, CASE WHEN j.account_id IS NULL THEN 'agent_room' END AS origin FROM agent_jobs j WHERE j.source_type = 'ui' ORDER BY j.created_at DESC, j.job_id DESC LIMIT 100)
           UNION ALL
           -- Scheduled runs: listed by the Jobs page (origin 'schedule'), never by the Agent room.
           (SELECT j.*, 'schedule' AS origin FROM agent_jobs j WHERE j.source_type = 'schedule' ORDER BY j.created_at DESC, j.job_id DESC LIMIT 100)
           UNION ALL
           (SELECT j.*, NULL::text AS origin FROM agent_jobs j WHERE j.source_type = 'line'
              AND NOT EXISTS (SELECT 1 FROM shared s WHERE j.account_id = ANY($1::text[]) AND j.chat_type = 'direct' AND j.chat_id = s.admin_mid)
              ORDER BY j.created_at DESC, j.job_id DESC LIMIT 100)
           UNION ALL
           (SELECT j.*, 'line_admin_direct' AS origin FROM agent_jobs j JOIN shared s ON j.account_id = ANY($1::text[]) AND j.chat_type = 'direct' AND j.chat_id = s.admin_mid
              WHERE j.source_type = 'line' ORDER BY j.created_at DESC, j.job_id DESC LIMIT 100)
         ) recent LEFT JOIN agent_outputs output ON output.job_id = recent.job_id
         ORDER BY recent.created_at DESC, recent.job_id DESC`,
        [[...new Set(lineage.accountIds)]],
      ),
      this.pool.query<{ count: string }>("SELECT count(*) FROM agent_jobs WHERE status = 'queued'"),
      this.pool.query<{ provider: string }>("SELECT value #>> '{}' AS provider FROM app_settings WHERE key = 'default_provider'"),
      this.lineWorker?.status(),
    ]);
    const providerStatuses: ProviderStatus[] = (['codex', 'claude'] as const).map((provider) => this.providerStatuses.get(provider)
      ?? { provider, status: 'unknown', detail: '尚未觀察 CLI 登入狀態；執行結果會反映實際可用性。' });
    const timestamp = new Date().toISOString();
    return {
      control: { epoch: Number(control.rows[0]?.control_epoch ?? 0), activeAccountId: control.rows[0]?.active_account_id ?? null,
        phase: this.phase, targetAccountId: this.targetAccountId },
      defaultProvider: defaultAgentSetting.rows[0]?.provider === 'codex' ? 'codex' : 'claude',
      queueDepth: Number(count.rows[0]?.count ?? 0),
      accounts: accounts.rows.map((row) => ({ accountId: row.account_id, displayName: row.display_name ?? row.account_id,
        status: row.status, lastSyncedAt: row.last_synced_at?.toISOString() ?? null, mode: row.mode, hasPrimaryAdmin: row.has_primary_admin, autoLoginOnStartup: row.auto_login_on_startup,
        productRole: row.product_role, avatarAvailable: Boolean(row.picture_path),
        ...(lineage.accountIds.includes(row.account_id) ? { agentLineage: row.account_id === lineage.currentAccountId ? 'current' as const : 'former' as const } : {}) })),
      conversations: conversations.rows.map(mapConversation),
      jobs: jobs.rows.map((row) => ({ jobId: row.job_id, accountId: row.account_id, chatType: row.chat_type,
        chatId: row.chat_id, provider: row.provider, prompt: row.prompt, status: row.status, createdAt: row.created_at.toISOString(),
        ...(row.reply_preview !== null && row.reply_preview !== undefined ? { replyPreview: row.reply_preview } : {}),
        ...(row.origin ? { origin: row.origin } : {}),
        // Display-only projection: name, size and kind. Stored relative paths and hashes never leave Main.
        ...(row.attachments?.length ? { attachments: row.attachments.map((item) => ({ name: item.name, size: item.size, kind: item.kind })) } : {}) })),
      providers: providerStatuses,
      components: [
        { name: 'database', status: 'ready', message: null, lastSuccessAt: timestamp, restartCount: 0 },
        workerHealth ?? { name: 'lineWorker', status: control.rows[0]?.active_account_id ? 'ready' : 'stopped', message: null,
          lastSuccessAt: control.rows[0]?.active_account_id ? timestamp : null, restartCount: 0 },
        ...providerStatuses.map((provider) => ({ name: provider.provider,
          status: provider.status === 'logged_in' ? 'ready' as const : provider.status === 'error' ? 'degraded' as const : 'stopped' as const,
          message: provider.detail, lastSuccessAt: null, restartCount: 0 })),
      ],
    };
  }

  async searchAgentJobs(query: AgentJobSearchQuery): Promise<{ jobs: AgentJobSummary[]; nextCursor: NonNullable<AgentJobSearchQuery['cursor']> | null }> {
    const parameters: unknown[] = [];
    const where: string[] = [];
    const bind = (value: unknown) => { parameters.push(value); return `$${parameters.length}`; };
    const keyword = query.keyword?.trim();
    if (keyword) {
      const pattern = `%${keyword.replace(/[!%_]/g, '!$&')}%`;
      const parameter = bind(pattern);
      const matches: string[] = [];
      if (query.searchPrompt) matches.push(`j.prompt ILIKE ${parameter} ESCAPE '!'`);
      if (query.searchReply) matches.push(`output.final_text ILIKE ${parameter} ESCAPE '!'`);
      where.push(`(${matches.join(' OR ')})`);
    }
    if (query.provider) where.push(`j.provider = ${bind(query.provider)}`);
    if (query.status) where.push(`j.status = ${bind(query.status)}`);
    if (query.createdFrom) where.push(`j.created_at >= ${bind(query.createdFrom)}::timestamptz`);
    if (query.createdToExclusive) where.push(`j.created_at < ${bind(query.createdToExclusive)}::timestamptz`);
    if (query.cursor) {
      const createdAt = bind(query.cursor.createdAt);
      const jobId = bind(query.cursor.jobId);
      where.push(`(j.created_at, j.job_id) < (${createdAt}::timestamptz, ${jobId}::uuid)`);
    }
    const limit = bind(query.limit + 1);
    const result = await this.pool.query<{ job_id: string; account_id: string | null; chat_type: 'direct' | 'group' | 'room' | null;
      chat_id: string | null; provider: AgentProvider; prompt: string; status: AgentJobSummary['status']; created_at: Date;
      reply_preview: string | null; origin: 'agent_room' | 'line_admin_direct' | 'schedule' | null; cursor_created_at: string;
      attachments: Array<{ name: string; size: number; kind: 'image' | 'file' }> | null }>(
      `WITH shared AS (${sharedAdminChatSql} LIMIT 1)
       SELECT j.job_id, j.account_id, j.chat_type, j.chat_id, j.provider, j.prompt, j.status, j.created_at,
         to_char(j.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS cursor_created_at,
         CASE WHEN char_length(output.final_text) > 240 THEN left(output.final_text, 239) || '…' ELSE output.final_text END AS reply_preview,
         CASE WHEN j.source_type = 'schedule' THEN 'schedule'
           WHEN j.account_id IS NULL THEN 'agent_room'
           WHEN EXISTS (SELECT 1 FROM shared s WHERE s.account_id=j.account_id AND j.chat_type='direct' AND j.chat_id=s.admin_mid AND j.source_type='line')
           THEN 'line_admin_direct' END AS origin,
         j.attachments
       FROM agent_jobs j LEFT JOIN agent_outputs output ON output.job_id=j.job_id
       WHERE ${where.length ? where.join(' AND ') : 'true'}
       ORDER BY j.created_at DESC, j.job_id DESC LIMIT ${limit}`,
      parameters,
    );
    const hasMore = result.rows.length > query.limit;
    const pageRows = result.rows.slice(0, query.limit);
    const jobs = pageRows.map((row): AgentJobSummary => ({ jobId: row.job_id, accountId: row.account_id,
      chatType: row.chat_type, chatId: row.chat_id, provider: row.provider, prompt: row.prompt, status: row.status,
      createdAt: row.created_at.toISOString(), ...(row.reply_preview !== null ? { replyPreview: row.reply_preview } : {}),
      ...(row.origin ? { origin: row.origin } : {}),
      ...(row.attachments?.length ? { attachments: row.attachments.map((item) => ({ name: item.name, size: item.size, kind: item.kind })) } : {}) }));
    const last = pageRows[pageRows.length - 1];
    return { jobs, nextCursor: hasMore && last ? { createdAt: last.cursor_created_at, jobId: last.job_id } : null };
  }

  async conversation(key: ConversationKey): Promise<ConversationSummary | null> {
    const result = await this.pool.query<ConversationRow>(`${conversationSelect}
      WHERE c.account_id=$1 AND c.chat_type=$2 AND c.chat_id=$3`, [key.accountId, key.chatType, key.chatId]);
    return result.rows[0] ? mapConversation(result.rows[0]) : null;
  }
}
