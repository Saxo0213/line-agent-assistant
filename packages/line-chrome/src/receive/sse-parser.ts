// Server-Sent-Events frame parser. Port of the line loop in OkLine okline/operations.py:395-425 (`_open_sse`), extended to
// the full SSE line grammar so that frames split across chunks, CRLF/CR/LF endings and multi-line data all work.

export interface SseFrame {
  /** Event name; "" for the unnamed default event. */
  readonly event: string;
  /** The data lines joined by "\n". */
  readonly data: string;
  readonly id: string | null;
}

export class SseParser {
  private buffer = '';
  private event = '';
  private data: string[] = [];
  private id: string | null = null;
  /** True when the previous chunk ended with CR: one LF at the start of the next non-empty chunk belongs to that CRLF (A31). */
  private pendingLf = false;

  /**
   * Feed decoded text; returns the frames completed by it. Incomplete trailing data is kept for the next call.
   * `onLine` runs once for each completed line, also for a comment line and a blank line (a liveness signal).
   */
  feed(text: string, onLine?: () => void): SseFrame[] {
    let input = text;
    if (this.pendingLf && input !== '') {
      this.pendingLf = false;
      if (input.startsWith('\n')) input = input.slice(1);
    }
    this.buffer += input;
    const frames: SseFrame[] = [];
    let start = 0;
    for (let i = 0; i < this.buffer.length; i += 1) {
      const c = this.buffer[i]!;
      if (c !== '\n' && c !== '\r') continue;
      const line = this.buffer.slice(start, i);
      if (c === '\r') {
        // A CR ends the line at once (requests iter_lines / str.splitlines, OkLine operations.py:437). One LF after it is part of the same line end (A31).
        if (i === this.buffer.length - 1) this.pendingLf = true;
        else if (this.buffer[i + 1] === '\n') i += 1;
      }
      start = i + 1;
      onLine?.();
      const frame = this.line(line);
      if (frame) frames.push(frame);
    }
    this.buffer = this.buffer.slice(start);
    return frames;
  }

  private line(line: string): SseFrame | null {
    if (line === '') {
      // Dispatch only when data is present (OkLine operations.py:441-449; EventSource does the same). A bare `event: ping`
      // is not dispatched. The receiver sees it as activity through the `onLine` callback.
      const dispatch = this.data.length > 0;
      const frame: SseFrame | null = dispatch ? { event: this.event, data: this.data.join('\n'), id: this.id } : null;
      this.event = '';
      this.data = [];
      return frame;
    }
    if (line.startsWith(':')) return null; // comment
    const colon = line.indexOf(':');
    const field = colon < 0 ? line : line.slice(0, colon);
    let value = colon < 0 ? '' : line.slice(colon + 1);
    if (value.startsWith(' ')) value = value.slice(1);
    if (field === 'event') {
      this.event = value;
    } else if (field === 'data') {
      this.data.push(value);
    } else if (field === 'id') {
      if (!value.includes('\0')) this.id = value;
    }
    return null;
  }
}
