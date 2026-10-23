import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { LineWorkerCommand, WorkerBinding } from '@line-agent/contracts';
import type { AutoResponderSettings, InboundEnvelope } from '@line-agent/contracts';
import { AccountRepository, AdminRepository, MessageRepository, RoomActivationRepository } from '@line-agent/database';
import { createTestDatabase } from '../../../../../packages/database/src/test-database.js';
import { RoomAutomationService } from './room-automation.js';
import type { Locale } from '../../locale.js';

const database = process.env.TEST_DATABASE_URL ? describe : describe.skip;

describe('room activation prompt localization', () => {
  it.each([
    ['en', 'Room activation confirmation for group room-1.', 'Activation is waiting'],
    ['zh-TW', '聊天室啟用確認：group room-1。', '等待帳號主要管理員'],
    ['ja', 'ルーム有効化の確認：group room-1。', 'アカウントの主管理者'],
    ['ko', '룸 활성화 확인: group room-1.', '계정 기본 관리자의'],
    ['unsupported', 'Room activation confirmation for group room-1.', 'Activation is waiting'],
  ] as Array<[string, string, string]>)('uses %s and preserves token and destination', async (locale, prefix, waiting) => {
    const commands: Extract<LineWorkerCommand, { type: 'sendText' }>[] = [];
    const service = new RoomAutomationService({ requestActivation: vi.fn(async () => ({ disposition: 'created', requestId: 'request' })),
      claimWaitingToSend: vi.fn(async () => ({ leaseToken: 'lease', adminChatId: 'admin' })),
      prepareChallengeSend: vi.fn(async () => true), markChallengeDeliveryUnknown: vi.fn() } as never,
    { get: vi.fn(), beginReplyEffect: vi.fn(), finishReplyEffect: vi.fn() } as never, Buffer.alloc(32, 1), 1,
    { async isAgentAccount() { return true; }, async activeBinding() { return { accountId: 'a', workerInstanceId: 'w', controlEpoch: 1 }; },
      async isCurrentControl() { return true; }, async send(command) { commands.push(command); return { type: 'sendResult', requestId: command.requestId,
        accountId: 'a', workerInstanceId: 'w', controlEpoch: 1, status: 'sent', messageId: 'sent', error: null }; } }, locale);
    await service.handle({ type: 'request', accountId: 'a', chatType: 'group', chatId: 'room-1', senderId: 'member', messageId: 'source' });
    const token = commands[0]!.text.match(/RA-[A-Za-z0-9_-]{43}/)?.[0];
    expect(token).toBeTruthy();
    expect(commands[0]).toMatchObject({ chatType: 'direct', chatId: 'admin' });
    expect(commands[0]!.text).toContain(prefix);
    expect(commands[0]!.text).toContain(token!);
    expect(commands[1]).toMatchObject({ chatType: 'group', chatId: 'room-1' });
    expect(commands[1]!.text).toContain(waiting);
  });
});

database('live room activation service', () => {
  let pool: Awaited<ReturnType<typeof createTestDatabase>>['pool'];
  let close: (() => Promise<void>) | undefined;
  let rooms: RoomActivationRepository;
  let accountId: string;
  let sent: Extract<LineWorkerCommand, { type: 'sendText' }>[];
  /** The signal argument of every transport send; room automation never passes one. */
  let sendSignals: unknown[];
  let service: RoomAutomationService;
  let active: boolean;
  let autoSettings: AutoResponderSettings;
  const binding: WorkerBinding = { accountId: 'activation-account', workerInstanceId: 'activation-worker', controlEpoch: 3 };

  beforeAll(async () => {
    ({ pool, close } = await createTestDatabase());
    accountId = `activation-${randomUUID()}`;
    const accounts = new AccountRepository(pool);
    const admins = new AdminRepository(pool);
    const messages = new MessageRepository(pool);
    rooms = new RoomActivationRepository(pool);
    await accounts.ensureAccount(accountId);
    await accounts.activateControl(accountId, 1);
    await accounts.setOwnMid(accountId, 'own-agent-mid');
    await admins.bindPrimary(accountId, 'primary-admin-chat', 'primary-admin');
    await messages.upsertConversationCatalog(accountId, [{ chatType: 'group', chatId: 'activation-room', title: 'Source room', members: [] }]);
  });
  beforeEach(() => {
    sent = [];
    sendSignals = [];
    active = true;
    autoSettings = { version: 0, displayName: 'Agent', fallback: 'fallback', rules: [{ trigger: 'hello there', reply: 'Exact reply' }] };
    const replyClaims = new Set<string>();
    service = new RoomAutomationService(rooms, { async get() { return autoSettings; },
      async beginReplyEffect(_key, sourceMessageId) {
        if (replyClaims.has(sourceMessageId)) return 'duplicate';
        replyClaims.add(sourceMessageId); return 'created';
      }, async finishReplyEffect() { return true; } },
      Buffer.alloc(32, 7), 1, {
        async isAgentAccount() { return true; },
        async activeBinding() { return active ? { ...binding, accountId } : null; },
        async isCurrentControl() { return active; },
        async send(command, ...rest: unknown[]) { sent.push(command); sendSignals.push(rest.length ? rest[0] : 'none');
          return { type: 'sendResult', requestId: command.requestId, accountId, workerInstanceId: binding.workerInstanceId,
            controlEpoch: binding.controlEpoch, status: 'sent', messageId: randomUUID(), error: null };
        },
      });
  });
  afterAll(async () => { await close?.(); });

  it('sends the one-time token only to the account primary admin, then waits in the source room and enables on scoped confirmation', async () => {
    await service.handle({ type: 'request', accountId, chatType: 'group', chatId: 'activation-room', senderId: 'member', messageId: 'request-live' });
    expect(sent).toHaveLength(2);
    expect(sent[0]).toMatchObject({ chatType: 'direct', chatId: 'primary-admin-chat' });
    expect(sent[1]).toMatchObject({ chatType: 'group', chatId: 'activation-room' });
    const token = sent[0]!.text.match(/RA-[A-Za-z0-9_-]{43}/)?.[0];
    expect(token).toBeTruthy();
    expect(sent[1]!.text).not.toContain(token!);
    expect(sendSignals).toEqual(['none', 'none']);
    await service.handle({ type: 'confirmation-candidate', accountId, chatType: 'group', chatId: 'activation-room',
      senderId: 'primary-admin', messageId: 'confirm-live', token: token! });
    expect(await rooms.getPolicy({ accountId, chatType: 'group', chatId: 'activation-room' })).toMatchObject({ state: 'ENABLED' });
    await service.respond({ accountId, chatType: 'group', chatId: 'activation-room', messageId: 'activated-room-message' } as InboundEnvelope,
      'hello there');
    expect(sent).toHaveLength(2);
  });

  it.each([
    ['en', 'Room activation confirmation for group activation-room.', 'Activation is waiting'],
    ['zh-TW', '聊天室啟用確認：group activation-room。', '等待帳號主要管理員'],
    ['ja', 'ルーム有効化の確認：group activation-room。', 'アカウントの主管理者'],
    ['ko', '룸 활성화 확인: group activation-room.', '계정 기본 관리자의'],
    ['unsupported', 'Room activation confirmation for group activation-room.', 'Activation is waiting'],
  ] as Array<[Locale | string, string, string]>)('localizes activation prompts in %s and preserves token and routing', async (locale, adminPrefix, waitingPrefix) => {
    service = new RoomAutomationService(rooms, { async get() { return autoSettings; }, async beginReplyEffect() { return 'created'; }, async finishReplyEffect() { return true; } },
      Buffer.alloc(32, 7), 1, {
        async isAgentAccount() { return true; }, async activeBinding() { return { ...binding, accountId }; },
        async isCurrentControl() { return true; }, async send(command) {
          sent.push(command); return { type: 'sendResult', requestId: command.requestId, accountId, workerInstanceId: binding.workerInstanceId,
            controlEpoch: binding.controlEpoch, status: 'sent', messageId: randomUUID(), error: null };
        },
      }, locale);
    await service.handle({ type: 'request', accountId, chatType: 'group', chatId: 'activation-room', senderId: 'member', messageId: 'localized-request' });
    const token = sent[0]!.text.match(/RA-[A-Za-z0-9_-]{43}/)?.[0];
    expect(token).toBeTruthy();
    expect(sent[0]).toMatchObject({ chatType: 'direct', chatId: 'primary-admin-chat' });
    expect(sent[0]!.text).toContain(adminPrefix);
    expect(sent[0]!.text).toContain(`@agent`);
    expect(sent[0]!.text).toContain(token!);
    expect(sent[1]).toMatchObject({ chatType: 'group', chatId: 'activation-room' });
    expect(sent[1]!.text).toContain(waitingPrefix);
  });

  it('does not create activation state or send when this account is not ACTIVE_CONTROL', async () => {
    active = false;
    await service.handle({ type: 'request', accountId, chatType: 'group', chatId: 'activation-room', senderId: 'member', messageId: 'monitor-only-request' });
    expect(sent).toEqual([]);
  });

  it('uses exact normalized triggers and suppresses a replayed deterministic reply', async () => {
    const envelope = { accountId, chatType: 'group', chatId: 'respond-room', messageId: 'reply-source' } as InboundEnvelope;
    await service.respond(envelope, 'hello   there');
    await service.respond(envelope, 'hello   there');
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ chatType: 'group', chatId: 'respond-room', text: 'Exact reply' });
  });

  it('does not send a fixed reply when no account session is active', async () => {
    active = false;
    const envelope = { accountId, chatType: 'group', chatId: 'offline-room', messageId: 'offline-source' } as InboundEnvelope;
    await service.respond(envelope, 'hello there');
    expect(sent).toEqual([]);
  });
});

describe('room auto-reply account role gate', () => {
  it('does not read or send the global reply for a Primary Admin account', async () => {
    const send = vi.fn();
    const get = vi.fn();
    const service = new RoomAutomationService(
      { hasActiveRoomGrant: async () => false } as never,
      { get, beginReplyEffect: vi.fn(), finishReplyEffect: vi.fn() } as never,
      Buffer.alloc(32, 7), 1,
      { isAgentAccount: async () => false, activeBinding: vi.fn(), isCurrentControl: vi.fn(), send } as never,
    );
    await service.respond({ accountId: 'primary-admin', chatType: 'group', chatId: 'room', messageId: 'message' } as InboundEnvelope,
      'hello there');
    expect(get).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
  });
});
