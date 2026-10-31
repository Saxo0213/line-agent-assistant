import { z } from 'zod';
import type { McpToolName } from './mcp.js';

/**
 * Code-owned registry of Agent permissions. Adding a capability means adding one entry here plus its
 * enforcement point; the database stores only (permission id, effect) rows, validated against this list.
 */
export type AgentPermissionEffect = 'ALLOW' | 'DENY';
export type AgentPermissionContextRule =
  /** Only the job's own (account, chat_type, chat_id). */
  | 'CURRENT_CHAT'
  /** Every chat of the job's own account; never granted implicitly. */
  | 'ACCOUNT'
  /** Only the folder of the job's own chat (group/room or friend 1:1). */
  | 'CURRENT_CHAT_FOLDER'
  /** Provider built-in file/shell tools in the layer the job runs in. */
  | 'PROVIDER_WORKSPACE';

export interface AgentPermissionDefinition {
  readonly id: string;
  readonly label: string;
  readonly description: string;
  readonly defaultEffect: AgentPermissionEffect;
  readonly contextRule: AgentPermissionContextRule;
}

export const AGENT_PERMISSIONS = [
  { id: 'records.query_current_chat', label: '查詢本聊天室紀錄', description: '允許 Agent 查詢觸發它的這個聊天室的訊息紀錄。',
    defaultEffect: 'ALLOW', contextRule: 'CURRENT_CHAT' },
  { id: 'records.query_all_chats', label: '查詢所有聊天室紀錄', description: '允許 Agent 查詢此帳號所有聊天室的訊息紀錄。',
    defaultEffect: 'DENY', contextRule: 'ACCOUNT' },
  { id: 'chat_folder.read', label: '讀取本聊天室資料夾', description: '允許 Agent 讀取本聊天室（群組或好友 1:1）資料夾內的筆記、整理過的紀錄與檔案。',
    defaultEffect: 'ALLOW', contextRule: 'CURRENT_CHAT_FOLDER' },
  { id: 'chat_folder.write', label: '寫入本聊天室資料夾', description: '允許 Agent 在本聊天室（群組或好友 1:1）資料夾內建立與修改檔案。',
    defaultEffect: 'ALLOW', contextRule: 'CURRENT_CHAT_FOLDER' },
  { id: 'agent.local_tools', label: '使用本機工作區（讀檔／執行指令）', description: '允許 Agent 使用 CLI 內建的檔案與指令工具（不受聊天室資料夾限制）。',
    defaultEffect: 'DENY', contextRule: 'PROVIDER_WORKSPACE' },
  { id: 'project_folder.read', label: '讀取專案資料夾', description: '允許 Agent 讀取管理者以 /folder 綁定到本聊天室的公司專案資料夾。',
    defaultEffect: 'DENY', contextRule: 'CURRENT_CHAT' },
  { id: 'project_folder.write', label: '寫入專案資料夾', description: '允許 Agent 在管理者以 /folder rw 綁定為可讀寫的專案資料夾內建立與修改檔案。',
    defaultEffect: 'DENY', contextRule: 'CURRENT_CHAT' },
] as const satisfies readonly AgentPermissionDefinition[];

export type AgentPermissionId = (typeof AGENT_PERMISSIONS)[number]['id'];
export const AGENT_PERMISSION_IDS = AGENT_PERMISSIONS.map((entry) => entry.id) as readonly AgentPermissionId[];
export const AgentPermissionIdSchema = z.custom<AgentPermissionId>(
  (value) => typeof value === 'string' && (AGENT_PERMISSION_IDS as readonly string[]).includes(value),
  { message: 'Unknown Agent permission id.' },
);
export const AgentPermissionEffectSchema = z.enum(['ALLOW', 'DENY']);
export const AgentExecutionLevelSchema = z.enum(['read_only', 'workspace_write', 'trust', 'full']);
export type AgentExecutionLevel = z.infer<typeof AgentExecutionLevelSchema>;
export const AgentApprovalTimeoutActionSchema = z.enum(['ALLOW', 'DENY']);
export type AgentApprovalTimeoutAction = z.infer<typeof AgentApprovalTimeoutActionSchema>;
export const AgentExecutionPolicySchema = z.strictObject({
  level: AgentExecutionLevelSchema,
  approvalTimeoutSeconds: z.number().int().min(10).max(900),
  timeoutAction: AgentApprovalTimeoutActionSchema,
  version: z.number().int().positive(),
  updatedAt: z.iso.datetime({ offset: true }),
});
export type AgentExecutionPolicy = z.infer<typeof AgentExecutionPolicySchema>;
export const AgentToolAllowlistEntrySchema = z.strictObject({
  id: z.uuid(), kind: z.enum(['tool','bash_command']), value: z.string().min(1), createdAt: z.iso.datetime({ offset: true }),
}).superRefine((entry, ctx) => {
  if (entry.value.length > (entry.kind === 'tool' ? 136 : 2000)) ctx.addIssue({code:'too_big',maximum:entry.kind === 'tool' ? 136 : 2000,origin:'string',inclusive:true});
});
export type AgentToolAllowlistEntry = z.infer<typeof AgentToolAllowlistEntrySchema>;
export const SetAgentExecutionPolicyInputSchema = z.strictObject({
  level: AgentExecutionLevelSchema,
  approvalTimeoutSeconds: z.number().int().min(10).max(900),
  timeoutAction: AgentApprovalTimeoutActionSchema,
  expectedVersion: z.number().int().positive(),
});
export type SetAgentExecutionPolicyInput = z.infer<typeof SetAgentExecutionPolicyInputSchema>;
export type EffectivePermissions = Readonly<Record<AgentPermissionId, AgentPermissionEffect>>;

export const AgentPermissionDefinitionSchema = z.strictObject({
  id: AgentPermissionIdSchema,
  label: z.string().min(1),
  description: z.string().min(1),
  defaultEffect: AgentPermissionEffectSchema,
  contextRule: z.enum(['CURRENT_CHAT', 'ACCOUNT', 'CURRENT_CHAT_FOLDER', 'PROVIDER_WORKSPACE']),
});

/** Any-of permission requirement per built-in MCP tool; the tool is allowed when at least one resolves ALLOW. */
export const MCP_TOOL_PERMISSIONS: Readonly<Record<McpToolName, readonly AgentPermissionId[]>> = {
  list_targets: ['records.query_current_chat', 'records.query_all_chats'],
  query_target_messages: ['records.query_current_chat', 'records.query_all_chats'],
  query_target_messages_by_time: ['records.query_current_chat', 'records.query_all_chats'],
  list_active_chats: ['records.query_current_chat', 'records.query_all_chats'],
  list_chat_notes: ['records.query_current_chat', 'records.query_all_chats'],
  get_chat_note: ['records.query_current_chat', 'records.query_all_chats'],
  list_chat_albums: ['records.query_current_chat', 'records.query_all_chats'],
  get_chat_album: ['records.query_current_chat', 'records.query_all_chats'],
};

/** Provider built-in tool decision, passed to the runner as data and never inferred by it. */
export const AgentToolPolicySchema = z.strictObject({
  /** Whether the principal has any provider local-tool permission; the execution level narrows it further. */
  localTools: z.boolean(),
  /** Read-only file tools inside the working directory. */
  fileRead: z.boolean(),
  /** Write/edit file tools inside the working directory. */
  fileWrite: z.boolean(),
  /** Canonical absolute paths of linked group folders, mounted read-only (one `--add-dir` each). */
  linkedReadDirs: z.array(z.string().min(1)).max(32),
  /** Canonical project folders bound to the job's chat with /folder; `writable` only when this job may modify that folder. */
  projectDirs: z.array(z.strictObject({ path: z.string().min(1), writable: z.boolean() })).max(8).default([]),
  /** True when file writes are enabled only for writable project folders: the job's own chat folder must stay read-only. */
  ownFolderReadOnly: z.boolean().optional(),
  /** Canonical workspace root mounted (one `--add-dir`) for admin/operator jobs whose cwd is below it; null otherwise. */
  workspaceRootDir: z.string().min(1).nullable(),
  /** Snapshotted global ceiling used by provider adapters. */
  level: AgentExecutionLevelSchema,
  /** WebSearch/WebFetch (Claude) and live web search (Codex); granted to every resolved principal, never to unresolved. */
  webTools: z.boolean().default(false),
  /** True only for Agent room UI jobs acting as the operator. */
  interactiveApproval: z.boolean(),
});
export type AgentToolPolicy = z.infer<typeof AgentToolPolicySchema>;

export const PERMISSION_VERSION_CONFLICT = 'PERMISSION_VERSION_CONFLICT';
/** WRITE links need path-scoped Claude permission rules that could not be verified offline, so they fail closed. */
export const LINK_WRITE_UNSUPPORTED = 'LINK_WRITE_UNSUPPORTED';
export const LINK_WRITE_UNSUPPORTED_MESSAGE = '目前無法安全地限定單一資料夾的寫入權限，連結資料夾僅支援唯讀（READ）';
export const FolderLinkAccessSchema = z.enum(['READ', 'WRITE']);
export const PROVIDER_TOOLS_UNSUPPORTED = 'PROVIDER_TOOLS_UNSUPPORTED';
export const PROVIDER_TOOLS_UNSUPPORTED_MESSAGE = 'Codex 無法限制本機工具，群組／好友工作請改用 Claude 或由管理者開放本機工作區權限';

const IdSchema = z.string().min(1);

export const AgentPermissionSubjectSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('EVERYONE') }),
  z.strictObject({ kind: z.literal('USER'), mid: z.string().min(1).max(512) }),
]);
export type AgentPermissionSubject = z.infer<typeof AgentPermissionSubjectSchema>;

export const ChatFolderChatTypeSchema = z.enum(['direct', 'group', 'room']);

export const AgentPermissionSubjectSummarySchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('USER'), mid: z.string().min(1), displayName: z.string(), grantScope: z.enum(['ACCOUNT', 'CHAT']),
    chatScopes: z.array(z.strictObject({ chatType: z.enum(['group', 'room']), chatId: IdSchema })) }),
]);
export type AgentPermissionSubjectSummary = z.infer<typeof AgentPermissionSubjectSummarySchema>;

export const AgentPermissionRuleSchema = z.strictObject({
  subject: AgentPermissionSubjectSchema,
  chatType: ChatFolderChatTypeSchema.nullable(),
  chatId: IdSchema.nullable(),
  permission: AgentPermissionIdSchema,
  effect: AgentPermissionEffectSchema,
  version: z.number().int().positive(),
});
export type AgentPermissionRule = z.infer<typeof AgentPermissionRuleSchema>;

export const AgentPermissionDefaultSchema = z.strictObject({
  permission: AgentPermissionIdSchema,
  effect: AgentPermissionEffectSchema,
  version: z.number().int().positive(),
});
export type AgentPermissionDefault = z.infer<typeof AgentPermissionDefaultSchema>;

export const AgentPermissionDefaultsViewSchema = z.strictObject({ rules: z.array(AgentPermissionDefaultSchema) });
export type AgentPermissionDefaultsView = z.infer<typeof AgentPermissionDefaultsViewSchema>;

export const SetAgentPermissionDefaultInputSchema = z.strictObject({
  permission: AgentPermissionIdSchema,
  effect: z.enum(['ALLOW', 'DENY', 'INHERIT']),
  expectedVersion: z.number().int().nonnegative(),
});
export type SetAgentPermissionDefaultInput = z.infer<typeof SetAgentPermissionDefaultInputSchema>;

export const ChatFolderSummarySchema = z.strictObject({
  folderId: z.uuid(),
  chatType: ChatFolderChatTypeSchema,
  chatId: IdSchema,
  title: z.string(),
  fileCount: z.number().int().nonnegative(),
  bytes: z.number().int().nonnegative(),
});
export type ChatFolderSummary = z.infer<typeof ChatFolderSummarySchema>;

/** Groups/rooms with the Agent enabled, plus whitelisted friends' 1:1 chats. */
export const EligibleChatSchema = z.strictObject({ chatType: ChatFolderChatTypeSchema, chatId: IdSchema, title: z.string() });
export type EligibleChat = z.infer<typeof EligibleChatSchema>;

export const AgentFolderLinkSchema = z.strictObject({
  subjectMid: z.string().min(1),
  folderId: z.uuid(),
  access: FolderLinkAccessSchema,
  version: z.number().int().positive(),
});
export type AgentFolderLink = z.infer<typeof AgentFolderLinkSchema>;

export const SetAgentFolderLinkInputSchema = z.strictObject({
  accountId: IdSchema,
  subjectMid: z.string().min(1).max(512),
  folderId: z.uuid(),
  access: z.enum(['NONE', 'READ', 'WRITE']),
  /** Current link version, or 0 when no link exists. */
  expectedVersion: z.number().int().nonnegative(),
});
export type SetAgentFolderLinkInput = z.infer<typeof SetAgentFolderLinkInputSchema>;

export const AgentPermissionsViewSchema = z.strictObject({
  catalog: z.array(AgentPermissionDefinitionSchema),
  defaults: z.array(AgentPermissionDefaultSchema),
  subjects: z.array(AgentPermissionSubjectSummarySchema),
  rules: z.array(AgentPermissionRuleSchema),
  links: z.array(AgentFolderLinkSchema),
  folders: z.array(ChatFolderSummarySchema),
  eligibleChats: z.array(EligibleChatSchema),
  /** The configured workspace (top layer) that groups\ and chats\ live under; null when it is unavailable. */
  workspaceRoot: z.string().nullable(),
});
export type AgentPermissionsView = z.infer<typeof AgentPermissionsViewSchema>;

export const SetAgentPermissionInputSchema = z.strictObject({
  accountId: IdSchema,
  subject: z.strictObject({ kind: z.literal('USER'), mid: z.string().min(1).max(512) }),
  chatType: ChatFolderChatTypeSchema,
  chatId: IdSchema,
  permission: AgentPermissionIdSchema,
  effect: z.enum(['ALLOW', 'DENY', 'INHERIT']),
  /** Current rule version, or 0 when no rule exists for this subject and permission. */
  expectedVersion: z.number().int().nonnegative(),
});
export type SetAgentPermissionInput = z.infer<typeof SetAgentPermissionInputSchema>;
