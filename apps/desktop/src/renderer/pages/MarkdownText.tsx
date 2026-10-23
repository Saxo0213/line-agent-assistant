import React, { useMemo, useRef } from 'react';

/**
 * Small in-house Markdown renderer for Agent replies. Safe by construction:
 * it only builds React elements (no raw HTML, no dangerouslySetInnerHTML), links are
 * limited to http/https, and both the block and inline parsers are linear-time with a
 * hard work budget, so no input can hang the renderer.
 */

type Align = 'left' | 'center' | 'right' | null;
interface ListNode { ordered: boolean; start: number; items: ListItem[] }
interface ListItem { text: string; children: ListNode | null }
type Block =
  | { t: 'heading'; level: number; text: string }
  | { t: 'para'; text: string }
  | { t: 'code'; text: string }
  | { t: 'hr' }
  | { t: 'quote'; blocks: Block[] }
  | { t: 'list'; list: ListNode }
  | { t: 'table'; align: Align[]; head: string[]; rows: string[][] };

const MAX_SPAN = 2000;
const MAX_QUOTE_DEPTH = 6;
const FENCE = /^ {0,3}(`{3,}|~{3,})[^`]*$/;
const FENCE_CLOSE = /^ {0,3}(`{3,}|~{3,})[ \t]*$/;
const LIST_ITEM = /^( *)([-*+]|\d{1,9}[.)])(?:[ \t]([^]*))?$/;
const HR = /^ {0,3}([-*_])(?:[ \t]*\1){2,}[ \t]*$/;
const QUOTE = /^ {0,3}>/;

export function safeHttpUrl(raw: string): string | null {
  const url = raw.trim();
  if (!url || url.length > 2048 || !/^https?:\/\//i.test(url) || /[\s\u0000-\u001f<>"]/.test(url)) return null;
  try {
    const parsed = new URL(url);
    return (parsed.protocol === 'http:' || parsed.protocol === 'https:') && !parsed.username && !parsed.password ? url : null;
  } catch { return null; }
}

// ---------- block parser ----------

const isBlank = (line: string) => line.trim() === '';
const isHr = (line: string) => line.length <= 200 && HR.test(line);

function parseHeading(line: string): { level: number; text: string } | null {
  let i = 0;
  while (i < 3 && line[i] === ' ') i += 1;
  let n = 0;
  while (line[i + n] === '#') n += 1;
  if (n < 1 || n > 6) return null;
  const rest = line.slice(i + n);
  if (rest !== '' && rest[0] !== ' ' && rest[0] !== '\t') return null;
  let text = rest.trim();
  let e = text.length;
  while (e > 0 && text[e - 1] === '#') e -= 1;
  if (e < text.length && (e === 0 || text[e - 1] === ' ' || text[e - 1] === '\t')) text = text.slice(0, e).trim();
  return text ? { level: n, text } : null;
}

function splitRow(line: string): string[] {
  let s = line.trim();
  if (s.startsWith('|')) s = s.slice(1);
  const cells: string[] = [];
  let cell = '';
  for (let i = 0; i < s.length; i += 1) {
    const c = s[i]!;
    if (c === '\\' && s[i + 1] === '|') { cell += '|'; i += 1; }
    else if (c === '|') { cells.push(cell.trim()); cell = ''; }
    else cell += c;
  }
  if (cell.trim() !== '' || !line.trimEnd().endsWith('|')) cells.push(cell.trim());
  return cells;
}

function alignOf(cell: string): Align | undefined {
  const t = cell.trim();
  if (!t) return undefined;
  const left = t.startsWith(':');
  const right = t.length > 1 && t.endsWith(':');
  const core = t.slice(left ? 1 : 0, right ? -1 : undefined);
  if (!core) return undefined;
  for (let i = 0; i < core.length; i += 1) if (core[i] !== '-') return undefined;
  return left && right ? 'center' : right ? 'right' : left ? 'left' : null;
}

function tableAlign(header: string, separator: string | undefined): Align[] | null {
  if (separator === undefined || !header.includes('|') || !separator.includes('-')) return null;
  const head = splitRow(header);
  const cells = splitRow(separator);
  if (!head.length || head.length !== cells.length) return null;
  const aligns: Align[] = [];
  for (const cell of cells) {
    const a = alignOf(cell);
    if (a === undefined) return null;
    aligns.push(a);
  }
  return aligns;
}

function startsBlock(lines: string[], i: number): boolean {
  const line = lines[i]!;
  return FENCE.test(line) || parseHeading(line) !== null || isHr(line) || QUOTE.test(line)
    || LIST_ITEM.test(line) || tableAlign(line, lines[i + 1]) !== null;
}

function parseList(lines: string[], start: number, first: RegExpExecArray): { list: ListNode; next: number } {
  const base = first[1]!.length;
  const ordered = /\d/.test(first[2]![0]!);
  const list: ListNode = { ordered, start: ordered ? parseInt(first[2]!, 10) : 1, items: [] };
  let j = start;
  while (j < lines.length) {
    const line = lines[j]!;
    if (isBlank(line)) {
      let k = j + 1;
      while (k < lines.length && isBlank(lines[k]!)) k += 1;
      if (k < lines.length && LIST_ITEM.test(lines[k]!) && !isHr(lines[k]!)) { j = k; continue; }
      break;
    }
    if (isHr(line)) break;
    const m = LIST_ITEM.exec(line);
    if (m) {
      const indent = m[1]!.length;
      const isOrdered = /\d/.test(m[2]![0]!);
      if (indent <= base + 1) {
        if (list.items.length && isOrdered !== ordered) break;
        list.items.push({ text: (m[3] ?? '').trimStart(), children: null });
      } else {
        const last = list.items[list.items.length - 1];
        if (!last) break;
        last.children ??= { ordered: isOrdered, start: isOrdered ? parseInt(m[2]!, 10) : 1, items: [] };
        last.children.items.push({ text: (m[3] ?? '').trimStart(), children: null });
      }
      j += 1;
      continue;
    }
    const indented = /^ {2,}/.test(line);
    if (!indented && startsBlock(lines, j)) break;
    const last = list.items[list.items.length - 1]!;
    const target = indented && last.children ? last.children.items[last.children.items.length - 1]! : last;
    target.text += `\n${line.trim()}`;
    j += 1;
  }
  return { list, next: j };
}

function parseBlocks(lines: string[], depth: number): Block[] {
  const out: Block[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    if (isBlank(line)) { i += 1; continue; }

    const fence = FENCE.exec(line);
    if (fence) {
      const marker = fence[1]!;
      const body: string[] = [];
      i += 1;
      while (i < lines.length) {
        const close = FENCE_CLOSE.exec(lines[i]!);
        if (close && close[1]![0] === marker[0] && close[1]!.length >= marker.length) { i += 1; break; }
        body.push(lines[i]!);
        i += 1;
      }
      out.push({ t: 'code', text: body.join('\n') });
      continue;
    }

    const heading = parseHeading(line);
    if (heading) { out.push({ t: 'heading', ...heading }); i += 1; continue; }

    if (isHr(line)) { out.push({ t: 'hr' }); i += 1; continue; }

    if (QUOTE.test(line)) {
      const inner: string[] = [];
      while (i < lines.length && QUOTE.test(lines[i]!)) {
        inner.push(lines[i]!.replace(/^ {0,3}> ?/, ''));
        i += 1;
      }
      out.push({ t: 'quote', blocks: depth < MAX_QUOTE_DEPTH ? parseBlocks(inner, depth + 1) : [{ t: 'para', text: inner.join('\n') }] });
      continue;
    }

    const align = tableAlign(line, lines[i + 1]);
    if (align) {
      const head = splitRow(line);
      const rows: string[][] = [];
      i += 2;
      while (i < lines.length && !isBlank(lines[i]!) && lines[i]!.includes('|')) {
        const cells = splitRow(lines[i]!);
        while (cells.length < head.length) cells.push('');
        rows.push(cells.slice(0, head.length));
        i += 1;
      }
      out.push({ t: 'table', align, head, rows });
      continue;
    }

    const item = LIST_ITEM.exec(line);
    if (item) {
      const { list, next } = parseList(lines, i, item);
      out.push({ t: 'list', list });
      i = next;
      continue;
    }

    const para: string[] = [line.trim()];
    i += 1;
    while (i < lines.length && !isBlank(lines[i]!) && !startsBlock(lines, i)) { para.push(lines[i]!.trim()); i += 1; }
    out.push({ t: 'para', text: para.join('\n') });
  }
  return out;
}

export function parseMarkdownBlocks(text: string): Block[] {
  const lines = text.split(/\r\n|\r|\n/).map((line) => line.replace(/^\t+/, (tabs) => '    '.repeat(tabs.length)));
  return parseBlocks(lines, 0);
}

// ---------- inline renderer ----------

interface Ctx { budget: number; key: number; open: (url: string) => void }

const SPECIAL = /[`*_[\\\n]|https?:\/\//g;
const isWs = (c: string | undefined) => c === undefined || /\s/.test(c);
const isAlnum = (c: string | undefined) => c !== undefined && /[A-Za-z0-9]/.test(c);

function linkElement(url: string, children: React.ReactNode, ctx: Ctx): React.ReactElement {
  return React.createElement('a', {
    key: `k${ctx.key++}`, href: url, rel: 'noreferrer noopener', title: url,
    onClick: (event: React.MouseEvent) => { event.preventDefault(); ctx.open(url); },
    onAuxClick: (event: React.MouseEvent) => { event.preventDefault(); },
  }, children);
}

function renderInline(src: string, ctx: Ctx, depth: number, allowLink: boolean): React.ReactNode[] {
  const out: React.ReactNode[] = [];
  let buf = '';
  const flush = () => { if (buf) { out.push(buf); buf = ''; } };
  const n = src.length;
  let i = 0;
  while (i < n) {
    if (ctx.budget <= 0) { buf += src.slice(i); break; }
    SPECIAL.lastIndex = i;
    const found = SPECIAL.exec(src);
    if (!found) { buf += src.slice(i); break; }
    const p = found.index;
    buf += src.slice(i, p);
    ctx.budget -= 1;
    const c = src[p]!;
    i = p + 1;

    if (c === '\n') { flush(); out.push(React.createElement('br', { key: `k${ctx.key++}` })); continue; }

    if (c === '\\') {
      const next = src[p + 1];
      if (next !== undefined && /[!-/:-@[-`{-~]/.test(next)) { buf += next; i = p + 2; } else buf += c;
      continue;
    }

    if (c === 'h') { // bare http(s) URL
      if (!allowLink || (p > 0 && isAlnum(src[p - 1]))) { buf += src.slice(p, p + 4); i = p + 4; continue; }
      let e = p;
      const limit = Math.min(n, p + MAX_SPAN);
      while (e < limit) {
        const code = src.charCodeAt(e);
        if (code <= 32 || code > 126 || code === 60 || code === 62 || code === 34 || code === 96) break;
        e += 1;
      }
      ctx.budget -= e - p;
      let url = src.slice(p, e);
      const counts: Record<string, number> = { '(': 0, ')': 0, '[': 0, ']': 0 };
      for (let q = 0; q < url.length; q += 1) { const ch = url[q]!; if (ch in counts) counts[ch]! += 1; }
      let urlEnd = url.length;
      while (urlEnd > 0) {
        const last = url[urlEnd - 1]!;
        if ('.,;:!?\'*_~'.includes(last)) urlEnd -= 1;
        else if (last === ')' && counts[')']! > counts['(']!) { counts[')']! -= 1; urlEnd -= 1; }
        else if (last === ']' && counts[']']! > counts['[']!) { counts[']']! -= 1; urlEnd -= 1; }
        else break;
      }
      url = url.slice(0, urlEnd);
      const safe = safeHttpUrl(url);
      if (safe && url.length > 8) { flush(); out.push(linkElement(safe, url, ctx)); i = p + url.length; }
      else { buf += src.slice(p, p + 4); i = p + 4; }
      continue;
    }

    if (c === '`') {
      let r = 1;
      while (src[p + r] === '`') r += 1;
      const limit = Math.min(n, p + r + MAX_SPAN);
      let close = -1;
      for (let q = p + r; q < limit; q += 1) {
        ctx.budget -= 1;
        if (src.charCodeAt(q) !== 96) continue;
        let r2 = 1;
        while (src[q + r2] === '`') r2 += 1;
        if (r2 === r) { close = q; break; }
        q += r2 - 1;
      }
      if (close < 0) { buf += src.slice(p, p + r); i = p + r; continue; }
      let code = src.slice(p + r, close).replace(/\n/g, ' ');
      if (code.length > 2 && code.startsWith(' ') && code.endsWith(' ') && code.trim()) code = code.slice(1, -1);
      flush();
      out.push(React.createElement('code', { key: `k${ctx.key++}` }, code));
      i = close + r;
      continue;
    }

    if (c === '*' || c === '_') {
      let r = 1;
      while (src[p + r] === c) r += 1;
      const m = c === '*' && r >= 2 ? 2 : 1;
      const opener = depth < 6 && !(c === '_' && r > 1) && !isWs(src[p + m]) && (c === '*' || !isAlnum(src[p - 1]));
      let close = -1;
      if (opener) {
        const limit = Math.min(n, p + m + MAX_SPAN);
        for (let j = p + m + 1; j < limit; j += 1) {
          ctx.budget -= 1;
          const d = src[j];
          if (d === '\\') { j += 1; continue; }
          if (d !== c) continue;
          let rr = 1;
          while (src[j + rr] === c) rr += 1;
          if (m === 2 && rr >= 2 && !isWs(src[j - 1])) { close = j + rr - 2; break; }
          if (m === 1 && rr === 1 && !isWs(src[j - 1]) && (c === '*' || !isAlnum(src[j + 1]))) { close = j; break; }
          j += rr - 1;
        }
      }
      if (close < 0) { buf += src.slice(p, p + r); i = p + r; continue; }
      flush();
      const inner = renderInline(src.slice(p + m, close), ctx, depth + 1, allowLink);
      out.push(React.createElement(m === 2 ? 'strong' : 'em', { key: `k${ctx.key++}` }, inner));
      i = close + m;
      continue;
    }

    if (c === '[') {
      let literal = true;
      if (allowLink && depth < 6) {
        let d = 1;
        let j = p + 1;
        const limit = Math.min(n, p + MAX_SPAN);
        for (; j < limit; j += 1) {
          ctx.budget -= 1;
          const ch = src[j];
          if (ch === '\\') j += 1;
          else if (ch === '[') d += 1;
          else if (ch === ']') { d -= 1; if (d === 0) break; }
        }
        if (j < limit && src[j] === ']' && src[j + 1] === '(') {
          let depthParen = 1;
          let k = j + 2;
          const end = Math.min(n, j + 2 + MAX_SPAN);
          for (; k < end; k += 1) {
            ctx.budget -= 1;
            const ch = src[k];
            if (ch === '(') depthParen += 1;
            else if (ch === ')') { depthParen -= 1; if (depthParen === 0) break; }
          }
          if (k < end && src[k] === ')') {
            literal = false;
            const rawTarget = src.slice(j + 2, k).trim();
            const token = (rawTarget.startsWith('<') && rawTarget.includes('>') ? rawTarget.slice(1, rawTarget.indexOf('>')) : rawTarget.split(/\s+/, 1)[0]) ?? '';
            const safe = safeHttpUrl(token);
            if (safe) {
              flush();
              out.push(linkElement(safe, renderInline(src.slice(p + 1, j), ctx, depth + 1, false), ctx));
            } else buf += src.slice(p, k + 1); // non-http(s) target: keep the source as plain text
            i = k + 1;
          }
        }
      }
      if (literal) buf += c;
      continue;
    }

    buf += c;
  }
  flush();
  return out;
}

// ---------- element builders ----------

function renderList(list: ListNode, ctx: Ctx, nested: boolean): React.ReactElement {
  const items = list.items.map((item) => React.createElement('li', { key: `k${ctx.key++}` },
    renderInline(item.text, ctx, 0, true),
    item.children ? renderList(item.children, ctx, true) : null));
  return list.ordered
    ? React.createElement('ol', { key: `k${ctx.key++}`, start: list.start !== 1 ? list.start : undefined, className: nested ? 'md-nested' : undefined }, items)
    : React.createElement('ul', { key: `k${ctx.key++}`, className: nested ? 'md-nested' : undefined }, items);
}

function renderBlock(block: Block, ctx: Ctx): React.ReactElement {
  const key = `k${ctx.key++}`;
  switch (block.t) {
    case 'heading':
      return React.createElement('div', { key, role: 'heading', 'aria-level': block.level, className: `md-heading md-h${block.level}` }, renderInline(block.text, ctx, 0, true));
    case 'para':
      return React.createElement('p', { key }, renderInline(block.text, ctx, 0, true));
    case 'code':
      return React.createElement('pre', { key, className: 'md-pre', tabIndex: 0 }, React.createElement('code', null, block.text));
    case 'hr':
      return React.createElement('hr', { key });
    case 'quote':
      return React.createElement('blockquote', { key }, block.blocks.map((inner) => renderBlock(inner, ctx)));
    case 'list':
      return renderList(block.list, ctx, false);
    case 'table': {
      const cell = (tag: 'th' | 'td', text: string, index: number) => React.createElement(tag,
        { key: `k${ctx.key++}`, style: block.align[index] ? { textAlign: block.align[index] } : undefined }, renderInline(text, ctx, 0, true));
      return React.createElement('div', { key, className: 'md-table-wrap', tabIndex: 0 },
        React.createElement('table', null,
          React.createElement('thead', null, React.createElement('tr', null, block.head.map((text, index) => cell('th', text, index)))),
          React.createElement('tbody', null, block.rows.map((row) => React.createElement('tr', { key: `k${ctx.key++}` }, row.map((text, index) => cell('td', text, index)))))));
    }
  }
}

export function buildMarkdown(text: string, open: (url: string) => void): React.ReactElement[] {
  const ctx: Ctx = { budget: 200_000 + 40 * text.length, key: 0, open };
  return parseMarkdownBlocks(text).map((block) => renderBlock(block, ctx));
}

export const MarkdownText = React.memo(function MarkdownText({ text, onOpenUrl }: { text: string; onOpenUrl: (url: string) => void }) {
  const openRef = useRef(onOpenUrl);
  openRef.current = onOpenUrl;
  const content = useMemo(() => {
    try { return buildMarkdown(text, (url) => openRef.current(url)); } catch { return null; }
  }, [text]);
  return <div className="message-text md" data-testid="agent-markdown">{content ?? text}</div>;
});
