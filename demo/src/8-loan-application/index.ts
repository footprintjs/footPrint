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
 * - Every stage writes its reasoning to scope — not just the result, but WHY
 * - The decider reads from scope and the narrative captures the decision + rationale
 * - NarrativeGenerator produces plain-English execution story
 * - The LLM gets everything it needs to answer follow-ups — no reconstruction
 *
 * BUILDS ON: Demo 3 (Decider)
 */

import { FlowChartBuilder, FlowChartExecutor, BaseState, StageContext } from 'footprint';

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
 *
 * The creditTier is the first input to the risk assessment.
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
// Scope Factory
// ============================================================================

/**
 * Creates a scope instance for each stage.
 */
const scopeFactory = (ctx: any, stageName: string, readOnly?: unknown) => {
  return new BaseState(ctx, stageName, readOnly);
};

// ============================================================================
// Flow Builder
// ============================================================================

/**
 * Builds the loan application processing flow.
 *
 * Stage descriptions flow into the narrative — they become the human-readable
 * story that the LLM uses to answer follow-up questions.
 */
export function buildLoanApplicationFlow() {
  return new FlowChartBuilder()
    .setEnableNarrative()
    .start(
      'ReceiveApplication',
      receiveApplication,
      'receive-app',
      'Receive Application',
      'received the loan application and captured applicant data',
    )
    .addFunction(
      'PullCreditReport',
      pullCreditReport,
      'pull-credit',
      'Pull Credit Report',
      'pulled the credit report and classified the credit tier',
    )
    .addFunction(
      'CalculateDTI',
      calculateDTI,
      'calc-dti',
      'Calculate DTI',
      'calculated the debt-to-income ratio from income and monthly debts',
    )
    .addFunction(
      'VerifyEmployment',
      verifyEmployment,
      'verify-emp',
      'Verify Employment',
      'verified employment status and tenure',
    )
    .addFunction(
      'AssessRisk',
      assessRisk,
      'assess-risk',
      'Assess Risk',
      'assessed overall risk by combining credit, DTI, and employment factors',
    )
    .addDeciderFunction(
      'LoanDecision',
      loanDecisionRouter as any,
      'loan-decision',
      'Loan Decision',
      'evaluated the risk tier to determine the loan outcome',
    )
      .addFunctionBranch(
        'approved',
        'ApproveApplication',
        approveApplication,
        'Approve Application',
        'Application approved — all risk factors within acceptable limits',
      )
      .addFunctionBranch(
        'rejected',
        'RejectApplication',
        rejectApplication,
        'Reject Application',
        'Application rejected — risk factors exceed acceptable thresholds',
      )
      .addFunctionBranch(
        'manual-review',
        'ManualReview',
        manualReviewApplication,
        'Manual Review',
        'Application forwarded for manual review — borderline risk factors',
      )
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

// ============================================================================
// Demo Execution
// ============================================================================

/**
 * Runs the loan application pipeline and returns narrative + data trace.
 *
 * This is the core of the demo: after execution, you get TWO things:
 * 1. The pipeline narrative (what happened and why)
 * 2. The data narrative (what was read and written at each stage)
 *
 * Combined, any LLM can answer "why was I rejected?" without reconstruction.
 */
export async function runLoanApplication(application: LoanApplication) {
  setCurrentApplication(application);

  const flowChart = buildLoanApplicationFlow();
  const executor = new FlowChartExecutor(flowChart, scopeFactory);

  await executor.run();

  // Get the execution narrative (what happened and why)
  const narrative = executor.getNarrative();

  return { narrative };
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

  const { narrative } = await runLoanApplication(app);

  // ── The execution narrative (what happened and why) ──
  console.log('\n' + '-'.repeat(72));
  console.log('  EXECUTION NARRATIVE (what the LLM receives):');
  console.log('-'.repeat(72));
  for (const sentence of narrative) {
    console.log(`  ${sentence}`);
  }

  // ── The punchline ──
  console.log('\n' + '-'.repeat(72));
  console.log('  THE PUNCHLINE:');
  console.log('-'.repeat(72));
  console.log(`
  Without FootPrint, the LLM must reconstruct the rejection reason from
  disconnected logs. It might hallucinate, miss a factor, or require
  multiple expensive tool calls to piece together the story.

  With FootPrint, the LLM receives the narrative above AS-IS.
  Even a $0.25 model can now answer:

    User: "Why was my loan rejected?"
    LLM:  "Your application was rejected because your credit score of 580
           falls in the 'fair' tier with below-average credit history,
           your debt-to-income ratio of 60% exceeds the 43% maximum,
           and your self-employment tenure of 1 year is below the
           2-year minimum. These factors combined placed you in the
           'high' risk tier, which triggered automatic rejection."

  That answer came from the trace — not from the LLM's imagination.
`);

  // ── Now show the approved case for contrast ──
  console.log('='.repeat(72));
  console.log('  For contrast, here is the APPROVED narrative:');
  console.log('='.repeat(72));

  const approvedResult = await runLoanApplication(sampleApplications.approved);
  for (const sentence of approvedResult.narrative) {
    console.log(`  ${sentence}`);
  }

  console.log('\n' + '='.repeat(72));
  console.log('  The difference is in the decision branch — same pipeline,');
  console.log('  different data, different narrative. No reconstruction needed.');
  console.log('='.repeat(72) + '\n');
}

main().catch(console.error);
