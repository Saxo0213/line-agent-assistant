import { describe, expect, it, vi } from 'vitest';
import type { LineSendAuditRow, SendSourceMessage } from '@line-agent/database';
import {
  AgentLineSendService,
  type AgentLineSendRepository,
  type AgentLineSendWorker,
} from './agent-line-send-service.js';

const ACCOUNT = 'acct-agent';
const ADMIN_MID = `u${'a'.repeat(32)}`;
const EXTERNAL = 'local-client:11111111-1111-4111-8111-111111111111';
const SESSION = { key: 'session-key-0001', label: 'Build' };

function makeFixture() {
  const audit: LineSendAuditRow[] = [];
  const sources = new Map<string, SendSourceMessage>();
  const chats = new Set([`direct:${ADMIN_MID}`, 'direct:u-friend', 'group:g-team']);
  const getSendTarget = async (accountId: string, chatType: string, chatId: string) =>
    chats.has(`${chatType}:${chatId}`) ? { accountId, chatType: chatType as 'direct' | 'group', chatId } : null;
  const repo = {
    findAgentSendAccount: vi.fn(async () => ACCOUNT),
    getAgentSendTarget: vi.fn(async (accountId: string, chatType: string, chatId: string) => {
      const target = await getSendTarget(accountId, chatType, chatId);
      return target ? { ...target, newDirect: false } : null;
    }),
    resolveSendSourceMessage: vi.fn(async (input: { messageId: string }) => sources.get(input.messageId) ?? null),
    getSendAttachment: vi.fn(async () => null),
    ensureDirectConversation: vi.fn(async () => undefined),
    recordLineSend: vi.fn(async (row: LineSendAuditRow) => { audit.push(row); }),
    countJobLineSends: vi.fn(async () => 0),
  };
  const sentTexts: string[] = [];
  let counter = 0;
  const worker: AgentLineSendWorker = {
    binding: async (accountId) => ({ accountId, workerInstanceId: 'w-1', controlEpoch: 1, mode: 'ACTIVE_CONTROL' }) as never,
    waitModeAck: async () => true,
    send: async (command) => {
      counter += 1;
      sentTexts.push(command.text);
      return { type: 'sendResult', accountId: command.accountId, workerInstanceId: command.workerInstanceId, controlEpoch: command.controlEpoch,
        requestId: command.requestId, status: 'sent', messageId: `m-${counter}`, error: null } as never;
    },
  };
  const stored: Array<{ accountId: string; lineMessageId: string; sessionKey: string }> = [];
  const sessions = {
    upsertSession: vi.fn(async (_client: unknown, input: { accountId: string; sessionKey: string; label: string }) =>
      ({ sessionKey: input.sessionKey, accountId: input.accountId, seq: 3, label: input.label, createdAt: '', lastSeenAt: '', closedAt: null })),
    recordMessage: vi.fn(async (input: { accountId: string; lineMessageId: string; sessionKey: string }) => { stored.push(input); }),
  };
  const service = new AgentLineSendService({ messages: repo as unknown as AgentLineSendRepository, worker, canWriteLine: async () => true,
    attachmentRoot: 'unused', sessions: sessions as never });
  // findSharedAdminChat reads one row: the Primary Admin direct chat of the Agent account.
  const client = { query: vi.fn(async () => ({ rows: [{ account_id: ACCOUNT, admin_mid: ADMIN_MID }] })) } as never;
  const send = async (rawInput: unknown, principalId = EXTERNAL) => {
    const outcome = await service.authorize(client, { jobId: 'req-1', principalId, rawInput, accountScope: [ACCOUNT] });
    if (outcome.kind === 'rejected') return outcome.output.results;
    return (await service.run(outcome.plan, { signal: new AbortController().signal, isLive: () => true })).results;
  };
  return { service, sources, sentTexts, stored, sessions, send, audit };
}

describe('send_to_target with an external session', () => {
  it('puts the session tag in front of the first text item and stores the LINE message id of every sent message', async () => {
    const { send, sentTexts, stored, sessions } = makeFixture();
    const results = await send({ chatType: 'direct', chatId: ADMIN_MID, session: SESSION,
      items: [{ type: 'text', text: 'first' }, { type: 'text', text: 'second' }] });
    expect(results.map((result) => result.status)).toEqual(['sent', 'sent']);
    expect(sentTexts).toEqual(['【Build #3】\nfirst', 'second']);
    expect(sessions.upsertSession).toHaveBeenCalledWith(expect.anything(), { accountId: ACCOUNT, sessionKey: SESSION.key, label: SESSION.label });
    expect(stored).toEqual([
      { accountId: ACCOUNT, lineMessageId: 'm-1', sessionKey: SESSION.key },
      { accountId: ACCOUNT, lineMessageId: 'm-2', sessionKey: SESSION.key },
    ]);
  });

  it('sends the tag as a text message of its own when no item is text, and the extra message is not an item', async () => {
    const { send, sentTexts, stored, sources } = makeFixture();
    sources.set('src-1', { kind: 'text', text: 'archived text', masked: false, attachments: [] } as unknown as SendSourceMessage);
    const results = await send({ chatType: 'direct', chatId: ADMIN_MID, session: SESSION,
      items: [{ type: 'message', accountId: ACCOUNT, chatType: 'direct', chatId: 'u-friend', messageId: 'src-1' }] });
    expect(results).toEqual([{ index: 0, status: 'sent' }]);
    expect(sentTexts).toEqual(['【Build #3】', 'archived text']);
    expect(stored.map((row) => row.lineMessageId)).toEqual(['m-1', 'm-2']);
  });

  it('refuses a session for a target that is not the direct chat of the Primary Admin with INVALID_INPUT', async () => {
    const { send, sentTexts, sessions } = makeFixture();
    const call = (chatType: string, chatId: string, principal?: string) =>
      send({ chatType, chatId, session: SESSION, items: [{ type: 'text', text: 'x' }] }, principal);
    await expect(call('direct', 'u-friend')).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    await expect(call('group', 'g-team')).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    // An internal Agent job never uses sessions, even for the admin chat.
    await expect(call('direct', ADMIN_MID, 'internal:primary_admin:u-admin')).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    expect(sentTexts).toEqual([]);
    expect(sessions.upsertSession).not.toHaveBeenCalled();
  });

  it('sends without a session as before: no tag and no stored message id', async () => {
    const { send, sentTexts, stored } = makeFixture();
    await send({ chatType: 'direct', chatId: 'u-friend', items: [{ type: 'text', text: 'plain' }] });
    expect(sentTexts).toEqual(['plain']);
    expect(stored).toEqual([]);
  });
});
