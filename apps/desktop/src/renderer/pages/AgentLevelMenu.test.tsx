// @vitest-environment jsdom
// Existing workflow assertions explicitly exercise the retained Traditional Chinese catalog.
import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import type { AgentExecutionPolicy } from '@line-agent/contracts';
import type { DesktopApi } from '../../preload/api.js';
import { AgentLevelMenu } from './AgentLevelMenu.js';
import { renderWithAgentLocale } from './agentTestLocale.js';
import { extraTextFor } from '../desktop-i18n.js';

afterEach(() => { cleanup(); vi.restoreAllMocks(); });
const policy = (level: AgentExecutionPolicy['level'] = 'trust', version = 3): AgentExecutionPolicy => ({ level, approvalTimeoutSeconds: 240, timeoutAction: 'DENY', version, updatedAt: new Date(0).toISOString() });
function setup(extra: Record<string, unknown> = {}) {
  let changed: ((event: unknown) => void) | undefined;
  const api = {
    getAgentExecutionPolicy: vi.fn(async () => policy()),
    setAgentExecutionPolicy: vi.fn(async () => ({ type: 'setAgentExecutionPolicy', version: 4 })),
    onEvent: vi.fn((listener: (event: unknown) => void) => { changed = listener; return vi.fn(); }),
    ...extra,
  } as unknown as DesktopApi & Record<string, ReturnType<typeof vi.fn>>;
  const view = renderWithAgentLocale(<AgentLevelMenu api={api} />);
  return { api, view, emit: (event: unknown = { type: 'agentExecutionPolicyChanged' }) => changed?.(event) };
}

describe('AgentLevelMenu', () => {
  it('renders current level and opens/closes with Escape and outside click', async () => {
    setup();
    const trigger = await screen.findByRole('button', { name: '權限：信任' });
    fireEvent.click(trigger);
    expect(screen.getByRole('menu')).toBeTruthy();
    fireEvent.keyDown(screen.getByRole('menu'), { key: 'Escape' });
    expect(screen.queryByRole('menu')).toBeNull();
    expect(document.activeElement).toBe(trigger);
    fireEvent.click(trigger);
    fireEvent.pointerDown(document.body);
    expect(screen.queryByRole('menu')).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });

  it('navigates menu items with arrow keys', async () => {
    setup();
    fireEvent.click(await screen.findByRole('button', { name: '權限：信任' }));
    const items = screen.getAllByRole('menuitemradio');
    expect(items.map((item) => item.textContent)).toHaveLength(4);
    expect(items[2]!.getAttribute('aria-checked')).toBe('true');
    fireEvent.keyDown(items[2]!, { key: 'ArrowDown' });
    expect(document.activeElement).toBe(items[3]!);
    fireEvent.keyDown(items[3]!, { key: 'ArrowDown' });
    expect(document.activeElement).toBe(items[0]!);
    fireEvent.keyDown(items[0]!, { key: 'ArrowUp' });
    expect(document.activeElement).toBe(items[3]!);
  });

  it('applies a tighter level without confirmation and sends the exact policy payload', async () => {
    const confirm = vi.spyOn(window, 'confirm');
    const { api } = setup();
    fireEvent.click(await screen.findByRole('button', { name: '權限：信任' }));
    fireEvent.click(screen.getByRole('menuitemradio', { name: /工作區可寫/ }));
    await waitFor(() => expect(api.setAgentExecutionPolicy).toHaveBeenCalledWith({ level: 'workspace_write', approvalTimeoutSeconds: 240, timeoutAction: 'DENY', expectedVersion: 3 }));
    expect(confirm).not.toHaveBeenCalled();
  });

  it('confirms loosening and applies only when accepted', async () => {
    const confirm = vi.spyOn(window, 'confirm').mockReturnValueOnce(false).mockReturnValueOnce(true);
    const { api } = setup();
    fireEvent.click(await screen.findByRole('button', { name: '權限：信任' }));
    fireEvent.click(screen.getByRole('menuitemradio', { name: /全部放行/ }));
    expect(confirm).toHaveBeenCalledWith('確定放寬 Agent 權限為「全部放行」？');
    expect(api.setAgentExecutionPolicy).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: '權限：信任' }));
    fireEvent.click(screen.getByRole('menuitemradio', { name: /全部放行/ }));
    await waitFor(() => expect(api.setAgentExecutionPolicy).toHaveBeenCalledWith({ level: 'full', approvalTimeoutSeconds: 240, timeoutAction: 'DENY', expectedVersion: 3 }));
  });

  it('reloads and reports version conflicts', async () => {
    let reads = 0;
    const { api } = setup({ getAgentExecutionPolicy: vi.fn(async () => policy(reads++ ? 'workspace_write' : 'trust', reads > 1 ? 4 : 3)),
      setAgentExecutionPolicy: vi.fn(async () => ({ type: 'error', code: 'PERMISSION_VERSION_CONFLICT', message: 'conflict' })) });
    fireEvent.click(await screen.findByRole('button', { name: '權限：信任' }));
    fireEvent.click(screen.getByRole('menuitemradio', { name: /唯讀/ }));
    expect((await screen.findByRole('status')).textContent).toContain('設定已在其他地方變更，已重新載入');
    expect(await screen.findByRole('button', { name: '權限：工作區可寫' })).toBeTruthy();
  });

  it('shows other errors', async () => {
    setup({ setAgentExecutionPolicy: vi.fn(async () => ({ type: 'error', code: 'FAILED', message: 'save failed' })) });
    fireEvent.click(await screen.findByRole('button', { name: '權限：信任' }));
    fireEvent.click(screen.getByRole('menuitemradio', { name: /唯讀/ }));
    expect((await screen.findByRole('status')).textContent).toContain(extraTextFor('zh-TW', 'operationFailed'));
  });

  it('reloads on policy events and defers an event received during save', async () => {
    let resolve!: (value: { type: string; version: number }) => void;
    const { api, emit } = setup({ setAgentExecutionPolicy: vi.fn(() => new Promise((done) => { resolve = done; })) });
    await screen.findByRole('button', { name: '權限：信任' });
    emit();
    await waitFor(() => expect(api.getAgentExecutionPolicy).toHaveBeenCalledTimes(2));
    fireEvent.click(screen.getByRole('button', { name: '權限：信任' }));
    fireEvent.click(screen.getByRole('menuitemradio', { name: /唯讀/ }));
    emit();
    expect(api.getAgentExecutionPolicy).toHaveBeenCalledTimes(2);
    await act(async () => resolve({ type: 'setAgentExecutionPolicy', version: 4 }));
    await waitFor(() => expect(api.getAgentExecutionPolicy).toHaveBeenCalledTimes(4));
  });

  it('ignores a load result after unmount', async () => {
    let resolve!: (value: AgentExecutionPolicy) => void;
    const { view } = setup({ getAgentExecutionPolicy: vi.fn(() => new Promise((done) => { resolve = done; })) });
    view.unmount();
    await act(async () => resolve(policy('full')));
    expect(screen.queryByRole('button', { name: '權限：全部放行' })).toBeNull();
  });
});
