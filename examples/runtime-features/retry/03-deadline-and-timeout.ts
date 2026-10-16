/**
 * retry — a time budget the whole run sees
 *
 * ## Why this exists
 *
 * A retry without a clock can run as long as it likes. The incident that
 * started this: a stage that retried an SDK call four times, 40 s each, long
 * past the caller's 120 s budget — and the record said "one stage, one error".
 *
 * So a run has ONE deadline (`run({ deadline })` or `run({ timeoutMs })`),
 * every attempt is capped by the time left, and an attempt may also have its
 * own cap (`retry({ timeoutMs })`). Inside the stage, `scope.$attempt()` hands
 * you the attempt's signal (pass it to `fetch` / your SDK) and the time left.
 *
 * ## What you get — three parts
 *
 *   1. An attempt that outlives its cap TIMES OUT and is retried; the record
 *      says `timeout`, with the cap it ran under.
 *   2. Under a deadline, a retry whose wait would outlast it is never started:
 *      the series stops `no-time-left`, and the narrative says how much time
 *      was left and how long the wait would have been.
 *   3. A lone call with no retry policy still leaves evidence when the
 *      deadline cuts it — one attempt, `timeout`, on its node. And whatever the
 *      abandoned attempt writes afterwards is dropped and recorded
 *      (`lateWrites`), never committed.
 *
 * Run: npx tsx examples/runtime-features/retry/03-deadline-and-timeout.ts
 */

import { type AttemptContext, flowChart, FlowChartExecutor, type TypedScope } from 'footprintjs';

const silent = { info: () => {}, log: () => {}, debug: () => {}, error: () => {}, warn: () => {} };
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** A local "rate service": slow on its first call, quick after — and it stops when the signal says so. */
let rateCalls = 0;
function fetchRate(t: AttemptContext): Promise<number> {
  rateCalls += 1;
  const takes = rateCalls === 1 ? 500 : 10;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => resolve(1.09), takes);
    t.signal.addEventListener('abort', () => {
      clearTimeout(timer);
      reject(t.signal.reason);
    });
  });
}

interface RateState {
  rate?: number;
  [key: string]: unknown;
}

interface ChargeState {
  charged?: boolean;
  [key: string]: unknown;
}

interface ReportState {
  report?: string;
  [key: string]: unknown;
}

// ── Part 1: an attempt cap — the slow first call times out, the retry answers ──

const rateChart = flowChart<RateState>(
  'Fetch rate',
  async (scope: TypedScope<RateState>) => {
    scope.rate = await fetchRate(scope.$attempt());
  },
  'fetch-rate',
)
  .retry({ attempts: 3, timeoutMs: 100, backoffMs: 20 })
  .build();

// ── Part 2: a deadline — a busy gateway, and a wait that would not fit ──────

const chargeChart = flowChart<ChargeState>(
  'Charge card',
  () => {
    // The gateway says when to come back: 2 s. The run has 1 s.
    throw Object.assign(new Error('gateway busy'), { status: 429, retryAfterMs: 2_000 });
  },
  'charge-card',
)
  .setLogger(silent)
  .retry({
    attempts: 4,
    // A stated wait plugs in here — the engine parses nothing.
    backoffMs: (n, error) => (error as { retryAfterMs?: number }).retryAfterMs ?? 100 * n,
  })
  .build();

// ── Part 3: a lone call, no retry policy, cut by the deadline ───────────────

const reportChart = flowChart<ReportState>(
  'Build report',
  async (scope: TypedScope<ReportState>) => {
    // Ignores its signal on purpose: the engine stops WAITING at the deadline,
    // but only the function can stop its own work.
    await sleep(150);
    try {
      scope.report = 'too late';
    } catch {
      // refused: this attempt already ended
    }
  },
  'build-report',
)
  .setLogger(silent)
  .build();

async function main() {
  console.log('Part 1 — an attempt cap');
  const rate = new FlowChartExecutor(rateChart);
  rate.enableNarrative();
  await rate.run();
  const rateNode = rate.getSnapshot().executionTree;
  for (const a of rateNode.attempts ?? []) {
    console.log(`  attempt ${a.attempt}: ${a.outcome} (cap ${a.timeoutMs}ms) → ${a.next} (${a.reason})`);
  }
  console.log(`  rate = ${(rate.getSnapshot().sharedState as RateState).rate}`);

  console.log('\nPart 2 — a deadline');
  const charge = new FlowChartExecutor(chargeChart);
  charge.enableNarrative();
  const started = Date.now();
  await charge.run({ timeoutMs: 1_000 }).catch((error: Error) => console.log(`  run failed: ${error.message}`));
  console.log(`  gave up after ${Date.now() - started}ms — it did not sit out a 2 s wait`);
  for (const line of charge.getNarrativeEntries().filter((e) => e.type === 'attempt')) console.log(`  ${line.text}`);

  console.log('\nPart 3 — a lone call the deadline cut');
  const report = new FlowChartExecutor(reportChart);
  await report.run({ timeoutMs: 50 }).catch((error: Error) => console.log(`  run failed: ${error.message}`));
  await sleep(200); // let the abandoned attempt try its late write
  const reportNode = report.getSnapshot().executionTree;
  const [only] = reportNode.attempts ?? [];
  console.log(`  attempts recorded: ${reportNode.attempts?.length} — ${only?.outcome}, ${only?.reason}`);
  console.log(`  late writes: ${JSON.stringify(reportNode.lateWrites)}`);
  console.log(`  report in state: ${String((report.getSnapshot().sharedState as ReportState).report)}`);
}

void main();
