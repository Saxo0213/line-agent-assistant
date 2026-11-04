import { spawn, type ChildProcess } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { requestTimeoutMs, runBridge, SEND_REQUEST_TIMEOUT_MS } from './index.js';

const bridgePath = path.resolve(import.meta.dirname, '../../dist/mcp-stdio-bridge.js');
const children: ChildProcess[] = [];
const servers: Server[] = [];
async function listen(handler: (request: import('node:http').IncomingMessage, response: import('node:http').ServerResponse) => void): Promise<{ server: Server; url: string }> {
  const server = createServer(handler);
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Unexpected fake server address');
  return { server, url: `http://127.0.0.1:${address.port}/mcp` };
}
function launch(url: string, extraEnv: Record<string, string> = {}): ChildProcess {
  const { LINEJS_MCP_TOKEN: _ignored, ...inherited } = process.env;
  const child = spawn(process.execPath, [bridgePath], { env: { ...inherited, LINEJS_MCP_URL: url, ...extraEnv }, stdio: ['pipe', 'pipe', 'pipe'] });
  children.push(child);
  return child;
}
function readLines(child: ChildProcess): { next(): Promise<string>; all: string[] } {
  let buffer = '';
  const lines: string[] = [];
  const waiters: Array<(line: string) => void> = [];
  child.stdout!.setEncoding('utf8');
  child.stdout!.on('data', (chunk: string) => {
    buffer += chunk;
    for (;;) {
      const index = buffer.indexOf('\n');
      if (index < 0) break;
      const line = buffer.slice(0, index); buffer = buffer.slice(index + 1);
      lines.push(line); waiters.shift()?.(line);
    }
  });
  let consumed = 0;
  return { all: lines, next: () => new Promise((resolve) => { const found = lines[consumed]; if (found !== undefined) { consumed += 1; resolve(found); } else waiters.push((line) => { consumed += 1; resolve(line); }); }) };
}
async function closeChild(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null) return;
  child.stdin?.end();
  await new Promise<void>((resolve) => { if (child.exitCode !== null) resolve(); else child.once('exit', () => resolve()); });
}
afterEach(async () => {
  await Promise.all(children.splice(0).map(closeChild));
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
});

describe('stdio MCP bridge', () => {
  it('forwards initialize, tools/list, and tools/call FIFO with session headers and no Authorization header', async () => {
    const received: Array<{ body: any; authorization?: string; session?: string }> = [];
    const { url } = await listen((request, response) => {
      let body = '';
      request.setEncoding('utf8'); request.on('data', (chunk) => { body += chunk; });
      request.on('end', () => {
        const parsed = JSON.parse(body);
        const session = request.headers['mcp-session-id'];
        const authorization = request.headers.authorization;
        received.push({ body: parsed, ...(typeof authorization === 'string' ? { authorization } : {}),
          ...(typeof session === 'string' ? { session } : {}) });
        response.setHeader('Content-Type', 'application/json');
        if (parsed.method === 'initialize') response.setHeader('Mcp-Session-Id', 'session-123');
        response.end(JSON.stringify({ jsonrpc: '2.0', id: parsed.id, result: { method: parsed.method } }));
      });
    });
    const child = launch(url);
    const output = readLines(child);
    for (const [id, method] of [[1, 'initialize'], [2, 'tools/list'], [3, 'tools/call']] as const) {
      child.stdin!.write(`${JSON.stringify({ jsonrpc: '2.0', id, method })}\n`);
      expect(JSON.parse(await output.next())).toMatchObject({ id, result: { method } });
    }
    expect(received.map(({ authorization, session }) => ({ authorization, session }))).toEqual([
      { authorization: undefined, session: undefined },
      { authorization: undefined, session: 'session-123' },
      { authorization: undefined, session: 'session-123' },
    ]);
    child.stdin!.end();
    await new Promise<void>((resolve) => child.once('exit', () => resolve()));
  });

  it('starts without LINEJS_MCP_TOKEN and never sends it, even when an old config still sets it', async () => {
    const received: Array<string | undefined> = [];
    const { url } = await listen((request, response) => {
      let body = ''; request.setEncoding('utf8'); request.on('data', (chunk) => { body += chunk; }); request.on('end', () => {
        received.push(request.headers.authorization);
        response.setHeader('Content-Type', 'application/json');
        response.end(JSON.stringify({ jsonrpc: '2.0', id: JSON.parse(body).id, result: {} }));
      });
    });
    for (const extraEnv of [{}, { LINEJS_MCP_TOKEN: 'la_mcp_old-config-value' }]) {
      const child = launch(url, extraEnv);
      const output = readLines(child);
      child.stdin!.write(`${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' })}\n`);
      expect(JSON.parse(await output.next())).toMatchObject({ id: 1, result: {} });
      child.stdin!.end();
      await new Promise<void>((resolve) => child.once('exit', () => resolve()));
      expect(output.all.join('\n')).not.toContain('la_mcp_old-config-value');
    }
    expect(received).toEqual([undefined, undefined]);
  });

  it('maps HTTP failures, connection refusal, oversize input, notifications, and non-loopback URLs', async () => {
    const { server, url } = await listen((request, response) => {
      let body = ''; request.setEncoding('utf8'); request.on('data', (chunk) => { body += chunk; }); request.on('end', () => {
        const id = JSON.parse(body).id;
        response.statusCode = id === 1 ? 401 : id === 2 ? 409 : id === 3 ? 500 : 202;
        response.end('failure');
      });
    });
    const child = launch(url);
    const output = readLines(child);
    for (const [id, status] of [[1, 401], [2, 409], [3, 500]] as const) {
      child.stdin!.write(`${JSON.stringify({ jsonrpc: '2.0', id, method: 'request' })}\n`);
      expect(JSON.parse(await output.next())).toMatchObject({ id, error: { code: -32000, message: `HTTP ${status}` } });
    }
    child.stdin!.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notification' })}\n`);
    child.stdin!.write(`${JSON.stringify({ jsonrpc: '2.0', id: 8, method: 'too-large' }).slice(0, -1)}${' '.repeat(70_000)} }\n`);
    expect(JSON.parse(await output.next())).toMatchObject({ id: 8, error: { code: -32000 } });
    await new Promise<void>((resolve) => server.close(() => resolve()));
    child.stdin!.write(`${JSON.stringify({ jsonrpc: '2.0', id: 9, method: 'connection-refused' })}\n`);
    expect(JSON.parse(await output.next())).toMatchObject({ id: 9, error: { code: -32000 } });
    child.stdin!.end();
    await new Promise<void>((resolve) => child.once('exit', () => resolve()));

    const invalid = launch('http://example.com/mcp');
    const stderr = new Promise<string>((resolve) => { let text = ''; invalid.stderr!.setEncoding('utf8'); invalid.stderr!.on('data', (chunk: string) => { text += chunk; }); invalid.once('exit', () => resolve(text)); });
    await closeChild(invalid);
    expect(await stderr).toContain('127.0.0.1');
  });
});

describe('stdio MCP bridge request timeout', () => {
  const SEND_CALL_BUDGET_MS = 600_000;
  it('keeps 10 s for every request except a tools/call of send_to_target, which waits longer than the 600 s send budget', () => {
    expect(SEND_REQUEST_TIMEOUT_MS).toBeGreaterThan(SEND_CALL_BUDGET_MS);
    expect(requestTimeoutMs({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'send_to_target', arguments: {} } })).toBe(SEND_REQUEST_TIMEOUT_MS);
    for (const request of [
      { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'list_send_targets' } },
      { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'query_target_messages' } },
      { jsonrpc: '2.0', id: 1, method: 'tools/call', params: null },
      { jsonrpc: '2.0', id: 1, method: 'tools/call' },
      { jsonrpc: '2.0', id: 1, method: 'tools/list', params: { name: 'send_to_target' } },
      { jsonrpc: '2.0', id: 1, method: 'ping' },
    ]) expect(requestTimeoutMs(request)).toBe(10_000);
  });

  it('arms the long timer only for the send call when it runs', async () => {
    const { url } = await listen((request, response) => {
      request.resume();
      request.on('end', () => { response.setHeader('Content-Type', 'application/json'); response.end(JSON.stringify({ jsonrpc: '2.0', id: 1, result: {} })); });
    });
    const delays: number[] = [];
    const real = globalThis.setTimeout;
    const spy = vi.spyOn(globalThis, 'setTimeout').mockImplementation(((handler: TimerHandler, delay?: number, ...args: unknown[]) => {
      if (delay === 10_000 || delay === SEND_REQUEST_TIMEOUT_MS) delays.push(delay);
      return real(handler as () => void, delay, ...args);
    }) as typeof setTimeout);
    try {
      const input = new PassThrough();
      const output = new PassThrough();
      const done = runBridge({ LINEJS_MCP_URL: url }, input as never, output as never);
      for (const name of ['query_target_messages', 'send_to_target']) {
        input.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: {} } }) + '\n');
      }
      input.end();
      await done;
    } finally { spy.mockRestore(); }
    expect(delays).toEqual([10_000, SEND_REQUEST_TIMEOUT_MS]);
  });
});

describe('stdio MCP bridge does not block on a send', () => {
  /** Fake server: send_to_target waits until `releaseSend()`; every other method answers at once. */
  async function slowSendServer() {
    let releaseSend!: () => void;
    const gate = new Promise<void>((resolve) => { releaseSend = resolve; });
    const seen: string[] = [];
    const { url } = await listen((request, response) => {
      let body = '';
      request.setEncoding('utf8'); request.on('data', (chunk) => { body += chunk; });
      request.on('end', () => {
        const parsed = JSON.parse(body);
        const isSend = parsed.method === 'tools/call' && parsed.params?.name === 'send_to_target';
        seen.push(isSend ? 'send' : parsed.method);
        void (isSend ? gate : Promise.resolve()).then(() => {
          response.setHeader('Content-Type', 'application/json');
          response.end(JSON.stringify({ jsonrpc: '2.0', id: parsed.id, result: { method: parsed.method, ...(isSend ? { results: [{ index: 0, status: 'sent' }] } : {}) } }));
        });
      });
    });
    return { url, releaseSend, seen };
  }
  function streams() {
    const input = new PassThrough();
    const output = new PassThrough();
    const lines: string[] = [];
    const waiters: Array<() => void> = [];
    let buffer = '';
    output.setEncoding('utf8');
    output.on('data', (chunk: string) => {
      buffer += chunk;
      for (let index = buffer.indexOf('\n'); index >= 0; index = buffer.indexOf('\n')) { lines.push(buffer.slice(0, index)); buffer = buffer.slice(index + 1); }
      waiters.splice(0).forEach((wake) => wake());
    });
    const waitFor = async (count: number) => { while (lines.length < count) await new Promise<void>((resolve) => { waiters.push(resolve); }); };
    return { input, output, lines, waitFor };
  }
  const send = { jsonrpc: '2.0', id: 'send-1', method: 'tools/call', params: { name: 'send_to_target', arguments: {} } };

  it('answers a ping sent during a slow send first, keeps the other requests in order, and answers the send later with its own id', async () => {
    const server = await slowSendServer();
    const { input, output, lines, waitFor } = streams();
    const done = runBridge({ LINEJS_MCP_URL: server.url }, input as never, output as never);
    input.write(JSON.stringify(send) + '\n');
    input.write(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'ping' }) + '\n');
    input.write(JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'tools/list' }) + '\n');
    await waitFor(2);
    expect(lines.map((line) => JSON.parse(line).id)).toEqual([2, 3]);
    expect(lines.length).toBe(2);
    server.releaseSend();
    await waitFor(3);
    const last = JSON.parse(lines[2]!);
    expect(last).toMatchObject({ id: 'send-1', result: { results: [{ index: 0, status: 'sent' }] } });
    for (const line of lines) expect(() => JSON.parse(line)).not.toThrow();
    input.end();
    await done;
  });

  it('waits for the send in progress when stdin ends, and only then finishes', async () => {
    const server = await slowSendServer();
    const { input, output, lines, waitFor } = streams();
    let finished = false;
    const done = runBridge({ LINEJS_MCP_URL: server.url }, input as never, output as never).then(() => { finished = true; });
    input.write(JSON.stringify(send) + '\n');
    input.end();
    await vi.waitFor(() => expect(server.seen).toEqual(['send']));
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(finished).toBe(false);
    expect(lines).toEqual([]);
    server.releaseSend();
    await done;
    expect(finished).toBe(true);
    await waitFor(1);
    expect(JSON.parse(lines[0]!)).toMatchObject({ id: 'send-1', result: { results: [{ status: 'sent' }] } });
  });

  it('keeps FIFO order for requests that are not a send', async () => {
    const server = await slowSendServer();
    const { input, output, lines, waitFor } = streams();
    const done = runBridge({ LINEJS_MCP_URL: server.url }, input as never, output as never);
    for (const id of [1, 2, 3, 4]) input.write(JSON.stringify({ jsonrpc: '2.0', id, method: id % 2 ? 'ping' : 'tools/list' }) + '\n');
    input.end();
    await done;
    await waitFor(4);
    expect(lines.map((line) => JSON.parse(line).id)).toEqual([1, 2, 3, 4]);
  });
});
