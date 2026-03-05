/**
 * Property-Based Tests for Demo 3: Decider (Order Processing Domain)
 *
 * PROPERTY: Decider Single Branch Selection (Scope-Based)
 * For any scope-based decider node with N branches and a decider function that
 * returns branch ID X, executing the pipeline SHALL result in exactly one branch
 * (the one with ID X) being executed, and all other N-1 branches SHALL NOT execute.
 *
 * **Validates: Requirements 8.1, 8.2**
 *
 * WHY: This property ensures the fundamental contract of scope-based decider nodes
 * (addDeciderFunction): exactly ONE branch executes based on the decider function's
 * return value read from scope. If this property fails, the single-choice branching
 * model is broken.
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

describe('Property: Scope-Based Decider Single Branch Selection', () => {
  /**
   * PROPERTY: Exactly one branch executes with addDeciderFunction
   *
   * For any set of N branches and a scope-based decider that returns one of
   * those branch IDs, exactly one branch should execute.
   *
   * **Validates: Requirements 8.1, 8.2**
   */
  it('should execute exactly one branch when scope-based decider returns valid ID', async () => {
    await fc.assert(
      fc.asyncProperty(uniqueBranchIdsArb, async (branchIds) => {
        for (const selectedId of branchIds) {
          const tracker = createExecutionTracker();
          const executedBranches: string[] = [];

          const branchFunctions = branchIds.map((id) => ({
            id,
            name: `Branch_${id}`,
            fn: async (scope: BaseState) => {
              executedBranches.push(id);
              return { branchId: id };
            },
          }));

          // Entry stage writes the selected ID to scope
          const entryStage = async (scope: BaseState) => {
            scope.setValue('selectedBranch', selectedId);
            return { started: true };
          };

          // Scope-based decider reads from scope
          const decider = (scope: BaseState) => {
            return (scope.getValue('selectedBranch') as string) ?? branchIds[0];
          };

          // Build pipeline using addDeciderFunction
          const builder = new FlowChartBuilder();
          builder.start('Entry', entryStage);

          let deciderList = builder.addDeciderFunction('TestDecider', decider as any, 'test-decider');
          for (const branch of branchFunctions) {
            deciderList = deciderList.addFunctionBranch(branch.id, branch.name, branch.fn);
          }
          deciderList.setDefault(branchIds[0]).end();

          await builder.execute(tracker.scopeFactory);

          if (executedBranches.length !== 1) return false;
          if (executedBranches[0] !== selectedId) return false;

          executedBranches.length = 0;
          tracker.reset();
        }

        return true;
      }),
      { numRuns: 100 },
    );
  });

  /**
   * PROPERTY: Non-selected branches do not execute with addDeciderFunction
   *
   * For any scope-based decider that returns branch ID X, all branches with
   * ID != X should NOT execute.
   *
   * **Validates: Requirements 8.1, 8.2**
   */
  it('should not execute non-selected branches with scope-based decider', async () => {
    await fc.assert(
      fc.asyncProperty(uniqueBranchIdsArb, async (branchIds) => {
        const selectedId = branchIds[0];
        const nonSelectedIds = branchIds.slice(1);

        const tracker = createExecutionTracker();
        const executedBranches: string[] = [];

        const branchFunctions = branchIds.map((id) => ({
          id,
          name: `Branch_${id}`,
          fn: async (scope: BaseState) => {
            executedBranches.push(id);
            return { branchId: id };
          },
        }));

        const entryStage = async (scope: BaseState) => {
          scope.setValue('selectedBranch', selectedId);
          return { started: true };
        };

        const decider = (scope: BaseState) => {
          return (scope.getValue('selectedBranch') as string) ?? branchIds[0];
        };

        const builder = new FlowChartBuilder();
        builder.start('Entry', entryStage);

        let deciderList = builder.addDeciderFunction('TestDecider', decider as any, 'test-decider');
        for (const branch of branchFunctions) {
          deciderList = deciderList.addFunctionBranch(branch.id, branch.name, branch.fn);
        }
        deciderList.setDefault(branchIds[0]).end();

        await builder.execute(tracker.scopeFactory);

        for (const nonSelectedId of nonSelectedIds) {
          if (executedBranches.includes(nonSelectedId)) return false;
        }

        return true;
      }),
      { numRuns: 100 },
    );
  });

  /**
   * PROPERTY: Default branch executes for unknown IDs with addDeciderFunction
   *
   * For any scope-based decider that returns an ID not in the branch list,
   * the default branch (id='default') should execute.
   *
   * NOTE: For scope-based deciders, the default fallback uses a branch with
   * id='default'.
   *
   * **Validates: Requirements 8.1, 8.2**
   */
  it('should execute default branch when scope-based decider returns unknown ID', async () => {
    await fc.assert(
      fc.asyncProperty(uniqueBranchIdsArb, branchIdArb, async (branchIds, unknownId) => {
        // Skip if unknownId matches any branch or 'default'
        if (branchIds.includes(unknownId) || unknownId === 'default') return true;
        // Skip if any branchId is 'default' (would conflict with our default branch)
        if (branchIds.includes('default')) return true;

        const tracker = createExecutionTracker();
        const executedBranches: string[] = [];

        const branchFunctions = branchIds.map((id) => ({
          id,
          name: `Branch_${id}`,
          fn: async (scope: BaseState) => {
            executedBranches.push(id);
            return { branchId: id };
          },
        }));

        const entryStage = async (scope: BaseState) => {
          scope.setValue('selectedBranch', unknownId);
          return { started: true };
        };

        const decider = (scope: BaseState) => {
          return (scope.getValue('selectedBranch') as string) ?? 'default';
        };

        const builder = new FlowChartBuilder();
        builder.start('Entry', entryStage);

        let deciderList = builder.addDeciderFunction('TestDecider', decider as any, 'test-decider');
        for (const branch of branchFunctions) {
          deciderList = deciderList.addFunctionBranch(branch.id, branch.name, branch.fn);
        }
        // Add a default branch with id='default' for scope-based decider fallback
        deciderList = deciderList.addFunctionBranch('default', 'DefaultBranch', async (scope: BaseState) => {
          executedBranches.push('default');
          return { branchId: 'default' };
        });
        deciderList.end();

        await builder.execute(tracker.scopeFactory);

        // The default branch should execute when no match found
        if (executedBranches.length !== 1) return false;
        if (executedBranches[0] !== 'default') return false;

        return true;
      }),
      { numRuns: 100 },
    );
  });

  /**
   * PROPERTY: Scope-based decider reads from scope, not from stage output
   *
   * For any value written to scope by the previous stage, the scope-based
   * decider should be able to read it and use it for routing.
   *
   * **Validates: Requirements 8.1, 8.2**
   */
  it('should route based on scope data written by previous stage', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.constantFrom('branch-a', 'branch-b'),
        async (targetBranch) => {
          const tracker = createExecutionTracker();
          const executedBranches: string[] = [];

          const entryStage = async (scope: BaseState) => {
            scope.setValue('routingTarget', targetBranch);
            return { irrelevantOutput: 'this is ignored by the decider' };
          };

          const decider = (scope: BaseState) => {
            return (scope.getValue('routingTarget') as string) ?? 'branch-a';
          };

          const builder = new FlowChartBuilder();
          builder.start('Entry', entryStage);

          builder.addDeciderFunction('ScopeDecider', decider as any, 'scope-decider')
            .addFunctionBranch('branch-a', 'BranchA', async (scope: BaseState) => {
              executedBranches.push('branch-a');
              return { branch: 'a' };
            })
            .addFunctionBranch('branch-b', 'BranchB', async (scope: BaseState) => {
              executedBranches.push('branch-b');
              return { branch: 'b' };
            })
            .setDefault('branch-a')
            .end();

          await builder.execute(tracker.scopeFactory);

          return executedBranches.length === 1 && executedBranches[0] === targetBranch;
        },
      ),
      { numRuns: 100 },
    );
  });

  /**
   * PROPERTY: Branch output becomes pipeline result with addDeciderFunction
   *
   * For any branch that executes and returns a value, that value
   * should be the result of the decider block.
   *
   * **Validates: Requirements 8.1, 8.2**
   */
  it('should return selected branch output as decider result', async () => {
    const branchOutputArb = fc.record({
      branchId: branchIdArb,
      data: fc.oneof(fc.integer(), fc.string(), fc.boolean()),
    });

    await fc.assert(
      fc.asyncProperty(branchOutputArb, async (branchOutput) => {
        const tracker = createExecutionTracker();

        const branchFn = async (scope: BaseState) => {
          return branchOutput;
        };

        const entryStage = async (scope: BaseState) => {
          scope.setValue('target', 'selected');
          return { started: true };
        };

        const decider = (scope: BaseState) => {
          return (scope.getValue('target') as string) ?? 'selected';
        };

        const builder = new FlowChartBuilder();
        builder.start('Entry', entryStage);

        builder.addDeciderFunction('TestDecider', decider as any, 'test-decider')
          .addFunctionBranch('selected', 'SelectedBranch', branchFn)
          .addFunctionBranch('other', 'OtherBranch', async () => ({ other: true }))
          .setDefault('selected')
          .end();

        const result = await builder.execute(tracker.scopeFactory);

        return JSON.stringify(result) === JSON.stringify(branchOutput);
      }),
      { numRuns: 100 },
    );
  });
});
