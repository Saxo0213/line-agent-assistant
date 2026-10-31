import { describe, expect, it } from 'vitest';
import type { InboundEnvelope } from '@line-agent/contracts';
import { hasOwnMention, isFolderCommandText, parseAgentSwitch, parseFolderCommand, routeTrigger } from './trigger-router.js';

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

describe('/folder command parsing', () => {
  it.each([
    ['/folder D:\\Projects\\Alpha', { type: 'folder', action: 'bind', path: 'D:\\Projects\\Alpha', mode: 'READ' }],
    ['/folder rw D:\\Projects\\Alpha', { type: 'folder', action: 'bind', path: 'D:\\Projects\\Alpha', mode: 'READ_WRITE' }],
    ['/FOLDER RW D:\\Projects\\Alpha', { type: 'folder', action: 'bind', path: 'D:\\Projects\\Alpha', mode: 'READ_WRITE' }],
    ['/folder D:\\公司 專案\\第一季 報告', { type: 'folder', action: 'bind', path: 'D:\\公司 專案\\第一季 報告', mode: 'READ' }],
    ['/folder "D:\\My Projects\\Alpha"', { type: 'folder', action: 'bind', path: 'D:\\My Projects\\Alpha', mode: 'READ' }],
    ['/folder rw \'D:\\My Projects\\Alpha\'', { type: 'folder', action: 'bind', path: 'D:\\My Projects\\Alpha', mode: 'READ_WRITE' }],
    ['/folder rw \u201CD:\\My Projects\\Alpha\u201D', { type: 'folder', action: 'bind', path: 'D:\\My Projects\\Alpha', mode: 'READ_WRITE' }],
    ['/folder \\\\server\\share\\Alpha', { type: 'folder', action: 'bind', path: '\\\\server\\share\\Alpha', mode: 'READ' }],
    ['/folder', { type: 'folder', action: 'list' }],
    ['/folder temp', { type: 'folder', action: 'temp_show' }],
    ['/folder temp off', { type: 'folder', action: 'temp_off' }],
    ['/folder temp retry', { type: 'folder', action: 'temp_retry' }],
    ['/folder temp "D:\\Extra Storage\\Chat"', { type: 'folder', action: 'temp_set', path: 'D:\\Extra Storage\\Chat' }],
    ['/folder   ', { type: 'folder', action: 'list' }],
    ['/folder off', { type: 'folder', action: 'off', path: null }],
    ['/folder OFF', { type: 'folder', action: 'off', path: null }],
    ['/folder off D:\\Projects\\Alpha', { type: 'folder', action: 'off', path: 'D:\\Projects\\Alpha' }],
    ['/folder off "D:\\My Projects\\Alpha"', { type: 'folder', action: 'off', path: 'D:\\My Projects\\Alpha' }],
    ['/folder rw', { type: 'folder', action: 'usage' }],
    ['/folder ""', { type: 'folder', action: 'usage' }],
  ])('parses %s', (text, expected) => {
    expect(parseFolderCommand(text)).toEqual(expected);
  });

  it('does not treat other words or sentences as the command', () => {
    for (const text of ['/folders D:\\x', '/folderD:\\x', 'please /folder D:\\x', 'folder D:\\x', '/free', '']) expect(parseFolderCommand(text)).toBeNull();
  });

  it('sees the command with or without an Agent mention, in every chat type', () => {
    expect(isFolderCommandText(envelope({ text: '@Agent /folder rw D:\\x' }), 'agent-mid')).toBe(true);
    expect(isFolderCommandText(envelope({ text: '/folder D:\\x', mentionIds: [], mentionRanges: [] }), 'agent-mid')).toBe(true);
    expect(isFolderCommandText(envelope({ chatType: 'direct', text: '/folder', mentionIds: [], mentionRanges: [] }), 'agent-mid')).toBe(true);
    expect(isFolderCommandText(envelope({ text: '@Agent hello' }), 'agent-mid')).toBe(false);
  });

  it('executes the command only for the Primary Admin; anyone else is an ordinary message', () => {
    const admin = { ...context, senderIsFolderAdmin: true, senderIsPrimaryAdmin: true };
    const bind = { type: 'folder', action: 'bind', path: 'D:\\x', mode: 'READ_WRITE' };
    expect(routeTrigger(envelope({ text: '@Agent /folder rw D:\\x' }), admin)).toEqual(bind);
    expect(routeTrigger(envelope({ text: '/folder rw D:\\x', mentionIds: [], mentionRanges: [] }), admin)).toEqual(bind);
    expect(routeTrigger(envelope({ chatType: 'direct', text: '/folder rw D:\\x', mentionIds: [], mentionRanges: [] }), admin)).toEqual(bind);
    const ordinary = { type: 'prompt', provider: 'codex', prompt: '/folder rw D:\\x' };
    expect(routeTrigger(envelope({ text: '@Agent /folder rw D:\\x' }), context)).toEqual(ordinary);
    expect(routeTrigger(envelope({ text: '@Agent /folder rw D:\\x' }), { ...context, senderIsPrimaryAdmin: true })).toEqual(ordinary);
    expect(routeTrigger(envelope({ text: '@Agent /folder rw D:\\x' }), { ...context, agentEnabled: false })).toEqual({ type: 'ignore' });
    expect(routeTrigger(envelope({ text: '/folder rw D:\\x', mentionIds: [], mentionRanges: [] }), context)).toEqual({ type: 'ignore' });
    expect(routeTrigger(envelope({ chatType: 'direct', text: '/folder', mentionIds: [], mentionRanges: [] }), context)).toEqual({ type: 'ignore' });
    expect(routeTrigger(envelope({ text: '/folder D:\\x', mentionIds: [], mentionRanges: [] }), { ...admin, freeModeActive: true })).toEqual({ type: 'folder', action: 'bind', path: 'D:\\x', mode: 'READ' });
    expect(routeTrigger(envelope({ text: '/folder D:\\x', mentionIds: [], mentionRanges: [] }), { ...context, freeModeActive: true })).toEqual({ type: 'free_message' });
  });
});

describe('bare /agent switch commands', () => {
  const mention = { mentionIds: ['agent-mid'], mentionRanges: [{ start: 0, end: 6, userId: 'agent-mid' }] };
  const admin = { ...context, senderIsPrimaryAdmin: true, primaryAdmin: true };
  it('parses claude, codex and default case-insensitively, and nothing with content', () => {
    expect(parseAgentSwitch('/agent claude')).toEqual({ provider: 'claude' });
    expect(parseAgentSwitch(' /AGENT Codex ')).toEqual({ provider: 'codex' });
    expect(parseAgentSwitch('/agent default')).toEqual({ provider: 'default' });
    expect(parseAgentSwitch('/agent claude fix this')).toBeNull();
    expect(parseAgentSwitch('/agent')).toBeNull();
  });
  it('lets only the Primary Administrator switch; a served member gets the usage hint; default from others is ordinary text', () => {
    expect(routeTrigger(envelope({ text: '@Agent /agent codex', ...mention }), admin)).toEqual({ type: 'agent_provider', provider: 'codex' });
    expect(routeTrigger(envelope({ text: '@Agent /agent default', ...mention }), admin)).toEqual({ type: 'agent_provider', provider: 'default' });
    expect(routeTrigger(envelope({ text: '@Agent /agent claude', ...mention }), context)).toEqual({ type: 'agent_usage', provider: 'claude' });
    expect(routeTrigger(envelope({ text: '@Agent /agent default', ...mention }), context))
      .toEqual({ type: 'prompt', provider: 'codex', prompt: '/agent default' });
    expect(routeTrigger(envelope({ text: '@Agent /agent claude fix this', ...mention }), context)).toEqual({ type: 'prompt', provider: 'claude', prompt: 'fix this' });
  });
  it('direct chats: only a Primary Administrator switches, a whitelisted friend gets the hint', () => {
    const direct = envelope({ chatType: 'direct', text: '/agent claude', mentionIds: [], mentionRanges: [] });
    expect(routeTrigger(direct, { ...context, senderIsPrimaryAdmin: true, primaryAdmin: true })).toEqual({ type: 'agent_provider', provider: 'claude' });
    expect(routeTrigger(direct, { ...context, senderIsPrimaryAdmin: true, primaryAdmin: false })).toEqual({ type: 'agent_usage', provider: 'claude' });
    expect(routeTrigger(direct, { ...context, senderIsPrimaryAdmin: false })).toEqual({ type: 'ignore' });
  });
  it('free mode: the Primary Administrator may omit the mention, a member text stays a free-mode message', () => {
    const bare = envelope({ text: '/agent claude', mentionIds: [], mentionRanges: [] });
    expect(routeTrigger(bare, { ...admin, freeModeActive: true })).toEqual({ type: 'agent_provider', provider: 'claude' });
    expect(routeTrigger(bare, admin)).toEqual({ type: 'ignore' });
    expect(routeTrigger(bare, { ...context, freeModeActive: true })).toEqual({ type: 'free_message' });
  });
});

describe('provider quota system command', () => {
  const mention={mentionIds:['agent-mid'],mentionRanges:[{start:0,end:6,userId:'agent-mid'}]};
  it('routes bare /quota and /額度 without model or workspace admission',()=>{
    const direct=envelope({chatType:'direct',text:'/QuOtA',mentionIds:[],mentionRanges:[]});
    expect(routeTrigger(direct,{...context,senderIsPrimaryAdmin:true,primaryAdmin:true,workspaceConfigured:false})).toEqual({type:'agent_quota'});
    expect(routeTrigger(envelope({text:'@Agent /額度',...mention}),{...context,workspaceConfigured:false})).toEqual({type:'agent_quota'});
  });
  it('keeps direct and group sender/room gates',()=>{
    const direct=envelope({chatType:'direct',text:'/quota',mentionIds:[],mentionRanges:[]});
    expect(routeTrigger(direct,{...context,primaryAdmin:false,senderIsPrimaryAdmin:false})).toEqual({type:'ignore'});
    expect(routeTrigger(envelope({text:'@Agent /quota',...mention}),{...context,agentEnabled:false})).toEqual({type:'ignore'});
    expect(routeTrigger(envelope({text:'@Agent /quota',...mention}),{...context,agentEnabled:true})).toEqual({type:'agent_quota'});
    expect(routeTrigger(envelope({text:'@Agent /quota now',...mention}),context).type).not.toBe('agent_quota');
  });
});
