/**
 * FlowChartBuilder.subflowOptions.test.ts
 *
 * Unit tests for FlowChartBuilder subflow mount options.
 * Tests that SubflowMountOptions are correctly stored in StageNode.
 *
 * **Property 1: Builder API Stores SubflowMountOptions**
 * **Validates: Requirements 1.1, 1.2, 1.3, 1.5, 3.1, 3.2, 3.3, 6.4**
 */

import { FlowChartBuilder } from '../../../../src/core/builder/FlowChartBuilder';
import type { SubflowMountOptions } from '../../../../src/core/executor/types';

describe('FlowChartBuilder — SubflowMountOptions', () => {
  // Helper to build a simple subflow for testing
  const buildSimpleSubflow = () => {
    return new FlowChartBuilder()
      .start('subflowEntry', async () => 'subflow-result')
      .addFunction('subflowStep')
      .build();
  };

  describe('addSubFlowChart', () => {
    it('stores subflowMountOptions in StageNode when provided', () => {
      const subflow = buildSimpleSubflow();
      const options: SubflowMountOptions = {
        inputMapper: (scope: any) => ({ userId: scope.userId }),
        scopeMode: 'isolated',
      };

      const main = new FlowChartBuilder()
        .start('entry')
        .addSubFlowChart('sub1', subflow, 'Subflow 1', options)
        .build();

      // Find the subflow node in children
      const subflowNode = main.root.children?.find(c => c.id === 'sub1');
      expect(subflowNode).toBeDefined();
      expect(subflowNode?.subflowMountOptions).toBeDefined();
      expect(subflowNode?.subflowMountOptions?.scopeMode).toBe('isolated');
      expect(typeof subflowNode?.subflowMountOptions?.inputMapper).toBe('function');
    });

    it('does not set subflowMountOptions when options not provided', () => {
      const subflow = buildSimpleSubflow();

      const main = new FlowChartBuilder()
        .start('entry')
        .addSubFlowChart('sub1', subflow, 'Subflow 1')
        .build();

      const subflowNode = main.root.children?.find(c => c.id === 'sub1');
      expect(subflowNode).toBeDefined();
      expect(subflowNode?.subflowMountOptions).toBeUndefined();
    });

    it('stores outputMapper in subflowMountOptions', () => {
      const subflow = buildSimpleSubflow();
      const options: SubflowMountOptions = {
        outputMapper: (output: any, _parentScope: any) => ({ result: output }),
      };

      const main = new FlowChartBuilder()
        .start('entry')
        .addSubFlowChart('sub1', subflow, 'Subflow 1', options)
        .build();

      const subflowNode = main.root.children?.find(c => c.id === 'sub1');
      expect(subflowNode?.subflowMountOptions?.outputMapper).toBeDefined();
      expect(typeof subflowNode?.subflowMountOptions?.outputMapper).toBe('function');
    });
  });

  describe('addSubFlowChartNext', () => {
    it('stores subflowMountOptions in StageNode when provided', () => {
      const subflow = buildSimpleSubflow();
      const options: SubflowMountOptions = {
        inputMapper: (scope: any) => ({ data: scope.data }),
        scopeMode: 'inherit',
      };

      const main = new FlowChartBuilder()
        .start('entry')
        .addSubFlowChartNext('sub1', subflow, 'Subflow 1', options)
        .build();

      // The subflow is mounted as next
      const subflowNode = main.root.next;
      expect(subflowNode).toBeDefined();
      expect(subflowNode?.id).toBe('sub1');
      expect(subflowNode?.subflowMountOptions).toBeDefined();
      expect(subflowNode?.subflowMountOptions?.scopeMode).toBe('inherit');
    });

    it('does not set subflowMountOptions when options not provided', () => {
      const subflow = buildSimpleSubflow();

      const main = new FlowChartBuilder()
        .start('entry')
        .addSubFlowChartNext('sub1', subflow, 'Subflow 1')
        .build();

      const subflowNode = main.root.next;
      expect(subflowNode).toBeDefined();
      expect(subflowNode?.subflowMountOptions).toBeUndefined();
    });
  });

  describe('DeciderList.addSubFlowChartBranch', () => {
    it('stores subflowMountOptions in StageNode when provided', () => {
      // Use unique subflows to avoid stageMap collision
      const subflowA = new FlowChartBuilder()
        .start('subflowEntryA', async () => 'result-a')
        .build();
      const subflowB = new FlowChartBuilder()
        .start('subflowEntryB', async () => 'result-b')
        .build();
      const optionsA: SubflowMountOptions = {
        inputMapper: (scope: any) => ({ branchData: scope.branchData }),
        scopeMode: 'isolated',
      };

      const main = new FlowChartBuilder()
        .start('entry')
        .addDecider(() => 'branchA')
          .addSubFlowChartBranch('branchA', subflowA, 'Branch A', optionsA)
          .addSubFlowChartBranch('branchB', subflowB, 'Branch B')
        .end()
        .build();

      // Find branch nodes in children
      const branchA = main.root.children?.find(c => c.id === 'branchA');
      const branchB = main.root.children?.find(c => c.id === 'branchB');

      expect(branchA).toBeDefined();
      expect(branchA?.subflowMountOptions).toBeDefined();
      expect(branchA?.subflowMountOptions?.scopeMode).toBe('isolated');

      expect(branchB).toBeDefined();
      expect(branchB?.subflowMountOptions).toBeUndefined();
    });
  });

  describe('SelectorList.addSubFlowChartBranch', () => {
    it('stores subflowMountOptions in StageNode when provided', () => {
      // Use unique subflows to avoid stageMap collision
      const subflowA = new FlowChartBuilder()
        .start('subflowEntryA', async () => 'result-a')
        .build();
      const subflowB = new FlowChartBuilder()
        .start('subflowEntryB', async () => 'result-b')
        .build();
      const optionsB: SubflowMountOptions = {
        inputMapper: (scope: any) => ({ selectedData: scope.selectedData }),
        outputMapper: (output: any) => ({ selectedResult: output }),
        scopeMode: 'inherit',
      };

      const main = new FlowChartBuilder()
        .start('entry')
        .addSelector(() => ['branchA', 'branchB'])
          .addSubFlowChartBranch('branchA', subflowA, 'Branch A')
          .addSubFlowChartBranch('branchB', subflowB, 'Branch B', optionsB)
        .end()
        .build();

      // Find branch nodes in children
      const branchA = main.root.children?.find(c => c.id === 'branchA');
      const branchB = main.root.children?.find(c => c.id === 'branchB');

      expect(branchA).toBeDefined();
      expect(branchA?.subflowMountOptions).toBeUndefined();

      expect(branchB).toBeDefined();
      expect(branchB?.subflowMountOptions).toBeDefined();
      expect(branchB?.subflowMountOptions?.scopeMode).toBe('inherit');
      expect(typeof branchB?.subflowMountOptions?.inputMapper).toBe('function');
      expect(typeof branchB?.subflowMountOptions?.outputMapper).toBe('function');
    });
  });

  describe('backward compatibility', () => {
    it('existing subflow mounting works without options parameter', () => {
      const subflow = buildSimpleSubflow();

      // All these should work without options
      const main = new FlowChartBuilder()
        .start('entry')
        .addSubFlowChart('fork1', subflow, 'Fork 1')
        .addSubFlowChartNext('next1', subflow, 'Next 1')
        .build();

      expect(main.root.children).toHaveLength(1);
      expect(main.root.children?.[0].id).toBe('fork1');
      expect(main.root.next?.id).toBe('next1');
    });

    it('decider branches work without options parameter', () => {
      const subflow = buildSimpleSubflow();

      const main = new FlowChartBuilder()
        .start('entry')
        .addDecider(() => 'branch1')
          .addSubFlowChartBranch('branch1', subflow, 'Branch 1')
          .addFunctionBranch('branch2', 'Branch 2')
        .end()
        .build();

      expect(main.root.children).toHaveLength(2);
    });

    it('selector branches work without options parameter', () => {
      const subflow = buildSimpleSubflow();

      const main = new FlowChartBuilder()
        .start('entry')
        .addSelector(() => ['branch1'])
          .addSubFlowChartBranch('branch1', subflow, 'Branch 1')
          .addFunctionBranch('branch2', 'Branch 2')
        .end()
        .build();

      expect(main.root.children).toHaveLength(2);
    });
  });

  describe('inputMapper function preservation', () => {
    it('inputMapper function is callable after build', () => {
      const subflow = buildSimpleSubflow();
      const inputMapper = (scope: { userId: string; name: string }) => ({
        id: scope.userId,
        displayName: scope.name,
      });

      const main = new FlowChartBuilder()
        .start('entry')
        .addSubFlowChart('sub1', subflow, 'Subflow 1', { inputMapper })
        .build();

      const subflowNode = main.root.children?.find(c => c.id === 'sub1');
      const storedMapper = subflowNode?.subflowMountOptions?.inputMapper;

      expect(storedMapper).toBeDefined();
      
      // Test that the mapper works correctly
      const testScope = { userId: 'user-123', name: 'Test User' };
      const result = storedMapper!(testScope);
      expect(result).toEqual({ id: 'user-123', displayName: 'Test User' });
    });

    it('outputMapper function is callable after build', () => {
      const subflow = buildSimpleSubflow();
      const outputMapper = (output: string, parentScope: { prefix: string }) => ({
        fullResult: `${parentScope.prefix}: ${output}`,
      });

      const main = new FlowChartBuilder()
        .start('entry')
        .addSubFlowChart('sub1', subflow, 'Subflow 1', { outputMapper })
        .build();

      const subflowNode = main.root.children?.find(c => c.id === 'sub1');
      const storedMapper = subflowNode?.subflowMountOptions?.outputMapper;

      expect(storedMapper).toBeDefined();
      
      // Test that the mapper works correctly
      const result = storedMapper!('done', { prefix: 'Result' });
      expect(result).toEqual({ fullResult: 'Result: done' });
    });
  });
});
