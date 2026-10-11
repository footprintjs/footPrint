// Capture a real public-API recording without installing the engine in Foottrace.
// node test/fixtures/causal-phases/generate.mjs /path/to/footprintjs-10-install
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';

const require = createRequire(resolve(process.argv[2], 'package.json'));
assert.equal(require('footprintjs/package.json').version, '10.0.0');
assert.equal(require('foottrace/package.json').version, '1.0.0');
const { flowChart, FlowChartExecutor } = require('footprintjs');

let valueActuallyRead;
const chart = flowChart('Seed', s => s.$setValue('runs', { b: { x: 1 } }), 'seed')
  .addListOfFunction([
    { id: 'a', name: 'A', fn: s => {
      valueActuallyRead = s.runs.b.x;
      s.$setValue('y', valueActuallyRead + 1);
    } },
    { id: 'b', name: 'B', fn: s => s.$setValue('x', 9) },
  ])
  .addFunction('Join', () => undefined, 'join')
  .build();
const executor = new FlowChartExecutor(chart, { writeProvenance: 'reads-prefix' });
await executor.run();
const snapshot = executor.getSnapshot();
assert.equal(valueActuallyRead, 1);
assert.equal(snapshot.sharedState.runs.a.y, 2);
assert.deepEqual(snapshot.commitLog.map(b => [b.runtimeStageId, b.phase]), [
  ['seed#0', undefined], ['a#1', undefined], ['b#2', undefined],
  ['a#1', 'repeat'], ['b#2', 'repeat'], ['join#3', undefined],
]);

// Retain the official read-source shape, omitting unrelated runtime diagnostics.
// No log row, read value, identity or graph relationship is changed.
function readTree(node) {
  return {
    runtimeStageId: node.runtimeStageId,
    ...(node.stageReads !== undefined && { stageReads: node.stageReads }),
    ...(node.children !== undefined && { children: node.children.map(readTree) }),
    ...(node.next !== undefined && { next: readTree(node.next) }),
  };
}

const readerFixture = {
  producer: 'footprintjs@10.0.0',
  recordLibrary: 'foottrace@1.0.0',
  valueActuallyRead,
  valueWritten: snapshot.sharedState.runs.a.y,
  commitLog: snapshot.commitLog,
  executionTree: readTree(snapshot.executionTree),
};
console.log(JSON.stringify(process.argv.includes('--full') ? snapshot : readerFixture, null, 2));
