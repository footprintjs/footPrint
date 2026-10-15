/**
 * retry — a flaky stage that tries again, and SAYS SO
 *
 * ## Why this exists
 *
 * The obvious way to retry a flaky call is a loop inside the stage function:
 *
 * ```ts
 * for (let i = 0; i < 3; i++) {
 *   try { scope.rate = await fetchRate(); break; } catch { await wait(100); }
 * }
 * ```
 *
 * That works, and it is invisible. The narrative shows one stage. The commit
 * log shows one entry. The two failed calls that happened first left no mark
 * anywhere — so when someone later asks "why did this run take four seconds?",
 * the trace has no answer. In a library whose whole thesis is that nothing
 * invisible happens, that is a hole.
 *
 * Declare the policy instead and every attempt is part of the record.
 *
 * ## What you get
 *
 *   - the stage retries, with the backoff you asked for;
 *   - every attempt is an `AttemptRecord` (10.1) — when it started, how long it
 *     took, how it ended, its failure category, and the retry-or-stop decision
 *     that followed, in the shape `decide()` records. It fires `onAttempt` and
 *     stays on the stage's execution-tree node (`attempts`, `attemptSummary`);
 *   - each failed attempt that is retried also fires `onStageRetry` — which
 *     attempt, how long the wait is, and the structured error that caused it;
 *   - the narrative shows one line per attempt IN ORDER, inside the stage,
 *     between the attempts' own reads and writes.
 *
 * Run: npx tsx examples/runtime-features/retry/01-declare-a-retry.ts
 */

import { flowChart, FlowChartExecutor } from 'footprintjs';

// ── State ───────────────────────────────────────────────────────────────────

interface QuoteState {
  currency: string;
  rate: number;
  quote: string;
  [key: string]: unknown;
}

// ── A rate service that is down for its first two calls ─────────────────────

let serviceCalls = 0;
async function fetchRate(currency: string): Promise<number> {
  serviceCalls += 1;
  if (serviceCalls <= 2) {
    throw new Error(`rate service unavailable (call ${serviceCalls})`);
  }
  return currency === 'EUR' ? 1.09 : 1.0;
}

// ── The chart ───────────────────────────────────────────────────────────────

const chart = flowChart<QuoteState>(
  'Read request',
  (scope) => {
    scope.currency = 'EUR';
  },
  'read-request',
)
  .addFunction(
    'Fetch rate',
    async (scope) => {
      scope.rate = await fetchRate(scope.currency);
    },
    'fetch-rate',
    'Ask the rate service for today’s conversion rate',
  )
  // Up to THREE runs in total — the first plus two retries — waiting 100ms,
  // then 200ms. `attempts` counts total runs, not extra ones.
  .retry({ attempts: 3, backoffMs: (attempt) => 100 * attempt })
  .addFunction(
    'Build quote',
    (scope) => {
      scope.quote = `1 USD = ${scope.rate} ${scope.currency}`;
    },
    'build-quote',
  )
  .build();

// ── Run it ──────────────────────────────────────────────────────────────────

async function main() {
  const executor = new FlowChartExecutor(chart);
  executor.enableNarrative();

  // The evidence channel: one event per attempt, whatever its outcome…
  executor.attachFlowRecorder({
    id: 'attempt-log',
    onAttempt: ({ stageName, record }) => {
      console.log(
        `  [attempt] ${stageName}: ${record.attempt}/${record.of} ${record.outcome} ` +
          `in ${record.durationMs}ms → ${record.next} (${record.reason})`,
      );
    },
    // …and one per failed attempt that is retried, as since 9.15.
    onStageRetry: (event) => {
      console.log(
        `  [retry] ${event.stageName}: attempt ${event.attempt}/${event.maxAttempts} failed ` +
          `(${event.message}) — waiting ${event.delayMs}ms`,
      );
    },
  });

  console.log('Running…');
  await executor.run();

  const state = executor.getSnapshot().sharedState as unknown as QuoteState;
  console.log(`\nResult: ${state.quote}`);
  console.log(`The rate service was called ${serviceCalls} times.`);

  // The narrative tells the same story in plain English, in order.
  console.log('\nNarrative:');
  for (const entry of executor.getNarrativeEntries()) {
    console.log(`${'  '.repeat(entry.depth)}${entry.text}`);
  }

  // ONE commit bundle for the stage, however many attempts ran: attempts are
  // internal to a single stage execution.
  const bundles = executor.getSnapshot().commitLog.filter((b) => b.stageId === 'fetch-rate');
  console.log(`\nCommit bundles for 'fetch-rate': ${bundles.length}`);

  // The attempts themselves live on the stage's execution-tree node, never in
  // the log: every record, and the series at a glance.
  let node = executor.getSnapshot().executionTree;
  while (node.id !== 'fetch-rate' && node.next) node = node.next;
  for (const record of node.attempts ?? []) {
    const decided = record.decision.rules.find((rule) => rule.matched)?.label ?? record.decision.defaultLabel;
    console.log(`  attempt ${record.attempt}: ${record.outcome}, decided "${decided}" → ${record.next}`);
  }
  console.log(`  summary: ${JSON.stringify(node.attemptSummary)}`);
}

void main();
