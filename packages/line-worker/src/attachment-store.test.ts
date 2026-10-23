import { createHash } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { AttachmentResultSchema } from "@line-agent/contracts";
import { mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import {
  AttachmentStoreError,
  buildAttachmentLocation,
  decodeStableId,
  encodeStableId,
  sanitizeAttachmentFilename,
  storeAttachment,
  type AttachmentFilesystemSafetyBroker,
  type AttachmentIdentity,
} from "./attachment-store.js";

const portableTestRuntime = { unsafeAllowPortableFilesystemOnWindowsForTests: true } as const;

function store(input: Parameters<typeof storeAttachment>[0]) {
  return storeAttachment(input, portableTestRuntime);
}

const temporaryRoots: string[] = [];

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "line-agent-attachments-"));
  temporaryRoots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

const baseIdentity: AttachmentIdentity = {
  accountId: "account-A",
  chatType: "group",
  chatId: "chat-A",
  messageId: "message-A",
  externalAttachmentId: "attachment-A",
};

function chunks(...values: string[]): AsyncIterable<Uint8Array> {
  return (async function* () {
    for (const value of values) yield Buffer.from(value);
  })();
}

function byteChunks(...values: Uint8Array[]): AsyncIterable<Uint8Array> {
  return (async function* () { for (const value of values) yield value; })();
}

describe("stable attachment identity", () => {
  it("round-trips IDs while producing lowercase Windows-safe segments", () => {
    const id = "u-測試-safe-looking";
    const encoded = encodeStableId(id);

    expect(encoded).toMatch(/^id-[0-9a-f]+$/);
    expect(decodeStableId(encoded)).toBe(id);
    expect(encodeStableId("A").toLowerCase()).not.toBe(encodeStableId("a").toLowerCase());
  });

  it.each(["", ".", "..", "../chat", "a/b", "a\\b", "C:\\x", "\\\\server\\share", "\\\\?\\C:\\x", "name:stream", "nul\0x", "CON", "com1", "name.", "name "])(
    "rejects unsafe stable ID %j instead of normalizing its identity",
    (id) => expect(() => encodeStableId(id)).toThrow(AttachmentStoreError),
  );

  it.each(["\ud800", "\udfff", `ok${String.fromCharCode(0xd800)}bad`])("rejects non-well-formed Unicode ID %j", (id) => {
    expect(() => encodeStableId(id)).toThrow(AttachmentStoreError);
  });

  it.each(["//server/share", "//?/C:/device", "//./PIPE/name"])("rejects slash-normalized UNC/device root %j", (root) => {
    expect(() => buildAttachmentLocation({ root, identity: baseIdentity, occurredAt: "2026-10-15", originalFileName: "x.bin" })).toThrow(AttachmentStoreError);
  });

  it("isolates same-name chats and same external attachment IDs by stable account/chat identity", () => {
    const root = "C:\\managed";
    const first = buildAttachmentLocation({
      root,
      identity: baseIdentity,
      occurredAt: "2026-10-15T01:02:03.000Z",
      originalFileName: "same name.pdf",
    });
    const otherChat = buildAttachmentLocation({
      root,
      identity: { ...baseIdentity, chatId: "chat-B" },
      occurredAt: "2026-10-15T01:02:03.000Z",
      originalFileName: "same name.pdf",
    });
    const otherAccount = buildAttachmentLocation({
      root,
      identity: { ...baseIdentity, accountId: "account-B" },
      occurredAt: "2026-10-15T01:02:03.000Z",
      originalFileName: "same name.pdf",
    });

    expect(first.managedRelativePath).not.toBe(otherChat.managedRelativePath);
    expect(first.managedRelativePath).not.toBe(otherAccount.managedRelativePath);
    expect(first.managedRelativePath).toContain("/group/");
    expect(first.managedRelativePath).not.toContain("\\");
  });

  it("does not accept a display chat name, so renames cannot change the stable path", () => {
    const input = {
      root: "C:\\managed",
      identity: baseIdentity,
      occurredAt: "2026-10-15T01:02:03.000Z",
      originalFileName: "photo.JPG",
    } as const;

    expect(buildAttachmentLocation(input).managedRelativePath).toBe(buildAttachmentLocation(input).managedRelativePath);
  });

  it("uses the external ID hash directory and the safe display filename", () => {
    const common = { root: "C:\\managed", identity: { ...baseIdentity, externalAttachmentId: "x".repeat(100) }, occurredAt: "2026-10-15" } as const;
    const first = buildAttachmentLocation({ ...common, originalFileName: "photo.JPG" });
    const renamed = buildAttachmentLocation({ ...common, originalFileName: "totally-different.exe" });

    expect(first.managedRelativePath).toContain("/");
    expect(first.managedRelativePath.split("/").at(-2)).toBe(createHash("sha256").update(common.identity.externalAttachmentId).digest("hex"));
    expect(first.storedFileName).toBe("photo.JPG");
    expect(renamed.storedFileName).toBe("totally-different.exe");
    expect(first.directoryAbsolutePath).toBe(renamed.directoryAbsolutePath);
    expect(first.absolutePath).not.toBe(renamed.absolutePath);
  });

  it("separates duplicate filenames by message and external attachment ID", () => {
    const common = { root: "C:\\managed", occurredAt: "2026-10-15" } as const;
    const sameAttachmentName = buildAttachmentLocation({ ...common, identity: baseIdentity, originalFileName: "photo.jpg" });
    const otherMessage = buildAttachmentLocation({ ...common, identity: { ...baseIdentity, messageId: "message-B" }, originalFileName: "photo.jpg" });
    const otherAttachment = buildAttachmentLocation({ ...common, identity: { ...baseIdentity, externalAttachmentId: "attachment-B" }, originalFileName: "photo.jpg" });
    expect(new Set([sameAttachmentName.managedRelativePath, otherMessage.managedRelativePath, otherAttachment.managedRelativePath]).size).toBe(3);
  });

  it("emits a schema-valid POSIX managed path while retaining native absolute paths", () => {
    const location = buildAttachmentLocation({
      root: "C:\\managed",
      identity: baseIdentity,
      occurredAt: "2026-10-15T01:02:03.000Z",
      originalFileName: "display.pdf",
    });

    expect(location.managedRelativePath).toMatch(/^accounts\//);
    expect(location.managedRelativePath).not.toContain("\\");
    expect(isAbsolute(location.absolutePath)).toBe(true);
    expect(location.directoryAbsolutePath).toBe(dirname(location.absolutePath));
    expect(AttachmentResultSchema.safeParse({
      type: "attachmentResult",
      accountId: baseIdentity.accountId,
      chatType: baseIdentity.chatType,
      chatId: baseIdentity.chatId,
      attachmentId: "11111111-1111-4111-8111-111111111111",
      attemptToken: "b7c252f7-8b1e-4fac-a9cc-69bc206c09a1",
      workerInstanceId: "worker-1",
      status: "ready",
      relativePath: location.managedRelativePath,
      sha256: "00".repeat(32),
      sizeBytes: 0,
      name: location.sanitizedDisplayFileName,
    }).success).toBe(true);
  });

  it("sanitizes harmless invalid filename characters while preserving the extension", () => {
    expect(sanitizeAttachmentFilename("quarterly rep?rt.PDF")).toBe("quarterly rep_rt.PDF");
  });

  it.each(["../x.txt", "a/b.txt", "a\\b.txt", "C:\\x.txt", "\\\\server\\x", "file.txt:evil", "nul\0.txt", "CON", "LPT1.txt", ".", ".."])(
    "rejects dangerous display filename %j",
    (name) => expect(() => sanitizeAttachmentFilename(name)).toThrow(AttachmentStoreError),
  );
});

describe("storeAttachment", () => {
  it("stores exact named files beneath the per-attachment hash directory without changing bytes", async () => {
    const root = await temporaryRoot();
    const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xc0, 0x00, 0x11, 0x08, 0x00, 0x01, 0x00, 0x01, 0x03, 0x01, 0x11, 0x00, 0x02, 0x11, 0x00, 0x03, 0x11, 0x00]);
    const pdf = Buffer.from("%PDF-1.7\\nbytes");
    const common = {
      root,
      identity: baseIdentity,
      occurredAt: "2026-10-15T01:02:03.000Z",
      maxBytes: 100,
      timeoutMs: 2_000,
    } as const;
    const image = await store({ ...common, originalFileName: "photo.jpg", source: byteChunks(jpeg) });
    const document = await store({ ...common, identity: { ...baseIdentity, externalAttachmentId: "attachment-PDF" }, originalFileName: "rules.pdf", source: byteChunks(pdf) });
    const imageBytes = await readFile(image.absolutePath);
    const documentBytes = await readFile(document.absolutePath);

    expect(image.managedRelativePath).toBe(`accounts/${encodeStableId(baseIdentity.accountId)}/group/${encodeStableId(baseIdentity.chatId)}/2026/10/${encodeStableId(baseIdentity.messageId)}/${createHash("sha256").update(baseIdentity.externalAttachmentId).digest("hex")}/photo.jpg`);
    expect(document.managedRelativePath).toBe(`accounts/${encodeStableId(baseIdentity.accountId)}/group/${encodeStableId(baseIdentity.chatId)}/2026/10/${encodeStableId(baseIdentity.messageId)}/${createHash("sha256").update("attachment-PDF").digest("hex")}/rules.pdf`);
    expect(imageBytes).toEqual(jpeg);
    expect(documentBytes).toEqual(pdf);
    expect(image.sha256).toBe(createHash("sha256").update(jpeg).digest("hex"));
    expect(document.sha256).toBe(createHash("sha256").update(pdf).digest("hex"));
    expect((await readdir(image.directoryAbsolutePath)).sort()).toEqual(["photo.jpg"]);
  });

  it("enforces the real streamed byte count even when metadata would claim less", async () => {
    const root = await temporaryRoot();

    await expect(store({
      root,
      identity: baseIdentity,
      occurredAt: "2026-10-15T01:02:03.000Z",
      originalFileName: "large.bin",
      source: chunks("1234", "5678"),
      maxBytes: 7,
      timeoutMs: 2_000,
    })).rejects.toMatchObject({ code: "MAX_BYTES_EXCEEDED" });

    const files = await readdir(join(root, "accounts", encodeStableId(baseIdentity.accountId), "group", encodeStableId(baseIdentity.chatId), "2026", "10", encodeStableId(baseIdentity.messageId), createHash("sha256").update(baseIdentity.externalAttachmentId).digest("hex")));
    expect(files).toEqual([]);
  });

  it("aborts a stalled source and removes its .part file", async () => {
    const root = await temporaryRoot();
    const controller = new AbortController();
    const source = (async function* () {
      yield Buffer.from("started");
      await new Promise<void>(() => undefined);
    })();
    const storing = store({
      root,
      identity: baseIdentity,
      occurredAt: "2026-10-15T01:02:03.000Z",
      originalFileName: "stalled.bin",
      source,
      maxBytes: 100,
      timeoutMs: 10_000,
      signal: controller.signal,
    });
    setTimeout(() => controller.abort(), 20);

    await expect(storing).rejects.toMatchObject({ code: "ABORTED" });
    const directory = join(root, "accounts", encodeStableId(baseIdentity.accountId), "group", encodeStableId(baseIdentity.chatId), "2026", "10", encodeStableId(baseIdentity.messageId), createHash("sha256").update(baseIdentity.externalAttachmentId).digest("hex"));
    expect(await readdir(directory)).toEqual([]);
  });

  it("treats an exact replay as idempotent and rejects different content for the same stable target", async () => {
    const root = await temporaryRoot();
    const input = {
      root,
      identity: baseIdentity,
      occurredAt: "2026-10-15T01:02:03.000Z",
      originalFileName: "document.pdf",
      maxBytes: 100,
      timeoutMs: 2_000,
    } as const;
    const first = await store({ ...input, source: chunks("same") });
    const replay = await store({ ...input, source: chunks("same") });

    expect(replay.absolutePath).toBe(first.absolutePath);
    expect(replay.idempotent).toBe(true);
    await expect(store({ ...input, source: chunks("different") })).rejects.toMatchObject({ code: "CONTENT_CONFLICT" });
    expect(await readFile(first.absolutePath, "utf8")).toBe("same");
  });

  it("handles filename case collisions according to the host filesystem without replacing bytes", async () => {
    const root = await temporaryRoot();
    const input = { root, identity: baseIdentity, occurredAt: "2026-10-15", maxBytes: 100, timeoutMs: 2_000 } as const;
    const first = await store({ ...input, originalFileName: "photo.jpg", source: chunks("same") });
    const caseVariant = await store({ ...input, originalFileName: "PHOTO.JPG", source: chunks("same") });
    if (process.platform === "win32") {
      expect(caseVariant.idempotent).toBe(true);
      await expect(store({ ...input, originalFileName: "PHOTO.JPG", source: chunks("different") })).rejects.toMatchObject({ code: "CONTENT_CONFLICT" });
    } else {
      expect(caseVariant.absolutePath).not.toBe(first.absolutePath);
      expect(caseVariant.idempotent).toBe(false);
    }
    expect(await readFile(first.absolutePath, "utf8")).toBe("same");
  });

  it("rejects a symlink or junction that escapes the canonical managed root", async () => {
    const root = await temporaryRoot();
    const outside = await temporaryRoot();
    await mkdir(root, { recursive: true });
    await symlink(outside, join(root, "accounts"), process.platform === "win32" ? "junction" : "dir");

    await expect(store({
      root,
      identity: baseIdentity,
      occurredAt: "2026-10-15T01:02:03.000Z",
      originalFileName: "escape.bin",
      source: chunks("no escape"),
      maxBytes: 100,
      timeoutMs: 2_000,
    })).rejects.toMatchObject({ code: "SYMLINK_ESCAPE" });
    expect(await readdir(outside)).toEqual([]);
  });

  it("refuses an existing symbolic-link target rather than following it", async () => {
    const root = await temporaryRoot();
    const outside = await temporaryRoot();
    const location = buildAttachmentLocation({
      root,
      identity: baseIdentity,
      occurredAt: "2026-10-15T01:02:03.000Z",
      originalFileName: "linked.txt",
    });
    await mkdir(location.directoryAbsolutePath, { recursive: true });
    const outsideFile = join(outside, "outside.txt");
    await writeFile(outsideFile, "outside");
    await symlink(outsideFile, location.absolutePath, "file");

    await expect(store({
      root,
      identity: baseIdentity,
      occurredAt: "2026-10-15T01:02:03.000Z",
      originalFileName: "linked.txt",
      source: chunks("replacement"),
      maxBytes: 100,
      timeoutMs: 2_000,
    })).rejects.toMatchObject({ code: "SYMLINK_ESCAPE" });
    expect(await readFile(outsideFile, "utf8")).toBe("outside");
  });

  it("publishes no-replace when a concurrent writer wins after the first writer checked", async () => {
    const root = await temporaryRoot();
    let releaseFirst!: () => void;
    const wait = new Promise<void>((resolve) => { releaseFirst = resolve; });
    const slowFirst = (async function* () {
      yield Buffer.from("first");
      await wait;
    })();
    const input = {
      root,
      identity: baseIdentity,
      occurredAt: "2026-10-15T01:02:03.000Z",
      originalFileName: "ignored.txt",
      maxBytes: 100,
      timeoutMs: 2_000,
    } as const;
    const first = store({ ...input, source: slowFirst });
    await new Promise((resolve) => setTimeout(resolve, 25));
    const winner = await store({ ...input, source: chunks("winner") });
    releaseFirst();

    await expect(first).rejects.toMatchObject({ code: "CONTENT_CONFLICT" });
    expect(await readFile(winner.absolutePath, "utf8")).toBe("winner");
  });

  it("fails closed on Windows before writing when no handle-anchored native broker is supplied", async () => {
    const parent = await temporaryRoot();
    const root = join(parent, "must-not-be-created");
    await expect(storeAttachment({
      root,
      identity: baseIdentity,
      occurredAt: "2026-10-15",
      originalFileName: "x.bin",
      source: chunks("x"),
      maxBytes: 10,
      timeoutMs: 1_000,
    })).rejects.toMatchObject({ code: "NATIVE_BROKER_REQUIRED" });
    await expect(readdir(root)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("uses the actual Windows platform even if untyped runtime input tries to override it", async () => {
    if (process.platform !== "win32") return;
    const parent = await temporaryRoot();
    const root = join(parent, "platform-cannot-be-forged");
    await expect(storeAttachment({
      root,
      identity: baseIdentity,
      occurredAt: "2026-10-15",
      originalFileName: "x.bin",
      source: chunks("x"),
      maxBytes: 10,
      timeoutMs: 1_000,
    }, { platform: "linux" } as unknown as Parameters<typeof storeAttachment>[1])).rejects.toMatchObject({ code: "NATIVE_BROKER_REQUIRED" });
    await expect(readdir(root)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects the portable test escape hatch in a production environment", async () => {
    if (process.platform !== "win32") return;
    const parent = await temporaryRoot();
    const root = join(parent, "production-cannot-use-test-bypass");
    const previous = process.env.NODE_ENV;
    process.env.NODE_ENV = "production";
    try {
      await expect(storeAttachment({
        root,
        identity: baseIdentity,
        occurredAt: "2026-10-15",
        originalFileName: "x.bin",
        source: chunks("x"),
        maxBytes: 10,
        timeoutMs: 1_000,
      }, portableTestRuntime)).rejects.toMatchObject({ code: "NATIVE_BROKER_REQUIRED" });
      await expect(readdir(root)).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      if (previous === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = previous;
    }
  });

  it("passes only stable relative components to a broker declaring anchored open and no-replace publication", async () => {
    const parent = await temporaryRoot();
    const root = join(parent, "broker-root");
    let request: Parameters<AttachmentFilesystemSafetyBroker["storeAnchored"]>[0] | undefined;
    const broker: AttachmentFilesystemSafetyBroker = {
      guarantees: { rootHandleAnchored: true, rejectsReparsePoints: true, publishNoReplace: true },
      async storeAnchored(value) {
        request = value;
        return { sha256: "00".repeat(32), size: 0, idempotent: false };
      },
    };
    const result = await storeAttachment({
      root,
      identity: baseIdentity,
      occurredAt: "2026-10-15",
      originalFileName: "display.exe",
      source: chunks(),
      maxBytes: 10,
      timeoutMs: 1_000,
    }, { windowsSafetyBroker: broker });

    expect(request).toMatchObject({
      root,
      directorySegments: expect.arrayContaining(["accounts", "group", "2026", "10"]),
      targetFileName: "display.exe",
      requiredGuarantees: { rootHandleAnchored: true, rejectsReparsePoints: true, publishNoReplace: true },
    });
    expect(request?.directorySegments.at(-1)).toBe(createHash("sha256").update(baseIdentity.externalAttachmentId).digest("hex"));
    await expect(readdir(root)).rejects.toMatchObject({ code: "ENOENT" });
  });
});
