import { stdin, stdout } from 'node:process';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const MAX_LINE_BYTES = 64 * 1024;
const REQUEST_TIMEOUT_MS = 10_000;
type JsonRpcId = string | number | null;
type JsonRpcRequest = { jsonrpc?: unknown; id?: JsonRpcId; method?: unknown };

function responseError(id: JsonRpcId, message: string): string {
  return JSON.stringify({ jsonrpc: '2.0', id, error: { code: -32000, message } });
}
function idFromPrefix(line: string): JsonRpcId {
  const match = /"id"\s*:\s*("(?:\\.|[^"\\])*"|-?\d+(?:\.\d+)?|null)/.exec(line);
  if (!match) return null;
  try { return JSON.parse(match[1]!) as JsonRpcId; } catch { return null; }
}

export async function runBridge(env: NodeJS.ProcessEnv, input = stdin, output = stdout): Promise<void> {
  const endpointText = env.LINEJS_MCP_URL;
  const token = env.LINEJS_MCP_TOKEN;
  if (!endpointText || !token) throw new Error('LINEJS_MCP_URL and LINEJS_MCP_TOKEN are required.');
  const endpoint = new URL(endpointText);
  if (endpoint.hostname !== '127.0.0.1' || endpoint.protocol !== 'http:') throw new Error('MCP bridge only accepts an http URL on 127.0.0.1.');
  let sessionId: string | null = null;
  let queued = Promise.resolve();
  let line = Buffer.alloc(0);
  let overLimit = false;
  let ended = false;

  const processLine = async (bytes: Buffer, tooLong: boolean): Promise<void> => {
    const text = bytes.toString('utf8');
    let request: JsonRpcRequest | undefined;
    try { request = JSON.parse(text) as JsonRpcRequest; } catch { /* Report a parse error below. */ }
    const id = request && Object.hasOwn(request, 'id') ? request.id ?? null : idFromPrefix(text);
    if (tooLong) { output.write(`${responseError(id, 'Request line exceeds 64 KiB.')}\n`); return; }
    if (!request || request.jsonrpc !== '2.0' || typeof request.method !== 'string') {
      if (request && Object.hasOwn(request, 'id')) output.write(`${JSON.stringify({ jsonrpc: '2.0', id, error: { code: -32600, message: 'Invalid JSON-RPC request.' } })}\n`);
      return;
    }
    const hasId = Object.hasOwn(request, 'id');
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new Error('Request timed out.')), REQUEST_TIMEOUT_MS);
    try {
      const headers: Record<string, string> = {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
      };
      if (sessionId) headers['Mcp-Session-Id'] = sessionId;
      const response = await fetch(endpoint, { method: 'POST', headers, body: text, signal: controller.signal, redirect: 'error' });
      const returnedSession = response.headers.get('Mcp-Session-Id');
      if (returnedSession) sessionId = returnedSession;
      const body = await response.text();
      if (!hasId) return;
      if (!response.ok) { output.write(`${responseError(id, `HTTP ${response.status}`)}\n`); return; }
      if (response.status === 202 || !body.trim()) return;
      let parsed: unknown;
      try { parsed = JSON.parse(body); } catch { output.write(`${responseError(id, 'MCP server returned an invalid JSON response.')}\n`); return; }
      output.write(`${JSON.stringify(parsed)}\n`);
    } catch (error) {
      if (hasId) output.write(`${responseError(id, controller.signal.aborted ? 'Request timed out.' : 'MCP connection failed.')}\n`);
    } finally {
      clearTimeout(timer);
      controller.abort();
    }
  };
  const enqueueLine = (bytes: Buffer, tooLong: boolean) => {
    queued = queued.then(() => processLine(bytes, tooLong)).catch(() => undefined);
  };
  const onData = (chunk: Buffer | string) => {
    const bytes = typeof chunk === 'string' ? Buffer.from(chunk) : chunk;
    let offset = 0;
    while (offset < bytes.length) {
      const newline = bytes.indexOf(0x0a, offset);
      const end = newline < 0 ? bytes.length : newline;
      const piece = bytes.subarray(offset, end);
      if (!overLimit) {
        if (line.length + piece.length > MAX_LINE_BYTES) {
          const remaining = Math.max(0, MAX_LINE_BYTES - line.length);
          line = Buffer.concat([line, piece.subarray(0, remaining)]);
          overLimit = true;
        } else line = Buffer.concat([line, piece]);
      }
      if (newline < 0) break;
      enqueueLine(line, overLimit);
      line = Buffer.alloc(0);
      overLimit = false;
      offset = newline + 1;
    }
  };
  const onEnd = () => {
    if (ended) return;
    ended = true;
    if (line.length || overLimit) enqueueLine(line, overLimit);
    input.removeListener('data', onData);
    input.removeListener('end', onEnd);
  };
  input.on('data', onData);
  input.once('end', onEnd);
  await new Promise<void>((resolve) => {
    input.once('close', () => resolve());
    input.once('end', () => resolve());
  });
  await queued;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  void runBridge(process.env).catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : 'MCP bridge failed.'}\n`);
    process.exitCode = 1;
  });
}
