import { OUTGOING_MENTIONS_MAX, type OutgoingMention } from '@line-agent/contracts';

/** A chat member the Agent may mention. `name` is the display name shown in the chat history (contact nickname, contact name, member name). */
export interface MentionCandidate { mid: string; name: string }

const USER_MID = /^u[0-9a-fA-F]{32}$/;
const WORD_CHAR = /[A-Za-z0-9_]/;
const FENCE = /(^|\n)```[^\n]*\n[\s\S]*?\n```(?=\n|$)/g;

const normalizeName = (name: string): string => name.trim().toLowerCase();

/** [start, end) ranges of fenced code blocks, where `@` is code rather than a mention. */
function fencedRanges(text: string): Array<[number, number]> {
  return [...text.matchAll(FENCE)].map((match) => [match.index!, match.index! + match[0].length] as [number, number]);
}

/**
 * Converts `@name` in an Agent reply into LINE mention ranges (UTF-16 offsets into `text`; the text itself is not changed).
 *
 * - Only members whose normalized (trimmed, case-insensitive) display name equals the text after `@` are mentioned; the longest
 *   name wins, so names with spaces or punctuation work and "Amy Lin" beats "Amy".
 * - Two different members with the same normalized name are ambiguous: that `@` is left as plain text (no shorter fallback).
 * - `selfMid` and anything that is not a user MID is never mentioned. At most OUTGOING_MENTIONS_MAX mentions are produced.
 * - An ASCII word character directly before `@` (an e-mail address) or directly after a name that ends in one (`@Amyx` for
 *   `Amy`) is not a mention. `@` inside fenced code blocks is ignored.
 */
export function resolveAgentMentions(text: string, candidates: readonly MentionCandidate[], selfMid: string | null = null): OutgoingMention[] {
  if (!text.includes('@') || candidates.length === 0) return [];
  // The Agent's own name takes part in the longest-match contest (as a name that is never mentioned), so "@Bot Helper"
  // is not turned into a mention of a member called "Bot" when the Agent is "Bot Helper".
  const members = new Map<string, { name: string; length: number; mids: Set<string>; self: boolean }>();
  for (const candidate of candidates) {
    const trimmed = candidate.name.trim();
    if (!trimmed || !USER_MID.test(candidate.mid)) continue;
    const key = normalizeName(trimmed);
    const entry = members.get(key) ?? { name: key, length: trimmed.length, mids: new Set<string>(), self: false };
    if (candidate.mid === selfMid) entry.self = true;
    else entry.mids.add(candidate.mid);
    members.set(key, entry);
  }
  const names = [...members.values()].sort((left, right) => right.length - left.length);
  const fences = fencedRanges(text);
  const result: OutgoingMention[] = [];
  for (let at = text.indexOf('@'); at >= 0 && result.length < OUTGOING_MENTIONS_MAX; at = text.indexOf('@', at + 1)) {
    if (fences.some(([start, end]) => at >= start && at < end)) continue;
    if (at > 0 && WORD_CHAR.test(text[at - 1]!)) continue;
    for (const entry of names) {
      const end = at + 1 + entry.length;
      if (end > text.length) continue;
      if (text.slice(at + 1, end).toLowerCase() !== entry.name) continue;
      if (WORD_CHAR.test(entry.name.at(-1)!) && end < text.length && WORD_CHAR.test(text[end]!)) continue;
      if (entry.mids.size === 1 && !entry.self) {
        const [userId] = entry.mids;
        result.push({ start: at, end, userId: userId! });
      }
      // Longest match decides: an ambiguous name is not retried with a shorter one.
      at = end - 1;
      break;
    }
  }
  return result;
}
