import { refuse } from '../../../readLawWitness.js';
import type { ValueFact } from '../../../readWitness.js';
import type { Row, Write } from './types.js';

export const KEYS = ['a', 'b', 'list', 'obj', 'hist'];
export const atom = (value: ValueFact) => ['undefined', 'null', 'string', 'number', 'boolean'].includes(value.kind);
export const objectKind = (value: ValueFact) => ['object', 'array', 'date'].includes(value.kind);
export const objectId = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) > 0;
export const undef = (): ValueFact => ({ kind: 'undefined' });

export function rows(value: ValueFact): readonly Row[] {
  if (!Array.isArray(value.entries) || value.entries.length > 10_000) return refuse('unsupported chart value entries');
  const seen = new Set<string>();
  return value.entries.map((item) => {
    if (
      !Array.isArray(item) ||
      item.length !== 3 ||
      typeof item[0] !== 'string' ||
      typeof item[1] !== 'boolean' ||
      !item[2] ||
      typeof item[2] !== 'object' ||
      seen.has(item[0])
    )
      return refuse('unsupported chart value entry');
    seen.add(item[0]);
    return item as unknown as Row;
  });
}

export function supported(value: ValueFact, budget = { nodes: 0 }, depth = 0): void {
  if (++budget.nodes > 10_000 || depth > 64) return refuse('chart fact bound exceeded');
  if (value.kind === 'object' || value.kind === 'array') {
    for (const [, , child] of rows(value)) supported(child, budget, depth + 1);
  } else if (value.kind === 'date') {
    if (typeof value.value !== 'number' || !Number.isFinite(value.value)) return refuse('unsupported Date fact');
  } else if (value.kind === 'number') {
    if (typeof value.value !== 'string' || !Number.isFinite(Number(value.value)))
      return refuse('unsupported number fact');
  } else if (value.kind === 'string' || value.kind === 'boolean') {
    if (typeof value.value !== value.kind) return refuse('unsupported primitive fact');
  } else if (value.kind !== 'undefined' && value.kind !== 'null') return refuse('unsupported/ref chart fact');
}

/** Pure literal projection of unchanged materialise; never executes it on a native value. */
export function literal(value: unknown, budget = { nodes: 0 }, depth = 0): ValueFact {
  if (++budget.nodes > 10_000 || depth > 64) return refuse('chart literal projection bound');
  if (value === '__DATE__') return { kind: 'date', value: 1_700_000_000_000 };
  if (value === undefined) return undef();
  if (value === null) return { kind: 'null' };
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return refuse('nonfinite chart literal');
    return { kind: 'number', value: Object.is(value, -0) ? '-0' : String(value) };
  }
  if (typeof value === 'string' || typeof value === 'boolean') return { kind: typeof value, value };
  if (typeof value !== 'object' || ![Object.prototype, null, Array.prototype].includes(Object.getPrototypeOf(value)))
    return refuse('unsupported chart literal');
  const array = Array.isArray(value);
  return {
    kind: array ? 'array' : 'object',
    ...(array ? { value: value.length } : {}),
    entries: Object.entries(value).map(([key, child]) => [key, true, literal(child, budget, depth + 1)]),
  };
}

export function array(values: readonly ValueFact[]): ValueFact {
  return { kind: 'array', value: values.length, entries: values.map((value, i) => [String(i), true, value]) };
}
export const record = (key: string, value: ValueFact): ValueFact => ({ kind: 'object', entries: [[key, true, value]] });
export function literalWrite(write: Write, at: readonly string[], value: ValueFact): Write {
  return objectKind(value) ? { ...write, literal: { at, value } } : write;
}
export function denseValues(value: ValueFact): ValueFact[] {
  if (value.kind !== 'array' || !Number.isSafeInteger(value.value) || (value.value as number) < 0)
    return refuse('unsupported array branch');
  const items = rows(value);
  if (
    items.length !== value.value ||
    items.some(
      ([key, enumerable, child], i) => key !== String(i) || !enumerable || (!atom(child) && !objectKind(child)),
    )
  )
    return refuse('sparse/unsupported array branch');
  return items.map(([, , child]) => child);
}

/** The closed snapshot's object paths, not a native lookup, materialisation, or state replay. */
export function objectPaths(
  value: ValueFact,
  path: readonly string[] = [],
  budget = { nodes: 0 },
): readonly string[][] {
  if (++budget.nodes > 10_000 || path.length > 128) return refuse('literal identity shape bound exceeded');
  if (!objectKind(value)) return [];
  const out = [[...path]];
  if (value.kind === 'object' || value.kind === 'array')
    for (const [key, , child] of rows(value)) out.push(...objectPaths(child, [...path, key], budget));
  return out;
}
