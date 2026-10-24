import { spawnSync } from "node:child_process";
import { mkdirSync, copyFileSync, existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..");
const source = resolve(root, "native", "AttachmentBroker.cs");
const output = resolve(root, "dist", "native", "AttachmentBroker.exe");
const framework = process.env.WINDIR ? resolve(process.env.WINDIR, "Microsoft.NET", "Framework64", "v4.0.30319", "csc.exe") : "";

if (process.platform !== "win32") process.exit(0);
if (!existsSync(framework)) throw new Error("The Windows .NET Framework x64 C# compiler is required");
mkdirSync(dirname(output), { recursive: true });
const result = spawnSync(framework, ["/nologo", "/target:exe", "/platform:x64", "/optimize+", `/out:${output}`, "/r:System.Runtime.Serialization.dll", source], {
  stdio: "inherit",
  shell: false,
});
if (result.error) throw result.error;
if (result.status !== 0) process.exit(result.status ?? 1);

// Also make the helper available beside compiled JS for test/dev layouts that
// emit src files under dist/src.
const adjacent = resolve(root, "dist", "src", "native", "AttachmentBroker.exe");
mkdirSync(dirname(adjacent), { recursive: true });
copyFileSync(output, adjacent);

const malformedSource = resolve(root, "src", "fixtures", "windows-attachment-broker", "MalformedAttachmentBroker.cs");
const malformedOutput = resolve(root, "dist", "test-fixtures", "MalformedAttachmentBroker.exe");
mkdirSync(dirname(malformedOutput), { recursive: true });
const fixture = spawnSync(framework, ["/nologo", "/target:exe", "/platform:x64", `/out:${malformedOutput}`, malformedSource], { stdio: "inherit", shell: false });
if (fixture.error) throw fixture.error;
if (fixture.status !== 0) process.exit(fixture.status ?? 1);

const crashingSource = resolve(root, "src", "fixtures", "windows-attachment-broker", "CrashingAttachmentBroker.cs");
const crashingOutput = resolve(root, "dist", "test-fixtures", "CrashingAttachmentBroker.exe");
const crashFixture = spawnSync(framework, ["/nologo", "/target:exe", "/platform:x64", `/out:${crashingOutput}`, crashingSource], { stdio: "inherit", shell: false });
if (crashFixture.error) throw crashFixture.error;
if (crashFixture.status !== 0) process.exit(crashFixture.status ?? 1);

const identitySource = resolve(root, "src", "fixtures", "chat-resource-archive", "IdentityProbe.cs");
const identityOutput = resolve(root, "dist", "test-fixtures", "ChatResourceIdentityProbe.exe");
mkdirSync(dirname(identityOutput), { recursive: true });
const identityFixture = spawnSync(framework, ["/nologo", "/target:exe", "/platform:x64", `/out:${identityOutput}`, identitySource], { stdio: "inherit", shell: false });
if (identityFixture.error) throw identityFixture.error;
if (identityFixture.status !== 0) process.exit(identityFixture.status ?? 1);
