import { createHash } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ConversationKey } from '@line-agent/contracts';
import { ChatResourceArchiveService, isNativeNotePostNotification, nativePostNotificationSubtype, type ChatResourceArchiveDependencies, type ChatResourceArchiveItem,
  type ChatResourceArchiveVersion, type ChatResourceBinding, type ChatResourceKind, type ChatResourceReadResult, type ChatResourceRequest,
  type ChatResourceStore } from './chat-resources.js';
import { ChatResourceAccountAdmission } from './chat-resource-admission.js';
import { createOperationalAudit, type AuditEvent } from './operational-audit.js';
import { createChatResourceDiagnostics, parseChatResourceDiagnostic } from './chat-resource-diagnostics.js';

const noteA = { postId: 'post/one', createdTime: 1_700_000_000_000, text: 'A', content: { html: '<b>data</b>' } };
const album = { albumId: 'album:one', chatId: 'chat-1', title: 'Photos', photoCount: 1, createTime: 1_700_000_000_000, updateTime: 1_700_000_000_001 };
const photo = { photoId: 'photo/one', oid: 'oid', prefix: 'album/a', shotTime: 1_700_000_000_000, width: 2, height: 3 };
const key = { accountId: 'account-1', chatType: 'group' as const, chatId: 'chat-1' };

type CommitGate = { started(): void; wait: Promise<void> };
function deferred(): { promise: Promise<void>; resolve(): void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

describe('ChatResourceArchiveService', () => {
  const services = new Set<ChatResourceArchiveService>();
  afterEach(async () => { await Promise.all([...services].map((service) => service.shutdown())); services.clear(); });

  async function setup(overrides: Partial<ChatResourceArchiveDependencies> = {}, storeOverrides: Partial<ChatResourceStore> = {}) {
    const { readChatResource: readOverride, ...dependencyOverrides } = overrides;
    const revisions = new Map<string, ChatResourceArchiveVersion[]>();
    const published: Array<{ key: ConversationKey; kind: ChatResourceKind; resourceId: string; content: Uint8Array }> = [];
    let gate: CommitGate | undefined;
    const hash = (content: Uint8Array) => createHash('sha256').update(content).digest('hex');
    const store: ChatResourceStore = {
      async publish(input) {
        gate?.started();
        if (gate) await gate.wait;
        if (input.signal.aborted) throw input.signal.reason;
        input.guard();
        const content = Buffer.from(input.content);
        const id = `${input.key.accountId}\0${input.key.chatType}\0${input.key.chatId}\0${input.kind}\0${input.resourceId}`;
        const versions = revisions.get(id) ?? [];
        const version: ChatResourceArchiveVersion = { revision: (versions.at(-1)?.revision ?? 0) + 1, savedAt: new Date(1_700_000_000_000 + versions.length).toISOString(),
          content, contentHash: hash(content), byteLength: content.byteLength };
        versions.push(version);
        revisions.set(id, versions);
        published.push({ key: input.key, kind: input.kind, resourceId: input.resourceId, content });
        return { revision: version.revision, savedAt: version.savedAt, contentHash: version.contentHash, byteLength: version.byteLength };
      },
      async read(input) {
        const id = `${input.key.accountId}\0${input.key.chatType}\0${input.key.chatId}\0${input.kind}\0${input.resourceId}`;
        const version = revisions.get(id)?.at(-1);
        return version ? { ...version, content: Buffer.from(version.content) } : null;
      },
      async list(input) {
        const prefix = `${input.key.accountId}\0${input.key.chatType}\0${input.key.chatId}\0${input.kind}\0`;
        const items: ChatResourceArchiveItem[] = [];
        for (const [id, versions] of revisions) if (id.startsWith(prefix) && versions.length) {
          const version = versions.at(-1)!;
          items.push({ resourceId: id.slice(prefix.length), revision: version.revision, savedAt: version.savedAt, contentHash: version.contentHash, byteLength: version.byteLength });
        }
        return { items: items.slice(0, input.limit), nextCursor: null };
      },
      async close() {},
      forceClose() {},
      ...storeOverrides,
    };
    const worker = vi.fn(async (command: Parameters<ChatResourceArchiveDependencies['readChatResource']>[0]) => {
      const data = (() => {
        switch (command.action) {
          case 'listNotes': return { notes: [noteA], nextCursor: null };
          case 'getNote': return { note: noteA };
          case 'listAlbums': return { albums: [album], nextCursor: null };
          case 'listAlbumPhotos': return { photos: [photo], nextCursor: null };
          case 'downloadAlbumPhoto': return { bytes: new Uint8Array([1, 2, 3]) };
        }
      })();
      return { type: 'chatResourceResult' as const, requestId: command.requestId, action: command.action, ok: true,
        accountId: command.accountId, workerInstanceId: command.workerInstanceId, controlEpoch: command.controlEpoch,
        chatType: command.chatType, chatId: command.chatId, ...data } as ChatResourceReadResult;
    });
    const readChatResource = vi.fn(readOverride ?? worker);
    let currentBinding: ChatResourceBinding | null = { accountId: key.accountId, workerInstanceId: 'worker-1', controlEpoch: 1,
      transportOwnerId: 'owner-1', transportGeneration: 2, writeGrantVersion: 3, mode: 'ACTIVE_CONTROL' };
    const deps: ChatResourceArchiveDependencies = {
      readChatResource,
      store,
      isWritableAccount: async () => true,
      getBinding: async (accountId) => currentBinding?.accountId === accountId ? currentBinding : null,
      isCurrentBinding: (binding) => currentBinding?.accountId === binding.accountId && currentBinding.workerInstanceId === binding.workerInstanceId
        && currentBinding.controlEpoch === binding.controlEpoch && currentBinding.transportOwnerId === binding.transportOwnerId
        && currentBinding.transportGeneration === binding.transportGeneration && currentBinding.writeGrantVersion === binding.writeGrantVersion
        && currentBinding.mode === binding.mode,
      conversationExists: async () => true,
      ...dependencyOverrides,
    };
    const service = new ChatResourceArchiveService(deps);
    services.add(service);
    return { service, deps, readChatResource, store, revisions, published, setGate: (value?: CommitGate) => { gate = value; },
      setBinding: (binding: ChatResourceBinding | null) => { currentBinding = binding; } };
  }

  it('archives all five worker resource actions through the typed store seam', async () => {
    const { service, readChatResource, published } = await setup();
    await service.listNotes(key, null);
    await service.getNote(key, noteA.postId);
    await service.listAlbums(key, null);
    await service.listAlbumPhotos(key, album.albumId, null);
    const result = await service.downloadAlbumPhoto(key, album.albumId, photo.photoId, photo.oid, photo.prefix);
    const commands = readChatResource.mock.calls.map(([command]) => command);
    expect(commands.map(({ action }) => action)).toEqual(['listNotes', 'getNote', 'listAlbums', 'listAlbumPhotos', 'downloadAlbumPhoto']);
    expect(commands[0]).toMatchObject({ transportOwnerId: 'owner-1', transportGeneration: 2, writeGrantVersion: 3 });
    expect(commands[2]).toMatchObject({ transportOwnerId: 'owner-1', transportGeneration: 2, writeGrantVersion: 3 });
    expect(commands[4]).toMatchObject({ prefix: 'album/a', maxBytes: 20 * 1024 * 1024 });
    expect(result).toMatchObject({ photoId: photo.photoId, sizeBytes: 3 });
    expect(published.map(({ kind }) => kind)).toEqual(['note', 'note', 'album', 'photo-page', 'photo']);
    expect(Buffer.from(published[0]!.content).toString()).toContain('A');
  });

  it('opens an album across cursor pages and publishes each photo into its album folder', async () => {
    const secondPhoto = { ...photo, photoId: 'photo-two', oid: 'oid-two' };
    const worker = vi.fn(async (command: Parameters<ChatResourceArchiveDependencies['readChatResource']>[0]) => {
      const data = command.action === 'listAlbumPhotos'
        ? command.cursor ? { photos: [secondPhoto], nextCursor: null } : { photos: [photo], nextCursor: 'page-2' }
        : { bytes: new Uint8Array([1, 2, 3]) };
      return { type: 'chatResourceResult' as const, requestId: command.requestId, action: command.action, ok: true,
        accountId: command.accountId, workerInstanceId: command.workerInstanceId, controlEpoch: command.controlEpoch,
        chatType: command.chatType, chatId: command.chatId, ...data } as ChatResourceReadResult;
    });
    const records: unknown[] = [];
    const archivedPhotos = new Set<string>();
    const store = {
      ensureAlbumFolder: vi.fn(async () => {}),
      hasAlbumPhoto: vi.fn(async ({ photoId }: { photoId: string }) => archivedPhotos.has(photoId)),
      publishAlbumPhoto: vi.fn(async ({ photoId }: { photoId: string }) => { archivedPhotos.add(photoId); }),
    };
    const { service } = await setup({ readChatResource: worker, recordDiagnostic: (record) => records.push(record) }, store);

    const result = await service.openAlbum(key, album.albumId);

    expect(worker.mock.calls.map(([command]) => [command.action, command.cursor ?? null])).toEqual([
      ['listAlbumPhotos', null], ['downloadAlbumPhoto', null], ['listAlbumPhotos', 'page-2'], ['downloadAlbumPhoto', null],
    ]);
    expect(store.ensureAlbumFolder).toHaveBeenCalledOnce();
    expect(store.publishAlbumPhoto).toHaveBeenCalledTimes(2);
    expect(result).toMatchObject({ savedCount: 2, failedCount: 0, complete: true });
    const downloads = records.filter((record) => (record as { action?: string }).action === 'photo_download');
    expect(downloads).toHaveLength(2);
    expect(new Set(downloads.map((record) => (record as { correlationId?: string }).correlationId)).size).toBe(2);
    expect(JSON.stringify(records)).not.toContain(photo.oid);
    const reopened = await service.openAlbum(key, album.albumId);
    expect(reopened).toMatchObject({ savedCount: 2, failedCount: 0, complete: true });
    expect(worker.mock.calls.filter(([command]) => command.action === 'downloadAlbumPhoto')).toHaveLength(2);
    expect(store.publishAlbumPhoto).toHaveBeenCalledTimes(2);
    expect(store.ensureAlbumFolder).toHaveBeenCalledTimes(2);
  });

  it('rejects a duplicate album open instead of joining the first caller’s cancellation lifetime', async () => {
    let resolvePage!: (value: ChatResourceReadResult) => void;
    const pageReady = new Promise<ChatResourceReadResult>((resolve) => { resolvePage = resolve; });
    const store = { ensureAlbumFolder: vi.fn(async () => {}), publishAlbumPhoto: vi.fn(async () => {}) };
    let pageRequestId = '';
    const { service, readChatResource } = await setup({ readChatResource: async (command) => command.action === 'listAlbumPhotos'
      ? (pageRequestId = command.requestId, pageReady)
      : { type: 'chatResourceResult', requestId: command.requestId, action: command.action, ok: true, accountId: key.accountId,
        workerInstanceId: 'worker-1', controlEpoch: 1, chatType: key.chatType, chatId: key.chatId, bytes: new Uint8Array([1]) },
    }, store);
    const first = service.openAlbum(key, album.albumId);
    await vi.waitFor(() => expect(readChatResource).toHaveBeenCalledOnce());
    const alreadyAborted = new AbortController();
    alreadyAborted.abort(new Error('second caller already cancelled'));
    await expect(service.openAlbum(key, album.albumId, alreadyAborted.signal)).rejects.toThrow('ALBUM_ARCHIVE_ALREADY_RUNNING');
    resolvePage({ type: 'chatResourceResult', requestId: pageRequestId, action: 'listAlbumPhotos', ok: true, accountId: key.accountId,
      workerInstanceId: 'worker-1', controlEpoch: 1, chatType: key.chatType, chatId: key.chatId, photos: [], nextCursor: null });
    await expect(first).resolves.toMatchObject({ complete: true });
  });

  it('projects one safe system activity record per downloaded photo and none for unchanged reopen', async () => {
    const { projectSystemActivity } = await import('./system-records.js');
    const secondPhoto = { ...photo, photoId: 'photo-two', oid: 'oid-two' };
    const events: AuditEvent[] = [];
    const audit = createOperationalAudit({ async append(event) { events.push(event); }, async appendFallback() {}, logSinkState() {} });
    const archivedPhotos = new Set<string>();
    const store = { ensureAlbumFolder: vi.fn(async () => {}),
      hasAlbumPhoto: vi.fn(async ({ photoId }: { photoId: string }) => archivedPhotos.has(photoId)),
      publishAlbumPhoto: vi.fn(async ({ photoId }: { photoId: string }) => { archivedPhotos.add(photoId); }) };
    const { service } = await setup({ readChatResource: async (command: ChatResourceRequest) => {
      const data = command.action === 'listAlbumPhotos' ? { photos: [photo, secondPhoto], nextCursor: null } : { bytes: new Uint8Array([1]) };
      return { type: 'chatResourceResult', requestId: command.requestId, action: command.action, ok: true, accountId: key.accountId,
        workerInstanceId: 'worker-1', controlEpoch: 1, chatType: key.chatType, chatId: key.chatId, ...data } as ChatResourceReadResult;
    }, audit } as never, store);
    await service.openAlbum(key, album.albumId);
    await audit.flush();
    const rows = projectSystemActivity(events as never, []);
    expect(rows).toHaveLength(2);
    expect(rows.every((row) => row.kind === 'audit' && row.action === '相簿照片下載' && row.phase === '已完成')).toBe(true);
    expect(new Set(events.map((event) => event.correlationId)).size).toBe(2);
    await service.openAlbum(key, album.albumId);
    await audit.flush();
    expect(events).toHaveLength(2);
    expect(events.every((event) => event.action === 'album_photo_download' && event.phase === 'succeeded')).toBe(true);
    expect(JSON.stringify(events)).not.toContain(photo.oid);
  });

  it('counts bytes after failed publication and limits subsequent LINE reads to the remaining budget', async () => {
    const secondPhoto = { ...photo, photoId: 'photo-two', oid: 'oid-two' };
    const thirdPhoto = { ...photo, photoId: 'photo-three', oid: 'oid-three' };
    const commands: Array<{ photoId: string | undefined; maxBytes: number | undefined }> = [];
    const store = { ensureAlbumFolder: vi.fn(async () => {}), hasAlbumPhoto: vi.fn(async () => false),
      publishAlbumPhoto: vi.fn(async () => { throw new Error('disk unavailable'); }) };
    const events: AuditEvent[] = [];
    const audit = createOperationalAudit({ async append(event) { events.push(event); }, async appendFallback() {}, logSinkState() {} });
    const { service } = await setup({ albumOpenByteLimit: 10, audit,
      readChatResource: async (command: ChatResourceRequest) => {
        if (command.action === 'listAlbumPhotos') return { type: 'chatResourceResult', requestId: command.requestId, action: command.action,
          ok: true, accountId: key.accountId, workerInstanceId: 'worker-1', controlEpoch: 1, chatType: key.chatType, chatId: key.chatId,
          photos: [photo, secondPhoto, thirdPhoto], nextCursor: null };
        commands.push({ photoId: command.photoId, maxBytes: command.maxBytes });
        const size = command.photoId === photo.photoId ? 6 : 4;
        return { type: 'chatResourceResult', requestId: command.requestId, action: command.action, ok: true, accountId: key.accountId,
          workerInstanceId: 'worker-1', controlEpoch: 1, chatType: key.chatType, chatId: key.chatId, bytes: new Uint8Array(size) };
      } } as never, store);
    const result = await service.openAlbum(key, album.albumId);
    await audit.flush();
    expect(commands).toEqual([{ photoId: photo.photoId, maxBytes: 10 }, { photoId: secondPhoto.photoId, maxBytes: 4 }]);
    expect(result).toMatchObject({ failedCount: 2, totalCount: 3, byteCount: 10, complete: false, errorCode: 'BYTE_LIMIT' });
    const { projectSystemActivity } = await import('./system-records.js');
    expect(projectSystemActivity(events as never, []).flatMap((row) => row.kind === 'audit' ? [row.phase] : [])).toEqual(['失敗', '失敗']);
    expect(new Set(events.map((event) => event.correlationId)).size).toBe(2);
  });

  it('continues after a photo download failure and returns a safe partial result', async () => {
    const secondPhoto = { ...photo, photoId: 'photo-two', oid: 'oid-two' };
    const store = { ensureAlbumFolder: vi.fn(async () => {}), publishAlbumPhoto: vi.fn(async () => {}) };
    const { service, readChatResource } = await setup({ readChatResource: async (command) => {
      if (command.action === 'listAlbumPhotos') return { type: 'chatResourceResult', requestId: command.requestId, action: command.action, ok: true,
        accountId: key.accountId, workerInstanceId: 'worker-1', controlEpoch: 1, chatType: key.chatType, chatId: key.chatId,
        photos: [photo, secondPhoto], nextCursor: null };
      if (command.action === 'downloadAlbumPhoto' && command.photoId === photo.photoId) return { type: 'chatResourceResult', requestId: command.requestId,
        action: command.action, ok: false, error: 'response_shape_invalid', accountId: key.accountId, workerInstanceId: 'worker-1', controlEpoch: 1,
        chatType: key.chatType, chatId: key.chatId };
      return { type: 'chatResourceResult', requestId: command.requestId, action: command.action, ok: true, accountId: key.accountId,
        workerInstanceId: 'worker-1', controlEpoch: 1, chatType: key.chatType, chatId: key.chatId, bytes: new Uint8Array([1]) };
    } }, store);
    const result = await service.openAlbum(key, album.albumId);
    expect(result).toMatchObject({ savedCount: 1, failedCount: 1, totalCount: 2, complete: false, errorCode: null,
      failureCodes: ['LINE_READ_FAILED'] });
    expect(readChatResource.mock.calls.filter(([command]) => command.action === 'downloadAlbumPhoto')).toHaveLength(2);
    expect(store.publishAlbumPhoto).toHaveBeenCalledOnce();
  });

  it('returns a resumable cursor after the bounded album-photo page budget', async () => {
    const { service, readChatResource } = await setup({ readChatResource: async (command) => {
      const page = command.cursor === undefined ? 0 : Number(command.cursor.replace('page-', ''));
      const photos = Array.from({ length: 50 }, (_, index) => ({ ...photo, photoId: `photo-${page * 50 + index}` }));
      return { type: 'chatResourceResult', requestId: command.requestId, action: command.action, ok: true, accountId: command.accountId,
        workerInstanceId: command.workerInstanceId, controlEpoch: command.controlEpoch, chatType: command.chatType, chatId: command.chatId,
        photos, nextCursor: page < 10 ? `page-${page + 1}` : null } as ChatResourceReadResult;
    } }, { ensureAlbumFolder: vi.fn(async () => {}), hasAlbumPhoto: vi.fn(async () => true), publishAlbumPhoto: vi.fn(async () => {}) });
    const first = await service.openAlbum(key, album.albumId);
    expect(first).toMatchObject({ complete: false, errorCode: 'PAGE_LIMIT', nextCursor: 'page-10', nextPhotoIndex: 0, totalCount: 500 });
    const second = await service.openAlbum(key, album.albumId, undefined, 'notification', undefined, first.nextCursor, first.nextPhotoIndex);
    expect(second).toMatchObject({ complete: true, nextCursor: null, totalCount: 50 });
    expect(readChatResource.mock.calls.filter(([command]) => command.action === 'listAlbumPhotos')).toHaveLength(11);
  });

  it('persists a producer incomplete failure through the production diagnostic parser and sink', async () => {
    const root = await mkdtemp(join(tmpdir(), 'album-failure-diagnostic-'));
    const diagnostics = createChatResourceDiagnostics({ appDataDirectory: root });
    const parsed: unknown[] = [];
    const { service } = await setup({ recordDiagnostic: (record) => {
      const safe = parseChatResourceDiagnostic(record);
      parsed.push(safe);
      if (safe) diagnostics.record(safe);
    } });
    service.recordNotificationFailure(key, new Error('ALBUM_ARCHIVE_INCOMPLETE'));
    await diagnostics.shutdown();
    expect(parsed[0]).toMatchObject({ failureStage: 'archive_scan', failureReason: 'archive_incomplete' });
    const stored = (await readFile(diagnostics.filePath, 'utf8')).trim().split('\n').map((line) => JSON.parse(line));
    expect(stored).toContainEqual(expect.objectContaining({ failureStage: 'archive_scan', failureReason: 'archive_incomplete' }));
    await rm(root, { recursive: true, force: true });
  });

  it('resumes at the first unsaved photo after a per-pass byte budget', async () => {
    const firstPhoto = { ...photo, photoId: 'photo-first' };
    const secondPhoto = { ...photo, photoId: 'photo-second' };
    const published: string[] = [];
    const { service, readChatResource } = await setup({ albumOpenByteLimit: 3, readChatResource: async (command) => {
      const data = command.action === 'listAlbumPhotos' ? { photos: [firstPhoto, secondPhoto], nextCursor: null }
        : command.action === 'downloadAlbumPhoto' ? { bytes: new Uint8Array([1, 2]) } : {};
      return { type: 'chatResourceResult', requestId: command.requestId, action: command.action, ok: true, accountId: command.accountId,
        workerInstanceId: command.workerInstanceId, controlEpoch: command.controlEpoch, chatType: command.chatType, chatId: command.chatId, ...data } as ChatResourceReadResult;
    } }, { ensureAlbumFolder: vi.fn(async () => {}), publishAlbumPhoto: vi.fn(async ({ photoId }: { photoId: string }) => { published.push(photoId); }) });
    const first = await service.openAlbum(key, album.albumId);
    expect(first).toMatchObject({ complete: false, errorCode: 'BYTE_LIMIT', nextCursor: null, nextPhotoIndex: 1, savedCount: 1 });
    const second = await service.openAlbum(key, album.albumId, undefined, 'notification', undefined, first.nextCursor, first.nextPhotoIndex);
    expect(second).toMatchObject({ complete: true, savedCount: 1, nextCursor: null });
    expect(published).toEqual(['photo-first', 'photo-second']);
    expect(readChatResource.mock.calls.filter(([command]) => command.action === 'downloadAlbumPhoto')).toHaveLength(3);
  });

  it('rejects monitor-only album opens before creating a folder or reading LINE', async () => {
    const store = { ensureAlbumFolder: vi.fn(async () => {}), publishAlbumPhoto: vi.fn(async () => {}) };
    const { service, readChatResource } = await setup({ isWritableAccount: async () => false }, store);
    await expect(service.openAlbum(key, album.albumId)).rejects.toThrow('read-only');
    expect(store.ensureAlbumFolder).not.toHaveBeenCalled();
    expect(readChatResource).not.toHaveBeenCalled();
  });

  it('cancels a pending album open without publishing after the request is cancelled', async () => {
    let resolvePage!: (value: ChatResourceReadResult) => void;
    const pageReady = new Promise<ChatResourceReadResult>((resolve) => { resolvePage = resolve; });
    const store = { ensureAlbumFolder: vi.fn(async () => {}), publishAlbumPhoto: vi.fn(async () => {}) };
    const { service, readChatResource } = await setup({ readChatResource: async (command) => {
      if (command.action === 'listAlbumPhotos') return pageReady;
      return { type: 'chatResourceResult', requestId: command.requestId, action: command.action, ok: true, accountId: key.accountId,
        workerInstanceId: 'worker-1', controlEpoch: 1, chatType: key.chatType, chatId: key.chatId, bytes: new Uint8Array([1]) };
    } }, store);
    const controller = new AbortController();
    const open = service.openAlbum(key, album.albumId, controller.signal);
    await vi.waitFor(() => expect(readChatResource).toHaveBeenCalledOnce());
    controller.abort(new Error('cancelled'));
    await expect(open).rejects.toThrow('cancelled');
    resolvePage({ type: 'chatResourceResult', requestId: 'late', action: 'listAlbumPhotos', ok: true, accountId: key.accountId,
      workerInstanceId: 'worker-1', controlEpoch: 1, chatType: key.chatType, chatId: key.chatId, photos: [photo], nextCursor: null });
    await Promise.resolve();
    expect(store.publishAlbumPhoto).not.toHaveBeenCalled();
  });

  it('rejects monitored accounts and unknown conversations before contacting LINE or the store', async () => {
    const { service, readChatResource } = await setup({ isWritableAccount: async () => false });
    await expect(service.listNotes(key, null)).rejects.toThrow('read-only');
    expect(readChatResource).not.toHaveBeenCalled();
    const invalid = await setup({ conversationExists: async () => false });
    await expect(invalid.service.listAlbums(key, null)).rejects.toThrow('conversation');
    expect(invalid.readChatResource).not.toHaveBeenCalled();
  });

  it('records only fixed gateway failure categories for note and album live reads', async () => {
    const records: unknown[] = [];
    const { service } = await setup({
      readChatResource: async () => { throw Object.assign(new Error('account credential secret and chat body'), { diagnostic: {
        stage: 'gateway_admission', reason: 'stale_binding', currentBindingMatch: false, currentEpochMatch: true, workerReady: true,
      } }); },
      recordDiagnostic: (record) => records.push(record),
    });
    await expect(service.listNotes(key, null)).rejects.toThrow('account credential secret');
    await expect(service.listAlbums(key, null)).rejects.toThrow('account credential secret');
    expect(records).toHaveLength(2);
    for (const record of records) {
      expect(record).toMatchObject({ status: 'failure', errorCode: 'ACCOUNT_BINDING_CHANGED', failureStage: 'gateway_admission',
        failureReason: 'stale_binding', currentBindingMatch: false, currentEpochMatch: true, workerReady: true });
      expect(JSON.stringify(record)).not.toContain('credential');
      expect(JSON.stringify(record)).not.toContain('chat body');
    }
  });

  it('reports album folder and photo write failures at the bounded archive-write stage', async () => {
    const diagnostics: unknown[] = [];
    const folderFailure = await setup({ recordDiagnostic: (record) => diagnostics.push(record) }, {
      ensureAlbumFolder: async () => { throw Object.assign(new Error('permission denied'), { code: 'EACCES' }); }, publishAlbumPhoto: async () => {},
    });
    await expect(folderFailure.service.openAlbum(key, album.albumId, undefined, 'notification')).rejects.toThrow('permission denied');
    expect(diagnostics).toContainEqual(expect.objectContaining({ source: 'notification', action: 'album_photos', failureStage: 'archive_write', failureReason: 'folder_write_failed' }));

    diagnostics.length = 0;
    const photoFailure = await setup({ recordDiagnostic: (record) => diagnostics.push(record) }, {
      ensureAlbumFolder: async () => {}, publishAlbumPhoto: async () => { throw Object.assign(new Error('disk full'), { code: 'ENOSPC' }); },
    });
    await photoFailure.service.openAlbum(key, album.albumId, undefined, 'notification');
    expect(diagnostics).toContainEqual(expect.objectContaining({ source: 'notification', action: 'album_photos',
      failureStage: 'archive_write', failureReason: 'photo_write_failed' }));
  });

  it('identifies archive contains failures separately and does not issue a LINE photo download', async () => {
    const diagnostics: unknown[] = [];
    const { service, readChatResource } = await setup({ recordDiagnostic: (record) => diagnostics.push(record) }, {
      ensureAlbumFolder: async () => {},
      hasAlbumPhoto: async () => { throw new Error('archive index unavailable'); },
      publishAlbumPhoto: async () => {},
    });

    await service.openAlbum(key, album.albumId, undefined, 'notification');

    expect(readChatResource.mock.calls.map(([command]) => command.action)).toEqual(['listAlbumPhotos']);
    expect(diagnostics).toContainEqual(expect.objectContaining({ source: 'notification', action: 'album_photos',
      failureStage: 'archive_contains', failureReason: 'unknown' }));
    expect(diagnostics).not.toContainEqual(expect.objectContaining({ action: 'photo_download' }));
  });

  it('does not infer binding failures from broad caller error text', async () => {
    const records: unknown[] = [];
    const { service } = await setup({ readChatResource: async () => { throw new Error('account is temporarily unavailable'); },
      recordDiagnostic: (record) => records.push(record) });
    await expect(service.listNotes(key, null)).rejects.toThrow('temporarily unavailable');
    expect(records[0]).toMatchObject({ errorCode: 'UNKNOWN', failureStage: 'resource_read', failureReason: 'unknown' });
  });

  it('records a safe worker category while keeping the generic read failure', async () => {
    const records: unknown[] = [];
    const { service } = await setup({ readChatResource: async (command) => ({ type: 'chatResourceResult',
      requestId: command.requestId, action: command.action, accountId: key.accountId, workerInstanceId: 'worker-1', controlEpoch: 1,
      chatType: key.chatType, chatId: key.chatId, ok: false, error: 'normalization_failure' }),
      recordDiagnostic: (record) => records.push(record) });
    await expect(service.listNotes(key, null)).rejects.toThrow('LINE_READ_FAILED');
    expect(records[0]).toMatchObject({ failureStage: 'worker_response', failureReason: 'worker_response_error',
      failureCategory: 'normalization_failure' });
    expect(JSON.stringify(records[0])).not.toContain('normalization_failure token');
  });

  it('passes bounded native album failure facts into the production diagnostic record', async () => {
    const records: unknown[] = [];
    const { service } = await setup({ readChatResource: async (command) => ({ type: 'chatResourceResult',
      requestId: command.requestId, action: command.action, accountId: key.accountId, workerInstanceId: 'worker-1', controlEpoch: 1,
      chatType: key.chatType, chatId: key.chatId, ok: false, error: 'response_code_invalid', failureKind: 'linejs_internal',
      upstreamCode: 102001 }) as never, recordDiagnostic: (record) => records.push(record) });
    await expect(service.listAlbums(key, null)).rejects.toThrow('LINE_READ_FAILED');
    expect(records[0]).toMatchObject({ action: 'album_list', failureCategory: 'response_code_invalid',
      failureKind: 'linejs_internal', upstreamCode: 102001 });
    expect(JSON.stringify(records[0])).not.toContain('message');
  });

  it.each([
    [403, 403],
    ['missing', 'missing'],
    ['non_numeric', 'non_numeric'],
  ] as const)('records only a bounded Note response code for a modal read (%s)', async (_label, responseCode) => {
    const records: unknown[] = [];
    const { service } = await setup({ readChatResource: async (command) => ({ type: 'chatResourceResult',
      requestId: command.requestId, action: command.action, accountId: key.accountId, workerInstanceId: 'worker-1', controlEpoch: 1,
      chatType: key.chatType, chatId: key.chatId, ok: false, error: 'response_code_invalid', responseCode }),
      recordDiagnostic: (record) => records.push(record) });
    await expect(service.listNotes(key, null)).rejects.toThrow('LINE_READ_FAILED');
    expect(records[0]).toMatchObject({ failureCategory: 'response_code_invalid', responseCode });
    expect(JSON.stringify(records[0])).not.toContain('secret');
  });

  it('does not persist Note response codes from background notification reads', async () => {
    const records: unknown[] = [];
    const { service } = await setup({ readChatResource: async (command) => ({ type: 'chatResourceResult',
      requestId: command.requestId, action: command.action, accountId: key.accountId, workerInstanceId: 'worker-1', controlEpoch: 1,
      chatType: key.chatType, chatId: key.chatId, ok: false, error: 'response_code_invalid', responseCode: 403 }),
      recordDiagnostic: (record) => records.push(record) });
    await expect(service.listNotes(key, null, undefined, 'notification')).rejects.toThrow('LINE_READ_FAILED');
    expect(records[0]).not.toHaveProperty('responseCode');
  });

  it('closes account admission on invalidation until the facade confirms authenticated readiness', async () => {
    const { service, readChatResource, published } = await setup();
    service.invalidateAccount(key.accountId, 'logout');
    await expect(service.getNote(key, noteA.postId)).rejects.toThrow('archive is closed');
    expect(readChatResource).not.toHaveBeenCalled();
    service.reopenAccount(key.accountId);
    await expect(service.getNote(key, noteA.postId)).resolves.toMatchObject({ postId: noteA.postId });
    expect(readChatResource).toHaveBeenCalledOnce();
    expect(published).toHaveLength(1);
  });

  it('keeps fresh requests closed through blocked teardown and reopens only after fresh login readiness', async () => {
    let ready = false;
    const { service, deps, readChatResource, published, setBinding } = await setup();
    const admission = new ChatResourceAccountAdmission(service, (binding) => ready
      && deps.isCurrentBinding(binding as ChatResourceBinding) && binding.mode === 'ACTIVE_CONTROL');
    let finishTeardown!: () => void;
    const teardownGate = new Promise<void>((resolve) => { finishTeardown = resolve; });
    let teardownFinished = false;
    const teardown = (async () => { admission.close(key.accountId, 'logout'); await teardownGate; teardownFinished = true; })();
    await expect(service.getNote(key, noteA.postId)).rejects.toThrow('archive is closed');
    expect(readChatResource).not.toHaveBeenCalled();
    expect(teardownFinished).toBe(false);
    finishTeardown();
    await teardown;

    const fresh = { accountId: key.accountId, workerInstanceId: 'worker-2', controlEpoch: 2, transportOwnerId: 'owner-2',
      transportGeneration: 3, writeGrantVersion: 4, mode: 'ACTIVE_CONTROL' } as const;
    admission.authenticated({ ...fresh, workerInstanceId: 'worker-1', controlEpoch: 1 });
    await expect(service.getNote(key, noteA.postId)).rejects.toThrow('archive is closed');
    admission.authenticated(fresh);
    await expect(service.getNote(key, noteA.postId)).rejects.toThrow('archive is closed');
    admission.observeBinding(fresh);
    admission.authenticated(fresh);
    setBinding(fresh);
    admission.ready(fresh);
    await expect(service.getNote(key, noteA.postId)).rejects.toThrow('archive is closed');
    expect(readChatResource).not.toHaveBeenCalled();

    ready = true;
    admission.ready(fresh);
    await expect(service.getNote(key, noteA.postId)).resolves.toMatchObject({ postId: noteA.postId });
    expect(readChatResource).toHaveBeenCalledOnce();
    expect(published).toHaveLength(1);
  });

  it('fails closed before LINE when no native store was injected', async () => {
    const { deps, readChatResource } = await setup();
    const withoutStore = { ...deps };
    delete withoutStore.store;
    const noStore = new ChatResourceArchiveService(withoutStore);
    services.add(noStore);
    await expect(noStore.listNotes(key, null)).rejects.toThrow('CHAT_RESOURCE_STORE_UNAVAILABLE');
    expect(readChatResource).not.toHaveBeenCalled();
  });

  it('rejects albums returned for a different chat before publication', async () => {
    const { service, published } = await setup({ readChatResource: async (command) => ({
      type: 'chatResourceResult', requestId: command.requestId, action: command.action, ok: true,
      accountId: command.accountId, workerInstanceId: command.workerInstanceId, controlEpoch: command.controlEpoch,
      chatType: command.chatType, chatId: command.chatId, albums: [{ ...album, chatId: 'other-chat' }], nextCursor: null,
    } as ChatResourceReadResult) });
    await expect(service.listAlbums(key, null)).rejects.toThrow('does not belong');
    expect(published).toHaveLength(0);
  });

  it('projects IPC envelopes into exact worker commands for every action', async () => {
    const { service, readChatResource } = await setup();
    const base = { accountId: key.accountId, chatType: key.chatType, chatId: key.chatId };
    await service.dispatchIpc({ ...base, requestId: 'renderer-list-notes', type: 'listChatNotes', cursor: null });
    await service.dispatchIpc({ ...base, requestId: 'renderer-get-note', type: 'getChatNote', postId: noteA.postId });
    await service.dispatchIpc({ ...base, requestId: 'renderer-list-albums', type: 'listChatAlbums', cursor: null });
    await service.dispatchIpc({ ...base, requestId: 'renderer-list-photos', type: 'listChatAlbumPhotos', albumId: album.albumId, cursor: null });
    await service.dispatchIpc({ ...base, requestId: 'renderer-download-photo', type: 'downloadChatAlbumPhoto', albumId: album.albumId, photoId: photo.photoId, oid: photo.oid, prefix: photo.prefix });
    const commands = readChatResource.mock.calls.map(([command]) => command);
    expect(commands).toHaveLength(5);
    for (const command of commands) {
      expect(command).toMatchObject({ type: 'chatResourceRead', accountId: key.accountId, chatType: key.chatType, chatId: key.chatId,
        workerInstanceId: 'worker-1', controlEpoch: 1 });
      expect(command.requestId).not.toMatch(/^renderer-/);
    }
  });

  it('forwards a renderer cancellation signal through IPC to the worker before publication', async () => {
    let entered!: () => void;
    const started = new Promise<void>((resolve) => { entered = resolve; });
    const { service, readChatResource, published } = await setup({ readChatResource: (_command, signal) => new Promise((resolve, reject) => {
      entered();
      signal?.addEventListener('abort', () => reject(signal.reason), { once: true });
    }) });
    const controller = new AbortController();
    const request = service.dispatchIpc({ ...key, requestId: 'cancel-read', type: 'listChatNotes', cursor: null }, controller.signal);
    await started;
    controller.abort(new Error('modal closed'));
    await expect(request).rejects.toThrow('modal closed');
    expect(readChatResource).toHaveBeenCalledOnce();
    expect(published).toHaveLength(0);
  });

  it('does not publish a late download response after its request is cancelled', async () => {
    let release!: (result: ChatResourceReadResult) => void;
    const { service, published, readChatResource } = await setup({ readChatResource: (command) => new Promise((resolve) => { release = resolve; }) });
    const controller = new AbortController();
    const operation = service.dispatchIpc({ ...key, requestId: 'cancel-download', type: 'downloadChatAlbumPhoto', albumId: album.albumId,
      photoId: photo.photoId, oid: photo.oid, prefix: photo.prefix }, controller.signal);
    await vi.waitFor(() => expect(readChatResource).toHaveBeenCalledOnce());
    controller.abort(new Error('modal closed'));
    await expect(operation).rejects.toThrow('modal closed');
    release({ type: 'chatResourceResult', requestId: readChatResource.mock.calls[0]![0].requestId, action: 'downloadAlbumPhoto', ok: true,
      accountId: key.accountId, workerInstanceId: 'worker-1', controlEpoch: 1, chatType: key.chatType, chatId: key.chatId, bytes: new Uint8Array([1]) });
    await Promise.resolve();
    expect(published).toHaveLength(0);
  });

  it.each(['logout', 'mode change', 'control epoch change'])('cancels a deferred commit when %s is invalidated before commit', async (transition) => {
    const { service, published, setGate, setBinding } = await setup();
    const started = deferred(), commit = deferred();
    setGate({ started: () => started.resolve(), wait: commit.promise });
    const operation = service.getNote(key, noteA.postId);
    await started.promise;
    if (transition === 'logout') setBinding(null);
    else if (transition === 'mode change') setBinding({ accountId: key.accountId, workerInstanceId: 'worker-1', controlEpoch: 1,
      transportOwnerId: 'owner-1', transportGeneration: 2, writeGrantVersion: 3, mode: 'MONITOR_ONLY' });
    else setBinding({ accountId: key.accountId, workerInstanceId: 'worker-1', controlEpoch: 2,
      transportOwnerId: 'owner-1', transportGeneration: 2, writeGrantVersion: 3, mode: 'ACTIVE_CONTROL' });
    service.invalidateAccount(key.accountId, transition);
    commit.resolve();
    await expect(operation).rejects.toThrow(transition);
    expect(published).toHaveLength(0);
  });

  it('drains and fences a deferred native commit during shutdown', async () => {
    const { service, published, setGate } = await setup();
    const started = deferred(), commit = deferred();
    setGate({ started: () => started.resolve(), wait: commit.promise });
    const operation = service.getNote(key, noteA.postId);
    await started.promise;
    const shutdown = service.shutdown();
    commit.resolve();
    await expect(operation).rejects.toThrow('shutting down');
    await shutdown;
    expect(published).toHaveLength(0);
  });

  it('bounds shutdown when native publish, read, or close hangs and rejects pending callers', async () => {
    const publishGate = deferred();
    let entered!: () => void;
    const enteredPromise = new Promise<void>((resolve) => { entered = resolve; });
    const forceClose = vi.fn();
    const { service } = await setup({}, { publish: async (input) => {
      entered(); await publishGate.promise; input.guard();
      throw new Error('late publish should be fenced');
    }, close: async () => new Promise<void>(() => {}), forceClose });
    const operation = service.getNote(key, noteA.postId);
    void operation.catch(() => undefined);
    await enteredPromise;
    const started = Date.now();
    await service.shutdown();
    expect(Date.now() - started).toBeLessThan(1500);
    await expect(operation).rejects.toThrow('shutting down');
    expect(forceClose).toHaveBeenCalledOnce();
    publishGate.resolve();
    await Promise.resolve();
  });

  it('bounds shutdown for a hung worker read before native publication', async () => {
    let release!: (result: ChatResourceReadResult) => void;
    const forceClose = vi.fn();
    const { service, readChatResource } = await setup({ readChatResource: (command) => new Promise((resolve) => { release = resolve; }) },
      { close: async () => {}, forceClose });
    const operation = service.getNote(key, noteA.postId);
    void operation.catch(() => undefined);
    await vi.waitFor(() => expect(readChatResource).toHaveBeenCalledOnce());
    await service.shutdown();
    await expect(operation).rejects.toThrow('shutting down');
    expect(forceClose).toHaveBeenCalledOnce();
    release({ type: 'chatResourceResult', requestId: 'late', action: 'getNote', ok: true, accountId: key.accountId,
      workerInstanceId: 'worker-1', controlEpoch: 1, chatType: key.chatType, chatId: key.chatId, note: noteA });
  });

  it('uses forceClose when native close hangs even after reads drain', async () => {
    const forceClose = vi.fn();
    const { service } = await setup({}, { close: async () => new Promise<void>(() => {}), forceClose });
    const started = Date.now();
    await service.shutdown();
    expect(Date.now() - started).toBeLessThan(1500);
    expect(forceClose).toHaveBeenCalledOnce();
  });

  it('assigns a newer revision for A→B→A and retains every snapshot', async () => {
    let text = 'A';
    const { service, revisions, readChatResource, store } = await setup({ readChatResource: async (command) => ({
      type: 'chatResourceResult', requestId: command.requestId, action: command.action, ok: true,
      accountId: command.accountId, workerInstanceId: command.workerInstanceId, controlEpoch: command.controlEpoch,
      chatType: command.chatType, chatId: command.chatId, note: { ...noteA, text },
    } as ChatResourceReadResult) });
    await service.getNote(key, noteA.postId);
    text = 'B'; await service.getNote(key, noteA.postId);
    text = 'A'; await service.getNote(key, noteA.postId);
    const versions = [...revisions.values()][0]!;
    expect(versions.map((version) => version.revision)).toEqual([1, 2, 3]);
    expect(Buffer.from(versions.at(-1)!.content).toString()).toContain('A');
    expect(versions).toHaveLength(3);
    expect(Date.parse(versions.at(-1)!.savedAt)).toBeGreaterThan(Date.parse(versions[0]!.savedAt));
    expect((await store.read({ key, kind: 'note', resourceId: noteA.postId }))?.revision).toBe(3);
    expect((await store.list({ key, kind: 'note', limit: 50 })).items[0]?.revision).toBe(3);
    expect(readChatResource).toHaveBeenCalledTimes(3);
  });

  it('rejects stale worker responses and caller cancellation', async () => {
    const { service } = await setup({ readChatResource: async (command) => ({
      type: 'chatResourceResult', requestId: command.requestId, action: command.action, ok: true,
      accountId: command.accountId, workerInstanceId: command.workerInstanceId, controlEpoch: command.controlEpoch,
      chatType: command.chatType, chatId: 'other-chat', notes: [], nextCursor: null,
    } as ChatResourceReadResult) });
    await expect(service.listNotes(key, null)).rejects.toThrow('Invalid LINE resource response');
    const controller = new AbortController(); controller.abort(new Error('cancelled'));
    await expect(service.listNotes(key, null, controller.signal)).rejects.toThrow('cancelled');
  });

  it('coalesces duplicate notifications and performs one trailing refresh', async () => {
    const pending: Array<() => void> = [];
    const { service, readChatResource } = await setup({ readChatResource: (command) => new Promise<ChatResourceReadResult>((resolve) => {
      pending.push(() => resolve({ type: 'chatResourceResult', requestId: command.requestId, action: command.action, ok: true,
        accountId: command.accountId, workerInstanceId: command.workerInstanceId, controlEpoch: command.controlEpoch,
        chatType: command.chatType, chatId: command.chatId, notes: [], nextCursor: null }));
    }) });
    const first = service.refreshNotesFromNotification(key);
    const second = service.refreshNotesFromNotification(key);
    await vi.waitFor(() => expect(readChatResource).toHaveBeenCalledTimes(1));
    pending.shift()!();
    await vi.waitFor(() => expect(readChatResource).toHaveBeenCalledTimes(2));
    pending.shift()!();
    await Promise.all([first, second]);
    expect(readChatResource).toHaveBeenCalledTimes(2);
  });

  it('stops an album reconciliation when its captured binding changes between operations', async () => {
    const diagnostics: unknown[] = [];
    const originalBinding: ChatResourceBinding = { accountId: key.accountId, workerInstanceId: 'worker-1', controlEpoch: 1,
      transportOwnerId: 'owner-1', transportGeneration: 2, writeGrantVersion: 3, mode: 'ACTIVE_CONTROL' };
    const { service, readChatResource, setBinding } = await setup({ recordDiagnostic: (record) => diagnostics.push(record),
      readChatResource: async (command) => {
        setBinding({ ...originalBinding, workerInstanceId: 'replacement-worker' });
        return { type: 'chatResourceResult', requestId: command.requestId, action: command.action, ok: true,
          accountId: command.accountId, workerInstanceId: command.workerInstanceId, controlEpoch: command.controlEpoch,
          chatType: command.chatType, chatId: command.chatId, albums: [album], nextCursor: null } as ChatResourceReadResult;
      } });
    await expect(service.listAlbums(key, null, undefined, 'notification', originalBinding)).rejects.toThrow('binding changed');
    expect(readChatResource.mock.calls.map(([command]) => command.action)).toEqual(['listAlbums']);
    expect(diagnostics).not.toHaveLength(0);
  });

});

describe('native Note notification recognition', () => {
  const envelope = { eventId: 'event-1', accountId: 'account-1', chatType: 'group' as const, chatId: 'chat-1', senderId: 'sender-1',
    messageId: 'message-1', kind: 'event' as const, text: null, mentionIds: [], mentionRanges: [], replyToMessageId: null,
    ingestion: { source: 'live' as const, cursor: 'cursor' }, occurredAt: new Date(0).toISOString(), attachments: [],
    raw: { message: { contentType: 16, contentMetadata: { serviceType: 'GB' } } } };
  it('recognizes only exact live GB Note POSTNOTIFICATION content with a native message envelope', () => {
    expect(isNativeNotePostNotification(envelope)).toBe(true);
    expect(nativePostNotificationSubtype(envelope)).toBe('note');
    expect(nativePostNotificationSubtype({ ...envelope, raw: { message: { contentType: 16, contentMetadata: { serviceType: 'AB' } } } })).toBe('album');
    expect(isNativeNotePostNotification({ ...envelope, raw: { message: { contentType: 16, contentMetadata: { serviceType: 'AB' } } } })).toBe(false);
    expect(isNativeNotePostNotification({ ...envelope, raw: { message: { contentType: 16, contentMetadata: { serviceType: 'UNKNOWN' } } } })).toBe(false);
    expect(isNativeNotePostNotification({ ...envelope, ingestion: { source: 'history' as const, cursor: 'cursor' } })).toBe(false);
    expect(isNativeNotePostNotification({ ...envelope, raw: { message: { contentType: 1 } } })).toBe(false);
    expect(isNativeNotePostNotification({ ...envelope, raw: {} })).toBe(false);
  });

});
