import { describe, expect, it } from 'vitest';
import { codexQuotaWindows, formatProviderQuota, ProviderQuotaService, quotaFailureSuggestion } from './provider-quota-service.js';

describe('provider quota formatting', () => {
  it('uses the provider supplied duration and reset time for each Codex window', () => {
    expect(codexQuotaWindows({ rateLimits: { primary: { usedPercent: 43, windowDurationMins: 240, resetsAt: 1790000000 },
      secondary: { usedPercent: 12, windowDurationMins: 10080, resetsAt: 1790600000 } } })).toEqual([
      { label: '240 分鐘', durationMins: 240, usedPercent: 43, resetsAt: new Date(1790000000 * 1000).toISOString(), blocksProvider: true },
      { label: '10080 分鐘', durationMins: 10080, usedPercent: 12, resetsAt: new Date(1790600000 * 1000).toISOString(), blocksProvider: true },
    ]);
  });

  it('shows unknown after a query error instead of inventing zero usage', () => {
    expect(formatProviderQuota({ provider: 'claude', source: 'Anthropic OAuth usage API', requestedAt: new Date(0).toISOString(), fetchedAt: null,
      stale: false, error: 'OAuth unavailable', windows: [], availabilityKnown: false })).toContain('額度：未知（OAuth unavailable）');
  });

  it('coalesces concurrent reads and does not timestamp failed reads as successful', async () => {
    let calls = 0;
    const service = new ProviderQuotaService(async () => { calls += 1; throw new Error('offline'); }, () => 1_798_000_000_000);
    const [left, right] = await Promise.all([service.get('codex'), service.get('codex')]);
    expect(calls).toBe(1);
    expect(left.fetchedAt).toBeNull();
    expect(right.error).toBe('offline');
  });

  it('prefers authoritative Claude limits and labels scoped quota from the returned model name', async () => {
    const service = new ProviderQuotaService(async () => ({
      limits: [
        { kind: 'session', group: 'session', percent: 0, severity: 'normal', resets_at: null, scope: null, is_active: false },
        { kind: 'weekly_all', group: 'weekly', percent: 100, severity: 'critical', resets_at: '2026-11-02T15:59:59.828720+00:00', scope: null, is_active: true },
        { kind: 'weekly_scoped', group: 'weekly', percent: 57, severity: 'normal', resets_at: '2026-11-02T15:59:59.828933+00:00',
          scope: { model: { id: null, display_name: 'Fable' }, surface: null }, is_active: false },
      ],
      five_hour: { utilization: 12 }, seven_day: { utilization: 20 }, seven_day_opus: null, seven_day_sonnet: null,
      iguana_necktie: { utilization: 100, resets_at: '2026-11-05T00:00:00Z' },
    }));
    const snapshot = await service.get('claude');
    expect(snapshot.windows).toEqual([
      expect.objectContaining({ label: '一般工作階段額度', usedPercent: 0, blocksProvider: true }),
      expect.objectContaining({ label: '一般每週額度', usedPercent: 100, blocksProvider: true,
        resetsAt: new Date('2026-11-02T15:59:59.828720+00:00').toISOString() }),
      expect.objectContaining({ label: 'Fable 專用每週額度', usedPercent: 57, blocksProvider: false }),
    ]);
    expect(snapshot.availabilityKnown).toBe(true);
  });

  it('keeps scoped-only Claude data visible but marks provider-wide availability unknown', async () => {
    const service = new ProviderQuotaService(async () => ({ limits: [
      { kind: 'weekly_scoped', group: 'weekly', percent: 57, resets_at: '2026-11-02T15:59:59Z',
        scope: { model: { display_name: 'Fable' } }, is_active: false },
    ] }));
    const snapshot = await service.get('claude');
    expect(snapshot.windows).toEqual([expect.objectContaining({ label: 'Fable 專用每週額度', usedPercent: 57, blocksProvider: false })]);
    expect(snapshot.availabilityKnown).toBe(false);
    expect(formatProviderQuota(snapshot)).toContain('整體可用性：未知');
    expect(quotaFailureSuggestion({ currentName:'Codex',currentRecoveryAt:null,targetName:'Claude',currentBlocked:true,
      alternateBlocked:false,alternateRecoveryAt:null,alternateAvailable:snapshot.availabilityKnown,alternateQueryError:null,
      alternateStale:false,consentAvailable:false,originalSenderAdmin:true })).toContain('目前無法確認 Claude Agent 是否可用');
  });

  it('falls back only to recognized general Claude legacy fields when limits are absent or unusable', async () => {
    const service = new ProviderQuotaService(async () => ({
      limits: [{ kind: 'new_experimental_kind', group: 'experimental', percent: 100, scope: null }],
      five_hour: { utilization: 37, resets_at: '2026-11-01T00:00:00Z' },
      seven_day: { utilization: 61, resets_at: '2026-11-02T00:00:00Z' },
      seven_day_opus: { utilization: 100 }, iguana_necktie: { utilization: 100 },
    }));
    const snapshot = await service.get('claude');
    expect(snapshot.windows).toEqual([
      expect.objectContaining({ label: 'five_hour', usedPercent: 37, blocksProvider: true }),
      expect.objectContaining({ label: 'seven_day', usedPercent: 61, blocksProvider: true }),
    ]);
  });

  it('reports both persisted providers blocked with both reset times even when the alternate query errors', () => {
    const suggestion=quotaFailureSuggestion({currentName:'Codex',currentRecoveryAt:'2026-11-01T00:00:00Z',targetName:'Claude',currentBlocked:true,alternateBlocked:true,
      alternateRecoveryAt:'2026-11-02T16:00:00Z',alternateAvailable:false,alternateQueryError:'OAuth unavailable',
      alternateStale:true,consentAvailable:false,originalSenderAdmin:true});
    expect(suggestion).toMatch(/Codex Agent 預計重設：.+；Claude Agent 預計重設：.+。/);
    expect(suggestion).toContain('Claude Agent 預計重設');
    expect(suggestion).toContain('目前沒有可用的 Agent');
    expect(suggestion).toContain('最新查詢失敗：OAuth unavailable');
  });
});
