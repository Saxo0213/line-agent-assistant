import { desktopTextFor } from './desktop-i18n.js';
import type { Locale } from '../locale.js';
/** Renderer labels for archived LINE conversation categories. */
export function chatTypeLabel(localeOrType: Locale | string, maybeType?: string): string {
  const locale: Locale = maybeType === undefined ? 'en' : localeOrType as Locale;
  const chatType = maybeType ?? localeOrType;
  switch (chatType) {
    case 'direct': return desktopTextFor(locale, 'direct');
    case 'group': return desktopTextFor(locale, 'group');
    case 'room': return desktopTextFor(locale, 'room');
    case 'community': return desktopTextFor(locale, 'community');
    case 'thread': return desktopTextFor(locale, 'thread');
    default: return desktopTextFor(locale, 'room');
  }
}

export function conversationFallbackTitle(localeOrType: Locale | string, maybeType?: string): string {
  const locale: Locale = maybeType === undefined ? 'en' : localeOrType as Locale;
  const chatType = maybeType ?? localeOrType;
  switch (chatType) {
    case 'direct': return desktopTextFor(locale, 'directChat');
    case 'community': return desktopTextFor(locale, 'community');
    case 'thread': return desktopTextFor(locale, 'thread');
    case 'group': return desktopTextFor(locale, 'groupConversation');
    default: return desktopTextFor(locale, 'room');
  }
}
