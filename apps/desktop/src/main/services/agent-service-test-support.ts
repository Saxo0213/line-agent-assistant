import { AgentService } from './agent-service.js';
import type { AgentJobEnvironment } from './agent-job-environment.js';

type Parameters_ = ConstructorParameters<typeof AgentService>;
type Leading = Parameters_ extends [...infer Head, AgentJobEnvironment, unknown?, unknown?, unknown?] ? Head : never;
type TestArguments = Leading extends [infer A, infer B, infer C, ...infer Rest] ? [A, B, C, ...Partial<Rest>] : never;

/** Test-only environment: the job's stored workspace with the full tool set (what jobs used to get). */
export const fullToolsEnvironment: AgentJobEnvironment = {
  prepare: async (_jobId, topLayer) => ({ ok: true, workspacePath: topLayer ?? 'C:\\workspace',
    tools: { localTools: true, fileRead: true, fileWrite: true, linkedReadDirs: [], projectDirs: [], workspaceRootDir: null, level: 'workspace_write', webTools: false, interactiveApproval:false } }),
};

const LEADING_LENGTH = 13;

/** Builds an AgentService for tests that only care about a prefix of the constructor arguments. */
export function newAgentService(...args: TestArguments): AgentService {
  const padded: unknown[] = Array.from({ length: LEADING_LENGTH }, (_, index) => args[index]);
  return new AgentService(...(padded as Leading), fullToolsEnvironment);
}
