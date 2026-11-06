// Build a chart, run it, and read why it took a branch.
import { decide, flowChart, FlowChartExecutor } from 'footprintjs';

interface LoanState {
  creditScore: number;
  decision?: string;
}

const chart = flowChart<LoanState>('Intake', (scope) => {
    scope.creditScore = scope.$getArgs<{ score: number }>().score; // input is frozen and untracked; state is tracked
  }, 'intake')
  .addDeciderFunction('Route', (scope) => decide(scope, [
      { when: { creditScore: { gte: 700 } }, then: 'approve', label: 'Good credit' },
    ], { branch: 'review', label: 'No rule fired' }), 'route')
    .addFunctionBranch('approve', 'Approve', (scope) => { scope.decision = 'approved'; })
    .addFunctionBranch('review', 'Review', (scope) => { scope.decision = 'manual review'; })
    .end()
  .build();

const executor = new FlowChartExecutor(chart);
executor.enableNarrative(); // off until you ask, and must come before run()
await executor.run({ input: { score: 640 } });

console.log(executor.getSnapshot().sharedState.decision);
for (const entry of executor.getNarrativeEntries()) console.log('  '.repeat(entry.depth) + entry.text);

// Output:
// manual review
// Stage 1: The process began with Intake.
//   Step 1: Write creditScore = 640
// Stage 2: Next, it moved on to Route.
//   Step 1: Read creditScore = 640
//   [Condition]: No rules matched, fell back to default "No rule fired": Review.
// Stage 3: Next, it moved on to Review.
//   Step 1: Write decision = "manual review"
