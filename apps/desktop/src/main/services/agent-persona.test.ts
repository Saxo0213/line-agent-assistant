import { describe, expect, it, vi } from 'vitest';
import type { InboundEnvelope } from '@line-agent/contracts';
import {
  buildFreeModeJudgePrompt, executePersonaCommand, personaFingerprint, personaPromptSection, readGlobalPersona, resolveEffectivePersona,
  type ConversationPersonaOverride, type PersonaSettingsWriter,
} from './agent-persona.js';
import { FREE_MODE_JUDGE_SYSTEM_PROMPT } from './free-mode-service.js';
import { isPersonaCommandText, parsePersonaCommand, routeTrigger } from './trigger-router.js';

const key = { accountId: 'a', chatType: 'group' as const, chatId: 'g' };
const fakeSettings = (app: Record<string, unknown> = {}, override: ConversationPersonaOverride | null = { description: null, liveliness: null }) => {
  const state = { override: override ? { ...override } : null };
  const settings: PersonaSettingsWriter = {
    async getAppSetting(name) { return app[name] ?? null; },
    async getConversationPersona() { return state.override; },
    async setConversationPersona(_key, patch) {
      if (!state.override) return false;
      state.override = { ...state.override, ...patch } as ConversationPersonaOverride;
      return true;
    },
  };
  return { settings, state };
};

describe('/persona parsing', () => {
  it.each([
    ['/persona', { type: 'persona', action: 'show' }],
    ['/PERSONA  ', { type: 'persona', action: 'show' }],
    ['/persona default', { type: 'persona', action: 'default' }],
    ['/persona DEFAULT', { type: 'persona', action: 'default' }],
    ['/persona 安靜', { type: 'persona', action: 'liveliness', liveliness: 'quiet' }],
    ['/persona 一般', { type: 'persona', action: 'liveliness', liveliness: 'normal' }],
    ['/persona 活潑', { type: 'persona', action: 'liveliness', liveliness: 'lively' }],
    ['/persona Quiet', { type: 'persona', action: 'liveliness', liveliness: 'quiet' }],
    ['/persona NORMAL', { type: 'persona', action: 'liveliness', liveliness: 'normal' }],
    ['/persona lively', { type: 'persona', action: 'liveliness', liveliness: 'lively' }],
    ['/persona 溫柔又愛開玩笑', { type: 'persona', action: 'description', description: '溫柔又愛開玩笑' }],
    ['/persona 活潑的小助理', { type: 'persona', action: 'description', description: '活潑的小助理' }],
    ['/persona 第一行\n第二行', { type: 'persona', action: 'description', description: '第一行\n第二行' }],
  ])('parses %j', (text, expected) => { expect(parsePersonaCommand(text)).toEqual(expected); });
  it('does not treat other text as a persona command', () => {
    expect(parsePersonaCommand('/personal')).toBeNull();
    expect(parsePersonaCommand('hello /persona')).toBeNull();
    expect(parsePersonaCommand('/free')).toBeNull();
  });
});

const envelope = (overrides: Partial<InboundEnvelope> = {}): InboundEnvelope => ({
  eventId: 'e1', accountId: 'a', chatType: 'group', chatId: 'g', senderId: 'user', messageId: 'm1',
  kind: 'text', text: '/persona 活潑', mentionIds: [], mentionRanges: [], replyToMessageId: null,
  ingestion: { source: 'live', cursor: null }, occurredAt: '2026-10-28T00:00:00.000Z', attachments: [], raw: {}, ...overrides,
});
const context = { ownMid: 'agent-mid', agentEnabled: false, senderIsPrimaryAdmin: false, workspaceConfigured: true, defaultProvider: 'claude' as const };

describe('/persona routing', () => {
  it('executes for the Primary Administrator with or without the Agent mention', () => {
    const admin = { ...context, senderIsPrimaryAdmin: true, primaryAdmin: true };
    expect(routeTrigger(envelope(), admin)).toEqual({ type: 'persona', action: 'liveliness', liveliness: 'lively' });
    const mentioned = envelope({ text: '@Agent /persona default', mentionIds: ['agent-mid'], mentionRanges: [{ start: 0, end: 6, userId: 'agent-mid' }] });
    expect(routeTrigger(mentioned, admin)).toEqual({ type: 'persona', action: 'default' });
    expect(isPersonaCommandText(mentioned, 'agent-mid')).toBe(true);
  });
  it('never executes for anyone else: ignored when free mode is off, a free-mode message when it is on', () => {
    expect(routeTrigger(envelope(), context)).toEqual({ type: 'ignore' });
    expect(routeTrigger(envelope(), { ...context, freeModeActive: true })).toEqual({ type: 'free_message' });
  });
  it('is not a command in a direct chat', () => {
    const direct = envelope({ chatType: 'direct', text: '/persona 活潑' });
    expect(routeTrigger(direct, { ...context, senderIsPrimaryAdmin: true, primaryAdmin: true }))
      .toEqual({ type: 'prompt', provider: 'claude', prompt: '/persona 活潑' });
    expect(isPersonaCommandText(direct, 'agent-mid')).toBe(false);
  });
});

describe('effective persona', () => {
  it('uses the global value when the chat has no override', async () => {
    const { settings } = fakeSettings({ agent_persona_description: ' 親切 ', agent_persona_liveliness: 'quiet' });
    expect(await resolveEffectivePersona(settings, key)).toEqual({ description: '親切', liveliness: 'quiet', descriptionSource: 'global', livelinessSource: 'global' });
  });
  it('lets a chat override each field on its own', async () => {
    const { settings } = fakeSettings({ agent_persona_description: '親切', agent_persona_liveliness: 'quiet' }, { description: null, liveliness: 'lively' });
    expect(await resolveEffectivePersona(settings, key)).toEqual({ description: '親切', liveliness: 'lively', descriptionSource: 'global', livelinessSource: 'chat' });
    const both = fakeSettings({ agent_persona_description: '親切' }, { description: '嚴肅', liveliness: 'lively' });
    expect(await resolveEffectivePersona(both.settings, key)).toMatchObject({ description: '嚴肅', descriptionSource: 'chat' });
  });
  it('uses only the global value in a 1:1 chat and falls back to a neutral normal default', async () => {
    const { settings } = fakeSettings({}, { description: '嚴肅', liveliness: 'lively' });
    expect(await resolveEffectivePersona(settings, { ...key, chatType: 'direct' as never })).toMatchObject({ description: '', liveliness: 'normal' });
    expect(await readGlobalPersona({ getAppSetting: async () => 'bogus' })).toEqual({ description: 'bogus', liveliness: 'normal' });
  });
});

describe('persona prompts', () => {
  it('adds a labeled style block that cannot change permissions, and nothing when blank', () => {
    const section = personaPromptSection('像貓咪一樣說話');
    expect(section).toContain('【語氣與風格設定】');
    expect(section).toContain('像貓咪一樣說話');
    expect(section).toMatch(/不能改變你的權限、可用工具或安全規則/);
    expect(personaPromptSection('')).toBe('');
    expect(personaPromptSection('   ')).toBe('');
  });
  it('changes the judge system prompt with the liveliness and leaves normal untouched', () => {
    const base = FREE_MODE_JUDGE_SYSTEM_PROMPT;
    expect(buildFreeModeJudgePrompt(base, { description: '', liveliness: 'normal' })).toBe(base);
    const quiet = buildFreeModeJudgePrompt(base, { description: '', liveliness: 'quiet' });
    const lively = buildFreeModeJudgePrompt(base, { description: '', liveliness: 'lively' });
    expect(quiet).toContain('回覆積極度：安靜');
    expect(quiet).toContain('閒聊、接話、感想、玩笑、單純附和一律判為 false');
    expect(lively).toContain('回覆積極度：活潑');
    expect(lively).toContain('不要連續插話太多次');
    expect(lively).toContain('urgency 仍維持 0 到 39');
    expect(new Set([base, quiet, lively]).size).toBe(3);
    expect(quiet.startsWith(base)).toBe(true);
    expect(buildFreeModeJudgePrompt(base, { description: '愛開玩笑', liveliness: 'normal' })).toContain('愛開玩笑');
  });
  it('fingerprints liveliness and description so a change starts a fresh judge session', () => {
    expect(personaFingerprint({ description: 'a', liveliness: 'quiet' })).not.toBe(personaFingerprint({ description: 'a', liveliness: 'lively' }));
    expect(personaFingerprint({ description: 'a', liveliness: 'quiet' })).not.toBe(personaFingerprint({ description: 'b', liveliness: 'quiet' }));
  });
});

describe('executePersonaCommand', () => {
  it('sets the description, then the liveliness, each only for the chat', async () => {
    const { settings, state } = fakeSettings();
    expect(await executePersonaCommand(settings, key, { type: 'persona', action: 'description', description: '溫柔' }, 'zh-TW')).toContain('溫柔');
    expect(state.override).toEqual({ description: '溫柔', liveliness: null });
    expect(await executePersonaCommand(settings, key, { type: 'persona', action: 'liveliness', liveliness: 'lively' }, 'zh-TW')).toContain('活潑');
    expect(state.override).toEqual({ description: '溫柔', liveliness: 'lively' });
  });
  it('shows the effective values and where each comes from, without ids', async () => {
    const { settings } = fakeSettings({ agent_persona_description: '全域風格' }, { description: null, liveliness: 'quiet' });
    const text = await executePersonaCommand(settings, key, { type: 'persona', action: 'show' }, 'zh-TW');
    expect(text).toContain('全域風格');
    expect(text).toContain('安靜');
    expect(text).toContain('預設');
    expect(text).toContain('此聊天室設定');
    expect(text).not.toMatch(/g\b.*a\b.*chatId/);
  });
  it('clears both overrides on default and reports a missing conversation or an over-long description', async () => {
    const { settings, state } = fakeSettings({}, { description: '舊', liveliness: 'quiet' });
    expect(await executePersonaCommand(settings, key, { type: 'persona', action: 'default' }, 'en')).toMatch(/default/i);
    expect(state.override).toEqual({ description: null, liveliness: null });
    const set = vi.spyOn(settings, 'setConversationPersona');
    expect(await executePersonaCommand(settings, key, { type: 'persona', action: 'description', description: 'x'.repeat(501) }, 'en')).toContain('500');
    expect(set).not.toHaveBeenCalled();
    const missing = fakeSettings({}, null).settings;
    expect(await executePersonaCommand(missing, key, { type: 'persona', action: 'liveliness', liveliness: 'quiet' }, 'en')).toMatch(/Could not/);
  });
});
