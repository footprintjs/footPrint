/** Synthetic native overhead only. Run the same harness against the baseline and candidate source. */
import * as engine from '../src';
import type { FlowChart, RunLifecycle } from '../src';

type Mode = 'direct' | 'nested' | 'same' | 'fresh';
type Shape = 'raw' | 'facade';
const args = new Map(
  process.argv.slice(2).map((arg) => {
    const split = arg.indexOf('=');
    return split < 0 ? [arg, 'true'] : [arg.slice(0, split), arg.slice(split + 1)];
  }),
);
const shape = args.get('--shape') ?? 'raw';
if (shape !== 'raw' && shape !== 'facade') throw new TypeError('shape must be raw or facade');
const samples = Number(args.get('--samples') ?? 100);
const warmup = Number(args.get('--warmup') ?? 20);
if (
  !Number.isInteger(samples) ||
  samples < 1 ||
  samples > 10000 ||
  !Number.isInteger(warmup) ||
  warmup < 0 ||
  warmup > 10000
)
  throw new RangeError('Invalid sample counts');
const narrative = args.has('--narrative');
const redact = args.has('--redact');
const policy = redact ? { keys: ['secret'] } : undefined;

function chartFor(mode: Mode): FlowChart {
  const child =
    mode === 'same' || mode === 'fresh'
      ? engine
          .flowChart<{ value?: number; secret?: string }>(
            'ask',
            {
              execute: async (scope) => {
                scope.value = 1;
                scope.secret = 'synthetic';
                return { question: 'next?' };
              },
              resume: async (scope) => {
                scope.value = (scope.value ?? 0) + 1;
              },
            },
            'ask',
          )
          .build()
      : engine
          .flowChart<{ value?: number; secret?: string }>(
            'write',
            async (scope) => {
              scope.value = 1;
              scope.secret = 'synthetic';
            },
            'write',
          )
          .build();
  return mode === 'nested'
    ? engine
        .flowChart('root', async () => undefined, 'root')
        .addSubFlowChartNext('child', child, 'child')
        .build()
    : child;
}

function rawOperation(chart: FlowChart, mode: Mode): () => Promise<void> {
  return async () => {
    const executor = new engine.FlowChartExecutor(chart);
    if (narrative) executor.enableNarrative();
    if (policy) executor.setRedactionPolicy(policy);
    await executor.run();
    if (mode === 'same') await executor.resume(executor.getCheckpoint()!, 'go');
    if (mode === 'fresh') {
      const checkpoint = structuredClone(executor.getCheckpoint()!);
      const resumed = new engine.FlowChartExecutor(chart);
      if (narrative) resumed.enableNarrative();
      if (policy) resumed.setRedactionPolicy(policy);
      await resumed.resume(checkpoint, 'go');
      resumed.getSnapshot({ redact });
    } else executor.getSnapshot({ redact });
  };
}

function facadeOperation(chart: FlowChart, mode: Mode): () => Promise<void> {
  // Baseline source has no lifecycle export. It executes only the raw arm.
  const factory = (
    engine as unknown as {
      createRunLifecycle?: (chart: FlowChart, options: { runnerId: string }) => RunLifecycle;
    }
  ).createRunLifecycle;
  if (!factory) throw new Error('The selected source has no lifecycle; select the raw arm');
  const owner = factory(chart, { runnerId: 'synthetic-overhead' });
  const setup = { ...(narrative && { narrative: {} }), ...(policy && { redaction: policy }) };
  return async () => {
    await owner.withRun(async (run) => {
      await run.execute({ kind: 'run' }, setup);
      if (mode !== 'same' && mode !== 'fresh') run.snapshot({ redact });
    });
    if (mode === 'same') {
      const continuation = owner.continuation()!;
      await owner.withRun(async (run) => {
        await run.execute({ kind: 'resume', mode: 'same', continuation, input: 'go' });
        run.snapshot({ redact });
      });
    }
    if (mode === 'fresh') {
      const checkpoint = owner.continuation()!.checkpoint();
      await owner.withRun(async (run) => {
        await run.execute({ kind: 'resume', mode: 'fresh', checkpoint, input: 'go' }, setup);
        run.snapshot({ redact });
      });
    }
  };
}

async function main(selected: Shape): Promise<void> {
  const results = [];
  for (const mode of ['direct', 'nested', 'same', 'fresh'] as const) {
    const chart = chartFor(mode);
    const operation = selected === 'raw' ? rawOperation(chart, mode) : facadeOperation(chart, mode);
    for (let index = 0; index < warmup; index += 1) await operation();
    const rawMs: number[] = [];
    for (let index = 0; index < samples; index += 1) {
      const started = performance.now();
      await operation();
      rawMs.push(performance.now() - started);
    }
    const sorted = [...rawMs].sort((a, b) => a - b);
    const at = (p: number) => sorted[Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * p))];
    results.push({ mode, rawMs, medianMs: at(0.5), p95Ms: at(0.95), minMs: sorted[0], maxMs: sorted.at(-1) });
  }
  const report = {
    measurement: 'Synthetic native execution overhead, not answer latency or production performance',
    node: process.version,
    platform: process.platform,
    arch: process.arch,
    configuration: {
      shape: selected,
      samples,
      warmup,
      narrative,
      redact,
      tracking: 'native defaults',
      clock: 'performance.now',
      chartBuiltOnce: true,
      noProviderOrExternalIO: true,
    },
    results,
  };
  const output = args.get('--output');
  if (output) {
    const fs = require('fs') as { writeFileSync(path: string, value: string): void };
    fs.writeFileSync(output, JSON.stringify(report, null, 2) + '\n');
  } else console.log(JSON.stringify(report, null, 2));
}

void main(shape).catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
