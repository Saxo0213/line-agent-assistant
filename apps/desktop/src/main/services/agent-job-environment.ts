import { realpath } from 'node:fs/promises';
import type { AgentToolPolicy } from '@line-agent/contracts';
import { deriveToolPolicy, type JobPolicy } from '@line-agent/database';
import type { AgentExecutionLevel } from '@line-agent/contracts';
import type { ChatFolderService } from './chat-folders.js';

export type AgentJobPlan =
  | { ok: true; workspacePath: string; tools: AgentToolPolicy }
  | { ok: false; code: string; message: string };

/** Main-owned decision of where a job runs and which provider tools it gets; consumed by agent-service. */
export interface AgentJobEnvironment {
  /** `topLayer` is the workspace stored on the job row; the bridge validates it exactly as before. */
  prepare(jobId: string, topLayer?: string): Promise<AgentJobPlan>;
}

export interface AgentJobEnvironmentDependencies {
  resolvePolicy(jobId: string): Promise<JobPolicy | null>;
  getExecutionLevel?(): Promise<AgentExecutionLevel>;
  folders: Pick<ChatFolderService, 'resolve'>;
  workspace: { current(): Promise<string> };
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
    let policy: JobPolicy | null;
    try { policy = await this.dependencies.resolvePolicy(jobId); }
    catch { return fail('JOB_POLICY_UNRESOLVED', 'The Agent job permissions could not be resolved.'); }
    if (!policy || policy.principal.kind === 'unresolved') return fail('JOB_POLICY_UNRESOLVED', 'The Agent job permissions could not be resolved.');
    let level: AgentExecutionLevel = 'workspace_write';
    try { level = await this.dependencies.getExecutionLevel?.() ?? level; }
    catch { return fail('EXECUTION_POLICY_UNAVAILABLE', 'The Agent execution policy could not be loaded.'); }
    const tools = deriveToolPolicy(policy, level);
    try {
      if (policy.principal.kind === 'operator'
        || (policy.principal.kind === 'admin' && policy.chatType === 'direct')) {
        return { ok: true, workspacePath: topLayer ?? await realpath(await this.dependencies.workspace.current()), tools };
      }
      if (policy.accountId === null || policy.chatType === null || policy.chatId === null) {
        return fail('JOB_POLICY_UNRESOLVED', 'The Agent job permissions could not be resolved.');
      }
      const own = await this.dependencies.folders.resolve(policy.accountId, policy.chatType, policy.chatId, 'system:agent-job');
      // The admin/operator layer is the whole system: below the top layer it still mounts the workspace root.
      // Whitelisted users never get it.
      if (policy.principal.kind === 'admin') {
        return { ok: true, workspacePath: own.path, tools: { ...tools, workspaceRootDir: await realpath(await this.dependencies.workspace.current()) } };
      }
      const linkedReadDirs: string[] = [];
      for (const linked of policy.linkedChats) {
        linkedReadDirs.push((await this.dependencies.folders.resolve(policy.accountId, linked.chatType, linked.chatId, 'system:agent-job')).path);
      }
      return { ok: true, workspacePath: own.path,
        tools: linkedReadDirs.length > 0 ? { ...tools, fileRead: true, linkedReadDirs } : tools };
    } catch (error) {
      const code = (error as { code?: unknown }).code === 'CHAT_FOLDER_UNAVAILABLE' ? 'CHAT_FOLDER_UNAVAILABLE' : 'WORKSPACE_UNAVAILABLE';
      return fail(code, code === 'CHAT_FOLDER_UNAVAILABLE'
        ? 'The chat folder is unavailable or escapes the workspace.' : 'The Agent workspace is unavailable.');
    }
  }
}
