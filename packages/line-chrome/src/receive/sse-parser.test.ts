import { describe, expect, it } from 'vitest';
import { SseParser } from './sse-parser.js';

describe('SseParser', () => {
  it('parses named and unnamed events with ids', () => {
    const p = new SseParser();
    const frames = p.feed('event: ping\ndata: {}\n\nid: 7\ndata: [1]\n\n');
    expect(frames).toEqual([
      { event: 'ping', data: '{}', id: null },
      { event: '', data: '[1]', id: '7' },
    ]);
  });

  it('joins multi-line data with newlines', () => {
    expect(new SseParser().feed('data: a\ndata: b\ndata:c\n\n')).toEqual([{ event: '', data: 'a\nb\nc', id: null }]);
  });

  it('skips comments and ignores unknown fields', () => {
    expect(new SseParser().feed(': keepalive\nretry: 5000\nfoo: bar\ndata: x\n\n')).toEqual([{ event: '', data: 'x', id: null }]);
  });

  it('handles frames split at every byte boundary', () => {
    const wire = 'event: fullSync\ndata: {"nextRevision":9}\n\n: c\ndata: [{"revision":10}]\n\n';
    const expected = [
      { event: 'fullSync', data: '{"nextRevision":9}', id: null },
      { event: '', data: '[{"revision":10}]', id: null },
    ];
    expect(new SseParser().feed(wire)).toEqual(expected);
    const p = new SseParser();
    const out = [];
    for (const ch of wire) out.push(...p.feed(ch));
    expect(out).toEqual(expected);
  });

  it('handles CRLF and bare CR, including CRLF split across chunks', () => {
    const p = new SseParser();
    // a CR ends a line at once, also as the last character of a chunk (A31)
    expect(p.feed('data: a\r\n\r\ndata: b\r\r')).toEqual([
      { event: '', data: 'a', id: null },
      { event: '', data: 'b', id: null },
    ]);
    expect(p.feed('data: c\n\n')).toEqual([{ event: '', data: 'c', id: null }]);
    const split = new SseParser();
    expect([...split.feed('data: a\r'), ...split.feed('\n\r'), ...split.feed('\n')]).toEqual([{ event: '', data: 'a', id: null }]);
  });

  it('a double CR dispatches at once and runs onLine twice', () => {
    const p = new SseParser();
    let lines = 0;
    expect(p.feed('data: {"type":26,"revision":101}\r\r', () => { lines += 1; })).toEqual([{ event: '', data: '{"type":26,"revision":101}', id: null }]);
    expect(lines).toBe(2);
  });

  it('the LF of a CRLF split across chunks is not a line', () => {
    const p = new SseParser();
    let lines = 0;
    const cb = () => { lines += 1; };
    expect(p.feed('data: a\r', cb)).toEqual([]);
    expect(lines).toBe(1);
    expect(p.feed('\n\r\n', cb)).toEqual([{ event: '', data: 'a', id: null }]);
    expect(lines).toBe(2);
  });

  it('an empty chunk between CR and LF does not cancel the pending LF', () => {
    const p = new SseParser();
    expect(p.feed('event: fullSync\r')).toEqual([]);
    expect(p.feed('')).toEqual([]);
    expect(p.feed('\ndata: {"nextRevision":9}\n\n')).toEqual([{ event: 'fullSync', data: '{"nextRevision":9}', id: null }]);
  });

  it('LF then CR: both end a line, so the frame is dispatched at once', () => {
    expect(new SseParser().feed('data: a\n\r')).toEqual([{ event: '', data: 'a', id: null }]);
  });

  it('does not dispatch an incomplete frame, nor a dataless unnamed one', () => {
    const p = new SseParser();
    expect(p.feed('data: partial')).toEqual([]);
    expect(p.feed('\n')).toEqual([]);
    expect(p.feed('\n')).toEqual([{ event: '', data: 'partial', id: null }]);
    expect(p.feed('id: 1\n\n')).toEqual([]);
  });

  it('does not dispatch a named event without data (a bare ping), but reports every line', () => {
    const p = new SseParser();
    let lines = 0;
    expect(p.feed('event: ping\n\n', () => { lines += 1; })).toEqual([]);
    expect(lines).toBe(2);
  });

  it('reports a comment line and a blank line through the line callback without a frame', () => {
    const p = new SseParser();
    let lines = 0;
    expect(p.feed(': keepalive\n', () => { lines += 1; })).toEqual([]);
    expect(p.feed('\n', () => { lines += 1; })).toEqual([]);
    expect(p.feed('data: x', () => { lines += 1; })).toEqual([]); // an incomplete line is not reported
    expect(lines).toBe(2);
  });

  it('resets event name and data between frames', () => {
    const frames = new SseParser().feed('event: a\ndata: 1\n\ndata: 2\n\n');
    expect(frames.map((f) => f.event)).toEqual(['a', '']);
  });

  it('keeps the value verbatim after a single leading space', () => {
    expect(new SseParser().feed('data:  two\n\n')[0]!.data).toBe(' two');
  });
});
