import { describe, expect, it } from 'vitest';
import { OUTGOING_MENTIONS_MAX, outgoingMentionsIssue } from '@line-agent/contracts';
import { resolveAgentMentions, type MentionCandidate } from './agent-mentions.js';

const mid = (n: number): string => `u${n.toString(16).padStart(32, '0')}`;
const member = (n: number, name: string): MentionCandidate => ({ mid: mid(n), name });
const SELF = mid(999);

const slices = (text: string, mentions: ReturnType<typeof resolveAgentMentions>): string[] =>
  mentions.map((mention) => text.slice(mention.start, mention.end));

describe('resolveAgentMentions', () => {
  it('mentions a unique member and keeps the text unchanged', () => {
    const text = '好的 @小明 這樣可以嗎';
    const mentions = resolveAgentMentions(text, [member(1, '小明'), member(2, '小華')], SELF);
    expect(mentions).toEqual([{ start: 3, end: 6, userId: mid(1) }]);
    expect(slices(text, mentions)).toEqual(['@小明']);
  });

  it('matches case-insensitively and ignores surrounding blanks in the member name', () => {
    const text = 'hi @AMY, done';
    expect(resolveAgentMentions(text, [member(1, '  amy ')], SELF)).toEqual([{ start: 3, end: 7, userId: mid(1) }]);
  });

  it('matches names that contain spaces and punctuation, longest name first', () => {
    const text = '@Amy Lin 你好，@Amy 也看一下，@王(小明) 請看';
    const mentions = resolveAgentMentions(text, [member(1, 'Amy'), member(2, 'Amy Lin'), member(3, '王(小明)')], SELF);
    expect(slices(text, mentions)).toEqual(['@Amy Lin', '@Amy', '@王(小明)']);
    expect(mentions.map((mention) => mention.userId)).toEqual([mid(2), mid(1), mid(3)]);
  });

  it('does not mention when two members share the normalized name, and does not fall back to a shorter name', () => {
    const text = '@小明明 你好 @小華';
    const mentions = resolveAgentMentions(text, [member(1, '小明明'), member(2, '小明明'), member(3, '小明'), member(4, '小華')], SELF);
    expect(slices(text, mentions)).toEqual(['@小華']);
  });

  it('leaves text alone when no member matches or the name is not a member', () => {
    expect(resolveAgentMentions('@不存在 你好', [member(1, '小明')], SELF)).toEqual([]);
    expect(resolveAgentMentions('沒有標註', [member(1, '小明')], SELF)).toEqual([]);
    expect(resolveAgentMentions('@小明', [], SELF)).toEqual([]);
  });

  it('never mentions the Agent itself, nor a shorter member name hidden behind the Agent name', () => {
    const agent: MentionCandidate = { mid: SELF, name: 'Bot Helper' };
    expect(resolveAgentMentions('@Bot Helper 我在', [agent, member(1, 'Bot')], SELF)).toEqual([]);
    expect(resolveAgentMentions('@Bot Helper', [agent], SELF)).toEqual([]);
  });

  it('ignores candidates whose MID is not a user MID', () => {
    expect(resolveAgentMentions('@小明', [{ mid: 'c-group', name: '小明' }, { mid: '成員 1234', name: '小明' }], SELF)).toEqual([]);
  });

  it('requires word boundaries for ASCII names and skips e-mail addresses', () => {
    expect(resolveAgentMentions('@Amyx', [member(1, 'Amy')], SELF)).toEqual([]);
    expect(resolveAgentMentions('mail me at x@Amy.com', [member(1, 'Amy')], SELF)).toEqual([]);
    expect(resolveAgentMentions('@Amy.', [member(1, 'Amy')], SELF)).toHaveLength(1);
  });

  it('ignores @ inside fenced code blocks', () => {
    const text = '```ts\n@小明\n```\n@小明';
    const mentions = resolveAgentMentions(text, [member(1, '小明')], SELF);
    expect(mentions).toEqual([{ start: text.lastIndexOf('@'), end: text.length, userId: mid(1) }]);
  });

  it('caps the result at the mention limit', () => {
    const text = Array.from({ length: 30 }, () => '@A').join(' ');
    const mentions = resolveAgentMentions(text, [member(1, 'A')], SELF);
    expect(mentions).toHaveLength(OUTGOING_MENTIONS_MAX);
    expect(outgoingMentionsIssue(text, mentions)).toBeNull();
  });

  it('uses UTF-16 offsets after emoji and produces ranges the contract accepts', () => {
    const text = '😀😀 @小明 👍 @Bob';
    const mentions = resolveAgentMentions(text, [member(1, '小明'), member(2, 'Bob')], SELF);
    expect(slices(text, mentions)).toEqual(['@小明', '@Bob']);
    expect(mentions[0]!.start).toBe(5);
    expect(outgoingMentionsIssue(text, mentions)).toBeNull();
  });

  it('matches a member whose name contains an emoji', () => {
    const text = 'ok @小明😀 ok';
    const mentions = resolveAgentMentions(text, [member(1, '小明😀')], SELF);
    expect(slices(text, mentions)).toEqual(['@小明😀']);
    expect(outgoingMentionsIssue(text, mentions)).toBeNull();
  });
});
