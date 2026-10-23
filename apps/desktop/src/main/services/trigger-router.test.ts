import { describe, expect, it } from 'vitest';
import type { InboundEnvelope } from '@line-agent/contracts';
import { hasOwnMention, routeTrigger } from './trigger-router.js';

const envelope = (overrides: Partial<InboundEnvelope> = {}): InboundEnvelope => ({
  eventId: 'e1', accountId: 'a', chatType: 'group', chatId: 'g', senderId: 'user', messageId: 'm1',
  kind: 'text', text: '@Agent /agent claude fix this', mentionIds: ['agent-mid'],
  mentionRanges: [{ start: 0, end: 6, userId: 'agent-mid' }], replyToMessageId: null,
  ingestion: { source: 'live', cursor: null }, occurredAt: '2026-10-15T00:00:00.000Z', attachments: [], raw: {}, ...overrides,
});
const context = { ownMid: 'agent-mid', agentEnabled: true, senderIsPrimaryAdmin: false,
  workspaceConfigured: true, defaultProvider: 'codex' as const };

describe('routeTrigger', () => {
  it('recognizes only a structured mention of this account MID', () => {
    expect(hasOwnMention(envelope(), 'agent-mid')).toBe(true);
    expect(hasOwnMention(envelope({ text: '@Agent', mentionIds: [], mentionRanges: [] }), 'agent-mid')).toBe(false);
    expect(hasOwnMention(envelope({ mentionRanges: [{ start: 0, end: 6, userId: 'other-mid' }] }), 'agent-mid')).toBe(false);
    expect(hasOwnMention(envelope({ mentionIds: ['agent-mid'], mentionRanges: [] }), 'agent-mid')).toBe(false);
  });
  it('uses an actual UTF-16 Agent mention and command provider while preserving prompt text', () => {
    expect(routeTrigger(envelope(), context)).toEqual({ type: 'prompt', provider: 'claude', prompt: 'fix this' });
  });
  it('rejects forged mention ID without a valid span', () => {
    expect(routeTrigger(envelope({ mentionRanges: [] }), context)).toEqual({ type: 'ignore' });
  });
  it('does not let a reply to an Agent message bypass the verified group mention gate', () => {
    const reply = envelope({ text: 'continue', mentionIds: [], mentionRanges: [], replyToMessageId: 'prior' });
    expect(routeTrigger(reply, context)).toEqual({ type: 'ignore' });
  });
  it('requires group Agent enablement even with a verified own-MID mention', () => {
    expect(routeTrigger(envelope(), { ...context, agentEnabled: false })).toEqual({ type: 'ignore' });
  });
  it('lets a verified primary administrator mention Agent in a group with room activation off', () => {
    expect(routeTrigger(envelope(), { ...context, agentEnabled: false, senderIsPrimaryAdmin: true }))
      .toEqual({ type: 'prompt', provider: 'claude', prompt: 'fix this' });
    expect(routeTrigger(envelope({ text: '@Agent /status' }),
      { ...context, agentEnabled: false, senderIsPrimaryAdmin: true })).toEqual({ type: 'status' });
  });
  it('routes direct messages from the immutable primary administrator even when the room toggle is off', () => {
    const direct = envelope({ chatType: 'direct', text: 'hello', mentionIds: [], mentionRanges: [] });
    expect(routeTrigger(direct, context)).toEqual({ type: 'ignore' });
    expect(routeTrigger(direct, { ...context, agentEnabled: false, senderIsPrimaryAdmin: true }))
      .toEqual({ type: 'prompt', provider: 'codex', prompt: 'hello' });
    expect(routeTrigger(direct, { ...context, senderIsPrimaryAdmin: true })).toEqual({ type: 'prompt', provider: 'codex', prompt: 'hello' });
    expect(routeTrigger(direct, { ...context, agentEnabled: true, senderIsPrimaryAdmin: false })).toEqual({ type: 'ignore' });
  });
  it('ignores self, history, non-text, decrypt failures and missing workspace', () => {
    const direct = envelope({ chatType: 'direct', text: 'hello', mentionIds: [], mentionRanges: [] });
    const authorized = { ...context, senderIsPrimaryAdmin: true };
    expect(routeTrigger({ ...direct, senderId: 'agent-mid' }, authorized)).toEqual({ type: 'ignore' });
    expect(routeTrigger({ ...direct, ingestion: { source: 'history', cursor: null } }, authorized)).toEqual({ type: 'ignore' });
    expect(routeTrigger({ ...direct, kind: 'event', text: null, raw: { contentState: 'decrypt_failed' } }, authorized)).toEqual({ type: 'ignore' });
    expect(routeTrigger(direct, { ...authorized, workspaceConfigured: false })).toEqual({ type: 'ignore' });
  });
  it('recognizes control commands and never treats ordinary flags as settings', () => {
    const direct = envelope({ chatType: 'direct', mentionIds: [], mentionRanges: [] });
    const authorized = { ...context, senderIsPrimaryAdmin: true };
    expect(routeTrigger({ ...direct, text: '/stop' }, authorized)).toEqual({ type: 'stop' });
    expect(routeTrigger({ ...direct, text: '/new' }, authorized)).toEqual({ type: 'new' });
    expect(routeTrigger({ ...direct, text: '/status' }, authorized)).toEqual({ type: 'status' });
    expect(routeTrigger({ ...direct, text: '/status' }, context)).toEqual({ type: 'ignore' });
    expect(routeTrigger({ ...direct, text: '--workspace C:\\evil --danger' }, authorized)).toEqual({ type: 'prompt', provider: 'codex', prompt: '--workspace C:\\evil --danger' });
    expect(routeTrigger({ ...direct, text: '  ' }, authorized)).toEqual({ type: 'ignore' });
  });
  it('does not treat @all as the account own MID', () => {
    expect(routeTrigger(envelope({ text: '@all hello', mentionIds: ['@all'],
      mentionRanges: [{ start: 0, end: 4, userId: '@all' }] }), context)).toEqual({ type: 'ignore' });
  });
});
