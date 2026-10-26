// @vitest-environment jsdom
// Existing workflow assertions explicitly exercise the retained Traditional Chinese catalog.
import React from 'react';
import desktopPackage from '../../../package.json' with { type: 'json' };
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render as renderBase, screen, waitFor, within } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import { URL as NodeURL } from 'node:url';
import { Settings } from './Settings.js';
import { readStoredSettingsTab, SETTINGS_TAB_KEY } from '../settings-tab-storage.js';
import type { DesktopApi } from '../../preload/api.js';
import { AGENT_PERMISSIONS, AgentStatusIconsSchema, DEFAULT_AGENT_STATUS_ICONS, type AgentStatusIcons, type LineAccountSummary } from '@line-agent/contracts';
import { LINE_REACTION_GLYPHS } from '../AgentStatusMarker.js';
import { LocaleProvider, type LocaleState } from '../locale-context.js';
import { desktopTextFor, extraTextFor } from '../desktop-i18n.js';

const desktopVersion = desktopPackage.version;
let testLocaleState: LocaleState = { status: 'loaded', effectiveLocale: 'zh-TW', preference: 'automatic', busy: false, error: null, restartChoice: false, restartPending: false, retry: vi.fn(), retryRestart: vi.fn(), restartNow: vi.fn(), restartLater: vi.fn(), setPreference: vi.fn() };
beforeEach(() => { testLocaleState = { status: 'loaded', effectiveLocale: 'zh-TW', preference: 'automatic', busy: false, error: null, restartChoice: false, restartPending: false, retry: vi.fn(), retryRestart: vi.fn(), restartNow: vi.fn(), restartLater: vi.fn(), setPreference: vi.fn() }; });
function render(ui: React.ReactElement) {
  const result = renderBase(<LocaleProvider value={testLocaleState}>{ui}</LocaleProvider>);
  return { ...result, rerender: (next: React.ReactElement) => result.rerender(<LocaleProvider value={testLocaleState}>{next}</LocaleProvider>) };
}

function renderWithStartupLocale(ui: React.ReactElement, locale: LocaleState['effectiveLocale']) {
  testLocaleState = { ...testLocaleState, effectiveLocale: locale };
  return render(ui);
}

async function editFallback(card: ReturnType<typeof within>, value: string) {
  fireEvent.click(card.getByRole('button', { name: '編輯預設回覆' }));
  const dialog = screen.getByRole('dialog', { name: '編輯預設回覆' });
  fireEvent.change(within(dialog).getByLabelText('回覆訊息'), { target: { value } });
  fireEvent.click(within(dialog).getByRole('button', { name: '確定' }));
}

function createAutoResponderApi(initial: { version: number; displayName: string; fallback: string; rules: Array<{ trigger: string; reply: string }> }) {
  let saved = structuredClone(initial);
  const api = {
    getDatabaseSetupStatus: vi.fn(async () => ({ configured: true, attachmentRoot: null, agentWorkspace: null, connection: null })),
    getConversationSettings: vi.fn(async () => ({ attachmentAutoAttemptLimit: 3, showAgentStatusMarkers: true, agentStatusIcons: { ...DEFAULT_AGENT_STATUS_ICONS } })),
    getAutoResponderSettings: vi.fn(async () => structuredClone(saved)),
    setAutoResponderSettings: vi.fn(async (expectedVersion: number, input: Omit<typeof saved, 'version'>) => {
      if (expectedVersion !== saved.version) return { type: 'error', requestId: 'save', ok: false, code: 'AUTORESPONDER_VERSION_CONFLICT', message: 'conflict' } as const;
      saved = { ...structuredClone(input), version: expectedVersion + 1 };
      return { type: 'setAutoResponderSettings', requestId: 'save', ok: true, version: saved.version } as const;
    }),
  } as unknown as DesktopApi;
  return { api, getSaved: () => structuredClone(saved) };
}

afterEach(() => { cleanup(); document.querySelectorAll('[data-settings-layout-test]').forEach((style) => style.remove()); vi.unstubAllGlobals(); });

describe('system language setting', () => {
  beforeEach(() => {
    testLocaleState = { status: 'loaded', effectiveLocale: 'en', preference: 'automatic', busy: false, error: null, retry: vi.fn(), retryRestart: vi.fn(), setPreference: vi.fn() };
  });

  it('renders the effective locale and selected preference from the startup provider', () => {
    testLocaleState = { ...testLocaleState, effectiveLocale: 'ja', preference: 'ko' };
    const api = { getDatabaseSetupStatus: vi.fn(async () => ({ configured: false, attachmentRoot: null, agentWorkspace: null, connection: null })) } as unknown as DesktopApi;
    render(<Settings api={api} headingRef={React.createRef()} />);
    expect(screen.getByRole('heading', { name: 'システム設定' })).toBeTruthy();
    expect((screen.getByRole('combobox', { name: '言語' }) as HTMLSelectElement).value).toBe('ko');
    expect(screen.getByText('現在の言語: 日本語')).toBeTruthy();
    expect(api.getLocale).toBeUndefined();
  });

  it.each([
    ['en', 'Unsend message', 'One hour (default)', 'Seven days'],
    ['zh-TW', '收回訊息', '一小時（預設）', '七天'],
    ['ja', 'メッセージの送信取消', '1時間（デフォルト）', '7日間'],
    ['ko', '메시지 보내기 취소', '1시간(기본값)', '7일'],
  ] as const)('loads and persists the mutually exclusive unsend window choices in %s', async (locale, label, oneHourLabel, sevenDaysLabel) => {
    const api = {
      getDatabaseSetupStatus: vi.fn(async () => ({ configured: false, attachmentRoot: null, agentWorkspace: null, connection: null })),
      getManualUnsendWindow: vi.fn(async () => '7d' as const),
      setManualUnsendWindow: vi.fn(async (value: '1h' | '7d') => value),
    } as unknown as DesktopApi;
    renderWithStartupLocale(<Settings api={api} headingRef={React.createRef()} />, locale);
    const choices = await screen.findByRole('group', { name: label });
    const oneHour = within(choices).getByRole('radio', { name: oneHourLabel }) as HTMLInputElement;
    const sevenDays = within(choices).getByRole('radio', { name: sevenDaysLabel }) as HTMLInputElement;
    const systemSettingsCard = document.querySelector('section.locale-settings');
    expect(systemSettingsCard?.contains(choices)).toBe(true);
    await waitFor(() => expect(sevenDays.checked).toBe(true));
    expect(oneHour.checked).toBe(false);
    fireEvent.click(oneHour);
    await waitFor(() => expect(api.setManualUnsendWindow).toHaveBeenCalledWith('1h'));
    await waitFor(() => expect(oneHour.checked).toBe(true));
    expect(sevenDays.checked).toBe(false);
  });

  it('forwards validated selector choices to the locale owner', () => {
    const setPreference = vi.fn();
    testLocaleState = { ...testLocaleState, setPreference };
    const api = { getDatabaseSetupStatus: vi.fn(async () => ({ configured: false, attachmentRoot: null, agentWorkspace: null, connection: null })) } as unknown as DesktopApi;
    render(<Settings api={api} headingRef={React.createRef()} />);
    fireEvent.change(screen.getByRole('combobox', { name: 'Language' }), { target: { value: 'ja' } });
    expect(setPreference).toHaveBeenCalledWith('ja');
    expect(api.getLocale).toBeUndefined();
  });

  it.each([
    ['en', 'System Settings', 'System', 'Language', 'Current language: English'],
    ['zh-TW', '系統設定', '系統', '語言', '目前語言: 繁體中文'],
  ] as const)('renders Settings copy in %s', (effectiveLocale, title, systemTab, language, effectiveLabel) => {
    testLocaleState = { ...testLocaleState, effectiveLocale, preference: 'automatic' };
    const api = { getDatabaseSetupStatus: vi.fn(async () => ({ configured: false, attachmentRoot: null, agentWorkspace: null, connection: null })) } as unknown as DesktopApi;
    render(<Settings api={api} headingRef={React.createRef()} />);
    expect(screen.getByRole('heading', { name: title })).toBeTruthy();
    expect(screen.getByRole('tab', { name: systemTab })).toBeTruthy();
    expect(screen.getByRole('combobox', { name: language })).toBeTruthy();
    expect(screen.getByText(effectiveLabel)).toBeTruthy();
  });

  it('keeps visible copy on the startup locale after the saved preference changes', () => {
    testLocaleState = { ...testLocaleState, effectiveLocale: 'en', preference: 'automatic' };
    const api = { getDatabaseSetupStatus: vi.fn(async () => ({ configured: false, attachmentRoot: null, agentWorkspace: null, connection: null })) } as unknown as DesktopApi;
    const view = render(<Settings api={api} headingRef={React.createRef()} />);
    fireEvent.change(screen.getByRole('combobox', { name: 'Language' }), { target: { value: 'zh-TW' } });
    testLocaleState = { ...testLocaleState, preference: 'zh-TW' };
    view.rerender(<Settings api={api} headingRef={React.createRef()} />);
    expect((screen.getByRole('combobox', { name: 'Language' }) as HTMLSelectElement).value).toBe('zh-TW');
    expect(screen.getByRole('heading', { name: 'System Settings' })).toBeTruthy();
    expect(screen.getByRole('combobox', { name: 'Language' })).toBeTruthy();
    expect(screen.getByText('Current language: English')).toBeTruthy();
  });

  it('opens a focused accessible restart dialog and leaves a restart action visible after Later', () => {
    const restartNow = vi.fn();
    const restartLater = vi.fn();
    const retryRestart = vi.fn();
    testLocaleState = { ...testLocaleState, effectiveLocale: 'en', preference: 'automatic', restartNow, restartLater, retryRestart };
    const api = { getDatabaseSetupStatus: vi.fn(async () => ({ configured: false, attachmentRoot: null, agentWorkspace: null, connection: null })) } as unknown as DesktopApi;
    const view = render(<Settings api={api} headingRef={React.createRef()} />);
    const language = screen.getByRole('combobox', { name: 'Language' });
    fireEvent.change(language, { target: { value: 'ja' } });
    testLocaleState = { ...testLocaleState, preference: 'ja', restartChoice: true, restartPending: true };
    view.rerender(<Settings api={api} headingRef={React.createRef()} />);
    const choice = screen.getByRole('alertdialog', { name: 'Restart the application now to apply the saved language?' });
    expect(document.activeElement).toBe(within(choice).getByRole('button', { name: 'Later' }));
    fireEvent.click(within(choice).getByRole('button', { name: 'Later' }));
    expect(restartLater).toHaveBeenCalledOnce();
    testLocaleState = { ...testLocaleState, restartChoice: false };
    view.rerender(<Settings api={api} headingRef={React.createRef()} />);
    expect(document.activeElement).toBe(screen.getByRole('combobox', { name: 'Language' }));
    expect(screen.getByRole('status').textContent).toContain('Language saved. Restart the application to apply it.');
    fireEvent.click(screen.getByRole('button', { name: 'Restart now' }));
    expect(retryRestart).toHaveBeenCalledOnce();
    expect(screen.getByText('Current language: English')).toBeTruthy();
    expect((screen.getByRole('combobox', { name: 'Language' }) as HTMLSelectElement).value).toBe('ja');
  });
});

describe('immediate autoresponder persistence', () => {
  const open = async (api: DesktopApi) => {
    render(<Settings api={api} headingRef={React.createRef()} accounts={[]} />);
    fireEvent.click(screen.getByRole('tab', { name: '對話' }));
    await screen.findByRole('heading', { name: /自動回覆/ });
    return within(document.querySelector('.autoresponder-settings') as HTMLElement);
  };

  it('persists add, edit, delete, and default reply changes immediately and reloads saved settings', async () => {
    const { api, getSaved } = createAutoResponderApi({ version: 1, displayName: 'Helper', fallback: 'default', rules: [{ trigger: 'hello', reply: 'Hi' }] });
    const card = await open(api);
    expect(card.queryByRole('button', { name: '儲存' })).toBeNull();

    fireEvent.click(card.getByRole('button', { name: '新增規則' }));
    let dialog = screen.getByRole('dialog', { name: '新增規則' });
    fireEvent.change(within(dialog).getByLabelText('觸發詞'), { target: { value: 'bye' } });
    fireEvent.change(within(dialog).getByLabelText('回覆訊息'), { target: { value: 'Goodbye' } });
    fireEvent.click(within(dialog).getByRole('button', { name: '確定' }));
    await waitFor(() => expect(getSaved().rules).toEqual([{ trigger: 'hello', reply: 'Hi' }, { trigger: 'bye', reply: 'Goodbye' }]));
    expect(api.getAutoResponderSettings).toHaveBeenCalledTimes(2);

    fireEvent.click(card.getByRole('button', { name: '編輯規則 2' }));
    dialog = screen.getByRole('dialog', { name: '編輯規則' });
    fireEvent.change(within(dialog).getByLabelText('回覆訊息'), { target: { value: 'See you' } });
    fireEvent.click(within(dialog).getByRole('button', { name: '確定' }));
    await waitFor(() => expect(getSaved().rules[1]).toEqual({ trigger: 'bye', reply: 'See you' }));

    await editFallback(card, 'new default');
    await waitFor(() => expect(getSaved().fallback).toBe('new default'));

    fireEvent.click(card.getByRole('button', { name: '刪除規則 1' }));
    await waitFor(() => expect(getSaved().rules).toEqual([{ trigger: 'bye', reply: 'See you' }]));
    expect(api.setAutoResponderSettings).toHaveBeenCalledTimes(4);
    expect(api.getAutoResponderSettings).toHaveBeenCalledTimes(5);
  });

  it('cancels or overwrites a normalized duplicate trigger while keeping one matching rule', async () => {
    const { api, getSaved } = createAutoResponderApi({ version: 4, displayName: 'Helper', fallback: 'default', rules: [{ trigger: 'hello', reply: 'old' }] });
    const card = await open(api);
    const addDuplicate = () => {
      fireEvent.click(card.getByRole('button', { name: '新增規則' }));
      const dialog = screen.getByRole('dialog', { name: '新增規則' });
      fireEvent.change(within(dialog).getByLabelText('觸發詞'), { target: { value: ' hello  ' } });
      fireEvent.change(within(dialog).getByLabelText('回覆訊息'), { target: { value: 'new' } });
      fireEvent.click(within(dialog).getByRole('button', { name: '確定' }));
    };
    addDuplicate();
    let dialog = screen.getByRole('dialog', { name: '新增規則' });
    expect(within(dialog).getByRole('button', { name: '覆蓋' })).toBeTruthy();
    fireEvent.click(within(dialog).getByRole('button', { name: '確定' }));
    expect(api.setAutoResponderSettings).not.toHaveBeenCalled();
    fireEvent.click(within(dialog).getByRole('button', { name: '取消' }));
    expect(api.setAutoResponderSettings).not.toHaveBeenCalled();
    expect(getSaved().rules).toEqual([{ trigger: 'hello', reply: 'old' }]);

    addDuplicate();
    dialog = screen.getByRole('dialog', { name: '新增規則' });
    fireEvent.click(within(dialog).getByRole('button', { name: '覆蓋' }));
    await waitFor(() => expect(getSaved().rules).toEqual([{ trigger: 'hello', reply: 'new' }]));
    expect(api.setAutoResponderSettings).toHaveBeenCalledTimes(1);

    fireEvent.click(card.getByRole('button', { name: '新增規則' }));
    dialog = screen.getByRole('dialog', { name: '新增規則' });
    fireEvent.change(within(dialog).getByLabelText('觸發詞'), { target: { value: 'bye' } });
    fireEvent.change(within(dialog).getByLabelText('回覆訊息'), { target: { value: 'later' } });
    fireEvent.click(within(dialog).getByRole('button', { name: '確定' }));
    await waitFor(() => expect(getSaved().rules).toHaveLength(2));
    fireEvent.click(card.getByRole('button', { name: '編輯規則 2' }));
    dialog = screen.getByRole('dialog', { name: '編輯規則' });
    fireEvent.change(within(dialog).getByLabelText('觸發詞'), { target: { value: ' hello ' } });
    fireEvent.change(within(dialog).getByLabelText('回覆訊息'), { target: { value: 'edited replacement' } });
    fireEvent.click(within(dialog).getByRole('button', { name: '確定' }));
    fireEvent.click(within(dialog).getByRole('button', { name: '覆蓋' }));
    await waitFor(() => expect(getSaved().rules).toEqual([{ trigger: 'hello', reply: 'edited replacement' }]));
  });

  it('prompts for any duplicate normalized trigger, even when both replies match', async () => {
    const { api } = createAutoResponderApi({ version: 1, displayName: 'Helper', fallback: 'default', rules: [{ trigger: 'hello', reply: 'same' }] });
    const card = await open(api);
    fireEvent.click(card.getByRole('button', { name: '新增規則' }));
    const dialog = screen.getByRole('dialog', { name: '新增規則' });
    fireEvent.change(within(dialog).getByLabelText('觸發詞'), { target: { value: ' hello ' } });
    fireEvent.change(within(dialog).getByLabelText('回覆訊息'), { target: { value: 'same' } });
    fireEvent.click(within(dialog).getByRole('button', { name: '確定' }));
    expect(within(dialog).getByRole('button', { name: '覆蓋' })).toBeTruthy();
    expect(api.setAutoResponderSettings).not.toHaveBeenCalled();
  });

  it('rechecks the duplicate target after a version conflict before overwriting', async () => {
    const initial = { version: 1, displayName: 'Helper', fallback: 'default', rules: [
      { trigger: 'source', reply: 'source reply' }, { trigger: 'target', reply: 'target reply' },
    ] };
    const latest = { version: 2, displayName: 'Helper', fallback: 'default', rules: [
      { trigger: 'remote', reply: 'remote reply' }, { trigger: 'source', reply: 'source reply' },
    ] };
    let readCount = 0;
    const api = {
      getDatabaseSetupStatus: vi.fn(async () => ({ configured: true, attachmentRoot: null, agentWorkspace: null, connection: null })),
      getConversationSettings: vi.fn(async () => ({ attachmentAutoAttemptLimit: 3, showAgentStatusMarkers: true, agentStatusIcons: { ...DEFAULT_AGENT_STATUS_ICONS } })),
      getAutoResponderSettings: vi.fn(async () => readCount++ === 0 ? initial : latest),
      setAutoResponderSettings: vi.fn()
        .mockResolvedValueOnce({ type: 'error', requestId: 'save', ok: false, code: 'AUTORESPONDER_VERSION_CONFLICT', message: 'conflict' })
        .mockResolvedValueOnce({ type: 'setAutoResponderSettings', requestId: 'retry', ok: true, version: 3 }),
    } as unknown as DesktopApi;
    const card = await open(api);
    fireEvent.click(card.getByRole('button', { name: '編輯規則 1' }));
    const dialog = screen.getByRole('dialog', { name: '編輯規則' });
    fireEvent.change(within(dialog).getByLabelText('觸發詞'), { target: { value: 'target' } });
    fireEvent.change(within(dialog).getByLabelText('回覆訊息'), { target: { value: 'replacement' } });
    fireEvent.click(within(dialog).getByRole('button', { name: '確定' }));
    fireEvent.click(within(dialog).getByRole('button', { name: '覆蓋' }));
    expect((await within(dialog).findByRole('alert')).textContent).toBe('設定已在其他地方變更，已重新載入');
    expect(within(dialog).queryByRole('button', { name: '覆蓋' })).toBeNull();
    fireEvent.click(within(dialog).getByRole('button', { name: '確定' }));
    await waitFor(() => expect(api.setAutoResponderSettings).toHaveBeenLastCalledWith(2, {
      displayName: 'Helper', fallback: 'default', rules: [
        { trigger: 'remote', reply: 'remote reply' }, { trigger: 'target', reply: 'replacement' },
      ],
    }));
  });

  it('keeps the draft when its source was deleted remotely and requires explicit recreation', async () => {
    const initial = { version: 1, displayName: 'Helper', fallback: 'default', rules: [
      { trigger: 'source', reply: 'old' }, { trigger: 'target', reply: 'target reply' },
    ] };
    const latest = { version: 2, displayName: 'Helper', fallback: 'default', rules: [{ trigger: 'remote', reply: 'remote reply' }] };
    let readCount = 0;
    const api = {
      getDatabaseSetupStatus: vi.fn(async () => ({ configured: true, attachmentRoot: null, agentWorkspace: null, connection: null })),
      getConversationSettings: vi.fn(async () => ({ attachmentAutoAttemptLimit: 3, showAgentStatusMarkers: true, agentStatusIcons: { ...DEFAULT_AGENT_STATUS_ICONS } })),
      getAutoResponderSettings: vi.fn(async () => readCount++ === 0 ? initial : latest),
      setAutoResponderSettings: vi.fn()
        .mockResolvedValueOnce({ type: 'error', requestId: 'save', ok: false, code: 'AUTORESPONDER_VERSION_CONFLICT', message: 'conflict' })
        .mockResolvedValueOnce({ type: 'setAutoResponderSettings', requestId: 'retry', ok: true, version: 3 }),
    } as unknown as DesktopApi;
    const card = await open(api);
    fireEvent.click(card.getByRole('button', { name: '編輯規則 1' }));
    let dialog = screen.getByRole('dialog', { name: '編輯規則' });
    fireEvent.change(within(dialog).getByLabelText('回覆訊息'), { target: { value: 'kept draft' } });
    fireEvent.click(within(dialog).getByRole('button', { name: '確定' }));
    expect((await within(dialog).findByRole('alert')).textContent).toBe('設定已在其他地方變更，已重新載入');
    expect(within(dialog).getByText(/這條規則已在其他地方刪除/)).toBeTruthy();
    expect(within(dialog).getByLabelText('回覆訊息')).toHaveProperty('value', 'kept draft');
    expect(within(dialog).getByRole('button', { name: '確定' })).toHaveProperty('disabled', true);
    expect(api.setAutoResponderSettings).toHaveBeenCalledTimes(1);
    fireEvent.click(within(dialog).getByRole('button', { name: '改為新增規則' }));
    fireEvent.click(within(dialog).getByRole('button', { name: '確定' }));
    await waitFor(() => expect(api.setAutoResponderSettings).toHaveBeenLastCalledWith(2, {
      displayName: 'Helper', fallback: 'default', rules: [
        { trigger: 'remote', reply: 'remote reply' }, { trigger: 'source', reply: 'kept draft' },
      ],
    }));
  });

  it('preserves create-from-draft mode through duplicate overwrite after the source was deleted', async () => {
    const initial = { version: 1, displayName: 'Helper', fallback: 'default', rules: [{ trigger: 'source', reply: 'old' }] };
    const latest = { version: 2, displayName: 'Helper', fallback: 'default', rules: [{ trigger: 'target', reply: 'remote target' }] };
    let readCount = 0;
    const api = {
      getDatabaseSetupStatus: vi.fn(async () => ({ configured: true, attachmentRoot: null, agentWorkspace: null, connection: null })),
      getConversationSettings: vi.fn(async () => ({ attachmentAutoAttemptLimit: 3, showAgentStatusMarkers: true, agentStatusIcons: { ...DEFAULT_AGENT_STATUS_ICONS } })),
      getAutoResponderSettings: vi.fn(async () => readCount++ === 0 ? initial : latest),
      setAutoResponderSettings: vi.fn()
        .mockResolvedValueOnce({ type: 'error', requestId: 'save', ok: false, code: 'AUTORESPONDER_VERSION_CONFLICT', message: 'conflict' })
        .mockResolvedValueOnce({ type: 'setAutoResponderSettings', requestId: 'retry', ok: true, version: 3 }),
    } as unknown as DesktopApi;
    const card = await open(api);
    fireEvent.click(card.getByRole('button', { name: '編輯規則 1' }));
    const dialog = screen.getByRole('dialog', { name: '編輯規則' });
    fireEvent.change(within(dialog).getByLabelText('觸發詞'), { target: { value: 'target' } });
    fireEvent.change(within(dialog).getByLabelText('回覆訊息'), { target: { value: 'draft replacement' } });
    fireEvent.click(within(dialog).getByRole('button', { name: '確定' }));
    expect((await within(dialog).findByRole('alert')).textContent).toBe('設定已在其他地方變更，已重新載入');
    expect(within(dialog).getByText(/這條規則已在其他地方刪除/)).toBeTruthy();
    fireEvent.click(within(dialog).getByRole('button', { name: '改為新增規則' }));
    fireEvent.click(within(dialog).getByRole('button', { name: '確定' }));
    expect(within(dialog).getByRole('button', { name: '覆蓋' })).toBeTruthy();
    fireEvent.click(within(dialog).getByRole('button', { name: '覆蓋' }));
    await waitFor(() => expect(api.setAutoResponderSettings).toHaveBeenLastCalledWith(2, {
      displayName: 'Helper', fallback: 'default', rules: [{ trigger: 'target', reply: 'draft replacement' }],
    }));
  });

  it('requires explicit recovery when a tab refresh removes the edited source', async () => {
    const initial = { version: 1, displayName: 'Helper', fallback: 'default', rules: [{ trigger: 'source', reply: 'old' }] };
    const latest = { version: 2, displayName: 'Helper', fallback: 'default', rules: [{ trigger: 'remote', reply: 'remote value' }] };
    let readCount = 0;
    const api = {
      getDatabaseSetupStatus: vi.fn(async () => ({ configured: true, attachmentRoot: null, agentWorkspace: null, connection: null })),
      getConversationSettings: vi.fn(async () => ({ attachmentAutoAttemptLimit: 3, showAgentStatusMarkers: true, agentStatusIcons: { ...DEFAULT_AGENT_STATUS_ICONS } })),
      getAutoResponderSettings: vi.fn(async () => readCount++ === 0 ? initial : latest),
      setAutoResponderSettings: vi.fn(async () => ({ type: 'setAutoResponderSettings', requestId: 'save', ok: true, version: 3 })),
    } as unknown as DesktopApi;
    const card = await open(api);
    fireEvent.click(card.getByRole('button', { name: '編輯規則 1' }));
    let dialog = screen.getByRole('dialog', { name: '編輯規則' });
    fireEvent.change(within(dialog).getByLabelText('回覆訊息'), { target: { value: 'retained draft' } });
    fireEvent.click(screen.getByRole('tab', { name: '助理' }));
    await waitFor(() => expect(api.getAutoResponderSettings).toHaveBeenCalledTimes(1));
    fireEvent.click(screen.getByRole('tab', { name: '對話' }));
    dialog = await screen.findByRole('dialog', { name: '規則已不存在' });
    expect(within(dialog).getByLabelText('回覆訊息')).toHaveProperty('value', 'retained draft');
    expect(within(dialog).getByRole('button', { name: '確定' })).toHaveProperty('disabled', true);
    expect(api.setAutoResponderSettings).not.toHaveBeenCalled();
    fireEvent.click(within(dialog).getByRole('button', { name: '改為新增規則' }));
    fireEvent.click(within(dialog).getByRole('button', { name: '確定' }));
    await waitFor(() => expect(api.setAutoResponderSettings).toHaveBeenCalledWith(2, {
      displayName: 'Helper', fallback: 'default', rules: [
        { trigger: 'remote', reply: 'remote value' }, { trigger: 'source', reply: 'retained draft' },
      ],
    }));
  });

  it('invalidates duplicate confirmation after a second conflict but keeps recreate mode and remote rows', async () => {
    const initial = { version: 1, displayName: 'Helper', fallback: 'default', rules: [{ trigger: 'source', reply: 'old' }] };
    const afterFirstConflict = { version: 2, displayName: 'Helper', fallback: 'default', rules: [
      { trigger: 'target', reply: 'remote target' }, { trigger: 'remote-one', reply: 'one' },
    ] };
    const afterSecondConflict = { version: 3, displayName: 'Helper', fallback: 'default', rules: [
      { trigger: 'remote-two', reply: 'two' }, { trigger: 'target', reply: 'newest target' },
    ] };
    let readCount = 0;
    let saved = afterSecondConflict;
    const api = {
      getDatabaseSetupStatus: vi.fn(async () => ({ configured: true, attachmentRoot: null, agentWorkspace: null, connection: null })),
      getConversationSettings: vi.fn(async () => ({ attachmentAutoAttemptLimit: 3, showAgentStatusMarkers: true, agentStatusIcons: { ...DEFAULT_AGENT_STATUS_ICONS } })),
      getAutoResponderSettings: vi.fn(async () => {
        readCount++;
        if (readCount === 1) return initial;
        if (readCount === 2) return afterFirstConflict;
        if (readCount === 3) return afterSecondConflict;
        return saved;
      }),
      setAutoResponderSettings: vi.fn()
        .mockResolvedValueOnce({ type: 'error', requestId: 'first', ok: false, code: 'AUTORESPONDER_VERSION_CONFLICT', message: 'conflict' })
        .mockResolvedValueOnce({ type: 'error', requestId: 'second', ok: false, code: 'AUTORESPONDER_VERSION_CONFLICT', message: 'conflict' })
        .mockImplementationOnce(async (version: number, input: Omit<typeof initial, 'version'>) => {
          saved = { ...structuredClone(input), version: version + 1 };
          return { type: 'setAutoResponderSettings', requestId: 'third', ok: true, version: saved.version };
        }),
    } as unknown as DesktopApi;
    const card = await open(api);
    fireEvent.click(card.getByRole('button', { name: '編輯規則 1' }));
    let dialog = screen.getByRole('dialog', { name: '編輯規則' });
    fireEvent.change(within(dialog).getByLabelText('觸發詞'), { target: { value: 'target' } });
    fireEvent.change(within(dialog).getByLabelText('回覆訊息'), { target: { value: 'draft replacement' } });
    fireEvent.click(within(dialog).getByRole('button', { name: '確定' }));
    expect((await within(dialog).findByRole('alert')).textContent).toBe('設定已在其他地方變更，已重新載入');
    fireEvent.click(within(dialog).getByRole('button', { name: '改為新增規則' }));
    fireEvent.click(within(dialog).getByRole('button', { name: '確定' }));
    fireEvent.click(within(dialog).getByRole('button', { name: '覆蓋' }));
    expect((await within(dialog).findByRole('alert')).textContent).toBe('設定已在其他地方變更，已重新載入');
    expect(within(dialog).queryByRole('button', { name: '覆蓋' })).toBeNull();
    expect(within(dialog).getByRole('heading', { name: '新增規則' })).toBeTruthy();
    expect(within(dialog).getByLabelText('回覆訊息')).toHaveProperty('value', 'draft replacement');
    fireEvent.click(within(dialog).getByRole('button', { name: '確定' }));
    expect(within(dialog).getByRole('button', { name: '覆蓋' })).toBeTruthy();
    fireEvent.click(within(dialog).getByRole('button', { name: '覆蓋' }));
    await waitFor(() => expect(api.setAutoResponderSettings).toHaveBeenLastCalledWith(3, {
      displayName: 'Helper', fallback: 'default', rules: [
        { trigger: 'remote-two', reply: 'two' }, { trigger: 'target', reply: 'draft replacement' },
      ],
    }));
    await waitFor(() => expect(saved.version).toBe(4));
  });

  it('does not close the draft on Escape while a save is pending, including after rejection', async () => {
    const { api } = createAutoResponderApi({ version: 1, displayName: 'Helper', fallback: 'default', rules: [] });
    let rejectSave!: (error: Error) => void;
    (api.setAutoResponderSettings as ReturnType<typeof vi.fn>).mockImplementationOnce(() => new Promise((_resolve, reject) => { rejectSave = reject; }));
    const card = await open(api);
    fireEvent.click(card.getByRole('button', { name: '新增規則' }));
    const dialog = screen.getByRole('dialog', { name: '新增規則' });
    fireEvent.change(within(dialog).getByLabelText('觸發詞'), { target: { value: 'pending' } });
    fireEvent.change(within(dialog).getByLabelText('回覆訊息'), { target: { value: 'preserve me' } });
    fireEvent.click(within(dialog).getByRole('button', { name: '確定' }));
    await waitFor(() => expect(api.setAutoResponderSettings).toHaveBeenCalledTimes(1));
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.getByRole('dialog', { name: '新增規則' })).toBeTruthy();
    await act(async () => { rejectSave(new Error('temporary failure')); });
    expect((await within(dialog).findByRole('alert')).textContent).toContain('無法儲存自動回覆設定');
    expect(within(dialog).getByLabelText('觸發詞')).toHaveProperty('value', 'pending');
    expect(within(dialog).getByLabelText('回覆訊息')).toHaveProperty('value', 'preserve me');
  });

  it('keeps modal focus trapped while adding a duplicate confirmation action', async () => {
    const { api } = createAutoResponderApi({ version: 1, displayName: 'Helper', fallback: 'default', rules: [{ trigger: 'hello', reply: 'old' }] });
    const card = await open(api);
    fireEvent.click(card.getByRole('button', { name: '新增規則' }));
    let dialog = screen.getByRole('dialog', { name: '新增規則' });
    const trigger = within(dialog).getByLabelText('觸發詞');
    const reply = within(dialog).getByLabelText('回覆訊息');
    expect(document.activeElement).toBe(trigger);
    fireEvent.change(trigger, { target: { value: ' hello ' } });
    fireEvent.change(reply, { target: { value: 'new' } });
    fireEvent.click(within(dialog).getByRole('button', { name: '確定' }));
    dialog = screen.getByRole('dialog', { name: '新增規則' });
    expect(within(dialog).getByRole('button', { name: '覆蓋' })).toBeTruthy();
    const confirm = within(dialog).getByRole('button', { name: '確定' });
    confirm.focus();
    fireEvent.keyDown(confirm, { key: 'Tab' });
    expect(document.activeElement).toBe(trigger);
    fireEvent.keyDown(trigger, { key: 'Tab', shiftKey: true });
    expect(document.activeElement).toBe(confirm);
  });

  it('ignores a stale settings read that resolves after a save completes', async () => {
    const initial = { version: 1, displayName: 'Helper', fallback: 'initial', rules: [] };
    let saved = initial;
    let readCount = 0;
    let finishStaleLoad!: (settings: typeof initial) => void;
    let finishSave!: (result: { type: 'setAutoResponderSettings'; requestId: string; ok: true; version: number }) => void;
    const api = {
      getDatabaseSetupStatus: vi.fn(async () => ({ configured: true, attachmentRoot: null, agentWorkspace: null, connection: null })),
      getConversationSettings: vi.fn(async () => ({ attachmentAutoAttemptLimit: 3, showAgentStatusMarkers: true, agentStatusIcons: { ...DEFAULT_AGENT_STATUS_ICONS } })),
      getAutoResponderSettings: vi.fn(() => {
        readCount++;
        if (readCount === 1) return Promise.resolve(initial);
        if (readCount === 2) return new Promise<typeof initial>((resolve) => { finishStaleLoad = resolve; });
        return Promise.resolve(saved);
      }),
      setAutoResponderSettings: vi.fn((_version: number, input: Omit<typeof initial, 'version'>) => {
        saved = { ...structuredClone(input), version: 2 };
        return new Promise((resolve) => { finishSave = resolve; });
      }),
    } as unknown as DesktopApi;
    const card = await open(api);
    await editFallback(card, 'saved');
    await waitFor(() => expect(api.setAutoResponderSettings).toHaveBeenCalledTimes(1));
    fireEvent.click(screen.getByRole('tab', { name: '助理' }));
    fireEvent.click(screen.getByRole('tab', { name: '對話' }));
    await waitFor(() => expect(api.getAutoResponderSettings).toHaveBeenCalledTimes(2));
    await act(async () => { finishSave({ type: 'setAutoResponderSettings', requestId: 'save', ok: true, version: 2 }); });
    await screen.findByText('saved');
    await act(async () => { finishStaleLoad(initial); });
    expect(document.querySelector('.autoresponder-rule-table')?.textContent).toContain('saved');
    expect(document.querySelector('.autoresponder-rule-table')?.textContent).not.toContain('initial');
  });

  it('does not write when the reply text is unchanged', async () => {
    const { api } = createAutoResponderApi({ version: 1, displayName: 'Helper', fallback: 'default', rules: [{ trigger: 'hello', reply: 'same' }] });
    const card = await open(api);
    fireEvent.click(card.getByRole('button', { name: '編輯預設回覆' }));
    const dialog = screen.getByRole('dialog', { name: '編輯預設回覆' });
    fireEvent.change(within(dialog).getByLabelText('回覆訊息'), { target: { value: 'default' } });
    fireEvent.click(within(dialog).getByRole('button', { name: '確定' }));
    expect(api.setAutoResponderSettings).not.toHaveBeenCalled();

    fireEvent.click(card.getByRole('button', { name: '編輯規則 1' }));
    const ruleDialog = screen.getByRole('dialog', { name: '編輯規則' });
    fireEvent.change(within(ruleDialog).getByLabelText('觸發詞'), { target: { value: ' hello ' } });
    fireEvent.change(within(ruleDialog).getByLabelText('回覆訊息'), { target: { value: 'same' } });
    fireEvent.click(within(ruleDialog).getByRole('button', { name: '確定' }));
    expect(api.setAutoResponderSettings).not.toHaveBeenCalled();
  });

  it('keeps the dialog draft and saved list after an IPC error', async () => {
    const { api } = createAutoResponderApi({ version: 2, displayName: 'Helper', fallback: 'default', rules: [] });
    (api.setAutoResponderSettings as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('offline'));
    const card = await open(api);
    fireEvent.click(card.getByRole('button', { name: '新增規則' }));
    const dialog = screen.getByRole('dialog', { name: '新增規則' });
    fireEvent.change(within(dialog).getByLabelText('觸發詞'), { target: { value: 'draft' } });
    fireEvent.change(within(dialog).getByLabelText('回覆訊息'), { target: { value: 'kept' } });
    fireEvent.click(within(dialog).getByRole('button', { name: '確定' }));
    expect((await within(dialog).findByRole('alert')).textContent).toContain('無法儲存自動回覆設定');
    expect(within(dialog).getByLabelText('觸發詞')).toHaveProperty('value', 'draft');
    expect(card.queryByText('draft')).toBeNull();
  });

  it('keeps blank default replies in the dialog until corrected', async () => {
    const { api, getSaved } = createAutoResponderApi({ version: 1, displayName: 'Helper', fallback: 'default', rules: [] });
    const card = await open(api);
    fireEvent.click(card.getByRole('button', { name: '編輯預設回覆' }));
    const dialog = screen.getByRole('dialog', { name: '編輯預設回覆' });
    const reply = within(dialog).getByLabelText('回覆訊息');
    fireEvent.change(reply, { target: { value: '   ' } });
    fireEvent.click(within(dialog).getByRole('button', { name: '確定' }));
    expect((await within(dialog).findByRole('alert')).textContent).toContain('預設回覆不可空白');
    expect(api.setAutoResponderSettings).not.toHaveBeenCalled();
    fireEvent.change(reply, { target: { value: 'corrected' } });
    fireEvent.click(within(dialog).getByRole('button', { name: '確定' }));
    await waitFor(() => expect(getSaved().fallback).toBe('corrected'));
  });

  it('refreshes the version after conflict but keeps the attempted input for an explicit retry', async () => {
    const initial = { version: 2, displayName: 'Helper', fallback: 'default', rules: [] };
    const latest = { version: 3, displayName: 'Remote helper', fallback: 'remote default', rules: [] };
    let readCount = 0;
    const api = {
      getDatabaseSetupStatus: vi.fn(async () => ({ configured: true, attachmentRoot: null, agentWorkspace: null, connection: null })),
      getConversationSettings: vi.fn(async () => ({ attachmentAutoAttemptLimit: 3, showAgentStatusMarkers: true, agentStatusIcons: { ...DEFAULT_AGENT_STATUS_ICONS } })),
      getAutoResponderSettings: vi.fn(async () => readCount++ === 0 ? initial : latest),
      setAutoResponderSettings: vi.fn()
        .mockResolvedValueOnce({ type: 'error', requestId: 'save', ok: false, code: 'AUTORESPONDER_VERSION_CONFLICT', message: 'conflict' })
        .mockResolvedValueOnce({ type: 'setAutoResponderSettings', requestId: 'retry', ok: true, version: 4 }),
    } as unknown as DesktopApi;
    const card = await open(api);
    fireEvent.click(card.getByRole('button', { name: '新增規則' }));
    const dialog = screen.getByRole('dialog', { name: '新增規則' });
    fireEvent.change(within(dialog).getByLabelText('觸發詞'), { target: { value: 'draft' } });
    fireEvent.change(within(dialog).getByLabelText('回覆訊息'), { target: { value: 'kept' } });
    fireEvent.click(within(dialog).getByRole('button', { name: '確定' }));
    expect((await within(dialog).findByRole('alert')).textContent).toBe('設定已在其他地方變更，已重新載入');
    expect(within(dialog).getByLabelText('觸發詞')).toHaveProperty('value', 'draft');
    expect(card.queryByText('draft')).toBeNull();
    expect(api.setAutoResponderSettings).toHaveBeenCalledTimes(1);
    expect(api.getAutoResponderSettings).toHaveBeenCalledTimes(2);
    fireEvent.click(within(dialog).getByRole('button', { name: '確定' }));
    await waitFor(() => expect(api.setAutoResponderSettings).toHaveBeenLastCalledWith(3, {
      displayName: 'Remote helper', fallback: 'remote default', rules: [{ trigger: 'draft', reply: 'kept' }],
    }));
  });
});

describe('settings layout and status preview', () => {
  const makeApi = () => ({
    getDatabaseSetupStatus: vi.fn(async () => ({ configured: true, attachmentRoot: 'D:\attachments', agentWorkspace: 'D:\workspace', connection: { host: 'localhost', port: 5432, username: 'postgres', ssl: 'disable' as const, database: 'line_agent' } })),
    getConversationSettings: vi.fn(async () => ({ attachmentAutoAttemptLimit: 3, showAgentStatusMarkers: true, agentStatusIcons: { ...DEFAULT_AGENT_STATUS_ICONS }, agentStatusRotationIntervalSeconds: 10 })),
    setConversationSettings: vi.fn(async (settings: unknown) => settings),
  }) as unknown as DesktopApi;
  const openConversation = async (api = makeApi()) => {
    renderWithStartupLocale(<Settings api={api} headingRef={React.createRef()} onNotice={vi.fn()} />, 'zh-TW');
    fireEvent.click(screen.getByRole('tab', { name: '對話' }));
    await waitFor(() => expect(screen.getByLabelText('附件自動下載嘗試次數')).toHaveProperty('value', '3'));
  };
  it.each(['en', 'zh-TW', 'ja', 'ko'] as const)('localizes six read-only status notes and neutral glyphs in %s', async (locale) => {
    renderWithStartupLocale(<Settings api={makeApi()} headingRef={React.createRef()} onNotice={vi.fn()} />, locale);
    fireEvent.click(screen.getByRole('tab', { name: desktopTextFor(locale, 'conversations') }));
    await screen.findByLabelText(desktopTextFor(locale, 'automaticAttachmentDownloadAttempts'));
    const grid = document.querySelector('.agent-status-icon-grid')!;
    const rows = [...grid.querySelectorAll(':scope > .agent-status-icon-row')];
    expect(rows.map((row) => row.querySelector('.agent-status-icon-note')?.textContent)).toEqual([
      'AMAZING', desktopTextFor(locale, 'alternating'), 'LOVE', 'SAD', 'FUN', 'OMG',
    ]);
    expect(rows.map((row) => [...row.querySelectorAll('.agent-status-marker .agent-status-glyph')].map((glyph) => glyph.textContent))).toEqual([
      [LINE_REACTION_GLYPHS.AMAZING], [LINE_REACTION_GLYPHS.NICE, LINE_REACTION_GLYPHS.AMAZING, LINE_REACTION_GLYPHS.FUN],
      [LINE_REACTION_GLYPHS.LOVE], [LINE_REACTION_GLYPHS.SAD], [LINE_REACTION_GLYPHS.FUN], [LINE_REACTION_GLYPHS.OMG],
    ]);
    const preview = within(rows[1] as HTMLElement).getByLabelText(desktopTextFor(locale, 'arg0PreviewAlternatingArg1', { arg0: desktopTextFor(locale, 'running'), arg1: 'NICE、AMAZING、FUN' }));
    expect(preview.className).toContain('agent-status-marker running');
    expect(preview.getAttribute('role')).toBeNull();
    expect(rows.every((row) => row.querySelectorAll('button').length === 0)).toBe(true);
    expect(screen.queryByRole('listbox')).toBeNull();
    expect(screen.queryByRole('button', { name: '恢復預設圖示' })).toBeNull();
    expect(screen.queryByRole('checkbox')).toBeNull();
  });

  it.each(['en', 'zh-TW', 'ja', 'ko'] as const)('shows the saved rotation interval row in %s', async (locale) => {
    renderWithStartupLocale(<Settings api={makeApi()} headingRef={React.createRef()} />, locale);
    fireEvent.click(screen.getByRole('tab', { name: desktopTextFor(locale, 'conversations') }));
    const input = await screen.findByLabelText(desktopTextFor(locale, 'agentStatusRotationIntervalSeconds'));
    expect(input).toHaveProperty('value', '10');
    expect(input.closest('fieldset')?.querySelector('.agent-status-icon-grid')).not.toBeNull();
  });

  it('saves a five second rotation interval and disables smaller values', async () => {
    const api = makeApi();
    renderWithStartupLocale(<Settings api={api} headingRef={React.createRef()} />, 'en');
    fireEvent.click(screen.getByRole('tab', { name: desktopTextFor('en', 'conversations') }));
    const input = await screen.findByLabelText(desktopTextFor('en', 'agentStatusRotationIntervalSeconds'));
    const save = screen.getByRole('button', { name: desktopTextFor('en', 'save') });
    fireEvent.change(input, { target: { value: '4' } });
    expect(save).toHaveProperty('disabled', true);
    fireEvent.change(input, { target: { value: '86401' } });
    expect(save).toHaveProperty('disabled', true);
    fireEvent.change(input, { target: { value: '5' } });
    expect(save).toHaveProperty('disabled', false);
    fireEvent.click(save);
    await waitFor(() => expect(api.setConversationSettings).toHaveBeenCalledWith(expect.objectContaining({ agentStatusRotationIntervalSeconds: 5 })));
  });

  it.each(['en', 'zh-TW', 'ja', 'ko'] as const)('localizes rejected conversation settings loads and focus reloads in %s', async (locale) => {
    const api = makeApi();
    (api.getConversationSettings as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('private backend diagnostic'));
    renderWithStartupLocale(<Settings api={api} headingRef={React.createRef()} />, locale);
    fireEvent.click(screen.getByRole('tab', { name: desktopTextFor(locale, 'conversations') }));
    const toast = () => document.querySelector('.system-toast')!;
    await waitFor(() => expect(toast().textContent).toBe(extraTextFor(locale, 'operationFailed')));
    expect(api.getConversationSettings).toHaveBeenCalledTimes(1);
    await act(async () => { fireEvent.focus(window); });
    await waitFor(() => expect(api.getConversationSettings).toHaveBeenCalledTimes(2));
    expect(toast().textContent).toBe(extraTextFor(locale, 'operationFailed'));
  });
  it('ignores a stored custom icon', async () => {
    const api = makeApi();
    (api.getConversationSettings as ReturnType<typeof vi.fn>).mockResolvedValue({ attachmentAutoAttemptLimit: 3, showAgentStatusMarkers: false, agentStatusIcons: { ...DEFAULT_AGENT_STATUS_ICONS, running: '★' } });
    await openConversation(api);
    expect(screen.getByLabelText('執行中預覽：NICE、AMAZING、FUN 輪替').querySelector('.agent-status-glyph')?.textContent).toBe(LINE_REACTION_GLYPHS.NICE);
    expect(screen.getByLabelText('執行中預覽：NICE、AMAZING、FUN 輪替').textContent).not.toContain('★');
  });
  it('keeps the header and tablist outside the scrolling panel and resets scroll on tab switch', async () => {
    render(<Settings api={makeApi()} headingRef={React.createRef()} onNotice={vi.fn()} />);
    const scroll = document.querySelector('.settings-panel-scroll') as HTMLElement;
    const tablist = screen.getByRole('tablist');
    const heading = screen.getByRole('heading', { name: '設定' });
    expect(scroll.contains(tablist)).toBe(false);
    expect(scroll.contains(heading)).toBe(false);
    expect(scroll.querySelector('[role="tabpanel"]')).toBeTruthy();
    expect(scroll.querySelectorAll('[role="tab"]').length).toBe(0);
    scroll.scrollTop = 120;
    fireEvent.click(screen.getByRole('tab', { name: '指令' }));
    expect(scroll.scrollTop).toBe(0);
  });
  it('shows the description on the same row as the title', () => {
    render(<Settings api={makeApi()} headingRef={React.createRef()} onNotice={vi.fn()} />);
    const row = screen.getByRole('heading', { name: '設定' }).parentElement!;
    expect(row.className).toBe('page-title-row');
    expect(within(row).getByText('集中管理資料庫、附件與 Agent。')).toBeTruthy();
  });
});

describe('database settings', () => {
  it('compacts long attachment paths while keeping the full path accessible', async () => {
    const path = 'D:\\Users\\Administrator\\AppData\\Roaming\\LINE Agent Assistant\\attachments\\account-123';
    const api = {
      getDatabaseSetupStatus: vi.fn(async () => ({ configured: true, attachmentRoot: path, agentWorkspace: null,
        connection: { host: 'localhost', port: 5432, username: 'postgres', ssl: 'disable' as const, database: 'line_agent' } })),
    } as unknown as DesktopApi;
    render(<Settings api={api} headingRef={React.createRef()} />);
    const value = await screen.findByLabelText(path);
    expect(value.querySelector('.system-location-path-start')?.textContent).toBe('D:\\');
    expect(value.querySelector('.system-location-path-middle')?.textContent).toBe('Users\\Administrator\\AppData\\Roaming\\LINE Agent Assistant\\attachments\\');
    expect(value.querySelector('.system-location-path-tail')?.textContent).toBe('account-123');
    expect(value.textContent).toBe(path);
    expect(value.getAttribute('title')).toBe(path);
    expect(screen.getByRole('button', { name: '變更位置' })).toBeTruthy();
    expect(screen.getByRole('button', { name: '開啟位置' })).toBeTruthy();
  });

  it('confirms before moving attachments, keeps the active path on cancel, and shows the system fields horizontally', async () => {
    const api = {
      getDatabaseSetupStatus: vi.fn(async () => ({ configured: true, attachmentRoot: 'D:\\old-attachments', agentWorkspace: 'D:\\workspace',
        connection: { host: 'localhost', port: 5432, username: 'postgres', ssl: 'disable' as const, database: 'line_agent' }, embedded: { version: '18.6', port: 55432 } })),
      prepareAttachmentRootChange: vi.fn(async () => ({ id: '9e2af331-4376-4a43-bc81-ce421cc3cb19', path: 'E:\\attachments' })),
      moveAttachmentRoot: vi.fn(async () => ({ saved: true as const, restartRequired: true as const, path: 'E:\\attachments', sourceRetained: true as const })),
      openAttachmentRoot: vi.fn(async () => undefined), restartApplication: vi.fn(async () => undefined),
      getConversationSettings: vi.fn(async () => ({ attachmentAutoAttemptLimit: 3, showAgentStatusMarkers: true, agentStatusIcons: { ...DEFAULT_AGENT_STATUS_ICONS } })),
    } as unknown as DesktopApi;
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);
    render(<Settings api={api} headingRef={React.createRef()} />);
    await screen.findByLabelText('D:\\old-attachments');
    const rows = document.querySelectorAll('.database-summary .system-location-row');
    expect(rows).toHaveLength(2);
    expect(rows[0]?.querySelector('.button-row')?.textContent).toContain('顯示密碼');
    fireEvent.click(await screen.findByRole('button', { name: '變更位置' }));
    await waitFor(() => expect((api.prepareAttachmentRootChange as ReturnType<typeof vi.fn>)).toHaveBeenCalledOnce());
    expect(confirm).toHaveBeenCalledWith(expect.stringContaining('E:\\attachments'));
    expect((api.moveAttachmentRoot as ReturnType<typeof vi.fn>)).not.toHaveBeenCalled();
    expect(screen.getByLabelText('D:\\old-attachments')).toBeTruthy();
  });

  it('moves attachments only after confirmation and requests restart', async () => {
    const api = {
      getDatabaseSetupStatus: vi.fn(async () => ({ configured: true, attachmentRoot: 'D:\\old-attachments', agentWorkspace: 'D:\\workspace', connection: { host: 'localhost', port: 5432, username: 'postgres', ssl: 'disable' as const, database: 'line_agent' } })),
      prepareAttachmentRootChange: vi.fn(async () => ({ id: '9e2af331-4376-4a43-bc81-ce421cc3cb19', path: 'E:\\attachments' })),
      moveAttachmentRoot: vi.fn(async () => ({ saved: true as const, restartRequired: true as const, path: 'E:\\attachments', sourceRetained: true as const })),
      restartApplication: vi.fn(async () => undefined),
    } as unknown as DesktopApi;
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    const alert = vi.spyOn(window, 'alert').mockImplementation(() => undefined);
    render(<Settings api={api} headingRef={React.createRef()} />);
    fireEvent.click(await screen.findByRole('button', { name: '變更位置' }));
    await waitFor(() => expect((api.moveAttachmentRoot as ReturnType<typeof vi.fn>)).toHaveBeenCalledWith('9e2af331-4376-4a43-bc81-ce421cc3cb19'));
    expect((api.restartApplication as ReturnType<typeof vi.fn>)).toHaveBeenCalledOnce();
    expect(alert).toHaveBeenCalledWith(expect.stringContaining('D:\\old-attachments'));
  });

  it('alerts and restarts into the old location when a fenced attachment move fails', async () => {
    const api = {
      getDatabaseSetupStatus: vi.fn(async () => ({ configured: true, attachmentRoot: 'D:\\old-attachments', agentWorkspace: null, connection: { host: 'localhost', port: 5432, username: 'postgres', ssl: 'disable' as const, database: 'line_agent' } })),
      prepareAttachmentRootChange: vi.fn(async () => ({ id: '9e2af331-4376-4a43-bc81-ce421cc3cb19', path: 'E:\\attachments' })),
      moveAttachmentRoot: vi.fn(async () => { throw Object.assign(new Error('Attachment copy failed.'), { restartRequired: true }); }),
      restartApplication: vi.fn(async () => undefined),
    } as unknown as DesktopApi;
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    const alert = vi.spyOn(window, 'alert').mockImplementation(() => undefined);
    render(<Settings api={api} headingRef={React.createRef()} />);
    fireEvent.click(await screen.findByRole('button', { name: '變更位置' }));
    await waitFor(() => expect((api.restartApplication as ReturnType<typeof vi.fn>)).toHaveBeenCalledOnce());
    expect(alert).toHaveBeenCalledWith(expect.stringContaining('目前的附件位置'));
    expect(screen.getByLabelText('D:\\old-attachments')).toBeTruthy();
  });

  it('loads and saves attachment retries and Agent marker preference from the conversation tab', async () => {
    const onNotice = vi.fn();
    const api = {
      getDatabaseSetupStatus: vi.fn(async () => ({ configured: true, attachmentRoot: 'D:\\attachments', agentWorkspace: 'D:\\workspace', connection: { host: 'localhost', port: 5432, username: 'postgres', ssl: 'disable' as const, database: 'line_agent' } })),
      getConversationSettings: vi.fn(async () => ({ attachmentAutoAttemptLimit: 3, showAgentStatusMarkers: true, agentStatusIcons: { ...DEFAULT_AGENT_STATUS_ICONS }, agentStatusRotationIntervalSeconds: 10 })),
      setConversationSettings: vi.fn(async (settings: { attachmentAutoAttemptLimit: number; showAgentStatusMarkers: boolean; agentStatusIcons: AgentStatusIcons; agentStatusRotationIntervalSeconds: number }) => settings),
    } as unknown as DesktopApi;
    render(<Settings api={api} headingRef={React.createRef()} onNotice={onNotice} />);
    fireEvent.click(screen.getByRole('tab', { name: '對話' }));
    await waitFor(() => expect(screen.getByLabelText('附件自動下載嘗試次數')).toHaveProperty('value', '3'));
    fireEvent.change(screen.getByLabelText('附件自動下載嘗試次數'), { target: { value: '7' } });
    fireEvent.click(within(document.querySelector('.conversation-settings') as HTMLElement).getByRole('button', { name: '儲存' }));
    await waitFor(() => expect(api.setConversationSettings).toHaveBeenCalledWith({
      attachmentAutoAttemptLimit: 7, showAgentStatusMarkers: true, agentStatusIcons: DEFAULT_AGENT_STATUS_ICONS, agentStatusRotationIntervalSeconds: 10,
    }));
    const sent = (api.setConversationSettings as ReturnType<typeof vi.fn>).mock.calls[0]![0] as { agentStatusIcons: unknown };
    expect(AgentStatusIconsSchema.safeParse(sent.agentStatusIcons).success).toBe(true);
    await waitFor(() => expect(onNotice).toHaveBeenCalledWith('對話設定已儲存'));
    expect(document.querySelector('.inline-notice')).toBeNull();
  });

  it('keeps work records and places database health in 系統 without a status page or Agent health card', async () => {
    const api = {
      getDatabaseSetupStatus: vi.fn(async () => ({ configured: true, attachmentRoot: null, agentWorkspace: null, connection: { host: 'localhost', port: 5432, username: 'postgres', ssl: 'disable' as const, database: 'line_agent' } })),
      listWorkRecords: vi.fn(async () => []),
      listSystemActivity: vi.fn(async () => ({ activity: [], partial: false })),
      listSystemErrors: vi.fn(async () => ({ errors: [], partial: false })),
    } as unknown as DesktopApi;
    renderWithStartupLocale(<Settings api={api} headingRef={React.createRef()} components={[
      { name: 'database', status: 'ready', message: null, lastSuccessAt: null, restartCount: 0 },
      { name: 'lineWorker', status: 'ready', message: null, lastSuccessAt: null, restartCount: 0 },
      { name: 'codex', status: 'stopped', message: '尚未設定', lastSuccessAt: null, restartCount: 0 },
    ]} />, 'en');

    expect(screen.getAllByRole('tab').map((item) => item.textContent)).toEqual(['System', 'Conversations', 'Assistant', 'Commands', 'Records', 'About']);
    expect(screen.queryByRole('tab', { name: 'Status' })).toBeNull();
    expect(within(document.querySelector('.database-summary') as HTMLElement).getByText('Database').nextElementSibling?.textContent).toBe('Connected');
    expect(screen.queryByRole('heading', { name: '選用 Agent' })).toBeNull();
    expect(screen.queryByText('LINE workers')).toBeNull();
    fireEvent.click(screen.getByRole('tab', { name: 'Records' }));
    expect(screen.queryByRole('heading', { name: 'Work records' })).toBeNull();
    expect(screen.queryByText('WORK RECORDS')).toBeNull();
    const recordsPage = document.querySelector('.work-records-page');
    expect(recordsPage?.firstElementChild?.classList.contains('work-records-card')).toBe(true);
    expect(recordsPage?.firstElementChild?.firstElementChild).toBe(screen.getByRole('tablist', { name: 'Work record categories' }));
    expect(screen.getByRole('tab', { name: 'System records' })).toBeTruthy();
    expect(screen.getByRole('tab', { name: 'System errors' })).toBeTruthy();
  });

  it('shows the existing Agent permissions card under the Agent tab', async () => {
    const api = {
      getDatabaseSetupStatus: vi.fn(async () => ({ configured: true, attachmentRoot: null, agentWorkspace: null, connection: null })),
      getAgentPermissions: vi.fn(async () => ({
        catalog: AGENT_PERMISSIONS.map((entry) => ({ ...entry })), defaults: [], subjects: [], rules: [], links: [], folders: [], eligibleChats: [], workspaceRoot: 'D:\\workspace',
      })),
      getAgentExecutionPolicy: vi.fn(async () => ({ level: 'workspace_write' as const, approvalTimeoutSeconds: 180, timeoutAction: 'DENY' as const, version: 1, updatedAt: new Date(0).toISOString() })),
      setAgentExecutionPolicy: vi.fn(async () => ({ type: 'setAgentExecutionPolicy', version: 2 })),
      listAgentToolAllowlist: vi.fn(async () => []),
      onEvent: vi.fn(() => () => undefined),
    } as unknown as DesktopApi;
    const account = { accountId: 'agent-1', displayName: 'Agent LINE', status: 'connected' as const, lastSyncedAt: null, mode: 'ACTIVE_CONTROL' as const, productRole: 'AGENT' as const };
    render(<Settings api={api} headingRef={React.createRef()} accounts={[account]} />);

    expect(screen.queryByRole('tab', { name: '權限' })).toBeNull();
    fireEvent.click(screen.getByRole('tab', { name: '助理' }));
    expect(await screen.findByRole('heading', { name: 'Agent 執行權限' })).toBeTruthy();
    expect(screen.queryByRole('heading', { name: 'Agent 權限' })).toBeNull();
    expect(screen.queryByText('設定白名單使用者能讓 Agent 做什麼，以及各聊天室的工作資料夾。')).toBeNull();
    expect(screen.getByRole('radio', { name: '工作區可寫' })).toHaveProperty('checked', true);
    for (const choice of ['唯讀', '工作區可寫', '信任', '全部放行（預設）']) {
      const radio = screen.getByRole('radio', { name: choice });
      const row = radio.closest('label.perm-execution-option');
      expect(row?.querySelector('.perm-row-copy strong')?.textContent).toBe(choice);
      expect(row?.querySelector('.perm-row-copy small')?.textContent).toBeTruthy();
    }
    expect(api.getAgentPermissions).toHaveBeenCalledWith('agent-1');
    expect(api.getAgentExecutionPolicy).toHaveBeenCalled();
    fireEvent.click(screen.getByRole('radio', { name: '唯讀' }));
    await waitFor(() => expect(api.setAgentExecutionPolicy).toHaveBeenCalledWith({ level: 'read_only', approvalTimeoutSeconds: 180, timeoutAction: 'DENY', expectedVersion: 1 }));
    expect(screen.getAllByRole('tabpanel')).toHaveLength(1);
  });

  it('redirects a previously saved 權限 tab to Agent', () => {
    window.localStorage.setItem(SETTINGS_TAB_KEY, 'permissions');
    expect(readStoredSettingsTab()).toBe('agent');
    window.localStorage.removeItem(SETTINGS_TAB_KEY);
  });

  it.each(['accounts', 'database', 'status'])('maps the retired %s tab to 系統', (tab) => {
    window.localStorage.setItem(SETTINGS_TAB_KEY, tab);
    expect(readStoredSettingsTab()).toBe('system');
    expect(window.localStorage.getItem(SETTINGS_TAB_KEY)).toBe('system');
    window.localStorage.removeItem(SETTINGS_TAB_KEY);
  });

  it('refreshes unknown and error providers without starting login', async () => {
    const api = {
      getDatabaseSetupStatus: vi.fn(async () => ({ configured: true, attachmentRoot: 'D:\\attachments', agentWorkspace: 'D:\\workspace', connection: { host: 'localhost', port: 5432, username: 'postgres', ssl: 'disable' as const, database: 'line_agent' } })),
      agentLogin: vi.fn(async () => ({ type: 'accepted', requestId: 'x', ok: true } as const)),
      agentRefreshStatus: vi.fn(async () => ({ type: 'accepted', requestId: 'x', ok: true } as const)),
    } as unknown as DesktopApi;
    render(<Settings api={api} headingRef={React.createRef()} providers={[
      { provider: 'codex', status: 'unknown', detail: null },
      { provider: 'claude', status: 'error', detail: null },
    ]} />);
    fireEvent.click(screen.getByRole('tab', { name: '助理' }));

    fireEvent.click(screen.getByRole('button', { name: /Codex/ }));
    fireEvent.click(screen.getByRole('button', { name: /Claude/ }));

    await waitFor(() => expect(api.agentRefreshStatus).toHaveBeenCalledTimes(2));
    expect(api.agentRefreshStatus).toHaveBeenCalledWith('codex');
    expect(api.agentRefreshStatus).toHaveBeenCalledWith('claude');
    expect(api.agentLogin).not.toHaveBeenCalled();
  });

  it('requires confirmation before logging out and omits auth actions for missing CLIs', async () => {
    const confirm = vi.fn().mockReturnValueOnce(false).mockReturnValueOnce(true);
    vi.stubGlobal('confirm', confirm);
    const api = {
      getDatabaseSetupStatus: vi.fn(async () => ({ configured: true, attachmentRoot: 'D:\\attachments', agentWorkspace: 'D:\\workspace', connection: { host: 'localhost', port: 5432, username: 'postgres', ssl: 'disable' as const, database: 'line_agent' } })),
      agentLogout: vi.fn(async () => ({ type: 'accepted', requestId: 'x', ok: true } as const)),
    } as unknown as DesktopApi;
    render(<Settings api={api} headingRef={React.createRef()} providers={[
      { provider: 'claude', status: 'logged_in', detail: null },
      { provider: 'codex', status: 'not_installed', detail: null },
    ]} />);
    fireEvent.click(screen.getByRole('tab', { name: '助理' }));

    expect(screen.queryByRole('button', { name: '登入 Claude' })).toBeNull();
    expect(screen.queryByText('CLI 已回報登入。')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: '登出 Claude' }));
    expect(api.agentLogout).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: '登出 Claude' }));

    expect(confirm).toHaveBeenCalledTimes(2);
    await waitFor(() => expect(api.agentLogout).toHaveBeenCalledWith('claude'));
    expect(screen.queryByRole('button', { name: /Codex/ })).toBeNull();
  });

  it('restores a saved Codex default after Settings remounts', async () => {
    let persistedProvider: 'codex' | 'claude' = 'claude';
    const api = {
      getDatabaseSetupStatus: vi.fn(async () => ({ configured: true, attachmentRoot: 'D:\\attachments', agentWorkspace: 'D:\\workspace', connection: { host: 'localhost', port: 5432, username: 'postgres', ssl: 'disable' as const, database: 'line_agent' } })),
      setWorkspace: vi.fn(async () => ({ type: 'setWorkspace', requestId: 'x', ok: true } as const)),
      setDefaultAgent: vi.fn(async (provider: 'codex' | 'claude') => {
        persistedProvider = provider;
        return { type: 'setDefaultAgent', requestId: 'x', ok: true } as const;
      }),
    } as unknown as DesktopApi;
    const mount = () => render(<Settings api={api} headingRef={React.createRef()} defaultProvider={persistedProvider} />);
    const first = mount();
    fireEvent.click(screen.getByRole('tab', { name: '助理' }));
    const select = await screen.findByRole('combobox', { name: '預設 Agent' }) as HTMLSelectElement;
    fireEvent.change(select, { target: { value: 'codex' } });
    fireEvent.click(within(document.querySelector('.agent-basics') as HTMLElement).getByRole('button', { name: '儲存' }));
    await waitFor(() => expect(api.setDefaultAgent).toHaveBeenCalledWith('codex'));
    first.unmount();

    mount();
    fireEvent.click(screen.getByRole('tab', { name: '助理' }));
    expect(await screen.findByRole('combobox', { name: '預設 Agent' })).toHaveProperty('value', 'codex');
  });

  it('keeps a dirty provider choice when a newer snapshot arrives', async () => {
    const api = {
      getDatabaseSetupStatus: vi.fn(async () => ({ configured: true, attachmentRoot: 'D:\\attachments', agentWorkspace: 'D:\\workspace', connection: { host: 'localhost', port: 5432, username: 'postgres', ssl: 'disable' as const, database: 'line_agent' } })),
    } as unknown as DesktopApi;
    const view = render(<Settings api={api} headingRef={React.createRef()} defaultProvider="codex" />);
    fireEvent.click(screen.getByRole('tab', { name: '助理' }));
    const select = await screen.findByRole('combobox', { name: '預設 Agent' }) as HTMLSelectElement;
    fireEvent.change(select, { target: { value: 'claude' } });
    view.rerender(<Settings api={api} headingRef={React.createRef()} defaultProvider="codex" />);
    expect(screen.getByRole('combobox', { name: '預設 Agent' })).toHaveProperty('value', 'claude');
  });

  it('applies a new persisted provider from a snapshot while the selection is clean', async () => {
    const api = {
      getDatabaseSetupStatus: vi.fn(async () => ({ configured: true, attachmentRoot: 'D:\\attachments', agentWorkspace: 'D:\\workspace', connection: { host: 'localhost', port: 5432, username: 'postgres', ssl: 'disable' as const, database: 'line_agent' } })),
    } as unknown as DesktopApi;
    const view = render(<Settings api={api} headingRef={React.createRef()} defaultProvider="claude" />);
    fireEvent.click(screen.getByRole('tab', { name: '助理' }));
    const select = await screen.findByRole('combobox', { name: '預設 Agent' });
    expect(select).toHaveProperty('value', 'claude');

    view.rerender(<Settings api={api} headingRef={React.createRef()} defaultProvider="codex" />);

    expect(screen.getByRole('combobox', { name: '預設 Agent' })).toHaveProperty('value', 'codex');
  });

  it('loads shared autoresponder rules regardless of account selection without resaving them', async () => {
    const api = {
      getDatabaseSetupStatus: vi.fn(async () => ({ configured: true, attachmentRoot: 'D:\\attachments', agentWorkspace: 'D:\\workspace', connection: { host: 'localhost', port: 5432, username: 'postgres', ssl: 'disable' as const, database: 'line_agent' } })),
      getConversationSettings: vi.fn(async () => ({ attachmentAutoAttemptLimit: 3, showAgentStatusMarkers: true, agentStatusIcons: { ...DEFAULT_AGENT_STATUS_ICONS } })),
      getAutoResponderSettings: vi.fn(async () => ({ version: 3, displayName: 'Helper', fallback: '我不知道你在說甚麼', rules: [{ trigger: 'hello', reply: 'Hi' }] })),
      setAutoResponderSettings: vi.fn(async () => ({ type: 'setAutoResponderSettings', requestId: 'save', ok: true, version: 4 } as const)),
    } as unknown as DesktopApi;
    render(<Settings api={api} headingRef={React.createRef()} accounts={[
      { accountId: 'account-admin', displayName: 'Admin LINE', status: 'connected', lastSyncedAt: null, mode: 'MONITOR_ONLY', productRole: 'PRIMARY_ADMIN' },
      { accountId: 'account-agent', displayName: 'Agent LINE', status: 'connected', lastSyncedAt: null, mode: 'ACTIVE_CONTROL', productRole: 'AGENT' },
    ]} />);
    fireEvent.click(screen.getByRole('tab', { name: '對話' }));
    expect(await screen.findByText('我不知道你在說甚麼')).toBeTruthy();
    expect(screen.queryByLabelText('Agent 顯示名稱')).toBeNull();
    expect(api.getAutoResponderSettings).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('columnheader', { name: '操作' })).toBeTruthy();
    expect(within(document.querySelector('.autoresponder-settings') as HTMLElement).queryByRole('button', { name: '儲存' })).toBeNull();
    expect(api.setAutoResponderSettings).not.toHaveBeenCalled();
  });

  it('renders the 自動回覆 card in the 對話 tab and not in the Agent tab', async () => {
    const api = {
      getDatabaseSetupStatus: vi.fn(async () => ({ configured: true, attachmentRoot: null, agentWorkspace: null, connection: { host: 'localhost', port: 5432, username: 'postgres', ssl: 'disable' as const, database: 'line_agent' } })),
      getConversationSettings: vi.fn(async () => ({ attachmentAutoAttemptLimit: 3, showAgentStatusMarkers: true, agentStatusIcons: { ...DEFAULT_AGENT_STATUS_ICONS } })),
      getAutoResponderSettings: vi.fn(async () => ({ version: 1, displayName: 'Helper', fallback: '我不知道你在說甚麼', rules: [] })),
      setAutoResponderSettings: vi.fn(async () => ({ type: 'setAutoResponderSettings', requestId: 'save', ok: true, version: 2 } as const)),
    } as unknown as DesktopApi;
    const accounts = [{ accountId: 'account-a', displayName: 'LINE A', status: 'connected' as const, lastSyncedAt: null, mode: 'ACTIVE_CONTROL' as const, productRole: null }];
    render(<Settings api={api} headingRef={React.createRef()} accounts={accounts} />);
    fireEvent.click(screen.getByRole('tab', { name: '對話' }));
    const heading = await screen.findByRole('heading', { name: /自動回覆/ });
    expect(heading.textContent).toBe('自動回覆（助理未登入）');
    expect(heading.parentElement).toBe(screen.getByRole('button', { name: '新增規則' }).parentElement?.parentElement);
    expect(screen.queryByText('未啟用或待審核的聊天室使用固定回覆，不會啟動 Agent。')).toBeNull();
    expect(screen.getAllByRole('tabpanel')).toHaveLength(1);
    const stack = screen.getByRole('tabpanel');
    expect(stack.classList.contains('settings-card-stack')).toBe(true);
    expect(stack.querySelector('.conversation-settings')).toBeTruthy();
    expect(stack.querySelector('.conversation-settings')?.textContent).not.toContain('調整附件自動下載與 Agent 狀態顯示。');
    expect(stack.querySelector('.autoresponder-settings')).toBeTruthy();
    fireEvent.click(screen.getByRole('tab', { name: '助理' }));
    expect(screen.queryByRole('heading', { name: /自動回覆/ })).toBeNull();
    expect(screen.queryByText('Room auto-replies')).toBeNull();
  });

  it('lists Agent prompts and LINE enrollment commands in the 指令 tab', async () => {
    const api = {
      getDatabaseSetupStatus: vi.fn(async () => ({ configured: true, attachmentRoot: 'D:\\attachments', agentWorkspace: 'D:\\workspace', connection: { host: 'localhost', port: 5432, username: 'postgres', ssl: 'disable' as const, database: 'line_agent' } })),
      setWorkspace: vi.fn(), setDefaultAgent: vi.fn(), agentLogin: vi.fn(), agentLogout: vi.fn(),
    } as unknown as DesktopApi;
    render(<Settings api={api} headingRef={React.createRef()} />);

    fireEvent.click(screen.getByRole('tab', { name: '指令' }));

    const table = screen.getByRole('table', { name: '對話指令清單' });
    for (const command of ['/stop', '/new', '/status', '/agent codex <提示內容>', '/agent claude <提示內容>', '/adduser', '/新增使用者']) {
      expect(table.textContent).toContain(command);
    }
    expect(table.textContent).not.toContain('一般文字提示');
    expect(table.textContent).toContain('使用者授權');
    expect(table.textContent).not.toContain('LINE 使用者授權');
    expect(table.textContent).toContain('在 1:1／群組中，可新增 Agent 使用權限名單。');
    expect(table.textContent).toContain('停止目前的 Agent 工作');
    expect(table.textContent).toContain('開始新的 Agent 對話');
    expect(table.textContent).toContain('查詢目前 Agent 工作狀態');
  });

  it('separates database and Agent settings into tabs and includes provider login controls', async () => {
    const api = {
      getDatabaseSetupStatus: vi.fn(async () => ({ configured: true, attachmentRoot: 'D:\\attachments', agentWorkspace: 'D:\\workspace', connection: { host: 'localhost', port: 5432, username: 'postgres', ssl: 'disable' as const, database: 'line_agent' } })),
      agentLogin: vi.fn(async () => ({ type: 'accepted', requestId: 'x', ok: true } as const)),
      agentLogout: vi.fn(async () => ({ type: 'accepted', requestId: 'x', ok: true } as const)),
      setWorkspace: vi.fn(async () => ({ type: 'setWorkspace', requestId: 'x', ok: true } as const)),
      setDefaultAgent: vi.fn(async () => ({ type: 'setDefaultAgent', requestId: 'x', ok: true } as const)),
    } as unknown as DesktopApi;
    const style = document.createElement('style');
    style.dataset.settingsLayoutTest = 'true';
    style.textContent = readFileSync(new NodeURL('../styles.css', import.meta.url), 'utf8');
    document.head.append(style);
    render(<Settings api={api} headingRef={React.createRef()} providers={[
      { provider: 'codex', status: 'logged_out', detail: null },
      { provider: 'claude', status: 'logged_in', detail: null },
    ]} />);
    expect(screen.getByRole('tab', { name: '系統' }).getAttribute('aria-selected')).toBe('true');
    expect(screen.queryByRole('heading', { name: 'Agent 工作目錄' })).toBeNull();
    fireEvent.click(screen.getByRole('tab', { name: '助理' }));
    expect(screen.queryByRole('heading', { name: 'Agent 工作目錄' })).toBeNull();
    expect(screen.getByRole('heading', { name: 'Codex' })).toBeTruthy();
    const basics = document.querySelector('.agent-basics') as HTMLElement;
    expect(within(basics).getByRole('heading', { name: 'Agent 基本設定' })).toBeTruthy();
    const basicsHeader = within(basics).getByRole('heading', { name: 'Agent 基本設定' }).parentElement!;
    const actionCluster = basicsHeader.querySelector('.agent-basics-actions') as HTMLElement;
    expect(actionCluster).toBeTruthy();
    expect(actionCluster.querySelector('label')?.textContent).toContain('預設 Agent');
    expect(Array.from(actionCluster.children).map((child) => child.tagName.toLowerCase())).toEqual(['label', 'button']);
    expect(within(actionCluster).getByRole('button', { name: '儲存' })).toBeTruthy();
    const loginPanels = Array.from(basics.querySelectorAll('.agent-login-panel'));
    expect(loginPanels).toHaveLength(2);
    expect(document.querySelectorAll('.agent-login-panel')).toHaveLength(2);
    expect(document.querySelector('.agent-provider-settings')).toBeNull();
    expect(loginPanels.map((panel) => panel.querySelector('h3')?.textContent)).toEqual(['Codex', 'Claude']);
    const workspaceLabel = within(basics).getByText('工作目錄', { selector: 'label' });
    for (const panel of loginPanels) expect(panel.compareDocumentPosition(workspaceLabel) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(within(loginPanels[0] as HTMLElement).getByRole('button', { name: '登入 Codex' })).toBeTruthy();
    expect(within(loginPanels[0] as HTMLElement).queryByRole('button', { name: '登出 Codex' })).toBeNull();
    expect(within(loginPanels[1] as HTMLElement).getByRole('button', { name: '登出 Claude' })).toBeTruthy();
    expect(within(loginPanels[1] as HTMLElement).queryByRole('button', { name: '登入 Claude' })).toBeNull();
    expect(loginPanels[1]?.textContent).not.toContain('CLI 已回報登入。');
    await screen.findByDisplayValue('D:\\workspace');
    expect(within(basics).queryByRole('heading', { name: 'Agent 工作目錄' })).toBeNull();
    expect(within(basics).getByText('工作目錄', { selector: 'label' })).toBeTruthy();
    expect(getComputedStyle(within(basics).getByText('工作目錄', { selector: 'label' })).display).toBe('block');
    expect(getComputedStyle(basics.querySelector('.agent-workspace-row') as HTMLElement).alignItems).toBe('center');
    expect(getComputedStyle(document.querySelector('.agent-settings>.cards.secondary-settings') as HTMLElement).marginTop).toBe('0px');
    expect(within(basics).queryByText('工作目錄（供 Main 驗證）', { selector: 'label' })).toBeNull();
    expect(within(basics).getByRole('textbox', { name: 'Agent 工作目錄' })).toBeTruthy();
    expect(within(basics).queryByText('Agent', { selector: 'label' })).toBeNull();
    expect(within(basics).getByRole('combobox', { name: '預設 Agent' })).toBeTruthy();
    fireEvent.click(within(actionCluster).getByRole('button', { name: '儲存' }));
    await waitFor(() => expect(api.setWorkspace).toHaveBeenCalledWith('D:\\workspace'));
    expect(api.setDefaultAgent).not.toHaveBeenCalled();
    fireEvent.change(screen.getByRole('combobox', { name: '預設 Agent' }), { target: { value: 'codex' } });
    fireEvent.click(within(actionCluster).getByRole('button', { name: '儲存' }));
    await waitFor(() => expect(api.setDefaultAgent).toHaveBeenCalledWith('codex'));
    fireEvent.click(screen.getByRole('button', { name: '登入 Codex' }));
    await waitFor(() => expect(api.agentLogin).toHaveBeenCalledWith('codex'));
  });

  it('does not infer a live connection from configured settings when health is missing', async () => {
    const api = {
      getDatabaseSetupStatus: vi.fn(async () => ({ configured: true, attachmentRoot: 'D:\\LineAgentData\\attachments', agentWorkspace: 'D:\\LineAgentData\\workspace', connection: { host: 'db.internal', port: 5433, username: 'line_user', ssl: 'require' as const, database: 'line_agent' } })),
    } as unknown as DesktopApi;
    render(<Settings api={api} headingRef={React.createRef()} />);

    const summary = document.querySelector('.database-summary') as HTMLElement;
    expect(await within(summary).findByText('無法確認連線')).toBeTruthy();
    for (const hidden of ['db.internal', '5433', 'line_user', 'line_agent', '由 App 自動管理']) expect(summary.textContent).not.toContain(hidden);
    expect(summary.querySelectorAll('input, select')).toHaveLength(0);
    expect(summary.querySelectorAll('button')).toHaveLength(2);
    expect(screen.queryByRole('button', { name: '資料庫設定' })).toBeNull();
    expect(screen.queryByRole('button', { name: '顯示密碼' })).toBeNull();
    expect(screen.queryByRole('button', { name: '變更密碼' })).toBeNull();
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(screen.queryByLabelText('PostgreSQL 密碼')).toBeNull();
  });

  it('shows 尚未設定 and no dialog when the database is not configured', async () => {
    const api = { getDatabaseSetupStatus: vi.fn(async () => ({ configured: false, attachmentRoot: null, agentWorkspace: 'D:\\workspace', connection: null })) } as unknown as DesktopApi;
    render(<Settings api={api} headingRef={React.createRef()} />);
    await waitFor(() => expect(api.getDatabaseSetupStatus).toHaveBeenCalled());
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(within(document.querySelector('.database-summary') as HTMLElement).getByText('資料庫').nextElementSibling?.textContent).toBe('尚未設定');
  });

  it('embedded mode shows the app-managed summary and fetches the password only when the user clicks', async () => {
    const writeText = vi.fn(async () => undefined);
    vi.stubGlobal('navigator', { ...navigator, clipboard: { writeText } });
    const api = {
      getDatabaseSetupStatus: vi.fn(async () => ({ configured: true, attachmentRoot: 'D:\\data\\attachments', agentWorkspace: 'D:\\data\\workspace',
        connection: { host: '127.0.0.1', port: 55432, username: 'line_agent_admin', ssl: 'disable' as const, database: 'line_agent' }, embedded: { version: '18.6', port: 55432 } })),
      getEmbeddedConnectionInfo: vi.fn(async () => ({ version: '18.6', host: '127.0.0.1', port: 55432, username: 'line_agent_admin', database: 'line_agent',
        url: 'postgresql://line_agent_admin:s3cret@127.0.0.1:55432/line_agent?sslmode=disable', password: 's3cret' })),
    } as unknown as DesktopApi;
    renderWithStartupLocale(<Settings api={api} headingRef={React.createRef()} />, 'en');
    const show = await screen.findByRole('button', { name: 'Show password' });
    expect(screen.getByText('Unable to verify connection')).toBeTruthy();
    const summary = screen.getByRole('tabpanel').textContent ?? '';
    for (const hidden of ['18.6', '55432', 'line_agent_admin', '127.0.0.1', 'portable', 'embedded']) expect(summary).not.toContain(hidden);
    expect(screen.queryByRole('button', { name: 'Database settings' })).toBeNull();
    const panel = screen.getByRole('tabpanel');
    expect(panel.querySelector('.database-summary')).toBeTruthy();
    const accountCard = screen.getByRole('region', { name: 'LINE account settings' });
    expect(accountCard.querySelectorAll('.account-role-slot')).toHaveLength(2);
    const accountTitle = within(accountCard).getByRole('heading', { name: 'Account' });
    expect(accountTitle.nextElementSibling?.classList.contains('account-role-slots')).toBe(true);
    const accountTitleRule = readFileSync(new NodeURL('../styles.css', import.meta.url), 'utf8').match(/\.combined-account-card>\.combined-account-title\{([^}]*)\}/)?.[1] ?? '';
    expect(accountTitleRule).toContain('border-bottom:1px solid var(--border)');
    expect(within(accountCard).getAllByText('Not logged in')).toHaveLength(2);
    expect(accountCard.textContent).toContain('AgentNot logged in');
    expect(accountCard.textContent).toContain('Primary AdminNot logged in');
    const monitorCard = screen.getByRole('region', { name: 'External monitoring' });
    expect(accountCard.compareDocumentPosition(monitorCard) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(within(screen.getByLabelText('Primary Admin account slot')).getByText('Set administrator from LINE and start external monitoring')).toBeTruthy();
    expect(api.getEmbeddedConnectionInfo).not.toHaveBeenCalled();
    expect(document.body.textContent).not.toContain('s3cret');
    fireEvent.click(show);
    const dialog = await screen.findByRole('dialog', { name: 'Connection information' });
    expect(api.getEmbeddedConnectionInfo).toHaveBeenCalledOnce();
    expect(within(dialog).getByText('s3cret', { selector: '.connection-info-value' })).toBeTruthy();
    expect(dialog.querySelectorAll('input, textarea')).toHaveLength(0);
    expect(getComputedStyle(within(dialog).getByText('s3cret', { selector: '.connection-info-value' })).userSelect).toBe('none');
    fireEvent.click(within(dialog).getAllByRole('button', { name: 'Copy' })[1]!);
    expect(writeText).toHaveBeenCalledWith('s3cret');
    fireEvent.click(screen.getByRole('button', { name: 'Close connection information' }));
    expect(screen.queryByText('s3cret', { selector: '.connection-info-value' })).toBeNull();
  });

  it('shows a retained logged-out account name under its role and keeps connection status separate', () => {
    const account: LineAccountSummary = { accountId: 'admin-1', displayName: 'Known Admin', status: 'disconnected', lastSyncedAt: null,
      mode: 'MONITOR_ONLY', productRole: 'PRIMARY_ADMIN', hasVerifiedLineIdentity: true, canStartExternalImport: true };
    renderWithStartupLocale(<Settings api={{ getDatabaseSetupStatus: vi.fn(async () => ({ configured: false, attachmentRoot: null, agentWorkspace: null, connection: null })) } as unknown as DesktopApi} headingRef={React.createRef()} accounts={[account]} />, 'en');
    const slot = screen.getByLabelText('Primary Admin account slot');
    expect(slot.querySelector('.account-role-heading')?.textContent).toContain('Known Admin');
    expect(slot.querySelector('.account-role-heading')?.textContent).not.toContain('Not logged in');
    expect(slot.textContent).toContain('Connection status: Logged out');
    expect(screen.getByLabelText('Agent account slot').querySelector('.account-role-heading')?.textContent).toContain('Not logged in');
  });

  it('shows the historical import bar only during the initial import and aligns active controls with the submitted count', () => {
    const account: LineAccountSummary = { accountId: 'admin-1', displayName: 'Known Admin', status: 'disconnected', lastSyncedAt: null,
      mode: 'MONITOR_ONLY', productRole: 'PRIMARY_ADMIN', hasVerifiedLineIdentity: true, canStartExternalImport: true,
      officialLineBuild: { version: '26.5.0.3975', status: 'accepted' },
      externalImportProgress: { stage: 'monitoring', copiedBytes: null, totalBytes: null, committedRows: '42', eligibleRows: '120', message: null } };
    renderWithStartupLocale(<Settings api={{ getDatabaseSetupStatus: vi.fn(async () => ({ configured: false, attachmentRoot: null, agentWorkspace: null, connection: null })) } as unknown as DesktopApi} headingRef={React.createRef()} accounts={[account]} />, 'en');
    expect(screen.getByLabelText('Primary Admin account slot').textContent).toContain('Connection status: External monitoring');
    const monitorCard = screen.getByRole('region', { name: 'External monitoring' });
    expect(monitorCard.textContent).toContain('LINE version: 26.5.0.3975');
    expect(within(monitorCard).queryByRole('heading', { name: 'Monitoring' })).toBeNull();
    const submitted = within(monitorCard).getByText('Committed: 42 / 120 messages');
    const layout = submitted.closest('.external-monitor-layout')!;
    expect(layout.querySelector('.external-monitor-count')).toBe(submitted);
    expect(layout.querySelector('progress[aria-label="Message history import progress"]')).toBeNull();
    expect(layout.querySelector('.external-monitor-indicator')?.textContent).toBe('Monitoring');
    expect(within(layout as HTMLElement).getByRole('button', { name: 'Stop external monitoring' })).toBeTruthy();
    const countRow = submitted.parentElement!;
    expect(countRow.querySelector('.external-monitor-indicator')).toBeTruthy();
    const countRowRule = readFileSync(new NodeURL('../styles.css', import.meta.url), 'utf8').match(/\.external-monitor-count-row\{([^}]*)\}/)?.[1] ?? '';
    expect(countRowRule).toContain('justify-content:space-between');
    expect(within(screen.getByLabelText('Primary Admin account slot')).queryByText('Set administrator from LINE and start external monitoring')).toBeNull();
  });

  it('shows the external monitoring connection label while the admin is syncing', () => {
    const account: LineAccountSummary = { accountId: 'admin-1', displayName: 'Known Admin', status: 'disconnected', lastSyncedAt: null,
      mode: 'MONITOR_ONLY', productRole: 'PRIMARY_ADMIN', hasVerifiedLineIdentity: true, canStartExternalImport: true,
      externalImportProgress: { stage: 'syncing', copiedBytes: null, totalBytes: null, committedRows: '42', eligibleRows: '120', message: null } };
    renderWithStartupLocale(<Settings api={{ getDatabaseSetupStatus: vi.fn(async () => ({ configured: false, attachmentRoot: null, agentWorkspace: null, connection: null })) } as unknown as DesktopApi} headingRef={React.createRef()} accounts={[account]} />, 'en');
    expect(screen.getByLabelText('Primary Admin account slot').textContent).toContain('Connection status: External monitoring');
  });

  it.each(['counting_rows', 'importing_history'] as const)('shows historical import progress above the submitted count during %s', (stage) => {
    const account: LineAccountSummary = { accountId: 'admin-1', displayName: 'Known Admin', status: 'disconnected', lastSyncedAt: null,
      mode: 'MONITOR_ONLY', productRole: 'PRIMARY_ADMIN', hasVerifiedLineIdentity: true, canStartExternalImport: true,
      externalImportProgress: { stage, copiedBytes: null, totalBytes: null, committedRows: '42', eligibleRows: '120', message: null } };
    renderWithStartupLocale(<Settings api={{ getDatabaseSetupStatus: vi.fn(async () => ({ configured: false, attachmentRoot: null, agentWorkspace: null, connection: null })) } as unknown as DesktopApi} headingRef={React.createRef()} accounts={[account]} />, 'en');
    const monitorCard = screen.getByRole('region', { name: 'External monitoring' });
    const progress = within(monitorCard).getByRole('progressbar', { name: 'Message history import progress' });
    const submitted = within(monitorCard).getByText('Committed: 42 / 120 messages');
    const layout = submitted.closest('.external-monitor-layout')!;
    expect(layout.firstElementChild).toBe(progress);
    expect(layout.querySelector('.external-monitor-count-row')?.contains(submitted)).toBe(true);
  });

  it('does not show a historical import bar after the import completes', () => {
    const account: LineAccountSummary = { accountId: 'admin-1', displayName: 'Known Admin', status: 'disconnected', lastSyncedAt: null,
      mode: 'MONITOR_ONLY', productRole: 'PRIMARY_ADMIN', hasVerifiedLineIdentity: true, canStartExternalImport: true,
      externalImportProgress: { stage: 'complete', copiedBytes: null, totalBytes: null, committedRows: '120', eligibleRows: '120', message: null } };
    renderWithStartupLocale(<Settings api={{ getDatabaseSetupStatus: vi.fn(async () => ({ configured: false, attachmentRoot: null, agentWorkspace: null, connection: null })) } as unknown as DesktopApi} headingRef={React.createRef()} accounts={[account]} />, 'en');
    const monitorCard = screen.getByRole('region', { name: 'External monitoring' });
    expect(within(monitorCard).queryByRole('progressbar', { name: 'Message history import progress' })).toBeNull();
    expect(within(monitorCard).getByText('Committed: 120 / 120 messages')).toBeTruthy();
  });

  describe('embedded password change', () => {
    const embeddedApi = (overrides: Record<string, unknown>) => ({
      getDatabaseSetupStatus: vi.fn(async () => ({ configured: true, attachmentRoot: 'D:\\data\\attachments', agentWorkspace: 'D:\\data\\workspace',
        connection: { host: '127.0.0.1', port: 55432, username: 'line_agent_admin', ssl: 'disable' as const, database: 'line_agent' }, embedded: { version: '18.6', port: 55432 } })),
      changeEmbeddedPassword: vi.fn(async () => undefined),
      restartApplication: vi.fn(async () => undefined),
      ...overrides,
    }) as unknown as DesktopApi & { changeEmbeddedPassword: ReturnType<typeof vi.fn>; restartApplication: ReturnType<typeof vi.fn> };
    const openDialog = async (api: DesktopApi) => {
      render(<Settings api={api} headingRef={React.createRef()} />);
      fireEvent.click(await screen.findByRole('button', { name: '變更密碼' }));
      return screen.findByRole('dialog', { name: '變更密碼' });
    };

    it('validates length and confirmation before sending anything', async () => {
      const api = embeddedApi({});
      const dialog = await openDialog(api);
      fireEvent.change(within(dialog).getByLabelText('新密碼'), { target: { value: 'short' } });
      fireEvent.change(within(dialog).getByLabelText('確認新密碼'), { target: { value: 'short' } });
      fireEvent.click(within(dialog).getByRole('button', { name: '變更' }));
      expect(within(dialog).getByRole('alert').textContent).toBe('密碼需為 8–128 個字元。');
      fireEvent.change(within(dialog).getByLabelText('新密碼'), { target: { value: 'long-enough-1' } });
      fireEvent.change(within(dialog).getByLabelText('確認新密碼'), { target: { value: 'long-enough-2' } });
      fireEvent.click(within(dialog).getByRole('button', { name: '變更' }));
      expect(within(dialog).getByRole('alert').textContent).toBe('兩次輸入的密碼不一致。');
      expect(api.changeEmbeddedPassword).not.toHaveBeenCalled();
      fireEvent.click(within(dialog).getByRole('button', { name: '取消' }));
      expect(screen.queryByRole('dialog')).toBeNull();
    });

    it.each(['密碼密碼密碼密碼', 'abcdefgé1', 'abcdefg\u0007h'])('rejects a non-ASCII or control-character password: %j', async (value) => {
      const api = embeddedApi({});
      const dialog = await openDialog(api);
      fireEvent.change(within(dialog).getByLabelText('新密碼'), { target: { value } });
      fireEvent.change(within(dialog).getByLabelText('確認新密碼'), { target: { value } });
      fireEvent.click(within(dialog).getByRole('button', { name: '變更' }));
      expect(within(dialog).getByRole('alert').textContent).toBe('密碼需為 8–128 個字元。');
      expect(api.changeEmbeddedPassword).not.toHaveBeenCalled();
    });

    it('changes the password, shows the success text and restarts', async () => {
      const api = embeddedApi({});
      const dialog = await openDialog(api);
      fireEvent.change(within(dialog).getByLabelText('新密碼'), { target: { value: 'long-enough-1' } });
      fireEvent.change(within(dialog).getByLabelText('確認新密碼'), { target: { value: 'long-enough-1' } });
      fireEvent.click(within(dialog).getByRole('button', { name: '變更' }));
      expect(await within(dialog).findByText('密碼已變更，正在重新啟動…')).toBeTruthy();
      expect(api.changeEmbeddedPassword).toHaveBeenCalledWith('long-enough-1');
      await waitFor(() => expect(api.restartApplication).toHaveBeenCalledOnce());
      expect(document.body.textContent).not.toContain('long-enough-1');
    });

    it('shows the failure text and the error code without restarting', async () => {
      const api = embeddedApi({ changeEmbeddedPassword: vi.fn(async () => { throw Object.assign(new Error('x'), { errorCode: 'pg_password_save_failed' }); }) });
      const dialog = await openDialog(api);
      fireEvent.change(within(dialog).getByLabelText('新密碼'), { target: { value: 'long-enough-1' } });
      fireEvent.change(within(dialog).getByLabelText('確認新密碼'), { target: { value: 'long-enough-1' } });
      fireEvent.click(within(dialog).getByRole('button', { name: '變更' }));
      const alert = await within(dialog).findByRole('alert');
      expect(alert.textContent).toContain('變更密碼失敗。');
      expect(alert.textContent).toContain('錯誤代碼：pg_password_save_failed');
      expect(api.restartApplication).not.toHaveBeenCalled();
    });
  });

  it('shows the product name and packaged version in the About tab', () => {
    vi.stubGlobal('__APP_VERSION__', desktopVersion);
    const api = {
      getDatabaseSetupStatus: vi.fn(async () => ({ configured: true, attachmentRoot: null, agentWorkspace: null, connection: { host: 'localhost', port: 5432, username: 'postgres', ssl: 'disable' as const, database: 'line_agent' } })),
    } as unknown as DesktopApi;
    render(<Settings api={api} headingRef={React.createRef()} />);

    fireEvent.click(screen.getByRole('tab', { name: '關於' }));

    expect(screen.getByText('LINE Agent Assistant')).toBeTruthy();
    expect(screen.getByRole('tabpanel').textContent).toContain(desktopVersion);
    expect(screen.getByRole('heading', { name: '非官方聲明' })).toBeTruthy();
    expect(screen.getByRole('tabpanel').textContent).toContain('LINE Agent Assistant 為獨立開發的第三方工具，與 LINE 服務及其營運公司 LY Corporation 無隸屬、合作、贊助或背書關係。LINE 名稱及相關商標屬其權利人所有；本程式提及 LINE 僅用於說明相容服務。');
  });

  it('describes an unknown Agent provider as checked at execution time', async () => {
    const api = {
      getDatabaseSetupStatus: vi.fn(async () => ({ configured: true, attachmentRoot: 'D:\\attachments', agentWorkspace: 'D:\\workspace', connection: { host: 'localhost', port: 5432, username: 'postgres', ssl: 'disable' as const, database: 'line_agent' } })),
      setWorkspace: vi.fn(), setDefaultAgent: vi.fn(), agentLogin: vi.fn(), agentLogout: vi.fn(),
    } as unknown as DesktopApi;
    render(<Settings api={api} headingRef={React.createRef()} providers={[
      { provider: 'codex', status: 'unknown', detail: null },
    ]} />);
    fireEvent.click(screen.getByRole('tab', { name: '助理' }));
    expect(screen.getByText('執行時檢查')).toBeTruthy();
    expect(screen.queryByText('尚未觀察 CLI 登入狀態；執行結果會反映實際可用性。')).toBeNull();
    expect(screen.getByRole('button', { name: '重新檢查 Codex' })).toBeTruthy();
  });

  it('hides manual MCP token issuance controls while keeping the endpoint', async () => {
    const tokenSummary: import('@line-agent/contracts').McpTokenSummary = {
      tokenId: '11111111-1111-4111-8111-111111111111',
      principalId: 'external:laptop-1',
      deviceLabel: 'Analyst MacBook',
      accountScopes: ['account-admin'],
      toolScopes: ['list_targets', 'query_target_messages', 'query_target_messages_by_time'],
      grantVersion: 1,
      state: 'ACTIVE',
      expiresAt: '2026-10-20T00:00:00.000Z',
      revokedAt: null,
      lastUsedAt: null,
      createdAt: '2026-10-17T00:00:00.000Z',
    };
    let tokens: import('@line-agent/contracts').McpTokenSummary[] = [tokenSummary];
    const plaintextSecret = 'la_mcp_' + 'Z'.repeat(43);
    const api = {
      getDatabaseSetupStatus: vi.fn(async () => ({
        configured: true,
        attachmentRoot: 'D:\\attachments',
        agentWorkspace: 'D:\\workspace',
        connection: { host: 'localhost', port: 5432, username: 'postgres', ssl: 'disable' as const, database: 'line_agent' },
      })),
      mcpGetStatus: vi.fn(async () => ({
        running: true,
        endpoint: 'http://127.0.0.1:38471/mcp',
        host: '127.0.0.1' as const,
        port: 38471,
        activeTokenCount: 1,
        inFlightRequests: 0,
        maxConcurrentRequests: 8,
      })),
      mcpListTokens: vi.fn(async () => tokens),
      mcpIssueToken: vi.fn(async (input: Parameters<DesktopApi['mcpIssueToken']>[0]) => {
        const created = {
          ...tokenSummary,
          tokenId: '22222222-2222-4222-8222-222222222222',
          deviceLabel: input.deviceLabel,
          accountScopes: input.accountScopes,
          expiresAt: input.expiration.mode === 'never' ? null : tokenSummary.expiresAt,
        };
        tokens = [created, ...tokens];
        return { token: created, plaintextToken: plaintextSecret };
      }),
      mcpRevokeToken: vi.fn(async (tokenId: string) => {
        tokens = tokens.map((item) =>
          item.tokenId === tokenId ? { ...item, state: 'REVOKED' as const, revokedAt: '2026-10-17T12:00:00.000Z' } : item,
        );
        return true;
      }),
    } as unknown as DesktopApi;

    render(
      <Settings
        api={api}
        headingRef={React.createRef()}
        accounts={[
          { accountId: 'account-agent', displayName: 'Agent LINE', status: 'connected', lastSyncedAt: null, mode: 'ACTIVE_CONTROL', productRole: 'AGENT' },
          { accountId: 'account-admin', displayName: 'Admin LINE', status: 'connected', lastSyncedAt: null, mode: 'MONITOR_ONLY', productRole: 'PRIMARY_ADMIN' },
          { accountId: 'account-unknown', displayName: 'Private LINE', status: 'connected', lastSyncedAt: null, mode: 'MONITOR_ONLY', productRole: null },
        ]}
      />,
    );
    fireEvent.click(screen.getByRole('tab', { name: '助理' }));

    expect(await screen.findByText('http://127.0.0.1:38471/mcp')).toBeTruthy();
    expect(screen.queryByText('Analyst MacBook')).toBeNull();
    expect(screen.queryByLabelText('設備／Agent 名稱')).toBeNull();
    expect(screen.queryByText('Token 有效期限')).toBeNull();
    expect(screen.queryByRole('radio', { name: '限制時間' })).toBeNull();
    expect(screen.queryByLabelText('有效時數（小時）')).toBeNull();
    expect(screen.queryByRole('button', { name: '核發 MCP Token' })).toBeNull();
    expect(screen.queryByText('帳號授權')).toBeNull();
    expect(screen.queryByText('工具授權')).toBeNull();
    expect(screen.queryByRole('button', { name: /撤銷 Token/ })).toBeNull();
    expect(screen.queryByText(plaintextSecret)).toBeNull();
    expect(api.mcpIssueToken).not.toHaveBeenCalled();
  });

  it('shows only stable role scopes for local clients and excludes retired accounts', async () => {
    const api = {
      getDatabaseSetupStatus: vi.fn(async () => ({ configured: true, attachmentRoot: null, agentWorkspace: null, connection: { host: 'localhost', port: 5432, username: 'postgres', ssl: 'disable' as const, database: 'line_agent' } })),
      mcpGetStatus: vi.fn(async () => ({ running: true, endpoint: 'http://127.0.0.1:38471/mcp', host: '127.0.0.1' as const, port: 38471, activeTokenCount: 0, inFlightRequests: 0, maxConcurrentRequests: 8 })),
      mcpListTokens: vi.fn(async () => []),
      mcpLocalClientStatus: vi.fn(async () => [
        { client: 'claude-desktop' as const, installed: true, connected: false, tokenId: null, accountScopes: [] },
        { client: 'codex' as const, installed: true, connected: true, tokenId: '11111111-1111-4111-8111-111111111111', accountScopes: ['account-agent'] },
      ]),
      mcpLocalClientConnect: vi.fn(async (client: 'claude-desktop' | 'codex', accountScopes: string[]) => ({ client, installed: true, connected: true, tokenId: '22222222-2222-4222-8222-222222222222', accountScopes })),
      mcpLocalClientDisconnect: vi.fn(async () => undefined),
    } as unknown as DesktopApi;
    const accounts = [
      { accountId: 'account-agent', displayName: 'Agent LINE', status: 'connected', lastSyncedAt: null, mode: 'ACTIVE_CONTROL', productRole: 'AGENT' },
      { accountId: 'account-admin', displayName: 'Admin LINE', status: 'connected', lastSyncedAt: null, mode: 'MONITOR_ONLY', productRole: 'PRIMARY_ADMIN' },
      { accountId: 'retired-agent', displayName: 'Retired Agent', status: 'disconnected', lastSyncedAt: null, mode: 'PAUSED', productRole: null },
    ] as unknown as import('@line-agent/contracts').LineAccountSummary[];
    const rendered = render(<Settings api={api} headingRef={React.createRef()} accounts={accounts} />);
    fireEvent.click(screen.getByRole('tab', { name: '助理' }));
    expect(screen.queryByText('需重新啟動 Claude Desktop／Codex 後生效')).toBeNull();
    const card = await screen.findByRole('region', { name: 'Claude Desktop MCP 連線' });
    const codexCard = await screen.findByRole('region', { name: 'Codex MCP 連線' });
    expect(within(card).queryByText(/已連接・帳號範圍|未連接/, { selector: 'p' })).toBeNull();
    expect(within(card).getByText('未連接', { selector: '.badge' })).toBeTruthy();
    expect(within(codexCard).queryByText(/已連接・帳號範圍/, { selector: 'p' })).toBeNull();
    expect(within(codexCard).getByText('已連接', { selector: '.badge' })).toBeTruthy();
    expect(within(card).getByText('帳號範圍')).toBeTruthy();
    expect(within(card).getByRole('checkbox', { name: 'Claude Desktop AGENT帳號' })).toHaveProperty('checked', true);
    expect(within(card).getByRole('checkbox', { name: 'Claude Desktop 管理員帳號' })).toHaveProperty('checked', true);
    expect(within(card).queryByRole('checkbox', { name: 'Claude Desktop Retired Agent' })).toBeNull();
    fireEvent.click(within(card).getByRole('button', { name: '連接' }));
    await waitFor(() => expect(api.mcpLocalClientConnect).toHaveBeenCalledWith('claude-desktop', ['role:AGENT', 'role:PRIMARY_ADMIN']));
    expect(screen.getByText('需重新啟動 Claude Desktop／Codex 後生效')).toBeTruthy();
    fireEvent.click(screen.getByRole('tab', { name: '指令' }));
    expect(screen.queryByText('需重新啟動 Claude Desktop／Codex 後生效')).toBeNull();
    fireEvent.click(screen.getByRole('tab', { name: '助理' }));
    expect(await screen.findByText('需重新啟動 Claude Desktop／Codex 後生效')).toBeTruthy();
    rendered.unmount();
    render(<Settings api={api} headingRef={React.createRef()} accounts={accounts} />);
    fireEvent.click(screen.getByRole('tab', { name: '助理' }));
    expect(screen.queryByText('需重新啟動 Claude Desktop／Codex 後生效')).toBeNull();
  });
  it('shows both fixed role rows when only one real account exists and grants no missing role', async () => {
    const api = {
      getDatabaseSetupStatus: vi.fn(async () => ({ configured: true, attachmentRoot: null, agentWorkspace: null, connection: { host: 'localhost', port: 5432, username: 'postgres', ssl: 'disable' as const, database: 'line_agent' } })),
      mcpGetStatus: vi.fn(async () => ({ running: true, endpoint: 'http://127.0.0.1:38471/mcp', host: '127.0.0.1' as const, port: 38471, activeTokenCount: 0, inFlightRequests: 0, maxConcurrentRequests: 8 })),
      mcpListTokens: vi.fn(async () => []),
      mcpLocalClientStatus: vi.fn(async () => [
        { client: 'claude-desktop' as const, installed: true, connected: false, tokenId: null, accountScopes: [] },
        { client: 'codex' as const, installed: true, connected: false, tokenId: null, accountScopes: [] },
      ]),
      mcpLocalClientConnect: vi.fn(async (client: 'claude-desktop' | 'codex', accountScopes: string[]) => ({ client, installed: true, connected: true, tokenId: null, accountScopes })),
    } as unknown as DesktopApi;
    const account = { accountId: 'account-agent', displayName: 'Agent LINE', status: 'connected', lastSyncedAt: null, mode: 'ACTIVE_CONTROL', productRole: 'AGENT' } as unknown as import('@line-agent/contracts').LineAccountSummary;
    const style = document.createElement('style');
    style.dataset.settingsLayoutTest = 'true';
    // Load the full cascade so the generic .panel label column direction is exercised.
    style.textContent = readFileSync(new NodeURL('../styles.css', import.meta.url), 'utf8');
    document.head.append(style);
    render(<Settings api={api} headingRef={React.createRef()} accounts={[account]} />);
    fireEvent.click(screen.getByRole('tab', { name: '助理' }));
    const card = await screen.findByRole('region', { name: 'Claude Desktop MCP 連線' });
    const roleCheckboxes = within(card).getAllByRole('checkbox');
    expect(roleCheckboxes.map((checkbox) => checkbox.getAttribute('aria-label'))).toEqual([
      'Claude Desktop AGENT帳號',
      'Claude Desktop 管理員帳號（尚未新增）',
    ]);
    expect(roleCheckboxes[0]).toHaveProperty('checked', true);
    expect(roleCheckboxes[1]).toHaveProperty('checked', false);
    expect(roleCheckboxes[1]).toHaveProperty('disabled', true);
    expect(roleCheckboxes[1]!.getAttribute('aria-label')).toContain('尚未新增');
    expect(within(card).queryByText('（尚未新增）')).toBeNull();
    const roleLabels = roleCheckboxes.map((checkbox) => checkbox.closest('label') as HTMLLabelElement);
    expect(roleLabels.map((label) => getComputedStyle(label).flexDirection)).toEqual(['row', 'row']);
    const scopePicker = card.querySelector('.mcp-local-scope-picker') as HTMLElement;
    // A 320px card leaves 292px inside its padding; two 132px tracks plus the 12px gap fit.
    expect(getComputedStyle(scopePicker).gridTemplateColumns).toContain('132px');
    fireEvent.click(within(card).getByRole('button', { name: '連接' }));
    await waitFor(() => expect(api.mcpLocalClientConnect).toHaveBeenCalledWith('claude-desktop', ['role:AGENT']));
  });
  it('does not show the restart note when connecting a local MCP client fails', async () => {
    const api = {
      getDatabaseSetupStatus: vi.fn(async () => ({ configured: true, attachmentRoot: null, agentWorkspace: null, connection: { host: 'localhost', port: 5432, username: 'postgres', ssl: 'disable' as const, database: 'line_agent' } })),
      mcpGetStatus: vi.fn(async () => ({ running: true, endpoint: 'http://127.0.0.1:38471/mcp', host: '127.0.0.1' as const, port: 38471, activeTokenCount: 0, inFlightRequests: 0, maxConcurrentRequests: 8 })),
      mcpListTokens: vi.fn(async () => []),
      mcpLocalClientStatus: vi.fn(async () => [{ client: 'claude-desktop' as const, installed: true, connected: false, tokenId: null, accountScopes: [] }]),
      mcpLocalClientConnect: vi.fn(async () => { throw new Error('connect failed'); }),
    } as unknown as DesktopApi;
    const account = { accountId: 'account-agent', displayName: 'Agent LINE', status: 'connected', lastSyncedAt: null, mode: 'ACTIVE_CONTROL', productRole: 'AGENT' } as unknown as import('@line-agent/contracts').LineAccountSummary;
    render(<Settings api={api} headingRef={React.createRef()} accounts={[account]} />);
    fireEvent.click(screen.getByRole('tab', { name: '助理' }));
    const card = await screen.findByRole('region', { name: 'Claude Desktop MCP 連線' });
    fireEvent.click(within(card).getByRole('button', { name: '連接' }));
    await waitFor(() => expect(screen.getByRole('status').textContent).toContain('無法更新本機 MCP 連線設定'));
    expect(screen.queryByText('需重新啟動 Claude Desktop／Codex 後生效')).toBeNull();
  });
  it('refreshes the MCP token count badge after connect and disconnect', async () => {
    const statusWith = (activeTokenCount: number) => ({ running: true, endpoint: 'http://127.0.0.1:38471/mcp', host: '127.0.0.1' as const, port: 38471, activeTokenCount, inFlightRequests: 0, maxConcurrentRequests: 8 });
    const mcpGetStatus = vi.fn()
      .mockResolvedValueOnce(statusWith(0))
      .mockResolvedValueOnce(statusWith(1))
      .mockResolvedValueOnce(statusWith(0));
    const api = {
      getDatabaseSetupStatus: vi.fn(async () => ({ configured: true, attachmentRoot: null, agentWorkspace: null, connection: { host: 'localhost', port: 5432, username: 'postgres', ssl: 'disable' as const, database: 'line_agent' } })),
      mcpGetStatus,
      mcpListTokens: vi.fn(async () => []),
      mcpLocalClientStatus: vi.fn(async () => [
        { client: 'claude-desktop' as const, installed: true, connected: false, tokenId: null, accountScopes: [] },
        { client: 'codex' as const, installed: true, connected: false, tokenId: null, accountScopes: [] },
      ]),
      mcpLocalClientConnect: vi.fn(async (client: 'claude-desktop' | 'codex', accountScopes: string[]) => ({ client, installed: true, connected: true, tokenId: '22222222-2222-4222-8222-222222222222', accountScopes })),
      mcpLocalClientDisconnect: vi.fn(async () => undefined),
    } as unknown as DesktopApi;
    const account = { accountId: 'account-A', displayName: 'LINE 帳號 A', productRole: 'AGENT' } as unknown as import('@line-agent/contracts').LineAccountSummary;
    render(<Settings api={api} headingRef={React.createRef()} accounts={[account]} />);
    fireEvent.click(screen.getByRole('tab', { name: '助理' }));
    expect(await screen.findByText('運行中 (0 個有效 Token)')).toBeTruthy();
    const mcpHeading = screen.getByRole('heading', { name: 'MCP 伺服器與外部 Agent 授權' });
    const statusBadge = screen.getByText('運行中 (0 個有效 Token)');
    expect(mcpHeading.closest('.panel-top')?.contains(statusBadge)).toBe(true);
    expect(screen.queryByText('僅綁定本機 Loopback。')).toBeNull();
    const card = await screen.findByRole('region', { name: 'Claude Desktop MCP 連線' });
    fireEvent.click(within(card).getByRole('button', { name: '連接' }));
    expect(await screen.findByText('運行中 (1 個有效 Token)')).toBeTruthy();
    fireEvent.click(within(card).getByRole('button', { name: '中斷連接' }));
    expect(await screen.findByText('運行中 (0 個有效 Token)')).toBeTruthy();
    expect(mcpGetStatus).toHaveBeenCalledTimes(3);
  });
  it('keeps stable role selections independent across equivalent account snapshots', async () => {
    const api = {
      getDatabaseSetupStatus: vi.fn(async () => ({ configured: true, attachmentRoot: null, agentWorkspace: null, connection: { host: 'localhost', port: 5432, username: 'postgres', ssl: 'disable' as const, database: 'line_agent' } })),
      mcpGetStatus: vi.fn(async () => ({ running: true, endpoint: 'http://127.0.0.1:38471/mcp', host: '127.0.0.1' as const, port: 38471, activeTokenCount: 0, inFlightRequests: 0, maxConcurrentRequests: 8 })),
      mcpListTokens: vi.fn(async () => []),
      mcpLocalClientStatus: vi.fn(async () => [
        { client: 'claude-desktop' as const, installed: true, connected: false, tokenId: null, accountScopes: [] },
        { client: 'codex' as const, installed: true, connected: false, tokenId: null, accountScopes: [] },
      ]),
      mcpLocalClientConnect: vi.fn(async (client: 'claude-desktop' | 'codex', accountScopes: string[]) => ({ client, installed: true, connected: true, tokenId: null, accountScopes })),
    } as unknown as DesktopApi;
    const a = { accountId: 'A', displayName: 'Account A', status: 'connected' as const, lastSyncedAt: null, mode: 'ACTIVE_CONTROL' as const, productRole: 'AGENT' as const };
    const b = { accountId: 'B', displayName: 'Account B', status: 'connected' as const, lastSyncedAt: null, mode: 'MONITOR_ONLY' as const, productRole: 'PRIMARY_ADMIN' as const };
    const view = render(<Settings api={api} headingRef={React.createRef()} accounts={[a, b]} />);
    fireEvent.click(screen.getByRole('tab', { name: '助理' }));
    const findCard = (client: string) => screen.getAllByRole('region').find((item) => item.getAttribute('aria-label')?.startsWith(`${client} MCP`))!;
    await waitFor(() => expect(findCard('Claude Desktop')).toBeTruthy());
    const claude = findCard('Claude Desktop');
    const codex = findCard('Codex');
    fireEvent.click(within(claude).getByRole('checkbox', { name: 'Claude Desktop 管理員帳號' }));
    expect(within(codex).getByRole('checkbox', { name: 'Codex 管理員帳號' })).toHaveProperty('checked', true);
    view.rerender(<Settings api={api} headingRef={React.createRef()} accounts={[{ ...a }, { ...b }]} />);
    const updatedClaude = findCard('Claude Desktop');
    expect(within(updatedClaude).getByRole('checkbox', { name: 'Claude Desktop 管理員帳號' })).toHaveProperty('checked', false);
    view.rerender(<Settings api={api} headingRef={React.createRef()} accounts={[{ ...a }]} />);
    fireEvent.click(within(findCard('Claude Desktop')).getAllByRole('button')[0]!);
    await waitFor(() => expect(api.mcpLocalClientConnect).toHaveBeenCalledWith('claude-desktop', ['role:AGENT']));
  });
});
