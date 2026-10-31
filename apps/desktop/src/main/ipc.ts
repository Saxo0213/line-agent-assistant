import { IpcRequestSchema, IpcResultSchema, type IpcResult } from '@line-agent/contracts';
import { randomUUID } from 'node:crypto';
import type { DesktopServiceFacade } from './service-facade.js';
import { diagnosticFailure, type SafeDiagnostic } from '@line-agent/contracts';
import { DesktopReadRequestSchema, DesktopReadResultSchema } from '../desktop-protocol.js';

type Sender = { senderId: number; url: string };
type IpcFacade = Pick<DesktopServiceFacade, 'dispatch'> & Partial<Pick<DesktopServiceFacade, 'openAttachment' | 'downloadAttachment'>>;
const RESOURCE_REQUEST_TYPES = new Set(['listChatNotes', 'getChatNote', 'listChatAlbums', 'listChatAlbumPhotos', 'downloadChatAlbumPhoto', 'openChatAlbum', 'openReadableChatAlbumFolder']);
const MAX_ACTIVE_CHAT_RESOURCE_REQUESTS = 32;
type AdapterOptions = { webContentsId: number; rendererUrl: string; service?: IpcFacade; resolveService?: () => IpcFacade;
  onDiagnostic?: (diagnostic: SafeDiagnostic, identity?: import('@line-agent/contracts').DiagnosticIdentity) => void;
  resolveFileTypeIcon?: (extension: string) => Promise<string | null>; openExternalUrl?: (url: string) => Promise<void> };

function canonicalExternalUrl(value: string): string | null {
  if (value.length > 8192 || /[\u0000-\u001f\u007f-\u009f]/.test(value)) return null;
  try {
    const url = new URL(value);
    if ((url.protocol !== 'http:' && url.protocol !== 'https:') || !url.hostname || url.username || url.password) return null;
    return url.href;
  } catch {
    return null;
  }
}

export function createIpcAdapter(options: AdapterOptions) {
  const activeChatResourceRequests = new Map<string, AbortController>();
  return async (sender: Sender, payload: unknown): Promise<IpcResult> => {
    const requestId = typeof payload === 'object' && payload !== null && 'requestId' in payload && typeof payload.requestId === 'string' ? payload.requestId : 'invalid';
    const fail = (code: string, message: string): IpcResult => ({ type: 'error', requestId, ok: false, code, message, retryable: false });
    if (sender.senderId !== options.webContentsId || sender.url !== options.rendererUrl) return fail('UNTRUSTED_SENDER', 'Renderer identity mismatch');
    const parsed = IpcRequestSchema.safeParse(payload);
    if (!parsed.success) return fail('INVALID_REQUEST', 'Invalid IPC request');
    const identity = { requestId, ...('accountId' in parsed.data ? { accountId: parsed.data.accountId } : {}) };
    if (parsed.data.type === 'reportRendererFailure') {
      try { options.onDiagnostic?.({ operation: 'renderer', stage: 'execute', category: 'unknown', recovery: 'reopen_app' }, identity); }
      catch { /* A renderer fault must not make diagnostic delivery fail recursively. */ }
      return { type: 'accepted', requestId, ok: true };
    }
    if (parsed.data.type === 'cancelChatResourceRequest') {
      const active = activeChatResourceRequests.get(`${sender.senderId}\0${parsed.data.targetRequestId}`);
      const cancelled = Boolean(active && !active.signal.aborted);
      if (cancelled) active!.abort(new Error('Chat resource request cancelled.'));
      return { type: 'cancelChatResourceRequest', requestId, ok: true, cancelled };
    }
    if (parsed.data.type === 'openExternalUrl') {
      const url = canonicalExternalUrl(parsed.data.url);
      if (!url) return fail('INVALID_URL', 'Only absolute HTTP or HTTPS URLs without credentials are allowed');
      if (!options.openExternalUrl) return fail('SERVICE_UNAVAILABLE', 'External browser unavailable');
      try {
        await options.openExternalUrl(url);
        return { type: 'openExternalUrl', requestId, ok: true };
      } catch (error) {
        try { options.onDiagnostic?.(diagnosticFailure('ipc', 'execute', error), identity); } catch { /* observer only */ }
        return fail('SERVICE_UNAVAILABLE', 'External browser unavailable');
      }
    }
    if (parsed.data.type === 'openAttachment' && !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(parsed.data.attachmentId)) return fail('INVALID_ATTACHMENT_ID', 'Attachment ID must be UUID');
    if (parsed.data.type === 'downloadAttachment' && !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(parsed.data.attachmentId)) return fail('INVALID_ATTACHMENT_ID', 'Attachment ID must be UUID');
    let resourceSignal: AbortSignal | undefined;
    try {
      if (parsed.data.type === 'resolveFileTypeIcon') return { type: 'resolveFileTypeIcon', requestId, ok: true,
        dataUrl: await options.resolveFileTypeIcon?.(parsed.data.extension) ?? null };
      const service = options.resolveService?.() ?? options.service;
      if (!service) return fail('SERVICE_UNAVAILABLE', 'Service unavailable');
      if (parsed.data.type === 'openAttachment') {
        if (!service.openAttachment) return fail('SERVICE_UNAVAILABLE', 'Attachment service unavailable');
        return { type: 'openAttachment', requestId, ok: true, opened: await service.openAttachment(parsed.data.attachmentId, sender.senderId) };
      }
      if (parsed.data.type === 'downloadAttachment') {
        if (!service.downloadAttachment) return fail('SERVICE_UNAVAILABLE', 'Attachment service unavailable');
        if (!await service.downloadAttachment({ accountId: parsed.data.accountId, chatType: parsed.data.chatType,
          chatId: parsed.data.chatId }, parsed.data.attachmentId)) return fail('DOWNLOAD_NOT_AVAILABLE', 'Attachment download is not available for this conversation.');
        return { type: 'accepted', requestId, ok: true };
      }
      let response: IpcResult;
      if (RESOURCE_REQUEST_TYPES.has(parsed.data.type)) {
        if (activeChatResourceRequests.size >= MAX_ACTIVE_CHAT_RESOURCE_REQUESTS) return fail('SERVICE_BUSY', 'Too many active chat resource requests');
        const controller = new AbortController();
        resourceSignal = controller.signal;
        const key = `${sender.senderId}\0${parsed.data.requestId}`;
        if (activeChatResourceRequests.has(key)) return fail('INVALID_REQUEST', 'Duplicate active request ID');
        activeChatResourceRequests.set(key, controller);
        try { response = await service.dispatch(parsed.data, controller.signal); }
        finally { activeChatResourceRequests.delete(key); }
      } else response = await service.dispatch(parsed.data);
      const result = IpcResultSchema.safeParse(response);
      const responseTypeMatches = result.success && (
        result.data.type === parsed.data.type || result.data.type === 'accepted' || result.data.type === 'error'
        || (parsed.data.type === 'lineBeginAdminPairing' && result.data.type === 'lineAdminPairing')
      );
      if (!result.success || result.data.requestId !== parsed.data.requestId || !responseTypeMatches) return fail('INVALID_SERVICE_RESPONSE', 'Service returned invalid response');
      return result.data;
    } catch (error) {
      if (resourceSignal?.aborted && (error === resourceSignal.reason || (error instanceof Error && error.name === 'AbortError')))
        return fail('CANCELLED', 'Chat resource request cancelled');
      try { options.onDiagnostic?.(diagnosticFailure('ipc', 'execute', error), identity); } catch { /* Observation cannot escape IPC. */ }
      return fail('SERVICE_UNAVAILABLE', 'Service unavailable');
    }
  };
}

type ReadFacade = Pick<DesktopServiceFacade, 'listMessages' | 'listAttachmentStates' | 'listAgentStatuses' | 'listWorkRecords' | 'controlState'>
  & Partial<Pick<DesktopServiceFacade, 'listStoredAttachments'>>
  & Partial<Pick<DesktopServiceFacade, 'listFriends' | 'listMessageReaders'>>
  & Partial<Pick<DesktopServiceFacade, 'listSystemActivity' | 'listSystemErrors'>>;
export function createReadAdapter(options: { webContentsId: number; rendererUrl: string; service?: ReadFacade; resolveService?: () => ReadFacade;
  onDiagnostic?: (diagnostic: SafeDiagnostic, identity?: import('@line-agent/contracts').DiagnosticIdentity) => void }) {
  return async (sender: Sender, payload: unknown) => {
    if (sender.senderId !== options.webContentsId || sender.url !== options.rendererUrl) throw new Error('Untrusted renderer');
    const request = DesktopReadRequestSchema.parse(payload);
    const correlationId = randomUUID();
    try {
    const service = options.resolveService?.() ?? options.service;
    if (!service) throw new Error('Service unavailable');
    let result: unknown;
    if (request.type === 'listMessages') result = { type: 'listMessages', page: await service.listMessages(request.key, request.cursor, request.limit, request.messageId) };
    else if (request.type === 'listAttachmentStates') result = { type: 'listAttachmentStates', attachments: await service.listAttachmentStates(request.key, request.attachmentIds) };
    else if (request.type === 'listStoredAttachments') result = { type: 'listStoredAttachments', page: service.listStoredAttachments
      ? await service.listStoredAttachments(request.key, request.cursor, request.limit) : { attachments: [], nextCursor: null } };
    else if (request.type === 'listAgentStatuses') result = { type: 'listAgentStatuses', statuses: await service.listAgentStatuses(request.key, request.messageIds) };
    else if (request.type === 'listWorkRecords') result = { type: 'listWorkRecords', records: await service.listWorkRecords() };
    else if (request.type === 'listFriends') result = { type: 'listFriends', friends: service.listFriends ? await service.listFriends(request.accountId) : [] };
    else if (request.type === 'listMessageReaders') result = { type: 'listMessageReaders', ...(service.listMessageReaders ? await service.listMessageReaders(request.key, request.messageId) : { readers: [] }) };
    else if (request.type === 'listSystemActivity') {
      if (!service.listSystemActivity) throw new Error('System activity unavailable');
      result = { type: 'listSystemActivity', ...await service.listSystemActivity() };
    } else if (request.type === 'listSystemErrors') {
      if (!service.listSystemErrors) throw new Error('System errors unavailable');
      result = { type: 'listSystemErrors', ...await service.listSystemErrors() };
    }
    else result = { type: 'getControlState', state: await service.controlState() };
    return DesktopReadResultSchema.parse(result);
    } catch (error) {
      try { options.onDiagnostic?.(diagnosticFailure('ipc', 'read', error), { correlationId }); } catch { /* Observation cannot escape IPC. */ }
      throw new Error('Service read failed. See System Errors for diagnostic details.');
    }
  };
}
