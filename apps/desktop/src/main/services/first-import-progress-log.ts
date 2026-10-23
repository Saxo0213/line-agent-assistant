import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

const DEFAULT_SETTLEMENT_TIMEOUT_MS = 1_000;
const activePaths = new Set<string>();

export type FirstImportProgressRecord = Readonly<{
  stage: string;
  completedPage: number | null;
  committedRows: string;
  updatedAt: string;
}>;

type ProgressLogIo = Readonly<{
  write?(record: FirstImportProgressRecord, canCommit: () => boolean): Promise<void>;
  remove?(): Promise<void>;
  onError?(error: unknown): void;
  settlementTimeoutMs?: number;
}>;

export function createFirstImportProgressLog(filePath: string, io: ProgressLogIo = {}): {
  available: boolean;
  record(value: FirstImportProgressRecord): void;
  close(input: { remove: boolean }): Promise<void>;
} {
  const resolvedPath = resolve(filePath);
  const ownerKey = process.platform === 'win32' ? resolvedPath.toLowerCase() : resolvedPath;
  const available = !activePaths.has(ownerKey);
  if (available) activePaths.add(ownerKey);
  let pending: FirstImportProgressRecord | null = null;
  let writing: Promise<void> | null = null;
  let accepting = true;
  let canWrite = true;
  let closing: Promise<void> | null = null;

  const write = io.write ?? ((value: FirstImportProgressRecord, canCommit: () => boolean) => replaceRecord(resolvedPath, value, canCommit));
  const remove = io.remove ?? (() => rm(resolvedPath, { force: true }));
  const report = (error: unknown) => {
    try { io.onError?.(error); } catch { /* diagnostics must not affect import */ }
  };

  const drain = async () => {
    while (pending) {
      const value = pending;
      pending = null;
      try { if (canWrite) await write(value, () => canWrite); } catch (error) { report(error); }
    }
  };

  const startDrain = () => {
    if (!writing) {
      writing = drain().finally(() => { writing = null; });
    }
  };

  const completeClose = async (removeFile: boolean) => {
    try {
      if (pending && !writing) startDrain();
      while (writing) await writing;
      canWrite = false;
      if (removeFile) {
        try { await remove(); } catch (error) { report(error); }
      }
    } finally {
      canWrite = false;
      if (available) activePaths.delete(ownerKey);
    }
  };

  return {
    available,
    record(value) {
      if (!available || !accepting) return;
      pending = value;
      startDrain();
    },
    close(input) {
      if (closing) return closing;
      accepting = false;
      if (!available) return closing = Promise.resolve();
      const operation = completeClose(input.remove);
      closing = (async () => {
        const timeoutMs = io.settlementTimeoutMs ?? DEFAULT_SETTLEMENT_TIMEOUT_MS;
        await settlesWithin(operation, timeoutMs);
      })();
      return closing;
    },
  };
}

async function replaceRecord(filePath: string, value: FirstImportProgressRecord, canCommit: () => boolean): Promise<void> {
  if (!canCommit()) return;
  await mkdir(dirname(filePath), { recursive: true, mode: 0o700 });
  if (!canCommit()) return;
  const temporaryPath = `${filePath}.${randomUUID()}.tmp`;
  const contents = `${JSON.stringify(value)}\n`;
  try {
    await writeFile(temporaryPath, contents, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    if (!canCommit()) return;
    await rename(temporaryPath, filePath);
    if (!canCommit()) {
      try {
        if (await readFile(filePath, 'utf8') === contents) await rm(filePath, { force: true });
      } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    }
  } catch (error) {
    await rm(temporaryPath, { force: true }).catch(() => undefined);
    throw error;
  } finally {
    await rm(temporaryPath, { force: true }).catch(() => undefined);
  }
}

async function settlesWithin(operation: Promise<void>, timeoutMs: number): Promise<boolean> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<false>((resolve) => { timer = setTimeout(() => resolve(false), timeoutMs); });
  const result = await Promise.race([operation.then(() => true as const), timeout]);
  if (timer) clearTimeout(timer);
  return result;
}
