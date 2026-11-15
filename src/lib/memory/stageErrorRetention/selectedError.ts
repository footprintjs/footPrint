/**
 * One thrown value and what a logger or a serializer prints with it: its own
 * keys at every depth, and its `cause` / an `AggregateError`'s `errors` — own
 * NON-enumerable keys no key walk sees — each walked the same way (a cycle
 * among them is followed once).
 */
export function selectedError(
  value: object,
  base: string | undefined,
  memo: { has(value: unknown): boolean } | undefined,
  selected: (value: object, base: string | undefined) => boolean,
  seen = new Set<object>(),
): boolean {
  if (seen.has(value)) return false;
  seen.add(value);
  // A wrapper cannot expose a raw cause already served masked within this origin.
  if (memo?.has(value) || selected(value, base)) return true;
  const own = (key: string): unknown =>
    Object.prototype.hasOwnProperty.call(value, key) ? (value as Record<string, unknown>)[key] : undefined;
  const errors = own('errors');
  for (const part of [own('cause'), ...(Array.isArray(errors) ? errors : [])]) {
    if (part !== null && typeof part === 'object' && selectedError(part, base, memo, selected, seen)) return true;
  }
  return false;
}
