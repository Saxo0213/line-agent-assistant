import React from 'react';
import { useDesktopLocale } from './desktop-i18n.js';
import { chatTypeLabel } from './chatTypeLabels.js';

type IconKind = 'person' | 'people' | 'house' | 'bubble';

function iconKind(chatType: string): IconKind {
  switch (chatType) {
    case 'direct': return 'person';
    case 'community': return 'house';
    case 'thread': return 'bubble';
    default: return 'people'; // group, room and unknown multi-person chats
  }
}

/** Small currentColor icon replacing the textual 「（個人）」-style conversation prefix. */
export function ChatTypeIcon({ chatType }: { chatType: string }) {
  const locale = useDesktopLocale();
  const kind = iconKind(chatType);
  return <svg className="chat-type-icon" data-chat-icon={kind} role="img" aria-label={chatTypeLabel(locale, chatType)} viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    {kind === 'person' && <><circle cx="12" cy="8" r="4" /><path d="M4.5 21c0-4 3.4-6.5 7.5-6.5s7.5 2.5 7.5 6.5" /></>}
    {kind === 'people' && <><circle cx="9" cy="8" r="3.6" /><path d="M2.5 20c0-3.6 2.9-5.8 6.5-5.8s6.5 2.2 6.5 5.8" /><path d="M15.5 4.6a3.6 3.6 0 0 1 0 6.8" /><path d="M17.5 14.6c2.4.6 4 2.5 4 5.4" /></>}
    {kind === 'house' && <><path d="M3 11.5 12 4l9 7.5" /><path d="M5.5 10v10h13V10" /><path d="M10 20v-5.5h4V20" /></>}
    {kind === 'bubble' && <path d="M4 5h16v11H10l-5 4v-4H4z" />}
  </svg>;
}

/** Wraps an avatar and overlays the chat-type icon on its top-left corner. */
export function AvatarWithTypeBadge({ chatType, children }: { chatType?: string | undefined; children: React.ReactNode }) {
  return <span className="avatar-badge-wrap">{children}{chatType && <span className="chat-type-badge" data-chat-type={chatType}><ChatTypeIcon chatType={chatType} /></span>}</span>;
}
