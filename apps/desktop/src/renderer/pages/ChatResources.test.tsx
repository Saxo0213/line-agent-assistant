// @vitest-environment jsdom
import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { IpcRequestSchema, type ConversationKey } from '@line-agent/contracts';
import { LocaleProvider } from '../locale-context.js';
import { ChatResources, type ChatResourceApi } from './ChatResources.js';

afterEach(() => cleanup());

const route: ConversationKey = { accountId: 'agent-1', chatType: 'group', chatId: 'group-1' };
const note = { postId: 'note-1', createdTime: 1_760_000_000_000, text: 'Agenda\nNext week' };
const album = { albumId: 'album-1', chatId: route.chatId, title: 'Trip', photoCount: 1, createTime: null, updateTime: null };
const photo = { photoId: 'photo-1', oid: 'oid-1', prefix: 'album/a' as const, shotTime: null, width: 640, height: 480 };
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}

function api(): ChatResourceApi {
  return {
    listChatNotes: vi.fn(async () => ({ notes: [note], nextCursor: null })),
    getChatNote: vi.fn(async () => note),
    listChatAlbums: vi.fn(async () => ({ albums: [album], nextCursor: null })),
    listChatAlbumPhotos: vi.fn(async () => ({ photos: [photo], nextCursor: null })),
    downloadChatAlbumPhoto: vi.fn(async () => ({ albumId: album.albumId, photoId: photo.photoId, sizeBytes: 1200 })),
    openChatAlbum: vi.fn(async () => ({ albumId: album.albumId, savedCount: 1, failedCount: 0, totalCount: 1, byteCount: 1200, complete: true, failureCodes: [], errorCode: null })),
    cancelChatResourceRequest: vi.fn(async () => true),
  };
}

function renderControls(client = api(), status: 'connected' | 'disconnected' = 'connected', mode = 'ACTIVE_CONTROL', locale: 'en' | 'zh-TW' | 'ja' | 'ko' = 'en', selectedRoute = route) {
  return render(<LocaleProvider value={{ status: 'loaded', effectiveLocale: locale, preference: locale, busy: false, error: null, retry() {}, retryRestart() {}, setPreference() {} }}>
    <ChatResources api={client} route={selectedRoute} accountStatus={status} accountMode={mode} />
  </LocaleProvider>);
}

describe('ChatResources', () => {
  it('omits Note and Album actions while the account is not logged in', () => {
    renderControls(api(), 'disconnected');
    expect(screen.queryByRole('button', { name: 'Notes' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Albums' })).toBeNull();
  });

  it('omits Note and Album actions for a monitoring-only account', () => {
    renderControls(api(), 'connected', 'MONITOR_ONLY');
    expect(screen.queryByRole('button', { name: 'Open chat notes' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Open chat albums' })).toBeNull();
  });

  it('opens an accessible Notes dialog and shows note content', async () => {
    const client = api();
    renderControls(client);
    const notesAction = screen.getByRole('button', { name: 'Open chat notes' });
    const albumsAction = screen.getByRole('button', { name: 'Open chat albums' });
    expect(notesAction.textContent).toBe('');
    expect(albumsAction.textContent).toBe('');
    expect(notesAction.getAttribute('title')).toBe('Notes');
    expect(albumsAction.getAttribute('title')).toBe('Albums');
    fireEvent.click(notesAction);
    expect(await screen.findByRole('dialog', { name: 'Notes' })).toBeTruthy();
    expect(screen.queryByRole('navigation', { name: 'Notes / Albums' })).toBeNull();
    expect(await screen.findByRole('button', { name: 'Agenda' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Agenda' }));
    expect(await screen.findByText((_, element) => element?.tagName === 'PRE' && element.textContent === 'Agenda\nNext week')).toBeTruthy();
    expect(client.listChatNotes).toHaveBeenCalledWith(route, null, expect.any(String));
    expect(client.getChatNote).toHaveBeenCalledWith(route, note.postId, expect.any(String));
  });

  it('opens Albums from its header action without an in-dialog Notes or Albums switcher', async () => {
    renderControls();
    fireEvent.click(screen.getByRole('button', { name: 'Open chat albums' }));
    expect(await screen.findByRole('dialog', { name: 'Albums' })).toBeTruthy();
    expect(screen.queryByRole('navigation', { name: 'Notes / Albums' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Notes' })).toBeNull();
  });

  it('sends null cursors accepted by IPC for first Notes, Albums, and photo pages', async () => {
    const client = api();
    client.listChatNotes = vi.fn(async (_key, cursor, requestId) => {
      expect(IpcRequestSchema.safeParse({ type: 'listChatNotes', ...route, cursor, requestId }).success).toBe(true);
      return { notes: [note], nextCursor: null };
    });
    client.listChatAlbums = vi.fn(async (_key, cursor, requestId) => {
      expect(IpcRequestSchema.safeParse({ type: 'listChatAlbums', ...route, cursor, requestId }).success).toBe(true);
      return { albums: [album], nextCursor: null };
    });
    client.listChatAlbumPhotos = vi.fn(async (_key, albumId, cursor, requestId) => {
      expect(IpcRequestSchema.safeParse({ type: 'listChatAlbumPhotos', ...route, albumId, cursor, requestId }).success).toBe(true);
      return { photos: [photo], nextCursor: null };
    });
    renderControls(client);

    fireEvent.click(screen.getByRole('button', { name: 'Open chat notes' }));
    await screen.findByRole('button', { name: 'Agenda' });
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    fireEvent.click(screen.getByRole('button', { name: 'Open chat albums' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Trip' }));
    await screen.findByRole('button', { name: 'Download photo' });

    expect(client.listChatNotes).toHaveBeenCalledWith(route, null, expect.any(String));
    expect(client.listChatAlbums).toHaveBeenCalledWith(route, null, expect.any(String));
    expect(client.listChatAlbumPhotos).toHaveBeenCalledWith(route, album.albumId, null, expect.any(String));
  });

  it('lists album photos and reports a successful download', async () => {
    const client = api();
    renderControls(client);
    fireEvent.click(screen.getByRole('button', { name: 'Open chat albums' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Trip' }));
    expect(await screen.findByText('1 photo')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Download photo' }));
    expect(await screen.findByText('Image saved')).toBeTruthy();
    const preview = await screen.findByTestId('album-photo-preview-photo-1');
    fireEvent.load(preview);
    expect(await screen.findByLabelText('Saved photo')).toBeTruthy();
    expect(client.downloadChatAlbumPhoto).toHaveBeenCalledWith(route, album.albumId, photo.photoId, photo.oid, photo.prefix, expect.any(String));
  });

  it('shows saved album previews and marks a photo only after its archive image loads', async () => {
    const client = api();
    client.listChatAlbums = vi.fn(async () => ({ albums: [{ ...album, coverPhotoIds: ['photo-1', 'photo-2'] }], nextCursor: null }));
    client.listChatAlbumPhotos = vi.fn(async () => ({ photos: [photo, { ...photo, photoId: 'photo-2' }], nextCursor: null }));
    renderControls(client);
    fireEvent.click(screen.getByRole('button', { name: 'Open chat albums' }));
    const card = await screen.findByRole('button', { name: 'Trip' });
    expect(card.querySelectorAll('img')).toHaveLength(2);
    expect(client.downloadChatAlbumPhoto).not.toHaveBeenCalled();
    fireEvent.click(card);
    const preview = await screen.findByTestId('album-photo-preview-photo-1');
    expect(preview.getAttribute('src')).toMatch(/^line-media:\/\/album-photo\//);
    expect(screen.queryByLabelText('Saved photo')).toBeNull();
    fireEvent.load(preview);
    expect(await screen.findByLabelText('Saved photo')).toBeTruthy();
    expect(client.downloadChatAlbumPhoto).not.toHaveBeenCalled();
  });

  it('selects an album for display without starting archive reconciliation', async () => {
    const client = api();
    client.openChatAlbum = vi.fn(async () => ({ albumId: album.albumId, savedCount: 2, failedCount: 0, totalCount: 2,
      byteCount: 2400, complete: true, failureCodes: [], errorCode: null }));
    renderControls(client);
    fireEvent.click(screen.getByRole('button', { name: 'Open chat albums' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Trip' }));
    await screen.findByRole('button', { name: 'Download photo' });
    fireEvent.click(screen.getByRole('button', { name: 'Back' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Trip' }));
    await waitFor(() => expect(client.listChatAlbumPhotos).toHaveBeenCalledTimes(2));
    expect(client.openChatAlbum).not.toHaveBeenCalled();
    expect(screen.queryByText('Saving album photos…')).toBeNull();
  });

  it('marks an explicit album photo refresh as a LINE refresh request', async () => {
    const client = api();
    renderControls(client);
    fireEvent.click(screen.getByRole('button', { name: 'Open chat albums' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Trip' }));
    await screen.findByRole('button', { name: 'Download photo' });
    fireEvent.click(screen.getByRole('button', { name: 'Refresh' }));
    await waitFor(() => expect(client.listChatAlbumPhotos).toHaveBeenCalledTimes(2));
    expect(client.listChatAlbumPhotos).toHaveBeenLastCalledWith(route, album.albumId, null, expect.any(String), true);
  });

  it('shows a retryable error when a list read fails', async () => {
    const client = api();
    client.listChatNotes = vi.fn(async () => { throw new Error('private backend detail'); });
    renderControls(client);
    fireEvent.click(screen.getByRole('button', { name: 'Open chat notes' }));
    expect((await screen.findByRole('alert')).textContent).toContain('Unable to load notes');
    expect(screen.queryByText('private backend detail')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    await waitFor(() => expect(client.listChatNotes).toHaveBeenCalledTimes(2));
  });

  it('requests one bounded cursor page at a time and refreshes from the first page', async () => {
    const client = api();
    client.listChatNotes = vi.fn()
      .mockResolvedValueOnce({ notes: [note], nextCursor: 'cursor-2' })
      .mockResolvedValueOnce({ notes: [], nextCursor: null })
      .mockResolvedValueOnce({ notes: [note], nextCursor: null });
    renderControls(client);
    fireEvent.click(screen.getByRole('button', { name: 'Open chat notes' }));
    await screen.findByRole('button', { name: 'Load more' });
    expect(client.listChatNotes).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole('button', { name: 'Load more' }));
    await waitFor(() => expect(client.listChatNotes).toHaveBeenCalledWith(route, 'cursor-2', expect.any(String)));
    fireEvent.click(screen.getByRole('button', { name: 'Refresh' }));
    await waitFor(() => expect(client.listChatNotes).toHaveBeenLastCalledWith(route, null, expect.any(String)));
  });

  it.each([
    ['zh-TW', '開啟聊天室記事'], ['ja', 'チャットのノートを開く'], ['ko', '대화 노트 열기'],
  ] as const)('localizes resource actions in %s', (locale, label) => {
    renderControls(api(), 'connected', 'ACTIVE_CONTROL', locale);
    expect(screen.getByRole('button', { name: label })).toBeTruthy();
  });

  it('refreshes the first Notes page after closing and reopening', async () => {
    const client = api();
    const refreshed = { ...note, postId: 'note-2', text: 'Updated agenda' };
    client.listChatNotes = vi.fn()
      .mockResolvedValueOnce({ notes: [note], nextCursor: null })
      .mockResolvedValueOnce({ notes: [refreshed], nextCursor: null });
    renderControls(client);
    fireEvent.click(screen.getByRole('button', { name: 'Open chat notes' }));
    await screen.findByRole('button', { name: 'Agenda' });
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    fireEvent.click(screen.getByRole('button', { name: 'Open chat notes' }));
    expect(await screen.findByRole('button', { name: 'Updated agenda' })).toBeTruthy();
    expect(client.listChatNotes).toHaveBeenCalledTimes(2);
    expect(client.listChatNotes).toHaveBeenLastCalledWith(route, null, expect.any(String));
  });

  it('refreshes Albums when closing and reopening its header action', async () => {
    const client = api();
    const refreshed = { ...album, albumId: 'album-2', title: 'Updated trip' };
    client.listChatAlbums = vi.fn()
      .mockResolvedValueOnce({ albums: [album], nextCursor: null })
      .mockResolvedValueOnce({ albums: [refreshed], nextCursor: null });
    renderControls(client);
    fireEvent.click(screen.getByRole('button', { name: 'Open chat albums' }));
    await screen.findByRole('button', { name: 'Trip' });
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    fireEvent.click(screen.getByRole('button', { name: 'Open chat albums' }));
    expect(await screen.findByRole('button', { name: 'Updated trip' })).toBeTruthy();
    expect(client.listChatAlbums).toHaveBeenCalledTimes(2);
    expect(client.listChatAlbums).toHaveBeenLastCalledWith(route, null, expect.any(String));
  });

  it('shows only the latest album selection after an older photo request finishes', async () => {
    const client = api();
    const albumB = { ...album, albumId: 'album-b', title: 'B' };
    const photoA = { ...photo, photoId: 'photo-a', oid: 'oid-a' };
    const photoB = { ...photo, photoId: 'photo-b', oid: 'oid-b' };
    const pendingA = deferred<{ photos: typeof photoA[]; nextCursor: string | null }>();
    const pendingB = deferred<{ photos: typeof photoB[]; nextCursor: string | null }>();
    client.listChatAlbums = vi.fn(async () => ({ albums: [album, albumB], nextCursor: null }));
    client.listChatAlbumPhotos = vi.fn((_key, albumId) => albumId === album.albumId ? pendingA.promise : pendingB.promise);
    renderControls(client);
    fireEvent.click(screen.getByRole('button', { name: 'Open chat albums' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Trip' }));
    fireEvent.click(screen.getByRole('button', { name: 'Back' }));
    fireEvent.click(await screen.findByRole('button', { name: 'B' }));
    expect(client.listChatAlbumPhotos).toHaveBeenCalledTimes(2);
    expect(client.listChatAlbumPhotos).toHaveBeenLastCalledWith(route, albumB.albumId, null, expect.any(String));
    pendingB.resolve({ photos: [photoB], nextCursor: null });
    await screen.findByRole('button', { name: 'Download photo' });
    pendingA.resolve({ photos: [photoA], nextCursor: null });
    fireEvent.click(screen.getByRole('button', { name: 'Download photo' }));
    await waitFor(() => expect(client.downloadChatAlbumPhoto).toHaveBeenCalledWith(route, albumB.albumId, photoB.photoId, photoB.oid, photoB.prefix, expect.any(String)));
  });

  it('cancels active reads when the modal closes and ignores a late success', async () => {
    const client = api();
    let activeRequestId: string | undefined;
    const pending = deferred<{ notes: typeof note[]; nextCursor: string | null }>();
    let calls = 0;
    client.listChatNotes = vi.fn((_key: ConversationKey, _cursor: string | null, requestId?: string) => {
      activeRequestId = requestId;
      return calls++ === 0 ? pending.promise : Promise.resolve({ notes: [], nextCursor: null });
    });
    renderControls(client);
    fireEvent.click(screen.getByRole('button', { name: 'Open chat notes' }));
    expect(activeRequestId).toEqual(expect.any(String));
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    expect(client.cancelChatResourceRequest).toHaveBeenCalledWith(activeRequestId);
    pending.resolve({ notes: [{ ...note, postId: 'late-note', text: 'Late result' }], nextCursor: null });
    await waitFor(() => expect(screen.queryByText('Late result')).toBeNull());
    fireEvent.click(screen.getByRole('button', { name: 'Open chat notes' }));
    await screen.findByText('No notes in this chat.');
    expect(screen.queryByRole('button', { name: 'Late result' })).toBeNull();
  });

  it('removes settled request tracking so closing does not cancel a completed read', async () => {
    const client = api();
    renderControls(client);
    fireEvent.click(screen.getByRole('button', { name: 'Open chat notes' }));
    await screen.findByRole('button', { name: 'Agenda' });
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    expect(client.cancelChatResourceRequest).not.toHaveBeenCalled();
  });

  it('aborts active reads when the selected chat changes', async () => {
    const client = api();
    let activeRequestId: string | undefined;
    client.listChatNotes = vi.fn((_key: ConversationKey, _cursor: string | null, requestId?: string) => { activeRequestId = requestId; return new Promise<never>(() => {}); });
    const view = renderControls(client);
    fireEvent.click(screen.getByRole('button', { name: 'Open chat notes' }));
    expect(activeRequestId).toEqual(expect.any(String));
    view.rerender(<LocaleProvider value={{ status: 'loaded', effectiveLocale: 'en', preference: 'en', busy: false, error: null, retry() {}, retryRestart() {}, setPreference() {} }}>
      <ChatResources api={client} route={{ ...route, chatId: 'group-2' }} accountStatus="connected" accountMode="ACTIVE_CONTROL" />
    </LocaleProvider>);
    expect(client.cancelChatResourceRequest).toHaveBeenCalledWith(activeRequestId);
  });

  it('cancels active reads on unmount', () => {
    const client = api();
    let activeRequestId: string | undefined;
    client.listChatNotes = vi.fn((_key: ConversationKey, _cursor: string | null, requestId?: string) => { activeRequestId = requestId; return new Promise<never>(() => {}); });
    const view = renderControls(client);
    fireEvent.click(screen.getByRole('button', { name: 'Open chat notes' }));
    view.unmount();
    expect(client.cancelChatResourceRequest).toHaveBeenCalledWith(activeRequestId);
  });

  it('ignores note detail results after Back and reopen', async () => {
    const client = api();
    const pending = deferred<typeof note>();
    client.getChatNote = vi.fn(() => pending.promise);
    renderControls(client);
    fireEvent.click(screen.getByRole('button', { name: 'Open chat notes' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Agenda' }));
    fireEvent.click(screen.getByRole('button', { name: 'Back' }));
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    fireEvent.click(screen.getByRole('button', { name: 'Open chat notes' }));
    await screen.findByRole('button', { name: 'Agenda' });
    pending.resolve({ ...note, text: 'Late stale note' });
    await waitFor(() => expect(screen.queryByText('Late stale note')).toBeNull());
    expect(screen.queryByRole('heading', { name: 'Late stale note' })).toBeNull();
  });

  it('keeps Shift+Tab inside the dialog when focus starts on the dialog container', async () => {
    renderControls();
    fireEvent.click(screen.getByRole('button', { name: 'Open chat notes' }));
    const dialog = await screen.findByRole('dialog', { name: 'Notes' });
    await screen.findByRole('button', { name: 'Agenda' });
    dialog.focus();
    fireEvent.keyDown(document, { key: 'Tab', shiftKey: true });
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Agenda' }));
  });

  it('applies a pending Notes page after opening and leaving note detail', async () => {
    const client = api();
    const note2 = { ...note, postId: 'note-2', text: 'Second page note' };
    const pending = deferred<{ notes: typeof note2[]; nextCursor: string | null }>();
    client.listChatNotes = vi.fn()
      .mockResolvedValueOnce({ notes: [note], nextCursor: 'cursor-2' })
      .mockReturnValueOnce(pending.promise);
    renderControls(client);
    fireEvent.click(screen.getByRole('button', { name: 'Open chat notes' }));
    await screen.findByRole('button', { name: 'Load more' });
    fireEvent.click(screen.getByRole('button', { name: 'Load more' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Agenda' }));
    fireEvent.click(screen.getByRole('button', { name: 'Back' }));
    pending.resolve({ notes: [note2], nextCursor: 'cursor-3' });
    expect(await screen.findByRole('button', { name: 'Second page note' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Refresh' }).hasAttribute('disabled')).toBe(false);
    expect(screen.getByRole('button', { name: 'Load more' })).toBeTruthy();
  });

  it('applies a pending Albums page after opening and leaving album detail', async () => {
    const client = api();
    const album2 = { ...album, albumId: 'album-2', title: 'Second page album' };
    const pending = deferred<{ albums: typeof album2[]; nextCursor: string | null }>();
    client.listChatAlbums = vi.fn()
      .mockResolvedValueOnce({ albums: [album], nextCursor: 'cursor-2' })
      .mockReturnValueOnce(pending.promise);
    renderControls(client);
    fireEvent.click(screen.getByRole('button', { name: 'Open chat albums' }));
    await screen.findByRole('button', { name: 'Load more' });
    fireEvent.click(screen.getByRole('button', { name: 'Load more' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Trip' }));
    fireEvent.click(screen.getByRole('button', { name: 'Back' }));
    pending.resolve({ albums: [album2], nextCursor: 'cursor-3' });
    expect(await screen.findByRole('button', { name: 'Second page album' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Refresh' }).hasAttribute('disabled')).toBe(false);
    expect(screen.getByRole('button', { name: 'Load more' })).toBeTruthy();
  });
});
