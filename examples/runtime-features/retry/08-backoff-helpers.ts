/**
 * retry — backoff helpers: `exponentialBackoff` and `statedWaitFirst`
 *
 * ## Why this exists
 *
 * Every retry loop needs the same few lines: an exponential ceiling, some
 * jitter so a fleet of callers does not retry in step, and — when the server
 * says "retry after 2 s" — that stated wait instead of our own guess. Written by
 * hand in each loop, they drift: a different base here, no jitter there, a
 * `Retry-After` honoured in one loop and ignored in the next.
 *
 * The helpers build the function `RetryPolicy.backoffMs` already takes, so
 * nothing about the policy changes: the runner asks the function once per
 * retry, caps the answer at `maxBackoffMs`, and records the wait it chose
 * (`AttemptRecord.delayMs`, `onStageRetry`'s `delayMs`). The trace explains
 * every wait as it was waited — nothing is redrawn to explain it.
 *
 *   ceiling c = baseDelayMs × multiplier^(n − 1)     (n = the attempt that failed)
 *   'none'  → c      'equal' → c/2 + r·c/2      'full' → r·c      (r = random(), in [0, 1])
 *
 * ## What you get — three parts
 *
 *   1. A stage on an exponential schedule with equal jitter. `random` is
 *      injected (a seeded generator), so the run is exact and repeatable.
 *   2. A stated wait (`retryAfterMs` on the error) wins over the schedule.
 *   3. The same builder outside any chart, on `attempt()`.
 *
 * Run: npx tsx examples/runtime-features/retry/08-backoff-helpers.ts
 */

import {
  attempt,
  type AttemptRecord,
  exponentialBackoff,
  flowChart,
  FlowChartExecutor,
  type RetryPolicy,
  statedWaitFirst,
} from 'footprintjs';

/** A small seeded generator (mulberry32): the same seed draws the same jitter every run. */
function seeded(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

/** A local "rate service": busy (503) for its first `busy` calls, then it answers. */
function rateService(busy: number, statedWaitMs?: number) {
  let calls = 0;
  return () => {
    calls += 1;
    if (calls > busy) return 1.08;
    const error = Object.assign(new Error('rate service busy'), { status: 503 });
    throw statedWaitMs === undefined ? error : Object.assign(error, { retryAfterMs: statedWaitMs });
  };
}

/** The waits a stage's attempts recorded, in order — `undefined` for the attempt that answered. */
async function runStage(name: string, policy: RetryPolicy, busy: () => number) {
  const chart = flowChart(name, () => void busy(), name.toLowerCase().replace(/\s+/g, '-'))
    .retry(policy)
    .build();
  const executor = new FlowChartExecutor(chart);
  const announced: number[] = [];
  executor.attachFlowRecorder({ id: 'retries', onStageRetry: (event) => announced.push(event.delayMs) });
  await executor.run();
  const records = executor.getSnapshot().executionTree.attempts ?? [];
  return { records, announced };
}

const ms = (value: number | undefined) => (value === undefined ? '—' : `${value.toFixed(1)}ms`);

async function main() {
  // ── 1. An exponential schedule with equal jitter, drawn from a seeded source ──
  const random = seeded(7);
  const draws = seeded(7); // the same seed, to say what each wait had to be
  const schedule = await runStage(
    'Fetch rate',
    {
      attempts: 4,
      backoffMs: exponentialBackoff({ baseDelayMs: 20, multiplier: 2, jitter: 'equal', random }),
      maxBackoffMs: 200,
    },
    rateService(3),
  );
  console.log('Fetch rate — exponential, equal jitter, maxBackoffMs 200:');
  for (const record of schedule.records) {
    const ceiling = 20 * 2 ** (record.attempt - 1);
    const line = record.next === 'retry' ? `waited ${ms(record.delayMs)} (ceiling ${ceiling}ms)` : record.next;
    console.log(`  attempt ${record.attempt}: ${record.outcome} → ${line}`);
  }

  // ── 2. A stated wait (retryAfterMs on the error) wins over the schedule ──
  const retryAfterMs = (error: unknown) => (error as { retryAfterMs?: number }).retryAfterMs;
  const stated = await runStage(
    'Fetch quote',
    {
      attempts: 2,
      backoffMs: statedWaitFirst(retryAfterMs, exponentialBackoff({ baseDelayMs: 20 })),
      maxBackoffMs: 200,
    },
    rateService(1, 35),
  );
  console.log(`\nFetch quote — the service said "retry after 35ms": waited ${ms(stated.records[0]?.delayMs)}`);

  // ── 3. The same builder outside any chart, on attempt() ──
  const outside: AttemptRecord[] = [];
  const rates = rateService(1);
  const answer = await attempt(
    () => rates(),
    { attempts: 2, backoffMs: exponentialBackoff({ baseDelayMs: 15 }), maxBackoffMs: 200 },
    { target: 'rates.read', onAttempt: (record) => outside.push(record) },
  );
  console.log(`\nattempt() outside a chart: ${outside.map((r) => `#${r.attempt} ${r.outcome}`).join(', ')} → ${answer}`);

  // ── Assertions (the example is also a test) ──
  const waits = schedule.records.filter((r) => r.next === 'retry').map((r) => r.delayMs ?? -1);
  const expected = [1, 2, 3].map((n) => {
    const c = 20 * 2 ** (n - 1);
    return Math.min(200, c / 2 + (draws() * c) / 2);
  });
  if (schedule.records.map((r) => r.outcome).join() !== 'failed,failed,failed,ok') {
    throw new Error('the stage must fail three times, then answer');
  }
  if (waits.join() !== expected.join() || schedule.announced.join() !== expected.join()) {
    throw new Error(`every wait must be drawn once, recorded and announced as drawn: ${waits} vs ${expected}`);
  }
  if (waits.some((w, i) => w < 10 * 2 ** i || w > 20 * 2 ** i)) throw new Error('a wait left its equal-jitter band');
  if (stated.records[0]?.delayMs !== 35) throw new Error('the stated wait must win over the schedule');
  if (outside.map((r) => `${r.outcome}:${r.delayMs ?? '-'}`).join() !== 'failed:15,ok:-' || answer !== 1.08) {
    throw new Error('attempt() must wait the schedule too');
  }
  console.log('\n  ✓ every wait drawn once, recorded, inside its band; the stated wait won; attempt() agrees');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
