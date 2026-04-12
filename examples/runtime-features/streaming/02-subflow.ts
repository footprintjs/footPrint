/**
 * Streaming — Inside a Subflow
 *
 * Verifies that streaming stages work correctly when mounted
 * inside a subflow. The StreamHandlers should receive tokens
 * from the subflow's streaming stage just like a root-level one.
 *
 * Pipeline: Seed → [Subflow: Prepare → Stream → Finalize] → Report
 *
 * Run: npx tsx examples/runtime-features/streaming/02-subflow.ts
 */

import {
  flowChart,
  FlowChartBuilder,
  FlowChartExecutor,
  type StreamHandlers,
} from 'footprintjs';

interface ParentState {
  query: string;
  answer?: string;
}

const responseTokens = ['Based ', 'on ', 'the ', 'data, ', 'the ', 'answer ', 'is ', '42.'];

const llmSubflow = new FlowChartBuilder()
  .start('PreparePrompt', async (scope: any) => {
    scope.prompt = `Answer: ${scope.query}`;
  }, 'prepare-prompt')
  .addStreamingFunction(
    'CallLLM',
    async (scope: any, _breakFn, streamCallback) => {
      for (const token of responseTokens) {
        streamCallback?.(token);
      }
      scope.response = responseTokens.join('');
    },
    'call-llm',
    'llm-stream',
  )
  .addFunction('ExtractAnswer', async (scope: any) => {
    scope.answer = scope.response;
  }, 'extract')
  .build();

const chart = flowChart<ParentState>('Seed', async (scope) => {
  scope.query = 'What is the meaning of life?';
}, 'seed')
  .addSubFlowChartNext('sf-llm', llmSubflow, 'LLM Call', {
    inputMapper: (s: any) => ({ query: s.query }),
    outputMapper: (s: any) => ({ answer: s.answer }),
  })
  .addFunction('Report', async (scope) => {
    console.log(`Answer: ${scope.answer}`);
  }, 'report')
  .build();

(async () => {
  const tokens: string[] = [];

  const handlers: StreamHandlers = {
    onToken: (_id, token) => { tokens.push(token); },
    onEnd: (id, full) => console.log(`[${id}] complete: ${full?.length} chars`),
  };

  const executor = new FlowChartExecutor(chart, { streamHandlers: handlers });
  executor.enableNarrative();
  await executor.run();

  console.log(`Tokens from subflow: ${tokens.length}`);
  console.log('Narrative:');
  executor.getNarrative().forEach((line) => console.log(`  ${line}`));
})().catch(console.error);
