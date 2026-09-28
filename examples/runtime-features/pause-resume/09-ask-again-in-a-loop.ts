/**
 * Pause/Resume — asking again, inside a loop
 *
 * A review loop: draft → ask a reviewer → revise and loop, or publish. The
 * reviewer is asked from INSIDE a subflow mounted in the loop body, and that
 * subflow asks AGAIN when an answer is unclear — its decider loops back to the
 * very stage that paused.
 *
 *     Draft ──► [ Review: Check → Ask (PAUSE) → Clear? ─┬─ unclear → loop to Ask ]
 *       ▲                                                └─ clear → exit
 *       │                                    │
 *       └──────── Revise ◄── Route ◄─────────┘ ──► Publish
 *
 * ## The law this example exercises
 *
 * A resume re-enters the chart ONCE, then the run belongs to the chart as
 * built. So after a resume:
 *
 *   - a loop back to the stage that paused reaches THE STAGE — it pauses and
 *     asks again (it does not replay the resume half);
 *   - a loop whose head sits outside the paused subflow reaches that head;
 *   - the next pass through the Review mount is a FRESH entry — its
 *     inputMapper runs with the new draft, its first stage runs, and nothing
 *     from the earlier checkpoint leaks into it.
 *
 * (Until 9.27.1 the first two ended the run early or never asked again.)
 *
 * Every resume here runs on a NEW executor from the checkpoint's JSON bytes —
 * the pattern a service uses when the answer arrives hours later.
 *
 * Run: npx tsx examples/runtime-features/pause-resume/09-ask-again-in-a-loop.ts
 */

import type { FlowchartCheckpoint } from 'footprintjs';
import { flowChart, FlowChartExecutor } from 'footprintjs';
import { ArrayMergeMode } from 'footprintjs/advanced';

interface ReviewState {
  version: number;
  draft: string;
  verdict?: 'approve' | 'revise';
  story: string[];
  published?: string;
  [key: string]: unknown;
}

interface ReviewScope {
  draft: string;
  priorStory: string[];
  story?: string[];
  answer?: string;
  [key: string]: unknown;
}

// ── The Review subflow: asks until the answer is clear ─────────────────────
const review = flowChart<ReviewScope>(
  'Check',
  (scope) => {
    scope.story = [...scope.priorStory, `check "${scope.draft}"`];
  },
  'check',
)
  .addPausableFunction(
    'Ask reviewer',
    {
      execute: (scope) => {
        scope.story = [...(scope.story ?? []), 'ask the reviewer'];
        return { question: `Approve "${scope.draft}"? (approve / revise)` };
      },
      resume: (scope, input) => {
        const answer = (input as { answer: string }).answer;
        scope.answer = answer;
        scope.story = [...(scope.story ?? []), `reviewer said "${answer}"`];
      },
    },
    'ask',
  )
  .addDeciderFunction(
    'Clear?',
    (scope) => (scope.answer === 'approve' || scope.answer === 'revise' ? 'clear' : 'unclear'),
    'is-clear',
  )
  // An unclear answer loops back to the stage that PAUSED — which asks again.
  .addFunctionBranch('unclear', 'Unclear', () => undefined, 'ask again', { loopTo: 'ask' })
  .addFunctionBranch('clear', 'Clear', () => undefined)
  .end()
  .build();

// ── The loop ────────────────────────────────────────────────────────────────
const chart = flowChart<ReviewState>(
  'Start',
  (scope) => {
    scope.version = 0;
    scope.story = [];
  },
  'start',
)
  .addFunction(
    'Draft',
    (scope) => {
      scope.version += 1;
      scope.draft = `release notes v${scope.version}`;
      scope.story = [...scope.story, `draft v${scope.version}`];
    },
    'draft',
  )
  .addSubFlowChartNext('review', review, 'Review', {
    inputMapper: (parent: ReviewState) => ({ draft: parent.draft, priorStory: parent.story }),
    outputMapper: (sf: ReviewScope) => ({ story: sf.story, verdict: sf.answer }),
    arrayMerge: ArrayMergeMode.Replace,
  })
  .addDeciderFunction('Route', (scope) => (scope.verdict === 'approve' ? 'publish' : 'revise'), 'route')
  .addFunctionBranch(
    'revise',
    'Revise',
    (scope) => {
      scope.story = [...scope.story, 'revise'];
    },
    'revise',
    { loopTo: 'draft' },
  )
  .addFunctionBranch('publish', 'Publish', (scope) => {
    scope.published = scope.draft;
    scope.story = [...scope.story, `publish v${scope.version}`];
  })
  .end()
  .build();

(async () => {
  // The reviewer's answers, in the order the questions arrive.
  const answers = ['hmm?', 'revise', 'approve'];

  let executor = new FlowChartExecutor(chart);
  let result: unknown = await executor.run();
  let asked = 0;
  while ((result as { paused?: boolean } | undefined)?.paused) {
    const checkpoint = executor.getCheckpoint() as FlowchartCheckpoint;
    const question = (checkpoint.pauseData as { question: string }).question;
    const answer = answers[asked++];
    console.log(`paused at ${checkpoint.pausedStageId} — ${question} → "${answer}"`);

    // Persist, then resume later on a fresh executor.
    const wire = JSON.stringify(checkpoint);
    executor = new FlowChartExecutor(chart);
    result = await executor.resume(JSON.parse(wire) as FlowchartCheckpoint, { answer });
  }

  const state = executor.getSnapshot().sharedState as unknown as ReviewState;
  console.log('\nstory:');
  for (const line of state.story) console.log(`  - ${line}`);

  // The run this example promises — checked, so running it is a test.
  const expected = [
    'draft v1',
    'check "release notes v1"',
    'ask the reviewer',
    'reviewer said "hmm?"',
    'ask the reviewer', // asked AGAIN: the loop reached the stage that paused
    'reviewer said "revise"',
    'revise',
    'draft v2', // the loop after the resume reached its head outside the subflow
    'check "release notes v2"', // a FRESH entry: the inputMapper ran with v2
    'ask the reviewer',
    'reviewer said "approve"',
    'publish v2',
  ];
  if (asked !== 3 || JSON.stringify(state.story) !== JSON.stringify(expected)) {
    throw new Error(`unexpected run: asked ${asked} times, story ${JSON.stringify(state.story)}`);
  }
  console.log(`\nasked ${asked} times; published "${state.published}"`);
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
