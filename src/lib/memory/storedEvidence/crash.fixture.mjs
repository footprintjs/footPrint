import { decide, flowChart, FlowChartExecutor } from '../../../index.js';
import { fileSink } from '../../sinks/fileSink.js';

// Bounded child fixture: the parent owns the bundle/file and checks the actual SIGKILL result.
async function main() {
  const sink = fileSink(process.argv[2]);
  const inner = flowChart(
    'Inside',
    (s) => {
      s.inside = 1;
    },
    'inside',
  )
    .addFunction(
      'Blocked',
      async () => {
        await sink.flush();
        process.kill(process.pid, 'SIGKILL');
      },
      'blocked',
    )
    .build();
  const chart = flowChart(
    'Seed',
    (s) => {
      s.go = true;
    },
    'seed',
  )
    .addDeciderFunction('Route', (s) => decide(s, [{ when: { go: { eq: true } }, then: 'child' }], 'no'), 'route')
    .addSubFlowChartBranch('child', inner, 'Child')
    .addFunctionBranch('no', 'No', () => {})
    .end()
    .build();
  await new FlowChartExecutor(chart, { sink }).run();
}
main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
