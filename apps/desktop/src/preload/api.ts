import {
  AgentPermissionsViewSchema,
  AgentApprovalDecisionSchema,
  PendingAgentApprovalSchema,
  type AgentApprovalDecision,
  type PendingAgentApproval,
  type AgentPermissionsView,
  AgentPermissionDefaultsViewSchema,
  type AgentPermissionDefaultsView,
  type SetAgentFolderLinkInput,
  type SetAgentPermissionInput,
  type SetAgentPermissionDefaultInput,
  type AgentExecutionPolicy,
  type AgentToolAllowlistEntry,
  type SetAgentExecutionPolicyInput,
  AppSnapshotSchema,
  ChatResourceNoteSchema,
  ChatResourceAlbumSchema,
  ChatResourcePhotoSchema,
  AutoResponderSettingsSchema,
  IpcEventSchema,
  IpcResultSchema,
  McpServerStatusSchema,
  McpLocalClientKindSchema,
  McpLocalClientStatusSchema,
  McpTokenSummarySchema,
  McpToolOutputUnionSchema,
  MessageSearchResultSchema,
  type AgentJobSearchQuery,
  type AgentJobSummary,
  type AgentAttachmentUpload,
  type AgentEvent,
  type AgentProvider,
  type AppSnapshot,
  type AutoResponderRule,
  type AutoResponderSettings,
  type ConversationKey,
  type WritableConversationKey,
  type IpcEvent,
  type IpcRequest,
  type IpcResult,
  type McpServerStatus,
  type McpLocalClientKind,
  type McpLocalClientStatus,
  type McpTokenSummary,
  type McpToolInputUnion,
  type McpToolName,
  type McpToolOutputUnion,
  type MessageSearchResult,
  type ChatResourceNote,
  type ChatResourceAlbum,
  type ChatResourcePhoto,
} from '@line-agent/contracts';
import { FriendListSchema, MessageReadersSchema, AttachmentStateListSchema, ControlStateSchema, DesktopReadResultSchema, MessagePageSchema, SystemActivityResultSchema, SystemErrorsResultSchema, WorkRecordSchema } from '../desktop-protocol.js';
import { DatabaseSetupResultSchema, SETUP_PROGRESS_CHANNEL, SetupProgressEventSchema, type DatabaseConnectionInput, type DatabaseSetupStatus,
  type EmbeddedConnectionInfo, type SetupProgressEvent } from '../setup-protocol.js';
import type { FriendRow, MessagePage, MessageReader, WorkRecord } from '../main/service-facade.js';
import { LocaleSnapshotSchema, type LocalePreference, type LocaleSnapshot } from '../locale.js';

export type DesktopApi = {
  reportRendererFailure?(): Promise<IpcResult>;
  getLocale(): Promise<LocaleSnapshot>;
  setLocale(preference: LocalePreference): Promise<LocaleSnapshot>;
  getSnapshot(): Promise<AppSnapshot>;
  listMessages(key: ConversationKey, cursor: string | null, limit?: number, messageId?: string): Promise<MessagePage>;
  listChatNotes(key: ConversationKey, cursor: string | null, requestId?: string): Promise<{ notes: ChatResourceNote[]; nextCursor: string | null }>;
  getChatNote(key: ConversationKey, postId: string, requestId?: string): Promise<ChatResourceNote>;
  listChatAlbums(key: ConversationKey, cursor: string | null, requestId?: string): Promise<{ albums: ChatResourceAlbum[]; nextCursor: string | null }>;
  listChatAlbumPhotos(key: ConversationKey, albumId: string, cursor: string | null, requestId?: string): Promise<{ photos: ChatResourcePhoto[]; nextCursor: string | null }>;
  downloadChatAlbumPhoto(key: ConversationKey, albumId: string, photoId: string, oid: string, prefix: 'album/a' | 'album/v', requestId?: string): Promise<{ albumId: string; photoId: string; sizeBytes: number }>;
  openChatAlbum(key: ConversationKey, albumId: string, requestId?: string): Promise<{ albumId: string; savedCount: number; failedCount: number; totalCount: number;
    byteCount: number; complete: boolean; failureCodes: string[]; errorCode: string | null }>;
  cancelChatResourceRequest(targetRequestId: string): Promise<boolean>;
  listAttachmentStates(key: ConversationKey, attachmentIds: readonly string[]): Promise<ReturnType<typeof AttachmentStateListSchema.parse>>;
  listAgentStatuses(key: ConversationKey, messageIds: readonly string[]): Promise<Array<{ messageId: string; jobId: string; status: 'queued' | 'running' | 'completed' | 'failed' | 'cancelled' | 'interrupted'; revision: string }>>;
  listWorkRecords(): Promise<WorkRecord[]>;
  listFriends(accountId: string): Promise<FriendRow[]>;
  listMessageReaders(key: ConversationKey, messageId: string): Promise<{ readers: MessageReader[] }>;
  listSystemActivity(): Promise<ReturnType<typeof SystemActivityResultSchema.parse>>;
  listSystemErrors(): Promise<ReturnType<typeof SystemErrorsResultSchema.parse>>;
  getControlState(): Promise<{ activeAccountId: string | null; epoch: number; pendingOutbound: number }>;
  getJobEvents(key: WritableConversationKey, jobId: string): Promise<AgentEvent[]>;
  searchMessages(query: { key?: ConversationKey; accountId?: string; senderId?: string; text?: string; limit: number }): Promise<MessageSearchResult[]>;
  searchAgentJobs(query: AgentJobSearchQuery): Promise<{ jobs: AgentJobSummary[]; nextCursor: NonNullable<AgentJobSearchQuery['cursor']> | null }>;
  sendText(key: WritableConversationKey, text: string): Promise<IpcResult>;
  replyText(key: WritableConversationKey, replyToMessageId: string, text: string): Promise<IpcResult>;
  sendManualMedia?(key: WritableConversationKey, files: AgentAttachmentUpload[]): Promise<IpcResult>;
  unsendMessage(key: ConversationKey, messageId: string): Promise<IpcResult>;
  getManualUnsendWindow(): Promise<'1h' | '7d'>;
  setManualUnsendWindow(window: '1h' | '7d'): Promise<'1h' | '7d'>;
  /** The shared Agent room: operator-owned, independent of every LINE account. */
  submitAgentRoomPrompt(input: { provider: AgentProvider; prompt: string; attachments?: AgentAttachmentUpload[] }): Promise<IpcResult>;
  getAgentRoomJobEvents(jobId: string): Promise<AgentEvent[]>;
  stopAgentRoomJob(jobId: string): Promise<IpcResult>;
  retryAgentRoomJob(jobId: string): Promise<IpcResult>;
  openAttachment(attachmentId: string): Promise<boolean>;
  openExternalUrl(url: string): Promise<IpcResult>;
  downloadAttachment(key: WritableConversationKey, attachmentId: string): Promise<IpcResult>;
  resolveFileTypeIcon(extension: string): Promise<string | null>;
  lineAddAccountQr(): Promise<IpcResult>;
  lineLoginQr(accountId: string): Promise<IpcResult>;
  lineLogout(accountId: string): Promise<IpcResult>;
  refreshLineAvatar(accountId: string): Promise<IpcResult>;
  lineSetAutoLogin(accountId: string, enabled: boolean): Promise<IpcResult>;
  lineBeginAdminPairing(accountId: string): Promise<{ token: string; expiresAt: string }>;
  lineStart(accountId: string): Promise<IpcResult>;
  externalImportStart(accountId: string): Promise<IpcResult>;
  externalImportStop(accountId: string): Promise<IpcResult>;
  /** Operator-only: reads the official LINE identity for the admin-binding confirmation dialog. */
  previewExternalAdminBinding(): Promise<IpcResult>;
  /** Operator-only: binds `mid` (re-verified natively) as Primary Admin, then starts External Monitor. */
  startExternalMonitorAsAdmin(mid: string): Promise<IpcResult>;
  officialLineApproveSigner(): Promise<IpcResult>;
  lineSyncHistory?(key: WritableConversationKey, cursor: string | null, limit?: number): Promise<IpcResult>;
  agentLogin(provider: AgentProvider): Promise<IpcResult>;
  agentLogout(provider: AgentProvider): Promise<IpcResult>;
  agentRefreshStatus(provider: AgentProvider): Promise<IpcResult>;
  stopJob(key: WritableConversationKey, jobId: string): Promise<IpcResult>;
  retryJob(key: WritableConversationKey, jobId: string): Promise<IpcResult>;
  setWorkspace(workspacePath: string): Promise<IpcResult>;
  setDefaultAgent(provider: AgentProvider): Promise<IpcResult>;
  getConversationSettings(): Promise<Extract<IpcResult, { type: 'getConversationSettings' }>['settings']>;
  setConversationSettings(settings: Extract<IpcRequest, { type: 'setConversationSettings' }>['settings']): Promise<Extract<IpcResult, { type: 'setConversationSettings' }>['settings']>;
  getAutoResponderSettings(): Promise<AutoResponderSettings>;
  setAutoResponderSettings(expectedVersion: number, settings: Pick<AutoResponderSettings, 'displayName' | 'fallback' | 'rules'>): Promise<IpcResult>;
  mcpGetStatus(): Promise<McpServerStatus>;
  mcpLocalClientStatus(): Promise<McpLocalClientStatus[]>;
  mcpLocalClientConnect(client: McpLocalClientKind, accountScopes: string[]): Promise<McpLocalClientStatus>;
  mcpLocalClientDisconnect(client: McpLocalClientKind): Promise<void>;
  mcpListTokens(): Promise<McpTokenSummary[]>;
  mcpIssueToken(input: {
    deviceLabel: string;
    principalId?: string;
    accountScopes: string[];
    toolScopes: McpToolName[];
    expiration: import('@line-agent/contracts').McpTokenExpiration;
  }): Promise<{ token: McpTokenSummary; plaintextToken: string }>;
  mcpRevokeToken(tokenId: string): Promise<boolean>;
  mcpCallInternalTool(tool: McpToolInputUnion): Promise<McpToolOutputUnion>;
  getAgentPermissions(accountId: string): Promise<AgentPermissionsView>;
  getAgentPermissionDefaults(): Promise<AgentPermissionDefaultsView>;
  setAgentPermissionDefault(input: SetAgentPermissionDefaultInput): Promise<IpcResult>;
  revokeAgentWhitelistUser(accountId: string, targetMid: string): Promise<IpcResult>;
  /** Resolves to `{ type: 'setAgentPermission', version }` or an error result (code `PERMISSION_VERSION_CONFLICT` on a stale expectedVersion). */
  setAgentPermission(input: SetAgentPermissionInput): Promise<IpcResult>;
  getAgentExecutionPolicy(): Promise<AgentExecutionPolicy>;
  setAgentExecutionPolicy(input: SetAgentExecutionPolicyInput): Promise<IpcResult>;
  listAgentToolAllowlist(): Promise<AgentToolAllowlistEntry[]>;
  removeAgentToolAllowlistEntry(id: string): Promise<IpcResult>;
  clearAgentToolAllowlist(): Promise<IpcResult>;
  /**
   * Resolves to `{ type: 'decideAgentApproval' }` or an error result (`APPROVAL_NOT_PENDING`, `APPROVAL_REMEMBER_UNAVAILABLE`).
   * Main owns the approval decision; the renderer sends only the approval ID and choice.
   */
  decideAgentApproval(approvalId: string, decision: AgentApprovalDecision): Promise<IpcResult>;
  listPendingAgentApprovals(): Promise<PendingAgentApproval[]>;
  /** Resolves to `{ type: 'setAgentFolderLink', version }` or an error result (`PERMISSION_VERSION_CONFLICT`, `INVALID_LINK`, `LINK_WRITE_UNSUPPORTED`). */
  setAgentFolderLink(input: SetAgentFolderLinkInput): Promise<IpcResult>;
  createChatFolder(input: { accountId: string; chatType: 'direct' | 'group' | 'room'; chatId: string }): Promise<IpcResult>;
  openChatFolder(folderId: string): Promise<IpcResult>;
  getDatabaseSetupStatus(): Promise<DatabaseSetupStatus>;
  listDatabases(connection: DatabaseConnectionInput): Promise<string[]>;
  createDatabase(connection: DatabaseConnectionInput, database: string): Promise<string[]>;
  chooseAttachmentRoot(): Promise<string | null>;
  prepareAttachmentRootChange?(): Promise<{ id: string; path: string } | null>;
  moveAttachmentRoot?(selectionId: string): Promise<{ saved: true; restartRequired: true; path: string; sourceRetained: true }>;
  openAttachmentRoot?(): Promise<void>;
  chooseAgentWorkspace(): Promise<string | null>;
  saveDatabaseSetup(connection: DatabaseConnectionInput, database: string, attachmentRoot: string, agentWorkspace: string): Promise<{ saved: true; restartRequired: true }>;
  restartApplication(): Promise<void>;
  /** Resolves when the embedded PostgreSQL is installed, started and saved; rejects with `errorCode` set on failure. */
  startEmbeddedProvision(): Promise<void>;
  cancelEmbeddedProvision(): Promise<void>;
  /** Explicit request: the only way the renderer receives the embedded password. */
  getEmbeddedConnectionInfo(): Promise<EmbeddedConnectionInfo>;
  /** Changes the app-managed database password; rejects with `errorCode` set on failure. The caller restarts afterwards. */
  changeEmbeddedPassword(password: string): Promise<void>;
  saveEmbeddedSetup(attachmentRoot: string, agentWorkspace: string): Promise<{ saved: true; restartRequired: true }>;
  onSetupProgress(callback: (event: SetupProgressEvent) => void): () => void;
  onSnapshot(callback: (snapshot: AppSnapshot) => void): () => void;
  onEvent(callback: (event: IpcEvent) => void): () => void;
};

type Transport = { invoke(channel: string, payload: unknown): Promise<unknown>; on(channel: string, callback: (_event: unknown, payload: unknown) => void): void; removeListener(channel: string, callback: (_event: unknown, payload: unknown) => void): void };
type RequestBody = IpcRequest extends infer Item ? Item extends IpcRequest ? Omit<Item, 'requestId'> : never : never;

function throwIpcErrorOrUnexpected(result: IpcResult, message: string): never {
  if (result.type === 'error') {
    const error = new Error(result.message);
    error.name = result.code;
    throw error;
  }
  throw new Error(message);
}

export function createDesktopApi(transport: Transport): DesktopApi {
  const request = async (body: RequestBody, requestId: string = crypto.randomUUID()): Promise<IpcResult> => {
    const result = IpcResultSchema.parse(await transport.invoke('line-agent:request', { ...body, requestId }));
    if (result.requestId !== requestId) throw new Error('IPC correlation mismatch');
    return result;
  };
  const read = async <T extends 'listMessages' | 'listAttachmentStates' | 'listAgentStatuses' | 'listWorkRecords' | 'listFriends' | 'listMessageReaders' | 'listSystemActivity' | 'listSystemErrors' | 'getControlState'>(body: { type: T; [key: string]: unknown }): Promise<Extract<ReturnType<typeof DesktopReadResultSchema.parse>, { type: T }>> => {
    const result = DesktopReadResultSchema.parse(await transport.invoke('line-agent:read', body));
    if (result.type !== body.type) throw new Error('IPC read response mismatch');
    return result as Extract<ReturnType<typeof DesktopReadResultSchema.parse>, { type: T }>;
  };
  const setup = async (body: Record<string, unknown>) => {
    const requestId = crypto.randomUUID();
    const result = DatabaseSetupResultSchema.parse(await transport.invoke('line-agent:setup', { ...body, requestId }));
    if (result.requestId !== requestId) throw new Error('IPC correlation mismatch');
    if (!result.ok) throw Object.assign(new Error(result.message), { ...(result.errorCode ? { errorCode: result.errorCode } : {}), ...(result.restartRequired ? { restartRequired: true } : {}) });
    return result;
  };
  return Object.freeze({
    async getLocale() { return LocaleSnapshotSchema.parse(await transport.invoke('line-agent:locale', { type: 'getLocale' })); },
    async setLocale(preference) { return LocaleSnapshotSchema.parse(await transport.invoke('line-agent:locale', { type: 'setLocale', preference })); },
    reportRendererFailure: () => request({ type: 'reportRendererFailure' }),
    async getSnapshot() { const result = await request({ type: 'getSnapshot' }); if (result.type !== 'getSnapshot') throw new Error(result.type === 'error' ? result.message : 'Unexpected snapshot response'); return AppSnapshotSchema.parse(result.snapshot); },
    async listMessages(key, cursor, limit = 75, messageId) { const result = await read({ type: 'listMessages', key, cursor, limit, ...(messageId ? { messageId } : {}) }); return MessagePageSchema.parse(result.page); },
    async listChatNotes(key, cursor, requestId) { const result = await request({ type: 'listChatNotes', ...key, cursor }, requestId); if (result.type !== 'listChatNotes') throwIpcErrorOrUnexpected(result, 'Unexpected Note response'); return { notes: ChatResourceNoteSchema.array().max(50).parse(result.notes), nextCursor: result.nextCursor }; },
    async getChatNote(key, postId, requestId) { const result = await request({ type: 'getChatNote', ...key, postId }, requestId); if (result.type !== 'getChatNote') throwIpcErrorOrUnexpected(result, 'Unexpected Note response'); return ChatResourceNoteSchema.parse(result.note); },
    async listChatAlbums(key, cursor, requestId) { const result = await request({ type: 'listChatAlbums', ...key, cursor }, requestId); if (result.type !== 'listChatAlbums') throwIpcErrorOrUnexpected(result, 'Unexpected Album response'); return { albums: ChatResourceAlbumSchema.array().max(50).parse(result.albums), nextCursor: result.nextCursor }; },
    async listChatAlbumPhotos(key, albumId, cursor, requestId) { const result = await request({ type: 'listChatAlbumPhotos', ...key, albumId, cursor }, requestId); if (result.type !== 'listChatAlbumPhotos') throwIpcErrorOrUnexpected(result, 'Unexpected Album photo response'); return { photos: ChatResourcePhotoSchema.array().max(50).parse(result.photos), nextCursor: result.nextCursor }; },
    async downloadChatAlbumPhoto(key, albumId, photoId, oid, prefix, requestId) { const result = await request({ type: 'downloadChatAlbumPhoto', ...key, albumId, photoId, oid, prefix }, requestId); if (result.type !== 'downloadChatAlbumPhoto') throwIpcErrorOrUnexpected(result, 'Unexpected Album photo download response'); return { albumId: result.albumId, photoId: result.photoId, sizeBytes: result.sizeBytes }; },
    async openChatAlbum(key, albumId, requestId) { const result = await request({ type: 'openChatAlbum', ...key, albumId }, requestId); if (result.type !== 'openChatAlbum') throwIpcErrorOrUnexpected(result, 'Unexpected Album archive response'); return { albumId: result.albumId, savedCount: result.savedCount, failedCount: result.failedCount, totalCount: result.totalCount,
      byteCount: result.byteCount, complete: result.complete, failureCodes: result.failureCodes, errorCode: result.errorCode }; },
    async cancelChatResourceRequest(targetRequestId) { const result = await request({ type: 'cancelChatResourceRequest', targetRequestId }); return result.type === 'cancelChatResourceRequest' && result.cancelled; },
    async listAttachmentStates(key, attachmentIds) { if (attachmentIds.length > 225) throw new Error('Attachment state lookup exceeds 225 IDs'); if (attachmentIds.some((id) => !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id))) throw new Error('Invalid attachment ID'); const result = await read({ type: 'listAttachmentStates', key, attachmentIds: [...new Set(attachmentIds)] }); return AttachmentStateListSchema.parse(result.attachments); },
    async listAgentStatuses(key, messageIds) { if (messageIds.length > 225) throw new Error('Agent status lookup exceeds 225 IDs'); const result = await read({ type: 'listAgentStatuses', key, messageIds: [...new Set(messageIds)] }); return result.statuses; },
    async listWorkRecords() { const result = await read({ type: 'listWorkRecords' }); return WorkRecordSchema.array().parse(result.records); },
    async listFriends(accountId) { const result = await read({ type: 'listFriends', accountId }); return FriendListSchema.parse(result.friends); },
    async listMessageReaders(key, messageId) { const result = await read({ type: 'listMessageReaders', key, messageId }); return MessageReadersSchema.parse({ readers: result.readers }); },
    async listSystemActivity() { const result = await read({ type: 'listSystemActivity' }); return SystemActivityResultSchema.parse({ activity: result.activity, partial: result.partial }); },
    async listSystemErrors() { const result = await read({ type: 'listSystemErrors' }); return SystemErrorsResultSchema.parse({ errors: result.errors, partial: result.partial }); },
    async getControlState() { const result = await read({ type: 'getControlState' }); return ControlStateSchema.parse(result.state); },
    async getJobEvents(key, jobId) { const result = await request({ type: 'getJobEvents', ...key, jobId }); if (result.type !== 'getJobEvents') throw new Error(result.type === 'error' ? result.message : 'Unexpected job events response'); return result.events; },
    async searchMessages(query) { const result = await request({ type: 'searchMessages', query }); if (result.type !== 'searchMessages') throw new Error(result.type === 'error' ? result.message : 'Unexpected search response'); return MessageSearchResultSchema.array().parse(result.messages); },
    async searchAgentJobs(query) { const result = await request({ type: 'searchAgentJobs', query }); if (result.type !== 'searchAgentJobs') throw new Error(result.type === 'error' ? result.message : 'Unexpected task search response'); return { jobs: result.jobs, nextCursor: result.nextCursor }; },
    sendText: (key, text) => request({ type: 'sendText', ...key, text }),
    replyText: (key, replyToMessageId, text) => request({ type: 'replyText', ...key, replyToMessageId, text }),
    sendManualMedia: (key, files) => request({ type: 'sendManualMedia', ...key, files }),
    unsendMessage: (key, messageId) => request({ type: 'unsendMessage', ...key, messageId }),
    async getManualUnsendWindow() { const result = await request({ type: 'getManualUnsendWindow' }); if (result.type !== 'getManualUnsendWindow') throwIpcErrorOrUnexpected(result, 'Unexpected unsend setting response'); return result.window; },
    async setManualUnsendWindow(window) { const result = await request({ type: 'setManualUnsendWindow', window }); if (result.type !== 'setManualUnsendWindow') throwIpcErrorOrUnexpected(result, 'Unexpected unsend setting response'); return result.window; },
    submitAgentRoomPrompt: (input) => request({ type: 'submitAgentRoomPrompt', provider: input.provider, prompt: input.prompt,
      ...(input.attachments?.length ? { attachments: input.attachments } : {}) }),
    async getAgentRoomJobEvents(jobId) { const result = await request({ type: 'getAgentRoomJobEvents', jobId }); if (result.type !== 'getAgentRoomJobEvents') throw new Error(result.type === 'error' ? result.message : 'Unexpected job events response'); return result.events; },
    stopAgentRoomJob: (jobId) => request({ type: 'stopAgentRoomJob', jobId }),
    retryAgentRoomJob: (jobId) => request({ type: 'retryAgentRoomJob', jobId }),
    async openAttachment(attachmentId) { if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(attachmentId)) throw new Error('Invalid attachment ID'); const result = await request({ type: 'openAttachment', attachmentId }); return result.type === 'openAttachment' && result.opened; },
    openExternalUrl: (url) => request({ type: 'openExternalUrl', url }),
    async downloadAttachment(key, attachmentId) { if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(attachmentId)) throw new Error('Invalid attachment ID'); return await request({ type: 'downloadAttachment', ...key, attachmentId }); },
    async resolveFileTypeIcon(extension) { if (!/^[a-z0-9]{1,12}$/.test(extension)) return null; const result = await request({ type: 'resolveFileTypeIcon', extension }); return result.type === 'resolveFileTypeIcon' ? result.dataUrl : null; },
    lineAddAccountQr: () => request({ type: 'lineAddAccountQr' }),
    lineLoginQr: (accountId) => request({ type: 'lineLoginQr', accountId }),
    lineLogout: (accountId) => request({ type: 'lineLogout', accountId }),
    refreshLineAvatar: (accountId) => request({ type: 'refreshLineAvatar', accountId }),
    lineSetAutoLogin: (accountId, enabled) => request({ type: 'lineSetAutoLogin', accountId, enabled }),
    async lineBeginAdminPairing(accountId) { const result = await request({ type: 'lineBeginAdminPairing', accountId }); if (result.type !== 'lineAdminPairing') throw new Error(result.type === 'error' ? result.message : 'Unexpected pairing response'); return { token: result.token, expiresAt: result.expiresAt }; },
    lineStart: (accountId) => request({ type: 'lineStart', accountId }),
    externalImportStart: (accountId) => request({ type: 'externalImportStart', accountId }),
    externalImportStop: (accountId) => request({ type: 'externalImportStop', accountId }),
    previewExternalAdminBinding: () => request({ type: 'previewExternalAdminBinding' }),
    startExternalMonitorAsAdmin: (mid) => request({ type: 'startExternalMonitorAsAdmin', mid }),
    officialLineApproveSigner: () => request({ type: 'officialLineApproveSigner' }),
    lineSyncHistory: (key, cursor, limit = 50) => request({ type: 'lineSyncHistory', ...key, cursor, limit }),
    agentLogin: (provider) => request({ type: 'agentLogin', provider }),
    agentLogout: (provider) => request({ type: 'agentLogout', provider }),
    agentRefreshStatus: (provider) => request({ type: 'agentRefreshStatus', provider }),
    stopJob: (key, jobId) => request({ type: 'stopJob', ...key, jobId }),
    retryJob: (key, jobId) => request({ type: 'retryJob', ...key, jobId }),
    setWorkspace: (workspacePath) => request({ type: 'setWorkspace', workspacePath }),
    setDefaultAgent: (provider) => request({ type: 'setDefaultAgent', provider }),
    async getConversationSettings() { const result = await request({ type: 'getConversationSettings' }); if (result.type !== 'getConversationSettings') throw new Error(result.type === 'error' ? result.message : 'Unexpected conversation settings response'); return result.settings; },
    async setConversationSettings(settings) { const result = await request({ type: 'setConversationSettings', settings }); if (result.type !== 'setConversationSettings') throw new Error(result.type === 'error' ? result.message : 'Unexpected conversation settings response'); return result.settings; },
    async getAutoResponderSettings() {
      const result = await request({ type: 'getAutoResponderSettings' });
      if (result.type !== 'getAutoResponderSettings') throw new Error(result.type === 'error' ? result.message : 'Unexpected autoresponder settings response');
      return AutoResponderSettingsSchema.parse(result.settings);
    },
    setAutoResponderSettings(expectedVersion, settings) {
      return request({ type: 'setAutoResponderSettings', expectedVersion,
        displayName: settings.displayName, fallback: settings.fallback, rules: settings.rules as AutoResponderRule[] });
    },
    async mcpGetStatus() {
      const result = await request({ type: 'mcpGetStatus' });
      if (result.type !== 'mcpGetStatus') throw new Error(result.type === 'error' ? result.message : 'Unexpected MCP status response');
      return McpServerStatusSchema.parse(result.status);
    },
    async mcpLocalClientStatus() {
      const result = await request({ type: 'mcpLocalClientStatus' });
      if (result.type !== 'mcpLocalClientStatus') throwIpcErrorOrUnexpected(result, 'Unexpected local MCP status response');
      return McpLocalClientStatusSchema.array().parse(result.clients);
    },
    async mcpLocalClientConnect(client, accountScopes) {
      const result = await request({ type: 'mcpLocalClientConnect', client: McpLocalClientKindSchema.parse(client), accountScopes });
      if (result.type !== 'mcpLocalClientConnect') throwIpcErrorOrUnexpected(result, 'Unexpected local MCP connect response');
      return McpLocalClientStatusSchema.parse(result.status);
    },
    async mcpLocalClientDisconnect(client) {
      const result = await request({ type: 'mcpLocalClientDisconnect', client: McpLocalClientKindSchema.parse(client) });
      if (result.type !== 'mcpLocalClientDisconnect') throwIpcErrorOrUnexpected(result, 'Unexpected local MCP disconnect response');
    },
    async mcpListTokens() {
      const result = await request({ type: 'mcpListTokens' });
      if (result.type !== 'mcpListTokens') throw new Error(result.type === 'error' ? result.message : 'Unexpected MCP tokens response');
      return McpTokenSummarySchema.array().parse(result.tokens);
    },
    async mcpIssueToken(input) {
      const result = await request({
        type: 'mcpIssueToken',
        deviceLabel: input.deviceLabel,
        ...(input.principalId ? { principalId: input.principalId } : {}),
        accountScopes: input.accountScopes,
        toolScopes: input.toolScopes,
        expiration: input.expiration,
      });
      if (result.type !== 'mcpIssueToken') throw new Error(result.type === 'error' ? result.message : 'Unexpected MCP issue token response');
      return { token: McpTokenSummarySchema.parse(result.token), plaintextToken: result.plaintextToken };
    },
    async mcpRevokeToken(tokenId) {
      if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(tokenId)) {
        throw new Error('Invalid MCP token ID');
      }
      const result = await request({ type: 'mcpRevokeToken', tokenId });
      if (result.type !== 'mcpRevokeToken') throw new Error(result.type === 'error' ? result.message : 'Unexpected MCP revoke token response');
      return result.revoked;
    },
    async mcpCallInternalTool(tool) {
      const result = await request({ type: 'mcpCallInternalTool', tool });
      if (result.type !== 'mcpCallInternalTool') throw new Error(result.type === 'error' ? result.message : 'Unexpected MCP internal tool response');
      return McpToolOutputUnionSchema.parse(result.result);
    },
    async getAgentPermissions(accountId) {
      const result = await request({ type: 'getAgentPermissions', accountId });
      if (result.type !== 'getAgentPermissions') throw new Error(result.type === 'error' ? result.message : 'Unexpected permissions response');
      return AgentPermissionsViewSchema.parse(result.view);
    },
    async getAgentPermissionDefaults() {
      const result = await request({ type: 'getAgentPermissionDefaults' });
      if (result.type !== 'getAgentPermissionDefaults') throw new Error(result.type === 'error' ? result.message : 'Unexpected global permission defaults response');
      return AgentPermissionDefaultsViewSchema.parse(result.defaults);
    },
    setAgentPermissionDefault: (input) => request({ type: 'setAgentPermissionDefault', ...input }),
    setAgentPermission: (input) => request({ type: 'setAgentPermission', ...input }),
    revokeAgentWhitelistUser: (accountId, targetMid) => request({ type: 'revokeAgentWhitelistUser', accountId, targetMid }),
    async getAgentExecutionPolicy() {
      const result = await request({ type: 'getAgentExecutionPolicy' });
      if (result.type !== 'getAgentExecutionPolicy') throw new Error(result.type === 'error' ? result.message : 'Unexpected execution policy response');
      return result.policy;
    },
    setAgentExecutionPolicy: (input) => request({ type: 'setAgentExecutionPolicy', ...input }),
    async listAgentToolAllowlist() {
      const result = await request({ type: 'listAgentToolAllowlist' });
      if (result.type !== 'listAgentToolAllowlist') throw new Error(result.type === 'error' ? result.message : 'Unexpected allowlist response');
      return result.entries;
    },
    removeAgentToolAllowlistEntry: (id) => request({ type: 'removeAgentToolAllowlistEntry', id }),
    clearAgentToolAllowlist: () => request({ type: 'clearAgentToolAllowlist' }),
    decideAgentApproval: async (approvalId, decision) =>
      request({ type: 'decideAgentApproval', approvalId, decision: AgentApprovalDecisionSchema.parse(decision) }),
    async listPendingAgentApprovals() {
      const result = await request({ type: 'listPendingAgentApprovals' });
      if (result.type !== 'listPendingAgentApprovals') throw new Error(result.type === 'error' ? result.message : 'Unexpected pending approvals response');
      return PendingAgentApprovalSchema.array().parse(result.approvals);
    },
    setAgentFolderLink: (input) => request({ type: 'setAgentFolderLink', ...input }),
    createChatFolder: (input) => request({ type: 'createChatFolder', ...input }),
    openChatFolder: (folderId) => request({ type: 'openChatFolder', folderId }),
    async getDatabaseSetupStatus() { const result = await setup({ type: 'getDatabaseSetupStatus' }); if (result.type !== 'getDatabaseSetupStatus') throw new Error('Unexpected setup response'); return result.status; },
    async listDatabases(connection) { const result = await setup({ type: 'listDatabases', connection }); if (result.type !== 'listDatabases') throw new Error('Unexpected setup response'); return result.databases; },
    async createDatabase(connection, database) { const result = await setup({ type: 'createDatabase', connection, database }); if (result.type !== 'createDatabase') throw new Error('Unexpected setup response'); return result.databases; },
    async chooseAttachmentRoot() { const result = await setup({ type: 'chooseAttachmentRoot' }); if (result.type !== 'chooseAttachmentRoot') throw new Error('Unexpected setup response'); return result.path; },
    async prepareAttachmentRootChange() { const result = await setup({ type: 'prepareAttachmentRootChange' }); if (result.type !== 'prepareAttachmentRootChange') throw new Error('Unexpected setup response'); return result.selection; },
    async moveAttachmentRoot(selectionId) { const result = await setup({ type: 'moveAttachmentRoot', selectionId }); if (result.type !== 'moveAttachmentRoot') throw new Error('Unexpected setup response'); return { saved: result.saved, restartRequired: result.restartRequired, path: result.path, sourceRetained: result.sourceRetained }; },
    async openAttachmentRoot() { const result = await setup({ type: 'openAttachmentRoot' }); if (result.type !== 'openAttachmentRoot') throw new Error('Unexpected setup response'); },
    async chooseAgentWorkspace() { const result = await setup({ type: 'chooseAgentWorkspace' }); if (result.type !== 'chooseAgentWorkspace') throw new Error('Unexpected setup response'); return result.path; },
    async saveDatabaseSetup(connection, database, attachmentRoot, agentWorkspace) { const result = await setup({ type: 'saveDatabaseSetup', connection, database, attachmentRoot, agentWorkspace }); if (result.type !== 'saveDatabaseSetup') throw new Error('Unexpected setup response'); return { saved: result.saved, restartRequired: result.restartRequired }; },
    async restartApplication() { const result = await setup({ type: 'restartApplication' }); if (result.type !== 'restartApplication') throw new Error('Unexpected setup response'); },
    async startEmbeddedProvision() { const result = await setup({ type: 'startEmbeddedProvision' }); if (result.type !== 'startEmbeddedProvision') throw new Error('Unexpected setup response'); },
    async cancelEmbeddedProvision() { const result = await setup({ type: 'cancelEmbeddedProvision' }); if (result.type !== 'cancelEmbeddedProvision') throw new Error('Unexpected setup response'); },
    async getEmbeddedConnectionInfo() { const result = await setup({ type: 'getEmbeddedConnectionInfo' }); if (result.type !== 'getEmbeddedConnectionInfo') throw new Error('Unexpected setup response'); return result.info; },
    async changeEmbeddedPassword(password) { const result = await setup({ type: 'changeEmbeddedPassword', password }); if (result.type !== 'changeEmbeddedPassword') throw new Error('Unexpected setup response'); },
    async saveEmbeddedSetup(attachmentRoot, agentWorkspace) { const result = await setup({ type: 'saveEmbeddedSetup', attachmentRoot, agentWorkspace }); if (result.type !== 'saveEmbeddedSetup') throw new Error('Unexpected setup response'); return { saved: result.saved, restartRequired: result.restartRequired }; },
    onSetupProgress(callback) {
      const listener = (_event: unknown, payload: unknown) => { const parsed = SetupProgressEventSchema.safeParse(payload); if (parsed.success) callback(parsed.data); };
      transport.on(SETUP_PROGRESS_CHANNEL, listener);
      return () => transport.removeListener(SETUP_PROGRESS_CHANNEL, listener);
    },
    onSnapshot(callback) {
      const listener = (_event: unknown, payload: unknown) => { const parsed = AppSnapshotSchema.safeParse(payload); if (parsed.success) callback(parsed.data); };
      transport.on('line-agent:snapshot', listener);
      return () => transport.removeListener('line-agent:snapshot', listener);
    },
    onEvent(callback) {
      const listener = (_event: unknown, payload: unknown) => { const parsed = IpcEventSchema.safeParse(payload); if (parsed.success) callback(parsed.data); };
      transport.on('line-agent:event', listener);
      return () => transport.removeListener('line-agent:event', listener);
    },
  });
}
