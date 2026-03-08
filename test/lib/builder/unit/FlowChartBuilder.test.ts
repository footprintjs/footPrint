import { flowChart, FlowChartBuilder, specToStageNode } from '../../../../src/lib/builder';

const noop = async () => {};

describe('FlowChartBuilder', () => {
  describe('start', () => {
    it('creates root node with name', () => {
      const chart = new FlowChartBuilder().start('root', noop).build();
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
      const chart = new FlowChartBuilder().start('root', fn).build();
      expect(chart.stageMap.get('root')).toBe(fn);
    });

    it('throws if start called twice', () => {
      expect(() => {
        new FlowChartBuilder().start('a', noop).start('b', noop);
      }).toThrow('root already defined');
    });

    it('works without fn', () => {
      const chart = new FlowChartBuilder().start('root').build();
      expect(chart.root.name).toBe('root');
      expect(chart.root.fn).toBeUndefined();
      expect(chart.stageMap.size).toBe(0);
    });
  });

  describe('addFunction', () => {
    it('chains a next node', () => {
      const chart = flowChart('a', noop).addFunction('b', noop).build();
      expect(chart.root.next?.name).toBe('b');
    });

    it('chains multiple nodes', () => {
      const chart = flowChart('a', noop).addFunction('b', noop).addFunction('c', noop).build();
      expect(chart.root.next?.next?.name).toBe('c');
    });

    it('registers all fns in stageMap', () => {
      const fn1 = async () => {};
      const fn2 = async () => {};
      const chart = flowChart('a', fn1).addFunction('b', fn2).build();
      expect(chart.stageMap.get('a')).toBe(fn1);
      expect(chart.stageMap.get('b')).toBe(fn2);
    });

    it('throws if cursor not initialised', () => {
      expect(() => {
        new FlowChartBuilder().addFunction('b', noop);
      }).toThrow('cursor undefined');
    });
  });

  describe('addStreamingFunction', () => {
    it('creates streaming node with streamId', () => {
      const chart = flowChart('a', noop).addStreamingFunction('stream', 'my-stream', noop).build();
      const node = chart.root.next!;
      expect(node.isStreaming).toBe(true);
      expect(node.streamId).toBe('my-stream');
    });

    it('defaults streamId to name', () => {
      const chart = flowChart('a', noop).addStreamingFunction('stream', undefined, noop).build();
      expect(chart.root.next!.streamId).toBe('stream');
    });
  });

  describe('stageMap collision', () => {
    it('throws on conflicting fn for same name', () => {
      expect(() => {
        flowChart('a', async () => 1)
          .addFunction('a', async () => 2)
          .build();
      }).toThrow('stageMap collision');
    });

    it('allows same fn reference for same name', () => {
      const fn = async () => {};
      expect(() => {
        flowChart('a', fn).addFunction('a', fn).build();
      }).not.toThrow();
    });
  });

  describe('build', () => {
    it('throws if start not called', () => {
      expect(() => new FlowChartBuilder().build()).toThrow('empty tree');
    });

    it('returns buildTimeStructure as rootSpec', () => {
      const chart = flowChart('a', noop).addFunction('b', noop).build();
      expect(chart.buildTimeStructure.name).toBe('a');
      expect(chart.buildTimeStructure.next?.name).toBe('b');
    });

    it('builds description from stage names', () => {
      const chart = flowChart('Entry', noop).addFunction('Process', noop).build();
      expect(chart.description).toContain('Entry');
      expect(chart.description).toContain('Process');
    });

    it('includes descriptions in description string', () => {
      const chart = flowChart('entry', noop, undefined, undefined, 'start here')
        .addFunction('end', noop, undefined, 'finish here')
        .build();
      expect(chart.description).toContain('start here');
      expect(chart.description).toContain('finish here');
    });
  });

  describe('toSpec', () => {
    it('returns SerializedPipelineStructure', () => {
      const spec = flowChart('a', noop).addFunction('b', noop).toSpec();
      expect(spec.name).toBe('a');
      expect(spec.type).toBe('stage');
      expect(spec.next?.name).toBe('b');
    });
  });

  describe('toMermaid', () => {
    it('generates mermaid diagram', () => {
      const mermaid = flowChart('a', noop).addFunction('b', noop).toMermaid();
      expect(mermaid).toContain('flowchart TD');
      expect(mermaid).toContain('a["a"]');
      expect(mermaid).toContain('a --> b');
    });
  });

  describe('setEnableNarrative', () => {
    it('sets enableNarrative on FlowChart', () => {
      const chart = flowChart('a', noop).setEnableNarrative().build();
      expect(chart.enableNarrative).toBe(true);
    });
  });

  describe('setLogger', () => {
    it('passes logger to FlowChart', () => {
      const mockLogger = { info: jest.fn(), log: jest.fn(), debug: jest.fn(), error: jest.fn(), warn: jest.fn() };
      const chart = flowChart('a', noop).setLogger(mockLogger).build();
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
      const handler = jest.fn();
      const builder = flowChart('a', noop).onStream(handler);
      expect(builder).toBeDefined(); // fluent returns this
    });

    it('registers onStreamStart handler', () => {
      const handler = jest.fn();
      const builder = flowChart('a', noop).onStreamStart(handler);
      expect(builder).toBeDefined();
    });

    it('registers onStreamEnd handler', () => {
      const handler = jest.fn();
      const builder = flowChart('a', noop).onStreamEnd(handler);
      expect(builder).toBeDefined();
    });
  });

  describe('extractors', () => {
    it('passes traversal extractor to FlowChart', () => {
      const ext = () => null;
      const chart = flowChart('a', noop).addTraversalExtractor(ext).build();
      expect(chart.extractor).toBe(ext);
    });

    it('build-time extractor transforms nodes', () => {
      const extractor = (node: any) => ({ ...node, custom: true });
      const chart = new FlowChartBuilder(extractor).start('a', noop).addFunction('b', noop).build();
      expect((chart.buildTimeStructure as any).custom).toBe(true);
      expect((chart.buildTimeStructure.next as any).custom).toBe(true);
    });

    it('records build-time extractor errors', () => {
      const extractor = () => {
        throw new Error('boom');
      };
      const builder = new FlowChartBuilder(extractor).start('a', noop);
      const errors = builder.getBuildTimeExtractorErrors();
      expect(errors).toHaveLength(1);
      expect(errors[0].message).toBe('boom');
    });
  });
});

describe('flowChart factory', () => {
  it('creates builder with start already called', () => {
    const chart = flowChart('entry', noop).build();
    expect(chart.root.name).toBe('entry');
  });

  it('passes buildTimeExtractor', () => {
    const ext = (n: any) => ({ ...n, tagged: true });
    const chart = flowChart('a', noop, undefined, ext).build();
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
