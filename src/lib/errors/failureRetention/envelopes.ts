import type { StructuredErrorInfo } from '../errorInfo.js';

interface Slot {
  readonly replace: boolean;
  readonly value?: unknown;
  readonly kind: 'clear' | 'masked' | 'unknown';
}
const entries = new WeakMap<object, WeakMap<object, Slot>>();
const masked = new WeakSet<object>();

/** Only the real final error envelope is registered; raw results stay untouched. */
export function rememberErrorEnvelope(
  rule: object,
  envelope: object,
  raw: unknown,
  info: StructuredErrorInfo,
  kind: Slot['kind'],
): void {
  let book = entries.get(rule);
  if (!book) {
    book = new WeakMap();
    entries.set(rule, book);
  }
  const objectLike = raw !== null && (typeof raw === 'object' || typeof raw === 'function');
  const supported =
    objectLike ||
    typeof raw === 'string' ||
    typeof raw === 'number' ||
    typeof raw === 'bigint' ||
    typeof raw === 'symbol';
  const replace = supported && info.raw !== raw;
  book.set(
    envelope,
    replace
      ? Object.freeze({ replace, kind, value: objectLike ? Object.freeze({ ...info }) : info.message })
      : Object.freeze({ replace, kind }),
  );
  if (replace) masked.add(rule);
}
export function errorEnvelope(rule: object, envelope: object): Slot | undefined {
  return entries.get(rule)?.get(envelope);
}
export function hasErrorEnvelopes(rule: object): boolean {
  return masked.has(rule);
}
