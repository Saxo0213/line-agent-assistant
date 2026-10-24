import { DatabaseSetupRequestSchema, DatabaseSetupResultSchema, type DatabaseSetupResult, type EmbeddedConnectionInfo } from '../setup-protocol.js';
import type { DatabaseSetupService } from './services/database-setup.js';
import { EMBEDDED_PG_MESSAGES, isEmbeddedPgError } from './services/embedded-postgres/errors.js';
import { diagnosticFailure, type SafeDiagnostic } from '@line-agent/contracts';

/** Main-side owner of the embedded PostgreSQL wizard flow; progress events are pushed by its implementation. */
export type EmbeddedSetupPort = { start(): Promise<void>; cancel(): void; connectionInfo(): Promise<EmbeddedConnectionInfo>;
  changePassword(password: string): Promise<void> };

type Sender = { senderId: number; url: string };
type AttachmentRootChange = { prepare(): Promise<{ id: string; path: string } | null>; move(id: string): Promise<string>; openCurrent(): Promise<void> };

export function createSetupCutover(options: { isConnected(): boolean; fence(): void; shutdown(): Promise<void>; timeoutMs?: number }) {
  let inFlight = false;
  let shutdownFailed = false;
  return {
    async save<T>(save: () => Promise<T>): Promise<T> {
      if (shutdownFailed) throw new Error('Setup cutover is unavailable after shutdown failure');
      if (inFlight) throw new Error('Setup cutover already in progress');
      inFlight = true;
      try {
        if (options.isConnected()) {
          options.fence();
          let timer:ReturnType<typeof setTimeout>|undefined;
          try { await Promise.race([options.shutdown(),new Promise<never>((_resolve,reject)=>{
            timer=setTimeout(()=>reject(new Error('Setup cutover shutdown timed out')),options.timeoutMs ?? 30_000);
          })]); }
          catch (cause) { shutdownFailed = true; throw cause; }
          finally {if(timer) clearTimeout(timer);}
        }
        return await save();
      } finally { inFlight = false; }
    },
  };
}

export function createSetupAdapter(options: { webContentsId: number; rendererUrl: string; setup: DatabaseSetupService;
  onDiagnostic?: (diagnostic: SafeDiagnostic) => void;
  chooseAttachmentRoot(): Promise<string | null>; chooseAgentWorkspace(): Promise<string | null>; restartApplication(): Promise<void> | void;
  runSetupSave?: (save: () => Promise<void>) => Promise<void>; attachmentRootChange?: AttachmentRootChange; embedded?: EmbeddedSetupPort }) {
  return async (sender: Sender, payload: unknown): Promise<DatabaseSetupResult> => {
    const requestId = typeof payload === 'object' && payload !== null && 'requestId' in payload && typeof payload.requestId === 'string'
      ? payload.requestId : 'invalid';
    const error = (message: string, restartRequired = false): DatabaseSetupResult => ({ type: 'error', requestId, ok: false, message, ...(restartRequired ? { restartRequired: true } : {}) });
    if (sender.senderId !== options.webContentsId || sender.url !== options.rendererUrl) return error('Renderer identity mismatch');
    const parsed = DatabaseSetupRequestSchema.safeParse(payload);
    if (!parsed.success) return error('資料庫設定內容無效。');
    const request = parsed.data;
    try {
      let result: DatabaseSetupResult;
      if (request.type === 'getDatabaseSetupStatus') result = { type: request.type, requestId, ok: true, status: await options.setup.status() };
      else if (request.type === 'listDatabases') result = { type: request.type, requestId, ok: true, databases: await options.setup.listDatabases(request.connection) };
      else if (request.type === 'createDatabase') result = { type: request.type, requestId, ok: true, databases: await options.setup.createDatabase(request.connection, request.database) };
      else if (request.type === 'chooseAttachmentRoot') result = { type: request.type, requestId, ok: true, path: await options.chooseAttachmentRoot() };
      else if (request.type === 'prepareAttachmentRootChange') {
        if (!options.attachmentRootChange) throw new Error('Attachment folder change unavailable');
        const selection = await options.attachmentRootChange.prepare();
        result = { type: request.type, requestId, ok: true, selection };
      } else if (request.type === 'moveAttachmentRoot') {
        if (!options.attachmentRootChange) throw new Error('Attachment folder change unavailable');
        const path = await options.attachmentRootChange.move(request.selectionId);
        result = { type: request.type, requestId, ok: true, saved: true, restartRequired: true, path, sourceRetained: true };
      } else if (request.type === 'openAttachmentRoot') {
        if (!options.attachmentRootChange) throw new Error('Attachment folder access unavailable');
        await options.attachmentRootChange.openCurrent(); result = { type: request.type, requestId, ok: true };
      }
      else if (request.type === 'chooseAgentWorkspace') result = { type: request.type, requestId, ok: true, path: await options.chooseAgentWorkspace() };
      else if (request.type === 'saveDatabaseSetup') {
        const save = () => options.setup.saveConfiguration(request.connection, request.database, request.attachmentRoot, request.agentWorkspace);
        await (options.runSetupSave ?? ((operation) => operation()))(save);
        result = { type: request.type, requestId, ok: true, saved: true, restartRequired: true };
      } else if (request.type === 'startEmbeddedProvision') {
        if (!options.embedded) throw new Error('Embedded PostgreSQL unavailable');
        await options.embedded.start(); result = { type: request.type, requestId, ok: true };
      } else if (request.type === 'cancelEmbeddedProvision') {
        options.embedded?.cancel(); result = { type: request.type, requestId, ok: true };
      } else if (request.type === 'getEmbeddedConnectionInfo') {
        if (!options.embedded) throw new Error('Embedded PostgreSQL unavailable');
        result = { type: request.type, requestId, ok: true, info: await options.embedded.connectionInfo() };
      } else if (request.type === 'changeEmbeddedPassword') {
        if (!options.embedded) throw new Error('Embedded PostgreSQL unavailable');
        await options.embedded.changePassword(request.password); result = { type: request.type, requestId, ok: true };
      } else if (request.type === 'saveEmbeddedSetup') {
        const save = () => options.setup.saveEmbeddedConfiguration(request.attachmentRoot, request.agentWorkspace);
        await (options.runSetupSave ?? ((operation) => operation()))(save);
        result = { type: request.type, requestId, ok: true, saved: true, restartRequired: true };
      } else {
        await options.restartApplication(); result = { type: request.type, requestId, ok: true };
      }
      return DatabaseSetupResultSchema.parse(result);
    } catch (cause) {
      try { options.onDiagnostic?.(diagnosticFailure('database', 'prepare', cause)); } catch { /* Setup result remains authoritative. */ }
      if (isEmbeddedPgError(cause)) return { type: 'error', requestId, ok: false, message: EMBEDDED_PG_MESSAGES[cause.code], errorCode: cause.code };
      const code = typeof cause === 'object' && cause !== null && 'code' in cause ? String(cause.code) : '';
      if (code === 'INVALID_WORKSPACE') return error('Select an existing absolute workspace directory in Settings → Agent.');
      if (code === '28P01') return error('PostgreSQL 帳號或密碼錯誤。');
      if (code === '3D000') return error('指定的資料庫不存在。');
      if (code === '42P04') return error('同名資料庫已存在，請重新讀取清單。');
      if (code === 'ECONNREFUSED') return error('無法連線 PostgreSQL，請確認主機、Port 與服務狀態。');
      if (cause instanceof Error && cause.message === 'Invalid database name') return error('資料庫名稱格式無效。');
      if (cause instanceof Error && cause.message === 'Managed folders must be absolute paths') return error('附件與 Agent 工作目錄必須是絕對路徑。');
      return error('資料庫操作失敗，請檢查連線設定與伺服器權限。', request.type === 'moveAttachmentRoot');
    }
  };
}
