import { request as httpRequest } from 'node:http';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { McpHttpServer } from './mcp-http-server.js';
import { McpService } from './mcp-service.js';

describe('McpHttpServer cancellation', () => {
  let server: McpHttpServer | undefined;

  afterEach(async () => {
    await server?.shutdown();
    server = undefined;
  });

  function createHangingService() {
    let requestSignal: AbortSignal | undefined;
    const service = {
      handleExternalJsonRpc: vi.fn((_payload: unknown, signal?: AbortSignal) => {
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

const OK = { httpStatus: 200, body: { jsonrpc: '2.0', id: 1, result: {} } };

/** node:http lets the test set Host and Origin exactly, which fetch does not. */
function rawPost(url: string, headers: Record<string, string>, body = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' })): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const target = new URL(url);
    const req = httpRequest({ host: target.hostname, port: target.port, path: target.pathname, method: 'POST',
      headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body), ...headers } }, (res) => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', (chunk: string) => { text += chunk; });
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body: text }));
    });
    req.on('error', reject);
    req.end(body);
  });
}

describe('McpHttpServer request guard and routing', () => {
  let server: McpHttpServer | undefined;
  afterEach(async () => { await server?.shutdown(); server = undefined; });

  function create() {
    const service = {
      handleExternalJsonRpc: vi.fn(async (..._args: unknown[]) => OK),
      handleInternalJsonRpc: vi.fn(async (..._args: unknown[]) => OK),
    };
    server = new McpHttpServer(service as never, { port: 0 });
    return service;
  }

  it('refuses any request with an Origin header and never calls the service', async () => {
    const service = create();
    await server!.start();
    const endpoint = server!.status().endpoint!;
    for (const headers of [
      { origin: 'https://evil.example' },
      { origin: 'null' },
      { origin: 'http://127.0.0.1', authorization: 'Bearer la_mcp_x' },
      { origin: 'http://localhost', authorization: 'Bearer li_job_x' },
    ]) {
      const response = await rawPost(endpoint, headers);
      expect(response.status).toBe(403);
      expect(JSON.parse(response.body)).toMatchObject({ jsonrpc: '2.0', error: { code: -32600 } });
    }
    expect(service.handleExternalJsonRpc).not.toHaveBeenCalled();
    expect(service.handleInternalJsonRpc).not.toHaveBeenCalled();
  });

  it('refuses a wrong Host header (DNS rebinding) and accepts 127.0.0.1 and localhost on the bound port', async () => {
    const service = create();
    await server!.start();
    const endpoint = server!.status().endpoint!;
    const port = server!.status().port!;
    for (const host of [`evil.example:${port}`, 'evil.example', `127.0.0.1:${port + 1}`, '127.0.0.1', `localhost:${port + 1}`, `127.0.0.1.evil.example:${port}`]) {
      const response = await rawPost(endpoint, { host });
      expect(response.status).toBe(403);
    }
    expect(service.handleExternalJsonRpc).not.toHaveBeenCalled();
    for (const host of [`127.0.0.1:${port}`, `localhost:${port}`]) {
      expect((await rawPost(endpoint, { host })).status).toBe(200);
    }
    expect(service.handleExternalJsonRpc).toHaveBeenCalledTimes(2);
  });

  it('applies the guard to a wrong path too', async () => {
    create();
    await server!.start();
    const port = server!.status().port!;
    expect((await rawPost(`http://127.0.0.1:${port}/other`, { origin: 'https://evil.example' })).status).toBe(403);
    expect((await rawPost(`http://127.0.0.1:${port}/other`, {})).status).toBe(404);
  });

  it('sends a request without Authorization, and one with an old la_mcp_ bearer, to the external handler with no token', async () => {
    const service = create();
    await server!.start();
    const endpoint = server!.status().endpoint!;
    const payload = { jsonrpc: '2.0', id: 1, method: 'tools/list' };
    for (const authorization of [undefined, `Bearer la_mcp_${'A'.repeat(43)}`, 'Bearer something-else', 'Basic abc']) {
      const response = await fetch(endpoint, { method: 'POST',
        headers: { 'content-type': 'application/json', ...(authorization ? { authorization } : {}) }, body: JSON.stringify(payload) });
      expect(response.status).toBe(200);
    }
    expect(service.handleExternalJsonRpc).toHaveBeenCalledTimes(4);
    for (const call of service.handleExternalJsonRpc.mock.calls) {
      expect(call).toHaveLength(2);
      expect(call[0]).toEqual(payload);
      expect(call[1]).toBeInstanceOf(AbortSignal);
    }
    expect(service.handleInternalJsonRpc).not.toHaveBeenCalled();
  });

  it('sends an li_job_ bearer to the internal handler only', async () => {
    const service = create();
    await server!.start();
    const token = `li_job_${'T'.repeat(43)}`;
    const response = await fetch(server!.status().endpoint!, { method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }) });
    expect(response.status).toBe(200);
    expect(service.handleInternalJsonRpc).toHaveBeenCalledWith(token, server!.endpointInstance, expect.anything(), expect.any(AbortSignal));
    expect(service.handleExternalJsonRpc).not.toHaveBeenCalled();
  });

  it('rejects an invalid li_job_ token with 401 through the real service and never serves it as external', async () => {
    const recordAudit = vi.fn(async (..._args: unknown[]) => undefined);
    const executeLocalClientRead = vi.fn();
    const service = new McpService({ pool: {} as never, tokens: { recordAudit, executeLocalClientRead } as never, messages: {} as never });
    server = new McpHttpServer(service, { port: 0 });
    await server.start();
    const response = await fetch(server.status().endpoint!, { method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer li_job_${'A'.repeat(43)}` },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }) });
    expect(response.status).toBe(401);
    expect(recordAudit).toHaveBeenCalledWith(expect.objectContaining({ action: 'AUTH_REJECTED', disposition: 'AUTH_INVALID', tokenId: null }));
    expect(executeLocalClientRead).not.toHaveBeenCalled();
    await service.shutdown();
  });
});
