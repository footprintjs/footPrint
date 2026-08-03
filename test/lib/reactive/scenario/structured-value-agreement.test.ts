/**
 * Regression: a STRUCTURED value read back through the TypedScope property
 * proxy must say the same thing as `$getValue` — and a copy of it must COMMIT
 * the same thing.
 *
 * Reported by a consumer building a DAG feature: a subflow's `outputMapper`
 * merged `{ a: {...}, b: {...} }` into a parent key, and the parent stage read
 * it back as `{}`. Enumeration was never the problem (Object.keys/spread/for-in
 * were always right) — SERIALIZATION was: the nested proxy's `toJSON` stripped
 * every object-valued member as a blanket cycle guard.
 *
 * That leaked into the write path too, because assigning a proxy value round-
 * trips through JSON: `scope.copy = scope.results` committed `{}` into state.
 * So these tests assert the COMMITTED BYTES, in the commit log, where the
 * corruption actually landed.
 */
import { describe, expect, it } from 'vitest';

import { flowChart, FlowChartBuilder } from '../../../../src/lib/builder';
import { FlowChartExecutor } from '../../../../src/lib/runner';

interface ParentState {
  seed: number;
  results: Record<string, { score: number; notes: string[] }>;
  copy: Record<string, unknown>;
  seenViaProperty: string;
  seenViaGetValue: string;
  keysViaProperty: string[];
}

/** Subflow that produces two object-valued results. */
function buildScoringSubflow() {
  return new FlowChartBuilder<any, any>()
    .start(
      'Score',
      async (scope: any) => {
        scope.alpha = { score: 1, notes: ['first'] };
        scope.beta = { score: 2, notes: ['second'] };
      },
      'score',
    )
    .build();
}

describe('structured values: property reads agree with $getValue (subflow outputMapper)', () => {
  it('a structured outputMapper result reads back whole through every path', async () => {
    const chart = flowChart<ParentState>(
      'Seed',
      async (scope: any) => {
        scope.seed = 1;
      },
      'seed',
    )
      .addSubFlowChartNext('scoring', buildScoringSubflow(), 'Scoring', {
        inputMapper: () => ({}),
        outputMapper: (out: any) => ({ results: { alpha: out.alpha, beta: out.beta } }),
      })
      .addFunction(
        'ReadBack',
        async (scope: any) => {
          scope.seenViaProperty = JSON.stringify(scope.results);
          scope.seenViaGetValue = JSON.stringify(scope.$getValue('results'));
          scope.keysViaProperty = Object.keys(scope.results);
        },
        'read-back',
      )
      .build();

    const executor = new FlowChartExecutor(chart);
    await executor.run();
    const state = executor.getSnapshot().sharedState as any;

    const expected = JSON.stringify({
      alpha: { score: 1, notes: ['first'] },
      beta: { score: 2, notes: ['second'] },
    });

    expect(state.seenViaProperty).toBe(expected); // was '{}' before the fix
    expect(state.seenViaGetValue).toBe(expected);
    expect(state.keysViaProperty).toEqual(['alpha', 'beta']);
  });

  it('copying that value into another key COMMITS the full structure', async () => {
    const chart = flowChart<ParentState>(
      'Seed',
      async (scope: any) => {
        scope.seed = 1;
      },
      'seed',
    )
      .addSubFlowChartNext('scoring', buildScoringSubflow(), 'Scoring', {
        inputMapper: () => ({}),
        outputMapper: (out: any) => ({ results: { alpha: out.alpha, beta: out.beta } }),
      })
      .addFunction(
        'Copy',
        async (scope: any) => {
          scope.copy = scope.results; // proxy -> proxy copy
        },
        'copy',
      )
      .build();

    const executor = new FlowChartExecutor(chart);
    await executor.run();
    const snapshot = executor.getSnapshot();

    const whole = {
      alpha: { score: 1, notes: ['first'] },
      beta: { score: 2, notes: ['second'] },
    };

    // Live state.
    expect((snapshot.sharedState as any).copy).toEqual(whole);

    // The committed bytes — where the corruption landed. Before the fix this
    // bundle carried `copy: {}`.
    const copyBundle = snapshot.commitLog.find((b) => b.stageId === 'copy');
    expect(copyBundle).toBeDefined();
    const committed = { ...copyBundle!.overwrite, ...copyBundle!.updates } as Record<string, unknown>;
    expect(committed.copy).toEqual(whole);
  });

  it('deep writes into a structured result still commit as merges', async () => {
    const chart = flowChart<ParentState>(
      'Seed',
      async (scope: any) => {
        scope.results = { alpha: { score: 1, notes: ['first'] } };
      },
      'seed',
    )
      .addFunction(
        'Bump',
        async (scope: any) => {
          scope.results.alpha.score = 99;
        },
        'bump',
      )
      .build();

    const executor = new FlowChartExecutor(chart);
    await executor.run();
    const snapshot = executor.getSnapshot();

    expect((snapshot.sharedState as any).results).toEqual({ alpha: { score: 99, notes: ['first'] } });
    const bump = snapshot.commitLog.find((b) => b.stageId === 'bump');
    expect(bump!.updates).toEqual({ results: { alpha: { score: 99 } } });
  });

  it('serializing the scope adds no phantom toJSON to the recorded read set', async () => {
    // The reads channel and the writeProvenance prefixes must carry keys a
    // STAGE asked for. JSON.stringify asks every value for `toJSON` — that
    // question is the runtime's, and causalChain/sliceForKey would otherwise
    // carry a key no chart names.
    const readKeysSeen: string[] = [];

    const chart = flowChart<any>(
      'Seed',
      async (scope: any) => {
        scope.amount = 100;
        scope.customer = { name: 'Alice' };
      },
      'seed',
    )
      .addFunction(
        'Serialize',
        async (scope: any) => {
          scope.serialized = JSON.stringify(scope);
          scope.total = (scope.amount as number) * 2;
        },
        'serialize',
      )
      .build();

    const executor = new FlowChartExecutor(chart, { writeProvenance: 'reads-prefix' });
    executor.attachScopeRecorder({
      id: 'read-spy',
      onRead: (entry: any) => {
        readKeysSeen.push(entry.key);
      },
    } as any);
    await executor.run();

    expect(readKeysSeen).not.toContain('toJSON');
    // ...and the reads that DID happen are still there — less noise, not less truth.
    expect(readKeysSeen).toContain('amount');

    const serialize = executor.getSnapshot().commitLog.find((b) => b.stageId === 'serialize');
    const provenance = serialize!.trace.flatMap((t) => t.readKeys ?? []);
    expect(provenance.length).toBeGreaterThan(0);
    expect(provenance).not.toContain('toJSON');
    expect(provenance).toContain('amount');
  });

  it('arrays of objects merged by an outputMapper read back whole', async () => {
    const rowsSubflow = new FlowChartBuilder<any, any>()
      .start(
        'MakeRows',
        async (scope: any) => {
          scope.rows = [
            { id: 1, meta: { ok: true } },
            { id: 2, meta: { ok: false } },
          ];
        },
        'make-rows',
      )
      .build();

    const chart = flowChart<any>(
      'Seed',
      async (scope: any) => {
        scope.seed = 1;
      },
      'seed',
    )
      .addSubFlowChartNext('rows', rowsSubflow, 'Rows', {
        inputMapper: () => ({}),
        outputMapper: (out: any) => ({ table: { rows: out.rows } }),
      })
      .addFunction(
        'ReadRows',
        async (scope: any) => {
          scope.serialized = JSON.stringify(scope.table);
          scope.ids = scope.table.rows.map((r: any) => r.id);
          scope.okFlags = scope.table.rows.map((r: any) => r.meta.ok);
        },
        'read-rows',
      )
      .build();

    const executor = new FlowChartExecutor(chart);
    await executor.run();
    const state = executor.getSnapshot().sharedState as any;

    expect(state.serialized).toBe(
      JSON.stringify({
        rows: [
          { id: 1, meta: { ok: true } },
          { id: 2, meta: { ok: false } },
        ],
      }),
    );
    expect(state.ids).toEqual([1, 2]);
    expect(state.okFlags).toEqual([true, false]);
  });
});
