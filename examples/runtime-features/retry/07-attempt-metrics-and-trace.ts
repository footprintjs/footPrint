/** A provider-neutral metric exemplar → stored trace → bounded causal query and committed state. */
import { flowChart, FlowChartExecutor } from 'footprintjs';
import { attempts, memoryStore } from 'footprintjs/recorders';
import { causalChain, readStoredRecord, stateAt } from 'foottrace';
import { memorySink } from 'foottrace/write';

async function main() {
  let calls = 0;
  const metrics = attempts({ exemplars: 2, store: memoryStore() });
  const sink = memorySink();
  const chart = flowChart<{ order?: string; available?: boolean }>(
    'Order',
    (scope) => {
      scope.order = 'synthetic-order';
    },
    'order',
  )
    .addFunction(
      'Inventory',
      async (scope) => {
        scope.available = await scope.$call(
          'demo.inventory',
          () => {
            if (++calls === 1) throw new Error('synthetic transient failure');
            return true;
          },
          { attempts: 2 },
        );
      },
      'inventory',
    )
    .build();
  const executor = new FlowChartExecutor(chart, { sink });
  executor.attachFlowRecorder(metrics);
  await executor.run();
  const ref = metrics.slowest('demo.inventory', 1)[0];
  if (!ref) throw new Error('missing physical exemplar');
  const stored = readStoredRecord(sink.entries).root(ref.runId);
  if (!stored?.complete || stored.gaps.length > 0) throw new Error('stored trace incomplete');
  const index = stored.commitLog.findIndex((bundle) => bundle.runtimeStageId === ref.runtimeStageId);
  if (index < 0) throw new Error('missing stage commit');
  // A metric reference selects a real stage stop. This example collected no separate read lookup,
  // so the causal query honestly returns the selected stage without inventing upstream dependencies.
  const causal = causalChain([...stored.commitLog], ref.runtimeStageId, () => [], { maxDepth: 2, maxNodes: 20 });
  if (!causal) throw new Error('missing causal stage');
  const state = stateAt(stored.source(), index);
  if (state.state.available !== true) throw new Error('unexpected committed state');
  const totals = await metrics.aggregate({ target: 'demo.inventory' });
  if (totals.byTarget.get('demo.inventory')?.count !== 2) throw new Error('incorrect count');
  console.log('✓ metric exemplar → stored trace → causal stage and committed state; no model required');
  console.log(
    `Physical attempt: ${ref.id}; role: ${ref.attemptKind}; rows: ${totals.byTarget.get('demo.inventory')?.count}`,
  );
}
main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
