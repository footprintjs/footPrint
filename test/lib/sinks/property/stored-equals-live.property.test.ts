/**
 * The stored record IS the live record (design §3.5) — for any chart of plain writes, what the sink stored reads
 * back, through `readStoredRecord`, as the snapshot the run serves: the same bundles, the same base, the same fold.
 *
 * WHY: a crash-safe record is only worth keeping if reading it gives the answer the live run would have given.
 * The sink is handed the log's own frozen bundles as they land, so there is no second encoding to drift — this
 * pins that nothing on the way (the wiring, the redaction pass over the base, a subflow's address) changes them.
 *
 * Test types: Property (fast-check: random stage counts, random JSON writes and deletes, an optional subflow mount,
 * both commit encodings) — the stored root and mount logs equal the live ones, and fold to the live state.
 */
import fc from 'fast-check';
import { readStoredRecord, stateAt } from 'foottrace';
import { memorySink } from 'foottrace/write';
import { describe, expect, it } from 'vitest';

import { flowChart, FlowChartExecutor } from '../../../../src/index.js';

type S = Record<string, any>;
type Op = { key: string; value: unknown } | { key: string; remove: true };

const keys = fc.constantFrom('a', 'b', 'c', 'list');
const op: fc.Arbitrary<Op> = fc.oneof(
  fc.record({ key: keys, value: fc.jsonValue({ maxDepth: 2 }) }),
  fc.record({ key: keys, remove: fc.constant(true as const) }),
);
const stages = fc.array(fc.array(op, { maxLength: 4 }), { minLength: 1, maxLength: 5 });

function apply(s: S, ops: readonly Op[]) {
  for (const o of ops) {
    if (Object.hasOwn(o, 'remove')) delete s[o.key];
    else s[o.key] = structuredClone((o as { value: unknown }).value);
  }
}

function build(plan: readonly (readonly Op[])[], mount: readonly Op[] | undefined) {
  let builder = flowChart<S>('S0', (s) => apply(s, plan[0]), 's0');
  for (let i = 1; i < plan.length; i++) builder = builder.addFunction(`S${i}`, (s) => apply(s, plan[i]), `s${i}`);
  if (mount) {
    builder = builder.addSubFlowChartNext('sf', flowChart<S>('In', (s) => apply(s, mount), 'in').build(), 'Sub', {
      inputMapper: (p: S) => ({ from: p.a ?? null }),
      outputMapper: (o: S) => ({ fromSub: o.b ?? null }),
    });
  }
  return builder.build();
}

const plain = (v: unknown) => JSON.parse(JSON.stringify(v));

describe('the stored record equals the live record', () => {
  it('root and mount logs, base and fold — for random charts, both encodings', async () => {
    await fc.assert(
      fc.asyncProperty(
        stages,
        fc.option(fc.array(op, { maxLength: 3 }), { nil: undefined }),
        fc.constantFrom('full', 'delta' as const),
        async (plan, mount, commitValues) => {
          const sink = memorySink();
          const executor = new FlowChartExecutor(build(plan, mount), { sink, commitValues });
          await executor.run();
          const snapshot = executor.getSnapshot();
          const record = readStoredRecord(sink.entries);

          const root = record.root(snapshot.runId)!;
          expect(root.complete).toBe(true);
          expect(plain(root.commitLog)).toEqual(plain(snapshot.commitLog));
          expect(plain(root.initialState)).toEqual(plain(snapshot.initialState));
          expect(stateAt(root.source(), root.commitLog.length - 1).state).toEqual(
            stateAt(snapshot, snapshot.commitLog.length - 1).state,
          );

          for (const [key, value] of Object.entries(snapshot.subflowResults ?? {})) {
            if (!key.includes('#')) continue;
            const live = (value as any).treeContext;
            const stored = record.log(live.logAddress)!;
            expect(stored.complete).toBe(true);
            expect(plain(stored.commitLog)).toEqual(plain(live.history));
          }
        },
      ),
      { numRuns: 40 },
    );
  });
});
