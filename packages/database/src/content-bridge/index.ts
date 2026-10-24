import { LINE_CONTENT_KIND_BY_TYPE, LINE_CONTENT_TYPE_NUMBER_BY_NAME, NativeSourceEnvelopeSchema, parseSticonRanges, redactMessageContent, redactSensitiveText, STICON_REPLACE_MAX_BYTES, type ContactDescriptor, type MessageContent, type MessageKind, type NativeSourceEnvelope, type SticonRange } from '@line-agent/contracts';

/**
 * Layer 2 of the two-layer message storage (docs/architecture/content-bridge-two-layer-2026-10-20.md).
 * Layer 1 (messages.raw / raw.native) is never rewritten here. This module is the only place that parses
 * LINE content types: pure, bounded, synchronous. Both the live worker envelope and the plain native
 * row envelope are first reduced to the same `BridgeFields`, so one rule serves both sources.
 */
export type BridgeSource = 'native' | 'live';
export type BridgeLocation = Readonly<{ title: string | null; address: string | null; latitude: number | null; longitude: number | null }>;
export type BridgeFields = Readonly<{
  contentType: number | null;
  text: string | null;
  metadata: Readonly<Record<string, unknown>>;
  location: BridgeLocation | null;
  contact: Readonly<{ mid: string | null; displayName: string | null }> | null;
  /** Native `_eventInfo` cell, JSON-parsed under the metadata byte bound; null when absent, oversized or malformed. */
  eventInfo: Readonly<Record<string, unknown>> | null;
  /** Display names of the MIDs a type-18 chat event mentions (resolved by the caller from contacts/members); absent = all fall back. */
  names?: ReadonlyMap<string, string>;
}>;
export type BridgeRule = Readonly<{
  source: BridgeSource;
  contentType: number | '*';
  /** 0 = this type has no projection (content stays NULL); a rule that produces content starts at 1. */
  version: number;
  convert(fields: BridgeFields): MessageContent | null;
}>;
export type BridgeResult = Readonly<{
  content: MessageContent | null;
  version: number;
  kind: MessageKind;
  replyToMessageId: string | null;
}>;

export const MAX_METADATA_BYTES = STICON_REPLACE_MAX_BYTES;
const MAX_TEXT_CHARS = 4096;
const SAFE_INTEGER_TEXT = /^\d{1,16}$/;

function boundedText(value: unknown, max = MAX_TEXT_CHARS): string | null {
  if (typeof value !== 'string') return null;
  let text = value.replaceAll('\0', '�').trim();
  if (text.length > max) {
    text = text.slice(0, max);
    const last = text.charCodeAt(text.length - 1);
    if (last >= 0xd800 && last <= 0xdbff) text = text.slice(0, -1);
  }
  return text.length === 0 ? null : text;
}
function finiteWithin(value: unknown, limit: number): number | null {
  return typeof value === 'number' && Number.isFinite(value) && Math.abs(value) <= limit ? value : null;
}

const convertContact = (f: BridgeFields): MessageContent => ({ format: 1, type: 'contact',
  mid: boundedText(f.contact?.mid, 512), displayName: boundedText(f.contact?.displayName, 128) });
const convertLocation = (f: BridgeFields): MessageContent => ({ format: 1, type: 'location',
  title: boundedText(f.location?.title, 1024), address: boundedText(f.location?.address, 2048),
  latitude: finiteWithin(f.location?.latitude, 90), longitude: finiteWithin(f.location?.longitude, 180) });
const convertRich = (variant: 'rich' | 'flex') => (f: BridgeFields): MessageContent => ({ format: 1, type: 'rich',
  variant, altText: boundedText(f.metadata.ALT_TEXT) });
const convertMedia = (f: BridgeFields): MessageContent => {
  const duration = f.metadata.DURATION;
  const text = typeof duration === 'string' ? duration
    : typeof duration === 'number' && Number.isSafeInteger(duration) && duration >= 0 ? String(duration) : '';
  return { format: 1, type: 'media', durationMs: SAFE_INTEGER_TEXT.test(text) && Number.isSafeInteger(Number(text)) ? Number(text) : null };
};
const convertEvent = (type: number) => (f: BridgeFields): MessageContent => ({ format: 1, type: 'event',
  nativeContentType: type, text: boundedText(f.text) });
const convertCall = (f: BridgeFields): MessageContent => {
  const type = f.metadata.TYPE;
  const resultValue = f.metadata.RESULT;
  const durationValue = f.metadata.DURATION;
  const result = typeof resultValue === 'string' && /^[A-Z0-9_]{1,32}$/.test(resultValue) ? resultValue : null;
  const durationText = typeof durationValue === 'string' && /^\d+$/.test(durationValue) ? durationValue
    : typeof durationValue === 'number' && Number.isSafeInteger(durationValue) && durationValue >= 0 ? String(durationValue) : null;
  const durationMs = durationText !== null && Number.isSafeInteger(Number(durationText)) ? Number(durationText) : null;
  const hasCall = ['TYPE', 'RESULT', 'DURATION'].some((key) => Object.hasOwn(f.metadata, key));
  return { format: 1, type: 'event', nativeContentType: 6, text: boundedText(f.text),
    call: hasCall ? { media: type === 'A' ? 'audio' : type === 'V' ? 'video' : null, result, durationMs } : null };
};
const convertUnsupported = (f: BridgeFields): MessageContent => ({ format: 1, type: 'unsupported',
  nativeContentType: f.contentType, fallbackText: boundedText(f.text) ?? boundedText(f.metadata.ALT_TEXT) });
const noProjection = (): null => null;
const MEMBER_FALLBACK = '成員';
const MAX_EVENT_TARGETS = 20;
const CHAT_EVENT_MID = /^[ucr][0-9a-f]{32}$/;
/** LOC_KEY -> whether the key carries targets (after the actor). */
const CHAT_EVENT_HAS_TARGETS: Readonly<Record<string, boolean>> = { C_MI: true, C_GI: true, C_MJ: false, A_MC: true };
/** `LOC_ARGS` of a native type-18 chat event: actor, then (after U+001E) targets separated by U+001F. Null when malformed. */
function parseChatEventArgs(metadata: Readonly<Record<string, unknown>>): { actor: string; targets: string[] } | null {
  const raw = metadata.LOC_ARGS;
  if (typeof raw !== 'string' || raw.length === 0 || Buffer.byteLength(raw, 'utf8') > MAX_METADATA_BYTES) return null;
  const sides = raw.split('\u001e');
  if (sides.length > 2) return null;
  const actor = sides[0]!;
  const targets = sides.length === 2 ? sides[1]!.split('\u001f') : [];
  if (!CHAT_EVENT_MID.test(actor) || !targets.every((mid) => CHAT_EVENT_MID.test(mid))) return null;
  return { actor, targets };
}
/** Native type 18 (CHATEVENT): LINE's localized group system line, rebuilt from `LOC_KEY`/`LOC_ARGS`. Unknown or malformed stays text-less. */
const convertChatEvent = (f: BridgeFields): MessageContent => {
  const plain: MessageContent = { format: 1, type: 'event', nativeContentType: 18, text: boundedText(f.text) };
  const key = f.metadata.LOC_KEY;
  if (typeof key !== 'string' || !Object.hasOwn(CHAT_EVENT_HAS_TARGETS, key)) return plain;
  const args = parseChatEventArgs(f.metadata);
  if (args === null || (args.targets.length > 0) !== CHAT_EVENT_HAS_TARGETS[key]) return plain;
  const nameOf = (mid: string): string => boundedText(f.names?.get(mid), 128) ?? MEMBER_FALLBACK;
  const actor = nameOf(args.actor);
  const targets = args.targets.slice(0, MAX_EVENT_TARGETS).map(nameOf).join(', ');
  const text = key === 'C_GI' ? `${actor}已邀請${targets}加入群組，等對方加入再一起聊天吧！`
    : key === 'C_MJ' ? `${actor}已加入群組。` : `${actor}已新增${targets}至群組。`;
  return { format: 1, type: 'event', nativeContentType: 18, text };
};
/** MIDs a native type-18 row's text depends on (actor first), or [] when the row is not a recognised chat event. */
export function nativeChatEventMids(envelope: NativeSourceEnvelope | null | undefined): string[] {
  try {
    if (!envelope || envelope.format !== 2 || envelope.encoding !== 'plain' || envelope.table !== '_message') return [];
    const cells = cellMap(envelope);
    if (cellInteger(cells, '_contentType') !== 18) return [];
    const metadataText = cellText(cells, '_contentMetadata');
    if (metadataText === null) return [];
    const parsed: unknown = JSON.parse(metadataText);
    if (!isRecord(parsed) || typeof parsed.LOC_KEY !== 'string' || !Object.hasOwn(CHAT_EVENT_HAS_TARGETS, parsed.LOC_KEY)) return [];
    const args = parseChatEventArgs(parsed);
    return args ? [args.actor, ...args.targets.slice(0, MAX_EVENT_TARGETS)] : [];
  } catch { return []; }
}
/** MIDs needed to format a live type-18 event; malformed or unrelated envelopes return no identifiers. */
export function liveChatEventMids(rawValue: unknown): string[] {
  try {
    if (!isRecord(rawValue) || rawValue.contentState !== undefined || !isRecord(rawValue.message)) return [];
    const message = rawValue.message;
    const type = typeof message.contentType === 'number' ? message.contentType
      : typeof message.contentType === 'string' ? TYPE_NUMBER_BY_NAME[message.contentType] ?? Number(message.contentType) : null;
    const metadata = message.contentMetadata;
    if (type !== 18 || !isRecord(metadata) || typeof metadata.LOC_KEY !== 'string'
      || !Object.hasOwn(CHAT_EVENT_HAS_TARGETS, metadata.LOC_KEY)) return [];
    const args = parseChatEventArgs(metadata);
    return args ? [args.actor, ...args.targets.slice(0, MAX_EVENT_TARGETS)] : [];
  } catch { return []; }
}
/** Native type 0 with `_eventInfo.type` 15: LINE's community member-removal system line; every other type-0 row has no projection. */
const convertNativeText = (f: BridgeFields): MessageContent | null => {
  const info = f.eventInfo;
  if (info === null || (info.type !== 15 && info.type !== '15')) return null;
  const names = isRecord(info.displayNameMap) ? info.displayNameMap : {};
  const nameOf = (mid: unknown): string => (typeof mid === 'string' && Object.hasOwn(names, mid) ? boundedText(names[mid], 128) : null) ?? MEMBER_FALLBACK;
  const mids = Array.isArray(info.midList) ? info.midList.slice(0, MAX_EVENT_TARGETS) : [];
  const targets = mids.length > 0 ? mids.map(nameOf).join('、') : MEMBER_FALLBACK;
  return { format: 1, type: 'event', nativeContentType: 0, text: `${nameOf(info.fromId)}已將${targets}強制退出社群。` };
};

/** LINE ContentType (linejs enum) -> converter, rule version (the kind map lives in contracts). */
const TYPE_TABLE: ReadonlyArray<readonly [number, (f: BridgeFields) => MessageContent | null, number]> = [
  [0, noProjection, 0], [1, noProjection, 0], [7, noProjection, 0], [14, noProjection, 0],
  [2, convertMedia, 1], [3, convertMedia, 1],
  [13, convertContact, 1], [15, convertLocation, 1],
  [17, convertRich('rich'), 1], [22, convertRich('flex'), 1],
  [6, convertCall, 1], [9, convertEvent(9), 1], [16, convertEvent(16), 1], [18, convertChatEvent, 2],
];

/** The ordered bridge table: exact content-type rules first, the `*` fallback last, per source. */
export const CONTENT_BRIDGE_RULES: readonly BridgeRule[] = (['native', 'live'] as const).flatMap((source): BridgeRule[] => [
  ...TYPE_TABLE.map(([contentType, convert, version]): BridgeRule => source === 'native' && contentType === 0
    ? { source, contentType, version: 1, convert: convertNativeText } : { source, contentType, version, convert }),
  { source, contentType: '*', version: 1, convert: convertUnsupported },
]);

const TYPE_NUMBER_BY_NAME = LINE_CONTENT_TYPE_NUMBER_BY_NAME;
/** The `raw->'message'->>'contentType'` spellings that identify a type in Layer 1 (number text and linejs name). */
export function contentTypeAliases(type: number): string[] {
  return [String(type), ...Object.entries(TYPE_NUMBER_BY_NAME).filter(([, value]) => value === type).map(([name]) => name)];
}

export function bridgeRuleFor(source: BridgeSource, contentType: number | null, rules: readonly BridgeRule[] = CONTENT_BRIDGE_RULES): BridgeRule {
  return rules.find((rule) => rule.source === source && rule.contentType === contentType)
    ?? rules.find((rule) => rule.source === source && rule.contentType === '*')!;
}

/** Bridge kind for a content type; the same map the live normalizer routes with (contracts LINE_CONTENT_KIND_BY_TYPE). */
export function bridgeKindFor(type: number | null): MessageKind { return type === null ? 'event' : LINE_CONTENT_KIND_BY_TYPE[type] ?? 'event'; }

function applyRules(source: BridgeSource, fields: BridgeFields, replyToMessageId: string | null, rules: readonly BridgeRule[]): BridgeResult {
  const type = fields.contentType === 0 && fields.location !== null ? 15 : fields.contentType;
  const rule = bridgeRuleFor(source, type, rules);
  const converted = fields.metadata.UNSENT === true || fields.metadata.UNSENT === 'true'
    ? { format: 1 as const, type: 'unsent' as const } : rule.convert({ ...fields, contentType: type });
  // Only the native type-0 member-removal projection changes the kind (text -> event); every other row keeps its type's kind.
  const kind = type === 0 && converted?.type === 'event' ? 'event' : bridgeKindFor(type);
  return { content: converted === null ? null : redactMessageContent(converted), version: rule.version, kind, replyToMessageId };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function relationReply(relationType: unknown, relatedId: unknown): string | null {
  if (relationType !== 3 && relationType !== 'REPLY') return null;
  const id = typeof relatedId === 'string' ? relatedId : typeof relatedId === 'number' && Number.isSafeInteger(relatedId) ? String(relatedId) : null;
  return id !== null && id.length > 0 && id.length <= 512 ? id : null;
}

/** Live worker `messages.raw` (the sanitized operation) plus the envelope contact descriptor. */
export function bridgeLiveMessage(input: Readonly<{ raw: unknown; contact?: ContactDescriptor | null | undefined; names?: ReadonlyMap<string, string> }>,
  rules: readonly BridgeRule[] = CONTENT_BRIDGE_RULES): BridgeResult | null {
  const raw = isRecord(input.raw) ? input.raw : {};
  if (raw.contentState !== undefined) return null; // decrypt_failed / contact_rejected: nothing to project
  const message = isRecord(raw.message) ? raw.message : null;
  if (message === null && !input.contact) return null;
  const m = message ?? {};
  const rawType = m.contentType;
  const contentType = typeof rawType === 'number' && Number.isSafeInteger(rawType) ? rawType
    : typeof rawType === 'string' ? TYPE_NUMBER_BY_NAME[rawType] ?? (/^\d{1,4}$/.test(rawType) ? Number(rawType) : null) : null;
  const metadata = isRecord(m.contentMetadata) ? m.contentMetadata : {};
  const location = isRecord(m.location) && Object.keys(m.location).length > 0
    ? { title: boundedText(m.location.title, 1024), address: boundedText(m.location.address, 2048),
      latitude: finiteWithin(m.location.latitude, 90), longitude: finiteWithin(m.location.longitude, 180) } : null;
  const contact = input.contact ? { mid: input.contact.mid, displayName: input.contact.displayName } : null;
  return applyRules('live', { contentType: input.contact ? 13 : contentType, text: typeof m.text === 'string' ? m.text : null,
    metadata, location, contact, eventInfo: null, ...(input.names ? { names: input.names } : {}) }, relationReply(m.messageRelationType, m.relatedMessageId), rules);
}

/** Narrow, read-time subtype projection from an already stored raw message. No raw fields leave this module. */
export function postNotificationSubtypeFromRaw(rawValue: unknown): 'note' | 'album' | null {
  if (!isRecord(rawValue) || rawValue.sourceDeleted === true) return null;
  if (rawValue.contentState !== undefined) return null;
  // Native history stores a sanitized `message` projection beside the authoritative
  // plain native row. Once native is present, never fall back to projection fields.
  if (rawValue.native !== undefined) return postNotificationSubtypeFromNative(rawValue.native);
  const message = isRecord(rawValue.message) ? rawValue.message : null;
  if (message !== null) {
    const rawType = message.contentType;
    const contentType = typeof rawType === 'number' ? rawType : typeof rawType === 'string'
      ? TYPE_NUMBER_BY_NAME[rawType] ?? (/^\d{1,4}$/.test(rawType) ? Number(rawType) : null) : null;
    if (contentType !== 16) return null;
    const metadata = message.contentMetadata;
    if (!isRecord(metadata)) return null;
    return metadata.serviceType === 'GB' ? 'note' : metadata.serviceType === 'AB' ? 'album' : null;
  }
  return null;
}

function postNotificationSubtypeFromNative(native: unknown): 'note' | 'album' | null {
  // Read only the two native cells needed for classification. This deliberately does
  // not validate or convert the complete native envelope on the snapshot path.
  if (!isRecord(native) || native.format !== 2 || native.encoding !== 'plain' || native.table !== '_message' || !isRecord(native.row)
    || !Array.isArray(native.row.columns) || !Array.isArray(native.row.cells) || native.row.columns.length !== native.row.cells.length) return null;
  const columns = native.row.columns;
  const cells = native.row.cells;
  const typeIndex = columns.indexOf('_contentType');
  const metadataIndex = columns.indexOf('_contentMetadata');
  if (typeIndex < 0 || metadataIndex < 0 || typeIndex >= cells.length || metadataIndex >= cells.length) return null;
  const typeCell = cells[typeIndex];
  const typeText = typeof typeCell === 'number' ? String(typeCell) : isRecord(typeCell) && typeCell.sqliteType === 'integer' && typeof typeCell.value === 'string'
    ? typeCell.value : typeof typeCell === 'string' ? typeCell : null;
  if (typeText !== '16') return null;
  const metadataText = cellText(cellMap(native as unknown as Extract<NativeSourceEnvelope, { format: 2 }>), '_contentMetadata');
  if (metadataText === null) return null;
  if (Buffer.byteLength(metadataText, 'utf8') > MAX_METADATA_BYTES) return null;
  try {
    const metadata: unknown = JSON.parse(metadataText);
    if (!isRecord(metadata)) return null;
    return metadata.serviceType === 'GB' ? 'note' : metadata.serviceType === 'AB' ? 'album' : null;
  } catch { return null; }
}

type Cells = ReadonlyMap<string, unknown>;
function cellMap(envelope: Extract<NativeSourceEnvelope, { format: 2 }>): Cells {
  const map = new Map<string, unknown>();
  envelope.row.columns.forEach((column, index) => map.set(column, envelope.row.cells[index]));
  return map;
}
function cellText(cells: Cells, name: string, maxBytes = MAX_METADATA_BYTES): string | null {
  const cell = cells.get(name);
  if (typeof cell === 'string') return Buffer.byteLength(cell, 'utf8') <= maxBytes ? cell : null;
  if (isRecord(cell) && (cell.sqliteType === 'text' || cell.sqliteType === 'blob') && cell.encoding === 'base64' && typeof cell.data === 'string') {
    if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(cell.data)) return null;
    const padding = cell.data.endsWith('==') ? 2 : cell.data.endsWith('=') ? 1 : 0;
    const decodedBytes = cell.data.length / 4 * 3 - padding;
    if (decodedBytes > maxBytes) return null;
    try { const decoded = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.from(cell.data, 'base64')); return Buffer.byteLength(decoded, 'utf8') <= maxBytes ? decoded : null; } catch { return null; }
  }
  return null;
}
function cellInteger(cells: Cells, name: string): number | null {
  const cell = cells.get(name);
  if (typeof cell === 'number' && Number.isSafeInteger(cell)) return cell;
  if (isRecord(cell) && cell.sqliteType === 'integer' && typeof cell.value === 'string' && /^-?\d{1,18}$/.test(cell.value)) {
    const value = Number(cell.value);
    return Number.isSafeInteger(value) ? value : null;
  }
  return null;
}

/** Bounded `_contentMetadata` text of a plain native `_message` envelope; null for dpapi, other tables or an absent/oversized cell. */
export function nativeContentMetadataText(envelope: unknown): string | null {
  try {
    if (!isRecord(envelope) || envelope.format !== 2 || envelope.encoding !== 'plain' || envelope.table !== '_message') return null;
    const row = envelope.row;
    if (!isRecord(row) || !Array.isArray(row.columns) || !Array.isArray(row.cells) || row.columns.length !== row.cells.length) return null;
    return cellText(cellMap(envelope as Extract<NativeSourceEnvelope, { format: 2 }>), '_contentMetadata');
  } catch { return null; }
}

/** Bounded `_text` of a plain native `_message` envelope (display of a recalled text original); null otherwise. */
export function nativeMessageText(envelope: unknown): string | null {
  try {
    if (!isRecord(envelope) || envelope.format !== 2 || envelope.encoding !== 'plain' || envelope.table !== '_message') return null;
    const row = envelope.row;
    if (!isRecord(row) || !Array.isArray(row.columns) || !Array.isArray(row.cells) || row.columns.length !== row.cells.length) return null;
    return boundedText(cellText(cellMap(envelope as Extract<NativeSourceEnvelope, { format: 2 }>), '_text', MAX_TEXT_CHARS * 4), MAX_TEXT_CHARS);
  } catch { return null; }
}

/** Extract sticon ranges from only the native _message fields used by the shared contracts parser. */
export function sticonRangesFromNativeEnvelope(envelope: NativeSourceEnvelope | null | undefined): SticonRange[] {
  try {
    if (!envelope || envelope.format !== 2 || envelope.encoding !== 'plain' || envelope.table !== '_message') return [];
    const cells = cellMap(envelope);
    const text = cellText(cells, '_text', MAX_TEXT_CHARS);
    const metadataText = cellText(cells, '_contentMetadata');
    if (text === null || metadataText === null) return [];
    const metadata: unknown = JSON.parse(metadataText);
    return parseSticonRanges(text, metadata);
  } catch { return []; }
}

/** Original native source text for remapping raw metadata offsets onto stored display text. */
export function sticonSourceTextFromNativeEnvelope(envelope: NativeSourceEnvelope | null | undefined): string | null {
  try {
    if (!envelope || envelope.format !== 2 || envelope.encoding !== 'plain' || envelope.table !== '_message') return null;
    return cellText(cellMap(envelope), '_text', MAX_TEXT_CHARS);
  } catch { return null; }
}

/** Sticon ranges projected onto text_content, using the same replacement and overlap rules as mentions. */
export function remapSticonRangesForDisplay(text: string, ranges: readonly SticonRange[]): SticonRange[] {
  const remapped = redactSensitiveText(text, ranges.map((range, index) => ({ start: range.start, end: range.end, userId: String(index) })));
  return remapped.mentionRanges.flatMap(({ start, end, userId }) => {
    const resource = ranges[Number(userId)];
    return resource ? [{ ...resource, start, end }] : [];
  });
}

/** Extract the same parser result from the live worker's sanitized raw message envelope. */
export function sticonRangesFromLiveRaw(rawValue: unknown): SticonRange[] {
  try {
    if (!isRecord(rawValue) || !isRecord(rawValue.message)) return [];
    const message = rawValue.message;
    const text = typeof message.text === 'string' ? message.text : null;
    if (text === null || text.length > MAX_TEXT_CHARS) return [];
    const metadata = message.contentMetadata;
    if (metadata !== undefined && Buffer.byteLength(JSON.stringify(metadata), 'utf8') > MAX_METADATA_BYTES) return [];
    return parseSticonRanges(text, metadata);
  } catch { return []; }
}

/** Original live source text for remapping raw metadata offsets onto stored display text. */
export function sticonSourceTextFromLiveRaw(rawValue: unknown): string | null {
  if (!isRecord(rawValue) || !isRecord(rawValue.message)) return null;
  const text = rawValue.message.text;
  return typeof text === 'string' && text.length <= MAX_TEXT_CHARS ? text : null;
}

function hasLocationCell(cell: unknown): boolean {
  if (typeof cell === 'string') return cell.trim().length > 0;
  if (isRecord(cell) && (cell.sqliteType === 'text' || cell.sqliteType === 'blob')) return typeof cell.data === 'string' && cell.data.length > 0;
  return false;
}

/** Plain native envelope (`format 2`); `dpapi` envelopes and other tables are skipped (null). */
export function bridgeNativeEnvelope(envelope: NativeSourceEnvelope | null | undefined,
  rules: readonly BridgeRule[] = CONTENT_BRIDGE_RULES, names?: ReadonlyMap<string, string>): BridgeResult | null {
  if (!envelope || envelope.format !== 2 || envelope.encoding !== 'plain' || envelope.table !== '_message') return null;
  const cells = cellMap(envelope);
  const metadataText = cellText(cells, '_contentMetadata');
  let metadata: Record<string, unknown> = {};
  if (metadataText !== null && Buffer.byteLength(metadataText, 'utf8') <= MAX_METADATA_BYTES) {
    try { const parsed: unknown = JSON.parse(metadataText); if (isRecord(parsed)) metadata = parsed; } catch { /* malformed optional metadata */ }
  }
  const contentType = cellInteger(cells, '_contentType');
  const text = cellText(cells, '_text');
  const type = contentType !== null && contentType >= 0 ? contentType : null;
  // Native keeps no decoded location struct: a non-empty `_location` blob only marks presence, `_text` is the title fallback.
  // Text rows carry `_location` as "" (or NULL); an empty/blank cell is "no location".
  const location = type === 15 || (type === 0 && hasLocationCell(cells.get('_location')))
    ? { title: boundedText(text, 1024), address: null, latitude: null, longitude: null } : null;
  const eventText = type === 0 ? cellText(cells, '_eventInfo') : null;
  let eventInfo: Record<string, unknown> | null = null;
  if (eventText !== null && eventText.length > 0) {
    try { const parsed: unknown = JSON.parse(eventText); if (isRecord(parsed)) eventInfo = parsed; } catch { /* malformed optional eventInfo */ }
  }
  const contact = type === 13 ? { mid: boundedText(metadata.mid, 512), displayName: boundedText(metadata.displayName, 128) } : null;
  return applyRules('native', { contentType: type, text, metadata, location, contact, eventInfo, ...(names ? { names } : {}) },
    relationReply(cellInteger(cells, '_messageRelationType'), cellText(cells, '_relatedMessageId')), rules);
}

/** True only when a plain native `_message` envelope's `_contentMetadata` says `UNSENT`; dpapi/other shapes are not decidable (false). */
export function isRecalledNativeEnvelope(envelope: unknown): boolean {
  const text = nativeContentMetadataText(envelope);
  if (text === null || Buffer.byteLength(text, 'utf8') > MAX_METADATA_BYTES) return false;
  try {
    const parsed: unknown = JSON.parse(text);
    return isRecord(parsed) && (parsed.UNSENT === true || parsed.UNSENT === 'true');
  } catch { return false; }
}
