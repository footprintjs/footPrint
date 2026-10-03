/**
 * Boundary — a key query costs what its answer costs, not a fold per key (F3 review, fix 1).
 *
 * The shape that broke it: commit i writes `cfg␟f{i}`, every 50th commit also merges `cfg`, and stage i reads
 * `cfg␟f{i-1}`; a causal walk from the last commit asks one nested key per stage. Folding the top-level key
 * once per KEY (and scanning the log for its rows) made that walk cubic in the log — N = 1000: 1.3 s,
 * 4000: 92 s. The read model (`memory/logModel.ts`) indexes the log once, folds each top-level key at most
 * once, and needs no verdict at all when no write around the key falls after its last write.
 *
 * The test runs the same shape at N and 4N and asserts the time ratio stays near linear: < 10× for 4× the
 * log (a quadratic walk is 16×, the old cubic one 64×). The minimum of several runs is compared, so machine
 * noise does not fail it; the shape does.
 */
import type { CommitBundle } from '../../../../src';
import { deepFreeze } from '../../../../src/lib/capture/freeze';
import { causalChain, commitValueAt, findLastWriter } from '../../../../src/trace';

const D = '\u001F';

function shape(n: number, frozen: boolean, width = Number.POSITIVE_INFINITY) {
  const log: CommitBundle[] = [];
  const reads = new Map<string, string[]>();
  const field = (i: number) => `f${Number.isFinite(width) ? i % width : i}`;
  for (let i = 0; i < n; i++) {
    const trace: CommitBundle['trace'] = [{ path: `cfg${D}${field(i)}`, verb: 'set' }];
    const updates: Record<string, unknown> = {};
    if (i % 50 === 0) {
      trace.push({ path: 'cfg', verb: 'merge' });
      updates.cfg = { g: i };
    }
    const rid = `s${i}#${i}`;
    log.push({
      idx: i,
      stage: 'S',
      stageId: `s${i}`,
      runtimeStageId: rid,
      trace,
      overwrite: { cfg: { [field(i)]: i } },
      updates,
      redactedPaths: [],
    });
    reads.set(rid, i > 0 ? [`cfg${D}${field(i - 1)}`] : []);
  }
  return { log: frozen ? deepFreeze(log, 'indices') : log, lookup: (id: string) => reads.get(id) ?? [] };
}

/** The fastest of `runs` timings of `work` on a fresh shape of size `n`. */
function fastest(
  n: number,
  frozen: boolean,
  work: (s: ReturnType<typeof shape>) => unknown,
  runs = 6,
  width = Number.POSITIVE_INFINITY,
): number {
  let best = Number.POSITIVE_INFINITY;
  for (let r = 0; r < runs; r++) {
    const s = shape(n, frozen, width);
    const t0 = performance.now();
    work(s);
    best = Math.min(best, performance.now() - t0);
  }
  return best;
}

const walk = (s: ReturnType<typeof shape>) =>
  causalChain(s.log, s.log[s.log.length - 1].runtimeStageId, s.lookup, { maxDepth: 1e6, maxNodes: 1e6 });

describe('a causal walk over nested keys scales near-linearly in the log', () => {
  for (const frozen of [false, true]) {
    it(`${frozen ? 'a frozen (engine) log' : 'a hand-built log'}: N = 2000 vs 8000 stays under 10×`, () => {
      // the walk is real: it reaches the first stage through every nested key
      const small = shape(200, frozen);
      expect(walk(small)).toBeDefined();
      fastest(500, frozen, walk, 1); // warm up
      const n = fastest(2000, frozen, walk);
      const n4 = fastest(8000, frozen, walk);
      expect(n4 / Math.max(n, 1)).toBeLessThan(10);
    }, 60_000);
  }

  // One model per frozen log: 200 single questions build it once and fold the top-level key at most once. The
  // container keeps 100 fields (the mixed bench's shape): a container that grows by one field per commit makes
  // every fold of it — the live commit's included — pay V8's copy of a growing object, which is not this
  // model's cost to remove.
  it('200 single writer and value questions on a frozen log, at 4× the log, stay under 8×', () => {
    const ask = (s: ReturnType<typeof shape>) => {
      const len = s.log.length;
      for (let j = 0; j < 100; j++) findLastWriter(s.log, `cfg${D}f${(len - 2 - j) % 100}`, len - j);
      for (let j = 0; j < 100; j++) commitValueAt(s.log, len - 1 - j, `cfg${D}f${(len - 2 - j) % 100}`);
    };
    fastest(500, true, ask, 1, 100);
    const n = fastest(2000, true, ask, 6, 100);
    const n4 = fastest(8000, true, ask, 6, 100);
    expect(n4 / Math.max(n, 1)).toBeLessThan(10);
  }, 60_000);
});
