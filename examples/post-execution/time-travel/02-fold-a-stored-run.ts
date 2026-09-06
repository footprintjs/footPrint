/**
 * Time Travel — folding a run you stored on disk
 *
 * A commit log stores DIFFS, so the log alone cannot rebuild a value that was
 * seeded before the run and only merged afterwards. That is why the fold BASE
 * travels with the log: `getSnapshot().initialState`. Ship the two together and
 * an offline consumer — a support tool, a triage agent, a dashboard reading
 * yesterday's traces — reproduces exactly the state each stage saw.
 *
 * `stateAt` says how it got its answer. Hand it a log with no base and it
 * returns `basis: 'log-only'` rather than a quietly partial state.
 *
 * Run: npx tsx examples/post-execution/time-travel/02-fold-a-stored-run.ts
 */

import type { RuntimeSnapshot } from 'footprintjs';
import { flowChart, FlowChartExecutor } from 'footprintjs';
import { commitIndexOf, stateAt } from 'footprintjs/trace';

interface AuditState {
  tenant: { id: string; plan: string };
  events: string[];
  verdict: string;
}

const chart = flowChart<AuditState>('Collect', async (scope) => {
  // `tenant` was SEEDED before the run and is only ever merged here — the
  // classic value a log-only replay loses.
  scope.events = ['collected'];
}, 'collect')
  .addFunction('Decide', async (scope) => {
    scope.verdict = scope.tenant.plan === 'enterprise' ? 'allow' : 'review';
    scope.events = [...scope.events, `verdict:${scope.verdict}`];
  }, 'decide')
  .build();

(async () => {
  const executor = new FlowChartExecutor(chart, {
    initialContext: { tenant: { id: 'T-1', plan: 'enterprise' } },
  } as any);
  await executor.run();

  // Store the run: the log AND its base. This is JSON — no engine required.
  const stored = JSON.parse(
    JSON.stringify({
      initialState: executor.getSnapshot().initialState,
      commitLog: executor.getSnapshot().commitLog,
    }),
  );

  console.log('=== Folded offline, from JSON ===\n');
  const decideIdx = commitIndexOf(stored.commitLog, stored.commitLog[1].runtimeStageId);
  const before = stateAt(stored, decideIdx - 1);
  const after = stateAt(stored, decideIdx);

  console.log(`  before Decide (${before.basis}): ${JSON.stringify(before.state)}`);
  console.log(`  after  Decide (${after.basis}): ${JSON.stringify(after.state)}`);
  // before Decide (initial+log): {"tenant":{"id":"T-1","plan":"enterprise"},"events":["collected"]}
  // after  Decide (initial+log): {..., "verdict":"allow", "events":["collected","verdict:allow"]}

  console.log('\n=== The same log WITHOUT its base ===\n');
  const partial = stateAt({ commitLog: stored.commitLog }, decideIdx);
  console.log(`  basis=${partial.basis}  tenant=${JSON.stringify(partial.state.tenant)}`);
  // basis=log-only  tenant=undefined  ← said out loud, never guessed

  // `initialState` is OPTIONAL BY TYPE — served on every snapshot the engine
  // builds EXCEPT `getSnapshot({ redact: true })`, which omits it because the
  // base is the run's raw pre-run seed and no redaction policy ever touched
  // it. It is never required of a snapshot you build yourself either: a
  // fixture or a stored trace written against 9.16.x still compiles, and
  // still folds (honestly).
  const { initialState: _dropped, ...withoutBase } = executor.getSnapshot();
  const legacyShaped: RuntimeSnapshot = withoutBase;
  console.log(`  a 9.16-shaped snapshot folds as: ${stateAt(legacyShaped, decideIdx).basis}`);
  // a 9.16-shaped snapshot folds as: log-only
})().catch(console.error);
