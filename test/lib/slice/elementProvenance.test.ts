/**
 * arrayProvenance / elementProvenance — Convention 3 coverage, all 7 types.
 *
 * What is being pinned:
 * 1. The append-fold INVARIANT: births are index-aligned with the
 *    reconstructed array, and the fold's value reconstruction agrees with
 *    `commitValueAt` byte-for-byte (property test — includes the MERGE arm
 *    with dedup collisions, so the two folds can never drift).
 * 2. The honesty labels: 'append-verb' (delta mode, exact) vs
 *    'prefix-inference' (full mode, heuristic) vs 'whole-value' (reset) —
 *    and honest ABSENCE: missing: 'empty-log'|'never-written'|'not-an-array'.
 * 3. The agent mega-key story end-to-end: a loop growing an array yields
 *    per-element birth stages in BOTH commitValues modes.
 */

import { describe, expect, it } from 'vitest';

import { flowChart } from '../../../src/lib/builder/FlowChartBuilder.js';
import { commitValueAt } from '../../../src/lib/memory/commitLogUtils.js';
import type { CommitBundle, StageSnapshot, TraceEntry } from '../../../src/lib/memory/types.js';
import { deepEqual } from '../../../src/lib/memory/utils.js';
import { FlowChartExecutor } from '../../../src/lib/runner/FlowChartExecutor.js';
import {
  arrayProvenance,
  elementProvenance,
  keysReadFromExecutionTree,
  sliceForKey,
} from '../../../src/lib/slice/index.js';

// ── Test helpers ───────────────────────────────────────────────────────

let seq = 0;
function bundle(stageId: string, verb: TraceEntry['verb'], key: string, value: unknown): CommitBundle {
  const idx = seq++;
  return {
    idx,
    stage: stageId,
    stageId,
    runtimeStageId: `${stageId}#${idx}`,
    trace: [{ path: key, verb }],
    redactedPaths: [],
    overwrite: verb === 'merge' ? {} : { [key]: value },
    updates: verb === 'merge' ? { [key]: value } : {},
  };
}
function resetSeq() {
  seq = 0;
}

// ════════════════════════════════════════════════════════════════════════
// UNIT
// ════════════════════════════════════════════════════════════════════════

describe('arrayProvenance — unit', () => {
  it('delta mode: append verbs give EXACT births per element', () => {
    resetSeq();
    const log = [
      bundle('seed', 'set', 'msgs', ['m0']),
      bundle('toolA', 'append', 'msgs', ['m1', 'm2']),
      bundle('toolB', 'append', 'msgs', ['m3']),
    ];
    const prov = arrayProvenance(log, 'msgs');
    expect(prov.missing).toBeUndefined();
    expect(prov.length).toBe(4);
    expect(prov.births!.map((b) => b.stageId)).toEqual(['seed', 'toolA', 'toolA', 'toolB']);
    expect(prov.births!.map((b) => b.basis)).toEqual(['whole-value', 'append-verb', 'append-verb', 'append-verb']);
    expect(prov.births!.map((b) => b.value)).toEqual(['m0', 'm1', 'm2', 'm3']);
    expect(prov.births!.map((b) => b.index)).toEqual([0, 1, 2, 3]);
  });

  it('full mode: strict-prefix growth attributes the tail by inference', () => {
    resetSeq();
    const log = [
      bundle('seed', 'set', 'msgs', ['m0']),
      bundle('grow1', 'set', 'msgs', ['m0', 'm1']),
      bundle('grow2', 'set', 'msgs', ['m0', 'm1', 'm2']),
    ];
    const prov = arrayProvenance(log, 'msgs');
    expect(prov.births!.map((b) => b.stageId)).toEqual(['seed', 'grow1', 'grow2']);
    expect(prov.births!.map((b) => b.basis)).toEqual(['whole-value', 'prefix-inference', 'prefix-inference']);
  });

  it('wholesale replacement resets every birth to the replacing commit', () => {
    resetSeq();
    const log = [
      bundle('seed', 'set', 'msgs', ['m0', 'm1']),
      bundle('rewrite', 'set', 'msgs', ['different', 'm1']), // NOT a prefix (elem 0 changed)
    ];
    const prov = arrayProvenance(log, 'msgs');
    expect(prov.births!.map((b) => b.stageId)).toEqual(['rewrite', 'rewrite']);
    expect(prov.births!.map((b) => b.basis)).toEqual(['whole-value', 'whole-value']);
  });

  it('identical re-set keeps the original births (no false rebirth)', () => {
    resetSeq();
    const log = [
      bundle('seed', 'set', 'msgs', ['m0']),
      bundle('noop', 'set', 'msgs', ['m0']), // equal array — strict prefix of itself
    ];
    const prov = arrayProvenance(log, 'msgs');
    expect(prov.births![0].stageId).toBe('seed');
  });

  it('delete clears provenance (honest not-an-array); a later set restarts it', () => {
    resetSeq();
    const log = [
      bundle('seed', 'set', 'msgs', ['m0']),
      bundle('wipe', 'delete', 'msgs', undefined),
      bundle('reseed', 'set', 'msgs', ['n0']),
    ];
    const prov = arrayProvenance(log, 'msgs');
    expect(prov.length).toBe(1);
    expect(prov.births![0].stageId).toBe('reseed');
    // At the wipe point the folded value is not an array — reason says so.
    expect(arrayProvenance(log, 'msgs', { atIdx: 1 }).missing).toBe('not-an-array');
  });

  it('honest absence: scalar key / never-written / empty log each carry their reason', () => {
    resetSeq();
    expect(arrayProvenance([bundle('seed', 'set', 'count', 42)], 'count').missing).toBe('not-an-array');
    expect(arrayProvenance([bundle('a', 'set', 'other', [1])], 'msgs').missing).toBe('never-written');
    expect(arrayProvenance([], 'msgs').missing).toBe('empty-log');
  });

  it('atIdx time-travels: births as of an earlier commit', () => {
    resetSeq();
    const log = [
      bundle('seed', 'set', 'msgs', ['m0']),
      bundle('toolA', 'append', 'msgs', ['m1']),
      bundle('toolB', 'append', 'msgs', ['m2']),
    ];
    const early = arrayProvenance(log, 'msgs', { atIdx: 1 });
    expect(early.length).toBe(2);
    expect(early.births!.map((b) => b.stageId)).toEqual(['seed', 'toolA']);
  });

  it('elementProvenance: single-element convenience + out-of-range honesty', () => {
    resetSeq();
    const log = [bundle('seed', 'set', 'msgs', ['m0']), bundle('toolA', 'append', 'msgs', ['m1'])];
    expect(elementProvenance(log, 'msgs', 1)?.stageId).toBe('toolA');
    expect(elementProvenance(log, 'msgs', 9)).toBeUndefined();
    expect(elementProvenance(log, 'msgs', -1)).toBeUndefined();
  });
});

describe('arrayProvenance — merge verb semantics (unit)', () => {
  // deepSmartMerge on arrays is UNION-dedup (utils.ts:205-221): growth keeps
  // the old prefix; dedup can SHRINK; empty src CLEARS. Each case pinned.

  it('union growth: prev [a,b] + src [b,c] → [a,b,c]; tail attributed by inference', () => {
    resetSeq();
    const log = [bundle('seed', 'set', 'msgs', ['a', 'b']), bundle('grow', 'merge', 'msgs', ['b', 'c'])];
    const prov = arrayProvenance(log, 'msgs');
    expect(prov.births!.map((b) => b.value)).toEqual(['a', 'b', 'c']);
    expect(prov.births!.map((b) => b.stageId)).toEqual(['seed', 'seed', 'grow']);
    expect(prov.births![2].basis).toBe('prefix-inference');
  });

  it('dedup shrink: prev [a,a] + src [b] → [a,b]; wholesale rebirth (not a prefix)', () => {
    resetSeq();
    const log = [bundle('seed', 'set', 'msgs', ['a', 'a']), bundle('dedup', 'merge', 'msgs', ['b'])];
    const prov = arrayProvenance(log, 'msgs');
    expect(prov.births!.map((b) => b.value)).toEqual(['a', 'b']);
    expect(prov.births!.every((b) => b.stageId === 'dedup' && b.basis === 'whole-value')).toBe(true);
    // Parity with the engine fold:
    expect(commitValueAt(log, 1, 'msgs')).toEqual(['a', 'b']);
  });

  it('empty merge src clears the array (deliberate deepSmartMerge rule) → zero births', () => {
    resetSeq();
    const log = [bundle('seed', 'set', 'msgs', ['a']), bundle('clear', 'merge', 'msgs', [])];
    const prov = arrayProvenance(log, 'msgs');
    expect(prov.length).toBe(0);
    expect(prov.births).toEqual([]);
    expect(commitValueAt(log, 1, 'msgs')).toEqual([]);
  });

  it('first-touch merge (no prior value) births everything whole-value', () => {
    resetSeq();
    const log = [bundle('m', 'merge', 'msgs', ['x', 'y'])];
    const prov = arrayProvenance(log, 'msgs');
    expect(prov.births!.every((b) => b.basis === 'whole-value' && b.stageId === 'm')).toBe(true);
  });

  it('object merge degrades the key to non-array → honest not-an-array', () => {
    resetSeq();
    const log = [bundle('seed', 'set', 'msgs', ['a']), bundle('obj', 'merge', 'msgs', { note: 'no longer an array' })];
    expect(arrayProvenance(log, 'msgs').missing).toBe('not-an-array');
  });
});

// ════════════════════════════════════════════════════════════════════════
// PROPERTY — the fold-equivalence invariant, MERGE ARM INCLUDED. For random
// verb sequences over a SMALL value pool (forcing dedup collisions):
// (a) the provenance fold reconstructs the SAME value commitValueAt does;
// (b) births stay index-aligned (births.length === value.length, 0..n-1).
// ════════════════════════════════════════════════════════════════════════

describe('arrayProvenance — property (fold equivalence with commitValueAt)', () => {
  function mulberry32(seed: number) {
    return () => {
      seed |= 0;
      seed = (seed + 0x6d2b79f5) | 0;
      let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  it('holds across 80 random verb sequences (set/append/delete/merge, dedup collisions, random atIdx)', () => {
    for (let run = 0; run < 80; run++) {
      const rand = mulberry32(42 + run);
      resetSeq();
      const log: CommitBundle[] = [];
      const ops = 3 + Math.floor(rand() * 12);
      // SMALL pool → merge's Set-union dedup actually collides.
      const pool = ['a', 'b', 'c', 'd'];
      const pick = () => pool[Math.floor(rand() * pool.length)];
      const arr = (max: number) => Array.from({ length: 1 + Math.floor(rand() * max) }, pick);
      for (let i = 0; i < ops; i++) {
        const roll = rand();
        if (roll < 0.3) log.push(bundle(`st${i}`, 'set', 'k', arr(4)));
        else if (roll < 0.55) log.push(bundle(`ap${i}`, 'append', 'k', arr(3)));
        else if (roll < 0.65) log.push(bundle(`del${i}`, 'delete', 'k', undefined));
        else if (roll < 0.85) log.push(bundle(`mg${i}`, 'merge', 'k', rand() < 0.15 ? [] : arr(3)));
        else log.push(bundle(`mo${i}`, 'merge', 'k', { deg: pick() })); // object degrade
      }
      // Random inclusive anchor — provenance must agree at EVERY point, not just the end.
      const atIdx = Math.floor(rand() * log.length);
      const prov = arrayProvenance(log, 'k', { atIdx });
      const reference = commitValueAt(log, atIdx, 'k');

      if (Array.isArray(reference)) {
        expect(prov.missing, `run ${run} @${atIdx}`).toBeUndefined();
        expect(prov.length).toBe(reference.length);
        expect(prov.births!.length).toBe(reference.length);
        prov.births!.forEach((b, i) => {
          expect(b.index).toBe(i);
          expect(deepEqual(b.value, reference[i]), `run ${run} @${atIdx} elem ${i}`).toBe(true);
        });
      } else {
        expect(prov.missing, `run ${run} @${atIdx}`).toBeDefined();
        expect(prov.births).toBeUndefined();
      }
    }
  });
});

// ════════════════════════════════════════════════════════════════════════
// FUNCTIONAL — the agent mega-key story on a REAL loop chart, both modes.
// ════════════════════════════════════════════════════════════════════════

describe('elementProvenance — functional (loop chart, both commitValues modes)', () => {
  interface S {
    msgs: string[];
    round?: number;
  }

  function loopChart() {
    return flowChart<S>(
      'Seed',
      async (scope) => {
        scope.msgs = ['user-question'];
        scope.round = 0;
      },
      'seed',
    )
      .addFunction(
        'Work',
        async (scope) => {
          scope.round = scope.round! + 1;
          scope.msgs.push(`tool-result-${scope.round}`);
        },
        'work',
      )
      .addDeciderFunction('Check', async (scope) => (scope.round! < 3 ? 'again' : 'done'), 'check')
      .addFunctionBranch(
        'again',
        'Loop',
        async () => {
          /* hop back */
        },
        undefined,
        { loopTo: 'work' },
      )
      .addFunctionBranch('done', 'Finish', async () => {
        /* end */
      })
      .setDefault('done')
      .end()
      .build();
  }

  it.each(['full', 'delta'] as const)('commitValues %s: each msgs element names its birth iteration', async (mode) => {
    const executor = new FlowChartExecutor(loopChart(), { commitValues: mode });
    await executor.run();
    const { commitLog } = executor.getSnapshot();

    const prov = arrayProvenance(commitLog, 'msgs');
    expect(prov.length).toBe(4); // seed + 3 loop rounds
    expect(prov.births![0].stageId).toBe('seed');
    // Every grown element was born in a DISTINCT execution of `work` —
    // this is the mega-key fix: history-style growth resolves per element.
    const workBirths = prov.births!.slice(1);
    expect(workBirths.every((b) => b.stageId === 'work')).toBe(true);
    expect(new Set(workBirths.map((b) => b.runtimeStageId)).size).toBe(3);
    // Honesty labels differ by mode; attribution agrees.
    const expectedBasis = mode === 'delta' ? 'append-verb' : 'prefix-inference';
    expect(workBirths.every((b) => b.basis === expectedBasis)).toBe(true);
  });
});

// ════════════════════════════════════════════════════════════════════════
// INTEGRATION — chained triage: element birth → slice of the birth stage.
// (The exact hop an LLM backtrack tool makes: "who made history[2]?" then
// "and why did THAT stage run / what did it read?")
// ════════════════════════════════════════════════════════════════════════

describe('element → slice chained triage — integration', () => {
  interface S {
    source?: string;
    msgs: string[];
  }

  it('birth.runtimeStageId anchors a sliceForKey follow-up (before: commitIdx + 1)', async () => {
    const chart = flowChart<S>(
      'Seed',
      async (scope) => {
        scope.source = 'db';
        scope.msgs = [];
      },
      'seed',
    )
      .addFunction(
        'Fetch',
        async (scope) => {
          scope.msgs.push(`fetched-from-${scope.source}`);
        },
        'fetch',
      )
      .build();
    const executor = new FlowChartExecutor(chart, { commitValues: 'delta' });
    await executor.run();
    const snapshot = executor.getSnapshot();

    const birth = elementProvenance(snapshot.commitLog, 'msgs', 0)!;
    expect(birth.stageId).toBe('fetch');

    // The documented chained-triage idiom: birth idx is inclusive, `before`
    // is exclusive — +1 makes the birth commit itself the anchor.
    const slice = sliceForKey(
      snapshot.commitLog,
      'msgs',
      keysReadFromExecutionTree(snapshot.executionTree as StageSnapshot),
      { before: birth.commitIdx + 1 },
    );
    expect(slice.writer!.runtimeStageId).toBe(birth.runtimeStageId);
    expect(slice.root!.parents[0]?.runtimeStageId).toMatch(/^seed#/); // fetch read `source`
  });
});

// ════════════════════════════════════════════════════════════════════════
// SECURITY — redacted data stays redacted through the fold, including the
// degraded delta path where redactPatch replaced an append TAIL with the
// '[REDACTED]' string (the same degradation applySmartMerge documents).
// ════════════════════════════════════════════════════════════════════════

describe('arrayProvenance — security (redaction pass-through)', () => {
  it('re-serves the redaction placeholder, never an original', () => {
    resetSeq();
    const log = [bundle('seed', 'set', 'msgs', ['ok']), bundle('secret', 'append', 'msgs', ['[REDACTED]'])];
    log[1].redactedPaths = ['msgs'];
    const prov = arrayProvenance(log, 'msgs');
    expect(prov.births![1].value).toBe('[REDACTED]');
    expect(JSON.stringify(prov)).not.toContain('sk-');
  });

  it('a redacted NON-array append tail degrades exactly like the engine fold (parity)', () => {
    resetSeq();
    const log = [
      bundle('seed', 'set', 'msgs', ['ok']),
      bundle('secret', 'append', 'msgs', '[REDACTED]'), // whole tail replaced by a string
    ];
    log[1].redactedPaths = ['msgs'];
    expect(commitValueAt(log, 1, 'msgs')).toBe('[REDACTED]'); // engine: tail BECOMES the value
    expect(arrayProvenance(log, 'msgs').missing).toBe('not-an-array'); // honest, matching absence
  });
});

// ════════════════════════════════════════════════════════════════════════
// PERFORMANCE + LOAD — post-hoc budgets (CI-safe, generous).
// ════════════════════════════════════════════════════════════════════════

describe('arrayProvenance — performance & load', () => {
  it('perf: 2000 delta appends fold under 300ms (no equality checks on the append path)', () => {
    resetSeq();
    const log: CommitBundle[] = [bundle('seed', 'set', 'msgs', [])];
    for (let i = 0; i < 2000; i++) log.push(bundle(`t${i}`, 'append', 'msgs', [`m${i}`]));
    const t0 = performance.now();
    const prov = arrayProvenance(log, 'msgs');
    expect(prov.length).toBe(2000);
    expect(performance.now() - t0).toBeLessThan(300);
  });

  it('perf: 300-step full-mode prefix growth (quadratic equality checks) under 1s', () => {
    resetSeq();
    const arr: string[] = [];
    const log: CommitBundle[] = [];
    for (let i = 0; i < 300; i++) {
      arr.push(`m${i}`);
      log.push(bundle(`t${i}`, 'set', 'msgs', [...arr]));
    }
    const t0 = performance.now();
    const prov = arrayProvenance(log, 'msgs');
    expect(prov.length).toBe(300);
    expect(prov.births!.every((b, i) => (i === 0 ? b.basis === 'whole-value' : b.basis === 'prefix-inference'))).toBe(
      true,
    );
    expect(performance.now() - t0).toBeLessThan(1000);
  });

  it('load: provenance for 100 distinct array keys over one 1k-commit log under 2s', () => {
    resetSeq();
    const log: CommitBundle[] = [];
    for (let k = 0; k < 100; k++) log.push(bundle(`seed${k}`, 'set', `arr${k}`, [`base${k}`]));
    for (let i = 0; i < 900; i++) log.push(bundle(`t${i}`, 'append', `arr${i % 100}`, [`v${i}`]));
    const t0 = performance.now();
    for (let k = 0; k < 100; k++) {
      expect(arrayProvenance(log, `arr${k}`).length).toBe(10);
    }
    expect(performance.now() - t0).toBeLessThan(2000);
  });
});
