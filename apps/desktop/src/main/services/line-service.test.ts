import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Pool } from 'pg';
import { randomBytes } from 'node:crypto';
import { LineWorkerCommandSchema } from '@line-agent/contracts';
import type { InboundEnvelope, LineWorkerCommand, LineWorkerEvent } from '@line-agent/contracts';
import { normalizeOperation } from '../../../../../packages/line-worker/src/normalizer.js';
import { createTestDatabase } from '../../../../../packages/database/src/test-database.js';
import { AccountRepository, AdminRepository, AgentPermissionRepository, FriendWhitelistRepository, MessageRepository, RoomActivationRepository, SettingsRepository } from '../../../../../packages/database/src/index.js';
import { LineService as BaseLineService } from './line-service.js';
import { PermissionCommandService, type PermissionCommandTransport } from './permission-command.js';
import { SecretStore } from './secret-store.js';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { WorkspaceAuthority } from './workspace-authority.js';
import { classifyRoomControl } from './room-control.js';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const database = process.env.TEST_DATABASE_URL ? describe : describe.skip;
const cursor = (revision: string) => ({ version: 1 as const, revision, globalRev: '0', individualRev: '0' });
class LineService extends BaseLineService {
  constructor(accounts: ConstructorParameters<typeof BaseLineService>[0], messages: ConstructorParameters<typeof BaseLineService>[1],
    settings: ConstructorParameters<typeof BaseLineService>[2], worker: ConstructorParameters<typeof BaseLineService>[3],
    agents: ConstructorParameters<typeof BaseLineService>[4], secrets?: ConstructorParameters<typeof BaseLineService>[5],
    attachments?: ConstructorParameters<typeof BaseLineService>[6], onInbound?: ConstructorParameters<typeof BaseLineService>[7],
    admins?: ConstructorParameters<typeof BaseLineService>[8], roomControl?: ConstructorParameters<typeof BaseLineService>[10],
    whitelist?: ConstructorParameters<typeof BaseLineService>[11], locale: ConstructorParameters<typeof BaseLineService>[16] = 'en') {
    super(accounts, messages, settings, worker, agents, secrets, attachments, onInbound, admins,
      { async inspect() { return { status: 'available', version: 0, path: 'C:\\trusted' }; } }, roomControl, whitelist,
      async (envelope) => envelope.chatType === 'direct' && envelope.text === '654321', undefined, undefined, undefined, locale);
  }
}
const batch = (): Extract<LineWorkerEvent, { type: 'batch' }> => ({ type: 'batch', accountId: 'a', workerInstanceId: 'w1', controlEpoch: 1,
  batchId: 'b1', cursorBefore: cursor('0'), cursorAfter: cursor('1'), envelopes: [{ eventId: 'e1', accountId: 'a', chatType: 'direct', chatId: 'c',
    senderId: 'user', messageId: 'm1', kind: 'text', text: 'hello', mentionIds: [], mentionRanges: [], replyToMessageId: null,
    ingestion: { source: 'live', cursor: null }, occurredAt: '2026-10-15T00:00:00.000Z', attachments: [], raw: {} }] });

describe('Agent status reply localization', () => {
  it.each([
    ['en', 'job-1', 'Agent running (job-1)'], ['zh-TW', 'job-1', 'Agent 執行中（job-1）'],
    ['ja', 'job-1', 'Agent 実行中（job-1）'], ['ko', 'job-1', 'Agent 실행 중 (job-1)'],
    ['en', null, 'Agent idle'], ['zh-TW', null, 'Agent 閒置'], ['ja', null, 'Agent 待機中'], ['ko', null, 'Agent 대기 중'],
  ] as const)('formats %s running/idle status while preserving job ID and chat', async (locale, jobId, expected) => {
    const commands: LineWorkerCommand[] = [];
    const binding = { accountId: 'a', workerInstanceId: 'w', controlEpoch: 1, mode: 'ACTIVE_CONTROL' as const };
    const service = new BaseLineService({ async bindWorker() {} } as never,
      { async applyPendingRouteAction(_key: unknown, _messageId: string, _worker: string, apply: (action: string) => Promise<void>) { await apply('status'); } } as never,
      {} as never, { async send(command) { commands.push(command); } },
      { kick() {}, async stopChat() {}, async resetChat() {}, async getChatStatus() { return { runningJobId: jobId }; } },
      undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, locale);
    await service.bind(binding);
    await (service as any).applyPendingAction(binding, { accountId: 'a', chatType: 'direct', chatId: 'chat' }, 'message');
    expect(commands[0]).toMatchObject({ type: 'sendText', chatType: 'direct', chatId: 'chat', replyToMessageId: 'message', text: expected });
    if (jobId) expect(commands[0]?.type === 'sendText' ? commands[0].text : '').toContain(jobId);
  });
});

describe('stop and new acknowledgements', () => {
  it.each([
    ['stop', true, 'zh-TW', '已停止 Agent 工作'], ['stop', false, 'zh-TW', '目前沒有進行中的 Agent 工作'],
    ['stop', true, 'en', 'Agent work stopped'], ['stop', false, 'ja', '実行中の Agent 作業はありません'],
    ['new', false, 'zh-TW', '已開始新的 Agent 對話'], ['new', false, 'ko', '새 Agent 대화를 시작했습니다'],
  ] as const)('acknowledges /%s (cancelled %s, %s) without exposing ids', async (action, cancelled, locale, expected) => {
    const commands: LineWorkerCommand[] = [];
    const binding = { accountId: 'a', workerInstanceId: 'w', controlEpoch: 1, mode: 'ACTIVE_CONTROL' as const };
    const service = new BaseLineService({ async bindWorker() {} } as never,
      { async applyPendingRouteAction(_key: unknown, _messageId: string, _worker: string, apply: (action: string) => Promise<void>) { await apply(action); } } as never,
      {} as never, { async send(command) { commands.push(command); } },
      { kick() {}, async stopChat() { return cancelled; }, async resetChat() {} },
      undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, locale);
    await service.bind(binding);
    await (service as any).applyPendingAction(binding, { accountId: 'a', chatType: 'direct', chatId: 'chat' }, 'message');
    expect(commands[0]).toMatchObject({ type: 'sendText', chatId: 'chat', replyToMessageId: 'message', text: expected });
  });
});

it('correlates bounded logout results to the current binding and rejects them on unbind', async () => {
  const commands: LineWorkerCommand[] = [];
  const service = new BaseLineService({ async bindWorker() {} } as never,
    { async listPendingRouteActions() { return []; } } as never, {} as never,
    { async send(command) { commands.push(command); } },
    { kick() {}, async stopChat() {}, async resetChat() {} });
  await expect(service.requestLogout('logout-account', 'logout-worker', 10_000)).rejects.toThrow('LINE_LOGOUT_TIMEOUT_INVALID');
  const binding = { accountId: 'logout-account', workerInstanceId: 'logout-worker', controlEpoch: 19, mode: 'ACTIVE_CONTROL' as const };
  await service.bind(binding);
  const pending = service.requestLogout(binding.accountId, binding.workerInstanceId, 11_000);
  await vi.waitFor(() => expect(commands).toHaveLength(1));
  const command = commands[0]!;
  expect(command).toMatchObject({ type: 'logout', accountId: binding.accountId,
    workerInstanceId: binding.workerInstanceId, controlEpoch: binding.controlEpoch, requestId: expect.any(String) });
  if (command.type !== 'logout') throw new Error('logout command not sent');
  await service.handleWorkerEvent(binding.workerInstanceId, { type: 'logoutResult', accountId: binding.accountId,
    workerInstanceId: binding.workerInstanceId, controlEpoch: binding.controlEpoch,
    requestId: command.requestId, ok: true, error: null });
  await expect(pending).resolves.toEqual({ ok: true, error: null });

  const invalidated = service.requestLogout(binding.accountId, binding.workerInstanceId, 11_000);
  await vi.waitFor(() => expect(commands).toHaveLength(2));
  await service.handleWorkerEvent(binding.workerInstanceId, { type: 'authInvalidated', accountId: binding.accountId,
    workerInstanceId: binding.workerInstanceId, controlEpoch: binding.controlEpoch });
  await expect(invalidated).resolves.toEqual({ ok: false, error: 'LINE_AUTH_INVALIDATED' });

  const abandoned = service.requestLogout(binding.accountId, binding.workerInstanceId, 11_000);
  await vi.waitFor(() => expect(commands).toHaveLength(3));
  service.unbind(binding.workerInstanceId);
  await expect(abandoned).rejects.toThrow('LINE_LOGOUT_WORKER_STOPPED');
});

it('keeps attachment admission independent from receive health while preserving auth and protocol fences', async () => {
  const service = new BaseLineService({ async bindWorker() {}, async getAccount() { return { ownMid: 'agent-mid' }; },
    async applyWorkerLogin() { return true; }, async applyWorkerConnectionStatus() { return true; } } as never,
    { async listPendingRouteActions() { return []; } } as never, {} as never, { async send() {} },
    { kick() {}, async stopChat() {}, async resetChat() {} });
  const binding = { accountId: 'a', workerInstanceId: 'readiness-no-db', controlEpoch: 1, mode: 'ACTIVE_CONTROL' as const };
  const eventBinding = { accountId: binding.accountId, workerInstanceId: binding.workerInstanceId, controlEpoch: binding.controlEpoch };
  await service.bind(binding);
  await service.handleWorkerEvent(binding.workerInstanceId, { type: 'login', ...eventBinding,
    loginAttemptId: 'readiness-no-db-login', ownMid: 'agent-mid', displayName: null });
  await service.handleWorkerEvent(binding.workerInstanceId, { type: 'status', ...eventBinding, state: 'ready', message: null });
  expect(service.isAttachmentReady(binding)).toBe(true);
  await service.handleWorkerEvent(binding.workerInstanceId, { type: 'status', ...eventBinding, state: 'degraded', message: 'receive retrying' });
  expect(service.isAuthenticatedReady(binding)).toBe(false);
  expect(service.isAttachmentReady(binding)).toBe(true);
  await service.handleWorkerEvent(binding.workerInstanceId, { type: 'catalogRefreshStatus', ...eventBinding,
    state: 'degraded', code: 'CATALOG_REFRESH_FAILED' });
  expect(service.isAttachmentReady(binding)).toBe(true);
  await service.handleWorkerEvent(binding.workerInstanceId, { type: 'status', ...eventBinding, state: 'disconnected', message: null });
  expect(service.isAttachmentReady(binding)).toBe(false);
  await service.handleWorkerEvent(binding.workerInstanceId, { type: 'status', ...eventBinding, state: 'ready', message: null });
  expect(service.isAttachmentReady(binding)).toBe(false);
  await service.handleWorkerEvent(binding.workerInstanceId, { type: 'status', ...eventBinding, state: 'PROTOCOL_UNVERIFIED', message: 'mismatch' });
  expect(service.isAttachmentReady(binding)).toBe(false);
  await service.handleWorkerEvent(binding.workerInstanceId, { type: 'authInvalidated', ...eventBinding });
  expect(service.isAttachmentReady(binding)).toBe(false);
});

it('keeps worker readiness after a retryable token refresh diagnostic and healthy poll', async () => {
  const service = new BaseLineService({ async bindWorker() {}, async getAccount() { return { ownMid: 'agent-mid' }; },
    async applyWorkerLogin() { return true; }, async applyWorkerConnectionStatus() { return true; } } as never,
    { async listPendingRouteActions() { return []; } } as never, {} as never, { async send() {} },
    { kick() {}, async stopChat() {}, async resetChat() {} });
  const binding = { accountId: 'a', workerInstanceId: 'refresh-failure-ready', controlEpoch: 1, mode: 'ACTIVE_CONTROL' as const };
  const eventBinding = { accountId: binding.accountId, workerInstanceId: binding.workerInstanceId, controlEpoch: binding.controlEpoch };
  await service.bind(binding);
  await service.handleWorkerEvent(binding.workerInstanceId, { type: 'login', ...eventBinding,
    loginAttemptId: 'refresh-failure-login', ownMid: 'agent-mid', displayName: null });
  await service.handleWorkerEvent(binding.workerInstanceId, { type: 'status', ...eventBinding, state: 'ready', message: null });
  const failure = { type: 'error' as const, ...eventBinding, code: 'WORKER_OPERATION_FAILED' as const,
    message: 'LINE token refresh failed', retryable: true,
    diagnostic: { operation: 'loginToken' as const, stage: 'execute' as const, category: 'transport_failed' as const,
      recovery: 'retry' as const, outcome: 'failed' as const } };

  await service.handleWorkerEvent(binding.workerInstanceId, failure);
  expect(service.isAuthenticatedReady(binding)).toBe(true);
  expect(service.isAttachmentReady(binding)).toBe(true);
  await service.handleWorkerEvent(binding.workerInstanceId, { type: 'status', ...eventBinding, state: 'ready', message: null });
  expect(service.isAuthenticatedReady(binding)).toBe(true);
  expect(service.isAttachmentReady(binding)).toBe(true);
});

describe('administrative archive admission', () => {
  function setup(failCommit = false, effectHook?: () => Promise<void>) {
    const seen = new Set<string>();
    const effects: string[] = [];
    const order: string[] = [];
    const service = new BaseLineService(
      { async bindWorker() {}, async getAccount() { return { ownMid: 'agent' }; } } as never,
      { async listPendingRouteActions() { return []; }, async applyPendingRouteAction() {},
        async ingestBatchAndRoute(input: { envelopes: InboundEnvelope[] }) {
          if (failCommit) throw new Error('commit failed');
          order.push('commit');
          const insertedMessageIds = input.envelopes.flatMap((e) => {
            if (seen.has(e.messageId)) return []; seen.add(e.messageId); return [e.messageId];
          });
          return { insertedMessageIds, jobMessageIds: [] };
        } } as never,
      { async getAppSetting() { return undefined; }, async getConversationAgent() { return null; } } as never,
      { async send() { order.push('ack'); } },
      { kick() {}, async stopChat() {}, async resetChat() {} }, undefined, undefined,
      async (e) => { effects.push(e.messageId); order.push('effect'); await effectHook?.(); return true; },
    );
    return { service, effects, order };
  }
  it('executes one effect after commit for duplicate source identities and never replays it', async () => {
    const { service, effects, order } = setup();
    await service.bind({ accountId: 'a', workerInstanceId: 'w1', controlEpoch: 1, mode: 'ACTIVE_CONTROL' });
    const event = batch(); event.envelopes.push({ ...event.envelopes[0]! });
    await service.handleWorkerEvent('w1', event);
    await service.handleWorkerEvent('w1', event);
    expect(effects).toEqual(['m1']);
    expect(order).toEqual(['commit', 'effect', 'ack', 'commit', 'ack']);
  });
  it('does not execute an administrative effect when archive commit fails', async () => {
    const { service, effects } = setup(true);
    await service.bind({ accountId: 'a', workerInstanceId: 'w1', controlEpoch: 1, mode: 'ACTIVE_CONTROL' });
    await expect(service.handleWorkerEvent('w1', batch())).rejects.toThrow('commit failed');
    expect(effects).toEqual([]);
  });
  it('serializes overlapping batches and bounds waiting admission to one', async () => {
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => { release = resolve; });
    const { service, effects } = setup(false, () => blocked);
    await service.bind({ accountId: 'a', workerInstanceId: 'w1', controlEpoch: 1, mode: 'ACTIVE_CONTROL' });
    const first = service.handleWorkerEvent('w1', batch());
    await vi.waitFor(() => expect(effects).toEqual(['m1']));
    const secondEvent = batch(); secondEvent.envelopes[0]!.messageId = 'm2';
    const second = service.handleWorkerEvent('w1', secondEvent);
    await expect(service.handleWorkerEvent('w1', batch())).rejects.toThrow('ACCOUNT_INGRESS_CAPACITY');
    expect(effects).toEqual(['m1']);
    release(); await Promise.all([first, second]);
    expect(effects).toEqual(['m1', 'm2']);
  });
  it('cancels waiting admission at shutdown and drains the active batch', async () => {
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => { release = resolve; });
    const { service, effects } = setup(false, () => blocked);
    await service.bind({ accountId: 'a', workerInstanceId: 'w1', controlEpoch: 1, mode: 'ACTIVE_CONTROL' });
    const first = service.handleWorkerEvent('w1', batch());
    await vi.waitFor(() => expect(effects).toEqual(['m1']));
    const secondEvent = batch(); secondEvent.envelopes[0]!.messageId = 'm2';
    const second = service.handleWorkerEvent('w1', secondEvent);
    const shutdown = service.shutdownIngress();
    release(); await Promise.allSettled([first, second, shutdown]);
    expect(effects).toEqual(['m1']);
    await expect(service.handleWorkerEvent('w1', batch())).rejects.toThrow('ACCOUNT_INGRESS_CLOSED');
  });
});

describe('LineService group mention authorization fast path', () => {
  function setup(options: { primary?: boolean; primaryError?: boolean; friend?: boolean; room?: boolean; responder?: boolean; handledMessageId?: string;
    freeMode?: never; freeActive?: boolean } = {}) {
    const providerChanges: Array<string | null> = [];
    const personaChanges: unknown[] = [];
    const calls: string[] = [];
    const friendScopes: unknown[] = [];
    const archived: Array<{ envelopes: InboundEnvelope[]; decisions: unknown[] }> = [];
    const kicked: string[] = [];
    const replies: string[] = [];
    const commands: LineWorkerCommand[] = [];
    const freeCommands: Array<{ enabledBy: string; command: unknown; sourceMessageId: string | undefined }> = [];
    const freeMode = { isActive: () => options.freeActive ?? false, statusText: () => null, addMessage() {},
      async handleCommand(_key: unknown, enabledBy: string, command: unknown, sourceMessageId?: string) { freeCommands.push({ enabledBy, command, sourceMessageId }); } };
    const folderCommands: Array<{ actor: string; chatType: string; command: unknown }> = [];
    const projectFolders = { async handleCommand(key: { chatType: string }, actor: string, command: unknown) { folderCommands.push({ actor, chatType: key.chatType, command }); } };
    const enrollmentInputs: Array<{ candidate: unknown; ownMid: string | null | undefined }> = [];
    const service = new BaseLineService(
      { async bindWorker() {}, async getAccount() { return { ownMid: 'agent-mid' }; } } as never,
      { async listPendingRouteActions() { return []; }, async applyPendingRouteAction() {}, async ingestBatchAndRoute(input: { envelopes: InboundEnvelope[] }, decisions: unknown[]) {
        archived.push({ envelopes: input.envelopes, decisions });
        return { inserted: input.envelopes.length, duplicate: 0,
          insertedMessageIds: input.envelopes.map((envelope) => envelope.messageId), jobIds: [],
          jobMessageIds: decisions.flatMap((decision: any, index) => decision.eligible ? [input.envelopes[index]!.messageId] : []),
          primaryAdminActionMessageIds: decisions.flatMap((decision: any, index) => decision.primaryAdminSenderId
            && (decision.eligible || decision.action === 'stop' || decision.action === 'new' || decision.action === 'status'
              || decision.workspaceFailure) ? [input.envelopes[index]!.messageId] : []) };
      } } as never,
      { async getAppSetting() { return undefined; }, async getConversationAgent() { return { enabled: true, provider: 'codex' }; },
        async setConversationProvider(_key: unknown, provider: string | null) { providerChanges.push(provider); return true; },
        async getConversationPersona() { return { description: null, liveliness: null }; },
        async setConversationPersona(_key: unknown, patch: unknown) { personaChanges.push(patch); return true; } } as never,
      { async send(command: LineWorkerCommand) { commands.push(command); } },
      { kick(key) { kicked.push(key.chatId); }, async stopChat() {}, async resetChat() {} },
      undefined, undefined, async (envelope, candidate, ownMid) => {
        enrollmentInputs.push({ candidate, ownMid });
        if (envelope.messageId !== options.handledMessageId) return false;
        calls.push(`enrollment:${ownMid}`);
        return true;
      },
      { async isPrimaryAdministrator() { return options.primary ?? false; }, async isPrimaryUser() { calls.push('primary'); if (options.primaryError) throw new Error('admin lookup unavailable'); return options.primary ?? false; } } as never,
      { async inspect() { return { status: 'available', version: 1, path: 'C:\\trusted' }; } },
      { async handle() { calls.push('control'); }, async isEnabled() { return options.responder ?? true; },
        async getActiveAuthorization() { calls.push('room'); return options.room === false ? null : { grantId: 'room-grant', version: 1 }; },
        async respond(_envelope, body) { replies.push(body); } },
      { async getActiveAuthorization(_accountId: string, _senderId: string, scope: unknown) {
        calls.push('friend'); friendScopes.push(scope);
        return options.friend === false ? null : { grantId: 'friend-grant', version: 1, scopeKind: 'ACCOUNT' };
      } } as never,
      async (envelope) => envelope.messageId === options.handledMessageId,
      undefined, undefined, undefined, 'en', undefined, freeMode, projectFolders,
    );
    return { service, freeCommands, folderCommands, calls, archived, kicked, replies, enrollmentInputs, friendScopes, commands, providerChanges, personaChanges };
  }

  const groupMessage = (overrides: Partial<InboundEnvelope> = {}): InboundEnvelope => ({
    ...batch().envelopes[0]!, chatType: 'group', chatId: 'g', messageId: 'group-message',
    text: 'hello everyone', mentionIds: [], mentionRanges: [], ...overrides,
  });

  describe('/persona chat override', () => {
    const sentTexts = (commands: LineWorkerCommand[]) => commands.flatMap((command) => command.type === 'sendText' ? [command.text] : []);
    async function run(options: Parameters<typeof setup>[0], envelope: InboundEnvelope) {
      const harness = setup(options);
      await harness.service.bind({ accountId: 'a', workerInstanceId: 'w1', controlEpoch: 1, mode: 'ACTIVE_CONTROL' });
      await harness.service.handleWorkerEvent('w1', { ...batch(), envelopes: [envelope] });
      await harness.service.idleRoomEffects();
      return harness;
    }

    it('lets the Primary Administrator set the description without a mention and confirms it', async () => {
      const h = await run({ primary: true }, groupMessage({ messageId: 'persona-1', text: '/persona 溫柔簡短' }));
      expect(h.personaChanges).toEqual([{ description: '溫柔簡短' }]);
      expect(sentTexts(h.commands)).toEqual(["This chat's Agent persona is now: 溫柔簡短"]);
      expect(h.replies).toEqual([]);
    });
    it('sets the liveliness, with an English alias and a mention', async () => {
      const h = await run({ primary: true }, groupMessage({ messageId: 'persona-2', text: '@Agent /persona Lively',
        mentionIds: ['agent-mid'], mentionRanges: [{ start: 0, end: 6, userId: 'agent-mid' }] }));
      expect(h.personaChanges).toEqual([{ liveliness: 'lively' }]);
      expect(sentTexts(h.commands)).toEqual(["This chat's reply liveliness is now: Lively"]);
    });
    it('clears both overrides on default', async () => {
      const h = await run({ primary: true }, groupMessage({ messageId: 'persona-3', text: '/persona default' }));
      expect(h.personaChanges).toEqual([{ description: null, liveliness: null }]);
    });
    it('answers a bare /persona with the effective values and changes nothing', async () => {
      const h = await run({ primary: true }, groupMessage({ messageId: 'persona-4', text: '/persona' }));
      expect(h.personaChanges).toEqual([]);
      expect(sentTexts(h.commands)[0]).toMatch(/^Agent persona \(default\): \(none, neutral tone\)\nReply liveliness \(default\): Normal$/);
    });
    it('does not execute for a non-administrator: no change, no confirmation', async () => {
      const h = await run({ primary: false }, groupMessage({ messageId: 'persona-5', text: '/persona 活潑' }));
      expect(h.personaChanges).toEqual([]);
      expect(sentTexts(h.commands)).toEqual([]);
      expect(h.replies).toEqual([]);
    });
    it('lets a non-administrator mention of /persona take the ordinary auto-reply path', async () => {
      const h = await run({ primary: false, friend: false, responder: false }, groupMessage({ messageId: 'persona-6', text: '@Agent /persona 活潑',
        mentionIds: ['agent-mid'], mentionRanges: [{ start: 0, end: 6, userId: 'agent-mid' }] }));
      expect(h.personaChanges).toEqual([]);
      expect(h.replies).toEqual(['/persona 活潑']);
    });
  });

  describe('/agent chat override', () => {
    const mentioned = (text: string, messageId = 'agent-command') => groupMessage({ messageId, text,
      mentionIds: ['agent-mid'], mentionRanges: [{ start: 0, end: 6, userId: 'agent-mid' }] });
    const sentTexts = (commands: LineWorkerCommand[]) => commands.flatMap((command) => command.type === 'sendText' ? [command.text] : []);
    async function run(options: Parameters<typeof setup>[0], envelope: InboundEnvelope) {
      const harness = setup(options);
      await harness.service.bind({ accountId: 'a', workerInstanceId: 'w1', controlEpoch: 1, mode: 'ACTIVE_CONTROL' });
      await harness.service.handleWorkerEvent('w1', { ...batch(), envelopes: [envelope] });
      await harness.service.idleRoomEffects();
      return harness;
    }

    it('lets the Primary Administrator set the chat override with a bare /agent claude|codex and confirms it', async () => {
      const h = await run({ primary: true }, mentioned('@Agent /AGENT Codex'.replace('/AGENT Codex', '/agent codex')));
      expect(h.providerChanges).toEqual(['codex']);
      expect(sentTexts(h.commands)).toContain('This chat now uses Codex');
      expect(h.kicked).toEqual([]);
      expect(h.replies).toEqual([]);
      expect(h.archived[0]!.decisions).toEqual([{ eligible: false, action: 'ignore' }]);
    });

    it('clears the override with /agent default and names the global default', async () => {
      const h = await run({ primary: true }, mentioned('@Agent /agent default'));
      expect(h.providerChanges).toEqual([null]);
      expect(sentTexts(h.commands)).toContain('This chat is back to the default Agent (Claude)');
    });

    it('lets the Primary Administrator switch without a mention while free mode is on', async () => {
      const h = await run({ primary: true, freeActive: true }, groupMessage({ messageId: 'free-switch', text: '/agent claude' }));
      expect(h.providerChanges).toEqual(['claude']);
      expect(sentTexts(h.commands)).toContain('This chat now uses Claude');
    });

    it('does not let a served non-administrator switch: bare /agent claude gets the usage hint', async () => {
      const h = await run({ primary: false }, mentioned('@Agent /agent claude'));
      expect(h.providerChanges).toEqual([]);
      expect(sentTexts(h.commands)).toContain('Add what you want done after /agent claude');
    });

    it('treats /agent default from a non-administrator in an unserved room as ordinary text for the responder', async () => {
      const h = await run({ primary: false, room: false, friend: false, responder: false }, mentioned('@Agent /agent default'));
      expect(h.providerChanges).toEqual([]);
      expect(sentTexts(h.commands)).toEqual([]);
      expect(h.replies).toEqual(['/agent default']);
    });

    it('treats an administrator-less /agent claude from a free-mode member as a free-mode message', async () => {
      const h = await run({ primary: false, freeActive: true }, groupMessage({ messageId: 'member-switch', text: '/agent claude' }));
      expect(h.providerChanges).toEqual([]);
      expect(sentTexts(h.commands)).toEqual([]);
    });
  });

  it('archives an untagged group text without authorization lookups or a job', async () => {
    const { service, calls, archived, kicked } = setup();
    await service.bind({ accountId: 'a', workerInstanceId: 'w1', controlEpoch: 1, mode: 'ACTIVE_CONTROL' });
    await service.handleWorkerEvent('w1', { ...batch(), envelopes: [groupMessage()] });
    expect(calls).toEqual([]);
    expect(archived[0]!.envelopes[0]!.messageId).toBe('group-message');
    expect(archived[0]!.decisions).toEqual([{ eligible: false, action: 'ignore' }]);
    expect(kicked).toEqual([]);
  });

  it('does not treat a text-only fake tag as a mention', async () => {
    const { service, calls, archived, kicked } = setup();
    await service.bind({ accountId: 'a', workerInstanceId: 'w1', controlEpoch: 1, mode: 'ACTIVE_CONTROL' });
    await service.handleWorkerEvent('w1', { ...batch(), envelopes: [groupMessage({ text: '@Agent please help' })] });
    expect(calls).toEqual([]);
    expect(archived[0]!.decisions).toEqual([{ eligible: false, action: 'ignore' }]);
    expect(kicked).toEqual([]);
  });

  it('does not apply this account own-MID to a group message from another account', async () => {
    const { service, calls, archived, kicked } = setup();
    await service.bind({ accountId: 'a', workerInstanceId: 'w1', controlEpoch: 1, mode: 'ACTIVE_CONTROL' });
    await service.handleWorkerEvent('w1', { ...batch(), envelopes: [groupMessage({ accountId: 'other-account',
      text: '@Agent please help', mentionIds: ['agent-mid'], mentionRanges: [{ start: 0, end: 6, userId: 'agent-mid' }] })] });
    expect(calls).toEqual([]);
    expect(archived[0]!.decisions).toEqual([{ eligible: false, action: 'ignore' }]);
    expect(kicked).toEqual([]);
  });

  it('checks group permissions only after a true own-MID mention and admits its job', async () => {
    const { service, calls, archived, kicked, friendScopes } = setup();
    await service.bind({ accountId: 'a', workerInstanceId: 'w1', controlEpoch: 1, mode: 'ACTIVE_CONTROL' });
    await service.handleWorkerEvent('w1', { ...batch(), envelopes: [groupMessage({ text: '@Agent do this',
      mentionIds: ['agent-mid'], mentionRanges: [{ start: 0, end: 6, userId: 'agent-mid' }] })] });
    expect(calls).toEqual(['primary', 'friend', 'room']);
    expect(friendScopes).toEqual([{ kind: 'CHAT', chatType: 'group', chatId: 'g' }]);
    expect(archived[0]!.decisions).toEqual([expect.objectContaining({ eligible: true, prompt: 'do this' })]);
    expect(kicked).toEqual(['g']);
  });

  it('keeps the unapproved and disabled room branches ineligible', async () => {
    for (const options of [{ friend: false }, { room: false }]) {
      const { service, archived, kicked } = setup(options);
      await service.bind({ accountId: 'a', workerInstanceId: 'w1', controlEpoch: 1, mode: 'ACTIVE_CONTROL' });
      await service.handleWorkerEvent('w1', { ...batch(), envelopes: [groupMessage({ text: '@Agent do this',
        mentionIds: ['agent-mid'], mentionRanges: [{ start: 0, end: 6, userId: 'agent-mid' }] })] });
      expect(archived[0]!.decisions).toEqual([{ eligible: false, action: 'ignore' }]);
      expect(kicked).toEqual([]);
    }
  });

  it('admits a PRIMARY_ADMIN group mention without room or friend grants', async () => {
    const { service, calls, archived, kicked } = setup({ primary: true });
    await service.bind({ accountId: 'a', workerInstanceId: 'w1', controlEpoch: 1, mode: 'ACTIVE_CONTROL' });
    await service.handleWorkerEvent('w1', { ...batch(), envelopes: [groupMessage({ text: '@Agent do this',
      mentionIds: ['agent-mid'], mentionRanges: [{ start: 0, end: 6, userId: 'agent-mid' }] })] });
    expect(calls).toEqual(['primary']);
    expect(archived[0]!.decisions).toEqual([expect.objectContaining({ eligible: true, prompt: 'do this', primaryAdminSenderId: 'user' })]);
    expect(kicked).toEqual(['g']);
  });

  it('suppresses the disabled-room fallback after a primary-admin Agent route commits', async () => {
    const { service, replies, kicked } = setup({ primary: true, responder: false });
    await service.bind({ accountId: 'a', workerInstanceId: 'w1', controlEpoch: 1, mode: 'ACTIVE_CONTROL' });
    await service.handleWorkerEvent('w1', { ...batch(), envelopes: [groupMessage({ text: '@Agent hello',
      mentionIds: ['agent-mid'], mentionRanges: [{ start: 0, end: 6, userId: 'agent-mid' }] })] });
    await service.idleRoomEffects();
    expect(kicked).toEqual(['g']);
    expect(replies).toEqual([]);
  });

  it.each([
    ['/free', false, true], ['@Agent /free', true, true], ['/free 10', false, true],
  ])('never lets the disabled-room responder answer the Primary Administrator command %s (mention %s, Primary Admin %s)', async (text, mention, primary) => {
    const { service, replies, freeCommands } = setup({ primary, responder: false });
    await service.bind({ accountId: 'a', workerInstanceId: 'w1', controlEpoch: 1, mode: 'ACTIVE_CONTROL' });
    await service.handleWorkerEvent('w1', { ...batch(), envelopes: [groupMessage({ messageId: 'free-command', text,
      ...(mention ? { mentionIds: ['agent-mid'], mentionRanges: [{ start: 0, end: 6, userId: 'agent-mid' }] } : {}) })] });
    await service.idleRoomEffects();
    expect(replies).toEqual([]);
    expect(freeCommands.map((item) => item.sourceMessageId)).toEqual(primary ? ['free-command'] : []);
  });

  it.each([
    ['/folder D:/Projects/Alpha', false, true, 'bind'], ['@Agent /folder rw "D:/My Projects/Alpha"', true, true, 'bind'], ['/folder', false, true, 'list'],
    ['/folder off', false, true, 'off'], ['@Agent /folder off D:/Projects/Alpha', true, true, 'off'],
    ['/folder D:/Projects/Alpha', false, false, null], ['@Agent /folder rw D:/Projects/Alpha', true, false, null], ['@Agent /folder', true, false, null],
  ])('executes the group command %s (mention %s, Primary Admin %s) only for the Primary Admin', async (text, mention, primary, action) => {
    const { service, replies, folderCommands, kicked, archived } = setup({ primary, responder: false });
    await service.bind({ accountId: 'a', workerInstanceId: 'w1', controlEpoch: 1, mode: 'ACTIVE_CONTROL' });
    await service.handleWorkerEvent('w1', { ...batch(), envelopes: [groupMessage({ messageId: 'folder-command', senderId: 'u-sender', text,
      ...(mention ? { mentionIds: ['agent-mid'], mentionRanges: [{ start: 0, end: 6, userId: 'agent-mid' }] } : {}) })] });
    await service.idleRoomEffects();
    if (primary) {
      expect(replies).toEqual([]);
      expect(kicked).toEqual([]);
      expect(archived[0]!.decisions).toEqual([{ eligible: false, action: 'ignore' }]);
    }
    expect(folderCommands.map((item) => [item.actor, item.chatType, (item.command as { action: string }).action])).toEqual(action ? [['u-sender', 'group', action]] : []);
  });

  it('lets a non-admin /folder with a mention reach the disabled-room responder like any other text, never the admin one', async () => {
    for (const primary of [false, true]) {
      const { service, replies, folderCommands } = setup({ primary, friend: false, responder: false });
      await service.bind({ accountId: 'a', workerInstanceId: 'w1', controlEpoch: 1, mode: 'ACTIVE_CONTROL' });
      await service.handleWorkerEvent('w1', { ...batch(), envelopes: [groupMessage({ messageId: 'folder-resp', text: '@Agent /folder D:/x',
        mentionIds: ['agent-mid'], mentionRanges: [{ start: 0, end: 6, userId: 'agent-mid' }] })] });
      await service.idleRoomEffects();
      expect(replies).toHaveLength(primary ? 0 : 1);
      expect(folderCommands).toHaveLength(primary ? 1 : 0);
    }
  });

  it('executes /folder in the Primary Admin 1:1 chat and never for anyone else there', async () => {
    for (const primary of [true, false]) {
      const { service, folderCommands, kicked } = setup({ primary });
      await service.bind({ accountId: 'a', workerInstanceId: 'w1', controlEpoch: 1, mode: 'ACTIVE_CONTROL' });
      await service.handleWorkerEvent('w1', { ...batch(), envelopes: [groupMessage({ chatType: 'direct', chatId: 'admin-1', messageId: 'direct-folder', text: '/folder rw D:/Projects/Alpha' })] });
      await service.idleRoomEffects();
      if (primary) expect(kicked).toEqual([]); // a non-admin message is ordinary (a whitelisted friend's goes the normal prompt path)
      expect(folderCommands).toHaveLength(primary ? 1 : 0);
      if (primary) expect(folderCommands[0]).toMatchObject({ chatType: 'direct', command: { action: 'bind', mode: 'READ_WRITE', path: 'D:/Projects/Alpha' } });
    }
  });

  it('treats /free from a non-Primary-Administrator as ordinary text: the responder answers a mention and nothing runs', async () => {
    const { service, replies, freeCommands } = setup({ primary: false, responder: false });
    await service.bind({ accountId: 'a', workerInstanceId: 'w1', controlEpoch: 1, mode: 'ACTIVE_CONTROL' });
    await service.handleWorkerEvent('w1', { ...batch(), envelopes: [groupMessage({ messageId: 'free-command', text: '@Agent /free',
      mentionIds: ['agent-mid'], mentionRanges: [{ start: 0, end: 6, userId: 'agent-mid' }] })] });
    await service.idleRoomEffects();
    expect(replies).toEqual(['/free']);
    expect(freeCommands).toEqual([]);
  });

  it('still answers ordinary mentioned text in a room that is not enabled', async () => {
    const { service, replies } = setup({ responder: false });
    await service.bind({ accountId: 'a', workerInstanceId: 'w1', controlEpoch: 1, mode: 'ACTIVE_CONTROL' });
    await service.handleWorkerEvent('w1', { ...batch(), envelopes: [groupMessage({ text: '@Agent hello there',
      mentionIds: ['agent-mid'], mentionRanges: [{ start: 0, end: 6, userId: 'agent-mid' }] })] });
    await service.idleRoomEffects();
    expect(replies).toEqual(['hello there']);
  });

  it('archives and acknowledges a mixed batch when primary-admin lookup fails for one mention', async () => {
    const { service, archived, calls, commands, replies } = setup({ primaryError: true, responder: false });
    await service.bind({ accountId: 'a', workerInstanceId: 'w1', controlEpoch: 1, mode: 'ACTIVE_CONTROL' });
    await expect(service.handleWorkerEvent('w1', { ...batch(), envelopes: [
      groupMessage({ messageId: 'admin-lookup-fails', text: '@Agent prompt', mentionIds: ['agent-mid'],
        mentionRanges: [{ start: 0, end: 6, userId: 'agent-mid' }] }),
      groupMessage({ messageId: 'unrelated-message', text: 'ordinary text' }),
    ] })).resolves.toBeDefined();
    expect(calls).toEqual(['primary']);
    expect(archived[0]!.decisions).toEqual([{ eligible: false, action: 'ignore' }, { eligible: false, action: 'ignore' }]);
    expect(commands).toContainEqual(expect.objectContaining({ type: 'ackBatch' }));
    expect(replies).toEqual([]);
  });

  it('archives handled enrollment mentions without creating an Agent job or disabled-room autoresponse', async () => {
    const { service, calls, archived, kicked, replies } = setup({ responder: false, handledMessageId: 'add-user' });
    await service.bind({ accountId: 'a', workerInstanceId: 'w1', controlEpoch: 1, mode: 'ACTIVE_CONTROL' });
    await service.handleWorkerEvent('w1', { ...batch(), envelopes: [groupMessage({ messageId: 'add-user',
      text: '@Agent /adduser', mentionIds: ['agent-mid'], mentionRanges: [{ start: 0, end: 6, userId: 'agent-mid' }] })] });
    await service.idleRoomEffects();
    expect(calls).toContain('enrollment:agent-mid');
    expect(archived[0]!.decisions).toEqual([{ eligible: false, action: 'ignore' }]);
    expect(kicked).toEqual([]);
    expect(replies).toEqual([]);
  });

  it('passes only an in-memory exact own-mention group token while persisting a redacted message', async () => {
    const { service, archived, enrollmentInputs, kicked } = setup({ handledMessageId: 'group-token' });
    const code = 'LW-ABCDEFGH';
    await service.bind({ accountId: 'a', workerInstanceId: 'w1', controlEpoch: 1, mode: 'ACTIVE_CONTROL' });
    await service.handleWorkerEvent('w1', { ...batch(), envelopes: [groupMessage({ messageId: 'group-token',
      text: `@Agent ${code}`, mentionIds: ['agent-mid'], mentionRanges: [{ start: 0, end: 6, userId: 'agent-mid' }] })] });
    const stored = archived[0]!.envelopes[0]!;
    expect(stored.text).toBe('@Agent [REDACTED_VERIFICATION_CODE]');
    expect(JSON.stringify(stored)).not.toContain(code);
    expect(enrollmentInputs[0]).toEqual({ candidate: { code, exact: true }, ownMid: 'agent-mid' });
    expect(archived[0]!.decisions).toEqual([{ eligible: false, action: 'ignore' }]);
    expect(kicked).toEqual([]);
  });

  it('checks mixed batch permissions independently and still runs room control and disabled-room replies', async () => {
    const { service, calls, archived, kicked, replies } = setup({ responder: false });
    await service.bind({ accountId: 'a', workerInstanceId: 'w1', controlEpoch: 1, mode: 'ACTIVE_CONTROL' });
    const tagged = groupMessage({ messageId: 'tagged', text: '@Agent hello', mentionIds: ['agent-mid'],
      mentionRanges: [{ start: 0, end: 6, userId: 'agent-mid' }] });
    const untagged = groupMessage({ messageId: 'untagged', text: 'hello' });
    const monitor = groupMessage({ messageId: 'monitor', text: '@Agent monitor', mentionIds: ['agent-mid'],
      mentionRanges: [{ start: 0, end: 6, userId: 'agent-mid' }] });
    await service.handleWorkerEvent('w1', { ...batch(), envelopes: [tagged, untagged, monitor] });
    await service.idleRoomEffects();
    expect(calls).toEqual(['primary', 'friend', 'room', 'control']);
    expect(archived[0]!.envelopes.map((item) => item.messageId)).toEqual(['tagged', 'untagged', 'monitor']);
    expect(archived[0]!.decisions).toEqual([
      expect.objectContaining({ eligible: true }),
      { eligible: false, action: 'ignore' },
      { eligible: false, action: 'ignore' },
    ]);
    expect(replies).toContain('hello');
    expect(kicked).toEqual(['g']);
  });
});

describe('LineService unavailable workspace routing', () => {
  it('inspects once, terminally routes only the trigger, acknowledges, and never kicks it', async () => {
    const persisted: unknown[] = [];
    const commands: LineWorkerCommand[] = [];
    const kicked: string[] = [];
    let inspections = 0;
    const event = batch();
    event.envelopes = [
      { ...event.envelopes[0]!, messageId: 'ordinary', eventId: 'ordinary-event', senderId: 'intruder', text: 'hello' },
      { ...event.envelopes[0]!, messageId: 'trigger', eventId: 'trigger-event', text: 'do this' },
    ];
    const service = new BaseLineService(
      { async bindWorker() {}, async getAccount() { return { ownMid: 'agent-mid' }; } } as never,
      { async listPendingRouteActions() { return []; }, async applyPendingRouteAction() {}, async ingestBatchAndRoute(_batch: unknown, decisions: unknown[]) {
        persisted.push(...decisions);
        return { inserted: 2, duplicate: 0, insertedMessageIds: ['ordinary', 'trigger'], jobIds: [], jobMessageIds: [] };
      } } as never,
      { async getAppSetting(key: string) { if (key === 'default_provider') return 'codex'; throw new Error('LINE must not read the workspace setting'); },
        async getConversationAgent() { return { enabled: true, provider: 'codex' }; } } as never,
      { async send(command) { commands.push(command); } },
      { kick(key) { kicked.push(key.chatId); }, async stopChat() {}, async resetChat() {} },
      undefined, undefined, undefined, { async isPrimaryAdministrator(_accountId: string, _chatId: string, senderId: string) { return senderId === 'user'; } } as never,
      { async inspect() { inspections++; return { status: 'unavailable', version: 3, configuredPath: 'D:\\missing', reason: 'Workspace directory is unavailable' }; } },
    );
    await service.bind({ accountId: 'a', workerInstanceId: 'w1', controlEpoch: 1, mode: 'ACTIVE_CONTROL' });
    await service.handleWorkerEvent('w1', event);

    expect(inspections).toBe(1);
    expect(persisted[0]).toEqual({ eligible: false, action: 'ignore' });
    expect(persisted[1]).toMatchObject({ eligible: false, workspaceFailure: {
      provider: 'codex', prompt: 'do this', workspacePath: 'D:\\missing', code: 'INVALID_WORKSPACE',
    } });
    expect(kicked).toEqual([]);
    expect(commands).toMatchObject([{ type: 'ackBatch', batchId: 'b1' }]);
  });

  it('passes code candidates only in memory and archives/routes a redacted placeholder', async () => {
    const persisted: Array<{ batch: unknown; decisions: unknown[] }> = [];
    const received: unknown[] = [];
    const event = batch();
    event.envelopes = [{ ...event.envelopes[0]!, messageId: 'code-message', eventId: 'code-event',
      senderId: 'administrator', text: 'LW-ABCDEFGH', raw: { message: { text: 'LW-ABCDEFGH' } } },
    { ...event.envelopes[0]!, accountId: 'other-account', messageId: 'cross-account-code', eventId: 'cross-account-event',
      senderId: 'administrator', text: 'LW-ABCDEFGH', raw: { message: { text: 'LW-ABCDEFGH' } } }];
    const service = new BaseLineService(
      { async bindWorker() {}, async getAccount() { return { ownMid: 'agent-mid' }; } } as never,
      { async listPendingRouteActions() { return []; }, async applyPendingRouteAction() {}, async ingestBatchAndRoute(input: unknown, decisions: unknown[]) {
        persisted.push({ batch: input, decisions });
        return { inserted: 1, duplicate: 0, insertedMessageIds: ['code-message'], jobIds: [], jobMessageIds: [] };
      } } as never,
      { async getAppSetting() { return undefined; }, async getConversationAgent() { return { enabled: true, provider: 'codex' }; } } as never,
      { async send() {} }, { kick() { throw new Error('sensitive message must not kick an Agent'); }, async stopChat() {}, async resetChat() {} },
      undefined, undefined,
      async (safeEnvelope, candidate) => { received.push({ safeEnvelope, candidate }); return false; },
      undefined,
      { async inspect() { return { status: 'available', version: 1, path: 'C:\\trusted' }; } },
    );
    await service.bind({ accountId: 'a', workerInstanceId: 'w1', controlEpoch: 1, mode: 'ACTIVE_CONTROL' });
    await service.handleWorkerEvent('w1', event);

    const stored = (persisted[0]!.batch as Extract<LineWorkerEvent, { type: 'batch' }>).envelopes[0]!;
    expect(stored.text).toBe('[REDACTED_VERIFICATION_CODE]');
    expect(JSON.stringify(stored)).not.toContain('LW-ABCDEFGH');
    expect(persisted[0]!.decisions).toEqual([{ eligible: false, action: 'ignore' }, { eligible: false, action: 'ignore' }]);
    expect(received[0]).toMatchObject({ candidate: { code: 'LW-ABCDEFGH', exact: true },
      safeEnvelope: { text: '[REDACTED_VERIFICATION_CODE]' } });
    expect(received).toHaveLength(1);
  });
});

it('tracks catalog health separately from attachment readiness', async () => {
  const statuses: string[] = [];
  const service = new LineService({ async bindWorker() {}, async getAccount() { return { ownMid: 'u-self' }; },
    async applyWorkerLogin() { return true; }, async applyWorkerConnectionStatus(_binding: unknown, status: 'connected' | 'degraded') { statuses.push(status); return true; } } as never,
    { async listPendingRouteActions() { return []; }, async applyPendingRouteAction() {} } as never,
    {} as never, { async send() {} }, { kick() {}, async stopChat() {}, async resetChat() {} });
  const binding = { accountId: 'a', workerInstanceId: 'w1', controlEpoch: 1, mode: 'ACTIVE_CONTROL' as const };
  service.bind(binding);
  await service.handleWorkerEvent('w1', { type: 'login', accountId: 'a', workerInstanceId: 'w1', controlEpoch: 1,
    loginAttemptId: 'catalog-health-login', ownMid: 'u-self', displayName: 'Agent' });
  await service.handleWorkerEvent('w1', { type: 'status', accountId: 'a', workerInstanceId: 'w1', controlEpoch: 1,
    state: 'ready', message: null });
  await service.handleWorkerEvent('w1', { type: 'catalogRefreshStatus', accountId: 'a', workerInstanceId: 'w1', controlEpoch: 1,
    state: 'degraded', code: 'CATALOG_REFRESH_FAILED' });
  expect(statuses).toContain('degraded');
  expect(service.isAttachmentReady(binding)).toBe(true);
  await service.handleWorkerEvent('w1', { type: 'catalogRefreshStatus', accountId: 'a', workerInstanceId: 'w1', controlEpoch: 1,
    state: 'ready', code: 'CATALOG_REFRESH_RECOVERED' });
  expect(statuses.at(-1)).toBe('connected');
  expect(service.isAttachmentReady(binding)).toBe(true);
});

function syncConfirmedService(options: { applySyncConfirmed?: (binding: unknown) => Promise<boolean>; diagnostics?: unknown[] } = {}) {
  const calls = { status: 0, syncConfirmed: [] as unknown[], pendingReads: 0 };
  const service = new BaseLineService({ async bindWorker() {}, async getAccount() { return { ownMid: 'u-self' }; },
    async applyWorkerLogin() { return true; },
    async applyWorkerConnectionStatus() { calls.status += 1; return true; },
    async applyWorkerSyncConfirmed(binding: unknown) { calls.syncConfirmed.push(binding); return await (options.applySyncConfirmed?.(binding) ?? true); },
  } as never,
  { async listPendingRouteActions() { calls.pendingReads += 1; return []; }, async applyPendingRouteAction() {} } as never,
  {} as never, { async send() {} }, { kick() {}, async stopChat() {}, async resetChat() {} },
  undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, 'en',
  (diagnostic) => { options.diagnostics?.push(diagnostic); });
  return { service, calls };
}

it('persists a current syncConfirmed event without a connection status write', async () => {
  const { service, calls } = syncConfirmedService();
  const binding = { accountId: 'a-sync', workerInstanceId: 'w-sync', controlEpoch: 1, mode: 'MONITOR_ONLY' as const };
  await service.bind(binding);
  const statusBefore = calls.status;
  await service.handleWorkerEvent('w-sync', { type: 'syncConfirmed', accountId: 'a-sync', workerInstanceId: 'w-sync', controlEpoch: 1 });
  expect(calls.syncConfirmed).toEqual([binding]);
  expect(calls.status).toBe(statusBefore);
  expect(service.binding('a-sync')).toBeDefined();
});

it('reports a persist diagnostic and does not throw when the syncConfirmed write rejects or returns false', async () => {
  const diagnostics: unknown[] = [];
  const { service, calls } = syncConfirmedService({ diagnostics, applySyncConfirmed: async () => { throw new Error('database outage'); } });
  const binding = { accountId: 'a-sync-fail', workerInstanceId: 'w-sync-fail', controlEpoch: 1, mode: 'MONITOR_ONLY' as const };
  await service.bind(binding);
  const event = { type: 'syncConfirmed' as const, accountId: 'a-sync-fail', workerInstanceId: 'w-sync-fail', controlEpoch: 1 };
  await expect(service.handleWorkerEvent('w-sync-fail', event)).resolves.toBeUndefined();
  expect(calls.syncConfirmed).toHaveLength(1);
  expect(diagnostics).toHaveLength(1);
  expect(diagnostics[0]).toMatchObject({ stage: 'persist' });
  expect(service.binding('a-sync-fail')).toBeDefined();
  const refused = syncConfirmedService({ applySyncConfirmed: async () => false });
  await refused.service.bind(binding);
  await expect(refused.service.handleWorkerEvent('w-sync-fail', event)).resolves.toBeUndefined();
  expect(refused.service.binding('a-sync-fail')).toBeDefined();
});

it('does not start pending action recovery for a syncConfirmed event in ACTIVE_CONTROL mode', async () => {
  const { service, calls } = syncConfirmedService();
  const binding = { accountId: 'a-sync-active', workerInstanceId: 'w-sync-active', controlEpoch: 1, mode: 'ACTIVE_CONTROL' as const };
  await service.bind(binding);
  await vi.waitFor(() => expect(calls.pendingReads).toBeGreaterThan(0));
  const reads = calls.pendingReads;
  await service.handleWorkerEvent('w-sync-active', { type: 'syncConfirmed', accountId: 'a-sync-active',
    workerInstanceId: 'w-sync-active', controlEpoch: 1 });
  expect(calls.syncConfirmed).toHaveLength(1);
  expect(calls.pendingReads).toBe(reads);
});

it('ignores a stale syncConfirmed event from another worker instance', async () => {
  const { service, calls } = syncConfirmedService();
  const binding = { accountId: 'a-sync-stale', workerInstanceId: 'w-sync-stale', controlEpoch: 1, mode: 'MONITOR_ONLY' as const };
  await service.bind(binding);
  await service.handleWorkerEvent('w-sync-stale', { type: 'syncConfirmed', accountId: 'a-sync-stale', workerInstanceId: 'w-old', controlEpoch: 1 });
  await service.handleWorkerEvent('w-sync-stale', { type: 'syncConfirmed', accountId: 'a-sync-stale', workerInstanceId: 'w-sync-stale', controlEpoch: 0 });
  await service.handleWorkerEvent('w-old', { type: 'syncConfirmed', accountId: 'a-sync-stale', workerInstanceId: 'w-old', controlEpoch: 1 });
  expect(calls.syncConfirmed).toEqual([]);
});

it('exposes accepted native login readiness for manual send admission and clears it on reconnect', async () => {
  const service = new LineService({ async bindWorker() {}, async getAccount() { return { ownMid: 'u-self' }; },
    async applyWorkerLogin() { return true; } } as never,
    { async listPendingRouteActions() { return []; }, async applyPendingRouteAction() {} } as never,
    {} as never, { async send() {} }, { kick() {}, async stopChat() {}, async resetChat() {} });
  const binding = { accountId: 'manual-ready', workerInstanceId: 'manual-worker', controlEpoch: 1, mode: 'MONITOR_ONLY' as const };
  service.bind(binding);
  expect(service.isAuthenticatedReady(binding)).toBe(false);
  await service.handleWorkerEvent(binding.workerInstanceId, { type: 'login', ...binding,
    loginAttemptId: 'manual-login', ownMid: 'u-self', displayName: 'Admin' });
  expect(service.isAuthenticatedReady(binding)).toBe(false);
  await service.handleWorkerEvent(binding.workerInstanceId, { type: 'status', ...binding, state: 'ready', message: null });
  expect(service.isAuthenticatedReady(binding)).toBe(true);
  await service.handleWorkerEvent(binding.workerInstanceId, { type: 'status', ...binding, state: 'connecting', message: null });
  expect(service.isAuthenticatedReady(binding)).toBe(false);
});

it('does not let catalog recovery clear a degraded transport, and clears either health only after its own recovery', async () => {
  const statuses: string[] = [];
  const service = new LineService({ async bindWorker() {}, async getAccount() { return { ownMid: 'u-self' }; },
    async applyWorkerLogin() { return true; }, async applyWorkerConnectionStatus(_binding: unknown, status: 'connected' | 'degraded' | 'disconnected') {
      statuses.push(status); return true;
    } } as never,
    { async listPendingRouteActions() { return []; }, async applyPendingRouteAction() {} } as never,
    {} as never, { async send() {} }, { kick() {}, async stopChat() {}, async resetChat() {} });
  const binding = { accountId: 'a-health-compose', workerInstanceId: 'w-health-compose', controlEpoch: 1, mode: 'ACTIVE_CONTROL' as const };
  service.bind(binding);
  await service.handleWorkerEvent(binding.workerInstanceId, { type: 'login', ...binding,
    loginAttemptId: 'health-compose-login', ownMid: 'u-self', displayName: 'Agent' });
  await service.handleWorkerEvent(binding.workerInstanceId, { type: 'status', ...binding, state: 'ready', message: null });
  await service.handleWorkerEvent(binding.workerInstanceId, { type: 'catalogRefreshStatus', ...binding,
    state: 'degraded', code: 'CATALOG_REFRESH_FAILED' });
  await service.handleWorkerEvent(binding.workerInstanceId, { type: 'status', ...binding, state: 'degraded', message: null });
  await service.handleWorkerEvent(binding.workerInstanceId, { type: 'catalogRefreshStatus', ...binding,
    state: 'ready', code: 'CATALOG_REFRESH_RECOVERED' });
  expect(statuses.at(-1)).toBe('degraded');
  expect(service.isAttachmentReady(binding)).toBe(true);

  await service.handleWorkerEvent(binding.workerInstanceId, { type: 'status', ...binding, state: 'ready', message: null });
  expect(statuses.at(-1)).toBe('connected');
  await service.handleWorkerEvent(binding.workerInstanceId, { type: 'catalogRefreshStatus', ...binding,
    state: 'degraded', code: 'CATALOG_REFRESH_FAILED' });
  expect(service.isAttachmentReady(binding)).toBe(true);
  await service.handleWorkerEvent(binding.workerInstanceId, { type: 'status', ...binding, state: 'ready', message: null });
  expect(statuses.at(-1)).toBe('degraded');
  await service.handleWorkerEvent(binding.workerInstanceId, { type: 'catalogRefreshStatus', ...binding,
    state: 'ready', code: 'CATALOG_REFRESH_RECOVERED' });
  expect(statuses.at(-1)).toBe('connected');
});

it('persists the latest transport health after a held catalog-recovery write', async () => {
  let holdConnected = false;
  let enterHeldWrite!: () => void;
  let releaseHeldWrite!: () => void;
  const heldWriteEntered = new Promise<void>((resolve) => { enterHeldWrite = resolve; });
  const heldWrite = new Promise<void>((resolve) => { releaseHeldWrite = resolve; });
  let persisted: string | null = null;
  const writes: string[] = [];
  let activeWrites = 0;
  let maxConcurrentWrites = 0;
  const service = new LineService({ async bindWorker() {}, async getAccount() { return { ownMid: 'u-self' }; },
    async applyWorkerLogin() { return true; }, async applyWorkerConnectionStatus(_binding: unknown, status: string) {
      activeWrites += 1;
      maxConcurrentWrites = Math.max(maxConcurrentWrites, activeWrites);
      try {
        if (holdConnected && status === 'connected') { holdConnected = false; enterHeldWrite(); await heldWrite; }
        persisted = status;
        writes.push(status);
        return true;
      } finally { activeWrites -= 1; }
    } } as never,
    { async listPendingRouteActions() { return []; }, async applyPendingRouteAction() {} } as never,
    {} as never, { async send() {} }, { kick() {}, async stopChat() {}, async resetChat() {} });
  const binding = { accountId: 'catalog-write-race', workerInstanceId: 'catalog-write-worker', controlEpoch: 1, mode: 'ACTIVE_CONTROL' as const };
  service.bind(binding);
  await service.handleWorkerEvent(binding.workerInstanceId, { type: 'login', ...binding,
    loginAttemptId: 'catalog-write-login', ownMid: 'u-self', displayName: 'Agent' });
  await service.handleWorkerEvent(binding.workerInstanceId, { type: 'status', ...binding, state: 'ready', message: null });
  await service.handleWorkerEvent(binding.workerInstanceId, { type: 'catalogRefreshStatus', ...binding,
    state: 'degraded', code: 'CATALOG_REFRESH_FAILED' });
  await vi.waitFor(() => expect(activeWrites).toBe(0));

  const completedBeforeRace = writes.length;
  holdConnected = true;
  const recovered = service.handleWorkerEvent(binding.workerInstanceId, { type: 'catalogRefreshStatus', ...binding,
    state: 'ready', code: 'CATALOG_REFRESH_RECOVERED' });
  await heldWriteEntered;
  await recovered;
  await service.handleWorkerEvent(binding.workerInstanceId, { type: 'status', ...binding, state: 'degraded', message: null });
  releaseHeldWrite();
  await vi.waitFor(() => {
    expect(activeWrites).toBe(0);
    expect(writes.length).toBe(completedBeforeRace + 2);
  });
  expect(writes.slice(completedBeforeRace)).toEqual(['connected', 'degraded']);
  expect(persisted).toBe('degraded');
  expect(maxConcurrentWrites).toBe(1);
});

it('persists the latest catalog health after a held transport-recovery write', async () => {
  let holdConnected = false;
  let enterHeldWrite!: () => void;
  let releaseHeldWrite!: () => void;
  const heldWriteEntered = new Promise<void>((resolve) => { enterHeldWrite = resolve; });
  const heldWrite = new Promise<void>((resolve) => { releaseHeldWrite = resolve; });
  let persisted: string | null = null;
  const writes: string[] = [];
  let activeWrites = 0;
  let maxConcurrentWrites = 0;
  const service = new LineService({ async bindWorker() {}, async getAccount() { return { ownMid: 'u-self' }; },
    async applyWorkerLogin() { return true; }, async applyWorkerConnectionStatus(_binding: unknown, status: string) {
      activeWrites += 1;
      maxConcurrentWrites = Math.max(maxConcurrentWrites, activeWrites);
      try {
        if (holdConnected && status === 'connected') { holdConnected = false; enterHeldWrite(); await heldWrite; }
        persisted = status;
        writes.push(status);
        return true;
      } finally { activeWrites -= 1; }
    } } as never,
    { async listPendingRouteActions() { return []; }, async applyPendingRouteAction() {} } as never,
    {} as never, { async send() {} }, { kick() {}, async stopChat() {}, async resetChat() {} });
  const binding = { accountId: 'transport-write-race', workerInstanceId: 'transport-write-worker', controlEpoch: 1, mode: 'ACTIVE_CONTROL' as const };
  service.bind(binding);
  await service.handleWorkerEvent(binding.workerInstanceId, { type: 'login', ...binding,
    loginAttemptId: 'transport-write-login', ownMid: 'u-self', displayName: 'Agent' });
  await service.handleWorkerEvent(binding.workerInstanceId, { type: 'status', ...binding, state: 'degraded', message: null });
  await vi.waitFor(() => expect(activeWrites).toBe(0));
  const completedBeforeRace = writes.length;
  holdConnected = true;
  const recovered = service.handleWorkerEvent(binding.workerInstanceId, { type: 'status', ...binding, state: 'ready', message: null });
  await heldWriteEntered;
  await recovered;
  await service.handleWorkerEvent(binding.workerInstanceId, { type: 'catalogRefreshStatus', ...binding,
    state: 'degraded', code: 'CATALOG_REFRESH_FAILED' });
  releaseHeldWrite();
  await vi.waitFor(() => {
    expect(activeWrites).toBe(0);
    expect(writes.length).toBe(completedBeforeRace + 2);
  });
  expect(writes.slice(completedBeforeRace)).toEqual(['connected', 'degraded']);
  expect(persisted).toBe('degraded');
  expect(maxConcurrentWrites).toBe(1);
});

it('keeps the binding and attachment readiness when catalog health persistence rejects, then handles the next batch', async () => {
  let rejectHealthWrite = false;
  let finishRejectedWrite!: () => void;
  const rejectedWriteFinished = new Promise<void>((resolve) => { finishRejectedWrite = resolve; });
  let healthWriteAttempts = 0;
  const commands: LineWorkerCommand[] = [];
  const archived: string[] = [];
  const service = new LineService({ async bindWorker() {}, async getAccount() { return { ownMid: 'u-self' }; },
    async applyWorkerLogin() { return true; }, async applyWorkerConnectionStatus() {
      healthWriteAttempts += 1;
      if (rejectHealthWrite) {
        rejectHealthWrite = false;
        finishRejectedWrite();
        throw new Error('temporary database outage');
      }
      return true;
    } } as never,
    { async listPendingRouteActions() { return []; }, async applyPendingRouteAction() {},
      async ingestBatchAndRoute(event: Extract<LineWorkerEvent, { type: 'batch' }>) {
        archived.push(...event.envelopes.map((envelope) => envelope.messageId));
        return { inserted: event.envelopes.length, duplicate: 0,
          insertedMessageIds: event.envelopes.map((envelope) => envelope.messageId), jobIds: [], jobMessageIds: [] };
      } } as never,
    { async getAppSetting() { return undefined; }, async getConversationAgent() { return { enabled: false, provider: 'codex' }; } } as never,
    { async send(command) { commands.push(command); } }, { kick() {}, async stopChat() {}, async resetChat() {} });
  const binding = { accountId: 'catalog-db-rejection', workerInstanceId: 'catalog-db-worker', controlEpoch: 1, mode: 'ACTIVE_CONTROL' as const };
  service.bind(binding);
  await service.handleWorkerEvent(binding.workerInstanceId, { type: 'login', ...binding,
    loginAttemptId: 'catalog-db-login', ownMid: 'u-self', displayName: 'Agent' });
  await service.handleWorkerEvent(binding.workerInstanceId, { type: 'status', ...binding, state: 'ready', message: null });
  await vi.waitFor(() => expect(service.isAttachmentReady(binding)).toBe(true));
  rejectHealthWrite = true;
  await service.handleWorkerEvent(binding.workerInstanceId, { type: 'catalogRefreshStatus', ...binding,
    state: 'degraded', code: 'CATALOG_REFRESH_FAILED' });
  await rejectedWriteFinished;

  expect(service.binding(binding.accountId)).toMatchObject({ workerInstanceId: binding.workerInstanceId });
  expect(service.isAttachmentReady(binding)).toBe(true);
  expect(healthWriteAttempts).toBe(2);
  await service.handleWorkerEvent(binding.workerInstanceId, { ...batch(), ...binding });

  expect(archived).toEqual(['m1']);
  expect(commands).toContainEqual(expect.objectContaining({ type: 'ackBatch', batchId: 'b1' }));
  expect(healthWriteAttempts).toBe(2);
});

it('projects a current login failure through the existing transport health composition', async () => {
  const statuses: string[] = [];
  const binding = { accountId: 'a-login-failure', workerInstanceId: 'w-login-failure', controlEpoch: 1, mode: 'ACTIVE_CONTROL' as const };
  const service = new LineService({ async bindWorker() {}, async applyWorkerConnectionStatus(_binding: unknown, status: 'connected' | 'degraded' | 'disconnected') {
    statuses.push(status); return true;
  } } as never, { async listPendingRouteActions() { return []; }, async applyPendingRouteAction() {} } as never,
    {} as never, { async send() {} }, { kick() {}, async stopChat() {}, async resetChat() {} });
  await service.bind(binding);
  await service.requestQrLogin(binding.accountId, binding.workerInstanceId, 'failure-attempt');
  await service.handleWorkerEvent(binding.workerInstanceId, { type: 'loginFailure', ...binding,
    loginAttemptId: 'failure-attempt', code: 'LOGIN_FAILED', message: 'LINE login failed. Try again.' });

  await vi.waitFor(() => expect(statuses).toEqual(['degraded']));
  expect(statuses).toEqual(['degraded']);
});

it('sends a reaction using the currently bound active LINE worker', async () => {
  const commands: LineWorkerCommand[] = [];
  const service = new LineService({ async bindWorker() {} } as never, {} as never, {} as never,
    { async send(command) { commands.push(command); } }, { kick() {}, async stopChat() {}, async resetChat() {} });
  await service.bind({ accountId: 'a', workerInstanceId: 'w1', controlEpoch: 1, mode: 'ACTIVE_CONTROL' });

  await service.reactToMessage({ accountId: 'a', chatType: 'direct', chatId: 'c' }, '9', 'AMAZING');

  expect(commands).toMatchObject([{ type: 'reactMessage', accountId: 'a', workerInstanceId: 'w1', controlEpoch: 1,
    chatType: 'direct', chatId: 'c', messageId: '9', reaction: 'AMAZING' }]);
  expect(LineWorkerCommandSchema.safeParse(commands[0]).success).toBe(true);
});

it('does not send an existing job reaction after EXTERNAL_MONITOR is selected', async () => {
  const commands: LineWorkerCommand[] = [];
  const service = new LineService({ async bindWorker() {}, async resolveCapabilities() {
    return { connectionMode: 'EXTERNAL_MONITOR', canWriteLine: false };
  } } as never, {} as never, {} as never,
  { async send(command) { commands.push(command); } }, { kick() {}, async stopChat() {}, async resetChat() {} });
  await service.bind({ accountId: 'a', workerInstanceId: 'w1', controlEpoch: 1, mode: 'ACTIVE_CONTROL' });

  await service.reactToMessage({ accountId: 'a', chatType: 'direct', chatId: 'c' }, 'existing-job-message', 'SAD');

  expect(commands).toEqual([]);
});

database('LineService transaction and worker identity', () => {
  let pool: Pool; let close: () => Promise<void>; let accounts: AccountRepository; let messages: MessageRepository;
  let settings: SettingsRepository; let admins: AdminRepository; let whitelist: FriendWhitelistRepository;
  let loginSourceId: string;
  beforeAll(async () => { ({ pool, close } = await createTestDatabase()); accounts = new AccountRepository(pool);
    messages = new MessageRepository(pool); settings = new SettingsRepository(pool); admins = new AdminRepository(pool);
    whitelist = new FriendWhitelistRepository(pool);
    await accounts.ensureAccount('a');
    await pool.query("UPDATE line_accounts SET product_role='AGENT' WHERE account_id='a'");
    await accounts.activateControl('a', 1); await accounts.setOwnMid('a', 'agent-mid');
    await accounts.bindWorker({ accountId: 'a', workerInstanceId: 'w1', controlEpoch: 1 });
    await accounts.applyWorkerLogin({ accountId: 'a', workerInstanceId: 'w1', controlEpoch: 1 }, 'agent-mid', 'Agent');
    loginSourceId = (await pool.query("SELECT selected_source_id FROM line_accounts WHERE account_id='a'")).rows[0]!.selected_source_id;
    await messages.ingestAndRoute({ ...batch().envelopes[0]!, messageId: 'seed', eventId: 'seed' }, { eligible: false });
    await settings.setAppSetting('workspace_path', 'C:\\trusted');
    await settings.setConversationAgent({ accountId: 'a', chatType: 'direct', chatId: 'c', enabled: true, provider: 'codex' });
    await admins.bindPrimary('a', 'c', 'user'); });
  beforeEach(async () => {
    await pool.query('DELETE FROM message_source_provenance WHERE source_id=$1', [loginSourceId]);
    await pool.query('DELETE FROM external_source_conflicts WHERE source_id=$1', [loginSourceId]);
    await pool.query('DELETE FROM external_source_observations WHERE source_id=$1', [loginSourceId]);
    await pool.query('DELETE FROM external_source_batches WHERE source_id=$1', [loginSourceId]);
    await pool.query("DELETE FROM sync_cursors WHERE account_id='a' AND source='live'");
    await pool.query('UPDATE external_source_checkpoints SET cursor=$2::jsonb WHERE source_id=$1',
      [loginSourceId, JSON.stringify(cursor('0'))]);
  });
  afterAll(async () => { await close?.(); });

  it('keeps an unavailable prompt terminal when its directory is restored before ingest, with replay acknowledged once per batch', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'line-workspace-restore-'));
    const authority = await WorkspaceAuthority.load(settings);
    await authority.configure(directory);
    await rm(directory, { recursive: true });
    const commands: LineWorkerCommand[] = []; const kicked: string[] = [];
    const original = messages.ingestBatchSource.bind(messages);
    const ingest = vi.spyOn(messages, 'ingestBatchSource').mockImplementation(async (...args) => {
      await mkdir(directory, { recursive: true });
      return original(...args);
    });
    const service = new BaseLineService(accounts, messages, settings, { async send(command) { commands.push(command); } },
      { kick(key) { kicked.push(key.chatId); }, async stopChat() {}, async resetChat() {} },
      undefined, undefined, undefined, admins, authority);
    const event = { ...batch(), batchId: 'restored-before-commit',
      envelopes: [{ ...batch().envelopes[0]!, eventId: 'restore-event', messageId: 'restore-message', text: 'do this' }] };
    try {
      await service.bind({ accountId: 'a', workerInstanceId: 'w1', controlEpoch: 1, mode: 'ACTIVE_CONTROL' });
      await service.handleWorkerEvent('w1', event);
      expect(await authority.inspect()).toMatchObject({ status: 'available' });
      await service.handleWorkerEvent('w1', event);
      const jobs = await pool.query(`SELECT j.status, count(e.event_id)::int events FROM agent_jobs j
        JOIN agent_events e ON e.job_id=j.job_id WHERE j.source_message_id='restore-message' GROUP BY j.job_id`);
      expect(jobs.rows).toEqual([{ status: 'failed', events: 1 }]);
      expect(kicked).toEqual([]);
      expect(commands.filter(command => command.type === 'ackBatch')).toHaveLength(2);
    } finally { ingest.mockRestore(); await rm(directory, { recursive: true, force: true }); }
  });

  it('restores operational readiness after a transient degraded status without another login', async () => {
    const service = new LineService(accounts, messages, settings, { async send() {} },
      { kick() {}, async stopChat() {}, async resetChat() {} });
    const binding = { accountId: 'a', workerInstanceId: 'readiness-worker', controlEpoch: 1, mode: 'ACTIVE_CONTROL' as const };
    const eventBinding = { accountId: binding.accountId, workerInstanceId: binding.workerInstanceId, controlEpoch: binding.controlEpoch };
    await service.bind(binding);
    await service.handleWorkerEvent('readiness-worker', { type: 'login', ...eventBinding, loginAttemptId: 'readiness-login-1', ownMid: 'agent-mid', displayName: null });
    await service.handleWorkerEvent('readiness-worker', { type: 'status', ...eventBinding, state: 'ready', message: null });
    expect(service.isAttachmentReady(binding)).toBe(true);
    await service.handleWorkerEvent('readiness-worker', { type: 'status', ...eventBinding, state: 'degraded', message: 'temporary network loss' });
    expect(service.isAuthenticatedReady(binding)).toBe(false);
    expect(service.isAttachmentReady(binding)).toBe(true);
    await service.handleWorkerEvent('readiness-worker', { type: 'status', ...eventBinding, state: 'ready', message: null });
    expect(service.isAttachmentReady(binding)).toBe(true);
    await service.handleWorkerEvent('readiness-worker', { type: 'error', accountId: 'a', workerInstanceId: 'readiness-worker',
      controlEpoch: 1, code: 'WORKER_OPERATION_FAILED', message: 'temporary worker error', retryable: true });
    expect(service.isAuthenticatedReady(binding)).toBe(true);
    expect(service.isAttachmentReady(binding)).toBe(true);
    await service.handleWorkerEvent('readiness-worker', { type: 'status', ...eventBinding, state: 'ready', message: null });
    expect(service.isAttachmentReady(binding)).toBe(true);
    await service.handleWorkerEvent('readiness-worker', { type: 'status', ...eventBinding, state: 'connecting', message: null });
    await service.handleWorkerEvent('readiness-worker', { type: 'status', ...eventBinding, state: 'ready', message: null });
    expect(service.isAttachmentReady(binding)).toBe(false);
    await service.handleWorkerEvent('readiness-worker', { type: 'login', accountId: 'a', workerInstanceId: 'readiness-worker',
      controlEpoch: 1, loginAttemptId: 'readiness-login-2', ownMid: 'agent-mid', displayName: null });
    await service.handleWorkerEvent('readiness-worker', { type: 'status', ...eventBinding, state: 'ready', message: null });
    expect(service.isAttachmentReady(binding)).toBe(true);
    await service.handleWorkerEvent('readiness-worker', { type: 'status', ...eventBinding, state: 'disconnected', message: null });
    await service.handleWorkerEvent('readiness-worker', { type: 'status', ...eventBinding, state: 'ready', message: null });
    expect(service.isAttachmentReady(binding)).toBe(false);
    await service.handleWorkerEvent('readiness-worker', { type: 'login', accountId: 'a', workerInstanceId: 'readiness-worker',
      controlEpoch: 1, loginAttemptId: 'readiness-login-3', ownMid: 'agent-mid', displayName: null });
    await service.handleWorkerEvent('readiness-worker', { type: 'status', ...eventBinding, state: 'ready', message: null });
    expect(service.isAttachmentReady(binding)).toBe(true);
    await service.handleWorkerEvent('readiness-worker', { type: 'status', ...eventBinding, state: 'PROTOCOL_UNVERIFIED', message: 'protocol mismatch' });
    expect(service.isAttachmentReady(binding)).toBe(false);
    await service.handleWorkerEvent('readiness-worker', { type: 'authInvalidated', ...eventBinding });
    expect(service.isAttachmentReady(binding)).toBe(false);
  });

  it('makes login durable before a later attachment download starts', async () => {
    let service!: LineService;
    const started: boolean[] = [];
    service = new LineService(accounts, messages, settings, { async send() {} },
      { kick() {}, async stopChat() {}, async resetChat() {} }, undefined,
      { async downloadById() { started.push(service.isAttachmentReady(binding)); return true; } });
    const binding = { accountId: 'a', workerInstanceId: 'attachment-login-worker', controlEpoch: 1, mode: 'ACTIVE_CONTROL' as const };
    const eventBinding = { accountId: binding.accountId, workerInstanceId: binding.workerInstanceId, controlEpoch: binding.controlEpoch };
    await service.bind(binding);
    await service.handleWorkerEvent(binding.workerInstanceId, { type: 'login', ...eventBinding,
      loginAttemptId: 'attachment-login-1', ownMid: 'agent-mid', displayName: null });
    await service.handleWorkerEvent(binding.workerInstanceId, { type: 'status', ...eventBinding, state: 'ready', message: null });
    await service.handleWorkerEvent(binding.workerInstanceId, { ...batch(), workerInstanceId: binding.workerInstanceId,
      batchId: 'attachment-after-login', cursorAfter: cursor('901'),
      envelopes: [{ ...batch().envelopes[0]!, eventId: 'attachment-after-login-event', messageId: 'attachment-after-login-message',
        kind: 'file', text: null,
        attachments: [{ id: 'attachment-after-login-file', kind: 'file', name: 'report.pdf', mimeType: 'application/pdf', sizeBytes: 12 }] }] });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(started).toEqual([true]);
  });

  it('acks only after atomic commit and re-kicks a durable queued job on replay', async () => {
    const commands: LineWorkerCommand[] = []; const kicked: string[] = [];
    const service = new LineService(accounts, messages, settings, {
      async send(command) { commands.push(command); },
    }, { kick(key) { kicked.push(key.chatId); }, async stopChat() {}, async resetChat() {} }, undefined, undefined, undefined, admins);
    service.bind({ accountId: 'a', workerInstanceId: 'w1', controlEpoch: 1, mode: 'ACTIVE_CONTROL' });
    const inserted = await service.handleWorkerEvent('w1', batch());
    const duplicate = await service.handleWorkerEvent('w1', batch());
    expect(inserted).toEqual(['m1']);
    expect(duplicate).toEqual([]);
    expect(commands).toMatchObject([{ type: 'ackBatch', batchId: 'b1', cursorAfter: cursor('1') }, { type: 'ackBatch', batchId: 'b1' }]);
    expect(kicked).toEqual(['c', 'c']);
    const rows = await pool.query("SELECT count(*) FROM agent_jobs WHERE source_message_id='m1'");
    expect(rows.rows[0].count).toBe('1');
  });

  it('does not route a direct message from a non-primary sender', async () => {
    const kicked: string[] = [];
    const service = new LineService(accounts, messages, settings, { async send() {} },
      { kick(key) { kicked.push(key.chatId); }, async stopChat() {}, async resetChat() {} },
      undefined, undefined, undefined, admins);
    service.bind({ accountId: 'a', workerInstanceId: 'w1', controlEpoch: 1, mode: 'ACTIVE_CONTROL' });
    const input = { ...batch(), batchId: 'non-admin-direct', cursorAfter: cursor('20'), envelopes: [
      { ...batch().envelopes[0]!, eventId: 'non-admin-event', messageId: 'non-admin-message', senderId: 'intruder' },
    ] };
    await service.handleWorkerEvent('w1', input);
    expect(kicked).toEqual([]);
    const jobs = await pool.query("SELECT count(*) FROM agent_jobs WHERE source_message_id='non-admin-message'");
    expect(jobs.rows[0].count).toBe('0');
  });

  it('archives a consumed administrator pairing token without creating an Agent job', async () => {
    const kicked: string[] = [];
    const service = new LineService(accounts, messages, settings, { async send() {} },
      { kick(key) { kicked.push(key.chatId); }, async stopChat() {}, async resetChat() {} },
      undefined, undefined, async (envelope) => envelope.text === '654321', admins);
    service.bind({ accountId: 'a', workerInstanceId: 'w1', controlEpoch: 1, mode: 'ACTIVE_CONTROL' });
    await service.handleWorkerEvent('w1', { ...batch(), batchId: 'pairing-token', cursorAfter: cursor('22'), envelopes: [
      { ...batch().envelopes[0]!, eventId: 'pairing-token-event', messageId: 'pairing-token-message', text: '654321' },
    ] });
    expect(kicked).toEqual([]);
    const jobs = await pool.query("SELECT count(*) FROM agent_jobs WHERE source_message_id='pairing-token-message'");
    expect(jobs.rows[0].count).toBe('0');
    const stored = await pool.query("SELECT text_content FROM messages WHERE account_id='a' AND message_id='pairing-token-message'");
    expect(stored.rows).toEqual([{ text_content: '654321' }]);
  });

  it('sanitizes room activation candidates before callbacks, archive/search, and provider routing', async () => {
    const token = `RA-${'A'.repeat(43)}`;
    const callbacks: string[] = [];
    const kicked: string[] = [];
    await messages.upsertConversationCatalog('a', [{ chatType: 'group', chatId: 'activation-room',
      title: 'Activation room', members: [] }]);
    await settings.setConversationAgent({ accountId: 'a', chatType: 'group', chatId: 'activation-room', enabled: true, provider: 'codex' });
    const service = new LineService(accounts, messages, settings, { async send() {} },
      { kick(key) { kicked.push(key.chatId); }, async stopChat() {}, async resetChat() {} }, undefined, undefined,
      async (envelope) => { callbacks.push(`${envelope.text}|${JSON.stringify(envelope.raw)}`); return false; }, admins);
    service.bind({ accountId: 'a', workerInstanceId: 'w1', controlEpoch: 1, mode: 'ACTIVE_CONTROL' });
    const base = { ...batch().envelopes[0]!, chatType: 'group' as const, chatId: 'activation-room', senderId: 'member' };
    await service.handleWorkerEvent('w1', { ...batch(), batchId: 'activation-controls', cursorAfter: cursor('23'), envelopes: [
      { ...base, eventId: 'activation-request-event', messageId: 'activation-request', text: '@Agent monitor',
        mentionIds: ['agent-mid'], mentionRanges: [{ start: 0, end: 6, userId: 'agent-mid' }], raw: { message: { text: '@Agent monitor' } } },
      { ...base, eventId: 'activation-copied-event', messageId: 'activation-copied', text: `copied ${token}`,
        mentionIds: [], mentionRanges: [], raw: { copied: token } },
    ] });

    expect(kicked).toEqual([]);
    expect(callbacks.join('\n')).not.toContain(token);
    const stored = await pool.query('SELECT message_id,text_content,raw::text FROM messages WHERE message_id = ANY($1::text[]) ORDER BY message_id',
      [['activation-request', 'activation-copied']]);
    expect(stored.rows).toHaveLength(2);
    expect(stored.rows.map((row) => `${row.text_content}|${row.raw}`).join('\n')).not.toContain(token);
    const searchable = await messages.searchMessages({ key: { accountId: 'a', chatType: 'group', chatId: 'activation-room' },
      text: token, limit: 20 });
    expect(searchable).toEqual([]);
    const jobs = await pool.query("SELECT count(*) FROM agent_jobs WHERE source_message_id = ANY($1::text[])",
      [['activation-request', 'activation-copied']]);
    expect(jobs.rows[0].count).toBe('0');
  });

  it('archives live activation requests before dispatching them without blocking the receive ACK', async () => {
    const commands: LineWorkerCommand[] = [];
    const received: string[] = [];
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => { release = resolve; });
    await messages.upsertConversationCatalog('a', [{ chatType: 'group', chatId: 'live-activation-room',
      title: 'Activation room', members: [] }]);
    const service = new BaseLineService(accounts, messages, settings, { async send(command) { commands.push(command); } },
      { kick() {}, async stopChat() {}, async resetChat() {} }, undefined, undefined, undefined, admins,
      { async inspect() { return { status: 'available', version: 0, path: 'C:\\trusted' }; } },
      { async handle(command: import('./room-control.js').RoomActivationCommand) { received.push(command.messageId); await blocked; } } as never);
    const live = { ...batch().envelopes[0]!, chatType: 'group' as const, chatId: 'live-activation-room',
      messageId: 'live-activation-message', eventId: 'live-activation-event',
      senderId: 'member', text: '@Agent monitor', mentionIds: ['agent-mid'],
      mentionRanges: [{ start: 0, end: 6, userId: 'agent-mid' }] };
    expect(classifyRoomControl(live, 'agent-mid', 'a')).toMatchObject({ type: 'command', command: { type: 'request' } });
    service.bind({ accountId: 'a', workerInstanceId: 'activation-worker', controlEpoch: 1, mode: 'ACTIVE_CONTROL' });
    await service.handleWorkerEvent('activation-worker', { ...batch(), workerInstanceId: 'activation-worker', batchId: 'live-activation', cursorAfter: cursor('950'),
      envelopes: [live] });

    expect(received).toEqual(['live-activation-message']);
    expect(commands.at(-1)).toMatchObject({ type: 'ackBatch', batchId: 'live-activation' });
    const archived = await pool.query("SELECT count(*) FROM messages WHERE account_id='a' AND message_id='m1'");
    expect(archived.rows[0].count).toBe('1');
    release();
  });

  it('admits a PRIMARY_ADMIN group mention without room activation or friend authorization', async () => {
    await messages.upsertConversationCatalog('a', [{ chatType: 'group', chatId: 'admin-room',
      title: 'Admin room', members: [] }]);
    const kicked: string[] = [];
    const service = new LineService(accounts, messages, settings, { async send() {} },
      { kick(key) { kicked.push(key.chatId); }, async stopChat() {}, async resetChat() {} }, undefined, undefined, undefined, admins);
    service.bind({ accountId: 'a', workerInstanceId: 'admin-room-worker', controlEpoch: 1, mode: 'ACTIVE_CONTROL' });
    const source = { ...batch().envelopes[0]!, eventId: 'primary-admin-room-event', messageId: 'primary-admin-room-message',
      chatType: 'group' as const, chatId: 'admin-room', senderId: 'user', text: '@Agent do this', mentionIds: ['agent-mid'],
      mentionRanges: [{ start: 0, end: 6, userId: 'agent-mid' }] };
    await service.handleWorkerEvent('admin-room-worker', { ...batch(), workerInstanceId: 'admin-room-worker', batchId: 'primary-admin-room', cursorAfter: cursor('951'), envelopes: [source] });
    const jobs = await pool.query("SELECT count(*) FROM agent_jobs WHERE source_message_id='primary-admin-room-message'");
    expect(kicked).toEqual(['admin-room']);
    expect(jobs.rows[0].count).toBe('1');
  });

  it('rechecks primary-admin binding changes at ingest for prompts, workspace failures, and group controls', async () => {
    const cases = [
      { name: 'prompt', text: '@Agent do work', mode: 'available', change: 'revoke' },
      { name: 'workspace-failure', text: '@Agent do work', mode: 'unavailable', change: 'replace' },
      { name: 'stop', text: '@Agent /stop', mode: 'available', change: 'revoke' },
      { name: 'new', text: '@Agent /new', mode: 'available', change: 'replace' },
      { name: 'status', text: '@Agent /status', mode: 'available', change: 'revoke' },
    ] as const;
    let cursorBefore = '0';
    for (const testCase of cases) {
      const messageId = `admin-race-${testCase.name}`;
      const commands: LineWorkerCommand[] = [];
      const effects: string[] = [];
      const replies: string[] = [];
      const workerId = `admin-race-worker-${testCase.name}`;
      const original = messages.admitLiveBatch.bind(messages);
      const ingest = vi.spyOn(messages, 'admitLiveBatch').mockImplementation(async (...args) => {
        if (testCase.change === 'revoke') {
          await pool.query("DELETE FROM account_administrators WHERE account_id='a' AND role='PRIMARY_ADMIN'");
        } else {
          await pool.query("UPDATE account_administrators SET user_id='replacement-admin' WHERE account_id='a' AND role='PRIMARY_ADMIN'");
        }
        return original(...args);
      });
      const workspace = testCase.mode === 'unavailable' ? {
        async inspect() { return { status: 'unavailable' as const, version: 0, configuredPath: 'C:\\missing', reason: 'missing' }; },
      } : undefined;
      const service = new BaseLineService(accounts, messages, settings,
        { async send(command) { commands.push(command); } },
        { kick() {}, async stopChat() { effects.push('stop'); }, async resetChat() { effects.push('new'); },
          async getChatStatus() { effects.push('status'); return { runningJobId: null }; } },
        undefined, undefined, undefined, admins, workspace,
        { async handle() {}, async isEnabled() { return false; }, async respond(_envelope, body) { replies.push(body); } }, whitelist);
      try {
        await service.bind({ accountId: 'a', workerInstanceId: workerId, controlEpoch: 1, mode: 'ACTIVE_CONTROL' });
        const source = { ...batch().envelopes[0]!, eventId: `${messageId}-event`, messageId,
          chatType: 'group' as const, chatId: 'admin-race-room', senderId: 'user', text: testCase.text,
          mentionIds: ['agent-mid'], mentionRanges: [{ start: 0, end: 6, userId: 'agent-mid' }] };
        await service.handleWorkerEvent(workerId, { ...batch(), workerInstanceId: workerId,
          batchId: `${messageId}-batch`, cursorBefore: cursor(cursorBefore), cursorAfter: cursor('970'), envelopes: [source] });
        cursorBefore = '970';
      } finally {
        ingest.mockRestore();
        const restored = await pool.query("UPDATE account_administrators SET user_id='user' WHERE account_id='a' AND role='PRIMARY_ADMIN'");
        if (!restored.rowCount) await admins.bindPrimary('a', 'c', 'user');
      }
      expect((await pool.query('SELECT action FROM message_routes WHERE account_id=$1 AND message_id=$2', ['a', messageId])).rows[0]?.action)
        .toBe('ignore');
      expect((await pool.query('SELECT count(*) FROM agent_jobs WHERE account_id=$1 AND source_message_id=$2', ['a', messageId])).rows[0]?.count)
        .toBe('0');
      expect(effects).toEqual([]);
      expect(commands.filter((command) => command.type === 'ackBatch')).toHaveLength(1);
      if (testCase.name === 'status') expect(commands.some((command) => command.type === 'sendText')).toBe(false);
    }
  });

  it('executes successful primary-admin group controls without the disabled-room fallback', async () => {
    const commands: LineWorkerCommand[] = [];
    const effects: string[] = [];
    const replies: string[] = [];
    const service = new BaseLineService(accounts, messages, settings,
      { async send(command) { commands.push(command); } },
      { kick() {}, async stopChat() { effects.push('stop'); }, async resetChat() { effects.push('new'); },
        async getChatStatus() { effects.push('status'); return { runningJobId: null }; } },
      undefined, undefined, undefined, admins, undefined,
      { async handle() {}, async isEnabled() { return false; }, async respond(_envelope, body) { replies.push(body); } }, whitelist);
    await service.bind({ accountId: 'a', workerInstanceId: 'admin-control-worker', controlEpoch: 1, mode: 'ACTIVE_CONTROL' });
    const source = (name: string) => ({ ...batch().envelopes[0]!, eventId: `${name}-event`, messageId: `admin-control-${name}`,
      chatType: 'group' as const, chatId: 'admin-control-room', senderId: 'user', text: `@Agent /${name}`,
      mentionIds: ['agent-mid'], mentionRanges: [{ start: 0, end: 6, userId: 'agent-mid' }] });
    let cursorBefore = '0';
    for (const [index, name] of ['stop', 'new', 'status'].entries()) {
      const cursorAfter = String(980 + index);
      await service.handleWorkerEvent('admin-control-worker', { ...batch(), workerInstanceId: 'admin-control-worker',
        batchId: `admin-control-${name}-batch`, cursorBefore: cursor(cursorBefore), cursorAfter: cursor(cursorAfter), envelopes: [source(name)] });
      cursorBefore = cursorAfter;
    }
    expect(effects).toEqual(['stop', 'new', 'status']);
    expect(replies).toEqual([]);
    expect((await pool.query("SELECT action FROM message_routes WHERE account_id='a' AND message_id LIKE 'admin-control-%' ORDER BY message_id")).rows)
      .toEqual([{ action: 'new' }, { action: 'status' }, { action: 'stop' }]);
  });

  it('admits direct PRIMARY_ADMIN messages as before and only active same-account whitelist members otherwise', async () => {
    const otherAccount = `whitelist-other-${Date.now()}`;
    await accounts.ensureAccount(otherAccount);
    await whitelist.activate('a', 'direct-member', 'user');
    await whitelist.activate(otherAccount, 'cross-account-member', 'admin-other');
    await settings.setConversationAgent({ accountId: 'a', chatType: 'direct', chatId: 'c', enabled: true, provider: 'codex' });
    const kicked: string[] = [];
    const service = new LineService(accounts, messages, settings, { async send() {} },
      { kick(key) { kicked.push(key.chatId); }, async stopChat() {}, async resetChat() {} }, undefined, undefined, undefined,
      admins, undefined, whitelist);
    service.bind({ accountId: 'a', workerInstanceId: 'whitelist-direct-worker', controlEpoch: 1, mode: 'ACTIVE_CONTROL' });
    const envelope = (messageId: string, senderId: string) => ({ ...batch().envelopes[0]!, eventId: `${messageId}-event`, messageId, senderId, text: 'do work' });
    await service.handleWorkerEvent('whitelist-direct-worker', { ...batch(), workerInstanceId: 'whitelist-direct-worker', batchId: 'whitelist-direct',
      cursorAfter: cursor('960'), envelopes: [envelope('direct-admin', 'user'), envelope('direct-allowed', 'direct-member'), envelope('direct-cross-account', 'cross-account-member'), envelope('direct-unlisted', 'unlisted-member')] });
    expect(kicked).toEqual(['c', 'c']);
    expect((await pool.query("SELECT source_message_id FROM agent_jobs WHERE source_message_id LIKE 'direct-%' ORDER BY source_message_id")).rows)
      .toEqual([{ source_message_id: 'direct-admin' }, { source_message_id: 'direct-allowed' }]);
    expect((await pool.query("SELECT direct_friend_grant_id, direct_friend_grant_version FROM agent_jobs WHERE source_message_id='direct-allowed'")).rows[0])
      .toMatchObject({ direct_friend_grant_id: expect.any(String), direct_friend_grant_version: '1' });
    expect((await pool.query("SELECT direct_friend_grant_id FROM agent_jobs WHERE source_message_id='direct-admin'")).rows[0]?.direct_friend_grant_id).toBeNull();

    await whitelist.revoke('a', 'direct-member', 'user');
    await service.handleWorkerEvent('whitelist-direct-worker', { ...batch(), workerInstanceId: 'whitelist-direct-worker', batchId: 'whitelist-direct-revoked',
      cursorBefore: cursor('960'), cursorAfter: cursor('961'), envelopes: [envelope('direct-revoked', 'direct-member')] });
    expect((await pool.query("SELECT count(*) FROM agent_jobs WHERE source_message_id='direct-revoked'")).rows[0]?.count).toBe('0');
  });

  it('rechecks a direct whitelist grant in the job transaction after a concurrent revoke', async () => {
    const targetMid = `racing-member-${Date.now()}`;
    await whitelist.activate('a', targetMid, 'user');
    await settings.setConversationAgent({ accountId: 'a', chatType: 'direct', chatId: 'c', enabled: true, provider: 'codex' });
    const original = messages.admitLiveBatch.bind(messages);
    vi.spyOn(messages, 'admitLiveBatch').mockImplementation(async (...args) => {
      await whitelist.revoke('a', targetMid, 'user');
      return original(...args);
    });
    const service = new LineService(accounts, messages, settings, { async send() {} },
      { kick() {}, async stopChat() {}, async resetChat() {} }, undefined, undefined, undefined, admins, undefined, whitelist);
    service.bind({ accountId: 'a', workerInstanceId: 'whitelist-race-worker', controlEpoch: 1, mode: 'ACTIVE_CONTROL' });
    const source = { ...batch().envelopes[0]!, eventId: 'whitelist-race-event', messageId: 'whitelist-race-message', senderId: targetMid };
    try {
      await service.handleWorkerEvent('whitelist-race-worker', { ...batch(), workerInstanceId: 'whitelist-race-worker', batchId: 'whitelist-race',
        cursorAfter: cursor('963'), envelopes: [source] });
    } finally {
      vi.restoreAllMocks();
    }
    expect((await pool.query("SELECT count(*) FROM agent_jobs WHERE source_message_id='whitelist-race-message'")).rows[0]?.count).toBe('0');
    expect((await pool.query("SELECT count(*) FROM messages WHERE account_id='a' AND message_id='whitelist-race-message'")).rows[0]?.count).toBe('1');
  });

  it('serializes an in-flight group admission behind a CHAT enrollment without deadlock', async () => {
    const targetMid = `u${randomBytes(16).toString('hex')}`;
    const chatId = `enrollment-race-${randomBytes(6).toString('hex')}`;
    const grant = await whitelist.activate('a', targetMid, 'user', { kind: 'CHAT', chatType: 'group', chatId });
    const binding = { accountId: 'a', workerInstanceId: `enrollment-race-worker-${Date.now()}`, controlEpoch: 1, mode: 'ACTIVE_CONTROL' as const };
    const service = new LineService(accounts, messages, settings, { async send() {} },
      { kick() {}, async stopChat() {}, async resetChat() {} }, undefined, undefined, undefined, admins, undefined, whitelist);
    await service.bind(binding);
    const account = await pool.query<{ selected_source_id: string | null; selected_source_generation: string | null;
      worker_instance_id: string | null; worker_binding_epoch: string }>(
      'SELECT selected_source_id, selected_source_generation, worker_instance_id, worker_binding_epoch FROM line_accounts WHERE account_id=$1', ['a']);
    const control = await pool.query<{ control_epoch: string }>('SELECT control_epoch FROM account_control WHERE singleton=true');
    const adminVersion = await pool.query<{ version: string }>('SELECT version FROM account_administrator_versions WHERE account_id=$1', ['a']);
    const current = account.rows[0]!;
    let releaseEnrollment!: () => void;
    let signalEnrollmentLock!: () => void;
    let signalIngestStart!: () => void;
    const enrollmentLocked = new Promise<void>((resolve) => { signalEnrollmentLock = resolve; });
    const allowEnrollment = new Promise<void>((resolve) => { releaseEnrollment = resolve; });
    const ingestStarted = new Promise<void>((resolve) => { signalIngestStart = resolve; });
    let paused = false;
    const gatedPool = {
      query: pool.query.bind(pool),
      async connect() {
        const client = await pool.connect();
        return {
          async query(sql: string, values?: unknown[]) {
            const result = await client.query(sql, values);
            if (!paused && sql.includes('SELECT a.connection_mode')) {
              paused = true;
              signalEnrollmentLock();
              await allowEnrollment;
            }
            return result;
          },
          release: () => client.release(),
        };
      },
    } as unknown as Pool;
    const enrollment = new FriendWhitelistRepository(gatedPool).activateForEnrollment({
      accountId: 'a', workerInstanceId: current.worker_instance_id!, controlEpoch: Number(control.rows[0]!.control_epoch),
      selectedSourceId: current.selected_source_id,
      selectedSourceGeneration: current.selected_source_generation === null ? null : Number(current.selected_source_generation),
      adminChatId: 'c', adminUserId: 'user', adminVersion: Number(adminVersion.rows[0]!.version), targetMid,
      scope: { kind: 'CHAT', chatType: 'group', chatId },
    });
    const originalIngest = messages.prepareBatchConversations.bind(messages);
    const ingestSpy = vi.spyOn(messages, 'prepareBatchConversations').mockImplementation(async (...args) => {
      signalIngestStart();
      return originalIngest(...args);
    });
    const event = { ...batch(), workerInstanceId: binding.workerInstanceId, controlEpoch: binding.controlEpoch,
      batchId: `enrollment-race-${chatId}`, envelopes: [{ ...batch().envelopes[0]!,
        messageId: `admission-${chatId}`, eventId: `admission-event-${chatId}`, chatType: 'group' as const, chatId,
        senderId: targetMid, text: '@Agent do work', mentionIds: ['agent-mid'],
        mentionRanges: [{ start: 0, end: 6, userId: 'agent-mid' }] }] };
    try {
      await enrollmentLocked;
      const ingress = service.handleWorkerEvent(binding.workerInstanceId, event);
      await ingestStarted;
      releaseEnrollment();
      const [activated] = await Promise.all([enrollment, ingress]);
      expect(activated.grantId).toBe(grant.grantId);
    } finally {
      releaseEnrollment();
      ingestSpy.mockRestore();
    }
    expect((await pool.query('SELECT direct_friend_grant_id, room_agent_grant_id FROM agent_jobs WHERE source_message_id=$1',
      [`admission-${chatId}`])).rows).toEqual([{ direct_friend_grant_id: grant.grantId, room_agent_grant_id: null }]);
  });

  it('admits a room member only with both room authority and same-account friend authorization, while PRIMARY_ADMIN bypasses both', async () => {
    await messages.upsertConversationCatalog('a', [
      { chatType: 'group', chatId: 'authorized-room', title: 'Authorized room', members: [] },
      { chatType: 'group', chatId: 'friend-race-room', title: 'Friend revoke race room', members: [] },
      { chatType: 'group', chatId: 'chat-only-room', title: 'Chat grant only room', members: [] },
    ]);
    await whitelist.activate('a', 'room-member', 'user', { kind: 'CHAT', chatType: 'group', chatId: 'authorized-room' });
    const friendRaceGrant = await whitelist.activate('a', 'room-member', 'user',
      { kind: 'CHAT', chatType: 'group', chatId: 'friend-race-room' });
    await whitelist.activate('a', 'account-member', 'user');
    const chatAndAccountGrant = await whitelist.activate('a', 'account-member', 'user',
      { kind: 'CHAT', chatType: 'group', chatId: 'chat-only-room' });
    await whitelist.activate('a', 'user', 'user');
    const rooms = new RoomActivationRepository(pool);
    const scope = { accountId: 'a', chatType: 'group' as const, chatId: 'authorized-room' };
    const friendRaceScope = { accountId: 'a', chatType: 'group' as const, chatId: 'friend-race-room' };
    const digestKey = randomBytes(32);
    const token = `RA-${randomBytes(32).toString('base64url')}`;
    const activation = await rooms.requestActivation({ ...scope, sourceMessageId: 'authorize-room-request', requesterId: 'room-member' });
    if (activation.disposition !== 'created') throw new Error('room activation was not created');
    const claim = await rooms.claimWaitingToSend(activation.requestId, 'room-authorizer', 60_000);
    if (!claim) throw new Error('room challenge was not claimable');
    if (!await rooms.prepareChallengeSend({ requestId: activation.requestId, leaseToken: claim.leaseToken, token, digestKey, digestKeyVersion: 1 })) {
      throw new Error('room challenge was not prepared');
    }
    expect((await rooms.confirmActivation({ ...scope, sourceMessageId: 'authorize-room-confirm', senderUserId: 'user', token, digestKey,
      digestKeyVersion: 1 })).disposition).toBe('enabled');
    const friendRaceActivation = await rooms.requestActivation({ ...friendRaceScope,
      sourceMessageId: 'friend-race-room-request', requesterId: 'room-member' });
    if (friendRaceActivation.disposition !== 'created') throw new Error('friend race room activation was not created');
    const friendRaceClaim = await rooms.claimWaitingToSend(friendRaceActivation.requestId, 'friend-race-room-authorizer', 60_000);
    if (!friendRaceClaim) throw new Error('friend race room challenge was not claimable');
    const friendRaceToken = `RA-${randomBytes(32).toString('base64url')}`;
    if (!await rooms.prepareChallengeSend({ requestId: friendRaceActivation.requestId, leaseToken: friendRaceClaim.leaseToken,
      token: friendRaceToken, digestKey, digestKeyVersion: 1 })) throw new Error('friend race room challenge was not prepared');
    expect((await rooms.confirmActivation({ ...friendRaceScope, sourceMessageId: 'friend-race-room-confirm', senderUserId: 'user',
      token: friendRaceToken, digestKey, digestKeyVersion: 1 })).disposition).toBe('enabled');
    const kicked: string[] = [];
    const replies: string[] = [];
    const service = new LineService(accounts, messages, settings, { async send() {} },
      { kick(key) { kicked.push(key.chatId); }, async stopChat() {}, async resetChat() {} }, undefined, undefined, undefined,
      admins, { async handle() {}, async isEnabled(key) { return key.chatType !== 'direct' && rooms.hasActiveRoomGrant(key as Parameters<RoomActivationRepository['hasActiveRoomGrant']>[0]); },
        async getActiveAuthorization(key) { return key.chatType === 'direct' ? null : rooms.getActiveRoomAuthorization(key as Parameters<RoomActivationRepository['getActiveRoomAuthorization']>[0]); },
        async respond(_envelope: InboundEnvelope, body: string) { replies.push(body); } }, whitelist);
    service.bind({ accountId: 'a', workerInstanceId: 'whitelist-room-worker', controlEpoch: 1, mode: 'ACTIVE_CONTROL' });
    const envelope = (messageId: string, senderId: string, chatId = 'authorized-room') => ({ ...batch().envelopes[0]!, eventId: `${messageId}-event`, messageId,
      chatType: 'group' as const, chatId, senderId, text: '@Agent do work', mentionIds: ['agent-mid'],
      mentionRanges: [{ start: 0, end: 6, userId: 'agent-mid' }] });
    await service.handleWorkerEvent('whitelist-room-worker', { ...batch(), workerInstanceId: 'whitelist-room-worker', batchId: 'whitelist-room',
      cursorAfter: cursor('962'), envelopes: [envelope('room-member-allowed', 'room-member'), envelope('account-member-group-allowed', 'account-member'),
        envelope('room-member-unlisted', 'unlisted-room-member'), envelope('room-admin', 'user')] });
    expect(kicked).toEqual(['authorized-room', 'authorized-room', 'authorized-room']);
    expect((await pool.query("SELECT source_message_id FROM agent_jobs WHERE source_message_id IN ('room-member-allowed','account-member-group-allowed','room-admin') ORDER BY source_message_id")).rows)
      .toEqual([{ source_message_id: 'account-member-group-allowed' }, { source_message_id: 'room-admin' }, { source_message_id: 'room-member-allowed' }]);
    expect((await pool.query("SELECT direct_friend_grant_id, direct_friend_grant_version, room_agent_grant_id, room_agent_grant_version FROM agent_jobs WHERE source_message_id='room-member-allowed'")).rows[0])
      .toEqual({ direct_friend_grant_id: expect.any(String), direct_friend_grant_version: '1',
        room_agent_grant_id: null, room_agent_grant_version: null });
    expect((await pool.query("SELECT direct_friend_grant_id, room_agent_grant_id, room_agent_grant_version FROM agent_jobs WHERE source_message_id='account-member-group-allowed'")).rows[0])
      .toMatchObject({ direct_friend_grant_id: expect.any(String), room_agent_grant_id: expect.any(String), room_agent_grant_version: '2' });
    await service.handleWorkerEvent('whitelist-room-worker', { ...batch(), workerInstanceId: 'whitelist-room-worker', batchId: 'chat-only-no-room-policy',
      cursorBefore: cursor('962'), cursorAfter: cursor('9621'), envelopes: [envelope('chat-only-with-account-grant', 'account-member', 'chat-only-room')] });
    expect((await pool.query("SELECT direct_friend_grant_id, room_agent_grant_id FROM agent_jobs WHERE source_message_id='chat-only-with-account-grant'")).rows[0])
      .toEqual({ direct_friend_grant_id: chatAndAccountGrant.grantId, room_agent_grant_id: null });
    expect(replies).toEqual([]);
    const failedWorkspaceReplies: string[] = [];
    const failedWorkspace = new BaseLineService(accounts, messages, settings, { async send() {} },
      { kick() {}, async stopChat() {}, async resetChat() {} }, undefined, undefined, undefined, admins,
      { async inspect() { return { status: 'unavailable', version: 0, configuredPath: 'D:\\missing', reason: 'Workspace directory is unavailable' }; } },
      { async handle() {}, async isEnabled() { return false; }, async respond(_envelope: InboundEnvelope, body: string) { failedWorkspaceReplies.push(body); } } as never, whitelist);
    failedWorkspace.bind({ accountId: 'a', workerInstanceId: 'whitelist-room-worker', controlEpoch: 1, mode: 'ACTIVE_CONTROL' });
    await failedWorkspace.handleWorkerEvent('whitelist-room-worker', { ...batch(), workerInstanceId: 'whitelist-room-worker', batchId: 'chat-only-workspace-failure',
      cursorBefore: cursor('9621'), cursorAfter: cursor('9622'), envelopes: [envelope('chat-only-workspace-failure-message', 'account-member', 'chat-only-room')] });
    expect((await pool.query("SELECT status FROM agent_jobs WHERE source_message_id='chat-only-workspace-failure-message'")).rows)
      .toEqual([{ status: 'failed' }]);
    expect(failedWorkspaceReplies).toEqual([]);
    expect((await pool.query("SELECT direct_friend_grant_id, room_agent_grant_id FROM agent_jobs WHERE source_message_id='room-admin'")).rows[0])
      .toEqual({ direct_friend_grant_id: null, room_agent_grant_id: null });

    await service.handleWorkerEvent('whitelist-room-worker', { ...batch(), workerInstanceId: 'whitelist-room-worker', batchId: 'chat-only-direct-denied',
      cursorBefore: cursor('9622'), cursorAfter: cursor('9623'), envelopes: [{ ...batch().envelopes[0]!, eventId: 'chat-only-direct-event', messageId: 'chat-only-direct-denied',
        chatType: 'direct', chatId: 'c', senderId: 'room-member', text: 'hello' }] });
    expect((await pool.query("SELECT count(*) FROM agent_jobs WHERE source_message_id='chat-only-direct-denied'")).rows[0]?.count).toBe('0');

    const original = messages.admitLiveBatch.bind(messages);
    vi.spyOn(messages, 'admitLiveBatch').mockImplementation(async (...args) => {
      await rooms.revokeRoom(scope, 'admin-revoke');
      return original(...args);
    });
    try {
      await service.handleWorkerEvent('whitelist-room-worker', { ...batch(), workerInstanceId: 'whitelist-room-worker', batchId: 'whitelist-room-revoked',
        cursorBefore: cursor('9623'), cursorAfter: cursor('9624'), envelopes: [envelope('room-member-revoked-during-admission', 'account-member')] });
    } finally {
      vi.restoreAllMocks();
    }
    expect((await pool.query("SELECT count(*) FROM agent_jobs WHERE source_message_id='room-member-revoked-during-admission'")).rows[0]?.count).toBe('0');

    const beforeWhitelistRevoke = messages.admitLiveBatch.bind(messages);
    let requestedFriendRaceDecision: unknown;
    vi.spyOn(messages, 'admitLiveBatch').mockImplementation(async (...args) => {
      await whitelist.revoke('a', 'room-member', 'admin-revoke',
        { kind: 'CHAT', chatType: 'group', chatId: 'friend-race-room' });
      requestedFriendRaceDecision = args[1][0];
      return beforeWhitelistRevoke(...args);
    });
    try {
      await service.handleWorkerEvent('whitelist-room-worker', { ...batch(), workerInstanceId: 'whitelist-room-worker', batchId: 'chat-grant-revoked',
        cursorBefore: cursor('9624'), cursorAfter: cursor('9625'), envelopes: [envelope('room-member-friend-revoked-during-admission', 'room-member', 'friend-race-room')] });
    } finally {
      vi.restoreAllMocks();
    }
    expect(requestedFriendRaceDecision).toMatchObject({ eligible: true,
      authorization: { directGrantId: friendRaceGrant.grantId, directGrantVersion: friendRaceGrant.version } });
    expect((await pool.query("SELECT count(*) FROM agent_jobs WHERE source_message_id='room-member-friend-revoked-during-admission'")).rows[0]?.count).toBe('0');
  });

  it('routes disabled-room mentions to the deterministic responder and suppresses Agent admission', async () => {
    await messages.upsertConversationCatalog('a', [{ chatType: 'group', chatId: 'responder-room',
      title: 'Responder room', members: [] }]);
    await settings.setConversationAgent({ accountId: 'a', chatType: 'group', chatId: 'responder-room', enabled: true, provider: 'codex' });
    const replies: string[] = [];
    const kicked: string[] = [];
    const service = new BaseLineService(accounts, messages, settings, { async send() {} },
      { kick(key) { kicked.push(key.chatId); }, async stopChat() {}, async resetChat() {} }, undefined, undefined, undefined, admins,
      { async inspect() { return { status: 'available', version: 0, path: 'C:\\trusted' }; } },
      { async handle() {}, async isEnabled() { return false; }, async respond(_envelope: InboundEnvelope, body: string) { replies.push(body); } } as never);
    const source = { ...batch().envelopes[0]!, eventId: 'responder-room-event', messageId: 'responder-room-message',
      chatType: 'group' as const, chatId: 'responder-room', senderId: 'member', text: '@Agent   hello   there',
      mentionIds: ['agent-mid'], mentionRanges: [{ start: 0, end: 6, userId: 'agent-mid' }] };
    service.bind({ accountId: 'a', workerInstanceId: 'responder-room-worker', controlEpoch: 1, mode: 'ACTIVE_CONTROL' });
    await service.handleWorkerEvent('responder-room-worker', { ...batch(), workerInstanceId: 'responder-room-worker',
      batchId: 'responder-room', cursorAfter: cursor('952'), envelopes: [source] });
    const jobs = await pool.query("SELECT count(*) FROM agent_jobs WHERE source_message_id='responder-room-message'");
    expect(replies).toEqual(['hello there']);
    expect(kicked).toEqual([]);
    expect(jobs.rows[0].count).toBe('0');
    // Recognised commands never also produce the fallback reply (independent-ingest path).
    replies.length = 0;
    const command = (messageId: string, text: string, mentioned: boolean) => ({ ...source, eventId: `${messageId}-event`, messageId, text,
      ...(mentioned ? {} : { mentionIds: [], mentionRanges: [] }) });
    await service.handleWorkerEvent('responder-room-worker', { ...batch(), workerInstanceId: 'responder-room-worker',
      batchId: 'responder-room-commands', cursorBefore: cursor('952'), cursorAfter: cursor('953'),
      envelopes: [command('cmd-free', '/free', false), command('cmd-mention-free', '@Agent /free', true), command('cmd-ordinary', '@Agent ordinary text', true)] });
    await service.idleRoomEffects();
    expect(replies).toEqual(['/free', 'ordinary text']);
  });

  it('keeps room Agent jobs closed even after Worker readiness until member grants are wired', async () => {
    await messages.upsertConversationCatalog('a', [{ chatType: 'group', chatId: 'ready-room', title: 'Ready room', members: [] }]);
    const kicked: string[] = [];
    const service = new LineService(accounts, messages, settings, { async send() {} },
      { kick(key) { kicked.push(key.chatId); }, async stopChat() {}, async resetChat() {} }, undefined, undefined, undefined, admins,
      { async handle() {}, async isEnabled() { return true; } } as never);
    const binding = { accountId: 'a', workerInstanceId: 'ready-room-worker', controlEpoch: 1 };
    await service.bind({ ...binding, mode: 'ACTIVE_CONTROL' });
    const memberMention = (messageId: string) => ({ ...batch().envelopes[0]!, eventId: `${messageId}-event`, messageId,
      chatType: 'group' as const, chatId: 'ready-room', senderId: 'room-member', text: '@Agent do this',
      mentionIds: ['agent-mid'], mentionRanges: [{ start: 0, end: 6, userId: 'agent-mid' }] });
    await service.handleWorkerEvent(binding.workerInstanceId, { ...batch(), ...binding, batchId: 'room-not-ready',
      cursorAfter: cursor('954'), envelopes: [memberMention('room-not-ready-message')] });
    expect((await pool.query("SELECT count(*) FROM agent_jobs WHERE source_message_id='room-not-ready-message'")).rows[0].count).toBe('0');

    await service.handleWorkerEvent(binding.workerInstanceId, { type: 'login', ...binding, loginAttemptId: 'room-ready-login',
      ownMid: 'agent-mid', displayName: null });
    await service.handleWorkerEvent(binding.workerInstanceId, { type: 'status', ...binding, state: 'ready', message: null });
    await service.handleWorkerEvent(binding.workerInstanceId, { ...batch(), ...binding, batchId: 'room-ready',
      cursorBefore: cursor('954'), cursorAfter: cursor('955'), envelopes: [memberMention('room-ready-message')] });

    expect(kicked).toEqual([]);
    expect((await pool.query("SELECT count(*) FROM agent_jobs WHERE source_message_id IN ('room-not-ready-message','room-ready-message')")).rows[0].count).toBe('0');
    expect((await pool.query("SELECT count(*) FROM messages WHERE chat_id='ready-room' AND message_id IN ('room-not-ready-message','room-ready-message')")).rows[0].count).toBe('2');
  });

  it('does not trust the legacy conversation Agent toggle as room authority', async () => {
    await messages.upsertConversationCatalog('a', [{ chatType: 'group', chatId: 'legacy-toggle-room',
      title: 'Legacy room', members: [] }]);
    await settings.setConversationAgent({ accountId: 'a', chatType: 'group', chatId: 'legacy-toggle-room', enabled: true, provider: 'codex' });
    const kicked: string[] = [];
    const service = new LineService(accounts, messages, settings, { async send() {} },
      { kick(key) { kicked.push(key.chatId); }, async stopChat() {}, async resetChat() {} }, undefined, undefined, undefined, admins);
    service.bind({ accountId: 'a', workerInstanceId: 'legacy-toggle-worker', controlEpoch: 1, mode: 'ACTIVE_CONTROL' });
    const source = { ...batch().envelopes[0]!, eventId: 'legacy-toggle-event', messageId: 'legacy-toggle-message',
      chatType: 'group' as const, chatId: 'legacy-toggle-room', senderId: 'member', text: '@Agent do it',
      mentionIds: ['agent-mid'], mentionRanges: [{ start: 0, end: 6, userId: 'agent-mid' }] };
    await service.handleWorkerEvent('legacy-toggle-worker', { ...batch(), workerInstanceId: 'legacy-toggle-worker',
      batchId: 'legacy-toggle-room', cursorAfter: cursor('953'), envelopes: [source] });
    const jobs = await pool.query("SELECT count(*) FROM agent_jobs WHERE source_message_id='legacy-toggle-message'");
    expect(kicked).toEqual([]);
    expect(jobs.rows[0].count).toBe('0');
  });

  it('redacts copied room token candidates from history before archive and search', async () => {
    const token = `RA-${'A'.repeat(43)}`;
    const service = new LineService(accounts, messages, settings, { async send() {} },
      { kick() {}, async stopChat() {}, async resetChat() {} });
    service.bind({ accountId: 'a', workerInstanceId: 'w1', controlEpoch: 1, mode: 'ACTIVE_CONTROL' });
    await service.handleWorkerEvent('w1', { type: 'historyResult', accountId: 'a', workerInstanceId: 'w1', controlEpoch: 1,
      chatType: 'room', chatId: 'history-room', requestId: 'history-token', nextCursor: null,
      envelopes: [{ ...batch().envelopes[0]!, eventId: 'history-token-event', messageId: 'history-token-message',
        chatType: 'room', chatId: 'history-room', text: token, raw: { message: { text: token } },
        ingestion: { source: 'history', cursor: null } }] });

    const stored = await pool.query("SELECT text_content,raw::text FROM messages WHERE message_id='history-token-message'");
    expect(stored.rows).toHaveLength(1);
    expect(`${stored.rows[0].text_content}|${stored.rows[0].raw}`).not.toContain(token);
    expect(await messages.searchMessages({ key: { accountId: 'a', chatType: 'room', chatId: 'history-room' }, text: token, limit: 10 })).toEqual([]);
  });

  it('redacts attachment metadata from live, history, and own-message echoes before persistence and listing', async () => {
    const token = `RA-${'A'.repeat(43)}`;
    const normalized = (id: string, senderId: string, source: 'live' | 'history') => normalizeOperation({
      revision: id, type: 26, message: { id, from: senderId, to: 'c-attachment-secret', toType: 2,
        contentType: 'FILE', createdTime: 1792108800000,
        contentMetadata: { FILE_NAME: `${token}.txt`, MIME_TYPE: `application/${token}`, FILE_SIZE: '17' } },
    }, { accountId: 'a', ownMid: 'agent-mid', source, cursor: source === 'live' ? 'attachment-cursor' : null });
    const live = normalized('attachment-live-secret', 'member', 'live');
    const echo = normalized('attachment-echo-secret', 'agent-mid', 'live');
    const history = normalized('attachment-history-secret', 'member', 'history');
    const service = new LineService(accounts, messages, settings, { async send() {} },
      { kick() {}, async stopChat() {}, async resetChat() {} });
    service.bind({ accountId: 'a', workerInstanceId: 'w1', controlEpoch: 1, mode: 'ACTIVE_CONTROL' });
    await service.handleWorkerEvent('w1', { ...batch(), batchId: 'attachment-secret-live', cursorAfter: cursor('24'),
      envelopes: [live, echo] });
    await service.handleWorkerEvent('w1', { type: 'historyResult', accountId: 'a', workerInstanceId: 'w1', controlEpoch: 1,
      chatType: 'group', chatId: 'c-attachment-secret', requestId: 'attachment-secret-history', nextCursor: null,
      envelopes: [history] });

    const rows = await pool.query('SELECT message_id,name,mime_type FROM attachments WHERE message_id = ANY($1::text[]) ORDER BY message_id',
      [['attachment-live-secret', 'attachment-echo-secret', 'attachment-history-secret']]);
    expect(rows.rows).toHaveLength(3);
    expect(JSON.stringify(rows.rows)).not.toContain(token);
    expect(rows.rows.map((row) => row.message_id)).toEqual([
      'attachment-echo-secret', 'attachment-history-secret', 'attachment-live-secret',
    ]);
    const listed = await messages.listAttachments({ accountId: 'a', chatType: 'group', chatId: 'c-attachment-secret' }, null, 10);
    expect(listed.attachments).toHaveLength(3);
    expect(JSON.stringify(listed.attachments)).not.toContain(token);
    for (const item of listed.attachments) {
      expect(item.name).toBe('[REDACTED].txt');
      expect(item.mimeType).toBe('application/[REDACTED]');
    }
  });

  it('keeps room Agent admission closed until account-scoped member grants are available', async () => {
    const base = { ...batch().envelopes[0]!, chatType: 'group' as const, chatId: 'group-chat',
      senderId: 'group-user', text: 'seed', mentionIds: [], mentionRanges: [] };
    await messages.ingestAndRoute({ ...base, eventId: 'group-seed-event', messageId: 'group-seed' }, { eligible: false });
    await settings.setConversationAgent({ accountId: 'a', chatType: 'group', chatId: 'group-chat', enabled: true, provider: 'codex' });
    const kicked: string[] = [];
    const service = new LineService(accounts, messages, settings, { async send() {} },
      { kick(key) { kicked.push(key.chatId); }, async stopChat() {}, async resetChat() {} },
      undefined, undefined, undefined, admins, { async handle() {}, async isEnabled() { return true; } });
    service.bind({ accountId: 'a', workerInstanceId: 'w1', controlEpoch: 1, mode: 'ACTIVE_CONTROL' });
    const replyOnly = { ...base, eventId: 'reply-only-event', messageId: 'reply-only-message', text: 'continue',
      replyToMessageId: 'prior-agent-message' };
    const forged = { ...base, eventId: 'forged-event', messageId: 'forged-message', text: '@Agent do it',
      mentionIds: ['agent-mid'], mentionRanges: [] };
    const all = { ...base, eventId: 'all-event', messageId: 'all-message', text: '@all do it',
      mentionIds: ['@all'], mentionRanges: [{ start: 0, end: 4, userId: '@all' }] };
    const valid = { ...base, eventId: 'valid-mention-event', messageId: 'valid-mention-message', text: '@Agent do it',
      mentionIds: ['agent-mid'], mentionRanges: [{ start: 0, end: 6, userId: 'agent-mid' }] };
    await service.handleWorkerEvent('w1', { ...batch(), batchId: 'group-routing', cursorAfter: cursor('21'),
      envelopes: [replyOnly, forged, all, valid] });
    expect(kicked).toEqual([]);
    const jobs = await pool.query("SELECT source_message_id FROM agent_jobs WHERE source_message_id = ANY($1::text[]) ORDER BY source_message_id",
      [['reply-only-message', 'forged-message', 'all-message', 'valid-mention-message']]);
    expect(jobs.rows).toEqual([]);
    expect((await pool.query("SELECT count(*) FROM messages WHERE message_id = ANY($1::text[])",
      [['reply-only-message', 'forged-message', 'all-message', 'valid-mention-message']])).rows[0].count).toBe('4');
  });

  it('drops an event from an unbound process instance', async () => {
    const commands: LineWorkerCommand[] = [];
    const service = new LineService(accounts, messages, settings, { async send(command) { commands.push(command); } },
      { kick() {}, async stopChat() {}, async resetChat() {} });
    service.bind({ accountId: 'a', workerInstanceId: 'w1', controlEpoch: 1, mode: 'ACTIVE_CONTROL' });
    const before = await pool.query('SELECT cursor FROM external_source_checkpoints WHERE source_id=$1', [loginSourceId]);
    await service.handleWorkerEvent('stale-instance', { ...batch(), batchId: 'b2', cursorAfter: cursor('2') });
    expect(commands).toHaveLength(0);
    const row = await pool.query('SELECT cursor FROM external_source_checkpoints WHERE source_id=$1', [loginSourceId]);
    expect(row.rows[0].cursor).toEqual(before.rows[0].cursor);
  });
  it('keeps the newest same-epoch worker binding when an older registration is delayed', async () => {
    let releaseOld!: () => void;
    const oldGate = new Promise<void>((resolve) => { releaseOld = resolve; });
    const registered: string[] = [];
    const realBind = accounts.bindWorker.bind(accounts);
    const spy = vi.spyOn(accounts, 'bindWorker').mockImplementation(async (binding) => {
      if (binding.workerInstanceId === 'delayed-old') await oldGate;
      await realBind(binding);
      registered.push(binding.workerInstanceId);
    });
    try {
      const service = new LineService(accounts, messages, settings, { async send() {} },
        { kick() {}, async stopChat() {}, async resetChat() {} });
      service.bind({ accountId: 'a', workerInstanceId: 'delayed-old', controlEpoch: 1, mode: 'ACTIVE_CONTROL' });
      service.bind({ accountId: 'a', workerInstanceId: 'new-worker', controlEpoch: 1, mode: 'ACTIVE_CONTROL' });
      await new Promise((resolve) => setTimeout(resolve, 30));
      releaseOld();
      for (let attempt = 0; attempt < 100 && registered.length < 2; attempt++) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      expect(registered).toEqual(['delayed-old', 'new-worker']);
      const row = await pool.query("SELECT worker_instance_id FROM line_accounts WHERE account_id = 'a'");
      expect(row.rows[0].worker_instance_id).toBe('new-worker');
    } finally { releaseOld(); spy.mockRestore(); }
  });

  it('runs a replayed /new command only once', async () => {
    let resets = 0;
    const service = new LineService(accounts, messages, settings, { async send() {} },
      { kick() {}, async stopChat() {}, async resetChat() { resets++; } }, undefined, undefined, undefined, admins);
    service.bind({ accountId: 'a', workerInstanceId: 'w1', controlEpoch: 1, mode: 'ACTIVE_CONTROL' });
    const input = { ...batch(), batchId: 'new-command', cursorAfter: cursor('2'), envelopes: [
      { ...batch().envelopes[0]!, eventId: 'new-event', messageId: 'new-message', text: '/new' },
    ] };
    await service.handleWorkerEvent('w1', input);
    await service.handleWorkerEvent('w1', input);
    expect(resets).toBe(1);
  });
  it('replays a committed /new effect exactly once when the first worker ack fails', async () => {
    let resets = 0; let acknowledgements = 0;
    const service = new LineService(accounts, messages, settings, { async send(command) {
      if (command.type === 'ackBatch' && ++acknowledgements === 1) throw new Error('ack channel down');
    } }, { kick() {}, async stopChat() {}, async resetChat() { resets++; } }, undefined, undefined, undefined, admins);
    service.bind({ accountId: 'a', workerInstanceId: 'w1', controlEpoch: 1, mode: 'ACTIVE_CONTROL' });
    const input = { ...batch(), batchId: 'ack-failed-new', cursorAfter: cursor('12'), envelopes: [
      { ...batch().envelopes[0]!, eventId: 'ack-failed-new-event', messageId: 'ack-failed-new-message', text: '/new' },
    ] };
    await expect(service.handleWorkerEvent('w1', input)).rejects.toThrow('ack channel down');
    await service.handleWorkerEvent('w1', input);
    expect(resets).toBe(1);
    expect(acknowledgements).toBe(2);
  });
  it('keeps a failed post-commit /new effect pending for batch replay', async () => {
    let resets = 0; let acknowledgements = 0;
    const service = new LineService(accounts, messages, settings, { async send(command) {
      if (command.type === 'ackBatch') acknowledgements++;
    } }, { kick() {}, async stopChat() {}, async resetChat() {
      if (++resets === 1) throw new Error('reset interrupted');
    } }, undefined, undefined, undefined, admins);
    service.bind({ accountId: 'a', workerInstanceId: 'w1', controlEpoch: 1, mode: 'ACTIVE_CONTROL' });
    const input = { ...batch(), batchId: 'reset-failed-new', cursorAfter: cursor('13'), envelopes: [
      { ...batch().envelopes[0]!, eventId: 'reset-failed-new-event', messageId: 'reset-failed-new-message', text: '/new' },
    ] };
    await expect(service.handleWorkerEvent('w1', input)).rejects.toThrow('reset interrupted');
    expect(acknowledgements).toBe(1);
    expect((await pool.query("SELECT effect_applied_at FROM message_routes WHERE account_id='a' AND message_id='reset-failed-new-message'")).rows[0]?.effect_applied_at).toBeNull();
    await service.handleWorkerEvent('w1', input);
    expect(resets).toBe(2);
    expect(acknowledgements).toBe(2);
    expect((await pool.query("SELECT effect_applied_at FROM message_routes WHERE account_id='a' AND message_id='reset-failed-new-message'")).rows[0]?.effect_applied_at).not.toBeNull();
  });
  it('recovers an unmatched live prompt after restart without worker replay and admits it once', async () => {
    const commands: LineWorkerCommand[] = [];
    const first = new LineService(accounts, messages, settings, { async send(command) { commands.push(command); } },
      { kick() {}, async stopChat() {}, async resetChat() {} }, undefined, undefined, undefined, admins);
    const failOnce = vi.spyOn(messages, 'admitLiveBatch').mockRejectedValueOnce(new Error('forced admission failure'));
    await first.bind({ accountId: 'a', workerInstanceId: 'w1', controlEpoch: 1, mode: 'ACTIVE_CONTROL' });
    const input = { ...batch(), batchId: 'recover-after-ack', cursorAfter: cursor('100'), envelopes: [
      { ...batch().envelopes[0]!, eventId: 'recover-after-ack-event', messageId: 'recover-after-ack-message', text: 'do this' },
    ] };
    await first.handleWorkerEvent('w1', input);
    failOnce.mockRestore();
    expect(commands).toContainEqual(expect.objectContaining({ type: 'ackBatch', batchId: input.batchId }));
    expect((await pool.query("SELECT count(*)::int count FROM messages WHERE account_id='a' AND message_id='recover-after-ack-message'"))
      .rows[0]?.count).toBe(1);
    expect((await pool.query("SELECT count(*)::int count FROM agent_jobs WHERE account_id='a' AND source_message_id='recover-after-ack-message'"))
      .rows[0]?.count).toBe(0);
    expect(await messages.listUnroutedLiveSourceMessages({ accountId: 'a', workerInstanceId: 'w1', controlEpoch: 1 }))
      .toMatchObject([{ envelope: { messageId: 'recover-after-ack-message', text: 'do this' },
        receiptMode: 'ACTIVE_CONTROL', receiptControlEpoch: 1, sensitive: false }]);

    const kicked: string[] = [];
    const restarted = new LineService(accounts, messages, settings, { async send() {} },
      { kick(key) { kicked.push(key.chatId); }, async stopChat() {}, async resetChat() {} }, undefined, undefined, undefined, admins);
    const recoveredAdmit = vi.spyOn(messages, 'admitLiveBatch');
    await restarted.bind({ accountId: 'a', workerInstanceId: 'restart-worker', controlEpoch: 1, mode: 'ACTIVE_CONTROL' });
    expect(await messages.listUnroutedLiveSourceMessages({ accountId: 'a', workerInstanceId: 'restart-worker', controlEpoch: 1 }))
      .toMatchObject([{ envelope: { messageId: 'recover-after-ack-message', ingestion: { source: 'live' } } }]);
    await restarted.handleWorkerEvent('restart-worker', { type: 'status', accountId: 'a', workerInstanceId: 'restart-worker',
      controlEpoch: 1, state: 'ready', message: null });
    expect(kicked).toEqual(['c']);
    expect(recoveredAdmit).toHaveBeenCalled();
    expect((await pool.query("SELECT count(*)::int count FROM agent_jobs WHERE account_id='a' AND source_message_id='recover-after-ack-message'"))
      .rows[0]?.count).toBe(1);
    expect((await pool.query("SELECT action FROM message_routes WHERE account_id='a' AND message_id='recover-after-ack-message'"))
      .rows[0]?.action).toBe('prompt');
  });
  it.each([
    ['monitor-only receipt', 'MONITOR_ONLY', 1],
    ['old control epoch receipt', 'ACTIVE_CONTROL', 0],
  ] as const)('does not replay a group mention automation for %s', async (_label, receiptMode, receiptEpoch) => {
    const chatId = `recovery-mention-${receiptMode}-${receiptEpoch}`;
    const grant = await whitelist.activate('a', 'recovery-member', 'user', { kind: 'CHAT', chatType: 'group', chatId });
    await messages.upsertConversationCatalog('a', [{ chatType: 'group', chatId, title: chatId, members: [] }]);
    await settings.setConversationAgent({ accountId: 'a', chatType: 'group', chatId, enabled: true, provider: 'codex' });
    const envelope = { ...batch().envelopes[0]!, eventId: `event-${chatId}`, messageId: `message-${chatId}`,
      chatType: 'group' as const, chatId, senderId: 'recovery-member', text: '@Agent do this', mentionIds: ['agent-mid'],
      mentionRanges: [{ start: 0, end: 6, userId: 'agent-mid' }] };
    const makeService = (commands: LineWorkerCommand[], responses: string[]) => new LineService(
      accounts, messages, settings, { async send(command) { commands.push(command); } },
      { kick() {}, async stopChat() {}, async resetChat() {} }, undefined, undefined, undefined, admins,
      { async handle() {}, async getActiveAuthorization() { return { grantId: grant.grantId, version: grant.version }; },
        async respond(_envelope, body) { responses.push(body); } }, whitelist);
    const firstCommands: LineWorkerCommand[] = [];
    const first = makeService(firstCommands, []);
    const failOnce = vi.spyOn(messages, 'admitLiveBatch').mockRejectedValueOnce(new Error('forced admission failure'));
    await first.bind({ accountId: 'a', workerInstanceId: 'w1', controlEpoch: 1, mode: 'ACTIVE_CONTROL' });
    await first.handleWorkerEvent('w1', { ...batch(), batchId: `batch-${chatId}`, envelopes: [envelope] });
    failOnce.mockRestore();
    await pool.query(`UPDATE external_source_observations SET normalized_payload=jsonb_set(jsonb_set(normalized_payload,
      '{livePayload,recovery,receiptMode}', to_jsonb($2::text), true),
      '{livePayload,recovery,controlEpoch}',to_jsonb($3::int),true)
      WHERE source_id=$1 AND observation_id=$4`, [loginSourceId, receiptMode, receiptEpoch, envelope.messageId]);

    const commands: LineWorkerCommand[] = [];
    const responses: string[] = [];
    const restarted = makeService(commands, responses);
    await restarted.bind({ accountId: 'a', workerInstanceId: 'recovery-worker', controlEpoch: 1, mode: 'ACTIVE_CONTROL' });
    await restarted.handleWorkerEvent('recovery-worker', { type: 'status', accountId: 'a', workerInstanceId: 'recovery-worker',
      controlEpoch: 1, state: 'ready', message: null });
    expect(responses).toEqual([]);
    expect(commands.filter((command) => command.type === 'sendText')).toEqual([]);
    expect((await pool.query('SELECT count(*)::int count FROM agent_jobs WHERE account_id=$1 AND source_message_id=$2',
      ['a', envelope.messageId])).rows[0]?.count).toBe(0);
    expect((await pool.query('SELECT action FROM message_routes WHERE account_id=$1 AND message_id=$2',
      ['a', envelope.messageId])).rows[0]?.action).toBe('ignore');
  });
  it('correlates QR login rotation and restores secrets to a fresh worker', async () => {
    const folder = await mkdtemp(join(tmpdir(), 'line-rotation-'));
    try {
      const secrets = new SecretStore(folder, { async protect(value) { return value; }, async unprotect(value) { return value; } });
      const commands: LineWorkerCommand[] = [];
      const service = new LineService(accounts, messages, settings, { async send(command) { commands.push(command); } },
        { kick() {}, async stopChat() {}, async resetChat() {} }, secrets);
      service.bind({ accountId: 'a', workerInstanceId: 'w1', controlEpoch: 1, mode: 'ACTIVE_CONTROL' });
      await service.requestQrLogin('a', 'w1', 'attempt-1');
      const rotation = { type: 'secretRotation' as const, accountId: 'a', workerInstanceId: 'w1', controlEpoch: 1,
        loginAttemptId: 'attempt-1', secrets: { token: 'token-1', qrCert: 'cert-1', e2eeStorage: { key: 'e2ee' } } };
      await service.handleWorkerEvent('w1', { ...rotation, loginAttemptId: 'stale' });
      expect(await secrets.load('a')).toBeNull();
      await service.handleWorkerEvent('w1', rotation);
      expect(await secrets.load('a')).toBeNull();
      const latestRotation = { ...rotation, secrets: { token: 'token-2', qrCert: 'cert-2', e2eeStorage: { key: 'e2ee-2' } } };
      await service.handleWorkerEvent('w1', latestRotation);
      expect(await secrets.load('a')).toBeNull();
      await service.handleWorkerEvent('w1', { type: 'login', accountId: 'a', workerInstanceId: 'w1', controlEpoch: 1,
        loginAttemptId: 'attempt-1', ownMid: 'agent-mid', displayName: 'Agent' });
      expect(await secrets.load('a')).toEqual(latestRotation.secrets);
      service.bind({ accountId: 'a', workerInstanceId: 'w2', controlEpoch: 1, mode: 'ACTIVE_CONTROL' });
      await service.requestTokenLogin('a', 'w2', 'attempt-2');
      expect(commands).toMatchObject([{ type: 'loginQr', loginAttemptId: 'attempt-1' },
        { type: 'setSecretState', workerInstanceId: 'w2', secrets: latestRotation.secrets },
        { type: 'loginToken', workerInstanceId: 'w2', loginAttemptId: 'attempt-2' }]);
    } finally { await rm(folder, { recursive: true, force: true }); }
  });
  it('rejects a different MID QR login without saving its pending secrets or replacing account identity', async () => {
    const folder = await mkdtemp(join(tmpdir(), 'line-rotation-mismatch-'));
    try {
      const secrets = new SecretStore(folder, { async protect(value) { return value; }, async unprotect(value) { return value; } });
      const service = new LineService(accounts, messages, settings, { async send() {} },
        { kick() {}, async stopChat() {}, async resetChat() {} }, secrets);
      const binding = { accountId: 'a', workerInstanceId: 'qr-mismatch-worker', controlEpoch: 1, mode: 'ACTIVE_CONTROL' as const };
      await service.bind(binding);
      await service.requestQrLogin('a', binding.workerInstanceId, 'qr-mismatch-attempt');
      await service.handleWorkerEvent(binding.workerInstanceId, { type: 'secretRotation', ...binding,
        loginAttemptId: 'qr-mismatch-attempt', secrets: { token: 'wrong-mid-token', qrCert: null, e2eeStorage: null } });
      await service.handleWorkerEvent(binding.workerInstanceId, { type: 'login', accountId: 'a', workerInstanceId: binding.workerInstanceId,
        controlEpoch: 1, loginAttemptId: 'qr-mismatch-attempt', ownMid: 'u-different', displayName: null });
      expect(await secrets.load('a')).toBeNull();
      expect((await accounts.getAccount('a'))?.ownMid).toBe('agent-mid');
      expect(service.isCurrentWorkerEvent(binding.workerInstanceId, { type: 'login', accountId: 'a', workerInstanceId: binding.workerInstanceId,
        controlEpoch: 1, loginAttemptId: 'qr-mismatch-attempt', ownMid: 'u-different', displayName: null })).toBe(false);
    } finally { await rm(folder, { recursive: true, force: true }); }
  });
  it('persists a native token rotation after the matching token login without restarting the worker', async () => {
    const folder = await mkdtemp(join(tmpdir(), 'line-native-rotation-'));
    try {
      const secrets = new SecretStore(folder, { async protect(value) { return value; }, async unprotect(value) { return value; } });
      secrets.beginLogin('a', 'saved-worker', 'saved-attempt');
      await secrets.saveRotation('a', 'saved-worker', 'saved-attempt', { token: 'before', qrCert: null, e2eeStorage: null });
      const commands: LineWorkerCommand[] = [];
      const service = new LineService(accounts, messages, settings, { async send(command) { commands.push(command); } },
        { kick() {}, async stopChat() {}, async resetChat() {} }, secrets);
      await service.bind({ accountId: 'a', workerInstanceId: 'token-worker', controlEpoch: 1, mode: 'ACTIVE_CONTROL' });
      await service.requestTokenLogin('a', 'token-worker', 'token-attempt');
      await service.handleWorkerEvent('token-worker', { type: 'login', accountId: 'a', workerInstanceId: 'token-worker',
        controlEpoch: 1, loginAttemptId: 'token-attempt', ownMid: 'agent-mid', displayName: 'Agent' });
      await service.handleWorkerEvent('token-worker', { type: 'secretRotation', accountId: 'a', workerInstanceId: 'token-worker',
        controlEpoch: 1, loginAttemptId: 'token-attempt', secrets: { token: 'after', qrCert: 'rotated-cert', e2eeStorage: null } });
      expect(await secrets.load('a')).toEqual({ token: 'after', qrCert: 'rotated-cert', e2eeStorage: null });
      expect(commands.map((command) => command.type)).toEqual(['setSecretState', 'loginToken']);
      expect(service.isCurrentWorkerEvent('token-worker', { type: 'status', accountId: 'a', workerInstanceId: 'token-worker',
        controlEpoch: 1, state: 'ready', message: null })).toBe(true);
    } finally { await rm(folder, { recursive: true, force: true }); }
  });
  it.each([
    ['en', 'job-1', 'Agent running (job-1)'], ['zh-TW', 'job-1', 'Agent 執行中（job-1）'],
    ['ja', 'job-1', 'Agent 実行中（job-1）'], ['ko', 'job-1', 'Agent 실행 중 (job-1)'],
    ['en', null, 'Agent idle'], ['zh-TW', null, 'Agent 閒置'], ['ja', null, 'Agent 待機中'], ['ko', null, 'Agent 대기 중'],
  ] as const)('answers /status in %s using current chat state without enqueuing an Agent job', async (locale, jobId, expected) => {
    const commands: LineWorkerCommand[] = [];
    const messageId = `status-message-${locale}-${jobId ?? 'idle'}`;
    const service = new LineService(accounts, messages, settings, { async send(command) { commands.push(command); } },
      { kick() {}, async stopChat() {}, async resetChat() {}, async getChatStatus() { return { runningJobId: jobId }; } },
      undefined, undefined, undefined, admins, undefined, undefined, locale);
    service.bind({ accountId: 'a', workerInstanceId: 'w1', controlEpoch: 1, mode: 'ACTIVE_CONTROL' });
    await service.handleWorkerEvent('w1', { ...batch(), batchId: `status-batch-${locale}-${jobId ?? 'idle'}`, cursorAfter: cursor('3'),
      envelopes: [{ ...batch().envelopes[0]!, eventId: `${messageId}-event`, messageId, text: '/status' }] });
    expect(commands).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'sendText', chatId: 'c', text: expected, replyToMessageId: messageId }),
      expect.objectContaining({ type: 'ackBatch' }),
    ]));
    if (jobId) expect(commands.find((command) => command.type === 'sendText')?.type === 'sendText'
      ? commands.find((command) => command.type === 'sendText')?.text : '').toContain(jobId);
  });

  describe('/權限 command', () => {
    const permissionService = (workerInstanceId: string, now: () => number = Date.now, startRevision = '0') => {
      const commands: LineWorkerCommand[] = []; const kicked: string[] = [];
      /** Result status the mocked shared LINE reply transport reports for each sendText. */
      const reply = { status: 'sent' as 'sent' | 'failed' | 'unknown' };
      let service!: BaseLineService;
      const transport: PermissionCommandTransport = {
        async isAgentAccount() { return true; },
        async activeBinding(accountId) { return service.binding(accountId); },
        async isCurrentControl() { return true; },
        async send(command) {
          commands.push(command);
          return { type: 'sendResult', accountId: command.accountId, workerInstanceId: command.workerInstanceId,
            controlEpoch: command.controlEpoch, requestId: command.requestId, status: reply.status,
            messageId: reply.status === 'sent' ? `sent-${command.requestId}` : null, error: reply.status === 'sent' ? null : 'not sent' };
        },
      };
      const permissionCommands = new PermissionCommandService(new AgentPermissionRepository(pool), transport, { now, locale: 'zh-TW' });
      service = new BaseLineService(accounts, messages, settings, { async send(command) { commands.push(command); } },
        { kick(key) { kicked.push(key.chatId); }, async stopChat() {}, async resetChat() {} },
        undefined, undefined, undefined, admins,
        { async inspect() { return { status: 'available', version: 0, path: 'C:\\trusted' }; } }, undefined, whitelist,
        undefined, undefined, permissionCommands, undefined, 'zh-TW');
      const binding = { accountId: 'a', workerInstanceId, controlEpoch: 1, mode: 'ACTIVE_CONTROL' as const };
      let priorRevision = startRevision;
      const batchCursors = new Map<string, { before: string; after: string }>();
      const deliverBatch = async (batchId: string, revision: string, envelopes: InboundEnvelope[]) => {
        const recorded = batchCursors.get(batchId);
        const before = recorded?.before ?? priorRevision;
        const after = recorded?.after ?? revision;
        const result = await service.handleWorkerEvent(workerInstanceId, { ...batch(), workerInstanceId, batchId,
          cursorBefore: cursor(before), cursorAfter: cursor(after), envelopes });
        if (!recorded) { batchCursors.set(batchId, { before, after }); priorRevision = after; }
        return result;
      };
      const deliver = (name: string, revision: string, overrides: Partial<InboundEnvelope> = {}) => deliverBatch(`${name}-batch`, revision,
        [{ ...batch().envelopes[0]!, eventId: `${name}-event`, messageId: name, text: '/權限', ...overrides }]);
      const sent = () => commands.filter((command) => command.type === 'sendText');
      /** Delivers one batch; repeating a messageId in `items` or a whole call replays it as a duplicate. */
      const deliverMany = (batchId: string, revision: string, items: Array<{ id: string; text: string }>) => deliverBatch(batchId, revision,
        items.map(({ id, text }) => ({ ...batch().envelopes[0]!, eventId: `${id}-event`, messageId: id, text })));
      const texts = () => sent().map((command) => command.type === 'sendText' ? command.text : '');
      return { service, binding, commands, kicked, deliver, deliverMany, sent, texts, reply, permissionCommands };
    };
    const settle = () => new Promise((resolve) => setTimeout(resolve, 30));
    /** Sets the shared execution policy for one test and restores the previous level afterwards. */
    const withPolicy = async (level: 'read_only' | 'workspace_write' | 'trust' | 'full') => {
      const repository = new AgentPermissionRepository(pool);
      const before = await repository.getExecutionPolicy();
      await repository.setExecutionPolicy({ level, approvalTimeoutSeconds: before.approvalTimeoutSeconds, timeoutAction: before.timeoutAction, expectedVersion: before.version });
      const start = await repository.getExecutionPolicy();
      return {
        start,
        current: () => repository.getExecutionPolicy(),
        restore: async () => {
          const now = await repository.getExecutionPolicy();
          await repository.setExecutionPolicy({ level: before.level, approvalTimeoutSeconds: before.approvalTimeoutSeconds, timeoutAction: before.timeoutAction, expectedVersion: now.version });
        },
      };
    };
    const listOf = (current: string) => expect.stringContaining(`目前 Agent 執行權限：${current}\n`);
    const routeOf = async (messageId: string) => (await pool.query(
      "SELECT r.action, (SELECT count(*)::int FROM agent_jobs j WHERE j.account_id=r.account_id AND j.source_message_id=r.message_id) jobs FROM message_routes r WHERE r.account_id='a' AND r.message_id=$1",
      [messageId])).rows[0];

    it('answers the primary admin direct /權限 once without routing an Agent job', async () => {
      const { service, binding, kicked, deliver, sent } = permissionService('permission-admin-worker');
      await service.bind(binding);
      await deliver('permission-admin-list', '1700');
      await vi.waitFor(() => expect(sent()).toHaveLength(1));
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(sent()).toEqual([expect.objectContaining({ type: 'sendText', accountId: 'a', chatType: 'direct', chatId: 'c',
        replyToMessageId: 'permission-admin-list', text: expect.stringContaining('目前 Agent 執行權限：') })]);
      expect(await routeOf('permission-admin-list')).toEqual({ action: 'ignore', jobs: 0 });
      expect(kicked).toEqual([]);
    });

    it('routes a whitelisted friend direct /權限 as an ordinary prompt', async () => {
      await whitelist.activate('a', 'permission-friend', 'user');
      await settings.setConversationAgent({ accountId: 'a', chatType: 'direct', chatId: 'c', enabled: true, provider: 'codex' });
      const { service, binding, kicked, deliver, sent } = permissionService('permission-friend-worker');
      await service.bind(binding);
      await deliver('permission-friend-list', '1701', { senderId: 'permission-friend' });
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(sent()).toEqual([]);
      expect(await routeOf('permission-friend-list')).toEqual({ action: 'prompt', jobs: 1 });
      expect(kicked).toEqual(['c']);
    });

    it('routes a group @mention /權限 from the primary admin as before', async () => {
      await messages.upsertConversationCatalog('a', [{ chatType: 'group', chatId: 'permission-room', title: 'Permission room', members: [] }]);
      const { service, binding, kicked, deliver, sent } = permissionService('permission-group-worker');
      await service.bind(binding);
      await deliver('permission-group-list', '1702', { chatType: 'group', chatId: 'permission-room', senderId: 'user',
        text: '@Agent /權限', mentionIds: ['agent-mid'], mentionRanges: [{ start: 0, end: 6, userId: 'agent-mid' }] });
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(sent()).toEqual([]);
      expect(await routeOf('permission-group-list')).toEqual({ action: 'prompt', jobs: 1 });
      expect(kicked).toEqual(['permission-room']);
    });

    it('treats a number after the pending choice expires as a normal prompt', async () => {
      await settings.setConversationAgent({ accountId: 'a', chatType: 'direct', chatId: 'c', enabled: true, provider: 'codex' });
      const clock = { now: 1_000 };
      const { service, binding, kicked, deliver, sent } = permissionService('permission-expiry-worker', () => clock.now);
      await service.bind(binding);
      await deliver('permission-expiry-list', '1703');
      await vi.waitFor(() => expect(sent()).toHaveLength(1));
      clock.now += 120_000;
      await deliver('permission-expiry-choice', '1704', { text: '2' });
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(sent()).toHaveLength(1);
      expect(await routeOf('permission-expiry-choice')).toEqual({ action: 'prompt', jobs: 1 });
      expect(kicked).toEqual(['c']);
    });

    it('keeps the armed list when a duplicate /權限 is replayed, then applies a tighter choice', async () => {
      const policy = await withPolicy('trust');
      try {
        const { service, binding, kicked, deliverMany, texts } = permissionService('permission-replay-list-worker');
        await service.bind(binding);
        await deliverMany('permission-replay-list-batch', '1710', [{ id: 'permission-replay-list', text: '/權限' }]);
        await vi.waitFor(() => expect(texts()).toHaveLength(1));
        await settle();
        expect(await deliverMany('permission-replay-list-batch', '1710', [{ id: 'permission-replay-list', text: '/權限' }])).toEqual([]);
        await settle();
        expect(texts()).toEqual([listOf('信任')]);
        await deliverMany('permission-replay-choice-batch', '1711', [{ id: 'permission-replay-choice', text: '1' }]);
        await vi.waitFor(() => expect(texts()).toHaveLength(2));
        await settle();
        expect(texts()).toEqual([listOf('信任'), '已改為 唯讀']);
        expect(await policy.current()).toMatchObject({ level: 'read_only', version: policy.start.version + 1 });
        expect(await routeOf('permission-replay-choice')).toEqual({ action: 'ignore', jobs: 0 });
        expect(kicked).toEqual([]);
      } finally { await policy.restore(); }
    });

    it('does not write or reply again for a replayed choice or confirmation', async () => {
      const policy = await withPolicy('workspace_write');
      try {
        const { service, binding, kicked, deliverMany, texts } = permissionService('permission-replay-confirm-worker');
        await service.bind(binding);
        await deliverMany('permission-replay-confirm-list-batch', '1712', [{ id: 'permission-replay-confirm-list', text: '/權限' }]);
        await vi.waitFor(() => expect(texts()).toHaveLength(1));
        await settle();
        await deliverMany('permission-replay-confirm-choice-batch', '1713', [{ id: 'permission-replay-confirm-choice', text: '4' }]);
        await vi.waitFor(() => expect(texts()).toHaveLength(2));
        await settle();
        await deliverMany('permission-replay-confirm-choice-batch', '1713', [{ id: 'permission-replay-confirm-choice', text: '4' }]);
        await settle();
        expect(texts()).toHaveLength(2);
        await deliverMany('permission-replay-confirm-yes-batch', '1714', [{ id: 'permission-replay-confirm-yes', text: '確認' }]);
        await vi.waitFor(() => expect(texts()).toHaveLength(3));
        await settle();
        await deliverMany('permission-replay-confirm-yes-batch', '1714', [{ id: 'permission-replay-confirm-yes', text: '確認' }]);
        await settle();
        expect(texts()).toEqual([listOf('工作區可寫'), '確定要放寬為 全部放行？回覆「確認」套用，回覆其他內容取消（2 分鐘內有效）', '已放寬為 全部放行']);
        expect(await policy.current()).toMatchObject({ level: 'full', version: policy.start.version + 1 });
        expect(await routeOf('permission-replay-confirm-choice')).toEqual({ action: 'ignore', jobs: 0 });
        expect(await routeOf('permission-replay-confirm-yes')).toEqual({ action: 'ignore', jobs: 0 });
        expect(kicked).toEqual([]);
      } finally { await policy.restore(); }
    });

    it('applies a message repeated within one batch once', async () => {
      const policy = await withPolicy('trust');
      try {
        const { service, binding, kicked, deliverMany, texts } = permissionService('permission-batch-duplicate-worker');
        await service.bind(binding);
        await deliverMany('permission-batch-duplicate-list-batch', '1715', [
          { id: 'permission-batch-duplicate-list', text: '/權限' }, { id: 'permission-batch-duplicate-list', text: '/權限' }]);
        await vi.waitFor(() => expect(texts()).toHaveLength(1));
        await settle();
        await deliverMany('permission-batch-duplicate-choice-batch', '1716', [
          { id: 'permission-batch-duplicate-choice', text: '1' }, { id: 'permission-batch-duplicate-choice', text: '1' }]);
        await vi.waitFor(() => expect(texts()).toHaveLength(2));
        await settle();
        expect(texts()).toEqual([listOf('信任'), '已改為 唯讀']);
        expect(await policy.current()).toMatchObject({ level: 'read_only', version: policy.start.version + 1 });
        expect(kicked).toEqual([]);
      } finally { await policy.restore(); }
    });

    it('applies exactly one effect when a failed ingestion is retried', async () => {
      const policy = await withPolicy('trust');
      const ingest = vi.spyOn(messages, 'ingestBatchSource');
      try {
        const { service, binding, kicked, deliverMany, texts } = permissionService('permission-ingest-retry-worker');
        await service.bind(binding);
        const list = [{ id: 'permission-ingest-retry-list', text: '/權限' }];
        ingest.mockRejectedValueOnce(new Error('commit failed'));
        await expect(deliverMany('permission-ingest-retry-list-batch', '1717', list)).rejects.toThrow('commit failed');
        await settle();
        expect(texts()).toEqual([]);
        await deliverMany('permission-ingest-retry-list-batch', '1717', list);
        await vi.waitFor(() => expect(texts()).toHaveLength(1));
        await settle();
        const choice = [{ id: 'permission-ingest-retry-choice', text: '1' }];
        ingest.mockRejectedValueOnce(new Error('commit failed'));
        await expect(deliverMany('permission-ingest-retry-choice-batch', '1718', choice)).rejects.toThrow('commit failed');
        await settle();
        expect(texts()).toHaveLength(1);
        expect((await policy.current()).version).toBe(policy.start.version);
        await deliverMany('permission-ingest-retry-choice-batch', '1718', choice);
        await vi.waitFor(() => expect(texts()).toHaveLength(2));
        await deliverMany('permission-ingest-retry-choice-batch', '1718', choice);
        await settle();
        expect(texts()).toEqual([listOf('信任'), '已改為 唯讀']);
        expect(await policy.current()).toMatchObject({ level: 'read_only', version: policy.start.version + 1 });
        expect(await routeOf('permission-ingest-retry-choice')).toEqual({ action: 'ignore', jobs: 0 });
        expect(kicked).toEqual([]);
      } finally { ingest.mockRestore(); await policy.restore(); }
    });

    it('never routes a confirmation-stage message to an Agent job', async () => {
      await settings.setConversationAgent({ accountId: 'a', chatType: 'direct', chatId: 'c', enabled: true, provider: 'codex' });
      const policy = await withPolicy('workspace_write');
      try {
        const { service, binding, kicked, deliverMany, texts } = permissionService('permission-confirm-route-worker');
        await service.bind(binding);
        await deliverMany('permission-confirm-route-list-batch', '1719', [{ id: 'permission-confirm-route-list', text: '/權限' }]);
        await vi.waitFor(() => expect(texts()).toHaveLength(1));
        await deliverMany('permission-confirm-route-choice-batch', '1720', [{ id: 'permission-confirm-route-choice', text: '3' }]);
        await vi.waitFor(() => expect(texts()).toHaveLength(2));
        await deliverMany('permission-confirm-route-cancel-batch', '1721', [{ id: 'permission-confirm-route-cancel', text: '幫我寫程式' }]);
        await vi.waitFor(() => expect(texts()).toHaveLength(3));
        await deliverMany('permission-confirm-route-list2-batch', '1722', [{ id: 'permission-confirm-route-list2', text: '/permissions' }]);
        await vi.waitFor(() => expect(texts()).toHaveLength(4));
        await deliverMany('permission-confirm-route-choice2-batch', '1723', [{ id: 'permission-confirm-route-choice2', text: '3' }]);
        await vi.waitFor(() => expect(texts()).toHaveLength(5));
        await deliverMany('permission-confirm-route-yes-batch', '1724', [{ id: 'permission-confirm-route-yes', text: 'yes' }]);
        await vi.waitFor(() => expect(texts()).toHaveLength(6));
        await settle();
        expect(texts().slice(2)).toEqual(['已取消', listOf('工作區可寫'),
          '確定要放寬為 信任？回覆「確認」套用，回覆其他內容取消（2 分鐘內有效）', '已放寬為 信任']);
        for (const id of ['permission-confirm-route-list', 'permission-confirm-route-choice', 'permission-confirm-route-cancel',
          'permission-confirm-route-list2', 'permission-confirm-route-choice2', 'permission-confirm-route-yes']) {
          expect(await routeOf(id)).toEqual({ action: 'ignore', jobs: 0 });
        }
        expect(await policy.current()).toMatchObject({ level: 'trust', version: policy.start.version + 1 });
        expect(kicked).toEqual([]);
      } finally { await policy.restore(); }
    });

    it('keeps the list and confirm prompts unarmed when the transport reports failed or unknown', async () => {
      await settings.setConversationAgent({ accountId: 'a', chatType: 'direct', chatId: 'c', enabled: true, provider: 'codex' });
      for (const [index, status] of (['failed', 'unknown'] as const).entries()) {
        const policy = await withPolicy('workspace_write');
        try {
          const prefix = `permission-unsent-${status}`;
          const revision = (base: number) => String(1730 + index * 10 + base);
          const { service, binding, commands, kicked, deliverMany, texts, reply, permissionCommands } =
            permissionService(`${prefix}-worker`, Date.now, index === 0 ? '0' : '1734');
          await service.bind(binding);
          const acks = () => commands.filter((command) => command.type === 'ackBatch').length;

          // An unsent list leaves the following digit to the Agent.
          reply.status = status;
          await deliverMany(`${prefix}-list-batch`, revision(0), [{ id: `${prefix}-list`, text: '/權限' }]);
          await vi.waitFor(() => expect(permissionCommands.sizes().runners).toBe(0));
          expect(texts()).toEqual([listOf('工作區可寫')]);
          reply.status = 'sent';
          await deliverMany(`${prefix}-digit-batch`, revision(1), [{ id: `${prefix}-digit`, text: '1' }]);
          await settle();
          expect(texts()).toHaveLength(1);
          expect(await routeOf(`${prefix}-digit`)).toEqual({ action: 'prompt', jobs: 1 });

          // An unsent confirm question leaves the following confirmation to the Agent.
          await deliverMany(`${prefix}-list2-batch`, revision(2), [{ id: `${prefix}-list2`, text: '/權限' }]);
          await vi.waitFor(() => expect(texts()).toHaveLength(2));
          await vi.waitFor(() => expect(permissionCommands.sizes().runners).toBe(0));
          reply.status = status;
          await deliverMany(`${prefix}-choice-batch`, revision(3), [{ id: `${prefix}-choice`, text: '4' }]);
          await vi.waitFor(() => expect(texts()).toHaveLength(3));
          await vi.waitFor(() => expect(permissionCommands.sizes().runners).toBe(0));
          reply.status = 'sent';
          await deliverMany(`${prefix}-yes-batch`, revision(4), [{ id: `${prefix}-yes`, text: '確認' }]);
          await settle();
          expect(texts()).toEqual([listOf('工作區可寫'), listOf('工作區可寫'),
            '確定要放寬為 全部放行？回覆「確認」套用，回覆其他內容取消（2 分鐘內有效）']);
          expect(await routeOf(`${prefix}-choice`)).toEqual({ action: 'ignore', jobs: 0 });
          expect(await routeOf(`${prefix}-yes`)).toEqual({ action: 'prompt', jobs: 1 });
          expect(await policy.current()).toMatchObject({ level: 'workspace_write', version: policy.start.version });
          expect(acks()).toBe(5);
          expect(kicked).toEqual(['c', 'c']);
          await permissionCommands.close();
        } finally { await policy.restore(); }
      }
    });
  });
  it('queues every supported attachment kind by its authoritative ID after commit', async () => {
    const ids: string[] = [];
    const service = new LineService(accounts, messages, settings, { async send() {} },
      { kick() {}, async stopChat() {}, async resetChat() {} }, undefined,
      { async downloadById(id) { ids.push(id); return true; } });
    service.bind({ accountId: 'a', workerInstanceId: 'w1', controlEpoch: 1, mode: 'ACTIVE_CONTROL' });
    await service.handleWorkerEvent('w1', { ...batch(), batchId: 'attachments', cursorAfter: cursor('4'),
      envelopes: [{ ...batch().envelopes[0]!, eventId: 'att-event', messageId: 'att-message', kind: 'image', text: null,
        attachments: (['image', 'video', 'audio', 'file'] as const).map((kind) => ({ id: `external-${kind}`, kind, name: null, mimeType: null, sizeBytes: null })) }] });
    expect(ids).toHaveLength(4);
    expect(new Set(ids).size).toBe(4);
  });
  it('acknowledges a committed LINE batch without waiting for attachment network downloads', async () => {
    const commands: LineWorkerCommand[] = [];
    let started!: () => void; let release!: () => void;
    const downloadStarted = new Promise<void>((resolve) => { started = resolve; });
    const downloadGate = new Promise<void>((resolve) => { release = resolve; });
    const service = new LineService(accounts, messages, settings, { async send(command) { commands.push(command); } },
      { kick() {}, async stopChat() {}, async resetChat() {} }, undefined,
      { async downloadById() { started(); await downloadGate; return true; } });
    service.bind({ accountId: 'a', workerInstanceId: 'w1', controlEpoch: 1, mode: 'ACTIVE_CONTROL' });
    const handling = service.handleWorkerEvent('w1', { ...batch(), batchId: 'nonblocking-attachment', cursorAfter: cursor('5'),
      envelopes: [{ ...batch().envelopes[0]!, eventId: 'nonblocking-attachment-event',
        messageId: 'nonblocking-attachment-message', kind: 'file', text: null,
        attachments: [{ id: 'nonblocking-external-file', kind: 'file', name: 'report.pdf',
          mimeType: 'application/pdf', sizeBytes: 12 }] }] });
    try {
      await downloadStarted;
      await expect(Promise.race([handling.then(() => 'acknowledged'),
        new Promise<string>((resolve) => setTimeout(() => resolve('blocked'), 100))])).resolves.toBe('acknowledged');
      expect(commands).toContainEqual(expect.objectContaining({ type: 'ackBatch', batchId: 'nonblocking-attachment' }));
    } finally {
      release();
      await handling;
    }
  });
  it('archives worker history without triggering an Agent', async () => {
    const kicked: string[] = [];
    const service = new LineService(accounts, messages, settings, { async send() {} },
      { kick(key) { kicked.push(key.chatId); }, async stopChat() {}, async resetChat() {} });
    service.bind({ accountId: 'a', workerInstanceId: 'w1', controlEpoch: 1, mode: 'ACTIVE_CONTROL' });
    await service.handleWorkerEvent('w1', { type: 'historyResult', accountId: 'a', workerInstanceId: 'w1', controlEpoch: 1,
      chatType: 'direct', chatId: 'c', requestId: 'history-request', nextCursor: null,
      envelopes: [{ ...batch().envelopes[0]!, eventId: 'history-event', messageId: 'history-message',
        ingestion: { source: 'history', cursor: null } }] });
    expect((await messages.searchMessages({ key: { accountId: 'a', chatType: 'direct', chatId: 'c' }, text: 'hello', limit: 100 })).map((row) => row.messageId)).toContain('history-message');
    expect(kicked).toEqual([]);
  });
  it('persists the LINE conversation catalog and member nicknames', async () => {
    const service = new LineService(accounts, messages, settings, { async send() {} },
      { kick() {}, async stopChat() {}, async resetChat() {} });
    service.bind({ accountId: 'a', workerInstanceId: 'w1', controlEpoch: 1, mode: 'ACTIVE_CONTROL' });
    await service.handleWorkerEvent('w1', { type: 'conversationCatalog', accountId: 'a', workerInstanceId: 'w1',
      controlEpoch: 1, conversations: [{ chatType: 'group', chatId: 'catalog-chat', title: '工程群組',
        members: [{ memberId: 'member-1', displayName: '王小明' }] }] });
    const rows = await pool.query(`SELECT c.title,cm.display_name FROM conversations c
      JOIN conversation_members cm USING(account_id,chat_type,chat_id)
      WHERE c.account_id='a' AND c.chat_type='group' AND c.chat_id='catalog-chat'`);
    expect(rows.rows).toEqual([{ title: '工程群組', display_name: '王小明' }]);
  });
  it('stores an empty live catalog title without erasing an existing title and updates real titles', async () => {
    const service = new LineService(accounts, messages, settings, { async send() {} },
      { kick() {}, async stopChat() {}, async resetChat() {} });
    service.bind({ accountId: 'a', workerInstanceId: 'w1', controlEpoch: 1, mode: 'ACTIVE_CONTROL' });
    await messages.upsertConversationCatalog('a', [{ chatType: 'group', chatId: 'catalog-keeps-title', title: 'Stored real title', members: [] }]);
    const refresh = (chatType: 'direct' | 'group', chatId: string, title: string | null) => service.handleWorkerEvent('w1', {
      type: 'conversationCatalog', accountId: 'a', workerInstanceId: 'w1', controlEpoch: 1,
      conversations: [{ chatType, chatId, title, members: [] }],
    });
    await refresh('direct', 'catalog-empty-title', null);
    await refresh('group', 'catalog-keeps-title', null);
    await service.handleWorkerEvent('w1', { type: 'conversationCatalog', accountId: 'a', workerInstanceId: 'w1', controlEpoch: 1,
      conversations: [{ chatType: 'group', chatId: 'catalog-updates-title', title: 'Updated real title', members: [] }] });
    const rows = await pool.query(`SELECT chat_id,title FROM conversations
      WHERE account_id='a' AND chat_id = ANY($1::text[]) ORDER BY chat_id`,
    [['catalog-empty-title', 'catalog-keeps-title', 'catalog-updates-title']]);
    expect(rows.rows).toEqual([
      { chat_id: 'catalog-empty-title', title: '' },
      { chat_id: 'catalog-keeps-title', title: 'Stored real title' },
      { chat_id: 'catalog-updates-title', title: 'Updated real title' },
    ]);
  });
  it('persists the contact fields of the worker catalog response into line_contacts, the store the native pass also writes', async () => {
    const service = new LineService(accounts, messages, settings, { async send() {} },
      { kick() {}, async stopChat() {}, async resetChat() {} });
    service.bind({ accountId: 'a', workerInstanceId: 'w1', controlEpoch: 1, mode: 'ACTIVE_CONTROL' });
    const catalog = (members: Array<{ memberId: string; displayName: string | null; nickname?: string | null }>, title: string | null) =>
      service.handleWorkerEvent('w1', { type: 'conversationCatalog', accountId: 'a', workerInstanceId: 'w1', controlEpoch: 1,
        conversations: [{ chatType: 'direct', chatId: 'live-friend', title, members: members.filter((member) => member.memberId === 'live-friend') },
          { chatType: 'group', chatId: 'live-group', title: 'Live Group', members }] });
    await catalog([{ memberId: 'live-friend', displayName: 'Live Real', nickname: '張襄君' },
      { memberId: 'live-stranger', displayName: 'Stranger', nickname: '' }], '張襄君');
    const read = async () => (await pool.query(`SELECT mid,display_name,nickname FROM line_contacts
      WHERE account_id='a' AND mid LIKE 'live-%' ORDER BY mid`)).rows;
    expect(await read()).toEqual([{ mid: 'live-friend', display_name: 'Live Real', nickname: '張襄君' },
      { mid: 'live-stranger', display_name: 'Stranger', nickname: null }]);
    // A later response that does not carry the nickname field keeps the stored nickname and never blanks a name.
    await catalog([{ memberId: 'live-friend', displayName: null }, { memberId: 'live-stranger', displayName: 'Stranger' }], '張襄君');
    expect(await read()).toEqual([{ mid: 'live-friend', display_name: 'Live Real', nickname: '張襄君' },
      { mid: 'live-stranger', display_name: 'Stranger', nickname: null }]);
    expect((await pool.query("SELECT title FROM conversations WHERE account_id='a' AND chat_type='direct' AND chat_id='live-friend'")).rows)
      .toEqual([{ title: '張襄君' }]);
  });
});

describe('read position change publication', () => {
  function setup(result: Record<string, unknown>) {
    const published: Array<Array<{ key: unknown; messageId: string }>> = [];
    const order: string[] = [];
    const service = new BaseLineService(
      { async bindWorker() {}, async getAccount() { return { ownMid: 'agent' }; } } as never,
      { async listPendingRouteActions() { return []; }, async applyPendingRouteAction() {},
        async ingestBatchAndRoute() {
          return { insertedMessageIds: [], jobMessageIds: [], jobIds: [], jobStatuses: [], primaryAdminActionMessageIds: [], ...result };
        } } as never,
      { async getAppSetting() { return undefined; }, async getConversationAgent() { return null; } } as never,
      { async send() { order.push('ack'); } },
      { kick() {}, async stopChat() {}, async resetChat() {} },
      undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined,
      (changes) => { order.push('publish'); published.push([...changes] as never); },
    );
    return { service, published, order };
  }
  const changes = [
    { key: { accountId: 'a', chatType: 'group', chatId: 'c1' }, messageId: '10' },
    { key: { accountId: 'a', chatType: 'room', chatId: 'r1' }, messageId: '11' },
  ];

  it('publishes one change per affected conversation when positions advanced', async () => {
    const { service, published, order } = setup({ readPositionsChanged: 3, readPositionChanges: changes });
    await service.bind({ accountId: 'a', workerInstanceId: 'w1', controlEpoch: 1, mode: 'ACTIVE_CONTROL' });
    await service.handleWorkerEvent('w1', { ...batch(), envelopes: [] });
    expect(published).toEqual([changes]);
    expect(order).toEqual(['publish', 'ack']);
  });

  it('publishes nothing for a replay without position changes', async () => {
    const { service, published } = setup({ readPositionsChanged: 0, readPositionChanges: [] });
    await service.bind({ accountId: 'a', workerInstanceId: 'w1', controlEpoch: 1, mode: 'ACTIVE_CONTROL' });
    await service.handleWorkerEvent('w1', { ...batch(), envelopes: [] });
    expect(published).toEqual([]);
  });
});
