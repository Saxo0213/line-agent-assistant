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

describe('routeTrigger group free mode', () => {
  const admin = { ...context, senderIsPrimaryAdmin: true };
  const plain = (text: string) => envelope({ text, mentionIds: [], mentionRanges: [] });

  it('parses /free, /free N and /free off, with or without an Agent mention', () => {
    expect(routeTrigger(plain('/free'), admin)).toEqual({ type: 'free', action: 'on', minutes: 5 });
    expect(routeTrigger(plain('/free 30'), admin)).toEqual({ type: 'free', action: 'on', minutes: 30 });
    expect(routeTrigger(plain('/FREE   120'), admin)).toEqual({ type: 'free', action: 'on', minutes: 120 });
    expect(routeTrigger(plain('/free off'), admin)).toEqual({ type: 'free', action: 'off' });
    expect(routeTrigger(envelope({ text: '@Agent /free 7' }), admin)).toEqual({ type: 'free', action: 'on', minutes: 7 });
    expect(routeTrigger(envelope({ text: '@Agent /free off' }), { ...admin, agentEnabled: false })).toEqual({ type: 'free', action: 'off' });
  });
  it('a bare /free never turns free mode off, even while it is on', () => {
    expect(routeTrigger(plain('/free'), { ...admin, freeModeActive: true })).toEqual({ type: 'free', action: 'on', minutes: 5 });
    expect(routeTrigger(plain('/free 9'), { ...admin, freeModeActive: true })).toEqual({ type: 'free', action: 'on', minutes: 9 });
  });
  it('rejects out-of-range and malformed arguments with the range reply', () => {
    for (const text of ['/free 0', '/free 121', '/free -3', '/free 1.5', '/free abc', '/free 5 6', '/free 99999999']) {
      expect(routeTrigger(plain(text), admin)).toEqual({ type: 'free_range' });
    }
  });
  it('is Primary Administrator only; a member /free is never forwarded to the Agent', () => {
    expect(routeTrigger(plain('/free'), context)).toEqual({ type: 'ignore' });
    expect(routeTrigger(envelope({ text: '@Agent /free' }), context)).toEqual({ type: 'ignore' });
    expect(routeTrigger(plain('/free'), { ...context, freeModeActive: true })).toEqual({ type: 'free_message' });
    expect(routeTrigger({ ...plain('/free'), chatType: 'direct' }, admin)).not.toMatchObject({ type: 'free' });
  });
  it('does not treat /freedom or text after a different word as the command', () => {
    expect(routeTrigger(plain('/freedom'), admin)).toEqual({ type: 'ignore' });
    expect(routeTrigger(plain('please /free'), admin)).toEqual({ type: 'ignore' });
  });
  it('keeps the live/own/decrypt_failed gates for free commands and messages', () => {
    const on = { ...admin, freeModeActive: true };
    expect(routeTrigger({ ...plain('/free'), ingestion: { source: 'history', cursor: null } }, on)).toEqual({ type: 'ignore' });
    expect(routeTrigger({ ...plain('/free'), senderId: 'agent-mid' }, on)).toEqual({ type: 'ignore' });
    expect(routeTrigger({ ...plain('hi'), senderId: 'agent-mid' }, on)).toEqual({ type: 'ignore' });
    expect(routeTrigger({ ...plain('hi'), raw: { contentState: 'decrypt_failed' } }, on)).toEqual({ type: 'ignore' });
    expect(routeTrigger({ ...plain('hi'), kind: 'image', text: null }, on)).toEqual({ type: 'ignore' });
  });
  it('treats any member text as addressed to the Agent only while free mode is on', () => {
    expect(routeTrigger(plain('hello everyone'), context)).toEqual({ type: 'ignore' });
    expect(routeTrigger(plain('hello everyone'), { ...context, freeModeActive: true })).toEqual({ type: 'free_message' });
    expect(routeTrigger(plain('hello'), { ...context, agentEnabled: false, freeModeActive: true })).toEqual({ type: 'free_message' });
    expect(routeTrigger(plain('hello'), { ...admin, freeModeActive: true })).toEqual({ type: 'free_message' });
  });
  it('keeps an explicit mention on the normal path while on (admin prompt, /stop, /new, /status)', () => {
    const on = { ...admin, freeModeActive: true };
    expect(routeTrigger(envelope({ text: '@Agent fix this' }), on)).toEqual({ type: 'prompt', provider: 'codex', prompt: 'fix this' });
    expect(routeTrigger(envelope({ text: '@Agent /stop' }), on)).toEqual({ type: 'stop' });
    expect(routeTrigger(envelope({ text: '@Agent /status' }), on)).toEqual({ type: 'status' });
    expect(routeTrigger(envelope({ text: '@Agent /new' }), on)).toEqual({ type: 'new' });
  });
});
