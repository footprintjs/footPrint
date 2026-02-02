/**
 * Property-based tests for Loop support in FlowChartBuilder.
 * Uses fast-check for property-based testing.
 *
 * Feature: flowchart-loop-dynamic-support
 */

import * as fc from 'fast-check';

import { FlowChartBuilder } from '../../src/core/builder/FlowChartBuilder';

// Arbitrary for valid stage names (non-empty alphanumeric strings)
const stageNameArb = fc.string({ minLength: 1, maxLength: 20 }).filter((s) => /^[a-zA-Z][a-zA-Z0-9]*$/.test(s));

// Arbitrary for stage IDs (unique identifiers)
const stageIdArb = fc.string({ minLength: 1, maxLength: 15 }).filter((s) => /^[a-zA-Z][a-zA-Z0-9_]*$/.test(s));

/**
 * **Feature: flowchart-loop-dynamic-support, Property 1: Loop Target Recording**
 *
 * *For any* FlowChartBuilder with a valid node, calling `loopTo(stageId)`
 * SHALL record the loop target and produce a reference node in build output.
 *
 * **Validates: Requirements 1.1, 1.2**
 */
describe('FlowChartBuilder Loop Property Tests', () => {
  describe('Property 1: loopTo() Records Target and Produces Reference Node', () => {
    it('should return the builder for chaining after loopTo', () => {
      fc.assert(
        fc.property(stageNameArb, stageIdArb, (rootName, targetId) => {
          const fb = new FlowChartBuilder().start(rootName, undefined, targetId);
          const result = fb.loopTo(targetId);

          return result instanceof FlowChartBuilder;
        }),
        { numRuns: 100 },
      );
    });

    it('should produce next node with loop target id in build output', () => {
      fc.assert(
        fc.property(stageNameArb, stageIdArb, stageNameArb, (rootName, targetId, middleName) => {
          const fb = new FlowChartBuilder()
            .start(rootName, undefined, targetId)
            .addFunction(middleName)
            .loopTo(targetId);

          const { root } = fb.build();

          // The middle node should have a next that references the target
          const middleNode = root.next;
          return (
            middleNode !== undefined &&
            middleNode.next !== undefined &&
            middleNode.next.id === targetId &&
            middleNode.next.name === targetId
          );
        }),
        { numRuns: 100 },
      );
    });

    it('should include loopTarget in spec output', () => {
      fc.assert(
        fc.property(stageNameArb, stageIdArb, stageNameArb, (rootName, targetId, middleName) => {
          const fb = new FlowChartBuilder()
            .start(rootName, undefined, targetId)
            .addFunction(middleName)
            .loopTo(targetId);

          const spec = fb.toSpec();

          // The middle node in spec should have loopTarget
          const middleSpec = spec.next;
          return (
            middleSpec !== undefined &&
            middleSpec.loopTarget === targetId &&
            middleSpec.next !== undefined &&
            middleSpec.next.id === targetId
          );
        }),
        { numRuns: 100 },
      );
    });

    it('should throw when loopTo is called twice on same node', () => {
      fc.assert(
        fc.property(stageNameArb, stageIdArb, stageIdArb, (rootName, targetId1, targetId2) => {
          const fb = new FlowChartBuilder().start(rootName, undefined, targetId1).loopTo(targetId1);

          try {
            fb.loopTo(targetId2);
            return false; // Should have thrown
          } catch (e: any) {
            return e.message.includes('loopTo already defined');
          }
        }),
        { numRuns: 100 },
      );
    });

    it('should set loopTarget on internal node', () => {
      fc.assert(
        fc.property(stageNameArb, stageIdArb, (rootName, targetId) => {
          const fb = new FlowChartBuilder()
            .start(rootName, undefined, targetId)
            .loopTo(targetId);

          // Build and verify the loop reference is created
          const { root } = fb.build();
          
          return (
            root.next !== undefined &&
            root.next.id === targetId &&
            root.next.name === targetId
          );
        }),
        { numRuns: 100 },
      );
    });
  });

  /**
   * **Feature: flowchart-loop-dynamic-support, Property 2: Loop Reference Node Structure**
   *
   * *For any* loop target, the reference node SHALL have only id and name fields,
   * with no fn, children, or other properties.
   *
   * **Validates: Requirements 1.2**
   */
  describe('Property 2: Loop Reference Node is Minimal', () => {
    it('should produce reference node with only id and name', () => {
      fc.assert(
        fc.property(stageNameArb, stageIdArb, (rootName, targetId) => {
          const fb = new FlowChartBuilder()
            .start(rootName, undefined, targetId)
            .loopTo(targetId);

          const { root } = fb.build();

          const refNode = root.next;
          if (!refNode) return false;

          // Reference node should have id and name equal to targetId
          // and should NOT have fn, children, next, etc.
          return (
            refNode.id === targetId &&
            refNode.name === targetId &&
            refNode.fn === undefined &&
            refNode.children === undefined &&
            refNode.next === undefined &&
            refNode.nextNodeDecider === undefined &&
            refNode.nextNodeSelector === undefined
          );
        }),
        { numRuns: 100 },
      );
    });
  });

  /**
   * **Feature: flowchart-loop-dynamic-support, Property 3: Loop with Children**
   *
   * *For any* node with children (fork), loopTo can be set and will apply
   * after children complete.
   *
   * **Validates: Requirements 1.1**
   */
  describe('Property 3: Loop After Fork', () => {
    it('should allow loopTo after addListOfFunction', () => {
      fc.assert(
        fc.property(stageNameArb, stageIdArb, stageNameArb, (rootName, targetId, childName) => {
          const fb = new FlowChartBuilder()
            .start(rootName, undefined, targetId)
            .addListOfFunction([{ id: 'child1', name: childName }])
            .loopTo(targetId);

          const { root } = fb.build();

          // Root should have children AND a next reference node
          return (
            root.children !== undefined &&
            root.children.length === 1 &&
            root.next !== undefined &&
            root.next.id === targetId
          );
        }),
        { numRuns: 100 },
      );
    });
  });
});


/**
 * **Feature: flowchart-loop-dynamic-support, Property 4: Loop with Decider Branches**
 *
 * *For any* FlowChartBuilder with decider branches, loopTo can be set on the parent
 * and will create a reference node for the loop target.
 *
 * **Validates: Requirements 1.1, 1.2**
 * 
 * Note: The compile() method for runtime continuation has been removed in the
 * simplified FlowChartBuilder. Use subgraph composition pattern instead.
 */
describe('Property 4: Loop with Decider Branches', () => {
  it('should allow loopTo after decider branches are defined', () => {
    fc.assert(
      fc.property(stageNameArb, stageIdArb, stageNameArb, stageIdArb, (rootName, targetId, branchName, branchId) => {
        const fb = new FlowChartBuilder()
          .start(rootName, undefined, targetId)
          .addDecider(() => branchId)
          .addFunctionBranch(branchId, branchName)
          .end()
          .loopTo(targetId);

        const { root } = fb.build();

        // Root should have children (decider branches) AND a next reference node (loop)
        return (
          root.children !== undefined &&
          root.children.length === 1 &&
          root.next !== undefined &&
          root.next.id === targetId
        );
      }),
      { numRuns: 100 },
    );
  });

  it('should include loopTarget in spec when decider has branches', () => {
    fc.assert(
      fc.property(stageNameArb, stageIdArb, stageNameArb, stageIdArb, (rootName, targetId, branchName, branchId) => {
        const fb = new FlowChartBuilder()
          .start(rootName, undefined, targetId)
          .addDecider(() => branchId)
          .addFunctionBranch(branchId, branchName)
          .end()
          .loopTo(targetId);

        const spec = fb.toSpec();

        return (
          spec.children !== undefined &&
          spec.children.length === 1 &&
          spec.loopTarget === targetId &&
          spec.next !== undefined &&
          spec.next.id === targetId
        );
      }),
      { numRuns: 100 },
    );
  });

  it('should allow loopTo after selector branches are defined', () => {
    fc.assert(
      fc.property(stageNameArb, stageIdArb, stageNameArb, stageIdArb, (rootName, targetId, branchName, branchId) => {
        const selectorFn = () => [branchId];
        const fb = new FlowChartBuilder()
          .start(rootName, undefined, targetId)
          .addSelector(selectorFn)
          .addFunctionBranch(branchId, branchName)
          .end()
          .loopTo(targetId);

        const { root } = fb.build();

        return (
          root.children !== undefined &&
          root.children.length === 1 &&
          root.nextNodeSelector === selectorFn &&
          root.next !== undefined &&
          root.next.id === targetId
        );
      }),
      { numRuns: 100 },
    );
  });
});
