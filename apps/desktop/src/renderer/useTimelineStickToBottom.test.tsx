// @vitest-environment jsdom
import { act, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useTimelineStickToBottom } from './useTimelineStickToBottom.js';

class ResizeObserverMock {
  static instances: ResizeObserverMock[] = [];
  callback: ResizeObserverCallback;
  disconnected = false;
  target: Element | null = null;
  constructor(callback: ResizeObserverCallback) { this.callback = callback; ResizeObserverMock.instances.push(this); }
  observe(target: Element) { this.target = target; }
  unobserve() {}
  disconnect() { this.disconnected = true; }
  resize() { this.callback([], this as unknown as ResizeObserver); }
}

describe('useTimelineStickToBottom', () => {
  afterEach(() => { vi.unstubAllGlobals(); ResizeObserverMock.instances = []; });

  it('follows content growth while pinned and leaves a scrolled-up reader and new-message count alone', () => {
    vi.stubGlobal('ResizeObserver', ResizeObserverMock);
    const pane = { current: { scrollTop: 100, scrollHeight: 500 } as HTMLElement };
    const content = { current: document.createElement('div') };
    const pinned = { current: true };
    const anchor: { current: unknown | null } = { current: null };
    const { rerender } = renderHook(({ room }) => useTimelineStickToBottom(pane, content, room, pinned, anchor), { initialProps: { room: 'A' } });
    act(() => ResizeObserverMock.instances[0]!.resize());
    expect(pane.current.scrollTop).toBe(500);

    anchor.current = { height: 700, top: 500 };
    pane.current.scrollTop = 120;
    act(() => ResizeObserverMock.instances[0]!.resize());
    expect(pane.current.scrollTop).toBe(120);
    anchor.current = null;

    pinned.current = false; // scroll handler records the reader moving away from bottom
    pane.current.scrollTop = 100;
    act(() => ResizeObserverMock.instances[0]!.resize());
    expect(pane.current.scrollTop).toBe(100);
    // The hook does not mutate the existing new-message count/pill state.
    rerender({ room: 'A' });
    expect(pane.current.scrollTop).toBe(100);
  });

  it('disconnects its observer when switching rooms and unmounting', () => {
    vi.stubGlobal('ResizeObserver', ResizeObserverMock);
    const pane = { current: document.createElement('div') };
    const content = { current: document.createElement('div') };
    const pinned = { current: true };
    const anchor: { current: unknown | null } = { current: null };
    const { rerender, unmount } = renderHook(({ room }) => useTimelineStickToBottom(pane, content, room, pinned, anchor), { initialProps: { room: 'A' } });
    const first = ResizeObserverMock.instances[0]!;
    rerender({ room: 'B' });
    expect(first.disconnected).toBe(true);
    const second = ResizeObserverMock.instances[1]!;
    unmount();
    expect(second.disconnected).toBe(true);
  });
});
