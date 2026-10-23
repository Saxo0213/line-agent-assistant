import { describe, expect, it } from 'vitest';
import {
  AGENT_PERMISSIONS, AgentApprovalErrorCodeSchema, IpcEventSchema, AgentPermissionsViewSchema, AgentToolAllowlistEntrySchema, IpcRequestSchema, IpcResultSchema, MCP_TOOL_PERMISSIONS, MCP_TOOL_NAMES,
} from './index.js';

const requestId = 'req-1';
const folderId = '2a653934-7064-4d90-a9f0-e6e24cf4f93d';

describe('Agent permission registry', () => {
  it('validates execution policy IPC values and rejects out-of-range timeouts', () => {
    expect(IpcRequestSchema.safeParse({ type:'setAgentExecutionPolicy',requestId,level:'trust',approvalTimeoutSeconds:180,timeoutAction:'ALLOW',expectedVersion:1 }).success).toBe(true);
    expect(IpcRequestSchema.safeParse({ type:'setAgentExecutionPolicy',requestId,level:'trust',approvalTimeoutSeconds:180,expectedVersion:1 }).success).toBe(false);
    expect(IpcRequestSchema.safeParse({ type:'setAgentExecutionPolicy',requestId,level:'trust',approvalTimeoutSeconds:180,timeoutAction:'sometimes',expectedVersion:1 }).success).toBe(false);
    expect(IpcRequestSchema.safeParse({ type:'setAgentExecutionPolicy',requestId,level:'trust',approvalTimeoutSeconds:9,expectedVersion:1 }).success).toBe(false);
    expect(IpcRequestSchema.safeParse({ type:'removeAgentToolAllowlistEntry',requestId,id:folderId }).success).toBe(true);
    expect(IpcResultSchema.safeParse({ type:'getAgentExecutionPolicy',requestId,ok:true,policy:{level:'workspace_write',approvalTimeoutSeconds:180,timeoutAction:'DENY',version:1,updatedAt:new Date().toISOString()} }).success).toBe(true);
    expect(AgentToolAllowlistEntrySchema.safeParse({ id:folderId, kind:'tool', value:'WebFetch', createdAt:new Date().toISOString() }).success).toBe(true);
    expect(AgentToolAllowlistEntrySchema.safeParse({ id:folderId, kind:'bash_command', value:' git status ', createdAt:new Date().toISOString() }).success).toBe(true);
    expect(AgentToolAllowlistEntrySchema.safeParse({ id:folderId, kind:'bash_head', value:'git status', createdAt:new Date().toISOString() }).success).toBe(false);
  });
  it('holds the five initial entries with the specified defaults and context rules', () => {
    expect(AGENT_PERMISSIONS.map((entry) => [entry.id, entry.defaultEffect, entry.contextRule])).toEqual([
      ['records.query_current_chat', 'ALLOW', 'CURRENT_CHAT'],
      ['records.query_all_chats', 'DENY', 'ACCOUNT'],
      ['chat_folder.read', 'ALLOW', 'CURRENT_CHAT_FOLDER'],
      ['chat_folder.write', 'ALLOW', 'CURRENT_CHAT_FOLDER'],
      ['agent.local_tools', 'DENY', 'PROVIDER_WORKSPACE'],
    ]);
    expect(AGENT_PERMISSIONS.find((entry) => entry.id === 'chat_folder.read')?.label).toBe('讀取本聊天室資料夾');
    expect(AGENT_PERMISSIONS.find((entry) => entry.id === 'chat_folder.write')?.label).toBe('寫入本聊天室資料夾');
    expect(AGENT_PERMISSIONS.find((entry) => entry.id === 'chat_folder.write')?.defaultEffect).toBe('ALLOW');
    for (const entry of AGENT_PERMISSIONS) expect(entry.description.length).toBeGreaterThan(0);
  });

  it('maps every built-in MCP tool to the records permissions', () => {
    for (const tool of MCP_TOOL_NAMES) expect(MCP_TOOL_PERMISSIONS[tool]).toEqual(['records.query_current_chat', 'records.query_all_chats']);
  });
});

describe('permission IPC validation', () => {
  const set = { type: 'setAgentPermission', requestId, accountId: 'acc', subject: { kind: 'USER', mid: 'U1' }, chatType: 'group', chatId: 'C1', permission: 'records.query_all_chats', effect: 'ALLOW', expectedVersion: 0 };

  it('accepts known permissions with ALLOW, DENY and INHERIT, and rejects unknown ids (row 10)', () => {
    for (const effect of ['ALLOW', 'DENY', 'INHERIT']) expect(IpcRequestSchema.safeParse({ ...set, effect }).success).toBe(true);
    expect(IpcRequestSchema.safeParse({ ...set, permission: 'web.search' }).success).toBe(false);
    expect(IpcRequestSchema.safeParse({ ...set, permission: 'group_folder.read' }).success).toBe(false);
    expect(IpcRequestSchema.safeParse({ ...set, effect: 'MAYBE' }).success).toBe(false);
    expect(IpcRequestSchema.safeParse({ ...set, expectedVersion: -1 }).success).toBe(false);
    expect(IpcRequestSchema.safeParse({ ...set, extra: true }).success).toBe(false);
    expect(IpcRequestSchema.safeParse({ ...set, subject: { kind: 'USER' } }).success).toBe(false);
    expect(IpcRequestSchema.safeParse({ ...set, subject: { kind: 'EVERYONE' } }).success).toBe(false);
    expect(IpcRequestSchema.safeParse({ ...set, chatType: 'direct', chatId: '' }).success).toBe(false);
  });

  it('validates folder, link and read requests', () => {
    expect(IpcRequestSchema.safeParse({ type: 'getAgentPermissions', requestId, accountId: 'acc' }).success).toBe(true);
    expect(IpcRequestSchema.safeParse({ type: 'createChatFolder', requestId, accountId: 'acc', chatType: 'direct', chatId: 'U1' }).success).toBe(true);
    expect(IpcRequestSchema.safeParse({ type: 'createChatFolder', requestId, accountId: 'acc', chatType: 'community', chatId: 'U1' }).success).toBe(false);
    expect(IpcRequestSchema.safeParse({ type: 'openChatFolder', requestId, folderId }).success).toBe(true);
    expect(IpcRequestSchema.safeParse({ type: 'openChatFolder', requestId, folderId: 'C:\\Windows' }).success).toBe(false);
    const link = { type: 'setAgentFolderLink', requestId, accountId: 'acc', subjectMid: 'U1', folderId, access: 'READ', expectedVersion: 0 };
    for (const access of ['NONE', 'READ', 'WRITE']) expect(IpcRequestSchema.safeParse({ ...link, access }).success).toBe(true);
    expect(IpcRequestSchema.safeParse({ ...link, access: 'ADMIN' }).success).toBe(false);
    expect(IpcRequestSchema.safeParse({ ...link, folderId: 'not-a-uuid' }).success).toBe(false);
  });

  it('round-trips the permission view and the version-conflict error result', () => {
    const view = { catalog: AGENT_PERMISSIONS.map((entry) => ({ ...entry })), defaults: [{ permission: 'chat_folder.write', effect: 'ALLOW', version: 1 }], subjects: [{ kind: 'USER', mid: 'U1', displayName: 'Alice', grantScope: 'ACCOUNT', chatScopes: [] }],
      rules: [{ subject: { kind: 'USER', mid: 'U1' }, chatType: 'group', chatId: 'C1', permission: 'chat_folder.write', effect: 'ALLOW', version: 2 }],
      links: [{ subjectMid: 'U1', folderId, access: 'READ', version: 1 }],
      folders: [{ folderId, chatType: 'group', chatId: 'C1', title: 'Group', fileCount: 3, bytes: 10 }],
      eligibleChats: [{ chatType: 'direct', chatId: 'U1', title: 'Alice' }], workspaceRoot: 'C:\\workspace' };
    expect(AgentPermissionsViewSchema.safeParse(view).success).toBe(true);
    expect(IpcResultSchema.safeParse({ type: 'getAgentPermissions', requestId, ok: true, view }).success).toBe(true);
    expect(IpcResultSchema.safeParse({ type: 'setAgentPermission', requestId, ok: true, version: 3 }).success).toBe(true);
    expect(IpcRequestSchema.safeParse({ type: 'getAgentPermissionDefaults', requestId }).success).toBe(true);
    expect(IpcRequestSchema.safeParse({ type: 'setAgentPermissionDefault', requestId, permission: 'chat_folder.write', effect: 'DENY', expectedVersion: 0 }).success).toBe(true);
    expect(IpcResultSchema.safeParse({ type: 'getAgentPermissionDefaults', requestId, ok: true, defaults: { rules: [] } }).success).toBe(true);
    expect(IpcResultSchema.safeParse({ type: 'setAgentPermissionDefault', requestId, ok: true, version: 1 }).success).toBe(true);
    expect(IpcResultSchema.safeParse({ type: 'error', requestId, ok: false, code: 'PERMISSION_VERSION_CONFLICT', message: 'x', retryable: false }).success).toBe(true);
    expect(AgentPermissionsViewSchema.safeParse({ ...view, rules: [{ ...view.rules[0], permission: 'unknown.thing' }] }).success).toBe(false);
  });
});

describe('Agent approval IPC', () => {
  const approval = { approvalId: 'appr-1', jobId: 'job-1', tool: 'Bash', summary: 'git status', deadline: new Date().toISOString(), canRemember: true };

  it('validates decide and list requests', () => {
    for (const decision of ['once', 'session', 'always', 'deny']) {
      expect(IpcRequestSchema.safeParse({ type: 'decideAgentApproval', requestId, approvalId: 'appr-1', decision }).success).toBe(true);
    }
    expect(IpcRequestSchema.safeParse({ type: 'decideAgentApproval', requestId, approvalId: 'appr-1', decision: 'forever' }).success).toBe(false);
    expect(IpcRequestSchema.safeParse({ type: 'decideAgentApproval', requestId, approvalId: '', decision: 'once' }).success).toBe(false);
    // The renderer can never name what gets remembered.
    expect(IpcRequestSchema.safeParse({ type: 'decideAgentApproval', requestId, approvalId: 'appr-1', decision: 'always', command: 'rm -rf /' }).success).toBe(false);
    expect(IpcRequestSchema.safeParse({ type: 'listPendingAgentApprovals', requestId }).success).toBe(true);
  });

  it('validates results, error codes and events', () => {
    expect(IpcResultSchema.safeParse({ type: 'decideAgentApproval', requestId, ok: true }).success).toBe(true);
    expect(IpcResultSchema.safeParse({ type: 'listPendingAgentApprovals', requestId, ok: true, approvals: [approval] }).success).toBe(true);
    expect(IpcResultSchema.safeParse({ type: 'listPendingAgentApprovals', requestId, ok: true, approvals: Array.from({ length: 33 }, () => approval) }).success).toBe(false);
    for (const code of AgentApprovalErrorCodeSchema.options) {
      expect(IpcResultSchema.safeParse({ type: 'error', requestId, ok: false, code, message: code, retryable: false }).success).toBe(true);
    }
    expect(IpcEventSchema.safeParse({ type: 'agentApprovalRequested', approval }).success).toBe(true);
    expect(IpcEventSchema.safeParse({ type: 'agentApprovalRequested', approval: { ...approval, summary: 'x'.repeat(5000) } }).success).toBe(true);
    expect(IpcEventSchema.safeParse({ type: 'agentApprovalRequested', approval: { ...approval, deadline: 'soon' } }).success).toBe(false);
    expect(IpcEventSchema.safeParse({ type: 'agentApprovalRequested', approval: { ...approval, tool: '' } }).success).toBe(false);
    for (const outcome of ['allowed', 'denied', 'timeout', 'cancelled']) {
      expect(IpcEventSchema.safeParse({ type: 'agentApprovalResolved', approvalId: 'appr-1', jobId: 'job-1', outcome }).success).toBe(true);
    }
    expect(IpcEventSchema.safeParse({ type: 'agentApprovalResolved', approvalId: 'appr-1', jobId: 'job-1', outcome: 'maybe' }).success).toBe(false);
    expect(IpcEventSchema.safeParse({ type: 'agentExecutionPolicyChanged' }).success).toBe(true);
    expect(IpcEventSchema.safeParse({ type: 'agentExecutionPolicyChanged', policy: {} }).success).toBe(false);
  });
});
