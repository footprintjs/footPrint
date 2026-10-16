/**
 * attempt/name.ts — the ONE rule for a name an attempt record carries (design §3.6, threat model, packet P2): the
 * target of a `$call` / `attempt()`, a standalone series, and an observed report's target and source.
 *
 * A target is a NAME from code — `'stripe.quotes.create'` — never from a model and never a value. It rides every
 * record, narrative line, recorder row and metric key exactly as given, so a name is refused unless it is a string
 * of 1–{@link MAX_NAME_LENGTH} characters with no control (C0, DEL, C1), format (zero-width, bidi overrides),
 * surrogate or line/paragraph-separator character:
 *   - an empty name names nothing;
 *   - an overlong one is a value, or a flood of one;
 *   - a control or separator character forges a narrative line or a log record, and a bidi override hides what a
 *     line says.
 * The refusal names the FIELD, never the value (P4's precedent): a rejected name may be exactly what must not be
 * echoed. A `TypeError`, because a malformed name is the caller's code breaking its contract.
 */

/** The longest name an attempt record carries. */
export const MAX_NAME_LENGTH = 128;

/** Control, format, surrogate and line/paragraph-separator characters — none may sit in a name. */
const FORBIDDEN = /[\p{Cc}\p{Cf}\p{Cs}\p{Zl}\p{Zp}]/u;

/** Why `value` is not a name, or `undefined` when it is one. */
export function attemptNameProblem(value: unknown): string | undefined {
  if (typeof value !== 'string') return 'must be a string';
  if (value.length === 0) return 'must not be empty';
  if (value.length > MAX_NAME_LENGTH) return `must be at most ${MAX_NAME_LENGTH} characters`;
  if (FORBIDDEN.test(value)) return 'must not contain control, format or line-separator characters';
  return undefined;
}

/** `value` as a name, or a `TypeError` that names `where` and `field` (never the value). */
export function admitAttemptName(where: string, field: string, value: unknown): string {
  const problem = attemptNameProblem(value);
  if (problem !== undefined) {
    throw new TypeError(`${where}: ${field} ${problem} — it is a name from code, never a value`);
  }
  return value as string;
}
