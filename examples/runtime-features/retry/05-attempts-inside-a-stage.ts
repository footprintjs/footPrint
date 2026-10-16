/**
 * retry — attempts inside a stage: `$call`, `observed()` and `attempt()`
 *
 * ## Why this exists
 *
 * A stage's own retry policy records the STAGE's attempts. But most retries
 * happen one level down: a stage calls a payment API, an LLM, a search index —
 * and the call is where time and failure live. The incident that started this
 * design: the record said "one stage, one error"; the truth was four 40 s
 * attempts inside an SDK.
 *
 * So a call made inside a stage goes through `scope.$call(target, fn, policy?)`.
 * Every attempt — even a single call with no retry — is an `AttemptRecord` of
 * kind `'call'` on the stage's node and on `onAttempt`: when it started, how
 * long it took, how it ended, its failure category, and the retry-or-stop
 * decision. It runs under the stage attempt's time and signal.
 *
 * ## What you get — four parts
 *
 *   1. A single call leaves evidence (`attempts: 1`, the default).
 *   2. A call that retries: every attempt under one series, told in the
 *      narrative line by line.
 *   3. An SDK that retries on its own: the adapter reports each of its
 *      attempts with `observed()` — or, better, turns the SDK's retries off and
 *      lets `$call` run the one loop.
 *   4. The same runner outside any chart: `attempt()`.
 *
 * Run: npx tsx examples/runtime-features/retry/05-attempts-inside-a-stage.ts
 */

import {
  attempt,
  type AttemptContext,
  type AttemptRecord,
  flowChart,
  FlowChartExecutor,
  type TypedScope,
} from 'footprintjs';

/** A local "quote service" that is busy for its first `busy` calls, then answers. */
function quoteService(busy: number) {
  let calls = 0;
  return (signal: AbortSignal): Promise<{ price: number }> => {
    calls += 1;
    if (signal.aborted) return Promise.reject(signal.reason);
    if (calls <= busy) return Promise.reject(Object.assign(new Error('service busy'), { status: 503 }));
    return Promise.resolve({ price: 42 });
  };
}

/**
 * A local "SDK" that retries on its own and tells you about each try through a
 * hook — the shape most SDKs expose (a request/response event, a retry callback).
 */
function makeSdk(options: { maxRetries: number; onTry?: (t: { attempt: number; ok: boolean; ms: number }) => void }) {
  let failuresLeft = 1;
  return async (): Promise<string> => {
    for (let attemptNo = 1; ; attemptNo++) {
      const ok = failuresLeft-- <= 0;
      options.onTry?.({ attempt: attemptNo, ok, ms: 5 });
      if (ok) return 'ch_123';
      if (attemptNo > options.maxRetries) throw Object.assign(new Error('gateway 502'), { status: 502 });
    }
  };
}

interface QuoteState {
  stock?: number;
  quote?: { price: number };
  charge?: string;
  [key: string]: unknown;
}

const lookup = quoteService(0);
const quotes = quoteService(2);

const chart = flowChart<QuoteState>(
  'Check stock',
  async (scope: TypedScope<QuoteState>) => {
    // Part 1 — a single call: no policy, still ONE record.
    const stock = await scope.$call('inventory.lookup', (t: AttemptContext) => lookup(t.signal));
    scope.stock = stock.price;
  },
  'check-stock',
)
  .addFunction(
    'Quote',
    async (scope: TypedScope<QuoteState>) => {
      // Part 2 — a call that retries: busy twice, then answers.
      scope.quote = await scope.$call('quotes.create', (t) => quotes(t.signal), { attempts: 3, backoffMs: 10 });
    },
    'quote',
  )
  .addFunction(
    'Charge',
    async (scope: TypedScope<QuoteState>) => {
      // Part 3 — an SDK that keeps its own retries: report each of them.
      const t = scope.$attempt();
      const sdk = makeSdk({
        maxRetries: 2,
        onTry: (tryInfo) =>
          t.observed({
            target: 'payments',
            attempt: tryInfo.attempt,
            of: 3,
            outcome: tryInfo.ok ? 'ok' : 'failed',
            durationMs: tryInfo.ms,
            ...(!tryInfo.ok && { error: Object.assign(new Error('gateway 502'), { status: 502 }) }),
          }),
      });
      scope.charge = await sdk();
    },
    'charge',
  )
  .build();

async function main() {
  const executor = new FlowChartExecutor(chart);
  executor.enableNarrative();
  await executor.run();

  console.log('The narrative tells every call:');
  for (const line of executor.getNarrativeEntries().filter((e) => e.type === 'attempt')) console.log(`  ${line.text}`);

  const tree = executor.getSnapshot().executionTree;
  const recordsOf = (id: string): readonly AttemptRecord[] => {
    for (let node: typeof tree | undefined = tree; node; node = node.next) if (node.id === id) return node.attempts ?? [];
    return [];
  };
  const stock = recordsOf('check-stock');
  const quote = recordsOf('quote');
  const charge = recordsOf('charge');
  console.log('\nOn the execution tree:');
  for (const r of [...stock, ...quote, ...charge]) {
    console.log(`  ${r.kind.padEnd(8)} ${r.series}  #${r.attempt} ${r.outcome} → ${r.next} (${r.reason})`);
  }

  // Part 4 — the same runner outside any chart. Records go to your callback only.
  const seen: AttemptRecord[] = [];
  const outside = quoteService(1);
  const value = await attempt((t) => outside(t.signal), { attempts: 2 }, {
    target: 'quotes.create',
    series: 'order-77',
    onAttempt: (record) => seen.push(record),
  });
  console.log(`\nattempt() outside a chart: ${seen.map((r) => `#${r.attempt} ${r.outcome}`).join(', ')} → ${value.price}`);

  // ── Assertions (the example is also a test) ──
  if (stock.length !== 1 || stock[0].kind !== 'call' || stock[0].outcome !== 'ok') {
    throw new Error('a single call must leave one record');
  }
  if (quote.map((r) => r.outcome).join() !== 'failed,failed,ok' || new Set(quote.map((r) => r.series)).size !== 1) {
    throw new Error('a retried call must keep every attempt under one series');
  }
  if (quote[0].category !== 'server' || quote[2].next !== 'done') throw new Error('category / decision missing');
  if (charge.map((r) => `${r.kind}:${r.outcome}`).join() !== 'observed:failed,observed:ok') {
    throw new Error('the SDK’s own attempts must be reported as observed');
  }
  if (seen.map((r) => r.outcome).join() !== 'failed,ok' || value.price !== 42) throw new Error('attempt() broke');
  console.log('\n  ✓ every call recorded: single, retried, observed, and outside a chart');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
