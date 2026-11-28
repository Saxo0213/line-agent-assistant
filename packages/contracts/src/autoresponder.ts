import { z } from 'zod';

export interface AutoResponderRule {
  trigger: string;
  reply: string;
}

export interface AutoResponderSettings {
  version: number;
  displayName: string;
  fallback: string;
  rules: AutoResponderRule[];
}

export const AutoResponderRuleSchema = z.strictObject({ trigger: z.string().min(1).max(256), reply: z.string().min(1).max(2000) });
export const AutoResponderInputSchema = z.strictObject({ displayName: z.string().min(1).max(80), fallback: z.string().min(1).max(2000),
  rules: z.array(AutoResponderRuleSchema).max(50) }).superRefine((value, context) => {
  const error = validateAutoresponderConfig(value);
  if (error) context.addIssue({ code: 'custom', message: error });
});
export const AutoResponderSettingsSchema = AutoResponderInputSchema.extend({ version: z.number().int().nonnegative() });

export const DEFAULT_AUTORESPONDER_FALLBACK = '我不知道你在說甚麼；我不會回答你喔；今天天氣很好；你後面有人';

export function splitAutoresponderReplies(reply: string): string[] {
  const parts = reply.split(/[；;]/u).map((part) => part.trim()).filter((part) => part.length > 0);
  return parts.length > 0 ? parts : [reply.trim()];
}

export function normalizeAutoresponderTrigger(value: string): string {
  return value.normalize('NFC').trim().replace(/\s+/gu, ' ');
}

function hasAutoresponderReplyPart(reply: string): boolean {
  return reply.split(/[；;]/u).some((part) => part.trim().length > 0);
}

export function selectAutoresponderReply(text: string, rules: readonly AutoResponderRule[], fallback: string, random: () => number = Math.random): string {
  const normalized = normalizeAutoresponderTrigger(text);
  const reply = rules.find((rule) => normalizeAutoresponderTrigger(rule.trigger) === normalized)?.reply ?? fallback;
  const parts = splitAutoresponderReplies(reply);
  const index = Math.min(parts.length - 1, Math.max(0, Math.floor(random() * parts.length)));
  return parts[index]!;
}

export function validateAutoresponderConfig(input: {
  displayName: string;
  fallback: string;
  rules: readonly AutoResponderRule[];
}): string | null {
  if (input.displayName.length > 80) return 'displayName must be at most 80 characters';
  if (!hasAutoresponderReplyPart(input.fallback) || input.fallback.length > 2000) return 'fallback must contain 1 to 2000 characters';
  if (input.rules.length > 50) return 'rules must contain at most 50 entries';
  const seen = new Set<string>();
  for (const rule of input.rules) {
    const trigger = normalizeAutoresponderTrigger(rule.trigger);
    if (!trigger || trigger.length > 256) return 'trigger must contain 1 to 256 characters';
    if (!hasAutoresponderReplyPart(rule.reply) || rule.reply.length > 2000) return 'reply must contain 1 to 2000 characters';
    if (trigger === '\u76E3\u63A7' || trigger === '??' || /^[mM][oO][nN][iI][tT][oO][rR]$/.test(trigger) || /^RA-[A-Za-z0-9_-]+$/.test(trigger)) {
      return 'reserved trigger cannot be configured';
    }
    if (seen.has(trigger)) return 'duplicate normalized trigger';
    seen.add(trigger);
  }
  return null;
}
