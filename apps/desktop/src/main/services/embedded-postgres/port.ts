import { createServer } from 'node:net';
import { EmbeddedPgError } from './errors.js';
import { EMBEDDED_PG_PORT_RANGE } from './pin.js';

export type BindPort = (port: number) => Promise<boolean>;

/** True when 127.0.0.1:<port> can be bound right now (the socket is closed again immediately). */
export const bindPort: BindPort = (port) => new Promise<boolean>((resolve) => {
  const server = createServer();
  server.once('error', () => resolve(false));
  server.listen({ host: '127.0.0.1', port, exclusive: true }, () => { server.close(() => resolve(true)); });
});

export async function chooseFreePort(bind: BindPort): Promise<number> {
  for (let port = EMBEDDED_PG_PORT_RANGE.first; port <= EMBEDDED_PG_PORT_RANGE.last; port += 1) {
    if (await bind(port)) return port;
  }
  throw new EmbeddedPgError('pg_port_unavailable');
}
