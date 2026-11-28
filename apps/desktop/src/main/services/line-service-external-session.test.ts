import { describe, expect, it } from 'vitest';
import type { InboundEnvelope, LineWorkerCommand, LineWorkerEvent } from '@line-agent/contracts';
import { LineService } from './line-service.js';
import type { ExternalSessionRouting } from './external-session-service.js';

const cursor = (revision: string) => ({ version: 1 as const, revision, globalRev: '0', individualRev: '0' });
const adminMessage = (overrides: Partial<InboundEnvelope> = {}): InboundEnvelope => ({
  eventId: 'e1', accountId: 'a', chatType: 'direct', chatId: 'u-admin', senderId: 'u-admin', messageId: 'm-in-1', kind: 'text', text: 'ok, go ahead',
  mentionIds: [], mentionRanges: [], replyToMessageId: null, ingestion: { source: 'live', cursor: null },
  occurredAt: '2026-11-28T00:00:00.000Z', attachments: [], raw: {}, ...overrides,
});
const batchOf = (envelopes: InboundEnvelope[]): Extract<LineWorkerEvent, { type: 'batch' }> => ({ type: 'batch', accountId: 'a', workerInstanceId: 'w1',
  controlEpoch: 1, batchId: 'b1', cursorBefore: cursor('0'), cursorAfter: cursor('1'), envelopes, startupSync: false, startupFinal: false });

async function run(envelope: InboundEnvelope, session: { closed: boolean } | null) {
  const archived: Array<{ decisions: any[] }> = [];
  const kicked: string[] = [];
  const quoteReplies: Array<{ sessionKey: string; inboundMessageId: string; text: string; attachmentIds: readonly string[] }> = [];
  const lookups: Array<{ accountId: string; messageId: string }> = [];
  const systemTexts: Array<{ text: string; principalId: string; chatId: string }> = [];
  const commands: LineWorkerCommand[] = [];
  const routing: ExternalSessionRouting = {
    async findQuoted(accountId, messageId) {
      lookups.push({ accountId, messageId });
      return session && messageId === 'm-out-1' ? { sessionKey: 'session-key-0001', seq: 2, label: 'Build', closed: session.closed } : null;
    },
    async addQuoteReply(input) { quoteReplies.push(input); },
  };
  const messages = { async listPendingRouteActions() { return []; }, async applyPendingRouteAction() {},
    async getAttachmentBySource() { return null; },
    async ingestBatchAndRoute(input: { envelopes: InboundEnvelope[] }, decisions: any[]) {
      archived.push({ decisions });
      return { inserted: input.envelopes.length, duplicate: 0, insertedMessageIds: input.envelopes.map((item) => item.messageId), jobIds: [],
        jobMessageIds: decisions.flatMap((decision, index) => decision.eligible ? [input.envelopes[index]!.messageId] : []),
        primaryAdminActionMessageIds: [] };
    } };
  const settings = { async getAppSetting() { return undefined; }, async getConversationAgent() { return { enabled: true, provider: 'claude' }; } };
  const admins = { async isPrimaryAdministrator() { return true; }, async isPrimaryUser() { return true; } };
  const service = new LineService(
    { async bindWorker() {}, async getAccount() { return { ownMid: 'agent-mid' }; } } as never, messages as never, settings as never,
    { async send(command: LineWorkerCommand) { commands.push(command); } },
    { kick(key) { kicked.push(key.chatId); }, async stopChat() {}, async resetChat() {} },
    undefined, undefined, undefined, admins as never,
    { async inspect() { return { status: 'available', version: 1, path: 'C:\\trusted' }; } },
    undefined, undefined, undefined, undefined, undefined, undefined, 'en', undefined, undefined, undefined,
    async (input) => { systemTexts.push({ text: input.text, principalId: input.principalId, chatId: input.target.chatId }); return { status: 'sent' as const }; },
    undefined, undefined, undefined, undefined, undefined, routing);
  await service.bind({ accountId: 'a', workerInstanceId: 'w1', controlEpoch: 1, mode: 'ACTIVE_CONTROL' });
  await service.handleWorkerEvent('w1', batchOf([envelope]));
  await service.idleRoomEffects();
  return { archived, kicked, quoteReplies, lookups, systemTexts };
}

describe('quoted reply of the Primary Admin to an external session', () => {
  it('gives the message to an open session, creates no Agent job and tells the admin', async () => {
    const h = await run(adminMessage({ replyToMessageId: 'm-out-1' }), { closed: false });
    expect(h.quoteReplies).toEqual([{ sessionKey: 'session-key-0001', inboundMessageId: 'm-in-1', text: 'ok, go ahead', attachmentIds: [] }]);
    expect(h.archived[0]!.decisions).toEqual([{ eligible: false, action: 'ignore' }]);
    expect(h.kicked).toEqual([]);
    expect(h.systemTexts).toEqual([{ text: '已轉給【Build #2】。', principalId: 'system:external_session', chatId: 'u-admin' }]);
  });

  it('keeps the normal Agent route for a closed session and adds the notice', async () => {
    const h = await run(adminMessage({ replyToMessageId: 'm-out-1' }), { closed: true });
    expect(h.quoteReplies).toEqual([]);
    expect(h.archived[0]!.decisions[0]).toMatchObject({ eligible: true, prompt: 'ok, go ahead' });
    expect(h.kicked).toEqual(['u-admin']);
    expect(h.systemTexts.map((item) => item.text)).toEqual(['【Build #2】已結束，訊息交給 Agent。']);
  });

  it('keeps a quoted command as a command', async () => {
    const h = await run(adminMessage({ replyToMessageId: 'm-out-1', text: '/stop' }), { closed: false });
    expect(h.lookups).toEqual([]);
    expect(h.quoteReplies).toEqual([]);
    expect(h.systemTexts).toEqual([]);
    expect(h.archived[0]!.decisions[0]).toMatchObject({ eligible: false, action: 'stop' });
  });

  it('routes a quote of any other message, and a message without a quote, to the Agent without a notice', async () => {
    const other = await run(adminMessage({ replyToMessageId: 'm-other' }), { closed: false });
    expect(other.lookups).toEqual([{ accountId: 'a', messageId: 'm-other' }]);
    expect(other.archived[0]!.decisions[0]).toMatchObject({ eligible: true });
    expect(other.systemTexts).toEqual([]);
    const plain = await run(adminMessage(), { closed: false });
    expect(plain.lookups).toEqual([]);
    expect(plain.archived[0]!.decisions[0]).toMatchObject({ eligible: true });
  });
});
