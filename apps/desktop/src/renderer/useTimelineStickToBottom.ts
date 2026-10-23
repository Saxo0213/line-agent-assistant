import { useEffect, type MutableRefObject, type RefObject } from 'react';

/** Scrolls to the bottom and records the resulting offset so the scroll handler can tell our own pin from a reader's scroll. */
export function pinPaneToBottom(pane: HTMLElement, pinTop?: MutableRefObject<number | null>) {
  pane.scrollTop = pane.scrollHeight;
  if (pinTop) pinTop.current = pane.scrollTop;
}

export function useTimelineStickToBottom(
  pane: RefObject<HTMLElement | null>, content: RefObject<HTMLElement | null>, routeKey: string,
  pinned: MutableRefObject<boolean>, anchorPending: MutableRefObject<unknown>,
  pinTop?: MutableRefObject<number | null>,
) {
  useEffect(() => {
    const target = content.current;
    if (!target || !pane.current || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(() => {
      const node = pane.current;
      if (node && pinned.current && !anchorPending.current) pinPaneToBottom(node, pinTop);
    });
    observer.observe(target);
    observer.observe(pane.current);
    return () => observer.disconnect();
  }, [pane, content, routeKey, pinned, anchorPending, pinTop]);
}
