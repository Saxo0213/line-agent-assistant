import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { X } from 'lucide-react';
import { CHAT_EXTRA_FOLDER_DESCRIPTION_MAX, CHAT_EXTRA_FOLDER_LIMIT, type ChatExtraFolder, type ChatExtraFolderResult, type ChatExtraFolderStatus, type ConversationKey, type WritableConversationKey } from '@line-agent/contracts';
import type { DesktopApi } from '../../preload/api.js';
import { useDesktopLocale } from '../desktop-i18n.js';
import { projectFoldersTextFor, type ProjectFoldersCopyKey } from '../../desktop-project-folders-copy.js';
import { ProjectFoldersPanel } from './ProjectFoldersPanel.js';
import { AgentWhitelistPermissions } from './AgentWhitelistPermissions.js';

const REFRESH_MS = 5_000;
const COPY = {
  en: { button: 'Chat settings', title: 'Chat settings', tabDownload: 'Download folders', tabAccess: 'Agent access folders', tabPermissions: 'Permissions', tabsLabel: 'Settings of this chat',
    permissionsMeaning: 'Permissions of the Agent when it works for a whitelisted user in this chat.', notWhitelisted: 'This person is not on the whitelist.',
    meaning: 'Attachments of the selected chat are copied here; the Agent cannot read them unless they are also an access folder.', close: 'Close', fixed: 'Fixed location', open: 'Open', defaultFolder: 'Default folder',
    defaultNone: 'Not set. What no classification folder gets stays in the fixed location only.', choose: 'Choose', change: 'Change', remove: 'Remove',
    classified: 'Classification folders', none: 'No classification folder.', add: 'Add folder', description: 'Description (for example: invoices, receipts)',
    hintDefault: 'All attachments are copied to the default folder.', hintOne: 'All attachments are copied to this folder.',
    hintMany: 'The Agent sorts each new attachment into a classification folder by its description, file name, message and image content. If it cannot decide, the attachment goes to the default folder (with no default folder it stays in the fixed location only).',
    waitingClassification: 'Waiting for classification {count}', recent: 'Recent classifications', retryFailed: 'Retry failed',
    progress: 'Copied {done} · Waiting {waiting} · Failed {failed}', confirmRemove: 'After you remove it, attachments are no longer copied to this folder. Files already copied are kept.',
    confirm: 'Confirm', cancel: 'Cancel', setDone: 'Folder set. History attachments are being copied in the background.', addDone: 'Folder added.', removeDone: 'Folder removed.',
    retryDone: '{count} failed attachments are queued again.', retryNone: 'No failed attachments.', openError: 'Unable to open the folder.', loadError: 'Unable to load the setting.',
    agent: 'Agent decision', default_uncertain: 'Not sure, default folder', default_failed: 'Classification failed, default folder', noFolder: 'fixed location only',
    ACCESS_DENIED: 'Access to the folder was denied. Check the permissions of the folder or the network share.',
    UNREACHABLE: 'The folder cannot be reached. Check that the network share is online.',
    NOT_ABSOLUTE: 'Use a folder with a full path: a local folder or a network share such as \\\\server\\share\\folder.', NOT_DIRECTORY: 'The folder does not exist.', REPARSE_POINT: 'A folder link or junction cannot be used.',
    PROTECTED_FOLDER: 'Cannot use a system folder or the main attachment folder.', OTHER_CHAT_FOLDER: 'Cannot use the work folder of another chat.',
    DUPLICATE_FOLDER: 'This folder is already in use for this chat.', LIMIT_REACHED: 'A chat can have 10 classification folders at most.',
    NOT_FOUND: 'The folder was not found. The list is updated.', FAILED: 'Unable to save the setting. Check the folder and try again.' },
  'zh-TW': { button: '聊天室設定', title: '聊天室設定', tabDownload: '下載資料夾', tabAccess: 'Agent 權限資料夾', tabPermissions: '權限設定', tabsLabel: '本聊天室的設定',
    permissionsMeaning: 'Agent 在此聊天室為白名單使用者工作時的權限。', notWhitelisted: '此聊天對象不在白名單中。',
    meaning: '所選聊天室的附件會複製到這裡；Agent 不能讀取，除非這些資料夾同時也是權限資料夾。', close: '關閉', fixed: '固定位置', open: '開啟', defaultFolder: '預設資料夾',
    defaultNone: '未設定。沒有分類資料夾收到的附件只留在固定位置。', choose: '選擇', change: '更換', remove: '移除',
    classified: '分類資料夾', none: '沒有分類資料夾。', add: '新增資料夾', description: '說明（例如：發票、收據）',
    hintDefault: '所有附件都會複製到預設資料夾。', hintOne: '所有附件都會複製到這個資料夾。',
    hintMany: 'Agent 會依說明、檔名、訊息和圖片內容把新附件分到分類資料夾；判斷不出來放預設資料夾（未設定預設時只留在固定位置）。',
    waitingClassification: '等待分類 {count}', recent: '最近分類', retryFailed: '重試失敗',
    progress: '已複製 {done}・等待 {waiting}・失敗 {failed}', confirmRemove: '移除後不再複製到這個資料夾，已複製的檔案會保留。',
    confirm: '確認', cancel: '取消', setDone: '已設定，歷史附件正在背景複製。', addDone: '已新增資料夾。', removeDone: '已移除資料夾。',
    retryDone: '已重新排入 {count} 個失敗附件。', retryNone: '目前沒有失敗的附件。', openError: '無法開啟資料夾。', loadError: '無法載入設定。',
    agent: 'Agent 判斷', default_uncertain: '判斷不出來，放預設資料夾', default_failed: '分類失敗，放預設資料夾', noFolder: '只留在固定位置',
    ACCESS_DENIED: '沒有權限存取這個資料夾，請檢查資料夾或網路分享的權限。',
    UNREACHABLE: '連不到這個資料夾，請確認網路分享已連線。',
    NOT_ABSOLUTE: '請使用完整路徑的資料夾：本機資料夾，或像 \\\\server\\share\\folder 的網路分享。', NOT_DIRECTORY: '資料夾不存在', REPARSE_POINT: '不能使用資料夾連結或接合點。',
    PROTECTED_FOLDER: '不能使用系統資料夾或附件主資料夾', OTHER_CHAT_FOLDER: '不能使用其他聊天室的工作資料夾',
    DUPLICATE_FOLDER: '這個資料夾已經在本聊天室使用。', LIMIT_REACHED: '每個聊天室最多 10 個分類資料夾。',
    NOT_FOUND: '找不到這個資料夾，列表已更新。', FAILED: '設定失敗，請檢查資料夾後重試。' },
  ja: { button: 'チャット設定', title: 'チャット設定', tabDownload: 'ダウンロードフォルダー', tabAccess: 'Agent アクセスフォルダー', tabPermissions: '権限設定', tabsLabel: 'このチャットの設定',
    permissionsMeaning: 'このチャットでホワイトリストのユーザーのために Agent が作業するときの権限です。', notWhitelisted: 'この相手はホワイトリストに登録されていません。',
    meaning: '選択したチャットの添付ファイルがここにコピーされます。アクセスフォルダーにも設定しない限り、Agent は読み取れません。', close: '閉じる', fixed: '固定の保存先', open: '開く', defaultFolder: 'デフォルトフォルダー',
    defaultNone: '未設定です。分類フォルダーに入らない添付ファイルは固定の保存先にだけ残ります。', choose: '選択', change: '変更', remove: '削除',
    classified: '分類フォルダー', none: '分類フォルダーはありません。', add: 'フォルダーを追加', description: '説明（例：請求書、領収書）',
    hintDefault: 'すべての添付ファイルがデフォルトフォルダーにコピーされます。', hintOne: 'すべての添付ファイルがこのフォルダーにコピーされます。',
    hintMany: 'Agent が説明、ファイル名、メッセージ、画像の内容から新しい添付ファイルを分類フォルダーに振り分けます。判断できないものはデフォルトフォルダーに入ります（デフォルト未設定の場合は固定の保存先にだけ残ります）。',
    waitingClassification: '分類待ち {count}', recent: '最近の分類', retryFailed: '失敗を再試行',
    progress: 'コピー済み {done}・待機 {waiting}・失敗 {failed}', confirmRemove: '削除すると、このフォルダーへはコピーされません。コピー済みのファイルは残ります。',
    confirm: '確認', cancel: 'キャンセル', setDone: '設定しました。過去の添付ファイルをバックグラウンドでコピーしています。', addDone: 'フォルダーを追加しました。', removeDone: 'フォルダーを削除しました。',
    retryDone: '失敗した添付ファイル {count} 件を再度キューに入れました。', retryNone: '失敗した添付ファイルはありません。', openError: 'フォルダーを開けません。', loadError: '設定を読み込めません。',
    agent: 'Agent の判断', default_uncertain: '判断できず、デフォルトフォルダーへ', default_failed: '分類に失敗、デフォルトフォルダーへ', noFolder: '固定の保存先のみ',
    ACCESS_DENIED: 'フォルダーへのアクセスが拒否されました。フォルダーまたはネットワーク共有の権限を確認してください。',
    UNREACHABLE: 'フォルダーに接続できません。ネットワーク共有がオンラインか確認してください。',
    NOT_ABSOLUTE: 'フルパスのフォルダー（ローカルフォルダー、または \\\\server\\share\\folder のようなネットワーク共有）を使用してください。', NOT_DIRECTORY: 'フォルダーが存在しません。', REPARSE_POINT: 'フォルダーのリンクやジャンクションは使用できません。',
    PROTECTED_FOLDER: 'システムフォルダーまたは添付ファイルのメインフォルダーは使用できません。', OTHER_CHAT_FOLDER: '他のチャットの作業フォルダーは使用できません。',
    DUPLICATE_FOLDER: 'このフォルダーはこのチャットで既に使用されています。', LIMIT_REACHED: '1 つのチャットに設定できる分類フォルダーは最大 10 個です。',
    NOT_FOUND: 'フォルダーが見つかりません。一覧を更新しました。', FAILED: '設定できませんでした。フォルダーを確認して再試行してください。' },
  ko: { button: '채팅 설정', title: '채팅 설정', tabDownload: '다운로드 폴더', tabAccess: 'Agent 접근 폴더', tabPermissions: '권한 설정', tabsLabel: '이 채팅의 설정',
    permissionsMeaning: '이 채팅에서 Agent가 화이트리스트 사용자를 위해 작업할 때의 권한입니다.', notWhitelisted: '이 상대는 화이트리스트에 없습니다.',
    meaning: '선택한 채팅의 첨부 파일이 여기로 복사됩니다. 접근 폴더로도 설정하지 않으면 Agent는 읽을 수 없습니다.', close: '닫기', fixed: '고정 위치', open: '열기', defaultFolder: '기본 폴더',
    defaultNone: '설정되지 않았습니다. 분류 폴더에 들어가지 않는 첨부 파일은 고정 위치에만 남습니다.', choose: '선택', change: '변경', remove: '제거',
    classified: '분류 폴더', none: '분류 폴더가 없습니다.', add: '폴더 추가', description: '설명 (예: 청구서, 영수증)',
    hintDefault: '모든 첨부 파일이 기본 폴더로 복사됩니다.', hintOne: '모든 첨부 파일이 이 폴더로 복사됩니다.',
    hintMany: 'Agent가 설명, 파일 이름, 메시지, 이미지 내용을 보고 새 첨부 파일을 분류 폴더로 나눕니다. 판단하지 못하면 기본 폴더에 넣습니다 (기본 폴더가 없으면 고정 위치에만 남습니다).',
    waitingClassification: '분류 대기 {count}', recent: '최근 분류', retryFailed: '실패 재시도',
    progress: '복사됨 {done}・대기 {waiting}・실패 {failed}', confirmRemove: '제거하면 이 폴더로 더 이상 복사되지 않습니다. 이미 복사한 파일은 유지됩니다.',
    confirm: '확인', cancel: '취소', setDone: '설정했습니다. 이전 첨부 파일을 백그라운드에서 복사하고 있습니다.', addDone: '폴더를 추가했습니다.', removeDone: '폴더를 제거했습니다.',
    retryDone: '실패한 첨부 파일 {count}개를 다시 대기열에 넣었습니다.', retryNone: '실패한 첨부 파일이 없습니다.', openError: '폴더를 열 수 없습니다.', loadError: '설정을 불러올 수 없습니다.',
    agent: 'Agent 판단', default_uncertain: '판단 불가, 기본 폴더', default_failed: '분류 실패, 기본 폴더', noFolder: '고정 위치에만',
    ACCESS_DENIED: '폴더에 접근할 수 없습니다. 폴더 또는 네트워크 공유의 권한을 확인하세요.',
    UNREACHABLE: '폴더에 연결할 수 없습니다. 네트워크 공유가 온라인인지 확인하세요.',
    NOT_ABSOLUTE: '전체 경로의 폴더(로컬 폴더 또는 \\\\server\\share\\folder 같은 네트워크 공유)를 사용하세요.', NOT_DIRECTORY: '폴더가 없습니다.', REPARSE_POINT: '폴더 링크나 정션은 사용할 수 없습니다.',
    PROTECTED_FOLDER: '시스템 폴더나 첨부 파일 기본 폴더는 사용할 수 없습니다.', OTHER_CHAT_FOLDER: '다른 채팅의 작업 폴더는 사용할 수 없습니다.',
    DUPLICATE_FOLDER: '이 폴더는 이 채팅에서 이미 사용 중입니다.', LIMIT_REACHED: '채팅마다 분류 폴더는 최대 10개입니다.',
    NOT_FOUND: '폴더를 찾을 수 없습니다. 목록을 새로 고쳤습니다.', FAILED: '설정하지 못했습니다. 폴더를 확인한 뒤 다시 시도하세요.' },
} as const;
/** Texts of the Settings download-folder section. */
export const downloadFoldersText = (locale: keyof typeof COPY) => ({ heading: COPY[locale].tabDownload, meaning: COPY[locale].meaning });
type Copy = (typeof COPY)[keyof typeof COPY];
type Notice = { kind: 'info' | 'error'; text: string } | null;
const routeId = (key: ConversationKey) => JSON.stringify([key.accountId, key.chatType, key.chatId]);
const isWritable = (key: ConversationKey): key is WritableConversationKey => key.chatType === 'direct' || key.chatType === 'group' || key.chatType === 'room';
const baseName = (root: string) => root.split(/[\\/]+/).filter(Boolean).pop() ?? root;
const fill = (template: string, values: Record<string, number>) => template.replace(/\{(\w+)\}/g, (_, name: string) => String(values[name] ?? ''));

/**
 * Gear button of the chat header. Only a chat that can receive attachments shows it.
 * The dialog has a tab for the download folders and, when `accessFolders` is true (an Agent account),
 * a tab for the Agent access folders and a tab for the whitelist permissions of this chat.
 */
export function ChatDownloadLocation({ api, route, accessFolders = false }: { api: DesktopApi; route: ConversationKey; accessFolders?: boolean }) {
  return isWritable(route) ? <FolderSettingsDialog api={api} route={route} accessFolders={accessFolders} /> : null;
}

type FolderTab = 'download' | 'access' | 'permissions';

function FolderSettingsDialog({ api, route, accessFolders }: { api: DesktopApi; route: WritableConversationKey; accessFolders: boolean }) {
  const locale = useDesktopLocale();
  const copy = COPY[locale];
  const accessText = (key: ProjectFoldersCopyKey) => projectFoldersTextFor(locale, key);
  const currentRouteId = routeId(route);
  const trigger = useRef<HTMLButtonElement>(null);
  const dialog = useRef<HTMLElement>(null);
  const [isOpen, setIsOpen] = useState(false);
  const [tab, setTab] = useState<FolderTab>('download');

  // A different chat closes the dialog.
  useLayoutEffect(() => { setIsOpen(false); setTab('download'); }, [currentRouteId]);
  useLayoutEffect(() => { if (isOpen) dialog.current?.focus(); }, [isOpen]);

  const open = () => { setTab('download'); setIsOpen(true); };
  const close = () => { setIsOpen(false); trigger.current?.focus(); };
  useLayoutEffect(() => {
    if (!isOpen) return;
    const onKeyDown = (event: KeyboardEvent) => { if (event.key === 'Escape') { event.stopPropagation(); close(); } };
    document.addEventListener('keydown', onKeyDown, true);
    return () => document.removeEventListener('keydown', onKeyDown, true);
  }, [isOpen]);

  const tabs: { id: FolderTab; label: string }[] = [{ id: 'download', label: copy.tabDownload }, ...(accessFolders ? [{ id: 'access' as const, label: copy.tabAccess }, { id: 'permissions' as const, label: copy.tabPermissions }] : [])];
  const active: FolderTab = tabs.some((item) => item.id === tab) ? tab : 'download';
  const onTabKeyDown = (event: React.KeyboardEvent<HTMLButtonElement>) => {
    if (event.key !== 'ArrowRight' && event.key !== 'ArrowLeft') return;
    event.preventDefault();
    const index = tabs.findIndex((item) => item.id === active);
    const next = tabs[(index + (event.key === 'ArrowRight' ? 1 : tabs.length - 1)) % tabs.length]!;
    setTab(next.id);
    document.getElementById(`folder-settings-tab-${next.id}`)?.focus();
  };

  return <>
    <div className="chat-resources-actions">
      <button ref={trigger} type="button" aria-haspopup="dialog" aria-expanded={isOpen} aria-label={copy.button} title={copy.button} onClick={open}>
        <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z" /><circle cx="12" cy="12" r="3" /></svg>
      </button>
    </div>
    {isOpen && <div className="chat-resources-scrim" onMouseDown={(event) => { if (event.target === event.currentTarget) close(); }}>
      <section ref={dialog} className="chat-resources-dialog download-location-dialog" role="dialog" aria-modal="true" aria-labelledby="download-location-title" tabIndex={-1}>
        <header className="chat-resources-dialog-header"><h2 id="download-location-title">{copy.title}</h2><div><button type="button" aria-label={copy.close} onClick={close}><X size={18} aria-hidden="true" /></button></div></header>
        {tabs.length > 1 && <div className="folder-settings-tabs" role="tablist" aria-label={copy.tabsLabel}>
          {tabs.map((item) => <button key={item.id} id={`folder-settings-tab-${item.id}`} type="button" role="tab" aria-selected={active === item.id}
            aria-controls={`folder-settings-panel-${item.id}`} tabIndex={active === item.id ? 0 : -1} className={active === item.id ? 'active' : ''}
            onClick={() => setTab(item.id)} onKeyDown={onTabKeyDown}>{item.label}</button>)}
        </div>}
        <div className="chat-resources-body download-location-body">
          {active === 'download'
            ? <div id="folder-settings-panel-download" role={tabs.length > 1 ? 'tabpanel' : undefined} aria-labelledby={tabs.length > 1 ? 'folder-settings-tab-download' : undefined} className="download-location-tab">
              <p className="muted">{copy.meaning}</p>
              <ChatDownloadLocationPanel api={api} route={route} /></div>
            : active === 'access'
              ? <div id="folder-settings-panel-access" role="tabpanel" aria-labelledby="folder-settings-tab-access" className="download-location-tab">
                <p className="muted">{accessText('note')}</p>
                <ProjectFoldersPanel api={api} route={{ accountId: route.accountId, chatType: route.chatType, chatId: route.chatId }} /></div>
              : <div id="folder-settings-panel-permissions" role="tabpanel" aria-labelledby="folder-settings-tab-permissions" className="download-location-tab">
                <p className="muted">{copy.permissionsMeaning}</p>
                <AgentWhitelistPermissions api={api} accountId={route.accountId} fixedChat={{ chatType: route.chatType, chatId: route.chatId }} notWhitelistedText={copy.notWhitelisted} /></div>}
        </div>
      </section>
    </div>}
  </>;
}

/** One classification folder. The description is a draft that is saved on blur or Enter. */
function ClassifiedRow({ folder, copy, busy, confirming, onSaveDescription, onOpen, onAskRemove, onRemove, onCancelRemove }: {
  folder: ChatExtraFolder; copy: Copy; busy: boolean; confirming: boolean; onSaveDescription(folderId: string, description: string): void;
  onOpen(folderId: string): void; onAskRemove(folderId: string): void; onRemove(folderId: string): void; onCancelRemove(): void;
}) {
  const [text, setText] = useState(folder.description);
  const focused = useRef(false);
  const lastSaved = useRef(folder.description);
  useEffect(() => { lastSaved.current = folder.description; if (!focused.current) setText(folder.description); }, [folder.description]);
  const save = () => {
    const next = text.trim();
    if (next === lastSaved.current) return;
    lastSaved.current = next;
    onSaveDescription(folder.folderId, next);
  };
  return <li className="download-location-folder">
    <div className="download-location-pathrow">
      <p className="download-location-path">{folder.root}</p>
      <div className="download-location-actions">
        <button type="button" disabled={busy} onClick={() => onOpen(folder.folderId)}>{copy.open}</button>
        <button type="button" disabled={busy} onClick={() => onAskRemove(folder.folderId)}>{copy.remove}</button>
      </div>
    </div>
    <input type="text" value={text} maxLength={CHAT_EXTRA_FOLDER_DESCRIPTION_MAX} placeholder={copy.description} aria-label={`${copy.description} ${baseName(folder.root)}`}
      onChange={(event) => setText(event.target.value)} onFocus={() => { focused.current = true; }}
      onBlur={() => { focused.current = false; save(); }} onKeyDown={(event) => { if (event.key === 'Enter') { event.preventDefault(); save(); } }} />
    <p className="muted" role="status">{fill(copy.progress, { done: folder.completed, waiting: folder.queued + folder.claimed, failed: folder.failed })}</p>
    {confirming && <div className="download-location-confirm" role="alertdialog" aria-label={copy.confirmRemove}><p>{copy.confirmRemove}</p>
      <button type="button" onClick={() => onRemove(folder.folderId)}>{copy.confirm}</button><button type="button" onClick={onCancelRemove}>{copy.cancel}</button></div>}
  </li>;
}

/**
 * The body of the download-folder setting of one chat: fixed location, default folder, classification folders, counts and decisions.
 * The gear dialog and Settings → 資料夾 both render it. It loads when it mounts and when the chat changes.
 */
export function ChatDownloadLocationPanel({ api, route }: { api: DesktopApi; route: WritableConversationKey }) {
  const locale = useDesktopLocale();
  const copy = COPY[locale];
  const currentRouteId = routeId(route);
  const routeRef = useRef(currentRouteId);
  routeRef.current = currentRouteId;
  const generation = useRef(0);
  const [status, setStatus] = useState<ChatExtraFolderStatus | null>(null);
  const [notice, setNotice] = useState<Notice>(null);
  const [busy, setBusy] = useState(false);
  const [confirming, setConfirming] = useState<string | null>(null);

  useLayoutEffect(() => {
    const requestGeneration = ++generation.current;
    setStatus(null); setNotice(null); setBusy(false); setConfirming(null);
    void refresh(requestGeneration);
    return () => { ++generation.current; };
  }, [currentRouteId]);

  // Every call checks that the panel and the chat are still the same ones that started the call.
  const alive = (requestGeneration: number) => requestGeneration === generation.current && routeRef.current === currentRouteId;

  async function refresh(requestGeneration = generation.current, quiet = false) {
    try {
      const next = await api.listChatExtraFolders(route);
      if (alive(requestGeneration)) setStatus(next);
    } catch {
      if (alive(requestGeneration) && !quiet) setNotice({ kind: 'error', text: copy.loadError });
    }
  }

  const entries = status ? [...(status.defaultFolder ? [status.defaultFolder] : []), ...status.folders] : [];
  const waiting = status ? entries.reduce((sum, entry) => sum + entry.queued + entry.claimed, 0) + status.waitingClassification : 0;
  const failed = entries.reduce((sum, entry) => sum + entry.failed, 0);
  useEffect(() => {
    if (waiting === 0) return;
    const requestGeneration = generation.current;
    const timer = setInterval(() => { void refresh(requestGeneration, true); }, REFRESH_MS);
    return () => clearInterval(timer);
  }, [waiting > 0, currentRouteId]);

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

  const folderCount = status?.folders.length ?? 0;
  const hasDefault = !!status?.defaultFolder;
  const chooseDefault = () => void run(async () => fromResult(await api.setDefaultChatExtraFolder(route), folderCount === 0 ? copy.setDone : copy.addDone));
  const addFolder = () => void run(async () => fromResult(await api.addChatExtraFolder(route), !hasDefault && folderCount === 0 ? copy.setDone : copy.addDone));
  const removeFolder = (folderId: string) => { setConfirming(null); void run(async () => fromResult(await api.removeChatExtraFolder(route, folderId), copy.removeDone)); };
  const saveDescription = (folderId: string, description: string) => void run(async () => fromResult(await api.setChatExtraFolderDescription(route, folderId, description), ''));
  const retryFailed = () => void run(async () => {
    const count = await api.retryChatExtraFolders(route);
    return { kind: 'info', text: count ? fill(copy.retryDone, { count }) : copy.retryNone };
  });
  const openFolder = (openIt: () => Promise<boolean>) => void run(async () => (await openIt()) ? null : { kind: 'error', text: copy.openError });
  const hint = !status ? '' : folderCount === 0 ? (hasDefault ? copy.hintDefault : '') : folderCount === 1 && !hasDefault ? copy.hintOne : copy.hintMany;
  const defaultFolder = status?.defaultFolder ?? null;

  return <div className="download-location-body">
          <div className="download-location-row"><strong>{copy.fixed}</strong><button type="button" disabled={busy} onClick={() => openFolder(() => api.openStoredAttachmentsFolder(route))}>{copy.open}</button></div>
          {status && <>
            <h3>{copy.defaultFolder}</h3>
            {defaultFolder === null
              ? <><p className="muted">{copy.defaultNone}</p><div className="download-location-actions"><button type="button" disabled={busy} onClick={chooseDefault}>{copy.choose}</button></div></>
              : <>
                <div className="download-location-pathrow">
                  <p className="download-location-path">{defaultFolder.root}</p>
                  <div className="download-location-actions">
                    <button type="button" disabled={busy} onClick={() => openFolder(() => api.openChatExtraFolder(route, defaultFolder.folderId))}>{copy.open}</button>
                    <button type="button" disabled={busy} onClick={chooseDefault}>{copy.change}</button>
                    <button type="button" disabled={busy} onClick={() => setConfirming(defaultFolder.folderId)}>{copy.remove}</button>
                  </div>
                </div>
                <p className="muted" role="status">{fill(copy.progress, { done: defaultFolder.completed, waiting: defaultFolder.queued + defaultFolder.claimed, failed: defaultFolder.failed })}</p>
                {confirming === defaultFolder.folderId && <div className="download-location-confirm" role="alertdialog" aria-label={copy.confirmRemove}><p>{copy.confirmRemove}</p>
                  <button type="button" onClick={() => removeFolder(defaultFolder.folderId)}>{copy.confirm}</button><button type="button" onClick={() => setConfirming(null)}>{copy.cancel}</button></div>}
              </>}
            <h3>{copy.classified}</h3>
            {folderCount === 0 && <p className="muted">{copy.none}</p>}
            {folderCount > 0 && <ul className="download-location-folders">
              {status.folders.map((folder) => <ClassifiedRow key={folder.folderId} folder={folder} copy={copy} busy={busy} confirming={confirming === folder.folderId}
                onSaveDescription={saveDescription} onOpen={(folderId) => openFolder(() => api.openChatExtraFolder(route, folderId))}
                onAskRemove={setConfirming} onRemove={removeFolder} onCancelRemove={() => setConfirming(null)} />)}
            </ul>}
            <div className="download-location-actions">
              <button type="button" disabled={busy || folderCount >= CHAT_EXTRA_FOLDER_LIMIT} onClick={addFolder}>{copy.add}</button>
              {failed > 0 && <button type="button" disabled={busy} onClick={retryFailed}>{copy.retryFailed}</button>}
            </div>
            {hint && <p className="muted">{hint}</p>}
            {status.waitingClassification > 0 && <p className="muted" role="status">{fill(copy.waitingClassification, { count: status.waitingClassification })}</p>}
            {status.decisions.length > 0 && <>
              <h3>{copy.recent}</h3>
              <ul className="download-location-decisions">
                {status.decisions.map((decision, index) => <li key={`${decision.decidedAt}-${index}`}>
                  <span>{decision.attachmentName} → {decision.folderName ?? copy.noFolder}</span>
                  <span className="muted"> · {copy[decision.decidedBy]}{decision.reason ? ` · ${decision.reason}` : ''}</span></li>)}
              </ul>
            </>}
          </>}
          {notice && notice.text && <p role={notice.kind === 'error' ? 'alert' : 'status'}>{notice.text}</p>}
  </div>;
}
