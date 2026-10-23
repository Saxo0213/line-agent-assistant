import { randomBytes, randomUUID } from 'node:crypto';
import type { WritableConversationKey, LineWorkerCommand, LineWorkerEvent, WorkerBinding } from '@line-agent/contracts';
import { selectAutoresponderReply, type AutoResponderSettings } from '@line-agent/contracts';
import type { AutoResponderRepository, RoomActivationRepository, RoomActivationScope } from '@line-agent/database';
import type { InboundEnvelope } from '@line-agent/contracts';
import type { RoomControlHandler } from './line-service.js';
import type { Locale } from '../../locale.js';
import { linePrompt } from './line-prompts.js';

type SendTextCommand = Extract<LineWorkerCommand, { type: 'sendText' }>;
type SendResult = Extract<LineWorkerEvent, { type: 'sendResult' }>;

export interface RoomAutomationTransport {
  /** Only the product's AGENT account may use the automatic room reply. */
  isAgentAccount(accountId: string): Promise<boolean>;
  activeBinding(accountId: string): Promise<WorkerBinding | null>;
  isCurrentControl(binding: WorkerBinding): Promise<boolean>;
  /** `signal` cancels the gateway send; room automation never passes one. */
  send(command: SendTextCommand, signal?: AbortSignal): Promise<SendResult>;
}

export class RoomAutomationService implements RoomControlHandler {
  constructor(
    private readonly rooms: RoomActivationRepository,
  private readonly autoresponders: Pick<AutoResponderRepository, 'get' | 'beginReplyEffect' | 'finishReplyEffect'>,
    private readonly digestKey: Buffer,
    private readonly digestKeyVersion: number,
    private readonly transport: RoomAutomationTransport,
    private readonly locale: Locale | string = 'en',
  ) {
    if (digestKey.length !== 32 || !Number.isInteger(digestKeyVersion) || digestKeyVersion < 1) throw new Error('Invalid room token digest key');
  }

  async isEnabled(key: WritableConversationKey): Promise<boolean> {
    if (key.chatType === 'direct') return false;
    return this.rooms.hasActiveRoomGrant(key as RoomActivationScope);
  }

  async getActiveAuthorization(key: WritableConversationKey): Promise<{ grantId: string; version: number } | null> {
    if (key.chatType === 'direct') return null;
    return this.rooms.getActiveRoomAuthorization(key as RoomActivationScope);
  }

  async handle(command: Parameters<RoomControlHandler['handle']>[0]): Promise<void> {
    const binding = await this.transport.activeBinding(command.accountId);
    if (!binding || !await this.transport.isCurrentControl(binding)) return;
    if (command.type === 'request') await this.request(command, binding);
    else await this.confirm(command);
  }

  async respond(envelope: InboundEnvelope, body: string): Promise<void> {
    if (envelope.chatType === 'direct') return;
    if (!await this.transport.isAgentAccount(envelope.accountId)) return;
    const key: RoomActivationScope = { accountId: envelope.accountId, chatType: envelope.chatType, chatId: envelope.chatId };
    if (await this.isEnabled(key)) return;
    const settings: AutoResponderSettings = await this.autoresponders.get();
    const text = selectAutoresponderReply(body, settings.rules, settings.fallback);
    const binding = await this.transport.activeBinding(key.accountId);
    if (!binding || !await this.transport.isCurrentControl(binding)) return;
    const claim = await this.autoresponders.beginReplyEffect(key, envelope.messageId, text);
    if (claim !== 'created') return;
    const sent = await this.sendOnce(key, text, envelope.messageId, binding);
    await this.autoresponders.finishReplyEffect(key, envelope.messageId, sent ? 'SENT' : 'UNKNOWN');
  }

  private async request(command: Extract<Parameters<RoomControlHandler['handle']>[0], { type: 'request' }>, binding: WorkerBinding): Promise<void> {
    const created = await this.rooms.requestActivation({ accountId: command.accountId, chatType: command.chatType,
      chatId: command.chatId, sourceMessageId: command.messageId, requesterId: command.senderId });
    if (created.disposition !== 'created') return;
    const claim = await this.rooms.claimWaitingToSend(created.requestId, binding.workerInstanceId, 60_000);
    if (!claim) return;
    const token = `RA-${randomBytes(32).toString('base64url')}`;
    const prepared = await this.rooms.prepareChallengeSend({ requestId: created.requestId, leaseToken: claim.leaseToken,
      token, digestKey: this.digestKey, digestKeyVersion: this.digestKeyVersion });
    if (!prepared) return;
    const adminSent = await this.sendOnce({ accountId: command.accountId, chatType: 'direct', chatId: claim.adminChatId },
      linePrompt(this.locale, 'roomActivationAdmin', { level: command.chatType, code: command.chatId, token }),
      command.messageId, binding);
    if (!adminSent) await this.rooms.markChallengeDeliveryUnknown(created.requestId);
    await this.sendOnce({ accountId: command.accountId, chatType: command.chatType, chatId: command.chatId },
      linePrompt(this.locale, 'roomActivationWaiting'), command.messageId, binding);
  }

  private async confirm(command: Extract<Parameters<RoomControlHandler['handle']>[0], { type: 'confirmation-candidate' }>): Promise<void> {
    await this.rooms.confirmActivation({ accountId: command.accountId, chatType: command.chatType, chatId: command.chatId,
      sourceMessageId: command.messageId, senderUserId: command.senderId, token: command.token,
      digestKey: this.digestKey, digestKeyVersion: this.digestKeyVersion });
  }

  private async sendOnce(key: WritableConversationKey, text: string, sourceMessageId: string, expected?: WorkerBinding): Promise<boolean> {
    const binding = await this.transport.activeBinding(key.accountId);
    if (!binding || !await this.transport.isCurrentControl(binding)
      || (expected && (binding.workerInstanceId !== expected.workerInstanceId || binding.controlEpoch !== expected.controlEpoch))) return false;
    const requestId = randomUUID();
    const command: SendTextCommand = { type: 'sendText', ...binding, ...key, requestId, text, replyToMessageId: sourceMessageId };
    try {
      const result = await this.transport.send(command);
      return result.type === 'sendResult' && result.requestId === requestId && result.accountId === binding.accountId
        && result.workerInstanceId === binding.workerInstanceId && result.controlEpoch === binding.controlEpoch
        && result.status === 'sent' && !!result.messageId;
    } catch { return false; }
  }
}
