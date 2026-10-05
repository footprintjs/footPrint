/**
 * Resolve a nullable narrative formatter result without treating exclusion as
 * fallback. The caller invokes the formatter so its receiver and context stay
 * at the event boundary; only an unhandled result evaluates the default.
 */
export function resolveText(custom: string | null | undefined, fallback: () => string): string | null {
  return custom === undefined ? fallback() : custom;
}
