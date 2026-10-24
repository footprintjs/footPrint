/** Native sources, no AI or remote service. Requires packet 3's adopted Foottrace writer dependency. */
import { flowChart, FlowChartExecutor } from 'footprintjs';

const chart = flowChart<{ count: number }>(
  'Increment',
  (scope) => {
    scope.count = scope.count + 1;
  },
  'increment',
).build();

(async () => {
  const executor = new FlowChartExecutor(chart, {
    initialContext: { count: 1 },
    readSources: true,
    readTracking: 'off',
  });
  await executor.run();
  const sources = executor.getSnapshot().readSources!;
  if (sources.status !== 'captured') throw new Error('Source evidence is incomplete');
  if (sources.record?.occurrences[0]?.source.kind !== 'base') throw new Error('Expected a native base read');
  console.log('Native source:', sources.record.occurrences[0].source.kind);
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
