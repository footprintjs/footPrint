/**
 * LLM Integration: LangChain Agent + FootPrint Tool
 *
 * Same credit-decision flowchart, this time consumed by a LangChain agent.
 * FootPrint's toMCPTool() provides the name and description; the input schema
 * is expressed as Zod for LangChain's tool() helper.
 *
 * Run:  ANTHROPIC_API_KEY=sk-ant-... npm run integration:llm-langchain
 * Try it: https://footprintjs.github.io/footprint-playground/samples/llm-agent-tool
 */

import { z } from 'zod';
import { tool } from '@langchain/core/tools';
import { ChatAnthropic } from '@langchain/anthropic';
import { HumanMessage, AIMessage, ToolMessage } from '@langchain/core/messages';
import { flowChart, FlowChartExecutor, decide } from 'footprintjs';

// ── State interface ────────────────────────────────────────────────────────

interface CreditState {
  creditScore: number;
  dti: number;        // debt-to-income ratio
  riskFactors: string[];
  decision: string;
}

// ── Build the credit decision flowchart ───────────────────────────────────

const creditDecision = flowChart<CreditState>(
  'AssessCredit',
  async (scope) => {
    const app = scope.$getArgs<{
      creditScore: number;
      monthlyIncome: number;
      monthlyDebts: number;
      applicantName: string;
    }>();
    scope.creditScore = app.creditScore;
    scope.dti = app.monthlyDebts / (app.monthlyIncome / 12);
    scope.riskFactors = [];
  },
  'assess-credit',
  undefined,
  'Compute debt-to-income ratio and pull credit assessment',
)
  .addDeciderFunction(
    'CreditDecision',
    (scope) => {
      return decide(scope, [
        {
          when: { creditScore: { gte: 700 }, dti: { lt: 0.43 } },
          then: 'approved',
          label: 'Strong credit profile',
        },
        {
          when: { creditScore: { lt: 580 } },
          then: 'rejected',
          label: 'Credit score below minimum',
        },
      ], 'manual-review');
    },
    'credit-decision',
    'Route to approval, rejection, or manual review based on risk profile',
  )
    .addFunctionBranch('approved', 'Approve', async (scope) => {
      const app = scope.$getArgs<{ applicantName: string }>();
      scope.decision = `APPROVED — ${app.applicantName}`;
    }, 'approve')
    .addFunctionBranch('rejected', 'Reject', async (scope) => {
      const app = scope.$getArgs<{ applicantName: string }>();
      scope.decision = `REJECTED — ${app.applicantName}: ${scope.riskFactors.join('; ') || 'credit score below minimum'}`;
    }, 'reject')
    .addFunctionBranch('manual-review', 'ManualReview', async (scope) => {
      const app = scope.$getArgs<{ applicantName: string }>();
      scope.decision = `MANUAL REVIEW — ${app.applicantName}`;
    }, 'manual-review')
    .setDefault('manual-review')
    .end()
  .contract({
    input: z.object({
      creditScore: z.number().describe('FICO credit score (300–850)'),
      monthlyIncome: z.number().describe('Gross monthly income in USD'),
      monthlyDebts: z.number().describe('Total monthly debt payments in USD'),
      applicantName: z.string().describe('Full name of the applicant'),
    }),
  })
  .build();

// ── Get the tool descriptor from FootPrint ────────────────────────────────

const mcpTool = creditDecision.toMCPTool();

console.log('=== LangChain Agent + FootPrint Tool ===\n');
console.log('Tool descriptor from FootPrint:');
console.log(`  name:        ${mcpTool.name}`);
console.log(`  description: ${mcpTool.description}`);

// ── Wrap as a LangChain tool ──────────────────────────────────────────────
// LangChain's tool() takes a Zod schema directly. We define it inline so
// TypeScript can infer the argument types for the execute function.

const creditTool = tool(
  async (rawInput: unknown) => {
    const { creditScore, monthlyIncome, monthlyDebts, applicantName } = rawInput as {
      creditScore: number;
      monthlyIncome: number;
      monthlyDebts: number;
      applicantName: string;
    };
    const executor = new FlowChartExecutor(creditDecision);
    executor.enableNarrative();
    await executor.run({ input: { creditScore, monthlyIncome, monthlyDebts, applicantName } });

    const snapshot = executor.getSnapshot();
    const decision = (snapshot.sharedState as unknown as CreditState).decision;
    const trace = executor.getNarrative();

    return JSON.stringify({ decision, trace });
  },
  {
    name: mcpTool.name,
    description: mcpTool.description,
    schema: z.object({
      creditScore: z.number().describe('FICO credit score (300-850)'),
      monthlyIncome: z.number().describe('Gross monthly income in USD'),
      monthlyDebts: z.number().describe('Total monthly debt payments in USD'),
      applicantName: z.string().describe('Full name of the applicant'),
    }),
  },
);

// ── Run the LangChain agent ────────────────────────────────────────────────

(async () => {
  const model = new ChatAnthropic({ model: 'claude-opus-4-5' }).bindTools([creditTool]);

  const humanMessage = new HumanMessage(
    'Assess this loan application and explain the recommendation: ' +
    'Sarah Chen, credit score 720, monthly income $5000, monthly debts $1800',
  );

  // Step 1: Initial invocation — model decides to call the tool
  console.log('\n--- Step 1: Model decides to call the tool ---\n');

  const firstResponse = await model.invoke([humanMessage]);

  const toolCalls = firstResponse.tool_calls ?? [];
  if (toolCalls.length === 0) {
    console.log('Model responded without calling the tool:');
    console.log(firstResponse.content);
    return;
  }

  console.log('Tool called:', toolCalls[0].name);
  console.log('With args:', JSON.stringify(toolCalls[0].args, null, 2));

  // Step 2: Execute all tool calls and collect results
  console.log('\n--- Step 2: Running FootPrint flowchart ---\n');

  const toolMessages: ToolMessage[] = [];
  for (const call of toolCalls) {
    const result = await creditTool.invoke(call.args);
    const parsed = JSON.parse(result);
    console.log('Decision:', parsed.decision);
    console.log('\nCausal trace (captured by FootPrint):');
    (parsed.trace as string[]).forEach((line: string) => console.log(`  ${line}`));
    toolMessages.push(new ToolMessage({ content: result, tool_call_id: call.id! }));
  }

  // Step 3: Feed tool results back — model explains the decision
  console.log('\n--- Step 3: Model explains using the causal trace ---\n');

  const finalResponse = await model.invoke([
    humanMessage,
    firstResponse as AIMessage,
    ...toolMessages,
  ]);

  console.log("Model's explanation:");
  console.log(
    typeof finalResponse.content === 'string'
      ? finalResponse.content
      : JSON.stringify(finalResponse.content),
  );

  console.log('\n=== Done ===');
  console.log('The causal trace gave the model the WHY — not just the outcome.');
})().catch((err) => {
  if (err.message?.includes('ANTHROPIC_API_KEY')) {
    console.error('Set ANTHROPIC_API_KEY to run this sample.');
    console.error('  export ANTHROPIC_API_KEY=sk-ant-...');
  } else {
    console.error(err);
  }
  process.exit(1);
});
