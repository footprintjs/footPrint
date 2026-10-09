/**
 * key-queries — what a key query costs on a log written through nested rows (F3, 9.33.0).
 *
 * Why it exists: F3 made every key query see rows INSIDE and AROUND a key (the writer and value rules,
 * `src/lib/memory/keyPaths.ts`). Applied naively — a scan of the log and a fold of the top-level key per KEY —
 * a causal walk over nested keys was cubic in the log (review of PR #18: N = 1000 → 1.3 s, 4000 → 92 s). The
 * read model (`src/lib/memory/logModel.ts`) indexes the log once, folds a top-level key at most once, and asks
 * for a verdict only when a write around the key falls after its last write. This bench is the instrument:
 *
 *   SCALING  commit i writes `cfg␟f{i}`, every 50th commit also merges `cfg`, stage i reads `cfg␟f{i-1}`; one
 *            `causalChain` from the last commit, at N = 1k, 2k, 4k, 8k. Near-linear: each doubling ≈ 2×.
 *   SINGLE   100 `findLastWriter` + 100 `commitValueAt` of nested keys on a FROZEN log (an engine log — its read
 *            model is memoised on it), N = 2.5k and 10k, a 100-field container; then 100 `commitValueAt` of the
 *            container itself — an OBJECT answer, which the memo hands out as a detached copy since 9.44.2
 *            (`logModel · valueAt`): this column is that copy's cost.
 *
 * Run:  npx tsx bench/key-queries.ts
 */

export {}; // a module, so these names stay out of the bench folder's script scope

type Bundle = {
  idx: number;
  stage: string;
  stageId: string;
  runtimeStageId: string;
  trace: Array<{ path: string; verb: string }>;
  overwrite: Record<string, unknown>;
  updates: Record<string, unknown>;
  redactedPaths: string[];
};

const D = '\u001F';

function build(n: number, width = Number.POSITIVE_INFINITY) {
  const log: Bundle[] = [];
  const reads = new Map<string, string[]>();
  const field = (i: number) => `f${Number.isFinite(width) ? i % width : i}`;
  for (let i = 0; i < n; i++) {
    const trace = [{ path: `cfg${D}${field(i)}`, verb: 'set' }];
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
  return { log, lookup: (id: string) => reads.get(id) ?? [] };
}

async function main() {
  const trace = (await import('foottrace')) as any;
  const { deepFreeze } = (await import('foottrace/write')) as any;
  const time = (f: () => unknown) => {
    const t0 = performance.now();
    f();
    return performance.now() - t0;
  };

  console.log('key-queries [src]');
  console.log('SCALING — causalChain over nested keys (fastest of 3)');
  let previous = 0;
  for (const n of [1000, 2000, 4000, 8000]) {
    let best = Number.POSITIVE_INFINITY;
    for (let r = 0; r < 3; r++) {
      const { log, lookup } = build(n);
      best = Math.min(
        best,
        time(() => trace.causalChain(log, log[n - 1].runtimeStageId, lookup, { maxDepth: 1e6, maxNodes: 1e6 })),
      );
    }
    console.log(
      `  N=${String(n).padStart(5)}  ${best.toFixed(1).padStart(8)} ms${
        previous ? `   ×${(best / previous).toFixed(1)} for ×2` : ''
      }`,
    );
    previous = best;
  }

  console.log(
    'SINGLE — 100 findLastWriter + 100 commitValueAt of nested keys, then of the container, on a frozen log (100 fields)',
  );
  for (const n of [2500, 10000]) {
    const { log } = build(n, 100);
    deepFreeze(log, 'indices');
    Object.freeze(log);
    const w = time(() => {
      for (let j = 0; j < 100; j++) trace.findLastWriter(log, `cfg${D}f${(n - 2 - j) % 100}`, n - j);
    });
    const v = time(() => {
      for (let j = 0; j < 100; j++) trace.commitValueAt(log, n - 1 - j, `cfg${D}f${(n - 2 - j) % 100}`);
    });
    const c = time(() => {
      for (let j = 0; j < 100; j++) trace.commitValueAt(log, n - 1 - j, 'cfg');
    });
    console.log(
      `  N=${String(n).padStart(5)}  findLastWriter ×100 ${w.toFixed(1).padStart(7)} ms   commitValueAt ×100 ${v
        .toFixed(1)
        .padStart(7)} ms   container ×100 ${c.toFixed(1).padStart(7)} ms`,
    );
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
