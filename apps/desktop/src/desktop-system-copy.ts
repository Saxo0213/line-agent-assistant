/** Legacy display enums are wire values, never persisted translations or user content. */
export const SYSTEM_DISPLAY_COPY = {
  '系統操作失敗': 'System operation failed',
  '系統啟動': 'System startup', '系統關閉': 'System shutdown', '服務啟動': 'Service started', '服務停止': 'Service stopped',
  '工作程序啟動': 'Worker started', '工作程序停止': 'Worker stopped', '工作程序重新啟動': 'Worker restarted',
  '工作程序隔離': 'Worker isolated', '工作程序結束': 'Worker exited', 'LINE 登入開始': 'LINE login started',
  'LINE QR Code 已準備': 'LINE QR code ready', 'LINE PIN 已準備': 'LINE PIN ready', 'LINE 登入完成': 'LINE login completed',
  'LINE 登入失敗': 'LINE login failed', 'LINE 登入失效': 'LINE login invalidated', '登入資訊已更新': 'Login information updated',
  '清除登入資訊': 'Clear login information', '帳號控制變更': 'Account control changed', '帳號模式變更': 'Account mode changed',
  'Agent 狀態變更': 'Agent status changed', 'Codex 登入': 'Codex login', 'Claude 登入': 'Claude login',
  'Codex 登出': 'Codex logout', 'Claude 登出': 'Claude logout', '外部監控設定變更': 'External monitoring settings changed',
  '系統紀錄儲存失敗': 'System record storage failed', '系統紀錄儲存恢復': 'System record storage restored', '系統作業': 'System operation',
  '圖片下載': 'Image download', '影片下載': 'Video download', '語音下載': 'Voice download', '檔案下載': 'File download',
  '附件下載': 'Attachment download', 'LINE 操作失敗': 'LINE action failed', 'LINE 聯絡人／群組清單更新': 'LINE contacts / groups updated',
  '新增使用者（好友授權）': 'Add user (friend authorization)', '新增使用者：確認 LINE 好友關係': 'Add user: verify LINE friendship',
  '新增使用者：加入 LINE 好友': 'Add user: add LINE friend', '新增使用者：重新確認好友': 'Add user: recheck friendship',
  '新增使用者：授權預檢': 'Add user: authorization preflight', '新增使用者：寫入白名單': 'Add user: save allowlist',
  '相簿照片下載': 'Album photo download',
  '自由模式回覆判斷': 'Free mode reply decision', '自由模式中斷回覆': 'Free mode reply interrupted',
  'LINE 訊息延遲（LINE 至本機）': 'LINE message delay (LINE to app)', 'LINE 訊息延遲（本機佇列／寫入）': 'LINE message delay (app queue / save)',
  '已提出': 'Requested', '已完成': 'Completed', '失敗': 'Failed', '已記錄': 'Recorded',
  '等待下載': 'Waiting to download', '下載中': 'Downloading', '已過期': 'Expired', '重試中': 'Retrying', '下載失敗': 'Download failed',
} as const;

export const EXTRA_DESKTOP_COPY = {
  optionalLocalAnalysis: 'OPTIONAL LOCAL ANALYSIS', agents: 'Agents', operations: 'OPERATIONS', agentQueue: 'AGENT QUEUE',
  bytes: 'bytes', lineAccounts: 'LINE ACCOUNTS', agentAccountSlot: 'Agent account slot', primaryAdminAccountSlot: 'Primary Admin account slot',
  archiveSearch: 'ARCHIVE SEARCH', preferences: 'PREFERENCES', mcpEndpoint: 'MCP Endpoint:', accounts: 'Accounts:',
  toolsAvailable: 'LINE tools available', toolsConfigured: 'LINE tools configured', toolsNotLoaded: 'LINE tools not loaded',
  operationFailed: 'Unable to complete this action. Try again.',
  automaticReplyConflict: 'Settings changed elsewhere. The latest version is ready; your edits are preserved. Save again to apply them.',
  queued: 'Queued', running: 'Running', completed: 'Completed', failed: 'Failed', cancelled: 'Cancelled', interrupted: 'Interrupted',
  active: 'Active', revoked: 'Revoked', expired: 'Expired',
  searchAgentTab: 'Agent', searchPrimaryAdminTab: 'Primary Admin', formerAgentAccount: 'Former Agent account',
} as const;

export const EXTRA_TRADITIONAL_COPY: Record<keyof typeof EXTRA_DESKTOP_COPY, string> = {
  optionalLocalAnalysis: '選用本機分析', agents: 'Agent', operations: '作業', agentQueue: 'Agent 佇列', bytes: '位元組', lineAccounts: 'LINE 帳號',
  agentAccountSlot: 'Agent 帳號欄位', primaryAdminAccountSlot: '主要管理員帳號欄位', archiveSearch: '封存搜尋', preferences: '偏好設定',
  mcpEndpoint: 'MCP 端點：', accounts: '帳號：', toolsAvailable: 'LINE 工具可用', toolsConfigured: 'LINE 工具已設定', toolsNotLoaded: 'LINE 工具未載入',
  operationFailed: '無法完成此操作，請重試。', automaticReplyConflict: '設定已在其他位置變更。最新版本已載入，您的編輯內容已保留。請再次儲存以套用。',
  queued: '已排入佇列', running: '執行中', completed: '已完成', failed: '失敗', cancelled: '已取消', interrupted: '已中斷', active: '啟用', revoked: '已撤銷', expired: '已過期',
  searchAgentTab: 'Agent', searchPrimaryAdminTab: '主要管理者', formerAgentAccount: '舊 Agent 帳號',
};
export const EXTRA_JAPANESE_COPY: Record<keyof typeof EXTRA_DESKTOP_COPY, string> = {
  optionalLocalAnalysis: '任意のローカル分析', agents: 'Agent', operations: '操作', agentQueue: 'Agent キュー', bytes: 'バイト', lineAccounts: 'LINE アカウント',
  agentAccountSlot: 'Agent アカウント枠', primaryAdminAccountSlot: '主管理者アカウント枠', archiveSearch: 'アーカイブ検索', preferences: '設定',
  mcpEndpoint: 'MCP エンドポイント：', accounts: 'アカウント：', toolsAvailable: 'LINE ツールを利用できます', toolsConfigured: 'LINE ツールを設定済み', toolsNotLoaded: 'LINE ツールを読み込めません',
  operationFailed: '操作を完了できませんでした。もう一度お試しください。', automaticReplyConflict: '設定が別の場所で変更されました。最新の内容を読み込み、編集内容は保持されています。適用するには再度保存してください。',
  queued: '待機中', running: '実行中', completed: '完了', failed: '失敗', cancelled: 'キャンセル済み', interrupted: '中断', active: '有効', revoked: '取り消し済み', expired: '期限切れ',
  searchAgentTab: 'Agent', searchPrimaryAdminTab: '主管理者', formerAgentAccount: '以前の Agent アカウント',
};
export const EXTRA_KOREAN_COPY: Record<keyof typeof EXTRA_DESKTOP_COPY, string> = {
  optionalLocalAnalysis: '선택적 로컬 분석', agents: 'Agent', operations: '작업', agentQueue: 'Agent 대기열', bytes: '바이트', lineAccounts: 'LINE 계정',
  agentAccountSlot: 'Agent 계정 슬롯', primaryAdminAccountSlot: '주 관리자 계정 슬롯', archiveSearch: '보관 검색', preferences: '환경설정',
  mcpEndpoint: 'MCP 엔드포인트:', accounts: '계정:', toolsAvailable: 'LINE 도구 사용 가능', toolsConfigured: 'LINE 도구 구성됨', toolsNotLoaded: 'LINE 도구가 로드되지 않음',
  operationFailed: '작업을 완료할 수 없습니다. 다시 시도하세요.', automaticReplyConflict: '다른 곳에서 설정이 변경되었습니다. 최신 버전이 준비되었으며 편집 내용은 보존되었습니다. 적용하려면 다시 저장하세요.',
  queued: '대기 중', running: '실행 중', completed: '완료', failed: '실패', cancelled: '취소됨', interrupted: '중단됨', active: '활성', revoked: '취소됨', expired: '만료됨',
  searchAgentTab: 'Agent', searchPrimaryAdminTab: '주 관리자', formerAgentAccount: '이전 Agent 계정',
};

const JAPANESE_SYSTEM_LABELS: Record<keyof typeof SYSTEM_DISPLAY_COPY, string> = {
  '系統操作失敗': 'システム操作失敗',
  '系統啟動': 'システム起動', '系統關閉': 'システム終了', '服務啟動': 'サービス起動', '服務停止': 'サービス停止', '工作程序啟動': 'ワーカー起動', '工作程序停止': 'ワーカー停止', '工作程序重新啟動': 'ワーカー再起動',
  '工作程序隔離': 'ワーカー隔離', '工作程序結束': 'ワーカー終了', 'LINE 登入開始': 'LINE ログイン開始', 'LINE QR Code 已準備': 'LINE QR コードの準備完了', 'LINE PIN 已準備': 'LINE PIN の準備完了',
  'LINE 登入完成': 'LINE ログイン完了', 'LINE 登入失敗': 'LINE ログイン失敗', 'LINE 登入失效': 'LINE ログイン無効', '登入資訊已更新': 'ログイン情報を更新', '清除登入資訊': 'ログイン情報を消去',
  '帳號控制變更': 'アカウント制御を変更', '帳號模式變更': 'アカウントモードを変更', 'Agent 狀態變更': 'Agent の状態を変更', 'Codex 登入': 'Codex ログイン', 'Claude 登入': 'Claude ログイン',
  'Codex 登出': 'Codex ログアウト', 'Claude 登出': 'Claude ログアウト', '外部監控設定變更': '外部監視設定を変更', '系統紀錄儲存失敗': 'システム記録の保存失敗', '系統紀錄儲存恢復': 'システム記録の保存を復旧',
  '系統作業': 'システム操作', '圖片下載': '画像をダウンロード', '影片下載': '動画をダウンロード', '語音下載': '音声をダウンロード', '檔案下載': 'ファイルをダウンロード', '附件下載': '添付ファイルをダウンロード',
  'LINE 操作失敗': 'LINE 操作失敗', 'LINE 聯絡人／群組清單更新': 'LINE 連絡先／グループ一覧を更新', '新增使用者（好友授權）': 'ユーザー追加（友だち認証）', '新增使用者：確認 LINE 好友關係': 'ユーザー追加：LINE の友だち関係を確認',
  '新增使用者：加入 LINE 好友': 'ユーザー追加：LINE の友だちに追加', '新增使用者：重新確認好友': 'ユーザー追加：友だち関係を再確認', '新增使用者：授權預檢': 'ユーザー追加：認証を事前確認', '新增使用者：寫入白名單': 'ユーザー追加：許可リストに保存',
  '相簿照片下載': 'アルバム写真をダウンロード',
  '自由模式回覆判斷': 'フリーモード返信の判定', '自由模式中斷回覆': 'フリーモード返信の中断',
  'LINE 訊息延遲（LINE 至本機）': 'LINE メッセージ遅延（LINE からアプリ）', 'LINE 訊息延遲（本機佇列／寫入）': 'LINE メッセージ遅延（アプリのキュー／保存）',
  '已提出': 'リクエスト済み', '已完成': '完了', '失敗': '失敗', '已記錄': '記録済み', '等待下載': 'ダウンロード待ち', '下載中': 'ダウンロード中', '已過期': '期限切れ', '重試中': '再試行中', '下載失敗': 'ダウンロード失敗',
};
const KOREAN_SYSTEM_LABELS: Record<keyof typeof SYSTEM_DISPLAY_COPY, string> = {
  '系統操作失敗': '시스템 작업 실패',
  '系統啟動': '시스템 시작', '系統關閉': '시스템 종료', '服務啟動': '서비스 시작', '服務停止': '서비스 중지', '工作程序啟動': '작업자 시작', '工作程序停止': '작업자 중지', '工作程序重新啟動': '작업자 재시작',
  '工作程序隔離': '작업자 격리', '工作程序結束': '작업자 종료', 'LINE 登入開始': 'LINE 로그인 시작', 'LINE QR Code 已準備': 'LINE QR 코드 준비 완료', 'LINE PIN 已準備': 'LINE PIN 준비 완료',
  'LINE 登入完成': 'LINE 로그인 완료', 'LINE 登入失敗': 'LINE 로그인 실패', 'LINE 登入失效': 'LINE 로그인 무효화', '登入資訊已更新': '로그인 정보 업데이트', '清除登入資訊': '로그인 정보 삭제',
  '帳號控制變更': '계정 제어 변경', '帳號模式變更': '계정 모드 변경', 'Agent 狀態變更': 'Agent 상태 변경', 'Codex 登入': 'Codex 로그인', 'Claude 登入': 'Claude 로그인',
  'Codex 登出': 'Codex 로그아웃', 'Claude 登出': 'Claude 로그아웃', '外部監控設定變更': '외부 모니터링 설정 변경', '系統紀錄儲存失敗': '시스템 기록 저장 실패', '系統紀錄儲存恢復': '시스템 기록 저장 복구',
  '系統作業': '시스템 작업', '圖片下載': '이미지 다운로드', '影片下載': '동영상 다운로드', '語音下載': '음성 다운로드', '檔案下載': '파일 다운로드', '附件下載': '첨부 파일 다운로드',
  'LINE 操作失敗': 'LINE 작업 실패', 'LINE 聯絡人／群組清單更新': 'LINE 연락처／그룹 목록 업데이트', '新增使用者（好友授權）': '사용자 추가(친구 인증)', '新增使用者：確認 LINE 好友關係': '사용자 추가: LINE 친구 관계 확인',
  '新增使用者：加入 LINE 好友': '사용자 추가: LINE 친구 추가', '新增使用者：重新確認好友': '사용자 추가: 친구 관계 재확인', '新增使用者：授權預檢': '사용자 추가: 인증 사전 확인', '新增使用者：寫入白名單': '사용자 추가: 허용 목록 저장',
  '相簿照片下載': '앨범 사진 다운로드',
  '自由模式回覆判斷': '자유 모드 답장 판단', '自由模式中斷回覆': '자유 모드 답장 중단',
  'LINE 訊息延遲（LINE 至本機）': 'LINE 메시지 지연(LINE에서 앱)', 'LINE 訊息延遲（本機佇列／寫入）': 'LINE 메시지 지연(앱 대기열/저장)',
  '已提出': '요청됨', '已完成': '완료', '失敗': '실패', '已記錄': '기록됨', '等待下載': '다운로드 대기', '下載中': '다운로드 중', '已過期': '만료됨', '重試中': '재시도 중', '下載失敗': '다운로드 실패',
};

export const SYSTEM_LABELS: Record<import('./locale.js').Locale, Record<keyof typeof SYSTEM_DISPLAY_COPY, string>> = {
  en: SYSTEM_DISPLAY_COPY,
  'zh-TW': Object.fromEntries(Object.keys(SYSTEM_DISPLAY_COPY).map((key) => [key, key])) as Record<keyof typeof SYSTEM_DISPLAY_COPY, string>,
  ja: JAPANESE_SYSTEM_LABELS,
  ko: KOREAN_SYSTEM_LABELS,
};

const NATIVE_ENGLISH_COPY = {
  newAttachmentFolder: 'Choose a new LINE attachment folder', attachmentFolder: 'Choose a LINE attachment folder',
  agentWorkspace: 'Choose an Agent workspace', showConsole: 'Show console', quit: 'Quit',
} as const;
const NATIVE_TRADITIONAL_COPY: Record<keyof typeof NATIVE_ENGLISH_COPY, string> = {
  newAttachmentFolder: '選擇新的 LINE 附件儲存資料夾', attachmentFolder: '選擇 LINE 附件儲存資料夾',
  agentWorkspace: '選擇 Agent 工作目錄', showConsole: '顯示操作台', quit: '結束',
};
const NATIVE_JAPANESE_COPY: Record<keyof typeof NATIVE_ENGLISH_COPY, string> = {
  newAttachmentFolder: '新しい LINE 添付ファイルフォルダーを選択', attachmentFolder: 'LINE 添付ファイルフォルダーを選択', agentWorkspace: 'Agent ワークスペースを選択', showConsole: 'コンソールを表示', quit: '終了',
};
const NATIVE_KOREAN_COPY: Record<keyof typeof NATIVE_ENGLISH_COPY, string> = {
  newAttachmentFolder: '새 LINE 첨부 파일 폴더 선택', attachmentFolder: 'LINE 첨부 파일 폴더 선택', agentWorkspace: 'Agent 작업 공간 선택', showConsole: '콘솔 표시', quit: '종료',
};
export function nativeDesktopText(locale: import('./locale.js').Locale, key: keyof typeof NATIVE_ENGLISH_COPY): string {
  return ({ en: NATIVE_ENGLISH_COPY, 'zh-TW': NATIVE_TRADITIONAL_COPY, ja: NATIVE_JAPANESE_COPY, ko: NATIVE_KOREAN_COPY }[locale] ?? NATIVE_ENGLISH_COPY)[key];
}
