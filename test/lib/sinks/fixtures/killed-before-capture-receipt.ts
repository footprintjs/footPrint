import { flowChart, FlowChartExecutor } from '../../../../src/index.js';
import { fileSink } from '../../../../src/sinks.js';
import { controlDepRecorder } from '../../../../src/trace.js';

const sink = fileSink(process.argv[2]!);
const executor = new FlowChartExecutor(
  flowChart(
    'Work',
    (s) => {
      s.value = 1;
    },
    'work',
  ).build(),
  {
    captureCoverage: true,
    sink: {
      adapter: sink,
      capture: {
        acknowledge: async (target, context) => {
          await sink.acknowledge(target, context);
          process.kill(process.pid, 'SIGKILL');
          return { ...target, durability: 'durable' };
        },
      },
    },
  },
);
executor.attachFlowRecorder(controlDepRecorder({ captureCoverage: true }));
executor.run().catch(() => undefined);
