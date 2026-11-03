/** #142 migration evidence compares two real, unmodified normalized outputs. */
import { expect, it } from 'vitest';

import oldDelta from './fixtures/component-2488.delta.json';
import oldFull from './fixtures/component-2488.full.json';
import evidence from './fixtures/component-2488-f2-migration.json';
import delta from './fixtures/component-absent-2488-f2.delta.json';
import full from './fixtures/component-absent-2488-f2.full.json';

type Difference = { path: string; before: unknown; after: unknown };
function differences(before: unknown, after: unknown, path = ''): Difference[] {
  if (Object.is(before, after)) return [];
  if (
    before === null ||
    after === null ||
    typeof before !== 'object' ||
    typeof after !== 'object' ||
    Array.isArray(before) !== Array.isArray(after)
  )
    return [{ path, before, after }];
  const a = before as Record<string, unknown>;
  const b = after as Record<string, unknown>;
  return [...new Set([...Object.keys(a), ...Object.keys(b)])].sort().flatMap((key) => {
    const at = Array.isArray(before) ? `${path}[${key}]` : `${path}.${key}`;
    if (Object.hasOwn(a, key) !== Object.hasOwn(b, key)) return [{ path: at, before: a[key], after: b[key] }];
    return differences(a[key], b[key], at);
  });
}
const prefix = '.paused.executionTree.next.next';
const paths = [
  `${prefix}.attemptSummary.last.reason`,
  `${prefix}.attempts[0].decision.rules[0].label`,
  `${prefix}.attempts[1].decision.rules[0].label`,
  `${prefix}.attempts[2].decision.rules[0].label`,
  `${prefix}.attempts[2].reason`,
  '.paused.narrative[11].text',
].sort();
it.each(['full', 'delta'] as const)('#142 changes exactly six admitted wording fields in real %s outputs', (mode) => {
  const changes = differences(mode === 'full' ? oldFull : oldDelta, mode === 'full' ? full : delta);
  expect(changes.map((change) => change.path)).toEqual(paths);
  expect(changes).toEqual(evidence.differences[mode]);
  for (const change of changes) {
    if (change.path === '.paused.narrative[11].text') {
      expect(change.before).toBe('Attempt 3 of 3 at Flaky succeeded in «ms».');
      expect(change.after).toBe('Attempt 3 of 3 at Flaky answered in «ms».');
    } else {
      expect(change.before).toBe('succeeded');
      expect(change.after).toBe('answered');
    }
  }
});
it('keeps an unrelated record change visible in the real-output diff', () => {
  const changed = structuredClone(full) as typeof full & { unexpected: boolean };
  changed.unexpected = true;
  expect(differences(oldFull, changed).map((change) => change.path)).toEqual([...paths, '.unexpected'].sort());
});
