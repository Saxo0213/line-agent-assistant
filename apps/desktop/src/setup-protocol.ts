import { z } from 'zod';

export const DatabaseConnectionInputSchema = z.strictObject({
  host: z.string().trim().min(1).max(253),
  port: z.number().int().min(1).max(65535),
  username: z.string().min(1).max(128),
  password: z.string().max(1024),
  ssl: z.enum(['disable', 'require']),
});
export type DatabaseConnectionInput = z.infer<typeof DatabaseConnectionInputSchema>;

/**
 * 8-128 printable ASCII characters (U+0020-U+007E). ASCII only, so the SCRAM verifier, node-postgres and libpq (SASLprep)
 * all derive the same key. Shared by the renderer, the request schema and main.
 */
export function isValidEmbeddedPassword(password: string): boolean {
  return /^[ -~]{8,128}$/.test(password);
}

export const DatabaseSetupRequestSchema = z.discriminatedUnion('type', [
  z.strictObject({ type: z.literal('getDatabaseSetupStatus'), requestId: z.uuid() }),
  z.strictObject({ type: z.literal('listDatabases'), requestId: z.uuid(), connection: DatabaseConnectionInputSchema }),
  z.strictObject({ type: z.literal('createDatabase'), requestId: z.uuid(), connection: DatabaseConnectionInputSchema,
    database: z.string().regex(/^[A-Za-z][A-Za-z0-9_-]{0,62}$/) }),
  z.strictObject({ type: z.literal('chooseAttachmentRoot'), requestId: z.uuid() }),
  z.strictObject({ type: z.literal('prepareAttachmentRootChange'), requestId: z.uuid() }),
  z.strictObject({ type: z.literal('moveAttachmentRoot'), requestId: z.uuid(), selectionId: z.uuid() }),
  z.strictObject({ type: z.literal('openAttachmentRoot'), requestId: z.uuid() }),
  z.strictObject({ type: z.literal('chooseAgentWorkspace'), requestId: z.uuid() }),
  z.strictObject({ type: z.literal('saveDatabaseSetup'), requestId: z.uuid(), connection: DatabaseConnectionInputSchema,
    database: z.string().regex(/^[A-Za-z][A-Za-z0-9_-]{0,62}$/), attachmentRoot: z.string().min(3).max(1024),
    agentWorkspace: z.string().min(3).max(1024) }),
  z.strictObject({ type: z.literal('restartApplication'), requestId: z.uuid() }),
  z.strictObject({ type: z.literal('startEmbeddedProvision'), requestId: z.uuid() }),
  z.strictObject({ type: z.literal('cancelEmbeddedProvision'), requestId: z.uuid() }),
  z.strictObject({ type: z.literal('getEmbeddedConnectionInfo'), requestId: z.uuid() }),
  z.strictObject({ type: z.literal('saveEmbeddedSetup'), requestId: z.uuid(), attachmentRoot: z.string().min(3).max(1024),
    agentWorkspace: z.string().min(3).max(1024) }),
  z.strictObject({ type: z.literal('changeEmbeddedPassword'), requestId: z.uuid(), password: z.string().max(1024) }),
]);
export type DatabaseSetupRequest = z.infer<typeof DatabaseSetupRequestSchema>;

const SafeConnectionSchema = DatabaseConnectionInputSchema.omit({ password: true });
export const DatabaseSetupStatusSchema = z.strictObject({ configured: z.boolean(), attachmentRoot: z.string().nullable(), agentWorkspace: z.string().nullable(),
  connection: SafeConnectionSchema.extend({ database: z.string() }).nullable(),
  embedded: z.strictObject({ version: z.string(), port: z.number().int() }).optional() });
export type DatabaseSetupStatus = z.infer<typeof DatabaseSetupStatusSchema>;

export const EmbeddedConnectionInfoSchema = z.strictObject({ version: z.string(), host: z.string(), port: z.number().int(),
  username: z.string(), database: z.string(), url: z.string(), password: z.string() });
export type EmbeddedConnectionInfo = z.infer<typeof EmbeddedConnectionInfoSchema>;

export const SetupProgressEventSchema = z.strictObject({
  phase: z.enum(['runtime', 'download', 'verify', 'extract', 'initdb', 'start', 'database']),
  receivedBytes: z.number().int().nonnegative().optional(), totalBytes: z.number().int().nonnegative().optional() });
export type SetupProgressEvent = z.infer<typeof SetupProgressEventSchema>;
export const SETUP_PROGRESS_CHANNEL = 'line-agent:setup-progress';

export const DatabaseSetupResultSchema = z.discriminatedUnion('type', [
  z.strictObject({ type: z.literal('getDatabaseSetupStatus'), requestId: z.uuid(), ok: z.literal(true), status: DatabaseSetupStatusSchema }),
  z.strictObject({ type: z.literal('listDatabases'), requestId: z.uuid(), ok: z.literal(true), databases: z.array(z.string()) }),
  z.strictObject({ type: z.literal('createDatabase'), requestId: z.uuid(), ok: z.literal(true), databases: z.array(z.string()) }),
  z.strictObject({ type: z.literal('chooseAttachmentRoot'), requestId: z.uuid(), ok: z.literal(true), path: z.string().nullable() }),
  z.strictObject({ type: z.literal('prepareAttachmentRootChange'), requestId: z.uuid(), ok: z.literal(true), selection: z.strictObject({ id: z.uuid(), path: z.string() }).nullable() }),
  z.strictObject({ type: z.literal('moveAttachmentRoot'), requestId: z.uuid(), ok: z.literal(true), saved: z.literal(true), restartRequired: z.literal(true), path: z.string(), sourceRetained: z.literal(true) }),
  z.strictObject({ type: z.literal('openAttachmentRoot'), requestId: z.uuid(), ok: z.literal(true) }),
  z.strictObject({ type: z.literal('chooseAgentWorkspace'), requestId: z.uuid(), ok: z.literal(true), path: z.string().nullable() }),
  z.strictObject({ type: z.literal('saveDatabaseSetup'), requestId: z.uuid(), ok: z.literal(true), saved: z.literal(true), restartRequired: z.literal(true) }),
  z.strictObject({ type: z.literal('restartApplication'), requestId: z.uuid(), ok: z.literal(true) }),
  z.strictObject({ type: z.literal('startEmbeddedProvision'), requestId: z.uuid(), ok: z.literal(true) }),
  z.strictObject({ type: z.literal('cancelEmbeddedProvision'), requestId: z.uuid(), ok: z.literal(true) }),
  z.strictObject({ type: z.literal('getEmbeddedConnectionInfo'), requestId: z.uuid(), ok: z.literal(true), info: EmbeddedConnectionInfoSchema }),
  z.strictObject({ type: z.literal('saveEmbeddedSetup'), requestId: z.uuid(), ok: z.literal(true), saved: z.literal(true), restartRequired: z.literal(true) }),
  z.strictObject({ type: z.literal('changeEmbeddedPassword'), requestId: z.uuid(), ok: z.literal(true) }),
  z.strictObject({ type: z.literal('error'), requestId: z.string(), ok: z.literal(false), message: z.string(),
    errorCode: z.string().regex(/^[a-z0-9_:.-]{1,120}$/).optional(), restartRequired: z.boolean().optional() }),
]);
export type DatabaseSetupResult = z.infer<typeof DatabaseSetupResultSchema>;
