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
  it('shows a local saved-file list with an Open button that keeps the name in its label and opens by attachment ID while disconnected', async () => {
    const client = { listStoredAttachments: vi.fn(async () => ({ attachments: [item], nextCursor: null })), openAttachment: vi.fn(async () => true) } as unknown as DesktopApi;
    renderFiles(group, client);
    fireEvent.click(screen.getByRole('button', { name: 'Open saved files' }));
    expect(await screen.findByRole('dialog', { name: 'Saved files' })).toBeTruthy();
    const open = await screen.findByRole('button', { name: 'Open report.pdf' });
    expect(open.textContent).toBe('Open');
    expect(open.getAttribute('title')).toBe('report.pdf');
    expect(screen.getByText('report.pdf')).toBeTruthy();
    expect([...document.querySelectorAll('th')].map((cell) => cell.textContent)).toEqual(['Message date', 'Type', 'Size', 'Name', '']);
    fireEvent.click(open);
    await waitFor(() => expect(client.openAttachment).toHaveBeenCalledWith('attachment-1'));
    expect(client.listStoredAttachments).toHaveBeenCalledWith(group, null, 50, null);
  });

  it('uses the short Open text in every language', async () => {
    renderFiles(group, undefined, 'zh-TW');
    fireEvent.click(screen.getByRole('button', { name: '開啟已儲存檔案' }));
    expect((await screen.findByRole('button', { name: '開啟 report.pdf' })).textContent).toBe('開啟');
  });

  it('shows speaker tabs in group chats and reloads the table from the first page for the chosen sender', async () => {
    const second = { ...item, attachmentId: 'attachment-2', name: 'second.png', senderId: 'member-2', senderDisplayName: 'Mia' };
    const client = { listStoredAttachments: vi.fn(async (_key: ConversationKey, _cursor: string | null, _limit?: number, sender?: string | null) =>
      sender === 'member-2' ? { attachments: [second], nextCursor: null } : { attachments: [item, second], nextCursor: null }),
    listStoredAttachmentSenders: vi.fn(async () => ({ senders: [{ senderId: 'member-1', senderDisplayName: 'Kai', count: 3 }, { senderId: 'member-2', senderDisplayName: 'Mia', count: 1 }] })),
    openAttachment: vi.fn() } as unknown as DesktopApi;
    renderFiles(group, client);
    fireEvent.click(screen.getByRole('button', { name: 'Open saved files' }));
    expect(await screen.findByRole('tablist')).toBeTruthy();
    expect(screen.getAllByRole('tab').map((tab) => tab.textContent)).toEqual(['All', 'Kai (3)', 'Mia (1)']);
    expect(screen.getByRole('tab', { name: 'All' }).getAttribute('aria-selected')).toBe('true');
    expect(await screen.findByRole('button', { name: 'Open report.pdf' })).toBeTruthy();
    fireEvent.click(screen.getByRole('tab', { name: 'Mia (1)' }));
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Open report.pdf' })).toBeNull());
    expect(await screen.findByRole('button', { name: 'Open second.png' })).toBeTruthy();
    expect(screen.getByRole('tab', { name: 'Mia (1)' }).getAttribute('aria-selected')).toBe('true');
    expect(client.listStoredAttachments).toHaveBeenLastCalledWith(group, null, 50, 'member-2');
  });

  it('ignores a late response of an earlier tab and resets to All when the dialog opens again', async () => {
    const second = { ...item, attachmentId: 'attachment-2', name: 'second.png', senderId: 'member-2', senderDisplayName: 'Mia' };
    const slow = deferred<{ attachments: typeof item[]; nextCursor: null }>();
    const client = { listStoredAttachments: vi.fn()
      .mockResolvedValueOnce({ attachments: [item, second], nextCursor: null })
      .mockReturnValueOnce(slow.promise)
      .mockResolvedValueOnce({ attachments: [second], nextCursor: null })
      .mockResolvedValueOnce({ attachments: [item, second], nextCursor: null }),
    listStoredAttachmentSenders: vi.fn(async () => ({ senders: [{ senderId: 'member-1', senderDisplayName: 'Kai', count: 1 }, { senderId: 'member-2', senderDisplayName: 'Mia', count: 1 }] })),
    openAttachment: vi.fn() } as unknown as DesktopApi;
    renderFiles(group, client);
    fireEvent.click(screen.getByRole('button', { name: 'Open saved files' }));
    fireEvent.click(await screen.findByRole('tab', { name: 'Kai (1)' }));
    fireEvent.click(screen.getByRole('tab', { name: 'Mia (1)' }));
    expect(await screen.findByRole('button', { name: 'Open second.png' })).toBeTruthy();
    slow.resolve({ attachments: [item], nextCursor: null });
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Open report.pdf' })).toBeNull());
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    fireEvent.click(screen.getByRole('button', { name: 'Open saved files' }));
    expect((await screen.findByRole('tab', { name: 'All' })).getAttribute('aria-selected')).toBe('true');
    expect(client.listStoredAttachments).toHaveBeenLastCalledWith(group, null, 50, null);
  });

  it('shows no tabs for direct chats and paginates records without duplicate attachment rows', async () => {
    const client = { listStoredAttachments: vi.fn().mockResolvedValueOnce({ attachments: [item], nextCursor: 'next' })
      .mockResolvedValueOnce({ attachments: [item, { ...item, attachmentId: 'attachment-2', name: 'second.png' }], nextCursor: null }),
    listStoredAttachmentSenders: vi.fn(async () => ({ senders: [{ senderId: 'member-1', senderDisplayName: 'Kai', count: 1 }] })),
    openAttachment: vi.fn() } as unknown as DesktopApi;
    renderFiles(direct, client);
    fireEvent.click(screen.getByRole('button', { name: 'Open saved files' }));
    expect(await screen.findByRole('dialog', { name: 'Saved files' })).toBeTruthy();
    expect(screen.queryByRole('tablist')).toBeNull();
    expect(client.listStoredAttachmentSenders).not.toHaveBeenCalled();
    fireEvent.click(await screen.findByRole('button', { name: 'Load more' }));
    expect(await screen.findByRole('button', { name: 'Open second.png' })).toBeTruthy();
    expect(screen.getAllByRole('button', { name: 'Open report.pdf' })).toHaveLength(1);
    expect(client.listStoredAttachments).toHaveBeenNthCalledWith(2, direct, 'next', 50, null);
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
    expect(await screen.findByRole('button', { name: 'Open new-chat.txt' })).toBeTruthy();
    resolveOld({ attachments: [item], nextCursor: null });
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Open report.pdf' })).toBeNull());
  });

  it('ignores an earlier request after the modal is closed and reopened', async () => {
    let resolveOld!: (value: { attachments: typeof item[]; nextCursor: null }) => void;
    const oldPage = new Promise<{ attachments: typeof item[]; nextCursor: null }>((resolve) => { resolveOld = resolve; });
    const client = { listStoredAttachments: vi.fn().mockReturnValueOnce(oldPage).mockResolvedValueOnce({ attachments: [{ ...item, name: 'fresh.txt' }], nextCursor: null }), openAttachment: vi.fn() } as unknown as DesktopApi;
    renderFiles(group, client);
    fireEvent.click(screen.getByRole('button', { name: 'Open saved files' }));
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    fireEvent.click(screen.getByRole('button', { name: 'Open saved files' }));
    expect(await screen.findByRole('button', { name: 'Open fresh.txt' })).toBeTruthy();
    resolveOld({ attachments: [item], nextCursor: null });
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Open report.pdf' })).toBeNull());
  });

  it('focuses the modal, contains Tab, closes on Escape and restores focus to its trigger', async () => {
    renderFiles(group);
    const trigger = screen.getByRole('button', { name: 'Open saved files' });
    fireEvent.click(trigger);
    const dialog = await screen.findByRole('dialog', { name: 'Saved files' });
    const firstButton = screen.getByRole('button', { name: 'Open folder' });
    const openFile = await screen.findByRole('button', { name: 'Open report.pdf' });

    expect(document.activeElement).toBe(dialog);
    fireEvent.keyDown(document, { key: 'Tab', shiftKey: true });
    expect(document.activeElement).toBe(openFile);
    fireEvent.keyDown(document, { key: 'Tab' });
    expect(document.activeElement).toBe(firstButton);
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

  it('opens the saved-files folder of this chat from the header and shows an alert when it fails', async () => {
    const client = { listStoredAttachments: vi.fn(async () => ({ attachments: [item], nextCursor: null })), openAttachment: vi.fn(),
      openStoredAttachmentsFolder: vi.fn().mockResolvedValueOnce(true).mockResolvedValueOnce(false) } as unknown as DesktopApi;
    renderFiles(group, client);
    fireEvent.click(screen.getByRole('button', { name: 'Open saved files' }));
    await screen.findByRole('dialog', { name: 'Saved files' });
    fireEvent.click(screen.getByRole('button', { name: 'Open folder' }));
    await waitFor(() => expect(client.openStoredAttachmentsFolder).toHaveBeenCalledWith(group));
    expect(screen.queryByText('Unable to open the folder.')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Open folder' }));
    expect(await screen.findByText('Unable to open the folder.')).toBeTruthy();
  });
});
