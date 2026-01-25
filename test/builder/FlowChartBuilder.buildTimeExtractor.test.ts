/**
 * FlowChartBuilder.buildTimeExtractor.test.ts
 *
 * Tests for the build-time extractor feature.
 * Validates that build-time extractors transform toSpec() output correctly.
 * 
 * **Validates: Requirements 1.1, 1.2, 1.3, 1.4, 1.5, 2.1-2.10, 8.1, 8.3**
 */

import { FlowChartBuilder, FlowChartSpec, BuildTimeNodeMetadata, BuildTimeExtractor } from '../../src/builder/FlowChartBuilder';

describe('FlowChartBuilder Build-Time Extractor', () => {
  describe('Registration', () => {
    /**
     * **Validates: Requirement 1.1**
     */
    it('should store extractor when addBuildTimeExtractor is called', () => {
      const extractor: BuildTimeExtractor = (metadata) => ({ ...metadata, custom: true });
      const builder = new FlowChartBuilder()
        .start('entry', async () => 'done')
        .addBuildTimeExtractor(extractor);

      // Verify extractor is used by checking toSpec output
      const spec = builder.toSpec<any>();
      expect(spec.custom).toBe(true);
    });

    it('should replace previous extractor when called multiple times (last wins)', () => {
      const extractor1: BuildTimeExtractor = (metadata) => ({ ...metadata, version: 1 });
      const extractor2: BuildTimeExtractor = (metadata) => ({ ...metadata, version: 2 });

      const spec = new FlowChartBuilder()
        .start('entry', async () => 'done')
        .addBuildTimeExtractor(extractor1)
        .addBuildTimeExtractor(extractor2)
        .toSpec<any>();

      expect(spec.version).toBe(2);
    });

    it('should support fluent chaining', () => {
      const builder = new FlowChartBuilder()
        .start('entry', async () => 'done')
        .addBuildTimeExtractor(() => ({ name: 'test' }))
        .addFunction('next', async () => 'next');

      expect(builder).toBeInstanceOf(FlowChartBuilder);
    });
  });

  describe('Backward Compatibility', () => {
    /**
     * **Validates: Requirement 1.4**
     */
    it('should return default FlowChartSpec when no extractor is registered', () => {
      const spec = new FlowChartBuilder()
        .start('entry', async () => 'done', 'entry-id')
        .addFunction('next', async () => 'next', 'next-id')
        .toSpec();

      expect(spec.name).toBe('entry');
      expect(spec.id).toBe('entry-id');
      expect(spec.next?.name).toBe('next');
      expect(spec.next?.id).toBe('next-id');
    });

    it('should not affect build() output', () => {
      const extractor: BuildTimeExtractor = (metadata) => ({ ...metadata, custom: true });
      const { root, stageMap } = new FlowChartBuilder()
        .start('entry', async () => 'done')
        .addBuildTimeExtractor(extractor)
        .build();

      expect(root.name).toBe('entry');
      expect(stageMap.has('entry')).toBe(true);
      // build() should not have custom property
      expect((root as any).custom).toBeUndefined();
    });
  });

  describe('Metadata Completeness', () => {
    /**
     * **Property 1: Build-time extractor receives complete metadata for all nodes**
     * **Validates: Requirements 1.2, 1.5, 2.1-2.10**
     */
    it('should pass all node properties to extractor', () => {
      let capturedMetadata: BuildTimeNodeMetadata | undefined;
      const extractor: BuildTimeExtractor = (metadata) => {
        capturedMetadata = metadata;
        return metadata;
      };

      new FlowChartBuilder()
        .start('entry', async () => 'done', 'entry-id', 'Entry Stage')
        .addBuildTimeExtractor(extractor)
        .toSpec();

      expect(capturedMetadata).toBeDefined();
      expect(capturedMetadata!.name).toBe('entry');
      expect(capturedMetadata!.id).toBe('entry-id');
      expect(capturedMetadata!.displayName).toBe('Entry Stage');
    });

    it('should include streaming properties in metadata', () => {
      let capturedMetadata: BuildTimeNodeMetadata | undefined;
      const extractor: BuildTimeExtractor = (metadata) => {
        // The streaming node is in metadata.next
        if (metadata.next?.isStreaming) capturedMetadata = metadata.next;
        return metadata;
      };

      new FlowChartBuilder()
        .start('entry', async () => 'done')
        .addStreamingFunction('streaming', 'stream-1', async () => 'done')
        .addBuildTimeExtractor(extractor)
        .toSpec();

      expect(capturedMetadata).toBeDefined();
      expect(capturedMetadata!.isStreaming).toBe(true);
      expect(capturedMetadata!.streamId).toBe('stream-1');
    });

    it('should include decider properties in metadata', () => {
      let capturedMetadata: BuildTimeNodeMetadata | undefined;
      const extractor: BuildTimeExtractor = (metadata) => {
        if (metadata.hasDecider) capturedMetadata = metadata;
        return metadata;
      };

      new FlowChartBuilder()
        .start('entry', async () => 'branchA')
        .addDecider((out) => out as string)
          .addFunctionBranch('branchA', 'branchAStage', async () => 'A')
          .addFunctionBranch('branchB', 'branchBStage', async () => 'B')
        .end()
        .addBuildTimeExtractor(extractor)
        .toSpec();

      expect(capturedMetadata).toBeDefined();
      expect(capturedMetadata!.hasDecider).toBe(true);
      expect(capturedMetadata!.branchIds).toEqual(['branchA', 'branchB']);
      expect(capturedMetadata!.children?.length).toBe(2);
    });

    it('should include selector properties in metadata', () => {
      let capturedMetadata: BuildTimeNodeMetadata | undefined;
      const extractor: BuildTimeExtractor = (metadata) => {
        if (metadata.hasSelector) capturedMetadata = metadata;
        return metadata;
      };

      new FlowChartBuilder()
        .start('entry', async () => ['branchA'])
        .addSelector((out) => out as string[])
          .addFunctionBranch('branchA', 'branchAStage', async () => 'A')
          .addFunctionBranch('branchB', 'branchBStage', async () => 'B')
        .end()
        .addBuildTimeExtractor(extractor)
        .toSpec();

      expect(capturedMetadata).toBeDefined();
      expect(capturedMetadata!.hasSelector).toBe(true);
      expect(capturedMetadata!.branchIds).toEqual(['branchA', 'branchB']);
    });

    it('should include parallel child metadata', () => {
      const capturedMetadata: BuildTimeNodeMetadata[] = [];
      const extractor: BuildTimeExtractor = (metadata) => {
        capturedMetadata.push(metadata);
        return metadata;
      };

      new FlowChartBuilder()
        .start('fork', async () => 'fork', 'fork-id')
        .addListOfFunction([
          { id: 'child1', name: 'child1Stage' },
          { id: 'child2', name: 'child2Stage' },
        ])
        .addBuildTimeExtractor(extractor)
        .toSpec();

      // Find children in captured metadata
      const forkNode = capturedMetadata.find(m => m.name === 'fork');
      expect(forkNode?.children?.length).toBe(2);
      
      const child1 = forkNode?.children?.find(c => c.name === 'child1Stage');
      expect(child1?.isParallelChild).toBe(true);
      expect(child1?.parallelGroupId).toBe('fork-id');
    });

    it('should include loop target in metadata', () => {
      let capturedMetadata: BuildTimeNodeMetadata | undefined;
      const extractor: BuildTimeExtractor = (metadata) => {
        // The loop target is on the 'process' node which is in metadata.next
        if (metadata.next?.loopTarget) capturedMetadata = metadata.next;
        return metadata;
      };

      new FlowChartBuilder()
        .start('entry', async () => 'done', 'entry-id')
        .addFunction('process', async () => 'done', 'process-id')
        .loopTo('entry-id')
        .addBuildTimeExtractor(extractor)
        .toSpec();

      expect(capturedMetadata).toBeDefined();
      expect(capturedMetadata!.loopTarget).toBe('entry-id');
      expect(capturedMetadata!.next?.id).toBe('entry-id');
    });
  });

  describe('Transformation', () => {
    /**
     * **Property 2: Build-time extractor transforms output correctly**
     * **Validates: Requirement 1.3**
     */
    it('should transform output to custom format', () => {
      interface CustomNode {
        name: string;
        type: 'stage' | 'decider' | 'fork' | 'streaming';
        children?: CustomNode[];
        next?: CustomNode;
      }

      const extractor: BuildTimeExtractor<CustomNode> = (metadata) => {
        let type: CustomNode['type'] = 'stage';
        if (metadata.hasDecider || metadata.hasSelector) type = 'decider';
        else if (metadata.children && metadata.children.length > 0) type = 'fork';
        else if (metadata.isStreaming) type = 'streaming';

        return {
          name: metadata.name,
          type,
          children: metadata.children?.map(c => extractor(c)),
          next: metadata.next ? extractor(metadata.next) : undefined,
        };
      };

      const spec = new FlowChartBuilder()
        .start('entry', async () => 'done')
        .addFunction('process', async () => 'done')
        .addBuildTimeExtractor(extractor)
        .toSpec<CustomNode>();

      expect(spec.name).toBe('entry');
      expect(spec.type).toBe('stage');
      expect(spec.next?.name).toBe('process');
      expect(spec.next?.type).toBe('stage');
    });

    it('should allow adding computed properties', () => {
      interface NodeWithType extends FlowChartSpec {
        type: 'stage' | 'decider' | 'fork' | 'streaming';
      }

      const extractor: BuildTimeExtractor<NodeWithType> = (metadata) => {
        let type: NodeWithType['type'] = 'stage';
        if (metadata.hasDecider || metadata.hasSelector) type = 'decider';
        else if (metadata.children && metadata.children.length > 0 && !metadata.hasDecider && !metadata.hasSelector) type = 'fork';
        else if (metadata.isStreaming) type = 'streaming';

        return {
          ...metadata,
          type,
          children: metadata.children?.map(c => extractor(c)),
          next: metadata.next ? extractor(metadata.next) : undefined,
        };
      };

      const spec = new FlowChartBuilder()
        .start('entry', async () => 'branchA')
        .addDecider((out) => out as string)
          .addFunctionBranch('branchA', 'branchAStage', async () => 'A')
        .end()
        .addBuildTimeExtractor(extractor)
        .toSpec<NodeWithType>();

      expect(spec.type).toBe('decider');
      expect(spec.children?.[0].type).toBe('stage');
    });

    it('should allow removing properties', () => {
      interface MinimalNode {
        name: string;
        children?: MinimalNode[];
        next?: MinimalNode;
      }

      const extractor: BuildTimeExtractor<MinimalNode> = (metadata) => ({
        name: metadata.name,
        children: metadata.children?.map(c => extractor(c)),
        next: metadata.next ? extractor(metadata.next) : undefined,
      });

      const spec = new FlowChartBuilder()
        .start('entry', async () => 'done', 'entry-id', 'Entry Stage')
        .addBuildTimeExtractor(extractor)
        .toSpec<MinimalNode>();

      expect(spec.name).toBe('entry');
      expect((spec as any).id).toBeUndefined();
      expect((spec as any).displayName).toBeUndefined();
    });
  });

  describe('Error Handling', () => {
    /**
     * **Property 6: Extractor errors are handled gracefully**
     * **Validates: Requirements 8.1, 8.3**
     */
    it('should fall back to default spec when extractor throws', () => {
      const extractor: BuildTimeExtractor = () => {
        throw new Error('Extractor error');
      };

      const builder = new FlowChartBuilder()
        .start('entry', async () => 'done', 'entry-id')
        .addBuildTimeExtractor(extractor);

      // Should not throw, should return default spec
      const spec = builder.toSpec();
      expect(spec.name).toBe('entry');
      expect(spec.id).toBe('entry-id');
    });

    it('should record extractor errors in getBuildTimeExtractorErrors()', () => {
      const extractor: BuildTimeExtractor = () => {
        throw new Error('Test error');
      };

      const builder = new FlowChartBuilder()
        .start('entry', async () => 'done')
        .addBuildTimeExtractor(extractor);

      builder.toSpec();

      const errors = builder.getBuildTimeExtractorErrors();
      expect(errors.length).toBe(1);
      expect(errors[0].message).toBe('Test error');
      expect(errors[0].error).toBeInstanceOf(Error);
    });

    it('should return empty array when no errors occurred', () => {
      const builder = new FlowChartBuilder()
        .start('entry', async () => 'done');

      builder.toSpec();

      const errors = builder.getBuildTimeExtractorErrors();
      expect(errors).toEqual([]);
    });
  });
});
