import type { MentionRange } from './line.js';
import type { MessageContent } from './line.js';

/**
 * Message-text storage contract shared by every writer of `messages.text_content`
 * (the live LINE path and the official-database native path), so readers never
 * branch on the source:
 *
 * - Secret substrings are replaced in place (never the whole message):
 *   `LW-XXXXXXXX` friend-invitation codes -> `[REDACTED_VERIFICATION_CODE]`,
 *   `RA-...` room-activation tokens -> `[REDACTED]`. Mention ranges are
 *   recomputed against the redacted text; a range that overlaps a replaced span
 *   is dropped.
 * - Only `text` messages carry a text body. Image, video, audio, file, sticker and
 *   contact messages store `text_content = NULL`; their payload lives in the
 *   attachment, sticker or contact descriptors.
 */
export const VERIFICATION_CODE_MARKER = '[REDACTED_VERIFICATION_CODE]';
export const ROOM_TOKEN_MARKER = '[REDACTED]';

const VERIFICATION_CODE = /LW-[A-HJ-NP-Z2-9]{8}/g;
const ROOM_TOKEN = /RA-[A-Za-z0-9_-]+/g;

const NON_TEXT_KINDS: ReadonlySet<string> = new Set(['image', 'video', 'audio', 'file', 'sticker', 'contact']);

export type RedactedText = Readonly<{ text: string; mentionRanges: MentionRange[]; redacted: boolean }>;

function replaceMatches(text: string, ranges: readonly MentionRange[], pattern: RegExp, marker: string): RedactedText {
  const spans = [...text.matchAll(pattern)].map((match) => ({ start: match.index!, end: match.index! + match[0].length }));
  if (spans.length === 0) return { text, mentionRanges: [...ranges], redacted: false };
  let result = '';
  let cursor = 0;
  for (const span of spans) {
    result += text.slice(cursor, span.start) + marker;
    cursor = span.end;
  }
  result += text.slice(cursor);
  const delta = marker.length;
  const shift = (offset: number): number => {
    let shifted = offset;
    for (const span of spans) if (span.end <= offset) shifted += delta - (span.end - span.start);
    return shifted;
  };
  const mentionRanges = ranges.flatMap((range): MentionRange[] => {
    if (spans.some((span) => span.start < range.end && span.end > range.start)) return [];
    return [{ ...range, start: shift(range.start), end: shift(range.end) }];
  });
  return { text: result, mentionRanges, redacted: true };
}

/** Friend-invitation verification codes only (the live path reads the raw text first to detect them). */
export function redactVerificationCodes(text: string, ranges: readonly MentionRange[] = []): RedactedText {
  return replaceMatches(text, ranges, VERIFICATION_CODE, VERIFICATION_CODE_MARKER);
}

/** Room-activation tokens only. */
export function redactRoomTokens(text: string, ranges: readonly MentionRange[] = []): RedactedText {
  return replaceMatches(text, ranges, ROOM_TOKEN, ROOM_TOKEN_MARKER);
}

/** Both secret classes, room tokens first (the order the live path applies them). */
export function redactSensitiveText(text: string, ranges: readonly MentionRange[] = []): RedactedText {
  const tokens = redactRoomTokens(text, ranges);
  const codes = redactVerificationCodes(tokens.text, tokens.mentionRanges);
  return { text: codes.text, mentionRanges: codes.mentionRanges, redacted: tokens.redacted || codes.redacted };
}

/** Free-form strings (attachment names, raw metadata values) with the same secret rules and no ranges. */
export function redactSensitiveString(value: string): string {
  return redactSensitiveText(value).text;
}

export function redactMessageContent(content: MessageContent): MessageContent {
  switch (content.type) {
    case 'unsent': return content;
    case 'contact': return { ...content, displayName: content.displayName === null ? null : redactSensitiveString(content.displayName) };
    case 'location': return { ...content,
      title: content.title === null ? null : redactSensitiveString(content.title),
      address: content.address === null ? null : redactSensitiveString(content.address) };
    case 'rich': return { ...content, altText: content.altText === null ? null : redactSensitiveString(content.altText) };
    case 'event': return { ...content, text: content.text === null ? null : redactSensitiveString(content.text) };
    case 'unsupported': return { ...content, fallbackText: content.fallbackText === null ? null : redactSensitiveString(content.fallbackText) };
    case 'media': return content;
  }
}

/** The `text_content` representation per message kind (see the contract above). */
export function storedTextForKind(kind: string, text: string | null): string | null {
  return NON_TEXT_KINDS.has(kind) ? null : text;
}
