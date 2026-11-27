import { describe, expect, it } from 'vitest';
import { parseLineContactLink } from './line-contact-link.js';

const MID = `u${'a1'.repeat(16)}`;

describe('parseLineContactLink', () => {
  it('accepts a profile link and a bare user MID', () => {
    expect(parseLineContactLink(`line://nv/profilePopup/mid=${MID}`)).toBe(MID);
    expect(parseLineContactLink(`  ${MID.toUpperCase().replace(/^U/, 'u')}  `)).toBe(MID);
    expect(parseLineContactLink(MID)).toBe(MID);
  });

  it('rejects every other text', () => {
    for (const text of ['', 'hello', `c${'a'.repeat(32)}`, `u${'a'.repeat(31)}`, `u${'g'.repeat(32)}`,
      `https://line.me/ti/p/${MID}`, `line://nv/profilePopup/mid=${MID}&x=1`, `line://nv/chat/mid=${MID}`, `line://nv/profilePopup/mid=c${'a'.repeat(32)}`]) {
      expect(parseLineContactLink(text)).toBeNull();
    }
  });
});
