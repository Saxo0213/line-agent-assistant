import type { AgentProvider, InboundEnvelope } from '@line-agent/contracts';

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

/** The message text with this account's structured mention removed (the whole text when it carries none), trimmed. */
function textWithoutOwnMention(envelope: InboundEnvelope, ownMid: string | null): string {
  const text = envelope.text ?? '';
  const mention = findOwnMentionRange(envelope, ownMid);
  return (mention ? text.slice(0, mention.start) + text.slice(mention.end) : text).trim();
}

/** True for a group/room text that is a `/free` command (with or without an Agent mention). */
export function isFreeCommandText(envelope: InboundEnvelope, ownMid: string | null): boolean {
  return envelope.chatType !== 'direct' && envelope.text !== null && parseFreeCommand(textWithoutOwnMention(envelope, ownMid)) !== null;
}

export interface TriggerContext {
  ownMid: string | null;
  agentEnabled: boolean;
  senderIsPrimaryAdmin: boolean;
  workspaceConfigured: boolean;
  defaultProvider: AgentProvider;
  /** Group free mode is on for this chat: any member's text counts as addressed to the Agent. */
  freeModeActive?: boolean;
}

export type TriggerDecision =
  | { type: 'ignore' }
  | { type: 'prompt'; provider: AgentProvider; prompt: string }
  | { type: 'stop' | 'new' | 'status' }
  | FreeCommand
  | { type: 'free_message' };

export function routeTrigger(envelope: InboundEnvelope, context: TriggerContext): TriggerDecision {
  // Group free mode (docs/architecture/group-free-mode.md): `/free` is a Primary Administrator command, mention optional.
  // The sender gates of routeNormalTrigger (live, text, not own, decrypt_failed) hold for every free decision too.
  const group = envelope.chatType !== 'direct' && !isNormallyIgnored(envelope, context);
  const free = group ? parseFreeCommand(textWithoutOwnMention(envelope, context.ownMid)) : null;
  if (free) {
    if (context.senderIsPrimaryAdmin) return free;
    return context.freeModeActive ? { type: 'free_message' } : { type: 'ignore' };
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
  if (!text) return { type: 'ignore' };
  if (text === '/stop') return { type: 'stop' };
  if (text === '/new') return { type: 'new' };
  if (text === '/status') return { type: 'status' };
  const command = /^\/agent\s+(codex|claude)(?:\s+([\s\S]*))?$/i.exec(text);
  const provider = command ? command[1]!.toLowerCase() as AgentProvider : context.defaultProvider;
  const prompt = (command ? command[2] ?? '' : text).trim();
  return prompt ? { type: 'prompt', provider, prompt } : { type: 'ignore' };
}
