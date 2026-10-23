// @vitest-environment jsdom
// Existing workflow assertions explicitly exercise the retained Traditional Chinese catalog.
import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import type { IpcResult, PendingAgentApproval } from '@line-agent/contracts';
import type { DesktopApi } from '../../preload/api.js';
import { AgentApprovalCards } from './AgentApprovalCards.js';
import { renderWithAgentLocale } from './agentTestLocale.js';
import { extraTextFor } from '../desktop-i18n.js';

afterEach(() => { cleanup(); vi.useRealTimers(); });
const approval: PendingAgentApproval = { approvalId: 'approval-1', jobId: 'job-1', tool: 'Bash', summary: 'echo  one\n  two', deadline: new Date(Date.now() + 20_000).toISOString(), canRemember: true };
function setup(pending: PendingAgentApproval[] = [], decide = vi.fn(async (): Promise<IpcResult> => ({ type: 'decideAgentApproval', requestId: 'x', ok: true })), list = vi.fn(async () => pending)) {
  let listener: ((event: Parameters<Parameters<DesktopApi['onEvent']>[0]>[0]) => void) | undefined;
  const unsubscribe = vi.fn(() => { listener = undefined; });
  const api = { listPendingAgentApprovals: list, decideAgentApproval: decide,
    onEvent: vi.fn((callback: typeof listener) => { listener = callback; return unsubscribe; }) } as unknown as DesktopApi;
  const view = renderWithAgentLocale(<AgentApprovalCards api={api} />);
  return { api, view, unsubscribe, emit: (event: Parameters<NonNullable<typeof listener>>[0]) => listener?.(event) };
}

describe('AgentApprovalCards', () => {
  it('loads pending cards and preserves long command whitespace', async () => {
    setup([approval]);
    expect(await screen.findByRole('region', { name: 'Agent 核可請求' })).toBeTruthy();
    expect(document.querySelector('pre')?.textContent).toBe(approval.summary);
    expect(screen.getByText('Agent 要求執行命令列')).toBeTruthy();
  });

  it('adds requested events once and removes resolved cards', async () => {
    const { emit } = setup();
    await waitFor(() => expect(screen.queryByRole('region', { name: 'Agent 核可請求' })).toBeNull());
    await act(async () => { emit({ type: 'agentApprovalRequested', approval }); emit({ type: 'agentApprovalRequested', approval }); });
    expect(screen.getAllByRole('region', { name: 'Agent 核可請求' })).toHaveLength(1);
    act(() => emit({ type: 'agentApprovalResolved', approvalId: approval.approvalId, jobId: approval.jobId, outcome: 'allowed' }));
    expect(screen.queryByRole('region', { name: 'Agent 核可請求' })).toBeNull();
  });

  it.each([['允許一次', 'once'], ['本會話允許', 'session'], ['永久允許', 'always'], ['拒絕', 'deny']] as const)('sends %s decision', async (label, value) => {
    const decide = vi.fn(async (): Promise<IpcResult> => ({ type: 'decideAgentApproval', requestId: 'x', ok: true }));
    setup([approval], decide);
    fireEvent.click(await screen.findByRole('button', { name: label }));
    await waitFor(() => expect(decide).toHaveBeenCalledWith(approval.approvalId, value));
  });

  it('disables remembered choices when the command is too long', async () => {
    setup([{ ...approval, canRemember: false }]);
    expect(await screen.findByText('命令超過 2000 字，只能允許一次')).toBeTruthy();
    expect(screen.getByRole('button', { name: '本會話允許' })).toHaveProperty('disabled', true);
    expect(screen.getByRole('button', { name: '永久允許' })).toHaveProperty('disabled', true);
  });

  it('removes an expired approval decision and reports it', async () => {
    const decide = vi.fn(async (): Promise<IpcResult> => ({ type: 'error', requestId: 'x', ok: false, code: 'APPROVAL_NOT_PENDING', message: 'gone', retryable: false }));
    setup([approval], decide);
    fireEvent.click(await screen.findByRole('button', { name: '拒絕' }));
    expect(await screen.findByText('這個核可已失效')).toBeTruthy();
    expect(screen.queryByRole('region', { name: 'Agent 核可請求' })).toBeNull();
  });

  it.each(['resolved error', 'rejection'] as const)('ignores a decision that settles after unmount (%s)', async (settlement) => {
    vi.useFakeTimers();
    let resolveDecision: (result: IpcResult) => void = () => undefined;
    let rejectDecision: (error: Error) => void = () => undefined;
    const decide = vi.fn(() => new Promise<IpcResult>((resolve, reject) => { resolveDecision = resolve; rejectDecision = reject; }));
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const { view } = setup([approval], decide);
    await act(async () => { await Promise.resolve(); });
    fireEvent.click(screen.getAllByRole('button')[0]!);
    view.unmount();
    expect(vi.getTimerCount()).toBe(0);
    if (settlement === 'resolved error') {
      await act(async () => { resolveDecision({ type: 'error', requestId: 'x', ok: false, code: 'APPROVAL_NOT_PENDING', message: 'gone', retryable: false }); });
    } else {
      await act(async () => { rejectDecision(new Error('failed')); });
    }
    expect(vi.getTimerCount()).toBe(0);
    expect(consoleError).not.toHaveBeenCalled();
    consoleError.mockRestore();
  });

  it.each(['error', 'resolved'] as const)('does not resurrect an approval terminally transitioned during the initial snapshot (%s)', async (transition) => {
    let release: (items: PendingAgentApproval[]) => void = () => undefined;
    const list = vi.fn(() => new Promise<PendingAgentApproval[]>((resolve) => { release = resolve; }));
    const decide = vi.fn(async (): Promise<IpcResult> => ({ type: 'error', requestId: 'x', ok: false, code: 'APPROVAL_NOT_PENDING', message: 'gone', retryable: false }));
    const { emit } = setup([], decide, list);
    await act(async () => { emit({ type: 'agentApprovalRequested', approval }); });
    if (transition === 'error') {
      fireEvent.click(screen.getByRole('button', { name: '拒絕' }));
      await screen.findByText('這個核可已失效');
    }
    else act(() => emit({ type: 'agentApprovalResolved', approvalId: approval.approvalId, jobId: approval.jobId, outcome: 'allowed' }));
    await act(async () => { release([approval]); });
    expect(screen.queryByRole('region', { name: 'Agent 核可請求' })).toBeNull();
  });

  it('allows repeated request and resolution cycles without retaining terminal ids', async () => {
    const { emit, api } = setup();
    await waitFor(() => expect(api.listPendingAgentApprovals).toHaveBeenCalledTimes(1));
    for (let i = 0; i < 200; i += 1) {
      const item = { ...approval, approvalId: `approval-${i}` };
      act(() => emit({ type: 'agentApprovalRequested', approval: item }));
      act(() => emit({ type: 'agentApprovalResolved', approvalId: item.approvalId, jobId: item.jobId, outcome: 'allowed' }));
    }
    const later = { ...approval, approvalId: 'later' };
    act(() => emit({ type: 'agentApprovalRequested', approval: later }));
    expect(document.querySelector('pre')?.textContent).toBe(later.summary);
  });

  it('drops an initial snapshot that resolves after unmount', async () => {
    let release: (items: PendingAgentApproval[]) => void = () => undefined;
    const list = vi.fn(() => new Promise<PendingAgentApproval[]>((resolve) => { release = resolve; }));
    const { view } = setup([], undefined, list);
    view.unmount();
    await act(async () => { release([approval]); });
    expect(screen.queryByText(approval.summary)).toBeNull();
  });

  it('clears busy after a retryable decision error and allows retry', async () => {
    let release: (result: IpcResult) => void = () => undefined;
    const decide = vi.fn().mockImplementationOnce(() => new Promise<IpcResult>((resolve) => { release = resolve; }))
      .mockResolvedValueOnce({ type: 'decideAgentApproval', requestId: 'y', ok: true });
    setup([approval], decide);
    const button = await screen.findByRole('button', { name: '拒絕' });
    fireEvent.click(button);
    expect(button).toHaveProperty('disabled', true);
    await act(async () => { release({ type: 'error', requestId: 'x', ok: false, code: 'FAILED', message: 'try again', retryable: true }); });
    expect((await screen.findByRole('alert')).textContent).toContain(extraTextFor('zh-TW', 'operationFailed'));
    expect(button).toHaveProperty('disabled', false);
    fireEvent.click(button);
    await waitFor(() => expect(decide).toHaveBeenCalledTimes(2));
  });

  it('expires notices after five seconds and a replacement resets the timer', async () => {
    vi.useFakeTimers();
    const { emit } = setup();
    act(() => emit({ type: 'agentApprovalResolved', approvalId: approval.approvalId, jobId: approval.jobId, outcome: 'timeout' }));
    await act(async () => { vi.advanceTimersByTime(4000); });
    act(() => emit({ type: 'agentApprovalResolved', approvalId: approval.approvalId, jobId: approval.jobId, outcome: 'cancelled' }));
    await act(async () => { vi.advanceTimersByTime(4000); });
    expect(screen.getByRole('status')).toBeTruthy();
    await act(async () => { vi.advanceTimersByTime(1000); });
    expect(screen.queryByRole('status')).toBeNull();
  });

  it('unsubscribes and clears interval and notice timer on unmount', async () => {
    vi.useFakeTimers();
    const { emit, view, api, unsubscribe } = setup([approval]);
    await act(async () => { await Promise.resolve(); });
    act(() => emit({ type: 'agentApprovalResolved', approvalId: approval.approvalId, jobId: approval.jobId, outcome: 'timeout' }));
    view.unmount();
    expect(unsubscribe).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('starts a newly requested card countdown from the current time after idle', async () => {
    vi.useFakeTimers();
    const { emit } = setup();
    await act(async () => { await Promise.resolve(); });
    await act(async () => { vi.advanceTimersByTime(60_000); });
    const fresh = { ...approval, deadline: new Date(Date.now() + 20_000).toISOString() };
    act(() => emit({ type: 'agentApprovalRequested', approval: fresh }));
    expect(document.querySelector('.agent-approval-countdown')?.textContent).toContain('20');
  });

  it('updates countdown and clears its interval after the last card resolves', async () => {
    vi.useFakeTimers();
    const { emit } = setup([{ ...approval, deadline: new Date(Date.now() + 20_000).toISOString() }]);
    await act(async () => { await Promise.resolve(); });
    expect(screen.getByText(/剩餘/).textContent).toContain('20');
    await act(async () => { vi.advanceTimersByTime(1000); });
    expect(screen.getByText(/剩餘/).textContent).toContain('19');
    act(() => emit({ type: 'agentApprovalResolved', approvalId: approval.approvalId, jobId: approval.jobId, outcome: 'allowed' }));
    expect(screen.queryByRole('region', { name: 'Agent 核可請求' })).toBeNull();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('shows timeout and cancelled outcomes temporarily', async () => {
    const { emit } = setup([approval]);
    act(() => emit({ type: 'agentApprovalResolved', approvalId: approval.approvalId, jobId: approval.jobId, outcome: 'timeout' }));
    expect(screen.getByText('已逾時，自動拒絕')).toBeTruthy();
    act(() => emit({ type: 'agentApprovalResolved', approvalId: approval.approvalId, jobId: approval.jobId, outcome: 'cancelled' }));
    expect(screen.getByText('工作已停止，核可已取消')).toBeTruthy();
  });
});
