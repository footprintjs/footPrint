// Follow a value back to the decision and the data that produced it.
import { decide, flowChart, FlowChartExecutor } from 'footprintjs';
import { controlDepRecorder } from 'footprintjs/trace';
import { causalChain, findLastWriter, formatCausalChain, keysReadFromExecutionTree } from 'foottrace';

interface ExportState {
  width: number;
  status?: string;
}

const chart = flowChart<ExportState>('LoadImage', (scope) => { scope.width = 640; }, 'load-image')
  .addDeciderFunction('CheckResolution', (scope) => decide(scope, [
      { when: { width: { gte: 1280 } }, then: 'export', label: 'Wide enough' },
    ], 'reject'), 'check-resolution')
    .addFunctionBranch('export', 'ExportImage', (scope) => { scope.status = 'exported'; })
    .addFunctionBranch('reject', 'RejectExport', (scope) => { scope.status = 'rejected'; })
    .end()
  .build();

const executor = new FlowChartExecutor(chart);
const control = controlDepRecorder(); // connects a branch to the decision that chose it
executor.setReadTracking('full'); // data edges need the recorded reads; set both before run()
executor.attachCombinedRecorder(control);
await executor.run();

const { commitLog, executionTree } = executor.getSnapshot();
const writer = findLastWriter(commitLog, 'status');
const reads = keysReadFromExecutionTree(executionTree);
const chain = writer && causalChain(commitLog, writer.runtimeStageId, reads.lookup, { controlDeps: control.asLookup() });
if (chain) console.log(formatCausalChain(chain));

// Output:
// RejectExport (reject#2) [wrote: status]
//   CheckResolution (check-resolution#1) ← [control]
//     LoadImage (load-image#0) ← via width [wrote: width]
