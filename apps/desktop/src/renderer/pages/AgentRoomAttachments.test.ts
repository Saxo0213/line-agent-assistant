// @vitest-environment jsdom
// Existing workflow assertions explicitly exercise the retained Traditional Chinese catalog.
import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { AgentJobSummary } from '@line-agent/contracts';
import { AgentRoom } from './AgentRoom.js';
import type { DesktopApi } from '../../preload/api.js';
import { LocaleProvider, type LocaleState } from '../locale-context.js';

afterEach(() => { cleanup(); localStorage.clear(); });

const conversation = { accountId: 'account-A', chatType: 'direct' as const, chatId: 'local-agent', title: 'Agent 室',
  agentEnabled: true, defaultProvider: 'codex' as const, unreadCount: 0, localOnly: true };
const providers = [{ provider: 'codex' as const, status: 'unknown' as const, detail: null }];
const MB = 1024 * 1024;
const testLocaleState: LocaleState = { status: 'loaded', effectiveLocale: 'zh-TW', preference: 'zh-TW', busy: false, error: null, retry: vi.fn(), retryRestart: vi.fn(), setPreference: vi.fn() };
const file = (name: string, size = 4, type = 'application/octet-stream') => {
  const value = new File([new Uint8Array(size).fill(7)], name, { type });
  return value;
};

function setup(jobs: AgentJobSummary[] = [], submit?: DesktopApi['submitAgentRoomPrompt']) {
  const api = {
    getAgentRoomJobEvents: vi.fn(async () => []),
    listPendingAgentApprovals: vi.fn(async () => []),
    decideAgentApproval: vi.fn(async () => ({ type: 'decideAgentApproval', requestId: 'x', ok: true })),
    onEvent: vi.fn(() => () => undefined),
    submitAgentRoomPrompt: vi.fn(submit ?? (async () => ({ type: 'submitAgentRoomPrompt', requestId: 'x', ok: true, jobId: 'job-1' } as const))),
  } as unknown as DesktopApi;
  render(React.createElement(LocaleProvider, { value: testLocaleState }, React.createElement(AgentRoom, { api, conversation, jobs, providers })));
  return api;
}
const input = () => screen.getByTestId('agent-room-file-input') as HTMLInputElement;
const choose = (...files: File[]) => fireEvent.change(input(), { target: { files } });
const send = () => screen.getByRole('button', { name: /^傳送/ }) as HTMLButtonElement;
const chips = () => within(screen.getByLabelText('待傳送附件')).getAllByRole('listitem');

describe('Agent room attachment composer', () => {
  it('puts a labelled 附加檔案 button left of 傳送 that opens the hidden multi-file input (row 1)', () => {
    setup();
    const attach = screen.getByRole('button', { name: '附加檔案' });
    expect(attach.getAttribute('title')).toBe('附加檔案');
    expect(attach.compareDocumentPosition(send()) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(input().type).toBe('file');
    expect(input().multiple).toBe(true);
    const click = vi.spyOn(input(), 'click');
    fireEvent.click(attach);
    expect(click).toHaveBeenCalledOnce();
  });

  it('shows a chip with name, size and a thumbnail for images, and sends the bytes with the text', async () => {
    const api = setup();
    fireEvent.change(screen.getByRole('textbox', { name: 'Agent 訊息' }), { target: { value: '看圖' } });
    choose(file('shot.png', 2048, 'image/png'), file('report.pdf', 12, 'application/pdf'));
    await waitFor(() => expect(chips()).toHaveLength(2));
    expect(within(chips()[0]!).getByText('shot.png')).toBeTruthy();
    expect(within(chips()[0]!).getByText('2.0 KB')).toBeTruthy();
    expect(within(chips()[1]!).getByText('12 B')).toBeTruthy();
    await waitFor(() => expect(chips()[0]!.querySelector('img')?.getAttribute('src')).toMatch(/^data:image\/png/));
    expect(chips()[1]!.querySelector('img')).toBeNull();
    fireEvent.click(send());
    await waitFor(() => expect(api.submitAgentRoomPrompt).toHaveBeenCalledOnce());
    const call = (api.submitAgentRoomPrompt as ReturnType<typeof vi.fn>).mock.calls[0]![0];
    expect(call.provider).toBe('codex');
    expect(call.prompt).toBe('看圖');
    expect(call.attachments.map((item: { name: string }) => item.name)).toEqual(['shot.png', 'report.pdf']);
    expect(call.attachments[0].bytes).toBeInstanceOf(Uint8Array);
    expect(call.attachments[0].bytes.byteLength).toBe(2048);
    expect(call.attachments[0]).not.toHaveProperty('path');
    await waitFor(() => expect(screen.queryByLabelText('待傳送附件')).toBeNull());
  });

  it('removes a chip with ×', async () => {
    setup();
    choose(file('a.txt'), file('b.txt'));
    await waitFor(() => expect(chips()).toHaveLength(2));
    fireEvent.click(screen.getByRole('button', { name: '移除 a.txt' }));
    expect(chips()).toHaveLength(1);
    expect(screen.queryByText('a.txt')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: '移除 b.txt' }));
    expect(screen.queryByLabelText('待傳送附件')).toBeNull();
  });

  it('takes files from a paste, names unnamed screenshots clipboard-N.png, and leaves text-only paste alone (row 2)', async () => {
    setup();
    const box = screen.getByRole('textbox', { name: 'Agent 訊息' });
    const textPaste = new Event('paste', { bubbles: true, cancelable: true }) as Event & { clipboardData?: unknown };
    textPaste.clipboardData = { files: [], items: [], getData: () => 'plain' };
    expect(fireEvent(box, textPaste)).toBe(true);
    expect(screen.queryByLabelText('待傳送附件')).toBeNull();

    const shot = new File([new Uint8Array(5)], '', { type: 'image/png' });
    const filePaste = new Event('paste', { bubbles: true, cancelable: true }) as Event & { clipboardData?: unknown };
    filePaste.clipboardData = { files: [shot], items: [] };
    expect(fireEvent(box, filePaste)).toBe(false);
    await waitFor(() => expect(chips()).toHaveLength(1));
    expect(within(chips()[0]!).getByText('clipboard-1.png')).toBeTruthy();
    const second = new Event('paste', { bubbles: true, cancelable: true }) as Event & { clipboardData?: unknown };
    second.clipboardData = { files: [], items: [{ kind: 'file', getAsFile: () => new File([new Uint8Array(3)], '', { type: 'image/jpeg' }) }] };
    fireEvent(box, second);
    await waitFor(() => expect(chips()).toHaveLength(2));
    expect(within(chips()[1]!).getByText('clipboard-2.jpeg')).toBeTruthy();
  });

  it('accepts dropped files with a highlight while dragging', async () => {
    setup();
    const composer = screen.getByTestId('agent-composer');
    fireEvent.dragOver(composer, { dataTransfer: { types: ['Files'], files: [] } });
    expect(composer.className).toContain('dragging-attachment');
    fireEvent.dragLeave(composer, { relatedTarget: null });
    expect(composer.className).not.toContain('dragging-attachment');
    fireEvent.dragOver(composer, { dataTransfer: { types: ['Files'], files: [] } });
    fireEvent.drop(composer, { dataTransfer: { types: ['Files'], files: [file('dropped.csv')] } });
    expect(composer.className).not.toContain('dragging-attachment');
    await waitFor(() => expect(chips()).toHaveLength(1));
    expect(within(chips()[0]!).getByText('dropped.csv')).toBeTruthy();
    // A drag of plain text does not light up the composer.
    fireEvent.dragOver(composer, { dataTransfer: { types: ['text/plain'], files: [] } });
    expect(composer.className).not.toContain('dragging-attachment');
  });

  it('enforces the client-side limits with Chinese messages (row 5)', async () => {
    setup();
    choose(file('big.bin', 20 * MB + 1));
    expect(await screen.findByText('單一檔案上限 20 MB')).toBeTruthy();
    expect(screen.queryByLabelText('待傳送附件')).toBeNull();

    choose(...Array.from({ length: 11 }, (_, i) => file(`f${i}.txt`)));
    await waitFor(() => expect(chips()).toHaveLength(10));
    expect(await screen.findByText('最多 10 個檔案')).toBeTruthy();
  });

  it('enforces the 50 MB total', async () => {
    setup();
    choose(file('a.bin', 20 * MB), file('b.bin', 20 * MB), file('c.bin', 10 * MB + 1));
    await waitFor(() => expect(chips()).toHaveLength(2));
    expect(await screen.findByText('附件合計上限 50 MB')).toBeTruthy();
  });

  it('enables 傳送 for an attachment alone and sends an empty prompt (row 3)', async () => {
    const api = setup();
    expect(send().disabled).toBe(true);
    choose(file('a.png', 8, 'image/png'));
    await waitFor(() => expect(send().disabled).toBe(false));
    fireEvent.click(send());
    await waitFor(() => expect(api.submitAgentRoomPrompt).toHaveBeenCalledOnce());
    expect((api.submitAgentRoomPrompt as ReturnType<typeof vi.fn>).mock.calls[0]![0]).toMatchObject({ provider: 'codex', prompt: '' });
    // The pending bubble shows the default prompt and the attachment chip.
    expect(await screen.findByText('請查看附件。')).toBeTruthy();
    expect(screen.getAllByText('a.png').length).toBeGreaterThan(0);
  });

  it('keeps the draft and the chips when the send fails', async () => {
    const api = setup([], async () => ({ type: 'error', requestId: 'x', ok: false, code: 'ATTACHMENT_WRITE_FAILED', message: '附件寫入失敗，未建立工作。請確認磁碟空間後再試。', retryable: false } as const));
    fireEvent.change(screen.getByRole('textbox', { name: 'Agent 訊息' }), { target: { value: '保留我' } });
    choose(file('keep.pdf'));
    await waitFor(() => expect(chips()).toHaveLength(1));
    fireEvent.click(send());
    await waitFor(() => expect(api.submitAgentRoomPrompt).toHaveBeenCalledOnce());
    expect(await screen.findByText(/附件寫入失敗/)).toBeTruthy();
    expect((screen.getByRole('textbox', { name: 'Agent 訊息' }) as HTMLTextAreaElement).value).toBe('保留我');
    expect(chips()).toHaveLength(1);
    expect(within(chips()[0]!).getByText('keep.pdf')).toBeTruthy();
    expect(send().disabled).toBe(false);
  });

  it('shows attachment chips (name and size, no path) under the operator message in the timeline (row 1)', () => {
    setup([{ jobId: 'j1', accountId: null, chatType: null, chatId: null, provider: 'codex', prompt: '請看', status: 'completed',
      createdAt: '2026-10-20T00:00:00.000Z', attachments: [{ name: 'shot.png', size: 2048, kind: 'image' }, { name: 'doc.pdf', size: 5 * MB, kind: 'file' }] }]);
    const timeline = screen.getByLabelText('附件');
    const items = within(timeline).getAllByRole('listitem');
    expect(items).toHaveLength(2);
    expect(within(items[0]!).getByText('shot.png')).toBeTruthy();
    expect(within(items[0]!).getByText('2.0 KB')).toBeTruthy();
    expect(within(items[1]!).getByText('5.0 MB')).toBeTruthy();
    expect(timeline.textContent).not.toMatch(/agent-attachments|[A-Za-z]:\\/);
    expect(within(timeline).queryByRole('button')).toBeNull();
  });

  it('disables the attach button while a submit is in flight', async () => {
    let release!: () => void;
    const api = setup([], () => new Promise((resolve) => { release = () => resolve({ type: 'submitAgentRoomPrompt', requestId: 'x', ok: true, jobId: 'job-9' }); }));
    fireEvent.change(screen.getByRole('textbox', { name: 'Agent 訊息' }), { target: { value: 'go' } });
    fireEvent.click(send());
    await waitFor(() => expect(api.submitAgentRoomPrompt).toHaveBeenCalledOnce());
    expect((screen.getByRole('button', { name: '附加檔案' }) as HTMLButtonElement).disabled).toBe(true);
    await act(async () => release());
  });
});
