import { createHash, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { copyFile, mkdir, open, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { build } from 'esbuild';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

if (process.platform !== 'win32' || process.arch !== 'x64') throw new Error('The JS external reader bridge requires Windows x64.');

const desktopRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const repositoryRoot = path.resolve(desktopRoot, '../..');
const systemRoot = await realpath(process.env.SystemRoot ?? 'C:\\Windows');
const frameworkRoot = path.join(systemRoot, 'Microsoft.NET', 'Framework64', 'v4.0.30319');
const compiler = await realpath(path.join(frameworkRoot, 'csc.exe'));
if (path.dirname(compiler).toLowerCase() !== frameworkRoot.toLowerCase() || (await readFile(compiler)).subarray(0, 2).toString() !== 'MZ') {
  throw new Error('A trusted Windows .NET Framework x64 compiler is required.');
}

const referenceRoots = [path.join(repositoryRoot, '.references'), path.resolve(repositoryRoot, '..', '..', '.references')];
let sqliteSource;
for (const referenceRoot of referenceRoots) {
  const candidate = path.join(referenceRoot, 'runtime-cache', 'sqlite3mc-2.5.1', 'dll', 'sqlite3mc_x64.dll');
  if (await readFile(candidate).then(() => true, () => false)) { sqliteSource = candidate; break; }
}
if (!sqliteSource) throw new Error('Pinned SQLite3MC resource is unavailable.');

const outputRoot = path.join(desktopRoot, 'dist', 'js-external-reader', 'v1');
const bridgeOutput = path.join(outputRoot, 'ExternalReaderBridge.exe');
const sqliteOutput = path.join(outputRoot, 'sqlite3mc_x64.dll');
const releaseLock = await acquireBuildLock(path.join(desktopRoot, 'dist', '.js-external-reader-build.lock'));
try {
await mkdir(outputRoot, { recursive: true });
await Promise.all(['controller.mjs.map', 'SqliteFixtureHarness.exe'].map((name) => rm(path.join(outputRoot, name), { force: true })));
execFileSync(compiler, [
  '/nologo', '/target:exe', '/platform:x64', '/optimize+',
  `/out:${bridgeOutput}`,
  `/reference:${path.join(frameworkRoot, 'System.Web.Extensions.dll')}`,
  path.join(desktopRoot, 'native', 'ExternalReaderBridge.cs'),
  path.join(desktopRoot, 'native', 'OfficialLineMainWindowCloser.cs'),
  path.join(desktopRoot, 'native', 'Sqlite3Mc.cs'),
  path.join(desktopRoot, 'native', 'NativeSourceArchive.cs'),
  path.join(desktopRoot, 'native', 'LineEncryptedPageValidator.cs'),
  path.join(desktopRoot, 'native', 'OfficialSourceInventory.cs'),
  path.join(desktopRoot, 'native', 'OfficialSourceHeaderProbe.cs'),
  path.join(desktopRoot, 'native', 'NativeAttachmentOperations.cs'),
  path.join(desktopRoot, 'native', 'OfficialSourceKeyProbe.cs'),
  path.join(desktopRoot, 'native', 'LineEncryptedSnapshot.cs'),
], { shell: false, windowsHide: true, stdio: 'inherit', env: { SystemRoot: systemRoot, TEMP: process.env.TEMP, TMP: process.env.TMP } });

const sqliteBytes = await readFile(sqliteSource);
const sqliteDigest = createHash('sha256').update(sqliteBytes).digest('hex');
if (sqliteBytes.byteLength !== 2_442_576 || sqliteDigest !== '5030decc6d914539e3b9b7e28aa4f6de1e7161dac6fd4b21eb02e6754d9b175e') {
  throw new Error('Pinned SQLite3MC resource integrity failure.');
}
await copyFile(sqliteSource, sqliteOutput);

const controllerOutput = path.join(outputRoot, 'controller.mjs');
await build({ entryPoints: [path.join(desktopRoot, 'src', 'main', 'services', 'js-external-reader', 'entry.ts')], outfile: controllerOutput,
  bundle: true, platform: 'node', format: 'esm', target: 'node24', external: ['electron'], sourcemap: false,
  ...(process.argv.includes('--minify') ? { minify: true, keepNames: true } : {}) });

const files = {};
for (const filename of [bridgeOutput, controllerOutput, sqliteOutput]) {
  const bytes = await readFile(filename);
  files[path.basename(filename)] = { bytes: bytes.byteLength, sha256: createHash('sha256').update(bytes).digest('hex') };
}
await writeFile(path.join(outputRoot, 'manifest.json'), `${JSON.stringify({ schemaVersion: 1, candidateVersion: 'v1', capability: 'readonly_source_verify_candidate', files }, null, 2)}\n`, { flag: 'w' });
process.stdout.write('Built and staged the isolated JS read-only source verification candidate.\n');
} finally {
  await releaseLock();
}

async function acquireBuildLock(lockPath) {
  await mkdir(path.dirname(lockPath), { recursive: true });
  const token = `${process.pid}:${randomUUID()}`;
  const timeoutAt = Date.now() + 30_000;
  while (Date.now() < timeoutAt) {
    try {
      const handle = await open(lockPath, 'wx');
      await handle.writeFile(token);
      await handle.close();
      return async () => {
        if (await readFile(lockPath, 'utf8').then((value) => value === token, () => false)) await rm(lockPath, { force: true });
      };
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error;
      const holder = await readFile(lockPath, 'utf8').catch(() => '');
      const processId = Number(holder.split(':', 1)[0]);
      let alive = Number.isSafeInteger(processId) && processId > 0;
      if (alive) {
        try { process.kill(processId, 0); }
        catch (probeError) { if (probeError?.code === 'ESRCH') alive = false; }
      }
      if (!alive) await rm(lockPath, { force: true });
      else await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
  throw new Error('Timed out waiting for the JS external reader build lock.');
}
