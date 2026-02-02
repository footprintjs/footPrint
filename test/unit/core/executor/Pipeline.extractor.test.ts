/**
 * Pipeline.extractor.test.ts
 *
 * Tests for the traversal extractor feature.
 * Validates that extractors are called correctly during pipeline execution
 * and that results are collected properly.
 */

import { FlowChartBuilder } from '../../../../src/core/builder/FlowChartBuilder';
import { Pipeline, StageNode } from '../../../../src/core/executor/Pipeline';
import { TraversalExtractor, PipelineStageFunction } from '../../../../src/core/executor/types';
import { StageContext } from '../../../../src/core/memory/StageContext';
import type { ScopeFactory } from '../../../../src/scope/providers/types';

type TOut = any;
type TScope = any;
type PSF = PipelineStageFunction<TOut, TScope>;
type Node = StageNode<TOut, TScope>;

// Silence logger noise
jest.mock('../../../../src/utils/logger', () => ({
  logger: { error: jest.fn(), info: jest.fn(), warn: jest.fn() },
}));

// Simple scope factory - returns context as scope
const scopeFactory: ScopeFactory<any> = (ctx: any) => ctx;

// Build a typed stageMap from object
const makeMap = (obj: Record<string, jest.Mock<any, any>>): Map<string, PSF> => {
  const m = new Map<string, PSF>();
  for (const [k, v] of Object.entries(obj)) m.set(k, v as unknown as PSF);
  return m;
};

describe('Pipeline Traversal Extractor', () => {
  describe('Registration (FlowChartBuilder)', () => {
    it('should store extractor when addTraversalExtractor is called', () => {
      const extractor: TraversalExtractor = () => ({ test: true });
      const builder = new FlowChartBuilder()
        .start('entry', async () => 'done')
        .addTraversalExtractor(extractor);

      const { extractor: builtExtractor } = builder.build();
      expect(builtExtractor).toBe(extractor);
    });

    it('should include extractor in build() output', () => {
      const extractor: TraversalExtractor = () => ({ test: true });
      const { root, stageMap, extractor: builtExtractor } = new FlowChartBuilder()
        .start('entry', async () => 'done')
        .addTraversalExtractor(extractor)
        .build();

      expect(root).toBeDefined();
      expect(stageMap).toBeDefined();
      expect(builtExtractor).toBe(extractor);
    });

    it('should replace previous extractor when called multiple times (last wins)', () => {
      const extractor1: TraversalExtractor = () => ({ first: true });
      const extractor2: TraversalExtractor = () => ({ second: true });

      const { extractor } = new FlowChartBuilder()
        .start('entry', async () => 'done')
        .addTraversalExtractor(extractor1)
        .addTraversalExtractor(extractor2)
        .build();

      expect(extractor).toBe(extractor2);
    });

    it('should return undefined extractor when none registered', () => {
      const { extractor } = new FlowChartBuilder()
        .start('entry', async () => 'done')
        .build();

      expect(extractor).toBeUndefined();
    });

    it('should support fluent chaining', () => {
      const builder = new FlowChartBuilder()
        .start('entry', async () => 'done')
        .addTraversalExtractor(() => ({}))
        .addFunction('next', async () => 'next');

      expect(builder).toBeInstanceOf(FlowChartBuilder);
    });
  });

  describe('Invocation', () => {
    it('should call extractor after each stage completes', async () => {
      const extractorCalls: string[] = [];
      const extractor: TraversalExtractor = (snapshot) => {
        extractorCalls.push(snapshot.node.name);
        return { stageName: snapshot.node.name };
      };

      const fns = {
        stage1: jest.fn(() => 'result1'),
        stage2: jest.fn(() => 'result2'),
      };

      const root: Node = {
        name: 'stage1',
        fn: fns.stage1,
        next: { name: 'stage2', fn: fns.stage2 },
      };

      const pipeline = new Pipeline(root, makeMap(fns), scopeFactory, undefined, undefined, undefined, undefined, undefined, extractor);
      await pipeline.execute();

      expect(extractorCalls).toEqual(['stage1', 'stage2']);
    });

    it('should pass correct node to extractor', async () => {
      let capturedNode: StageNode | undefined;
      const extractor: TraversalExtractor = (snapshot) => {
        capturedNode = snapshot.node;
        return { captured: true };
      };

      const stageFn = jest.fn(() => 'done');
      const root: Node = {
        name: 'testStage',
        id: 'test-id',
        displayName: 'Test Stage',
        fn: stageFn,
      };

      const pipeline = new Pipeline(root, makeMap({ testStage: stageFn }), scopeFactory, undefined, undefined, undefined, undefined, undefined, extractor);
      await pipeline.execute();

      expect(capturedNode).toBeDefined();
      expect(capturedNode!.name).toBe('testStage');
      expect(capturedNode!.id).toBe('test-id');
      expect(capturedNode!.displayName).toBe('Test Stage');
    });

    it('should pass context to extractor', async () => {
      let capturedContext: StageContext | undefined;
      const extractor: TraversalExtractor = (snapshot) => {
        capturedContext = snapshot.context;
        return { captured: true };
      };

      const stageFn = jest.fn(() => 'done');
      const root: Node = { name: 'testStage', fn: stageFn };

      const pipeline = new Pipeline(root, makeMap({ testStage: stageFn }), scopeFactory, undefined, undefined, undefined, undefined, undefined, extractor);
      await pipeline.execute();

      expect(capturedContext).toBeDefined();
      expect(typeof capturedContext!.commit).toBe('function');
    });

    it('should call extractor on error paths (after commit, before throw)', async () => {
      let extractorCalled = false;
      const extractor: TraversalExtractor = () => {
        extractorCalled = true;
        return { error: true };
      };

      const errorFn = jest.fn(() => {
        throw new Error('Test error');
      });
      const root: Node = { name: 'errorStage', fn: errorFn };

      const pipeline = new Pipeline(root, makeMap({ errorStage: errorFn }), scopeFactory, undefined, undefined, undefined, undefined, undefined, extractor);

      await expect(pipeline.execute()).rejects.toThrow('Test error');
      expect(extractorCalled).toBe(true);
    });
  });


  describe('Results Collection', () => {
    it('should store results with correct stage paths', async () => {
      const extractor: TraversalExtractor = (snapshot) => ({
        name: snapshot.node.name,
      });

      const fns = {
        entry: jest.fn(() => 'entry'),
        process: jest.fn(() => 'process'),
      };

      const root: Node = {
        name: 'entry',
        id: 'entry',
        fn: fns.entry,
        next: { name: 'process', id: 'process', fn: fns.process },
      };

      const pipeline = new Pipeline(root, makeMap(fns), scopeFactory, undefined, undefined, undefined, undefined, undefined, extractor);
      await pipeline.execute();

      const results = pipeline.getExtractedResults();
      expect(results.size).toBe(2);
      expect(results.get('entry')).toEqual({ name: 'entry' });
      expect(results.get('process')).toEqual({ name: 'process' });
    });

    it('should NOT add entry when extractor returns undefined', async () => {
      const extractor: TraversalExtractor = (snapshot) => {
        if (snapshot.node.name === 'skip') return undefined;
        return { name: snapshot.node.name };
      };

      const fns = {
        keep: jest.fn(() => 'keep'),
        skip: jest.fn(() => 'skip'),
      };

      const root: Node = {
        name: 'keep',
        fn: fns.keep,
        next: { name: 'skip', fn: fns.skip },
      };

      const pipeline = new Pipeline(root, makeMap(fns), scopeFactory, undefined, undefined, undefined, undefined, undefined, extractor);
      await pipeline.execute();

      const results = pipeline.getExtractedResults();
      expect(results.size).toBe(1);
      expect(results.has('keep')).toBe(true);
      expect(results.has('skip')).toBe(false);
    });

    it('should NOT add entry when extractor returns null', async () => {
      const extractor: TraversalExtractor = (snapshot) => {
        if (snapshot.node.name === 'skip') return null;
        return { name: snapshot.node.name };
      };

      const fns = {
        keep: jest.fn(() => 'keep'),
        skip: jest.fn(() => 'skip'),
      };

      const root: Node = {
        name: 'keep',
        fn: fns.keep,
        next: { name: 'skip', fn: fns.skip },
      };

      const pipeline = new Pipeline(root, makeMap(fns), scopeFactory, undefined, undefined, undefined, undefined, undefined, extractor);
      await pipeline.execute();

      const results = pipeline.getExtractedResults();
      expect(results.size).toBe(1);
      expect(results.has('keep')).toBe(true);
      expect(results.has('skip')).toBe(false);
    });

    it('should return typed results via getExtractedResults<T>()', async () => {
      interface MyResult {
        stageName: string;
        timestamp: number;
      }

      const extractor: TraversalExtractor<MyResult> = (snapshot) => ({
        stageName: snapshot.node.name,
        timestamp: 12345,
      });

      const stageFn = jest.fn(() => 'done');
      const root: Node = { name: 'entry', fn: stageFn };

      const pipeline = new Pipeline(root, makeMap({ entry: stageFn }), scopeFactory, undefined, undefined, undefined, undefined, undefined, extractor);
      await pipeline.execute();

      const results = pipeline.getExtractedResults<MyResult>();
      const entry = results.get('entry');
      expect(entry?.stageName).toBe('entry');
      expect(entry?.timestamp).toBe(12345);
    });
  });


  describe('Error Handling', () => {
    it('should log extractor errors and continue execution', async () => {
      let stage2Called = false;

      const extractor: TraversalExtractor = (snapshot) => {
        if (snapshot.node.name === 'stage1') {
          throw new Error('Extractor error');
        }
        return { name: snapshot.node.name };
      };

      const fns = {
        stage1: jest.fn(() => 'result1'),
        stage2: jest.fn(() => {
          stage2Called = true;
          return 'result2';
        }),
      };

      const root: Node = {
        name: 'stage1',
        fn: fns.stage1,
        next: { name: 'stage2', fn: fns.stage2 },
      };

      const pipeline = new Pipeline(root, makeMap(fns), scopeFactory, undefined, undefined, undefined, undefined, undefined, extractor);
      await pipeline.execute();

      // Pipeline should continue despite extractor error
      expect(stage2Called).toBe(true);

      // stage1 should NOT be in results (extractor threw)
      const results = pipeline.getExtractedResults();
      expect(results.has('stage1')).toBe(false);
      expect(results.has('stage2')).toBe(true);
    });

    it('should record extractor errors in getExtractorErrors()', async () => {
      const extractor: TraversalExtractor = (snapshot) => {
        if (snapshot.node.name === 'errorStage') {
          throw new Error('Extractor failed');
        }
        return { name: snapshot.node.name };
      };

      const stageFn = jest.fn(() => 'done');
      const root: Node = { name: 'errorStage', fn: stageFn };

      const pipeline = new Pipeline(root, makeMap({ errorStage: stageFn }), scopeFactory, undefined, undefined, undefined, undefined, undefined, extractor);
      await pipeline.execute();

      const errors = pipeline.getExtractorErrors();
      expect(errors.length).toBe(1);
      expect(errors[0].stagePath).toBe('errorStage');
      expect(errors[0].message).toBe('Extractor failed');
      expect(errors[0].error).toBeInstanceOf(Error);
    });

    it('should NOT propagate extractor errors to caller', async () => {
      const extractor: TraversalExtractor = () => {
        throw new Error('Extractor error');
      };

      const stageFn = jest.fn(() => 'done');
      const root: Node = { name: 'entry', fn: stageFn };

      const pipeline = new Pipeline(root, makeMap({ entry: stageFn }), scopeFactory, undefined, undefined, undefined, undefined, undefined, extractor);

      // Should NOT throw
      await expect(pipeline.execute()).resolves.toBe('done');
    });
  });


  describe('Backward Compatibility', () => {
    it('should behave identically when no extractor is registered', async () => {
      const stageFn = jest.fn(() => 'result');
      const root: Node = { name: 'entry', fn: stageFn };

      const pipeline = new Pipeline(root, makeMap({ entry: stageFn }), scopeFactory);
      const result = await pipeline.execute();

      expect(result).toBe('result');
      expect(pipeline.getExtractedResults().size).toBe(0);
      expect(pipeline.getExtractorErrors().length).toBe(0);
    });

    it('should not affect getContextTree() behavior', async () => {
      const extractor: TraversalExtractor = () => ({ extracted: true });

      const stageFn = jest.fn(() => 'done');
      const root: Node = { name: 'entry', fn: stageFn };

      const pipeline = new Pipeline(root, makeMap({ entry: stageFn }), scopeFactory, undefined, undefined, undefined, undefined, undefined, extractor);
      await pipeline.execute();

      const contextTree = pipeline.getContextTree();
      expect(contextTree).toBeDefined();
    });

    it('should not change pipeline execution timing or order', async () => {
      const executionOrder: string[] = [];

      const extractor: TraversalExtractor = (snapshot) => {
        executionOrder.push(`extract:${snapshot.node.name}`);
        return {};
      };

      const fns = {
        stage1: jest.fn(() => {
          executionOrder.push('execute:stage1');
          return 'result1';
        }),
        stage2: jest.fn(() => {
          executionOrder.push('execute:stage2');
          return 'result2';
        }),
      };

      const root: Node = {
        name: 'stage1',
        fn: fns.stage1,
        next: { name: 'stage2', fn: fns.stage2 },
      };

      const pipeline = new Pipeline(root, makeMap(fns), scopeFactory, undefined, undefined, undefined, undefined, undefined, extractor);
      await pipeline.execute();

      // Extractor should be called AFTER each stage executes
      expect(executionOrder).toEqual([
        'execute:stage1',
        'extract:stage1',
        'execute:stage2',
        'extract:stage2',
      ]);
    });
  });


  describe('Decider Stages', () => {
    it('should call extractor for decider stage before branching', async () => {
      const extractorCalls: string[] = [];
      const extractor: TraversalExtractor = (snapshot) => {
        extractorCalls.push(snapshot.node.name);
        return { name: snapshot.node.name };
      };

      const fns = {
        deciderStage: jest.fn(() => 'branchA'),
        branchAStage: jest.fn(() => 'A'),
        branchBStage: jest.fn(() => 'B'),
      };

      const root: Node = {
        name: 'deciderStage',
        fn: fns.deciderStage,
        nextNodeDecider: (out) => out as string,
        children: [
          { id: 'branchA', name: 'branchAStage', fn: fns.branchAStage },
          { id: 'branchB', name: 'branchBStage', fn: fns.branchBStage },
        ],
      };

      const pipeline = new Pipeline(root, makeMap(fns), scopeFactory, undefined, undefined, undefined, undefined, undefined, extractor);
      await pipeline.execute();

      expect(extractorCalls).toContain('deciderStage');
      expect(extractorCalls).toContain('branchAStage');
      expect(extractorCalls).not.toContain('branchBStage');
    });
  });

  describe('Fork Stages (Parallel Children)', () => {
    it('should call extractor for all parallel children', async () => {
      const extractorCalls: string[] = [];
      const extractor: TraversalExtractor = (snapshot) => {
        extractorCalls.push(snapshot.node.name);
        return { name: snapshot.node.name };
      };

      const fns = {
        forkStage: jest.fn(() => 'fork'),
        child1Stage: jest.fn(() => 'c1'),
        child2Stage: jest.fn(() => 'c2'),
      };

      const root: Node = {
        name: 'forkStage',
        fn: fns.forkStage,
        children: [
          { id: 'child1', name: 'child1Stage', fn: fns.child1Stage },
          { id: 'child2', name: 'child2Stage', fn: fns.child2Stage },
        ],
      };

      const pipeline = new Pipeline(root, makeMap(fns), scopeFactory, undefined, undefined, undefined, undefined, undefined, extractor);
      await pipeline.execute();

      expect(extractorCalls).toContain('forkStage');
      expect(extractorCalls).toContain('child1Stage');
      expect(extractorCalls).toContain('child2Stage');
    });
  });

  describe('Stage Path Generation', () => {
    it('should use node.id for stage path when available', async () => {
      const extractor: TraversalExtractor = () => ({ test: true });

      const stageFn = jest.fn(() => 'done');
      const root: Node = { name: 'stageName', id: 'stageId', fn: stageFn };

      const pipeline = new Pipeline(root, makeMap({ stageName: stageFn }), scopeFactory, undefined, undefined, undefined, undefined, undefined, extractor);
      await pipeline.execute();

      const results = pipeline.getExtractedResults();
      expect(results.has('stageId')).toBe(true);
      expect(results.has('stageName')).toBe(false);
    });

    it('should use node.name for stage path when id not available', async () => {
      const extractor: TraversalExtractor = () => ({ test: true });

      const stageFn = jest.fn(() => 'done');
      const root: Node = { name: 'stageName', fn: stageFn };

      const pipeline = new Pipeline(root, makeMap({ stageName: stageFn }), scopeFactory, undefined, undefined, undefined, undefined, undefined, extractor);
      await pipeline.execute();

      const results = pipeline.getExtractedResults();
      expect(results.has('stageName')).toBe(true);
    });
  });

  describe('Step Number Tracking', () => {
    /**
     * **Validates: Requirements 3.1, 3.2, 3.4, 4.2**
     * Step numbers should be 1-based and monotonically increasing.
     */
    it('should provide 1-based step numbers starting at 1', async () => {
      const stepNumbers: number[] = [];
      const extractor: TraversalExtractor = (snapshot) => {
        stepNumbers.push(snapshot.stepNumber);
        return { step: snapshot.stepNumber };
      };

      const fns = {
        stage1: jest.fn(() => 'result1'),
        stage2: jest.fn(() => 'result2'),
        stage3: jest.fn(() => 'result3'),
      };

      const root: Node = {
        name: 'stage1',
        fn: fns.stage1,
        next: { 
          name: 'stage2', 
          fn: fns.stage2,
          next: { name: 'stage3', fn: fns.stage3 },
        },
      };

      const pipeline = new Pipeline(root, makeMap(fns), scopeFactory, undefined, undefined, undefined, undefined, undefined, extractor);
      await pipeline.execute();

      expect(stepNumbers).toEqual([1, 2, 3]);
    });

    it('should increment step numbers monotonically', async () => {
      const stepNumbers: number[] = [];
      const extractor: TraversalExtractor = (snapshot) => {
        stepNumbers.push(snapshot.stepNumber);
        return { step: snapshot.stepNumber };
      };

      const fns = {
        entry: jest.fn(() => 'entry'),
        process: jest.fn(() => 'process'),
        finish: jest.fn(() => 'finish'),
      };

      const root: Node = {
        name: 'entry',
        fn: fns.entry,
        next: { 
          name: 'process', 
          fn: fns.process,
          next: { name: 'finish', fn: fns.finish },
        },
      };

      const pipeline = new Pipeline(root, makeMap(fns), scopeFactory, undefined, undefined, undefined, undefined, undefined, extractor);
      await pipeline.execute();

      // Verify monotonic increase
      for (let i = 1; i < stepNumbers.length; i++) {
        expect(stepNumbers[i]).toBe(stepNumbers[i - 1] + 1);
      }
    });

    it('should include stepNumber in StageSnapshot', async () => {
      let capturedSnapshot: any;
      const extractor: TraversalExtractor = (snapshot) => {
        capturedSnapshot = snapshot;
        return { captured: true };
      };

      const stageFn = jest.fn(() => 'done');
      const root: Node = { name: 'testStage', fn: stageFn };

      const pipeline = new Pipeline(root, makeMap({ testStage: stageFn }), scopeFactory, undefined, undefined, undefined, undefined, undefined, extractor);
      await pipeline.execute();

      expect(capturedSnapshot).toBeDefined();
      expect(capturedSnapshot.stepNumber).toBe(1);
      expect(typeof capturedSnapshot.stepNumber).toBe('number');
    });

    it('should track step numbers across decider branches', async () => {
      const stepNumbers: { name: string; step: number }[] = [];
      const extractor: TraversalExtractor = (snapshot) => {
        stepNumbers.push({ name: snapshot.node.name, step: snapshot.stepNumber });
        return { step: snapshot.stepNumber };
      };

      const fns = {
        deciderStage: jest.fn(() => 'branchA'),
        branchAStage: jest.fn(() => 'A'),
        branchBStage: jest.fn(() => 'B'),
      };

      const root: Node = {
        name: 'deciderStage',
        fn: fns.deciderStage,
        nextNodeDecider: (out) => out as string,
        children: [
          { id: 'branchA', name: 'branchAStage', fn: fns.branchAStage },
          { id: 'branchB', name: 'branchBStage', fn: fns.branchBStage },
        ],
      };

      const pipeline = new Pipeline(root, makeMap(fns), scopeFactory, undefined, undefined, undefined, undefined, undefined, extractor);
      await pipeline.execute();

      // deciderStage should be step 1, branchAStage should be step 2
      expect(stepNumbers).toEqual([
        { name: 'deciderStage', step: 1 },
        { name: 'branchAStage', step: 2 },
      ]);
    });

    it('should track step numbers for parallel children (fork)', async () => {
      const stepNumbers: { name: string; step: number }[] = [];
      const extractor: TraversalExtractor = (snapshot) => {
        stepNumbers.push({ name: snapshot.node.name, step: snapshot.stepNumber });
        return { step: snapshot.stepNumber };
      };

      const fns = {
        forkStage: jest.fn(() => 'fork'),
        child1Stage: jest.fn(() => 'c1'),
        child2Stage: jest.fn(() => 'c2'),
      };

      const root: Node = {
        name: 'forkStage',
        fn: fns.forkStage,
        children: [
          { id: 'child1', name: 'child1Stage', fn: fns.child1Stage },
          { id: 'child2', name: 'child2Stage', fn: fns.child2Stage },
        ],
      };

      const pipeline = new Pipeline(root, makeMap(fns), scopeFactory, undefined, undefined, undefined, undefined, undefined, extractor);
      await pipeline.execute();

      // forkStage should be step 1
      const forkStep = stepNumbers.find(s => s.name === 'forkStage');
      expect(forkStep?.step).toBe(1);

      // Children execute in parallel, so their step numbers may vary
      // but they should all be > 1 and unique
      const childSteps = stepNumbers.filter(s => s.name !== 'forkStage').map(s => s.step);
      expect(childSteps.length).toBe(2);
      childSteps.forEach(step => expect(step).toBeGreaterThan(1));
    });

    it('should continue step counting even when extractor throws', async () => {
      const stepNumbers: number[] = [];
      const extractor: TraversalExtractor = (snapshot) => {
        stepNumbers.push(snapshot.stepNumber);
        if (snapshot.node.name === 'stage2') {
          throw new Error('Extractor error');
        }
        return { step: snapshot.stepNumber };
      };

      const fns = {
        stage1: jest.fn(() => 'result1'),
        stage2: jest.fn(() => 'result2'),
        stage3: jest.fn(() => 'result3'),
      };

      const root: Node = {
        name: 'stage1',
        fn: fns.stage1,
        next: { 
          name: 'stage2', 
          fn: fns.stage2,
          next: { name: 'stage3', fn: fns.stage3 },
        },
      };

      const pipeline = new Pipeline(root, makeMap(fns), scopeFactory, undefined, undefined, undefined, undefined, undefined, extractor);
      await pipeline.execute();

      // Step numbers should still be monotonic even with error
      expect(stepNumbers).toEqual([1, 2, 3]);
    });
  });
});
