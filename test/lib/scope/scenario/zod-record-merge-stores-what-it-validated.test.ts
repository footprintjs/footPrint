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
 * Now the one value is both: `merge` validates `{ ...current, ...patch }` and stores that collection. A record
 * that does not exist yet is written whole; after that only the entries the patch names are written, each as a
 * whole entry, so the commit log grows with the patch and not with the collection. One field of an entry is
 * changed through `record.at(key)`.
 *
 * Test types: scenario (real executor), property.
 */
import * as fc from 'fast-check';
import { findLastWriter } from 'foottrace';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { flowChart, FlowChartExecutor } from '../../../../src/index.js';
import { defineScopeFromZod } from '../../../../src/zod.js';

/** The record's path separator (U+001F). */
const SEP = String.fromCodePoint(0x1f);

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

  it('the record holds one set row per entry the patch names, and none for the others', async () => {
    const { log } = await run('deny', (scope) => scope.tags.merge({ b: ['q'] }));
    const bundle = log.find((entry) => entry.stageId === 'merge')!;
    expect(bundle.trace.map((row) => `${row.verb} ${row.path}`)).toEqual([`set tags${SEP}b`]);
    expect(JSON.stringify(bundle)).not.toContain('"x"');
  });

  it.each(['full', 'delta'] as const)(
    'commitValues %s: a one-entry merge commits that entry and not the others',
    async (mode) => {
      const chart = flowChart<any>(
        'Seed',
        (scope) => {
          scope.people.set({ p: { name: 'Ann', age: 3 }, r: { name: 'Rae', age: 5 } });
        },
        'seed',
      )
        .addFunction('Merge', (scope) => scope.people.merge({ q: { name: 'Bo', age: 9 } }), 'merge')
        .build();
      const executor = new FlowChartExecutor(chart, {
        scopeFactory: defineScopeFromZod(schema, { strict: 'deny' }),
      } as never);
      executor.setCommitValues(mode);
      await executor.run();
      const snapshot = executor.getSnapshot();
      const bundle = snapshot.commitLog.find((entry) => entry.stageId === 'merge')!;
      expect(bundle.trace.map((row) => `${row.verb} ${row.path}`)).toEqual([`set people${SEP}q`]);
      const bytes = JSON.stringify(bundle);
      expect(bytes).toContain('Bo');
      expect(bytes).not.toContain('Ann');
      expect(bytes).not.toContain('Rae');
      expect((snapshot.sharedState as any).people).toEqual({
        p: { name: 'Ann', age: 3 },
        r: { name: 'Rae', age: 5 },
        q: { name: 'Bo', age: 9 },
      });
    },
  );

  it('an entry the patch replaces is replaced whole: no merge inside it, no list union', async () => {
    const { state, log } = await run('deny', (scope) => {
      scope.people.merge({ p: { name: 'Pat', age: 4 } });
      scope.tags.merge({ a: ['z'] });
    });
    expect(state.people).toEqual({ p: { name: 'Pat', age: 4 } });
    expect(state.tags).toEqual({ a: ['z'] });
    const rows = log.find((entry) => entry.stageId === 'merge')!.trace.map((row) => `${row.verb} ${row.path}`);
    expect(rows.sort()).toEqual([`set people${SEP}p`, `set tags${SEP}a`]);
  });

  it('the stage reads its own merge back as the whole validated collection', async () => {
    let seen: unknown;
    await run('deny', (scope) => {
      scope.people.merge({ q: { name: 'Bo', age: 9 } });
      seen = scope.people.get();
    });
    expect(seen).toEqual({ p: { name: 'Ann', age: 3 }, q: { name: 'Bo', age: 9 } });
  });

  it("inside a fork child, the child's namespace holds only the patched entry", async () => {
    const chart = flowChart<any>(
      'Seed',
      (scope) => {
        scope.people.set({ p: { name: 'Ann', age: 3 } });
      },
      'seed',
    )
      .addFunction('Pre', () => undefined, 'pre')
      .addListOfFunction([
        { id: 'a', name: 'A', fn: (scope: any) => scope.people.merge({ a: { name: 'Al', age: 1 } }) },
        { id: 'b', name: 'B', fn: (scope: any) => scope.people.merge({ b: { name: 'Bea', age: 2 } }) },
      ])
      .build();
    const executor = new FlowChartExecutor(chart, {
      scopeFactory: defineScopeFromZod(schema, { strict: 'deny' }),
    } as never);
    await executor.run();
    const { sharedState, commitLog } = executor.getSnapshot() as any;
    expect(sharedState.runs.a.people).toEqual({ a: { name: 'Al', age: 1 } });
    expect(sharedState.runs.b.people).toEqual({ b: { name: 'Bea', age: 2 } });
    for (const id of ['a', 'b']) {
      const bundle = commitLog.find((entry: any) => entry.stageId === id && entry.trace.length > 0);
      expect(bundle.trace.map((row: any) => `${row.verb} ${row.path}`)).toEqual([
        ['set', ['runs', id, 'people', id].join(SEP)].join(' '),
      ]);
      expect(JSON.stringify(bundle)).not.toContain('Ann');
    }
  });

  it('a record nested in a record: a merge writes the entries it names under the inner record', async () => {
    const nested = z.object({ teams: z.record(z.string(), z.record(z.string(), z.number())) });
    const chart = flowChart<any>(
      'Seed',
      (scope) => {
        scope.teams.set({ red: { ann: 1 } });
      },
      'seed',
    )
      .addFunction('Merge', (scope) => scope.teams.at('red').merge({ bo: 2 }), 'merge')
      .build();
    const executor = new FlowChartExecutor(chart, {
      scopeFactory: defineScopeFromZod(nested, { strict: 'deny' }),
    } as never);
    await executor.run();
    const { sharedState, commitLog } = executor.getSnapshot() as any;
    expect(sharedState.teams).toEqual({ red: { ann: 1, bo: 2 } });
    const bundle = commitLog.find((entry: any) => entry.stageId === 'merge');
    expect(bundle.trace.map((row: any) => `${row.verb} ${row.path}`)).toEqual([
      ['set', ['teams', 'red', 'bo'].join(SEP)].join(' '),
    ]);
  });

  it('redaction by keys and by fields still hides what the merge wrote and what it did not', async () => {
    const secrets = z.object({ secret: z.record(z.string(), z.object({ token: z.string(), ok: z.boolean() })) });
    for (const policy of [{ keys: ['secret'] }, { fields: { secret: ['a.token', 'b.token'] } }]) {
      const chart = flowChart<any>(
        'Seed',
        (scope) => {
          scope.secret.set({ a: { token: 'TOK-A', ok: true } });
        },
        'seed',
      )
        .addFunction('M', (scope) => scope.secret.merge({ b: { token: 'TOK-B', ok: false } }), 'm')
        .build();
      const events: unknown[] = [];
      const executor = new FlowChartExecutor(chart, {
        scopeFactory: defineScopeFromZod(secrets, { strict: 'deny' }),
      } as never);
      executor.setRedactionPolicy(policy as never);
      executor.attachScopeRecorder({
        id: 'w',
        onWrite: (event: unknown) => events.push(event),
        onCommit: (event: unknown) => events.push(event),
      } as never);
      await executor.run();
      const { sharedState, commitLog } = executor.getSnapshot() as any;
      const served = JSON.stringify({ log: commitLog, events });
      expect(served).not.toContain('TOK-A');
      expect(served).not.toContain('TOK-B');
      expect(sharedState.secret.b.token).toBe('TOK-B');
    }
  });

  it('findLastWriter names the merging stage for the entry it wrote, and the seed for the others', async () => {
    const users = z.object({ users: z.record(z.string(), z.object({ name: z.string() })) });
    const chart = flowChart<any>(
      'Seed',
      (scope) => {
        scope.users.set({ ann: { name: 'Ann' } });
      },
      'seed',
    )
      .addFunction('AddBo', (scope) => scope.users.merge({ bo: { name: 'Bo' } }), 'add-bo')
      .build();
    const executor = new FlowChartExecutor(chart, {
      scopeFactory: defineScopeFromZod(users, { strict: 'deny' }),
    } as never);
    await executor.run();
    const log = executor.getSnapshot().commitLog;
    expect(findLastWriter(log, ['users', 'bo'].join(SEP))?.stageId).toBe('add-bo');
    expect(findLastWriter(log, ['users', 'ann'].join(SEP))?.stageId).toBe('seed');
    expect(findLastWriter(log, ['users', 'ann', 'name'].join(SEP))?.stageId).toBe('seed');
    expect(findLastWriter(log, 'users')?.stageId).toBe('add-bo');
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
