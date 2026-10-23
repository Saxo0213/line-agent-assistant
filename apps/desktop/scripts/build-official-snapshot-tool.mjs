import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { copyFile, mkdir, readFile, realpath } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

if (process.platform !== 'win32' || process.arch !== 'x64') throw new Error('Official snapshot tool requires Windows x64.');
const desktopRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const repositoryRoot = path.resolve(desktopRoot, '../..');
const systemRoot = await realpath(process.env.SystemRoot ?? 'C:\\Windows');
const frameworkRoot = path.join(systemRoot, 'Microsoft.NET', 'Framework64', 'v4.0.30319');
const compiler = await realpath(path.join(frameworkRoot, 'csc.exe'));
if ((await readFile(compiler)).subarray(0, 2).toString() !== 'MZ') throw new Error('Trusted .NET Framework x64 compiler required.');
let sqliteSource;
for (const root of [path.join(repositoryRoot, '.references'), path.resolve(repositoryRoot, '..', '..', '.references')]) {
  const candidate = path.join(root, 'runtime-cache', 'sqlite3mc-2.5.1', 'dll', 'sqlite3mc_x64.dll');
  if (await readFile(candidate).then(() => true, () => false)) { sqliteSource = candidate; break; }
}
if (!sqliteSource) throw new Error('Pinned SQLite3MC resource unavailable.');
const bytes = await readFile(sqliteSource);
if (bytes.byteLength !== 2_442_576 || createHash('sha256').update(bytes).digest('hex') !== '5030decc6d914539e3b9b7e28aa4f6de1e7161dac6fd4b21eb02e6754d9b175e') throw new Error('Pinned SQLite3MC integrity failure.');
const outputRoot = path.join(desktopRoot, 'dist', 'official-snapshot-tool');
await mkdir(outputRoot, { recursive: true });
const output = path.join(outputRoot, 'OfficialSnapshotTool.exe');
execFileSync(compiler, ['/nologo', '/target:exe', '/platform:x64', '/optimize+', `/out:${output}`,
  `/reference:${path.join(frameworkRoot, 'System.Web.Extensions.dll')}`,
  ...['OfficialSnapshotTool.cs','OfficialSnapshotAnalyzer.cs','OfficialSnapshotCorrelator.cs','OfficialSnapshotDecode.cs','Sqlite3Mc.cs','Sqlite3McAnalysis.cs','NativeSourceArchive.cs','LineEncryptedSnapshot.cs','LineEncryptedPageValidator.cs','OfficialSourceInventory.cs','OfficialSourceKeyProbe.cs'].map((file) => path.join(desktopRoot, 'native', file))],
{ shell: false, windowsHide: true, stdio: 'inherit', env: { SystemRoot: systemRoot, TEMP: process.env.TEMP, TMP: process.env.TMP } });
await copyFile(sqliteSource, path.join(outputRoot, 'sqlite3mc_x64.dll'));
process.stdout.write(`${output}\n`);
