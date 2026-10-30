import { execFileSync, spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { copyFile, mkdir, mkdtemp, open, readFile, readdir, realpath, rename, rm, stat, utimes, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { encodeFrame, FrameDecoder, FRAME_LIMITS } from './protocol.js';
import { FileOwnerReadyMarkerStore, type OwnerProcessIdentity } from './owner-ready-session.js';
import { JsExternalReaderController } from './controller.js';
import { ExternalSourceProbeAdmissionGate } from '../external-source-probe-admission.js';
import { buildDesktopScript } from '../../../test-support/build-desktop.js';

const desktopRoot = path.resolve(fileURLToPath(new URL('../../../../', import.meta.url)));
let fixtureRoot = '';
let inventoryHarness = '';
let inventoryBridgeHarness = '';
let fixtureLineExecutable = '';
let sourceBridge = '';

describe('synthetic official-source inventory', () => {
  beforeAll(async () => {
    fixtureRoot = await mkdtemp(path.join(os.tmpdir(), 'linejs-source-inventory-fixture-'));
    try {
      execFileSync(process.execPath, [path.join(desktopRoot, 'scripts', 'build-js-external-reader-fixtures.mjs'), fixtureRoot], { stdio: 'inherit' });
      inventoryHarness = path.join(fixtureRoot, 'OfficialSourceInventoryHarness.exe');
      inventoryBridgeHarness = path.join(fixtureRoot, 'OfficialSourceInventoryBridgeHarness.exe');
      sourceBridge = path.join(fixtureRoot, 'ExternalReaderBridgeSourceTest.exe');
      fixtureLineExecutable = path.join(fixtureRoot, 'LINE', 'bin', 'current', 'LINE.exe');
    } catch (error) {
      await rm(fixtureRoot, { recursive: true, force: true });
      fixtureRoot = '';
      throw error;
    }
  });

  afterAll(async () => {
    if (fixtureRoot) await rm(fixtureRoot, { recursive: true, force: true });
    fixtureRoot = '';
  });

  it('accepts one supported synthetic build, EDB, WAL, and injected process identity', async () => {
    const root = await createSource();
    try {
      const result = runInventory(root, 'accept');
      expect(result).toMatch(/^PASS\|26\.4\.2\.3957\|1\|1\|1\|accepted$/);
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it('pins the only production build identity to the reviewed reference', async () => {
    const root = await createSource();
    try {
      expect(runInventory(root, 'contract')).toBe(
        'CONTRACT|26.4.2.3957|30634432|893d899f3b39d9cef59752067166b7e72c6f7021e1841b24b617ab079cf8f2b1',
      );
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it('fails closed on the official-source operation before any source inventory', () => {
    const requestId = '0123456789abcdef0123456789abcdef';
    const init = encodeFrame({ version: 1, requestId, sequence: 1, type: 'init', operation: 'verify_official_source',
      expectedMid: 'synthetic-mid', deadlineUnixMs: Date.now() + 10_000 }, FRAME_LIMITS.controlBytes);
    const result = spawnSync(sourceBridge, ['--request-id', requestId], {
      input: init, encoding: 'buffer', windowsHide: true, timeout: 10_000, maxBuffer: 16 * 1024,
    });
    if (result.error) throw result.error;
    expect(result.status).toBe(4);
    expect(result.stdout.byteLength).toBeLessThan(1024);
  });

  it('waits for owner-ready before synthetic process/source inventory and returns sanitized bounds only', async () => {
    const root = await createSource();
    try {
      const result = await runProtocolInventory(root, 'pinnedaccept');
      expect(result.frames.map((frame) => frame.type)).toEqual(['hello', 'inventory', 'result', 'closed']);
      expect(result.frames[1]).toMatchObject({ buildCode: 'accepted', buildVersion: '26.4.2.3957', buildBytes: 30634432, candidateCount: 1, processCount: 1 });
      expect(result.frames[1]).toHaveProperty('edbMiB');
      expect(result.frames[1]).toHaveProperty('walMiB');
      expect(result.frames[2]).toEqual(expect.objectContaining({ verdict: 'unsupported', mappingCode: 'not_checked' }));
      expect(result.frames[2]).not.toHaveProperty('sourcePath');
      expect(result.frames[2]).not.toHaveProperty('processId');
      expect(result.frames[3]).toMatchObject({ sourceAccessed: true });
      expect(result.exitCode).toBe(0);
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it('verifies an encrypted private snapshot with an exact fixture MID and schema', async () => {
    const root = await createSource(false);
    const lineProcess = spawn(path.join(root, 'LINE', 'bin', 'current', 'LINE.exe'), [], {
      stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true,
    });
    const writer = spawn(path.join(fixtureRoot, 'SqliteFixtureHarness.exe'), ['--snapshot-hold', root], {
      stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true,
    });
    const exitListenersBefore = process.listenerCount('exit');
    try {
      await Promise.all([waitReady(lineProcess, 'line_process_not_ready'), waitReady(writer, 'fixture_writer_not_ready')]);
      const before = createHash('sha256').update(await readFile(path.join(root, 'LINE', 'Data', 'db', 'messages.edb'))).digest('hex');
      const walBefore = createHash('sha256').update(await readFile(path.join(root, 'LINE', 'Data', 'db', 'messages.edb-wal'))).digest('hex');
      const shmBefore = createHash('sha256').update(await readFile(path.join(root, 'LINE', 'Data', 'db', 'messages.edb-shm'))).digest('hex');
      const keyProbe = spawnSync(path.join(fixtureRoot, 'OfficialSourceKeyProbeHarness.exe'),
        [path.join(root, 'LINE', 'Data', 'db', 'messages.edb')], { encoding: 'utf8', windowsHide: true, timeout: 5_000 });
      expect(keyProbe.status, keyProbe.stderr).toBe(0);
      expect(keyProbe.stdout.trim()).toBe('PASS|FIRST_PAGE_BEFORE_SQLITE|CANDIDATES=2');
      for (const scenario of ['ascii_carry', 'utf16_carry', 'wal_grow', 'partial_gap', 'unreadable_gap', 'identity_change', 'region_limit', 'cancel']) {
        const scan = spawnSync(path.join(fixtureRoot, 'OfficialSourceKeyProbeSyntheticHarness.exe'), [root, scenario], {
          encoding: 'utf8', windowsHide: true, timeout: 8_000,
        });
        expect(scan.status, `${scenario}: ${scan.stderr}`).toBe(0);
        expect(scan.stdout.trim()).toMatch(scenario.endsWith('_carry') || scenario === 'wal_grow' ? /^FOUND\|/ : /^REJECT\|/);
      }
      // One key rescan: found on the second scan; both fail -> key_unavailable after exactly two scans;
      // cancellation or a deadline expiry during the first scan never starts a second one.
      const rescanExpected: Record<string, RegExp> = {
        rescan_found: /^FOUND\|rescan_found\|reads=4\|passes=2$/,
        rescan_none: /^REJECT\|rescan_none\|reads=4\|passes=2$/,
        rescan_cancel: /^REJECT\|rescan_cancel\|reads=1\|passes=1$/,
        rescan_deadline: /^REJECT\|rescan_deadline\|reads=1\|passes=1$/,
      };
      for (const [scenario, expected] of Object.entries(rescanExpected)) {
        const scan = spawnSync(path.join(fixtureRoot, 'OfficialSourceKeyProbeSyntheticHarness.exe'), [root, scenario], {
          encoding: 'utf8', windowsHide: true, timeout: 8_000,
        });
        expect(scan.status, `${scenario}: ${scan.stderr}`).toBe(0);
        expect(scan.stdout.trim()).toMatch(expected);
      }
      const sameSource: Record<string, string> = {
        same_wal_grow: 'SAME', same_db_grow: 'SAME', same_db_replaced: 'CHANGED', same_exe_stat: 'CHANGED',
        same_exe_hash: 'CHANGED', same_process_restart: 'CHANGED',
      };
      for (const [scenario, verdict] of Object.entries(sameSource)) {
        const scan = spawnSync(path.join(fixtureRoot, 'OfficialSourceKeyProbeSyntheticHarness.exe'), [root, scenario], {
          encoding: 'utf8', windowsHide: true, timeout: 8_000,
        });
        expect(scan.status, `${scenario}: ${scan.stderr}`).toBe(0);
        expect(scan.stdout.trim()).toBe(verdict === 'SAME' ? `SAME|${scenario}` : `CHANGED|${scenario}|source_changed`);
      }
      const result = await runProtocolInventory(root, 'pinnedaccept', 'fixture-own-mid', undefined, lineProcess.pid);
      expect(result.frames.map((frame) => frame.type)).toEqual(['hello', 'inventory', 'result', 'closed']);
      expect(result.frames[2]).toMatchObject({ verdict: 'supported', mappingCode: 'line-profile-mid-v1', liveReadState: 'not_tested' });
      expect(result.frames[2]).not.toHaveProperty('rows');
      expect(result.exitCode).toBe(0);
      expect(await readdir(path.join(root, 'probe-abcdef0123456789abcdef0123456789'))).toEqual(['owner.json']);
      expect(createHash('sha256').update(await readFile(path.join(root, 'LINE', 'Data', 'db', 'messages.edb'))).digest('hex')).toBe(before);
      expect(createHash('sha256').update(await readFile(path.join(root, 'LINE', 'Data', 'db', 'messages.edb-wal'))).digest('hex')).toBe(walBefore);
      expect(createHash('sha256').update(await readFile(path.join(root, 'LINE', 'Data', 'db', 'messages.edb-shm'))).digest('hex')).toBe(shmBefore);
      const wrongMidId = 'fedcba9876543210fedcba9876543210';
      const wrongMid = await runProtocolInventory(root, 'pinnedaccept', 'another-mid', wrongMidId, lineProcess.pid);
      expect(wrongMid.frames[2]).toMatchObject({ verdict: 'unsupported', errorCode: 'official_account_not_active' });
      expect(await readdir(path.join(root, `probe-${wrongMidId}`))).toEqual(['owner.json']);
      for (const [index, shape] of ['zero', 'wrong', 'duplicate', 'mixed', 'unique'].entries()) {
        const acknowledged = new Promise<void>((resolve, reject) => {
          const timeout = setTimeout(() => reject(new Error('profile_shape_timeout')), 20_000);
          writer.stdout.once('data', (data: Buffer) => {
            clearTimeout(timeout);
            if (!data.toString().includes('PROFILE_SET')) reject(new Error('profile_shape_not_set'));
            else resolve();
          });
        });
        writer.stdin.write(`PROFILE_${shape.toUpperCase()}\n`);
        await acknowledged;
        const requestId = `${(index + 1).toString(16).padStart(32, '0')}`;
        const probe = await runProtocolInventory(root, 'pinnedaccept', 'fixture-own-mid', requestId, lineProcess.pid);
        expect(probe.frames[2]).toMatchObject(shape === 'unique'
          ? { verdict: 'supported', mappingCode: 'line-profile-mid-v1' }
          // A readable single other MID is another logged-in account; zero/duplicate/mixed profiles are schema problems.
          : { verdict: 'unsupported', errorCode: shape === 'wrong' ? 'official_account_not_active' : 'mid_or_schema_mismatch' });
        expect(await readdir(path.join(root, `probe-${requestId}`))).toEqual(['owner.json']);
      }
      for (const [index, stage] of ['scan', 'shm_guard', 'query'].entries()) {
        const requestId = `${(index + 10).toString(16).padStart(32, '0')}`;
        const cancelled = await runProtocolInventory(root, 'pinnedaccept', 'fixture-own-mid', requestId,
          lineProcess.pid, stage);
        expect(cancelled.frames[2]).toMatchObject({ verdict: 'unsupported', errorCode: 'cancelled' });
        expect(cancelled.exitCode).toBe(0);
        expect(await readdir(path.join(root, `probe-${requestId}`))).toEqual(['owner.json']);
      }
      // A non-schema live-read failure must stay fail-closed (source_io_error -> guard unknown), never mid_or_schema_mismatch (other_account).
      const failId = '0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c';
      const failStarted = Date.now();
      const readFailure = await runProtocolInventory(root, 'pinnedaccept', 'fixture-own-mid', failId, lineProcess.pid, 'query_fail');
      expect(Date.now() - failStarted).toBeLessThan(4_000);
      expect(readFailure.exitCode).toBe(0);
      expect(readFailure.frames.map((frame) => frame.type)).toEqual(['hello', 'inventory', 'result', 'closed']);
      expect(readFailure.frames[2]).toMatchObject({ verdict: 'unsupported', errorCode: 'source_io_error' });
      expect(readFailure.frames[2]).not.toMatchObject({ errorCode: 'mid_or_schema_mismatch' });
      expect(await readdir(path.join(root, `probe-${failId}`))).toEqual(['owner.json']);
      expect(process.listenerCount('exit')).toBe(exitListenersBefore);
    } finally {
      writer.stdout?.resume(); writer.stderr?.resume(); lineProcess.stdout?.resume(); lineProcess.stderr?.resume();
      writer.stdin.end('CLOSE\n');
      await new Promise<void>((resolve) => { if (writer.exitCode !== null) resolve(); else writer.once('close', () => resolve()); });
      lineProcess.stdin.end('\n');
      await new Promise<void>((resolve) => { if (lineProcess.exitCode !== null) resolve(); else lineProcess.once('close', () => resolve()); });
      await rm(root, { recursive: true, force: true });
    }
  }, 20_000);

  it('verifies a large (>64 MiB) source in place well under the guard deadline without creating a snapshot', async () => {
    const root = await createSource(false);
    const lineProcess = spawn(path.join(root, 'LINE', 'bin', 'current', 'LINE.exe'), [], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    const writer = spawn(path.join(fixtureRoot, 'SqliteFixtureHarness.exe'), ['--snapshot-hold-large', root], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    try {
      await Promise.all([waitReady(lineProcess, 'line_process_not_ready'), waitReady(writer, 'fixture_writer_not_ready')]);
      const databasePath = path.join(root, 'LINE', 'Data', 'db', 'messages.edb');
      expect((await stat(databasePath)).size).toBeGreaterThanOrEqual(64 * 1024 * 1024);
      const guardDeadlineMs = 20_000;
      const startedOk = Date.now();
      const ok = await runProtocolInventory(root, 'pinnedaccept', 'fixture-own-mid', '0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a', lineProcess.pid);
      const okElapsed = Date.now() - startedOk;
      expect(ok.frames[2]).toMatchObject({ verdict: 'supported', mappingCode: 'line-profile-mid-v1', liveReadState: 'not_tested' });
      expect(String(ok.frames[2]!.sourceDigest)).toMatch(/^[0-9a-f]{64}$/);
      expect(okElapsed).toBeLessThan(guardDeadlineMs);
      const startedBad = Date.now();
      const bad = await runProtocolInventory(root, 'pinnedaccept', 'another-mid', '0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b', lineProcess.pid);
      const badElapsed = Date.now() - startedBad;
      expect(bad.frames[2]).toMatchObject({ verdict: 'unsupported', errorCode: 'official_account_not_active' });
      expect(badElapsed).toBeLessThan(guardDeadlineMs);
      for (const id of ['0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a', '0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b'])
        expect(await readdir(path.join(root, `probe-${id}`))).toEqual(['owner.json']);
      console.log(`large-fixture verify_official_source elapsed: supported=${okElapsed}ms mismatch=${badElapsed}ms`);
    } finally {
      writer.stdout?.resume(); writer.stderr?.resume(); lineProcess.stdout?.resume(); lineProcess.stderr?.resume();
      writer.stdin.end('CLOSE\n');
      await new Promise<void>((resolve) => { if (writer.exitCode !== null) resolve(); else writer.once('close', () => resolve()); });
      lineProcess.stdin.end('\n');
      await new Promise<void>((resolve) => { if (lineProcess.exitCode !== null) resolve(); else lineProcess.once('close', () => resolve()); });
      await rm(root, { recursive: true, force: true });
    }
  }, 60_000);

  it('verifies a version-only admitted build end to end and reports it as accepted', async () => {
    const root = await createSource(false);
    const lineProcess = spawn(path.join(root, 'LINE', 'bin', 'current', 'LINE.exe'), [], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    const writer = spawn(path.join(fixtureRoot, 'SqliteFixtureHarness.exe'), ['--snapshot-hold', root], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    try {
      await Promise.all([waitReady(lineProcess, 'line_process_not_ready'), waitReady(writer, 'fixture_writer_not_ready')]);
      const result = await runProtocolInventory(root, 'ver-new', 'fixture-own-mid', undefined, lineProcess.pid);
      expect(result.frames.map((frame) => frame.type)).toEqual(['hello', 'inventory', 'result', 'closed']);
      expect(result.frames[1]).toMatchObject({ buildCode: 'accepted', buildVersion: '26.5.0.3975' });
      expect(result.frames[2]).toMatchObject({ verdict: 'supported', buildCode: 'accepted', buildVersion: '26.5.0.3975',
        mappingCode: 'line-profile-mid-v1' });
      const wrongMid = await runProtocolInventory(root, 'ver-new', 'another-mid', 'fedcba9876543210fedcba9876543210', lineProcess.pid);
      expect(wrongMid.frames[1]).toMatchObject({ buildCode: 'accepted' });
      expect(wrongMid.frames[2]).toMatchObject({ verdict: 'unsupported', errorCode: 'official_account_not_active' });
    } finally {
      writer.stdout?.resume(); writer.stderr?.resume(); lineProcess.stdout?.resume(); lineProcess.stderr?.resume();
      writer.stdin.end('CLOSE\n');
      await new Promise<void>((resolve) => { if (writer.exitCode !== null) resolve(); else writer.once('close', () => resolve()); });
      lineProcess.stdin.end('\n');
      await new Promise<void>((resolve) => { if (lineProcess.exitCode !== null) resolve(); else lineProcess.once('close', () => resolve()); });
      await rm(root, { recursive: true, force: true });
    }
  }, 20_000);

  it('streams a retained synthetic encrypted snapshot through NEXT/PAGE/ACK, rejects replay, and cleans up on EOF', async () => {
    const root = await createSource(false);
    const lineProcess = spawn(path.join(root, 'LINE', 'bin', 'current', 'LINE.exe'), [], { stdio: ['pipe','pipe','pipe'], windowsHide: true });
    const writer = spawn(path.join(fixtureRoot, 'SqliteFixtureHarness.exe'), ['--snapshot-hold', root], { stdio: ['pipe','pipe','pipe'], windowsHide: true });
    try {
      await Promise.all([waitReady(lineProcess, 'line_process_timeout'), waitReady(writer, 'fixture_writer_timeout')]);
      const completed = await runProtocolInventory(root, 'pinnedaccept', 'fixture-own-mid', '11111111111111111111111111111111', lineProcess.pid!, undefined, 'first_import_snapshot');
      expect(completed.frames.map((frame) => frame.type)).toContain('progress');
      expect(completed.frames.find((frame) => frame.type === 'ready')).toMatchObject({ schemaVersion: 'line-profile-mid-v1', eligibleCount: '4' });
      expect(completed.frames.filter((frame) => frame.type === 'page')).toHaveLength(2);
      expect(completed.frames.filter((frame) => frame.type === 'page')[0]).toMatchObject({ pageNumber: 1, hasMore: true });
      expect(completed.frames.filter((frame) => frame.type === 'page')[1]).toMatchObject({ pageNumber: 2, hasMore: false });
      expect(completed.frames.find((frame) => frame.type === 'complete')).toMatchObject({ pageCount: 2, rowCount: 4 });
      const progress = completed.frames.filter((frame) => frame.type === 'progress');
      expect(progress.map((frame) => frame.phase)).toContain('snapshot_copy');
      expect(progress.map((frame) => frame.phase)).toContain('snapshot_hash');
      expect(progress.map((frame) => frame.phase)).not.toContain('snapshot_reread');
      expect(progress.map((frame) => frame.phase)).toContain('key_scan');
      for (const phase of ['key_scan', 'snapshot_copy', 'snapshot_hash'] as const) {
        const values = progress.filter((frame) => frame.phase === phase).map((frame) => BigInt(String(frame.bytesCopied)));
        expect(values.length, `${phase} progress`).toBeGreaterThan(0);
        expect(values.every((value, index) => index === 0 || value > values[index - 1]!)).toBe(true);
      }
      const copied = progress.filter((frame) => frame.phase === 'snapshot_copy').map((frame) => BigInt(String(frame.bytesCopied)));
      expect(copied.length).toBeGreaterThan(0);
      expect(copied.every((value, index) => index === 0 || value >= copied[index - 1]!)).toBe(true);
      const lastCopyIndex = progress.map((frame) => frame.phase).lastIndexOf('snapshot_copy');
      const firstHashIndex = progress.findIndex((frame) => frame.phase === 'snapshot_hash');
      expect(lastCopyIndex).toBeLessThan(firstHashIndex);
      expect(progress[lastCopyIndex]?.phase).toBe('snapshot_copy');
      expect(typeof progress[lastCopyIndex]?.totalBytes).toBe('string');
      expect(BigInt(String(progress[lastCopyIndex]?.bytesCopied))).toBe(BigInt(String(progress[lastCopyIndex]?.totalBytes)));
      for (const phase of ['count', 'page_read'] as const) {
        const steps = progress.filter((frame) => frame.phase === phase).map((frame) => BigInt(String(frame.scanSteps)));
        expect(steps.every((value, index) => index === 0 || value > steps[index - 1]!)).toBe(true);
      }
      expect(completed.exitCode).toBe(0);
      expect(await readdir(path.join(root, 'probe-11111111111111111111111111111111'))).toEqual(['owner.json']);

      const replay = await runProtocolInventory(root, 'pinnedaccept', 'fixture-own-mid', '22222222222222222222222222222222', lineProcess.pid!, undefined, 'first_import_snapshot', 'replay');
      expect(replay.frames.find((frame) => frame.type === 'result')).toMatchObject({ verdict: 'unsupported', errorCode: 'protocol_invalid' });
      expect(await readdir(path.join(root, 'probe-22222222222222222222222222222222'))).toEqual(['owner.json']);

      const cancelled = await runProtocolInventory(root, 'pinnedaccept', 'fixture-own-mid', '33333333333333333333333333333333', lineProcess.pid!, undefined, 'first_import_snapshot', 'cancel');
      expect(cancelled.frames.some((frame) => frame.type === 'page')).toBe(true);
      expect(cancelled.exitCode).toBe(0);
      expect(await readdir(path.join(root, 'probe-33333333333333333333333333333333'))).toEqual(['owner.json']);

      const emptied = new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('fixture_empty_timeout')), 20_000);
        writer.stdout.once('data', (data: Buffer) => { clearTimeout(timer); if (!data.toString().includes('COMMITTED')) reject(new Error('fixture_empty_not_committed')); else resolve(); });
      });
      writer.stdin.write('CLEAR_MESSAGES\n'); await emptied;
      const empty = await runProtocolInventory(root, 'pinnedaccept', 'fixture-own-mid', '44444444444444444444444444444444', lineProcess.pid!, undefined, 'first_import_snapshot');
      expect(empty.frames.find((frame) => frame.type === 'ready')).toMatchObject({ eligibleCount: '0', highWatermark: null });
      expect(empty.frames.find((frame) => frame.type === 'ready')?.sourceIdentityDigest).toBe(completed.frames.find((frame) => frame.type === 'ready')?.sourceIdentityDigest);
      expect(empty.frames.find((frame) => frame.type === 'ready')?.snapshotDigest).not.toBe(completed.frames.find((frame) => frame.type === 'ready')?.snapshotDigest);
      expect(empty.frames.find((frame) => frame.type === 'page')).toMatchObject({ rows: [], hasMore: false });
      expect(empty.frames.find((frame) => frame.type === 'complete')).toMatchObject({ pageCount: 1, rowCount: 0 });
      expect(await readdir(path.join(root, 'probe-44444444444444444444444444444444'))).toEqual(['owner.json']);
    } finally {
      writer.stdout?.resume(); writer.stderr?.resume(); lineProcess.stdout?.resume(); lineProcess.stderr?.resume();
      writer.stdin.end('CLOSE\n');
      if (lineProcess.exitCode === null && lineProcess.signalCode === null) lineProcess.kill();
      await Promise.all([waitClosed(writer), waitClosed(lineProcess)]);
      await rm(root, { recursive: true, force: true });
    }
  }, 30_000);

  it('fails a wrong account MID before publishing a fixed copy', async () => {
    const root = await createSource(false);
    const lineProcess = spawn(path.join(root, 'LINE', 'bin', 'current', 'LINE.exe'), [], { stdio: ['pipe','pipe','pipe'], windowsHide: true });
    const writer = spawn(path.join(fixtureRoot, 'SqliteFixtureHarness.exe'), ['--snapshot-hold', root], { stdio: ['pipe','pipe','pipe'], windowsHide: true });
    try {
      await Promise.all([waitReady(lineProcess, 'line_process_timeout'), waitReady(writer, 'fixture_writer_timeout')]);
      const result = await runProtocolInventory(root, 'pinnedaccept', 'fixture-other-mid',
        '55555555555555555555555555555555', lineProcess.pid, undefined, 'first_import_snapshot');
      expect(result.frames.find((frame) => frame.type === 'result')).toMatchObject({ verdict: 'unsupported', errorCode: 'official_account_not_active' });
      expect(result.frames.some((frame) => frame.type === 'ready')).toBe(false);
      expect(result.exitCode).toBe(0);
      expect(await readdir(path.join(root, 'probe-55555555555555555555555555555555'))).toEqual(['owner.json']);
    } finally {
      writer.stdin.end('CLOSE\n');
      if (lineProcess.exitCode === null && lineProcess.signalCode === null) lineProcess.kill();
      await Promise.all([waitClosed(writer), waitClosed(lineProcess)]);
      await rm(root, { recursive: true, force: true });
    }
  }, 30_000);

  it('keeps one fixed snapshot when LINE commits while the native backup is copying', async () => {
    const root = await createSource(false);
    const lineProcess = spawn(path.join(root, 'LINE', 'bin', 'current', 'LINE.exe'), [], { stdio: ['pipe','pipe','pipe'], windowsHide: true });
    const writer = spawn(path.join(fixtureRoot, 'SqliteFixtureHarness.exe'), ['--snapshot-hold', root], { stdio: ['pipe','pipe','pipe'], windowsHide: true });
    try {
      await Promise.all([waitReady(lineProcess, 'line_process_timeout'), waitReady(writer, 'fixture_writer_timeout')]);
      const result = await runProtocolInventory(root, 'pinnedaccept', 'fixture-own-mid',
        '88888888888888888888888888888888', lineProcess.pid, 'source_change_during_backup', 'first_import_snapshot');
      expect(result.frames.find((frame) => frame.type === 'ready'), `${result.diagnostics} ${JSON.stringify(result.frames)}`).toMatchObject({ eligibleCount: '4' });
      expect(result.frames.find((frame) => frame.type === 'complete')).toMatchObject({ pageCount: 2, rowCount: 4 });
      expect(result.diagnostics).toContain('TEST_BACKUP_MUTATION:1');
      expect(result.frames.filter((frame) => frame.type === 'progress' && frame.phase === 'snapshot_reread')).toHaveLength(0);
      expect(result.exitCode).toBe(0);
      await sendFixtureCommand(writer, 'REFRESH_HASHES', 'REFRESHED');
      expect(await readdir(path.join(root, 'probe-88888888888888888888888888888888'))).toEqual(['owner.json']);
    } finally {
      writer.stdin.end('CLOSE\n');
      if (lineProcess.exitCode === null && lineProcess.signalCode === null) lineProcess.kill();
      await Promise.all([waitClosed(writer), waitClosed(lineProcess)]);
      await rm(root, { recursive: true, force: true });
    }
  }, 30_000);

  it('runs native encrypted rows through readOfficialSnapshot and ACKs only after consumer settlement', async () => {
    const sourceRoot = await createSource(false);
    const requestRoot = await mkdtemp(path.join(os.tmpdir(), 'linejs-native-reader-controller-'));
    const requestId = randomUUID().replaceAll('-', '');
    const lineProcess = spawn(path.join(sourceRoot, 'LINE', 'bin', 'current', 'LINE.exe'), [], { stdio: ['pipe','pipe','pipe'], windowsHide: true });
    const writer = spawn(path.join(fixtureRoot, 'SqliteFixtureHarness.exe'), ['--snapshot-hold', sourceRoot], { stdio: ['pipe','pipe','pipe'], windowsHide: true });
    let bridgeChild: ChildProcess | undefined;
    let resourceRoot = '';
    let restoreIdleTimeout: (() => void) | undefined;
    try {
      await Promise.all([waitReady(lineProcess, 'line_process_timeout'), waitReady(writer, 'fixture_writer_timeout')]);
      resourceRoot = await makeControllerResources(fixtureRoot);
      const bridgePath = await realpath(path.join(resourceRoot, 'ExternalReaderBridge.exe'));
      const bridgeSha256 = createHash('sha256').update(await readFile(bridgePath)).digest('hex');
      const mainIdentity: OwnerProcessIdentity = { pid: 44_444, startedAt: '134000000000000044', imagePath: 'C:\\synthetic\\main.exe', imageSha256: 'a'.repeat(64) };
      let bridgeIdentity: OwnerProcessIdentity | undefined;
      const admission = new ExternalSourceProbeAdmissionGate();
      const launch = ((command: string, _args: readonly string[], options: Parameters<typeof spawn>[2]) => {
        bridgeChild = spawn(command, [requestId, sourceRoot, 'pinnedaccept', String(lineProcess.pid), 'slow_progress'], options);
        bridgeIdentity = { pid: bridgeChild.pid!, startedAt: '134000000000000077', imagePath: bridgePath, imageSha256: bridgeSha256 };
        return bridgeChild;
      }) as unknown as typeof spawn;
      const controller = new JsExternalReaderController(admission, launch);
      const order: string[] = [], observations: Record<string, unknown>[] = [], phases: string[] = [];
      const directoryRows: Array<Record<string, unknown>> = [];
      let catalogRecords = 0;
      const countSteps: bigint[] = [];
      const scanStartedAt = Date.now();
      const originalSetTimeout = globalThis.setTimeout;
      const idleTimeoutSpy = vi.spyOn(globalThis, 'setTimeout').mockImplementation(((handler: TimerHandler, timeout?: number, ...args: unknown[]) =>
        originalSetTimeout(handler, timeout === 120_000 ? 3_000 : timeout, ...args)) as typeof setTimeout);
      restoreIdleTimeout = () => idleTimeoutSpy.mockRestore();
      const completion = await controller.readOfficialSnapshot({
        bridgePath, requestRoot, requestId, expectedMid: 'fixture-own-mid', deadlineUnixMs: Date.now() + 30_000,
        mainIdentity, markerStore: new FileOwnerReadyMarkerStore(requestRoot, requestId, (directory) => ensurePrivateDirectory(directory)),
        inspectProcess: async (pid) => pid === bridgeIdentity?.pid ? bridgeIdentity : null,
        onReady: async (metadata) => { order.push('ready'); expect(metadata.eligibleCount).toBe('4'); return null; },
        onProgress: async (progress) => {
          phases.push(progress.phase);
          if (progress.phase === 'count' && progress.scanSteps) countSteps.push(BigInt(progress.scanSteps));
        },
        // The facade supplies these committers; without onCatalogPage the first import fails at catalog page 1.
        onDirectoryPage: async (page) => { directoryRows.push(...page.rows); },
        onCatalogPage: async (page) => { catalogRecords += page.rows.length; },
        onPage: async (page) => {
          order.push('consumer');
          observations.push(...page.rows);
          expect(page.rows.every((row) => row.observationId === `official-line-db:${row.nativeMessageId}`)).toBe(true);
        },
      });
      order.push('complete');
      expect(completion).toMatchObject({ pageCount: 1, rowCount: 4 });
      expect(observations).toHaveLength(4);
      expect(order).toEqual(['ready', 'consumer', 'complete']);
      expect(catalogRecords).toBeGreaterThan(0);
      // The shared fixture's _contact has no nickname column: names still arrive, nickname stays null.
      expect(directoryRows).toEqual(expect.arrayContaining([
        expect.objectContaining({ kind: 'contact', mid: 'fixture-contact', displayName: 'Fixture Contact', nickname: null }),
        expect.objectContaining({ kind: 'conversation', chatId: 'fixture-chat', chatType: 'direct' }),
        expect.objectContaining({ kind: 'conversation', chatId: 'fixture-group', chatType: 'group' }),
      ]));
      expect(directoryRows.findIndex((row) => row.kind === 'conversation')).toBeGreaterThan(directoryRows.findIndex((row) => row.kind === 'contact'));
      expect(phases).toContain('snapshot_hash');
      expect(phases).not.toContain('snapshot_reread');
      expect(countSteps.length).toBeGreaterThan(1);
      expect(countSteps.every((steps, index) => index === 0 || steps > countSteps[index - 1]!)).toBe(true);
      expect(Date.now() - scanStartedAt).toBeGreaterThan(1_000);
      expect(bridgeChild?.exitCode).toBe(0);
      expect(admission.isBusy()).toBe(false);
    } finally {
      restoreIdleTimeout?.();
      writer.stdin.end('CLOSE\n');
      lineProcess.stdin.end('\n');
      await Promise.all([waitClosed(writer), waitClosed(lineProcess)]);
      bridgeChild?.kill();
      await rm(sourceRoot, { recursive: true, force: true });
      await rm(requestRoot, { recursive: true, force: true });
      if (resourceRoot) await rm(resourceRoot, { recursive: true, force: true });
    }
  }, 60_000);

  it('accepts empty sender rows and propagates the finite code for a malformed null sender', async () => {
    const root = await createSource(false);
    const lineProcess = spawn(path.join(root, 'LINE', 'bin', 'current', 'LINE.exe'), [], { stdio: ['pipe','pipe','pipe'], windowsHide: true });
    const writer = spawn(path.join(fixtureRoot, 'SqliteFixtureHarness.exe'), ['--snapshot-hold', root], { stdio: ['pipe','pipe','pipe'], windowsHide: true });
    try {
      await Promise.all([waitReady(lineProcess, 'line_process_timeout'), waitReady(writer, 'fixture_writer_timeout')]);
      await sendFixtureCommand(writer, 'EMPTY_SENDER', 'EMPTY_SENDER_ADDED');
      await sendFixtureCommand(writer, 'NULL_SENDER', 'NULL_SENDER_ADDED');
      const result = await runProtocolInventory(root, 'pinnedaccept', 'fixture-own-mid', randomUUID().replaceAll('-', ''),
        lineProcess.pid!, undefined, 'first_import_snapshot');
      expect(result.frames.find((frame) => frame.type === 'ready')).toMatchObject({ eligibleCount: '7' });
      const resultFrame = result.frames.find((frame) => frame.type === 'result');
      expect(resultFrame, JSON.stringify(result.frames.map(({ type, errorCode, verdict }) => ({ type, errorCode, verdict })))).toMatchObject({ errorCode: 'source_row_invalid' });
      expect(JSON.stringify(resultFrame)).not.toMatch(/malformed|m-null-sender|senderId|source_io_error/);
      expect(result.exitCode).toBe(0);
    } finally {
      writer.stdin.end('CLOSE\n');
      lineProcess.stdin.end('\n');
      await Promise.all([waitClosed(writer), waitClosed(lineProcess)]);
      await rm(root, { recursive: true, force: true });
    }
  }, 45_000);

  it('reports an unsupported synthetic build with a fixed code and no inventory values', async () => {
    const root = await createSource();
    try {
      await writeFile(path.join(root, 'LINE', 'bin', 'current', 'LINE.exe'), 'unsupported synthetic build');
      const result = await runProtocolInventory(root, 'accept');
      expect(result.frames.map((frame) => frame.type)).toEqual(['hello', 'result', 'closed']);
      expect(result.frames[1]).toEqual(expect.objectContaining({ verdict: 'unsupported', errorCode: 'unsupported_build' }));
      expect(result.frames[1]).not.toHaveProperty('processId');
      expect(result.frames[2]).toMatchObject({ sourceAccessed: true });
      expect(result.exitCode).toBe(0);
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it('answers wait_change with changed=false at timeout and changed=true soon after an SHM header change', async () => {
    const root = await createSource(false);
    const lineProcess = spawn(path.join(root, 'LINE', 'bin', 'current', 'LINE.exe'), [], {
      stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true,
    });
    const writer = spawn(path.join(fixtureRoot, 'SqliteFixtureHarness.exe'), ['--snapshot-hold', root], {
      stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true,
    });
    try {
      await waitReady(lineProcess, 'line_process_timeout');
      await waitReady(writer, 'fixture_writer_timeout');
      const shmPath = path.join(root, 'LINE', 'Data', 'db', 'messages.edb-shm');
      await withIdleDirectMonitor(root, lineProcess.pid!, async (session) => {
        // Nothing changes: the answer comes at the timeout, not before.
        let started = Date.now();
        session.send('wait_change', { timeoutMs: 1000 });
        const idle = await session.next('change');
        expect(idle.frame).toMatchObject({ changed: false });
        expect(idle.at - started).toBeGreaterThanOrEqual(900);
        expect(idle.at - started).toBeLessThan(5_000);
        // One byte inside the two WAL-index header copies (bytes 0..95) changes, as a commit does.
        session.send('wait_change', { timeoutMs: 20_000 });
        await new Promise((resolve) => setTimeout(resolve, 400));
        const handle = await open(shmPath, 'r+');
        try {
          const byte = Buffer.alloc(1);
          await handle.read(byte, 0, 1, 40);
          byte[0] = byte[0]! ^ 0xff;
          started = Date.now();
          await handle.write(byte, 0, 1, 40);
        } finally { await handle.close(); }
        const changed = await session.next('change');
        expect(changed.frame).toMatchObject({ changed: true });
        expect(changed.at - started).toBeLessThan(1_500);
        // The closed input pipe ends a wait at once (the 60000 ms timeout is never reached).
        session.send('wait_change', { timeoutMs: 60_000 });
        await new Promise((resolve) => setTimeout(resolve, 300));
        const exited = new Promise<number | null>((resolve) => session.child.once('exit', (code) => resolve(code)));
        const closeStarted = Date.now();
        session.child.stdin!.end();
        await exited;
        expect(Date.now() - closeStarted).toBeLessThan(5_000);
      });
    } finally {
      writer.stdout?.resume(); writer.stderr?.resume(); lineProcess.stdout?.resume(); lineProcess.stderr?.resume();
      writer.stdin.end('CLOSE\n'); lineProcess.stdin.end();
      await waitClosed(writer); await waitClosed(lineProcess);
      await rm(root, { recursive: true, force: true });
    }
  }, 120_000);

  it('answers wait_change with changed=true at once for a commit made between two pages of one round', async () => {
    const root = await createSource(false);
    const lineProcess = spawn(path.join(root, 'LINE', 'bin', 'current', 'LINE.exe'), [], {
      stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true,
    });
    const writer = spawn(path.join(fixtureRoot, 'SqliteFixtureHarness.exe'), ['--snapshot-hold', root], {
      stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true,
    });
    try {
      await waitReady(lineProcess, 'line_process_timeout');
      await waitReady(writer, 'fixture_writer_timeout');
      let commitsBetweenPages = 0;
      await withIdleDirectMonitor(root, lineProcess.pid!, async (session) => {
        // The round had more than one page and the commit came after page 1 (the round bound) and before the last page.
        expect(commitsBetweenPages).toBe(1);
        const started = Date.now();
        session.send('wait_change', { timeoutMs: 20_000 });
        const answer = await session.next('change');
        expect(answer.frame).toMatchObject({ changed: true });
        expect(answer.at - started).toBeLessThan(1_500);
      }, async (pageNumber) => {
        if (pageNumber !== 1) return;
        await sendFixtureCommand(writer, 'GROW_NEWER', 'NEWER_COMMITTED');
        commitsBetweenPages++;
      });
    } finally {
      writer.stdout?.resume(); writer.stderr?.resume(); lineProcess.stdout?.resume(); lineProcess.stderr?.resume();
      writer.stdin.end('CLOSE\n'); lineProcess.stdin.end();
      await waitClosed(writer); await waitClosed(lineProcess);
      await rm(root, { recursive: true, force: true });
    }
  }, 120_000);

  it('ignores changes outside the writer fields: -shm bytes 96..135 and the -wal last-write time', async () => {
    const root = await createSource(false);
    const lineProcess = spawn(path.join(root, 'LINE', 'bin', 'current', 'LINE.exe'), [], {
      stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true,
    });
    const writer = spawn(path.join(fixtureRoot, 'SqliteFixtureHarness.exe'), ['--snapshot-hold', root], {
      stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true,
    });
    try {
      await waitReady(lineProcess, 'line_process_timeout');
      await waitReady(writer, 'fixture_writer_timeout');
      const database = path.join(root, 'LINE', 'Data', 'db', 'messages.edb');
      await withIdleDirectMonitor(root, lineProcess.pid!, async (session) => {
        session.send('wait_change', { timeoutMs: 1000 });
        // Reader marks and nBackfill (bytes 96..135) change, then the -wal last-write time.
        const handle = await open(database + '-shm', 'r+');
        try {
          for (const offset of [100, 120, 135]) {
            const byte = Buffer.alloc(1);
            await handle.read(byte, 0, 1, offset);
            byte[0] = byte[0]! ^ 0xff;
            await handle.write(byte, 0, 1, offset);
          }
        } finally { await handle.close(); }
        const walTime = new Date(Date.now() + 60_000);
        await utimes(database + '-wal', walTime, walTime);
        const answer = await session.next('change');
        expect(answer.frame).toMatchObject({ changed: false });
      });
    } finally {
      writer.stdout?.resume(); writer.stderr?.resume(); lineProcess.stdout?.resume(); lineProcess.stderr?.resume();
      writer.stdin.end('CLOSE\n'); lineProcess.stdin.end();
      await waitClosed(writer); await waitClosed(lineProcess);
      await rm(root, { recursive: true, force: true });
    }
  }, 120_000);

  it('opens the change-check files with full sharing: another handle can rename and delete -shm meanwhile', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'linejs-change-signal-'));
    try {
      await writeFile(path.join(directory, 'messages.edb'), Buffer.alloc(4096, 1));
      await writeFile(path.join(directory, 'messages.edb-wal'), Buffer.alloc(8192, 2));
      await writeFile(path.join(directory, 'messages.edb-shm'), Buffer.alloc(32768, 3));
      const child = spawn(inventoryBridgeHarness, ['x', directory, 'change_signal_loop', '3000'], {
        stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, shell: false,
        env: { SystemRoot: process.env.SystemRoot, TEMP: process.env.TEMP, TMP: process.env.TMP },
      });
      let output = '';
      let diagnostics = '';
      child.stderr.on('data', (chunk: Buffer) => { diagnostics += chunk.toString(); });
      const ready = new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`change_signal_loop_not_ready:${diagnostics}`)), 20_000);
        child.stdout.on('data', (chunk: Buffer) => {
          output += chunk.toString();
          if (output.includes('READY')) { clearTimeout(timer); resolve(); }
        });
      });
      const closed = new Promise<number | null>((resolve) => child.once('close', (code) => resolve(code)));
      await ready;
      const shm = path.join(directory, 'messages.edb-shm');
      // Each round renames and deletes the file that the loop opens many times per second.
      for (let round = 0; round < 15; round++) {
        await rename(shm, `${shm}.moved`);
        await writeFile(shm, Buffer.alloc(32768, round));
        await rm(`${shm}.moved`);
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      await rm(shm);
      expect(await closed, diagnostics).toBe(0);
      const match = /LOOP\|(\d+)\|(\d+)\|(\d+)/.exec(output);
      expect(match, output).not.toBeNull();
      expect(Number(match![1])).toBeGreaterThan(100);
      // The deleted file reads as unreadable (a change), never as a sharing violation (Win32 error 32).
      expect(Number(match![3])).toBe(0);
    } finally { await rm(directory, { recursive: true, force: true }); }
  }, 60_000);

  it('detects SHM mutation during direct reads of a concurrently committed WAL', async () => {
    const root = await createSource(false);
    const lineProcess = spawn(path.join(root, 'LINE', 'bin', 'current', 'LINE.exe'), [], {
      stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true,
    });
    const writer = spawn(path.join(fixtureRoot, 'SqliteFixtureHarness.exe'), ['--snapshot-hold', root], {
      stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true,
    });
    let writerSourceState: { edb: string; wal: string; shm: string } | undefined;
    try {
      await waitReady(lineProcess, 'line_process_timeout');
      await waitReady(writer, 'fixture_writer_timeout');
      const database = path.join(root, 'LINE', 'Data', 'db', 'messages.edb');
      const result = await runProtocolInventory(root, 'pinnedaccept', 'fixture-own-mid',
        '88888888888888888888888888888888', lineProcess.pid, undefined, 'direct_monitor', 'complete', async () => {
          await new Promise<void>((resolve, reject) => {
            const timeout = setTimeout(() => reject(new Error('fixture_growth_timeout')), 20_000);
            writer.stdout.once('data', (data: Buffer) => {
              clearTimeout(timeout);
              if (!data.toString().includes('COMMITTED')) reject(new Error('fixture_growth_not_committed'));
              else {
                void Promise.all([readFile(database), readFile(database + '-wal'), readFile(database + '-shm')]).then(([edb, wal, shm]) => {
                  writerSourceState = { edb: createHash('sha256').update(edb).digest('hex'), wal: createHash('sha256').update(wal).digest('hex'),
                    shm: createHash('sha256').update(shm).digest('hex') };
                  resolve();
                }, reject);
              }
            });
            writer.stdin.write('GROW\n');
          });
        }, undefined, 5);
      expect(result.frames.map((frame) => frame.type).filter((type) => type !== 'progress'))
        .toEqual(['hello', 'inventory', 'ready', 'directory_page', 'page', 'page', 'page', 'page', 'page', 'closed']);
      const ready = result.frames.find((frame) => frame.type === 'ready');
      expect(ready).toMatchObject({ schemaVersion: 'line-profile-mid-v1' });
      const pages = result.frames.filter((frame) => frame.type === 'page');
      // The recent tail is captured only once a poll proves the forward cursor drained (zero candidate rows),
      // so a round with forward rows needs a follow-up drain page that carries the tail and ends the round.
      const page = pages[0]!;
      expect(page.rows).toHaveLength(4);
      expect(page.tailRows).toHaveLength(0);
      expect(page.lastCursor).toMatchObject({ createdTime: '1000', id: 'm-10' });
      expect(page.hasMore).toBe(true);
      expect(page).not.toHaveProperty('tailWindow');
      expect(page).not.toHaveProperty('unreadCounts');
      const drainPage = pages[1]!;
      expect(drainPage.rows).toHaveLength(0);
      expect(drainPage.tailRows).toHaveLength(4);
      expect(drainPage.lastCursor).toMatchObject({ createdTime: '1000', id: 'm-10' });
      expect(drainPage.hasMore).toBe(false);
      // The final tail page carries the complete key range and every tail row id; a short tail extends to the table start.
      expect(drainPage.tailWindow).toEqual({ upper: { createdTime: '1000', id: 'm-10' }, lower: null, complete: true,
        ids: (drainPage.tailRows as Array<Record<string, unknown>>).map((row) => row.nativeMessageId) });
      // LINE's own _unreadCount rides only on the final page of the round.
      expect(drainPage.unreadCounts).toEqual({ entries: [['fixture-chat', 3], ['fixture-group', 1200]] });
      // m-11 committed after the first round's bound, so it arrives in the next round.
      const nextPage = pages[2]!;
      expect(nextPage.rows).toHaveLength(1);
      expect((nextPage.rows as Array<Record<string, unknown>>)[0]?.nativeMessageId).toBe('m-11');
      expect(nextPage.tailRows).toHaveLength(0);
      expect(nextPage.hasMore).toBe(true);
      const nextDrain = pages[3]!;
      expect(nextDrain.rows).toHaveLength(0);
      expect(nextDrain.tailRows).toHaveLength(5);
      expect(nextDrain.hasMore).toBe(false);
      expect((nextDrain.tailWindow as { ids: string[] }).ids).toHaveLength(5);
      expect(nextPage).not.toHaveProperty('tailWindow');
      expect(nextPage).not.toHaveProperty('unreadCounts');
      expect(nextDrain.unreadCounts).toEqual({ entries: [['fixture-chat', 3], ['fixture-group', 1200]] });
      expect(JSON.stringify(nextDrain.lastCursor)).toBe(JSON.stringify(nextPage.lastCursor));
      const idlePage = pages[4]!;
      expect(idlePage.rows).toHaveLength(0);
      expect(idlePage.hasMore).toBe(false);
      expect(JSON.stringify(idlePage.lastCursor)).toBe(JSON.stringify(nextPage.lastCursor));
      expect(result.exitCode).toBe(0);
      const afterReader = { edb: createHash('sha256').update(await readFile(database)).digest('hex'),
        wal: createHash('sha256').update(await readFile(database + '-wal')).digest('hex'),
        shm: createHash('sha256').update(await readFile(database + '-shm')).digest('hex') };
      expect(afterReader.edb).toBe(writerSourceState?.edb);
      expect(afterReader.wal).toBe(writerSourceState?.wal);
      expect(afterReader.shm).not.toBe(writerSourceState?.shm);
    } finally {
      writer.stdout?.resume(); writer.stderr?.resume(); lineProcess.stdout?.resume(); lineProcess.stderr?.resume();
      writer.stdin.end('CLOSE\n'); lineProcess.stdin.end();
      await waitClosed(writer); await waitClosed(lineProcess);
      await rm(root, { recursive: true, force: true });
    }
  });

  it('tolerates live WAL growth and database writes during the direct-monitor key scan', async () => {
    const root = await createSource(false);
    const lineProcess = spawn(path.join(root, 'LINE', 'bin', 'current', 'LINE.exe'), [], {
      stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true,
    });
    const writer = spawn(path.join(fixtureRoot, 'SqliteFixtureHarness.exe'), ['--snapshot-hold', root], {
      stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true,
    });
    try {
      await waitReady(lineProcess, 'line_process_timeout');
      await waitReady(writer, 'fixture_writer_timeout');
      const result = await runProtocolInventory(root, 'scanwalappend', 'fixture-own-mid',
        'abababababababababababababababab', lineProcess.pid, undefined, 'direct_monitor');
      // The harness mutates only after every pre-scan check passed, so the change is observed after the scan.
      expect(result.diagnostics).toContain('TEST_SCAN_MUTATION:scanwalappend');
      // A successful direct monitor streams pages and closes without a failure result frame.
      expect(result.frames.map((frame) => frame.type).filter((type) => type !== 'progress'), JSON.stringify(result.frames))
        .toEqual(['hello', 'inventory', 'ready', 'directory_page', 'page', 'page', 'closed']);
      expect(result.frames.find((frame) => frame.type === 'ready')).toMatchObject({ schemaVersion: 'line-profile-mid-v1' });
      expect(result.exitCode).toBe(0);
    } finally {
      writer.stdout?.resume(); writer.stderr?.resume(); lineProcess.stdout?.resume(); lineProcess.stderr?.resume();
      writer.stdin.end('CLOSE\n'); lineProcess.stdin.end();
      await waitClosed(writer); await waitClosed(lineProcess);
      await rm(root, { recursive: true, force: true });
    }
  }, 30_000);

  it.each(['scandbreplace', 'scanprocessrotate', 'scanexechashrotate'])(
    'fails closed when %s changes during the direct-monitor key scan', async (scenario) => {
      const root = await createSource(false);
      const lineProcess = spawn(path.join(root, 'LINE', 'bin', 'current', 'LINE.exe'), [], {
        stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true,
      });
      const writer = spawn(path.join(fixtureRoot, 'SqliteFixtureHarness.exe'), ['--snapshot-hold', root], {
        stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true,
      });
      try {
        await waitReady(lineProcess, 'line_process_timeout');
        await waitReady(writer, 'fixture_writer_timeout');
        const result = await runProtocolInventory(root, scenario, 'fixture-own-mid',
          randomUUID().replaceAll('-', ''), lineProcess.pid, undefined, 'direct_monitor');
        expect(result.frames.find((frame) => frame.type === 'result')).toMatchObject({
          verdict: 'unsupported', errorCode: 'source_changed',
        });
        expect(result.diagnostics).toContain(`TEST_SCAN_MUTATION:${scenario}`);
        expect(result.frames.some((frame) => frame.type === 'ready')).toBe(false);
        expect(result.exitCode).toBe(0);
      } finally {
        writer.stdout?.resume(); writer.stderr?.resume(); lineProcess.stdout?.resume(); lineProcess.stderr?.resume();
        writer.stdin.end('CLOSE\n'); lineProcess.stdin.end();
        await waitClosed(writer); await waitClosed(lineProcess);
        await rm(root, { recursive: true, force: true });
      }
    }, 30_000,
  );

  it('reads more than 100 arrivals across bounded polls, survives WAL rotation, and cancels with a busy writer', async () => {
    const root = await createSource(false);
    const lineProcess = spawn(path.join(root, 'LINE', 'bin', 'current', 'LINE.exe'), [], {
      stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true,
    });
    const writer = spawn(path.join(fixtureRoot, 'SqliteFixtureHarness.exe'), ['--snapshot-hold', root], {
      stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true,
    });
    const database = path.join(root, 'LINE', 'Data', 'db', 'messages.edb');
    const databaseDirectory = path.dirname(database);
    try {
      await waitReady(lineProcess, 'line_process_timeout');
      await waitReady(writer, 'fixture_writer_timeout');
      let afterRotation: { edb: string; wal: string } | undefined;
      const result = await runProtocolInventory(root, 'pinnedaccept', 'fixture-own-mid',
        'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', lineProcess.pid, undefined, 'direct_monitor', 'complete', async () => {
          const beforeCheckpoint = await readFile(database + '-wal');
          await sendFixtureCommand(writer, 'CHECKPOINT', 'CHECKPOINTED');
          const afterCheckpoint = await readFile(database + '-wal');
          expect(afterCheckpoint.byteLength).toBeLessThan(beforeCheckpoint.byteLength);
          await sendFixtureCommand(writer, 'GROW_MANY 150', 'GROWN 150');
          afterRotation = {
            edb: createHash('sha256').update(await readFile(database)).digest('hex'),
            wal: createHash('sha256').update(await readFile(database + '-wal')).digest('hex'),
          };
        }, undefined, 5, async (pageNumber) => {
          if (pageNumber === 2) {
            await sendFixtureCommand(writer, 'GROW_NEWER', 'NEWER_COMMITTED');
            await sendFixtureCommand(writer, 'DELETE_ID live-150', 'DELETED');
            afterRotation = {
              edb: createHash('sha256').update(await readFile(database)).digest('hex'),
              wal: createHash('sha256').update(await readFile(database + '-wal')).digest('hex'),
            };
          }
        });
      expect(result.exitCode, JSON.stringify(result.frames)).toBe(0);
      const pages = result.frames.filter((frame) => frame.type === 'page');
      expect(pages).toHaveLength(5);
      // Round 1 (bound = the original last row): forward page, then a drain page that carries the tail and ends the round.
      expect(pages[0]?.rows).toHaveLength(4);
      expect(pages[0]?.tailRows).toHaveLength(0);
      expect(pages[0]?.hasMore).toBe(true);
      expect(pages[1]?.rows).toHaveLength(0);
      expect(pages[1]?.tailRows).toHaveLength(4);
      expect(pages[1]?.hasMore).toBe(false);
      // Round 2 starts after live-001..live-150 were committed behind the WAL checkpoint and, after page 2,
      // 'round-late' was added and live-150 deleted; the bound is captured on the next poll, so both are in range
      // and the deleted row is gone.
      expect(pages[2]?.rows).toHaveLength(100);
      expect(pages[2]?.tailRows).toHaveLength(0);
      expect(pages[2]?.hasMore).toBe(true);
      expect(pages[3]?.rows).toHaveLength(50);
      const lastForwardIds = (pages[3]?.rows as Array<Record<string, unknown>>).map((row) => row.nativeMessageId);
      expect(lastForwardIds).toContain('live-149');
      expect(lastForwardIds).toContain('round-late');
      expect(lastForwardIds).not.toContain('live-150');
      expect(pages[3]?.tailRows).toHaveLength(0);
      expect(pages[3]?.hasMore).toBe(true);
      for (const index of [0, 2, 3]) expect(pages[index]).not.toHaveProperty('tailWindow');
      expect(pages[1]?.tailWindow).toMatchObject({ lower: null, complete: true });
      expect(pages[4]?.rows).toEqual([]);
      expect(pages[4]?.hasMore).toBe(false);
      expect(pages[4]?.tailRows).toHaveLength(50);
      const tailIds = (pages[4]?.tailRows as Array<Record<string, unknown>>).map((row) => row.nativeMessageId);
      expect(tailIds).toContain('live-149');
      expect(tailIds).toContain('round-late');
      expect(tailIds).not.toContain('live-150');
      // A full 50-row tail bounds the range from below by its oldest row and lists every id.
      const fullWindow = pages[4]?.tailWindow as { upper: unknown; lower: { createdTime: string; id: string } | null; complete: boolean; ids: string[] };
      expect(fullWindow.complete).toBe(true);
      expect(fullWindow.ids).toEqual(tailIds);
      expect(fullWindow.lower).toEqual({ createdTime: (pages[4]?.tailRows as Array<Record<string, unknown>>)[0]?.createdTime, id: tailIds[0] });
      expect(JSON.stringify(pages[4]?.lastCursor)).toBe(JSON.stringify(pages[3]?.lastCursor));
      expect(result.frames.some((frame) => frame.type === 'closed')).toBe(true);
      const afterReader = {
        edb: createHash('sha256').update(await readFile(database)).digest('hex'),
        wal: createHash('sha256').update(await readFile(database + '-wal')).digest('hex'),
      };
      expect(afterReader).toEqual(afterRotation);
      expect((await readdir(databaseDirectory)).sort()).toEqual(['messages.edb', 'messages.edb-shm', 'messages.edb-wal'].sort());

      await sendFixtureCommand(writer, 'BEGIN_GROWTH', 'BUSY');
      const busyState = {
        edb: createHash('sha256').update(await readFile(database)).digest('hex'),
        wal: createHash('sha256').update(await readFile(database + '-wal')).digest('hex'),
      };
      const started = Date.now();
      const cancelled = await runProtocolInventory(root, 'pinnedaccept', 'fixture-own-mid',
        'cccccccccccccccccccccccccccccccc', lineProcess.pid, undefined, 'direct_monitor', 'cancel');
      expect(Date.now() - started).toBeLessThan(5_000);
      expect(cancelled.exitCode).toBe(0);
      expect(cancelled.frames).toContainEqual(expect.objectContaining({ type: 'result', errorCode: 'cancelled' }));
      expect(cancelled.frames).toContainEqual(expect.objectContaining({ type: 'closed' }));
      expect({
        edb: createHash('sha256').update(await readFile(database)).digest('hex'),
        wal: createHash('sha256').update(await readFile(database + '-wal')).digest('hex'),
      }).toEqual(busyState);
      expect((await readdir(databaseDirectory)).sort()).toEqual(['messages.edb', 'messages.edb-shm', 'messages.edb-wal'].sort());
      await sendFixtureCommand(writer, 'COMMIT_GROWTH', 'COMMITTED');
    } finally {
      writer.stdout?.resume(); writer.stderr?.resume(); lineProcess.stdout?.resume(); lineProcess.stderr?.resume();
      writer.stdin.end('CLOSE\n'); lineProcess.stdin.end();
      await waitClosed(writer); await waitClosed(lineProcess);
      await rm(root, { recursive: true, force: true });
    }
  }, 60_000);

  it('keeps an explicitly empty round bound empty until the next round', async () => {
    const root = await createSource(false);
    const lineProcess = spawn(path.join(root, 'LINE', 'bin', 'current', 'LINE.exe'), [], {
      stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true,
    });
    const writer = spawn(path.join(fixtureRoot, 'SqliteFixtureHarness.exe'), ['--snapshot-hold', root], {
      stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true,
    });
    try {
      await waitReady(lineProcess, 'line_process_timeout');
      await waitReady(writer, 'fixture_writer_timeout');
      await sendFixtureCommand(writer, 'CLEAR_MESSAGES', 'COMMITTED');
      const result = await runProtocolInventory(root, 'pinnedaccept', 'fixture-own-mid',
        'dddddddddddddddddddddddddddddddd', lineProcess.pid, undefined, 'direct_monitor', 'complete', async () => {
          await sendFixtureCommand(writer, 'GROW_MANY 1', 'GROWN 1');
        }, undefined, 2);
      expect(result.exitCode).toBe(0);
      const pages = result.frames.filter((frame) => frame.type === 'page');
      expect(pages).toHaveLength(2);
      expect(pages[0]).toMatchObject({ rows: [], tailRows: [], lastCursor: null, hasMore: false });
      expect(pages[0]).not.toHaveProperty('tailWindow');
      expect(pages[1]?.rows).toHaveLength(1);
      expect((pages[1]?.rows as Array<Record<string, unknown>>)[0]?.nativeMessageId).toBe('live-001');
      expect(pages[1]?.lastCursor).toMatchObject({ createdTime: '1001', id: 'live-001' });
    } finally {
      writer.stdout?.resume(); writer.stderr?.resume(); lineProcess.stdout?.resume(); lineProcess.stderr?.resume();
      writer.stdin.end('CLOSE\n'); lineProcess.stdin.end();
      await waitClosed(writer); await waitClosed(lineProcess);
      await rm(root, { recursive: true, force: true });
    }
  }, 60_000);

  it('pauses direct mode before SQLite opens when WAL exists but SHM is missing', async () => {
    const root = await createSource(false);
    const lineProcess = spawn(path.join(root, 'LINE', 'bin', 'current', 'LINE.exe'), [], {
      stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true,
    });
    const writer = spawn(path.join(fixtureRoot, 'SqliteFixtureHarness.exe'), ['--snapshot-hold', root], {
      stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true,
    });
    try {
      await waitReady(lineProcess, 'line_process_timeout');
      await waitReady(writer, 'fixture_writer_timeout');
      const database = path.join(root, 'LINE', 'Data', 'db', 'messages.edb');
      const committedWal = await readFile(database + '-wal');
      writer.stdin.end('CLOSE\n');
      await waitClosed(writer);
      await writeFile(database + '-wal', committedWal);
      await rm(database + '-shm', { force: true });
      const result = await runProtocolInventory(root, 'pinnedaccept', 'fixture-own-mid',
        '99999999999999999999999999999999', lineProcess.pid, undefined, 'direct_monitor');
      expect(result.frames.map((frame) => frame.type)).toEqual(['hello', 'result', 'closed']);
      expect(result.frames[1]).toMatchObject({ verdict: 'unsupported', errorCode: 'source_shm_missing' });
      expect(await readFile(database + '-shm').then(() => true, () => false)).toBe(false);
    } finally {
      writer.stdout?.resume(); writer.stderr?.resume(); lineProcess.stdout?.resume(); lineProcess.stderr?.resume();
      writer.stdin.end('CLOSE\n'); lineProcess.stdin.end();
      await waitClosed(writer); await waitClosed(lineProcess);
      await rm(root, { recursive: true, force: true });
    }
  });

  it('runs only the newest database: identity, MID mismatch without fallback to an older admin DB, and the key error without fallback', async () => {
    const root = await createSource(false);
    const older = path.join(root, 'LINE', 'Data', 'db', 'older.edb');
    const lineProcess = spawn(path.join(root, 'LINE', 'bin', 'current', 'LINE.exe'), [], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    const writer = spawn(path.join(fixtureRoot, 'SqliteFixtureHarness.exe'), ['--snapshot-hold', root], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    try {
      await Promise.all([waitReady(lineProcess, 'line_process_not_ready'), waitReady(writer, 'fixture_writer_not_ready')]);
      // The admin's older database: a real encrypted fixture (same key, MID fixture-own-mid) left on disk, standalone.
      // If it were ever opened it would verify as the admin.
      const donorRoot = await createSource(false);
      const donor = spawn(path.join(fixtureRoot, 'SqliteFixtureHarness.exe'), ['--snapshot-hold', donorRoot], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
      try {
        await waitReady(donor, 'donor_writer_not_ready');
        donor.stdin.end('CLOSE\n');
        await waitClosed(donor);
        await copyFile(path.join(donorRoot, 'LINE', 'Data', 'db', 'messages.edb'), older);
      } finally { await rm(donorRoot, { recursive: true, force: true }); }
      await utimes(older, new Date('2020-01-01T00:00:00Z'), new Date('2020-01-01T00:00:00Z'));
      const olderBefore = createHash('sha256').update(await readFile(older)).digest('hex');
      const directory = path.join(root, 'LINE', 'Data', 'db');
      const verify = (expectedMid: string, requestId: string) =>
        runProtocolInventory(root, 'pinnedaccept', expectedMid, requestId, lineProcess.pid);

      const identity = await runProtocolInventory(root, 'pinnedaccept', '', 'a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1', lineProcess.pid,
        undefined, 'read_official_identity');
      expect(identity.frames.map((frame) => frame.type)).toEqual(['hello', 'inventory', 'result', 'closed']);
      expect(identity.frames[1]).toMatchObject({ candidateCount: 2 });
      expect(identity.frames[2]).toMatchObject({ verdict: 'supported', mid: 'fixture-own-mid', displayName: 'Fixture Profile Owner', candidateCount: 2 });
      expect(JSON.stringify(identity.frames)).not.toContain(directory);

      // Row 9: the newest database is the admin's: proceeds, no candidate_ambiguous.
      expect((await verify('fixture-own-mid', 'd4d4d4d4d4d4d4d4d4d4d4d4d4d4d4d4')).frames[2]).toMatchObject({ verdict: 'supported' });

      // Official LINE switches to a non-admin account: the newest database now has another MID.
      const acknowledged = new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error('profile_shape_timeout')), 5_000);
        writer.stdout.once('data', (data: Buffer) => {
          clearTimeout(timeout);
          if (data.toString().includes('PROFILE_SET')) resolve(); else reject(new Error('profile_shape_not_set'));
        });
      });
      writer.stdin.write('PROFILE_WRONG\n');
      await acknowledged;
      // Row 8: the active account is not the expected (admin) one -> nothing is read or imported.
      const notActive = await verify('fixture-own-mid', 'c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3');
      expect(notActive.frames.map((frame) => frame.type)).toEqual(['hello', 'inventory', 'result', 'closed']);
      expect(notActive.frames[2]).toMatchObject({ verdict: 'unsupported', errorCode: 'official_account_not_active' });
      expect(notActive.frames[2]).not.toHaveProperty('rows');
      // The older admin database is only stat'ed: it was not opened (no fallback), modified or given sidecar files.
      expect(createHash('sha256').update(await readFile(older)).digest('hex')).toBe(olderBefore);
      expect((await readdir(directory)).filter((name) => name.startsWith('older.edb')).sort()).toEqual(['older.edb']);
      // The active account is the target when asked for its own MID.
      expect((await verify('fixture-other-mid', 'e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5')).frames[2]).toMatchObject({ verdict: 'supported' });
      // Identity follows the active candidate, not the admin database.
      const switched = await runProtocolInventory(root, 'pinnedaccept', '', 'f6f6f6f6f6f6f6f6f6f6f6f6f6f6f6f6', lineProcess.pid, undefined, 'read_official_identity');
      expect(switched.frames[2]).toMatchObject({ verdict: 'supported', mid: 'fixture-other-mid', candidateCount: 2 });
      expect((await readdir(directory)).filter((name) => name.startsWith('older.edb')).sort()).toEqual(['older.edb']);

      // Row 10b: the newest file is one the memory key cannot open: the key error, never a fallback to messages.edb.
      const newest = path.join(directory, 'newest.edb');
      await writeFile(newest, randomBytes(16 * 1024));
      const future = new Date(Date.now() + 3_600_000);
      await utimes(newest, future, future);
      const noKey = await verify('fixture-other-mid', 'a9a9a9a9a9a9a9a9a9a9a9a9a9a9a9a9');
      expect(noKey.frames[2]).toMatchObject({ verdict: 'unsupported', errorCode: 'key_unavailable' });
      expect((await readdir(directory)).filter((name) => name.startsWith('newest.edb')).sort()).toEqual(['newest.edb']);
    } finally {
      writer.stdout?.resume(); writer.stderr?.resume(); lineProcess.stdout?.resume(); lineProcess.stderr?.resume();
      writer.stdin.end('CLOSE\n'); lineProcess.stdin.end();
      await waitClosed(writer); await waitClosed(lineProcess);
      await rm(root, { recursive: true, force: true });
    }
  });

  it('pins an existing SHM against deletion or rotation until the direct SQLite open settles', async () => {
    const root = await createSource(false);
    const lineProcess = spawn(path.join(root, 'LINE', 'bin', 'current', 'LINE.exe'), [], {
      stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true,
    });
    const writer = spawn(path.join(fixtureRoot, 'SqliteFixtureHarness.exe'), ['--snapshot-hold', root], {
      stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true,
    });
    try {
      await waitReady(lineProcess, 'line_process_timeout');
      await waitReady(writer, 'fixture_writer_timeout');
      const shm = path.join(root, 'LINE', 'Data', 'db', 'messages.edb-shm');
      let rotationRejected = false;
      const result = await runProtocolInventory(root, 'pinnedaccept', 'fixture-own-mid',
        'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', lineProcess.pid, 'shm_guard', 'direct_monitor', 'complete', undefined, async () => {
          try { await rm(shm); }
          catch (error) { rotationRejected = (error as NodeJS.ErrnoException).code === 'EBUSY' || (error as NodeJS.ErrnoException).code === 'EPERM'; }
        });
      expect(rotationRejected).toBe(true);
      expect(await readFile(shm).then(() => true, () => false)).toBe(true);
      expect(result.frames).toContainEqual(expect.objectContaining({ type: 'result', errorCode: 'cancelled' }));
    } finally {
      writer.stdout?.resume(); writer.stderr?.resume(); lineProcess.stdout?.resume(); lineProcess.stderr?.resume();
      writer.stdin.end('CLOSE\n'); lineProcess.stdin.end();
      await waitClosed(writer); await waitClosed(lineProcess);
      await rm(root, { recursive: true, force: true });
    }
  });

  it('rejects zero and multiple synthetic EDB candidates', async () => {
    const emptyRoot = await createSource(false);
    const multipleRoot = await createSource(true, false);
    try {
      expect(runInventory(emptyRoot, 'zero')).toBe('REJECT|candidate_missing');
      await writeFile(path.join(multipleRoot, 'LINE', 'Data', 'db', 'second.edb'), 'second');
      // Row 10: an exact last-write tie between two candidates is ambiguous.
      expect(runInventory(multipleRoot, 'multiple')).toBe('REJECT|candidate_ambiguous');
    } finally {
      await rm(emptyRoot, { recursive: true, force: true });
      await rm(multipleRoot, { recursive: true, force: true });
    }
  });

  it.each([
    ['multi-second-newer', 'second.edb'],
    ['multi-first-newer', 'messages.edb'],
    ['multi-wal-newer', 'messages.edb'], // row 10c: a -wal newer than its .edb counts, beating a newer other .edb
  ])('picks the candidate with the newest last-write time (%s), counting the -wal, by stat only', async (scenario, expected) => {
    const root = await createSource();
    try {
      await writeFile(path.join(root, 'LINE', 'Data', 'db', 'second.edb'), 'second');
      expect(runInventory(root, scenario)).toBe(`ACTIVE|${expected}|2`);
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it('rejects unsupported build identity and reparse candidates', async () => {
    const unsupportedRoot = await createSource();
    const reparseRoot = await createSource();
    try {
      await writeFile(path.join(unsupportedRoot, 'LINE', 'bin', 'current', 'LINE.exe'), 'unsupported synthetic build');
      expect(runInventory(unsupportedRoot, 'unsupported')).toBe('REJECT|unsupported_build|Untrusted|not_accepted');
      expect(runInventory(reparseRoot, 'reparse')).toBe('REJECT|source_reparse_or_type');
    } finally {
      await rm(unsupportedRoot, { recursive: true, force: true });
      await rm(reparseRoot, { recursive: true, force: true });
    }
  });

  it.each([
    // Unsigned fixture executable with a valid version: accepted, whatever the version relative to the seed.
    ['ver-new', /^PASS\|26\.5\.0\.3975\|1\|1\|1\|accepted$/],
    ['ver-old', /^PASS\|26\.4\.1\.100\|1\|1\|1\|accepted$/],
    ['ver-bad', /^REJECT\|unsupported_build\|Untrusted\|bad_version$/],
    ['ver-missing', /^REJECT\|unsupported_build\|Untrusted\|bad_version$/],
    // The fixture executable has no version resource, so the production reader reports it as missing.
    ['ver-real', /^REJECT\|unsupported_build\|Untrusted\|bad_version$/],
  ])('classifies an unknown executable build by file version only (%s)', async (scenario, expected) => {
    const root = await createSource();
    try {
      await writeFile(path.join(root, 'LINE', 'bin', 'current', 'LINE.exe'), Buffer.concat([await readFile(fixtureLineExecutable), Buffer.from('candidate')]));
      expect(runInventory(root, scenario)).toMatch(expected);
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it('rejects a reparse-point source even when the build version is valid', async () => {
    const root = await createSource();
    try {
      await writeFile(path.join(root, 'LINE', 'bin', 'current', 'LINE.exe'), Buffer.concat([await readFile(fixtureLineExecutable), Buffer.from('candidate')]));
      expect(runInventory(root, 'ver-reparse')).toBe('REJECT|source_reparse_or_type');
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it('reads a real embedded file version offline and reports a fixture without one as missing', () => {
    expect(runInventory(process.execPath, 'version')).toMatch(/^VER\|\d+\.\d+\.\d+\.\d+$/);
    expect(runInventory(fixtureLineExecutable, 'version')).toBe('VER|');
  });

  it('never reaches the process or key probe for a build with an unreadable version', async () => {
    const root = await createSource();
    try {
      const result = await runProtocolInventory(root, 'ver-bad');
      expect(result.frames.map((frame) => frame.type)).toEqual(['hello', 'result', 'closed']);
      expect(result.frames[1]).toMatchObject({ verdict: 'unsupported', buildCode: 'unsupported', errorCode: 'unsupported_build', buildReason: 'bad_version' });
      expect(result.frames[1]).not.toHaveProperty('signerThumbprint');
      expect(JSON.stringify(result.frames)).not.toMatch(/LINE\.exe|[A-Za-z]:\\/);
      expect(result.exitCode).toBe(0);
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it('admits a version-only build and an init-trusted build without touching rejected paths', async () => {
    const root = await createSource();
    try {
      const executable = path.join(root, 'LINE', 'bin', 'current', 'LINE.exe');
      const bytes = Buffer.concat([await readFile(fixtureLineExecutable), Buffer.from('promoted')]);
      await writeFile(executable, bytes);
      const candidate = await runProtocolInventory(root, 'ver-new');
      expect(candidate.frames.map((frame) => frame.type)).toEqual(['hello', 'inventory', 'result', 'closed']);
      expect(candidate.frames[1]).toMatchObject({ buildCode: 'accepted', buildVersion: '26.5.0.3975', buildBytes: bytes.byteLength,
        buildSha256: createHash('sha256').update(bytes).digest('hex') });
      const trusted = await runProtocolInventory(root, 'accept', 'synthetic-mid', 'bbcdef0123456789abcdef0123456789', 0, undefined,
        'verify_official_source', 'complete', undefined, undefined, 2, undefined, { trust: {
          accepted: [{ version: '26.5.0.3975', bytes: bytes.byteLength, sha256: createHash('sha256').update(bytes).digest('hex') }],
          pinned: [] } });
      expect(trusted.frames[1]).toMatchObject({ buildCode: 'accepted', buildVersion: '26.5.0.3975' });
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it.each([
    ['not an object', 'nope'],
    ['extra key', { accepted: [], pinned: [], extra: 1 }],
    ['bad sha', { accepted: [{ version: '26.5.0.1', bytes: 10, sha256: 'ABC' }], pinned: [] }],
    ['bad version', { accepted: [{ version: 'x', bytes: 10, sha256: 'a'.repeat(64) }], pinned: [] }],
    ['bad thumbprint', { accepted: [], pinned: ['not-a-thumbprint'] }],
    ['too many builds', { accepted: Array.from({ length: 65 }, (_, i) => ({ version: `26.5.0.${i}`, bytes: 10 + i, sha256: i.toString(16).padStart(64, '0') })), pinned: [] }],
    ['too many pins', { accepted: [], pinned: Array.from({ length: 9 }, (_, i) => i.toString(16).toUpperCase().padStart(40, '0')) }],
  ])('fails closed on malformed init trust (%s)', async (_name, trust) => {
    const root = await createSource();
    try {
      const result = await runProtocolInventory(root, 'pinnedaccept', 'synthetic-mid', 'cbcdef0123456789abcdef0123456789', 0, undefined,
        'verify_official_source', 'complete', undefined, undefined, 2, undefined, { trust });
      expect(result.frames.map((frame) => frame.type)).toEqual(['hello', 'result', 'closed']);
      expect(result.frames[1]).toMatchObject({ verdict: 'unsupported', errorCode: 'protocol_invalid' });
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it('rejects missing and ambiguous injected process identities', async () => {
    const root = await createSource();
    try {
      expect(runInventory(root, 'processzero')).toBe('REJECT|process_missing');
      expect(runInventory(root, 'processmultiple')).toBe('REJECT|process_ambiguous');
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it('never treats a WAL created, deleted or replaced during one pass as a source change', async () => {
    const created = await createSource(true, false);
    const deleted = await createSource();
    const replaced = await createSource();
    try {
      const createdWal = path.join(created, 'LINE', 'Data', 'db', 'messages.edb-wal');
      const deletedWal = path.join(deleted, 'LINE', 'Data', 'db', 'messages.edb-wal');
      const replacedWal = path.join(replaced, 'LINE', 'Data', 'db', 'messages.edb-wal');
      await expect(readFile(createdWal)).rejects.toMatchObject({ code: 'ENOENT' });
      await Promise.all([deletedWal, replacedWal].map((wal) => writeFile(wal, Buffer.from([1, 2, 3, 4]))));
      expect(runInventory(created, 'walcreate')).toBe('PASS|26.4.2.3957|1|1|1|accepted');
      expect(runInventory(deleted, 'waldelete')).toBe('PASS|26.4.2.3957|1|0|1|accepted');
      expect(runInventory(replaced, 'walreplace')).toBe('PASS|26.4.2.3957|1|1|1|accepted');
    } finally {
      await rm(created, { recursive: true, force: true });
      await rm(deleted, { recursive: true, force: true });
      await rm(replaced, { recursive: true, force: true });
    }
  });

  it('accepts a stable absent WAL and reports a zero size', async () => {
    const root = await createSource(true, false);
    try {
      await expect(readFile(path.join(root, 'LINE', 'Data', 'db', 'messages.edb-wal'))).rejects.toMatchObject({ code: 'ENOENT' });
      expect(runInventory(root, 'accept')).toBe('PASS|26.4.2.3957|1|0|1|accepted');
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it('rejects a process whose image path differs and a process identity that changes during inventory', async () => {
    const wrongImage = await createSource();
    const rotatedProcess = await createSource();
    try {
      expect(runInventory(wrongImage, 'processwrongimage')).toBe('REJECT|process_missing');
      expect(runInventory(rotatedProcess, 'processrotate')).toBe('REJECT|source_changed');
    } finally {
      await rm(wrongImage, { recursive: true, force: true });
      await rm(rotatedProcess, { recursive: true, force: true });
    }
  });

  it('rejects a candidate replaced after initial source inventory', async () => {
    const root = await createSource();
    try { expect(runInventory(root, 'replace')).toBe('REJECT|source_changed'); }
    finally { await rm(root, { recursive: true, force: true }); }
  });
});

async function createSource(withDatabase = true, withWal = true): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'linejs-source-inventory-case-'));
  const lineDirectory = path.join(root, 'LINE');
  const executable = path.join(lineDirectory, 'bin', 'current', 'LINE.exe');
  const databaseDirectory = path.join(lineDirectory, 'Data', 'db');
  await mkdir(path.dirname(executable), { recursive: true });
  await mkdir(databaseDirectory, { recursive: true });
  await copyFile(fixtureLineExecutable, executable);
  if (withDatabase) {
    await writeFile(path.join(databaseDirectory, 'messages.edb'), 'synthetic-edb');
    if (withWal) await writeFile(path.join(databaseDirectory, 'messages.edb-wal'), 'synthetic-wal');
  }
  return root;
}

async function makeControllerResources(fixtureDirectory: string): Promise<string> {
  buildDesktopScript(desktopRoot, 'build-js-external-reader.mjs');
  const resourceRoot = await mkdtemp(path.join(os.tmpdir(), 'linejs-reader-controller-resources-'));
  const sources: Record<string, string> = {
    'ExternalReaderBridge.exe': path.join(fixtureDirectory, 'OfficialSourceInventoryBridgeHarness.exe'),
    'controller.mjs': path.join(desktopRoot, 'dist', 'js-external-reader', 'v1', 'controller.mjs'),
    'sqlite3mc_x64.dll': path.join(fixtureDirectory, 'sqlite3mc_x64.dll'),
  };
  const files: Record<string, { bytes: number; sha256: string }> = {};
  for (const [name, source] of Object.entries(sources)) {
    const bytes = await readFile(source);
    await writeFile(path.join(resourceRoot, name), bytes);
    files[name] = { bytes: bytes.byteLength, sha256: createHash('sha256').update(bytes).digest('hex') };
  }
  await writeFile(path.join(resourceRoot, 'manifest.json'), JSON.stringify({
    schemaVersion: 1, candidateVersion: 'v1', capability: 'readonly_source_verify_candidate', files,
  }));
  return resourceRoot;
}

async function ensurePrivateDirectory(directory: string): Promise<void> {
  const quoted = `'${directory.replaceAll("'", "''")}'`;
  const script = `$ErrorActionPreference='Stop'; $path=${quoted}; $sid=[System.Security.Principal.WindowsIdentity]::GetCurrent().User; ` +
    `$system=New-Object System.Security.Principal.SecurityIdentifier('S-1-5-18'); ` +
    `$acl=New-Object System.Security.AccessControl.DirectorySecurity; $acl.SetOwner($sid); $acl.SetAccessRuleProtection($true,$false); ` +
    `$inherit=[System.Security.AccessControl.InheritanceFlags]'ContainerInherit,ObjectInherit'; ` +
    `$acl.AddAccessRule((New-Object System.Security.AccessControl.FileSystemAccessRule($sid,'FullControl',$inherit,'None','Allow'))); ` +
    `$acl.AddAccessRule((New-Object System.Security.AccessControl.FileSystemAccessRule($system,'FullControl',$inherit,'None','Allow'))); ` +
    `Set-Acl -LiteralPath $path -AclObject $acl; $actual=Get-Acl -LiteralPath $path; ` +
    `if (!$actual.AreAccessRulesProtected -or $actual.Access.Count -ne 2) { throw 'private_directory_acl_invalid' }; 'private'`;
  const result = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
    encoding: 'utf8', windowsHide: true, timeout: 10_000, maxBuffer: 16 * 1024,
  }).trim();
  if (result !== 'private') throw new Error('owner_directory_not_private');
}

function runInventory(root: string, scenario: string): string {
  const result = spawnSync(inventoryHarness, [root, scenario], { encoding: 'utf8', windowsHide: true, timeout: 10_000, maxBuffer: 16 * 1024 });
  if (result.error) throw result.error;
  expect(result.status, result.stderr).toBe(0);
  return result.stdout.trim();
}

async function runProtocolInventory(root: string, scenario: string, expectedMid = 'synthetic-mid',
  requestId = 'abcdef0123456789abcdef0123456789', realProcessId = 0, pauseStage?: string,
  operation: 'verify_official_source' | 'first_import_snapshot' | 'direct_monitor' | 'read_official_identity' = 'verify_official_source', streamMode: 'complete' | 'cancel' | 'replay' = 'complete',
  onDirectPage?: () => Promise<void>, onPauseStage?: () => Promise<void>, directPollCount = 2,
  onDirectPoll?: (pageNumber: number, page: Record<string, unknown>) => Promise<void>, initExtra: { trust?: unknown } = {}):
  Promise<{ frames: Record<string, unknown>[]; exitCode: number | null; diagnostics: string }> {
  const requestDirectory = path.join(root, `probe-${requestId}`);
  await mkdir(requestDirectory);
  const child = spawn(inventoryBridgeHarness, realProcessId > 0
    ? [requestId, root, scenario, String(realProcessId), ...(pauseStage ? [pauseStage] : [])]
    : [requestId, root, scenario], {
    stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, shell: false,
    cwd: requestDirectory,
    env: { SystemRoot: process.env.SystemRoot, TEMP: process.env.TEMP, TMP: process.env.TMP },
  });
  const decoder = new FrameDecoder(FRAME_LIMITS.pageBytes);
  const reachedStage = pauseStage && ['scan', 'query', 'shm_guard'].includes(pauseStage) ? new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(`stage_timeout:${pauseStage}`)), 20_000);
    child.stderr.on('data', (data: Buffer) => {
      if (!data.toString().includes(`TEST_STAGE:${pauseStage}`)) return;
      clearTimeout(timeout); resolve();
    });
  }) : null;
  const frames: Record<string, unknown>[] = [];
  let diagnostics = '';
  child.stderr.on('data', (chunk: Buffer) => { diagnostics += chunk.toString(); });
  const waiters: Array<{ count: number; resolve: () => void; reject: (error: Error) => void }> = [];
  child.stdout.on('data', (chunk: Buffer) => {
    frames.push(...decoder.push(chunk));
    for (const waiter of [...waiters]) {
      if (frames.length < waiter.count) continue;
      waiters.splice(waiters.indexOf(waiter), 1);
      waiter.resolve();
    }
  });
  const closed = new Promise<void>((resolve, reject) => {
    child.once('close', (code, signal) => {
      if (waiters.length) {
        const error = new Error(`inventory_bridge_closed_before_frames:${code ?? signal ?? 'unknown'}`);
        for (const waiter of waiters.splice(0)) waiter.reject(error);
      }
      resolve();
    });
    child.once('error', reject);
  });
  const waitFor = async (count: number) => {
    if (frames.length >= count) return;
    const until = Date.now() + 20_000;
    await new Promise<void>((resolve, reject) => {
      const waiter = { count, resolve: () => { clearTimeout(timer); resolve(); }, reject: (error: Error) => { clearTimeout(timer); reject(error); } };
      const timer = setTimeout(() => {
        const index = waiters.indexOf(waiter); if (index >= 0) waiters.splice(index, 1);
        reject(new Error(`inventory_bridge_frame_timeout:${JSON.stringify(frames)}`));
      }, until - Date.now());
      waiters.push(waiter);
      if (frames.length >= count) {
        waiters.splice(waiters.indexOf(waiter), 1);
        waiter.resolve();
      }
    });
  };
  const waitType = async (type: string, fromIndex = 0) => {
    const until = Date.now() + 10_000;
    while (!frames.slice(fromIndex).some((frame) => frame.type === type)) {
      if (Date.now() >= until) throw new Error(`inventory_bridge_type_timeout:${type}:${JSON.stringify(frames)}`);
      await waitFor(frames.length + 1);
    }
  };
  // Direct monitoring either becomes ready or fails closed with a result frame after inventory (for example a
  // source change during the key scan). Returns true when ready; a result leaves the bridge to close by itself.
  const waitDirectReadyOrResult = async () => {
    const isOutcome = (frame: Record<string, unknown>) => frame.type === 'ready' || frame.type === 'result';
    const until = Date.now() + 10_000;
    while (!frames.slice(2).some(isOutcome)) {
      if (Date.now() >= until) throw new Error(`inventory_bridge_type_timeout:ready_or_result:${JSON.stringify(frames)}`);
      await waitFor(frames.length + 1);
    }
    return frames.slice(2).find(isOutcome)!.type === 'ready';
  };
  // Load-tolerant request deadline: the bridge closes the request at this absolute time, which a busy machine can reach
  // before the first frame arrives. No test here asserts the deadline itself.
  const deadlineUnixMs = Date.now() + 30_000;
  try {
    await writeFile(path.join(requestDirectory, 'owner.json'), JSON.stringify({
      phase: 'owned', requestId, childPid: child.pid, deadlineUnixMs,
    }));
    await waitFor(1);
    child.stdin.write(encodeFrame({ version: 1, requestId, sequence: 1, type: 'init', operation,
      ...(operation === 'read_official_identity' ? {} : { expectedMid }), deadlineUnixMs, ...initExtra }, 16 * 1024));
    expect(frames.map((frame) => frame.type)).toEqual(['hello']);
    expect(child.exitCode).toBeNull();
    child.stdin.write(encodeFrame({ version: 1, requestId, sequence: 2, type: 'owner_ready' }, FRAME_LIMITS.controlBytes));
    await waitFor(2);
    if (frames[1]?.type === 'inventory') {
      child.stdin.write(encodeFrame({ version: 1, requestId, sequence: 3, type: 'verify',
        workDeadlineUnixMs: operation === 'direct_monitor' ? deadlineUnixMs + 60_000 : deadlineUnixMs,
        ...(operation === 'direct_monitor' ? { sourceIdentityDigest: frames[1]!.sourceIdentityDigest, cursor: null } : {}) }, FRAME_LIMITS.controlBytes));
      if (reachedStage) { await reachedStage; await onPauseStage?.(); child.stdin.end(); }
      if (operation === 'first_import_snapshot' && !reachedStage) {
        await Promise.race([waitType('ready', frames.length), waitType('result', frames.length)]);
        if (frames.some((frame) => frame.type === 'result')) {
          child.stdin.end();
        } else {
        let inSeq = 4, pageNo = 1, cursor: unknown = null, totalRows = 0;
        for (const prefix of ['directory', 'catalog'] as const) {
          for (let number = 1; ; number++) {
            const start = frames.length;
            child.stdin.write(encodeFrame({ version: 1, requestId, sequence: inSeq++, type: `${prefix}_next`, pageNumber: number }, FRAME_LIMITS.controlBytes));
            await waitType(`${prefix}_page`, start);
            const sidePage = frames.slice(start).find((frame) => frame.type === `${prefix}_page`)!;
            child.stdin.write(encodeFrame({ version: 1, requestId, sequence: inSeq++, type: `${prefix}_ack`, pageNumber: number,
              batchDigest: sidePage.batchDigest }, FRAME_LIMITS.controlBytes));
            if (sidePage.hasMore !== true) break;
          }
        }
        for (;;) {
          child.stdin.write(encodeFrame({ version: 1, requestId, sequence: inSeq++, type: 'next', pageNumber: pageNo, limitRows: 2, cursor }, FRAME_LIMITS.controlBytes));
          const pageStart = frames.length;
          await Promise.race([waitType('page', pageStart), waitType('result', pageStart)]);
          if (frames.slice(pageStart).some((frame) => frame.type === 'result')) { child.stdin.end(); break; }
          const page = frames.slice(pageStart).find((frame) => frame.type === 'page')!;
          totalRows += Array.isArray(page.rows) ? page.rows.length : 0;
          if (streamMode === 'cancel') { child.stdin.end(); break; }
          child.stdin.write(encodeFrame({ version: 1, requestId, sequence: inSeq++, type: 'ack', pageNumber: pageNo, batchDigest: page.batchDigest, lastCursor: page.lastCursor }, FRAME_LIMITS.controlBytes));
          if (streamMode === 'replay' && pageNo === 1) {
            child.stdin.write(encodeFrame({ version: 1, requestId, sequence: inSeq++, type: 'next', pageNumber: 1, limitRows: 2, cursor: page.lastCursor }, FRAME_LIMITS.controlBytes));
            await waitType('result', frames.length); child.stdin.end(); break;
          }
          if (page.hasMore !== true) {
            child.stdin.write(encodeFrame({ version: 1, requestId, sequence: inSeq++, type: 'done', pageCount: pageNo, rowCount: totalRows }, FRAME_LIMITS.controlBytes));
            await waitType('complete', frames.length); child.stdin.end(); break;
          }
          cursor = page.lastCursor; pageNo++;
        }
        }
      } else if (operation === 'direct_monitor' && frames[1]?.type === 'inventory' && !reachedStage &&
          await waitDirectReadyOrResult()) {
        let sequence = 4;
        let cursor: unknown = null;
        for (let number = 1; ; number++) {
          const start = frames.length;
          child.stdin.write(encodeFrame({ version: 1, requestId, sequence: sequence++, type: 'directory_next', pageNumber: number }, FRAME_LIMITS.controlBytes));
          await waitType('directory_page', start);
          const directory = frames.slice(start).find((frame) => frame.type === 'directory_page')!;
          child.stdin.write(encodeFrame({ version: 1, requestId, sequence: sequence++, type: 'directory_ack', pageNumber: number,
            batchDigest: directory.batchDigest }, FRAME_LIMITS.controlBytes));
          if (directory.hasMore !== true) break;
        }
        let closeStart = frames.length;
        for (let pageNumber = 1; pageNumber <= directPollCount; pageNumber++) {
          const pageStart = frames.length;
          child.stdin.write(encodeFrame({ version: 1, requestId, sequence: sequence++, type: 'poll', pageNumber, cursor }, FRAME_LIMITS.controlBytes));
          await waitType('page', pageStart);
          const page = frames.slice(pageStart).find((frame) => frame.type === 'page')!;
          if (pageNumber === 1) await onDirectPage?.();
          await onDirectPoll?.(pageNumber, page);
          if (streamMode === 'cancel') { closeStart = frames.length; child.stdin.end(); break; }
          child.stdin.write(encodeFrame({ version: 1, requestId, sequence: sequence++, type: 'ack', pageNumber,
            batchDigest: page.batchDigest, lastCursor: page.lastCursor }, FRAME_LIMITS.controlBytes));
          cursor = page.lastCursor;
        }
        if (streamMode !== 'cancel') {
          closeStart = frames.length;
          child.stdin.write(encodeFrame({ version: 1, requestId, sequence: sequence++, type: 'close', reason: 'monitor_stop' }, FRAME_LIMITS.controlBytes));
        }
        child.stdin.end();
        await waitType('closed', closeStart);
      } else await waitFor(3);
    }
    const expectedAfterClose = frames[1]?.type === 'inventory' ? (operation === 'direct_monitor' ? 5 : 4) : 3;
    // Stages that pause the bridge close stdin themselves once reached; every other verify run (including
    // failure-injection stages such as query_fail) must close stdin so the bridge sees EOF immediately.
    if (!reachedStage && operation !== 'first_import_snapshot' && operation !== 'direct_monitor') child.stdin.end();
    if (operation === 'first_import_snapshot') await waitType('closed');
    else if (operation === 'direct_monitor') {
      if (frames[1]?.type !== 'inventory' || !frames.some((frame) => frame.type === 'ready')) child.stdin.end();
      await waitType('closed');
    }
    else await waitFor(expectedAfterClose);
    await closed;
    return { frames, exitCode: child.exitCode, diagnostics };
  } finally {
    child.stdin.end();
    if (child.exitCode === null && child.signalCode === null) child.kill();
  }
}

// Starts a direct-monitor bridge session on the fixture source, reads every page until the first one with
// hasMore=false, and hands control to body at that point (the bridge is idle, as after an acknowledged page).
async function withIdleDirectMonitor(root: string, realProcessId: number, body: (session: {
  child: ChildProcess;
  send(type: string, fields?: Record<string, unknown>): void;
  next(type: string): Promise<{ frame: Record<string, unknown>; at: number }>;
}) => Promise<void>, afterAck?: (pageNumber: number) => Promise<void>): Promise<void> {
  const requestId = 'cdef0123456789abcdef012345678901';
  const requestDirectory = path.join(root, `probe-${requestId}`);
  await mkdir(requestDirectory);
  const child = spawn(inventoryBridgeHarness, [requestId, root, 'pinnedaccept', String(realProcessId)], {
    stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, shell: false, cwd: requestDirectory,
    env: { SystemRoot: process.env.SystemRoot, TEMP: process.env.TEMP, TMP: process.env.TMP },
  });
  const decoder = new FrameDecoder(FRAME_LIMITS.pageBytes);
  const frames: Array<{ frame: Record<string, unknown>; at: number }> = [];
  let consumed = 0;
  let diagnostics = '';
  child.stderr.on('data', (chunk: Buffer) => { diagnostics += chunk.toString(); });
  child.stdout.on('data', (chunk: Buffer) => { for (const frame of decoder.push(chunk)) frames.push({ frame, at: Date.now() }); });
  let sequence = 1;
  const send = (type: string, fields: Record<string, unknown> = {}) => {
    child.stdin.write(encodeFrame({ version: 1, requestId, sequence: sequence++, type, ...fields }, FRAME_LIMITS.controlBytes));
  };
  const next = async (type: string) => {
    const until = Date.now() + 20_000;
    for (;;) {
      while (consumed < frames.length) {
        const item = frames[consumed++]!;
        if (item.frame.type === type) return item;
        if (item.frame.type === 'result') throw new Error(`bridge_result:${JSON.stringify(item.frame)}:${diagnostics}`);
      }
      if (Date.now() >= until) throw new Error(`bridge_frame_timeout:${type}:${JSON.stringify(frames.map((item) => item.frame.type))}:${diagnostics}`);
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  };
  const deadlineUnixMs = Date.now() + 120_000;
  try {
    await writeFile(path.join(requestDirectory, 'owner.json'), JSON.stringify({ phase: 'owned', requestId, childPid: child.pid, deadlineUnixMs }));
    await next('hello');
    send('init', { operation: 'direct_monitor', expectedMid: 'fixture-own-mid', deadlineUnixMs });
    send('owner_ready');
    const inventory = (await next('inventory')).frame;
    send('verify', { workDeadlineUnixMs: deadlineUnixMs + 60_000, sourceIdentityDigest: inventory.sourceIdentityDigest, cursor: null });
    await next('ready');
    for (let number = 1; ; number++) {
      send('directory_next', { pageNumber: number });
      const directory = (await next('directory_page')).frame;
      send('directory_ack', { pageNumber: number, batchDigest: directory.batchDigest });
      if (directory.hasMore !== true) break;
    }
    let cursor: unknown = null;
    for (let number = 1; ; number++) {
      send('poll', { pageNumber: number, cursor });
      const page = (await next('page')).frame;
      send('ack', { pageNumber: number, batchDigest: page.batchDigest, lastCursor: page.lastCursor });
      cursor = page.lastCursor;
      if (page.hasMore !== true) break;
      // The bridge reads the next page only after the next poll, so a hook here runs between two pages of one round.
      if (afterAck) await afterAck(number);
    }
    await body({ child, send, next });
  } finally {
    child.stdin.end();
    if (child.exitCode === null && child.signalCode === null) child.kill();
  }
}

function waitReady(child: ChildProcess, errorCode: string): Promise<void> {
  return new Promise((resolve,reject)=>{
    const timer=setTimeout(()=>reject(new Error(errorCode)),30_000);
    let output='', diagnostics='';
    child.once('error',error=>{clearTimeout(timer);reject(error);});
    child.once('exit',(code)=>{if(!output.includes('READY')){clearTimeout(timer);reject(new Error(`${errorCode}:exit=${code}:stderr=${diagnostics}`));}});
    child.stderr?.on('data',(data:Buffer)=>{diagnostics+=data.toString();});
    child.stdout?.on('data',(data:Buffer)=>{output+=data.toString();if(output.includes('READY')){clearTimeout(timer);resolve();}});
  });
}
function sendFixtureCommand(child: ChildProcess, command: string, expected: string): Promise<void> {
  return new Promise((resolve, reject) => {
    if (!child.stdin || !child.stdout) { reject(new Error('fixture_stdio_unavailable')); return; }
    let output = '';
    const timeout = setTimeout(() => { child.stdout!.off('data', onData); reject(new Error(`fixture_command_timeout:${command}:${output}`)); }, 20_000);
    const onData = (chunk: Buffer) => {
      output += chunk.toString('utf8');
      if (!output.includes(expected)) return;
      clearTimeout(timeout); child.stdout!.off('data', onData); resolve();
    };
    child.stdout.on('data', onData);
    child.stdin.write(command + '\n');
  });
}
function waitClosed(child: ChildProcess): Promise<void> {
  if(child.exitCode!==null || child.signalCode!==null) return Promise.resolve();
  return new Promise((resolve,reject)=>{
    const timer=setTimeout(()=>{ child.kill(); reject(new Error('fixture_process_exit_timeout')); },20_000);
    child.once('exit',()=>{clearTimeout(timer);resolve();}); child.once('error',error=>{clearTimeout(timer);reject(error);});
  });
}
