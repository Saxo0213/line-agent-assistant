import { describe, expect, it, vi } from 'vitest';
import { parseSticonRanges } from './index.js';

const productId = '0123456789abcdef01234567';
const metadata = (resources: unknown[]) => ({ REPLACE: JSON.stringify({ sticon: { resources } }) });

describe('parseSticonRanges', () => {
  it('parses static, animated, and multiple ordered resources', () => {
    expect(parseSticonRanges('(pray)and(x)', metadata([
      { S: 0, E: 6, resourceType: 'STATIC', sticonId: '001', productId },
      { S: 9, E: 12, resourceType: 'ANIMATION', sticonId: '2', productId },
    ]))).toEqual([
      { start: 0, end: 6, productId, sticonId: '001', animated: false },
      { start: 9, end: 12, productId, sticonId: '2', animated: true },
    ]);
  });

  it('rejects overlap, out of range, malformed input, and more than 64 resources', () => {
    const r = (S: number, E: number) => ({ S, E, resourceType: 'STATIC', sticonId: '1', productId });
    expect(parseSticonRanges('abcdef', metadata([r(0, 4), r(3, 6)]))).toEqual([]);
    expect(parseSticonRanges('abc', metadata([r(0, 4)]))).toEqual([]);
    expect(parseSticonRanges('abc', { REPLACE: '{bad' })).toEqual([]);
    expect(parseSticonRanges('x'.repeat(64), metadata(Array.from({ length: 65 }, (_, i) => r(i, i + 1))))).toEqual([]);
  });

  it('limits REPLACE by UTF-8 bytes before parsing', () => {
    const overhead = new TextEncoder().encode('{"padding":"","sticon":{"resources":[]}}').length;
    const wrap = (target: number) => {
      const fill = target - overhead;
      return `{"padding":"${'é'.repeat(Math.floor(fill / 2))}${fill % 2 ? 'a' : ''}","sticon":{"resources":[]}}`;
    };
    const accepted = wrap(16_384);
    expect(new TextEncoder().encode(accepted).length).toBe(16_384);
    const parse = vi.spyOn(JSON, 'parse');
    expect(parseSticonRanges('x', { REPLACE: accepted })).toEqual([]);
    expect(parse).toHaveBeenCalledOnce();
    parse.mockClear();
    const tooLarge = wrap(16_385);
    expect(new TextEncoder().encode(tooLarge).length).toBe(16_385);
    expect(parseSticonRanges('x', { REPLACE: tooLarge })).toEqual([]);
    expect(parse).not.toHaveBeenCalled();
    parse.mockRestore();
  });
});
