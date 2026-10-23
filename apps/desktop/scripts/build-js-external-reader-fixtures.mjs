import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFile, mkdir, readFile, realpath, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

if (process.platform !== 'win32' || process.arch !== 'x64') throw new Error('Native reader fixtures require Windows x64.');
const tempRoot = await realpath(os.tmpdir());
const outputRoot = await realpath(path.resolve(process.argv[2] ?? ''));
const relative = path.relative(tempRoot, outputRoot);
if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('Fixture output must be a private directory under the system temp root.');

const desktopRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const repositoryRoot = path.resolve(desktopRoot, '../..');
const systemRoot = await realpath(process.env.SystemRoot ?? 'C:\\Windows');
const frameworkRoot = path.join(systemRoot, 'Microsoft.NET', 'Framework64', 'v4.0.30319');
const compiler = await realpath(path.join(frameworkRoot, 'csc.exe'));
if ((await readFile(compiler)).subarray(0, 2).toString() !== 'MZ') throw new Error('A trusted Windows .NET Framework x64 compiler is required.');

// Compiler diagnostics (including warnings) go to stderr only: this script's own
// stdout is the machine-readable fixture path that tests parse.
function compile(args) {
  try {
    execFileSync(compiler, args, { shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8',
      env: { SystemRoot: systemRoot, TEMP: process.env.TEMP, TMP: process.env.TMP } });
  } catch (error) {
    process.stderr.write(String(error.stdout ?? ''));
    process.stderr.write(String(error.stderr ?? ''));
    throw error;
  }
}

const referenceRoots = [path.join(repositoryRoot, '.references'), path.resolve(repositoryRoot, '..', '..', '.references')];
let sqliteSource;
for (const referenceRoot of referenceRoots) {
  const candidate = path.join(referenceRoot, 'runtime-cache', 'sqlite3mc-2.5.1', 'dll', 'sqlite3mc_x64.dll');
  if (await readFile(candidate).then(() => true, () => false)) { sqliteSource = candidate; break; }
}
if (!sqliteSource) throw new Error('Pinned SQLite3MC fixture resource is unavailable.');
const sqliteBytes = await readFile(sqliteSource);
if (sqliteBytes.byteLength !== 2_442_576 || createHash('sha256').update(sqliteBytes).digest('hex') !== '5030decc6d914539e3b9b7e28aa4f6de1e7161dac6fd4b21eb02e6754d9b175e') {
  throw new Error('Pinned SQLite3MC fixture resource integrity failure.');
}
const outputInfo = await stat(outputRoot);
if (!outputInfo.isDirectory()) throw new Error('Fixture output is not a directory.');
await mkdir(outputRoot, { recursive: true });
const fixtureOutput = path.join(outputRoot, 'SqliteFixtureHarness.exe');
compile([
  '/nologo', '/target:exe', '/platform:x64', '/optimize+', '/define:SQLITE_FIXTURE_WRITER',
  `/out:${path.join(outputRoot, 'SnapshotFixtureHarness.exe')}`,
  `/reference:${path.join(frameworkRoot, 'System.Web.Extensions.dll')}`,
  path.join(desktopRoot, 'native', 'LineEncryptedSnapshot.cs'),
  path.join(desktopRoot, 'native', 'LineEncryptedPageValidator.cs'),
  path.join(desktopRoot, 'native', 'Sqlite3Mc.cs'),
  path.join(desktopRoot, 'native', 'NativeSourceArchive.cs'),
  path.join(desktopRoot, 'native', 'SnapshotFixtureHarness.cs'),
]);
compile([
  '/nologo', '/target:exe', '/platform:x64', '/optimize+', '/define:SQLITE_FIXTURE_WRITER',
  `/out:${path.join(outputRoot, 'FixedBackupFixtureHarness.exe')}`,
  `/reference:${path.join(frameworkRoot, 'System.Web.Extensions.dll')}`,
  path.join(desktopRoot, 'native', 'LineEncryptedSnapshot.cs'),
  path.join(desktopRoot, 'native', 'LineEncryptedPageValidator.cs'),
  path.join(desktopRoot, 'native', 'Sqlite3Mc.cs'),
  path.join(desktopRoot, 'native', 'NativeSourceArchive.cs'),
  path.join(desktopRoot, 'native', 'FixedBackupFixtureHarness.cs'),
]);
compile([
  '/nologo', '/target:exe', '/platform:x64', '/optimize+',
  `/out:${path.join(outputRoot, 'OfficialSourceKeyProbeHarness.exe')}`,
  path.join(desktopRoot, 'native', 'OfficialSourceKeyProbeHarness.cs'),
  path.join(desktopRoot, 'native', 'OfficialSourceKeyProbe.cs'),
  path.join(desktopRoot, 'native', 'OfficialSourceInventory.cs'),
  path.join(desktopRoot, 'native', 'LineEncryptedPageValidator.cs'),
]);
compile([
  '/nologo', '/target:exe', '/platform:x64', '/optimize+', '/define:READER_WATCHDOG_TEST',
  `/out:${path.join(outputRoot, 'ExternalReaderBridgeWatchdogTest.exe')}`,
  `/reference:${path.join(frameworkRoot, 'System.Web.Extensions.dll')}`,
  path.join(desktopRoot, 'native', 'ExternalReaderBridge.cs'),
  path.join(desktopRoot, 'native', 'NativeAttachmentOperations.cs'),
  path.join(desktopRoot, 'native', 'OfficialSourceHeaderProbe.cs'),
  path.join(desktopRoot, 'native', 'OfficialLineMainWindowCloser.cs'),
  path.join(desktopRoot, 'native', 'Sqlite3Mc.cs'),
  path.join(desktopRoot, 'native', 'NativeSourceArchive.cs'),
  path.join(desktopRoot, 'native', 'OfficialSourceInventory.cs'),
  path.join(desktopRoot, 'native', 'OfficialSourceKeyProbe.cs'),
  path.join(desktopRoot, 'native', 'LineEncryptedSnapshot.cs'),
  path.join(desktopRoot, 'native', 'LineEncryptedPageValidator.cs'),
]);
compile([
  '/nologo', '/target:exe', '/platform:x64', '/optimize+', '/define:READER_PAGE_BUDGET_TEST',
  '/main:ExternalReaderBridgePageBudgetHarness',
  `/out:${path.join(outputRoot, 'ExternalReaderBridgePageBudgetHarness.exe')}`,
  `/reference:${path.join(frameworkRoot, 'System.Web.Extensions.dll')}`,
  path.join(desktopRoot, 'native', 'ExternalReaderBridge.cs'),
  path.join(desktopRoot, 'native', 'NativeAttachmentOperations.cs'),
  path.join(desktopRoot, 'native', 'OfficialSourceHeaderProbe.cs'),
  path.join(desktopRoot, 'native', 'OfficialLineMainWindowCloser.cs'),
  path.join(desktopRoot, 'native', 'Sqlite3Mc.cs'),
  path.join(desktopRoot, 'native', 'NativeSourceArchive.cs'),
  path.join(desktopRoot, 'native', 'OfficialSourceInventory.cs'),
  path.join(desktopRoot, 'native', 'OfficialSourceKeyProbe.cs'),
  path.join(desktopRoot, 'native', 'LineEncryptedSnapshot.cs'),
  path.join(desktopRoot, 'native', 'LineEncryptedPageValidator.cs'),
  path.join(desktopRoot, 'native', 'ExternalReaderBridgePageBudgetHarness.cs'),
]);
await copyFile(sqliteSource, path.join(outputRoot, 'sqlite3mc_x64.dll'));
const lineFixturePath = path.join(outputRoot, 'LINE', 'bin', 'current', 'LINE.exe');
await mkdir(path.dirname(lineFixturePath), { recursive: true });
compile([
  '/nologo', '/target:exe', '/platform:x64', '/optimize+',
  `/out:${lineFixturePath}`,
  path.join(desktopRoot, 'native', 'LineFixtureProcess.cs'),
]);
const lineBytes = await readFile(lineFixturePath);
const lineHash = createHash('sha256').update(lineBytes).digest('hex');
const buildContract = path.join(outputRoot, 'LineFixtureBuildContract.cs');
await writeFile(buildContract, `internal static class LineFixtureBuildContract { internal const int Bytes = ${lineBytes.byteLength}; internal const string Sha256 = "${lineHash}"; }\n`);
compile([
  '/nologo', '/target:exe', '/platform:x64', '/optimize+', '/define:SQLITE_FIXTURE_WRITER,READER_OFFICIAL_SOURCE_TEST',
  '/main:SqliteFixtureHarness',
  `/out:${fixtureOutput}`,
  `/reference:${path.join(frameworkRoot, 'System.Web.Extensions.dll')}`,
  path.join(desktopRoot, 'native', 'Sqlite3Mc.cs'),
  path.join(desktopRoot, 'native', 'NativeSourceArchive.cs'),
  path.join(desktopRoot, 'native', 'SqliteFixtureHarness.cs'),
  path.join(desktopRoot, 'native', 'ExternalReaderBridge.cs'),
  path.join(desktopRoot, 'native', 'NativeAttachmentOperations.cs'),
  path.join(desktopRoot, 'native', 'OfficialSourceHeaderProbe.cs'),
  path.join(desktopRoot, 'native', 'OfficialLineMainWindowCloser.cs'),
  path.join(desktopRoot, 'native', 'OfficialSourceInventory.cs'),
  path.join(desktopRoot, 'native', 'OfficialSourceKeyProbe.cs'),
  path.join(desktopRoot, 'native', 'LineEncryptedSnapshot.cs'),
  path.join(desktopRoot, 'native', 'LineEncryptedPageValidator.cs'),
  buildContract,
]);
compile([
  '/nologo', '/target:exe', '/platform:x64', '/optimize+', '/define:READER_OFFICIAL_SOURCE_TEST',
  '/main:OfficialSourceKeyProbeSyntheticHarness',
  `/out:${path.join(outputRoot, 'OfficialSourceKeyProbeSyntheticHarness.exe')}`,
  path.join(desktopRoot, 'native', 'OfficialSourceKeyProbeSyntheticHarness.cs'),
  path.join(desktopRoot, 'native', 'OfficialSourceKeyProbe.cs'),
  path.join(desktopRoot, 'native', 'OfficialSourceInventory.cs'),
  path.join(desktopRoot, 'native', 'OfficialSourceInventoryHarness.cs'),
  path.join(desktopRoot, 'native', 'LineEncryptedPageValidator.cs'),
  buildContract,
]);
compile([
  '/nologo', '/target:exe', '/platform:x64', '/optimize+', '/define:READER_FIXTURE_SOURCE_TEST,SQLITE_FIXTURE_WRITER',
  `/out:${path.join(outputRoot, 'ExternalReaderBridgeSourceTest.exe')}`,
  `/reference:${path.join(frameworkRoot, 'System.Web.Extensions.dll')}`,
  path.join(desktopRoot, 'native', 'ExternalReaderBridge.cs'),
  path.join(desktopRoot, 'native', 'NativeAttachmentOperations.cs'),
  path.join(desktopRoot, 'native', 'OfficialSourceHeaderProbe.cs'),
  path.join(desktopRoot, 'native', 'OfficialLineMainWindowCloser.cs'),
  path.join(desktopRoot, 'native', 'Sqlite3Mc.cs'),
  path.join(desktopRoot, 'native', 'NativeSourceArchive.cs'),
  path.join(desktopRoot, 'native', 'LineEncryptedPageValidator.cs'),
  path.join(desktopRoot, 'native', 'OfficialSourceInventory.cs'),
  path.join(desktopRoot, 'native', 'OfficialSourceKeyProbe.cs'),
  path.join(desktopRoot, 'native', 'LineEncryptedSnapshot.cs'),
  buildContract,
]);
compile([
  '/nologo', '/target:exe', '/platform:x64', '/optimize+',
  `/out:${path.join(outputRoot, 'OfficialSourceInventoryHarness.exe')}`,
  path.join(desktopRoot, 'native', 'OfficialSourceInventory.cs'),
  path.join(desktopRoot, 'native', 'OfficialSourceInventoryHarness.cs'),
  buildContract,
]);
compile([
  '/nologo', '/target:exe', '/platform:x64', '/optimize+', '/define:READER_OFFICIAL_SOURCE_TEST,SQLITE_FIXTURE_WRITER',
  '/main:OfficialSourceInventoryBridgeHarness',
  `/out:${path.join(outputRoot, 'OfficialSourceInventoryBridgeHarness.exe')}`,
  `/reference:${path.join(frameworkRoot, 'System.Web.Extensions.dll')}`,
  path.join(desktopRoot, 'native', 'ExternalReaderBridge.cs'),
  path.join(desktopRoot, 'native', 'NativeAttachmentOperations.cs'),
  path.join(desktopRoot, 'native', 'OfficialSourceHeaderProbe.cs'),
  path.join(desktopRoot, 'native', 'OfficialLineMainWindowCloser.cs'),
  path.join(desktopRoot, 'native', 'OfficialSourceInventory.cs'),
  path.join(desktopRoot, 'native', 'OfficialSourceInventoryHarness.cs'),
  path.join(desktopRoot, 'native', 'OfficialSourceInventoryBridgeHarness.cs'),
  path.join(desktopRoot, 'native', 'Sqlite3Mc.cs'),
  path.join(desktopRoot, 'native', 'NativeSourceArchive.cs'),
  path.join(desktopRoot, 'native', 'OfficialSourceKeyProbe.cs'),
  path.join(desktopRoot, 'native', 'LineEncryptedSnapshot.cs'),
  path.join(desktopRoot, 'native', 'LineEncryptedPageValidator.cs'),
  buildContract,
]);
compile([
  '/nologo', '/target:exe', '/platform:x64', '/optimize+', '/define:SQLITE_FIXTURE_WRITER',
  '/main:OfficialSnapshotToolHarness',
  `/out:${path.join(outputRoot, 'OfficialSnapshotToolHarness.exe')}`,
  `/reference:${path.join(frameworkRoot, 'System.Web.Extensions.dll')}`,
  path.join(desktopRoot, 'native', 'OfficialSnapshotToolHarness.cs'),
  path.join(desktopRoot, 'native', 'OfficialSnapshotTool.cs'),
  path.join(desktopRoot, 'native', 'OfficialSnapshotAnalyzer.cs'),
  path.join(desktopRoot, 'native', 'OfficialSnapshotCorrelator.cs'),
  path.join(desktopRoot, 'native', 'OfficialSnapshotDecode.cs'),
  path.join(desktopRoot, 'native', 'Sqlite3McAnalysis.cs'),
  path.join(desktopRoot, 'native', 'OfficialSourceInventory.cs'),
  path.join(desktopRoot, 'native', 'OfficialSourceKeyProbe.cs'),
  path.join(desktopRoot, 'native', 'LineEncryptedSnapshot.cs'),
  path.join(desktopRoot, 'native', 'LineEncryptedPageValidator.cs'),
  path.join(desktopRoot, 'native', 'Sqlite3Mc.cs'),
  path.join(desktopRoot, 'native', 'NativeSourceArchive.cs'),
]);
compile([
  '/nologo', '/target:exe', '/platform:x64', '/optimize+', '/define:SQLITE_FIXTURE_WRITER',
  '/main:OfficialSchemaNamesToolHarness',
  `/out:${path.join(outputRoot, 'OfficialSchemaNamesToolHarness.exe')}`,
  `/reference:${path.join(frameworkRoot, 'System.Web.Extensions.dll')}`,
  path.join(desktopRoot, 'native', 'OfficialSchemaNamesToolHarness.cs'),
  path.join(desktopRoot, 'native', 'Sqlite3McSchemaNames.cs'),
  path.join(desktopRoot, 'native', 'Sqlite3Mc.cs'),
  path.join(desktopRoot, 'native', 'NativeSourceArchive.cs'),
  path.join(desktopRoot, 'native', 'LineEncryptedSnapshot.cs'),
  path.join(desktopRoot, 'native', 'LineEncryptedPageValidator.cs'),
]);
process.stdout.write(`${fixtureOutput}\n`);
