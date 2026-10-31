import type {AgentMcpLaunch} from '@line-agent/contracts';

/** Child-environment variable that carries the per-run internal MCP capability. */
export const INTERNAL_MCP_TOKEN_ENV='LINEJS_INTERNAL_MCP_TOKEN';
/** Claude's per-tool MCP timeout variable; send_to_target can wait for a paced queue of LINE sends. */
export const CLAUDE_MCP_TOOL_TIMEOUT_ENV='MCP_TOOL_TIMEOUT';
/** Provider-side MCP tool timeout for the linejs server (matches the 600 s send_to_target backstop). */
export const LINEJS_MCP_TOOL_TIMEOUT_SEC=600;
export const LINEJS_MCP_SERVER='linejs';
export const claudePermissionPromptToolName=`mcp__${LINEJS_MCP_SERVER}__request_permission`;
/**
 * Fixed tool catalog exposed to built-in Agents. The server still hides query_agent_room_history outside the Agent room,
 * and the send and schedule tools from every principal except the Primary Admin and the desktop operator.
 */
export const LINEJS_MCP_TOOLS=['list_targets','query_target_messages','query_target_messages_by_time','list_active_chats','query_agent_room_history','list_send_targets','send_to_target','list_schedules','create_schedule','update_schedule','delete_schedule'] as const;
/** Claude's qualified MCP tool names. */
export const claudeMcpToolNames=()=>LINEJS_MCP_TOOLS.map(tool=>`mcp__${LINEJS_MCP_SERVER}__${tool}`);

/** Launch-only Claude MCP config. The bearer value is a variable reference resolved from the child environment. */
export function claudeMcpConfig(mcp:AgentMcpLaunch|undefined,extensionServers:Record<string,Record<string,unknown>>={}):string {
  const linejs=mcp?{[LINEJS_MCP_SERVER]:{type:'http',url:mcp.endpoint,headers:{Authorization:`Bearer \${${INTERNAL_MCP_TOKEN_ENV}}`}}}:{};
  // linejs is listed first and an extension of the same name can never replace it.
  return JSON.stringify({mcpServers:{...linejs,...Object.fromEntries(Object.entries(extensionServers).filter(([name])=>name!==LINEJS_MCP_SERVER))}});
}
/** Launch-only Codex `-c` overrides; they reference the token env var by name only. */
export function codexMcpOverrides(mcp:AgentMcpLaunch):string[] {
  const prefix=`mcp_servers.${LINEJS_MCP_SERVER}`;
  return [
    '-c',`${prefix}.url=${JSON.stringify(mcp.endpoint)}`,
    '-c',`${prefix}.bearer_token_env_var=${JSON.stringify(INTERNAL_MCP_TOKEN_ENV)}`,
    '-c',`${prefix}.enabled_tools=${JSON.stringify([...LINEJS_MCP_TOOLS])}`,
    '-c',`${prefix}.tool_timeout_sec=${LINEJS_MCP_TOOL_TIMEOUT_SEC}`,
    // Per-tool approval (McpServerToolConfig.approval_mode); the Primary Admin's own request is the approval for sends.
    ...LINEJS_MCP_TOOLS.flatMap(tool=>['-c',`${prefix}.tools.${tool}.approval_mode="approve"`]),
  ];
}
