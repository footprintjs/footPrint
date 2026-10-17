/**
 * C2: inspect already collected stage attention without a model or provider call.
 * Run: npx tsx examples/runtime-features/attention/01-stage-attention.ts
 */
import { flowChart, FlowChartExecutor } from 'footprintjs';
import type { StageSnapshot } from 'footprintjs/advanced';
import type { Attention } from 'foottrace';
import { buildAttemptId, parseAttemptId } from 'foottrace';

function check(value: unknown, message: string): asserts value {
  if (!value) throw new Error(message);
}

/** Resolve references only under the snapshot that owns the mark. */
function checkProof(stage: StageSnapshot, mark: Attention): void {
  for (const ref of mark.evidence) {
    const parsed = parseAttemptId(ref);
    if (parsed) {
      check(ref === buildAttemptId(parsed.runtimeStageId, parsed.attempt, parsed.call), 'noncanonical attempt proof');
      check(parsed.runtimeStageId === stage.runtimeStageId, 'attempt proof belongs to another execution');
      check(
        stage.attempts?.some((entry) => entry.series + '@' + entry.attempt === ref),
        'attention cited an attempt that was not retained',
      );
    } else if (ref === 'attemptSummary') check(stage.attemptSummary, 'missing summary evidence');
    else if (ref === 'errors:stageExecutionError') {
      check(Object.hasOwn(stage.errors, 'stageExecutionError'), 'missing stage-error evidence');
    } else if (ref === 'attemptsDropped') check((stage.attemptsDropped ?? 0) > 0, 'missing omission evidence');
    else throw new Error('unsupported scoped evidence reference');
  }
}

async function main(): Promise<void> {
  let calls = 0;
  const chart = flowChart<{ started?: boolean; available?: boolean; finished?: boolean }>(
    'Start',
    (scope) => {
      scope.started = true;
    },
    'start',
  )
    .addFunction(
      'Read inventory',
      (scope) => {
        if (++calls === 1) throw new Error('synthetic transient failure');
        scope.available = true;
      },
      'inventory',
    )
    .retry({ attempts: 2 })
    .addFunction(
      'Finish',
      (scope) => {
        scope.finished = true;
      },
      'finish',
    )
    .build();
  const executor = new FlowChartExecutor(chart);
  await executor.run();

  const snapshot = executor.getSnapshot();
  const start = snapshot.executionTree;
  const inventory = start.next;
  const finish = inventory?.next;
  check(start.id === 'start' && inventory?.id === 'inventory' && finish?.id === 'finish', 'missing executed stage');
  check(!Object.hasOwn(start, 'attention'), 'healthy start unexpectedly has attention');
  check(!Object.hasOwn(finish, 'attention'), 'healthy finish unexpectedly has attention');
  const retry = inventory.attention?.find((mark) => mark.kind === 'retried');
  check(retry?.reason === 'RETRY_RECORDED' && retry.evidence.length > 0, 'recovered retry has no recorded proof');
  for (const mark of inventory.attention ?? []) checkProof(inventory, mark);
  const citedAttempt = retry.evidence.find((ref) => parseAttemptId(ref) !== undefined);
  check(citedAttempt, 'retry has no retained-attempt reference');
  const attempt = inventory.attempts?.find((entry) => entry.series + '@' + entry.attempt === citedAttempt);
  check(attempt?.next === 'retry', 'retry reference does not point to its actual recorded decision');
  check(!inventory.attention?.some((mark) => mark.kind === 'gave-up'), 'recovery was mislabeled as exhaustion');
  check(snapshot.sharedState.finished === true && calls === 2, 'unexpected flow outcome');

  console.log('✓ healthy stages omit attention; a recovered retry keeps resolvable local proof');
  console.log(`Inventory attention: ${retry.kind}; proof: ${retry.evidence.join(', ')}`);
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
