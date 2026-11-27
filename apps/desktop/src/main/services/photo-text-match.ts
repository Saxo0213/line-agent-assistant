/** The verdict of the keywords on the text of one photo, or of all photos of one message. `keywords` are the original (not normalized) ones. */
export type PhotoTextVerdict = { state: 'hit' | 'unclear' | 'miss'; keywords: string[] };

const IGNORED = /[\s·・.,，。:：;；\-－_()（）[\]【】「」'"]/gu;

/** NFKC, then no whitespace and none of the punctuation marks that OCR drops or adds. */
export function normalizePhotoText(text: string): string {
  return text.normalize('NFKC').replace(IGNORED, '');
}

/** A window of the keyword length in the text that differs from the keyword in exactly one character. */
function hasOneCharacterDifference(text: readonly string[], keyword: readonly string[]): boolean {
  for (let start = 0; start + keyword.length <= text.length; start++) {
    let different = 0;
    for (let offset = 0; offset < keyword.length && different < 2; offset++) if (text[start + offset] !== keyword[offset]) different++;
    if (different === 1) return true;
  }
  return false;
}

function hasKeywordPair(text: string, keyword: readonly string[]): boolean {
  for (let index = 0; index + 1 < keyword.length; index++) if (text.includes(`${keyword[index]}${keyword[index + 1]}`)) return true;
  return false;
}

/**
 * hit: a pass text contains the keyword. unclear (keyword of 3+ characters only): no hit, and a pass text has a window
 * of the keyword length with one wrong character, or contains two neighbouring characters of the keyword. Else miss.
 */
export function classifyPhotoText(passTexts: readonly string[], keywords: readonly string[]): PhotoTextVerdict {
  const texts = passTexts.map(normalizePhotoText);
  const characters = texts.map((text) => Array.from(text));
  const hit: string[] = [];
  const near: string[] = [];
  for (const original of keywords) {
    const keyword = normalizePhotoText(original);
    if (keyword.length === 0) continue;
    if (texts.some((text) => text.includes(keyword))) { hit.push(original); continue; }
    const symbols = Array.from(keyword);
    if (symbols.length < 3) continue;
    if (texts.some((text, index) => hasOneCharacterDifference(characters[index]!, symbols) || hasKeywordPair(text, symbols))) near.push(original);
  }
  if (hit.length > 0) return { state: 'hit', keywords: hit };
  if (near.length > 0) return { state: 'unclear', keywords: near };
  return { state: 'miss', keywords: [] };
}

/** Several photos of one message: hit if any photo hits, else unclear if any is unclear, else miss. The keyword lists are merged without repeats. */
export function combinePhotoVerdicts(verdicts: readonly PhotoTextVerdict[]): PhotoTextVerdict {
  for (const state of ['hit', 'unclear'] as const) {
    const matching = verdicts.filter((verdict) => verdict.state === state);
    if (matching.length > 0) return { state, keywords: [...new Set(matching.flatMap((verdict) => verdict.keywords))] };
  }
  return { state: 'miss', keywords: [] };
}
