import { describe, expect, it } from 'vitest';
import { classifyPhotoText, combinePhotoVerdicts, normalizePhotoText } from './photo-text-match.js';

describe('photo text classification', () => {
  it('normalizes with NFKC and drops spaces and the listed punctuation', () => {
    expect(normalizePhotoText('王 小・明，（Ａ）')).toBe('王小明A');
    expect(normalizePhotoText('「張.三-豐」\n【x】_y')).toBe('張三豐xy');
  });

  it('hits when a pass contains the keyword, whatever the spacing and punctuation', () => {
    expect(classifyPhotoText(['本 日 簽 到 王 小 明'], ['王小明', '張三豐'])).toEqual({ state: 'hit', keywords: ['王小明'] });
    expect(classifyPhotoText(['沒有', '王·小明'], ['王小明'])).toEqual({ state: 'hit', keywords: ['王小明'] });
    expect(classifyPhotoText(['王小明 張三豐'], ['王小明', '張三豐'])).toEqual({ state: 'hit', keywords: ['王小明', '張三豐'] });
  });

  it('is unclear for a 3+ character keyword with one wrong character or two neighbouring characters', () => {
    expect(classifyPhotoText(['本日 張二豐 簽到'], ['張三豐'])).toEqual({ state: 'unclear', keywords: ['張三豐'] });
    expect(classifyPhotoText(['只看到 張三'], ['張三豐'])).toEqual({ state: 'unclear', keywords: ['張三豐'] });
    expect(classifyPhotoText(['只看到 三豐'], ['張三豐'])).toEqual({ state: 'unclear', keywords: ['張三豐'] });
    // A hit of another keyword wins over a near keyword.
    expect(classifyPhotoText(['王小明 張二豐'], ['王小明', '張三豐'])).toEqual({ state: 'hit', keywords: ['王小明'] });
  });

  it('never calls a 1-2 character keyword unclear, and misses when nothing is near', () => {
    expect(classifyPhotoText(['王大明'], ['王小'])).toEqual({ state: 'miss', keywords: [] });
    expect(classifyPhotoText(['王'], ['王小'])).toEqual({ state: 'miss', keywords: [] });
    expect(classifyPhotoText(['完全不同的文字'], ['張三豐'])).toEqual({ state: 'miss', keywords: [] });
    expect(classifyPhotoText([''], ['張三豐'])).toEqual({ state: 'miss', keywords: [] });
  });

  it('combines the photos of one message: hit, then unclear, then miss', () => {
    const miss = { state: 'miss' as const, keywords: [] };
    const near = { state: 'unclear' as const, keywords: ['張三豐'] };
    const hit = { state: 'hit' as const, keywords: ['王小明'] };
    expect(combinePhotoVerdicts([miss, near, hit, { state: 'hit', keywords: ['王小明', 'B'] }])).toEqual({ state: 'hit', keywords: ['王小明', 'B'] });
    expect(combinePhotoVerdicts([miss, near])).toEqual(near);
    expect(combinePhotoVerdicts([miss, miss])).toEqual(miss);
  });
});
