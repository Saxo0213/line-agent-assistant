import type { AgentProvider } from '@line-agent/contracts';

export interface ProviderQuotaWindow { label: string; durationMins: number | null; usedPercent: number; resetsAt: string | null; blocksProvider: boolean }
export interface ProviderQuotaSnapshot {
  provider: AgentProvider; source: string; requestedAt: string; fetchedAt: string | null; stale: boolean; error: string | null; windows: ProviderQuotaWindow[];
  availabilityKnown: boolean;
  blocked?: boolean; recoveryAt?: string | null; evidence?: string | null;
}
const CACHE_TTL_MS = 60_000;
const BACKOFF_MS = 60_000;

function resetTimestamp(value: unknown): string | null {
  if (typeof value === 'number' && Number.isFinite(value)) {
    const date = new Date(value * 1000);
    return Number.isFinite(date.getTime()) ? date.toISOString() : null;
  }
  if (typeof value === 'string') {
    const date = new Date(value);
    return Number.isFinite(date.getTime()) ? date.toISOString() : null;
  }
  return null;
}

export function codexQuotaWindows(value: unknown): ProviderQuotaWindow[] {
  if (!value || typeof value !== 'object') return [];
  const root = value as Record<string, unknown>;
  const limits = (root.rateLimits ?? root.rate_limits ?? root) as Record<string, unknown>;
  return ['primary', 'secondary'].flatMap((slot) => {
    const window = limits?.[slot];
    if (!window || typeof window !== 'object') return [];
    const item = window as Record<string, unknown>;
    const used = item.usedPercent ?? item.used_percent;
    if (typeof used !== 'number' || !Number.isFinite(used)) return [];
    const duration = item.windowDurationMins ?? item.window_duration_mins;
    const reset = item.resetsAt ?? item.resets_at;
    return [{ label: typeof duration === 'number' && Number.isFinite(duration) && duration > 0 ? `${duration} 分鐘` : slot,
      durationMins: typeof duration === 'number' && Number.isFinite(duration) && duration > 0 ? duration : null,
      usedPercent: Math.max(0, Math.min(100, used)), resetsAt: resetTimestamp(reset), blocksProvider: true }];
  }).sort((a, b) => (a.durationMins ?? Infinity) - (b.durationMins ?? Infinity));
}

function claudeQuotaWindows(value: unknown): { windows: ProviderQuotaWindow[]; availabilityKnown: boolean } {
  const data = value && typeof value === 'object' ? value as Record<string, unknown> : {};
  const structured = Array.isArray(data.limits) ? data.limits.flatMap((raw): ProviderQuotaWindow[] => {
    if (!raw || typeof raw !== 'object') return [];
    const item = raw as Record<string, unknown>;
    const { kind, group, percent, scope } = item;
    if (typeof kind !== 'string' || typeof group !== 'string' || typeof percent !== 'number' || !Number.isFinite(percent)) return [];
    const model = scope && typeof scope === 'object' ? (scope as Record<string, unknown>).model : null;
    const modelName = model && typeof model === 'object' && typeof (model as Record<string, unknown>).display_name === 'string'
      ? ((model as Record<string, unknown>).display_name as string).trim().slice(0, 80) : '';
    const label = kind === 'session' && group === 'session' ? '一般工作階段額度'
      : kind === 'weekly_all' && group === 'weekly' ? '一般每週額度'
        : kind === 'weekly_scoped' && group === 'weekly' ? `${modelName ? `${modelName} 專用` : '專用'}每週額度` : null;
    if (!label) return [];
    const generalScope = scope === null || scope === undefined;
    return [{ label, durationMins: null, usedPercent: Math.max(0, Math.min(100, percent)), resetsAt: resetTimestamp(item.resets_at),
      blocksProvider: generalScope && (kind === 'session' || kind === 'weekly_all') }];
  }) : [];
  const legacy = (keys: string[]) => keys.flatMap((key) => {
    const raw = data[key];
    if (!raw || typeof raw !== 'object') return [];
    const item = raw as Record<string, unknown>;
    const utilization = item.utilization;
    if (typeof utilization !== 'number' || !Number.isFinite(utilization)) return [];
    return [{ label: key, durationMins: null, usedPercent: Math.max(0, Math.min(100, utilization)), resetsAt: resetTimestamp(item.resets_at), blocksProvider: true }];
  });
  if (structured.length) {
    const hasSession = structured.some((window) => window.label === '一般工作階段額度');
    const hasWeekly = structured.some((window) => window.label === '一般每週額度');
    const legacyGeneral = legacy([...(hasSession ? [] : ['five_hour']), ...(hasWeekly ? [] : ['seven_day'])]);
    const windows = [...structured, ...legacyGeneral];
    return { windows, availabilityKnown: windows.some((window) => window.blocksProvider) };
  }
  const windows = legacy(['five_hour', 'seven_day']);
  return { windows, availabilityKnown: windows.length > 0 };
}

export class ProviderQuotaService {
  private readonly cache = new Map<AgentProvider, { snapshot: ProviderQuotaSnapshot; until: number; backoffUntil: number }>();
  private readonly flights = new Map<AgentProvider, Promise<ProviderQuotaSnapshot>>();
  constructor(private readonly query: (provider: AgentProvider) => Promise<unknown>, private readonly now = Date.now) {}

  private async refresh(provider: AgentProvider, force = false): Promise<ProviderQuotaSnapshot> {
    const now = this.now();
    const prior = this.cache.get(provider);
    const active = this.flights.get(provider);
    if (active) return active;
    if (!force && prior && now < prior.until) return prior.snapshot;
    if (!force && prior && now < prior.backoffUntil) return { ...prior.snapshot, stale: true, error: prior.snapshot.error ?? '查詢暫時退避中' };
    const flight = (async () => {
      const requestedAt = new Date(now).toISOString();
      try {
        const raw = await this.query(provider);
        const parsed = provider === 'claude' ? claudeQuotaWindows(raw) : { windows: codexQuotaWindows(raw), availabilityKnown: true };
        const { windows, availabilityKnown } = parsed;
        if (!windows.length) throw new Error('Provider 未回傳可辨識的額度視窗');
        const snapshot: ProviderQuotaSnapshot = { provider, source: provider === 'claude' ? 'Anthropic OAuth usage API' : 'Codex app-server account/rateLimits/read',
          requestedAt, fetchedAt: new Date(this.now()).toISOString(), stale: false, error: null, windows, availabilityKnown };
        this.cache.set(provider, { snapshot, until: this.now() + CACHE_TTL_MS, backoffUntil: 0 });
        return snapshot;
      } catch (error) {
        const safe = error instanceof Error ? error.message.slice(0, 180) : 'provider 查詢失敗';
        const snapshot: ProviderQuotaSnapshot = prior?.snapshot
          ? { ...prior.snapshot, stale: true, error: safe }
          : { provider, source: provider === 'claude' ? 'Anthropic OAuth usage API' : 'Codex app-server account/rateLimits/read',
            requestedAt, fetchedAt: null, stale: false, error: safe, windows: [], availabilityKnown: false };
        this.cache.set(provider, { snapshot, until: this.now() + CACHE_TTL_MS, backoffUntil: this.now() + BACKOFF_MS });
        return snapshot;
      }
    })();
    this.flights.set(provider, flight);
    try { return await flight; } finally { this.flights.delete(provider); }
  }

  get(provider: AgentProvider): Promise<ProviderQuotaSnapshot> { return this.refresh(provider); }
  refreshNow(provider: AgentProvider): Promise<ProviderQuotaSnapshot> { return this.refresh(provider,true); }
  getAll(): Promise<ProviderQuotaSnapshot[]> { return Promise.all([this.get('claude'), this.get('codex')]); }
}

const localTime = (value: string | null): string | null => {
  if (!value) return null;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? new Intl.DateTimeFormat('zh-TW', { timeZone: 'Asia/Taipei', dateStyle: 'medium', timeStyle: 'short' }).format(date) : null;
};

export function formatProviderQuota(snapshot: ProviderQuotaSnapshot): string {
  const title = snapshot.provider === 'claude' ? 'Claude' : 'Codex';
  const lines = [`${title} 額度：${snapshot.error ? `未知（${snapshot.error}）` : ''}${snapshot.stale ? '（快取資料，查詢失敗）' : ''}`.trim()];
  if(snapshot.blocked) lines.push(`已知用量限制：${snapshot.evidence ?? 'provider 曾拒絕本次工作'}；重設 ${localTime(snapshot.recoveryAt ?? null) ?? '未知'}`);
  for (const window of snapshot.windows) lines.push(`• ${window.label}：已用 ${window.usedPercent}%${localTime(window.resetsAt) ? `，重設 ${localTime(window.resetsAt)}` : ''}`);
  if (!snapshot.availabilityKnown) lines.push('• 整體可用性：未知（沒有通用額度視窗）');
  if (!snapshot.windows.length && !snapshot.error) lines.push('• 額度視窗：未知');
  lines.push(`來源：${snapshot.source}；查詢時間：${localTime(snapshot.fetchedAt) ?? '未知'}`);
  return lines.join('\n');
}

function formatQuotaReset(value:string|null|undefined):string {
  if(!value) return '重設時間未知';
  const date=new Date(value);
  if(!Number.isFinite(date.getTime())) return '重設時間未知';
  return new Intl.DateTimeFormat('zh-TW',{timeZone:'Asia/Taipei',dateStyle:'medium',timeStyle:'short'}).format(date);
}

export function quotaFailureSuggestion(input:{currentName:string;currentRecoveryAt:string|null;targetName:string;currentBlocked:boolean;alternateBlocked:boolean;alternateRecoveryAt:string|null;
  alternateAvailable:boolean;alternateQueryError:string|null;alternateStale:boolean;consentAvailable:boolean;originalSenderAdmin:boolean}):string {
  const freshness=input.alternateQueryError?`最新查詢失敗：${input.alternateQueryError}；沿用已保存的額度狀態。`
    :input.alternateStale?'最新額度查詢結果已過期；沿用已保存的額度狀態。':'';
  if(input.currentBlocked&&input.alternateBlocked) return `${input.currentName} Agent 預計重設：${formatQuotaReset(input.currentRecoveryAt)}；${input.targetName} Agent 預計重設：${formatQuotaReset(input.alternateRecoveryAt)}。目前沒有可用的 Agent。${freshness}`;
  if(input.consentAvailable) return `${input.targetName} Agent 可用。只有原始提問者可在 10 分鐘內傳送「/agent ${input.targetName.toLowerCase()}」同意切換聊天室並重試一次。`;
  if(input.alternateBlocked) return `${input.targetName} Agent 額度已用完；預計重設：${formatQuotaReset(input.alternateRecoveryAt)}。${freshness}`;
  if(!input.alternateAvailable) return `目前無法確認 ${input.targetName} Agent 是否可用；請稍後傳送 /quota 查詢。${freshness}`;
  if(!input.originalSenderAdmin) return `${input.targetName} Agent 可用。原始提問者不是主要管理員，無法直接同意這次重試；管理員可用 /agent ${input.targetName.toLowerCase()} 切換聊天室，之後請原提問者重新送出需求。`;
  return `${input.targetName} Agent 可用。`;
}
