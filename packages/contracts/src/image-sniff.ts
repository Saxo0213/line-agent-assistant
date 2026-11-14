/** The one magic-byte table for image files. The client MIME type and the file name are never used. */
export type SniffedImageMimeType = 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp';

/** Stored file extension for each sniffed image type. */
export const IMAGE_EXTENSION_BY_MIME: Readonly<Record<SniffedImageMimeType, string>> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp',
};

/** Longest prefix that `sniffImageMimeType` reads. */
export const IMAGE_SNIFF_PREFIX_BYTES = 12;

export function sniffImageMimeType(bytes: Uint8Array): SniffedImageMimeType | null {
  const startsWith = (...signature: number[]) => signature.every((value, index) => bytes[index] === value);
  if (bytes.length >= 8 && startsWith(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)) return 'image/png';
  if (bytes.length >= 3 && startsWith(0xff, 0xd8, 0xff)) return 'image/jpeg';
  if (bytes.length >= 6 && (startsWith(0x47, 0x49, 0x46, 0x38, 0x37, 0x61) || startsWith(0x47, 0x49, 0x46, 0x38, 0x39, 0x61))) return 'image/gif';
  if (bytes.length >= 12 && startsWith(0x52, 0x49, 0x46, 0x46) && bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50) return 'image/webp';
  return null;
}
