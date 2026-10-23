import { describe, expect, it } from 'vitest';
import { nativeReactions } from './native-reactions.js';
import { SAMPLE_FUN, SAMPLE_NICE, SAMPLE_PAID } from './native-reactions.fixtures.js';

const rawWith = (cell: unknown, columns: unknown = ['_id', '_reactionStatus']) => ({ native: { row: { columns, cells: ['1', cell] } } });
const entry = (reactor: string, extra: Record<string, unknown> = {}) =>
  ({ reactor, type: 1, PredefinedType: 2, PaidType: {}, createdAt: 1000, updatedAt: 1000, ...extra });
const statusOf = (...entries: unknown[]) => JSON.stringify({ reactionList: entries, totalCount: 0, countByType: {} });

describe('nativeReactions', () => {
  it('parses the synthetic predefined and paid samples', () => {
    expect(nativeReactions(rawWith(SAMPLE_NICE))).toEqual([{ kind: 'NICE', count: 1, reactorIds: ['u00000000000000000000000000000001'] }]);
    expect(nativeReactions(rawWith(SAMPLE_FUN))).toEqual([{ kind: 'FUN', count: 1, reactorIds: ['u00000000000000000000000000000002'] }]);
    expect(nativeReactions(rawWith(SAMPLE_PAID))).toEqual([{ kind: 'PAID', productId: '60ebfdc03cc24041bb139cf5', emojiId: '004', count: 1, reactorIds: ['u00000000000000000000000000000003'] }]);
  });

  it('accepts the { value, sqliteType } cell wrapper', () => {
    expect(nativeReactions(rawWith({ value: SAMPLE_NICE, sqliteType: 'text' }))).toHaveLength(1);
  });

  it('aggregates NICE from different reactors into one group', () => {
    const result = nativeReactions(rawWith(statusOf(entry('ua'), entry('ub'), entry('uc'))));
    expect(result).toEqual([{ kind: 'NICE', count: 3, reactorIds: ['ua', 'ub', 'uc'] }]);
  });

  it('skips duplicate entries from the same reactor and group', () => {
    expect(nativeReactions(rawWith(statusOf(entry('ua'), entry('ua', { createdAt: 2000 }))))[0]).toMatchObject({ count: 1, reactorIds: ['ua'] });
  });

  it('skips cancel:true and keeps absent cancel', () => {
    const result = nativeReactions(rawWith(statusOf(entry('ua', { cancel: true }), entry('ub'))));
    expect(result).toEqual([{ kind: 'NICE', count: 1, reactorIds: ['ub'] }]);
  });

  it('skips unknown PredefinedType and unknown type', () => {
    expect(nativeReactions(rawWith(statusOf(entry('ua', { PredefinedType: 1 }), entry('ub', { PredefinedType: 8 }), entry('uc', { type: 3 }))))).toEqual([]);
  });

  it('skips paid entries with bad ids', () => {
    const paid = (paidType: unknown) => entry('ua', { type: 2, PaidType: paidType });
    expect(nativeReactions(rawWith(statusOf(
      paid({ productId: 'XYZ', emojiId: '004' }), paid({ productId: '60ebfdc03cc24041bb139cf5', emojiId: 'abc' }),
      paid({ productId: '60ebfdc03cc24041bb139cf5', emojiId: '1234567' }), paid({ productId: '60EBFDC03CC24041BB139CF5', emojiId: '1' }),
      paid({}), paid(null), paid({ productId: 1, emojiId: 2 }),
    )))).toEqual([]);
  });

  it('returns [] for missing, null, empty, invalid or wrongly shaped cells', () => {
    for (const raw of [null, undefined, 'x', 1, [], {}, { native: {} }, { native: { row: {} } },
      rawWith(null), rawWith(''), rawWith('{not json'), rawWith('[]'), rawWith('{}'), rawWith('{"reactionList":"x"}'),
      rawWith(SAMPLE_NICE, ['_id', 'other']), rawWith(SAMPLE_NICE, 'broken'), { native: { row: { columns: ['_reactionStatus'], cells: [] } } }]) {
      expect(nativeReactions(raw)).toEqual([]);
    }
  });

  it('caps groups at 20 and reactors at 50 while count stays true', () => {
    const many = Array.from({ length: 60 }, (_, i) => entry(`u${i}`));
    const result = nativeReactions(rawWith(statusOf(...many)));
    expect(result[0]!.count).toBe(60);
    expect(result[0]!.reactorIds).toHaveLength(50);
    const groups = Array.from({ length: 25 }, (_, i) => entry('ua', { type: 2, PaidType: { productId: '60ebfdc03cc24041bb139cf5', emojiId: String(i + 1) } }));
    expect(nativeReactions(rawWith(statusOf(...groups)))).toHaveLength(20);
  });

  it('orders groups by earliest createdAt', () => {
    const result = nativeReactions(rawWith(statusOf(
      entry('ua', { PredefinedType: 3, createdAt: 3000 }), entry('ub', { PredefinedType: 5, createdAt: 1000 }),
      entry('uc', { PredefinedType: 3, createdAt: 500 }), entry('ud', { PredefinedType: 7, createdAt: 2000 }))));
    expect(result.map((group) => group.kind)).toEqual(['LOVE', 'AMAZING', 'OMG']);
  });
});
