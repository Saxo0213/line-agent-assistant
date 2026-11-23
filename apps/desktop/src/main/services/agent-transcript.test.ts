import { describe, expect, it } from 'vitest';
import { buildTranscript, withTranscriptPreamble, type TranscriptEvent } from './agent-transcript.js';

const user = (text: string): TranscriptEvent => ({ role: 'user', text });
const assistant = (text: string): TranscriptEvent => ({ role: 'assistant', text });
const fill = (lineLength: number) => 'y'.repeat(lineLength - 'User: '.length);

describe('buildTranscript', () => {
  it('writes User and Assistant lines oldest first and compacts whitespace', () => {
    expect(buildTranscript([user('a \n\n  b'), assistant('  c\td ')])).toBe('User: a b\nAssistant: c d');
  });
  it('skips events with empty text', () => {
    expect(buildTranscript([user('one'), assistant('  \n '), user('')])).toBe('User: one');
    expect(buildTranscript([user(' ')])).toBe('');
    expect(buildTranscript([])).toBe('');
  });
  it('keeps only the last 24 events', () => {
    const events = Array.from({ length: 30 }, (_, index) => user(`m${index}`));
    const lines = buildTranscript(events).split('\n');
    expect(lines).toHaveLength(24);
    expect(lines[0]).toBe('User: m6');
    expect(lines.at(-1)).toBe('User: m29');
  });
  it('takes the 24-event window before it skips empty texts', () => {
    const events = [user('old'), ...Array.from({ length: 23 }, () => user('')), user('new')];
    expect(buildTranscript(events)).toBe('User: new');
  });
  it('stops at the first line, from the newest, that makes the total exceed 6000 and does not add it', () => {
    const lines = buildTranscript([user('old'), user(fill(3000)), user(fill(3000)), user('new')]).split('\n');
    // Walk: "new" 9, + 3000 = 3009, + 3000 = 6009 > 6000: stop. The second big line and "old" are lost.
    expect(lines).toEqual([`User: ${'y'.repeat(2994)}`, 'User: new']);
  });
  it('allows a total of exactly 6000 characters', () => {
    expect(buildTranscript([user(fill(3000)), user(fill(3000))]).split('\n')).toHaveLength(2);
    expect(buildTranscript([user(fill(3000)), user(fill(3001))]).split('\n')).toHaveLength(1);
  });
  it('counts characters, not UTF-16 units', () => {
    const emoji = '😀'.repeat(2990);
    expect(buildTranscript([user(emoji), user('z')])).toBe(`User: ${emoji}\nUser: z`);
  });
});

describe('withTranscriptPreamble', () => {
  it('puts the transcript before the trimmed current message', () => {
    expect(withTranscriptPreamble('  hello \n', 'User: a')).toBe('Recent LINEJS transcript for continuity:\nUser: a\n\nCurrent user message:\nhello');
  });
  it('leaves the message unchanged when the transcript is empty', () => {
    expect(withTranscriptPreamble('  hello ', '')).toBe('  hello ');
  });
});
