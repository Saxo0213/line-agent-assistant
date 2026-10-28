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
  const cases: Array<[string, 'group' | 'room', string | null, string, string]> = [
    ['en', 'group', 'Team Chat', 'Room activation confirmation for group Team Chat.', 'Activation is waiting'],
    ['zh-TW', 'group', 'Team Chat', '聊天室啟用確認：群組 Team Chat。', '等待帳號主要管理員'],
    ['ja', 'group', 'Team Chat', 'ルーム有効化の確認：グループ Team Chat。', 'アカウントの主管理者'],
    ['ko', 'group', 'Team Chat', '룸 활성화 확인: 그룹 Team Chat.', '계정 기본 관리자의'],
    ['unsupported', 'group', 'Team Chat', 'Room activation confirmation for group Team Chat.', 'Activation is waiting'],
    ['en', 'group', null, 'Room activation confirmation for group Unnamed group.', 'Activation is waiting'],
    ['zh-TW', 'group', null, '聊天室啟用確認：群組 未命名群組。', '等待帳號主要管理員'],
    ['ja', 'group', null, 'ルーム有効化の確認：グループ 名称未設定のグループ。', 'アカウントの主管理者'],
    ['ko', 'group', null, '룸 활성화 확인: 그룹 이름 없는 그룹.', '계정 기본 관리자의'],
    ['en', 'room', null, 'Room activation confirmation for chat room Unnamed chat room.', 'Activation is waiting'],
    ['zh-TW', 'room', null, '聊天室啟用確認：多人聊天室 未命名聊天室。', '等待帳號主要管理員'],
    ['ja', 'room', null, 'ルーム有効化の確認：トークルーム 名称未設定のトークルーム。', 'アカウントの主管理者'],
    ['ko', 'room', null, '룸 활성화 확인: 대화방 이름 없는 대화방.', '계정 기본 관리자의'],
  ];
  it.each(cases)('uses %s for a %s titled %s: names the chat, never shows its id, keeps token and destination',
    async (locale, chatType, title, prefix, waiting) => {
    const commands: Extract<LineWorkerCommand, { type: 'sendText' }>[] = [];
    const service = new RoomAutomationService({ requestActivation: vi.fn(async () => ({ disposition: 'created', requestId: 'request' })),
      enableByPrimaryAdmin: vi.fn(async () => ({ disposition: 'not_primary_admin' })), getRoomTitle: vi.fn(async () => title),
      claimWaitingToSend: vi.fn(async () => ({ leaseToken: 'lease', adminChatId: 'admin' })),
      prepareChallengeSend: vi.fn(async () => true), markChallengeDeliveryUnknown: vi.fn() } as never,
    { get: vi.fn(), beginReplyEffect: vi.fn(), finishReplyEffect: vi.fn() } as never, Buffer.alloc(32, 1), 1,
    { async isAgentAccount() { return true; }, async activeBinding() { return { accountId: 'a', workerInstanceId: 'w', controlEpoch: 1 }; },
      async isCurrentControl() { return true; }, async send(command) { commands.push(command); return { type: 'sendResult', requestId: command.requestId,
        accountId: 'a', workerInstanceId: 'w', controlEpoch: 1, status: 'sent', messageId: 'sent', error: null }; } }, locale);
    await service.handle({ type: 'request', accountId: 'a', chatType, chatId: 'c4a128a6deadbeef0866', senderId: 'member', messageId: 'source' });
    const token = commands[0]!.text.match(/RA-[A-Za-z0-9_-]{43}/)?.[0];
    expect(token).toBeTruthy();
    expect(commands[0]).toMatchObject({ chatType: 'direct', chatId: 'admin' });
    expect(commands[0]!.text).toContain(prefix);
    expect(commands[0]!.text).toContain(token!);
    expect(commands[1]).toMatchObject({ chatType, chatId: 'c4a128a6deadbeef0866' });
    expect(commands[1]!.text).toContain(waiting);
    for (const command of commands) expect(command.text).not.toContain('c4a128a6');
  });
});

database('live room activation service', () => {
  let pool: Awaited<ReturnType<typeof createTestDatabase>>['pool'];
  let close: (() => Promise<void>) | undefined;
  let rooms: RoomActivationRepository;
  let messages: MessageRepository;
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
    messages = new MessageRepository(pool);
    rooms = new RoomActivationRepository(pool);
    await accounts.ensureAccount(accountId);
    await accounts.activateControl(accountId, 1);
    await accounts.setOwnMid(accountId, 'own-agent-mid');
    await admins.bindPrimary(accountId, 'primary-admin-chat', 'primary-admin');
    await messages.upsertConversationCatalog(accountId, [{ chatType: 'group', chatId: 'activation-room', title: 'Source room', members: [] },
      { chatType: 'group', chatId: 'direct-room', title: 'Direct room', members: [] },
      { chatType: 'group', chatId: 'pending-room', title: 'Pending room', members: [] }]);
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

  /** A fresh account with a bound Primary Admin and one group, so request rate limits and earlier activations never interfere. */
  async function isolated(title: string): Promise<{ account: string; chatId: string }> {
    const account = `isolated-${randomUUID()}`;
    const chatId = `isolated-room-${randomUUID()}`;
    await new AccountRepository(pool).ensureAccount(account);
    await new AdminRepository(pool).bindPrimary(account, 'primary-admin-chat', 'primary-admin');
    await messages.upsertConversationCatalog(account, [{ chatType: 'group', chatId, title, members: [] }]);
    return { account, chatId };
  }
  function localizedService(account: string, locale: Locale | string): RoomAutomationService {
    return new RoomAutomationService(rooms, { async get() { return autoSettings; }, async beginReplyEffect() { return 'created'; }, async finishReplyEffect() { return true; } },
      Buffer.alloc(32, 7), 1, { async isAgentAccount() { return true; }, async activeBinding() { return { ...binding, accountId: account }; },
        async isCurrentControl() { return true; }, async send(command) {
          sent.push(command); return { type: 'sendResult', requestId: command.requestId, accountId: account, workerInstanceId: binding.workerInstanceId,
            controlEpoch: binding.controlEpoch, status: 'sent', messageId: randomUUID(), error: null };
        } }, locale);
  }

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
    ['en', 'Room activation confirmation for group Source room.', 'Activation is waiting'],
    ['zh-TW', '聊天室啟用確認：群組 Source room。', '等待帳號主要管理員'],
    ['ja', 'ルーム有効化の確認：グループ Source room。', 'アカウントの主管理者'],
    ['ko', '룸 활성화 확인: 그룹 Source room.', '계정 기본 관리자의'],
    ['unsupported', 'Room activation confirmation for group Source room.', 'Activation is waiting'],
  ] as Array<[Locale | string, string, string]>)('localizes activation prompts in %s and preserves token and routing', async (locale, adminPrefix, waitingPrefix) => {
    const room = await isolated('Source room');
    const localized = localizedService(room.account, locale);
    await localized.handle({ type: 'request', accountId: room.account, chatType: 'group', chatId: room.chatId, senderId: 'member', messageId: 'localized-request' });
    const token = sent[0]!.text.match(/RA-[A-Za-z0-9_-]{43}/)?.[0];
    expect(token).toBeTruthy();
    expect(sent[0]).toMatchObject({ chatType: 'direct', chatId: 'primary-admin-chat' });
    expect(sent[0]!.text).toContain(adminPrefix);
    expect(sent[0]!.text).toContain(`@agent`);
    expect(sent[0]!.text).not.toContain('activation-room');
    expect(sent[0]!.text).toContain(token!);
    expect(sent[1]).toMatchObject({ chatType: 'group', chatId: room.chatId });
    expect(sent[1]!.text).toContain(waitingPrefix);
    for (const command of sent) expect(command.text).not.toContain(room.chatId);
  });

  it('enables the room directly for the Primary Admin: no token DM, one group confirmation, then the responder stays silent', async () => {
    await service.handle({ type: 'request', accountId, chatType: 'group', chatId: 'direct-room', senderId: 'primary-admin', messageId: 'direct-request' });
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ chatType: 'group', chatId: 'direct-room', text: 'Agent enabled' });
    expect(sent.some((command) => command.chatType === 'direct')).toBe(false);
    expect(await rooms.hasActiveRoomGrant({ accountId, chatType: 'group', chatId: 'direct-room' })).toBe(true);
    await service.handle({ type: 'request', accountId, chatType: 'group', chatId: 'direct-room', senderId: 'primary-admin', messageId: 'direct-request' });
    await service.handle({ type: 'request', accountId, chatType: 'group', chatId: 'direct-room', senderId: 'primary-admin', messageId: 'direct-request-2' });
    expect(sent).toHaveLength(1);
  });

  it('a Primary Admin request cancels a pending token request instead of leaving it live', async () => {
    await service.handle({ type: 'request', accountId, chatType: 'group', chatId: 'pending-room', senderId: 'member', messageId: 'pending-by-member' });
    expect(sent).toHaveLength(2);
    await service.handle({ type: 'request', accountId, chatType: 'group', chatId: 'pending-room', senderId: 'primary-admin', messageId: 'pending-by-admin' });
    expect(await rooms.hasActiveRoomGrant({ accountId, chatType: 'group', chatId: 'pending-room' })).toBe(true);
    expect(sent).toHaveLength(3);
  });

  it('names an untitled group with the placeholder and never shows its id in any locale', async () => {
    for (const [locale, placeholder] of [['en', 'Unnamed group'], ['zh-TW', '未命名群組'], ['ja', '名称未設定のグループ'], ['ko', '이름 없는 그룹']] as const) {
      sent.length = 0;
      const room = await isolated('');
      const localized = localizedService(room.account, locale);
      await localized.handle({ type: 'request', accountId: room.account, chatType: 'group', chatId: room.chatId, senderId: 'member', messageId: `untitled-request-${locale}` });
      expect(sent[0]!.text).toContain(placeholder);
      for (const command of sent) expect(command.text).not.toContain(room.chatId);
    }
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
