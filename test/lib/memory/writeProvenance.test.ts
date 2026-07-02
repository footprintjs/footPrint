/**
 * writeProvenance dial (#P1) — per-write read-sets. Convention 3, all 7 types.
 *
 * What is being pinned:
 * 1. TEMPORAL-PREFIX SEMANTICS: each staged write records exactly the keys
 *    tracked-read BEFORE it (monotone — prefixes only grow in a stage).
 * 2. BYTE PARITY WHEN OFF (the default): no `readKeys` field anywhere —
 *    charts that never enable the dial keep byte-identical commit logs.
 * 3. The 6-site propagation pattern: executor option → runtime → root
 *    context → createNext/createChild → SubflowExecutor duck-push, plus the
 *    snapshot discriminant.
 * 4. Delta-mode aggregation: one entry per path carries the LAST write's
 *    prefix (== the union, by monotonicity).
 */

import { describe, expect, it } from 'vitest';

import { flowChart } from '../../../src/lib/builder/FlowChartBuilder.js';
import { TransactionBuffer } from '../../../src/lib/memory/TransactionBuffer.js';
import type { CommitBundle } from '../../../src/lib/memory/types.js';
import { FlowChartExecutor } from '../../../src/lib/runner/FlowChartExecutor.js';

/** Find the trace entry for a user key in a bundle (run-namespaced paths). */
function entryFor(bundle: CommitBundle, key: string) {
  return bundle.trace.find((t) => t.path.endsWith(key));
}
/** Strip the run namespace from recorded read keys for assertion ease. */
function userKeys(readKeys: string[] | undefined): string[] | undefined {
  return readKeys;
}

// ════════════════════════════════════════════════════════════════════════
// UNIT — TransactionBuffer stamping
// ════════════════════════════════════════════════════════════════════════

describe('TransactionBuffer readKeys stamping — unit', () => {
  it('stamps the provider value per op; different writes capture different prefixes', () => {
    const reads: string[] = [];
    const buf = new TransactionBuffer({}, 'full', () => [...reads]);
    buf.set(['x'], 1);
    reads.push('a');
    buf.set(['y'], 2);
    reads.push('b');
    buf.merge(['z'], { n: 1 });
    const { trace } = buf.commit();
    expect(trace.find((t) => t.path === 'x')!.readKeys).toEqual([]);
    expect(trace.find((t) => t.path === 'y')!.readKeys).toEqual(['a']);
    expect(trace.find((t) => t.path === 'z')!.readKeys).toEqual(['a', 'b']);
  });

  it('NO provider (default) → readKeys absent on every entry — byte parity', () => {
    const buf = new TransactionBuffer({}, 'full');
    buf.set(['x'], 1);
    buf.merge(['z'], { n: 1 });
    const { trace } = buf.commit();
    expect(trace.every((t) => !Object.prototype.hasOwnProperty.call(t, 'readKeys'))).toBe(true);
  });

  it('delta mode: one entry per path carries the LAST write prefix (the union)', () => {
    const reads: string[] = [];
    const buf = new TransactionBuffer({}, 'delta', () => [...reads]);
    buf.set(['arr'], ['m0']);
    reads.push('a');
    buf.set(['arr'], ['m0', 'm1']); // second write of same path, later prefix
    const { trace } = buf.commit();
    const arrEntries = trace.filter((t) => t.path === 'arr');
    expect(arrEntries).toHaveLength(1); // delta dedup: one entry per path
    expect(arrEntries[0].readKeys).toEqual(['a']); // LAST prefix, not the first
  });
});

// ════════════════════════════════════════════════════════════════════════
// FUNCTIONAL — real executor, the dial end-to-end (both commitValues modes)
// ════════════════════════════════════════════════════════════════════════

describe('writeProvenance — functional (real charts)', () => {
  interface S {
    a?: number;
    b?: number;
    x?: number;
    y?: number;
  }

  function abChart() {
    return flowChart<S>(
      'Seed',
      async (scope) => {
        scope.a = 1;
        scope.b = 2;
      },
      'seed',
    )
      .addFunction(
        'Mixed',
        async (scope) => {
          scope.x = scope.a! + 1; // read a THEN write x → readKeys [a]
          scope.y = scope.b! + 1; // read b THEN write y → readKeys [a, b]
        },
        'mixed',
      )
      .build();
  }

  it.each(['full', 'delta'] as const)(
    'commitValues %s: per-write prefixes distinguish x←a from y←{a,b}',
    async (mode) => {
      const executor = new FlowChartExecutor(abChart(), { commitValues: mode, writeProvenance: 'reads-prefix' });
      await executor.run();
      const snapshot = executor.getSnapshot();
      expect(snapshot.writeProvenance).toBe('reads-prefix'); // the discriminant

      const mixed = snapshot.commitLog.find((c) => c.stageId === 'mixed')!;
      // The whole point of the dial: x's write saw only `a`; y's saw both.
      expect(userKeys(entryFor(mixed, 'x')!.readKeys)).toEqual(['a']);
      expect(userKeys(entryFor(mixed, 'y')!.readKeys)).toEqual(['a', 'b']);
      // Seed wrote before any read — honest empty prefix, not absence.
      expect(entryFor(snapshot.commitLog[0], 'a')!.readKeys).toEqual([]);
    },
  );

  it('default (off): commit log is byte-identical — no readKeys field anywhere', async () => {
    const executor = new FlowChartExecutor(abChart());
    await executor.run();
    const snapshot = executor.getSnapshot();
    expect(snapshot.writeProvenance).toBe('off');
    for (const bundle of snapshot.commitLog) {
      expect(bundle.trace.every((t) => !Object.prototype.hasOwnProperty.call(t, 'readKeys'))).toBe(true);
    }
  });

  it('provenance works even under readTracking OFF (independent dials)', async () => {
    const executor = new FlowChartExecutor(abChart(), { readTracking: 'off', writeProvenance: 'reads-prefix' });
    await executor.run();
    const mixed = executor.getSnapshot().commitLog.find((c) => c.stageId === 'mixed')!;
    expect(entryFor(mixed, 'x')!.readKeys).toEqual(['a']); // key STRINGS need no retention
  });
});

// ════════════════════════════════════════════════════════════════════════
// INTEGRATION — subflow duck-push inheritance
// ════════════════════════════════════════════════════════════════════════

describe('writeProvenance — integration (subflow inheritance)', () => {
  interface Outer {
    seedVal?: number;
    result?: number;
  }
  interface Inner {
    input?: number;
    output?: number;
  }

  it('a nested subflow stamps readKeys because the parent dial pushes in', async () => {
    const inner = flowChart<Inner>(
      'Compute',
      async (scope) => {
        scope.output = (scope.input ?? 0) * 2; // read input → write output
      },
      'compute',
    ).build();

    const outer = flowChart<Outer>(
      'Seed',
      async (scope) => {
        scope.seedVal = 21;
      },
      'seed',
    )
      .addSubFlowChartNext('sf-calc', inner, 'Calc', {
        inputMapper: (scope: Outer) => ({ input: scope.seedVal }),
        outputMapper: (s: Inner) => ({ result: s.output }),
      })
      .build();

    const executor = new FlowChartExecutor(outer, { writeProvenance: 'reads-prefix' });
    await executor.run();
    const snapshot = executor.getSnapshot();

    // Subflow commit logs live on the subflow result's treeContext.history
    // (the subflow runs in an ISOLATED runtime — see slice/README.md
    // § Subflow boundaries).
    const sf = (snapshot.subflowResults as Record<string, { treeContext: { history: CommitBundle[] } }>)['sf-calc'];
    expect(sf).toBeDefined();
    const bundles = sf.treeContext.history;
    const compute = bundles.find((c) => c.trace.some((t) => t.path.endsWith('output')))!;
    const outEntry = compute.trace.find((t) => t.path.endsWith('output'))!;
    expect(outEntry.readKeys).toEqual(['input']); // inherited dial, inner chart stamped
  });
});

// ════════════════════════════════════════════════════════════════════════
// PROPERTY — monotone-prefix invariant over random read/write interleavings
// ════════════════════════════════════════════════════════════════════════

describe('writeProvenance — property (temporal prefix is monotone and exact)', () => {
  function mulberry32(seed: number) {
    return () => {
      seed |= 0;
      seed = (seed + 0x6d2b79f5) | 0;
      let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  it('every staged write records exactly the reads that preceded it (30 random interleavings)', () => {
    for (let run = 0; run < 30; run++) {
      const rand = mulberry32(7 + run);
      const reads: string[] = [];
      const seen = new Set<string>();
      const buf = new TransactionBuffer({}, 'full', () => [...reads]);
      const expected: Array<{ path: string; prefix: string[] }> = [];
      let w = 0;
      for (let i = 0; i < 20; i++) {
        if (rand() < 0.5) {
          const k = `r${Math.floor(rand() * 6)}`;
          if (!seen.has(k)) {
            seen.add(k);
            reads.push(k);
          } // registry = insertion-ordered set
        } else {
          const path = `w${w++}`;
          expected.push({ path, prefix: [...reads] });
          buf.set([path], i);
        }
      }
      const { trace } = buf.commit();
      for (const { path, prefix } of expected) {
        expect(trace.find((t) => t.path === path)!.readKeys).toEqual(prefix);
      }
      // Monotonicity: prefixes never shrink across write order.
      for (let i = 1; i < expected.length; i++) {
        expect(expected[i].prefix.length).toBeGreaterThanOrEqual(expected[i - 1].prefix.length);
      }
    }
  });
});

// ════════════════════════════════════════════════════════════════════════
// SECURITY — readKeys carries key NAMES only, never values
// ════════════════════════════════════════════════════════════════════════

describe('writeProvenance — security', () => {
  interface S {
    apiKey?: string;
    derived?: string;
  }

  it('a redacted key appears in readKeys by NAME; its value never does', async () => {
    const chart = flowChart<S>(
      'Seed',
      async (scope) => {
        scope.apiKey = 'sk-super-secret-123';
      },
      'seed',
    )
      .addFunction(
        'Use',
        async (scope) => {
          scope.derived = scope.apiKey!.length.toString();
        },
        'use',
      )
      .build();
    const executor = new FlowChartExecutor(chart, { writeProvenance: 'reads-prefix' });
    executor.setRedactionPolicy({ keys: ['apiKey'] });
    await executor.run();
    const log = executor.getSnapshot().commitLog;
    const use = log.find((c) => c.stageId === 'use')!;
    expect(entryFor(use, 'derived')!.readKeys).toEqual(['apiKey']); // the NAME — that is the provenance
    expect(JSON.stringify(log)).not.toContain('sk-super-secret'); // the VALUE stays redacted upstream
  });
});

// ════════════════════════════════════════════════════════════════════════
// PERFORMANCE + LOAD
// ════════════════════════════════════════════════════════════════════════

describe('writeProvenance — performance & load', () => {
  it('perf: 2000 stamped writes with a 50-key prefix under 250ms', () => {
    const reads = Array.from({ length: 50 }, (_, i) => `k${i}`);
    const buf = new TransactionBuffer({}, 'full', () => [...reads]);
    const t0 = performance.now();
    for (let i = 0; i < 2000; i++) buf.set([`w${i}`], i);
    buf.commit();
    expect(performance.now() - t0).toBeLessThan(250);
  });

  it('load: a 60-stage chart with the dial on completes and stamps everywhere', async () => {
    interface S {
      [k: string]: number | undefined;
    }
    let builder = flowChart<S>(
      'S0',
      async (scope) => {
        scope.v0 = 0;
      },
      's0',
    );
    for (let i = 1; i < 60; i++) {
      const idx = i;
      builder = builder.addFunction(
        `S${idx}`,
        async (scope) => {
          scope[`v${idx}`] = (scope[`v${idx - 1}`] ?? 0) + 1; // read prev → write next
        },
        `s${idx}`,
      );
    }
    const executor = new FlowChartExecutor(builder.build(), { writeProvenance: 'reads-prefix' });
    await executor.run();
    const log = executor.getSnapshot().commitLog;
    expect(log).toHaveLength(60);
    for (let i = 1; i < 60; i++) {
      expect(entryFor(log[i], `v${i}`)!.readKeys).toEqual([`v${i - 1}`]);
    }
  });
});
