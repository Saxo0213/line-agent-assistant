import { describe, expect, it } from "vitest";

import {
  DurableCursorSession,
  decodeHistoryCursor,
  decodeTalkCursor,
  encodeHistoryCursor,
  encodeTalkCursor,
  type EnvelopeBatchAck,
  type HistoryCursorV1,
  type TalkCursorV1,
} from "./cursor.js";

const before: TalkCursorV1 = {
  version: 1,
  revision: "9007199254740993",
  globalRev: "9223372036854775806",
  individualRev: "0",
};

const after: TalkCursorV1 = {
  version: 1,
  revision: "9007199254740994",
  globalRev: "9223372036854775807",
  individualRev: "1",
};

describe("TalkCursorV1", () => {
  it("uses deterministic canonical JSON encoded as unpadded base64url", () => {
    const encoded = encodeTalkCursor(before);
    const expectedJson =
      '{"version":1,"revision":"9007199254740993","globalRev":"9223372036854775806","individualRev":"0"}';

    expect(encoded).toBe(Buffer.from(expectedJson).toString("base64url"));
    expect(encoded).not.toMatch(/[+/=]/);
    expect(decodeTalkCursor(encoded)).toEqual(before);
  });

  it("rejects malformed, non-canonical, unknown-version, numeric, and overflowing cursors", () => {
    const values = [
      "not base64url!",
      Buffer.from("{not json}").toString("base64url"),
      Buffer.from(
        '{"version":2,"revision":"1","globalRev":"1","individualRev":"1"}',
      ).toString("base64url"),
      Buffer.from(
        '{"version":1,"revision":1,"globalRev":"1","individualRev":"1"}',
      ).toString("base64url"),
      Buffer.from(
        '{"version":1,"revision":"9223372036854775808","globalRev":"1","individualRev":"1"}',
      ).toString("base64url"),
      Buffer.from(
        '{"revision":"1","version":1,"globalRev":"1","individualRev":"1"}',
      ).toString("base64url"),
      Buffer.from(
        '{"version":1,"revision":"01","globalRev":"1","individualRev":"1"}',
      ).toString("base64url"),
    ];

    for (const value of values) {
      expect(() => decodeTalkCursor(value)).toThrow();
    }
  });
});

describe("durable envelope batch acknowledgement", () => {
  it("does not advance before an exact account/batch/before/after acknowledgement", () => {
    const session = new DurableCursorSession<string>("account-a", before);
    const batch = session.stage("batch-1", after, ["message-1"]);

    expect(session.durableCursor).toEqual(before);
    expect(session.pendingBatch).toEqual(batch);

    expect(() =>
      session.acknowledge({
        accountId: "account-b",
        batchId: batch.batchId,
        cursorBefore: batch.cursorBefore,
        cursorAfter: batch.cursorAfter,
      }),
    ).toThrow(/account/i);
    expect(() =>
      session.acknowledge({
        accountId: batch.accountId,
        batchId: "wrong-batch",
        cursorBefore: batch.cursorBefore,
        cursorAfter: batch.cursorAfter,
      }),
    ).toThrow(/batch/i);
    expect(() =>
      session.acknowledge({
        accountId: batch.accountId,
        batchId: batch.batchId,
        cursorBefore: after,
        cursorAfter: batch.cursorAfter,
      }),
    ).toThrow(/before/i);
    expect(() =>
      session.acknowledge({
        accountId: batch.accountId,
        batchId: batch.batchId,
        cursorBefore: batch.cursorBefore,
        cursorAfter: before,
      }),
    ).toThrow(/after/i);
    expect(session.durableCursor).toEqual(before);

    session.acknowledge({
      accountId: batch.accountId,
      batchId: batch.batchId,
      cursorBefore: batch.cursorBefore,
      cursorAfter: batch.cursorAfter,
    });
    expect(session.durableCursor).toEqual(after);
    expect(session.pendingBatch).toBeUndefined();
  });

  it("replays the identical pending batch after ack timeout", () => {
    const session = new DurableCursorSession<string>("account-a", before);
    const batch = session.stage("batch-1", after, ["message-1"]);

    expect(session.onAckTimeout()).toEqual(batch);
    expect(session.pendingBatch).toEqual(batch);
    expect(session.durableCursor).toEqual(before);
  });

  it("captures nested JSON DTO values instead of retaining caller references", () => {
    const envelope = {
      messageId: "message-1",
      raw: { metadata: { key: "original" }, values: [1, 2] },
    };
    const session = new DurableCursorSession<typeof envelope>("account-a", before);
    session.stage("batch-1", after, [envelope]);

    envelope.raw.metadata.key = "mutated";
    envelope.raw.values.push(3);

    expect(session.onAckTimeout().envelopes).toEqual([{
      messageId: "message-1",
      raw: { metadata: { key: "original" }, values: [1, 2] },
    }]);
  });

  it("does not expose internal nested references from pending getters", () => {
    const envelope = {
      messageId: "message-1",
      raw: { metadata: { key: "original" } },
    };
    const session = new DurableCursorSession<typeof envelope>("account-a", before);
    session.stage("batch-1", after, [envelope]);
    const exposed = session.pendingBatch!;

    expect(exposed).not.toBe(session.pendingBatch);
    expect(exposed.envelopes[0]).not.toBe(session.pendingBatch!.envelopes[0]);
    expect(Object.isFrozen(exposed.envelopes[0]!.raw.metadata)).toBe(true);
    expect(() => {
      exposed.envelopes[0]!.raw.metadata.key = "mutated";
    }).toThrow();
    expect(session.onAckTimeout().envelopes[0]!.raw.metadata.key).toBe("original");
  });

  it("fails closed when a pending envelope is not a JSON DTO", () => {
    const session = new DurableCursorSession("account-a", before);
    expect(() =>
      session.stage("batch-1", after, [{ value: 1n }] as never[])
    ).toThrow(/JSON/i);
    expect(session.pendingBatch).toBeUndefined();
  });

  it("restarts from the last durable cursor rather than an unacked cursor", () => {
    const session = new DurableCursorSession<string>("account-a", before);
    session.stage("batch-lost-with-process", after, ["message-1"]);

    const restarted = session.restartFromDurable();
    expect(restarted.durableCursor).toEqual(before);
    expect(restarted.pendingBatch).toBeUndefined();
    expect(restarted.stage("batch-replayed", after, ["message-1"]).cursorBefore)
      .toEqual(before);
  });

  it("requires an ack for a cursor-only checkpoint", () => {
    const session = new DurableCursorSession<never>("account-a", before);
    const checkpoint = session.stage("cursor-only", after, []);

    expect(checkpoint.envelopes).toEqual([]);
    expect(session.durableCursor).toEqual(before);
    session.acknowledge({
      accountId: checkpoint.accountId,
      batchId: checkpoint.batchId,
      cursorBefore: checkpoint.cursorBefore,
      cursorAfter: checkpoint.cursorAfter,
    });
    expect(session.durableCursor).toEqual(after);
  });

  it("rejects malformed ack cursor data without coercing numbers", () => {
    const session = new DurableCursorSession("account-a", before);
    const batch = session.stage("batch-1", after, []);
    const malformed = {
      accountId: batch.accountId,
      batchId: batch.batchId,
      cursorBefore: { ...batch.cursorBefore, revision: 1 },
      cursorAfter: batch.cursorAfter,
    } as unknown as EnvelopeBatchAck;

    expect(() => session.acknowledge(malformed)).toThrow();
    expect(session.durableCursor).toEqual(before);
  });
});

describe("HistoryCursorV1", () => {
  it("round-trips a full conversation key and 64-bit pagination fields", () => {
    const cursor: HistoryCursorV1 = {
      version: 1,
      accountId: "account-a",
      chatType: "group",
      chatId: "c-group-id",
      messageId: "9223372036854775807",
      deliveredTime: "9007199254740993",
    };

    const encoded = encodeHistoryCursor(cursor);
    expect(JSON.stringify(decodeHistoryCursor(encoded))).toBe(JSON.stringify(cursor));
    expect(encoded).not.toMatch(/[+/=]/);
  });

  it("rejects an incomplete conversation key or overflowing pagination value", () => {
    const invalidValues = [
      {
        version: 1,
        accountId: "",
        chatType: "group",
        chatId: "c-group-id",
        messageId: "1",
        deliveredTime: "1",
      },
      {
        version: 1,
        accountId: "account-a",
        chatType: "group",
        chatId: "c-group-id",
        messageId: "9223372036854775808",
        deliveredTime: "1",
      },
    ];

    for (const invalid of invalidValues) {
      const encoded = Buffer.from(JSON.stringify(invalid)).toString("base64url");
      expect(() => decodeHistoryCursor(encoded)).toThrow();
    }
  });
});
