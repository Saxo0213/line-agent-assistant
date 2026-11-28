import { describe, expect, it } from 'vitest';
import type { ExternalSessionRecord, ExternalSessionReplyRecord, ExternalSessionRepository } from '@line-agent/database';
import { ExternalSessionService } from './external-session-service.js';

const ACCOUNT = 'acct-agent';
const KEY = 'session-key-0001';

/** In-memory stand-in for the parts of ExternalSessionRepository that the service uses. */
class FakeSessions {
  session: ExternalSessionRecord = { sessionKey: KEY, accountId: ACCOUNT, seq: 1, label: 'Build', createdAt: '2026-11-28T00:00:00.000Z',
    lastSeenAt: '2026-11-28T00:00:00.000Z', closedAt: null };
  replies: ExternalSessionReplyRecord[] = [];
  touches = 0;
  async closeIdleSessions() { return 0; }
  async getSession(accountId: string, sessionKey: string) { return accountId === ACCOUNT && sessionKey === KEY ? this.session : null; }
  async touchSession() { this.touches += 1; }
  async closeSession() { this.session = { ...this.session, closedAt: new Date().toISOString() }; return true; }
  async listReplies() { return this.replies; }
  async describeAttachments() { return []; }
  async insertReply(input: { sessionKey: string; source: 'quote' | 'agent'; inboundMessageId: string; text: string; attachmentIds: readonly string[] }) {
    const reply: ExternalSessionReplyRecord = { replyId: `r-${this.replies.length + 1}`, sessionKey: input.sessionKey, source: input.source,
      inboundMessageId: input.inboundMessageId, text: input.text, attachmentIds: [...input.attachmentIds], note: null,
      createdAt: new Date().toISOString(), deliveredAt: null };
    this.replies.push(reply);
    return { reply, inserted: true };
  }
  async takeUndeliveredReplies() {
    const due = this.replies.filter((reply) => reply.deliveredAt === null);
    const now = new Date().toISOString();
    this.replies = this.replies.map((reply) => reply.deliveredAt === null ? { ...reply, deliveredAt: now } : reply);
    return due.map((reply) => ({ ...reply, deliveredAt: now }));
  }
}

function makeService() {
  const sessions = new FakeSessions();
  const service = new ExternalSessionService({ sessions: sessions as unknown as ExternalSessionRepository,
    messages: { findAgentSendAccount: async () => ACCOUNT } });
  const client = { query: async () => ({ rows: [] }) } as never;
  const plan = async (timeoutSeconds: number) => {
    const staged = await service.authorize(client, { toolName: 'wait_for_admin_reply', rawInput: { sessionKey: KEY, timeoutSeconds }, accountScope: [ACCOUNT] });
    if (staged.kind !== 'wait') throw new Error('A wait plan was expected.');
    return staged;
  };
  return { sessions, service, plan };
}

describe('wait_for_admin_reply', () => {
  it('returns at once with the pending replies and marks them delivered', async () => {
    const { sessions, service, plan } = makeService();
    await service.addQuoteReply({ sessionKey: KEY, inboundMessageId: 'in-1', text: 'first', attachmentIds: [] });
    await service.addQuoteReply({ sessionKey: KEY, inboundMessageId: 'in-2', text: 'second', attachmentIds: [] });
    const started = Date.now();
    const output = await service.run(await plan(30), { signal: new AbortController().signal });
    expect(Date.now() - started).toBeLessThan(1_000);
    expect(output).toMatchObject({ toolName: 'wait_for_admin_reply', sessionKey: KEY, sessionClosed: false });
    expect('replies' in output && output.replies.map((reply) => reply.text)).toEqual(['first', 'second']);
    expect(sessions.replies.every((reply) => reply.deliveredAt !== null)).toBe(true);
    expect(sessions.touches).toBeGreaterThan(0);
    // The delivered replies are not returned again.
    const again = await service.run(await plan(1), { signal: new AbortController().signal });
    expect('replies' in again && again.replies).toEqual([]);
  });

  it('returns a reply that is written while it waits, without waiting for the timeout', async () => {
    const { service, plan } = makeService();
    const waiting = service.run(await plan(30), { signal: new AbortController().signal });
    const started = Date.now();
    setTimeout(() => { void service.addQuoteReply({ sessionKey: KEY, inboundMessageId: 'in-9', text: 'late answer', attachmentIds: [] }); }, 50);
    const output = await waiting;
    expect(Date.now() - started).toBeLessThan(2_000);
    expect('replies' in output && output.replies.map((reply) => reply.text)).toEqual(['late answer']);
  });

  it('returns an empty list at the timeout and stops at once when the request is cancelled', async () => {
    const { service, plan } = makeService();
    const timedOut = await service.run(await plan(1), { signal: new AbortController().signal });
    expect(timedOut).toMatchObject({ replies: [], sessionClosed: false });
    const controller = new AbortController();
    const cancelled = service.run(await plan(30), { signal: controller.signal });
    setTimeout(() => controller.abort(), 30);
    expect(await cancelled).toMatchObject({ replies: [] });
  });

  it('rejects a bad timeout and reports an unknown session key', async () => {
    const { service } = makeService();
    const client = { query: async () => ({ rows: [] }) } as never;
    await expect(service.authorize(client, { toolName: 'wait_for_admin_reply', rawInput: { sessionKey: KEY, timeoutSeconds: 601 }, accountScope: [ACCOUNT] }))
      .rejects.toMatchObject({ code: 'INVALID_INPUT' });
    const unknown = await service.authorize(client, { toolName: 'list_admin_replies', rawInput: { sessionKey: 'other-key-0001' }, accountScope: [ACCOUNT] });
    expect(unknown).toMatchObject({ kind: 'done', output: { error: { code: 'SESSION_NOT_FOUND' } } });
  });
});
