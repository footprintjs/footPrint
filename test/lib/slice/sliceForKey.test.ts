/**
 * sliceForKey / keysRead sources — Convention 3 coverage, all 7 types:
 * UNIT, FUNCTIONAL, INTEGRATION, PROPERTY, SECURITY, PERFORMANCE, LOAD.
 *
 * What is being pinned: the variable-first triage contract — anchor at the
 * key's last writer, delegate to causalChain, honest absence as a result
 * (`missing`), and the keysRead strategy breadcrumb (`keysReadKind`).
 */

import { describe, expect, it } from 'vitest';

import { flowChart } from '../../../src/lib/builder/FlowChartBuilder.js';
import type { CommitBundle, StageSnapshot } from '../../../src/lib/memory/types.js';
import { controlDepRecorder } from '../../../src/lib/recorder/ControlDepRecorder.js';
import { FlowChartExecutor } from '../../../src/lib/runner/FlowChartExecutor.js';
import {
  keysReadFromExecutionTree,
  keysReadFromMap,
  resolveKeysReadSource,
  sliceForKey,
} from '../../../src/lib/slice/index.js';

// ── Test helpers ───────────────────────────────────────────────────────

function commit(stageId: string, runtimeStageId: string, keysWritten: string[], idx: number): CommitBundle {
  return {
    idx,
    stage: stageId,
    stageId,
    runtimeStageId,
    trace: keysWritten.map((k) => ({ path: k, verb: 'set' as const })),
    redactedPaths: [],
    overwrite: Object.fromEntries(keysWritten.map((k) => [k, `val-${k}`])),
    updates: {},
  };
}

// ════════════════════════════════════════════════════════════════════════
// UNIT
// ════════════════════════════════════════════════════════════════════════

describe('sliceForKey — unit', () => {
  const log = [
    commit('seed', 'seed#0', ['x'], 0),
    commit('mid', 'mid#1', ['y'], 1),
    commit('end', 'end#2', ['z'], 2),
    commit('mid', 'mid#3', ['y'], 3), // y rewritten later
  ];
  const reads = keysReadFromMap({ 'mid#1': ['x'], 'end#2': ['y'], 'mid#3': ['x'] });

  it('anchors at the LAST writer of the key', () => {
    const slice = sliceForKey(log, 'y', reads);
    expect(slice.writer?.runtimeStageId).toBe('mid#3');
    expect(slice.root?.runtimeStageId).toBe('mid#3');
    expect(slice.missing).toBeUndefined();
  });

  it('walks read→write dependencies transitively from the anchor', () => {
    const slice = sliceForKey(log, 'z', reads);
    expect(slice.writer?.runtimeStageId).toBe('end#2');
    // end#2 read y → last writer of y BEFORE idx 2 is mid#1; mid#1 read x → seed#0.
    const parent = slice.root!.parents[0];
    expect(parent.runtimeStageId).toBe('mid#1');
    expect(parent.parents[0]?.runtimeStageId).toBe('seed#0');
  });

  it('`before` slices the value as it stood at an earlier time', () => {
    const slice = sliceForKey(log, 'y', reads, { before: 2 });
    expect(slice.writer?.runtimeStageId).toBe('mid#1');
    expect(slice.before).toBe(2);
  });

  it('honest absence: empty log', () => {
    const slice = sliceForKey([], 'y', reads);
    expect(slice.missing).toBe('empty-log');
    expect(slice.root).toBeUndefined();
    expect(slice.writer).toBeUndefined();
  });

  it('honest absence: never-written key (initial-state / args / closure blind spot)', () => {
    const slice = sliceForKey(log, 'ghost', reads);
    expect(slice.missing).toBe('never-written');
    expect(slice.root).toBeUndefined();
  });

  it('records which keysRead strategy produced the slice', () => {
    expect(sliceForKey(log, 'y', reads).keysReadKind).toBe('map');
    expect(sliceForKey(log, 'y', (id) => (id === 'mid#3' ? ['x'] : [])).keysReadKind).toBe('custom-fn');
  });

  it('data edges carry the read key', () => {
    const slice = sliceForKey(log, 'z', reads);
    const edge = slice.root!.parentEdges[0];
    expect(edge.kind).toBe('data');
    expect(edge.key).toBe('y');
  });
});

describe('keysRead sources — unit', () => {
  it('resolveKeysReadSource wraps bare functions, passes strategies through', () => {
    const fn = (_id: string) => ['a'];
    expect(resolveKeysReadSource(fn).kind).toBe('custom-fn');
    const src = keysReadFromMap({});
    expect(resolveKeysReadSource(src)).toBe(src);
  });

  it('keysReadFromMap accepts both Map and plain-object forms', () => {
    const fromMap = keysReadFromMap(new Map([['a#0', ['k1']]]));
    const fromObj = keysReadFromMap({ 'a#0': ['k1'] });
    expect(fromMap.lookup('a#0')).toEqual(['k1']);
    expect(fromObj.lookup('a#0')).toEqual(['k1']);
    expect(fromMap.lookup('missing#9')).toEqual([]);
  });

  it('keysReadFromExecutionTree walks next + children and skips nodes without ids/reads', () => {
    const tree: StageSnapshot = {
      id: 'a',
      runtimeStageId: 'a#0',
      stageReads: { x: 1 },
      logs: {},
      errors: {},
      metrics: {},
      evals: {},
      next: {
        id: 'fork',
        // no runtimeStageId — must be skipped, not crash
        logs: {},
        errors: {},
        metrics: {},
        evals: {},
        children: [
          { id: 'b', runtimeStageId: 'b#1', stageReads: { y: 'marker' }, logs: {}, errors: {}, metrics: {}, evals: {} },
          { id: 'c', runtimeStageId: 'c#2', logs: {}, errors: {}, metrics: {}, evals: {} }, // no reads
        ],
      },
    };
    const src = keysReadFromExecutionTree(tree);
    expect(src.kind).toBe('execution-tree');
    expect(src.lookup('a#0')).toEqual(['x']);
    expect(src.lookup('b#1')).toEqual(['y']); // summary markers keep KEYS — that's all a slice needs
    expect(src.lookup('c#2')).toEqual([]);
  });

  it('keysReadFromExecutionTree survives a malformed (cyclic) consumer-built tree', () => {
    const a: StageSnapshot = {
      id: 'a',
      runtimeStageId: 'a#0',
      stageReads: { x: 1 },
      logs: {},
      errors: {},
      metrics: {},
      evals: {},
    };
    a.next = a; // deliberately malformed
    expect(() => keysReadFromExecutionTree(a)).not.toThrow();
    expect(keysReadFromExecutionTree(a).lookup('a#0')).toEqual(['x']);
  });

  it('keysReadFromMap object form does NOT read through the prototype chain', () => {
    // runtimeStageIds are consumer-influenced strings — an id named
    // 'constructor' must not resolve Object.prototype.constructor.
    const src = keysReadFromMap({ 'a#0': ['k'] });
    expect(src.lookup('constructor')).toEqual([]);
    expect(src.lookup('hasOwnProperty')).toEqual([]);
  });

  it('array-path StateKey normalises internally — no engine delimiter needed', () => {
    // A nested write is recorded under its normalised path; consumers pass
    // the path ARRAY and never touch the delimiter constant.
    const nestedKey = ['customer', 'address'];
    const slice = sliceForKey([], nestedKey, keysReadFromMap({}));
    expect(slice.key).toContain('customer');
    expect(slice.key).toContain('address');
    expect(slice.missing).toBe('empty-log');
  });

  it('coverage telemetry propagates: KeysReadSource.coverage → VariableSlice.readsCoverage', () => {
    const tree: StageSnapshot = {
      id: 'a',
      runtimeStageId: 'a#0',
      stageReads: { x: 1 },
      logs: {},
      errors: {},
      metrics: {},
      evals: {},
      next: { id: 'b', runtimeStageId: 'b#1', logs: {}, errors: {}, metrics: {}, evals: {} },
    };
    const src = keysReadFromExecutionTree(tree);
    expect(src.coverage).toEqual({ steps: 2, stepsWithReads: 1 });
    const log = [commit('a', 'a#0', ['x'], 0)];
    expect(sliceForKey(log, 'x', src).readsCoverage).toEqual({ steps: 2, stepsWithReads: 1 });
    // Map/custom-fn strategies carry no coverage — field stays absent, not fabricated.
    expect(sliceForKey(log, 'x', keysReadFromMap({})).readsCoverage).toBeUndefined();
  });

  it('keysReadFromExecutionTree accepts multiple roots (subflow trees)', () => {
    const rootTree: StageSnapshot = {
      id: 'r',
      runtimeStageId: 'r#0',
      stageReads: { a: 1 },
      logs: {},
      errors: {},
      metrics: {},
      evals: {},
    };
    const sfTree: StageSnapshot = {
      id: 's',
      runtimeStageId: 'sf/s#1',
      stageReads: { b: 1 },
      logs: {},
      errors: {},
      metrics: {},
      evals: {},
    };
    const src = keysReadFromExecutionTree([rootTree, sfTree]);
    expect(src.lookup('r#0')).toEqual(['a']);
    expect(src.lookup('sf/s#1')).toEqual(['b']);
  });
});

// ════════════════════════════════════════════════════════════════════════
// FUNCTIONAL — the zero-setup selling point: slice a finished run's
// snapshot with NO recorder attached (reads come from the execution tree).
// ════════════════════════════════════════════════════════════════════════

describe('sliceForKey — functional (real run, zero recorders)', () => {
  interface S {
    input?: string;
    processed?: string;
    output?: string;
  }

  it('click-a-key triage: why is `output` what it is?', async () => {
    const chart = flowChart<S>(
      'Seed',
      async (scope) => {
        scope.input = 'hello';
      },
      'seed',
    )
      .addFunction(
        'Process',
        async (scope) => {
          scope.processed = scope.input!.toUpperCase();
        },
        'process',
      )
      .addFunction(
        'Format',
        async (scope) => {
          scope.output = `[${scope.processed}]`;
        },
        'format',
      )
      .build();

    const executor = new FlowChartExecutor(chart);
    await executor.run();
    const snapshot = executor.getSnapshot();

    const slice = sliceForKey(
      snapshot.commitLog,
      'output',
      keysReadFromExecutionTree(snapshot.executionTree as StageSnapshot),
    );

    expect(slice.missing).toBeUndefined();
    expect(slice.writer?.stageId).toBe('format');
    // format read `processed` (written by process), which read `input` (seed).
    const chain = [
      slice.root!.runtimeStageId,
      slice.root!.parents[0]?.runtimeStageId,
      slice.root!.parents[0]?.parents[0]?.runtimeStageId,
    ];
    expect(chain[0]).toMatch(/^format#/);
    expect(chain[1]).toMatch(/^process#/);
    expect(chain[2]).toMatch(/^seed#/);
  });
});

// ════════════════════════════════════════════════════════════════════════
// INTEGRATION — with ControlDepRecorder: the slice explains BOTH data
// lineage and "which decision allowed the writer to run".
// ════════════════════════════════════════════════════════════════════════

describe('sliceForKey — integration (control edges)', () => {
  interface S {
    score?: number;
    verdict?: string;
  }

  it('the writer stage carries a control edge to its governing decider', async () => {
    const chart = flowChart<S>(
      'Score',
      async (scope) => {
        scope.score = 750;
      },
      'score',
    )
      .addDeciderFunction('Route', async (scope) => (scope.score! > 700 ? 'good' : 'bad'), 'route')
      .addFunctionBranch('good', 'Approve', async (scope) => {
        scope.verdict = 'approved';
      })
      .addFunctionBranch('bad', 'Reject', async (scope) => {
        scope.verdict = 'rejected';
      })
      .setDefault('bad')
      .end()
      .build();

    const ctrl = controlDepRecorder();
    const executor = new FlowChartExecutor(chart);
    executor.attachCombinedRecorder(ctrl);
    await executor.run();
    const snapshot = executor.getSnapshot();

    const slice = sliceForKey(
      snapshot.commitLog,
      'verdict',
      keysReadFromExecutionTree(snapshot.executionTree as StageSnapshot),
      { controlDeps: ctrl.asLookup() },
    );

    expect(slice.writer?.stage).toBe('Approve');
    const controlEdge = slice.root!.parentEdges.find((e) => e.kind === 'control');
    expect(controlEdge).toBeDefined();
    expect(controlEdge!.parent.runtimeStageId).toMatch(/^route#/);
  });
});

// ════════════════════════════════════════════════════════════════════════
// PROPERTY — slice membership equals reference reachability: for random
// dependency graphs, the slice contains exactly the commits reachable from
// the anchor via (read key → last prior writer) hops.
// ════════════════════════════════════════════════════════════════════════

describe('sliceForKey — property (reference reachability)', () => {
  function mulberry32(seed: number) {
    return () => {
      seed |= 0;
      seed = (seed + 0x6d2b79f5) | 0;
      let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  it('matches an independent backward-reachability computation (20 random graphs)', () => {
    for (let g = 0; g < 20; g++) {
      const rand = mulberry32(1000 + g);
      const n = 5 + Math.floor(rand() * 20);
      const log: CommitBundle[] = [];
      const readsMap: Record<string, string[]> = {};
      for (let i = 0; i < n; i++) {
        const id = `s${i}#${i}`;
        const writes = [`k${i}`];
        // read up to 2 keys written strictly earlier
        const reads: string[] = [];
        for (let r = 0; r < 2; r++) {
          if (i > 0 && rand() < 0.7) reads.push(`k${Math.floor(rand() * i)}`);
        }
        readsMap[id] = [...new Set(reads)];
        log.push(commit(`s${i}`, id, writes, i));
      }
      const targetKey = `k${n - 1}`;
      const slice = sliceForKey(log, targetKey, keysReadFromMap(readsMap), { maxDepth: 100, maxNodes: 1000 });

      // Reference: BFS over (read key → last writer before idx), independent impl.
      const expected = new Set<string>();
      const queue: number[] = [n - 1];
      while (queue.length > 0) {
        const idx = queue.shift()!;
        const id = `s${idx}#${idx}`;
        if (expected.has(id)) continue;
        expected.add(id);
        for (const rk of readsMap[id]) {
          for (let j = idx - 1; j >= 0; j--) {
            if (log[j].trace.some((t) => t.path === rk)) {
              queue.push(j);
              break;
            }
          }
        }
      }

      const got = new Set<string>();
      const stack = [slice.root!];
      while (stack.length > 0) {
        const node = stack.pop()!;
        if (got.has(node.runtimeStageId)) continue;
        got.add(node.runtimeStageId);
        for (const p of node.parents) stack.push(p);
      }
      expect(got).toEqual(expected);
    }
  });
});

// ════════════════════════════════════════════════════════════════════════
// SECURITY — the slice re-serves commit-log bytes; redacted stays redacted.
// ════════════════════════════════════════════════════════════════════════

describe('sliceForKey — security (redaction pass-through)', () => {
  it('a redacted writer bundle flows through unmodified — no resurrection surface', () => {
    const redacted: CommitBundle = {
      idx: 0,
      stage: 'auth',
      stageId: 'auth',
      runtimeStageId: 'auth#0',
      trace: [{ path: 'apiKey', verb: 'set' }],
      redactedPaths: ['apiKey'],
      overwrite: { apiKey: '[REDACTED]' },
      updates: {},
    };
    const slice = sliceForKey([redacted], 'apiKey', keysReadFromMap({}));
    expect(slice.writer!.overwrite.apiKey).toBe('[REDACTED]');
    expect(slice.writer!.redactedPaths).toContain('apiKey');
    expect(JSON.stringify(slice)).not.toContain('sk-real'); // nothing invented
  });
});

// ════════════════════════════════════════════════════════════════════════
// PERFORMANCE + LOAD — post-hoc query budgets (CI-safe, generous).
// ════════════════════════════════════════════════════════════════════════

describe('sliceForKey — performance & load', () => {
  it('perf: one slice over a 5k-commit log stays under 500ms', () => {
    const n = 5000;
    const log: CommitBundle[] = [];
    const readsMap: Record<string, string[]> = {};
    for (let i = 0; i < n; i++) {
      const id = `s${i}#${i}`;
      log.push(commit(`s${i}`, id, [`k${i}`], i));
      readsMap[id] = i > 0 ? [`k${i - 1}`] : [];
    }
    const t0 = performance.now();
    const slice = sliceForKey(log, `k${n - 1}`, keysReadFromMap(readsMap), { maxDepth: 50 });
    const elapsed = performance.now() - t0;
    expect(slice.root).toBeDefined();
    expect(elapsed).toBeLessThan(500);
  });

  it('load: 200 sequential variable slices over a 1k-commit log under 2s', () => {
    const n = 1000;
    const log: CommitBundle[] = [];
    const readsMap: Record<string, string[]> = {};
    for (let i = 0; i < n; i++) {
      const id = `s${i}#${i}`;
      log.push(commit(`s${i}`, id, [`k${i % 200}`], i));
      readsMap[id] = i > 0 ? [`k${(i - 1) % 200}`] : [];
    }
    const reads = keysReadFromMap(readsMap);
    const t0 = performance.now();
    for (let k = 0; k < 200; k++) {
      sliceForKey(log, `k${k}`, reads, { maxDepth: 10, maxNodes: 50 });
    }
    expect(performance.now() - t0).toBeLessThan(2000);
  });
});
