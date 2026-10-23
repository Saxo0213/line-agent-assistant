import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { copyFile, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { FRAME_LIMITS, encodeFrame, FrameDecoder } from './protocol.js';
import { FrameStream, JsExternalReaderController } from './controller.js';
import { ExternalSourceProbeAdmissionGate } from '../external-source-probe-admission.js';
import { AccountRepository, ExternalMonitorRepository, type ExternalObservation } from '@line-agent/database';
import { createTestDatabase } from '../../../../../../packages/database/src/test-database.js';

const desktopRoot = path.resolve(fileURLToPath(new URL('../../../../', import.meta.url)));
let fixtureRoot = '';
let fixturePath = '';
const watchdogBridgeName = 'ExternalReaderBridgeWatchdogTest.exe';
let decodedNativeFixtureRows: string[] = [];

describe('native SQLite3MC reader on generated fixture data', () => {
  beforeAll(async () => {
    fixtureRoot = await mkdtemp(path.join(os.tmpdir(), 'linejs-reader-fixture-'));
    const output = execFileSync(process.execPath, [path.join(desktopRoot, 'scripts', 'build-js-external-reader-fixtures.mjs'), fixtureRoot], { encoding: 'utf8' });
    fixturePath = output.trim();
  });

  afterAll(async () => { if (fixtureRoot) await rm(fixtureRoot, { recursive: true, force: true }); });

  it('fails closed on duplicate native message IDs and unknown midType group membership', () => {
    // The --keyset harness grew in 8e454d3/44a0c0a (large aggregate rows, 60,537-row window refill) and now needs about
    // 60 s of fixture writing on its own; the original 15 s budget only fit the pre-growth harness. Assertions are
    // unchanged: the harness must exit 0 and print PASS.
    const result = spawnSync(fixturePath, ['--keyset'], { encoding: 'utf8', windowsHide: true, timeout: 240_000 });
    expect(result.status, result.stderr).toBe(0);
    // The harness also reports its native 1,000-row source timing before the final verdict line.
    expect(result.stdout.trim()).toMatch(/^(NATIVE_SOURCE_1000_ROWS_MS=\d+\r?\n)?PASS$/);
  }, 270_000);

  it('splits normal and initial page prefixes without dropping optional mention ranges', () => {
    const harness = path.join(fixtureRoot, 'ExternalReaderBridgePageBudgetHarness.exe');
    const result = spawnSync(harness, [], { encoding: 'utf8', windowsHide: true, timeout: 15_000 });
    expect(result.error).toBeUndefined();
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout.trim()).toBe('PASS');
  }, 30_000);

  it('opens the encrypted WAL fixture read-only and leaves EDB/WAL bytes unchanged', () => {
    const run = spawnSync(fixturePath, [], { encoding: 'utf8', windowsHide: true });
    expect(run.error).toBeUndefined();
    expect(run.status, run.stderr).toBe(0);
    expect(run.stdout.trim()).toBe('PASS');
  });

  it('backs up one encrypted fixed view while a concurrent writer commits', () => {
    const harness = path.join(fixtureRoot, 'FixedBackupFixtureHarness.exe');
    const run = spawnSync(harness, [], { encoding: 'utf8', windowsHide: true, timeout: 30_000 });
    expect(run.error).toBeUndefined();
    expect(run.status, run.stderr).toBe(0);
    expect(run.stdout.trim()).toMatch(/^PASS\|replacement=blocked\|progressUpdates=\d+\|sourceRows=5\|snapshotRows=4\|cancel=unknown-preserved\|limit=clean\|busy=bounded\|locked=bounded$/);
  }, 40_000);

  it('records bounded native SQLite3MC WAL compatibility diagnostics', async () => {
    const matrixRoot = await mkdtemp(path.join(os.tmpdir(), 'linejs-reader-wal-matrix-'));
    const database = path.join(matrixRoot, 'LINE', 'Data', 'db', 'messages.edb');
    const wal = database + '-wal';
    const shm = database + '-shm';
    const writer = spawn(fixturePath, ['--hold', matrixRoot], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    let writerOutput = '';
    writer.stdout.on('data', (chunk: Buffer) => { writerOutput += chunk.toString('utf8'); });
    writer.stderr.on('data', (chunk: Buffer) => { writerOutput += chunk.toString('utf8').slice(0, 1024); });
    const matrix: Record<string, unknown>[] = [];
    try {
      await expectOutputLine(writer.stdout, 'READY', 5_000);
      matrix.push(await runNativeFixtureDiagnostic('zeroed_candidate_key_repro', database, wal, shm, true));
      matrix.push(await runNativeFixtureDiagnostic('writer_open_no_commit', database, wal, shm));
      await sendWriterCommand(writer, 'BEGIN_GROWTH', 'BUSY');
      matrix.push(await runNativeFixtureDiagnostic('writer_busy_uncommitted', database, wal, shm));
      await sendWriterCommand(writer, 'COMMIT_GROWTH', 'COMMITTED');
      matrix.push(await runNativeFixtureDiagnostic('writer_open_after_commit', database, wal, shm));
      await sendWriterCommand(writer, 'CLOSE', 'CLOSING');
      await closesWithin(writer, 5_000);
      expect(writer.exitCode).toBe(0);
      matrix.push(await runNativeFixtureDiagnostic('writer_closed', database, wal, shm));

      const missingRoot = path.join(matrixRoot, 'missing-shm');
      await mkdir(missingRoot, { recursive: true });
      const missingDatabase = path.join(missingRoot, 'messages.edb');
      await copyFile(database, missingDatabase);
      if (existsSync(wal)) await copyFile(wal, missingDatabase + '-wal');
      const missingShm = missingDatabase + '-shm';
      const missing = await runNativeFixtureDiagnostic('missing_shm', missingDatabase, missingDatabase + '-wal', missingShm);
      expect(missing.shmExistedBeforeNative).toBe(false);
      missing.shmCreatedByNative = missing.shmExistedAfterNative === true;
      expect(missing.shmCreatedByNative).toBe(true);
      matrix.push(missing);

      const rotationRoot = await mkdtemp(path.join(os.tmpdir(), 'linejs-reader-wal-rotation-'));
      const rotatedWriter = spawn(fixturePath, ['--hold', rotationRoot], { stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true });
      try {
        await expectOutputLine(rotatedWriter.stdout, 'READY', 5_000);
        await sendWriterCommand(rotatedWriter, 'GROW', 'COMMITTED');
        await sendWriterCommand(rotatedWriter, 'CLOSE', 'CLOSING');
        await closesWithin(rotatedWriter, 5_000);
        const rotatedDb = path.join(rotationRoot, 'LINE', 'Data', 'db', 'messages.edb');
        const beforeRotation = await hashFiles(database, wal);
        await copyFile(rotatedDb, database);
        if (existsSync(rotatedDb + '-wal')) await copyFile(rotatedDb + '-wal', wal);
        else if (existsSync(wal)) await rm(wal, { force: true });
        const afterRotation = await hashFiles(database, wal);
        expect(afterRotation.edb !== beforeRotation.edb || afterRotation.wal !== beforeRotation.wal).toBe(true);
        matrix.push(await runNativeFixtureDiagnostic('source_rotated', database, wal, shm));
      } finally {
        rotatedWriter.stdin.end();
        if (rotatedWriter.exitCode === null && rotatedWriter.signalCode === null) {
          rotatedWriter.kill();
          await closesWithin(rotatedWriter, 5_000);
        }
        await rm(rotationRoot, { recursive: true, force: true });
      }
      console.info(`NATIVE_WAL_MATRIX ${JSON.stringify(matrix)}`);
      expect(matrix).toHaveLength(7);
      expect(matrix.every((item) => typeof item.nativeStage === 'string' && typeof item.nativePrimary === 'number' &&
        typeof item.nativeExtended === 'number' && typeof item.nativeVersion === 'string' && typeof item.nativeOk === 'boolean')).toBe(true);
      expect(matrix[0]).toMatchObject({ case: 'zeroed_candidate_key_repro', nativeOk: false,
        nativeStage: 'prepare', nativePrimary: 26, nativeExtended: 26 });
      expect(matrix.slice(1, 5).map((item) => item.nativeRows)).toEqual([4, 4, 5, 5]);
      expect(matrix.slice(1, 5).every((item) => item.nativeOk)).toBe(true);
      expect(matrix[5]).toMatchObject({ case: 'missing_shm', shmExistedBeforeNative: false, shmExistedAfterNative: true,
        shmCreatedByNative: true });
    } finally {
      writer.stdin.end();
      if (writer.exitCode === null && writer.signalCode === null) {
        writer.kill();
        await closesWithin(writer, 5_000);
      }
      await rm(matrixRoot, { recursive: true, force: true });
    }
  }, 60_000);

  it('exits on its independent preparation watchdog while init is absent or partial', async () => {
    const executable = path.join(fixtureRoot, watchdogBridgeName);
    for (const partial of [false, true]) {
      const child = spawn(executable, ['--request-id', 'a'.repeat(32)], { stdio: ['pipe', 'ignore', 'ignore'], windowsHide: true });
      const startedAt = Date.now();
      if (partial) child.stdin.write(Buffer.from([0, 0]));
      await closesWithin(child, 4_000);
      expect(Date.now() - startedAt).toBeLessThan(3_500);
    }
  });

  it('closes promptly when EOF interrupts a partial input frame', async () => {
    const executable = path.join(fixtureRoot, watchdogBridgeName);
    const child = spawn(executable, ['--request-id', 'c'.repeat(32)], { stdio: ['pipe', 'ignore', 'ignore'], windowsHide: true });
    const startedAt = Date.now();
    child.stdin.write(Buffer.from([0, 0]));
    child.stdin.end();
    await closesWithin(child, 2_000);
    expect(Date.now() - startedAt).toBeLessThan(1_500);
  });

  it('exits on its independent session watchdog while close is partial', async () => {
    const executable = path.join(fixtureRoot, watchdogBridgeName);
    const child = spawn(executable, ['--request-id', 'b'.repeat(32)], { stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true });
    const decoder = new FrameDecoder(FRAME_LIMITS.controlBytes);
    const inventory = new Promise<void>((resolve, reject) => {
      child.stdout.on('data', (chunk: Buffer) => {
        try {
          if (decoder.push(chunk).some((frame) => frame.type === 'inventory')) resolve();
        } catch (error) { reject(error); }
      });
    });
    child.stdin.write(encodeFrame({ version: 1, requestId: 'b'.repeat(32), sequence: 1, type: 'init',
      expectedMid: 'fixture-own-mid', deadlineUnixMs: Date.now() + 20_000 }, FRAME_LIMITS.controlBytes));
    await within(inventory, 3_000, 'fixture_inventory_timeout');
    const startedAt = Date.now();
    child.stdin.write(Buffer.from([0, 0]));
    await closesWithin(child, 4_000);
    expect(Date.now() - startedAt).toBeLessThan(3_500);
  });

  it('discovers only the fixture LINE build, validates the in-process key, and opens the encrypted EDB read-only', async () => {
    await withNativeFixtureSource(async ({ root, bridgePath, databasePath, nativeRows, processId }) => {
      const before = await hashFiles(databasePath, databasePath + '-wal');
      const shmBefore = await fileMetadata(databasePath + '-shm');
      const controller = new JsExternalReaderController(new ExternalSourceProbeAdmissionGate());
      const rows: string[] = [];
      const result = await controller.readFixtureSourcePages({ bridgePath, fixtureRoot: root, fixtureProcessId: processId,
        expectedMid: 'fixture-own-mid', deadlineUnixMs: Date.now() + 15_000,
        onPage: (page) => { rows.push(...page.rows); expect(page.diagnostic).toContain('readonly=1|open_flags=1|key_order=open,cipher,wal_settings,key'); } });
      expect(rows).toEqual(nativeRows);
      decodedNativeFixtureRows = rows;
      expect(result).toEqual({ pageCount: 1, rowCount: nativeRows.length });
      expect(await hashFiles(databasePath, databasePath + '-wal')).toEqual(before);
      const shmAfter = await fileMetadata(databasePath + '-shm');
      console.info(`BRIDGE_REOPEN_DIAGNOSTIC ${JSON.stringify({ rows: rows.length, edbWalStable: true, shmBefore, shmAfter })}`);
    });
  }, 60_000);

  it('uses only the explicitly injected synthetic process identity', async () => {
    await withNativeFixtureSource(async ({ root, bridgePath }) => {
      const controller = new JsExternalReaderController(new ExternalSourceProbeAdmissionGate());
      await expect(controller.readFixtureSourcePages({ bridgePath, fixtureRoot: root, fixtureProcessId: 0x7fffffff,
        expectedMid: 'fixture-own-mid', deadlineUnixMs: Date.now() + 10_000, onPage: () => undefined })).rejects.toThrow();
    });
  }, 15_000);

  it('rejects ambiguous EDB candidates from the injected synthetic source directory', async () => {
    await withNativeFixtureSource(async ({ root, bridgePath, processId }) => {
      await writeFile(path.join(root, 'LINE', 'Data', 'db', 'second.edb'), 'synthetic-only');
      const controller = new JsExternalReaderController(new ExternalSourceProbeAdmissionGate());
      await expect(controller.readFixtureSourcePages({ bridgePath, fixtureRoot: root, fixtureProcessId: processId,
        expectedMid: 'fixture-own-mid', deadlineUnixMs: Date.now() + 10_000, onPage: () => undefined })).rejects.toThrow();
    });
  }, 15_000);

  it('reads bounded encrypted fixture pages and ACKs only after the page consumer completes', async () => {
    await withNativeFixtureSource(async ({ root, bridgePath, nativeRows, processId }) => {
      const controller = new JsExternalReaderController(new ExternalSourceProbeAdmissionGate());
      const rows: string[] = [];
      let consumerCompleted = false;
      const result = await controller.readFixtureSourcePages({
        bridgePath, fixtureRoot: root, fixtureProcessId: processId, expectedMid: 'fixture-own-mid', deadlineUnixMs: Date.now() + 15_000,
        onPage: async (page) => {
          expect(consumerCompleted).toBe(false);
          rows.push(...page.rows);
          consumerCompleted = true;
        },
      });
      expect(result).toEqual({ pageCount: 1, rowCount: 4 });
      expect(rows).toEqual(nativeRows);
      expect(consumerCompleted).toBe(true);
    });
  }, 60_000);

  it('cooperatively cancels a page consumer before ACK and releases controller admission', async () => {
    await withNativeFixtureSource(async ({ root, bridgePath, nativeRows, processId }) => {
      const controller = new JsExternalReaderController(new ExternalSourceProbeAdmissionGate());
      const cancellation = new AbortController();
      let signalObservedAbort = false;
      let startConsumer!: () => void;
      const consumerStarted = new Promise<void>((resolve) => { startConsumer = resolve; });
      const reading = controller.readFixtureSourcePages({
        bridgePath, fixtureRoot: root, fixtureProcessId: processId, expectedMid: 'fixture-own-mid', deadlineUnixMs: Date.now() + 15_000,
        signal: cancellation.signal,
        onPage: async (_page, signal) => {
          startConsumer();
          await new Promise<void>((resolve) => signal?.addEventListener('abort', () => { signalObservedAbort = true; resolve(); }, { once: true }));
        },
      });
      await within(consumerStarted, 5_000, 'fixture_consumer_not_started');
      cancellation.abort();
      await expect(reading).rejects.toThrow('reader_cancelled');
      expect(signalObservedAbort).toBe(true);

      const recoveredRows: string[] = [];
      await controller.readFixtureSourcePages({
        bridgePath, fixtureRoot: root, fixtureProcessId: processId, expectedMid: 'fixture-own-mid', deadlineUnixMs: Date.now() + 15_000,
        onPage: async (page) => { recoveredRows.push(...page.rows); },
      });
      expect(recoveredRows).toEqual(nativeRows);
    });
  }, 35_000);

  it('aborts the owned consumer signal at the session deadline and settles before reuse', async () => {
    await withNativeFixtureSource(async ({ root, bridgePath, nativeRows, processId }) => {
      const controller = new JsExternalReaderController(new ExternalSourceProbeAdmissionGate());
      let signalObservedAbort = false;
      const reading = controller.readFixtureSourcePages({
        bridgePath, fixtureRoot: root, fixtureProcessId: processId, expectedMid: 'fixture-own-mid', deadlineUnixMs: Date.now() + 3_000,
        onPage: async (_page, signal) => {
          await new Promise<void>((resolve) => signal?.addEventListener('abort', () => { signalObservedAbort = true; resolve(); }, { once: true }));
        },
      });
      await expect(reading).rejects.toThrow('reader_deadline_exceeded');
      expect(signalObservedAbort).toBe(true);
      const rows: string[] = [];
      await controller.readFixtureSourcePages({ bridgePath, fixtureRoot: root, fixtureProcessId: processId, expectedMid: 'fixture-own-mid',
        deadlineUnixMs: Date.now() + 10_000, onPage: (page) => { rows.push(...page.rows); } });
      expect(rows).toEqual(nativeRows);
    });
  }, 25_000);

  it('keeps admission fenced while a noncooperative page consumer remains unsettled', async () => {
    await withNativeFixtureSource(async ({ root, bridgePath, nativeRows, processId }) => {
      const controller = new JsExternalReaderController(new ExternalSourceProbeAdmissionGate());
      const cancellation = new AbortController();
      let startConsumer!: () => void;
      const consumerStarted = new Promise<void>((resolve) => { startConsumer = resolve; });
      let releaseConsumer!: () => void;
      const reading = controller.readFixtureSourcePages({
        bridgePath, fixtureRoot: root, fixtureProcessId: processId, expectedMid: 'fixture-own-mid', deadlineUnixMs: Date.now() + 15_000,
        signal: cancellation.signal,
        onPage: () => new Promise<void>((resolve) => { releaseConsumer = resolve; startConsumer(); }),
      });
      await within(consumerStarted, 5_000, 'fixture_consumer_not_started');
      cancellation.abort();
      expect(releaseConsumer).toBeDefined();
      await expect(controller.readFixtureSourcePages({ bridgePath, fixtureRoot: root, fixtureProcessId: processId, expectedMid: 'fixture-own-mid',
        deadlineUnixMs: Date.now() + 10_000, onPage: () => undefined })).rejects.toThrow('reader_already_active');

      releaseConsumer();
      await expect(reading).rejects.toThrow('reader_cancelled');
      const rows: string[] = [];
      await eventually(async () => {
        try {
          await controller.readFixtureSourcePages({ bridgePath, fixtureRoot: root, fixtureProcessId: processId, expectedMid: 'fixture-own-mid',
            deadlineUnixMs: Date.now() + 10_000, onPage: (page) => { rows.push(...page.rows); } });
          return true;
        } catch (error) {
          if ((error as Error).message === 'reader_already_active') return false;
          throw error;
        }
      }, 5_000, 'fixture_admission_not_released');
      expect(rows).toEqual(nativeRows);
    });
  }, 35_000);

  it.skipIf(!process.env.TEST_DATABASE_URL)('imports fixture observations and repairs deleted archive tail rows with provenance', async () => {
    const disposable = await createTestDatabase();
    const { pool, close } = disposable;
    try {
      const suffix = randomUUID().replaceAll('-', '');
      const accountId = `fixture-primary-${suffix}`;
      const agentAccountId = `fixture-agent-${suffix}`;
      const ownMid = `fixture-own-mid-${suffix}`;
      const accounts = new AccountRepository(pool);
      const repository = new ExternalMonitorRepository(pool);
      await accounts.ensureAccount(accountId);
      await accounts.setOwnMid(accountId, ownMid);
      await accounts.ensureAccount(agentAccountId);
      await accounts.setOwnMid(agentAccountId, `fixture-agent-mid-${suffix}`);
      await pool.query("UPDATE line_accounts SET product_role=NULL WHERE product_role='PRIMARY_ADMIN'");
      await pool.query("UPDATE line_accounts SET product_role='AGENT' WHERE account_id=$1", [agentAccountId]);
      await pool.query("UPDATE line_accounts SET product_role='PRIMARY_ADMIN' WHERE account_id=$1", [accountId]);
      await pool.query("DELETE FROM account_administrators WHERE account_id=$1 AND role='PRIMARY_ADMIN'", [agentAccountId]);
      await pool.query(`INSERT INTO account_administrators(account_id,chat_type,chat_id,user_id,role)
        VALUES ($1,'direct',$2,$3,'PRIMARY_ADMIN')`, [agentAccountId, `fixture-admin-chat-${suffix}`, ownMid]);
      const source = await repository.bindVerifiedExternalSource({ accountId, ownMid, sourceIdentity: `synthetic-fixture-${suffix}` });
      const observations = observationsFromNativeFixture(decodedNativeFixtureRows.length > 0 ? decodedNativeFixtureRows : await captureNativeFixtureRows());
      const firstCursor = { history: { sourceRows: observations.length }, highWater: { sourceRows: observations.length } };
      const importRows: string[] = [];
      let initial: Awaited<ReturnType<typeof repository.stageAndProjectBatch>> | undefined;
      await withNativeFixtureSource(async ({ root, bridgePath, nativeRows, processId }) => {
        const controller = new JsExternalReaderController(new ExternalSourceProbeAdmissionGate());
        await controller.readFixtureSourcePages({ bridgePath, fixtureRoot: root, fixtureProcessId: processId, expectedMid: 'fixture-own-mid',
          deadlineUnixMs: Date.now() + 15_000, onPage: async (page) => {
            importRows.push(...page.rows);
            expect(importRows).toEqual(nativeRows);
            const pageObservations = observationsFromNativeFixture(page.rows);
            initial = await repository.stageAndProjectBatch({
              accountId, sourceId: source.sourceId, generation: source.generation, expectedModeRevision: source.modeRevision,
              expectedCheckpoint: null, batchId: 'fixture-first-import', cursor: firstCursor, observations: pageObservations,
            });
          } });
      });
      expect(importRows).toEqual(observations.map((row) => `${row.nativeMessageId}|${new Date(row.occurredAt).getTime()}|${row.text}`));
      expect(initial).toMatchObject({ staged: observations.length, projected: observations.length, conflicts: 0, replayed: false });

      const sourceState = await pool.query(`SELECT
        (SELECT count(*) FROM external_source_observations WHERE source_id=$1) AS observations,
        (SELECT count(*) FROM external_source_batches WHERE source_id=$1) AS receipts,
        (SELECT count(*) FROM external_source_checkpoints WHERE source_id=$1) AS checkpoints,
        (SELECT count(*) FROM messages WHERE account_id=$2) AS messages,
        (SELECT count(*) FROM message_source_provenance WHERE source_id=$1) AS provenance`, [source.sourceId, accountId]);
      expect(sourceState.rows[0]).toEqual({ observations: '4', receipts: '1', checkpoints: '1', messages: '4', provenance: '4' });

      const stored = await pool.query<{ observation_id: string; canonical_message_id: string }>(
        'SELECT observation_id,canonical_message_id FROM external_source_observations WHERE source_id=$1 ORDER BY observation_id', [source.sourceId]);
      const canonicalByObservation = new Map(stored.rows.map((row) => [row.observation_id, row.canonical_message_id]));
      const terminalObservations = observations.slice(-2);
      const terminalIds = terminalObservations.map((observation) => canonicalByObservation.get(observation.observationId))
        .filter((id): id is string => typeof id === 'string');
      if (terminalIds.length !== terminalObservations.length) throw new Error('fixture_archive_ids_missing');
      const retainedObservationRows = await pool.query('SELECT count(*) FROM external_source_observations WHERE source_id=$1', [source.sourceId]);
      const retainedReceipts = await pool.query('SELECT count(*) FROM external_source_batches WHERE source_id=$1', [source.sourceId]);
      const retainedCheckpoint = await pool.query('SELECT cursor FROM external_source_checkpoints WHERE source_id=$1', [source.sourceId]);
      await pool.query('DELETE FROM messages WHERE account_id=$1 AND message_id=ANY($2::text[])', [accountId, terminalIds]);
      expect((await pool.query('SELECT count(*) FROM external_source_observations WHERE source_id=$1', [source.sourceId])).rows[0]?.count)
        .toBe(retainedObservationRows.rows[0]?.count);
      expect((await pool.query('SELECT count(*) FROM external_source_batches WHERE source_id=$1', [source.sourceId])).rows[0]?.count)
        .toBe(retainedReceipts.rows[0]?.count);
      expect((await pool.query('SELECT cursor FROM external_source_checkpoints WHERE source_id=$1', [source.sourceId])).rows[0]?.cursor)
        .toEqual(retainedCheckpoint.rows[0]?.cursor);
      expect((await pool.query('SELECT count(*) FROM messages WHERE account_id=$1', [accountId])).rows[0]?.count).toBe('2');

      const runTailPass = async (batchId: string, expectedCheckpoint: Record<string, unknown>, marker: { capturedHead: number; next: number }) => {
        let result: Awaited<ReturnType<typeof repository.stageAndProjectBatch>> | undefined;
        await withNativeFixtureSource(async ({ root, bridgePath, nativeRows, processId }) => {
          const controller = new JsExternalReaderController(new ExternalSourceProbeAdmissionGate());
          const rows: string[] = [];
          await controller.readFixtureSourcePages({ bridgePath, fixtureRoot: root, fixtureProcessId: processId, expectedMid: 'fixture-own-mid',
            deadlineUnixMs: Date.now() + 15_000, onPage: async (page) => {
              rows.push(...page.rows);
              expect(rows).toEqual(nativeRows);
              expect(rows).toEqual(importRows);
              result = await repository.stageAndProjectBatch({
                accountId, sourceId: source.sourceId, generation: source.generation, expectedModeRevision: source.modeRevision,
                expectedCheckpoint, batchId, cursor: {}, tail: { marker }, observations: observationsFromNativeFixture(page.rows),
              });
            } });
        });
        if (!result) throw new Error('fixture_tail_pass_missing_result');
        return result;
      };

      const firstTailMarker = { capturedHead: observations.length, next: 1 };
      const firstTail = await runTailPass('fixture-tail-repair-1', firstCursor, firstTailMarker);
      expect(firstTail).toMatchObject({ staged: observations.length, projected: observations.length, conflicts: 0, replayed: false });
      const restored = await pool.query<{ message_id: string; text_content: string }>(
        'SELECT message_id,text_content FROM messages WHERE account_id=$1 ORDER BY message_id', [accountId]);
      const expectedMessageRows = observations.map((observation) => ({
        message_id: canonicalByObservation.get(observation.observationId)!, text_content: observation.text!,
      })).sort((left, right) => left.message_id.localeCompare(right.message_id));
      expect(restored.rows).toEqual(expectedMessageRows);
      const expectedProvenance = observations.map((observation) => ({ message_id: canonicalByObservation.get(observation.observationId)!,
        observation_id: observation.observationId, origin: 'EXTERNAL_MONITOR', redacted: true }))
        .sort((left, right) => left.observation_id.localeCompare(right.observation_id));
      const provenanceAfterRepair = await pool.query(`SELECT message_id,observation_id,origin,redacted FROM message_source_provenance
        WHERE source_id=$1 ORDER BY observation_id`, [source.sourceId]);
      expect(provenanceAfterRepair.rows).toEqual(expectedProvenance);
      expect((await pool.query('SELECT count(*) FROM external_source_observations WHERE source_id=$1', [source.sourceId])).rows[0]?.count)
        .toBe('4');

      const afterFirstTail = { ...firstCursor, tail: firstTailMarker };
      const secondTail = await runTailPass('fixture-tail-repair-2', afterFirstTail, { capturedHead: observations.length, next: 2 });
      expect(secondTail).toMatchObject({ staged: observations.length, projected: observations.length, conflicts: 0, replayed: false });
      expect((await pool.query('SELECT message_id,text_content FROM messages WHERE account_id=$1 ORDER BY message_id', [accountId])).rows)
        .toEqual(expectedMessageRows);
      expect((await pool.query(`SELECT message_id,observation_id,origin,redacted FROM message_source_provenance
        WHERE source_id=$1 ORDER BY observation_id`, [source.sourceId])).rows).toEqual(expectedProvenance);
      expect((await pool.query('SELECT count(*) FROM external_source_observations WHERE source_id=$1', [source.sourceId])).rows[0]?.count)
        .toBe('4');
      expect((await pool.query('SELECT count(*) FROM external_source_batches WHERE source_id=$1', [source.sourceId])).rows[0]?.count)
        .toBe('3');
      expect((await pool.query('SELECT cursor FROM external_source_checkpoints WHERE source_id=$1', [source.sourceId])).rows[0]?.cursor)
        .toEqual({ ...firstCursor, tail: { capturedHead: observations.length, next: 2 } });
    } finally {
      await close();
    }
  });
});

async function expectOutputLine(stream: NodeJS.ReadableStream, expected: string, timeoutMs: number): Promise<void> {
  await within(new Promise<void>((resolve, reject) => {
    let buffer = '';
    stream.on('data', (chunk: Buffer) => {
      buffer += chunk.toString('utf8');
      if (buffer.split(/\r?\n/).includes(expected)) resolve();
    });
    stream.on('error', reject);
  }), timeoutMs, `fixture_output_${expected}_timeout`);
}

async function sendWriterCommand(writer: { stdin: NodeJS.WritableStream; stdout: NodeJS.ReadableStream }, command: string, expected: string): Promise<void> {
  const reply = expectOutputLine(writer.stdout, expected, 5_000);
  writer.stdin.write(`${command}\n`);
  await reply;
}

async function withNativeFixtureSource<T>(run: (source: { root: string; bridgePath: string; databasePath: string; nativeRows: string[]; processId: number }) => Promise<T>): Promise<T> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'linejs-reader-controller-fixture-'));
  const bridgePath = path.join(root, 'ExternalReaderBridgeSourceTest.exe');
  const writerPath = path.join(root, 'SqliteFixtureHarness.exe');
  const linePath = path.join(root, 'LINE', 'bin', 'current', 'LINE.exe');
  const databasePath = path.join(root, 'LINE', 'Data', 'db', 'messages.edb');
  let writer: ReturnType<typeof spawn> | undefined;
  let writerOutput = '';
  let lineProcess: ReturnType<typeof spawn> | undefined;
  try {
    await mkdir(path.dirname(linePath), { recursive: true });
    await Promise.all([
      copyFile(path.join(fixtureRoot, 'ExternalReaderBridgeSourceTest.exe'), bridgePath),
      copyFile(fixturePath, writerPath),
      copyFile(path.join(fixtureRoot, 'sqlite3mc_x64.dll'), path.join(root, 'sqlite3mc_x64.dll')),
      copyFile(path.join(fixtureRoot, 'LINE', 'bin', 'current', 'LINE.exe'), linePath),
    ]);
    writer = spawn(writerPath, ['--hold', root], { stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true });
    writer.stdout!.on('data', (chunk: Buffer) => { writerOutput += chunk.toString('utf8'); });
    await expectOutputLine(writer.stdout!, 'READY', 5_000);
    lineProcess = spawn(linePath, [], { stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true });
    await expectOutputLine(lineProcess.stdout!, 'READY', 5_000);
    if (!Number.isSafeInteger(lineProcess.pid) || !lineProcess.pid) throw new Error('fixture_source_process_pid_missing');
    return await run({ root, bridgePath, databasePath, nativeRows: rowsFromWriterOutput(writerOutput), processId: lineProcess.pid });
  } finally {
    writer?.stdin?.end();
    lineProcess?.stdin?.end();
    const closers: Promise<void>[] = [];
    if (writer) closers.push(closesWithin(writer, 5_000));
    if (lineProcess) closers.push(closesWithin(lineProcess, 5_000));
    await Promise.all(closers);
    if (writer && writer.exitCode !== 0 || lineProcess && lineProcess.exitCode !== 0) throw new Error('fixture_source_process_exit_invalid');
    if (writer && !writerOutput.includes('PASS')) throw new Error('fixture_source_writer_failed');
    await rm(root, { recursive: true, force: true });
  }
}

async function runNativeFixtureDiagnostic(name: string, database: string, wal: string, shm: string, zeroKey = false): Promise<Record<string, unknown>> {
  const beforeNative = await hashFiles(database, wal);
  const shmBeforeNative = await fileMetadata(shm);
  const native = runNativeDiagnostic(fixturePath, database, zeroKey);
  const afterNative = await hashFiles(database, wal);
  const shmAfterNative = await fileMetadata(shm);
  return {
    case: name,
    nativeOk: native.ok,
    nativeStage: native.stage,
    nativePrimary: native.primary,
    nativeExtended: native.extended,
    nativeVersion: native.version,
    nativeCodec: 'aes128cbc|mc_legacy_wal=0|aes128cbc.legacy=0',
    nativeReadOnly: true,
    nativeOpenFlags: 1,
    nativeKeyOrder: 'open,cipher,wal_settings,key',
    nativeRows: native.rows?.length ?? null,
    edbStableDuringNative: beforeNative.edb === afterNative.edb,
    walStableDuringNative: beforeNative.wal === afterNative.wal,
    shmExistedBeforeNative: shmBeforeNative !== null,
    shmExistedAfterNative: shmAfterNative !== null,
    shmBytesBeforeNative: shmBeforeNative?.bytes ?? null,
    shmBytesAfterNative: shmAfterNative?.bytes ?? null,
    shmModifiedBeforeNative: shmBeforeNative?.modifiedMs ?? null,
    shmModifiedAfterNative: shmAfterNative?.modifiedMs ?? null,
  };
}

function runNativeDiagnostic(executable: string, database: string, zeroKey = false): {
  ok: boolean; stage: string; primary: number; extended: number; version: string; rows?: string[];
} {
  const run = spawnSync(executable, [zeroKey ? '--probe-zero-key' : '--probe', database], { encoding: 'utf8', windowsHide: true, timeout: 5_000, maxBuffer: 1024 * 1024 });
  if (run.error) throw run.error;
  const lines = run.stdout.trim().split(/\r?\n/);
  const header = /^(PROBE_OK|PROBE_FAIL)\|([^|]+)\|(\d+)\|(\d+)\|(sqlite=[^|]+\|cipher=[^|]+\|readonly=1\|open_flags=1\|key_order=[a-z_,]+)(?:\|rows=(\d+))?$/.exec(lines[0] ?? '');
  if (!header) throw new Error(`fixture_native_diagnostic_invalid:${run.status}:${run.stderr.slice(0, 200)}`);
  const rows = lines.slice(1).filter((line) => line.startsWith('ROW\t')).map((line) => line.slice(4));
  return { ok: header[1] === 'PROBE_OK', stage: header[2]!, primary: Number(header[3]), extended: Number(header[4]),
    version: header[5]!, ...(header[1] === 'PROBE_OK' ? { rows } : {}) };
}

async function hashFiles(database: string, wal: string): Promise<{ edb: string | null; wal: string | null }> {
  return { edb: await fileHash(database), wal: await fileHash(wal) };
}

async function fileHash(filename: string): Promise<string | null> {
  try { return createHash('sha256').update(await readFile(filename)).digest('hex'); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

async function fileMetadata(filename: string): Promise<{ bytes: number; modifiedMs: number } | null> {
  try {
    const info = await stat(filename);
    return { bytes: info.size, modifiedMs: info.mtimeMs };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

function rowsFromWriterOutput(output: string): string[] {
  const lines = output.split(/\r?\n/);
  const start = lines.indexOf('NATIVE_ROWS_BEGIN');
  const end = lines.indexOf('NATIVE_ROWS_END');
  if (start < 0 || end <= start) throw new Error('fixture_native_rows_unavailable');
  return lines.slice(start + 1, end).map((line) => {
    if (!line.startsWith('ROW\t')) throw new Error('fixture_native_row_invalid');
    return line.slice(4);
  });
}

async function captureNativeFixtureRows(): Promise<string[]> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'linejs-reader-archive-fixture-'));
  const writer = spawn(fixturePath, ['--hold', root], { stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true });
  let output = '';
  writer.stdout.on('data', (chunk: Buffer) => { output += chunk.toString('utf8'); });
  try {
    await expectOutputLine(writer.stdout, 'READY', 5_000);
    const rows = rowsFromWriterOutput(output);
    writer.stdin.end();
    await closesWithin(writer, 5_000);
    expect(writer.exitCode).toBe(0);
    expect(output).toContain('PASS');
    return rows;
  } finally {
    writer.stdin.end();
    if (writer.exitCode === null && writer.signalCode === null) {
      writer.kill();
      await closesWithin(writer, 5_000);
    }
    await rm(root, { recursive: true, force: true });
  }
}

function observationsFromNativeFixture(rows: readonly string[]): ExternalObservation[] {
  return rows.map((row) => {
    const match = /^([^|]+)\|(-?\d+)\|(.*)$/.exec(row);
    if (!match) throw new Error('fixture_native_row_invalid');
    const occurredAt = new Date(Number(match[2])).toISOString();
    return { observationId: `fixture:${match[1]}`, canonicalMessageId: null, nativeConversationKind: 'direct',
      nativeConversationId: 'fixture-chat', nativeMessageId: match[1]!, chatType: 'direct', chatId: 'fixture-chat',
      senderId: 'fixture-sender', kind: 'text', text: match[3]!, occurredAt };
  });
}

async function writeBridgeFrame(child: ReturnType<typeof spawn>, frame: unknown): Promise<void> {
  if (!child.stdin) throw new Error('fixture_bridge_stdin_unavailable');
  child.stdin.write(encodeFrame(frame, FRAME_LIMITS.controlBytes));
}

function closesWithin(child: ReturnType<typeof spawn>, timeoutMs: number): Promise<void> {
  const closed = new Promise<void>((resolve) => child.once('close', () => resolve()));
  return new Promise((resolve, reject) => {
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
      void closed.then(() => reject(new Error('fixture_bridge_did_not_exit')));
    }, timeoutMs);
    void closed.then(() => { clearTimeout(timer); if (!timedOut) resolve(); });
  });
}

function within(promise: Promise<void>, timeoutMs: number, message: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), timeoutMs);
    promise.then(() => { clearTimeout(timer); resolve(); }, (error) => { clearTimeout(timer); reject(error); });
  });
}

async function eventually<T>(check: () => Promise<T | false>, timeoutMs: number, message: string): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const result = await check();
    if (result !== false) return result;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(message);
}
