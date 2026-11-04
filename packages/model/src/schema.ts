// Provider strict-output syntax is narrower than the schema validated by callers.
// Only the wire schema is projected; callers still validate the original schema.
// https://developers.openai.com/api/docs/guides/structured-outputs
export function outputSchema(
  schema: Record<string, unknown>,
): Record<string, unknown> {
  const result = { ...schema };
  delete result.$schema;
  delete result.default;
  delete result.minLength;
  delete result.maxLength;
  const formats = [
    "date-time",
    "time",
    "date",
    "duration",
    "email",
    "hostname",
    "ipv4",
    "ipv6",
    "uuid",
  ];
  if (typeof result.format === "string" && !formats.includes(result.format))
    delete result.format;
  if ("const" in result) {
    result.enum = [result.const];
    delete result.const;
  }
  if (Array.isArray(result.oneOf) && !result.anyOf) {
    result.anyOf = result.oneOf;
    delete result.oneOf;
  }
  const visit = (value: unknown): unknown =>
    value && typeof value === "object" && !Array.isArray(value)
      ? outputSchema(value as Record<string, unknown>)
      : value;
  for (const key of ["properties", "$defs", "definitions", "patternProperties"])
    if (result[key] && typeof result[key] === "object")
      result[key] = Object.fromEntries(
        Object.entries(result[key] as Record<string, unknown>).map(
          ([name, value]) => [name, visit(value)],
        ),
      );
  for (const key of ["anyOf", "oneOf", "allOf", "prefixItems"])
    if (Array.isArray(result[key]))
      result[key] = (result[key] as unknown[]).map(visit);
  for (const key of [
    "items",
    "additionalProperties",
    "contains",
    "not",
    "if",
    "then",
    "else",
  ])
    if (key in result) result[key] = visit(result[key]);
  return result;
}
