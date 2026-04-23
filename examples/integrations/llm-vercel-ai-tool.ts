/**
 * LLM Integration: Vercel AI SDK + FootPrint Tool
 *
 * Same credit-decision flowchart with the Vercel AI SDK's tool() helper.
 * maxSteps: 3 lets the model call the tool and then explain the result
 * in a single generateText() call.
 *
 * Run:  ANTHROPIC_API_KEY=sk-ant-... npm run integration:llm-vercel-ai
 * Try it: https://footprintjs.github.io/footprint-playground/samples/llm-agent-tool
 */

import { generateText, tool } from 'ai';
import { createAnthropic } from '@ai-sdk/anthropic';
import { z } from 'zod';
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

console.log('=== Vercel AI SDK + FootPrint Tool ===\n');
console.log('Tool descriptor from FootPrint:');
console.log(`  name:        ${mcpTool.name}`);
console.log(`  description: ${mcpTool.description}`);

// ── Wrap as a Vercel AI SDK tool ──────────────────────────────────────────
// tool() from 'ai' takes parameters (Zod schema) + execute function.
// maxSteps: 3 in generateText allows: think → call tool → explain result.

const anthropic = createAnthropic();

const creditTool = tool({
  description: mcpTool.description,
  parameters: z.object({
    creditScore: z.number().describe('FICO credit score (300-850)'),
    monthlyIncome: z.number().describe('Gross monthly income in USD'),
    monthlyDebts: z.number().describe('Total monthly debt payments in USD'),
    applicantName: z.string().describe('Full name of the applicant'),
  }),
  execute: async ({ creditScore, monthlyIncome, monthlyDebts, applicantName }: { creditScore: number; monthlyIncome: number; monthlyDebts: number; applicantName: string }) => {
    const executor = new FlowChartExecutor(creditDecision);
    executor.enableNarrative();
    await executor.run({ input: { creditScore, monthlyIncome, monthlyDebts, applicantName } });

    const snapshot = executor.getSnapshot();
    const decision = (snapshot.sharedState as unknown as CreditState).decision;
    const trace = executor.getNarrativeEntries().map(e => e.text);

    return { decision, trace };
  },
});

// ── Run with generateText ─────────────────────────────────────────────────

(async () => {
  console.log('\n--- Running generateText (maxSteps: 3) ---\n');

  const { text, steps } = await generateText({
    model: anthropic('claude-opus-4-5'),
    tools: { assess_credit: creditTool },
    maxSteps: 3, // allow: call tool → explain result
    prompt:
      'Assess this loan application and explain your recommendation: ' +
      'Sarah Chen, credit score 720, monthly income $5000, monthly debts $1800',
  });

  // Find the tool call step to surface the causal trace
  const toolStep = steps.find((s: any) => s.toolCalls && s.toolCalls.length > 0);
  if (toolStep) {
    const toolResult = toolStep.toolResults?.[0];
    if (toolResult && 'result' in toolResult) {
      const result = toolResult.result as { decision: string; trace: string[] };
      console.log('Decision returned by flowchart:', result.decision);
      console.log('\nCausal trace (captured by FootPrint):');
      result.trace.forEach((line) => console.log(`  ${line}`));
    }
  }

  console.log('\n--- Final explanation from model ---\n');
  console.log(text);

  console.log('\n=== Done ===');
  console.log('generateText handled the tool call loop automatically.');
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
