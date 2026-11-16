/** Read a decision from the saved file, with no live executor or execution-tree walk. */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { decide, flowChart, FlowChartExecutor } from 'footprintjs';
import { fileSink, readRecordFile } from 'footprintjs/sinks';
import { readRunEvidence, readStoredRecord } from 'foottrace';

interface State {
  score?: number;
  outcome?: string;
}

async function main() {
  const folder = mkdtempSync(join(tmpdir(), 'footprint-offline-why-'));
  const path = join(folder, 'run.jsonl');
  const sink = fileSink(path);
  try {
    const chart = flowChart<State>(
      'Score',
      (scope) => {
        scope.score = 640;
      },
      'score',
    )
      .addDeciderFunction(
        'Route',
        (scope) =>
          decide(scope, [{ when: { score: { gte: 700 } }, then: 'approve', label: 'High score' }], {
            branch: 'review',
            label: 'No rule matched',
          }),
        'route',
      )
      .addFunctionBranch('approve', 'Approve', (scope) => {
        scope.outcome = 'approved';
      })
      .addFunctionBranch('review', 'Manual review', (scope) => {
        scope.outcome = 'review';
      })
      .end()
      .build();
    await new FlowChartExecutor(chart, { sink }).run();
    await sink.close();

    // Everything below reads only the saved file. Keep channel status beside its rows:
    // an empty partial channel means nothing was seen, not that nothing happened.
    const file = readRecordFile(path);
    const record = readStoredRecord(file.entries);
    const [root] = [...record.logs.values()].filter((log) => log.address.drillPath.length === 0);
    const evidence = readRunEvidence(record, root.address.logRunId);
    const decision = evidence.decisions.rows[0];
    const reads = evidence.reads.rows.find((row) => row.id === decision?.id);
    const branch = evidence.stages.rows.find((row) => row.parent === decision?.id);
    console.log('decision:', evidence.decisions.status);
    console.log('chosen:', decision?.chosen ?? 'unknown');
    console.log('reads:', reads?.keys.join(', ') ?? 'unknown');
    console.log('governed by:', branch ? evidence.control(branch.id).decider ?? 'unknown' : 'unknown');
    console.log('complete:', root.complete);
  } finally {
    await sink.close();
    rmSync(folder, { recursive: true });
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

// Output:
// decision: collected
// chosen: Manual review
// reads: score
// governed by: route#1
// complete: true
