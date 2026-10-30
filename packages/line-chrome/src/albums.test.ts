import { describe, expect, it } from 'vitest';
import {
  ALBUM_CHANNEL_ID, ALBUM_PREVIEW_TID, ChannelTokenCache, ChannelTokenError, buildAlbumPreviewRequest, downloadAlbumPreview,
  parseChannelTokenExpiration,
} from './albums.js';
import { ObsHttpError, ObsSizeLimitError, type ObsRequest } from './obs.js';
import type { FetchLike } from './gateway.js';

// Contract of line-cli pkg/line/obs_test.go TestDownloadAlbumPreviewMatchesLINERequestContract.
const NOW = 1_700_000_000_000;

describe('parseChannelTokenExpiration (line-cli parseChannelTokenExpiration)', () => {
  it('reads epoch ms, epoch s, relative seconds and RFC 3339, minus the 30 s buffer', () => {
    expect(parseChannelTokenExpiration(9_999_999_999_999, NOW)).toBe(9_999_999_999_999 - 30_000);
    expect(parseChannelTokenExpiration(2_000_000_000, NOW)).toBe(2_000_000_000_000 - 30_000);
    expect(parseChannelTokenExpiration(600, NOW)).toBe(NOW + 600_000 - 30_000);
    expect(parseChannelTokenExpiration('600', NOW)).toBe(NOW + 600_000 - 30_000);
    expect(parseChannelTokenExpiration('2030-01-01T00:00:00Z', NOW)).toBe(Date.parse('2030-01-01T00:00:00Z') - 30_000);
  });
  it('falls back to five minutes for absent, zero, junk or nearly expired values', () => {
    const fallback = NOW + 5 * 60_000;
    for (const raw of [undefined, null, 0, -4, 'soon', {}, 10, 123.5, '2024-01-01']) expect(parseChannelTokenExpiration(raw, NOW), String(raw)).toBe(fallback);
  });
});

describe('ChannelTokenCache', () => {
  it('reads the clock before the RPC and counts the lifetime from that time', async () => {
    const clock = { t: NOW };
    let issued = 0;
    const instance = new ChannelTokenCache(async () => { issued += 1; clock.t = NOW + 120_000; return { channelAccessToken: 'tok', expiration: 600 }; }, () => clock.t);
    await instance.get(ALBUM_CHANNEL_ID);
    clock.t = NOW + 600_000 - 40_000; // inside the lifetime counted from NOW
    await instance.get(ALBUM_CHANNEL_ID);
    expect(issued).toBe(1);
    clock.t = NOW + 600_000 - 29_000; // inside the 30 s buffer
    await instance.get(ALBUM_CHANNEL_ID);
    expect(issued).toBe(2);
  });
  it('accepts a 4097-character ASCII token', async () => {
    const token = 'a'.repeat(4097);
    const instance = new ChannelTokenCache(async () => ({ channelAccessToken: token }), () => NOW);
    expect(await instance.get('1')).toBe(token);
  });
  function cache(replies: unknown[], clock = { t: NOW }) {
    const asked: string[] = [];
    const instance = new ChannelTokenCache(async (id) => { asked.push(id); const next = replies.shift(); if (next instanceof Error) throw next; return next; }, () => clock.t);
    return { instance, asked, clock };
  }
  it('issues once per channel and reuses the token until the buffered expiry', async () => {
    const { instance, asked, clock } = cache([{ channelAccessToken: 'tok-1', expiration: NOW + 3_600_000 }, { channelAccessToken: 'tok-2', expiration: NOW + 7_200_000 }]);
    expect(await instance.get(ALBUM_CHANNEL_ID)).toBe('tok-1');
    expect(await instance.get(ALBUM_CHANNEL_ID)).toBe('tok-1');
    expect(asked).toEqual([ALBUM_CHANNEL_ID]);
    clock.t = NOW + 3_600_000 - 29_000; // inside the 30 s buffer
    expect(await instance.get(ALBUM_CHANNEL_ID)).toBe('tok-2');
    expect(asked).toHaveLength(2);
  });
  it('shares one in-flight issue, rejects an empty or malformed token and forgets on clear()', async () => {
    const { instance, asked } = cache([{ channelAccessToken: 'a' }, { channelAccessToken: 'b' }]);
    expect(await Promise.all([instance.get('1'), instance.get('1')])).toEqual(['a', 'a']);
    expect(asked).toHaveLength(1);
    instance.clear();
    expect(await instance.get('1')).toBe('b');
    for (const data of [{ channelAccessToken: '' }, { token: 'legacy' }, null, 'x']) {
      await expect(cache([data]).instance.get('1')).rejects.toBeInstanceOf(ChannelTokenError);
    }
  });
});

function recorder(response: () => Response) {
  const seen: Array<{ url: string; init: RequestInit }> = [];
  const fetch: FetchLike = async (url, init) => { seen.push({ url, init }); return response(); };
  return { seen, fetch };
}
const base = { channelToken: 'channel-token', accessToken: 'line-token', chatId: 'chat-id', albumId: 'album-id', oid: 'preview-oid', maxBytes: 1024 };

describe('downloadAlbumPreview (line-cli DownloadAlbumPreview)', () => {
  it('sends exactly one GET with the line-cli header contract and no X-Line-Application', async () => {
    const { seen, fetch } = recorder(() => new Response('album-thumbnail'));
    const authorized: ObsRequest[] = [];
    const data = await downloadAlbumPreview({ ...base, fetch, authorize: (request) => { authorized.push(request); } });
    expect(data.toString()).toBe('album-thumbnail');
    expect(seen).toHaveLength(1);
    expect(seen[0]!.url).toBe(`https://obs.line-apps.com/r/album/a/preview-oid/${ALBUM_PREVIEW_TID}`);
    expect(ALBUM_PREVIEW_TID).toBe('f482x482');
    expect(seen[0]!.init.method).toBe('GET');
    expect(seen[0]!.init.redirect).toBe('error');
    expect(seen[0]!.init.body).toBeUndefined();
    const headers = seen[0]!.init.headers as Array<[string, string]>;
    expect(headers.map(([name]) => name)).toEqual(['User-Agent', 'X-Line-ChannelToken', 'X-Line-Mid', 'X-Line-Album', 'X-Line-Access']);
    const map = Object.fromEntries(headers);
    expect(map['X-Line-ChannelToken']).toBe('channel-token');
    expect(map['X-Line-Mid']).toBe('chat-id');
    expect(map['X-Line-Album']).toBe('album-id');
    expect(map['X-Line-Access']).toBe('line-token');
    expect(map['X-Line-Application']).toBeUndefined();
    expect(map['Cookie']).toBeUndefined();
    expect(authorized).toHaveLength(1);
    expect(authorized[0]!.url).toBe(seen[0]!.url);
  });
  it('omits X-Line-Album when the album id is empty and path-escapes the oid', () => {
    const request = buildAlbumPreviewRequest({ ...base, albumId: '', oid: 'a/b c' });
    expect(request.headers.map(([name]) => name)).not.toContain('X-Line-Album');
    expect(request.url).toBe('https://obs.line-apps.com/r/album/a/a%2Fb%20c/f482x482');
    expect(() => buildAlbumPreviewRequest({ ...base, oid: '' })).toThrow(RangeError);
    expect(() => buildAlbumPreviewRequest({ ...base, chatId: '' })).toThrow(RangeError);
  });
  it('does not send when the gate refuses', async () => {
    const { seen, fetch } = recorder(() => new Response('x'));
    await expect(downloadAlbumPreview({ ...base, fetch, authorize: () => { throw new Error('denied'); } })).rejects.toThrow('denied');
    expect(seen).toHaveLength(0);
  });
  it('classifies 202 / 404 / 403 by status, never retries, and enforces the byte limit', async () => {
    for (const status of [202, 404, 403]) {
      const { seen, fetch } = recorder(() => new Response('error', { status }));
      await expect(downloadAlbumPreview({ ...base, fetch, authorize: () => undefined })).rejects.toMatchObject({ status });
      expect(seen).toHaveLength(1);
    }
    const { fetch } = recorder(() => new Response('toolong'));
    await expect(downloadAlbumPreview({ ...base, maxBytes: 3, fetch, authorize: () => undefined })).rejects.toBeInstanceOf(ObsSizeLimitError);
    const failing = recorder(() => new Response('', { status: 500 }));
    await expect(downloadAlbumPreview({ ...base, fetch: failing.fetch, authorize: () => undefined })).rejects.toBeInstanceOf(ObsHttpError);
  });
  it('stops on abort before the request', async () => {
    const controller = new AbortController();
    controller.abort(new Error('stop'));
    const { seen, fetch } = recorder(() => new Response('x'));
    await expect(downloadAlbumPreview({ ...base, fetch, authorize: () => undefined, signal: controller.signal })).rejects.toThrow('stop');
    expect(seen).toHaveLength(0);
  });
});
