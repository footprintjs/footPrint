/** Reachable unfrozen objects; typed arrays/DataViews are deliberately not sealable. */
export function unfrozen(v: unknown, path = '$', out: string[] = [], seen = new Set<object>()): string[] {
  if (v === null || typeof v !== 'object' || seen.has(v) || ArrayBuffer.isView(v)) return out;
  seen.add(v);
  if (!Object.isFrozen(v)) out.push(path);
  for (const k of Object.getOwnPropertyNames(v)) unfrozen((v as Record<string, unknown>)[k], `${path}.${k}`, out, seen);
  return out;
}
