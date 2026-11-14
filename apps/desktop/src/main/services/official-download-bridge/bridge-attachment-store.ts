// Saves the bytes of a bridge download with the same store and the same name rules as the worker download.
// It uses `storeAttachment` and the Windows attachment broker, as `AttachmentStorageService` does.

import type { Attachment } from '@line-agent/database';
import {
  IMAGE_SNIFF_PREFIX_BYTES, fallbackAttachmentFileName, peekAttachmentSource, sanitizeAttachmentFilename, storeAttachment,
  type AttachmentFilesystemSafetyBroker,
} from '@line-agent/line-worker/attachment-storage';

export interface BridgeStoreInput {
  readonly attachment: Attachment;
  /** `File.name` of the extension File. */
  readonly name: string;
  readonly source: AsyncIterable<Uint8Array>;
  readonly maxBytes: number;
  readonly signal: AbortSignal;
}

export interface BridgeStoredAttachment {
  readonly relativePath: string;
  readonly sha256: string;
  readonly sizeBytes: number;
  readonly name: string;
}

export type BridgeAttachmentStore = (input: BridgeStoreInput) => Promise<BridgeStoredAttachment>;

const STORE_TIMEOUT_MS = 300_000;

function safeName(name: string | null | undefined): string | undefined {
  if (name == null) return undefined;
  try { return sanitizeAttachmentFilename(name); } catch { return undefined; }
}

export function createBridgeAttachmentStore(options: { root: string; broker?: AttachmentFilesystemSafetyBroker }): BridgeAttachmentStore {
  return async (input) => {
    const { attachment } = input;
    const namedByLine = safeName(input.name);
    let originalFileName = namedByLine ?? safeName(attachment.name) ?? 'attachment.blob';
    let source = input.source;
    // Same rule as the worker: an unnamed image gets its extension from the first bytes.
    if (attachment.kind === 'image' && namedByLine === undefined && (originalFileName === 'attachment.bin' || originalFileName === 'attachment.blob')) {
      const peeked = await peekAttachmentSource(source, IMAGE_SNIFF_PREFIX_BYTES, input.signal);
      source = peeked.source;
      originalFileName = fallbackAttachmentFileName(peeked.prefix);
    }
    const stored = await storeAttachment({
      root: options.root,
      identity: { accountId: attachment.accountId, chatType: attachment.chatType as 'direct' | 'group' | 'room', chatId: attachment.chatId,
        messageId: attachment.messageId, externalAttachmentId: attachment.externalAttachmentId },
      occurredAt: attachment.occurredAt,
      originalFileName,
      ...(attachment.chatType !== 'direct' ? { sender: { id: attachment.senderId ?? 'unknown', displayName: attachment.senderDisplayName ?? null } } : {}),
      source, maxBytes: input.maxBytes, timeoutMs: STORE_TIMEOUT_MS, signal: input.signal,
    }, options.broker ? { windowsSafetyBroker: options.broker } : {});
    return { relativePath: stored.managedRelativePath.replaceAll('\\', '/'), sha256: stored.sha256, sizeBytes: stored.size,
      name: stored.sanitizedDisplayFileName };
  };
}
