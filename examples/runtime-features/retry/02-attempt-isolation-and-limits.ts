/**
 * retry — what an attempt is allowed to leave behind, and what stops a retry
 *
 * Two rules decide whether declarative retry is safe to reach for. Both are
 * shown running here.
 *
 * ## Rule 1 — a failed attempt's writes are thrown away
 *
 * A stage that fails halfway has usually written something. If the next
 * attempt could see that half-written state, retrying would be more dangerous
 * than not retrying: attempt 2 would start from the wreckage of attempt 1.
 *
 * So a failed non-final attempt's staged writes are DISCARDED. Nothing was
 * applied, so there is nothing to roll back — footprint stages writes in a
 * buffer and only flushes it on commit, and a discarded attempt simply never
 * commits. The next attempt starts from committed state.
 *
 * The FINAL attempt keeps the shipped law exactly: on success it commits, and
 * on failure it commits what it wrote and then rethrows. Commit-on-error has
 * always been the rule and retry does not change it.
 *
 * ## Rule 2 — `retryOn` decides what is worth retrying
 *
 * A timeout deserves another go. "Card declined" does not — retrying it wastes
 * time and can double-charge. `retryOn` is the gate, and when it declines the
 * stage fails immediately, on the ordinary error path, as if no policy existed.
 *
 * ## The arithmetic, stated once
 *
 *   - exhausted policy → `attempts - 1` retry events, then one error event
 *   - `retryOn` declines → ZERO retry events, then one error event
 *   - success on the first try → zero of either
 *
 * Run: npx tsx examples/runtime-features/retry/02-attempt-isolation-and-limits.ts
 */

import { flowChart, FlowChartExecutor } from 'footprintjs';

const noop = () => undefined;

// ── Part 1: a failed attempt leaves nothing behind ──────────────────────────

interface ImportState {
  rowsSeen: number;
  imported: string;
  [key: string]: unknown;
}

let importCalls = 0;

const importChart = flowChart<ImportState>(
  'Start import',
  (scope) => {
    scope.rowsSeen = 0;
  },
  'start-import',
)
  .addFunction(
    'Import rows',
    (scope) => {
      importCalls += 1;
      // Every attempt starts by reading what the LAST attempt wrote here.
      // Because failed attempts are discarded, this always reads 0.
      console.log(`  attempt ${importCalls} sees rowsSeen = ${scope.rowsSeen}`);
      scope.rowsSeen = 500;
      if (importCalls < 3) throw new Error('connection reset mid-import');
      scope.imported = 'ok';
    },
    'import-rows',
  )
  .retry({ attempts: 3 })
  .build();

// ── Part 2: retryOn separates transient from permanent ─────────────────────

class DeclinedError extends Error {
  readonly permanent = true;
}

interface ChargeState {
  charged: boolean;
  [key: string]: unknown;
}

let chargeCalls = 0;

const chargeChart = flowChart<ChargeState>('Begin', () => undefined, 'begin')
  // The failure below is deliberate; keep the example's output readable by
  // silencing the engine's own error logging.
  .setLogger({ info: noop, log: noop, debug: noop, error: noop, warn: noop })
  .addFunction(
    'Charge card',
    (scope) => {
      chargeCalls += 1;
      if (chargeCalls === 1) throw new Error('gateway timeout'); // worth retrying
      throw new DeclinedError('card declined'); // NOT worth retrying
    },
    'charge-card',
  )
  .retry({
    attempts: 5,
    // Only transient failures get another go. A decline stops here.
    retryOn: (error) => !(error instanceof DeclinedError),
  })
  .build();

// ── Run both ────────────────────────────────────────────────────────────────

async function main() {
  console.log('Part 1 — attempt isolation');
  const importExecutor = new FlowChartExecutor(importChart);
  await importExecutor.run();
  const importState = importExecutor.getSnapshot().sharedState as unknown as ImportState;
  console.log(`  committed rowsSeen: ${importState.rowsSeen} (only the successful attempt's write)`);
  console.log(
    `  commit bundles for 'import-rows': ` +
      `${importExecutor.getSnapshot().commitLog.filter((b) => b.stageId === 'import-rows').length}`,
  );

  console.log('\nPart 2 — retryOn');
  const chargeExecutor = new FlowChartExecutor(chargeChart);
  let retries = 0;
  let errors = 0;
  chargeExecutor.attachFlowRecorder({
    id: 'counters',
    onStageRetry: (event) => {
      retries += 1;
      console.log(`  [retry] attempt ${event.attempt}: ${event.message} — retrying`);
    },
    onError: (event) => {
      errors += 1;
      console.log(`  [error] ${event.message} — not retried`);
    },
  });

  try {
    await chargeExecutor.run();
  } catch (error) {
    console.log(`  run failed with: ${(error as Error).message}`);
  }

  console.log(`\n  the card was charged ${chargeCalls} times (not 5)`);
  console.log(`  retry events: ${retries}, error events: ${errors}`);

  // Commit-on-error: the final attempt's writes still land, exactly as they
  // would for a stage with no policy at all.
  console.log(`  charged flag in state: ${String((chargeExecutor.getSnapshot().sharedState as ChargeState).charged)}`);
}

void main();
