import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createFirstImportProgressLog, type FirstImportProgressRecord } from './first-import-progress-log.js';

describe('first import progress log', () => {
  let root: string | undefined;

  afterEach(async () => {
    if (root) await rm(root, { recursive: true, force: true });
    root = undefined;
  });

  it('coalesces pending records, retains cancellation progress, and removes after successful drain', async () => {
    root = await mkdtemp(join(tmpdir(), 'first-import-progress-'));
    const file = join(root, 'progress.json');
    const firstWrite = deferred<void>();
    const started = deferred<void>();
    const writes: FirstImportProgressRecord[] = [];
    const log = createFirstImportProgressLog(file, {
      async write(record) {
        writes.push(record);
        await writeFile(file, JSON.stringify(record), 'utf8');
        if (writes.length === 1) { started.resolve(); await firstWrite.promise; }
      },
    });
    log.record(record('copying_snapshot', null, '0', 'a'));
    await started.promise;
    log.record(record('counting_rows', null, '0', 'b'));
    log.record(record('importing_history', 3, '100', 'c'));
    firstWrite.resolve();
    await log.close({ remove: false });
    expect(writes.map((item) => item.updatedAt)).toEqual(['a', 'c']);
    expect(JSON.parse(await readFile(file, 'utf8'))).toEqual(record('importing_history', 3, '100', 'c'));

    const completed = createFirstImportProgressLog(file);
    completed.record(record('complete', 3, '100', 'd'));
    await completed.close({ remove: true });
    await expect(readFile(file, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('keeps log write failures nonfatal and still closes successfully', async () => {
    root = await mkdtemp(join(tmpdir(), 'first-import-progress-'));
    const onError = vi.fn();
    const log = createFirstImportProgressLog(join(root, 'progress.json'), {
      async write() { throw new Error('disk full'); },
      onError,
    });
    expect(() => log.record(record('importing_history', 1, '25', 'a'))).not.toThrow();
    await expect(log.close({ remove: true })).resolves.toBeUndefined();
    expect(onError).toHaveBeenCalledTimes(1);
  });

  it('keeps path ownership through a timed out write so a successor cannot be removed by old cleanup', async () => {
    root = await mkdtemp(join(tmpdir(), 'first-import-progress-'));
    const file = join(root, 'progress.json');
    const started = deferred<void>();
    const release = deferred<void>();
    const writeFinished = deferred<void>();
    const removeFinished = deferred<void>();
    let lateWrites = 0;
    let successorWrites = 0;
    let removals = 0;
    const log = createFirstImportProgressLog(file, {
      settlementTimeoutMs: 20,
      async write(value, canCommit) {
        started.resolve();
        await release.promise;
        if (canCommit?.()) {
          lateWrites += 1;
          await writeFile(file, JSON.stringify(value), 'utf8');
        }
        writeFinished.resolve();
      },
      async remove() { removals += 1; await rm(file, { force: true }); removeFinished.resolve(); },
    });
    log.record(record('complete', 1, '25', 'late'));
    await started.promise;
    const close = log.close({ remove: true });
    const bounded = await Promise.race([close.then(() => true), delay(100).then(() => false)]);
    const successor = createFirstImportProgressLog(file, { async write() { successorWrites += 1; } });
    expect(successor.available).toBe(false);
    successor.record(record('copying_snapshot', null, '0', 'successor'));
    release.resolve();
    await writeFinished.promise;
    await close;
    await removeFinished.promise;
    expect(bounded).toBe(true);
    expect(lateWrites).toBe(1);
    expect(successorWrites).toBe(0);
    expect(removals).toBe(1);
    await expect(readFile(file, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
    const nextAttempt = createFirstImportProgressLog(file);
    expect(nextAttempt.available).toBe(true);
    await nextAttempt.close({ remove: false });
  });

  it('retains path ownership until a timed out removal settles', async () => {
    root = await mkdtemp(join(tmpdir(), 'first-import-progress-'));
    const file = join(root, 'progress.json');
    const removeStarted = deferred<void>();
    const releaseRemove = deferred<void>();
    const removeFinished = deferred<void>();
    let removals = 0;
    let successorWrites = 0;
    const log = createFirstImportProgressLog(file, {
      settlementTimeoutMs: 20,
      async write() {},
      async remove() { removals += 1; removeStarted.resolve(); await releaseRemove.promise; removeFinished.resolve(); },
    });
    log.record(record('complete', 1, '25', 'done'));
    const close = log.close({ remove: true });
    await removeStarted.promise;
    const bounded = await Promise.race([close.then(() => true), delay(100).then(() => false)]);
    const successor = createFirstImportProgressLog(file, { async write() { successorWrites += 1; } });
    expect(successor.available).toBe(false);
    successor.record(record('copying_snapshot', null, '0', 'successor'));
    releaseRemove.resolve();
    await removeFinished.promise;
    await close;
    expect(bounded).toBe(true);
    expect(removals).toBe(1);
    expect(successorWrites).toBe(0);
    const nextAttempt = createFirstImportProgressLog(file);
    expect(nextAttempt.available).toBe(true);
    await nextAttempt.close({ remove: false });
  });
});

function record(stage: string, completedPage: number | null, committedRows: string, updatedAt: string): FirstImportProgressRecord {
  return { stage, completedPage, committedRows, updatedAt };
}

function deferred<T>(): { promise: Promise<T>; resolve(value: T): void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
