import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { lineMediaUrl, type ConversationKey, type LineMediaTarget } from '@line-agent/contracts';
import type { DesktopApi } from '../preload/api.js';

type Props = {
  api?: DesktopApi;
  enabled: boolean;
  target?: LineMediaTarget | undefined;
  attachment?: { key: ConversationKey; attachmentId: string };
  fallback?: string;
  accessibleFallback?: boolean;
  fallbackKind?: 'person' | 'group';
  className: string;
  alt?: string;
  title?: string;
};

export function AvatarPlaceholder({ kind, className }: { kind: 'person' | 'group'; className: string }) {
  return <span className={`avatar-placeholder ${className}`} data-avatar-placeholder={kind} aria-hidden="true">
    <svg viewBox="0 0 24 24" focusable="false">
      {kind === 'person'
        ? <><circle cx="12" cy="8" r="3.3" fill="currentColor" /><path d="M5.2 20v-1.3a6.8 6.8 0 0 1 13.6 0V20z" fill="currentColor" /></>
        : <><circle cx="9" cy="8" r="2.8" fill="currentColor" /><circle cx="16.5" cy="9" r="2.3" fill="currentColor" /><path d="M2.8 19.8v-1a6.2 6.2 0 0 1 12.4 0v1z" fill="currentColor" /><path d="M15 14.1a5.1 5.1 0 0 1 6.2 5v.7h-4.3v-1a8.4 8.4 0 0 0-1.9-4.7z" fill="currentColor" /></>}
    </svg>
  </span>;
}

const visibleAttachments = new Map<Element, (visible: boolean) => void>();
let attachmentObserver: IntersectionObserver | null = null;
const refreshedAccountAvatars = new Map<string, { version: number; ownMid: string }>();
const accountAvatarListeners = new Set<() => void>();

export function accountAvatarRefreshed(accountId: string, ownMid: string): void {
  const previous = refreshedAccountAvatars.get(accountId);
  refreshedAccountAvatars.set(accountId, { version: (previous?.version ?? 0) + 1, ownMid });
  for (const listener of accountAvatarListeners) listener();
}

function avatarRefreshVersion(target: LineMediaTarget | undefined): number {
  if (!target) return 0;
  const refreshed = refreshedAccountAvatars.get(target.accountId);
  if (!refreshed) return 0;
  if (target.type === 'account') return refreshed.version;
  if (target.type === 'conversation' && target.chatType === 'direct' && target.chatId === refreshed.ownMid) return refreshed.version;
  if (target.type === 'member' && target.memberId === refreshed.ownMid) return refreshed.version;
  return 0;
}

function subscribeToAccountAvatarRefresh(listener: () => void): () => void {
  accountAvatarListeners.add(listener);
  return () => accountAvatarListeners.delete(listener);
}

function observeAttachment(element: Element, update: (visible: boolean) => void): () => void {
  visibleAttachments.set(element, update);
  if (typeof IntersectionObserver === 'undefined') { update(true); return () => visibleAttachments.delete(element); }
  attachmentObserver ??= new IntersectionObserver((entries) => {
    for (const entry of entries) visibleAttachments.get(entry.target)?.(entry.isIntersecting);
  }, { rootMargin: '160px' });
  attachmentObserver.observe(element);
  return () => {
    visibleAttachments.delete(element);
    attachmentObserver?.unobserve(element);
    if (visibleAttachments.size === 0) { attachmentObserver?.disconnect(); attachmentObserver = null; }
  };
}

export function LineMediaImage(props: Props) {
  const target = props.target ?? (props.attachment ? { type: 'attachment' as const,
    ...props.attachment.key, attachmentId: props.attachment.attachmentId } : undefined);
  const scope = JSON.stringify(target ?? null);
  const refreshedAt = useSyncExternalStore(subscribeToAccountAvatarRefresh,
    () => avatarRefreshVersion(target),
    () => 0);
  return <LineMediaImageRequest key={JSON.stringify([scope, props.enabled, refreshedAt])} {...props} target={target} />;
}

function LineMediaImageRequest({ enabled, target, fallback, fallbackKind, accessibleFallback, className, alt = '', title }: Props) {
  const [failed, setFailed] = useState(false);
  const [visible, setVisible] = useState(false);
  const sentinel = useRef<HTMLSpanElement>(null);
  const url = target ? lineMediaUrl(target) : null;

  useEffect(() => {
    if (!enabled || !target || !sentinel.current) return;
    return observeAttachment(sentinel.current, setVisible);
  }, [enabled, JSON.stringify(target)]);

  if (target?.type === 'attachment') return <span ref={sentinel} className="inline-attachment-image-container" aria-label={alt}>
    {enabled && visible && url && !failed
      ? <img className={className} src={url} alt={alt} onError={() => setFailed(true)} />
      : <span className="inline-attachment-image-placeholder">{fallback ?? 'Image'}</span>}
  </span>;
  if (enabled && url && !failed) return <img className={className} src={url} alt={alt} title={title} onError={() => setFailed(true)} />;
  if (fallbackKind) return <AvatarPlaceholder kind={fallbackKind} className={className} />;
  return <span className={className} aria-hidden={accessibleFallback ? undefined : true}
    role={accessibleFallback ? 'img' : undefined} aria-label={accessibleFallback ? fallback : undefined}>{fallback}</span>;
}
