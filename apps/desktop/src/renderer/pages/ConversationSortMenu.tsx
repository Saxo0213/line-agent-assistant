import { useDesktopText } from '../desktop-i18n.js';
import React, { useEffect, useId, useRef, useState } from 'react';

export type SortMode = 'received' | 'unread' | 'name';
export type SortDirection = 'asc' | 'desc';
export type SortState = { mode: SortMode; direction: SortDirection };

export const DEFAULT_SORT: SortState = { mode: 'received', direction: 'desc' };
/** A newly chosen option starts here: newest first, unread first, A to Z. */
export const defaultDirection = (mode: SortMode): SortDirection => (mode === 'name' ? 'asc' : 'desc');
export const nextSort = (current: SortState, mode: SortMode): SortState =>
  current.mode === mode ? { mode, direction: current.direction === 'asc' ? 'desc' : 'asc' } : { mode, direction: defaultDirection(mode) };

const OPTION_KEYS = [
  { mode: 'received', label: 'receivedTime', asc: 'oldestFirst', desc: 'newestFirst' },
  { mode: 'unread', label: 'unreadMessages', asc: 'unreadLast', desc: 'unreadFirst' },
  { mode: 'name', label: 'name', asc: 'aToZ', desc: 'zToA' },
] as const;
const arrow = (direction: SortDirection) => (direction === 'asc' ? '↑' : '↓');

export function ConversationSortMenu({ value, onChange }: { value: SortState; onChange: (next: SortState) => void }) {
  const desktopText = useDesktopText();
  const OPTIONS = OPTION_KEYS.map((option) => ({ mode: option.mode, label: desktopText(option.label), asc: desktopText(option.asc), desc: desktopText(option.desc) }));
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const root = useRef<HTMLDivElement | null>(null);
  const button = useRef<HTMLButtonElement | null>(null);
  const list = useRef<HTMLUListElement | null>(null);
  const id = useId();
  const current = OPTIONS.find((option) => option.mode === value.mode)!;

  // The outside-click listener exists only while the menu is open.
  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: MouseEvent) => { if (!root.current?.contains(event.target as Node)) setOpen(false); };
    document.addEventListener('mousedown', onPointerDown);
    return () => document.removeEventListener('mousedown', onPointerDown);
  }, [open]);
  useEffect(() => { if (open) list.current?.focus(); }, [open]);

  const openMenu = () => { setActive(Math.max(0, OPTIONS.findIndex((option) => option.mode === value.mode))); setOpen(true); };
  const closeToButton = () => { setOpen(false); button.current?.focus(); };
  const choose = (mode: SortMode) => { onChange(nextSort(value, mode)); closeToButton(); };

  return <div className="sort-menu" ref={root}>
    <button type="button" ref={button} className="sort-menu-button" aria-haspopup="listbox" aria-expanded={open} aria-controls={open ? `${id}-list` : undefined}
      aria-label={desktopText('sortArg0Arg1', { arg0: current.label, arg1: current[value.direction] })}
      onClick={() => (open ? setOpen(false) : openMenu())}
      onKeyDown={(event) => { if (!open && (event.key === 'ArrowDown' || event.key === 'ArrowUp')) { event.preventDefault(); openMenu(); } }}>
      <span>{current.label} {arrow(value.direction)}</span><span aria-hidden="true" className="sort-menu-caret">▾</span>
    </button>
    {open && <ul ref={list} id={`${id}-list`} className="sort-menu-list" role="listbox" tabIndex={-1} aria-label={desktopText('sortOrder')} aria-activedescendant={`${id}-${OPTIONS[active]!.mode}`}
      onKeyDown={(event) => {
        if (event.key === 'ArrowDown') { event.preventDefault(); setActive((index) => Math.min(OPTIONS.length - 1, index + 1)); }
        else if (event.key === 'ArrowUp') { event.preventDefault(); setActive((index) => Math.max(0, index - 1)); }
        else if (event.key === 'Home') { event.preventDefault(); setActive(0); }
        else if (event.key === 'End') { event.preventDefault(); setActive(OPTIONS.length - 1); }
        else if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); choose(OPTIONS[active]!.mode); }
        else if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); closeToButton(); }
        else if (event.key === 'Tab') setOpen(false);
      }}>
      {OPTIONS.map((option, index) => {
        const selected = option.mode === value.mode;
        return <li key={option.mode} id={`${id}-${option.mode}`} role="option" aria-selected={selected} className={`sort-menu-option${index === active ? ' active' : ''}`}
          onMouseEnter={() => setActive(index)} onClick={() => choose(option.mode)}>
          <span>{option.label}</span>{selected && <span aria-hidden="true" className="sort-menu-arrow">{arrow(value.direction)}</span>}
        </li>;
      })}
    </ul>}
  </div>;
}
