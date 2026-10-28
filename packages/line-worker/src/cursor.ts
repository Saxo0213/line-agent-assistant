import { Buffer } from "node:buffer";

const MAX_SIGNED_INT64 = "9223372036854775807";
const BASE64URL = /^[A-Za-z0-9_-]+$/;
const DECIMAL = /^(?:0|[1-9][0-9]*)$/;

export type TalkCursorV1 = Readonly<{
  version: 1;
  revision: string;
  globalRev: string;
  individualRev: string;
}>;

export type ChatType = "direct" | "group" | "room";

export type JsonValue =
  | null
  | boolean
  | number
  | string
  | readonly JsonValue[]
  | { readonly [key: string]: JsonValue };

export type HistoryCursorV1 = Readonly<{
  version: 1;
  accountId: string;
  chatType: ChatType;
  chatId: string;
  messageId: string;
  deliveredTime: string;
}>;

export type EnvelopeBatch<T extends JsonValue = JsonValue> = Readonly<{
  accountId: string;
  batchId: string;
  cursorBefore: TalkCursorV1;
  cursorAfter: TalkCursorV1;
  envelopes: readonly T[];
  readReceipts?: readonly ReadReceipt[];
}>;

export type ReadReceipt = Readonly<{
  chatId: string; readerMid: string; messageId: string; readAt: string;
}>;

export type EnvelopeBatchAck = Readonly<{
  accountId: string;
  batchId: string;
  cursorBefore: TalkCursorV1;
  cursorAfter: TalkCursorV1;
}>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function cloneJsonDto(value: unknown, ancestors = new WeakSet<object>()): JsonValue {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean"
  ) {
    return value;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new TypeError("JSON DTO numbers must be finite");
    }
    return value;
  }
  if (typeof value !== "object") {
    throw new TypeError("Envelope must contain JSON DTO values only");
  }
  if (ancestors.has(value)) {
    throw new TypeError("Envelope JSON DTO must not contain cycles");
  }
  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      if (
        Object.keys(value).length !== value.length ||
        !value.every((_entry, index) => Object.hasOwn(value, index))
      ) {
        throw new TypeError("Envelope JSON DTO arrays must be dense");
      }
      const result = value.map((entry) => cloneJsonDto(entry, ancestors));
      return Object.freeze(result);
    }

    const prototype = Object.getPrototypeOf(value) as unknown;
    if (prototype !== Object.prototype && prototype !== null) {
      throw new TypeError("Envelope must contain plain JSON DTO objects");
    }
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const result: Record<string, JsonValue> = Object.create(null) as Record<
      string,
      JsonValue
    >;
    for (const key of Reflect.ownKeys(descriptors)) {
      if (typeof key !== "string") {
        throw new TypeError("Envelope JSON DTO keys must be strings");
      }
      const descriptor = descriptors[key]!;
      if (!descriptor.enumerable || !("value" in descriptor)) {
        throw new TypeError("Envelope JSON DTO properties must be enumerable data");
      }
      result[key] = cloneJsonDto(descriptor.value, ancestors);
    }
    return Object.freeze(result);
  } finally {
    ancestors.delete(value);
  }
}

function assertExactKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
  description: string,
): void {
  const actual = Object.keys(value);
  if (
    actual.length !== expected.length ||
    expected.some((key) => !Object.hasOwn(value, key))
  ) {
    throw new TypeError(`${description} has missing or unknown fields`);
  }
}

function assertId(value: unknown, field: string): asserts value is string {
  if (typeof value !== "string" || value.length === 0) {
    throw new TypeError(`${field} must be a non-empty string`);
  }
}

function assertDecimalInt64(
  value: unknown,
  field: string,
): asserts value is string {
  if (typeof value !== "string" || !DECIMAL.test(value)) {
    throw new TypeError(`${field} must be a canonical decimal string`);
  }
  if (
    value.length > MAX_SIGNED_INT64.length ||
    (value.length === MAX_SIGNED_INT64.length && value > MAX_SIGNED_INT64)
  ) {
    throw new RangeError(`${field} exceeds signed 64-bit range`);
  }
}

function parseTalkCursor(value: unknown): TalkCursorV1 {
  if (!isRecord(value)) {
    throw new TypeError("Talk cursor must be an object");
  }
  assertExactKeys(
    value,
    ["version", "revision", "globalRev", "individualRev"],
    "Talk cursor",
  );
  if (value.version !== 1) {
    throw new TypeError("Unknown talk cursor version");
  }
  assertDecimalInt64(value.revision, "revision");
  assertDecimalInt64(value.globalRev, "globalRev");
  assertDecimalInt64(value.individualRev, "individualRev");
  return Object.freeze({
    version: 1,
    revision: value.revision,
    globalRev: value.globalRev,
    individualRev: value.individualRev,
  });
}

function canonicalTalkJson(cursor: TalkCursorV1): string {
  return JSON.stringify({
    version: 1,
    revision: cursor.revision,
    globalRev: cursor.globalRev,
    individualRev: cursor.individualRev,
  });
}

function parseHistoryCursor(value: unknown): HistoryCursorV1 {
  if (!isRecord(value)) {
    throw new TypeError("History cursor must be an object");
  }
  assertExactKeys(
    value,
    [
      "version",
      "accountId",
      "chatType",
      "chatId",
      "messageId",
      "deliveredTime",
    ],
    "History cursor",
  );
  if (value.version !== 1) {
    throw new TypeError("Unknown history cursor version");
  }
  assertId(value.accountId, "accountId");
  assertId(value.chatId, "chatId");
  if (
    value.chatType !== "direct" &&
    value.chatType !== "group" &&
    value.chatType !== "room"
  ) {
    throw new TypeError("chatType is invalid");
  }
  assertDecimalInt64(value.messageId, "messageId");
  assertDecimalInt64(value.deliveredTime, "deliveredTime");
  return Object.freeze({
    version: 1,
    accountId: value.accountId,
    chatType: value.chatType,
    chatId: value.chatId,
    messageId: value.messageId,
    deliveredTime: value.deliveredTime,
  });
}

function canonicalHistoryJson(cursor: HistoryCursorV1): string {
  return JSON.stringify({
    version: 1,
    accountId: cursor.accountId,
    chatType: cursor.chatType,
    chatId: cursor.chatId,
    messageId: cursor.messageId,
    deliveredTime: cursor.deliveredTime,
  });
}

function decodeCanonical<T>(
  encoded: string,
  parse: (value: unknown) => T,
  canonicalJson: (value: T) => string,
): T {
  if (!BASE64URL.test(encoded)) {
    throw new TypeError("Cursor must be unpadded base64url");
  }
  const bytes = Buffer.from(encoded, "base64url");
  if (bytes.toString("base64url") !== encoded) {
    throw new TypeError("Cursor has a non-canonical base64url encoding");
  }

  let raw: unknown;
  try {
    raw = JSON.parse(bytes.toString("utf8"));
  } catch {
    throw new TypeError("Cursor is not valid JSON");
  }
  const parsed = parse(raw);
  if (Buffer.from(canonicalJson(parsed)).toString("base64url") !== encoded) {
    throw new TypeError("Cursor JSON is not canonical");
  }
  return parsed;
}

export function encodeTalkCursor(cursor: TalkCursorV1): string {
  const parsed = parseTalkCursor(cursor);
  return Buffer.from(canonicalTalkJson(parsed)).toString("base64url");
}

export function decodeTalkCursor(encoded: string): TalkCursorV1 {
  return decodeCanonical(encoded, parseTalkCursor, canonicalTalkJson);
}

export function encodeHistoryCursor(cursor: HistoryCursorV1): string {
  const parsed = parseHistoryCursor(cursor);
  return Buffer.from(canonicalHistoryJson(parsed)).toString("base64url");
}

export function decodeHistoryCursor(encoded: string): HistoryCursorV1 {
  return decodeCanonical(encoded, parseHistoryCursor, canonicalHistoryJson);
}

function copyTalkCursor(cursor: TalkCursorV1): TalkCursorV1 {
  return parseTalkCursor(cursor);
}

export function cursorsEqual(left: TalkCursorV1, right: TalkCursorV1): boolean {
  return canonicalTalkJson(parseTalkCursor(left)) ===
    canonicalTalkJson(parseTalkCursor(right));
}

export function createEnvelopeBatch<T extends JsonValue>(input: {
  accountId: string;
  batchId: string;
  cursorBefore: TalkCursorV1;
  cursorAfter: TalkCursorV1;
  envelopes: readonly T[];
  readReceipts?: readonly ReadReceipt[];
}): EnvelopeBatch<T> {
  assertId(input.accountId, "accountId");
  assertId(input.batchId, "batchId");
  if (!Array.isArray(input.envelopes)) {
    throw new TypeError("envelopes must be an array");
  }
  return Object.freeze({
    accountId: input.accountId,
    batchId: input.batchId,
    cursorBefore: copyTalkCursor(input.cursorBefore),
    cursorAfter: copyTalkCursor(input.cursorAfter),
    envelopes: Object.freeze(
      input.envelopes.map((envelope) => cloneJsonDto(envelope) as T),
    ),
    ...(input.readReceipts === undefined ? {} : {
      readReceipts: Object.freeze(input.readReceipts.map((receipt) => Object.freeze({ ...receipt }))),
    }),
  });
}

function cloneEnvelopeBatch<T extends JsonValue>(
  batch: EnvelopeBatch<T>,
): EnvelopeBatch<T> {
  return createEnvelopeBatch({
    accountId: batch.accountId,
    batchId: batch.batchId,
    cursorBefore: batch.cursorBefore,
    cursorAfter: batch.cursorAfter,
    envelopes: batch.envelopes,
    ...(batch.readReceipts === undefined ? {} : { readReceipts: batch.readReceipts }),
  });
}

export function validateBatchAck<T extends JsonValue>(
  batch: EnvelopeBatch<T>,
  ack: EnvelopeBatchAck,
): void {
  if (!isRecord(ack)) {
    throw new TypeError("Batch acknowledgement must be an object");
  }
  assertExactKeys(
    ack,
    ["accountId", "batchId", "cursorBefore", "cursorAfter"],
    "Batch acknowledgement",
  );
  assertId(ack.accountId, "ack.accountId");
  assertId(ack.batchId, "ack.batchId");
  if (ack.accountId !== batch.accountId) {
    throw new Error("Batch acknowledgement account mismatch");
  }
  if (ack.batchId !== batch.batchId) {
    throw new Error("Batch acknowledgement batch ID mismatch");
  }
  if (!cursorsEqual(ack.cursorBefore, batch.cursorBefore)) {
    throw new Error("Batch acknowledgement cursorBefore mismatch");
  }
  if (!cursorsEqual(ack.cursorAfter, batch.cursorAfter)) {
    throw new Error("Batch acknowledgement cursorAfter mismatch");
  }
}

export class DurableCursorSession<T extends JsonValue = JsonValue> {
  readonly #accountId: string;
  #durableCursor: TalkCursorV1;
  #pendingBatch: EnvelopeBatch<T> | undefined;

  constructor(accountId: string, durableCursor: TalkCursorV1) {
    assertId(accountId, "accountId");
    this.#accountId = accountId;
    this.#durableCursor = copyTalkCursor(durableCursor);
  }

  get durableCursor(): TalkCursorV1 {
    return copyTalkCursor(this.#durableCursor);
  }

  get pendingBatch(): EnvelopeBatch<T> | undefined {
    return this.#pendingBatch === undefined
      ? undefined
      : cloneEnvelopeBatch(this.#pendingBatch);
  }

  stage(
    batchId: string,
    cursorAfter: TalkCursorV1,
    envelopes: readonly T[],
    readReceipts?: readonly ReadReceipt[],
  ): EnvelopeBatch<T> {
    if (this.#pendingBatch !== undefined) {
      throw new Error("Cannot stage a second batch before acknowledgement");
    }
    const batch = createEnvelopeBatch({
      accountId: this.#accountId,
      batchId,
      cursorBefore: this.#durableCursor,
      cursorAfter,
      envelopes,
      ...(readReceipts === undefined || readReceipts.length === 0 ? {} : { readReceipts }),
    });
    this.#pendingBatch = batch;
    return cloneEnvelopeBatch(batch);
  }

  acknowledge(ack: EnvelopeBatchAck): TalkCursorV1 {
    if (this.#pendingBatch === undefined) {
      throw new Error("No pending batch to acknowledge");
    }
    validateBatchAck(this.#pendingBatch, ack);
    this.#durableCursor = copyTalkCursor(this.#pendingBatch.cursorAfter);
    this.#pendingBatch = undefined;
    return this.durableCursor;
  }

  onAckTimeout(): EnvelopeBatch<T> {
    if (this.#pendingBatch === undefined) {
      throw new Error("No pending batch to replay");
    }
    return cloneEnvelopeBatch(this.#pendingBatch);
  }

  restartFromDurable(): DurableCursorSession<T> {
    return new DurableCursorSession<T>(this.#accountId, this.#durableCursor);
  }
}
