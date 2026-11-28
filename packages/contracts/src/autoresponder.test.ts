import { describe, expect, it } from 'vitest';
import { normalizeAutoresponderTrigger, selectAutoresponderReply, splitAutoresponderReplies, validateAutoresponderConfig } from './autoresponder.js';

describe('deterministic autoresponder rules', () => {
  it('matches complete normalized strings while preserving case and punctuation', () => {
    const rules = [
      { trigger: '  hi   there ', reply: 'Hello' },
      { trigger: 'Hi there!', reply: 'Different' },
    ];
    expect(selectAutoresponderReply('hi\tthere', rules, 'I do not know')).toBe('Hello');
    expect(selectAutoresponderReply('Hi there!', rules, 'I do not know')).toBe('Different');
    expect(selectAutoresponderReply('HI THERE!', rules, 'I do not know')).toBe('I do not know');
  });

  it('normalizes NFC and rejects reserved commands, token forms, duplicates, and oversized settings', () => {
    expect(normalizeAutoresponderTrigger('  e\u0301   hi ')).toBe('é hi');
    expect(validateAutoresponderConfig({ displayName: 'Agent', fallback: '我不知道你在說甚麼', rules: [
      { trigger: 'monitor', reply: 'custom' },
    ] })).toContain('reserved');
    expect(validateAutoresponderConfig({ displayName: 'Agent', fallback: 'fallback', rules: [
      { trigger: 'x  y', reply: 'one' }, { trigger: 'x y', reply: 'two' },
    ] })).toContain('duplicate');
    expect(validateAutoresponderConfig({ displayName: 'Agent', fallback: 'fallback', rules: [
      { trigger: '\u76E3\u63A7', reply: 'custom' },
    ] })).toContain('reserved');
    expect(validateAutoresponderConfig({ displayName: 'Agent', fallback: ' ', rules: [] })).toContain('fallback');
  });

  it('splits replies on both semicolons, drops empty parts and picks one with the random parameter', () => {
    expect(splitAutoresponderReplies('甲；乙; 丙 ；；  ;')).toEqual(['甲', '乙', '丙']);
    expect(splitAutoresponderReplies('single')).toEqual(['single']);
    const rules = [{ trigger: 'hi', reply: 'A；B;C' }];
    expect(selectAutoresponderReply('hi', rules, 'x', () => 0)).toBe('A');
    expect(selectAutoresponderReply('hi', rules, 'x', () => 0.5)).toBe('B');
    expect(selectAutoresponderReply('hi', rules, 'x', () => 0.99)).toBe('C');
    expect(selectAutoresponderReply('other', rules, 'F1；F2', () => 0.6)).toBe('F2');
  });

  it('rejects a reply or fallback that has no non-empty part', () => {
    expect(validateAutoresponderConfig({ displayName: 'Agent', fallback: '；', rules: [] })).toContain('fallback');
    expect(validateAutoresponderConfig({ displayName: 'Agent', fallback: 'ok', rules: [{ trigger: 'a', reply: ' ; ； ' }] })).toContain('reply');
    expect(validateAutoresponderConfig({ displayName: 'Agent', fallback: 'ok；', rules: [{ trigger: 'a', reply: 'b；' }] })).toBeNull();
  });
});
