import { randomBytes } from 'node:crypto';
import {
  PREVIEW_CSP,
  createPreviewWindowOptions,
  isAllowedPreviewNavigation,
  type PreviewCapability,
  type PreviewPresenter,
  type PreviewResource,
} from './attachment-preview.js';

type Handler = (request: Request) => Response | Promise<Response>;

type PreviewSession = {
  protocol: { handle(scheme: string, handler: Handler): void; unhandle(scheme: string): void };
  setPermissionRequestHandler(handler: (_contents: unknown, _permission: unknown, callback: (allowed: boolean) => void) => void): void;
  setPermissionCheckHandler(handler: () => boolean): void;
};

type PreviewWebContents = {
  id: number;
  on(name: string, listener: (...args: any[]) => void): void;
  setWindowOpenHandler(handler: () => { action: 'deny' }): void;
};

type PreviewWindow = {
  webContents: PreviewWebContents;
  loadURL(url: string): Promise<unknown>;
  once(name: string, listener: (...args: any[]) => void): void;
  on(name: string, listener: (...args: any[]) => void): void;
  show(): void;
  focus(): void;
  close(): void;
};

export type ElectronPreviewDependencies<TSession extends PreviewSession = PreviewSession> = {
  createSession(partition: string): TSession;
  createWindow(options: ReturnType<typeof createPreviewWindowOptions> & { webPreferences: ReturnType<typeof createPreviewWindowOptions>['webPreferences'] & { session: TSession } }): PreviewWindow;
  reportError?(error: unknown): void;
};

function denied(status: number): Response {
  return new Response(null, { status, headers: { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' } });
}

type ByteRange = { start: number; end: number };

function parseByteRange(value: string, length: number): ByteRange | null {
  const match = /^bytes=(\d*)-(\d*)$/.exec(value.trim());
  if (!match || (match[1] === '' && match[2] === '')) return null;
  if (match[1] === '') {
    const suffix = Number(match[2]);
    if (!Number.isSafeInteger(suffix) || suffix <= 0) return null;
    return { start: Math.max(0, length - suffix), end: length - 1 };
  }
  const start = Number(match[1]);
  const requestedEnd = match[2] === '' ? length - 1 : Number(match[2]);
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(requestedEnd) || start < 0 || start >= length || requestedEnd < start) return null;
  return { start, end: Math.min(requestedEnd, length - 1) };
}

function contentResponse(protocolRequest: Request, payload: NonNullable<ReturnType<PreviewResource['read']>>): Response {
  const rangeHeader = protocolRequest.headers.get('range');
  const range = rangeHeader === null ? undefined : parseByteRange(rangeHeader, payload.bytes.byteLength);
  const common: Record<string, string> = {
    'Content-Type': payload.mimeType,
    'Content-Security-Policy': PREVIEW_CSP,
    'X-Content-Type-Options': 'nosniff',
    'Cache-Control': 'no-store, max-age=0',
    'Cross-Origin-Resource-Policy': 'same-origin',
    'Content-Disposition': 'inline',
    'Accept-Ranges': 'bytes',
  };
  if (rangeHeader !== null && !range) {
    return new Response(null, { status: 416, headers: { ...common, 'Content-Range': `bytes */${payload.bytes.byteLength}`, 'Content-Length': '0' } });
  }
  const selected = range ? payload.bytes.subarray(range.start, range.end + 1) : payload.bytes;
  const headers = { ...common, 'Content-Length': String(selected.byteLength), ...(range ? { 'Content-Range': `bytes ${range.start}-${range.end}/${payload.bytes.byteLength}` } : {}) };
  return new Response(protocolRequest.method === 'HEAD' ? null : Uint8Array.from(selected), { status: range ? 206 : 200, headers });
}

export function createElectronPreviewPresenter<TSession extends PreviewSession>(dependencies: ElectronPreviewDependencies<TSession>): PreviewPresenter {
  const windows = new Set<PreviewWindow>();

  return {
    async present(request) {
      const previewSession = dependencies.createSession(`preview-${randomBytes(24).toString('base64url')}`);
      previewSession.setPermissionRequestHandler((_contents: unknown, _permission: unknown, callback: (allowed: boolean) => void) => callback(false));
      previewSession.setPermissionCheckHandler(() => false);
      const base = createPreviewWindowOptions();
      const window = dependencies.createWindow({ ...base, webPreferences: { ...base.webPreferences, session: previewSession } });
      let capability: PreviewCapability | undefined;
      let resource: PreviewResource | null = null;
      let initialUrl = '';
      let servedInitialResource = false;
      let closed = false;
      const cleanup = () => {
        if (closed) return;
        closed = true;
        resource?.close();
        capability?.close();
        try { previewSession.protocol.unhandle('line-preview'); } catch { /* session may already be destroyed */ }
        windows.delete(window);
      };

      windows.add(window);
      window.on('closed', cleanup);
      try {
        capability = request.issueCapability(window.webContents.id);
        initialUrl = capability.url;
        previewSession.protocol.handle('line-preview', (protocolRequest) => {
          if (protocolRequest.url !== initialUrl) return denied(404);
          if (protocolRequest.method !== 'GET' && protocolRequest.method !== 'HEAD') return new Response(null, { status: 405, headers: { Allow: 'GET, HEAD' } });
          resource ??= capability!.activate();
          const payload = resource?.read();
          if (!payload) return denied(410);
          const response = contentResponse(protocolRequest, payload);
          if (response.status < 400) servedInitialResource = true;
          return response;
        });
        window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
        window.webContents.on('will-navigate', (event: { preventDefault(): void }, target: string) => {
          if (!isAllowedPreviewNavigation(target, initialUrl)) event.preventDefault();
        });
        window.webContents.on('will-attach-webview', (event: { preventDefault(): void }) => event.preventDefault());
        window.once('ready-to-show', () => { window.show(); window.focus(); });
        await window.loadURL(initialUrl);
        return true;
      } catch (error) {
        if (servedInitialResource && typeof error === 'object' && error !== null && 'code' in error && error.code === 'ERR_FAILED') return true;
        dependencies.reportError?.(error);
        cleanup();
        try { window.close(); } catch { /* window may already be gone */ }
        return false;
      }
    },
    closeAll() {
      for (const window of [...windows]) window.close();
    },
  };
}
