import type { AgentExecutionLevel } from './agent-permissions.js';

export type ExecutionAllowlist = ReadonlyArray<{ kind: 'tool' | 'bash_command'; value: string }>;
export type ExecutionPrincipalKind = 'operator' | 'admin' | 'user' | 'unresolved';
export type ToolUseDecision = 'allow' | 'deny' | 'ask';
export type WritePathEvidence = { resolvedTarget: string; resolvedWorkspaceRoot: string };
export const BASH_COMMAND_MAX_LENGTH = 2000;

const reads = new Set(['Read', 'Glob', 'Grep']);
const writes = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit']);
const queryMcpTools = new Set(['mcp__linejs__list_targets', 'mcp__linejs__query_target_messages', 'mcp__linejs__query_target_messages_by_time', 'mcp__linejs__query_agent_room_history']);

function pathInsideWorkspace(value: unknown, workspaceRoot: string): boolean {
  if (typeof value !== 'string' || !value.trim() || !workspaceRoot.trim()) return false;
  const norm = (p: string) => {
    const source = p.replace(/\//g, '\\').replace(/\\+/g, '\\');
    const prefix = /^[A-Za-z]:/.test(source) ? source.slice(0, 2).toLowerCase() : source.startsWith('\\') ? '\\' : '';
    const stack: string[] = [];
    for (const part of source.slice(prefix === '\\' ? 1 : /^[A-Za-z]:/.test(source) ? 2 : 0).split('\\')) {
      if (!part || part === '.') continue;
      if (part === '..') { if (stack.length) stack.pop(); else stack.push('..'); }
      else stack.push(part.toLowerCase());
    }
    return `${prefix}${stack.join('\\')}`.replace(/\\$/, '');
  };
  const raw = value.trim();
  if (!/^[A-Za-z]:[\\/]/.test(raw) && !/^\/(?!\/)/.test(raw)) return false;
  const path = norm(raw), root = norm(workspaceRoot.trim()).replace(/\\$/, '');
  if (/^(?:\\\\|\/\/)/.test(raw) || /^[A-Za-z]:/.test(path) && !/^[A-Za-z]:/.test(root)) return false;
  if (/^[A-Za-z]:/i.test(path) && (path[0] ?? '').toLowerCase() !== (root[0] ?? '').toLowerCase()) return false;
  return path.toLowerCase() === root.toLowerCase() || path.toLowerCase().startsWith(`${root.toLowerCase()}\\`);
}

export function decideToolUse(
  level: AgentExecutionLevel,
  allowlists: ExecutionAllowlist,
  principalKind: ExecutionPrincipalKind,
  tool: string,
  input: unknown,
  pathEvidence: WritePathEvidence | null,
): ToolUseDecision {
  if (principalKind === 'unresolved') return 'deny';
  // The broker applies the same exact-command policy to the prompt result.
  if (tool.toLowerCase() === 'bash') {
    if (principalKind !== 'operator' || level === 'read_only') return 'deny';
    if (level === 'full') return 'allow';
    const command = (input as {command?: unknown} | null)?.command;
    if (typeof command !== 'string' || !command.length) return 'deny';
    return allowlists.some((entry) => entry.kind === 'bash_command' && entry.value === command) ? 'allow' : 'ask';
  }
  const allowlisted = allowlists.some((entry) => entry.kind === 'tool' && entry.value.toLowerCase() === tool.toLowerCase());
  if (writes.has(tool)) {
    if (level === 'read_only') return 'deny';
    if (level === 'full' || (pathEvidence !== null && pathInsideWorkspace(pathEvidence.resolvedTarget, pathEvidence.resolvedWorkspaceRoot))) return 'allow';
    return principalKind === 'operator' ? 'ask' : 'deny';
  }
  if (reads.has(tool)) return 'allow';
  if (queryMcpTools.has(tool)) return 'allow';
  if (level === 'full') return 'allow';
  if (level === 'trust' && ['WebFetch', 'WebSearch'].includes(tool)) return 'allow';
  const result = allowlisted ? 'allow' : 'ask';
  return result === 'ask' && principalKind !== 'operator' ? 'deny' : result;
}
