/**
 * Cyclic values on the commit path (9.18.1).
 *
 * The engine's own law on state values is "must survive `structuredClone`",
 * and `structuredClone` PRESERVES cycles — so a value that references itself
 * (a tool schema whose object pointed at itself, in the field report that
 * found this) is a legal value, and every walker on the commit path must
 * terminate on it. Two did not: `deepEqual` (the net-change filter every
 * commit runs) and `deepSmartMerge` (the `merge` verb, staged and replayed).
 *
 * Unit halves pin the guards; the engine half pushes a cyclic value through a
 * real subflow outputMapper and reads it back through the commit log, the
 * fold and the cursor.
 */
import { describe, expect, it } from 'vitest';

import { flowChart } from '../../../src/lib/builder/FlowChartBuilder.js';
import { ArrayMergeMode } from '../../../src/lib/engine/types.js';
import type { CommitBundle } from '../../../src/lib/memory/types.js';
import { deepEqual, deepSmartMerge } from '../../../src/lib/memory/utils.js';
import { FlowChartExecutor } from '../../../src/lib/runner/FlowChartExecutor.js';
import { commitValueAt, stateAt, timeTravel } from '../../../src/trace.js';

interface Schema {
  name: string;
  version: number;
  params: Record<string, unknown>;
  self?: Schema;
}

/** The field shape: an object that references itself one key down. `version`
 *  is set AFTER `self` so a compare walks the cycle before it can find the
 *  one leaf that differs between two versions. */
function cyclicSchema(version = 1): Schema {
  const s = { name: 'search', params: { q: 'string' } } as Schema;
  s.self = s;
  s.version = version;
  return s;
}

// ════════════════════════════════════════════════════════════════════════
// deepEqual — the net-change filter terminates on every legal value
// ════════════════════════════════════════════════════════════════════════

describe('deepEqual — cyclic values', () => {
  it('(a) a self-referential object equals its structural twin', () => {
    expect(deepEqual(cyclicSchema(), cyclicSchema())).toBe(true);
    // The twin the engine itself makes: committed state is a structuredClone.
    const s = cyclicSchema();
    expect(deepEqual(s, structuredClone(s))).toBe(true);
  });

  it('(a) cyclic arrays and two-object (mutual) cycles', () => {
    const a: unknown[] = [1];
    a.push(a);
    const b: unknown[] = [1];
    b.push(b);
    expect(deepEqual(a, b)).toBe(true);

    const p: Record<string, unknown> = { n: 1 };
    const q: Record<string, unknown> = { p };
    p.q = q;
    const p2: Record<string, unknown> = { n: 1 };
    const q2: Record<string, unknown> = { p: p2 };
    p2.q = q2;
    expect(deepEqual(p, p2)).toBe(true);
  });

  it('(b) two cycles of different shape are not equal', () => {
    // Loops back through a node with different data.
    const one: Record<string, unknown> = { name: 'x' };
    one.self = one;
    const two: Record<string, unknown> = { name: 'x' };
    two.self = { name: 'y', self: two };
    expect(deepEqual(one, two)).toBe(false);

    // Loops back under a different key.
    const viaSelf: Record<string, unknown> = { name: 'x' };
    viaSelf.self = viaSelf;
    const viaParent: Record<string, unknown> = { name: 'x' };
    viaParent.parent = viaParent;
    expect(deepEqual(viaSelf, viaParent)).toBe(false);

    // Array cycle vs object cycle.
    const arr: unknown[] = [];
    arr.push(arr);
    const obj: Record<string, unknown> = {};
    obj[0] = obj;
    expect(deepEqual(arr, obj)).toBe(false);
  });

  it('(c) a cycle vs an acyclic value is not equal', () => {
    const s = cyclicSchema();
    const flat = {
      name: 'search',
      version: 1,
      params: { q: 'string' },
      self: { name: 'search', version: 1, params: { q: 'string' } },
    };
    expect(deepEqual(s, flat)).toBe(false);
    expect(deepEqual(flat, s)).toBe(false);
  });

  it('a difference PAST the cycle is still seen — the guard hides no leaf', () => {
    expect(deepEqual(cyclicSchema(1), cyclicSchema(2))).toBe(false);
    const a: Record<string, unknown> = { leaf: { v: 1 } };
    a.self = a;
    const b: Record<string, unknown> = { leaf: { v: 2 } };
    b.self = b;
    expect(deepEqual(a, b)).toBe(false);
  });

  it('(d) acyclic behaviour unchanged — the existing rules, plus shared references', () => {
    expect(deepEqual(NaN, NaN)).toBe(true);
    expect(deepEqual(null, undefined)).toBe(false);
    expect(deepEqual([], {})).toBe(false);
    expect(deepEqual({ 0: 'a', length: 1 }, ['a'])).toBe(false);
    expect(deepEqual([1, 2, 3], [3, 2, 1])).toBe(false);
    expect(deepEqual({ a: 1, b: 2 }, { b: 2, a: 1 })).toBe(true);
    expect(deepEqual({ a: { b: { c: 1 } } }, { a: { b: { c: 2 } } })).toBe(false);
    expect(deepEqual({ a: 1, b: undefined }, { a: 1, c: undefined })).toBe(false);

    // A DAG (one object reachable twice) is not a cycle: each occurrence is
    // compared against its own counterpart.
    const shared = { k: 1 };
    expect(deepEqual({ a: shared, b: shared }, { a: { k: 1 }, b: { k: 1 } })).toBe(true);
    expect(deepEqual({ a: shared, b: shared }, { a: { k: 1 }, b: { k: 2 } })).toBe(false);
    expect(deepEqual({ a: { k: 1 }, b: { k: 2 } }, { a: shared, b: shared })).toBe(false);
  });
});

// ════════════════════════════════════════════════════════════════════════
// deepSmartMerge — the merge verb terminates on a cyclic source
// ════════════════════════════════════════════════════════════════════════

describe('deepSmartMerge — cyclic source', () => {
  it('a cyclic src merges to a value that mirrors the cycle', () => {
    const out = deepSmartMerge({ name: 'old', extra: true }, cyclicSchema());
    expect(out.name).toBe('search');
    expect(out.extra).toBe(true);
    expect(out.params).toEqual({ q: 'string' });
    expect(out.self).toBe(out); // the cycle re-enters the value being built
  });

  it('a shared (acyclic) src reference at two keys still merges against each key’s own dst', () => {
    const shared = { x: 1 };
    const out = deepSmartMerge({ a: { keepA: true }, b: { keepB: true } }, { a: shared, b: shared });
    expect(out.a).toEqual({ keepA: true, x: 1 });
    expect(out.b).toEqual({ keepB: true, x: 1 });
    expect(out.a).not.toBe(out.b);
  });

  it('acyclic behaviour unchanged', () => {
    expect(deepSmartMerge({ a: [1, 2], b: { c: 1 } }, { a: [2, 3], b: { d: 2 }, e: 'x' })).toEqual({
      a: [1, 2, 3],
      b: { c: 1, d: 2 },
      e: 'x',
    });
    expect(deepSmartMerge({ a: [1] }, { a: [] })).toEqual({ a: [] });
    expect(deepSmartMerge({ a: 1 }, null)).toBe(null);
    expect(deepSmartMerge(undefined, { a: { b: 1 } })).toEqual({ a: { b: 1 } });
  });
});

// ════════════════════════════════════════════════════════════════════════
// (e) engine — a cyclic value crosses a subflow outputMapper; the run completes
// ════════════════════════════════════════════════════════════════════════

interface Inner {
  schema?: Schema;
}
interface Outer {
  tools?: Schema[];
  tool?: Schema;
  done?: boolean;
}

/** Outer seeds `tools = [v1]`, the subflow describes a schema, its outputMapper
 *  REPLACES `tools` — a `set` over a key that already holds a cyclic value, so
 *  the net-change filter must compare two cycles. */
function outputMapperChart(describe: () => Schema) {
  const inner = flowChart<Inner>(
    'Describe',
    async (scope) => {
      scope.schema = describe(); // TypedScope set trap: JSON round-trip fails, value passes through raw
    },
    'describe',
  ).build();

  return flowChart<Outer>(
    'Seed',
    async (scope) => {
      scope.tools = [cyclicSchema(1)];
    },
    'seed',
  )
    .addSubFlowChartNext('sf-tools', inner, 'Tools', {
      outputMapper: (s: Inner) => ({ tools: [s.schema] }),
      arrayMerge: ArrayMergeMode.Replace,
    })
    .addFunction(
      'Finish',
      async (scope) => {
        scope.done = true;
      },
      'finish',
    )
    .build();
}

function toolsWriters(log: readonly CommitBundle[]): CommitBundle[] {
  return log.filter((b) => b.trace.some((t) => t.path === 'tools'));
}

function outputMapperErrors(snapshot: { executionTree: unknown }): string[] {
  const out: string[] = [];
  const walk = (node: unknown) => {
    if (!node || typeof node !== 'object') return;
    const errors = (node as { errors?: Record<string, unknown> }).errors;
    if (errors && Object.prototype.hasOwnProperty.call(errors, 'outputMapperError')) {
      out.push(String(errors.outputMapperError));
    }
  };
  for (const node of Object.values(snapshot.executionTree as Record<string, unknown>)) walk(node);
  return out;
}

describe('engine — a cyclic value through a subflow outputMapper', () => {
  it('a changed cyclic twin commits, and the log, the fold and the cursor all hold the cycle', async () => {
    const executor = new FlowChartExecutor(outputMapperChart(() => cyclicSchema(2)));
    await executor.run();
    const snapshot = executor.getSnapshot();

    // The run completed and nothing was swallowed on the way.
    expect(outputMapperErrors(snapshot)).toEqual([]);
    expect(snapshot.sharedState.done).toBe(true);

    // Live state: the merged-back value is the v2 cycle.
    const live = snapshot.sharedState.tools as Schema[];
    expect(live[0].version).toBe(2);
    expect(live[0].self).toBe(live[0]);

    // The inner run held the cycle too — landmine 1 (the TypedScope JSON
    // round-trip) lets a cyclic value through untouched.
    const sf = (snapshot.subflowResults as Record<string, { treeContext: { globalContext: Inner } }>)['sf-tools'];
    expect(sf.treeContext.globalContext.schema?.self).toBe(sf.treeContext.globalContext.schema);

    // Commit log: seed (v1) and mount (v2) both wrote `tools`, both hold a cycle.
    const writers = toolsWriters(snapshot.commitLog);
    expect(writers).toHaveLength(2);
    for (const bundle of writers) {
      const tools = (bundle.overwrite as { tools: Schema[] }).tools;
      expect(tools[0].self).toBe(tools[0]);
    }
    expect((writers[1].overwrite as { tools: Schema[] }).tools[0].version).toBe(2);

    // The fold, the reconstructed value and every cursor stop terminate.
    const last = snapshot.commitLog.length - 1;
    const folded = stateAt(snapshot, last);
    const foldedTools = folded.state.tools as Schema[];
    expect(foldedTools[0].version).toBe(2);
    expect(foldedTools[0].self).toBe(foldedTools[0]);
    expect(Object.isFrozen(foldedTools[0])).toBe(true);

    const at = commitValueAt(snapshot.commitLog as CommitBundle[], last, 'tools') as Schema[];
    expect(at[0].version).toBe(2);
    expect(at[0].self).toBe(at[0]);

    const tt = timeTravel(snapshot);
    for (const stop of tt.stops) expect(() => tt.stateAt(stop)).not.toThrow();
  });

  it('an identical cyclic twin is a no-op write — nothing spurious is committed', async () => {
    const executor = new FlowChartExecutor(outputMapperChart(() => cyclicSchema(1)));
    await executor.run();
    const snapshot = executor.getSnapshot();

    expect(outputMapperErrors(snapshot)).toEqual([]);
    expect(snapshot.sharedState.done).toBe(true);
    expect(toolsWriters(snapshot.commitLog)).toHaveLength(1); // the seed only
  });

  it('the merge verb ($update) takes a cyclic value and every replay of it terminates', async () => {
    const chart = flowChart<Outer>(
      'Seed',
      async (scope) => {
        scope.tool = { name: 'old', version: 0, params: {} };
      },
      'seed',
    )
      .addFunction(
        'Update',
        async (scope) => {
          scope.$update('tool', cyclicSchema(3));
        },
        'update',
      )
      .build();

    const executor = new FlowChartExecutor(chart);
    await executor.run();
    const snapshot = executor.getSnapshot();

    const live = snapshot.sharedState.tool as Schema;
    expect(live.version).toBe(3);
    expect(live.self).toBe(live);

    const last = snapshot.commitLog.length - 1;
    expect(snapshot.commitLog[last].trace.map((t) => t.verb)).toEqual(['merge']);
    const folded = stateAt(snapshot, last).state.tool as Schema;
    expect(folded.version).toBe(3);
    expect(folded.self).toBe(folded);
    const at = commitValueAt(snapshot.commitLog as CommitBundle[], last, 'tool') as Schema;
    expect(at.version).toBe(3);
    expect(at.self).toBe(at);
  });
});
