import { execFileSync, spawn, spawnSync, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFile, lstat, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const desktopRoot = path.resolve(fileURLToPath(new URL('../../../../', import.meta.url)));
let fixtureRoot = '';
let fixtureWriter: ChildProcessWithoutNullStreams | undefined;
let databasePath = '';
let snapshotHarness = '';

describe('synthetic encrypted EDB/WAL private snapshot', () => {
  beforeAll(async () => {
    fixtureRoot = await mkdtemp(path.join(os.tmpdir(), 'linejs-private-snapshot-'));
    const fixtureExe = execFileSync(process.execPath, [path.join(desktopRoot, 'scripts', 'build-js-external-reader-fixtures.mjs'), fixtureRoot], { encoding: 'utf8' }).trim();
    snapshotHarness = path.join(fixtureRoot, 'SnapshotFixtureHarness.exe');
    databasePath = path.join(fixtureRoot, 'LINE', 'Data', 'db', 'messages.edb');
    fixtureWriter = spawn(fixtureExe, ['--snapshot-hold', fixtureRoot], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    await expectLine(fixtureWriter, 'READY', 8_000);
  });

  afterAll(async () => {
    if (fixtureWriter && fixtureWriter.exitCode === null) {
      fixtureWriter.stdin.end('CLOSE\n');
      try { await waitClose(fixtureWriter, 5_000); }
      catch {
        fixtureWriter.kill();
        await waitClose(fixtureWriter, 2_000);
      }
    }
    fixtureWriter = undefined;
    if (fixtureRoot) await rm(fixtureRoot, { recursive: true, force: true });
  });

  it('captures a committed WAL prefix, revalidates the private page key, opens only the copy, then cleans owned files', async () => {
    const sourceBefore = await hashes();
    const scenario = await prepareScenario('success');
    const run = runCapture(scenario, 'valid');
    expect(run.status, run.stdout + run.stderr).toBe(0);
    expect(run.stdout).toMatch(/^PASS\|ORDER=Database1Copied,Wal1Copied,Wal2Observed,Database2Observed\|OPEN_ATTEMPTS=2\|PAGE_SIZE=4096\|WAL_COMMIT_BYTES=[3-9]\d+\r?\n$/);
    expect(await hashes(scenario.databasePath)).toEqual(scenario.sourceBefore);
    expect(await hashes()).toEqual(sourceBefore);
    expect(await readdir(scenario.privateRoot)).toEqual([]);
  }, 15_000);

  it('rejects a bootstrap key mismatch before any private SQLite open and cleans its copy', async () => {
    const sourceBefore = await hashes();
    const scenario = await prepareScenario('wrong-key');
    const run = runCapture(scenario, 'wrong-key');
    expect(run.status).toBe(1);
    expect(run.stdout.trim(), run.stderr).toMatch(/^FAIL\|snapshot_key_mismatch\|OPEN_ATTEMPTS=0\|ORDER=Database1Copied,Wal1Copied,Wal2Observed,Database2Observed$/);
    expect(await hashes(scenario.databasePath)).toEqual(scenario.sourceBefore);
    expect(await hashes()).toEqual(sourceBefore);
    expect(await readdir(scenario.privateRoot)).toEqual([]);
  }, 15_000);

  it('rejects same-length content mutation even when the source timestamp is restored', async () => {
    const sourceBefore = await hashes();
    const scenario = await prepareScenario('mutated');
    const run = runCapture(scenario, 'same-length-change');
    expect(run.status).toBe(1);
    expect(run.stdout.trim(), run.stderr).toMatch(/^FAIL\|snapshot_source_changed\|OPEN_ATTEMPTS=0\|ORDER=Database1Copied,Wal1Copied,Wal2Observed,Database2Observed$/);
    expect(await hashes(scenario.databasePath)).toEqual(scenario.sourceBefore);
    expect(await hashes()).toEqual(sourceBefore);
    expect(await readdir(scenario.privateRoot)).toEqual([]);
  }, 15_000);

  it('rejects WAL replacement and a hot journal without retaining private copies', async () => {
    const sourceBefore = await hashes();
    const replacementScenario = await prepareScenario('wal-replaced');
    const replacement = runCapture(replacementScenario, 'wal-replacement');
    expect(replacement.status).toBe(1);
    expect(replacement.stdout.trim(), replacement.stderr).toMatch(/^FAIL\|snapshot_source_changed\|OPEN_ATTEMPTS=0\|ORDER=Database1Copied,Wal1Copied,Wal2Observed,Database2Observed$/);
    expect(await hashes(replacementScenario.databasePath)).toEqual(replacementScenario.sourceBefore);
    expect(await hashes()).toEqual(sourceBefore);
    expect(await readdir(replacementScenario.privateRoot)).toEqual([]);

    const journalScenario = await prepareScenario('hot-journal');
    const journal = runCapture(journalScenario, 'hot-journal');
    expect(journal.status).toBe(1);
    expect(journal.stdout.trim(), journal.stderr).toMatch(/^FAIL\|snapshot_hot_journal\|OPEN_ATTEMPTS=0\|ORDER=Database1Copied,Wal1Copied,Wal2Observed,Database2Observed$/);
    expect(await hashes(journalScenario.databasePath)).toEqual(journalScenario.sourceBefore);
    expect(await hashes()).toEqual(sourceBefore);
    expect(await readdir(journalScenario.privateRoot)).toEqual([]);
  }, 20_000);

  it('enforces source-byte, cancellation, and deadline bounds with owned cleanup', async () => {
    const sourceBefore = await hashes();
    for (const [scenario, code] of [['size-limit', 'snapshot_size_limit'], ['cancel', 'CANCELLED'], ['deadline', 'DEADLINE'], ['cancel-held-guards', 'CANCELLED'], ['deadline-held-guards', 'DEADLINE'], ['callback-failure', 'snapshot_callback_failure']] as const) {
      const prepared = await prepareScenario(scenario);
      const run = runCapture(prepared, scenario);
      expect(run.status, `${scenario}: ${run.stdout}${run.stderr}`).toBe(1);
      const expectedOpens = scenario.endsWith('held-guards') || scenario === 'callback-failure' ? 2 : 0;
      expect(run.stdout.trim(), `${scenario}: ${run.stderr}`).toMatch(new RegExp(`^FAIL\\|${code}\\|OPEN_ATTEMPTS=${expectedOpens}\\|ORDER=.*$`));
      expect(await hashes(prepared.databasePath)).toEqual(prepared.sourceBefore);
      expect(await hashes()).toEqual(sourceBefore);
      expect(await readdir(prepared.privateRoot)).toEqual([]);
    }
  }, 20_000);

  it('preserves destination collisions and replaced files, directories, and reparse targets', async () => {
    const sourceBefore = await hashes();
    const collision = await prepareScenario('preexisting-collision');
    await mkdir(collision.privateRoot, { recursive: true });
    const preexistingFile = path.join(collision.privateRoot, 'snapshot.edb');
    await writeFile(preexistingFile, Buffer.from('UNOWNED_COLLISION'));
    const preexisting = runCapture(collision, 'preexisting-collision');
    expect(preexisting.stdout.trim()).toMatch(/^FAIL\|snapshot_destination_exists\|OPEN_ATTEMPTS=0\|ORDER=$/);
    expect(await readFile(preexistingFile, 'utf8')).toBe('UNOWNED_COLLISION');

    const walCollision = await prepareScenario('wal-collision');
    const walPath = path.join(walCollision.privateRoot, 'snapshot.edb-wal');
    const walResult = runCapture(walCollision, 'wal-collision');
    expect(walResult.stdout.trim()).toMatch(/^FAIL\|snapshot_ownership_lost\|OPEN_ATTEMPTS=0\|ORDER=Database1Copied$/);
    expect(await readdir(walCollision.privateRoot)).toEqual(['snapshot.edb-wal']);
    expect(await readFile(walPath, 'utf8')).toBe('UNOWNED_WAL_COLLISION');

    for (const mode of ['replace-file', 'replace-directory', 'replace-reparse'] as const) {
      const replaced = await prepareScenario(mode);
      const output = runCapture(replaced, mode);
      expect(output.stdout.trim()).toMatch(/^FAIL\|snapshot_ownership_lost\|OPEN_ATTEMPTS=0\|ORDER=Database1Copied$/);
      const privateDatabase = path.join(replaced.privateRoot, 'snapshot.edb');
      if (mode === 'replace-file') expect(await readFile(privateDatabase, 'utf8')).toBe('UNOWNED_FILE_REPLACEMENT');
      if (mode === 'replace-directory') expect(await readFile(path.join(privateDatabase, 'sentinel'), 'utf8')).toBe('UNOWNED_DIRECTORY_REPLACEMENT');
      if (mode === 'replace-reparse') {
        const target = path.join(replaced.scenarioRoot, 'snapshot-reparse-target');
        expect(await readFile(target, 'utf8')).toBe('UNOWNED_REPARSE_TARGET');
        expect((await lstat(privateDatabase)).isSymbolicLink()).toBe(true);
      }
      expect((await readdir(replaced.privateRoot)).sort()).toEqual(['snapshot.edb']);
    }
    const rootReplacement = await prepareScenario('replace-private-directory');
    const rootResult = runCapture(rootReplacement, 'replace-private-directory');
    expect(rootResult.stdout.trim(), rootResult.stderr).toMatch(/^FAIL\|snapshot_ownership_lost\|OPEN_ATTEMPTS=0\|ORDER=Database1Copied$/);
    expect(await readFile(path.join(rootReplacement.privateRoot, 'UNOWNED_SENTINEL'), 'utf8')).toBe('UNOWNED_DIRECTORY_SENTINEL');
    expect((await readdir(rootReplacement.privateRoot)).sort()).toEqual(['UNOWNED_SENTINEL']);
    const movedOwnedRoot = rootReplacement.privateRoot + '-moved';
    expect(await readdir(movedOwnedRoot).catch(() => [])).toEqual([]);
    await rm(movedOwnedRoot, { recursive: true, force: true });
    expect(await hashes()).toEqual(sourceBefore);
  }, 25_000);

  it('owns SHM only by exclusive creation, never claims journals, and holds DB/WAL guards through SQLite close', async () => {
    const shmCollision = await prepareScenario('shm-collision');
    const shmPath = path.join(shmCollision.privateRoot, 'snapshot.edb-shm');
    const shmResult = runCapture(shmCollision, 'shm-collision');
    expect(shmResult.status).toBe(1);
    expect(shmResult.stdout.trim()).toMatch(/^FAIL\|snapshot_ownership_lost\|OPEN_ATTEMPTS=0\|ORDER=Database1Copied,Wal1Copied,Wal2Observed,Database2Observed$/);
    expect(await readFile(shmPath, 'utf8')).toBe('UNOWNED_SHM_COLLISION');

    const journalCollision = await prepareScenario('private-journal-collision');
    const journalPath = path.join(journalCollision.privateRoot, 'snapshot.edb-journal');
    const journalResult = runCapture(journalCollision, 'private-journal-collision');
    expect(journalResult.status).toBe(1);
    expect(journalResult.stdout.trim()).toMatch(/^FAIL\|snapshot_ownership_lost\|OPEN_ATTEMPTS=0\|ORDER=Database1Copied,Wal1Copied,Wal2Observed,Database2Observed$/);
    expect(await readFile(journalPath, 'utf8')).toBe('UNOWNED_JOURNAL_COLLISION');

    const journalMid = await prepareScenario('journal-mid-callback');
    const journalMidPath = path.join(journalMid.privateRoot, 'snapshot.edb-journal');
    const journalMidResult = runCapture(journalMid, 'journal-mid-callback');
    expect(journalMidResult.status).toBe(1);
    expect(journalMidResult.stdout.trim()).toMatch(/^FAIL\|snapshot_ownership_lost\|OPEN_ATTEMPTS=2\|ORDER=Database1Copied,Wal1Copied,Wal2Observed,Database2Observed$/);
    expect(await readFile(journalMidPath, 'utf8')).toBe('UNOWNED_JOURNAL_MID_CALLBACK');

    const journalDirectory = await prepareScenario('journal-directory-boundary');
    const journalDirectoryResult = runCapture(journalDirectory, 'journal-directory-boundary');
    expect(journalDirectoryResult.status).toBe(1);
    expect(journalDirectoryResult.stdout.trim()).toMatch(/^FAIL\|snapshot_ownership_lost\|OPEN_ATTEMPTS=2\|ORDER=Database1Copied,Wal1Copied,Wal2Observed,Database2Observed$/);
    expect(await readFile(path.join(journalDirectory.privateRoot, 'snapshot.edb-journal', 'sentinel'), 'utf8')).toBe('UNOWNED_JOURNAL_DIRECTORY');

    const shmReplacement = await prepareScenario('shm-replacement-boundary');
    const shmReplacementResult = runCapture(shmReplacement, 'shm-replacement-boundary');
    expect(shmReplacementResult.status, shmReplacementResult.stdout + shmReplacementResult.stderr).toBe(0);
    expect(await readdir(shmReplacement.privateRoot)).toEqual([]);

    const boundary = await prepareScenario('guarded-open-boundary');
    const guarded = runCapture(boundary, 'guarded-open-boundary');
    expect(guarded.status, guarded.stdout + guarded.stderr).toBe(0);
    expect(guarded.stdout).toMatch(/^PASS\|ORDER=Database1Copied,Wal1Copied,Wal2Observed,Database2Observed\|OPEN_ATTEMPTS=2\|PAGE_SIZE=4096\|WAL_COMMIT_BYTES=[3-9]\d+\r?\n$/);
    expect(await readdir(boundary.privateRoot)).toEqual([]);
  }, 25_000);

  it('retains the exact WAL1 stream and denies mutation from copy through SQLite close', async () => {
    const scenario = await prepareScenario('wal-stream-lifecycle');
    const result = runCapture(scenario, 'wal-stream-lifecycle');
    expect(result.status, result.stdout + result.stderr).toBe(0);
    expect(result.stdout).toMatch(/^PASS\|ORDER=Database1Copied,Wal1Copied,Wal2Observed,Database2Observed\|OPEN_ATTEMPTS=2\|PAGE_SIZE=4096\|WAL_COMMIT_BYTES=[3-9]\d+\r?\n$/);
    expect(await hashes(scenario.databasePath)).toEqual(scenario.sourceBefore);
    expect(await readdir(scenario.privateRoot)).toEqual([]);
  }, 15_000);

  it('rejects malformed or uncommitted WAL and trims a valid uncommitted tail', async () => {
    const sourceBefore = await hashes();
    for (const [mode, code] of [['bad-wal-header', 'snapshot_wal_invalid'], ['no-wal-commit', 'snapshot_wal_no_commit']] as const) {
      const scenario = await prepareScenario(mode);
      const run = runCapture(scenario, mode);
      expect(run.status, `${mode}: ${run.stdout}${run.stderr}`).toBe(1);
      expect(run.stdout.trim()).toMatch(new RegExp(`^FAIL\\|${code}\\|OPEN_ATTEMPTS=0\\|ORDER=Database1Copied,Wal1Copied,Wal2Observed,Database2Observed$`));
      expect(await hashes(scenario.databasePath)).toEqual(scenario.sourceBefore);
      expect(await readdir(scenario.privateRoot)).toEqual([]);
    }

    for (const [mode, code] of [['wal-header-only', 'snapshot_wal_no_commit']] as const) {
      const missing = await prepareScenario(mode);
      const rejected = runCapture(missing, mode);
      expect(rejected.status, `${mode}: ${rejected.stdout}${rejected.stderr}`).toBe(1);
      expect(rejected.stdout.trim()).toMatch(new RegExp(`^FAIL\\|${code}\\|OPEN_ATTEMPTS=0\\|ORDER=Database1Copied,Wal1Copied,Wal2Observed,Database2Observed$`));
      expect(await hashes(missing.databasePath)).toEqual(missing.sourceBefore);
      expect(await readdir(missing.privateRoot)).toEqual([]);
    }

    for (const mode of ['wal-absent', 'wal-empty'] as const) {
      const baseOnly = await prepareScenario(mode);
      const accepted = runCapture(baseOnly, mode);
      expect(accepted.status, `${mode}: ${accepted.stdout}${accepted.stderr}`).toBe(0);
      expect(accepted.stdout).toMatch(/^PASS\|ORDER=Database1Copied,Wal1Copied,Wal2Observed,Database2Observed\|OPEN_ATTEMPTS=2\|PAGE_SIZE=4096\|WAL_COMMIT_BYTES=0\r?\n$/);
      expect(await hashes(baseOnly.databasePath)).toEqual(baseOnly.sourceBefore);
      expect(await readdir(baseOnly.privateRoot)).toEqual([]);
    }

    for (const mode of ['private-db-same-length-change', 'wal-mutated-before-validation', 'wal-mutated-at-validation'] as const) {
      const changed = await prepareScenario(mode);
      const rejected = runCapture(changed, mode);
      expect(rejected.status).toBe(1);
      expect(rejected.stdout.trim()).toMatch(/^FAIL\|snapshot_source_changed\|OPEN_ATTEMPTS=0\|ORDER=Database1Copied,Wal1Copied,Wal2Observed,Database2Observed$/);
      expect(await hashes(changed.databasePath)).toEqual(changed.sourceBefore);
      expect(await readdir(changed.privateRoot)).toEqual([]);
    }

    const tail = await prepareScenario('uncommitted-tail');
    const committedWalBytes = (await readFile(tail.databasePath + '-wal')).byteLength;
    const result = runCapture(tail, 'uncommitted-tail');
    expect(result.status, result.stdout + result.stderr).toBe(0);
    expect(result.stdout).toMatch(new RegExp(`\\|WAL_COMMIT_BYTES=${committedWalBytes}\\r?\\n$`));
    expect(await hashes(tail.databasePath)).toEqual(tail.sourceBefore);
    expect(await readdir(tail.privateRoot)).toEqual([]);
    expect(await hashes()).toEqual(sourceBefore);
  }, 25_000);
});

async function prepareScenario(name: string) {
  const scenarioRoot = path.join(fixtureRoot, `case-${name}`);
  const sourceRoot = path.join(scenarioRoot, 'source');
  const privateRoot = path.join(scenarioRoot, 'private');
  await mkdir(sourceRoot, { recursive: true });
  const sourceDatabase = path.join(sourceRoot, 'messages.edb');
  await copyFile(databasePath, sourceDatabase); await copyFile(databasePath + '-wal', sourceDatabase + '-wal');
  return { scenarioRoot, privateRoot, databasePath: sourceDatabase, sourceBefore: await hashes(sourceDatabase) };
}

function runCapture(scenario: Awaited<ReturnType<typeof prepareScenario>>, mode: string) {
  return spawnSyncBounded(snapshotHarness, [scenario.databasePath, scenario.privateRoot, mode], 10_000);
}

function spawnSyncBounded(command: string, args: string[], timeout: number): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync(command, args, { encoding: 'utf8', windowsHide: true, timeout, maxBuffer: 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] });
  if (result.error) throw result.error;
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

async function hashes(database = databasePath) {
  return Promise.all([database, database + '-wal'].map(async (file) => createHash('sha256').update(await readFile(file)).digest('hex')));
}

async function expectLine(child: ChildProcessWithoutNullStreams, expected: string, timeoutMs: number): Promise<void> {
  let buffer = '', stderr = '';
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => finish(new Error('fixture_writer_timeout')), timeoutMs);
    const onData = (chunk: Buffer) => { buffer += chunk.toString('utf8'); if (buffer.split(/\r?\n/).includes(expected)) finish(); };
    const onError = (error: Error) => finish(error);
    const onClose = (code: number | null) => finish(new Error(`fixture_writer_closed_${code}:${stderr}`));
    const finish = (error?: Error) => {
      clearTimeout(timer); child.stdout.off('data', onData); child.off('error', onError); child.off('close', onClose);
      error ? reject(error) : resolve();
    };
    child.stdout.on('data', onData); child.stderr.on('data', (chunk) => { stderr += chunk.toString('utf8'); }); child.once('error', onError); child.once('close', onClose);
  });
}

async function waitClose(child: ChildProcessWithoutNullStreams, timeoutMs: number): Promise<void> {
  if (child.exitCode !== null) return;
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('fixture_writer_shutdown_timeout')), timeoutMs);
    child.once('close', () => { clearTimeout(timer); resolve(); });
  });
}
