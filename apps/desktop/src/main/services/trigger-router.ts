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

export interface TriggerContext {
  ownMid: string | null;
  agentEnabled: boolean;
  senderIsPrimaryAdmin: boolean;
  workspaceConfigured: boolean;
  defaultProvider: AgentProvider;
}

export type TriggerDecision =
  | { type: 'ignore' }
  | { type: 'prompt'; provider: AgentProvider; prompt: string }
  | { type: 'stop' | 'new' | 'status' };

export function routeTrigger(envelope: InboundEnvelope, context: TriggerContext): TriggerDecision {
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
