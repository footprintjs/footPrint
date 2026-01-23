/**
 * Pipeline.subflow.integration.test.ts
 *
 * Integration tests for nested subflow contexts using realistic pipeline structures.
 * Tests end-to-end subflow execution with FlowChartBuilder patterns.
 *
 * _Requirements: All (end-to-end validation)_
 */

import { Pipeline, StageNode } from '../../../src/core/pipeline/Pipeline';
import { StageContext } from '../../../src/core/context/StageContext';
import { ScopeFactory } from '../../../src/core/context/types';
import { SubflowResult } from '../../../src/core/pipeline/types';

// Simple scope factory for testing
const testScopeFactory: ScopeFactory<StageContext> = (context: StageContext) => context;

describe('Pipeline Subflow Integration Tests', () => {
  /**
   * Integration Test: LLM-Core Pattern
   * ------------------------------------------------------------------
   * Simulates the llm-core subflow pattern with buildPrompt → askLLM → parseResponse
   */
  describe('LLM-Core Pattern', () => {
    it('should execute llm-core subflow with isolated context', async () => {
      const executionLog: string[] = [];

      // Define the llm-core subflow structure
      const llmCoreSubflow: StageNode = {
        name: 'llm-core',
        id: 'llm-core',
        isSubflowRoot: true,
        subflowId: 'llm-core',
        subflowName: 'LLM Core',
        fn: (scope: StageContext) => {
          executionLog.push('llm-core-root');
          scope.setObject([], 'llmCoreStarted', true);
          return 'llm-core-initialized';
        },
        children: [
          {
            name: 'buildPrompt',
            id: 'buildPrompt',
            fn: (scope: StageContext) => {
              executionLog.push('buildPrompt');
              scope.setObject([], 'prompt', 'Generated prompt');
              return { prompt: 'Generated prompt' };
            },
          },
          {
            name: 'askLLM',
            id: 'askLLM',
            fn: (scope: StageContext) => {
              executionLog.push('askLLM');
              scope.setObject([], 'llmResponse', 'LLM response text');
              return { response: 'LLM response text' };
            },
          },
          {
            name: 'parseResponse',
            id: 'parseResponse',
            fn: (scope: StageContext) => {
              executionLog.push('parseResponse');
              scope.setObject([], 'parsedResult', { parsed: true });
              return { parsed: true };
            },
          },
        ],
      };

      // Parent pipeline structure
      const root: StageNode = {
        name: 'chat',
        id: 'chat',
        fn: (scope: StageContext) => {
          executionLog.push('chat');
          scope.setObject([], 'chatStarted', true);
          return 'chat-initialized';
        },
        next: {
          name: 'prepareContext',
          id: 'prepareContext',
          fn: (scope: StageContext) => {
            executionLog.push('prepareContext');
            scope.setObject([], 'contextPrepared', true);
            return 'context-ready';
          },
          next: {
            ...llmCoreSubflow,
            next: {
              name: 'formatOutput',
              id: 'formatOutput',
              fn: (scope: StageContext) => {
                executionLog.push('formatOutput');
                scope.setObject([], 'outputFormatted', true);
                return 'final-output';
              },
            },
          },
        },
      };

      const stageMap = new Map();
      const pipeline = new Pipeline(root, stageMap, testScopeFactory);

      const result = await pipeline.execute();

      // Verify execution order
      expect(executionLog).toEqual([
        'chat',
        'prepareContext',
        'llm-core-root',
        'buildPrompt',
        'askLLM',
        'parseResponse',
        'formatOutput',
      ]);

      // Verify subflow was collected
      const subflowResults = pipeline.getSubflowResults();
      expect(subflowResults.size).toBe(1);
      expect(subflowResults.has('llm-core')).toBe(true);

      // Verify subflow result structure
      const llmCoreResult = subflowResults.get('llm-core')!;
      expect(llmCoreResult.subflowId).toBe('llm-core');
      expect(llmCoreResult.subflowName).toBe('LLM Core');
      expect(llmCoreResult.pipelineStructure.name).toBe('llm-core');
      expect(llmCoreResult.pipelineStructure.children).toHaveLength(3);

      // Verify subflow context isolation
      const subflowContext = llmCoreResult.treeContext;
      expect(subflowContext.globalContext).toBeDefined();

      // Verify parent context doesn't have subflow data
      const parentContext = pipeline.getContextTree();
      const parentGlobal = parentContext.globalContext as Record<string, unknown>;
      expect(parentGlobal['chatStarted']).toBe(true);
      expect(parentGlobal['contextPrepared']).toBe(true);
      expect(parentGlobal['outputFormatted']).toBe(true);
      // Subflow data should NOT be in parent
      expect(parentGlobal['llmCoreStarted']).toBeUndefined();
      expect(parentGlobal['prompt']).toBeUndefined();
    });

    it('should provide data for frontend drill-down navigation', async () => {
      // Subflow with children (parallel stages) - the correct pattern for subflow internal structure
      const llmCoreSubflow: StageNode = {
        name: 'llm-core',
        id: 'llm-core',
        isSubflowRoot: true,
        subflowId: 'llm-core',
        subflowName: 'LLM Core',
        displayName: 'LLM Core Processing',
        fn: () => 'initialized',
        children: [
          {
            name: 'buildPrompt',
            id: 'buildPrompt',
            displayName: 'Build Prompt',
            fn: (scope: StageContext) => {
              scope.setObject([], 'promptData', { template: 'test', variables: ['a', 'b'] });
              return 'prompt-built';
            },
          },
          {
            name: 'askLLM',
            id: 'askLLM',
            displayName: 'Ask LLM',
            isStreaming: true,
            fn: (scope: StageContext) => {
              scope.setObject([], 'llmData', { model: 'claude', tokens: 100 });
              return 'llm-response';
            },
          },
        ],
      };

      const root: StageNode = {
        name: 'root',
        id: 'root',
        fn: () => 'root-done',
        next: llmCoreSubflow,
      };

      const stageMap = new Map();
      const pipeline = new Pipeline(root, stageMap, testScopeFactory);

      await pipeline.execute();

      const subflowResults = pipeline.getSubflowResults();
      const llmCoreResult = subflowResults.get('llm-core')!;

      // Frontend needs: pipelineStructure for flowchart rendering
      const structure = llmCoreResult.pipelineStructure;
      expect(structure.name).toBe('llm-core');
      expect(structure.displayName).toBe('LLM Core Processing');
      // Type field is required for frontend rendering
      expect(structure.type).toBe('fork'); // Has children, so it's a fork
      // Children are used for subflow internal structure
      expect(structure.children).toHaveLength(2);
      expect(structure.children![0].name).toBe('buildPrompt');
      expect(structure.children![0].displayName).toBe('Build Prompt');
      expect(structure.children![0].type).toBe('stage'); // Regular stage
      expect(structure.children![1].name).toBe('askLLM');
      expect(structure.children![1].isStreaming).toBe(true);
      expect(structure.children![1].type).toBe('streaming'); // Streaming stage type

      // Frontend needs: treeContext for stage data display
      const treeContext = llmCoreResult.treeContext;
      expect(treeContext.stageContexts).toBeDefined();
      expect(treeContext.history).toBeDefined();

      // Frontend needs: parentStageId for breadcrumb navigation
      expect(llmCoreResult.parentStageId).toBeDefined();
    });
  });

  /**
   * Integration Test: Nested Subflows
   * ------------------------------------------------------------------
   * Tests subflow containing another subflow (e.g., chat → llm-core → tool-executor)
   */
  describe('Nested Subflows', () => {
    it('should handle subflow containing another subflow', async () => {
      const executionLog: string[] = [];

      // Inner subflow: tool-executor
      const toolExecutorSubflow: StageNode = {
        name: 'tool-executor',
        id: 'tool-executor',
        isSubflowRoot: true,
        subflowId: 'tool-executor',
        subflowName: 'Tool Executor',
        fn: (scope: StageContext) => {
          executionLog.push('tool-executor');
          scope.setObject([], 'toolExecuted', true);
          return 'tool-result';
        },
      };

      // Outer subflow: llm-core (contains tool-executor)
      const llmCoreSubflow: StageNode = {
        name: 'llm-core',
        id: 'llm-core',
        isSubflowRoot: true,
        subflowId: 'llm-core',
        subflowName: 'LLM Core',
        fn: (scope: StageContext) => {
          executionLog.push('llm-core');
          scope.setObject([], 'llmStarted', true);
          return 'llm-initialized';
        },
        next: {
          name: 'processTools',
          id: 'processTools',
          fn: (scope: StageContext) => {
            executionLog.push('processTools');
            return 'tools-processed';
          },
          next: toolExecutorSubflow,
        },
      };

      // Parent pipeline
      const root: StageNode = {
        name: 'chat',
        id: 'chat',
        fn: (scope: StageContext) => {
          executionLog.push('chat');
          scope.setObject([], 'chatStarted', true);
          return 'chat-done';
        },
        next: llmCoreSubflow,
      };

      const stageMap = new Map();
      const pipeline = new Pipeline(root, stageMap, testScopeFactory);

      await pipeline.execute();

      // Verify execution order
      expect(executionLog).toEqual([
        'chat',
        'llm-core',
        'processTools',
        'tool-executor',
      ]);

      // Verify both subflows were collected
      const subflowResults = pipeline.getSubflowResults();
      expect(subflowResults.size).toBe(2);
      expect(subflowResults.has('llm-core')).toBe(true);
      expect(subflowResults.has('tool-executor')).toBe(true);

      // Verify each subflow has isolated context
      const llmCoreResult = subflowResults.get('llm-core')!;
      const toolExecutorResult = subflowResults.get('tool-executor')!;

      expect(llmCoreResult.treeContext).toBeDefined();
      expect(toolExecutorResult.treeContext).toBeDefined();

      // Contexts should be different objects
      expect(llmCoreResult.treeContext).not.toBe(toolExecutorResult.treeContext);
    });
  });

  /**
   * Integration Test: Multiple Parallel Subflows
   * ------------------------------------------------------------------
   * Tests multiple subflows executing in parallel (fork pattern)
   */
  describe('Multiple Parallel Subflows', () => {
    it('should execute multiple subflows in parallel with isolated contexts', async () => {
      const executionLog: string[] = [];

      const subflowA: StageNode = {
        name: 'subflowA',
        id: 'subflowA',
        isSubflowRoot: true,
        subflowId: 'subflow-a',
        subflowName: 'Subflow A',
        fn: (scope: StageContext) => {
          executionLog.push('subflowA');
          scope.setObject([], 'dataA', 'valueA');
          return 'resultA';
        },
      };

      const subflowB: StageNode = {
        name: 'subflowB',
        id: 'subflowB',
        isSubflowRoot: true,
        subflowId: 'subflow-b',
        subflowName: 'Subflow B',
        fn: (scope: StageContext) => {
          executionLog.push('subflowB');
          scope.setObject([], 'dataB', 'valueB');
          return 'resultB';
        },
      };

      const subflowC: StageNode = {
        name: 'subflowC',
        id: 'subflowC',
        isSubflowRoot: true,
        subflowId: 'subflow-c',
        subflowName: 'Subflow C',
        fn: (scope: StageContext) => {
          executionLog.push('subflowC');
          scope.setObject([], 'dataC', 'valueC');
          return 'resultC';
        },
      };

      const root: StageNode = {
        name: 'root',
        id: 'root',
        fn: () => {
          executionLog.push('root');
          return 'root-done';
        },
        children: [subflowA, subflowB, subflowC],
      };

      const stageMap = new Map();
      const pipeline = new Pipeline(root, stageMap, testScopeFactory);

      await pipeline.execute();

      // Root should execute first
      expect(executionLog[0]).toBe('root');

      // All subflows should execute (order may vary due to parallel execution)
      expect(executionLog).toContain('subflowA');
      expect(executionLog).toContain('subflowB');
      expect(executionLog).toContain('subflowC');

      // All subflows should be collected
      const subflowResults = pipeline.getSubflowResults();
      expect(subflowResults.size).toBe(3);

      // Each subflow should have isolated data
      const resultA = subflowResults.get('subflow-a')!;
      const resultB = subflowResults.get('subflow-b')!;
      const resultC = subflowResults.get('subflow-c')!;

      // Verify isolation - each subflow's data should only be in its own context
      const globalA = resultA.treeContext.globalContext as Record<string, unknown>;
      const globalB = resultB.treeContext.globalContext as Record<string, unknown>;
      const globalC = resultC.treeContext.globalContext as Record<string, unknown>;

      expect(globalA['dataA']).toBe('valueA');
      expect(globalA['dataB']).toBeUndefined();
      expect(globalA['dataC']).toBeUndefined();

      expect(globalB['dataB']).toBe('valueB');
      expect(globalB['dataA']).toBeUndefined();
      expect(globalB['dataC']).toBeUndefined();

      expect(globalC['dataC']).toBe('valueC');
      expect(globalC['dataA']).toBeUndefined();
      expect(globalC['dataB']).toBeUndefined();
    });
  });

  /**
   * Integration Test: Subflow with Decider
   * ------------------------------------------------------------------
   * Tests subflow containing a decider node
   */
  describe('Subflow with Decider', () => {
    it('should execute subflow with internal decider correctly', async () => {
      const executionLog: string[] = [];

      const subflowWithDecider: StageNode = {
        name: 'deciderSubflow',
        id: 'deciderSubflow',
        isSubflowRoot: true,
        subflowId: 'decider-subflow',
        subflowName: 'Decider Subflow',
        fn: (scope: StageContext) => {
          executionLog.push('deciderSubflow-root');
          scope.setObject([], 'decision', 'pathB');
          return 'pathB'; // Return value used by decider
        },
        nextNodeDecider: (input: string) => input, // Use stage output as decision
        children: [
          {
            name: 'pathA',
            id: 'pathA',
            fn: () => {
              executionLog.push('pathA');
              return 'pathA-result';
            },
          },
          {
            name: 'pathB',
            id: 'pathB',
            fn: () => {
              executionLog.push('pathB');
              return 'pathB-result';
            },
          },
        ],
      };

      const root: StageNode = {
        name: 'root',
        id: 'root',
        fn: () => {
          executionLog.push('root');
          return 'root-done';
        },
        next: subflowWithDecider,
      };

      const stageMap = new Map();
      const pipeline = new Pipeline(root, stageMap, testScopeFactory);

      await pipeline.execute();

      // Verify execution order - decider should pick pathB
      expect(executionLog).toEqual(['root', 'deciderSubflow-root', 'pathB']);

      // Verify subflow was collected
      const subflowResults = pipeline.getSubflowResults();
      expect(subflowResults.has('decider-subflow')).toBe(true);

      // Verify structure includes decider info
      const result = subflowResults.get('decider-subflow')!;
      expect(result.pipelineStructure.hasDecider).toBe(true);
      expect(result.pipelineStructure.children).toHaveLength(2);
    });
  });

  /**
   * Integration Test: Error Recovery
   * ------------------------------------------------------------------
   * Tests that subflow errors are properly captured with partial data
   */
  describe('Error Recovery', () => {
    it('should capture partial execution data on subflow error', async () => {
      const executionLog: string[] = [];

      // Subflow with children (parallel stages) - one will fail
      const errorSubflow: StageNode = {
        name: 'errorSubflow',
        id: 'errorSubflow',
        isSubflowRoot: true,
        subflowId: 'error-subflow',
        subflowName: 'Error Subflow',
        fn: (scope: StageContext) => {
          executionLog.push('errorSubflow-root');
          scope.setObject([], 'beforeError', 'captured');
          return 'initialized';
        },
        children: [
          {
            name: 'willSucceed',
            id: 'willSucceed',
            fn: (scope: StageContext) => {
              executionLog.push('willSucceed');
              scope.setObject([], 'successData', 'also-captured');
              return 'success';
            },
          },
          {
            name: 'willFail',
            id: 'willFail',
            fn: () => {
              executionLog.push('willFail');
              throw new Error('Intentional failure');
            },
          },
        ],
      };

      const root: StageNode = {
        name: 'root',
        id: 'root',
        fn: () => {
          executionLog.push('root');
          return 'root-done';
        },
        next: errorSubflow,
      };

      const stageMap = new Map();
      const pipeline = new Pipeline(root, stageMap, testScopeFactory);

      // Execute - children execute in parallel, so one may succeed before the other fails
      // The pipeline should still complete (children errors are captured, not thrown)
      await pipeline.execute();

      // Verify execution - root and subflow root execute, then children in parallel
      expect(executionLog).toContain('root');
      expect(executionLog).toContain('errorSubflow-root');
      expect(executionLog).toContain('willSucceed');
      expect(executionLog).toContain('willFail');

      // Verify subflow result was captured
      const subflowResults = pipeline.getSubflowResults();
      expect(subflowResults.has('error-subflow')).toBe(true);

      const result = subflowResults.get('error-subflow')!;
      expect(result.subflowId).toBe('error-subflow');
      expect(result.treeContext).toBeDefined();
      expect(result.pipelineStructure).toBeDefined();

      // Partial data should be in the context (from root fn)
      const globalContext = result.treeContext.globalContext as Record<string, unknown>;
      expect(globalContext['beforeError']).toBe('captured');
      // Note: successData is in the child's context, not global
    });
  });

  /**
   * Integration Test: API Response Structure
   * ------------------------------------------------------------------
   * Verifies the SubflowResult structure matches what the frontend expects
   */
  describe('API Response Structure', () => {
    it('should produce SubflowResult compatible with SubflowCallInfo frontend type', async () => {
      const subflow: StageNode = {
        name: 'apiSubflow',
        id: 'apiSubflow',
        isSubflowRoot: true,
        subflowId: 'api-subflow',
        subflowName: 'API Subflow',
        displayName: 'API Processing Subflow',
        fn: (scope: StageContext) => {
          scope.setObject([], 'apiData', { endpoint: '/test', method: 'GET' });
          return 'api-done';
        },
        children: [
          {
            name: 'validate',
            id: 'validate',
            displayName: 'Validate Request',
            fn: () => 'validated',
          },
          {
            name: 'execute',
            id: 'execute',
            displayName: 'Execute Request',
            isStreaming: true,
            fn: () => 'executed',
          },
        ],
      };

      const root: StageNode = {
        name: 'root',
        id: 'root',
        fn: () => 'root-done',
        next: subflow,
      };

      const stageMap = new Map();
      const pipeline = new Pipeline(root, stageMap, testScopeFactory);

      await pipeline.execute();

      const subflowResults = pipeline.getSubflowResults();
      const result = subflowResults.get('api-subflow')!;

      // Verify structure matches SubflowCallInfo expectations
      // (from 📦 AWSHodgkinFrontendAssets/src/types/chat.ts)
      
      // Required fields
      expect(typeof result.subflowId).toBe('string');
      expect(typeof result.subflowName).toBe('string');
      expect(typeof result.parentStageId).toBe('string');
      
      // pipelineStructure for flowchart rendering
      expect(result.pipelineStructure).toMatchObject({
        name: 'apiSubflow',
        displayName: 'API Processing Subflow',
        children: expect.arrayContaining([
          expect.objectContaining({ name: 'validate', displayName: 'Validate Request' }),
          expect.objectContaining({ name: 'execute', displayName: 'Execute Request', isStreaming: true }),
        ]),
      });

      // treeContext for stage data
      expect(result.treeContext).toMatchObject({
        globalContext: expect.any(Object),
        stageContexts: expect.any(Object),
        history: expect.any(Array),
      });
    });
  });
});
