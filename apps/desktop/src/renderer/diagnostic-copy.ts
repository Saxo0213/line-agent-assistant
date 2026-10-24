import type { SafeDiagnostic } from '@line-agent/contracts';
import type { Locale } from '../locale.js';

const recovery: Record<Locale, Record<SafeDiagnostic['recovery'], string>> = {
  en: { retry: 'Retry this action.', reconnect: 'Reconnect the account.', relogin: 'Sign in again with LINE QR login.', check_configuration: 'Check configuration and access permissions.', reopen_app: 'Reopen the application.', wait: 'Wait for recovery.', none: 'No action is required.', inspect_outcome: 'Check the outcome before trying again.' },
  'zh-TW': { retry: '請重試這項操作。', reconnect: '請重新連線此帳號。', relogin: '請重新使用 LINE QR Code 登入。', check_configuration: '請檢查設定與存取權限。', reopen_app: '請重新開啟應用程式。', wait: '請等待恢復。', none: '不需要採取行動。', inspect_outcome: '請先確認操作結果，再決定是否重試。' },
  ja: { retry: '操作を再試行してください。', reconnect: 'アカウントを再接続してください。', relogin: 'LINE QR コードで再度ログインしてください。', check_configuration: '設定とアクセス権を確認してください。', reopen_app: 'アプリを開き直してください。', wait: '復旧をお待ちください。', none: '操作は不要です。', inspect_outcome: '再試行する前に結果を確認してください。' },
  ko: { retry: '작업을 다시 시도하세요.', reconnect: '계정을 다시 연결하세요.', relogin: 'LINE QR 코드로 다시 로그인하세요.', check_configuration: '설정과 접근 권한을 확인하세요.', reopen_app: '앱을 다시 여세요.', wait: '복구를 기다리세요.', none: '조치가 필요하지 않습니다.', inspect_outcome: '다시 시도하기 전에 결과를 확인하세요.' },
};
export const diagnosticLabels: Record<Locale, { operation: string; stage: string; reason: string; failureKind: string; upstreamStatus: string; upstreamCode: string; recovery: string; reference: string; legacy: string }> = {
  en: { operation: 'Operation', stage: 'Stage', reason: 'Reason', failureKind: 'Native error kind', upstreamStatus: 'HTTP status', upstreamCode: 'LINE response code', recovery: 'Recovery', reference: 'Reference', legacy: 'Diagnostic detail was not recorded.' },
  'zh-TW': { operation: '操作', stage: '階段', reason: '原因', failureKind: 'LINEJS 錯誤類型', upstreamStatus: 'HTTP 狀態碼', upstreamCode: 'LINE 回應碼', recovery: '處理方式', reference: '紀錄編號', legacy: '當時未記錄詳細診斷資訊。' },
  ja: { operation: '操作', stage: '段階', reason: '理由', failureKind: 'LINEJS エラー種別', upstreamStatus: 'HTTP ステータス', upstreamCode: 'LINE 応答コード', recovery: '対処', reference: '参照番号', legacy: '詳細な診断情報は記録されていません。' },
  ko: { operation: '작업', stage: '단계', reason: '원인', failureKind: 'LINEJS 오류 종류', upstreamStatus: 'HTTP 상태', upstreamCode: 'LINE 응답 코드', recovery: '복구 방법', reference: '참조', legacy: '진단 세부 정보가 기록되지 않았습니다.' },
};
export function diagnosticRecovery(locale: Locale, diagnostic: SafeDiagnostic): string { return recovery[locale][diagnostic.recovery]; }
