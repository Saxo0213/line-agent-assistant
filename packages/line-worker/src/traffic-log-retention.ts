import { lstat, readdir, unlink } from 'node:fs/promises';
import { join } from 'node:path';

export const TRAFFIC_LOG_MAX_AGE_MS = 14 * 24 * 60 * 60 * 1000;
export const TRAFFIC_LOG_MAX_TOTAL_BYTES = 200 * 1024 * 1024;
const DAY_MS = 24 * 60 * 60 * 1000;

export type TrafficLogPruneOptions = Readonly<{
  now?: number;
  maxAgeMs?: number;
  maxTotalBytes?: number;
}>;

/**
 * Deletes `*.jsonl` files that are older than the maximum age. Then it deletes the oldest files
 * until the total size is at most the size limit. It touches no other file. It never throws.
 */
export async function pruneTrafficLogs(directory: string, options: TrafficLogPruneOptions = {}): Promise<{ deleted: number }> {
  const now = options.now ?? Date.now();
  const maxAgeMs = options.maxAgeMs ?? TRAFFIC_LOG_MAX_AGE_MS;
  const maxTotalBytes = options.maxTotalBytes ?? TRAFFIC_LOG_MAX_TOTAL_BYTES;
  let deleted = 0;
  try {
    const files: Array<{ path: string; mtimeMs: number; size: number }> = [];
    for (const name of await readdir(directory)) {
      if (!name.endsWith('.jsonl')) continue;
      const path = join(directory, name);
      try {
        const info = await lstat(path);
        if (info.isFile()) files.push({ path, mtimeMs: info.mtimeMs, size: info.size });
      } catch { /* The file was removed or is not readable. */ }
    }
    const remove = async (file: { path: string }): Promise<boolean> => {
      try { await unlink(file.path); deleted += 1; return true; } catch { return false; }
    };
    const kept: typeof files = [];
    for (const file of files) {
      if (now - file.mtimeMs > maxAgeMs && await remove(file)) continue;
      kept.push(file);
    }
    kept.sort((left, right) => left.mtimeMs - right.mtimeMs);
    let total = kept.reduce((sum, file) => sum + file.size, 0);
    for (const file of kept) {
      if (total <= maxTotalBytes) break;
      if (await remove(file)) total -= file.size;
    }
  } catch { /* A missing directory or a read error leaves the files as they are. */ }
  return { deleted };
}

/** Prunes now and then once a day. The timer does not keep the process alive. */
export function startTrafficLogRetention(directory: string, options: TrafficLogPruneOptions = {}): () => void {
  void pruneTrafficLogs(directory, options);
  const timer = setInterval(() => { void pruneTrafficLogs(directory, options); }, DAY_MS);
  timer.unref();
  return () => clearInterval(timer);
}
