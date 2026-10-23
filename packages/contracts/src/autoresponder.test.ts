import { describe, expect, it } from 'vitest';
import { normalizeAutoresponderTrigger, selectAutoresponderReply, validateAutoresponderConfig } from './autoresponder.js';

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
});
