import { afterEach, expect, it, vi } from 'vitest';
import { createLinejsAdapter } from './linejs-adapter.js';
import { MediaUploadFailedError } from './worker-loop.js';

const jwt = [Buffer.from('{"alg":"HS256"}').toString('base64url'), Buffer.from('{"sub":"u-self"}').toString('base64url'), 'signature'].join('.');
const lease = { accountId: 'account-A', workerInstanceId: 'worker-1', controlEpoch: 7 };
const peer = `u${'a'.repeat(32)}`;
const group = `c${'b'.repeat(32)}`;
const spies: Array<{ mockRestore(): void }> = [];
afterEach(() => { for (const spy of spies.splice(0)) spy.mockRestore(); });

async function fixture(options: { objIds?: string[]; status?: number; valid?: () => boolean; mode?: 'ACTIVE_CONTROL' | 'MONITOR_ONLY' } = {}) {
  const { E2EE } = await import(new URL('../../../node_modules/@evex/linejs/base/e2ee/mod.js', import.meta.url).href) as {
    E2EE: { prototype: object };
  };
  const { TalkService } = await import(new URL('../../../node_modules/@evex/linejs/base/service/talk/mod.js', import.meta.url).href) as {
    TalkService: { prototype: object };
  };
  const order: string[] = [];
  const encrypt = vi.spyOn(E2EE.prototype as any, 'encryptE2EEMessage').mockImplementation(async () => {
    order.push('encryptE2EEMessage'); return [Buffer.from([1, 2, 3])];
  });
  const send = vi.spyOn(TalkService.prototype as any, 'sendMessage').mockImplementation(async () => {
    order.push('sendMessage'); return { id: '777' };
  });
  spies.push(encrypt, send);
  const requests: Request[] = [];
  const objIds = [...(options.objIds ?? ['OID_1', 'OID_1'])];
  const physicalTransport = vi.fn(async (request: Request) => {
    requests.push(request);
    order.push(`POST ${new URL(request.url).pathname}`);
    return new Response(null, { status: options.status ?? 200, headers: { 'x-obs-oid': objIds.shift() ?? '' } });
  });
  const adapter = await createLinejsAdapter({ ...lease, mode: options.mode ?? 'ACTIVE_CONTROL',
    validateLease: options.valid ?? (() => true), physicalTransport });
  await adapter.installSecrets({ token: jwt, qrCert: null, e2eeStorage: null });
  return { adapter, order, requests, encrypt, send, physicalTransport };
}

it('uploads an image, its preview, then sends the E2EE message with the linejs metadata', async () => {
  const { adapter, order, requests, encrypt, send } = await fixture();
  const bytes = Buffer.from('image-bytes');
  await expect(adapter.sendMedia({ chatType: 'direct', chatId: peer }, { kind: 'image', bytes, fileName: 'photo.png' }, lease))
    .resolves.toEqual({ messageId: '777' });
  expect(order).toEqual([expect.stringMatching(/^POST \/r\/talk\/emi\/reqid-[0-9a-f-]{36}$/), 'POST /r/talk/emi/OID_1__ud-preview',
    'encryptE2EEMessage', 'sendMessage']);
  expect(requests.every((request) => request.method === 'POST' && request.redirect === 'error'
    && new URL(request.url).hostname === 'obs.line-apps.com' && new URL(request.url).search === '')).toBe(true);
  const [first, preview] = await Promise.all(requests.map(async (request) => Buffer.from(await request.arrayBuffer())));
  expect(first!.equals(preview!)).toBe(true);
  expect(first!.length).toBe(bytes.length + 32);
  expect(JSON.parse(Buffer.from(requests[0]!.headers.get('x-obs-params')!, 'base64').toString())).toMatchObject({ type: 'file' });
  expect(encrypt).toHaveBeenCalledWith(peer, expect.objectContaining({ fileName: 'photo.png', keyMaterial: expect.any(String) }), 1);
  const size = bytes.length + 32;
  expect(send).toHaveBeenCalledWith(expect.objectContaining({ to: peer, contentType: 1, chunks: [Buffer.from([1, 2, 3])],
    contentMetadata: { SID: 'emi', OID: 'OID_1', FILE_SIZE: String(size), e2eeVersion: '2',
      MEDIA_CONTENT_INFO: JSON.stringify({ category: 'original', fileSize: size, extension: 'png', animated: false }) } }));
});

it('uploads a file once without a preview or media content info', async () => {
  const { adapter, order, send } = await fixture({ objIds: ['OID_F'] });
  await adapter.sendMedia({ chatType: 'group', chatId: group }, { kind: 'file', bytes: Buffer.from('doc'), fileName: 'report.pdf' }, lease);
  expect(order).toEqual([expect.stringMatching(/^POST \/r\/talk\/emf\/reqid-/), 'encryptE2EEMessage', 'sendMessage']);
  expect(send).toHaveBeenCalledWith(expect.objectContaining({ to: group, contentType: 14,
    contentMetadata: { SID: 'emf', OID: 'OID_F', FILE_SIZE: String(3 + 32), e2eeVersion: '2' } }));
});

it('allows an explicitly manual media send through a monitor only binding', async () => {
  const monitor = await fixture({ mode: 'MONITOR_ONLY', objIds: ['OID_F'] });
  await monitor.adapter.sendMedia({ chatType: 'direct', chatId: peer }, { kind: 'file', bytes: Buffer.from('doc'), fileName: 'report.pdf' }, lease, true);
  expect(monitor.order).toEqual([expect.stringMatching(/^POST \/r\/talk\/emf\/reqid-/), 'encryptE2EEMessage', 'sendMessage']);
  expect(monitor.send).toHaveBeenCalledOnce();
});

it('fails the upload when the preview object id does not match, without sending', async () => {
  const { adapter, send } = await fixture({ objIds: ['OID_1', 'OID_2'] });
  await expect(adapter.sendMedia({ chatType: 'direct', chatId: peer }, { kind: 'image', bytes: Buffer.from('x'), fileName: 'a.png' }, lease))
    .rejects.toBeInstanceOf(MediaUploadFailedError);
  expect(send).not.toHaveBeenCalled();
});

it('fails the upload on an HTTP error or a missing object id, without sending', async () => {
  const http = await fixture({ status: 500 });
  await expect(http.adapter.sendMedia({ chatType: 'direct', chatId: peer }, { kind: 'file', bytes: Buffer.from('x'), fileName: 'a.bin' }, lease))
    .rejects.toBeInstanceOf(MediaUploadFailedError);
  expect(http.send).not.toHaveBeenCalled();
  const missing = await fixture({ objIds: [''] });
  await expect(missing.adapter.sendMedia({ chatType: 'direct', chatId: peer }, { kind: 'file', bytes: Buffer.from('x'), fileName: 'a.bin' }, lease))
    .rejects.toBeInstanceOf(MediaUploadFailedError);
  expect(missing.send).not.toHaveBeenCalled();
});

it('lets a sendMessage failure propagate as a non-upload error', async () => {
  const { adapter, send } = await fixture({ objIds: ['OID_F'] });
  send.mockRejectedValueOnce(new Error('timeout'));
  const outcome = adapter.sendMedia({ chatType: 'direct', chatId: peer }, { kind: 'file', bytes: Buffer.from('x'), fileName: 'a.bin' }, lease);
  await expect(outcome).rejects.toThrow('timeout');
  await expect(outcome).rejects.not.toBeInstanceOf(MediaUploadFailedError);
});

it('denies room, mismatched MID, monitor mode and a stale lease before any POST', async () => {
  const media = { kind: 'file' as const, bytes: Buffer.from('x'), fileName: 'a.bin' };
  const active = await fixture();
  await expect(active.adapter.sendMedia({ chatType: 'room' as never, chatId: `r${'c'.repeat(32)}` }, media, lease)).rejects.toMatchObject({ code: 'SIDE_EFFECT_DENIED' });
  await expect(active.adapter.sendMedia({ chatType: 'direct', chatId: group }, media, lease)).rejects.toMatchObject({ code: 'SIDE_EFFECT_DENIED' });
  await expect(active.adapter.sendMedia({ chatType: 'group', chatId: peer }, media, lease)).rejects.toMatchObject({ code: 'SIDE_EFFECT_DENIED' });
  const monitor = await fixture({ mode: 'MONITOR_ONLY' });
  await expect(monitor.adapter.sendMedia({ chatType: 'direct', chatId: peer }, media, lease)).rejects.toMatchObject({ code: 'SIDE_EFFECT_DENIED' });
  const stale = await fixture({ valid: () => false });
  await expect(stale.adapter.sendMedia({ chatType: 'direct', chatId: peer }, media, lease)).rejects.toMatchObject({ code: 'SIDE_EFFECT_DENIED' });
  for (const item of [active, monitor, stale]) {
    expect(item.physicalTransport).not.toHaveBeenCalled();
    expect(item.send).not.toHaveBeenCalled();
  }
});
