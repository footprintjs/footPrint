import { equal, refuse } from '../readLawWitness.js';
import type { ValueFact } from '../readWitness.js';

const member = (value: ValueFact, name: string): ValueFact | undefined => {
  const row = value.entries?.find((entry) => Array.isArray(entry) && entry[0] === name) as unknown[] | undefined;
  return row?.[2] as ValueFact | undefined;
};
function withMember(value: ValueFact, name: string, next: ValueFact): ValueFact {
  const entries = (value.entries ?? []).map((row) => (Array.isArray(row) ? [...row] : refuse('unreadable edit fact')));
  const i = entries.findIndex((row) => row[0] === name);
  if (i < 0) entries.push([name, true, next]);
  else entries[i][2] = next;
  return { ...value, entries };
}

/** The existing fixture edit's four closed data branches; no memory, staging, encoding or replay law. */
export function declaredWriteBackEdit(before: ValueFact, n: number, after: ValueFact): void {
  const number: ValueFact = { kind: 'number', value: String(n) };
  let expected: ValueFact;
  if (before.kind === 'array') {
    const first = member(before, '0');
    if (first?.kind === 'object') expected = withMember(before, '0', withMember(first, 'n', number));
    else {
      if (!Number.isSafeInteger(before.value) || (before.value as number) < 0) return refuse('unknown fixture array');
      expected = { ...withMember(before, String(before.value), number), value: (before.value as number) + 1 };
    }
  } else if (before.kind === 'object') {
    const inner = member(before, 'x');
    expected =
      inner?.kind === 'object'
        ? withMember(before, 'x', withMember(inner, 'n', number))
        : withMember(before, 'n', number);
  } else if (before.kind === 'date')
    expected = before; // The real helper does not edit Date, but its caller writes objects.
  else return refuse('first-commit branch requires the actual returned object');
  if (!equal(expected, after)) return refuse('edit differs from declared editForWriteBack branch');
}
