import { NativeSourceEnvelopeSchema, type SticonRange } from '@line-agent/contracts';
import {
  remapSticonRangesForDisplay, sticonRangesFromLiveRaw, sticonRangesFromNativeEnvelope, sticonSourceTextFromNativeEnvelope,
} from '@line-agent/database';

export type ProjectedSticon = Readonly<{ start: number; end: number; resource: SticonRange }>;

/** The single sticon projection: timeline, chat-list preview and the sticon media handler all call this. */
export function projectSticons(raw: Record<string, unknown>, storedText: string | null): ProjectedSticon[] {
  const native = NativeSourceEnvelopeSchema.safeParse(raw.native);
  if (native.success) {
    const sourceText = sticonSourceTextFromNativeEnvelope(native.data) ?? '';
    return remapSticonRangesForDisplay(sourceText, sticonRangesFromNativeEnvelope(native.data))
      .map((resource) => ({ start: resource.start, end: resource.end, resource }));
  }
  if (storedText === null || storedText.includes('[REDACTED')) return [];
  return sticonRangesFromLiveRaw(raw).map((resource) => ({ start: resource.start, end: resource.end, resource }));
}

/**
 * SQL expression (over `<column>`, a messages.raw jsonb) that keeps only the bounded raw fields `projectSticons` reads.
 * Shared by the timeline, the sticon media handler and the chat-list snapshot.
 */
export function boundedSticonRawSql(column = 'raw'): string {
  const cells = `${column}->'native'->'row'->'cells'`;
  const index = (name: string) => `(array_position(ARRAY(SELECT jsonb_array_elements_text(${column}->'native'->'row'->'columns')), '${name}')-1)`;
  return `CASE WHEN ${column} ? 'native' AND ${column}->'native'->>'format'='2' AND ${column}->'native'->>'table'='_message' THEN
    jsonb_build_object('native',jsonb_build_object('format',2,'encoding','plain','table','_message','sourceDigest',${column}->'native'->>'sourceDigest',
      'row',jsonb_build_object('columns',jsonb_build_array('_text','_contentMetadata'),'cells',jsonb_build_array(
        CASE WHEN octet_length((${cells}->${index('_text')})::text)<=8192 THEN ${cells}->${index('_text')} ELSE NULL END,
        CASE WHEN (jsonb_typeof(${cells}->${index('_contentMetadata')})='string'
            AND octet_length((${cells}->${index('_contentMetadata')}) #>> '{}')<=16384)
            OR octet_length(${cells}->${index('_contentMetadata')}->>'data')<=21848
            THEN ${cells}->${index('_contentMetadata')} ELSE NULL END))))
  ELSE jsonb_build_object('message',jsonb_build_object('text',CASE WHEN char_length(${column}->'message'->>'text')<=4096 THEN ${column}->'message'->'text' ELSE NULL END,
    'contentMetadata',CASE WHEN octet_length((${column}->'message'->'contentMetadata')::text)<=16384 THEN ${column}->'message'->'contentMetadata' ELSE NULL END)) END`;
}

const OBJECT_REPLACEMENT = '￼';
const PRIVATE_USE_SUPPLEMENTARY = /[\u{F0000}-\u{10FFFF}]/gu;
export const PREVIEW_STICON_LIMIT = 16;

/**
 * Chat-list preview of a text message: each of the first 16 sticon ranges becomes one U+FFFC placeholder (range i is
 * the i-th sticon of the message, as for the media handler) and every other supplementary private-use code point is
 * dropped. The result is trimmed and the ranges are re-based onto it.
 */
export function previewWithSticons(text: string, projected: readonly ProjectedSticon[]): { text: string; ranges: SticonRange[] } {
  const used = projected.slice(0, PREVIEW_STICON_LIMIT);
  let out = '';
  let cursor = 0;
  const placed: Array<{ at: number; resource: SticonRange }> = [];
  for (const item of used) {
    // An out-of-bounds or overlapping range would shift every later index: stop, never skip.
    if (item.start < cursor || item.end > text.length || item.start >= item.end) break;
    out += text.slice(cursor, item.start).replace(PRIVATE_USE_SUPPLEMENTARY, '');
    placed.push({ at: out.length, resource: item.resource });
    out += OBJECT_REPLACEMENT;
    cursor = item.end;
  }
  out += text.slice(cursor).replace(PRIVATE_USE_SUPPLEMENTARY, '');
  const lead = out.length - out.trimStart().length;
  const trimmed = out.trim();
  const ranges = placed.flatMap(({ at, resource }) => at - lead >= 0 && at - lead < trimmed.length
    ? [{ ...resource, start: at - lead, end: at - lead + 1 }] : []);
  return { text: trimmed, ranges };
}
