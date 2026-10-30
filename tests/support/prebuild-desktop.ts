import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, readdir, readFile, rm, stat, utimes, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const desktopRoot = path.join(repositoryRoot, 'apps', 'desktop');
// Stamp and lock live outside dist/ because electron-builder packs dist/**/* into the asar.
const stateRoot = path.join(repositoryRoot, 'node_modules', '.cache', 'linejs-test-prebuild');
const stampPath = path.join(stateRoot, 'stamp');
const lockPath = path.join(stateRoot, 'lock');
// A live holder refreshes the lock's mtime this often; a lock untouched for STALE_LOCK_MS belongs to a dead process.
const HEARTBEAT_MS = 5_000;
const STALE_LOCK_MS = 60_000;

const inputRoots = [
  path.join(desktopRoot, 'src'), path.join(desktopRoot, 'native'), path.join(desktopRoot, 'scripts'),
  path.join(repositoryRoot, 'packages', 'contracts', 'src'), path.join(repositoryRoot, 'packages', 'line-chrome', 'src'), path.join(repositoryRoot, 'packages', 'database', 'src'),
  path.join(repositoryRoot, 'packages', 'database', 'migrations'),
  path.join(repositoryRoot, 'packages', 'agent-bridge', 'src'), path.join(repositoryRoot, 'packages', 'line-worker', 'src'),
];
const skipped = /(^|[\\/])(node_modules|dist)([\\/]|$)|\.test\.(ts|tsx|mjs)$/;

async function newestInputTime(directory: string): Promise<number> {
  let newest = 0;
  let entries;
  try { entries = await readdir(directory, { withFileTypes: true }); } catch { return 0; }
  for (const entry of entries) {
    const entryPath = path.join(directory, entry.name);
    if (skipped.test(entryPath)) continue;
    newest = Math.max(newest, entry.isDirectory() ? await newestInputTime(entryPath) : (await stat(entryPath)).mtimeMs);
  }
  return newest;
}

const requiredOutputs = [
  path.join(repositoryRoot, 'packages', 'line-chrome', 'dist', 'index.js'),
  path.join(desktopRoot, 'dist', 'main.js'),
  path.join(desktopRoot, 'dist', 'js-external-reader', 'v1', 'ExternalReaderBridge.exe'),
  path.join(desktopRoot, 'dist', 'js-external-reader', 'v1', 'manifest.json'),
];

async function upToDate(): Promise<boolean> {
  // A stamp without its outputs (dist/ cleaned or a build killed after stamping) must not count as built.
  for (const output of requiredOutputs) if (!await stat(output).then(() => true, () => false)) return false;
  const stamp = await stat(stampPath).then((value) => value.mtimeMs, () => 0);
  if (stamp === 0) return false;
  const lockfile = await stat(path.join(repositoryRoot, 'package-lock.json')).then((value) => value.mtimeMs, () => 0);
  if (lockfile > stamp) return false;
  for (const root of inputRoots) if (await newestInputTime(root) > stamp) return false;
  return true;
}

async function withBuildLock<T>(run: () => Promise<T>): Promise<T> {
  await mkdir(stateRoot, { recursive: true });
  for (;;) {
    try { await mkdir(lockPath); break; }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      // A holder that died mid-build stops refreshing the lock; only then is it stale, however long its build ran.
      const age = Date.now() - await stat(lockPath).then((value) => value.mtimeMs, () => Date.now());
      if (age > STALE_LOCK_MS) await rm(lockPath, { recursive: true, force: true });
      else await new Promise((resolve) => setTimeout(resolve, 200));
    }
  }
  // Own the lock with a token: if this process is slow enough for its lock to be judged stale and taken over, it must
  // neither refresh nor delete the new holder's lock.
  const token = randomUUID();
  const ownerPath = path.join(lockPath, 'owner');
  await writeFile(ownerPath, token);
  const stillOurs = async () => await readFile(ownerPath, 'utf8').then((value) => value === token, () => false);
  const heartbeat = setInterval(() => {
    void stillOurs().then(async (ours) => { if (ours) { const now = new Date(); await utimes(lockPath, now, now); } }).catch(() => undefined);
  }, HEARTBEAT_MS);
  try { return await run(); } finally {
    clearInterval(heartbeat);
    if (await stillOurs()) await rm(lockPath, { recursive: true, force: true });
  }
}

function runStep(command: string, args: string[], shell = false): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: 'inherit', shell, cwd: repositoryRoot });
    child.once('error', reject);
    child.once('exit', (code) => code === 0 ? resolve() : reject(new Error(`${command} ${args.join(' ')} exited with ${code}`)));
  });
}

/**
 * Runs the build asynchronously so the lock heartbeat keeps ticking while it runs. Workspace package dist/ output is
 * rebuilt first: the renderer and main bundles resolve @line-agent/* through it, and a merge that adds a contract export
 * otherwise fails the desktop build with MISSING_EXPORT.
 */
async function runBuild(): Promise<void> {
  for (const workspace of ['contracts', 'line-chrome', 'database', 'agent-bridge', 'line-worker']) {
    await runStep('npm', ['run', 'build', '--workspace', `@line-agent/${workspace}`], true);
  }
  await runStep(process.execPath, [path.join(desktopRoot, 'scripts', 'build.mjs')]);
}

/**
 * Vitest global setup: build the desktop bundle and JS external reader resources once per run, before any worker
 * starts, unless dist/ is already newer than every build input. Test files then skip their own rebuilds (see
 * apps/desktop/src/test-support/build-desktop.ts), which removes the cross-file races on the shared dist/ tree: a
 * rebuild while a sibling file executes the reader bridge fails csc or replaces the manifest under a running test.
 * Concurrent vitest processes in one worktree serialize on a lock and the later ones find the build up to date.
 * Workers inherit this process environment.
 */
export default async function prebuildDesktop(): Promise<void> {
  if (process.platform !== 'win32' || process.arch !== 'x64') return;
  if (!await upToDate()) {
    await withBuildLock(async () => {
      if (await upToDate()) return;
      await runBuild();
      const now = new Date();
      await writeFile(stampPath, now.toISOString());
      await utimes(stampPath, now, now);
    });
  }
  process.env.LINEJS_TEST_DESKTOP_PREBUILT = '1';
}
