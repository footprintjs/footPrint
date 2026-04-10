/**
 * Feature: Streaming Stages
 *
 * Streaming stages emit tokens incrementally via a StreamCallback.
 * The executor calls lifecycle hooks: onStart -> onToken -> onEnd.
 *
 * Run:  npm run feature:streaming
 * Try it: https://footprintjs.github.io/footprint-playground/samples/streaming
 */

import {
  flowChart,
  FlowChartExecutor,
  type StreamHandlers,
} from 'footprintjs';

interface SummaryState {
  patientName: string;
  temperature: number;
  unit: string;
  summary?: string;
  saved?: boolean;
  reportLength?: number;
}

(async () => {

const llmTokens = [
  'The ', 'patient ', 'presents ', 'with ', 'elevated ',
  'temperature ', 'of ', '102.6F, ', 'consistent ', 'with ',
  'a ', 'moderate ', 'fever.',
];

const streams: Record<string, string[]> = {};

const streamHandlers: StreamHandlers = {
  onStart: (streamId) => {
    streams[streamId] = [];
    process.stdout.write(`  [${streamId}] streaming: `);
  },
  onToken: (streamId, token) => {
    streams[streamId].push(token);
    process.stdout.write(token);
  },
  onEnd: (streamId, fullText) => {
    process.stdout.write('\n');
    console.log(`  [${streamId}] complete: ${fullText?.length ?? 0} chars`);
  },
};

const chart = flowChart<SummaryState>('PrepareContext', async (scope) => {
  scope.patientName = 'Jane Doe';
  scope.temperature = 102.6;
  scope.unit = 'fahrenheit';
}, 'prepare-context')
  .addStreamingFunction(
    'GenerateSummary',
    async (scope, _breakFn, streamCallback) => {
      // Simulate LLM streaming
      for (const token of llmTokens) {
        await new Promise((r) => setTimeout(r, 30));
        streamCallback?.(token);
      }
      scope.summary = llmTokens.join('');
    },
    'generate-summary',
    'llm-summary',
  )
  .addFunction('SaveReport', async (scope) => {
    scope.saved = true;
    scope.reportLength = scope.summary!.length;
  }, 'save-report')
  .build();

const executor = new FlowChartExecutor(chart, { streamHandlers });

console.log('=== Streaming Stage (LLM simulation) ===\n');
await executor.run();

console.log(`\n  Tokens captured: ${streams['llm-summary']?.length ?? 0}`);

})().catch(console.error);
