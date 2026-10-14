import { flowChart, decide, FlowChartExecutor } from 'footprintjs';
import { controlDepRecorder } from 'footprintjs/trace';

type ExportState = {
  width: number;
  status: 'exported' | 'rejected';
};

const chart = flowChart<ExportState>('LoadImage', (scope) => {
  scope.width = 640; // Example data; no image service is called.
}, 'load-image')
  .addDeciderFunction('CheckResolution', (scope) => decide(scope, [
    {
      when: { width: { gte: 1280 } },
      then: 'export',
      label: 'Image is wide enough',
    },
  ], 'reject'), 'check-resolution')
    .addFunctionBranch('export', 'ExportImage', (scope) => {
      scope.status = 'exported';
    })
    .addFunctionBranch('reject', 'RejectExport', (scope) => {
      scope.status = 'rejected';
    })
    .setDefault('reject')
    .end()
  .build();

const executor = new FlowChartExecutor(chart);
const control = controlDepRecorder();

// Enable before execution: collect the narrative and governing decisions.
executor.setReadTracking('full');
executor.enableNarrative();
executor.attachCombinedRecorder(control);
await executor.run();

const snapshot = executor.getSnapshot();
console.log(snapshot.sharedState.status); // Expected: "rejected".
console.log(executor.getNarrativeEntries().map(e => e.text).join('\n'));
console.dir(control.getDecisions(), { depth: null });

import {
  causalChain,
  findLastWriter,
  formatCausalChain,
  keysReadFromExecutionTree,
} from 'foottrace';

// Continue from the completed run above.
const writer = findLastWriter(snapshot.commitLog, 'status');
if (!writer) throw new Error('No recorded writer for status.');

const reads = keysReadFromExecutionTree(snapshot.executionTree);
const chain = causalChain(
  snapshot.commitLog,
  writer.runtimeStageId,
  reads.lookup,
  { controlDeps: control.asLookup() },
);

if (!chain) throw new Error('No causal chain.');
console.log(formatCausalChain(chain));
