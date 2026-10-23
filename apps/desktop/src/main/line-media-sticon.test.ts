import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { LineMediaService } from './line-media.js';

const PNG = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82]);
const PRODUCT = '0123456789abcdef01234567';

describe('sticon media', () => {
  const services: LineMediaService[] = [];
  afterEach(() => { for (const service of services.splice(0)) service.shutdown(); });

  it('validates identifiers and caches immutable sticons on repeat reads', async () => {
    const cacheRoot = await mkdtemp(path.join(tmpdir(), 'line-sticon-cache-'));
    let calls = 0;
    let requested = '';
    const service = new LineMediaService({ cacheRoot, fetch: async (url) => {
      calls++; requested = String(url); return new Response(PNG);
    } });
    services.push(service);
    expect(service.sticonSource('bad', '1', false)).toBeNull();
    expect(service.sticonSource(PRODUCT, '1/../x', false)).toBeNull();
    const source = service.sticonSource(PRODUCT, '001', false);
    expect((await service.handle(source)).status).toBe(200);
    expect((await service.handle(source)).status).toBe(200);
    expect(requested).toBe(`https://stickershop.line-scdn.net/sticonshop/v1/sticon/${PRODUCT}/android/001.png`);
    expect(calls).toBe(1);
    await rm(cacheRoot, { recursive: true, force: true });
  });

  it('falls back from animated to static asset', async () => {
    const cacheRoot = await mkdtemp(path.join(tmpdir(), 'line-sticon-fallback-'));
    const requested: string[] = [];
    const service = new LineMediaService({ cacheRoot, fetch: async (url) => {
      requested.push(String(url));
      return requested.length === 1 ? new Response(null, { status: 404 }) : new Response(PNG);
    } });
    services.push(service);
    expect((await service.handle(service.sticonSource(PRODUCT, '7', true))).status).toBe(200);
    expect(requested).toEqual([
      `https://stickershop.line-scdn.net/sticonshop/v1/sticon/${PRODUCT}/android/7_animation.png`,
      `https://stickershop.line-scdn.net/sticonshop/v1/sticon/${PRODUCT}/android/7.png`,
    ]);
    await rm(cacheRoot, { recursive: true, force: true });
  });
});
