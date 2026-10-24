import { randomBytes } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import type { InboundEnvelope, LineWorkerCommand, LineWorkerEvent, WorkerBinding } from '@line-agent/contracts';
import type { AccountCapabilities } from '@line-agent/database';
import type { Locale } from '../../locale.js';
import { FriendEnrollmentService } from './friend-enrollment-service.js';
import { LineService } from './line-service.js';
import { linePrompt } from './line-prompts.js';

const binding: WorkerBinding & { mode: 'ACTIVE_CONTROL' } = {
  accountId: 'account-a', workerInstanceId: 'worker-a', controlEpoch: 3,
  transportOwnerId: 'owner-a', transportGeneration: 4, writeGrantVersion: 5, mode: 'ACTIVE_CONTROL',
};
const targetMid = 'u' + 'a'.repeat(32);
const ownMid = 'u' + 'b'.repeat(32);
const primary = { accountId: 'account-a', chatType: 'direct' as const, chatId: 'admin-chat', senderId: 'admin-mid' };
const contact = (overrides: Partial<InboundEnvelope> = {}): InboundEnvelope => ({
  eventId: 'event-1', ...primary, messageId: 'message-1', kind: 'contact', contact: { mid: targetMid, displayName: 'Target' },
  text: null, mentionIds: [], mentionRanges: [], replyToMessageId: null,
  ingestion: { source: 'live', cursor: null }, occurredAt: '2026-10-17T00:00:00.000Z', attachments: [], raw: {}, ...overrides,
});
const codeMessage = (code: string, overrides: Partial<InboundEnvelope> = {}) => contact({
  ...(code.startsWith('LW-') && overrides.chatId === undefined && overrides.chatType === undefined
    ? { chatId: targetMid, senderId: targetMid } : {}),
  kind: 'text', contact: undefined, text: '[REDACTED_VERIFICATION_CODE]', ...overrides,
});
const directCommand = (overrides: Partial<InboundEnvelope> = {}) => codeMessage('', {
  text: '/adduser', ...overrides,
});
const ownMention = (text: string, userId = ownMid, start = 0, end = 6) => ({
  text, mentionIds: [userId], mentionRanges: [{ start, end, userId }],
});
const groupCommand = (overrides: Partial<InboundEnvelope> = {}) => codeMessage('', {
  chatType: 'group', chatId: 'origin-room', ...ownMention('@Agent /adduser'), ...overrides,
});
const inlineGroupCommand = (command: string, overrides: Partial<InboundEnvelope> = {}) => codeMessage('', {
  chatType: 'group', chatId: 'origin-room', text: `@Agent ${command} @Target`, mentionIds: [ownMid, targetMid],
  mentionRanges: [{ start: 0, end: 6, userId: ownMid }, { start: 8 + command.length, end: 15 + command.length, userId: targetMid }], ...overrides,
});
const groupSelection = (overrides: Partial<InboundEnvelope> = {}) => codeMessage('', {
  chatType: 'group', chatId: 'origin-room', text: '@Agent @Target', mentionIds: [ownMid, targetMid],
  mentionRanges: [{ start: 0, end: 6, userId: ownMid }, { start: 7, end: 14, userId: targetMid }], ...overrides,
});
const groupCodeMessage = (code: string, overrides: Partial<InboundEnvelope> = {}) => codeMessage(code, {
  chatType: 'group', chatId: 'origin-room', ...ownMention(`@Agent ${code}`), ...overrides,
});
const event = <T extends LineWorkerEvent['type']>(type: T, fields: Record<string, unknown>) => ({
  type, ...binding, ...fields,
}) as Extract<LineWorkerEvent, { type: T }>;
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

function setup(locale: Locale | string = 'zh-TW') {
  let now = 1_000;
  let currentBinding: (WorkerBinding & { mode: 'ACTIVE_CONTROL' }) | null = binding;
  const adminCurrent = { value: true };
  const friendConfirmation = { userId: null as string | null, version: null as number | null };
  let adminVersion = 1;
  const controlCurrent = { activeAccountId: 'account-a', controlEpoch: 3 };
  let generatedCode = 'LW-ABCDEFG2';
  const admins = {
    getPrimaryAdministratorVersion: vi.fn(async () => adminVersion),
    hasPrimaryAdministratorFriendConfirmation: vi.fn(async (_accountId: string, userId: string, version: number) =>
      friendConfirmation.userId === userId && friendConfirmation.version === version),
    confirmPrimaryAdministratorFriendship: vi.fn(async (_accountId: string, userId: string, version: number) => {
      friendConfirmation.userId = userId; friendConfirmation.version = version; return true;
    }),
    isPrimaryAdministrator: vi.fn(async (accountId: string, chatId: string, senderId: string) =>
      adminCurrent.value && accountId === primary.accountId && chatId === primary.chatId && senderId === primary.senderId),
    isPrimaryUser: vi.fn(async (accountId: string, senderId: string) =>
      adminCurrent.value && accountId === primary.accountId && senderId === primary.senderId),
    getPrimaryAdministrator: vi.fn(async (accountId: string) => accountId === primary.accountId
      ? { chatId: primary.chatId, userId: primary.senderId } : null),
  };
  const whitelist = {
    activateForEnrollment: vi.fn(async (input: any) => input.scope.kind === 'ACCOUNT'
      ? whitelist.activate(input.accountId, input.targetMid, input.adminUserId)
      : whitelist.activate(input.accountId, input.targetMid, input.adminUserId, input.scope)),
    activate: vi.fn(async (_accountId: string, _mid: string, _actor: string, _scope?: unknown) => ({ grantId: 'grant', accountId: 'account-a',
      targetMid, capability: 'AGENT_USE' as const, scopeKind: 'ACCOUNT' as const, chatType: null, chatId: null,
      state: 'ACTIVE' as const, version: 1 })),
    getActiveAuthorization: vi.fn(async () => null),
  };
  const accounts = {
    getAccount: vi.fn(async () => ({ accountId: 'account-a', mode: 'ACTIVE_CONTROL' as const, ownMid: 'u' + 'b'.repeat(32), productRole: 'AGENT' as const })),
    getControlState: vi.fn(async () => ({ ...controlCurrent })),
    resolveCapabilities: vi.fn(async (): Promise<AccountCapabilities> => ({ accountId: 'account-a', productRole: 'PRIMARY_ADMIN',
      connectionMode: 'SYSTEM_LOGIN', roleRevision: 0, modeRevision: 0, selectedSourceId: null,
      selectedSourceGeneration: null, selectedSourceType: null, sourceState: null, canWriteLine: true })),
  };
  const workers = {
    binding: vi.fn(async () => currentBinding),
    isCurrentActiveControlBinding: vi.fn((candidate: WorkerBinding) => !!currentBinding
      && currentBinding.mode === 'ACTIVE_CONTROL' && candidate.accountId === currentBinding.accountId
      && candidate.workerInstanceId === currentBinding.workerInstanceId && candidate.controlEpoch === currentBinding.controlEpoch
      && candidate.transportOwnerId === currentBinding.transportOwnerId && candidate.transportGeneration === currentBinding.transportGeneration
      && candidate.writeGrantVersion === currentBinding.writeGrantVersion),
    waitModeAck: vi.fn(async () => true),
    send: vi.fn(async (command: LineWorkerCommand) => event('sendResult', {
      requestId: command.type === 'sendText' ? command.requestId : 'none', status: 'sent', messageId: 'sent', error: null,
    })),
    checkFriendRelation: vi.fn(async (command: Extract<LineWorkerCommand, { type: 'checkFriendRelation' }>) => event('friendRelationResult', {
      requestId: command.requestId, targetMid: command.targetMid, status: 'friend', error: null,
    })),
    addFriendByMid: vi.fn(async (command: Extract<LineWorkerCommand, { type: 'addFriendByMid' }>) => event('addFriendResult', {
      requestId: command.requestId, targetMid: command.targetMid, status: 'added', error: null,
    })),
  };
  const auditEvents: any[] = [];
  const audit = {
    request: vi.fn((_action: string, _fields: unknown) => '123e4567-e89b-42d3-a456-426614174000'),
    observed: vi.fn((action: string, fields: unknown) => auditEvents.push({ action, phase: 'observed', ...fields as object })),
    complete: vi.fn((correlationId: string, phase: string, fields: unknown) => auditEvents.push({ action: 'friend_enrollment', correlationId, phase, ...fields as object })),
  };
  const service = new FriendEnrollmentService({ admins, whitelist, accounts, workers,
    audit: audit as never,
    now: () => now, digestKey: randomBytes(32), makeCode: () => generatedCode, locale });
  return { service, admins, whitelist, accounts, workers, adminCurrent, controlCurrent, friendConfirmation,
    setAdminVersion(value: number) { adminVersion = value; },
    audit, auditEvents,
    setNow(value: number) { now = value; }, setBinding(value: typeof currentBinding) { currentBinding = value; },
    setCode(value: string) { generatedCode = value; } };
}

async function startDirect(ctx: ReturnType<typeof setup>, overrides: Partial<InboundEnvelope> = {}) {
  const identity = { accountId: overrides.accountId ?? primary.accountId,
    chatId: overrides.chatId ?? primary.chatId, senderId: overrides.senderId ?? primary.senderId };
  await ctx.service.handle(directCommand(identity), null, ownMid);
  await ctx.service.handle(contact({ ...identity, ...overrides }), null, ownMid);
}

describe('FriendEnrollmentService', () => {
  it('checks and adds the primary administrator once per active binding', async () => {
    const ctx = setup();
    ctx.admins.getPrimaryAdministrator.mockResolvedValue({ chatId: 'admin-chat', userId: targetMid });
    ctx.workers.checkFriendRelation.mockImplementationOnce(async (command) => event('friendRelationResult', {
      requestId: command.requestId, targetMid: command.targetMid, status: 'not_friend', error: null,
    }));
    const controller = new AbortController();
    await ctx.service.ensurePrimaryAdministratorFriendship(binding, controller.signal);
    await ctx.service.ensurePrimaryAdministratorFriendship(binding, controller.signal);
    expect(ctx.workers.checkFriendRelation).toHaveBeenCalledTimes(1);
    expect(ctx.workers.addFriendByMid).toHaveBeenCalledTimes(1);
    expect(ctx.workers.addFriendByMid).toHaveBeenCalledWith(expect.objectContaining({ targetMid }));
    expect(ctx.admins.confirmPrimaryAdministratorFriendship).toHaveBeenCalledWith('account-a', targetMid, 1);
  });

  it('persists a friend result and skips relation and add RPCs on a later ready start', async () => {
    const ctx = setup();
    ctx.admins.getPrimaryAdministrator.mockResolvedValue({ chatId: 'admin-chat', userId: targetMid });
    const controller = new AbortController();
    await ctx.service.ensurePrimaryAdministratorFriendship(binding, controller.signal);
    expect(ctx.friendConfirmation).toEqual({ userId: targetMid, version: 1 });
    const restartedService = new FriendEnrollmentService({ admins: ctx.admins, whitelist: ctx.whitelist, accounts: ctx.accounts,
      workers: ctx.workers, digestKey: randomBytes(32) });
    await restartedService.ensurePrimaryAdministratorFriendship(binding, controller.signal);
    expect(ctx.workers.checkFriendRelation).toHaveBeenCalledTimes(1);
    expect(ctx.workers.addFriendByMid).not.toHaveBeenCalled();
  });

  it('checks again when the administrator version changes', async () => {
    const ctx = setup();
    ctx.admins.getPrimaryAdministrator.mockResolvedValue({ chatId: 'admin-chat', userId: targetMid });
    ctx.admins.getPrimaryAdministrator.mockResolvedValue({ chatId: 'admin-chat', userId: targetMid });
    const controller = new AbortController();
    await ctx.service.ensurePrimaryAdministratorFriendship(binding, controller.signal);
    ctx.setAdminVersion(2);
    await ctx.service.ensurePrimaryAdministratorFriendship(binding, controller.signal);
    expect(ctx.workers.checkFriendRelation).toHaveBeenCalledTimes(2);
    expect(ctx.admins.confirmPrimaryAdministratorFriendship).toHaveBeenCalledTimes(2);
  });

  it('retries the once-per-binding check after a primary administrator binds to an already-ready worker', async () => {
    const ctx = setup();
    ctx.admins.getPrimaryAdministrator.mockResolvedValue(null);
    const controller = new AbortController();
    await ctx.service.ensurePrimaryAdministratorFriendship(binding, controller.signal);
    expect(ctx.workers.checkFriendRelation).not.toHaveBeenCalled();
    ctx.admins.getPrimaryAdministrator.mockResolvedValue({ chatId: 'admin-chat', userId: targetMid });
    ctx.workers.checkFriendRelation.mockImplementationOnce(async (command) => event('friendRelationResult', {
      requestId: command.requestId, targetMid: command.targetMid, status: 'not_friend', error: null,
    }));
    await ctx.service.ensurePrimaryAdministratorFriendship(binding, controller.signal);
    await ctx.service.ensurePrimaryAdministratorFriendship(binding, controller.signal);
    expect(ctx.workers.checkFriendRelation).toHaveBeenCalledTimes(1);
    expect(ctx.workers.addFriendByMid).toHaveBeenCalledTimes(1);
  });

  it('admits one relation check when a successful pairing overlaps a no-admin check', async () => {
    const ctx = setup();
    const heldAdmin = deferred<{ chatId: string; userId: string } | null>();
    ctx.admins.getPrimaryAdministrator.mockImplementationOnce(() => heldAdmin.promise);
    const noAdminJob = ctx.service.ensurePrimaryAdministratorFriendship(binding, new AbortController().signal);
    await vi.waitFor(() => expect(ctx.admins.getPrimaryAdministrator).toHaveBeenCalledTimes(1));
    ctx.admins.getPrimaryAdministrator.mockResolvedValue({ chatId: 'admin-chat', userId: targetMid });
    const pairedJob = ctx.service.ensurePrimaryAdministratorFriendship(binding, new AbortController().signal, 'admin-bound');
    heldAdmin.resolve(null);
    await Promise.all([noAdminJob, pairedJob]);
    expect(ctx.workers.checkFriendRelation).toHaveBeenCalledTimes(1);
    expect(ctx.workers.checkFriendRelation).toHaveBeenCalledWith(expect.objectContaining({ accountId: binding.accountId, targetMid }));
  });

  it('does not add a relation result released after its lifecycle signal is aborted', async () => {
    const ctx = setup();
    ctx.admins.getPrimaryAdministrator.mockResolvedValue({ chatId: 'admin-chat', userId: targetMid });
    const heldRelation = deferred<Extract<LineWorkerEvent, { type: 'friendRelationResult' }>>();
    ctx.workers.checkFriendRelation.mockImplementationOnce(() => heldRelation.promise);
    const controller = new AbortController();
    const job = ctx.service.ensurePrimaryAdministratorFriendship(binding, controller.signal);
    await vi.waitFor(() => expect(ctx.workers.checkFriendRelation).toHaveBeenCalledTimes(1));
    controller.abort();
    const command = ctx.workers.checkFriendRelation.mock.calls[0]![0];
    heldRelation.resolve(event('friendRelationResult', { requestId: command.requestId, targetMid, status: 'not_friend', error: null }));
    await job;
    expect(ctx.workers.addFriendByMid).not.toHaveBeenCalled();
    expect(ctx.admins.confirmPrimaryAdministratorFriendship).not.toHaveBeenCalled();
  });

  it.each(['removed', 'replaced'] as const)('does not add the captured primary after it is %s during relation lookup', async (change) => {
    const ctx = setup();
    let version = 1;
    ctx.admins.getPrimaryAdministratorVersion.mockImplementation(async () => version);
    ctx.admins.getPrimaryAdministrator.mockResolvedValue({ chatId: 'admin-chat', userId: targetMid });
    const held = deferred<Extract<LineWorkerEvent, { type: 'friendRelationResult' }>>();
    ctx.workers.checkFriendRelation.mockImplementationOnce(() => held.promise);
    const job = ctx.service.ensurePrimaryAdministratorFriendship(binding, new AbortController().signal);
    await vi.waitFor(() => expect(ctx.workers.checkFriendRelation).toHaveBeenCalledTimes(1));
    if (change === 'removed') ctx.admins.getPrimaryAdministrator.mockResolvedValue(null);
    else ctx.admins.getPrimaryAdministrator.mockResolvedValue({ chatId: 'replacement-chat', userId: ownMid });
    version++;
    const command = ctx.workers.checkFriendRelation.mock.calls[0]![0];
    held.resolve(event('friendRelationResult', { requestId: command.requestId, targetMid, status: 'not_friend', error: null }));
    await job;
    expect(ctx.workers.addFriendByMid).not.toHaveBeenCalled();
    expect(ctx.admins.confirmPrimaryAdministratorFriendship).not.toHaveBeenCalled();
  });

  it('fails closed for unknown relation and does not retry on the same binding', async () => {
    const ctx = setup();
    ctx.admins.getPrimaryAdministrator.mockResolvedValue({ chatId: 'admin-chat', userId: targetMid });
    ctx.workers.checkFriendRelation.mockImplementation(async (command) => event('friendRelationResult', {
      requestId: command.requestId, targetMid: command.targetMid, status: 'unknown', error: 'RELATION_OUTCOME_UNKNOWN',
    }));
    await expect(ctx.service.ensurePrimaryAdministratorFriendship(binding, new AbortController().signal)).rejects.toThrow();
    expect(ctx.workers.addFriendByMid).not.toHaveBeenCalled();
    expect(ctx.admins.confirmPrimaryAdministratorFriendship).not.toHaveBeenCalled();
    await expect(ctx.service.ensurePrimaryAdministratorFriendship(binding, new AbortController().signal)).rejects.toThrow();
    expect(ctx.workers.checkFriendRelation).toHaveBeenCalledTimes(1);
  });

  it('reports a failed primary administrator add and never repeats it on the same binding', async () => {
    const ctx = setup();
    ctx.admins.getPrimaryAdministrator.mockResolvedValue({ chatId: 'admin-chat', userId: targetMid });
    ctx.workers.checkFriendRelation.mockImplementationOnce(async (command) => event('friendRelationResult', {
      requestId: command.requestId, targetMid: command.targetMid, status: 'not_friend', error: null,
    }));
    ctx.workers.addFriendByMid.mockImplementationOnce(async (command) => event('addFriendResult', {
      requestId: command.requestId, targetMid: command.targetMid, status: 'unknown', error: 'TRANSPORT_OUTCOME_UNKNOWN',
    }));
    await expect(ctx.service.ensurePrimaryAdministratorFriendship(binding, new AbortController().signal)).rejects.toThrow();
    await expect(ctx.service.ensurePrimaryAdministratorFriendship(binding, new AbortController().signal)).rejects.toThrow();
    expect(ctx.workers.addFriendByMid).toHaveBeenCalledTimes(1);
    expect(ctx.admins.confirmPrimaryAdministratorFriendship).not.toHaveBeenCalled();
  });

  it('does not continue a cancelled binding job and allows a restarted binding to check once', async () => {
    const ctx = setup();
    ctx.admins.getPrimaryAdministrator.mockResolvedValue({ chatId: 'admin-chat', userId: targetMid });
    const held = deferred<Extract<LineWorkerEvent, { type: 'friendRelationResult' }>>();
    ctx.workers.checkFriendRelation.mockImplementationOnce(() => held.promise);
    const controller = new AbortController();
    const oldJob = ctx.service.ensurePrimaryAdministratorFriendship(binding, controller.signal);
    await vi.waitFor(() => expect(ctx.workers.checkFriendRelation).toHaveBeenCalledTimes(1));
    controller.abort();
    ctx.setBinding(null);
    held.resolve(event('friendRelationResult', { requestId: ctx.workers.checkFriendRelation.mock.calls[0]![0].requestId,
      targetMid, status: 'not_friend', error: null }));
    await expect(oldJob).resolves.toBeUndefined();
    expect(ctx.workers.addFriendByMid).not.toHaveBeenCalled();
    const restarted = { ...binding, workerInstanceId: 'worker-restarted', transportGeneration: 5 };
    ctx.workers.checkFriendRelation.mockImplementationOnce(async (command) => ({ ...event('friendRelationResult', {
      requestId: command.requestId, targetMid: command.targetMid, status: 'friend', error: null,
    }), workerInstanceId: restarted.workerInstanceId, transportGeneration: restarted.transportGeneration }));
    ctx.setBinding(restarted);
    await ctx.service.ensurePrimaryAdministratorFriendship(restarted, new AbortController().signal);
    expect(ctx.workers.checkFriendRelation).toHaveBeenCalledTimes(2);
  });

  it('does not add an already-friend primary administrator', async () => {
    const ctx = setup();
    ctx.admins.getPrimaryAdministrator.mockResolvedValue({ chatId: 'admin-chat', userId: targetMid });
    await ctx.service.ensurePrimaryAdministratorFriendship(binding, new AbortController().signal);
    expect(ctx.workers.addFriendByMid).not.toHaveBeenCalled();
  });

  it('does not check primary administrator friendship from inbound message handling or classification', async () => {
    const ctx = setup();
    await ctx.service.classify(directCommand(), null, ownMid);
    await ctx.service.handle(codeMessage('ordinary message'), null, ownMid);
    expect(ctx.workers.checkFriendRelation).not.toHaveBeenCalled();
    expect(ctx.workers.addFriendByMid).not.toHaveBeenCalled();
  });

  it('localizes enrollment prompts while keeping the existing primary-admin and account authorization boundary', async () => {
    const expected: Array<[Locale, string, string]> = [
      ['en', 'Share the LINE contact', 'LINE friend verified and added to the allowlist.'],
      ['zh-TW', '請分享要新增的 LINE 聯絡人。', 'LINE 好友已確認，並已加入白名單。'],
      ['ja', '追加するLINE連絡先', 'LINEの友だちを確認し、許可リストに追加しました。'],
      ['ko', '추가할 LINE 연락처', 'LINE 친구를 확인하고 허용 목록에 추가했습니다.'],
    ];
    for (const [locale, firstPrompt, successReply] of expected) {
      const ctx = setup(locale);
      await startDirect(ctx);
      const initial = ctx.workers.send.mock.calls[0]?.[0];
      expect(initial?.type === 'sendText' ? initial.text : '').toContain(firstPrompt);
      await ctx.service.handle(codeMessage('LW-ABCDEFG2'), { code: 'LW-ABCDEFG2', exact: true });
      const reply = ctx.workers.send.mock.calls.at(-1)?.[0];
      expect(reply?.type === 'sendText' ? reply.text : '').toBe(successReply);
      expect(ctx.whitelist.activateForEnrollment).toHaveBeenCalledWith(expect.objectContaining({
        accountId: 'account-a', targetMid, scope: { kind: 'ACCOUNT' }, adminUserId: 'admin-mid', adminChatId: 'admin-chat',
      }));
    }

    const denied = setup('ja');
    denied.adminCurrent.value = false;
    await denied.service.handle(directCommand(), null, ownMid);
    expect(denied.workers.send).not.toHaveBeenCalled();
    expect(denied.whitelist.activateForEnrollment).not.toHaveBeenCalled();
  });

  it('audits the bounded confirmation stages and keeps a committed grant successful when its reply fails', async () => {
    const ctx = setup();
    await startDirect(ctx);
    ctx.workers.send.mockImplementationOnce(async (command) => event('sendResult', {
      requestId: command.type === 'sendText' ? command.requestId : 'none', status: 'failed', messageId: null, error: 'TRANSPORT_OUTCOME_UNKNOWN',
    }));
    await ctx.service.handle(codeMessage('LW-ABCDEFG2'), { code: 'LW-ABCDEFG2', exact: true });
    expect(ctx.whitelist.activateForEnrollment).toHaveBeenCalledTimes(1);
    expect(ctx.audit.request).toHaveBeenCalledWith('friend_enrollment', expect.objectContaining({ initiator: 'user', reasonCode: 'operator_action' }));
    expect(ctx.auditEvents).toHaveLength(4);
    expect(ctx.auditEvents.length + 1).toBeLessThanOrEqual(7);
    expect(new Set(ctx.auditEvents.map((entry) => entry.correlationId)).size).toBe(1);
    expect(ctx.auditEvents.at(-1)).toMatchObject({ phase: 'succeeded', resultCode: 'authorization_active_reply_failed', errorCode: 'ENROLLMENT_REPLY_FAILED' });
    expect(JSON.stringify(ctx.auditEvents)).not.toContain(targetMid);
  });

  it('records a relation timeout as a fixed failure without adding or granting', async () => {
    const ctx = setup();
    await startDirect(ctx);
    ctx.workers.checkFriendRelation.mockImplementationOnce(async (command) => event('friendRelationResult', {
      requestId: command.requestId, targetMid, status: 'unknown', error: 'RELATION_RESPONSE_TIMEOUT',
    }));
    await ctx.service.handle(codeMessage('LW-ABCDEFG2'), { code: 'LW-ABCDEFG2', exact: true });
    expect(ctx.workers.addFriendByMid).not.toHaveBeenCalled();
    expect(ctx.whitelist.activateForEnrollment).not.toHaveBeenCalled();
    expect(ctx.auditEvents).toHaveLength(2);
    expect(ctx.auditEvents[0]).toMatchObject({ action: 'friend_relation_initial', errorCode: 'RELATION_RESPONSE_TIMEOUT' });
    expect(ctx.auditEvents[1]).toMatchObject({ phase: 'failed', errorCode: 'RELATION_RESPONSE_TIMEOUT' });
  });

  it('keeps a positive recheck that still says not_friend as a relation result, not a binding error', async () => {
    const ctx = setup();
    await startDirect(ctx);
    ctx.workers.checkFriendRelation.mockImplementationOnce(async (command) => event('friendRelationResult', {
      requestId: command.requestId, targetMid, status: 'not_friend', error: null,
    })).mockImplementationOnce(async (command) => event('friendRelationResult', {
      requestId: command.requestId, targetMid, status: 'not_friend', error: null,
    }));
    await ctx.service.handle(codeMessage('LW-ABCDEFG2'), { code: 'LW-ABCDEFG2', exact: true });
    expect(ctx.auditEvents.find((item) => item.action === 'friend_relation_recheck')).toMatchObject({ resultCode: 'relation_not_friend' });
    expect(ctx.auditEvents.at(-1)).toMatchObject({ phase: 'failed', resultCode: 'authorization_denied' });
    expect(ctx.auditEvents.at(-1)).not.toHaveProperty('errorCode', 'ENROLLMENT_BINDING_CHANGED');
    expect(ctx.whitelist.activateForEnrollment).not.toHaveBeenCalled();
  });

  it('bounds a complete add and recheck audit to seven events and keeps identifiers private', async () => {
    const ctx = setup();
    await startDirect(ctx);
    ctx.workers.checkFriendRelation.mockImplementationOnce(async (command) => event('friendRelationResult', {
      requestId: command.requestId, targetMid, status: 'not_friend', error: null,
    })).mockImplementationOnce(async (command) => event('friendRelationResult', {
      requestId: command.requestId, targetMid, status: 'friend', error: null,
    }));
    await ctx.service.handle(codeMessage('LW-ABCDEFG2'), { code: 'LW-ABCDEFG2', exact: true });
    expect(ctx.auditEvents.length).toBeLessThanOrEqual(7);
    expect(ctx.auditEvents.length).toBe(6);
    expect(ctx.auditEvents.at(-1)).toMatchObject({ phase: 'succeeded', resultCode: 'authorization_active_reply_sent' });
    expect(JSON.stringify(ctx.auditEvents)).not.toContain(targetMid);
  });

  it('terminates with a sanitized precheck failure when a post-relation binding guard throws', async () => {
    const ctx = setup();
    await startDirect(ctx);
    let relationAccepted = false;
    let postRelationControlReads = 0;
    ctx.workers.checkFriendRelation.mockImplementationOnce(async (command) => {
      relationAccepted = true;
      return event('friendRelationResult', { requestId: command.requestId, targetMid, status: 'friend', error: null });
    });
    ctx.accounts.getControlState.mockImplementation(async () => {
      if (relationAccepted && ++postRelationControlReads === 2) throw new Error('private guard database detail');
      return { ...ctx.controlCurrent };
    });
    await expect(ctx.service.handle(codeMessage('LW-ABCDEFG2'), { code: 'LW-ABCDEFG2', exact: true })).resolves.toBe(true);
    expect(ctx.whitelist.activateForEnrollment).not.toHaveBeenCalled();
    const terminal = ctx.auditEvents.filter((item) => item.action === 'friend_enrollment' && item.phase === 'failed');
    expect(terminal).toHaveLength(1);
    expect(terminal[0]).toMatchObject({ errorCode: 'ENROLLMENT_PRECHECK_FAILED' });
    expect(terminal[0]).not.toHaveProperty('error', expect.anything());
    expect(terminal[0].correlationId).toBe(ctx.auditEvents[0].correlationId);
    expect(ctx.auditEvents.length).toBeLessThanOrEqual(7);
    expect(JSON.stringify(ctx.auditEvents)).not.toContain('private guard database detail');
  });

  it('reports a mismatched recheck binding as the terminal failure cause', async () => {
    const ctx = setup();
    await startDirect(ctx);
    ctx.workers.checkFriendRelation.mockImplementationOnce(async (command) => event('friendRelationResult', {
      requestId: command.requestId, targetMid, status: 'not_friend', error: null,
    })).mockImplementationOnce(async (command) => ({ ...event('friendRelationResult', {
      requestId: command.requestId, targetMid, status: 'friend', error: null,
    }), workerInstanceId: 'stale-worker' }));
    await ctx.service.handle(codeMessage('LW-ABCDEFG2'), { code: 'LW-ABCDEFG2', exact: true });
    expect(ctx.auditEvents.at(-1)).toMatchObject({ phase: 'failed', errorCode: 'ENROLLMENT_BINDING_CHANGED' });
    expect(ctx.whitelist.activateForEnrollment).not.toHaveBeenCalled();
  });

  it('classifies a stale add result as a binding change instead of an add transport failure', async () => {
    const ctx = setup();
    await startDirect(ctx);
    ctx.workers.checkFriendRelation.mockImplementationOnce(async (command) => event('friendRelationResult', {
      requestId: command.requestId, targetMid, status: 'not_friend', error: null,
    }));
    ctx.workers.addFriendByMid.mockImplementationOnce(async (command) => ({ ...event('addFriendResult', {
      requestId: command.requestId, targetMid, status: 'added', error: null,
    }), transportGeneration: 900 }));
    await ctx.service.handle(codeMessage('LW-ABCDEFG2'), { code: 'LW-ABCDEFG2', exact: true });
    expect(ctx.auditEvents.find((item) => item.action === 'friend_add_attempt')).toMatchObject({ errorCode: 'ENROLLMENT_BINDING_CHANGED' });
    expect(ctx.auditEvents.at(-1)).toMatchObject({ phase: 'failed', errorCode: 'ENROLLMENT_BINDING_CHANGED' });
    expect(ctx.whitelist.activateForEnrollment).not.toHaveBeenCalled();
  });

  it.each(['unknown', 'throw'] as const)('retains an active grant when the success reply is %s', async (outcome) => {
    const ctx = setup();
    await startDirect(ctx);
    ctx.workers.send.mockImplementation(async (command) => {
      if (command.type !== 'sendText') return event('sendResult', { requestId: 'none', status: 'sent', messageId: 'sent', error: null });
      if (outcome === 'throw') throw new Error('private send failure');
      return event('sendResult', { requestId: command.requestId, status: 'unknown', messageId: null, error: null });
    });
    await ctx.service.handle(codeMessage('LW-ABCDEFG2'), { code: 'LW-ABCDEFG2', exact: true });
    expect(ctx.whitelist.activateForEnrollment).toHaveBeenCalledTimes(1);
    expect(ctx.auditEvents.at(-1)).toMatchObject({ phase: 'succeeded', resultCode: 'authorization_active_reply_unknown', errorCode: 'ENROLLMENT_REPLY_UNKNOWN' });
    expect(ctx.auditEvents.filter((item) => item.phase === 'failed')).toHaveLength(0);
  });

  it('does not turn a reply preflight exception after commit into a grant failure', async () => {
    const ctx = setup();
    await startDirect(ctx);
    let committed = false;
    ctx.accounts.resolveCapabilities.mockImplementation(async () => {
      if (committed) throw new Error('private preflight failure');
      return { accountId: 'account-a', productRole: 'PRIMARY_ADMIN', connectionMode: 'SYSTEM_LOGIN', roleRevision: 0,
        modeRevision: 0, selectedSourceId: null, selectedSourceGeneration: null, selectedSourceType: null, sourceState: null, canWriteLine: true };
    });
    const activate = ctx.whitelist.activateForEnrollment.getMockImplementation()!;
    ctx.whitelist.activateForEnrollment.mockImplementation(async (input) => {
      const result = await activate(input);
      committed = true;
      return result;
    });
    await ctx.service.handle(codeMessage('LW-ABCDEFG2'), { code: 'LW-ABCDEFG2', exact: true });
    expect(ctx.whitelist.activateForEnrollment).toHaveBeenCalledTimes(1);
    expect(ctx.auditEvents.at(-1)).toMatchObject({ phase: 'succeeded', resultCode: 'authorization_active_reply_unknown', errorCode: 'ENROLLMENT_REPLY_UNKNOWN' });
    expect(ctx.auditEvents.filter((item) => item.phase === 'failed')).toHaveLength(0);
  });

  it('keeps grant authority independent from operational audit sink failures', async () => {
    const ctx = setup();
    await startDirect(ctx);
    ctx.audit.request.mockImplementationOnce(() => { throw new Error('private sink error'); });
    ctx.audit.observed.mockImplementation(() => { throw new Error('private sink error'); });
    ctx.audit.complete.mockImplementation(() => { throw new Error('private sink error'); });
    await ctx.service.handle(codeMessage('LW-ABCDEFG2'), { code: 'LW-ABCDEFG2', exact: true });
    expect(ctx.whitelist.activateForEnrollment).toHaveBeenCalledTimes(1);
    expect(ctx.workers.addFriendByMid).not.toHaveBeenCalled();
  });

  it('issues one code for replayed admission and processes same-batch command selection confirmation in order', async () => {
    const ctx = setup();
    const admitted = new Set<string>();
    const line = new LineService({ ...ctx.accounts, async bindWorker() {} } as never,
      { async listPendingRouteActions() { return []; }, async applyPendingRouteAction() {},
        async ingestBatchAndRoute(input: { envelopes: InboundEnvelope[] }, decisions: { eligible: boolean }[]) {
          expect(decisions.every((decision) => !decision.eligible)).toBe(true);
          return { insertedMessageIds: input.envelopes.flatMap((e) => {
            if (admitted.has(e.messageId)) return []; admitted.add(e.messageId); return [e.messageId];
          }), jobMessageIds: [] };
        } } as never,
      { async getConversationAgent() { return null; } } as never, { async send() {} },
      { kick() { throw new Error('enrollment must not route'); }, async stopChat() {}, async resetChat() {} },
      undefined, undefined, (e, candidate, own, captured) => ctx.service.handle(e, candidate, own, captured), ctx.admins as never,
      undefined, undefined, undefined, (e, candidate, own) => ctx.service.classify(e, candidate, own));
    await line.bind(binding);
    const command = groupCommand({ messageId: 'command' });
    const selection = groupSelection({ messageId: 'selection' });
    const confirmation = groupCodeMessage('LW-ABCDEFG2', { messageId: 'confirmation' });
    const input = { type: 'batch' as const, ...binding, batchId: 'batch',
      cursorBefore: { version: 1 as const, revision: '0', globalRev: '0', individualRev: '0' },
      cursorAfter: { version: 1 as const, revision: '1', globalRev: '0', individualRev: '0' },
      envelopes: [command, command, selection, selection, confirmation] };
    await line.handleWorkerEvent(binding.workerInstanceId, input);
    await line.handleWorkerEvent(binding.workerInstanceId, input);
    expect(ctx.workers.send.mock.calls.filter(([c]) => c.type === 'sendText' && c.text.includes('LW-ABCDEFG2'))).toHaveLength(1);
    expect(ctx.workers.checkFriendRelation).not.toHaveBeenCalled();
    expect(ctx.workers.addFriendByMid).not.toHaveBeenCalled();
    expect(ctx.whitelist.activateForEnrollment).toHaveBeenCalledTimes(1);
    expect(ctx.whitelist.activateForEnrollment).toHaveBeenCalledWith(expect.objectContaining({ scope: { kind: 'CHAT', chatType: 'group', chatId: 'origin-room' } }));
  });
  it('does not reacquire a replacement binding for a stale admitted command', async () => {
    const ctx = setup();
    ctx.setBinding({ ...binding, workerInstanceId: 'replacement' });
    await ctx.service.handle(inlineGroupCommand('/adduser'), null, ownMid, binding);
    expect(ctx.workers.send).not.toHaveBeenCalled();
  });

  it('cancels a challenge when administrator version changes even with the same MID', async () => {
    const ctx = setup();
    await startDirect(ctx);
    ctx.admins.getPrimaryAdministratorVersion.mockResolvedValue(2);
    await ctx.service.handle(codeMessage('LW-ABCDEFG2'), { code: 'LW-ABCDEFG2', exact: true }, ownMid);
    expect(ctx.workers.checkFriendRelation).not.toHaveBeenCalled();
    expect(ctx.whitelist.activateForEnrollment).not.toHaveBeenCalled();
  });

  it('cancels before native operations when selected source changes without a control epoch change', async () => {
    const ctx = setup();
    await startDirect(ctx);
    const capabilities = await ctx.accounts.resolveCapabilities();
    ctx.accounts.resolveCapabilities.mockResolvedValue({ ...capabilities, selectedSourceId: 'replacement', selectedSourceGeneration: 2 });
    await ctx.service.handle(codeMessage('LW-ABCDEFG2'), { code: 'LW-ABCDEFG2', exact: true }, ownMid);
    expect(ctx.workers.checkFriendRelation).not.toHaveBeenCalled();
    expect(ctx.whitelist.activateForEnrollment).not.toHaveBeenCalled();
  });

  it('reserves exact target selection without a current flow but routes ordinary mention prompts', async () => {
    const ctx = setup();
    expect(await ctx.service.classify(groupSelection(), null, ownMid)).toBe(true);
    expect(await ctx.service.classify(groupSelection({ text: '@Agent @Target summarize' }), null, ownMid)).toBe(false);
    expect(ctx.workers.send).not.toHaveBeenCalled();
  });
  it('does not start enrollment from a direct contact without an explicit adduser command', async () => {
    const ctx = setup();
    expect(await ctx.service.handle(contact(), null, ownMid)).toBe(true);
    expect(ctx.workers.send).not.toHaveBeenCalled();
  });

  it('rejects adduser and an already-started enrollment after EXTERNAL_MONITOR is selected', async () => {
    const ctx = setup();
    await ctx.service.handle(directCommand(), null, ownMid);
    expect(ctx.workers.send).toHaveBeenCalledTimes(1);
    ctx.accounts.resolveCapabilities.mockResolvedValue({ accountId: 'account-a', productRole: 'PRIMARY_ADMIN',
      connectionMode: 'EXTERNAL_MONITOR', roleRevision: 0, modeRevision: 1, selectedSourceId: 'external-source',
      selectedSourceGeneration: 1, selectedSourceType: 'EXTERNAL_MONITOR', sourceState: 'ACTIVE', canWriteLine: false });

    await expect(ctx.service.handle(directCommand({ messageId: 'external-adduser' }), null, ownMid)).resolves.toBe(false);
    await expect(ctx.service.handle(contact({ messageId: 'external-contact' }), null, ownMid)).resolves.toBe(false);
    await expect(ctx.service.handle(codeMessage('LW-ABCDEFG2', { messageId: 'external-code' }),
      { code: 'LW-ABCDEFG2', exact: true }, ownMid)).resolves.toBe(false);

    expect(ctx.workers.send).toHaveBeenCalledTimes(1);
    expect(ctx.workers.checkFriendRelation).not.toHaveBeenCalled();
    expect(ctx.workers.addFriendByMid).not.toHaveBeenCalled();
    expect(ctx.whitelist.activate).not.toHaveBeenCalled();
  });

  it('does not continue an in-flight friend verification into addFriend or grant mutation after source switch', async () => {
    const ctx = setup();
    let entered!: () => void;
    let resolveRelation!: (value: Extract<LineWorkerEvent, { type: 'friendRelationResult' }>) => void;
    const relationStarted = new Promise<void>((resolve) => { entered = resolve; });
    const relationResult = new Promise<Extract<LineWorkerEvent, { type: 'friendRelationResult' }>>((resolve) => { resolveRelation = resolve; });
    ctx.workers.checkFriendRelation.mockImplementationOnce(async (command) => {
      entered();
      return relationResult;
    });
    await startDirect(ctx);
    const consume = ctx.service.handle(codeMessage('LW-ABCDEFG2'), { code: 'LW-ABCDEFG2', exact: true }, ownMid);
    await relationStarted;
    ctx.accounts.resolveCapabilities.mockResolvedValue({ accountId: 'account-a', productRole: 'PRIMARY_ADMIN',
      connectionMode: 'EXTERNAL_MONITOR', roleRevision: 0, modeRevision: 1, selectedSourceId: 'external-source',
      selectedSourceGeneration: 1, selectedSourceType: 'EXTERNAL_MONITOR', sourceState: 'ACTIVE', canWriteLine: false });
    const request = ctx.workers.checkFriendRelation.mock.calls[0]![0];
    resolveRelation(event('friendRelationResult', { requestId: request.requestId, targetMid, status: 'not_friend', error: null }));
    await consume;

    expect(ctx.workers.addFriendByMid).not.toHaveBeenCalled();
    expect(ctx.whitelist.activate).not.toHaveBeenCalled();
  });

  it('does not send a post-activation response when external selection wins the grant transaction race', async () => {
    const ctx = setup();
    const activation = deferred<Awaited<ReturnType<typeof ctx.whitelist.activate>>>();
    let activationStarted!: () => void;
    const started = new Promise<void>((resolve) => { activationStarted = resolve; });
    ctx.whitelist.activate.mockImplementationOnce(async () => {
      activationStarted();
      return activation.promise;
    });
    await startDirect(ctx);
    const consume = ctx.service.handle(codeMessage('LW-ABCDEFG2'), { code: 'LW-ABCDEFG2', exact: true }, ownMid);
    await started;
    const sendCountBeforeSourceSwitch = ctx.workers.send.mock.calls.length;
    ctx.accounts.resolveCapabilities.mockResolvedValue({ accountId: 'account-a', productRole: 'PRIMARY_ADMIN',
      connectionMode: 'EXTERNAL_MONITOR', roleRevision: 0, modeRevision: 1, selectedSourceId: 'external-source',
      selectedSourceGeneration: 1, selectedSourceType: 'EXTERNAL_MONITOR', sourceState: 'ACTIVE', canWriteLine: false });
    activation.reject(new Error('EXTERNAL_MONITOR_READ_ONLY'));
    await consume;

    expect(ctx.workers.send).toHaveBeenCalledTimes(sendCountBeforeSourceSwitch);
    expect(ctx.workers.addFriendByMid).not.toHaveBeenCalled();
    expect(ctx.workers.checkFriendRelation).toHaveBeenCalledTimes(1);
  });

  it('accepts the exact Chinese command but not a command with extra text', async () => {
    const ctx = setup();
    await ctx.service.handle(directCommand({ text: '/adduser please' }), null, ownMid);
    expect(ctx.workers.send).not.toHaveBeenCalled();
    await ctx.service.handle(directCommand({ text: '/ADDUSER' }), null, ownMid);
    expect(ctx.workers.send).toHaveBeenCalledTimes(1);
    await ctx.service.handle(directCommand({ messageId: 'mixed-case', text: '/AdDuSeR' }), null, ownMid);
    expect(ctx.workers.send).toHaveBeenCalledTimes(2);
    await ctx.service.handle(directCommand({ text: '/新增使用者' }), null, ownMid);
    expect(ctx.workers.send).toHaveBeenCalledTimes(3);
  });

  it('requires the primary admin command and accepts direct proof only from the selected target chat', async () => {
    const ctx = setup();
    await ctx.service.handle(directCommand(), null, ownMid);
    expect(ctx.workers.send).toHaveBeenCalledWith(expect.objectContaining({ chatType: 'direct', chatId: 'admin-chat',
      text: expect.stringContaining('請分享') }));
    await ctx.service.handle(contact(), null, ownMid);
    expect(ctx.workers.send).toHaveBeenCalledWith(expect.objectContaining({ chatType: 'direct', chatId: 'admin-chat',
      text: expect.stringContaining('LW-ABCDEFG2') }));
    await ctx.service.handle(codeMessage('LW-ABCDEFG2', { chatId: primary.chatId, senderId: primary.senderId }),
      { code: 'LW-ABCDEFG2', exact: true }, ownMid);
    expect(ctx.workers.checkFriendRelation).not.toHaveBeenCalled();
    await ctx.service.handle(codeMessage('LW-ABCDEFG2', { chatId: targetMid, senderId: targetMid }),
      { code: 'LW-ABCDEFG2', exact: true }, ownMid);
    expect(ctx.whitelist.activate).toHaveBeenCalledWith('account-a', targetMid, 'admin-mid');
  });

  it('completes group enrollment through target selection and origin-room confirmation, bypassing friendship checks', async () => {
    const ctx = setup();
    await ctx.service.handle(groupCommand(), null, ownMid);
    expect(ctx.workers.send).toHaveBeenCalledWith(expect.objectContaining({ chatType: 'group', chatId: 'origin-room',
      text: expect.stringContaining('請在此群組標記') }));
    await ctx.service.handle(groupSelection(), null, ownMid);
    expect(ctx.workers.send).toHaveBeenCalledWith(expect.objectContaining({ chatType: 'direct', chatId: 'admin-chat',
      text: expect.stringContaining('@AGENT') }));
    expect((ctx.workers.send.mock.calls.at(-1)?.[0] as Extract<LineWorkerCommand, { type: 'sendText' }>).text)
      .toContain('LW-ABCDEFG2');
    await ctx.service.handle(codeMessage('LW-ABCDEFG2'), { code: 'LW-ABCDEFG2', exact: true }, ownMid);
    expect(ctx.workers.checkFriendRelation).not.toHaveBeenCalled();
    expect(ctx.workers.addFriendByMid).not.toHaveBeenCalled();
    expect(ctx.workers.send).toHaveBeenCalledWith(expect.objectContaining({ type: 'sendText', chatType: 'direct', chatId: 'admin-chat',
      text: expect.stringContaining('LW-ABCDEFG2') }));
    expect(ctx.whitelist.activateForEnrollment).not.toHaveBeenCalled();
    await ctx.service.handle(codeMessage('LW-ABCDEFG2'), { code: 'LW-ABCDEFG2', exact: true }, ownMid);
    expect(ctx.whitelist.activateForEnrollment).not.toHaveBeenCalled();
    await ctx.service.handle(groupCodeMessage('LW-ABCDEFG2'), { code: 'LW-ABCDEFG2', exact: true }, ownMid);
    expect(ctx.whitelist.activateForEnrollment).toHaveBeenCalledWith(expect.objectContaining({
      targetMid, scope: { kind: 'CHAT', chatType: 'group', chatId: 'origin-room' },
    }));
    expect(ctx.workers.send.mock.calls.at(-1)?.[0]).toMatchObject({ type: 'sendText', chatType: 'group', chatId: 'origin-room' });
  });

  it('creates a CHAT grant when only ACCOUNT authorization exists, then reports an exact repeat as active', async () => {
    const ctx = setup();
    ctx.whitelist.getActiveAuthorization
      .mockResolvedValueOnce({ scopeKind: 'ACCOUNT' } as never)
      .mockResolvedValueOnce({ scopeKind: 'CHAT', chatType: 'group', chatId: 'origin-room' } as never);
    const confirmGroupEnrollment = async (suffix: string) => {
      await ctx.service.handle(groupCommand({ messageId: `${suffix}-command` }), null, ownMid);
      await ctx.service.handle(groupSelection({ messageId: `${suffix}-selection` }), null, ownMid);
      await ctx.service.handle(groupCodeMessage('LW-ABCDEFG2', { messageId: `${suffix}-confirmation` }),
        { code: 'LW-ABCDEFG2', exact: true }, ownMid);
    };

    await confirmGroupEnrollment('first');
    expect(ctx.whitelist.activateForEnrollment).toHaveBeenCalledWith(expect.objectContaining({
      targetMid, scope: { kind: 'CHAT', chatType: 'group', chatId: 'origin-room' },
    }));
    expect(ctx.whitelist.getActiveAuthorization).toHaveBeenNthCalledWith(1, 'account-a', targetMid,
      { kind: 'CHAT', chatType: 'group', chatId: 'origin-room' });
    expect(ctx.workers.send.mock.calls.at(-1)?.[0]).toMatchObject({
      type: 'sendText', chatType: 'group', chatId: 'origin-room', text: '已完成此群組的使用者授權。',
    });

    await confirmGroupEnrollment('repeat');
    expect(ctx.whitelist.activateForEnrollment).toHaveBeenCalledTimes(2);
    expect(ctx.whitelist.activateForEnrollment).toHaveBeenNthCalledWith(2, expect.objectContaining({
      targetMid, scope: { kind: 'CHAT', chatType: 'group', chatId: 'origin-room' },
    }));
    expect(ctx.whitelist.getActiveAuthorization).toHaveBeenNthCalledWith(2, 'account-a', targetMid,
      { kind: 'CHAT', chatType: 'group', chatId: 'origin-room' });
    expect(ctx.workers.send.mock.calls.at(-1)?.[0]).toMatchObject({
      type: 'sendText', chatType: 'group', chatId: 'origin-room', text: '此使用者已具備此群組的授權。',
    });
  });

  it('accepts mixed-case group adduser commands and rejects extra text', async () => {
    const ctx = setup();
    await ctx.service.handle(groupCommand({ text: '@Agent /AdDuSeR' }), null, ownMid);
    expect(ctx.workers.send).toHaveBeenCalledTimes(1);
    const invalid = setup();
    await invalid.service.handle(groupCommand({ text: '@Agent /ADDUSER please' }), null, ownMid);
    expect(invalid.workers.send).not.toHaveBeenCalled();
  });

  it('accepts inline group commands and requires origin-group confirmation without friendship checks', async () => {
    for (const command of ['/新增使用者', '/aDdUsEr']) {
      const ctx = setup();
      expect(await ctx.service.handle(inlineGroupCommand(command), null, ownMid)).toBe(true);
      expect(ctx.workers.send).toHaveBeenCalledTimes(1);
      expect(ctx.workers.send.mock.calls[0]?.[0]).toMatchObject({ type: 'sendText', chatType: 'direct', chatId: 'admin-chat' });
      expect(ctx.workers.send.mock.calls[0]?.[0].type === 'sendText'
        ? ctx.workers.send.mock.calls[0]?.[0].text : '').toContain('LW-ABCDEFG2');
      expect(ctx.workers.checkFriendRelation).not.toHaveBeenCalled();
      expect(ctx.workers.addFriendByMid).not.toHaveBeenCalled();
      expect(ctx.whitelist.activateForEnrollment).not.toHaveBeenCalled();
      await ctx.service.handle(groupCodeMessage('LW-ABCDEFG2'), { code: 'LW-ABCDEFG2', exact: true }, ownMid);
      expect(ctx.whitelist.activateForEnrollment).toHaveBeenCalledWith(expect.objectContaining({
        targetMid, scope: { kind: 'CHAT', chatType: 'group', chatId: 'origin-room' },
      }));
      expect(ctx.workers.send.mock.calls.at(-1)?.[0]).toMatchObject({ type: 'sendText', chatType: 'group', chatId: 'origin-room' });
    }
  });

  it('rejects malformed inline group commands, fake mentions, extra text and multiple targets', async () => {
    const ctx = setup();
    await ctx.service.handle(inlineGroupCommand('/adduser', { mentionIds: [targetMid],
      mentionRanges: [{ start: 0, end: 6, userId: targetMid }, { start: 15, end: 22, userId: targetMid }] }), null, ownMid);
    await ctx.service.handle(inlineGroupCommand('/adduser extra'), null, ownMid);
    await ctx.service.handle(inlineGroupCommand('/adduser', { text: '@Agent /adduser @Target @Other', mentionIds: [ownMid, targetMid, 'u' + 'c'.repeat(32)],
      mentionRanges: [{ start: 0, end: 6, userId: ownMid }, { start: 15, end: 22, userId: targetMid },
        { start: 23, end: 29, userId: 'u' + 'c'.repeat(32) }] }), null, ownMid);
    expect(ctx.workers.send).not.toHaveBeenCalled();
  });

  it('handles but does not start from group contacts, fake mentions, or non-primary group commands', async () => {
    const ctx = setup();
    expect(await ctx.service.handle(contact({ chatType: 'group', chatId: 'origin-room' }), null, ownMid)).toBe(true);
    await ctx.service.handle(groupCommand({ mentionIds: [], mentionRanges: [] }), null, ownMid);
    ctx.adminCurrent.value = false;
    await ctx.service.handle(groupCommand(), null, ownMid);
    expect(ctx.workers.send).not.toHaveBeenCalled();
  });

  it('ignores group code before target selection and requires confirmation in the origin group', async () => {
    const ctx = setup();
    await ctx.service.handle(groupCommand(), null, ownMid);
    await ctx.service.handle(groupSelection(), null, ownMid);
    expect(ctx.whitelist.activateForEnrollment).not.toHaveBeenCalled();
    expect(ctx.workers.send.mock.calls.at(-1)?.[0]).toMatchObject({ type: 'sendText', chatType: 'direct', chatId: 'admin-chat',
      text: expect.stringContaining('LW-ABCDEFG2') });
    await ctx.service.handle(groupCodeMessage('LW-ABCDEFG2', { chatId: 'wrong-group' }), { code: 'LW-ABCDEFG2', exact: true }, ownMid);
    expect(ctx.whitelist.activateForEnrollment).not.toHaveBeenCalled();
    await ctx.service.handle(groupCodeMessage('LW-ABCDEFG2'), { code: 'LW-ABCDEFG2', exact: true }, ownMid);
    expect(ctx.whitelist.activateForEnrollment).toHaveBeenCalledTimes(1);
    expect(ctx.workers.checkFriendRelation).not.toHaveBeenCalled();
    expect(ctx.workers.addFriendByMid).not.toHaveBeenCalled();
  });

  it('requires exactly one structured target mention in the original group', async () => {
    const ctx = setup();
    await ctx.service.handle(groupCommand(), null, ownMid);
    await ctx.service.handle(groupSelection({ text: '@Agent @Target extra' }), null, ownMid);
    expect(ctx.workers.send).toHaveBeenCalledTimes(2);
    await ctx.service.handle(groupSelection({ text: '@Agent @Target @Other', mentionIds: [ownMid, targetMid, 'u' + 'c'.repeat(32)],
      mentionRanges: [{ start: 0, end: 6, userId: ownMid }, { start: 7, end: 14, userId: targetMid },
        { start: 15, end: 21, userId: 'u' + 'c'.repeat(32) }] }), null, ownMid);
    expect(ctx.workers.send).toHaveBeenCalledTimes(3);
  });

  it('replies in the origin group with the required mention format for an invalid target selection', async () => {
    const ctx = setup();
    await ctx.service.handle(groupCommand(), null, ownMid);
    await ctx.service.handle(groupSelection({ text: '@Agent @Target extra' }), null, ownMid);
    expect(ctx.workers.send).toHaveBeenCalledTimes(2);
    expect(ctx.workers.send.mock.calls.at(-1)?.[0]).toMatchObject({ type: 'sendText', chatType: 'group', chatId: 'origin-room',
      text: expect.stringContaining('標記格式不正確') });
  });

  it('does not issue a token when a delayed direct selection admin lookup completes after expiry', async () => {
    const ctx = setup();
    await ctx.service.handle(directCommand(), null, ownMid);
    const delayed = deferred<boolean>();
    const beforeSelection = ctx.admins.isPrimaryAdministrator.mock.calls.length;
    ctx.admins.isPrimaryAdministrator.mockImplementationOnce(() => delayed.promise);
    const selection = ctx.service.handle(contact(), null, ownMid);
    await vi.waitFor(() => expect(ctx.admins.isPrimaryAdministrator).toHaveBeenCalledTimes(beforeSelection + 1));
    ctx.setNow(601_001);
    delayed.resolve(true);
    await selection;
    await vi.waitFor(() => expect(ctx.workers.send).toHaveBeenCalledTimes(2));
    const last = ctx.workers.send.mock.calls.at(-1)?.[0];
    expect(last).toMatchObject({ type: 'sendText', chatType: 'direct', chatId: 'admin-chat' });
    expect(last?.type === 'sendText' ? last.text : '').toContain('已過期');
    expect(ctx.workers.send.mock.calls.some(([command]) => command.type === 'sendText' && command.text.includes('LW-ABCDEFG2'))).toBe(false);
  });

  it('does not issue a group token when the delayed primary direct lookup completes after expiry', async () => {
    const ctx = setup();
    await ctx.service.handle(groupCommand(), null, ownMid);
    const delayed = deferred<{ chatId: string; userId: string } | null>();
    ctx.admins.getPrimaryAdministrator.mockImplementationOnce(() => delayed.promise);
    const selection = ctx.service.handle(groupSelection(), null, ownMid);
    await vi.waitFor(() => expect(ctx.admins.getPrimaryAdministrator).toHaveBeenCalledTimes(2));
    ctx.setNow(601_001);
    delayed.resolve({ chatId: 'admin-chat', userId: 'admin-mid' });
    await selection;
    await vi.waitFor(() => expect(ctx.workers.send).toHaveBeenCalledTimes(2));
    const last = ctx.workers.send.mock.calls.at(-1)?.[0];
    expect(last).toMatchObject({ type: 'sendText', chatType: 'group', chatId: 'origin-room' });
    expect(last?.type === 'sendText' ? last.text : '').toContain('已過期');
    expect(ctx.workers.send.mock.calls.some(([command]) => command.type === 'sendText' && command.text.includes('LW-ABCDEFG2'))).toBe(false);
  });

  it('does not clear a replacement flow when an older selection lookup expires late', async () => {
    const ctx = setup();
    await ctx.service.handle(directCommand(), null, ownMid);
    const beforeSelection = ctx.admins.isPrimaryAdministrator.mock.calls.length;
    const delayed = deferred<boolean>();
    ctx.admins.isPrimaryAdministrator.mockImplementationOnce(() => delayed.promise);
    const oldContact = ctx.service.handle(contact({ contact: { mid: 'u' + 'c'.repeat(32), displayName: 'Old' } }), null, ownMid);
    await vi.waitFor(() => expect(ctx.admins.isPrimaryAdministrator).toHaveBeenCalledTimes(beforeSelection + 1));

    ctx.setNow(601_001);
    await ctx.service.handle(directCommand({ messageId: 'new-command' }), null, ownMid);
    await ctx.service.handle(contact({ messageId: 'new-contact' }), null, ownMid);
    delayed.resolve(true);
    await oldContact;

    expect(ctx.workers.send.mock.calls.some(([command]) => command.type === 'sendText' && command.text.includes('已過期'))).toBe(false);
    await ctx.service.handle(codeMessage('LW-ABCDEFG2'), { code: 'LW-ABCDEFG2', exact: true }, ownMid);
    expect(ctx.whitelist.activate).toHaveBeenCalledWith('account-a', targetMid, 'admin-mid');
  });

  it('prevents a delayed older adduser lookup from replacing a newer flow', async () => {
    const ctx = setup();
    const delayed = deferred<boolean>();
    ctx.admins.isPrimaryAdministrator.mockImplementationOnce(() => delayed.promise);
    const oldCommand = ctx.service.handle(directCommand({ messageId: 'old-command' }), null, ownMid);
    await vi.waitFor(() => expect(ctx.admins.isPrimaryAdministrator).toHaveBeenCalledTimes(1));
    await ctx.service.handle(directCommand({ messageId: 'new-command' }), null, ownMid);
    delayed.resolve(true);
    await oldCommand;
    expect(ctx.workers.send).toHaveBeenCalledTimes(1);
    expect(ctx.workers.send.mock.calls[0]?.[0]).toMatchObject({ type: 'sendText', text: expect.stringContaining('請分享') });
  });

  it('sends a challenge to the exact primary admin and activates an already verified friend', async () => {
    const ctx = setup();
    await startDirect(ctx);
    expect(ctx.workers.send).toHaveBeenCalledWith(expect.objectContaining({
      type: 'sendText', accountId: 'account-a', workerInstanceId: 'worker-a', controlEpoch: 3,
      transportOwnerId: 'owner-a', transportGeneration: 4, writeGrantVersion: 5,
      chatType: 'direct', chatId: 'admin-chat',
      text: expect.stringMatching(/選定的聯絡人|relay.*selected contact/i),
    }));
    expect((ctx.workers.send.mock.calls[1]?.[0] as Extract<LineWorkerCommand, { type: 'sendText' }>).text).toContain('LW-ABCDEFG2');
    expect(await ctx.service.handle(codeMessage('LW-ABCDEFG2'), { code: 'LW-ABCDEFG2', exact: true })).toBe(true);
    expect(ctx.workers.checkFriendRelation).toHaveBeenCalledTimes(1);
    expect(ctx.workers.addFriendByMid).not.toHaveBeenCalled();
    expect(ctx.whitelist.activate).toHaveBeenCalledWith('account-a', targetMid, 'admin-mid');
    const reply = ctx.workers.send.mock.calls.at(-1)?.[0];
    expect(reply).toMatchObject({ type: 'sendText', chatId: 'admin-chat', text: expect.any(String) });
    expect(reply?.type === 'sendText' ? reply.text : '').not.toContain('LW-ABCDEFG2');
  });

  it('allows the primary admin to enroll their own LINE identity as long as it is not the bot MID', async () => {
    const ctx = setup();
    const selfContact = contact({ senderId: targetMid, contact: { mid: targetMid, displayName: 'Admin' } });
    ctx.admins.isPrimaryAdministrator.mockResolvedValue(true);
    await ctx.service.handle(directCommand({ senderId: targetMid }), null, ownMid);
    await ctx.service.handle(selfContact, null, ownMid);
    expect(ctx.workers.send).toHaveBeenCalledTimes(2);
  });

  it('rejects non-admin, group, history, echo, invalid contact and own LINE MID', async () => {
    const ctx = setup();
    ctx.adminCurrent.value = false;
    await startDirect(ctx);
    ctx.adminCurrent.value = true;
    await ctx.service.handle(contact({ chatType: 'group' }), null);
    await ctx.service.handle(contact({ ingestion: { source: 'history', cursor: 'history' } }), null);
    await ctx.service.handle(contact({ senderId: 'u' + 'b'.repeat(32) }), null);
    await ctx.service.handle(contact({ contact: { mid: 'not-a-line-mid', displayName: null } }), null);
    await ctx.service.handle(contact({ contact: { mid: 'u' + 'b'.repeat(32), displayName: null } }), null);
    expect(ctx.workers.send).not.toHaveBeenCalled();
  });

  it('expires after ten minutes and consumes the challenge after five wrong attempts', async () => {
    const ctx = setup();
    await startDirect(ctx);
    for (let i = 0; i < 5; i++) await ctx.service.handle(codeMessage('LW-BCDEFGH2'), { code: 'LW-BCDEFGH2', exact: true });
    expect(ctx.workers.checkFriendRelation).not.toHaveBeenCalled();
    await startDirect(ctx);
    ctx.setNow(601_000);
    await ctx.service.handle(codeMessage('LW-ABCDEFG2'), { code: 'LW-ABCDEFG2', exact: true });
    expect(ctx.workers.checkFriendRelation).not.toHaveBeenCalled();
  });

  it('rejects replay and cross-account code submissions', async () => {
    const ctx = setup();
    await startDirect(ctx);
    const candidate = { code: 'LW-ABCDEFG2', exact: true };
    await ctx.service.handle(codeMessage(candidate.code), candidate);
    await ctx.service.handle(codeMessage(candidate.code, { accountId: 'account-b' }), candidate);
    expect(ctx.whitelist.activate).toHaveBeenCalledTimes(1);
  });

  it.each(['en', 'zh-TW', 'ja', 'ko'] as const)('localizes invalid enrollment tokens in %s without mutation', async (locale) => {
    const ctx = setup(locale);
    await startDirect(ctx);
    await ctx.service.handle(codeMessage('LW-BCDEFGH2'), { code: 'LW-BCDEFGH2', exact: true });
    const reply = ctx.workers.send.mock.calls.at(-1)?.[0];
    expect(reply?.type === 'sendText' ? reply.text : '').toBe(linePrompt(locale, 'enrollmentTokenExpired'));
    expect(ctx.workers.checkFriendRelation).not.toHaveBeenCalled();
    expect(ctx.whitelist.activate).not.toHaveBeenCalled();
  });

  it.each(['en', 'zh-TW', 'ja', 'ko'] as const)('localizes enrollment verification failure in %s without authorization', async (locale) => {
    const ctx = setup(locale);
    ctx.workers.checkFriendRelation.mockImplementation(async (command) => event('friendRelationResult', {
      requestId: command.requestId, targetMid: command.targetMid, status: 'failed', error: 'LINE unavailable',
    }));
    await startDirect(ctx);
    await ctx.service.handle(codeMessage('LW-ABCDEFG2'), { code: 'LW-ABCDEFG2', exact: true });
    const reply = ctx.workers.send.mock.calls.at(-1)?.[0];
    expect(reply?.type === 'sendText' ? reply.text : '').toBe(linePrompt(locale, 'enrollmentDirectFailed'));
    expect(ctx.whitelist.activate).not.toHaveBeenCalled();
  });

  it('does not consume a challenge whose verification-code send failed', async () => {
    const ctx = setup();
    ctx.workers.send.mockImplementationOnce(async (command) => event('sendResult', {
      requestId: command.type === 'sendText' ? command.requestId : 'none', status: 'sent', messageId: 'prompt', error: null,
    }));
    ctx.workers.send.mockImplementationOnce(async (command) => event('sendResult', {
      requestId: command.type === 'sendText' ? command.requestId : 'none', status: 'failed', messageId: null, error: 'send failed',
    }));
    await ctx.service.handle(directCommand(), null, ownMid);
    await ctx.service.handle(contact(), null, ownMid);
    await ctx.service.handle(codeMessage('LW-ABCDEFG2'), { code: 'LW-ABCDEFG2', exact: true });
    expect(ctx.workers.checkFriendRelation).not.toHaveBeenCalled();
    expect(ctx.whitelist.activate).not.toHaveBeenCalled();
  });

  it('reports when the target already has an active whitelist grant', async () => {
    const ctx = setup();
    ctx.whitelist.getActiveAuthorization.mockResolvedValueOnce({ scopeKind: 'ACCOUNT', chatType: null, chatId: null } as never);
    await startDirect(ctx);
    await ctx.service.handle(codeMessage('LW-ABCDEFG2'), { code: 'LW-ABCDEFG2', exact: true });
    const result = ctx.workers.send.mock.calls.at(-1)?.[0];
    expect(result?.type === 'sendText' ? result.text : '').toContain('\u5df2\u5728\u767d\u540d\u55ae\u4e2d');
  });

  it('adds once for not-friend and unknown add, then requires an exact friend recheck', async () => {
    const ctx = setup();
    ctx.workers.checkFriendRelation.mockImplementationOnce(async (command) => event('friendRelationResult', {
      requestId: command.requestId, targetMid: command.targetMid, status: 'not_friend', error: null,
    })).mockImplementationOnce(async (command) => event('friendRelationResult', {
      requestId: command.requestId, targetMid: command.targetMid, status: 'friend', error: null,
    }));
    ctx.workers.addFriendByMid.mockImplementationOnce(async (command) => event('addFriendResult', {
      requestId: command.requestId, targetMid: command.targetMid, status: 'unknown', error: null,
    }));
    await startDirect(ctx);
    await ctx.service.handle(codeMessage('LW-ABCDEFG2'), { code: 'LW-ABCDEFG2', exact: true });
    expect(ctx.workers.addFriendByMid).toHaveBeenCalledTimes(1);
    expect(ctx.workers.checkFriendRelation).toHaveBeenCalledTimes(2);
    expect(ctx.whitelist.activate).toHaveBeenCalledTimes(1);
  });

  it('does not activate when recheck fails, the worker changes, or the admin changes', async () => {
    const ctx = setup();
    ctx.workers.checkFriendRelation.mockImplementationOnce(async (command) => event('friendRelationResult', {
      requestId: command.requestId, targetMid: command.targetMid, status: 'not_friend', error: null,
    })).mockImplementationOnce(async (command) => event('friendRelationResult', {
      requestId: command.requestId, targetMid: command.targetMid, status: 'not_friend', error: null,
    }));
    await startDirect(ctx);
    await ctx.service.handle(codeMessage('LW-ABCDEFG2'), { code: 'LW-ABCDEFG2', exact: true });
    expect(ctx.whitelist.activate).not.toHaveBeenCalled();

    ctx.workers.checkFriendRelation.mockReset().mockImplementation(async (command) => event('friendRelationResult', {
      requestId: command.requestId, targetMid: command.targetMid, status: 'friend', error: null,
    }));
    await startDirect(ctx);
    ctx.workers.checkFriendRelation.mockImplementationOnce(async (command) => {
      const result = event('friendRelationResult', { requestId: command.requestId, targetMid: command.targetMid, status: 'friend', error: null });
      ctx.setBinding(null);
      return result;
    });
    await ctx.service.handle(codeMessage('LW-ABCDEFG2'), { code: 'LW-ABCDEFG2', exact: true });
    expect(ctx.whitelist.activate).not.toHaveBeenCalled();

    ctx.setBinding(binding);
    await startDirect(ctx);
    ctx.adminCurrent.value = false;
    await ctx.service.handle(codeMessage('LW-ABCDEFG2'), { code: 'LW-ABCDEFG2', exact: true });
    expect(ctx.whitelist.activate).not.toHaveBeenCalled();
  });

  it('rechecks administrator and active account control after the LINE friend result', async () => {
    const ctx = setup();
    await startDirect(ctx);
    ctx.workers.checkFriendRelation.mockImplementationOnce(async (command) => {
      const result = event('friendRelationResult', { requestId: command.requestId, targetMid: command.targetMid, status: 'friend', error: null });
      ctx.adminCurrent.value = false;
      return result;
    });
    await ctx.service.handle(codeMessage('LW-ABCDEFG2'), { code: 'LW-ABCDEFG2', exact: true });
    expect(ctx.whitelist.activate).not.toHaveBeenCalled();

    ctx.adminCurrent.value = true;
    await startDirect(ctx);
    ctx.workers.checkFriendRelation.mockImplementationOnce(async (command) => {
      const result = event('friendRelationResult', { requestId: command.requestId, targetMid: command.targetMid, status: 'friend', error: null });
      ctx.controlCurrent.activeAccountId = 'account-b';
      return result;
    });
    await ctx.service.handle(codeMessage('LW-ABCDEFG2'), { code: 'LW-ABCDEFG2', exact: true });
    expect(ctx.whitelist.activate).not.toHaveBeenCalled();
  });

  it('uses a single-use synchronous compare-and-delete for simultaneous correct codes', async () => {
    const ctx = setup();
    await startDirect(ctx);
    const results = await Promise.all([
      ctx.service.handle(codeMessage('LW-ABCDEFG2'), { code: 'LW-ABCDEFG2', exact: true }),
      ctx.service.handle(codeMessage('LW-ABCDEFG2'), { code: 'LW-ABCDEFG2', exact: true }),
    ]);
    expect(results).toEqual([true, true]);
    expect(ctx.workers.checkFriendRelation).toHaveBeenCalledTimes(1);
    expect(ctx.whitelist.activate).toHaveBeenCalledTimes(1);
  });

  it('keeps a replacement challenge when an older send failure arrives late', async () => {
    const ctx = setup();
    const firstSend = deferred<Extract<LineWorkerEvent, { type: 'sendResult' }>>();
    ctx.workers.send.mockImplementationOnce(async (command) => event('sendResult', {
      requestId: command.type === 'sendText' ? command.requestId : 'none', status: 'sent', messageId: 'prompt', error: null,
    }));
    ctx.workers.send.mockImplementationOnce(() => firstSend.promise);
    await ctx.service.handle(directCommand(), null, ownMid);
    const first = ctx.service.handle(contact(), null, ownMid);
    await vi.waitFor(() => expect(ctx.workers.send).toHaveBeenCalledTimes(2));
    ctx.setCode('LW-ABCDEFG2');
    await startDirect(ctx, { messageId: 'message-2' });
    firstSend.reject(new Error('send failed'));
    await first;
    await ctx.service.handle(codeMessage('LW-ABCDEFG2'), { code: 'LW-ABCDEFG2', exact: true });
    expect(ctx.whitelist.activate).toHaveBeenCalledTimes(1);
  });

  it('does not let old-code admin lookups spend attempts on a replacement challenge', async () => {
    const ctx = setup();
    await startDirect(ctx);
    const lookups = Array.from({ length: 5 }, () => deferred<boolean>());
    ctx.admins.isPrimaryAdministrator.mockClear();
    lookups.forEach((lookup) => ctx.admins.isPrimaryAdministrator.mockImplementationOnce(() => lookup.promise));
    const oldAttempts = Array.from({ length: 5 }, () =>
      ctx.service.handle(codeMessage('LW-BCDEFGH2'), { code: 'LW-BCDEFGH2', exact: true }));
    await vi.waitFor(() => expect(ctx.admins.isPrimaryAdministrator).toHaveBeenCalledTimes(5));
    ctx.setCode('LW-ABCDEFG2');
    await startDirect(ctx, { messageId: 'new-contact' });
    lookups.forEach((lookup) => lookup.resolve(true));
    await Promise.all(oldAttempts);
    await ctx.service.handle(codeMessage('LW-ABCDEFG2'), { code: 'LW-ABCDEFG2', exact: true });
    expect(ctx.whitelist.activate).toHaveBeenCalledTimes(1);
  });

  it('does not let an older delayed contact lookup overwrite a newer contact challenge', async () => {
    const ctx = setup();
    await ctx.service.handle(directCommand(), null, ownMid);
    ctx.admins.isPrimaryAdministrator.mockClear();
    const oldLookup = deferred<boolean>();
    ctx.admins.isPrimaryAdministrator.mockImplementationOnce(() => oldLookup.promise);
    const oldMid = 'u' + 'c'.repeat(32);
    const oldContact = ctx.service.handle(contact({ contact: { mid: oldMid, displayName: 'Old' } }), null, ownMid);
    await vi.waitFor(() => expect(ctx.admins.isPrimaryAdministrator).toHaveBeenCalledTimes(1));
    ctx.setCode('LW-ABCDEFG2');
    await startDirect(ctx, { messageId: 'new-contact' });
    oldLookup.resolve(true);
    await oldContact;
    await ctx.service.handle(codeMessage('LW-ABCDEFG2'), { code: 'LW-ABCDEFG2', exact: true });
    expect(ctx.whitelist.activate).toHaveBeenCalledWith('account-a', targetMid, 'admin-mid');
    expect(ctx.whitelist.activate).not.toHaveBeenCalledWith('account-a', oldMid, 'admin-mid');
  });

  it('rechecks exact worker and transport binding after the final admin lookup', async () => {
    const ctx = setup();
    await startDirect(ctx);
    ctx.whitelist.getActiveAuthorization.mockImplementationOnce(async () => {
      ctx.setBinding({ ...binding, transportGeneration: 88 });
      return null;
    });
    await ctx.service.handle(codeMessage('LW-ABCDEFG2'), { code: 'LW-ABCDEFG2', exact: true });
    expect(ctx.whitelist.activate).not.toHaveBeenCalled();
  });
});
