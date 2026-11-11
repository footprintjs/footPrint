/**
 * A Zod record's `merge` stores the value it validated.
 *
 * `merge(patch)` validated `{ ...current, ...patch }` (entries replaced whole) and then stored the patch with
 * the engine's merge verb, which merges INSIDE an entry and unions arrays. Two different values:
 *
 * - `tags.merge({ a: ['z'] })` on `{ a: ['x', 'y'] }` was checked as `{ a: ['z'] }` and stored as
 *   `{ a: ['x', 'y', 'z'] }`, three items under a schema that allows two;
 * - `people.merge({ p: { age: 4 } })` was refused for a missing name, although what would have been stored
 *   (`{ name: 'Ann', age: 4 }`) was valid.
 *
 * Now the one value is both: `merge` adds or replaces whole entries, and stores exactly that collection.
 * One field of an entry is changed through `record.at(key)`.
 *
 * Test types: scenario (real executor), property.
 */
import * as fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { flowChart, FlowChartExecutor } from '../../../../src/index.js';
import { defineScopeFromZod } from '../../../../src/zod.js';

const schema = z.object({
  tags: z.record(z.string(), z.array(z.string()).max(2)),
  people: z.record(z.string(), z.object({ name: z.string(), age: z.number() })),
});

async function run(strict: 'warn' | 'deny', merge: (scope: any) => void) {
  const chart = flowChart<any>(
    'Seed',
    (scope) => {
      scope.tags.set({ a: ['x', 'y'] });
      scope.people.set({ p: { name: 'Ann', age: 3 } });
    },
    'seed',
  )
    .addFunction('Merge', merge, 'merge')
    .build();
  const executor = new FlowChartExecutor(chart, { scopeFactory: defineScopeFromZod(schema, { strict }) } as never);
  let rejected: unknown;
  try {
    await executor.run();
  } catch (error) {
    rejected = error;
  }
  const snapshot = executor.getSnapshot();
  return { rejected, state: snapshot.sharedState as any, log: snapshot.commitLog };
}

describe('a Zod record merge stores the value it validated', () => {
  it('an entry holding a list is replaced, not unioned: the stored list obeys the schema', async () => {
    const { rejected, state } = await run('deny', (scope) => scope.tags.merge({ a: ['z'] }));
    expect(rejected).toBeUndefined();
    expect(state.tags).toEqual({ a: ['z'] });
    expect(schema.shape.tags.safeParse(state.tags).success).toBe(true);
  });

  it('a new entry is added and the others are kept', async () => {
    const { state } = await run('deny', (scope) => scope.people.merge({ q: { name: 'Bo', age: 9 } }));
    expect(state.people).toEqual({ p: { name: 'Ann', age: 3 }, q: { name: 'Bo', age: 9 } });
  });

  it('half an entry is refused, and nothing is stored (deny throws)', async () => {
    const { rejected, state } = await run('deny', (scope) => scope.people.merge({ p: { age: 4 } }));
    expect(rejected).toBeDefined();
    expect(state.people).toEqual({ p: { name: 'Ann', age: 3 } });
  });

  it('half an entry is refused, and nothing is stored (warn drops the write)', async () => {
    const { rejected, state } = await run('warn', (scope) => scope.people.merge({ p: { age: 4 } }));
    expect(rejected).toBeUndefined();
    expect(state.people).toEqual({ p: { name: 'Ann', age: 3 } });
  });

  it('one field of an entry is changed through at(key)', async () => {
    const { state } = await run('deny', (scope) => scope.people.at('p').age.set(4));
    expect(state.people).toEqual({ p: { name: 'Ann', age: 4 } });
  });

  it('the record holds the write as one set of the whole collection', async () => {
    const { log } = await run('deny', (scope) => scope.tags.merge({ b: ['q'] }));
    const bundle = log.find((entry) => entry.stageId === 'merge')!;
    expect(bundle.trace.map((row) => `${row.verb} ${row.path}`)).toEqual(['set tags']);
  });

  it('property: after any merge the stored record is the validated one, or the merge was refused whole', async () => {
    const entry = fc.oneof(
      fc.array(fc.string({ maxLength: 2 }), { maxLength: 4 }),
      fc.constant('not a list'),
      fc.constant(null),
    );
    const patch = fc.dictionary(fc.constantFrom('a', 'b', 'c'), entry, { maxKeys: 3 });
    await fc.assert(
      fc.asyncProperty(patch, async (given) => {
        const before = { a: ['x', 'y'] };
        const { rejected, state } = await run('deny', (scope) => scope.tags.merge(given));
        const proposed = { ...before, ...given };
        if (schema.shape.tags.safeParse(proposed).success) {
          expect(rejected).toBeUndefined();
          expect(state.tags).toEqual(proposed);
        } else {
          expect(rejected).toBeDefined();
          expect(state.tags).toEqual(before);
        }
        // Whatever happened, what is stored satisfies the schema.
        expect(schema.shape.tags.safeParse(state.tags).success).toBe(true);
      }),
      { numRuns: 60 },
    );
  });
});
