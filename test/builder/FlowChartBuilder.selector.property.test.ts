/**
 * Property-based tests for Selector support in FlowChartBuilder.
 * Uses fast-check for property-based testing.
 *
 * Feature: flowchart-selector-support
 */

import * as fc from 'fast-check';

import {
  FlowChartBuilder,
  SelectorList,
  specToStageNode,
} from '../../src/builder/FlowChartBuilder';

// Arbitrary for valid stage names (non-empty alphanumeric strings)
const stageNameArb = fc.string({ minLength: 1, maxLength: 20 }).filter((s) => /^[a-zA-Z][a-zA-Z0-9]*$/.test(s));

// Arbitrary for branch IDs (unique identifiers)
const branchIdArb = fc.string({ minLength: 1, maxLength: 15 }).filter((s) => /^[a-zA-Z][a-zA-Z0-9_]*$/.test(s));

// Helper to generate unique branch specs
const uniqueBranchesArb = fc
  .array(
    fc.record({
      id: branchIdArb,
      name: stageNameArb,
    }),
    { minLength: 1, maxLength: 5 },
  )
  .map((branches) => {
    // Ensure unique IDs
    const seen = new Set<string>();
    return branches.filter((b) => {
      if (seen.has(b.id)) return false;
      seen.add(b.id);
      return true;
    });
  })
  .filter((branches) => branches.length > 0);

/**
 * **Feature: flowchart-selector-support, Property 1: addSelector Returns SelectorList**
 *
 * *For any* FlowChartBuilder with a valid root node, calling `addSelector()`
 * SHALL return a SelectorList instance for fluent branch configuration.
 *
 * **Validates: Requirements 1.1**
 */
describe('FlowChartBuilder Selector Property Tests', () => {
  describe('Property 1: addSelector Returns SelectorList', () => {
    it('should return SelectorList instance when addSelector is called', () => {
      fc.assert(
        fc.property(stageNameArb, (rootName) => {
          const fb = new FlowChartBuilder().start(rootName);
          const selector = () => 'branch1';
          const result = fb.addSelector(selector);

          return result instanceof SelectorList;
        }),
        { numRuns: 100 },
      );
    });

    it('should accept selector functions returning single string', () => {
      fc.assert(
        fc.property(stageNameArb, branchIdArb, (rootName, branchId) => {
          const fb = new FlowChartBuilder().start(rootName);
          const selector = () => branchId;
          const result = fb.addSelector(selector);

          return result instanceof SelectorList;
        }),
        { numRuns: 100 },
      );
    });

    it('should accept selector functions returning string array', () => {
      fc.assert(
        fc.property(
          stageNameArb,
          fc.array(branchIdArb, { minLength: 1, maxLength: 3 }),
          (rootName, branchIds) => {
            const fb = new FlowChartBuilder().start(rootName);
            const selector = () => branchIds;
            const result = fb.addSelector(selector);

            return result instanceof SelectorList;
          },
        ),
        { numRuns: 100 },
      );
    });

    it('should accept async selector functions', () => {
      fc.assert(
        fc.property(stageNameArb, branchIdArb, (rootName, branchId) => {
          const fb = new FlowChartBuilder().start(rootName);
          const selector = async () => branchId;
          const result = fb.addSelector(selector);

          return result instanceof SelectorList;
        }),
        { numRuns: 100 },
      );
    });
  });

  /**
   * **Feature: flowchart-selector-support, Property 2: SelectorList Branch Addition**
   *
   * *For any* SelectorList, calling `addFunctionBranch()`, `addSubFlowChartBranch()`,
   * or `addBranchList()` SHALL add branches and return the same SelectorList for chaining.
   *
   * **Validates: Requirements 2.1, 2.2, 2.3**
   */
  describe('Property 2: SelectorList Branch Addition', () => {
    it('should allow chaining addFunctionBranch calls', () => {
      fc.assert(
        fc.property(stageNameArb, uniqueBranchesArb, (rootName, branches) => {
          const fb = new FlowChartBuilder().start(rootName);
          let selectorList = fb.addSelector(() => branches[0].id);

          for (const branch of branches) {
            const result = selectorList.addFunctionBranch(branch.id, branch.name);
            if (!(result instanceof SelectorList)) return false;
            selectorList = result;
          }

          return true;
        }),
        { numRuns: 100 },
      );
    });

    it('should allow addBranchList for bulk branch addition', () => {
      fc.assert(
        fc.property(stageNameArb, uniqueBranchesArb, (rootName, branches) => {
          const fb = new FlowChartBuilder().start(rootName);
          const selectorList = fb.addSelector(() => branches[0].id);
          const result = selectorList.addBranchList(branches);

          return result instanceof SelectorList;
        }),
        { numRuns: 100 },
      );
    });

    it('should throw on duplicate branch IDs', () => {
      fc.assert(
        fc.property(stageNameArb, branchIdArb, stageNameArb, (rootName, branchId, branchName) => {
          const fb = new FlowChartBuilder().start(rootName);
          const selectorList = fb.addSelector(() => branchId);

          selectorList.addFunctionBranch(branchId, branchName);

          try {
            selectorList.addFunctionBranch(branchId, 'duplicate');
            return false; // Should have thrown
          } catch (e: any) {
            return e.message.includes('duplicate selector branch id');
          }
        }),
        { numRuns: 100 },
      );
    });

    it('should return FlowChartBuilder when end() is called', () => {
      fc.assert(
        fc.property(stageNameArb, branchIdArb, stageNameArb, (rootName, branchId, branchName) => {
          const fb = new FlowChartBuilder().start(rootName);
          const result = fb
            .addSelector(() => branchId)
            .addFunctionBranch(branchId, branchName)
            .end();

          return result instanceof FlowChartBuilder;
        }),
        { numRuns: 100 },
      );
    });

    it('should throw when end() is called with no branches', () => {
      fc.assert(
        fc.property(stageNameArb, (rootName) => {
          const fb = new FlowChartBuilder().start(rootName);
          const selectorList = fb.addSelector(() => 'any');

          try {
            selectorList.end();
            return false; // Should have thrown
          } catch (e: any) {
            return e.message.includes('requires at least one branch');
          }
        }),
        { numRuns: 100 },
      );
    });
  });

  /**
   * **Feature: flowchart-selector-support, Property 3: Build Output with Selector**
   *
   * *For any* FlowChartBuilder with a selector, `build()` SHALL produce a StageNode
   * with `nextNodeSelector` function and children array.
   *
   * **Validates: Requirements 3.1, 3.2**
   */
  describe('Property 3: Build Output with Selector', () => {
    it('should include nextNodeSelector in built StageNode', () => {
      fc.assert(
        fc.property(stageNameArb, uniqueBranchesArb, (rootName, branches) => {
          const selectorFn = () => branches.map((b) => b.id);
          const fb = new FlowChartBuilder().start(rootName);

          let selectorList = fb.addSelector(selectorFn);
          for (const branch of branches) {
            selectorList = selectorList.addFunctionBranch(branch.id, branch.name);
          }
          selectorList.end();

          const { root } = fb.build();

          return (
            typeof root.nextNodeSelector === 'function' &&
            Array.isArray(root.children) &&
            root.children.length === branches.length
          );
        }),
        { numRuns: 100 },
      );
    });

    it('should preserve selector function reference in build output', () => {
      fc.assert(
        fc.property(stageNameArb, branchIdArb, stageNameArb, (rootName, branchId, branchName) => {
          const selectorFn = () => [branchId];
          const fb = new FlowChartBuilder()
            .start(rootName)
            .addSelector(selectorFn)
            .addFunctionBranch(branchId, branchName)
            .end();

          const { root } = fb.build();

          // The selector should be the same function
          return root.nextNodeSelector === selectorFn;
        }),
        { numRuns: 100 },
      );
    });

    it('should include children with correct IDs', () => {
      fc.assert(
        fc.property(stageNameArb, uniqueBranchesArb, (rootName, branches) => {
          const fb = new FlowChartBuilder().start(rootName);

          let selectorList = fb.addSelector(() => branches[0].id);
          for (const branch of branches) {
            selectorList = selectorList.addFunctionBranch(branch.id, branch.name);
          }
          selectorList.end();

          const { root } = fb.build();

          const childIds = root.children?.map((c) => c.id) ?? [];
          return branches.every((b) => childIds.includes(b.id));
        }),
        { numRuns: 100 },
      );
    });
  });

  /**
   * **Feature: flowchart-selector-support, Property 4: Spec Output with Selector Metadata**
   *
   * *For any* FlowChartBuilder with a selector, `toSpec()` SHALL produce a FlowChartSpec
   * with `hasSelector: true` and `branchIds` array.
   *
   * **Validates: Requirements 4.1, 4.2**
   */
  describe('Property 4: Spec Output with Selector Metadata', () => {
    it('should include hasSelector: true in spec', () => {
      fc.assert(
        fc.property(stageNameArb, uniqueBranchesArb, (rootName, branches) => {
          const fb = new FlowChartBuilder().start(rootName);

          let selectorList = fb.addSelector(() => branches[0].id);
          for (const branch of branches) {
            selectorList = selectorList.addFunctionBranch(branch.id, branch.name);
          }
          selectorList.end();

          const spec = fb.toSpec();

          return spec.hasSelector === true;
        }),
        { numRuns: 100 },
      );
    });

    it('should include branchIds in spec', () => {
      fc.assert(
        fc.property(stageNameArb, uniqueBranchesArb, (rootName, branches) => {
          const fb = new FlowChartBuilder().start(rootName);

          let selectorList = fb.addSelector(() => branches[0].id);
          for (const branch of branches) {
            selectorList = selectorList.addFunctionBranch(branch.id, branch.name);
          }
          selectorList.end();

          const spec = fb.toSpec();

          return (
            Array.isArray(spec.branchIds) &&
            spec.branchIds.length === branches.length &&
            branches.every((b) => spec.branchIds?.includes(b.id))
          );
        }),
        { numRuns: 100 },
      );
    });

    it('should NOT include hasDecider when using selector', () => {
      fc.assert(
        fc.property(stageNameArb, branchIdArb, stageNameArb, (rootName, branchId, branchName) => {
          const fb = new FlowChartBuilder()
            .start(rootName)
            .addSelector(() => branchId)
            .addFunctionBranch(branchId, branchName)
            .end();

          const spec = fb.toSpec();

          return spec.hasSelector === true && spec.hasDecider === undefined;
        }),
        { numRuns: 100 },
      );
    });
  });

  /**
   * **Feature: flowchart-selector-support, Property 5: Inflate Preserves Selector**
   *
   * *For any* built flow with a selector, inflating it via `addSubFlowChartBranch`
   * SHALL preserve the selector function on the internal node.
   *
   * **Validates: Requirements 5.1, 5.2**
   */
  describe('Property 5: Inflate Preserves Selector', () => {
    it('should preserve selector when mounting subtree via addSubFlowChartBranch', () => {
      fc.assert(
        fc.property(stageNameArb, branchIdArb, stageNameArb, (rootName, branchId, branchName) => {
          // Build a subtree with a selector
          const selectorFn = () => [branchId];
          const subtree = new FlowChartBuilder()
            .start('subtreeRoot')
            .addSelector(selectorFn)
            .addFunctionBranch(branchId, branchName)
            .end()
            .build();

          // Mount it in a parent tree via decider
          const parent = new FlowChartBuilder()
            .start(rootName)
            .addDecider(() => 'sub')
            .addSubFlowChartBranch('sub', subtree, 'Subtree')
            .end();

          const { root } = parent.build();

          // Find the mounted subtree
          const mountedSubtree = root.children?.find((c) => c.id === 'sub');

          return (
            mountedSubtree !== undefined &&
            typeof mountedSubtree.nextNodeSelector === 'function' &&
            mountedSubtree.nextNodeSelector === selectorFn
          );
        }),
        { numRuns: 100 },
      );
    });

    it('should preserve selector when mounting subtree via addSubFlowChart', () => {
      fc.assert(
        fc.property(stageNameArb, branchIdArb, stageNameArb, (rootName, branchId, branchName) => {
          // Build a subtree with a selector
          const selectorFn = () => [branchId];
          const subtree = new FlowChartBuilder()
            .start('subtreeRoot')
            .addSelector(selectorFn)
            .addFunctionBranch(branchId, branchName)
            .end()
            .build();

          // Mount it as a child in a parent tree
          const parent = new FlowChartBuilder()
            .start(rootName)
            .addSubFlowChart('sub', subtree, 'Subtree')
            .addFunction('aggregate');

          const { root } = parent.build();

          // Find the mounted subtree
          const mountedSubtree = root.children?.find((c) => c.id === 'sub');

          return (
            mountedSubtree !== undefined &&
            typeof mountedSubtree.nextNodeSelector === 'function' &&
            mountedSubtree.nextNodeSelector === selectorFn
          );
        }),
        { numRuns: 100 },
      );
    });
  });

  /**
   * **Feature: flowchart-selector-support, Property 6: Decider-Selector Mutual Exclusivity**
   *
   * *For any* node, attempting to add both a decider AND a selector SHALL throw an error.
   *
   * **Validates: Requirements 1.3**
   */
  describe('Property 6: Decider-Selector Mutual Exclusivity', () => {
    it('should throw when adding selector after decider', () => {
      fc.assert(
        fc.property(stageNameArb, branchIdArb, stageNameArb, (rootName, branchId, branchName) => {
          const fb = new FlowChartBuilder()
            .start(rootName)
            .addDecider(() => branchId)
            .addFunctionBranch(branchId, branchName)
            .end();

          // Reset to root and try to add selector
          fb.resetToRoot();

          try {
            fb.addSelector(() => branchId);
            return false; // Should have thrown
          } catch (e: any) {
            return e.message.includes('mutually exclusive');
          }
        }),
        { numRuns: 100 },
      );
    });

    it('should throw when adding decider after selector', () => {
      fc.assert(
        fc.property(stageNameArb, branchIdArb, stageNameArb, (rootName, branchId, branchName) => {
          const fb = new FlowChartBuilder()
            .start(rootName)
            .addSelector(() => branchId)
            .addFunctionBranch(branchId, branchName)
            .end();

          // Reset to root and try to add decider
          fb.resetToRoot();

          try {
            fb.addDecider(() => branchId);
            return false; // Should have thrown
          } catch (e: any) {
            return e.message.includes('mutually exclusive');
          }
        }),
        { numRuns: 100 },
      );
    });

    it('should allow selector on different nodes than decider', () => {
      fc.assert(
        fc.property(stageNameArb, branchIdArb, stageNameArb, (rootName, branchId, branchName) => {
          // Root has decider, child has selector - should work
          const fb = new FlowChartBuilder()
            .start(rootName)
            .addDecider(() => branchId)
            .addFunctionBranch(branchId, branchName, undefined, (childBuilder) => {
              // Child node can have its own selector
              childBuilder
                .addSelector(() => 'nested')
                .addFunctionBranch('nested', 'nestedBranch')
                .end();
            })
            .end();

          try {
            const { root } = fb.build();
            // Root should have decider, child should have selector
            return (
              typeof root.nextNodeDecider === 'function' &&
              root.children?.[0]?.nextNodeSelector !== undefined
            );
          } catch {
            return false;
          }
        }),
        { numRuns: 100 },
      );
    });
  });
});
