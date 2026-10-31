import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { realpath, mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { access } from 'node:fs/promises';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { createServer } from 'node:net';
import { once } from 'node:events';
import { request as httpRequest } from 'node:http';
import { IpcResultSchema, LineWorkerCommandSchema, lineMediaUrl, parseLineMediaUrl,type AgentExecutionLevel, type AgentRunRequest, type InboundEnvelope, type IpcEvent, type LineWorkerCommand, type LineWorkerEvent, type LineMediaTarget } from '@line-agent/contracts';
import { AccountRepository, AdminRepository, AgentPermissionRepository, AgentRepository, ExternalMonitorRepository, MessageRepository, SettingsRepository } from '@line-agent/database';
import { createTestDatabase } from '../../../../packages/database/src/test-database.js';
import { plainEnvelope } from '../../../../packages/database/src/content-bridge/test-support.js';
import { createLinejsAdapter } from '../../../../packages/line-worker/src/linejs-adapter.js';
import { FRIEND_LIST_LIMIT, FriendListSchema, MessagePageSchema, MessageReadersSchema } from '../desktop-protocol.js';
import { createConnectedFacade, createPermissionCommandService, resolveMcpLocalClientBridgePath, sameJsonValue, toExternalObservation, type ConnectedFacadeOptions, type IntegratedAgent, type IntegratedWorkerGateway } from './connected-facade.js';
import { isNativeNotePostNotification, type ChatResourceReadResult, type ChatResourceRequest, type ChatResourceStore } from './services/chat-resources.js';
import type { PermissionCommandTransport } from './services/permission-command.js';
import { SecretStore } from './services/secret-store.js';
import { OfficialBuildTrustService, type OfficialBuildTrustState } from './services/official-build-trust.js';
import { createOperationalAudit, type AuditEvent } from './services/operational-audit.js';
import { AttachmentPreviewService } from './attachment-preview.js';
import { LineMediaService } from './line-media.js';
import { createDisconnectedFacade } from './service-facade.js';
import { createIpcAdapter } from './ipc.js';
import { createDesktopApi } from '../preload/api.js';
import { ExternalMonitorDiagnosticFailure } from './services/external-monitor-diagnostics.js';
import { ChatResourceAccountAdmission } from './services/chat-resource-admission.js';

const database = process.env.TEST_DATABASE_URL ? describe : describe.skip;
const MEDIA_PNG = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82]);
// vi.waitFor defaults to 1 s, which is shorter than the snapshot publisher's 1 s refresh throttle plus the
// database work these assertions wait for when the whole suite runs in parallel.
const waitForState = ((callback, options) => vi.waitFor(callback, { timeout: 10_000, interval: 50,
  ...(typeof options === 'number' ? { timeout: options } : options) })) as typeof vi.waitFor;
/** POSTs JSON-RPC to the loopback MCP listener with a bearer token. */
const postLoopbackJson = (endpoint: string, token: string, payload: unknown): Promise<unknown> => new Promise((resolve, reject) => {
  const req = httpRequest(endpoint, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` } }, (res) => {
    const chunks: Buffer[] = [];
    res.on('data', (chunk: Buffer) => chunks.push(chunk));
    res.on('end', () => { try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); } catch (error) { reject(error); } });
    res.on('error', reject);
  });
  req.on('error', reject);
  req.end(JSON.stringify(payload));
});

describe('JSONB structural equality', () => {
  it('compares nested cursor objects without depending on property order', () => {
    expect(sameJsonValue({ createdTime: '7', key: { a: 1, b: 2 } }, { key: { b: 2, a: 1 }, createdTime: '7' })).toBe(true);
    expect(sameJsonValue({ createdTime: '7', id: 'a' }, { createdTime: '7', id: 'b' })).toBe(false);
  });
});


describe('disconnected task search', () => {
  it('reports database unavailability through the standard request error', async () => {
    const result = await createDisconnectedFacade('Database unavailable').dispatch({ type: 'searchAgentJobs', requestId: 'search',
      query: { searchPrompt: true, searchReply: true, limit: 25 } });
    expect(result).toMatchObject({ type: 'error', requestId: 'search', ok: false, code: 'NOT_CONNECTED', message: 'Database unavailable' });
  });
});

describe('local MCP bridge path', () => {
  it('resolves packaged bridges from app.asar.unpacked and development bridges from the app directory', () => {
    expect(resolveMcpLocalClientBridgePath('C:/App/resources/app.asar', true)).toBe(join('C:/App/resources/app.asar.unpacked', 'dist', 'mcp-stdio-bridge.js'));
    expect(resolveMcpLocalClientBridgePath('C:/repo/apps/desktop', false)).toBe(join('C:/repo/apps/desktop', 'dist', 'mcp-stdio-bridge.js'));
  });
});

describe('connected facade permission policy publisher', () => {
  it('publishes after a successful LINE permission policy write', async () => {
    let policy = { level: 'trust' as AgentExecutionLevel, approvalTimeoutSeconds: 60, timeoutAction: 'DENY' as 'ALLOW' | 'DENY', version: 1, updatedAt: new Date().toISOString() };
    const repository = {
      async getExecutionPolicy() { return { ...policy }; },
      async setExecutionPolicy(input: { level: AgentExecutionLevel; approvalTimeoutSeconds: number; timeoutAction: 'ALLOW' | 'DENY'; expectedVersion: number }) {
        policy = { ...policy, level: input.level, approvalTimeoutSeconds: input.approvalTimeoutSeconds, timeoutAction: input.timeoutAction, version: policy.version + 1 };
        return policy.version;
      },
    };
    const binding = { accountId: 'a', workerInstanceId: 'w1', controlEpoch: 1 };
    const transport: PermissionCommandTransport = {
      async isAgentAccount() { return true; },
      async activeBinding() { return binding; },
      async isCurrentControl() { return true; },
      async send(command) { return { type: 'sendResult', accountId: command.accountId, workerInstanceId: command.workerInstanceId,
        controlEpoch: command.controlEpoch, requestId: command.requestId, status: 'sent', messageId: 'sent', error: null }; },
    };
    const published: IpcEvent[] = [];
    const service = createPermissionCommandService(repository, transport,
      () => published.push({ type: 'agentExecutionPolicyChanged' }));
    const envelope = (messageId: string, text: string): InboundEnvelope => ({ eventId: `${messageId}-event`, accountId: 'a',
      chatType: 'direct', chatId: 'c', senderId: 'admin', messageId, kind: 'text', text, mentionIds: [], mentionRanges: [],
      replyToMessageId: null, ingestion: { source: 'live', cursor: null }, occurredAt: new Date().toISOString(), attachments: [], raw: {} });
    const enqueue = async (messageId: string, text: string) => {
      const message = envelope(messageId, text);
      const ticket = service.classify(message, true);
      expect(ticket).not.toBeNull();
      service.enqueue(message, ticket!);
      await vi.waitFor(() => expect(service.sizes().runners).toBe(0));
    };

    await enqueue('permission-list', '/\u6b0a\u9650');
    await enqueue('permission-select', '1');
    expect(policy.level).toBe('read_only');
    expect(published).toEqual([{ type: 'agentExecutionPolicyChanged' }]);
    await service.close();
  });
});

describe('external observation mention mapping', () => {
  const baseRow = {
    observationId: 'fixture-observation', canonicalMessageId: null, nativeConversationKind: 'group',
    nativeConversationId: 'fixture-chat', nativeMessageId: 'fixture-message', chatType: 'group', chatId: 'fixture-chat',
    senderId: 'fixture-sender', kind: 'text', createdTime: '1792000000000', text: 'A \uD83D\uDE00 @all', readonlyForSending: true,
    nativePayload: { format: 1, table: '_message', sourceDigest: 'a'.repeat(64), encoding: 'dpapi', data: 'AQID' },
  } as const;

  it('preserves valid UTF-16 mention ranges through the database observation mapper', () => {
    const observation = toExternalObservation({ ...baseRow,
      mentionRanges: [{ start: 2, end: 4, userId: 'fixture-target' }, { start: 5, end: 9, userId: '@all' }],
    });
    expect(observation.mentionRanges).toEqual([
      { start: 2, end: 4, userId: 'fixture-target' }, { start: 5, end: 9, userId: '@all' },
    ]);
  });

  it('drops only malformed optional mention ranges and keeps the required observation', () => {
    const observation = toExternalObservation({ ...baseRow, mentionRanges: [{ start: 0, end: 99, userId: 'fixture-target' }] });
    expect(observation.observationId).toBe(baseRow.observationId);
    expect(observation.mentionRanges).toBeUndefined();
  });

  it('keeps the protected source envelope and preserves sanitized filename projection and safe sticker metadata', () => {
    const observation = toExternalObservation({ ...baseRow, kind: 'file', text: 'report\0 final.pdf',
      nativeStickerMetadata: { STKID: '123', STKTXT: '  sticker\n label  ', STKOPT: 'A' } });
    expect(observation.nativePayload).toBe(baseRow.nativePayload);
    expect(observation.text).toBe('report\uFFFD final.pdf');
    expect(observation.nativeStickerMetadata).toEqual({ STKID: '123', STKTXT: 'sticker label', STKOPT: 'A' });
  });

  it('omits malformed optional sticker projection without rejecting the source row', () => {
    const observation = toExternalObservation({ ...baseRow,
      nativeStickerMetadata: { STKID: 'not-an-id' } as never });
    expect(observation.observationId).toBe(baseRow.observationId);
    expect(observation.nativeStickerMetadata).toBeUndefined();
    expect(observation.nativePayload).toBe(baseRow.nativePayload);
  });

  it('forwards bounded native attachment descriptors without inventing MIME or expiry', () => {
    const descriptors = [{ id: 'fixture-message', kind: 'file' as const, name: '資料.bin', mimeType: null,
      sizeBytes: 37, expiresAt: null }];
    const observation = toExternalObservation({ ...baseRow, nativeAttachments: descriptors } as never);
    expect(observation.attachments).toEqual(descriptors);
  });

  it('forwards a bounded community sender picture without requiring a sender name', () => {
    expect(toExternalObservation({ ...baseRow, chatType: 'community', senderPicturePath: 'abcdefghijklmnop' }).senderPicturePath)
      .toBe('abcdefghijklmnop');
    expect(toExternalObservation({ ...baseRow, senderPicturePath: 'x'.repeat(2049) } as never).senderPicturePath).toBeUndefined();
  });
});
type TestBinding = Parameters<IntegratedWorkerGateway['start']>[1];


database('connected facade account login semantics', () => {
  let pool: Awaited<ReturnType<typeof createTestDatabase>>['pool'];
  let closeDatabase: (() => Promise<void>) | undefined;
  let facade: Awaited<ReturnType<typeof createConnectedFacade>>;
  const viaUrl = (target: LineMediaTarget) => {
    const url = lineMediaUrl(target);
    expect(url).not.toBeNull();
    const parsed = parseLineMediaUrl(new URL(url!).href);
    expect(parsed).not.toBeNull();
    return facade.handleLineMedia!(parsed!);
  };
  // Source-builder spies prove WHICH remote asset a fixed media URL resolved to; fetches alone cannot,
  // because the per-test disk cache serves a repeated asset without fetching.
  type MediaSourceBuilder = 'sticonSource' | 'stickerSource' | 'avatarSource' | 'attachmentSource';
  let mediaSources: Record<MediaSourceBuilder, { mock: { calls: unknown[][]; results: Array<{ value: unknown }> }; mockClear(): unknown; mockRestore(): unknown }>;
  const clearMediaObservations = () => {
    for (const spy of Object.values(mediaSources)) spy.mockClear();
    mediaFetches.length = 0;
  };
  /** One request that must serve exactly one source built by `builder(args)` and fetch exactly `fetched`. */
  const expectMediaServed = async (target: LineMediaTarget, builder: MediaSourceBuilder, args: unknown[], fetched: string[]) => {
    clearMediaObservations();
    const response = await viaUrl(target);
    expect(response.status).toBe(200);
    for (const [name, spy] of Object.entries(mediaSources)) {
      expect(spy.mock.calls, `${name} calls for ${JSON.stringify(target)}`).toEqual(name === builder ? [args] : []);
    }
    expect(mediaSources[builder].mock.results[0]?.value).not.toBeNull();
    expect(mediaFetches).toEqual(fetched);
    clearMediaObservations();
  };
  /** One request that must be refused before any source is built or any byte is fetched. */
  const expectMediaRejected = async (target: LineMediaTarget) => {
    clearMediaObservations();
    const response = await viaUrl(target);
    expect(response.status).toBe(404);
    for (const [name, spy] of Object.entries(mediaSources)) {
      expect(spy.mock.calls, `${name} calls for ${JSON.stringify(target)}`).toEqual([]);
    }
    expect(mediaFetches).toEqual([]);
  };
  let commands: LineWorkerCommand[];
  let friendRemoteCalls: number;
  let friendRelationCommands: Extract<LineWorkerCommand, { type: 'checkFriendRelation' }>[];
  let friendAddCommands: Extract<LineWorkerCommand, { type: 'addFriendByMid' }>[];
  let friendAddStatus: Extract<LineWorkerEvent, { type: 'addFriendResult' }>['status'];
  let pendingFriendRelation: { started(): void; wait: Promise<Extract<LineWorkerEvent, { type: 'friendRelationResult' }>> } | null;
  let starts: Array<{ accountId: string; mode: string; controlEpoch: number }>;
  let stops: string[];
  let stoppedWorkerInstances: string[];
  let bindings: Map<string, TestBinding>;
  let downloadReadyBindings: Set<string>;
  let acceptedDownloadToken = 'candidate-two';
  let markDownloadReadyOnAccept = true;
  let qrError: Error | null;
  let failedLoginTokenAccount: string | null;
  let lineLogoutFailure = false;
  let manualSendFailure: string | null;
  let manualUnsendFailure: string | null;
  let manualUnsendFenced = false;
  let activeControlAckFailures = new Set<string>();
  let activeControlAckDelays = new Set<string>();
  let activeControlAckChecks = 0;
  let welcomeSendOutcome: 'sent' | 'failed' | 'unknown' | 'throw';
  let refreshedOwnProfile: { ownMid: string; displayName: string; picturePath: string } | null;
  let profileFailure: string | null;
  let monitorAckFailures = new Set<string>();
  let failDownloadOnlyStart = false;
  let workerEventHandler: ((workerInstanceId: string, event: LineWorkerEvent) => Promise<void>) | undefined;
  let workerBindingHandler: ((binding: TestBinding, signal: AbortSignal) => Promise<void> | void) | undefined;
  let workerRestartBindingHandler: ((binding: TestBinding, signal: AbortSignal) => Promise<void> | void) | undefined;
  let published: IpcEvent[];
  let agent: IntegratedAgent;
  let workers: IntegratedWorkerGateway;
  let secretRoot: string;
  let secretStore: SecretStore;
  let pendingProtect: { started(): void; wait: Promise<void> } | null;
  let pendingWelcomeSend: { started(): void; wait: Promise<void>; release?: () => void } | null;
  let pendingWelcomeBinding: { accountId: string; started(): void; wait: Promise<void> } | null;
  let pendingOwnProfileRead: { started(): void; wait: Promise<void>; release?: () => void } | null;
  let pendingWorkerStop: { started(): void; wait: Promise<void> } | null;
  let pendingManualMedia: { started(): void; wait: Promise<void>; release(): void } | null;
  let auditEvents: AuditEvent[];
  let audit: ReturnType<typeof createOperationalAudit>;
  let mediaFetches: string[];
  let archiveStore: ChatResourceStore;
  let archivePublishGate: { entered(): void; wait: Promise<void> } | null;
  let archiveCommits: number;
  let archiveReads: number;

  beforeEach(async () => {
    archivePublishGate = null;
    archiveCommits = 0;
    archiveReads = 0;
    archiveStore = {
      async publish(input) {
        const gate = archivePublishGate;
        if (gate) { gate.entered(); await gate.wait; }
        input.guard(); archiveCommits++;
        return { revision: archiveCommits, savedAt: new Date().toISOString(), contentHash: (await import('node:crypto')).createHash('sha256').update(input.content).digest('hex'), byteLength: input.content.byteLength };
      },
      async read() { return null; }, async list() { return { items: [], nextCursor: null }; }, async close() {}, forceClose() {},
    };
    mediaFetches = [];
    mediaSources = {
      sticonSource: vi.spyOn(LineMediaService.prototype, 'sticonSource'),
      stickerSource: vi.spyOn(LineMediaService.prototype, 'stickerSource'),
      avatarSource: vi.spyOn(LineMediaService.prototype, 'avatarSource'),
      attachmentSource: vi.spyOn(LineMediaService.prototype, 'attachmentSource'),
    };
    vi.stubGlobal('fetch', async (input: RequestInfo | URL) => {
      mediaFetches.push(String(input));
      return new Response(MEDIA_PNG, { headers: { 'content-type': 'image/png' } });
    });
    ({ pool, close: closeDatabase } = await createTestDatabase());
    secretRoot = await mkdtemp(join(tmpdir(), 'connected-auth-invalidation-'));
    pendingProtect = null;
    pendingWelcomeSend = null;
    pendingWelcomeBinding = null;
    pendingOwnProfileRead = null;
    pendingWorkerStop = null;
    pendingManualMedia = null;
    auditEvents = [];
    audit = createOperationalAudit({ async append(event) { auditEvents.push(event); }, async appendFallback() {}, logSinkState() {} });
    secretStore = new SecretStore(secretRoot, { async protect(value) {
      const gate = pendingProtect;
      if (gate) { pendingProtect = null; gate.started(); await gate.wait; }
      return value;
    }, async unprotect(value) { return value; } });
    commands = [];
    friendRemoteCalls = 0;
    friendRelationCommands = [];
    friendAddCommands = [];
    friendAddStatus = 'unknown';
    pendingFriendRelation = null;
    activeControlAckFailures = new Set();
    activeControlAckDelays = new Set();
    activeControlAckChecks = 0;
    starts = [];
    stops = [];
    stoppedWorkerInstances = [];
    bindings = new Map();
    downloadReadyBindings = new Set();
    acceptedDownloadToken = 'candidate-two';
    markDownloadReadyOnAccept = true;
    qrError = null;
    failedLoginTokenAccount = null;
    lineLogoutFailure = false;
    workerRestartBindingHandler = undefined;
    manualSendFailure = null;
    manualUnsendFailure = null;
    manualUnsendFenced = false;
    welcomeSendOutcome = 'sent';
    refreshedOwnProfile = null;
    profileFailure = null;
    monitorAckFailures = new Set();
    failDownloadOnlyStart = false;
    published = [];
    let onBinding: ((binding: TestBinding, signal: AbortSignal) => Promise<void> | void) | undefined;
    workers = {
      onEvent(listener) {
        const previous = workerEventHandler;
        workerEventHandler = listener;
        return () => { if (workerEventHandler === listener) workerEventHandler = previous; };
      },
      onBinding(listener) {
        const previousHandler = workerBindingHandler;
        onBinding = listener;
        workerBindingHandler = listener;
        return () => { if (workerBindingHandler === listener) workerBindingHandler = previousHandler; };
      },
      onRestartBinding(listener) {
        const previousHandler = workerRestartBindingHandler;
        workerRestartBindingHandler = listener;
        return () => { if (workerRestartBindingHandler === listener) workerRestartBindingHandler = previousHandler; };
      },
      async start(accountId, binding) {
        starts.push({ accountId, mode: binding.mode, controlEpoch: binding.controlEpoch });
        if (binding.purpose === 'DOWNLOAD_ONLY' && failDownloadOnlyStart) throw new Error('simulated optional download worker start failure');
        bindings.set(accountId, binding);
        await onBinding?.(binding, new AbortController().signal);
        return binding;
      },
      async binding(accountId) {
        const gate = pendingWelcomeBinding;
        if (gate?.accountId === accountId) {
          pendingWelcomeBinding = null;
          gate.started();
          await gate.wait;
        }
        return bindings.get(accountId) ?? null;
      },
      isDownloadReady(binding) { return downloadReadyBindings.has(binding.workerInstanceId); },
      async adoptDownloadAuth(command) {
        commands.push(command);
        const accepted = command.token === acceptedDownloadToken;
        if (accepted && markDownloadReadyOnAccept) downloadReadyBindings.add(command.workerInstanceId);
        return { type: 'downloadAuthResult', accountId: command.accountId, workerInstanceId: command.workerInstanceId,
          controlEpoch: command.controlEpoch, transportOwnerId: command.transportOwnerId, transportGeneration: command.transportGeneration,
          writeGrantVersion: command.writeGrantVersion, requestId: command.requestId, accepted,
          error: accepted ? null : 'PROFILE_MISMATCH' };
      },
      isCurrentActiveControlBinding(binding) {
        const current = bindings.get(binding.accountId);
        return !!current && current.mode === 'ACTIVE_CONTROL' && current.accountId === binding.accountId
          && current.workerInstanceId === binding.workerInstanceId && current.controlEpoch === binding.controlEpoch
          && current.transportOwnerId === binding.transportOwnerId && current.transportGeneration === binding.transportGeneration
          && current.writeGrantVersion === binding.writeGrantVersion;
      },
      isCurrentManualSendBinding(binding) {
        const current = bindings.get(binding.accountId);
        return !manualUnsendFenced && !!current && current.mode !== 'PAUSED' && current.accountId === binding.accountId
          && current.workerInstanceId === binding.workerInstanceId && current.controlEpoch === binding.controlEpoch
          && current.transportOwnerId === binding.transportOwnerId && current.transportGeneration === binding.transportGeneration
          && current.writeGrantVersion === binding.writeGrantVersion;
      },
      async send(command) {
        commands.push(command);
        if (command.type === 'logout') {
          const { type: _type, ...identity } = command;
          await workerEventHandler?.(command.workerInstanceId, lineLogoutFailure
            ? { type: 'logoutResult', ...identity, ok: false, error: 'LINE_LOGOUT_FAILED' }
            : { type: 'logoutResult', ...identity, ok: true, error: null });
        }
        if (command.type === 'sendText' && command.text === 'Welcome as the primary administrator.' && pendingWelcomeSend) {
          pendingWelcomeSend.started();
          await pendingWelcomeSend.wait;
        }
        if (command.type === 'sendText' && command.text === 'Welcome as the primary administrator.' && welcomeSendOutcome === 'throw') {
          throw new Error('simulated worker send failure');
        }
        if (command.type === 'loginQr' && qrError) throw qrError;
        if (command.type === 'loginToken' && command.accountId === failedLoginTokenAccount) {
          throw new Error('Token restore failed');
        }
        const welcomeStatus = welcomeSendOutcome === 'throw' ? 'sent' : welcomeSendOutcome;
        return { type: 'sendResult', accountId: command.accountId, workerInstanceId: command.workerInstanceId, controlEpoch: command.controlEpoch,
          requestId: command.type === 'sendText' ? command.requestId : 'send-result',
          status: command.type === 'sendText' && command.text === 'Welcome as the primary administrator.' ? welcomeStatus : 'sent',
          messageId: null, error: welcomeSendOutcome === 'failed' ? 'SIMULATED_FAILURE' : null };
      },
      async refreshOwnProfile(command) {
        commands.push(command);
        const gate = pendingOwnProfileRead;
        if (gate) { pendingOwnProfileRead = null; gate.started(); await gate.wait; }
        const { type: _type, timeoutMs: _timeoutMs, ...binding } = command;
        if (profileFailure) return { ...binding, type: 'ownProfileResult', ok: false, error: profileFailure };
        if (!refreshedOwnProfile) throw new Error('No fake profile configured');
        return { ...binding, type: 'ownProfileResult', ok: true, error: null, ...refreshedOwnProfile };
      },
      async sendManual(command) {
        const manual = { ...command, type: 'manualSendText' } as LineWorkerCommand;
        commands.push(manual);
        return { type: 'sendResult', accountId: command.accountId, workerInstanceId: command.workerInstanceId, controlEpoch: command.controlEpoch,
          requestId: command.requestId, status: manualSendFailure === '__UNKNOWN__' ? 'unknown' : manualSendFailure ? 'failed' : 'sent',
          messageId: manualSendFailure ? null : 'manual-sent', error: manualSendFailure === '__UNKNOWN__' ? null : manualSendFailure };
      },
      async sendMedia(command, signal) {
        const media = { type: 'sendMedia', ...command } as LineWorkerCommand;
        commands.push(media);
        const gate = pendingManualMedia;
        if (gate) {
          pendingManualMedia = null;
          gate.started();
          await Promise.race([gate.wait, new Promise<void>((resolve) => signal?.addEventListener('abort', () => resolve(), { once: true }))]);
          if (signal?.aborted) throw new Error('Worker send cancelled after worker admission');
        }
        return { type: 'sendResult', accountId: command.accountId, workerInstanceId: command.workerInstanceId, controlEpoch: command.controlEpoch,
          requestId: command.requestId, operationId: command.requestId, attemptId: command.requestId, status: 'sent', messageId: 'media-sent', error: null };
      },
      async unsend(command) {
        commands.push(command);
        return { type: 'unsendResult', accountId: command.accountId, workerInstanceId: command.workerInstanceId, controlEpoch: command.controlEpoch,
          transportOwnerId: command.transportOwnerId, transportGeneration: command.transportGeneration, writeGrantVersion: command.writeGrantVersion,
          requestId: command.requestId, chatType: command.chatType, chatId: command.chatId, messageId: command.messageId,
          status: manualUnsendFailure === '__UNKNOWN__' ? 'unknown' : manualUnsendFailure ? 'failed' : 'unsent',
          error: manualUnsendFailure === '__UNKNOWN__' ? 'TRANSPORT_OUTCOME_UNKNOWN' : manualUnsendFailure };
      },
      async checkFriendRelation(command) {
        friendRemoteCalls++;
        friendRelationCommands.push(command);
        const gate = pendingFriendRelation;
        if (gate) { pendingFriendRelation = null; gate.started(); return gate.wait; }
        return { ...command, type: 'friendRelationResult', status: 'unknown', error: 'RELATION_OUTCOME_UNKNOWN' };
      },
      async addFriendByMid(command) {
        friendRemoteCalls++;
        friendAddCommands.push(command);
        return { ...command, type: 'addFriendResult', status: friendAddStatus,
          error: friendAddStatus === 'added' ? null : 'TRANSPORT_OUTCOME_UNKNOWN' };
      },
      async download() { throw new Error('No attachment download expected'); },
      async readChatResource(command: ChatResourceRequest): Promise<ChatResourceReadResult> {
        archiveReads++;
        return { type: 'chatResourceResult', requestId: command.requestId, action: command.action, ok: true,
          accountId: command.accountId, workerInstanceId: command.workerInstanceId, controlEpoch: command.controlEpoch,
          chatType: command.chatType, chatId: command.chatId, note: { postId: command.postId ?? 'note-a', createdTime: 1, text: 'archive test' } };
      },
      async waitModeAck(accountId, mode, timeoutMs) {
        if (mode === 'ACTIVE_CONTROL' && timeoutMs === 100) activeControlAckChecks++;
        // Startup ACKs remain immediate. Friendship readiness gets a pending
        // worker ACK that can be cancelled while the response is outstanding.
        if (mode === 'ACTIVE_CONTROL' && timeoutMs === 100 && activeControlAckDelays.has(accountId)) {
          await new Promise((resolve) => setTimeout(resolve, 75));
          return !activeControlAckFailures.has(accountId);
        }
        if (mode === 'ACTIVE_CONTROL' && timeoutMs === 100 && activeControlAckFailures.has(accountId)) return false;
        return mode !== 'MONITOR_ONLY' || !monitorAckFailures.has(bindings.get(accountId)?.workerInstanceId ?? '');
      },
      async stop(accountId) {
        const gate = pendingWorkerStop;
        if (gate) { pendingWorkerStop = null; gate.started(); await gate.wait; }
        stops.push(accountId); bindings.delete(accountId);
      },
      async stopBinding(binding) {
        const gate = pendingWorkerStop;
        if (gate) { pendingWorkerStop = null; gate.started(); await gate.wait; }
        stoppedWorkerInstances.push(binding.workerInstanceId); downloadReadyBindings.delete(binding.workerInstanceId); if (bindings.get(binding.accountId)?.workerInstanceId === binding.workerInstanceId) {
        stops.push(binding.accountId); bindings.delete(binding.accountId);
      } },
      async shutdown() { bindings.clear(); pendingWelcomeSend?.release?.(); },
    };
    agent = {
      async *run() {},
      async cancel() {},
      async getAuthStatus() { return { status: 'logged_out' }; },
      async agentRefreshStatus() { return { status: 'logged_out' }; },
      async openLogin() { return { ok: true }; },
      async logout() { return { ok: true }; },
      async shutdown() {},
    };
    await pool.query("INSERT INTO app_settings(key,value) VALUES ('workspace_path',$1::jsonb)", [JSON.stringify('Z:\\missing-workspace-recovery')]);
    facade = await createConnectedFacade({ pool, workers, agent, attachmentRoot: 'C:\\attachments', mediaCacheRoot: join(secretRoot, 'line-media-cache'),
      previewPresenter: { async present() { return false; }, closeAll() {} }, secretStore, audit, runMigrations: false,
      chatResourceStore: archiveStore,
      publish(event) { published.push(event); } });
  });

  afterEach(async () => {
    pendingProtect = null;
    await facade?.shutdown();
    await closeDatabase?.();
    if (secretRoot) await rm(secretRoot, { recursive: true, force: true });
    for (const spy of Object.values(mediaSources)) spy.mockRestore();
    vi.unstubAllGlobals();
  });

  it.each(['lineLoginQr', 'lineReplaceAgentQr', 'lineLogout', 'getManualUnsendWindow'] as const)('identifies thrown %s failures without private exception text', async (type) => {
    const sentinel = 'PRIVATE_IPC_SENTINEL token=secret C:\\private\\qr-pin';
    const error = type === 'lineLogout' ? Object.assign(new Error(sentinel), { code: 'ETIMEDOUT' }) : new Error(sentinel);
    const spy = type === 'getManualUnsendWindow'
      ? vi.spyOn(SettingsRepository.prototype, 'getAppSetting').mockRejectedValue(error)
      : vi.spyOn(AccountRepository.prototype, 'getAccount').mockRejectedValue(error);
    const requestId = randomUUID();
    try {
      const result = await facade.dispatch(type === 'getManualUnsendWindow' ? { type, requestId } : { type, requestId, accountId: 'account-a' });
      const codes = { lineLoginQr: 'LINE_LOGIN_QR_START_FAILED', lineReplaceAgentQr: 'AGENT_REPLACEMENT_FAILED', lineLogout: 'LINE_LOGOUT_FAILED', getManualUnsendWindow: 'SERVICE_ERROR' };
      expect(result).toMatchObject({ ok: false, code: codes[type], requestId });
      await audit.flush();
      const events = auditEvents.filter((event) => event.requestId === requestId && event.diagnostic?.ipcAction === type);
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({ correlationId: requestId, diagnostic: { ipcAction: type, category: type === 'lineLogout' ? 'timeout' : 'unknown' } });
      expect(JSON.stringify([result, events])).not.toContain(sentinel);
    } finally { spy.mockRestore(); }
  });

  it('uses the default manual unsend window and persists the selected value', async () => {
    expect(await facade.dispatch({ type: 'getManualUnsendWindow', requestId: 'unsend-window-default' }))
      .toMatchObject({ type: 'getManualUnsendWindow', ok: true, window: '1h' });
    expect(await facade.dispatch({ type: 'setManualUnsendWindow', requestId: 'unsend-window-set', window: '7d' }))
      .toMatchObject({ type: 'setManualUnsendWindow', ok: true, window: '7d' });
    expect(await facade.dispatch({ type: 'getManualUnsendWindow', requestId: 'unsend-window-read' }))
      .toMatchObject({ type: 'getManualUnsendWindow', ok: true, window: '7d' });
    await expect(new SettingsRepository(pool).getAppSetting('not_a_supported_setting'))
      .rejects.toThrow('App setting not allowed');
  });

  it('mints the MCP capability for queued jobs recovered at startup because the listener is bound first', async () => {
    await facade.shutdown();
    // The queued job belongs to the shared Agent room: recovery needs no LINE account at all.
    const { jobId } = await new AgentRepository(pool).enqueueUiJob({
      provider: 'codex', requestId: 'recover-request', prompt: 'recover me', workspacePath: 'Z:\\missing-workspace-recovery' });
    const requests: AgentRunRequest[] = [];
    const recordingAgent: IntegratedAgent = { ...agent, async *run(request) {
      requests.push(request);
      yield { type: 'started', externalSessionId: 'recovered-session' };
      yield { type: 'completed', finalText: 'done' };
    } };
    facade = await createConnectedFacade({ pool, workers, agent: recordingAgent, attachmentRoot: 'C:\\attachments', secretStore, audit,
      runMigrations: false, closePoolOnShutdown: false, mcpHttpPort: 0, skillsDirectory: join(import.meta.dirname, '..', '..', '..', '..', 'skills') });
    await waitForState(() => expect(requests).toHaveLength(1));
    const status = await facade.dispatch({ type: 'mcpGetStatus', requestId: 'recover-status' });
    expect(status).toMatchObject({ ok: true, status: { running: true } });
    const endpoint = (status as { status: { endpoint: string } }).status.endpoint;
    expect(requests[0]!.jobId).toBe(jobId);
    expect(requests[0]!.mcp).toEqual({ endpoint, token: expect.stringMatching(/^li_job_/) });
    expect(requests[0]!.prompt).toContain('linejs-mcp');
    await waitForState(async () => {
      const rows = await pool.query<{ event: { type: string; status?: string } }>('SELECT event FROM agent_events WHERE job_id = $1 ORDER BY event_id', [jobId]);
      expect(rows.rows.map((row) => row.event).find((event) => event.type === 'mcp_status')).toMatchObject({ status: 'configured' });
    });
  });

  it('round-trips a pending Agent tool approval through IPC, maps broker errors, and publishes approval and policy events', async () => {
    const permissionRepository = new AgentPermissionRepository(pool);
    const previousPolicy = await permissionRepository.getExecutionPolicy();
    await permissionRepository.setExecutionPolicy({ level: 'workspace_write', approvalTimeoutSeconds: previousPolicy.approvalTimeoutSeconds, timeoutAction: previousPolicy.timeoutAction,
      expectedVersion: previousPolicy.version });
    try {
    await facade.shutdown();
    await new AgentRepository(pool).enqueueUiJob({
      provider: 'claude', requestId: 'approval-request', prompt: 'run the tests', workspacePath: 'Z:\\missing-workspace-recovery' });
    const answers: Array<{ behavior: string }> = [];
    const longCommand = `echo ${'x'.repeat(2100)}`;
    const approvalAgent: IntegratedAgent = { ...agent, async *run(request) {
      yield { type: 'started', externalSessionId: 'approval-session' };
      for (const [id, command] of [[1, 'npm test -- approval'], [2, longCommand]] as const) {
        // node:http directly: this suite stubs global fetch for LINE media.
        const body = await postLoopbackJson(request.mcp!.endpoint, request.mcp!.token, { jsonrpc: '2.0', id, method: 'tools/call',
          params: { name: 'request_permission', arguments: { tool_name: 'Bash', input: { command }, tool_use_id: `toolu_${id}` } } }) as
          { result: { content: Array<{ text: string }> } };
        answers.push(JSON.parse(body.result.content[0]!.text) as { behavior: string });
      }
      yield { type: 'completed', finalText: 'done' };
    } };
    facade = await createConnectedFacade({ pool, workers, agent: approvalAgent, attachmentRoot: 'C:\\attachments', secretStore, audit,
      runMigrations: false, closePoolOnShutdown: false, mcpHttpPort: 0, publish(event) { published.push(event); } });
    const requested = () => published.filter((event): event is Extract<IpcEvent, { type: 'agentApprovalRequested' }> => event.type === 'agentApprovalRequested');
    await waitForState(() => expect(requested()).toHaveLength(1));
    const listed = await facade.dispatch({ type: 'listPendingAgentApprovals', requestId: 'list-1' });
    expect(listed).toMatchObject({ type: 'listPendingAgentApprovals', ok: true,
      approvals: [{ tool: 'Bash', summary: 'npm test -- approval', canRemember: true }] });
    const first = (listed as { approvals: Array<{ approvalId: string; jobId: string }> }).approvals[0]!;
    expect(requested()[0]!.approval).toEqual((listed as { approvals: unknown[] }).approvals[0]);
    expect(await facade.dispatch({ type: 'decideAgentApproval', requestId: 'decide-1', approvalId: first.approvalId, decision: 'once' }))
      .toEqual({ type: 'decideAgentApproval', requestId: 'decide-1', ok: true });
    expect(await facade.dispatch({ type: 'decideAgentApproval', requestId: 'decide-2', approvalId: first.approvalId, decision: 'once' }))
      .toMatchObject({ type: 'error', ok: false, code: 'APPROVAL_NOT_PENDING', retryable: false });

    await waitForState(() => expect(requested()).toHaveLength(2));
    const second = requested()[1]!.approval;
    expect(second).toMatchObject({ summary: longCommand, canRemember: false });
    expect(await facade.dispatch({ type: 'decideAgentApproval', requestId: 'decide-3', approvalId: second.approvalId, decision: 'session' }))
      .toMatchObject({ type: 'error', ok: false, code: 'APPROVAL_REMEMBER_UNAVAILABLE' });
    expect(await facade.dispatch({ type: 'listPendingAgentApprovals', requestId: 'list-2' })).toMatchObject({ approvals: [{ approvalId: second.approvalId }] });
    expect(await facade.dispatch({ type: 'decideAgentApproval', requestId: 'decide-4', approvalId: second.approvalId, decision: 'deny' }))
      .toMatchObject({ ok: true });
    await waitForState(() => expect(answers).toHaveLength(2));
    expect(answers.map((answer) => answer.behavior)).toEqual(['allow', 'deny']);
    expect(published.filter((event) => event.type === 'agentApprovalResolved')).toEqual([
      { type: 'agentApprovalResolved', approvalId: first.approvalId, jobId: first.jobId, outcome: 'allowed' },
      { type: 'agentApprovalResolved', approvalId: second.approvalId, jobId: first.jobId, outcome: 'denied' },
    ]);
    expect(await facade.dispatch({ type: 'listPendingAgentApprovals', requestId: 'list-3' })).toMatchObject({ approvals: [] });

    const policy = await facade.dispatch({ type: 'getAgentExecutionPolicy', requestId: 'policy-1' }) as { policy: { version: number } };
    expect(published.some((event) => event.type === 'agentExecutionPolicyChanged')).toBe(false);
    const stale = await facade.dispatch({ type: 'setAgentExecutionPolicy', requestId: 'policy-2', level: 'trust', approvalTimeoutSeconds: 60, timeoutAction: 'DENY',
      expectedVersion: policy.policy.version + 5 });
    expect(stale).toMatchObject({ type: 'error' });
    expect(published.some((event) => event.type === 'agentExecutionPolicyChanged')).toBe(false);
    expect(await facade.dispatch({ type: 'setAgentExecutionPolicy', requestId: 'policy-3', level: 'trust', approvalTimeoutSeconds: 60, timeoutAction: 'DENY',
      expectedVersion: policy.policy.version })).toMatchObject({ ok: true });
    expect(published.filter((event) => event.type === 'agentExecutionPolicyChanged')).toEqual([{ type: 'agentExecutionPolicyChanged' }]);
    } finally {
      const currentPolicy = await permissionRepository.getExecutionPolicy();
      await permissionRepository.setExecutionPolicy({ level: previousPolicy.level, approvalTimeoutSeconds: previousPolicy.approvalTimeoutSeconds, timeoutAction: previousPolicy.timeoutAction,
        expectedVersion: currentPolicy.version });
    }
  });

  async function seedExternalProbeAttachment(accountId: string, chatId: string, messageId: string, name: string, sizeBytes = 2, ageHours = 1) {
    const capability = await new AccountRepository(pool).resolveCapabilities(accountId);
    const sourceId = capability!.selectedSourceId!;
    const generation = capability!.selectedSourceGeneration!;
    const observationId = `${messageId}-obs`;
    await pool.query('INSERT INTO conversations(account_id, chat_id, chat_type) VALUES ($1,$2,\'group\') ON CONFLICT DO NOTHING', [accountId, chatId]);
    await pool.query(`INSERT INTO messages(account_id,message_id,event_id,chat_type,chat_id,sender_id,kind,ingestion_source,occurred_at,raw)
      VALUES ($1,$2,$3,'group',$4,'person','file','live',now() - make_interval(hours => $6),$5::jsonb)`,
    [accountId, messageId, `${messageId}-event`, chatId,
      JSON.stringify({ native: { format: 1, table: '_message', sourceDigest: 'c'.repeat(64), encoding: 'dpapi', data: 'AQID' } }), ageHours]);
    await pool.query(`INSERT INTO attachments(external_attachment_id, account_id, message_id, chat_type, chat_id, kind, name, size_bytes)
      VALUES ($1,$2,$1,'group',$3,'file',$4,$5)`, [messageId, accountId, chatId, name, sizeBytes]);
    await pool.query(`INSERT INTO external_source_batches(source_id,account_id,generation,batch_id,payload_digest,result)
      VALUES ($1,$2,$3,$4,repeat('b',64),'{}'::jsonb)`, [sourceId, accountId, generation, `${messageId}-batch`]);
    await pool.query(`INSERT INTO external_source_observations(source_id,account_id,generation,observation_id,batch_id,canonical_message_id,normalized_digest,normalized_payload,status)
      VALUES ($1,$2,$3,$4,$5,$6,repeat('c',64),'{}'::jsonb,'PROJECTED')`,
    [sourceId, accountId, generation, observationId, `${messageId}-batch`, messageId]);
    await pool.query(`INSERT INTO message_source_provenance(account_id, message_id, source_id, generation, observation_id, origin, redacted)
      VALUES ($1,$2,$3,$4,$5,'EXTERNAL_MONITOR',true)`, [accountId, messageId, sourceId, generation, observationId]);
  }

  async function restartFacadeWithImporter(importer: NonNullable<ConnectedFacadeOptions['officialSnapshotImporter']>,
    publish?: (event: IpcEvent) => void, externalImportProgressPath?: string, externalDownloadTokenLookup = false,
    externalMonitorDiagnosticPath?: string) {
    await facade.shutdown();
    facade = await createConnectedFacade({ pool, workers, agent, attachmentRoot: 'C:\\attachments', secretStore, audit,
      runMigrations: false, officialSnapshotImporter: importer, externalDownloadTokenLookup,
      ...(externalImportProgressPath ? { externalImportProgressPath } : {}),
      ...(externalMonitorDiagnosticPath ? { externalMonitorDiagnosticPath } : {}),
      publish(event) { published.push(event); publish?.(event); } });
  }

  it('commits bounded native catalog pages before message import without changing the message checkpoint', async () => {
    await addStoredAccounts('catalog-agent', 'catalog-admin');
    const importer: NonNullable<ConnectedFacadeOptions['officialSnapshotImporter']> = {
      async readOfficialSnapshot(input) {
        await input.onReady({ sourceIdentityDigest: 'a'.repeat(64), snapshotDigest: 'b'.repeat(64), schemaVersion: 'line-schema-v1',
          highWatermark: null, eligibleCount: '0' });
        await input.onCatalogPage({ requestId: 'catalog-request', pageNumber: 1, batchDigest: 'c'.repeat(64), hasMore: false,
          rows: [{ tableName: '_contact', recordKey: 'pk:["u-catalog"]',
            nativePayload: { format: 1, table: '_contact', sourceDigest: 'd'.repeat(64), encoding: 'dpapi', data: 'AQID' } }] });
        return { sourceIdentityDigest: 'a'.repeat(64), snapshotDigest: 'b'.repeat(64), pageCount: 0, rowCount: 0, highWatermark: null };
      },
    };
    await restartFacadeWithImporter(importer);
    expect(await facade.dispatch({ type: 'externalImportStart', requestId: 'catalog-import', accountId: 'catalog-admin' }))
      .toMatchObject({ ok: true });
    await waitForState(async () => {
      const result = await pool.query(`SELECT table_name,record_key,source_digest FROM native_source_catalog_records
        WHERE account_id='catalog-admin' AND table_name='_contact'`);
      expect(result.rows).toEqual([{ table_name: '_contact', record_key: 'pk:["u-catalog"]', source_digest: 'd'.repeat(64) }]);
    });
    const capability = await new AccountRepository(pool).resolveCapabilities('catalog-admin');
    const state = capability?.selectedSourceId && capability.selectedSourceGeneration !== null
      ? await new ExternalMonitorRepository(pool).getInitialImportState({ accountId: 'catalog-admin',
        sourceId: capability.selectedSourceId, generation: capability.selectedSourceGeneration }) : null;
    expect(state).toMatchObject({ committedCount: '0', cursor: {} });
  });

  it.each(['after-ready', 'after-page', 'before-done'] as const)('aborts and drains an official import during shutdown at %s', async (phase) => {
    await addStoredAccounts('import-agent', 'import-admin');
    let reached!: () => void;
    const reachedPhase = new Promise<void>((resolve) => { reached = resolve; });
    let observedSignal: AbortSignal | undefined;
    const importer: NonNullable<ConnectedFacadeOptions['officialSnapshotImporter']> = {
      async readOfficialSnapshot(input) {
        observedSignal = input.signal;
        input.onProgress({ phase: 'source_check', bytesCopied: null, totalBytes: null, rowsScanned: null, eligibleCount: null });
        await input.onReady({ sourceIdentityDigest: '2'.repeat(64), snapshotDigest: '3'.repeat(64), schemaVersion: 'line-schema-v1',
          highWatermark: null, eligibleCount: '0' });
        if (phase !== 'after-ready') await input.onPage({ pageNumber: 0, batchDigest: '4'.repeat(64), rows: [], lastCursor: null, hasMore: false });
        reached();
        await new Promise<never>((_resolve, reject) => input.signal.addEventListener('abort', () => reject(new Error('reader cancelled')), { once: true }));
        throw new Error('unreachable');
      },
    };
    await restartFacadeWithImporter(importer);
    expect(await facade.dispatch({ type: 'externalImportStart', requestId: `import-${phase}`, accountId: 'import-admin' })).toMatchObject({ ok: true });
    await reachedPhase;
    let shutdownDone = false;
    const shutdown = facade.shutdown().then(() => { shutdownDone = true; });
    await expect(shutdown).resolves.toBeUndefined();
    expect(observedSignal?.aborted).toBe(true);
    expect(shutdownDone).toBe(true);
  });

  it('maps the close_line_window progress phase to the closing_line_window stage', async () => {
    await addStoredAccounts('close-agent', 'close-admin');
    let reached!: () => void;
    const reachedPhase = new Promise<void>((resolve) => { reached = resolve; });
    const importer: NonNullable<ConnectedFacadeOptions['officialSnapshotImporter']> = {
      async readOfficialSnapshot(input) {
        input.onProgress({ phase: 'close_line_window', bytesCopied: null, totalBytes: null, rowsScanned: null, eligibleCount: null });
        reached();
        await new Promise<never>((_resolve, reject) => input.signal.addEventListener('abort', () => reject(new Error('reader cancelled')), { once: true }));
        throw new Error('unreachable');
      },
    };
    await restartFacadeWithImporter(importer);
    expect(await facade.dispatch({ type: 'externalImportStart', requestId: 'close-window', accountId: 'close-admin' })).toMatchObject({ ok: true });
    await reachedPhase;
    await waitForState(async () => {
      const snapshot = await facade.dispatch({ type: 'getSnapshot', requestId: 'close-window-state' });
      if (snapshot.type !== 'getSnapshot' || !snapshot.ok) throw new Error('snapshot unavailable');
      expect(snapshot.snapshot.accounts.find((item) => item.accountId === 'close-admin')?.externalImportProgress?.stage).toBe('closing_line_window');
    }, { timeout: 15_000, interval: 100 });
    await facade.shutdown();
  });

  it('restarts a changed snapshot from its prefix and completes two committed pages',{ timeout: 60_000 }, async () => {
    await addStoredAccounts('snapshot-agent', 'snapshot-admin');
    const row = (id: string, time: string, text: string) => ({ observationId: id, canonicalMessageId: null as null,
      nativeConversationKind: 'direct', nativeConversationId: 'chat', nativeMessageId: id, chatType: 'direct' as const,
      chatId: 'chat', senderId: 'person', kind: 'text' as const, createdTime: time, text, readonlyForSending: false });
    const first = row('snapshot-row-1', '1', 'one');
    const second = row('snapshot-row-2', '2', 'two');
    const progressPath = join(secretRoot, 'first-import-progress.json');
    const ready = (snapshotDigest: string) => ({ sourceIdentityDigest: '5'.repeat(64), snapshotDigest,
      schemaVersion: 'line-schema-v1', highWatermark: { createdTime: '2', id: 'snapshot-row-2' }, eligibleCount: '2' });
    let firstPageCommitted!: () => void;
    const committed = new Promise<void>((resolve) => { firstPageCommitted = resolve; });
    const interrupted: NonNullable<ConnectedFacadeOptions['officialSnapshotImporter']> = {
      async readOfficialSnapshot(input) {
        await input.onReady(ready('6'.repeat(64)));
        await input.onPage({ pageNumber: 0, batchDigest: '7'.repeat(64), rows: [first],
          lastCursor: { createdTime: '1', id: 'snapshot-row-1' }, hasMore: true });
        firstPageCommitted();
        throw new Error('simulated interruption after a committed page');
      },
    };
    await restartFacadeWithImporter(interrupted, undefined, progressPath);
    await facade.dispatch({ type: 'externalImportStart', requestId: 'snapshot-first-run', accountId: 'snapshot-admin' });
    await committed;
    await waitForState(async () => {
      const capability = await new AccountRepository(pool).resolveCapabilities('snapshot-admin');
      const state = capability?.selectedSourceId && capability.selectedSourceGeneration !== null
        ? await new ExternalMonitorRepository(pool).getInitialImportState({ accountId: 'snapshot-admin',
          sourceId: capability.selectedSourceId, generation: capability.selectedSourceGeneration }) : null;
      expect(state?.committedCount).toBe('1');
    });
    // The progress log is replaced with rename() and is best effort (first-import-progress-log.ts replaceRecord has no
    // retry): reading the file while the import is still writing it makes rename() fail with EPERM on Windows and drops
    // the final record. So do not touch the file during the import; wait for the facade to report the failed stage,
    // then read it once (retrying only transient read errors).
    await waitForState(async () => {
      const snapshot = await facade.dispatch({ type: 'getSnapshot', requestId: 'snapshot-first-run-state' });
      if (snapshot.type !== 'getSnapshot' || !snapshot.ok) throw new Error('snapshot unavailable');
      expect(snapshot.snapshot.accounts.find((item) => item.accountId === 'snapshot-admin')?.externalImportProgress?.stage).toBe('failed');
    }, { timeout: 15_000, interval: 100 });
    let retainedProgress: Record<string, unknown> | undefined;
    for (let attempt = 0; attempt < 20 && !retainedProgress; attempt += 1) {
      try { retainedProgress = JSON.parse(await readFile(progressPath, 'utf8')) as Record<string, unknown>; }
      catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code !== 'ENOENT' && code !== 'EPERM' && code !== 'EBUSY' && !(error instanceof SyntaxError)) throw error;
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
    }
    expect(retainedProgress).toMatchObject({ stage: 'failed', completedPage: 0, committedRows: '1' });
    expect(Object.keys(retainedProgress!).sort()).toEqual(['committedRows', 'completedPage', 'stage', 'updatedAt']);

    let resumeCursor: { createdTime: string; id: string } | null | undefined;
    let resumedPageCommitted!: () => void;
    const resumedCommit = new Promise<void>((resolve) => { resumedPageCommitted = resolve; });
    const resumeSameSnapshot: NonNullable<ConnectedFacadeOptions['officialSnapshotImporter']> = {
      async readOfficialSnapshot(input) {
        resumeCursor = await input.onReady(ready('6'.repeat(64)));
        await input.onPage({ pageNumber: 1, batchDigest: 'b'.repeat(64), rows: [second],
          lastCursor: { createdTime: '2', id: 'snapshot-row-2' }, hasMore: false });
        resumedPageCommitted();
        throw new Error('simulated interruption after resumed page');
      },
    };
    await restartFacadeWithImporter(resumeSameSnapshot, undefined, progressPath);
    await facade.dispatch({ type: 'externalImportStart', requestId: 'snapshot-resume-run', accountId: 'snapshot-admin' });
    await resumedCommit;
    expect(resumeCursor).toEqual({ createdTime: '1', id: 'snapshot-row-1' });
    await waitForState(async () => {
      const capability = await new AccountRepository(pool).resolveCapabilities('snapshot-admin');
      const state = capability?.selectedSourceId && capability.selectedSourceGeneration !== null
        ? await new ExternalMonitorRepository(pool).getInitialImportState({ accountId: 'snapshot-admin',
          sourceId: capability.selectedSourceId, generation: capability.selectedSourceGeneration }) : null;
      expect(state?.committedCount).toBe('2');
    });

    let authorizedCursor: { createdTime: string; id: string } | null | undefined;
    const replacement: NonNullable<ConnectedFacadeOptions['officialSnapshotImporter']> = {
      async readOfficialSnapshot(input) {
        authorizedCursor = await input.onReady(ready('8'.repeat(64)));
        expect(authorizedCursor).toBeNull();
        await input.onPage({ pageNumber: 0, batchDigest: '9'.repeat(64), rows: [first],
          lastCursor: { createdTime: '1', id: 'snapshot-row-1' }, hasMore: true });
        await input.onPage({ pageNumber: 1, batchDigest: 'a'.repeat(64), rows: [second],
          lastCursor: { createdTime: '2', id: 'snapshot-row-2' }, hasMore: false });
        return { sourceIdentityDigest: '5'.repeat(64), snapshotDigest: '8'.repeat(64), pageCount: 2, rowCount: 2,
          highWatermark: { createdTime: '2', id: 'snapshot-row-2' } };
      },
    };
    await restartFacadeWithImporter(replacement, undefined, progressPath);
    await facade.dispatch({ type: 'externalImportStart', requestId: 'snapshot-replacement-run', accountId: 'snapshot-admin' });
    await waitForState(async () => {
      const capability = await new AccountRepository(pool).resolveCapabilities('snapshot-admin');
      const state = capability?.selectedSourceId && capability.selectedSourceGeneration !== null
        ? await new ExternalMonitorRepository(pool).getInitialImportState({ accountId: 'snapshot-admin',
          sourceId: capability.selectedSourceId, generation: capability.selectedSourceGeneration }) : null;
      expect(state).toMatchObject({ initialImportComplete: true, committedCount: '2', cursor: { createdTime: '2', id: 'snapshot-row-2' } });
    }, { timeout: 10_000 });
    // Windows reports EPERM while the progress log is still being unlinked, so wait for the final ENOENT.
    await waitForState(async () => {
      await expect(readFile(progressPath, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
    }, { timeout: 5_000, interval: 50 });
    expect(authorizedCursor).toBeNull();
  });

  it('commits a 2,000-row initial snapshot page and completes at its cursor', { timeout: 60_000 }, async () => {
    await addStoredAccounts('snapshot-500-agent', 'snapshot-500-admin');
    const rows = Array.from({ length: 2000 }, (_, index) => ({
      observationId: `snapshot-500-row-${index + 1}`, canonicalMessageId: null,
      nativeConversationKind: 'direct', nativeConversationId: 'snapshot-500-chat',
      nativeMessageId: `snapshot-500-message-${index + 1}`, chatType: 'direct' as const,
      chatId: 'snapshot-500-chat', senderId: 'person', kind: 'text' as const, createdTime: String(index + 1),
      text: `message ${index + 1}`, readonlyForSending: false,
    }));
    const highWatermark = { createdTime: '2000', id: 'snapshot-500-message-2000' };
    const importer: NonNullable<ConnectedFacadeOptions['officialSnapshotImporter']> = {
      async readOfficialSnapshot(input) {
        await input.onReady({ sourceIdentityDigest: '5'.repeat(64), snapshotDigest: '6'.repeat(64),
          schemaVersion: 'line-schema-v1', highWatermark, eligibleCount: '2000' });
        await input.onPage({ pageNumber: 0, batchDigest: '7'.repeat(64), rows,
          lastCursor: highWatermark, hasMore: false });
        return { sourceIdentityDigest: '5'.repeat(64), snapshotDigest: '6'.repeat(64), pageCount: 1, rowCount: 2000, highWatermark };
      },
    };
    await restartFacadeWithImporter(importer);
    await facade.dispatch({ type: 'externalImportStart', requestId: 'snapshot-500-run', accountId: 'snapshot-500-admin' });
    await waitForState(async () => {
      const capability = await new AccountRepository(pool).resolveCapabilities('snapshot-500-admin');
      const state = capability?.selectedSourceId && capability.selectedSourceGeneration !== null
        ? await new ExternalMonitorRepository(pool).getInitialImportState({ accountId: 'snapshot-500-admin',
          sourceId: capability.selectedSourceId, generation: capability.selectedSourceGeneration }) : null;
      expect(state).toMatchObject({ initialImportComplete: true, committedCount: '2000', cursor: highWatermark });
    }, { timeout: 15_000, interval: 100 });
  });

  it('completes a resumed snapshot only after the committed prefix plus suffix matches the durable total', async () => {
    await addStoredAccounts('resume-agent', 'resume-admin');
    const row = (id: string, time: string) => ({ observationId: id, canonicalMessageId: null as null,
      nativeConversationKind: 'direct', nativeConversationId: 'resume-chat', nativeMessageId: id, chatType: 'direct' as const,
      chatId: 'resume-chat', senderId: 'person', kind: 'text' as const, createdTime: time, text: id, readonlyForSending: false });
    const prefix = row('resume-prefix', '1');
    const suffix = row('resume-suffix', '2');
    const ready = { sourceIdentityDigest: 'b'.repeat(64), snapshotDigest: 'c'.repeat(64), schemaVersion: 'line-schema-v1',
      highWatermark: { createdTime: '2', id: 'resume-suffix' }, eligibleCount: '2' };
    let firstPageCommitted!: () => void;
    const firstCommitted = new Promise<void>((resolve) => { firstPageCommitted = resolve; });
    const firstRun: NonNullable<ConnectedFacadeOptions['officialSnapshotImporter']> = {
      async readOfficialSnapshot(input) {
        await input.onReady(ready);
        await input.onPage({ pageNumber: 0, batchDigest: 'd'.repeat(64), rows: [prefix],
          lastCursor: { createdTime: '1', id: 'resume-prefix' }, hasMore: true });
        firstPageCommitted();
        throw new Error('simulated interruption after committed prefix');
      },
    };
    await restartFacadeWithImporter(firstRun);
    await facade.dispatch({ type: 'externalImportStart', requestId: 'resume-prefix-run', accountId: 'resume-admin' });
    await firstCommitted;
    await waitForState(async () => {
      const snapshot = await facade.dispatch({ type: 'getSnapshot', requestId: 'resume-prefix-state' });
      if (snapshot.type !== 'getSnapshot' || !snapshot.ok) throw new Error('snapshot unavailable');
      expect(snapshot.snapshot.accounts.find((item) => item.accountId === 'resume-admin')?.externalImportProgress?.stage).toBe('failed');
    }, { timeout: 10_000, interval: 100 });

    let cursor: { createdTime: string; id: string } | null | undefined;
    let durableAtAck = '0';
    const resumed: NonNullable<ConnectedFacadeOptions['officialSnapshotImporter']> = {
      async readOfficialSnapshot(input) {
        cursor = await input.onReady(ready);
        await input.onPage({ pageNumber: 0, batchDigest: 'e'.repeat(64), rows: [suffix],
          lastCursor: { createdTime: '2', id: 'resume-suffix' }, hasMore: false });
        const capability = await new AccountRepository(pool).resolveCapabilities('resume-admin');
        const state = capability?.selectedSourceId && capability.selectedSourceGeneration !== null
          ? await new ExternalMonitorRepository(pool).getInitialImportState({ accountId: 'resume-admin',
            sourceId: capability.selectedSourceId, generation: capability.selectedSourceGeneration }) : null;
        durableAtAck = state?.committedCount ?? '0';
        return { sourceIdentityDigest: ready.sourceIdentityDigest, snapshotDigest: ready.snapshotDigest, pageCount: 1, rowCount: 2,
          highWatermark: ready.highWatermark };
      },
    };
    await restartFacadeWithImporter(resumed);
    await facade.dispatch({ type: 'externalImportStart', requestId: 'resume-suffix-run', accountId: 'resume-admin' });
    await waitForState(async () => {
      const snapshot = await facade.dispatch({ type: 'getSnapshot', requestId: 'resume-complete-state' });
      if (snapshot.type !== 'getSnapshot' || !snapshot.ok) throw new Error('snapshot unavailable');
      expect(snapshot.snapshot.accounts.find((item) => item.accountId === 'resume-admin')?.externalImportProgress?.stage).toBe('failed');
    }, { timeout: 10_000, interval: 100 });
    expect(cursor).toEqual({ createdTime: '1', id: 'resume-prefix' });
    expect(durableAtAck).toBe('2');
    const capability = await new AccountRepository(pool).resolveCapabilities('resume-admin');
    const repository = new ExternalMonitorRepository(pool);
    const unfinished = capability?.selectedSourceId && capability.selectedSourceGeneration !== null
      ? await repository.getInitialImportState({ accountId: 'resume-admin', sourceId: capability.selectedSourceId,
        generation: capability.selectedSourceGeneration }) : null;
    expect(unfinished).toMatchObject({ initialImportComplete: false, committedCount: '2' });

    await seedExternalProbeAttachment('resume-admin', 'resume-chat', 'resume-probe-message', 'probe.bin');

    const finishFromCommittedHighWater: NonNullable<ConnectedFacadeOptions['officialSnapshotImporter']> = {
      async readOfficialSnapshot(input) {
        const resume = await input.onReady(ready);
        expect(resume).toEqual({ createdTime: '2', id: 'resume-suffix' });
        return { sourceIdentityDigest: ready.sourceIdentityDigest, snapshotDigest: ready.snapshotDigest, pageCount: 0, rowCount: 0,
          highWatermark: ready.highWatermark };
      },
      async readOfficialMonitor(input) {
        input.onReady?.({
          async acquireAuthCandidates() { return { candidates: [
            { token: 'candidate-one', application: 'DESKTOPWIN\t26.4.2.3957\tWINDOWS\t10.0.0-NT-x64' },
            { token: 'candidate-two', application: 'DESKTOPWIN\t26.5.1.4180\tWINDOWS\t10.0.0-NT-x64' },
          ], errorCode: null }; },
          async decodeAttachment() {
            return {
              metadata: {
                messageId: 'resume-probe-message',
                chatId: 'resume-chat',
                from: null,
                to: null,
                toType: null,
                contentType: 14,
                contentMetadata: { OID: 'OID_123', SID: 'emf', OBS_POP: null, FILE_SIZE: '2', MEDIA_CONTENT_INFO: null, DOWNLOAD_URL: null },
                keyMaterial: Buffer.alloc(32, 7).toString('base64'),
                fileName: 'probe.bin',
                sizeBytes: 2,
              },
              errorCode: null,
            };
          },
        }, input.signal);
        await new Promise<void>((resolve) => {
          if (input.signal.aborted) resolve();
          else input.signal.addEventListener('abort', () => resolve(), { once: true });
        });
      },
    };
    await restartFacadeWithImporter(finishFromCommittedHighWater, undefined, undefined, true);
    await facade.dispatch({ type: 'externalImportStart', requestId: 'resume-finish-run', accountId: 'resume-admin' });
    await waitForState(async () => {
      const snapshot = await facade.dispatch({ type: 'getSnapshot', requestId: 'resume-finish-state' });
      if (snapshot.type !== 'getSnapshot' || !snapshot.ok) throw new Error('snapshot unavailable');
      expect(snapshot.snapshot.accounts.find((item) => item.accountId === 'resume-admin')?.externalImportProgress?.stage).toBe('monitoring');
    }, { timeout: 10_000, interval: 100 });
    await waitForState(() => {
      expect(commands.filter((command) => command.type === 'adoptDownloadAuth').map((command) => [command.token, command.application])).toEqual([
        ['candidate-one', 'DESKTOPWIN\t26.4.2.3957\tWINDOWS\t10.0.0-NT-x64'],
        ['candidate-two', 'DESKTOPWIN\t26.5.1.4180\tWINDOWS\t10.0.0-NT-x64'],
      ]);
      expect(commands.find((command) => command.type === 'adoptDownloadAuth')).toMatchObject({
        probe: expect.objectContaining({ messageId: 'resume-probe-message', externalAttachmentId: 'resume-probe-message' }),
      });
    });
    expect(starts).toContainEqual(expect.objectContaining({ accountId: 'resume-admin', mode: 'MONITOR_ONLY' }));
  });

  it('does not retry later auth candidates after accepted adoption while restart readiness is still settling', async () => {
    await addStoredAccounts('auth-ready-agent', 'auth-ready-admin');
    acceptedDownloadToken = 'candidate-one';
    markDownloadReadyOnAccept = false;
    const ready = { sourceIdentityDigest: '3'.repeat(64), snapshotDigest: '4'.repeat(64), schemaVersion: 'line-schema-v1',
      highWatermark: null, eligibleCount: '0' };
    const importer: NonNullable<ConnectedFacadeOptions['officialSnapshotImporter']> = {
      async readOfficialSnapshot(input) {
        await input.onReady(ready);
        await seedExternalProbeAttachment('auth-ready-admin', 'auth-ready-chat', 'auth-ready-small-message', 'small.bin', 2, 3);
        await seedExternalProbeAttachment('auth-ready-admin', 'auth-ready-chat', 'auth-ready-probe-message', 'probe.bin', 209715200, 1);
        return { sourceIdentityDigest: ready.sourceIdentityDigest, snapshotDigest: ready.snapshotDigest,
          pageCount: 0, rowCount: 0, highWatermark: null };
      },
      async readOfficialMonitor(input) {
        const callbackLifetime = new AbortController();
        const callbackResult = input.onReady?.({ async acquireAuthCandidates() { return { candidates: [
          { token: 'candidate-one', application: 'DESKTOPWIN\t26.4.2.3957\tWINDOWS\t10.0.0-NT-x64' },
          { token: 'candidate-two', application: 'DESKTOPWIN\t26.5.1.4180\tWINDOWS\t10.0.0-NT-x64' },
        ], errorCode: null }; }, async decodeAttachment() {
          return {
            metadata: {
              messageId: 'auth-ready-probe-message',
              chatId: 'auth-ready-chat',
              from: null,
              to: null,
              toType: null,
              contentType: 14,
              contentMetadata: { OID: 'OID_123', SID: 'emf', OBS_POP: null, FILE_SIZE: '209715200', MEDIA_CONTENT_INFO: null, DOWNLOAD_URL: null },
              keyMaterial: Buffer.alloc(32, 7).toString('base64'),
              fileName: 'probe.bin',
              sizeBytes: 209715200,
            },
            errorCode: null,
          };
        } }, callbackLifetime.signal);
        expect(callbackResult).toBeUndefined();
        callbackLifetime.abort();
        await new Promise<void>((resolve) => input.signal.addEventListener('abort', () => resolve(), { once: true }));
      },
    };
    await restartFacadeWithImporter(importer, undefined, undefined, true);
    expect(await facade.dispatch({ type: 'externalImportStart', requestId: 'auth-ready-run', accountId: 'auth-ready-admin' }))
      .toMatchObject({ ok: true });
    await waitForState(() => expect(commands.filter((command) => command.type === 'adoptDownloadAuth')
      .map((command) => command.token)).toEqual(['candidate-one']), { timeout: 10_000, interval: 100 });
    expect(downloadReadyBindings.size).toBe(0);
    // The newest probe attachment is 200 MiB; adoption must not be gated by the download byte cap.
    expect(commands.find((command) => command.type === 'adoptDownloadAuth')).toMatchObject({
      probe: expect.objectContaining({ messageId: 'auth-ready-probe-message' }) });
    expect((commands.find((command) => command.type === 'adoptDownloadAuth') as any).probe).not.toHaveProperty('maxBytes');
  });

  it('skips scraping and testing download auth candidates when no recent external attachment exists in the database', async () => {
    await addStoredAccounts('no-probe-agent', 'no-probe-admin');
    let acquireAuthCalled = 0;
    const ready = { sourceIdentityDigest: '5'.repeat(64), snapshotDigest: '6'.repeat(64), schemaVersion: 'line-schema-v1',
      highWatermark: null, eligibleCount: '0' };
    const importer: NonNullable<ConnectedFacadeOptions['officialSnapshotImporter']> = {
      async readOfficialSnapshot(input) {
        await input.onReady(ready);
        return { sourceIdentityDigest: ready.sourceIdentityDigest, snapshotDigest: ready.snapshotDigest,
          pageCount: 0, rowCount: 0, highWatermark: null };
      },
      async readOfficialMonitor(input) {
        input.onReady?.({
          async acquireAuthCandidates() {
            acquireAuthCalled += 1;
            return { candidates: [{ token: 'candidate-one', application: 'DESKTOPWIN\t26.5.1.4180\tWINDOWS\t10.0.0-NT-x64' }], errorCode: null };
          },
          async decodeAttachment() { return { metadata: null, errorCode: 'not_requested' }; },
        }, input.signal);
        await new Promise<void>((resolve) => input.signal.addEventListener('abort', () => resolve(), { once: true }));
      },
    };
    await restartFacadeWithImporter(importer, undefined, undefined, true);
    expect(await facade.dispatch({ type: 'externalImportStart', requestId: 'no-probe-run', accountId: 'no-probe-admin' }))
      .toMatchObject({ ok: true });
    await waitForState(async () => {
      const snapshot = await facade.dispatch({ type: 'getSnapshot', requestId: 'no-probe-state' });
      if (snapshot.type !== 'getSnapshot' || !snapshot.ok) throw new Error('snapshot unavailable');
      expect(snapshot.snapshot.accounts.find((item) => item.accountId === 'no-probe-admin')?.externalImportProgress?.stage).toBe('monitoring');
    }, { timeout: 10_000, interval: 100 });
    await waitForState(() => expect(stoppedWorkerInstances.length).toBeGreaterThanOrEqual(1));
    expect(acquireAuthCalled).toBe(0);
    expect(commands.filter((command) => command.type === 'adoptDownloadAuth')).toEqual([]);
  });

  it('does not request official auth candidates or adopt a download token when monitoring becomes ready', async () => {
    await addStoredAccounts('auth-ready-agent', 'auth-ready-admin');
    acceptedDownloadToken = 'candidate-one';
    const ready = { sourceIdentityDigest: '3'.repeat(64), snapshotDigest: '4'.repeat(64), schemaVersion: 'line-schema-v1',
      highWatermark: null, eligibleCount: '0' };
    let authRequests = 0;
    let readyCalled = false;
    const importer: NonNullable<ConnectedFacadeOptions['officialSnapshotImporter']> = {
      async readOfficialSnapshot(input) {
        await input.onReady(ready);
        return { sourceIdentityDigest: ready.sourceIdentityDigest, snapshotDigest: ready.snapshotDigest,
          pageCount: 0, rowCount: 0, highWatermark: null };
      },
      async readOfficialMonitor(input) {
        const callbackLifetime = new AbortController();
        const callbackResult = input.onReady?.({ async acquireAuthCandidates() { authRequests++; return { candidates: [
          { token: 'candidate-one', application: 'DESKTOPWIN\t26.4.2.3957\tWINDOWS\t10.0.0-NT-x64' },
        ], errorCode: null }; }, async decodeAttachment() { return { metadata: null, errorCode: 'not_requested' }; } }, callbackLifetime.signal);
        expect(callbackResult).toBeUndefined();
        readyCalled = true;
        await new Promise((resolve) => setTimeout(resolve, 100));
        callbackLifetime.abort();
        await new Promise<void>((resolve) => {
          if (input.signal.aborted) resolve();
          else input.signal.addEventListener('abort', () => resolve(), { once: true });
        });
      },
    };
    await restartFacadeWithImporter(importer);
    expect(await facade.dispatch({ type: 'externalImportStart', requestId: 'auth-ready-run', accountId: 'auth-ready-admin' }))
      .toMatchObject({ ok: true });
    await waitForState(() => expect(readyCalled).toBe(true), { timeout: 10_000, interval: 100 });
    expect(authRequests).toBe(0);
    expect(commands.filter((command) => command.type === 'adoptDownloadAuth')).toEqual([]);
    expect(downloadReadyBindings.size).toBe(0);
  });

  it('does not start a download-only worker or adopt official tokens when an external attachment download is requested', async () => {
    await addStoredAccounts('auth-off-agent', 'auth-off-admin');
    const repository = new ExternalMonitorRepository(pool);
    const accountId = 'auth-off-admin';
    const cursor = { createdTime: '1792000000000', id: 'auth-off-message' };
    const source = await repository.bindVerifiedExternalSource({ accountId, ownMid: `own-${accountId}`,
      sourceIdentity: 'auth-off-source', initialImport: { snapshotDigest: 'b'.repeat(64), schemaVersion: 'line-schema-v1',
        highWater: cursor, eligibleCount: '1' } });
    await repository.stageAndProjectBatch({ accountId, sourceId: source.sourceId, generation: source.generation,
      expectedModeRevision: source.modeRevision, expectedCheckpoint: {}, batchId: 'auth-off-initial-page', cursor,
      initialImport: true, observations: [{ observationId: 'auth-off-observation', canonicalMessageId: 'auth-off-message',
        nativeConversationKind: 'group', nativeConversationId: 'auth-off-chat', nativeMessageId: 'auth-off-message',
        chatType: 'group', chatId: 'auth-off-chat', senderId: 'person', kind: 'file', text: null,
        occurredAt: '2026-10-18T00:00:00.000Z', nativePayload: { format: 1, table: '_message', sourceDigest: 'c'.repeat(64),
          encoding: 'dpapi', data: 'AQID' }, attachments: [{ id: 'auth-off-message', kind: 'file', name: 'retry.txt',
          mimeType: null, sizeBytes: 2, expiresAt: null }] }] });
    await repository.completeInitialImport({ accountId, sourceId: source.sourceId, generation: source.generation,
      expectedModeRevision: source.modeRevision, expectedCheckpoint: cursor, finalCursor: cursor, highWater: cursor });

    let monitorStarted!: () => void; const monitorStartedPromise = new Promise<void>((resolve) => { monitorStarted = resolve; });
    let authRequests = 0;
    const importer: NonNullable<ConnectedFacadeOptions['officialSnapshotImporter']> = {
      async readOfficialSnapshot() { throw new Error('completed source must skip history import'); },
      async readOfficialMonitor(input) {
        input.onReady?.({ async acquireAuthCandidates() { authRequests++; return { candidates: [
          { token: 'candidate-one', application: 'DESKTOPWIN\t26.4.2.3957\tWINDOWS\t10.0.0-NT-x64' },
        ], errorCode: null }; }, async decodeAttachment() { return { metadata: null, errorCode: null }; } }, input.signal);
        monitorStarted();
        await new Promise<void>((resolve) => {
          if (input.signal.aborted) resolve();
          else input.signal.addEventListener('abort', () => resolve(), { once: true });
        });
      },
    };
    await restartFacadeWithImporter(importer);
    try {
      await monitorStartedPromise;
      const attachment = await new MessageRepository(pool).getAttachmentBySource({ accountId, chatType: 'group', chatId: 'auth-off-chat' },
        'auth-off-message', 'auth-off-message');
      expect(attachment).toMatchObject({ status: 'queued', externalSource: true });
      await facade.downloadAttachment({ accountId, chatType: 'group', chatId: 'auth-off-chat' }, attachment!.attachmentId);
      expect(authRequests).toBe(0);
      expect(commands.filter((command) => command.type === 'adoptDownloadAuth')).toEqual([]);
      expect(bindings.get(accountId)?.purpose).not.toBe('DOWNLOAD_ONLY');
      expect(await facade.dispatch({ type: 'getSnapshot', requestId: 'auth-off-monitor-snapshot' }))
        .toMatchObject({ type: 'getSnapshot', ok: true });
    } finally {
      await facade.dispatch({ type: 'externalImportStop', requestId: 'auth-off-monitor-stop', accountId });
    }
  });

  it('completes a nonempty partial resume followed by the native empty terminal page shape', async () => {
    await addStoredAccounts('terminal-resume-agent', 'terminal-resume-admin');
    const row = (id: string, time: string) => ({ observationId: id, canonicalMessageId: null as null,
      nativeConversationKind: 'direct', nativeConversationId: 'terminal-chat', nativeMessageId: id, chatType: 'direct' as const,
      chatId: 'terminal-chat', senderId: 'person', kind: 'text' as const, createdTime: time, text: id, readonlyForSending: false });
    const first = row('terminal-prefix', '1');
    const last = row('terminal-suffix', '2');
    const ready = { sourceIdentityDigest: '3'.repeat(64), snapshotDigest: '4'.repeat(64), schemaVersion: 'line-schema-v1',
      highWatermark: { createdTime: '2', id: 'terminal-suffix' }, eligibleCount: '2' };
    const interrupted: NonNullable<ConnectedFacadeOptions['officialSnapshotImporter']> = {
      async readOfficialSnapshot(input) {
        await input.onReady(ready);
        await input.onPage({ pageNumber: 0, batchDigest: '5'.repeat(64), rows: [first],
          lastCursor: { createdTime: '1', id: 'terminal-prefix' }, hasMore: true });
        throw new Error('interrupted after committed prefix');
      },
    };
    await restartFacadeWithImporter(interrupted);
    await facade.dispatch({ type: 'externalImportStart', requestId: 'terminal-prefix-run', accountId: 'terminal-resume-admin' });
    await waitForState(async () => {
      const snapshot = await facade.dispatch({ type: 'getSnapshot', requestId: 'terminal-prefix-state' });
      if (snapshot.type !== 'getSnapshot' || !snapshot.ok) throw new Error('snapshot unavailable');
      expect(snapshot.snapshot.accounts.find((item) => item.accountId === 'terminal-resume-admin')?.externalImportProgress?.stage).toBe('failed');
    }, { timeout: 10_000, interval: 100 });

    let resumeCursor: { createdTime: string; id: string } | null | undefined;
    let committedBeforeComplete = '0';
    const resumed: NonNullable<ConnectedFacadeOptions['officialSnapshotImporter']> = {
      async readOfficialSnapshot(input) {
        resumeCursor = await input.onReady(ready);
        await input.onPage({ pageNumber: 0, batchDigest: '6'.repeat(64), rows: [last],
          lastCursor: { createdTime: '2', id: 'terminal-suffix' }, hasMore: false });
        await input.onPage({ pageNumber: 1, batchDigest: '7'.repeat(64), rows: [], lastCursor: null, hasMore: false });
        const capability = await new AccountRepository(pool).resolveCapabilities('terminal-resume-admin');
        const state = capability?.selectedSourceId && capability.selectedSourceGeneration !== null
          ? await new ExternalMonitorRepository(pool).getInitialImportState({ accountId: 'terminal-resume-admin',
            sourceId: capability.selectedSourceId, generation: capability.selectedSourceGeneration }) : null;
        committedBeforeComplete = state?.committedCount ?? '0';
        return { sourceIdentityDigest: ready.sourceIdentityDigest, snapshotDigest: ready.snapshotDigest, pageCount: 2, rowCount: 1,
          highWatermark: ready.highWatermark };
      },
      async readOfficialMonitor(input) {
        await new Promise<void>((resolve) => {
          if (input.signal.aborted) resolve();
          else input.signal.addEventListener('abort', () => resolve(), { once: true });
        });
      },
    };
    await restartFacadeWithImporter(resumed);
    await facade.dispatch({ type: 'externalImportStart', requestId: 'terminal-resume-run', accountId: 'terminal-resume-admin' });
    await waitForState(async () => {
      const snapshot = await facade.dispatch({ type: 'getSnapshot', requestId: 'terminal-resume-state' });
      if (snapshot.type !== 'getSnapshot' || !snapshot.ok) throw new Error('snapshot unavailable');
      expect(snapshot.snapshot.accounts.find((item) => item.accountId === 'terminal-resume-admin')?.externalImportProgress?.stage).toBe('monitoring');
    }, { timeout: 10_000, interval: 100 });
    expect(resumeCursor).toEqual({ createdTime: '1', id: 'terminal-prefix' });
    expect(committedBeforeComplete).toBe('2');
    const capability = await new AccountRepository(pool).resolveCapabilities('terminal-resume-admin');
    const state = capability?.selectedSourceId && capability.selectedSourceGeneration !== null
      ? await new ExternalMonitorRepository(pool).getInitialImportState({ accountId: 'terminal-resume-admin',
        sourceId: capability.selectedSourceId, generation: capability.selectedSourceGeneration }) : null;
    expect(state).toMatchObject({ initialImportComplete: true, committedCount: '2', cursor: { createdTime: '2', id: 'terminal-suffix' } });
  });

  it('emits one scoped refresh after a changed direct round reaches its terminal committed page', async () => {
    await addStoredAccounts('round-agent', 'round-admin');
    const row = (id: string, time: string, text: string, observationId = id) => ({ observationId, canonicalMessageId: null as null,
      nativeConversationKind: 'direct', nativeConversationId: 'round-chat', nativeMessageId: id, chatType: 'direct' as const,
      chatId: 'round-chat', senderId: 'person', kind: 'text' as const, createdTime: time, text, readonlyForSending: false });
    const history = row('round-history', '1', 'before');
    const changedHistory = row('round-history', '1', 'updated', 'round-history');
    const backdated = row('round-backdated', '0', 'late');
    const forward = row('round-forward', '2', 'forward');
    const ready = { sourceIdentityDigest: '8'.repeat(64), snapshotDigest: '9'.repeat(64), schemaVersion: 'line-schema-v1',
      highWatermark: { createdTime: '1', id: 'round-history' }, eligibleCount: '1' };
    let firstPageCursor: Record<string, unknown> | null = null;
    let noRefreshAfterFirstPage = false;
    let reachedTerminal!: () => void;
    const terminal = new Promise<void>((resolve) => { reachedTerminal = resolve; });
    let monitorAttempts = 0;
    let publishedStateAtRefresh: Promise<void> | undefined;
    const importer: NonNullable<ConnectedFacadeOptions['officialSnapshotImporter']> = {
      async readOfficialSnapshot(input) {
        await input.onReady(ready);
        await input.onPage({ pageNumber: 0, batchDigest: 'a'.repeat(64), rows: [history],
          lastCursor: ready.highWatermark, hasMore: false });
        return { sourceIdentityDigest: ready.sourceIdentityDigest, snapshotDigest: ready.snapshotDigest, pageCount: 1, rowCount: 1,
          highWatermark: ready.highWatermark };
      },
      async readOfficialMonitor(input) {
        monitorAttempts++;
        if (monitorAttempts === 1) {
          expect(input.cursor).toEqual(ready.highWatermark);
          firstPageCursor = await input.onPage({ pageNumber: 1, batchDigest: 'b'.repeat(64), rows: [forward],
            tailRows: [changedHistory, backdated], lastCursor: { createdTime: '2', id: 'round-forward' }, hasMore: true }, input.signal) as Record<string, unknown>;
          const capability = await new AccountRepository(pool).resolveCapabilities('round-admin');
          const state = capability?.selectedSourceId && capability.selectedSourceGeneration !== null
            ? await new ExternalMonitorRepository(pool).getInitialImportState({ accountId: 'round-admin', sourceId: capability.selectedSourceId,
              generation: capability.selectedSourceGeneration }) : null;
          expect(state?.cursor).toEqual({ createdTime: '2', id: 'round-forward' });
          noRefreshAfterFirstPage = !published.some((event) => event.type === 'externalMonitorRoundComplete' || event.type === 'messageStored');
          throw new Error('simulated interruption after committed nonterminal round page');
        }
        expect(input.cursor).toEqual({ createdTime: '2', id: 'round-forward' });
        await input.onPage({ pageNumber: 2, batchDigest: 'c'.repeat(64), rows: [],
          tailRows: [changedHistory, backdated, forward], lastCursor: { createdTime: '2', id: 'round-forward' }, hasMore: false }, input.signal);
        reachedTerminal();
        await new Promise<void>((resolve) => {
          if (input.signal.aborted) resolve();
          else input.signal.addEventListener('abort', () => resolve(), { once: true });
        });
      },
    };
    const runSpy = vi.spyOn(agent, 'run');
    await restartFacadeWithImporter(importer, (event) => {
      if (event.type === 'externalMonitorRoundComplete') {
        publishedStateAtRefresh = (async () => {
          const capability = await new AccountRepository(pool).resolveCapabilities('round-admin');
          const state = capability?.selectedSourceId && capability.selectedSourceGeneration !== null
            ? await new ExternalMonitorRepository(pool).getInitialImportState({ accountId: 'round-admin', sourceId: capability.selectedSourceId,
              generation: capability.selectedSourceGeneration }) : null;
          expect(state?.cursor).toEqual({ createdTime: '2', id: 'round-forward' });
          const stored = await pool.query(`SELECT message_id,text_content FROM messages WHERE account_id='round-admin' ORDER BY message_id`);
          expect(stored.rows).toEqual(expect.arrayContaining([
            expect.objectContaining({ message_id: expect.any(String), text_content: 'updated' }),
            expect.objectContaining({ message_id: expect.any(String), text_content: 'late' }),
            expect.objectContaining({ message_id: expect.any(String), text_content: 'forward' }),
          ]));
        })();
      }
    });
    expect(await facade.dispatch({ type: 'externalImportStart', requestId: 'monitor-round-start', accountId: 'round-admin' }))
      .toMatchObject({ ok: true });
    await waitForState(async () => {
      const snapshot = await facade.dispatch({ type: 'getSnapshot', requestId: 'monitor-round-interrupted' });
      if (snapshot.type !== 'getSnapshot' || !snapshot.ok) throw new Error('snapshot unavailable');
      expect(snapshot.snapshot.accounts.find((item) => item.accountId === 'round-admin')?.externalImportProgress?.stage).toBe('failed');
    }, { timeout: 10_000, interval: 100 });
    expect(published.some((event) => event.type === 'externalMonitorRoundComplete')).toBe(false);
    expect(await facade.dispatch({ type: 'externalImportStart', requestId: 'monitor-round-resume', accountId: 'round-admin' }))
      .toMatchObject({ ok: true });
    await terminal;
    await publishedStateAtRefresh;
    expect(firstPageCursor).toEqual({ createdTime: '2', id: 'round-forward' });
    expect(noRefreshAfterFirstPage).toBe(true);
    expect(monitorAttempts).toBe(2);
    expect(published.filter((event) => event.type === 'externalMonitorRoundComplete')).toEqual([
      { type: 'externalMonitorRoundComplete', accountId: 'round-admin' },
    ]);
    expect(published.some((event) => event.type === 'messageStored')).toBe(false);
    expect(commands.some((command) => command.type === 'sendText' || command.type === 'manualSendText' || command.type === 'loginToken')).toBe(false);
    expect(runSpy).not.toHaveBeenCalled();
    runSpy.mockRestore();
  });

  it('fails closed on unsupported snapshot rows before committing a page', async () => {
    await addStoredAccounts('unsupported-agent', 'unsupported-admin');
    const importer: NonNullable<ConnectedFacadeOptions['officialSnapshotImporter']> = {
      async readOfficialSnapshot(input) {
        await input.onReady({ sourceIdentityDigest: 'c'.repeat(64), snapshotDigest: 'd'.repeat(64),
          schemaVersion: 'line-schema-v1', highWatermark: { createdTime: '1', id: 'unsupported-row' }, eligibleCount: '1' });
        await input.onPage({ pageNumber: 0, batchDigest: 'e'.repeat(64), rows: [{ observationId: 'unsupported-row',
          canonicalMessageId: null, nativeConversationKind: 'unknown', nativeConversationId: 'chat', nativeMessageId: 'message',
          chatType: 'unsupported', chatId: 'chat', senderId: 'person', kind: 'text', createdTime: '1', text: 'ignored',
          readonlyForSending: false }], lastCursor: { createdTime: '1', id: 'unsupported-row' }, hasMore: false });
        throw new Error('unsupported row should have stopped the reader');
      },
    };
    await restartFacadeWithImporter(importer);
    expect(await facade.dispatch({ type: 'externalImportStart', requestId: 'unsupported-snapshot', accountId: 'unsupported-admin' }))
      .toMatchObject({ ok: true });
    await waitForState(async () => {
      const snapshot = await facade.dispatch({ type: 'getSnapshot', requestId: 'unsupported-snapshot-state' });
      if (snapshot.type !== 'getSnapshot' || !snapshot.ok) throw new Error('snapshot unavailable');
      expect(snapshot.snapshot.accounts.find((item) => item.accountId === 'unsupported-admin')?.externalImportProgress?.stage).toBe('failed');
    }, { timeout: 10_000, interval: 100 });
    const capability = await new AccountRepository(pool).resolveCapabilities('unsupported-admin');
    const state = capability?.selectedSourceId && capability.selectedSourceGeneration !== null
      ? await new ExternalMonitorRepository(pool).getInitialImportState({ accountId: 'unsupported-admin',
        sourceId: capability.selectedSourceId, generation: capability.selectedSourceGeneration }) : null;
    expect(state).toMatchObject({ initialImportComplete: false, committedCount: '0' });
  });

  it('archives read-only community rows with source metadata instead of rejecting them as unsendable', async () => {
    await addStoredAccounts('community-agent', 'community-admin');
    const importer: NonNullable<ConnectedFacadeOptions['officialSnapshotImporter']> = {
      async readOfficialSnapshot(input) {
        await input.onReady({ sourceIdentityDigest: 'c'.repeat(64), snapshotDigest: 'd'.repeat(64),
          schemaVersion: 'line-schema-v1', highWatermark: { createdTime: '2', id: 'community-message-invalid-name' }, eligibleCount: '2' });
        await input.onPage({ pageNumber: 0, batchDigest: 'e'.repeat(64), rows: [{ observationId: 'official-line-db:community-message',
          canonicalMessageId: null, nativeConversationKind: 'midType:4', nativeConversationId: 'community-id', nativeMessageId: 'community-message',
          chatType: 'community', chatId: 'community-id', senderId: 'sender', senderName: 'Native Square Nickname', kind: 'text', createdTime: '1', text: 'stored',
          readonlyForSending: true, conversationTitle: 'Community title',
          nativeMetadata: { midType: 4, parentChatId: null, communityId: 'community-id' }, nativeContentType: 0,
        }, { observationId: 'official-line-db:community-message-invalid-name', canonicalMessageId: null,
          nativeConversationKind: 'midType:4', nativeConversationId: 'community-id', nativeMessageId: 'community-message-invalid-name',
          chatType: 'community', chatId: 'community-id', senderId: 'malformed-sender', senderName: { invalid: true },
          kind: 'text', createdTime: '2', text: 'also stored', readonlyForSending: true, conversationTitle: 'Community title',
          nativeMetadata: { midType: 4, parentChatId: null, communityId: 'community-id' }, nativeContentType: 0,
        }] as unknown as Parameters<typeof input.onPage>[0]['rows'], lastCursor: { createdTime: '2', id: 'community-message-invalid-name' }, hasMore: false });
        return { sourceIdentityDigest: 'c'.repeat(64), snapshotDigest: 'd'.repeat(64), pageCount: 1, rowCount: 2,
          highWatermark: { createdTime: '2', id: 'community-message-invalid-name' } };
      },
      async readOfficialMonitor() {},
    };
    await restartFacadeWithImporter(importer);
    expect(await facade.dispatch({ type: 'externalImportStart', requestId: 'community-snapshot', accountId: 'community-admin' }))
      .toMatchObject({ ok: true });
    await waitForState(async () => {
      const snapshot = await facade.dispatch({ type: 'getSnapshot', requestId: 'community-snapshot-state' });
      if (snapshot.type !== 'getSnapshot' || !snapshot.ok) throw new Error('snapshot unavailable');
      const progress = snapshot.snapshot.accounts.find((item) => item.accountId === 'community-admin')?.externalImportProgress;
      if (progress?.stage !== 'monitoring') throw new Error(progress?.message ?? `Import stage was ${progress?.stage ?? 'missing'}`);
    }, { timeout: 10_000, interval: 100 });
    const row = await pool.query(`SELECT m.message_id,m.chat_type,c.title,c.native_metadata FROM messages m
      JOIN conversations c ON c.account_id=m.account_id AND c.chat_type=m.chat_type AND c.chat_id=m.chat_id
      WHERE m.account_id='community-admin' AND m.message_id='community-message'`);
    expect(row.rows).toEqual([{ message_id: 'community-message', chat_type: 'community', title: 'Community title',
      native_metadata: { midType: 4, parentChatId: null, communityId: 'community-id' } }]);
    const sender = await pool.query(`SELECT display_name FROM conversation_members WHERE account_id='community-admin'
      AND chat_type='community' AND chat_id='community-id' AND member_id='sender'`);
    expect(sender.rows).toEqual([{ display_name: 'Native Square Nickname' }]);
    const malformedNameRow = await pool.query(`SELECT message_id FROM messages WHERE account_id='community-admin'
      AND message_id='community-message-invalid-name'`);
    expect(malformedNameRow.rows).toEqual([{ message_id: 'community-message-invalid-name' }]);
    const malformedSender = await pool.query(`SELECT display_name FROM conversation_members WHERE account_id='community-admin'
      AND chat_type='community' AND chat_id='community-id' AND member_id='malformed-sender'`);
    expect(malformedSender.rows).toEqual([]);
    expect(commands.some((command) => command.type === 'sendText' || command.type === 'manualSendText')).toBe(false);
    expect(await new AccountRepository(pool).resolveCapabilities('community-admin')).toMatchObject({ canWriteLine: false });
  });

  describe('startup auto-login opt-in', () => {
    async function storeToken(accountId: string) {
      secretStore.beginLogin(accountId, 'seed-instance', 'seed-attempt');
      expect(await secretStore.saveRotation(accountId, 'seed-instance', 'seed-attempt',
        { token: `token-${accountId}`, qrCert: null, e2eeStorage: null })).toBe(true);
    }
    async function restartFacade() {
      await facade.shutdown();
      starts.length = 0; commands.length = 0; bindings.clear();
      facade = await createConnectedFacade({ pool, workers, agent, attachmentRoot: 'C:\attachments', secretStore, audit,
        runMigrations: false, publish(event) { published.push(event); } });
    }

    it('skips startup login for accounts without the opt-in and keeps their secrets', async () => {
      await addStoredAccounts('auto-off-agent');
      await storeToken('auto-off-agent');
      await pool.query("UPDATE line_accounts SET status='connected' WHERE account_id='auto-off-agent'");
      await restartFacade();
      expect(starts.filter((item) => item.accountId === 'auto-off-agent')).toEqual([]);
      expect(commands.some((command) => command.type === 'loginToken')).toBe(false);
      expect((await pool.query("SELECT status FROM line_accounts WHERE account_id='auto-off-agent'")).rows[0]).toEqual({ status: 'disconnected' });
      expect((await secretStore.load('auto-off-agent'))?.token).toBe('token-auto-off-agent');
    });

    it('keeps the existing startup login path for opted-in accounts', async () => {
      await addStoredAccounts('auto-on-agent');
      await storeToken('auto-on-agent');
      await new AccountRepository(pool).setAutoLoginOnStartup('auto-on-agent', true);
      await restartFacade();
      expect(starts.some((item) => item.accountId === 'auto-on-agent')).toBe(true);
      expect(commands.some((command) => command.type === 'loginToken' && command.accountId === 'auto-on-agent')).toBe(true);
    });

    it('keeps the degraded state and the worker when a token login reports LOGIN_FAILED', async () => {
      await addStoredAccounts('auto-failure-event-agent');
      await storeToken('auto-failure-event-agent');
      await new AccountRepository(pool).setAutoLoginOnStartup('auto-failure-event-agent', true);
      await restartFacade();
      const attempt = (commands.filter((command) => command.type === 'loginToken' && command.accountId === 'auto-failure-event-agent')
        .at(-1)! as { loginAttemptId: string }).loginAttemptId;
      const binding = bindings.get('auto-failure-event-agent')!;
      published = [];
      await workerEventHandler?.(binding.workerInstanceId, { type: 'loginFailure', ...binding, loginAttemptId: attempt,
        code: 'LOGIN_FAILED', message: 'LINE login failed. Try again.', detail: 'fetch_identity:TypeError' });
      expect(bindings.has('auto-failure-event-agent')).toBe(true);
      expect(published.filter((event) => event.type === 'lineLoginState')).toEqual([
        { type: 'lineLoginState', accountId: 'auto-failure-event-agent', loginAttemptId: attempt, state: 'degraded', message: 'LINE login failed. Try again.' }]);
      expect(auditEvents.find((event) => event.diagnostic?.reason === 'LOGIN_FAILED')?.diagnostic).toMatchObject({ detail: 'fetch_identity:TypeError' });
      expect((await secretStore.load('auto-failure-event-agent'))?.token).toBe('token-auto-failure-event-agent');
    });

    it('makes one opted-in startup restore attempt and preserves the secret after failure', async () => {
      await addStoredAccounts('auto-fail-agent');
      await storeToken('auto-fail-agent');
      await new AccountRepository(pool).setAutoLoginOnStartup('auto-fail-agent', true);
      failedLoginTokenAccount = 'auto-fail-agent';
      await restartFacade();
      await new Promise((resolve) => setTimeout(resolve, 1200));
      expect(commands.filter((command) => command.type === 'loginToken' && command.accountId === 'auto-fail-agent')).toHaveLength(1);
      expect((await secretStore.load('auto-fail-agent'))?.token).toBe('token-auto-fail-agent');
      expect((await pool.query("SELECT status FROM line_accounts WHERE account_id='auto-fail-agent'")).rows[0]).toEqual({ status: 'degraded' });
    });

    it('rebinds a replacement worker without automatically logging the LINE account in again', async () => {
      await addStoredAccounts('worker-restart-agent');
      await storeToken('worker-restart-agent');
      expect((await facade.dispatch({ type: 'lineStart', requestId: 'worker-restart-start', accountId: 'worker-restart-agent' })).ok).toBe(true);
      const original = bindings.get('worker-restart-agent');
      expect(original).toBeDefined();
      const replacement = { ...original!, workerInstanceId: 'worker-restart-replacement' };
      bindings.set(replacement.accountId, replacement);
      commands.length = 0;
      await workerRestartBindingHandler?.(replacement, new AbortController().signal);
      expect(commands.some((command) => command.type === 'loginToken' || command.type === 'loginQr')).toBe(false);
    });

    it('persists the lineSetAutoLogin toggle, exposes it in the snapshot, and rejects unknown accounts', async () => {
      await addStoredAccounts('toggle-agent');
      const read = async () => {
        const snapshot = await facade.dispatch({ type: 'getSnapshot', requestId: 'toggle-snapshot' });
        return snapshot.type === 'getSnapshot' && snapshot.ok
          ? snapshot.snapshot.accounts.find((item) => item.accountId === 'toggle-agent')?.autoLoginOnStartup : undefined;
      };
      await waitForState(async () => expect(await read()).toBe(false), { timeout: 5000, interval: 100 });
      expect(await facade.dispatch({ type: 'lineSetAutoLogin', requestId: 'toggle-on', accountId: 'toggle-agent', enabled: true }))
        .toMatchObject({ ok: true });
      await waitForState(async () => expect(await read()).toBe(true), { timeout: 5000, interval: 100 });
      await restartFacade();
      await waitForState(async () => expect(await read()).toBe(true), { timeout: 5000, interval: 100 });
      expect(await facade.dispatch({ type: 'lineSetAutoLogin', requestId: 'toggle-off', accountId: 'toggle-agent', enabled: false }))
        .toMatchObject({ ok: true });
      await waitForState(async () => expect(await read()).toBe(false), { timeout: 5000, interval: 100 });
      expect(await facade.dispatch({ type: 'lineSetAutoLogin', requestId: 'toggle-missing', accountId: 'nope', enabled: true }))
        .toMatchObject({ ok: false, code: 'ACCOUNT_NOT_FOUND' });
    });
  });

  it('starts manual LINE login directly without an official-process lookup or confirmation field', async () => {
    await addStoredAccounts('direct-login-agent');
    expect(await facade.dispatch({ type: 'lineStart', requestId: 'direct-start', accountId: 'direct-login-agent' }))
      .toMatchObject({ ok: true });
    expect(await facade.dispatch({ type: 'lineLoginQr', requestId: 'direct-qr', accountId: 'direct-login-agent' }))
      .toMatchObject({ ok: true });
    expect(starts.some((item) => item.accountId === 'direct-login-agent')).toBe(true);
    expect(commands.some((command) => command.type === 'loginQr' && command.accountId === 'direct-login-agent')).toBe(true);
  });

  it('drains a startup-resumed monitor before the Primary Admin QR login worker starts', async () => {
    vi.useRealTimers();
    const accountId = 'startup-monitor-admin';
    await addStoredAccounts('startup-monitor-agent', accountId);
    const repository = new ExternalMonitorRepository(pool);
    const source = await repository.bindVerifiedExternalSource({ accountId, ownMid: `own-${accountId}`,
      sourceIdentity: 'startup-monitor-source', initialImport: { snapshotDigest: 'a'.repeat(64),
        schemaVersion: 'line-schema-v1', highWater: null, eligibleCount: '0' } });
    await repository.completeInitialImport({ accountId, sourceId: source.sourceId, generation: source.generation,
      expectedModeRevision: source.modeRevision, expectedCheckpoint: {}, finalCursor: {}, highWater: null });
    expect(await new AdminRepository(pool).isPrimaryUser('startup-monitor-agent', `own-${accountId}`)).toBe(true);
    expect((await pool.query(`SELECT a.status,a.connection_mode,a.source_transition_state,c.initial_import_complete
      FROM line_accounts a JOIN line_account_sources s ON s.account_id=a.account_id AND s.source_id=a.selected_source_id
      JOIN external_source_checkpoints c ON c.source_id=s.source_id WHERE a.account_id=$1`, [accountId])).rows[0])
      .toEqual({ status: 'disconnected', connection_mode: 'EXTERNAL_MONITOR', source_transition_state: 'STABLE', initial_import_complete: true });
    await expect(repository.readBatchFence({ accountId, sourceId: source.sourceId, generation: source.generation }))
      .resolves.toMatchObject({ expectedModeRevision: source.modeRevision, expectedCheckpoint: {} });
    let monitorStarted!: () => void;
    const started = new Promise<void>((resolve) => { monitorStarted = resolve; });
    let finishMonitor!: () => void;
    const finished = new Promise<void>((resolve) => { finishMonitor = resolve; });
    const importer: NonNullable<ConnectedFacadeOptions['officialSnapshotImporter']> = {
      async readOfficialSnapshot() { throw new Error('snapshot import should not run for a completed source'); },
      async readOfficialMonitor(input) {
        monitorStarted();
        await new Promise<void>((resolve) => {
          if (input.signal.aborted) resolve();
          else input.signal.addEventListener('abort', () => resolve(), { once: true });
        });
        finishMonitor();
      },
    };
    await restartFacadeWithImporter(importer);
    await started;

    const lineLogin = facade.dispatch({ type: 'lineLoginQr', requestId: 'qr-after-monitor-drain', accountId });
    await finished;
    expect((await lineLogin).ok).toBe(true);
    expect(starts.at(-1)?.accountId).toBe(accountId);
  }, 45_000);

  it('keeps the database monitor running when the optional download-only worker cannot start', async () => {
    const accountId = 'monitor-without-download-worker';
    await addStoredAccounts('monitor-without-download-agent', accountId);
    const repository = new ExternalMonitorRepository(pool);
    const source = await repository.bindVerifiedExternalSource({ accountId, ownMid: `own-${accountId}`,
      sourceIdentity: 'monitor-without-download-source', initialImport: { snapshotDigest: 'a'.repeat(64),
        schemaVersion: 'line-schema-v1', highWater: null, eligibleCount: '0' } });
    await repository.completeInitialImport({ accountId, sourceId: source.sourceId, generation: source.generation,
      expectedModeRevision: source.modeRevision, expectedCheckpoint: {}, finalCursor: {}, highWater: null });
    failDownloadOnlyStart = true;
    let monitorRuns = 0;
    let observedSignal: AbortSignal | undefined;
    const importer: NonNullable<ConnectedFacadeOptions['officialSnapshotImporter']> = {
      async readOfficialSnapshot() { throw new Error('completed source must skip history import'); },
      async readOfficialMonitor(input) {
        monitorRuns++;
        observedSignal = input.signal;
        input.onReady?.({ async acquireAuthCandidates() { return { candidates: [], errorCode: null }; },
          async decodeAttachment() { return { metadata: null, errorCode: null }; } }, input.signal);
        await input.onPage({ pageNumber: 1, batchDigest: 'e'.repeat(64), rows: [{ observationId: 'monitor-row', canonicalMessageId: null,
          nativeConversationKind: 'group', nativeConversationId: 'monitor-chat', nativeMessageId: 'monitor-message',
          chatType: 'group', chatId: 'monitor-chat', senderId: 'person', kind: 'text', createdTime: '1792000000000',
          text: 'saved while download worker is unavailable', readonlyForSending: true }], tailRows: [],
          lastCursor: { createdTime: '1792000000000', id: 'monitor-message' }, hasMore: false });
        await new Promise<void>((resolve) => {
          if (input.signal.aborted) resolve();
          else input.signal.addEventListener('abort', () => resolve(), { once: true });
        });
      },
    };
    await restartFacadeWithImporter(importer);
    await waitForState(async () => {
      expect(monitorRuns).toBe(1);
      const row = await pool.query('SELECT text_content FROM messages WHERE account_id=$1 AND message_id=$2', [accountId, 'monitor-message']);
      expect(row.rows).toEqual([{ text_content: 'saved while download worker is unavailable' }]);
    }, { timeout: 2_000, interval: 20 });
    expect(observedSignal?.aborted).toBe(false);
    expect(await facade.dispatch({ type: 'externalImportStop', requestId: 'monitor-without-download-stop', accountId }))
      .toMatchObject({ type: 'accepted', ok: true });
  });

  it('stops a timed-out download-auth owner before an explicit retry creates a fresh worker', async () => {
    await addStoredAccounts('auth-timeout-agent', 'auth-timeout-admin');
    const repository = new ExternalMonitorRepository(pool);
    const accountId = 'auth-timeout-admin';
    const cursor = { createdTime: '1792000000000', id: 'auth-timeout-message' };
    const source = await repository.bindVerifiedExternalSource({ accountId, ownMid: `own-${accountId}`,
      sourceIdentity: 'auth-timeout-source', initialImport: { snapshotDigest: 'b'.repeat(64), schemaVersion: 'line-schema-v1',
        highWater: cursor, eligibleCount: '1' } });
    await repository.stageAndProjectBatch({ accountId, sourceId: source.sourceId, generation: source.generation,
      expectedModeRevision: source.modeRevision, expectedCheckpoint: {}, batchId: 'auth-timeout-initial-page', cursor,
      initialImport: true, observations: [{ observationId: 'auth-timeout-observation', canonicalMessageId: 'auth-timeout-message',
        nativeConversationKind: 'group', nativeConversationId: 'auth-timeout-chat', nativeMessageId: 'auth-timeout-message',
        chatType: 'group', chatId: 'auth-timeout-chat', senderId: 'person', kind: 'file', text: null,
        occurredAt: '2026-10-18T00:00:00.000Z', nativePayload: { format: 1, table: '_message', sourceDigest: 'c'.repeat(64),
          encoding: 'dpapi', data: 'AQID' }, attachments: [{ id: 'auth-timeout-message', kind: 'file', name: 'retry.txt',
          mimeType: null, sizeBytes: 2, expiresAt: null }] }] });
    await repository.completeInitialImport({ accountId, sourceId: source.sourceId, generation: source.generation,
      expectedModeRevision: source.modeRevision, expectedCheckpoint: cursor, finalCursor: cursor, highWater: cursor });

    let monitorStarted!: () => void; const monitorStartedPromise = new Promise<void>((resolve) => { monitorStarted = resolve; });
    let authStarted!: () => void; const authStartedPromise = new Promise<void>((resolve) => { authStarted = resolve; });
    let releaseTimedOutAuth!: () => void; const timedOutAuth = new Promise<void>((resolve) => { releaseTimedOutAuth = resolve; });
    const authCalls: Array<{ workerInstanceId: string; token: string }> = [];
    const activeDownloadWorkers = new Set<string>();
    let firstWorkerId = '';
    let overlappingDownloadWorkers = false;
    workers.start = async (id, binding) => {
      starts.push({ accountId: id, mode: binding.mode, controlEpoch: binding.controlEpoch });
      if (binding.purpose === 'DOWNLOAD_ONLY') {
        if (activeDownloadWorkers.size > 0) overlappingDownloadWorkers = true;
        activeDownloadWorkers.add(binding.workerInstanceId);
      }
      bindings.set(id, binding);
      await workerBindingHandler?.(binding, new AbortController().signal);
      return binding;
    };
    workers.stopBinding = async (binding) => {
      stoppedWorkerInstances.push(binding.workerInstanceId);
      downloadReadyBindings.delete(binding.workerInstanceId);
      activeDownloadWorkers.delete(binding.workerInstanceId);
      if (bindings.get(binding.accountId)?.workerInstanceId === binding.workerInstanceId) bindings.delete(binding.accountId);
    };
    workers.adoptDownloadAuth = async (command) => {
      commands.push(command);
      authCalls.push({ workerInstanceId: command.workerInstanceId, token: command.token });
      if (!firstWorkerId) firstWorkerId = command.workerInstanceId;
      if (command.workerInstanceId === firstWorkerId) {
        if (command.token === 'candidate-one') { authStarted(); await timedOutAuth; }
        return { type: 'downloadAuthResult', accountId: command.accountId, workerInstanceId: command.workerInstanceId,
          controlEpoch: command.controlEpoch, transportOwnerId: command.transportOwnerId, transportGeneration: command.transportGeneration,
          writeGrantVersion: command.writeGrantVersion, requestId: command.requestId, accepted: false, error: 'AUTH_UNAVAILABLE' };
      }
      downloadReadyBindings.add(command.workerInstanceId);
      return { type: 'downloadAuthResult', accountId: command.accountId, workerInstanceId: command.workerInstanceId,
        controlEpoch: command.controlEpoch, transportOwnerId: command.transportOwnerId, transportGeneration: command.transportGeneration,
        writeGrantVersion: command.writeGrantVersion, requestId: command.requestId, accepted: true, error: null };
    };
    workers.download = async (command) => ({ type: 'attachmentResult', accountId: command.accountId, chatType: command.chatType,
      chatId: command.chatId, workerInstanceId: command.workerInstanceId, controlEpoch: command.controlEpoch,
      attachmentId: command.attachmentId, attemptToken: command.attemptToken, status: 'ready',
      relativePath: `managed/${command.attachmentId}.txt`, sha256: 'd'.repeat(64), sizeBytes: 2, name: 'retry.txt' });
    const importer: NonNullable<ConnectedFacadeOptions['officialSnapshotImporter']> = {
      async readOfficialSnapshot() { throw new Error('completed source must skip history import'); },
      async readOfficialMonitor(input) {
        input.onReady?.({ async acquireAuthCandidates() { return { candidates: [
          { token: 'candidate-one', application: 'DESKTOPWIN\t26.4.2.3957\tWINDOWS\t10.0.0-NT-x64' },
          { token: 'candidate-two', application: 'DESKTOPWIN\t26.5.1.4180\tWINDOWS\t10.0.0-NT-x64' },
        ], errorCode: null }; }, async decodeAttachment() {
          return {
            metadata: {
              messageId: 'auth-timeout-message',
              chatId: 'auth-timeout-chat',
              from: null,
              to: null,
              toType: null,
              contentType: 14,
              contentMetadata: { OID: 'OID_123', SID: 'emf', OBS_POP: null, FILE_SIZE: '2', MEDIA_CONTENT_INFO: null, DOWNLOAD_URL: null },
              keyMaterial: Buffer.alloc(32, 7).toString('base64'),
              fileName: 'retry.txt',
              sizeBytes: 2,
            },
            errorCode: null,
          };
        } }, input.signal);
        monitorStarted();
        await new Promise<void>((resolve) => {
          if (input.signal.aborted) resolve();
          else input.signal.addEventListener('abort', () => resolve(), { once: true });
        });
      },
    };
    await restartFacadeWithImporter(importer, undefined, undefined, true);
    try {
      await monitorStartedPromise;
      await authStartedPromise;
      const oldWorkerId = firstWorkerId;
      releaseTimedOutAuth();
      await waitForState(() => expect(stoppedWorkerInstances).toContain(oldWorkerId));
      expect(activeDownloadWorkers.size).toBe(0);
      expect(overlappingDownloadWorkers).toBe(false);

      const attachment = await new MessageRepository(pool).getAttachmentBySource({ accountId, chatType: 'group', chatId: 'auth-timeout-chat' },
        'auth-timeout-message', 'auth-timeout-message');
      expect(attachment).toMatchObject({ status: 'queued', externalSource: true });
      await pool.query("UPDATE line_accounts SET status='connected' WHERE account_id=$1", [accountId]);
      await expect(facade.downloadAttachment({ accountId, chatType: 'group', chatId: 'auth-timeout-chat' },
        attachment!.attachmentId)).resolves.toBe(true);
      const retryWorkerId = authCalls.find((call) => call.workerInstanceId !== oldWorkerId)?.workerInstanceId;
      expect(retryWorkerId).toBeTruthy();
      expect(retryWorkerId).not.toBe(oldWorkerId);
      expect(authCalls.filter((call) => call.workerInstanceId === oldWorkerId).map((call) => call.token))
        .toEqual(['candidate-one', 'candidate-two']);
      expect(authCalls.filter((call) => call.workerInstanceId === retryWorkerId).map((call) => call.token))
        .toEqual(['candidate-one']);
      expect(overlappingDownloadWorkers).toBe(false);
      expect((await new MessageRepository(pool).getAttachmentBySource({ accountId, chatType: 'group', chatId: 'auth-timeout-chat' },
        'auth-timeout-message', 'auth-timeout-message'))?.status).toBe('ready');
      expect(await facade.dispatch({ type: 'getSnapshot', requestId: 'auth-timeout-monitor-snapshot' }))
        .toMatchObject({ type: 'getSnapshot', ok: true });
    } finally {
      releaseTimedOutAuth();
      await facade.dispatch({ type: 'externalImportStop', requestId: 'auth-timeout-monitor-stop', accountId });
    }
  });

  it('projects and safely records startup authority-read failures', async () => {
    const accountId = 'monitor-startup-diagnostic-admin';
    await addStoredAccounts('monitor-startup-diagnostic-agent', accountId);
    const repository = new ExternalMonitorRepository(pool);
    const source = await repository.bindVerifiedExternalSource({ accountId, ownMid: `own-${accountId}`,
      sourceIdentity: 'monitor-startup-diagnostic-source', initialImport: { snapshotDigest: 'a'.repeat(64),
        schemaVersion: 'line-schema-v1', highWater: null, eligibleCount: '0' } });
    await repository.completeInitialImport({ accountId, sourceId: source.sourceId, generation: source.generation,
      expectedModeRevision: source.modeRevision, expectedCheckpoint: {}, finalCursor: {}, highWater: null });
    const failure = 'private postgres path C:\\secret\ncredential=hidden';
    const getState = vi.spyOn(ExternalMonitorRepository.prototype, 'getInitialImportState').mockRejectedValue(new Error(failure));
    const diagnosticPath = join(secretRoot, 'startup-monitor-diagnostic.json');
    const importer: NonNullable<ConnectedFacadeOptions['officialSnapshotImporter']> = {
      async readOfficialSnapshot() { throw new Error('completed source must skip snapshot import'); },
      async readOfficialMonitor() { throw new Error('must not reach reader before state verification'); },
    };
    try {
      await restartFacadeWithImporter(importer, undefined, undefined, false, diagnosticPath);
      await waitForState(async () => {
        const snapshot = await facade.dispatch({ type: 'getSnapshot', requestId: 'monitor-startup-diagnostic-state' });
        expect(snapshot.type === 'getSnapshot' && snapshot.ok
          ? snapshot.snapshot.accounts.find((item) => item.accountId === accountId)?.externalImportProgress
          : null).toMatchObject({ stage: 'failed', committedRows: '0', message: 'external_monitor_database_failed' });
      });
      const record = JSON.parse(await readFile(diagnosticPath, 'utf8')) as Record<string, unknown>;
      expect(record).toMatchObject({ stage: 'startup', code: 'external_monitor_database_failed', producer: 'startup_resume' });
      expect(JSON.stringify(record)).not.toContain(failure);
    } finally {
      getState.mockRestore();
    }
  });

  it('classifies stale authority at a completed-import restart fence', async () => {
    const accountId = 'monitor-restart-diagnostic-admin';
    await addStoredAccounts('monitor-restart-diagnostic-agent', accountId);
    const diagnosticPath = join(secretRoot, 'restart-monitor-diagnostic.json');
    const importer: NonNullable<ConnectedFacadeOptions['officialSnapshotImporter']> = {
      async readOfficialSnapshot() { throw new Error('completed source must skip snapshot import'); },
      async readOfficialMonitor() { throw new Error('monitor reader must not start after failed fence'); },
    };
    await restartFacadeWithImporter(importer, undefined, undefined, false, diagnosticPath);
    const repository = new ExternalMonitorRepository(pool);
    const source = await repository.bindVerifiedExternalSource({ accountId, ownMid: `own-${accountId}`,
      sourceIdentity: 'monitor-restart-diagnostic-source', initialImport: { snapshotDigest: 'b'.repeat(64),
        schemaVersion: 'line-schema-v1', highWater: null, eligibleCount: '0' } });
    await repository.completeInitialImport({ accountId, sourceId: source.sourceId, generation: source.generation,
      expectedModeRevision: source.modeRevision, expectedCheckpoint: {}, finalCursor: {}, highWater: null });
    const failure = 'External source authority is stale';
    const readFence = vi.spyOn(ExternalMonitorRepository.prototype, 'readBatchFence').mockRejectedValue(new Error(failure));
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      expect(await facade.dispatch({ type: 'externalImportStart', requestId: 'monitor-restart-diagnostic-start', accountId }))
        .toMatchObject({ ok: true });
      await waitForState(async () => {
        const snapshot = await facade.dispatch({ type: 'getSnapshot', requestId: 'monitor-restart-diagnostic-state' });
        expect(snapshot.type === 'getSnapshot' && snapshot.ok
          ? snapshot.snapshot.accounts.find((item) => item.accountId === accountId)?.externalImportProgress
          : null).toMatchObject({ stage: 'failed', committedRows: '0', message: 'external_monitor_authority_stale' });
      });
      const record = JSON.parse(await readFile(diagnosticPath, 'utf8')) as Record<string, unknown>;
      expect(record).toMatchObject({ stage: 'startup', code: 'external_monitor_authority_stale', producer: 'manual_start' });
      expect(JSON.stringify(warning.mock.calls)).not.toContain(failure);
      expect(JSON.stringify(record)).not.toContain(failure);
    } finally {
      readFence.mockRestore();
      warning.mockRestore();
    }
  });

  it('persists the facade fence phase when the admitted monitor state changes before reader launch', async () => {
    const accountId = 'monitor-second-state-diagnostic-admin';
    await addStoredAccounts('monitor-second-state-diagnostic-agent', accountId);
    const diagnosticPath = join(secretRoot, 'second-state-monitor-diagnostic.json');
    const repository = new ExternalMonitorRepository(pool);
    const source = await repository.bindVerifiedExternalSource({ accountId, ownMid: `own-${accountId}`,
      sourceIdentity: 'monitor-second-state-diagnostic-source', initialImport: { snapshotDigest: 'd'.repeat(64),
        schemaVersion: 'line-schema-v1', highWater: null, eligibleCount: '0' } });
    await repository.completeInitialImport({ accountId, sourceId: source.sourceId, generation: source.generation,
      expectedModeRevision: source.modeRevision, expectedCheckpoint: {}, finalCursor: {}, highWater: null });
    const admittedState = await repository.getInitialImportState({ accountId, sourceId: source.sourceId, generation: source.generation });
    expect(admittedState?.initialImportComplete).toBe(true);
    let stateReads = 0;
    const getState = vi.spyOn(ExternalMonitorRepository.prototype, 'getInitialImportState').mockImplementation(async () => {
      stateReads += 1;
      return stateReads === 1 ? admittedState : { ...admittedState!, initialImportComplete: false };
    });
    let readerLaunches = 0;
    const importer: NonNullable<ConnectedFacadeOptions['officialSnapshotImporter']> = {
      async readOfficialSnapshot() { throw new Error('completed source must skip snapshot import'); },
      async readOfficialMonitor() { readerLaunches += 1; throw new Error('reader must not start after state fence fails'); },
    };
    try {
      await restartFacadeWithImporter(importer, undefined, undefined, false, diagnosticPath);
      await waitForState(async () => {
        const record = JSON.parse(await readFile(diagnosticPath, 'utf8')) as Record<string, unknown>;
        expect(record).toMatchObject({ stage: 'startup', code: 'external_monitor_checkpoint_changed',
          phase: 'facade_checkpoint_fence' });
      });
      expect(stateReads).toBe(2);
      expect(readerLaunches).toBe(0);
    } finally {
      getState.mockRestore();
    }
  });

  it('preserves typed private directory phase from marker creation under owner admission', async () => {
    const accountId = 'monitor-private-directory-phase-admin';
    await addStoredAccounts('monitor-private-directory-phase-agent', accountId);
    const diagnosticPath = join(secretRoot, 'private-directory-phase-monitor-diagnostic.json');
    const repository = new ExternalMonitorRepository(pool);
    const source = await repository.bindVerifiedExternalSource({ accountId, ownMid: `own-${accountId}`,
      sourceIdentity: 'monitor-private-directory-phase-source', initialImport: { snapshotDigest: 'e'.repeat(64),
        schemaVersion: 'line-schema-v1', highWater: null, eligibleCount: '0' } });
    await repository.completeInitialImport({ accountId, sourceId: source.sourceId, generation: source.generation,
      expectedModeRevision: source.modeRevision, expectedCheckpoint: {}, finalCursor: {}, highWater: null });
    const importer: NonNullable<ConnectedFacadeOptions['officialSnapshotImporter']> = {
      async readOfficialSnapshot() { throw new Error('completed source must skip snapshot import'); },
      async readOfficialMonitor(input) {
        input.onPhase?.('owner_admission_marker');
        throw new ExternalMonitorDiagnosticFailure('external_monitor_reader_startup_failed', 'startup',
          'private_directory_acl_command_timeout', 'private_directory_preparation');
      },
    };
    await restartFacadeWithImporter(importer, undefined, undefined, false, diagnosticPath);
    await waitForState(async () => {
      const record = JSON.parse(await readFile(diagnosticPath, 'utf8')) as Record<string, unknown>;
      expect(record).toMatchObject({ stage: 'startup', code: 'external_monitor_reader_startup_failed',
        detail: 'private_directory_acl_command_timeout', phase: 'private_directory_preparation', producer: 'startup_resume' });
    });
  });

  it('records reader failures with the runtime phase after readiness and hides injected text', async () => {
    const accountId = 'monitor-runtime-diagnostic-admin';
    await addStoredAccounts('monitor-runtime-diagnostic-agent', accountId);
    const diagnosticPath = join(secretRoot, 'runtime-monitor-diagnostic.json');
    const repository = new ExternalMonitorRepository(pool);
    const source = await repository.bindVerifiedExternalSource({ accountId, ownMid: `own-${accountId}`,
      sourceIdentity: 'monitor-runtime-diagnostic-source', initialImport: { snapshotDigest: 'c'.repeat(64),
        schemaVersion: 'line-schema-v1', highWater: null, eligibleCount: '0' } });
    await repository.completeInitialImport({ accountId, sourceId: source.sourceId, generation: source.generation,
      expectedModeRevision: source.modeRevision, expectedCheckpoint: {}, finalCursor: {}, highWater: null });
    const failure = 'native exception C:\\private mid=u-secret credential=hidden';
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const importer: NonNullable<ConnectedFacadeOptions['officialSnapshotImporter']> = {
      async readOfficialSnapshot() { throw new Error('completed source must skip snapshot import'); },
      async readOfficialMonitor(input) {
        input.onReady?.({ sourceId: 'fake-source', generation: 1 } as never);
        throw new Error(failure);
      },
    };
    try {
      await restartFacadeWithImporter(importer, undefined, undefined, false, diagnosticPath);
      await waitForState(async () => {
        const snapshot = await facade.dispatch({ type: 'getSnapshot', requestId: 'monitor-runtime-diagnostic-state' });
        expect(snapshot.type === 'getSnapshot' && snapshot.ok
          ? snapshot.snapshot.accounts.find((item) => item.accountId === accountId)?.externalImportProgress
          : null).toMatchObject({ stage: 'failed', committedRows: '0', message: 'external_monitor_unknown' });
      });
      const record = JSON.parse(await readFile(diagnosticPath, 'utf8')) as Record<string, unknown>;
      expect(record).toMatchObject({ stage: 'runtime', code: 'external_monitor_unknown', producer: 'startup_resume' });
      expect(JSON.stringify(warning.mock.calls)).not.toContain(failure);
      expect(JSON.stringify(record)).not.toContain(failure);
    } finally {
      warning.mockRestore();
    }
  });

  it('stops only the matching completed external monitor and keeps its checkpoint', async () => {
    const accountId = 'explicit-stop-admin';
    await addStoredAccounts('explicit-stop-agent', accountId);
    const repository = new ExternalMonitorRepository(pool);
    const source = await repository.bindVerifiedExternalSource({ accountId, ownMid: `own-${accountId}`,
      sourceIdentity: 'explicit-stop-source', initialImport: { snapshotDigest: 'a'.repeat(64),
        schemaVersion: 'line-schema-v1', highWater: null, eligibleCount: '0' } });
    await repository.completeInitialImport({ accountId, sourceId: source.sourceId, generation: source.generation,
      expectedModeRevision: source.modeRevision, expectedCheckpoint: {}, finalCursor: {}, highWater: null });
    const diagnosticPath = join(secretRoot, 'explicit-stop-monitor-diagnostic.json');
    await writeFile(diagnosticPath, JSON.stringify({ version: 1, createdAt: new Date().toISOString(),
      stage: 'startup', code: 'external_monitor_unknown' }));
    let monitorStarted!: () => void;
    const started = new Promise<void>((resolve) => { monitorStarted = resolve; });
    let restartedMonitorStarted!: () => void;
    const restarted = new Promise<void>((resolve) => { restartedMonitorStarted = resolve; });
    let monitorRuns = 0;
    let observedSignal: AbortSignal | undefined;
    const importer: NonNullable<ConnectedFacadeOptions['officialSnapshotImporter']> = {
      async readOfficialSnapshot() { throw new Error('completed source must skip initial import'); },
      async readOfficialMonitor(input) {
        await input.onReady?.({ sourceId: 'fake-source', generation: 1 } as never);
        observedSignal = input.signal;
        monitorRuns++;
        if (monitorRuns === 1) monitorStarted();
        else restartedMonitorStarted();
        await new Promise<never>((_resolve, reject) => {
          if (input.signal.aborted) reject(new Error('monitor cancelled'));
          else input.signal.addEventListener('abort', () => reject(new Error('monitor cancelled')), { once: true });
        });
      },
    };
    await restartFacadeWithImporter(importer, undefined, undefined, false, diagnosticPath);
    await started;
    await vi.waitFor(async () => expect(readFile(diagnosticPath, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' }));

    const otherAccountRequest = await facade.dispatch({ type: 'externalImportStop', requestId: 'explicit-stop-other', accountId: 'explicit-stop-agent' });
    expect(otherAccountRequest).toMatchObject({ ok: false, code: 'EXTERNAL_MONITOR_NOT_ACTIVE' });
    expect(observedSignal?.aborted).toBe(false);

    expect(await facade.dispatch({ type: 'externalImportStop', requestId: 'explicit-stop-active', accountId })).toMatchObject({ type: 'accepted', ok: true });
    expect(observedSignal?.aborted).toBe(true);
    await waitForState(async () => {
      const snapshot = await facade.dispatch({ type: 'getSnapshot', requestId: 'explicit-stop-snapshot' });
      expect(snapshot.type === 'getSnapshot' && snapshot.ok
        ? snapshot.snapshot.accounts.find((item) => item.accountId === accountId)?.externalImportProgress
        : null).toMatchObject({ stage: 'complete', committedRows: '0' });
      // getSnapshot serves the last published snapshot and refreshes at most once per second
      // (createCoalescedSnapshotPublisher), so the default 1s waitFor window can end before the refresh lands.
    }, { timeout: 5_000, interval: 100 });
    await expect(repository.getInitialImportState({ accountId, sourceId: source.sourceId, generation: source.generation }))
      .resolves.toMatchObject({ initialImportComplete: true, committedCount: '0', cursor: {} });
    await expect(readFile(diagnosticPath, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await facade.dispatch({ type: 'externalImportStart', requestId: 'explicit-stop-restart', accountId })).toMatchObject({ ok: true });
    await restarted;
    expect(await facade.dispatch({ type: 'externalImportStop', requestId: 'explicit-stop-second', accountId })).toMatchObject({ type: 'accepted', ok: true });
    expect(await facade.dispatch({ type: 'externalImportStop', requestId: 'explicit-stop-repeat', accountId })).toMatchObject({ type: 'accepted', ok: true });
    expect(await facade.dispatch({ type: 'externalImportStop', requestId: 'explicit-stop-nonmonitor', accountId: 'explicit-stop-agent' }))
      .toMatchObject({ ok: false, code: 'EXTERNAL_MONITOR_NOT_ACTIVE' });
  });

  it('projects the official LINE build status for the Primary Admin and pins a rotated signer only on explicit approval', async () => {
    const adminId = 'trust-admin';
    await addStoredAccounts('trust-agent', adminId);
    let stored: unknown = null;
    const trust = new OfficialBuildTrustService({
      async read() { return stored; },
      async write(state: OfficialBuildTrustState) { stored = JSON.parse(JSON.stringify(state)); },
    });
    await facade.shutdown();
    facade = await createConnectedFacade({ pool, workers, agent, attachmentRoot: 'C:\attachments', secretStore, audit,
      runMigrations: false, officialBuildTrust: trust, publish(event) { published.push(event); } });
    const accountsOf = async () => {
      const snapshot = await facade.dispatch({ type: 'getSnapshot', requestId: `trust-snapshot-${Math.random()}` });
      if (snapshot.type !== 'getSnapshot' || !snapshot.ok) throw new Error('snapshot_unavailable');
      return snapshot.snapshot.accounts;
    };
    expect((await accountsOf()).find((item) => item.accountId === adminId)?.officialLineBuild ?? null).toBeNull();
    expect(await facade.dispatch({ type: 'officialLineApproveSigner', requestId: 'trust-approve-none' }))
      .toMatchObject({ ok: false, code: 'OFFICIAL_SIGNER_NOT_PENDING' });
    await trust.record({ kind: 'blocked', verdict: 'rotation', version: '26.5.0.3975', reason: 'not_pinned', thumbprint: 'B'.repeat(40) });
    await waitForState(async () => {
      const accounts = await accountsOf();
      expect(accounts.find((item) => item.accountId === adminId)?.officialLineBuild).toEqual({ version: '26.5.0.3975', status: 'rotation' });
      expect(accounts.find((item) => item.accountId === 'trust-agent')?.officialLineBuild).toBeUndefined();
    }, { timeout: 5_000, interval: 100 });
    expect(JSON.stringify(await accountsOf())).not.toContain('B'.repeat(40));
    expect(await facade.dispatch({ type: 'officialLineApproveSigner', requestId: 'trust-approve' })).toMatchObject({ type: 'accepted', ok: true });
    expect((await trust.state()).pinnedThumbprints).toContain('B'.repeat(40));
    await waitForState(async () => {
      expect((await accountsOf()).find((item) => item.accountId === adminId)?.officialLineBuild).toEqual({ version: '26.5.0.3975', status: 'candidate' });
    }, { timeout: 5_000, interval: 100 });
    expect(await facade.dispatch({ type: 'officialLineApproveSigner', requestId: 'trust-approve-again' }))
      .toMatchObject({ ok: false, code: 'OFFICIAL_SIGNER_NOT_PENDING' });
  });

  it('refuses signer approval when no build trust service is attached', async () => {
    expect(await facade.dispatch({ type: 'officialLineApproveSigner', requestId: 'trust-approve-unavailable' }))
      .toMatchObject({ ok: false, code: 'OFFICIAL_SIGNER_UNAVAILABLE' });
  });

  it('rejects monitor stop while the initial history import is unfinished', async () => {
    const accountId = 'explicit-stop-incomplete-admin';
    await addStoredAccounts('explicit-stop-incomplete-agent', accountId);
    let reachedReady!: () => void;
    const ready = new Promise<void>((resolve) => { reachedReady = resolve; });
    let observedSignal: AbortSignal | undefined;
    const importer: NonNullable<ConnectedFacadeOptions['officialSnapshotImporter']> = {
      async readOfficialSnapshot(input) {
        observedSignal = input.signal;
        await input.onReady({ sourceIdentityDigest: 'b'.repeat(64), snapshotDigest: 'c'.repeat(64),
          schemaVersion: 'line-schema-v1', highWatermark: null, eligibleCount: '0' });
        reachedReady();
        await new Promise<never>((_resolve, reject) => input.signal.addEventListener('abort', () => reject(new Error('import cancelled')), { once: true }));
        throw new Error('unreachable');
      },
    };
    await restartFacadeWithImporter(importer);
    expect(await facade.dispatch({ type: 'externalImportStart', requestId: 'explicit-stop-incomplete-start', accountId })).toMatchObject({ ok: true });
    await ready;
    expect(await facade.dispatch({ type: 'externalImportStop', requestId: 'explicit-stop-incomplete', accountId }))
      .toMatchObject({ ok: false, code: 'EXTERNAL_IMPORT_INCOMPLETE' });
    expect(observedSignal?.aborted).toBe(false);
  });

  async function expectFailedStartup(trigger: 'recovery' | 'settings') {
    const previousEventHandler = workerEventHandler;
    const previousBindingHandler = workerBindingHandler;
    await pool.query(`CREATE FUNCTION fail_mcp_startup() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'forced ${trigger} startup failure'; END $$`);
    await pool.query(`CREATE TRIGGER fail_mcp_startup BEFORE ${trigger === 'recovery' ? 'UPDATE' : 'INSERT'} ON ${trigger === 'recovery' ? 'agent_jobs' : 'app_settings'}
      FOR EACH STATEMENT EXECUTE FUNCTION fail_mcp_startup()`);
    try {
      await expect(createConnectedFacade({ pool, workers, agent, attachmentRoot: 'C:\\attachments', secretStore, audit,
        runMigrations: false, closePoolOnShutdown: false, mcpHttpPort: 0 })).rejects.toThrow(`forced ${trigger} startup failure`);
      expect(workerEventHandler).toBe(previousEventHandler);
      expect(workerBindingHandler).toBe(previousBindingHandler);
      expect((await pool.query('SELECT 1 AS still_usable')).rows[0].still_usable).toBe(1);
    } finally {
      await pool.query(`DROP TRIGGER fail_mcp_startup ON ${trigger === 'recovery' ? 'agent_jobs' : 'app_settings'}`);
      await pool.query('DROP FUNCTION fail_mcp_startup()');
    }
  }

  it('unwinds subscriptions and preserves the borrowed pool when recovery fails', async () => {
    await expectFailedStartup('recovery');
  });

  it('unwinds subscriptions and preserves the borrowed pool when attachment settings fail', async () => {
    await expectFailedStartup('settings');
  });

  it('unwinds the full startup stack after the final MCP bind fails', async () => {
    const previousEventHandler = workerEventHandler;
    const previousBindingHandler = workerBindingHandler;
    const occupied = createServer();
    occupied.listen(0, '127.0.0.1');
    await once(occupied, 'listening');
    const port = (occupied.address() as import('node:net').AddressInfo).port;
    try {
      await expect(createConnectedFacade({ pool, workers, agent, attachmentRoot: 'C:\\attachments', secretStore, audit,
        runMigrations: false, closePoolOnShutdown: false, mcpHttpPort: port })).rejects.toMatchObject({ code: 'EADDRINUSE' });
      expect(workerEventHandler).toBe(previousEventHandler);
      expect(workerBindingHandler).toBe(previousBindingHandler);
      expect((await pool.query('SELECT 1 AS still_usable')).rows[0].still_usable).toBe(1);
    } finally {
      occupied.close();
      await once(occupied, 'close');
    }
  });

  it('fences and drains a paused worker callback before failed startup returns', async () => {
    await addStoredAccounts('account-a');
    await activate('account-a');
    const binding = bindings.get('account-a')!;
    const previousEventHandler = workerEventHandler;
    let stopStarted!: () => void;
    const started = new Promise<void>((resolve) => { stopStarted = resolve; });
    let releaseStop!: () => void;
    const stopGate = new Promise<void>((resolve) => { releaseStop = resolve; });
    pendingWorkerStop = { started: stopStarted, wait: stopGate };
    let trackedCallback!: Promise<void>;
    const occupied = createServer();
    occupied.listen(0, '127.0.0.1');
    await once(occupied, 'listening');
    const port = (occupied.address() as import('node:net').AddressInfo).port;
    try {
      const startup = createConnectedFacade({ pool, workers, agent, attachmentRoot: 'C:\\attachments', secretStore, audit,
        runMigrations: false, closePoolOnShutdown: false, mcpHttpPort: port,
        async beforeMcpListen() {
          await workerBindingHandler?.(binding, new AbortController().signal);
          trackedCallback = workerEventHandler!(binding.workerInstanceId, { type: 'authInvalidated', ...binding });
          await started;
        } });
      await started;
      let startupSettled = false;
      void startup.catch(() => { startupSettled = true; });
      await waitForState(() => expect(workerEventHandler).toBe(previousEventHandler));
      expect(startupSettled).toBe(false);
      releaseStop();
      await expect(startup).rejects.toMatchObject({ code: 'EADDRINUSE' });
      await trackedCallback;
      expect((await pool.query('SELECT 1 AS still_usable')).rows[0].still_usable).toBe(1);
    } finally {
      releaseStop();
      occupied.close();
      await once(occupied, 'close');
    }
  });

  async function addStoredAccounts(...accountIds: string[]) {
    for (const accountId of accountIds) await pool.query(
      'INSERT INTO line_accounts(account_id,display_name,own_mid) VALUES ($1,$1,$2)', [accountId, `own-${accountId}`]);
    for (const [index, accountId] of accountIds.entries()) {
      if (index === 0) await pool.query("UPDATE line_accounts SET product_role='AGENT' WHERE account_id=$1", [accountId]);
      else if (index === 1) await pool.query("UPDATE line_accounts SET product_role='PRIMARY_ADMIN' WHERE account_id=$1", [accountId]);
    }
    if (accountIds[0] && accountIds[1]) await pool.query(`INSERT INTO account_administrators(account_id,chat_type,chat_id,user_id,role)
      VALUES ($1,'direct',$2,$3,'PRIMARY_ADMIN')`, [accountIds[0], `admin-chat-${accountIds[0]}`, `own-${accountIds[1]}`]);
  }

  async function accountModes() {
    const result = await pool.query<{ account_id: string; mode: string }>('SELECT account_id,mode FROM line_accounts ORDER BY account_id');
    return result.rows;
  }

  async function activate(accountId: string, expectedEpoch = 1) {
    await pool.query("UPDATE line_accounts SET product_role='AGENT' WHERE account_id=$1 AND product_role IS NULL", [accountId]);
    await pool.query(`INSERT INTO account_administrators(account_id,chat_type,chat_id,user_id,role)
      VALUES ($1,'direct',$2,$3,'PRIMARY_ADMIN') ON CONFLICT (account_id,role) DO NOTHING`,
    [accountId, `admin-chat-${accountId}`, `admin-mid-${accountId}`]);
    const state = await facade.controlState();
    if (!state.activeAccountId) expect((await new AccountRepository(pool).activateControl(accountId, expectedEpoch)).activated).toBe(true);
    const result = await facade.dispatch({ type: 'lineStart', requestId: `start-${accountId}`, accountId });
    expect(result.ok, JSON.stringify(result)).toBe(true);
  }

  async function loginReady(accountId: string, ownMid = `own-${accountId}`) {
    await activate(accountId);
    expect((await facade.dispatch({ type: 'lineLoginQr', requestId: `qr-${accountId}`, accountId })).ok).toBe(true);
    const binding = bindings.get(accountId)!;
    const attempt = latestLoginAttempt(accountId);
    await workerEventHandler?.(binding.workerInstanceId, { type: 'login', ...binding, loginAttemptId: attempt, ownMid, displayName: 'Agent' });
    await workerEventHandler?.(binding.workerInstanceId, { type: 'status', ...binding, state: 'ready', message: null });
    return binding;
  }

  /** The worker's login and ready events: the primary-admin friend check starts only after both. */
  async function signalLoggedInReady(accountId: string, ownMid = `own-${accountId}`, withTransport = false) {
    expect((await facade.dispatch({ type: 'lineLoginQr', requestId: `qr-ready-${accountId}`, accountId })).ok).toBe(true);
    // QR login replaces the worker; the gateway handshake belongs to this fresh binding.
    const binding = withTransport
      ? { ...bindings.get(accountId)!, transportOwnerId: 'test-owner', transportGeneration: 1, writeGrantVersion: 1 }
      : bindings.get(accountId)!;
    if (withTransport) {
      bindings.set(accountId, binding);
      await workerBindingHandler?.(binding, new AbortController().signal);
    }
    const attempt = latestLoginAttempt(accountId);
    await workerEventHandler?.(binding.workerInstanceId, { type: 'login', ...binding, loginAttemptId: attempt, ownMid, displayName: 'Agent' });
    await workerEventHandler?.(binding.workerInstanceId, { type: 'status', ...binding, state: 'ready', message: null });
  }

  async function seedManualUnsendMessage(binding: TestBinding, messageId: string, senderId: string, occurredAt: string) {
    const raw = { message: { id: messageId, from: senderId, to: 'unsend-chat', toType: 1, contentType: 0,
      text: `source ${messageId}`, createdTime: Date.parse(occurredAt), contentMetadata: {} } };
    const checkpoint = await pool.query<{ cursor: { version: 1; revision: string; globalRev: string; individualRev: string } }>(
      "SELECT cursor FROM external_source_checkpoints WHERE account_id=$1 AND source_id=(SELECT selected_source_id FROM line_accounts WHERE account_id=$1)",
      [binding.accountId]);
    const cursorBefore = checkpoint.rows[0]!.cursor;
    const cursorAfter = { version: 1 as const, revision: (BigInt(cursorBefore.revision) + 1n).toString(),
      globalRev: (BigInt(cursorBefore.globalRev) + 1n).toString(), individualRev: cursorBefore.individualRev };
    await workerEventHandler?.(binding.workerInstanceId, { type: 'batch', ...binding, batchId: `batch-${messageId}`,
      cursorBefore, cursorAfter, envelopes: [{
        eventId: `event-${messageId}`, messageId, accountId: binding.accountId, chatType: 'direct', chatId: 'unsend-chat',
        senderId, kind: 'text', text: `source ${messageId}`, mentionIds: [], mentionRanges: [], replyToMessageId: null,
        ingestion: { source: 'live', cursor: null }, occurredAt, attachments: [], raw,
      }] });
  }

  async function control() { return facade.controlState(); }

  it('refreshes the connected account avatar through its current worker and publishes the updated snapshot', async () => {
    const accountId = 'avatar-refresh-flow';
    const ownMid = `u${'c'.repeat(32)}`;
    const picturePath = 'https://profile.line-scdn.net/avatar-refresh.png';
    await addStoredAccounts(accountId);
    const binding: TestBinding = { accountId, workerInstanceId: 'avatar-refresh-worker', controlEpoch: 0, mode: 'MONITOR_ONLY' };
    await workers.start(accountId, binding);
    await pool.query(`UPDATE line_accounts SET own_mid=$2,status='connected',mode='MONITOR_ONLY',connection_mode='SYSTEM_LOGIN',
      worker_instance_id=$3,worker_binding_epoch=$4 WHERE account_id=$1`,
    [accountId, ownMid, binding.workerInstanceId, binding.controlEpoch]);
    refreshedOwnProfile = { ownMid, displayName: 'Refreshed account', picturePath };

    const result = await facade.dispatch({ type: 'refreshLineAvatar', requestId: 'avatar-refresh-flow-request', accountId });

    expect(result).toMatchObject({ type: 'accepted', ok: true, requestId: 'avatar-refresh-flow-request' });
    expect(commands.at(-1)).toMatchObject({ type: 'refreshOwnProfile', accountId, workerInstanceId: binding.workerInstanceId });
    expect(LineWorkerCommandSchema.safeParse(commands.at(-1)).success).toBe(true);
    expect(await pool.query('SELECT display_name,picture_path FROM line_accounts WHERE account_id=$1', [accountId])).toMatchObject({
      rows: [{ display_name: 'Refreshed account', picture_path: picturePath }],
    });
    expect(published.some((event) => event.type === 'snapshotChanged')).toBe(true);
    expect(published.filter((event) => event.type === 'lineAvatarRefreshed')).toEqual([{ type: 'lineAvatarRefreshed', accountId, ownMid }]);
  });

  it('preserves a bounded Talk profile failure code without exposing worker prose', async () => {
    const accountId = 'avatar-refresh-server-error';
    const ownMid = `u${'c'.repeat(32)}`;
    await addStoredAccounts(accountId);
    const binding: TestBinding = { accountId, workerInstanceId: 'avatar-error-worker', controlEpoch: 0, mode: 'MONITOR_ONLY' };
    await workers.start(accountId, binding);
    await pool.query(`UPDATE line_accounts SET own_mid=$2,status='connected',mode='MONITOR_ONLY',connection_mode='SYSTEM_LOGIN',
      worker_instance_id=$3,worker_binding_epoch=$4 WHERE account_id=$1`,
    [accountId, ownMid, binding.workerInstanceId, binding.controlEpoch]);
    profileFailure = 'LINE_TALK_NOT_FOUND';
    const result = await facade.dispatch({ type: 'refreshLineAvatar', requestId: 'profile-5', accountId });
    expect(result).toMatchObject({ type: 'error', ok: false, code: 'LINE_PROFILE_REFRESH_FAILED',
      serverErrorCode: 'LINE_TALK_NOT_FOUND', message: 'LINE profile could not be refreshed.' });
    profileFailure = 'token=private MID=u12345678901234567890123456789012';
    const poisoned = await facade.dispatch({ type: 'refreshLineAvatar', requestId: 'profile-poison', accountId });
    expect(poisoned).toMatchObject({ type: 'error', ok: false, code: 'LINE_PROFILE_REFRESH_FAILED',
      message: 'LINE profile could not be refreshed.' });
    expect(poisoned).not.toHaveProperty('serverErrorCode');
    await audit.flush();
    expect(JSON.stringify(auditEvents)).not.toContain(profileFailure);
  });

  it('coalesces overlapping avatar refreshes for the same signed-in account', async () => {
    const accountId = 'avatar-refresh-overlap';
    const ownMid = `u${'b'.repeat(32)}`;
    await addStoredAccounts(accountId);
    const binding: TestBinding = { accountId, workerInstanceId: 'avatar-refresh-overlap-worker', controlEpoch: 0, mode: 'MONITOR_ONLY' };
    await workers.start(accountId, binding);
    await pool.query(`UPDATE line_accounts SET own_mid=$2,status='connected',mode='MONITOR_ONLY',connection_mode='SYSTEM_LOGIN',
      worker_instance_id=$3,worker_binding_epoch=$4 WHERE account_id=$1`,
    [accountId, ownMid, binding.workerInstanceId, binding.controlEpoch]);
    refreshedOwnProfile = { ownMid, displayName: 'Overlapping account', picturePath: 'https://profile.line-scdn.net/overlap.png' };
    let begin!: () => void;
    let release!: () => void;
    const started = new Promise<void>((resolve) => { begin = resolve; });
    const pending = new Promise<void>((resolve) => { release = resolve; });
    pendingOwnProfileRead = { started: begin, wait: pending, release };

    const first = facade.dispatch({ type: 'refreshLineAvatar', requestId: 'avatar-overlap-first', accountId });
    await started;
    const second = facade.dispatch({ type: 'refreshLineAvatar', requestId: 'avatar-overlap-second', accountId });
    await Promise.resolve();
    expect(commands.filter((command) => command.type === 'refreshOwnProfile')).toHaveLength(1);
    release();

    expect(await first).toMatchObject({ type: 'accepted', requestId: 'avatar-overlap-first', ok: true });
    expect(await second).toMatchObject({ type: 'accepted', requestId: 'avatar-overlap-second', ok: true });
    expect(published.filter((event) => event.type === 'lineAvatarRefreshed')).toHaveLength(1);
  });

  it.each([
    ['paused account', { accountMode: 'PAUSED' as const }],
    ['disconnected account', { status: 'disconnected' as const }],
    ['external monitor source', { connectionMode: 'EXTERNAL_MONITOR' as const }],
    ['download-only binding', { purpose: 'DOWNLOAD_ONLY' as const }],
  ] as [string, { accountMode?: 'PAUSED'; status?: 'disconnected'; connectionMode?: 'EXTERNAL_MONITOR'; purpose?: 'DOWNLOAD_ONLY' }][])('does not issue a profile read for a %s', async (_label, excluded) => {
    const accountId = `avatar-refresh-skip-${String(_label).replaceAll(' ', '-')}`;
    const ownMid = `u${'e'.repeat(32)}`;
    await addStoredAccounts(accountId);
    const binding: TestBinding = { accountId, workerInstanceId: `${accountId}-worker`, controlEpoch: 0, mode: 'MONITOR_ONLY',
      ...(excluded.purpose ? { purpose: excluded.purpose } : {}) };
    await workers.start(accountId, binding);
    await pool.query(`UPDATE line_accounts SET own_mid=$2,status=$3,mode=$4,connection_mode=$5,
      worker_instance_id=$6,worker_binding_epoch=$7 WHERE account_id=$1`,
    [accountId, ownMid, excluded.status ?? 'connected', excluded.accountMode ?? 'MONITOR_ONLY', excluded.connectionMode ?? 'SYSTEM_LOGIN',
      binding.workerInstanceId, binding.controlEpoch]);

    const result = await facade.dispatch({ type: 'refreshLineAvatar', requestId: `${accountId}-request`, accountId });

    expect(result).toMatchObject({ type: 'error', ok: false, code: 'LINE_PROFILE_REFRESH_UNAVAILABLE' });
    expect(commands.some((command) => command.type === 'refreshOwnProfile' && command.accountId === accountId)).toBe(false);
  });

  it.each(['logout', 'rebind'] as const)('discards a profile response after %s during the read', async (change) => {
    const accountId = `avatar-refresh-stale-${change}`;
    const ownMid = `u${'f'.repeat(32)}`;
    const oldPicture = 'https://profile.line-scdn.net/avatar-before-stale-read.png';
    await addStoredAccounts(accountId);
    const binding: TestBinding = { accountId, workerInstanceId: `${accountId}-worker`, controlEpoch: 0, mode: 'MONITOR_ONLY' };
    await workers.start(accountId, binding);
    await pool.query(`UPDATE line_accounts SET own_mid=$2,status='connected',mode='MONITOR_ONLY',connection_mode='SYSTEM_LOGIN',
      picture_path=$3,worker_instance_id=$4,worker_binding_epoch=$5 WHERE account_id=$1`,
    [accountId, ownMid, oldPicture, binding.workerInstanceId, binding.controlEpoch]);
    refreshedOwnProfile = { ownMid, displayName: 'Stale response', picturePath: 'https://profile.line-scdn.net/avatar-stale.png' };
    let begin!: () => void;
    let release!: () => void;
    const started = new Promise<void>((resolve) => { begin = resolve; });
    const pending = new Promise<void>((resolve) => { release = resolve; });
    pendingOwnProfileRead = { started: begin, wait: pending };
    const request = facade.dispatch({ type: 'refreshLineAvatar', requestId: `${accountId}-request`, accountId });
    await started;
    if (change === 'logout') {
      await pool.query("UPDATE line_accounts SET status='disconnected' WHERE account_id=$1", [accountId]);
    } else {
      const replacement: TestBinding = { ...binding, workerInstanceId: `${accountId}-replacement` };
      bindings.set(accountId, replacement);
      await pool.query('UPDATE line_accounts SET worker_instance_id=$2 WHERE account_id=$1', [accountId, replacement.workerInstanceId]);
    }
    release();

    expect(await request).toMatchObject({ type: 'error', ok: false, code: 'LINE_PROFILE_REFRESH_STALE' });
    expect((await pool.query('SELECT picture_path FROM line_accounts WHERE account_id=$1', [accountId])).rows[0]?.picture_path).toBe(oldPicture);
    expect(published.some((event) => event.type === 'lineAvatarRefreshed' && event.accountId === accountId)).toBe(false);
  });

  function latestLoginAttempt(accountId: string): string {
    const state = [...published].reverse().find((event) => event.type === 'lineLoginState'
      && event.accountId === accountId && event.state === 'connecting');
    if (state?.type !== 'lineLoginState' || !state.loginAttemptId) throw new Error('No current login attempt published');
    return state.loginAttemptId;
  }

  const pairedAdminMid = `u${'e'.repeat(32)}`;

  async function prepareAdminPairing(accountId: string) {
    await addStoredAccounts(accountId);
    await pool.query('UPDATE line_accounts SET own_mid=$2 WHERE account_id=$1', [accountId, `own-${accountId}`]);
    expect((await new AccountRepository(pool).activateControl(accountId, 1)).activated).toBe(true);
    expect((await facade.dispatch({ type: 'lineStart', requestId: `pairing-start-${accountId}`, accountId })).ok).toBe(true);
    await signalLoggedInReady(accountId, `own-${accountId}`, true);
    const binding = bindings.get(accountId);
    if (!binding) throw new Error('Active worker binding was not created');
    const result = await facade.dispatch({ type: 'lineBeginAdminPairing', requestId: `pairing-begin-${accountId}`, accountId });
    if (result.type !== 'lineAdminPairing') throw new Error('Pairing challenge was not created');
    return { binding, token: result.token };
  }

  async function deliverPairing(accountId: string, binding: TestBinding, token: string, batchId: string) {
    await workerEventHandler?.(binding.workerInstanceId, { type: 'batch', ...binding, batchId,
      cursorBefore: { version: 1, revision: '0', globalRev: '0', individualRev: '0' },
      cursorAfter: { version: 1, revision: '1', globalRev: '1', individualRev: '0' }, envelopes: [{
        eventId: `${batchId}-event`, messageId: `${batchId}-message`, accountId, chatType: 'direct',
        chatId: pairedAdminMid, senderId: pairedAdminMid, kind: 'text', text: token,
        mentionIds: [], mentionRanges: [], replyToMessageId: null,
        ingestion: { source: 'live', cursor: null }, occurredAt: new Date().toISOString(), attachments: [], raw: {},
      }] });
  }

  it('rejects forged control switching and lineStart without reserving an account slot', async () => {
    const before = await pool.query('SELECT count(*) FROM line_accounts');
    const switched = await facade.dispatch({ type: 'switchControl', requestId: 'forged-switch', accountId: 'forged', expectedEpoch: 1 });
    const started = await facade.dispatch({ type: 'lineStart', requestId: 'forged-start', accountId: 'forged-third' });
    expect(switched).toMatchObject({ ok: false, code: 'CONTROL_SWITCH_DISABLED' });
    expect(started).toMatchObject({ ok: false, code: 'ACCOUNT_NOT_FOUND' });
    expect(starts).toEqual([]);
    expect((await pool.query('SELECT count(*) FROM line_accounts')).rows[0].count).toBe(before.rows[0].count);
  });

  function holdNextSecretProtect() {
    let started!: () => void;
    let release!: () => void;
    const entered = new Promise<void>((resolve) => { started = resolve; });
    const wait = new Promise<void>((resolve) => { release = resolve; });
    pendingProtect = { started, wait };
    return { entered, release };
  }


  async function prepareAdminQrLogin() {
    await addStoredAccounts('account-a', 'account-b');
    await activate('account-a');
    await pool.query("UPDATE line_accounts SET own_mid='expected-admin-mid' WHERE account_id='account-b'");
    await pool.query("UPDATE account_administrators SET user_id='expected-admin-mid' WHERE account_id='account-a'");
    await facade.dispatch({ type: 'lineStart', requestId: 'start-admin', accountId: 'account-b' });
    const previous = bindings.get('account-b')!;
    secretStore.beginLogin('account-b', previous.workerInstanceId, 'stored-admin-secret');
    await secretStore.saveRotation('account-b', previous.workerInstanceId, 'stored-admin-secret',
      { token: 'previous-admin-token', qrCert: null, e2eeStorage: null });
    const result = await facade.dispatch({ type: 'lineLoginQr', requestId: 'admin-qr', accountId: 'account-b' });
    expect(result.ok).toBe(true);
    const binding = bindings.get('account-b')!;
    const persistedBinding = await pool.query<{ worker_instance_id: string; worker_binding_epoch: string }>(
      "SELECT worker_instance_id,worker_binding_epoch FROM line_accounts WHERE account_id='account-b'");
    expect(persistedBinding.rows[0]).toEqual({ worker_instance_id: binding.workerInstanceId,
      worker_binding_epoch: String(binding.controlEpoch) });
    const loginCommand = [...commands].reverse().find((command): command is Extract<LineWorkerCommand, { type: 'loginQr' }> =>
      command.type === 'loginQr' && command.accountId === 'account-b' && command.workerInstanceId === binding.workerInstanceId);
    if (!loginCommand) throw new Error('The current Admin binding did not receive a QR login command');
    const state = [...published].reverse().find((event) => event.type === 'lineLoginState'
      && event.accountId === 'account-b' && event.state === 'connecting');
    if (state?.type !== 'lineLoginState') throw new Error('No current Admin QR attempt was published');
    expect(state.loginAttemptId).toBe(loginCommand.loginAttemptId);
    return { binding, attempt: loginCommand.loginAttemptId };
  }

  it('stops only the invalidated account, clears its secret, and persists reauth_required', async () => {
    await addStoredAccounts('account-a', 'account-b');
    await activate('account-a');
    await facade.dispatch({ type: 'lineLoginQr', requestId: 'start-qr-account-a', accountId: 'account-a' });
    const accountA = bindings.get('account-a')!;
    const accountAAttempt = latestLoginAttempt('account-a');
    await workerEventHandler?.(accountA.workerInstanceId, { type: 'login', ...accountA, loginAttemptId: accountAAttempt,
      ownMid: 'own-account-a', displayName: 'Agent' });
    await workerEventHandler?.(accountA.workerInstanceId, { type: 'status', ...accountA, state: 'ready', message: null });
    expect(await facade.dispatch({ type: 'sendText', requestId: 'before-auth-invalidation', accountId: 'account-a',
      chatType: 'direct', chatId: 'chat-a', text: 'valid before invalidation' })).toMatchObject({ ok: true });
    await facade.dispatch({ type: 'lineStart', requestId: 'start-account-b', accountId: 'account-b' });
    const accountB = bindings.get('account-b')!;
    for (const [accountId, binding, attempt] of [['account-a', accountA, latestLoginAttempt('account-a')],
      ['account-b', accountB, 'attempt-account-b']] as const) {
      secretStore.beginLogin(accountId, binding.workerInstanceId, attempt);
      await secretStore.saveRotation(accountId, binding.workerInstanceId, attempt,
        { token: `token-${accountId}`, qrCert: null, e2eeStorage: null });
    }
    stops.length = 0;
    const commandsBeforeInvalidation = commands.length;
    const { RequestClient } = await import(new URL('./request/mod.js', import.meta.resolve('@evex/linejs/base')).href) as {
      RequestClient: { prototype: { request: (...args: any[]) => Promise<unknown> } };
    };
    const { InternalError } = await import(new URL('./core/mod.js', import.meta.resolve('@evex/linejs/base')).href) as {
      InternalError: new (type: string, message: string, data: Record<string, unknown>) => Error;
    };
    const authError = new InternalError('RequestError', 'Request internal failed', { code: 'NOT_AUTHORIZED_DEVICE' });
    const request = vi.spyOn(RequestClient.prototype, 'request').mockRejectedValue(authError);
    let invalidation = Promise.resolve();
    const adapter = await createLinejsAdapter({ accountId: accountA.accountId, workerInstanceId: accountA.workerInstanceId,
      controlEpoch: accountA.controlEpoch, mode: 'ACTIVE_CONTROL', validateLease: () => true,
      physicalTransport: async () => new Response() });
    await adapter.installSecrets({ token: [Buffer.from('{"alg":"HS256"}').toString('base64url'),
      Buffer.from('{"sub":"u-self"}').toString('base64url'), 'signature'].join('.'), qrCert: null, e2eeStorage: null });
    adapter.on('authInvalidated', () => {
      invalidation = workerEventHandler!(accountA.workerInstanceId, { type: 'authInvalidated', ...accountA });
    });
    try {
      await expect(adapter.sync({ version: 1, revision: '0', globalRev: '0', individualRev: '0' })).rejects.toBe(authError);
      await invalidation;
    } finally { request.mockRestore(); }
    const statuses = await pool.query('SELECT account_id,status FROM line_accounts ORDER BY account_id');
    expect(stops).toEqual(['account-a']);
    expect(statuses.rows).toEqual([{ account_id: 'account-a', status: 'reauth_required' },
      { account_id: 'account-b', status: 'disconnected' }]);
    expect(await secretStore.load('account-a')).toBeNull();
    expect((await secretStore.load('account-b'))?.token).toBe('token-account-b');
    expect(published).toContainEqual(expect.objectContaining({ type: 'lineLoginState', accountId: 'account-a', state: 'reauth_required' }));
    expect(await facade.dispatch({ type: 'sendText', requestId: 'after-auth-invalidation', accountId: 'account-a',
      chatType: 'direct', chatId: 'chat-a', text: 'must be blocked' })).toMatchObject({ ok: false });
    expect(commands.some((command) => command.type === 'manualSendText' && command.requestId === 'after-auth-invalidation')).toBe(false);
    expect(commands.slice(commandsBeforeInvalidation).some((command) => command.type === 'loginToken' || command.type === 'loginQr')).toBe(false);
  });

  it('rejects direct facade Notes reads without sending a LINE resource request', async () => {
    const key = { accountId: 'account-a', chatType: 'group' as const, chatId: 'archive-chat' };
    const readsBefore = archiveReads;
    await expect(facade.listChatNotes(key, null)).rejects.toThrow('Notes are disabled.');
    await expect(facade.getChatNote(key, 'note-a')).rejects.toThrow('Notes are disabled.');
    expect(archiveReads).toBe(readsBefore);
  });

  it('returns the IPC error code UNSUPPORTED for a worker UNSUPPORTED result and keeps other codes', async () => {
    await addStoredAccounts('account-a');
    await loginReady('account-a');
    await pool.query("INSERT INTO conversations(account_id,chat_type,chat_id,title) VALUES ('account-a','group','archive-chat','Archive test') ON CONFLICT DO NOTHING");
    Object.assign(bindings.get('account-a')!, { transportOwnerId: 'archive-owner', transportGeneration: 1, writeGrantVersion: 1 });
    const workerError = (command: ChatResourceRequest, error: string) => ({
      type: 'chatResourceResult' as const, requestId: command.requestId, action: command.action, ok: false as const, error,
      accountId: command.accountId, workerInstanceId: command.workerInstanceId, controlEpoch: command.controlEpoch,
      chatType: command.chatType, chatId: command.chatId });
    const adapter = createIpcAdapter({ webContentsId: 7, rendererUrl: 'file:///app/index.html', onDiagnostic: vi.fn(),
      service: { dispatch: (request, signal) => facade.dispatch(request, signal) } });
    const sender = { senderId: 7, url: 'file:///app/index.html' };
    const route = { accountId: 'account-a', chatType: 'group', chatId: 'archive-chat' };
    workers.readChatResource = async (command) => workerError(command, 'UNSUPPORTED');
    await expect(adapter(sender, { type: 'listChatNotes', requestId: 'notes-unsupported', ...route, cursor: null }))
      .resolves.toMatchObject({ type: 'error', ok: false, code: 'UNSUPPORTED' });
    await expect(adapter(sender, { type: 'listChatAlbums', requestId: 'albums-unsupported', ...route, cursor: null }))
      .resolves.toMatchObject({ type: 'error', ok: false, code: 'UNSUPPORTED' });
    workers.readChatResource = async (command) => workerError(command, 'response_shape_invalid');
    await expect(adapter(sender, { type: 'listChatNotes', requestId: 'notes-other-error', ...route, cursor: null }))
      .resolves.toMatchObject({ type: 'error', code: 'SERVICE_ERROR' });
  });

  it('cancels a pending album open without diagnostics or late publication, then accepts the next request', async () => {
    await addStoredAccounts('account-a');
    await loginReady('account-a');
    await pool.query("INSERT INTO conversations(account_id,chat_type,chat_id,title) VALUES ('account-a','group','archive-chat','Archive test') ON CONFLICT DO NOTHING");
    Object.assign(bindings.get('account-a')!, { transportOwnerId: 'archive-owner', transportGeneration: 1, writeGrantVersion: 1 });
    archiveStore.ensureAlbumFolder = async () => undefined;
    archiveStore.publishAlbumPhoto = async () => { archiveCommits++; };

    let readStarted!: () => void;
    const started = new Promise<void>((resolve) => { readStarted = resolve; });
    let resolveRead!: (result: ChatResourceReadResult) => void;
    workers.readChatResource = async (command) => {
      archiveReads++;
      readStarted();
      return await new Promise<ChatResourceReadResult>((resolve) => { resolveRead = resolve; });
    };

    const onDiagnostic = vi.fn();
    const adapter = createIpcAdapter({ webContentsId: 7, rendererUrl: 'file:///app/index.html', onDiagnostic,
      service: { dispatch: (request, signal) => facade.dispatch(request, signal) } });
    const sender = { senderId: 7, url: 'file:///app/index.html' };
    let wireResult: unknown;
    const preloadApi = createDesktopApi({ async invoke(_channel, payload) {
      wireResult = await adapter(sender, payload);
      return wireResult;
    }, on() {}, removeListener() {} });
    const openRequest = (requestId: string) => ({ type: 'openChatAlbum', requestId, accountId: 'account-a',
      chatType: 'group', chatId: 'archive-chat', albumId: 'album-a' });
    const auditEventsBeforeCancel = auditEvents.length;
    const pendingOpen = adapter(sender, openRequest('album-cancelled'));
    const enteredRead = await Promise.race([started.then(() => true), pendingOpen.then((result) => result)]);
    if (enteredRead !== true) throw new Error(`Album request returned before worker read: ${JSON.stringify(enteredRead)}`);
    await expect(adapter(sender, { type: 'cancelChatResourceRequest', requestId: 'album-cancel', targetRequestId: 'album-cancelled' }))
      .resolves.toMatchObject({ type: 'cancelChatResourceRequest', ok: true, cancelled: true });
    await expect(pendingOpen).resolves.toMatchObject({ type: 'error', code: 'CANCELLED' });
    const readsAfterCancel = archiveReads;
    await audit.flush();
    expect(onDiagnostic).not.toHaveBeenCalled();
    expect(auditEvents.slice(auditEventsBeforeCancel).some((event) => event.requestId === 'album-cancelled')).toBe(false);

    resolveRead({ type: 'chatResourceResult', requestId: 'late-album-read', action: 'listAlbumPhotos', ok: true,
      accountId: 'account-a', workerInstanceId: bindings.get('account-a')!.workerInstanceId, controlEpoch: bindings.get('account-a')!.controlEpoch,
      chatType: 'group', chatId: 'archive-chat', photos: [], nextCursor: null });
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(archiveCommits).toBe(0);
    expect(archiveReads).toBe(readsAfterCancel);

    workers.readChatResource = async (command) => {
      archiveReads++;
      return { type: 'chatResourceResult', requestId: command.requestId, action: command.action, ok: true,
        accountId: command.accountId, workerInstanceId: command.workerInstanceId, controlEpoch: command.controlEpoch,
        chatType: command.chatType, chatId: command.chatId, photos: [], nextCursor: null };
    };
    await expect(preloadApi.openChatAlbum({ accountId: 'account-a', chatType: 'group', chatId: 'archive-chat' }, 'album-a', 'album-after-cancel'))
      .resolves.toMatchObject({ albumId: 'album-a', savedCount: 0, failedCount: 0, totalCount: 0, complete: true, errorCode: null });
    expect(IpcResultSchema.safeParse(wireResult).success).toBe(true);
    expect(wireResult).not.toHaveProperty('nextCursor');
    expect(wireResult).not.toHaveProperty('nextPhotoIndex');
    expect(archiveReads).toBe(readsAfterCancel + 1);

    workers.readChatResource = async (command) => command.action === 'listAlbumPhotos'
      ? { type: 'chatResourceResult', requestId: command.requestId, action: command.action, ok: true,
        accountId: command.accountId, workerInstanceId: command.workerInstanceId, controlEpoch: command.controlEpoch,
        chatType: command.chatType, chatId: command.chatId,
        photos: [{ photoId: 'denied-photo', oid: 'denied-oid', prefix: 'album/a', shotTime: null, width: null, height: null }], nextCursor: null }
      : { type: 'chatResourceResult', requestId: command.requestId, action: command.action, ok: false, error: 'response_shape_invalid',
        accountId: command.accountId, workerInstanceId: command.workerInstanceId, controlEpoch: command.controlEpoch,
        chatType: command.chatType, chatId: command.chatId };
    await expect(preloadApi.openChatAlbum({ accountId: 'account-a', chatType: 'group', chatId: 'archive-chat' }, 'album-a', 'album-failed'))
      .resolves.toMatchObject({ complete: false, savedCount: 0, failedCount: 1, totalCount: 1,
        failureContext: { action: 'photo_download', stage: 'resource_read', code: 'ALBUM_RECONCILIATION_FAILED' } });
    expect(IpcResultSchema.safeParse(wireResult).success).toBe(true);
    expect(wireResult).not.toHaveProperty('nextCursor');
    expect(wireResult).not.toHaveProperty('nextPhotoIndex');

    archiveStore.ensureAlbumFolder = async () => { throw new Error('unexpected archive failure'); };
    await expect(adapter(sender, openRequest('album-unexpected'))).resolves.toMatchObject({ type: 'error', code: 'SERVICE_ERROR' });
    await audit.flush();
    expect(auditEvents).toContainEqual(expect.objectContaining({ action: 'runtime_error', requestId: 'album-unexpected',
      diagnostic: expect.objectContaining({ category: 'unknown' }) }));
  });

  it('recovers an overdue album retry only after the current Agent binding is authenticated and ready', async () => {
    const accountId = 'startup-album-recovery';
    const chatId = 'startup-album-chat';
    const messageId = 'startup-album-notification';
    await addStoredAccounts(accountId);
    secretStore.beginLogin(accountId, 'startup-secret-seed', 'startup-secret-seed-attempt');
    expect(await secretStore.saveRotation(accountId, 'startup-secret-seed', 'startup-secret-seed-attempt',
      { token: 'startup-test-token', qrCert: null, e2eeStorage: null })).toBe(true);
    await pool.query("INSERT INTO conversations(account_id,chat_type,chat_id,title) VALUES ($1,'group',$2,'Startup archive') ON CONFLICT DO NOTHING",
      [accountId, chatId]);
    await pool.query(`INSERT INTO messages(account_id,message_id,event_id,chat_type,chat_id,sender_id,kind,ingestion_source,occurred_at,raw)
      VALUES ($1,$2,$3,'group',$4,'friend-mid','event','live',now(),$5::jsonb)`,
    [accountId, messageId, `${messageId}-event`, chatId,
      JSON.stringify({ message: { id: messageId, from: 'friend-mid', to: chatId, toType: 2, contentType: 16,
        contentMetadata: { serviceType: 'AB' } } })]);
    await pool.query(`INSERT INTO album_notification_tasks(account_id,chat_type,chat_id,message_id,status,attempt_count,next_attempt_at,error_stage,error_code)
      VALUES ($1,'group',$2,$3,'retry',9,clock_timestamp()-interval '1 second','archive_scan','ALBUM_RECONCILIATION_FAILED')`,
    [accountId, chatId, messageId]);

    let savedPhotos = 0;
    const actions: string[] = [];
    archiveStore.ensureAlbumFolder = async () => undefined;
    archiveStore.hasAlbumPhoto = async () => false;
    archiveStore.publishAlbumPhoto = async () => { savedPhotos++; };
    workers.readChatResource = async (command) => {
      actions.push(command.action);
      const data = command.action === 'listAlbums' ? { albums: [{ albumId: 'startup-album', chatId, title: 'Album',
        photoCount: 1, createTime: 1, updateTime: 2 }], nextCursor: null }
        : command.action === 'listAlbumPhotos' ? { photos: [{ photoId: 'startup-photo', oid: 'startup-oid', prefix: 'album/a',
          shotTime: 1, width: 2, height: 3 }], nextCursor: null } : { bytes: new Uint8Array([1, 2, 3]) };
      return { type: 'chatResourceResult', requestId: command.requestId, action: command.action, ok: true,
        accountId: command.accountId, workerInstanceId: command.workerInstanceId, controlEpoch: command.controlEpoch,
        chatType: command.chatType, chatId: command.chatId, ...data } as ChatResourceReadResult;
    };

    await activate(accountId);
    await new Promise<void>((resolve) => setTimeout(resolve, 30));
    expect((await pool.query<{ attempt_count: number; status: string }>(
      'SELECT attempt_count,status FROM album_notification_tasks WHERE account_id=$1 AND message_id=$2', [accountId, messageId])).rows[0])
      .toEqual({ attempt_count: 9, status: 'retry' });
    expect(actions).toEqual([]);

    const binding = bindings.get(accountId)!;
    Object.assign(binding, { transportOwnerId: 'startup-album-owner', transportGeneration: 1, writeGrantVersion: 1 });
    const tokenLogin = [...commands].reverse().find((command) => command.type === 'loginToken' && command.accountId === accountId);
    if (tokenLogin?.type !== 'loginToken') throw new Error('Startup did not dispatch token login');
    const loginAttemptId = tokenLogin.loginAttemptId;
    await workerEventHandler!(binding.workerInstanceId, { type: 'login', ...binding, loginAttemptId,
      ownMid: `own-${accountId}`, displayName: 'Agent' });
    expect(actions).toEqual([]);
    await workerEventHandler!(binding.workerInstanceId, { type: 'status', ...binding, state: 'ready', message: null });
    await vi.waitFor(async () => {
      const row = await pool.query<{ attempt_count: number; status: string }>(
        'SELECT attempt_count,status FROM album_notification_tasks WHERE account_id=$1 AND message_id=$2', [accountId, messageId]);
      expect(row.rows[0]).toEqual({ attempt_count: 10, status: 'completed' });
    });
    expect(actions).toEqual(['listAlbums', 'listAlbumPhotos', 'downloadAlbumPhoto']);
    expect(savedPhotos).toBe(1);
  });

  it.each(['group', 'direct'] as const)('archives a committed live Album POSTNOTIFICATION in a %s chat without renderer action or Note reads', async (chatType) => {
    const accountId = 'automatic-album-notification';
    const chatId = `automatic-album-chat-${chatType}`;
    await addStoredAccounts(accountId);
    const binding = await loginReady(accountId);
    await pool.query("INSERT INTO conversations(account_id,chat_type,chat_id,title) VALUES ($1,$2,$3,'Automatic archive') ON CONFLICT DO NOTHING", [accountId, chatType, chatId]);
    Object.assign(bindings.get(accountId)!, { transportOwnerId: 'automatic-album-owner', transportGeneration: 1, writeGrantVersion: 1 });
    const actions: string[] = [];
    const savedAlbumFolder = join(secretRoot, 'automatic-album-folder');
    const savedPhotoPath = join(savedAlbumFolder, 'automatic-photo.bin');
    const photoBytes = new Uint8Array([1, 2, 3, 4, 5]);
    let photos = 0;
    archiveStore.ensureAlbumFolder = async () => { await mkdir(savedAlbumFolder, { recursive: true }); };
    archiveStore.hasAlbumPhoto = async () => false;
    archiveStore.publishAlbumPhoto = async ({ content }) => { await writeFile(savedPhotoPath, content); photos++; };
    workers.readChatResource = async (command) => {
      actions.push(command.action);
      const data = command.action === 'listAlbums' ? { albums: [{ albumId: 'automatic-album', chatId, title: 'Album',
        photoCount: 1, createTime: 1, updateTime: 2 }], nextCursor: null }
        : command.action === 'listAlbumPhotos' ? { photos: [{ photoId: 'automatic-photo', oid: 'automatic-oid', prefix: 'album/a',
          shotTime: 1, width: 2, height: 3 }], nextCursor: null } : { bytes: photoBytes };
      return { type: 'chatResourceResult', requestId: command.requestId, action: command.action, ok: true, accountId: command.accountId,
        workerInstanceId: command.workerInstanceId, controlEpoch: command.controlEpoch, chatType: command.chatType, chatId: command.chatId, ...data } as ChatResourceReadResult;
    };
    const checkpoint = await pool.query<{ cursor: { version: 1; revision: string; globalRev: string; individualRev: string } }>(
      'SELECT cursor FROM external_source_checkpoints WHERE account_id=$1 AND source_id=(SELECT selected_source_id FROM line_accounts WHERE account_id=$1)', [accountId]);
    const before = checkpoint.rows[0]!.cursor;
    const after = { version: 1 as const, revision: (BigInt(before.revision) + 1n).toString(),
      globalRev: (BigInt(before.globalRev) + 1n).toString(), individualRev: before.individualRev };
    const raw = { message: { id: 'album-notification-message', from: 'friend-mid', to: chatId, toType: chatType === 'group' ? 2 : 0,
      contentType: 16, contentMetadata: { serviceType: 'AB' } } };
    await workerEventHandler!(binding.workerInstanceId, { type: 'batch', ...binding, batchId: 'automatic-album-notification-batch',
      cursorBefore: before, cursorAfter: after, envelopes: [{ eventId: 'automatic-album-notification-event', messageId: 'album-notification-message',
        accountId, chatType, chatId, senderId: 'friend-mid', kind: 'event', text: null,
        mentionIds: [], mentionRanges: [], replyToMessageId: null, ingestion: { source: 'live', cursor: null },
        occurredAt: new Date().toISOString(), attachments: [], raw }] });

    await vi.waitFor(() => expect(actions).toHaveLength(3));
    await vi.waitFor(() => expect(photos).toBe(1));
    expect(actions).toEqual(['listAlbums', 'listAlbumPhotos', 'downloadAlbumPhoto']);
    expect(actions).not.toContain('listNotes');
    expect(await readdir(savedAlbumFolder)).toEqual(['automatic-photo.bin']);
    expect(new Uint8Array(await readFile(savedPhotoPath))).toEqual(photoBytes);

    await expect(pool.query<{ status: string }>(`SELECT status FROM album_notification_tasks
      WHERE account_id=$1 AND chat_type=$2 AND chat_id=$3 AND message_id='album-notification-message'`, [accountId, chatType, chatId]))
      .resolves.toMatchObject({ rows: [{ status: 'completed' }] });

    const persisted = await pool.query<{ chat_type: string; chat_id: string }>(
      `SELECT DISTINCT chat_type, chat_id FROM messages WHERE account_id = $1 AND ingestion_source = 'live'
       AND raw #>> '{message,contentType}' IN ('16', 'POSTNOTIFICATION')
       AND raw #>> '{message,contentMetadata,serviceType}' = 'AB'`, [accountId]);
    expect(persisted.rows).toContainEqual({ chat_type: chatType, chat_id: chatId });
  });

  it('ignores an invalidation whose database binding has already been replaced', async () => {
    await addStoredAccounts('account-a');
    await activate('account-a');
    await facade.dispatch({ type: 'lineLoginQr', requestId: 'start-qr-a', accountId: 'account-a' });
    const old = bindings.get('account-a')!;
    const attempt = latestLoginAttempt('account-a');
    stops.length = 0;
    secretStore.beginLogin('account-a', old.workerInstanceId, attempt);
    await secretStore.saveRotation('account-a', old.workerInstanceId, attempt,
      { token: 'keep-this-token', qrCert: null, e2eeStorage: null });
    await new AccountRepository(pool).bindWorker({ accountId: 'account-a', workerInstanceId: 'replacement-worker',
      controlEpoch: old.controlEpoch });
    published.length = 0;

    await workerEventHandler!(old.workerInstanceId, { type: 'authInvalidated', ...old });

    expect(stops).toEqual([]);
    expect((await new AccountRepository(pool).getAccount('account-a'))?.ownMid).toBe('own-account-a');
    expect((await pool.query("SELECT status,worker_instance_id FROM line_accounts WHERE account_id='account-a'")).rows[0])
      .toEqual({ status: 'disconnected', worker_instance_id: 'replacement-worker' });
    expect((await secretStore.load('account-a'))?.token).toBe('keep-this-token');
    expect(published).toEqual([]);
  });

  it('holds QR replacement behind fenced invalidation and lets the replacement secret win', async () => {
    await addStoredAccounts('account-a');
    await activate('account-a');
    await facade.dispatch({ type: 'lineLoginQr', requestId: 'start-qr-a', accountId: 'account-a' });
    const old = bindings.get('account-a')!;
    const oldAttempt = latestLoginAttempt('account-a');
    const gate = holdNextSecretProtect();
    const oldSave = secretStore.saveRotation('account-a', old.workerInstanceId, oldAttempt,
      { token: 'old-token', qrCert: null, e2eeStorage: null });
    await gate.entered;
    stops.length = 0;

    const invalidation = workerEventHandler!(old.workerInstanceId, { type: 'authInvalidated', ...old });
    await waitForState(() => expect(stops).toContain('account-a'));
    let replacementFinished = false;
    const replacement = facade.dispatch({ type: 'lineLoginQr', requestId: 'replace-qr-a', accountId: 'account-a' })
      .then((result) => { replacementFinished = true; return result; });
    await Promise.resolve();
    expect(replacementFinished).toBe(false);

    gate.release();
    await expect(oldSave).resolves.toBe(false);
    await invalidation;
    await expect(replacement).resolves.toMatchObject({ ok: true });
    const current = bindings.get('account-a')!;
    const currentAttempt = latestLoginAttempt('account-a');
    expect(current.workerInstanceId).not.toBe(old.workerInstanceId);
    expect(await secretStore.saveRotation('account-a', current.workerInstanceId, currentAttempt,
      { token: 'new-token', qrCert: null, e2eeStorage: null })).toBe(true);
    expect((await secretStore.load('account-a'))?.token).toBe('new-token');
    const stateEvents = published.filter((event) => event.type === 'lineLoginState' && event.accountId === 'account-a');
    expect(stateEvents.filter((event) => event.type === 'lineLoginState' && event.state === 'reauth_required'))
      .toEqual([expect.objectContaining({ loginAttemptId: oldAttempt })]);
    expect(stateEvents.at(-1)).toMatchObject({ loginAttemptId: currentAttempt, state: 'connecting' });
  });

  it('holds lineStart token restore behind invalidation clear and preserves the next credential', async () => {
    await addStoredAccounts('account-a', 'account-b');
    await activate('account-a');
    await facade.dispatch({ type: 'lineLoginQr', requestId: 'start-qr-a', accountId: 'account-a' });
    const old = bindings.get('account-a')!;
    const oldAttempt = latestLoginAttempt('account-a');
    expect(await secretStore.saveRotation('account-a', old.workerInstanceId, oldAttempt,
      { token: 'saved-old-token', qrCert: null, e2eeStorage: null })).toBe(true);

    await facade.dispatch({ type: 'lineStart', requestId: 'start-account-b', accountId: 'account-b' });
    const accountB = bindings.get('account-b')!;
    secretStore.beginLogin('account-b', accountB.workerInstanceId, 'account-b-attempt');
    expect(await secretStore.saveRotation('account-b', accountB.workerInstanceId, 'account-b-attempt',
      { token: 'account-b-token', qrCert: null, e2eeStorage: null })).toBe(true);

    const gate = holdNextSecretProtect();
    const oldSave = secretStore.saveRotation('account-a', old.workerInstanceId, oldAttempt,
      { token: 'held-old-token', qrCert: null, e2eeStorage: null });
    await gate.entered;
    stops.length = 0;
    const invalidation = workerEventHandler!(old.workerInstanceId, { type: 'authInvalidated', ...old });
    await waitForState(() => expect(stops).toContain('account-a'));

    const startsBeforeReplacement = starts.length;
    const commandsBeforeReplacement = commands.length;
    const replacement = facade.dispatch({ type: 'lineStart', requestId: 'line-start-replacement-a', accountId: 'account-a' });
    let noEarlyStart = false;
    try {
      await new Promise((resolve) => setTimeout(resolve, 30));
      noEarlyStart = starts.length === startsBeforeReplacement
        && !commands.slice(commandsBeforeReplacement).some((command) => command.type === 'loginToken');
    } finally { gate.release(); }
    await expect(oldSave).resolves.toBe(false);
    await invalidation;
    expect(noEarlyStart).toBe(true);
    await expect(replacement).resolves.toMatchObject({ ok: true });
    expect((await secretStore.load('account-a'))?.token).toBeUndefined();
    expect((await secretStore.load('account-b'))?.token).toBe('account-b-token');
    const lineStartBinding = bindings.get('account-a')!;

    await facade.dispatch({ type: 'lineLoginQr', requestId: 'qr-after-line-start-a', accountId: 'account-a' });
    const qrBinding = bindings.get('account-a')!;
    const newAttempt = latestLoginAttempt('account-a');
    expect(qrBinding.workerInstanceId).not.toBe(lineStartBinding.workerInstanceId);
    expect(await secretStore.saveRotation('account-a', qrBinding.workerInstanceId, newAttempt,
      { token: 'new-after-invalidation-token', qrCert: null, e2eeStorage: null })).toBe(true);
    expect((await secretStore.load('account-a'))?.token).toBe('new-after-invalidation-token');
    const stateEvents = published.filter((event) => event.type === 'lineLoginState' && event.accountId === 'account-a');
    const oldTerminalIndex = stateEvents.findIndex((event) => event.type === 'lineLoginState'
      && event.loginAttemptId === oldAttempt && event.state === 'reauth_required');
    const newConnectingIndex = stateEvents.findIndex((event) => event.type === 'lineLoginState'
      && event.loginAttemptId === newAttempt && event.state === 'connecting');
    expect(oldTerminalIndex).toBeGreaterThanOrEqual(0);
    expect(newConnectingIndex).toBeGreaterThan(oldTerminalIndex);
    expect(stateEvents.slice(newConnectingIndex + 1).some((event) => event.type === 'lineLoginState'
      && event.loginAttemptId === oldAttempt && event.state === 'reauth_required')).toBe(false);
  });

  it('persists the app-wide autoresponder rules with a version check', async () => {
    await addStoredAccounts('account-a', 'account-b');
    const initial = await facade.dispatch({ type: 'getAutoResponderSettings', requestId: 'get-auto-a' });
    expect(initial).toMatchObject({ type: 'getAutoResponderSettings', settings: {
      version: 0, displayName: 'Agent', fallback: '我不知道你在說甚麼', rules: [],
    } });
    const saved = await facade.dispatch({ type: 'setAutoResponderSettings', requestId: 'save-auto-a',
      expectedVersion: 0, displayName: 'Helper', fallback: 'Unknown', rules: [{ trigger: ' hello   there ', reply: 'Hi' }] });
    expect(saved).toMatchObject({ type: 'setAutoResponderSettings', version: 1, ok: true });
    const loaded = await facade.dispatch({ type: 'getAutoResponderSettings', requestId: 'reload-auto-a' });
    expect(loaded).toMatchObject({ settings: { version: 1, rules: [{ trigger: 'hello there', reply: 'Hi' }] } });
    expect(await facade.dispatch({ type: 'getAutoResponderSettings', requestId: 'get-auto-b' }))
      .toMatchObject({ settings: { version: 1, displayName: 'Helper', rules: [{ trigger: 'hello there', reply: 'Hi' }] } });
    expect(await facade.dispatch({ type: 'setAutoResponderSettings', requestId: 'stale-auto-a',
      expectedVersion: 0, displayName: 'Lost update', fallback: 'Unknown', rules: [] }))
      .toMatchObject({ ok: false, code: 'AUTORESPONDER_VERSION_CONFLICT' });
    expect(await facade.dispatch({ type: 'getAutoResponderSettings', requestId: 'reload-after-auto-conflict' }))
      .toMatchObject({ settings: { version: 1, displayName: 'Helper', fallback: 'Unknown', rules: [{ trigger: 'hello there', reply: 'Hi' }] } });
  });

  it('rejects direct IPC enablement of a group room Agent policy', async () => {
    await addStoredAccounts('account-a');
    const messages = new MessageRepository(pool);
    await messages.upsertConversationCatalog('account-a', [{ chatType: 'group', chatId: 'unconfirmed-room', title: 'Unconfirmed', members: [] }]);
    const result = await facade.dispatch({ type: 'setConversationAgent', requestId: 'enable-unconfirmed-room',
      accountId: 'account-a', chatType: 'group', chatId: 'unconfirmed-room', enabled: true, provider: 'codex' });
    expect(result).toMatchObject({ ok: false, code: 'ROOM_REQUIRES_CONFIRMATION' });
    expect((await pool.query("SELECT agent_enabled FROM conversations WHERE account_id='account-a' AND chat_id='unconfirmed-room'")).rows[0].agent_enabled).toBe(false);
  });

  it('keeps the mirrored unread count when an external-monitor chat is opened, while a live account still clears it', async () => {
    await addStoredAccounts('unread-live-account', 'unread-monitor-account');
    for (const [accountId, mode] of [['unread-live-account', 'SYSTEM_LOGIN'], ['unread-monitor-account', 'EXTERNAL_MONITOR']] as const) {
      await pool.query('UPDATE line_accounts SET connection_mode=$2 WHERE account_id=$1', [accountId, mode]);
      await pool.query(`INSERT INTO conversations(account_id,chat_type,chat_id,title,unread_count) VALUES ($1,'group','unread-chat','',5)`, [accountId]);
      await facade.listMessages({ accountId, chatType: 'group', chatId: 'unread-chat' }, null, 10);
    }
    const unread = async (accountId: string) => (await pool.query<{ unread_count: number }>(
      "SELECT unread_count FROM conversations WHERE account_id=$1 AND chat_id='unread-chat'", [accountId])).rows[0]?.unread_count;
    expect(await unread('unread-monitor-account')).toBe(5);
    expect(await unread('unread-live-account')).toBe(0);
  });

  it('rejects manual LINE sends for an EXTERNAL_MONITOR account while the shared Agent room still accepts work', async () => {
    await addStoredAccounts('external-send-account');
    await activate('external-send-account');
    await pool.query("UPDATE line_accounts SET connection_mode='EXTERNAL_MONITOR' WHERE account_id='external-send-account'");

    expect(await facade.dispatch({ type: 'sendText', requestId: 'external-manual-send', accountId: 'external-send-account',
      chatType: 'direct', chatId: 'chat-1', text: 'hello' })).toMatchObject({ ok: false, code: 'LINE_SEND_NOT_STARTED' });
    // The Agent room is the operator's own and is not gated by any account's LINE write capability.
    expect(await facade.dispatch({ type: 'setWorkspace', requestId: 'external-workspace', workspacePath: tmpdir() })).toMatchObject({ ok: true });
    expect(await facade.dispatch({ type: 'submitAgentRoomPrompt', requestId: 'external-agent-prompt', provider: 'codex', prompt: 'summarize' }))
      .toMatchObject({ ok: true, type: 'submitAgentRoomPrompt' });
    expect((await pool.query("SELECT account_id, chat_id, source_type FROM agent_jobs WHERE source_request_id='external-agent-prompt'")).rows)
      .toEqual([{ account_id: null, chat_id: null, source_type: 'ui' }]);
    expect(commands.filter((command) => command.type === 'manualSendText')).toHaveLength(0);
    expect((await pool.query("SELECT count(*) FROM agent_jobs WHERE account_id='external-send-account'")).rows[0]?.count).toBe('0');
  });

  it('stores Agent room attachments atomically: files and metadata on success, no row and no files on rejection', async () => {
    const workspace = await realpath(await mkdtemp(join(tmpdir(), 'linejs-facade-attach-')));
    try {
      expect(await facade.dispatch({ type: 'setWorkspace', requestId: 'attach-workspace', workspacePath: workspace })).toMatchObject({ ok: true });
      const png = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2]);
      const ok = await facade.dispatch({ type: 'submitAgentRoomPrompt', requestId: 'attach-ok', provider: 'codex', prompt: '',
        attachments: [{ name: '..\\..\\shot.png', bytes: png }] });
      expect(ok).toMatchObject({ ok: true, type: 'submitAgentRoomPrompt' });
      const row = (await pool.query("SELECT job_id, prompt, attachments FROM agent_jobs WHERE source_request_id='attach-ok'")).rows[0];
      expect(row.prompt).toBe('請查看附件。');
      expect(row.attachments).toEqual([expect.objectContaining({ name: 'shot.png', kind: 'image', mime: 'image/png', size: 10,
        relativePath: `.agent-attachments/${row.job_id}/shot.png`, sha256: expect.stringMatching(/^[0-9a-f]{64}$/) })]);
      expect(new Uint8Array(await readFile(join(workspace, '.agent-attachments', row.job_id, 'shot.png')))).toEqual(png);

      // The snapshot summary carries name, size and kind only: no path, hash or mime.
      const snapshot = await facade.dispatch({ type: 'getSnapshot', requestId: 'attach-snapshot' });
      const summary = snapshot.type === 'getSnapshot' ? snapshot.snapshot.jobs.find((job) => job.jobId === row.job_id) : undefined;
      expect(summary?.attachments).toEqual([{ name: 'shot.png', size: 10, kind: 'image' }]);

      const rejected = await facade.dispatch({ type: 'submitAgentRoomPrompt', requestId: 'attach-big', provider: 'codex', prompt: 'x',
        attachments: [{ name: 'big.bin', bytes: new Uint8Array(20 * 1024 * 1024 + 1) }] });
      expect(rejected).toMatchObject({ ok: false, code: 'ATTACHMENT_LIMIT' });
      expect((await pool.query("SELECT count(*) FROM agent_jobs WHERE source_request_id='attach-big'")).rows[0].count).toBe('0');
    } finally { await rm(workspace, { recursive: true, force: true }); }
  });

  it('refuses to stop, retry or read a LINE job through the Agent room requests and sends nothing to the worker', async () => {
    await addStoredAccounts('room-bypass-account');
    await new MessageRepository(pool).upsertConversationCatalog('room-bypass-account', [{ chatType: 'group', chatId: 'bypass-chat', title: 'Bypass', members: [] }]);
    await pool.query(`INSERT INTO messages (account_id, message_id, event_id, chat_id, chat_type, sender_id, kind, ingestion_source, occurred_at, raw)
      VALUES ('room-bypass-account','bm-run','be-run','bypass-chat','group','s','text','live',now(),'{}'::jsonb),
             ('room-bypass-account','bm-fail','be-fail','bypass-chat','group','s','text','live',now(),'{}'::jsonb)`);
    await pool.query(`INSERT INTO agent_sessions (account_id, chat_type, chat_id, provider, source_type) VALUES ('room-bypass-account','group','bypass-chat','codex','line')`);
    const runningId = randomUUID(); const failedId = randomUUID();
    for (const [jobId, messageId, status] of [[runningId, 'bm-run', 'running'], [failedId, 'bm-fail', 'failed']] as const) {
      await pool.query(
        `INSERT INTO agent_jobs (job_id, account_id, chat_type, chat_id, provider, source_type, source_message_id, prompt, workspace_path, generation, creation_epoch, status)
         VALUES ($1,'room-bypass-account','group','bypass-chat','codex','line',$2,'p','C:\\work',0,0,$3)`, [jobId, messageId, status]);
    }
    await pool.query('INSERT INTO agent_events (job_id, event) VALUES ($1, \'{"type":"text_delta","text":"line only"}\'::jsonb)', [runningId]);
    const statuses = async () => (await pool.query('SELECT status FROM agent_jobs WHERE job_id = ANY($1) ORDER BY status', [[runningId, failedId]])).rows;
    const before = await statuses();
    expect(await facade.dispatch({ type: 'setWorkspace', requestId: 'bypass-workspace', workspacePath: tmpdir() })).toMatchObject({ ok: true });
    const commandCount = commands.length;

    expect(await facade.dispatch({ type: 'stopAgentRoomJob', requestId: 'bypass-stop', jobId: runningId })).toMatchObject({ ok: true });
    expect(await facade.dispatch({ type: 'retryAgentRoomJob', requestId: 'bypass-retry', jobId: failedId }))
      .toMatchObject({ ok: false, code: 'AGENT_JOB_NOT_RETRYABLE', message: '此任務目前無法重試（可能已取消、已產生輸出，或所屬 Agent 會話已變更）。' });
    expect(await facade.dispatch({ type: 'getAgentRoomJobEvents', requestId: 'bypass-events', jobId: runningId }))
      .toMatchObject({ ok: true, type: 'getAgentRoomJobEvents', events: [] });

    expect(await statuses()).toEqual(before);
    expect(before.map((row) => row.status)).toEqual(['failed', 'running']);
    expect(commands.length).toBe(commandCount);
  });

  it('reports a refused retry instead of accepting it silently, and still queues a retryable room job', async () => {
    expect(await facade.dispatch({ type: 'setWorkspace', requestId: 'retry-workspace', workspacePath: tmpdir() })).toMatchObject({ ok: true });
    const insert = async (status: string) => {
      const jobId = randomUUID();
      await pool.query(
        `INSERT INTO agent_jobs (job_id, account_id, chat_type, chat_id, provider, source_type, source_request_id, prompt, workspace_path, generation, creation_epoch, status)
         VALUES ($1,NULL,NULL,NULL,'codex','ui',$2,'p','C:\\work',0,NULL,$3)`, [jobId, `retry-src-${jobId}`, status]);
      return jobId;
    };
    const statusOf = async (jobId: string) => (await pool.query('SELECT status FROM agent_jobs WHERE job_id=$1', [jobId])).rows[0]?.status;
    const refused = { ok: false, code: 'AGENT_JOB_NOT_RETRYABLE', message: '此任務目前無法重試（可能已取消、已產生輸出，或所屬 Agent 會話已變更）。' };

    const cancelledId = await insert('cancelled');
    expect(await facade.dispatch({ type: 'retryAgentRoomJob', requestId: 'retry-cancelled', jobId: cancelledId })).toMatchObject(refused);
    expect(await statusOf(cancelledId)).toBe('cancelled');

    const outputId = await insert('failed');
    await pool.query("INSERT INTO agent_outputs (job_id, final_text) VALUES ($1,'done')", [outputId]);
    expect(await facade.dispatch({ type: 'retryAgentRoomJob', requestId: 'retry-output', jobId: outputId })).toMatchObject(refused);
    expect(await statusOf(outputId)).toBe('failed');

    // A LINE-scoped retry that the repository refuses is refused too (the job does not exist for that key).
    expect(await facade.dispatch({ type: 'retryJob', requestId: 'retry-line', accountId: 'no-such-account', chatType: 'group', chatId: 'no-chat', jobId: randomUUID() }))
      .toMatchObject(refused);

    const failedId = await insert('failed');
    expect(await facade.dispatch({ type: 'retryAgentRoomJob', requestId: 'retry-ok', jobId: failedId })).toMatchObject({ ok: true });
    // The worker may already have re-failed the requeued job, so status proves nothing. The queued transition
    // rewrites workspace_path from the current workspace, which a re-failure cannot undo.
    expect((await pool.query('SELECT workspace_path FROM agent_jobs WHERE job_id=$1', [failedId])).rows[0]?.workspace_path).not.toBe('C:\\work');
  });

  it('requires accepted native login readiness for manual send projection and admission', async () => {
    await addStoredAccounts('account-a');
    await activate('account-a');
    const binding = bindings.get('account-a')!;
    await pool.query("UPDATE line_accounts SET status='connected' WHERE account_id='account-a'");

    const beforeLogin = await facade.dispatch({ type: 'getSnapshot', requestId: 'snapshot-before-login' });
    expect(beforeLogin.type === 'getSnapshot' && beforeLogin.snapshot.accounts[0]?.canSendManually).toBe(false);
    expect(await facade.dispatch({ type: 'sendText', requestId: 'manual-before-login', accountId: 'account-a',
      chatType: 'direct', chatId: 'chat-a', text: 'must be gated' })).toMatchObject({ ok: false, code: 'LINE_SEND_NOT_STARTED' });
    expect(commands.some((command) => command.type === 'manualSendText' && command.requestId === 'manual-before-login')).toBe(false);

    const loginResult = await facade.dispatch({ type: 'lineLoginQr', requestId: 'qr-for-manual-ready', accountId: 'account-a' });
    expect(loginResult.ok).toBe(true);
    const current = bindings.get('account-a')!;
    const attempt = latestLoginAttempt('account-a');
    await workerEventHandler?.(current.workerInstanceId, { type: 'login', ...current, loginAttemptId: attempt,
      ownMid: 'own-account-a', displayName: 'Agent' });
    await workerEventHandler?.(current.workerInstanceId, { type: 'status', ...current, state: 'ready', message: null });

    const sent = await facade.dispatch({ type: 'sendText', requestId: 'manual-after-login', accountId: 'account-a',
      chatType: 'direct', chatId: 'chat-a', text: 'accepted native login' });
    expect(sent).toMatchObject({ ok: true });
    await waitForState(async () => expect((await pool.query("SELECT status FROM line_accounts WHERE account_id='account-a'")).rows[0]?.status).toBe('connected'));
    await waitForState(() => {
      const latest = [...published].reverse().find((event) => event.type === 'snapshotChanged');
      expect(latest?.type === 'snapshotChanged' && latest.snapshot.accounts.find((item) => item.accountId === 'account-a')?.canSendManually).toBe(true);
    }, { timeout: 4000, interval: 50 });
    const afterLogin = await facade.dispatch({ type: 'getSnapshot', requestId: 'snapshot-after-login' });
    expect(afterLogin.type).toBe('getSnapshot');

    await workerEventHandler?.(current.workerInstanceId, { type: 'status', ...current, state: 'connecting', message: null });
    expect(await facade.dispatch({ type: 'sendText', requestId: 'manual-after-disconnect', accountId: 'account-a',
      chatType: 'direct', chatId: 'chat-a', text: 'disconnected' })).toMatchObject({ ok: false, code: 'LINE_SEND_NOT_STARTED' });
    expect(commands.some((command) => command.type === 'manualSendText' && command.requestId === 'manual-after-disconnect')).toBe(false);
  });

  it('keeps Agent readiness and manual send admission after a retryable token refresh failure', async () => {
    await addStoredAccounts('account-a');
    const binding = await loginReady('account-a');
    await workerEventHandler?.(binding.workerInstanceId, { type: 'error', ...binding, code: 'WORKER_OPERATION_FAILED',
      message: 'LINE token refresh failed', retryable: true,
      diagnostic: { operation: 'loginToken', stage: 'execute', category: 'transport_failed', recovery: 'retry', outcome: 'failed' } });
    await workerEventHandler?.(binding.workerInstanceId, { type: 'status', ...binding, state: 'ready', message: null });

    expect(await facade.dispatch({ type: 'sendText', requestId: 'agent-send-after-refresh-failure', accountId: 'account-a',
      chatType: 'direct', chatId: 'chat-a', text: 'Agent remains available' })).toMatchObject({ ok: true });
    expect(commands.some((command) => command.type === 'manualSendText' && command.requestId === 'agent-send-after-refresh-failure')).toBe(true);
    expect(published).not.toContainEqual(expect.objectContaining({ type: 'lineLoginState', accountId: 'account-a', state: 'reauth_required' }));
    expect(auditEvents).toContainEqual(expect.objectContaining({ action: 'worker_operation_error', accountId: 'account-a',
      diagnostic: { operation: 'loginToken', stage: 'execute', category: 'transport_failed', recovery: 'retry', outcome: 'failed' } }));
  });

  it('allows a natively logged-in Primary Admin to send while remaining monitor-only', async () => {
    const { binding, attempt } = await prepareAdminQrLogin();
    await workerEventHandler?.(binding.workerInstanceId, { type: 'login', ...binding, loginAttemptId: attempt,
      ownMid: 'expected-admin-mid', displayName: 'Primary Admin' });
    await workerEventHandler?.(binding.workerInstanceId, { type: 'status', ...binding, state: 'ready', message: null });

    expect(await facade.dispatch({ type: 'sendText', requestId: 'admin-manual-send', accountId: 'account-b',
      chatType: 'direct', chatId: 'admin-chat-account-b', text: 'human reply' })).toMatchObject({ ok: true });
    expect(bindings.get('account-b')?.mode).toBe('MONITOR_ONLY');
    expect(await control()).toMatchObject({ activeAccountId: 'account-a' });
    expect(commands.some((command) => command.type === 'manualSendText' && command.requestId === 'admin-manual-send')).toBe(true);
    const media = await facade.dispatch({ type: 'sendManualMedia', requestId: 'admin-manual-media', accountId: 'account-b',
      chatType: 'direct', chatId: 'admin-chat-account-b', files: [{ name: 'note.txt', bytes: new Uint8Array([1, 2]) }] });
    expect(media).toMatchObject({ ok: true });
    expect(commands.some((command) => command.type === 'sendMedia' && command.manualSend === true && command.fileName === 'note.txt')).toBe(true);
  });

  it('bounds same-account media bursts and cancels an admitted send with staged-file cleanup', async () => {
    await addStoredAccounts('account-a');
    await loginReady('account-a');
    let started!: () => void;
    let release!: () => void;
    const entered = new Promise<void>((resolve) => { started = resolve; });
    const wait = new Promise<void>((resolve) => { release = resolve; });
    pendingManualMedia = { started: () => started(), wait, release: () => release() };
    const controller = new AbortController();
    const request = { type: 'sendManualMedia' as const, requestId: 'bounded-manual-media', accountId: 'account-a',
      chatType: 'direct' as const, chatId: 'media-chat', files: [{ name: 'note.txt', bytes: new Uint8Array([1, 2]) }] };
    const active = facade.dispatch(request, controller.signal);
    await entered;
    const filePath = commands.find((command) => command.type === 'sendMedia')?.filePath;
    expect(filePath).toBeDefined();
    expect(await facade.dispatch({ ...request, requestId: 'burst-manual-media' })).toMatchObject({ ok: false, code: 'LINE_MEDIA_BUSY' });
    expect(commands.filter((command) => command.type === 'sendMedia')).toHaveLength(1);

    controller.abort();
    expect(await active).toMatchObject({ ok: false, code: 'LINE_SEND_OUTCOME_UNKNOWN' });
    await expect(access(filePath!)).rejects.toThrow();
    expect(await facade.dispatch({ ...request, requestId: 'after-cancel-manual-media' })).toMatchObject({ ok: true });
  });

  it('keeps a rejected Primary Admin MID unable to send manually', async () => {
    const { binding, attempt } = await prepareAdminQrLogin();
    await workerEventHandler?.(binding.workerInstanceId, { type: 'login', ...binding, loginAttemptId: attempt,
      ownMid: 'wrong-admin-mid', displayName: 'Wrong Admin' });
    const result = await facade.dispatch({ type: 'sendText', requestId: 'wrong-mid-manual-send', accountId: 'account-b',
      chatType: 'direct', chatId: 'admin-chat-account-b', text: 'must be denied' });
    expect(result).toMatchObject({ ok: false });
    expect(commands.some((command) => command.type === 'manualSendText' && command.requestId === 'wrong-mid-manual-send')).toBe(false);
  });

  it('denies manual sends to the local Agent conversation before worker enqueue', async () => {
    await addStoredAccounts('account-a');
    await activate('account-a');
    expect(await facade.dispatch({ type: 'sendText', requestId: 'local-room-manual-send', accountId: 'account-a',
      chatType: 'direct', chatId: '__local_agent_room__', text: 'local only' })).toMatchObject({ ok: false, code: 'LINE_SEND_NOT_STARTED' });
    expect(commands.some((command) => command.type === 'manualSendText' && command.requestId === 'local-room-manual-send')).toBe(false);
  });

  it('serializes manual admission behind relogin and denies the fresh unready worker', async () => {
    await addStoredAccounts('account-a');
    await activate('account-a');
    const login = await facade.dispatch({ type: 'lineLoginQr', requestId: 'qr-for-held-send', accountId: 'account-a' });
    expect(login.ok).toBe(true);
    const binding = bindings.get('account-a')!;
    const attempt = latestLoginAttempt('account-a');
    await workerEventHandler?.(binding.workerInstanceId, { type: 'login', ...binding, loginAttemptId: attempt,
      ownMid: 'own-account-a', displayName: 'Agent' });
    await workerEventHandler?.(binding.workerInstanceId, { type: 'status', ...binding, state: 'ready', message: null });
    const oldWorker = binding.workerInstanceId;
    const relogin = facade.dispatch({ type: 'lineLoginQr', requestId: 'relogin-before-manual-send', accountId: 'account-a' });
    const outgoing = facade.dispatch({ type: 'sendText', requestId: 'manual-during-relogin', accountId: 'account-a',
      chatType: 'direct', chatId: 'chat-a', text: 'cancel while login is pending' });
    expect(await relogin).toMatchObject({ ok: true });
    expect(bindings.get('account-a')?.workerInstanceId).not.toBe(oldWorker);
    expect(await outgoing).toMatchObject({ ok: false, code: 'LINE_SEND_NOT_STARTED' });
    expect(commands.some((command) => command.type === 'manualSendText' && command.requestId === 'manual-during-relogin')).toBe(false);
  });

  it('returns the native send error once without retrying or reporting recipient delivery state', async () => {
    await addStoredAccounts('account-a');
    await activate('account-a');
    const login = await facade.dispatch({ type: 'lineLoginQr', requestId: 'qr-for-send-failure', accountId: 'account-a' });
    expect(login.ok).toBe(true);
    const binding = bindings.get('account-a')!;
    const attempt = latestLoginAttempt('account-a');
    await workerEventHandler?.(binding.workerInstanceId, { type: 'login', ...binding, loginAttemptId: attempt,
      ownMid: 'own-account-a', displayName: 'Agent' });
    await workerEventHandler?.(binding.workerInstanceId, { type: 'status', ...binding, state: 'ready', message: null });
    manualSendFailure = 'SIDE_EFFECT_DENIED';

    const result = await facade.dispatch({ type: 'sendText', requestId: 'single-failed-manual-send', accountId: 'account-a',
      chatType: 'direct', chatId: 'chat-a', text: 'send once' });
    expect(result).toMatchObject({ ok: false, code: 'LINE_SEND_NOT_STARTED', message: 'SIDE_EFFECT_DENIED' });
    expect(commands.filter((command) => command.type === 'manualSendText' && command.requestId === 'single-failed-manual-send')).toHaveLength(1);

    manualSendFailure = 'LINE_TALK_E2EE_RETRY_ENCRYPT';
    expect(await facade.dispatch({ type: 'sendText', requestId: 'talk-rejected-send', accountId: 'account-a',
      chatType: 'direct', chatId: 'chat-a', text: 'send once' })).toMatchObject({ ok: false,
      code: 'LINE_SEND_NOT_STARTED', serverErrorCode: 'LINE_TALK_E2EE_RETRY_ENCRYPT', message: 'LINE message was not sent.' });
    expect(commands.filter((command) => command.type === 'manualSendText' && command.requestId === 'talk-rejected-send')).toHaveLength(1);

    const privateServerText = 'token=private MID=u12345678901234567890123456789012 text=private';
    manualSendFailure = privateServerText;
    expect(await facade.dispatch({ type: 'sendText', requestId: 'poisoned-send', accountId: 'account-a',
      chatType: 'direct', chatId: 'chat-a', text: 'send once' })).toMatchObject({ ok: false,
      code: 'LINE_SEND_NOT_STARTED', message: 'LINE message was not sent.' });
    expect(commands.filter((command) => command.type === 'manualSendText' && command.requestId === 'poisoned-send')).toHaveLength(1);
    await audit.flush();
    expect(JSON.stringify(auditEvents)).not.toContain(privateServerText);
  });

  it('reconciles a confirmed unsend into the exact older timeline row and refuses other senders', async () => {
    await addStoredAccounts('unsend-facade-account');
    const binding = await loginReady('unsend-facade-account');
    const olderAt = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    await seedManualUnsendMessage(binding, 'unsend-owned-older', `own-${binding.accountId}`, olderAt);
    await seedManualUnsendMessage(binding, 'unsend-other-older', 'other-person', olderAt);
    const key = { accountId: binding.accountId, chatType: 'direct' as const, chatId: 'unsend-chat' };

    const rejected = await facade.dispatch({ type: 'unsendMessage', requestId: 'unsend-other', ...key, messageId: 'unsend-other-older' });
    expect(rejected).toMatchObject({ ok: false, code: 'MESSAGE_NOT_ELIGIBLE' });
    expect(commands.some((command) => command.type === 'unsendMessage' && command.requestId === 'unsend-other')).toBe(false);

    const acceptedResult = await facade.dispatch({ type: 'unsendMessage', requestId: 'unsend-owned', ...key, messageId: 'unsend-owned-older' });
    expect(acceptedResult, JSON.stringify(acceptedResult)).toMatchObject({ ok: true });
    expect(commands.filter((command) => command.type === 'unsendMessage' && command.requestId === 'unsend-owned')).toHaveLength(1);
    const projected = await facade.listMessages(key, null, 1, 'unsend-owned-older');
    expect(projected.messages).toHaveLength(1);
    expect(projected.messages[0]).toMatchObject({ messageId: 'unsend-owned-older', content: { type: 'unsent' }, text: 'source unsend-owned-older' });
  });

  it('does not write DB unsend state after a failed or unknown worker result, and denies a fenced binding', async () => {
    await addStoredAccounts('unsend-failure-account');
    const binding = await loginReady('unsend-failure-account');
    const occurredAt = new Date().toISOString();
    await seedManualUnsendMessage(binding, 'unsend-failure-row', `own-${binding.accountId}`, occurredAt);
    const request = { type: 'unsendMessage' as const, requestId: 'unsend-failure', accountId: binding.accountId,
      chatType: 'direct' as const, chatId: 'unsend-chat', messageId: 'unsend-failure-row' };
    const before = await facade.listMessages(request, null, 1, request.messageId);

    manualUnsendFailure = 'SIDE_EFFECT_DENIED';
    expect(await facade.dispatch(request)).toMatchObject({ ok: false, code: 'LINE_UNSEND_NOT_STARTED' });
    expect(await facade.listMessages(request, null, 1, request.messageId)).toEqual(before);
    manualUnsendFailure = 'LINE_TALK_NOT_YOUR_MESSAGE';
    expect(await facade.dispatch({ ...request, requestId: 'unsend-talk-rejection' })).toMatchObject({ ok: false,
      code: 'LINE_UNSEND_NOT_STARTED', serverErrorCode: 'LINE_TALK_NOT_YOUR_MESSAGE', message: 'LINE message was not unsent.' });
    expect(await facade.listMessages(request, null, 1, request.messageId)).toEqual(before);
    manualUnsendFailure = '__UNKNOWN__';
    expect(await facade.dispatch({ ...request, requestId: 'unsend-unknown' })).toMatchObject({ ok: false, code: 'LINE_UNSEND_OUTCOME_UNKNOWN' });
    expect(await facade.listMessages(request, null, 1, request.messageId)).toEqual(before);

    manualUnsendFenced = true;
    expect(await facade.dispatch({ ...request, requestId: 'unsend-fenced' })).toMatchObject({ ok: false, code: 'ACCOUNT_NOT_ACTIVE' });
    expect(commands.some((command) => command.type === 'unsendMessage' && command.requestId === 'unsend-fenced')).toBe(false);
    expect(await facade.listMessages(request, null, 1, request.messageId)).toEqual(before);
  });

  it('preserves an unknown worker send outcome as uncertain without retrying', async () => {
    await addStoredAccounts('account-a');
    await activate('account-a');
    await facade.dispatch({ type: 'lineLoginQr', requestId: 'qr-for-send-unknown', accountId: 'account-a' });
    const binding = bindings.get('account-a')!;
    const attempt = latestLoginAttempt('account-a');
    await workerEventHandler?.(binding.workerInstanceId, { type: 'login', ...binding, loginAttemptId: attempt,
      ownMid: 'own-account-a', displayName: 'Agent' });
    await workerEventHandler?.(binding.workerInstanceId, { type: 'status', ...binding, state: 'ready', message: null });
    manualSendFailure = '__UNKNOWN__';

    const result = await facade.dispatch({ type: 'sendText', requestId: 'single-unknown-manual-send', accountId: 'account-a',
      chatType: 'direct', chatId: 'chat-a', text: 'unknown once' });
    expect(result).toMatchObject({ ok: false, code: 'LINE_SEND_OUTCOME_UNKNOWN' });
    expect(commands.filter((command) => command.type === 'manualSendText' && command.requestId === 'single-unknown-manual-send')).toHaveLength(1);
  });

  it('rejects old live enrollment ingress before pairing hooks once EXTERNAL_MONITOR is selected', async () => {
    const accountId = 'external-ingress-account';
    const agentAccountId = 'external-ingress-agent-account';
    await addStoredAccounts(agentAccountId, accountId);
    await pool.query("UPDATE line_accounts SET product_role=NULL WHERE account_id=$1", [agentAccountId]);
    await pool.query("UPDATE line_accounts SET product_role='AGENT' WHERE account_id=$1", [accountId]);
    await new AdminRepository(pool).bindPrimary(accountId, 'admin-direct', 'admin-user');
    await activate(accountId);
    const binding = bindings.get(accountId)!;
    const sendBatch = (batchId: string, messageId: string, text: string, kind: 'text' | 'contact' = 'text') =>
      workerEventHandler?.(binding.workerInstanceId, { type: 'batch', ...binding, batchId,
        cursorBefore: { version: 1, revision: '0', globalRev: '0', individualRev: '0' },
        cursorAfter: { version: 1, revision: '1', globalRev: '1', individualRev: '0' }, envelopes: [{
          eventId: `${messageId}-event`, messageId, accountId, chatType: 'direct', chatId: 'admin-direct',
          senderId: 'admin-user', kind, text: kind === 'text' ? text : null, contact: kind === 'contact'
            ? { mid: `u${'a'.repeat(32)}`, displayName: 'Target' } : undefined,
          mentionIds: [], mentionRanges: [], replyToMessageId: null, ingestion: { source: 'live', cursor: null },
          occurredAt: new Date().toISOString(), attachments: [], raw: {},
        }] });

    await pool.query("UPDATE line_accounts SET product_role=NULL WHERE account_id=$1", [accountId]);
    await pool.query("UPDATE line_accounts SET product_role='AGENT' WHERE account_id=$1", [agentAccountId]);
    await pool.query("UPDATE line_accounts SET product_role='PRIMARY_ADMIN' WHERE account_id=$1", [accountId]);
    await new ExternalMonitorRepository(pool).bindVerifiedExternalSource({ accountId,
      ownMid: `own-${accountId}`, sourceIdentity: 'sanitized-source-profile' });
    const sendCountBeforeExternalIngress = commands.length;

    await sendBatch('external-adduser', 'adduser-after-switch', '/adduser');
    await sendBatch('external-contact', 'contact-after-switch', '', 'contact');

    expect(commands).toHaveLength(sendCountBeforeExternalIngress);
    expect(friendRemoteCalls).toBe(0);
    expect((await pool.query('SELECT count(*) FROM line_friend_whitelist_grants WHERE account_id=$1', [accountId])).rows[0]?.count).toBe('0');
    expect((await pool.query('SELECT count(*) FROM messages WHERE account_id=$1', [accountId])).rows[0]?.count).toBe('0');
    expect(commands.some((command) => command.type === 'ackBatch' && command.batchId.startsWith('external-'))).toBe(false);
  });

  it('publishes a new admin pairing and attempts one welcome send without holding batch ACK', async () => {
    const accountId = 'pairing-feedback-account';
    await addStoredAccounts(accountId);
    await pool.query('UPDATE line_accounts SET own_mid=$2 WHERE account_id=$1', [accountId, `own-${accountId}`]);
    expect((await new AccountRepository(pool).activateControl(accountId, 1)).activated).toBe(true);
    expect((await facade.dispatch({ type: 'lineStart', requestId: 'pairing-feedback-start', accountId })).ok).toBe(true);
    await signalLoggedInReady(accountId, `own-${accountId}`, true);
    const binding = bindings.get(accountId)!;
    const challenge = await facade.dispatch({ type: 'lineBeginAdminPairing', requestId: 'pairing-feedback-begin', accountId });
    expect(challenge.type).toBe('lineAdminPairing');
    if (challenge.type !== 'lineAdminPairing') throw new Error('Pairing challenge was not created');
    let release!: () => void;
    let entered!: () => void;
    const pending = new Promise<void>((resolve) => { release = resolve; });
    const sendStarted = new Promise<void>((resolve) => { entered = resolve; });
    pendingWelcomeSend = { started: entered, wait: pending };
    const envelope = { eventId: 'pairing-feedback-event', messageId: 'pairing-feedback-message', accountId,
      chatType: 'direct' as const, chatId: pairedAdminMid, senderId: pairedAdminMid, kind: 'text' as const,
      text: challenge.token, mentionIds: [], mentionRanges: [], replyToMessageId: null,
      ingestion: { source: 'live' as const, cursor: null }, occurredAt: new Date().toISOString(), attachments: [], raw: {} };
    await workerEventHandler?.(binding.workerInstanceId, { type: 'batch', ...binding, batchId: 'pairing-feedback-batch',
      cursorBefore: { version: 1, revision: '0', globalRev: '0', individualRev: '0' },
      cursorAfter: { version: 1, revision: '1', globalRev: '1', individualRev: '0' }, envelopes: [envelope] });
    await sendStarted;
    expect(commands.filter((command) => command.type === 'sendText'
      && command.text === 'Welcome as the primary administrator.' && command.chatId === pairedAdminMid)).toHaveLength(1);
    expect(commands.some((command) => command.type === 'ackBatch' && command.batchId === 'pairing-feedback-batch')).toBe(true);
    await waitForState(() => expect(published.some((event) => event.type === 'snapshotChanged'
      && event.snapshot.accounts.some((item) => item.accountId === accountId && item.hasPrimaryAdmin === true))).toBe(true));
    expect((await pool.query("SELECT own_mid,connection_mode FROM line_accounts WHERE product_role='PRIMARY_ADMIN'")).rows)
      .toEqual([{ own_mid: pairedAdminMid, connection_mode: 'OFFLINE' }]);
    release();
    pendingWelcomeSend = null;
  });

  it.each([
    ['throw', '[admin-pairing] welcome send failed'],
    ['failed', '[admin-pairing] welcome send did not report sent'],
    ['unknown', '[admin-pairing] welcome send did not report sent'],
  ] as const)('keeps a new admin binding after welcome send outcome %s, ACKs, logs, and never retries', async (outcome, warningText) => {
    const accountId = `pairing-outcome-${outcome}`;
    const { binding, token } = await prepareAdminPairing(accountId);
    welcomeSendOutcome = outcome;
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      await deliverPairing(accountId, binding, token, `pairing-outcome-batch-${outcome}`);
      await waitForState(() => expect(warning).toHaveBeenCalledWith(warningText));
      expect(commands.filter((command) => command.type === 'sendText' && command.text === 'Welcome as the primary administrator.'
        && command.chatId === pairedAdminMid)).toHaveLength(1);
      expect(commands.filter((command) => command.type === 'ackBatch' && command.batchId === `pairing-outcome-batch-${outcome}`)).toHaveLength(1);
      expect(await new AdminRepository(pool).hasPrimary(accountId)).toBe(true);
      await new Promise((resolve) => setTimeout(resolve, 25));
      expect(commands.filter((command) => command.type === 'sendText' && command.text === 'Welcome as the primary administrator.'
        && command.chatId === pairedAdminMid)).toHaveLength(1);
    } finally { warning.mockRestore(); }
  });

  it('skips welcome admission when the worker stops after the pairing is persisted', async () => {
    const accountId = 'pairing-stopped-before-admission';
    const { binding, token } = await prepareAdminPairing(accountId);
    const bindPrimary = AccountRepository.prototype.bindPrimaryAdministrator;
    const persisted = vi.spyOn(AccountRepository.prototype, 'bindPrimaryAdministrator').mockImplementation(async function (this: AccountRepository, ...args) {
      const result = await bindPrimary.apply(this, args);
      bindings.delete(accountId);
      return result;
    });
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      await deliverPairing(accountId, binding, token, 'pairing-stopped-batch');
      await waitForState(() => expect(warning).toHaveBeenCalledWith('[admin-pairing] welcome send skipped: binding unavailable'));
      expect(commands.some((command) => command.type === 'sendText' && command.text === 'Welcome as the primary administrator.')).toBe(false);
      expect(commands.some((command) => command.type === 'ackBatch' && command.batchId === 'pairing-stopped-batch')).toBe(true);
      expect(await new AdminRepository(pool).hasPrimary(accountId)).toBe(true);
    } finally { warning.mockRestore(); persisted.mockRestore(); }
  });

  it('waits for the pending welcome send to settle through worker shutdown', async () => {
    const accountId = 'pairing-pending-shutdown';
    const { binding, token } = await prepareAdminPairing(accountId);
    let release!: () => void;
    let entered!: () => void;
    let shutdownEntered!: () => void;
    const wait = new Promise<void>((resolve) => { release = resolve; });
    const started = new Promise<void>((resolve) => { entered = resolve; });
    const workerShutdown = new Promise<void>((resolve) => { shutdownEntered = resolve; });
    pendingWelcomeSend = { started: entered, wait, release: shutdownEntered };
    await deliverPairing(accountId, binding, token, 'pairing-shutdown-batch');
    await started;
    expect(commands.some((command) => command.type === 'ackBatch' && command.batchId === 'pairing-shutdown-batch')).toBe(true);
    let shutdownSettled = false;
    const shutdown = facade.shutdown().then(() => { shutdownSettled = true; });
    try {
      await workerShutdown;
      await new Promise((resolve) => setImmediate(resolve));
      expect(shutdownSettled).toBe(false);
    } finally { release(); }
    await shutdown;
    expect(commands.filter((command) => command.type === 'sendText' && command.text === 'Welcome as the primary administrator.')).toHaveLength(1);
    expect(await new AdminRepository(pool).hasPrimary(accountId)).toBe(true);
    pendingWelcomeSend = null;
  });

  it('activates room controls and deterministic replies while withholding Agent admission without a room grant', async () => {
    await addStoredAccounts('account-a');
    const ownMid = 'agent-mid';
    await pool.query("UPDATE line_accounts SET own_mid=$2 WHERE account_id=$1", ['account-a', ownMid]);
    await new AdminRepository(pool).bindPrimary('account-a', 'admin-direct', 'admin-user');
    await pool.query("INSERT INTO conversations(account_id,chat_type,chat_id,agent_enabled) VALUES ('account-a','group','disabled-room',true)");
    await activate('account-a');
    const binding = bindings.get('account-a')!;
    const makeEnvelope = (messageId: string, body: string) => {
      const text = `@Agent ${body}`;
      return { accountId: 'account-a', eventId: `${messageId}-event`, messageId, chatId: 'disabled-room',
        chatType: 'group' as const, senderId: 'member', kind: 'text' as const, text, replyToMessageId: null,
        mentionIds: [ownMid], mentionRanges: [{ start: 0, end: 6, userId: ownMid }],
        ingestion: { source: 'live' as const, cursor: null }, occurredAt: new Date().toISOString(), attachments: [], raw: {} };
    };
    await workerEventHandler?.(binding.workerInstanceId, { type: 'batch', ...binding, batchId: 'disabled-room-batch',
      cursorBefore: { version: 1, revision: '0', globalRev: '0', individualRev: '0' },
      cursorAfter: { version: 1, revision: '1', globalRev: '1', individualRev: '0' },
      envelopes: [makeEnvelope('disabled-monitor', 'monitor'), makeEnvelope('disabled-reply', 'anything')] });
    await waitForState(() => expect(commands.filter((command) => command.type === 'sendText')).toHaveLength(3));
    await facade.shutdown();

    expect((await pool.query("SELECT count(*) FROM room_activation_requests WHERE account_id='account-a'")).rows[0].count).toBe('1');
    expect((await pool.query("SELECT count(*) FROM agent_jobs WHERE account_id='account-a' AND chat_type='group'")).rows[0].count).toBe('0');
    const sends = commands.filter((command) => command.type === 'sendText');
    const adminTokenSend = sends.find((command) => command.chatType === 'direct' && command.chatId === 'admin-direct');
    expect(adminTokenSend?.type === 'sendText' ? adminTokenSend.text : '').toMatch(/RA-[A-Za-z0-9_-]{43}/);
    expect(sends.some((command) => command.type === 'sendText' && command.chatType === 'group'
      && command.chatId === 'disabled-room' && command.text === '我不知道你在說甚麼')).toBe(true);
    expect(commands.some((command) => command.type === 'ackBatch' && command.batchId === 'disabled-room-batch')).toBe(true);
    expect((await pool.query("SELECT count(*) FROM messages WHERE account_id='account-a' AND chat_id='disabled-room'")).rows[0].count).toBe('2');
  });

  it('permanently closes dispatch and waits for admitted login before releasing shutdown', async () => {
    let release!:()=>void;const gate=new Promise<void>(resolve=>{release=resolve;});let entered!:()=>void;
    const ready=new Promise<void>(resolve=>{entered=resolve;});
    agent.openLogin=async()=>{entered();await gate;return {ok:true};};
    const login=facade.dispatch({type:'agentLogin',requestId:'paused-login',provider:'codex'});await ready;
    let done=false;const shutdown=facade.shutdown().then(()=>{done=true;});
    await new Promise(resolve=>setTimeout(resolve,10));
    const completedBeforeRelease=done;
    const late=await facade.dispatch({type:'setWorkspace',requestId:'late-setting',workspacePath:tmpdir()});
    release();await Promise.all([login,shutdown]);
    expect(late).toMatchObject({ok:false,code:'SERVICE_CLOSING'});
    expect(completedBeforeRelease).toBe(false);
    expect((await pool.query("SELECT value FROM app_settings WHERE key='workspace_path'")).rows[0].value).toBe('Z:\\missing-workspace-recovery');
    expect(done).toBe(true);
    expect(await facade.dispatch({type:'getSnapshot',requestId:'after-close'})).toMatchObject({ok:false,code:'SERVICE_CLOSING'});
  });

  it('refreshes provider status without invoking login or logout and publishes the result', async () => {
    const agentRefreshStatus = vi.fn(async () => ({ status: 'authenticated' as const }));
    const getAuthStatus = vi.fn(async () => ({ status: 'logged_out' as const }));
    const openLogin = vi.fn(async () => ({ ok: true }));
    const logout = vi.fn(async () => ({ ok: true }));
    agent.agentRefreshStatus = agentRefreshStatus;
    agent.getAuthStatus = getAuthStatus;
    agent.openLogin = openLogin;
    agent.logout = logout;

    const result = await facade.dispatch({type:'agentRefreshStatus',requestId:'refresh-auth',provider:'codex'});

    expect(result).toMatchObject({type:'accepted',ok:true});
    expect(agentRefreshStatus).toHaveBeenCalledExactlyOnceWith('codex');
    expect(getAuthStatus).not.toHaveBeenCalled();
    expect(openLogin).not.toHaveBeenCalled();
    expect(logout).not.toHaveBeenCalled();
    expect(published).toContainEqual(expect.objectContaining({type:'snapshotChanged',snapshot:expect.objectContaining({
      providers:expect.arrayContaining([expect.objectContaining({provider:'codex',status:'logged_in'})]),
    })}));
  });

  it('audits user Agent OAuth actions, worker stop, and LINE token clearing with correlated outcomes', async () => {
    await addStoredAccounts('audit-account');
    await activate('audit-account');
    await facade.dispatch({ type: 'agentLogin', requestId: 'audit-agent-login', provider: 'codex' });
    await facade.dispatch({ type: 'agentLogout', requestId: 'audit-agent-logout', provider: 'codex' });
    const result = await facade.dispatch({ type: 'lineLogout', requestId: 'audit-line-logout', accountId: 'audit-account' });
    await audit.flush();

    expect(result.ok).toBe(true);
    for (const [action, requestId] of [['agent_codex_login', 'audit-agent-login'], ['agent_codex_logout', 'audit-agent-logout'],
      ['secret_clear', 'audit-line-logout']] as const) {
      expect(auditEvents.filter((event) => event.action === action).map((event) => [event.phase, event.correlationId])).toEqual([
        ['requested', requestId], ['succeeded', requestId],
      ]);
    }
    expect(auditEvents.some((event) => event.action === 'worker_stop' && event.phase === 'requested'
      && event.accountId === 'audit-account' && event.workerInstanceId)).toBe(true);
    expect(JSON.stringify(auditEvents)).not.toMatch(/password|token|oauth/i);
  });

  it('keeps the worker, secrets, and connected state when server logout fails', async () => {
    await addStoredAccounts('logout-failure-account');
    await loginReady('logout-failure-account');
    lineLogoutFailure = true;
    stops.length = 0;
    const before = await pool.query<{ status: string }>("SELECT status FROM line_accounts WHERE account_id='logout-failure-account'");
    const admissionClose = vi.spyOn(ChatResourceAccountAdmission.prototype, 'close');

    try {
      const result = await facade.dispatch({ type: 'lineLogout', requestId: 'logout-failure', accountId: 'logout-failure-account' });

      expect(result).toMatchObject({ ok: false, code: 'LINE_LOGOUT_FAILED' });
      expect(stops).toEqual([]);
      expect(await secretStore.load('logout-failure-account')).not.toBeNull();
      expect((await pool.query<{ status: string }>("SELECT status FROM line_accounts WHERE account_id='logout-failure-account'")).rows[0]?.status)
        .toBe(before.rows[0]?.status);
      expect(admissionClose.mock.calls.some(([accountId]) => accountId === 'logout-failure-account')).toBe(false);
    } finally { admissionClose.mockRestore(); }
  });

  it('cancels a pending QR login of an account with an own MID without a server logout', async () => {
    await addStoredAccounts('cancel-pending-account');
    await activate('cancel-pending-account');
    expect((await facade.dispatch({ type: 'lineLoginQr', requestId: 'qr-cancel-pending', accountId: 'cancel-pending-account' })).ok).toBe(true);
    const attempt = latestLoginAttempt('cancel-pending-account');
    const closeLogin = vi.spyOn(secretStore, 'closeLogin');
    commands.length = 0;
    published = [];

    try {
      const result = await facade.dispatch({ type: 'lineLogout', requestId: 'cancel-pending', accountId: 'cancel-pending-account' });

      expect(result).toMatchObject({ type: 'accepted', ok: true });
      expect(commands.filter((command) => command.type === 'logout')).toEqual([]);
      expect(closeLogin.mock.calls.some(([accountId, , attemptId]) => accountId === 'cancel-pending-account' && attemptId === attempt)).toBe(true);
      expect(published).toContainEqual(expect.objectContaining({ type: 'lineLoginState', accountId: 'cancel-pending-account', state: 'disconnected' }));
    } finally { closeLogin.mockRestore(); }
  });

  it('sends the logout command for a connected account and fails when the worker rejects it', async () => {
    await addStoredAccounts('connected-logout-account');
    await loginReady('connected-logout-account');
    lineLogoutFailure = true;
    commands.length = 0;

    const result = await facade.dispatch({ type: 'lineLogout', requestId: 'connected-logout-failure', accountId: 'connected-logout-account' });

    expect(commands.filter((command) => command.type === 'logout')).toHaveLength(1);
    expect(result).toMatchObject({ ok: false, code: 'LINE_LOGOUT_FAILED' });
  });

  it('starts with an invalid saved workspace and repairs it live with stable validation errors', async () => {
    expect((await facade.dispatch({ type: 'getSnapshot', requestId: 'snapshot' })).ok).toBe(true);
    const invalid = await facade.dispatch({ type: 'setWorkspace', requestId: 'invalid', workspacePath: 'relative' });
    expect(invalid).toMatchObject({ ok: false, code: 'INVALID_WORKSPACE' });
    expect((await pool.query("SELECT value FROM app_settings WHERE key='workspace_path'")).rows[0].value).toBe('Z:\\missing-workspace-recovery');
    expect((await facade.dispatch({ type: 'setWorkspace', requestId: 'valid', workspacePath: tmpdir() })).ok).toBe(true);
    expect((await pool.query("SELECT value FROM app_settings WHERE key='workspace_path'")).rows[0].value).toBe(await realpath(tmpdir()));
  });

  it('reserves the Primary Admin slot in monitor mode while the Agent keeps control', async () => {
    await addStoredAccounts('account-a');
    await activate('account-a');
    const before = await control();

    const result = await facade.dispatch({ type: 'lineAddAccountQr', requestId: 'add-account' });

    expect(result.ok).toBe(true);
    const added = (await pool.query<{ account_id: string; mode: string }>(
      "SELECT account_id,mode FROM line_accounts WHERE account_id <> 'account-a' ORDER BY created_at DESC LIMIT 1")).rows[0];
    expect(added?.mode).toBe('MONITOR_ONLY');
    expect(await control()).toMatchObject({ activeAccountId: 'account-a', epoch: before.epoch });
    expect(commands.some((command) => command.type === 'revokeControl')).toBe(false);
    expect(starts).toContainEqual(expect.objectContaining({ accountId: added?.account_id, mode: 'MONITOR_ONLY' }));
  });

  it('starts QR relogin for a non-control account while preserving both account workers', async () => {
    await addStoredAccounts('account-a', 'account-b');
    await facade.dispatch({ type: 'lineStart', requestId: 'start-b', accountId: 'account-b' });
    await activate('account-a');
    const before = await control();
    const aBinding = bindings.get('account-a');
    const bBinding = bindings.get('account-b');

    const result = await facade.dispatch({ type: 'lineLoginQr', requestId: 'relogin-b', accountId: 'account-b' });

    expect(result.ok).toBe(true);
    expect(await control()).toMatchObject({ activeAccountId: 'account-a', epoch: before.epoch });
    expect(bindings.get('account-a')).toEqual(aBinding);
    expect(bindings.get('account-b')?.workerInstanceId).not.toBe(bBinding?.workerInstanceId);
    expect(bindings.get('account-b')?.mode).toBe('MONITOR_ONLY');
    expect(stops).toEqual(['account-b']);
    expect(commands.some((command) => command.type === 'revokeControl')).toBe(false);
  });

  it('rejects a Primary Admin QR MID that differs from the Agent binding before saving credentials', async () => {
    const { binding, attempt } = await prepareAdminQrLogin();
    const saveRotation = vi.spyOn(secretStore, 'saveRotation');
    await workerEventHandler?.(binding.workerInstanceId, { type: 'secretRotation', ...binding, loginAttemptId: attempt,
      secrets: { token: 'wrong-admin-token', qrCert: null, e2eeStorage: null } });
    await workerEventHandler?.(binding.workerInstanceId, { type: 'login', ...binding, loginAttemptId: attempt,
      ownMid: 'wrong-admin-mid', displayName: 'Wrong Admin' });

    expect(saveRotation).not.toHaveBeenCalled();
    expect((await pool.query("SELECT own_mid FROM line_accounts WHERE account_id='account-b'")).rows[0].own_mid).toBe('expected-admin-mid');
    expect((await secretStore.load('account-b'))?.token).toBe('previous-admin-token');
    expect(stoppedWorkerInstances).toContain(binding.workerInstanceId);
    expect(published).toContainEqual(expect.objectContaining({ type: 'lineLoginState', accountId: 'account-b',
      loginAttemptId: attempt, state: 'degraded', message: expect.stringContaining('MID does not match') }));
    expect(bindings.has('account-b')).toBe(false);
  });

  it('rejects a Primary Admin MID when the Agent binding changes during QR login', async () => {
    const { binding, attempt } = await prepareAdminQrLogin();
    const saveRotation = vi.spyOn(secretStore, 'saveRotation');
    await pool.query("UPDATE account_administrators SET user_id='changed-admin-mid' WHERE account_id='account-a'");
    await workerEventHandler?.(binding.workerInstanceId, { type: 'secretRotation', ...binding, loginAttemptId: attempt,
      secrets: { token: 'stale-binding-token', qrCert: null, e2eeStorage: null } });
    await workerEventHandler?.(binding.workerInstanceId, { type: 'login', ...binding, loginAttemptId: attempt,
      ownMid: 'expected-admin-mid', displayName: 'Expected Admin' });

    expect(saveRotation).not.toHaveBeenCalled();
    expect((await pool.query("SELECT own_mid FROM line_accounts WHERE account_id='account-b'")).rows[0].own_mid).toBe('expected-admin-mid');
    expect((await secretStore.load('account-b'))?.token).toBe('previous-admin-token');
    expect(stoppedWorkerInstances).toContain(binding.workerInstanceId);
    expect(published).toContainEqual(expect.objectContaining({ type: 'lineLoginState', accountId: 'account-b',
      loginAttemptId: attempt, state: 'degraded', message: expect.stringContaining('MID does not match') }));
    expect(bindings.has('account-b')).toBe(false);
  });

  it('persists a matching Primary Admin QR identity and pending secret on the current binding', async () => {
    const { binding, attempt } = await prepareAdminQrLogin();
    await pool.query("UPDATE line_accounts SET own_mid=NULL WHERE account_id='account-b'");
    const saveRotation = vi.spyOn(secretStore, 'saveRotation');
    await workerEventHandler?.(binding.workerInstanceId, { type: 'secretRotation', ...binding, loginAttemptId: attempt,
      secrets: { token: 'matching-admin-token', qrCert: null, e2eeStorage: null } });
    await workerEventHandler?.(binding.workerInstanceId, { type: 'login', ...binding, loginAttemptId: attempt,
      ownMid: 'expected-admin-mid', displayName: 'Expected Admin' });

    expect(saveRotation).toHaveBeenCalledWith('account-b', binding.workerInstanceId, attempt,
      { token: 'matching-admin-token', qrCert: null, e2eeStorage: null });
    expect((await pool.query("SELECT own_mid,status FROM line_accounts WHERE account_id='account-b'")).rows[0])
      .toEqual({ own_mid: 'expected-admin-mid', status: 'connected' });
    expect((await secretStore.load('account-b'))?.token).toBe('matching-admin-token');
    expect(bindings.get('account-b')?.workerInstanceId).toBe(binding.workerInstanceId);
    expect(stoppedWorkerInstances).not.toContain(binding.workerInstanceId);
  });

  it('does not persist Admin identity when saving a matching QR secret fails', async () => {
    const { binding, attempt } = await prepareAdminQrLogin();
    await pool.query("UPDATE line_accounts SET own_mid=NULL WHERE account_id='account-b'");
    const saveRotation = vi.spyOn(secretStore, 'saveRotation').mockResolvedValue(false);
    try {
      await workerEventHandler?.(binding.workerInstanceId, { type: 'secretRotation', ...binding, loginAttemptId: attempt,
        secrets: { token: 'unsaved-admin-token', qrCert: null, e2eeStorage: null } });
      await workerEventHandler?.(binding.workerInstanceId, { type: 'login', ...binding, loginAttemptId: attempt,
        ownMid: 'expected-admin-mid', displayName: 'Expected Admin' });
      expect(saveRotation).toHaveBeenCalledWith('account-b', binding.workerInstanceId, attempt,
        { token: 'unsaved-admin-token', qrCert: null, e2eeStorage: null });
    } finally { saveRotation.mockRestore(); }

    expect((await pool.query("SELECT own_mid FROM line_accounts WHERE account_id='account-b'")).rows[0].own_mid).toBeNull();
    expect((await secretStore.load('account-b'))?.token).toBe('previous-admin-token');
    expect(stoppedWorkerInstances).toContain(binding.workerInstanceId);
    expect(published).toContainEqual(expect.objectContaining({ type: 'lineLoginState', accountId: 'account-b',
      loginAttemptId: attempt, state: 'degraded', message: expect.stringContaining('MID does not match') }));
    expect(bindings.has('account-b')).toBe(false);
  });

  it('continues persisting inbound messages from the monitor-only Primary Admin worker', async () => {
    await addStoredAccounts('account-a', 'account-b');
    await facade.dispatch({ type: 'lineStart', requestId: 'start-monitor', accountId: 'account-b' });
    const binding = bindings.get('account-b')!;

    await workerEventHandler?.(binding.workerInstanceId, { type: 'batch', accountId: binding.accountId,
      workerInstanceId: binding.workerInstanceId, controlEpoch: binding.controlEpoch, batchId: 'monitor-batch',
      cursorBefore: { version: 1, revision: '0', globalRev: '0', individualRev: '0' },
      cursorAfter: { version: 1, revision: '1', globalRev: '1', individualRev: '0' }, envelopes: [{
        eventId: 'monitor-event', accountId: binding.accountId, chatType: 'direct', chatId: 'contact-mid',
        senderId: 'contact-mid', messageId: 'monitor-message', kind: 'text', text: 'saved while monitoring',
        mentionIds: [], mentionRanges: [], replyToMessageId: null,
        ingestion: { source: 'live', cursor: null }, occurredAt: '2026-10-16T00:00:00.000Z', attachments: [], raw: {},
      }] });
    const rows = await pool.query<{ text_content: string | null }>("SELECT text_content FROM messages WHERE account_id='account-b' AND message_id='monitor-message'");
    expect(rows.rows).toEqual([{ text_content: 'saved while monitoring' }]);
    const key = { accountId: binding.accountId, chatType: 'direct' as const, chatId: 'contact-mid' };
    const beforeUnsend = await facade.listMessages(key, null, 1, 'monitor-message');
    const unsend = await facade.dispatch({ type: 'unsendMessage', requestId: 'monitor-unsend', ...key, messageId: 'monitor-message' });
    expect(unsend).toMatchObject({ ok: false, code: 'EXTERNAL_MONITOR_READ_ONLY' });
    expect(commands.some((command) => command.type === 'unsendMessage' && command.requestId === 'monitor-unsend')).toBe(false);
    expect(await facade.listMessages(key, null, 1, 'monitor-message')).toEqual(beforeUnsend);
    expect(commands.some((command) => command.type === 'ackBatch' && command.batchId === 'monitor-batch')).toBe(true);
    expect(await control()).toMatchObject({ activeAccountId: null });
  });

  it('denies unsend from an external-monitor-only account before worker RPC or database mutation', async () => {
    await addStoredAccounts('external-unsend-agent');
    const monitor = await new AccountRepository(pool).bindPrimaryAdminFromExternalMonitor({
      mid: 'u11111111111111111111111111111111', correlationId: 'external-unsend-test' });
    expect(monitor.ok).toBe(true);
    if (!monitor.ok) throw new Error('External monitor account was not created');
    const accountId = monitor.accountId;
    const chatId = 'external-unsend-chat';
    await pool.query('INSERT INTO conversations(account_id,chat_id,chat_type) VALUES($1,$2,\'direct\')', [accountId, chatId]);
    await pool.query(`INSERT INTO messages(account_id,message_id,event_id,chat_id,chat_type,sender_id,kind,text_content,content,
      ingestion_source,occurred_at,raw) VALUES($1,$2,$3,$4,'direct',$5,'text','keep this row',
      '{"format":1,"type":"text"}'::jsonb,'live',now(),'{}'::jsonb)`,
    [accountId, 'external-unsend-message', 'external-unsend-event', chatId, 'u11111111111111111111111111111111']);
    const before = await pool.query('SELECT text_content,content,raw FROM messages WHERE account_id=$1 AND message_id=$2',
      [accountId, 'external-unsend-message']);

    const result = await facade.dispatch({ type: 'unsendMessage', requestId: 'external-monitor-unsend', accountId,
      chatType: 'direct', chatId, messageId: 'external-unsend-message' });

    expect(result).toMatchObject({ ok: false, code: 'EXTERNAL_MONITOR_READ_ONLY' });
    expect(commands.some((command) => command.type === 'unsendMessage' && command.requestId === 'external-monitor-unsend')).toBe(false);
    expect(await pool.query('SELECT text_content,content,raw FROM messages WHERE account_id=$1 AND message_id=$2',
      [accountId, 'external-unsend-message'])).toEqual(before);
  });

  /*
   * Media test port map (637d068): each old test keeps its name, and every old `resolveLineMedia(target, senderId)` call
   * has exactly one fixed-URL request through `viaUrl(target)` (build URL -> new URL().href -> parse -> handleLineMedia).
   * Old "capability" => expectMediaServed: 200, exactly one call of the named source builder with the listed args,
   *   no other builder call, and the exact mock-fetch list (fresh per-test cache dir, so a repeated asset fetches []).
   * Old "null" => expectMediaRejected: 404, zero source-builder calls, zero fetches.
   *
   * projects stored sticker metadata and resolves media only for the complete message scope
   * | old call | new assertion |
   * | sticker sticker-message -> capability | served: stickerSource('123456', true); fetch sticker/123456/android/sticker_animation.png |
   * | sticker chatId=different-chat -> null | rejected |
   * | (added) sticker missing-message | rejected |
   *
   * projects sticon ranges from stored message metadata and resolves only an in-range message index
   * | old call | new assertion |
   * | live-sticon-message index 0 -> null | rejected |
   * | live-sticon-message index 1 -> null | rejected |
   * | live-sticon-message index 2 -> null | rejected |
   * | emoji-live-sticon-message index 0 -> capability | served: sticonSource(productId, '004', true); fetch .../004_animation.png |
   * | sticon-message index 0 -> issueSticon(productId, '001', true) | served: sticonSource(productId, '001', true); fetch .../001_animation.png |
   * | sticon-message index 1 -> issueSticon(fedcba..., '002', true) | served: sticonSource('fedcba...', '002', true); fetch .../002_animation.png |
   * | duplicate-live-sticon-message index 0 -> issueSticon(productId, '001', true) | served: sticonSource(productId, '001', true); fetch [] (cached) |
   * | duplicate-live-sticon-message index 1 -> issueSticon(fedcba..., '002', true) | served: sticonSource('fedcba...', '002', true); fetch [] (cached) |
   * | native-masked-sticon-message index 0 -> issueSticon(aaaa..., '001', false) | served: sticonSource('aaaa...', '001', false); fetch .../001.png |
   * | native-masked-sticon-message index 1 -> issueSticon(bbbb..., '002', true) | served: sticonSource('bbbb...', '002', true); fetch .../002_animation.png |
   * | native-masked-sticon-message index 2 -> issueSticon(cccc..., '003', false) | served: sticonSource('cccc...', '003', false); fetch .../003.png |
   * | ordinary-message index 0 -> null | rejected |
   * | live-sticon-message index 0 after old-format REPLACE update -> null | rejected |
   * | (added) native-masked index 3, missing-message, sticon-message index 63, other chat, other account, malformed and oversized native metadata | rejected |
   *
   * resolves stored contact and account pictures consistently for direct, group, community, and own senders
   * | old call | new assertion |
   * | conversation direct direct-peer-picture -> capability | served: avatarSource(peerUrl); fetch peerUrl |
   * | conversation direct own-<accountId> -> capability | served: avatarSource(ownUrl); fetch [] (ownUrl cached by the account request) |
   * | member group picture-group group-sender-picture -> capability | served: avatarSource(groupUrl); fetch groupUrl |
   * | member community picture-community community-sender-picture -> capability | served: avatarSource(communityUrl); fetch communityUrl |
   * | member group picture-group missing-picture -> null | rejected |
   * | (added) account -> served: avatarSource(ownUrl); fetch ownUrl; community member in other chat, conversation in other account | rejected |
   */
  it('projects stored sticker metadata and resolves media only for the complete message scope', async () => {
    await addStoredAccounts('sticker-account');
    await facade.dispatch({ type: 'lineStart', requestId: 'start-sticker', accountId: 'sticker-account' });
    const binding = bindings.get('sticker-account')!;
    await workerEventHandler?.(binding.workerInstanceId, { type: 'batch', accountId: binding.accountId,
      workerInstanceId: binding.workerInstanceId, controlEpoch: binding.controlEpoch, batchId: 'sticker-batch',
      cursorBefore: { version: 1, revision: '0', globalRev: '0', individualRev: '0' },
      cursorAfter: { version: 1, revision: '1', globalRev: '1', individualRev: '0' }, envelopes: [{
        eventId: 'sticker-event', accountId: binding.accountId, chatType: 'group', chatId: 'sticker-chat',
        senderId: 'sticker-sender', messageId: 'sticker-message', kind: 'sticker', text: null,
        mentionIds: [], mentionRanges: [], replyToMessageId: null,
        ingestion: { source: 'live', cursor: null }, occurredAt: '2026-10-17T00:00:00.000Z', attachments: [],
        raw: { message: { contentMetadata: { STKID: '123456', STKOPT: 'A', STKTXT: 'Hello sticker' } } },
      }] });
    const key = { accountId: 'sticker-account', chatType: 'group' as const, chatId: 'sticker-chat' };

    const page = await facade.listMessages(key, null, 10);

    expect(page.messages[0]).toMatchObject({ kind: 'sticker', sticker: {
      stickerId: '123456', animated: true, altText: 'Hello sticker',
    } });
    await expectMediaRejected({ type: 'sticker', accountId: 'sticker-account', chatType: 'group', chatId: 'sticker-chat', messageId: 'missing-message' });
    await expectMediaServed({ type: 'sticker', ...key, messageId: 'sticker-message' }, 'stickerSource', ['123456', true],
      ['https://stickershop.line-scdn.net/stickershop/v1/sticker/123456/android/sticker_animation.png']);
    await expectMediaRejected({ type: 'sticker', ...key, chatId: 'different-chat', messageId: 'sticker-message' });
    // A recalled sticker whose current raw has no sticker metadata is served from raw.recall.original.
    await pool.query("UPDATE messages SET raw=$3::jsonb WHERE account_id=$1 AND message_id=$2", [binding.accountId, 'sticker-message', JSON.stringify({
      native: { format: 2, table: '_message', sourceDigest: 'd'.repeat(64), encoding: 'plain',
        row: { columns: ['_contentType', '_contentMetadata'], cells: [{ sqliteType: 'integer', value: '7' }, '{"UNSENT":"true"}'] } },
      recall: { recalledAt: '2026-10-22T00:00:00.000Z', original: { format: 2, table: '_message', sourceDigest: 'e'.repeat(64), encoding: 'plain',
        row: { columns: ['_contentType', '_contentMetadata'], cells: [{ sqliteType: 'integer', value: '7' }, '{"STKID":"777","STKOPT":"A","STKTXT":"old"}'] } } } })]);
    await expectMediaServed({ type: 'sticker', ...key, messageId: 'sticker-message' }, 'stickerSource', ['777', true],
      ['https://stickershop.line-scdn.net/stickershop/v1/sticker/777/android/sticker_animation.png']);
  });

  it('projects sticon ranges from stored message metadata and resolves only an in-range message index', async () => {
    await addStoredAccounts('sticon-account');
    await facade.dispatch({ type: 'lineStart', requestId: 'start-sticon', accountId: 'sticon-account' });
    const binding = bindings.get('sticon-account')!;
    const productId = '0123456789abcdef01234567';
    await workerEventHandler?.(binding.workerInstanceId, { type: 'batch', accountId: binding.accountId,
      workerInstanceId: binding.workerInstanceId, controlEpoch: binding.controlEpoch, batchId: 'sticon-batch',
      cursorBefore: { version: 1, revision: '0', globalRev: '0', individualRev: '0' },
      cursorAfter: { version: 1, revision: '1', globalRev: '1', individualRev: '0' }, envelopes: [{
        eventId: 'sticon-event', accountId: binding.accountId, chatType: 'group', chatId: 'sticon-chat',
        senderId: 'sticon-sender', messageId: 'sticon-message', kind: 'text', text: '(pray)',
        mentionIds: [], mentionRanges: [], replyToMessageId: null,
        ingestion: { source: 'live', cursor: null }, occurredAt: '2026-10-17T00:00:00.000Z', attachments: [],
        raw: { message: { text: '(pray)', contentMetadata: { REPLACE: JSON.stringify({ sticon: { resources: [
          { S: 0, E: 6, resourceType: 'ANIMATION', version: 1, sticonId: '001', productId },
        ] } }) } } },
      }, {
        eventId: 'live-sticon-event', accountId: binding.accountId, chatType: 'group', chatId: 'sticon-chat',
        senderId: 'sticon-sender', messageId: 'live-sticon-message', kind: 'text', text: 'LW-ABCDEFGH (pray) RA-token (wave)',
        mentionIds: [], mentionRanges: [], replyToMessageId: null,
        ingestion: { source: 'live', cursor: null }, occurredAt: '2026-10-17T00:00:02.000Z', attachments: [],
        raw: { message: { text: 'LW-ABCDEFGH (pray) RA-token (wave)', contentMetadata: { REPLACE: JSON.stringify({ sticon: { resources: [
          { S: 12, E: 18, resourceType: 'STATIC', version: 1, sticonId: '001', productId },
          { S: 28, E: 34, resourceType: 'ANIMATION', version: 1, sticonId: '002', productId },
          { S: 0, E: 10, resourceType: 'STATIC', version: 1, sticonId: '003', productId },
        ] } }) } } },
      }, {
        eventId: 'emoji-live-sticon-event', accountId: binding.accountId, chatType: 'group', chatId: 'sticon-chat',
        senderId: 'sticon-sender', messageId: 'emoji-live-sticon-message', kind: 'text', text: '😀 (pray)',
        mentionIds: [], mentionRanges: [], replyToMessageId: null,
        ingestion: { source: 'live', cursor: null }, occurredAt: '2026-10-17T00:00:03.000Z', attachments: [],
        raw: { message: { text: '😀 (pray)', contentMetadata: { REPLACE: JSON.stringify({ sticon: { resources: [
          { S: 3, E: 9, resourceType: 'ANIMATION', version: 1, sticonId: '004', productId },
        ] } }) } } },
      }, {
        eventId: 'duplicate-live-sticon-event', accountId: binding.accountId, chatType: 'group', chatId: 'sticon-chat',
        senderId: 'sticon-sender', messageId: 'duplicate-live-sticon-message', kind: 'text', text: '(pray) (pray)',
        mentionIds: [], mentionRanges: [], replyToMessageId: null,
        ingestion: { source: 'live', cursor: null }, occurredAt: '2026-10-17T00:00:04.000Z', attachments: [],
        raw: { message: { text: '(pray) (pray)', contentMetadata: { REPLACE: JSON.stringify({ sticon: { resources: [
          { S: 0, E: 6, resourceType: 'ANIMATION', version: 1, sticonId: '001', productId },
          { S: 7, E: 13, resourceType: 'ANIMATION', version: 1, sticonId: '002', productId: 'fedcba9876543210fedcba98' },
        ] } }) } } },
      }, {
        eventId: 'native-masked-sticon-event', accountId: binding.accountId, chatType: 'group', chatId: 'sticon-chat',
        senderId: 'sticon-sender', messageId: 'native-masked-sticon-message', kind: 'text',
        text: 'LW-ABCDEFGH (a) RA-token (b) (c) LW-IJKLMNOP',
        mentionIds: [], mentionRanges: [], replyToMessageId: null,
        ingestion: { source: 'live', cursor: null }, occurredAt: '2026-10-17T00:00:05.000Z', attachments: [],
        raw: { message: { text: 'LW-ABCDEFGH (a) RA-token (b) (c) LW-IJKLMNOP', contentMetadata: {} } },
      }, {
        eventId: 'ordinary-event', accountId: binding.accountId, chatType: 'group', chatId: 'sticon-chat',
        senderId: 'sticon-sender', messageId: 'ordinary-message', kind: 'text', text: 'plain',
        mentionIds: [], mentionRanges: [], replyToMessageId: null,
        ingestion: { source: 'live', cursor: null }, occurredAt: '2026-10-17T00:00:01.000Z', attachments: [], raw: {},
      }] });
    const nativeSticon = plainEnvelope({ _id: 'sticon-message', _text: '(pray) (pray)', _contentMetadata: JSON.stringify({
      REPLACE: JSON.stringify({ sticon: { resources: [
        { S: 0, E: 6, resourceType: 'ANIMATION', version: 1, sticonId: '001', productId },
        { S: 7, E: 13, resourceType: 'ANIMATION', version: 1, sticonId: '002', productId: 'fedcba9876543210fedcba98' },
      ] } }),
      STICON_OWNERSHIP: JSON.stringify([productId]),
    }) });
    await pool.query("UPDATE messages SET text_content=$3, raw=jsonb_build_object('native',$2::jsonb) WHERE account_id=$1 AND message_id='sticon-message'",
      [binding.accountId, JSON.stringify(nativeSticon), '(pray) (pray)']);
    const nativeMaskedText = 'LW-ABCDEFGH (a) RA-token (b) (c) LW-IJKLMNOP';
    const nativeAStart = nativeMaskedText.indexOf('(a)');
    const nativeBStart = nativeMaskedText.indexOf('(b)');
    const nativeCStart = nativeMaskedText.indexOf('(c)');
    const nativeTokenStart = nativeMaskedText.indexOf('RA-token');
    const nativeMasked = plainEnvelope({ _id: 'native-masked-sticon-message', _text: nativeMaskedText,
      _contentMetadata: JSON.stringify({ REPLACE: JSON.stringify({ sticon: { resources: [
        { S: nativeAStart, E: nativeAStart + 3, resourceType: 'STATIC', version: 1, sticonId: '001', productId: 'aaaaaaaaaaaaaaaaaaaaaaaa' },
        { S: nativeBStart, E: nativeBStart + 3, resourceType: 'ANIMATION', version: 1, sticonId: '002', productId: 'bbbbbbbbbbbbbbbbbbbbbbbb' },
        { S: nativeCStart, E: nativeCStart + 3, resourceType: 'STATIC', version: 1, sticonId: '003', productId: 'cccccccccccccccccccccccc' },
        { S: nativeTokenStart - 1, E: nativeTokenStart + 5, resourceType: 'ANIMATION', version: 1, sticonId: '006', productId: 'dddddddddddddddddddddddd' },
      ] } }) }) });
    await pool.query("UPDATE messages SET text_content=$3, raw=jsonb_build_object('native',$2::jsonb) WHERE account_id=$1 AND message_id='native-masked-sticon-message'",
      [binding.accountId, JSON.stringify(nativeMasked), '[REDACTED_VERIFICATION_CODE] (a) [REDACTED] (b) (c) [REDACTED_VERIFICATION_CODE]']);
    const key = { accountId: binding.accountId, chatType: 'group' as const, chatId: 'sticon-chat' };
    const originalQuery = pool.query.bind(pool);
    const sqlSeen: string[] = [];
    const querySpy = vi.spyOn(pool, 'query').mockImplementation(((sql: string, values?: unknown[]) => {
      sqlSeen.push(sql);
      return originalQuery(sql, values as never);
    }) as typeof pool.query);
    let page: Awaited<ReturnType<typeof facade.listMessages>>;
    try { page = await facade.listMessages(key, null, 10); }
    finally { querySpy.mockRestore(); }
    const projection = sqlSeen.find((sql) => sql.includes("jsonb_array_elements_text(raw->'native'->'row'->'columns')") && sql.includes("'_contentMetadata'"));
    expect(projection).toContain("'_text'");
    expect(projection).toContain("'_contentMetadata'");
    expect(projection).not.toContain("'_location'");
    expect(projection).toContain('LIMIT 100');
    expect(page.messages.length).toBeLessThanOrEqual(100);
    expect(page.messages.find((item) => item.messageId === 'sticon-message')?.sticonRanges).toEqual([
      { start: 0, end: 6, productId, sticonId: '001', animated: true },
      { start: 7, end: 13, productId: 'fedcba9876543210fedcba98', sticonId: '002', animated: true },
    ]);
    const nativeMaskedMessage = page.messages.find((item) => item.messageId === 'native-masked-sticon-message')!;
    expect(nativeMaskedMessage.text).toBe('[REDACTED_VERIFICATION_CODE] (a) [REDACTED] (b) (c) [REDACTED_VERIFICATION_CODE]');
    expect(nativeMaskedMessage.sticonRanges).toBeDefined();
    const nativeMaskedRanges = nativeMaskedMessage.sticonRanges!;
    expect(nativeMaskedRanges.map((range) => nativeMaskedMessage.text!.slice(range.start, range.end)))
      .toEqual(['(a)', '(b)', '(c)']);
    expect(nativeMaskedRanges).toEqual([
      expect.objectContaining({ productId: 'aaaaaaaaaaaaaaaaaaaaaaaa', sticonId: '001' }),
      expect.objectContaining({ productId: 'bbbbbbbbbbbbbbbbbbbbbbbb', sticonId: '002' }),
      expect.objectContaining({ productId: 'cccccccccccccccccccccccc', sticonId: '003' }),
    ]);
    expect(nativeMaskedRanges.some(({ productId: actualProductId, sticonId }) => actualProductId === 'dddddddddddddddddddddddd' || sticonId === '006')).toBe(false);
    expect(page.messages.find((item) => item.messageId === 'ordinary-message')?.sticonRanges).toEqual([]);
    const liveMessage = page.messages.find((item) => item.messageId === 'live-sticon-message')!;
    expect(liveMessage.text).toBe('[REDACTED_VERIFICATION_CODE] (pray) [REDACTED] (wave)');
    const prayAt = liveMessage.text!.indexOf('(pray)');
    const waveAt = liveMessage.text!.indexOf('(wave)');
    expect(liveMessage.sticonRanges).toEqual([]);
    const persistedLive = await pool.query<{ raw: { message: { text: string; contentMetadata: { REPLACE: string } } } }>(
      "SELECT raw FROM messages WHERE account_id=$1 AND message_id='live-sticon-message'", [binding.accountId]);
    const persistedText = persistedLive.rows[0]!.raw.message.text;
    const persistedReplace = JSON.parse(persistedLive.rows[0]!.raw.message.contentMetadata.REPLACE) as { sticon: { resources: Array<{ S: number; E: number; sticonId: string }> } };
    expect(persistedText).toBe(liveMessage.text);
    expect(persistedText).not.toContain('LW-ABCDEFGH'); expect(persistedText).not.toContain('RA-token');
    expect(persistedReplace.sticon.resources.map(({ S, E, sticonId }) => [S, E, sticonId])).toEqual([[12, 18, '001'], [28, 34, '002'], [0, 10, '003']]);
    // Old resolveLineMedia(live-sticon-message, 0|1|2) => null: the masked live text no longer carries its stored ranges.
    for (const index of [0, 1, 2]) await expectMediaRejected({ type: 'sticon', ...key, messageId: 'live-sticon-message', index });
    const sticonUrl = (id: string, sticonId: string, animated: boolean) =>
      `https://stickershop.line-scdn.net/sticonshop/v1/sticon/${id}/android/${sticonId}${animated ? '_animation' : ''}.png`;
    const otherProductId = 'fedcba9876543210fedcba98';
    const emojiMessage = page.messages.find((item) => item.messageId === 'emoji-live-sticon-message')!;
    const emojiStart = emojiMessage.text!.indexOf('(pray)');
    expect(emojiMessage.sticonRanges).toEqual([{ start: emojiStart, end: emojiStart + 6, productId, sticonId: '004', animated: true }]);
    await expectMediaServed({ type: 'sticon', ...key, messageId: 'emoji-live-sticon-message', index: 0 }, 'sticonSource',
      [productId, '004', true], [sticonUrl(productId, '004', true)]);
    // Distinct assets per index: a swapped or always-first index builds the wrong (productId, sticonId) and fails here.
    await expectMediaServed({ type: 'sticon', ...key, messageId: 'sticon-message', index: 0 }, 'sticonSource',
      [productId, '001', true], [sticonUrl(productId, '001', true)]);
    await expectMediaServed({ type: 'sticon', ...key, messageId: 'sticon-message', index: 1 }, 'sticonSource',
      [otherProductId, '002', true], [sticonUrl(otherProductId, '002', true)]);
    const duplicateMessage = page.messages.find((item) => item.messageId === 'duplicate-live-sticon-message')!;
    expect(duplicateMessage.sticonRanges).toEqual([
      { start: 0, end: 6, productId, sticonId: '001', animated: true },
      { start: 7, end: 13, productId: otherProductId, sticonId: '002', animated: true },
    ]);
    // Same assets as sticon-message: the disk cache serves them without a fetch, so the builder arguments are the proof.
    await expectMediaServed({ type: 'sticon', ...key, messageId: 'duplicate-live-sticon-message', index: 0 }, 'sticonSource',
      [productId, '001', true], []);
    await expectMediaServed({ type: 'sticon', ...key, messageId: 'duplicate-live-sticon-message', index: 1 }, 'sticonSource',
      [otherProductId, '002', true], []);
    for (const [index, expectedProductId, expectedSticonId, animated] of [
      [0, 'aaaaaaaaaaaaaaaaaaaaaaaa', '001', false],
      [1, 'bbbbbbbbbbbbbbbbbbbbbbbb', '002', true],
      [2, 'cccccccccccccccccccccccc', '003', false],
    ] as const) {
      await expectMediaServed({ type: 'sticon', ...key, messageId: 'native-masked-sticon-message', index }, 'sticonSource',
        [expectedProductId, expectedSticonId, animated], [sticonUrl(expectedProductId, expectedSticonId, animated)]);
    }
    await expectMediaRejected({ type: 'sticon', ...key, messageId: 'ordinary-message', index: 0 });
    await expectMediaRejected({ type: 'sticon', ...key, messageId: 'native-masked-sticon-message', index: 3 });
    await expectMediaRejected({ type: 'sticon', ...key, messageId: 'missing-message', index: 0 });
    await expectMediaRejected({ type: 'sticon', ...key, messageId: 'sticon-message', index: 63 });
    await expectMediaRejected({ type: 'sticon', ...key, chatId: 'elsewhere', messageId: 'sticon-message', index: 0 });
    await expectMediaRejected({ type: 'sticon', ...key, accountId: 'other-account', messageId: 'sticon-message', index: 0 });
    await pool.query(`UPDATE messages SET raw=jsonb_set(raw,ARRAY['native','row','cells',
      (array_position(ARRAY(SELECT jsonb_array_elements_text(raw->'native'->'row'->'columns')), '_contentMetadata')-1)::text],to_jsonb($2::text))
      WHERE account_id=$1 AND message_id='sticon-message'`, [binding.accountId, '{not-json']);
    await expectMediaRejected({ type: 'sticon', ...key, messageId: 'sticon-message', index: 0 });
    await pool.query(`UPDATE messages SET raw=jsonb_set(raw,ARRAY['native','row','cells',
      (array_position(ARRAY(SELECT jsonb_array_elements_text(raw->'native'->'row'->'columns')), '_contentMetadata')-1)::text],to_jsonb($2::text))
      WHERE account_id=$1 AND message_id='sticon-message'`, [binding.accountId, 'x'.repeat(9000)]);
    await expectMediaRejected({ type: 'sticon', ...key, messageId: 'sticon-message', index: 0 });
    await pool.query(`UPDATE messages SET raw=jsonb_set(raw,'{message,contentMetadata,REPLACE}',to_jsonb($2::text))
      WHERE account_id=$1 AND message_id='live-sticon-message'`, [binding.accountId, JSON.stringify({ sticon: { resources: [
        { S: 0, E: 10, resourceType: 'STATIC', version: 1, sticonId: '005', productId },
      ] } })]);
    const oldPage = await facade.listMessages(key, null, 10);
    expect(oldPage.messages.find((item) => item.messageId === 'live-sticon-message')?.sticonRanges).toEqual([]);
    await expectMediaRejected({ type: 'sticon', ...key, messageId: 'live-sticon-message', index: 0 });
  });

  it('leaves unnamed timeline attachments for localized display and retains named file names', async () => {
    await addStoredAccounts('attachment-label-account');
    await facade.dispatch({ type: 'lineStart', requestId: 'start-attachment-labels', accountId: 'attachment-label-account' });
    const binding = bindings.get('attachment-label-account')!;
    await workerEventHandler?.(binding.workerInstanceId, { type: 'batch', accountId: binding.accountId,
      workerInstanceId: binding.workerInstanceId, controlEpoch: binding.controlEpoch, batchId: 'attachment-label-batch',
      cursorBefore: { version: 1, revision: '0', globalRev: '0', individualRev: '0' },
      cursorAfter: { version: 1, revision: '1', globalRev: '1', individualRev: '0' }, envelopes: [{
        eventId: 'attachment-label-event', accountId: binding.accountId, chatType: 'group', chatId: 'attachment-label-chat',
        senderId: 'attachment-label-sender', messageId: 'attachment-label-message', kind: 'text', text: 'attachments',
        mentionIds: [], mentionRanges: [], replyToMessageId: null, ingestion: { source: 'live', cursor: null },
        occurredAt: '2026-10-17T00:00:00.000Z', attachments: (['image', 'video', 'audio', 'file'] as const).flatMap((kind) =>
          ([null, '  ', `${kind}.ext`] as const).map((name, index) => ({ id: `label-${kind}-${index}`, kind, name,
            mimeType: null, sizeBytes: 1 }))), raw: {},
      }] });
    const key = { accountId: binding.accountId, chatType: 'group' as const, chatId: 'attachment-label-chat' };
    const completed = await pool.query<{ attachment_id: string }>("UPDATE attachments SET status='ready',relative_path='managed/completed-image',sha256=$2,size_bytes=1 WHERE account_id=$1 AND external_attachment_id='label-image-0' RETURNING attachment_id",
      [binding.accountId, 'b'.repeat(64)]);
    const page = await facade.listMessages(key, null, 10);
    for (const kind of ['image', 'video', 'audio', 'file'] as const) {
      expect(page.messages[0]?.attachments.filter((item) => item.kind === kind).map((item) => item.name).sort())
        .toEqual(['', '', `${kind}.ext`].sort());
    }
    expect(page.messages[0]?.attachments.find(({ id }) => id === completed.rows[0]?.attachment_id))
      .toMatchObject({ name: '', status: 'ready' });
    const listed = await facade.dispatch({ type: 'listAttachments', requestId: 'list-attachment-labels', ...key, before: null, limit: 20 });
    expect(listed).toMatchObject({ ok: true, attachments: expect.arrayContaining([
      expect.objectContaining({ kind: 'image', name: '圖片' }), expect.objectContaining({ kind: 'video', name: '影片' }),
      expect.objectContaining({ kind: 'audio', name: '語音' }), expect.objectContaining({ kind: 'file', name: '檔案' }),
      expect.objectContaining({ kind: 'file', name: 'file.ext' }),
    ]) });
    expect(page.messages[0]).toMatchObject({ deleted: false, attachments: expect.arrayContaining([expect.objectContaining({ kind: 'file' })]) });
    const parsedNormal = MessagePageSchema.parse(page);
    expect(parsedNormal.messages[0]).not.toHaveProperty('sourceDeleted');
    expect(parsedNormal.messages[0]).not.toHaveProperty('recallOriginal');
    await pool.query("UPDATE messages SET content=$3::jsonb WHERE account_id=$1 AND message_id=$2",
      [binding.accountId, 'attachment-label-message', JSON.stringify({ format: 1, type: 'unsent' })]);
    const recalledPage = await facade.listMessages(key, null, 10);
    expect(recalledPage.messages[0]).toMatchObject({ deleted: true, attachments: expect.arrayContaining([expect.objectContaining({ kind: 'file' })]) });
    expect(recalledPage.messages[0]).toMatchObject({ deletedAtSource: false, recalledContent: null });
    const nativeEnvelope = (cells: unknown[]) => ({ format: 2, table: '_message', sourceDigest: 'c'.repeat(64), encoding: 'plain',
      row: { columns: ['_contentType', '_text', '_contentMetadata'], cells } });
    const setRaw = (patch: unknown) => pool.query("UPDATE messages SET raw=COALESCE(raw,'{}'::jsonb) || $3::jsonb WHERE account_id=$1 AND message_id=$2",
      [binding.accountId, 'attachment-label-message', JSON.stringify(patch)]);
    // A recalled sticker original is exposed for display only; the stored content stays unsent.
    await setRaw({ recall: { recalledAt: '2026-10-22T00:00:00.000Z', original: nativeEnvelope([{ sqliteType: 'integer', value: '7' }, null,
      '{"STKID":"4242","STKOPT":"A","STKTXT":"hello"}']) } });
    const stickerPage = await facade.listMessages(key, null, 10);
    for (const leaked of MessagePageSchema.parse(stickerPage).messages) { expect(leaked).not.toHaveProperty('sourceDeleted'); expect(leaked).not.toHaveProperty('recallOriginal'); }
    expect(stickerPage.messages[0]).toMatchObject({ deleted: true, deletedAtSource: false, content: { type: 'unsent' },
      recalledKind: 'sticker', sticker: { stickerId: '4242', animated: true, altText: 'hello' } });
    // A recalled text original is exposed as display text.
    await setRaw({ recall: { recalledAt: '2026-10-22T00:00:00.000Z', original: nativeEnvelope([{ sqliteType: 'integer', value: '0' }, 'original words', null]) } });
    const textPage = await facade.listMessages(key, null, 10);
    for (const leaked of MessagePageSchema.parse(textPage).messages) { expect(leaked).not.toHaveProperty('sourceDeleted'); expect(leaked).not.toHaveProperty('recallOriginal'); }
    expect(textPage.messages[0]).toMatchObject({ deleted: true, recalledKind: 'text', recalledText: 'original words' });
    // A row LINE deleted at the source is presented like a recall.
    await pool.query("UPDATE messages SET content=NULL WHERE account_id=$1 AND message_id=$2", [binding.accountId, 'attachment-label-message']);
    await setRaw({ sourceDeleted: { detectedAt: '2026-10-22T00:00:00.000Z' } });
    const deletedPage = await facade.listMessages(key, null, 10);
    for (const leaked of MessagePageSchema.parse(deletedPage).messages) { expect(leaked).not.toHaveProperty('sourceDeleted'); expect(leaked).not.toHaveProperty('recallOriginal'); }
    expect(deletedPage.messages[0]).toMatchObject({ deleted: true, deletedAtSource: true });
  });

  it('resolves a stored image attachment through the line media protocol handler', async () => {
    await addStoredAccounts('media-attachment-account');
    await facade.dispatch({ type: 'lineStart', requestId: 'start-media-attachment', accountId: 'media-attachment-account' });
    const binding = bindings.get('media-attachment-account')!;
    const key = { accountId: binding.accountId, chatType: 'group' as const, chatId: 'media-attachment-chat' };
    await workerEventHandler?.(binding.workerInstanceId, { type: 'batch', accountId: binding.accountId,
      workerInstanceId: binding.workerInstanceId, controlEpoch: binding.controlEpoch, batchId: 'media-attachment-batch',
      cursorBefore: { version: 1, revision: '0', globalRev: '0', individualRev: '0' },
      cursorAfter: { version: 1, revision: '1', globalRev: '1', individualRev: '0' }, envelopes: [{
        eventId: 'media-attachment-event', accountId: binding.accountId, chatType: key.chatType, chatId: key.chatId,
        senderId: 'media-attachment-sender', messageId: 'media-attachment-message', kind: 'image', text: null,
        mentionIds: [], mentionRanges: [], replyToMessageId: null, ingestion: { source: 'live', cursor: null },
        occurredAt: '2026-10-17T00:00:00.000Z', attachments: [{ id: 'media-attachment-external', kind: 'image',
          name: 'preview.png', mimeType: 'image/png', sizeBytes: MEDIA_PNG.byteLength }], raw: {},
      }] });
    await waitForState(async () => {
      const rows = await pool.query("SELECT attachment_id FROM attachments WHERE account_id=$1 AND external_attachment_id='media-attachment-external'", [binding.accountId]);
      expect(rows.rows).toHaveLength(1);
    });
    const attachmentId = '2a653934-7064-4d90-a9f0-e6e24cf4f93d';
    await pool.query("UPDATE attachments SET attachment_id=$2,status='ready',relative_path='managed/preview.png',sha256=$3,size_bytes=$4 WHERE account_id=$1 AND external_attachment_id='media-attachment-external'",
      [binding.accountId, attachmentId, 'a'.repeat(64), MEDIA_PNG.byteLength]);
    expect(await new MessageRepository(pool).getAttachment(attachmentId)).toMatchObject({ attachmentId, accountId: binding.accountId,
      chatType: key.chatType, chatId: key.chatId, kind: 'image', status: 'ready' });
    const readImage = vi.spyOn(AttachmentPreviewService.prototype, 'readImage')
      .mockResolvedValue({ bytes: Buffer.from(MEDIA_PNG), mimeType: 'image/png' });
    const target = parseLineMediaUrl('line-media://attachment/bWVkaWEtYXR0YWNobWVudC1hY2NvdW50/group/bWVkaWEtYXR0YWNobWVudC1jaGF0/MmE2NTM5MzQtNzA2NC00ZDkwLWE5ZjAtZTZlMjRjZjRmOTNk');
    expect(parseLineMediaUrl('not-a-line-media-url')).toBeNull();
    expect(parseLineMediaUrl('line-media://invalid')).toBeNull();
    expect(target).toEqual({ type: 'attachment', ...key, attachmentId });
    const response = await viaUrl(target!);
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('image/png');
    expect(readImage).toHaveBeenCalledWith(attachmentId, expect.objectContaining(key), { senderId: 0 }, 8 * 1024 * 1024, expect.any(AbortSignal));

    const wrongConversation = parseLineMediaUrl('line-media://attachment/bWVkaWEtYXR0YWNobWVudC1hY2NvdW50/group/b3RoZXItY29udmVyc2F0aW9u/MmE2NTM5MzQtNzA2NC00ZDkwLWE5ZjAtZTZlMjRjZjRmOTNk');
    const previousCalls = readImage.mock.calls.length;
    expect(await viaUrl(wrongConversation!)).toMatchObject({ status: 404 });
    expect(readImage).toHaveBeenCalledTimes(previousCalls);
    readImage.mockRestore();
  });

  it('shows contact nicknames as timeline senders (group, direct, reply) and keeps accounts apart', async () => {
    await addStoredAccounts('names-account');
    await facade.dispatch({ type: 'lineStart', requestId: 'start-names', accountId: 'names-account' });
    const binding = bindings.get('names-account')!;
    await pool.query(`INSERT INTO line_contacts(account_id,mid,display_name,nickname) VALUES
      ('names-account','nick-friend','Real Name','張襄君'),('names-account','plain-friend','Plain Name',NULL)`);
    const envelope = (messageId: string, chatType: 'group' | 'direct', chatId: string, senderId: string, replyTo: string | null = null) => ({
      eventId: `event-${messageId}`, accountId: binding.accountId, chatType, chatId, senderId, messageId, kind: 'text' as const,
      text: `text ${messageId}`, mentionIds: [], mentionRanges: [], replyToMessageId: replyTo,
      ingestion: { source: 'live' as const, cursor: null }, occurredAt: '2026-10-17T00:00:00.000Z', attachments: [], raw: {} });
    await workerEventHandler?.(binding.workerInstanceId, { type: 'batch', accountId: binding.accountId,
      workerInstanceId: binding.workerInstanceId, controlEpoch: binding.controlEpoch, batchId: 'names-batch',
      cursorBefore: { version: 1, revision: '0', globalRev: '0', individualRev: '0' },
      cursorAfter: { version: 1, revision: '1', globalRev: '1', individualRev: '0' }, envelopes: [
        envelope('names-nick', 'group', 'names-group', 'nick-friend'),
        envelope('names-plain', 'group', 'names-group', 'plain-friend'),
        envelope('names-reply', 'group', 'names-group', 'nick-friend', 'names-nick'),
        envelope('names-own', 'group', 'names-group', 'own-names-account'),
        envelope('names-direct', 'direct', 'nick-friend', 'nick-friend'),
        envelope('names-stranger', 'group', 'names-group', 'stranger'),
      ] });
    const group = await facade.listMessages({ accountId: 'names-account', chatType: 'group', chatId: 'names-group' }, null, 10);
    const nameOf = (page: typeof group, id: string) => page.messages.find((message) => message.messageId === id)?.senderName;
    expect(nameOf(group, 'names-nick')).toBe('張襄君');
    expect(nameOf(group, 'names-plain')).toBe('Plain Name');
    expect(nameOf(group, 'names-reply')).toBe('張襄君');
    expect(group.messages.find((message) => message.messageId === 'names-reply')?.replyToMessageId).toBe('names-nick');
    expect(nameOf(group, 'names-own')).toBe('names-account');
    expect(nameOf(group, 'names-stranger')).toBe('stranger'); // Renderer localizes the sender-ID sentinel.
    const direct = await facade.listMessages({ accountId: 'names-account', chatType: 'direct', chatId: 'nick-friend' }, null, 10);
    expect(nameOf(direct, 'names-direct')).toBe('張襄君');
    // The same MID under another account resolves to that account's own nickname (or none).
    await pool.query("INSERT INTO line_accounts(account_id,display_name,own_mid) VALUES ('names-other','names-other','own-names-other')");
    await pool.query("INSERT INTO line_contacts(account_id,mid,display_name,nickname) VALUES ('names-other','nick-friend','Real Name','Other Nick')");
    await pool.query("INSERT INTO conversations(account_id,chat_type,chat_id,title) VALUES ('names-other','direct','nick-friend','')");
    await pool.query(`INSERT INTO messages(account_id,message_id,event_id,chat_type,chat_id,sender_id,kind,text_content,mention_ids,mention_ranges,ingestion_source,occurred_at,raw)
      VALUES ('names-other','other-direct','event-other','direct','nick-friend','nick-friend','text','hi','[]','[]','history',now(),'{}')`);
    const other = await facade.listMessages({ accountId: 'names-other', chatType: 'direct', chatId: 'nick-friend' }, null, 10);
    expect(nameOf(other, 'other-direct')).toBe('Other Nick');
  });

  it('lists only this account\'s status-1 friends with nickname-first names and conversation flags, within the schema and limit', async () => {
    await pool.query("INSERT INTO line_accounts(account_id,display_name,own_mid) VALUES ('friends-a','friends-a','own-friends-a'),('friends-b','friends-b','own-friends-b')");
    await pool.query(`INSERT INTO line_contacts(account_id,mid,display_name,nickname,native_status,picture_path) VALUES
      ('friends-a','f-nick','Real Name','暱稱',1,'p/a'),('friends-a','f-plain','Plain Name',NULL,1,NULL),
      ('friends-a','f-blocked','Blocked',NULL,2,NULL),('friends-a','f-deleted','Deleted',NULL,5,NULL),('friends-a','f-unknown','Unknown',NULL,NULL,NULL),
      ('friends-b','f-other','Other Account',NULL,1,NULL)`);
    await pool.query("INSERT INTO conversations(account_id,chat_type,chat_id,title) VALUES ('friends-a','direct','f-nick',''),('friends-a','group','f-plain','group with friend mid')");
    const friends = await facade.listFriends!('friends-a');
    expect(FriendListSchema.parse(friends)).toEqual(friends);
    expect([...friends].sort((left, right) => left.mid.localeCompare(right.mid))).toEqual([
      { mid: 'f-nick', name: '暱稱', avatarAvailable: true, hasConversation: true },
      { mid: 'f-plain', name: 'Plain Name', avatarAvailable: false, hasConversation: false },
    ]);
    expect((await facade.listFriends!('friends-b')).map((row) => row.mid)).toEqual(['f-other']);
    expect(await facade.listFriends!('friends-none')).toEqual([]);
    await pool.query(`INSERT INTO line_contacts(account_id,mid,display_name,native_status)
      SELECT 'friends-a','bulk-' || n,'Bulk ' || n,1 FROM generate_series(1, ${FRIEND_LIST_LIMIT + 5}) n`);
    const bounded = await facade.listFriends!('friends-a');
    expect(bounded).toHaveLength(FRIEND_LIST_LIMIT);
    expect(FriendListSchema.safeParse(bounded).success).toBe(true);
  });

  it('projects readCount and reader lists within the strict schemas, with and without read positions', async () => {
    await pool.query("INSERT INTO line_accounts(account_id,display_name,own_mid) VALUES ('rr-a','rr-a','own-rr-a')");
    await pool.query("INSERT INTO conversations(account_id,chat_type,chat_id) VALUES ('rr-a','group','rr-group')");
    for (const [id, sender, minute] of [['100', 'own-rr-a', 1], ['200', 'rr-other', 2]] as const) {
      await pool.query(`INSERT INTO messages (account_id, message_id, event_id, chat_id, chat_type, sender_id, kind, text_content, ingestion_source, occurred_at, raw)
        VALUES ('rr-a',$1,$2,'rr-group','group',$3,'text','t','live','2026-10-22T00:00:00Z'::timestamptz + ($4 || ' minutes')::interval,'{}'::jsonb)`,
        [id, `ev-rr-${id}`, sender, String(minute)]);
    }
    const key = { accountId: 'rr-a', chatType: 'group' as const, chatId: 'rr-group' };
    const without = MessagePageSchema.parse(await facade.listMessages(key, null, 10));
    expect(without.messages.map((message) => message.readCount)).toEqual([undefined, undefined]);
    expect(MessageReadersSchema.parse(await facade.listMessageReaders!(key, '100'))).toEqual({ readers: [] });
    await pool.query("INSERT INTO line_contacts(account_id,mid,display_name) VALUES ('rr-a','rr-reader','Reader One')");
    await pool.query(`INSERT INTO message_read_positions (account_id,chat_type,chat_id,reader_mid,last_read_message_id,last_read_at) VALUES
      ('rr-a','group','rr-group','rr-reader','150','2026-10-22T01:00:00Z'),('rr-a','group','rr-group','rr-reader-2','100','2026-10-22T02:00:00Z')`);
    const withReads = MessagePageSchema.parse(await facade.listMessages(key, null, 10));
    expect(withReads.messages.map((message) => message.readCount)).toEqual([2, undefined]);
    const readers = MessageReadersSchema.parse(await facade.listMessageReaders!(key, '100'));
    expect(readers.readers.map((reader) => reader.mid)).toEqual(['rr-reader-2', 'rr-reader']);
    expect(readers.readers[1]!.name).toBe('Reader One');
    expect(await facade.listMessageReaders!(key, '200')).toEqual({ readers: [] });
  });

  it('projects real reaction samples through repository, facade mapping and the strict MessagePageSchema, and serves only present paid icons', async () => {
    const samples = [
      '{"reactionList":[{"PaidType":{},"PredefinedType":2,"createdAt":1792277695027,"reactor":"ub6f5a192eaf1fc1acc3c61508b4fd6da","type":1,"updatedAt":1792277695027,"cancel":false}],"totalCount":0,"countByType":{}}',
      '{"reactionList":[{"reactor":"ufaeaefdf10160b3aa1f38d2f57e68736","type":1,"createdAt":1792635926799,"updatedAt":1792635926799,"PredefinedType":4,"PaidType":{}}],"totalCount":0,"countByType":{}}',
      '{"reactionList":[{"reactor":"ub254b3c8c4fc001b1862a8eef68f4f00","type":2,"createdAt":1792638565546,"updatedAt":1792638565546,"PredefinedType":0,"PaidType":{"emojiId":"004","productId":"60ebfdc03cc24041bb139cf5","resourceType":1,"version":2}}],"totalCount":0,"countByType":{}}',
    ];
    await pool.query("INSERT INTO line_accounts(account_id,display_name,own_mid) VALUES ('rx-a','rx-a','own-rx-a')");
    await pool.query("INSERT INTO conversations(account_id,chat_type,chat_id) VALUES ('rx-a','group','rx-group')");
    await pool.query("INSERT INTO line_contacts(account_id,mid,display_name) VALUES ('rx-a','ub6f5a192eaf1fc1acc3c61508b4fd6da','Nice Person')");
    const insert = (id: string, minute: number, raw: unknown) => pool.query(
      `INSERT INTO messages (account_id, message_id, event_id, chat_id, chat_type, sender_id, kind, text_content, ingestion_source, occurred_at, raw)
       VALUES ('rx-a',$1,$2,'rx-group','group','rx-other','text','t','live','2026-10-22T00:00:00Z'::timestamptz + ($3 || ' minutes')::interval,$4::jsonb)`,
      [id, `ev-rx-${id}`, String(minute), JSON.stringify(raw)]);
    for (const [index, cell] of samples.entries()) {
      await insert(String(index + 1), index + 1, { native: { row: { columns: ['_reactionStatus'], cells: [cell] } } });
    }
    await insert('4', 4, {});
    const key = { accountId: 'rx-a', chatType: 'group' as const, chatId: 'rx-group' };
    const page = MessagePageSchema.parse(await facade.listMessages(key, null, 10));
    expect(page.messages.map((message) => message.reactions)).toEqual([
      [{ kind: 'NICE', count: 1, reactorNames: ['Nice Person'] }],
      [{ kind: 'FUN', count: 1, reactorNames: ['…8736'] }],
      [{ kind: 'PAID', productId: '60ebfdc03cc24041bb139cf5', emojiId: '004', count: 1, reactorNames: ['…4f00'] }],
      undefined,
    ]);
    const paid = { type: 'reaction' as const, ...key, productId: '60ebfdc03cc24041bb139cf5', emojiId: '004' };
    await expectMediaServed({ ...paid, messageId: '3' }, 'sticonSource', ['60ebfdc03cc24041bb139cf5', '004', false],
      ['https://stickershop.line-scdn.net/sticonshop/v1/sticon/60ebfdc03cc24041bb139cf5/android/004.png']);
    await expectMediaRejected({ ...paid, messageId: '1' });
    await expectMediaRejected({ ...paid, messageId: '3', emojiId: '005' });
  });

  it('projects bounded reply previews with the timeline sender name rule and omits missing targets', async () => {
    await addStoredAccounts('reply-preview-account');
    await facade.dispatch({ type: 'lineStart', requestId: 'start-reply-preview', accountId: 'reply-preview-account' });
    const binding = bindings.get('reply-preview-account')!;
    await pool.query("INSERT INTO line_contacts(account_id,mid,display_name,nickname) VALUES ($1,'quoted-sender','Display Name','Preferred Nick')", [binding.accountId]);
    const envelope = (messageId: string, kind: 'text' | 'image' | 'audio', text: string | null, replyToMessageId: string | null = null, chatId = 'reply-preview-chat') => ({
      eventId: `event-${messageId}`, accountId: binding.accountId, chatType: 'group' as const, chatId,
      senderId: messageId.startsWith('quoted-') ? 'quoted-sender' : 'reply-sender', messageId, kind, text,
      mentionIds: [], mentionRanges: [], replyToMessageId, ingestion: { source: 'live' as const, cursor: null },
      occurredAt: '2026-10-17T00:00:00.000Z', attachments: [], raw: {},
    });
    await workerEventHandler?.(binding.workerInstanceId, { type: 'batch', accountId: binding.accountId,
      workerInstanceId: binding.workerInstanceId, controlEpoch: binding.controlEpoch, batchId: 'reply-preview-batch',
      cursorBefore: { version: 1, revision: '0', globalRev: '0', individualRev: '0' },
      cursorAfter: { version: 1, revision: '1', globalRev: '1', individualRev: '0' }, envelopes: [
        envelope('quoted-text', 'text', `  ${'quoted text '.repeat(10)}  `),
        envelope('quoted-image', 'image', null),
        envelope('quoted-audio', 'audio', null),
        envelope('quoted-whitespace', 'text', ' \t\n '),
        envelope('quoted-unicode', 'text', '😀'.repeat(81)),
        envelope('quoted-other-chat', 'text', 'foreign quote', null, 'other-reply-preview-chat'),
        envelope('text-reply', 'text', 'reply', 'quoted-text'),
        envelope('image-reply', 'text', 'reply to image', 'quoted-image'),
        envelope('audio-reply', 'text', 'reply to audio', 'quoted-audio'),
        envelope('whitespace-reply', 'text', 'reply', 'quoted-whitespace'),
        envelope('unicode-reply', 'text', 'reply', 'quoted-unicode'),
        envelope('scope-reply', 'text', 'reply', 'quoted-other-chat'),
        envelope('missing-reply', 'text', 'reply to missing', 'no-longer-stored'),
      ] });
    const page = await facade.listMessages({ accountId: binding.accountId, chatType: 'group', chatId: 'reply-preview-chat' }, null, 30);
    const byId = new Map(page.messages.map((item) => [item.messageId, item]));
    const longPreview = `  ${'quoted text '.repeat(10)}  `.trim();
    expect(byId.get('text-reply')?.replyTo).toMatchObject({ messageId: 'quoted-text', senderId: 'quoted-sender',
      senderName: 'Preferred Nick', direction: 'inbound', senderAvatarAvailable: false,
      preview: `${Array.from(longPreview).slice(0, 79).join('')}…` });
    expect(byId.get('text-reply')?.replyTo?.preview.length).toBeLessThanOrEqual(80);
    expect(byId.get('image-reply')?.replyTo).toMatchObject({ messageId: 'quoted-image', preview: '圖片', senderName: 'Preferred Nick' });
    expect(byId.get('audio-reply')?.replyTo).toMatchObject({ messageId: 'quoted-audio', preview: '語音', senderName: 'Preferred Nick' });
    expect(byId.get('missing-reply')?.replyTo).toBeNull();
    expect(byId.get('whitespace-reply')?.replyTo?.preview).toBe('訊息內容');
    expect(Array.from(byId.get('unicode-reply')?.replyTo?.preview ?? '')).toHaveLength(80);
    expect(byId.get('unicode-reply')?.replyTo?.preview).toBe(`${'😀'.repeat(79)}…`);
    expect(byId.get('scope-reply')?.replyTo).toBeNull();
  });

  it('uses native community message status for timeline and quoted message direction', async () => {
    await addStoredAccounts('community-direction-account');
    await facade.dispatch({ type: 'lineStart', requestId: 'start-community-direction', accountId: 'community-direction-account' });
    const binding = bindings.get('community-direction-account')!;
    const accountId = binding.accountId;
    const ownMid = 'p-self';
    await pool.query('UPDATE line_accounts SET own_mid=$2 WHERE account_id=$1', [accountId, ownMid]);
    await new MessageRepository(pool).upsertConversationCatalog(accountId, [{ chatType: 'community', chatId: 'direction-community', title: 'Community', members: [
      { memberId: ownMid, displayName: 'Self' }, { memberId: 'p-other', displayName: 'Other' },
    ] }]);
    const insertNative = async (messageId: string, senderId: string, status: number, replyTo: string | null = null) => {
      const raw = { native: { format: 2, encoding: 'plain', table: '_message', row: {
        columns: ['_status'], cells: [{ value: status, sqliteType: 'integer' }],
      } } };
      await pool.query(`INSERT INTO messages(account_id,message_id,event_id,chat_type,chat_id,sender_id,kind,text_content,
        mention_ids,mention_ranges,ingestion_source,occurred_at,raw,reply_to_message_id)
        VALUES($1,$2,$3,'community','direction-community',$4,'text',$2,'[]'::jsonb,'[]'::jsonb,'history',now(),$5::jsonb,$6)`,
      [accountId, messageId, `event-${messageId}`, senderId, JSON.stringify(raw), replyTo]);
    };
    await insertNative('community-own', 'p-self', 2);
    await insertNative('community-other', 'p-other', 1);
    await insertNative('community-reply', 'p-other', 1, 'community-own');
    const page = await facade.listMessages({ accountId, chatType: 'community', chatId: 'direction-community' }, null, 10);
    const byId = new Map(page.messages.map((item) => [item.messageId, item]));
    expect(byId.get('community-own')?.direction).toBe('outbound');
    expect(byId.get('community-other')?.direction).toBe('inbound');
    expect(byId.get('community-reply')?.replyTo?.direction).toBe('outbound');
  });

  it('uses the direct conversation picture for an inbound quoted sender avatar', async () => {
    await addStoredAccounts('reply-direct-avatar-account');
    await facade.dispatch({ type: 'lineStart', requestId: 'start-reply-direct-avatar', accountId: 'reply-direct-avatar-account' });
    const binding = bindings.get('reply-direct-avatar-account')!;
    await pool.query("INSERT INTO conversations(account_id,chat_type,chat_id,title,picture_path) VALUES($1,'direct','direct-peer','Peer','/tmp/peer.png')", [binding.accountId]);
    const envelope = (messageId: string, senderId: string, replyToMessageId: string | null = null) => ({
      eventId: `event-${messageId}`, accountId: binding.accountId, chatType: 'direct' as const, chatId: 'direct-peer', senderId,
      messageId, kind: 'text' as const, text: messageId, mentionIds: [], mentionRanges: [], replyToMessageId,
      ingestion: { source: 'live' as const, cursor: null }, occurredAt: '2026-10-17T00:00:00.000Z', attachments: [], raw: {},
    });
    await workerEventHandler?.(binding.workerInstanceId, { type: 'batch', accountId: binding.accountId,
      workerInstanceId: binding.workerInstanceId, controlEpoch: binding.controlEpoch, batchId: 'reply-direct-avatar-batch',
      cursorBefore: { version: 1, revision: '0', globalRev: '0', individualRev: '0' },
      cursorAfter: { version: 1, revision: '1', globalRev: '1', individualRev: '0' }, envelopes: [
        envelope('direct-quoted-message', 'direct-peer'), envelope('direct-reply-message', 'own-direct', 'direct-quoted-message'),
      ] });
    const page = await facade.listMessages({ accountId: binding.accountId, chatType: 'direct', chatId: 'direct-peer' }, null, 10);
    expect(page.messages.find((item) => item.messageId === 'direct-reply-message')?.replyTo?.senderAvatarAvailable).toBe(true);
  });

  it('resolves stored contact and account pictures consistently for direct, group, community, and own senders', async () => {
    await addStoredAccounts('read-picture-account');
    await facade.dispatch({ type: 'lineStart', requestId: 'start-read-picture', accountId: 'read-picture-account' });
    const binding = bindings.get('read-picture-account')!;
    const peerUrl = 'https://profile.line-scdn.net/direct-peer-picture';
    const groupUrl = 'https://profile.line-scdn.net/group-member-picture';
    const communityUrl = 'https://obs.line-scdn.net/community-member-picture';
    const ownUrl = 'https://profile.line-scdn.net/own-picture';
    await pool.query("INSERT INTO line_contacts(account_id,mid,display_name,picture_path) VALUES($1,'direct-peer-picture','Peer',$2),($1,'group-sender-picture','Group sender',$3),($1,'community-sender-picture','Community sender',$4)",
      [binding.accountId, peerUrl, groupUrl, ownUrl]);
    await pool.query("UPDATE line_accounts SET picture_path=$2 WHERE account_id=$1", [binding.accountId, ownUrl]);
    await pool.query("INSERT INTO conversations(account_id,chat_type,chat_id,title) VALUES($1,'direct',$2,'Primary Admin')",
      [binding.accountId, `own-${binding.accountId}`]);
    await pool.query("INSERT INTO conversations(account_id,chat_type,chat_id,title) VALUES($1,'direct','direct-peer-picture','Peer'),($1,'group','picture-group','Group'),($1,'community','picture-community','Community')", [binding.accountId]);
    await pool.query("INSERT INTO conversation_members(account_id,chat_type,chat_id,member_id,picture_path) VALUES($1,'community','picture-community','community-sender-picture',$2)",
      [binding.accountId, communityUrl]);
    await workerEventHandler?.(binding.workerInstanceId, { type: 'batch', accountId: binding.accountId,
      workerInstanceId: binding.workerInstanceId, controlEpoch: binding.controlEpoch, batchId: 'read-picture-batch',
      cursorBefore: { version: 1, revision: '0', globalRev: '0', individualRev: '0' },
      cursorAfter: { version: 1, revision: '1', globalRev: '1', individualRev: '0' }, envelopes: ([
        ['read-direct', 'direct', 'direct-peer-picture', 'direct-peer-picture'],
        ['read-group', 'group', 'picture-group', 'group-sender-picture'],
        ['read-own', 'group', 'picture-group', 'own-picture-mid'],
      ] as const).map(([messageId, chatType, chatId, senderId]) => ({ eventId: `event-${messageId}`, accountId: binding.accountId,
        chatType: chatType as 'direct' | 'group', chatId, senderId, messageId,
        kind: 'text' as const, text: messageId, mentionIds: [], mentionRanges: [], replyToMessageId: null,
        ingestion: { source: 'live' as const, cursor: null }, occurredAt: '2026-10-17T00:00:00.000Z', attachments: [], raw: {} })) });
    await pool.query(`INSERT INTO messages(account_id,message_id,event_id,chat_type,chat_id,sender_id,kind,text_content,mention_ids,mention_ranges,ingestion_source,occurred_at,raw)
      VALUES($1,'read-community','event-read-community','community','picture-community','community-sender-picture','text','community', '[]','[]','history',now(),'{}')`, [binding.accountId]);
    const list = await facade.listMessages({ accountId: binding.accountId, chatType: 'direct', chatId: 'direct-peer-picture' }, null, 10);
    expect(list.messages[0]?.senderAvatarAvailable).toBe(true);
    const community = await facade.listMessages({ accountId: binding.accountId, chatType: 'community', chatId: 'picture-community' }, null, 10);
    expect(community.messages[0]?.senderAvatarAvailable).toBe(true);
    await expectMediaRejected({ type: 'member', accountId: binding.accountId, chatType: 'group', chatId: 'picture-group', memberId: 'missing-picture' });
    await expectMediaServed({ type: 'account', accountId: binding.accountId }, 'avatarSource', [ownUrl], [ownUrl]);
    await expectMediaServed({ type: 'conversation', accountId: binding.accountId, chatType: 'direct', chatId: 'direct-peer-picture' },
      'avatarSource', [peerUrl], [peerUrl]);
    // The own direct conversation falls back to the account picture, already cached by the account request above.
    await expectMediaServed({ type: 'conversation', accountId: binding.accountId, chatType: 'direct', chatId: `own-${binding.accountId}` },
      'avatarSource', [ownUrl], []);
    await expectMediaServed({ type: 'member', accountId: binding.accountId, chatType: 'group', chatId: 'picture-group', memberId: 'group-sender-picture' },
      'avatarSource', [groupUrl], [groupUrl]);
    await expectMediaServed({ type: 'member', accountId: binding.accountId, chatType: 'community', chatId: 'picture-community', memberId: 'community-sender-picture' },
      'avatarSource', [communityUrl], [communityUrl]);
    await expectMediaRejected({ type: 'member', accountId: binding.accountId, chatType: 'community', chatId: 'elsewhere', memberId: 'community-sender-picture' });
    await expectMediaRejected({ type: 'conversation', accountId: 'other-account', chatType: 'direct', chatId: 'direct-peer-picture' });
  });

  it('keeps message detail available when the Agent status projection query fails', async () => {
    await addStoredAccounts('detail-status-account');
    await facade.dispatch({ type: 'lineStart', requestId: 'start-detail-status', accountId: 'detail-status-account' });
    const binding = bindings.get('detail-status-account')!;
    await workerEventHandler?.(binding.workerInstanceId, { type: 'batch', accountId: binding.accountId,
      workerInstanceId: binding.workerInstanceId, controlEpoch: binding.controlEpoch, batchId: 'detail-status-batch',
      cursorBefore: { version: 1, revision: '0', globalRev: '0', individualRev: '0' },
      cursorAfter: { version: 1, revision: '1', globalRev: '1', individualRev: '0' }, envelopes: [{
        eventId: 'detail-status-event', accountId: binding.accountId, chatType: 'group', chatId: 'detail-status-chat',
        senderId: 'detail-status-sender', messageId: 'detail-status-message', kind: 'text', text: 'message detail survives',
        mentionIds: [], mentionRanges: [], replyToMessageId: null,
        ingestion: { source: 'live', cursor: null }, occurredAt: '2026-10-17T00:00:00.000Z', attachments: [{ id: 'detail-status-attachment',
          kind: 'file', name: 'retry.bin', mimeType: 'application/octet-stream', sizeBytes: 1 }], raw: {},
      }] });
    const originalQuery = pool.query.bind(pool);
    const query = vi.spyOn(pool, 'query').mockImplementation(((sql: string, values?: unknown[]) => {
      if (sql.includes('SELECT job_id, source_message_id, status FROM agent_jobs')) return Promise.reject(new Error('Agent projection unavailable'));
      return originalQuery(sql, values as never);
    }) as typeof pool.query);
    try {
      await pool.query("UPDATE attachments SET status='failed', retry_count=3, retry_after='infinity'::timestamptz WHERE account_id=$1 AND message_id='detail-status-message'", [binding.accountId]);
      const page = await facade.listMessages({ accountId: binding.accountId, chatType: 'group', chatId: 'detail-status-chat' }, null, 10);
      expect(page.messages[0]).toMatchObject({ messageId: 'detail-status-message', text: 'message detail survives', agentJobStatus: null,
        attachments: [expect.objectContaining({ canRetryManually: false })] });
    } finally { query.mockRestore(); }
  });

  it('keeps current control unchanged when a new account QR command fails', async () => {
    await addStoredAccounts('account-a');
    await activate('account-a');
    const before = await control();
    qrError = new Error('QR startup failed');

    const result = await facade.dispatch({ type: 'lineAddAccountQr', requestId: 'failed-add' });

    expect(result.ok).toBe(false);
    expect(await control()).toMatchObject({ activeAccountId: 'account-a', epoch: before.epoch });
    expect(bindings.get('account-a')?.mode).toBe('ACTIVE_CONTROL');
    expect((await accountModes()).find((account) => account.account_id !== 'account-a')?.mode).toBe('MONITOR_ONLY');
    expect(commands.some((command) => command.type === 'revokeControl')).toBe(false);
  });

  it('relogs in the active account without granting control again or changing its epoch', async () => {
    await addStoredAccounts('account-a');
    await activate('account-a');
    const before = await control();
    const binding = bindings.get('account-a');
    const startCount = starts.length;

    const result = await facade.dispatch({ type: 'lineLoginQr', requestId: 'relogin-active', accountId: 'account-a' });

    expect(result.ok).toBe(true);
    expect(await control()).toMatchObject({ activeAccountId: 'account-a', epoch: before.epoch });
    expect(bindings.get('account-a')?.workerInstanceId).not.toBe(binding?.workerInstanceId);
    expect(bindings.get('account-a')).toMatchObject({ accountId: 'account-a', mode: 'ACTIVE_CONTROL', controlEpoch: before.epoch });
    expect(starts).toHaveLength(startCount + 1);
    expect(stops).toEqual(['account-a']);
    expect(commands.some((command) => command.type === 'revokeControl')).toBe(false);
  });

  it('rejects control transfer requests without changing the active Agent account', async () => {
    await addStoredAccounts('account-a', 'account-b');
    await activate('account-a');

    const before = await control();
    const result = await facade.dispatch({ type: 'switchControl', requestId: 'handoff-b', accountId: 'account-b', expectedEpoch: before.epoch });

    expect(result).toMatchObject({ ok: false, code: 'CONTROL_SWITCH_DISABLED' });
    expect(await control()).toMatchObject({ activeAccountId: 'account-a', epoch: before.epoch });
    const modes = await accountModes();
    expect(modes.filter((account) => account.mode === 'ACTIVE_CONTROL').map((account) => account.account_id)).toEqual(['account-a']);
    expect(modes.find((account) => account.account_id === 'account-b')?.mode).toBe('MONITOR_ONLY');
  });

  it('keeps the Primary Admin monitor-only when a switch request is forged', async () => {
    await addStoredAccounts('account-a', 'account-b');
    await activate('account-a');
    await facade.dispatch({ type: 'lineStart', requestId: 'start-b-monitor', accountId: 'account-b' });
    const prior = bindings.get('account-b')!;
    secretStore.beginLogin('account-b', prior.workerInstanceId, 'saved-b-attempt');
    expect(await secretStore.saveRotation('account-b', prior.workerInstanceId, 'saved-b-attempt',
      { token: 'saved-b-token', qrCert: null, e2eeStorage: null })).toBe(true);

    const before = await control();
    expect((await facade.dispatch({ type: 'switchControl', requestId: 'switch-b-with-token', accountId: 'account-b',
      expectedEpoch: before.epoch })).ok).toBe(false);
    expect(bindings.get('account-b')?.workerInstanceId).toBe(prior.workerInstanceId);
    expect(bindings.get('account-b')?.mode).toBe('MONITOR_ONLY');
    expect(commands.some((command) => command.type === 'loginToken' && command.accountId === 'account-b')).toBe(false);
  });

  it('does not replace the Agent worker to force a control transfer', async () => {
    await addStoredAccounts('account-a', 'account-b');
    await activate('account-a');
    await facade.dispatch({ type: 'lineStart', requestId: 'start-b-monitor', accountId: 'account-b' });
    const oldActive = bindings.get('account-a')!;

    const before = await control();
    expect((await facade.dispatch({ type: 'switchControl', requestId: 'force-monitor-a-switch-b', accountId: 'account-b',
      expectedEpoch: before.epoch })).ok).toBe(false);
    expect(bindings.get('account-a')?.workerInstanceId).toBe(oldActive.workerInstanceId);
    expect(bindings.get('account-a')?.mode).toBe('ACTIVE_CONTROL');
  });

  it('rejects an additional QR account after both fixed role slots are occupied', async () => {
    await addStoredAccounts('account-a', 'account-b');
    await activate('account-a');
    const startCount = starts.length;
    const result = await facade.dispatch({ type: 'lineAddAccountQr', requestId: 'third-account' });
    expect(result).toMatchObject({ ok: false, code: 'SERVICE_ERROR' });
    expect(starts).toHaveLength(startCount);
    expect((await pool.query('SELECT count(*) FROM line_accounts')).rows[0].count).toBe('2');
  });

  it('does not publish a status update from a worker replaced for the same account', async () => {
    await addStoredAccounts('account-a');
    await facade.dispatch({ type: 'lineStart', requestId: 'start-a', accountId: 'account-a' });
    const old = bindings.get('account-a')!;
    const replacement = { ...old, workerInstanceId: 'replacement-worker' };
    await workerBindingHandler?.(replacement, new AbortController().signal);
    published = [];

    await workerEventHandler?.(old.workerInstanceId, { type: 'status', accountId: old.accountId,
      workerInstanceId: old.workerInstanceId, controlEpoch: old.controlEpoch, state: 'ready', message: null });
    await workerEventHandler?.(old.workerInstanceId, { type: 'error', accountId: old.accountId,
      workerInstanceId: old.workerInstanceId, controlEpoch: old.controlEpoch,
      code: 'INVALID_COMMAND', message: 'stale event', retryable: false });

    expect(published.some((event) => event.type === 'lineLoginState' && event.accountId === 'account-a')).toBe(false);
    expect(auditEvents.some((event) => event.action === 'worker_operation_error')).toBe(false);
  });

  it('attributes generic worker callback failures without exposing error text', async () => {
    await addStoredAccounts('diagnostic-account');
    expect(await facade.dispatch({ type: 'lineStart', requestId: 'diagnostic-start', accountId: 'diagnostic-account' }))
      .toMatchObject({ ok: true });
    const binding = bindings.get('diagnostic-account')!;
    const failure = new Error('private message and token=secret-value');
    vi.spyOn(workers, 'binding').mockRejectedValueOnce(failure);

    await expect(workerEventHandler!(binding.workerInstanceId, { type: 'status', ...binding, state: 'ready', message: null }))
      .rejects.toBe(failure);
    await waitForState(() => expect(auditEvents.some((event) => event.action === 'runtime_error'
      && event.diagnostic?.operation === 'line_ingest')).toBe(true));

    const event = auditEvents.find((item) => item.action === 'runtime_error' && item.diagnostic?.operation === 'line_ingest');
    expect(event).toMatchObject({ accountId: binding.accountId, workerInstanceId: binding.workerInstanceId,
      diagnostic: { operation: 'line_ingest', stage: 'execute', category: 'unknown' } });
    expect(JSON.stringify(event)).not.toContain('private message');
    expect(JSON.stringify(event)).not.toContain('secret-value');
  });

  it('does not turn a generic worker operation error into degraded account status', async () => {
    await addStoredAccounts('account-a');
    await facade.dispatch({ type: 'lineStart', requestId: 'start-a', accountId: 'account-a' });
    const binding = bindings.get('account-a')!;
    await workerEventHandler?.(binding.workerInstanceId, { type: 'login', ...binding,
      loginAttemptId: 'operation-error-login', ownMid: 'mid-a', displayName: 'Agent' });
    await workerEventHandler?.(binding.workerInstanceId, { type: 'status', ...binding, state: 'ready', message: null });
    published = [];

    await workerEventHandler?.(binding.workerInstanceId, { type: 'error', ...binding,
      code: 'INVALID_COMMAND', message: 'Invalid command', retryable: false });
    await workerEventHandler?.(binding.workerInstanceId, { type: 'error', ...binding,
      code: 'QUEUE_FULL', message: 'Worker capability is busy', retryable: true });
    await workerEventHandler?.(binding.workerInstanceId, { type: 'error', ...binding,
      code: 'HISTORY_READ_FAILED', message: 'The LINE chat history could not be read.', retryable: false });
    await workerEventHandler?.(binding.workerInstanceId, ({ type: 'error', ...binding,
      code: 'SENSITIVE_UNRECOGNIZED_CODE', message: 'private provider payload', retryable: false } as unknown as LineWorkerEvent));
    await workerEventHandler?.(binding.workerInstanceId, { type: 'catalogRefreshStatus', ...binding,
      state: 'degraded', code: 'CATALOG_REFRESH_FAILED' });
    await workerEventHandler?.(binding.workerInstanceId, { type: 'catalogRefreshStatus', ...binding,
      state: 'ready', code: 'CATALOG_REFRESH_RECOVERED' });
    await audit.flush();

    expect(published.some((event) => event.type === 'lineLoginState')).toBe(false);
    await waitForState(async () => expect((await pool.query(
      "SELECT status FROM line_accounts WHERE account_id='account-a'")).rows[0].status).toBe('connected'));
    expect((await pool.query("SELECT status FROM line_accounts WHERE account_id='account-a'")).rows[0].status).toBe('connected');
    expect(auditEvents.filter((event) => event.action === 'worker_operation_error').map((event) => event.errorCode))
      .toEqual(['INVALID_COMMAND', 'QUEUE_FULL', 'HISTORY_READ_FAILED', 'WORKER_OPERATION_FAILED']);
    expect(auditEvents.filter((event) => event.action === 'line_catalog_refresh').map((event) => [event.errorCode, event.resultCode]))
      .toEqual([['CATALOG_REFRESH_FAILED', undefined], [undefined, 'catalog_refresh_recovered']]);
    expect(JSON.stringify(auditEvents)).not.toContain('private provider payload');

    vi.spyOn(audit, 'observed').mockImplementation(() => { throw new Error('audit sink unavailable'); });
    await workerEventHandler?.(binding.workerInstanceId, { type: 'error', ...binding,
      code: 'QUEUE_FULL', message: 'diagnostic sink failure must be harmless', retryable: true });
    expect((await pool.query("SELECT status FROM line_accounts WHERE account_id='account-a'")).rows[0].status).toBe('connected');
  });
  describe('binding the primary admin from the official LINE (External Monitor)', () => {
    const MID = `u${'1'.repeat(32)}`;
    const OTHER_MID = `u${'2'.repeat(32)}`;
    type Importer = NonNullable<ConnectedFacadeOptions['officialSnapshotImporter']>;
    function importer(identity: () => Awaited<ReturnType<NonNullable<Importer['readOfficialIdentity']>>>, snapshotMids: string[] = []): Importer {
      return {
        async readOfficialIdentity() { return identity(); },
        async readOfficialSnapshot(input) {
          snapshotMids.push(input.expectedMid);
          await input.onReady({ sourceIdentityDigest: 'a'.repeat(64), snapshotDigest: 'b'.repeat(64), schemaVersion: 'line-schema-v1',
            highWatermark: null, eligibleCount: '0' });
          return { sourceIdentityDigest: 'a'.repeat(64), snapshotDigest: 'b'.repeat(64), pageCount: 0, rowCount: 0, highWatermark: null };
        },
      };
    }
    const supported = (mid = MID, displayName: string | null = '王小明', candidateCount = 1) =>
      ({ status: 'supported', mid, displayName, candidateCount }) as const;
    async function addAgentOnly() {
      await pool.query("INSERT INTO line_accounts(account_id,display_name,own_mid,product_role) VALUES ('bind-agent','bind-agent','own-bind-agent','AGENT')");
    }
    async function bindingRows() {
      return {
        admins: (await pool.query('SELECT account_id,chat_id,user_id FROM account_administrators')).rows,
        slots: (await pool.query("SELECT account_id,own_mid,display_name,connection_mode,status FROM line_accounts WHERE product_role='PRIMARY_ADMIN'")).rows,
        audits: (await pool.query("SELECT actor,details FROM audit_logs WHERE action='primary_admin_bound_external_monitor'")).rows,
      };
    }

    it('publishes one externalAdminBindingProgress event per reading phase, in order, during the preview', async () => {
      await addAgentOnly();
      const phases: Array<'locating' | 'reading_identity'> = ['locating', 'reading_identity'];
      await restartFacadeWithImporter({ ...importer(() => supported()),
        async readOfficialIdentity(input) { for (const phase of phases) input.onPhase?.(phase); return supported(); } });
      published.length = 0;
      const result = await facade.dispatch({ type: 'previewExternalAdminBinding', requestId: 'bind-phases' });
      expect(result).toMatchObject({ ok: true, type: 'previewExternalAdminBinding' });
      expect(published.filter((event) => event.type === 'externalAdminBindingProgress')).toEqual([
        { type: 'externalAdminBindingProgress', phase: 'locating' },
        { type: 'externalAdminBindingProgress', phase: 'reading_identity' }]);
    });

    it('previews the active official identity without changing anything (cancel path)', async () => {
      await addAgentOnly();
      await restartFacadeWithImporter(importer(() => supported(MID, '王小明', 2)));
      expect(await facade.dispatch({ type: 'previewExternalAdminBinding', requestId: 'bind-preview' })).toEqual({
        type: 'previewExternalAdminBinding', requestId: 'bind-preview', ok: true, identity: { mid: MID, displayName: '王小明' }, otherCandidates: 1 });
      expect(await bindingRows()).toEqual({ admins: [], slots: [], audits: [] });
    });

    it('binds the admin (chat_id = user_id = MID), creates the slot, audits a masked MID and starts External Monitor', async () => {
      // Row 13: fresh DB, an Agent but no admin row and no admin slot, and no prior QR login of any admin.
      await addAgentOnly();
      expect(await bindingRows()).toEqual({ admins: [], slots: [], audits: [] });
      const snapshotMids: string[] = [];
      await restartFacadeWithImporter(importer(() => supported(), snapshotMids));
      expect(await facade.dispatch({ type: 'previewExternalAdminBinding', requestId: 'bind-first-preview' }))
        .toMatchObject({ ok: true, identity: { mid: MID } });
      expect(await facade.dispatch({ type: 'startExternalMonitorAsAdmin', requestId: 'bind-start', mid: MID }))
        .toEqual({ type: 'startExternalMonitorAsAdmin', requestId: 'bind-start', ok: true, bound: true, started: true, message: null });
      const rows = await bindingRows();
      expect(rows.admins).toEqual([{ account_id: 'bind-agent', chat_id: MID, user_id: MID }]);
      expect(rows.slots).toHaveLength(1);
      expect(rows.slots[0]).toMatchObject({ own_mid: MID, display_name: '王小明', connection_mode: 'EXTERNAL_MONITOR' });
      expect(rows.audits).toHaveLength(1);
      expect(rows.audits[0]).toMatchObject({ actor: 'user', details: { phase: 'succeeded', masked_mid: `${MID.slice(0, 5)}…${MID.slice(-4)}`, account_id: rows.slots[0].account_id } });
      expect(JSON.stringify(rows.audits)).not.toContain(MID);
      await vi.waitFor(() => expect(snapshotMids).toEqual([MID]));
    });

    it('persists the official identity picture when binding the admin', async () => {
      await addAgentOnly();
      await restartFacadeWithImporter(importer(() => ({ ...supported(), picturePath: '/path' })));
      expect(await facade.dispatch({ type: 'previewExternalAdminBinding', requestId: 'bind-picture-preview' }))
        .toMatchObject({ ok: true, identity: { picturePath: '/path' } });
      await facade.dispatch({ type: 'startExternalMonitorAsAdmin', requestId: 'bind-picture-start', mid: MID });
      await vi.waitFor(async () => {
        const rows = await pool.query("SELECT picture_path FROM line_accounts WHERE product_role='PRIMARY_ADMIN'");
        expect(rows.rows).toEqual([{ picture_path: 'https://profile.line-scdn.net/path' }]);
      });
    });

    it('sends no friend relation check or add after worker login, ready and external admin binding', async () => {
      await addAgentOnly();
      await new AdminRepository(pool).bindPrimary('bind-agent', MID, MID);
      await pool.query("UPDATE line_accounts SET own_mid='own-bind-agent', status='connected' WHERE account_id='bind-agent'");
      await restartFacadeWithImporter(importer(() => supported()));
      expect((await new AccountRepository(pool).activateControl('bind-agent', 1)).activated).toBe(true);
      expect((await facade.dispatch({ type: 'lineStart', requestId: 'bind-agent-no-relation', accountId: 'bind-agent' })).ok).toBe(true);
      const startedBinding = bindings.get('bind-agent')!;
      const readyBinding = { ...startedBinding, transportOwnerId: 'test-owner', transportGeneration: 1, writeGrantVersion: 1 };
      bindings.set('bind-agent', readyBinding);
      await workerBindingHandler?.(readyBinding, new AbortController().signal);
      await signalLoggedInReady('bind-agent');
      await new Promise((resolve) => setTimeout(resolve, 300));
      expect(friendRelationCommands).toEqual([]);
      expect(friendAddCommands).toEqual([]);
      expect(friendRemoteCalls).toBe(0);
      await facade.shutdown();
    });

    it('refuses when the primary admin is already bound and leaves existing flows alone', async () => {
      await addStoredAccounts('bind-agent', 'bind-admin');
      await restartFacadeWithImporter(importer(() => supported()));
      for (const request of [{ type: 'previewExternalAdminBinding' }, { type: 'startExternalMonitorAsAdmin', mid: MID }] as const) {
        expect(await facade.dispatch({ ...request, requestId: `bound-${request.type}` } as never)).toMatchObject({ ok: false, code: 'PRIMARY_ADMIN_ALREADY_BOUND' });
      }
      expect((await bindingRows()).admins).toHaveLength(1);
      expect((await bindingRows()).audits).toEqual([]);
    });

    // ---- No Agent account (design §3c) ----
    const AGENT_LOGIN_MID = `u${'3'.repeat(32)}`;
    async function addUnloggedAgent() {
      await pool.query(`INSERT INTO line_accounts(account_id,display_name,product_role,worker_instance_id,worker_binding_epoch)
        VALUES ('late-agent','late-agent','AGENT','late-worker',0)`);
    }
    const agentLogin = (mid: string) => new AccountRepository(pool).applyWorkerLogin(
      { accountId: 'late-agent', workerInstanceId: 'late-worker', controlEpoch: 0 } as never, mid, 'Late Agent');
    async function initialImportComplete(accountId: string) {
      await vi.waitFor(async () => {
        const rows = await pool.query(`SELECT 1 FROM external_source_checkpoints WHERE account_id=$1 AND initial_import_complete`, [accountId]);
        expect(rows.rowCount).toBe(1);
      }, 8000);
    }

    it('A1: with no Agent and no slot, start creates the slot without a binding row and the import runs to completion', async () => {
      const snapshotMids: string[] = [];
      await restartFacadeWithImporter(importer(() => supported(), snapshotMids));
      expect(await facade.dispatch({ type: 'previewExternalAdminBinding', requestId: 'noagent-preview' }))
        .toMatchObject({ ok: true, identity: { mid: MID } });
      expect(await facade.dispatch({ type: 'startExternalMonitorAsAdmin', requestId: 'noagent-start', mid: MID }))
        .toMatchObject({ ok: true, bound: true, started: true });
      const rows = await bindingRows();
      expect(rows.admins).toEqual([]);
      expect(rows.slots).toHaveLength(1);
      expect(rows.slots[0]).toMatchObject({ own_mid: MID, connection_mode: 'EXTERNAL_MONITOR' });
      expect(rows.audits).toHaveLength(1);
      await vi.waitFor(() => expect(snapshotMids).toEqual([MID]));
      await initialImportComplete(rows.slots[0].account_id);
      const source = await pool.query('SELECT admin_binding_account_id FROM line_account_sources WHERE account_id=$1', [rows.slots[0].account_id]);
      expect(source.rows).toEqual([{ admin_binding_account_id: null }]);
    });

    it('A2: once the slot holds the identity the action is refused and concurrent starts bind once', async () => {
      await restartFacadeWithImporter(importer(() => supported()));
      const results = await Promise.all([1, 2].map((index) =>
        facade.dispatch({ type: 'startExternalMonitorAsAdmin', requestId: `noagent-race-${index}`, mid: MID })));
      expect(results.filter((result) => result.ok)).toHaveLength(1);
      expect((await bindingRows()).slots).toHaveLength(1);
      await vi.waitFor(async () => expect((await pool.query("SELECT status FROM line_accounts WHERE product_role='PRIMARY_ADMIN'")).rows).toHaveLength(1));
      for (const request of [{ type: 'previewExternalAdminBinding' }, { type: 'startExternalMonitorAsAdmin', mid: MID }] as const) {
        expect(await facade.dispatch({ ...request, requestId: `noagent-again-${request.type}` } as never))
          .toMatchObject({ ok: false, code: expect.stringMatching(/^(PRIMARY_ADMIN_ALREADY_BOUND|EXTERNAL_IMPORT_BUSY)$/) });
      }
    });

    it('A3: official LINE on another account than the slot stops with official_account_not_active', async () => {
      const wrongAccount: Importer = {
        async readOfficialIdentity() { return supported(); },
        async readOfficialSnapshot() { throw new Error('reader_source_unsupported:official_account_not_active'); },
      };
      await restartFacadeWithImporter(wrongAccount);
      expect(await facade.dispatch({ type: 'startExternalMonitorAsAdmin', requestId: 'noagent-wrong', mid: MID })).toMatchObject({ ok: true, bound: true });
      await vi.waitFor(async () => {
        const snapshot = await facade.dispatch({ type: 'getSnapshot', requestId: 'noagent-wrong-snapshot' });
        const account = snapshot.ok && snapshot.type === 'getSnapshot' ? snapshot.snapshot.accounts.find((item) => item.productRole === 'PRIMARY_ADMIN') : undefined;
        expect(account?.externalImportProgress).toMatchObject({ stage: 'failed', message: expect.stringContaining('official_account_not_active') });
      }, 8000);
    });

    it('A4: an Agent logging in later with another MID is bound to the slot MID, audited, and adopts the source', async () => {
      await restartFacadeWithImporter(importer(() => supported()));
      await facade.dispatch({ type: 'startExternalMonitorAsAdmin', requestId: 'noagent-before-agent', mid: MID });
      const slotId = (await bindingRows()).slots[0].account_id;
      await initialImportComplete(slotId);
      await addUnloggedAgent();
      expect(await agentLogin(AGENT_LOGIN_MID)).toBe(true);
      const rows = await bindingRows();
      expect(rows.admins).toEqual([{ account_id: 'late-agent', chat_id: MID, user_id: MID }]);
      expect(rows.audits).toHaveLength(2);
      expect(JSON.stringify(rows.audits)).not.toContain(MID);
      const source = await pool.query('SELECT admin_binding_account_id,admin_binding_mid,admin_binding_version FROM line_account_sources WHERE account_id=$1', [slotId]);
      expect(source.rows).toEqual([{ admin_binding_account_id: 'late-agent', admin_binding_mid: MID, admin_binding_version: '1' }]);
      expect((await pool.query("SELECT own_mid FROM line_accounts WHERE account_id='late-agent'")).rows).toEqual([{ own_mid: AGENT_LOGIN_MID }]);
      // After the bind the binding is the single authority: the next batch fence passes with the adopted source.
      const capability = await new AccountRepository(pool).resolveCapabilities(slotId);
      await expect(new ExternalMonitorRepository(pool).readBatchFence({ accountId: slotId, sourceId: capability!.selectedSourceId!,
        generation: capability!.selectedSourceGeneration! })).resolves.toBeTruthy();
    });

    it('A5: an Agent logging in with the slot MID is rejected and leaves the slot and bindings untouched', async () => {
      await restartFacadeWithImporter(importer(() => supported()));
      await facade.dispatch({ type: 'startExternalMonitorAsAdmin', requestId: 'noagent-same-mid', mid: MID });
      await addUnloggedAgent();
      expect(await agentLogin(MID)).toBe(false);
      expect((await pool.query("SELECT own_mid FROM line_accounts WHERE account_id='late-agent'")).rows).toEqual([{ own_mid: null }]);
      const rows = await bindingRows();
      expect(rows.admins).toEqual([]);
      expect(rows.slots).toHaveLength(1);
      expect(rows.slots[0]).toMatchObject({ own_mid: MID });
    });

    it('fails closed when a binding-less source no longer matches the slot identity', async () => {
      await restartFacadeWithImporter(importer(() => supported()));
      await facade.dispatch({ type: 'startExternalMonitorAsAdmin', requestId: 'noagent-mismatch', mid: MID });
      const slotId = (await bindingRows()).slots[0].account_id;
      await initialImportComplete(slotId);
      const capability = await new AccountRepository(pool).resolveCapabilities(slotId);
      const fence = { accountId: slotId, sourceId: capability!.selectedSourceId!, generation: capability!.selectedSourceGeneration! };
      await expect(new ExternalMonitorRepository(pool).readBatchFence(fence)).resolves.toBeTruthy();
      await pool.query('UPDATE line_accounts SET own_mid=$2 WHERE account_id=$1', [slotId, OTHER_MID]);
      await expect(new ExternalMonitorRepository(pool).readBatchFence(fence)).rejects.toThrow('External source authority is stale');
    });

    it('A7: an admin start racing an Agent login ends with exactly one binding and one slot', async () => {
      await addUnloggedAgent();
      const repository = new AccountRepository(pool);
      const [started, loggedIn] = await Promise.all([
        repository.bindPrimaryAdminFromExternalMonitor({ mid: MID, correlationId: 'race-bind' }), agentLogin(AGENT_LOGIN_MID)]);
      expect(loggedIn).toBe(true);
      expect(started.ok).toBe(true);
      const rows = await bindingRows();
      expect(rows.admins).toEqual([{ account_id: 'late-agent', chat_id: MID, user_id: MID }]);
      expect(rows.slots).toHaveLength(1);
    });

    it('rejects a confirmation whose MID no longer matches the fresh native read', async () => {
      await addAgentOnly();
      await restartFacadeWithImporter(importer(() => supported(OTHER_MID)));
      expect(await facade.dispatch({ type: 'startExternalMonitorAsAdmin', requestId: 'changed', mid: MID }))
        .toMatchObject({ ok: false, code: 'OFFICIAL_IDENTITY_CHANGED' });
      expect(await bindingRows()).toEqual({ admins: [], slots: [], audits: [] });
    });

    it('reports an unavailable official identity with the safe reader code', async () => {
      await addAgentOnly();
      await restartFacadeWithImporter(importer(() => ({ status: 'unsupported', errorCode: 'candidate_missing' })));
      expect(await facade.dispatch({ type: 'previewExternalAdminBinding', requestId: 'unavailable' }))
        .toMatchObject({ ok: false, code: 'OFFICIAL_IDENTITY_UNAVAILABLE', message: expect.stringContaining('candidate_missing') });
      expect(await bindingRows()).toEqual({ admins: [], slots: [], audits: [] });
    });

    it('exposes the bare machine code and logs it without the MID when the reader is unsupported', async () => {
      await addAgentOnly();
      await restartFacadeWithImporter(importer(() => ({ status: 'unsupported', errorCode: 'key_unavailable' })));
      const warning = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
      try {
        expect(await facade.dispatch({ type: 'previewExternalAdminBinding', requestId: 'code-visible' }))
          .toMatchObject({ ok: false, code: 'OFFICIAL_IDENTITY_UNAVAILABLE', message: 'key_unavailable' });
        expect(warning).toHaveBeenCalledWith('[external-admin-binding] official identity read unsupported:', 'key_unavailable');
        expect(JSON.stringify(warning.mock.calls)).not.toContain(MID);
      } finally { warning.mockRestore(); }
    });

    it.each([
      ['unsupported_build', () => ({ status: 'unsupported', errorCode: 'unsupported_build' }) as const],
      ['process_missing', () => { throw new Error('reader_source_unsupported:process_missing'); }],
      ['process_missing', () => { throw new Error('process_missing'); }],
      ['reader_failed', () => { throw new Error(`some random text with spaces ${MID} C:\\Users\\x\\LINE`); }],
      ['reader_failed', () => { throw new Error('x'.repeat(200)); }],
      ['reader_failed', () => { throw 'not an error'; }],
    ])('yields only the safe code %s for preview and confirm, never raw text or the MID', async (expected, identity) => {
      await addAgentOnly();
      await restartFacadeWithImporter(importer(identity as never));
      const warning = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
      try {
        for (const request of [{ type: 'previewExternalAdminBinding', requestId: 'code-p' } as const,
          { type: 'startExternalMonitorAsAdmin', requestId: 'code-c', mid: MID } as const]) {
          const result = await facade.dispatch(request);
          expect(result).toMatchObject({ ok: false, code: 'OFFICIAL_IDENTITY_UNAVAILABLE', message: expected, retryable: true });
          expect(IpcResultSchema.safeParse(result).success).toBe(true);
          expect(JSON.stringify(result)).not.toContain(MID);
          expect(JSON.stringify(result)).not.toContain('random text');
        }
      } finally { warning.mockRestore(); }
    });

    it('audits a thrown native-reader failure once with its request ID and without exception text', async () => {
      await addAgentOnly();
      await restartFacadeWithImporter(importer(() => { throw new Error('private reader failure token=secret'); }));
      const result = await facade.dispatch({ type: 'previewExternalAdminBinding', requestId: 'native-reader-diagnostic' });
      expect(result).toMatchObject({ ok: false, code: 'OFFICIAL_IDENTITY_UNAVAILABLE', message: 'reader_failed' });

      const readerEvents = auditEvents.filter((event) => event.action === 'runtime_error'
        && event.diagnostic?.operation === 'native_reader' && event.diagnostic?.stage === 'read');
      expect(readerEvents).toHaveLength(1);
      expect(readerEvents[0]).toMatchObject({ requestId: 'native-reader-diagnostic',
        diagnostic: { operation: 'native_reader', stage: 'read', category: 'unknown' } });
      expect(JSON.stringify(readerEvents)).not.toContain('private reader failure');
      expect(JSON.stringify(readerEvents)).not.toContain('secret');
    });

    it('yields identity_invalid for a malformed MID and reader_missing without a reader', async () => {
      await addAgentOnly();
      await restartFacadeWithImporter(importer(() => supported('not-a-mid')));
      expect(await facade.dispatch({ type: 'previewExternalAdminBinding', requestId: 'bad-mid' }))
        .toMatchObject({ ok: false, code: 'OFFICIAL_IDENTITY_UNAVAILABLE', message: 'identity_invalid' });
      await restartFacadeWithImporter({ async readOfficialSnapshot() { throw new Error('unused'); } });
      const missing = await facade.dispatch({ type: 'previewExternalAdminBinding', requestId: 'no-reader' });
      expect(missing).toMatchObject({ ok: false, code: 'OFFICIAL_IDENTITY_UNAVAILABLE', message: 'reader_missing' });
      expect(IpcResultSchema.safeParse(missing).success).toBe(true);
    });

    it('binds exactly once when two confirmations race', async () => {
      await addAgentOnly();
      await restartFacadeWithImporter(importer(() => supported()));
      const results = await Promise.all([1, 2].map((index) =>
        facade.dispatch({ type: 'startExternalMonitorAsAdmin', requestId: `race-${index}`, mid: MID })));
      expect(results.filter((result) => result.ok)).toHaveLength(1);
      expect(results.find((result) => !result.ok)).toMatchObject({ code: expect.stringMatching(/^(EXTERNAL_IMPORT_BUSY|PRIMARY_ADMIN_ALREADY_BOUND)$/) });
      const rows = await bindingRows();
      expect(rows.admins).toHaveLength(1);
      expect(rows.slots).toHaveLength(1);
      expect(rows.audits).toHaveLength(1);
    });

    it('serializes the repository transaction: concurrent binds create one admin and one slot', async () => {
      await addAgentOnly();
      const accountsRepository = new AccountRepository(pool);
      const results = await Promise.all([1, 2, 3].map((index) =>
        accountsRepository.bindPrimaryAdminFromExternalMonitor({ mid: MID, correlationId: `repo-${index}` })));
      expect(results.filter((result) => result.ok)).toHaveLength(1);
      expect(results.filter((result) => !result.ok)).toEqual([
        { ok: false, code: 'PRIMARY_ADMIN_ALREADY_BOUND' }, { ok: false, code: 'PRIMARY_ADMIN_ALREADY_BOUND' }]);
      expect((await bindingRows()).slots).toHaveLength(1);
    });

    it('rejects a slot that already belongs to another account and an official account equal to the Agent', async () => {
      await addAgentOnly();
      await pool.query("INSERT INTO line_accounts(account_id,display_name,own_mid,product_role) VALUES ('bind-other-admin','x',$1,'PRIMARY_ADMIN')", [OTHER_MID]);
      const accountsRepository = new AccountRepository(pool);
      expect(await accountsRepository.bindPrimaryAdminFromExternalMonitor({ mid: MID, correlationId: 'slot-conflict' }))
        .toEqual({ ok: false, code: 'ADMIN_SLOT_CONFLICT' });
      await pool.query("DELETE FROM line_accounts WHERE account_id='bind-other-admin'");
      await pool.query("UPDATE line_accounts SET own_mid=$1 WHERE account_id='bind-agent'", [MID]);
      expect(await accountsRepository.bindPrimaryAdminFromExternalMonitor({ mid: MID, correlationId: 'agent-same' }))
        .toEqual({ ok: false, code: 'ADMIN_SLOT_CONFLICT' });
      expect(await bindingRows()).toEqual({ admins: [], slots: [], audits: [] });
    });

    it('keeps the binding and reports started:false when External Monitor cannot start', async () => {
      await addAgentOnly();
      await restartFacadeWithImporter(importer(() => supported()));
      vi.spyOn(workers, 'binding').mockImplementation(async (accountId) => accountId === 'bind-agent' ? null : ({ accountId } as never));
      const result = await facade.dispatch({ type: 'startExternalMonitorAsAdmin', requestId: 'start-fails', mid: MID });
      expect(result).toMatchObject({ ok: true, bound: true, started: false, message: expect.stringContaining('External history import requires') });
      const rows = await bindingRows();
      expect(rows.admins).toHaveLength(1);
      expect(rows.slots).toHaveLength(1);
    });
  });

  it('fails closed with the reader code when a resumed monitor finds another source identity, leaving source and binding unchanged', async () => {
    await addStoredAccounts('mismatch-agent', 'mismatch-admin');
    const ready = { sourceIdentityDigest: '7'.repeat(64), snapshotDigest: '8'.repeat(64), schemaVersion: 'line-schema-v1',
      highWatermark: null, eligibleCount: '0' };
    const first: NonNullable<ConnectedFacadeOptions['officialSnapshotImporter']> = {
      async readOfficialSnapshot(input) {
        await input.onReady(ready);
        return { sourceIdentityDigest: ready.sourceIdentityDigest, snapshotDigest: ready.snapshotDigest, pageCount: 0, rowCount: 0, highWatermark: null };
      },
      async readOfficialMonitor(input) { await new Promise<void>((resolve) => input.signal.addEventListener('abort', () => resolve(), { once: true })); },
    };
    await restartFacadeWithImporter(first);
    expect(await facade.dispatch({ type: 'externalImportStart', requestId: 'mismatch-first', accountId: 'mismatch-admin' })).toMatchObject({ ok: true });
    await vi.waitFor(async () => expect((await pool.query(
      "SELECT 1 FROM external_source_checkpoints WHERE account_id='mismatch-admin' AND initial_import_complete")).rowCount).toBe(1), { timeout: 8000 });
    const state = async () => ({
      sources: (await pool.query("SELECT source_id,generation,state,admin_binding_account_id,admin_binding_mid FROM line_account_sources WHERE account_id='mismatch-admin' ORDER BY generation")).rows,
      account: (await pool.query("SELECT selected_source_id,selected_source_generation,mode_revision,own_mid,connection_mode FROM line_accounts WHERE account_id='mismatch-admin'")).rows,
      admins: (await pool.query('SELECT account_id,chat_id,user_id FROM account_administrators')).rows,
    });
    const before = await state();
    // Restart: the native reader now reports another active database (official LINE on a different account).
    const calls: string[] = [];
    const another: NonNullable<ConnectedFacadeOptions['officialSnapshotImporter']> = {
      async readOfficialSnapshot() { calls.push('snapshot'); throw new Error('no snapshot expected on resume'); },
      async readOfficialMonitor() { calls.push('monitor'); throw new Error('reader_source_identity_changed'); },
    };
    await restartFacadeWithImporter(another);
    await vi.waitFor(async () => {
      const snapshot = await facade.dispatch({ type: 'getSnapshot', requestId: 'mismatch-snapshot' });
      const account = snapshot.ok && snapshot.type === 'getSnapshot' ? snapshot.snapshot.accounts.find((item) => item.accountId === 'mismatch-admin') : undefined;
      expect(account?.externalImportProgress).toMatchObject({ stage: 'failed', message: 'external_monitor_source_changed' });
    }, { timeout: 8000 });
    expect(calls).toEqual(['monitor']); // no retry against another candidate, no new snapshot import
    expect(await state()).toEqual(before);
  });

  it('accepts one current correlated login failure and ignores stale or already closed attempts', async () => {
    await addStoredAccounts('account-a', 'account-b');
    await facade.dispatch({ type: 'lineStart', requestId: 'start-a', accountId: 'account-a' });
    await facade.dispatch({ type: 'lineLoginQr', requestId: 'qr-a', accountId: 'account-a' });
    const binding = bindings.get('account-a')!;
    const attempt = commands.filter((command) => command.type === 'loginQr').at(-1)!.loginAttemptId;
    published = [];
    const failed = { type: 'loginFailure', ...binding, loginAttemptId: attempt, code: 'LOGIN_TIMEOUT',
      message: 'LINE login timed out. Try again.' } as const;

    await workerEventHandler?.(binding.workerInstanceId, { ...failed, loginAttemptId: 'stale-attempt' });
    expect(published).toEqual([]);
    await workerEventHandler?.(binding.workerInstanceId, failed);
    await workerEventHandler?.(binding.workerInstanceId, failed);

    expect(published.filter((event) => event.type === 'lineLoginState')).toEqual([
      { type: 'lineLoginState', accountId: 'account-a', loginAttemptId: attempt,
        state: 'disconnected', message: 'LINE login timed out. Try again.' },
    ]);
    expect((await pool.query("SELECT status FROM line_accounts WHERE account_id='account-a'")).rows[0].status).toBe('disconnected');
    expect((await pool.query("SELECT status FROM line_accounts WHERE account_id='account-b'")).rows[0].status).toBe('disconnected');
  });

  it('allows facade logout followed by Agent replacement without repairing durable worker binding in the test', async () => {
    await addStoredAccounts('replace-after-logout-agent');
    expect(await facade.dispatch({ type: 'lineStart', requestId: 'replace-logout-start', accountId: 'replace-after-logout-agent' }))
      .toMatchObject({ ok: true });
    const initialBinding = bindings.get('replace-after-logout-agent')!;
    expect(await facade.dispatch({ type: 'lineLoginQr', requestId: 'replace-logout-login', accountId: initialBinding.accountId }))
      .toMatchObject({ ok: true });
    const original = bindings.get(initialBinding.accountId)!;
    const attempt = latestLoginAttempt(original.accountId);
    await workerEventHandler?.(original.workerInstanceId, { type: 'secretRotation', ...original, loginAttemptId: attempt,
      secrets: { token: 'old-agent-token', qrCert: 'old-cert', e2eeStorage: null } });
    await workerEventHandler?.(original.workerInstanceId, { type: 'login', ...original, loginAttemptId: attempt,
      ownMid: `own-${original.accountId}`, displayName: 'Original Agent' });
    expect((await pool.query('SELECT worker_instance_id,worker_binding_epoch FROM line_accounts WHERE account_id=$1', [original.accountId])).rows[0])
      .toEqual({ worker_instance_id: original.workerInstanceId, worker_binding_epoch: String(original.controlEpoch) });
    expect(await secretStore.load(original.accountId)).toMatchObject({ token: 'old-agent-token' });

    expect(await facade.dispatch({ type: 'lineLogout', requestId: 'replace-logout', accountId: original.accountId }))
      .toMatchObject({ ok: true });
    expect((await pool.query('SELECT worker_instance_id,worker_binding_epoch FROM line_accounts WHERE account_id=$1', [original.accountId])).rows[0])
      .toEqual({ worker_instance_id: null, worker_binding_epoch: null });
    expect(await secretStore.load(original.accountId)).toBeNull();

    const replaced = await facade.dispatch({ type: 'lineReplaceAgentQr', requestId: 'replace-after-logout', accountId: original.accountId });
    expect(replaced, JSON.stringify(replaced)).toMatchObject({ ok: true });
    expect((await pool.query("SELECT account_id,product_role FROM line_accounts WHERE product_role='AGENT'")).rows)
      .toEqual([{ account_id: expect.not.stringMatching(/^replace-after-logout-agent$/), product_role: 'AGENT' }]);
  });

  it('confirms replacement after a different LINE identity is scanned without relabeling the old account', async () => {
    const oldMid = `u${'4'.repeat(32)}`;
    const scannedMid = `u${'5'.repeat(32)}`;
    await addStoredAccounts('mismatch-replace-agent');
    await pool.query('UPDATE line_accounts SET own_mid=$2 WHERE account_id=$1', ['mismatch-replace-agent', oldMid]);
    expect(await facade.dispatch({ type: 'lineStart', requestId: 'mismatch-replace-start', accountId: 'mismatch-replace-agent' }))
      .toMatchObject({ ok: true });
    expect(await facade.dispatch({ type: 'lineLoginQr', requestId: 'mismatch-replace-qr', accountId: 'mismatch-replace-agent' }))
      .toMatchObject({ ok: true });
    const attempt = latestLoginAttempt('mismatch-replace-agent');
    const mismatchedWorker = bindings.get('mismatch-replace-agent')!;
    await workerEventHandler?.(mismatchedWorker.workerInstanceId, { type: 'login', ...mismatchedWorker,
      loginAttemptId: attempt, ownMid: scannedMid, displayName: 'Different LINE identity' });
    expect(published.some((event) => event.type === 'agentIdentityMismatch' && event.accountId === 'mismatch-replace-agent')).toBe(true);
    expect((await pool.query('SELECT own_mid,product_role FROM line_accounts WHERE account_id=$1', ['mismatch-replace-agent'])).rows)
      .toEqual([{ own_mid: oldMid, product_role: 'AGENT' }]);

    expect(await facade.dispatch({ type: 'lineReplaceAgentQr', requestId: 'mismatch-replace-confirm', accountId: 'mismatch-replace-agent' }))
      .toMatchObject({ ok: true });
    expect((await pool.query('SELECT own_mid,product_role FROM line_accounts WHERE account_id=$1', ['mismatch-replace-agent'])).rows)
      .toEqual([{ own_mid: oldMid, product_role: null }]);
    expect((await pool.query("SELECT own_mid FROM line_accounts WHERE product_role='AGENT'")).rows).toEqual([{ own_mid: null }]);
  });

  it('compare-clears a persisted worker binding after restart when no live worker is registered', async () => {
    await addStoredAccounts('restart-logout-agent');
    expect(await facade.dispatch({ type: 'lineStart', requestId: 'restart-logout-start', accountId: 'restart-logout-agent' }))
      .toMatchObject({ ok: true });
    const staleBinding = bindings.get('restart-logout-agent')!;
    await facade.shutdown(); // The gateway stops its process; the row intentionally retains its durable binding.
    expect(bindings.has('restart-logout-agent')).toBe(false);
    expect((await pool.query('SELECT worker_instance_id FROM line_accounts WHERE account_id=$1', [staleBinding.accountId])).rows[0])
      .toEqual({ worker_instance_id: staleBinding.workerInstanceId });
    await restartFacadeWithImporter({ async readOfficialSnapshot() { throw new Error('unused'); } });

    expect(await facade.dispatch({ type: 'lineLogout', requestId: 'restart-logout', accountId: staleBinding.accountId }))
      .toMatchObject({ ok: true });
    expect((await pool.query('SELECT worker_instance_id,worker_binding_epoch,status FROM line_accounts WHERE account_id=$1', [staleBinding.accountId])).rows[0])
      .toEqual({ worker_instance_id: null, worker_binding_epoch: null, status: 'disconnected' });
  });

  it('clears the stopped account credential before direct replacement and serializes duplicate requests', async () => {
    await addStoredAccounts('direct-replace-agent');
    expect(await facade.dispatch({ type: 'lineStart', requestId: 'direct-replace-start', accountId: 'direct-replace-agent' }))
      .toMatchObject({ ok: true });
    const oldWorker = bindings.get('direct-replace-agent')!;
    secretStore.beginLogin(oldWorker.accountId, oldWorker.workerInstanceId, 'seed-old-credential');
    await expect(secretStore.saveRotation(oldWorker.accountId, oldWorker.workerInstanceId, 'seed-old-credential',
      { token: 'old-saved-token', qrCert: 'old-cert', e2eeStorage: null })).resolves.toBe(true);
    expect(await secretStore.load(oldWorker.accountId)).toMatchObject({ token: 'old-saved-token' });

    const clear = vi.spyOn(secretStore, 'clear').mockRejectedValueOnce(new Error('simulated credential store failure'));
    expect(await facade.dispatch({ type: 'lineReplaceAgentQr', requestId: 'direct-replace-clear-fails', accountId: oldWorker.accountId }))
      .toMatchObject({ ok: false, code: 'AGENT_REPLACEMENT_FAILED' });
    expect((await pool.query('SELECT product_role,own_mid FROM line_accounts WHERE account_id=$1', [oldWorker.accountId])).rows)
      .toEqual([{ product_role: 'AGENT', own_mid: `own-${oldWorker.accountId}` }]);
    expect(await secretStore.load(oldWorker.accountId)).toMatchObject({ token: 'old-saved-token' });
    clear.mockRestore();

    const results = await Promise.all([1, 2].map((index) => facade.dispatch({ type: 'lineReplaceAgentQr',
      requestId: `direct-replace-race-${index}`, accountId: oldWorker.accountId })));
    expect(results.filter((result) => result.ok)).toHaveLength(1);
    expect(results.filter((result) => !result.ok)).toHaveLength(1);
    expect((await pool.query("SELECT count(*) FROM line_accounts WHERE product_role='AGENT'")).rows[0].count).toBe('1');
    expect((await pool.query('SELECT product_role FROM line_accounts WHERE account_id=$1', [oldWorker.accountId])).rows)
      .toEqual([{ product_role: null }]);
    expect(await secretStore.load(oldWorker.accountId)).toBeNull();
    await workerEventHandler?.(oldWorker.workerInstanceId, { type: 'secretRotation', ...oldWorker,
      loginAttemptId: 'seed-old-credential', secrets: { token: 'stale-rotation', qrCert: null, e2eeStorage: null } });
    expect(await secretStore.load(oldWorker.accountId)).toBeNull();
  });

  it('cancels a pending replacement QR, ignores late worker events, retries login, and preserves active Admin monitor authority', async () => {
    const adminMid = `u${'6'.repeat(32)}`;
    const agentMid = `u${'7'.repeat(32)}`;
    await addStoredAccounts('monitor-switch-agent');
    await pool.query('UPDATE line_accounts SET own_mid=$2 WHERE account_id=$1', ['monitor-switch-agent', agentMid]);
    const identity = { status: 'supported' as const, mid: adminMid, displayName: 'Primary Admin', candidateCount: 1 };
    await restartFacadeWithImporter({
      async readOfficialIdentity() { return identity; },
      async readOfficialSnapshot(input) {
        await input.onReady({ sourceIdentityDigest: 'a'.repeat(64), snapshotDigest: 'b'.repeat(64), schemaVersion: 'line-schema-v1',
          highWatermark: null, eligibleCount: '0' });
        return { sourceIdentityDigest: 'a'.repeat(64), snapshotDigest: 'b'.repeat(64), pageCount: 0, rowCount: 0, highWatermark: null };
      },
    });
    expect(await facade.dispatch({ type: 'startExternalMonitorAsAdmin', requestId: 'monitor-switch-start', mid: adminMid }))
      .toMatchObject({ ok: true, bound: true });
    await waitForState(async () => expect((await pool.query(`SELECT 1 FROM external_source_checkpoints c
      JOIN line_accounts a ON a.account_id=c.account_id WHERE a.product_role='PRIMARY_ADMIN' AND c.initial_import_complete`)).rowCount).toBe(1));
    const adminAccountId = (await pool.query("SELECT account_id FROM line_accounts WHERE product_role='PRIMARY_ADMIN'")).rows[0]!.account_id as string;
    const checkpointBefore = (await pool.query(`SELECT source_id,generation,cursor,initial_import_complete
      FROM external_source_checkpoints WHERE account_id=$1`, [adminAccountId])).rows;
    const sourceBefore = (await pool.query(`SELECT source_id,generation,admin_binding_account_id,admin_binding_mid,admin_binding_version,state
      FROM line_account_sources WHERE account_id=$1 AND source_type='EXTERNAL_MONITOR' AND state='ACTIVE'`, [adminAccountId])).rows[0];
    expect(sourceBefore).toMatchObject({ admin_binding_account_id: 'monitor-switch-agent', admin_binding_mid: adminMid });

    expect(await facade.dispatch({ type: 'lineReplaceAgentQr', requestId: 'monitor-switch-replace', accountId: 'monitor-switch-agent' }))
      .toMatchObject({ ok: true });
    const pendingAgentId = (await pool.query("SELECT account_id FROM line_accounts WHERE product_role='AGENT'")).rows[0]!.account_id as string;
    const pendingWorker = bindings.get(pendingAgentId)!;
    const pendingAttempt = latestLoginAttempt(pendingAgentId);
    await workerEventHandler?.(pendingWorker.workerInstanceId, { type: 'secretRotation', ...pendingWorker, loginAttemptId: pendingAttempt,
      secrets: { token: 'pending-token', qrCert: 'pending-cert', e2eeStorage: null } });
    expect(await facade.dispatch({ type: 'lineLogout', requestId: 'monitor-switch-cancel', accountId: pendingAgentId }))
      .toMatchObject({ ok: true });
    for (const event of [
      { type: 'qr', ...pendingWorker, loginAttemptId: pendingAttempt, code: 'late-qr' },
      { type: 'pin', ...pendingWorker, loginAttemptId: pendingAttempt, pin: '123456' },
      { type: 'secretRotation', ...pendingWorker, loginAttemptId: pendingAttempt, secrets: { token: 'late-token', qrCert: null, e2eeStorage: null } },
      { type: 'login', ...pendingWorker, loginAttemptId: pendingAttempt, ownMid: agentMid, displayName: 'Late login' },
    ] as const) await workerEventHandler?.(pendingWorker.workerInstanceId, event as LineWorkerEvent);
    expect((await pool.query('SELECT own_mid,product_role,worker_instance_id,worker_binding_epoch FROM line_accounts WHERE account_id=$1', [pendingAgentId])).rows)
      .toEqual([{ own_mid: null, product_role: 'AGENT', worker_instance_id: null, worker_binding_epoch: null }]);
    expect(await secretStore.load(pendingAgentId)).toBeNull();

    expect(await facade.dispatch({ type: 'lineLoginQr', requestId: 'monitor-switch-retry', accountId: pendingAgentId })).toMatchObject({ ok: true });
    const retryWorker = bindings.get(pendingAgentId)!;
    expect(retryWorker.workerInstanceId).not.toBe(pendingWorker.workerInstanceId);
    const retryAttempt = latestLoginAttempt(pendingAgentId);
    await workerEventHandler?.(retryWorker.workerInstanceId, { type: 'secretRotation', ...retryWorker, loginAttemptId: retryAttempt,
      secrets: { token: 'new-agent-token', qrCert: null, e2eeStorage: null } });
    await workerEventHandler?.(retryWorker.workerInstanceId, { type: 'login', ...retryWorker, loginAttemptId: retryAttempt,
      ownMid: agentMid, displayName: 'New Agent' });

    const sourceAfter = (await pool.query(`SELECT source_id,generation,admin_binding_account_id,admin_binding_mid,admin_binding_version,state
      FROM line_account_sources WHERE account_id=$1 AND source_type='EXTERNAL_MONITOR' AND state='ACTIVE'`, [adminAccountId])).rows[0];
    expect(sourceAfter).toMatchObject({ source_id: sourceBefore.source_id, generation: sourceBefore.generation,
      admin_binding_account_id: pendingAgentId, admin_binding_mid: adminMid, state: 'ACTIVE' });
    expect(sourceAfter.admin_binding_version).not.toBeNull();
    expect((await pool.query(`SELECT source_id,generation,cursor,initial_import_complete
      FROM external_source_checkpoints WHERE account_id=$1`, [adminAccountId])).rows).toEqual(checkpointBefore);
    expect((await pool.query("SELECT account_id,chat_id,user_id FROM account_administrators WHERE role='PRIMARY_ADMIN'")).rows)
      .toEqual([{ account_id: pendingAgentId, chat_id: adminMid, user_id: adminMid }]);
    const capability = await new AccountRepository(pool).resolveCapabilities(adminAccountId);
    await expect(new ExternalMonitorRepository(pool).readBatchFence({ accountId: adminAccountId,
      sourceId: capability!.selectedSourceId!, generation: capability!.selectedSourceGeneration! })).resolves.toBeTruthy();
  });

  describe('CHROMEOS login transport', () => {
    type LtsmStatus = Parameters<NonNullable<ConnectedFacadeOptions['chromeLogin']>['ltsm']['status']> extends [] ? Awaited<ReturnType<NonNullable<ConnectedFacadeOptions['chromeLogin']>['ltsm']['status']>> : never;
    const AVAILABLE: LtsmStatus = { kind: 'available', version: '3.7.2' };
    const desktopSecrets = { token: 'desktop-token', qrCert: 'desktop-cert', e2eeStorage: { key: 'linejs' } };
    const chromeSecrets = { token: 'chrome-token', qrCert: 'chrome-cert', e2eeStorage: { transport: 'CHROMEOS-3.7.2', 'chrome:reqSeq': 3 } };
    let ltsmStatus: LtsmStatus;
    let pickedFolder: string | null;
    let installedFrom: string[];
    let openedUrls: string[];

    beforeEach(async () => {
      ltsmStatus = AVAILABLE;
      pickedFolder = null;
      installedFrom = [];
      openedUrls = [];
      await facade.shutdown();
      facade = await createConnectedFacade({ pool, workers, agent, attachmentRoot: 'C:\\attachments', mediaCacheRoot: join(secretRoot, 'line-media-cache'),
        previewPresenter: { async present() { return false; }, closeAll() {} }, secretStore, audit, runMigrations: false,
        chatResourceStore: archiveStore,
        chromeLogin: {
          ltsm: {
            rootDir: 'C:\\userData\\line-chrome\\ltsm',
            async status() { return ltsmStatus; },
            async detectAndInstall() { return { kind: 'not-found', required: '3.7.2' }; },
            async installFromFolder(folder) { installedFrom.push(folder); return { kind: 'installed', status: { kind: 'available', version: '3.7.2' }, source: { browser: 'manual', profile: '' } }; },
          },
          async chooseFolder() { return pickedFolder; },
          async openStore(url) { openedUrls.push(url); },
        },
        publish(event) { published.push(event); } });
    });

    const storeSecrets = async (accountId: string, transport: 'DESKTOPWIN' | 'CHROMEOS', secrets: typeof desktopSecrets | typeof chromeSecrets) => {
      secretStore.beginLogin(accountId, `seed-${transport}`, `seed-${transport}`, transport);
      expect(await secretStore.saveRotation(accountId, `seed-${transport}`, `seed-${transport}`, secrets)).toBe(true);
      await secretStore.closeLogin(accountId, `seed-${transport}`, `seed-${transport}`);
    };
    // The transport of an account is a marker file in the secret store, not a database value.
    const setTransport = (accountId: string, lineTransport: 'DESKTOPWIN' | 'CHROMEOS') => secretStore.setTransport(accountId, lineTransport);
    const statusOf = async (accountId: string) =>
      (await pool.query<{ status: string }>('SELECT status FROM line_accounts WHERE account_id=$1', [accountId])).rows[0]?.status;
    const secretStates = () => commands.filter((command): command is Extract<LineWorkerCommand, { type: 'setSecretState' }> => command.type === 'setSecretState');

    it('leaves DESKTOPWIN bindings exactly as before and restores only DESKTOPWIN secrets', async () => {
      await addStoredAccounts('d1');
      await storeSecrets('d1', 'DESKTOPWIN', desktopSecrets);
      await storeSecrets('d1', 'CHROMEOS', chromeSecrets);
      // Saving a secret sets the marker. Set the intended start state last: DESKTOPWIN with both stored sessions.
      await setTransport('d1', 'DESKTOPWIN');
      await activate('d1');
      expect(Object.hasOwn(bindings.get('d1')!, 'lineTransport')).toBe(false);
      expect(secretStates().map((command) => command.secrets.token)).toEqual(['desktop-token']);
    });

    it('starts a CHROMEOS account with lineTransport and only its own stored session', async () => {
      await addStoredAccounts('c1');
      await setTransport('c1', 'CHROMEOS');
      await storeSecrets('c1', 'DESKTOPWIN', desktopSecrets);
      await storeSecrets('c1', 'CHROMEOS', chromeSecrets);
      await activate('c1');
      expect(bindings.get('c1')).toMatchObject({ accountId: 'c1', lineTransport: 'CHROMEOS' });
      expect(secretStates().map((command) => command.secrets.token)).toEqual(['chrome-token']);
      const snapshot = await facade.dispatch({ type: 'getSnapshot', requestId: 'snap' });
      expect(snapshot).toMatchObject({ ok: true });
      expect((snapshot as { snapshot: { accounts: Array<{ accountId: string; lineTransport?: string }> } }).snapshot.accounts
        .find((account) => account.accountId === 'c1')?.lineTransport).toBe('CHROMEOS');
    });

    it('does not hand a DESKTOPWIN session to a CHROMEOS worker when only DESKTOPWIN secrets exist', async () => {
      await addStoredAccounts('c1');
      await storeSecrets('c1', 'DESKTOPWIN', desktopSecrets);
      // Set the marker last: CHROMEOS with only a DESKTOPWIN stored session.
      await setTransport('c1', 'CHROMEOS');
      await activate('c1');
      expect(secretStates()).toEqual([]);
      expect(commands.some((command) => command.type === 'loginToken')).toBe(false);
    });

    it.each(['lineStart', 'lineLoginQr'] as const)('fails %s fast with the typed ltsm error and spawns no worker', async (type) => {
      await addStoredAccounts('c1');
      await setTransport('c1', 'CHROMEOS');
      ltsmStatus = { kind: 'wrong-version', required: '3.7.2', detected: ['3.8.0'] };
      const result = await facade.dispatch({ type, requestId: `fast-${type}`, accountId: 'c1' });
      expect(result).toMatchObject({ ok: false, code: 'CHROME_LTSM_UNAVAILABLE', retryable: false,
        chromeLtsmStatus: { kind: 'wrong-version', required: '3.7.2', detected: ['3.8.0'] } });
      expect(IpcResultSchema.safeParse(result).success).toBe(true);
      expect(starts).toEqual([]);
      expect(commands).toEqual([]);
    });

    it('starts the QR login of a new slot with the chosen transport, and reserves no slot when ltsm is unavailable', async () => {
      ltsmStatus = { kind: 'missing', required: '3.7.2' };
      const refused = await facade.dispatch({ type: 'lineAddAccountQr', requestId: 'add-chrome-refused', lineTransport: 'CHROMEOS' });
      expect(refused).toMatchObject({ ok: false, code: 'CHROME_LTSM_UNAVAILABLE', chromeLtsmStatus: { kind: 'missing' } });
      expect((await pool.query('SELECT count(*)::int AS n FROM line_accounts')).rows[0].n).toBe(0);
      expect(starts).toEqual([]);

      ltsmStatus = AVAILABLE;
      const accepted = await facade.dispatch({ type: 'lineAddAccountQr', requestId: 'add-chrome', lineTransport: 'CHROMEOS' });
      expect(accepted.ok, JSON.stringify(accepted)).toBe(true);
      const row = (await pool.query<{ account_id: string }>('SELECT account_id FROM line_accounts')).rows[0]!;
      expect(await secretStore.getTransport(row.account_id)).toBe('CHROMEOS');
      expect(bindings.get(row.account_id)).toMatchObject({ lineTransport: 'CHROMEOS' });
      expect(commands.some((command) => command.type === 'loginQr' && command.accountId === row.account_id)).toBe(true);
    });

    it('a login request without a transport creates a DESKTOPWIN slot', async () => {
      const accepted = await facade.dispatch({ type: 'lineAddAccountQr', requestId: 'add-default' });
      expect(accepted.ok, JSON.stringify(accepted)).toBe(true);
      const row = (await pool.query<{ account_id: string }>('SELECT account_id FROM line_accounts')).rows[0]!;
      expect(await secretStore.getTransport(row.account_id)).toBe('DESKTOPWIN');
      expect(Object.hasOwn(bindings.get(row.account_id)!, 'lineTransport')).toBe(false);
    });

    it('moves an account whose worker reports CHROME_LTSM_UNAVAILABLE to reauth_required without clearing its session', async () => {
      await addStoredAccounts('c1');
      await setTransport('c1', 'CHROMEOS');
      await storeSecrets('c1', 'CHROMEOS', chromeSecrets);
      await activate('c1');
      const binding = bindings.get('c1')!;
      stops.length = 0;
      await workerEventHandler?.(binding.workerInstanceId, { type: 'error', ...binding, code: 'CHROME_LTSM_UNAVAILABLE', message: 'LINE Chrome assets are not installed',
        retryable: false, chromeLtsmStatus: 'missing',
        diagnostic: { operation: 'init', stage: 'bootstrap', category: 'unavailable', recovery: 'check_configuration', outcome: 'failed' } } as LineWorkerEvent);
      await waitForState(async () => expect(await statusOf('c1')).toBe('reauth_required'));
      expect(stops).toEqual(['c1']);
      expect(await secretStore.load('c1', 'CHROMEOS')).toEqual(chromeSecrets);
      expect(auditEvents.some((event) => event.action === 'worker_operation_error' && event.accountId === 'c1')).toBe(true);
      expect(JSON.stringify(auditEvents)).not.toContain('C:\\userData');
    });

    it('serves availability, detection, folder choice and the Web Store through typed IPCs', async () => {
      expect(await facade.dispatch({ type: 'getChromeLoginAvailability', requestId: 'avail' }))
        .toEqual({ type: 'getChromeLoginAvailability', requestId: 'avail', ok: true, status: AVAILABLE });
      expect(await facade.dispatch({ type: 'detectChromeLtsm', requestId: 'detect' }))
        .toEqual({ type: 'detectChromeLtsm', requestId: 'detect', ok: true, result: { kind: 'not-found', required: '3.7.2' } });
      expect(await facade.dispatch({ type: 'chooseChromeLtsmFolder', requestId: 'cancel' }))
        .toEqual({ type: 'chooseChromeLtsmFolder', requestId: 'cancel', ok: true, result: { kind: 'cancelled' } });
      pickedFolder = 'D:\\picked';
      expect(await facade.dispatch({ type: 'chooseChromeLtsmFolder', requestId: 'pick' }))
        .toMatchObject({ ok: true, result: { kind: 'installed' } });
      expect(installedFrom).toEqual(['D:\\picked']);
      expect(await facade.dispatch({ type: 'openChromeExtensionStore', requestId: 'store' })).toEqual({ type: 'openChromeExtensionStore', requestId: 'store', ok: true });
      expect(openedUrls).toEqual(['https://chromewebstore.google.com/detail/ophjlpahpchlmihnnnihgmmeilfjmjjc']);
    });

    describe('login method switch of an existing account', () => {
      const startDesktopAccount = async (accountId: string) => {
        await addStoredAccounts(accountId);
        await storeSecrets(accountId, 'DESKTOPWIN', desktopSecrets);
        await activate(accountId);
        commands.length = 0;
        starts.length = 0;
        stops.length = 0;
      };
      const rotate = async (accountId: string, secrets: typeof chromeSecrets) => {
        const binding = bindings.get(accountId)!;
        const attempt = latestLoginAttempt(accountId);
        await workerEventHandler?.(binding.workerInstanceId, { type: 'secretRotation', ...binding, loginAttemptId: attempt, secrets });
        return { binding, attempt };
      };

      it('starts a CHROMEOS worker without a server logout and keeps the DESKTOPWIN secrets', async () => {
        await startDesktopAccount('s1');
        const result = await facade.dispatch({ type: 'lineLoginQr', requestId: 'switch-chrome', accountId: 's1', lineTransport: 'CHROMEOS' });
        expect(result, JSON.stringify(result)).toMatchObject({ ok: true });
        expect(bindings.get('s1')).toMatchObject({ accountId: 's1', lineTransport: 'CHROMEOS' });
        expect(commands.some((command) => command.type === 'logout')).toBe(false);
        expect(commands.some((command) => command.type === 'loginQr' && command.accountId === 's1')).toBe(true);
        expect(await secretStore.load('s1', 'DESKTOPWIN')).toEqual(desktopSecrets);
        // The marker changes only after the login succeeds.
        expect(await secretStore.getTransport('s1')).toBe('DESKTOPWIN');
      });

      it('returns CHROME_LTSM_UNAVAILABLE and starts no worker when the Chrome files are not usable', async () => {
        await startDesktopAccount('s1');
        ltsmStatus = { kind: 'wrong-version', required: '3.7.2', detected: ['3.8.0'] };
        const result = await facade.dispatch({ type: 'lineLoginQr', requestId: 'switch-refused', accountId: 's1', lineTransport: 'CHROMEOS' });
        expect(result).toMatchObject({ ok: false, code: 'CHROME_LTSM_UNAVAILABLE' });
        expect(starts).toEqual([]);
        expect(commands).toEqual([]);
        expect(await secretStore.getTransport('s1')).toBe('DESKTOPWIN');
      });

      it('makes CHROMEOS the login method of the account after the QR login succeeds', async () => {
        await startDesktopAccount('s1');
        expect(await facade.dispatch({ type: 'lineLoginQr', requestId: 'switch-ok', accountId: 's1', lineTransport: 'CHROMEOS' })).toMatchObject({ ok: true });
        const { binding, attempt } = await rotate('s1', chromeSecrets);
        await workerEventHandler?.(binding.workerInstanceId, { type: 'login', ...binding, loginAttemptId: attempt, ownMid: 'own-s1', displayName: 'Agent' });
        expect(await secretStore.getTransport('s1')).toBe('CHROMEOS');
        expect(await secretStore.load('s1', 'CHROMEOS')).toEqual(chromeSecrets);
        expect(await secretStore.load('s1', 'DESKTOPWIN')).toEqual(desktopSecrets);
        const snapshot = await facade.dispatch({ type: 'getSnapshot', requestId: 'snap-switch' });
        expect((snapshot as { snapshot: { accounts: Array<{ accountId: string; lineTransport?: string }> } }).snapshot.accounts
          .find((account) => account.accountId === 's1')?.lineTransport).toBe('CHROMEOS');
      });

      it('keeps the old method when the QR login fails', async () => {
        await startDesktopAccount('s1');
        expect(await facade.dispatch({ type: 'lineLoginQr', requestId: 'switch-fail', accountId: 's1', lineTransport: 'CHROMEOS' })).toMatchObject({ ok: true });
        const { binding, attempt } = await rotate('s1', chromeSecrets);
        await workerEventHandler?.(binding.workerInstanceId, { type: 'loginFailure', ...binding, loginAttemptId: attempt,
          code: 'LOGIN_TIMEOUT', message: 'LINE login timed out. Try again.' });
        expect(await secretStore.getTransport('s1')).toBe('DESKTOPWIN');
        expect(await secretStore.load('s1', 'CHROMEOS')).toBeNull();
        expect(await secretStore.load('s1', 'DESKTOPWIN')).toEqual(desktopSecrets);
      });

      const failureMessages = { LOGIN_FAILED: 'LINE login failed. Try again.', LOGIN_TIMEOUT: 'LINE login timed out. Try again.',
        LOGIN_ATTEMPT_REPLACED: 'This LINE login attempt was replaced. Try again.' } as const;

      it.each(['LOGIN_FAILED', 'LOGIN_TIMEOUT'] as const)('ends a failed QR relogin (%s) logged out with no worker, no control and unchanged secrets', async (code) => {
        await startDesktopAccount('s1');
        expect(await facade.dispatch({ type: 'lineLoginQr', requestId: `end-${code}`, accountId: 's1', lineTransport: 'CHROMEOS' })).toMatchObject({ ok: true });
        const { binding, attempt } = await rotate('s1', chromeSecrets);
        published = [];
        stops.length = 0;
        const detail = 'qr_login_v2:ChromeApiError:qrCodeLoginV2:8';
        await workerEventHandler?.(binding.workerInstanceId, { type: 'loginFailure', ...binding, loginAttemptId: attempt, code,
          message: failureMessages[code], ...(code === 'LOGIN_FAILED' ? { detail } : {}) } as LineWorkerEvent);

        expect(bindings.has('s1')).toBe(false);
        expect(stops).toContain('s1');
        expect(await statusOf('s1')).toBe('disconnected');
        expect(published.filter((event) => event.type === 'lineLoginState')).toEqual([
          { type: 'lineLoginState', accountId: 's1', loginAttemptId: attempt, state: 'disconnected', message: failureMessages[code] }]);
        expect(await secretStore.getTransport('s1')).toBe('DESKTOPWIN');
        expect(await secretStore.load('s1', 'DESKTOPWIN')).toEqual(desktopSecrets);
        expect(await secretStore.load('s1', 'CHROMEOS')).toBeNull();
        expect(auditEvents.some((event) => event.action === 'secret_clear')).toBe(false);
        const row = auditEvents.find((event) => event.action === 'runtime_error' && event.diagnostic?.reason === code);
        if (code === 'LOGIN_FAILED') expect(row?.diagnostic).toMatchObject({ operation: 'loginQr', stage: 'authenticate', detail });
        else expect(row?.diagnostic).not.toHaveProperty('detail');
      });

      it('keeps the worker and the degraded state when the failed QR attempt was replaced', async () => {
        await startDesktopAccount('s1');
        expect(await facade.dispatch({ type: 'lineLoginQr', requestId: 'end-replaced', accountId: 's1', lineTransport: 'CHROMEOS' })).toMatchObject({ ok: true });
        const { binding, attempt } = await rotate('s1', chromeSecrets);
        published = [];
        await workerEventHandler?.(binding.workerInstanceId, { type: 'loginFailure', ...binding, loginAttemptId: attempt,
          code: 'LOGIN_ATTEMPT_REPLACED', message: failureMessages.LOGIN_ATTEMPT_REPLACED });
        expect(bindings.has('s1')).toBe(true);
        expect(await statusOf('s1')).toBe('degraded');
        expect(published.filter((event) => event.type === 'lineLoginState')).toEqual([
          { type: 'lineLoginState', accountId: 's1', loginAttemptId: attempt, state: 'degraded', message: failureMessages.LOGIN_ATTEMPT_REPLACED }]);
      });

      it('keeps the DESKTOPWIN secrets and the marker when a pending CHROMEOS relogin is cancelled', async () => {
        await startDesktopAccount('s1');
        expect(await facade.dispatch({ type: 'lineLoginQr', requestId: 'cancel-switch', accountId: 's1', lineTransport: 'CHROMEOS' })).toMatchObject({ ok: true });
        await rotate('s1', chromeSecrets);
        auditEvents.length = 0;
        expect(await facade.dispatch({ type: 'lineLogout', requestId: 'cancel-switch-logout', accountId: 's1' })).toMatchObject({ ok: true });
        expect(bindings.has('s1')).toBe(false);
        expect(await secretStore.getTransport('s1')).toBe('DESKTOPWIN');
        expect(await secretStore.load('s1', 'DESKTOPWIN')).toEqual(desktopSecrets);
        expect(auditEvents.some((event) => event.action === 'secret_clear')).toBe(false);
      });

      it('clears only the CHROMEOS secrets when a connected CHROMEOS account logs out', async () => {
        await startDesktopAccount('s1');
        expect(await facade.dispatch({ type: 'lineLoginQr', requestId: 'logout-chrome', accountId: 's1', lineTransport: 'CHROMEOS' })).toMatchObject({ ok: true });
        const { binding, attempt } = await rotate('s1', chromeSecrets);
        await workerEventHandler?.(binding.workerInstanceId, { type: 'login', ...binding, loginAttemptId: attempt, ownMid: 'own-s1', displayName: 'Agent' });
        expect(await secretStore.load('s1', 'CHROMEOS')).toEqual(chromeSecrets);
        auditEvents.length = 0;
        expect(await facade.dispatch({ type: 'lineLogout', requestId: 'logout-chrome-now', accountId: 's1' })).toMatchObject({ ok: true });
        expect(await secretStore.load('s1', 'CHROMEOS')).toBeNull();
        expect(await secretStore.load('s1', 'DESKTOPWIN')).toEqual(desktopSecrets);
        expect(auditEvents.filter((event) => event.action === 'secret_clear').length).toBeGreaterThan(0);
      });

      it('keeps the old method when the scan belongs to a different LINE account', async () => {
        await startDesktopAccount('s1');
        expect(await facade.dispatch({ type: 'lineLoginQr', requestId: 'switch-other', accountId: 's1', lineTransport: 'CHROMEOS' })).toMatchObject({ ok: true });
        const { binding, attempt } = await rotate('s1', chromeSecrets);
        await workerEventHandler?.(binding.workerInstanceId, { type: 'login', ...binding, loginAttemptId: attempt, ownMid: 'other-mid', displayName: 'Other' });
        expect(await secretStore.getTransport('s1')).toBe('DESKTOPWIN');
        expect(await secretStore.load('s1', 'CHROMEOS')).toBeNull();
        expect((await pool.query('SELECT own_mid FROM line_accounts WHERE account_id=$1', ['s1'])).rows).toEqual([{ own_mid: 'own-s1' }]);
      });

      it('keeps the current method when the request has no lineTransport', async () => {
        await startDesktopAccount('s1');
        expect(await facade.dispatch({ type: 'lineLoginQr', requestId: 'same-desktop', accountId: 's1' })).toMatchObject({ ok: true });
        expect(Object.hasOwn(bindings.get('s1')!, 'lineTransport')).toBe(false);
      });

      it('keeps CHROMEOS when the request has no lineTransport', async () => {
        await addStoredAccounts('s3');
        await setTransport('s3', 'CHROMEOS');
        await activate('s3');
        expect(await facade.dispatch({ type: 'lineLoginQr', requestId: 'same-chrome', accountId: 's3' })).toMatchObject({ ok: true });
        expect(bindings.get('s3')).toMatchObject({ lineTransport: 'CHROMEOS' });
      });
    });
  });
});
