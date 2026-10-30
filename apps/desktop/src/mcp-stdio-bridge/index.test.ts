import { spawn, type ChildProcess } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

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
