import { z } from 'zod';

export const StoredAttachmentItemSchema = z.strictObject({
  attachmentId: z.uuid(), messageId: z.string().min(1), name: z.string().min(1), kind: z.enum(['image','video','audio','file']),
  mimeType: z.string().nullable(), sizeBytes: z.number().int().nonnegative().nullable(), occurredAt: z.iso.datetime({ offset: true }),
  senderId: z.string().min(1), senderDisplayName: z.string().min(1),
});
export type StoredAttachmentItem = z.infer<typeof StoredAttachmentItemSchema>;
export const StoredAttachmentPageSchema = z.strictObject({ attachments: z.array(StoredAttachmentItemSchema).max(100), nextCursor: z.string().max(2048).nullable() });
export type StoredAttachmentPage = z.infer<typeof StoredAttachmentPageSchema>;
export const StoredAttachmentSenderSchema = z.strictObject({ senderId: z.string().min(1), senderDisplayName: z.string().min(1), count: z.number().int().positive() });
export type StoredAttachmentSender = z.infer<typeof StoredAttachmentSenderSchema>;
export const StoredAttachmentSendersSchema = z.strictObject({ senders: z.array(StoredAttachmentSenderSchema).max(5000) });
export type StoredAttachmentSenders = z.infer<typeof StoredAttachmentSendersSchema>;

/** The most extra folders that one chat can have. */
export const CHAT_EXTRA_FOLDER_LIMIT = 10;
/** The longest description of an extra folder. */
export const CHAT_EXTRA_FOLDER_DESCRIPTION_MAX = 200;
const CopyProgressShape = {
  queued: z.number().int().nonnegative(), claimed: z.number().int().nonnegative(),
  completed: z.number().int().nonnegative(), failed: z.number().int().nonnegative(),
};
/** The default folder of a chat (path only), with the progress of its copy queue. */
export const ChatDefaultFolderSchema = z.strictObject({ folderId: z.uuid(), root: z.string().min(1).max(1024), ...CopyProgressShape });
export type ChatDefaultFolder = z.infer<typeof ChatDefaultFolderSchema>;
/** One classification folder of a chat (path and description), with the progress of its copy queue. */
export const ChatExtraFolderSchema = z.strictObject({
  folderId: z.uuid(),
  root: z.string().min(1).max(1024),
  description: z.string().max(CHAT_EXTRA_FOLDER_DESCRIPTION_MAX),
  ...CopyProgressShape,
});
export type ChatExtraFolder = z.infer<typeof ChatExtraFolderSchema>;
export const CHAT_EXTRA_FOLDER_DECIDED_BY = ['agent', 'default_uncertain', 'default_failed'] as const;
/** One decision of the Agent classifier. `folderName` is the base name of the chosen folder at decision time. */
export const ChatExtraFolderDecisionSchema = z.strictObject({
  attachmentName: z.string().max(512),
  folderName: z.string().max(260).nullable(),
  decidedBy: z.enum(CHAT_EXTRA_FOLDER_DECIDED_BY),
  reason: z.string().max(CHAT_EXTRA_FOLDER_DESCRIPTION_MAX),
  decidedAt: z.iso.datetime({ offset: true }),
});
export type ChatExtraFolderDecision = z.infer<typeof ChatExtraFolderDecisionSchema>;
/** The default folder, the classification folders of one chat, the count of attachments that wait for the classifier, and the last decisions. */
export const ChatExtraFolderStatusSchema = z.strictObject({
  defaultFolder: ChatDefaultFolderSchema.nullable(),
  folders: z.array(ChatExtraFolderSchema).max(CHAT_EXTRA_FOLDER_LIMIT),
  waitingClassification: z.number().int().nonnegative(),
  decisions: z.array(ChatExtraFolderDecisionSchema).max(10),
});
export type ChatExtraFolderStatus = z.infer<typeof ChatExtraFolderStatusSchema>;
export const CHAT_EXTRA_FOLDER_ERROR_CODES = ['NOT_ABSOLUTE', 'NOT_DIRECTORY', 'REPARSE_POINT', 'PROTECTED_FOLDER', 'OTHER_CHAT_FOLDER',
  'ACCESS_DENIED', 'UNREACHABLE', 'DUPLICATE_FOLDER', 'LIMIT_REACHED', 'NOT_FOUND', 'FAILED'] as const;
export const ChatExtraFolderResultSchema = z.union([
  z.strictObject({ ok: z.literal(true) }),
  z.strictObject({ ok: z.literal(false), code: z.enum(CHAT_EXTRA_FOLDER_ERROR_CODES) }),
]);
export type ChatExtraFolderResult = z.infer<typeof ChatExtraFolderResultSchema>;

// ---- Internal MCP tools: the download folders of a chat (never in McpToolNameSchema / external token scopes) ----
export const LIST_CHAT_DOWNLOAD_FOLDERS_TOOL_NAME = 'list_chat_download_folders' as const;
export const ADD_CHAT_DOWNLOAD_FOLDER_TOOL_NAME = 'add_chat_download_folder' as const;
export const SET_CHAT_DOWNLOAD_FOLDER_DESCRIPTION_TOOL_NAME = 'set_chat_download_folder_description' as const;
export const SET_CHAT_DEFAULT_DOWNLOAD_FOLDER_TOOL_NAME = 'set_chat_default_download_folder' as const;
export const REMOVE_CHAT_DOWNLOAD_FOLDER_TOOL_NAME = 'remove_chat_download_folder' as const;
export const CHAT_DOWNLOAD_FOLDER_TOOL_NAMES = [
  LIST_CHAT_DOWNLOAD_FOLDERS_TOOL_NAME, ADD_CHAT_DOWNLOAD_FOLDER_TOOL_NAME, SET_CHAT_DOWNLOAD_FOLDER_DESCRIPTION_TOOL_NAME,
  SET_CHAT_DEFAULT_DOWNLOAD_FOLDER_TOOL_NAME, REMOVE_CHAT_DOWNLOAD_FOLDER_TOOL_NAME,
] as const;
export type ChatDownloadFolderToolName = (typeof CHAT_DOWNLOAD_FOLDER_TOOL_NAMES)[number];
export const isChatDownloadFolderToolName = (value: unknown): value is ChatDownloadFolderToolName =>
  (CHAT_DOWNLOAD_FOLDER_TOOL_NAMES as readonly unknown[]).includes(value);

/** The chat that a download folder tool acts on. All fields absent: the chat of the job itself. */
const chatDownloadFolderTargetShape = {
  accountId: z.string().min(1).max(256).optional(),
  chatType: z.enum(['direct', 'group', 'room']).optional(),
  chatId: z.string().min(1).max(256).optional(),
};
const hasValidChatTarget = (value: { accountId?: string | undefined; chatType?: string | undefined; chatId?: string | undefined }) =>
  (value.chatType === undefined) === (value.chatId === undefined) && (value.accountId === undefined || value.chatType !== undefined);
const CHAT_TARGET_MESSAGE = 'chatType and chatId must be given together; accountId is allowed only with them.';
const folderPath = z.string().min(1).max(1024);
const folderDescription = z.string().trim().min(1).max(CHAT_EXTRA_FOLDER_DESCRIPTION_MAX);

export const ListChatDownloadFoldersToolInputSchema = z.strictObject(chatDownloadFolderTargetShape).refine(hasValidChatTarget, CHAT_TARGET_MESSAGE);
export const AddChatDownloadFolderToolInputSchema = z.strictObject({ ...chatDownloadFolderTargetShape, path: folderPath, description: folderDescription })
  .refine(hasValidChatTarget, CHAT_TARGET_MESSAGE);
export const SetChatDownloadFolderDescriptionToolInputSchema = z.strictObject({ ...chatDownloadFolderTargetShape, folderId: z.uuid(), description: folderDescription })
  .refine(hasValidChatTarget, CHAT_TARGET_MESSAGE);
export const SetChatDefaultDownloadFolderToolInputSchema = z.strictObject({ ...chatDownloadFolderTargetShape, path: folderPath })
  .refine(hasValidChatTarget, CHAT_TARGET_MESSAGE);
export const RemoveChatDownloadFolderToolInputSchema = z.strictObject({ ...chatDownloadFolderTargetShape, folderId: z.uuid().optional(), clearDefault: z.literal(true).optional() })
  .refine(hasValidChatTarget, CHAT_TARGET_MESSAGE)
  .refine((value) => (value.folderId === undefined) !== (value.clearDefault === undefined), 'Give exactly one of folderId or clearDefault.');
