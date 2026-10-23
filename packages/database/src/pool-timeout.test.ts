import { createServer, type Socket } from 'node:net';
import { describe, expect, it } from 'vitest';
import { createPool } from './pool.js';

describe('createPool connection deadline', () => {
  it('settles a PostgreSQL client stalled during handshake and lets pool shutdown finish', async () => {
    const sockets = new Set<Socket>();
    const server = createServer((socket) => {
      sockets.add(socket);
      socket.once('close', () => sockets.delete(socket));
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Expected a TCP server address');

    const pool = createPool(`postgresql://unused:unused@127.0.0.1:${address.port}/unused`);
    const startedAt = Date.now();
    let ending: Promise<void> | undefined;
    try {
      await expect(pool.connect()).rejects.toThrow();
      const poolState = pool as unknown as { _clients: Array<{ connection?: { stream?: { destroyed?: boolean } } }> };
      expect(Date.now() - startedAt).toBeLessThan(2_200);
      expect(poolState._clients).toHaveLength(0);
      ending = pool.end();
      await expect(Promise.race([
        ending,
        new Promise<never>((_resolve, reject) => setTimeout(() => reject(new Error('pool.end exceeded 1 second')), 1_000)),
      ])).resolves.toBeUndefined();
      expect(poolState._clients).toHaveLength(0);
    } finally {
      for (const socket of sockets) socket.destroy();
      if (!ending) await pool.end().catch(() => undefined);
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  });
});
