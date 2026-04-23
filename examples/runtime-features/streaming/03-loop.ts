/**
 * Streaming — Inside a Loop
 *
 * Verifies that streaming stages produce correct tokens across
 * multiple loop iterations. Each iteration should trigger the
 * full StreamHandlers lifecycle (onStart → onToken → onEnd).
 *
 * Pattern: an agent loop that streams a response each iteration,
 * then decides whether to loop or stop.
 *
 * Pipeline: Init → StreamResponse (loop) → Done
 *
 * Run: npx tsx examples/runtime-features/streaming/03-loop.ts
 */

import { flowChart, FlowChartExecutor, type StreamHandlers } from 'footprintjs';

interface AgentState {
  iteration: number;
  maxIterations: number;
  responses: string[];
}

const chart = flowChart<AgentState>('Init', async (scope) => {
  scope.iteration = 0;
  scope.maxIterations = 3;
  scope.responses = [];
}, 'init')
  .addStreamingFunction(
    'StreamResponse',
    async (scope, _breakFn, streamCallback) => {
      scope.iteration += 1;
      const tokens = [`[Iter ${scope.iteration}] `, 'Hello ', 'world.'];
      for (const t of tokens) {
        streamCallback?.(t);
      }
      scope.responses = [...scope.responses, tokens.join('')];

      if (scope.iteration >= scope.maxIterations) {
        scope.$break();
      }
    },
    'stream-response',
    `agent-stream`,
  )
  .loopTo('stream-response')
  .build();

(async () => {
  const allTokens: Array<{ iteration: number; token: string }> = [];
  let startCount = 0;
  let endCount = 0;

  const handlers: StreamHandlers = {
    onStart: () => { startCount++; },
    onToken: (_id, token) => { allTokens.push({ iteration: startCount, token }); },
    onEnd: () => { endCount++; },
  };

  const executor = new FlowChartExecutor(chart, { streamHandlers: handlers });
  executor.enableNarrative();
  await executor.run();

  console.log(`Stream lifecycle calls: ${startCount} starts, ${endCount} ends`);
  console.log(`Total tokens across all iterations: ${allTokens.length}`);
  console.log('Narrative:');
  executor.getNarrativeEntries().map(e => e.text).forEach((line) => console.log(`  ${line}`));
})().catch(console.error);
