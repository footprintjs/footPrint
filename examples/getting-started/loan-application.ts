/**
 * Quick Start — Loan Application
 *
 * A complete loan underwriting pipeline that demonstrates:
 * - Reading input via $getArgs() (readonly, frozen, shared across all stages)
 * - Writing computed values via typed property access (scope.key = value)
 * - Auto-generated narrative trace (enableNarrative() + getNarrative())
 * - Decider-based branching with decide() evidence capture
 *
 * In the playground, edit the INPUT panel (bottom-left) to change applicant data.
 * Try it: https://footprintjs.github.io/footprint-playground/samples/loan-application
 */

import { flowChart, FlowChartExecutor, decide } from 'footprintjs';

declare const INPUT: any;

(async () => {

// ── Input ───────────────────────────────────────────────────────────────
// In the playground, INPUT is provided via the JSON input panel.
// When running standalone, define it here as a fallback.

interface LoanApplication {
  applicantName: string;
  annualIncome: number;
  monthlyDebts: number;
  creditScore: number;
  employmentStatus: 'employed' | 'self-employed' | 'unemployed';
  employmentYears: number;
  loanAmount: number;
}

interface LoanInput {
  app: LoanApplication;
}

const input: LoanInput = (typeof INPUT !== 'undefined' && INPUT) || {
  app: {
    applicantName: 'Bob Martinez',
    annualIncome: 42_000,
    monthlyDebts: 2_100,
    creditScore: 580,
    employmentStatus: 'self-employed',
    employmentYears: 1,
    loanAmount: 40_000,
  },
};

// ── Mock Services ───────────────────────────────────────────────────────

const creditBureau = {
  pullReport: (score: number) => {
    const tier =
      score >= 740 ? 'excellent'
        : score >= 670 ? 'good'
          : score >= 580 ? 'fair'
            : 'poor';
    return {
      tier,
      flags: tier === 'fair' ? ['below-average credit'] : [],
    };
  },
};

const employerVerification = {
  verify: (status: string, years: number) => ({
    verified: status !== 'unemployed',
    flags:
      status === 'self-employed' && years < 2
        ? [`Self-employed for only ${years} year(s)`]
        : [],
  }),
};

// ── State type ──────────────────────────────────────────────────────────

interface LoanState {
  creditTier: string;
  creditFlags: string[];
  dtiRatio: number;
  dtiPercent: number;
  dtiStatus: string;
  dtiFlags: string[];
  employmentVerified: boolean;
  employmentFlags: string[];
  riskTier: string;
  riskFactors: string[];
  decision: string;
}

// ── Flowchart ───────────────────────────────────────────────────────────

const chart = flowChart<LoanState>('ReceiveApplication', async (scope) => {
  const { app } = scope.$getArgs<LoanInput>();
  console.log(`  Received application from ${app.applicantName}`);
}, 'receive-application', undefined,
  'Ingest the loan application and store applicant data')
  .addFunction('PullCreditReport', async (scope) => {
    const { app } = scope.$getArgs<LoanInput>();
    await new Promise((r) => setTimeout(r, 40)); // simulate credit bureau API
    const report = creditBureau.pullReport(app.creditScore);
    scope.creditTier = report.tier;
    scope.creditFlags = report.flags;
  }, 'pull-credit-report',
    'Retrieve credit score and flag any credit issues')
  .addFunction('CalculateDTI', async (scope) => {
    const { app } = scope.$getArgs<LoanInput>();
    const dtiRatio = Math.round((app.monthlyDebts / (app.annualIncome / 12)) * 100) / 100;
    scope.dtiRatio = dtiRatio;
    scope.dtiPercent = Math.round(dtiRatio * 100);
    scope.dtiStatus = dtiRatio > 0.43 ? 'excessive' : 'healthy';
    scope.dtiFlags =
      dtiRatio > 0.43 ? [`DTI at ${Math.round(dtiRatio * 100)}% exceeds 43%`] : [];
  }, 'calculate-dti',
    'Compute debt-to-income ratio and flag excessive debt')
  .addFunction('VerifyEmployment', async (scope) => {
    const { app } = scope.$getArgs<LoanInput>();
    await new Promise((r) => setTimeout(r, 25)); // simulate employer verification
    const result = employerVerification.verify(app.employmentStatus, app.employmentYears);
    scope.employmentVerified = result.verified;
    scope.employmentFlags = result.flags;
  }, 'verify-employment',
    'Confirm employment status and years of experience')
  .addFunction('AssessRisk', async (scope) => {
    const riskTier =
      !scope.employmentVerified || scope.dtiStatus === 'excessive' || scope.creditTier === 'poor'
        ? 'high' : 'low';
    scope.riskTier = riskTier;

    scope.riskFactors = [
      ...scope.creditFlags,
      ...scope.dtiFlags,
      ...scope.employmentFlags,
    ];
  }, 'assess-risk',
    'Evaluate all flags and credit data to determine risk tier')
  .addDeciderFunction('LoanDecision', (scope) => {
    return decide(scope, [
      { when: { riskTier: { eq: 'low' } }, then: 'approved', label: 'Low risk' },
      { when: { riskTier: { eq: 'high' } }, then: 'rejected', label: 'High risk' },
    ], 'manual-review');
  }, 'loan-decision',
    'Route to approval, rejection, or manual review based on risk tier')
    .addFunctionBranch('approved', 'ApproveApplication', async (scope) => {
      const { app } = scope.$getArgs<LoanInput>();
      scope.decision = `${app.applicantName}: APPROVED`;
    },
      'Generate approval letter with loan terms')
    .addFunctionBranch('rejected', 'RejectApplication', async (scope) => {
      const { app } = scope.$getArgs<LoanInput>();
      scope.decision = `${app.applicantName}: REJECTED — ${scope.riskFactors.join('; ')}`;
    },
      'Generate rejection notice with denial reasons')
    .addFunctionBranch('manual-review', 'ManualReview', async (scope) => {
      const { app } = scope.$getArgs<LoanInput>();
      scope.decision = `${app.applicantName}: SENT TO MANUAL REVIEW`;
    },
      'Flag for human underwriter review with risk summary')
    .setDefault('manual-review')
    .end()

  .build();

// ── Run ─────────────────────────────────────────────────────────────────

const executor = new FlowChartExecutor(chart);
executor.enableNarrative();
await executor.run({ input });

console.log('=== Loan Application — Causal Trace ===\n');
executor.getNarrativeEntries().map(e => e.text).forEach((line) => console.log(`  ${line}`));
console.log();
})().catch(console.error);
