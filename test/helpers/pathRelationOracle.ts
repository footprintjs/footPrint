import { pathSegments } from 'foottrace/paths';

/** Independent segment-array oracle for the engine-log differentials. No record internals imported. */
export function relation(row: string, key: string): 'exact' | 'inside' | 'around' | undefined {
  const a = pathSegments(row);
  const b = pathSegments(key);
  if (!a.slice(0, Math.min(a.length, b.length)).every((segment, i) => segment === b[i])) return undefined;
  return a.length === b.length ? 'exact' : a.length > b.length ? 'inside' : 'around';
}
