/**
 * Inspect eager subflow structure during construction, without running a chart.
 * This consumes builder-owned metadata, not a runtime record or arbitrary input.
 */
import { flowChart, type StructureRecorder } from 'footprintjs';
import { walkSubflowSpec, type WalkerItem } from 'footprintjs/trace';

let stageCalls = 0;
let lazyCalls = 0;
const stage = () => {
  stageCalls++;
};
const child = flowChart('Read', stage, 'read').build();
const stages: Extract<WalkerItem, { kind: 'stage' }>[] = [];
const unresolved: string[] = [];
const recorder: StructureRecorder = {
  id: 'static-subflows',
  onSubflowMounted(event) {
    if (!event.subflowSpec) {
      unresolved.push(event.subflowPath);
      return;
    }
    for (const item of walkSubflowSpec(event.subflowSpec, event.subflowPath)) {
      if (item.kind === 'stage') stages.push(item);
    }
  },
};

const builder = flowChart('Start', stage, 'start', { structureRecorders: [recorder] })
  .addSubFlowChartNext('first', child, 'First')
  .addSubFlowChartNext('second', child, 'Second')
  .addLazySubFlowChartNext(
    'lazy',
    () => {
      lazyCalls++;
      return child;
    },
    'Lazy',
  );
builder.build();

// Recorder exceptions are isolated by the builder; never let that hide a failed example.
if (builder.getStructureBuildErrors().length !== 0) throw new Error('REGRESSION: structure recorder failed');
if (
  JSON.stringify(stages.map((item) => [item.subflowPath, item.stageId])) !==
  JSON.stringify([
    ['first', 'read'],
    ['second', 'read'],
  ])
) {
  throw new Error('REGRESSION: repeated child stages lost their supplied ids or mount namespaces');
}
if (JSON.stringify(unresolved) !== JSON.stringify(['lazy'])) throw new Error('REGRESSION: lazy shape was invented');
if (stageCalls !== 0 || lazyCalls !== 0) throw new Error('REGRESSION: static inspection executed application work');

for (const item of stages) console.log(`${item.subflowPath}: ${item.stageId}`);
console.log(`Unresolved lazy mounts: ${unresolved.join(', ')}`);
console.log(`Stage calls: ${stageCalls}; lazy factory calls: ${lazyCalls}`);

// Output:
// first: read
// second: read
// Unresolved lazy mounts: lazy
// Stage calls: 0; lazy factory calls: 0
