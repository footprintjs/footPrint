/**
 * Streaming — Linear Pipeline
 *
 * A streaming stage emits tokens incrementally via a callback.
 * The executor routes tokens through StreamHandlers lifecycle:
 * onStart → onToken (per chunk) → onEnd (with concatenated full text).
 *
 * This example: PrepareContext → GenerateSummary (streaming) → SaveReport
 *
 * Run: npx tsx examples/runtime-features/streaming/01-linear.ts
 */

import { flowChart, FlowChartExecutor, type StreamHandlers } from 'footprintjs';

interface SummaryState {
  topic: string;
  summary?: string;
  saved?: boolean;
}

const tokens = ['The ', 'patient ', 'has ', 'a ', 'moderate ', 'fever.'];

const chart = flowChart<SummaryState>('PrepareContext', async (scope) => {
  scope.topic = 'fever assessment';
}, 'prepare')
  .addStreamingFunction(
    'GenerateSummary',
    async (scope, _breakFn, streamCallback) => {
      for (const token of tokens) {
        streamCallback?.(token);
      }
      scope.summary = tokens.join('');
    },
    'generate',
    'llm-stream',
  )
  .addFunction('SaveReport', async (scope) => {
    scope.saved = true;
  }, 'save')
  .build();

(async () => {
  const collected: string[] = [];

  const handlers: StreamHandlers = {
    onStart: (id) => console.log(`[${id}] started`),
    onToken: (id, token) => { collected.push(token); },
    onEnd: (id, full) => console.log(`[${id}] done: "${full}"`),
  };

  const executor = new FlowChartExecutor(chart, { streamHandlers: handlers });
  executor.enableNarrative();
  await executor.run();

  console.log(`Tokens collected: ${collected.length}`);
  console.log('Narrative:');
  executor.getNarrativeEntries().map(e => e.text).forEach((line) => console.log(`  ${line}`));
})().catch(console.error);
