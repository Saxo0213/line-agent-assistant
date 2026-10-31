import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { createLinejsAdapter, downloadLinejsE2eeAttachment } from './linejs-adapter.js';
import { fetchLinejsConversationCatalog } from './linejs-adapter.js';
import { BaseClient, InternalError } from '@evex/linejs/base';
import { Protocols, Thrift as LineThrift } from '@evex/linejs/thrift';
import { createHash, createHmac, randomBytes } from 'node:crypto';
import { storeAttachment } from './attachment-store.js';
import { MessageRepository } from '../../database/src/message-repository.js';
import { LineWorkerLoop } from './worker-loop.js';
import { FakeLineTransport } from './fake-transport.js';
import type { Pool } from 'pg';
import type { AttachmentDownloadIdentity } from './attachment-download.js';
import { normalizeOperation } from './normalizer.js';
import { validateAttachmentMessage } from './attachment-download.js';
import { boundedChatResourceResponseCode, ChatResourceFailure } from './chat-resource-error.js';
import { LineServerRejection } from './line-server-error.js';

it('decodes a physical encrypted sendMessage Talk rejection after one network dispatch', async () => {
  const { E2EE } = await import(new URL('../../../node_modules/@evex/linejs/base/e2ee/mod.js', import.meta.url).href) as {
    E2EE: { prototype: { encryptE2EEMessage: (...args: any[]) => Promise<Buffer[]> } };
  };
  const { LegyEncryptedTransport } = await import(new URL('../../../node_modules/@evex/linejs/base/request/legy.js', import.meta.url).href) as {
    LegyEncryptedTransport: { prototype: { fetch: (request: Request, fetcher: (request: Request) => Promise<Response>,
      options: { endpoint?: string }) => Promise<Response> } };
  };
  const secret = 'token=private MID=u12345678901234567890123456789012 text=private';
  const encrypt = vi.spyOn(E2EE.prototype, 'encryptE2EEMessage').mockResolvedValue([Buffer.from([1])]);
  const legy = vi.spyOn(LegyEncryptedTransport.prototype, 'fetch').mockImplementation(async (_request, fetcher, options) => {
    await fetcher(new Request(options.endpoint ?? 'https://gf.line.naver.jp/enc', { method: 'POST', body: 'fixture' }));
    return await linejsTalkRejectionResponse('sendMessage', 82, secret);
  });
  const physicalTransport = vi.fn(async () => new Response());
  const adapter = await createLinejsAdapter({ ...lease, mode: 'ACTIVE_CONTROL', validateLease: () => true, physicalTransport });
  await adapter.installSecrets({ token: jwt, qrCert: null, e2eeStorage: null });
  try {
    const error = await adapter.send({ chatType: 'direct', chatId: 'u-peer' }, 'hello', null, lease)
      .catch((value: unknown) => value);
    expect(error).toBeInstanceOf(LineServerRejection);
    expect(error).toMatchObject({ code: 'LINE_TALK_E2EE_RETRY_ENCRYPT', upstreamCode: 82,
      message: 'LINE_TALK_E2EE_RETRY_ENCRYPT' });
    expect(JSON.stringify(error)).not.toContain(secret);
    expect(physicalTransport).toHaveBeenCalledOnce();
    expect(legy).toHaveBeenCalledOnce();
  } finally { adapter.revoke(); encrypt.mockRestore(); legy.mockRestore(); }
});

it('decodes one physical sync Talk rejection without retaining its private reason', async () => {
  const { LegyEncryptedTransport } = await import(new URL('../../../node_modules/@evex/linejs/base/request/legy.js', import.meta.url).href) as {
    LegyEncryptedTransport: { prototype: { fetch: (request: Request, fetcher: (request: Request) => Promise<Response>,
      options: { endpoint?: string }) => Promise<Response> } };
  };
  const secret = 'token=private MID=u12345678901234567890123456789012';
  const legy = vi.spyOn(LegyEncryptedTransport.prototype, 'fetch').mockImplementation(async (_request, fetcher, options) => {
    await fetcher(new Request(options.endpoint ?? 'https://gf.line.naver.jp/enc', { method: 'POST', body: 'fixture' }));
    return await linejsTalkRejectionResponse('sync', 4, secret);
  });
  const physicalTransport = vi.fn(async () => new Response());
  const adapter = await createLinejsAdapter({ ...lease, mode: 'MONITOR_ONLY', validateLease: () => false, physicalTransport });
  await adapter.installSecrets({ token: jwt, qrCert: null, e2eeStorage: null });
  try {
    const error = await adapter.sync(cursor).catch((value: unknown) => value);
    expect(error).toMatchObject({ code: 'LINE_TALK_EXCESSIVE_ACCESS', upstreamCode: 4 });
    expect(physicalTransport).toHaveBeenCalledOnce();
    expect(legy).toHaveBeenCalledOnce();
    expect(JSON.stringify(error)).not.toContain(secret);
  } finally { adapter.revoke(); legy.mockRestore(); }
});


it('preserves an E2EE preparation Talk rejection before sendMedia reaches sendMessage', async () => {
  const { E2EE } = await import(new URL('../../../node_modules/@evex/linejs/base/e2ee/mod.js', import.meta.url).href) as {
    E2EE: { prototype: { encryptByKeyMaterial: (...args: any[]) => Promise<unknown>;
      encryptE2EEMessage: (...args: any[]) => Promise<Buffer[]> } };
  };
  const { LineObs } = await import(new URL('../../../node_modules/@evex/linejs/base/obs/mod.js', import.meta.url).href) as {
    LineObs: { prototype: { uploadObjectForService: (...args: any[]) => Promise<unknown> } };
  };
  const { TalkService } = await import(new URL('../../../node_modules/@evex/linejs/base/service/talk/mod.js', import.meta.url).href) as {
    TalkService: { prototype: { sendMessage: (...args: any[]) => Promise<unknown> } };
  };
  const { LegyEncryptedTransport } = await import(new URL('../../../node_modules/@evex/linejs/base/request/legy.js', import.meta.url).href) as {
    LegyEncryptedTransport: { prototype: { fetch: (request: Request, fetcher: (request: Request) => Promise<Response>,
      options: { endpoint?: string }) => Promise<Response> } };
  };
  const secret = 'token=private MID=u12345678901234567890123456789012 text=private';
  const encryptData = vi.spyOn(E2EE.prototype, 'encryptByKeyMaterial').mockResolvedValue({
    keyMaterial: Buffer.alloc(32, 1), encryptedData: Buffer.from([1, 2, 3]) });
  const upload = vi.spyOn(LineObs.prototype, 'uploadObjectForService').mockResolvedValue({ objId: 'uploaded-once' });
  const encryptMessage = vi.spyOn(E2EE.prototype, 'encryptE2EEMessage').mockImplementation(async function (this: { client: BaseClient }) {
    await this.client.talk.getLastE2EEPublicKeys({ chatMid: 'u-peer' });
    return [Buffer.from([1])];
  });
  const sendMessage = vi.spyOn(TalkService.prototype, 'sendMessage');
  const legy = vi.spyOn(LegyEncryptedTransport.prototype, 'fetch').mockImplementation(async (_request, fetcher, options) => {
    await fetcher(new Request(options.endpoint ?? 'https://gf.line.naver.jp/enc', { method: 'POST', body: 'fixture' }));
    return await linejsTalkRejectionResponse('getLastE2EEPublicKeys', 84, secret);
  });
  const physicalTransport = vi.fn(async () => new Response());
  const adapter = await createLinejsAdapter({ ...lease, mode: 'ACTIVE_CONTROL', validateLease: () => true, physicalTransport });
  await adapter.installSecrets({ token: jwt, qrCert: null, e2eeStorage: null });
  try {
    const error = await adapter.sendMedia({ chatType: 'direct', chatId: 'u-peer' },
      { kind: 'file', bytes: Buffer.from([9]), fileName: 'safe.bin' }, lease).catch((value: unknown) => value);
    expect(error).toBeInstanceOf(LineServerRejection);
    expect(error).toMatchObject({ code: 'LINE_TALK_E2EE_UPDATE_RECEIVER_KEY', upstreamCode: 84,
      message: 'LINE_TALK_E2EE_UPDATE_RECEIVER_KEY' });
    expect(upload).toHaveBeenCalledOnce();
    expect(encryptMessage).toHaveBeenCalledOnce();
    expect(legy).toHaveBeenCalledOnce();
    expect(physicalTransport).toHaveBeenCalledOnce();
    expect(sendMessage).not.toHaveBeenCalled();
    expect(JSON.stringify(error)).not.toContain(secret);
  } finally { adapter.revoke(); encryptData.mockRestore(); upload.mockRestore(); encryptMessage.mockRestore(); sendMessage.mockRestore(); legy.mockRestore(); }
});

it.each([
  ['unsendMessage', 'NOT_YOUR_MESSAGE', 28],
  ['react', 'MESSAGE_NOT_FOUND', 64],
  ['getRecentMessagesV2', 'EXPIRED_REVISION', 52],
] as const)('decodes one native Talk %s rejection with a fixed %s code', async (method, name, number) => {
  const privateText = 'token=private MID=u12345678901234567890123456789012 body=private';
  const { RequestClient } = await import(new URL('../../../node_modules/@evex/linejs/base/request/mod.js', import.meta.url).href) as {
    RequestClient: { prototype: { request: (...args: any[]) => Promise<unknown> } };
  };
  const native = new InternalError('RequestError', privateText, { code: name, reason: privateText,
    parameterMap: { private: privateText }, rawBody: privateText });
  const request = vi.spyOn(RequestClient.prototype, 'request').mockRejectedValue(native);
  const physicalTransport = vi.fn(async () => { throw new Error('unexpected physical request'); });
  const adapter = await createLinejsAdapter({ ...lease, mode: 'ACTIVE_CONTROL', validateLease: () => true, physicalTransport });
  await adapter.installSecrets({ token: jwt, qrCert: null, e2eeStorage: null });
  try {
    const failed = method === 'unsendMessage'
      ? adapter.unsend({ chatType: 'direct', chatId: 'u-peer' }, '9', lease)
      : method === 'react'
        ? adapter.react({ chatType: 'direct', chatId: 'u-peer' }, '9', 'NICE', lease)
        : adapter.history({ chatType: 'direct', chatId: 'u-peer' }, null, 10);
    const error = await failed.catch((value: unknown) => value);
    expect(error).toBeInstanceOf(LineServerRejection);
    expect(error).toMatchObject({ code: `LINE_TALK_${name}`, upstreamCode: number });
    expect((error as Error).message).not.toContain(privateText);
    expect(JSON.stringify(error)).not.toContain(privateText);
    expect(request).toHaveBeenCalledOnce();
    expect(request.mock.calls[0]?.[1]).toBe(method);
    expect(request.mock.calls[0]?.[4]).toBe('/S4');
    expect(physicalTransport).not.toHaveBeenCalled();
  } finally { adapter.revoke(); request.mockRestore(); }
});

it.each([
  [{ code: 0 }, 0],
  [{ code: 73 }, 73],
  [{ code: -73 }, -73],
  [{}, 'missing'],
  [{ code: 'private response' }, 'non_numeric'],
  [{ code: 1_000_000_001 }, 'non_numeric'],
])('classifies only a bounded numeric LINEJS Note response code (%j)', (response, expected) => {
  expect(boundedChatResourceResponseCode(response.code, Object.hasOwn(response, 'code'))).toBe(expected);
});

it.each([
  [{ code: 403, message: 'private response text', result: {} }, 403],
  [{ result: {} }, 'missing'],
  [{ code: 'private response text', result: {} }, 'non_numeric'],
])('preserves a safe code from a fake LINEJS Note list response (%j)', async (response, expectedCode) => {
  const { Login } = await import(new URL('../../../node_modules/@evex/linejs/base/login/mod.js', import.meta.url).href) as {
    Login: { prototype: { login: (...args: any[]) => Promise<unknown> } };
  };
  const { Timeline } = await import(new URL('../../../node_modules/@evex/linejs/base/timeline/mod.js', import.meta.url).href) as {
    Timeline: { prototype: { initTimeline: (...args: any[]) => Promise<unknown>; listPost: (...args: any[]) => Promise<unknown> } };
  };
  const login = vi.spyOn(Login.prototype, 'login').mockImplementation(async function (this: { client: BaseClient }) {
    this.client.profile = { mid: `u${'a'.repeat(32)}` } as never;
  });
  const init = vi.spyOn(Timeline.prototype, 'initTimeline').mockResolvedValue(undefined);
  const list = vi.spyOn(Timeline.prototype, 'listPost').mockResolvedValue(response as never);
  const adapter = await createLinejsAdapter({ ...lease, mode: 'MONITOR_ONLY', validateLease: () => false,
    physicalTransport: async () => { throw new Error('fake LINEJS response must not use the network'); } });
  await adapter.installSecrets({ token: jwt, qrCert: null, e2eeStorage: null });
  try {
    await adapter.loginToken(jwt);
    const failure = await adapter.readChatResource({ type: 'chatResourceRead', ...lease, chatType: 'group', chatId: attachmentIdentity.chatId,
      requestId: 'note-response-code', action: 'listNotes', timeoutMs: 5000 }, { signal: new AbortController().signal })
      .catch((error: unknown) => error);
    expect(failure).toMatchObject({ category: 'response_code_invalid', responseCode: expectedCode });
    expect(failure).toBeInstanceOf(ChatResourceFailure);
    expect((failure as Error).message).toBe('response_code_invalid');
    expect(JSON.stringify(failure)).not.toContain('private response text');
    expect(list).toHaveBeenCalledWith({ homeId: attachmentIdentity.chatId });
  } finally { login.mockRestore(); init.mockRestore(); list.mockRestore(); }
});

it('normalizes a successful fake LINEJS Note list response without using the network', async () => {
  const { Login } = await import(new URL('../../../node_modules/@evex/linejs/base/login/mod.js', import.meta.url).href) as {
    Login: { prototype: { login: (...args: any[]) => Promise<unknown> } };
  };
  const { Timeline } = await import(new URL('../../../node_modules/@evex/linejs/base/timeline/mod.js', import.meta.url).href) as {
    Timeline: { prototype: { initTimeline: (...args: any[]) => Promise<unknown>; listPost: (...args: any[]) => Promise<unknown> } };
  };
  const login = vi.spyOn(Login.prototype, 'login').mockImplementation(async function (this: { client: BaseClient }) {
    this.client.profile = { mid: `u${'a'.repeat(32)}` } as never;
  });
  const init = vi.spyOn(Timeline.prototype, 'initTimeline').mockResolvedValue(undefined);
  const list = vi.spyOn(Timeline.prototype, 'listPost').mockResolvedValue({ code: 0, result: {
    posts: [{ postId: 'post-1', createdTime: 12, contents: { text: 'Safe title' } }], nextCursor: 'next-1',
  } } as never);
  const adapter = await createLinejsAdapter({ ...lease, mode: 'MONITOR_ONLY', validateLease: () => false,
    physicalTransport: async () => { throw new Error('fake LINEJS response must not use the network'); } });
  await adapter.installSecrets({ token: jwt, qrCert: null, e2eeStorage: null });
  try {
    await adapter.loginToken(jwt);
    await expect(adapter.readChatResource({ type: 'chatResourceRead', ...lease, chatType: 'group', chatId: attachmentIdentity.chatId,
      requestId: 'note-success', action: 'listNotes', timeoutMs: 5000 }, { signal: new AbortController().signal }))
      .resolves.toEqual({ notes: [{ postId: 'post-1', createdTime: 12, text: 'Safe title', content: { text: 'Safe title' } }], nextCursor: 'next-1' });
  } finally { login.mockRestore(); init.mockRestore(); list.mockRestore(); }
});

it.each([
  [{ photos: [], hasMore: false, nextCursor: 'v1_advanced' }, 'v1_requested', null,
    { rawPhotoCount: 0, hasMorePresent: true, hasMore: false, nextCursorRelation: 'advanced' }],
  [{ photos: [], hasMore: false, nextCursor: 'v1_requested' }, 'v1_requested', null,
    { rawPhotoCount: 0, hasMorePresent: true, hasMore: false, nextCursorRelation: 'same' }],
  [{ photos: [], hasMore: true, cursor: 'v1_next' }, null, 'v1_next', { rawPhotoCount: 0, hasMorePresent: true, hasMore: true, nextCursorRelation: 'absent' }],
  [{ photos: [], nextCursor: 'v1_prev' }, 'v1_prev', 'v1_prev', { rawPhotoCount: 0, hasMorePresent: false, nextCursorRelation: 'same' }],
  [{ photos: [{ oid: 'private-photo-oid', photoId: 'private-photo-id' }], nextCursor: 'v1_next' }, null, 'v1_next',
    { rawPhotoCount: 1, hasMorePresent: false, nextCursorRelation: 'advanced' }],
])('captures bounded Moa photo-page shape without cursor or photo identifiers (%j)', async (result, requestCursor, expectedCursor, expectedShape) => {
  const { Login } = await import(new URL('../../../node_modules/@evex/linejs/base/login/mod.js', import.meta.url).href) as {
    Login: { prototype: { login: (...args: any[]) => Promise<unknown> } };
  };
  const { MoaService } = await import(new URL('../../../node_modules/@evex/linejs/base/service/moa/mod.js', import.meta.url).href) as {
    MoaService: { prototype: { getAlbumChannelToken: (...args: any[]) => Promise<string>; getPhotos: (...args: any[]) => Promise<unknown> } };
  };
  const login = vi.spyOn(Login.prototype, 'login').mockImplementation(async function (this: { client: BaseClient }) {
    this.client.profile = { mid: `u${'a'.repeat(32)}` } as never;
    this.client.authToken = jwt;
  });
  const token = vi.spyOn(MoaService.prototype, 'getAlbumChannelToken').mockResolvedValue('fixture-token');
  const photos = vi.spyOn(MoaService.prototype, 'getPhotos').mockResolvedValue({ code: 0, result } as never);
  const adapter = await createLinejsAdapter({ ...lease, mode: 'MONITOR_ONLY', validateLease: () => false,
    physicalTransport: async () => { throw new Error('fake Moa response must not use the network'); } });
  try {
    await adapter.loginToken(jwt);
    await expect(adapter.readChatResource({ type: 'chatResourceRead', ...lease, chatType: 'group', chatId: attachmentIdentity.chatId,
      requestId: 'photo-page-completion', action: 'listAlbumPhotos', albumId: 'album-1', cursor: requestCursor ?? undefined, timeoutMs: 5000 },
    { signal: new AbortController().signal })).resolves.toMatchObject({ nextCursor: expectedCursor, photoPageShape: expectedShape });
    expect(photos).toHaveBeenCalledOnce();
  } finally { adapter.revoke(); login.mockRestore(); token.mockRestore(); photos.mockRestore(); }
});

it.each([
  { label: 'LINE response code', nativeError: new InternalError('MoaError', 'private Moa message token=secret', { code: 102001, message: 'private Moa message token=secret' }), upstreamCode: 102001, upstreamStatus: undefined },
  { label: 'HTTP status', nativeError: new InternalError('MoaError', 'private HTTP message token=secret', { status: 503 }), upstreamCode: undefined, upstreamStatus: 503 },
  { label: 'invalid zero status and fractional code', nativeError: new InternalError('MoaError', 'private invalid response token=secret', { status: 0, code: 1.5 }), upstreamCode: 'non_numeric', upstreamStatus: undefined },
  { label: 'invalid high status', nativeError: new InternalError('MoaError', 'private invalid status token=secret', { status: 799 }), upstreamCode: undefined, upstreamStatus: undefined },
])('preserves only bounded Moa failure facts ($label)', async ({ nativeError, upstreamCode, upstreamStatus }) => {
  const { Login } = await import(new URL('../../../node_modules/@evex/linejs/base/login/mod.js', import.meta.url).href) as {
    Login: { prototype: { login: (...args: any[]) => Promise<unknown> } };
  };
  const { MoaService } = await import(new URL('../../../node_modules/@evex/linejs/base/service/moa/mod.js', import.meta.url).href) as {
    MoaService: { prototype: { getAlbumChannelToken: (...args: any[]) => Promise<string>; getAlbums: (...args: any[]) => Promise<unknown> } };
  };
  const login = vi.spyOn(Login.prototype, 'login').mockImplementation(async function (this: { client: BaseClient }) {
    this.client.profile = { mid: `u${'a'.repeat(32)}` } as never;
    this.client.authToken = jwt;
  });
  const token = vi.spyOn(MoaService.prototype, 'getAlbumChannelToken').mockResolvedValue('fixture-token');
  const albums = vi.spyOn(MoaService.prototype, 'getAlbums').mockRejectedValue(nativeError);
  const adapter = await createLinejsAdapter({ ...lease, mode: 'MONITOR_ONLY', validateLease: () => false,
    physicalTransport: async () => { throw new Error('fake Moa failure must not use the network'); } });
  try {
    await adapter.loginToken(jwt);
    const failure = await adapter.readChatResource({ type: 'chatResourceRead', ...lease, chatType: 'group', chatId: attachmentIdentity.chatId,
      requestId: 'album-moa-failure', action: 'listAlbums', timeoutMs: 5000 }, { signal: new AbortController().signal })
      .catch((error: unknown) => error);
    expect(failure).toMatchObject({ category: upstreamCode === undefined ? 'list_get_transport_failure' : 'response_code_invalid',
      failureKind: 'linejs_internal', ...(upstreamCode === undefined ? {} : { upstreamCode }),
      ...(upstreamStatus === undefined ? {} : { upstreamStatus }) });
    expect(JSON.stringify(failure)).not.toContain('private Moa message');
    expect(JSON.stringify(failure)).not.toContain('secret');
    expect(token).toHaveBeenCalledOnce();
    expect(albums).toHaveBeenCalledOnce();
  } finally { adapter.revoke(); login.mockRestore(); token.mockRestore(); albums.mockRestore(); }
});

const openablePng = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+ip1sAAAAASUVORK5CYII=', 'base64');
const archivedOid = `OID_123${'a'.repeat(56)}`;

// Exercise the production SQL-row projection without connecting to a database.
async function downloadArchivedFixture(adapter: Awaited<ReturnType<typeof createLinejsAdapter>>,
  message: Record<string, unknown>, identity: AttachmentDownloadIdentity,
  plaintext: Buffer) {
  message = { ...message, contentMetadata: { ...message.contentMetadata as Record<string, unknown>, OID: archivedOid } };
  expect(archivedOid).toHaveLength(63);
  expect(message.chunks).toHaveLength(5);
  const now = new Date('2026-10-18T00:00:00.000Z');
  const row = { attachment_id: '11111111-1111-4111-8111-111111111111', external_attachment_id: '9',
    account_id: identity.accountId, chat_type: identity.chatType, chat_id: identity.chatId, message_id: '9', kind: identity.kind,
    name: 'fixture.bin', mime_type: null, status: 'downloading', relative_path: null, sha256: null, size_bytes: null,
    error: null, occurred_at: now, retry_count: 1, retry_after: null, created_at: now, expires_at: null, updated_at: now,
    raw: { type: 26, revision: '9', message } };
  const repository = new MessageRepository({ query: vi.fn().mockResolvedValue({ rows: [row] }) } as unknown as Pool);
  const attachment = (await repository.getAttachment(row.attachment_id))!;
  expect(attachment.lineMessage).toEqual(message);
  const root = await mkdtemp(join(tmpdir(), 'archived-attachment-worker-'));
  temporary.push(root);
  const transport = new FakeLineTransport({ ownMid: identity.ownMid, displayName: 'Fixture' });
  transport.download = adapter.download.bind(adapter);
  const events: any[] = [];
  const worker = new LineWorkerLoop({ transport, emit: (event) => { events.push(event); }, validateLease: () => false,
    attachmentRoot: root, minFreeBytes: 0, attachmentRuntime: { unsafeAllowPortableFilesystemOnWindowsForTests: true } });
  await worker.handle({ type: 'init', ...lease, protocolVersion: 4, mode: 'MONITOR_ONLY', durableCursor: cursor });
  await worker.handle({ type: 'loginQr', ...lease, loginAttemptId: 'synthetic-login' });
  await worker.handle({ type: 'downloadAttachment', ...lease, chatType: attachment.chatType, chatId: attachment.chatId,
    attachmentId: attachment.attachmentId, externalAttachmentId: attachment.externalAttachmentId,
    messageId: attachment.messageId, kind: attachment.kind, occurredAt: attachment.occurredAt, lineMessage: attachment.lineMessage,
    requestId: 'archive-download', attemptToken: 'b7c252f7-8b1e-4fac-a9cc-69bc206c09a1',
    originalFileName: 'fixture.bin', maxBytes: 1024, timeoutMs: 5000 });
  const result = events.at(-1);
  expect(result).toMatchObject({ type: 'attachmentResult', status: 'ready', sizeBytes: plaintext.length });
  expect(await readFile(join(root, result.relativePath))).toEqual(plaintext);
  await worker.handle({ type: 'stop', ...lease });
}

const jwt = [Buffer.from('{"alg":"HS256"}').toString('base64url'), Buffer.from('{"sub":"u-self"}').toString('base64url'), 'signature'].join('.');
const lease = { accountId: 'account-A', workerInstanceId: 'worker-1', controlEpoch: 7 };
const cursor = { version: 1 as const, revision: '0', globalRev: '0', individualRev: '0' };
const temporary: string[] = [];
afterEach(async () => { for (const path of temporary.splice(0)) await rm(path, { recursive: true, force: true }); });
async function linejsRefreshResponse(accessToken: string, refreshToken: string): Promise<Response> {
  const { Protocols } = await import(new URL('../../../node_modules/@evex/linejs/base/thrift/mod.js', import.meta.url).href) as {
    Protocols: Record<number, any>;
  };
  const client = new BaseClient({ device: 'DESKTOPWIN' });
  const body = Buffer.from(client.thrift.writeThrift([[12, 0, [
    [11, 1, accessToken], [10, 2, 3600], [10, 4, Math.floor(Date.now() / 1000)], [11, 5, refreshToken],
  ]]], 'refresh', Protocols[4]!));
  body[1] = 0x41; // Compact protocol version 1 with a REPLY message type.
  client.thrift.readThrift(body, Protocols[4]!);
  return new Response(body);
}
async function linejsLogoutResponse(): Promise<Response> {
  const client = new BaseClient({ device: 'DESKTOPWIN' });
  const body = Buffer.from(client.thrift.writeThrift([], 'logoutZ', Protocols[4]!));
  body[1] = 0x41;
  return new Response(body);
}
async function linejsLogoutExceptionResponse(code: number, message = 'server rejection'): Promise<Response> {
  const client = new BaseClient({ device: 'DESKTOPWIN' });
  const body = Buffer.from(client.thrift.writeThrift([[12, 1, [[8, 1, code], [11, 2, message]]]], 'logoutZ', Protocols[4]!));
  body[1] = 0x41;
  return new Response(body);
}
async function linejsRefreshDemandResponse(methodName: string): Promise<Response> {
  const { Protocols } = await import(new URL('../../../node_modules/@evex/linejs/base/thrift/mod.js', import.meta.url).href) as {
    Protocols: Record<number, any>;
  };
  const client = new BaseClient({ device: 'DESKTOPWIN' });
  const body = Buffer.from(client.thrift.writeThrift([[12, 1, [[8, 1, 119], [11, 2, 'refresh required']]]], methodName, Protocols[4]!));
  body[1] = 0x41; // Compact protocol version 1 with a REPLY message type.
  const parsed = client.thrift.readThrift(body, Protocols[4]!);
  client.thrift.rename_data(parsed);
  expect(parsed.data.e.code).toBe('MUST_REFRESH_V3_TOKEN');
  return new Response(body);
}
async function linejsTalkRejectionResponse(methodName: string, numericCode: number, privateText: string): Promise<Response> {
  const client = new BaseClient({ device: 'DESKTOPWIN' });
  const body = Buffer.from(client.thrift.writeThrift([[12, 1, [[8, 1, numericCode], [11, 2, privateText],
    [13, 3, [11, 11, { private: privateText }]]]]], methodName, Protocols[4]!));
  body[1] = 0x41; // Compact REPLY, as returned after the pinned LEGY envelope is decrypted.
  return new Response(body);
}
async function linejsProfileResponse(mid: string): Promise<Response> {
  const { Protocols } = await import(new URL('../../../node_modules/@evex/linejs/base/thrift/mod.js', import.meta.url).href) as {
    Protocols: Record<number, any>;
  };
  const client = new BaseClient({ device: 'DESKTOPWIN' });
  const body = Buffer.from(client.thrift.writeThrift([[12, 0, [[11, 1, mid], [11, 20, 'Agent']]]], 'getProfile', Protocols[4]!));
  body[1] = 0x41;
  return new Response(body);
}

it('routes logoutZ through the single authenticated /RS4 gate request', async () => {
  const requests: Request[] = [];
  const adapter = await createLinejsAdapter({ ...lease, mode: 'MONITOR_ONLY', validateLease: () => false,
    physicalTransport: async (request) => { requests.push(request); return linejsLogoutResponse(); } });
  await adapter.installSecrets({ token: jwt, qrCert: null, e2eeStorage: null });
  try {
    await adapter.logoutServer();
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({ method: 'POST', redirect: 'error' });
    expect(new URL(requests[0]!.url).pathname).toBe('/RS4');
    expect(requests[0]!.headers.get('x-line-access')).toBe(jwt);
    expect(new Uint8Array(await requests[0]!.clone().arrayBuffer())).toEqual(new Uint8Array([0x82, 0x21, 0x00, 0x07,
      0x6c, 0x6f, 0x67, 0x6f, 0x75, 0x74, 0x5a, 0x00]));
  } finally { adapter.revoke(); }
});

it('waits for an in-flight scheduled refresh before logging out with the rotated token', async () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-10-26T00:00:00.000Z'));
  const randomSpy = vi.spyOn(Math, 'random').mockReturnValue(0.5);
  const refreshedToken = [Buffer.from('{"alg":"HS256"}').toString('base64url'),
    Buffer.from('{"sub":"u-self","v":"logout-race-refresh"}').toString('base64url'), 'signature'].join('.');
  const requests: Request[] = [];
  let releaseRefresh!: (response: Response) => void;
  const credentials = vi.fn();
  const adapter = await createLinejsAdapter({ ...lease, mode: 'MONITOR_ONLY', validateLease: () => false,
    physicalTransport: async (request) => {
      requests.push(request);
      if (new URL(request.url).pathname === '/EXT/auth/tokenrefresh/v1') {
        return await new Promise<Response>((resolve) => { releaseRefresh = resolve; });
      }
      return linejsLogoutResponse();
    } });
  adapter.on('credentials', credentials);
  try {
    await adapter.installSecrets({ token: jwt, qrCert: null,
      e2eeStorage: { refreshToken: 'refresh-before-logout', expire: Math.floor(Date.now() / 1000) + 1, retained: 'kept' } });
    await vi.advanceTimersByTimeAsync(500);
    await vi.waitFor(() => expect(requests).toHaveLength(1));

    const logout = adapter.logoutServer();
    await Promise.resolve();
    expect(requests).toHaveLength(1);

    releaseRefresh(await linejsRefreshResponse(refreshedToken, 'refresh-after-logout'));
    await logout;

    expect(credentials).toHaveBeenCalledOnce();
    expect(credentials).toHaveBeenCalledWith({ token: refreshedToken, e2eeStorage: {
      refreshToken: 'refresh-after-logout', expire: expect.any(Number), retained: 'kept',
    } });
    expect(requests).toHaveLength(2);
    expect(new URL(requests[1]!.url).pathname).toBe('/RS4');
    expect(requests[1]!.headers.get('x-line-access')).toBe(refreshedToken);
    expect(vi.getTimerCount()).toBe(0);
  } finally { adapter.revoke(); randomSpy.mockRestore(); vi.useRealTimers(); }
});

it.each(['server rejection', 'logout deadline'] as const)('keeps one refresh scheduled from rotated credentials after an overlapping %s', async (outcome) => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-10-26T00:00:00.000Z'));
  const setTimeoutSpy = vi.spyOn(globalThis, 'setTimeout');
  const randomSpy = vi.spyOn(Math, 'random').mockReturnValue(0.5);
  const refreshedToken = [Buffer.from('{"alg":"HS256"}').toString('base64url'),
    Buffer.from('{"sub":"u-self","v":"logout-failure-refresh"}').toString('base64url'), 'signature'].join('.');
  const requests: Request[] = [];
  let releaseRefresh!: (response: Response) => void;
  const credentials = vi.fn();
  const adapter = await createLinejsAdapter({ ...lease, mode: 'MONITOR_ONLY', validateLease: () => false,
    physicalTransport: async (request) => {
      requests.push(request);
      if (new URL(request.url).pathname === '/EXT/auth/tokenrefresh/v1') {
        return await new Promise<Response>((resolve) => { releaseRefresh = resolve; });
      }
      return outcome === 'server rejection' ? linejsLogoutExceptionResponse(4) : linejsLogoutResponse();
    } });
  adapter.on('credentials', credentials);
  try {
    await adapter.installSecrets({ token: jwt, qrCert: null,
      e2eeStorage: { refreshToken: 'refresh-before-logout', expire: Math.floor(Date.now() / 1000) + 1, retained: 'kept' } });
    await vi.advanceTimersByTimeAsync(500);
    await vi.waitFor(() => expect(requests).toHaveLength(1));

    const controller = new AbortController();
    const logout = adapter.logoutServer(controller.signal);
    if (outcome === 'logout deadline') {
      controller.abort(new Error('logout deadline'));
      await expect(logout).rejects.toThrow('logout deadline');
    }
    releaseRefresh(await linejsRefreshResponse(refreshedToken, 'refresh-after-logout'));
    if (outcome === 'server rejection') await expect(logout).rejects.toThrow('LINE_LOGOUT_SERVER_REJECTED');
    await vi.waitFor(() => expect(credentials).toHaveBeenCalledOnce());

    expect(requests).toHaveLength(outcome === 'server rejection' ? 2 : 1);
    expect(setTimeoutSpy).toHaveBeenCalledTimes(2);
    expect(setTimeoutSpy.mock.calls[1]?.[1]).toBeGreaterThan(3_500_000);
    expect(vi.getTimerCount()).toBe(1);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(requests).toHaveLength(outcome === 'server rejection' ? 2 : 1);
    expect(vi.getTimerCount()).toBe(1);
  } finally { adapter.revoke(); randomSpy.mockRestore(); vi.useRealTimers(); }
});

it.each([
  ['ordinary rejection', 4],
  ['refresh-required rejection', 119],
] as const)('rejects pinned logoutZ wire exception %s without losing auth', async (_name, code) => {
  const requests: Request[] = [];
  let attempts = 0;
  const adapter = await createLinejsAdapter({ ...lease, mode: 'MONITOR_ONLY', validateLease: () => false,
    physicalTransport: async (request) => {
      requests.push(request);
      return attempts++ === 0 ? linejsLogoutExceptionResponse(code) : linejsLogoutResponse();
    } });
  await adapter.installSecrets({ token: jwt, qrCert: null,
    e2eeStorage: { refreshToken: 'refresh-existing', expire: Math.floor(Date.now() / 1000) + 3_600 } });
  try {
    await expect(adapter.logoutServer()).rejects.toThrow('LINE_LOGOUT_SERVER_REJECTED');
    expect(requests).toHaveLength(1);
    await adapter.logoutServer();
    expect(requests).toHaveLength(2);
    expect(requests.map((request) => request.headers.get('x-line-access'))).toEqual([jwt, jwt]);
  } finally { adapter.revoke(); }
});

it('treats only the pinned auth invalidation TalkException as server logout confirmation', async () => {
  const authInvalidated = vi.fn();
  const adapter = await createLinejsAdapter({ ...lease, mode: 'MONITOR_ONLY', validateLease: () => false,
    physicalTransport: async () => linejsLogoutExceptionResponse(1) });
  adapter.on('authInvalidated', authInvalidated);
  await adapter.installSecrets({ token: jwt, qrCert: null,
    e2eeStorage: { refreshToken: 'refresh-existing', expire: Math.floor(Date.now() / 1000) + 3_600 } });
  try {
    await expect(adapter.logoutServer()).resolves.toBeUndefined();
    expect(authInvalidated).toHaveBeenCalledOnce();
  } finally { adapter.revoke(); }
});

it('rejects malformed pinned logoutZ wire responses before native token clearing', async () => {
  const adapter = await createLinejsAdapter({ ...lease, mode: 'MONITOR_ONLY', validateLease: () => false,
    physicalTransport: async () => new Response(new Uint8Array([0x82, 0x41, 0x00])) });
  await adapter.installSecrets({ token: jwt, qrCert: null,
    e2eeStorage: { refreshToken: 'refresh-existing', expire: Math.floor(Date.now() / 1000) + 3_600 } });
  try {
    await expect(adapter.logoutServer()).rejects.toThrow('LINE_LOGOUT_MALFORMED_RESPONSE');
  } finally { adapter.revoke(); }
});

it.each(['headers', 'body'] as const)('aborts stalled logout %s and a late response cannot complete the expired attempt', async (stall) => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-10-26T00:00:00.000Z'));
  const requests: Request[] = [];
  let releaseHeaders!: (response: Response) => void;
  let bodyController: ReadableStreamDefaultController<Uint8Array> | undefined;
  const adapter = await createLinejsAdapter({ ...lease, mode: 'MONITOR_ONLY', validateLease: () => false,
    physicalTransport: async (request) => {
      requests.push(request);
      if (requests.length > 1) return linejsLogoutResponse();
      if (stall === 'headers') return await new Promise<Response>((resolve) => { releaseHeaders = resolve; });
      request.signal.addEventListener('abort', () => bodyController?.error(new Error('body aborted')), { once: true });
      return new Response(new ReadableStream<Uint8Array>({ start(controller) { bodyController = controller; } }));
    } });
  await adapter.installSecrets({ token: jwt, qrCert: null,
    e2eeStorage: { refreshToken: 'refresh-existing', expire: Math.floor(Date.now() / 1000) + 3_600 } });
  const controller = new AbortController();
  try {
    const attempt = adapter.logoutServer(controller.signal);
    await vi.waitFor(() => expect(requests).toHaveLength(1));
    expect(requests[0]?.method).toBe('POST');
    const rejected = expect(attempt).rejects.toThrow('logout deadline');
    const timeout = setTimeout(() => controller.abort(new Error('logout deadline')), 500);
    await vi.advanceTimersByTimeAsync(500);
    await rejected;
    expect(requests[0]?.signal.aborted).toBe(true);
    clearTimeout(timeout);
    expect(requests).toHaveLength(1);
    if (stall === 'headers') releaseHeaders(await linejsLogoutResponse());
    const retryController = new AbortController();
    await adapter.logoutServer(retryController.signal);
    expect(requests).toHaveLength(2);
    expect(requests.every((request) => request.method === 'POST')).toBe(true);
  } finally { adapter.revoke(); vi.useRealTimers(); }
});

it('cancels the scheduled refresh timer when server logout confirms auth invalidation', async () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-10-26T00:00:00.000Z'));
  const setTimeoutSpy = vi.spyOn(globalThis, 'setTimeout');
  const clearTimeoutSpy = vi.spyOn(globalThis, 'clearTimeout');
  const invalidation = new InternalError('RequestError', 'fixture LINE auth invalidation', { code: 'NOT_AUTHORIZED_DEVICE' });
  const adapter = await createLinejsAdapter({ ...lease, mode: 'MONITOR_ONLY', validateLease: () => false,
    physicalTransport: async () => { throw invalidation; } });
  const authInvalidated = vi.fn();
  adapter.on('authInvalidated', authInvalidated);
  try {
    await adapter.installSecrets({ token: jwt, qrCert: null,
      e2eeStorage: { refreshToken: 'refresh-existing', expire: Math.floor(Date.now() / 1000) + 3_600 } });
    const timer = setTimeoutSpy.mock.results[0]!.value;
    await adapter.logoutServer();
    expect(authInvalidated).toHaveBeenCalledOnce();
    expect(clearTimeoutSpy).toHaveBeenCalledWith(timer);
    expect(vi.getTimerCount()).toBe(0);
  } finally { adapter.revoke(); vi.useRealTimers(); }
});

it('schedules one refresh from stored expire and persists rotated credentials before scheduling the next refresh', async () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-10-26T00:00:00.000Z'));
  const setTimeoutSpy = vi.spyOn(globalThis, 'setTimeout');
  const clearTimeoutSpy = vi.spyOn(globalThis, 'clearTimeout');
  const randomSpy = vi.spyOn(Math, 'random').mockReturnValue(0.25);
  const nextToken = [Buffer.from('{"alg":"HS256"}').toString('base64url'), Buffer.from('{"sub":"u-self","v":"refreshed"}').toString('base64url'), 'next'].join('.');
  const credentials = vi.fn();
  const refreshFailure = vi.fn();
  const physicalTransport = vi.fn(async () => linejsRefreshResponse(nextToken, 'rotated-refresh'));
  const adapter = await createLinejsAdapter({ ...lease, mode: 'MONITOR_ONLY', validateLease: () => false, physicalTransport });
  adapter.on('credentials', credentials);
  adapter.on('refreshFailure', refreshFailure);
  try {
    const expire = Math.floor(Date.now() / 1000) + 5;
    await adapter.installSecrets({ token: jwt, qrCert: null, e2eeStorage: { refreshToken: 'refresh-old', expire } });
    expect(setTimeoutSpy.mock.calls.map((call) => call[1])).toEqual([4_750]);
    await vi.advanceTimersByTimeAsync(4_750);
    await vi.waitFor(() => expect(credentials).toHaveBeenCalledOnce());
    expect(physicalTransport).toHaveBeenCalledOnce();
    expect(refreshFailure).not.toHaveBeenCalled();
    expect(credentials).toHaveBeenCalledWith(expect.objectContaining({ token: nextToken,
      e2eeStorage: expect.objectContaining({ refreshToken: 'rotated-refresh', expire: expect.any(Number) }) }));
    expect(randomSpy).toHaveBeenCalled();
    expect(setTimeoutSpy.mock.calls[0]?.[1]).toBe(4_750);
    expect(setTimeoutSpy.mock.calls[0]?.[1]).toBeGreaterThanOrEqual(4_000);
    expect(setTimeoutSpy.mock.calls[0]?.[1]).toBeLessThanOrEqual(5_000);
    expect(setTimeoutSpy.mock.calls[1]?.[1]).toBeGreaterThanOrEqual(3_598_950);
    expect(setTimeoutSpy.mock.calls[1]?.[1]).toBeLessThanOrEqual(3_599_000);
    const nextTimer = setTimeoutSpy.mock.results[1]!.value;
    adapter.revoke();
    expect(clearTimeoutSpy).toHaveBeenCalledWith(nextTimer);
    expect(vi.getTimerCount()).toBe(0);
  } finally { adapter.revoke(); randomSpy.mockRestore(); vi.useRealTimers(); }
});

it('does not busy-loop token refresh after a failed physical refresh', async () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-10-26T00:00:00.000Z'));
  const setTimeoutSpy = vi.spyOn(globalThis, 'setTimeout');
  const randomSpy = vi.spyOn(Math, 'random').mockReturnValue(0.5);
  const refreshFailure = vi.fn();
  const physicalTransport = vi.fn(async () => { throw new Error('offline'); });
  const adapter = await createLinejsAdapter({ ...lease, mode: 'MONITOR_ONLY', validateLease: () => false, physicalTransport });
  adapter.on('refreshFailure', refreshFailure);
  try {
    await adapter.installSecrets({ token: jwt, qrCert: null, e2eeStorage: {
      refreshToken: 'refresh-old', expire: Math.floor(Date.now() / 1000) + 2 } });
    expect(setTimeoutSpy.mock.calls[0]?.[1]).toBe(1_500);
    await vi.advanceTimersByTimeAsync(1_500);
    await vi.waitFor(() => expect(refreshFailure).toHaveBeenCalledOnce());
    expect(physicalTransport).toHaveBeenCalledOnce();
    expect(setTimeoutSpy).toHaveBeenCalledOnce();
  } finally { adapter.revoke(); randomSpy.mockRestore(); vi.useRealTimers(); }
});

it.each(['revoke', 'auth-invalidation'] as const)('does not rearm scheduled refresh after an in-flight refresh completes following %s', async (stopKind) => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-10-26T00:00:00.000Z'));
  const setTimeoutSpy = vi.spyOn(globalThis, 'setTimeout');
  const randomSpy = vi.spyOn(Math, 'random').mockReturnValue(0.5);
  const requests: Request[] = [];
  let releaseRefresh!: (response: Response) => void;
  const token = [Buffer.from('{"alg":"HS256"}').toString('base64url'), Buffer.from('{"sub":"u-self","v":"late-refresh"}').toString('base64url'), 'next'].join('.');
  const adapter = await createLinejsAdapter({ ...lease, mode: 'MONITOR_ONLY', validateLease: () => false,
    physicalTransport: async (request) => {
      requests.push(request);
      if (requests.length === 1) return await new Promise<Response>((resolve) => { releaseRefresh = resolve; });
      if (stopKind === 'auth-invalidation') throw new InternalError('RequestError', 'fixture invalidation', { code: 'NOT_AUTHORIZED_DEVICE' });
      return linejsProfileResponse(`u${'a'.repeat(32)}`);
    } });
  const credentials = vi.fn();
  const authInvalidated = vi.fn();
  adapter.on('credentials', credentials);
  adapter.on('authInvalidated', authInvalidated);
  await adapter.installSecrets({ token: jwt, qrCert: null,
    e2eeStorage: { refreshToken: 'refresh-existing', expire: Math.floor(Date.now() / 1000) + 1 } });
  try {
    expect(setTimeoutSpy.mock.calls[0]?.[1]).toBe(500);
    await vi.advanceTimersByTimeAsync(500);
    await vi.waitFor(() => expect(requests).toHaveLength(1));
    if (stopKind === 'revoke') adapter.revoke();
    else {
      await expect(adapter.refreshOwnProfile()).rejects.toThrow();
      expect(authInvalidated).toHaveBeenCalledOnce();
    }
    releaseRefresh(await linejsRefreshResponse(token, 'rotated-refresh'));
    for (let index = 0; index < 100; index += 1) await Promise.resolve();
    expect(credentials).not.toHaveBeenCalled();
    expect(setTimeoutSpy).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(requests).toHaveLength(stopKind === 'revoke' ? 1 : 2);
  } finally { adapter.revoke(); randomSpy.mockRestore(); vi.useRealTimers(); }
});
const attachmentIdentity = { accountId: 'account-A', chatType: 'group' as const, chatId: `c${'b'.repeat(32)}`,
  ownMid: `u${'a'.repeat(32)}`, messageId: '9', kind: 'file' as const, externalAttachmentId: 'OID_123' };
function encryptedAttachmentMessage(kind: 'image' | 'file' | 'video' | 'audio' = 'file') {
  return { id: '9', from: `u${'c'.repeat(32)}`, to: attachmentIdentity.chatId, toType: 2,
    contentType: kind === 'image' ? 1 : kind === 'video' ? 2 : kind === 'audio' ? 3 : 14, contentMetadata: { OID: 'OID_123',
      SID: kind === 'image' ? 'emi' : kind === 'video' ? 'emv' : kind === 'audio' ? 'ema' : 'emf',
      OBS_POP: 'pop-presence-fixture', FILE_SIZE: '32' },
    chunks: Array.from({ length: 5 }, (_, index) => ({ encoding: 'base64', data: Buffer.from([index + 1]).toString('base64') })) };
}
async function cachedE2eeMetadataFixture(rawPayload: string) {
  const { E2EE } = await import(new URL('../../../node_modules/@evex/linejs/base/e2ee/mod.js', import.meta.url).href) as {
    E2EE: { new (...args: any[]): object; prototype: {
      client: { log: () => void };
      generateSharedSecret: (privateKey: Buffer, publicKey: Buffer) => Uint8Array;
      getSHA256Sum: (...values: (string | Buffer)[]) => Buffer;
      generateAAD: (to: string, from: string, senderKeyId: number, receiverKeyId: number, version: number, contentType: number) => Buffer;
      encryptE2EEMessageV2: (data: Buffer, key: Buffer, nonce: Buffer, aad: Buffer) => Buffer;
      getIntBytes: (value: number) => Uint8Array;
      getE2EESelfKeyDataByKeyId: (...args: any[]) => Promise<unknown>;
      getE2EELocalPublicKey: (...args: any[]) => Promise<unknown>;
    } };
  };
  const nacl = (await import('tweetnacl')).default;
  const senderPair = nacl.box.keyPair();
  const receiverPair = nacl.box.keyPair();
  const senderPrivateKey = Buffer.from(senderPair.secretKey);
  const senderPublicKey = Buffer.from(senderPair.publicKey);
  const receiverPrivateKey = Buffer.from(receiverPair.secretKey);
  const receiverPublicKey = Buffer.from(receiverPair.publicKey);
  const crypto = Object.create(E2EE.prototype) as InstanceType<typeof E2EE> & {
    client: { log: () => void };
    generateSharedSecret: (privateKey: Buffer, publicKey: Buffer) => Uint8Array;
    getSHA256Sum: (...values: (string | Buffer)[]) => Buffer;
    generateAAD: (to: string, from: string, senderKeyId: number, receiverKeyId: number, version: number, contentType: number) => Buffer;
    encryptE2EEMessageV2: (data: Buffer, key: Buffer, nonce: Buffer, aad: Buffer) => Buffer;
    getIntBytes: (value: number) => Uint8Array;
  };
  crypto.client = { log: () => undefined };
  const senderKeyId = 21;
  const receiverKeyId = 33;
  const sharedSecret = Buffer.from(crypto.generateSharedSecret(senderPrivateKey, receiverPublicKey));
  const salt = randomBytes(16);
  const nonce = randomBytes(12);
  const gcmKey = crypto.getSHA256Sum(sharedSecret, salt, Buffer.from('Key'));
  const identity = { ...attachmentIdentity, chatType: 'direct' as const, chatId: senderMidFixture(), kind: 'image' as const };
  const aad = crypto.generateAAD(identity.ownMid, identity.chatId, senderKeyId, receiverKeyId, 2, 1);
  const encryptedData = crypto.encryptE2EEMessageV2(Buffer.from(rawPayload), gcmKey, nonce, aad);
  return { E2EE, identity, senderPublicKey, receiverPrivateKey, senderKeyId, receiverKeyId,
    chunks: [salt, encryptedData, nonce, Buffer.from(crypto.getIntBytes(senderKeyId)),
      Buffer.from(crypto.getIntBytes(receiverKeyId))] as Buffer[] };
}

it.each([
  ['corrupt cached-key GCM', '{"keyMaterial":"AQ==","fileName":"fixture.png"}', true],
  ['invalid decrypted JSON', '{not-json', false],
])('classifies local E2EE metadata failure (%s) separately from an RPC failure', async (_label, payload, corruptGcm) => {
  const fixture = await cachedE2eeMetadataFixture(payload);
  if (corruptGcm) fixture.chunks[1]![0] ^= 1;
  const selfLookup = vi.spyOn(fixture.E2EE.prototype, 'getE2EESelfKeyDataByKeyId').mockResolvedValue({
    keyId: fixture.receiverKeyId, privKey: fixture.receiverPrivateKey.toString('base64'), pubKey: 'local-public-key',
  });
  const peerLookup = vi.spyOn(fixture.E2EE.prototype, 'getE2EELocalPublicKey').mockResolvedValue(fixture.senderPublicKey);
  const token = await mockEncryptedObsToken();
  const physicalTransport = vi.fn(async () => new Response());
  const adapter = await createLinejsAdapter({ ...lease, mode: 'MONITOR_ONLY', validateLease: () => false, physicalTransport });
  await adapter.installSecrets({ token: jwt, qrCert: null, e2eeStorage: null });
  const message = { id: fixture.identity.messageId, from: fixture.identity.chatId, to: fixture.identity.ownMid, toType: 0,
    contentType: 1, contentMetadata: { OID: 'OID_123', SID: 'emi', e2eeVersion: '2' },
    chunks: fixture.chunks.map((chunk) => ({ encoding: 'base64', data: chunk.toString('base64') })) };
  try {
    await expect(adapter.download('image', fixture.identity.messageId, 'OID_123', message,
      { signal: new AbortController().signal, maxBytes: 1024, identity: fixture.identity }))
      .rejects.toMatchObject({ code: 'LINE_E2EE_METADATA_DECRYPT_FAILED' });
    expect(selfLookup).toHaveBeenCalledWith(fixture.receiverKeyId);
    expect(peerLookup).toHaveBeenCalledWith(fixture.identity.chatId, fixture.senderKeyId);
    expect(token).not.toHaveBeenCalled();
    expect(physicalTransport).not.toHaveBeenCalled();
  } finally { peerLookup.mockRestore(); selfLookup.mockRestore(); token.mockRestore(); }
});

it('labels a real nested LINEJS key RPC failure at the RequestClient boundary', async () => {
  const fixture = await cachedE2eeMetadataFixture('{"keyMaterial":"AQ=="}');
  const { RequestClient } = await import(new URL('../../../node_modules/@evex/linejs/base/request/mod.js', import.meta.url).href) as {
    RequestClient: { prototype: { request: (...args: any[]) => Promise<unknown> } };
  };
  const requestFailure = new Error('private key RPC transport detail');
  const request = vi.spyOn(RequestClient.prototype, 'request').mockRejectedValue(requestFailure);
  const token = await mockEncryptedObsToken();
  const physicalTransport = vi.fn(async () => new Response());
  const adapter = await createLinejsAdapter({ ...lease, mode: 'MONITOR_ONLY', validateLease: () => false, physicalTransport });
  await adapter.installSecrets({ token: jwt, qrCert: null, e2eeStorage: null });
  const message = { id: fixture.identity.messageId, from: fixture.identity.chatId, to: fixture.identity.ownMid, toType: 0,
    contentType: 1, contentMetadata: { OID: 'OID_123', SID: 'emi', e2eeVersion: '2' },
    chunks: fixture.chunks.map((chunk) => ({ encoding: 'base64', data: chunk.toString('base64') })) };
  try {
    await expect(adapter.download('image', fixture.identity.messageId, 'OID_123', message,
      { signal: new AbortController().signal, maxBytes: 1024, identity: fixture.identity }))
      .rejects.toMatchObject({ code: 'LINE_E2EE_METADATA_RPC_FAILED' });
    expect(request).toHaveBeenCalled();
    expect(token).not.toHaveBeenCalled();
    expect(physicalTransport).not.toHaveBeenCalled();
  } finally { request.mockRestore(); token.mockRestore(); }
});

async function mockEncryptedObsToken() {
  const { TalkService } = await import(new URL('../../../node_modules/@evex/linejs/base/service/talk/mod.js', import.meta.url).href) as {
    TalkService: { prototype: { acquireEncryptedAccessToken: (...args: any[]) => Promise<string> } };
  };
  return vi.spyOn(TalkService.prototype, 'acquireEncryptedAccessToken').mockResolvedValue('3600\u001eobs-fixture-token');
}

it('uses the installed LINEJS RequestClient sync serializer and guarded LEGY physical fetch', async () => {
  const requests: Request[] = [];
  const adapter = await createLinejsAdapter({ ...lease, mode: 'MONITOR_ONLY', validateLease: () => false,
    physicalTransport: async (request) => { requests.push(request); throw new Error('offline fixture stop'); } });
  await adapter.installSecrets({ token: jwt, qrCert: null, e2eeStorage: null });
  await expect(adapter.sync(cursor)).rejects.toThrow('offline fixture stop');
  expect(requests).toHaveLength(1);
  expect(requests[0]?.url).toBe('https://gf.line.naver.jp/enc');
});

it.each(['image', 'file'].flatMap((kind) => [false, true].map((archived) => ({ kind: kind as 'image' | 'file', archived }))))('downloads direct E2EE $kind (archived=$archived) with authenticated stored bytes', async ({ kind, archived }) => {
  const { E2EE } = await import(new URL('../../../node_modules/@evex/linejs/base/e2ee/mod.js', import.meta.url).href) as {
    E2EE: { prototype: { getE2EESelfKeyDataByKeyId: (...args: any[]) => Promise<unknown>;
      getE2EELocalPublicKey: (...args: any[]) => Promise<Buffer>;
      encryptE2EEMessageByData: (...args: any[]) => Buffer[]; generateSharedSecret: (priv: Buffer, pub: Buffer) => Uint8Array;
      encryptByKeyMaterial: (...args: any[]) => Promise<any> } };
  };
  const nacl = (await import('tweetnacl')).default;
  const senderPair = nacl.box.keyPair();
  const receiverPair = nacl.box.keyPair();
  const senderPriv = Buffer.from(senderPair.secretKey);
  const senderPub = Buffer.from(senderPair.publicKey);
  const receiverPriv = Buffer.from(receiverPair.secretKey);
  const receiverPub = Buffer.from(receiverPair.publicKey);
  const directIdentity = { ...attachmentIdentity, chatType: 'direct' as const, chatId: senderMidFixture() };
  const senderKeyId = kind === 'image' && !archived ? 0x41424344 : 21;
  const sender = Object.create(E2EE.prototype) as { client: { log: () => void };
    encryptE2EEMessageByData: (...args: any[]) => Buffer[]; generateSharedSecret: (priv: Buffer, pub: Buffer) => Uint8Array };
  sender.client = { log: () => undefined };
  const keyMaterial = Buffer.alloc(32, 0x41);
  const plaintext = kind === 'image' ? openablePng : Buffer.from('pinned native five chunk fixture');
  const mediaCrypto = Object.create(E2EE.prototype) as {
    encryptByKeyMaterial: (data: Buffer, key: Buffer) => Promise<{ encryptedData: Buffer }>;
  };
  const encryptedMedia = await mediaCrypto.encryptByKeyMaterial(plaintext, keyMaterial);
  const encrypted = await sender.encryptE2EEMessageByData(senderKeyId, 33,
    Buffer.from(sender.generateSharedSecret(senderPriv, receiverPub)), 2,
    { keyMaterial: keyMaterial.toString('base64'), fileName: kind === 'image' ? 'fixture.png' : 'fixture.bin' }, directIdentity.ownMid,
    senderMidFixture(), kind === 'image' ? 1 : 14);
  const keyLookup = vi.spyOn(E2EE.prototype, 'getE2EESelfKeyDataByKeyId').mockResolvedValue({
    keyId: 33, privKey: receiverPriv.toString('base64'), pubKey: receiverPub.toString('base64'),
  });
  const peerLookup = vi.spyOn(E2EE.prototype, 'getE2EELocalPublicKey').mockResolvedValue(senderPub);
  const requests: Request[] = [];
  const token = await mockEncryptedObsToken();
  const adapter = await createLinejsAdapter({ ...lease, mode: 'MONITOR_ONLY', validateLease: () => false,
    physicalTransport: async (request) => { requests.push(request); return requests.length === 1
      ? new Response(JSON.stringify({ status: 'exist', encodeStatus: 'done' })) : new Response(encryptedMedia.encryptedData); } });
  try {
    await adapter.installSecrets({ token: jwt, qrCert: null, e2eeStorage: null });
    const sourceMessage = encryptedAttachmentMessage(kind);
    const nativeMessage = { ...sourceMessage, to: directIdentity.ownMid, toType: 0,
      contentMetadata: { ...sourceMessage.contentMetadata, e2eeVersion: '2', FILE_SIZE: String(encryptedMedia.encryptedData.length) },
      from: senderMidFixture(), createdTime: 1760522400000,
      chunks: encrypted.map((chunk, index) => index === 3 && kind === 'image' && !archived
        ? chunk.toString('utf8')
        : kind === 'image' && !archived ? chunk : { encoding: 'base64', data: chunk.toString('base64') }) };
    expect(nativeMessage.chunks).toHaveLength(5);
    const message = kind === 'image' && !archived
      ? JSON.parse(JSON.stringify(normalizeOperation({ revision: '9', type: 26, message: nativeMessage }, {
        accountId: directIdentity.accountId, ownMid: directIdentity.ownMid, source: 'history', cursor: 'native-image-fixture',
      }).raw)).message
      : nativeMessage;
    if (kind === 'image' && !archived) {
      expect(message.chunks[3]).toEqual({ encoding: 'base64', data: Buffer.from('ABCD').toString('base64') });
    }
    const identity = { ...directIdentity, kind };
    if (archived) {
      await downloadArchivedFixture(adapter, { ...message, toType: 'USER', contentType: kind.toUpperCase() }, identity, plaintext);
      expect(new URL(requests[1]!.url).pathname).toBe(`/r/talk/${kind === 'image' ? 'emi' : 'emf'}/${archivedOid}`);
      return;
    }
    const result = await adapter.download(kind, '9', 'OID_123', message,
      { signal: new AbortController().signal, maxBytes: 1024, identity });
    const root = await mkdtemp(join(tmpdir(), 'linejs-e2ee-store-'));
    temporary.push(root);
    const stored = await storeAttachment({ root, identity: { ...identity, messageId: '9', externalAttachmentId: 'OID_123' },
      occurredAt: '2026-10-18T00:00:00.000Z', originalFileName: result.name ?? (kind === 'image' ? 'fixture.png' : 'fixture.bin'), source: result.source,
      maxBytes: 1024, timeoutMs: 5_000 }, { unsafeAllowPortableFilesystemOnWindowsForTests: true });
    expect(await readFile(stored.absolutePath)).toEqual(plaintext);
    expect(stored.size).toBe(plaintext.length);
    expect(result.name).toBe(kind === 'image' ? 'fixture.png' : 'fixture.bin');
    expect(keyLookup).toHaveBeenCalledWith(33);
    expect(peerLookup).toHaveBeenCalledWith(senderMidFixture(), senderKeyId);
    expect(requests).toHaveLength(2);
    const sid = kind === 'image' ? 'emi' : 'emf';
    expect(new URL(requests[0]!.url).pathname).toBe(`/r/talk/${sid}/OID_123/object_info.obs`);
    expect(new URL(requests[1]!.url).pathname).toBe(`/r/talk/${sid}/OID_123`);
    expect(new URL(requests[0]!.url).searchParams.get('p')).toBe('pop-presence-fixture');
    expect(requests[1]!.headers.get('x-line-application')).toContain('DESKTOPWIN');
    expect(requests[1]!.headers.get('user-agent')).toMatch(/^Line\//);
    expect(requests[1]!.headers.get('x-line-access')).toBe('obs-fixture-token');
    const talkMeta = JSON.parse(Buffer.from(requests[1]!.headers.get('x-talk-meta')!, 'base64').toString('utf8')) as { message: string };
    expect(Buffer.from(talkMeta.message, 'base64')).toEqual(Buffer.from([11, 0, 4, 0, 0, 0, 1, 57, 15, 0, 27, 12, 0, 0, 0, 0, 0]));
    expect(token).toHaveBeenCalledWith({ featureType: 2 });
  } finally { keyLookup.mockRestore(); peerLookup.mockRestore(); token.mockRestore(); }
});

it.each(['image', 'file'].flatMap((kind) => [false, true].map((archived) => ({ kind: kind as 'image' | 'file', archived }))))('recovers group E2EE $kind (archived=$archived) and stores authenticated bytes', async ({ kind, archived }) => {
  const { E2EE } = await import(new URL('../../../node_modules/@evex/linejs/base/e2ee/mod.js', import.meta.url).href) as {
    E2EE: { prototype: { getE2EESelfKeyData: (...args: any[]) => Promise<unknown>;
      getE2EELocalPublicKey: (...args: any[]) => Promise<unknown>;
      encryptE2EEMessageByData: (...args: any[]) => Buffer[]; generateSharedSecret: (priv: Buffer, pub: Buffer) => Uint8Array;
      encryptByKeyMaterial: (...args: any[]) => Promise<any> } };
  };
  const nacl = (await import('tweetnacl')).default;
  const senderPair = nacl.box.keyPair();
  const groupPair = nacl.box.keyPair();
  const senderPriv = Buffer.from(senderPair.secretKey);
  const senderPub = Buffer.from(senderPair.publicKey);
  const groupPriv = Buffer.from(groupPair.secretKey);
  const groupPub = Buffer.from(groupPair.publicKey);
  const groupId = attachmentIdentity.chatId;
  const senderMid = senderMidFixture();
  const sender = Object.create(E2EE.prototype) as { client: { log: () => void };
    encryptE2EEMessageByData: (...args: any[]) => Buffer[]; generateSharedSecret: (priv: Buffer, pub: Buffer) => Uint8Array };
  sender.client = { log: () => undefined };
  const keyMaterial = Buffer.alloc(32, 0x52);
  const plaintext = kind === 'image' ? openablePng : Buffer.from('native group file bytes');
  const mediaCrypto = Object.create(E2EE.prototype) as { encryptByKeyMaterial: (data: Buffer, key: Buffer) => Promise<{ encryptedData: Buffer }> };
  const encryptedMedia = await mediaCrypto.encryptByKeyMaterial(plaintext, keyMaterial);
  const encrypted = await sender.encryptE2EEMessageByData(21, 33,
    Buffer.from(sender.generateSharedSecret(senderPriv, groupPub)), 2,
    { keyMaterial: keyMaterial.toString('base64'), fileName: kind === 'image' ? 'group.png' : 'group.bin' }, groupId, senderMid,
    kind === 'image' ? 1 : 14);
  const selfLookup = vi.spyOn(E2EE.prototype, 'getE2EESelfKeyData').mockResolvedValue({
    keyId: 33, privKey: groupPriv.toString('base64'), pubKey: groupPub.toString('base64'),
  } as never);
  const localLookup = vi.spyOn(E2EE.prototype, 'getE2EELocalPublicKey').mockImplementation(async (mid: string) =>
    mid === groupId ? { keyId: 33, privKey: groupPriv.toString('base64'), pubKey: groupPub.toString('base64') }
      : senderPub as never);
  const token = await mockEncryptedObsToken();
  let calls = 0;
  const adapter = await createLinejsAdapter({ ...lease, mode: 'MONITOR_ONLY', validateLease: () => false,
    physicalTransport: async () => ++calls === 1
      ? new Response(JSON.stringify({ status: 'exist', encodeStatus: 'done' })) : new Response(encryptedMedia.encryptedData) });
  const identity = { ...attachmentIdentity, kind };
  try {
    await adapter.installSecrets({ token: jwt, qrCert: null, e2eeStorage: null });
    const sourceMessage = encryptedAttachmentMessage(kind);
    const message = { ...sourceMessage, from: senderMid, to: groupId, toType: 2,
      contentMetadata: { ...sourceMessage.contentMetadata, e2eeVersion: '2', FILE_SIZE: String(encryptedMedia.encryptedData.length) },
      chunks: encrypted.map((chunk) => ({ encoding: 'base64', data: chunk.toString('base64') })) };
    if (archived) {
      await downloadArchivedFixture(adapter, { ...message, toType: 'GROUP', contentType: kind.toUpperCase() }, identity, plaintext);
      expect(calls).toBe(2);
      return;
    }
    const result = await adapter.download(kind, '9', 'OID_123', message,
      { signal: new AbortController().signal, maxBytes: 1024, identity });
    const root = await mkdtemp(join(tmpdir(), 'linejs-group-e2ee-store-'));
    temporary.push(root);
    const stored = await storeAttachment({ root, identity, occurredAt: '2026-10-18T00:00:00.000Z',
      originalFileName: result.name ?? (kind === 'image' ? 'group.png' : 'group.bin'), source: result.source, maxBytes: 1024, timeoutMs: 5_000 },
    { unsafeAllowPortableFilesystemOnWindowsForTests: true });
    expect(await readFile(stored.absolutePath)).toEqual(plaintext);
    expect(selfLookup).toHaveBeenCalled();
    expect(localLookup).toHaveBeenCalledWith(groupId, 33);
    expect(localLookup).toHaveBeenCalledWith(senderMid, 21);
    expect(token).toHaveBeenCalledWith({ featureType: 2 });
  } finally { selfLookup.mockRestore(); localLookup.mockRestore(); token.mockRestore(); }
});

it('downloads native encrypted metadata with its decoded key material, skips E2EE chunk lookup, and never calls TalkService.getProfile', async () => {
  const { E2EE } = await import(new URL('../../../node_modules/@evex/linejs/base/e2ee/mod.js', import.meta.url).href) as {
    E2EE: { prototype: { decryptE2EEDataMessage: (...args: any[]) => Promise<unknown>; encryptByKeyMaterial: (...args: any[]) => Promise<any> } };
  };
  const decryptEnvelope = vi.spyOn(E2EE.prototype, 'decryptE2EEDataMessage').mockRejectedValue(new Error('must not look up native chunks'));
  const token = await mockEncryptedObsToken();
  const { TalkService } = await import(new URL('../../../node_modules/@evex/linejs/base/service/talk/mod.js', import.meta.url).href) as {
    TalkService: { prototype: { getProfile: (...args: any[]) => Promise<unknown> } };
  };
  const getProfile = vi.spyOn(TalkService.prototype, 'getProfile').mockRejectedValue(new Error('must never call TalkService.getProfile'));
  const keyMaterial = Buffer.alloc(32, 0x41);
  const plaintext = Buffer.from('native encrypted attachment');
  const crypto = Object.create(E2EE.prototype) as { encryptByKeyMaterial(data: Buffer, key: Buffer): Promise<{ encryptedData: Buffer }> };
  const ciphertext = (await crypto.encryptByKeyMaterial(plaintext, keyMaterial)).encryptedData;
  const requests: Request[] = [];
  const identity = { ...attachmentIdentity, kind: 'file' as const };
  const nativeAttachment = { messageId: '9', chatId: identity.chatId, from: null, to: null, toType: null, contentType: 14,
    contentMetadata: { OID: 'OID_123', SID: 'emf', OBS_POP: 'pop-presence-fixture', FILE_SIZE: String(ciphertext.length),
      MEDIA_CONTENT_INFO: null, DOWNLOAD_URL: null }, keyMaterial: keyMaterial.toString('base64'), fileName: 'native.bin', sizeBytes: plaintext.length };
  const probe = {
    chatType: identity.chatType,
    chatId: identity.chatId,
    messageId: '9',
    externalAttachmentId: 'OID_123',
    kind: 'file' as const,
    lineMessage: {},
    nativeAttachment,
    maxBytes: 1024,
  };
  try {
    const capturedApplication = 'DESKTOPWIN\t26.5.1.4180\tWINDOWS\t10.0.0-NT-x64';
    // Direct OBS token fails 401 on object_info.obs, fallback to acquireEncryptedAccessToken({ featureType: 2 }) succeeds:
    const adapterWithFallback = await createLinejsAdapter({ ...lease, mode: 'MONITOR_ONLY', validateLease: () => false,
      physicalTransport: async (request) => {
        requests.push(request);
        if (new URL(request.url).pathname.endsWith('/object_info.obs')) {
          if (request.headers.get('x-line-access') === 'fixture-auth') {
            return new Response('Unauthorized', { status: 401 });
          }
          return new Response(JSON.stringify({ status: 'exist', encodeStatus: 'done' }));
        }
        return new Response(ciphertext);
      } });
    await adapterWithFallback.adoptDownloadAuth('fixture-auth', capturedApplication, { expectedMid: identity.ownMid, probe });
    const result = await adapterWithFallback.download('file', '9', '9', {}, { signal: new AbortController().signal, maxBytes: 1024,
      identity, nativeAttachment });
    const chunks: Buffer[] = [];
    for await (const chunk of result.source) chunks.push(Buffer.from(chunk));
    expect(Buffer.concat(chunks)).toEqual(plaintext);
    expect(result.name).toBe('native.bin');
    expect(getProfile).not.toHaveBeenCalled();
    expect(requests.some((request) => request.url.includes('legy.line-apps.com/S4'))).toBe(false);
    expect(requests[0]!.headers.get('x-line-application')).toBe(capturedApplication);
    expect(requests[0]!.headers.get('user-agent')).toBe('Line/26.5.1.4180');
    expect(new URL(requests.at(-1)!.url).pathname).toBe('/r/talk/emf/OID_123');
    expect(requests.at(-1)!.url).toContain('p=pop-presence-fixture');
    expect(decryptEnvelope).not.toHaveBeenCalled();
    // acquireEncryptedAccessToken called once during adoptDownloadAuth fallback, and reused in download() without calling again!
    expect(token).toHaveBeenCalledTimes(1);
    expect(token).toHaveBeenCalledWith({ featureType: 2 });
    adapterWithFallback.revoke();
  } finally { decryptEnvelope.mockRestore(); token.mockRestore(); getProfile.mockRestore(); }
});

it('adopts a direct OBS candidate token via object_info.obs probe and downloads with zero /S4 RPC calls', async () => {
  const { E2EE } = await import(new URL('../../../node_modules/@evex/linejs/base/e2ee/mod.js', import.meta.url).href) as {
    E2EE: { prototype: { encryptByKeyMaterial: (...args: any[]) => Promise<any> } };
  };
  const { TalkService } = await import(new URL('../../../node_modules/@evex/linejs/base/service/talk/mod.js', import.meta.url).href) as {
    TalkService: { prototype: { getProfile: (...args: any[]) => Promise<unknown>; acquireEncryptedAccessToken: (...args: any[]) => Promise<unknown> } };
  };
  const getProfile = vi.spyOn(TalkService.prototype, 'getProfile').mockRejectedValue(new Error('must not call getProfile'));
  const acquireToken = vi.spyOn(TalkService.prototype, 'acquireEncryptedAccessToken').mockRejectedValue(new Error('must not call acquireEncryptedAccessToken for direct OBS token'));
  const keyMaterial = Buffer.alloc(32, 0x42);
  const plaintext = Buffer.from('direct obs token payload');
  const crypto = Object.create(E2EE.prototype) as { encryptByKeyMaterial(data: Buffer, key: Buffer): Promise<{ encryptedData: Buffer }> };
  const ciphertext = (await crypto.encryptByKeyMaterial(plaintext, keyMaterial)).encryptedData;
  const requests: Request[] = [];
  const adapter = await createLinejsAdapter({ ...lease, mode: 'MONITOR_ONLY', validateLease: () => false,
    physicalTransport: async (request) => {
      requests.push(request);
      if (new URL(request.url).pathname.endsWith('/object_info.obs')) {
        return new Response(JSON.stringify({ status: 'exist', encodeStatus: 'done' }));
      }
      return new Response(ciphertext);
    } });
  const identity = { ...attachmentIdentity, kind: 'file' as const };
  const nativeAttachment = { messageId: '9', chatId: identity.chatId, from: null, to: null, toType: null, contentType: 14,
    contentMetadata: { OID: 'OID_123', SID: 'emf', OBS_POP: null, FILE_SIZE: String(ciphertext.length),
      MEDIA_CONTENT_INFO: null, DOWNLOAD_URL: null }, keyMaterial: keyMaterial.toString('base64'), fileName: 'direct.bin', sizeBytes: plaintext.length };
  const probe = {
    chatType: identity.chatType,
    chatId: identity.chatId,
    messageId: '9',
    externalAttachmentId: 'OID_123',
    kind: 'file' as const,
    lineMessage: {},
    nativeAttachment,
    maxBytes: 1024,
  };
  try {
    const adopted = await adapter.adoptDownloadAuth('direct-obs-token', 'DESKTOPWIN\t26.5.1.4180\tWINDOWS\t10.0.0-NT-x64', {
      expectedMid: identity.ownMid,
      probe,
    });
    expect(adopted).toEqual({ ownMid: identity.ownMid, displayName: null });
    const result = await adapter.download('file', '9', '9', {}, {
      signal: new AbortController().signal,
      maxBytes: 1024,
      identity,
      nativeAttachment,
    });
    const chunks: Buffer[] = [];
    for await (const chunk of result.source) chunks.push(Buffer.from(chunk));
    expect(Buffer.concat(chunks)).toEqual(plaintext);
    expect(getProfile).not.toHaveBeenCalled();
    expect(acquireToken).not.toHaveBeenCalled();
    expect(requests.every((request) => new URL(request.url).hostname === 'obs.line-apps.com')).toBe(true);
    expect(requests.every((request) => request.headers.get('x-line-access') === 'direct-obs-token')).toBe(true);
  } finally {
    getProfile.mockRestore();
    acquireToken.mockRestore();
    adapter.revoke();
  }
});

it('rejects a JWT download-auth candidate with a mismatched MID offline with zero network calls', async () => {
  const requests: Request[] = [];
  const adapter = await createLinejsAdapter({ ...lease, mode: 'MONITOR_ONLY', validateLease: () => false,
    physicalTransport: async (request) => { requests.push(request); return new Response(new Uint8Array(), { status: 200 }); } });
  const mismatchedMid = `u${'f'.repeat(32)}`;
  const mismatchedJwt = [
    Buffer.from('{"alg":"HS256"}').toString('base64url'),
    Buffer.from(JSON.stringify({ sub: mismatchedMid })).toString('base64url'),
    'signature',
  ].join('.');
  const probe = {
    chatType: attachmentIdentity.chatType,
    chatId: attachmentIdentity.chatId,
    messageId: '9',
    externalAttachmentId: 'OID_123',
    kind: 'file' as const,
    lineMessage: {},
    nativeAttachment: { messageId: '9', chatId: attachmentIdentity.chatId, from: null, to: null, toType: null, contentType: 14,
      contentMetadata: { OID: 'OID_123', SID: 'emf', OBS_POP: null, FILE_SIZE: '16',
        MEDIA_CONTENT_INFO: null, DOWNLOAD_URL: null }, keyMaterial: Buffer.alloc(32, 1).toString('base64'), fileName: 'native.bin', sizeBytes: 16 },
    maxBytes: 1024,
  };
  try {
    const result = await adapter.adoptDownloadAuth(mismatchedJwt, 'DESKTOPWIN\t26.5.1.4180\tWINDOWS\t10.0.0-NT-x64', {
      expectedMid: attachmentIdentity.ownMid,
      probe,
    });
    expect(result).toEqual({ ownMid: mismatchedMid, displayName: null });
    expect(requests).toHaveLength(0);
  } finally { adapter.revoke(); }
});

async function downloadAuthFixture(respond: (token: string, path: string) => Response | null) {
  const { E2EE } = await import(new URL('../../../node_modules/@evex/linejs/base/e2ee/mod.js', import.meta.url).href) as {
    E2EE: { prototype: { encryptByKeyMaterial: (...args: any[]) => Promise<any> } };
  };
  const { TalkService } = await import(new URL('../../../node_modules/@evex/linejs/base/service/talk/mod.js', import.meta.url).href) as {
    TalkService: { prototype: { acquireEncryptedAccessToken: (...args: any[]) => Promise<string> } };
  };
  const acquireToken = vi.spyOn(TalkService.prototype, 'acquireEncryptedAccessToken').mockResolvedValue('3600\u001eobs-fixture-token');
  const keyMaterial = Buffer.alloc(32, 0x42);
  const plaintext = Buffer.from('download auth fixture payload');
  const crypto = Object.create(E2EE.prototype) as { encryptByKeyMaterial(data: Buffer, key: Buffer): Promise<{ encryptedData: Buffer }> };
  const ciphertext = (await crypto.encryptByKeyMaterial(plaintext, keyMaterial)).encryptedData;
  const seen: Array<{ token: string | null; path: string }> = [];
  const adapter = await createLinejsAdapter({ ...lease, mode: 'MONITOR_ONLY', validateLease: () => false,
    physicalTransport: async (request) => {
      const path = new URL(request.url).pathname;
      const token = request.headers.get('x-line-access');
      seen.push({ token, path });
      return respond(token ?? '', path) ?? (path.endsWith('/object_info.obs')
        ? new Response(JSON.stringify({ status: 'exist', encodeStatus: 'done' })) : new Response(ciphertext));
    } });
  const identity = { ...attachmentIdentity, kind: 'file' as const };
  const nativeAttachment = { messageId: '9', chatId: identity.chatId, from: null, to: null, toType: null, contentType: 14,
    contentMetadata: { OID: 'OID_123', SID: 'emf', OBS_POP: null, FILE_SIZE: String(ciphertext.length),
      MEDIA_CONTENT_INFO: null, DOWNLOAD_URL: null }, keyMaterial: keyMaterial.toString('base64'), fileName: 'f.bin', sizeBytes: plaintext.length };
  const probe = { chatType: identity.chatType, chatId: identity.chatId, messageId: '9', externalAttachmentId: 'OID_123',
    kind: 'file' as const, lineMessage: {}, nativeAttachment, maxBytes: 1024 };
  const application = 'DESKTOPWIN\t26.5.1.4180\tWINDOWS\t10.0.0-NT-x64';
  const download = async () => {
    const result = await adapter.download('file', '9', '9', {}, { signal: new AbortController().signal, maxBytes: 1024, identity, nativeAttachment });
    const chunks: Buffer[] = [];
    for await (const chunk of result.source) chunks.push(Buffer.from(chunk));
    return Buffer.concat(chunks);
  };
  return { adapter, acquireToken, seen, identity, probe, application, plaintext, download, cleanup: () => { acquireToken.mockRestore(); adapter.revoke(); } };
}
const unauthorized = () => new Response('', { status: 401 });

it('falls back to a featureType 2 OBS token when the direct opaque preflight is rejected with 401', async () => {
  const fx = await downloadAuthFixture((token, path) => (token === 'opaque-token' && path.endsWith('/object_info.obs') ? unauthorized() : null));
  try {
    await fx.adapter.adoptDownloadAuth('opaque-token', fx.application, { expectedMid: fx.identity.ownMid, probe: fx.probe });
    expect(fx.seen.map((entry) => entry.token)).toEqual(['opaque-token', 'obs-fixture-token']);
    expect(fx.acquireToken).toHaveBeenCalledTimes(1);
    expect(fx.acquireToken).toHaveBeenCalledWith({ featureType: 2 });
    expect(await fx.download()).toEqual(fx.plaintext);
    expect(fx.acquireToken).toHaveBeenCalledTimes(1);
  } finally { fx.cleanup(); }
});

it('acquires a featureType 2 OBS token for a V3 JWT without trying it directly as the OBS token', async () => {
  const fx = await downloadAuthFixture(() => null);
  const v3 = [Buffer.from('{"alg":"HS256"}').toString('base64url'),
    Buffer.from(JSON.stringify({ sub: fx.identity.ownMid })).toString('base64url'), 'signature'].join('.');
  try {
    await fx.adapter.adoptDownloadAuth(v3, fx.application, { expectedMid: fx.identity.ownMid, probe: fx.probe });
    expect(fx.acquireToken).toHaveBeenCalledWith({ featureType: 2 });
    expect(fx.seen.map((entry) => entry.token)).toEqual(['obs-fixture-token']);
  } finally { fx.cleanup(); }
});

it('clears adopted auth and the cached OBS token when preflight fails, so a later download cannot use them', async () => {
  const fx = await downloadAuthFixture((_token, path) => (path.endsWith('/object_info.obs') ? unauthorized() : null));
  try {
    await expect(fx.adapter.adoptDownloadAuth('opaque-token', fx.application, { expectedMid: fx.identity.ownMid, probe: fx.probe }))
      .rejects.toMatchObject({ code: 'LINE_OBS_HTTP_401' });
    const before = fx.seen.length;
    await expect(fx.download()).rejects.toBeTruthy();
    // No cached OBS token and no adopted auth: the old token is never replayed as a bearer.
    expect(fx.seen.slice(before).some((entry) => entry.token === 'opaque-token')).toBe(false);
  } finally { fx.cleanup(); }
});

it('reacquires the OBS token exactly once when the cached adopted token is rejected with 401', async () => {
  let rejectOpaque = false;
  const fx = await downloadAuthFixture((token) => (rejectOpaque && token === 'opaque-token' ? unauthorized() : null));
  try {
    await fx.adapter.adoptDownloadAuth('opaque-token', fx.application, { expectedMid: fx.identity.ownMid, probe: fx.probe });
    expect(fx.acquireToken).not.toHaveBeenCalled();
    rejectOpaque = true;
    expect(await fx.download()).toEqual(fx.plaintext);
    expect(fx.acquireToken).toHaveBeenCalledTimes(1);
  } finally { fx.cleanup(); }
});

it('treats a second 401 after the single reacquire as a normal attachment failure', async () => {
  let rejectAll = false;
  const fx = await downloadAuthFixture(() => (rejectAll ? unauthorized() : null));
  try {
    await fx.adapter.adoptDownloadAuth('opaque-token', fx.application, { expectedMid: fx.identity.ownMid, probe: fx.probe });
    rejectAll = true;
    await expect(fx.download()).rejects.toMatchObject({ code: 'LINE_OBS_HTTP_401' });
    expect(fx.acquireToken).toHaveBeenCalledTimes(1);
  } finally { fx.cleanup(); }
});

it('adopts with a 200 MiB probe attachment and only issues the object_info preflight, never a body GET', async () => {
  const fx = await downloadAuthFixture(() => null);
  const bigProbe = { ...fx.probe, nativeAttachment: { ...fx.probe.nativeAttachment,
    contentMetadata: { ...fx.probe.nativeAttachment.contentMetadata, FILE_SIZE: '209715200' }, sizeBytes: 209715200 } };
  try {
    await expect(fx.adapter.adoptDownloadAuth('opaque-token', fx.application, { expectedMid: fx.identity.ownMid, probe: bigProbe }))
      .resolves.toEqual({ ownMid: fx.identity.ownMid, displayName: null });
    expect(fx.seen).toHaveLength(1);
    expect(fx.seen[0]!.path.endsWith('/object_info.obs')).toBe(true);
  } finally { fx.cleanup(); }
});

it('classifies a real pinned LINEJS OBS 404 response without treating its body as expiry proof', async () => {
  const { E2EE } = await import(new URL('../../../node_modules/@evex/linejs/base/e2ee/mod.js', import.meta.url).href) as {
    E2EE: { prototype: { decryptE2EEDataMessage: (...args: any[]) => Promise<unknown> } };
  };
  const decryptEnvelope = vi.spyOn(E2EE.prototype, 'decryptE2EEDataMessage').mockResolvedValue({
    keyMaterial: Buffer.alloc(32, 0x41).toString('base64'), fileName: 'fixture.bin',
  });
  const token = await mockEncryptedObsToken();
  const adapter = await createLinejsAdapter({ ...lease, mode: 'MONITOR_ONLY', validateLease: () => false,
    physicalTransport: async () => new Response('private signed URL response body', { status: 404 }) });
  await adapter.installSecrets({ token: jwt, qrCert: null, e2eeStorage: null });
  try {
    const identity = { ...attachmentIdentity, kind: 'image' as const };
    const error = await adapter.download('image', '9', 'OID_123', encryptedAttachmentMessage('image'),
    { signal: new AbortController().signal, maxBytes: 1024, identity }).catch((value: unknown) => value);
    expect(error).toMatchObject({ code: 'LINE_OBS_HTTP_404' });
    expect(JSON.stringify(error)).not.toContain('private');
    expect(JSON.stringify(error)).not.toContain('404 response body');
  } finally { decryptEnvelope.mockRestore(); token.mockRestore(); }
});

it('rejects wrong chat and OID bindings before any OBS request', async () => {
  const token = await mockEncryptedObsToken();
  const requests: Request[] = [];
  const adapter = await createLinejsAdapter({ ...lease, mode: 'MONITOR_ONLY', validateLease: () => false,
    physicalTransport: async (request) => { requests.push(request); return new Response(); } });
  await adapter.installSecrets({ token: jwt, qrCert: null, e2eeStorage: null });
  const identity = { ...attachmentIdentity, kind: 'image' as const };
  try {
    await expect(adapter.download('image', '9', 'OID_123', { ...encryptedAttachmentMessage('image'),
      to: `c${'d'.repeat(32)}` }, { signal: new AbortController().signal, maxBytes: 1024, identity }))
      .rejects.toMatchObject({ code: 'ATTACHMENT_METADATA_INVALID' });
    await expect(adapter.download('image', '9', 'OID_123', { ...encryptedAttachmentMessage('image'),
      contentMetadata: { OID: 'OID_WRONG', SID: 'emi' } },
    { signal: new AbortController().signal, maxBytes: 1024, identity }))
      .rejects.toMatchObject({ code: 'ATTACHMENT_METADATA_INVALID' });
    expect(token).not.toHaveBeenCalled();
    expect(requests).toEqual([]);
  } finally { token.mockRestore(); }
});

it.each([
  { id: 'wrong' }, { from: `u${'d'.repeat(32)}` }, { to: `u${'d'.repeat(32)}` },
  { toType: 'GROUP' }, { toType: 'ROOM' }, { toType: 'user' }, { toType: '0' },
  { contentType: 'FILE' }, { contentType: 'image' }, { contentType: '1' },
  { contentMetadata: { OID: '../OID_123', SID: 'emi' } },
  { contentMetadata: { OID: 'OID_123', SID: 'emf' } },
  { chunks: [{ encoding: 'base64', data: 'not base64' }] },
  { externalAttachmentId: 'unrelated' },
  { envelope: true },
])('rejects contradictory archived metadata before key lookup, RPC or OBS %#', async (patch) => {
  const { E2EE } = await import(new URL('../../../node_modules/@evex/linejs/base/e2ee/mod.js', import.meta.url).href);
  const decrypt = vi.spyOn(E2EE.prototype, 'decryptE2EEDataMessage');
  const token = await mockEncryptedObsToken();
  const requests: Request[] = [];
  const identity = { ...attachmentIdentity, chatType: 'direct' as const, chatId: senderMidFixture(), kind: 'image' as const,
    externalAttachmentId: 'externalAttachmentId' in patch ? patch.externalAttachmentId! : '9' };
  const adapter = await createLinejsAdapter({ ...lease, mode: 'MONITOR_ONLY', validateLease: () => false,
    physicalTransport: async (request) => { requests.push(request); return new Response(); } });
  await adapter.installSecrets({ token: jwt, qrCert: null, e2eeStorage: null });
  const message = { ...encryptedAttachmentMessage('image'), from: identity.chatId, to: identity.ownMid,
    toType: 'USER', contentType: 'IMAGE', ...patch };
  const raw = 'envelope' in patch ? { type: 26, message } : message;
  try {
    await expect(adapter.download('image', '9', identity.externalAttachmentId, raw,
      { signal: new AbortController().signal, maxBytes: 1024, identity })).rejects.toMatchObject({ code: 'ATTACHMENT_METADATA_INVALID' });
    expect(decrypt).not.toHaveBeenCalled();
    expect(token).not.toHaveBeenCalled();
    expect(requests).toEqual([]);
  } finally { decrypt.mockRestore(); token.mockRestore(); }
});

it.each([undefined, 1, 2, 3, '0'] as const)('rejects direct-message toType %s before E2EE key lookup, token RPC, or OBS', async (toType) => {
  const { E2EE } = await import(new URL('../../../node_modules/@evex/linejs/base/e2ee/mod.js', import.meta.url).href) as {
    E2EE: { prototype: { decryptE2EEDataMessage: (...args: any[]) => Promise<unknown> } };
  };
  const decrypt = vi.spyOn(E2EE.prototype, 'decryptE2EEDataMessage').mockResolvedValue({ keyMaterial: Buffer.alloc(32, 1).toString('base64') });
  const token = await mockEncryptedObsToken();
  const requests: Request[] = [];
  const identity = { ...attachmentIdentity, chatType: 'direct' as const, chatId: senderMidFixture(), kind: 'image' as const };
  const adapter = await createLinejsAdapter({ ...lease, mode: 'MONITOR_ONLY', validateLease: () => false,
    physicalTransport: async (request) => { requests.push(request); return new Response(); } });
  await adapter.installSecrets({ token: jwt, qrCert: null, e2eeStorage: null });
  const raw: Record<string, unknown> = { ...encryptedAttachmentMessage('image'), from: identity.chatId, to: identity.ownMid };
  if (toType === undefined) delete raw.toType;
  else raw.toType = toType;
  try {
    await expect(adapter.download('image', '9', 'OID_123', raw,
      { signal: new AbortController().signal, maxBytes: 1024, identity })).rejects.toMatchObject({ code: 'ATTACHMENT_METADATA_INVALID' });
    expect(decrypt).not.toHaveBeenCalled();
    expect(token).not.toHaveBeenCalled();
    expect(requests).toEqual([]);
  } finally { decrypt.mockRestore(); token.mockRestore(); }
});

it.each([
  [{ status: 'notexist' }, 'LINE_OBS_OBJECT_NOT_FOUND'],
  [{ status: 'exist', encodeStatus: 7 }, 'LINE_OBS_METADATA_INVALID'],
  [{ status: 'unknown' }, 'LINE_OBS_METADATA_INVALID'],
  [{ status: 'exist', encodeStatus: 'done', futureField: { supported: true } }, null],
])('maps bounded OBS preflight state safely %#', async (body, code) => {
  const token = await mockEncryptedObsToken();
  let calls = 0;
  const adapter = await createLinejsAdapter({ ...lease, mode: 'MONITOR_ONLY', validateLease: () => false,
    physicalTransport: async () => { calls += 1; return new Response(calls === 1 ? JSON.stringify(body) : new Uint8Array([1, 2])); } });
  await adapter.installSecrets({ token: jwt, qrCert: null, e2eeStorage: null });
  const { E2EE } = await import(new URL('../../../node_modules/@evex/linejs/base/e2ee/mod.js', import.meta.url).href) as {
    E2EE: { prototype: { decryptE2EEDataMessage: (...args: any[]) => Promise<unknown> } };
  };
  const decrypt = vi.spyOn(E2EE.prototype, 'decryptE2EEDataMessage').mockResolvedValue({ keyMaterial: Buffer.alloc(32, 1).toString('base64') });
  const decryptMedia = vi.spyOn(E2EE.prototype, 'decryptByKeyMaterial').mockResolvedValue(Buffer.from([7, 8]));
  try {
    const attempt = adapter.download('image', '9', 'OID_123', encryptedAttachmentMessage('image'),
      { signal: new AbortController().signal, maxBytes: 1024, identity: { ...attachmentIdentity, kind: 'image' } });
    if (code === null) {
      await expect(attempt).resolves.toMatchObject({ name: null });
      expect(calls).toBe(2);
    } else {
      await expect(attempt).rejects.toMatchObject({ code });
      expect(calls).toBe(1);
    }
  } finally { decryptMedia.mockRestore(); decrypt.mockRestore(); token.mockRestore(); }
});

it('bounds ing retry to six preflight cycles and five two-second delays, then clears timers', async () => {
  vi.useFakeTimers();
  const token = await mockEncryptedObsToken();
  let calls = 0;
  let firstRequest!: () => void;
  const first = new Promise<void>((resolve) => { firstRequest = resolve; });
  const adapter = await createLinejsAdapter({ ...lease, mode: 'MONITOR_ONLY', validateLease: () => false,
    physicalTransport: async () => { calls += 1; firstRequest(); return new Response(JSON.stringify({ status: 'exist', encodeStatus: 'ing' })); } });
  await adapter.installSecrets({ token: jwt, qrCert: null, e2eeStorage: null });
  const identity = { ...attachmentIdentity, kind: 'image' as const, externalAttachmentId: '9' };
  try {
    const pending = adapter.download('image', '9', '9', { id: '9', from: senderMidFixture(), to: identity.chatId,
      toType: 2, contentType: 1, contentMetadata: {} }, { signal: new AbortController().signal, maxBytes: 16, identity });
    const settled = pending.then(() => null, (error: unknown) => error);
    await first;
    await vi.runAllTimersAsync();
    expect(await settled).toMatchObject({ code: 'LINE_OBS_ENCODING_INCOMPLETE' });
    expect(calls).toBe(6);
    expect(vi.getTimerCount()).toBe(0);
  } finally { token.mockRestore(); vi.useRealTimers(); }
});

it('cancels an ing delay and removes its timer immediately on abort', async () => {
  vi.useFakeTimers();
  const token = await mockEncryptedObsToken();
  const controller = new AbortController();
  let trackedAbortListeners = 0;
  const addAbortListener = controller.signal.addEventListener.bind(controller.signal);
  const removeAbortListener = controller.signal.removeEventListener.bind(controller.signal);
  const addSpy = vi.spyOn(controller.signal, 'addEventListener').mockImplementation(((type: string, listener: EventListenerOrEventListenerObject | null, options?: boolean | AddEventListenerOptions) => {
    if (type === 'abort') trackedAbortListeners += 1;
    return addAbortListener(type, listener, options);
  }) as typeof controller.signal.addEventListener);
  const removeSpy = vi.spyOn(controller.signal, 'removeEventListener').mockImplementation(((type: string, listener: EventListenerOrEventListenerObject | null, options?: boolean | EventListenerOptions) => {
    if (type === 'abort') trackedAbortListeners -= 1;
    return removeAbortListener(type, listener, options);
  }) as typeof controller.signal.removeEventListener);
  let firstRequest!: () => void;
  const first = new Promise<void>((resolve) => { firstRequest = resolve; });
  const adapter = await createLinejsAdapter({ ...lease, mode: 'MONITOR_ONLY', validateLease: () => false,
    physicalTransport: async () => { firstRequest(); return new Response(JSON.stringify({ status: 'exist', encodeStatus: 'ing' })); } });
  await adapter.installSecrets({ token: jwt, qrCert: null, e2eeStorage: null });
  const identity = { ...attachmentIdentity, kind: 'image' as const, externalAttachmentId: '9' };
  try {
    const pending = adapter.download('image', '9', '9', { id: '9', from: senderMidFixture(), to: identity.chatId,
      toType: 2, contentType: 1, contentMetadata: {} }, { signal: controller.signal, maxBytes: 16, identity });
    const settled = pending.then(() => null, (error: unknown) => error);
    await first;
    await vi.advanceTimersByTimeAsync(0);
    expect(vi.getTimerCount()).toBe(1);
    controller.abort(new Error('cancel during preflight retry delay'));
    expect(await settled).toMatchObject({ code: 'LINE_DOWNLOAD_CANCELLED' });
    expect(vi.getTimerCount()).toBe(0);
    expect(trackedAbortListeners).toBe(0);
  } finally { addSpy.mockRestore(); removeSpy.mockRestore(); token.mockRestore(); vi.useRealTimers(); }
});

it('cancels oversized object-info streams at the 16 KiB bound', async () => {
  const token = await mockEncryptedObsToken();
  let cancelled = false;
  const adapter = await createLinejsAdapter({ ...lease, mode: 'MONITOR_ONLY', validateLease: () => false,
    physicalTransport: async () => new Response(new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(new Uint8Array([123])); },
      cancel() { cancelled = true; },
    }), { headers: { 'content-length': String(16 * 1024 + 1) } }) });
  await adapter.installSecrets({ token: jwt, qrCert: null, e2eeStorage: null });
  const identity = { ...attachmentIdentity, kind: 'image' as const, externalAttachmentId: '9' };
  try {
    await expect(adapter.download('image', '9', '9', { id: '9', from: senderMidFixture(), to: identity.chatId,
      toType: 2, contentType: 1, contentMetadata: {} }, { signal: new AbortController().signal, maxBytes: 16, identity }))
      .rejects.toMatchObject({ code: 'LINE_MEDIA_SIZE_LIMIT' });
    expect(cancelled).toBe(true);
  } finally { token.mockRestore(); }
});

it('cancels a 202 response body before retrying preflight', async () => {
  vi.useFakeTimers();
  const token = await mockEncryptedObsToken();
  let cancelled = false;
  let calls = 0;
  const adapter = await createLinejsAdapter({ ...lease, mode: 'MONITOR_ONLY', validateLease: () => false,
    physicalTransport: async () => {
      calls += 1;
      if (calls === 1) return new Response(new ReadableStream<Uint8Array>({
        start(controller) { controller.enqueue(new Uint8Array([1])); }, cancel() { cancelled = true; },
      }), { status: 202 });
      return calls === 2 ? new Response(JSON.stringify({ status: 'exist' })) : new Response(new Uint8Array([7]));
    } });
  await adapter.installSecrets({ token: jwt, qrCert: null, e2eeStorage: null });
  const identity = { ...attachmentIdentity, kind: 'image' as const, externalAttachmentId: '9' };
  try {
    const pending = adapter.download('image', '9', '9', { id: '9', from: senderMidFixture(), to: identity.chatId,
      toType: 2, contentType: 1, contentMetadata: {} }, { signal: new AbortController().signal, maxBytes: 16, identity });
    const settled = pending.then((value) => value, (error: unknown) => { throw error; });
    await vi.runAllTimersAsync();
    const result = await settled;
    const bytes: Uint8Array[] = [];
    for await (const chunk of result.source) bytes.push(chunk);
    expect(Buffer.concat(bytes)).toEqual(Buffer.from([7]));
    expect(cancelled).toBe(true);
    expect(calls).toBe(3);
    expect(vi.getTimerCount()).toBe(0);
  } finally { token.mockRestore(); vi.useRealTimers(); }
});

it('uses the plain message ID and optional original TID without encrypted headers', async () => {
  const token = await mockEncryptedObsToken();
  const requests: Request[] = [];
  const adapter = await createLinejsAdapter({ ...lease, mode: 'MONITOR_ONLY', validateLease: () => false,
    physicalTransport: async (request) => { requests.push(request); return requests.length === 1
      ? new Response(JSON.stringify({ status: 'exist' })) : new Response(new Uint8Array([1, 2, 3])); } });
  await adapter.installSecrets({ token: jwt, qrCert: null, e2eeStorage: null });
  const identity = { ...attachmentIdentity, kind: 'image' as const, externalAttachmentId: '9' };
  try {
    const result = await adapter.download('image', '9', '9', { id: '9', from: senderMidFixture(),
      to: identity.chatId, toType: 2, contentType: 1,
      contentMetadata: { MEDIA_CONTENT_INFO: '{"category":"original"}' } },
    { signal: new AbortController().signal, maxBytes: 16, identity });
    const chunks: Uint8Array[] = [];
    for await (const chunk of result.source) chunks.push(chunk);
    expect(Buffer.concat(chunks)).toEqual(Buffer.from([1, 2, 3]));
    expect(new URL(requests[0]!.url).pathname).toBe('/r/talk/m/9/object_info.obs');
    expect(new URL(requests[1]!.url).pathname).toBe('/r/talk/m/9/original');
    expect(requests[1]!.headers.get('x-talk-meta')).toBeNull();
    expect(token).toHaveBeenCalledOnce();
  } finally { token.mockRestore(); }
});

it('serializes the real LINEJS encrypted-token RPC with feature type 2 before any OBS request', async () => {
  const { TalkService } = await import(new URL('../../../node_modules/@evex/linejs/base/service/talk/mod.js', import.meta.url).href) as {
    TalkService: { prototype: { acquireEncryptedAccessToken: (...args: any[]) => Promise<string> } };
  };
  const original = TalkService.prototype.acquireEncryptedAccessToken;
  const rpcArgs: unknown[][] = [];
  const rpc = vi.spyOn(TalkService.prototype, 'acquireEncryptedAccessToken').mockImplementation(function(this: unknown, ...args: any[]) {
    rpcArgs.push(args);
    return original.apply(this as never, args as never);
  });
  const { RequestClient } = await import(new URL('../../../node_modules/@evex/linejs/base/request/mod.js', import.meta.url).href) as {
    RequestClient: { prototype: { request: (...args: any[]) => Promise<unknown> } };
  };
  const originalRequest = RequestClient.prototype.request;
  const requestArgs: unknown[][] = [];
  const requestSpy = vi.spyOn(RequestClient.prototype, 'request').mockImplementation(function(this: unknown, ...args: any[]) {
    requestArgs.push(args);
    return originalRequest.apply(this as never, args as never);
  });
  const { Thrift, LINEStruct } = await import(new URL('../../../node_modules/@evex/linejs/base/thrift/mod.js', import.meta.url).href) as {
    Thrift: { prototype: { writeThrift: (...args: any[]) => Uint8Array } };
    LINEStruct: { acquireEncryptedAccessToken_args: (args: { featureType: number }) => unknown };
  };
  const originalWrite = Thrift.prototype.writeThrift;
  const serialized: Array<{ value: unknown; method: string }> = [];
  const write = vi.spyOn(Thrift.prototype, 'writeThrift').mockImplementation(function(this: unknown, value: unknown, method: string, ...rest: any[]) {
    serialized.push({ value, method });
    return originalWrite.call(this as never, value, method, ...rest as never);
  });
  const requests: Request[] = [];
  const adapter = await createLinejsAdapter({ ...lease, mode: 'MONITOR_ONLY', validateLease: () => false,
    physicalTransport: async (request) => { requests.push(request); throw new Error('controlled RPC transport stop'); } });
  await adapter.installSecrets({ token: jwt, qrCert: null, e2eeStorage: null });
  const identity = { ...attachmentIdentity, kind: 'image' as const, externalAttachmentId: '9' };
  try {
    await expect(adapter.download('image', '9', '9', { id: '9', from: senderMidFixture(), to: identity.chatId,
      toType: 2, contentType: 1, contentMetadata: {} },
    { signal: new AbortController().signal, maxBytes: 16, identity })).rejects.toMatchObject({ code: 'LINE_OBS_TOKEN_RPC_FAILED' });
    expect(rpcArgs).toEqual([[{ featureType: 2 }]]);
    expect(requestArgs[0]?.[1]).toBe('acquireEncryptedAccessToken');
    expect(requestArgs[0]?.[4]).toBe('/S4');
    expect(serialized).toContainEqual({ method: 'acquireEncryptedAccessToken',
      value: LINEStruct.acquireEncryptedAccessToken_args({ featureType: 2 }) });
    expect(requests).toHaveLength(1);
    expect(requests[0]!.url).toBe('https://gf.line.naver.jp/enc');
    expect(requests[0]!.method).toBe('POST');
    expect(requests[0]!.headers.get('x-line-application')).toContain('DESKTOPWIN');
    expect(requests.some((request) => new URL(request.url).hostname === 'obs.line-apps.com')).toBe(false);
  } finally { requestSpy.mockRestore(); rpc.mockRestore(); write.mockRestore(); }
});

it.each(['token', 'metadata'] as const)('preserves a decoded Talk rejection from the %s attachment RPC after one physical request', async (phase) => {
  const { E2EE } = await import(new URL('../../../node_modules/@evex/linejs/base/e2ee/mod.js', import.meta.url).href) as {
    E2EE: { prototype: { decryptE2EEDataMessage: (...args: any[]) => Promise<unknown> } };
  };
  const { LegyEncryptedTransport } = await import(new URL('../../../node_modules/@evex/linejs/base/request/legy.js', import.meta.url).href) as {
    LegyEncryptedTransport: { prototype: { fetch: (request: Request, fetcher: (request: Request) => Promise<Response>,
      options: { endpoint?: string }) => Promise<Response> } };
  };
  const secret = 'token=private MID=u12345678901234567890123456789012 reason=private';
  const method = phase === 'token' ? 'acquireEncryptedAccessToken' : 'getLastE2EEPublicKeys';
  const decrypt = phase === 'metadata' ? vi.spyOn(E2EE.prototype, 'decryptE2EEDataMessage')
    .mockImplementation(async function(this: { client: BaseClient }) {
      await this.client.talk.getLastE2EEPublicKeys({ chatMid: attachmentIdentity.chatId });
      throw new Error('unreachable');
    }) : null;
  const legy = vi.spyOn(LegyEncryptedTransport.prototype, 'fetch').mockImplementation(async (_request, fetcher, options) => {
    await fetcher(new Request(options.endpoint ?? 'https://gf.line.naver.jp/enc', { method: 'POST', body: 'fixture' }));
    return await linejsTalkRejectionResponse(method, 84, secret);
  });
  const physicalTransport = vi.fn(async () => new Response());
  const adapter = await createLinejsAdapter({ ...lease, mode: 'MONITOR_ONLY', validateLease: () => false, physicalTransport });
  await adapter.installSecrets({ token: jwt, qrCert: null, e2eeStorage: null });
  try {
    const identity = { ...attachmentIdentity, kind: 'image' as const,
      externalAttachmentId: phase === 'token' ? '9' : 'OID_123' };
    const message = phase === 'token' ? { id: '9', from: `u${'c'.repeat(32)}`, to: identity.chatId,
      toType: 2, contentType: 1, contentMetadata: {} }
      : encryptedAttachmentMessage('image');
    const error = await adapter.download('image', '9', identity.externalAttachmentId, message,
      { signal: new AbortController().signal, maxBytes: 1024, identity }).catch((value: unknown) => value);
    expect(error).toMatchObject({ code: phase === 'token' ? 'LINE_OBS_TOKEN_RPC_FAILED' : 'LINE_E2EE_METADATA_RPC_FAILED',
      serverErrorCode: 'LINE_TALK_E2EE_UPDATE_RECEIVER_KEY', upstreamCode: 84 });
    expect(physicalTransport).toHaveBeenCalledOnce();
    expect(legy).toHaveBeenCalledOnce();
    expect(JSON.stringify(error)).not.toContain(secret);
  } finally { adapter.revoke(); decrypt?.mockRestore(); legy.mockRestore(); }
});

it('keeps an unknown Talk token rejection at the attachment phase fallback', async () => {
  const { LegyEncryptedTransport } = await import(new URL('../../../node_modules/@evex/linejs/base/request/legy.js', import.meta.url).href) as {
    LegyEncryptedTransport: { prototype: { fetch: (request: Request, fetcher: (request: Request) => Promise<Response>,
      options: { endpoint?: string }) => Promise<Response> } };
  };
  const secret = 'token=private reason=private';
  const legy = vi.spyOn(LegyEncryptedTransport.prototype, 'fetch').mockImplementation(async (_request, fetcher, options) => {
    await fetcher(new Request(options.endpoint ?? 'https://gf.line.naver.jp/enc', { method: 'POST', body: 'fixture' }));
    return await linejsTalkRejectionResponse('acquireEncryptedAccessToken', 999, secret);
  });
  const physicalTransport = vi.fn(async () => new Response());
  const adapter = await createLinejsAdapter({ ...lease, mode: 'MONITOR_ONLY', validateLease: () => false, physicalTransport });
  await adapter.installSecrets({ token: jwt, qrCert: null, e2eeStorage: null });
  try {
    const identity = { ...attachmentIdentity, kind: 'image' as const, externalAttachmentId: '9' };
    const error = await adapter.download('image', '9', '9', { id: '9', from: `u${'c'.repeat(32)}`,
      to: identity.chatId, toType: 2, contentType: 1, contentMetadata: {} },
    { signal: new AbortController().signal, maxBytes: 1024, identity }).catch((value: unknown) => value);
    expect(error).toMatchObject({ code: 'LINE_OBS_TOKEN_RPC_FAILED' });
    expect(error.serverErrorCode).toBeUndefined();
    expect(error.upstreamCode).toBeUndefined();
    expect(physicalTransport).toHaveBeenCalledOnce();
    expect(JSON.stringify(error)).not.toContain(secret);
  } finally { adapter.revoke(); legy.mockRestore(); }
});

it('decodes the LINEJS Thrift token success field as the wire string consumed by the adapter', async () => {
  const { Protocols } = await import(new URL('../../../node_modules/@evex/linejs/base/thrift/mod.js', import.meta.url).href) as {
    Protocols: Record<number, any>;
  };
  const client = new BaseClient({ device: 'DESKTOPWIN' });
  const nativeToken = '172800\u001eobs-wire-token';
  // acquireEncryptedAccessToken_result.success is Thrift field 0, STRING.
  const wireResponse = Buffer.from(client.thrift.writeThrift([[11, 0, nativeToken]], 'acquireEncryptedAccessToken', Protocols[3]!));
  wireResponse[3] = 2; // TMessageType.REPLY; LINEJS reads the same binary method/result shape.
  const parsed = client.thrift.readThrift(wireResponse, Protocols[3]!);
  expect(parsed._info.mtype).toBe(2);
  client.thrift.rename_data(parsed);
  expect(parsed.data.success).toBe(nativeToken);
});

it('rejects a malformed real token RPC result before any OBS request', async () => {
  const token = await mockEncryptedObsToken();
  token.mockResolvedValue('not-a-token-response');
  const requests: Request[] = [];
  const adapter = await createLinejsAdapter({ ...lease, mode: 'MONITOR_ONLY', validateLease: () => false,
    physicalTransport: async (request) => { requests.push(request); return new Response(); } });
  await adapter.installSecrets({ token: jwt, qrCert: null, e2eeStorage: null });
  const identity = { ...attachmentIdentity, kind: 'image' as const, externalAttachmentId: '9' };
  try {
    await expect(adapter.download('image', '9', '9', { id: '9', from: senderMidFixture(), to: identity.chatId,
      toType: 2, contentType: 1, contentMetadata: {} },
    { signal: new AbortController().signal, maxBytes: 16, identity })).rejects.toMatchObject({ code: 'LINE_OBS_TOKEN_INVALID' });
    expect(requests).toEqual([]);
  } finally { token.mockRestore(); }
});

it('authenticates full video chunks using the CLI 128 KiB chunk-HMAC rule', async () => {
  const { E2EE } = await import(new URL('../../../node_modules/@evex/linejs/base/e2ee/mod.js', import.meta.url).href) as {
    E2EE: { prototype: { decryptE2EEDataMessage: (...args: any[]) => Promise<unknown>; deriveKeyMaterial: (key: Buffer) => Promise<any>;
      ___encryptAESCTR: (key: Buffer, nonce: Buffer, data: Buffer) => Promise<Buffer> } };
  };
  const e2ee = Object.create(E2EE.prototype) as InstanceType<typeof E2EE>;
  const key = Buffer.alloc(32, 0x42);
  const plaintext = Buffer.alloc(140_000, 0x61);
  const keys = await e2ee.deriveKeyMaterial(key);
  const encrypted = await e2ee.___encryptAESCTR(keys.encKey, keys.nonce, plaintext);
  const mac = createHmac('sha256', keys.macKey);
  for (let offset = 0; offset < encrypted.length; offset += 128 * 1024) {
    mac.update(createHash('sha256').update(encrypted.subarray(offset, offset + 128 * 1024)).digest());
  }
  const fixture = Buffer.concat([encrypted, mac.digest()]);
  const decrypt = vi.spyOn(E2EE.prototype, 'decryptE2EEDataMessage').mockResolvedValue({ keyMaterial: key.toString('base64') });
  const token = await mockEncryptedObsToken();
  let requestCount = 0;
  const adapter = await createLinejsAdapter({ ...lease, mode: 'MONITOR_ONLY', validateLease: () => false,
    physicalTransport: async () => ++requestCount === 1
      ? new Response(JSON.stringify({ status: 'exist', encodeStatus: 'done' })) : new Response(fixture) });
  await adapter.installSecrets({ token: jwt, qrCert: null, e2eeStorage: null });
  try {
    const identity = { ...attachmentIdentity, kind: 'video' as const };
    const result = await adapter.download('video', '9', 'OID_123', encryptedAttachmentMessage('video'),
      { signal: new AbortController().signal, maxBytes: 200_000, identity });
    const output: Uint8Array[] = [];
    for await (const chunk of result.source) output.push(chunk);
    expect(Buffer.concat(output)).toEqual(plaintext);
    expect(requestCount).toBe(2);
  } finally { decrypt.mockRestore(); token.mockRestore(); }
});

it.each(['tamper', 'truncate'] as const)('rejects %s full-video ciphertext without returning plaintext', async (damage) => {
  const { E2EE } = await import(new URL('../../../node_modules/@evex/linejs/base/e2ee/mod.js', import.meta.url).href) as {
    E2EE: { prototype: { decryptE2EEDataMessage: (...args: any[]) => Promise<unknown>; deriveKeyMaterial: (key: Buffer) => Promise<any>;
      ___encryptAESCTR: (key: Buffer, nonce: Buffer, data: Buffer) => Promise<Buffer> } };
  };
  const e2ee = Object.create(E2EE.prototype) as InstanceType<typeof E2EE>;
  const key = Buffer.alloc(32, 0x43);
  const encrypted = await e2ee.___encryptAESCTR((await e2ee.deriveKeyMaterial(key)).encKey,
    (await e2ee.deriveKeyMaterial(key)).nonce, Buffer.from('video bytes'));
  const keys = await e2ee.deriveKeyMaterial(key);
  const mac = createHmac('sha256', keys.macKey).update(createHash('sha256').update(encrypted).digest()).digest();
  const valid = Buffer.concat([encrypted, mac]);
  const damaged = damage === 'tamper' ? Buffer.from(valid) : valid.subarray(0, 20);
  if (damage === 'tamper') damaged[damaged.length - 1] ^= 1;
  const decrypt = vi.spyOn(E2EE.prototype, 'decryptE2EEDataMessage').mockResolvedValue({ keyMaterial: key.toString('base64') });
  const token = await mockEncryptedObsToken();
  let calls = 0;
  const adapter = await createLinejsAdapter({ ...lease, mode: 'MONITOR_ONLY', validateLease: () => false,
    physicalTransport: async () => ++calls === 1 ? new Response(JSON.stringify({ status: 'exist' })) : new Response(damaged) });
  await adapter.installSecrets({ token: jwt, qrCert: null, e2eeStorage: null });
  try {
    await expect(adapter.download('video', '9', 'OID_123', encryptedAttachmentMessage('video'),
      { signal: new AbortController().signal, maxBytes: 1024, identity: { ...attachmentIdentity, kind: 'video' } }))
      .rejects.toMatchObject({ code: 'LINE_MEDIA_AUTH_FAILED' });
    expect(calls).toBe(2);
  } finally { decrypt.mockRestore(); token.mockRestore(); }
});

it.each(['tamper', 'truncate'] as const)('rejects %s authenticated audio ciphertext without returning bytes', async (damage) => {
  const { E2EE } = await import(new URL('../../../node_modules/@evex/linejs/base/e2ee/mod.js', import.meta.url).href) as {
    E2EE: { prototype: { decryptE2EEDataMessage: (...args: any[]) => Promise<unknown>;
      encryptByKeyMaterial: (...args: any[]) => Promise<{ encryptedData: Buffer }> } };
  };
  const e2ee = Object.create(E2EE.prototype) as InstanceType<typeof E2EE>;
  const key = Buffer.alloc(32, 0x53);
  const valid = (await e2ee.encryptByKeyMaterial(Buffer.from('audio bytes'), key)).encryptedData;
  const damaged = damage === 'tamper' ? Buffer.from(valid) : valid.subarray(0, valid.length - 12);
  if (damage === 'tamper') damaged[damaged.length - 1] ^= 1;
  const decrypt = vi.spyOn(E2EE.prototype, 'decryptE2EEDataMessage').mockResolvedValue({ keyMaterial: key.toString('base64') });
  const token = await mockEncryptedObsToken();
  let calls = 0;
  const adapter = await createLinejsAdapter({ ...lease, mode: 'MONITOR_ONLY', validateLease: () => false,
    physicalTransport: async () => ++calls === 1 ? new Response(JSON.stringify({ status: 'exist' })) : new Response(damaged) });
  await adapter.installSecrets({ token: jwt, qrCert: null, e2eeStorage: null });
  try {
    await expect(adapter.download('audio', '9', 'OID_123', encryptedAttachmentMessage('audio'),
      { signal: new AbortController().signal, maxBytes: 1024,
        identity: { ...attachmentIdentity, kind: 'audio' } as never })).rejects.toMatchObject({ code: 'LINE_MEDIA_AUTH_FAILED' });
    expect(calls).toBe(2);
  } finally { decrypt.mockRestore(); token.mockRestore(); }
});

function senderMidFixture(): string { return `u${'c'.repeat(32)}`; }

it.each([
  ['ObsError', { status: 410 }, 'LINE_OBS_HTTP_410'],
  ['E2EEMediaError', { key: 'private-key' }, 'LINE_MEDIA_AUTH_FAILED'],
  ['NoE2EEKey', { key: 'private-key' }, 'LINE_E2EE_SELF_KEY_MISSING'],
  ['No E2EEKey', { key: 'private-key' }, 'LINE_E2EE_PEER_KEY_UNAVAILABLE'],
  ['E2EEKeyMismatch', { key: 'private-key' }, 'LINE_E2EE_KEY_MISMATCH'],
  ['Not support E2EE', { key: 'private-key' }, 'LINE_E2EE_UNSUPPORTED'],
  ['RequestError', { code: 'OTHER_PRIVATE_CODE' }, 'LINE_E2EE_METADATA_RPC_FAILED'],
])('maps pinned native %s to a fixed safe attachment diagnostic', async (nativeType, data, safeCode) => {
  const { E2EE } = await import(new URL('../../../node_modules/@evex/linejs/base/e2ee/mod.js', import.meta.url).href) as {
    E2EE: { prototype: { decryptE2EEDataMessage: (...args: any[]) => Promise<unknown> } };
  };
  const failure = new InternalError(nativeType, 'secret exception text https://private.example/?token=secret', data as Record<string, unknown>);
  const decrypt = vi.spyOn(E2EE.prototype, 'decryptE2EEDataMessage').mockRejectedValue(failure);
  const token = await mockEncryptedObsToken();
  if (nativeType === 'RequestError') token.mockRejectedValue(failure);
  const adapter = await createLinejsAdapter({ ...lease, mode: 'MONITOR_ONLY', validateLease: () => false,
    physicalTransport: async () => new Response() });
  await adapter.installSecrets({ token: jwt, qrCert: null, e2eeStorage: null });
  try {
    const identity = { ...attachmentIdentity, kind: 'image' as const };
    const error = await adapter.download('image', '9', 'OID_123', encryptedAttachmentMessage('image'),
      { signal: new AbortController().signal, maxBytes: 1024, identity }).catch((value: unknown) => value);
    expect(error).toMatchObject({ code: safeCode });
    expect(JSON.stringify(error)).not.toContain('secret');
    expect(JSON.stringify(error)).not.toContain('private.example');
  } finally { decrypt.mockRestore(); token.mockRestore(); }
});

it('does not forward arbitrary exception code data from attachment token errors', async () => {
  const { E2EE } = await import(new URL('../../../node_modules/@evex/linejs/base/e2ee/mod.js', import.meta.url).href) as {
    E2EE: { prototype: { decryptE2EEDataMessage: (...args: any[]) => Promise<unknown> } };
  };
  const decrypt = vi.spyOn(E2EE.prototype, 'decryptE2EEDataMessage').mockResolvedValue({
    keyMaterial: Buffer.alloc(32, 1).toString('base64'),
  });
  const token = await mockEncryptedObsToken();
  token.mockRejectedValue(Object.assign(new Error('private exception detail'), { code: 'ATTACHMENT_EXPIRED' }));
  const adapter = await createLinejsAdapter({ ...lease, mode: 'MONITOR_ONLY', validateLease: () => false,
    physicalTransport: async () => new Response() });
  await adapter.installSecrets({ token: jwt, qrCert: null, e2eeStorage: null });
  try {
    const identity = { ...attachmentIdentity, kind: 'image' as const };
    await expect(adapter.download('image', '9', 'OID_123', encryptedAttachmentMessage('image'),
      { signal: new AbortController().signal, maxBytes: 1024, identity })).rejects.toMatchObject({ code: 'LINE_OBS_TOKEN_RPC_FAILED' });
  } finally { decrypt.mockRestore(); token.mockRestore(); }
});

it('keeps authentication invalidation ahead of the E2EE metadata RPC stage code', async () => {
  const { E2EE } = await import(new URL('../../../node_modules/@evex/linejs/base/e2ee/mod.js', import.meta.url).href) as {
    E2EE: { prototype: { decryptE2EEDataMessage: (...args: any[]) => Promise<unknown> } };
  };
  const authFailure = new InternalError('RequestError', 'private request failure', { code: 'NOT_AUTHORIZED_DEVICE' });
  const decrypt = vi.spyOn(E2EE.prototype, 'decryptE2EEDataMessage').mockRejectedValue(authFailure);
  const token = await mockEncryptedObsToken();
  const adapter = await createLinejsAdapter({ ...lease, mode: 'MONITOR_ONLY', validateLease: () => false,
    physicalTransport: async () => new Response() });
  await adapter.installSecrets({ token: jwt, qrCert: null, e2eeStorage: null });
  const invalidated = vi.fn();
  adapter.on('authInvalidated', invalidated);
  try {
    await expect(adapter.download('image', '9', 'OID_123', encryptedAttachmentMessage('image'),
      { signal: new AbortController().signal, maxBytes: 1024, identity: { ...attachmentIdentity, kind: 'image' } }))
      .rejects.toMatchObject({ code: 'LINE_AUTH_INVALIDATED' });
    expect(invalidated).toHaveBeenCalledOnce();
    expect(token).not.toHaveBeenCalled();
  } finally { decrypt.mockRestore(); token.mockRestore(); }
});

it('authorizes a source-message Reaction as a guarded active-control TALK write', async () => {
  const requests: Request[] = [];
  const adapter = await createLinejsAdapter({ ...lease, mode: 'ACTIVE_CONTROL', validateLease: () => true,
    physicalTransport: async (request) => { requests.push(request); throw new Error('offline reaction fixture'); } });
  await adapter.installSecrets({ token: jwt, qrCert: null, e2eeStorage: null });

  await expect(adapter.react({ chatType: 'direct', chatId: 'u-peer' }, '9', 'AMAZING', lease))
    .rejects.toThrow('offline reaction fixture');
  expect(requests).toHaveLength(1);
});

it('maps OMG to the LINEJS react enum value without cancelling the reaction', async () => {
  const requests: Request[] = [];
  const adapter = await createLinejsAdapter({ ...lease, mode: 'ACTIVE_CONTROL', validateLease: () => true,
    physicalTransport: async (request) => { requests.push(request); throw new Error('offline reaction fixture'); } });
  await adapter.installSecrets({ token: jwt, qrCert: null, e2eeStorage: null });
  await expect(adapter.react({ chatType: 'direct', chatId: 'u-peer' }, '9', 'OMG', lease))
    .rejects.toThrow('offline reaction fixture');
  expect(requests).toHaveLength(1);
});

it('does not treat a LINEJS end event as authentication invalidation', async () => {
  const { BaseClient } = await import(new URL('./mod.js', import.meta.resolve('@evex/linejs/base')).href) as {
    BaseClient: { prototype: { on: (...args: any[]) => unknown } };
  };
  let ended: (() => void) | undefined;
  const original = BaseClient.prototype.on;
  const spy = vi.spyOn(BaseClient.prototype, 'on').mockImplementation(function (this: unknown, event: string, listener: (...args: any[]) => void) {
    if (event === 'end') ended = listener as () => void;
    return original.call(this, event, listener);
  });
  try {
    const adapter = await createLinejsAdapter({ ...lease, mode: 'MONITOR_ONLY', validateLease: () => false,
      physicalTransport: async () => new Response() });
    const invalidated = vi.fn();
    adapter.on('authInvalidated', invalidated);
    expect(ended).toBeUndefined();
    expect(invalidated).not.toHaveBeenCalled();
  } finally { spy.mockRestore(); }
});

it('forwards LINEJS RequestError with NOT_AUTHORIZED_DEVICE from the actual request path', async () => {
  const { RequestClient } = await import(new URL('./request/mod.js', import.meta.resolve('@evex/linejs/base')).href) as {
    RequestClient: { prototype: { request: (...args: any[]) => Promise<unknown> } };
  };
  const { InternalError } = await import(new URL('./core/mod.js', import.meta.resolve('@evex/linejs/base')).href) as {
    InternalError: new (type: string, message: string, data: Record<string, unknown>) => Error;
  };
  const authError = new InternalError('RequestError', 'Request internal failed', { code: 'NOT_AUTHORIZED_DEVICE' });
  const request = vi.spyOn(RequestClient.prototype, 'request').mockRejectedValue(authError);
  const adapter = await createLinejsAdapter({ ...lease, mode: 'MONITOR_ONLY', validateLease: () => false,
    physicalTransport: async () => new Response() });
  await adapter.installSecrets({ token: jwt, qrCert: null, e2eeStorage: null });
  const invalidated = vi.fn();
  adapter.on('authInvalidated', invalidated);

  try {
    await expect(adapter.sync(cursor)).rejects.toBe(authError);
    expect(invalidated).toHaveBeenCalledOnce();
  } finally { request.mockRestore(); }
});

it('does not convert an ordinary LINEJS network request error into auth invalidation', async () => {
  const { RequestClient } = await import(new URL('./request/mod.js', import.meta.resolve('@evex/linejs/base')).href) as {
    RequestClient: { prototype: { request: (...args: any[]) => Promise<unknown> } };
  };
  const networkError = new Error('network unavailable');
  const request = vi.spyOn(RequestClient.prototype, 'request').mockRejectedValue(networkError);
  const adapter = await createLinejsAdapter({ ...lease, mode: 'MONITOR_ONLY', validateLease: () => false,
    physicalTransport: async () => new Response() });
  await adapter.installSecrets({ token: jwt, qrCert: null, e2eeStorage: null });
  const invalidated = vi.fn();
  adapter.on('authInvalidated', invalidated);

  try {
    await expect(adapter.sync(cursor)).rejects.toBe(networkError);
    expect(invalidated).not.toHaveBeenCalled();
  } finally { request.mockRestore(); }
});

async function legyModule() {
  return await import(new URL('../../../node_modules/@evex/linejs/base/request/legy.js', import.meta.url).href) as {
    LegyEncryptedTransport: { prototype: { fetch: (request: Request, fetcher: (request: Request) => Promise<Response>,
      options: { endpoint?: string }) => Promise<Response> } };
  };
}
async function monitorAdapter(physicalTransport: (request: Request) => Promise<Response>) {
  const adapter = await createLinejsAdapter({ ...lease, mode: 'MONITOR_ONLY', validateLease: () => false, physicalTransport });
  await adapter.installSecrets({ token: jwt, qrCert: null, e2eeStorage: null });
  return adapter;
}

it('drains supplemental history on a real empty HTTP 410 sync before marking startup final', async () => {
  const { TalkService } = await import(new URL('../../../node_modules/@evex/linejs/base/service/talk/mod.js', import.meta.url).href) as {
    TalkService: { prototype: { sync: (...args: any[]) => Promise<unknown>;
      getRecentMessagesV2: (...args: any[]) => Promise<unknown> } };
  };
  const { E2EE } = await import(new URL('../../../node_modules/@evex/linejs/base/e2ee/mod.js', import.meta.url).href) as {
    E2EE: { prototype: { decryptE2EEMessage: (...args: any[]) => Promise<unknown> } };
  };
  const chatId = `c${'d'.repeat(32)}`;
  const history = Array.from({ length: 20 }, (_, index) => ({ id: `history-${index}` }));
  const operations = [{ type: 'NOTIFIED_READ_MESSAGE', revision: 1n, param1: chatId,
    param2: `u${'e'.repeat(32)}`, param3: '1', createdTime: 1_760_000_000_000 },
  ...Array.from({ length: 99 }, (_, index) => ({ revision: BigInt(index + 2), type: 26, message: { id: `raw-${index}` } }))];
  const sync = vi.spyOn(TalkService.prototype, 'sync').mockResolvedValueOnce({
    operationResponse: { operations, globalEvents: { lastRevision: '100' } },
  });
  const recent = vi.spyOn(TalkService.prototype, 'getRecentMessagesV2').mockResolvedValue(history);
  const decrypt = vi.spyOn(E2EE.prototype, 'decryptE2EEMessage').mockImplementation(async (_encrypted: unknown) => {
    const id = (_encrypted as { id: string }).id;
    return { id, from: `u${'f'.repeat(32)}`, to: 'u-self', contentType: 'NONE', text: id, createdTime: 1_760_000_000_000 };
  });
  const physicalTransport = vi.fn(async () => new Response(null, { status: 410 }));
  const adapter = await monitorAdapter(physicalTransport);
  try {
    const first = await adapter.sync(cursor);
    expect(first).toMatchObject({ rawOperationCount: 100, hasMoreStartupItems: true });
    expect(first.operations).toHaveLength(100);
    expect(recent).toHaveBeenCalledOnce();

    const final = await adapter.sync(first.cursorAfter);
    expect(final).toMatchObject({ rawOperationCount: 0, hasMoreStartupItems: false });
    expect(final.operations).toHaveLength(19);
    expect(final.operations.every((item) => typeof item === 'object' && item !== null && 'source' in item && item.source === 'history')).toBe(true);
    expect(physicalTransport).toHaveBeenCalledOnce();
    expect(sync).toHaveBeenCalledTimes(2);
  } finally {
    adapter.revoke();
    sync.mockRestore(); recent.mockRestore(); decrypt.mockRestore();
  }
});

it('treats an empty HTTP 410 sync long poll as a normal empty result after one physical request', async () => {
  const physicalTransport = vi.fn(async () => new Response(null, { status: 410 }));
  const adapter = await monitorAdapter(physicalTransport);
  try {
    await expect(adapter.sync(cursor)).resolves.toEqual({ cursorAfter: cursor, operations: [], rawOperationCount: 0, hasMoreStartupItems: false });
    expect(physicalTransport).toHaveBeenCalledOnce();
  } finally { adapter.revoke(); }
});

it('treats an HTTP 410 sync with a non-Thrift body as a normal empty result', async () => {
  const { LegyEncryptedTransport } = await legyModule();
  const legy = vi.spyOn(LegyEncryptedTransport.prototype, 'fetch').mockImplementation(async (_request, fetcher, options) => {
    await fetcher(new Request(options.endpoint ?? 'https://gf.line.naver.jp/enc', { method: 'POST', body: 'fixture' }));
    return new Response('not thrift', { status: 410 });
  });
  const physicalTransport = vi.fn(async () => new Response(null, { status: 410 }));
  const adapter = await monitorAdapter(physicalTransport);
  try {
    await expect(adapter.sync(cursor)).resolves.toEqual({ cursorAfter: cursor, operations: [], rawOperationCount: 0, hasMoreStartupItems: false });
    expect(physicalTransport).toHaveBeenCalledOnce();
    expect(legy).toHaveBeenCalledOnce();
  } finally { adapter.revoke(); legy.mockRestore(); }
});

it('keeps a decoded Talk rejection on an HTTP 410 sync as a LineServerRejection', async () => {
  const { LegyEncryptedTransport } = await legyModule();
  const secret = 'token=private MID=u12345678901234567890123456789012';
  const legy = vi.spyOn(LegyEncryptedTransport.prototype, 'fetch').mockImplementation(async (_request, fetcher, options) => {
    await fetcher(new Request(options.endpoint ?? 'https://gf.line.naver.jp/enc', { method: 'POST', body: 'fixture' }));
    const rejected = await linejsTalkRejectionResponse('sync', 4, secret);
    return new Response(await rejected.arrayBuffer(), { status: 410 });
  });
  const physicalTransport = vi.fn(async () => new Response(null, { status: 410 }));
  const adapter = await monitorAdapter(physicalTransport);
  try {
    const error = await adapter.sync(cursor).catch((value: unknown) => value);
    expect(error).toBeInstanceOf(LineServerRejection);
    expect(error).toMatchObject({ code: 'LINE_TALK_EXCESSIVE_ACCESS', upstreamCode: 4 });
    expect(physicalTransport).toHaveBeenCalledOnce();
  } finally { adapter.revoke(); legy.mockRestore(); }
});

it('still rejects an empty HTTP 500 sync and a sync network error', async () => {
  const serverError = vi.fn(async () => new Response(null, { status: 500 }));
  const failing = await monitorAdapter(serverError);
  try {
    await expect(failing.sync(cursor)).rejects.toThrow('status=500');
    expect(serverError).toHaveBeenCalledOnce();
  } finally { failing.revoke(); }
  const networkError = new Error('network unavailable');
  const offline = await monitorAdapter(async () => { throw networkError; });
  try { await expect(offline.sync(cursor)).rejects.toBe(networkError); }
  finally { offline.revoke(); }
});

it('does not treat an empty HTTP 410 on a different RPC as a normal result', async () => {
  const physicalTransport = vi.fn(async () => new Response(null, { status: 410 }));
  const adapter = await monitorAdapter(physicalTransport);
  try {
    await expect(adapter.refreshOwnProfile()).rejects.toThrow('status=410');
    expect(physicalTransport).toHaveBeenCalledOnce();
  } finally { adapter.revoke(); }
});

it('sends the same sync request for an HTTP 410 answer and an HTTP 200 answer', async () => {
  const { LegyEncryptedTransport } = await legyModule();
  const client = new BaseClient({ device: 'DESKTOPWIN' });
  const okBody = Buffer.from(client.thrift.writeThrift([[12, 0, [[8, 99, 1]]]], 'sync', Protocols[4]!));
  okBody[1] = 0x41;
  const seen: Array<{ method: string; url: string; headers: Array<[string, string]>; body: string }> = [];
  let answer = new Response(null, { status: 410 });
  const legy = vi.spyOn(LegyEncryptedTransport.prototype, 'fetch').mockImplementation(async (request, fetcher, options) => {
    seen.push({ method: request.method, url: request.url, headers: [...request.headers.entries()].sort(),
      body: Buffer.from(await request.clone().arrayBuffer()).toString('hex') });
    await fetcher(new Request(options.endpoint ?? 'https://gf.line.naver.jp/enc', { method: 'POST', body: 'fixture' }));
    return answer;
  });
  const physicalTransport = vi.fn(async () => new Response(null, { status: answer.status }));
  const adapter = await monitorAdapter(physicalTransport);
  try {
    await expect(adapter.sync(cursor)).resolves.toEqual({ cursorAfter: cursor, operations: [], rawOperationCount: 0, hasMoreStartupItems: false });
    answer = new Response(okBody, { status: 200 });
    await expect(adapter.sync(cursor)).resolves.toMatchObject({ operations: [] });
    expect(physicalTransport).toHaveBeenCalledTimes(2);
    expect(seen).toHaveLength(2);
    expect(seen[1]).toEqual(seen[0]);
    expect(new URL(seen[0]!.url).pathname).toBe('/SYNC4');
  } finally { adapter.revoke(); legy.mockRestore(); }
});

it('denies monitor sends and stale active sends before the physical RequestClient fetch', async () => {
  const physicalTransport = vi.fn(async () => { throw new Error('network must not be reached'); });
  const monitor = await createLinejsAdapter({ ...lease, mode: 'MONITOR_ONLY', validateLease: () => true, physicalTransport });
  await monitor.installSecrets({ token: jwt, qrCert: null, e2eeStorage: null });
  await expect(monitor.send({ chatType: 'direct', chatId: 'u-peer' }, 'hello', null, lease)).rejects.toMatchObject({ code: 'SIDE_EFFECT_DENIED' });
  const active = await createLinejsAdapter({ ...lease, mode: 'ACTIVE_CONTROL', validateLease: () => false, physicalTransport });
  await active.installSecrets({ token: jwt, qrCert: null, e2eeStorage: null });
  await expect(active.send({ chatType: 'direct', chatId: 'u-peer' }, 'hello', null, lease)).rejects.toMatchObject({ code: 'SIDE_EFFECT_DENIED' });
  expect(physicalTransport).not.toHaveBeenCalled();
});

it('allows a manual send through a monitor adapter using only the guarded native sendMessage RPC', async () => {
  const { E2EE } = await import(new URL('../../../node_modules/@evex/linejs/base/e2ee/mod.js', import.meta.url).href) as {
    E2EE: { prototype: object };
  };
  const encrypt = vi.spyOn(E2EE.prototype as any, 'encryptE2EEMessage').mockResolvedValue([Buffer.from([1, 2, 3])]);
  const physicalTransport = vi.fn(async () => { throw new Error('manual send reached physical transport'); });
  const monitor = await createLinejsAdapter({ ...lease, mode: 'MONITOR_ONLY', validateLease: () => true, physicalTransport });
  await monitor.installSecrets({ token: jwt, qrCert: null, e2eeStorage: null });
  try {
    await expect(monitor.send({ chatType: 'direct', chatId: 'u-peer' }, 'human text', null, lease, true))
      .rejects.toThrow('manual send reached physical transport');
    expect(encrypt).toHaveBeenCalledOnce();
    expect(physicalTransport).toHaveBeenCalledOnce();
  } finally { encrypt.mockRestore(); }
});

it('denies a monitor manual send revoked while E2EE preparation is pending', async () => {
  const { E2EE } = await import(new URL('../../../node_modules/@evex/linejs/base/e2ee/mod.js', import.meta.url).href) as {
    E2EE: { prototype: object };
  };
  let releaseEncryption!: () => void;
  let signalEncryptionStarted!: () => void;
  const encryptionStarted = new Promise<void>((resolve) => { signalEncryptionStarted = resolve; });
  const encryptionHold = new Promise<void>((resolve) => { releaseEncryption = resolve; });
  const encrypt = vi.spyOn(E2EE.prototype as any, 'encryptE2EEMessage').mockImplementation(async () => {
    signalEncryptionStarted();
    await encryptionHold;
    return [Buffer.from([1, 2, 3])];
  });
  const physicalTransport = vi.fn(async () => new Response());
  const monitor = await createLinejsAdapter({ ...lease, mode: 'MONITOR_ONLY', validateLease: () => true, physicalTransport });
  await monitor.installSecrets({ token: jwt, qrCert: null, e2eeStorage: null });
  const sending = monitor.send({ chatType: 'direct', chatId: 'u-peer' }, 'human text', null, lease, true);
  try {
    await encryptionStarted;
    monitor.revoke();
    releaseEncryption();
    await expect(sending).rejects.toMatchObject({ code: 'SIDE_EFFECT_DENIED' });
    expect(encrypt).toHaveBeenCalledOnce();
    expect(physicalTransport).not.toHaveBeenCalled();
  } finally {
    releaseEncryption();
    encrypt.mockRestore();
  }
});

it('uses the pinned friend ID list as the authoritative relation result', async () => {
  const { RelationService } = await import(new URL('./service/relation/mod.js', import.meta.resolve('@evex/linejs/base')).href) as {
    RelationService: { prototype: { getUserFriendIds(...args: any[]): Promise<unknown>; getFriendDetails(...args: any[]): Promise<unknown> } };
  };
  const mid = `u${'a'.repeat(32)}`;
  const ids = vi.spyOn(RelationService.prototype, 'getUserFriendIds').mockResolvedValue({ userFriendMids: [mid], nextUserPageToken: '' });
  const details = vi.spyOn(RelationService.prototype, 'getFriendDetails').mockRejectedValue(new Error('detail RPC must not run'));
  const adapter = await createLinejsAdapter({ ...lease, mode: 'ACTIVE_CONTROL', validateLease: () => true,
    physicalTransport: async () => new Response() });
  try {
    expect(await adapter.checkFriendRelation(mid, lease)).toBe('friend');
    expect(ids).toHaveBeenCalledWith({ request: { blockStatus: 'NOT_BLOCK' } });
    expect(details).not.toHaveBeenCalled();
    ids.mockResolvedValue({ userFriendMids: [], nextUserPageToken: '' });
    expect(await adapter.checkFriendRelation(mid, lease)).toBe('not_friend');
    expect(details).not.toHaveBeenCalled();
  } finally { ids.mockRestore(); details.mockRestore(); }
});

it('accepts unrelated string IDs of any format but fails closed on non-string entries after the target', async () => {
  const { RelationService } = await import(new URL('./service/relation/mod.js', import.meta.resolve('@evex/linejs/base')).href) as {
    RelationService: { prototype: { getUserFriendIds(...args: any[]): Promise<unknown>; getFriendDetails(...args: any[]): Promise<unknown> } };
  };
  const mid = `u${'a'.repeat(32)}`;
  const ids = vi.spyOn(RelationService.prototype, 'getUserFriendIds').mockResolvedValue({
    userFriendMids: ['native-schema-id', mid], nextUserPageToken: '',
  });
  const details = vi.spyOn(RelationService.prototype, 'getFriendDetails').mockResolvedValue({ responses: [{
    targetUserMid: mid, friendDetail: { user: {} },
  }] });
  const adapter = await createLinejsAdapter({ ...lease, mode: 'ACTIVE_CONTROL', validateLease: () => true,
    physicalTransport: async () => new Response() });
  try {
    expect(await adapter.checkFriendRelation(mid, lease)).toBe('friend');
    expect(details).not.toHaveBeenCalled();
    ids.mockResolvedValue({ userFriendMids: [mid, 7], nextUserPageToken: '' });
    expect(await adapter.checkFriendRelationDiagnostic(mid, lease)).toEqual({
      status: 'unknown', error: 'RELATION_LIST_SHAPE_INVALID',
    });
    expect(details).not.toHaveBeenCalled();
  } finally { ids.mockRestore(); details.mockRestore(); }
});

it('follows Relation pagination and accepts a target found on a later page', async () => {
  const { RelationService } = await import(new URL('./service/relation/mod.js', import.meta.resolve('@evex/linejs/base')).href) as {
    RelationService: { prototype: { getUserFriendIds(...args: any[]): Promise<unknown>; getFriendDetails(...args: any[]): Promise<unknown> } };
  };
  const mid = `u${'a'.repeat(32)}`;
  const ids = vi.spyOn(RelationService.prototype, 'getUserFriendIds')
    .mockResolvedValueOnce({ userFriendMids: ['other-format-id'], nextUserPageToken: 'next-page' })
    .mockResolvedValueOnce({ userFriendMids: [mid], nextUserPageToken: '' });
  const details = vi.spyOn(RelationService.prototype, 'getFriendDetails').mockRejectedValue(new Error('detail RPC must not run'));
  const adapter = await createLinejsAdapter({ ...lease, mode: 'ACTIVE_CONTROL', validateLease: () => true,
    physicalTransport: async () => new Response() });
  try {
    expect(await adapter.checkFriendRelation(mid, lease)).toBe('friend');
    expect(ids.mock.calls.map(([request]) => request)).toEqual([
      { request: { blockStatus: 'NOT_BLOCK' } },
      { request: { blockStatus: 'NOT_BLOCK', userPageToken: 'next-page' } },
    ]);
    expect(details).not.toHaveBeenCalled();
  } finally { ids.mockRestore(); details.mockRestore(); }
});

it('returns unknown on repeated or over-limit Relation pagination instead of trusting a partial friend list', async () => {
  const { RelationService } = await import(new URL('./service/relation/mod.js', import.meta.resolve('@evex/linejs/base')).href) as {
    RelationService: { prototype: { getUserFriendIds(...args: any[]): Promise<unknown> } };
  };
  const mid = `u${'a'.repeat(32)}`;
  const ids = vi.spyOn(RelationService.prototype, 'getUserFriendIds').mockResolvedValue({
    userFriendMids: [], nextUserPageToken: 'repeat',
  });
  const adapter = await createLinejsAdapter({ ...lease, mode: 'ACTIVE_CONTROL', validateLease: () => true,
    physicalTransport: async () => new Response() });
  try {
    expect(await adapter.checkFriendRelation(mid, lease)).toBe('unknown');
    expect(ids).toHaveBeenCalledTimes(2);
    ids.mockClear();
    let page = 0;
    ids.mockImplementation(async () => { page += 1; return { userFriendMids: [], nextUserPageToken: `next-${page}` }; });
    expect(await adapter.checkFriendRelation(mid, lease)).toBe('unknown');
    expect(ids).toHaveBeenCalledTimes(100);
  } finally { ids.mockRestore(); }
});

it('returns unknown for malformed Relation list fields rather than treating them as an empty friend list', async () => {
  const { RelationService } = await import(new URL('./service/relation/mod.js', import.meta.resolve('@evex/linejs/base')).href) as {
    RelationService: { prototype: { getUserFriendIds(...args: any[]): Promise<unknown>; getFriendDetails(...args: any[]): Promise<unknown> } };
  };
  const ids = vi.spyOn(RelationService.prototype, 'getUserFriendIds').mockResolvedValue({ userFriendMids: null, nextUserPageToken: '' });
  const details = vi.spyOn(RelationService.prototype, 'getFriendDetails').mockResolvedValue({ responses: [] });
  const adapter = await createLinejsAdapter({ ...lease, mode: 'ACTIVE_CONTROL', validateLease: () => true,
    physicalTransport: async () => new Response() });
  try {
    expect(await adapter.checkFriendRelation(`u${'a'.repeat(32)}`, lease)).toBe('unknown');
    expect(await adapter.checkFriendRelationDiagnostic(`u${'a'.repeat(32)}`, lease)).toEqual({
      status: 'unknown', error: 'RELATION_LIST_SHAPE_INVALID',
    });
    expect(details).not.toHaveBeenCalled();
    ids.mockResolvedValue({ userFriendMids: [], nextUserPageToken: null });
    expect(await adapter.checkFriendRelation(`u${'a'.repeat(32)}`, lease)).toBe('unknown');
    expect(await adapter.checkFriendRelationDiagnostic(`u${'a'.repeat(32)}`, lease)).toEqual({
      status: 'unknown', error: 'RELATION_LIST_SHAPE_INVALID',
    });
    ids.mockRejectedValueOnce(new Error('sensitive target and native payload'));
    const failed = await adapter.checkFriendRelationDiagnostic(`u${'a'.repeat(32)}`, lease);
    expect(failed).toEqual({ status: 'unknown', error: 'RELATION_LIST_RPC_FAILED' });
    expect(JSON.stringify(failed)).not.toContain('sensitive');
  } finally { ids.mockRestore(); details.mockRestore(); }
});

it('validates friend-list fields and never requests friend details', async () => {
  const { RelationService } = await import(new URL('./service/relation/mod.js', import.meta.resolve('@evex/linejs/base')).href) as {
    RelationService: { prototype: { getUserFriendIds(...args: any[]): Promise<unknown>; getFriendDetails(...args: any[]): Promise<unknown> } };
  };
  const mid = `u${'a'.repeat(32)}`;
  const ids = vi.spyOn(RelationService.prototype, 'getUserFriendIds');
  const details = vi.spyOn(RelationService.prototype, 'getFriendDetails').mockResolvedValue({ responses: [{
    targetUserMid: mid, friendDetail: { user: {} },
  }] });
  const adapter = await createLinejsAdapter({ ...lease, mode: 'ACTIVE_CONTROL', validateLease: () => true,
    physicalTransport: async () => new Response() });
  try {
    ids.mockResolvedValueOnce({ nextUserPageToken: '' });
    expect(await adapter.checkFriendRelationDiagnostic(mid, lease)).toEqual({ status: 'not_friend', error: null });
    ids.mockResolvedValueOnce({ userFriendMids: [mid] });
    expect(await adapter.checkFriendRelationDiagnostic(mid, lease)).toEqual({ status: 'friend', error: null });
    ids.mockResolvedValueOnce({ userFriendMids: undefined, nextUserPageToken: undefined });
    expect(await adapter.checkFriendRelationDiagnostic(mid, lease)).toEqual({ status: 'not_friend', error: null });
    expect(details).not.toHaveBeenCalled();
    const invalid = [
      { userFriendMids: null, nextUserPageToken: '' },
      { userFriendMids: 1, nextUserPageToken: '' },
      { userFriendMids: {}, nextUserPageToken: '' },
      { userFriendMids: [mid, 1], nextUserPageToken: '' },
      { userFriendMids: [], nextUserPageToken: null },
      { userFriendMids: [], nextUserPageToken: 1 },
      { userFriendMids: [], nextUserPageToken: {} },
    ];
    for (const body of invalid) {
      ids.mockResolvedValueOnce(body);
      expect(await adapter.checkFriendRelationDiagnostic(mid, lease)).toEqual({
        status: 'unknown', error: 'RELATION_LIST_SHAPE_INVALID',
      });
    }
    expect(details).not.toHaveBeenCalled();
  } finally { ids.mockRestore(); details.mockRestore(); }
});

it('decodes optional friend-list fields from real compact Thrift responses (evidence 1a-c)', async () => {
  const { RelationService } = await import(new URL('./service/relation/mod.js', import.meta.resolve('@evex/linejs/base')).href) as {
    RelationService: { prototype: { getFriendDetails(...args: any[]): Promise<unknown> } };
  };
  const mid = `u${'a'.repeat(32)}`;
  const details = vi.spyOn(RelationService.prototype, 'getFriendDetails').mockResolvedValue({ responses: [{
    targetUserMid: mid, friendDetail: { user: {} },
  }] });
  const thrift = new LineThrift();
  const midsField = (mids: string[]) => [14, 1, [11, mids]] as const;
  const tokenField = (token: string) => [11, 2, token] as const;
  const result = (fields: Array<readonly [number, number, unknown]>) => new Response(
    thrift.writeThrift([[12, 0, fields as any]], 'getUserFriendIds', Protocols[4]),
    { headers: { 'content-type': 'application/x-thrift' } },
  );
  const emptySuccessResult = () => {
    const message = thrift.writeThrift([], 'getUserFriendIds', Protocols[4]);
    const header = message.slice(0, 4 + 'getUserFriendIds'.length);
    // Compact protocol: outer field 0 is a STRUCT, followed by an empty
    // success struct and the outer struct STOP marker (plus linejs's trailer).
    return new Response(new Uint8Array([...header, 0x0c, 0x00, 0x00, 0x00]), {
      headers: { 'content-type': 'application/x-thrift' },
    });
  };
  let scenario: 'a' | 'b' | 'c' = 'a';
  let listCalls = 0;
  const physicalTransport = vi.fn(async (request: Request) => {
    expect(request.method).toBe('POST');
    listCalls += 1;
    if (scenario === 'a') return result([midsField([mid])]);
    if (scenario === 'b') return emptySuccessResult();
    return listCalls === 1 ? result([midsField([]), tokenField('next')]) : result([midsField([mid])]);
  });
  const adapter = await createLinejsAdapter({ ...lease, mode: 'ACTIVE_CONTROL', validateLease: () => true, physicalTransport });
  await adapter.installSecrets({ token: jwt, qrCert: null, e2eeStorage: null });
  try {
    const firstResult = await adapter.checkFriendRelationDiagnostic(mid, lease);
    expect(listCalls).toBe(1);
    expect(firstResult).toEqual({ status: 'friend', error: null });
    expect(details).not.toHaveBeenCalled();

    scenario = 'b';
    listCalls = 0;
    details.mockClear();
    expect(await adapter.checkFriendRelationDiagnostic(mid, lease)).toEqual({ status: 'not_friend', error: null });
    expect(listCalls).toBe(1);
    expect(details).not.toHaveBeenCalled();

    scenario = 'c';
    listCalls = 0;
    expect(await adapter.checkFriendRelationDiagnostic(mid, lease)).toEqual({ status: 'friend', error: null });
    expect(listCalls).toBe(2);
    expect(details).not.toHaveBeenCalled();
  } finally { details.mockRestore(); }
});

it('classifies an addFriendByMid physical failure as unknown and never retries its write', async () => {
  const physicalTransport = vi.fn(async () => { throw new Error('timeout'); });
  const adapter = await createLinejsAdapter({ ...lease, mode: 'ACTIVE_CONTROL', validateLease: () => true, physicalTransport });
  await adapter.installSecrets({ token: jwt, qrCert: null, e2eeStorage: null });
  const started = vi.fn();
  const result = await adapter.addFriendByMid(`u${'a'.repeat(32)}`, lease, started);
  expect(result).toEqual({ status: 'unknown', error: 'TRANSPORT_OUTCOME_UNKNOWN' });
  expect(physicalTransport).toHaveBeenCalledTimes(1);
  expect(started).toHaveBeenCalledOnce();
});

it.each([
  [undefined, { mid: `u${'a'.repeat(32)}`, reference: '', trackingMetaType: 10 }],
  [`c${'b'.repeat(32)}`, { mid: `u${'a'.repeat(32)}`, reference: '', trackingMetaType: 5, trackingMetaHint: `c${'b'.repeat(32)}` }],
])('sends explicit friend add tracking metadata for source %s', async (sourceChatMid, expectedOptions) => {
  const { RelationService } = await import(new URL('./service/relation/mod.js', import.meta.resolve('@evex/linejs/base')).href) as {
    RelationService: { prototype: { addFriendByMid(options: Record<string, unknown>): Promise<unknown> } };
  };
  const original = RelationService.prototype.addFriendByMid;
  const physicalTransport = vi.fn(async () => { throw new Error('fixture transport stop'); });
  const adapter = await createLinejsAdapter({ ...lease, mode: 'ACTIVE_CONTROL', validateLease: () => true, physicalTransport });
  await adapter.installSecrets({ token: jwt, qrCert: null, e2eeStorage: null });
  const dispatchedOptions: Record<string, unknown>[] = [];
  const dispatch = vi.spyOn(RelationService.prototype, 'addFriendByMid').mockImplementation(async function (options) {
    dispatchedOptions.push(options);
    return original.call(this, options);
  });
  try {
    await adapter.addFriendByMid(`u${'a'.repeat(32)}`, lease, () => undefined, undefined, sourceChatMid);
    expect(dispatchedOptions).toEqual([expectedOptions]);
    expect(physicalTransport).toHaveBeenCalledOnce();
  } finally { dispatch.mockRestore(); }
});

it.each([
  [0, 'UNKNOWN'],
  [1, 'INVALID_TARGET_USER'],
  [2, 'AGE_VALIDATION'],
  [3, 'TOO_MANY_FRIENDS'],
  [4, 'TOO_MANY_REQUESTS'],
  [5, 'MALFORMED_REQUEST'],
  [6, 'TRACKING_META_QRCODE_FAVORED'],
  [7, 'TRACKING_META_UPGRADE_FAVORED'],
])('classifies LINE add friend result code %i as %s', async (code, errorName) => {
  const physicalTransport = vi.fn(async () => { throw new InternalError('RequestError', 'LINE rejected the friend add', { code }); });
  const adapter = await createLinejsAdapter({ ...lease, mode: 'ACTIVE_CONTROL', validateLease: () => true, physicalTransport });
  await adapter.installSecrets({ token: jwt, qrCert: null, e2eeStorage: null });
  expect(await adapter.addFriendByMid(`u${'a'.repeat(32)}`, lease, () => undefined))
    .toEqual({ status: 'failed', error: `LINE_RELATION_ADD_${errorName}` });
  expect(physicalTransport).toHaveBeenCalledOnce();
});

it.each([
  [0, { status: 'failed', error: 'LINE_RELATION_ADD_UNKNOWN' }],
  [1, { status: 'failed', error: 'LINE_RELATION_ADD_INVALID_TARGET_USER' }],
  [2, { status: 'failed', error: 'LINE_RELATION_ADD_AGE_VALIDATION' }],
  [3, { status: 'failed', error: 'LINE_RELATION_ADD_TOO_MANY_FRIENDS' }],
  [4, { status: 'failed', error: 'LINE_RELATION_ADD_TOO_MANY_REQUESTS' }],
  [5, { status: 'failed', error: 'LINE_RELATION_ADD_MALFORMED_REQUEST' }],
  [6, { status: 'failed', error: 'LINE_RELATION_ADD_TRACKING_META_QRCODE_FAVORED' }],
  [7, { status: 'failed', error: 'LINE_RELATION_ADD_TRACKING_META_UPGRADE_FAVORED' }],
  [99, { status: 'unknown', error: 'TRANSPORT_OUTCOME_UNKNOWN' }],
])('classifies encoded Thrift addFriendByMid rejection reason %i through BaseClient', async (rejectionCode, expected) => {
  const thrift = new LineThrift();
  const wireResponse = thrift.writeThrift([[12, 1, [[8, 1, rejectionCode], [11, 2, 'private rejection hint']]]],
    'addFriendByMid', Protocols[4]!);
  const physicalTransport = vi.fn(async () => new Response(wireResponse, {
    headers: { 'content-type': 'application/x-thrift' },
  }));
  const adapter = await createLinejsAdapter({ ...lease, mode: 'ACTIVE_CONTROL', validateLease: () => true, physicalTransport });
  await adapter.installSecrets({ token: jwt, qrCert: null, e2eeStorage: null });
  const result = await adapter.addFriendByMid(`u${'a'.repeat(32)}`, lease, () => undefined);
  expect(result).toEqual(expected);
  expect(physicalTransport).toHaveBeenCalledOnce();
});

it('keeps non-RequestError and out-of-range LINE error codes as unknown after physical start', async () => {
  const errors: unknown[] = [new Error('timeout'), new InternalError('RequestError', 'unknown response', { code: 8 })];
  for (const error of errors) {
    const physicalTransport = vi.fn(async () => { throw error; });
    const adapter = await createLinejsAdapter({ ...lease, mode: 'ACTIVE_CONTROL', validateLease: () => true, physicalTransport });
    await adapter.installSecrets({ token: jwt, qrCert: null, e2eeStorage: null });
    expect(await adapter.addFriendByMid(`u${'a'.repeat(32)}`, lease, () => undefined))
      .toEqual({ status: 'unknown', error: 'TRANSPORT_OUTCOME_UNKNOWN' });
    expect(physicalTransport).toHaveBeenCalledOnce();
  }
});

it('consumes the Relation physical boundary on first dispatch and denies a re-entrant second dispatch', async () => {
  const { RelationService } = await import(new URL('./service/relation/mod.js', import.meta.resolve('@evex/linejs/base')).href) as {
    RelationService: { prototype: { addFriendByMid(options: { mid: string }): Promise<unknown> } };
  };
  const original = RelationService.prototype.addFriendByMid;
  const physicalTransport = vi.fn(async () => { throw new Error('first physical request timed out'); });
  const adapter = await createLinejsAdapter({ ...lease, mode: 'ACTIVE_CONTROL', validateLease: () => true, physicalTransport });
  await adapter.installSecrets({ token: jwt, qrCert: null, e2eeStorage: null });
  const dispatch = vi.spyOn(RelationService.prototype, 'addFriendByMid').mockImplementation(async function (options) {
    const first = original.call(this, options);
    const second = original.call(this, options);
    const results = await Promise.allSettled([first, second]);
    const denied = results.find((result) => result.status === 'rejected' && (result.reason as { code?: string }).code === 'SIDE_EFFECT_DENIED');
    expect(denied).toBeDefined();
    const rejected = results.find((result) => result.status === 'rejected');
    if (rejected?.status === 'rejected') throw rejected.reason;
    return undefined;
  });
  try {
    const result = await adapter.addFriendByMid(`u${'a'.repeat(32)}`, lease, () => undefined);
    expect(result).toEqual({ status: 'unknown', error: 'TRANSPORT_OUTCOME_UNKNOWN' });
    expect(physicalTransport).toHaveBeenCalledOnce();
  } finally { dispatch.mockRestore(); }
});

it('never enters the physical Relation write when its cancellation state is already aborted', async () => {
  const physicalTransport = vi.fn(async () => new Response());
  const adapter = await createLinejsAdapter({ ...lease, mode: 'ACTIVE_CONTROL', validateLease: () => true, physicalTransport });
  await adapter.installSecrets({ token: jwt, qrCert: null, e2eeStorage: null });
  const controller = new AbortController(); controller.abort();
  const started = vi.fn();
  expect(await adapter.addFriendByMid(`u${'a'.repeat(32)}`, lease, started, controller.signal))
    .toEqual({ status: 'failed', error: 'SIDE_EFFECT_DENIED' });
  expect(started).not.toHaveBeenCalled();
  expect(physicalTransport).not.toHaveBeenCalled();
});

it('keeps Relation reads control-only and rejects a stale lease before physical fetch', async () => {
  const requests: Request[] = [];
  const targetMid = `u${'a'.repeat(32)}`;
  const monitor = await createLinejsAdapter({ ...lease, mode: 'MONITOR_ONLY', validateLease: () => true,
    physicalTransport: async (request) => { requests.push(request); throw new Error('offline'); } });
  await monitor.installSecrets({ token: jwt, qrCert: null, e2eeStorage: null });
  expect(await monitor.checkFriendRelation(targetMid, lease)).toBe('unknown');
  expect(requests).toHaveLength(0);

  const active = await createLinejsAdapter({ ...lease, mode: 'ACTIVE_CONTROL', validateLease: () => false,
    physicalTransport: async (request) => { requests.push(request); throw new Error('offline'); } });
  await active.installSecrets({ token: jwt, qrCert: null, e2eeStorage: null });
  expect(await active.checkFriendRelation(targetMid, lease)).toBe('unknown');
  expect(requests).toHaveLength(0);
});

it('classifies a stale Relation write lease as not started before physical transport', async () => {
  const physicalTransport = vi.fn(async () => new Response());
  const adapter = await createLinejsAdapter({ ...lease, mode: 'ACTIVE_CONTROL', validateLease: () => false, physicalTransport });
  await adapter.installSecrets({ token: jwt, qrCert: null, e2eeStorage: null });
  const started = vi.fn();
  expect(await adapter.addFriendByMid(`u${'a'.repeat(32)}`, lease, started))
    .toEqual({ status: 'failed', error: 'SIDE_EFFECT_DENIED' });
  expect(started).not.toHaveBeenCalled();
  expect(physicalTransport).not.toHaveBeenCalled();
});

it('keeps reads in monitor mode after control revocation while denying every LINE send', async () => {
  const { TalkService } = await import(new URL('./service/talk/mod.js', import.meta.resolve('@evex/linejs/base')).href) as {
    TalkService: new (...args: never[]) => { getProfile(...args: unknown[]): Promise<{ mid: string; displayName: string }> };
  };
  const profile = vi.spyOn(TalkService.prototype, 'getProfile').mockResolvedValue({ mid: 'u-self', displayName: 'Agent' });
  const requests: Request[] = [];
  try {
    const adapter = await createLinejsAdapter({ ...lease, mode: 'ACTIVE_CONTROL', validateLease: () => true,
      physicalTransport: async (request) => { requests.push(request); throw new Error('offline fixture stop'); } });
    await adapter.installSecrets({ token: jwt, qrCert: null, e2eeStorage: null });
    await adapter.loginToken(jwt);

    await expect(adapter.sync(cursor)).rejects.toThrow('offline fixture stop');
    adapter.revoke();
    await expect(adapter.sync(cursor)).rejects.toThrow('offline fixture stop');
    await expect(adapter.listConversations()).rejects.toThrow('offline fixture stop');
    await expect(adapter.history({ chatType: 'group', chatId: 'c-group' }, null, 10))
      .rejects.toThrow('offline fixture stop');
    const token = await mockEncryptedObsToken();
    const { E2EE } = await import(new URL('../../../node_modules/@evex/linejs/base/e2ee/mod.js', import.meta.url).href) as {
      E2EE: { prototype: { decryptE2EEDataMessage: (...args: any[]) => Promise<unknown> } };
    };
    const decrypt = vi.spyOn(E2EE.prototype, 'decryptE2EEDataMessage').mockResolvedValue({ keyMaterial: Buffer.alloc(32, 1).toString('base64') });
    try {
      await expect(adapter.download('file', '9', 'OID_123', encryptedAttachmentMessage(), {
        signal: new AbortController().signal, maxBytes: 32, identity: attachmentIdentity,
      })).rejects.toMatchObject({ code: 'LINE_NATIVE_DOWNLOAD_FAILED' });
    } finally { token.mockRestore(); decrypt.mockRestore(); }
    await expect(adapter.send({ chatType: 'direct', chatId: 'u-peer' }, 'hello', null, lease))
      .rejects.toMatchObject({ code: 'SIDE_EFFECT_DENIED' });

    expect(requests).toHaveLength(5);
    expect(new URL(requests.at(-1)!.url).hostname).toBe('obs.line-apps.com');
  } finally { profile.mockRestore(); }
});

it('pre-refreshes a due saved session with native linejs auth and emits one complete rotated snapshot', async () => {
  const { TalkService } = await import(new URL('../../../node_modules/@evex/linejs/base/service/talk/mod.js', import.meta.url).href) as {
    TalkService: { prototype: { getProfile: (...args: any[]) => Promise<unknown> } };
  };
  const refreshedToken = [Buffer.from('{"alg":"HS256"}').toString('base64url'),
    Buffer.from('{"sub":"u-self","v":"refreshed"}').toString('base64url'), 'signature'].join('.');
  const profile = vi.spyOn(TalkService.prototype, 'getProfile').mockResolvedValue({ mid: 'u-self', displayName: 'Agent' });
  const requests: Request[] = [];
  const adapter = await createLinejsAdapter({ ...lease, mode: 'MONITOR_ONLY', validateLease: () => false,
    physicalTransport: async (request) => { requests.push(request); return await linejsRefreshResponse(refreshedToken, 'rotated-refresh-token'); } });
  const rotations: unknown[] = [];
  const storageEvents: unknown[] = [];
  adapter.on('credentials', (value) => rotations.push(value));
  adapter.on('storage', (value) => storageEvents.push(value));
  try {
    await adapter.installSecrets({ token: jwt, qrCert: null,
      e2eeStorage: { refreshToken: 'saved-refresh-token', expire: 1, retained: 'kept' } });
    await adapter.loginToken(jwt);

    expect(requests).toHaveLength(1);
    expect(new URL(requests[0]!.url).pathname).toBe('/EXT/auth/tokenrefresh/v1');
    expect(rotations).toEqual([{ token: refreshedToken, e2eeStorage: {
      refreshToken: 'rotated-refresh-token', expire: expect.any(Number), retained: 'kept',
    } }]);
    expect(storageEvents).toEqual([]);
  } finally { profile.mockRestore(); }
});

it('preserves the saved snapshot on a temporary native refresh failure', async () => {
  const failure = new Error('fixture network unavailable');
  const requests: Request[] = [];
  const adapter = await createLinejsAdapter({ ...lease, mode: 'MONITOR_ONLY', validateLease: () => false,
    physicalTransport: async (request) => { requests.push(request); throw failure; } });
  const rotations: unknown[] = [];
  const storageEvents: unknown[] = [];
  adapter.on('credentials', (value) => rotations.push(value));
  adapter.on('storage', (value) => storageEvents.push(value));
  await adapter.installSecrets({ token: jwt, qrCert: null,
    e2eeStorage: { refreshToken: 'saved-refresh-token', expire: 1, retained: 'kept' } });
  await expect(adapter.loginToken(jwt)).rejects.toBe(failure);
  expect(requests).toHaveLength(1);
  expect(new URL(requests[0]!.url).pathname).toBe('/EXT/auth/tokenrefresh/v1');
  expect(rotations).toEqual([]);
  expect(storageEvents).toEqual([]);
});

it('classifies explicit refresh invalidation through the fake physical dispatcher', async () => {
  const invalidation = new InternalError('RequestError', 'fixture LINE invalidation', { code: 'NOT_AUTHORIZED_DEVICE' });
  const requests: Request[] = [];
  const invalidated = vi.fn();
  const adapter = await createLinejsAdapter({ ...lease, mode: 'MONITOR_ONLY', validateLease: () => false,
    physicalTransport: async (request) => { requests.push(request); throw invalidation; } });
  adapter.on('authInvalidated', invalidated);
  const rotations: unknown[] = [];
  adapter.on('credentials', (value) => rotations.push(value));
  await adapter.installSecrets({ token: jwt, qrCert: null,
    e2eeStorage: { refreshToken: 'saved-refresh-token', expire: 1 } });

  await expect(adapter.loginToken(jwt)).rejects.toBe(invalidation);

  expect(requests).toHaveLength(1);
  expect(new URL(requests[0]!.url).pathname).toBe('/EXT/auth/tokenrefresh/v1');
  expect(invalidated).toHaveBeenCalledOnce();
  expect(rotations).toEqual([]);
});

it('does not refresh or replay a mutation when the server demands token refresh', async () => {
  const { E2EE } = await import(new URL('../../../node_modules/@evex/linejs/base/e2ee/mod.js', import.meta.url).href) as {
    E2EE: { prototype: { encryptE2EEMessage: (...args: any[]) => Promise<Buffer[]> } };
  };
  const { LegyEncryptedTransport } = await import(new URL('../../../node_modules/@evex/linejs/base/request/legy.js', import.meta.url).href) as {
    LegyEncryptedTransport: { prototype: { fetch: (request: Request, fetcher: (request: Request) => Promise<Response>,
      options: { endpoint?: string }) => Promise<Response> } };
  };
  const encrypt = vi.spyOn(E2EE.prototype, 'encryptE2EEMessage').mockResolvedValue([Buffer.from([1])]);
  let sends = 0;
  const legy = vi.spyOn(LegyEncryptedTransport.prototype, 'fetch').mockImplementation(async function(_request, fetcher, options) {
    await fetcher(new Request(options.endpoint ?? 'https://gf.line.naver.jp/enc', { method: 'POST', body: 'fixture' }));
    sends += 1;
    return await linejsRefreshDemandResponse('sendMessage');
  });
  const requests: Request[] = [];
  const adapter = await createLinejsAdapter({ ...lease, mode: 'ACTIVE_CONTROL', validateLease: () => true,
    physicalTransport: async (request) => {
      requests.push(request);
      return new URL(request.url).pathname === '/EXT/auth/tokenrefresh/v1'
        ? await linejsRefreshResponse(jwt, 'rotated-refresh-token') : new Response();
    } });
  await adapter.installSecrets({ token: jwt, qrCert: null,
    e2eeStorage: { refreshToken: 'saved-refresh-token', expire: 1 } });
  try {
    let failure: unknown;
    try { await adapter.send({ chatType: 'direct', chatId: 'u-peer' }, 'hello', null, lease); }
    catch (error) { failure = error; }
    expect(sends).toBe(1);
    expect(requests.filter((request) => new URL(request.url).pathname === '/enc')).toHaveLength(1);
    expect(requests.filter((request) => new URL(request.url).pathname === '/EXT/auth/tokenrefresh/v1')).toHaveLength(0);
    expect(failure).toMatchObject({ code: 'SIDE_EFFECT_DENIED' });
  } finally { encrypt.mockRestore(); legy.mockRestore(); }
});

it('refreshes and retries a read when the server demands token refresh', async () => {
  const { LegyEncryptedTransport } = await import(new URL('../../../node_modules/@evex/linejs/base/request/legy.js', import.meta.url).href) as {
    LegyEncryptedTransport: { prototype: { fetch: (request: Request, fetcher: (request: Request) => Promise<Response>,
      options: { endpoint?: string }) => Promise<Response> } };
  };
  let readAttempts = 0;
  const legy = vi.spyOn(LegyEncryptedTransport.prototype, 'fetch').mockImplementation(async function(request, fetcher, options) {
    await fetcher(new Request(options.endpoint ?? 'https://gf.line.naver.jp/enc', { method: 'POST', body: 'fixture' }));
    return ++readAttempts === 1 ? await linejsRefreshDemandResponse('getProfile') : await linejsProfileResponse(`u${'a'.repeat(32)}`);
  });
  const requests: Request[] = [];
  const adapter = await createLinejsAdapter({ ...lease, mode: 'MONITOR_ONLY', validateLease: () => false,
    physicalTransport: async (request) => {
      requests.push(request);
      return new URL(request.url).pathname === '/EXT/auth/tokenrefresh/v1'
        ? await linejsRefreshResponse(jwt, 'rotated-refresh-token') : new Response();
    } });
  const rotations: unknown[] = [];
  adapter.on('credentials', (value) => rotations.push(value));
  await adapter.installSecrets({ token: jwt, qrCert: null,
    e2eeStorage: { refreshToken: 'saved-refresh-token', expire: Math.floor(Date.now() / 1000) + 3600 } });
  try {
    await expect(adapter.refreshOwnProfile()).resolves.toEqual({ ownMid: `u${'a'.repeat(32)}`, displayName: 'Agent' });
    expect(requests.filter((request) => new URL(request.url).pathname === '/enc')).toHaveLength(2);
    expect(requests.filter((request) => new URL(request.url).pathname === '/EXT/auth/tokenrefresh/v1')).toHaveLength(1);
    expect(rotations).toEqual([{ token: jwt, e2eeStorage: {
      refreshToken: 'rotated-refresh-token', expire: expect.any(Number),
    } }]);
  } finally { legy.mockRestore(); }
});

it('coalesces overlapping profile refreshes and resumes ordinary storage events afterward', async () => {
  const { TalkService } = await import(new URL('../../../node_modules/@evex/linejs/base/service/talk/mod.js', import.meta.url).href) as {
    TalkService: { prototype: { getProfile: (...args: any[]) => Promise<unknown> } };
  };
  const refreshedToken = [Buffer.from('{"alg":"HS256"}').toString('base64url'),
    Buffer.from('{"sub":"u-self","v":"refreshed"}').toString('base64url'), 'signature'].join('.');
  let profileCalls = 0;
  const profile = vi.spyOn(TalkService.prototype, 'getProfile').mockImplementation(async function(this: any) {
    if (profileCalls++ === 0) await Promise.all([
      this.client.auth.tryRefreshToken(), this.client.auth.tryRefreshToken(),
    ]);
    return { mid: 'u-self', displayName: 'Agent' };
  });
  const requests: Request[] = [];
  const adapter = await createLinejsAdapter({ ...lease, mode: 'MONITOR_ONLY', validateLease: () => false,
    physicalTransport: async (request) => { requests.push(request); return await linejsRefreshResponse(refreshedToken, 'rotated-refresh-token'); } });
  const rotations: any[] = [];
  const storageEvents: unknown[] = [];
  adapter.on('credentials', (value) => rotations.push(value));
  adapter.on('storage', (value) => storageEvents.push(value));
  try {
    await adapter.installSecrets({ token: jwt, qrCert: null,
      e2eeStorage: { refreshToken: 'saved-refresh-token', expire: Math.floor(Date.now() / 1000) + 3600 } });
    await adapter.loginToken(jwt);
    expect(requests).toHaveLength(1);
    expect(rotations).toEqual([{ token: refreshedToken, e2eeStorage: {
      refreshToken: 'rotated-refresh-token', expire: expect.any(Number),
    } }]);
    expect(storageEvents).toEqual([]);

    await adapter.loginToken(JSON.stringify({ accessToken: jwt, refreshToken: 'ordinary-refresh', expire: 4_000_000_000 }));
    expect(storageEvents).toHaveLength(2);
  } finally { profile.mockRestore(); }
});

it('revalidates the physical write permit after asynchronous lease validation and revoke', async () => {
  const { E2EE } = await import(new URL('../../../node_modules/@evex/linejs/base/e2ee/mod.js', import.meta.url).href) as {
    E2EE: { prototype: object };
  };
  let releaseValidation!: () => void;
  let signalValidation!: () => void;
  const validationStarted = new Promise<void>((resolve) => { signalValidation = resolve; });
  const validationHold = new Promise<void>((resolve) => { releaseValidation = resolve; });
  let validations = 0;
  const validateLease = vi.fn(async () => {
    validations += 1;
    if (validations === 1) { signalValidation(); await validationHold; }
    return true;
  });
  const encrypt = vi.spyOn(E2EE.prototype as any, 'encryptE2EEMessage').mockResolvedValue([Buffer.from([1, 2, 3])]);
  const physicalTransport = vi.fn(async () => new Response());
  const adapter = await createLinejsAdapter({ ...lease, mode: 'ACTIVE_CONTROL', validateLease, physicalTransport });
  await adapter.installSecrets({ token: jwt, qrCert: null, e2eeStorage: null });
  const sending = adapter.send({ chatType: 'direct', chatId: 'u-peer' }, 'hello', null, lease);
  try {
    await validationStarted;
    adapter.revoke();
    releaseValidation();
    await expect(sending).rejects.toMatchObject({ code: 'SIDE_EFFECT_DENIED' });
    expect(physicalTransport).not.toHaveBeenCalled();
  } finally {
    releaseValidation();
    encrypt.mockRestore();
  }
});

it('fails protocol verification before constructing a login-capable client', async () => {
  const packageRoot = await mkdtemp(join(tmpdir(), 'linejs-drift-'));
  temporary.push(packageRoot);
  await writeFile(join(packageRoot, 'package.json'), JSON.stringify({ name: '@jsr/evex__linejs', version: '3.5.1' }));
  const physicalTransport = vi.fn(async () => new Response());
  await expect(createLinejsAdapter({ ...lease, mode: 'MONITOR_ONLY', packageRoot,
    validateLease: () => false, physicalTransport })).rejects.toMatchObject({ code: 'PROTOCOL_UNVERIFIED' });
  expect(physicalTransport).not.toHaveBeenCalled();
});

it('routes initial and paged history through guarded read RPCs', async () => {
  const requests: Request[] = [];
  const adapter = await createLinejsAdapter({ ...lease, mode: 'MONITOR_ONLY', validateLease: () => false,
    physicalTransport: async (request) => { requests.push(request); throw new Error('offline fixture stop'); } });
  await adapter.installSecrets({ token: jwt, qrCert: null, e2eeStorage: null });
  await expect(adapter.history({ chatType: 'group', chatId: 'c-group' }, null, 10)).rejects.toThrow('offline fixture stop');
  await expect(adapter.history({ chatType: 'group', chatId: 'c-group' }, { version: 1, accountId: 'account-A',
    chatType: 'group', chatId: 'c-group', messageId: '9223372036854775807', deliveredTime: '1760522400000' }, 10)).rejects.toThrow('offline fixture stop');
  expect(requests.map((request) => request.url)).toEqual(['https://gf.line.naver.jp/enc', 'https://gf.line.naver.jp/enc']);
});

it('passes restored encrypted chunks to LINEJS E2EE media download and preserves its File name', async () => {
  let received: unknown;
  const result = await downloadLinejsE2eeAttachment({
    async downloadMediaByE2EE(message) {
      received = message;
      return new File([new Uint8Array([1, 2])], '新文字文件.txt', { type: 'text/plain' });
    },
    async downloadMessageData() { throw new Error('plain downloader must not be used'); },
  }, {
    id: '9', from: 'u-peer', to: 'u-self', contentMetadata: { OID: 'OID_123', SID: 'emf' },
    chunks: [{ encoding: 'base64', data: 'AQID' }],
  });
  expect(received).toMatchObject({ id: '9', chunks: [expect.any(Uint8Array)] });
  expect(Array.from((received as { chunks: Uint8Array[] }).chunks[0]!)).toEqual([1, 2, 3]);
  expect(result.name).toBe('新文字文件.txt');
  const bytes: Uint8Array[] = [];
  for await (const chunk of result.source) bytes.push(chunk);
  expect(Buffer.concat(bytes)).toEqual(Buffer.from([1, 2]));
});

it('passes newly normalized mixed native chunks as exact bytes through worker validation to LINEJS', async () => {
  const identity = { ...attachmentIdentity, chatType: 'direct' as const, chatId: `u${'d'.repeat(32)}`, kind: 'image' as const };
  const nativeText = '\0鍵🙂';
  const envelope = normalizeOperation({ revision: 9, type: 26, message: {
    id: '9', from: identity.chatId, to: identity.ownMid, toType: 0, contentType: 'IMAGE',
    contentMetadata: { OID: 'OID_123', SID: 'emi' }, chunks: [nativeText, new Uint8Array([1, 2, 3])],
  } }, { accountId: identity.accountId, ownMid: identity.ownMid, source: 'live', cursor: null });
  const archivedMessage = JSON.parse(JSON.stringify(envelope.raw)).message;
  const parsed = validateAttachmentMessage(archivedMessage, identity, 1024);
  let received: unknown;
  await downloadLinejsE2eeAttachment({
    async downloadMediaByE2EE(message) { received = message; return new File([new Uint8Array([7])], 'image.png'); },
    async downloadMessageData() { throw new Error('plain downloader must not be used'); },
  }, parsed.message);
  expect((received as { chunks: Uint8Array[] }).chunks.map((chunk) => Array.from(chunk))).toEqual([
    Array.from(Buffer.from(nativeText, 'utf8')), [1, 2, 3],
  ]);
});

it('uses the LINEJS plain media downloader when the stored message has no E2EE chunks', async () => {
  const downloadMediaByE2EE = vi.fn(async () => null);
  const downloadMessageData = vi.fn(async () => new File([new Uint8Array([4, 5])], 'plain.pdf'));
  const result = await downloadLinejsE2eeAttachment({ downloadMediaByE2EE, downloadMessageData }, { id: '10' });
  expect(downloadMediaByE2EE).not.toHaveBeenCalled();
  expect(downloadMessageData).toHaveBeenCalledWith({ messageId: '10', isPreview: false, isSquare: false });
  expect(result.name).toBe('plain.pdf');
});

it('checks encrypted attachment bytes before allocating chunks for decryption', async () => {
  const decrypt = vi.fn(async () => new File([new Uint8Array([1])], 'encrypted.bin'));
  await expect(downloadLinejsE2eeAttachment({ downloadMediaByE2EE: decrypt,
    async downloadMessageData() { throw new Error('plain download not expected'); } },
  { id: '11', chunks: [{ encoding: 'base64', data: 'AQIDBAUG' }] }, 4)).rejects.toThrow(/limit|exceed/i);
  expect(decrypt).not.toHaveBeenCalled();
});

it('checks the decrypted plaintext file size against the same attachment bound', async () => {
  const plaintext = vi.fn(async () => new File([new Uint8Array([1, 2, 3])], 'plain.bin'));
  await expect(downloadLinejsE2eeAttachment({ downloadMediaByE2EE: async () => null,
    downloadMessageData: plaintext }, { id: '12' }, 2)).rejects.toThrow(/limit|exceed/i);
  expect(plaintext).toHaveBeenCalledOnce();
});

it('bounds chunked plaintext OBS media inside the real adapter fetch path', async () => {
  let sourceCancelled = false;
  const token = await mockEncryptedObsToken();
  let calls = 0;
  const adapter = await createLinejsAdapter({ ...lease, mode: 'MONITOR_ONLY', validateLease: () => false,
    physicalTransport: async () => ++calls === 1 ? new Response(JSON.stringify({ status: 'exist' })) : new Response(new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(new Uint8Array([1, 2, 3])); },
      cancel() { sourceCancelled = true; },
    })) });
  await adapter.installSecrets({ token: jwt, qrCert: null, e2eeStorage: null });
  await expect(adapter.download('image', '12', '12', { id: '12', from: senderMidFixture(), to: attachmentIdentity.chatId,
    toType: 2, contentType: 1, contentMetadata: {} }, {
    signal: new AbortController().signal, maxBytes: 2,
    identity: { ...attachmentIdentity, kind: 'image', messageId: '12', externalAttachmentId: '12' },
  })).rejects.toMatchObject({ code: 'LINE_MEDIA_SIZE_LIMIT' });
  expect(sourceCancelled).toBe(true);
  token.mockRestore();
});

it('cancels a stalled plaintext LINEJS response body after the attachment deadline', async () => {
  const controller = new AbortController();
  let responseStarted = false;
  let responseAborted = false;
  const token = await mockEncryptedObsToken();
  const adapter = await createLinejsAdapter({ ...lease, mode: 'MONITOR_ONLY', validateLease: () => false,
    physicalTransport: async (request) => new Response(new ReadableStream<Uint8Array>({
      start(streamController) {
        responseStarted = true;
        request.signal.addEventListener('abort', () => {
          responseAborted = true;
          streamController.error(request.signal.reason);
        }, { once: true });
      },
    })) });
  await adapter.installSecrets({ token: jwt, qrCert: null, e2eeStorage: null });
  const download = adapter.download('image', '13', '13', { id: '13', from: senderMidFixture(), to: attachmentIdentity.chatId,
    toType: 2, contentType: 1, contentMetadata: {} }, { signal: controller.signal, maxBytes: 32,
    identity: { ...attachmentIdentity, kind: 'image', messageId: '13', externalAttachmentId: '13' } });
  await vi.waitFor(() => expect(responseStarted).toBe(true));
  controller.abort(new Error('attachment deadline'));
  await expect(download).rejects.toThrow();
  expect(responseAborted).toBe(true);
  token.mockRestore();
});

it('rejects oversized chunked attachment bodies before LINEJS can buffer them', async () => {
  const module = await import('./linejs-adapter.js') as unknown as {
    limitDownloadResponse?: (response: Response, maxBytes: number) => Response;
  };
  expect(module.limitDownloadResponse).toBeTypeOf('function');
  let sourceCancelled = false;
  const source = new ReadableStream<Uint8Array>({
    start(controller) { controller.enqueue(new Uint8Array([1, 2, 3])); },
    cancel() { sourceCancelled = true; },
  });
  const bounded = module.limitDownloadResponse!(new Response(source), 2);
  await expect(bounded.arrayBuffer()).rejects.toThrow(/limit|exceed/i);
  expect(sourceCancelled).toBe(true);
});

it('rejects a declared oversized attachment before reading its body', async () => {
  const module = await import('./linejs-adapter.js') as unknown as {
    limitDownloadResponse?: (response: Response, maxBytes: number) => Response;
  };
  expect(module.limitDownloadResponse).toBeTypeOf('function');
  let sourceCancelled = false;
  const response = new Response(new ReadableStream<Uint8Array>({
    pull() { return new Promise<void>(() => undefined); },
    cancel() { sourceCancelled = true; },
  }), { headers: { 'content-length': '99' } });
  expect(() => module.limitDownloadResponse!(response, 2)).toThrow(/limit|exceed/i);
  expect(sourceCancelled).toBe(true);
});

it('mirrors LINEJS fetchJoinedChats and resolves direct and group member display names in bounded batches', async () => {
  const calls: Array<{ method: string; mids: string[] }> = [];
  let joinedOptions: unknown;
  const memberChatMids = Array.from({ length: 101 }, (_, index) => `c-group-${index}`);
  const chats = memberChatMids.map((chatMid) => ({
    chatMid,
    chatName: `Group ${chatMid.slice(8)}`,
    extra: { groupExtra: { memberMids: { 'u-self': 0, [`u-member-${chatMid.slice(8)}`]: 0 } } },
  }));
  const catalog = await fetchLinejsConversationCatalog({
    ownMid: 'u-self',
    getAllChatMids: async (...args: unknown[]) => { [joinedOptions] = args; return { memberChatMids }; },
    getMessageBoxes: async () => ({ messageBoxes: [{ id: 'u-peer' }, { id: 'c-group-0' }] }),
    getChats: async ({ chatMids }) => {
      calls.push({ method: 'getChats', mids: chatMids });
      return { chats: chats.filter((chat) => chatMids.includes(chat.chatMid)) };
    },
    getContactsV2: async ({ mids }) => {
      calls.push({ method: 'getContactsV2', mids });
      return { contacts: Object.fromEntries(mids.map((mid) => [mid, {
        contact: { displayName: mid === 'u-self' ? 'Agent' : 'Alice' },
      }])) };
    },
  }, async (call) => await call());
  expect(joinedOptions).toEqual({ request: { withMemberChats: true }, syncReason: 'INTERNAL' });
  expect(calls.filter((call) => call.method === 'getChats').map((call) => call.mids.length)).toEqual([100, 1]);
  expect(calls.filter((call) => call.method === 'getContactsV2').map((call) => call.mids.length)).toEqual([100, 3]);
  expect(catalog[0]).toEqual({ chatType: 'direct', chatId: 'u-peer', title: 'Alice',
    members: [{ memberId: 'u-peer', displayName: 'Alice' }] });
  expect(catalog[1]).toEqual({ chatType: 'group', chatId: 'c-group-0', title: 'Group 0', members: [
    { memberId: 'u-member-0', displayName: 'Alice' }, { memberId: 'u-self', displayName: 'Agent' },
  ] });
});

it('carries the owner-set contact name (displayNameOverridden) from the existing contact response and titles direct chats with it', async () => {
  const catalog = await fetchLinejsConversationCatalog({
    ownMid: 'u-self',
    getAllChatMids: async () => ({ memberChatMids: ['c-group'] }),
    getMessageBoxes: async () => ({ messageBoxes: [{ id: 'u-friend' }, { id: 'u-plain' }, { id: 'c-group' }] }),
    getChats: async () => ({ chats: [{ chatMid: 'c-group', chatName: 'Team',
      extra: { groupExtra: { memberMids: { 'u-friend': 0, 'u-stranger': 0 } } } }] }),
    getContactsV2: async ({ mids }) => ({ contacts: Object.fromEntries(mids.map((mid) => [mid, { contact: {
      displayName: `Profile ${mid}`,
      ...(mid === 'u-friend' ? { displayNameOverridden: '張襄君' } : mid === 'u-stranger' ? { displayNameOverridden: '' } : {}),
    } }])) }),
  }, async (call) => await call());
  expect(catalog.find((item) => item.chatId === 'u-friend')).toEqual({ chatType: 'direct', chatId: 'u-friend', title: '張襄君',
    members: [{ memberId: 'u-friend', displayName: 'Profile u-friend', nickname: '張襄君' }] });
  // No override in the response: the profile name titles the chat and no nickname is claimed.
  expect(catalog.find((item) => item.chatId === 'u-plain')).toEqual({ chatType: 'direct', chatId: 'u-plain', title: 'Profile u-plain',
    members: [{ memberId: 'u-plain', displayName: 'Profile u-plain' }] });
  expect(catalog.find((item) => item.chatId === 'c-group')?.members).toEqual([
    { memberId: 'u-friend', displayName: 'Profile u-friend', nickname: '張襄君' },
    { memberId: 'u-stranger', displayName: 'Profile u-stranger', nickname: '' },
  ]);
});

it('normalizes LINE picture paths with unknown, explicit-empty, allowlisted, and rejected states', async () => {
  const module = await import('./linejs-adapter.js') as unknown as {
    normalizeLinePicturePath?: (value: unknown, present?: boolean) => string | null | undefined;
  };
  expect(module.normalizeLinePicturePath).toBeTypeOf('function');
  const normalize = module.normalizeLinePicturePath!;

  expect(normalize(undefined, false)).toBeUndefined();
  expect(normalize(null, true)).toBeNull();
  expect(normalize('', true)).toBeNull();
  expect(normalize('https://profile.line-scdn.net/p.png', true)).toBe('https://profile.line-scdn.net/p.png');
  expect(normalize('https://obs.line-apps.com/p.png', true)).toBe('https://obs.line-apps.com/p.png');
  for (const length of [79, 166]) {
    const segment = 'a'.repeat(length - 1) + 'Z';
    expect(normalize(`/${segment}`, true)).toBe(`https://profile.line-scdn.net/${segment}`);
  }
  expect(normalize("/a~b!$&'()*+,;=:@-._Z", true)).toBe("https://profile.line-scdn.net/a~b!$&'()*+,;=:@-._Z");
  expect(normalize('/x/xxxx/x/xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx', true)).toBe('https://profile.line-scdn.net/x/xxxx/x/xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx');
  for (const invalid of [
    'http://profile.line-scdn.net/p.png', 'https://attacker.example/p.png',
    'https://user:pass@profile.line-scdn.net/p.png', 'https://profile.line-scdn.net/p.png#fragment',
    'file:///secret.png', 'https://profile.line-scdn.net/' + 'a'.repeat(2049), 42,
    '//attacker.example/p.png', '/one?x=1', '/one#fragment', '/.', '/..', '/one/../two', '/one/./two', '/one/',
    '/%2fhost', '/%5cpath', '/%2e%2e/secret', '/one%2f..%2fsecret', '/%2e', '/one%252e', '/one\\two',
    '/one\u0000two', '/one\ntwo', '/one two', '/é', '/one%20two', '//', '/one//two', 'one', './one', '../one',
  ]) expect(normalize(invalid, true)).toBeUndefined();
});

it('decrypts E2EE history messages using the same marker as LINEJS TalkMessage.fromRawTalk', async () => {
  const module = await import('./linejs-adapter.js') as unknown as {
    decryptLinejsHistoryMessages?: (messages: readonly unknown[], decrypt: (message: unknown) => Promise<unknown>) => Promise<unknown[]>;
  };
  expect(module.decryptLinejsHistoryMessages).toBeTypeOf('function');
  const decrypt = vi.fn(async (message: unknown) => ({ ...(message as object), text: 'decrypted' }));
  const plain = { id: '1', text: 'plain', contentMetadata: {} };
  const encrypted = { id: '2', text: '', contentMetadata: { e2eeVersion: '2' } };

  const result = await module.decryptLinejsHistoryMessages!([plain, encrypted], decrypt);

  expect(decrypt).toHaveBeenCalledExactlyOnceWith(encrypted);
  expect(result).toEqual([plain, { ...encrypted, text: 'decrypted' }]);
});

it('adds the MENTION metadata to an encrypted text message only when mentions are given', async () => {
  const { linejsEncryptedTextMessageOptions } = await import('./linejs-adapter.js');
  const chunks = [Buffer.from([1])];
  const user = `u${'a'.repeat(32)}`;
  const withMention = linejsEncryptedTextMessageOptions('c-group', chunks, null, [{ start: 3, end: 6, userId: user }]);
  expect(withMention.contentMetadata).toEqual({ e2eeVersion: '2', contentType: '0', e2eeMark: '2',
    MENTION: JSON.stringify({ MENTIONEES: [{ S: '3', E: '6', M: user }] }) });
  expect(linejsEncryptedTextMessageOptions('c-group', chunks, null, []).contentMetadata).toEqual({ e2eeVersion: '2', contentType: '0', e2eeMark: '2' });
});

it('builds an explicitly encrypted LINEJS text message without retaining plaintext', async () => {
  const module = await import('./linejs-adapter.js') as unknown as {
    linejsEncryptedTextMessageOptions?: (to: string, chunks: Buffer[], replyToMessageId: string | null) => Record<string, unknown>;
  };
  expect(module.linejsEncryptedTextMessageOptions).toBeTypeOf('function');

  const chunks = [Buffer.from([1, 2, 3])];
  const options = module.linejsEncryptedTextMessageOptions!('u-peer', chunks, '42');

  expect(options).toEqual({
    to: 'u-peer', contentType: 'NONE',
    contentMetadata: { e2eeVersion: '2', contentType: '0', e2eeMark: '2' },
    relatedMessageId: '42', e2ee: true, chunks,
  });
  expect(options).not.toHaveProperty('text');
});
