import { z } from 'zod';

/** Providers an extra MCP server can apply to. Declared here (not imported from agent.ts) so agent.ts can embed these schemas. */
export const AgentExtensionProviderSchema = z.enum(['claude', 'codex']);
export type AgentExtensionProvider = z.infer<typeof AgentExtensionProviderSchema>;

/** Value shown instead of a stored secret. The renderer never receives env or header values. */
export const AGENT_MCP_SECRET_MASK = '********';
export const AGENT_MCP_MAX_SERVERS = 32;

export const AGENT_MCP_RESERVED_NAME = 'linejs';
export const AGENT_MCP_RESERVED_PREFIX = 'claude_ai';

export const AgentMcpServerNameSchema = z.string()
  .regex(/^[a-z0-9][a-z0-9_-]{0,39}$/, 'Name must be 1-40 lowercase letters, digits, "_" or "-"')
  .refine((name) => name !== AGENT_MCP_RESERVED_NAME && !name.startsWith(AGENT_MCP_RESERVED_PREFIX), 'Name is reserved');

export const AgentMcpSourceSchema = z.enum(['manual', 'claude-code', 'claude-desktop', 'codex']);
export type AgentMcpSource = z.infer<typeof AgentMcpSourceSchema>;
export const AgentMcpImportSourceSchema = z.enum(['claude-code', 'claude-desktop', 'codex']);
export type AgentMcpImportSource = z.infer<typeof AgentMcpImportSourceSchema>;
export const AgentMcpTransportSchema = z.enum(['stdio', 'http']);
export type AgentMcpTransport = z.infer<typeof AgentMcpTransportSchema>;

const ENV_KEY = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;
const HEADER_KEY = /^[A-Za-z0-9!#$%&'*+.^_`|~-]{1,128}$/;
const EnvKeySchema = z.string().regex(ENV_KEY, 'Invalid environment variable name').refine((key) => !/^LINEJS_/i.test(key), 'Name is reserved');
const HeaderKeySchema = z.string().regex(HEADER_KEY, 'Invalid header name');
const SecretValueSchema = z.string().max(8192);
const HeaderValueSchema = z.string().max(8192).refine((value) => !/[\r\n]/.test(value), 'Header values cannot contain line breaks');
const CommandSchema = z.string().trim().min(1).max(1024);
const ArgSchema = z.string().max(4096);
const ArgsSchema = z.array(ArgSchema).max(64);
const UrlSchema = z.string().trim().max(2048).refine((value) => {
  try { const url = new URL(value); return url.protocol === 'http:' || url.protocol === 'https:'; } catch { return false; }
}, 'URL must be http or https');
const ProvidersSchema = z.array(AgentExtensionProviderSchema).min(1).max(2).refine((items) => new Set(items).size === items.length, 'Duplicate provider');

interface ServerShape {
  transport: AgentMcpTransport; command?: string | undefined; args?: unknown[] | undefined;
  env?: Record<string, unknown> | undefined; url?: string | undefined; headers?: Record<string, unknown> | undefined;
}
/** stdio needs a command and carries no url/headers; http needs a url and carries no command/args/env. */
function checkTransportShape(server: ServerShape, context: z.RefinementCtx): void {
  const issue = (path: string, message: string) => context.addIssue({ code: 'custom', path: [path], message });
  if (server.transport === 'stdio') {
    if (!server.command) issue('command', 'Command is required');
    if (server.url) issue('url', 'URL is only for http');
    if (server.headers && Object.keys(server.headers).length > 0) issue('headers', 'Headers are only for http');
  } else {
    if (!server.url) issue('url', 'URL is required');
    if (server.command) issue('command', 'Command is only for stdio');
    if (server.args && server.args.length > 0) issue('args', 'Arguments are only for stdio');
    if (server.env && Object.keys(server.env).length > 0) issue('env', 'Environment is only for stdio');
  }
}

/** A server with its secrets, as used for one run (Main -> bridge). Never persisted in this form. */
export const AgentMcpServerDefinitionSchema = z.strictObject({
  name: AgentMcpServerNameSchema,
  transport: AgentMcpTransportSchema,
  command: CommandSchema.optional(),
  args: ArgsSchema.default([]),
  env: z.record(EnvKeySchema, SecretValueSchema).default({}),
  url: UrlSchema.optional(),
  headers: z.record(HeaderKeySchema, HeaderValueSchema).default({}),
  providers: ProvidersSchema,
}).superRefine(checkTransportShape);
export type AgentMcpServerDefinition = z.infer<typeof AgentMcpServerDefinitionSchema>;

/**
 * Renderer -> Main add/edit payload. Without `id` every env/header value must be non-empty. With `id`, an empty value for an
 * existing key means "keep the stored value"; keys left out of the payload are removed.
 */
export const AgentMcpServerInputSchema = z.strictObject({
  id: z.uuid().optional(),
  name: AgentMcpServerNameSchema,
  transport: AgentMcpTransportSchema,
  command: CommandSchema.optional(),
  args: ArgsSchema.default([]),
  env: z.record(EnvKeySchema, SecretValueSchema).default({}),
  url: UrlSchema.optional(),
  headers: z.record(HeaderKeySchema, HeaderValueSchema).default({}),
  enabled: z.boolean(),
  providers: ProvidersSchema,
}).superRefine((server, context) => {
  checkTransportShape(server, context);
  if (server.id) return;
  for (const [field, values] of [['env', server.env], ['headers', server.headers]] as const) {
    for (const [key, value] of Object.entries(values)) {
      if (value === '') context.addIssue({ code: 'custom', path: [field, key], message: 'Value is required' });
    }
  }
});
export type AgentMcpServerInput = z.infer<typeof AgentMcpServerInputSchema>;

/** Main -> renderer view: env and header values are always the mask. */
export const AgentMcpServerSummarySchema = z.strictObject({
  id: z.uuid(),
  name: AgentMcpServerNameSchema,
  transport: AgentMcpTransportSchema,
  command: z.string().optional(),
  args: ArgsSchema,
  env: z.record(z.string(), z.literal(AGENT_MCP_SECRET_MASK)),
  url: z.string().optional(),
  headers: z.record(z.string(), z.literal(AGENT_MCP_SECRET_MASK)),
  enabled: z.boolean(),
  source: AgentMcpSourceSchema,
  providers: ProvidersSchema,
});
export type AgentMcpServerSummary = z.infer<typeof AgentMcpServerSummarySchema>;

/** Built-in tool additions for eligible jobs. Each only ever adds to what the execution level already grants. */
export const AgentExtensionToolsSchema = z.strictObject({
  /** Claude WebSearch; Codex `web_search = "live"`. */
  webSearch: z.boolean(),
  /** Claude WebFetch. */
  webFetch: z.boolean(),
  /** Claude Bash; still asks through the Agent room approval prompt. */
  bash: z.boolean(),
  /** Claude Read, Glob, Grep. */
  fileRead: z.boolean(),
  /** Claude Write, Edit. */
  fileWrite: z.boolean(),
});
export type AgentExtensionTools = z.infer<typeof AgentExtensionToolsSchema>;
export const DEFAULT_AGENT_EXTENSION_TOOLS: AgentExtensionTools = { webSearch: false, webFetch: false, bash: false, fileRead: false, fileWrite: false };

export const AgentExtensionsStateSchema = z.strictObject({
  servers: z.array(AgentMcpServerSummarySchema).max(AGENT_MCP_MAX_SERVERS),
  tools: AgentExtensionToolsSchema,
});
export type AgentExtensionsState = z.infer<typeof AgentExtensionsStateSchema>;

/** Resolved extras for one run. Only Main fills it, and only for jobs whose principal is eligible. */
export const AgentRunExtensionsSchema = z.strictObject({
  servers: z.array(AgentMcpServerDefinitionSchema).max(AGENT_MCP_MAX_SERVERS),
  tools: AgentExtensionToolsSchema,
});
export type AgentRunExtensions = z.infer<typeof AgentRunExtensionsSchema>;

export const AgentMcpImportErrorCodeSchema = z.enum(['INVALID_FORMAT', 'READ_FAILED']);
export const AgentMcpImportIssueSchema = z.enum(['UNSUPPORTED_TRANSPORT', 'UNSUPPORTED_AUTH', 'INVALID_DEFINITION', 'RESERVED_NAME']);

export const AgentMcpImportCandidateSchema = z.strictObject({
  source: AgentMcpImportSourceSchema,
  /** Name as written in the source file. */
  sourceName: z.string().min(1).max(256),
  /** Slug the server would be stored under. */
  name: z.string().max(40),
  transport: AgentMcpTransportSchema,
  command: z.string().optional(),
  args: ArgsSchema,
  envKeys: z.array(z.string()).max(256),
  url: z.string().optional(),
  headerKeys: z.array(z.string()).max(256),
  /** Present when the entry cannot be imported. */
  issue: AgentMcpImportIssueSchema.optional(),
  /** True when a stored server already uses `name`. */
  nameTaken: z.boolean(),
});
export type AgentMcpImportCandidate = z.infer<typeof AgentMcpImportCandidateSchema>;

export const AgentMcpImportListingSchema = z.strictObject({
  sources: z.array(z.strictObject({
    source: AgentMcpImportSourceSchema,
    status: z.enum(['ok', 'missing', 'error']),
    error: AgentMcpImportErrorCodeSchema.optional(),
    candidates: z.array(AgentMcpImportCandidateSchema).max(256),
  })).max(3),
});
export type AgentMcpImportListing = z.infer<typeof AgentMcpImportListingSchema>;

export const AgentMcpImportSelectionSchema = z.strictObject({
  source: AgentMcpImportSourceSchema,
  sourceName: z.string().min(1).max(256),
});
export const AgentMcpImportResultSchema = z.strictObject({
  imported: z.array(AgentMcpServerNameSchema).max(AGENT_MCP_MAX_SERVERS),
  skipped: z.array(z.strictObject({
    source: AgentMcpImportSourceSchema,
    sourceName: z.string().min(1).max(256),
    reason: z.enum(['NOT_FOUND', 'NAME_TAKEN', 'LIMIT', 'UNSUPPORTED', 'RESERVED_NAME']),
  })).max(256),
});
export type AgentMcpImportResult = z.infer<typeof AgentMcpImportResultSchema>;

/** Tools that the execution level already provides to an eligible (operator/admin) job, as `claudeBuiltInTools` computes them. */
export function agentExtensionToolsGrantedByLevel(level: 'read_only' | 'workspace_write' | 'trust' | 'full'): Record<keyof AgentExtensionTools, boolean> {
  return {
    fileRead: true,
    fileWrite: level !== 'read_only',
    webSearch: level === 'trust' || level === 'full',
    webFetch: level === 'trust' || level === 'full',
    // Bash already asks for approval on workspace_write/trust and is unrestricted on full.
    bash: level !== 'read_only',
  };
}
