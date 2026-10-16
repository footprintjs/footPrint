/**
 * budget — a time budget checked before the chart ever runs
 *
 * ## Why this exists
 *
 * The incident behind it: a stage retried an SDK call four times, 40 s each,
 * past a caller who gave the whole request 120 s — and the record said "one
 * stage, one error". Both numbers were DECLARED: the retry policy on the stage,
 * and the caller's budget. So the library checks one against the other while
 * you build the chart, not in production.
 *
 * ## What you get — three parts
 *
 *   1. `.budget(ms)` on the chart: `build()` REFUSES a chart whose declared
 *      policies already allow longer — `attempts × timeoutMs` plus the waits
 *      between attempts, summed along the slowest path — and says which stages
 *      make it slow. A function backoff is counted at its declared ceiling
 *      (`maxBackoffMs`, which the runner enforces) — never by calling it.

 *   2. `timeBudget(chart)` reports the worst case, the slowest path, and every
 *      stage it cannot bound (no `timeoutMs`, a loop, a lazy subflow, a
 *      parallelForEach) — named, never guessed at.
 *   3. A loop is never iterated: tell the check how many passes you allow
 *      (`assume: { loops: { [targetId]: n } }`) and it counts each stage of
 *      the loop that many times.
 *
 * Run: npx tsx examples/build-time-features/budget/01-time-budget.ts
 */

import { flowChart, timeBudget, type TypedScope } from 'footprintjs';

interface QuoteState {
  quote?: number;
  charged?: boolean;
  answer?: string;
  route?: 'again' | 'done';
  [key: string]: unknown;
}

// Local stand-ins: nothing here calls a real service.
const read = (scope: TypedScope<QuoteState>) => {
  scope.quote = 42;
};
const charge = (scope: TypedScope<QuoteState>) => {
  scope.charged = true;
};

// ── Part 1: the worked example — refused at build ───────────────────────────

function partOne(): string {
  try {
    flowChart<QuoteState>('Read quote', read, 'read', { retry: { attempts: 1, timeoutMs: 5_000 } })
      .addFunction('Charge card', charge, 'charge')
      .retry({ attempts: 4, timeoutMs: 40_000, backoffMs: 1_000 }) // 4 × 40 s + 3 × 1 s = 163 s
      .budget(120_000) // the caller's contract: 120 s
      .build();
    return 'built';
  } catch (error) {
    return (error as Error).message;
  }
}

// ── Part 2: a chart that keeps its budget, and what the report says ─────────

const kept = flowChart<QuoteState>('Read quote', read, 'read', { retry: { attempts: 1, timeoutMs: 5_000 } })
  .addFunction('Charge card', charge, 'charge')
  // 3 × 20 s + two waits of at most 2 s: the ceiling is what the check counts, and what the runner enforces
  .retry({ attempts: 3, timeoutMs: 20_000, backoffMs: (n) => 1_000 * n, maxBackoffMs: 2_000 })
  .addFunction('Notify', () => undefined, 'notify') // no timeoutMs: unbounded, named
  .budget(120_000)
  .build();

// ── Part 3: a loop, bounded by an assumption ────────────────────────────────

const agent = flowChart<QuoteState>('Ask', () => undefined, 'ask', { retry: { attempts: 2, timeoutMs: 10_000 } })
  .addDeciderFunction('Route', (scope: TypedScope<QuoteState>) => scope.route ?? 'done', 'route', undefined, {
    retry: { attempts: 1, timeoutMs: 100 },
  })
  .addFunctionBranch('again', 'Ask again', () => undefined, undefined, {
    loopTo: 'ask',
    retry: { attempts: 1, timeoutMs: 100 },
  })
  .addFunctionBranch('done', 'Answer', () => undefined, undefined, { retry: { attempts: 1, timeoutMs: 100 } })
  .end()
  .build();

function main() {
  console.log('Part 1 — refused at build');
  const refusal = partOne();
  console.log(`  ${refusal}`);

  console.log('\nPart 2 — a budget the chart keeps');
  const report = kept.timeBudget();
  console.log(`  worst case: ${report.worstCaseMs ?? 'unbounded'}; known part: ${report.knownMs} ms of ${report.budgetMs} ms`);
  for (const step of report.criticalPath) {
    console.log(`  ${step.stageId}: ${step.attempts} × ${step.timeoutMs ?? '∞'} ms + ${step.backoffMs} ms waits`);
  }
  console.log(`  not bounded: ${report.unbounded.map((u) => `${u.stageId} (${u.why})`).join(', ')}`);

  console.log('\nPart 3 — a loop, never iterated');
  const open = timeBudget(agent);
  const assumed = timeBudget(agent, { assume: { loops: { ask: 3 } }, budgetMs: 60_000 });
  console.log(`  no assumption: ${open.unbounded.map((u) => `${u.stageId} (${u.why})`).join(', ')}`);
  console.log(`  3 passes: worst case ${assumed.worstCaseMs} ms, over a 60 s budget: ${assumed.over}`);

  // ── Assertions (the example is also a test) ──
  if (!refusal.includes('its declared policies allow 168000 ms, over its budget by 48000 ms')) {
    throw new Error('not refused');
  }
  if (!refusal.includes('charge: 4 × 40000 ms + 3000 ms of waits = 163000 ms')) throw new Error('slow stage not named');
  if (report.worstCaseMs !== null || report.knownMs !== 69_000 || report.over) throw new Error('bad report');
  if (report.unbounded.length !== 1 || report.unbounded[0].stageId !== 'notify') throw new Error('notify not named');
  if (open.worstCaseMs !== null || open.unbounded[0]?.why !== 'loop') throw new Error('the loop was iterated');
  // 3 × (ask 20 000 + route 100 + the slower branch 100)
  if (assumed.worstCaseMs !== 60_600 || !assumed.over) throw new Error('bad loop bound');
  console.log('\n  ✓ refused at build, reported, and bounded by an assumption');
}

try {
  main();
} catch (error) {
  console.error(error);
  process.exit(1);
}
