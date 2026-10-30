import { z } from 'zod';

const IdSchema = z.string().min(1);

export const ChatTypeSchema = z.enum(['direct', 'group', 'room', 'community', 'thread']);
export type ChatType = z.infer<typeof ChatTypeSchema>;

/** Categories that the current LINE transport can address for operations. */
export const WritableChatTypeSchema = z.enum(['direct', 'group', 'room']);
export type WritableChatType = z.infer<typeof WritableChatTypeSchema>;
export function isWritableChatType(value: ChatType): value is WritableChatType {
  return WritableChatTypeSchema.safeParse(value).success;
}

/** Backward-compatible names for archive/read callers. */
export const ArchiveChatTypeSchema = ChatTypeSchema;
export type ArchiveChatType = ChatType;

/** Native source relationships kept with an archived conversation. */
export const NativeConversationMetadataSchema = z.strictObject({
  midType: z.number().int().nonnegative().nullable(),
  parentChatId: z.string().max(256).nullable(),
  communityId: z.string().max(256).nullable(),
});
export type NativeConversationMetadata = z.infer<typeof NativeConversationMetadataSchema>;

export const ConversationKeySchema = z.strictObject({
  accountId: IdSchema,
  chatType: ChatTypeSchema,
  chatId: IdSchema,
});
export type ConversationKey = z.infer<typeof ConversationKeySchema>;

export const WritableConversationKeySchema = z.strictObject({
  accountId: IdSchema,
  chatType: WritableChatTypeSchema,
  chatId: IdSchema,
});
export type WritableConversationKey = z.infer<typeof WritableConversationKeySchema>;

export const ArchiveConversationKeySchema = ConversationKeySchema;
export type ArchiveConversationKey = z.infer<typeof ArchiveConversationKeySchema>;

export const AccountModeSchema = z.enum(['ACTIVE_CONTROL', 'MONITOR_ONLY', 'PAUSED']);
export type AccountMode = z.infer<typeof AccountModeSchema>;

export const ControlEpochSchema = z.number().int().nonnegative();

/**
 * Which LINE protocol an account's worker speaks. DESKTOPWIN is the linejs transport and the default; CHROMEOS is the
 * LINE Chrome extension (3.7.2) protocol port. An absent value means DESKTOPWIN (see resolveLineTransport).
 */
export const LineTransportKindSchema = z.enum(['DESKTOPWIN', 'CHROMEOS']);
export type LineTransportKind = z.infer<typeof LineTransportKindSchema>;
export const DEFAULT_LINE_TRANSPORT: LineTransportKind = 'DESKTOPWIN';
export function resolveLineTransport(value: LineTransportKind | undefined): LineTransportKind {
  return value ?? DEFAULT_LINE_TRANSPORT;
}
/** The only `application` string a CHROMEOS init may carry (the trailing tab is part of the value). */
export const CHROMEOS_APPLICATION = 'CHROMEOS\t3.7.2\tChrome_OS\t';

export const WorkerBindingSchema = z.strictObject({
  accountId: IdSchema,
  workerInstanceId: IdSchema,
  controlEpoch: ControlEpochSchema,
  transportOwnerId: IdSchema.optional(),
  transportGeneration: ControlEpochSchema.optional(),
  writeGrantVersion: ControlEpochSchema.optional(),
  lineTransport: LineTransportKindSchema.optional(),
});
export type WorkerBinding = z.infer<typeof WorkerBindingSchema>;

export const WorkerWriteAuthorizationSchema = z.strictObject({
  request: WorkerBindingSchema.merge(WritableConversationKeySchema),
  binding: WorkerBindingSchema.extend({ mode: AccountModeSchema }),
}).superRefine(({ request, binding }, context) => {
  if (request.accountId !== binding.accountId) context.addIssue({ code: 'custom', path: ['request', 'accountId'], message: 'Worker account binding mismatch' });
  if (request.workerInstanceId !== binding.workerInstanceId) context.addIssue({ code: 'custom', path: ['request', 'workerInstanceId'], message: 'Worker instance mismatch' });
  if (request.controlEpoch !== binding.controlEpoch) context.addIssue({ code: 'custom', path: ['request', 'controlEpoch'], message: 'Stale control epoch' });
  if (binding.mode !== 'ACTIVE_CONTROL') context.addIssue({ code: 'custom', path: ['binding', 'mode'], message: 'LINE write requires ACTIVE_CONTROL' });
});
export type WorkerWriteAuthorization = z.infer<typeof WorkerWriteAuthorizationSchema>;
