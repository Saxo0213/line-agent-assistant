import { z } from 'zod';

/** Chat types that can own project folders (the same set as the /folder command). */
export const ProjectFolderChatTypeSchema = z.enum(['direct', 'group', 'room']);
export const ProjectFolderModeSchema = z.enum(['READ', 'READ_WRITE']);
export type ProjectFolderMode = z.infer<typeof ProjectFolderModeSchema>;

/** Largest path the database stores (agent_project_folders.path). */
export const PROJECT_FOLDER_PATH_MAX = 1000;

/** Error codes of the Settings → 資料夾 requests. One code for each reason; the UI chooses the text from the code. */
export const PROJECT_FOLDER_ERROR_CODES = [
  'PROJECT_FOLDER_NOT_ABSOLUTE',
  'PROJECT_FOLDER_NOT_FOUND',
  'PROJECT_FOLDER_FORBIDDEN',
  'PROJECT_FOLDER_UNSUPPORTED_CHARS',
  'PROJECT_FOLDER_ACCOUNT_INVALID',
] as const;
export type ProjectFolderErrorCode = typeof PROJECT_FOLDER_ERROR_CODES[number];

export const ProjectFolderEntrySchema = z.strictObject({
  path: z.string().min(1).max(1024),
  mode: ProjectFolderModeSchema,
});
export type ProjectFolderEntry = z.infer<typeof ProjectFolderEntrySchema>;

export const ProjectFolderChatInputSchema = z.strictObject({
  accountId: z.string().min(1),
  chatType: ProjectFolderChatTypeSchema,
  chatId: z.string().min(1),
});
export type ProjectFolderChatInput = z.infer<typeof ProjectFolderChatInputSchema>;

export const ProjectFolderBindInputSchema = ProjectFolderChatInputSchema.extend({
  path: z.string().min(1).max(PROJECT_FOLDER_PATH_MAX),
  mode: ProjectFolderModeSchema,
});
export type ProjectFolderBindInput = z.infer<typeof ProjectFolderBindInputSchema>;

export const ProjectFolderUnbindInputSchema = ProjectFolderChatInputSchema.extend({
  path: z.string().min(1).max(1024),
});
export type ProjectFolderUnbindInput = z.infer<typeof ProjectFolderUnbindInputSchema>;

export const ProjectFolderBindStatusSchema = z.enum(['created', 'updated', 'unchanged']);
