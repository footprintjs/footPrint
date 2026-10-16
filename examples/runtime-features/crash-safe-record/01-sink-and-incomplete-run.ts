/**
 * crash-safe record — a run's record that outlives the run
 *
 * ## Why this exists
 *
 * `getSnapshot()` lives in the process that ran the chart. When that process
 * is killed mid-retry, out of memory, or frozen by a serverless host, the
 * record of the one run you most need to explain dies with it.
 *
 * Give the executor a SINK and every log of the run (the root and each
 * subflow mount) hands it its entries AS THEY LAND: the base it opened with,
 * each commit, a note for each attempt that ended, and how it closed. Read
 * them back with `readStoredRecord` (foottrace) and you get the same log the
 * live snapshot holds — or, for a run that never finished, a log that SAYS
 * it never finished (`complete: false`) and still folds what landed.
 *
 * ## What you get — three parts
 *
 *   1. `fileSink(path)` (Node, `footprintjs/sinks`): one JSON line per entry,
 *      read back with `readRecordFile` → `readStoredRecord`. A finished run is
 *      `complete`, its stored commits equal the live ones.
 *   2. A run still in flight — exactly what a crash would leave behind: no
 *      closing entry, so `complete: false`; the commits that landed; and the
 *      attempts of the stage that never committed, each noted as it ended.
 *      (`test/lib/sinks/scenario/hard-kill.test.ts` does it with a real
 *      SIGKILL.)
 *   3. The redaction policy applies before any entry is written: a secret
 *      in state never reaches the sink.
 *
 * Run: npx tsx examples/runtime-features/crash-safe-record/01-sink-and-incomplete-run.ts
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { flowChart, FlowChartExecutor } from 'footprintjs';
import { fileSink, readRecordFile } from 'footprintjs/sinks';
import { readStoredRecord, stateAt } from 'foottrace';
import { memorySink } from 'foottrace/write';

interface OrderState {
  orderId?: string;
  cardNumber?: string;
  charged?: boolean;
  [key: string]: unknown;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const silent = { info: () => {}, log: () => {}, debug: () => {}, error: () => {}, warn: () => {} };

/** A payment gateway: busy for its first `busyCalls` calls, then answers — or, with `hang`, never answers again. */
function gateway(busyCalls: number, hang = false) {
  let calls = 0;
  return async (signal?: AbortSignal): Promise<void> => {
    calls += 1;
    if (calls <= busyCalls) throw Object.assign(new Error('gateway busy'), { status: 503 });
    if (hang) {
      await new Promise((_resolve, reject) => signal?.addEventListener('abort', () => reject(signal.reason)));
    }
  };
}

function orderChart(charge: (signal?: AbortSignal) => Promise<void>) {
  return flowChart<OrderState>(
    'Receive order',
    (scope) => {
      scope.orderId = 'A-17';
      scope.cardNumber = '4111 1111 1111 1111';
    },
    'receive',
  )
    .addFunction(
      'Charge card',
      async (scope) => {
        await charge(scope.$attempt().signal);
        scope.charged = true;
      },
      'charge',
    )
    .retry({ attempts: 4, backoffMs: 10 })
    .setLogger(silent)
    .build();
}

async function main() {
  const dir = mkdtempSync(join(tmpdir(), 'footprint-record-'));
  try {
    // ── Part 1 — a file sink, a finished run ────────────────────────────────
    const path = join(dir, 'orders.jsonl');
    const sink = fileSink(path);
    const finished = new FlowChartExecutor(orderChart(gateway(1)), { sink });
    finished.setRedactionPolicy({ keys: ['cardNumber'] });
    await finished.run();
    await sink.close();

    const runId = finished.getSnapshot().runId;
    const stored = readStoredRecord(readRecordFile(path).entries).root(runId);
    if (!stored) throw new Error('the run’s root log must be in the file');
    const attempts = stored.notes.filter((n) => n.kind === 'attempt').length;
    console.log(`Part 1 — ${path}`);
    console.log(`  complete: ${stored.complete}, outcome: ${stored.outcome}, commits: ${stored.commitLog.length}`);
    console.log(`  attempt notes: ${attempts}; the sink took ${finished.getSnapshot().sink?.entries} entries`);

    // ── Part 2 — a run still in flight: what a crash leaves ─────────────────
    const inFlight = memorySink();
    const controller = new AbortController();
    const hanging = new FlowChartExecutor(orderChart(gateway(2, true)), { sink: inFlight });
    hanging.setRedactionPolicy({ keys: ['cardNumber'] });
    const running = hanging.run({ signal: controller.signal });
    // Wait until the stage's first two attempts have ended and its third is stuck at the gateway.
    while (inFlight.entries.filter((e) => e.kind === 'note').length < 2) await sleep(5);

    // Read the sink NOW — this is everything a process killed at this instant would have left.
    const crashed = [...readStoredRecord(inFlight.entries).logs.values()][0];
    const noted = crashed.notes.map((n) => (n.data as { record: { attempt: number; outcome: string } }).record);
    console.log('\nPart 2 — a run that never finished');
    console.log(`  complete: ${crashed.complete} (no closing entry), commits landed: ${crashed.commitLog.length}`);
    console.log(`  state from what landed: ${JSON.stringify(stateAt(crashed.source(), 0).state)}`);
    console.log(
      `  attempts of the stage that never committed: ${noted.map((r) => `#${r.attempt} ${r.outcome}`).join(', ')}`,
    );
    controller.abort(new Error('operator stopped the run'));
    await running.catch(() => undefined);

    // ── Part 3 — no secret on disk ──────────────────────────────────────────
    const written = JSON.stringify(readRecordFile(path).entries);
    console.log(`\nPart 3 — the card number on disk: ${written.includes('4111') ? 'PRESENT' : 'absent (REDACTED)'}`);

    // ── Assertions (the example is also a test) ──
    if (!stored.complete || stored.outcome !== 'ok') throw new Error('a finished run must read back complete');
    if (stored.commitLog.length !== finished.getSnapshot().commitLog.length) throw new Error('stored ≠ live commits');
    if (attempts !== 2) throw new Error('a stage that failed once then succeeded leaves two attempt notes');
    if (crashed.complete || crashed.commitLog.length !== 1) throw new Error('an unfinished run must read incomplete');
    if (noted.map((r) => r.outcome).join() !== 'failed,failed') throw new Error('the ended attempts must be noted');
    if (written.includes('4111') || JSON.stringify(inFlight.entries).includes('4111')) {
      throw new Error('a redacted key reached the sink');
    }
    console.log('\n  ✓ the record outlives the run: stored, incomplete when unfinished, never a secret');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
