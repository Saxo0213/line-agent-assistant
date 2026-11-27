import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

export interface AgentUpgradeNotice {
  /** The app version that the notice text names. */
  readonly version: string;
  /** True once for each pending provider session ID. The ID is removed and the state file is written. */
  take(externalSessionId: string): boolean;
}

export interface AgentUpgradeNoticeOptions {
  file: string;
  version: string;
  listSessionIds: () => Promise<string[]>;
  onError?: (error: unknown) => void;
}

/** Builds the one-time notice text for the first resumed job of a session that existed before an app version change. */
export function agentUpgradeNoticeText(version: string): string {
  return `【系統通知】應用程式已更新到 ${version}，MCP 工具已更新。這段對話中較早載入的工具說明是舊版本，不要依賴它們；使用任何 linejs 工具前，請重新載入它的工具規格（例如用 ToolSearch 選取工具名稱），以目前的工具規格為準。`;
}

/**
 * State file: { version, pending }. At startup, a different or missing version (or bad JSON) lists all existing provider session IDs
 * as pending. The same version keeps the pending list. It never throws.
 */
export async function prepareAgentUpgradeNotice(options: AgentUpgradeNoticeOptions): Promise<AgentUpgradeNotice> {
  const { file, version, listSessionIds, onError } = options;
  const report = (error: unknown) => { try { onError?.(error); } catch { /* The report must not throw. */ } };
  const write = async (pending: string[]) => {
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, JSON.stringify({ version, pending }), 'utf8');
  };
  let pending = new Set<string>();
  try {
    type Stored = { version?: unknown; pending?: unknown };
    let stored: Stored | null = null;
    try { stored = JSON.parse(await readFile(file, 'utf8')) as Stored | null; } catch { stored = null; }
    if (stored && stored.version === version && Array.isArray(stored.pending)) {
      pending = new Set((stored.pending as unknown[]).filter((id): id is string => typeof id === 'string'));
    } else {
      pending = new Set(await listSessionIds());
      await write([...pending]);
    }
  } catch (error) {
    report(error);
  }
  // One promise chain: writes run one after another, and each one writes the pending set as it is when the write runs.
  let chain: Promise<void> = Promise.resolve();
  return {
    version,
    take(externalSessionId: string): boolean {
      if (!pending.delete(externalSessionId)) return false;
      chain = chain.then(() => write([...pending])).catch(report);
      return true;
    },
  };
}
