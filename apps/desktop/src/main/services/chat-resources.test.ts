import { createHash } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ConversationKey } from '@line-agent/contracts';
import { ChatAlbumCatalogRepository } from '@line-agent/database';
import { createTestDatabase } from '../../../../../packages/database/src/test-database.js';
import { AlbumArchiveFailure, ChatResourceArchiveService, isNativeNotePostNotification, nativePostNotificationSubtype, type ChatResourceArchiveDependencies, type ChatResourceArchiveItem,
  type ChatResourceArchiveVersion, type ChatResourceBinding, type ChatResourceKind, type ChatResourceReadResult, type ChatResourceRequest,
  type ChatResourceStore } from './chat-resources.js';
import { ChatResourceAccountAdmission } from './chat-resource-admission.js';
import { createOperationalAudit, type AuditEvent } from './operational-audit.js';
import { createChatResourceDiagnostics, parseChatResourceDiagnostic } from './chat-resource-diagnostics.js';

const noteA = { postId: 'post/one', createdTime: 1_700_000_000_000, text: 'A', content: { html: '<b>data</b>' } };
const album = { albumId: 'album:one', chatId: 'chat-1', title: 'Photos', photoCount: 1, createTime: 1_700_000_000_000, updateTime: 1_700_000_000_001 };
const photo = { photoId: 'photo/one', oid: 'oid', prefix: 'album/a' as const, shotTime: 1_700_000_000_000, width: 2, height: 3 };
const key = { accountId: 'account-1', chatType: 'group' as const, chatId: 'chat-1' };
const integrationTest = process.env.TEST_DATABASE_URL ? it : it.skip;

type CommitGate = { started(): void; wait: Promise<void> };
function deferred(): { promise: Promise<void>; resolve(): void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

describe('ChatResourceArchiveService', () => {
  const services = new Set<ChatResourceArchiveService>();
  afterEach(async () => { await Promise.all([...services].map((service) => service.shutdown())); services.clear(); });

  it('lazily exports already-saved photos from the catalog without LINE reads or duplicate catalog rows', async () => {
    const bytes = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0, 0, 0, 0, 0]);
    const canonical = { folderName: createHash('sha256').update(album.albumId).digest('hex'), fileName: 'record_f_saved.jpg',
      contentHash: createHash('sha256').update(bytes).digest('hex'), byteCount: bytes.byteLength, revision: 1, savedAt: new Date().toISOString() };
    const catalog = {
      getAlbum: vi.fn(async () => album), ensureReadableFolderName: vi.fn(async (_key: ConversationKey, _albumId: string, name: string) => name),
      listSavedPhotosForReadableReconciliation: vi.fn(async () => ({ items: [{ ...photo, scanOrdinal: 0 }], nextCursor: null })),
      savedPhoto: vi.fn(async () => canonical), savePhoto: vi.fn(async () => {}), readablePhotoName: vi.fn(async () => null),
      saveReadablePhotoName: vi.fn(async () => {}),
      readableExportState: vi.fn(async () => ({ cursor: -1, sweepFailed: false })), saveReadableExportProgress: vi.fn(async () => {}), hasPhotosNeedingReadableExport: vi.fn(async () => false),
    } as unknown as NonNullable<ChatResourceArchiveDependencies['catalog']>;
    const ensureFolder = vi.fn(async () => {}), materialize = vi.fn(async () => ({ unchanged: false }));
    const { service, readChatResource } = await setup({ catalog }, { inspectAlbumPhoto: vi.fn(async () => canonical),
      ensureReadableAlbumFolder: ensureFolder, materializeAlbumPhoto: materialize });

    await expect(service.openReadableAlbumFolder(key, album.albumId)).resolves.toMatchObject({ exportedCount: 1, failedCount: 0, totalCount: 1, complete: true });
    expect(materialize).toHaveBeenCalledWith(expect.objectContaining({ canonicalFile: canonical, viewFileName: expect.stringMatching(/LINE_ALBUM_Photos_20231114_0001_[0-9a-f]{10}\.jpg/) }));
    expect(catalog.saveReadablePhotoName).toHaveBeenCalledOnce();
    expect(catalog.savePhoto).not.toHaveBeenCalled();
    expect(readChatResource).not.toHaveBeenCalled();
  });

  it('backfills saved photos during album selection from local catalog and archive only', async () => {
    const bytes = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0, 0, 0, 0, 0]);
    const canonical = { folderName: createHash('sha256').update(album.albumId).digest('hex'), fileName: 'record_f_saved.jpg',
      contentHash: createHash('sha256').update(bytes).digest('hex'), byteCount: bytes.byteLength, revision: 1, savedAt: new Date().toISOString() };
    const catalog = {
      photoScan: vi.fn(async () => ({ complete: true, generation: 1, cursor: null, previousCursor: null, nextOrdinal: 1 })),
      listPhotos: vi.fn(async () => ({ items: [photo], nextCursor: null })),
      getAlbum: vi.fn(async () => album), ensureReadableFolderName: vi.fn(async (_key: ConversationKey, _albumId: string, name: string) => name),
      listSavedPhotosForReadableReconciliation: vi.fn(async () => ({ items: [{ ...photo, scanOrdinal: 0 }], nextCursor: null })),
      savedPhoto: vi.fn(async () => canonical), savePhoto: vi.fn(async () => {}), readablePhotoName: vi.fn(async () => null), saveReadablePhotoName: vi.fn(async () => {}),
      readableExportState: vi.fn(async () => ({ cursor: -1, sweepFailed: false })), saveReadableExportProgress: vi.fn(async () => {}), hasPhotosNeedingReadableExport: vi.fn(async () => false),
    } as unknown as NonNullable<ChatResourceArchiveDependencies['catalog']>;
    const materialize = vi.fn(async () => ({ unchanged: false }));
    const { service, readChatResource } = await setup({ catalog }, { inspectAlbumPhoto: vi.fn(async () => canonical),
      ensureReadableAlbumFolder: vi.fn(async () => {}), materializeAlbumPhoto: materialize });

    await expect(service.listAlbumPhotos(key, album.albumId, null)).resolves.toMatchObject({ photos: [photo], nextCursor: null });
    expect(materialize).toHaveBeenCalledOnce();
    const nextCursor = `db-photo:${Buffer.from(JSON.stringify({ generation: 1, ordinal: 0 })).toString('base64url')}`;
    await service.listAlbumPhotos(key, album.albumId, nextCursor);
    expect(materialize).toHaveBeenCalledOnce();
    expect(readChatResource).not.toHaveBeenCalled();
    expect(catalog.savePhoto).not.toHaveBeenCalled();
  });

  it('eventually completes readable reconciliation of 501 and 1001 saved photos', async () => {
    for (const total of [501, 1001]) {
      const photos = Array.from({ length: total }, (_, index) => ({ ...photo, photoId: `photo-${String(index + 1).padStart(4, '0')}`, scanOrdinal: index }));
      const exported = new Set<string>(); let progress = { cursor: -1, sweepFailed: false };
      const canonical = { folderName: createHash('sha256').update(album.albumId).digest('hex'), fileName: 'record_f_saved.jpg',
        contentHash: createHash('sha256').update(new Uint8Array([1, 2, 3])).digest('hex'), byteCount: 3, revision: 1, savedAt: new Date().toISOString() };
      const catalog = {
        getAlbum: vi.fn(async () => album), ensureReadableFolderName: vi.fn(async (_key: ConversationKey, _albumId: string, name: string) => name),
        listSavedPhotosForReadableReconciliation: vi.fn(async (_key: ConversationKey, _albumId: string, cursor: string | null, limit = 50) => {
          const rows = photos.filter((item) => item.scanOrdinal > (cursor === null ? -1 : Number(cursor)));
          const items = rows.slice(0, limit);
          return { items, nextCursor: rows.length > limit ? String(items.at(-1)!.scanOrdinal) : null };
        }),
        savedPhoto: vi.fn(async () => canonical), savePhoto: vi.fn(async () => {}),
        readablePhotoName: vi.fn(async (_key: ConversationKey, _albumId: string, photoId: string) => exported.has(photoId) ? 'LINE_ALBUM_Photos_20231114_0001_aaaaaaaaaa.jpg' : null),
        saveReadablePhotoName: vi.fn(async (_key: ConversationKey, _albumId: string, photoId: string) => { exported.add(photoId); }),
        readableExportState: vi.fn(async () => ({ ...progress })),
        receiverToken: 'catalog-receiver',
        saveReadableExportProgress: vi.fn(async function (this: { receiverToken: string }, _key: ConversationKey, _albumId: string, expectedCursor: number, expectedFailed: boolean, cursor: number, sweepFailed: boolean) {
          expect(this.receiverToken).toBe('catalog-receiver');
          if (progress.cursor !== expectedCursor || progress.sweepFailed !== expectedFailed) throw new Error('progress changed');
          progress = { cursor, sweepFailed };
        }),
        hasPhotosNeedingReadableExport: vi.fn(async () => exported.size < total),
      } as unknown as NonNullable<ChatResourceArchiveDependencies['catalog']>;
      const materialize = vi.fn(async () => ({ unchanged: false }));
      const { service } = await setup({ catalog }, { inspectAlbumPhoto: vi.fn(async () => canonical), ensureReadableAlbumFolder: vi.fn(async () => {}), materializeAlbumPhoto: materialize });

      let result = await service.openReadableAlbumFolder(key, album.albumId);
      expect(result).toMatchObject({ complete: false, failureCodes: ['PAGE_LIMIT'] });
      for (let attempt = 0; attempt < 4 && !result.complete; attempt += 1) result = await service.openReadableAlbumFolder(key, album.albumId);
      expect(result).toMatchObject({ complete: true, failedCount: 0 });
      expect(exported.size).toBe(total);
      expect(materialize).toHaveBeenCalledTimes(total);
      expect(progress).toEqual({ cursor: -1, sweepFailed: false });
    }
  });

  it('advances past early failures and keeps sweep completion false until a later retry succeeds', async () => {
    const total = 501;
    const photos = Array.from({ length: total }, (_, index) => ({ ...photo, photoId: `photo-${String(index + 1).padStart(4, '0')}`, scanOrdinal: index }));
    const exported = new Set<string>(); let progress = { cursor: -1, sweepFailed: false };
    const canonical = { folderName: createHash('sha256').update(album.albumId).digest('hex'), fileName: 'record_f_saved.jpg',
      contentHash: createHash('sha256').update(new Uint8Array([1, 2, 3])).digest('hex'), byteCount: 3, revision: 1, savedAt: new Date().toISOString() };
    const catalog = {
      getAlbum: vi.fn(async () => album), ensureReadableFolderName: vi.fn(async (_key: ConversationKey, _albumId: string, name: string) => name),
      listSavedPhotosForReadableReconciliation: vi.fn(async (_key: ConversationKey, _albumId: string, cursor: string | null, limit = 50) => {
        const rows = photos.filter((item) => item.scanOrdinal > (cursor === null ? -1 : Number(cursor)));
        const items = rows.slice(0, limit);
        return { items, nextCursor: rows.length > limit ? String(items.at(-1)!.scanOrdinal) : null };
      }),
      savedPhoto: vi.fn(async () => canonical), savePhoto: vi.fn(async () => {}),
      readablePhotoName: vi.fn(async (_key: ConversationKey, _albumId: string, photoId: string) => `LINE_ALBUM_Photos_20231114_${String(Number(photoId.slice(-4))).padStart(4, '0')}_${'a'.repeat(10)}.jpg`),
      saveReadablePhotoName: vi.fn(async (_key: ConversationKey, _albumId: string, photoId: string) => { exported.add(photoId); }),
      readableExportState: vi.fn(async () => ({ ...progress })),
      saveReadableExportProgress: vi.fn(async (_key: ConversationKey, _albumId: string, expectedCursor: number, expectedFailed: boolean, cursor: number, sweepFailed: boolean) => {
        if (progress.cursor !== expectedCursor || progress.sweepFailed !== expectedFailed) throw new Error('progress changed');
        progress = { cursor, sweepFailed };
      }),
      hasPhotosNeedingReadableExport: vi.fn(async () => false),
    } as unknown as NonNullable<ChatResourceArchiveDependencies['catalog']>;
    let repaired = false;
    const materialize = vi.fn(async ({ photoId }: { photoId: string }) => {
      if (photoId === 'photo-0001' && !repaired) throw Object.assign(new Error('edited readable file'), { code: 'NO_REPLACE_CONFLICT' });
      return { unchanged: false };
    });
    const { service } = await setup({ catalog }, { inspectAlbumPhoto: vi.fn(async () => canonical), ensureReadableAlbumFolder: vi.fn(async () => {}), materializeAlbumPhoto: materialize });

    const first = await service.openReadableAlbumFolder(key, album.albumId);
    expect(first).toMatchObject({ failedCount: 1, complete: false });
    const tail = await service.openReadableAlbumFolder(key, album.albumId);
    expect(tail).toMatchObject({ exportedCount: 1, complete: false });
    expect(tail.failureCodes).toContain('PENDING_RETRY');
    expect(progress).toEqual({ cursor: -1, sweepFailed: true });
    repaired = true;
    const retryFirst = await service.openReadableAlbumFolder(key, album.albumId);
    expect(retryFirst).toMatchObject({ failedCount: 0, complete: false, failureCodes: ['PAGE_LIMIT'] });
    const retryTail = await service.openReadableAlbumFolder(key, album.albumId);
    expect(retryTail).toMatchObject({ failedCount: 0, complete: true });
    expect(progress).toEqual({ cursor: -1, sweepFailed: false });
  });

  it('serializes concurrent album selection and folder reconciliation against the durable cursor', async () => {
    let progress = { cursor: -1, sweepFailed: false }, attempts = 0;
    const canonical = { folderName: createHash('sha256').update(album.albumId).digest('hex'), fileName: 'record_f_saved.jpg',
      contentHash: createHash('sha256').update(new Uint8Array([1, 2, 3])).digest('hex'), byteCount: 3, revision: 1, savedAt: new Date().toISOString() };
    const catalog = {
      photoScan: vi.fn(async () => ({ complete: true, generation: 1, cursor: null, previousCursor: null, nextOrdinal: 1 })),
      listPhotos: vi.fn(async () => ({ items: [photo], nextCursor: null })),
      getAlbum: vi.fn(async () => album), ensureReadableFolderName: vi.fn(async (_key: ConversationKey, _albumId: string, name: string) => name),
      listSavedPhotosForReadableReconciliation: vi.fn(async () => ({ items: [{ ...photo, scanOrdinal: 0 }], nextCursor: null })),
      savedPhoto: vi.fn(async () => canonical), savePhoto: vi.fn(async () => {}), readablePhotoName: vi.fn(async () => 'LINE_ALBUM_Photos_20231114_0001_0123456789.jpg'),
      saveReadablePhotoName: vi.fn(async () => {}), readableExportState: vi.fn(async () => ({ ...progress })),
      saveReadableExportProgress: vi.fn(async (_key: ConversationKey, _albumId: string, expectedCursor: number, expectedFailed: boolean, cursor: number, sweepFailed: boolean) => {
        if (progress.cursor !== expectedCursor || progress.sweepFailed !== expectedFailed) throw new Error('progress changed');
        progress = { cursor, sweepFailed };
      }), hasPhotosNeedingReadableExport: vi.fn(async () => false),
    } as unknown as NonNullable<ChatResourceArchiveDependencies['catalog']>;
    const materialize = vi.fn(async () => {
      if (++attempts === 1) throw Object.assign(new Error('edited readable file'), { code: 'NO_REPLACE_CONFLICT' });
      return { unchanged: false };
    });
    const { service } = await setup({ catalog }, { inspectAlbumPhoto: vi.fn(async () => canonical), ensureReadableAlbumFolder: vi.fn(async () => {}), materializeAlbumPhoto: materialize });

    const [selection, folder] = await Promise.all([service.listAlbumPhotos(key, album.albumId, null), service.openReadableAlbumFolder(key, album.albumId)]);
    expect(selection).toMatchObject({ photos: [photo] });
    expect(folder).toMatchObject({ exportedCount: 1, failedCount: 0, complete: true });
    expect(materialize).toHaveBeenCalledTimes(2);
    expect(progress).toEqual({ cursor: -1, sweepFailed: false });
  });

  it('revalidates a stored readable filename and reports an edited copy conflict', async () => {
    const canonical = { folderName: createHash('sha256').update(album.albumId).digest('hex'), fileName: 'record_f_saved.jpg',
      contentHash: createHash('sha256').update(new Uint8Array([1, 2, 3])).digest('hex'), byteCount: 3, revision: 1, savedAt: new Date().toISOString() };
    const storedName = 'LINE_ALBUM_Photos_20231114_0001_0123456789.jpg';
    const catalog = {
      getAlbum: vi.fn(async () => album), ensureReadableFolderName: vi.fn(async (_key: ConversationKey, _albumId: string, name: string) => name),
      listSavedPhotosForReadableReconciliation: vi.fn(async () => ({ items: [{ ...photo, scanOrdinal: 0 }], nextCursor: null })),
      savedPhoto: vi.fn(async () => canonical), savePhoto: vi.fn(async () => {}), readablePhotoName: vi.fn(async () => storedName),
      saveReadablePhotoName: vi.fn(async () => {}), readableExportState: vi.fn(async () => ({ cursor: -1, sweepFailed: false })), saveReadableExportProgress: vi.fn(async () => {}),
      hasPhotosNeedingReadableExport: vi.fn(async () => false),
    } as unknown as NonNullable<ChatResourceArchiveDependencies['catalog']>;
    const materialize = vi.fn(async () => { throw Object.assign(new Error('edited readable file'), { code: 'NO_REPLACE_CONFLICT' }); });
    const { service } = await setup({ catalog }, { inspectAlbumPhoto: vi.fn(async () => canonical), ensureReadableAlbumFolder: vi.fn(async () => {}), materializeAlbumPhoto: materialize });

    await expect(service.openReadableAlbumFolder(key, album.albumId)).resolves.toMatchObject({ exportedCount: 0, failedCount: 1, totalCount: 1, complete: false });
    expect(materialize).toHaveBeenCalledWith(expect.objectContaining({ viewFileName: storedName }));
    expect(catalog.saveReadablePhotoName).not.toHaveBeenCalled();
  });

  it('exports newly archived photos after the canonical catalog save without changing saved status on copy failure', async () => {
    const canonical = { folderName: createHash('sha256').update(album.albumId).digest('hex'), fileName: 'record_f_saved.jpg',
      contentHash: createHash('sha256').update(new Uint8Array([1, 2, 3])).digest('hex'), byteCount: 3, revision: 1, savedAt: new Date().toISOString() };
    const catalog = {
      beginPhotoScan: vi.fn(async () => 4), appendPhotoPage: vi.fn(async () => ({ nextOrdinal: 1, complete: true })),
      photoScan: vi.fn(async () => null), savedPhoto: vi.fn(async () => null), savePhoto: vi.fn(async () => {}),
      getAlbum: vi.fn(async () => album), photoWithOrdinal: vi.fn(async () => ({ ...photo, scanOrdinal: 0 })),
      ensureReadableFolderName: vi.fn(async (_key: ConversationKey, _albumId: string, name: string) => name),
      readablePhotoName: vi.fn(async () => null), saveReadablePhotoName: vi.fn(async () => {}),
    } as unknown as NonNullable<ChatResourceArchiveDependencies['catalog']>;
    const { service, store } = await setup({ catalog }, { ensureAlbumFolder: vi.fn(async () => {}), inspectAlbumPhoto: vi.fn(async () => null),
      publishAlbumPhoto: vi.fn(async () => canonical), ensureReadableAlbumFolder: vi.fn(async () => {}),
      materializeAlbumPhoto: vi.fn(async () => { throw Object.assign(new Error('edited readable file'), { code: 'NO_REPLACE_CONFLICT' }); }) });

    await expect(service.openAlbum(key, album.albumId)).resolves.toMatchObject({ savedCount: 1, failedCount: 0, complete: true });
    expect(catalog.savePhoto).toHaveBeenCalledOnce();
    expect(store.materializeAlbumPhoto).toHaveBeenCalledOnce();
    expect(catalog.saveReadablePhotoName).not.toHaveBeenCalled();
  });

  it('materializes a readable copy after an explicit photo download', async () => {
    const canonical = { folderName: createHash('sha256').update(album.albumId).digest('hex'), fileName: 'record_f_saved.jpg',
      contentHash: createHash('sha256').update(new Uint8Array([1, 2, 3])).digest('hex'), byteCount: 3, revision: 1, savedAt: new Date().toISOString() };
    const catalog = {
      savedPhoto: vi.fn(async () => null), savePhoto: vi.fn(async () => {}), getAlbum: vi.fn(async () => album),
      photoWithOrdinal: vi.fn(async () => ({ ...photo, scanOrdinal: 0 })),
      ensureReadableFolderName: vi.fn(async (_key: ConversationKey, _albumId: string, name: string) => name),
      readablePhotoName: vi.fn(async () => null), saveReadablePhotoName: vi.fn(async () => {}),
    } as unknown as NonNullable<ChatResourceArchiveDependencies['catalog']>;
    const materialize = vi.fn(async () => ({ unchanged: false }));
    const { service } = await setup({ catalog }, { inspectAlbumPhoto: vi.fn(async () => null),
      publishAlbumPhoto: vi.fn(async () => canonical), ensureReadableAlbumFolder: vi.fn(async () => {}), materializeAlbumPhoto: materialize });

    await expect(service.downloadAlbumPhoto(key, album.albumId, photo.photoId, photo.oid, photo.prefix)).resolves.toMatchObject({ sizeBytes: 3 });
    expect(catalog.savePhoto).toHaveBeenCalledOnce();
    expect(materialize).toHaveBeenCalledOnce();
    expect(catalog.saveReadablePhotoName).toHaveBeenCalledOnce();
  });

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

  it('serves a preview only when catalog metadata matches the native archive and never asks LINE to download', async () => {
    const bytes = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0, 0, 0, 0, 0]);
    const savedFile = { folderName: createHash('sha256').update(album.albumId).digest('hex'), fileName: 'record_f_saved.jpg',
      contentHash: createHash('sha256').update(bytes).digest('hex'), byteCount: bytes.byteLength, revision: 1, savedAt: new Date().toISOString() };
    const catalog = { savedPhoto: vi.fn(async () => savedFile) } as unknown as NonNullable<ChatResourceArchiveDependencies['catalog']>;
    const readAlbumPhoto = vi.fn(async () => ({ ...savedFile, content: bytes }));
    const { service, readChatResource } = await setup({ catalog }, { readAlbumPhoto });

    await expect(service.readSavedAlbumPhoto(key, album.albumId, photo.photoId)).resolves.toEqual({ bytes, mimeType: 'image/jpeg' });
    expect(catalog.savedPhoto).toHaveBeenCalledWith(key, album.albumId, photo.photoId);
    expect(readAlbumPhoto).toHaveBeenCalledWith(expect.objectContaining({ key, albumId: album.albumId, photoId: photo.photoId }));
    expect(readChatResource).not.toHaveBeenCalled();
  });

  it('rejects a stale catalog file record when reading an album preview', async () => {
    const bytes = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0, 0, 0, 0, 0]);
    const savedFile = { folderName: 'a'.repeat(64), fileName: 'record_f_old.jpg', contentHash: 'b'.repeat(64), byteCount: 100, revision: 1, savedAt: new Date().toISOString() };
    const catalog = { savedPhoto: vi.fn(async () => savedFile) } as unknown as NonNullable<ChatResourceArchiveDependencies['catalog']>;
    const { service, readChatResource } = await setup({ catalog }, { readAlbumPhoto: vi.fn(async () => ({ ...savedFile, content: bytes,
      fileName: 'record_f_replaced.jpg', contentHash: createHash('sha256').update(bytes).digest('hex'), byteCount: bytes.byteLength })) });

    await expect(service.readSavedAlbumPhoto(key, album.albumId, photo.photoId)).resolves.toBeNull();
    expect(readChatResource).not.toHaveBeenCalled();
  });

  it('archives the enabled worker resource actions through the typed store seam', async () => {
    const savedFile = { folderName: createHash('sha256').update(album.albumId).digest('hex'), fileName: 'record_f_saved.jpg',
      contentHash: createHash('sha256').update(new Uint8Array([1, 2, 3])).digest('hex'), byteCount: 3, revision: 1, savedAt: new Date().toISOString() };
    const { service, readChatResource, published, store } = await setup({}, {
      inspectAlbumPhoto: vi.fn(async () => null),
      publishAlbumPhoto: vi.fn(async () => savedFile),
    });
    await service.listAlbums(key, null);
    await service.listAlbumPhotos(key, album.albumId, null);
    const result = await service.downloadAlbumPhoto(key, album.albumId, photo.photoId, photo.oid, photo.prefix);
    const commands = readChatResource.mock.calls.map(([command]) => command);
    expect(commands.map(({ action }) => action)).toEqual(['listAlbums', 'listAlbumPhotos', 'downloadAlbumPhoto']);
    expect(commands[0]).toMatchObject({ transportOwnerId: 'owner-1', transportGeneration: 2, writeGrantVersion: 3 });
    expect(commands[2]).toMatchObject({ prefix: 'album/a', maxBytes: 20 * 1024 * 1024 });
    expect(result).toMatchObject({ photoId: photo.photoId, sizeBytes: 3 });
    expect(published.map(({ kind }) => kind)).toEqual(['album', 'photo-page']);
    expect(store.publishAlbumPhoto).toHaveBeenCalledOnce();
  });

  it('rejects direct Notes service calls without reading LINE', async () => {
    const { service, readChatResource } = await setup();
    await expect(service.listNotes(key, null)).rejects.toThrow('Notes are disabled.');
    await expect(service.getNote(key, noteA.postId)).rejects.toThrow('Notes are disabled.');
    expect(readChatResource).not.toHaveBeenCalled();
    await expect(service.listAlbums(key, null)).resolves.toMatchObject({ albums: expect.any(Array) });
    expect(readChatResource.mock.calls.map(([command]) => command.action)).toEqual(['listAlbums']);
  });

  it('repairs a missing saved-file catalog row from native inspection without reading LINE', async () => {
    const savedFile = { folderName: createHash('sha256').update(album.albumId).digest('hex'), fileName: 'record_f_existing.jpg',
      contentHash: 'a'.repeat(64), byteCount: 23, revision: 4, savedAt: new Date().toISOString() };
    const catalog = { savedPhoto: vi.fn(async () => null), savePhoto: vi.fn(async () => {}) } as unknown as NonNullable<ChatResourceArchiveDependencies['catalog']>;
    const { service, readChatResource, store } = await setup({ catalog }, {
      inspectAlbumPhoto: vi.fn(async () => savedFile),
      publishAlbumPhoto: vi.fn(async () => { throw new Error('existing photo must not be rewritten'); }),
    });

    const result = await service.downloadAlbumPhoto(key, album.albumId, photo.photoId, photo.oid, photo.prefix);

    expect(result).toEqual({ albumId: album.albumId, photoId: photo.photoId, sizeBytes: savedFile.byteCount });
    expect(readChatResource).not.toHaveBeenCalled();
    expect(store.publishAlbumPhoto).not.toHaveBeenCalled();
    expect(catalog.savedPhoto).toHaveBeenCalledWith(key, album.albumId, photo.photoId);
    expect(catalog.savePhoto).toHaveBeenCalledWith(key, album.albumId, photo.photoId, savedFile, expect.objectContaining({ mode: 'ACTIVE_CONTROL' }));
  });

  it('uses an exact catalog file match only after native verification', async () => {
    const savedFile = { folderName: createHash('sha256').update(album.albumId).digest('hex'), fileName: 'record_f_cached.jpg',
      contentHash: 'c'.repeat(64), byteCount: 19, revision: 8, savedAt: new Date().toISOString() };
    const catalog = { savedPhoto: vi.fn(async () => savedFile), savePhoto: vi.fn(async () => {}), clearSavedPhoto: vi.fn(async () => {}) } as unknown as NonNullable<ChatResourceArchiveDependencies['catalog']>;
    const inspectAlbumPhoto = vi.fn(async () => savedFile);
    const { service, readChatResource, store } = await setup({ catalog }, { inspectAlbumPhoto,
      publishAlbumPhoto: vi.fn(async () => { throw new Error('verified existing file must not be rewritten'); }) });

    await expect(service.downloadAlbumPhoto(key, album.albumId, photo.photoId, photo.oid, photo.prefix))
      .resolves.toEqual({ albumId: album.albumId, photoId: photo.photoId, sizeBytes: savedFile.byteCount });
    expect(catalog.savedPhoto).toHaveBeenCalledWith(key, album.albumId, photo.photoId);
    expect(inspectAlbumPhoto).toHaveBeenCalledOnce();
    expect(catalog.savePhoto).not.toHaveBeenCalled();
    expect(catalog.clearSavedPhoto).not.toHaveBeenCalled();
    expect(readChatResource).not.toHaveBeenCalled();
    expect(store.publishAlbumPhoto).not.toHaveBeenCalled();
  });

  it('clears stale saved-file metadata when native inspection finds the file missing', async () => {
    const staleFile = { folderName: createHash('sha256').update(album.albumId).digest('hex'), fileName: 'record_f_stale.jpg',
      contentHash: 'e'.repeat(64), byteCount: 99, revision: 2, savedAt: new Date().toISOString() };
    const repairedFile = { ...staleFile, fileName: 'record_f_repaired.jpg', contentHash: 'f'.repeat(64), byteCount: 3, revision: 3 };
    const catalog = { savedPhoto: vi.fn(async () => staleFile), clearSavedPhoto: vi.fn(async () => {}), savePhoto: vi.fn(async () => {}) } as unknown as NonNullable<ChatResourceArchiveDependencies['catalog']>;
    const inspectAlbumPhoto = vi.fn(async () => null);
    const publishAlbumPhoto = vi.fn(async () => repairedFile);
    const { service, readChatResource } = await setup({ catalog }, { inspectAlbumPhoto, publishAlbumPhoto });

    await expect(service.downloadAlbumPhoto(key, album.albumId, photo.photoId, photo.oid, photo.prefix))
      .resolves.toEqual({ albumId: album.albumId, photoId: photo.photoId, sizeBytes: 3 });
    expect(catalog.clearSavedPhoto).toHaveBeenCalledOnce();
    expect(readChatResource.mock.calls.filter(([command]) => command.action === 'downloadAlbumPhoto')).toHaveLength(1);
    expect(publishAlbumPhoto).toHaveBeenCalledOnce();
    expect(catalog.savePhoto).toHaveBeenCalledWith(key, album.albumId, photo.photoId, repairedFile, expect.anything());
  });

  it('repairs the catalog after native commit when the database write failed', async () => {
    const savedFile = { folderName: createHash('sha256').update(album.albumId).digest('hex'), fileName: 'record_f_committed.jpg',
      contentHash: createHash('sha256').update(new Uint8Array([1, 2, 3])).digest('hex'), byteCount: 3, revision: 1, savedAt: new Date().toISOString() };
    const catalog = { savedPhoto: vi.fn(async () => null), clearSavedPhoto: vi.fn(async () => {}),
      savePhoto: vi.fn().mockRejectedValueOnce(new Error('database unavailable')).mockResolvedValue(undefined) } as unknown as NonNullable<ChatResourceArchiveDependencies['catalog']>;
    const inspectAlbumPhoto = vi.fn().mockResolvedValueOnce(null).mockResolvedValue(savedFile);
    const publishAlbumPhoto = vi.fn(async () => savedFile);
    const { service, readChatResource } = await setup({ catalog }, { inspectAlbumPhoto, publishAlbumPhoto });

    await expect(service.downloadAlbumPhoto(key, album.albumId, photo.photoId, photo.oid, photo.prefix)).rejects.toThrow('database unavailable');
    await expect(service.downloadAlbumPhoto(key, album.albumId, photo.photoId, photo.oid, photo.prefix))
      .resolves.toEqual({ albumId: album.albumId, photoId: photo.photoId, sizeBytes: savedFile.byteCount });

    expect(readChatResource.mock.calls.filter(([command]) => command.action === 'downloadAlbumPhoto')).toHaveLength(1);
    expect(publishAlbumPhoto).toHaveBeenCalledOnce();
    expect(catalog.savePhoto).toHaveBeenCalledTimes(2);
  });

  it('serves a complete cached album scan repeatedly and refreshes only on request', async () => {
    const cachedAlbum = { ...album, title: 'Cached title' };
    let scanState = { complete: true, generation: 3, cursor: null as string | null, previousCursor: null as string | null, nextOrdinal: 1 };
    const catalog = {
      albumScan: vi.fn(async () => ({ complete: scanState.complete, generation: scanState.generation })),
      albumScanState: vi.fn(async () => scanState),
      listAlbums: vi.fn(async () => ({ items: [cachedAlbum], nextCursor: null })),
      beginAlbumScan: vi.fn(async () => { scanState = { complete: false, generation: scanState.generation + 1, cursor: null, previousCursor: null, nextOrdinal: 0 }; return scanState.generation; }),
      appendAlbumPage: vi.fn(async (_key: ConversationKey, generation: number, _expected: string | null, _albums: readonly unknown[], next: string | null) => {
        scanState = { complete: next === null, generation, cursor: next, previousCursor: null, nextOrdinal: 1 };
        return { complete: next === null, nextOrdinal: 1 };
      }),
      upsertAlbums: vi.fn(async () => {}), completeAlbumScan: vi.fn(async () => {}),
    } as unknown as NonNullable<ChatResourceArchiveDependencies['catalog']>;
    const { service, readChatResource } = await setup({ catalog });

    await expect(service.listAlbums(key, null)).resolves.toMatchObject({ albums: [cachedAlbum], nextCursor: null });
    await expect(service.listAlbums(key, null)).resolves.toMatchObject({ albums: [cachedAlbum], nextCursor: null });
    expect(readChatResource).not.toHaveBeenCalled();
    expect(catalog.listAlbums).toHaveBeenCalledTimes(2);

    await service.listAlbums(key, null, undefined, 'modal', undefined, true);
    expect(readChatResource.mock.calls.map(([command]) => command.action)).toEqual(['listAlbums']);
    expect(catalog.appendAlbumPage).toHaveBeenCalledOnce();
  });

  it('resumes an uncached 501-photo list from saved LINE cursor progress without downloading photos', async () => {
    const rows = Array.from({ length: 501 }, (_, index) => ({ ...photo, photoId: index === 500 ? 'a-tail' : `z-${String(index).padStart(3, '0')}`, oid: `oid-${index}` }));
    let scan = { complete: false, generation: 0, cursor: null as string | null, previousCursor: null as string | null, nextOrdinal: 0 };
    const catalogRows: Array<(typeof rows)[number]> = [];
    const catalog = {
      photoScan: vi.fn(async () => scan),
      beginPhotoScan: vi.fn(async () => { scan = { complete: false, generation: scan.generation + 1, cursor: null, previousCursor: null, nextOrdinal: 0 }; return scan.generation; }),
      appendPhotoPage: vi.fn(async (_key: ConversationKey, _albumId: string, generation: number, expected: string | null, photos: readonly (typeof rows)[number][], next: string | null) => {
        if (scan.cursor !== expected) throw new Error('stale expected cursor');
        catalogRows.push(...photos);
        scan = { complete: next === null, generation, cursor: next, previousCursor: expected, nextOrdinal: scan.nextOrdinal + photos.length };
        return { complete: scan.complete, nextOrdinal: scan.nextOrdinal };
      }),
      listPhotos: vi.fn(async (_key: ConversationKey, _albumId: string, after: string | null, limit = 50) => {
        const afterOrdinal = after === null ? -1 : Number(after);
        const remaining = catalogRows.filter((_, ordinal) => ordinal > afterOrdinal);
        const page = remaining.slice(0, limit);
        return { items: page, nextCursor: remaining.length > limit ? String(afterOrdinal + page.length) : null };
      }),
    } as unknown as NonNullable<ChatResourceArchiveDependencies['catalog']>;
    const readChatResource = vi.fn(async (command: ChatResourceRequest) => {
      if (command.action !== 'listAlbumPhotos') throw new Error(`Unexpected modal action: ${command.action}`);
      const pageIndex = command.cursor === undefined ? 0 : Number(command.cursor.slice('page-'.length));
      const pageRows = rows.slice(pageIndex * 50, (pageIndex + 1) * 50);
      return { type: 'chatResourceResult' as const, requestId: command.requestId, action: command.action, ok: true,
        accountId: command.accountId, workerInstanceId: command.workerInstanceId, controlEpoch: command.controlEpoch,
        chatType: command.chatType, chatId: command.chatId, photos: pageRows,
        nextCursor: (pageIndex + 1) * 50 < rows.length ? `page-${pageIndex + 1}` : null } as ChatResourceReadResult;
    });
    const { service } = await setup({ catalog, readChatResource });

    const displayed = new Set<string>();
    let cursor: string | null = null;
    do {
      const page = await service.listAlbumPhotos(key, album.albumId, cursor);
      for (const item of page.photos) displayed.add(item.photoId);
      cursor = page.nextCursor;
    } while (cursor !== null && displayed.size <= 501);

    expect(displayed.size).toBe(501);
    expect(readChatResource.mock.calls.filter(([command]) => command.action === 'listAlbumPhotos')).toHaveLength(11);
    expect(readChatResource.mock.calls.every(([command]) => command.action === 'listAlbumPhotos')).toBe(true);
    expect(scan).toEqual({ complete: true, generation: 1, cursor: null, previousCursor: 'page-10', nextOrdinal: 501 });
    expect(catalog.beginPhotoScan).toHaveBeenCalledOnce();
    await service.listAlbumPhotos(key, album.albumId, null);
    expect(readChatResource).toHaveBeenCalledTimes(11);
  });

  it('pages an uncached 501-album list in source order and then serves it from cache', async () => {
    const rows = Array.from({ length: 501 }, (_, index) => ({ ...album, albumId: `album-${String(500 - index).padStart(3, '0')}` }));
    let scan = { complete: false, generation: 0, cursor: null as string | null, previousCursor: null as string | null, nextOrdinal: 0 };
    const imported: typeof rows = [];
    const catalog = {
      albumScan: vi.fn(async () => ({ complete: scan.complete, generation: scan.generation })),
      albumScanState: vi.fn(async () => scan),
      beginAlbumScan: vi.fn(async () => { scan = { complete: false, generation: scan.generation + 1, cursor: null, previousCursor: null, nextOrdinal: 0 }; return scan.generation; }),
      appendAlbumPage: vi.fn(async (_key: ConversationKey, generation: number, expected: string | null, page: readonly typeof rows[number][], next: string | null) => {
        if (scan.cursor !== expected) throw new Error('stale expected cursor');
        imported.push(...page);
        scan = { complete: next === null, generation, cursor: next, previousCursor: expected, nextOrdinal: scan.nextOrdinal + page.length };
        return { nextOrdinal: scan.nextOrdinal, complete: scan.complete };
      }),
      listAlbums: vi.fn(async (_key: ConversationKey, after: string | null, limit = 50) => {
        const ordinal = after === null ? -1 : Number(after);
        const remaining = imported.filter((_, index) => index > ordinal);
        const items = remaining.slice(0, limit);
        return { items, nextCursor: remaining.length > limit ? String(ordinal + items.length) : null };
      }),
    } as unknown as NonNullable<ChatResourceArchiveDependencies['catalog']>;
    const readChatResource = vi.fn(async (command: ChatResourceRequest) => {
      if (command.action !== 'listAlbums') throw new Error(`Unexpected modal action: ${command.action}`);
      const pageIndex = command.cursor == null ? 0 : Number(command.cursor.slice('albums-'.length));
      const page = rows.slice(pageIndex * 50, (pageIndex + 1) * 50);
      return { type: 'chatResourceResult' as const, requestId: command.requestId, action: command.action, ok: true,
        accountId: command.accountId, workerInstanceId: command.workerInstanceId, controlEpoch: command.controlEpoch,
        chatType: command.chatType, chatId: command.chatId, albums: page,
        nextCursor: (pageIndex + 1) * 50 < rows.length ? `albums-${pageIndex + 1}` : null } as ChatResourceReadResult;
    });
    const { service } = await setup({ catalog, readChatResource });
    const displayed: string[] = [];
    let cursor: string | null = null;
    do {
      const page = await service.listAlbums(key, cursor);
      displayed.push(...page.albums.map(({ albumId }) => albumId));
      cursor = page.nextCursor;
    } while (cursor);
    expect(displayed).toEqual(rows.map(({ albumId }) => albumId));
    expect(readChatResource).toHaveBeenCalledTimes(11);
    await service.listAlbums(key, null);
    expect(readChatResource).toHaveBeenCalledTimes(11);
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

  it('keeps an archival tail on the completed modal photo generation', async () => {
    const file = { folderName: createHash('sha256').update(album.albumId).digest('hex'), fileName: 'record_f_tail.jpg',
      contentHash: createHash('sha256').update(new Uint8Array([1])).digest('hex'), byteCount: 1, revision: 1, savedAt: new Date().toISOString() };
    const catalog = {
      photoScan: vi.fn(async () => ({ complete: true, generation: 7, cursor: null, previousCursor: 'page-tail', nextOrdinal: 10 })),
      beginPhotoScan: vi.fn(async () => 8), appendPhotoPage: vi.fn(async () => ({ nextOrdinal: 11, complete: true })), upsertPhotos: vi.fn(async () => {}),
      advancePhotoScan: vi.fn(async () => {}), savedPhoto: vi.fn(async () => null), savePhoto: vi.fn(async () => {}),
    } as unknown as NonNullable<ChatResourceArchiveDependencies['catalog']>;
    const readChatResource = vi.fn(async (command: ChatResourceRequest) => command.action === 'listAlbumPhotos'
      ? { type: 'chatResourceResult' as const, requestId: command.requestId, action: command.action, ok: true,
        accountId: command.accountId, workerInstanceId: command.workerInstanceId, controlEpoch: command.controlEpoch,
        chatType: command.chatType, chatId: command.chatId, photos: [photo], nextCursor: null } as ChatResourceReadResult
      : { type: 'chatResourceResult' as const, requestId: command.requestId, action: command.action, ok: true,
        accountId: command.accountId, workerInstanceId: command.workerInstanceId, controlEpoch: command.controlEpoch,
        chatType: command.chatType, chatId: command.chatId, bytes: new Uint8Array([1]) } as ChatResourceReadResult);
    const { service } = await setup({ catalog, readChatResource }, {
      ensureAlbumFolder: vi.fn(async () => {}), inspectAlbumPhoto: vi.fn(async () => null),
      publishAlbumPhoto: vi.fn(async () => file),
    });

    await service.openAlbum(key, album.albumId, undefined, 'notification', undefined, 'page-tail', 0);

    expect(catalog.photoScan).toHaveBeenCalledWith(key, album.albumId);
    expect(catalog.beginPhotoScan).not.toHaveBeenCalled();
    expect(catalog.appendPhotoPage).toHaveBeenCalledWith(key, album.albumId, 7, 'page-tail', [photo], null, expect.anything());
    expect(catalog.savePhoto).toHaveBeenCalledWith(key, album.albumId, photo.photoId, file, expect.anything());
  });

  it('resumes an archival page-limit continuation on its original incomplete scan generation', async () => {
    const photos = Array.from({ length: 501 }, (_, index) => ({ ...photo, photoId: `resume-${String(index).padStart(3, '0')}`, oid: `resume-oid-${index}` }));
    const file = { folderName: createHash('sha256').update(album.albumId).digest('hex'), fileName: 'record_f_saved.jpg',
      contentHash: 'd'.repeat(64), byteCount: 1, revision: 1, savedAt: new Date().toISOString() };
    let scan = { complete: false, generation: 0, cursor: null as string | null, previousCursor: null as string | null, nextOrdinal: 0 };
    const catalog = {
      photoScan: vi.fn(async () => scan),
      beginPhotoScan: vi.fn(async () => { scan = { complete: false, generation: scan.generation + 1, cursor: null, previousCursor: null, nextOrdinal: 0 }; return scan.generation; }),
      appendPhotoPage: vi.fn(async (_key: ConversationKey, _albumId: string, generation: number, expected: string | null, rows: readonly unknown[], cursor: string | null) => {
        if (scan.cursor !== expected) throw new Error('stale expected cursor');
        scan = { complete: cursor === null, generation, cursor, previousCursor: expected, nextOrdinal: scan.nextOrdinal + rows.length };
        return { complete: scan.complete, nextOrdinal: scan.nextOrdinal };
      }),
      savedPhoto: vi.fn(async () => file), savePhoto: vi.fn(async () => {}),
    } as unknown as NonNullable<ChatResourceArchiveDependencies['catalog']>;
    const readChatResource = vi.fn(async (command: ChatResourceRequest) => {
      if (command.action !== 'listAlbumPhotos') throw new Error(`Unexpected automatic action: ${command.action}`);
      const pageIndex = command.cursor === undefined ? 0 : Number(command.cursor.slice('page-'.length));
      return { type: 'chatResourceResult' as const, requestId: command.requestId, action: command.action, ok: true,
        accountId: command.accountId, workerInstanceId: command.workerInstanceId, controlEpoch: command.controlEpoch,
        chatType: command.chatType, chatId: command.chatId, photos: photos.slice(pageIndex * 50, (pageIndex + 1) * 50),
        nextCursor: (pageIndex + 1) * 50 < photos.length ? `page-${pageIndex + 1}` : null } as ChatResourceReadResult;
    });
    const { service } = await setup({ catalog, readChatResource }, { ensureAlbumFolder: vi.fn(async () => {}),
      inspectAlbumPhoto: vi.fn(async () => file), publishAlbumPhoto: vi.fn(async () => file) });

    const first = await service.openAlbum(key, album.albumId, undefined, 'notification');
    expect(first).toMatchObject({ complete: false, errorCode: 'PAGE_LIMIT', nextCursor: 'page-10' });
    expect(scan).toMatchObject({ complete: false, generation: 1, cursor: 'page-10', nextOrdinal: 500 });
    const resumed = await service.openAlbum(key, album.albumId, undefined, 'notification', undefined, first.nextCursor, first.nextPhotoIndex);

    expect(resumed).toMatchObject({ complete: true, errorCode: null });
    expect(scan).toMatchObject({ complete: true, generation: 1, cursor: null, previousCursor: 'page-10', nextOrdinal: 501 });
    expect(catalog.beginPhotoScan).toHaveBeenCalledOnce();
    expect(readChatResource.mock.calls.map(([command]) => command.cursor ?? null).filter((cursor) => cursor !== null))
      .toEqual(['page-1', 'page-2', 'page-3', 'page-4', 'page-5', 'page-6', 'page-7', 'page-8', 'page-9', 'page-10']);
    expect(readChatResource.mock.calls.some(([command]) => command.action === 'downloadAlbumPhoto')).toBe(false);
  });

  it('keeps a repeated nonterminal photo cursor as an incomplete archive failure', async () => {
    const secondPage = { ...photo, photoId: 'photo-two', oid: 'oid-two' };
    const pages: Array<{ cursor: string | null; photos: typeof photo[]; nextCursor: string | null }> = [
      { cursor: null, photos: [photo], nextCursor: 'page-2' },
      { cursor: 'page-2', photos: [secondPage], nextCursor: 'page-2' },
    ];
    const worker = vi.fn(async (command: Parameters<ChatResourceArchiveDependencies['readChatResource']>[0]) => {
      if (command.action === 'listAlbumPhotos') {
        const page = pages.find(({ cursor }) => cursor === (command.cursor ?? null))!;
        return { type: 'chatResourceResult' as const, requestId: command.requestId, action: command.action, ok: true,
          accountId: command.accountId, workerInstanceId: command.workerInstanceId, controlEpoch: command.controlEpoch,
          chatType: command.chatType, chatId: command.chatId, photos: page.photos, nextCursor: page.nextCursor } as ChatResourceReadResult;
      }
      return { type: 'chatResourceResult' as const, requestId: command.requestId, action: command.action, ok: true,
        accountId: command.accountId, workerInstanceId: command.workerInstanceId, controlEpoch: command.controlEpoch,
        chatType: command.chatType, chatId: command.chatId, bytes: new Uint8Array([1]) } as ChatResourceReadResult;
    });
    const published: string[] = [];
    const { service } = await setup({ readChatResource: worker }, {
      ensureAlbumFolder: vi.fn(async () => {}),
      publishAlbumPhoto: vi.fn(async ({ photoId }: { photoId: string }) => { published.push(photoId); }),
    });

    const result = await service.openAlbum(key, album.albumId);

    expect(result).toMatchObject({ savedCount: 2, failedCount: 0, complete: false, errorCode: 'CURSOR_LOOP' });
    expect(published).toEqual([photo.photoId, secondPage.photoId]);
    expect(worker.mock.calls.filter(([command]) => command.action === 'listAlbumPhotos').map(([command]) => command.cursor ?? null))
      .toEqual([null, 'page-2']);
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
      failureCodes: ['LINE_READ_FAILED'], failureContext: { action: 'photo_download', stage: 'resource_read', code: 'ALBUM_RECONCILIATION_FAILED' } });
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

  it('keeps album-list, photo-download, and pagination failure summaries distinct', async () => {
    const diagnostics: unknown[] = [];
    const { service } = await setup({ recordDiagnostic: (record) => diagnostics.push(record) });
    service.recordNotificationFailure(key, new AlbumArchiveFailure({ action: 'album_list', stage: 'resource_read', code: 'ALBUM_RECONCILIATION_FAILED' }));
    service.recordNotificationFailure(key, new AlbumArchiveFailure({ action: 'photo_download', stage: 'resource_read', code: 'ALBUM_RECONCILIATION_FAILED' }));
    service.recordNotificationFailure(key, new AlbumArchiveFailure({ action: 'album_photos', stage: 'pagination', code: 'ALBUM_PHOTO_CURSOR_LOOP' }));
    expect(diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({ action: 'album_list', failureStage: 'resource_read', failureReason: 'worker_response_error' }),
      expect.objectContaining({ action: 'photo_download', failureStage: 'resource_read', failureReason: 'worker_response_error' }),
      expect.objectContaining({ action: 'album_photos', failureStage: 'photo_pagination', failureReason: 'cursor_loop' }),
    ]));
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

  integrationTest('replays the byte-limited page into the catalog before continuing later archive pages', async () => {
    const { pool, close } = await createTestDatabase();
    try {
      await pool.query("UPDATE account_control SET control_epoch=1 WHERE singleton=true");
      await pool.query("INSERT INTO line_accounts(account_id,mode,worker_instance_id,worker_binding_epoch) VALUES($1,'ACTIVE_CONTROL','worker-1',1)", [key.accountId]);
      const catalog = new ChatAlbumCatalogRepository(pool);
      const listGeneration = await catalog.beginAlbumScan(key, { workerInstanceId: 'worker-1', controlEpoch: 1, mode: 'ACTIVE_CONTROL' });
      await catalog.appendAlbumPage(key, listGeneration, null, [album], null,
        { workerInstanceId: 'worker-1', controlEpoch: 1, mode: 'ACTIVE_CONTROL' });

      const a = { ...photo, photoId: 'photo-a', oid: 'oid-a' };
      const b = { ...photo, photoId: 'photo-b', oid: 'oid-b' };
      const c = { ...photo, photoId: 'photo-c', oid: 'oid-c' };
      const d = { ...photo, photoId: 'photo-d', oid: 'oid-d' };
      const byteReads: string[] = [];
      const physicalFiles = new Map<string, { folderName: string; fileName: string; contentHash: string; byteCount: number; revision: number; savedAt: string }>();
      const { service } = await setup({ catalog, albumOpenByteLimit: 4, readChatResource: async (command) => {
        if (command.action === 'listAlbumPhotos') {
          const rows = command.cursor == null ? [a] : command.cursor === 'p1' ? [b, c] : [d];
          const nextCursor = command.cursor == null ? 'p1' : command.cursor === 'p1' ? 'p2' : null;
          return { type: 'chatResourceResult', requestId: command.requestId, action: command.action, ok: true, accountId: command.accountId,
            workerInstanceId: command.workerInstanceId, controlEpoch: command.controlEpoch, chatType: command.chatType, chatId: command.chatId,
            photos: rows, nextCursor } as ChatResourceReadResult;
        }
        if (command.action === 'downloadAlbumPhoto') {
          byteReads.push(command.photoId!);
          const size = command.photoId === 'photo-a' || command.photoId === 'photo-b' ? 2 : 1;
          return { type: 'chatResourceResult', requestId: command.requestId, action: command.action, ok: true, accountId: command.accountId,
            workerInstanceId: command.workerInstanceId, controlEpoch: command.controlEpoch, chatType: command.chatType, chatId: command.chatId,
            bytes: new Uint8Array(size) } as ChatResourceReadResult;
        }
        throw new Error(`Unexpected action ${command.action}`);
      } }, { ensureAlbumFolder: vi.fn(async () => {}),
        inspectAlbumPhoto: vi.fn(async ({ photoId }: { photoId: string }) => physicalFiles.get(photoId) ?? null),
        publishAlbumPhoto: vi.fn(async ({ photoId, content }: { photoId: string; content: Uint8Array }) => {
          const saved = { folderName: 'a'.repeat(64), fileName: `record_f_${photoId}.jpg`, contentHash: createHash('sha256').update(content).digest('hex'),
            byteCount: content.byteLength, revision: 1, savedAt: new Date().toISOString() };
          physicalFiles.set(photoId, saved);
          return saved;
        }) });

      const first = await service.openAlbum(key, album.albumId, undefined, 'notification');
      expect(first).toMatchObject({ complete: false, errorCode: 'BYTE_LIMIT', nextCursor: 'p1', nextPhotoIndex: 1, savedCount: 2 });
      const resumed = await service.openAlbum(key, album.albumId, undefined, 'notification', undefined, first.nextCursor, first.nextPhotoIndex);
      expect(resumed).toMatchObject({ complete: true, errorCode: null, savedCount: 2 });
      expect(byteReads).toEqual(['photo-a', 'photo-b', 'photo-c', 'photo-d']);
      expect((await catalog.listPhotos(key, album.albumId, null, 50)).items.map(({ photoId }) => photoId)).toEqual(['photo-a', 'photo-b', 'photo-c', 'photo-d']);
      await expect(catalog.photoScan(key, album.albumId)).resolves.toMatchObject({ complete: true, cursor: null, nextOrdinal: 4 });
      await service.shutdown();
    } finally { await close(); }
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
    await expect(service.listAlbums(key, null)).rejects.toThrow('read-only');
    expect(readChatResource).not.toHaveBeenCalled();
    const invalid = await setup({ conversationExists: async () => false });
    await expect(invalid.service.listAlbums(key, null)).rejects.toThrow('conversation');
    expect(invalid.readChatResource).not.toHaveBeenCalled();
  });

  it('records only fixed gateway failure categories for Album live reads', async () => {
    const records: unknown[] = [];
    const { service } = await setup({
      readChatResource: async () => { throw Object.assign(new Error('account credential secret and chat body'), { diagnostic: {
        stage: 'gateway_admission', reason: 'stale_binding', currentBindingMatch: false, currentEpochMatch: true, workerReady: true,
      } }); },
      recordDiagnostic: (record) => records.push(record),
    });
    await expect(service.listAlbums(key, null)).rejects.toThrow('account credential secret');
    expect(records).toHaveLength(1);
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
    await expect(folderFailure.service.openAlbum(key, album.albumId, undefined, 'notification')).rejects.toMatchObject({ failureContext: {
      action: 'album_photos', stage: 'archive_write', code: 'ALBUM_ARCHIVE_INCOMPLETE',
    } });
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
    await expect(service.listAlbums(key, null)).rejects.toThrow('temporarily unavailable');
    expect(records[0]).toMatchObject({ errorCode: 'UNKNOWN', failureStage: 'resource_read', failureReason: 'unknown' });
  });

  it('records a safe worker category while keeping the generic read failure', async () => {
    const records: unknown[] = [];
    const { service } = await setup({ readChatResource: async (command) => ({ type: 'chatResourceResult',
      requestId: command.requestId, action: command.action, accountId: key.accountId, workerInstanceId: 'worker-1', controlEpoch: 1,
      chatType: key.chatType, chatId: key.chatId, ok: false, error: 'normalization_failure' }),
      recordDiagnostic: (record) => records.push(record) });
    await expect(service.listAlbums(key, null)).rejects.toThrow('LINE_READ_FAILED');
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

  it('preserves existing Note archive records while Note service reads are disabled', async () => {
    const { service, readChatResource, store } = await setup();
    const content = Buffer.from('existing archived note');
    const controller = new AbortController();
    await store.publish({ key, kind: 'note', resourceId: noteA.postId, content, signal: controller.signal, guard() {} });
    await expect(service.listNotes(key, null)).rejects.toThrow('Notes are disabled.');
    await expect(service.getNote(key, noteA.postId)).rejects.toThrow('Notes are disabled.');
    const saved = await store.read({ key, kind: 'note', resourceId: noteA.postId });
    expect(saved && Buffer.from(saved.content).toString()).toBe('existing archived note');
    expect(readChatResource).not.toHaveBeenCalled();
  });

  it('closes account admission on invalidation until the facade confirms authenticated readiness', async () => {
    const { service, readChatResource, published } = await setup();
    service.invalidateAccount(key.accountId, 'logout');
    await expect(service.listAlbums(key, null)).rejects.toThrow('archive is closed');
    expect(readChatResource).not.toHaveBeenCalled();
    service.reopenAccount(key.accountId);
    await expect(service.listAlbums(key, null)).resolves.toMatchObject({ albums: [expect.objectContaining({ albumId: album.albumId })] });
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
    await expect(service.listAlbums(key, null)).rejects.toThrow('archive is closed');
    expect(readChatResource).not.toHaveBeenCalled();
    expect(teardownFinished).toBe(false);
    finishTeardown();
    await teardown;

    const fresh = { accountId: key.accountId, workerInstanceId: 'worker-2', controlEpoch: 2, transportOwnerId: 'owner-2',
      transportGeneration: 3, writeGrantVersion: 4, mode: 'ACTIVE_CONTROL' } as const;
    admission.authenticated({ ...fresh, workerInstanceId: 'worker-1', controlEpoch: 1 });
    await expect(service.listAlbums(key, null)).rejects.toThrow('archive is closed');
    admission.authenticated(fresh);
    await expect(service.listAlbums(key, null)).rejects.toThrow('archive is closed');
    admission.observeBinding(fresh);
    admission.authenticated(fresh);
    setBinding(fresh);
    admission.ready(fresh);
    await expect(service.listAlbums(key, null)).rejects.toThrow('archive is closed');
    expect(readChatResource).not.toHaveBeenCalled();

    ready = true;
    admission.ready(fresh);
    await expect(service.listAlbums(key, null)).resolves.toMatchObject({ albums: [expect.objectContaining({ albumId: album.albumId })] });
    expect(readChatResource).toHaveBeenCalledOnce();
    expect(published).toHaveLength(1);
  });

  it('fails closed before LINE when no native store was injected', async () => {
    const { deps, readChatResource } = await setup();
    const withoutStore = { ...deps };
    delete withoutStore.store;
    const noStore = new ChatResourceArchiveService(withoutStore);
    services.add(noStore);
    await expect(noStore.listAlbums(key, null)).rejects.toThrow('CHAT_RESOURCE_STORE_UNAVAILABLE');
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

  it('rejects disabled Note IPC actions without reading LINE and keeps Album reads available', async () => {
    const { service, readChatResource } = await setup({}, {
      inspectAlbumPhoto: vi.fn(async () => null),
      publishAlbumPhoto: vi.fn(async () => ({ folderName: createHash('sha256').update(album.albumId).digest('hex'),
        fileName: 'record_f_saved.jpg', contentHash: createHash('sha256').update(new Uint8Array([1, 2, 3])).digest('hex'),
        byteCount: 3, revision: 1, savedAt: new Date().toISOString() })),
    });
    const base = { accountId: key.accountId, chatType: key.chatType, chatId: key.chatId };
    await expect(service.dispatchIpc({ ...base, requestId: 'renderer-list-notes', type: 'listChatNotes', cursor: null })).rejects.toThrow('Notes are disabled.');
    await expect(service.dispatchIpc({ ...base, requestId: 'renderer-get-note', type: 'getChatNote', postId: noteA.postId })).rejects.toThrow('Notes are disabled.');
    await service.dispatchIpc({ ...base, requestId: 'renderer-list-albums', type: 'listChatAlbums', cursor: null });
    await service.dispatchIpc({ ...base, requestId: 'renderer-list-photos', type: 'listChatAlbumPhotos', albumId: album.albumId, cursor: null });
    await service.dispatchIpc({ ...base, requestId: 'renderer-download-photo', type: 'downloadChatAlbumPhoto', albumId: album.albumId, photoId: photo.photoId, oid: photo.oid, prefix: photo.prefix });
    const commands = readChatResource.mock.calls.map(([command]) => command);
    expect(commands).toHaveLength(3);
    for (const command of commands) {
      expect(command).toMatchObject({ type: 'chatResourceRead', accountId: key.accountId, chatType: key.chatType, chatId: key.chatId,
        workerInstanceId: 'worker-1', controlEpoch: 1 });
      expect(command.requestId).not.toMatch(/^renderer-/);
    }
  });

  it('rejects disabled Note IPC actions even when a caller signal is provided', async () => {
    const { service, readChatResource, published } = await setup({ readChatResource: (_command, signal) => new Promise((resolve, reject) => {
      signal?.addEventListener('abort', () => reject(signal.reason), { once: true });
    }) });
    const controller = new AbortController();
    const request = service.dispatchIpc({ ...key, requestId: 'cancel-read', type: 'listChatNotes', cursor: null }, controller.signal);
    await expect(request).rejects.toThrow('Notes are disabled.');
    expect(readChatResource).not.toHaveBeenCalled();
    expect(published).toHaveLength(0);
  });

  it('does not publish a late download response after its request is cancelled', async () => {
    let release!: (result: ChatResourceReadResult) => void;
    const { service, published, readChatResource } = await setup({ readChatResource: (command) => new Promise((resolve) => { release = resolve; }) }, {
      inspectAlbumPhoto: vi.fn(async () => null),
      publishAlbumPhoto: vi.fn(async () => ({ folderName: createHash('sha256').update(album.albumId).digest('hex'),
        fileName: 'record_f_saved.jpg', contentHash: createHash('sha256').update(new Uint8Array([1])).digest('hex'),
        byteCount: 1, revision: 1, savedAt: new Date().toISOString() })),
    });
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
    const operation = service.listAlbums(key, null);
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
    const operation = service.listAlbums(key, null);
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
    const operation = service.listAlbums(key, null);
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
    const operation = service.listAlbums(key, null);
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
    const { service, readChatResource, store } = await setup();
    await store.publish({ key, kind: 'note', resourceId: noteA.postId, content: Buffer.from('existing archive'),
      signal: new AbortController().signal, guard() {} });
    await expect(service.listNotes(key, null)).rejects.toThrow('Notes are disabled.');
    await expect(service.getNote(key, noteA.postId)).rejects.toThrow('Notes are disabled.');
    const archived = await store.read({ key, kind: 'note', resourceId: noteA.postId });
    expect(archived && Buffer.from(archived.content).toString()).toBe('existing archive');
    expect(readChatResource).not.toHaveBeenCalled();
  });

  it('rejects stale worker responses and caller cancellation', async () => {
    const { service } = await setup({ readChatResource: async (command) => ({
      type: 'chatResourceResult', requestId: command.requestId, action: command.action, ok: true,
      accountId: command.accountId, workerInstanceId: command.workerInstanceId, controlEpoch: command.controlEpoch,
      chatType: command.chatType, chatId: 'other-chat', albums: [], nextCursor: null,
    } as ChatResourceReadResult) });
    await expect(service.listAlbums(key, null)).rejects.toThrow('Invalid LINE resource response');
    const controller = new AbortController(); controller.abort(new Error('cancelled'));
    await expect(service.listAlbums(key, null, controller.signal)).rejects.toThrow('cancelled');
  });

  it('does not refresh Notes from background notifications', async () => {
    const { service, readChatResource } = await setup();
    await service.refreshNotesFromNotification(key);
    expect(readChatResource).not.toHaveBeenCalled();
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
