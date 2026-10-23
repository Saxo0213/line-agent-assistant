import { request } from 'node:https';
import { EmbeddedPgError } from './errors.js';

export type HttpResponse = { status: number; headers: Record<string, string | string[] | undefined>; body: AsyncIterable<Uint8Array>; destroy(): void };
export type HttpGet = (url: string, signal: AbortSignal) => Promise<HttpResponse>;

/** HTTPS GET without redirect following. */
export const httpGet: HttpGet = (url, signal) => new Promise((resolve, reject) => {
  if (!url.startsWith('https://')) { reject(new EmbeddedPgError('pg_download_failed', 'not https')); return; }
  const req = request(url, { method: 'GET', signal, headers: { 'user-agent': 'LineAgentAssistant' } }, (res) => {
    resolve({ status: res.statusCode ?? 0, headers: res.headers, body: res, destroy: () => res.destroy() });
  });
  req.once('error', reject);
  req.end();
});

/** Reads chunks, failing with `onIdle()` when no chunk arrives within `idleMs`. */
export async function* readWithIdle(response: HttpResponse, idleMs: number, onIdle: () => Error): AsyncGenerator<Uint8Array> {
  const iterator = response.body[Symbol.asyncIterator]();
  try {
    for (;;) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const idle = new Promise<never>((_resolve, reject) => { timer = setTimeout(() => { response.destroy(); reject(onIdle()); }, idleMs); });
      let next: IteratorResult<Uint8Array>;
      try { next = await Promise.race([iterator.next(), idle]); }
      finally { if (timer) clearTimeout(timer); }
      if (next.done) return;
      yield next.value;
    }
  } finally { response.destroy(); }
}
