/** Reactions derived at read time from the native row cell `_reactionStatus` (messages.raw.native.row). */
export type MessageReactionKind = 'NICE' | 'LOVE' | 'FUN' | 'AMAZING' | 'SAD' | 'OMG' | 'PAID';

export interface MessageReaction {
  kind: MessageReactionKind;
  productId?: string;
  emojiId?: string;
  count: number;
  reactorIds: string[];
}

export const MAX_REACTION_GROUPS = 20;
export const MAX_REACTORS_PER_REACTION = 50;

const PREDEFINED: Readonly<Record<number, Exclude<MessageReactionKind, 'PAID'>>> = {
  2: 'NICE', 3: 'LOVE', 4: 'FUN', 5: 'AMAZING', 6: 'SAD', 7: 'OMG',
};
const PRODUCT_ID = /^[0-9a-f]{24}$/;
const EMOJI_ID = /^[0-9]{1,6}$/;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

function reactionStatus(raw: unknown): unknown {
  if (!isRecord(raw)) return null;
  const native = raw.native;
  if (!isRecord(native)) return null;
  const row = native.row;
  if (!isRecord(row) || !Array.isArray(row.columns) || !Array.isArray(row.cells)) return null;
  const index = row.columns.indexOf('_reactionStatus');
  if (index < 0) return null;
  let cell: unknown = row.cells[index];
  // A cell is either the JSON text itself or a `{ value, sqliteType }` wrapper around it.
  if (isRecord(cell) && !('reactionList' in cell) && 'value' in cell) cell = cell.value;
  if (typeof cell === 'string') {
    if (cell.length === 0 || cell.length > 1_000_000) return null;
    try { return JSON.parse(cell) as unknown; } catch { return null; }
  }
  return cell;
}

/** Never throws. Returns [] for a missing, empty or malformed cell. */
export function nativeReactions(raw: unknown): MessageReaction[] {
  try {
    const status = reactionStatus(raw);
    if (!isRecord(status) || !Array.isArray(status.reactionList)) return [];
    const groups = new Map<string, { kind: MessageReactionKind; productId?: string; emojiId?: string; first: number; order: number; reactors: Set<string> }>();
    status.reactionList.forEach((entry: unknown, order) => {
      if (!isRecord(entry) || entry.cancel === true) return;
      const reactor = entry.reactor;
      if (typeof reactor !== 'string' || reactor.length === 0 || reactor.length > 100) return;
      const created = typeof entry.createdAt === 'number' && Number.isFinite(entry.createdAt) ? entry.createdAt : Number.MAX_SAFE_INTEGER;
      let key: string; let kind: MessageReactionKind; let productId: string | undefined; let emojiId: string | undefined;
      if (entry.type === 1) {
        const name = typeof entry.PredefinedType === 'number' ? PREDEFINED[entry.PredefinedType] : undefined;
        if (!name) return;
        key = name; kind = name;
      } else if (entry.type === 2) {
        const paid = entry.PaidType;
        if (!isRecord(paid) || typeof paid.productId !== 'string' || typeof paid.emojiId !== 'string'
          || !PRODUCT_ID.test(paid.productId) || !EMOJI_ID.test(paid.emojiId)) return;
        productId = paid.productId; emojiId = paid.emojiId;
        key = `PAID:${productId}:${emojiId}`; kind = 'PAID';
      } else return;
      let group = groups.get(key);
      if (!group) {
        group = { kind, ...(productId ? { productId } : {}), ...(emojiId ? { emojiId } : {}), first: created, order, reactors: new Set() };
        groups.set(key, group);
      }
      group.first = Math.min(group.first, created);
      group.reactors.add(reactor);
    });
    return [...groups.values()]
      .sort((a, b) => a.first - b.first || a.order - b.order)
      .slice(0, MAX_REACTION_GROUPS)
      .map((group) => ({
        kind: group.kind,
        ...(group.productId ? { productId: group.productId } : {}),
        ...(group.emojiId ? { emojiId: group.emojiId } : {}),
        count: group.reactors.size,
        reactorIds: [...group.reactors].slice(0, MAX_REACTORS_PER_REACTION),
      }));
  } catch { return []; }
}
