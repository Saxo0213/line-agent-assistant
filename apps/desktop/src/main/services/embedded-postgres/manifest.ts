import { z } from 'zod';
import { EMBEDDED_PG_MANIFEST_URL_PATTERN, EMBEDDED_PG_PIN } from './pin.js';
import { readWithIdle, type HttpGet } from './http.js';

export type DownloadArtifact = { version: string; url: string; size: number; sha256: string; source: 'manifest' | 'pinned' };
export const PINNED_ARTIFACT: DownloadArtifact = Object.freeze({ ...EMBEDDED_PG_PIN, source: 'pinned' as const });

const MAX_BODY = 16 * 1024;
const MAX_SIZE = 1024 ** 3;
const ManifestSchema = z.strictObject({ schema: z.literal(1), postgres: z.strictObject({
  version: z.string().regex(/^18\.\d+$/), url: z.string().max(300), size: z.number().int().min(1).max(MAX_SIZE),
  sha256: z.string().regex(/^[0-9a-f]{64}$/) }) });

export function compareVersions(a: string, b: string): number {
  const left = a.split('.').map(Number); const right = b.split('.').map(Number);
  for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
    const difference = (left[index] ?? 0) - (right[index] ?? 0);
    if (difference !== 0) return difference;
  }
  return 0;
}

class ManifestRejected extends Error { constructor(readonly reason: string) { super(reason); } }

/**
 * Fetches the server manifest. Returns the artifact it offers, or the built-in pin on any failure; the failure
 * cause is only logged as `pg_manifest_<reason>`.
 */
export async function resolveArtifact(options: { manifestUrl: string; httpGet: HttpGet; log(message: string): void;
  timeoutMs?: number | undefined }): Promise<DownloadArtifact> {
  if (!options.manifestUrl) return PINNED_ARTIFACT;
  const controller = new AbortController();
  const timeoutMs = options.timeoutMs ?? 10_000;
  const total = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const timedOut = () => new ManifestRejected('timeout');
    const abortRace = new Promise<never>((_resolve, reject) => controller.signal.addEventListener('abort', () => reject(timedOut()), { once: true }));
    abortRace.catch(() => undefined);
    const run = async (): Promise<DownloadArtifact> => {
      const response = await options.httpGet(options.manifestUrl, controller.signal).catch((error: unknown) => {
        throw controller.signal.aborted || (error instanceof Error && error.name === 'AbortError') ? timedOut() : new ManifestRejected('fetch');
      });
      if (response.status >= 300 && response.status < 400) { response.destroy(); throw new ManifestRejected('redirect'); }
      if (response.status !== 200) { response.destroy(); throw new ManifestRejected('status'); }
      const type = String(response.headers['content-type'] ?? '').toLowerCase();
      if (!/^(?:application\/(?:[a-z0-9.+-]+\+)?json|text\/plain)(?:\s*;|$)/.test(type)) { response.destroy(); throw new ManifestRejected('not_json'); }
      const chunks: Buffer[] = []; let received = 0;
      for await (const chunk of readWithIdle(response, timeoutMs, timedOut)) {
        received += chunk.byteLength;
        if (received > MAX_BODY) { response.destroy(); throw new ManifestRejected('oversize'); }
        chunks.push(Buffer.from(chunk));
      }
      let json: unknown;
      try { json = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw new ManifestRejected('not_json'); }
      const parsed = ManifestSchema.safeParse(json);
      if (!parsed.success) throw new ManifestRejected('schema');
      const { version, url, size, sha256 } = parsed.data.postgres;
      const match = EMBEDDED_PG_MANIFEST_URL_PATTERN.exec(url);
      if (!match) throw new ManifestRejected('url');
      if (match[1] !== version) throw new ManifestRejected('version');
      if (compareVersions(version, EMBEDDED_PG_PIN.version) < 0) throw new ManifestRejected('downgrade');
      return { version, url, size, sha256, source: 'manifest' };
    };
    return await Promise.race([run(), abortRace]);
  } catch (error) {
    options.log(`pg_manifest_${error instanceof ManifestRejected ? error.reason : 'fetch'}`);
    return PINNED_ARTIFACT;
  } finally { clearTimeout(total); }
}
