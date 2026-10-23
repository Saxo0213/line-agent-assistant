import { execFileSync, spawnSync } from 'node:child_process';
import { mkdir, realpath, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

if (process.platform !== 'win32' || process.arch !== 'x64') throw new Error('Native attachment fixtures require Windows x64.');
const tempRoot = await realpath(os.tmpdir());
const outputRoot = await realpath(path.resolve(process.argv[2] ?? ''));
const relative = path.relative(tempRoot, outputRoot);
if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('Fixture output must be under the system temp root.');
if (!(await stat(outputRoot)).isDirectory()) throw new Error('Fixture output is not a directory.');
await mkdir(outputRoot, { recursive: true });

const desktopRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const nativeRoot = path.join(desktopRoot, 'native');
const systemRoot = await realpath(process.env.SystemRoot ?? 'C:\\Windows');
const frameworkRoot = path.join(systemRoot, 'Microsoft.NET', 'Framework64', 'v4.0.30319');
const compiler = await realpath(path.join(frameworkRoot, 'csc.exe'));
const executable = path.join(outputRoot, 'NativeAttachmentAuxHarness.exe');
const sources = [
  path.join(nativeRoot, 'NativeSourceArchive.cs'),
  path.join(nativeRoot, 'ExternalReaderBridge.cs'),
  path.join(nativeRoot, 'OfficialLineMainWindowCloser.cs'),
  path.join(nativeRoot, 'Sqlite3Mc.cs'),
  path.join(nativeRoot, 'LineEncryptedPageValidator.cs'),
  path.join(nativeRoot, 'OfficialSourceInventory.cs'),
  path.join(nativeRoot, 'OfficialSourceHeaderProbe.cs'),
  path.join(nativeRoot, 'OfficialSourceKeyProbe.cs'),
  path.join(nativeRoot, 'LineEncryptedSnapshot.cs'),
  path.join(nativeRoot, 'NativeAttachmentOperations.cs'),
  path.join(nativeRoot, 'NativeAttachmentAuxHarness.cs'),
];
execFileSync(compiler, [
  '/nologo', '/target:exe', '/platform:x64', '/optimize+',
  '/define:READER_AUTH_PROBE_TEST,READER_ATTACHMENT_AUX_TEST,READER_OFFICIAL_SOURCE_TEST,SQLITE_FIXTURE_WRITER',
  '/main:NativeAttachmentAuxHarness',
  `/out:${executable}`,
  `/reference:${path.join(frameworkRoot, 'System.Web.Extensions.dll')}`,
  ...sources,
], { shell: false, windowsHide: true, stdio: 'inherit', env: { SystemRoot: systemRoot, TEMP: process.env.TEMP, TMP: process.env.TMP } });
const run = spawnSync(executable, [], {
  shell: false, windowsHide: true, encoding: 'utf8', env: { SystemRoot: systemRoot, TEMP: process.env.TEMP, TMP: process.env.TMP },
});
process.stdout.write(run.stdout ?? ''); process.stderr.write(run.stderr ?? '');
if (run.status !== 0) throw new Error(`Native attachment fixture failed with exit ${run.status}.`);
