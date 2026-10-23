import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { copyFile, lstat, mkdir, mkdtemp, open, readFile, readdir, rename, rm, stat, symlink, unlink } from "node:fs/promises";
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { WindowsAttachmentBroker } from "./windows-attachment-broker.js";

const packageRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const helper = join(packageRoot, "dist", "native", "AttachmentBroker.exe");
const malformed = join(packageRoot, "dist", "test-fixtures", "MalformedAttachmentBroker.exe");
const crashing = join(packageRoot, "dist", "test-fixtures", "CrashingAttachmentBroker.exe");
const roots: string[] = [];

async function temp(prefix = "line-broker-"): Promise<string> { const value = await mkdtemp(join(tmpdir(), prefix)); roots.push(value); return value; }
function bytes(value: string, pause?: Promise<void>): AsyncIterable<Uint8Array> { return (async function* () { yield Buffer.from(value); if (pause) await pause; })(); }
function request(root: string, source: AsyncIterable<Uint8Array>, overrides: Record<string, unknown> = {}) {
  return {
    root,
    directorySegments: ["accounts", "id-61", "group", "id-62", "2026", "10", "id-63"],
    targetFileName: "att-" + "a".repeat(64) + ".blob",
    source,
    maxBytes: 1024,
    timeoutMs: 5_000,
    requiredGuarantees: { rootHandleAnchored: true, rejectsReparsePoints: true, publishNoReplace: true },
    ...overrides,
  } as Parameters<WindowsAttachmentBroker["storeAnchored"]>[0];
}
async function waitFor<T>(probe: () => Promise<T | undefined>, timeoutMs = 5_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) { const value = await probe(); if (value !== undefined) return value; await new Promise((resolveWait) => setTimeout(resolveWait, 5)); }
  throw new Error("probe timed out");
}
function frame(value: Uint8Array): Buffer { const length = Buffer.alloc(4); length.writeUInt32LE(value.byteLength); return Buffer.concat([length, value]); }

beforeAll(() => {
  if (process.platform !== "win32") return;
  const built = spawnSync(process.execPath, [join(packageRoot, "scripts", "build-attachment-broker.mjs")], { stdio: "inherit", shell: false });
  if (built.status !== 0) throw new Error("native broker build failed");
});
afterEach(async () => { await Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true }))); });

describe.runIf(process.platform === "win32")("WindowsAttachmentBroker native probes", () => {
  it("streams, flushes, publishes no-replace and recognizes an exact replay", async () => {
    const root = await temp(); const broker = new WindowsAttachmentBroker({ helperPath: helper });
    const first = await broker.storeAnchored(request(root, bytes("hello world")));
    const replay = await broker.storeAnchored(request(root, bytes("hello world")));
    expect(first).toEqual({ sha256: "b94d27b9934d3e08a52e52d7da7dabfac484efe37a5380ee9088f7ace2efcde9", size: 11, idempotent: false });
    expect(replay).toEqual({ ...first, idempotent: true });
  });

  it("allows exactly one concurrent different-byte winner and never overwrites it", async () => {
    const root = await temp(); const broker = new WindowsAttachmentBroker({ helperPath: helper });
    let release!: () => void; const gate = new Promise<void>((resolveGate) => { release = resolveGate; });
    const slow = broker.storeAnchored(request(root, bytes("loser", gate)));
    await new Promise((resolveWait) => setTimeout(resolveWait, 40));
    const winner = await broker.storeAnchored(request(root, bytes("winner"))); release();
    await expect(slow).rejects.toMatchObject({ code: "CONTENT_CONFLICT" });
    expect(winner.idempotent).toBe(false);
    const final = join(root, ...request(root, bytes("")).directorySegments, request(root, bytes("")).targetFileName);
    expect(await readFile(final, "utf8")).toBe("winner");
  });

  it("creates the same first-time directory chain safely for concurrent targets", async () => {
    const root = await temp(); const broker = new WindowsAttachmentBroker({ helperPath: helper });
    const base = request(root, bytes("first"));
    const other = request(root, bytes("second"), { targetFileName: "att-" + "b".repeat(64) + ".blob" });
    const [first, second] = await Promise.all([broker.storeAnchored(base), broker.storeAnchored(other)]);
    expect([first.size, second.size].sort()).toEqual([5, 6]);
  });

  it("rejects an existing junction and writes zero bytes outside", async () => {
    const root = await temp(); const outside = await temp("line-broker-outside-");
    await symlink(outside, join(root, "accounts"), "junction");
    const broker = new WindowsAttachmentBroker({ helperPath: helper });
    await expect(broker.storeAnchored(request(root, bytes("escape")))).rejects.toMatchObject({ code: "SYMLINK_ESCAPE" });
    expect(await readdir(outside)).toEqual([]);
  });

  it("rejects a junction in the configured root ancestry before creating anything outside", async () => {
    const parent = await temp(); const outside = await temp("line-broker-outside-"); const ancestor = join(parent, "ancestor");
    await symlink(outside, ancestor, "junction");
    const broker = new WindowsAttachmentBroker({ helperPath: helper });
    await expect(broker.storeAnchored(request(join(ancestor, "managed-root"), bytes("escape")))).rejects.toMatchObject({ code: "SYMLINK_ESCAPE" });
    expect(await readdir(outside)).toEqual([]);
  });

  it("stays anchored while a parent is replaced with a junction", async () => {
    const root = await temp(); const outside = await temp("line-broker-outside-"); const accounts = join(root, "accounts"); const moved = join(root, "accounts-safe");
    await mkdir(accounts); let stop = false; let installed = 0; const unexpected: unknown[] = [];
    const raceCodes: Record<"move" | "install" | "remove" | "restore", ReadonlySet<string>> = {
      move: new Set(["ENOENT", "EEXIST", "EPERM", "EBUSY", "ENOTEMPTY"]),
      install: new Set(["EEXIST", "EPERM", "EBUSY"]),
      remove: new Set(["ENOENT", "EPERM", "EBUSY", "EISDIR"]),
      restore: new Set(["ENOENT", "EEXIST", "EPERM", "EBUSY", "ENOTEMPTY"]),
    };
    const recordFailure = (operation: keyof typeof raceCodes, error: unknown) => {
      if (!raceCodes[operation].has((error as NodeJS.ErrnoException).code ?? "")) unexpected.push({ operation, error });
    };
    const attacker = (async () => { while (!stop) {
      let operation: keyof typeof raceCodes = "move";
      try {
        await rename(accounts, moved);
        operation = "install"; await symlink(outside, accounts, "junction"); installed += 1;
        await new Promise((resolveWait) => setTimeout(resolveWait, 1));
        operation = "remove"; await unlink(accounts);
        operation = "restore"; await rename(moved, accounts);
      } catch (error) {
        recordFailure(operation, error);
        await unlink(accounts).catch((cleanup: unknown) => recordFailure("remove", cleanup));
        await rename(moved, accounts).catch((cleanup: unknown) => recordFailure("restore", cleanup));
        await new Promise((resolveWait) => setTimeout(resolveWait, 1));
      }
    } })();
    const broker = new WindowsAttachmentBroker({ helperPath: helper });
    const outcome = await broker.storeAnchored(request(root, bytes("anchored"), { directorySegments: ["accounts", ...Array.from({ length: 80 }, (_, index) => `d${index}`)] })).then(() => "stored", (error: unknown) => {
      const code = (error as { code?: string }).code;
      expect(["SYMLINK_ESCAPE", "NATIVE_BROKER_REQUIRED"]).toContain(code);
      if (code === "NATIVE_BROKER_REQUIRED") {
        expect((error as Error).message).toMatch(/^Windows attachment broker failed \(WIN32_(ROOT|DIRECTORY)_\d+\)$/);
      }
      return "rejected";
    }).finally(async () => { stop = true; await attacker; });
    const accountEntry = await lstat(accounts).catch((error: NodeJS.ErrnoException) => error.code === "ENOENT" ? undefined : Promise.reject(error));
    const movedEntry = await lstat(moved).catch((error: NodeJS.ErrnoException) => error.code === "ENOENT" ? undefined : Promise.reject(error));
    if (accountEntry?.isSymbolicLink()) await unlink(accounts);
    if ((!accountEntry || accountEntry.isSymbolicLink()) && movedEntry) await rename(moved, accounts);
    const restoredAccount = await lstat(accounts).catch((error: NodeJS.ErrnoException) => error.code === "ENOENT" ? undefined : Promise.reject(error));
    const safeMovedDirectory = await lstat(moved).catch((error: NodeJS.ErrnoException) => error.code === "ENOENT" ? undefined : Promise.reject(error));
    expect(["stored", "rejected"]).toContain(outcome); expect(installed).toBeGreaterThan(0); expect(unexpected).toEqual([]);
    expect((restoredAccount?.isDirectory() && !restoredAccount.isSymbolicLink()) || (safeMovedDirectory?.isDirectory() && !safeMovedDirectory.isSymbolicLink())).toBe(true);
    expect(await readdir(outside)).toEqual([]);
  });

  it("does not permit an external writer to mutate staging during hash and publication", async () => {
    const root = await temp(); const broker = new WindowsAttachmentBroker({ helperPath: helper }); const content = Buffer.alloc(64 * 1024 * 1024, 0x61);
    let release!: () => void; const gate = new Promise<void>((resolveGate) => { release = resolveGate; });
    let yielded!: () => void; const sourceYielded = new Promise<void>((resolveYielded) => { yielded = resolveYielded; });
    const source = (async function* () { yield content; yielded(); await gate; })();
    const pending = broker.storeAnchored(request(root, source, { maxBytes: content.byteLength + 1, timeoutMs: 15_000 })); await sourceYielded;
    const directory = join(root, ...request(root, bytes("")).directorySegments);
    const staging = await waitFor(async () => {
      const names = await readdir(directory).catch(() => []); const name = names.find((candidate) => candidate.endsWith(".part"));
      if (!name) return undefined; const info = await stat(join(directory, name)); return info.size === content.byteLength ? join(directory, name) : undefined;
    });
    let externalWriteSucceeded = false;
    try { const writer = await open(staging, "r+"); try { await writer.write(Buffer.from("MUTATION"), 0, 8, 0); externalWriteSucceeded = true; } finally { await writer.close(); } } catch (error) {
      expect(["EBUSY", "EPERM", "EACCES"]).toContain((error as NodeJS.ErrnoException).code);
    }
    release(); const result = await pending;
    expect(externalWriteSucceeded).toBe(false);
    expect(result.sha256).toBe(createHash("sha256").update(content).digest("hex"));
    const final = join(directory, request(root, bytes("")).targetFileName); expect(createHash("sha256").update(await readFile(final)).digest("hex")).toBe(result.sha256);
  }, 20_000);

  it("fails closed while an existing target has an external writable handle", async () => {
    const root = await temp(); const broker = new WindowsAttachmentBroker({ helperPath: helper }); const value = request(root, bytes("stable"));
    await broker.storeAnchored(value); const final = join(root, ...value.directorySegments, value.targetFileName);
    const writer = await open(final, "r+");
    try { await expect(broker.storeAnchored(request(root, bytes("stable")))).rejects.toMatchObject({ code: "NATIVE_BROKER_REQUIRED" }); }
    finally { await writer.close(); }
    expect(await readFile(final, "utf8")).toBe("stable");
  });

  it("cleans staging on oversize and abort", async () => {
    const root = await temp(); const broker = new WindowsAttachmentBroker({ helperPath: helper });
    await expect(broker.storeAnchored(request(root, bytes("too large"), { maxBytes: 2 }))).rejects.toMatchObject({ code: "MAX_BYTES_EXCEEDED" });
    const controller = new AbortController(); let release!: () => void; const gate = new Promise<void>((resolveGate) => { release = resolveGate; });
    let began!: () => void; const sourceBegan = new Promise<void>((resolveBegan) => { began = resolveBegan; });
    const stalled = (async function* () { yield Buffer.from("partial"); began(); await gate; })();
    const pending = broker.storeAnchored(request(root, stalled, { signal: controller.signal }));
    await sourceBegan; await new Promise((resolveWait) => setTimeout(resolveWait, 30)); controller.abort();
    await expect(pending).rejects.toMatchObject({ code: "ABORTED" }); release();
    const directory = join(root, ...request(root, bytes("")).directorySegments);
    const files = await readdir(directory).catch((error: NodeJS.ErrnoException) => error.code === "ENOENT" ? [] : Promise.reject(error));
    expect(files.filter((name) => name.endsWith(".part"))).toEqual([]);
  });

  it("gracefully lets native cleanup finish for source throw, post-write oversize, and timeout", async () => {
    const root = await temp(); const broker = new WindowsAttachmentBroker({ helperPath: helper });
    const throwing = (async function* () { yield Buffer.from("partial"); throw new Error("source failed"); })();
    await expect(broker.storeAnchored(request(root, throwing))).rejects.toThrow("source failed");
    const oversize = (async function* () { yield Buffer.from("1234"); yield Buffer.from("5"); })();
    await expect(broker.storeAnchored(request(root, oversize, { maxBytes: 4 }))).rejects.toMatchObject({ code: "MAX_BYTES_EXCEEDED" });
    const stalled = (async function* () { yield Buffer.from("partial"); await new Promise<void>(() => undefined); })();
    await expect(broker.storeAnchored(request(root, stalled, { timeoutMs: 100 }))).rejects.toMatchObject({ code: "TIMEOUT" });
    const directory = join(root, ...request(root, bytes("")).directorySegments);
    expect((await readdir(directory)).filter((name) => name.endsWith(".part"))).toEqual([]);
  });

  it("uses native delete-on-close so a forced helper termination leaves no staging file", async () => {
    const root = await temp(); const value = request(root, bytes(""));
    const child = spawn(helper, ["--stdio-v1"], { shell: false, windowsHide: true, stdio: ["pipe", "pipe", "pipe"] }); child.stderr.resume(); child.stdout.resume();
    const header = Buffer.from(JSON.stringify({ protocol: "line-attachment-broker/v1", root, directorySegments: value.directorySegments, targetFileName: value.targetFileName, maxBytes: 1024 }), "utf8");
    child.stdin.write(frame(header)); child.stdin.write(frame(Buffer.from("partial")));
    const directory = join(root, ...value.directorySegments); await waitFor(async () => (await readdir(directory).catch(() => [])).some((name) => name.endsWith(".part")) ? true : undefined);
    child.kill(); await new Promise<void>((resolveClose) => child.once("close", () => resolveClose()));
    expect((await readdir(directory)).filter((name) => name.endsWith(".part"))).toEqual([]);
  });

  it("fails closed on malformed output, helper crash and missing helper", async () => {
    const root = await temp(); const fakeDir = await temp(); const fake = join(fakeDir, "AttachmentBroker.exe"); await copyFile(malformed, fake);
    await expect(new WindowsAttachmentBroker({ helperPath: fake }).storeAnchored(request(root, bytes("x")))).rejects.toMatchObject({ code: "NATIVE_BROKER_REQUIRED" });
    const crashDir = await temp(); const crash = join(crashDir, "AttachmentBroker.exe"); await copyFile(crashing, crash);
    await expect(new WindowsAttachmentBroker({ helperPath: crash }).storeAnchored(request(root, bytes("x")))).rejects.toMatchObject({ code: "NATIVE_BROKER_REQUIRED" });
    const missing = join(await temp(), "AttachmentBroker.exe");
    await expect(new WindowsAttachmentBroker({ helperPath: missing }).storeAnchored(request(root, bytes("x")))).rejects.toMatchObject({ code: "NATIVE_BROKER_REQUIRED" });
  });
});
