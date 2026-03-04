/**
 * Tests for Demo 8: Loan Application — "Why Was I Rejected?"
 *
 * BEHAVIOR: Verifies that the loan application pipeline produces correct
 * decisions AND narratives for different applicant profiles.
 *
 * WHY: The narrative is the product — it must correctly capture the causal
 * chain from application data through risk assessment to decision.
 */
import { FlowChartExecutor, BaseState, StageContext } from 'footprint';
import {
  buildLoanApplicationFlow,
  runLoanApplication,
  sampleApplications,
  setCurrentApplication,
} from './index';

// ============================================================================
// Helpers
// ============================================================================

function createExecutionTracker() {
  const executedStages: string[] = [];
  const scopeFactory = (ctx: StageContext, stageName: string, readOnly?: unknown) => {
    executedStages.push(stageName);
    return new BaseState(ctx, stageName, readOnly);
  };
  return { scopeFactory, getExecutedStages: () => executedStages };
}

// ============================================================================
// Decision Routing Tests
// ============================================================================

describe('Demo 8: Loan Application', () => {
  describe('decision routing', () => {
    it('should approve a strong applicant (low risk)', async () => {
      setCurrentApplication(sampleApplications.approved);
      const tracker = createExecutionTracker();
      const flowChart = buildLoanApplicationFlow();
      const executor = new FlowChartExecutor(flowChart, tracker.scopeFactory);
      await executor.run();

      const executed = tracker.getExecutedStages();
      expect(executed).toContain('ApproveApplication');
      expect(executed).not.toContain('RejectApplication');
      expect(executed).not.toContain('ManualReview');
    });

    it('should reject a weak applicant (high risk)', async () => {
      setCurrentApplication(sampleApplications.rejected);
      const tracker = createExecutionTracker();
      const flowChart = buildLoanApplicationFlow();
      const executor = new FlowChartExecutor(flowChart, tracker.scopeFactory);
      await executor.run();

      const executed = tracker.getExecutedStages();
      expect(executed).toContain('RejectApplication');
      expect(executed).not.toContain('ApproveApplication');
      expect(executed).not.toContain('ManualReview');
    });

    it('should send borderline applicant to manual review (medium risk)', async () => {
      setCurrentApplication(sampleApplications.manualReview);
      const tracker = createExecutionTracker();
      const flowChart = buildLoanApplicationFlow();
      const executor = new FlowChartExecutor(flowChart, tracker.scopeFactory);
      await executor.run();

      const executed = tracker.getExecutedStages();
      expect(executed).toContain('ManualReview');
      expect(executed).not.toContain('ApproveApplication');
      expect(executed).not.toContain('RejectApplication');
    });
  });

  // ============================================================================
  // Narrative Tests — The Core Value Proposition
  // ============================================================================

  describe('narrative generation', () => {
    it('should produce a narrative that explains the rejection', async () => {
      const result = await runLoanApplication(sampleApplications.rejected);

      // The narrative should exist and have multiple sentences
      expect(result.narrative.length).toBeGreaterThan(0);

      // Join narrative for easier assertion
      const fullNarrative = result.narrative.join(' ');

      // The narrative should mention the process beginning
      expect(fullNarrative).toContain('The process began');

      // The narrative should mention the decision
      expect(fullNarrative).toMatch(/Reject/i);
    });

    it('should produce a narrative that explains the approval', async () => {
      const result = await runLoanApplication(sampleApplications.approved);
      const fullNarrative = result.narrative.join(' ');

      expect(fullNarrative).toContain('The process began');
      expect(fullNarrative).toMatch(/Approve/i);
    });

    it('should capture stage descriptions in the narrative', async () => {
      const result = await runLoanApplication(sampleApplications.rejected);
      const fullNarrative = result.narrative.join(' ');

      // Stage descriptions should appear as narrative sentences
      expect(fullNarrative).toMatch(/credit/i);
      expect(fullNarrative).toMatch(/debt-to-income|DTI/i);
      expect(fullNarrative).toMatch(/employment/i);
      expect(fullNarrative).toMatch(/risk/i);
    });
  });

  // ============================================================================
  // Execution Order Tests
  // ============================================================================

  describe('execution order', () => {
    it('should execute all common stages before the decider', async () => {
      setCurrentApplication(sampleApplications.rejected);
      const tracker = createExecutionTracker();
      const flowChart = buildLoanApplicationFlow();
      const executor = new FlowChartExecutor(flowChart, tracker.scopeFactory);
      await executor.run();

      const executed = tracker.getExecutedStages();

      // Common stages should all appear before the branch
      const receiveIdx = executed.indexOf('ReceiveApplication');
      const creditIdx = executed.indexOf('PullCreditReport');
      const dtiIdx = executed.indexOf('CalculateDTI');
      const empIdx = executed.indexOf('VerifyEmployment');
      const riskIdx = executed.indexOf('AssessRisk');
      const rejectIdx = executed.indexOf('RejectApplication');

      expect(receiveIdx).toBeLessThan(creditIdx);
      expect(creditIdx).toBeLessThan(dtiIdx);
      expect(dtiIdx).toBeLessThan(empIdx);
      expect(empIdx).toBeLessThan(riskIdx);
      expect(riskIdx).toBeLessThan(rejectIdx);
    });

    it('should execute exactly one decision branch', async () => {
      setCurrentApplication(sampleApplications.approved);
      const tracker = createExecutionTracker();
      const flowChart = buildLoanApplicationFlow();
      const executor = new FlowChartExecutor(flowChart, tracker.scopeFactory);
      await executor.run();

      const executed = tracker.getExecutedStages();
      const branchCount = [
        executed.includes('ApproveApplication'),
        executed.includes('RejectApplication'),
        executed.includes('ManualReview'),
      ].filter(Boolean).length;

      expect(branchCount).toBe(1);
    });
  });
});
