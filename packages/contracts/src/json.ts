import { z } from 'zod';

export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

export const JsonValueSchema: z.ZodType<JsonValue> = z.lazy(() =>
  z.union([
    z.null(),
    z.boolean(),
    z.number().finite(),
    z.string(),
    z.array(JsonValueSchema),
    z.record(z.string(), JsonValueSchema),
  ]),
);

export function toJsonSafe(value: unknown): JsonValue {
  const serialized = JSON.stringify(value, (_key, item: unknown) =>
    typeof item === 'bigint' ? item.toString(10) : item,
  );
  if (serialized === undefined) {
    throw new TypeError('Value cannot be represented as JSON');
  }
  return JSON.parse(serialized) as JsonValue;
}
