/**
 * Tests for Demo 8: Loan Application — "Why Was I Rejected?"
 *
 * BEHAVIOR: Verifies that the loan application pipeline produces correct
 * decisions AND combined narratives for different applicant profiles.
 *
 * WHY: The combined narrative (flow + steps + conditions) is the product.
 * It must correctly capture the causal chain from application data through
 * risk assessment to decision — all built automatically from read/write ops.
 */
import { FlowChartExecutor, BaseState, StageContext, NarrativeRecorder } from 'footprint';
import {
  buildLoanApplicationFlow,
  runLoanApplication,
  sampleApplications,
  setCurrentApplication,
  createInstrumentedScopeFactory,
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
  // Combined Narrative Tests — The Core Value Proposition
  // ============================================================================

  describe('combined narrative', () => {
    it('should produce a combined narrative with flow + steps for rejection', async () => {
      const result = await runLoanApplication(sampleApplications.rejected);

      // Combined narrative should have flow-level stages and step-level operations
      expect(result.combinedNarrative.length).toBeGreaterThan(0);

      const fullText = result.combinedNarrative.join('\n');

      // Flow level: stages should be numbered
      expect(fullText).toMatch(/Stage \d+/);

      // Step level: operations should appear as steps
      expect(fullText).toMatch(/Step \d+/);

      // Should contain read and write operations
      expect(fullText).toContain('Write');
      expect(fullText).toContain('Read');
    });

    it('should capture the rejection condition in the narrative', async () => {
      const result = await runLoanApplication(sampleApplications.rejected);
      const fullText = result.combinedNarrative.join('\n');

      // The decider condition should appear
      expect(fullText).toMatch(/Condition|Reject/i);
    });

    it('should capture the approval condition in the narrative', async () => {
      const result = await runLoanApplication(sampleApplications.approved);
      const fullText = result.combinedNarrative.join('\n');

      expect(fullText).toMatch(/Approve/i);
    });

    it('should capture step-level data that explains the decision', async () => {
      const result = await runLoanApplication(sampleApplications.rejected);
      const fullText = result.combinedNarrative.join('\n');

      // The step-level data should include the actual values that led to rejection
      expect(fullText).toContain('creditTier');
      expect(fullText).toContain('dtiStatus');
      expect(fullText).toContain('riskTier');
    });

    it('should produce different narratives for different applicants', async () => {
      const rejected = await runLoanApplication(sampleApplications.rejected);
      const approved = await runLoanApplication(sampleApplications.approved);

      const rejectedText = rejected.combinedNarrative.join('\n');
      const approvedText = approved.combinedNarrative.join('\n');

      // Both should have stage structure
      expect(rejectedText).toMatch(/Stage \d+/);
      expect(approvedText).toMatch(/Stage \d+/);

      // But different decision branches
      expect(rejectedText).toMatch(/Reject/i);
      expect(approvedText).toMatch(/Approve/i);
    });
  });

  // ============================================================================
  // NarrativeRecorder Integration Tests
  // ============================================================================

  describe('NarrativeRecorder step capture', () => {
    it('should capture all stage operations with step numbers', async () => {
      const result = await runLoanApplication(sampleApplications.rejected);
      const stageData = result.recorder.getStageData();

      // ReceiveApplication should have writes for all applicant fields
      const receiveData = stageData.get('ReceiveApplication');
      expect(receiveData).toBeDefined();
      expect(receiveData!.writes.length).toBeGreaterThanOrEqual(8);
      expect(receiveData!.operations[0].stepNumber).toBe(1);

      // PullCreditReport should have reads and writes
      const creditData = stageData.get('PullCreditReport');
      expect(creditData).toBeDefined();
      expect(creditData!.reads.length).toBeGreaterThanOrEqual(1);
      expect(creditData!.writes.length).toBeGreaterThanOrEqual(3);
    });

    it('should preserve interleaved operation order within stages', async () => {
      const result = await runLoanApplication(sampleApplications.rejected);
      const stageData = result.recorder.getStageData();

      // CalculateDTI reads annualIncome and monthlyDebts, then writes dtiRatio etc.
      const dtiData = stageData.get('CalculateDTI');
      expect(dtiData).toBeDefined();
      expect(dtiData!.operations.length).toBeGreaterThan(0);

      // First operations should be reads, followed by writes
      const firstRead = dtiData!.operations.findIndex(op => op.type === 'read');
      const firstWrite = dtiData!.operations.findIndex(op => op.type === 'write');
      expect(firstRead).toBeLessThan(firstWrite);
    });

    it('should produce flat sentences for all stages', async () => {
      const result = await runLoanApplication(sampleApplications.rejected);
      const flat = result.recorder.toFlatSentences();

      // Should have entries for multiple stages
      expect(flat.length).toBeGreaterThan(10);

      // Each entry should have format "StageName: Step N: ..."
      expect(flat[0]).toMatch(/^[\w]+: Step \d+:/);
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
