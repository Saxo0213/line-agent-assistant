// @vitest-environment jsdom
import React from 'react';
import { cleanup, fireEvent, render as renderUi, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AgentExtensionsState, AgentMcpImportListing, AgentMcpServerSummary } from '@line-agent/contracts';
import type { DesktopApi } from '../../preload/api.js';
import { ENGLISH_EXTENSIONS_COPY, JAPANESE_EXTENSIONS_COPY, KOREAN_EXTENSIONS_COPY, TRADITIONAL_CHINESE_EXTENSIONS_COPY } from '../../desktop-extensions-copy.js';
import { LocaleProvider, type LocaleState } from '../locale-context.js';
import { AgentExtensionsSettings, buildServerInput, validateServerForm } from './AgentExtensionsSettings.js';

afterEach(cleanup);

const files: AgentMcpServerSummary = { id: '8f1b6f5e-6b0a-4c3a-9d49-2c2f5c9f9f10', name: 'files', transport: 'stdio', command: 'node', args: ['server.js'], env: { API_KEY: '********' }, headers: {}, enabled: true, source: 'claude-code', providers: ['claude', 'codex'] };
const remote: AgentMcpServerSummary = { id: '9a1b6f5e-6b0a-4c3a-9d49-2c2f5c9f9f11', name: 'remote', transport: 'http', args: [], env: {}, url: 'https://example.com/mcp', headers: { Authorization: '********' }, enabled: false, source: 'manual', providers: ['claude'] };
const off = { webSearch: false, webFetch: false, bash: false, fileRead: false, fileWrite: false };

const ok = (type: string, extra: object = {}) => ({ type, requestId: 'r', ok: true, ...extra });
const err = (code: string) => ({ type: 'error', requestId: 'r', ok: false, code, message: 'x', retryable: false });
function setup(options: { state?: AgentExtensionsState; level?: 'read_only' | 'workspace_write' | 'trust' | 'full'; listing?: AgentMcpImportListing; locale?: 'zh-TW' | 'en' | 'ja' | 'ko'; save?: (input: unknown) => unknown } = {}) {
  const state: AgentExtensionsState = options.state ?? { servers: [files, remote], tools: off };
  const api = {
    getAgentExtensions: vi.fn(async () => state),
    getAgentExecutionPolicy: vi.fn(async () => ({ level: options.level ?? 'read_only' })),
    onEvent: vi.fn(() => () => undefined),
    saveAgentMcpServer: vi.fn(async (input: unknown) => options.save ? options.save(input) : ok('saveAgentMcpServer', { server: files })),
    deleteAgentMcpServer: vi.fn(async () => ok('deleteAgentMcpServer')),
    setAgentMcpServerEnabled: vi.fn(async () => ok('setAgentMcpServerEnabled', { server: files })),
    setAgentExtensionTools: vi.fn(async (tools: object) => ok('setAgentExtensionTools', { tools })),
    listAgentMcpImportCandidates: vi.fn(async () => options.listing ?? { sources: [] }),
    importAgentMcpServers: vi.fn(async () => ok('importAgentMcpServers', { result: { imported: ['alpha'], skipped: [] } })),
  } as unknown as DesktopApi;
  const locale = options.locale ?? 'zh-TW';
  const value: LocaleState = { status: 'loaded', effectiveLocale: locale, preference: locale, busy: false, error: null, retry() {}, retryRestart() {}, setPreference() {} };
  renderUi(<LocaleProvider value={value}><AgentExtensionsSettings api={api} /></LocaleProvider>);
  return api;
}
const T = TRADITIONAL_CHINESE_EXTENSIONS_COPY;

describe('AgentExtensionsSettings', () => {
  it('renders the section, the note, the server rows and the buttons', async () => {
    setup();
    expect(await screen.findByRole('heading', { name: 'Agent 擴充工具' })).toBeTruthy();
    expect(screen.getByText('只有主要管理者、助理室與排程觸發的 Agent 可使用；群組成員與自由模式不會載入。')).toBeTruthy();
    const rows = within(screen.getByRole('list', { name: T.listLabel })).getAllByRole('listitem');
    expect(rows).toHaveLength(2);
    expect(within(rows[0]!).getByText('files')).toBeTruthy();
    expect(within(rows[0]!).getByText('Claude Code')).toBeTruthy();
    expect(within(rows[0]!).getByText('stdio')).toBeTruthy();
    expect(within(rows[0]!).getByText('適用於 Claude / Codex')).toBeTruthy();
    expect(within(rows[1]!).getByText('手動')).toBeTruthy();
    expect(within(rows[1]!).getByText('HTTP')).toBeTruthy();
    expect(screen.getByRole('switch', { name: '啟用 files' }).getAttribute('aria-checked')).toBe('true');
    expect(screen.getByRole('switch', { name: '啟用 remote' }).getAttribute('aria-checked')).toBe('false');
    expect(screen.getByRole('button', { name: '從本機匯入' })).toBeTruthy();
    expect(screen.getByRole('button', { name: '手動新增' })).toBeTruthy();
  });

  it('toggles a server through the API', async () => {
    const api = setup();
    fireEvent.click(await screen.findByRole('switch', { name: '啟用 remote' }));
    await waitFor(() => expect(api.setAgentMcpServerEnabled).toHaveBeenCalledWith(remote.id, true));
  });

  it('validates the add dialog inline and saves a valid stdio server with its secrets', async () => {
    const api = setup({ state: { servers: [files], tools: off } });
    fireEvent.click(await screen.findByRole('button', { name: '手動新增' }));
    const dialog = await screen.findByRole('dialog', { name: '新增 MCP 伺服器' });
    fireEvent.click(within(dialog).getByRole('button', { name: '儲存' }));
    expect(within(dialog).getByText(T.errNameInvalid)).toBeTruthy();
    expect(within(dialog).getByText(T.errCommandRequired)).toBeTruthy();
    expect(api.saveAgentMcpServer).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(within(dialog).getByLabelText('名稱'));

    fireEvent.change(within(dialog).getByLabelText('名稱'), { target: { value: 'linejs' } });
    expect(within(dialog).getByText(T.errNameReserved)).toBeTruthy();
    fireEvent.change(within(dialog).getByLabelText('名稱'), { target: { value: 'files' } });
    expect(within(dialog).getByText(T.errNameTaken)).toBeTruthy();
    fireEvent.change(within(dialog).getByLabelText('名稱'), { target: { value: 'notes' } });
    fireEvent.change(within(dialog).getByLabelText('指令'), { target: { value: 'node' } });
    fireEvent.change(within(dialog).getByLabelText('參數（每行一個）'), { target: { value: 'a.js\n\n--x' } });
    fireEvent.click(within(dialog).getByRole('button', { name: '新增' }));
    fireEvent.change(within(dialog).getByLabelText('名稱', { selector: 'input[name="env-key-0"]' }), { target: { value: 'API_KEY' } });
    fireEvent.click(within(dialog).getByRole('button', { name: '儲存' }));
    expect(within(dialog).getByText(T.errValueRequired)).toBeTruthy();
    fireEvent.change(within(dialog).getByLabelText('值', { selector: 'input[name="env-value-0"]' }), { target: { value: 'sk-1' } });
    fireEvent.click(within(dialog).getByRole('button', { name: '儲存' }));
    await waitFor(() => expect(api.saveAgentMcpServer).toHaveBeenCalledWith({
      name: 'notes', transport: 'stdio', enabled: true, providers: ['claude', 'codex'], args: ['a.js', '--x'], env: { API_KEY: 'sk-1' }, headers: {}, command: 'node' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });

  it('validates http servers: the URL scheme, header names and at least one provider', async () => {
    setup({ state: { servers: [], tools: off } });
    fireEvent.click(await screen.findByRole('button', { name: '手動新增' }));
    const dialog = await screen.findByRole('dialog');
    fireEvent.click(within(dialog).getByRole('radio', { name: '遠端（HTTP）' }));
    fireEvent.change(within(dialog).getByLabelText('名稱'), { target: { value: 'web' } });
    fireEvent.change(within(dialog).getByLabelText('網址'), { target: { value: 'ftp://example.com' } });
    fireEvent.click(within(dialog).getByRole('checkbox', { name: 'Claude' }));
    fireEvent.click(within(dialog).getByRole('checkbox', { name: 'Codex' }));
    fireEvent.click(within(dialog).getByRole('button', { name: '儲存' }));
    expect(within(dialog).getByText(T.errUrlInvalid)).toBeTruthy();
    expect(within(dialog).getByText(T.errProviderRequired)).toBeTruthy();
  });

  it('shows an inline name error when the server rejects a duplicate', async () => {
    setup({ state: { servers: [], tools: off }, save: () => err('AGENT_EXTENSION_NAME_TAKEN') });
    fireEvent.click(await screen.findByRole('button', { name: '手動新增' }));
    const dialog = await screen.findByRole('dialog');
    fireEvent.change(within(dialog).getByLabelText('名稱'), { target: { value: 'dup' } });
    fireEvent.change(within(dialog).getByLabelText('指令'), { target: { value: 'node' } });
    fireEvent.click(within(dialog).getByRole('button', { name: '儲存' }));
    expect(await within(dialog).findByText(T.errNameTaken)).toBeTruthy();
    expect(screen.getByRole('dialog')).toBeTruthy();
  });

  it('keeps stored secrets on edit: existing keys come back as empty values and are never prefilled', async () => {
    const api = setup();
    fireEvent.click(await screen.findByRole('button', { name: '編輯 files' }));
    const dialog = await screen.findByRole('dialog', { name: '編輯 MCP 伺服器' });
    const value = within(dialog).getByLabelText('值') as HTMLInputElement;
    expect(value.value).toBe('');
    expect(value.placeholder).toBe('保持不變');
    expect((within(dialog).getByLabelText('名稱', { selector: 'input[name="env-key-0"]' }) as HTMLInputElement).readOnly).toBe(true);
    fireEvent.click(within(dialog).getByRole('button', { name: '儲存' }));
    await waitFor(() => expect(api.saveAgentMcpServer).toHaveBeenCalledWith(expect.objectContaining({ id: files.id, name: 'files', env: { API_KEY: '' }, args: ['server.js'], command: 'node' })));
  });

  it('closes the dialog on Escape and traps Tab inside it', async () => {
    setup();
    const opener = await screen.findByRole('button', { name: '手動新增' });
    opener.focus();
    fireEvent.click(opener);
    const dialog = await screen.findByRole('dialog');
    const buttons = within(dialog).getAllByRole('button');
    buttons[buttons.length - 1]!.focus();
    fireEvent.keyDown(dialog, { key: 'Tab' });
    expect(dialog.contains(document.activeElement)).toBe(true);
    fireEvent.keyDown(dialog, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(document.activeElement).toBe(opener);
  });

  it('confirms before deleting', async () => {
    const api = setup();
    fireEvent.click(await screen.findByRole('button', { name: '刪除 remote' }));
    const dialog = await screen.findByRole('alertdialog');
    expect(within(dialog).getByText('刪除「remote」？')).toBeTruthy();
    expect(api.deleteAgentMcpServer).not.toHaveBeenCalled();
    fireEvent.click(within(dialog).getByRole('button', { name: '取消' }));
    expect(api.deleteAgentMcpServer).not.toHaveBeenCalled();
    fireEvent.click(await screen.findByRole('button', { name: '刪除 remote' }));
    fireEvent.click(within(await screen.findByRole('alertdialog')).getByRole('button', { name: '刪除' }));
    await waitFor(() => expect(api.deleteAgentMcpServer).toHaveBeenCalledWith(remote.id));
  });

  it('lists importable servers per source with errors, selects some and imports them', async () => {
    const candidate = (over: object) => ({ source: 'claude-code', sourceName: 'alpha', name: 'alpha', transport: 'stdio', command: 'npx', args: ['-y', 'a'], envKeys: ['TOKEN'], headerKeys: [], nameTaken: false, ...over });
    const listing: AgentMcpImportListing = { sources: [
      { source: 'claude-code', status: 'ok', candidates: [candidate({}), candidate({ sourceName: 'beta', name: 'beta', nameTaken: true }), candidate({ sourceName: 'gamma', name: 'gamma', issue: 'UNSUPPORTED_TRANSPORT' })] as never },
      { source: 'claude-desktop', status: 'missing', candidates: [] },
      { source: 'codex', status: 'error', error: 'INVALID_FORMAT', candidates: [] },
    ] };
    const api = setup({ listing });
    fireEvent.click(await screen.findByRole('button', { name: '從本機匯入' }));
    const dialog = await screen.findByRole('dialog', { name: '從本機匯入' });
    expect(await within(dialog).findByText('alpha')).toBeTruthy();
    expect(within(dialog).getAllByText('環境變數：TOKEN')).toHaveLength(3);
    expect(within(dialog).getByText(T.importSourceMissing)).toBeTruthy();
    expect(within(dialog).getByText(T.importSourceInvalid)).toBeTruthy();
    expect(within(dialog).getByText(T.importNameTaken)).toBeTruthy();
    expect(within(dialog).getByText(T.issueUnsupportedTransport)).toBeTruthy();
    const boxes = within(dialog).getAllByRole('checkbox') as HTMLInputElement[];
    expect(boxes.map((box) => box.disabled)).toEqual([false, true, true]);
    const submit = within(dialog).getByRole('button', { name: '匯入' });
    expect((submit as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(boxes[0]!);
    fireEvent.click(within(dialog).getByRole('button', { name: '匯入' }));
    await waitFor(() => expect(api.importAgentMcpServers).toHaveBeenCalledWith([{ source: 'claude-code', sourceName: 'alpha' }]));
    expect(await within(dialog).findByText('已匯入：alpha')).toBeTruthy();
    expect(api.getAgentExtensions).toHaveBeenCalledTimes(2);
  });

  it('shows a load failure inside the import dialog with a retry', async () => {
    const api = setup();
    (api.listAgentMcpImportCandidates as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('boom'));
    fireEvent.click(await screen.findByRole('button', { name: '從本機匯入' }));
    const dialog = await screen.findByRole('dialog');
    expect(await within(dialog).findByText(/無法載入擴充工具/)).toBeTruthy();
    fireEvent.click(within(dialog).getByRole('button', { name: '重試' }));
    expect(await within(dialog).findByText(T.importNoneFound)).toBeTruthy();
  });

  it('saves built-in tool toggles and marks tools the current level already grants', async () => {
    const api = setup({ level: 'workspace_write' });
    const search = await screen.findByRole('switch', { name: '網路搜尋' });
    const fetchTool = screen.getByRole('switch', { name: '讀取網頁' });
    const write = screen.getByRole('switch', { name: '寫入檔案' });
    const read = screen.getByRole('switch', { name: '讀取檔案' });
    await waitFor(() => expect((write as HTMLButtonElement).disabled).toBe(true));
    expect(write.getAttribute('aria-checked')).toBe('true');
    expect((read as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getAllByText(T.levelGranted).length).toBeGreaterThanOrEqual(3);
    expect((fetchTool as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(fetchTool);
    await waitFor(() => expect(api.setAgentExtensionTools).toHaveBeenCalledWith({ ...off, webFetch: true }));
    expect((search as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(search);
    await waitFor(() => expect(api.setAgentExtensionTools).toHaveBeenLastCalledWith({ ...off, webFetch: true, webSearch: true }));
  });

  it('reverts a toggle and tells the user when saving fails', async () => {
    const api = setup();
    (api.setAgentExtensionTools as ReturnType<typeof vi.fn>).mockResolvedValueOnce(err('X'));
    const fetchTool = await screen.findByRole('switch', { name: '讀取網頁' });
    fireEvent.click(fetchTool);
    expect(await screen.findByText(T.actionFailed)).toBeTruthy();
    expect(screen.getByRole('switch', { name: '讀取網頁' }).getAttribute('aria-checked')).toBe('false');
  });

  it('shows the claude.ai connector toggle as unavailable with the reason', async () => {
    const api = setup();
    const connector = await screen.findByRole('switch', { name: '使用 claude.ai 帳號連接器' });
    expect((connector as HTMLButtonElement).disabled).toBe(true);
    expect(connector.getAttribute('aria-checked')).toBe('false');
    expect(screen.getByText(T.connectorUnavailable)).toBeTruthy();
    expect(screen.getByText(/--strict-mcp-config/)).toBeTruthy();
    fireEvent.click(connector);
    expect(api.setAgentExtensionTools).not.toHaveBeenCalled();
  });

  it('renders in every locale', async () => {
    for (const [locale, copy] of [['en', ENGLISH_EXTENSIONS_COPY], ['ja', JAPANESE_EXTENSIONS_COPY], ['ko', KOREAN_EXTENSIONS_COPY]] as const) {
      setup({ locale });
      expect(await screen.findByRole('heading', { name: copy.heading })).toBeTruthy();
      expect(screen.getByText(copy.note)).toBeTruthy();
      cleanup();
    }
  });
});

describe('extension copy and form helpers', () => {
  it('has the same keys and slots in all four locales', () => {
    const slots = (value: string) => [...value.matchAll(/\{arg\d+\}/g)].map((match) => match[0]).sort();
    for (const copy of [TRADITIONAL_CHINESE_EXTENSIONS_COPY, JAPANESE_EXTENSIONS_COPY, KOREAN_EXTENSIONS_COPY]) {
      expect(Object.keys(copy).sort()).toEqual(Object.keys(ENGLISH_EXTENSIONS_COPY).sort());
      for (const key of Object.keys(ENGLISH_EXTENSIONS_COPY) as Array<keyof typeof ENGLISH_EXTENSIONS_COPY>) {
        expect(copy[key].length).toBeGreaterThan(0);
        expect(slots(copy[key])).toEqual(slots(ENGLISH_EXTENSIONS_COPY[key]));
      }
    }
  });
  it('builds the input without secrets for unchanged keys and drops the other transport fields', () => {
    const form = { name: ' a ', transport: 'http' as const, providers: { claude: true, codex: false }, command: 'node', args: 'x', env: [{ key: 'K', value: 'v', stored: false }],
      url: ' https://e.example ', headers: [{ key: 'Authorization', value: '', stored: true }], enabled: true };
    expect(buildServerInput(form, 'id-1')).toEqual({ id: 'id-1', name: 'a', transport: 'http', enabled: true, providers: ['claude'], args: [], env: {}, headers: { Authorization: '' }, url: 'https://e.example' });
    expect(validateServerForm(form)).toMatchObject({ env: {}, headers: {} });
    expect(validateServerForm({ ...form, headers: [{ key: 'A', value: '1', stored: false }, { key: 'a', value: '2', stored: false }] }).headers[1]?.key).toBe('errKeyDuplicate');
  });
});
