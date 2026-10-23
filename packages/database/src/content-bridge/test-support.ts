import { createHash } from 'node:crypto';
import type { NativeSourceEnvelope } from '@line-agent/contracts';

type PlainField = string | number | Buffer | null;

/** Builds the `format 2` plain envelope the native reader writes (cells tagged like NativeSourceCell.SourceJsonValue). */
export function plainEnvelope(fields: Record<string, PlainField>, table: '_message' = '_message'): Extract<NativeSourceEnvelope, { format: 2 }> {
  const columns = Object.keys(fields);
  const cells = columns.map((column) => {
    const value = fields[column]!;
    if (value === null) return null;
    if (typeof value === 'string') return value;
    if (typeof value === 'number') return { sqliteType: 'integer' as const, value: String(value) };
    return { sqliteType: 'blob' as const, encoding: 'base64' as const, data: value.toString('base64') };
  });
  return { format: 2, table, sourceDigest: createHash('sha256').update(JSON.stringify([columns, cells])).digest('hex'),
    encoding: 'plain', row: { columns, cells } };
}

/** A legacy DPAPI envelope (opaque to the bridge). */
export function dpapiEnvelope(sourceDigest: string): Extract<NativeSourceEnvelope, { format: 1 }> {
  return { format: 1, table: '_message', sourceDigest, encoding: 'dpapi', data: 'AAAA' };
}
