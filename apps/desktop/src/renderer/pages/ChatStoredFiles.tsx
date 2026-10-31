import React, { useLayoutEffect, useRef, useState } from 'react';
import { Folder, X } from 'lucide-react';
import type { ConversationKey, StoredAttachmentItem } from '@line-agent/contracts';
import type { DesktopApi } from '../../preload/api.js';
import { useDesktopLocale } from '../desktop-i18n.js';

const PAGE_SIZE = 50;
const COPY = {
  en: { button: 'Open saved files', title: 'Saved files', close: 'Close', name: 'Name', type: 'Type', size: 'Size', date: 'Message date', speaker: 'Speaker', open: 'Open {name}', loading: 'Loading…', empty: 'No saved files in this chat.', error: 'Unable to load saved files.', openError: 'Unable to open this file.', more: 'Load more', retry: 'Retry' },
  'zh-TW': { button: '開啟已儲存檔案', title: '已儲存檔案', close: '關閉', name: '檔名', type: '類型', size: '大小', date: '訊息日期', speaker: '發言人', open: '開啟 {name}', loading: '載入中…', empty: '此聊天室沒有已儲存的檔案。', error: '無法載入已儲存檔案。', openError: '無法開啟此檔案。', more: '載入更多', retry: '重試' },
  ja: { button: '保存済みファイルを開く', title: '保存済みファイル', close: '閉じる', name: '名前', type: '種類', size: 'サイズ', date: 'メッセージ日時', speaker: '送信者', open: '{name} を開く', loading: '読み込み中…', empty: 'このチャットに保存済みファイルはありません。', error: '保存済みファイルを読み込めません。', openError: 'このファイルを開けません。', more: 'さらに読み込む', retry: '再試行' },
  ko: { button: '저장된 파일 열기', title: '저장된 파일', close: '닫기', name: '이름', type: '유형', size: '크기', date: '메시지 날짜', speaker: '보낸 사람', open: '{name} 열기', loading: '불러오는 중…', empty: '이 채팅에 저장된 파일이 없습니다.', error: '저장된 파일을 불러올 수 없습니다.', openError: '이 파일을 열 수 없습니다.', more: '더 불러오기', retry: '다시 시도' },
} as const;
type LoadState = 'idle' | 'loading' | 'ready' | 'error';
const routeId = (key: ConversationKey) => JSON.stringify([key.accountId, key.chatType, key.chatId]);

function fileSize(bytes: number | null, locale: string): string {
  if (bytes === null) return '—';
  if (bytes < 1024) return `${new Intl.NumberFormat(locale).format(bytes)} B`;
  const unit = bytes < 1024 ** 2 ? 'KB' : bytes < 1024 ** 3 ? 'MB' : 'GB';
  const divisor = unit === 'KB' ? 1024 : unit === 'MB' ? 1024 ** 2 : 1024 ** 3;
  return `${new Intl.NumberFormat(locale, { maximumFractionDigits: 1 }).format(bytes / divisor)} ${unit}`;
}

export function ChatStoredFiles({ api, route }: { api: DesktopApi; route: ConversationKey }) {
  const locale = useDesktopLocale();
  const copy = COPY[locale];
  const currentRouteId = routeId(route);
  const currentRouteIdRef = useRef(currentRouteId);
  currentRouteIdRef.current = currentRouteId;
  const generation = useRef(0);
  const openRef = useRef(false);
  const trigger = useRef<HTMLButtonElement>(null);
  const dialog = useRef<HTMLElement>(null);
  const [isOpen, setIsOpen] = useState(false);
  const [items, setItems] = useState<StoredAttachmentItem[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [state, setState] = useState<LoadState>('idle');
  const [loadingMore, setLoadingMore] = useState(false);
  const [openFailure, setOpenFailure] = useState(false);
  const [retryCursor, setRetryCursor] = useState<string | null>(null);

  useLayoutEffect(() => {
    ++generation.current;
    openRef.current = false;
    setIsOpen(false);
    setItems([]); setCursor(null); setState('idle'); setLoadingMore(false); setOpenFailure(false); setRetryCursor(null);
    return () => { ++generation.current; openRef.current = false; };
  }, [currentRouteId]);

  useLayoutEffect(() => { if (isOpen) dialog.current?.focus(); }, [isOpen]);

  useLayoutEffect(() => {
    if (!isOpen) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { event.stopPropagation(); close(); return; }
      if (event.key !== 'Tab' || !dialog.current) return;
      const focusable = [...dialog.current.querySelectorAll<HTMLElement>('button:not(:disabled), [href], [tabindex]:not([tabindex="-1"])')];
      const first = focusable[0]; const last = focusable.at(-1);
      if (!first || !last) return;
      if (event.shiftKey && (document.activeElement === first || document.activeElement === dialog.current)) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && (document.activeElement === last || document.activeElement === dialog.current)) { event.preventDefault(); first.focus(); }
    };
    document.addEventListener('keydown', onKeyDown, true);
    return () => document.removeEventListener('keydown', onKeyDown, true);
  }, [isOpen]);

  async function load(pageCursor: string | null, requestGeneration = generation.current) {
    setState('loading'); setLoadingMore(pageCursor !== null);
    try {
      const page = await api.listStoredAttachments(route, pageCursor, PAGE_SIZE);
      if (requestGeneration !== generation.current || !openRef.current || currentRouteId !== currentRouteIdRef.current) return;
      setItems((current) => {
        const merged = pageCursor === null ? page.attachments : [...current, ...page.attachments];
        return [...new Map(merged.map((item) => [item.attachmentId, item])).values()];
      });
      setCursor(page.nextCursor);
      setRetryCursor(null);
      setState('ready');
    } catch {
      if (requestGeneration === generation.current && openRef.current && currentRouteId === currentRouteIdRef.current) { setRetryCursor(pageCursor); setState('error'); }
    } finally {
      if (requestGeneration === generation.current) setLoadingMore(false);
    }
  }

  function open() {
    const requestGeneration = ++generation.current;
    openRef.current = true;
    setIsOpen(true); setItems([]); setCursor(null); setOpenFailure(false); setRetryCursor(null);
    void load(null, requestGeneration);
  }

  function close() {
    openRef.current = false;
    ++generation.current;
    setIsOpen(false); setState('idle'); setItems([]); setCursor(null); setLoadingMore(false); setOpenFailure(false); setRetryCursor(null);
    trigger.current?.focus();
  }

  async function openFile(attachmentId: string) {
    const requestGeneration = generation.current;
    const requestRouteId = currentRouteId;
    try {
      if (!await api.openAttachment(attachmentId)) throw new Error('open failed');
      if (requestGeneration === generation.current && openRef.current && requestRouteId === currentRouteIdRef.current) setOpenFailure(false);
    } catch {
      if (requestGeneration === generation.current && openRef.current && requestRouteId === currentRouteIdRef.current) setOpenFailure(true);
    }
  }

  return <>
    <div className="chat-resources-actions">
      <button ref={trigger} type="button" aria-haspopup="dialog" aria-expanded={isOpen} aria-label={copy.button} title={copy.button} onClick={open}><Folder size={17} aria-hidden="true" /></button>
    </div>
    {isOpen && <div className="chat-resources-scrim" onMouseDown={(event) => { if (event.target === event.currentTarget) close(); }}>
      <section ref={dialog} className="chat-resources-dialog" role="dialog" aria-modal="true" aria-labelledby="saved-files-title" tabIndex={-1}>
        <header className="chat-resources-dialog-header"><h2 id="saved-files-title">{copy.title}</h2><button type="button" aria-label={copy.close} onClick={close}><X size={18} aria-hidden="true" /></button></header>
        <div className="chat-resources-body">
          {state === 'loading' && <p className="chat-resources-state muted" role="status">{copy.loading}</p>}
          {state === 'error' && <div className="chat-resources-state" role="alert"><p>{copy.error}</p><button type="button" onClick={() => void load(retryCursor)}>{copy.retry}</button></div>}
          {state === 'ready' && items.length === 0 && <p className="chat-resources-state muted">{copy.empty}</p>}
          {items.length > 0 && <div className="stored-files-table-wrap"><table className="stored-files-table"><thead><tr><th scope="col">{copy.name}</th><th scope="col">{copy.type}</th><th scope="col">{copy.size}</th><th scope="col">{copy.date}</th>{route.chatType !== 'direct' && <th scope="col">{copy.speaker}</th>}<th scope="col" /></tr></thead>
            <tbody>{items.map((item) => <tr key={item.attachmentId}><td>{item.name}</td><td>{item.mimeType || item.kind}</td><td>{fileSize(item.sizeBytes, locale)}</td><td>{new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(item.occurredAt))}</td>{route.chatType !== 'direct' && <td>{item.senderDisplayName}</td>}<td><button type="button" aria-label={copy.open.replace('{name}', item.name)} onClick={() => void openFile(item.attachmentId)}>{copy.open.replace('{name}', item.name)}</button></td></tr>)}</tbody>
          </table></div>}
          {openFailure && <p role="alert">{copy.openError}</p>}
          {state === 'ready' && cursor !== null && <button type="button" className="chat-resources-more" disabled={loadingMore} onClick={() => void load(cursor)}>{loadingMore ? copy.loading : copy.more}</button>}
        </div>
      </section>
    </div>}
  </>;
}
