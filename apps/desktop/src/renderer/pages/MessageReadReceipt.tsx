import { useDesktopLocale, useDesktopText } from '../desktop-i18n.js';
import { formatDate, type Locale } from '../../locale.js';
import React, { useEffect, useId, useRef, useState } from 'react';
import type { ConversationKey } from '@line-agent/contracts';
import type { DesktopApi } from '../../preload/api.js';
import type { MessageReader } from '../../main/service-facade.js';
import { LineMediaImage } from '../LineMediaImage.js';

const OPEN_EVENT = 'line-agent:read-receipt-open';
const PANEL_MAX_HEIGHT = 300;
const PANEL_WIDTH = 240;

/** Time for today, month/day and time otherwise, in the effective desktop locale. */
export function formatReadTime(timestamp: string, now = new Date(), locale: Locale = 'en'): string {
  const date = new Date(timestamp);
  return formatDate(locale, date, {
    ...(date.toDateString() === now.toDateString() ? {} : { month: 'numeric', day: 'numeric' }),
    hour: 'numeric', minute: '2-digit',
  });
}

type Placement = { left: number; top?: number; bottom?: number };
type Load = { state: 'loading' } | { state: 'error' } | { state: 'ready'; readers: MessageReader[] };

/** Read marker under an own message. Direct chats show plain text; group and room chats open a reader list. */
export function MessageReadReceipt({ api, route, messageId, count }: {
  api: DesktopApi; route: ConversationKey; messageId: string; count: number;
}) {
  const desktopText = useDesktopText();
  if (!(count > 0)) return null;
  if (route.chatType === 'direct') return <span className="message-read">{desktopText('read')}</span>;
  if (route.chatType !== 'group' && route.chatType !== 'room') return null;
  return <ReadReaders api={api} route={route} messageId={messageId} count={count} />;
}

function ReadReaders({ api, route, messageId, count }: { api: DesktopApi; route: ConversationKey; messageId: string; count: number }) {
  const desktopText = useDesktopText();
  const locale = useDesktopLocale();
  const [open, setOpen] = useState(false);
  const [placement, setPlacement] = useState<Placement>({ left: 0, top: 0 });
  const [load, setLoad] = useState<Load>({ state: 'loading' });
  const root = useRef<HTMLSpanElement | null>(null);
  const button = useRef<HTMLButtonElement | null>(null);
  const panel = useRef<HTMLDivElement | null>(null);
  const id = useId();

  const close = () => setOpen(false);
  const closeToButton = () => { setOpen(false); button.current?.focus(); };

  // Listeners exist only while the panel is open.
  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: MouseEvent) => { if (!root.current?.contains(event.target as Node)) close(); };
    const onKeyDown = (event: KeyboardEvent) => { if (event.key === 'Escape') { event.stopPropagation(); closeToButton(); } };
    const onOtherOpened = (event: Event) => { if ((event as CustomEvent<string>).detail !== id) close(); };
    const onViewportChange = () => close();
    document.addEventListener('mousedown', onPointerDown);
    document.addEventListener('keydown', onKeyDown, true);
    document.addEventListener(OPEN_EVENT, onOtherOpened);
    window.addEventListener('resize', onViewportChange);
    window.addEventListener('scroll', onViewportChange, true);
    return () => {
      document.removeEventListener('mousedown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown, true);
      document.removeEventListener(OPEN_EVENT, onOtherOpened);
      window.removeEventListener('resize', onViewportChange);
      window.removeEventListener('scroll', onViewportChange, true);
    };
  }, [open, id]);

  // One request per open.
  useEffect(() => {
    if (!open) return;
    let current = true;
    setLoad({ state: 'loading' });
    api.listMessageReaders(route, messageId).then(
      (result) => { if (current) setLoad({ state: 'ready', readers: result.readers }); },
      () => { if (current) setLoad({ state: 'error' }); });
    return () => { current = false; };
  }, [open]);
  useEffect(() => { if (open) panel.current?.focus(); }, [open]);

  const toggle = () => {
    if (open) { close(); return; }
    const rect = button.current?.getBoundingClientRect();
    if (rect) {
      const left = Math.max(8, Math.min(rect.right - PANEL_WIDTH, window.innerWidth - PANEL_WIDTH - 8));
      // Flip upward when there is not enough room below.
      setPlacement(window.innerHeight - rect.bottom < PANEL_MAX_HEIGHT + 12 && rect.top > window.innerHeight - rect.bottom
        ? { left, bottom: window.innerHeight - rect.top + 4 } : { left, top: rect.bottom + 4 });
    }
    document.dispatchEvent(new CustomEvent(OPEN_EVENT, { detail: id }));
    setOpen(true);
  };

  return <span className="message-read-root" ref={root}>
    <button type="button" ref={button} className="message-read message-read-button" aria-haspopup="dialog" aria-expanded={open}
      aria-controls={open ? `${id}-panel` : undefined} aria-label={desktopText('readByArg0ViewReaders', { arg0: count })} onClick={toggle}>{desktopText('read')}{count}</button>
    {open && <div ref={panel} id={`${id}-panel`} className="read-readers-panel" role="dialog" tabIndex={-1} aria-label={desktopText('readByArg0', { arg0: count })}
      style={{ left: placement.left, ...(placement.top !== undefined ? { top: placement.top } : {}), ...(placement.bottom !== undefined ? { bottom: placement.bottom } : {}),
        width: PANEL_WIDTH, maxHeight: PANEL_MAX_HEIGHT }}>
      <h3 className="read-readers-title">{desktopText('read')}{count}</h3>
      {load.state === 'loading' && <p className="read-readers-status muted" role="status">{desktopText('loading251')}</p>}
      {load.state === 'error' && <p className="read-readers-status" role="alert">{desktopText('unableToLoadReaders')}</p>}
      {load.state === 'ready' && <ul className="read-readers-list">
        {load.readers.map((reader) => <li key={reader.mid} className="read-reader">
          <LineMediaImage api={api} enabled target={{ type: 'member', accountId: route.accountId, chatType: route.chatType,
            chatId: route.chatId, memberId: reader.mid }} fallbackKind="person" className="read-reader-avatar" />
          <span className="read-reader-name">{reader.name || desktopText('otherPerson')}</span>
          <time className="read-reader-time" dateTime={reader.readAt}>{formatReadTime(reader.readAt, new Date(), locale)}</time>
        </li>)}
      </ul>}
    </div>}
  </span>;
}
