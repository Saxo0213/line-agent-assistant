import { VERIFICATION_CODE_MARKER, redactVerificationCodes, storedTextForKind, type InboundEnvelope } from '@line-agent/contracts';

// Detection only; storage redaction (in-place replacement, recomputed mention ranges, text per kind)
// is the shared contract in @line-agent/contracts redaction.ts, also used by the native writer.
const CODE_PATTERN = /LW-[A-HJ-NP-Z2-9]{8}/g;
const REDACTED = VERIFICATION_CODE_MARKER;

export type SanitizedIngress = Readonly<{
  envelope: InboundEnvelope;
  sensitive: boolean;
  secretCandidate: Readonly<{ code: string; exact: boolean }> | null;
}>;

function matchingCodes(value: unknown, matches: string[], seen: WeakSet<object>): void {
  if (typeof value === 'string') {
    for (const match of value.matchAll(CODE_PATTERN)) matches.push(match[0]);
    return;
  }
  if (typeof value !== 'object' || value === null || seen.has(value)) return;
  seen.add(value);
  if (Array.isArray(value)) for (const entry of value) matchingCodes(entry, matches, seen);
  else for (const [key, entry] of Object.entries(value)) {
    matchingCodes(key, matches, seen);
    matchingCodes(entry, matches, seen);
  }
}

function redactRaw(value: unknown, seen: WeakMap<object, unknown>): unknown {
  if (typeof value === 'string') return value.replace(CODE_PATTERN, REDACTED);
  if (typeof value !== 'object' || value === null) return value;
  const existing = seen.get(value);
  if (existing !== undefined) return existing;
  if (Array.isArray(value)) {
    const result: unknown[] = [];
    seen.set(value, result);
    for (const entry of value) result.push(redactRaw(entry, seen));
    return result;
  }
  const result: Record<string, unknown> = {};
  seen.set(value, result);
  for (const [key, entry] of Object.entries(value)) result[key.replace(CODE_PATTERN, REDACTED)] = redactRaw(entry, seen);
  return result;
}

export function sanitizeInbound(
  envelope: InboundEnvelope,
  options: Readonly<{ ownMid?: string }> = {},
): SanitizedIngress {
  const matches: string[] = [];
  matchingCodes(envelope.text, matches, new WeakSet());
  matchingCodes(envelope.raw, matches, new WeakSet());
  for (const attachment of envelope.attachments) {
    matchingCodes(attachment.name, matches, new WeakSet());
    matchingCodes(attachment.mimeType, matches, new WeakSet());
  }
  if (envelope.contact) matchingCodes(envelope.contact.displayName, matches, new WeakSet());
  const code = envelope.text?.match(CODE_PATTERN)?.[0] ?? null;
  const liveUserMessage = envelope.ingestion.source === 'live' && options.ownMid !== undefined && envelope.senderId !== options.ownMid;
  let candidateText = envelope.text;
  if (candidateText !== null && (envelope.chatType === 'group' || envelope.chatType === 'room')) {
    const ownRanges = envelope.mentionRanges.filter((range) => range.userId === options.ownMid);
    candidateText = ownRanges.length === 1
      ? candidateText.slice(0, ownRanges[0]!.start) + candidateText.slice(ownRanges[0]!.end) : null;
  }
  const candidateCode = envelope.kind === 'text' ? candidateText?.match(CODE_PATTERN)?.[0] ?? null : null;
  const secretCandidate = candidateCode && liveUserMessage
    ? { code: candidateCode, exact: candidateText?.trim() === candidateCode }
    : null;
  const containsCode = matches.length > 0;
  const isContact = envelope.kind === 'contact';
  const attachments = envelope.attachments.map((attachment) => ({
    ...attachment,
    name: attachment.name?.replace(CODE_PATTERN, REDACTED) ?? null,
    mimeType: attachment.mimeType?.replace(CODE_PATTERN, REDACTED) ?? null,
  }));
  // Only the matched substring is replaced; the candidate above was read from the unsanitized text.
  const redacted = envelope.text === null ? null : redactVerificationCodes(envelope.text, envelope.mentionRanges);
  const text = storedTextForKind(envelope.kind, redacted?.text ?? null);
  const sanitized: InboundEnvelope = isContact
    ? { ...envelope, text,
      ...(envelope.contact ? { contact: { ...envelope.contact,
        displayName: envelope.contact.displayName?.replace(CODE_PATTERN, REDACTED) ?? null } } : {}),
      mentionIds: [], mentionRanges: [], attachments, raw: {} }
    : {
      ...envelope,
      text,
      mentionRanges: text === null ? [] : redacted?.mentionRanges ?? [],
      attachments,
      raw: redactRaw(envelope.raw, new WeakMap()) as InboundEnvelope['raw'],
    };
  return { envelope: sanitized, sensitive: containsCode || isContact, secretCandidate };
}
