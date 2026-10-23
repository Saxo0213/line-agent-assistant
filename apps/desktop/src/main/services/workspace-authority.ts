import { realpath, stat } from 'node:fs/promises';
import { isAbsolute } from 'node:path';

export class InvalidWorkspaceError extends Error {
  readonly code = 'INVALID_WORKSPACE';
  constructor(message = 'Select an existing absolute workspace directory in Settings → Agent.') { super(message); }
}
export async function validateWorkspace(candidate: unknown): Promise<string> {
  if (typeof candidate !== 'string' || !candidate.trim() || !isAbsolute(candidate)) throw new InvalidWorkspaceError();
  try {
    const canonical = await realpath(candidate);
    if (!(await stat(canonical)).isDirectory()) throw new InvalidWorkspaceError();
    return canonical;
  } catch { throw new InvalidWorkspaceError(); }
}
export type WorkspaceInspection =
  | { status: 'available'; version: number; path: string }
  | { status: 'unavailable'; version: number; configuredPath: string | null; reason: string };
interface WorkspaceSettings {
  getAppSetting(key: string): Promise<unknown>;
  setAppSetting(key: string, value: string): Promise<void>;
}
export class WorkspaceAuthority {
  private snapshot: Readonly<{ version: number; configuredPath: unknown }>;
  private commits: Promise<void> = Promise.resolve();
  private constructor(private readonly settings: WorkspaceSettings, configuredPath: unknown) {
    this.snapshot = Object.freeze({ version: 0, configuredPath });
  }
  static async load(settings: WorkspaceSettings, defaultPath?: string): Promise<WorkspaceAuthority> {
    const configured = await settings.getAppSetting('workspace_path');
    const authority = new WorkspaceAuthority(settings, configured);
    if (configured === null && defaultPath !== undefined) await authority.configure(defaultPath);
    return authority;
  }
  async current(): Promise<string> {
    const snapshot = this.snapshot;
    return validateWorkspace(snapshot.configuredPath);
  }
  async inspect(): Promise<WorkspaceInspection> {
    const snapshot = this.snapshot;
    try { return { status: 'available', version: snapshot.version, path: await validateWorkspace(snapshot.configuredPath) }; }
    catch {
      const wellFormed = typeof snapshot.configuredPath === 'string' && isAbsolute(snapshot.configuredPath);
      return { status: 'unavailable', version: snapshot.version,
        configuredPath: wellFormed ? snapshot.configuredPath as string : null,
        reason: wellFormed ? 'Configured workspace is unavailable. Select an existing directory in Settings → Agent.'
          : 'Workspace setting is malformed. Select an absolute directory in Settings → Agent.' };
    }
  }
  async configure(candidate: string): Promise<string> {
    const canonical = await validateWorkspace(candidate);
    const commit = this.commits.then(async () => {
      await this.settings.setAppSetting('workspace_path', canonical);
      this.snapshot = Object.freeze({ version: this.snapshot.version + 1, configuredPath: canonical });
    });
    this.commits = commit.catch(() => undefined);
    await commit;
    return canonical;
  }
}
