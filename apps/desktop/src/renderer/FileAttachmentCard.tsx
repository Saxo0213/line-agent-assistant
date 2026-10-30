import { useDesktopText } from './desktop-i18n.js';
import { useEffect, useState } from 'react';
import type { DesktopApi } from '../preload/api.js';
import type { AttachmentBlockReason } from '@line-agent/contracts';
import { attachmentBlockReasonKey } from './desktop-i18n.js';

export type FileAttachmentCardData = {
  id: string;
  kind: 'image' | 'video' | 'audio' | 'file';
  name: string;
  sizeBytes: number;
  status: string;
  canRetryManually?: boolean | undefined;
  /** Why a queued attachment cannot download now. It replaces the plain queued text. */
  blockReason?: AttachmentBlockReason | undefined;
  durationMs?: number | null | undefined;
};

function extensionOf(name: string): string | null {
  const basename = name.split(/[\\/]/).at(-1) ?? '';
  const dot = basename.lastIndexOf('.');
  if (dot <= 0 || dot === basename.length - 1) return null;
  const extension = basename.slice(dot + 1).toLowerCase();
  return /^[a-z0-9]{1,12}$/.test(extension) ? extension : null;
}

export function FileAttachmentCard({ attachment, api, onDownload, onOpen, showOpenAction = true, accountConnected = true }: {
  attachment: FileAttachmentCardData;
  api: DesktopApi;
  onDownload(): void;
  onOpen(): void;
  showOpenAction?: boolean;
  accountConnected?: boolean;
}) {
  const [icon, setIcon] = useState<string | null>(null);
  const desktopText = useDesktopText();
  const extension = extensionOf(attachment.name);
  useEffect(() => {
    let current = true;
    setIcon(null);
    if (extension) void api.resolveFileTypeIcon(extension).then((result) => { if (current) setIcon(result); }).catch(() => undefined);
    return () => { current = false; };
  }, [api, extension]);

  const retryable = attachment.canRetryManually === true && accountConnected;
  const statusLabel: Record<string, string> = { queued: desktopText(attachment.blockReason ? attachmentBlockReasonKey(attachment.blockReason) : 'notDownloaded'), downloading: desktopText('downloading'), ready: desktopText('readyToOpen'), failed: desktopText('downloadFailed'), expired: desktopText('downloadRetryPeriodExpired') };
  return <div className="file-attachment-card">
    <span className="file-attachment-icon" aria-hidden="true">{icon ? <img src={icon} alt="" width="32" height="32" /> : <svg className="file-attachment-glyph" viewBox="0 0 24 24" width="28" height="28" focusable="false"><path fill="currentColor" d="M6 2h8l6 6v12a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2zm7 1.5V9h5.5L13 3.5z" /></svg>}</span>
    <span className="file-attachment-details">
      <strong title={attachment.name || undefined}>{attachment.kind === 'image' ? desktopText('image') : attachment.name || desktopText('unnamedFile')}</strong>
      <small>{statusLabel[attachment.status] ?? desktopText('processing')}</small>
      {attachment.durationMs != null && <small>{Math.floor(attachment.durationMs / 60000)}:{String(Math.floor(attachment.durationMs / 1000) % 60).padStart(2, '0')}</small>}
    </span>
    {retryable
      ? <button onClick={onDownload}>{desktopText('download')}</button>
      : showOpenAction && <button disabled={attachment.status !== 'ready'} onClick={onOpen}>{desktopText('open')}</button>}
  </div>;
}
