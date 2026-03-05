/**
 * Demo 8: Loan Application — Why Was I Rejected?
 *
 * WHY THIS EXAMPLE EXISTS:
 * When your AI application rejects a loan, the user asks "why?"
 * Without causal traces, the LLM must reconstruct the reasoning from raw logs.
 * That reconstruction is expensive (tokens), slow (multiple turns), and unreliable
 * (hallucinations when context is missing).
 *
 * With FootPrint, the narrative is produced AS the pipeline executes.
 * The LLM gets a ready-made causal chain — even a cheap model can answer accurately.
 *
 * PATTERN: Linear stages → Decider → (Approved | Rejected | Manual Review)
 *
 * PIPELINE:
 * 1. ReceiveApplication — Capture applicant data
 * 2. PullCreditReport  — Simulate credit bureau lookup, write creditScore/creditTier
 * 3. CalculateDTI       — Compute debt-to-income ratio from income and debts
 * 4. VerifyEmployment   — Check employment status and duration
 * 5. AssessRisk          — Combine all factors into a risk tier
 * 6. LoanDecision        — Route to approved/rejected/manual-review based on riskTier
 *
 * KEY CONCEPTS:
 * - Stage functions just read/write scope — the narrative captures it automatically
 * - No verbose descriptions needed in the builder — stage names suffice
 * - NarrativeRecorder captures every read/write/delete as ordered steps
 * - CombinedNarrativeBuilder merges flow-level + step-level into one output
 * - The LLM gets everything it needs to answer follow-ups — no reconstruction
 *
 * BUILDS ON: Demo 3 (Decider)
 */

import {
  FlowChartBuilder,
  FlowChartExecutor,
  BaseState,
  NarrativeRecorder,
  CombinedNarrativeBuilder,
} from 'footprint';

// ============================================================================
// Types
// ============================================================================

export interface LoanApplication {
  applicantName: string;
  annualIncome: number;
  monthlyDebts: number;
  creditScore: number;
  employmentStatus: 'employed' | 'self-employed' | 'unemployed';
  employmentYears: number;
  loanAmount: number;
  loanPurpose: string;
}

export type RiskTier = 'low' | 'medium' | 'high';
export type LoanOutcome = 'approved' | 'rejected' | 'manual-review';

// ============================================================================
// Sample Applications
// ============================================================================

export const sampleApplications: Record<string, LoanApplication> = {
  /** Strong applicant — should be approved */
  approved: {
    applicantName: 'Alice Chen',
    annualIncome: 95000,
    monthlyDebts: 800,
    creditScore: 760,
    employmentStatus: 'employed',
    employmentYears: 6,
    loanAmount: 25000,
    loanPurpose: 'home renovation',
  },
  /** Weak applicant — should be rejected */
  rejected: {
    applicantName: 'Bob Martinez',
    annualIncome: 42000,
    monthlyDebts: 2100,
    creditScore: 580,
    employmentStatus: 'self-employed',
    employmentYears: 1,
    loanAmount: 40000,
    loanPurpose: 'debt consolidation',
  },
  /** Borderline applicant — should go to manual review */
  manualReview: {
    applicantName: 'Carol Patel',
    annualIncome: 68000,
    monthlyDebts: 1400,
    creditScore: 650,
    employmentStatus: 'employed',
    employmentYears: 3,
    loanAmount: 30000,
    loanPurpose: 'car purchase',
  },
};

// Current application being processed (set before each run)
let currentApplication: LoanApplication = sampleApplications.rejected;

export function setCurrentApplication(app: LoanApplication) {
  currentApplication = app;
}

// ============================================================================
// Stage Functions
// ============================================================================

/**
 * Stage 1: Receive and validate the loan application.
 * Writes all applicant data to scope so downstream stages can read it.
 */
const receiveApplication = async (scope: BaseState) => {
  const app = currentApplication;
  scope.setValue('applicantName', app.applicantName);
  scope.setValue('annualIncome', app.annualIncome);
  scope.setValue('monthlyDebts', app.monthlyDebts);
  scope.setValue('rawCreditScore', app.creditScore);
  scope.setValue('employmentStatus', app.employmentStatus);
  scope.setValue('employmentYears', app.employmentYears);
  scope.setValue('loanAmount', app.loanAmount);
  scope.setValue('loanPurpose', app.loanPurpose);
};

/**
 * Stage 2: Pull credit report and classify into tiers.
 *
 * Reads: rawCreditScore
 * Writes: creditScore, creditTier, creditFlags
 */
const pullCreditReport = async (scope: BaseState) => {
  const score = scope.getValue('rawCreditScore') as number;

  let creditTier: string;
  const creditFlags: string[] = [];

  if (score >= 740) {
    creditTier = 'excellent';
  } else if (score >= 670) {
    creditTier = 'good';
  } else if (score >= 580) {
    creditTier = 'fair';
    creditFlags.push('below-average credit history');
  } else {
    creditTier = 'poor';
    creditFlags.push('significant credit issues');
  }

  scope.setValue('creditScore', score);
  scope.setValue('creditTier', creditTier);
  scope.setValue('creditFlags', creditFlags);
};

/**
 * Stage 3: Calculate debt-to-income ratio.
 *
 * Reads: annualIncome, monthlyDebts
 * Writes: dtiRatio, dtiStatus, dtiFlags
 *
 * DTI > 43% is a hard rejection threshold per lending guidelines.
 * DTI 36-43% triggers caution flags.
 */
const calculateDTI = async (scope: BaseState) => {
  const annualIncome = scope.getValue('annualIncome') as number;
  const monthlyDebts = scope.getValue('monthlyDebts') as number;
  const monthlyIncome = annualIncome / 12;

  const dtiRatio = Math.round((monthlyDebts / monthlyIncome) * 100) / 100;
  const dtiPercent = Math.round(dtiRatio * 100);

  let dtiStatus: string;
  const dtiFlags: string[] = [];

  if (dtiPercent <= 35) {
    dtiStatus = 'healthy';
  } else if (dtiPercent <= 43) {
    dtiStatus = 'elevated';
    dtiFlags.push(`DTI at ${dtiPercent}% approaches the 43% limit`);
  } else {
    dtiStatus = 'excessive';
    dtiFlags.push(`DTI at ${dtiPercent}% exceeds the 43% maximum`);
  }

  scope.setValue('dtiRatio', dtiRatio);
  scope.setValue('dtiPercent', dtiPercent);
  scope.setValue('dtiStatus', dtiStatus);
  scope.setValue('dtiFlags', dtiFlags);
};

/**
 * Stage 4: Verify employment.
 *
 * Reads: employmentStatus, employmentYears
 * Writes: employmentVerified, employmentFlags
 */
const verifyEmployment = async (scope: BaseState) => {
  const status = scope.getValue('employmentStatus') as string;
  const years = scope.getValue('employmentYears') as number;

  let employmentVerified = true;
  const employmentFlags: string[] = [];

  if (status === 'unemployed') {
    employmentVerified = false;
    employmentFlags.push('applicant is currently unemployed');
  } else if (status === 'self-employed' && years < 2) {
    employmentFlags.push(`self-employed for only ${years} year(s) — less than 2-year minimum`);
  } else if (years < 1) {
    employmentFlags.push(`employment tenure of ${years} year(s) is below 1-year minimum`);
  }

  scope.setValue('employmentVerified', employmentVerified);
  scope.setValue('employmentFlags', employmentFlags);
};

/**
 * Stage 5: Assess overall risk by combining all factors.
 *
 * Reads: creditTier, creditFlags, dtiStatus, dtiFlags, employmentFlags, loanAmount, annualIncome
 * Writes: riskTier, riskFactors, riskSummary
 *
 * This is where the causal chain converges. The riskTier determines
 * which branch the decider takes.
 */
const assessRisk = async (scope: BaseState) => {
  const creditTier = scope.getValue('creditTier') as string;
  const dtiStatus = scope.getValue('dtiStatus') as string;
  const employmentVerified = scope.getValue('employmentVerified') as boolean;
  const creditFlags = (scope.getValue('creditFlags') as string[]) || [];
  const dtiFlags = (scope.getValue('dtiFlags') as string[]) || [];
  const employmentFlags = (scope.getValue('employmentFlags') as string[]) || [];
  const loanAmount = scope.getValue('loanAmount') as number;
  const annualIncome = scope.getValue('annualIncome') as number;

  // Collect all risk factors
  const riskFactors = [...creditFlags, ...dtiFlags, ...employmentFlags];

  // Check loan-to-income ratio
  const ltiRatio = loanAmount / annualIncome;
  if (ltiRatio > 0.5) {
    riskFactors.push(
      `loan amount ($${loanAmount.toLocaleString()}) is ${Math.round(ltiRatio * 100)}% of annual income`,
    );
  }

  // Determine risk tier
  let riskTier: RiskTier;

  if (!employmentVerified || dtiStatus === 'excessive' || creditTier === 'poor') {
    riskTier = 'high';
  } else if (
    creditTier === 'fair' ||
    dtiStatus === 'elevated' ||
    riskFactors.length > 0
  ) {
    riskTier = 'medium';
  } else {
    riskTier = 'low';
  }

  const riskSummary =
    riskFactors.length > 0
      ? `Risk tier: ${riskTier}. Factors: ${riskFactors.join('; ')}.`
      : `Risk tier: ${riskTier}. No adverse factors identified.`;

  scope.setValue('riskTier', riskTier);
  scope.setValue('riskFactors', riskFactors);
  scope.setValue('riskSummary', riskSummary);
};

/**
 * Decider: Route based on riskTier.
 *
 * Reads: riskTier, riskSummary
 * Returns: branch ID ('approved', 'rejected', or 'manual-review')
 *
 * The decider sets deciderRationale so the narrative captures WHY
 * this branch was chosen — this is the key differentiator from raw logs.
 */
const loanDecisionRouter = (scope: BaseState): string => {
  const riskTier = scope.getValue('riskTier') as RiskTier;
  const riskSummary = scope.getValue('riskSummary') as string;

  // Set rationale for narrative generation
  scope.addDebugInfo('deciderRationale', riskSummary);

  if (riskTier === 'low') return 'approved';
  if (riskTier === 'high') return 'rejected';
  return 'manual-review';
};

/**
 * Branch: Application approved.
 */
const approveApplication = async (scope: BaseState) => {
  const name = scope.getValue('applicantName') as string;
  const loanAmount = scope.getValue('loanAmount') as number;
  scope.setValue('decision', 'approved');
  scope.setValue('decisionMessage', `Congratulations ${name}! Your loan of $${loanAmount.toLocaleString()} has been approved.`);
};

/**
 * Branch: Application rejected.
 */
const rejectApplication = async (scope: BaseState) => {
  const name = scope.getValue('applicantName') as string;
  const riskFactors = (scope.getValue('riskFactors') as string[]) || [];
  scope.setValue('decision', 'rejected');
  scope.setValue(
    'decisionMessage',
    `Sorry ${name}, your application was not approved. Key factors: ${riskFactors.join('; ')}.`,
  );
};

/**
 * Branch: Application needs manual review.
 */
const manualReviewApplication = async (scope: BaseState) => {
  const name = scope.getValue('applicantName') as string;
  scope.setValue('decision', 'manual-review');
  scope.setValue('decisionMessage', `${name}, your application has been forwarded for manual review by a loan officer.`);
};

// ============================================================================
// Narrative-Instrumented Scope Factory
// ============================================================================

/**
 * Creates a scope factory that instruments BaseState to feed a NarrativeRecorder.
 *
 * WHY: The NarrativeRecorder captures every getValue/setValue as ordered steps.
 * By wrapping BaseState methods, the consumer gets step-level data narrative
 * (Step 1: Read, Step 2: Write) without changing any stage function code.
 *
 * This is the consumer-side pattern: stage functions stay clean,
 * and the narrative infrastructure is wired up in the scope factory.
 */
function createInstrumentedScopeFactory(recorder: NarrativeRecorder) {
  return (ctx: any, stageName: string, readOnly?: unknown) => {
    const scope = new BaseState(ctx, stageName, readOnly);

    // Wrap getValue to record reads
    const originalGetValue = scope.getValue.bind(scope);
    scope.getValue = (key?: string) => {
      const value = originalGetValue(key);
      recorder.onRead({
        stageName,
        pipelineId: '',
        timestamp: Date.now(),
        key: key ?? '',
        value,
      });
      return value;
    };

    // Wrap setValue to record writes
    const originalSetValue = scope.setValue.bind(scope);
    scope.setValue = (key: string, value: unknown, shouldRedact?: boolean, description?: string) => {
      recorder.onWrite({
        stageName,
        pipelineId: '',
        timestamp: Date.now(),
        key,
        value,
        operation: 'set',
      });
      return originalSetValue(key, value, shouldRedact, description);
    };

    // Wrap updateValue to record updates
    const originalUpdateValue = scope.updateValue.bind(scope);
    scope.updateValue = (key: string, value: unknown, description?: string) => {
      recorder.onWrite({
        stageName,
        pipelineId: '',
        timestamp: Date.now(),
        key,
        value,
        operation: 'update',
      });
      return originalUpdateValue(key, value, description);
    };

    // Wrap deleteValue to record deletes
    const originalDeleteValue = scope.deleteValue.bind(scope);
    scope.deleteValue = (key: string, description?: string) => {
      recorder.onWrite({
        stageName,
        pipelineId: '',
        timestamp: Date.now(),
        key,
        value: undefined,
        operation: 'delete',
      });
      return originalDeleteValue(key, description);
    };

    return scope;
  };
}

// ============================================================================
// Flow Builder
// ============================================================================

/**
 * Builds the loan application processing flow.
 *
 * NOTE: No verbose past-tense descriptions here. Stage names are enough —
 * the NarrativeRecorder captures what each stage actually reads and writes,
 * and CombinedNarrativeBuilder merges that into the narrative automatically.
 */
export function buildLoanApplicationFlow() {
  return new FlowChartBuilder()
    .setEnableNarrative()
    .start('ReceiveApplication', receiveApplication)
    .addFunction('PullCreditReport', pullCreditReport)
    .addFunction('CalculateDTI', calculateDTI)
    .addFunction('VerifyEmployment', verifyEmployment)
    .addFunction('AssessRisk', assessRisk)
    .addDeciderFunction(
      'LoanDecision',
      loanDecisionRouter as any,
    )
      .addFunctionBranch('approved', 'ApproveApplication', approveApplication)
      .addFunctionBranch('rejected', 'RejectApplication', rejectApplication)
      .addFunctionBranch('manual-review', 'ManualReview', manualReviewApplication)
      .setDefault('manual-review')
      .end()
    .build();
}

// ============================================================================
// Exports for testing
// ============================================================================

export const stages = {
  receiveApplication,
  pullCreditReport,
  calculateDTI,
  verifyEmployment,
  assessRisk,
  loanDecisionRouter,
  approveApplication,
  rejectApplication,
  manualReviewApplication,
};

export { createInstrumentedScopeFactory };

// ============================================================================
// Demo Execution
// ============================================================================

/**
 * Runs the loan application pipeline and returns the combined narrative.
 *
 * This is the core of the demo: after execution, you get a COMBINED narrative
 * that weaves together:
 * 1. Flow-level: what stages ran and in what order
 * 2. Step-level: what each stage read and wrote (captured automatically)
 * 3. Conditions: why the decider chose a particular branch
 *
 * No verbose descriptions needed — the narrative builds itself from the data.
 */
export async function runLoanApplication(application: LoanApplication) {
  setCurrentApplication(application);

  // 1. Create a NarrativeRecorder to capture step-level operations
  const recorder = new NarrativeRecorder({ id: 'loan-narrative', detail: 'full' });

  // 2. Build the flow and create an executor with the instrumented scope factory
  const flowChart = buildLoanApplicationFlow();
  const scopeFactory = createInstrumentedScopeFactory(recorder);
  const executor = new FlowChartExecutor(flowChart, scopeFactory);

  // 3. Run the pipeline
  await executor.run();

  // 4. Get the flow-level narrative (what stages ran, which branches were taken)
  const flowNarrative = executor.getNarrative();

  // 5. Combine flow narrative + step-level operations into one unified output
  const builder = new CombinedNarrativeBuilder();
  const combinedNarrative = builder.build(flowNarrative, recorder);

  // Also return the raw pieces for testing
  return {
    combinedNarrative,
    flowNarrative,
    recorder,
  };
}

/**
 * Main demo execution.
 *
 * Run with: npx ts-node -r tsconfig-paths/register -P demo/tsconfig.json demo/src/8-loan-application/index.ts
 */
async function main() {
  console.log('\n' + '='.repeat(72));
  console.log('  Demo 8: Loan Application — "Why Was I Rejected?"');
  console.log('='.repeat(72));

  // Run the REJECTED case — this is the interesting one
  const app = sampleApplications.rejected;
  console.log(`\n  Applicant: ${app.applicantName}`);
  console.log(`  Income: $${app.annualIncome.toLocaleString()}/yr | Debts: $${app.monthlyDebts}/mo`);
  console.log(`  Credit Score: ${app.creditScore} | Employment: ${app.employmentStatus} (${app.employmentYears}yr)`);
  console.log(`  Loan Request: $${app.loanAmount.toLocaleString()} for ${app.loanPurpose}`);

  const { combinedNarrative, recorder } = await runLoanApplication(app);

  // ── The combined narrative (flow + steps + conditions) ──
  console.log('\n' + '-'.repeat(72));
  console.log('  COMBINED NARRATIVE (what the LLM receives):');
  console.log('-'.repeat(72));
  for (const line of combinedNarrative) {
    console.log(`  ${line}`);
  }

  // ── Step-level detail (from NarrativeRecorder) ──
  console.log('\n' + '-'.repeat(72));
  console.log('  STEP-LEVEL DETAIL (per-stage operations):');
  console.log('-'.repeat(72));
  const sentences = recorder.toSentences();
  for (const [stageName, lines] of sentences) {
    console.log(`  ${stageName}:`);
    for (const line of lines) {
      console.log(`  ${line}`);
    }
  }

  // ── The punchline ──
  console.log('\n' + '-'.repeat(72));
  console.log('  THE PUNCHLINE:');
  console.log('-'.repeat(72));
  console.log(`
  No past-tense descriptions were written for any stage.
  The narrative built itself from the actual read/write operations:

    Stage 1: ReceiveApplication
      Step 1: Write applicantName = "Bob Martinez"
      Step 2: Write annualIncome = 42000
      ...
    Stage 3: CalculateDTI
      Step 1: Read annualIncome = 42000
      Step 2: Read monthlyDebts = 2100
      Step 3: Write dtiRatio = 0.6
      Step 4: Write dtiPercent = 60
      Step 5: Write dtiStatus = "excessive"
      Step 6: Write dtiFlags = (1 item)
    [Condition]: risk tier is high → chose "Reject Application"

  The LLM reads this trace and answers:

    User: "Why was my loan rejected?"
    LLM:  "Your DTI of 60% exceeded the 43% maximum, your credit score
           of 580 is in the 'fair' tier, and your self-employment of
           1 year is below the 2-year minimum. Combined risk: high."

  That answer came from the trace — not from the LLM's imagination.
`);

  // ── Approved case for contrast ──
  console.log('='.repeat(72));
  console.log('  For contrast, here is the APPROVED narrative:');
  console.log('='.repeat(72));

  const approvedResult = await runLoanApplication(sampleApplications.approved);
  for (const line of approvedResult.combinedNarrative) {
    console.log(`  ${line}`);
  }

  console.log('\n' + '='.repeat(72));
  console.log('  Same pipeline, different data, different narrative.');
  console.log('  No reconstruction needed.');
  console.log('='.repeat(72) + '\n');
}

main().catch(console.error);
