import { randomBytes, randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import type {
  AgentEvent, AgentProvider, AgentRunRequest, ConversationKey, DiagnosticIdentity, DownloadAuthProbe, IpcEvent, IpcRequest, IpcResult, LineWorkerCommand,
  LineWorkerEvent, WorkerBinding, ComponentHealth, LineServerErrorCode, LineTransportKind, ChromeLtsmUnavailableStatus,
} from '@line-agent/contracts';
import { CHROME_EXTENSION_STORE_URL, CHROME_LTSM_UNAVAILABLE_CODE, resolveLineTransport } from '@line-agent/contracts';
import { ATTACHMENT_BLOCK_REASONS, isAttachmentBlockReason } from '@line-agent/contracts';
import { CHROME_EXTENSION_VERSION } from '@line-agent/line-chrome';
import type { ChromeLtsmControl } from './services/chrome-ltsm-service.js';
import { mkdir, realpath } from 'node:fs/promises';
import path from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { AGENT_PERMISSIONS, AGENT_ROOM_KEY, AGENT_SCHEDULE_QUEUE_KEY, DEFAULT_AGENT_STATUS_ICONS, NativeAttachmentDescriptorSchema, NativeAttachmentDownloadInputSchema, NativeStickerMetadataSchema, isLocalAgentRoom, isWritableChatType, isLineServerErrorCode, lineResultErrorMessage, relationAddServerError, talkServerError } from '@line-agent/contracts';
import {
  AccountRepository, AdminRepository, AgentPermissionError, AgentExtensionsRepository, AgentPermissionRepository, AgentRepository, AgentScheduleError, AgentScheduleRepository, resolveAgentLineage, resolveJobPolicy, resolveUserPermissions, deriveToolPolicy, FREE_MODE_MEMBER_ID, AlbumNotificationTaskRepository, ChatAlbumCatalogRepository, type AlbumNotificationTaskChat, type AlbumNotificationTaskErrorCode, walkAlbumTaskMessagePages, AutoResponderRepository, ExternalMonitorRepository, FriendWhitelistRepository, McpDomainError, McpTokenRepository, MessageRepository, bridgeNativeEnvelope, nativeMessageText, ProjectFolderRepository, RoomActivationRepository, RoomFreeModeRepository, SettingsRepository, ProviderQuotaRepository, migrate, parseLineStickerDescriptor,
  CONVERSATION_PICTURE_SQL, NAME_RESOLUTION_GROUP_COLUMNS, nativeReactions, ownMessageSql, PEER_CONTACT_JOIN, SENDER_CONTACT_JOIN, SENDER_NAME_SQL, SENDER_PICTURE_SQL, conversationPictureSql, senderNameSql, senderPictureSql,
} from '@line-agent/database';
import type { Attachment, ExternalDirectPollInput, ExternalDirectPollResult, ExternalObservation } from '@line-agent/database';
import type { DesktopServiceFacade, TimelineMessage, WorkRecord } from './service-facade.js';
import { FRIEND_LIST_LIMIT, MESSAGE_READER_LIMIT } from '../desktop-protocol.js';
import type { AgentJobStatusProjection } from '@line-agent/database';
import type { Locale } from '../locale.js';

import { boundedSticonRawSql, projectSticons } from './sticon-projection.js';
import { AccountSupervisor, LineService } from './services/line-service.js';
import { AgentService, type AgentRunner, type InternalMcpLauncher } from './services/agent-service.js';
import { AgentScheduleService } from './services/agent-schedule-service.js';
import { FreeModeService } from './services/free-mode-service.js';
import { PERSONA_DESCRIPTION_SETTING, PERSONA_LIVELINESS_SETTING, readGlobalPersona, resolveEffectivePersona } from './services/agent-persona.js';
import { defaultProjectPathPolicy } from './services/project-folder-path.js';
import { ProjectFolderService } from './services/project-folder-service.js';
import { createScheduleMessageReader } from './services/agent-schedule-reader.js';
import { createAgentScheduleTargetResolver } from './services/agent-schedule-targets.js';
import { AgentAttachmentError } from './services/agent-attachments.js';
import { loadLinejsMcpSkill } from './services/mcp-skill.js';
import { AgentJobEnvironmentService } from './services/agent-job-environment.js';
import { AgentExtensionsService, AgentExtensionsServiceError, BackendSecretCodec } from './services/agent-extensions-service.js';
import { defaultImportLocations, type AgentExtensionImportLocations } from './services/agent-extension-import.js';
import { ChatFolderError, ChatFolderService } from './services/chat-folders.js';
import { AlbumArchiveFailure, albumFailureContextFrom, albumTaskFailureStage, ChatResourceArchiveService, nativePostNotificationSubtype,
  ChatResourceUnsupportedError, type ChatResourceBinding, type ChatResourceRequest, type ChatResourceReadResult, type ChatResourceStore } from './services/chat-resources.js';
import { AlbumNotificationDispatcher, archiveAlbumContinuations } from './services/album-notification-dispatcher.js';
import { ChatResourceAccountAdmission } from './services/chat-resource-admission.js';
import { ChatResourceArchive, createChatResourceStoreAdapter } from './services/chat-resource-archive.js';
import { createChatResourceDiagnostics, parseChatResourceDiagnostic } from './services/chat-resource-diagnostics.js';
import { createMcpChatResourceArchiveReader } from './services/mcp-chat-resource-reader.js';
import { trackOperation, type TrackedOperationContext } from './tracked-operation.js';
import { WorkspaceAuthority, InvalidWorkspaceError } from './services/workspace-authority.js';
import { AttachmentService } from './services/attachment-service.js';
import { DeliveryService } from './services/delivery-service.js';
import { AgentLineSendService } from './services/agent-line-send-service.js';
import { PermissionCommandService, type PermissionCommandTransport } from './services/permission-command.js';
import { ContentReprojectionService } from './services/content-reprojection-service.js';
import { HealthService, kindPreview } from './services/health-service.js';
import { AdminPairingService } from './services/admin-pairing-service.js';
import { FriendEnrollmentService } from './services/friend-enrollment-service.js';
import { RoomAutomationService, type RoomAutomationTransport } from './services/room-automation.js';
import { McpService } from './services/mcp-service.js';
import { AgentApprovalBroker, AgentApprovalBrokerError } from './services/agent-approval-broker.js';
import { resolveWritePathEvidence } from './services/write-path-evidence.js';
import { McpHttpServer } from './services/mcp-http-server.js';
import { LocalMcpConfigError, McpLocalClients, type LocalClientKind } from './services/mcp-local-clients.js';
import { DpapiUserSecretBackend, type SecretBackend, type SecretStore } from './services/secret-store.js';
import { AttachmentPreviewService, createRepositoryPreviewAuthority, type PreviewPresenter } from './attachment-preview.js';
import { AttachmentOpenService } from './attachment-open.js';
import { LineMediaService } from './line-media.js';
import { toDataURL } from 'qrcode';
import { createCoalescedSnapshotPublisher } from './domain-event-publisher.js';
import type { OfficialBuildTrustService } from './services/official-build-trust.js';
import {probeInitialProviderAuth} from './provider-auth.js';
import { AUDIT_ERROR_CODES, type AuditErrorCode, type OperationalAudit } from './services/operational-audit.js';
import { resolveChatProvider } from './services/default-provider.js';
import { ProviderQuotaService, quotaFailureSuggestion } from './services/provider-quota-service.js';
import { providerFailureResetAt } from '@line-agent/agent-bridge';
import { diagnosticFailure, parseSafeDiagnostic, type SafeDiagnostic } from '@line-agent/contracts';
import type { AuditEventsReadResult } from './services/operational-audit-runtime.js';
import { systemActivityResult, systemErrorsResult } from './services/system-records.js';
import { createSingleFlightRead } from './services/system-read-flight.js';
import { runCleanupInOrder, StartupCleanup } from './startup-cleanup.js';
import type { DirectMonitorPage, ImportCatalogPage, ImportCursor, ImportDirectoryPage, ImportProgress, ImportRow, NativeMonitorAccess } from './services/js-external-reader/protocol.js';
import { createFirstImportProgressLog } from './services/first-import-progress-log.js';
import { classifyExternalMonitorFailure, clearExternalMonitorDiagnostic, ExternalMonitorDiagnosticFailure, externalMonitorDatabaseFailure, externalMonitorFailureDetail, recordExternalMonitorDiagnostic as persistExternalMonitorDiagnostic, type ExternalMonitorFailurePhase } from './services/external-monitor-diagnostics.js';
import { linePrompt } from './services/line-prompts.js';
import { createOwnAvatarRefreshScheduler, runOwnAvatarRefreshes } from './services/own-avatar-refresh-scheduler.js';
import { cleanupStaleManualMedia, ManualMediaError, stageManualMedia } from './services/manual-media-staging.js';
import { createManualMediaAdmission } from './services/manual-media-admission.js';
import { ManualSendNotStartedError } from './services/manual-send-errors.js';
import { gatewayFault, recordSendFault, workerFault } from './services/send-failure.js';
import { pickWorkerBinding } from './worker-binding-fields.js';

const REPLY_SENDER_NAME_SQL = senderNameSql({ m: 'qm', la: 'qla', c: 'qc', cm: 'qcm',
  senderContact: 'quoted_sender_contact', peerContact: 'quoted_peer_contact' });
const REPLY_SENDER_PICTURE_SQL = senderPictureSql({ m: 'qm', la: 'qla', c: 'qc', cm: 'qcm',
  senderContact: 'quoted_sender_contact', peerContact: 'quoted_peer_contact' });

type Bound = WorkerBinding & { mode: 'ACTIVE_CONTROL' | 'MONITOR_ONLY' | 'PAUSED'; purpose?: 'DOWNLOAD_ONLY'; expectedMid?: string; application?: string };
type SendResult = Extract<LineWorkerEvent, { type: 'sendResult' }>;
const MACHINE_CODE_PATTERN = /^[a-z][a-z0-9_]*(:[a-z][a-z0-9_]*)*$/;
function asChatResourceBinding(binding: (Bound | null) | undefined): ChatResourceBinding | null {
  if (!binding || binding.mode !== 'ACTIVE_CONTROL' || typeof binding.transportOwnerId !== 'string'
    || typeof binding.transportGeneration !== 'number' || typeof binding.writeGrantVersion !== 'number') return null;
  return { accountId: binding.accountId, workerInstanceId: binding.workerInstanceId, controlEpoch: binding.controlEpoch,
    transportOwnerId: binding.transportOwnerId, transportGeneration: binding.transportGeneration,
    writeGrantVersion: binding.writeGrantVersion, mode: binding.mode };
}
function sameCapturedBinding(left: ChatResourceBinding, right: Bound | undefined): boolean {
  return !!right && left.accountId === right.accountId && left.workerInstanceId === right.workerInstanceId
    && left.controlEpoch === right.controlEpoch && left.transportOwnerId === right.transportOwnerId
    && left.transportGeneration === right.transportGeneration && left.writeGrantVersion === right.writeGrantVersion;
}
function cursorCycleDetector(): (cursor: string) => boolean {
  let anchor: string | undefined;
  let power = 1;
  let length = 0;
  return (cursor) => {
    if (anchor === undefined) { anchor = cursor; return false; }
    length += 1;
    if (cursor === anchor) return true;
    if (length === power) { anchor = cursor; power *= 2; length = 0; }
    return false;
  };
}
/** Caller-supplied part of a media send; the gateway adds owner fields, ids, permit and timeout. */
export type SendMediaRequest = Pick<Extract<LineWorkerCommand, { type: 'sendMedia' }>,
  'accountId' | 'workerInstanceId' | 'controlEpoch' | 'chatType' | 'chatId' | 'requestId' | 'kind' | 'filePath' | 'fileName' | 'sizeBytes' | 'sha256' | 'manualSend'>;

export interface IntegratedWorkerGateway {
  onEvent(listener: (workerInstanceId: string, event: LineWorkerEvent) => Promise<void>): (() => void) | void;
  onBinding?(listener: (binding: Bound, signal: AbortSignal) => Promise<void> | void): (() => void) | void;
  onRestartBinding?(listener: (binding: Bound, signal: AbortSignal) => Promise<void> | void): (() => void) | void;
  onModeChange?(listener: (binding: Bound, signal: AbortSignal) => Promise<void> | void): (() => void) | void;
  onWorkerExit?(listener: (binding: WorkerBinding) => void): (() => void) | void;
  health?(): Promise<ComponentHealth> | ComponentHealth;
  inventory?(): { activeWorkers: number; launchingWorkers: number; restartTimers: number; pendingTasks: number; ownedTimers: number; ownedListeners: number };
  start(accountId: string, binding: Bound): Promise<Bound>;
  binding(accountId: string): Promise<Bound | null>;
  send(command: LineWorkerCommand, signal?: AbortSignal): Promise<SendResult>;
  unsend?(command: Extract<LineWorkerCommand, { type: 'unsendMessage' }>, signal?: AbortSignal): Promise<Extract<LineWorkerEvent, { type: 'unsendResult' }>>;
  sendManual(command: Extract<LineWorkerCommand, { type: 'sendText' }>, signal?: AbortSignal): Promise<SendResult>;
  /** Internal only (agent send tools); one media send at a time gateway-wide. */
  sendMedia?(command: SendMediaRequest, signal?: AbortSignal): Promise<SendResult>;
  isCurrentActiveControlBinding(binding: WorkerBinding): boolean;
  isCurrentManualSendBinding(binding: WorkerBinding): boolean;
  checkFriendRelation(command: Extract<LineWorkerCommand, { type: 'checkFriendRelation' }>): Promise<Extract<LineWorkerEvent, { type: 'friendRelationResult' }>>;
  refreshOwnProfile?(command: Extract<LineWorkerCommand, { type: 'refreshOwnProfile' }>): Promise<Extract<LineWorkerEvent, { type: 'ownProfileResult' }>>;
  addFriendByMid(command: Extract<LineWorkerCommand, { type: 'addFriendByMid' }>): Promise<Extract<LineWorkerEvent, { type: 'addFriendResult' }>>;
  download(command: Extract<LineWorkerCommand, { type: 'downloadAttachment' }>, signal?: AbortSignal): Promise<Extract<LineWorkerEvent, { type: 'attachmentResult' }>>;
  readChatResource?(command: ChatResourceRequest, signal?: AbortSignal): Promise<ChatResourceReadResult>;
  adoptDownloadAuth?(command: Extract<LineWorkerCommand, { type: 'adoptDownloadAuth' }>, signal?: AbortSignal): Promise<Extract<LineWorkerEvent, { type: 'downloadAuthResult' }>>;
  isDownloadReady?(binding: WorkerBinding): boolean;
  /** Effective per-operation bound of the gateway (child boot/protocol guard and in-flight sends). */
  readonly responseTimeoutMs?: number;
  waitModeAck(accountId: string, mode: 'ACTIVE_CONTROL' | 'MONITOR_ONLY', timeoutMs: number): Promise<boolean>;
  /** Resolves on the child protocol ack, before restart adoption finishes. */
  waitRawModeAck?(accountId: string, mode: 'ACTIVE_CONTROL' | 'MONITOR_ONLY', timeoutMs: number): Promise<boolean>;
  stop(accountId: string): Promise<void>;
  stopBinding(binding: WorkerBinding): Promise<void>;
  shutdown(): Promise<void>;
}

export interface IntegratedAgent extends AgentRunner {
  getAuthStatus(provider: AgentProvider): Promise<{ status: 'authenticated' | 'logged_out' | 'not_installed' | 'error'; detail?: string }>;
  agentRefreshStatus(provider: AgentProvider): Promise<{ status: 'authenticated' | 'logged_out' | 'not_installed' | 'error'; detail?: string }>;
  onAuthStatus?(listener: (status: { provider: AgentProvider; status: 'not_installed' | 'logged_out' | 'authenticated' | 'error';
    detail?: string }) => void): (() => void) | void;
  openLogin(provider: AgentProvider): Promise<{ ok: boolean; detail?: string }>;
  logout(provider: AgentProvider): Promise<{ ok: boolean; detail?: string }>;
  /** One tool-less, read-only fast-model turn (group free-mode judge). */
  judge?(request: { provider: AgentProvider; prompt: string; systemPrompt: string; workspacePath: string; resumeSessionId?: string;
    timeoutMs?: number }): Promise<{ text: string; sessionId: string }>;
  shutdown(): Promise<void>;
}

export interface ConnectedFacadeOptions {
  /** Immutable effective locale captured by the main process during startup. */
  locale?: Locale;
  pool: Pool;
  workers: IntegratedWorkerGateway;
  agent: IntegratedAgent;
  workspaceAuthority?: WorkspaceAuthority;
  /** Shelved: borrowing official LINE tokens for external downloads. Production never passes true. */
  externalDownloadTokenLookup?: boolean;
  attachmentRoot: string;
  /** App-managed empty directory used as the working directory of the free-mode judge. */
  freeModeJudgeDirectory?: string;
  previewCacheRoot?: string;
  mediaCacheRoot?: string;
  /** Handle-anchored Main archive store; absent adapters fail closed. */
  chatResourceStore?: ChatResourceStore;
  chatResourceDiagnosticsDirectory?: string;
  /** App-owned locations (data, installation) that a /folder project folder may never be, contain or sit inside. */
  projectFolderProtectedPaths?: readonly string[];
  openAttachmentPath?: (file: string) => Promise<string>;
  /** Opens a chat folder in Explorer (shell.openPath); falls back to openAttachmentPath. Resolves to '' on success. */
  openFolderPath?: (folder: string) => Promise<string>;
  secretStore?: SecretStore;
  /** Support for CHROMEOS login: the ltsm asset service, the native folder picker and the Chrome Web Store opener. If absent, CHROMEOS is not available. */
  chromeLogin?: { ltsm: ChromeLtsmControl; chooseFolder(): Promise<string | null>; openStore(url: string): Promise<void> };
  audit?: OperationalAudit & { listEvents?: (limit?: number, onUpdate?: (result: AuditEventsReadResult) => void) => Promise<AuditEventsReadResult>; waitForReadDrain?: () => Promise<void> };
  publish?: (event: IpcEvent) => void;
  migrationDirectory?: string;
  closePoolOnShutdown?: boolean;
  runMigrations?: boolean;
  /** Starts the one-per-process content-bridge re-projection job after migrations (production only). */
  contentReprojection?: boolean;
  previewPresenter?: PreviewPresenter;
  beforeMcpListen?: () => void | Promise<void>;
  mcpHttpPort?: number;
  /** Injectable local MCP client config paths; production defaults use APPDATA/CODEX_HOME/USERPROFILE. */
  mcpLocalClientPaths?: { claudeDesktop?: string; codex?: string };
  /** Injectable sources of the Agent extension import and the seal for their secrets; production uses the user's config files and DPAPI. */
  agentExtensionImport?: Partial<AgentExtensionImportLocations>;
  agentExtensionSecretBackend?: SecretBackend;
  mcpLocalClientExecPath?: string;
  mcpLocalClientBridgePath?: string;
  mcpLocalClientAppPath?: string;
  mcpLocalClientPackaged?: boolean;
  /** Packaged app-owned Skills directory (contains linejs-mcp/SKILL.md). */
  skillsDirectory?: string;
  officialSnapshotImporter?: OfficialSnapshotImporter;
  externalImportProgressPath?: string;
  externalMonitorDiagnosticPath?: string;
  /** Persisted official LINE build trust; drives the Primary Admin build status and signer approval. */
  officialBuildTrust?: OfficialBuildTrustService;
}

export function resolveMcpLocalClientBridgePath(appPath: string, packaged: boolean): string {
  const root = packaged ? appPath.replace(/app\.asar(?:\\|\/)?$/, 'app.asar.unpacked') : appPath;
  return path.join(root, 'dist', 'mcp-stdio-bridge.js');
}

export type OfficialIdentityRead =
  | { status: 'supported'; mid: string; displayName: string | null; picturePath?: string | null; candidateCount: number }
  | { status: 'unsupported'; errorCode: string };

export type OfficialSourceVerification =
  | Readonly<{ status: 'supported' }>
  | Readonly<{ status: 'unsupported'; errorCode: string }>;

export type OfficialSnapshotImporter = {
  verifyOfficialSource?(input: { expectedMid: string; signal: AbortSignal }): Promise<OfficialSourceVerification>;
  /** Read-only identity of the account the official LINE is currently logged in to (active database only). */
  readOfficialIdentity?(input: { signal: AbortSignal; onPhase?(phase: 'locating' | 'reading_identity'): void }): Promise<OfficialIdentityRead>;
  readOfficialSnapshot(input: {
    expectedMid: string;
    signal: AbortSignal;
    onProgress(progress: { phase: string; bytesCopied: string | null; totalBytes: string | null; rowsScanned: string | null; eligibleCount: string | null }): void;
    onReady(metadata: { sourceIdentityDigest: string; snapshotDigest: string; schemaVersion: string;
      highWatermark: { createdTime: string; id: string } | null; eligibleCount: string | null }):
      Promise<{ createdTime: string; id: string } | null> | { createdTime: string; id: string } | null;
    onCatalogPage(page: ImportCatalogPage, signal?: AbortSignal): Promise<void> | void;
    onDirectoryPage?(page: ImportDirectoryPage, signal?: AbortSignal): Promise<void> | void;
    onPage(page: { pageNumber: number; batchDigest: string; rows: readonly ImportRow[];
      lastCursor: { createdTime: string; id: string } | null; hasMore: boolean }): Promise<void> | void;
  }): Promise<{ sourceIdentityDigest: string; snapshotDigest: string; pageCount: number; rowCount: number;
    highWatermark: { createdTime: string; id: string } | null }>;
  readOfficialMonitor?(input: {
    expectedMid: string;
    sourceIdentityDigest: string;
    cursor: ImportCursor | null;
    signal: AbortSignal;
    onPhase?(phase: ExternalMonitorFailurePhase): void;
    onProgress(progress: ImportProgress): void;
    onReady?(access: NativeMonitorAccess, signal?: AbortSignal): Promise<void> | void;
    onDirectoryPage?(page: ImportDirectoryPage, signal?: AbortSignal): Promise<void> | void;
    onPage(page: DirectMonitorPage, signal?: AbortSignal): Promise<ImportCursor | null> | ImportCursor | null;
  }): Promise<void>;
};

const accepted = (requestId: string): IpcResult => ({ type: 'accepted', requestId, ok: true });
const failure = (requestId: string, code: string, message: string, retryable = false,
  serverErrorCode?: LineServerErrorCode): IpcResult =>
  ({ type: 'error', requestId, ok: false, code, message, retryable,
    ...(serverErrorCode ? { serverErrorCode } : {}) });
/** Main refused a CHROMEOS login or start because the ltsm assets are not usable. It has the status and no path. */
class ChromeLtsmUnavailableError extends Error {
  readonly code = CHROME_LTSM_UNAVAILABLE_CODE;
  constructor(readonly status: ChromeLtsmUnavailableStatus) { super('LINE Chrome assets are unavailable'); this.name = 'ChromeLtsmUnavailableError'; }
}
function chromeLtsmMessage(status: ChromeLtsmUnavailableStatus): string {
  if (status.kind === 'wrong-version') return `偵測到的 LINE Chrome 擴充功能版本（${status.detected.join('、') || '未知'}）與所需的 ${status.required} 不符，無法使用 Chrome 登入。`;
  if (status.kind === 'corrupt') return 'LINE Chrome 安全模組檔案驗證失敗，請重新偵測或重新選擇檔案。';
  return `尚未安裝 LINE Chrome 擴充功能 ${status.required} 的安全模組檔案，請先偵測或選擇檔案。`;
}
const chromeLtsmUnavailable = (requestId: string, status: ChromeLtsmUnavailableStatus): IpcResult =>
  ({ type: 'error', requestId, ok: false, code: CHROME_LTSM_UNAVAILABLE_CODE, message: chromeLtsmMessage(status), retryable: false,
    chromeLtsmStatus: status });
const JOB_NOT_RETRYABLE = 'AGENT_JOB_NOT_RETRYABLE';
const JOB_NOT_RETRYABLE_MESSAGE = '此任務目前無法重試（可能已取消、已產生輸出，或所屬 Agent 會話已變更）。';

function applyProviderAuthStatus(health: HealthService, auth: {
  provider: AgentProvider; status: 'not_installed' | 'logged_out' | 'authenticated' | 'error'; detail?: string;
}): void {
  const authenticated = auth.status === 'authenticated';
  health.setProviderAuthStatus(auth.provider, {
    status: authenticated ? 'logged_in' : auth.status === 'not_installed' ? 'not_installed'
      : auth.status === 'error' ? 'error' : 'logged_out',
    detail: auth.detail ?? null,
  });
}

/** @internal Adapts one validated native reader row at the database boundary. */
export function toExternalObservation(row: ImportRow): ExternalObservation {
  if (row.chatType === 'unsupported') throw new Error('Official LINE row has no safe archive classification');
  if (!/^-?(0|[1-9]\d*)$/.test(row.createdTime)) throw new Error('Invalid LINE message timestamp');
  const createdTime = BigInt(row.createdTime);
  if (createdTime < -9_223_372_036_854_775_808n || createdTime > 9_223_372_036_854_775_807n) throw new Error('LINE message timestamp is outside int64');
  const milliseconds = Number(createdTime);
  if (!Number.isSafeInteger(milliseconds) || Math.abs(milliseconds) > 8_640_000_000_000_000) throw new Error('LINE message timestamp is outside supported date range');
  const occurredAt = new Date(milliseconds).toISOString();
  const chatType = row.chatType;
  const mentionRanges = externalMentionRanges(row.mentionRanges, row.text);
  const sticker = row.nativeStickerMetadata === undefined ? undefined : NativeStickerMetadataSchema.safeParse(row.nativeStickerMetadata);
  const attachments = Array.isArray(row.nativeAttachments) && row.nativeAttachments.length <= 32
    ? row.nativeAttachments.map((item) => NativeAttachmentDescriptorSchema.safeParse(item)) : undefined;
  const validAttachments = attachments?.every((item) => item.success) ? attachments?.map((item) => item.data) : undefined;
  return { observationId: row.observationId, canonicalMessageId: null, nativeConversationKind: row.nativeConversationKind,
    nativeConversationId: row.nativeConversationId, nativeMessageId: row.nativeMessageId, chatType,
    chatId: row.chatId, conversationTitle: row.conversationTitle ?? null,
    nativeMetadata: row.nativeMetadata ?? { midType: null, parentChatId: null, communityId: null },
    nativeContentType: row.nativeContentType ?? null, senderId: row.senderId,
    ...(typeof row.senderName === 'string' && row.senderName.length > 0 && row.senderName.length <= 256 && !row.senderName.includes('\0')
      ? { senderName: row.senderName } : {}), ...(mentionRanges === undefined ? {} : { mentionRanges }),
    ...(typeof row.senderPicturePath === 'string' && row.senderPicturePath.length <= 2048 ? { senderPicturePath: row.senderPicturePath } : {}),
    kind: row.kind, occurredAt, text: row.text === null ? null : row.text.replaceAll('\0', '\uFFFD'),
    ...(row.nativePayload === undefined ? {} : { nativePayload: row.nativePayload }),
    ...(validAttachments === undefined ? {} : { attachments: validAttachments }),
    ...(sticker?.success ? { nativeStickerMetadata: sticker.data } : {}) };
}

function externalMentionRanges(value: unknown, text: string | null): Array<{ start: number; end: number; userId: string }> | undefined {
  if (!Array.isArray(value) || value.length > 64 || text === null) return undefined;
  const ranges: Array<{ start: number; end: number; userId: string }> = [];
  for (const candidate of value) {
    if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) return undefined;
    const range = candidate as Record<string, unknown>;
    if (!Number.isSafeInteger(range.start) || !Number.isSafeInteger(range.end) ||
      (range.start as number) < 0 || (range.end as number) <= (range.start as number) || (range.end as number) > text.length ||
      typeof range.userId !== 'string' || range.userId.length === 0 || range.userId.length > 512 || range.userId.includes('\0')) return undefined;
    ranges.push({ start: range.start as number, end: range.end as number, userId: range.userId });
  }
  return ranges;
}

function importCursor(value: Record<string, unknown>): { createdTime: string; id: string } | null {
  if (Object.keys(value).length === 0) return null;
  if (typeof value.createdTime !== 'string' || typeof value.id !== 'string') throw new Error('Persisted LINE import cursor is invalid');
  return { createdTime: value.createdTime, id: value.id };
}

export function sameJsonValue(left: unknown, right: unknown): boolean {
  if (left === right) return true;
  if (left === null || right === null || typeof left !== 'object' || typeof right !== 'object') return false;
  if (Array.isArray(left) || Array.isArray(right)) return Array.isArray(left) && Array.isArray(right)
    && left.length === right.length && left.every((value, index) => sameJsonValue(value, right[index]));
  const leftRecord = left as Record<string, unknown>;
  const rightRecord = right as Record<string, unknown>;
  const leftKeys = Object.keys(leftRecord).sort();
  const rightKeys = Object.keys(rightRecord).sort();
  return leftKeys.length === rightKeys.length && leftKeys.every((key, index) => key === rightKeys[index]
    && sameJsonValue(leftRecord[key], rightRecord[key]));
}

function workerOperationErrorCode(code: string): AuditErrorCode {
  if (AUDIT_ERROR_CODES.includes(code as AuditErrorCode) && code !== 'UNKNOWN') return code as AuditErrorCode;
  return 'WORKER_OPERATION_FAILED';
}

export function recordWorkerDiagnostic(options: ConnectedFacadeOptions, event: Extract<LineWorkerEvent,
  { type: 'error' | 'catalogRefreshStatus' }>): void {
  if (!options.audit) return;
  try {
    if (event.type === 'catalogRefreshStatus') {
      const upstreamCode = event.state === 'degraded' && event.serverError
        ? talkServerError(event.serverError.slice('LINE_TALK_'.length))?.upstreamCode : undefined;
      options.audit.observed('line_catalog_refresh', { initiator: 'worker', accountId: event.accountId,
        workerInstanceId: event.workerInstanceId,
        ...(upstreamCode === undefined ? {} : { diagnostic: { operation: 'catalog_refresh', stage: 'read',
          category: 'denied', recovery: 'none', upstreamCode } as const }),
        ...(event.state === 'degraded'
          ? { errorCode: workerOperationErrorCode(event.serverError ?? event.code) } : { resultCode: 'catalog_refresh_recovered' }) });
      return;
    }
    const errorCode = workerOperationErrorCode(event.code);
    if (!AUDIT_ERROR_CODES.includes(errorCode)) return;
    if (event.diagnostic) {
      options.audit.failure(event.diagnostic, { initiator: 'worker', accountId: event.accountId,
        workerInstanceId: event.workerInstanceId, ...(event.requestId ? { requestId: event.requestId } : {}),
        background: !event.requestId && (event.diagnostic.operation === 'poll' || event.diagnostic.category === 'event_publish_failed' || event.diagnostic.category === 'queue_full') }, errorCode, 'worker_operation_error');
      return;
    }
    options.audit.observed('worker_operation_error', { initiator: 'worker', accountId: event.accountId,
      workerInstanceId: event.workerInstanceId, errorCode,
      ...(event.diagnostic ? { diagnostic: event.diagnostic } : {}),
      ...(event.requestId ? { requestId: event.requestId } : {}) });
  } catch { /* Diagnostics cannot affect command results or worker readiness. */ }
}

export function recordKnownServerResult(options: ConnectedFacadeOptions, event: Extract<LineWorkerEvent,
  { type: 'ownProfileResult' | 'sendResult' | 'unsendResult' | 'addFriendResult' }>): void {
  if (!options.audit || typeof event.error !== 'string' || !isLineServerErrorCode(event.error)) return;
  const relation = event.type === 'addFriendResult';
  const projection = relation
    ? event.error.startsWith('LINE_RELATION_ADD_') && relationAddServerError(event.error.slice('LINE_RELATION_ADD_'.length))
    : event.error.startsWith('LINE_TALK_') && talkServerError(event.error.slice('LINE_TALK_'.length));
  if (!projection) return;
  const operation = event.type === 'ownProfileResult' ? 'refreshOwnProfile' : event.type === 'sendResult' ? 'sendText'
    : event.type === 'unsendResult' ? 'unsendMessage' : 'addFriendByMid';
  try {
    options.audit.failure({ operation, stage: 'response', category: 'denied', recovery: 'none',
      upstreamCode: projection.upstreamCode }, { initiator: 'worker', accountId: event.accountId,
      workerInstanceId: event.workerInstanceId, requestId: event.requestId }, projection.code,
    relation ? 'friend_add_attempt' : 'worker_operation_error');
  } catch { /* Diagnostics cannot affect command results. */ }
}

export function recordAttachmentServerResult(options: ConnectedFacadeOptions,
  event: Extract<LineWorkerEvent, { type: 'attachmentResult'; status: 'failed' | 'expired' }>): void {
  if (!options.audit || !event.serverErrorCode?.startsWith('LINE_TALK_')) return;
  const projection = talkServerError(event.serverErrorCode.slice('LINE_TALK_'.length));
  if (!projection || event.upstreamCode !== projection.upstreamCode) return;
  try {
    options.audit.failure({ operation: 'downloadAttachment', stage: 'response', category: 'denied',
      recovery: 'none', upstreamCode: projection.upstreamCode },
    { initiator: 'worker', accountId: event.accountId, workerInstanceId: event.workerInstanceId,
      requestId: event.attachmentId }, projection.code, 'worker_operation_error');
  } catch { /* Diagnostics cannot affect downloads. */ }
}

/** Production composition root. Every external process and OS effect is supplied explicitly. */
export function createPermissionCommandService(
  repository: Pick<AgentPermissionRepository, 'getExecutionPolicy' | 'setExecutionPolicy'>,
  transport: PermissionCommandTransport,
  onPolicyChanged: () => void,
  locale: Locale | string = 'en',
  onDiagnostic?: (diagnostic: import('@line-agent/contracts').SafeDiagnostic) => void,
): PermissionCommandService {
  return new PermissionCommandService(repository, transport, { onPolicyChanged, locale, ...(onDiagnostic ? { onDiagnostic } : {}) });
}

export async function createConnectedFacade(options: ConnectedFacadeOptions): Promise<DesktopServiceFacade> {
  const cleanup = new StartupCleanup();
  await cleanupStaleManualMedia();
  try {
    const facade = await createConnectedFacadeInternal(options, cleanup);
    cleanup.commit();
    return facade;
  } catch (error) {
    await cleanup.unwind(error);
    throw error;
  }
}

/** Startup auto-login failure tagged with the failing step. Carries only platform discriminants, never token or message data. */
class StartupStageError extends Error {
  readonly code?: unknown;
  constructor(readonly stage: 'admission' | 'spawn' | 'dispatch' | 'response', readonly retryable: boolean, cause: unknown) {
    super(cause instanceof Error ? cause.message : 'Startup failed');
    this.name = cause instanceof Error && cause.name === 'TimeoutError' ? 'TimeoutError' : 'StartupStageError';
    this.code = cause && typeof cause === 'object' ? (cause as { code?: unknown }).code : undefined;
  }
}
/** Fallback when the gateway does not expose its effective bound; equals the gateway default. */
const DEFAULT_WORKER_RESPONSE_TIMEOUT_MS = 30_000;
/** Single delayed retry for a failed startup auto-login. */
const STARTUP_AUTOLOGIN_RETRY_DELAY_MS = 5_000;

async function createConnectedFacadeInternal(options: ConnectedFacadeOptions, startupCleanup: StartupCleanup): Promise<DesktopServiceFacade> {
  async function recordExternalMonitorDiagnostic(...args: Parameters<typeof persistExternalMonitorDiagnostic>): Promise<void> {
    const correlationId = options.audit?.failure({ operation: 'external_monitor', stage: args[4] ?? (args[1] === 'startup' ? 'bootstrap' : 'execute'),
      reason: args[2], category: args[2] === 'external_monitor_database_failed' ? 'persistence_failed'
        : args[2] === 'external_monitor_authority_stale' || args[2] === 'external_monitor_source_changed' ? 'stale_binding' : 'unknown',
      recovery: 'check_configuration' });
    await persistExternalMonitorDiagnostic(args[0], args[1], args[2], args[3], args[4], args[5],
      () => { options.audit?.failure(diagnosticFailure('external_monitor', 'write')); }, correlationId);
  }
  let closing = false;
  let shutdownPromise: Promise<void> | undefined;
  const inFlight = new Set<Promise<unknown>>();
  const manualMediaAdmission = createManualMediaAdmission();
  const externalMonitor = new ExternalMonitorRepository(options.pool);
  type ExternalImportProgress = NonNullable<import('@line-agent/contracts').LineAccountSummary['externalImportProgress']>;
  const externalImportProgress = new Map<string, ExternalImportProgress>();
  let pendingMonitorRefresh: { accountId: string; sourceId: string; generation: number; pending: boolean } | null = null;
  let externalImportOwner: { accountId: string; abort: AbortController; task?: Promise<unknown> } | null = null;
  /** At most one read-only official identity read at a time (admin binding preview / confirm). */
  let identityReadAbort: AbortController | null = null;
  const nativeMonitorAccess = new Map<string, { sourceId: string; generation: number; access: NativeMonitorAccess; signal: AbortSignal }>();
  const downloadAuthFlights = new Map<string, Promise<boolean>>();
  const recoveryTimers = new Set<ReturnType<typeof setTimeout>>();
  const avatarRefreshFlights = new Map<string, Promise<IpcResult>>();
  let ownAvatarRefreshScheduler: ReturnType<typeof createOwnAvatarRefreshScheduler> | undefined;
  let unsubscribeAuth: (() => void) | void;
  let unsubscribeWorkerExit: (() => void) | void;
  let unsubscribeEvent: (() => void) | void;
  let unsubscribeBinding: (() => void) | void;
  let unsubscribeRestartBinding: (() => void) | void;
  let unsubscribeModeChange: (() => void) | void;
  let mcpService!: McpService;
  let mcpHttpServer!: McpHttpServer;
  let mcpLocalClients!: McpLocalClients;
  let stopMcpService: () => Promise<void> = async () => undefined;
  let stopMcpHttpServer: () => Promise<void> = async () => undefined;
  let agentService!: AgentService;
  let stopAgentService: () => Promise<void> = async () => undefined;
  let stopAgentSchedules: () => Promise<void> = async () => undefined;
  let freeMode: FreeModeService | undefined;
  let projectFolders: ProjectFolderService | undefined;
  let delivery!: DeliveryService;
  let stopDelivery: () => Promise<void> = async () => undefined;
  let stopLineSend: () => Promise<void> = async () => undefined;
  let attachmentService!: AttachmentService;
  let stopAttachmentService: () => Promise<void> = async () => undefined;
  let previewService: AttachmentPreviewService | null = null;
  let stopPreview: () => Promise<void> = async () => undefined;
  let attachmentOpenService: AttachmentOpenService | null = null;
  let stopAttachmentOpen: () => Promise<void> = async () => undefined;
  let lineMedia!: LineMediaService;
  let stopLineMedia: () => Promise<void> = async () => undefined;
  let publishSnapshot!: ReturnType<typeof createCoalescedSnapshotPublisher>;
  let stopPublishSnapshot: () => Promise<void> = async () => undefined;
  let stopContentReprojection: () => Promise<void> = async () => undefined;
  let lineService!: LineService;
  let lineServiceReady = false;
  startupCleanup.beforeUnwind(async () => {
    closing = true;
    manualMediaAdmission.shutdown();
    externalImportOwner?.abort.abort();
    identityReadAbort?.abort();
    const earlyErrors = await runCleanupInOrder([
      () => ownAvatarRefreshScheduler?.shutdown(),
      () => { for (const timer of recoveryTimers) clearTimeout(timer); recoveryTimers.clear(); },
      () => unsubscribeAuth?.(), () => unsubscribeWorkerExit?.(), () => unsubscribeEvent?.(),
      () => unsubscribeBinding?.(), () => unsubscribeRestartBinding?.(), () => unsubscribeModeChange?.(),
    ]);
    const earlyOwners = await Promise.allSettled([
      stopMcpHttpServer, stopMcpService, stopLineSend, stopAgentService, stopDelivery,
      stopAttachmentService, stopLineMedia, stopPreview, stopAttachmentOpen, stopPublishSnapshot, stopContentReprojection,
    ].map((cleanup) => Promise.resolve().then(cleanup)));
    earlyErrors.push(...earlyOwners.filter((result): result is PromiseRejectedResult => result.status === 'rejected').map((result) => result.reason));
    while (inFlight.size) await Promise.allSettled([...inFlight]);
    const roomErrors = lineServiceReady ? await runCleanupInOrder([() => lineService.idleRoomEffects()]) : [];
    if (earlyErrors.length || roomErrors.length) {
      throw new AggregateError([...earlyErrors, ...roomErrors], 'Startup admission drain encountered cleanup errors');
    }
  });
  startupCleanup.add(() => { for (const timer of recoveryTimers) clearTimeout(timer); recoveryTimers.clear(); });
  function track<T>(work: () => Promise<T>, context: TrackedOperationContext): Promise<T> {
    return trackOperation(work, context, {
      inFlight,
      isClosing: () => closing,
      onFailure: (diagnostic, identity) => options.audit?.failure(diagnostic, identity),
    });
  }
  function admitted<T>(work: () => Promise<T>, context: TrackedOperationContext): Promise<T> {
    return closing ? Promise.reject(new Error('Service is closing')) : track(work, context);
  }
  function onceCleanup(action: () => void | Promise<void>): () => Promise<void> {
    let result: Promise<void> | undefined;
    return () => result ??= Promise.resolve().then(action).catch((error: unknown) => {
      options.audit?.failure(diagnosticFailure('shutdown', 'cleanup', error));
      throw error;
    });
  }
  async function stopExternalImportForAccount(accountId: string): Promise<void> {
    const owner = externalImportOwner;
    if (owner?.accountId === accountId) {
      owner.abort.abort();
      await owner.task;
    }
    nativeMonitorAccess.delete(accountId);
    const binding = await options.workers.binding(accountId);
    if (binding?.purpose === 'DOWNLOAD_ONLY') await options.workers.stopBinding(binding);
  }
  if (options.runMigrations !== false) await migrate(options.pool, options.migrationDirectory);
  if (options.contentReprojection === true) {
    const reprojection = new ContentReprojectionService(options.pool, {
      onError: (error) => options.audit?.failure(diagnosticFailure('database', 'persist', error)) });
    stopContentReprojection = onceCleanup(() => reprojection.shutdown());
    startupCleanup.add(stopContentReprojection);
    reprojection.start();
  }
  const accounts = new AccountRepository(options.pool);
  const canWriteLine = async (accountId: string): Promise<boolean> =>
    (await accounts.resolveCapabilities(accountId))?.canWriteLine === true;
  const assertLineWriteAllowed = async (accountId: string): Promise<void> => {
    if (!await canWriteLine(accountId)) throw new Error('EXTERNAL_MONITOR_READ_ONLY');
  };
  const sendLineCommand = async (command: LineWorkerCommand, signal?: AbortSignal): Promise<SendResult> => {
    if (command.type === 'sendText' || command.type === 'reactMessage' || command.type === 'unsendMessage') await assertLineWriteAllowed(command.accountId);
    return options.workers.send(command, signal);
  };
  const messages = new MessageRepository(options.pool);
  const agents = new AgentRepository(options.pool);
  const providerQuota = new ProviderQuotaRepository(options.pool);
  const settings = new SettingsRepository(options.pool);
  let conversationSettingsError: string | null = null;
  let conversationSettings = await settings.getConversationSettings().catch((error: unknown) => {
    options.audit?.failure(diagnosticFailure('database', 'read', error));
    conversationSettingsError = 'Unable to load conversation settings';
    return { attachmentAutoAttemptLimit: 3, showAgentStatusMarkers: true, agentStatusIcons: DEFAULT_AGENT_STATUS_ICONS,
      agentStatusRotationIntervalSeconds: 10 };
  });
  let settingsTail: Promise<void> = Promise.resolve();
  const friendWhitelist = new FriendWhitelistRepository(options.pool);
  const autoresponders = new AutoResponderRepository(options.pool);
  const roomActivation = new RoomActivationRepository(options.pool);
  const workspace = options.workspaceAuthority ?? await WorkspaceAuthority.load(settings);
  const admins = new AdminRepository(options.pool);
  const permissionRepository = new AgentPermissionRepository(options.pool);
  const chatFolders = new ChatFolderService(permissionRepository, workspace);
  const diagnostics = options.chatResourceDiagnosticsDirectory
    ? createChatResourceDiagnostics({ appDataDirectory: options.chatResourceDiagnosticsDirectory,
      onSinkFailure: (stage) => options.audit?.failure({ operation: 'chat_resource', stage,
        category: stage === 'queue' ? 'queue_full' : 'persistence_failed', recovery: 'check_configuration' }) }) : undefined;
  let archiveOwner: ChatResourceArchive | undefined;
  let chatResourceStore = options.chatResourceStore;
  if (!chatResourceStore && process.versions.electron && process.platform === 'win32') {
    archiveOwner = new ChatResourceArchive({ workspaceRoot: await workspace.current() });
    chatResourceStore = createChatResourceStoreAdapter({ archive: archiveOwner, folders: chatFolders });
  }
  if (diagnostics) startupCleanup.add(() => diagnostics.shutdown());
  const chatResources = new ChatResourceArchiveService({
    readChatResource: (command, signal) => {
      if (!options.workers.readChatResource) throw new Error('LINE Note and Album reads are unavailable in this worker.');
      return options.workers.readChatResource(command, signal);
    },
    isWritableAccount: canWriteLine,
    ...(chatResourceStore ? { store: chatResourceStore } : {}),
    catalog: new ChatAlbumCatalogRepository(options.pool),
    recordDiagnostic: (record) => {
      const safe = parseChatResourceDiagnostic(record);
      const correlationId = safe?.status === 'failure' && safe.errorCode !== 'CANCELLED' ? options.audit?.failure({
        operation: safe.action, stage: safe.failureStage === 'gateway_admission' ? 'admission'
          : safe.failureStage === 'archive_contains' ? 'archive_contains' : 'response',
        category: safe.errorCode === 'TIMEOUT' ? 'timeout' : 'invalid_response', recovery: 'retry',
        ...(safe.failureCategory ? { reason: safe.failureCategory } : {}),
        ...(safe.failureKind ? { failureKind: safe.failureKind } : {}),
        ...(safe.upstreamStatus === undefined ? {} : { upstreamStatus: safe.upstreamStatus }),
        ...(safe.upstreamCode === undefined ? {} : { upstreamCode: safe.upstreamCode }),
        ...(typeof safe.responseCode === 'number' ? { statusCode: safe.responseCode } : {}) }, { accountId: safe.accountId }) : undefined;
      if (safe) diagnostics?.record({ ...safe, ...(correlationId ? { correlationId } : {}) });
    },
    ...(options.audit ? { audit: options.audit } : {}),
    getBinding: async (accountId) => {
      const binding = await options.workers.binding(accountId);
      if (!binding || typeof binding.transportOwnerId !== 'string' || typeof binding.transportGeneration !== 'number'
        || typeof binding.writeGrantVersion !== 'number') return null;
      return { ...binding, transportOwnerId: binding.transportOwnerId, transportGeneration: binding.transportGeneration,
        writeGrantVersion: binding.writeGrantVersion };
    },
    isCurrentBinding: (binding) => binding.mode === 'ACTIVE_CONTROL' && lineService.isAuthenticatedReady(binding)
      && options.workers.isCurrentActiveControlBinding(binding),
    conversationExists: async (key) => (await options.pool.query('SELECT 1 FROM conversations WHERE account_id=$1 AND chat_type=$2 AND chat_id=$3 LIMIT 1',
      [key.accountId, key.chatType, key.chatId])).rowCount === 1,
  });
  const reconcileAlbumChat = async (key: ConversationKey, binding: ChatResourceBinding): Promise<void> => {
    let albumCursor: string | null = null;
    const albumCursorRepeats = cursorCycleDetector();
    do {
      let albums: Awaited<ReturnType<typeof chatResources.listAlbums>>;
      try { albums = await chatResources.listAlbums(key, albumCursor, undefined, 'notification', binding); }
      catch (error) {
        if (!options.workers.isCurrentActiveControlBinding(binding)) throw error;
        throw new AlbumArchiveFailure({ action: 'album_list', stage: 'resource_read', code: 'ALBUM_RECONCILIATION_FAILED' });
      }
      for (const album of albums.albums) {
        await archiveAlbumContinuations((cursor, photoIndex) =>
          chatResources.openAlbum(key, album.albumId, undefined, 'notification', binding, cursor, photoIndex));
      }
      albumCursor = albums.nextCursor;
      if (albumCursor !== null && albumCursorRepeats(albumCursor)) throw new AlbumArchiveFailure({ action: 'album_list', stage: 'pagination', code: 'ALBUM_RECONCILIATION_FAILED' });
    } while (albumCursor !== null);
  };
  const albumNotificationTasks = new AlbumNotificationTaskRepository(options.pool);
  const albumTaskRecovery = new Set<string>();
  const albumDispatcher = new AlbumNotificationDispatcher(async (accountId, binding, target, dispatchOptions) => {
    const isCurrent = () => !closing && options.workers.isCurrentActiveControlBinding(binding);
    if (!isCurrent()) return null;
    if (dispatchOptions.recover) {
      await albumNotificationTasks.recoverRunning(accountId);
      albumTaskRecovery.add(accountId);
    }
    if (dispatchOptions.backfill) {
      const current = await walkAlbumTaskMessagePages((afterMessageId) => albumNotificationTasks.backfillMissingPage({
        accountId, ...(afterMessageId ? { afterMessageId } : {}), limit: 64,
      }), isCurrent);
      if (!current) return null;
    }
    if (!albumTaskRecovery.has(accountId)) {
      await albumNotificationTasks.recoverRunning(accountId);
      albumTaskRecovery.add(accountId);
    }
    const skipInvalid = (chat?: AlbumNotificationTaskChat) => walkAlbumTaskMessagePages((afterMessageId) =>
      albumNotificationTasks.skipInvalidPage({ accountId, ...(afterMessageId ? { afterMessageId } : {}), limit: 64,
        ...(chat ? { chat } : {}) }), isCurrent);
    const targetTaskChat = target && (target.chatType === 'direct' || target.chatType === 'group' || target.chatType === 'room')
      ? { chatType: target.chatType, chatId: target.chatId } : undefined;
    if (!await skipInvalid(dispatchOptions.sweep ? undefined : targetTaskChat)) return null;
    let nextRetryAt: number | null = null;
    const processChat = async (key: ConversationKey): Promise<'continue' | 'retry' | 'stale'> => {
      if (closing || !options.workers.isCurrentActiveControlBinding(binding)) return 'stale';
      const claim = await albumNotificationTasks.claimChat(key);
      if (claim.retryAt !== null) { nextRetryAt = claim.retryAt; return 'retry'; }
      if (!claim.claimed) {
        const taskChat = key.chatType === 'direct' || key.chatType === 'group' || key.chatType === 'room'
          ? { chatType: key.chatType, chatId: key.chatId } : undefined;
        if (taskChat && !await skipInvalid(taskChat)) return 'stale';
        return 'continue';
      }
      if (closing || !options.workers.isCurrentActiveControlBinding(binding)) return 'stale';
      try {
        await reconcileAlbumChat(key, binding);
        if (closing || !options.workers.isCurrentActiveControlBinding(binding)) return 'stale';
        if (!await albumNotificationTasks.completeClaimedChat(key, binding)) return 'stale';
      } catch (error) {
        chatResources.recordNotificationFailure(key, error);
        const failureContext = albumFailureContextFrom(error);
        const safeCode: AlbumNotificationTaskErrorCode = failureContext?.code ?? (error instanceof Error && error.message === 'ALBUM_ARCHIVE_INCOMPLETE'
          ? 'ALBUM_ARCHIVE_INCOMPLETE' : error instanceof Error && error.message === 'ALBUM_PHOTO_CURSOR_LOOP'
            ? 'ALBUM_PHOTO_CURSOR_LOOP' : 'ALBUM_RECONCILIATION_FAILED');
        const retryAt = await albumNotificationTasks.retryClaimedChat(key, binding, { stage: failureContext ? albumTaskFailureStage(failureContext) : 'archive_scan', code: safeCode });
        if (retryAt === null && !isCurrent()) return 'stale';
        if (retryAt !== null) { nextRetryAt = retryAt; return 'retry'; }
      }
      return 'continue';
    };
    if (!dispatchOptions.sweep && target) {
      const result = await processChat(target);
      if (result === 'stale') return null;
    } else {
      let after: AlbumNotificationTaskChat | undefined;
      for (;;) {
        if (closing || !options.workers.isCurrentActiveControlBinding(binding)) return nextRetryAt;
        const page = await albumNotificationTasks.dueChatsPage({ accountId, ...(after ? { after } : {}), limit: 32 });
        if (!page.chats.length) break;
        for (const chat of page.chats) {
          const result = await processChat({ accountId, ...chat });
          if (result === 'stale') return nextRetryAt;
          if (result === 'retry') return nextRetryAt;
          after = chat;
        }
        if (!page.nextChat) break;
      }
    }
    return nextRetryAt ?? await albumNotificationTasks.nextRetryAt(accountId);
  }, async (accountId) => {
    const current = await options.workers.binding(accountId);
    if (!current || current.mode !== 'ACTIVE_CONTROL' || typeof current.transportOwnerId !== 'string'
      || typeof current.transportGeneration !== 'number' || typeof current.writeGrantVersion !== 'number'
      || !lineService.isAuthenticatedReady(current) || !options.workers.isCurrentActiveControlBinding(current)) return null;
    return { ...current, transportOwnerId: current.transportOwnerId, transportGeneration: current.transportGeneration,
      writeGrantVersion: current.writeGrantVersion };
  });
  const chatResourceAdmission = new ChatResourceAccountAdmission(chatResources,
    (binding) => lineService.isAuthenticatedReady(binding) && options.workers.isCurrentActiveControlBinding(binding));
  startupCleanup.add(() => chatResources.shutdown());
  const agentExtensions = new AgentExtensionsService(
    new AgentExtensionsRepository(options.pool, new BackendSecretCodec(options.agentExtensionSecretBackend ?? new DpapiUserSecretBackend())),
    () => ({ ...defaultImportLocations(), ...options.agentExtensionImport }));
  const agentJobEnvironment = new AgentJobEnvironmentService({
    resolvePolicy: (jobId) => resolveJobPolicy(options.pool, jobId),
    resolveExtensions: () => agentExtensions.resolveForRun(),
    getExecutionLevel: async () => (await permissionRepository.getExecutionPolicy()).level,
    resolveProjectFolders: async (key) => await projectFolders?.resolveMounts(key) ?? [],
    folders: chatFolders, workspace });
  const mcpTokens = new McpTokenRepository(options.pool);
  const getMcpLiveLoginBinding = async (accountId: string): Promise<Bound | null> => {
    if ((await accounts.resolveCapabilities(accountId))?.connectionMode !== 'SYSTEM_LOGIN') return null;
    const binding = await options.workers.binding(accountId);
    return !!binding && binding.mode === 'ACTIVE_CONTROL' && lineService.isAuthenticatedReady(binding)
      && options.workers.isCurrentActiveControlBinding(binding) ? binding : null;
  };
  // Single owner of pending interactive tool approvals (memory only, bounded); the renderer only answers by approvalId.
  const approvalBroker = new AgentApprovalBroker({ repository: permissionRepository, resolveWritePathEvidence,
    publish: (event) => {
      if (event.type === 'requested') options.publish?.({ type: 'agentApprovalRequested', approval: event.approval });
      else options.publish?.({ type: 'agentApprovalResolved', approvalId: event.approvalId, jobId: event.jobId, outcome: event.outcome });
    } });
  // Agent LINE send queue (list_send_targets / send_to_target). Built before the MCP service that hands it work; it sends
  // through the same worker gateway and write gate as DeliveryService, and drops its pending items on shutdown.
  const agentLineSend = new AgentLineSendService({ messages, canWriteLine, attachmentRoot: options.attachmentRoot,
    workspacePath: async () => workspace.current().catch(() => null),
    worker: {
      binding: (accountId) => options.workers.binding(accountId),
      waitModeAck: (accountId, mode, timeoutMs) => options.workers.waitModeAck(accountId, mode, timeoutMs),
      send: sendLineCommand,
      ...(options.workers.sendMedia ? { sendMedia: (command, signal) => options.workers.sendMedia!(command, signal) } : {}),
    },
    ...(options.audit ? { audit: options.audit } : {}) });
  stopLineSend = onceCleanup(() => agentLineSend.shutdown());
  startupCleanup.add(stopLineSend);
  const freeModeStore = new RoomFreeModeRepository(options.pool);
  const scheduleTargets = createAgentScheduleTargetResolver({ messages, pool: options.pool });
  // Scheduled Agent triggers (list/create/update/delete_schedule and the schedules IPC). The Agent room job is submitted through
  // agentService, which is built later; the service only calls it from its tick, which starts after both exist.
  const agentSchedules = new AgentScheduleService({ store: new AgentScheduleRepository(options.pool), targets: scheduleTargets, agentLineage: () => resolveAgentLineage(options.pool),
    primaryAdminChat: async () => {
      const identity = await agents.describeJobIdentity({ sourceType: 'ui', accountId: null, chatType: null, chatId: null });
      return identity.admin ? { accountId: identity.admin.accountId, chatId: identity.admin.chatId, title: identity.admin.name ?? '' } : null;
    },
    submit: (input) => agentService.submitScheduled(input),
    sendSystemText: (input) => agentLineSend.sendSystemText({ runId: input.runId, target: input.target, text: input.text }),
    // new_messages reads: Main calls the MCP tool itself with the schedule principal (internal:schedule). mcpService is built right after this service.
    readMessages: createScheduleMessageReader((tool, context) => mcpService.callInternalTool(tool, context ?? { sourceType: 'schedule', accountScope: null })),
    publish: () => { options.publish?.({ type: 'agentSchedulesChanged' }); },
    onError: (error) => { options.audit?.failure(diagnosticFailure('agent', 'execute', error)); } });
  stopAgentSchedules = onceCleanup(() => agentSchedules.stop());
  startupCleanup.add(stopAgentSchedules);
  mcpService = new McpService({ pool: options.pool, tokens: mcpTokens, messages, approvalBroker, lineSend: agentLineSend, schedules: agentSchedules,
    onDiagnostic: (diagnostic, identity) => options.audit?.failure(diagnostic, identity),
    ...(chatResourceStore ? { chatResources: createMcpChatResourceArchiveReader(chatResources, diagnostics ? (record) => diagnostics.record(record) : undefined) } : {}),
    getLiveLoginBinding: getMcpLiveLoginBinding,
    onInternalObservation: (jobId, observation) => agentService?.noteMcpObservation(jobId, observation) });
  /** Tells subscribers to re-read the execution policy after a successful write. */
  const publishExecutionPolicyChanged = (): void => { options.publish?.({ type: 'agentExecutionPolicyChanged' }); };
  // Pending approvals settle (cancelled → deny) before MCP admission closes.
  stopMcpService = onceCleanup(async () => { await approvalBroker.close(); await mcpService.shutdown(); });
  startupCleanup.add(stopMcpService);
  mcpHttpServer = new McpHttpServer(mcpService, { unref: true,
    onDiagnostic: () => options.audit?.failure(diagnosticFailure('mcp', 'response')),
    ...(options.mcpHttpPort === undefined ? {} : { port: options.mcpHttpPort }) });
  const userProfile = process.env.USERPROFILE ?? homedir();
  const appData = process.env.APPDATA ?? path.join(userProfile, 'AppData', 'Roaming');
  mcpLocalClients = new McpLocalClients({
    claudeConfigPath: options.mcpLocalClientPaths?.claudeDesktop ?? path.join(appData, 'Claude', 'claude_desktop_config.json'),
    codexConfigPath: options.mcpLocalClientPaths?.codex ?? path.join(process.env.CODEX_HOME ?? path.join(userProfile, '.codex'), 'config.toml'),
    execPath: options.mcpLocalClientExecPath ?? process.execPath,
    bridgePath: options.mcpLocalClientBridgePath ?? (options.mcpLocalClientAppPath
      ? resolveMcpLocalClientBridgePath(options.mcpLocalClientAppPath, options.mcpLocalClientPackaged === true)
      : path.join(path.dirname(fileURLToPath(import.meta.url)), 'mcp-stdio-bridge.js')),
    getPort: () => mcpHttpServer.status().port });
  // Register before bind so even a failed listen is unwound.
  stopMcpHttpServer = onceCleanup(() => mcpHttpServer.shutdown());
  startupCleanup.add(stopMcpHttpServer);
  await agents.recoverInterruptedState();
  await settings.setAppSetting('attachment_root', options.attachmentRoot);

  const auditWorkerStop = async (binding: WorkerBinding, stop: () => Promise<void>, initiator: 'user' | 'system' = 'system'): Promise<void> => {
    const correlationId = options.audit?.request('worker_stop', { initiator, accountId: binding.accountId,
      workerInstanceId: binding.workerInstanceId, reasonCode: 'operator_action' });
    try {
      await stop();
      if (correlationId) options.audit?.complete(correlationId, 'succeeded', { resultCode: 'worker_stopped' });
    } catch (error) {
      if (correlationId) options.audit?.complete(correlationId, 'failed', { errorCode: 'WORKER_STOP_FAILED' });
      throw error;
    }
  };
  const auditSecretClear = async (accountId: string, initiator: 'user' | 'system', correlation?: { requestId?: string; loginAttemptId?: string },
    lineTransport?: LineTransportKind): Promise<void> => {
    if (!options.secretStore) return;
    const correlationId = options.audit?.request('secret_clear', { initiator, accountId,
      ...(correlation?.requestId ? { requestId: correlation.requestId } : {}),
      ...(correlation?.loginAttemptId ? { loginAttemptId: correlation.loginAttemptId } : {}),
      reasonCode: initiator === 'user' ? 'operator_action' : 'auth_invalidated' });
    try {
      await options.secretStore.clear(accountId, lineTransport);
      if (correlationId) options.audit?.complete(correlationId, 'succeeded', { resultCode: 'secret_removed' });
    } catch (error) {
      if (correlationId) options.audit?.complete(correlationId, 'failed', { errorCode: 'SECRET_CLEAR_FAILED' });
      throw error;
    }
  };

  const stopAndClearWorkerBinding = async (accountId: string, initiator: 'user' | 'system'): Promise<void> => {
    const running = await options.workers.binding(accountId) ?? supervisor.binding(accountId);
    const durable = running ?? await accounts.getWorkerBinding(accountId);
    if (running) {
      await auditWorkerStop(running, () => options.workers.stopBinding(running), initiator);
      lineService.unbind(running.workerInstanceId);
      if (supervisor.isCurrent(running) && !supervisor.retireWithinLifecycle(running)) {
        throw new Error('Stopped LINE worker no longer owns active control');
      }
    }
    if (durable && !await accounts.clearStoppedWorkerBinding(durable)) {
      throw new Error('Stopped LINE worker binding changed before compare-clear');
    }
  };

  const health = new HealthService(options.pool, options.workers.health
    ? { status: () => options.workers.health!() }
    : undefined);
  publishSnapshot = createCoalescedSnapshotPublisher(async () => {
    const snapshot = await health.snapshot();
    const buildTrustState = options.officialBuildTrust ? await options.officialBuildTrust.state().catch(() => null) : null;
    const officialBuildFor = (account: { productRole?: string | null | undefined }) => account.productRole === 'PRIMARY_ADMIN' && buildTrustState?.lastObserved
      ? { officialLineBuild: { version: buildTrustState.lastObserved.version, status: buildTrustState.lastObserved.verdict } } : {};
    const accountsWithManualSend = await Promise.all(snapshot.accounts.map(async (account) => {
      if (account.status !== 'connected') {
        const [stored, agentAccount] = await Promise.all([accounts.getAccount(account.accountId),
          account.productRole === 'PRIMARY_ADMIN' ? accounts.listAuthenticatedAccounts() : Promise.resolve([])]);
        const agent = agentAccount.find((item) => item.productRole === 'AGENT');
        const verifiedBinding = !!stored?.ownMid && await externalAdminAuthorized(agent, stored.ownMid);
        const capability = await accounts.resolveCapabilities(account.accountId);
        const canStartExternalImport = !!options.officialSnapshotImporter?.readOfficialSnapshot
          && !!options.officialSnapshotImporter.readOfficialMonitor && account.productRole === 'PRIMARY_ADMIN'
          && verifiedBinding && account.status === 'disconnected' && !externalImportOwner;
        return { ...account, canSendManually: false, canStartExternalImport, hasVerifiedLineIdentity: !!stored?.ownMid,
          externalImportProgress: externalImportProgress.get(account.accountId) ?? null, ...officialBuildFor(account) };
      }
      const [stored, capabilities, binding] = await Promise.all([
        accounts.getAccount(account.accountId), accounts.resolveCapabilities(account.accountId), options.workers.binding(account.accountId),
      ]);
      const canSendManually = !!stored?.ownMid && (stored.productRole === 'AGENT' || stored.productRole === 'PRIMARY_ADMIN')
        && stored.mode !== 'PAUSED' && capabilities?.canWriteLine === true && !!binding
        && binding.mode !== 'PAUSED' && lineService.isAuthenticatedReady(binding)
        && options.workers.isCurrentManualSendBinding(binding);
      return { ...account, canSendManually, canStartExternalImport: false, hasVerifiedLineIdentity: !!stored?.ownMid,
        externalImportProgress: externalImportProgress.get(account.accountId) ?? null, ...officialBuildFor(account) };
    }));
    const accountsWithTransport = await Promise.all(accountsWithManualSend.map(async (account) =>
      await transportOf(account.accountId) === 'CHROMEOS' ? { ...account, lineTransport: 'CHROMEOS' as const } : account));
    return { ...snapshot, accounts: accountsWithTransport };
  }, (event) => options.publish?.(event));
  stopPublishSnapshot = onceCleanup(() => publishSnapshot.shutdown());
  startupCleanup.add(stopPublishSnapshot);
  const unsubscribeBuildTrust = options.officialBuildTrust?.onChange(() => {
    if (!closing) void publishSnapshot().catch(() => undefined);
  });
  if (unsubscribeBuildTrust) startupCleanup.add(unsubscribeBuildTrust);
  function publishAgentJobStatus(projection: AgentJobStatusProjection): void {
    // Only LINE jobs have a message status marker; the shared Agent room's jobs ride the snapshot.
    if (projection.sourceType === 'line' && projection.sourceMessageId) options.publish?.({ type: 'agentJobStatusChanged',
      accountId: projection.accountId, chatType: projection.chatType, chatId: projection.chatId, sourceMessageId: projection.sourceMessageId,
      jobId: projection.jobId, status: projection.status, revision: projection.revision });
  }
  unsubscribeAuth = options.agent.onAuthStatus?.((auth) => {
    if (closing) return;
    if (auth.status === 'error') options.audit?.failure({ ...diagnosticFailure('provider_auth', 'authenticate'), provider: auth.provider });
    applyProviderAuthStatus(health, auth);
    void publishSnapshot().catch(() => undefined);
  });
  if (unsubscribeAuth) startupCleanup.add(unsubscribeAuth);
  unsubscribeWorkerExit = options.workers.onWorkerExit?.((binding) => {
    chatResourceAdmission.close(binding.accountId, 'The account worker exited.');
    options.audit?.observed('worker_exited', {
      initiator: 'worker', accountId: binding.accountId, workerInstanceId: binding.workerInstanceId,
      reasonCode: 'worker_exit', correlationId: binding.workerInstanceId,
    });
  });
  if (unsubscribeWorkerExit) startupCleanup.add(unsubscribeWorkerExit);
  let skillText: string | undefined;
  const internalMcpLauncher: InternalMcpLauncher = {
    mint: (job) => {
      const transport = mcpHttpServer.status();
      if (!transport.running || !transport.endpoint) return null;
      const { token } = mcpService.internalCapabilities.mint({ jobId: job.jobId, accountId: job.accountId, generation: job.generation,
        approval: job.approval, endpointInstance: mcpHttpServer.endpointInstance });
      return { endpoint: transport.endpoint, token };
    },
    release: (jobId) => mcpService.internalCapabilities.release(jobId),
    scheduleContext: (sourceRequestId, jobId) => agentSchedules.runContext(sourceRequestId, jobId),
    skill: async () => {
      if (!options.skillsDirectory) return null;
      if (skillText) return skillText;
      const loaded = await loadLinejsMcpSkill(options.skillsDirectory);
      if (loaded) skillText = loaded; // Failed reads are retried on the next launch.
      return loaded;
    },
  };
  let providerQuotaService!: ProviderQuotaService;
  const validateQuotaFailureNotice = async (jobId:string, expected?:WorkerBinding):Promise<Bound|null> => {
    const job=await agents.getJob(jobId);
    if(!job||job.sourceType!=='line') return null;
    const current=await options.workers.binding(job.accountId);
    if(!current||current.mode!=='ACTIVE_CONTROL'||current.purpose==='DOWNLOAD_ONLY'||current.accountId!==job.accountId
      ||current.controlEpoch!==job.creationEpoch||(expected&&(current.workerInstanceId!==expected.workerInstanceId||current.controlEpoch!==expected.controlEpoch))
      ||!lineService.isAuthenticatedReady(current)||!options.workers.isCurrentActiveControlBinding(current)) return null;
    if(!await providerQuota.validateFailureNoticeAuthority({jobId,accountId:job.accountId,workerInstanceId:current.workerInstanceId,controlEpoch:current.controlEpoch})) return null;
    return current;
  };
  const handleProviderQuotaFailure = async (jobId: string, event: Extract<AgentEvent,{type:'failed'}>, observedAt = new Date().toISOString()): Promise<void> => {
    const failedJob=await agents.getJob(jobId);
    if(!failedJob) return;
    const resetAt=event.quotaRecoveryAt??providerFailureResetAt(event.message,Date.parse(observedAt));
    await providerQuota.recordFailure({provider:failedJob.provider,observedAt,recoveryAt:resetAt??null,
      source:'Agent PROVIDER_LIMIT failure',evidence:event.message});
    if(failedJob.sourceType!=='line') return;
    if(!await validateQuotaFailureNotice(jobId)) { await providerQuota.skipNotice(jobId); return; }
    const targetProvider=failedJob.provider==='codex'?'claude':'codex';
    const alternate=await providerQuotaService.get(targetProvider);
    await providerQuota.saveSnapshot({provider:targetProvider,requestedAt:alternate.requestedAt,fetchedAt:alternate.fetchedAt,
      stale:alternate.stale,snapshot:alternate});
    const stored=await providerQuota.get(targetProvider);
    const alternateBlocked=!!stored?.blocked||alternate.windows.some(window=>window.blocksProvider&&window.usedPercent>=100);
    const currentState=await providerQuota.get(failedJob.provider);
    const alternateAvailable=!alternate.error&&!alternate.stale&&!!alternate.fetchedAt&&alternate.availabilityKnown&&alternate.windows.length>0
      &&!alternate.windows.some(window=>window.blocksProvider&&window.usedPercent>=100)&&!!stored&&!stored.blocked;
    const consentAvailable=alternateAvailable&&await providerQuota.createProposal(jobId,targetProvider,new Date(Date.now()+10*60_000).toISOString());
    if(!await validateQuotaFailureNotice(jobId)) { await providerQuota.skipNotice(jobId); return; }
    await providerQuota.createNotice(jobId);
    const noticeBinding=await validateQuotaFailureNotice(jobId);
    if(!noticeBinding) { await providerQuota.skipNotice(jobId); return; }
    if(!await providerQuota.claimNotice(jobId)) return;
    const failedName=failedJob.provider==='codex'?'Codex':'Claude';
    const targetName=targetProvider==='codex'?'Codex':'Claude';
    const recovery=currentState?.recoveryAt??resetAt??null;
    const suggestion=quotaFailureSuggestion({currentName:failedName,currentRecoveryAt:recovery,targetName,
      currentBlocked:currentState?.blocked===true,alternateBlocked,alternateRecoveryAt:stored?.recoveryAt??null,
      alternateAvailable,alternateQueryError:alternate.error,alternateStale:alternate.stale,consentAvailable,
      originalSenderAdmin:consentAvailable});
    const currentReset=recovery?new Intl.DateTimeFormat('zh-TW',{timeZone:'Asia/Taipei',dateStyle:'medium',timeStyle:'short'}).format(new Date(recovery)):'重設時間未知';
    const failureStatus=currentState?.blocked&&alternateBlocked?`${failedName} 額度已用完。`:`${failedName} 額度已用完；預計重設：${currentReset}。`;
    try {
      const sent=await agentLineSend.sendSystemText({runId:randomUUID(),target:failedJob,principalId:'system:provider_quota',
        text:`${failureStatus}這次工作已失敗。${suggestion}`,
        validateBeforeSend:async(binding)=>{
          const sameBinding=binding.accountId===noticeBinding.accountId&&binding.workerInstanceId===noticeBinding.workerInstanceId
            &&binding.controlEpoch===noticeBinding.controlEpoch;
          const valid=sameBinding&&!!await validateQuotaFailureNotice(jobId,noticeBinding);
          if(!valid) await providerQuota.skipNotice(jobId);
          return !!valid;
        }});
      await providerQuota.finishNotice(jobId,sent.status==='sent'?'sent':'unknown');
    } catch { await providerQuota.finishNotice(jobId,'unknown').catch(()=>undefined); }
  };
  agentService = new AgentService(agents, workspace, options.agent,
    async (jobId, event) => {
      if (event.type === 'failed' && event.code === 'PROVIDER_LIMIT') await handleProviderQuotaFailure(jobId,event).catch(()=>undefined);
      if (event.type === 'failed') options.audit?.failure({ operation: 'agent',
        stage: event.code === 'BRIDGE_ERROR' ? 'spawn' : event.code === 'INVALID_JSONL' ? 'parse' : 'execute',
        category: event.code === 'AUTH_REQUIRED' ? 'authentication_required' : event.code === 'TIMEOUT' ? 'timeout' : 'unknown',
        recovery: event.code === 'AUTH_REQUIRED' ? 'check_configuration' : 'retry' }, { jobId });
      if (event.type === 'failed') freeMode?.noteJobFailed(jobId, event.message);
      options.publish?.({ type: 'agentEvent', jobId, event });
      if (event.type === 'started' || event.type === 'completed' || event.type === 'failed' || event.type === 'cancelled') {
        await publishSnapshot().catch(() => undefined);
      }
    },
    async (jobId) => delivery.deliverCompletedJob(jobId),
    2, 30 * 60 * 1000, 5000, 1,
    async (jobId, key, messageId, reaction) => {
      // A free-mode job is not a reply to its last batch message: no reaction on a member's message.
      if (await freeModeStore.isFreeModeJob(jobId).catch(() => false)) return;
      return lineService.reactToMessage(key, messageId, reaction);
    },
    (job) => mcpService.resolvePromptContext(job),
    (projection) => publishAgentJobStatus(projection),
    internalMcpLauncher, agentJobEnvironment,
    (diagnostic, jobId) => options.audit?.failure(diagnostic, { ...(jobId ? { jobId } : {}) }),
    (chat) => resolveEffectivePersona(settings, chat).then((persona) => persona.description),
    async (provider) => {
      const current=await providerQuota.get(provider);
      if(!current?.blocked) return null;
      const reset=current.recoveryAt?Date.parse(current.recoveryAt):NaN;
      if(!Number.isFinite(reset)||reset>Date.now()) return {blocked:true,recoveryAt:current.recoveryAt};
      const snapshot=await providerQuotaService.refreshNow(provider);
      await providerQuota.saveSnapshot({provider,requestedAt:snapshot.requestedAt,fetchedAt:snapshot.fetchedAt,stale:snapshot.stale,snapshot});
      const updated=await providerQuota.get(provider);
      return updated?.blocked?{blocked:true,recoveryAt:updated.recoveryAt}:null;
    });
  providerQuotaService = new ProviderQuotaService((provider) => agentService.queryQuota(provider));
  agentService.setStatusRotationIntervalSeconds(conversationSettings.agentStatusRotationIntervalSeconds);
  stopAgentService = onceCleanup(() => agentService.shutdown());
  startupCleanup.add(stopAgentService);

  async function ensureDownloadOnlyWorker(accountId: string, expectedMid: string): Promise<Bound> {
    const current = await options.workers.binding(accountId);
    if (current) {
      if (current.purpose === 'DOWNLOAD_ONLY' && current.expectedMid === expectedMid) return current;
      throw new Error('Another LINE worker already owns this account.');
    }
    const account = await accounts.getAccount(accountId);
    const capability = await accounts.resolveCapabilities(accountId);
    const control = await accounts.getControlState();
    if (!account || account.productRole !== 'PRIMARY_ADMIN' || account.ownMid !== expectedMid
      || capability?.connectionMode !== 'EXTERNAL_MONITOR' || control.activeAccountId === accountId || loginAttempts.has(accountId)) {
      throw new Error('External download worker eligibility changed.');
    }
    const binding: Bound = { accountId, workerInstanceId: randomUUID(), controlEpoch: control.controlEpoch,
      mode: 'MONITOR_ONLY', purpose: 'DOWNLOAD_ONLY', expectedMid };
    await options.workers.start(accountId, binding);
    const started = await options.workers.binding(accountId);
    if (!started || started.workerInstanceId !== binding.workerInstanceId || started.purpose !== 'DOWNLOAD_ONLY') {
      throw new Error('External download worker did not start under its expected binding.');
    }
    return started;
  }

  // Borrowing the official LINE app token for external downloads is shelved.
  const downloadTokenLookupEnabled = options.externalDownloadTokenLookup === true;

  function ensureDownloadOnlyAuth(binding: Bound | null, signal?: AbortSignal, requestedAccountId?: string,
    requestedExpectedMid?: string, canAcquireAuth?: () => boolean): Promise<boolean> {
    if (!downloadTokenLookupEnabled) return Promise.resolve(false);
    const accountId = binding?.accountId ?? requestedAccountId;
    const expectedMid = binding?.expectedMid ?? requestedExpectedMid;
    if (!accountId || !expectedMid) return Promise.resolve(false);
    const existing = downloadAuthFlights.get(accountId);
    if (existing) return existing;
    const task = (async () => {
      if (signal?.aborted || closing || !options.workers.adoptDownloadAuth) return false;
      const access = nativeMonitorAccess.get(accountId);
      const capability = await accounts.resolveCapabilities(accountId);
      if (!access || access.signal.aborted || access.sourceId !== capability?.selectedSourceId
        || access.generation !== capability?.selectedSourceGeneration) return false;
      let current = binding ?? await ensureDownloadOnlyWorker(accountId, expectedMid);
      if (current.purpose !== 'DOWNLOAD_ONLY' || current.expectedMid !== expectedMid) return false;
      if (options.workers.isDownloadReady?.(current)) return true;
      const actual = await options.workers.binding(accountId);
      if (!actual || actual.purpose !== 'DOWNLOAD_ONLY' || actual.workerInstanceId !== current.workerInstanceId
        || actual.controlEpoch !== current.controlEpoch || actual.expectedMid !== expectedMid) return false;
      current = actual;
      let acquired: Awaited<ReturnType<NativeMonitorAccess['acquireAuthCandidates']>>;
      if (canAcquireAuth && !canAcquireAuth()) return false;
      const probeSignal = signal ?? access.signal;
      const probe = await resolveDownloadAuthProbe(accountId, probeSignal);
      if (!probe) {
        if (!signal?.aborted && !access.signal.aborted) await options.workers.stopBinding(current).catch(() => undefined);
        return false;
      }
      try { acquired = await access.access.acquireAuthCandidates(probeSignal); }
      catch (error) {
        if (!probeSignal.aborted) {
          options.audit?.failure(diagnosticFailure('adoptDownloadAuth', 'prepare', error),
            { accountId, initiator: 'system', background: true }, 'ATTACHMENT_DOWNLOAD_OPERATION_FAILED');
        }
        await options.workers.stopBinding(current).catch(() => undefined);
        return false;
      }
      if (signal?.aborted || access.signal.aborted) return false;
      for (const candidate of acquired.candidates) {
        if (signal?.aborted || access.signal.aborted || closing) return false;
        try {
          const { mode: _mode, purpose: _purpose, expectedMid: _expectedMid, application: _application, ...workerBinding } = current;
          const result = await options.workers.adoptDownloadAuth({ type: 'adoptDownloadAuth', ...workerBinding,
            requestId: randomUUID(), token: candidate.token, application: candidate.application, expectedMid, probe }, probeSignal);
          if (result.accepted) return true;
        } catch { /* A failed candidate is followed by the next bounded native candidate. */ }
      }
      if (!signal?.aborted && !access.signal.aborted) {
        options.audit?.failure(diagnosticFailure('adoptDownloadAuth', 'authenticate'),
          { accountId, initiator: 'system', background: true }, 'ATTACHMENT_DOWNLOAD_OPERATION_FAILED');
        await options.workers.stopBinding(current).catch(() => undefined);
      }
      return false;
    })().finally(() => { if (downloadAuthFlights.get(accountId) === task) downloadAuthFlights.delete(accountId); });
    downloadAuthFlights.set(accountId, task);
    return task;
  }

  async function resolveNativeAttachment(attachment: Attachment, signal: AbortSignal) {
    if (!attachment.externalSource || !attachment.nativePayload || signal.aborted) return null;
    const active = nativeMonitorAccess.get(attachment.accountId);
    if (!active || active.signal.aborted) return null;
    const result = await active.access.decodeAttachment({ envelope: attachment.nativePayload,
      expectedMessageId: attachment.messageId, expectedChatId: attachment.chatId }, signal);
    if (signal.aborted || !result.metadata) return null;
    return NativeAttachmentDownloadInputSchema.parse(result.metadata);
  }

  async function resolveDownloadAuthProbe(accountId: string, signal: AbortSignal): Promise<DownloadAuthProbe | null> {
    if (signal.aborted) return null;
    const candidates = await messages.getRecentExternalAttachmentsForDownloadProbe(accountId, 5);
    for (const candidate of candidates) {
      if (signal.aborted) return null;
      if (!isWritableChatType(candidate.chatType)) continue;
      try {
        const nativeAttachment = await resolveNativeAttachment(candidate, signal);
        if (!nativeAttachment) continue;
        return {
          chatType: candidate.chatType,
          chatId: candidate.chatId,
          messageId: candidate.messageId,
          externalAttachmentId: candidate.externalAttachmentId,
          kind: candidate.kind,
          lineMessage: candidate.lineMessage,
          nativeAttachment,
        };
      } catch { /* Try the next recent attachment candidate. */ }
    }
    return null;
  }

  attachmentService = new AttachmentService(messages, {
    binding: async (accountId) => {
      await downloadAuthFlights.get(accountId)?.catch(() => false);
      if (!downloadTokenLookupEnabled) return await options.workers.binding(accountId);
      const current = await options.workers.binding(accountId);
      if (current) return current;
      const access = nativeMonitorAccess.get(accountId);
      if (!access || access.signal.aborted) return null;
      const account = await accounts.getAccount(accountId);
      if (!account?.ownMid) return null;
      try { return await ensureDownloadOnlyWorker(accountId, account.ownMid); }
      catch (error) {
        options.audit?.failure(diagnosticFailure('downloadAttachment', 'spawn', error),
          { accountId, initiator: 'system', background: true }, 'ATTACHMENT_DOWNLOAD_OPERATION_FAILED');
        return null;
      }
    },
    isReady: async (binding, canAcquireAuth): Promise<boolean> => {
      const current = await options.workers.binding(binding.accountId);
      if (!current || current.mode === 'PAUSED' || current.workerInstanceId !== binding.workerInstanceId
        || current.controlEpoch !== binding.controlEpoch) return false;
      if (current.purpose === 'DOWNLOAD_ONLY') {
        if (!await ensureDownloadOnlyAuth(current, undefined, undefined, undefined, canAcquireAuth)) return false;
        return options.workers.isDownloadReady?.(current) ?? true;
      }
      if (!lineService.isAttachmentReady(current)) return false;
      return await options.workers.waitModeAck(current.accountId, current.mode, 0);
    },
    download: (command, signal) => options.workers.download(command, signal),
  }, options.attachmentRoot, 4, async (attachmentId) => {
    options.publish?.({ type: 'attachmentChanged', attachmentId });
    void publishSnapshot().catch(() => undefined);
  }, (error, identity) => options.audit?.failure(parseSafeDiagnostic(error) ?? diagnosticFailure('attachment', 'execute', error), identity), resolveNativeAttachment, async (accountId) =>
    (await options.pool.query<{ status: string }>('SELECT status FROM line_accounts WHERE account_id=$1', [accountId])).rows[0]?.status === 'connected',
  Math.random, (result) => recordAttachmentServerResult(options, result),
  // One audit row for each reason change of one account. The detail field holds the bounded reason code.
  (accountId, reason) => options.audit?.failure({ operation: 'attachment', stage: 'queue', outcome: 'not_started', detail: reason,
    category: reason === 'ATTACHMENT_WORKER_UNAVAILABLE' ? 'authentication_required' : 'unavailable',
    recovery: reason === 'ATTACHMENT_WORKER_UNAVAILABLE' ? 'relogin' : reason === 'ATTACHMENT_WORKER_NOT_READY' ? 'wait' : 'none' },
  { accountId, initiator: 'system' }, 'ATTACHMENT_DOWNLOAD_OPERATION_FAILED'));
  stopAttachmentService = onceCleanup(() => attachmentService.shutdown());
  startupCleanup.add(stopAttachmentService);
  attachmentService.setAutomaticAttemptLimit(conversationSettings.attachmentAutoAttemptLimit);
  void attachmentService.backfillBlockReasons();
  previewService = options.previewPresenter ? new AttachmentPreviewService({ root: options.attachmentRoot,
    onDiagnostic: (diagnostic, identity) => options.audit?.failure(diagnostic, identity),
    ...(options.previewCacheRoot ? { cacheRoot: options.previewCacheRoot } : {}),
    authority: createRepositoryPreviewAuthority(messages), presenter: options.previewPresenter }) : null;
  stopPreview = onceCleanup(() => previewService?.shutdown());
  if (previewService) startupCleanup.add(stopPreview);
  if (options.openAttachmentPath) {
    attachmentOpenService = new AttachmentOpenService({ root: options.attachmentRoot,
      onDiagnostic: (diagnostic, identity) => options.audit?.failure(diagnostic, identity),
      authority: createRepositoryPreviewAuthority(messages), openPath: options.openAttachmentPath });
    stopAttachmentOpen = onceCleanup(() => attachmentOpenService?.shutdown());
    startupCleanup.add(stopAttachmentOpen);
  }
  lineMedia = new LineMediaService({
    onDiagnostic: (diagnostic, identity) => options.audit?.failure(diagnostic, identity),
    ...(options.mediaCacheRoot ? { cacheRoot: options.mediaCacheRoot } : {}),
    loadAttachment: async (key, attachmentId, signal) => previewService?.readImage(attachmentId, key, { senderId: 0 }, 8 * 1024 * 1024, signal) ?? null,
    loadAlbumPhoto: async (key, albumId, photoId, signal) => chatResources.readSavedAlbumPhoto(key, albumId, photoId, signal),
  });
  stopLineMedia = onceCleanup(() => lineMedia.shutdown());
  startupCleanup.add(stopLineMedia);
  const loginAttempts = new Map<string, string>();
  // Login attempt that the worker finished with a 'login' event. The loginAttempts entry stays after login success.
  const completedLoginAttempts = new Map<string, string>();
  /**
   * Local teardown of an account session that has no server session to end (a pending or failed login), or whose server
   * session is already ended. It stops the worker, releases control and clears the stopped binding. It clears no secrets.
   * Run it inside `supervisor.runLifecycle`.
   */
  const releaseAccountSession = async (accountId: string, binding: WorkerBinding | null | undefined, loginAttemptId: string | undefined,
    initiator: 'user' | 'system'): Promise<void> => {
    chatResourceAdmission.close(accountId, 'LINE logout was confirmed.');
    await stopExternalImportForAccount(accountId);
    if (binding) await auditWorkerStop(binding, () => options.workers.stopBinding(binding), initiator);
    const control = await accounts.getControlState();
    if (control.activeAccountId === accountId) {
      if (binding && supervisor.isCurrent(binding)) supervisor.retireWithinLifecycle(binding);
      else await supervisor.revokeControlAndCancel(control.controlEpoch);
    }
    loginAttempts.delete(accountId);
    completedLoginAttempts.delete(accountId);
    if (binding) lineService.unbind(binding.workerInstanceId);
    const durableBinding = binding ?? await accounts.getWorkerBinding(accountId);
    if (loginAttemptId && durableBinding) await lineService.cancelLoginAttempt(accountId, durableBinding.workerInstanceId, loginAttemptId);
    if (durableBinding && !await accounts.clearStoppedWorkerBinding(durableBinding)) {
      throw new Error('Stopped LINE worker binding changed before compare-clear');
    }
  };
  /** Binding fields that depend on the login method. DESKTOPWIN adds no field, so its bindings do not change. */
  const transportFields = (lineTransport: LineTransportKind | undefined) =>
    resolveLineTransport(lineTransport) === 'CHROMEOS' ? { lineTransport: 'CHROMEOS' as const } : {};
  /** Login method of the account. The marker file in the secret store holds it. If there is no marker, it is DESKTOPWIN. */
  function transportOf(accountId: string): Promise<LineTransportKind> {
    return options.secretStore?.getTransport(accountId) ?? Promise.resolve('DESKTOPWIN' as const);
  }
  /** Null when the login method can start. Otherwise, the reason why CHROMEOS cannot start. Main starts no worker in that case. */
  async function chromeLtsmBlock(lineTransport: LineTransportKind | undefined): Promise<ChromeLtsmUnavailableStatus | null> {
    if (resolveLineTransport(lineTransport) !== 'CHROMEOS') return null;
    const status = await options.chromeLogin?.ltsm.status().catch(() => null);
    if (status?.kind === 'available') return null;
    return status ?? { kind: 'missing', required: CHROME_EXTENSION_VERSION };
  }
  const adminPairings = new AdminPairingService({
    hasPrimary: (accountId) => admins.hasPrimary(accountId),
    bindPrimary: (accountId, chatId, userId) => accounts.bindPrimaryAdministrator(accountId, chatId, userId),
  });
  const friendEnrollment = new FriendEnrollmentService({ admins, whitelist: friendWhitelist, accounts, workers: {
    binding: (accountId) => options.workers.binding(accountId),
    isCurrentActiveControlBinding: (binding) => options.workers.isCurrentActiveControlBinding(binding),
    async send(command) { await assertLineWriteAllowed(command.accountId); return options.workers.send(command); },
  }, audit: options.audit, locale: options.locale ?? 'en' });
  const roomIsCurrentControl = async (binding: WorkerBinding): Promise<boolean> => {
    const [control, current] = await Promise.all([accounts.getControlState(), options.workers.binding(binding.accountId)]);
    return control.activeAccountId === binding.accountId && control.controlEpoch === binding.controlEpoch
      && !!current && current.mode === 'ACTIVE_CONTROL' && current.workerInstanceId === binding.workerInstanceId
      && current.controlEpoch === binding.controlEpoch
      && await options.workers.waitModeAck(binding.accountId, 'ACTIVE_CONTROL', 0);
  };
  // One validated LINE reply transport shared by room automation and the /權限 dialogue.
  const lineReplyTransport: RoomAutomationTransport = {
    async isAgentAccount(accountId) {
      return (await accounts.getAccount(accountId))?.productRole === 'AGENT';
    },
    async activeBinding(accountId) {
      const current = lineService.binding(accountId);
      return current && await roomIsCurrentControl(current) ? current : null;
    },
    isCurrentControl: roomIsCurrentControl,
    send: (command, signal) => sendLineCommand(command, signal),
  };
  const roomAutomation = new RoomAutomationService(roomActivation, autoresponders,
    await options.secretStore?.loadOrCreateRoomActivationDigestKey() ?? randomBytes(32), 1, lineReplyTransport, options.locale ?? 'en');
  const permissionCommands = createPermissionCommandService(permissionRepository, lineReplyTransport,
    publishExecutionPolicyChanged, options.locale ?? 'en', (diagnostic) => options.audit?.failure(diagnostic));
  // Group free mode: durable window per chat, debounced member messages, one room-member Agent job per batch.
  freeMode = new FreeModeService({ store: freeModeStore,
    roomGrant: (key) => roomActivation.getActiveRoomAuthorization(key).then((grant) => grant ? { grantId: grant.grantId, version: grant.version } : null),
    enableRoom: (key, adminUserId, sourceMessageId) => roomAutomation.enableByPrimaryAdmin(
      { accountId: key.accountId, chatType: key.chatType as 'group' | 'room', chatId: key.chatId }, adminUserId, sourceMessageId),
    sendSystemText: (input) => agentLineSend.sendSystemText(input),
    provider: async (key) => resolveChatProvider(settings, (await settings.getConversationAgent(key))?.provider),
    workspacePath: async () => { const inspection = await workspace.inspect(); return inspection.status === 'available' ? inspection.path : null; },
    kick: (key) => agentService.kick(key),
    persona: (key) => resolveEffectivePersona(settings, key),
    ...(options.agent.judge && options.freeModeJudgeDirectory ? { judge: async (input) => {
      await mkdir(options.freeModeJudgeDirectory!, { recursive: true });
      return options.agent.judge!({ provider: input.provider, prompt: input.prompt, systemPrompt: input.systemPrompt,
        workspacePath: options.freeModeJudgeDirectory!, timeoutMs: input.timeoutMs, ...(input.resumeSessionId ? { resumeSessionId: input.resumeSessionId } : {}) });
    } } : {}),
    // Codex needs the local-tools permission; the room-member principal usually lacks it, so free mode then runs on Claude.
    canUseProvider: async (key, provider) => provider !== 'codex' || deriveToolPolicy({ principal: { kind: 'user', senderMid: FREE_MODE_MEMBER_ID },
      permissions: await resolveUserPermissions(options.pool, key.accountId, FREE_MODE_MEMBER_ID, { chatType: key.chatType, chatId: key.chatId }) }).localTools,
    interruptJob: (key, jobId) => agentService.stopJob(key, jobId),
    audit: (event) => {
      const identity = { initiator: 'system' as const, accountId: event.key.accountId };
      if (event.type === 'judge_failed') options.audit?.failure(diagnosticFailure('agent', 'execute', event.error));
      else if (event.type === 'judge') options.audit?.observed('free_mode_judge', { ...identity,
        resultCode: event.verdict.reply ? 'free_mode_judge_reply' : 'free_mode_judge_no_reply' });
      else if (event.type === 'interrupt') options.audit?.observed('free_mode_interrupt', { ...identity, jobId: event.jobId, resultCode: 'free_mode_interrupted' });
      else options.audit?.observed('free_mode_interrupt', { ...identity, jobId: event.jobId,
        resultCode: `free_mode_interrupt_refused_${event.reason}` as const });
    },
    onError: (error) => { options.audit?.failure(diagnosticFailure('agent', 'execute', error)); } });
  startupCleanup.add(() => freeMode?.stop());
  // /folder: company project folders bound to a chat by the Primary Administrator (docs/architecture/project-folders.md).
  projectFolders = new ProjectFolderService({ store: new ProjectFolderRepository(options.pool),
    sendSystemText: (input) => agentLineSend.sendSystemText(input),
    policy: defaultProjectPathPolicy({ homeDirectory: process.env.USERPROFILE ?? homedir(),
      protectedPaths: options.projectFolderProtectedPaths ?? [],
      workspace: async () => { const inspection = await workspace.inspect(); return inspection.status === 'available' ? inspection.path : inspection.configuredPath; } }),
    onError: (error) => { options.audit?.failure(diagnosticFailure('agent', 'execute', error)); } });
  lineService = new LineService(accounts, messages, settings,
    { send: async (command) => { await sendLineCommand(command); } }, agentService, options.secretStore, attachmentService,
    async (envelope, secretCandidate, ownMid, capturedBinding) => {
      const postNotificationSubtype = nativePostNotificationSubtype(envelope);
      if (!closing && capturedBinding?.mode === 'ACTIVE_CONTROL' && postNotificationSubtype === 'album') {
        const current = await options.workers.binding(envelope.accountId);
        const archiveBinding = asChatResourceBinding(current);
        if (archiveBinding && sameCapturedBinding(archiveBinding, capturedBinding)) {
          const key = { accountId: envelope.accountId, chatType: envelope.chatType, chatId: envelope.chatId } as const;
          try {
            if (await albumNotificationTasks.enqueueCommitted({ ...key, messageId: envelope.messageId })) {
              albumDispatcher.request(key, archiveBinding);
            }
          } catch {
            chatResources.recordNotificationFailure(key, new Error('ALBUM_TASK_PERSIST_FAILED'));
            albumDispatcher.recover(envelope.accountId, archiveBinding);
          }
        }
      }
      const paired = await adminPairings.consume(envelope);
      if (paired) {
        void publishSnapshot().catch(() => console.warn('[admin-pairing] snapshot publish failed'));
        if (!closing) void track(async () => {
          if (closing) return;
          const binding = await options.workers.binding(envelope.accountId);
          if (!binding || binding.mode !== 'ACTIVE_CONTROL'
            || !options.workers.isCurrentActiveControlBinding(binding)) {
            console.warn('[admin-pairing] welcome send skipped: binding unavailable');
            return;
          }
          if (closing || !options.workers.isCurrentActiveControlBinding(binding)) return;
          try {
            await assertLineWriteAllowed(envelope.accountId);
            if (closing || !options.workers.isCurrentActiveControlBinding(binding)) return;
            const result = await sendLineCommand({ type: 'sendText', ...binding, accountId: envelope.accountId,
              requestId: randomUUID(), chatType: 'direct', chatId: envelope.chatId,
              text: linePrompt(options.locale ?? 'en', 'adminWelcome'), replyToMessageId: null });
            if (result.status !== 'sent') console.warn('[admin-pairing] welcome send did not report sent');
          } catch (error) {
            options.audit?.failure(diagnosticFailure('sendText', 'execute', error),
              { accountId: envelope.accountId, initiator: 'system', background: true }, 'MESSAGE_SEND_FAILED');
            console.warn('[admin-pairing] welcome send failed');
          }
        }, { operation: 'line_ingest', identity: { accountId: envelope.accountId, background: true } })
          .catch(() => console.warn('[admin-pairing] welcome send failed'));
      }
      const enrolled = await friendEnrollment.handle(envelope, secretCandidate, ownMid, capturedBinding);
      return paired || enrolled;
    }, admins, workspace, roomAutomation, friendWhitelist,
    async (envelope, candidate, ownMid) => adminPairings.classify(envelope)
      || await friendEnrollment.classify(envelope, candidate, ownMid),
    (statuses) => {
      for (const projection of statuses) {
        if (isWritableChatType(projection.chatType)) {
          publishAgentJobStatus({ ...projection, chatType: projection.chatType, sourceType: 'line' });
          // Best effort and detached: a queued LINE job shows AMAZING once; this never blocks or fails ingest.
          try { agentService.noteQueued({ ...projection, chatType: projection.chatType }); } catch { /* display only */ }
        }
      }
    }, permissionCommands,
    (changes) => {
      if (closing) return;
      void track(async () => {
        for (const change of changes) {
          const conversation = await health.conversation(change.key);
          if (conversation) options.publish?.({ type: 'messageStored', key: change.key, messageId: change.messageId, conversation });
        }
      }, { operation: 'line_ingest', identity: { ...(changes[0] ? { accountId: changes[0].key.accountId } : {}), background: true } }).catch(() => undefined);
    }, options.locale ?? 'en', (diagnostic) => options.audit?.failure(diagnostic), freeMode, projectFolders,
    (input) => agentLineSend.sendSystemText(input),
    async (snapshot) => providerQuota.saveSnapshot({ provider: snapshot.provider, requestedAt: snapshot.requestedAt,
      fetchedAt: snapshot.fetchedAt, stale: snapshot.stale, snapshot }), providerQuotaService,
    (key, senderId, targetProvider) => providerQuota.pendingProposal({ ...key, senderId, targetProvider }),
    (provider) => providerQuota.get(provider));
  lineServiceReady = true;
  delivery = new DeliveryService(agents, {
    binding: (accountId) => options.workers.binding(accountId),
    waitModeAck: (accountId, mode, timeoutMs) => options.workers.waitModeAck(accountId, mode, timeoutMs),
    send: sendLineCommand,
  }, canWriteLine, (diagnostic, identity) => options.audit?.failure(diagnostic, identity));
  stopDelivery = onceCleanup(() => delivery.shutdown());
  startupCleanup.add(stopDelivery);
  // Queued jobs are reclaimed only after the MCP listener is bound (see below) so their capability can be minted.
  /** One bound for child boot/first ack and for draining in-flight sends: the gateway's own response bound. */
  const workerBoundMs = options.workers.responseTimeoutMs ?? DEFAULT_WORKER_RESPONSE_TIMEOUT_MS;
  /** Waits for the mode ack within the boot bound; records one System Errors failure on a real timeout. */
  const waitModeAckReportingTimeout = async (binding: Bound, mode: 'ACTIVE_CONTROL' | 'MONITOR_ONLY',
    signal: AbortSignal | undefined, operation: 'line_ingest' | 'delivery'): Promise<boolean> => {
    if (await options.workers.waitModeAck(binding.accountId, mode, workerBoundMs)) return !signal?.aborted;
    if (signal?.aborted || closing) return false;
    const current = await options.workers.binding(binding.accountId);
    if (signal?.aborted || closing || !current || current.workerInstanceId !== binding.workerInstanceId
      || current.controlEpoch !== binding.controlEpoch || current.mode !== mode) return false;
    options.audit?.failure(diagnosticFailure(operation, 'response', Object.assign(new Error('Worker mode acknowledgement timed out'), { name: 'TimeoutError' })),
      { accountId: binding.accountId, workerInstanceId: binding.workerInstanceId, initiator: 'system', background: true });
    return false;
  };
  const supervisedWorker = (binding: Bound) => ({
    send: async (command: LineWorkerCommand) => { await options.workers.send(command); },
    waitModeAck: (mode: Bound['mode'], timeoutMs: number) => mode === 'PAUSED' ? Promise.resolve(false)
      : options.workers.waitRawModeAck?.(binding.accountId, mode, timeoutMs) ?? options.workers.waitModeAck(binding.accountId, mode, timeoutMs),
    killAndWait: () => auditWorkerStop(binding, () => options.workers.stopBinding(binding)),
  });
  const supervisor = new AccountSupervisor(accounts, {
    spawn: async (accountId, workerInstanceId, controlEpoch, mode) => {
      const lineTransport = await transportOf(accountId);
      const block = await chromeLtsmBlock(lineTransport);
      if (block) throw new ChromeLtsmUnavailableError(block);
      const binding: Bound = { accountId, workerInstanceId, controlEpoch, mode, ...transportFields(lineTransport) };
      await options.workers.start(accountId, binding);
      try {
        if (!bindsOnStart) await lineService.bind(binding);
      } catch (error) {
        await auditWorkerStop(binding, () => options.workers.stopBinding(binding)).catch(() => undefined);
        lineService.unbind(binding.workerInstanceId);
        throw error;
      }
      return supervisedWorker(binding);
    },
  }, workerBoundMs, (phase, target) => health.setSwitchPhase(phase, target), (jobId) => options.agent.cancel(jobId),
    (projection) => agentService.publishCommittedStatus(projection), workerBoundMs);

  function schedulePendingDeliveryRecovery(accountId: string): void {
    if (closing) return;
    // Mode-change callbacks run inside the gateway's acknowledgement handler;
    // defer replay until it has published full mode/binding readiness.
    const timer = setTimeout(() => {
      recoveryTimers.delete(timer);
      if (!closing) void track(() => delivery.recoverPending(accountId),
        { operation: 'delivery', identity: { accountId, background: true } }).catch(() => undefined);
    }, 0);
    recoveryTimers.add(timer);
  }

  async function updateChatResourceReadiness(instance: string, event: Extract<LineWorkerEvent, { type: 'login' | 'status' }>): Promise<void> {
    const binding = await options.workers.binding(event.accountId);
    if (!binding || binding.workerInstanceId !== instance || binding.workerInstanceId !== event.workerInstanceId
      || binding.controlEpoch !== event.controlEpoch || !lineService.isCurrentWorkerEvent(instance, event)) return;
    if (event.type === 'login') chatResourceAdmission.authenticated(binding);
    else if (event.state === 'ready') chatResourceAdmission.ready(binding);
    if (lineService.isAuthenticatedReady(binding)) {
      void track(() => recoverPendingAfterReady(binding),
        { operation: 'delivery', identity: { accountId: binding.accountId, workerInstanceId: binding.workerInstanceId, background: true } })
        .catch(() => undefined);
    }
  }

  unsubscribeEvent = options.workers.onEvent((instance, event) => closing ? Promise.resolve() : track(async () => {
    if (event.type === 'downloadAuthInvalidated') {
      const binding = await options.workers.binding(event.accountId);
      if (binding?.purpose === 'DOWNLOAD_ONLY' && binding.workerInstanceId === instance
        && binding.controlEpoch === event.controlEpoch) {
        void ensureDownloadOnlyAuth(binding).catch(() => undefined);
      }
      return;
    }
    if (event.type === 'downloadAuthResult' || event.type === 'downloadReady') return;
    if (!lineService.isCurrentWorkerEvent(instance, event)) return;
    if (event.type === 'authInvalidated') {
      // Settle a pending user logout from this exact binding before teardown unbinds it.
      await lineService.handleWorkerEvent(instance, event);
      // Fence archived resource IO before lifecycle/database teardown can yield.
      chatResourceAdmission.close(event.accountId, 'LINE authentication was invalidated.');
      const binding: WorkerBinding = event;
      // Use the method of the worker that lost its login. During a method switch it differs from the stored marker.
      const invalidatedWorker = await options.workers.binding(event.accountId);
      const invalidatedTransport = invalidatedWorker?.workerInstanceId === instance
        ? resolveLineTransport(invalidatedWorker.lineTransport) : await transportOf(event.accountId);
      const loginAttemptId = loginAttempts.get(event.accountId) ?? null;
      await supervisor.runLifecycle(async () => {
        if (!await accounts.invalidateWorkerBinding(binding)) return;
        if (loginAttemptId && loginAttempts.get(event.accountId) === loginAttemptId) {
          loginAttempts.delete(event.accountId);
          await options.secretStore?.closeLogin(event.accountId, instance, loginAttemptId);
        }
        if (supervisor.isCurrent(binding)) supervisor.retireWithinLifecycle(binding);
        await auditWorkerStop(binding, () => options.workers.stopBinding(binding));
        lineService.unbind(instance);
        await auditSecretClear(event.accountId, 'system', loginAttemptId ? { loginAttemptId } : undefined, invalidatedTransport);
        if (loginAttemptId) options.publish?.({ type: 'lineLoginState', accountId: event.accountId, loginAttemptId,
          state: 'reauth_required', message: 'LINE credentials were rejected. Sign in again with QR.' });
        await publishSnapshot();
      });
      return;
    }
    if (event.type === 'error' && event.code === CHROME_LTSM_UNAVAILABLE_CODE) {
      // The worker could not load its ltsm assets. They were removed or changed after the preflight.
      // Do the same teardown as for an authentication failure, but keep the stored session.
      // The account needs the assets again, not a new login. The diagnostic has no path.
      recordWorkerDiagnostic(options, event);
      chatResourceAdmission.close(event.accountId, 'LINE Chrome assets became unavailable.');
      const binding: WorkerBinding = event;
      const loginAttemptId = loginAttempts.get(event.accountId) ?? null;
      await supervisor.runLifecycle(async () => {
        if (!await accounts.invalidateWorkerBinding(binding)) return;
        if (loginAttemptId && loginAttempts.get(event.accountId) === loginAttemptId) {
          loginAttempts.delete(event.accountId);
          await options.secretStore?.closeLogin(event.accountId, instance, loginAttemptId);
        }
        if (supervisor.isCurrent(binding)) supervisor.retireWithinLifecycle(binding);
        await auditWorkerStop(binding, () => options.workers.stopBinding(binding));
        lineService.unbind(instance);
        options.publish?.({ type: 'lineLoginState', accountId: event.accountId, loginAttemptId,
          state: 'reauth_required', message: 'LINE Chrome 安全模組檔案無法使用；請先在登入設定中偵測或重新選擇檔案。' });
        await publishSnapshot();
      });
      return;
    }
    if (event.type === 'loginFailure') {
      if (loginAttempts.get(event.accountId) !== event.loginAttemptId) return;
      options.audit?.failure({ operation: 'loginQr', stage: 'authenticate', reason: event.code,
        category: event.code === 'LOGIN_TIMEOUT' ? 'timeout' : event.code === 'LOGIN_ATTEMPT_REPLACED' ? 'cancelled' : 'authentication_required',
        recovery: event.code === 'LOGIN_ATTEMPT_REPLACED' ? 'none' : 'relogin',
        ...('detail' in event && event.detail !== undefined ? { detail: event.detail } : {}) },
        { accountId: event.accountId, workerInstanceId: event.workerInstanceId, loginAttemptId: event.loginAttemptId });
      loginAttempts.delete(event.accountId);
      // A failed QR login ends logged out. A token login (startup or resume) and a replaced or busy attempt keep the old state.
      const endsLoggedOut = (event.code === 'LOGIN_FAILED' || event.code === 'LOGIN_TIMEOUT')
        && lineService.loginAttemptKind(event.accountId, instance, event.loginAttemptId) === 'qr';
      await lineService.handleWorkerEvent(instance, event);
      if (!lineService.isCurrentWorkerEvent(instance, event)) return;
      if (endsLoggedOut) {
        await supervisor.runLifecycle(async () => {
          const running = await options.workers.binding(event.accountId) ?? supervisor.binding(event.accountId);
          // Another worker owns the account now: leave it alone.
          if (running && running.workerInstanceId !== instance) return;
          // The login saved no secret. The attempt is already closed, so no attempt id is passed.
          await releaseAccountSession(event.accountId, running, undefined, 'system');
          await accounts.setConnectionStatus(event.accountId, 'disconnected');
          options.publish?.({ type: 'lineLoginState', accountId: event.accountId, loginAttemptId: event.loginAttemptId,
            state: 'disconnected', message: event.message });
          options.publish?.({ type: 'controlChanged', control: (await publishSnapshot.read()).control });
        });
        await publishSnapshot();
        return;
      }
      options.publish?.({ type: 'lineLoginState', accountId: event.accountId, loginAttemptId: event.loginAttemptId,
        state: 'degraded', message: event.message });
      await publishSnapshot();
      return;
    }
    if ((event.type === 'qr' || event.type === 'pin' || event.type === 'login')
      && loginAttempts.get(event.accountId) !== event.loginAttemptId) return;
    if ((event.type === 'batch' || event.type === 'historyResult')
      && (await accounts.resolveCapabilities(event.accountId))?.connectionMode === 'EXTERNAL_MONITOR') return;
    const insertedMessageIds = await lineService.handleWorkerEvent(instance, event);
    if (event.type === 'login' && !lineService.isCurrentWorkerEvent(instance, event)) {
      const rejected = await options.workers.binding(event.accountId);
      if (rejected?.workerInstanceId === instance && rejected.controlEpoch === event.controlEpoch) {
        await supervisor.runLifecycle(async () => {
          if (supervisor.isCurrent(rejected)) supervisor.retireWithinLifecycle(rejected);
          loginAttempts.delete(event.accountId);
          await auditWorkerStop(rejected, () => options.workers.stopBinding(rejected));
          lineService.unbind(instance);
          // An Agent cannot be its own admin: say so when the login MID equals the Primary Admin slot's official identity.
          const rejectedAccount = await accounts.getAccount(event.accountId);
          const slotAccount = (await accounts.listAuthenticatedAccounts()).find((item) => item.productRole === 'PRIMARY_ADMIN');
          const sameAsAdmin = rejectedAccount?.productRole === 'AGENT' && !!slotAccount?.ownMid && slotAccount.ownMid === event.ownMid;
          const identityMismatch = rejectedAccount?.productRole === 'AGENT' && !!rejectedAccount.ownMid && rejectedAccount.ownMid !== event.ownMid;
          if (identityMismatch) {
            options.audit?.failure({ ...diagnosticFailure('loginQr', 'authenticate'), reason: 'AGENT_IDENTITY_MISMATCH',
              category: 'denied', recovery: 'relogin' }, { accountId: event.accountId, workerInstanceId: instance, loginAttemptId: event.loginAttemptId });
            await accounts.setConnectionStatus(event.accountId, 'disconnected');
            const snapshot = await publishSnapshot.read();
            const oldDisplayName = (snapshot.accounts.find((item) => item.accountId === event.accountId)?.displayName ?? 'Agent')
              .replace(/[\u0000-\u001f\u007f-\u009f]/g, '').slice(0, 256);
            const scannedDisplayName = event.displayName?.replace(/[\u0000-\u001f\u007f-\u009f]/g, '').trim().slice(0, 256) || null;
            options.publish?.({ type: 'lineLoginState', accountId: event.accountId, loginAttemptId: event.loginAttemptId,
              state: 'disconnected', message: 'A different LINE account was scanned; the Agent account was not changed.' });
            options.publish?.({ type: 'agentIdentityMismatch', accountId: event.accountId, loginAttemptId: event.loginAttemptId,
              oldDisplayName, scannedDisplayName });
          } else options.publish?.({ type: 'lineLoginState', accountId: event.accountId, loginAttemptId: event.loginAttemptId,
            state: 'degraded', message: sameAsAdmin
              ? '這個 LINE 帳號已被設為主要管理者，Agent 不能與主要管理者是同一個帳號，請改用另一個 LINE 帳號登入 Agent。'
              : 'LINE MID does not match the reserved account role or verified Primary Admin binding.' });
          await publishSnapshot();
        });
      }
      return;
    }
    if (!lineService.isCurrentWorkerEvent(instance, event)) return;
    if (event.type === 'qr') {
      if (event.code.length > 2048) throw new Error('QR payload exceeds the local rendering limit');
      const imageDataUrl = await toDataURL(event.code, { type: 'image/png', width: 320, margin: 2, errorCorrectionLevel: 'M' });
      if (!lineService.isCurrentWorkerEvent(instance, event)) return;
      if (imageDataUrl.length > 256_000 || !/^data:image\/png;base64,[A-Za-z0-9+/]+={0,2}$/.test(imageDataUrl)) {
        throw new Error('QR payload could not be encoded safely');
      }
      options.publish?.({ type: 'lineQr', accountId: event.accountId, loginAttemptId: event.loginAttemptId, imageDataUrl });
    }
    if (event.type === 'pin') options.publish?.({ type: 'linePin', accountId: event.accountId, loginAttemptId: event.loginAttemptId, pin: event.pin });
    if (event.type === 'login') {
      if (!lineService.isCurrentWorkerEvent(instance, event)) return;
      completedLoginAttempts.set(event.accountId, event.loginAttemptId);
      await updateChatResourceReadiness(instance, event);
      await noteOwnAvatarAccountConnected(event.accountId);
      options.publish?.({ type: 'lineLoginState', accountId: event.accountId, loginAttemptId: event.loginAttemptId, state: 'connected', message: null });
      await publishSnapshot();
    }
    if (event.type === 'status') {
      if (event.state === 'ready') {
        await updateChatResourceReadiness(instance, event);
        await noteOwnAvatarAccountConnected(event.accountId);
      }
      if (event.state === 'ready') await attachmentService.recover(event.accountId);
      options.publish?.({ type: 'lineLoginState', accountId: event.accountId,
        loginAttemptId: loginAttempts.get(event.accountId) ?? null,
        state: event.state === 'ready' ? 'connected' : event.state === 'degraded' || event.state === 'PROTOCOL_UNVERIFIED' ? 'degraded' : event.state === 'connecting' ? 'connecting' : 'disconnected', message: event.message });
      await publishSnapshot();
    }
    if (event.type === 'error') {
      recordWorkerDiagnostic(options, event);
      return;
    }
    if (event.type === 'sendResult' || event.type === 'unsendResult' || event.type === 'addFriendResult'
      || event.type === 'ownProfileResult') recordKnownServerResult(options, event);
    if (event.type === 'conversationCatalog') await publishSnapshot();
    if (event.type === 'catalogRefreshStatus') {
      recordWorkerDiagnostic(options, event);
      await publishSnapshot();
    }
    if (event.type === 'syncConfirmed') {
      await publishSnapshot().catch(() => undefined);
      return;
    }
    if (event.type === 'historyResult') {
      options.publish?.({ type: 'lineHistorySynced', requestId: event.requestId,
        accountId: event.accountId, chatType: event.chatType, chatId: event.chatId, nextCursor: event.nextCursor });
      for (const messageId of insertedMessageIds ?? []) {
        const key = { accountId: event.accountId, chatType: event.chatType, chatId: event.chatId } as const;
        const conversation = await health.conversation(key);
        if (conversation) options.publish?.({ type: 'messageStored', key, messageId, conversation });
      }
      await publishSnapshot();
    }
    if (event.type === 'batch') {
      const inserted = new Set(insertedMessageIds ?? []);
      const latestByConversation = new Map<string, typeof event.envelopes[number]>();
      for (const envelope of event.envelopes) if (inserted.has(envelope.messageId)) {
        latestByConversation.set(JSON.stringify([envelope.accountId, envelope.chatType, envelope.chatId]), envelope);
      }
      for (const envelope of latestByConversation.values()) {
        const key = { accountId: envelope.accountId, chatType: envelope.chatType, chatId: envelope.chatId } as const;
        const conversation = await health.conversation(key);
        if (conversation) options.publish?.({ type: 'messageStored', key, messageId: envelope.messageId, conversation });
      }
    }
  }, { operation: 'line_ingest', identity: { accountId: event.accountId, workerInstanceId: instance,
    ...('requestId' in event && typeof event.requestId === 'string' ? { requestId: event.requestId } : {}),
    ...('loginAttemptId' in event && typeof event.loginAttemptId === 'string' ? { loginAttemptId: event.loginAttemptId } : {}),
    background: true } }));
  if (unsubscribeEvent) startupCleanup.add(unsubscribeEvent);
  const bindsOnStart = options.workers.onBinding !== undefined;
  async function restoreTokenForBinding(binding: Bound, signal?: AbortSignal): Promise<void> {
    if (closing || signal?.aborted || !(await options.secretStore?.load(binding.accountId, binding.lineTransport))?.token) return;
    if (closing || signal?.aborted) return;
    const current = await options.workers.binding(binding.accountId);
    if (!current || current.workerInstanceId !== binding.workerInstanceId || current.controlEpoch !== binding.controlEpoch) return;
    const loginAttemptId = randomUUID();
    loginAttempts.set(binding.accountId, loginAttemptId);
    try { await lineService.requestTokenLogin(binding.accountId, binding.workerInstanceId, loginAttemptId); }
    catch (error) {
      if (loginAttempts.get(binding.accountId) === loginAttemptId) loginAttempts.delete(binding.accountId);
      throw error;
    }
  }
  unsubscribeBinding = options.workers.onBinding?.((binding, signal) => {
    chatResourceAdmission.close(binding.accountId, 'A new account worker binding was observed.');
    chatResourceAdmission.observeBinding(binding);
    return admitted(async () => {
      if (signal.aborted) throw new Error('Worker binding cancelled');
      if (binding.purpose === 'DOWNLOAD_ONLY') {
        await accounts.bindWorker(binding, signal);
        return;
      }
      await lineService.bind(binding, signal);
      if (signal.aborted) throw new Error('Worker binding cancelled');
    }, { operation: 'line_ingest', identity: { accountId: binding.accountId, workerInstanceId: binding.workerInstanceId, background: true } });
  });
  if (unsubscribeBinding) startupCleanup.add(unsubscribeBinding);
  unsubscribeRestartBinding = options.workers.onRestartBinding?.((binding, signal) => {
    chatResourceAdmission.close(binding.accountId, 'The account worker binding restarted.');
    chatResourceAdmission.observeBinding(binding);
    return admitted(async () => {
      // Automatic utility-process restarts receive a new instance ID. Adopt the
      // acknowledged replacement under the same durable epoch before allowing
      // facade sends to treat it as current. Keeping this separate from a normal
      // start avoids recursively queueing adoption inside switchTo's spawn.
      if (signal.aborted) return;
      await supervisor.runLifecycle(async () => {
        if (signal.aborted) return;
        const current = await options.workers.binding(binding.accountId);
        if (signal.aborted || !current || current.accountId !== binding.accountId
          || current.workerInstanceId !== binding.workerInstanceId || current.controlEpoch !== binding.controlEpoch) return;
        if (current.purpose === 'DOWNLOAD_ONLY') {
          await accounts.bindWorker(current, signal);
          await ensureDownloadOnlyAuth(current, signal);
          return;
        }
        if (binding.mode === 'ACTIVE_CONTROL'
          && !await supervisor.adoptWithinLifecycle(current, supervisedWorker(current), true)) return;
      }, signal);
      if (signal.aborted) return;
      if (binding.mode === 'ACTIVE_CONTROL') schedulePendingDeliveryRecovery(binding.accountId);
    }, { operation: 'line_ingest', identity: { accountId: binding.accountId, workerInstanceId: binding.workerInstanceId, background: true } });
  });
  if (unsubscribeRestartBinding) startupCleanup.add(unsubscribeRestartBinding);
  unsubscribeModeChange = options.workers.onModeChange?.((binding, signal) => {
    chatResourceAdmission.close(binding.accountId, 'The account mode changed.', true);
    return admitted(async () => {
      if (signal.aborted) return;
      if (binding.purpose === 'DOWNLOAD_ONLY') return;
      await lineService.bind(binding, signal);
      if (signal.aborted) return;
      const mode = binding.mode;
      if (mode !== 'PAUSED') void track(async () => {
        if (signal.aborted || !await waitModeAckReportingTimeout(binding, mode, signal, 'line_ingest')) return;
        const current = await options.workers.binding(binding.accountId);
        if (signal.aborted || !current || current.workerInstanceId !== binding.workerInstanceId
          || current.controlEpoch !== binding.controlEpoch || current.mode !== mode) return;
        chatResourceAdmission.ready(current);
        chatResourceAdmission.modeReady(current);
        if (mode === 'ACTIVE_CONTROL' && lineService.isAuthenticatedReady(current)) {
          void track(() => recoverPendingAfterReady(current, signal),
            { operation: 'delivery', identity: { accountId: current.accountId, workerInstanceId: current.workerInstanceId, background: true } })
            .catch(() => undefined);
        }
      }, { operation: 'line_ingest', identity: { accountId: binding.accountId, workerInstanceId: binding.workerInstanceId, background: true } })
        .catch(() => undefined);
      if (binding.mode === 'ACTIVE_CONTROL') schedulePendingDeliveryRecovery(binding.accountId);
    }, { operation: 'line_ingest', identity: { accountId: binding.accountId, workerInstanceId: binding.workerInstanceId, background: true } });
  });
  if (unsubscribeModeChange) startupCleanup.add(unsubscribeModeChange);

  async function recoverPendingAfterReady(binding: Bound, signal?: AbortSignal): Promise<void> {
    if (signal?.aborted || closing || binding.mode !== 'ACTIVE_CONTROL'
      || !lineService.isAuthenticatedReady(binding) || !options.workers.isCurrentActiveControlBinding(binding)) return;
    if (!await waitModeAckReportingTimeout(binding, 'ACTIVE_CONTROL', signal, 'delivery')) return;
    if (signal?.aborted) return;
    const current = await options.workers.binding(binding.accountId);
    if (!current || current.mode !== 'ACTIVE_CONTROL' || current.accountId !== binding.accountId
      || current.workerInstanceId !== binding.workerInstanceId || current.controlEpoch !== binding.controlEpoch
      || !lineService.isAuthenticatedReady(current) || !options.workers.isCurrentActiveControlBinding(current)) return;
    await delivery.recoverPending(binding.accountId);
    for(const failure of await providerQuota.recoverableFailures(binding.accountId)) {
      if(failure.event.type==='failed'&&failure.event.code==='PROVIDER_LIMIT') {
        await handleProviderQuotaFailure(failure.jobId,failure.event as unknown as Extract<AgentEvent,{type:'failed'}>,failure.observedAt).catch(()=>undefined);
      }
    }
    if ((await accounts.getAccount(binding.accountId))?.productRole !== 'AGENT') return;
    if (signal?.aborted || closing || !lineService.isAuthenticatedReady(current)
      || !options.workers.isCurrentActiveControlBinding(current)) return;
    const archiveBinding = asChatResourceBinding(current);
    if (archiveBinding) albumDispatcher.recover(binding.accountId, archiveBinding);
  }

  async function startStoredAccount(account: Awaited<ReturnType<AccountRepository['getAccount']>> & {}): Promise<Bound> {
    await stopExternalImportForAccount(account.accountId);
    if (!account.productRole) throw new Error('LINE account role is unclassified; worker start is blocked');
    const lineTransport = await transportOf(account.accountId);
    const ltsmBlock = await chromeLtsmBlock(lineTransport);
    if (ltsmBlock) throw new StartupStageError('admission', false, new ChromeLtsmUnavailableError(ltsmBlock));
    let control: Awaited<ReturnType<AccountRepository['getControlState']>>;
    let mode: Bound['mode'] = account.mode === 'ACTIVE_CONTROL' ? 'ACTIVE_CONTROL' : 'MONITOR_ONLY';
    try {
      control = await accounts.getControlState();
      if (account.productRole === 'PRIMARY_ADMIN' && control.activeAccountId === account.accountId) {
        throw new StartupStageError('admission', false, new Error('Primary Admin account cannot own Agent control'));
      }
      if (account.productRole === 'AGENT' && control.activeAccountId && control.activeAccountId !== account.accountId) {
        throw new StartupStageError('admission', false, new Error('Agent control is owned by a different account; refusing automatic transfer'));
      }
      if (account.productRole === 'AGENT' && !control.activeAccountId) {
        const activation = await accounts.activateControl(account.accountId, control.controlEpoch);
        control = await accounts.getControlState();
        if (!activation.activated && control.activeAccountId !== account.accountId) {
          throw new StartupStageError('admission', false, new Error('Agent could not obtain vacant control'));
        }
        mode = 'ACTIVE_CONTROL';
      }
    } catch (error) { throw error instanceof StartupStageError ? error : new StartupStageError('admission', true, error); }
    const binding: Bound = { accountId: account.accountId, workerInstanceId: randomUUID(), controlEpoch: control.controlEpoch,
      mode, ...transportFields(lineTransport) };
    try {
      await options.workers.start(account.accountId, binding);
      if (!bindsOnStart) await lineService.bind(binding);
    } catch (error) { throw new StartupStageError('spawn', true, error); }
    try { await restoreTokenForBinding(binding); }
    catch (error) {
      await auditWorkerStop(binding, () => options.workers.stopBinding(binding)).catch(() => undefined);
      lineService.unbind(binding.workerInstanceId);
      throw new StartupStageError('dispatch', !(error instanceof Error && error.message === 'No saved LINE token for this account'), error);
    }
    if (binding.mode === 'ACTIVE_CONTROL') {
      let adopted = false;
      try { adopted = await supervisor.adoptWithinLifecycle(binding, supervisedWorker(binding)); }
      catch (error) { throw new StartupStageError('response', true, error); }
      if (!adopted) {
        await auditWorkerStop(binding, () => options.workers.stopBinding(binding));
        throw new StartupStageError('response', false, new Error('無法恢復主操作帳號控制權。'));
      }
    }
    return binding;
  }

  async function attemptStartupAutoLogin(account: Parameters<typeof startStoredAccount>[0]): Promise<{ retryable: boolean } | undefined> {
    const correlationId = options.audit?.request('worker_start', { initiator: 'system', accountId: account.accountId, reasonCode: 'startup' });
    try {
      await supervisor.runLifecycle(async () => {
        await accounts.setConnectionStatus(account.accountId, 'disconnected');
        const binding = await startStoredAccount(account);
        if (correlationId) options.audit?.complete(correlationId, 'succeeded', { workerInstanceId: binding.workerInstanceId });
      });
      return undefined;
    } catch (error) {
      const stage = error instanceof StartupStageError ? error.stage : 'unknown';
      const errorCode: AuditErrorCode = stage === 'dispatch' ? 'CREDENTIAL_RESTORE_FAILED' : 'WORKER_OPERATION_FAILED';
      // CHROMEOS without usable ltsm assets. The operator can fix this configuration problem. It is not a temporary fault.
      const ltsmUnavailable = error instanceof StartupStageError && error.code === CHROME_LTSM_UNAVAILABLE_CODE;
      try {
        if (correlationId) {
          options.audit?.complete(correlationId, 'failed', { errorCode, diagnostic: ltsmUnavailable
            ? { ...diagnosticFailure('startup', stage, error), category: 'unavailable', recovery: 'check_configuration' }
            : diagnosticFailure('startup', stage, error) });
        }
      } catch { /* Diagnostics cannot change the degraded outcome. */ }
      await options.workers.stop(account.accountId).catch((stopError: unknown) => {
        options.audit?.failure(diagnosticFailure('startup', 'cleanup', stopError), { accountId: account.accountId, initiator: 'system' }, 'WORKER_STOP_FAILED');
      });
      await accounts.setConnectionStatus(account.accountId, ltsmUnavailable ? 'reauth_required' : 'degraded').catch((statusError: unknown) => {
        options.audit?.failure(diagnosticFailure('database', 'persist', statusError), { accountId: account.accountId, initiator: 'system' }, 'DATABASE_WRITE_FAILED');
      });
      return { retryable: !(error instanceof StartupStageError) || error.retryable };
    }
  }

  /** One non-blocking retry; the timer is tracked in recoveryTimers so shutdown cancels it. A failed retry stays degraded. */
  function scheduleStartupAutoLoginRetry(account: Parameters<typeof startStoredAccount>[0]): void {
    if (closing) return;
    const timer = setTimeout(() => {
      recoveryTimers.delete(timer);
      if (closing) return;
      void track(async () => {
        // No retry once the token is gone (authentication invalidated) or the account was paused/removed.
        const current = await accounts.getAccount(account.accountId);
        const saved = await options.secretStore?.load(account.accountId, await transportOf(account.accountId));
        if (closing || !saved?.token || !current || current.mode === 'PAUSED') return;
        await attemptStartupAutoLogin(current);
      }, { operation: 'startup', identity: { accountId: account.accountId, background: true } }).catch(() => undefined);
    }, STARTUP_AUTOLOGIN_RETRY_DELAY_MS);
    recoveryTimers.add(timer);
  }

  async function reloginAccountWithQr(accountId: string, requestId: string, requestedTransport?: LineTransportKind): Promise<IpcResult> {
    return supervisor.runLifecycle(async () => {
      await stopExternalImportForAccount(accountId);
      const account = await accounts.getAccount(accountId);
      if (!account) return failure(requestId, 'ACCOUNT_NOT_FOUND', 'LINE account not found.');
      if (!account.productRole) return failure(requestId, 'ACCOUNT_ROLE_UNCLASSIFIED', 'This account has no verified Agent or Primary Admin role.');
      if (account.mode === 'PAUSED') return failure(requestId, 'ACCOUNT_PAUSED', 'This LINE account is paused.');
      // No requested method means the current method of the account. A different method is only stored after the QR login succeeds.
      const lineTransport = resolveLineTransport(requestedTransport ?? await transportOf(accountId));
      const ltsmBlock = await chromeLtsmBlock(lineTransport);
      if (ltsmBlock) return chromeLtsmUnavailable(requestId, ltsmBlock);
      let control = await accounts.getControlState();
      if (account.productRole === 'PRIMARY_ADMIN' && control.activeAccountId === accountId) {
        return failure(requestId, 'ADMIN_CONTROL_FORBIDDEN', 'Primary Admin accounts cannot own Agent control.');
      }
      if (account.productRole === 'AGENT' && control.activeAccountId && control.activeAccountId !== accountId) {
        return failure(requestId, 'AGENT_CONTROL_CONFLICT', 'Another account owns control; Agent relogin is blocked.');
      }
      let accountMode = account.mode;
      if (account.productRole === 'AGENT' && !control.activeAccountId) {
        const activation = await accounts.activateControl(accountId, control.controlEpoch);
        control = await accounts.getControlState();
        if (!activation.activated && control.activeAccountId !== accountId) {
          return failure(requestId, 'AGENT_CONTROL_CONFLICT', 'Agent could not obtain vacant control.');
        }
        accountMode = 'ACTIVE_CONTROL';
      }
      if (account.mode === 'ACTIVE_CONTROL' && control.activeAccountId !== accountId) {
        return failure(requestId, 'ACCOUNT_NOT_ACTIVE', 'Account control state changed; refresh and retry.');
      }
      const previous = await options.workers.binding(accountId) ?? supervisor.binding(accountId);
      if (previous) {
        await auditWorkerStop(previous, () => options.workers.stopBinding(previous));
        lineService.unbind(previous.workerInstanceId);
        if (previous.mode === 'ACTIVE_CONTROL' && supervisor.isCurrent(previous)
          && !supervisor.retireWithinLifecycle(previous)) throw new Error('Stopped LINE worker no longer owns active control');
      }
      await accounts.setConnectionStatus(accountId, 'disconnected');
      const binding: Bound = { accountId, workerInstanceId: randomUUID(), controlEpoch: control.controlEpoch, mode: accountMode,
        ...transportFields(lineTransport) };
      try {
        await options.workers.start(accountId, binding);
        if (binding.mode === 'ACTIVE_CONTROL' && !await supervisor.adoptWithinLifecycle(binding, supervisedWorker(binding))) {
          throw new Error('Fresh LINE worker could not adopt active control');
        }
      } catch (error) {
        await auditWorkerStop(binding, () => options.workers.stopBinding(binding)).catch(() => undefined);
        lineService.unbind(binding.workerInstanceId);
        await accounts.setConnectionStatus(accountId, 'degraded');
        throw error;
      }
      if (!bindsOnStart) await lineService.bind(binding);
      const loginAttemptId = randomUUID();
      loginAttempts.set(accountId, loginAttemptId);
      options.publish?.({ type: 'lineLoginState', accountId, loginAttemptId, state: 'connecting', message: null });
      try { await lineService.requestQrLogin(accountId, binding.workerInstanceId, loginAttemptId); }
      catch (error) {
        if (loginAttempts.get(accountId) === loginAttemptId) loginAttempts.delete(accountId);
        await options.secretStore?.closeLogin(accountId, binding.workerInstanceId, loginAttemptId).catch(() => undefined);
        options.audit?.failure(diagnosticFailure('loginQr', 'dispatch', error), { accountId, loginAttemptId });
        options.publish?.({ type: 'lineLoginState', accountId, loginAttemptId, state: 'degraded',
          message: 'LINE QR login failed to start.' });
        throw error;
      }
      return accepted(requestId);
    });
  }

  async function replaceAgentAccountWithQr(accountId: string, requestId: string, requestedTransport?: LineTransportKind): Promise<IpcResult> {
    return supervisor.runLifecycle(async () => {
      let createdAccountId: string | null = null;
      try {
        chatResourceAdmission.close(accountId, 'Agent account replacement was requested.');
        await stopExternalImportForAccount(accountId);
        const old = await accounts.getAccount(accountId);
        if (!old || old.productRole !== 'AGENT' || !old.ownMid) return failure(requestId, 'AGENT_REPLACEMENT_STALE', 'Agent 帳號已變更，請重新整理後再試。');
        if (loginAttempts.has(accountId)) return failure(requestId, 'AGENT_LOGIN_IN_PROGRESS', '請先取消目前的 LINE 登入，再更換 Agent 帳號。', true);
        // Fail fast. Do this before Main stops or replaces anything.
        const ltsmBlock = await chromeLtsmBlock(requestedTransport);
        if (ltsmBlock) return chromeLtsmUnavailable(requestId, ltsmBlock);
        await stopAndClearWorkerBinding(accountId, 'user');
        let control = await accounts.getControlState();
        if (control.activeAccountId && control.activeAccountId !== accountId) {
          options.audit?.failure({ ...diagnosticFailure('revokeControl', 'admission'), category: 'denied', recovery: 'none' }, { accountId, requestId });
          return failure(requestId, 'AGENT_CONTROL_CONFLICT', '另一個帳號仍持有控制權，Agent 帳號尚未更換。');
        }
        if (control.activeAccountId === accountId) {
          const revoked = await supervisor.revokeControlAndCancel(control.controlEpoch);
          if (!revoked.revoked) return failure(requestId, 'AGENT_CONTROL_CONFLICT', 'Agent 控制狀態已變更，請重新整理後再試。');
          control = await accounts.getControlState();
        }
        await auditSecretClear(accountId, 'user', { requestId });
        await accounts.setConnectionStatus(accountId, 'disconnected');
        const reserved = await accounts.replaceAgentAccount(accountId, control.controlEpoch);
        if (!reserved.ok) {
          const message = reserved.code === 'AGENT_WORKER_ACTIVE' ? 'Agent LINE 工作程序尚未停止，帳號未更換。'
            : reserved.code === 'AGENT_CONTROL_ACTIVE' ? 'Agent 控制權尚未停止，帳號未更換。' : 'Agent 帳號已變更，請重新整理後再試。';
          options.audit?.failure({ ...diagnosticFailure('database', 'persist'), category: 'denied', recovery: 'retry' }, { accountId, requestId });
          return failure(requestId, reserved.code, message, true);
        }
        createdAccountId = reserved.account.accountId;
        // The new account has no marker yet. Store the chosen transport before the worker starts.
        await options.secretStore?.setTransport(createdAccountId, requestedTransport ?? 'DESKTOPWIN');
        const binding = await startStoredAccount(reserved.account);
        const loginAttemptId = randomUUID();
        loginAttempts.set(binding.accountId, loginAttemptId);
        options.publish?.({ type: 'lineLoginState', accountId: binding.accountId, loginAttemptId, state: 'connecting', message: null });
        await lineService.requestQrLogin(binding.accountId, binding.workerInstanceId, loginAttemptId);
        await publishSnapshot();
        return accepted(requestId);
      } catch (error) {
        options.audit?.failure({ ...(createdAccountId ? diagnosticFailure('loginQr', 'dispatch', error)
          : diagnosticFailure('revokeControl', 'execute', error)), ipcAction: 'lineReplaceAgentQr' }, { accountId, requestId });
        if (!createdAccountId) return failure(requestId, 'AGENT_REPLACEMENT_FAILED', 'Agent 帳號未更換；舊帳號的聊天與附件仍保留。請確認狀態後重試。', true);
        if (createdAccountId) {
          const newId = createdAccountId;
          const attemptId = loginAttempts.get(newId);
          if (attemptId) loginAttempts.delete(newId);
          const binding = await options.workers.binding(newId).catch(() => null);
          if (binding) {
            if (attemptId) await options.secretStore?.closeLogin(newId, binding.workerInstanceId, attemptId).catch(() => undefined);
            await auditWorkerStop(binding, () => options.workers.stopBinding(binding)).catch(() => undefined);
            lineService.unbind(binding.workerInstanceId);
            if (supervisor.isCurrent(binding)) supervisor.retireWithinLifecycle(binding);
          }
          const control = await accounts.getControlState().catch(() => null);
          if (control?.activeAccountId === newId) await supervisor.revokeControlAndCancel(control.controlEpoch).catch(() => undefined);
          await accounts.setConnectionStatus(newId, 'disconnected').catch(() => undefined);
        }
        return failure(requestId, 'AGENT_REPLACEMENT_QR_START_FAILED', '新 Agent 帳號已保留，但 QR 登入未能啟動；請重試登入。', true);
      }
    });
  }

  async function runDirectMonitor(input: {
    accountId: string; ownMid: string; sourceId: string; generation: number; modeRevision: number;
    sourceIdentityDigest: string; checkpoint: Record<string, unknown>; signal: AbortSignal;
    setProgress(progress: ExternalImportProgress): void;
  }): Promise<void> {
    const importer = options.officialSnapshotImporter?.readOfficialMonitor;
    let readerReady = false;
    let diagnosticPhase: ExternalMonitorFailurePhase = 'facade_checkpoint_fence';
    let readinessDiagnosticClear: Promise<void> | undefined;
    const repository = async <T>(operation: () => Promise<T>): Promise<T> => {
      try { return await operation(); } catch (error) {
        const failure = externalMonitorDatabaseFailure(error, readerReady ? 'runtime' : 'startup');
        throw new ExternalMonitorDiagnosticFailure(failure.code, failure.stage, failure.detail, diagnosticPhase);
      }
    };
    if (!importer) throw new ExternalMonitorDiagnosticFailure('external_monitor_reader_startup_failed', 'startup');
    const committer: Pick<ExternalMonitorRepository, 'commitDirectPoll'> = externalMonitor;
    let checkpoint = input.checkpoint;
    const initialState = await repository(() => externalMonitor.getInitialImportState({ accountId: input.accountId, sourceId: input.sourceId,
      generation: input.generation, signal: input.signal }));
    if (!initialState?.initialImportComplete || initialState.sourceIdentityDigest !== input.sourceIdentityDigest) {
      throw new ExternalMonitorDiagnosticFailure('external_monitor_checkpoint_changed', 'startup', undefined, 'facade_checkpoint_fence');
    }
    input.setProgress({ stage: 'monitoring', copiedBytes: null, totalBytes: null,
      committedRows: initialState.committedCount, eligibleRows: initialState.eligibleCount, message: null });
    if (!pendingMonitorRefresh || pendingMonitorRefresh.accountId !== input.accountId
      || pendingMonitorRefresh.sourceId !== input.sourceId || pendingMonitorRefresh.generation !== input.generation) {
      pendingMonitorRefresh = { accountId: input.accountId, sourceId: input.sourceId, generation: input.generation, pending: false };
    }
    try {
    try { await importer({
      expectedMid: input.ownMid, sourceIdentityDigest: input.sourceIdentityDigest,
      cursor: importCursor(checkpoint) as ImportCursor | null, signal: input.signal,
      onPhase: (phase) => { diagnosticPhase = phase; },
      onReady: (access) => {
        if (input.signal.aborted) return;
        readerReady = true;
        readinessDiagnosticClear = clearExternalMonitorDiagnostic(options.externalMonitorDiagnosticPath);
        const current = { sourceId: input.sourceId, generation: input.generation, access, signal: input.signal };
        nativeMonitorAccess.set(input.accountId, current);
        // The session owns the access object for the full monitor lifetime.
        // Keep auth acquisition in its coalesced owner instead of making the
        // reader's ready callback wait on an auxiliary request it must pump.
        if (downloadTokenLookupEnabled) void ensureDownloadOnlyAuth(null, input.signal, input.accountId, input.ownMid).catch(() => undefined);
      },
      onProgress: () => {
        input.setProgress({ stage: 'monitoring', copiedBytes: null, totalBytes: null,
          committedRows: initialState.committedCount, eligibleRows: initialState.eligibleCount, message: null });
      },
      onDirectoryPage: async (page, callbackSignal) => {
        diagnosticPhase = 'directory_callback_ack';
        const signal = callbackSignal ?? input.signal;
        if (signal.aborted) throw new Error('Direct LINE monitoring cancelled.');
        const stored = await repository(() => externalMonitor.storeNativeDirectoryPage({ accountId: input.accountId, sourceId: input.sourceId,
          generation: input.generation, expectedModeRevision: input.modeRevision, rows: page.rows, signal }));
        // A changed name must reach the open window even when no message arrives.
        if (stored.contactsChanged > 0 || stored.conversationsChanged > 0) pendingMonitorRefresh!.pending = true;
      },
      onPage: async (page, callbackSignal) => {
        diagnosticPhase = 'first_poll_callback_ack';
        const signal = callbackSignal ?? input.signal;
        if (signal.aborted) throw new Error('Direct LINE monitoring cancelled.');
        if (page.rows.length > 100 || page.tailRows.length > 50 || (page.rows.length > 0 && !page.lastCursor)) {
          throw new Error('Direct LINE source page is malformed.');
        }
        const fence = await repository(() => externalMonitor.readBatchFence({ accountId: input.accountId, sourceId: input.sourceId,
          generation: input.generation, signal }));
        if (fence.expectedModeRevision !== input.modeRevision || !sameJsonValue(fence.expectedCheckpoint, checkpoint)) {
          throw new Error('Direct LINE source checkpoint or authority changed.');
        }
        if (signal.aborted) throw new Error('Direct LINE monitoring cancelled.');
        const nextCursor = page.rows.length ? page.lastCursor! : importCursor(checkpoint);
        const poll: ExternalDirectPollInput = { accountId: input.accountId, sourceId: input.sourceId,
          generation: input.generation, expectedModeRevision: input.modeRevision,
          expectedCheckpoint: fence.expectedCheckpoint, batchId: `direct-${randomUUID()}`,
          cursor: nextCursor ?? {}, forwardObservations: page.rows.map(toExternalObservation),
          tailObservations: page.tailRows.map(toExternalObservation),
          ...(page.tailWindow === undefined ? {} : { tailWindow: { upper: page.tailWindow.upper, lower: page.tailWindow.lower,
            ids: [...page.tailWindow.ids] } }),
          ...(page.unreadCounts === undefined ? {} : { unreadCounts: { entries: page.unreadCounts.entries.map(([id, n]): [string, number] => [id, n]) } }),
          signal };
        const committed: ExternalDirectPollResult = await repository(() => committer.commitDirectPoll(poll));
        // The repository commits this cursor atomically with the page. Advance
        // the local predecessor only after that transaction resolves.
        checkpoint = poll.cursor;
        if (!committed.replayed && committed.changedMessages.length > 0) pendingMonitorRefresh!.pending = true;
        if (!committed.replayed && committed.unreadChanged > 0) pendingMonitorRefresh!.pending = true;
        if (!page.hasMore && pendingMonitorRefresh!.pending) {
          options.publish?.({ type: 'externalMonitorRoundComplete', accountId: input.accountId });
          pendingMonitorRefresh!.pending = false;
        }
        return importCursor(checkpoint);
      },
    }); } catch (error) {
      await readinessDiagnosticClear;
      const stage = readerReady ? 'runtime' : 'startup';
      const phase = error instanceof ExternalMonitorDiagnosticFailure && error.phase ? error.phase : diagnosticPhase;
      throw new ExternalMonitorDiagnosticFailure(classifyExternalMonitorFailure(error, stage), stage, externalMonitorFailureDetail(error), phase);
    }
    } finally {
      await downloadAuthFlights.get(input.accountId)?.catch(() => false);
      const currentAccess = nativeMonitorAccess.get(input.accountId);
      if (currentAccess?.sourceId === input.sourceId && currentAccess.generation === input.generation) nativeMonitorAccess.delete(input.accountId);
      const currentWorker = await options.workers.binding(input.accountId).catch(() => null);
      if (currentWorker?.purpose === 'DOWNLOAD_ONLY' && currentWorker.expectedMid === input.ownMid) {
        await options.workers.stopBinding(currentWorker).catch(() => undefined);
      }
    }
  }

  async function beginExternalImport(requestId: string, accountId: string): Promise<IpcResult> {
    if (closing) return failure(requestId, 'SERVICE_CLOSING', 'Service is closing.');
    if (!options.officialSnapshotImporter) return failure(requestId, 'EXTERNAL_IMPORT_UNAVAILABLE', 'LINE history import is not available in this build.');
    return supervisor.runLifecycle(async () => {
      if (externalImportOwner) return failure(requestId, 'EXTERNAL_IMPORT_BUSY', 'An official LINE import is already running.', true);
      const account = await accounts.getAccount(accountId);
      const stored = await options.pool.query<{ status: string }>('SELECT status FROM line_accounts WHERE account_id=$1', [accountId]);
      const agent = (await accounts.listAuthenticatedAccounts()).find((item) => item.productRole === 'AGENT');
      const control = await accounts.getControlState();
      if (!account || account.productRole !== 'PRIMARY_ADMIN' || !account.ownMid || account.mode === 'ACTIVE_CONTROL'
        || stored.rows[0]?.status !== 'disconnected' || control.activeAccountId === accountId
        || !await externalAdminAuthorized(agent, account.ownMid)
        || loginAttempts.has(accountId) || await options.workers.binding(accountId)) {
        return failure(requestId, 'EXTERNAL_IMPORT_NOT_ALLOWED', 'External history import requires a verified, logged-out Primary Admin account.', false);
      }
      const capability = await accounts.resolveCapabilities(accountId);
      let previousState: Awaited<ReturnType<ExternalMonitorRepository['getInitialImportState']>> = null;
      let expectedSource: { sourceId: string; generation: number } | null = null;
      if (capability?.selectedSourceType === 'EXTERNAL_MONITOR' && capability.selectedSourceId
        && capability.selectedSourceGeneration !== null) {
        expectedSource = { sourceId: capability.selectedSourceId, generation: capability.selectedSourceGeneration };
        previousState = await externalMonitor.getInitialImportState({ accountId, ...expectedSource });
      }
      if (closing) return failure(requestId, 'SERVICE_CLOSING', 'Service is closing.');
      const abort = new AbortController();
      externalImportOwner = { accountId, abort };
      const progressLog = !previousState?.initialImportComplete && options.externalImportProgressPath
        ? createFirstImportProgressLog(options.externalImportProgressPath, {
          onError: (error) => options.audit?.failure(diagnosticFailure('external_monitor', 'write', error)),
        }) : null;
      let progressLogReady = false;
      let latestCompletedPage: number | null = null;
      let lastSnapshotCopyProgress: { copiedBytes: string | null; totalBytes: string | null } | null = null;
      const setProgress = (progress: ExternalImportProgress) => {
        externalImportProgress.set(accountId, progress);
        if (progressLogReady) progressLog?.record({ stage: progress.stage, completedPage: latestCompletedPage,
          committedRows: progress.committedRows, updatedAt: new Date().toISOString() });
        void publishSnapshot().catch(() => undefined);
      };
      setProgress({ stage: 'checking_source', copiedBytes: null, totalBytes: null, committedRows: previousState?.committedCount ?? '0',
        eligibleRows: previousState?.eligibleCount ?? null, message: null });
      const task = track(async () => {
        try {
          let bound: { sourceId: string; generation: number; modeRevision: number } | null = null;
          let checkpoint: Record<string, unknown> | null = previousState?.cursor ?? null;
          let state = previousState;
          let startingCommittedCount = previousState?.committedCount ?? '0';
          let readyCursor: { createdTime: string; id: string } | null = null;
          let activeSnapshotDigest: string | null = null;
          let activeSourceIdentityDigest: string | null = null;
          if (previousState?.initialImportComplete && expectedSource) {
            let fence: Awaited<ReturnType<ExternalMonitorRepository['readBatchFence']>>;
            try {
              fence = await externalMonitor.readBatchFence({ accountId, sourceId: expectedSource.sourceId,
                generation: expectedSource.generation, signal: abort.signal });
            } catch (error) {
              throw externalMonitorDatabaseFailure(error, 'startup');
            }
            await runDirectMonitor({ accountId, ownMid: account.ownMid!, sourceId: expectedSource.sourceId,
              generation: expectedSource.generation, modeRevision: fence.expectedModeRevision,
              sourceIdentityDigest: previousState.sourceIdentityDigest, checkpoint: fence.expectedCheckpoint ?? {},
              signal: abort.signal, setProgress });
            return;
          }
          const completion = await options.officialSnapshotImporter!.readOfficialSnapshot({
            expectedMid: account.ownMid!, signal: abort.signal,
            onProgress(progress) {
              progressLogReady = true;
              if (progress.phase === 'snapshot_copy') {
                lastSnapshotCopyProgress = { copiedBytes: progress.bytesCopied, totalBytes: progress.totalBytes };
              }
              const byteProgress = ['snapshot_hash', 'snapshot_reread'].includes(progress.phase)
                ? lastSnapshotCopyProgress ?? { copiedBytes: null, totalBytes: null }
                : { copiedBytes: progress.bytesCopied, totalBytes: progress.totalBytes };
              const stage = ['snapshot_copy', 'snapshot_hash', 'snapshot_reread'].includes(progress.phase) ? 'copying_snapshot'
                : progress.phase === 'close_line_window' ? 'closing_line_window'
                : progress.phase === 'count' ? 'counting_rows'
                  : progress.phase === 'page_read' ? 'importing_history' : 'checking_source';
              setProgress({ stage, ...byteProgress,
                committedRows: externalImportProgress.get(accountId)?.committedRows ?? state?.committedCount ?? '0',
                eligibleRows: progress.eligibleCount ?? state?.eligibleCount ?? null, message: null });
            },
            async onReady(metadata) {
              progressLogReady = true;
              if (abort.signal.aborted) throw new Error('External import cancelled.');
              activeSnapshotDigest = metadata.snapshotDigest;
              activeSourceIdentityDigest = metadata.sourceIdentityDigest;
              bound = await externalMonitor.bindVerifiedExternalSource({ accountId, ownMid: account.ownMid!,
                sourceIdentityDigest: metadata.sourceIdentityDigest, initialImport: { snapshotDigest: metadata.snapshotDigest,
                  schemaVersion: metadata.schemaVersion, highWater: metadata.highWatermark, eligibleCount: metadata.eligibleCount }, signal: abort.signal });
              state = await externalMonitor.getInitialImportState({ accountId, sourceId: bound.sourceId, generation: bound.generation, signal: abort.signal });
              if (!state || state.sourceIdentityDigest !== metadata.sourceIdentityDigest) throw new Error('Imported LINE source checkpoint could not be verified.');
              if (expectedSource && (expectedSource.sourceId !== bound.sourceId || expectedSource.generation !== bound.generation)) {
                throw new Error('LINE source identity changed. Start the import again to use its new checkpoint.');
              }
              if (state.initialImportComplete) throw new Error('Initial history import is already complete.');
              let restartFromBeginning = false;
              if (state.snapshotDigest !== metadata.snapshotDigest || state.schemaVersion !== metadata.schemaVersion
                || !sameJsonValue(state.highWater, metadata.highWatermark)
                || state.eligibleCount !== metadata.eligibleCount) {
                await externalMonitor.resetUnfinishedInitialImport({ accountId, sourceId: bound.sourceId, generation: bound.generation,
                  expectedModeRevision: bound.modeRevision, expectedCheckpoint: state.cursor, sourceIdentityDigest: metadata.sourceIdentityDigest,
                  snapshotDigest: metadata.snapshotDigest, schemaVersion: metadata.schemaVersion, highWater: metadata.highWatermark,
                  eligibleCount: metadata.eligibleCount, signal: abort.signal });
                checkpoint = {};
                restartFromBeginning = true;
                state = await externalMonitor.getInitialImportState({ accountId, sourceId: bound.sourceId, generation: bound.generation, signal: abort.signal });
                if (state?.committedCount !== '0') throw new Error('The saved snapshot changed; its unfinished rows were cleared. Start again to import the new snapshot.');
              } else checkpoint = state.cursor;
              const fence = await externalMonitor.readBatchFence({ accountId, sourceId: bound.sourceId, generation: bound.generation, signal: abort.signal });
              checkpoint = fence.expectedCheckpoint;
              if (fence.expectedModeRevision !== bound.modeRevision) throw new Error('External import account authority changed.');
              if (!sameJsonValue(checkpoint, state.cursor)) throw new Error('External import checkpoint changed before reading.');
              startingCommittedCount = state.committedCount;
              readyCursor = restartFromBeginning ? null : importCursor(checkpoint ?? {});
              if (abort.signal.aborted) throw new Error('External import cancelled.');
              setProgress({ stage: 'importing_history', copiedBytes: externalImportProgress.get(accountId)?.copiedBytes ?? null,
                totalBytes: externalImportProgress.get(accountId)?.totalBytes ?? null, committedRows: state.committedCount,
                eligibleRows: state.eligibleCount, message: null });
              return readyCursor;
            },
            async onCatalogPage(page, callbackSignal) {
              progressLogReady = true;
              if (abort.signal.aborted || callbackSignal?.aborted) throw new Error('External import cancelled.');
              if (!bound || !state || !checkpoint || !activeSnapshotDigest || !Number.isSafeInteger(page.pageNumber) || page.pageNumber < 1 ||
                !/^[0-9a-f]{64}$/.test(page.batchDigest) || page.rows.length > 1000 || (page.rows.length === 0 && page.hasMore)) {
                throw new Error('External import catalog page is malformed or arrived before source verification.');
              }
              const fence = await externalMonitor.readBatchFence({ accountId, sourceId: bound.sourceId,
                generation: bound.generation, signal: callbackSignal ?? abort.signal });
              if (!sameJsonValue(fence.expectedCheckpoint, checkpoint)) throw new Error('External import checkpoint changed during catalog commit.');
              if (fence.expectedModeRevision !== bound.modeRevision || state.sourceIdentityDigest !== activeSourceIdentityDigest ||
                state.snapshotDigest !== activeSnapshotDigest) {
                throw new Error('External import account authority changed.');
              }
              await externalMonitor.storeNativeCatalogPage({ accountId, sourceId: bound.sourceId, generation: bound.generation,
                expectedModeRevision: bound.modeRevision, expectedCheckpoint: checkpoint ?? {}, snapshotDigest: activeSnapshotDigest,
                batchId: `catalog:${page.requestId}:${page.pageNumber}:${page.batchDigest}`, records: page.rows,
                signal: callbackSignal ?? abort.signal });
            },
            async onDirectoryPage(page, callbackSignal) {
              progressLogReady = true;
              if (abort.signal.aborted || callbackSignal?.aborted) throw new Error('External import cancelled.');
              if (!bound || !state || !activeSnapshotDigest) throw new Error('External import directory page arrived before source verification.');
              const fence = await externalMonitor.readBatchFence({ accountId, sourceId: bound.sourceId,
                generation: bound.generation, signal: callbackSignal ?? abort.signal });
              if (fence.expectedModeRevision !== bound.modeRevision || state.sourceIdentityDigest !== activeSourceIdentityDigest) {
                throw new Error('External import account authority changed.');
              }
              await externalMonitor.storeNativeDirectoryPage({ accountId, sourceId: bound.sourceId, generation: bound.generation,
                expectedModeRevision: bound.modeRevision, rows: page.rows, signal: callbackSignal ?? abort.signal });
            },
            async onPage(page) {
              progressLogReady = true;
              if (abort.signal.aborted) throw new Error('External import cancelled.');
              if (!bound || !state || !checkpoint) throw new Error('External import page arrived before source verification.');
              if (page.rows.length > 2000 || (page.rows.length > 0 && page.lastCursor === null) || (page.rows.length === 0 && page.hasMore)) {
                throw new Error('External import page is malformed.');
              }
              if (page.rows.length === 0 && page.lastCursor === null && !page.hasMore) {
                // The native reader emits this terminal page when the durable
                // resume cursor already reaches the snapshot high water mark.
                // It carries no new checkpoint; keep the committed cursor and
                // count intact (which is `{}` only for a genuinely empty import).
                return;
              }
              const fence = await externalMonitor.readBatchFence({ accountId, sourceId: bound.sourceId, generation: bound.generation, signal: abort.signal });
              if (!sameJsonValue(fence.expectedCheckpoint, checkpoint)) throw new Error('External import checkpoint changed during page commit.');
              if (abort.signal.aborted) throw new Error('External import cancelled.');
              const observations = page.rows.map(toExternalObservation);
              await externalMonitor.stageAndProjectBatch({ accountId, sourceId: bound.sourceId, generation: bound.generation,
                expectedModeRevision: bound.modeRevision, expectedCheckpoint: checkpoint, batchId: `initial-${page.pageNumber}-${page.batchDigest}`,
                cursor: page.lastCursor ?? {}, initialImport: true, signal: abort.signal, observations });
              if (abort.signal.aborted) throw new Error('External import cancelled.');
              checkpoint = page.lastCursor ?? {};
              state = await externalMonitor.getInitialImportState({ accountId, sourceId: bound.sourceId, generation: bound.generation, signal: abort.signal });
              if (!state) throw new Error('External import checkpoint disappeared after commit.');
              latestCompletedPage = page.pageNumber;
              setProgress({ stage: 'importing_history', copiedBytes: externalImportProgress.get(accountId)?.copiedBytes ?? null,
                totalBytes: externalImportProgress.get(accountId)?.totalBytes ?? null, committedRows: state.committedCount,
                eligibleRows: state.eligibleCount, message: null });
            },
          });
          if (abort.signal.aborted) throw new Error('External import cancelled.');
          const suffixCountIsValid = Number.isSafeInteger(completion.rowCount) && completion.rowCount >= 0;
          const durableTotal = suffixCountIsValid
            ? (BigInt(startingCommittedCount) + BigInt(completion.rowCount)).toString() : null;
          if (!bound || !state || completion.sourceIdentityDigest !== state.sourceIdentityDigest
            || completion.snapshotDigest !== state.snapshotDigest || durableTotal !== state.committedCount
            || (state.eligibleCount !== null && state.committedCount !== state.eligibleCount)) {
            throw new Error('External import completion did not match its verified source and row count.');
          }
          const completedBinding = bound as { sourceId: string; generation: number; modeRevision: number };
          const finalCursor = completion.highWatermark ?? {};
          const fence = await externalMonitor.readBatchFence({ accountId, sourceId: completedBinding.sourceId, generation: completedBinding.generation, signal: abort.signal });
          if (!sameJsonValue(fence.expectedCheckpoint, finalCursor)) throw new Error('External import did not reach the verified high water mark.');
          if (abort.signal.aborted) throw new Error('External import cancelled.');
          await externalMonitor.completeInitialImport({ accountId, sourceId: completedBinding.sourceId, generation: completedBinding.generation,
            expectedModeRevision: completedBinding.modeRevision, expectedCheckpoint: fence.expectedCheckpoint!, finalCursor,
            highWater: completion.highWatermark, signal: abort.signal });
          if (progressLog) {
            progressLog.record({ stage: 'complete', completedPage: latestCompletedPage,
              committedRows: state.committedCount, updatedAt: new Date().toISOString() });
            await progressLog.close({ remove: true });
          }
          await runDirectMonitor({ accountId, ownMid: account.ownMid!, sourceId: completedBinding.sourceId,
            generation: completedBinding.generation, modeRevision: completedBinding.modeRevision,
            sourceIdentityDigest: state.sourceIdentityDigest, checkpoint: finalCursor, signal: abort.signal, setProgress });
        } catch (error) {
          if (abort.signal.aborted) {
            setProgress({ stage: 'complete', copiedBytes: externalImportProgress.get(accountId)?.copiedBytes ?? null,
              totalBytes: externalImportProgress.get(accountId)?.totalBytes ?? null,
              committedRows: externalImportProgress.get(accountId)?.committedRows ?? previousState?.committedCount ?? '0',
              eligibleRows: externalImportProgress.get(accountId)?.eligibleRows ?? previousState?.eligibleCount ?? null,
              message: 'External monitoring paused.' });
          } else {
            const monitorFailure = error instanceof ExternalMonitorDiagnosticFailure ? error : null;
            const safeCode = monitorFailure?.code ?? null;
            if (monitorFailure) await recordExternalMonitorDiagnostic(options.externalMonitorDiagnosticPath, monitorFailure.stage, monitorFailure.code,
              monitorFailure.detail, monitorFailure.phase, 'manual_start');
            setProgress({ stage: 'failed', copiedBytes: externalImportProgress.get(accountId)?.copiedBytes ?? null,
              totalBytes: externalImportProgress.get(accountId)?.totalBytes ?? null,
              committedRows: externalImportProgress.get(accountId)?.committedRows ?? previousState?.committedCount ?? '0',
              eligibleRows: externalImportProgress.get(accountId)?.eligibleRows ?? previousState?.eligibleCount ?? null,
              message: safeCode ?? externalMonitorFailureDetail(error) ?? 'LINE import failed.' });
          }
        } finally {
          if (progressLog) await progressLog.close({ remove: false });
          if (externalImportOwner?.abort === abort) externalImportOwner = null;
          await publishSnapshot().catch(() => undefined);
        }
      }, { operation: 'external_monitor', identity: { accountId, requestId } });
      externalImportOwner.task = task;
      void task.catch(() => undefined);
      return accepted(requestId);
    });
  }

  async function resumeExternalMonitorOnStartup(): Promise<void> {
    if (!options.officialSnapshotImporter?.readOfficialMonitor) return;
    await supervisor.runLifecycle(async () => {
    if (closing || externalImportOwner) return;
    const selected = await options.pool.query<{ account_id: string; source_id: string; generation: string;
      identity_digest: string; own_mid: string }>(`SELECT a.account_id,s.source_id,s.generation,s.identity_digest,a.own_mid
      FROM line_accounts a JOIN line_account_sources s ON s.account_id=a.account_id
        AND s.source_id=a.selected_source_id AND s.generation=a.selected_source_generation
      JOIN external_source_checkpoints c ON c.account_id=a.account_id AND c.source_id=s.source_id AND c.generation=s.generation
      WHERE a.product_role='PRIMARY_ADMIN' AND a.connection_mode='EXTERNAL_MONITOR' AND a.source_transition_state='STABLE'
        AND a.mode<>'ACTIVE_CONTROL' AND a.status='disconnected' AND s.source_type='EXTERNAL_MONITOR' AND s.state='ACTIVE'
        AND c.initial_import_complete=true ORDER BY a.account_id LIMIT 2`);
    if (selected.rowCount !== 1) return;
    const candidate = selected.rows[0]!;
    const generation = Number(candidate.generation);
    if (!Number.isSafeInteger(generation) || generation < 1) return;
    const account = await accounts.getAccount(candidate.account_id);
    if (!account?.ownMid || account.ownMid !== candidate.own_mid || loginAttempts.has(candidate.account_id)
      || await options.workers.binding(candidate.account_id)) return;
    const authenticated = await accounts.listAuthenticatedAccounts();
    const agent = authenticated.find((item) => item.productRole === 'AGENT');
    const control = await accounts.getControlState();
    if (control.activeAccountId === candidate.account_id || !await externalAdminAuthorized(agent, candidate.own_mid)) return;
    let state: Awaited<ReturnType<ExternalMonitorRepository['getInitialImportState']>>;
    try {
      state = await externalMonitor.getInitialImportState({ accountId: candidate.account_id,
        sourceId: candidate.source_id, generation });
    } catch (error) {
      const diagnostic = externalMonitorDatabaseFailure(error, 'startup');
      await recordExternalMonitorDiagnostic(options.externalMonitorDiagnosticPath, diagnostic.stage, diagnostic.code,
        undefined, 'facade_checkpoint_fence', 'startup_resume');
      externalImportProgress.set(candidate.account_id, { stage: 'failed', copiedBytes: null, totalBytes: null,
        committedRows: '0', eligibleRows: null, message: diagnostic.code });
      await publishSnapshot().catch(() => undefined);
      return;
    }
    if (closing || externalImportOwner || !state?.initialImportComplete || state.sourceIdentityDigest !== candidate.identity_digest) return;
    const abort = new AbortController();
    externalImportOwner = { accountId: candidate.account_id, abort };
    const setProgress = (progress: ExternalImportProgress) => {
      externalImportProgress.set(candidate.account_id, progress);
      void publishSnapshot().catch(() => undefined);
    };
    setProgress({ stage: 'monitoring', copiedBytes: null, totalBytes: null,
      committedRows: state.committedCount, eligibleRows: state.eligibleCount, message: null });
    const task = track(async () => {
      try {
        let fence: Awaited<ReturnType<ExternalMonitorRepository['readBatchFence']>>;
        try {
          fence = await externalMonitor.readBatchFence({ accountId: candidate.account_id, sourceId: candidate.source_id,
            generation, signal: abort.signal });
        } catch (error) {
          const failure = externalMonitorDatabaseFailure(error, 'startup');
          throw new ExternalMonitorDiagnosticFailure(failure.code, failure.stage, failure.detail, 'facade_checkpoint_fence');
        }
        await runDirectMonitor({ accountId: candidate.account_id, ownMid: candidate.own_mid, sourceId: candidate.source_id,
          generation, modeRevision: fence.expectedModeRevision,
          sourceIdentityDigest: candidate.identity_digest, checkpoint: fence.expectedCheckpoint ?? {}, signal: abort.signal, setProgress });
      } catch (error) {
        const failureStage = error instanceof ExternalMonitorDiagnosticFailure ? error.stage : 'startup';
        const failureCode = abort.signal.aborted ? null : classifyExternalMonitorFailure(error, failureStage);
        if (failureCode) await recordExternalMonitorDiagnostic(options.externalMonitorDiagnosticPath, failureStage, failureCode,
          externalMonitorFailureDetail(error), error instanceof ExternalMonitorDiagnosticFailure ? error.phase : undefined, 'startup_resume');
        setProgress({ stage: abort.signal.aborted ? 'complete' : 'failed', copiedBytes: null, totalBytes: null,
          committedRows: state.committedCount, eligibleRows: state.eligibleCount,
          message: abort.signal.aborted ? 'External monitoring paused.'
            : failureCode });
      } finally {
        if (externalImportOwner?.abort === abort) externalImportOwner = null;
        await publishSnapshot().catch(() => undefined);
      }
    }, { operation: 'external_monitor', identity: { accountId: candidate.account_id, background: true } });
    externalImportOwner.task = task;
    void task.catch(() => undefined);
    });
  }

  /**
   * Expected admin for external monitoring: the Agent's binding when an Agent account is logged in; with no Agent account
   * the Primary Admin slot's verified official identity is the authority (the `_profile._mid` re-check stays mandatory).
   */
  async function externalAdminAuthorized(agent: { accountId: string } | undefined, ownMid: string): Promise<boolean> {
    return agent ? admins.isPrimaryUser(agent.accountId, ownMid) : true;
  }

  const maskMid = (mid: string) => `${mid.slice(0, 5)}…${mid.slice(-4)}`;

  /**
   * Shared by the admin-binding preview and confirm: checks the preconditions and takes a fresh, read-only
   * identity reading of the account the official LINE is currently logged in to (active database only).
   */
  async function readBindableOfficialIdentity(requestId: string): Promise<
    { identity: { mid: string; displayName: string | null; picturePath?: string | null }; candidateCount: number } | IpcResult> {
    if (closing) return failure(requestId, 'SERVICE_CLOSING', 'Service is closing.');
    // The admin is unset when no Agent binding and no Primary Admin slot identity exist; an Agent account is optional.
    const authenticated = await accounts.listAuthenticatedAccounts();
    const agent = authenticated.find((item) => item.productRole === 'AGENT');
    if ((agent && await admins.hasPrimary(agent.accountId)) || authenticated.some((item) => item.productRole === 'PRIMARY_ADMIN')) {
      return failure(requestId, 'PRIMARY_ADMIN_ALREADY_BOUND', '已經設定主要管理者。');
    }
    if (externalImportOwner || identityReadAbort) return failure(requestId, 'EXTERNAL_IMPORT_BUSY', 'LINE 讀取正在進行中，請稍後再試。', true);
    const readIdentity = options.officialSnapshotImporter?.readOfficialIdentity?.bind(options.officialSnapshotImporter);
    if (!readIdentity) return failure(requestId, 'OFFICIAL_IDENTITY_UNAVAILABLE', 'reader_missing');
    const abort = new AbortController();
    identityReadAbort = abort;
    try {
      const read = await track(() => readIdentity({ signal: abort.signal,
        onPhase: (phase) => { options.publish?.({ type: 'externalAdminBindingProgress', phase }); } }),
      { operation: 'native_reader', identity: { requestId }, reportFailure: false });
      if (read.status !== 'supported') {
        const code = typeof read.errorCode === 'string' && read.errorCode.length <= 120 && MACHINE_CODE_PATTERN.test(read.errorCode) ? read.errorCode : 'reader_unsupported';
        console.warn('[external-admin-binding] official identity read unsupported:', code);
        return failure(requestId, 'OFFICIAL_IDENTITY_UNAVAILABLE', code, true);
      }
      if (!/^u[0-9a-f]{32}$/.test(read.mid)) return failure(requestId, 'OFFICIAL_IDENTITY_UNAVAILABLE', 'identity_invalid');
      return { identity: { mid: read.mid, displayName: read.displayName, ...(read.picturePath === undefined ? {} : { picturePath: read.picturePath }) }, candidateCount: read.candidateCount };
    } catch (error) {
      // Never log the MID; the reader error is a finite code.
      options.audit?.failure(diagnosticFailure('native_reader', 'read', error), { requestId });
      // Only a finite machine code (bare, or `prefix:<code>`) reaches the renderer; any other text becomes `reader_failed`.
      const raw = error instanceof Error ? error.message : '';
      const last = raw.slice(raw.lastIndexOf(':') + 1);
      const code = raw.length <= 120 && MACHINE_CODE_PATTERN.test(raw) && last.length > 0 ? last : 'reader_failed';
      return failure(requestId, 'OFFICIAL_IDENTITY_UNAVAILABLE', code, true);
    } finally {
      if (identityReadAbort === abort) identityReadAbort = null;
    }
  }

  async function previewExternalAdminBinding(requestId: string): Promise<IpcResult> {
    const read = await readBindableOfficialIdentity(requestId);
    if ('type' in read) return read;
    return { type: 'previewExternalAdminBinding', requestId, ok: true, identity: read.identity,
      otherCandidates: Math.max(0, read.candidateCount - 1) };
  }

  async function startExternalMonitorAsAdmin(requestId: string, mid: string): Promise<IpcResult> {
    // The renderer's MID is only a confirmation token: the authority is the fresh native read.
    const read = await readBindableOfficialIdentity(requestId);
    if ('type' in read) return read;
    if (read.identity.mid !== mid) return failure(requestId, 'OFFICIAL_IDENTITY_CHANGED', 'LINE 目前登入的帳號已變更，請重新操作。');
    if (closing) return failure(requestId, 'SERVICE_CLOSING', 'Service is closing.');
    const bound = await supervisor.runLifecycle(() => accounts.bindPrimaryAdminFromExternalMonitor({
      mid, displayName: read.identity.displayName, ...(read.identity.picturePath === undefined ? {} : { picturePath: read.identity.picturePath }), correlationId: requestId,
    }));
    if (!bound.ok) {
      const message = bound.code === 'AGENT_ACCOUNT_REQUIRED' ? '請先登入 Agent 帳號。'
        : bound.code === 'PRIMARY_ADMIN_ALREADY_BOUND' ? '已經設定主要管理者。'
          : 'LINE 目前的帳號無法成為主要管理者（與 Agent 帳號相同，或管理者帳號位已被其他帳號佔用）。';
      return failure(requestId, bound.code, message);
    }
    console.info(`[external-admin-binding] primary admin bound from official LINE ${maskMid(mid)}`);
    await publishSnapshot().catch(() => undefined);
    // The admin is confirmed by the user and now bound; a failed start leaves the card to retry.
    const started = await beginExternalImport(requestId, bound.accountId);
    return { type: 'startExternalMonitorAsAdmin', requestId, ok: true, bound: true, started: started.ok,
      message: started.ok ? null : started.message };
  }

  async function refreshOwnAvatar(accountId: string, requestId: string): Promise<IpcResult> {
    const currentFlight = avatarRefreshFlights.get(accountId);
    if (currentFlight) {
      const result = await currentFlight;
      return { ...result, requestId } as IpcResult;
    }
    const flight = (async (): Promise<IpcResult> => {
      if (closing) return failure(requestId, 'SERVICE_CLOSING', 'Service is closing.');
      const account = await accounts.getAccount(accountId);
      const capability = await accounts.resolveCapabilities(accountId);
      const binding = await options.workers.binding(accountId);
      if (!account?.ownMid || !account.productRole || !['AGENT', 'PRIMARY_ADMIN'].includes(account.productRole)
        || account.mode === 'PAUSED' || !binding
        || capability?.connectionMode !== 'SYSTEM_LOGIN' || capability.selectedSourceType === 'EXTERNAL_MONITOR'
        || capability.sourceState === 'FENCED' || capability.sourceState === 'RETIRED'
        || binding.mode === 'PAUSED' || binding.purpose === 'DOWNLOAD_ONLY' || !options.workers.refreshOwnProfile
        || !await accounts.canRefreshWorkerAvatar(binding, account.ownMid)) {
        return failure(requestId, 'LINE_PROFILE_REFRESH_UNAVAILABLE', 'A connected signed-in LINE account is required.', true);
      }
      const capturedBinding = { ...binding };
      try {
        const profile = await options.workers.refreshOwnProfile({ ...pickWorkerBinding(capturedBinding), type: 'refreshOwnProfile', requestId, timeoutMs: 15_000 });
        if (!profile.ok || profile.ownMid !== account.ownMid) return failure(requestId,
          'LINE_PROFILE_REFRESH_FAILED', profile.error === 'PROFILE_MISMATCH' ? 'The LINE account identity changed. Refresh was discarded.' : 'LINE profile could not be refreshed.', true,
          isLineServerErrorCode(profile.error) ? profile.error : undefined);
        const [current, currentCapabilities, currentBinding] = await Promise.all([
          accounts.getAccount(accountId), accounts.resolveCapabilities(accountId), options.workers.binding(accountId),
        ]);
        if (!current?.ownMid || current.ownMid !== account.ownMid || current.productRole !== account.productRole || current.mode === 'PAUSED'
          || currentBinding?.workerInstanceId !== capturedBinding.workerInstanceId
          || currentBinding.controlEpoch !== capturedBinding.controlEpoch || currentCapabilities?.connectionMode !== 'SYSTEM_LOGIN'
          || currentCapabilities.selectedSourceType === 'EXTERNAL_MONITOR'
          || currentCapabilities.sourceState !== capability.sourceState
          || currentCapabilities.selectedSourceId !== capability.selectedSourceId
          || currentCapabilities.selectedSourceGeneration !== capability.selectedSourceGeneration
          || !await accounts.canRefreshWorkerAvatar(capturedBinding, current.ownMid)) {
          return failure(requestId, 'LINE_PROFILE_REFRESH_STALE', 'The account connection changed during refresh. Try again.', true);
        }
        if (typeof profile.picturePath === 'string' && profile.picturePath.length > 0) await lineMedia.invalidateAvatar(profile.picturePath);
        if (!await accounts.refreshWorkerAvatar(capturedBinding, profile.ownMid, profile.displayName, profile.picturePath)) {
          return failure(requestId, 'LINE_PROFILE_REFRESH_STALE', 'The account connection changed during refresh. Try again.', true);
        }
        await publishSnapshot();
        options.publish?.({ type: 'lineAvatarRefreshed', accountId, ownMid: profile.ownMid });
        return { type: 'accepted', requestId, ok: true, ownMid: profile.ownMid };
      } catch (error) {
        options.audit?.failure(diagnosticFailure('refreshOwnProfile', 'execute', error),
          { accountId, requestId, initiator: 'user' }, 'PROFILE_REFRESH_FAILED');
        return failure(requestId, 'LINE_PROFILE_REFRESH_FAILED', 'LINE profile could not be refreshed.', true);
      }
    })();
    const tracked = flight.finally(() => { if (avatarRefreshFlights.get(accountId) === tracked) avatarRefreshFlights.delete(accountId); });
    avatarRefreshFlights.set(accountId, tracked);
    return tracked;
  }

  async function noteOwnAvatarAccountConnected(accountId: string): Promise<void> {
    const account = await accounts.getAccount(accountId);
    ownAvatarRefreshScheduler?.noteConnected(accountId, account?.productRole ?? null);
  }

  async function runPeriodicOwnAvatarRefreshes(accountsToRefresh: readonly { accountId: string; productRole: string }[]): Promise<void> {
    await runOwnAvatarRefreshes(accountsToRefresh,
      (accountId) => refreshOwnAvatar(accountId, `periodic-avatar-${randomUUID()}`), () => !closing);
  }

  async function dispatch(request: IpcRequest, signal?: AbortSignal): Promise<IpcResult> {
    const requestId = request.requestId;
    try {
      if (request.type === 'reportRendererFailure') {
        options.audit?.failure({ operation: 'renderer', stage: 'execute', category: 'unknown', recovery: 'reopen_app' }, { requestId });
        return accepted(requestId);
      }
      if (request.type === 'getSnapshot') return { type: request.type, requestId: request.requestId, ok: true, snapshot: await publishSnapshot.read() };
      if (request.type === 'getConversationSettings') {
        if (conversationSettingsError) return failure(requestId, 'SETTINGS_LOAD_FAILED', conversationSettingsError, true);
        return { type: request.type, requestId, ok: true, settings: await settings.getConversationSettings() };
      }
      if (request.type === 'getManualUnsendWindow') {
        const saved = await settings.getAppSetting('manual_unsend_window');
        return { type: request.type, requestId, ok: true, window: saved === '7d' ? '7d' : '1h' };
      }
      if (request.type === 'setManualUnsendWindow') {
        await settings.setAppSetting('manual_unsend_window', request.window);
        return { type: request.type, requestId, ok: true, window: request.window };
      }
      if (request.type === 'getAgentPersona') return { type: request.type, requestId, ok: true, persona: await readGlobalPersona(settings) };
      if (request.type === 'setAgentPersona') {
        const description = request.persona.description.trim();
        await settings.setAppSetting(PERSONA_DESCRIPTION_SETTING, description);
        await settings.setAppSetting(PERSONA_LIVELINESS_SETTING, request.persona.liveliness);
        return { type: request.type, requestId, ok: true, persona: { description, liveliness: request.persona.liveliness } };
      }
      if (request.type === 'setConversationSettings') {
        let resolve!: (value: IpcResult) => void;
        const result = new Promise<IpcResult>((done) => { resolve = done; });
        settingsTail = settingsTail.then(async () => {
          await settings.setConversationSettings(request.settings);
          conversationSettings = request.settings;
          conversationSettingsError = null;
          attachmentService.setAutomaticAttemptLimit(request.settings.attachmentAutoAttemptLimit);
          agentService.setStatusRotationIntervalSeconds(request.settings.agentStatusRotationIntervalSeconds);
          resolve({ type: request.type, requestId, ok: true, settings: request.settings });
        }).catch((error: unknown) => {
          options.audit?.failure(diagnosticFailure('database', 'persist', error), { requestId });
          resolve(failure(requestId, 'SETTINGS_SAVE_FAILED', 'Unable to save settings', true));
        });
        return await result;
      }
      if (request.type === 'lineStart') {
        return await supervisor.runLifecycle(async () => {
          await stopExternalImportForAccount(request.accountId);
          const account = await accounts.getAccount(request.accountId);
          if (!account) return failure(request.requestId, 'ACCOUNT_NOT_FOUND', 'LINE account not found.');
          if (!account.productRole) return failure(request.requestId, 'ACCOUNT_ROLE_UNCLASSIFIED', 'This account has no assigned role slot.');
          const ltsmBlock = await chromeLtsmBlock(await transportOf(account.accountId));
          if (ltsmBlock) return chromeLtsmUnavailable(request.requestId, ltsmBlock);
          await startStoredAccount(account);
          return accepted(request.requestId);
        });
      }
      if (request.type === 'refreshLineAvatar') {
        return refreshOwnAvatar(request.accountId, request.requestId);
      }
      if (request.type === 'externalImportStop') {
        return await supervisor.runLifecycle(async () => {
          const account = await accounts.getAccount(request.accountId);
          const capability = account?.productRole === 'PRIMARY_ADMIN'
            ? await accounts.resolveCapabilities(request.accountId) : null;
          if (!account?.ownMid || account.productRole !== 'PRIMARY_ADMIN'
            || capability?.selectedSourceType !== 'EXTERNAL_MONITOR' || !capability.selectedSourceId
            || capability.selectedSourceGeneration === null) {
            return failure(request.requestId, 'EXTERNAL_MONITOR_NOT_ACTIVE', '此帳號沒有有效的外部監控檢查點。');
          }
          const state = await externalMonitor.getInitialImportState({ accountId: request.accountId,
            sourceId: capability.selectedSourceId, generation: capability.selectedSourceGeneration });
          if (!state?.initialImportComplete) {
            return failure(request.requestId, 'EXTERNAL_IMPORT_INCOMPLETE', '首次歷史匯入完成前無法關閉外部監控。');
          }
          const owner = externalImportOwner;
          if (owner && owner.accountId !== request.accountId) {
            return failure(request.requestId, 'EXTERNAL_MONITOR_BUSY', '目前由另一個帳號執行外部監控。');
          }
          if (!owner) return accepted(request.requestId);
          const stage = externalImportProgress.get(request.accountId)?.stage;
          if (stage !== 'monitoring' && stage !== 'syncing') {
            return failure(request.requestId, 'EXTERNAL_MONITOR_NOT_ACTIVE', '此帳號目前不在外部監控階段。');
          }
          await stopExternalImportForAccount(request.accountId);
          return accepted(request.requestId);
        });
      }
      if (request.type === 'externalImportStart') return await beginExternalImport(request.requestId, request.accountId);
      if (request.type === 'previewExternalAdminBinding') return await previewExternalAdminBinding(request.requestId);
      if (request.type === 'startExternalMonitorAsAdmin') return await startExternalMonitorAsAdmin(request.requestId, request.mid);
      if (request.type === 'officialLineApproveSigner') {
        // Explicit user approval only: pins the signer recorded by the last rotation observation.
        if (!options.officialBuildTrust) return failure(requestId, 'OFFICIAL_SIGNER_UNAVAILABLE', '目前無法確認 LINE 簽署憑證。');
        try { await options.officialBuildTrust.approveRotation(); }
        catch (error) {
          const code = error instanceof Error ? error.message : '';
          if (code === 'official_signer_not_pending') return failure(requestId, 'OFFICIAL_SIGNER_NOT_PENDING', '目前沒有待確認的 LINE 簽署憑證。');
          if (code === 'official_signer_limit') return failure(requestId, 'OFFICIAL_SIGNER_LIMIT', '已信任的 LINE 簽署憑證數量已達上限。');
          throw error;
        }
        await publishSnapshot().catch(() => undefined);
        return accepted(requestId);
      }
      if (request.type === 'lineLogout') {
        return await supervisor.runLifecycle(async () => {
        const account = await accounts.getAccount(request.accountId);
        if (!account) return failure(request.requestId, 'ACCOUNT_NOT_FOUND', '找不到這個 LINE 帳號。');
        const loginAttemptId = loginAttempts.get(request.accountId);
        if (!account.ownMid && !loginAttemptId) return failure(request.requestId, 'ACCOUNT_NOT_AUTHENTICATED', '這不是已完成登入的 LINE 帳號。');
        const binding = await options.workers.binding(request.accountId) ?? supervisor.binding(request.accountId);
        // A pending login has no server session in the worker, so the worker cannot log out. Cancel it locally.
        const loginPending = !!loginAttemptId && completedLoginAttempts.get(request.accountId) !== loginAttemptId;
        if (account.ownMid && !loginPending) {
          if (!binding) throw new Error('LINE_LOGOUT_WORKER_UNAVAILABLE');
          const logout = await lineService.requestLogout(request.accountId, binding.workerInstanceId);
          if (!logout.ok && logout.error !== 'LINE_AUTH_INVALIDATED') throw new Error('LINE_LOGOUT_FAILED');
        }
        await releaseAccountSession(request.accountId, binding, loginAttemptId, 'user');
        // A cancelled login saved no secret, and the old method keeps its own. A real logout removes only the secrets of the
        // method of the session that logged out: the worker's own method when it runs, else the stored marker.
        if (!loginPending) {
          await auditSecretClear(request.accountId, 'user', { requestId: request.requestId },
            binding ? resolveLineTransport(binding.lineTransport) : await transportOf(request.accountId));
        }
        await accounts.setConnectionStatus(request.accountId, 'disconnected');
        options.publish?.({ type: 'lineLoginState', accountId: request.accountId, loginAttemptId: null,
          state: 'disconnected', message: '已登出；聊天紀錄與附件索引均已保留。' });
        options.publish?.({ type: 'controlChanged', control: (await publishSnapshot.read()).control });
        await publishSnapshot();
        return accepted(request.requestId);
        }).catch((error: unknown) => {
          options.audit?.failure({ ...diagnosticFailure('revokeControl', 'execute', error), ipcAction: request.type }, { accountId: request.accountId, requestId: request.requestId });
          return failure(request.requestId, 'LINE_LOGOUT_FAILED', 'LINE 登出未能安全完成，請確認帳號狀態後再試。', true);
        });
      }
      if (request.type === 'lineSetAutoLogin') {
        const account = await accounts.getAccount(request.accountId);
        if (!account) return failure(request.requestId, 'ACCOUNT_NOT_FOUND', '找不到這個 LINE 帳號。');
        await accounts.setAutoLoginOnStartup(request.accountId, request.enabled);
        await publishSnapshot();
        return accepted(request.requestId);
      }
      if (request.type === 'lineBeginAdminPairing') {
        const account = await accounts.getAccount(request.accountId);
        if (!account?.ownMid || account.mode !== 'ACTIVE_CONTROL') return failure(request.requestId, 'ACCOUNT_NOT_ACTIVE', '只有已登入的主操作帳號可以新增主要管理者。');
        try {
          const pairing = await adminPairings.begin(request.accountId);
          return { type: 'lineAdminPairing', requestId, ok: true, ...pairing };
        } catch (error) {
          options.audit?.failure(diagnosticFailure('ipc', 'execute', error), { requestId });
          return failure(request.requestId, 'ADMIN_ALREADY_EXISTS', '無法建立主要管理者驗證。');
        }
      }
      if (request.type === 'switchControl') {
        return failure(request.requestId, 'CONTROL_SWITCH_DISABLED', 'Account control is assigned to the fixed Agent role.');
      }
      if (request.type === 'sendText' || request.type === 'replyText') {
        let sendResult: Promise<SendResult> | undefined;
        const admissionFailure = await supervisor.runLifecycle(async () => {
          if (!await canWriteLine(request.accountId)) return { code: 'EXTERNAL_MONITOR_READ_ONLY', message: 'External monitoring is read-only.' };
          if (isLocalAgentRoom(request)) return { code: 'LOCAL_ROUTE_DENIED', message: 'Agent 室是本機對話，不會傳送到 LINE。' };
          const account = await accounts.getAccount(request.accountId);
          if (!account?.ownMid || (account.productRole !== 'AGENT' && account.productRole !== 'PRIMARY_ADMIN') || account.mode === 'PAUSED') {
            return { code: 'ACCOUNT_NOT_READY', message: 'LINE account is not ready for manual sending.' };
          }
          const binding = await options.workers.binding(request.accountId);
          if (!binding || binding.mode === 'PAUSED' || !options.workers.isCurrentManualSendBinding(binding)) {
            return { code: 'ACCOUNT_NOT_ACTIVE', message: 'LINE worker is not ready for manual sending.' };
          }
          if (!lineService.isAuthenticatedReady(binding)) {
            return { code: 'ACCOUNT_NOT_READY', message: 'LINE account has not completed native login and connection readiness.' };
          }
          // Queue the send while lifecycle transitions are serialized, then
          // await its physical outcome after releasing the lifecycle lane.
          sendResult = options.workers.sendManual({ type: 'sendText', ...binding, accountId: request.accountId,
            chatType: request.chatType, chatId: request.chatId, requestId: request.requestId, text: request.text,
            replyToMessageId: request.type === 'replyText' ? request.replyToMessageId : null });
          return null;
        });
        if (admissionFailure) return failure(request.requestId, 'LINE_SEND_NOT_STARTED', admissionFailure.message);
        if (!sendResult) return failure(request.requestId, 'LINE_SEND_NOT_STARTED', 'LINE account is not ready for manual sending.');
        const result = await sendResult;
        if (result.status === 'sent') return accepted(request.requestId);
        // A LINE server code is audited by recordKnownServerResult; every other worker code is audited here.
        if (!isLineServerErrorCode(result.error)) recordSendFault(options.audit, { accountId: request.accountId, requestId: request.requestId,
          operation: 'manualSendText' }, workerFault(result, result.status === 'failed' ? 'failed' : 'unknown'));
        return result.status === 'failed'
          ? failure(request.requestId, 'LINE_SEND_NOT_STARTED', lineResultErrorMessage(result.error, 'LINE message was not sent.'), false,
            isLineServerErrorCode(result.error) ? result.error : undefined)
          : failure(request.requestId, 'LINE_SEND_OUTCOME_UNKNOWN', 'LINE send outcome is unknown.');
      }
      if (request.type === 'sendManualMedia') {
        type ManualMediaAdmissionResult = { failure: { code: string; message: string } }
          | { binding: Bound; chatType: 'direct' | 'group' };
        const admission: ManualMediaAdmissionResult = await supervisor.runLifecycle(async (): Promise<ManualMediaAdmissionResult> => {
          if (!await canWriteLine(request.accountId)) return { failure: { code: 'EXTERNAL_MONITOR_READ_ONLY', message: 'External monitoring is read-only.' } };
          if (isLocalAgentRoom(request) || (request.chatType !== 'direct' && request.chatType !== 'group')) {
            return { failure: { code: 'LINE_MEDIA_UNSUPPORTED_CHAT', message: 'Attachments can only be sent to direct and group chats.' } };
          }
          const account = await accounts.getAccount(request.accountId);
          if (!account?.ownMid || (account.productRole !== 'AGENT' && account.productRole !== 'PRIMARY_ADMIN') || account.mode === 'PAUSED') {
            return { failure: { code: 'ACCOUNT_NOT_READY', message: 'LINE account is not ready for manual sending.' } };
          }
          const current = await options.workers.binding(request.accountId);
          if (!current || current.mode === 'PAUSED' || !options.workers.isCurrentManualSendBinding(current)) {
            return { failure: { code: 'ACCOUNT_NOT_ACTIVE', message: 'LINE worker is not ready for manual sending.' } };
          }
          if (!lineService.isAuthenticatedReady(current)) return { failure: { code: 'ACCOUNT_NOT_READY', message: 'LINE account has not completed native login and connection readiness.' } };
          if (request.files.length > 0 && !options.workers.sendMedia) return { failure: { code: 'LINE_MEDIA_UNAVAILABLE', message: 'LINE media sending is unavailable.' } };
          return { binding: current, chatType: request.chatType as 'direct' | 'group' };
        });
        if ('failure' in admission) return failure(request.requestId, admission.failure.code, admission.failure.message);
        if (signal?.aborted) return failure(request.requestId, 'LINE_SEND_NOT_STARTED', 'LINE attachment send was cancelled before staging.');
        let staged: Awaited<ReturnType<typeof stageManualMedia>> | undefined;
        try {
          staged = await stageManualMedia(request.files, undefined, signal);
          if (signal?.aborted) return failure(request.requestId, 'LINE_SEND_NOT_STARTED', 'LINE attachment send was cancelled before worker admission.');
          for (const item of staged.items) {
            const result = await options.workers.sendMedia!({ accountId: request.accountId, workerInstanceId: admission.binding.workerInstanceId,
              controlEpoch: admission.binding.controlEpoch, chatType: admission.chatType, chatId: request.chatId, requestId: randomUUID(),
              kind: item.kind, filePath: item.filePath, fileName: item.fileName, sizeBytes: item.sizeBytes, sha256: item.sha256,
              manualSend: true }, signal);
            if (result.status !== 'sent' && !isLineServerErrorCode(result.error)) recordSendFault(options.audit, { accountId: request.accountId,
              requestId: result.requestId, operation: 'sendMedia' }, workerFault(result, result.status === 'failed' ? 'failed' : 'unknown'));
            if (result.status !== 'sent') return result.status === 'failed'
              ? failure(request.requestId, 'LINE_SEND_NOT_STARTED', lineResultErrorMessage(result.error, 'LINE attachment was not sent.', result.detail), false,
                isLineServerErrorCode(result.error) ? result.error : undefined)
              : failure(request.requestId, 'LINE_SEND_OUTCOME_UNKNOWN', 'LINE attachment outcome is unknown.');
          }
          return accepted(request.requestId);
        } catch (error) {
          if (error instanceof ManualMediaError) return failure(request.requestId, 'LINE_SEND_NOT_STARTED', error.message);
          // The thrown gateway reason is kept in the audit row; the user text stays the same.
          recordSendFault(options.audit, { accountId: request.accountId, requestId: request.requestId, operation: 'sendMedia' },
            gatewayFault(error, error instanceof ManualSendNotStartedError ? 'failed' : 'unknown'));
          if (error instanceof ManualSendNotStartedError) return failure(request.requestId, 'LINE_SEND_NOT_STARTED', error.message);
          return failure(request.requestId, 'LINE_SEND_OUTCOME_UNKNOWN', 'LINE send outcome is unknown.');
        } finally { await staged?.cleanup().catch(() => undefined); }
      }
      if (request.type === 'unsendMessage') {
        if (!['direct', 'group', 'room'].includes(request.chatType)) return failure(request.requestId, 'UNSEND_CHAT_UNSUPPORTED', 'This conversation does not support message unsend.');
        const chatType = request.chatType as 'direct' | 'group' | 'room';
        if (!options.workers.unsend) return failure(request.requestId, 'LINE_UNSEND_NOT_STARTED', 'LINE worker does not support message unsend.');
        let resultPromise: Promise<Extract<LineWorkerEvent, { type: 'unsendResult' }>> | undefined;
        let ownMid: string | undefined;
        const admissionFailure = await supervisor.runLifecycle(async () => {
          if (!await canWriteLine(request.accountId)) return { code: 'EXTERNAL_MONITOR_READ_ONLY', message: 'External monitoring is read-only.' };
          if (isLocalAgentRoom(request)) return { code: 'LOCAL_ROUTE_DENIED', message: 'This conversation is local only.' };
          const account = await accounts.getAccount(request.accountId);
          if (!account?.ownMid || (account.productRole !== 'AGENT' && account.productRole !== 'PRIMARY_ADMIN') || account.mode === 'PAUSED') {
            return { code: 'ACCOUNT_NOT_READY', message: 'LINE account is not ready to unsend messages.' };
          }
          const storedMessage = await messages.getMessage(request, request.messageId);
          if (!storedMessage || storedMessage.senderId !== account.ownMid || storedMessage.content?.type === 'unsent' || storedMessage.sourceDeleted) {
            return { code: 'MESSAGE_NOT_ELIGIBLE', message: 'Only your own unrecalled messages can be unsent.' };
          }
          const binding = await options.workers.binding(request.accountId);
          if (!binding || binding.mode === 'PAUSED' || !options.workers.isCurrentManualSendBinding(binding)) {
            return { code: 'ACCOUNT_NOT_ACTIVE', message: 'LINE worker is not ready to unsend messages.' };
          }
          if (!lineService.isAuthenticatedReady(binding)) return { code: 'ACCOUNT_NOT_READY', message: 'LINE account is not connected.' };
          ownMid = account.ownMid;
          resultPromise = options.workers.unsend!({ type: 'unsendMessage', ...binding, accountId: request.accountId,
            chatType, chatId: request.chatId, requestId: request.requestId, messageId: request.messageId });
          return null;
        });
        if (admissionFailure) return failure(request.requestId, admissionFailure.code, admissionFailure.message);
        if (!resultPromise || !ownMid) return failure(request.requestId, 'LINE_UNSEND_NOT_STARTED', 'LINE account is not ready to unsend messages.');
        const result = await resultPromise;
        if (result.status !== 'unsent' && !isLineServerErrorCode(result.error)) recordSendFault(options.audit, { accountId: request.accountId,
          requestId: request.requestId, operation: 'unsendMessage' }, workerFault({ error: result.error }, result.status === 'failed' ? 'failed' : 'unknown'));
        if (result.status === 'failed') return failure(request.requestId, 'LINE_UNSEND_NOT_STARTED',
          lineResultErrorMessage(result.error, 'LINE message was not unsent.'), false,
          isLineServerErrorCode(result.error) ? result.error : undefined);
        if (result.status === 'unknown') return failure(request.requestId, 'LINE_UNSEND_OUTCOME_UNKNOWN', 'LINE unsend outcome is unknown.');
        try {
          await messages.recordManualUnsend(request, request.messageId, ownMid);
          return accepted(request.requestId);
        } catch (error) {
          options.audit?.failure(diagnosticFailure('unsendMessage', 'persist', error), { requestId });
          return failure(request.requestId, 'LINE_UNSEND_RECONCILIATION_FAILED', 'LINE unsend succeeded but local reconciliation failed.');
        }
      }
      // The shared Agent room is the operator's own: no LINE account, so no canWriteLine / ACTIVE_CONTROL gate.
      if (request.type === 'submitAgentRoomPrompt') {
        let result: Awaited<ReturnType<typeof agentService.submitFromUi>>;
        try {
          result = await agentService.submitFromUi({ provider: request.provider, requestId: request.requestId, prompt: request.prompt,
            ...(request.attachments?.length ? { attachments: request.attachments } : {}) });
        } catch (error) {
          // Attachment problems have user-readable zh-TW messages; nothing was stored and no job exists.
          if (error instanceof AgentAttachmentError) return failure(request.requestId, error.code, error.message);
          throw error;
        }
        await publishSnapshot();
        return { type: request.type, requestId: request.requestId, ok: true, jobId: result.jobId };
      }
      // The Jobs page and the schedule run history address any account-less job by id: a scheduled run lives on its own queue,
      // everything else is a room job. Only the job's stored source type decides; the room's lookups never see schedule jobs.
      const accountLessKey = async (jobId: string) => (await agents.getJob(jobId))?.sourceType === 'schedule' ? AGENT_SCHEDULE_QUEUE_KEY : AGENT_ROOM_KEY;
      if (request.type === 'stopAgentRoomJob') { await agentService.stopJob(await accountLessKey(request.jobId), request.jobId); await publishSnapshot(); return accepted(request.requestId); }
      if (request.type === 'retryAgentRoomJob') {
        if (!await agentService.retryJob(await accountLessKey(request.jobId), request.jobId)) return failure(request.requestId, JOB_NOT_RETRYABLE, JOB_NOT_RETRYABLE_MESSAGE);
        await publishSnapshot(); return accepted(request.requestId);
      }
      if (request.type === 'getAgentRoomJobEvents') {
        const events = await accountLessKey(request.jobId) === AGENT_SCHEDULE_QUEUE_KEY ? await agentService.getScheduleJobEvents(request.jobId) : await agentService.getRoomJobEvents(request.jobId);
        return { type: request.type, requestId: request.requestId, ok: true, events };
      }
      if (request.type === 'stopJob') { await agentService.stopJob(request, request.jobId); await publishSnapshot(); return accepted(request.requestId); }
      if (request.type === 'retryJob') {
        if (!await agentService.retryJob(request, request.jobId)) return failure(request.requestId, JOB_NOT_RETRYABLE, JOB_NOT_RETRYABLE_MESSAGE);
        await publishSnapshot(); return accepted(request.requestId);
      }
      if (request.type === 'newSession') { await agentService.resetChat(request); await publishSnapshot(); return accepted(request.requestId); }
      if (request.type === 'getJobEvents') return { type: request.type, requestId: request.requestId, ok: true, events: await agentService.getJobEvents(request, request.jobId) };
      if (request.type === 'searchMessages') {
        const input = request.query;
        const query: Parameters<MessageRepository['searchMessages']>[0] = { limit: input.limit,
          ...(input.key ? { key: input.key } : {}), ...(input.accountId ? { accountId: input.accountId } : {}), ...(input.scope ? { scope: input.scope } : {}),
          ...(input.senderId ? { senderId: input.senderId } : {}), ...(input.text !== undefined ? { text: input.text } : {}),
          ...(input.from ? { from: input.from } : {}), ...(input.to ? { to: input.to } : {}),
          ...(input.hasAttachment !== undefined ? { hasAttachment: input.hasAttachment } : {}),
          ...(input.attachmentKind ? { attachmentKind: input.attachmentKind } : {}) };
        return { type: request.type, requestId: request.requestId, ok: true, messages: await messages.searchMessages(query) };
      }
      if (request.type === 'searchAgentJobs') {
        const page = await health.searchAgentJobs(request.query);
        return { type: request.type, requestId: request.requestId, ok: true, ...page };
      }
      if (request.type === 'listMessages') { const page = await messages.listMessages(request, request.before, request.limit); return { type: request.type, requestId: request.requestId, ok: true, ...page }; }
      if (request.type === 'listAttachments') { const page = await messages.listAttachments(request, request.before, request.limit); return { type: request.type, requestId: request.requestId, ok: true, ...page }; }
      if (request.type === 'listChatNotes') return { type: request.type, requestId: request.requestId, ok: true,
        ...await chatResources.dispatchIpc(request, signal) };
      if (request.type === 'getChatNote') return { type: request.type, requestId: request.requestId, ok: true,
        ...await chatResources.dispatchIpc(request, signal) };
      if (request.type === 'listChatAlbums') return { type: request.type, requestId: request.requestId, ok: true,
        ...await chatResources.dispatchIpc({ ...request, refresh: request.refresh === true }, signal) };
      if (request.type === 'listChatAlbumPhotos') return { type: request.type, requestId: request.requestId, ok: true,
        ...await chatResources.dispatchIpc({ ...request, refresh: request.refresh === true }, signal) };
      if (request.type === 'downloadChatAlbumPhoto') return { type: request.type, requestId: request.requestId, ok: true,
        ...await chatResources.dispatchIpc(request, signal) };
      if (request.type === 'openChatAlbum') {
        const result = await chatResources.dispatchIpc(request, signal);
        return { type: request.type, requestId: request.requestId, ok: true, albumId: result.albumId, savedCount: result.savedCount,
          failedCount: result.failedCount, totalCount: result.totalCount, byteCount: result.byteCount, complete: result.complete,
          failureCodes: result.failureCodes, errorCode: result.errorCode,
          ...(result.failureContext ? { failureContext: result.failureContext } : {}) };
      }
      if (request.type === 'openReadableChatAlbumFolder') {
        const result = await chatResources.dispatchIpc(request, signal);
        const folder = await chatFolders.resolveExisting(request.accountId, request.chatType, request.chatId);
        if (!folder) return failure(request.requestId, 'CHAT_FOLDER_NOT_FOUND', '找不到這個聊天室資料夾。');
        const parent = path.join(folder.path, 'saved-albums', result.folderName);
        const open = options.openFolderPath ?? options.openAttachmentPath;
        const opened = open ? (await open(parent)) === '' : false;
        return { type: request.type, requestId: request.requestId, ok: true, albumId: result.albumId,
          exportedCount: result.exportedCount, failedCount: result.failedCount, totalCount: result.totalCount,
          complete: result.complete, failureCodes: result.failureCodes, folderName: result.folderName, opened };
      }
      if (request.type === 'getAutoResponderSettings') {
        return { type: request.type, requestId, ok: true, settings: await autoresponders.get() };
      }
      if (request.type === 'setAutoResponderSettings') {
        const version = await autoresponders.save(request.expectedVersion, {
          displayName: request.displayName, fallback: request.fallback, rules: request.rules,
        });
        return version === null
          ? failure(requestId, 'AUTORESPONDER_VERSION_CONFLICT', 'Autoresponder settings changed. Reload before saving.')
          : { type: request.type, requestId, ok: true, version };
      }
      if (request.type === 'setConversationAgent') {
        if (request.chatType !== 'direct' && request.enabled) return failure(requestId, 'ROOM_REQUIRES_CONFIRMATION', 'Group and room Agent access requires a primary-admin confirmation in that room.');
        await settings.setConversationAgent(request); await publishSnapshot(); return accepted(request.requestId);
      }
      if (request.type === 'setDefaultAgent') { await settings.setAppSetting('default_provider', request.provider); await publishSnapshot(); return accepted(request.requestId); }
      if (request.type === 'setWorkspace') { await workspace.configure(request.workspacePath); return accepted(request.requestId); }
      if (request.type === 'agentRefreshStatus') {
        const auth = await options.agent.agentRefreshStatus(request.provider);
        if (auth.status === 'error') options.audit?.failure({ ...diagnosticFailure('provider_auth', 'authenticate'), provider: request.provider });
        applyProviderAuthStatus(health, {provider:request.provider,...auth});
        await publishSnapshot();
        return accepted(request.requestId);
      }
      if (request.type === 'agentLogin' || request.type === 'agentLogout') {
        const action = request.type === 'agentLogin'
          ? request.provider === 'codex' ? 'agent_codex_login' : 'agent_claude_login'
          : request.provider === 'codex' ? 'agent_codex_logout' : 'agent_claude_logout';
        const correlationId = options.audit?.request(action, { initiator: 'user', requestId: request.requestId,
          reasonCode: 'operator_action' });
        let result: { ok: boolean; detail?: string };
        try {
          result = request.type === 'agentLogin' ? await options.agent.openLogin(request.provider) : await options.agent.logout(request.provider);
          if (correlationId) options.audit?.complete(correlationId, result.ok ? 'succeeded' : 'failed', result.ok
            ? { resultCode: 'agent_auth_action_completed' } : { errorCode: 'AGENT_AUTH_FAILED',
              diagnostic: { ...diagnosticFailure('provider_auth', 'authenticate'), provider: request.provider } });
        } catch (error) {
          if (correlationId) options.audit?.complete(correlationId, 'failed', { errorCode: 'AGENT_AUTH_FAILED',
            diagnostic: { ...diagnosticFailure('provider_auth', 'authenticate', error), provider: request.provider } });
          throw error;
        }
        const auth = await options.agent.getAuthStatus(request.provider);
        applyProviderAuthStatus(health, { provider: request.provider, ...auth });
        await publishSnapshot();
        return result.ok ? accepted(request.requestId) : failure(request.requestId, 'AGENT_AUTH_FAILED', result.detail ?? 'Agent 登入操作失敗。');
      }
      if (request.type === 'getChromeLoginAvailability') {
        const status = await options.chromeLogin?.ltsm.status().catch(() => null)
          ?? { kind: 'missing' as const, required: CHROME_EXTENSION_VERSION };
        return { type: 'getChromeLoginAvailability', requestId, ok: true, status };
      }
      if (request.type === 'detectChromeLtsm' || request.type === 'chooseChromeLtsmFolder') {
        if (!options.chromeLogin) return failure(requestId, 'CHROME_LOGIN_UNAVAILABLE', 'Chrome 登入在此環境不可用。');
        try {
          if (request.type === 'detectChromeLtsm') {
            return { type: 'detectChromeLtsm', requestId, ok: true, result: await options.chromeLogin.ltsm.detectAndInstall() };
          }
          const folder = await options.chromeLogin.chooseFolder();
          if (folder === null) return { type: 'chooseChromeLtsmFolder', requestId, ok: true, result: { kind: 'cancelled' } };
          return { type: 'chooseChromeLtsmFolder', requestId, ok: true, result: await options.chromeLogin.ltsm.installFromFolder(folder) };
        } catch (error) {
          options.audit?.failure({ ...diagnosticFailure('ipc', 'execute', error), ipcAction: request.type }, { requestId });
          return failure(requestId, 'CHROME_LTSM_INSTALL_FAILED', '無法讀取或複製 LINE Chrome 安全模組檔案。', true);
        }
      }
      if (request.type === 'openChromeExtensionStore') {
        if (!options.chromeLogin) return failure(requestId, 'CHROME_LOGIN_UNAVAILABLE', 'Chrome 登入在此環境不可用。');
        try { await options.chromeLogin.openStore(CHROME_EXTENSION_STORE_URL); }
        catch (error) {
          options.audit?.failure({ ...diagnosticFailure('ipc', 'execute', error), ipcAction: request.type }, { requestId });
          return failure(requestId, 'SERVICE_UNAVAILABLE', '無法開啟外部瀏覽器。', true);
        }
        return { type: 'openChromeExtensionStore', requestId, ok: true };
      }
      if (request.type === 'lineLoginQr') {
        try { return await reloginAccountWithQr(request.accountId, request.requestId, request.lineTransport); }
        catch (error) {
          options.audit?.failure({ ...diagnosticFailure('loginQr', 'dispatch', error), ipcAction: request.type }, { accountId: request.accountId, requestId: request.requestId });
          return failure(request.requestId, 'LINE_LOGIN_QR_START_FAILED', 'LINE QR 登入未能啟動，請重試。', true);
        }
      }
      if (request.type === 'lineReplaceAgentQr') {
        return await replaceAgentAccountWithQr(request.accountId, request.requestId, request.lineTransport);
      }
      if (request.type === 'lineAddAccountQr') {
        try { return await supervisor.runLifecycle(async () => {
        // Check the chosen login method before Main reserves a slot. A refused CHROMEOS login leaves no slot and no worker.
        const requestedBlock = await chromeLtsmBlock(request.lineTransport);
        if (requestedBlock) return chromeLtsmUnavailable(request.requestId, requestedBlock);
        const reserved = await accounts.reserveAccountSlot();
        if (request.lineTransport && await transportOf(reserved.accountId) !== request.lineTransport) {
          // Stop a worker that remains from the previous login method. Then store the chosen method.
          const leftover = await options.workers.binding(reserved.accountId);
          if (leftover) await stopAndClearWorkerBinding(reserved.accountId, 'user');
          await options.secretStore?.setTransport(reserved.accountId, request.lineTransport);
        }
        const slotBlock = await chromeLtsmBlock(await transportOf(reserved.accountId));
        if (slotBlock) return chromeLtsmUnavailable(request.requestId, slotBlock);
        const account = reserved;
        const binding = await options.workers.binding(account.accountId) ?? await startStoredAccount(account);
        await publishSnapshot();
        const loginAttemptId = randomUUID();
        loginAttempts.set(binding.accountId, loginAttemptId);
        options.publish?.({ type: 'lineLoginState', accountId: binding.accountId, loginAttemptId,
          state: 'connecting', message: null });
        try { await lineService.requestQrLogin(binding.accountId, binding.workerInstanceId, loginAttemptId); }
        catch (error) {
          if (loginAttempts.get(binding.accountId) === loginAttemptId) loginAttempts.delete(binding.accountId);
          await options.secretStore?.closeLogin(binding.accountId, binding.workerInstanceId, loginAttemptId).catch(() => undefined);
          options.audit?.failure(diagnosticFailure('loginQr', 'dispatch', error), { accountId: binding.accountId, loginAttemptId });
          options.publish?.({ type: 'lineLoginState', accountId: binding.accountId, loginAttemptId,
            state: 'degraded', message: 'LINE QR 登入啟動失敗' });
          await auditWorkerStop(binding, () => options.workers.stopBinding(binding)).catch(() => undefined);
          lineService.unbind(binding.workerInstanceId);
          if (supervisor.isCurrent(binding)) supervisor.retireWithinLifecycle(binding);
          const control = await accounts.getControlState().catch(() => null);
          if (control?.activeAccountId === binding.accountId) await supervisor.revokeControlAndCancel(control.controlEpoch).catch(() => undefined);
          await accounts.setConnectionStatus(binding.accountId, 'disconnected').catch(() => undefined);
          throw error;
        }
        return accepted(request.requestId);
        }); } catch (error) {
          options.audit?.failure({ ...diagnosticFailure('loginQr', 'dispatch', error), ipcAction: request.type }, { requestId: request.requestId });
          return failure(request.requestId, 'LINE_LOGIN_QR_START_FAILED', 'LINE QR 登入未能啟動，請重試。', true);
        }
      }
      if (request.type === 'lineSyncHistory') {
        if (isLocalAgentRoom(request)) return failure(request.requestId, 'LOCAL_ONLY', 'Agent 室沒有 LINE 歷史訊息。');
        const binding = await options.workers.binding(request.accountId);
        if (!binding) return failure(request.requestId, 'WORKER_UNAVAILABLE', 'LINE Worker 尚未啟動。', true);
        if (binding.mode === 'PAUSED') return failure(request.requestId, 'WORKER_PAUSED', 'LINE Worker 已暫停。', true);
        const { mode: _mode, ...lease } = binding;
        await options.workers.send({ type: 'history', ...lease, requestId: request.requestId,
          chatType: request.chatType, chatId: request.chatId, cursor: request.cursor, limit: request.limit });
        return accepted(request.requestId);
      }
      if (request.type === 'openAttachment') return { type: request.type, requestId: request.requestId, ok: true, opened: false };
      if (request.type === 'revealAttachment') return { type: request.type, requestId: request.requestId, ok: true, revealed: false };
      if (request.type === 'subscribeEvents') return accepted(request.requestId);
      if (request.type === 'mcpGetStatus') {
        return { type: request.type, requestId, ok: true, status: await mcpService.getStatus(mcpHttpServer.status()) };
      }
      if (request.type === 'mcpLocalClientStatus') {
        return { type: request.type, requestId, ok: true, clients: await mcpLocalClients.status() };
      }
      if (request.type === 'mcpLocalClientConnect') {
        const status = await mcpLocalClients.connect(request.client as LocalClientKind);
        return { type: request.type, requestId, ok: true, status };
      }
      if (request.type === 'mcpLocalClientDisconnect') {
        await mcpLocalClients.disconnect(request.client as LocalClientKind);
        return { type: request.type, requestId, ok: true };
      }
      if (request.type === 'mcpCallInternalTool') {
        const result = await mcpService.callInternalTool(request.tool, {
          sourceType: 'ui',
          requestId: request.requestId,
        });
        return { type: request.type, requestId, ok: true, result };
      }
      if (request.type === 'getAgentPermissions') {
        const state = await permissionRepository.getState(request.accountId);
        let workspaceRoot: string | null = null;
        try { workspaceRoot = await realpath(await workspace.current()); } catch { workspaceRoot = null; }
        const folders = [];
        for (const folder of state.folders) {
          const usage = await chatFolders.inspect(folder);
          folders.push({ folderId: folder.folderId, chatType: folder.chatType, chatId: folder.chatId, title: folder.title,
            fileCount: usage.fileCount, bytes: usage.bytes });
        }
        return { type: request.type, requestId, ok: true, view: {
          catalog: AGENT_PERMISSIONS.map((entry) => ({ ...entry })),
          defaults: state.defaults,
          subjects: state.subjects,
          rules: state.rules, links: state.links, folders, eligibleChats: state.eligibleChats, workspaceRoot } };
      }
      if (request.type === 'revokeAgentWhitelistUser') {
        const state = await permissionRepository.getState(request.accountId);
        if (!state.subjects.some((subject) => subject.mid === request.targetMid)) {
          return failure(requestId, 'INVALID_CHAT', '此使用者已沒有有效的 Agent 白名單資格。');
        }
        const revoked = await friendWhitelist.revokeAll(request.accountId, request.targetMid, 'operator');
        return { type: request.type, requestId, ok: true, revoked };
      }
      if (request.type === 'getAgentPermissionDefaults') {
        return { type: request.type, requestId, ok: true, defaults: await permissionRepository.getGlobalDefaults() };
      }
      if (request.type === 'setAgentPermissionDefault') {
        const { requestId: _requestId, type: _type, ...input } = request;
        const version = await permissionRepository.setGlobalDefault(input, 'operator');
        return { type: request.type, requestId, ok: true, version };
      }
      if (request.type === 'getAgentExecutionPolicy') {
        return { type: request.type, requestId, ok: true, policy: await permissionRepository.getExecutionPolicy() };
      }
      if (request.type === 'setAgentExecutionPolicy') {
        const { requestId: _requestId, type: _type, ...input } = request;
        const version = await permissionRepository.setExecutionPolicy(input, 'operator');
        publishExecutionPolicyChanged();
        return { type: request.type, requestId, ok: true, version };
      }
      if (request.type === 'decideAgentApproval') {
        // Main derives what is remembered from the pending record; the renderer only names the approval and decision.
        await approvalBroker.decide(request.approvalId, request.decision);
        return { type: request.type, requestId, ok: true };
      }
      if (request.type === 'listPendingAgentApprovals') {
        return { type: request.type, requestId, ok: true, approvals: approvalBroker.listPending() };
      }
      if (request.type === 'listAgentToolAllowlist') {
        return { type: request.type, requestId, ok: true, entries: await permissionRepository.listToolAllowlist() };
      }
      if (request.type === 'removeAgentToolAllowlistEntry') {
        await permissionRepository.removeToolAllowlistEntry(request.id, 'operator');
        return { type: request.type, requestId, ok: true };
      }
      if (request.type === 'clearAgentToolAllowlist') {
        await permissionRepository.clearToolAllowlist('operator');
        return { type: request.type, requestId, ok: true };
      }
      if (request.type === 'setAgentPermission') {
        // Local operator UI only: this IPC surface is never reachable from LINE or an MCP principal.
        const { requestId: _requestId, type: _type, ...input } = request;
        return { type: request.type, requestId, ok: true, version: await permissionRepository.setPermission(input, 'operator') };
      }
      if (request.type === 'setAgentFolderLink') {
        const { requestId: _requestId, type: _type, ...input } = request;
        return { type: request.type, requestId, ok: true, version: await permissionRepository.setFolderLink(input, 'operator') };
      }
      if (request.type === 'createChatFolder') {
        const { folder, path } = await chatFolders.resolve(request.accountId, request.chatType, request.chatId, 'operator');
        const usage = await chatFolders.stats(path);
        return { type: request.type, requestId, ok: true, folder: { folderId: folder.folderId, chatType: folder.chatType,
          chatId: folder.chatId, title: folder.title, fileCount: usage.fileCount, bytes: usage.bytes } };
      }
      if (request.type === 'openChatFolder') {
        const row = await permissionRepository.getChatFolder(request.folderId);
        if (!row) return failure(requestId, 'CHAT_FOLDER_NOT_FOUND', '找不到這個資料夾。');
        const { path } = await chatFolders.resolve(row.accountId, row.chatType, row.chatId, 'operator');
        const open = options.openFolderPath ?? options.openAttachmentPath;
        return { type: request.type, requestId, ok: true, opened: open ? (await open(path)) === '' : false };
      }
      if (request.type === 'getAgentExtensions') {
        return { type: request.type, requestId, ok: true, extensions: await agentExtensions.state() };
      }
      if (request.type === 'saveAgentMcpServer' || request.type === 'deleteAgentMcpServer' || request.type === 'setAgentMcpServerEnabled'
        || request.type === 'setAgentExtensionTools' || request.type === 'listAgentMcpImportCandidates' || request.type === 'importAgentMcpServers') {
        try {
          if (request.type === 'saveAgentMcpServer') return { type: request.type, requestId, ok: true, server: await agentExtensions.save(request.server) };
          if (request.type === 'deleteAgentMcpServer') { await agentExtensions.delete(request.serverId); return { type: request.type, requestId, ok: true }; }
          if (request.type === 'setAgentMcpServerEnabled') return { type: request.type, requestId, ok: true, server: await agentExtensions.setEnabled(request.serverId, request.enabled) };
          if (request.type === 'setAgentExtensionTools') return { type: request.type, requestId, ok: true, tools: await agentExtensions.setTools(request.tools) };
          if (request.type === 'listAgentMcpImportCandidates') return { type: request.type, requestId, ok: true, listing: await agentExtensions.listImportCandidates() };
          return { type: request.type, requestId, ok: true, result: await agentExtensions.importSelected(request.items) };
        } catch (error) {
          if (error instanceof AgentExtensionsServiceError) return failure(requestId, `AGENT_EXTENSION_${error.code}`, error.message);
          throw error;
        }
      }
      if (request.type === 'listAgentSchedules') {
        return { type: request.type, requestId, ok: true, schedules: await agentSchedules.list() };
      }
      if (request.type === 'createAgentSchedule') {
        return { type: request.type, requestId, ok: true, schedule: await agentSchedules.create(request.schedule) };
      }
      if (request.type === 'updateAgentSchedule') {
        return { type: request.type, requestId, ok: true, schedule: await agentSchedules.update(request.scheduleId, request.patch) };
      }
      if (request.type === 'deleteAgentSchedule') {
        if (!await agentSchedules.delete(request.scheduleId)) return failure(requestId, 'SCHEDULE_NOT_FOUND', '找不到這個排程。');
        return { type: request.type, requestId, ok: true };
      }
      if (request.type === 'listAgentScheduleRuns') {
        return { type: request.type, requestId, ok: true, runs: await agentSchedules.listRuns(request.scheduleId, request.limit) };
      }
      if (request.type === 'previewAgentScheduleNewMessages') {
        return { type: request.type, requestId, ok: true, preview: await agentSchedules.previewNewMessages(request.preview) };
      }
      if (request.type === 'listAgentScheduleTargets') {
        return { type: request.type, requestId, ok: true, targets: await agentSchedules.listTargets(request.query || undefined, request.limit, request.purpose) };
      }
      return failure(requestId, 'UNSUPPORTED_REQUEST', '此操作尚未支援。');
    } catch (error) {
      if (error instanceof AgentPermissionError) return failure(requestId, error.code, error.message);
      if (error instanceof AgentApprovalBrokerError) {
        return failure(requestId, error.code, error.code === 'APPROVAL_NOT_PENDING' ? '這項核可已結束或不存在。' : '這個命令太長，無法記住，只能允許一次或拒絕。');
      }
      if (error instanceof ChatFolderError) return failure(requestId, error.code, error.message);
      if (error instanceof ChatResourceUnsupportedError) return failure(requestId, error.code, error.message);
      if (error instanceof AgentScheduleError) {
        return failure(requestId, error.code, error.code === 'SCHEDULE_NOT_FOUND' ? '找不到這個排程。'
          : error.code === 'SCHEDULE_LIMIT' ? '啟用中的排程最多 50 個。'
          : error.code === 'SCHEDULE_INVALID_TARGET' ? '找不到指定的聊天室，或這個聊天室不能使用。'
          : error.code === 'SCHEDULE_INVALID' ? error.message : '這個排程沒有未來的觸發時間。');
      }
      if (error instanceof InvalidWorkspaceError) return failure(requestId, error.code, error.message);
      if (error instanceof McpDomainError) return failure(requestId, error.code, error.message);
      if (error instanceof LocalMcpConfigError) return failure(requestId, error.code, error.message);
      if (signal?.aborted && (error === signal.reason || (error instanceof Error && error.name === 'AbortError')))
        return failure(requestId, 'CANCELLED', 'Chat resource request cancelled');
      options.audit?.failure({ ...diagnosticFailure('ipc', 'execute', error), ipcAction: request.type }, { requestId, initiator: 'user' });
      return failure(requestId, 'SERVICE_ERROR', 'The operation failed. See System Errors for diagnostic details.', true);
    }
  }


  if (options.secretStore) {
    for (const account of await accounts.listAuthenticatedAccounts()) {
      if (account.autoLoginOnStartup !== true) {
        await accounts.setConnectionStatus(account.accountId, 'disconnected');
        continue;
      }
      const owner = await accounts.getControlState();
      if ((owner.activeAccountId && owner.activeAccountId !== account.accountId && account.productRole === 'AGENT')
        || (owner.activeAccountId === account.accountId && account.productRole !== 'AGENT')) continue;
      const saved = await options.secretStore.load(account.accountId, await transportOf(account.accountId));
      if (!saved?.token) {
        await accounts.setConnectionStatus(account.accountId, 'disconnected');
        continue;
      }
      const failed = await attemptStartupAutoLogin(account);
      if (failed?.retryable) scheduleStartupAutoLoginRetry(account);
    }
  }
  await attachmentService.recover();

  type ReadState<T> = { available: boolean; partial: boolean; value: T };
  type SystemSnapshotState = {
    audit: ReadState<AuditEventsReadResult['events']>;
    attachments: ReadState<Awaited<ReturnType<MessageRepository['listAttachmentActivity']>>>;
    terminalAttachments: ReadState<Awaited<ReturnType<MessageRepository['listTerminalAttachmentErrors']>>>;
  };
  const systemSnapshot = createSingleFlightRead<SystemSnapshotState>({
    createState: () => ({
      audit: { available: false, partial: true, value: [] },
      attachments: { available: false, partial: false, value: [] },
      terminalAttachments: { available: false, partial: false, value: [] },
    }),
    timeoutMs: 5000,
    start: async (state) => {
      const updateAudit = (result: AuditEventsReadResult) => {
        state.audit = { available: result.available, partial: result.partial, value: result.events };
      };
      const auditRead = options.audit?.listEvents
        ? options.audit.listEvents(500, updateAudit).then(updateAudit, () => updateAudit({ events: [], available: false, partial: true }))
        : Promise.resolve(updateAudit({ events: [], available: false, partial: true }));
      const attachmentRead = messages.listAttachmentActivity(100).then((value) => {
        state.attachments = { available: true, partial: false, value };
      }, () => { state.attachments = { available: false, partial: false, value: [] }; });
      const terminalRead = messages.listTerminalAttachmentErrors(100, conversationSettings.attachmentAutoAttemptLimit).then((value) => {
        state.terminalAttachments = { available: true, partial: false, value };
      }, () => { state.terminalAttachments = { available: false, partial: false, value: [] }; });
      await Promise.all([auditRead, attachmentRead, terminalRead]);
    },
    drain: async () => {
      await Promise.all([messages.waitForReadDrain(), options.audit?.waitForReadDrain?.()]);
    },
  });

  const facade: DesktopServiceFacade = {
    dispatch: (request, signal) => {
      if (closing) return Promise.resolve(failure(request.requestId, 'SERVICE_CLOSING', 'Service is closing.'));
      if (request.type !== 'sendManualMedia') return track(() => dispatch(request, signal),
        { operation: 'ipc', identity: { requestId: request.requestId,
          ...('accountId' in request && typeof request.accountId === 'string' ? { accountId: request.accountId } : {}) } });
      if (signal?.aborted) return Promise.resolve(failure(request.requestId, 'LINE_SEND_NOT_STARTED', 'LINE attachment send was cancelled before admission.'));
      const lease = manualMediaAdmission.acquire(request.accountId, signal);
      if (!lease) return Promise.resolve(failure(request.requestId, 'LINE_MEDIA_BUSY', 'Another attachment send is active or the media send limit is full.'));
      return track(() => dispatch(request, lease.signal),
        { operation: 'ipc', identity: { requestId: request.requestId, accountId: request.accountId } }).finally(() => lease.release());
    },
    async openAttachment(attachmentId, senderId = -1) {
      if (closing) return false;
      return attachmentOpenService?.open(attachmentId, { senderId }) ?? false;
    },
    async downloadAttachment(key: import('@line-agent/contracts').WritableConversationKey, attachmentId: string) {
      if (closing) return false;
      return await track(() => attachmentService.downloadManually(key, attachmentId),
        { operation: 'attachment', identity: { accountId: key.accountId } });
    },
    async handleLineMedia(target, signal) {
      const serve = (source: import('./line-media.js').LineMediaSource | null) => lineMedia.handle(source, signal);
      if (target.type === 'sticon') {
        const stored = await options.pool.query<{ raw: unknown; text_content: string | null }>(
          `SELECT text_content,${boundedSticonRawSql()} raw
           FROM messages WHERE account_id=$1 AND chat_type=$2 AND chat_id=$3 AND message_id=$4`,
          [target.accountId, target.chatType, target.chatId, target.messageId]);
        const raw = stored.rows[0]?.raw;
        if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return serve(null);
        const rawRecord = raw as Record<string, unknown>;
        const range = projectSticons(rawRecord, stored.rows[0]?.text_content ?? null)[target.index];
        if (!range) return serve(null);
        return serve(lineMedia.sticonSource(range.resource.productId, range.resource.sticonId, range.resource.animated));
      }
      if (target.type === 'reaction') {
        // Paid reaction icon: only when the stored native row really holds that reaction; same sticon source and disk cache.
        const stored = await options.pool.query<{ row: unknown }>(
          `SELECT raw #> '{native,row}' AS row FROM messages WHERE account_id=$1 AND chat_type=$2 AND chat_id=$3 AND message_id=$4`,
          [target.accountId, target.chatType, target.chatId, target.messageId]);
        const present = nativeReactions({ native: { row: stored.rows[0]?.row } })
          .some((group) => group.kind === 'PAID' && group.productId === target.productId && group.emojiId === target.emojiId);
        return serve(present ? lineMedia.sticonSource(target.productId, target.emojiId, false) : null);
      }
      if (target.type === 'sticker') {
        const stored = await options.pool.query<{ kind: string; raw: unknown }>(
          'SELECT kind,raw FROM messages WHERE account_id=$1 AND chat_type=$2 AND chat_id=$3 AND message_id=$4',
          [target.accountId, target.chatType, target.chatId, target.messageId]);
        const row = stored.rows[0];
        // A recalled sticker is displayed from its preserved pre-recall envelope (raw.recall.original).
        const rawRecord = typeof row?.raw === 'object' && row.raw !== null ? row.raw as { recall?: { original?: unknown } } : null;
        const sticker = (row?.kind === 'sticker' ? parseLineStickerDescriptor(row.raw) : null)
          ?? (rawRecord?.recall?.original ? parseLineStickerDescriptor({ native: rawRecord.recall.original }) : null);
        if (!sticker) return serve(null);
        return serve(lineMedia.stickerSource(sticker.stickerId, sticker.animated));
      }
      if (target.type === 'attachment') {
        const item = await messages.getAttachment(target.attachmentId);
        if (!item || item.accountId !== target.accountId || item.chatType !== target.chatType || item.chatId !== target.chatId
          || item.kind !== 'image' || item.status !== 'ready') return serve(null);
        return serve(lineMedia.attachmentSource(target.attachmentId, target));
      }
      if (target.type === 'albumPhoto') return serve(lineMedia.albumPhotoSource(target.albumId, target.photoId, target));
      let result: { rows: Array<{ picture_path: string | null }> };
      if (target.type === 'account') {
        result = await options.pool.query('SELECT picture_path FROM line_accounts WHERE account_id=$1 AND own_mid IS NOT NULL', [target.accountId]);
      } else if (target.type === 'conversation') {
        result = await options.pool.query(`SELECT ${CONVERSATION_PICTURE_SQL} picture_path FROM conversations c JOIN line_accounts la ON la.account_id=c.account_id ${PEER_CONTACT_JOIN} WHERE c.account_id=$1 AND c.chat_type=$2 AND c.chat_id=$3`,
          [target.accountId, target.chatType, target.chatId]);
      } else {
        result = await options.pool.query(`SELECT ${senderPictureSql({ m: 'm', la: 'la', c: 'c', cm: 'cm', senderContact: 'sender_contact', peerContact: 'peer_contact' })} picture_path
          FROM (SELECT $2::text chat_type,$4::text sender_id) m JOIN line_accounts la ON la.account_id=$1
          JOIN conversations c ON c.account_id=$1 AND c.chat_type=$2 AND c.chat_id=$3
          LEFT JOIN conversation_members cm ON cm.account_id=$1 AND cm.chat_type=$2 AND cm.chat_id=$3 AND cm.member_id=$4
          LEFT JOIN line_contacts sender_contact ON sender_contact.account_id=$1 AND sender_contact.mid=$4
          LEFT JOIN line_contacts peer_contact ON peer_contact.account_id=$1 AND c.chat_type='direct' AND peer_contact.mid=c.chat_id`,
          [target.accountId, target.chatType, target.chatId, target.memberId]);
      }
      const picturePath = result.rows[0]?.picture_path;
      return serve(picturePath ? lineMedia.avatarSource(picturePath) : null);
    },
    async listMessages(key, cursor, limit, exactMessageId) {
      const page = exactMessageId
        ? { messages: [await messages.getMessage(key, exactMessageId)].filter((item): item is NonNullable<typeof item> => item !== null), nextCursor: null }
        : await messages.listMessages(key, cursor, limit);
      // External-monitor accounts mirror LINE's own unread count; opening a chat here must not clear it.
      if (cursor === null && !exactMessageId && (await accounts.resolveCapabilities(key.accountId))?.connectionMode !== 'EXTERNAL_MONITOR') {
        await messages.markConversationRead(key);
      }
      const sticonRows = page.messages.length ? await options.pool.query<{ message_id: string; raw: unknown; text_content: string | null }>(
        `SELECT message_id,text_content,${boundedSticonRawSql()} raw
         FROM messages WHERE account_id=$1 AND chat_type=$2 AND chat_id=$3 AND message_id=ANY($4::text[]) LIMIT 100`,
          [key.accountId, key.chatType, key.chatId, page.messages.slice(0, 100).map((item) => item.messageId)]) : { rows: [] };
      const sticonsById = new Map(sticonRows.rows.map((row) => {
        const raw = row.raw && typeof row.raw === 'object' && !Array.isArray(row.raw) ? row.raw as Record<string, unknown> : {};
        return [row.message_id, projectSticons(raw, row.text_content)] as const;
      }));
      const details = page.messages.length ? await options.pool.query<{
        message_id: string; reply_to_message_id: string | null; sender_id: string; own_mid: string | null; is_own: boolean;
        resolved_sender_name: string | null;
        reply_message_id: string | null; reply_sender_id: string | null; reply_own_mid: string | null; reply_is_own: boolean;
        reply_sender_name: string | null; reply_sender_picture_path: string | null; reply_conversation_picture_path: string | null;
        reply_account_picture_path: string | null;
        reply_text: string | null; reply_kind: string | null;
        sender_picture_path: string | null; account_picture_path: string | null;
        attachments: Array<{ id: string; kind: 'image' | 'video' | 'audio' | 'file'; name: string; mimeType: string | null; sizeBytes: number | null; status: string; canRetryManually: boolean; blockReason?: string | null }>;
      }>(`SELECT m.message_id,m.reply_to_message_id,m.sender_id,la.own_mid,
          ${ownMessageSql('m', 'la')} AS is_own,
          ${SENDER_NAME_SQL} resolved_sender_name,
          rd.message_id reply_message_id,rd.sender_id reply_sender_id,rd.own_mid reply_own_mid,rd.is_own reply_is_own,
          rd.sender_name reply_sender_name,rd.sender_picture_path reply_sender_picture_path,
          rd.conversation_picture_path reply_conversation_picture_path,
          rd.account_picture_path reply_account_picture_path,rd.text_content reply_text,rd.kind reply_kind,
          ${SENDER_PICTURE_SQL} sender_picture_path,la.picture_path account_picture_path,
          COALESCE(jsonb_agg(jsonb_build_object('id',a.attachment_id,'kind',a.kind,'name',COALESCE(NULLIF(BTRIM(a.name), ''), ''),
            'mimeType',COALESCE(a.mime_type,'application/octet-stream'),'sizeBytes',COALESCE(a.size_bytes,0),
            'status',CASE WHEN a.status <> 'ready' AND m.occurred_at < now() - interval '7 days'
                AND EXISTS (SELECT 1 FROM message_source_provenance p WHERE p.account_id=a.account_id
                  AND p.message_id=a.message_id AND p.origin='EXTERNAL_MONITOR') THEN 'expired'
              WHEN a.status='failed' AND a.retry_count < $5 AND a.retry_after IS DISTINCT FROM 'infinity'::timestamptz
                AND NOT EXISTS (SELECT 1 FROM message_source_provenance p WHERE p.account_id=a.account_id
                  AND p.message_id=a.message_id AND p.origin='EXTERNAL_MONITOR') THEN 'queued' ELSE a.status END,
            'blockReason',CASE WHEN a.status='queued' AND a.error = ANY($6::text[]) THEN a.error END,
            'canRetryManually',la.status='connected' AND (m.occurred_at >= now() - interval '7 days' OR NOT EXISTS (SELECT 1 FROM message_source_provenance p
                WHERE p.account_id=a.account_id AND p.message_id=a.message_id AND p.origin='EXTERNAL_MONITOR'))
              AND (a.status='expired' OR (a.status='failed' AND (a.retry_count >= $5 OR a.retry_after='infinity'::timestamptz
                OR EXISTS (SELECT 1 FROM message_source_provenance p WHERE p.account_id=a.account_id
                  AND p.message_id=a.message_id AND p.origin='EXTERNAL_MONITOR')))
                OR (a.status='queued' AND EXISTS (SELECT 1 FROM message_source_provenance p WHERE p.account_id=a.account_id
                  AND p.message_id=a.message_id AND p.origin='EXTERNAL_MONITOR')))))
            FILTER (WHERE a.attachment_id IS NOT NULL),'[]'::jsonb) attachments
        FROM messages m JOIN line_accounts la ON la.account_id=m.account_id
        JOIN conversations c ON c.account_id=m.account_id AND c.chat_type=m.chat_type AND c.chat_id=m.chat_id
        LEFT JOIN conversation_members cm ON cm.account_id=m.account_id AND cm.chat_type=m.chat_type
          AND cm.chat_id=m.chat_id AND cm.member_id=m.sender_id
        ${SENDER_CONTACT_JOIN}
        ${PEER_CONTACT_JOIN}
        LEFT JOIN LATERAL (
          SELECT qm.message_id,qm.sender_id,qla.own_mid,${ownMessageSql('qm', 'qla')} AS is_own,${REPLY_SENDER_NAME_SQL} sender_name,
            ${REPLY_SENDER_PICTURE_SQL} sender_picture_path,${conversationPictureSql({ c: 'qc', la: 'qla', peerContact: 'quoted_peer_contact' })} conversation_picture_path,
            qla.picture_path account_picture_path,qm.text_content,qm.kind
          FROM messages qm
          JOIN line_accounts qla ON qla.account_id=qm.account_id
          JOIN conversations qc ON qc.account_id=qm.account_id AND qc.chat_type=qm.chat_type AND qc.chat_id=qm.chat_id
          LEFT JOIN conversation_members qcm ON qcm.account_id=qm.account_id AND qcm.chat_type=qm.chat_type
            AND qcm.chat_id=qm.chat_id AND qcm.member_id=qm.sender_id
          LEFT JOIN line_contacts quoted_sender_contact ON quoted_sender_contact.account_id=qm.account_id AND quoted_sender_contact.mid=qm.sender_id
          LEFT JOIN line_contacts quoted_peer_contact ON quoted_peer_contact.account_id=qc.account_id
            AND qc.chat_type='direct' AND quoted_peer_contact.mid=qc.chat_id
          WHERE qm.account_id=m.account_id AND qm.chat_type=m.chat_type AND qm.chat_id=m.chat_id
            AND qm.message_id=m.reply_to_message_id
          LIMIT 1
        ) rd ON true
        LEFT JOIN attachments a ON a.account_id=m.account_id AND a.chat_type=m.chat_type AND a.chat_id=m.chat_id AND a.message_id=m.message_id
        WHERE m.account_id=$1 AND m.chat_type=$2 AND m.chat_id=$3 AND m.message_id=ANY($4::text[])
        GROUP BY m.message_id,m.reply_to_message_id,m.sender_id,m.chat_type,cm.picture_path,la.picture_path,c.picture_path,
          sender_contact.picture_path,peer_contact.picture_path,
          rd.message_id,rd.sender_id,rd.own_mid,rd.sender_name,rd.sender_picture_path,rd.conversation_picture_path,rd.account_picture_path,rd.text_content,rd.kind,
          ${ownMessageSql('m', 'la')},rd.is_own,
          ${NAME_RESOLUTION_GROUP_COLUMNS}`,
      [key.accountId, key.chatType, key.chatId, page.messages.map((item) => item.messageId), conversationSettings.attachmentAutoAttemptLimit, [...ATTACHMENT_BLOCK_REASONS]]) : { rows: [] };
      const byId = new Map(details.rows.map((row) => [row.message_id, row]));
      const agentStatuses = new Map<string, { jobId: string; status: 'queued' | 'running' | 'completed' | 'failed' | 'cancelled' | 'interrupted'; revision: string }>();
      if (page.messages.length) {
        try {
          const jobs = await options.pool.query<{ job_id: string; source_message_id: string; status: 'queued' | 'running' | 'completed' | 'failed' | 'cancelled' | 'interrupted'; revision: string }>(
            `SELECT DISTINCT ON (source_message_id) job_id, source_message_id, status, ((extract(epoch FROM updated_at) * 1000000)::numeric(20,0))::text AS revision FROM agent_jobs WHERE account_id=$1 AND chat_type=$2 AND chat_id=$3
             AND source_type='line' AND source_message_id=ANY($4::text[]) ORDER BY source_message_id,(retry_of_job_id IS NOT NULL) DESC,updated_at DESC`,
            [key.accountId, key.chatType, key.chatId, page.messages.map((item) => item.messageId)]);
          for (const job of jobs.rows) agentStatuses.set(job.source_message_id, { jobId: job.job_id, status: job.status, revision: job.revision });
        } catch { /* Agent projection is optional; message detail must remain available. */ }
      }
      const timeline: TimelineMessage[] = page.messages.map((item) => { const detail = byId.get(item.messageId);
        const outbound = detail?.is_own === true;
        // Display-only original recovered from the stored pre-recall envelope; never written back to `content`.
        const recalledBridge = item.recallOriginal ? bridgeNativeEnvelope(item.recallOriginal) : null;
        const recalledText = item.recallOriginal ? nativeMessageText(item.recallOriginal) : null;
        const recalledSticker = item.recallOriginal && recalledBridge?.kind === 'sticker' ? parseLineStickerDescriptor({ native: item.recallOriginal }) : null;
        const { sourceDeleted: _sourceDeleted, recallOriginal: _recallOriginal, reactions: itemReactions, ...visible } = item;
        return ({ ...visible, text: item.text?.trim() || !recalledText ? item.text : recalledText, sticonRanges: (sticonsById.get(item.messageId) ?? []).map(({ start, end, resource }) => ({ ...resource, start, end })), senderName: detail?.resolved_sender_name ?? item.senderId,
        kind: item.kind, sticker: item.sticker ?? recalledSticker,
        agentJobStatus: agentStatuses.get(item.messageId)?.status ?? null,
        agentJobId: agentStatuses.get(item.messageId)?.jobId ?? null,
        agentJobRevision: agentStatuses.get(item.messageId)?.revision ?? null,
        senderAvatarAvailable: outbound ? Boolean(detail?.account_picture_path) : Boolean(detail?.sender_picture_path),
        replyTo: detail?.reply_message_id ? (() => {
          const replyOutbound = detail.reply_is_own === true;
          const textPreview = detail.reply_text?.trim();
          const previewCharacters = textPreview ? Array.from(textPreview) : [];
          return { messageId: detail.reply_message_id, senderId: detail.reply_sender_id!,
            senderName: detail.reply_sender_name ?? detail.reply_sender_id!, direction: replyOutbound ? 'outbound' as const : 'inbound' as const,
            senderAvatarAvailable: replyOutbound ? Boolean(detail.reply_account_picture_path)
              : key.chatType === 'direct' ? Boolean(detail.reply_conversation_picture_path) : Boolean(detail.reply_sender_picture_path),
            preview: textPreview ? (previewCharacters.length > 80 ? `${previewCharacters.slice(0, 79).join('')}…` : textPreview) : kindPreview(detail.reply_kind) ?? '訊息內容',
            ...(!textPreview ? { display: { kind: (['sticker', 'image', 'video', 'audio', 'file', 'contact', 'location'].includes(detail.reply_kind ?? '') ? detail.reply_kind : 'message') as import('@line-agent/contracts').GeneratedPreview['kind'] } } : {}) };
        })() : null,
        direction: outbound ? 'outbound' : 'inbound', replyToMessageId: detail?.reply_to_message_id ?? null,
        deleted: item.content?.type === 'unsent' || item.sourceDeleted, deletedAtSource: item.sourceDeleted,
        ...(outbound && (item.readCount ?? 0) > 0 ? { readCount: Math.min(item.readCount!, MESSAGE_READER_LIMIT) } : {}),
        ...(itemReactions && itemReactions.length > 0 ? { reactions: itemReactions.slice(0, 20).map((group) => ({ kind: group.kind,
          ...(group.productId ? { productId: group.productId } : {}), ...(group.emojiId ? { emojiId: group.emojiId } : {}),
          count: Math.min(group.count, 10000), reactorNames: group.reactorNames.slice(0, 50).map((name) => name.slice(0, 100)) })) } : {}),
        recalledContent: recalledBridge?.content?.type === 'unsent' ? null : recalledBridge?.content ?? null,
        recalledKind: recalledBridge?.kind ?? null, recalledText, attachments: (detail?.attachments ?? []).map((attachment) => ({ id: attachment.id, kind: attachment.kind, name: attachment.name,
          mimeType: attachment.mimeType ?? 'application/octet-stream', sizeBytes: Number(attachment.sizeBytes ?? 0), status: attachment.status,
          canRetryManually: attachment.canRetryManually,
          ...(isAttachmentBlockReason(attachment.blockReason) ? { blockReason: attachment.blockReason } : {}) })) }); });
      return { messages: timeline, olderCursor: page.nextCursor };
    },
    async listChatNotes(key, cursor) { return chatResources.listNotes(key, cursor); },
    async getChatNote(key, postId) { return chatResources.getNote(key, postId); },
    async listChatAlbums(key, cursor, refresh) { return chatResources.listAlbums(key, cursor, undefined, 'modal', undefined, refresh); },
    async listChatAlbumPhotos(key, albumId, cursor, refresh) { return chatResources.listAlbumPhotos(key, albumId, cursor, undefined, refresh); },
    async downloadChatAlbumPhoto(key, albumId, photoId, oid, prefix) { return chatResources.downloadAlbumPhoto(key, albumId, photoId, oid, prefix); },
    async openChatAlbum(key, albumId, signal) { return chatResources.openAlbum(key, albumId, signal); },
    async openReadableChatAlbumFolder(key, albumId, signal) { return chatResources.openReadableAlbumFolder(key, albumId, signal); },
    async listAttachmentStates(key, attachmentIds) {
      return messages.listAttachmentStates(key, attachmentIds, conversationSettings.attachmentAutoAttemptLimit);
    },
    async listAgentStatuses(key, messageIds) {
      if (!isWritableChatType(key.chatType)) return [];
      const rows = await agents.listLineJobStatus({ ...key, chatType: key.chatType }, messageIds);
      return rows.filter((row): row is typeof row & { sourceMessageId: string } => row.sourceMessageId !== null)
        .map((row) => ({ messageId: row.sourceMessageId, jobId: row.jobId, status: row.status, revision: row.revision }));
    },
    async listWorkRecords() {
      const result = await options.pool.query<{ work_record_id: string; title: string; status: WorkRecord['status']; account_id: string; chat_type: WorkRecord['key']['chatType']; chat_id: string; updated_at: Date }>(
        "SELECT work_record_id,title,'todo'::text AS status,account_id,chat_type,chat_id,updated_at FROM work_records WHERE account_id IS NOT NULL ORDER BY updated_at DESC LIMIT 100");
      return result.rows.map((row) => ({ id: row.work_record_id, title: row.title, status: row.status,
        key: { accountId: row.account_id, chatType: row.chat_type, chatId: row.chat_id }, messageIds: [], attachmentIds: [], updatedAt: row.updated_at.toISOString() }));
    },
    async listFriends(accountId) {
      // LINE ContactStatus 1 = FRIEND. Name rule matches the chat list: nickname, then profile name (then the stored chat title).
      const result = await options.pool.query<{ mid: string; name: string; avatar_available: boolean; has_conversation: boolean }>(
        `SELECT lc.mid, COALESCE(NULLIF(lc.nickname, ''), NULLIF(lc.display_name, ''), NULLIF(c.title, ''), '') AS name,
           (COALESCE(lc.picture_path, '') <> '') AS avatar_available, (c.chat_id IS NOT NULL) AS has_conversation
         FROM line_contacts lc
         LEFT JOIN conversations c ON c.account_id = lc.account_id AND c.chat_type = 'direct' AND c.chat_id = lc.mid
         WHERE lc.account_id = $1 AND lc.native_status = 1
         ORDER BY name, lc.mid LIMIT ${FRIEND_LIST_LIMIT}`, [accountId]);
      return result.rows.map((row) => ({ mid: row.mid, name: row.name, avatarAvailable: row.avatar_available, hasConversation: row.has_conversation }));
    },
    async listMessageReaders(key, messageId) {
      return { readers: await messages.listMessageReaders(key, messageId, { limit: MESSAGE_READER_LIMIT }) };
    },
    async listSystemActivity() {
      const state = await systemSnapshot();
      return systemActivityResult(state.audit, state.attachments);
    },
    async listSystemErrors() {
      const state = await systemSnapshot();
      return systemErrorsResult({ ...state.audit, events: state.audit.value }, state.terminalAttachments);
    },
    async controlState() {
      const state = await accounts.getControlState();
      const pending = await options.pool.query<{ count: string }>("SELECT count(*) FROM agent_deliveries WHERE status IN ('pending','sending')");
      return { activeAccountId: state.activeAccountId, epoch: state.controlEpoch, pendingOutbound: Number(pending.rows[0]?.count ?? 0) };
    },
    shutdown() {
      closing = true;
      manualMediaAdmission.shutdown();
      return shutdownPromise ??= (async () => {
        const errors: unknown[] = [];
        externalImportOwner?.abort.abort();
        identityReadAbort?.abort();
        const collect = (results: PromiseSettledResult<unknown>[]) => {
          for (const result of results) if (result.status === 'rejected') errors.push(result.reason);
        };
        const synchronousCleanup = [
          () => albumDispatcher.shutdown(),
          () => chatResources.shutdown(),
          () => ownAvatarRefreshScheduler?.shutdown(),
          () => { for (const timer of recoveryTimers) clearTimeout(timer); recoveryTimers.clear(); },
          // Before AgentService shuts down: no schedule may submit a job into a closing Agent service.
          stopAgentSchedules,
          () => unsubscribeAuth?.(), () => unsubscribeWorkerExit?.(), () => unsubscribeEvent?.(),
          () => unsubscribeBinding?.(), () => unsubscribeRestartBinding?.(), () => unsubscribeModeChange?.(),
          stopPublishSnapshot, stopLineMedia, stopPreview, stopContentReprojection,
        ];
        collect(await Promise.allSettled(synchronousCleanup.map((cleanup) => Promise.resolve().then(cleanup))));
        // Invoke every owner before awaiting any of them so admission remains closed.
        const owners = Promise.allSettled([
          () => lineService.shutdownIngress(), () => permissionCommands.close(), () => options.agent.shutdown(),
          () => options.workers.shutdown(), stopAgentService,
          stopDelivery, stopLineSend, stopAttachmentService, stopMcpHttpServer, stopMcpService,
        ].map((cleanup) => Promise.resolve().then(cleanup)));
        while (inFlight.size) await Promise.allSettled([...inFlight]);

        collect(await owners);
        errors.push(...await runCleanupInOrder([
          () => lineService.idleRoomEffects(),
          () => options.audit?.flush(),
          ...(options.closePoolOnShutdown ? [() => options.pool.end()] : []),
        ]));
        if (errors.length) throw new AggregateError(errors, 'Desktop shutdown encountered cleanup errors');
      })();
    },
  };
  await probeInitialProviderAuth({getAuthStatus: provider => options.agent.getAuthStatus(provider),
    report: status => health.setProviderAuthStatus(status.provider,{status:status.status,detail:status.detail})});
  await options.beforeMcpListen?.();
  await mcpHttpServer.start();
  await agentService.recoverQueued();
  await freeMode.start().catch((error: unknown) => { options.audit?.failure(diagnosticFailure('agent', 'execute', error)); });
  await agentSchedules.start().catch((error: unknown) => { options.audit?.failure(diagnosticFailure('agent', 'execute', error)); });
  void track(() => resumeExternalMonitorOnStartup(), { operation: 'external_monitor', identity: { background: true }, reportFailure: false })
    .catch((error: unknown) => {
    const stage = error instanceof ExternalMonitorDiagnosticFailure ? error.stage : 'startup';
    const code = classifyExternalMonitorFailure(error, stage);
    void recordExternalMonitorDiagnostic(options.externalMonitorDiagnosticPath, stage, code, externalMonitorFailureDetail(error),
      error instanceof ExternalMonitorDiagnosticFailure ? error.phase : 'facade_startup_selection', 'startup_resume');
    console.warn('[external-monitor] startup resume failed:', code);
  });
  ownAvatarRefreshScheduler = createOwnAvatarRefreshScheduler(async (accounts) => {
    try { await runPeriodicOwnAvatarRefreshes(accounts); }
    catch (error) { options.audit?.failure(diagnosticFailure('refreshOwnProfile', 'recover', error)); throw error; }
  });
  ownAvatarRefreshScheduler.start(await accounts.listAuthenticatedAccounts());
  return { ...facade,
    openAttachment: (...args) => admitted(() => facade.openAttachment!(...args), { operation: 'attachment' }),
    listMessages: (...args) => admitted(() => facade.listMessages(...args), { operation: 'ipc', identity: { accountId: args[0].accountId } }),
    listChatNotes: (...args) => admitted(() => chatResources.listNotes(...args), { operation: 'note_list', identity: { accountId: args[0].accountId } }),
    getChatNote: (...args) => admitted(() => chatResources.getNote(...args), { operation: 'note_detail', identity: { accountId: args[0].accountId } }),
    listChatAlbums: (key, cursor, refresh) => admitted(() => chatResources.listAlbums(key, cursor, undefined, 'modal', undefined, refresh),
      { operation: 'album_list', identity: { accountId: key.accountId } }),
    listChatAlbumPhotos: (key, albumId, cursor, refresh) => admitted(() => chatResources.listAlbumPhotos(key, albumId, cursor, undefined, refresh),
      { operation: 'album_photos', identity: { accountId: key.accountId } }),
    downloadChatAlbumPhoto: (...args) => admitted(() => chatResources.downloadAlbumPhoto(...args), { operation: 'photo_download', identity: { accountId: args[0].accountId } }),
    openChatAlbum: (...args) => admitted(() => chatResources.openAlbum(...args), { operation: 'chat_resource', identity: { accountId: args[0].accountId } }),
    openReadableChatAlbumFolder: (...args) => admitted(() => chatResources.openReadableAlbumFolder(...args), { operation: 'chat_resource', identity: { accountId: args[0].accountId } }),
    listAttachmentStates: (...args) => admitted(() => facade.listAttachmentStates(...args), { operation: 'attachment', identity: { accountId: args[0].accountId } }),
    listAgentStatuses: (...args) => admitted(() => facade.listAgentStatuses(...args), { operation: 'agent', identity: { accountId: args[0].accountId } }),
    listWorkRecords: (...args) => admitted(() => facade.listWorkRecords(...args), { operation: 'agent' }),
    listFriends: (...args) => admitted(() => facade.listFriends!(...args), { operation: 'ipc', identity: { accountId: args[0] } }),
    listMessageReaders: (...args) => admitted(() => facade.listMessageReaders!(...args), { operation: 'chat_resource', identity: { accountId: args[0].accountId } }),
    listSystemActivity: (...args) => admitted(() => facade.listSystemActivity!(...args), { operation: 'ipc' }),
    listSystemErrors: (...args) => admitted(() => facade.listSystemErrors!(...args), { operation: 'ipc' }),
    controlState: (...args) => admitted(() => facade.controlState(...args), { operation: 'ipc' }),
  };
}
