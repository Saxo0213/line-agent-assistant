import type { IpcRequest, IpcResult, ConversationKey, WritableConversationKey, AppSnapshot, MessageContent, LineMediaTarget } from '@line-agent/contracts';
import type { SystemActivityResult, SystemErrorsResult } from '../desktop-protocol.js';
import type { SticonRange } from '@line-agent/contracts';

export type TimelineMessage = {
  accountId: string; chatType: ConversationKey['chatType']; chatId: string; messageId: string; senderId: string;
  senderName: string; text: string | null; occurredAt: string; direction: 'inbound' | 'outbound';
  mentionRanges?: { start: number; end: number; userId: string }[] | undefined;
  sticonRanges?: SticonRange[] | undefined;
  kind: 'text' | 'image' | 'video' | 'audio' | 'file' | 'sticker' | 'contact' | 'event' | 'location' | 'rich';
  content?: MessageContent | null | undefined;
  sticker: { stickerId: string; animated: boolean; altText: string | null } | null;
  agentJobStatus?: 'queued' | 'running' | 'completed' | 'failed' | 'cancelled' | 'interrupted' | null | undefined;
  agentJobId?: string | null | undefined;
  agentJobRevision?: string | null | undefined;
  senderAvatarAvailable?: boolean | undefined;
  replyToMessageId: string | null;
  replyTo: { messageId: string; senderId: string; senderName: string; direction: 'inbound' | 'outbound'; senderAvatarAvailable: boolean; preview: string; display?: import('@line-agent/contracts').GeneratedPreview | undefined } | null;
  deleted: boolean;
  /** True when LINE deleted the row at the source (raw.sourceDeleted); presented like a recall. */
  deletedAtSource?: boolean | undefined;
  /** Readers covering this own message (direct/group/room); only present when greater than 0. */
  readCount?: number | undefined;
  /** Reactions under the bubble (derived from the native row); only present when non-empty. */
  reactions?: Array<{ kind: 'NICE' | 'LOVE' | 'FUN' | 'AMAZING' | 'SAD' | 'OMG' | 'PAID'; productId?: string | undefined; emojiId?: string | undefined; count: number; reactorNames: string[] }> | undefined;
  /** Display-only original from raw.recall.original; never written back to `content`. */
  recalledContent?: MessageContent | null | undefined;
  recalledKind?: TimelineMessage['kind'] | null | undefined;
  recalledText?: string | null | undefined;
  attachments: { id: string; kind: 'image' | 'video' | 'audio' | 'file'; name: string; mimeType: string; sizeBytes: number; status: string; canRetryManually?: boolean | undefined }[];
};
export type MessagePage = { messages: TimelineMessage[]; olderCursor: string | null };
export type AttachmentState = { attachmentId: string; messageId: string; kind: TimelineMessage['attachments'][number]['kind'];
  name: string; mimeType: string; sizeBytes: number; status: string; canRetryManually: boolean };
export type FriendRow = { mid: string; name: string; avatarAvailable: boolean; hasConversation: boolean };
export type MessageReader = { mid: string; name: string; readAt: string };
export type WorkRecord = { id: string; title: string; status: 'todo' | 'doing' | 'waiting' | 'done'; key: ConversationKey; messageIds: string[]; attachmentIds: string[]; updatedAt: string };
export type DesktopServiceFacade = {
  dispatch(request: IpcRequest): Promise<IpcResult>;
  openAttachment(attachmentId: string, senderId?: number): Promise<boolean>;
  downloadAttachment(key: WritableConversationKey, attachmentId: string): Promise<boolean>;
  handleLineMedia?(target: LineMediaTarget, signal?: AbortSignal): Promise<Response>;
  listMessages(key: ConversationKey, cursor: string | null, limit: number): Promise<MessagePage>;
  listAttachmentStates(key: ConversationKey, attachmentIds: readonly string[]): Promise<AttachmentState[]>;
  listAgentStatuses(key: ConversationKey, messageIds: readonly string[]): Promise<Array<{ messageId: string; jobId: string; status: NonNullable<TimelineMessage['agentJobStatus']>; revision: string }>>;
  listAgentStatuses(key: ConversationKey, messageIds: readonly string[]): Promise<Array<{ messageId: string; jobId: string; status: NonNullable<TimelineMessage['agentJobStatus']>; revision: string }>>;
  listWorkRecords(): Promise<WorkRecord[]>;
  listFriends?(accountId: string): Promise<FriendRow[]>;
  listMessageReaders?(key: ConversationKey, messageId: string): Promise<{ readers: MessageReader[] }>;
  listSystemActivity?(): Promise<SystemActivityResult>;
  listSystemErrors?(): Promise<SystemErrorsResult>;
  controlState(): Promise<{ activeAccountId: string | null; epoch: number; pendingOutbound: number }>;
  shutdown(): Promise<void>;
};

const emptySnapshot: AppSnapshot = { control: { epoch: 0, activeAccountId: null, phase: 'idle', targetAccountId: null }, components: [
  { name: 'database', status: 'stopped', message: '資料庫尚未接入', lastSuccessAt: null, restartCount: 0 },
  { name: 'lineWorker', status: 'stopped', message: 'LINE 服務尚未接入', lastSuccessAt: null, restartCount: 0 },
], defaultProvider: 'claude', queueDepth: 0, accounts: [], conversations: [], jobs: [], providers: [
  { provider: 'codex', status: 'not_installed', detail: null }, { provider: 'claude', status: 'not_installed', detail: null },
] };

export function createDisconnectedFacade(reason = '服務尚未接入；請完成 PostgreSQL 與資料目錄設定。'): DesktopServiceFacade {
  const snapshot: AppSnapshot = { ...emptySnapshot, components: emptySnapshot.components.map((component) =>
    component.name === 'database' ? { ...component, status: 'degraded', message: reason } : component) };
  return {
    async dispatch(request) {
      if (request.type === 'getSnapshot') return { type: 'getSnapshot', requestId: request.requestId, ok: true, snapshot };
      if (request.type === 'searchMessages') return { type: 'searchMessages', requestId: request.requestId, ok: true, messages: [] };
      if (request.type === 'getJobEvents') return { type: 'getJobEvents', requestId: request.requestId, ok: true, events: [] };
      if (request.type === 'getAgentRoomJobEvents') return { type: 'getAgentRoomJobEvents', requestId: request.requestId, ok: true, events: [] };
      return { type: 'error', requestId: request.requestId, ok: false, code: 'NOT_CONNECTED', message: reason, retryable: false };
    },
    async listMessages() { return { messages: [], olderCursor: null }; },
    async listAttachmentStates() { return []; },
    async listAgentStatuses() { return []; },
    async openAttachment() { return false; },
    async downloadAttachment() { return false; },
    async listWorkRecords() { return []; },
    async listFriends() { return []; },
    async listMessageReaders() { return { readers: [] }; },
    async controlState() { return { activeAccountId: null, epoch: 0, pendingOutbound: 0 }; },
    async shutdown() {},
  };
}
