import { ExtractorRunner } from '../../../../src/lib/engine/handlers/ExtractorRunner';
import type { ILogger } from '../../../../src/lib/engine/types';

const mockLogger: ILogger = {
  info: jest.fn(),
  log: jest.fn(),
  debug: jest.fn(),
  error: jest.fn(),
  warn: jest.fn(),
};

function makeContext(): any {
  return {
    debug: {
      logContext: {},
      errorContext: {},
      metricContext: {},
      evalContext: {},
      flowMessages: [],
    },
    stageName: 'test',
  };
}

describe('ExtractorRunner', () => {
  it('does nothing when no extractor provided', () => {
    const runner = new ExtractorRunner(undefined, false, { globalStore: { getState: () => ({}) } }, mockLogger);
    runner.callExtractor({ name: 'test' } as any, makeContext(), 'test');
    expect(runner.getExtractedResults().size).toBe(0);
  });

  it('calls extractor and stores result', () => {
    const extractor = jest.fn().mockReturnValue({ data: 42 });
    const runner = new ExtractorRunner(extractor, false, { globalStore: { getState: () => ({}) } }, mockLogger);

    runner.callExtractor({ name: 'test' } as any, makeContext(), 'root.test');

    expect(extractor).toHaveBeenCalledTimes(1);
    expect(runner.getExtractedResults().get('root.test')).toEqual({ data: 42 });
  });

  it('increments step counter (1-based)', () => {
    const extractor = jest.fn().mockReturnValue(null);
    const runner = new ExtractorRunner(extractor, false, { globalStore: { getState: () => ({}) } }, mockLogger);

    runner.callExtractor({ name: 'a' } as any, makeContext(), 'a');
    runner.callExtractor({ name: 'b' } as any, makeContext(), 'b');

    expect(extractor.mock.calls[0][0].stepNumber).toBe(1);
    expect(extractor.mock.calls[1][0].stepNumber).toBe(2);
  });

  it('enriches snapshots when enrichSnapshots is true', () => {
    const extractor = jest.fn().mockReturnValue(null);
    const runtime = {
      globalStore: { getState: () => ({ key: 'value' }) },
      executionHistory: { list: () => [1, 2, 3] },
    };
    const runner = new ExtractorRunner(extractor, true, runtime, mockLogger);

    runner.callExtractor({ name: 'test' } as any, makeContext(), 'test', 'output-value');

    const snapshot = extractor.mock.calls[0][0];
    expect(snapshot.scopeState).toEqual({ key: 'value' });
    expect(snapshot.stageOutput).toBe('output-value');
    expect(snapshot.historyIndex).toBe(3);
  });

  it('includes errorInfo in enriched snapshots', () => {
    const extractor = jest.fn().mockReturnValue(null);
    const runtime = {
      globalStore: { getState: () => ({}) },
      executionHistory: { list: () => [] },
    };
    const runner = new ExtractorRunner(extractor, true, runtime, mockLogger);

    runner.callExtractor({ name: 'test' } as any, makeContext(), 'test', undefined, {
      type: 'stageError',
      message: 'boom',
    });

    const snapshot = extractor.mock.calls[0][0];
    expect(snapshot.errorInfo).toEqual({ type: 'stageError', message: 'boom' });
  });

  it('catches extractor errors and records them', () => {
    const extractor = jest.fn().mockImplementation(() => {
      throw new Error('extractor failed');
    });
    const runner = new ExtractorRunner(extractor, false, { globalStore: { getState: () => ({}) } }, mockLogger);

    // Should not throw
    runner.callExtractor({ name: 'test' } as any, makeContext(), 'test');

    expect(runner.getExtractorErrors()).toHaveLength(1);
    expect(runner.getExtractorErrors()[0].message).toBe('extractor failed');
    expect(runner.getExtractorErrors()[0].stagePath).toBe('test');
  });

  it('skips null/undefined results', () => {
    const extractor = jest.fn().mockReturnValueOnce(null).mockReturnValueOnce(undefined).mockReturnValueOnce('valid');
    const runner = new ExtractorRunner(extractor, false, { globalStore: { getState: () => ({}) } }, mockLogger);

    runner.callExtractor({ name: 'a' } as any, makeContext(), 'a');
    runner.callExtractor({ name: 'b' } as any, makeContext(), 'b');
    runner.callExtractor({ name: 'c' } as any, makeContext(), 'c');

    expect(runner.getExtractedResults().size).toBe(1);
    expect(runner.getExtractedResults().get('c')).toBe('valid');
  });

  it('includes flowMessages in debugInfo when non-empty', () => {
    const extractor = jest.fn().mockReturnValue(null);
    const runtime = {
      globalStore: { getState: () => ({}) },
      executionHistory: { list: () => [] },
    };
    const runner = new ExtractorRunner(extractor, true, runtime, mockLogger);

    const ctx = makeContext();
    ctx.debug.flowMessages = [
      { role: 'user', content: 'hello' },
      { role: 'assistant', content: 'hi' },
    ];

    runner.callExtractor({ name: 'chat' } as any, ctx, 'chat');

    const snapshot = extractor.mock.calls[0][0];
    expect(snapshot.debugInfo.flowMessages).toEqual([
      { role: 'user', content: 'hello' },
      { role: 'assistant', content: 'hi' },
    ]);
  });

  it('handles enrichment errors gracefully', () => {
    const extractor = jest.fn().mockReturnValue('ok');
    const runtime = {
      globalStore: {
        getState: () => {
          throw new Error('store broken');
        },
      },
      executionHistory: { list: () => [] },
    };
    const logger: ILogger = {
      info: jest.fn(),
      log: jest.fn(),
      debug: jest.fn(),
      error: jest.fn(),
      warn: jest.fn(),
    };
    const runner = new ExtractorRunner(extractor, true, runtime, logger);

    runner.callExtractor({ name: 'test' } as any, makeContext(), 'test');

    // Enrichment failed but extractor still called
    expect(extractor).toHaveBeenCalledTimes(1);
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining("Enrichment error at stage 'test'"),
      expect.objectContaining({ error: expect.any(Error) }),
    );
    // Result still stored
    expect(runner.getExtractedResults().get('test')).toBe('ok');
  });

  it('records extractor error for non-Error thrown values', () => {
    const extractor = jest.fn().mockImplementation(() => {
      throw 'string-error'; // eslint-disable-line no-throw-literal
    });
    const logger: ILogger = {
      info: jest.fn(),
      log: jest.fn(),
      debug: jest.fn(),
      error: jest.fn(),
      warn: jest.fn(),
    };
    const runner = new ExtractorRunner(extractor, false, { globalStore: { getState: () => ({}) } }, logger);

    runner.callExtractor({ name: 'x' } as any, makeContext(), 'x');

    expect(runner.getExtractorErrors()).toHaveLength(1);
    expect(runner.getExtractorErrors()[0].message).toBe('string-error');
    expect(runner.getExtractorErrors()[0].error).toBe('string-error');
    expect(logger.error).toHaveBeenCalled();
  });

  describe('buildStructureMetadata', () => {
    const runtime = { globalStore: { getState: () => ({}) } };

    it('marks subflow root with subflowId and subflowName', () => {
      const extractor = jest.fn().mockReturnValue(null);
      const runner = new ExtractorRunner(extractor, false, runtime, mockLogger);

      runner.callExtractor(
        { name: 'sub', isSubflowRoot: true, subflowId: 'sf-1', subflowName: 'MySubflow' } as any,
        makeContext(),
        'sub',
      );

      const metadata = extractor.mock.calls[0][0].structureMetadata;
      expect(metadata.isSubflowRoot).toBe(true);
      expect(metadata.subflowId).toBe('sf-1');
      expect(metadata.subflowName).toBe('MySubflow');
    });

    it('propagates currentSubflowId for non-root nodes', () => {
      const extractor = jest.fn().mockReturnValue(null);
      const runner = new ExtractorRunner(extractor, false, runtime, mockLogger);
      runner.currentSubflowId = 'sf-2';

      runner.callExtractor({ name: 'child' } as any, makeContext(), 'child');

      const metadata = extractor.mock.calls[0][0].structureMetadata;
      expect(metadata.subflowId).toBe('sf-2');
      expect(metadata.isSubflowRoot).toBeUndefined();
    });

    it('marks parallel child with currentForkId', () => {
      const extractor = jest.fn().mockReturnValue(null);
      const runner = new ExtractorRunner(extractor, false, runtime, mockLogger);
      runner.currentForkId = 'fork-1';

      runner.callExtractor({ name: 'branch' } as any, makeContext(), 'branch');

      const metadata = extractor.mock.calls[0][0].structureMetadata;
      expect(metadata.isParallelChild).toBe(true);
      expect(metadata.parallelGroupId).toBe('fork-1');
    });

    it('includes streamId for streaming nodes', () => {
      const extractor = jest.fn().mockReturnValue(null);
      const runner = new ExtractorRunner(extractor, false, runtime, mockLogger);

      runner.callExtractor(
        { name: 'stream', isStreaming: true, streamId: 'stream-abc' } as any,
        makeContext(),
        'stream',
      );

      const metadata = extractor.mock.calls[0][0].structureMetadata;
      expect(metadata.type).toBe('streaming');
      expect(metadata.streamId).toBe('stream-abc');
    });

    it('marks isDynamic for nodes with children, fn, and no nextNodeSelector', () => {
      const extractor = jest.fn().mockReturnValue(null);
      const runner = new ExtractorRunner(extractor, false, runtime, mockLogger);

      const dynamicNode = {
        name: 'dynamic',
        children: [{ name: 'c1' }],
        fn: jest.fn(),
        // no nextNodeSelector
      };

      runner.callExtractor(dynamicNode as any, makeContext(), 'dynamic');

      const metadata = extractor.mock.calls[0][0].structureMetadata;
      expect(metadata.isDynamic).toBe(true);
    });

    it('does not mark isDynamic when nextNodeSelector is present', () => {
      const extractor = jest.fn().mockReturnValue(null);
      const runner = new ExtractorRunner(extractor, false, runtime, mockLogger);

      const deciderNode = {
        name: 'decider',
        children: [{ name: 'c1' }],
        fn: jest.fn(),
        nextNodeSelector: jest.fn(),
      };

      runner.callExtractor(deciderNode as any, makeContext(), 'decider');

      const metadata = extractor.mock.calls[0][0].structureMetadata;
      expect(metadata.isDynamic).toBeUndefined();
      expect(metadata.type).toBe('decider');
    });
  });

  describe('getStagePath', () => {
    const runner = new ExtractorRunner(undefined, false, { globalStore: { getState: () => ({}) } }, mockLogger);

    it('returns node id when no branchPath', () => {
      expect(runner.getStagePath({ name: 'test', id: 'test-id' } as any)).toBe('test-id');
    });

    it('falls back to node name when no id', () => {
      expect(runner.getStagePath({ name: 'test' } as any)).toBe('test');
    });

    it('combines branchPath with node id', () => {
      expect(runner.getStagePath({ name: 'test', id: 'tid' } as any, 'root.branch')).toBe('root.branch.tid');
    });

    it('uses contextStageName when different from node name', () => {
      expect(runner.getStagePath({ name: 'askLLM', id: 'askLLM' } as any, 'root', 'askLLM.2')).toBe('root.askLLM.2');
    });

    it('uses baseName when contextStageName matches node name', () => {
      expect(runner.getStagePath({ name: 'stage1', id: 'stage1' } as any, 'root', 'stage1')).toBe('root.stage1');
    });

    it('returns baseName without branchPath when contextStageName matches node name', () => {
      expect(runner.getStagePath({ name: 'stage1' } as any, undefined, 'stage1')).toBe('stage1');
    });
  });
});
