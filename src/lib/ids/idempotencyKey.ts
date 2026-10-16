/**
 * ids/idempotencyKey.ts — the ONE format rule for an idempotency key (design §3.3, packet P3). A leaf: the attempt
 * law (`attempt/effect.ts · admitIdempotencyKey`, a key a stage's rule or a `$call` gives) and the checkpoint decoder
 * (`pause/record.ts`, a key a paused execution carries to its resume) both ask it, so a key a stored checkpoint
 * smuggles in is held to the same rule as one the code made.
 *
 * 1–255 printable ASCII characters (`\x21`–`\x7e`), no space: a key travels in a request header
 * (`Idempotency-Key`), so a CR/LF could forge one, and 255 is Stripe's limit, inside every header limit. The
 * problem names the rule, never the value.
 */

/** The longest idempotency key. */
export const MAX_IDEMPOTENCY_KEY_LENGTH = 255;

const KEY_CHARACTERS = /^[\x21-\x7e]+$/;

/** Why `value` is not an idempotency key, or `undefined` when it is one. */
export function idempotencyKeyProblem(value: unknown): string | undefined {
  if (typeof value !== 'string' || value.length === 0 || value.length > MAX_IDEMPOTENCY_KEY_LENGTH) {
    return `must be a string of 1–${MAX_IDEMPOTENCY_KEY_LENGTH} characters`;
  }
  if (!KEY_CHARACTERS.test(value)) {
    return 'must be printable ASCII with no space or control character — it travels in a request header';
  }
  return undefined;
}
