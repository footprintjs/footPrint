/** Real public engine scenario shared with the separately owned reader protocol proof. */
async function produce({ flowChart, FlowChartExecutor, subflowCapture = require('footprintjs/subflow-capture').subflowCapture }, options = {}) {
  const child = flowChart(
    'Compute',
    (scope) => {
      scope.childAnswer = scope.seed * 2;
    },
    'compute',
  ).build();
  const branch = flowChart(
    'Branch',
    (scope) => {
      scope.branchAnswer = scope.item * 3;
    },
    'branch',
  ).build();
  const nested = flowChart(
    'Nested items',
    (scope) => {
      scope.items = [2, 1];
    },
    'nested-items',
  )
    .addParallelForEach('Nested fan', 'nested-fan', {
      items: (scope) => scope.items,
      branch: () => branch,
      into: 'nestedAnswers',
      maxBranches: 3,
    })
    .build();
  const chart = flowChart(
    'Source',
    (scope) => {
      scope['literal.source'] = 7;
      scope.items = [3, 1];
    },
    'source',
  )
    .addSubFlowChartNext('mapped', child, 'Mapped child', {
      inputMapper: (parent) => ({ seed: parent['literal.source'] }),
      outputMapper: (output) => ({ answer: output.childAnswer }),
    })
    .addFunction(
      'Later write',
      (scope) => {
        scope['literal.source'] = 999;
      },
      'later',
    )
    .addParallelForEach('Fan', 'fan', {
      items: (scope) => [...scope.items].reverse(),
      branch: () => branch,
      into: 'answers',
      maxBranches: 3,
    })
    .addSubFlowChartNext('nested', nested, 'Nested parent', {})
    .build();
  const executor = new FlowChartExecutor(chart, {...options,...subflowCapture({input:options.captureInputHandoff === true,fanout:options.captureFanoutHandoff === true})});
  await executor.run();
  return { snapshot: executor.getSnapshot(), redacted: executor.getSnapshot({ redact: true }) };
}
module.exports = { produce };
