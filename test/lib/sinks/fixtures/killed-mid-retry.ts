/**
 * A process that dies hard in the middle of a retry — the fixture for `scenario/hard-kill.test.ts`.
 *
 * Bundled by the test (esbuild) and run as its own Node process. It writes its record to the file named by its
 * first argument and kills ITSELF with SIGKILL while its second attempt runs: no `finally`, no flush, no closing
 * entry — nothing of the library's runs after that instant. Whatever is in the file got there as it happened.
 */
import { flowChart, FlowChartExecutor } from '../../../../src/index.js';
import { fileSink } from '../../../../src/sinks.js';

declare const process: { argv: string[]; pid: number; kill(pid: number, signal: string): void };

const path = process.argv[2];
/** The retry's wait — `0` is the default policy's: the next attempt starts without the event loop turning. */
const backoffMs = Number(process.argv[3] ?? '0');
let attempts = 0;

const chart = flowChart<Record<string, any>>(
  'Receive order',
  (s) => {
    s.orderId = 'A-17';
  },
  'receive',
)
  .addFunction(
    'Charge card',
    async () => {
      attempts += 1;
      if (attempts === 1) throw Object.assign(new Error('gateway busy'), { status: 503 });
      // Attempt 2: the machine goes away mid-call.
      process.kill(process.pid, 'SIGKILL');
      await new Promise(() => {});
    },
    'charge',
  )
  .retry({ attempts: 3, backoffMs })
  .build();

new FlowChartExecutor(chart, { sink: fileSink(path) }).run().catch(() => undefined);
