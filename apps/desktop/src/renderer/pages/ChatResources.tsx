import React, { useEffect, useRef, useState } from 'react';
import { ChevronLeft, ChevronRight, Download, FolderOpen, Image as ImageIcon, NotebookPen, RotateCw, X } from 'lucide-react';
import type { AlbumFailureContextDto, ConversationKey } from '@line-agent/contracts';
import { lineMediaUrl } from '@line-agent/contracts';
import { useDesktopLocale } from '../desktop-i18n.js';
import { desktopErrorText } from '../../desktop-error-copy.js';
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
  openReadableChatAlbumFolder(key: ConversationKey, albumId: string, requestId?: string): Promise<{ exportedCount: number; failedCount: number; totalCount: number; complete: boolean; failureCodes: string[]; opened: boolean }>;
  cancelChatResourceRequest(targetRequestId: string): Promise<boolean>;
};

const COPY = {
  en: { notes: 'Notes', albums: 'Albums', close: 'Close', refresh: 'Refresh', loading: 'Loading…', loadNotesError: 'Unable to load notes.', loadAlbumsError: 'Unable to load albums.', loadPhotosError: 'Unable to load photos.', photoUnavailable: 'Unable to load', loadNoteError: 'Unable to load this note.', emptyNotes: 'No notes in this chat.', emptyAlbums: 'No albums in this chat.', emptyPhotos: 'No photos in this album.', more: 'Load more', retry: 'Retry', saved: 'Image saved', saveError: 'Unable to save this image.', back: 'Back', photos: '{n} photo', photosPlural: '{n} photos', photo: 'LINE photo', download: 'Download photo', previous: 'Previous photo', next: 'Next photo', photoN: 'Photo {n}', untitled: 'Untitled note', unnamedAlbum: 'Untitled album', openNotes: 'Open chat notes', openAlbums: 'Open chat albums', archivingAlbum: 'Saving album photos…', albumArchiveComplete: 'Saved {saved} of {total} photos.', albumArchivePartial: 'Saved {saved} of {total}; {failed} failed.', albumArchiveCancelled: 'Album archive cancelled.', albumArchiveFailed: 'Album archive failed ({code}).', albumArchiveStage: 'Failure stage: {action} / {stage}.', openSavedAlbum: 'Open saved album folder', openingSavedAlbum: 'Preparing folder…', savedAlbumPartial: 'Saved {saved} of {total}; {failed} could not be exported.', savedAlbumOpenFailed: 'Could not open the saved album folder.' },
  'zh-TW': { notes: '記事本', albums: '相簿', close: '關閉', refresh: '重新整理', loading: '載入中…', loadNotesError: '無法載入記事。', loadAlbumsError: '無法載入相簿。', loadNoteError: '無法載入這則記事。', loadPhotosError: '無法載入照片。', photoUnavailable: '無法載入', emptyNotes: '此聊天室沒有記事。', emptyAlbums: '此聊天室沒有相簿。', emptyPhotos: '此相簿沒有照片。', more: '載入更多', retry: '重試', saved: '圖片已儲存', saveError: '無法儲存這張圖片。', back: '返回', photos: '{n} 張照片', photosPlural: '{n} 張照片', photo: 'LINE 照片', download: '下載照片', previous: '上一張照片', next: '下一張照片', photoN: '第 {n} 張照片', untitled: '未命名記事', unnamedAlbum: '未命名相簿', openNotes: '開啟聊天室記事', openAlbums: '開啟聊天室相簿', archivingAlbum: '正在儲存相簿照片…', albumArchiveComplete: '已儲存 {saved}/{total} 張照片。', albumArchivePartial: '已儲存 {saved}/{total} 張；{failed} 張失敗。', albumArchiveCancelled: '已取消相簿封存。', albumArchiveFailed: '相簿封存失敗（{code}）。', albumArchiveStage: '失敗階段：{action} / {stage}。', openSavedAlbum: '開啟已儲存的相簿資料夾', openingSavedAlbum: '正在準備資料夾…', savedAlbumPartial: '已儲存 {saved}/{total} 張；{failed} 張無法匯出。', savedAlbumOpenFailed: '無法開啟已儲存的相簿資料夾。' },
  ja: { notes: 'ノート', albums: 'アルバム', close: '閉じる', refresh: '更新', loading: '読み込み中…', loadNotesError: 'ノートを読み込めません。', loadAlbumsError: 'アルバムを読み込めません。', loadPhotosError: '写真を読み込めません。', photoUnavailable: '読み込めません', loadNoteError: 'このノートを読み込めません。', emptyNotes: 'このチャットにノートはありません。', emptyAlbums: 'このチャットにアルバムはありません。', emptyPhotos: 'このアルバムに写真はありません。', more: 'さらに読み込む', retry: '再試行', saved: '画像を保存しました', saveError: 'この画像を保存できません。', back: '戻る', photos: '写真 {n} 枚', photosPlural: '写真 {n} 枚', photo: 'LINE 写真', download: '写真を保存', previous: '前の写真', next: '次の写真', photoN: '写真 {n}', untitled: '無題のノート', unnamedAlbum: '無題のアルバム', openNotes: 'チャットのノートを開く', openAlbums: 'チャットのアルバムを開く', archivingAlbum: 'アルバムの写真を保存中…', albumArchiveComplete: '{total} 枚中 {saved} 枚を保存しました。', albumArchivePartial: '{total} 枚中 {saved} 枚を保存、{failed} 枚失敗しました。', albumArchiveCancelled: 'アルバム保存をキャンセルしました。', albumArchiveFailed: 'アルバム保存に失敗しました（{code}）。', albumArchiveStage: '失敗段階：{action} / {stage}。', openSavedAlbum: '保存したアルバムフォルダーを開く', openingSavedAlbum: 'フォルダーを準備中…', savedAlbumPartial: '{total} 枚中 {saved} 枚を保存、{failed} 枚を出力できませんでした。', savedAlbumOpenFailed: '保存したアルバムフォルダーを開けません。' },
  ko: { notes: '노트', albums: '앨범', close: '닫기', refresh: '새로고침', loading: '불러오는 중…', loadNotesError: '노트를 불러올 수 없습니다.', loadAlbumsError: '앨범을 불러올 수 없습니다.', loadPhotosError: '사진을 불러올 수 없습니다.', photoUnavailable: '불러올 수 없습니다', loadNoteError: '이 노트를 불러올 수 없습니다.', emptyNotes: '이 대화에 노트가 없습니다.', emptyAlbums: '이 대화에 앨범이 없습니다.', emptyPhotos: '이 앨범에 사진이 없습니다.', more: '더 불러오기', retry: '다시 시도', saved: '이미지를 저장했습니다', saveError: '이 이미지를 저장할 수 없습니다.', back: '뒤로', photos: '사진 {n}장', photosPlural: '사진 {n}장', photo: 'LINE 사진', download: '사진 저장', previous: '이전 사진', next: '다음 사진', photoN: '사진 {n}', untitled: '제목 없는 노트', unnamedAlbum: '제목 없는 앨범', openNotes: '대화 노트 열기', openAlbums: '대화 앨범 열기', archivingAlbum: '앨범 사진 저장 중…', albumArchiveComplete: '사진 {saved}/{total}장 저장 완료.', albumArchivePartial: '{total}장 중 {saved}장 저장, {failed}장 실패.', albumArchiveCancelled: '앨범 저장을 취소했습니다.', albumArchiveFailed: '앨범 저장 실패 ({code}).', albumArchiveStage: '실패 단계: {action} / {stage}.', openSavedAlbum: '저장된 앨범 폴더 열기', openingSavedAlbum: '폴더 준비 중…', savedAlbumPartial: '{total}장 중 {saved}장 저장, {failed}장 내보내지 못했습니다.', savedAlbumOpenFailed: '저장된 앨범 폴더를 열 수 없습니다.' },
} satisfies Record<Locale, Record<string, string>>;
/** The main process sends the IPC error code UNSUPPORTED when the login method has no Notes or Albums. */
/** UNSUPPORTED: the login method has no Notes or Albums. CHAT_RESOURCE_NO_HOME_CHAT: a direct chat that has not received a notebook or album notification yet. */
const isUnsupportedError = (error: unknown): 'UNSUPPORTED' | 'CHAT_RESOURCE_NO_HOME_CHAT' | null =>
  error instanceof Error && (error.name === 'UNSUPPORTED' || error.name === 'CHAT_RESOURCE_NO_HOME_CHAT') ? error.name : null;
type ResourceKind = 'notes' | 'albums';
type ReadState = 'idle' | 'loading' | 'error' | 'ready';
const keyId = (key: ConversationKey) => JSON.stringify([key.accountId, key.chatType, key.chatId]);
const savedPhotoLabel = (locale: Locale) => locale === 'zh-TW' ? '已儲存的照片' : locale === 'ja' ? '保存済みの写真' : locale === 'ko' ? '저장된 사진' : 'Saved photo';

/** Per-chat Note and Album controls. Calls are explicit and one cursor page per action. */
export function ChatResources({ api, route, accountStatus, accountMode }: { api: ChatResourceApi; route: ConversationKey; accountStatus: string; accountMode: string }) {
  const locale = useDesktopLocale();
  const [unsupported, setUnsupported] = useState<'UNSUPPORTED' | 'CHAT_RESOURCE_NO_HOME_CHAT' | null>(null);
  const unsupportedText = desktopErrorText(locale, unsupported ?? 'UNSUPPORTED');
  const copy = unsupported && unsupportedText
    ? { ...COPY[locale], loadNotesError: unsupportedText, loadAlbumsError: unsupportedText, loadPhotosError: unsupportedText, loadNoteError: unsupportedText, saveError: unsupportedText }
    : COPY[locale];
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
  const [readableFolderState, setReadableFolderState] = useState<'idle' | 'loading' | 'saved' | 'partial' | 'error'>('idle');
  const [readableFolderCounts, setReadableFolderCounts] = useState({ saved: 0, failed: 0, total: 0 });
  const dialog = useRef<HTMLDivElement | null>(null);
  const albumButton = useRef<HTMLButtonElement | null>(null);
  const openButton = useRef<HTMLButtonElement | null>(null);
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
  // Photo preload queue of the open album: every listed photo waits in display order, at most 2 run together.
  // A queue item first checks the archive; only a photo that is not saved is downloaded. A visible card moves to the front.
  // A new queue object replaces the old one when the view changes or the dialog closes: the waiting items of the old queue never start.
  type PhotoQueue = { active: number; waiting: ChatAlbumPhoto[]; known: Set<string>; albumId: string | null };
  const newPhotoQueue = (): PhotoQueue => ({ active: 0, waiting: [], known: new Set(), albumId: null });
  const photoQueue = useRef<PhotoQueue>(newPhotoQueue());
  const [photoLoad, setPhotoLoad] = useState<Record<string, 'queued' | 'loading' | 'ready' | 'failed'>>({});
  // Album cover fill: one album at a time, one photo at a time, in list order. One list read per album and one attempt per photo for each dialog open.
  // A new cover work object replaces the old one when the dialog opens again or the list is refreshed.
  const albumsRef = useRef<ChatAlbum[]>([]);
  albumsRef.current = albums;
  const coverRun = useRef(0);
  const coverWork = useRef({ listed: new Map<string, ChatAlbumPhoto[] | 'failed'>(), tried: new Set<string>() });
  const [coverFailed, setCoverFailed] = useState<Record<string, number>>({});
  const resetCoverWork = () => { coverWork.current = { listed: new Map(), tried: new Set() }; setCoverFailed({}); };
  const albumIdsKey = albums.map((album) => album.albumId).join('\n');
  // Single view of one photo inside the album dialog. The grid stays mounted but hidden, so its queue and scroll position stay.
  const [viewPhotoId, setViewPhotoId] = useState<string | null>(null);
  const bodyNode = useRef<HTMLDivElement | null>(null);
  const savedScroll = useRef<number | null>(null);
  const photoNav = useRef<{ id: string | null; ids: string[]; show: (id: string | null) => void }>({ id: null, ids: [], show: () => undefined });
  const showPhoto = (id: string | null) => {
    if (id !== null && viewPhotoId === null) savedScroll.current = bodyNode.current?.scrollTop ?? null;
    setViewPhotoId(id);
  };
  photoNav.current = { id: viewPhotoId, ids: photos.map((photo) => photo.photoId), show: showPhoto };
  const viewIndex = viewPhotoId === null ? -1 : photos.findIndex((photo) => photo.photoId === viewPhotoId);
  const viewPhoto = viewIndex >= 0 ? photos[viewIndex] : undefined;
  useEffect(() => {
    if (viewPhotoId !== null || savedScroll.current === null) return;
    if (bodyNode.current) bodyNode.current.scrollTop = savedScroll.current;
    savedScroll.current = null;
  }, [viewPhotoId]);
  const resetPhotoQueue = () => { photoQueue.current = newPhotoQueue(); setPhotoLoad({}); setViewPhotoId(null); savedScroll.current = null; };
  const cancelRequests = () => {
    resetPhotoQueue();
    for (const requestId of activeRequests.current) void api.cancelChatResourceRequest(requestId).catch(() => false);
    activeRequests.current.clear();
  };
  const probeSavedPhoto = (albumId: string, photoId: string): Promise<boolean> => new Promise((resolve) => {
    const src = lineMediaUrl({ type: 'albumPhoto', ...route, albumId, photoId });
    if (!src) { resolve(false); return; }
    const image = new Image();
    image.onload = () => resolve(true);
    image.onerror = () => resolve(false);
    image.src = src;
  });
  const runQueuedPhoto = async (queue: PhotoQueue, albumId: string, photo: ChatAlbumPhoto) => {
    const mark = (value: 'loading' | 'ready' | 'failed') => { if (queue === photoQueue.current) setPhotoLoad((current) => ({ ...current, [photo.photoId]: value })); };
    mark('loading');
    try {
      if (!await probeSavedPhoto(albumId, photo.photoId)) {
        await withRequestId((requestId) => api.downloadChatAlbumPhoto(route, albumId, photo.photoId, photo.oid, photo.prefix, requestId));
        if (queue !== photoQueue.current) return;
        if (!await probeSavedPhoto(albumId, photo.photoId)) { mark('failed'); return; }
      }
      mark('ready');
    } catch { mark('failed'); }
  };
  const pumpPhotoQueue = (queue: PhotoQueue) => {
    while (queue === photoQueue.current && queue.albumId && queue.active < 2 && queue.waiting.length > 0) {
      const photo = queue.waiting.shift()!;
      queue.active += 1;
      void runQueuedPhoto(queue, queue.albumId, photo).finally(() => { queue.active -= 1; pumpPhotoQueue(queue); });
    }
  };
  const prioritizePhoto = (photoId: string) => {
    const queue = photoQueue.current;
    const index = queue.waiting.findIndex((photo) => photo.photoId === photoId);
    if (index > 0) queue.waiting.unshift(...queue.waiting.splice(index, 1));
  };
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
      resetCoverWork();
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
    else if (selectedAlbum) { resetPhotoQueue(); setPhotos([]); setPhotoCursor(null); void loadPhotos(selectedAlbum, false, generation, true); }
    else if (kind === 'albums') { const listGeneration = ++albumsGeneration.current; resetCoverWork(); setAlbums([]); setAlbumCursor(null); void loadAlbums(false, listGeneration, true); }
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
    } catch (error) { setUnsupported(isUnsupportedError(error)); if (generation === notesGeneration.current && kindRef.current === 'notes') { setNoteError(true); setNoteState('error'); } }
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
    } catch (error) { setUnsupported(isUnsupportedError(error)); if (generation === albumsGeneration.current && kindRef.current === 'albums') { setAlbumError(true); setAlbumState('error'); } }
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
    } catch (error) { setUnsupported(isUnsupportedError(error)); if (generation === viewGeneration.current && kindRef.current === 'albums' && selectedAlbumRef.current?.albumId === album.albumId) { setPhotoError(true); setPhotoState('error'); } }
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
    } catch (error) { setUnsupported(isUnsupportedError(error)); if (generation === viewGeneration.current && kindRef.current === 'notes' && selectedNoteId.current === note.postId) setNoteDetailState('error'); }
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
    setSelectedAlbum(album); setPhotos([]); setPhotoCursor(null); setPhotoState('idle'); setDownloadState({}); setReadableFolderState('idle');
    void loadPhotos(album, false, generation);
  }
  function backFromNote() {
    ++viewGeneration.current; selectedNoteId.current = null; pendingNoteDetail.current = null;
    setSelectedNote(null); setNoteDetailState('idle');
  }
  function backFromAlbum() {
    cancelRequests();
    ++viewGeneration.current; selectedAlbumRef.current = null; pendingPhotos.current = null;
    setSelectedAlbum(null); setPhotos([]); setPhotoCursor(null); setPhotoState('idle'); setReadableFolderState('idle');
  }
  async function download(photo: ChatAlbumPhoto) {
    if (!selectedAlbum || requestLocks.current.has('download')) return;
    requestLocks.current.add('download');
    setDownloadState((current) => ({ ...current, [photo.photoId]: 'loading' }));
    try {
      await withRequestId((requestId) => api.downloadChatAlbumPhoto(route, selectedAlbum.albumId, photo.photoId, photo.oid, photo.prefix, requestId));
      setDownloadState((current) => ({ ...current, [photo.photoId]: 'saved' }));
      setPhotoLoad((current) => ({ ...current, [photo.photoId]: 'ready' }));
      setAlbums((current) => current.map((album) => album.albumId === selectedAlbum.albumId
        ? { ...album, coverPhotoIds: [photo.photoId, ...(album.coverPhotoIds ?? []).filter((id) => id !== photo.photoId)].slice(0, 3) } : album));
    } catch (error) { setUnsupported(isUnsupportedError(error)); setDownloadState((current) => ({ ...current, [photo.photoId]: 'error' })); }
    finally { requestLocks.current.delete('download'); }
  }
  async function openReadableAlbumFolder() {
    if (!selectedAlbum || requestLocks.current.has('readable-folder')) return;
    requestLocks.current.add('readable-folder'); setReadableFolderState('loading');
    try {
      const result = await withRequestId((requestId) => api.openReadableChatAlbumFolder(route, selectedAlbum.albumId, requestId));
      setReadableFolderCounts({ saved: result.exportedCount, failed: result.failedCount, total: result.totalCount });
      setReadableFolderState(!result.opened ? 'error' : result.complete ? 'saved' : 'partial');
    } catch { setReadableFolderState('error'); }
    finally { requestLocks.current.delete('readable-folder'); }
  }

  useEffect(() => { if (kind) dialog.current?.focus(); }, [kind]);
  // Each loaded photo page goes into the preload queue in display order.
  useEffect(() => {
    const queue = photoQueue.current;
    if (!selectedAlbum || kind !== 'albums') return;
    queue.albumId = selectedAlbum.albumId;
    const added = photos.filter((photo) => !queue.known.has(photo.photoId));
    if (added.length === 0) return;
    for (const photo of added) queue.known.add(photo.photoId);
    queue.waiting.push(...added);
    setPhotoLoad((current) => { const next = { ...current }; for (const photo of added) next[photo.photoId] ??= 'queued'; return next; });
    pumpPhotoQueue(queue);
  }, [photos, selectedAlbum, kind]);
  // Fill the first 3 cover photos of each listed album. Stops when the dialog closes, an album opens, or the album list changes.
  useEffect(() => {
    if (kind !== 'albums' || selectedAlbum !== null || albumIdsKey === '') return undefined;
    const token = ++coverRun.current;
    const live = () => token === coverRun.current && kindRef.current === 'albums';
    const work = coverWork.current;
    const coverIds = (albumId: string) => albumsRef.current.find((album) => album.albumId === albumId)?.coverPhotoIds ?? [];
    void (async () => {
      for (const albumId of albumIdsKey.split('\n')) {
        if (!live()) return;
        const album = albumsRef.current.find((item) => item.albumId === albumId);
        const target = Math.min(3, album?.photoCount ?? 0);
        if (!album || coverIds(albumId).length >= target) continue;
        let page = work.listed.get(albumId);
        if (page === undefined) {
          try {
            page = (await withRequestId((requestId) => api.listChatAlbumPhotos(route, albumId, null, requestId))).photos;
            work.listed.set(albumId, page);
          } catch {
            if (!live()) return;
            work.listed.set(albumId, 'failed');
            page = 'failed';
          }
          if (!live()) return;
        }
        if (page === 'failed') {
          setCoverFailed((current) => current[albumId] === undefined ? { ...current, [albumId]: target - coverIds(albumId).length } : current);
          continue;
        }
        const first = page.slice(0, 3);
        for (const photo of first) {
          if (!live()) return;
          if (coverIds(albumId).length >= target || coverIds(albumId).includes(photo.photoId)) continue;
          const triedKey = `${albumId}\n${photo.photoId}`;
          if (work.tried.has(triedKey)) continue;
          work.tried.add(triedKey);
          let saved = false;
          try {
            if (!await probeSavedPhoto(albumId, photo.photoId)) {
              await withRequestId((requestId) => api.downloadChatAlbumPhoto(route, albumId, photo.photoId, photo.oid, photo.prefix, requestId));
              saved = live() && await probeSavedPhoto(albumId, photo.photoId);
            } else saved = true;
          } catch { saved = false; }
          if (!live()) { work.tried.delete(triedKey); return; }
          if (!saved) { setCoverFailed((current) => ({ ...current, [albumId]: (current[albumId] ?? 0) + 1 })); continue; }
          const have = new Set([...coverIds(albumId), photo.photoId]);
          const ordered = [...first.map((item) => item.photoId).filter((id) => have.has(id)), ...coverIds(albumId).filter((id) => !first.some((item) => item.photoId === id))].slice(0, 3);
          setAlbums((current) => current.map((item) => item.albumId === albumId ? { ...item, coverPhotoIds: ordered } : item));
          albumsRef.current = albumsRef.current.map((item) => item.albumId === albumId ? { ...item, coverPhotoIds: ordered } : item);
        }
      }
    })();
    return () => { if (coverRun.current === token) ++coverRun.current; };
  // The cover run depends on the album ids, not on the cover ids that it changes.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [kind, selectedAlbum === null, albumIdsKey]);
  useEffect(() => {
    if (!kind) return;
    const onKeyDown = (event: KeyboardEvent) => {
      const nav = photoNav.current;
      if (event.key === 'Escape') { event.stopPropagation(); if (nav.id !== null) nav.show(null); else close(); return; }
      if (nav.id !== null && (event.key === 'ArrowLeft' || event.key === 'ArrowRight')) {
        event.preventDefault(); event.stopPropagation();
        const target = nav.ids[nav.ids.indexOf(nav.id) + (event.key === 'ArrowLeft' ? -1 : 1)];
        if (target !== undefined) nav.show(target);
        return;
      }
      if (event.key !== 'Tab' || !dialog.current) return;
      const items = [...dialog.current.querySelectorAll<HTMLElement>('button:not(:disabled), [href], [tabindex]:not([tabindex="-1"])')].filter((item) => !item.closest('[hidden]'));
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
    resetCoverWork();
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
    {kind !== null && <div className="chat-resources-scrim" onMouseDown={(event) => { if (event.target === event.currentTarget) close(); }}>
      <section ref={dialog} className="chat-resources-dialog" role="dialog" aria-modal="true" aria-labelledby="chat-resources-title" tabIndex={-1}>
        <header className="chat-resources-dialog-header"><h2 id="chat-resources-title">{kind === 'notes' ? copy.notes : copy.albums}</h2><div><button type="button" aria-label={copy.refresh} title={copy.refresh} disabled={kind === 'notes' ? noteState === 'loading' : selectedAlbum ? photoState === 'loading' : albumState === 'loading'} onClick={refresh}><RotateCw size={17} aria-hidden="true" /></button><button type="button" aria-label={copy.close} onClick={close}><X size={18} aria-hidden="true" /></button></div></header>
        <div className="chat-resources-body" ref={bodyNode}>
          {kind === 'notes' && <>
            {selectedNote ? <div className="chat-resource-detail"><button type="button" className="chat-resource-back" onClick={backFromNote}>{copy.back}</button><h3>{selectedNote.text?.split('\n')[0]?.trim() || copy.untitled}</h3>
              {noteDetailState === 'loading' && <p role="status">{copy.loading}</p>}{noteDetailState === 'error' && <p role="alert">{copy.loadNoteError}</p>}{noteDetailState === 'ready' && <pre>{selectedNote.text ?? ''}</pre>}</div>
              : <><ul className="chat-resource-list">{notes.map((note) => <li key={note.postId}><button type="button" onClick={() => void selectNote(note)} aria-label={note.text?.split('\n')[0]?.trim() || copy.untitled}><strong>{note.text?.split('\n')[0]?.trim() || copy.untitled}</strong>{note.createdTime !== null && <time dateTime={new Date(note.createdTime).toISOString()}>{new Intl.DateTimeFormat(locale, { dateStyle: 'medium' }).format(note.createdTime)}</time>}</button></li>)}</ul>
                {stateLine(noteState, notes.length === 0, noteError, copy.emptyNotes, copy.loadNotesError, () => void loadNotes(false), noteCursor !== null, () => void loadNotes(true))}</>}
          </>}
          {kind === 'albums' && <>
            {selectedAlbum ? <><div className="chat-resource-detail" hidden={viewPhoto !== undefined}><button type="button" className="chat-resource-back" onClick={backFromAlbum}>{copy.back}</button><h3>{selectedAlbum.title?.trim() || copy.unnamedAlbum}</h3>
              <button type="button" disabled={readableFolderState === 'loading'} onClick={() => void openReadableAlbumFolder()}><FolderOpen size={16} aria-hidden="true" />{readableFolderState === 'loading' ? copy.openingSavedAlbum : copy.openSavedAlbum}</button>
              {readableFolderState === 'partial' && <p role="status">{copy.savedAlbumPartial.replace('{saved}', String(readableFolderCounts.saved)).replace('{total}', String(readableFolderCounts.total)).replace('{failed}', String(readableFolderCounts.failed))}</p>}
              {readableFolderState === 'error' && <p role="alert">{copy.savedAlbumOpenFailed}</p>}
              <p className="muted">{photoCountText(locale, copy, selectedAlbum.photoCount)}</p>
              {selectedAlbum && photoState === 'ready' && photos.length === 0 && <p className="chat-resources-state muted">{copy.emptyPhotos}</p>}
              {photoState === 'loading' && <p className="chat-resources-state muted" role="status">{copy.loading}</p>}
              {photoState === 'error' && photoError && <div className="chat-resources-state" role="alert"><p>{copy.loadPhotosError}</p><button type="button" onClick={() => void loadPhotos(selectedAlbum, false)}>{copy.retry}</button></div>}
              <ul className="chat-resource-photos">{photos.map((photo, photoIndex) => <li key={photo.photoId}><button type="button" className="chat-resource-photo-cell" aria-label={copy.photoN.replace('{n}', String(photoIndex + 1))} onClick={() => showPhoto(photo.photoId)}>
                <PhotoPreview key={downloadState[photo.photoId] === 'saved' ? 'saved' : 'listed'} route={route} albumId={selectedAlbum.albumId} photoId={photo.photoId} alt={copy.photo} savedLabel={savedPhotoLabel(locale)} testId={`album-photo-preview-${photo.photoId}`}
                  photoLoad={{ state: photoLoad[photo.photoId] ?? 'queued', onVisible: () => prioritizePhoto(photo.photoId), loadingText: copy.loading, failedText: copy.photoUnavailable }} />
              </button></li>)}</ul>
              {stateLine(photoState, false, false, copy.emptyPhotos, copy.loadPhotosError, () => void loadPhotos(selectedAlbum, false), photoCursor !== null, () => void loadPhotos(selectedAlbum, true))}</div>
              {viewPhoto && (() => { const status = downloadState[viewPhoto.photoId]; return <div className="chat-resource-photo-single">
                <div className="chat-resource-photo-single-bar"><button type="button" className="chat-resource-back" onClick={() => showPhoto(null)}>{copy.back}</button>
                  <span>{viewIndex + 1} / {photos.length}</span>
                  <button type="button" aria-label={copy.previous} disabled={viewIndex <= 0} onClick={() => showPhoto(photos[viewIndex - 1]!.photoId)}><ChevronLeft size={17} aria-hidden="true" /></button>
                  <button type="button" aria-label={copy.next} disabled={viewIndex >= photos.length - 1} onClick={() => showPhoto(photos[viewIndex + 1]!.photoId)}><ChevronRight size={17} aria-hidden="true" /></button></div>
                <PhotoPreview key={`${viewPhoto.photoId}:${status === 'saved' ? 'saved' : 'listed'}`} route={route} albumId={selectedAlbum.albumId} photoId={viewPhoto.photoId} alt={copy.photo} savedLabel={savedPhotoLabel(locale)} testId={`album-photo-view-${viewPhoto.photoId}`}
                  photoLoad={{ state: photoLoad[viewPhoto.photoId] ?? 'queued', onVisible: () => prioritizePhoto(viewPhoto.photoId), loadingText: copy.loading, failedText: copy.photoUnavailable }} />
                <span>{viewPhoto.width && viewPhoto.height ? `${viewPhoto.width} × ${viewPhoto.height}` : copy.photo}</span>
                <button type="button" disabled={status === 'loading' || Object.values(downloadState).includes('loading')} aria-label={copy.download} onClick={() => void download(viewPhoto)}><Download size={16} aria-hidden="true" />{status === 'loading' ? copy.loading : copy.download}</button>
                {status === 'saved' && <span role="status">{copy.saved}</span>}{status === 'error' && <span role="alert">{copy.saveError}</span>}</div>; })()}</>
              : <><ul className="chat-resource-list">{albums.map((album) => <li key={album.albumId}><button type="button" className="chat-resource-album" onClick={() => void selectAlbum(album)} aria-label={album.title?.trim() || copy.unnamedAlbum}>
                  <span className="chat-resource-album-cover">{[0, 1, 2].map((cell) => {
                    const photoId = (album.coverPhotoIds ?? [])[cell];
                    if (photoId !== undefined) return <PhotoPreview key={photoId} route={route} albumId={album.albumId} photoId={photoId} alt="" savedLabel={savedPhotoLabel(locale)} />;
                    const failedCell = cell < (album.coverPhotoIds ?? []).length + (coverFailed[album.albumId] ?? 0);
                    return <span key={`empty-${cell}`} className="chat-resource-photo-preview">{failedCell && <span className="chat-resource-photo-note" role="alert">{copy.photoUnavailable}</span>}</span>;
                  })}</span>
                  <span className="chat-resource-album-meta"><strong>{album.title?.trim() || copy.unnamedAlbum}</strong><span>{photoCountText(locale, copy, album.photoCount)}</span></span>
                </button></li>)}</ul>
                {stateLine(albumState, albums.length === 0, albumError, copy.emptyAlbums, copy.loadAlbumsError, () => void loadAlbums(false), albumCursor !== null, () => void loadAlbums(true))}</>}
          </>}
        </div>
      </section>
    </div>}
  </>;
}

/**
 * Preview of one album photo from the local archive.
 * Without `photoLoad` (album covers) a photo that is not saved stays hidden.
 * With `photoLoad` (photo list) the dialog queue checks the archive and downloads a photo that is not saved.
 * The image element exists only when the queue state is `ready`, so no broken image is shown.
 * A visible card calls `onVisible` once: the queue moves that photo to the front.
 */
function PhotoPreview({ route, albumId, photoId, alt, savedLabel, testId, photoLoad }: { route: ConversationKey; albumId: string; photoId: string; alt: string; savedLabel: string; testId?: string;
  photoLoad?: { state: 'queued' | 'loading' | 'ready' | 'failed'; onVisible: () => void; loadingText: string; failedText: string } }) {
  const [loaded, setLoaded] = useState(false);
  const [broken, setBroken] = useState(false);
  const node = useRef<HTMLSpanElement | null>(null);
  const onVisible = useRef(photoLoad?.onVisible);
  onVisible.current = photoLoad?.onVisible;
  const waiting = photoLoad !== undefined && photoLoad.state === 'queued';
  useEffect(() => {
    const target = node.current;
    if (!waiting || !target || typeof IntersectionObserver === 'undefined') return undefined;
    const observer = new IntersectionObserver((entries) => { if (entries.some((entry) => entry.isIntersecting)) { onVisible.current?.(); observer.disconnect(); } });
    observer.observe(target);
    return () => observer.disconnect();
  }, [waiting]);
  const src = lineMediaUrl({ type: 'albumPhoto', ...route, albumId, photoId });
  const showImage = !!src && !broken && (!photoLoad || photoLoad.state === 'ready');
  const failed = photoLoad !== undefined && (photoLoad.state === 'failed' || broken);
  const pending = photoLoad !== undefined && (photoLoad.state === 'queued' || photoLoad.state === 'loading');
  return <span className="chat-resource-photo-preview" ref={node}>
    {showImage && <img src={src} alt={alt} loading={photoLoad ? undefined : 'lazy'} decoding="async" referrerPolicy="no-referrer" data-testid={testId}
      onLoad={() => setLoaded(true)} onError={(event) => { setLoaded(false); if (photoLoad) setBroken(true); else event.currentTarget.hidden = true; }} />}
    {pending && <span className="chat-resource-photo-note" role="status">{photoLoad.loadingText}</span>}
    {failed && <span className="chat-resource-photo-note" role="alert">{photoLoad.failedText}</span>}
    {loaded && <span className="chat-resource-photo-saved" role="img" aria-label={savedLabel}>✓</span>}
  </span>;
}

function photoCountText(locale: Locale, copy: typeof COPY[Locale], count: number | null): string {
  return copy[count === 1 && locale === 'en' ? 'photos' : 'photosPlural'].replace('{n}', count === null ? '—' : new Intl.NumberFormat(locale).format(count));
}
