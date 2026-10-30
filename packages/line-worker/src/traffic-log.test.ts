import { createHash } from 'node:crypto';
import { channel } from 'node:diagnostics_channel';
import { mkdir, mkdtemp, readdir, readFile, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { connect, createServer, type Server } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Agent, request as undiciRequest } from 'undici';
import { afterEach, describe, expect, it } from 'vitest';
import { isLineHost, jsonShapeOf, redactPath, startTrafficLog, trafficLabel, type TrafficLogHandle, type TrafficLogOptions, type TrafficRecord } from './traffic-log.js';
import { pruneTrafficLogs } from './traffic-log-retention.js';

const servers: Server[] = [];
const agents: Agent[] = [];
const directories: string[] = [];
const handles: TrafficLogHandle[] = [];

afterEach(async () => {
  for (const handle of handles.splice(0)) await handle.stop();
  await Promise.all(agents.splice(0).map((agent) => agent.close()));
  await Promise.all(servers.splice(0).map((server) => new Promise((done) => { server.close(done); server.closeAllConnections?.(); })));
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function tempDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'traffic-log-'));
  directories.push(directory);
  return directory;
}

/** A raw TCP server. It keeps the exact bytes of each HTTP request (request line, header block, body). */
async function rawServer(): Promise<{ port: number; received: Buffer[] }> {
  const received: Buffer[] = [];
  const server = createServer((socket) => {
    let pending = Buffer.alloc(0);
    socket.on('error', () => undefined);
    socket.on('data', (chunk) => {
      pending = Buffer.concat([pending, chunk]);
      for (;;) {
        const headEnd = pending.indexOf('\r\n\r\n');
        if (headEnd < 0) return;
        const head = pending.subarray(0, headEnd).toString('latin1');
        let total: number;
        if (/transfer-encoding: chunked/i.test(head)) {
          const terminator = pending.indexOf('0\r\n\r\n', headEnd + 4);
          if (terminator < 0) return;
          total = terminator + 5;
        } else {
          total = headEnd + 4 + Number(/content-length: (\d+)/i.exec(head)?.[1] ?? 0);
        }
        if (pending.length < total) return;
        received.push(Buffer.from(pending.subarray(0, total)));
        pending = pending.subarray(total);
        socket.write('HTTP/1.1 200 OK\r\ncontent-length: 2\r\n\r\nok');
      }
    });
  });
  servers.push(server);
  await new Promise<void>((ready) => server.listen(0, '127.0.0.1', ready));
  return { port: (server.address() as { port: number }).port, received };
}

/** The origin stays a LINE host. Only the TCP connection goes to the loopback server. */
function loopbackAgent(port: number): Agent {
  const agent = new Agent({ connect: (_options, callback) => {
    const socket = connect(port, '127.0.0.1');
    socket.once('connect', () => callback(null, socket));
    socket.once('error', (error) => callback(error, null));
  } });
  agents.push(agent);
  return agent;
}

async function startLog(directory: string, extra: Partial<TrafficLogOptions> = {}): Promise<TrafficLogHandle> {
  const handle = startTrafficLog({ directory, processKind: 'worker', transport: 'DESKTOPWIN', accountId: 'account-A', ...extra });
  handles.push(handle);
  return handle;
}

async function readRecords(directory: string): Promise<TrafficRecord[]> {
  const names = (await readdir(directory)).filter((name) => name.endsWith('.jsonl')).sort();
  const records: TrafficRecord[] = [];
  for (const name of names) {
    for (const line of (await readFile(join(directory, name), 'utf8')).split('\n')) if (line) records.push(JSON.parse(line) as TrafficRecord);
  }
  return records;
}

const sha8 = (value: string) => createHash('sha256').update(value).digest('hex').slice(0, 8);
const LINE_ORIGIN = 'https://obs.line-apps.com';
const peer = `u${'a'.repeat(32)}`;

function streamOf(parts: Buffer[]): ReadableStream<Uint8Array> {
  let index = 0;
  return new ReadableStream<Uint8Array>({ pull(controller) {
    const part = parts[index++];
    if (part) controller.enqueue(new Uint8Array(part)); else controller.close();
  } });
}

function decodeChunked(raw: Buffer): Buffer {
  const parts: Buffer[] = [];
  let offset = raw.indexOf('\r\n\r\n') + 4;
  for (;;) {
    const lineEnd = raw.indexOf('\r\n', offset);
    const size = parseInt(raw.subarray(offset, lineEnd).toString('latin1'), 16);
    if (size === 0) return Buffer.concat(parts);
    parts.push(raw.subarray(lineEnd + 2, lineEnd + 2 + size));
    offset = lineEnd + 2 + size + 2;
  }
}

type Scenario = (agent: Agent) => Promise<Response>;
const scenarios: Scenario[] = [
  (agent) => fetch(`${LINE_ORIGIN}/r/talk/emi/${peer}?a=1&b=2`, { method: 'POST', dispatcher: agent,
    headers: { 'x-line-access': 'secret-token-value', 'x-hmac': 'abc', 'user-agent': 'official-like', 'content-type': 'application/json' },
    body: JSON.stringify({ to: peer, text: 'hello' }) } as RequestInit),
  (agent) => fetch(new Request(`${LINE_ORIGIN}/S4`, { method: 'POST', headers: { 'content-type': 'application/x-thrift' }, body: new Uint8Array(70_000).fill(7) }),
    { dispatcher: agent } as RequestInit),
  (agent) => fetch(new Request(`${LINE_ORIGIN}/r/talk/emi/x`, { method: 'POST',
    body: streamOf([Buffer.alloc(100, 97), Buffer.alloc(200, 98), Buffer.alloc(50, 99)]), duplex: 'half' } as RequestInit), { dispatcher: agent } as RequestInit),
  (agent) => fetch(`${LINE_ORIGIN}/api/talk/thrift/Talk/TalkService/getProfile`, { dispatcher: agent } as RequestInit),
  (agent) => fetch(`${LINE_ORIGIN}/empty`, { method: 'POST', dispatcher: agent } as RequestInit),
  (agent) => fetch(`${LINE_ORIGIN}/api/x`, { method: 'PUT', dispatcher: agent, headers: { 'accept-language': 'zh-TW', 'x-lal': 'zh_TW' }, body: 'plain text' } as RequestInit),
];

async function runScenarios(): Promise<Buffer[]> {
  const server = await rawServer();
  const agent = loopbackAgent(server.port);
  for (const scenario of scenarios) await (await scenario(agent)).text();
  return server.received;
}

describe('traffic log does not change traffic', () => {
  it('sends identical raw bytes with the log on and off (buffered, string and duplex half stream bodies)', async () => {
    const off = await runScenarios();
    const directory = await tempDirectory();
    const handle = await startLog(directory);
    const on = await runScenarios();
    await handle.flush();
    expect(off).toHaveLength(scenarios.length);
    expect(on).toHaveLength(off.length);
    for (const [index, bytes] of off.entries()) expect(on[index]!.equals(bytes), `scenario ${index}`).toBe(true);
    expect(await readRecords(directory)).toHaveLength(scenarios.length);
    expect(handle.stats().dropped).toBe(0);
  });
});

describe('traffic log record', () => {
  it('records header order as written, redacts secrets, keeps other values and hashes ids', async () => {
    const directory = await tempDirectory();
    const handle = await startLog(directory);
    const server = await rawServer();
    const agent = loopbackAgent(server.port);
    const obs = Buffer.from(JSON.stringify({ name: 'photo.png', type: 'image', ver: '2.0', size: 12 })).toString('base64');
    const body = JSON.stringify({ to: peer, nested: { count: 12345, ok: true, none: null }, list: ['abc', 'defgh'] });
    const response = await undiciRequest(`${LINE_ORIGIN}/r/talk/emi/${peer}/OBJ?mid=${peer}&b=2`, { method: 'POST', dispatcher: agent,
      headers: { 'x-line-access': 'secret-token-value', 'x-hmac': 'hmac-value', cookie: 'a=b', 'user-agent': 'official-like',
        'content-type': 'application/json', 'x-obs-params': obs, 'x-lal': 'zh_TW', 'x-line-channeltoken': 'ct', 'x-other-token': 'tt' }, body });
    await response.body.text();
    await handle.flush();
    const [record] = await readRecords(directory);
    expect(record).toBeDefined();
    const raw = server.received[0]!.toString('latin1');
    const rawNames = raw.split('\r\n\r\n')[0]!.split('\r\n').slice(1).map((line) => line.split(':')[0]!.toLowerCase());
    expect(record!.headers!.map(([name]) => name.toLowerCase())).toEqual(rawNames);
    const headers = Object.fromEntries(record!.headers!.map(([name, value]) => [name.toLowerCase(), value]));
    expect(headers['x-line-access']).toBe(`<redacted:${'secret-token-value'.length}>`);
    expect(headers['x-hmac']).toBe(`<redacted:${'hmac-value'.length}>`);
    expect(headers.cookie).toBe('<redacted:3>');
    expect(headers['x-line-channeltoken']).toBe('<redacted:2>');
    expect(headers['x-other-token']).toBe('<redacted:2>');
    expect(headers['x-obs-params']).toBe(`<redacted:${obs.length}>`);
    expect(headers['user-agent']).toBe('official-like');
    expect(headers['content-type']).toBe('application/json');
    expect(headers['x-lal']).toBe('zh_TW');
    expect(headers['content-length']).toBe(String(Buffer.byteLength(body)));
    expect(record!.framingDerived).toBe(true);
    expect(JSON.stringify(record)).not.toContain('secret-token-value');
    expect(record!.obsParams).toEqual({ keys: ['name', 'type', 'ver', 'size'], types: { name: 'string', type: 'string', ver: 'string', size: 'number' } });
    expect(record!.path).toBe(`/r/talk/emi/<id:${sha8(peer)}>/OBJ`);
    expect(record!.requestLine).toBe(`POST /r/talk/emi/<id:${sha8(peer)}>/OBJ HTTP/1.1`);
    expect(record!.queryKeys).toEqual(['mid', 'b']);
    expect(JSON.stringify(record)).not.toContain(peer);
    expect(record!.body).toEqual({ kind: 'buffer', length: Buffer.byteLength(body), sha256: createHash('sha256').update(body).digest('hex') });
    expect(record!.jsonShape).toEqual({ to: 'string:33', nested: { count: 'number:5', ok: 'boolean', none: 'null' }, list: ['string:3', 'string:5'] });
    expect(JSON.stringify(record!.jsonShape)).not.toContain('hello');
    expect(record).toMatchObject({ status: 200, method: 'POST', origin: LINE_ORIGIN, process: 'worker', transport: 'DESKTOPWIN', httpVersion: '1.1', label: null });
    expect(record!.accountRef).toBe(createHash('sha256').update('account-A').digest('hex').slice(0, 12));
    expect(typeof record!.durationMs).toBe('number');
    expect(await readdir(directory)).toEqual([expect.stringMatching(/^\d{4}-\d{2}-\d{2}-worker-\d+\.jsonl$/)]);
  });

  it('records a stream body as stream with chunked transfer encoding and sends all bytes', async () => {
    const directory = await tempDirectory();
    const handle = await startLog(directory);
    const server = await rawServer();
    const agent = loopbackAgent(server.port);
    const parts = [Buffer.alloc(100, 97), Buffer.alloc(200, 98), Buffer.alloc(50, 99)];
    await (await fetch(new Request(`${LINE_ORIGIN}/r/talk/emi/x`, { method: 'POST', body: streamOf(parts), duplex: 'half' } as RequestInit),
      { dispatcher: agent } as RequestInit)).text();
    await handle.flush();
    const [record] = await readRecords(directory);
    expect(record!.body).toEqual({ kind: 'stream', length: null, sha256: null });
    expect(record!.headers).toContainEqual(['transfer-encoding', 'chunked']);
    expect(record!.headers!.some(([name]) => name === 'content-length')).toBe(false);
    expect(record!.jsonShape).toBeUndefined();
    expect(decodeChunked(server.received[0]!).equals(Buffer.concat(parts))).toBe(true);
  });

  it('records a fetch buffered body with its length and without a hash', async () => {
    const directory = await tempDirectory();
    const handle = await startLog(directory);
    const server = await rawServer();
    const agent = loopbackAgent(server.port);
    await (await fetch(new Request(`${LINE_ORIGIN}/S4`, { method: 'POST', body: new Uint8Array(300).fill(1) }), { dispatcher: agent } as RequestInit)).text();
    await handle.flush();
    const [record] = await readRecords(directory);
    expect(record!.body).toEqual({ kind: 'other', length: 300, sha256: null });
    expect(record!.headers).toContainEqual(['content-length', '300']);
  });

  it('takes the label from the async context and from a CHROMEOS gateway path', async () => {
    const directory = await tempDirectory();
    const handle = await startLog(directory);
    const server = await rawServer();
    const agent = loopbackAgent(server.port);
    await trafficLabel.run('sendMessage', async () => (await fetch(`${LINE_ORIGIN}/S4`, { method: 'POST', body: 'x', dispatcher: agent } as RequestInit)).text());
    await (await fetch(`${LINE_ORIGIN}/S4`, { method: 'POST', body: 'x', dispatcher: agent } as RequestInit)).text();
    await handle.flush();
    expect((await readRecords(directory)).map((record) => record.label)).toEqual(['sendMessage', null]);
    await handle.stop();
    const chromeDirectory = await tempDirectory();
    const chrome = await startLog(chromeDirectory, { transport: 'CHROMEOS' });
    await (await fetch(`${LINE_ORIGIN}/api/talk/thrift/Talk/TalkService/sendMessage`, { method: 'POST', body: 'x', dispatcher: agent } as RequestInit)).text();
    await chrome.flush();
    expect((await readRecords(chromeDirectory))[0]).toMatchObject({ label: 'sendMessage', transport: 'CHROMEOS' });
  });

  it('records the error class name when the connection fails', async () => {
    const directory = await tempDirectory();
    const handle = await startLog(directory);
    const agent = new Agent({ connect: (_options, callback) => callback(new Error('refused'), null) });
    agents.push(agent);
    await expect(fetch(`${LINE_ORIGIN}/S4`, { dispatcher: agent } as RequestInit)).rejects.toThrow();
    await handle.flush();
    const [record] = await readRecords(directory);
    expect(record!.error).toMatch(/^[A-Za-z0-9_]+$/);
    expect(record!.status).toBeUndefined();
    expect(record!.headers).toBeNull();
  });
});

describe('traffic log failure', () => {
  it('does not fail the request when the writer throws, and counts the drops', async () => {
    const directory = await tempDirectory();
    const handle = await startLog(directory, { appendLines: async () => { throw new Error('disk full'); } });
    const server = await rawServer();
    const agent = loopbackAgent(server.port);
    const response = await fetch(`${LINE_ORIGIN}/S4`, { method: 'POST', body: 'payload', dispatcher: agent } as RequestInit);
    expect(response.status).toBe(200);
    expect(await response.text()).toBe('ok');
    expect(server.received[0]!.toString('latin1').endsWith('payload')).toBe(true);
    await handle.flush();
    expect(handle.stats()).toEqual({ written: 0, dropped: 1 });
  });

  it('does not throw into the publisher when a handler receives bad data', async () => {
    const directory = await tempDirectory();
    const handle = await startLog(directory);
    const bad = { origin: 'https://obs.line-apps.com', get method(): string { throw new Error('boom'); } };
    expect(() => channel('undici:request:create').publish({ request: bad })).not.toThrow();
    expect(() => channel('undici:request:create').publish(null)).not.toThrow();
    expect(() => channel('undici:request:headers').publish({ request: {}, response: { statusCode: 200 } })).not.toThrow();
    expect(handle.stats().dropped).toBeGreaterThan(0);
  });
});

describe('traffic log host filter', () => {
  it('logs no request to a host that is not a LINE host', async () => {
    const directory = await tempDirectory();
    const handle = await startLog(directory);
    const server = await rawServer();
    const agent = loopbackAgent(server.port);
    await (await fetch('https://example.com/S4', { method: 'POST', body: 'x', dispatcher: agent } as RequestInit)).text();
    await (await fetch('https://notline.me/S4', { dispatcher: agent } as RequestInit)).text();
    await handle.flush();
    expect(await readRecords(directory).catch(() => [])).toEqual([]);
    expect(server.received).toHaveLength(2);
  });

  it('matches only the LINE host names', () => {
    for (const host of ['line.me', 'obs.line-apps.com', 'a.b.line-scdn.net', 'x.line.naver.jp', 'obs.naver.jp', 'LINE.ME']) expect(isLineHost(host), host).toBe(true);
    for (const host of ['notline.me', 'line.me.evil.com', 'example.com', '127.0.0.1', 'line-apps.com.evil.io']) expect(isLineHost(host), host).toBe(false);
  });
});

describe('traffic log redaction helpers', () => {
  it('hashes id-like path segments and keeps fixed ones', () => {
    const oid = '0hAbCdEf1234567890AbCdEf12345678';
    const uuid = '123e4567-e89b-12d3-a456-426614174000';
    const result = redactPath(`/r/talk/emi/${oid}/${uuid}/reqid-9f/${peer}/12345678901/sendMessage/S4?x=1&y=2&x=3`);
    expect(result.path).toBe(`/r/talk/emi/<id:${sha8(oid)}>/<id:${sha8(uuid)}>/<id:${sha8('reqid-9f')}>/<id:${sha8(peer)}>/<id:${sha8('12345678901')}>/sendMessage/S4`);
    expect(result.queryKeys).toEqual(['x', 'y', 'x']);
    expect(redactPath('/api/talk/thrift/Talk/TalkService/sendMessage').path).toBe('/api/talk/thrift/Talk/TalkService/sendMessage');
    expect(redactPath('/api/talk/thrift/LoginQrCode/SecondaryQrCodeLoginPermitNoticeService/x').path)
      .toBe('/api/talk/thrift/LoginQrCode/SecondaryQrCodeLoginPermitNoticeService/x');
  });

  it('shows only types and lengths for JSON leaves and caps arrays at 20', () => {
    const shape = jsonShapeOf({ a: 'secret', b: [1, 2, 3], c: Array.from({ length: 30 }, () => 'x'), d: { e: false } });
    expect(shape).toEqual({ a: 'string:6', b: ['number:1', 'number:1', 'number:1'], c: Array.from({ length: 20 }, () => 'string:1'), d: { e: 'boolean' } });
    expect(JSON.stringify(shape)).not.toContain('secret');
  });
});

describe('traffic log retention', () => {
  it('deletes old jsonl files, then the oldest files above the size limit, and leaves other files', async () => {
    const directory = await tempDirectory();
    const now = Date.now();
    const day = 24 * 60 * 60 * 1000;
    const make = async (name: string, size: number, ageDays: number) => {
      const path = join(directory, name);
      await writeFile(path, Buffer.alloc(size, 1));
      await utimes(path, new Date(now - ageDays * day), new Date(now - ageDays * day));
    };
    await make('old.jsonl', 10, 20);
    await make('note.txt', 10, 30);
    await make('a.jsonl', 100, 5);
    await make('b.jsonl', 100, 3);
    await make('c.jsonl', 100, 1);
    await mkdir(join(directory, 'sub.jsonl'));
    const result = await pruneTrafficLogs(directory, { now, maxAgeMs: 14 * day, maxTotalBytes: 250 });
    expect(result.deleted).toBe(2);
    expect((await readdir(directory)).sort()).toEqual(['b.jsonl', 'c.jsonl', 'note.txt', 'sub.jsonl']);
    expect((await stat(join(directory, 'b.jsonl'))).size).toBe(100);
  });

  it('does not throw when the directory is missing', async () => {
    const directory = await tempDirectory();
    await expect(pruneTrafficLogs(join(directory, 'missing'))).resolves.toEqual({ deleted: 0 });
  });
});
