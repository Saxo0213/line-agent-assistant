import { appendFile, mkdir, readdir, readFile, rename, stat, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { parseOperationalAuditEvent, type AuditEvent } from './operational-audit.js';

const filePrefix = 'operational-';
const currentName = `${filePrefix}current.jsonl`;
const fileLimit = 10 * 1024 * 1024;
const totalLimit = 140 * 1024 * 1024;
const retentionMs = 14 * 24 * 60 * 60 * 1000;

export class OperationalAuditFallback {
  private readonly ready: Promise<void>;
  constructor(private readonly directory: string) {
    // Startup cleanup is best-effort. Appends retry the required directory
    // creation/cleanup path, so a transient filesystem failure is recoverable.
    this.ready = this.cleanup().catch(() => undefined);
  }

  async append(event: AuditEvent): Promise<void> {
    await this.ready;
    await mkdir(this.directory, { recursive: true });
    const safeEvent = parseOperationalAuditEvent(event);
    if (!safeEvent) throw new Error('Invalid operational audit event');
    const path = join(this.directory, currentName);
    const line = `${JSON.stringify(safeEvent)}\n`;
    const byteCount = Buffer.byteLength(line, 'utf8');
    const size = await stat(path).then((file) => file.size, () => 0);
    if (size > 0 && size + byteCount > fileLimit) {
      const archive = join(this.directory, `${filePrefix}${new Date().toISOString().replaceAll(':', '-')}-${Math.random().toString(16).slice(2, 8)}.jsonl`);
      await rename(path, archive);
    }
    await appendFile(path, line, { encoding: 'utf8', mode: 0o600 });
    await this.cleanup();
  }

  async list(limit = 500): Promise<AuditEvent[]> {
    await this.ready;
    const files = (await this.files()).sort((a, b) => b.modifiedAt - a.modifiedAt);
    const events: AuditEvent[] = [];
    for (const file of files) {
      const lines = (await readFile(join(this.directory, file.name), 'utf8').catch(() => '')).split(/\r?\n/).filter(Boolean);
      for (const line of lines.reverse()) {
        try {
          const event = parseOperationalAuditEvent(JSON.parse(line));
          if (event && Buffer.byteLength(line, 'utf8') <= 8192) events.push(event);
        } catch { /* Ignore a partial line from an interrupted write. */ }
        if (events.length >= limit) return events;
      }
    }
    return events;
  }

  async listStrict(limit = 500, signal?: AbortSignal): Promise<AuditEvent[]> {
    await this.ready;
    signal?.throwIfAborted();
    let names: string[];
    try { names = await readdir(this.directory); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw error;
    }
    const eligible = names.filter((name) => name === currentName
      || /^operational-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}\.\d{3}Z-[0-9a-f]{6}\.jsonl$/i.test(name));
    const files: Array<{ name: string; size: number; modifiedAt: number }> = [];
    for (const name of eligible) {
      signal?.throwIfAborted();
      try {
        const details = await stat(join(this.directory, name));
        if (details.isFile()) files.push({ name, size: details.size, modifiedAt: details.mtimeMs });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
    }
    const cutoff = Date.now() - retentionMs;
    const recent = files.filter((file) => file.modifiedAt >= cutoff).sort((a, b) => b.modifiedAt - a.modifiedAt);
    const events: AuditEvent[] = [];
    let bytesRead = 0;
    for (const file of recent) {
      signal?.throwIfAborted();
      if (bytesRead + file.size > totalLimit) break;
      let text: string;
      try { text = await readFile(join(this.directory, file.name), { encoding: 'utf8', signal }); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
        throw error;
      }
      bytesRead += file.size;
      const lines = text.split(/\r?\n/).filter(Boolean).reverse();
      for (const line of lines) {
        if (Buffer.byteLength(line, 'utf8') > 8192) continue;
        try {
          const event = parseOperationalAuditEvent(JSON.parse(line));
          if (event) events.push(event);
        } catch { /* Ignore partial trailing lines and malformed legacy records. */ }
        if (events.length >= Math.max(1, Math.min(500, Math.trunc(limit)))) return events;
      }
    }
    return events;
  }

  private async files(): Promise<Array<{ name: string; size: number; modifiedAt: number }>> {
    const names = await readdir(this.directory).catch(() => [] as string[]);
    const result = [];
    for (const name of names.filter((entry) => entry.startsWith(filePrefix) && entry.endsWith('.jsonl'))) {
      const details = await stat(join(this.directory, name)).catch(() => null);
      if (details?.isFile()) result.push({ name, size: details.size, modifiedAt: details.mtimeMs });
    }
    return result;
  }

  private async cleanup(): Promise<void> {
    await mkdir(this.directory, { recursive: true });
    const files = (await this.files()).sort((a, b) => a.modifiedAt - b.modifiedAt);
    const cutoff = Date.now() - retentionMs;
    let total = files.reduce((sum, file) => sum + file.size, 0);
    for (const file of files) {
      if (file.modifiedAt < cutoff || total > totalLimit) {
        await unlink(join(this.directory, file.name)).catch(() => undefined);
        total -= file.size;
      }
    }
  }
}
