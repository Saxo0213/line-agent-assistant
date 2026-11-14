// Builds the message object for `eB` from the official LINE desktop row of an external-monitor message.
// The result has only the fields that `eB`, `QO` and `lB` read. It is never put into the extension store.
// Never log or audit any value of the result. It holds a key (`ENC_KM`) and object ids.

/** Row of the native `_message` envelope: `raw.native.row`. */
export interface NativeRowInput {
  readonly columns: readonly string[];
  readonly cells: readonly unknown[];
}

export interface BridgeMessage {
  readonly id: string;
  readonly contentType: number;
  readonly contentMetadata: Readonly<Record<string, string>>;
}

const MAX_TEXT_BYTES = 64 * 1024;
const NATIVE_CONTENT_TYPES: readonly number[] = [1, 14];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function cellValue(row: NativeRowInput, name: string): unknown {
  const index = row.columns.indexOf(name);
  return index < 0 ? undefined : row.cells[index];
}

function cellText(row: NativeRowInput, name: string): string | null {
  const cell = cellValue(row, name);
  if (typeof cell === 'string') return Buffer.byteLength(cell, 'utf8') <= MAX_TEXT_BYTES ? cell : null;
  if (isRecord(cell) && (cell.sqliteType === 'text' || cell.sqliteType === 'blob') && cell.encoding === 'base64' && typeof cell.data === 'string') {
    if (cell.data.length > MAX_TEXT_BYTES * 2) return null;
    try {
      const decoded = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.from(cell.data, 'base64'));
      return Buffer.byteLength(decoded, 'utf8') <= MAX_TEXT_BYTES ? decoded : null;
    } catch { return null; }
  }
  return null;
}

function cellInteger(row: NativeRowInput, name: string): number | null {
  const cell = cellValue(row, name);
  if (typeof cell === 'number' && Number.isSafeInteger(cell)) return cell;
  if (typeof cell === 'string' && /^-?\d{1,15}$/.test(cell)) return Number(cell);
  if (isRecord(cell) && cell.sqliteType === 'integer' && typeof cell.value === 'string' && /^-?\d{1,15}$/.test(cell.value)) return Number(cell.value);
  return null;
}

/** The `_id` column is text or an integer cell. Returns the id as text. */
function cellId(row: NativeRowInput, name: string): string | null {
  const text = cellText(row, name);
  if (text !== null && text.length > 0) return text;
  const number = cellInteger(row, name);
  return number === null ? null : String(number);
}

function parseObject(text: string | null): Record<string, unknown> | null {
  if (text === null) return null;
  try {
    const parsed: unknown = JSON.parse(text);
    return isRecord(parsed) ? parsed : null;
  } catch { return null; }
}

function scalarText(value: unknown): string | null {
  if (typeof value === 'string' && value.length > 0) return value;
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return null;
}

/**
 * Returns null when `_id`, `_contentType` (1 or 14), `SID`, `keyMaterial` or the e2ee version is missing.
 * Image and file only. Other fields of the row are not copied.
 */
export function buildMessageFromNativeRow(row: NativeRowInput | null | undefined): BridgeMessage | null {
  if (!row || !Array.isArray(row.columns) || !Array.isArray(row.cells)) return null;
  const id = cellId(row, '_id');
  const contentType = cellInteger(row, '_contentType');
  if (id === null || contentType === null || !NATIVE_CONTENT_TYPES.includes(contentType)) return null;
  const metadata = parseObject(cellText(row, '_contentMetadata'));
  const info = parseObject(cellText(row, '_contentInfo'));
  if (!metadata || !info) return null;
  const sid = scalarText(metadata.SID);
  const keyMaterial = typeof info.keyMaterial === 'string' && info.keyMaterial.length > 0 ? info.keyMaterial : null;
  const e2ee = scalarText(metadata.e2eeVersion) ?? scalarText(metadata.e2eeMark);
  if (sid === null || keyMaterial === null || e2ee === null) return null;
  const contentMetadata: Record<string, string> = { SID: sid, e2eeVersion: e2ee, ENC_KM: keyMaterial };
  const oid = scalarText(metadata.OID);
  if (oid !== null) contentMetadata.OID = oid;
  // `QO` reads OBS_POP and `eB` reads DOWNLOAD_URL. Both are copied only when they are non-empty text.
  for (const name of ['OBS_POP', 'DOWNLOAD_URL'] as const) {
    const value = metadata[name];
    if (typeof value === 'string' && value.length > 0) contentMetadata[name] = value;
  }
  const mediaInfo = metadata.MEDIA_CONTENT_INFO;
  if (typeof mediaInfo === 'string' && mediaInfo.length > 0) contentMetadata.MEDIA_CONTENT_INFO = mediaInfo;
  const fileSize = scalarText(metadata.FILE_SIZE);
  if (fileSize !== null) contentMetadata.FILE_SIZE = fileSize;
  if (contentType === 14) {
    const fileName = scalarText(metadata.FILE_NAME) ?? scalarText(info.fileName);
    if (fileName !== null) contentMetadata.FILE_NAME = fileName;
  } else {
    const fileName = scalarText(metadata.FILE_NAME);
    if (fileName !== null) contentMetadata.FILE_NAME = fileName;
  }
  return { id, contentType, contentMetadata };
}

/** Takes the native envelope (raw.native of an External Monitor message) and returns the plain _message row. Null for any other shape. */
export function nativeRowFromEnvelope(native: unknown): NativeRowInput | null {
  if (!isRecord(native)) return null;
  if (native.format !== 2 || native.encoding !== 'plain' || native.table !== '_message' || !isRecord(native.row)) return null;
  const row = native.row;
  return Array.isArray(row.columns) && Array.isArray(row.cells) ? { columns: row.columns as string[], cells: row.cells as unknown[] } : null;
}
