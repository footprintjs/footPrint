/**
 * StructureRecorder — Basic Attach and Event Collection
 *
 * Demonstrates the build-time twin of FlowRecorder. Attach a
 * StructureRecorder to a builder and observe the chart's shape as
 * it's constructed — every node added, every edge wired, every
 * decider closed, every subflow mounted.
 *
 * Two registration surfaces:
 *   - Options-bag: `flowChart('seed', fn, 'seed', { structureRecorders: [rec] })`
 *   - Fluent: `flowChart('seed', fn, 'seed').attachStructureRecorder(rec)`
 *
 * Both fire the same events to the same recorder.
 *
 * Run: npx tsx examples/build-time-features/structure-recorder/01-basic-attach.ts
 */

import {
  flowChart,
  type StructureRecorder,
  type StructureStageAddedEvent,
  type StructureEdgeAddedEvent,
  type StructureSubflowMountedEvent,
} from 'footprintjs';

const noop = async () => ({});

// Collect events into a log so we can print them after the build.
const events: Array<{ kind: string; payload: unknown }> = [];

const rec: StructureRecorder = {
  id: 'demo-structure',
  onStageAdded(e: StructureStageAddedEvent) {
    events.push({ kind: 'stageAdded', payload: { stageId: e.stageId, name: e.name, type: e.type } });
  },
  onEdgeAdded(e: StructureEdgeAddedEvent) {
    events.push({ kind: 'edgeAdded', payload: { from: e.from, to: e.to, kind: e.kind } });
  },
  onSubflowMounted(e: StructureSubflowMountedEvent) {
    events.push({
      kind: 'subflowMounted',
      payload: {
        subflowId: e.subflowId,
        subflowPath: e.subflowPath,
        hasSpec: e.subflowSpec !== undefined,
      },
    });
  },
};

// Build a small chart with a subflow.
const subflow = flowChart('validate', noop, 'validate')
  .addFunction('save', noop, 'save')
  .build();

const chart = flowChart('intake', noop, 'intake', { structureRecorders: [rec] })
  .addFunction('classify', noop, 'classify')
  .addSubFlowChartNext('process', subflow, 'Process')
  .addFunction('respond', noop, 'respond')
  .build();

console.log('Built chart:', chart.buildTimeStructure.id);
console.log('\nStructure events fired during build:');
for (const e of events) {
  console.log(' -', e.kind, JSON.stringify(e.payload));
}

// Expected output highlights:
//   onSubflowMounted carries `subflowPath: 'process'` and `hasSpec: true`.
//   The subflow's INTERNAL events (validate / save / their edge) did
//   NOT fire to this recorder — MOUNT-ONLY contract. See 02-walk-spec.ts
//   for how to materialize the subflow's inner structure from the
//   mount event payload.
