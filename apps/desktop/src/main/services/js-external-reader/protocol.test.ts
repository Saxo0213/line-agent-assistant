import { describe, expect, it } from 'vitest';
import { FRAME_LIMITS, encodeFrame, FrameDecoder, validateFrameEnvelope } from './protocol.js';
import { PassThrough } from 'node:stream';
import { FrameStream } from './controller.js';

describe('JS external reader private protocol', () => {
  it('decodes fragmented length-prefixed frames without accepting protocol extras', () => {
    const frame = { version: 1, requestId: 'a'.repeat(32), sequence: 1, type: 'hello', bridgeVersion: '1.0.0' };
    const bytes = encodeFrame(frame, FRAME_LIMITS.controlBytes);
    const decoder = new FrameDecoder(FRAME_LIMITS.controlBytes);
    expect(decoder.push(bytes.subarray(0, 2))).toEqual([]);
    expect(decoder.push(bytes.subarray(2, 7))).toEqual([]);
    const decoded = decoder.push(bytes.subarray(7));
    expect(decoded).toEqual([frame]);
    expect(validateFrameEnvelope(decoded[0], { requestId: frame.requestId, expectedSequence: 1, allowedKeys: ['bridgeVersion'] })).toBe(true);
    expect(validateFrameEnvelope({ ...frame, unexpected: true }, { requestId: frame.requestId, expectedSequence: 1, allowedKeys: ['bridgeVersion'] })).toBe(false);
  });

  it('rejects an advertised frame larger than its allocation ceiling before buffering the body', () => {
    const decoder = new FrameDecoder(FRAME_LIMITS.controlBytes);
    const header = Buffer.alloc(4);
    header.writeUInt32BE(FRAME_LIMITS.controlBytes + 1);
    expect(() => decoder.push(header)).toThrow('frame_too_large');
  });

  it('accepts an initial-import page above 1 MiB but rejects it on the ordinary page decoder', () => {
    const requestId = 'f'.repeat(32);
    const oversized = encodeFrame({ version: 1, requestId, sequence: 1, type: 'page', body: 'x'.repeat(1200 * 1024) },
      FRAME_LIMITS.initialImportPageBytes);
    expect(new FrameDecoder(FRAME_LIMITS.initialImportPageBytes).push(oversized)).toHaveLength(1);
    expect(() => new FrameDecoder(FRAME_LIMITS.pageBytes).push(oversized.subarray(0, 4))).toThrow('frame_too_large');
    const excessiveHeader = Buffer.alloc(4);
    excessiveHeader.writeUInt32BE(FRAME_LIMITS.initialImportPageBytes + 1);
    expect(() => new FrameDecoder(FRAME_LIMITS.initialImportPageBytes).push(excessiveHeader)).toThrow('frame_too_large');
  });

  it('surfaces a terminal parse failure ahead of already queued frames', async () => {
    const stream = new PassThrough();
    const frames = new FrameStream(stream, FRAME_LIMITS.controlBytes);
    const first = { version: 1, requestId: 'a'.repeat(32), sequence: 1, type: 'hello' };
    const second = { ...first, sequence: 2, type: 'inventory' };
    stream.write(Buffer.concat([encodeFrame(first, 4096), encodeFrame(second, 4096)]));
    expect(await frames.next(Date.now() + 1_000)).toEqual(first);
    stream.write(Buffer.from([0, 0, 32, 1]));
    await expect(frames.next(Date.now() + 1_000)).rejects.toThrow('frame_too_large');
    frames.close();
  });

  it('rejects a burst that exceeds its bounded control-frame queue', async () => {
    const stream = new PassThrough();
    const frames = new FrameStream(stream, FRAME_LIMITS.controlBytes);
    const frame = { version: 1, requestId: 'b'.repeat(32), sequence: 1, type: 'hello' };
    stream.write(Buffer.concat(Array.from({ length: 4 }, (_, index) => encodeFrame({ ...frame, sequence: index + 1 }, 4096))));
    await expect(frames.next(Date.now() + 1_000)).rejects.toThrow('reader_frame_queue_full');
    frames.close();
  });

  it.each(['coalesced', 'fragmented', 'delayed'] as const)('accepts the bounded three-frame inventory response when %s', async (mode) => {
    const stream = new PassThrough();
    const frames = new FrameStream(stream, FRAME_LIMITS.controlBytes, { maxQueuedFrames: 3, maxQueuedBytes: FRAME_LIMITS.controlBytes * 3 });
    const requestId = 'e'.repeat(32);
    const response = [
      { version: 1, requestId, sequence: 1, type: 'inventory' },
      { version: 1, requestId, sequence: 2, type: 'result' },
      { version: 1, requestId, sequence: 3, type: 'closed' },
    ].map((frame) => encodeFrame(frame, FRAME_LIMITS.controlBytes));
    if (mode === 'coalesced') stream.write(Buffer.concat(response));
    if (mode === 'fragmented') {
      const all = Buffer.concat(response);
      for (let offset = 0; offset < all.length; offset += 3) stream.write(all.subarray(offset, offset + 3));
    }
    const first = frames.next(Date.now() + 1_000);
    if (mode === 'delayed') {
      setTimeout(() => stream.write(Buffer.concat(response)), 10);
    }
    expect(await first).toMatchObject({ type: 'inventory' });
    expect(await frames.next(Date.now() + 1_000)).toMatchObject({ type: 'result' });
    expect(await frames.next(Date.now() + 1_000)).toMatchObject({ type: 'closed' });
    frames.close();
  });

  it('requires clean EOF after the closed frame and rejects queued trailing frames', async () => {
    const stream = new PassThrough();
    const frames = new FrameStream(stream, FRAME_LIMITS.controlBytes);
    const requestId = 'c'.repeat(32);
    const closed = { version: 1, requestId, sequence: 1, type: 'closed', sourceAccessed: false };
    const trailing = { version: 1, requestId, sequence: 2, type: 'inventory' };
    stream.write(Buffer.concat([encodeFrame(closed, 4096), encodeFrame(trailing, 4096)]));
    expect(await frames.next(Date.now() + 1_000)).toEqual(closed);
    stream.end();
    await expect(frames.expectCleanEnd(Date.now() + 1_000)).rejects.toThrow('reader_trailing_frame');
    frames.close();
  });

  it('rejects bytes after a terminal frame even when they form only a partial frame', async () => {
    const stream = new PassThrough();
    const frames = new FrameStream(stream, FRAME_LIMITS.controlBytes);
    const closed = { version: 1, requestId: 'd'.repeat(32), sequence: 1, type: 'closed', sourceAccessed: false };
    stream.write(encodeFrame(closed, 4096));
    expect(await frames.next(Date.now() + 1_000)).toEqual(closed);
    stream.write(Buffer.from([0, 0]));
    stream.end();
    await expect(frames.expectCleanEnd(Date.now() + 1_000)).rejects.toThrow('reader_trailing_bytes');
    frames.close();
  });

  it('cancels a clean-EOF wait and removes its pending wait state', async () => {
    const stream = new PassThrough();
    const frames = new FrameStream(stream, FRAME_LIMITS.controlBytes);
    const cancellation = new AbortController();
    const waiting = frames.expectCleanEnd(Date.now() + 5_000, cancellation.signal);
    cancellation.abort();
    await expect(waiting).rejects.toThrow('reader_cancelled');
    frames.close();
  });
});
