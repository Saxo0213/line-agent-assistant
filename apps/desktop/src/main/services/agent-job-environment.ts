import { realpath } from 'node:fs/promises';
import type { AgentRunExtensions, AgentToolPolicy } from '@line-agent/contracts';
import { deriveToolPolicy, type JobPolicy } from '@line-agent/database';
import type { AgentExecutionLevel } from '@line-agent/contracts';
import type { ChatFolderService } from './chat-folders.js';

export type AgentJobPlan =
  | { ok: true; workspacePath: string; tools: AgentToolPolicy; extensions?: AgentRunExtensions }
  | { ok: false; code: string; message: string };

/** Main-owned decision of where a job runs and which provider tools it gets; consumed by agent-service. */
export interface AgentJobEnvironment {
  /** `topLayer` is the workspace stored on the job row; the bridge validates it exactly as before. */
  prepare(jobId: string, topLayer?: string): Promise<AgentJobPlan>;
}

export interface AgentJobEnvironmentDependencies {
  resolvePolicy(jobId: string): Promise<JobPolicy | null>;
  getExecutionLevel?(): Promise<AgentExecutionLevel>;
  /** Stored extra MCP servers (secrets opened) and built-in tool additions; consulted only for eligible principals. */
  resolveExtensions?(): Promise<AgentRunExtensions | null>;
  folders: Pick<ChatFolderService, 'resolve'>;
  /** The chat's /folder bindings, re-validated now (missing or relocated folders already left out and audited). */
  resolveProjectFolders?(key: { accountId: string; chatType: string; chatId: string }): Promise<Array<{ path: string; mode: 'READ' | 'READ_WRITE' }>>;
  workspace: { current(): Promise<string> };
}

/**
 * Who may use the user's extra MCP servers and built-in tool additions: the desktop operator (Agent room and schedules) and the
 * Primary Admin. The principal comes from the durable job row; group/room members and free-mode jobs resolve to `user`.
 */
export const extensionsEligible = (policy: Pick<JobPolicy, 'principal'> | null): boolean =>
  policy?.principal.kind === 'operator' || policy?.principal.kind === 'admin';

/** Adds the project folders: reading them needs the file read tools, writing a writable one needs the file write tools. */
function withProjectDirs(tools: AgentToolPolicy, projectDirs: AgentToolPolicy['projectDirs']): AgentToolPolicy {
  return projectDirs.length === 0 ? tools
    : { ...tools, fileRead: true, fileWrite: tools.fileWrite || projectDirs.some((dir) => dir.writable), projectDirs,
      ...(!tools.fileWrite && projectDirs.some((dir) => dir.writable) ? { ownFolderReadOnly: true } : {}) };
}

const fail = (code: string, message: string): AgentJobPlan => ({ ok: false, code, message });

/**
 * Workspace selection, from the durable job row only:
 *  - UI job and primary-admin 1:1       -> the configured workspace (top layer), full tools
 *  - primary admin in a group/room      -> that group's folder, full tools
 *  - whitelisted user (group/room, 1:1) -> the chat's own folder (groups\ or chats\), tools per permission,
 *                                          plus one read-only mount per linked group folder
 * Anything unresolvable fails closed before a CLI starts.
 */
export class AgentJobEnvironmentService implements AgentJobEnvironment {
  constructor(private readonly dependencies: AgentJobEnvironmentDependencies) {}

  async prepare(jobId: string, topLayer?: string): Promise<AgentJobPlan> {
    const resolved: { policy: JobPolicy | null } = { policy: null };
    const plan = await this.prepareWorkspace(jobId, topLayer, resolved);
    if (!plan.ok || !this.dependencies.resolveExtensions || !extensionsEligible(resolved.policy)) return plan;
    // Extras are an addition: if they cannot be read the job still runs with exactly the tools it had before.
    let extensions: AgentRunExtensions | null = null;
    try { extensions = await this.dependencies.resolveExtensions(); } catch { extensions = null; }
    return extensions ? { ...plan, extensions } : plan;
  }

  /**
   * The chat's /folder project folders for this job. Admin: all of them. Whitelisted user (free-mode members included): only with
   * project_folder.read ALLOW. A folder is writable only when it was bound READ_WRITE, the principal has project_folder.write and
   * the execution level is not read_only. Operator jobs have no chat and mount nothing; anything unresolvable mounts nothing.
   */
  private async projectDirs(policy: JobPolicy, level: AgentExecutionLevel): Promise<AgentToolPolicy['projectDirs']> {
    const { principal, accountId, chatType, chatId } = policy;
    if (!this.dependencies.resolveProjectFolders || (principal.kind !== 'admin' && principal.kind !== 'user')
      || accountId === null || chatType === null || chatId === null || policy.permissions['project_folder.read'] !== 'ALLOW') return [];
    let mounts: Awaited<ReturnType<NonNullable<AgentJobEnvironmentDependencies['resolveProjectFolders']>>>;
    try { mounts = await this.dependencies.resolveProjectFolders({ accountId, chatType, chatId }); } catch { return []; }
    const mayWrite = policy.permissions['project_folder.write'] === 'ALLOW' && level !== 'read_only';
    return mounts.map((mount) => ({ path: mount.path, writable: mount.mode === 'READ_WRITE' && mayWrite }));
  }

  private async prepareWorkspace(jobId: string, topLayer: string | undefined, resolved: { policy: JobPolicy | null }): Promise<AgentJobPlan> {
    let policy: JobPolicy | null;
    try { policy = await this.dependencies.resolvePolicy(jobId); }
    catch { return fail('JOB_POLICY_UNRESOLVED', 'The Agent job permissions could not be resolved.'); }
    resolved.policy = policy;
    if (!policy || policy.principal.kind === 'unresolved') return fail('JOB_POLICY_UNRESOLVED', 'The Agent job permissions could not be resolved.');
    let level: AgentExecutionLevel = 'workspace_write';
    try { level = await this.dependencies.getExecutionLevel?.() ?? level; }
    catch { return fail('EXECUTION_POLICY_UNAVAILABLE', 'The Agent execution policy could not be loaded.'); }
    const tools = deriveToolPolicy(policy, level);
    try {
      if (policy.principal.kind === 'operator') {
        return { ok: true, workspacePath: topLayer ?? await realpath(await this.dependencies.workspace.current()), tools };
      }
      if (policy.principal.kind === 'admin' && policy.chatType === 'direct') {
        return { ok: true, workspacePath: topLayer ?? await realpath(await this.dependencies.workspace.current()),
          tools: withProjectDirs(tools, await this.projectDirs(policy, level)) };
      }
      if (policy.accountId === null || policy.chatType === null || policy.chatId === null) {
        return fail('JOB_POLICY_UNRESOLVED', 'The Agent job permissions could not be resolved.');
      }
      const own = await this.dependencies.folders.resolve(policy.accountId, policy.chatType, policy.chatId, 'system:agent-job');
      // The admin/operator layer is the whole system: below the top layer it still mounts the workspace root.
      // Whitelisted users never get it.
      if (policy.principal.kind === 'admin') {
        return { ok: true, workspacePath: own.path, tools: withProjectDirs({ ...tools, workspaceRootDir: await realpath(await this.dependencies.workspace.current()) },
          await this.projectDirs(policy, level)) };
      }
      const linkedReadDirs: string[] = [];
      for (const linked of policy.linkedChats) {
        linkedReadDirs.push((await this.dependencies.folders.resolve(policy.accountId, linked.chatType, linked.chatId, 'system:agent-job')).path);
      }
      const projectDirs = await this.projectDirs(policy, level);
      return { ok: true, workspacePath: own.path,
        tools: withProjectDirs(linkedReadDirs.length > 0 ? { ...tools, fileRead: true, linkedReadDirs } : tools, projectDirs) };
    } catch (error) {
      const code = (error as { code?: unknown }).code === 'CHAT_FOLDER_UNAVAILABLE' ? 'CHAT_FOLDER_UNAVAILABLE' : 'WORKSPACE_UNAVAILABLE';
      return fail(code, code === 'CHAT_FOLDER_UNAVAILABLE'
        ? 'The chat folder is unavailable or escapes the workspace.' : 'The Agent workspace is unavailable.');
    }
  }
}
