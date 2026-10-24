import { LineMediaTargetSchema, type LineMediaTarget } from './ipc.js';

function wellFormed(value: string): boolean {
  const check = (value as string & { isWellFormed?: () => boolean }).isWellFormed;
  if (typeof check === 'function') return check.call(value);
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(i + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return false;
      i++;
    } else if (code >= 0xdc00 && code <= 0xdfff) return false;
  }
  return true;
}

function encode(value: string): string {
  let binary = '';
  for (const byte of new TextEncoder().encode(value)) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function decode(value: string): string | null {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) return null;
  try {
    const base64 = value.replace(/-/g, '+').replace(/_/g, '/');
    const binary = atob(base64 + '='.repeat((4 - base64.length % 4) % 4));
    const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
    let canonical = '';
    for (const byte of bytes) canonical += String.fromCharCode(byte);
    if (btoa(canonical).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '') !== value) return null;
    return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch { return null; }
}

export function lineMediaUrl(input: LineMediaTarget): string | null {
  try {
  const parsed = LineMediaTargetSchema.safeParse(input);
  if (!parsed.success) return null;
  const target = parsed.data;
  const ids = target.type === 'account' ? [target.accountId]
    : target.type === 'conversation' ? [target.accountId, target.chatId]
    : target.type === 'member' ? [target.accountId, target.chatId, target.memberId]
    : target.type === 'sticker' || target.type === 'sticon' || target.type === 'reaction' ? [target.accountId, target.chatId, target.messageId]
    : target.type === 'albumPhoto' ? [target.accountId, target.chatId, target.albumId, target.photoId]
    : [target.accountId, target.chatId, target.attachmentId];
  if (ids.some((id) => !wellFormed(id))) return null;
  switch (target.type) {
    case 'account': return `line-media://avatar/account/${encode(target.accountId)}`;
    case 'conversation': return `line-media://avatar/conversation/${encode(target.accountId)}/${target.chatType}/${encode(target.chatId)}`;
    case 'member': return `line-media://avatar/member/${encode(target.accountId)}/${target.chatType}/${encode(target.chatId)}/${encode(target.memberId)}`;
    case 'sticker': return `line-media://sticker/${encode(target.accountId)}/${target.chatType}/${encode(target.chatId)}/${encode(target.messageId)}`;
    case 'sticon': return `line-media://sticon/${encode(target.accountId)}/${target.chatType}/${encode(target.chatId)}/${encode(target.messageId)}/${target.index}`;
    case 'reaction': return `line-media://reaction/${encode(target.accountId)}/${target.chatType}/${encode(target.chatId)}/${encode(target.messageId)}/${target.productId}/${target.emojiId}`;
    case 'attachment': return `line-media://attachment/${encode(target.accountId)}/${target.chatType}/${encode(target.chatId)}/${encode(target.attachmentId)}`;
    case 'albumPhoto': return `line-media://album-photo/${encode(target.accountId)}/${target.chatType}/${encode(target.chatId)}/${encode(target.albumId)}/${encode(target.photoId)}`;
  }
  } catch { return null; }
}

export function parseLineMediaUrl(value: string): LineMediaTarget | null {
  if (typeof value !== 'string' || !value.startsWith('line-media://') || /[?#]/.test(value)) return null;
  const match = /^line-media:\/\/(avatar|sticker|sticon|reaction|attachment|album-photo)\/([^?#]*)$/.exec(value);
  if (!match) return null;
  const route = match[1]!;
  const segments = match[2]!.split('/');
  let target: unknown;
  const id = (segment: string | undefined) => segment === undefined ? null : decode(segment);
  const chatType = (segment: string | undefined) => segment === 'direct' || segment === 'group' || segment === 'community' ? segment : null;
  if (route === 'avatar' && segments[0] === 'account' && segments.length === 2) {
    const accountId = id(segments[1]); if (accountId === null) return null;
    target = { type: 'account', accountId };
  } else if (route === 'avatar' && segments[0] === 'conversation' && segments.length === 4) {
    const accountId = id(segments[1]), ct = chatType(segments[2]), chatId = id(segments[3]);
    if (accountId === null || !ct || chatId === null) return null;
    target = { type: 'conversation', accountId, chatType: ct, chatId };
  } else if (route === 'avatar' && segments[0] === 'member' && segments.length === 5) {
    const accountId = id(segments[1]), ct = chatType(segments[2]), chatId = id(segments[3]), memberId = id(segments[4]);
    if (accountId === null || !ct || chatId === null || memberId === null) return null;
    target = { type: 'member', accountId, chatType: ct, chatId, memberId };
  } else if ((route === 'sticker' || route === 'attachment') && segments.length === 4) {
    const accountId = id(segments[0]), ct = chatType(segments[1]), chatId = id(segments[2]), last = id(segments[3]);
    if (accountId === null || !ct || chatId === null || last === null) return null;
    target = route === 'sticker' ? { type: route, accountId, chatType: ct, chatId, messageId: last }
      : { type: route, accountId, chatType: ct, chatId, attachmentId: last };
  } else if (route === 'album-photo' && segments.length === 5) {
    const accountId = id(segments[0]), ct = chatType(segments[1]), chatId = id(segments[2]), albumId = id(segments[3]), photoId = id(segments[4]);
    if (accountId === null || !ct || chatId === null || albumId === null || photoId === null) return null;
    target = { type: 'albumPhoto', accountId, chatType: ct, chatId, albumId, photoId };
  } else if (route === 'sticon' && segments.length === 5) {
    const accountId = id(segments[0]), ct = chatType(segments[1]), chatId = id(segments[2]), messageId = id(segments[3]);
    if (accountId === null || !ct || chatId === null || messageId === null || !/^\d+$/.test(segments[4]!)) return null;
    target = { type: route, accountId, chatType: ct, chatId, messageId, index: Number(segments[4]) };
  } else if (route === 'reaction' && segments.length === 6) {
    const accountId = id(segments[0]), ct = chatType(segments[1]), chatId = id(segments[2]), messageId = id(segments[3]);
    if (accountId === null || !ct || chatId === null || messageId === null) return null;
    target = { type: route, accountId, chatType: ct, chatId, messageId, productId: segments[4], emojiId: segments[5] };
  } else return null;
  const parsed = LineMediaTargetSchema.safeParse(target);
  return parsed.success ? parsed.data : null;
}
