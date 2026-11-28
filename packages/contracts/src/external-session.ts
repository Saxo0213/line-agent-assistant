import { z } from 'zod';

/** External MCP session tools (docs/design/external-session-reply.md). They exist on the external endpoint only. */
export const WAIT_FOR_ADMIN_REPLY_TOOL_NAME = 'wait_for_admin_reply' as const;
export const LIST_ADMIN_REPLIES_TOOL_NAME = 'list_admin_replies' as const;
export const CLOSE_SESSION_TOOL_NAME = 'close_session' as const;
export const EXTERNAL_SESSION_TOOL_NAMES = [WAIT_FOR_ADMIN_REPLY_TOOL_NAME, LIST_ADMIN_REPLIES_TOOL_NAME, CLOSE_SESSION_TOOL_NAME] as const;
export type ExternalSessionToolName = (typeof EXTERNAL_SESSION_TOOL_NAMES)[number];
export const isExternalSessionToolName = (value: unknown): value is ExternalSessionToolName =>
  typeof value === 'string' && (EXTERNAL_SESSION_TOOL_NAMES as readonly string[]).includes(value);

export const EXTERNAL_SESSION_KEY_PATTERN = /^[A-Za-z0-9_-]{8,128}$/;
export const EXTERNAL_SESSION_LABEL_MAX_CHARS = 24;
export const EXTERNAL_SESSION_WAIT_DEFAULT_SECONDS = 300;
export const EXTERNAL_SESSION_WAIT_MAX_SECONDS = 600;
export const EXTERNAL_SESSION_LIST_MAX = 50;

/**
 * Internal-only tool of the built-in Agent job that the Primary Admin started in the direct chat (never in a token scope, never on the
 * external endpoint). It gives the message of the admin to one waiting session.
 */
export const FORWARD_TO_SESSION_TOOL_NAME = 'forward_to_session' as const;
export const FORWARD_TO_SESSION_NOTE_MAX_CHARS = 500;
/** A session is waiting while it is open and was active within this time. */
export const WAITING_SESSION_WINDOW_HOURS = 24;
/** Length of the text of the last sent message in the waiting-session list of the Agent prompt. */
export const WAITING_SESSION_TEXT_CHARS = 80;

export const ForwardToSessionInputSchema = z.strictObject({
  seq: z.number().int().min(1),
  note: z.string().refine((value) => Array.from(value).length <= FORWARD_TO_SESSION_NOTE_MAX_CHARS,
    `note can have ${FORWARD_TO_SESSION_NOTE_MAX_CHARS} characters at most.`).optional(),
});
export interface ForwardToSessionOutput { forwarded: true; replyId: string; session: string }

export const ExternalSessionKeySchema = z.string().regex(EXTERNAL_SESSION_KEY_PATTERN, 'Session key must be 8 to 128 characters of A-Z, a-z, 0-9, _ or -.');

/** `session` of send_to_target. The label has 1 to 24 characters (code points). */
export const ExternalSessionInputSchema = z.strictObject({
  key: ExternalSessionKeySchema,
  label: z.string().refine((value) => {
    const length = Array.from(value.trim()).length;
    return length >= 1 && length <= EXTERNAL_SESSION_LABEL_MAX_CHARS;
  }, `Session label must have 1 to ${EXTERNAL_SESSION_LABEL_MAX_CHARS} characters.`).transform((value) => value.trim()),
});
export type ExternalSessionInput = z.infer<typeof ExternalSessionInputSchema>;

export const WaitForAdminReplyInputSchema = z.strictObject({
  sessionKey: ExternalSessionKeySchema,
  timeoutSeconds: z.number().int().min(1).max(EXTERNAL_SESSION_WAIT_MAX_SECONDS).optional(),
});
export const ListAdminRepliesInputSchema = z.strictObject({
  sessionKey: ExternalSessionKeySchema,
  since: z.iso.datetime({ offset: true }).optional(),
});
export const CloseSessionInputSchema = z.strictObject({ sessionKey: ExternalSessionKeySchema });

export const ExternalSessionReplySchema = z.strictObject({
  replyId: z.string().min(1),
  source: z.enum(['quote', 'agent']),
  text: z.string(),
  attachments: z.array(z.strictObject({ attachmentId: z.string().min(1), kind: z.string(), name: z.string() })),
  note: z.string().nullable(),
  receivedAt: z.string(),
});
export type ExternalSessionReply = z.infer<typeof ExternalSessionReplySchema>;

export type ExternalSessionToolOutput =
  | { toolName: typeof WAIT_FOR_ADMIN_REPLY_TOOL_NAME; sessionKey: string; replies: ExternalSessionReply[]; sessionClosed: boolean }
  | { toolName: typeof LIST_ADMIN_REPLIES_TOOL_NAME; sessionKey: string; replies: ExternalSessionReply[]; sessionClosed: boolean }
  | { toolName: typeof CLOSE_SESSION_TOOL_NAME; sessionKey: string; closed: true }
  | { error: { code: 'SESSION_NOT_FOUND' | 'SESSION_UNAVAILABLE'; message: string } };
