/**
 * Property-based tests for Subflow Metadata Propagation in FlowChartBuilder.
 * Uses fast-check for property-based testing.
 *
 * Feature: subflow-metadata-propagation
 */

import * as fc from 'fast-check';

import { FlowChartBuilder } from '../../../../src/core/builder/FlowChartBuilder';

// Arbitrary for valid stage names (non-empty alphanumeric strings)
const stageNameArb = fc.string({ minLength: 1, maxLength: 20 }).filter((s) => /^[a-zA-Z][a-zA-Z0-9]*$/.test(s));

// Arbitrary for stage IDs (unique identifiers)
const stageIdArb = fc.string({ minLength: 1, maxLength: 15 }).filter((s) => /^[a-zA-Z][a-zA-Z0-9_]*$/.test(s));

// Arbitrary for subflow IDs (kebab-case identifiers like "llm-core")
const subflowIdArb = fc.string({ minLength: 1, maxLength: 20 }).filter((s) => /^[a-z][a-z0-9-]*$/.test(s));

// Arbitrary for subflow display names
const subflowNameArb = fc.string({ minLength: 1, maxLength: 30 }).filter((s) => /^[A-Za-z][A-Za-z0-9 ]*$/.test(s));

/**
 * **Feature: subflow-metadata-propagation, Property 1: Subflow Metadata Preservation**
 *
 * *For any* internal node with subflow metadata (`isSubflowRoot`, `subflowId`, or `subflowName`),
 * calling `_nodeToStageNode` (via compile()) SHALL produce a StageNode with identical subflow metadata values.
 *
 * **Validates: Requirements 1.1, 1.2, 1.3, 1.4**
 */
describe('FlowChartBuilder Subflow Metadata Property Tests', () => {
  describe('Property 1: Subflow Metadata Preservation', () => {
    it('should preserve subflowId and subflowName when mounting a subflow and compiling', () => {
      fc.assert(
        fc.property(
          stageNameArb,
          stageIdArb,
          stageNameArb,
          subflowIdArb,
          subflowNameArb,
          (rootName, rootId, subflowRootName, subflowId, subflowName) => {
            // Create a subflow
            const subflow = new FlowChartBuilder()
              .start(subflowRootName, undefined, `${subflowId}_root`)
              .build();

            // Mount the subflow
            const mainBuilder = new FlowChartBuilder()
              .start(rootName, undefined, rootId)
              .addSubFlowChart(subflowId, subflow, subflowName);

            // Build and verify subflow metadata is preserved
            const { root } = mainBuilder.build();

            // The mounted subflow should be a child with subflow metadata
            const subflowChild = root.children?.find((c) => c.id === subflowId);

            return (
              subflowChild !== undefined &&
              subflowChild.isSubflowRoot === true &&
              subflowChild.subflowId === subflowId &&
              subflowChild.subflowName === subflowName
            );
          },
        ),
        { numRuns: 100 },
      );
    });

    it('should create reference node with subflow metadata (no deep propagation)', () => {
      fc.assert(
        fc.property(
          stageNameArb,
          stageIdArb,
          stageNameArb,
          stageNameArb,
          subflowIdArb,
          subflowNameArb,
          (rootName, rootId, subflowRootName, subflowChildName, subflowId, subflowName) => {
            // Create a subflow with multiple nodes
            const subflow = new FlowChartBuilder()
              .start(subflowRootName, undefined, `${subflowId}_root`)
              .addFunction(subflowChildName, undefined, `${subflowId}_child`)
              .build();

            // Mount the subflow
            const mainBuilder = new FlowChartBuilder()
              .start(rootName, undefined, rootId)
              .addSubFlowChart(subflowId, subflow, subflowName);

            // Build and verify reference node has metadata
            const { root, subflows } = mainBuilder.build();

            const subflowRef = root.children?.find((c) => c.id === subflowId);

            // Reference node should have subflow metadata
            const refHasMetadata =
              subflowRef !== undefined &&
              subflowRef.isSubflowRoot === true &&
              subflowRef.subflowId === subflowId &&
              subflowRef.subflowName === subflowName;

            // Subflow definition should be stored in subflows dictionary with mount id as key
            const hasSubflowDef = subflows !== undefined &&
              subflows[subflowId] !== undefined;

            return refHasMetadata && hasSubflowDef;
          },
        ),
        { numRuns: 100 },
      );
    });

    it('should preserve subflow metadata when mounting via addSubFlowChart', () => {
      fc.assert(
        fc.property(
          stageNameArb,
          stageIdArb,
          stageNameArb,
          subflowIdArb,
          subflowNameArb,
          (rootName, rootId, subflowRootName, subflowId, subflowName) => {
            // Create a subflow
            const subflow = new FlowChartBuilder()
              .start(subflowRootName, undefined, `${subflowId}_root`)
              .build();

            // Mount the subflow using addSubFlowChart
            const mainBuilder = new FlowChartBuilder()
              .start(rootName, undefined, rootId)
              .addSubFlowChart(subflowId, subflow, subflowName);

            const { root } = mainBuilder.build();
            const subflowChild = root.children?.find((c) => c.id === subflowId);

            // Verify the subflow metadata is present
            return (
              subflowChild !== undefined &&
              subflowChild.isSubflowRoot === true &&
              subflowChild.subflowId === subflowId &&
              subflowChild.subflowName === subflowName
            );
          },
        ),
        { numRuns: 100 },
      );
    });
  });

  /**
   * **Feature: subflow-metadata-propagation, Property 2: Sparse Object Pattern**
   *
   * *For any* internal node without subflow metadata (all three properties are undefined/falsy),
   * calling `_nodeToStageNode` (via compile()) SHALL produce a StageNode that does NOT have
   * `isSubflowRoot`, `subflowId`, or `subflowName` as own properties.
   *
   * **Validates: Requirements 2.3**
   */
  describe('Property 2: Sparse Object Pattern', () => {
    it('should not include subflow properties when not set', () => {
      fc.assert(
        fc.property(stageNameArb, stageIdArb, stageNameArb, (rootName, rootId, childName) => {
          // Create a simple flow without any subflow mounting
          const builder = new FlowChartBuilder()
            .start(rootName, undefined, rootId)
            .addFunction(childName, undefined, 'child1');

          const { root } = builder.build();

          // Neither root nor child should have subflow properties
          const hasSubflowPropsOnRoot =
            'isSubflowRoot' in root || 'subflowId' in root || 'subflowName' in root;

          const child = root.next;
          const hasSubflowPropsOnChild =
            child !== undefined &&
            ('isSubflowRoot' in child || 'subflowId' in child || 'subflowName' in child);

          return !hasSubflowPropsOnRoot && !hasSubflowPropsOnChild;
        }),
        { numRuns: 100 },
      );
    });

    it('should not include subflow properties in build() output when not set', () => {
      fc.assert(
        fc.property(stageNameArb, stageIdArb, stageNameArb, (rootName, childId, childName) => {
          // Build a flow with parallel children (no subflow)
          const builder = new FlowChartBuilder()
            .start(rootName)
            .addListOfFunction([{ id: childId, name: childName }]);

          const { root } = builder.build();

          if (!root.children || root.children.length === 0) {
            return false;
          }

          const child = root.children[0];
          const hasSubflowProps =
            'isSubflowRoot' in child || 'subflowId' in child || 'subflowName' in child;

          return !hasSubflowProps;
        }),
        { numRuns: 100 },
      );
    });
  });

  /**
   * **Feature: subflow-metadata-propagation, Property 3: Reference-Based Subflow Storage**
   *
   * *For any* subflow mounted via addSubFlowChart, the subflow definition SHALL be stored
   * in the `subflows` dictionary, and the mounted node SHALL be a reference node with metadata.
   *
   * **Validates: Requirements 3.1, 3.2 (updated for reference-based architecture)**
   */
  describe('Property 3: Reference-Based Subflow Storage', () => {
    it('should store subflow definition in subflows dictionary', () => {
      fc.assert(
        fc.property(
          stageNameArb,
          stageIdArb,
          stageNameArb,
          stageNameArb,
          subflowIdArb,
          subflowNameArb,
          (mainRootName, mainRootId, subflowRootName, subflowChildName, subflowId, subflowName) => {
            // Create a subflow with nested structure
            const subflow = new FlowChartBuilder()
              .start(subflowRootName, undefined, `${subflowId}_root`)
              .addFunction(subflowChildName, undefined, `${subflowId}_child`)
              .build();

            // Mount the subflow
            const mainBuilder = new FlowChartBuilder()
              .start(mainRootName, undefined, mainRootId)
              .addSubFlowChart(subflowId, subflow, subflowName);

            // Build
            const { root, subflows } = mainBuilder.build();

            // Verify reference node
            const subflowRef = root.children?.find((c) => c.id === subflowId);
            const refHasMetadata =
              subflowRef !== undefined &&
              subflowRef.isSubflowRoot === true &&
              subflowRef.subflowId === subflowId &&
              subflowRef.subflowName === subflowName;

            // Verify subflow definition is stored with mount id as key
            const hasSubflowDef = subflows !== undefined &&
              subflows[subflowId] !== undefined &&
              subflows[subflowId].root.name === `${subflowId}/${subflowRootName}`;

            return refHasMetadata && hasSubflowDef;
          },
        ),
        { numRuns: 100 },
      );
    });

    it('should preserve subflow metadata in toSpec() output', () => {
      fc.assert(
        fc.property(
          stageNameArb,
          stageIdArb,
          stageNameArb,
          subflowIdArb,
          subflowNameArb,
          (mainRootName, mainRootId, subflowRootName, subflowId, subflowName) => {
            // Create and mount a subflow
            const subflow = new FlowChartBuilder()
              .start(subflowRootName, undefined, `${subflowId}_root`)
              .build();

            const mainBuilder = new FlowChartBuilder()
              .start(mainRootName, undefined, mainRootId)
              .addSubFlowChart(subflowId, subflow, subflowName);

            // Get spec (JSON-serializable output)
            const spec = mainBuilder.toSpec();

            // Verify subflow metadata in spec
            const subflowSpec = spec.children?.find((c) => c.id === subflowId);

            return (
              subflowSpec !== undefined &&
              subflowSpec.isSubflowRoot === true &&
              subflowSpec.subflowId === subflowId &&
              subflowSpec.subflowName === subflowName
            );
          },
        ),
        { numRuns: 100 },
      );
    });

    it('should preserve subflow metadata through decider branch mounting', () => {
      fc.assert(
        fc.property(
          stageNameArb,
          stageIdArb,
          stageNameArb,
          subflowIdArb,
          subflowNameArb,
          (mainRootName, mainRootId, subflowRootName, subflowId, subflowName) => {
            // Create a subflow
            const subflow = new FlowChartBuilder()
              .start(subflowRootName, undefined, `${subflowId}_root`)
              .build();

            // Mount via decider branch
            const mainBuilder = new FlowChartBuilder()
              .start(mainRootName, undefined, mainRootId)
              .addDeciderFunction('Decider', () => subflowId)
              .addSubFlowChartBranch(subflowId, subflow, subflowName)
              .end();

            const { root } = mainBuilder.build();

            // addDeciderFunction creates a new decider node as root.next
            const deciderNode = root.next!;
            // Verify subflow metadata on decider branch
            const subflowBranch = deciderNode.children?.find((c) => c.id === subflowId);

            return (
              subflowBranch !== undefined &&
              subflowBranch.isSubflowRoot === true &&
              subflowBranch.subflowId === subflowId &&
              subflowBranch.subflowName === subflowName
            );
          },
        ),
        { numRuns: 100 },
      );
    });
  });

  /**
   * **Feature: subflow-metadata-propagation, Property 4: addSubFlowChartNext Preserves Internal Structure**
   *
   * *For any* subflow mounted via addSubFlowChartNext, subsequent addFunction calls SHALL NOT
   * overwrite the subflow's internal `next` chain. The subflow's internal structure should be
   * preserved in buildTimeStructure.subflowStructure, and stages added after the subflow should 
   * appear as the subflow wrapper node's `next`.
   *
   * **Validates: Bug fix for subflow internal structure being overwritten**
   */
  describe('Property 4: addSubFlowChartNext Preserves Internal Structure', () => {
    it('should preserve subflow internal structure when adding stages after subflow', () => {
      fc.assert(
        fc.property(
          stageNameArb,
          stageIdArb,
          stageNameArb,
          stageNameArb,
          stageNameArb,
          subflowIdArb,
          subflowNameArb,
          (mainRootName, mainRootId, subflowRootName, subflowChildName, afterSubflowName, subflowId, subflowName) => {
            // Create a subflow with internal structure (root -> child)
            const subflow = new FlowChartBuilder()
              .start(subflowRootName, undefined, `${subflowId}_root`)
              .addFunction(subflowChildName, undefined, `${subflowId}_child`)
              .build();

            // Mount the subflow as next, then add another stage after it
            const mainBuilder = new FlowChartBuilder()
              .start(mainRootName, undefined, mainRootId)
              .addSubFlowChartNext(subflowId, subflow, subflowName)
              .addFunction(afterSubflowName, undefined, 'after_subflow');

            const { buildTimeStructure } = mainBuilder.build();

            // The main root's next should be the subflow WRAPPER node
            const subflowSpec = buildTimeStructure.next;
            if (!subflowSpec) return false;

            // Verify subflow metadata on wrapper
            const hasSubflowMetadata =
              subflowSpec.isSubflowRoot === true &&
              subflowSpec.subflowId === subflowId &&
              subflowSpec.subflowName === subflowName;

            // Wrapper node has mount name, not internal name
            const hasWrapperName = subflowSpec.name === subflowName;

            // CRITICAL: The subflow's internal structure should be preserved in subflowStructure
            // The subflow's first internal stage should be subflowRootName
            // and its next should be subflowChildName (the internal chain)
            const hasInternalStructure =
              subflowSpec.subflowStructure !== undefined &&
              subflowSpec.subflowStructure.name === subflowRootName &&
              subflowSpec.subflowStructure.next?.name === subflowChildName;

            // The stage added AFTER the subflow should be in the wrapper's next chain
            // NOT in the subflow's internal structure
            const afterStageCorrect = subflowSpec.next?.name === afterSubflowName;

            return hasSubflowMetadata && hasWrapperName && hasInternalStructure && afterStageCorrect;
          },
        ),
        { numRuns: 100 },
      );
    });

    it('should not overwrite subflow internal next chain with subsequent stages', () => {
      // This is a specific regression test for the bug where addSubFlowChartNext
      // followed by addFunction would overwrite the subflow's internal next chain.
      
      // Create a subflow: extractInput -> keywordMatcher -> updateState
      const subflow = new FlowChartBuilder()
        .start('extractInput', undefined, 'extract_input')
        .addFunction('keywordMatcher', undefined, 'keyword_matcher')
        .addFunction('updateState', undefined, 'update_state')
        .build();

      // Mount the subflow, then add handleContextResolution after it
      const mainBuilder = new FlowChartBuilder()
        .start('prepareInput', undefined, 'prepare_input')
        .addSubFlowChartNext('smart-context-finder', subflow, 'Smart Context Finder')
        .addFunction('handleContextResolution', undefined, 'handle_resolution');

      const { buildTimeStructure } = mainBuilder.build();

      // Get the subflow wrapper spec
      const subflowSpec = buildTimeStructure.next;
      expect(subflowSpec).toBeDefined();
      expect(subflowSpec?.isSubflowRoot).toBe(true);
      expect(subflowSpec?.subflowId).toBe('smart-context-finder');
      
      // Wrapper has mount name
      expect(subflowSpec?.name).toBe('Smart Context Finder');

      // CRITICAL: The subflow's internal next chain should be preserved in subflowStructure
      // extractInput -> keywordMatcher -> updateState
      expect(subflowSpec?.subflowStructure).toBeDefined();
      expect(subflowSpec?.subflowStructure?.name).toBe('extractInput');
      expect(subflowSpec?.subflowStructure?.next?.name).toBe('keywordMatcher');
      expect(subflowSpec?.subflowStructure?.next?.next?.name).toBe('updateState');

      // The handleContextResolution should be in the wrapper's next chain
      // NOT in the subflow's internal structure
      expect(subflowSpec?.next?.name).toBe('handleContextResolution');
    });
  });
});
