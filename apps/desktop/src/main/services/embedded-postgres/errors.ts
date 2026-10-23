export const EMBEDDED_PG_CODES = ['vc_runtime_missing', 'pg_download_failed', 'pg_download_timeout', 'pg_download_cancelled', 'pg_hash_mismatch',
  'pg_extract_failed', 'pg_path_unsupported', 'pg_acl_failed', 'pg_data_conflict', 'pg_initdb_failed', 'pg_port_unavailable', 'pg_port_in_use',
  'pg_start_failed', 'pg_stop_timeout', 'pg_not_embedded', 'pg_password_invalid', 'pg_password_change_failed', 'pg_password_save_failed'] as const;
export type EmbeddedPgCode = (typeof EMBEDDED_PG_CODES)[number];

export const EMBEDDED_PG_MESSAGES: Readonly<Record<EmbeddedPgCode, string>> = Object.freeze({
  vc_runtime_missing: '需要 Microsoft Visual C++ 執行環境，請安裝後按「重新檢查」。',
  pg_download_failed: '下載資料庫檔案失敗，請檢查網路後重試。',
  pg_download_timeout: '下載資料庫檔案逾時，請檢查網路後重試。',
  pg_download_cancelled: '已取消下載。',
  pg_hash_mismatch: '下載的檔案驗證失敗，已刪除，請重試。',
  pg_extract_failed: '解壓縮資料庫檔案失敗。',
  pg_path_unsupported: '資料庫無法使用 ProgramData 資料夾路徑。',
  pg_acl_failed: '無法設定資料庫資料夾的存取權限。',
  pg_data_conflict: '資料庫資料夾已有其他內容，為避免覆蓋已停止安裝。',
  pg_initdb_failed: '初始化資料庫失敗。',
  pg_port_unavailable: '找不到資料庫可用的本機連接埠。',
  pg_port_in_use: '資料庫需要的連接埠被其他程式占用，請關閉該程式後重試。',
  pg_start_failed: '資料庫啟動失敗。',
  pg_stop_timeout: '資料庫停止逾時。',
  pg_not_embedded: '變更密碼失敗。',
  pg_password_invalid: '密碼需為 8–128 個字元。',
  pg_password_change_failed: '變更密碼失敗。',
  pg_password_save_failed: '變更密碼失敗。',
});

export class EmbeddedPgError extends Error {
  constructor(readonly code: EmbeddedPgCode, readonly detail?: string) {
    super(`${EMBEDDED_PG_MESSAGES[code]}（${code}）`);
    this.name = 'EmbeddedPgError';
  }
}

export function isEmbeddedPgError(value: unknown): value is EmbeddedPgError {
  return value instanceof EmbeddedPgError;
}
