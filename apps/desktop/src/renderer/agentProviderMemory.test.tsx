// @vitest-environment jsdom
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { ConversationKey } from '@line-agent/contracts';
import { AgentRoom } from './pages/AgentRoom.js';
import type { DesktopApi } from '../preload/api.js';
import { AGENT_PROVIDER_KEY_PREFIX, AGENT_PROVIDER_MAX_ENTRIES, agentProviderKey, readAgentProvider, writeAgentProvider } from './agentProviderMemory.js';

const route = (chatId: string): ConversationKey => ({ accountId: 'account-A', chatType: 'direct', chatId });
const api = { getJobEvents: vi.fn(async () => []), listPendingAgentApprovals: vi.fn(async () => []), decideAgentApproval: vi.fn(async () => ({ type: 'decideAgentApproval', requestId: 'x', ok: true })), onEvent: vi.fn(() => () => undefined) } as unknown as DesktopApi;
const providers = [{ provider: 'codex' as const, status: 'logged_in' as const, detail: null }, { provider: 'claude' as const, status: 'logged_in' as const, detail: null }];
const room = (chatId: string, defaultProvider: 'codex' | 'claude' = 'codex') => React.createElement(AgentRoom, {
  api, jobs: [], providers,
  conversation: { accountId: 'account-A', chatType: 'direct', chatId, title: 'Agent 室', agentEnabled: true, defaultProvider, unreadCount: 0, localOnly: true },
});
const selector = () => screen.getByRole('combobox', { name: 'Agent' }) as HTMLSelectElement;

beforeEach(() => localStorage.clear());
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

describe('shared Agent room provider memory', () => {
  it('uses the single account-independent key linejs.agentProvider.v1:agent-room', () => {
    const shared = { accountId: 'agent-room', chatType: 'direct' as const, chatId: 'agent-room' };
    expect(agentProviderKey(shared)).toBe('linejs.agentProvider.v1:agent-room');
    writeAgentProvider(shared, 'claude');
    expect(localStorage.getItem('linejs.agentProvider.v1:agent-room')).toContain('claude');
    expect(readAgentProvider(shared)).toBe('claude');
    render(React.createElement(AgentRoom, { api, jobs: [], providers,
      conversation: { ...shared, title: 'Agent 室', agentEnabled: true, defaultProvider: 'codex', unreadCount: 0, localOnly: true } }));
    expect(selector().value).toBe('claude');
  });
});

describe('Agent provider memory', () => {
  it('preselects the remembered provider when the room is opened again, per room', () => {
    const view = render(room('room-1'));
    expect(selector().value).toBe('codex');
    fireEvent.change(selector(), { target: { value: 'claude' } });
    expect(localStorage.getItem(agentProviderKey(route('room-1')))).toContain('claude');

    view.rerender(room('room-2'));
    expect(selector().value).toBe('codex');
    view.rerender(room('room-1'));
    expect(selector().value).toBe('claude');

    cleanup();
    render(room('room-1'));
    expect(selector().value).toBe('claude');
  });

  it('falls back to the default when the stored value is invalid or malformed', () => {
    localStorage.setItem(agentProviderKey(route('room-1')), JSON.stringify({ provider: 'gemini', at: 1 }));
    localStorage.setItem(agentProviderKey(route('room-2')), '{not json');
    expect(readAgentProvider(route('room-1'))).toBeNull();
    expect(readAgentProvider(route('room-2'))).toBeNull();
    expect(readAgentProvider(route('missing'))).toBeNull();
    const view = render(room('room-1', 'claude'));
    expect(selector().value).toBe('claude');
    view.rerender(room('room-2', 'codex'));
    expect(selector().value).toBe('codex');
  });

  it('ignores a remembered provider that is not currently available', () => {
    writeAgentProvider(route('room-1'), 'claude');
    expect(readAgentProvider(route('room-1'), ['codex'])).toBeNull();
  });

  it('keeps working when storage throws', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('denied'); });
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('full'); });
    render(room('room-1', 'codex'));
    expect(selector().value).toBe('codex');
    fireEvent.change(selector(), { target: { value: 'claude' } });
    expect(selector().value).toBe('claude');
  });

  it('bounds the number of remembered rooms and evicts the oldest', () => {
    let now = 1000;
    vi.spyOn(Date, 'now').mockImplementation(() => now++);
    for (let index = 0; index < AGENT_PROVIDER_MAX_ENTRIES + 5; index += 1) writeAgentProvider(route(`room-${index}`), 'claude');
    const keys = Object.keys(localStorage).filter((key) => key.startsWith(AGENT_PROVIDER_KEY_PREFIX));
    expect(keys).toHaveLength(AGENT_PROVIDER_MAX_ENTRIES);
    expect(readAgentProvider(route('room-0'))).toBeNull();
    expect(readAgentProvider(route('room-4'))).toBeNull();
    expect(readAgentProvider(route('room-5'))).toBe('claude');
    expect(readAgentProvider(route(`room-${AGENT_PROVIDER_MAX_ENTRIES + 4}`))).toBe('claude');
  });
});
