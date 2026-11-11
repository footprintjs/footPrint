/**
 * plainObject.ts — what a subflow boundary treats as "an object with fields".
 *
 * A plain object is the only shape that is spread into per-field writes at a subflow boundary
 * (`setObject([key], field, …)`, a row and a redaction verdict per field). A `Date`, `Map`, `Set` or
 * class instance has no fields to spread and is a value in its own right: it lands WHOLE (until
 * 9.24.0 it was spread into zero writes and silently vanished at both boundaries).
 *
 * WHY ITS OWN FILE. Two places must give the same answer: the merge-back (`SubflowInputMapper`), which
 * merges what this calls a plain object and replaces everything else, and the report of a mapper that
 * edits in place (`mapperEdits`), whose advice says what handing a value back will do. With two copies
 * of the test the advice drifts from the merge-back (the third reader of that report found a `Map`
 * told it would be merged). `mapperScope` sits between the two files, so neither can import the other.
 */
export function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}
