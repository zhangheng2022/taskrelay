import { z } from "zod";

// Cache only immutable schema definitions, never messages, users or credentials.
// Zod's combinators produce a new schema object and therefore a new cache entry.
const schemas = new WeakMap<z.ZodType, Record<string, unknown>>();
export function jsonSchema(schema: z.ZodType): Record<string, unknown> {
  let result = schemas.get(schema);
  if (!result) {
    result = z.toJSONSchema(schema) as Record<string, unknown>;
    schemas.set(schema, result);
  }
  return result;
}
