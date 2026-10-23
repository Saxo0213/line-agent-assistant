import { afterEach, describe, expect, it, vi } from 'vitest';
import { McpHttpServer } from './mcp-http-server.js';

describe('McpHttpServer cancellation', () => {
  let server: McpHttpServer | undefined;

  afterEach(async () => {
    await server?.shutdown();
    server = undefined;
  });

  function createHangingService() {
    let requestSignal: AbortSignal | undefined;
    const service = {
      handleExternalJsonRpc: vi.fn((_token: string | null, _payload: unknown, signal?: AbortSignal) => {
        requestSignal = signal;
        return new Promise<never>((_resolve, reject) => {
          signal?.addEventListener('abort', () => reject(new Error('cancelled')), { once: true });
        });
      }),
    };
    return { service, requestSignal: () => requestSignal };
  }

  it('aborts service work when the HTTP client disconnects', async () => {
    const { service, requestSignal } = createHangingService();
    server = new McpHttpServer(service as never, { port: 0 });
    await server.start();
    const controller = new AbortController();
    const pending = fetch(server.status().endpoint!, {
      method: 'POST',
      signal: controller.signal,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' }),
    });
    await vi.waitFor(() => expect(requestSignal()).toBeDefined());
    controller.abort();
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    await vi.waitFor(() => expect(requestSignal()?.aborted).toBe(true));
  });

  it('aborts service work and closes sockets during shutdown', async () => {
    const { service, requestSignal } = createHangingService();
    server = new McpHttpServer(service as never, { port: 0 });
    await server.start();
    const pending = fetch(server.status().endpoint!, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' }),
    }).catch(() => undefined);
    await vi.waitFor(() => expect(requestSignal()).toBeDefined());
    await server.shutdown();
    await pending;
    expect(requestSignal()?.aborted).toBe(true);
  });
});
