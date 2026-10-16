/**
 * Every built-in recorder accounts for attempts (10.1).
 *
 * ## Why this exists
 *
 * A retried stage used to look like one quiet step to every recorder but the
 * narrative: the Topology graph had no node for it, a subflow's boundary pair
 * said nothing about what it cost to get through, and a stage that gave up was
 * a bare error. Each built-in recorder now reads the same `onAttempt` records
 * and keeps the part it is about:
 *
 *   - Topology: an `attempt-series` node, with its `attemptSummary`;
 *   - InOut: an exit boundary's `attempts` count and `failedAttempts`;
 *   - Quality: a series that gave up is a drop (`drop: 'attempts'`);
 *   - Debug: one `attempt` row per attempt, an `attemptStop` row on giving up;
 *   - Manifest: the series' summary on its subflow entry;
 *   - ControlDep: the stop as an `attempt-stop` decision;
 *   - Metrics: `attempts`, and a duration over every attempt.
 *
 * One predicate decides what counts: a series that RETRIED, GAVE UP or TIMED OUT. A policy
 * stage that succeeded first time adds nothing, so a run in which nothing
 * retried reads exactly as it did before.
 *
 * Attempts arrive on the FLOW channel: attach recorders that also listen to
 * the scope channel (Quality, Debug) with `attachCombinedRecorder`.
 *
 * Run: npx tsx examples/recorders/06-attempts-in-every-recorder.ts
 */

import { flowChart, FlowChartExecutor } from 'footprintjs';
import { debug, manifest, metrics } from 'footprintjs/recorders';
import { controlDepRecorder, inOutRecorder, QualityRecorder, topologyRecorder } from 'footprintjs/trace';

type State = Record<string, unknown>;

let rateCalls = 0;
const payment = flowChart<State>(
  'Charge card',
  (scope) => {
    rateCalls += 1;
    if (rateCalls === 1) throw Object.assign(new Error('gateway timeout'), { status: 504 });
    scope.charged = true;
  },
  'charge',
)
  .retry({ attempts: 3 })
  .build();

const chart = flowChart<State>(
  'Read order',
  (scope) => {
    scope.orderId = 'o-1';
  },
  'read-order',
)
  .addSubFlowChartNext('sf-payment', payment, 'Payment')
  .addListOfFunction([
    {
      id: 'ledger',
      name: 'Post to ledger',
      fn: () => {
        throw Object.assign(new Error('ledger rejected the entry'), { status: 422 });
      },
      // A 4xx will not get better by trying again: decline it.
      retry: { attempts: 3, retryOn: (e) => (e as { status?: number }).status !== 422 },
    },
    { id: 'email', name: 'Email receipt', fn: () => undefined },
  ])
  .build();

async function main() {
  const executor = new FlowChartExecutor(chart);
  const topology = topologyRecorder();
  const inOut = inOutRecorder();
  const quality = new QualityRecorder(() => ({ score: 1 }));
  const debugLog = debug({ verbosity: 'minimal' });
  const subflows = manifest();
  const control = controlDepRecorder();
  const timing = metrics();
  for (const recorder of [topology, inOut, quality, debugLog, subflows, control, timing]) {
    executor.attachCombinedRecorder(recorder);
  }
  await executor.run();

  const series = topology.getByKind('attempt-series');
  console.log('Topology:', series.map((n) => `${n.name} ×${n.attemptSummary?.count} → ${n.attemptSummary?.last.reason}`));
  console.log('InOut, payment exit:', inOut.getBoundaries().find((b) => b.phase === 'exit' && !b.isRoot)?.attempts);
  console.log('Quality drop:', quality.values().filter((e) => e.drop === 'attempts').map((e) => e.factors));
  console.log('Debug:', debugLog.getEntries().filter((e) => e.type.startsWith('attempt')).length, 'attempt rows');
  console.log('Manifest:', subflows.getManifest()[0]?.attempts?.map((r) => r.attempts.count));
  console.log('ControlDep:', control.getDecisions().filter((d) => d.kind === 'attempt-stop').map((d) => d.ruleLabel));
  console.log('Metrics:', timing.values().filter((m) => m.attempts !== undefined).map((m) => m.attempts));

  if (series.length !== 2 || quality.values().every((e) => e.drop === undefined)) {
    throw new Error('expected two attempt series and one quality drop');
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
