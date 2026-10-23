import { nativeContentMetadataText } from './content-bridge/index.js';

export type StickerDescriptor = {
  stickerId: string;
  animated: boolean;
  altText: string | null;
};

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown> : null;
}

function idText(value: unknown): string | null {
  const text = typeof value === 'string' ? value : typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? String(value) : null;
  return text !== null && /^\d{1,20}$/.test(text) ? text : null;
}

function describe(metadata: Record<string, unknown> | null): StickerDescriptor | null {
  if (!metadata) return null;
  const stickerId = idText(metadata.STKID);
  if (stickerId === null) return null;
  const rawAltText = metadata.STKTXT;
  const cleanedAltText = typeof rawAltText === 'string'
    ? rawAltText.replace(/[\u0000-\u001f\u007f-\u009f]/gu, ' ').replace(/\s+/gu, ' ').trim().slice(0, 200)
    : '';
  return { stickerId, animated: metadata.STKOPT === 'A', altText: cleanedAltText || null };
}

/** Layer 1 fallback: the plain native `_message` row's `_contentMetadata` cell, flat or nested `STK` form. */
function nativeMetadata(native: unknown): Record<string, unknown> | null {
  const text = nativeContentMetadataText(native);
  if (text === null) return null;
  try {
    const outer = record(JSON.parse(text) as unknown);
    if (!outer) return null;
    if (outer.STKID !== undefined) return outer;
    return typeof outer.STK === 'string' && outer.STK.length <= text.length ? record(JSON.parse(outer.STK) as unknown) : null;
  } catch { return null; }
}

export function parseLineStickerDescriptor(raw: unknown): StickerDescriptor | null {
  const root = record(raw);
  return describe(record(record(root?.message)?.contentMetadata)) ?? describe(nativeMetadata(root?.native));
}
