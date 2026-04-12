/**
 * LLM Integration: Claude Agent + FootPrint Tool Calling
 *
 * Demonstrates how to expose a FootPrint flowchart as a tool for a Claude agent.
 * The unique value: FootPrint automatically captures WHY the credit decision was
 * made (which conditions passed/failed, which values were compared). Claude reads
 * the causal trace back and explains the decision in plain language — no extra
 * instrumentation needed.
 *
 * Pattern:
 *   1. Build flowchart with decide() for evidence capture
 *   2. chart.toMCPTool() → tool descriptor (name, description, inputSchema)
 *   3. Claude calls the tool via tool_use
 *   4. Run flowchart with Claude's inputs, capture narrative
 *   5. Return { result, trace } as tool_result
 *   6. Claude explains the decision using the trace
 *
 * Run:  ANTHROPIC_API_KEY=sk-ant-... npm run integration:llm-claude
 * Try it: https://footprintjs.github.io/footprint-playground/samples/llm-agent-tool
 */

import Anthropic from '@anthropic-ai/sdk';
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

// ── Expose as Anthropic tool ───────────────────────────────────────────────
// toMCPTool() returns { name, description, inputSchema } (camelCase).
// Anthropic SDK uses input_schema (snake_case) — convert here.

const mcpTool = creditDecision.toMCPTool();
const anthropicTool: Anthropic.Tool = {
  name: mcpTool.name,
  description: mcpTool.description,
  input_schema: mcpTool.inputSchema as Anthropic.Tool['input_schema'],
};

console.log('=== Claude Agent + FootPrint Tool Calling ===\n');
console.log('Tool descriptor:');
console.log(`  name:        ${mcpTool.name}`);
console.log(`  description: ${mcpTool.description}`);
console.log('  inputSchema:', JSON.stringify(mcpTool.inputSchema, null, 4).replace(/\n/g, '\n  '));

// ── Run the agent ──────────────────────────────────────────────────────────

const testApplicant = {
  applicantName: 'Sarah Chen',
  creditScore: 720,
  monthlyIncome: 5000,
  monthlyDebts: 1800,
};

(async () => {
  const client = new Anthropic();

  // Step 1: Ask Claude to assess the application — it will call the tool
  console.log('\n--- Step 1: Claude decides to call the tool ---\n');

  const firstResponse = await client.messages.create({
    model: 'claude-opus-4-5',
    max_tokens: 1024,
    tools: [anthropicTool],
    messages: [
      {
        role: 'user',
        content: `Please assess this loan application and tell me whether it should be approved: ${JSON.stringify(testApplicant)}`,
      },
    ],
  });

  // Find the tool_use block
  const toolUseBlock = firstResponse.content.find(
    (block): block is Anthropic.ToolUseBlock => block.type === 'tool_use',
  );

  if (!toolUseBlock) {
    console.log('Claude responded without calling the tool:');
    firstResponse.content.forEach((block) => {
      if (block.type === 'text') console.log(block.text);
    });
    return;
  }

  console.log('Claude called:', toolUseBlock.name);
  console.log('With input:', JSON.stringify(toolUseBlock.input, null, 2));

  // Step 2: Run the flowchart with Claude's input — capture causal trace
  console.log('\n--- Step 2: Running FootPrint flowchart ---\n');

  const executor = new FlowChartExecutor(creditDecision);
  executor.enableNarrative();
  await executor.run({ input: toolUseBlock.input as Record<string, unknown> });

  const snapshot = executor.getSnapshot();
  const decision = (snapshot.sharedState as unknown as CreditState).decision;
  const narrative = executor.getNarrative();

  console.log('Decision:', decision);
  console.log('\nCausal trace (captured by FootPrint):');
  narrative.forEach((line) => console.log(`  ${line}`));

  // Step 3: Feed result + trace back to Claude for explanation
  console.log('\n--- Step 3: Claude explains the decision using the trace ---\n');

  const secondResponse = await client.messages.create({
    model: 'claude-opus-4-5',
    max_tokens: 1024,
    tools: [anthropicTool],
    messages: [
      {
        role: 'user',
        content: `Please assess this loan application and tell me whether it should be approved: ${JSON.stringify(testApplicant)}`,
      },
      {
        role: 'assistant',
        content: firstResponse.content,
      },
      {
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: toolUseBlock.id,
            content: JSON.stringify({ decision, trace: narrative }),
          },
        ],
      },
    ],
  });

  const explanation = secondResponse.content
    .filter((block): block is Anthropic.TextBlock => block.type === 'text')
    .map((block) => block.text)
    .join('\n');

  console.log("Claude's explanation:");
  console.log(explanation);
  console.log('\n=== Done ===');
  console.log('The causal trace is what makes this possible — FootPrint captured the WHY automatically.');
})().catch((err) => {
  if (err.message?.includes('ANTHROPIC_API_KEY')) {
    console.error('Set ANTHROPIC_API_KEY to run this sample.');
    console.error('  export ANTHROPIC_API_KEY=sk-ant-...');
  } else {
    console.error(err);
  }
  process.exit(1);
});
