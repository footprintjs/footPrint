/**
 * Pause/Resume — two questions at once
 *
 * A release needs two sign-offs, gathered IN PARALLEL: a legal reviewer and a
 * security reviewer, each its own subflow, both mounted as children of one
 * fork. Both ask a person in the same pass. A Join then decides.
 *
 *     Prepare ─┬─► [ Legal:    Read → Ask (PAUSE) ] ─┬─► Join ──► Ship / Hold
 *              └─► [ Security: Scan → Ask (PAUSE) ] ─┘
 *
 * ## The law this example exercises
 *
 * Only one question can be asked at a time. The first child's pause is the
 * checkpoint's; every other child that paused in the same fan-out rides along
 * in `checkpoint.pendingPauses` — its stage, its question, its captured state.
 * Resuming finishes the first child, then pauses AGAIN with the next
 * sibling's question: nothing of that sibling runs twice, and a sibling that
 * had already finished never runs again. The Join runs ONCE, after the last
 * answer.
 *
 * (Until 9.28.0 the second question was dropped: the Join ran — or on 9.27.0
 * the fan-out re-ran on every resume and never finished.)
 *
 * Every resume here runs on a NEW executor from the checkpoint's JSON bytes —
 * the pattern a service uses when the answers arrive hours apart.
 *
 * Run: npx tsx examples/runtime-features/pause-resume/10-two-questions-at-once.ts
 */

import type { FlowChart, FlowchartCheckpoint } from 'footprintjs';
import { flowChart, FlowChartExecutor, interrupt } from 'footprintjs';

interface ReleaseState {
  version: string;
  legal?: string;
  security?: string;
  decision?: string;
  reads: string[];
  [key: string]: unknown;
}

interface ReviewScope {
  version: string;
  notes?: string;
  verdict?: string;
  [key: string]: unknown;
}

let preparedRuns = 0;

/** A reviewer subflow: looks at the release, then asks a person. */
function reviewer(area: 'legal' | 'security', look: string): FlowChart {
  return flowChart<ReviewScope>(
    look,
    (scope) => {
      scope.notes = `${area} looked at ${scope.version}`;
    },
    'look',
  )
    .addFunction(
      'Ask',
      (scope) => {
        const answer = interrupt<{ verdict: string }>(scope, {
          reason: `${area} sign-off for ${scope.version}?`,
          expects: 'approve | block',
        });
        scope.verdict = `${area}: ${answer.verdict}`;
      },
      'ask',
    )
    .build();
}

const chart = flowChart<ReleaseState>(
  'Prepare',
  (scope) => {
    preparedRuns += 1;
    scope.version = 'v2.4.0';
    scope.reads = [];
  },
  'prepare',
)
  .addSubFlowChart('legal', reviewer('legal', 'Read'), 'Legal', {
    inputMapper: (parent: ReleaseState) => ({ version: parent.version }),
    outputMapper: (sf: ReviewScope) => ({ legal: sf.verdict }),
  })
  .addSubFlowChart('security', reviewer('security', 'Scan'), 'Security', {
    inputMapper: (parent: ReleaseState) => ({ version: parent.version }),
    outputMapper: (sf: ReviewScope) => ({ security: sf.verdict }),
  })
  .addFunction(
    'Join',
    (scope) => {
      const blocked = [scope.legal, scope.security].some((v) => v?.endsWith('block'));
      scope.decision = blocked ? 'hold' : 'ship';
      scope.reads = [...scope.reads, `${scope.legal} + ${scope.security}`];
    },
    'join',
  )
  .build();

(async () => {
  const answers: Record<string, string> = { legal: 'approve', security: 'approve' };

  let executor = new FlowChartExecutor(chart);
  let result: unknown = await executor.run();
  const asked: string[] = [];
  while ((result as { paused?: boolean } | undefined)?.paused) {
    const checkpoint = executor.getCheckpoint() as FlowchartCheckpoint;
    const area = checkpoint.subflowPath[0];
    const waiting = (checkpoint.pendingPauses ?? []).map((p) => p.pausedStageId);
    asked.push(area);
    console.log(
      `paused at ${checkpoint.pausedStageId} — ${(checkpoint.pauseData as { reason: string }).reason}` +
        (waiting.length > 0 ? `  (still waiting: ${waiting.join(', ')})` : ''),
    );

    // Persist, then resume later on a fresh executor.
    const wire = JSON.stringify(checkpoint);
    executor = new FlowChartExecutor(chart);
    result = await executor.resume(JSON.parse(wire) as FlowchartCheckpoint, { verdict: answers[area] });
  }

  const state = executor.getSnapshot().sharedState as unknown as ReleaseState;
  console.log(`\ndecision: ${state.decision} — ${state.reads.join('; ')}`);

  // The run this example promises — checked, so running it is a test.
  const ok =
    JSON.stringify(asked) === JSON.stringify(['legal', 'security']) && // each asked once, in turn
    state.decision === 'ship' &&
    state.reads.length === 1 && // the Join ran ONCE, after both answers
    state.legal === 'legal: approve' &&
    state.security === 'security: approve' &&
    preparedRuns === 1; // Prepare never ran again
  if (!ok) throw new Error(`unexpected run: asked ${JSON.stringify(asked)}, state ${JSON.stringify(state)}`);
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
