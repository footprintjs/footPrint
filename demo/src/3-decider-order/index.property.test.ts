/**
 * Property-Based Tests for Demo 3: Decider (Order Processing Domain)
 *
 * PROPERTY: Decider Single Branch Selection
 * For any decider node with N branches and a decider function that returns
 * branch ID X, executing the pipeline SHALL result in exactly one branch
 * (the one with ID X) being executed, and all other N-1 branches SHALL NOT execute.
 *
 * **Validates: Requirements 3.2, 6.2**
 *
 * WHY: This property ensures the fundamental contract of decider nodes:
 * exactly ONE branch executes based on the decider function's return value.
 * If this property fails, the single-choice branching model is broken.
 *
 * COUNTEREXAMPLE MEANING: If this test fails, it means either:
 * 1. Multiple branches executed when only one should have
 * 2. No branches executed when one should have
 * 3. The wrong branch executed (not the one returned by decider)
 */

import * as fc from 'fast-check';
import { FlowChartBuilder, BaseState, StageContext } from 'footprint';

// ============================================================================
// Test Utilities
// ============================================================================

/**
 * Creates a scope factory that tracks which stages executed.
 */
function createExecutionTracker() {
  const executedStages: string[] = [];

  const scopeFactory = (ctx: StageContext, stageName: string, readOnly?: unknown) => {
    executedStages.push(stageName);
    return new BaseState(ctx, stageName, readOnly);
  };

  return {
    scopeFactory,
    getExecutedStages: () => executedStages,
    reset: () => {
      executedStages.length = 0;
    },
  };
}

/**
 * Generates valid branch IDs (non-empty alphanumeric strings).
 *
 * WHY: Branch IDs should be simple identifiers. We constrain the generator
 * to produce realistic IDs that would be used in production.
 */
const branchIdArb = fc.string({ minLength: 1, maxLength: 20 }).filter((s) => {
  return /^[a-zA-Z][a-zA-Z0-9_-]*$/.test(s);
});

/**
 * Generates a set of unique branch IDs.
 *
 * WHY: Decider branches must have unique IDs. We generate 2-5 branches
 * to test various configurations.
 */
const uniqueBranchIdsArb = fc
  .array(branchIdArb, { minLength: 2, maxLength: 5 })
  .map((ids) => [...new Set(ids)])
  .filter((ids) => ids.length >= 2);

// ============================================================================
// Property Tests
// ============================================================================

describe('Property 3: Decider Single Branch Selection', () => {
  /**
   * PROPERTY: Exactly one branch executes
   *
   * For any set of N branches and a decider that returns one of those branch IDs,
   * exactly one branch should execute.
   *
   * **Validates: Requirements 3.2, 6.2**
   */
  it('should execute exactly one branch when decider returns valid ID', async () => {
    await fc.assert(
      fc.asyncProperty(uniqueBranchIdsArb, async (branchIds) => {
        // For each branch ID, test that selecting it executes only that branch
        for (const selectedId of branchIds) {
          const tracker = createExecutionTracker();
          const executedBranches: string[] = [];

          // Create branch functions that record their execution
          const branchFunctions = branchIds.map((id) => ({
            id,
            name: `Branch_${id}`,
            fn: async (scope: BaseState) => {
              executedBranches.push(id);
              return { branchId: id };
            },
          }));

          // Decider always returns the selected ID
          const decider = () => selectedId;

          // Build and execute pipeline
          let builder = new FlowChartBuilder()
            .start('Entry', async () => ({ started: true }))
            .addDecider(decider);

          // Add all branches
          for (const branch of branchFunctions) {
            builder = builder.addFunctionBranch(branch.id, branch.name, branch.fn);
          }

          builder = builder.setDefault(branchIds[0]).end();

          await builder.execute(tracker.scopeFactory);

          // Assert: exactly one branch executed
          if (executedBranches.length !== 1) {
            return false;
          }

          // Assert: the correct branch executed
          if (executedBranches[0] !== selectedId) {
            return false;
          }
        }

        return true;
      }),
      { numRuns: 100 },
    );
  });

  /**
   * PROPERTY: Non-selected branches do not execute
   *
   * For any decider that returns branch ID X, all branches with ID != X
   * should NOT execute.
   *
   * **Validates: Requirements 3.2, 6.2**
   */
  it('should not execute non-selected branches', async () => {
    await fc.assert(
      fc.asyncProperty(uniqueBranchIdsArb, async (branchIds) => {
        // Select the first branch
        const selectedId = branchIds[0];
        const nonSelectedIds = branchIds.slice(1);

        const tracker = createExecutionTracker();
        const executedBranches: string[] = [];

        // Create branch functions that record their execution
        const branchFunctions = branchIds.map((id) => ({
          id,
          name: `Branch_${id}`,
          fn: async (scope: BaseState) => {
            executedBranches.push(id);
            return { branchId: id };
          },
        }));

        // Decider returns the selected ID
        const decider = () => selectedId;

        // Build and execute pipeline
        let builder = new FlowChartBuilder()
          .start('Entry', async () => ({ started: true }))
          .addDecider(decider);

        for (const branch of branchFunctions) {
          builder = builder.addFunctionBranch(branch.id, branch.name, branch.fn);
        }

        builder = builder.setDefault(branchIds[0]).end();

        await builder.execute(tracker.scopeFactory);

        // Assert: no non-selected branches executed
        for (const nonSelectedId of nonSelectedIds) {
          if (executedBranches.includes(nonSelectedId)) {
            return false;
          }
        }

        return true;
      }),
      { numRuns: 100 },
    );
  });

  /**
   * PROPERTY: Default branch executes for unknown IDs
   *
   * For any decider that returns an ID not in the branch list,
   * the default branch should execute.
   *
   * **Validates: Requirements 3.2, 6.2**
   */
  it('should execute default branch when decider returns unknown ID', async () => {
    await fc.assert(
      fc.asyncProperty(uniqueBranchIdsArb, branchIdArb, async (branchIds, unknownId) => {
        // Skip if unknownId happens to be in branchIds
        if (branchIds.includes(unknownId)) {
          return true;
        }

        const defaultId = branchIds[0];
        const tracker = createExecutionTracker();
        const executedBranches: string[] = [];

        // Create branch functions that record their execution
        const branchFunctions = branchIds.map((id) => ({
          id,
          name: `Branch_${id}`,
          fn: async (scope: BaseState) => {
            executedBranches.push(id);
            return { branchId: id };
          },
        }));

        // Decider returns an unknown ID
        const decider = () => unknownId;

        // Build and execute pipeline
        let builder = new FlowChartBuilder()
          .start('Entry', async () => ({ started: true }))
          .addDecider(decider);

        for (const branch of branchFunctions) {
          builder = builder.addFunctionBranch(branch.id, branch.name, branch.fn);
        }

        builder = builder.setDefault(defaultId).end();

        await builder.execute(tracker.scopeFactory);

        // Assert: exactly one branch executed (the default)
        if (executedBranches.length !== 1) {
          return false;
        }

        // Assert: the default branch executed
        if (executedBranches[0] !== defaultId) {
          return false;
        }

        return true;
      }),
      { numRuns: 100 },
    );
  });

  /**
   * PROPERTY: Decider receives previous stage output
   *
   * For any value returned by the previous stage, the decider function
   * should receive that value as input.
   *
   * **Validates: Requirements 3.2, 6.2**
   */
  it('should pass previous stage output to decider function', async () => {
    // Generate various output values
    const outputValueArb = fc.oneof(
      fc.record({ type: fc.constant('a'), value: fc.integer() }),
      fc.record({ type: fc.constant('b'), value: fc.string() }),
      fc.record({ type: fc.constant('c'), value: fc.boolean() }),
    );

    await fc.assert(
      fc.asyncProperty(outputValueArb, async (outputValue) => {
        const tracker = createExecutionTracker();
        let receivedInput: unknown = null;

        // Entry stage returns the output value
        const entryStage = async (scope: BaseState) => {
          return outputValue;
        };

        // Decider captures its input
        const decider = (input: unknown) => {
          receivedInput = input;
          return 'branch-a';
        };

        // Build and execute pipeline
        const builder = new FlowChartBuilder()
          .start('Entry', entryStage)
          .addDecider(decider)
            .addFunctionBranch('branch-a', 'BranchA', async () => ({ branch: 'a' }))
            .addFunctionBranch('branch-b', 'BranchB', async () => ({ branch: 'b' }))
            .setDefault('branch-a')
            .end();

        await builder.execute(tracker.scopeFactory);

        // Assert: decider received the previous stage output
        return JSON.stringify(receivedInput) === JSON.stringify(outputValue);
      }),
      { numRuns: 100 },
    );
  });

  /**
   * PROPERTY: Branch output becomes pipeline result
   *
   * For any branch that executes and returns a value, that value
   * should be the result of the decider block.
   *
   * **Validates: Requirements 3.2, 6.2**
   */
  it('should return selected branch output as decider result', async () => {
    // Generate various branch output values
    const branchOutputArb = fc.record({
      branchId: branchIdArb,
      data: fc.oneof(fc.integer(), fc.string(), fc.boolean()),
    });

    await fc.assert(
      fc.asyncProperty(branchOutputArb, async (branchOutput) => {
        const tracker = createExecutionTracker();

        // Branch returns the generated output
        const branchFn = async (scope: BaseState) => {
          return branchOutput;
        };

        // Decider always selects 'selected'
        const decider = () => 'selected';

        // Build and execute pipeline
        const builder = new FlowChartBuilder()
          .start('Entry', async () => ({ started: true }))
          .addDecider(decider)
            .addFunctionBranch('selected', 'SelectedBranch', branchFn)
            .addFunctionBranch('other', 'OtherBranch', async () => ({ other: true }))
            .setDefault('selected')
            .end();

        const result = await builder.execute(tracker.scopeFactory);

        // Assert: result matches branch output
        return JSON.stringify(result) === JSON.stringify(branchOutput);
      }),
      { numRuns: 100 },
    );
  });
});
