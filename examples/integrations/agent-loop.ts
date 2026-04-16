/**
 * Agent Loop (Pure FootPrint) — ReAct Pattern with Just Primitives
 *
 * Shows how to build an agent loop using only footprintjs primitives:
 *   flowChart + decide() + loopTo + $break.
 *
 * No separate agent library needed — the decider drives the loop,
 * and the narrative captures every reasoning step automatically.
 *
 *   ReceiveQuery ──> Reason ──> [ billing | shipping | account | finalize ]
 *                     ↑                                ↓
 *                     └──────── Observe ←──────────────┘
 *
 * Try it: https://footprintjs.github.io/footprint-playground/samples/agent-loop
 */

import { flowChart, FlowChartExecutor, decide } from 'footprintjs';

interface AgentState {
  userQuery: string;
  toolsCalled: string[];
  gatheredInfo: Record<string, string>;
  finalAnswer?: string;
  iteration: number;
  maxIterations: number;
}

// Mock tools — in production these would be real API calls.
const tools = {
  getBillingInfo: () => 'Account balance: $120.00, next payment 2026-05-01.',
  getShippingStatus: () => 'Order #1234 shipped yesterday, arrives Friday.',
  getAccountDetails: () => 'Member since 2023, tier: Premium.',
};

declare const INPUT: { userQuery: string } | undefined;

(async () => {
  const chart = flowChart<AgentState>('ReceiveQuery', async (scope) => {
    const input = INPUT ?? { userQuery: 'When will my order arrive?' };
    scope.userQuery = input.userQuery;
    scope.toolsCalled = [];
    scope.gatheredInfo = {};
    scope.iteration = 0;
    scope.maxIterations = 5;
  }, 'receive-query', 'Accept the user question and initialize agent state')

    .addDeciderFunction('Reason', (scope) => {
      scope.iteration++;
      const q = scope.userQuery.toLowerCase();

      return decide(scope, [
        // If we've already gathered info, respond.
        { when: (s) => s.toolsCalled.length > 0, then: 'finalize', label: 'Have info from tools — respond' },
        // Route by keyword.
        { when: (s) => /bill|payment/.test(q) && !s.toolsCalled.includes('billing'),   then: 'billing',  label: 'Billing keywords detected' },
        { when: (s) => /order|ship/.test(q)    && !s.toolsCalled.includes('shipping'), then: 'shipping', label: 'Shipping keywords detected' },
        { when: (s) => /account|member/.test(q) && !s.toolsCalled.includes('account'),  then: 'account',  label: 'Account keywords detected' },
      ], 'finalize');
    }, 'reason', 'Decide whether to call a tool or respond to the user')

      .addFunctionBranch('billing', 'CallBillingTool', async (scope) => {
        scope.gatheredInfo.billing = tools.getBillingInfo();
        scope.toolsCalled.push('billing');
      }, 'Call the billing API')

      .addFunctionBranch('shipping', 'CallShippingTool', async (scope) => {
        scope.gatheredInfo.shipping = tools.getShippingStatus();
        scope.toolsCalled.push('shipping');
      }, 'Call the shipping API')

      .addFunctionBranch('account', 'CallAccountTool', async (scope) => {
        scope.gatheredInfo.account = tools.getAccountDetails();
        scope.toolsCalled.push('account');
      }, 'Call the account API')

      .addFunctionBranch('finalize', 'Respond', async (scope) => {
        const evidence = Object.values(scope.gatheredInfo).join(' ');
        scope.finalAnswer = evidence
          ? `Here's what I found: ${evidence}`
          : `Sorry, I couldn't determine how to help with: "${scope.userQuery}"`;
        scope.$break();
      }, 'Compose the final answer and exit the loop')

      .setDefault('finalize')
    .end()
    .loopTo('reason')
    .build();

  const executor = new FlowChartExecutor(chart);
  executor.enableNarrative();
  await executor.run();

  console.log('=== Agent Loop (Pure FootPrint) ===\n');
  executor.getNarrative().forEach((line) => console.log(`  ${line}`));

  const { sharedState } = executor.getSnapshot();
  console.log(`\nFinal answer: ${sharedState.finalAnswer}`);
  console.log(`Iterations: ${sharedState.iteration}`);
  console.log(`Tools called: ${(sharedState.toolsCalled as string[]).join(', ') || 'none'}`);
})().catch(console.error);
