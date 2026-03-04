/**
 * Demo 2: LLM Tool Loop (Decider Pattern)
 *
 * Shows conditional branching with addDeciderFunction() - the classic LLM agent loop.
 */

import { FlowChartBuilder, BaseState } from 'footprint';

// Simple scope factory
const scopeFactory = (ctx: any, stageName: string, readOnly?: unknown) => {
  return new BaseState(ctx, stageName, readOnly);
};

// Simulated LLM responses
const mockResponses = [
  { type: 'tool_call', tool: 'search', args: { query: 'weather today' } },
  { type: 'tool_call', tool: 'calculator', args: { expr: '2+2' } },
  { type: 'response', content: 'The weather is sunny and 2+2=4!' },
];

let callIndex = 0;

// Stage functions
const callLLM = async (scope: BaseState) => {
  console.log('  [LLM] Calling LLM...');
  const response = mockResponses[callIndex++];
  scope.setObject('llmResponse', response);
  console.log(`        Response type: ${response.type}`);
};

const executeToolCall = async (scope: BaseState) => {
  const response = scope.getValue('llmResponse') as any;
  console.log(`  [Tool] Executing tool: ${response.tool}`);
  const result = response.tool === 'search' ? 'Sunny, 72°F' : '4';
  scope.setObject('toolResult', result);
};

const formatResponse = async (scope: BaseState) => {
  const response = scope.getValue('llmResponse') as any;
  console.log(`  [Response] Final answer: ${response.content}`);
};

const handleError = async () => {
  console.log('  [Error] Handling error...');
};

// Decider function - determines which branch to take
// Reads from scope (written by the preceding stage) instead of stage output
const routeDecider = (scope: BaseState) => {
  const response = scope.getValue('llmResponse') as any;
  if (response?.type === 'tool_call') return 'tool';
  if (response?.type === 'response') return 'response';
  return 'error';
};

// Build the LLM tool loop
export function buildLLMToolLoop() {
  return new FlowChartBuilder()
    .start('CallLLM', callLLM)
    .addDeciderFunction('RouteDecider', routeDecider as any)
      .addFunctionBranch('tool', 'ExecuteToolCall', executeToolCall)
      .addFunctionBranch('response', 'FormatResponse', formatResponse)
      .addFunctionBranch('error', 'HandleError', handleError)
      .setDefault('error')
      .end()
    .build();
}

// Execute the demo
async function main() {
  console.log('\n=== LLM Tool Loop Demo (Decider Pattern) ===\n');

  // Run the loop multiple times to show branching
  for (let i = 0; i < 3; i++) {
    console.log(`\n--- Iteration ${i + 1} ---`);

    const builder = new FlowChartBuilder()
      .start('CallLLM', callLLM)
      .addDeciderFunction('RouteDecider', routeDecider as any)
        .addFunctionBranch('tool', 'ExecuteToolCall', executeToolCall)
        .addFunctionBranch('response', 'FormatResponse', formatResponse)
        .addFunctionBranch('error', 'HandleError', handleError)
        .setDefault('error')
        .end();

    const result = await builder.execute(scopeFactory);
    console.log('  Result:', JSON.stringify(result, null, 2));
  }

  console.log('\n✓ LLM Tool Loop demo complete!');
}

main().catch(console.error);
