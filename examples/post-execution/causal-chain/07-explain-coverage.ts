/** Check the coverage of a live payment subflow and follow its output handoff. */
import { flowChart, FlowChartExecutor } from 'footprintjs';
import type { SubflowResult } from 'footprintjs/advanced';
import { captureWitnessOf, explain } from 'footprintjs/explain';
import { findLastWriter, type CommitBundle } from 'foottrace';
import { createRecordGraph } from 'foottrace/cause';

interface PaymentState {
  chargedAmount: number;
  txnId?: string;
}

const payment = flowChart<PaymentState>(
  'Charge',
  (scope) => {
    scope.txnId = `TXN-${scope.chargedAmount}`;
  },
  'charge',
).build();
const chart = flowChart<{ amount: number; receipt?: string }>(
  'Seed',
  (scope) => {
    scope.amount = 99;
  },
  'seed',
)
  .addSubFlowChartNext('payment', payment, 'Payment', {
    inputMapper: (parent) => ({ chargedAmount: parent.amount }),
    outputMapper: (child: PaymentState) => ({ receipt: child.txnId }),
  })
  .build();

async function inspect(enabled: boolean) {
  const executor = new FlowChartExecutor(chart, explain(enabled));
  await executor.run();
  const snapshot = executor.getSnapshot();
  if (snapshot.sharedState.receipt !== 'TXN-99') throw new Error('Expected the same payment receipt in both runs');

  const receipt = findLastWriter(snapshot.commitLog, 'receipt');
  if (!receipt || !snapshot.logAddress) throw new Error('The receipt write must be in the root log');
  // Route through the exact invocation that wrote the receipt.
  const child = snapshot.subflowResults?.[receipt.runtimeStageId] as SubflowResult | undefined;
  if (!child?.treeContext.logAddress) throw new Error('The receipt must come from a mounted child');
  const { treeContext, outputHandoff } = child;
  const childAddress = child.treeContext.logAddress;
  const captureWitness = captureWitnessOf(treeContext);
  if (Boolean(captureWitness) !== enabled) throw new Error('Only the explain run should bind a witness');
  if (captureWitnessOf({ ...treeContext })) throw new Error('A copy should carry no live witness');

  const graph = createRecordGraph([
    {
      address: snapshot.logAddress,
      commitLog: snapshot.commitLog,
      complete: true,
      subflows: {
        version: 1,
        status: 'partial',
        // This fixture supplies the one known mount. The general inventory stays partial.
        mounts: [
          { runtimeStageId: receipt.runtimeStageId, child: childAddress, ...(outputHandoff && { outputHandoff }) },
        ],
        collections: [],
      },
    },
    {
      address: childAddress,
      commitLog: treeContext.history,
      complete: true,
      subflows: { version: 1, status: 'partial', mounts: [], collections: [] },
      ...(treeContext.capture && { capture: treeContext.capture }),
      ...(captureWitness && { captureWitness }),
    },
  ]);
  const context = { signal: new AbortController().signal };
  const coverage = await graph.captureCoverage(
    childAddress,
    { channel: 'reads', mode: 'full', from: 0, to: treeContext.history.length },
    context,
  );
  const expectedCoverage = enabled ? 'covered' : 'collection-unknown';
  if (coverage.state !== expectedCoverage) throw new Error(`Expected ${expectedCoverage}, got ${coverage.state}`);

  const childWrite = findLastWriter(treeContext.history as CommitBundle[], 'txnId');
  if (!childWrite) throw new Error('The child must write the transaction ID in both runs');
  const childWriterNode = graph.nodeId(childAddress, {
    runtimeStageId: childWrite.runtimeStageId,
    commitIdx: childWrite.idx,
    key: 'txnId',
  });
  const receiptNode = graph.nodeId(snapshot.logAddress, {
    runtimeStageId: receipt.runtimeStageId,
    commitIdx: receipt.idx,
    key: 'receipt',
  });
  const parents = await graph.parents(receiptNode, context);
  const followedHandoff = parents.edges.some(
    (edge) => edge.nodeId === childWriterNode && edge.evidence.includes('subflow:output:0'),
  );
  if (followedHandoff !== enabled)
    throw new Error('Only the explain run should follow the receipt to its child writer');
  if (!enabled) {
    const gaps = await graph.gaps(receiptNode, context);
    if (
      !gaps.some((gap) => gap.code === 'not-collected') ||
      !gaps.some((gap) => gap.code === 'scope-boundary' && gap.evidence.includes('subflow:output:0'))
    ) {
      throw new Error('Expected missing evidence at the handoff boundary');
    }
  }

  console.log(
    `Explain ${enabled ? 'on' : 'off'}: ${coverage.state}; receipt source ${
      enabled ? childWrite.stageId : 'not-collected'
    }`,
  );
}

async function main(): Promise<void> {
  await inspect(true);
  await inspect(false);
}

main().catch((error: unknown) => {
  throw error;
});

// Output:
// Explain on: covered; receipt source payment/charge
// Explain off: collection-unknown; receipt source not-collected
