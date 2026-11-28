import { AGENT_ROOM_HISTORY_HINT, formatAskerLine, formatIdentityBlock, outputChannelLine, withIdentityBlock, withMcpSkill, type JobIdentityView } from './mcp-skill.js';

/** Identity of one resident session: the Agent room session, or the session of one LINE chat. */
export type ResidentIdentity = readonly ['ui'] | readonly ['line', string, string, string];

/** The session key of a job, reduced to the fields that name the session. */
export interface ResidentSessionKey {
  accountId: string | null;
  chatType: string | null;
  chatId: string | null;
}

/** Resident identity of a session or chat key. An account-less key is the Agent room. */
export function residentIdentity(key: ResidentSessionKey): ResidentIdentity {
  if (key.accountId === null || key.chatType === null || key.chatId === null) return ['ui'];
  return ['line', key.accountId, key.chatType, key.chatId];
}

/** Resident key = JSON of ["claude", identity, generation, sourceId]. The key has no arguments hash. */
export function residentKey(identity: ResidentIdentity, generation: number, sourceId: string): string {
  return JSON.stringify(['claude', identity, generation, sourceId]);
}

/** Splits a resident key. Returns null when the text is not a valid key. */
export function parseResidentKey(key: string): { identity: ResidentIdentity; generation: number; sourceId: string } | null {
  let value: unknown;
  try { value = JSON.parse(key); } catch { return null; }
  if (!Array.isArray(value) || value.length !== 4 || value[0] !== 'claude') return null;
  const [, identity, generation, sourceId] = value as [string, unknown, unknown, unknown];
  if (typeof generation !== 'number' || !Number.isInteger(generation)) return null;
  if (typeof sourceId !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(sourceId)) return null;
  if (!Array.isArray(identity)) return null;
  if (identity.length === 1 && identity[0] === 'ui') return { identity: ['ui'], generation, sourceId };
  if (identity.length === 4 && identity[0] === 'line' && identity.slice(1).every((part) => typeof part === 'string')) {
    return { identity: ['line', identity[1] as string, identity[2] as string, identity[3] as string], generation, sourceId };
  }
  return null;
}

/** The provider session key of a resident identity, as the pump builds it (Claude only). */
export function residentSessionKey(identity: ResidentIdentity):
  { accountId: null; chatType: null; chatId: null; provider: 'claude'; sourceType: 'ui' }
  | { accountId: string; chatType: 'direct' | 'group' | 'room'; chatId: string; provider: 'claude'; sourceType: 'line' } {
  if (identity[0] === 'ui') return { accountId: null, chatType: null, chatId: null, provider: 'claude', sourceType: 'ui' };
  return { accountId: identity[1], chatType: identity[2] as 'direct' | 'group' | 'room', chatId: identity[3], provider: 'claude', sourceType: 'line' };
}

export interface ResidentPromptInput {
  sourceType: 'line' | 'ui';
  /** The Skill text. Null: none. Used only when `mcp` is true. */
  skill: string | null;
  /** True when the Agent has the internal MCP. Without it the Skill, output-channel line, history hint and identity block are left out (as in the one-shot prompt). */
  mcp: boolean;
  historyEligible: boolean;
  identity: JobIdentityView | null;
  /** The job prompt with the schedule context, if any. */
  visiblePrompt: string;
  projectFolderSection: string;
  personaSection: string;
  replySection: string;
  attachmentSection: string;
  /** The waiting external sessions of the Primary Admin's direct chat (one turn); empty adds nothing. */
  waitingSessionsSection?: string;
  /** The 發問者 line of a LINE job (Primary Admin or member). Null or absent: none. */
  requesterLine?: string | null;
}

/**
 * Splits the prompt of a resident Claude job.
 * systemPrompt (fixed for the process): skill, output-channel line, history hint, identity block without the asker line,
 * project-folder section, persona section.
 * message (one turn): requester line (LINE jobs), asker line (group and room chats only), job prompt, reply-context section, attachment section, waiting-session section.
 */
export function buildResidentPrompt(input: ResidentPromptInput): { systemPrompt: string; message: string } {
  const head: string[] = [];
  if (input.mcp) {
    head.push(outputChannelLine(input.sourceType));
    if (input.historyEligible) head.push(AGENT_ROOM_HISTORY_HINT);
    const block = input.identity ? formatIdentityBlock(input.identity, { asker: false }) : null;
    if (block) head.push(block);
  }
  const channelAndMore = head.join('\n\n');
  const withSkill = input.mcp ? withMcpSkill(input.skill, channelAndMore) : channelAndMore;
  const tail = `${input.projectFolderSection}${input.personaSection}`;
  const systemPrompt = withSkill ? `${withSkill}${tail}` : tail.replace(/^\n+/, '');
  const askerLine = input.identity ? formatAskerLine(input.identity) : null;
  const turnLines = [input.requesterLine, askerLine].filter((line): line is string => !!line).join('\n');
  const visible = turnLines ? withIdentityBlock(input.visiblePrompt, turnLines) : input.visiblePrompt;
  return { systemPrompt, message: `${visible}${input.replySection}${input.attachmentSection}${input.waitingSessionsSection ?? ''}` };
}
