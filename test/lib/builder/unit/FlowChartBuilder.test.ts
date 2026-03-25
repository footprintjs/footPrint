import { vi } from 'vitest';

import { flowChart, FlowChartBuilder, specToStageNode } from '../../../../src/lib/builder';

const noop = async () => {};

describe('FlowChartBuilder', () => {
  describe('start', () => {
    it('creates root node with name', () => {
      const chart = new FlowChartBuilder().start('root', noop, 'root').build();
      expect(chart.root.name).toBe('root');
    });

    it('sets id and description on root', () => {
      const chart = new FlowChartBuilder().start('Root Stage', noop, 'root-id', 'initialises the flow').build();
      expect(chart.root.id).toBe('root-id');
      expect(chart.root.name).toBe('Root Stage');
      expect(chart.root.description).toBe('initialises the flow');
    });

    it('registers fn in stageMap', () => {
      const fn = async () => {};
      const chart = new FlowChartBuilder().start('root', fn, 'root').build();
      expect(chart.stageMap.get('root')).toBe(fn);
    });

    it('throws if start called twice', () => {
      expect(() => {
        new FlowChartBuilder().start('a', noop, 'a').start('b', noop, 'b');
      }).toThrow('root already defined');
    });

    it('fn is registered when provided', () => {
      const fn = async () => {};
      const chart = new FlowChartBuilder().start('root', fn, 'root').build();
      expect(chart.root.name).toBe('root');
      expect(chart.stageMap.size).toBe(1);
      expect(chart.stageMap.get('root')).toBe(fn);
    });
  });

  describe('addFunction', () => {
    it('chains a next node', () => {
      const chart = flowChart('a', noop, 'a').addFunction('b', noop, 'b').build();
      expect(chart.root.next?.name).toBe('b');
    });

    it('chains multiple nodes', () => {
      const chart = flowChart('a', noop, 'a').addFunction('b', noop, 'b').addFunction('c', noop, 'c').build();
      expect(chart.root.next?.next?.name).toBe('c');
    });

    it('registers all fns in stageMap', () => {
      const fn1 = async () => {};
      const fn2 = async () => {};
      const chart = flowChart('a', fn1, 'a').addFunction('b', fn2, 'b').build();
      expect(chart.stageMap.get('a')).toBe(fn1);
      expect(chart.stageMap.get('b')).toBe(fn2);
    });

    it('throws if cursor not initialised', () => {
      expect(() => {
        new FlowChartBuilder().addFunction('b', noop, 'b');
      }).toThrow('cursor undefined');
    });
  });

  describe('addStreamingFunction', () => {
    it('creates streaming node with streamId', () => {
      const chart = flowChart('a', noop, 'a').addStreamingFunction('stream', noop, 'stream', 'my-stream').build();
      const node = chart.root.next!;
      expect(node.isStreaming).toBe(true);
      expect(node.streamId).toBe('my-stream');
    });

    it('defaults streamId to name', () => {
      const chart = flowChart('a', noop, 'a').addStreamingFunction('stream', noop, 'stream').build();
      expect(chart.root.next!.streamId).toBe('stream');
    });
  });

  describe('stageMap collision', () => {
    it('throws on conflicting fn for same name', () => {
      expect(() => {
        flowChart('a', async () => 1, 'a')
          .addFunction('a', async () => 2, 'a')
          .build();
      }).toThrow('stageMap collision');
    });

    it('allows same fn reference for same name', () => {
      const fn = async () => {};
      expect(() => {
        flowChart('a', fn, 'a').addFunction('a', fn, 'a').build();
      }).not.toThrow();
    });
  });

  describe('build', () => {
    it('throws if start not called', () => {
      expect(() => new FlowChartBuilder().build()).toThrow('empty tree');
    });

    it('returns buildTimeStructure as rootSpec', () => {
      const chart = flowChart('a', noop, 'a').addFunction('b', noop, 'b').build();
      expect(chart.buildTimeStructure.name).toBe('a');
      expect(chart.buildTimeStructure.next?.name).toBe('b');
    });

    it('builds description from stage names', () => {
      const chart = flowChart('Entry', noop, 'entry').addFunction('Process', noop, 'process').build();
      expect(chart.description).toContain('Entry');
      expect(chart.description).toContain('Process');
    });

    it('includes descriptions in description string', () => {
      const chart = flowChart('entry', noop, 'entry', undefined, 'start here')
        .addFunction('end', noop, 'end', 'finish here')
        .build();
      expect(chart.description).toContain('start here');
      expect(chart.description).toContain('finish here');
    });
  });

  describe('toSpec', () => {
    it('returns SerializedPipelineStructure', () => {
      const spec = flowChart('a', noop, 'a').addFunction('b', noop, 'b').toSpec();
      expect(spec.name).toBe('a');
      expect(spec.type).toBe('stage');
      expect(spec.next?.name).toBe('b');
    });
  });

  describe('toMermaid', () => {
    it('generates mermaid diagram', () => {
      const mermaid = flowChart('a', noop, 'a').addFunction('b', noop, 'b').toMermaid();
      expect(mermaid).toContain('flowchart TD');
      expect(mermaid).toContain('a["a"]');
      expect(mermaid).toContain('a --> b');
    });
  });

  describe('setLogger', () => {
    it('passes logger to FlowChart', () => {
      const mockLogger = { info: vi.fn(), log: vi.fn(), debug: vi.fn(), error: vi.fn(), warn: vi.fn() };
      const chart = flowChart('a', noop, 'a').setLogger(mockLogger).build();
      expect(chart.logger).toBe(mockLogger);
    });
  });

  describe('loopTo', () => {
    it('sets next to loop target', () => {
      const chart = flowChart('a', noop, 'a').addFunction('b', noop, 'b').loopTo('a').build();
      expect(chart.root.next!.next?.name).toBe('a');
    });

    it('sets loopTarget on spec', () => {
      const spec = flowChart('a', noop, 'a').addFunction('b', noop, 'b').loopTo('a').toSpec();
      expect(spec.next!.loopTarget).toBe('a');
    });

    it('includes loop in description', () => {
      const chart = flowChart('a', noop, 'a').addFunction('b', noop, 'b').loopTo('a').build();
      expect(chart.description).toContain('loops back to step 1');
    });

    it('throws if loopTo set twice', () => {
      expect(() => {
        flowChart('a', noop, 'a').addFunction('b', noop, 'b').loopTo('a').loopTo('a');
      }).toThrow();
    });
  });

  describe('stream handlers', () => {
    it('registers onStream handler', () => {
      const handler = vi.fn();
      const builder = flowChart('a', noop, 'a').onStream(handler);
      expect(builder).toBeDefined(); // fluent returns this
    });

    it('registers onStreamStart handler', () => {
      const handler = vi.fn();
      const builder = flowChart('a', noop, 'a').onStreamStart(handler);
      expect(builder).toBeDefined();
    });

    it('registers onStreamEnd handler', () => {
      const handler = vi.fn();
      const builder = flowChart('a', noop, 'a').onStreamEnd(handler);
      expect(builder).toBeDefined();
    });
  });

  describe('extractors', () => {
    it('passes traversal extractor to FlowChart', () => {
      const ext = () => null;
      const chart = flowChart('a', noop, 'a').addTraversalExtractor(ext).build();
      expect(chart.extractor).toBe(ext);
    });

    it('build-time extractor transforms nodes', () => {
      const extractor = (node: any) => ({ ...node, custom: true });
      const chart = new FlowChartBuilder(extractor).start('a', noop, 'a').addFunction('b', noop, 'b').build();
      expect((chart.buildTimeStructure as any).custom).toBe(true);
      expect((chart.buildTimeStructure.next as any).custom).toBe(true);
    });

    it('records build-time extractor errors', () => {
      const extractor = () => {
        throw new Error('boom');
      };
      const builder = new FlowChartBuilder(extractor).start('a', noop, 'a');
      const errors = builder.getBuildTimeExtractorErrors();
      expect(errors).toHaveLength(1);
      expect(errors[0].message).toBe('boom');
    });
  });
});

describe('flowChart factory', () => {
  it('creates builder with start already called', () => {
    const chart = flowChart('entry', noop, 'entry').build();
    expect(chart.root.name).toBe('entry');
  });

  it('passes buildTimeExtractor', () => {
    const ext = (n: any) => ({ ...n, tagged: true });
    const chart = flowChart('a', noop, 'a', ext).build();
    expect((chart.buildTimeStructure as any).tagged).toBe(true);
  });
});

describe('specToStageNode', () => {
  it('converts spec to StageNode tree', () => {
    const spec = { name: 'a', children: [{ name: 'b', id: 'b' }], next: { name: 'c' } };
    const node = specToStageNode(spec);
    expect(node.name).toBe('a');
    expect(node.children![0].name).toBe('b');
    expect(node.next!.name).toBe('c');
  });

  it('handles spec with no children or next', () => {
    const node = specToStageNode({ name: 'solo' });
    expect(node.name).toBe('solo');
    expect(node.children).toBeUndefined();
    expect(node.next).toBeUndefined();
  });
});
