import type { AgentProvider } from '@line-agent/contracts';
import { routeKeyFor, routeNext, type RouteCandidate, type RouteDecision, type SessionKey, type SessionRoute } from '@line-agent/database';
import { resolveChatProvider } from './default-provider.js';

/** The chosen source of a job, or the reason that no source can run it. */
export type { RouteDecision };

/** One CLI account source as the router needs it (AccountSourceService.list satisfies it). */
export interface FailoverSourceRow {
  id: string;
  provider: AgentProvider;
  fallbackEnabled: boolean;
  isDefault: boolean;
  /** Position in the normalized fallback rotation; null outside the rotation. */
  order: number | null;
  /** The cached login status. `unknown` means that no status is cached. */
  status: 'logged_in' | 'logged_out' | 'not_installed' | 'error' | 'unknown';
}

/** The job fields that the router reads. */
export interface FailoverJobView {
  jobId: string;
  sourceType: 'line' | 'ui' | 'schedule';
  accountId: string | null;
  chatType: string | null;
  chatId: string | null;
  provider: AgentProvider;
}

export interface ProviderFailoverDependencies {
  settings: {
    getAgentAutoFailoverEnabled(): Promise<boolean>;
    getAppSetting(key: string): Promise<unknown>;
    getConversationAgent(key: { accountId: string; chatType: 'direct' | 'group' | 'room'; chatId: string }): Promise<{ provider: AgentProvider | null } | null>;
  };
  sources: { list(): Promise<FailoverSourceRow[]> };
  quota: { list(): Promise<Array<{ sourceId: string; blocked: boolean }>> };
  agents: { getRoute(routeKey: string): Promise<Pick<SessionRoute, 'provider' | 'sourceId'> | null> };
}

/**
 * Chooses the provider and account source of a job at the start of its turn.
 * Port of CliTalkAgent `route_session_excluding` (protocol/chat.rs 905-990) with the input of `source_candidates`
 * (provider_failover.rs 503-534). The decision is pure data; AgentService applies it.
 */
export class ProviderFailoverService {
  constructor(private readonly dependencies: ProviderFailoverDependencies) {}

  /** Plan D26: the switch `agent_auto_failover_enabled`. A missing setting means on. */
  async enabled(): Promise<boolean> {
    return this.dependencies.settings.getAgentAutoFailoverEnabled();
  }

  /**
   * The preferred provider. A LINE job follows its chat (the /agent choice, else the global default), like the enqueue.
   * A room or scheduled job has its provider fixed by its submission, so the job keeps it.
   */
  private async preferredProvider(job: FailoverJobView): Promise<AgentProvider> {
    if (job.sourceType === 'line' && job.accountId && job.chatType && job.chatId) {
      const conversation = await this.dependencies.settings.getConversationAgent(
        { accountId: job.accountId, chatType: job.chatType as 'direct' | 'group' | 'room', chatId: job.chatId });
      return resolveChatProvider(this.dependencies.settings, conversation?.provider);
    }
    return job.provider;
  }

  async routeFor(input: { job: FailoverJobView; sessionKey?: SessionKey; sessionGeneration: number; excluded: readonly string[] }): Promise<RouteDecision> {
    const [rows, quotaRows, preferredProvider] = await Promise.all([
      this.dependencies.sources.list(), this.dependencies.quota.list(), this.preferredProvider(input.job)]);
    const excluded = new Set(input.excluded);
    const candidates: RouteCandidate[] = rows
      .filter((row) => row.fallbackEnabled)
      .map((row) => ({ provider: row.provider, sourceId: row.id, isDefault: row.isDefault,
        // CTA status.is_none_or: no cached status counts as available.
        available: row.status !== 'logged_out' && row.status !== 'not_installed' && row.status !== 'error' }))
      .filter((candidate) => !excluded.has(candidate.sourceId));
    // CTA route_session_excluding: a retry that has no candidate left is exhausted, not "no source".
    if (candidates.length === 0 && excluded.size > 0) return { kind: 'all_sources_exhausted' };
    const order = rows.filter((row) => row.order !== null).sort((a, b) => a.order! - b.order!).map((row) => row.id);
    const route = input.sessionKey ? await this.dependencies.agents.getRoute(routeKeyFor(input.sessionKey)) : null;
    const currentSourceId = route && route.provider === input.job.provider ? route.sourceId : null;
    return routeNext({
      preferredProvider,
      currentSourceId,
      candidates,
      normalizedOrder: order,
      failover: { sources: new Map(quotaRows.map((row) => [row.sourceId, { blocked: row.blocked }])) },
    });
  }
}
