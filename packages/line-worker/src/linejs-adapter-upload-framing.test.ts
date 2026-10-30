import { createServer, type IncomingHttpHeaders, type Server } from 'node:http';
import { connect, type AddressInfo } from 'node:net';
import { Agent } from 'undici';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createLinejsAdapter } from './linejs-adapter.js';

const jwt = [Buffer.from('{"alg":"HS256"}').toString('base64url'), Buffer.from('{"sub":"u-self"}').toString('base64url'), 'signature'].join('.');
const lease = { accountId: 'account-A', workerInstanceId: 'worker-1', controlEpoch: 7 };
const peer = `u${'a'.repeat(32)}`;
const spies: Array<{ mockRestore(): void }> = [];
const servers: Server[] = [];
afterEach(async () => {
  for (const spy of spies.splice(0)) spy.mockRestore();
  await Promise.all(servers.splice(0).map((server) => new Promise((done) => server.close(done))));
});

type Seen = { method: string; url: string; headers: IncomingHttpHeaders; body: Buffer };

async function loopback(): Promise<{ origin: string; seen: Seen[] }> {
  const seen: Seen[] = [];
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      seen.push({ method: req.method ?? '', url: req.url ?? '', headers: req.headers, body: Buffer.concat(chunks) });
      res.writeHead(200, { 'x-obs-oid': 'OID_1' }).end();
    });
  });
  servers.push(server);
  await new Promise<void>((ready) => server.listen(0, '127.0.0.1', ready));
  return { origin: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, seen };
}

describe('OBS upload wire framing', () => {
  it('sends the adapter upload with Content-Length and without Transfer-Encoding', async () => {
    const { E2EE } = await import(new URL('../../../node_modules/@evex/linejs/base/e2ee/mod.js', import.meta.url).href) as { E2EE: { prototype: object } };
    const { TalkService } = await import(new URL('../../../node_modules/@evex/linejs/base/service/talk/mod.js', import.meta.url).href) as { TalkService: { prototype: object } };
    spies.push(vi.spyOn(E2EE.prototype as any, 'encryptE2EEMessage').mockImplementation(async () => [Buffer.from([1, 2, 3])]));
    spies.push(vi.spyOn(TalkService.prototype as any, 'sendMessage').mockImplementation(async () => ({ id: '777' })));
    const server = await loopback();
    const gated: Request[] = [];
    // The gate allows only https://obs.line-apps.com. The Request is not changed. Only the TCP connection goes to the loopback server.
    const port = Number(new URL(server.origin).port);
    const dispatcher = new Agent({ connect: (_options, callback) => {
      const socket = connect(port, '127.0.0.1');
      socket.once('connect', () => callback(null, socket));
      socket.once('error', (error) => callback(error, null));
    } });
    spies.push({ mockRestore: () => { void dispatcher.close(); } });
    const physicalTransport = async (request: Request): Promise<Response> => {
      expect(new URL(request.url).origin).toBe('https://obs.line-apps.com');
      gated.push(request.clone());
      return fetch(request, { dispatcher } as RequestInit);
    };
    const adapter = await createLinejsAdapter({ ...lease, mode: 'ACTIVE_CONTROL', validateLease: () => true, physicalTransport });
    await adapter.installSecrets({ token: jwt, qrCert: null, e2eeStorage: null });
    const bytes = Buffer.alloc(70_000, 7);
    await adapter.sendMedia({ chatType: 'direct', chatId: peer }, { kind: 'image', bytes, fileName: 'photo.png' }, lease);
    expect(server.seen).toHaveLength(2);
    for (const [index, entry] of server.seen.entries()) {
      const expected = Buffer.from(await gated[index]!.arrayBuffer());
      expect(expected.length).toBe(bytes.length + 32);
      expect(entry.method).toBe('POST');
      expect(entry.url).toMatch(/^\/r\/talk\/emi\/[^/]+/);
      expect(entry.headers['content-length']).toBe(String(expected.length));
      expect(entry.headers['transfer-encoding']).toBeUndefined();
      expect(entry.body.equals(expected)).toBe(true);
      expect(entry.headers['x-obs-params']).toBe(gated[index]!.headers.get('x-obs-params'));
    }
  });

  it('shows that a stream body with duplex half gives chunked Transfer-Encoding', async () => {
    const server = await loopback();
    const bytes = Buffer.alloc(1000, 3);
    const source = () => new Request(`${server.origin}/r/talk/emi/x`, { method: 'POST', body: bytes });
    await fetch(new Request(`${server.origin}/r/talk/emi/x`, { method: 'POST', body: source().body, duplex: 'half' } as RequestInit));
    expect(server.seen[0]!.headers['transfer-encoding']).toBe('chunked');
    expect(server.seen[0]!.headers['content-length']).toBeUndefined();
    await fetch(new Request(`${server.origin}/r/talk/emi/x`, { method: 'POST', body: await source().arrayBuffer() }));
    expect(server.seen[1]!.headers['content-length']).toBe('1000');
    expect(server.seen[1]!.headers['transfer-encoding']).toBeUndefined();
  });
});
