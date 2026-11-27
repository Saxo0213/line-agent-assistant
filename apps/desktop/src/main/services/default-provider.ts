import type { AgentProvider } from '@line-agent/contracts';

/** The Settings 預設 Agent rule: only the stored value `codex` selects Codex; a missing or invalid value means Claude. */
export function normalizeDefaultProvider(value: unknown): AgentProvider {
  return value === 'codex' ? 'codex' : 'claude';
}

const installStatus = new Map<AgentProvider, string>();

/** Records the last observed CLI status of a provider (written by the health service; read only by the default rule). */
export function noteProviderInstallStatus(provider: AgentProvider, status: string): void {
  installStatus.set(provider, status);
}

/**
 * The effective default Agent (read-time rule, nothing is written): the stored choice when its CLI is not `not_installed`;
 * else the other provider when it is not `not_installed`. With nothing stored, Codex wins only when it is logged in and Claude is not.
 * When neither CLI is installed the stored choice, else Claude, stays.
 */
export function effectiveDefaultProvider(stored: unknown): AgentProvider {
  const explicit = stored === 'codex' || stored === 'claude' ? stored : null;
  const installed = (provider: AgentProvider) => installStatus.get(provider) !== 'not_installed';
  const order: AgentProvider[] = explicit ? [explicit, explicit === 'codex' ? 'claude' : 'codex']
    : installStatus.get('codex') === 'logged_in' && installStatus.get('claude') !== 'logged_in' ? ['codex', 'claude'] : ['claude', 'codex'];
  return order.find(installed) ?? explicit ?? 'claude';
}

/** A chat's Agent: its /agent override when set, else the global default. */
export async function resolveChatProvider(settings: { getAppSetting(key: string): Promise<unknown> },
  override: AgentProvider | null | undefined): Promise<AgentProvider> {
  return override ?? await resolveDefaultProvider(settings);
}

/** The global default Agent (app setting `default_provider`), which LINE routing and free mode use instead of the per-conversation column. */
export async function resolveDefaultProvider(settings: { getAppSetting(key: string): Promise<unknown> }): Promise<AgentProvider> {
  return effectiveDefaultProvider(await settings.getAppSetting('default_provider'));
}
