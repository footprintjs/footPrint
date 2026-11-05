import { refuse } from '../readLawWitness.js';
import type { ValueFact } from '../readWitness.js';
export const fact = (value: string | number | boolean | undefined | readonly string[]): ValueFact =>
  Array.isArray(value)
    ? {
        kind: 'array',
        value: value.length,
        entries: value.map((part, i) => [String(i), true, { kind: 'string', value: part }]),
      }
    : value === undefined
    ? { kind: 'undefined' }
    : { kind: typeof value, value: typeof value === 'number' ? String(value) : value };
export const args = (...values: Parameters<typeof fact>[0][]) => values.map(fact);
export function stringPath(value: ValueFact): readonly string[] {
  if (
    value.kind !== 'array' ||
    !Number.isSafeInteger(value.value) ||
    (value.value as number) < 0 ||
    !Array.isArray(value.entries) ||
    value.entries.length !== value.value
  )
    return refuse('not a closed actual path argument');
  return value.entries.map((row, index) => {
    if (
      !Array.isArray(row) ||
      row.length !== 3 ||
      row[0] !== String(index) ||
      row[1] !== true ||
      !row[2] ||
      row[2].kind !== 'string' ||
      typeof row[2].value !== 'string'
    )
      return refuse('non-string actual path argument');
    return row[2].value as string;
  });
}
export function key(value: ValueFact): string {
  return value.kind === 'string' && typeof value.value === 'string'
    ? value.value
    : refuse('non-string actual key argument');
}
