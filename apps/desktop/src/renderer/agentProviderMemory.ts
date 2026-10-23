import { AGENT_ROOM_ID, type AgentProvider, type ConversationKey } from '@line-agent/contracts';

/**
 * Remembers the Agent provider picked in a room. UI-only convenience: LINE-triggered jobs use the
 * database default provider, never this value. Every storage access is guarded; failures are ignored.
 */
export const AGENT_PROVIDER_KEY_PREFIX = 'linejs.agentProvider.v1:';
export const AGENT_PROVIDER_MAX_ENTRIES = 500;
const PROVIDERS: readonly AgentProvider[] = ['codex', 'claude'];

const storage = (): Storage | null => {
  try { return typeof localStorage === 'undefined' ? null : localStorage; } catch { return null; }
};

/** The shared Agent room belongs to no LINE account, so it is one entry: `linejs.agentProvider.v1:agent-room`. */
export const agentProviderKey = (route: ConversationKey) => route.accountId === AGENT_ROOM_ID && route.chatId === AGENT_ROOM_ID
  ? `${AGENT_PROVIDER_KEY_PREFIX}${AGENT_ROOM_ID}`
  : `${AGENT_PROVIDER_KEY_PREFIX}${route.accountId}:${route.chatType}:${route.chatId}`;

function parse(raw: string | null): { provider: AgentProvider; at: number } | null {
  if (!raw) return null;
  try {
    const value = JSON.parse(raw) as { provider?: unknown; at?: unknown };
    if (typeof value.provider !== 'string' || !(PROVIDERS as readonly string[]).includes(value.provider)) return null;
    return { provider: value.provider as AgentProvider, at: typeof value.at === 'number' ? value.at : 0 };
  } catch { return null; }
}

/** Returns the remembered provider, or null when absent/invalid/unreadable. */
export function readAgentProvider(route: ConversationKey, available: readonly AgentProvider[] = PROVIDERS): AgentProvider | null {
  try {
    const entry = parse(storage()?.getItem(agentProviderKey(route)) ?? null);
    return entry && available.includes(entry.provider) ? entry.provider : null;
  } catch { return null; }
}

export function writeAgentProvider(route: ConversationKey, provider: AgentProvider): void {
  try {
    const store = storage();
    if (!store) return;
    const key = agentProviderKey(route);
    store.setItem(key, JSON.stringify({ provider, at: Date.now() }));
    const entries: Array<{ key: string; at: number }> = [];
    for (let index = 0; index < store.length; index += 1) {
      const name = store.key(index);
      if (name?.startsWith(AGENT_PROVIDER_KEY_PREFIX)) entries.push({ key: name, at: parse(store.getItem(name))?.at ?? 0 });
    }
    if (entries.length <= AGENT_PROVIDER_MAX_ENTRIES) return;
    entries.sort((left, right) => left.at - right.at);
    for (const stale of entries.slice(0, entries.length - AGENT_PROVIDER_MAX_ENTRIES)) {
      if (stale.key !== key) store.removeItem(stale.key);
    }
  } catch { /* storage unavailable or full: the selection simply is not remembered */ }
}
