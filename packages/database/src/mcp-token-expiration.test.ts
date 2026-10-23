import { describe, expect, it, vi } from 'vitest';
import type { Pool } from 'pg';
import type { McpTokenExpiration } from '@line-agent/contracts';
import { McpTokenRepository } from './mcp-token-repository.js';

describe('MCP token lifetime validation before database access', () => {
  it.each([undefined, null, {}, { mode: 'never', hours: 24 }, { mode: 'limited' },
    { mode: 'limited', hours: 0 }, { mode: 'limited', hours: 8761 }, { mode: 'limited', hours: 1.5 },
    { mode: 'limited', hours: NaN }, { mode: 'limited', hours: Infinity }, { mode: 'limited', hours: '24' },
    { mode: 'unknown' }])('rejects malformed lifetime %# without acquiring a connection or issuing an audit', async (expiration) => {
    const connect = vi.fn();
    const repository = new McpTokenRepository({ connect } as unknown as Pool);
    await expect(repository.issueToken({ deviceLabel: 'Fixture', accountScopes: ['account-A'], toolScopes: ['list_targets'],
      expiration: expiration as McpTokenExpiration })).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    expect(connect).not.toHaveBeenCalled();
  });

  it.each([{ mode: 'never' }, { mode: 'limited', hours: 168 }] as const)('issues $mode with explicit null or database-clock hours and lists nullable summaries', async (expiration) => {
    const now = new Date('2026-10-18T00:00:00.000Z');
    const row = { token_id: '11111111-1111-4111-8111-111111111111', principal_id: 'external:fixture', device_label: 'Fixture',
      account_scopes: ['account-A'], tool_scopes: ['list_targets'], grant_version: '1', state: 'ACTIVE',
      expires_at: expiration.mode === 'never' ? null : new Date('2026-10-25T00:00:00.000Z'),
      revoked_at: null, last_used_at: null, created_at: now };
    const query = vi.fn(async (sql: string, _parameters?: unknown[]) => {
      if (sql.startsWith('SELECT account_id')) return { rows: [{ account_id: 'account-A' }], rowCount: 1 };
      if (sql.includes('INSERT INTO mcp_agent_tokens') || sql.includes('FROM mcp_agent_tokens')) return { rows: [row], rowCount: 1 };
      return { rows: [], rowCount: 0 };
    });
    const release = vi.fn();
    const repository = new McpTokenRepository({ connect: async () => ({ query, release }), query } as unknown as Pool);
    const issued = await repository.issueToken({ deviceLabel: 'Fixture', accountScopes: ['account-A'], toolScopes: ['list_targets'], expiration });
    expect(issued.token.expiresAt).toBe(row.expires_at?.toISOString() ?? null);
    const insert = query.mock.calls.find(([sql]) => sql.includes('INSERT INTO mcp_agent_tokens'))!;
    expect(insert[0]).toContain('CASE WHEN $7::integer IS NULL THEN NULL ELSE clock_timestamp()');
    expect(insert[1]![6]).toBe(expiration.mode === 'never' ? null : 168);
    expect((await repository.listTokens())[0]?.expiresAt).toBe(issued.token.expiresAt);
    expect(release).toHaveBeenCalledOnce();
  });
});
