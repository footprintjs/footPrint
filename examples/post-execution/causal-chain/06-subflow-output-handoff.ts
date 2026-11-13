/**
 * Follow an output mapper's observed child reads without mixing two logs.
 *
 * Parent: Seed -> Payment -> Ship
 * Child: Charge writes txnId; the mapper hands it back as receipt.
 * The parent's unrelated txnId must never be selected as that child's source.
 *
 * Run: npx tsx --tsconfig examples/tsconfig.json examples/post-execution/causal-chain/06-subflow-output-handoff.ts
 */
import { flowChart, FlowChartExecutor } from 'footprintjs';
import type { SubflowResult } from 'footprintjs/advanced';
import { findLastWriter, type CommitBundle, type LogAddress } from 'foottrace';

interface ParentState {
  amount: number;
  txnId: string;
  receipt?: string;
  shipped?: boolean;
}

interface PaymentState {
  chargedAmount: number;
  txnId?: string;
}

function sameAddress(left: LogAddress | undefined, right: LogAddress): boolean {
  return left?.logRunId === right.logRunId
    && left.drillPath.length === right.drillPath.length
    && left.drillPath.every((part, index) => part === right.drillPath[index]);
}

async function main() {
  const payment = flowChart<PaymentState>('Charge', (scope) => {
    scope.txnId = `TXN-${scope.chargedAmount}`;
  }, 'charge').build();

  const chart = flowChart<ParentState>('Seed', (scope) => {
    scope.amount = 99;
    scope.txnId = 'UNRELATED-PARENT-VALUE';
  }, 'seed')
    .addSubFlowChartNext('payment', payment, 'Payment', {
      inputMapper: (parent) => ({ chargedAmount: parent.amount }),
      outputMapper: (child: PaymentState) => ({ receipt: child.txnId }),
    })
    .addFunction('Ship', (scope) => { scope.shipped = scope.receipt !== undefined; }, 'ship')
    .build();

  const executor = new FlowChartExecutor(chart, {
    captureOutputHandoff: true,
    writeProvenance: 'reads-prefix',
  });
  await executor.run();
  const snapshot = executor.getSnapshot();
  const parentWriter = findLastWriter(snapshot.commitLog, 'receipt');
  if (!parentWriter) throw new Error('The parent has no recorded receipt writer.');

  // This result comes from our own native run. Select one exact invocation,
  // not the reusable subflowId alias that can refer to another loop visit.
  const child = snapshot.subflowResults?.[parentWriter.runtimeStageId] as SubflowResult | undefined;
  const handoff = child?.outputHandoff;
  if (!child || !handoff || handoff.status !== 'captured') {
    console.log('Child attribution unavailable; keep the parent boundary.');
    return;
  }
  const merge = snapshot.commitLog[handoff.parent.commitIdx];
  if (!sameAddress(snapshot.logAddress, handoff.parent.address)
    || !sameAddress(child.treeContext.logAddress, handoff.child.address)
    || merge?.runtimeStageId !== handoff.parent.runtimeStageId
    || merge.idx !== parentWriter.idx
    || merge.runtimeStageId !== parentWriter.runtimeStageId) {
    throw new Error('The handoff does not match these parent and child records.');
  }

  console.log(`receipt: ${snapshot.sharedState.receipt}`);
  console.log(`parent txnId: ${snapshot.sharedState.txnId}`);
  console.log(`handoff: ${handoff.status} (${handoff.attribution})`);
  const write = handoff.writes.find(entry => entry.path === 'receipt');
  for (const key of write?.reads ?? []) {
    const writer = findLastWriter(child.treeContext.history as CommitBundle[], key, handoff.child.beforeCommitIdx);
    console.log(`child ${key}: ${writer?.stageId ?? 'earlier writer unknown'}`);
  }
  console.log(`parent row names child key: ${parentWriter.trace.some(row => row.readKeys?.includes('txnId'))}`);
}

main().catch((error: unknown) => { throw error; });

// Output:
// receipt: TXN-99
// parent txnId: UNRELATED-PARENT-VALUE
// handoff: captured (observed-read-prefix)
// child txnId: payment/charge
// parent row names child key: false
