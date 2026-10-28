import type { AgentProvider } from '@line-agent/contracts';

/** The Settings 預設 Agent rule: only the stored value `codex` selects Codex; a missing or invalid value means Claude. */
export function normalizeDefaultProvider(value: unknown): AgentProvider {
  return value === 'codex' ? 'codex' : 'claude';
}

/** A chat's Agent: its /agent override when set, else the global default. */
export async function resolveChatProvider(settings: { getAppSetting(key: string): Promise<unknown> },
  override: AgentProvider | null | undefined): Promise<AgentProvider> {
  return override ?? await resolveDefaultProvider(settings);
}

/** The global default Agent (app setting `default_provider`), which LINE routing and free mode use instead of the per-conversation column. */
export async function resolveDefaultProvider(settings: { getAppSetting(key: string): Promise<unknown> }): Promise<AgentProvider> {
  return normalizeDefaultProvider(await settings.getAppSetting('default_provider'));
}
