/**
 * Performance + load guards for delta commit detection (#13c-B).
 *
 * Perf tier — the honest cost note from the design memo, pinned:
 *   - Append DETECTION is new wall work: an O(|base|) structural prefix
 *     compare per array-set path per commit. On a HIT the commit gets
 *     cheaper in both wall and heap (the full-array clone shrinks to a
 *     tail clone). On a MISS (prefix diverges at the last element — the
 *     worst case) the commit pays compare + full clone, bounded by a small
 *     multiple of the full-mode commit. Thresholds are deliberately loose
 *     (regression guards against accidental O(n²), NOT micro-benchmarks).
 *   - The default 'full' mode pays ZERO: detection is mode-gated.
 *
 * Load tier — the retained-payload linearity that kills the quadratic:
 *   running the growing-history loop, the delta commit log's VALUE bytes
 *   grow linearly (one tail per iteration) while full mode's grow
 *   quadratically; at N iterations delta is a small fraction of full.
 */
import { flowChart, FlowChartExecutor } from '../../../../src';
import { TransactionBuffer } from '../../../../src/lib/memory/TransactionBuffer';

type Loose = Record<string, unknown>;

function bigArray(n: number): Array<{ id: number; text: string }> {
  return Array.from({ length: n }, (_, i) => ({ id: i, text: `message-${i}-${'x'.repeat(40)}` }));
}

describe('Boundary: delta commit performance (#13c-B)', () => {
  it('append HIT on a 10k-element array commits under budget and clones only the tail', () => {
    const base = { history: bigArray(10_000) };
    const buf = new TransactionBuffer(base, 'delta');
    buf.set(['history'], [...buf.get(['history']), { id: 10_000, text: 'new' }]);

    const start = performance.now();
    const bundle = buf.commit();
    const elapsed = performance.now() - start;

    expect(bundle.trace).toEqual([{ path: 'history', verb: 'append' }]);
    expect(bundle.overwrite.history).toHaveLength(1);
    expect(elapsed).toBeLessThan(500); // generous; typical is single-digit ms
  });

  it('append MISS (prefix diverges at the LAST element) stays within a bounded multiple of the full-mode commit', () => {
    const N = 10_000;
    const makeBase = () => ({ history: bigArray(N) });
    const diverged = () => {
      const arr = bigArray(N + 1);
      arr[N - 1] = { id: -1, text: 'diverged' }; // worst case: compare walks the whole prefix, then fails
      return arr;
    };

    // full-mode reference
    const fullBuf = new TransactionBuffer(makeBase(), 'full');
    fullBuf.set(['history'], diverged());
    const t0 = performance.now();
    fullBuf.commit();
    const fullMs = performance.now() - t0;

    // delta-mode worst case
    const deltaBuf = new TransactionBuffer(makeBase(), 'delta');
    deltaBuf.set(['history'], diverged());
    const t1 = performance.now();
    const bundle = deltaBuf.commit();
    const deltaMs = performance.now() - t1;

    expect(bundle.trace).toEqual([{ path: 'history', verb: 'set' }]); // lossless fallback
    expect(bundle.overwrite.history).toHaveLength(N + 1); // full value
    // Bounded: compare + clone vs clone. Generous multiple + absolute floor
    // to stay green under CI contention and sub-ms full-mode timings.
    expect(deltaMs).toBeLessThan(Math.max(fullMs * 10, 100));
  });

  it("the default 'full' mode never enters the detection branch (verbs stay set/merge)", () => {
    const buf = new TransactionBuffer({ history: [1, 2] }, 'full');
    buf.set(['history'], [1, 2, 3]);
    const bundle = buf.commit();
    expect(bundle.trace.every((t) => t.verb === 'set' || t.verb === 'merge')).toBe(true);
    expect(bundle.overwrite.history).toEqual([1, 2, 3]);
  });

  it('LOAD: over a growing-history loop, delta commit-log value bytes are a small fraction of full (linear vs quadratic)', async () => {
    const ITERATIONS = 60; // enough for the quadratic to dominate, fast enough for CI
    const buildChart = () =>
      flowChart<Loose>(
        'Seed',
        async (scope) => {
          scope.$setValue('i', 0);
          scope.$setValue('history', [] as unknown[]);
        },
        'seed',
      )
        .addFunction(
          'Work',
          async (scope) => {
            const i = scope.$getValue('i') as number;
            scope.$batchArray('history', (arr) => {
              arr.push({ idx: i, text: `message-${i}-${'x'.repeat(64)}` });
            });
            scope.$setValue('i', i + 1);
            if (i + 1 >= ITERATIONS) scope.$break();
          },
          'work',
        )
        .loopTo('work')
        .build();

    const logBytes = async (commitValues: 'full' | 'delta') => {
      const executor = new FlowChartExecutor(buildChart(), { commitValues });
      await executor.run({ maxIterations: ITERATIONS + 10 });
      const log = executor.getSnapshot().commitLog;
      let bytes = 0;
      for (const b of log)
        bytes += (JSON.stringify(b.overwrite) ?? '').length + (JSON.stringify(b.updates) ?? '').length;
      return { bytes, commits: log.length };
    };

    const full = await logBytes('full');
    const delta = await logBytes('delta');

    expect(delta.commits).toBe(full.commits); // cadence unchanged
    // Full retains Σi O(i) history copies; delta retains one ~100-byte tail
    // per iteration. At N=60 the ratio is ~N/2 ≈ 30× — assert a conservative 5×.
    expect(delta.bytes * 5).toBeLessThan(full.bytes);
  });
});
