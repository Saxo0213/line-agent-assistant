import { randomUUID } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { LineWorkerCommand, WorkerBinding } from '@line-agent/contracts';
import type { AutoResponderSettings, InboundEnvelope } from '@line-agent/contracts';
import { RoomAutomationService } from './room-automation.js';

describe('room auto-reply', () => {
  let sent: Extract<LineWorkerCommand, { type: 'sendText' }>[];
  let service: RoomAutomationService;
  let active: boolean;
  let autoSettings: AutoResponderSettings;
  const accountId = 'activation-account';
  const binding: WorkerBinding = { accountId, workerInstanceId: 'activation-worker', controlEpoch: 3 };

  beforeEach(() => {
    sent = [];
    active = true;
    autoSettings = { version: 0, displayName: 'Agent', fallback: 'fallback', rules: [{ trigger: 'hello there', reply: 'Exact reply' }] };
    const replyClaims = new Set<string>();
    service = new RoomAutomationService({ async get() { return autoSettings; },
      async beginReplyEffect(_key, sourceMessageId) {
        if (replyClaims.has(sourceMessageId)) return 'duplicate';
        replyClaims.add(sourceMessageId); return 'created';
      }, async finishReplyEffect() { return true; } }, {
      async isAgentAccount() { return true; },
      async activeBinding() { return active ? binding : null; },
      async isCurrentControl() { return active; },
      async send(command) { sent.push(command);
        return { type: 'sendResult', requestId: command.requestId, accountId, workerInstanceId: binding.workerInstanceId,
          controlEpoch: binding.controlEpoch, status: 'sent', messageId: randomUUID(), error: null };
      },
    });
  });

  it('uses exact normalized triggers and suppresses a replayed deterministic reply', async () => {
    const envelope = { accountId, chatType: 'group', chatId: 'respond-room', messageId: 'reply-source' } as InboundEnvelope;
    await service.respond(envelope, 'hello   there');
    await service.respond(envelope, 'hello   there');
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ chatType: 'group', chatId: 'respond-room', text: 'Exact reply' });
  });

  it('replies in a group with no activation step, and uses the fallback for an unknown text', async () => {
    await service.respond({ accountId, chatType: 'room', chatId: 'any-room', messageId: 'fallback-source' } as InboundEnvelope, 'something else');
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ chatType: 'room', chatId: 'any-room', text: 'fallback' });
  });

  it('does not send a fixed reply when no account session is active', async () => {
    active = false;
    const envelope = { accountId, chatType: 'group', chatId: 'offline-room', messageId: 'offline-source' } as InboundEnvelope;
    await service.respond(envelope, 'hello there');
    expect(sent).toEqual([]);
  });

  it('does not read or send the global reply for a Primary Admin account', async () => {
    const send = vi.fn();
    const get = vi.fn();
    const gated = new RoomAutomationService(
      { get, beginReplyEffect: vi.fn(), finishReplyEffect: vi.fn() } as never,
      { isAgentAccount: async () => false, activeBinding: vi.fn(), isCurrentControl: vi.fn(), send } as never,
    );
    await gated.respond({ accountId: 'primary-admin', chatType: 'group', chatId: 'room', messageId: 'message' } as InboundEnvelope,
      'hello there');
    expect(get).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
  });
});
