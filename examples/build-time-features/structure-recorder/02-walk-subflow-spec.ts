/**
 * StructureRecorder — Walk Subflow Spec on Mount Event
 *
 * MOUNT-ONLY semantics: when a parent builder mounts a subflow, the
 * subflow's INTERNAL onStageAdded / onEdgeAdded events fired to the
 * SUBFLOW's own recorder, NOT the parent's. To get the subflow's
 * inner structure from the parent's perspective, walk the
 * `subflowSpec` payload delivered on `onSubflowMounted` (added in
 * proposal #001).
 *
 * Use `walkSubflowSpec` from `footprintjs/trace` — yields a flat
 * ordered stream of items (subflow-start marker first, then
 * stages/edges/loops, nested subflows auto-recursed with composed
 * paths like `'outer/inner'`).
 *
 * Run: npx tsx examples/build-time-features/structure-recorder/02-walk-subflow-spec.ts
 */

import { flowChart, type StructureRecorder, type StructureSubflowMountedEvent } from 'footprintjs';
import { walkSubflowSpec } from 'footprintjs/trace';

const noop = async () => ({});

// Build the SAME chart shape as 01-basic-attach but materialize the
// subflow's inner structure into a flat node + edge list via the walker.
const innerNodes: Array<{ id: string; name: string; subflowPath: string }> = [];
const innerEdges: Array<{ from: string; to: string; kind: string; subflowPath: string }> = [];

const rec: StructureRecorder = {
  id: 'walker-demo',
  onSubflowMounted(e: StructureSubflowMountedEvent) {
    if (!e.subflowSpec) return; // lazy mount — no spec yet at build time
    for (const item of walkSubflowSpec(e.subflowSpec, e.subflowPath)) {
      switch (item.kind) {
        case 'subflow-start':
          // First item for each subflow — marks the entry stage.
          // Useful for drawing the boundary edge from the mount node.
          break;
        case 'stage':
          innerNodes.push({
            id: item.stageId,
            name: item.name,
            subflowPath: item.subflowPath,
          });
          break;
        case 'edge':
        case 'loop':
          innerEdges.push({
            from: item.from,
            to: item.to,
            kind: item.kind === 'loop' ? 'loop' : item.edgeKind,
            subflowPath: item.subflowPath,
          });
          break;
        case 'subflow':
          // Nested subflow marker. The walker auto-recurses into its
          // internals (composed `subflowPath`), so no manual recursion
          // needed here.
          break;
      }
    }
  },
};

// A nested-subflow shape so we can see composed paths.
const innermost = flowChart('check', noop, 'check').addFunction('finalize', noop, 'finalize').build();
const middle = flowChart('verify', noop, 'verify')
  .addSubFlowChartNext('checks', innermost, 'Checks')
  .build();
flowChart('intake', noop, 'intake', { structureRecorders: [rec] })
  .addSubFlowChartNext('process', middle, 'Process')
  .build();

console.log('Inner nodes materialized via walker:');
for (const n of innerNodes) {
  console.log(` - ${n.id}  (subflowPath=${n.subflowPath}, name=${n.name})`);
}
console.log('\nInner edges:');
for (const e of innerEdges) {
  console.log(` - ${e.from} → ${e.to}  [${e.kind}]  (subflowPath=${e.subflowPath})`);
}

// Expected output highlights:
//   - 'verify' and 'checks' tagged with subflowPath='process'
//   - 'check' and 'finalize' tagged with composed path 'process/checks'
//   - All inner edges materialized with their subflowPath
//
// This replaces the consumer-side "tagSubflowMembers" workaround that
// downstream libraries used to need (connected-component algorithm to
// retroactively figure out subflow membership). Now the library
// delivers the spec + path on the mount event; the consumer walks it.
