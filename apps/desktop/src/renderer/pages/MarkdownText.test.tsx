// @vitest-environment jsdom
// Existing workflow assertions explicitly exercise the retained Traditional Chinese catalog.
import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MarkdownText, safeHttpUrl } from './MarkdownText.js';
import { AgentRoom } from './AgentRoom.js';
import type { DesktopApi } from '../../preload/api.js';
import { LocaleProvider, type LocaleState } from '../locale-context.js';

afterEach(cleanup);

const renderTraditionalChinese = (ui: React.ReactElement) => {
  const locale: LocaleState = { status: 'loaded', effectiveLocale: 'zh-TW', preference: 'zh-TW', busy: false, error: null, retry() {}, retryRestart() {}, setPreference() {} };
  return render(<LocaleProvider value={locale}>{ui}</LocaleProvider>);
};

function md(text: string, onOpenUrl: (url: string) => void = () => undefined) {
  const view = render(<MarkdownText text={text} onOpenUrl={onOpenUrl} />);
  return view.container.querySelector('[data-testid="agent-markdown"]') as HTMLElement;
}

describe('MarkdownText syntax', () => {
  it('renders headings, paragraphs and line breaks', () => {
    const root = md('# 一\n\n###### 六\n\n第一行\n第二行');
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('一');
    expect(screen.getByRole('heading', { level: 6 }).textContent).toBe('六');
    expect(root.querySelectorAll('p')).toHaveLength(1);
    expect(root.querySelectorAll('p br')).toHaveLength(1);
  });

  it('renders bold, italic and inline code', () => {
    const root = md('**粗** *斜* _也斜_ `code` snake_case_name');
    expect(root.querySelector('strong')?.textContent).toBe('粗');
    expect([...root.querySelectorAll('em')].map((e) => e.textContent)).toEqual(['斜', '也斜']);
    expect(root.querySelector('code')?.textContent).toBe('code');
    expect(root.textContent).toContain('snake_case_name');
  });

  it('renders fenced code blocks verbatim, including markdown characters', () => {
    const root = md('```ts\nconst a = **1**;\n  <b>x</b>\n```\n後文');
    expect(root.querySelector('pre code')?.textContent).toBe('const a = **1**;\n  <b>x</b>');
    expect(root.querySelector('pre strong')).toBeNull();
    expect(root.querySelector('p')?.textContent).toBe('後文');
  });

  it('renders unordered, ordered and one level of nested lists', () => {
    const root = md('- a\n- b\n  - b1\n  - b2\n+ c\n\n3. x\n4. y');
    const lists = root.querySelectorAll(':scope > ul, :scope > ol');
    expect(lists).toHaveLength(2);
    expect(lists[0]!.querySelectorAll(':scope > li')).toHaveLength(3);
    expect(lists[0]!.querySelectorAll('li ul > li')).toHaveLength(2);
    expect(lists[1]!.tagName).toBe('OL');
    expect(lists[1]!.getAttribute('start')).toBe('3');
  });

  it('renders blockquote, horizontal rule', () => {
    const root = md('> 引用 **粗**\n> 第二行\n\n---\n\n後');
    expect(root.querySelector('blockquote strong')?.textContent).toBe('粗');
    expect(root.querySelectorAll('hr')).toHaveLength(1);
  });

  it('renders GFM tables with alignment and inline formatting', () => {
    const root = md('| 名稱 | 數量 | 備註 |\n|:--|--:|:-:|\n| **甲** | 1 | `x` |\n| 乙 | 2 |');
    const table = root.querySelector('.md-table-wrap table')!;
    expect([...table.querySelectorAll('th')].map((c) => c.textContent)).toEqual(['名稱', '數量', '備註']);
    expect(table.querySelectorAll('tbody tr')).toHaveLength(2);
    expect(table.querySelector('tbody td strong')?.textContent).toBe('甲');
    expect((table.querySelectorAll('th')[1] as HTMLElement).style.textAlign).toBe('right');
    expect((table.querySelectorAll('th')[2] as HTMLElement).style.textAlign).toBe('center');
    expect(table.querySelectorAll('tbody tr')[1]!.querySelectorAll('td')).toHaveLength(3);
    expect(root.textContent).not.toContain('|');
  });

  it('renders markdown links and bare URLs as http(s) anchors', () => {
    const root = md('見 [文件](https://example.com/a?b=1) 與 https://example.org/x。');
    const anchors = [...root.querySelectorAll('a')];
    expect(anchors.map((a) => a.getAttribute('href'))).toEqual(['https://example.com/a?b=1', 'https://example.org/x']);
    expect(root.textContent).toContain('x。');
  });
});

describe('MarkdownText safety', () => {
  it('shows raw HTML as literal text without creating elements', () => {
    const payload = '<script>alert(1)</script>\n\n<img src=x onerror=alert(1)>';
    const root = md(payload);
    expect(root.querySelector('script')).toBeNull();
    expect(root.querySelector('img')).toBeNull();
    expect(root.textContent).toContain('<script>alert(1)</script>');
    expect(root.textContent).toContain('<img src=x onerror=alert(1)>');
  });

  it('renders non-http(s) link targets as plain text', () => {
    const root = md('[a](javascript:alert(1)) [b](file:///C:/x) [c](data:text/html,x) [d](JaVaScRiPt:alert(1))');
    expect(root.querySelector('a')).toBeNull();
    expect(root.textContent).toContain('javascript:alert(1)');
    expect(safeHttpUrl('javascript:alert(1)')).toBeNull();
    expect(safeHttpUrl('http:evil')).toBeNull();
    expect(safeHttpUrl('https://ok.example/p')).toBe('https://ok.example/p');
  });

  it('renders URLs with credentials as plain text', () => {
    const root = md('[a](https://user:pw@example.com/x) https://user:pw@example.com/y');
    expect(root.querySelector('a')).toBeNull();
    expect(root.textContent).toContain('user:pw@example.com/y');
    expect(safeHttpUrl('https://user:pw@host/')).toBeNull();
    expect(safeHttpUrl('https://user@host/')).toBeNull();
  });

  it('does not backtrack quadratically on trailing parens or U+2028 in list lines', () => {
    const url = `https://a.example/${')'.repeat(1980)}`;
    const urls = Array.from({ length: 50 }, () => url).join(' ');
    let t0 = performance.now();
    const root = md(urls);
    expect(performance.now() - t0).toBeLessThan(200);
    expect(root.querySelectorAll('a')).toHaveLength(50);
    cleanup();
    t0 = performance.now();
    const list = md(`- ${' '.repeat(30000)}x y`);
    expect(performance.now() - t0).toBeLessThan(200);
    expect(list.querySelector('li')?.textContent?.startsWith('x')).toBe(true);
  });

  it('opens links through openExternalUrl and never navigates', () => {
    const open = vi.fn();
    const root = md('[go](https://example.com/x)', open);
    const anchor = root.querySelector('a')!;
    const notPrevented = fireEvent.click(anchor);
    expect(notPrevented).toBe(false);
    expect(open).toHaveBeenCalledExactlyOnceWith('https://example.com/x');
  });

  it('renders unclosed markers literally and never throws', () => {
    const root = md('**未結束 *也是 `code [連結](https://x\n```\n未關閉 fence');
    expect(root.querySelector('strong, em')).toBeNull();
    expect(root.textContent).toContain('**未結束');
    expect(root.textContent).toContain('未關閉 fence');
  });

  it('handles streaming prefixes of a document without error', () => {
    const doc = '## 標題\n\n**重點** 與 [連結](https://example.com)\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\n- x\n  - y\n\n```js\ncode\n```\n';
    for (let end = 0; end <= doc.length; end += 1) {
      const view = render(<MarkdownText text={doc.slice(0, end)} onOpenUrl={() => undefined} />);
      view.unmount();
    }
  });

  it('finishes large and pathological inputs quickly', () => {
    const big = Array.from({ length: 5000 }, (_, i) => `- 項目 ${i} **粗** [x](https://example.com/${i}) \`c\``).join('\n');
    const started = performance.now();
    md(big);
    expect(performance.now() - started).toBeLessThan(5000);
    cleanup();
    for (const nasty of ['['.repeat(100_000), '*'.repeat(100_000), '`'.repeat(100_000), '> '.repeat(50_000), '|'.repeat(100_000), '_a '.repeat(50_000), `${'(['.repeat(30_000)}]`]) {
      const t0 = performance.now();
      md(nasty);
      expect(performance.now() - t0).toBeLessThan(5000);
      cleanup();
    }
  });
});

describe('AgentRoom Markdown integration', () => {
  const conversation = { accountId: 'account-A', chatType: 'direct' as const, chatId: 'local-agent', title: 'Agent 室',
    agentEnabled: true, defaultProvider: 'codex' as const, unreadCount: 0, localOnly: true };
  const job = { jobId: 'job-md', accountId: null, chatType: null, chatId: null, provider: 'codex' as const,
    prompt: '**我的提問** ## 不要渲染', status: 'completed' as const, createdAt: '2026-10-18T00:00:00.000Z' };

  it('renders assistant Markdown, keeps user and failure text plain, and opens links via the preload API', async () => {
    const openExternalUrl = vi.fn(async () => ({ type: 'openExternalUrl', requestId: 'x', ok: true } as const));
    const api = {
      getAgentRoomJobEvents: vi.fn(async () => [{ type: 'completed', finalText: '## 結論\n\n**重點** [連結](https://example.com/z)' }]),
      listPendingAgentApprovals: vi.fn(async () => []),
      decideAgentApproval: vi.fn(async () => ({ type: 'decideAgentApproval', requestId: 'x', ok: true })),
      onEvent: vi.fn(() => () => undefined),
      openExternalUrl,
    } as unknown as DesktopApi;
    renderTraditionalChinese(<AgentRoom api={api} conversation={conversation} jobs={[job]} providers={[{ provider: 'codex', status: 'logged_in', detail: null }]} />);
    const body = await screen.findByTestId('agent-markdown');
    expect(body.querySelector('[role="heading"]')?.textContent).toBe('結論');
    expect(body.querySelector('strong')?.textContent).toBe('重點');
    expect(screen.getByText('**我的提問** ## 不要渲染')).toBeTruthy();
    expect(document.querySelectorAll('[data-testid="agent-markdown"]')).toHaveLength(1);
    fireEvent.click(body.querySelector('a')!);
    await waitFor(() => expect(openExternalUrl).toHaveBeenCalledWith('https://example.com/z'));
  });

  it('keeps Agent failure messages as plain text', async () => {
    const api = {
      getAgentRoomJobEvents: vi.fn(async () => [{ type: 'failed', code: 'X', message: '失敗 **不渲染**', retryable: false }]),
      listPendingAgentApprovals: vi.fn(async () => []),
      decideAgentApproval: vi.fn(async () => ({ type: 'decideAgentApproval', requestId: 'x', ok: true })),
      onEvent: vi.fn(() => () => undefined),
    } as unknown as DesktopApi;
    renderTraditionalChinese(<AgentRoom api={api} conversation={conversation} jobs={[{ ...job, status: 'failed' }]} providers={[{ provider: 'codex', status: 'logged_in', detail: null }]} />);
    expect(await screen.findByText(/Agent 無法完成這次工作/)).toBeTruthy();
    expect(document.querySelector('[data-testid="agent-markdown"]')).toBeNull();
  });
});
