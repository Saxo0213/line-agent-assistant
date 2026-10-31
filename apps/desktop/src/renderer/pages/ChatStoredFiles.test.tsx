// @vitest-environment jsdom
import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ConversationKey } from '@line-agent/contracts';
import type { DesktopApi } from '../../preload/api.js';
import { LocaleProvider } from '../locale-context.js';
import { ChatStoredFiles } from './ChatStoredFiles.js';

afterEach(() => cleanup());

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}

const group: ConversationKey = { accountId: 'acct-1', chatType: 'group', chatId: 'group-1' };
const direct: ConversationKey = { accountId: 'acct-1', chatType: 'direct', chatId: 'user-1' };
const item = { attachmentId: 'attachment-1', messageId: 'message-1', name: 'report.pdf', kind: 'file' as const,
  mimeType: 'application/pdf', sizeBytes: 2048, occurredAt: '2026-10-31T10:00:00.000Z', senderId: 'member-1', senderDisplayName: 'Kai' };
function renderFiles(key = group, api = { listStoredAttachments: vi.fn(async () => ({ attachments: [item], nextCursor: null })),
  openAttachment: vi.fn(async () => true) } as unknown as DesktopApi, locale: 'en' | 'zh-TW' | 'ja' | 'ko' = 'en') {
  return { ...render(<LocaleProvider value={{ status: 'loaded', effectiveLocale: locale, preference: locale, busy: false, error: null, retry() {}, retryRestart() {}, setPreference() {} }}>
    <ChatStoredFiles api={api} route={key} />
  </LocaleProvider>), api };
}

describe('ChatStoredFiles', () => {
  it('shows a local saved-file list with speaker in group chats and opens by attachment ID while disconnected', async () => {
    const client = { listStoredAttachments: vi.fn(async () => ({ attachments: [item], nextCursor: null })), openAttachment: vi.fn(async () => true) } as unknown as DesktopApi;
    renderFiles(group, client);
    fireEvent.click(screen.getByRole('button', { name: 'Open saved files' }));
    expect(await screen.findByRole('dialog', { name: 'Saved files' })).toBeTruthy();
    expect(screen.getByText('report.pdf')).toBeTruthy();
    expect(screen.getByText('Kai')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Open report.pdf' }));
    await waitFor(() => expect(client.openAttachment).toHaveBeenCalledWith('attachment-1'));
    expect(client.listStoredAttachments).toHaveBeenCalledWith(group, null, 50);
  });

  it('omits the speaker column for direct chats and paginates records without duplicate attachment rows', async () => {
    const client = { listStoredAttachments: vi.fn().mockResolvedValueOnce({ attachments: [item], nextCursor: 'next' })
      .mockResolvedValueOnce({ attachments: [item, { ...item, attachmentId: 'attachment-2', name: 'second.png' }], nextCursor: null }), openAttachment: vi.fn() } as unknown as DesktopApi;
    renderFiles(direct, client);
    fireEvent.click(screen.getByRole('button', { name: 'Open saved files' }));
    expect(await screen.findByRole('dialog', { name: 'Saved files' })).toBeTruthy();
    expect(screen.queryByText('Kai')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Load more' }));
    expect(await screen.findByText('second.png')).toBeTruthy();
    expect(screen.getAllByText('report.pdf')).toHaveLength(1);
    expect(client.listStoredAttachments).toHaveBeenNthCalledWith(2, direct, 'next', 50);
  });

  it('ignores a response from a previous chat after switching routes', async () => {
    let resolveOld!: (value: { attachments: typeof item[]; nextCursor: null }) => void;
    const oldPage = new Promise<{ attachments: typeof item[]; nextCursor: null }>((resolve) => { resolveOld = resolve; });
    const client = { listStoredAttachments: vi.fn().mockReturnValueOnce(oldPage).mockResolvedValueOnce({ attachments: [{ ...item, name: 'new-chat.txt' }], nextCursor: null }), openAttachment: vi.fn() } as unknown as DesktopApi;
    const view = renderFiles(group, client);
    fireEvent.click(screen.getByRole('button', { name: 'Open saved files' }));
    view.rerender(<LocaleProvider value={{ status: 'loaded', effectiveLocale: 'en', preference: 'en', busy: false, error: null, retry() {}, retryRestart() {}, setPreference() {} }}>
      <ChatStoredFiles api={client} route={direct} />
    </LocaleProvider>);
    fireEvent.click(screen.getByRole('button', { name: 'Open saved files' }));
    expect(await screen.findByText('new-chat.txt')).toBeTruthy();
    resolveOld({ attachments: [item], nextCursor: null });
    await waitFor(() => expect(screen.queryByText('report.pdf')).toBeNull());
  });

  it('ignores an earlier request after the modal is closed and reopened', async () => {
    let resolveOld!: (value: { attachments: typeof item[]; nextCursor: null }) => void;
    const oldPage = new Promise<{ attachments: typeof item[]; nextCursor: null }>((resolve) => { resolveOld = resolve; });
    const client = { listStoredAttachments: vi.fn().mockReturnValueOnce(oldPage).mockResolvedValueOnce({ attachments: [{ ...item, name: 'fresh.txt' }], nextCursor: null }), openAttachment: vi.fn() } as unknown as DesktopApi;
    renderFiles(group, client);
    fireEvent.click(screen.getByRole('button', { name: 'Open saved files' }));
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    fireEvent.click(screen.getByRole('button', { name: 'Open saved files' }));
    expect(await screen.findByText('fresh.txt')).toBeTruthy();
    resolveOld({ attachments: [item], nextCursor: null });
    await waitFor(() => expect(screen.queryByText('report.pdf')).toBeNull());
  });

  it('focuses the modal, contains Tab, closes on Escape and restores focus to its trigger', async () => {
    renderFiles(group);
    const trigger = screen.getByRole('button', { name: 'Open saved files' });
    fireEvent.click(trigger);
    const dialog = await screen.findByRole('dialog', { name: 'Saved files' });
    const close = screen.getByRole('button', { name: 'Close' });
    const openFile = await screen.findByRole('button', { name: 'Open report.pdf' });

    expect(document.activeElement).toBe(dialog);
    fireEvent.keyDown(document, { key: 'Tab', shiftKey: true });
    expect(document.activeElement).toBe(openFile);
    fireEvent.keyDown(document, { key: 'Tab' });
    expect(document.activeElement).toBe(close);
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByRole('dialog', { name: 'Saved files' })).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });

  it('ignores a failed open completion after the modal is closed and reopened', async () => {
    const pendingOpen = deferred<boolean>();
    const client = { listStoredAttachments: vi.fn(async () => ({ attachments: [item], nextCursor: null })), openAttachment: vi.fn(() => pendingOpen.promise) } as unknown as DesktopApi;
    renderFiles(group, client);
    fireEvent.click(screen.getByRole('button', { name: 'Open saved files' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Open report.pdf' }));
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    fireEvent.click(screen.getByRole('button', { name: 'Open saved files' }));
    expect(await screen.findByRole('dialog', { name: 'Saved files' })).toBeTruthy();
    pendingOpen.reject(new Error('open failed'));
    await waitFor(() => expect(screen.queryByRole('alert', { name: 'Unable to open this file.' })).toBeNull());
    expect(screen.queryByText('Unable to open this file.')).toBeNull();
  });

  it('does not let an old successful open clear a newer open failure', async () => {
    const pendingOpen = deferred<boolean>();
    const client = { listStoredAttachments: vi.fn(async () => ({ attachments: [item], nextCursor: null })), openAttachment: vi.fn()
      .mockReturnValueOnce(pendingOpen.promise).mockRejectedValueOnce(new Error('current open failed')) } as unknown as DesktopApi;
    renderFiles(group, client);
    fireEvent.click(screen.getByRole('button', { name: 'Open saved files' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Open report.pdf' }));
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    fireEvent.click(screen.getByRole('button', { name: 'Open saved files' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Open report.pdf' }));
    expect(await screen.findByText('Unable to open this file.')).toBeTruthy();
    pendingOpen.resolve(true);
    await waitFor(() => expect(screen.getByText('Unable to open this file.')).toBeTruthy());
  });
});
