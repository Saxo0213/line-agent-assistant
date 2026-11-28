import { McpInternalToolNameSchema } from '@line-agent/contracts';

/** The categories of the deterministic scan of one reply (docs/design/non-admin-reply-audit.md section 3). */
export const REPLY_PATTERN_CATEGORIES = ['version', 'path', 'tool', 'mid', 'chat_id'] as const;
export type ReplyPatternCategory = typeof REPLY_PATTERN_CATEGORIES[number];

export interface ReplyPatternContext {
  /** The running app version, for example `1.0.413`. */
  appVersion?: string;
  /** MCP tool names; the default is every MCP tool name of the contracts package. */
  toolNames?: readonly string[];
}

const NAME_EDGE_BEFORE = '(?<![A-Za-z0-9_])';
const NAME_EDGE_AFTER = '(?![A-Za-z0-9_])';
const escapeRegExp = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const VERSION_FORM = /(?<![\d.])1\.0\.\d+(?!\d)/;
// A drive path such as C:\x or c:/x. The letter before the colon must stand alone, so https:// does not match.
const DRIVE_PATH = /(?<![A-Za-z0-9])[A-Za-z]:[\\/]/;
const APP_FOLDER_NAME = /lineagentassistant|agent-workspace/i;
const MID = /(?<![0-9A-Za-z])u[0-9a-f]{32}(?![0-9A-Za-z])/;
const CHAT_ID = /(?<![0-9A-Za-z])[cr][0-9a-f]{32}(?![0-9A-Za-z])/;

export const defaultToolNames = (): readonly string[] => McpInternalToolNameSchema.options;

/** The categories that match in `text`, in the fixed order of REPLY_PATTERN_CATEGORIES. The text is not changed. */
export function scanReplyPatterns(text: string, context: ReplyPatternContext = {}): ReplyPatternCategory[] {
  const hits = new Set<ReplyPatternCategory>();
  if (VERSION_FORM.test(text)) hits.add('version');
  else if (context.appVersion && new RegExp(`(?<![\\d.])v?${escapeRegExp(context.appVersion)}(?!\\d)`).test(text)) hits.add('version');
  // Real paths only: the labels that the path redaction writes are not a hit.
  if (DRIVE_PATH.test(text) || APP_FOLDER_NAME.test(text)) hits.add('path');
  for (const name of context.toolNames ?? defaultToolNames()) {
    if (new RegExp(`${NAME_EDGE_BEFORE}${escapeRegExp(name)}${NAME_EDGE_AFTER}`).test(text)) { hits.add('tool'); break; }
  }
  if (MID.test(text)) hits.add('mid');
  if (CHAT_ID.test(text)) hits.add('chat_id');
  return REPLY_PATTERN_CATEGORIES.filter((category) => hits.has(category));
}
