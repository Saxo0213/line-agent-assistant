import { describe, expect, it } from 'vitest';
import { PREVIEW_CSP, type PreviewPayload } from './attachment-preview.js';
import { createElectronPreviewPresenter } from './electron-preview-presenter.js';

describe('isolated Electron preview presenter', () => {
  it('serves only the bound capability inside a sandboxed one-window session', async () => {
    let protocolHandler: ((request: Request) => Response | Promise<Response>) | undefined;
    let options: Record<string, unknown> | undefined;
    let loaded = '';
    let closed = 0;
    const events = new Map<string, (...args: unknown[]) => void>();
    const webEvents = new Map<string, (...args: unknown[]) => void>();
    const session = {
      protocol: { handle(scheme: string, handler: typeof protocolHandler) { expect(scheme).toBe('line-preview'); protocolHandler = handler; }, unhandle() {} },
      setPermissionRequestHandler(_handler: unknown) {},
      setPermissionCheckHandler(_handler: unknown) {},
    };
    const window = {
      webContents: {
        id: 73,
        on(name: string, listener: (...args: unknown[]) => void) { webEvents.set(name, listener); },
        setWindowOpenHandler(handler: () => { action: string }) { expect(handler()).toEqual({ action: 'deny' }); },
      },
      async loadURL(url: string) { loaded = url; },
      once(name: string, listener: (...args: unknown[]) => void) { events.set(name, listener); },
      on(name: string, listener: (...args: unknown[]) => void) { events.set(name, listener); },
      show() {}, focus() {}, close() {},
    };
    const presenter = createElectronPreviewPresenter({
      createSession: () => session,
      createWindow(value) { options = value as unknown as Record<string, unknown>; return window; },
    });
    const payload: PreviewPayload = { displayName: 'photo.png', mimeType: 'image/png', renderer: 'image', bytes: Buffer.from([137, 80, 78, 71]) };
    let activated = 0;
    let revoked = 0;

    await expect(presenter.present({
      displayName: payload.displayName,
      mimeType: payload.mimeType,
      renderer: payload.renderer,
      byteLength: payload.bytes.byteLength,
      issueCapability(viewerId) {
        expect(viewerId).toBe(73);
        return {
          token: 'A'.repeat(43), sessionId: 'session', url: `line-preview://content/${'A'.repeat(43)}`,
          activate: () => { activated++; return activated === 1 ? { read: () => payload, close: () => {} } : null; },
          close: () => { revoked++; },
        };
      },
    })).resolves.toBe(true);

    expect(options).toMatchObject({ webPreferences: { session, sandbox: true, contextIsolation: true, nodeIntegration: false, webSecurity: true, devTools: false } });
    expect(loaded).toBe(`line-preview://content/${'A'.repeat(43)}`);
    expect(protocolHandler).toBeDefined();
    expect((await protocolHandler!(new Request('line-preview://content/wrong'))).status).toBe(404);
    const response = await protocolHandler!(new Request(loaded));
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('image/png');
    expect(response.headers.get('content-security-policy')).toBe(PREVIEW_CSP);
    expect(response.headers.get('x-content-type-options')).toBe('nosniff');
    expect(Buffer.from(await response.arrayBuffer())).toEqual(payload.bytes);
    const ranged = await protocolHandler!(new Request(loaded, { headers: { Range: 'bytes=1-2' } }));
    expect(ranged.status).toBe(206);
    expect(ranged.headers.get('content-range')).toBe(`bytes 1-2/${payload.bytes.byteLength}`);
    expect(ranged.headers.get('accept-ranges')).toBe('bytes');
    expect(Buffer.from(await ranged.arrayBuffer())).toEqual(payload.bytes.subarray(1, 3));
    const head = await protocolHandler!(new Request(loaded, { method: 'HEAD', headers: { Range: 'bytes=2-' } }));
    expect(head.status).toBe(206);
    expect(head.headers.get('content-length')).toBe(String(payload.bytes.byteLength - 2));
    expect((await head.arrayBuffer()).byteLength).toBe(0);
    const unsatisfiable = await protocolHandler!(new Request(loaded, { headers: { Range: 'bytes=999-' } }));
    expect(unsatisfiable.status).toBe(416);
    expect(unsatisfiable.headers.get('content-range')).toBe(`bytes */${payload.bytes.byteLength}`);

    let prevented = false;
    webEvents.get('will-navigate')?.({ preventDefault() { prevented = true; } }, 'https://evil.example');
    expect(prevented).toBe(true);
    events.get('closed')?.();
    expect(revoked).toBe(1);
    presenter.closeAll();
  });

  it('revokes and closes when isolated protocol setup fails', async () => {
    let revoked = 0;
    let closed = 0;
    const presenter = createElectronPreviewPresenter({
      createSession: () => ({
        protocol: { handle() { throw new Error('protocol unavailable'); }, unhandle() {} },
        setPermissionRequestHandler() {}, setPermissionCheckHandler() {},
      }),
      createWindow: () => ({
        webContents: { id: 9, on() {}, setWindowOpenHandler() {} },
        async loadURL() {}, once() {}, on() {}, show() {}, focus() {}, close() { closed++; },
      }),
    });
    await expect(presenter.present({
      displayName: 'invoice.pdf', mimeType: 'application/pdf', renderer: 'pdf', byteLength: 8,
      issueCapability: () => ({ token: 'B'.repeat(43), sessionId: 's', url: `line-preview://content/${'B'.repeat(43)}`, activate: () => null, close: () => { revoked++; } }),
    })).resolves.toBe(false);
    expect({ revoked, closed }).toEqual({ revoked: 1, closed: 1 });
  });
});
