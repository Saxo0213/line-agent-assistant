import { describe, expect, it } from 'vitest';
import {
  buildTalkMeta, encodeObsParams, ObsClient, ObsHttpError, ObsSizeLimitError, parseEncryptedAccessToken, type ObsRequest,
} from './obs.js';
import type { FetchLike } from './gateway.js';

describe('OBS helpers (OkLine obs.py)', () => {
  it('encodes X-Obs-Params as base64 of compact JSON', () => {
    const encoded = encodeObsParams({ ver: '2.0', name: 'n', type: 'file' });
    expect(Buffer.from(encoded, 'base64').toString('utf8')).toBe('{"ver":"2.0","name":"n","type":"file"}');
  });

  it('builds X-Talk-Meta byte for byte', () => {
    const outer = JSON.parse(Buffer.from(buildTalkMeta('123'), 'base64').toString('utf8')) as { message: string };
    expect(Object.keys(outer)).toEqual(['message']);
    expect(Buffer.from(outer.message, 'base64').toString('hex')).toBe('0b000400000003313233' + '0f001b0c00000000' + '00');
  });

  it('parses the encrypted token from rows[1][0] and rejects malformed answers', () => {
    expect(parseEncryptedAccessToken('1\u001etok\u001fx')).toBe('tok');
    expect(parseEncryptedAccessToken('1\u001etok')).toBe('tok');
    expect(parseEncryptedAccessToken('onlyone')).toBeNull();
    expect(parseEncryptedAccessToken('1\u001e')).toBeNull();
    expect(parseEncryptedAccessToken(42)).toBeNull();
  });

  it('parses like OkLine: no length limit and no character check', () => {
    const long = 'a'.repeat(4097);
    expect(parseEncryptedAccessToken(`1\u001e${long}`)).toBe(long);
    expect(parseEncryptedAccessToken(`1\u001etok\u001f${'b'.repeat(9000)}`)).toBe('tok');
    expect(parseEncryptedAccessToken('1\u001ebad token')).toBe('bad token');
    expect(parseEncryptedAccessToken('1\u001e\u001fx')).toBeNull(); // empty second record field
    expect(parseEncryptedAccessToken('1\u001e\u001e')).toBeNull();
  });

  it('sends a 4097-character token in X-Line-Access', async () => {
    const long = 'a'.repeat(4097);
    const seen: ObsRequest[] = [];
    const obs = new ObsClient({ fetch: async () => new Response('data'), authorize: (request) => { seen.push(request); },
      acquireToken: async () => parseEncryptedAccessToken(`1\u001e${long}`) ?? '' });
    await obs.download({ sid: 'emi', oid: 'o1', maxBytes: 100 });
    expect(seen[0]!.headers.find(([name]) => name === 'X-Line-Access')?.[1]).toBe(long);
  });
});

function client(fetch: FetchLike, seen: ObsRequest[] = [], tokens: string[] = []) {
  return new ObsClient({ fetch, authorize: (request) => { seen.push(request); },
    acquireToken: async () => { tokens.push('t'); return 'enc-token'; } });
}

describe('ObsClient', () => {
  it('downloads with the OkLine header order and one token per client', async () => {
    const seen: ObsRequest[] = [];
    const tokens: string[] = [];
    const obs = client(async () => new Response('data'), seen, tokens);
    expect((await obs.download({ sid: 'emi', oid: 'o1', talkMessageId: '9', pop: 'pp', maxBytes: 100 })).toString()).toBe('data');
    await obs.download({ sid: 'emi', oid: 'o1', maxBytes: 100 });
    expect(tokens).toHaveLength(1);
    expect(seen[0]!.url).toBe('https://obs.line-apps.com/r/talk/emi/o1?p=pp');
    expect(seen[0]!.headers.map(([name]) => name)).toEqual(['accept', 'X-Line-Chrome-Version', 'Accept-Language', 'User-Agent', 'X-Line-Access',
      'X-Line-Application', 'X-Talk-Meta']);
    expect(seen[1]!.headers.map(([name]) => name)).not.toContain('X-Talk-Meta');
  });

  it('does not send when the gate refuses', async () => {
    let sent = 0;
    const obs = new ObsClient({ fetch: async () => { sent += 1; return new Response(''); }, authorize: () => { throw new Error('denied'); }, acquireToken: async () => 't' });
    await expect(obs.download({ sid: 'emi', oid: 'o1', maxBytes: 1 })).rejects.toThrow('denied');
    await expect(obs.upload({ path: 'talk/emf/reqid-x', data: new Uint8Array(1), params: {} })).rejects.toThrow('denied');
    expect(sent).toBe(0);
  });

  it('maps statuses and enforces the byte limit while streaming', async () => {
    await expect(client(async () => new Response('', { status: 404 })).download({ sid: 'm', oid: 'o', maxBytes: 5 })).rejects.toMatchObject({ status: 404 });
    await expect(client(async () => new Response('', { status: 202 })).download({ sid: 'm', oid: 'o', maxBytes: 5 })).rejects.toBeInstanceOf(ObsHttpError);
    const stream = new ReadableStream<Uint8Array>({ start(c) { c.enqueue(new Uint8Array(4)); c.enqueue(new Uint8Array(4)); c.close(); } });
    await expect(client(async () => new Response(stream)).download({ sid: 'm', oid: 'o', maxBytes: 5 })).rejects.toBeInstanceOf(ObsSizeLimitError);
  });

  it('aborts a pending read', async () => {
    const controller = new AbortController();
    const stream = new ReadableStream<Uint8Array>({ start(c) { c.enqueue(new Uint8Array(2)); } });
    const pending = client(async () => new Response(stream)).download({ sid: 'm', oid: 'o', maxBytes: 100, signal: controller.signal }).catch((e: unknown) => e);
    await new Promise((resolve) => setImmediate(resolve));
    controller.abort(new Error('stop'));
    expect(await pending).toMatchObject({ message: 'stop' });
  });

  it('uploads bytes and reads the object id from x-obs-oid', async () => {
    const seen: ObsRequest[] = [];
    let body: unknown;
    const obs = client(async (_url, init) => { body = init.body; return new Response('', { headers: { 'x-obs-oid': 'oid-1', 'x-obs-hash': 'h' } }); }, seen);
    const result = await obs.upload({ path: 'talk/emf/reqid-abc', data: new Uint8Array([1, 2, 3]), params: { type: 'file' } });
    expect(result).toEqual({ objId: 'oid-1', objHash: 'h' });
    expect(body).toEqual(new Uint8Array([1, 2, 3]));
    expect(seen[0]!.method).toBe('POST');
    expect(seen[0]!.url).toBe('https://obs.line-apps.com/r/talk/emf/reqid-abc');
    expect(seen[0]!.headers.at(-1)![0]).toBe('X-Obs-Params');
  });

  it('takes the object id from x-obs-oid only: a JSON body is ignored', async () => {
    const obs = client(async () => new Response('{"objId":"x"}', { headers: { 'x-obs-hash': 'h' } }));
    const result = await obs.upload({ path: 'talk/emf/reqid-abc', data: new Uint8Array([1]), params: {} });
    expect(result).toEqual({ objId: '', objHash: 'h' });
  });

  it('turns an upload HTTP error and a network error into typed errors', async () => {
    await expect(client(async () => new Response('', { status: 500 })).upload({ path: 'talk/emf/r', data: new Uint8Array(1), params: {} }))
      .rejects.toMatchObject({ status: 500 });
    await expect(client(async () => { throw new TypeError('reset'); }).upload({ path: 'talk/emf/r', data: new Uint8Array(1), params: {} }))
      .rejects.toMatchObject({ name: 'ChromeTransportError' });
  });
});
