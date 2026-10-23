// @vitest-environment jsdom
// Existing workflow assertions explicitly exercise the retained Traditional Chinese catalog.
import React from 'react';
import { cleanup, fireEvent, render } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { lineMediaUrl } from '@line-agent/contracts';
import type { DesktopApi } from '../../preload/api.js';
import { MessageReactions } from './MessageReactions.js';

vi.mock('../locale-context.js', async (importOriginal) => ({ ...(await importOriginal<typeof import('../locale-context.js')>()), useLocale: () => ({ effectiveLocale: 'zh-TW' }) }));

afterEach(cleanup);

const base = { accountId: 'account-A', chatType: 'group' as const, chatId: 'chat-1', messageId: '42' };
const api = {} as DesktopApi;

describe('MessageReactions', () => {
  it('renders nothing without reactions', () => {
    expect(render(<MessageReactions api={api} message={base} />).container.innerHTML).toBe('');
    expect(render(<MessageReactions api={api} message={{ ...base, reactions: [] }} />).container.innerHTML).toBe('');
  });

  it('renders predefined pills with matching neutral glyphs, a count above one, and names in title and aria-label', () => {
    const { container } = render(<MessageReactions api={api} message={{ ...base, reactions: [
      { kind: 'NICE', count: 3, reactorNames: ['A', 'B', 'C'] },
      { kind: 'LOVE', count: 1, reactorNames: ['Dee'] },
    ] }} />);
    const pills = [...container.querySelectorAll('.message-reaction')];
    expect(pills).toHaveLength(2);
    expect(pills[0]!.querySelector('.message-reaction-icon')!.textContent).toBe('●');
    expect(pills[0]!.querySelector('.message-reaction-icon')!.getAttribute('aria-hidden')).toBe('true');
    expect(pills[0]!.querySelector('.message-reaction-count')!.textContent).toBe('3');
    expect(pills[0]!.getAttribute('title')).toBe('A、B、C');
    expect(pills[0]!.getAttribute('aria-label')).toBe('NICE 3 人：A、B、C');
    expect(pills[1]!.querySelector('.message-reaction-icon')!.textContent).toBe('♡');
    expect(pills[1]!.querySelector('.message-reaction-count')).toBeNull();
  });

  it('loads a paid pill through the media URL and falls back to the text 回應 when the image fails', () => {
    const { container } = render(<MessageReactions api={api} message={{ ...base, reactions: [
      { kind: 'PAID', productId: '60ebfdc03cc24041bb139cf5', emojiId: '004', count: 2, reactorNames: ['A', 'B'] },
    ] }} />);
    const img = container.querySelector('img.message-reaction-icon')!;
    expect(img.getAttribute('src')).toBe(lineMediaUrl({ type: 'reaction', ...base, productId: '60ebfdc03cc24041bb139cf5', emojiId: '004' }));
    expect(img.getAttribute('src')).toMatch(/^line-media:\/\/reaction\//);
    expect(container.querySelector('.message-reaction')!.getAttribute('aria-label')).toBe('回應 2 人：A、B');
    fireEvent.error(img);
    expect(container.querySelector('img')).toBeNull();
    expect(container.textContent).toContain('回應');
  });
});
