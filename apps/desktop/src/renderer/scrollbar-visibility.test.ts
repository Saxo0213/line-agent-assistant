// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { URL as NodeURL } from 'node:url';
import { install, uninstall } from './scrollbar-visibility.js';

describe('scrollbar visibility', () => {
  let el: HTMLDivElement;
  beforeEach(() => {
    vi.useFakeTimers();
    el = document.createElement('div');
    document.body.append(el);
    install();
  });
  afterEach(() => {
    uninstall();
    el.remove();
    vi.useRealTimers();
  });
  const scroll = () => el.dispatchEvent(new Event('scroll'));

  it('adds the class on scroll and removes it after the timeout', () => {
    scroll();
    expect(el.classList.contains('is-scrolling')).toBe(true);
    vi.advanceTimersByTime(799);
    expect(el.classList.contains('is-scrolling')).toBe(true);
    vi.advanceTimersByTime(2);
    expect(el.classList.contains('is-scrolling')).toBe(false);
  });

  it('keeps a single timer across repeated scrolls', () => {
    scroll();
    vi.advanceTimersByTime(500);
    scroll();
    expect(vi.getTimerCount()).toBe(1);
    vi.advanceTimersByTime(500);
    expect(el.classList.contains('is-scrolling')).toBe(true);
    vi.advanceTimersByTime(400);
    expect(el.classList.contains('is-scrolling')).toBe(false);
  });

  it('keeps the class while the pointer is down', () => {
    scroll();
    el.dispatchEvent(new Event('pointerdown', { bubbles: true }));
    vi.advanceTimersByTime(5000);
    expect(el.classList.contains('is-scrolling')).toBe(true);
    el.dispatchEvent(new Event('pointerup', { bubbles: true }));
    vi.advanceTimersByTime(801);
    expect(el.classList.contains('is-scrolling')).toBe(false);
  });

  it('stops reacting after uninstall', () => {
    uninstall();
    scroll();
    expect(el.classList.contains('is-scrolling')).toBe(false);
    install();
  });

  it('styles.css hides the thumb without standard scrollbar properties', () => {
    const css = readFileSync(new NodeURL('./styles.css', import.meta.url), 'utf8');
    expect(css).not.toContain('scrollbar-color');
    expect(css).not.toContain('scrollbar-width');
    expect(css).toContain('.is-scrolling::-webkit-scrollbar-thumb');
    expect(css).toContain('scrollbar-gutter:stable');
  });
});
