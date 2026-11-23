import { describe, expect, it } from 'vitest';
import { ProviderFailoverService, type FailoverJobView, type FailoverSourceRow } from './provider-failover-service.js';

const MANAGED = 'acct-0123456789';
const base: FailoverSourceRow[] = [
  { id: 'claude', provider: 'claude', fallbackEnabled: true, isDefault: true, order: 0, status: 'unknown' },
  { id: MANAGED, provider: 'claude', fallbackEnabled: true, isDefault: false, order: 1, status: 'logged_in' },
  { id: 'codex', provider: 'codex', fallbackEnabled: true, isDefault: true, order: 2, status: 'unknown' },
];
const lineJob: FailoverJobView = { jobId: 'j', sourceType: 'line', accountId: 'a', chatType: 'direct', chatId: 'c', provider: 'claude' };

function service(input: { rows?: FailoverSourceRow[]; blocked?: string[]; chatProvider?: 'claude' | 'codex' | null; defaultProvider?: string; enabled?: boolean;
  route?: { provider: 'claude' | 'codex'; sourceId: string | null } | null }) {
  return new ProviderFailoverService({
    settings: {
      getAgentAutoFailoverEnabled: async () => input.enabled ?? true,
      getAppSetting: async () => input.defaultProvider ?? null,
      getConversationAgent: async () => ({ provider: input.chatProvider ?? null }),
    },
    sources: { list: async () => input.rows ?? base },
    quota: { list: async () => (input.blocked ?? []).map((sourceId) => ({ sourceId, blocked: true })) },
    agents: { getRoute: async () => input.route ?? null },
  });
}
const sessionKey = { accountId: 'a', chatType: 'direct' as const, chatId: 'c', provider: 'claude' as const };

describe('ProviderFailoverService', () => {
  it('uses the default source of the preferred provider and reports the enabled switch', async () => {
    const s = service({});
    expect(await s.enabled()).toBe(true);
    expect(await service({ enabled: false }).enabled()).toBe(false);
    expect(await s.routeFor({ job: lineJob, sessionKey, sessionGeneration: 1, excluded: [] })).toEqual({ kind: 'switch_required', provider: 'claude', sourceId: 'claude' });
    const used = service({ route: { provider: 'claude', sourceId: 'claude' } });
    expect(await used.routeFor({ job: lineJob, sessionKey, sessionGeneration: 1, excluded: [] })).toEqual({ kind: 'use', provider: 'claude', sourceId: 'claude' });
  });

  it('skips an excluded source (CliTalkAgent route_session_excluding)', async () => {
    const decision = await service({}).routeFor({ job: lineJob, sessionKey, sessionGeneration: 1, excluded: ['claude'] });
    expect(decision).toEqual({ kind: 'switch_required', provider: 'claude', sourceId: MANAGED });
  });

  it('is exhausted when every candidate is excluded', async () => {
    const decision = await service({}).routeFor({ job: lineJob, sessionKey, sessionGeneration: 1, excluded: ['claude', MANAGED, 'codex'] });
    expect(decision).toEqual({ kind: 'all_sources_exhausted' });
  });

  it('leaves out a source whose fallback is off', async () => {
    const rows = base.map((row) => (row.id === 'claude' || row.id === MANAGED ? { ...row, fallbackEnabled: false } : row));
    const decision = await service({ rows }).routeFor({ job: lineJob, sessionKey, sessionGeneration: 1, excluded: [] });
    expect(decision).toEqual({ kind: 'switch_required', provider: 'codex', sourceId: 'codex' });
  });

  it('skips a logged-out, missing or failed source but accepts one with no cached status', async () => {
    for (const status of ['logged_out', 'not_installed', 'error'] as const) {
      const rows = base.map((row) => (row.id === 'claude' ? { ...row, status } : row));
      expect(await service({ rows }).routeFor({ job: lineJob, sessionKey, sessionGeneration: 1, excluded: [] }))
        .toEqual({ kind: 'switch_required', provider: 'claude', sourceId: MANAGED });
    }
  });

  it('goes to the other provider when every source of the preferred provider is blocked', async () => {
    const decision = await service({ blocked: ['claude', MANAGED] }).routeFor({ job: lineJob, sessionKey, sessionGeneration: 1, excluded: [] });
    expect(decision).toEqual({ kind: 'switch_required', provider: 'codex', sourceId: 'codex' });
  });

  it('reports exhausted when all sources are blocked and no source when none is available', async () => {
    expect(await service({ blocked: ['claude', MANAGED, 'codex'] }).routeFor({ job: lineJob, sessionKey, sessionGeneration: 1, excluded: [] }))
      .toEqual({ kind: 'all_sources_exhausted' });
    const rows = base.map((row) => ({ ...row, status: 'logged_out' as const }));
    expect(await service({ rows }).routeFor({ job: lineJob, sessionKey, sessionGeneration: 1, excluded: [] })).toEqual({ kind: 'no_available_source' });
  });

  it('prefers the chat provider for a LINE job and keeps the submitted provider for a room job', async () => {
    expect(await service({ chatProvider: 'codex' }).routeFor({ job: lineJob, sessionKey, sessionGeneration: 1, excluded: [] }))
      .toEqual({ kind: 'switch_required', provider: 'codex', sourceId: 'codex' });
    expect(await service({ defaultProvider: 'codex' }).routeFor({ job: lineJob, sessionKey, sessionGeneration: 1, excluded: [] }))
      .toEqual({ kind: 'switch_required', provider: 'codex', sourceId: 'codex' });
    const room: FailoverJobView = { jobId: 'u', sourceType: 'ui', accountId: null, chatType: null, chatId: null, provider: 'claude' };
    expect(await service({ defaultProvider: 'codex' }).routeFor({ job: room, sessionKey: { accountId: null, provider: 'claude', sourceType: 'ui' } as never, sessionGeneration: 1, excluded: [] }))
      .toEqual({ kind: 'switch_required', provider: 'claude', sourceId: 'claude' });
  });
});
