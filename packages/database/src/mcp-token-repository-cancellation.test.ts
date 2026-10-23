import { describe, expect, it, vi } from 'vitest';
import type { Pool, PoolClient } from 'pg';
import { McpTokenRepository } from './mcp-token-repository.js';

function makeClient(onRelease?: (destroy?: boolean) => void): PoolClient {
  return {
    query: vi.fn(async (sql: string) => ({
      rows: sql.includes('SELECT account_id FROM line_accounts') ? [{ account_id: 'account-1' }] : [],
      rowCount: 0,
    })),
    release: vi.fn(onRelease),
  } as unknown as PoolClient;
}

function internalQuery(tokens: McpTokenRepository, signal?: AbortSignal) {
  return tokens.executeForInternalAgent({
    context: { sourceType: 'ui' },
    toolName: 'list_targets',
    ...(signal ? { signal } : {}),
    execute: async () => ({ data: 'ok', resultCount: 1 }),
  });
}

describe('MCP repository pool acquisition bounds', () => {
  it('destroys a client that arrives after request cancellation', async () => {
    const client = makeClient();
    const pool = {
      connect: vi.fn(() => new Promise<PoolClient>((resolve) => setTimeout(() => resolve(client), 40))),
    } as unknown as Pool;
    const tokens = new McpTokenRepository(pool);
    const controller = new AbortController();
    const pending = internalQuery(tokens, controller.signal);
    controller.abort(new Error('request disconnected'));

    await expect(pending).rejects.toThrow('cancelled');
    await vi.waitFor(() => expect(client.release).toHaveBeenCalledWith(true));
    expect(client.query).not.toHaveBeenCalled();
  });

  it('holds a fixed number of acquisition slots until stalled pool connects settle', async () => {
    let connectCalls = 0;
    const pool = {
      connect: vi.fn(() => {
        connectCalls += 1;
        return new Promise<PoolClient>((_resolve, reject) => setTimeout(() => reject(new Error('pool acquisition timeout')), 80));
      }),
    } as unknown as Pool;
    const tokens = new McpTokenRepository(pool);
    const controllers = Array.from({ length: 8 }, () => new AbortController());
    const pending = controllers.map((controller) => internalQuery(tokens, controller.signal));
    expect(connectCalls).toBe(8);
    for (const controller of controllers) controller.abort();
    await Promise.all(pending.map((query) => expect(query).rejects.toThrow('cancelled')));

    await expect(internalQuery(tokens)).rejects.toThrow('admission limit');
    expect(connectCalls).toBe(8);
    await new Promise((resolve) => setTimeout(resolve, 100));
    await expect(internalQuery(tokens)).rejects.toThrow('pool acquisition timeout');
    expect(connectCalls).toBe(9);
  });

  it('drains repeated concurrent bursts without exceeding eight active clients', async () => {
    let activeClients = 0;
    let maximumActiveClients = 0;
    const connect = vi.fn(async () => {
      activeClients += 1;
      maximumActiveClients = Math.max(maximumActiveClients, activeClients);
      return makeClient(() => { activeClients -= 1; });
    });
    const pool = { connect } as unknown as Pool;
    const tokens = new McpTokenRepository(pool);

    for (let burst = 0; burst < 5; burst += 1) {
      await expect(Promise.all(Array.from({ length: 8 }, () => internalQuery(tokens)))).resolves.toEqual(Array(8).fill('ok'));
      expect(activeClients).toBe(0);
    }
    expect(maximumActiveClients).toBeLessThanOrEqual(8);
    expect(maximumActiveClients).toBe(8);
  });
});
