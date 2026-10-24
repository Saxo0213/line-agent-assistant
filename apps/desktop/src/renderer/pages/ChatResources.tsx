import React, { useEffect, useRef, useState } from 'react';
import { Download, Image as ImageIcon, NotebookPen, RotateCw, X } from 'lucide-react';
import type { AlbumFailureContextDto, ConversationKey } from '@line-agent/contracts';
import { lineMediaUrl } from '@line-agent/contracts';
import { useDesktopLocale } from '../desktop-i18n.js';
import type { Locale } from '../../locale.js';

export type ChatNote = { postId: string; createdTime: number | null; text: string | null; content?: Record<string, unknown> };
export type ChatAlbum = { albumId: string; chatId: string; title: string | null; photoCount: number | null; createTime: number | null; updateTime: number | null; coverPhotoIds?: string[] };
export type ChatAlbumPhoto = { photoId: string; oid: string; prefix: 'album/a' | 'album/v'; shotTime: number | null; width: number | null; height: number | null };
export type ChatResourceApi = {
  listChatNotes(key: ConversationKey, cursor: string | null, requestId?: string): Promise<{ notes: ChatNote[]; nextCursor: string | null }>;
  getChatNote(key: ConversationKey, postId: string, requestId?: string): Promise<ChatNote>;
  listChatAlbums(key: ConversationKey, cursor: string | null, requestId?: string, refresh?: boolean): Promise<{ albums: ChatAlbum[]; nextCursor: string | null }>;
  listChatAlbumPhotos(key: ConversationKey, albumId: string, cursor: string | null, requestId?: string, refresh?: boolean): Promise<{ photos: ChatAlbumPhoto[]; nextCursor: string | null }>;
  downloadChatAlbumPhoto(key: ConversationKey, albumId: string, photoId: string, oid: string, prefix: 'album/a' | 'album/v', requestId?: string): Promise<{ albumId: string; photoId: string; sizeBytes: number }>;
  openChatAlbum(key: ConversationKey, albumId: string, requestId?: string): Promise<{ savedCount: number; failedCount: number; totalCount: number; complete: boolean; failureCodes: string[]; errorCode: string | null; failureContext?: AlbumFailureContextDto }>;
  cancelChatResourceRequest(targetRequestId: string): Promise<boolean>;
};

const COPY = {
  en: { notes: 'Notes', albums: 'Albums', close: 'Close', refresh: 'Refresh', loading: 'Loading…', loadNotesError: 'Unable to load notes.', loadAlbumsError: 'Unable to load albums.', loadPhotosError: 'Unable to load photos.', loadNoteError: 'Unable to load this note.', emptyNotes: 'No notes in this chat.', emptyAlbums: 'No albums in this chat.', emptyPhotos: 'No photos in this album.', more: 'Load more', retry: 'Retry', saved: 'Image saved', saveError: 'Unable to save this image.', back: 'Back', photos: '{n} photo', photosPlural: '{n} photos', photo: 'LINE photo', download: 'Download photo', untitled: 'Untitled note', unnamedAlbum: 'Untitled album', openNotes: 'Open chat notes', openAlbums: 'Open chat albums', archivingAlbum: 'Saving album photos…', albumArchiveComplete: 'Saved {saved} of {total} photos.', albumArchivePartial: 'Saved {saved} of {total}; {failed} failed.', albumArchiveCancelled: 'Album archive cancelled.', albumArchiveFailed: 'Album archive failed ({code}).', albumArchiveStage: 'Failure stage: {action} / {stage}.' },
  'zh-TW': { notes: '記事本', albums: '相簿', close: '關閉', refresh: '重新整理', loading: '載入中…', loadNotesError: '無法載入記事。', loadAlbumsError: '無法載入相簿。', loadNoteError: '無法載入這則記事。', loadPhotosError: '無法載入照片。', emptyNotes: '此聊天室沒有記事。', emptyAlbums: '此聊天室沒有相簿。', emptyPhotos: '此相簿沒有照片。', more: '載入更多', retry: '重試', saved: '圖片已儲存', saveError: '無法儲存這張圖片。', back: '返回', photos: '{n} 張照片', photosPlural: '{n} 張照片', photo: 'LINE 照片', download: '下載照片', untitled: '未命名記事', unnamedAlbum: '未命名相簿', openNotes: '開啟聊天室記事', openAlbums: '開啟聊天室相簿', archivingAlbum: '正在儲存相簿照片…', albumArchiveComplete: '已儲存 {saved}/{total} 張照片。', albumArchivePartial: '已儲存 {saved}/{total} 張；{failed} 張失敗。', albumArchiveCancelled: '已取消相簿封存。', albumArchiveFailed: '相簿封存失敗（{code}）。', albumArchiveStage: '失敗階段：{action} / {stage}。' },
  ja: { notes: 'ノート', albums: 'アルバム', close: '閉じる', refresh: '更新', loading: '読み込み中…', loadNotesError: 'ノートを読み込めません。', loadAlbumsError: 'アルバムを読み込めません。', loadPhotosError: '写真を読み込めません。', loadNoteError: 'このノートを読み込めません。', emptyNotes: 'このチャットにノートはありません。', emptyAlbums: 'このチャットにアルバムはありません。', emptyPhotos: 'このアルバムに写真はありません。', more: 'さらに読み込む', retry: '再試行', saved: '画像を保存しました', saveError: 'この画像を保存できません。', back: '戻る', photos: '写真 {n} 枚', photosPlural: '写真 {n} 枚', photo: 'LINE 写真', download: '写真を保存', untitled: '無題のノート', unnamedAlbum: '無題のアルバム', openNotes: 'チャットのノートを開く', openAlbums: 'チャットのアルバムを開く', archivingAlbum: 'アルバムの写真を保存中…', albumArchiveComplete: '{total} 枚中 {saved} 枚を保存しました。', albumArchivePartial: '{total} 枚中 {saved} 枚を保存、{failed} 枚失敗しました。', albumArchiveCancelled: 'アルバム保存をキャンセルしました。', albumArchiveFailed: 'アルバム保存に失敗しました（{code}）。', albumArchiveStage: '失敗段階：{action} / {stage}。' },
  ko: { notes: '노트', albums: '앨범', close: '닫기', refresh: '새로고침', loading: '불러오는 중…', loadNotesError: '노트를 불러올 수 없습니다.', loadAlbumsError: '앨범을 불러올 수 없습니다.', loadPhotosError: '사진을 불러올 수 없습니다.', loadNoteError: '이 노트를 불러올 수 없습니다.', emptyNotes: '이 대화에 노트가 없습니다.', emptyAlbums: '이 대화에 앨범이 없습니다.', emptyPhotos: '이 앨범에 사진이 없습니다.', more: '더 불러오기', retry: '다시 시도', saved: '이미지를 저장했습니다', saveError: '이 이미지를 저장할 수 없습니다.', back: '뒤로', photos: '사진 {n}장', photosPlural: '사진 {n}장', photo: 'LINE 사진', download: '사진 저장', untitled: '제목 없는 노트', unnamedAlbum: '제목 없는 앨범', openNotes: '대화 노트 열기', openAlbums: '대화 앨범 열기', archivingAlbum: '앨범 사진 저장 중…', albumArchiveComplete: '사진 {saved}/{total}장 저장 완료.', albumArchivePartial: '{total}장 중 {saved}장 저장, {failed}장 실패.', albumArchiveCancelled: '앨범 저장을 취소했습니다.', albumArchiveFailed: '앨범 저장 실패 ({code}).', albumArchiveStage: '실패 단계: {action} / {stage}.' },
} satisfies Record<Locale, Record<string, string>>;
type ResourceKind = 'notes' | 'albums';
type ReadState = 'idle' | 'loading' | 'error' | 'ready';
const keyId = (key: ConversationKey) => JSON.stringify([key.accountId, key.chatType, key.chatId]);
const savedPhotoLabel = (locale: Locale) => locale === 'zh-TW' ? '已儲存的照片' : locale === 'ja' ? '保存済みの写真' : locale === 'ko' ? '저장된 사진' : 'Saved photo';

/** Per-chat Note and Album controls. Calls are explicit and one cursor page per action. */
export function ChatResources({ api, route, accountStatus, accountMode }: { api: ChatResourceApi; route: ConversationKey; accountStatus: string; accountMode: string }) {
  const locale = useDesktopLocale();
  const copy = COPY[locale];
  const [kind, setKind] = useState<ResourceKind | null>(null);
  const [notes, setNotes] = useState<ChatNote[]>([]);
  const [albums, setAlbums] = useState<ChatAlbum[]>([]);
  const [photos, setPhotos] = useState<ChatAlbumPhoto[]>([]);
  const [noteCursor, setNoteCursor] = useState<string | null>(null);
  const [albumCursor, setAlbumCursor] = useState<string | null>(null);
  const [photoCursor, setPhotoCursor] = useState<string | null>(null);
  const [noteState, setNoteState] = useState<ReadState>('idle');
  const [albumState, setAlbumState] = useState<ReadState>('idle');
  const [photoState, setPhotoState] = useState<ReadState>('idle');
  const [noteError, setNoteError] = useState(false);
  const [albumError, setAlbumError] = useState(false);
  const [photoError, setPhotoError] = useState(false);
  const [selectedNote, setSelectedNote] = useState<ChatNote | null>(null);
  const [selectedAlbum, setSelectedAlbum] = useState<ChatAlbum | null>(null);
  const [noteDetailState, setNoteDetailState] = useState<ReadState>('idle');
  const [downloadState, setDownloadState] = useState<Record<string, 'loading' | 'saved' | 'error'>>({});
  const dialog = useRef<HTMLDivElement | null>(null);
  const openButton = useRef<HTMLButtonElement | null>(null);
  const albumButton = useRef<HTMLButtonElement | null>(null);
  const requestLocks = useRef(new Set<string>());
  const activeRequests = useRef(new Set<string>());
  const viewGeneration = useRef(0);
  const notesGeneration = useRef(0);
  const albumsGeneration = useRef(0);
  const kindRef = useRef<ResourceKind | null>(null);
  const selectedAlbumRef = useRef<ChatAlbum | null>(null);
  const selectedNoteId = useRef<string | null>(null);
  const pendingNotes = useRef<{ append: boolean; generation: number } | null>(null);
  const pendingAlbums = useRef<{ append: boolean; generation: number } | null>(null);
  const activePhotoReads = useRef(0);
  const pendingPhotos = useRef<{ album: ChatAlbum; append: boolean; generation: number } | null>(null);
  const pendingNoteDetail = useRef<{ note: ChatNote; generation: number } | null>(null);
  const requestKey = keyId(route);
  const loggedIn = accountStatus === 'connected' && accountMode !== 'MONITOR_ONLY';
  const cancelRequests = () => { for (const requestId of activeRequests.current) void api.cancelChatResourceRequest(requestId).catch(() => false); activeRequests.current.clear(); };
  const withRequestId = async <T,>(run: (requestId: string) => Promise<T>): Promise<T> => {
    const requestId = crypto.randomUUID(); activeRequests.current.add(requestId);
    try { return await run(requestId); }
    finally { activeRequests.current.delete(requestId); }
  };

  const open = (next: ResourceKind) => {
    cancelRequests();
    ++viewGeneration.current;
    const generation = next === 'notes' ? ++notesGeneration.current : ++albumsGeneration.current;
    kindRef.current = next;
    selectedNoteId.current = null;
    selectedAlbumRef.current = null;
    pendingNoteDetail.current = null;
    setKind(next);
    setSelectedNote(null);
    setSelectedAlbum(null);
    setDownloadState({});
    if (next === 'notes') {
      setNotes([]); setNoteCursor(null); setNoteState('idle');
      void loadNotes(false, generation);
    } else {
      setAlbums([]); setAlbumCursor(null); setAlbumState('idle'); setPhotos([]); setPhotoCursor(null); setPhotoState('idle');
      void loadAlbums(false, generation);
    }
  };
  const close = () => {
    cancelRequests();
    ++viewGeneration.current; kindRef.current = null; selectedNoteId.current = null; selectedAlbumRef.current = null;
    ++notesGeneration.current; ++albumsGeneration.current;
    pendingNotes.current = null; pendingAlbums.current = null; pendingPhotos.current = null; pendingNoteDetail.current = null;
    setKind(null); setSelectedNote(null); setSelectedAlbum(null); (kind === 'albums' ? albumButton.current : openButton.current)?.focus();
  };
  const refresh = () => {
    const generation = ++viewGeneration.current;
    selectedNoteId.current = null; pendingNoteDetail.current = null; setSelectedNote(null);
    if (kind === 'notes') { const listGeneration = ++notesGeneration.current; setNotes([]); setNoteCursor(null); void loadNotes(false, listGeneration); }
    else if (selectedAlbum) { setPhotos([]); setPhotoCursor(null); void loadPhotos(selectedAlbum, false, generation, true); }
    else if (kind === 'albums') { const listGeneration = ++albumsGeneration.current; setAlbums([]); setAlbumCursor(null); void loadAlbums(false, listGeneration, true); }
  };

  async function loadNotes(append: boolean, generation = notesGeneration.current) {
    setNoteState('loading'); setNoteError(false);
    if (requestLocks.current.has('notes')) { pendingNotes.current = { append, generation }; return; }
    requestLocks.current.add('notes');
    try {
      const page = await withRequestId((requestId) => api.listChatNotes(route, append ? noteCursor : null, requestId));
      if (generation === notesGeneration.current && kindRef.current === 'notes') {
        setNotes((current) => append ? [...current, ...page.notes] : page.notes);
        setNoteCursor(page.nextCursor); setNoteState('ready');
      }
    } catch { if (generation === notesGeneration.current && kindRef.current === 'notes') { setNoteError(true); setNoteState('error'); } }
    finally {
      requestLocks.current.delete('notes');
      const pending = pendingNotes.current; pendingNotes.current = null;
      if (pending && pending.generation === notesGeneration.current && kindRef.current === 'notes') void loadNotes(pending.append, pending.generation);
    }
  }
  async function loadAlbums(append: boolean, generation = albumsGeneration.current, refresh = false) {
    setAlbumState('loading'); setAlbumError(false);
    if (requestLocks.current.has('albums')) { pendingAlbums.current = { append, generation }; return; }
    requestLocks.current.add('albums');
    try {
      const page = await withRequestId((requestId) => refresh
        ? api.listChatAlbums(route, append ? albumCursor : null, requestId, true)
        : api.listChatAlbums(route, append ? albumCursor : null, requestId));
      if (generation === albumsGeneration.current && kindRef.current === 'albums') {
        setAlbums((current) => append ? [...current, ...page.albums] : page.albums);
        setAlbumCursor(page.nextCursor); setAlbumState('ready');
      }
    } catch { if (generation === albumsGeneration.current && kindRef.current === 'albums') { setAlbumError(true); setAlbumState('error'); } }
    finally {
      requestLocks.current.delete('albums');
      const pending = pendingAlbums.current; pendingAlbums.current = null;
      if (pending && pending.generation === albumsGeneration.current && kindRef.current === 'albums') void loadAlbums(pending.append, pending.generation);
    }
  }
  async function loadPhotos(album: ChatAlbum, append: boolean, generation = viewGeneration.current, refresh = false) {
    setPhotoState('loading'); setPhotoError(false);
    if (activePhotoReads.current >= 2) { pendingPhotos.current = { album, append, generation }; return; }
    activePhotoReads.current += 1;
    try {
      const page = await withRequestId((requestId) => refresh
        ? api.listChatAlbumPhotos(route, album.albumId, append ? photoCursor : null, requestId, true)
        : api.listChatAlbumPhotos(route, album.albumId, append ? photoCursor : null, requestId));
      if (generation === viewGeneration.current && kindRef.current === 'albums' && selectedAlbumRef.current?.albumId === album.albumId) {
        setPhotos((current) => append ? [...current, ...page.photos] : page.photos);
        setPhotoCursor(page.nextCursor); setPhotoState('ready');
      }
    } catch { if (generation === viewGeneration.current && kindRef.current === 'albums' && selectedAlbumRef.current?.albumId === album.albumId) { setPhotoError(true); setPhotoState('error'); } }
    finally {
      activePhotoReads.current -= 1;
      const pending = pendingPhotos.current; pendingPhotos.current = null;
      if (pending && pending.generation === viewGeneration.current && kindRef.current === 'albums' && selectedAlbumRef.current?.albumId === pending.album.albumId) {
        void loadPhotos(pending.album, pending.append, pending.generation);
      }
    }
  }
  async function selectNote(note: ChatNote) {
    const generation = ++viewGeneration.current;
    selectedNoteId.current = note.postId;
    setSelectedNote(note); setNoteDetailState('loading');
    if (requestLocks.current.has('note')) { pendingNoteDetail.current = { note, generation }; return; }
    await loadNoteDetail(note, generation);
  }
  async function loadNoteDetail(note: ChatNote, generation: number) {
    requestLocks.current.add('note');
    try {
      const detail = await withRequestId((requestId) => api.getChatNote(route, note.postId, requestId));
      if (generation === viewGeneration.current && kindRef.current === 'notes' && selectedNoteId.current === note.postId) { setSelectedNote(detail); setNoteDetailState('ready'); }
    } catch { if (generation === viewGeneration.current && kindRef.current === 'notes' && selectedNoteId.current === note.postId) setNoteDetailState('error'); }
    finally {
      requestLocks.current.delete('note');
      const pending = pendingNoteDetail.current; pendingNoteDetail.current = null;
      if (pending && pending.generation === viewGeneration.current && kindRef.current === 'notes' && selectedNoteId.current === pending.note.postId) void loadNoteDetail(pending.note, pending.generation);
    }
  }
  async function selectAlbum(album: ChatAlbum) {
    cancelRequests();
    const generation = ++viewGeneration.current;
    selectedAlbumRef.current = album;
    setSelectedAlbum(album); setPhotos([]); setPhotoCursor(null); setPhotoState('idle'); setDownloadState({});
    void loadPhotos(album, false, generation);
  }
  function backFromNote() {
    ++viewGeneration.current; selectedNoteId.current = null; pendingNoteDetail.current = null;
    setSelectedNote(null); setNoteDetailState('idle');
  }
  function backFromAlbum() {
    cancelRequests();
    ++viewGeneration.current; selectedAlbumRef.current = null; pendingPhotos.current = null;
    setSelectedAlbum(null); setPhotos([]); setPhotoCursor(null); setPhotoState('idle');
  }
  async function download(photo: ChatAlbumPhoto) {
    if (!selectedAlbum || requestLocks.current.has('download')) return;
    requestLocks.current.add('download');
    setDownloadState((current) => ({ ...current, [photo.photoId]: 'loading' }));
    try {
      await withRequestId((requestId) => api.downloadChatAlbumPhoto(route, selectedAlbum.albumId, photo.photoId, photo.oid, photo.prefix, requestId));
      setDownloadState((current) => ({ ...current, [photo.photoId]: 'saved' }));
      setAlbums((current) => current.map((album) => album.albumId === selectedAlbum.albumId
        ? { ...album, coverPhotoIds: [photo.photoId, ...(album.coverPhotoIds ?? []).filter((id) => id !== photo.photoId)].slice(0, 2) } : album));
    } catch { setDownloadState((current) => ({ ...current, [photo.photoId]: 'error' })); }
    finally { requestLocks.current.delete('download'); }
  }

  useEffect(() => { if (kind) dialog.current?.focus(); }, [kind]);
  useEffect(() => {
    if (!kind) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { event.stopPropagation(); close(); return; }
      if (event.key !== 'Tab' || !dialog.current) return;
      const items = [...dialog.current.querySelectorAll<HTMLElement>('button:not(:disabled), [href], [tabindex]:not([tabindex="-1"])')];
      const first = items[0]; const last = items.at(-1);
      if (!first || !last) return;
      if (event.shiftKey && (document.activeElement === first || document.activeElement === dialog.current)) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && (document.activeElement === last || document.activeElement === dialog.current)) { event.preventDefault(); first.focus(); }
    };
    document.addEventListener('keydown', onKeyDown, true);
    return () => document.removeEventListener('keydown', onKeyDown, true);
  }, [kind]);
  useEffect(() => {
    ++viewGeneration.current; kindRef.current = null; selectedNoteId.current = null; selectedAlbumRef.current = null;
    ++notesGeneration.current; ++albumsGeneration.current;
    pendingNotes.current = null; pendingAlbums.current = null; pendingPhotos.current = null; pendingNoteDetail.current = null;
    setKind(null); setSelectedNote(null); setSelectedAlbum(null); setNotes([]); setAlbums([]); setPhotos([]); setNoteCursor(null); setAlbumCursor(null); setPhotoCursor(null);
    setNoteState('idle'); setAlbumState('idle'); setPhotoState('idle'); setNoteError(false); setAlbumError(false); setPhotoError(false);
    return () => {
      cancelRequests();
      ++viewGeneration.current; kindRef.current = null; selectedNoteId.current = null; selectedAlbumRef.current = null;
      ++notesGeneration.current; ++albumsGeneration.current;
      pendingNotes.current = null; pendingAlbums.current = null; pendingPhotos.current = null; pendingNoteDetail.current = null;
    };
  // keyId intentionally captures the selected chat identity rather than object identity.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [requestKey, accountStatus, accountMode]);
  if (!loggedIn) return null;

  const stateLine = (state: ReadState, empty: boolean, failure: boolean, emptyText: string, errorText: string, retry: () => void, more: boolean, loadMore: () => void) => <>
    {state === 'loading' && <p className="chat-resources-state muted" role="status">{copy.loading}</p>}
    {state === 'error' && failure && <div className="chat-resources-state" role="alert"><p>{errorText}</p><button type="button" onClick={retry}>{copy.retry}</button></div>}
    {state === 'ready' && empty && <p className="chat-resources-state muted">{emptyText}</p>}
    {state === 'ready' && more && <button type="button" className="chat-resources-more" onClick={loadMore}>{copy.more}</button>}
  </>;
  return <>
    <div className="chat-resources-actions">
      <button type="button" ref={openButton} aria-haspopup="dialog" aria-expanded={kind === 'notes'} aria-label={copy.openNotes} title={copy.notes} onClick={() => open('notes')}><NotebookPen size={17} aria-hidden="true" /></button>
      <button type="button" ref={albumButton} aria-haspopup="dialog" aria-expanded={kind === 'albums'} aria-label={copy.openAlbums} title={copy.albums} onClick={() => open('albums')}><ImageIcon size={17} aria-hidden="true" /></button>
    </div>
    {kind && <div className="chat-resources-scrim" onMouseDown={(event) => { if (event.target === event.currentTarget) close(); }}>
      <section ref={dialog} className="chat-resources-dialog" role="dialog" aria-modal="true" aria-labelledby="chat-resources-title" tabIndex={-1}>
        <header className="chat-resources-dialog-header"><h2 id="chat-resources-title">{kind === 'notes' ? copy.notes : copy.albums}</h2><div><button type="button" aria-label={copy.refresh} title={copy.refresh} disabled={kind === 'notes' ? noteState === 'loading' : selectedAlbum ? photoState === 'loading' : albumState === 'loading'} onClick={refresh}><RotateCw size={17} aria-hidden="true" /></button><button type="button" aria-label={copy.close} onClick={close}><X size={18} aria-hidden="true" /></button></div></header>
        <div className="chat-resources-body">
          {kind === 'notes' && <>
            {selectedNote ? <div className="chat-resource-detail"><button type="button" className="chat-resource-back" onClick={backFromNote}>{copy.back}</button><h3>{selectedNote.text?.split('\n')[0]?.trim() || copy.untitled}</h3>
              {noteDetailState === 'loading' && <p role="status">{copy.loading}</p>}{noteDetailState === 'error' && <p role="alert">{copy.loadNoteError}</p>}{noteDetailState === 'ready' && <pre>{selectedNote.text ?? ''}</pre>}</div>
              : <><ul className="chat-resource-list">{notes.map((note) => <li key={note.postId}><button type="button" onClick={() => void selectNote(note)} aria-label={note.text?.split('\n')[0]?.trim() || copy.untitled}><strong>{note.text?.split('\n')[0]?.trim() || copy.untitled}</strong>{note.createdTime !== null && <time dateTime={new Date(note.createdTime).toISOString()}>{new Intl.DateTimeFormat(locale, { dateStyle: 'medium' }).format(note.createdTime)}</time>}</button></li>)}</ul>
                {stateLine(noteState, notes.length === 0, noteError, copy.emptyNotes, copy.loadNotesError, () => void loadNotes(false), noteCursor !== null, () => void loadNotes(true))}</>}
          </>}
          {kind === 'albums' && <>
            {selectedAlbum ? <div className="chat-resource-detail"><button type="button" className="chat-resource-back" onClick={backFromAlbum}>{copy.back}</button><h3>{selectedAlbum.title?.trim() || copy.unnamedAlbum}</h3>
              <p className="muted">{photoCountText(locale, copy, selectedAlbum.photoCount)}</p>
              {selectedAlbum && photoState === 'ready' && photos.length === 0 && <p className="chat-resources-state muted">{copy.emptyPhotos}</p>}
              {photoState === 'loading' && <p className="chat-resources-state muted" role="status">{copy.loading}</p>}
              {photoState === 'error' && photoError && <div className="chat-resources-state" role="alert"><p>{copy.loadPhotosError}</p><button type="button" onClick={() => void loadPhotos(selectedAlbum, false)}>{copy.retry}</button></div>}
              <ul className="chat-resource-photos">{photos.map((photo) => { const status = downloadState[photo.photoId]; return <li key={photo.photoId}>
                <PhotoPreview key={status === 'saved' ? 'saved' : 'listed'} route={route} albumId={selectedAlbum.albumId} photoId={photo.photoId} alt={copy.photo} savedLabel={savedPhotoLabel(locale)} testId={`album-photo-preview-${photo.photoId}`} />
                <span>{photo.width && photo.height ? `${photo.width} × ${photo.height}` : copy.photo}</span><button type="button" disabled={status === 'loading' || Object.values(downloadState).includes('loading')} aria-label={copy.download} onClick={() => void download(photo)}><Download size={16} aria-hidden="true" />{status === 'loading' ? copy.loading : copy.download}</button>{status === 'saved' && <span role="status">{copy.saved}</span>}{status === 'error' && <span role="alert">{copy.saveError}</span>}</li>; })}</ul>
              {stateLine(photoState, false, false, copy.emptyPhotos, copy.loadPhotosError, () => void loadPhotos(selectedAlbum, false), photoCursor !== null, () => void loadPhotos(selectedAlbum, true))}</div>
              : <><ul className="chat-resource-list">{albums.map((album) => <li key={album.albumId}><button type="button" className="chat-resource-album" onClick={() => void selectAlbum(album)} aria-label={album.title?.trim() || copy.unnamedAlbum}>
                  <span className="chat-resource-album-cover">{(album.coverPhotoIds ?? []).slice(0, 2).map((photoId) => <PhotoPreview key={photoId} route={route} albumId={album.albumId} photoId={photoId} alt="" savedLabel={savedPhotoLabel(locale)} />)}</span>
                  <span className="chat-resource-album-meta"><strong>{album.title?.trim() || copy.unnamedAlbum}</strong><span>{photoCountText(locale, copy, album.photoCount)}</span></span>
                </button></li>)}</ul>
                {stateLine(albumState, albums.length === 0, albumError, copy.emptyAlbums, copy.loadAlbumsError, () => void loadAlbums(false), albumCursor !== null, () => void loadAlbums(true))}</>}
          </>}
        </div>
      </section>
    </div>}
  </>;
}

function PhotoPreview({ route, albumId, photoId, alt, savedLabel, testId }: { route: ConversationKey; albumId: string; photoId: string; alt: string; savedLabel: string; testId?: string }) {
  const [loaded, setLoaded] = useState(false);
  const src = lineMediaUrl({ type: 'albumPhoto', ...route, albumId, photoId });
  return <span className="chat-resource-photo-preview">
    {src && <img src={src} alt={alt} loading="lazy" decoding="async" referrerPolicy="no-referrer" data-testid={testId}
      onLoad={() => setLoaded(true)} onError={(event) => { setLoaded(false); event.currentTarget.hidden = true; }} />}
    {loaded && <span className="chat-resource-photo-saved" role="img" aria-label={savedLabel}>✓</span>}
  </span>;
}

function photoCountText(locale: Locale, copy: typeof COPY[Locale], count: number | null): string {
  return copy[count === 1 && locale === 'en' ? 'photos' : 'photosPlural'].replace('{n}', count === null ? '—' : new Intl.NumberFormat(locale).format(count));
}
