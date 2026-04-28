/**
 * TopologyRecorder — composition graph from traversal events.
 *
 * Problem it solves:
 *   Post-run consumers can walk `executor.getSnapshot()` to understand the
 *   shape of a run. Live / streaming consumers (UIs showing an in-flight
 *   chart, agent-composition visualizers) don't have that luxury — they see
 *   only the event stream.
 *
 *   TopologyRecorder is the standard accumulator: attach it once via
 *   `attachCombinedRecorder`, query `getTopology()` at any moment.
 *
 * Three node kinds:
 *   - 'subflow'          — via onSubflowEntry (mounted subflow boundary)
 *   - 'fork-branch'      — synthesized one per child on onFork
 *   - 'decision-branch'  — synthesized for the chosen target on onDecision
 *
 * When a fork-branch or decision-branch target IS also a subflow, the
 * subsequent onSubflowEntry attaches as a child of the synthetic node —
 * the layered shape preserves both "who branched" and "what the branch ran."
 *
 * Run:  npx tsx examples/runtime-features/flow-recorder/06-topology.ts
 */
import { flowChart, FlowChartExecutor } from 'footprintjs';
import { topologyRecorder } from 'footprintjs/trace';

interface State {
  log: string[];
}

// Three sibling sub-charts to mount sequentially — mimics a small pipeline.
const classify = flowChart<State>('Classify', (scope) => {
  scope.$batchArray('log', (arr) => arr.push('classified'));
}, 'classify').build();

const analyze = flowChart<State>('Analyze', (scope) => {
  scope.$batchArray('log', (arr) => arr.push('analyzed'));
}, 'analyze').build();

const respond = flowChart<State>('Respond', (scope) => {
  scope.$batchArray('log', (arr) => arr.push('responded'));
}, 'respond').build();

const chart = flowChart<State>('Start', (scope) => {
  if (!scope.log) scope.log = [];
}, 'start')
  .addSubFlowChartNext('sf-classify', classify, 'Classify Request')
  .addSubFlowChartNext('sf-analyze',  analyze,  'Analyze Intent')
  .addSubFlowChartNext('sf-respond',  respond,  'Compose Response')
  .build();

async function main() {
  const executor = new FlowChartExecutor(chart);
  const topo = topologyRecorder();
  executor.attachCombinedRecorder(topo);

  await executor.run({ input: {} });

  const { nodes, edges, rootId, activeNodeId } = topo.getTopology();

  console.log('── Topology (live, from 3 primitive channels) ──');
  console.log(`root=${rootId} active=${activeNodeId ?? 'none (run complete)'}\n`);

  console.log('Nodes (insertion = execution order):');
  for (const n of nodes) {
    const parent = n.parentId ? ` parent=${n.parentId}` : '';
    console.log(`  ${n.kind.padEnd(16)} ${n.id.padEnd(20)} "${n.name}" depth=${n.depth} kind-in=${n.incomingKind}${parent}`);
  }

  console.log('\nEdges:');
  if (edges.length === 0) console.log('  (top-level siblings — consumers read execution order from nodes[])');
  for (const e of edges) {
    console.log(`  ${e.from} -[${e.kind}]-> ${e.to}  @ ${e.at}`);
  }

  // Agent-centric view: filter to subflow nodes only
  console.log('\n── Agent-centric view (subflow nodes only) ──');
  console.log(topo.getSubflowNodes().map((n) => `${n.id} "${n.name}"`).join('\n'));

  // Unit tests (test/lib/recorder/TopologyRecorder.test.ts) drive synthetic
  // events to exercise fork-branch and decision-branch node synthesis —
  // those are harder to trigger through the public builder API here, but
  // the recorder handles them identically to subflow events.
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
