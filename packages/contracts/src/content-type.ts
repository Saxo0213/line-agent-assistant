import type { MessageKind } from './line.js';

/** LINE `ContentType` names (linejs enum); the live server format sends a name or a number. */
export const LINE_CONTENT_TYPE_NUMBER_BY_NAME: Readonly<Record<string, number>> = {
  NONE: 0, IMAGE: 1, VIDEO: 2, AUDIO: 3, HTML: 4, PDF: 5, CALL: 6, STICKER: 7, PRESENCE: 8, GIFT: 9, GROUPBOARD: 10, APPLINK: 11,
  LINK: 12, CONTACT: 13, FILE: 14, LOCATION: 15, POSTNOTIFICATION: 16, RICH: 17, CHATEVENT: 18, MUSIC: 19, PAYMENT: 20, EXTIMAGE: 21, FLEX: 22,
};

/** The one content-type -> message kind map shared by the live normalizer (routing) and the database content bridge. */
export const LINE_CONTENT_KIND_BY_TYPE: Readonly<Record<number, MessageKind>> = {
  0: 'text', 1: 'image', 2: 'video', 3: 'audio', 7: 'sticker', 13: 'contact', 14: 'file', 15: 'location', 17: 'rich', 22: 'rich',
  6: 'event', 9: 'event', 16: 'event', 18: 'event',
};

/** Kind for a content type given as a number, a linejs name, or numeric text; anything unknown is an `event`. */
export function lineContentKind(value: unknown): MessageKind {
  const type = typeof value === 'number' ? value
    : typeof value === 'string' ? LINE_CONTENT_TYPE_NUMBER_BY_NAME[value] ?? (/^\d{1,4}$/.test(value) ? Number(value) : undefined) : undefined;
  return type === undefined ? 'event' : LINE_CONTENT_KIND_BY_TYPE[type] ?? 'event';
}
