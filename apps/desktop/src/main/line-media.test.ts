import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, readdir, rename, rm, stat, utimes, writeFile, open } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { LineMediaService } from './line-media.js';

/* Mechanical port of 637d068:apps/desktop/src/main/line-media.test.ts.
 * "issue a capability → handle(capabilityUrl)" became "handle(service.<kind>Source(...))": the fixed
 * line-media:// URL is parsed and resolved from the database by connected-facade.ts, and these sources are
 * exactly what that resolver passes to LineMediaService.handle. Every old test is listed exactly once.
 *
 *  1. serves an allowlisted remote image through an opaque short-lived capability
 *     → serves an allowlisted remote image through a fixed source
 *  2. rejects unsafe sources, non-image responses, and forged capability viewers
 *     → rejects unsafe sources and non-image responses (forged-viewer assertion deleted: viewer binding removed)
 *  3. binds ready image attachments to the full conversation scope and revokes them
 *     → binds ready image attachments to the full conversation scope (revoke assertion deleted: revocation removed)
 *  4. releases attachment capabilities across more than 256 consecutive inline images
 *     → serves more than 256 consecutive inline attachment images (revoke calls deleted: revocation removed)
 *  5. expires and bounds capabilities without background cleanup timers
 *     → deleted: capability TTL and the capability table bound were removed; the no-expiry property is the new
 *       test "keeps the same source usable after ten minutes"
 *  6. accepts OBS picture origin and rejects lookalikes, HTTP, and userinfo
 *     → accepts OBS picture origin and rejects lookalikes, HTTP, and userinfo
 *  7. cancels in-flight image reads and never follows a redirect outside LINE origins
 *     → cancels in-flight image reads and never follows a redirect outside LINE origins
 *  8. keeps a shared download alive when one reader aborts and cancels only the reader that aborts
 *     → keeps a shared download alive when one reader aborts and cancels only the reader that aborts
 *  9. lets the first reader finish when a later reader aborts the shared wait
 *     → lets the first reader finish when a later reader aborts the shared wait
 * 10. keeps an aborted underlying fetch in its flight until it settles
 *     → keeps an aborted underlying fetch in its flight until it settles
 * 11. keeps remote capacity reserved until every reader aborts and the fetch settles
 *     → keeps remote capacity reserved until every reader aborts and the fetch settles
 * 12. drains remote waiters FIFO and removes an aborted middle waiter
 *     → drains remote waiters FIFO and removes an aborted middle waiter
 * 13. settles queued remote readers on shutdown
 *     → settles queued remote readers on shutdown
 * 14. cancels a remote response body when its viewer aborts
 *     → cancels a remote response body when its reader aborts
 * 15. keeps remote capacity until the aborted response body drain settles
 *     → keeps remote capacity until the aborted response body drain settles
 * 16. settles a reader immediately on abort and cancels a late fetch response body
 *     → settles a reader immediately on abort and cancels a late fetch response body
 * 17. keeps remote reads at four or fewer and returns to idle after repeated bursts
 *     → keeps remote reads at four or fewer and returns to idle after repeated bursts (revoke calls deleted)
 * 18. queues twenty distinct images FIFO while holding at most four fetches
 *     → queues twenty distinct images FIFO while holding at most four fetches
 * 19. removes an aborted queued read, rejects a full queue, and drains queued reads on shutdown
 *     → removes an aborted queued read, queues past the old 64-waiter limit, and drains queued reads on shutdown
 *       (the 64-waiter rejection was removed; the 65 queued reads are now asserted to be enqueued)
 * 20. single-flights and persists a URL across capability instances
 *     → single-flights and persists a URL across service instances
 * 21. reads cached MIME and bytes from the same opened file version
 *     → reads cached MIME and bytes from the same opened file version
 * 22. keeps the old cached image and removes the temp file when revalidation rename fails
 *     → keeps the old cached image and removes the temp file when revalidation rename fails
 *       (revalidation is now in the foreground, so readers receive the validated fetched image instead of the
 *       stale bytes; the cache file, temp cleanup, reader settlement and slot release assertions are kept)
 * 23. serves stale avatar data immediately and starts only one background revalidation
 *     → revalidates a stale avatar once for concurrent readers and replaces the cache file
 *       (background refresh removed: stale entries are revalidated in the foreground; single revalidation,
 *       refreshed bytes, mtime and temp assertions kept)
 * 24. settles all readers after a disk write failure and releases the remote slot
 *     → settles all readers after a disk write failure and releases the remote slot
 *       (cache persistence is best effort since 319f368, so readers now get 200 instead of 404)
 * 25. deletes corrupt disk entries and refetches, without leaving temp files after failure
 *     → deletes corrupt disk entries and refetches, without leaving temp files after failure
 * 26. ignores crash leftovers and refetches when only a temporary cache file exists
 *     → ignores crash leftovers and refetches when only a temporary cache file exists
 * 27. keeps publication private until the complete temp image is renamed into place
 *     → keeps publication private until the complete temp image is renamed into place
 * 28. issues sticker capabilities only for bounded decimal IDs and uses the exact animated option
 *     → issues sticker sources only for bounded decimal IDs and uses the exact animated option
 * 29. rejects sticker redirects outside the same fixed CDN ID path
 *     → rejects sticker redirects outside the same fixed CDN ID path
 * 30. falls back from animated to static exactly once inside one sticker capability
 *     → falls back from animated to static exactly once inside one sticker source
 * 31. coalesces animated 503 fallback through the static key and retries animation after negative expiry
 *     → coalesces animated 503 fallback through the static key and retries animation after negative expiry
 * 32. keeps large cached files on disk and serves them by stream without a byte cap
 *     → keeps large cached files on disk and serves them without a byte cap
 * 33. serves concurrent cached whole buffers without a cache stream limit
 *     → serves concurrent cached whole buffers without a cache stream limit
 * 34. serves cached whole buffers independently of later capability revocation or shutdown
 *     → serves cached whole buffers independently of a later shutdown (revokeViewer deleted: revocation removed;
 *       the first response is now checked across shutdown instead)
 * 35. falls back through the static sticker URL after an animated request timeout
 *     → falls back through the static sticker URL after an animated request timeout
 * 36. aborts a pending remote read on %s and releases its request slot
 *     → aborts a pending remote read on %s and releases its request slot (cases shutdown and cancel kept;
 *       revoke, revokeViewer and expiry deleted: revocation and TTL removed)
 * 37. aborts a pending attachment read on %s and releases its stream slot
 *     → aborts a pending attachment read on %s and releases its stream slot (cases shutdown and cancel kept;
 *       revoke, revokeViewer and expiry deleted: revocation and TTL removed)
 * 38. holds attachment capacity until an aborted load finishes its handle cleanup
 *     → holds attachment capacity until an aborted load finishes its handle cleanup
 *       (abort replaces revoke; the second read now queues instead of being rejected)
 * 39. keeps rapid revoke and reentry churn within eight underlying attachment reads
 *     → keeps rapid abort and reentry churn within eight underlying attachment reads
 *       (abort replaces revoke; churn reads queue instead of being rejected)
 *
 * New tests without an old counterpart: serves 300 distinct URLs with four remote reads at most, in FIFO order;
 * queues and resolves the 65th and later remote waiters; queues 20 attachment reads behind eight active slots and
 * serves every request; starts the queued attachment identities in exact FIFO request order; keeps sticker redirect
 * limits and validates every redirect hop against the same asset; rejects sticker redirects to another ID, path, or
 * host without fetching again; shares a remote fetch and aborts only the reader that leaves; does not follow a
 * redirect outside the remote allowlist; returns remote capacity to idle after repeated bursts; returns the fetched
 * image and removes temp files when cache write or rename fails; cancels every remote response body on bad MIME and
 * oversize attachment rejection; drains a successful response body and settles an aborted body before releasing
 * remote capacity; holds the next queued request until an aborted response body drain settles; removes an aborted
 * attachment waiter and hands the freed queue slot to the next read; does not fetch a URL outside the allowlist and
 * uses the disk cache on repeat reads; keeps the same source usable after ten minutes; aborts active reads and
 * settles queued remote and attachment requests on shutdown; shuts down active and queued attachment and remote
 * reads and rejects later requests.
 */

const PNG = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82]);
const ATTACHMENT_ID = '2a653934-7064-4d90-a9f0-e6e24cf4f93d';
const ROOT = path.join(tmpdir(), `line-media-test-${Date.now()}-${Math.random().toString(16).slice(2)}`);
let serial = 0;
function createService(options: ConstructorParameters<typeof LineMediaService>[0] = {}) {
  return new LineMediaService({ cacheRoot: path.join(ROOT, String(++serial)), ...options });
}

describe('fixed LINE media reads', () => {
  const services: LineMediaService[] = [];
  afterEach(() => { for (const service of services.splice(0)) service.shutdown(); });
  afterAll(async () => { await rm(ROOT, { recursive: true, force: true }); });

  it('reports HTTP failure once per flight without remote text and keeps success/cancel quiet', async () => {
    const reports: unknown[][] = [];
    let status = 500;
    const service = createService({ fetch: async () => new Response(status === 200 ? PNG : 'private-response-sentinel',
      { status, headers: { 'content-type': 'image/png' } }), onDiagnostic: (...args) => { reports.push(args); } });
    services.push(service);
    expect((await service.handle(service.avatarSource('https://profile.line-scdn.net/private-url-sentinel.png'))).status).toBe(404);
    expect(reports).toMatchObject([[{ operation: 'attachment', stage: 'download', category: 'transport_failed', statusCode: 500 }, { correlationId: expect.any(String) }]]);
    const first = reports[0]?.[1];
    await service.handle(service.avatarSource('https://profile.line-scdn.net/another.png'));
    expect(reports[1]?.[1]).not.toEqual(first);
    expect(JSON.stringify(reports)).not.toMatch(/private-response-sentinel|private-url-sentinel|https:/);
    reports.length = 0; status = 200;
    expect((await service.handle(service.avatarSource('https://profile.line-scdn.net/success.png'))).status).toBe(200);
    const controller = new AbortController(); controller.abort();
    await service.handle(service.avatarSource('https://profile.line-scdn.net/cancel.png'), controller.signal);
    expect(reports).toEqual([]);
  });

  it('serves an allowlisted remote image through a fixed source', async () => {
    const service = createService({
      fetch: async () => new Response(PNG, { status: 200, headers: { 'content-type': 'image/png' } }),
    });
    services.push(service);
    const source = service.avatarSource('https://profile.line-scdn.net/p.png');

    const response = await service.handle(source);

    expect(source).toEqual({ type: 'remote', url: 'https://profile.line-scdn.net/p.png' });
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('image/png');
    expect(Buffer.from(await response.arrayBuffer())).toEqual(PNG);
  });

  it('invalidates only the cached URL for an explicitly refreshed account avatar', async () => {
    let fetches = 0;
    const service = createService({ fetch: async () => {
      fetches++;
      return new Response(PNG, { status: 200, headers: { 'content-type': 'image/png' } });
    } });
    services.push(service);
    const first = service.avatarSource('https://profile.line-scdn.net/own-avatar.png')!;
    const unrelated = service.avatarSource('https://profile.line-scdn.net/peer-avatar.png')!;

    await service.handle(first);
    await service.handle(unrelated);
    await service.invalidateAvatar('https://profile.line-scdn.net/own-avatar.png');
    await service.handle(unrelated);
    await service.handle(first);

    expect(fetches).toBe(3);
  });

  it('rejects unsafe sources and non-image responses', async () => {
    const service = createService({
      fetch: async () => new Response('<svg/>', { status: 200, headers: { 'content-type': 'image/svg+xml' } }),
    });
    services.push(service);

    expect(service.avatarSource('https://attacker.example/p.png')).toBeNull();
    expect(service.avatarSource('https://stickershop.line-scdn.net/stickershop/v1/sticker/123456/android/sticker.png')).toBeNull();
    expect((await service.handle(null)).status).toBe(404);
    const source = service.avatarSource('https://profile.line-scdn.net/p.png');
    expect((await service.handle(source)).status).toBe(404);
  });

  it('binds ready image attachments to the full conversation scope', async () => {
    const service = createService({
      loadAttachment: async (key, attachmentId) => attachmentId === ATTACHMENT_ID
        && key.accountId === 'account-A' && key.chatType === 'group' && key.chatId === 'chat-A'
        ? { bytes: PNG, mimeType: 'image/jpeg' } : null,
    });
    services.push(service);
    const key = { accountId: 'account-A', chatType: 'group' as const, chatId: 'chat-A' };
    const source = service.attachmentSource(ATTACHMENT_ID, key);

    const response = await service.handle(source);
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('image/png');
    expect((await service.handle(service.attachmentSource(ATTACHMENT_ID, { ...key, accountId: 'other' }))).status).toBe(404);
  });

  it('serves more than 256 consecutive inline attachment images', async () => {
    const service = createService({
      loadAttachment: async () => ({ bytes: PNG, mimeType: 'image/png' }),
    });
    services.push(service);
    const key = { accountId: 'account-A', chatType: 'group' as const, chatId: 'chat-A' };
    for (let index = 0; index < 300; index++) {
      const source = service.attachmentSource(ATTACHMENT_ID, key);
      expect(source).not.toBeNull();
      const response = await service.handle(source);
      expect(response.status).toBe(200);
      await response.arrayBuffer();
    }
  });

  it('accepts OBS picture origin and rejects lookalikes, HTTP, and userinfo', () => {
    const service = createService();
    services.push(service);
    expect(service.avatarSource('https://obs.line-scdn.net/hash/path')).toEqual({ type: 'remote', url: 'https://obs.line-scdn.net/hash/path' });
    for (const url of ['https://obs.line-scdn.net.evil/path', 'http://obs.line-scdn.net/path',
      'https://user@obs.line-scdn.net/path']) expect(service.avatarSource(url)).toBeNull();
  });

  it('cancels in-flight image reads and never follows a redirect outside LINE origins', async () => {
    let finishFetch!: (response: Response) => void;
    let observedSignal: AbortSignal | undefined;
    const service = createService({ fetch: async (_url, init) => {
      observedSignal = init?.signal ?? undefined;
      return await new Promise<Response>((resolve) => { finishFetch = resolve; });
    } });
    services.push(service);
    const source = service.avatarSource('https://profile.line-scdn.net/p.png');
    const controller = new AbortController();
    const pending = service.handle(source, controller.signal);
    await vi.waitFor(() => expect(observedSignal).toBeDefined());
    await new Promise((resolve) => setTimeout(resolve, 0));
    controller.abort();
    expect(observedSignal?.aborted).toBe(true);
    finishFetch(new Response(null, { status: 302, headers: { location: 'https://attacker.example/image.png' } }));
    expect((await pending).status).toBe(404);

    let requests = 0;
    const redirected = createService({ fetch: async () => {
      requests++;
      return new Response(null, { status: 302, headers: { location: 'https://attacker.example/image.png' } });
    } });
    services.push(redirected);
    const redirectedSource = redirected.avatarSource('https://profile.line-scdn.net/p.png');
    expect((await redirected.handle(redirectedSource)).status).toBe(404);
    expect(requests).toBe(1);
  });

  it('keeps a shared download alive when one reader aborts and cancels only the reader that aborts', async () => {
    let finish!: (response: Response) => void;
    let calls = 0;
    const service = createService({ fetch: async () => { calls++; return await new Promise<Response>((resolve) => { finish = resolve; }); } });
    services.push(service);
    const a = service.avatarSource('https://profile.line-scdn.net/shared-reader.png');
    const b = service.avatarSource('https://profile.line-scdn.net/shared-reader.png');
    const abortA = new AbortController();
    const readA = service.handle(a, abortA.signal);
    const readB = service.handle(b);
    await vi.waitFor(() => expect(calls).toBe(1));
    abortA.abort();
    await expect(readA).resolves.toMatchObject({ status: 404 });
    finish(new Response(PNG, { headers: { 'content-type': 'image/png' } }));
    await expect(readB).resolves.toMatchObject({ status: 200 });
    expect(calls).toBe(1);
  });

  it('lets the first reader finish when a later reader aborts the shared wait', async () => {
    let finish!: (response: Response) => void;
    let calls = 0;
    const service = createService({ fetch: async () => { calls++; return await new Promise<Response>((resolve) => { finish = resolve; }); } });
    services.push(service);
    const first = service.avatarSource('https://profile.line-scdn.net/later-abort.png');
    const later = service.avatarSource('https://profile.line-scdn.net/later-abort.png');
    const abortLater = new AbortController();
    const firstRead = service.handle(first);
    const laterRead = service.handle(later, abortLater.signal);
    await vi.waitFor(() => expect(calls).toBe(1));
    abortLater.abort();
    await expect(laterRead).resolves.toMatchObject({ status: 404 });
    finish(new Response(PNG, { headers: { 'content-type': 'image/png' } }));
    await expect(firstRead).resolves.toMatchObject({ status: 200 });
    expect(calls).toBe(1);
  });

  it('keeps an aborted underlying fetch in its flight until it settles', async () => {
    let firstSignal: AbortSignal | undefined;
    let firstFetch!: () => void;
    const started = new Promise<void>((resolve) => { firstFetch = resolve; });
    let finishFirst!: (response: Response) => void;
    let calls = 0;
    const service = createService({ fetch: async (_url, init) => {
      calls++;
      if (calls === 1) { firstSignal = init?.signal ?? undefined; firstFetch(); return await new Promise<Response>((resolve) => { finishFirst = resolve; }); }
      return new Response(PNG, { headers: { 'content-type': 'image/png' } });
    } });
    services.push(service);
    const first = service.avatarSource('https://profile.line-scdn.net/restart-flight.png');
    const abort = new AbortController();
    const firstRead = service.handle(first, abort.signal);
    await started; abort.abort();
    await expect(firstRead).resolves.toMatchObject({ status: 404 });
    expect(firstSignal?.aborted).toBe(true);
    const next = service.avatarSource('https://profile.line-scdn.net/restart-flight.png');
    const nextRead = service.handle(next);
    await new Promise((resolve) => setTimeout(resolve, 2));
    expect(calls).toBe(1);
    finishFirst(new Response(null, { status: 503 }));
    await expect(nextRead).resolves.toMatchObject({ status: 404 });
    expect(calls).toBe(1);
  });

  it('keeps remote capacity reserved until every reader aborts and the fetch settles', async () => {
    let finishFirst!: (response: Response) => void;
    let startedFirst!: () => void;
    const firstStarted = new Promise<void>((resolve) => { startedFirst = resolve; });
    let fetches = 0;
    const service = createService({ maxRemoteRequests: 1, fetch: async () => {
      fetches++;
      if (fetches === 1) {
        startedFirst();
        return await new Promise<Response>((resolve) => { finishFirst = resolve; });
      }
      return new Response(PNG, { headers: { 'content-type': 'image/png' } });
    } });
    services.push(service);
    const firstSource = service.avatarSource('https://profile.line-scdn.net/first.png');
    const abort = new AbortController();
    const secondAbort = new AbortController();
    const firstRead = service.handle(firstSource, abort.signal);
    const secondRead = service.handle(service.avatarSource('https://profile.line-scdn.net/first.png'), secondAbort.signal);
    await firstStarted;
    abort.abort();
    secondAbort.abort();
    await expect(firstRead).resolves.toMatchObject({ status: 404 });
    await expect(secondRead).resolves.toMatchObject({ status: 404 });

    const nextSource = service.avatarSource('https://profile.line-scdn.net/next.png');
    const nextRead = service.handle(nextSource);
    expect(fetches).toBe(1);

    finishFirst(new Response(null, { status: 503 }));
    await expect(nextRead).resolves.toMatchObject({ status: 200 });
    expect(fetches).toBe(2);
  });

  it('drains remote waiters FIFO and removes an aborted middle waiter', async () => {
    const starts: string[] = [];
    const releases = new Map<string, (response: Response) => void>();
    let startNext!: () => void;
    const firstStarted = new Promise<void>((resolve) => { startNext = resolve; });
    let enqueued!: () => void;
    let enqueueCount = 0;
    const allQueued = new Promise<void>((resolve) => { enqueued = resolve; });
    const queued: string[] = [];
    const service = createService({ maxRemoteRequests: 1,
      onRemoteEnqueued: (url) => { queued.push(url); if (++enqueueCount === 4) enqueued(); },
      fetch: async (input) => {
        const url = String(input); starts.push(url);
        if (starts.length === 1) startNext();
        return await new Promise<Response>((resolve) => { releases.set(url, resolve); });
      } });
    services.push(service);
    const firstSource = service.avatarSource('https://profile.line-scdn.net/fifo-first.png');
    const firstRead = service.handle(firstSource);
    await firstStarted;
    const queuedSources = ['a', 'b', 'c', 'd'].map((name) => service.avatarSource(`https://profile.line-scdn.net/fifo-${name}.png`));
    const remoteUrls = ['a', 'b', 'c', 'd'].map((name) => `https://profile.line-scdn.net/fifo-${name}.png`);
    const queuedHandles = new Map(queuedSources.map((source, index) => {
      const controller = new AbortController();
      return [remoteUrls[index]!, {
        controller,
        read: service.handle(source, controller.signal),
      }] as const;
    }));
    await allQueued;
    expect(queued).toHaveLength(4);
    expect(new Set(queued)).toEqual(new Set(remoteUrls));
    const cancelledUrl = queued[1]!;
    queuedHandles.get(cancelledUrl)!.controller.abort();
    await expect(queuedHandles.get(cancelledUrl)!.read).resolves.toMatchObject({ status: 404 });
    const firstUrlValue = 'https://profile.line-scdn.net/fifo-first.png';
    releases.get(firstUrlValue)!(new Response(PNG, { headers: { 'content-type': 'image/png' } }));
    const expectedOrder = [firstUrlValue, ...queued.filter((url) => url !== cancelledUrl)];
    for (const url of expectedOrder.slice(1)) {
      await vi.waitFor(() => expect(starts.at(-1)).toBe(url));
      releases.get(url)!(new Response(PNG, { headers: { 'content-type': 'image/png' } }));
    }
    await expect(Promise.all([firstRead, ...queued.filter((url) => url !== cancelledUrl).map((url) => queuedHandles.get(url)!.read)])).resolves.toEqual(
      Array.from({ length: 4 }, () => expect.objectContaining({ status: 200 })),
    );
    expect(starts).toEqual(expectedOrder);
    expect(starts).not.toContain(cancelledUrl);
  });

  it('settles queued remote readers on shutdown', async () => {
    let started!: () => void;
    const didStart = new Promise<void>((resolve) => { started = resolve; });
    const service = createService({ maxRemoteRequests: 1, fetch: async () => {
      started(); return await new Promise<Response>(() => undefined);
    } });
    services.push(service);
    const first = service.handle(service.avatarSource('https://profile.line-scdn.net/shutdown-first.png'));
    await didStart;
    const queued = service.handle(service.avatarSource('https://profile.line-scdn.net/shutdown-queued.png'));
    service.shutdown();
    await expect(Promise.all([first, queued])).resolves.toEqual([
      expect.objectContaining({ status: 404 }), expect.objectContaining({ status: 404 }),
    ]);
  });

  it('cancels a remote response body when its reader aborts', async () => {
    let bodyCancelled = false;
    let requests = 0;
    let didStart!: () => void;
    const started = new Promise<void>((resolve) => { didStart = resolve; });
    const service = createService({ maxRemoteRequests: 1, fetch: async (_url, init) => {
      requests++;
      if (requests > 1) return new Response(PNG, { headers: { 'content-type': 'image/png' } });
      let streamController!: ReadableStreamDefaultController<Uint8Array>;
      const body = new ReadableStream<Uint8Array>({
        start(controller) { streamController = controller; controller.enqueue(PNG); },
        pull() { didStart(); return new Promise<void>(() => undefined); },
        cancel() { bodyCancelled = true; },
      });
      init?.signal?.addEventListener('abort', () => { bodyCancelled = true; streamController.error(new Error('aborted')); }, { once: true });
      return new Response(body, { headers: { 'content-type': 'image/png' } });
    } });
    services.push(service);
    const firstSource = service.avatarSource('https://profile.line-scdn.net/first.png');
    const abort = new AbortController();
    const firstRead = service.handle(firstSource, abort.signal);
    await started;
    abort.abort();

    await expect(firstRead).resolves.toMatchObject({ status: 404 });
    await vi.waitFor(() => expect(bodyCancelled).toBe(true));
    const nextSource = service.avatarSource('https://profile.line-scdn.net/next.png');
    await expect(service.handle(nextSource)).resolves.toMatchObject({ status: 200 });
    expect(requests).toBe(2);
  });

  it('keeps remote capacity until the aborted response body drain settles', async () => {
    let finishCancel!: () => void;
    let cancelStarted!: () => void;
    const cancelBegan = new Promise<void>((resolve) => { cancelStarted = resolve; });
    let requests = 0;
    let didStart!: () => void;
    const started = new Promise<void>((resolve) => { didStart = resolve; });
    const service = createService({ maxRemoteRequests: 1, fetch: async (_url, init) => {
      requests++;
      if (requests > 1) return new Response(PNG, { headers: { 'content-type': 'image/png' } });
      let bodyController!: ReadableStreamDefaultController<Uint8Array>;
      const body = new ReadableStream<Uint8Array>({
        start(controller) { bodyController = controller; controller.enqueue(PNG); },
        pull() { didStart(); return new Promise<void>(() => undefined); },
      });
      init?.signal?.addEventListener('abort', () => { cancelStarted(); }, { once: true });
      finishCancel = () => { bodyController.error(new Error('aborted')); };
      return new Response(body, { headers: { 'content-type': 'image/png' } });
    } });
    services.push(service);
    const firstSource = service.avatarSource('https://profile.line-scdn.net/first.png');
    const abort = new AbortController();
    const firstRead = service.handle(firstSource, abort.signal);
    await started;
    abort.abort();

    await expect(firstRead).resolves.toMatchObject({ status: 404 });
    await cancelBegan;
    const nextSource = service.avatarSource('https://profile.line-scdn.net/next.png');
    const nextRead = service.handle(nextSource);
    expect(requests).toBe(1);

    finishCancel();
    await expect(nextRead).resolves.toMatchObject({ status: 200 });
    expect(requests).toBe(2);
  });

  it('settles a reader immediately on abort and cancels a late fetch response body', async () => {
    let finishFetch!: (response: Response) => void;
    let bodyCancelled = false;
    let fetches = 0;
    const service = createService({ fetch: async () => {
      fetches++;
      return await new Promise<Response>((resolve) => { finishFetch = resolve; });
    } });
    services.push(service);
    const source = service.avatarSource('https://profile.line-scdn.net/late.png');
    const abort = new AbortController();
    const pending = service.handle(source, abort.signal);
    await vi.waitFor(() => expect(fetches).toBe(1));
    abort.abort();
    await expect(pending).resolves.toMatchObject({ status: 404 });
    const body = new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(PNG); },
      cancel() { bodyCancelled = true; },
    });
    finishFetch(new Response(body, { headers: { 'content-type': 'image/png' } }));
    await vi.waitFor(() => expect(bodyCancelled).toBe(true));
    expect(fetches).toBe(1);
  });

  it('keeps remote reads at four or fewer and returns to idle after repeated bursts', async () => {
    let active = 0;
    let maximumActive = 0;
    let started = 0;
    let settle: Array<(response: Response) => void> = [];
    const service = createService({ maxRemoteRequests: 4, fetch: async () => {
      active++;
      started++;
      maximumActive = Math.max(maximumActive, active);
      return await new Promise<Response>((resolve) => {
        settle.push((response) => { active--; resolve(response); });
      });
    } });
    services.push(service);

    for (let wave = 0; wave < 3; wave++) {
      const before = started;
      const sources = Array.from({ length: 8 }, (_, index) => service.avatarSource(`https://profile.line-scdn.net/${wave}-${index}.png`));
      const reads = sources.map((source) => service.handle(source));
      await vi.waitFor(() => expect(started - before).toBe(4));
      expect(active).toBe(4);
      const current = settle.splice(0);
      current.forEach((finish) => finish(new Response(PNG, { headers: { 'content-type': 'image/png' } })));
      await vi.waitFor(() => expect(started - before).toBe(8));
      settle.splice(0).forEach((finish) => finish(new Response(PNG, { headers: { 'content-type': 'image/png' } })));
      const responses = await Promise.all(reads);
      expect(responses.map((response) => response.status)).toEqual(Array(8).fill(200));
      expect(active).toBe(0);
    }
    expect(maximumActive).toBe(4);
  });

  it('queues twenty distinct images FIFO while holding at most four fetches', async () => {
    let active = 0, maximum = 0;
    let fourActive!: () => void;
    const reachedFour = new Promise<void>((resolve) => { fourActive = resolve; });
    const service = createService({ fetch: async () => {
      active++; maximum = Math.max(maximum, active);
      if (active === 4) fourActive();
      // Hold until all four slots are in fetch at once: each slot first awaits a disk-cache miss, so a bare 1 ms
      // fetch could finish before the fourth slot reaches fetch and make the maximum timing-dependent.
      await reachedFour;
      await new Promise((resolve) => setTimeout(resolve, 1));
      active--;
      return new Response(PNG, { headers: { 'content-type': 'image/png' } });
    } });
    services.push(service);
    const sources = Array.from({ length: 20 }, (_, index) => service.avatarSource(`https://profile.line-scdn.net/burst-${index}.png`));
    const responses = await Promise.all(sources.map((source) => service.handle(source)));
    expect(responses.map((response) => response.status)).toEqual(Array(20).fill(200));
    expect(maximum).toBe(4);
  });

  it('removes an aborted queued read, queues past the old 64-waiter limit, and drains queued reads on shutdown', async () => {
    let release!: () => void;
    let calls = 0;
    let enqueued = 0;
    const service = createService({ maxRemoteRequests: 1, onRemoteEnqueued: () => { enqueued++; }, fetch: async () => {
      calls++;
      if (calls === 1) await new Promise<void>((resolve) => { release = resolve; });
      return new Response(PNG, { headers: { 'content-type': 'image/png' } });
    } });
    services.push(service);
    const first = service.avatarSource('https://profile.line-scdn.net/q-first.png');
    const firstRead = service.handle(first);
    await vi.waitFor(() => expect(calls).toBe(1));
    const abort = new AbortController();
    const queued = service.avatarSource('https://profile.line-scdn.net/q-abort.png');
    const queuedRead = service.handle(queued, abort.signal);
    abort.abort();
    await expect(queuedRead).resolves.toMatchObject({ status: 404 });
    const rest = Array.from({ length: 65 }, (_, index) => service.avatarSource(`https://profile.line-scdn.net/q-${index}.png`));
    const restReads = rest.map((source) => service.handle(source));
    await vi.waitFor(() => expect(calls).toBe(1));
    await vi.waitFor(() => expect(enqueued).toBe(66));
    service.shutdown();
    await expect(firstRead).resolves.toMatchObject({ status: 404 });
    expect((await Promise.all(restReads)).filter((response) => response.status === 404).length).toBe(65);
    release();
  });

  it('single-flights and persists a URL across service instances', async () => {
    const cacheRoot = await mkdtemp(path.join(tmpdir(), 'line-media-restart-'));
    let calls = 0;
    const options = { cacheRoot, fetch: async () => { calls++; return new Response(PNG, { headers: { 'content-type': 'image/png' } }); } };
    const first = createService(options); services.push(first);
    const sources = Array.from({ length: 10 }, () => first.avatarSource('https://profile.line-scdn.net/shared.png'));
    expect((await Promise.all(sources.map((source) => first.handle(source)))).every((response) => response.status === 200)).toBe(true);
    expect(calls).toBe(1);
    first.shutdown();
    const restarted = createService(options); services.push(restarted);
    const restartedSource = restarted.avatarSource('https://profile.line-scdn.net/shared.png');
    expect((await restarted.handle(restartedSource)).status).toBe(200);
    expect(calls).toBe(1);
    restarted.shutdown();
    await rm(cacheRoot, { recursive: true, force: true });
  });

  it('reads cached MIME and bytes from the same opened file version', async () => {
    const cacheRoot = await mkdtemp(path.join(tmpdir(), 'line-media-read-version-'));
    const url = 'https://profile.line-scdn.net/version.png';
    const key = createHash('sha256').update(url).digest('hex');
    const filename = path.join(cacheRoot, `${key}.img`);
    const gif = Buffer.from('GIF89a-image');
    await writeFile(filename, PNG);
    let opened!: () => void;
    let release!: () => void;
    const didOpen = new Promise<void>((resolve) => { opened = resolve; });
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const cacheFileSystem = { open: async (file: Parameters<typeof open>[0], flags: Parameters<typeof open>[1], mode?: Parameters<typeof open>[2]) => {
      const handle = await open(file, flags, mode);
      if (String(file) === filename) { opened(); await gate; }
      return handle;
    } };
    const service = createService({ cacheRoot, cacheFileSystem, fetch: async () => new Response(PNG, { headers: { 'content-type': 'image/png' } }) });
    services.push(service);
    try {
      const pending = service.handle(service.avatarSource(url));
      await didOpen;
      const replacement = path.join(cacheRoot, `${key}.replacement`);
      await writeFile(replacement, gif);
      await rm(filename);
      await rename(replacement, filename);
      release();
      const response = await pending;
      const bytes = Buffer.from(await response.arrayBuffer());
      expect(response.headers.get('content-type')).toBe('image/png');
      expect(bytes).toEqual(PNG);
      expect(response.headers.get('content-length')).toBe(String(PNG.byteLength));
    } finally { await rm(cacheRoot, { recursive: true, force: true }); }
  });

  it('keeps the old cached image and removes the temp file when revalidation rename fails', async () => {
    const cacheRoot = await mkdtemp(path.join(tmpdir(), 'line-media-rename-failure-'));
    const url = 'https://profile.line-scdn.net/revalidate-rename.png';
    const key = createHash('sha256').update(url).digest('hex');
    const filename = path.join(cacheRoot, `${key}.img`);
    const fresh = Buffer.from('GIF89a-new');
    await writeFile(filename, PNG);
    await utimes(filename, new Date(1), new Date(1));
    let called!: () => void;
    let renameAttempts = 0;
    const renameAttempt = new Promise<void>((resolve) => { called = resolve; });
    const cacheFileSystem = { rename: async (from: Parameters<typeof rename>[0], to: Parameters<typeof rename>[1]) => {
      if (String(to) === filename) { renameAttempts++; called(); throw new Error('injected rename failure'); }
      return await rename(from, to);
    } };
    let now = Date.now();
    let fetches = 0;
    const service = createService({ cacheRoot, now: () => now, cacheFileSystem, maxRemoteRequests: 1,
      fetch: async () => { fetches++; return new Response(fetches === 1 ? fresh : PNG, { headers: { 'content-type': fetches === 1 ? 'image/gif' : 'image/png' } }); } });
    services.push(service);
    try {
      const readers = [service.handle(service.avatarSource(url)), service.handle(service.avatarSource(url)), service.handle(service.avatarSource(url))];
      const responses = await Promise.all(readers);
      expect(responses.map((response) => response.status)).toEqual([200, 200, 200]);
      for (const response of responses) {
        expect(response.headers.get('content-type')).toBe('image/gif');
        expect(Buffer.from(await response.arrayBuffer())).toEqual(fresh);
      }
      now += 1;
      await renameAttempt;
      expect(renameAttempts).toBe(1);
      await vi.waitFor(async () => expect((await readdir(cacheRoot)).some((name) => name.endsWith('.tmp'))).toBe(false));
      expect(await readFile(filename)).toEqual(PNG);
      const following = await service.handle(service.avatarSource('https://profile.line-scdn.net/after-rename-failure.png'));
      expect(following.status).toBe(200);
      expect(fetches).toBe(2);
      expect(await readFile(filename)).toEqual(PNG);
      expect((await readdir(cacheRoot)).some((name) => name.endsWith('.tmp'))).toBe(false);
    } finally { await rm(cacheRoot, { recursive: true, force: true }); }
  });

  it('revalidates a stale avatar once for concurrent readers and replaces the cache file', async () => {
    const cacheRoot = await mkdtemp(path.join(tmpdir(), 'line-media-stale-'));
    const refreshedGif = Buffer.from('GIF89a-refreshed-image');
    let now = Date.now(), calls = 0;
    let finishRefresh!: () => void;
    const fetcher = async () => {
      calls++;
      if (calls > 1) { await new Promise<void>((resolve) => { finishRefresh = resolve; }); return new Response(refreshedGif, { headers: { 'content-type': 'image/gif' } }); }
      return new Response(PNG, { headers: { 'content-type': 'image/png' } });
    };
    const first = createService({ cacheRoot, now: () => now, fetch: fetcher }); services.push(first);
    const firstSource = first.avatarSource('https://profile.line-scdn.net/stale.png');
    await first.handle(firstSource);
    const image = path.join(cacheRoot, `${createHash('sha256').update('https://profile.line-scdn.net/stale.png').digest('hex')}.img`);
    const expiredAt = new Date(Date.now() - 8 * 86400_000);
    await utimes(image, expiredAt, expiredAt);
    const expiredMtime = (await stat(image)).mtimeMs;
    first.shutdown(); now += 8 * 86400_000;
    const stale = createService({ cacheRoot, now: () => now, fetch: fetcher }); services.push(stale);
    const sources = Array.from({ length: 8 }, () => stale.avatarSource('https://profile.line-scdn.net/stale.png'));
    const reads = Promise.all(sources.map((source) => stale.handle(source)));
    await vi.waitFor(() => expect(calls).toBe(2));
    finishRefresh();
    const responses = await reads;
    expect(responses.map((response) => response.status)).toEqual(Array(8).fill(200));
    expect(Buffer.from(await responses[0]!.arrayBuffer())).toEqual(refreshedGif);
    expect(calls).toBe(2);
    await vi.waitFor(async () => expect((await stat(image)).mtimeMs).toBeGreaterThan(expiredMtime));
    expect(await readFile(image)).toEqual(refreshedGif);
    expect((await readdir(cacheRoot)).some((name) => name.endsWith('.tmp'))).toBe(false);
    stale.shutdown();
    first.shutdown();
    await rm(cacheRoot, { recursive: true, force: true });
  });

  it('settles all readers after a disk write failure and releases the remote slot', async () => {
    let failFirstWrite = true;
    const cacheFileSystem = { writeFile: async (...args: Parameters<typeof writeFile>) => {
      if (failFirstWrite) { failFirstWrite = false; throw new Error('injected write failure'); }
      return await writeFile(...args);
    } };
    let calls = 0;
    const service = createService({ maxRemoteRequests: 1, cacheFileSystem, fetch: async () => { calls++; return new Response(PNG, { headers: { 'content-type': 'image/png' } }); } });
    services.push(service);
    try {
      const same = 'https://profile.line-scdn.net/write-fails.png';
      const first = service.handle(service.avatarSource(same));
      const second = service.handle(service.avatarSource(same));
      // Cache persistence is best effort since the fixed-URL change: the validated image is still served.
      await expect(Promise.all([first, second])).resolves.toEqual([
        expect.objectContaining({ status: 200 }), expect.objectContaining({ status: 200 }),
      ]);
      const next = service.handle(service.avatarSource('https://profile.line-scdn.net/write-recovers.png'));
      await expect(next).resolves.toMatchObject({ status: 200 });
      expect(calls).toBe(2);
    } finally { /* service shutdown is handled by afterEach */ }
  });

  it('deletes corrupt disk entries and refetches, without leaving temp files after failure', async () => {
    const cacheRoot = await mkdtemp(path.join(tmpdir(), 'line-media-corrupt-'));
    const url = 'https://profile.line-scdn.net/corrupt.png';
    const key = createHash('sha256').update(new URL(url).href).digest('hex');
    await writeFile(path.join(cacheRoot, `${key}.img`), 'not an image');
    await writeFile(path.join(cacheRoot, `${key}.json`), JSON.stringify({ mimeType: 'image/png', fetchedAt: Date.now() }));
    let calls = 0;
    const service = createService({ cacheRoot, fetch: async () => { calls++; return new Response(PNG, { headers: { 'content-type': 'image/png' } }); } });
    services.push(service);
    const source = service.avatarSource(url);
    expect((await service.handle(source)).status).toBe(200);
    expect(calls).toBe(1);
    await rm(cacheRoot, { recursive: true, force: true });

    const failureRoot = await mkdtemp(path.join(tmpdir(), 'line-media-fail-'));
    const failed = createService({ cacheRoot: failureRoot, fetch: async () => new Response(null, { status: 503 }) });
    services.push(failed);
    const failedSource = failed.avatarSource('https://profile.line-scdn.net/failure.png');
    expect((await failed.handle(failedSource)).status).toBe(404);
    expect(await readdir(failureRoot)).toEqual([]);
    await rm(failureRoot, { recursive: true, force: true });
  });

  it('ignores crash leftovers and refetches when only a temporary cache file exists', async () => {
    const cacheRoot = await mkdtemp(path.join(tmpdir(), 'line-media-tmp-leftover-'));
    const url = 'https://profile.line-scdn.net/leftover.png';
    const key = createHash('sha256').update(url).digest('hex');
    await writeFile(path.join(cacheRoot, `${key}.deadbeef.tmp`), PNG);
    let calls = 0;
    const service = createService({ cacheRoot, fetch: async () => { calls++; return new Response(PNG, { headers: { 'content-type': 'image/png' } }); } });
    services.push(service);
    const source = service.avatarSource(url);
    await expect(service.handle(source)).resolves.toMatchObject({ status: 200 });
    expect(calls).toBe(1);
    expect(await readFile(path.join(cacheRoot, `${key}.img`))).toEqual(PNG);
    expect(await readdir(cacheRoot)).toContain(`${key}.deadbeef.tmp`);
    await rm(cacheRoot, { recursive: true, force: true });
  });

  it('keeps publication private until the complete temp image is renamed into place', async () => {
    const cacheRoot = await mkdtemp(path.join(tmpdir(), 'line-media-atomic-'));
    let finishBody!: () => void;
    let tempReady!: () => void;
    const bodyPaused = new Promise<void>((resolve) => { tempReady = resolve; });
    let calls = 0;
    const service = createService({ cacheRoot, fetch: async () => {
      calls++;
      let controller!: ReadableStreamDefaultController<Uint8Array>;
      const body = new ReadableStream<Uint8Array>({
        start(value) { controller = value; value.enqueue(PNG); },
        pull() { tempReady(); return new Promise<void>((resolve) => { finishBody = () => { controller.close(); resolve(); }; }); },
      });
      return new Response(body, { headers: { 'content-type': 'image/png' } });
    } });
    services.push(service);
    const first = service.avatarSource('https://profile.line-scdn.net/atomic.png');
    const firstRead = service.handle(first);
    await bodyPaused;
    expect((await readdir(cacheRoot)).some((name) => name.endsWith('.tmp'))).toBe(false);
    expect((await readdir(cacheRoot)).some((name) => name.endsWith('.img'))).toBe(false);
    const second = service.avatarSource('https://profile.line-scdn.net/atomic.png');
    const secondRead = service.handle(second);
    finishBody();
    await expect(firstRead).resolves.toMatchObject({ status: 200 });
    await expect(secondRead).resolves.toMatchObject({ status: 200 });
    expect(calls).toBe(1);
    expect(await readdir(cacheRoot)).toEqual([`${createHash('sha256').update('https://profile.line-scdn.net/atomic.png').digest('hex')}.img`]);
    await rm(cacheRoot, { recursive: true, force: true });
  });

  it('issues sticker sources only for bounded decimal IDs and uses the exact animated option', async () => {
    const fetches: string[] = [];
    const service = createService({ fetch: async (input) => {
      fetches.push(String(input));
      return new Response(PNG, { headers: { 'content-type': 'image/png' } });
    } });
    services.push(service);
    const animatedSource = service.stickerSource('123456', true);
    const staticSource = service.stickerSource('123456', false);

    expect((await service.handle(animatedSource)).status).toBe(200);
    expect((await service.handle(staticSource)).status).toBe(200);
    expect(fetches).toEqual([
      'https://stickershop.line-scdn.net/stickershop/v1/sticker/123456/android/sticker_animation.png',
      'https://stickershop.line-scdn.net/stickershop/v1/sticker/123456/android/sticker.png',
    ]);
    expect(service.stickerSource('123456/../../x', false)).toBeNull();
  });

  it('rejects sticker redirects outside the same fixed CDN ID path', async () => {
    let requests = 0;
    const service = createService({ fetch: async () => {
      requests++;
      return new Response(null, { status: 302, headers: { location: 'https://attacker.example/image.png' } });
    } });
    services.push(service);
    const source = service.stickerSource('123456', false);

    expect((await service.handle(source)).status).toBe(404);
    expect(requests).toBe(1);
  });

  it('falls back from animated to static exactly once inside one sticker source', async () => {
    const fetches: string[] = [];
    const service = createService({ fetch: async (input) => {
      fetches.push(String(input));
      if (fetches.length === 1) return new Response(null, { status: 404 });
      return new Response(PNG, { headers: { 'content-type': 'image/png' } });
    } });
    services.push(service);
    const source = service.stickerSource('123456', true);

    expect((await service.handle(source)).status).toBe(200);
    expect(fetches).toEqual([
      'https://stickershop.line-scdn.net/stickershop/v1/sticker/123456/android/sticker_animation.png',
      'https://stickershop.line-scdn.net/stickershop/v1/sticker/123456/android/sticker.png',
    ]);
    const repeatedAnimated = service.stickerSource('123456', true);
    const repeatedStatic = service.stickerSource('123456', false);
    expect((await service.handle(repeatedAnimated)).status).toBe(200);
    expect((await service.handle(repeatedStatic)).status).toBe(200);
    expect(fetches).toHaveLength(2);
  });

  it('coalesces animated 503 fallback through the static key and retries animation after negative expiry', async () => {
    const cacheRoot = await mkdtemp(path.join(tmpdir(), 'line-media-animated-negative-'));
    let now = Date.now(), animatedFetches = 0, staticFetches = 0;
    let staticResponse!: (response: Response) => void;
    const service = createService({ cacheRoot, now: () => now, fetch: async (input) => {
      if (String(input).endsWith('sticker_animation.png')) {
        animatedFetches++;
        if (animatedFetches === 1) return new Response(null, { status: 503 });
        return new Response(PNG, { headers: { 'content-type': 'image/png' } });
      }
      staticFetches++;
      return await new Promise<Response>((resolve) => { staticResponse = resolve; });
    } });
    services.push(service);
    const animated = service.stickerSource('456789', true);
    const staticSource = service.stickerSource('456789', false);
    const animatedRead = service.handle(animated);
    const staticRead = service.handle(staticSource);
    await vi.waitFor(() => expect(staticFetches).toBe(1));
    staticResponse(new Response(PNG, { headers: { 'content-type': 'image/png' } }));
    await expect(animatedRead).resolves.toMatchObject({ status: 200 });
    await expect(staticRead).resolves.toMatchObject({ status: 200 });
    expect(animatedFetches).toBe(1);
    expect(staticFetches).toBe(1);
    const animatedKey = createHash('sha256').update('https://stickershop.line-scdn.net/stickershop/v1/sticker/456789/android/sticker_animation.png').digest('hex');
    const staticKey = createHash('sha256').update('https://stickershop.line-scdn.net/stickershop/v1/sticker/456789/android/sticker.png').digest('hex');
    await expect(stat(path.join(cacheRoot, `${animatedKey}.img`))).rejects.toThrow();
    expect(await readFile(path.join(cacheRoot, `${staticKey}.img`))).toEqual(PNG);

    now += 10 * 60_000 + 1;
    const retry = service.stickerSource('456789', true);
    await expect(service.handle(retry)).resolves.toMatchObject({ status: 200 });
    expect(animatedFetches).toBe(2);
    expect(await readFile(path.join(cacheRoot, `${animatedKey}.img`))).toEqual(PNG);
    await rm(cacheRoot, { recursive: true, force: true });
  });

  it('keeps large cached files on disk and serves them without a byte cap', async () => {
    const cacheRoot = await mkdtemp(path.join(tmpdir(), 'line-media-large-'));
    const largePng = Buffer.concat([PNG, Buffer.alloc(1024 * 1024 + 17)]);
    let calls = 0;
    const service = createService({ cacheRoot, fetch: async () => { calls++; return new Response(largePng, { headers: { 'content-type': 'image/png' } }); } });
    services.push(service);
    const source = service.avatarSource('https://profile.line-scdn.net/large.png');
    const response = await service.handle(source);
    expect(response.headers.get('content-length')).toBe(String(largePng.byteLength));
    expect((await response.arrayBuffer()).byteLength).toBe(largePng.byteLength);
    const repeated = service.avatarSource('https://profile.line-scdn.net/large.png');
    expect((await service.handle(repeated)).status).toBe(200);
    expect(calls).toBe(1);
    expect(await readdir(cacheRoot)).toHaveLength(1);
    service.shutdown();
    await rm(cacheRoot, { recursive: true, force: true });
  });

  it('serves concurrent cached whole buffers without a cache stream limit', async () => {
    const cacheRoot = await mkdtemp(path.join(tmpdir(), 'line-media-stream-limit-'));
    const largePng = Buffer.concat([PNG, Buffer.alloc(1024 * 1024 + 17)]);
    const service = createService({ cacheRoot, fetch: async () => new Response(largePng, { headers: { 'content-type': 'image/png' } }) });
    services.push(service);
    const seed = service.avatarSource('https://profile.line-scdn.net/stream-limit.png');
    const seedResponse = await service.handle(seed);
    await seedResponse.arrayBuffer();
    const opened = await Promise.all(Array.from({ length: 32 }, () => service.handle(seed)));
    const next = await service.handle(seed);
    expect(next.status).toBe(200);
    expect(opened.map((response) => response.status)).toEqual(Array(32).fill(200));
    await Promise.all([next, ...opened].map((response) => response.arrayBuffer()));
    expect((await readdir(cacheRoot)).filter((name) => name.endsWith('.img'))).toHaveLength(1);
    service.shutdown();
    await rm(cacheRoot, { recursive: true, force: true });
  });

  it('serves cached whole buffers independently of a later shutdown', async () => {
    const cacheRoot = await mkdtemp(path.join(tmpdir(), 'line-media-stream-revoke-'));
    const largePng = Buffer.concat([PNG, Buffer.alloc(1024 * 1024 + 17)]);
    const service = createService({ cacheRoot, fetch: async () => new Response(largePng, { headers: { 'content-type': 'image/png' } }) });
    services.push(service);
    const seed = service.avatarSource('https://profile.line-scdn.net/stream-revoke.png');
    const seedResponse = await service.handle(seed); await seedResponse.arrayBuffer();
    const again = service.avatarSource('https://profile.line-scdn.net/stream-revoke.png');
    const first = await service.handle(again);
    service.shutdown();
    await expect(first.arrayBuffer()).resolves.toHaveProperty('byteLength', largePng.byteLength);

    const restarted = createService({ cacheRoot, fetch: async () => new Response(largePng, { headers: { 'content-type': 'image/png' } }) });
    services.push(restarted);
    const restartedSource = restarted.avatarSource('https://profile.line-scdn.net/stream-revoke.png');
    const second = await restarted.handle(restartedSource);
    restarted.shutdown();
    await expect(second.arrayBuffer()).resolves.toHaveProperty('byteLength', largePng.byteLength);
    await rm(cacheRoot, { recursive: true, force: true });
  });

  it('falls back through the static sticker URL after an animated request timeout', async () => {
    vi.useFakeTimers();
    try {
      let fetches = 0;
      const service = createService({ maxRemoteRequests: 1, remoteTimeoutMs: 5_000, remoteDeadlineMs: 10_000,
        fetch: async (_url, init) => {
          fetches++;
          if (fetches > 1) return new Response(PNG, { headers: { 'content-type': 'image/png' } });
          return await new Promise<Response>((_resolve, reject) => init?.signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true }));
        } });
      services.push(service);
      const source = service.stickerSource('123456', true);
      const pending = service.handle(source);
      await vi.waitFor(() => expect(fetches).toBe(1));
      await vi.advanceTimersByTimeAsync(5_000);
      await expect(pending).resolves.toMatchObject({ status: 200 });
      expect(fetches).toBe(2);
    } finally { vi.useRealTimers(); }
  });

  it.each(['shutdown', 'cancel'] as const)(
    'aborts a pending remote read on %s and releases its request slot', async (action) => {
      let started!: () => void;
      const didStart = new Promise<void>((resolve) => { started = resolve; });
      let observedSignal: AbortSignal | undefined;
      let fetches = 0;
      const service = createService({ maxRemoteRequests: 1,
        fetch: async (_url, init) => {
          fetches++;
          if (fetches > 1) return new Response(PNG, { headers: { 'content-type': 'image/png' } });
          observedSignal = init?.signal ?? undefined;
          started();
          return await new Promise<Response>((_resolve, reject) => {
            observedSignal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
          });
        } });
      services.push(service);
      const source = service.avatarSource('https://profile.line-scdn.net/p.png');
      const controller = new AbortController();
      const pending = service.handle(source, controller.signal);
      await didStart;
      if (action === 'shutdown') service.shutdown();
      if (action === 'cancel') controller.abort();

      expect(observedSignal?.aborted).toBe(true);
      await expect(pending).resolves.toMatchObject({ status: 404 });
      if (action !== 'shutdown') {
        const next = service.avatarSource('https://profile.line-scdn.net/next.png');
        const fresh = await service.handle(next);
        expect(fresh.status).toBe(200);
      }
    },
  );

  it.each(['shutdown', 'cancel'] as const)(
    'aborts a pending attachment read on %s and releases its stream slot', async (action) => {
      let started!: () => void;
      const didStart = new Promise<void>((resolve) => { started = resolve; });
      let observedSignal: AbortSignal | undefined;
      let loads = 0;
      const service = createService({ maxAttachmentStreams: 1,
        loadAttachment: async (_key, _id, signal) => {
          loads++;
          if (loads > 1) return { bytes: PNG, mimeType: 'image/png' };
          observedSignal = signal;
          started();
          return await new Promise<null>((_resolve, reject) => {
            signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
          });
        } });
      services.push(service);
      const source = service.attachmentSource(ATTACHMENT_ID, { accountId: 'account-A', chatType: 'group', chatId: 'chat-A' });
      const controller = new AbortController();
      const pending = service.handle(source, controller.signal);
      await didStart;
      if (action === 'shutdown') service.shutdown();
      if (action === 'cancel') controller.abort();

      expect(observedSignal?.aborted).toBe(true);
      await expect(pending).resolves.toMatchObject({ status: 404 });
      if (action !== 'shutdown') {
        const next = service.attachmentSource(ATTACHMENT_ID, { accountId: 'account-A', chatType: 'group', chatId: 'chat-A' });
        expect(next).not.toBeNull();
        expect((await service.handle(next)).status).toBe(200);
      }
    },
  );

  it('holds attachment capacity until an aborted load finishes its handle cleanup', async () => {
    let closeStarted!: () => void;
    const closeCalled = new Promise<void>((resolve) => { closeStarted = resolve; });
    let finishRead!: (value: { bytes: Buffer; mimeType: string } | null) => void;
    let loads = 0;
    const service = createService({ maxAttachmentStreams: 1,
      loadAttachment: async (_key, _id, signal) => {
        loads++;
        if (loads > 1) return { bytes: PNG, mimeType: 'image/png' };
        return await new Promise((resolve) => {
          signal.addEventListener('abort', () => closeStarted(), { once: true });
          finishRead = resolve;
        });
      } });
    services.push(service);
    const key = { accountId: 'account-A', chatType: 'group' as const, chatId: 'chat-A' };
    const firstSource = service.attachmentSource(ATTACHMENT_ID, key);
    const abort = new AbortController();
    const firstRead = service.handle(firstSource, abort.signal);
    await new Promise((resolve) => setTimeout(resolve, 0));
    abort.abort();

    await expect(firstRead).resolves.toMatchObject({ status: 404 });
    await closeCalled;
    const secondSource = service.attachmentSource(ATTACHMENT_ID, key);
    let secondSettled = false;
    const secondRead = service.handle(secondSource).then((response) => { secondSettled = true; return response; });
    await new Promise((resolve) => setTimeout(resolve, 2));
    expect(secondSettled).toBe(false);
    expect(loads).toBe(1);

    finishRead!(null);
    await expect(secondRead).resolves.toMatchObject({ status: 200 });
    expect(loads).toBe(2);
  });

  it('keeps rapid abort and reentry churn within eight underlying attachment reads', async () => {
    const pendingLoads: Array<(value: { bytes: Buffer; mimeType: string } | null) => void> = [];
    let active = 0;
    let maximum = 0;
    const service = createService({ maxAttachmentStreams: 8,
      loadAttachment: async () => {
        active++;
        maximum = Math.max(maximum, active);
        return await new Promise((resolve) => pendingLoads.push((value) => { active--; resolve(value); }));
      } });
    services.push(service);
    const key = { accountId: 'account-A', chatType: 'group' as const, chatId: 'chat-A' };
    const controllers = Array.from({ length: 8 }, () => new AbortController());
    const firstReads = controllers.map((controller) => service.handle(service.attachmentSource(ATTACHMENT_ID, key), controller.signal));
    await vi.waitFor(() => expect(pendingLoads).toHaveLength(8));
    controllers.forEach((controller) => controller.abort());
    expect((await Promise.all(firstReads)).map((response) => response.status)).toEqual(Array(8).fill(404));
    const churn = Array.from({ length: 40 }, () => service.handle(service.attachmentSource(ATTACHMENT_ID, key)));
    await new Promise((resolve) => setTimeout(resolve, 2));
    expect(pendingLoads).toHaveLength(8);
    expect(maximum).toBe(8);
    let settled = 0;
    const churnDone = Promise.all(churn.map((read) => read.then((response) => { settled++; return response; })));
    while (settled < churn.length) {
      pendingLoads.splice(0).forEach((finish) => finish({ bytes: PNG, mimeType: 'image/png' }));
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(active).toBeLessThanOrEqual(8);
    }
    expect((await churnDone).map((response) => response.status)).toEqual(Array(40).fill(200));
    expect(active).toBe(0);
    expect(maximum).toBeLessThanOrEqual(8);
  });

  // ---- New tests (no old counterpart) ----

  it('serves 300 distinct URLs with four remote reads at most, in FIFO order', async () => {
    const started: string[] = [];
    const releases: Array<() => void> = [];
    let active = 0;
    let maximum = 0;
    const service = createService({ onRemoteEnqueued: (url) => started.push(`queued:${url}`), fetch: async (url) => {
      const href = String(url);
      started.push(`fetch:${href}`);
      active++; maximum = Math.max(maximum, active);
      await new Promise<void>((resolve) => releases.push(resolve));
      active--;
      return new Response(PNG, { headers: { 'content-type': 'image/png' } });
    } });
    services.push(service);
    const urls = Array.from({ length: 300 }, (_, i) => `https://profile.line-scdn.net/${i}.png`);
    const reads = urls.map((url) => service.handle(service.avatarSource(url)));
    await vi.waitFor(() => expect(started.filter((item) => item.startsWith('fetch:'))).toHaveLength(4));
    expect(maximum).toBe(4);
    for (let index = 0; index < urls.length - 4; index++) {
      releases[index]!();
      await vi.waitFor(() => expect(started.filter((item) => item.startsWith('fetch:'))).toHaveLength(index + 5), { interval: 1, timeout: 2_000 });
    }
    releases.slice(-4).forEach((finish) => finish());
    const responses = await Promise.all(reads);
    expect(responses.every((response) => response.status === 200)).toBe(true);
    expect(maximum).toBeLessThanOrEqual(4);
    const queued = started.filter((item) => item.startsWith('queued:')).map((item) => item.slice(7));
    expect(queued).toEqual(urls.slice(4));
  }, 20_000);

  it('queues and resolves the 65th and later remote waiters', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let queued = 0;
    const service = createService({ maxRemoteRequests: 1, onRemoteEnqueued: () => { queued++; },
      fetch: async () => { await gate; return new Response(PNG); } });
    services.push(service);
    const reads = Array.from({ length: 70 }, (_, index) => service.handle(service.avatarSource(`https://profile.line-scdn.net/waiter-${index}.png`)));
    await vi.waitFor(() => expect(queued).toBe(69));
    release();
    expect((await Promise.all(reads)).every((response) => response.status === 200)).toBe(true);
  });

  it('queues 20 attachment reads behind eight active slots and serves every request', async () => {
    let active = 0;
    let maximum = 0;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const service = createService({ loadAttachment: async () => {
      active++; maximum = Math.max(maximum, active);
      await gate;
      active--;
      return { bytes: PNG, mimeType: 'image/png' };
    } });
    services.push(service);
    const key = { accountId: 'account-A', chatType: 'group' as const, chatId: 'chat-A' };
    const reads = Array.from({ length: 20 }, () => service.handle(service.attachmentSource(ATTACHMENT_ID, key)));
    await vi.waitFor(() => expect(active).toBe(8));
    expect(maximum).toBe(8);
    release();
    expect((await Promise.all(reads)).every((response) => response.status === 200)).toBe(true);
    expect(maximum).toBeLessThanOrEqual(8);
  });

  it('starts the queued attachment identities in exact FIFO request order', async () => {
    const started: string[] = [];
    const releases: Array<() => void> = [];
    const service = createService({ loadAttachment: async (_key, id) => {
      started.push(id);
      await new Promise<void>((resolve) => releases.push(resolve));
      return { bytes: PNG, mimeType: 'image/png' };
    } });
    services.push(service);
    const key = { accountId: 'account-A', chatType: 'group' as const, chatId: 'chat-A' };
    const ids = Array.from({ length: 20 }, (_, i) => `00000000-0000-4000-8000-${String(i + 1).padStart(12, '0')}`);
    const reads = ids.map((id) => service.handle(service.attachmentSource(id, key)));
    await vi.waitFor(() => expect(started).toHaveLength(8));
    expect(started).toEqual(ids.slice(0, 8));
    for (let i = 0; i < 12; i++) {
      releases.shift()!();
      await vi.waitFor(() => expect(started).toHaveLength(9 + i));
      expect(started[8 + i]).toBe(ids[8 + i]);
    }
    releases.splice(0).forEach((release) => release());
    expect((await Promise.all(reads)).every((response) => response.status === 200)).toBe(true);
  });

  it('keeps sticker redirect limits and validates every redirect hop against the same asset', async () => {
    let requests = 0;
    const service = createService({ fetch: async (input) => {
      requests++;
      const url = String(input);
      if (requests === 1) return new Response(null, { status: 302, headers: { location: url.replace('sticker.png', 'sticker_animation.png') } });
      return new Response(null, { status: 302, headers: { location: 'https://stickershop.line-scdn.net/stickershop/v1/sticker/123456/android/sticker.png' } });
    } });
    services.push(service);
    expect((await service.handle(service.stickerSource('123456', false))).status).toBe(404);
    expect(requests).toBe(3);
  });

  it('rejects sticker redirects to another ID, path, or host without fetching again', async () => {
    const destinations = [
      'https://stickershop.line-scdn.net/stickershop/v1/sticker/654321/android/sticker.png',
      'https://stickershop.line-scdn.net/stickershop/v1/sticker/123456/ios/sticker.png',
      'https://attacker.example/stickershop/v1/sticker/123456/android/sticker.png',
    ];
    for (const destination of destinations) {
      let requests = 0;
      const service = createService({ fetch: async () => {
        requests++;
        return new Response(null, { status: 302, headers: { location: destination } });
      } });
      services.push(service);
      expect((await service.handle(service.stickerSource('123456', false))).status).toBe(404);
      expect(requests).toBe(1);
    }
  });

  it('shares a remote fetch and aborts only the reader that leaves', async () => {
    let release!: () => void;
    let started!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const didStart = new Promise<void>((resolve) => { started = resolve; });
    let fetches = 0;
    let fetchSignal: AbortSignal | undefined;
    const service = createService({ fetch: async (_url, init) => {
      fetches++;
      fetchSignal = init?.signal as AbortSignal;
      started();
      await gate;
      return new Response(PNG);
    } });
    services.push(service);
    const source = service.avatarSource('https://profile.line-scdn.net/shared-reader.png');
    const abort = new AbortController();
    const first = service.handle(source, abort.signal);
    const second = service.handle(source);
    await didStart;
    abort.abort();
    await expect(first).resolves.toMatchObject({ status: 404 });
    expect(fetchSignal?.aborted).toBe(false);
    release();
    await expect(second).resolves.toMatchObject({ status: 200 });
    expect(fetches).toBe(1);
  });

  it('does not follow a redirect outside the remote allowlist', async () => {
    const requested: string[] = [];
    const service = createService({ fetch: async (url) => {
      requested.push(String(url));
      return new Response(null, { status: 302, headers: { location: 'https://attacker.example/image.png' } });
    } });
    services.push(service);
    expect((await service.handle(service.avatarSource('https://profile.line-scdn.net/redirect.png'))).status).toBe(404);
    expect(requested).toEqual(['https://profile.line-scdn.net/redirect.png']);
  });

  it('returns remote capacity to idle after repeated bursts', async () => {
    vi.useFakeTimers();
    try {
      let active = 0, maximum = 0;
      const service = createService({ fetch: async () => {
        active++; maximum = Math.max(maximum, active);
        await Promise.resolve();
        active--;
        return new Response(PNG, { headers: { 'content-type': 'image/png' } });
      } });
      services.push(service);
      for (let burst = 0; burst < 3; burst++) {
        const responses = await Promise.all(Array.from({ length: 8 }, (_, i) => service.handle(service.avatarSource(`https://profile.line-scdn.net/burst-${burst}-${i}.png`))));
        expect(responses.every((response) => response.status === 200)).toBe(true);
        expect(active).toBe(0);
        expect(vi.getTimerCount()).toBe(0);
      }
      expect(maximum).toBeLessThanOrEqual(4);
    } finally { vi.useRealTimers(); }
  });

  it('returns the fetched image and removes temp files when cache write or rename fails', async () => {
    for (const failure of ['writeFile', 'rename'] as const) {
      const cacheRoot = await mkdtemp(path.join(tmpdir(), 'line-media-cache-fail-'));
      const cacheFileSystem = { [failure]: async () => { throw new Error(`injected ${failure} failure`); } };
      const service = createService({ cacheRoot, cacheFileSystem, fetch: async () => new Response(PNG) });
      services.push(service);
      const response = await service.handle(service.avatarSource(`https://profile.line-scdn.net/${failure}.png`));
      expect(response.status).toBe(200);
      expect(Buffer.from(await response.arrayBuffer())).toEqual(PNG);
      expect((await readdir(cacheRoot)).filter((name) => name.endsWith('.tmp'))).toEqual([]);
      await rm(cacheRoot, { recursive: true, force: true });
    }
  });

  it('cancels every remote response body on bad MIME and oversize attachment rejection', async () => {
    let drained = false;
    const service = createService({ fetch: async () => new Response(new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(new Uint8Array([1, 2, 3])); },
      pull(controller) { drained = true; controller.close(); },
    }), { headers: { 'content-type': 'image/svg+xml' } }), maxAttachmentBytes: 2,
      loadAttachment: async () => ({ bytes: PNG, mimeType: 'image/png' }) });
    services.push(service);
    expect((await service.handle(service.avatarSource('https://profile.line-scdn.net/bad-mime.png'))).status).toBe(404);
    expect(drained).toBe(true);
    const key = { accountId: 'account-A', chatType: 'group' as const, chatId: 'chat-A' };
    expect((await service.handle(service.attachmentSource(ATTACHMENT_ID, key))).status).toBe(404);
  });

  it('drains a successful response body and settles an aborted body before releasing remote capacity', async () => {
    let drained = false, bodyErrored = false, fetches = 0;
    let started!: () => void;
    const didStart = new Promise<void>((resolve) => { started = resolve; });
    const service = createService({ maxRemoteRequests: 1, fetch: async (_url, init) => {
      fetches++;
      if (fetches === 3) return new Response(PNG, { headers: { 'content-type': 'image/png' } });
      if (fetches === 2) {
        let controller!: ReadableStreamDefaultController<Uint8Array>;
        const body = new ReadableStream<Uint8Array>({
          start(value) { controller = value; value.enqueue(PNG); },
          pull() { started(); return new Promise<void>(() => undefined); },
        });
        init?.signal?.addEventListener('abort', () => { bodyErrored = true; controller.error(new Error('aborted')); }, { once: true });
        return new Response(body, { headers: { 'content-type': 'image/png' } });
      }
      return new Response(new ReadableStream<Uint8Array>({
        start(controller) { controller.enqueue(PNG); },
        pull(controller) { drained = true; controller.close(); },
      }), { headers: { 'content-type': 'image/png' } });
    } });
    services.push(service);
    await expect(service.handle(service.avatarSource('https://profile.line-scdn.net/drain-success.png'))).resolves.toMatchObject({ status: 200 });
    expect(drained).toBe(true);
    const abort = new AbortController();
    const pending = service.handle(service.avatarSource('https://profile.line-scdn.net/drain-abort.png'), abort.signal);
    await didStart;
    abort.abort();
    await expect(pending).resolves.toMatchObject({ status: 404 });
    expect(bodyErrored).toBe(true);
    await expect(service.handle(service.avatarSource('https://profile.line-scdn.net/drain-next.png'))).resolves.toMatchObject({ status: 200 });
  });

  it('holds the next queued request until an aborted response body drain settles', async () => {
    let releaseDrain!: () => void;
    let startedDrain!: () => void;
    let calls = 0;
    const draining = new Promise<void>((resolve) => { releaseDrain = resolve; });
    const didStartDrain = new Promise<void>((resolve) => { startedDrain = resolve; });
    const service = createService({ maxRemoteRequests: 1, fetch: async () => {
      calls++;
      if (calls === 1) {
        const body = new ReadableStream<Uint8Array>({
          start(controller) { controller.enqueue(PNG); },
          async pull(controller) { startedDrain(); await draining; controller.close(); },
          cancel() { /* Drain completion is deliberately deferred to model a slow body source. */ },
        });
        return new Response(body, { headers: { 'content-type': 'image/png' } });
      }
      return new Response(PNG, { headers: { 'content-type': 'image/png' } });
    } });
    services.push(service);
    const abort = new AbortController();
    const first = service.handle(service.avatarSource('https://profile.line-scdn.net/drain-hold.png'), abort.signal);
    await didStartDrain;
    const next = service.handle(service.avatarSource('https://profile.line-scdn.net/drain-next.png'));
    abort.abort();
    await expect(first).resolves.toMatchObject({ status: 404 });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(calls).toBe(1);
    releaseDrain();
    await expect(next).resolves.toMatchObject({ status: 200 });
    expect(calls).toBe(2);
  });

  it('removes an aborted attachment waiter and hands the freed queue slot to the next read', async () => {
    const releases: Array<() => void> = [];
    let active = 0;
    let maximum = 0;
    let started = 0;
    const service = createService({ loadAttachment: async () => {
      started++; active++; maximum = Math.max(maximum, active);
      return await new Promise<{ bytes: Buffer; mimeType: string }>((resolve) => releases.push(() => {
        active--; resolve({ bytes: PNG, mimeType: 'image/png' });
      }));
    } });
    services.push(service);
    const key = { accountId: 'account-A', chatType: 'group' as const, chatId: 'chat-A' };
    const activeReads = Array.from({ length: 8 }, () => service.handle(service.attachmentSource(ATTACHMENT_ID, key)));
    await vi.waitFor(() => expect(started).toBe(8));
    const abort = new AbortController();
    const cancelled = service.handle(service.attachmentSource(ATTACHMENT_ID, key), abort.signal);
    const next = service.handle(service.attachmentSource(ATTACHMENT_ID, key));
    abort.abort();
    await expect(cancelled).resolves.toMatchObject({ status: 404 });
    releases.slice(0, 8).forEach((finish) => finish());
    await vi.waitFor(() => expect(started).toBe(9));
    releases[8]!();
    expect((await Promise.all([...activeReads, next])).every((response) => response.status === 200)).toBe(true);
    expect(maximum).toBe(8);
  });

  it('does not fetch a URL outside the allowlist and uses the disk cache on repeat reads', async () => {
    let fetches = 0;
    const cacheRoot = path.join(ROOT, `persistent-${++serial}`);
    const service = createService({ cacheRoot, fetch: async () => { fetches++; return new Response(PNG); } });
    services.push(service);
    expect((await service.handle(service.avatarSource('https://outside.invalid/image.png'))).status).toBe(404);
    expect(fetches).toBe(0);
    const source = service.avatarSource('https://profile.line-scdn.net/cached.png');
    expect((await service.handle(source)).status).toBe(200);
    expect((await service.handle(source)).status).toBe(200);
    expect(fetches).toBe(1);
    const nextService = createService({ cacheRoot, fetch: async () => { fetches++; return new Response(PNG); } });
    services.push(nextService);
    expect((await nextService.handle(source)).status).toBe(200);
    expect(fetches).toBe(1);
  });

  it('keeps the same source usable after ten minutes', async () => {
    let now = 10_000;
    const service = createService({ now: () => now, fetch: async () => new Response(PNG) });
    services.push(service);
    const source = service.avatarSource('https://profile.line-scdn.net/long-lived.png');
    expect((await service.handle(source)).status).toBe(200);
    now += 11 * 60_000;
    expect((await service.handle(source)).status).toBe(200);
  });

  it('aborts active reads and settles queued remote and attachment requests on shutdown', async () => {
    vi.useFakeTimers();
    try {
      let remoteSignal: AbortSignal | undefined;
      let didStart!: () => void;
      let didQueue!: () => void;
      const started = new Promise<void>((resolve) => { didStart = resolve; });
      const queued = new Promise<void>((resolve) => { didQueue = resolve; });
      const remote = createService({ maxRemoteRequests: 1, onRemoteEnqueued: () => didQueue(), fetch: async (_url, init) => {
        remoteSignal = init?.signal as AbortSignal;
        didStart();
        return await new Promise<Response>((_resolve, reject) => remoteSignal!.addEventListener('abort', () => reject(new Error('aborted')), { once: true }));
      } });
      services.push(remote);
      const first = remote.handle(remote.avatarSource('https://profile.line-scdn.net/active.png'));
      const queuedRead = remote.handle(remote.avatarSource('https://profile.line-scdn.net/queued.png'));
      await Promise.all([started, queued]);
      remote.shutdown();
      await expect(first).resolves.toMatchObject({ status: 404 });
      await expect(queuedRead).resolves.toMatchObject({ status: 404 });
      expect(remoteSignal?.aborted).toBe(true);

      let attachmentSignal: AbortSignal | undefined;
      let didStartAttachment!: () => void;
      const attachmentStarted = new Promise<void>((resolve) => { didStartAttachment = resolve; });
      const attachment = createService({ loadAttachment: async (_key, _id, signal) => {
        attachmentSignal = signal;
        didStartAttachment();
        return await new Promise<null>((_resolve, reject) => signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true }));
      } });
      services.push(attachment);
      const key = { accountId: 'account-A', chatType: 'group' as const, chatId: 'chat-A' };
      const reading = attachment.handle(attachment.attachmentSource(ATTACHMENT_ID, key));
      await attachmentStarted;
      attachment.shutdown();
      await expect(reading).resolves.toMatchObject({ status: 404 });
      expect(attachmentSignal?.aborted).toBe(true);
      expect(vi.getTimerCount()).toBe(0);
    } finally { vi.useRealTimers(); }
  });

  it('shuts down active and queued attachment and remote reads and rejects later requests', async () => {
    vi.useFakeTimers();
    try {
      const startedRemote: Array<() => void> = [];
      const startedAttachment: Array<() => void> = [];
      const service = createService({ maxRemoteRequests: 1, maxAttachmentStreams: 1,
        fetch: async (_url, init) => await new Promise<Response>((_resolve, reject) => {
          startedRemote.push(() => init?.signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true }));
          init?.signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
        }),
        loadAttachment: async (_key, _id, signal) => await new Promise<null>((_resolve, reject) => {
          startedAttachment.push(() => signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true }));
          signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
        }),
      });
      services.push(service);
      const key = { accountId: 'account-A', chatType: 'group' as const, chatId: 'chat-A' };
      const remoteActive = service.handle(service.avatarSource('https://profile.line-scdn.net/active.png'));
      const remoteQueued = service.handle(service.avatarSource('https://profile.line-scdn.net/queued.png'));
      const attachmentActive = service.handle(service.attachmentSource(ATTACHMENT_ID, key));
      const attachmentQueued = service.handle(service.attachmentSource('00000000-0000-4000-8000-000000000001', key));
      await vi.waitFor(() => { expect(startedRemote).toHaveLength(1); expect(startedAttachment).toHaveLength(1); });
      service.shutdown();
      await expect(Promise.all([remoteActive, remoteQueued, attachmentActive, attachmentQueued])).resolves.toEqual(Array(4).fill(expect.objectContaining({ status: 404 })));
      expect((await service.handle(service.avatarSource('https://profile.line-scdn.net/later.png'))).status).toBe(404);
      expect(vi.getTimerCount()).toBe(0);
    } finally { vi.useRealTimers(); }
  });
});
