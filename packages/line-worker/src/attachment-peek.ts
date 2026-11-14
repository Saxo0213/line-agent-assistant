import { IMAGE_EXTENSION_BY_MIME, IMAGE_SNIFF_PREFIX_BYTES, sniffImageMimeType } from '@line-agent/contracts';

/** Fallback stored file name for an unnamed image download. Only the first bytes decide the extension. */
export const UNKNOWN_ATTACHMENT_FILE_NAME = 'attachment.bin';

function nextOrAbort<T>(iterator: AsyncIterator<T>, signal: AbortSignal): Promise<IteratorResult<T>> {
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise((resolve, reject) => {
    const onAbort = () => reject(signal.reason);
    signal.addEventListener('abort', onAbort, { once: true });
    iterator.next().then(
      (value) => { signal.removeEventListener('abort', onAbort); resolve(value); },
      (error: unknown) => { signal.removeEventListener('abort', onAbort); reject(error); },
    );
  });
}

/**
 * Reads the first chunks of a download source until `minBytes` bytes are known, and returns a source that
 * yields the same bytes again from the start. The caller can inspect `prefix` before it chooses a file name.
 */
export async function peekAttachmentSource(
  source: AsyncIterable<Uint8Array>,
  minBytes: number,
  signal: AbortSignal,
): Promise<{ prefix: Buffer; source: AsyncIterable<Uint8Array> }> {
  const iterator = source[Symbol.asyncIterator]();
  const buffered: Uint8Array[] = [];
  let total = 0;
  let ended = false;
  try {
    while (total < minBytes) {
      const next = await nextOrAbort(iterator, signal);
      if (next.done) { ended = true; break; }
      buffered.push(next.value);
      if (!(next.value instanceof Uint8Array)) break; // storeAttachment rejects a non-byte chunk
      total += next.value.byteLength;
    }
  } catch (error) {
    void Promise.resolve(iterator.return?.()).catch(() => undefined);
    throw error;
  }
  const prefix = Buffer.concat(buffered.filter((chunk): chunk is Uint8Array => chunk instanceof Uint8Array)).subarray(0, minBytes);
  async function* replay(): AsyncGenerator<Uint8Array> {
    let finished = false;
    try {
      yield* buffered;
      while (!ended) {
        const next = await iterator.next();
        if (next.done) { ended = true; break; }
        yield next.value;
      }
      finished = true;
    } finally {
      if (!finished && !ended) await Promise.resolve(iterator.return?.()).catch(() => undefined);
    }
  }
  return { prefix, source: { [Symbol.asyncIterator]: replay } };
}

/** `attachment.<ext>` for a recognized image signature, otherwise `attachment.bin`. */
export function fallbackAttachmentFileName(prefix: Uint8Array): string {
  const mime = sniffImageMimeType(prefix);
  return mime ? `attachment.${IMAGE_EXTENSION_BY_MIME[mime]}` : UNKNOWN_ATTACHMENT_FILE_NAME;
}

export { IMAGE_SNIFF_PREFIX_BYTES };
