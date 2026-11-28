import { describe, expect, it } from 'vitest';
import { DeliveryService } from './delivery-service.js';
import type { ReplyAuditDecision } from './reply-audit-service.js';

function setup(decision: ReplyAuditDecision | 'throw', sendOk = true) {
  const parts = ['first part', 'second part'];
  const sent: string[] = [];
  const marks: Array<[number, string]> = [];
  const unknown: number[] = [];
  const audited: string[][] = [];
  const repository = {
    async getJob() { return { jobId: 'j', accountId: 'account', chatType: 'group' as const, chatId: 'chat', provider: 'claude' as const, prompt: 'q',
      workspacePath: 'C:\\ws', generation: 0, status: 'completed' as const, sourceType: 'line' as const, sourceMessageId: 'm', sourceRequestId: null, creationEpoch: 4 }; },
    async listDeliveries() { return parts.map((text, partIndex) => ({ deliveryId: `d${partIndex}`, jobId: 'j', partIndex, text, idempotencyKey: `j:${partIndex}`,
      status: 'pending' as const, lineMessageId: null })); },
    async claimLineDelivery(_jobId: string, partIndex: number) { return { deliveryId: `d${partIndex}`, jobId: 'j', partIndex, text: parts[partIndex]!, idempotencyKey: `j:${partIndex}`,
      status: 'sending' as const, lineMessageId: null, accountId: 'account', chatType: 'group' as const, chatId: 'chat', controlEpoch: 4 }; },
    async markDeliverySent(_jobId: string, partIndex: number, id: string) { marks.push([partIndex, id]); return true; },
    async markDeliveryUnknown(_jobId: string, partIndex: number) { unknown.push(partIndex); return true; },
  };
  const service = new DeliveryService(repository, {
    async binding() { return { accountId: 'account', workerInstanceId: 'w', controlEpoch: 4, mode: 'ACTIVE_CONTROL' as const }; },
    async send(command) { sent.push(command.text); return { type: 'sendResult' as const, accountId: 'account', workerInstanceId: 'w', controlEpoch: 4,
      requestId: command.requestId, status: sendOk ? 'sent' as const : 'unknown' as const, messageId: sendOk ? `line-${sent.length}` : null, error: null }; },
  }, async () => true, undefined, (text) => `[redacted] ${text}`,
  async (_job, texts) => { audited.push(texts); if (decision === 'throw') throw new Error('audit bug'); return decision; });
  return { service, sent, marks, unknown, audited };
}

describe('reply audit step of the delivery', () => {
  it('audits the redacted text of all parts once and sends them when the decision is pass', async () => {
    const t = setup({ kind: 'pass' });
    await t.service.deliverCompletedJob('j');
    expect(t.audited).toEqual([['[redacted] first part', '[redacted] second part']]);
    expect(t.sent).toEqual(['[redacted] first part', '[redacted] second part']);
  });
  it('sends the fixed text once for a blocked reply and settles the other parts with its id', async () => {
    const t = setup({ kind: 'block', text: '此項由管理者管理。' });
    await t.service.deliverCompletedJob('j');
    expect(t.audited).toHaveLength(1);
    expect(t.sent).toEqual(['此項由管理者管理。']);
    expect(t.marks).toEqual([[0, 'line-1'], [1, 'line-1']]);
  });
  it('does not mark the other parts as sent when the fixed text was not confirmed', async () => {
    const t = setup({ kind: 'block', text: '此項由管理者管理。' }, false);
    await t.service.deliverCompletedJob('j');
    expect(t.sent).toEqual(['此項由管理者管理。']);
    expect(t.marks).toEqual([]);
    expect(t.unknown).toEqual([0, 1]);
  });
  it('does not hold the account send slot while an audit waits, and audits a job once', async () => {
    const sent: string[] = [];
    let release!: (decision: ReplyAuditDecision) => void;
    const slow = new Promise<ReplyAuditDecision>((resolve) => { release = resolve; });
    let slowAudits = 0;
    const repository = {
      async getJob(jobId: string) { return { jobId, accountId: 'account', chatType: 'group' as const, chatId: 'chat', provider: 'claude' as const, prompt: 'q',
        workspacePath: 'C:\\ws', generation: 0, status: 'completed' as const, sourceType: 'line' as const, sourceMessageId: jobId, sourceRequestId: null, creationEpoch: 4 }; },
      async listDeliveries(jobId: string) { return [{ deliveryId: `d-${jobId}`, jobId, partIndex: 0, text: `reply of ${jobId}`, idempotencyKey: `${jobId}:0`, status: 'pending' as const, lineMessageId: null }]; },
      async claimLineDelivery(jobId: string) { return { deliveryId: `d-${jobId}`, jobId, partIndex: 0, text: `reply of ${jobId}`, idempotencyKey: `${jobId}:0`,
        status: 'sending' as const, lineMessageId: null, accountId: 'account', chatType: 'group' as const, chatId: 'chat', controlEpoch: 4 }; },
      async markDeliverySent() { return true; }, async markDeliveryUnknown() { return true; },
    };
    const service = new DeliveryService(repository, {
      async binding() { return { accountId: 'account', workerInstanceId: 'w', controlEpoch: 4, mode: 'ACTIVE_CONTROL' as const }; },
      async send(command) { sent.push(command.text); return { type: 'sendResult' as const, accountId: 'account', workerInstanceId: 'w', controlEpoch: 4,
        requestId: command.requestId, status: 'sent' as const, messageId: `m${sent.length}`, error: null }; },
    }, async () => true, undefined, undefined, async (job) => { if (job.jobId === 'slow') { slowAudits++; return slow; } return { kind: 'pass' }; });
    const first = service.deliverCompletedJob('slow');
    await service.deliverCompletedJob('fast');
    expect(sent).toEqual(['reply of fast']);
    void service.deliverCompletedJob('slow');
    release({ kind: 'pass' });
    await first;
    expect(sent).toEqual(['reply of fast', 'reply of slow']);
    expect(slowAudits).toBe(1);
  });
  it('sends the reply as it is when the audit step itself fails', async () => {
    const t = setup('throw');
    await t.service.deliverCompletedJob('j');
    expect(t.sent).toEqual(['[redacted] first part', '[redacted] second part']);
  });
});
