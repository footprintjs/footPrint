/**
 * Self-Describing — MCP Tool Generation
 *
 * chart.toMCPTool() returns an MCP-compatible tool definition.
 * The description includes numbered step list from stage descriptions.
 *
 * Run: npx tsx examples/build-time-features/self-describing/02-mcp-tool.ts
 */

import { z } from 'zod';
import { flowChart, decide } from 'footprintjs';

interface State { creditScore?: number; decision?: string }

const chart = flowChart<State>('LoadApplication', async (scope) => {
  scope.creditScore = scope.$getArgs<{ creditScore: number }>().creditScore;
}, 'load', undefined, 'Load credit application data')
  .addDeciderFunction('ClassifyRisk', (scope) => {
    return decide(scope, [
      { when: { creditScore: { gt: 700 } }, then: 'approve', label: 'Good credit' },
    ], 'reject');
  }, 'classify', 'Evaluate credit risk')
    .addFunctionBranch('approve', 'Approve', async (scope) => { scope.decision = 'APPROVED'; }, 'Issue approval')
    .addFunctionBranch('reject', 'Reject', async (scope) => { scope.decision = 'REJECTED'; }, 'Issue rejection')
    .setDefault('reject')
    .end()
  .contract({
    input: z.object({ creditScore: z.number().min(300).max(850) }),
    mapper: (scope) => ({ decision: scope.decision }),
  })
  .build();

const tool = chart.toMCPTool();
console.log('MCP Tool:');
console.log(`  Name: ${tool.name}`);
console.log(`  Description:\n    ${tool.description.split('\n').join('\n    ')}`);
console.log(`  Input schema: ${JSON.stringify(tool.inputSchema, null, 2)}`);
