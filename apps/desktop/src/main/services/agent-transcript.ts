/** Transcript preamble of a new resident Claude process (CliTalkAgent chat.rs recent_session_transcript, prompt_user_with_session_context). */
export interface TranscriptEvent { role: 'user' | 'assistant'; text: string }

export const TRANSCRIPT_MAX_EVENTS = 24;
export const TRANSCRIPT_MAX_CHARS = 6000;

const compact = (value: string): string => value.split(/\s+/).filter(Boolean).join(' ');

/**
 * Takes the last 24 events and walks them from newest to oldest. A line over the 6000-character total stops the walk and is not added.
 * Empty texts are skipped. Returns the lines oldest first, or an empty string when no line stays.
 */
export function buildTranscript(events: readonly TranscriptEvent[]): string {
  const lines: string[] = [];
  let total = 0;
  for (const event of events.slice(Math.max(0, events.length - TRANSCRIPT_MAX_EVENTS)).reverse()) {
    const text = compact(event.text);
    if (!text) continue;
    const line = `${event.role === 'user' ? 'User' : 'Assistant'}: ${text}`;
    total += [...line].length;
    if (total > TRANSCRIPT_MAX_CHARS) break;
    lines.push(line);
  }
  return lines.reverse().join('\n');
}

/** The resident turn message with the transcript in front; unchanged when the transcript is empty. */
export function withTranscriptPreamble(message: string, transcript: string): string {
  return transcript ? `Recent LINEJS transcript for continuity:\n${transcript}\n\nCurrent user message:\n${message.trim()}` : message;
}
