import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const packageRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const fixture = join(packageRoot, "dist", "test-fixtures", "ChatResourceIdentityProbe.exe");
const roots: string[] = [];

afterEach(async () => { await Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true }))); });

describe.runIf(process.platform === "win32")("chat resource native identity", () => {
  it("matches Node dev/ino to the native volume serial and file index", async () => {
    const directory = await mkdtemp(join(tmpdir(), "chat-resource-identity-")); roots.push(directory);
    const nodeIdentity = await stat(directory, { bigint: true });
    const result = spawnSync(fixture, [directory], { encoding: "utf8", windowsHide: true, shell: false });
    expect(result.status).toBe(0);
    const native = JSON.parse(result.stdout) as { volumeSerial: string; fileId: string };
    expect(BigInt(native.volumeSerial)).toBe(nodeIdentity.dev);
    expect(BigInt(`0x${native.fileId}`)).toBe(nodeIdentity.ino);
  });
});
