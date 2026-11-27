import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { X } from 'lucide-react';
import type { ChatExtraFolderResult, ChatExtraFolderStatus, ConversationKey, WritableConversationKey } from '@line-agent/contracts';
import type { DesktopApi } from '../../preload/api.js';
import { useDesktopLocale } from '../desktop-i18n.js';

const REFRESH_MS = 5_000;
const COPY = {
  en: { button: 'Download location', title: 'Download location', close: 'Close', fixed: 'Fixed location', open: 'Open', extra: 'Extra storage location',
    none: 'Not set. Attachments are stored only in the fixed location.', choose: 'Choose folder', change: 'Change', disable: 'Disable', retryFailed: 'Retry failed',
    progress: 'Copied {done} · Waiting {waiting} · Failed {failed}', confirmOff: 'After you disable it, new attachments are not copied. Files already copied are kept.',
    confirm: 'Confirm', cancel: 'Cancel', setDone: 'Folder set. History attachments are being copied in the background.', offDone: 'Extra storage location disabled.',
    retryDone: '{count} failed attachments are queued again.', retryNone: 'No failed attachments.', openError: 'Unable to open the folder.', loadError: 'Unable to load the setting.',
    NOT_ABSOLUTE: 'Use a local folder with a full path.', NOT_DIRECTORY: 'The folder does not exist.', REPARSE_POINT: 'A folder link or junction cannot be used.',
    PROTECTED_FOLDER: 'Cannot use a system folder or the main attachment folder.', OTHER_CHAT_FOLDER: 'Cannot use the work folder of another chat.', FAILED: 'Unable to save the setting. Check the folder and try again.' },
  'zh-TW': { button: '下載位置', title: '下載位置', close: '關閉', fixed: '固定位置', open: '開啟', extra: '額外儲存位置',
    none: '未設定。附件只存在固定位置。', choose: '選擇資料夾', change: '更換', disable: '停用', retryFailed: '重試失敗',
    progress: '已複製 {done}・等待 {waiting}・失敗 {failed}', confirmOff: '停用後不再複製新附件，已複製的檔案會保留。',
    confirm: '確認', cancel: '取消', setDone: '已設定，歷史附件正在背景複製。', offDone: '已停用額外儲存位置。',
    retryDone: '已重新排入 {count} 個失敗附件。', retryNone: '目前沒有失敗的附件。', openError: '無法開啟資料夾。', loadError: '無法載入設定。',
    NOT_ABSOLUTE: '請使用完整路徑的本機資料夾。', NOT_DIRECTORY: '資料夾不存在', REPARSE_POINT: '不能使用資料夾連結或接合點。',
    PROTECTED_FOLDER: '不能使用系統資料夾或附件主資料夾', OTHER_CHAT_FOLDER: '不能使用其他聊天室的工作資料夾', FAILED: '設定失敗，請檢查資料夾後重試。' },
  ja: { button: 'ダウンロード先', title: 'ダウンロード先', close: '閉じる', fixed: '固定の保存先', open: '開く', extra: '追加の保存先',
    none: '未設定です。添付ファイルは固定の保存先にだけ保存されます。', choose: 'フォルダーを選択', change: '変更', disable: '無効にする', retryFailed: '失敗を再試行',
    progress: 'コピー済み {done}・待機 {waiting}・失敗 {failed}', confirmOff: '無効にすると新しい添付ファイルはコピーされません。コピー済みのファイルは残ります。',
    confirm: '確認', cancel: 'キャンセル', setDone: '設定しました。過去の添付ファイルをバックグラウンドでコピーしています。', offDone: '追加の保存先を無効にしました。',
    retryDone: '失敗した添付ファイル {count} 件を再度キューに入れました。', retryNone: '失敗した添付ファイルはありません。', openError: 'フォルダーを開けません。', loadError: '設定を読み込めません。',
    NOT_ABSOLUTE: 'フルパスのローカルフォルダーを使用してください。', NOT_DIRECTORY: 'フォルダーが存在しません。', REPARSE_POINT: 'フォルダーのリンクやジャンクションは使用できません。',
    PROTECTED_FOLDER: 'システムフォルダーまたは添付ファイルのメインフォルダーは使用できません。', OTHER_CHAT_FOLDER: '他のチャットの作業フォルダーは使用できません。', FAILED: '設定できませんでした。フォルダーを確認して再試行してください。' },
  ko: { button: '다운로드 위치', title: '다운로드 위치', close: '닫기', fixed: '고정 위치', open: '열기', extra: '추가 저장 위치',
    none: '설정되지 않았습니다. 첨부 파일은 고정 위치에만 저장됩니다.', choose: '폴더 선택', change: '변경', disable: '사용 안 함', retryFailed: '실패 재시도',
    progress: '복사됨 {done}・대기 {waiting}・실패 {failed}', confirmOff: '사용 안 함으로 바꾸면 새 첨부 파일은 복사되지 않습니다. 이미 복사한 파일은 유지됩니다.',
    confirm: '확인', cancel: '취소', setDone: '설정했습니다. 이전 첨부 파일을 백그라운드에서 복사하고 있습니다.', offDone: '추가 저장 위치를 사용 안 함으로 바꿨습니다.',
    retryDone: '실패한 첨부 파일 {count}개를 다시 대기열에 넣었습니다.', retryNone: '실패한 첨부 파일이 없습니다.', openError: '폴더를 열 수 없습니다.', loadError: '설정을 불러올 수 없습니다.',
    NOT_ABSOLUTE: '전체 경로의 로컬 폴더를 사용하세요.', NOT_DIRECTORY: '폴더가 없습니다.', REPARSE_POINT: '폴더 링크나 정션은 사용할 수 없습니다.',
    PROTECTED_FOLDER: '시스템 폴더나 첨부 파일 기본 폴더는 사용할 수 없습니다.', OTHER_CHAT_FOLDER: '다른 채팅의 작업 폴더는 사용할 수 없습니다.', FAILED: '설정하지 못했습니다. 폴더를 확인한 뒤 다시 시도하세요.' },
} as const;
type Notice = { kind: 'info' | 'error'; text: string } | null;
const routeId = (key: ConversationKey) => JSON.stringify([key.accountId, key.chatType, key.chatId]);
const isWritable = (key: ConversationKey): key is WritableConversationKey => key.chatType === 'direct' || key.chatType === 'group' || key.chatType === 'room';

/** Gear button of the chat header. Only a chat that can receive attachments shows it. */
export function ChatDownloadLocation({ api, route }: { api: DesktopApi; route: ConversationKey }) {
  return isWritable(route) ? <DownloadLocationPanel api={api} route={route} /> : null;
}

function DownloadLocationPanel({ api, route }: { api: DesktopApi; route: WritableConversationKey }) {
  const locale = useDesktopLocale();
  const copy = COPY[locale];
  const currentRouteId = routeId(route);
  const routeRef = useRef(currentRouteId);
  routeRef.current = currentRouteId;
  const generation = useRef(0);
  const trigger = useRef<HTMLButtonElement>(null);
  const dialog = useRef<HTMLElement>(null);
  const [isOpen, setIsOpen] = useState(false);
  const [status, setStatus] = useState<ChatExtraFolderStatus | null>(null);
  const [notice, setNotice] = useState<Notice>(null);
  const [busy, setBusy] = useState(false);
  const [confirmingOff, setConfirmingOff] = useState(false);
  const fill = (template: string, values: Record<string, number>) => template.replace(/\{(\w+)\}/g, (_, name: string) => String(values[name] ?? ''));

  useLayoutEffect(() => {
    ++generation.current;
    setIsOpen(false); setStatus(null); setNotice(null); setBusy(false); setConfirmingOff(false);
    return () => { ++generation.current; };
  }, [currentRouteId]);

  useLayoutEffect(() => { if (isOpen) dialog.current?.focus(); }, [isOpen]);

  // Every call checks that the panel and the chat are still the same ones that started the call.
  const alive = (requestGeneration: number) => requestGeneration === generation.current && routeRef.current === currentRouteId;

  async function refresh(requestGeneration = generation.current, quiet = false) {
    try {
      const next = await api.getChatExtraFolder(route);
      if (alive(requestGeneration)) setStatus(next);
    } catch {
      if (alive(requestGeneration) && !quiet) setNotice({ kind: 'error', text: copy.loadError });
    }
  }

  const waiting = status ? status.queued + status.claimed : 0;
  useEffect(() => {
    if (!isOpen || waiting === 0) return;
    const requestGeneration = generation.current;
    const timer = setInterval(() => { void refresh(requestGeneration, true); }, REFRESH_MS);
    return () => clearInterval(timer);
  }, [isOpen, waiting > 0, currentRouteId]);

  function open() {
    const requestGeneration = ++generation.current;
    setIsOpen(true); setStatus(null); setNotice(null); setConfirmingOff(false);
    void refresh(requestGeneration);
  }

  function close() {
    ++generation.current;
    setIsOpen(false); setNotice(null); setConfirmingOff(false); setBusy(false);
    trigger.current?.focus();
  }

  useLayoutEffect(() => {
    if (!isOpen) return;
    const onKeyDown = (event: KeyboardEvent) => { if (event.key === 'Escape') { event.stopPropagation(); close(); } };
    document.addEventListener('keydown', onKeyDown, true);
    return () => document.removeEventListener('keydown', onKeyDown, true);
  }, [isOpen]);

  async function run(work: () => Promise<Notice>) {
    const requestGeneration = generation.current;
    setBusy(true); setNotice(null);
    let next: Notice;
    try { next = await work(); } catch { next = { kind: 'error', text: copy.FAILED }; }
    if (!alive(requestGeneration)) return;
    setBusy(false); setNotice(next);
    await refresh(requestGeneration, true);
  }
  const fromResult = (result: ChatExtraFolderResult | null, success: string): Notice =>
    result === null ? null : result.ok ? { kind: 'info', text: success } : { kind: 'error', text: copy[result.code] };

  const choose = () => void run(async () => fromResult(await api.chooseChatExtraFolder(route), copy.setDone));
  const disable = () => { setConfirmingOff(false); void run(async () => fromResult(await api.clearChatExtraFolder(route), copy.offDone)); };
  const retryFailed = () => void run(async () => {
    const count = await api.retryChatExtraFolder(route);
    return { kind: 'info', text: count ? fill(copy.retryDone, { count }) : copy.retryNone };
  });
  const openFolder = (openIt: () => Promise<boolean>) => void run(async () => (await openIt()) ? null : { kind: 'error', text: copy.openError });

  return <>
    <div className="chat-resources-actions">
      <button ref={trigger} type="button" aria-haspopup="dialog" aria-expanded={isOpen} aria-label={copy.button} title={copy.button} onClick={open}>
        <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z" /><circle cx="12" cy="12" r="3" /></svg>
      </button>
    </div>
    {isOpen && <div className="chat-resources-scrim" onMouseDown={(event) => { if (event.target === event.currentTarget) close(); }}>
      <section ref={dialog} className="chat-resources-dialog download-location-dialog" role="dialog" aria-modal="true" aria-labelledby="download-location-title" tabIndex={-1}>
        <header className="chat-resources-dialog-header"><h2 id="download-location-title">{copy.title}</h2><div><button type="button" aria-label={copy.close} onClick={close}><X size={18} aria-hidden="true" /></button></div></header>
        <div className="chat-resources-body download-location-body">
          <div className="download-location-row"><strong>{copy.fixed}</strong><button type="button" disabled={busy} onClick={() => openFolder(() => api.openStoredAttachmentsFolder(route))}>{copy.open}</button></div>
          <h3>{copy.extra}</h3>
          {status && (status.root === null
            ? <><p className="muted">{copy.none}</p><button type="button" disabled={busy} onClick={choose}>{copy.choose}</button></>
            : <>
              <p className="download-location-path">{status.root}</p>
              <p className="muted" role="status">{fill(copy.progress, { done: status.completed, waiting, failed: status.failed })}</p>
              <div className="download-location-actions">
                <button type="button" disabled={busy} onClick={() => openFolder(() => api.openChatExtraFolder(route))}>{copy.open}</button>
                <button type="button" disabled={busy} onClick={choose}>{copy.change}</button>
                <button type="button" disabled={busy} onClick={() => setConfirmingOff(true)}>{copy.disable}</button>
                {status.failed > 0 && <button type="button" disabled={busy} onClick={retryFailed}>{copy.retryFailed}</button>}
              </div>
              {confirmingOff && <div className="download-location-confirm" role="alertdialog" aria-label={copy.confirmOff}><p>{copy.confirmOff}</p>
                <button type="button" onClick={disable}>{copy.confirm}</button><button type="button" onClick={() => setConfirmingOff(false)}>{copy.cancel}</button></div>}
            </>)}
          {notice && <p role={notice.kind === 'error' ? 'alert' : 'status'}>{notice.text}</p>}
        </div>
      </section>
    </div>}
  </>;
}
