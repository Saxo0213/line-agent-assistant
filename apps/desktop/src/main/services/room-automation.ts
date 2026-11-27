import type { WritableConversationKey, LineWorkerCommand, LineWorkerEvent, WorkerBinding } from '@line-agent/contracts';
import { selectAutoresponderReply, type AutoResponderSettings } from '@line-agent/contracts';
import type { AutoResponderRepository, RoomActivationScope } from '@line-agent/database';
import type { InboundEnvelope } from '@line-agent/contracts';
import { randomUUID } from 'node:crypto';
import type { RoomControlHandler } from './line-service.js';

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
    private readonly autoresponders: Pick<AutoResponderRepository, 'get' | 'beginReplyEffect' | 'finishReplyEffect'>,
    private readonly transport: RoomAutomationTransport,
  ) {}

  /** Answers a group/room mention of a sender that the Agent does not serve, by the auto-reply rules. */
  async respond(envelope: InboundEnvelope, body: string): Promise<void> {
    if (envelope.chatType === 'direct') return;
    if (!await this.transport.isAgentAccount(envelope.accountId)) return;
    const key: RoomActivationScope = { accountId: envelope.accountId, chatType: envelope.chatType, chatId: envelope.chatId };
    const settings: AutoResponderSettings = await this.autoresponders.get();
    const text = selectAutoresponderReply(body, settings.rules, settings.fallback);
    const binding = await this.transport.activeBinding(key.accountId);
    if (!binding || !await this.transport.isCurrentControl(binding)) return;
    const claim = await this.autoresponders.beginReplyEffect(key, envelope.messageId, text);
    if (claim !== 'created') return;
    const sent = await this.sendOnce(key, text, envelope.messageId, binding);
    await this.autoresponders.finishReplyEffect(key, envelope.messageId, sent ? 'SENT' : 'UNKNOWN');
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
