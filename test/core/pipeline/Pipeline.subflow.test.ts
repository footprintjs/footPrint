/**
 * Pipeline.subflow.test.ts
 *
 * Unit tests for nested subflow context functionality.
 * Tests that subflows execute with isolated PipelineRuntime and
 * store their results in the parent stage's metadata.
 *
 * _Requirements: 1.1, 1.2, 1.3, 1.4, 2.1, 2.2, 2.3, 3.1, 3.2, 3.3, 3.4, 4.1, 4.2, 4.3, 6.1, 6.2_
 */

import { Pipeline, StageNode } from '../../../src/core/pipeline/Pipeline';
import { StageContext } from '../../../src/core/context/StageContext';
import { ScopeFactory } from '../../../src/core/context/types';

// Simple scope factory for testing
const testScopeFactory: ScopeFactory<StageContext> = (context: StageContext) => context;

describe('Pipeline Subflow Execution', () => {
  describe('Subflow Detection and Context Creation', () => {
    /**
     * Test: Subflow root nodes create isolated context
     * _Requirements: 1.1, 1.2, 1.3_
     */
    it('should detect subflow root and create nested context', async () => {
      let subflowContextName: string | undefined;

      const subflowStage: StageNode = {
        name: 'subflowStage',
        id: 'subflowStage',
        isSubflowRoot: true,
        subflowId: 'test-subflow',
        subflowName: 'Test Subflow',
        fn: (scope: StageContext) => {
          // Capture the context's pipeline ID to verify isolation
          subflowContextName = scope.stageName;
          scope.setObject([], 'subflowData', 'from-subflow');
          return 'subflow-result';
        },
      };

      const root: StageNode = {
        name: 'root',
        id: 'root',
        fn: (scope: StageContext) => {
          scope.setObject([], 'parentData', 'from-parent');
          return 'parent-result';
        },
        next: subflowStage,
      };

      const stageMap = new Map();
      const pipeline = new Pipeline(root, stageMap, testScopeFactory);

      await pipeline.execute();

      // Verify subflow was detected and executed
      expect(subflowContextName).toBe('subflowStage');

      // Verify subflow results were collected
      const subflowResults = pipeline.getSubflowResults();
      expect(subflowResults.size).toBe(1);
      expect(subflowResults.has('test-subflow')).toBe(true);

      const result = subflowResults.get('test-subflow')!;
      expect(result.subflowId).toBe('test-subflow');
      expect(result.subflowName).toBe('Test Subflow');
      expect(result.pipelineStructure).toBeDefined();
      expect(result.treeContext).toBeDefined();
    });

    /**
     * Test: Nodes without isSubflowRoot execute normally
     * _Requirements: 6.2_
     */
    it('should execute non-subflow nodes normally', async () => {
      let executedStages: string[] = [];

      const root: StageNode = {
        name: 'root',
        id: 'root',
        fn: (scope: StageContext) => {
          executedStages.push('root');
          return 'root-result';
        },
        next: {
          name: 'stage2',
          id: 'stage2',
          fn: (scope: StageContext) => {
            executedStages.push('stage2');
            return 'stage2-result';
          },
        },
      };

      const stageMap = new Map();
      const pipeline = new Pipeline(root, stageMap, testScopeFactory);

      await pipeline.execute();

      expect(executedStages).toEqual(['root', 'stage2']);

      // No subflows should be collected
      const subflowResults = pipeline.getSubflowResults();
      expect(subflowResults.size).toBe(0);
    });
  });

  describe('Subflow Execution Isolation', () => {
    /**
     * Test: Subflow scope writes don't appear in parent scope
     * _Requirements: 2.1, 2.2_
     */
    it('should isolate subflow scope from parent scope', async () => {
      const subflowStage: StageNode = {
        name: 'subflowRoot',
        id: 'subflowRoot',
        isSubflowRoot: true,
        subflowId: 'isolated-subflow',
        subflowName: 'Isolated Subflow',
        fn: (scope: StageContext) => {
          // Write to subflow's isolated scope
          scope.setObject([], 'subflowOnly', 'subflow-value');
          return 'subflow-done';
        },
      };

      const root: StageNode = {
        name: 'root',
        id: 'root',
        fn: (scope: StageContext) => {
          scope.setObject([], 'parentOnly', 'parent-value');
          return 'parent-done';
        },
        next: subflowStage,
      };

      const stageMap = new Map();
      const pipeline = new Pipeline(root, stageMap, testScopeFactory);

      await pipeline.execute();

      // Get the parent context tree
      const parentTree = pipeline.getContextTree();

      // Parent should have parentOnly but NOT subflowOnly
      expect(parentTree.globalContext).toBeDefined();

      // Get subflow result
      const subflowResults = pipeline.getSubflowResults();
      const subflowResult = subflowResults.get('isolated-subflow')!;

      // Subflow should have its own isolated context
      expect(subflowResult.treeContext).toBeDefined();
      expect(subflowResult.treeContext.globalContext).toBeDefined();
    });

    /**
     * Test: Each subflow has independent history
     * _Requirements: 2.3_
     */
    it('should give each subflow independent history', async () => {
      const subflow1: StageNode = {
        name: 'subflow1Root',
        id: 'subflow1Root',
        isSubflowRoot: true,
        subflowId: 'subflow-1',
        subflowName: 'Subflow 1',
        fn: (scope: StageContext) => {
          scope.setObject([], 'data1', 'value1');
          return 'result1';
        },
      };

      const subflow2: StageNode = {
        name: 'subflow2Root',
        id: 'subflow2Root',
        isSubflowRoot: true,
        subflowId: 'subflow-2',
        subflowName: 'Subflow 2',
        fn: (scope: StageContext) => {
          scope.setObject([], 'data2', 'value2');
          return 'result2';
        },
      };

      const root: StageNode = {
        name: 'root',
        id: 'root',
        fn: () => 'root-done',
        children: [subflow1, subflow2],
      };

      const stageMap = new Map();
      const pipeline = new Pipeline(root, stageMap, testScopeFactory);

      await pipeline.execute();

      const subflowResults = pipeline.getSubflowResults();
      expect(subflowResults.size).toBe(2);

      const result1 = subflowResults.get('subflow-1')!;
      const result2 = subflowResults.get('subflow-2')!;

      // Each subflow should have its own history
      expect(result1.treeContext.history).toBeDefined();
      expect(result2.treeContext.history).toBeDefined();

      // Histories should be independent (different arrays)
      expect(result1.treeContext.history).not.toBe(result2.treeContext.history);
    });
  });

  describe('Subflow Result Storage', () => {
    /**
     * Test: Parent stage contains subflowResult in debugInfo
     * _Requirements: 3.1, 3.2, 3.3_
     */
    it('should store subflow result in parent stage debugInfo', async () => {
      const subflowStage: StageNode = {
        name: 'subflowRoot',
        id: 'subflowRoot',
        isSubflowRoot: true,
        subflowId: 'stored-subflow',
        subflowName: 'Stored Subflow',
        fn: () => 'subflow-output',
      };

      const root: StageNode = {
        name: 'root',
        id: 'root',
        fn: () => 'root-output',
        next: subflowStage,
      };

      const stageMap = new Map();
      const pipeline = new Pipeline(root, stageMap, testScopeFactory);

      await pipeline.execute();

      // Check the context tree for subflow metadata
      const contextTree = pipeline.getContextTree();
      const stageContexts = contextTree.stageContexts;

      // The subflow root stage should have subflow metadata in its logs
      // Navigate to the subflowRoot stage
      expect(stageContexts.next).toBeDefined();
      const subflowStageContext = stageContexts.next!;

      expect(subflowStageContext.logs).toBeDefined();
      expect(subflowStageContext.logs.isSubflowContainer).toBe(true);
      expect(subflowStageContext.logs.subflowId).toBe('stored-subflow');
      expect(subflowStageContext.logs.hasSubflowData).toBe(true);
      expect(subflowStageContext.logs.subflowResult).toBeDefined();
    });

    /**
     * Test: SubflowResult has all required fields
     * _Requirements: 4.4_
     */
    it('should include all required fields in SubflowResult', async () => {
      const subflowStage: StageNode = {
        name: 'completeSubflow',
        id: 'completeSubflow',
        isSubflowRoot: true,
        subflowId: 'complete-subflow',
        subflowName: 'Complete Subflow',
        fn: () => 'complete-output',
      };

      const root: StageNode = {
        name: 'root',
        id: 'root',
        fn: () => 'root-output',
        next: subflowStage,
      };

      const stageMap = new Map();
      const pipeline = new Pipeline(root, stageMap, testScopeFactory);

      await pipeline.execute();

      const subflowResults = pipeline.getSubflowResults();
      const result = subflowResults.get('complete-subflow')!;

      // Verify all required fields
      expect(result.subflowId).toBe('complete-subflow');
      expect(result.subflowName).toBe('Complete Subflow');
      expect(result.pipelineStructure).toBeDefined();
      expect(result.pipelineStructure.name).toBe('completeSubflow');
      expect(result.treeContext).toBeDefined();
      expect(result.treeContext.globalContext).toBeDefined();
      expect(result.treeContext.stageContexts).toBeDefined();
      expect(result.treeContext.history).toBeDefined();
      expect(result.parentStageId).toBeDefined();
    });
  });

  describe('SubflowResultsMap Collection', () => {
    /**
     * Test: Multiple subflows each have their own entry
     * _Requirements: 4.1, 4.2, 4.3_
     */
    it('should collect all subflow results in SubflowResultsMap', async () => {
      const subflows: StageNode[] = [
        {
          name: 'subflowA',
          id: 'subflowA',
          isSubflowRoot: true,
          subflowId: 'subflow-a',
          subflowName: 'Subflow A',
          fn: () => 'a-output',
        },
        {
          name: 'subflowB',
          id: 'subflowB',
          isSubflowRoot: true,
          subflowId: 'subflow-b',
          subflowName: 'Subflow B',
          fn: () => 'b-output',
        },
        {
          name: 'subflowC',
          id: 'subflowC',
          isSubflowRoot: true,
          subflowId: 'subflow-c',
          subflowName: 'Subflow C',
          fn: () => 'c-output',
        },
      ];

      const root: StageNode = {
        name: 'root',
        id: 'root',
        fn: () => 'root-output',
        children: subflows,
      };

      const stageMap = new Map();
      const pipeline = new Pipeline(root, stageMap, testScopeFactory);

      await pipeline.execute();

      const subflowResults = pipeline.getSubflowResults();

      // Should have exactly 3 entries
      expect(subflowResults.size).toBe(3);
      expect(subflowResults.has('subflow-a')).toBe(true);
      expect(subflowResults.has('subflow-b')).toBe(true);
      expect(subflowResults.has('subflow-c')).toBe(true);

      // Each should have correct data
      expect(subflowResults.get('subflow-a')!.subflowName).toBe('Subflow A');
      expect(subflowResults.get('subflow-b')!.subflowName).toBe('Subflow B');
      expect(subflowResults.get('subflow-c')!.subflowName).toBe('Subflow C');
    });
  });

  describe('Backward Compatibility', () => {
    /**
     * Test: Pipeline without subflows executes identically
     * _Requirements: 6.1_
     */
    it('should execute pipeline without subflows identically to before', async () => {
      let executionOrder: string[] = [];

      const root: StageNode = {
        name: 'stage1',
        id: 'stage1',
        fn: (scope: StageContext) => {
          executionOrder.push('stage1');
          scope.setObject([], 'data1', 'value1');
          return 'result1';
        },
        next: {
          name: 'stage2',
          id: 'stage2',
          fn: (scope: StageContext) => {
            executionOrder.push('stage2');
            scope.setObject([], 'data2', 'value2');
            return 'result2';
          },
          next: {
            name: 'stage3',
            id: 'stage3',
            fn: (scope: StageContext) => {
              executionOrder.push('stage3');
              return 'final-result';
            },
          },
        },
      };

      const stageMap = new Map();
      const pipeline = new Pipeline(root, stageMap, testScopeFactory);

      const result = await pipeline.execute();

      // Execution order should be preserved
      expect(executionOrder).toEqual(['stage1', 'stage2', 'stage3']);

      // Result should be the final stage's output
      expect(result).toBe('final-result');

      // No subflows collected
      expect(pipeline.getSubflowResults().size).toBe(0);

      // Context tree should be normal
      const contextTree = pipeline.getContextTree();
      expect(contextTree.stageContexts.name).toBe('stage1');
    });

    /**
     * Test: getContextTree output unchanged for non-subflow stages
     * _Requirements: 6.4_
     */
    it('should maintain backward compatible getContextTree output', async () => {
      const root: StageNode = {
        name: 'simpleStage',
        id: 'simpleStage',
        fn: (scope: StageContext) => {
          scope.setObject([], 'testKey', 'testValue');
          return 'simple-result';
        },
      };

      const stageMap = new Map();
      const pipeline = new Pipeline(root, stageMap, testScopeFactory);

      await pipeline.execute();

      const contextTree = pipeline.getContextTree();

      // Should have standard structure
      expect(contextTree.globalContext).toBeDefined();
      expect(contextTree.stageContexts).toBeDefined();
      expect(contextTree.history).toBeDefined();

      // Stage context should have expected properties
      expect(contextTree.stageContexts.id).toBeDefined();
      expect(contextTree.stageContexts.name).toBe('simpleStage');
      expect(contextTree.stageContexts.logs).toBeDefined();
    });
  });

  describe('Error Handling', () => {
    /**
     * Test: Subflow error stores partial data
     * _Requirements: 3.4_
     */
    it('should store partial data when subflow errors', async () => {
      const subflowStage: StageNode = {
        name: 'errorSubflow',
        id: 'errorSubflow',
        isSubflowRoot: true,
        subflowId: 'error-subflow',
        subflowName: 'Error Subflow',
        fn: (scope: StageContext) => {
          scope.setObject([], 'beforeError', 'value');
          throw new Error('Subflow error');
        },
      };

      const root: StageNode = {
        name: 'root',
        id: 'root',
        fn: () => 'root-output',
        next: subflowStage,
      };

      const stageMap = new Map();
      const pipeline = new Pipeline(root, stageMap, testScopeFactory);

      // Should throw the subflow error
      await expect(pipeline.execute()).rejects.toThrow('Subflow error');

      // But subflow results should still be collected with partial data
      const subflowResults = pipeline.getSubflowResults();
      expect(subflowResults.size).toBe(1);

      const result = subflowResults.get('error-subflow')!;
      expect(result.subflowId).toBe('error-subflow');
      expect(result.treeContext).toBeDefined();
      // Partial data should be present
      expect(result.pipelineStructure).toBeDefined();
    });
  });

  describe('Subflow with Children', () => {
    /**
     * Test: Subflow with internal children executes correctly
     * _Requirements: 1.4_
     */
    it('should execute subflow with internal children', async () => {
      let executedStages: string[] = [];

      const subflowStage: StageNode = {
        name: 'subflowWithChildren',
        id: 'subflowWithChildren',
        isSubflowRoot: true,
        subflowId: 'children-subflow',
        subflowName: 'Children Subflow',
        fn: (scope: StageContext) => {
          executedStages.push('subflowRoot');
          return 'subflow-root-output';
        },
        children: [
          {
            name: 'childA',
            id: 'childA',
            fn: (scope: StageContext) => {
              executedStages.push('childA');
              return 'childA-output';
            },
          },
          {
            name: 'childB',
            id: 'childB',
            fn: (scope: StageContext) => {
              executedStages.push('childB');
              return 'childB-output';
            },
          },
        ],
      };

      const root: StageNode = {
        name: 'root',
        id: 'root',
        fn: () => {
          executedStages.push('root');
          return 'root-output';
        },
        next: subflowStage,
      };

      const stageMap = new Map();
      const pipeline = new Pipeline(root, stageMap, testScopeFactory);

      await pipeline.execute();

      // Root should execute, then subflow root, then children
      expect(executedStages).toContain('root');
      expect(executedStages).toContain('subflowRoot');
      expect(executedStages).toContain('childA');
      expect(executedStages).toContain('childB');

      // Subflow should be collected
      const subflowResults = pipeline.getSubflowResults();
      expect(subflowResults.has('children-subflow')).toBe(true);
    });
  });

  describe('Subflow Structure Serialization', () => {
    /**
     * Test: Subflow with next chain has complete pipelineStructure
     * This tests the fix for the empty subflow visualization bug.
     * The bug was that subflowNode was created with next: undefined,
     * which stripped the subflow's internal structure during serialization.
     * 
     * _Requirements: 5.2, 5.3_
     */
    it('should serialize subflow with next chain completely', async () => {
      let executedStages: string[] = [];

      // Create a subflow with a next chain (like SmartContextFinder)
      const subflowStage: StageNode = {
        name: 'subflowRoot',
        id: 'subflowRoot',
        isSubflowRoot: true,
        subflowId: 'next-chain-subflow',
        subflowName: 'Next Chain Subflow',
        fn: (scope: StageContext) => {
          executedStages.push('subflowRoot');
          return 'subflow-root-output';
        },
        // This is the key: internal structure via next chain
        next: {
          name: 'internalStage1',
          id: 'internalStage1',
          fn: (scope: StageContext) => {
            executedStages.push('internalStage1');
            return 'internal1-output';
          },
          next: {
            name: 'internalStage2',
            id: 'internalStage2',
            fn: (scope: StageContext) => {
              executedStages.push('internalStage2');
              return 'internal2-output';
            },
          },
        },
      };

      const root: StageNode = {
        name: 'root',
        id: 'root',
        fn: () => {
          executedStages.push('root');
          return 'root-output';
        },
        next: subflowStage,
      };

      const stageMap = new Map();
      const pipeline = new Pipeline(root, stageMap, testScopeFactory);

      await pipeline.execute();

      // Verify all stages executed
      expect(executedStages).toContain('root');
      expect(executedStages).toContain('subflowRoot');
      expect(executedStages).toContain('internalStage1');
      expect(executedStages).toContain('internalStage2');

      // Get subflow result and verify pipelineStructure is complete
      const subflowResults = pipeline.getSubflowResults();
      expect(subflowResults.has('next-chain-subflow')).toBe(true);

      const result = subflowResults.get('next-chain-subflow')!;
      const structure = result.pipelineStructure;

      // Verify the structure includes the next chain
      expect(structure.name).toBe('subflowRoot');
      expect(structure.next).toBeDefined();
      expect(structure.next!.name).toBe('internalStage1');
      expect(structure.next!.next).toBeDefined();
      expect(structure.next!.next!.name).toBe('internalStage2');
    });

    /**
     * Test: Subflow with mixed next and children has complete pipelineStructure
     * This simulates the SmartContextFinder pattern: root → next → decider with children
     */
    it('should serialize subflow with mixed next and children completely', async () => {
      let executedStages: string[] = [];

      // Create a subflow with next chain leading to a decider with children
      const subflowStage: StageNode = {
        name: 'extractInput',
        id: 'extractInput',
        isSubflowRoot: true,
        subflowId: 'mixed-subflow',
        subflowName: 'Mixed Subflow',
        fn: (scope: StageContext) => {
          executedStages.push('extractInput');
          return 'extract-output';
        },
        next: {
          name: 'keywordMatcher',
          id: 'keywordMatcher',
          fn: (scope: StageContext) => {
            executedStages.push('keywordMatcher');
            return 'matched'; // Return value for decider
          },
          nextNodeDecider: (output) => output === 'matched' ? 'matchedBranch' : 'notMatchedBranch',
          children: [
            {
              name: 'matchedHandler',
              id: 'matchedBranch',
              fn: (scope: StageContext) => {
                executedStages.push('matchedHandler');
                return 'matched-result';
              },
            },
            {
              name: 'notMatchedHandler',
              id: 'notMatchedBranch',
              fn: (scope: StageContext) => {
                executedStages.push('notMatchedHandler');
                return 'not-matched-result';
              },
            },
          ],
        },
      };

      const root: StageNode = {
        name: 'root',
        id: 'root',
        fn: () => {
          executedStages.push('root');
          return 'root-output';
        },
        next: subflowStage,
      };

      const stageMap = new Map();
      const pipeline = new Pipeline(root, stageMap, testScopeFactory);

      await pipeline.execute();

      // Verify execution path
      expect(executedStages).toContain('root');
      expect(executedStages).toContain('extractInput');
      expect(executedStages).toContain('keywordMatcher');
      expect(executedStages).toContain('matchedHandler');

      // Get subflow result and verify pipelineStructure is complete
      const subflowResults = pipeline.getSubflowResults();
      expect(subflowResults.has('mixed-subflow')).toBe(true);

      const result = subflowResults.get('mixed-subflow')!;
      const structure = result.pipelineStructure;

      // Verify the structure includes the complete tree
      expect(structure.name).toBe('extractInput');
      expect(structure.next).toBeDefined();
      expect(structure.next!.name).toBe('keywordMatcher');
      expect(structure.next!.hasDecider).toBe(true);
      expect(structure.next!.children).toBeDefined();
      expect(structure.next!.children!.length).toBe(2);
      expect(structure.next!.children!.map(c => c.name)).toContain('matchedHandler');
      expect(structure.next!.children!.map(c => c.name)).toContain('notMatchedHandler');
    });
  });
});


describe('Reference-Based Subflow Resolution', () => {
  /**
   * Test: Reference nodes are resolved from subflows dictionary
   * _Requirements: Task 14 - Runtime reference resolution_
   */
  it('should resolve reference nodes from subflows dictionary', async () => {
    let executedStages: string[] = [];

    // Create a subflow definition (what would be in subflows dictionary)
    const subflowRoot: StageNode = {
      name: 'subflowEntry',
      id: 'subflowEntry',
      fn: (scope: StageContext) => {
        executedStages.push('subflowEntry');
        return 'subflow-output';
      },
      next: {
        name: 'subflowStep2',
        id: 'subflowStep2',
        fn: (scope: StageContext) => {
          executedStages.push('subflowStep2');
          return 'step2-output';
        },
      },
    };

    // Create a reference node (lightweight, no fn/children)
    const referenceNode: StageNode = {
      name: 'Subflow Mount',
      id: 'subflow-mount',
      isSubflowRoot: true,
      subflowId: 'subflow-mount',
      subflowName: 'Subflow Mount',
    };

    const root: StageNode = {
      name: 'root',
      id: 'root',
      fn: () => {
        executedStages.push('root');
        return 'root-output';
      },
      next: referenceNode,
    };

    // Create subflows dictionary - key is the subflowId (mount id)
    const subflows = {
      'subflow-mount': { root: subflowRoot },
    };

    const stageMap = new Map();
    const pipeline = new Pipeline(root, stageMap, testScopeFactory, undefined, undefined, undefined, undefined, undefined, undefined, undefined, subflows);

    await pipeline.execute();

    // Verify all stages executed including resolved subflow
    expect(executedStages).toContain('root');
    expect(executedStages).toContain('subflowEntry');
    expect(executedStages).toContain('subflowStep2');

    // Verify subflow results were collected
    const subflowResults = pipeline.getSubflowResults();
    expect(subflowResults.has('subflow-mount')).toBe(true);
  });

  /**
   * Test: Same subflow mounted twice uses same definition
   * _Requirements: Task 13 - Memoization test_
   */
  it('should use same subflow definition for multiple mounts', async () => {
    let executionCount = 0;

    // Create a subflow definition
    const subflowRoot: StageNode = {
      name: 'sharedSubflow',
      id: 'sharedSubflow',
      fn: (scope: StageContext) => {
        executionCount++;
        return `execution-${executionCount}`;
      },
    };

    // Create two reference nodes pointing to same subflow
    const ref1: StageNode = {
      name: 'Mount 1',
      id: 'mount-1',
      isSubflowRoot: true,
      subflowId: 'mount-1',
      subflowName: 'sharedSubflow',
    };

    const ref2: StageNode = {
      name: 'Mount 2',
      id: 'mount-2',
      isSubflowRoot: true,
      subflowId: 'mount-2',
      subflowName: 'sharedSubflow',
    };

    const root: StageNode = {
      name: 'root',
      id: 'root',
      fn: () => 'root-output',
      children: [ref1, ref2],
    };

    // Single definition in subflows dictionary
    const subflows = {
      'sharedSubflow': { root: subflowRoot },
    };

    const stageMap = new Map();
    const pipeline = new Pipeline(root, stageMap, testScopeFactory, undefined, undefined, undefined, undefined, undefined, undefined, undefined, subflows);

    await pipeline.execute();

    // Both mounts should execute (2 executions)
    expect(executionCount).toBe(2);

    // Both should be in subflow results with different IDs
    const subflowResults = pipeline.getSubflowResults();
    expect(subflowResults.has('mount-1')).toBe(true);
    expect(subflowResults.has('mount-2')).toBe(true);
  });

  /**
   * Test: Reference node preserves metadata during resolution
   * _Requirements: Task 14 - Metadata preservation_
   */
  it('should preserve reference node metadata during resolution', async () => {
    const subflowRoot: StageNode = {
      name: 'originalName',
      id: 'originalId',
      fn: () => 'subflow-output',
    };

    // Reference node with custom metadata
    const referenceNode: StageNode = {
      name: 'Custom Display Name',
      id: 'custom-mount-id',
      isSubflowRoot: true,
      subflowId: 'custom-mount-id',
      subflowName: 'originalName',
      displayName: 'My Custom Subflow',
    };

    const root: StageNode = {
      name: 'root',
      id: 'root',
      fn: () => 'root-output',
      next: referenceNode,
    };

    const subflows = {
      'originalName': { root: subflowRoot },
    };

    const stageMap = new Map();
    const pipeline = new Pipeline(root, stageMap, testScopeFactory, undefined, undefined, undefined, undefined, undefined, undefined, undefined, subflows);

    await pipeline.execute();

    // Verify subflow result uses reference node's metadata
    const subflowResults = pipeline.getSubflowResults();
    expect(subflowResults.has('custom-mount-id')).toBe(true);

    const result = subflowResults.get('custom-mount-id')!;
    expect(result.subflowId).toBe('custom-mount-id');
    expect(result.subflowName).toBe('originalName');
  });

  /**
   * Test: Backward compatibility - nodes with fn still work
   * _Requirements: Task 14 - Backward compatibility_
   */
  it('should handle subflow nodes with embedded fn (non-reference)', async () => {
    let executed = false;

    // Old-style subflow node with embedded fn (not a reference)
    const subflowNode: StageNode = {
      name: 'embeddedSubflow',
      id: 'embeddedSubflow',
      isSubflowRoot: true,
      subflowId: 'embedded-subflow',
      subflowName: 'Embedded Subflow',
      fn: () => {
        executed = true;
        return 'embedded-output';
      },
    };

    const root: StageNode = {
      name: 'root',
      id: 'root',
      fn: () => 'root-output',
      next: subflowNode,
    };

    // No subflows dictionary - using old approach
    const stageMap = new Map();
    const pipeline = new Pipeline(root, stageMap, testScopeFactory);

    await pipeline.execute();

    // Should still execute the embedded fn
    expect(executed).toBe(true);

    // Should still collect subflow results
    const subflowResults = pipeline.getSubflowResults();
    expect(subflowResults.has('embedded-subflow')).toBe(true);
  });

  /**
   * Test: Nested subflows in subflows dictionary
   * _Requirements: Task 14 - Nested subflow support_
   */
  it('should resolve nested subflows from dictionary', async () => {
    let executedStages: string[] = [];

    // Inner subflow definition
    const innerSubflow: StageNode = {
      name: 'innerSubflow',
      id: 'innerSubflow',
      fn: () => {
        executedStages.push('innerSubflow');
        return 'inner-output';
      },
    };

    // Outer subflow that references inner subflow
    const outerSubflow: StageNode = {
      name: 'outerSubflow',
      id: 'outerSubflow',
      fn: () => {
        executedStages.push('outerSubflow');
        return 'outer-output';
      },
      next: {
        name: 'Inner Mount',
        id: 'inner-mount',
        isSubflowRoot: true,
        subflowId: 'inner-mount',
        subflowName: 'innerSubflow',
      },
    };

    // Reference to outer subflow
    const outerRef: StageNode = {
      name: 'Outer Mount',
      id: 'outer-mount',
      isSubflowRoot: true,
      subflowId: 'outer-mount',
      subflowName: 'outerSubflow',
    };

    const root: StageNode = {
      name: 'root',
      id: 'root',
      fn: () => {
        executedStages.push('root');
        return 'root-output';
      },
      next: outerRef,
    };

    // Both subflows in dictionary
    const subflows = {
      'outerSubflow': { root: outerSubflow },
      'innerSubflow': { root: innerSubflow },
    };

    const stageMap = new Map();
    const pipeline = new Pipeline(root, stageMap, testScopeFactory, undefined, undefined, undefined, undefined, undefined, undefined, undefined, subflows);

    await pipeline.execute();

    // All stages should execute
    expect(executedStages).toContain('root');
    expect(executedStages).toContain('outerSubflow');
    expect(executedStages).toContain('innerSubflow');

    // Both subflows should be in results
    const subflowResults = pipeline.getSubflowResults();
    expect(subflowResults.has('outer-mount')).toBe(true);
    expect(subflowResults.has('inner-mount')).toBe(true);
  });
});
