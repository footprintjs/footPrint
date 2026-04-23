/**
 * Live Demo: Claude Agent + FootPrint Tool Calling
 *
 * Enter your Anthropic API key in the INPUT panel below, then click Run.
 * Claude will call the credit-decision flowchart as a tool and explain
 * the result using the automatic causal trace.
 *
 * INPUT example:
 * {
 *   "apiKey": "sk-ant-api03-...",
 *   "model": "claude-haiku-4-5-20251001",
 *   "applicant": {
 *     "applicantName": "Sarah Chen",
 *     "creditScore": 720,
 *     "monthlyIncome": 5000,
 *     "monthlyDebts": 1800
 *   }
 * }
 *
 * Available models (cheapest → most capable):
 *   claude-haiku-4-5-20251001   — default, ~$0.0001/run
 *   claude-3-7-sonnet-20250219  — hybrid reasoning
 *   claude-sonnet-4-6           — smarter explanations
 *   claude-opus-4-5             — most capable
 */

import { flowChart, FlowChartExecutor, decide, MetricRecorder, DebugRecorder } from 'footprintjs';
import { z } from 'zod';

(async () => {

const { apiKey, model: inputModel, applicant: app } = INPUT as {
  apiKey: string;
  model?: string;
  applicant: { applicantName: string; creditScore: number; monthlyIncome: number; monthlyDebts: number };
};

const model = inputModel ?? 'claude-haiku-4-5-20251001';
console.log(`Using model: ${model}`);

if (!apiKey) {
  console.error('Add your Anthropic API key to the INPUT panel: { "apiKey": "sk-ant-..." }');
  return;
}

// ── Credit Decision Flowchart ─────────────────────────────────────────

interface CreditState {
  dti: number;
  riskFactors: string[];
  decision: string;
}

const creditDecision = flowChart<CreditState>(
  'AssessCredit',
  async (scope) => {
    const input = scope.$getArgs<typeof app>();
    scope.dti = Math.round((input.monthlyDebts / input.monthlyIncome) * 100) / 100;
    scope.riskFactors = [];
    console.log(`  Assessing: ${input.applicantName} — score ${input.creditScore}, DTI ${scope.dti}`);
  },
  'assess-credit',
  undefined,
  'Compute debt-to-income ratio and assess credit profile',
)
  .addDeciderFunction(
    'CreditDecision',
    (scope) => {
      const args = scope.$getArgs<typeof app>();
      return decide(
        scope,
        [
          {
            when: (s) => args.creditScore >= 700 && s.dti < 0.43,
            then: 'approved',
            label: 'Strong credit profile',
          },
          {
            when: () => args.creditScore < 580,
            then: 'rejected',
            label: 'Credit score below minimum',
          },
        ],
        'manual-review',
      );
    },
    'credit-decision',
    'Route based on credit score and debt-to-income ratio',
  )
  .addFunctionBranch(
    'approved',
    'Approve',
    async (scope) => {
      const input = scope.$getArgs<typeof app>();
      scope.decision = `APPROVED — ${input.applicantName}`;
    },
    'Issue approval',
  )
  .addFunctionBranch(
    'rejected',
    'Reject',
    async (scope) => {
      const input = scope.$getArgs<typeof app>();
      scope.decision = `REJECTED — ${input.applicantName}: credit score below minimum`;
    },
    'Issue rejection',
  )
  .addFunctionBranch(
    'manual-review',
    'ManualReview',
    async (scope) => {
      const input = scope.$getArgs<typeof app>();
      scope.decision = `MANUAL REVIEW — ${input.applicantName}`;
    },
    'Flag for underwriter',
  )
  .setDefault('manual-review')
  .end()
  .contract({
    input: z.object({
      applicantName: z.string(),
      creditScore: z.number(),
      monthlyIncome: z.number(),
      monthlyDebts: z.number(),
    }),
  })
  .build();

// ── Expose as tool ────────────────────────────────────────────────────

const mcpTool = creditDecision.toMCPTool();
console.log('Tool ready:', mcpTool.name);
console.log();

// Anthropic SDK uses input_schema (snake_case), not inputSchema
const anthropicTool = {
  name: mcpTool.name,
  description: mcpTool.description,
  input_schema: mcpTool.inputSchema,
};

// ── Claude Agent ──────────────────────────────────────────────────────

const client = new Anthropic({ apiKey, dangerouslyAllowBrowser: true });

console.log(`Asking Claude to assess: ${app.applicantName}`);
console.log();

const first = await client.messages.create({
  model,
  max_tokens: 512,
  tools: [anthropicTool],
  messages: [
    {
      role: 'user',
      content: `Please assess this loan application:\n${JSON.stringify(app, null, 2)}`,
    },
  ],
});

const toolUse = first.content.find((b) => b.type === 'tool_use');
if (!toolUse || toolUse.type !== 'tool_use') {
  console.log('Claude did not call the tool. Response:', first.content);
  return;
}

console.log('Claude called:', toolUse.name);
console.log('Inputs:', JSON.stringify(toolUse.input, null, 2));
console.log();

// ── Run footprint with Claude's inputs ───────────────────────────────

const metricsRecorder = new MetricRecorder();
const debugRecorder = new DebugRecorder();

const executor = new FlowChartExecutor(creditDecision);
executor.enableNarrative();
executor.attachRecorder(metricsRecorder);
executor.attachRecorder(debugRecorder);
await executor.run({ input: toolUse.input });

const narrativeLines = executor.getNarrativeEntries().map(e => e.text);
const snapshot = executor.getSnapshot();
const decision = (snapshot.sharedState as any).decision;

console.log('=== Causal Trace ===');
narrativeLines.forEach((line) => console.log(' ', line));
console.log();

console.log('=== Metrics ===');
const aggMetrics = metricsRecorder.getMetrics();
console.log(`  Total: ${aggMetrics.totalDuration}ms · ${aggMetrics.totalReads} reads · ${aggMetrics.totalWrites} writes`);
for (const [, m] of aggMetrics.stageMetrics) {
  console.log(`  [${m.stageName}] ${m.totalDuration}ms · ${m.readCount} reads · ${m.writeCount} writes`);
}
console.log();

console.log('=== Debug Trace ===');
debugRecorder.getEntries().forEach((entry) => {
  if (entry.type === 'read' || entry.type === 'write') {
    const d = entry.data as { key: string; value: unknown };
    console.log(`  [${entry.type}] ${entry.stageName} · ${d.key} = ${JSON.stringify(d.value)}`);
  }
});
console.log();

// ── Feed trace back to Claude ─────────────────────────────────────────

const final = await client.messages.create({
  model,
  max_tokens: 512,
  tools: [anthropicTool],
  messages: [
    {
      role: 'user',
      content: `Please assess this loan application:\n${JSON.stringify(app, null, 2)}`,
    },
    { role: 'assistant', content: first.content },
    {
      role: 'user',
      content: [
        {
          type: 'tool_result',
          tool_use_id: toolUse.id,
          content: JSON.stringify({ decision, trace: narrativeLines }),
        },
      ],
    },
  ],
});

const textBlock = final.content.find((b) => b.type === 'text');
if (textBlock && textBlock.type === 'text') {
  console.log("=== Claude's Explanation ===");
  console.log(textBlock.text);
}

})().catch(console.error);
