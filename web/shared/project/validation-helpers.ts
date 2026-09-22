// Check ok before reading value
// Failed checks carry the field path for import feedback later
export type ValidationResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: { readonly path: string; readonly message: string } };

export function invalid(path: string, message: string): ValidationResult<never> {
  return { ok: false, error: { path, message } };
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  // typeof also calls null and arrays objects
  // Neither can hold a project record
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function checkFields(
  record: Record<string, unknown>,
  fields: readonly string[],
  path: string,
): ValidationResult<true> {
  // Inherited properties shouldn't fill gaps in imported data
  for (const field of fields) {
    if (!Object.hasOwn(record, field)) {
      return invalid(`${path}.${field}`, "Required field is missing");
    }
  }
  // Catch misspelled or unsupported fields before we discard anything
  for (const field of Object.keys(record)) {
    if (!fields.includes(field)) {
      return invalid(`${path}.${field}`, "Unknown field");
    }
  }
  return { ok: true, value: true };
}
