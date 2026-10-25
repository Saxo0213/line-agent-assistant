/**
 * After a fallback start the server may run on another port than `bootstrap.embedded.port`. Persists the new port (URL and
 * `embedded.port`) before anything connects; if the save fails the server is stopped so the app never runs on an unsaved port.
 * Logs ports only, never the URL or password.
 */
export async function persistMovedEmbeddedPort<T extends { databaseUrl: string; embedded?: { port: number } | undefined }>(
  bootstrap: T,
  server: { port: number; stop(): Promise<void> },
  save: (next: T) => Promise<void>,
  log: (message: string) => void,
): Promise<T> {
  const from = bootstrap.embedded?.port;
  const to = server.port;
  if (!bootstrap.embedded || from === to) return bootstrap;
  const url = new URL(bootstrap.databaseUrl);
  url.port = String(to);
  const next: T = { ...bootstrap, databaseUrl: url.toString(), embedded: { ...bootstrap.embedded, port: to } };
  try { await save(next); }
  catch (error) {
    await server.stop().catch(() => undefined);
    throw error;
  }
  log(`pg_port_moved from=${from} to=${to}`);
  return next;
}
