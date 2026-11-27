// The @ mention of the composer: pure text helpers. Offsets are UTF-16 code units, the unit of the LINE MENTION metadata.
import type { OutgoingMention } from '@line-agent/contracts';

/** One inserted mention. `text` is the inserted `@name` (without the space after it). */
export interface MentionRecord { start: number; end: number; mid: string; text: string }
export interface MentionMember { mid: string; name: string }

/** The member name that the list shows and that the inserted text uses. A member without a stored name shows the last 4 characters of the MID. */
export const mentionDisplayName = (member: MentionMember): string => member.name.trim() || `…${member.mid.slice(-4)}`;

/**
 * The open `@` query at the caret: an `@` at the start of the text or after a space, and no space between it and the caret.
 * Returns the offset of the `@` and the text typed after it, or null.
 */
export function findMentionQuery(text: string, caret: number): { start: number; query: string } | null {
  if (caret < 1 || caret > text.length) return null;
  for (let index = caret - 1; index >= 0; index -= 1) {
    const char = text[index]!;
    if (/\s/u.test(char)) return null;
    if (char === '@') {
      const before = index === 0 ? '' : text[index - 1]!;
      if (before !== '' && !/\s/u.test(before)) return null;
      return { start: index, query: text.slice(index + 1, caret) };
    }
  }
  return null;
}

/** Members whose name contains the query (case-insensitive). An empty query keeps every member. */
export function filterMentionMembers(members: readonly MentionMember[], query: string): MentionMember[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return [...members];
  return members.filter((member) => mentionDisplayName(member).toLowerCase().includes(needle));
}

/**
 * Moves the records after one text edit that replaced `removed` characters at `at` with `inserted` characters.
 * A record that the edit touches is removed. A record after the edit shifts.
 */
export function shiftMentionRecords(records: readonly MentionRecord[], at: number, removed: number, inserted: number): MentionRecord[] {
  const delta = inserted - removed;
  const result: MentionRecord[] = [];
  for (const record of records) {
    if (record.end <= at) result.push(record);
    else if (record.start >= at + removed) result.push({ ...record, start: record.start + delta, end: record.end + delta });
  }
  return result;
}

/** Updates the records after the textarea changed from `previous` to `next`. A record whose text no longer reads `@name` is dropped. */
export function reconcileMentionRecords(records: readonly MentionRecord[], previous: string, next: string): MentionRecord[] {
  if (records.length === 0 || previous === next) return [...records];
  let prefix = 0;
  const limit = Math.min(previous.length, next.length);
  while (prefix < limit && previous[prefix] === next[prefix]) prefix += 1;
  let suffix = 0;
  while (suffix < limit - prefix && previous[previous.length - 1 - suffix] === next[next.length - 1 - suffix]) suffix += 1;
  const removed = previous.length - prefix - suffix;
  const inserted = next.length - prefix - suffix;
  return shiftMentionRecords(records, prefix, removed, inserted).filter((record) => next.slice(record.start, record.end) === record.text);
}

/** Replaces the typed `@query` (from `queryStart` to `caret`) with `@name ` and records the mention. */
export function insertMention(text: string, queryStart: number, caret: number, member: MentionMember, records: readonly MentionRecord[]):
  { text: string; caret: number; records: MentionRecord[] } {
  const label = `@${mentionDisplayName(member)}`;
  const nextText = `${text.slice(0, queryStart)}${label} ${text.slice(caret)}`;
  const shifted = shiftMentionRecords(records, queryStart, caret - queryStart, label.length + 1);
  const record: MentionRecord = { start: queryStart, end: queryStart + label.length, mid: member.mid, text: label };
  return { text: nextText, caret: queryStart + label.length + 1, records: [...shifted, record].sort((left, right) => left.start - right.start) };
}

/**
 * The mentions to send with the trimmed text. `draft` is the text in the box and the sent text is `draft.trim()`,
 * so the offsets move by the removed leading space. A record outside the sent text is dropped.
 */
export function buildOutgoingMentions(draft: string, records: readonly MentionRecord[]): OutgoingMention[] {
  const sent = draft.trim();
  const lead = draft.length - draft.trimStart().length;
  const result: OutgoingMention[] = [];
  for (const record of records) {
    const start = record.start - lead;
    const end = record.end - lead;
    if (start < 0 || end > sent.length || sent.slice(start, end) !== record.text) continue;
    result.push({ start, end, userId: record.mid });
  }
  return result;
}
