import type { AgentLiveliness, AgentProvider, InboundEnvelope } from '@line-agent/contracts';
import { parseLivelinessWord } from './agent-persona.js';
import { parseModelCommand, type ModelCommand } from './model-command.js';

export function findOwnMentionRange(
  envelope: InboundEnvelope,
  ownMid: string | null,
  acceptRange: (range: { start: number; end: number }, text: string) => boolean = () => true,
): { start: number; end: number } | null {
  const text = envelope.text;
  if (ownMid === null || text === null || !envelope.mentionIds.includes(ownMid)) return null;
  for (const range of envelope.mentionRanges) {
    if (range.userId !== ownMid || range.start < 0 || range.end <= range.start || range.end > text.length
      || !envelope.mentionIds.includes(range.userId)) continue;
    const beginsOnCodePoint = range.start === 0 || !/[\uDC00-\uDFFF]/.test(text[range.start]!);
    const endsOnCodePoint = range.end === text.length || !/[\uDC00-\uDFFF]/.test(text[range.end]!);
    if (text.slice(range.start, range.end).startsWith('@') && beginsOnCodePoint && endsOnCodePoint
      && acceptRange(range, text)) {
      return { start: range.start, end: range.end };
    }
  }
  return null;
}

export function hasOwnMention(envelope: InboundEnvelope, ownMid: string | null): boolean {
  return findOwnMentionRange(envelope, ownMid) !== null;
}

export const FREE_MODE_DEFAULT_MINUTES = 5;
export const FREE_MODE_MIN_MINUTES = 1;
export const FREE_MODE_MAX_MINUTES = 120;

export type FreeCommand = { type: 'free'; action: 'on'; minutes: number } | { type: 'free'; action: 'off' } | { type: 'free_range' };

/** Parses `/free`, `/free N` and `/free off` (already trimmed, mention removed). Anything else is not a free command. */
export function parseFreeCommand(text: string): FreeCommand | null {
  const match = /^\/free(?:\s+([\s\S]*))?$/i.exec(text.trim());
  if (!match) return null;
  const argument = (match[1] ?? '').trim();
  if (argument === '') return { type: 'free', action: 'on', minutes: FREE_MODE_DEFAULT_MINUTES };
  if (argument.toLowerCase() === 'off') return { type: 'free', action: 'off' };
  if (!/^\d{1,6}$/.test(argument)) return { type: 'free_range' };
  const minutes = Number(argument);
  return minutes >= FREE_MODE_MIN_MINUTES && minutes <= FREE_MODE_MAX_MINUTES
    ? { type: 'free', action: 'on', minutes } : { type: 'free_range' };
}

/** Fixed prompt for a group message that is only the Agent mention. */
export const MENTION_ONLY_INSTRUCTION = '使用者在聊天室中只標註了你，沒有附上其他文字。請查看此聊天室最近的訊息，找出該使用者想請你處理的事，然後回答。若找不到明確的請求，請用一句簡短的話問該使用者需要什麼。';
export const MENTION_CONTEXT_MAX_MESSAGES = 8;
export const MENTION_CONTEXT_MAX_TEXT = 500;

export interface MentionContextMessage {
  messageId: string;
  senderName: string;
  kind: string;
  text: string | null;
  occurredAt: string;
}

const KIND_PLACEHOLDERS: Record<string, string> = {
  image: '[圖片]', video: '[影片]', audio: '[語音]', file: '[檔案]', sticker: '[貼圖]', contact: '[聯絡人]', location: '[位置]', rich: '[圖文訊息]',
};
const taipeiClock = new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Taipei', hour: '2-digit', minute: '2-digit', hour12: false });

function mentionContextLine(message: MentionContextMessage): string {
  const flat = (message.text ?? '').replace(/\s*[\r\n]+\s*/g, ' ').trim();
  const body = message.kind === 'text' && flat
    ? (flat.length > MENTION_CONTEXT_MAX_TEXT ? `${flat.slice(0, MENTION_CONTEXT_MAX_TEXT)}…` : flat)
    : KIND_PLACEHOLDERS[message.kind] ?? '[其他訊息]';
  const date = new Date(message.occurredAt);
  const clock = Number.isNaN(date.getTime()) ? '--:--' : taipeiClock.format(date);
  return `${message.senderName.trim() || '未知發言人'} ${clock} ${body}`;
}

/**
 * The prompt for a mention-only message: the fixed instruction plus the newest messages (oldest first, no duplicate ids).
 * A failed read gives the instruction without context.
 */
export async function composeMentionOnlyPrompt(load: () => Promise<MentionContextMessage[]>): Promise<string> {
  let messages: MentionContextMessage[];
  try { messages = await load(); } catch { return MENTION_ONLY_INSTRUCTION; }
  const unique = new Map<string, MentionContextMessage>();
  for (const message of messages) if (!unique.has(message.messageId)) unique.set(message.messageId, message);
  const recent = [...unique.values()]
    .sort((a, b) => Date.parse(a.occurredAt) - Date.parse(b.occurredAt) ||a.messageId.localeCompare(b.messageId))
    .slice(-MENTION_CONTEXT_MAX_MESSAGES);
  return recent.length ? `${MENTION_ONLY_INSTRUCTION}\n\n最近的聊天訊息（由舊到新）：\n${recent.map(mentionContextLine).join('\n')}` : MENTION_ONLY_INSTRUCTION;
}

/** The message text with this account's structured mention removed (the whole text when it carries none), trimmed. */
function textWithoutOwnMention(envelope: InboundEnvelope, ownMid: string | null): string {
  const text = envelope.text ?? '';
  const mention = findOwnMentionRange(envelope, ownMid);
  return (mention ? text.slice(0, mention.start) + text.slice(mention.end) : text).trim();
}

/** `/權限` and `/permissions` (exact text). The dialogue lives in the Primary Administrator's direct chat only. */
export const PERMISSION_COMMAND_PATTERN = /^(\/權限|\/permissions)$/i;

/** `/help`, `/說明` and `/指令` (exact text, mention already removed). */
const HELP_COMMAND_PATTERN = /^(?:\/help|\/說明|\/指令)$/i;

/** True for a group/room text that is `/權限` or `/permissions` (with or without an Agent mention). */
export function isPermissionCommandText(envelope: InboundEnvelope, ownMid: string | null): boolean {
  return envelope.chatType !== 'direct' && envelope.text !== null && PERMISSION_COMMAND_PATTERN.test(textWithoutOwnMention(envelope, ownMid));
}

/** True for a group/room text that is a `/free` command (with or without an Agent mention). */
export function isFreeCommandText(envelope: InboundEnvelope, ownMid: string | null): boolean {
  return envelope.chatType !== 'direct' && envelope.text !== null && parseFreeCommand(textWithoutOwnMention(envelope, ownMid)) !== null;
}

/** `/persona` (docs/architecture/agent-persona.md): a group/room override of the Agent persona description and reply liveliness. */
export type PersonaCommand =
  | { type: 'persona'; action: 'show' }
  | { type: 'persona'; action: 'default' }
  | { type: 'persona'; action: 'liveliness'; liveliness: AgentLiveliness }
  | { type: 'persona'; action: 'description'; description: string };

/**
 * Parses `/persona`, `/persona default`, `/persona 安靜|一般|活潑` (also quiet|normal|lively) and `/persona <description>`
 * (already trimmed, mention removed). Anything else is not a persona command.
 */
export function parsePersonaCommand(text: string): PersonaCommand | null {
  const match = /^\/persona(?:\s+([\s\S]*))?$/i.exec(text.trim());
  if (!match) return null;
  const argument = (match[1] ?? '').trim();
  if (argument === '') return { type: 'persona', action: 'show' };
  if (argument.toLowerCase() === 'default') return { type: 'persona', action: 'default' };
  const liveliness = parseLivelinessWord(argument);
  return liveliness ? { type: 'persona', action: 'liveliness', liveliness } : { type: 'persona', action: 'description', description: argument };
}

/** True for a group/room text that is a `/persona` command, with or without an Agent mention. */
export function isPersonaCommandText(envelope: InboundEnvelope, ownMid: string | null): boolean {
  return envelope.chatType !== 'direct' && envelope.text !== null && parsePersonaCommand(textWithoutOwnMention(envelope, ownMid)) !== null;
}

/** `/rules`: the Primary Administrator's per-chat Agent rules (group/room). `bad_name` is a malformed rule file name, `usage` a malformed command. */
export type RulesCommand =
  | { type: 'rules'; action: 'show' | 'clear' | 'usage' | 'bad_name' }
  | { type: 'rules'; action: 'set'; text: string }
  | { type: 'rules'; action: 'add'; name: string; text: string }
  | { type: 'rules'; action: 'remove'; name: string };

/**
 * Parses `/rules`, `/rules clear`, `/rules remove <name>`, `/rules add <name> <text>` and `/rules <text>` (already trimmed, mention removed).
 * A rule file name is 1 to 32 letters, digits, `_` or `-`.
 */
export function parseRulesCommand(text: string): RulesCommand | null {
  const match = /^\/rules(?:\s+([\s\S]*))?$/i.exec(text.trim());
  if (!match) return null;
  const argument = (match[1] ?? '').trim();
  if (argument === '') return { type: 'rules', action: 'show' };
  if (/^clear$/i.test(argument)) return { type: 'rules', action: 'clear' };
  const nameOk = (name: string) => /^[\p{L}\p{N}_-]{1,32}$/u.test(name);
  const remove = /^remove(?:\s+([\s\S]*))?$/i.exec(argument);
  if (remove) {
    const name = (remove[1] ?? '').trim();
    return !name ? { type: 'rules', action: 'usage' } : nameOk(name) ? { type: 'rules', action: 'remove', name } : { type: 'rules', action: 'bad_name' };
  }
  const add = /^add(?:\s+(\S+)(?:\s+([\s\S]*))?)?$/i.exec(argument);
  if (add) {
    const name = add[1] ?? '';
    const body = (add[2] ?? '').trim();
    if (!name || !body) return { type: 'rules', action: 'usage' };
    return nameOk(name) ? { type: 'rules', action: 'add', name, text: body } : { type: 'rules', action: 'bad_name' };
  }
  return { type: 'rules', action: 'set', text: argument };
}

/** True for a group/room text that is a `/rules` command, with or without an Agent mention. */
export function isRulesCommandText(envelope: InboundEnvelope, ownMid: string | null): boolean {
  return envelope.chatType !== 'direct' && envelope.text !== null && parseRulesCommand(textWithoutOwnMention(envelope, ownMid)) !== null;
}

export type FolderMode = 'READ' | 'READ_WRITE';
/** `usage` is a malformed `/folder` (for example `/folder rw` without a path). */
export type FolderCommand =
  | { type: 'folder'; action: 'bind'; path: string; mode: FolderMode }
  | { type: 'folder'; action: 'list' }
  | { type: 'folder'; action: 'off'; path: string | null }
  | { type: 'folder'; action: 'temp_show' | 'temp_off' | 'temp_retry' }
  | { type: 'folder'; action: 'temp_set'; path: string }
  | { type: 'folder'; action: 'usage' };

const QUOTE_PAIRS: Record<string, string> = { '"': '"', "'": "'", '“': '”', '‘': '’' };
/** Removes one pair of surrounding quotes (straight or typographic) from a path argument. */
function unquotePath(argument: string): string {
  const value = argument.trim();
  const close = QUOTE_PAIRS[value[0] ?? ''];
  return close !== undefined && value.length >= 2 && value.endsWith(close) ? value.slice(1, -1).trim() : value;
}

/**
 * Parses `/folder`, `/folder <path>`, `/folder rw <path>`, `/folder off` and `/folder off <path>` (already trimmed, mention removed).
 * The path may contain spaces and may be quoted. Anything that does not start with the `/folder` word is not a folder command.
 */
export function parseFolderCommand(text: string): FolderCommand | null {
  const match = /^\/folder(?:\s+([\s\S]*))?$/i.exec(text.trim());
  if (!match) return null;
  const argument = (match[1] ?? '').trim();
  if (argument === '') return { type: 'folder', action: 'list' };
  const temp = /^temp(?:\s+([\s\S]*))?$/i.exec(argument);
  if (temp) {
    const value = (temp[1] ?? '').trim();
    if (!value) return { type: 'folder', action: 'temp_show' };
    if (/^off$/i.test(value)) return { type: 'folder', action: 'temp_off' };
    if (/^retry$/i.test(value)) return { type: 'folder', action: 'temp_retry' };
    const path = unquotePath(value);
    return path ? { type: 'folder', action: 'temp_set', path } : { type: 'folder', action: 'usage' };
  }
  if (/^off$/i.test(argument)) return { type: 'folder', action: 'off', path: null };
  const off = /^off\s+([\s\S]+)$/i.exec(argument);
  if (off) { const path = unquotePath(off[1]!); return path ? { type: 'folder', action: 'off', path } : { type: 'folder', action: 'usage' }; }
  if (/^rw$/i.test(argument)) return { type: 'folder', action: 'usage' };
  const readWrite = /^rw\s+([\s\S]+)$/i.exec(argument);
  const path = unquotePath(readWrite ? readWrite[1]! : argument);
  if (!path) return { type: 'folder', action: 'usage' };
  return { type: 'folder', action: 'bind', path, mode: readWrite ? 'READ_WRITE' : 'READ' };
}

/** True for a text (group, room or direct) that is a `/folder` command, with or without an Agent mention. */
export function isFolderCommandText(envelope: InboundEnvelope, ownMid: string | null): boolean {
  return envelope.text !== null && parseFolderCommand(textWithoutOwnMention(envelope, ownMid)) !== null;
}

/** True for a group/room text that is a bare `/agent claude|codex|default` (with or without an Agent mention). */
export function isAgentSwitchText(envelope: InboundEnvelope, ownMid: string | null): boolean {
  return envelope.chatType !== 'direct' && envelope.text !== null && parseAgentSwitch(textWithoutOwnMention(envelope, ownMid)) !== null;
}

export interface TriggerContext {
  ownMid: string | null;
  agentEnabled: boolean;
  senderIsPrimaryAdmin: boolean;
  workspaceConfigured: boolean;
  defaultProvider: AgentProvider;
  /** The sender is the Primary Administrator (senderIsPrimaryAdmin also covers whitelisted users who may address the Agent). Defaults to senderIsPrimaryAdmin. */
  primaryAdmin?: boolean;
  /** Group free mode is on for this chat: any member's text counts as addressed to the Agent. */
  freeModeActive?: boolean;
  /** The sender is the account's Primary Administrator (strictly: in a 1:1 chat a whitelisted friend is not). Only they can use `/folder`. */
  senderIsFolderAdmin?: boolean;
}

export type TriggerDecision =
  | { type: 'ignore' }
  /** `mentionOnly`: a group message that is only the Agent mention. The prompt is the fixed instruction; the caller adds the chat context. */
  | { type: 'prompt'; provider: AgentProvider; prompt: string; mentionOnly?: true }
  | { type: 'stop' | 'new' | 'status' }
  /** Primary Administrator's bare `/agent claude|codex|default`: set or clear this chat's Agent override. */
  | { type: 'agent_provider'; provider: AgentProvider | 'default' }
  /** A served non-administrator sent a bare `/agent claude|codex`: reply with the usage hint, change nothing. */
  | { type: 'agent_usage'; provider: AgentProvider }
  | { type: 'agent_quota' }
  /** `/權限` in a group or room, sent by a served sender: reply with the fixed hint, never route to the Agent. */
  | { type: 'permission_hint' }
  /** `/help`, `/說明` or `/指令` from the Primary Administrator in the one-to-one chat: reply with the command list. No Agent job. */
  | { type: 'help' }
  /** Primary Administrator's `/model` or `/model <argument>`: show, set or clear this chat's Claude model. No Agent job. */
  | { type: 'agent_model'; command: ModelCommand }
  | FreeCommand
  | FolderCommand
  | PersonaCommand
  | RulesCommand
  | { type: 'free_message' };

/** Bare `/agent claude|codex|default` (already trimmed, mention removed); anything with content is a prompt instead. */
export function parseAgentSwitch(text: string): { provider: AgentProvider | 'default' } | null {
  const match = /^\/agent\s+(codex|claude|default)\s*$/i.exec(text.trim());
  return match ? { provider: match[1]!.toLowerCase() as AgentProvider | 'default' } : null;
}

export function routeTrigger(envelope: InboundEnvelope, context: TriggerContext): TriggerDecision {
  // Provider quota is a Main-owned system query and never requires an Agent workspace or model turn.
  if (envelope.ingestion.source === 'live' && envelope.kind === 'text' && envelope.text !== null
    && context.ownMid !== null && envelope.senderId !== context.ownMid
    && !(typeof envelope.raw === 'object' && envelope.raw !== null && !Array.isArray(envelope.raw) && envelope.raw.contentState === 'decrypt_failed')) {
    const text = textWithoutOwnMention(envelope, context.ownMid);
    if (/^\/(?:quota|額度)$/i.test(text)
      && (envelope.chatType === 'direct' ? context.senderIsPrimaryAdmin
        : (context.agentEnabled || (context.primaryAdmin ?? context.senderIsPrimaryAdmin)) && hasOwnMention(envelope, context.ownMid))) return { type: 'agent_quota' };
  }
  // Group free mode (docs/architecture/group-free-mode.md): `/free` is a Primary Administrator command, mention optional.
  // The sender gates of routeNormalTrigger (live, text, not own, decrypt_failed) hold for every free decision too.
  // `/folder` (docs/architecture/project-folders.md) is a Primary Administrator command in every chat type, mention optional.
  // Anyone else's `/folder` is never executed: it falls through and is an ordinary message.
  if (!isNormallyIgnored(envelope, context)) {
    const folder = parseFolderCommand(textWithoutOwnMention(envelope, context.ownMid));
    if (folder && context.senderIsFolderAdmin) return folder;
  }
  const group = envelope.chatType !== 'direct' && !isNormallyIgnored(envelope, context);
  // `/persona` is a Primary Administrator command in groups and rooms, mention optional; anyone else's is an ordinary message.
  if (group) {
    const persona = parsePersonaCommand(textWithoutOwnMention(envelope, context.ownMid));
    if (persona && (context.primaryAdmin ?? context.senderIsPrimaryAdmin)) return persona;
    // `/rules` follows the same gate as `/persona`.
    const rules = parseRulesCommand(textWithoutOwnMention(envelope, context.ownMid));
    if (rules && (context.primaryAdmin ?? context.senderIsPrimaryAdmin)) return rules;
  }
  // `/權限` works only in the Primary Administrator's direct chat. A served sender gets the hint; anyone else gets nothing here.
  if (group && PERMISSION_COMMAND_PATTERN.test(textWithoutOwnMention(envelope, context.ownMid))) {
    if (context.agentEnabled || (context.primaryAdmin ?? context.senderIsPrimaryAdmin)) return { type: 'permission_hint' };
  }
  const free = group ? parseFreeCommand(textWithoutOwnMention(envelope, context.ownMid)) : null;
  if (free) {
    if (context.senderIsPrimaryAdmin) return free;
    return context.freeModeActive ? { type: 'free_message' } : { type: 'ignore' };
  }
  // In free mode the Primary Administrator may switch the chat's Agent without the mention, like /free.
  if (group && context.freeModeActive && (context.primaryAdmin ?? context.senderIsPrimaryAdmin)) {
    const switchCommand = parseAgentSwitch(textWithoutOwnMention(envelope, context.ownMid));
    if (switchCommand) return { type: 'agent_provider', provider: switchCommand.provider };
  }
  const decision = routeNormalTrigger(envelope, context);
  return group && decision.type === 'ignore' && context.freeModeActive ? { type: 'free_message' } : decision;
}

function isNormallyIgnored(envelope: InboundEnvelope, context: TriggerContext): boolean {
  return envelope.ingestion.source !== 'live' || envelope.kind !== 'text' || envelope.text === null
    || context.ownMid === null || envelope.senderId === context.ownMid || !context.workspaceConfigured
    || (typeof envelope.raw === 'object' && envelope.raw !== null && !Array.isArray(envelope.raw) && envelope.raw.contentState === 'decrypt_failed');
}

function routeNormalTrigger(envelope: InboundEnvelope, context: TriggerContext): TriggerDecision {
  if (envelope.ingestion.source !== 'live' || envelope.kind !== 'text' || envelope.text === null
    || context.ownMid === null || envelope.senderId === context.ownMid || !context.workspaceConfigured
  ) return { type: 'ignore' };
  if (typeof envelope.raw === 'object' && envelope.raw !== null && !Array.isArray(envelope.raw)
    && envelope.raw.contentState === 'decrypt_failed') return { type: 'ignore' };
  let text = envelope.text;
  if (envelope.chatType !== 'direct') {
    if (!context.agentEnabled && !context.senderIsPrimaryAdmin) return { type: 'ignore' };
    const mention = findOwnMentionRange(envelope, context.ownMid);
    if (!mention) return { type: 'ignore' };
    text = text.slice(0, mention.start) + text.slice(mention.end);
  } else if (!context.senderIsPrimaryAdmin) return { type: 'ignore' };
  text = text.trim();
  if (!text) {
    // A lone mention in a group or room calls the Agent. In free mode the old free-mode path keeps this message.
    return envelope.chatType !== 'direct' && !context.freeModeActive
      ? { type: 'prompt', provider: context.defaultProvider, prompt: MENTION_ONLY_INSTRUCTION, mentionOnly: true }
      : { type: 'ignore' };
  }
  if (text === '/stop') return { type: 'stop' };
  if (text === '/new') return { type: 'new' };
  if (text === '/status') return { type: 'status' };
  // `/help` is a command only for the Primary Administrator in the one-to-one chat; anywhere else it is ordinary text.
  if (envelope.chatType === 'direct' && (context.primaryAdmin ?? context.senderIsPrimaryAdmin) && HELP_COMMAND_PATTERN.test(text)) return { type: 'help' };
  const switchCommand = parseAgentSwitch(text);
  if (switchCommand) {
    if (context.primaryAdmin ?? context.senderIsPrimaryAdmin) return { type: 'agent_provider', provider: switchCommand.provider };
    // `default` from anyone else is ordinary text; bare codex/claude gets the usage hint.
    if (switchCommand.provider !== 'default') return { type: 'agent_usage', provider: switchCommand.provider };
  }
  // `/model` follows the `/agent default` rule: anyone but the Primary Administrator sends ordinary text.
  const modelCommand = parseModelCommand(text);
  if (modelCommand && (context.primaryAdmin ?? context.senderIsPrimaryAdmin)) return { type: 'agent_model', command: modelCommand };
  const command = /^\/agent\s+(codex|claude)(?:\s+([\s\S]*))?$/i.exec(text);
  const provider = command ? command[1]!.toLowerCase() as AgentProvider : context.defaultProvider;
  const prompt = (command ? command[2] ?? '' : text).trim();
  return prompt ? { type: 'prompt', provider, prompt } : { type: 'ignore' };
}
