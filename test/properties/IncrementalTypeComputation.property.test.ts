/**
 * Property-based tests for Incremental Type Computation in FlowChartBuilder.
 * Uses fast-check for property-based testing.
 *
 * Feature: incremental-type-computation
 */

import * as fc from 'fast-check';
import {
  FlowChartBuilder,
  flowChart,
  SerializedPipelineStructure,
  BuildTimeExtractor,
} from '../../src/core/builder/FlowChartBuilder';

// Reserved JS property names to avoid
const reservedNames = new Set(['valueOf', 'toString', 'constructor', 'hasOwnProperty', 'prototype', '__proto__']);

// Arbitrary for valid stage names (non-empty alphanumeric strings, avoiding reserved names)
const stageNameArb = fc.string({ minLength: 1, maxLength: 20 })
  .filter((s) => /^[a-zA-Z][a-zA-Z0-9]*$/.test(s) && !reservedNames.has(s));

// Arbitrary for stage IDs (unique identifiers, avoiding reserved names)
const stageIdArb = fc.string({ minLength: 1, maxLength: 15 })
  .filter((s) => /^[a-zA-Z][a-zA-Z0-9_]*$/.test(s) && !reservedNames.has(s));

// Arbitrary for subflow IDs (kebab-case identifiers)
const subflowIdArb = fc.string({ minLength: 1, maxLength: 20 })
  .filter((s) => /^[a-z][a-z0-9-]*$/.test(s) && !reservedNames.has(s));

/**
 * Helper to collect all specs from a SerializedPipelineStructure tree.
 */
function collectAllSpecs(root: SerializedPipelineStructure): SerializedPipelineStructure[] {
  const specs: SerializedPipelineStructure[] = [];
  const visit = (spec: SerializedPipelineStructure) => {
    specs.push(spec);
    if (spec.children) {
      for (const child of spec.children) {
        visit(child);
      }
    }
    if (spec.next) {
      visit(spec.next);
    }
  };
  visit(root);
  return specs;
}

describe('Incremental Type Computation Property Tests', () => {
  /**
   * **Property 1: Builder Methods Set Correct Types**
   *
   * For any flow built with the builder, each node in the resulting
   * SerializedPipelineStructure should have the correct `type` field set
   * based on the builder method used to create it.
   *
   * **Validates: Requirements 1.1, 1.2, 1.3, 1.4, 1.5, 1.6, 1.7**
   */
  describe('Property 1: Builder Methods Set Correct Types', () => {
    it('start() creates node with type="stage"', () => {
      fc.assert(
        fc.property(stageNameArb, stageIdArb, (name, id) => {
          const { buildTimeStructure } = new FlowChartBuilder()
            .start(name, undefined, id)
            .build();

          return buildTimeStructure.type === 'stage';
        }),
        { numRuns: 100 },
      );
    });

    it('addFunction() creates node with type="stage"', () => {
      fc.assert(
        fc.property(stageNameArb, stageNameArb, (rootName, funcName) => {
          const { buildTimeStructure } = new FlowChartBuilder()
            .start(rootName)
            .addFunction(funcName)
            .build();

          return (
            buildTimeStructure.type === 'stage' &&
            buildTimeStructure.next?.type === 'stage'
          );
        }),
        { numRuns: 100 },
      );
    });

    it('addStreamingFunction() creates node with type="streaming"', () => {
      fc.assert(
        fc.property(stageNameArb, stageNameArb, (rootName, streamName) => {
          const { buildTimeStructure } = new FlowChartBuilder()
            .start(rootName)
            .addStreamingFunction(streamName, 'stream-id')
            .build();

          return (
            buildTimeStructure.type === 'stage' &&
            buildTimeStructure.next?.type === 'streaming' &&
            buildTimeStructure.next?.isStreaming === true
          );
        }),
        { numRuns: 100 },
      );
    });

    it('addDeciderFunction().end() sets parent type="decider"', () => {
      fc.assert(
        fc.property(
          stageNameArb,
          fc.uniqueArray(stageNameArb, { minLength: 2, maxLength: 2 }),
          (rootName, branches) => {
            const [branch1, branch2] = branches;
            const { buildTimeStructure } = new FlowChartBuilder()
              .start(rootName)
              .addDeciderFunction('Decider', () => branch1)
              .addFunctionBranch(branch1, `${branch1}Stage`)
              .addFunctionBranch(branch2, `${branch2}Stage`)
              .end()
              .build();

            // addDeciderFunction creates a new decider node as next of root
            const deciderSpec = buildTimeStructure.next;
            return (
              buildTimeStructure.type === 'stage' &&
              deciderSpec !== undefined &&
              deciderSpec.type === 'decider' &&
              deciderSpec.hasDecider === true &&
              deciderSpec.children?.every((c) => c.type === 'stage') === true
            );
          },
        ),
        { numRuns: 100 },
      );
    });

    it('addSelector().end() sets parent type="decider"', () => {
      fc.assert(
        fc.property(
          stageNameArb,
          fc.uniqueArray(stageNameArb, { minLength: 2, maxLength: 2 }),
          (rootName, branches) => {
            const [branch1, branch2] = branches;
            const { buildTimeStructure } = new FlowChartBuilder()
              .start(rootName)
              .addSelector(() => [branch1])
              .addFunctionBranch(branch1, `${branch1}Stage`)
              .addFunctionBranch(branch2, `${branch2}Stage`)
              .end()
              .build();

            return (
              buildTimeStructure.type === 'decider' &&
              buildTimeStructure.hasSelector === true &&
              buildTimeStructure.children?.every((c) => c.type === 'stage') === true
            );
          },
        ),
        { numRuns: 100 },
      );
    });

    it('addListOfFunction() sets parent type="fork" and children type="stage"', () => {
      fc.assert(
        fc.property(
          stageNameArb,
          fc.uniqueArray(stageIdArb, { minLength: 1, maxLength: 5 }),
          (rootName, childIds) => {
            const children = childIds.map((id) => ({ id, name: `${id}Stage` }));
            const { buildTimeStructure } = new FlowChartBuilder()
              .start(rootName, undefined, 'root-id')
              .addListOfFunction(children)
              .build();

            return (
              buildTimeStructure.type === 'fork' &&
              buildTimeStructure.children?.length === children.length &&
              buildTimeStructure.children?.every((c) => c.type === 'stage') === true
            );
          },
        ),
        { numRuns: 100 },
      );
    });

    it('addSubFlowChart() sets parent type="fork"', () => {
      fc.assert(
        fc.property(stageNameArb, subflowIdArb, stageNameArb, (rootName, subflowId, subflowRootName) => {
          const subflow = new FlowChartBuilder().start(subflowRootName).build();
          const { buildTimeStructure } = new FlowChartBuilder()
            .start(rootName)
            .addSubFlowChart(subflowId, subflow)
            .build();

          return buildTimeStructure.type === 'fork';
        }),
        { numRuns: 100 },
      );
    });
  });

  /**
   * **Property 2: Direct Return Without Transformation**
   *
   * For any flow built without a custom extractor, build() should return
   * the _rootSpec directly without any transformation. This ensures O(1)
   * complexity at build time.
   *
   * **Validates: Requirements 3.1, 3.3, 3.4**
   */
  describe('Property 2: Direct Return Without Transformation', () => {
    it('build() returns same structure on multiple calls', () => {
      fc.assert(
        fc.property(
          fc.array(fc.record({ name: stageNameArb, id: stageIdArb }), { minLength: 1, maxLength: 5 }),
          (nodeSpecs) => {
            let builder = new FlowChartBuilder().start(nodeSpecs[0].name, undefined, nodeSpecs[0].id);
            for (let i = 1; i < nodeSpecs.length; i++) {
              builder = builder.addFunction(nodeSpecs[i].name, undefined, nodeSpecs[i].id);
            }

            const result1 = builder.build();
            const result2 = builder.build();

            // buildTimeStructure should be the same object (not a copy)
            return result1.buildTimeStructure === result2.buildTimeStructure;
          },
        ),
        { numRuns: 100 },
      );
    });

    it('toSpec() returns same structure on multiple calls', () => {
      fc.assert(
        fc.property(stageNameArb, stageIdArb, (name, id) => {
          const builder = new FlowChartBuilder().start(name, undefined, id);

          const spec1 = builder.toSpec();
          const spec2 = builder.toSpec();

          // Should be the same object
          return spec1 === spec2;
        }),
        { numRuns: 100 },
      );
    });

    it('all nodes have type field set without extractor', () => {
      fc.assert(
        fc.property(
          fc.array(fc.record({ name: stageNameArb, id: stageIdArb }), { minLength: 1, maxLength: 5 }),
          (nodeSpecs) => {
            let builder = new FlowChartBuilder().start(nodeSpecs[0].name, undefined, nodeSpecs[0].id);
            for (let i = 1; i < nodeSpecs.length; i++) {
              builder = builder.addFunction(nodeSpecs[i].name, undefined, nodeSpecs[i].id);
            }

            const { buildTimeStructure } = builder.build();
            const allSpecs = collectAllSpecs(buildTimeStructure);

            // Every node should have a type field
            return allSpecs.every((spec) => spec.type !== undefined);
          },
        ),
        { numRuns: 100 },
      );
    });
  });

  /**
   * **Property 3: Custom Extractor Applied Incrementally**
   *
   * For any flow built with a custom extractor registered in the constructor,
   * the extractor should be applied to each node as it's created, not at build time.
   *
   * **Validates: Requirements 3.2, 4.3**
   */
  describe('Property 3: Custom Extractor Applied Incrementally', () => {
    it('extractor is called for each node created', () => {
      fc.assert(
        fc.property(
          fc.array(fc.record({ name: stageNameArb, id: stageIdArb }), { minLength: 1, maxLength: 5 }),
          (nodeSpecs) => {
            const callCount = { value: 0 };
            const extractor: BuildTimeExtractor = (metadata) => {
              callCount.value++;
              return { ...metadata, extracted: true };
            };

            let builder = new FlowChartBuilder(extractor).start(
              nodeSpecs[0].name,
              undefined,
              nodeSpecs[0].id,
            );
            for (let i = 1; i < nodeSpecs.length; i++) {
              builder = builder.addFunction(nodeSpecs[i].name, undefined, nodeSpecs[i].id);
            }

            // Extractor should have been called for each node
            return callCount.value === nodeSpecs.length;
          },
        ),
        { numRuns: 100 },
      );
    });

    it('extractor transforms each node', () => {
      fc.assert(
        fc.property(
          fc.array(fc.record({ name: stageNameArb, id: stageIdArb }), { minLength: 1, maxLength: 5 }),
          (nodeSpecs) => {
            const extractor: BuildTimeExtractor = (metadata) => ({
              ...metadata,
              customField: 'transformed',
            });

            let builder = new FlowChartBuilder(extractor).start(
              nodeSpecs[0].name,
              undefined,
              nodeSpecs[0].id,
            );
            for (let i = 1; i < nodeSpecs.length; i++) {
              builder = builder.addFunction(nodeSpecs[i].name, undefined, nodeSpecs[i].id);
            }

            const { buildTimeStructure } = builder.build();
            const allSpecs = collectAllSpecs(buildTimeStructure);

            // Every node should have the custom field
            return allSpecs.every((spec: any) => spec.customField === 'transformed');
          },
        ),
        { numRuns: 100 },
      );
    });

    it('extractor errors are caught and recorded', () => {
      fc.assert(
        fc.property(stageNameArb, (name) => {
          const extractor: BuildTimeExtractor = () => {
            throw new Error('Test error');
          };

          const builder = new FlowChartBuilder(extractor).start(name);
          const errors = builder.getBuildTimeExtractorErrors();

          // Error should have been recorded
          return errors.length === 1 && errors[0].message === 'Test error';
        }),
        { numRuns: 50 },
      );
    });
  });

  /**
   * **Property 4: Subflow buildTimeStructure Reused**
   *
   * For any subflow mounted via addSubFlowChart, addSubFlowChartBranch, or
   * addSubFlowChartNext, the subflow's buildTimeStructure should be reused
   * (with metadata wrapper) rather than rebuilt.
   *
   * **Validates: Requirements 4.1, 4.2, 4.4**
   */
  describe('Property 4: Subflow buildTimeStructure Reused', () => {
    it('addSubFlowChart preserves subflow structure with metadata', () => {
      fc.assert(
        fc.property(
          stageNameArb,
          subflowIdArb,
          stageNameArb,
          stageNameArb,
          (rootName, subflowId, subflowRootName, subflowChildName) => {
            // Build a subflow with multiple nodes
            const subflow = new FlowChartBuilder()
              .start(subflowRootName, undefined, `${subflowId}_root`)
              .addFunction(subflowChildName, undefined, `${subflowId}_child`)
              .build();

            // Mount the subflow
            const { buildTimeStructure } = new FlowChartBuilder()
              .start(rootName)
              .addSubFlowChart(subflowId, subflow)
              .build();

            // Find the mounted subflow in children
            const mountedSubflow = buildTimeStructure.children?.find((c) => c.id === subflowId);

            // Should have subflow metadata on the WRAPPER node
            // The internal structure is preserved in subflowStructure property
            return (
              mountedSubflow !== undefined &&
              mountedSubflow.isSubflowRoot === true &&
              mountedSubflow.subflowId === subflowId &&
              // Wrapper node has mount name, not subflow's internal name
              mountedSubflow.name === subflowId &&
              // Internal structure is preserved in subflowStructure
              mountedSubflow.subflowStructure !== undefined &&
              mountedSubflow.subflowStructure.name === subflowRootName &&
              mountedSubflow.subflowStructure.next?.name === subflowChildName
            );
          },
        ),
        { numRuns: 100 },
      );
    });

    it('addSubFlowChartNext preserves subflow structure with metadata', () => {
      fc.assert(
        fc.property(
          stageNameArb,
          subflowIdArb,
          stageNameArb,
          (rootName, subflowId, subflowRootName) => {
            const subflow = new FlowChartBuilder()
              .start(subflowRootName, undefined, `${subflowId}_root`)
              .build();

            const { buildTimeStructure } = new FlowChartBuilder()
              .start(rootName)
              .addSubFlowChartNext(subflowId, subflow)
              .build();

            // The next node should be the WRAPPER with subflow metadata
            // Internal structure is preserved in subflowStructure property
            return (
              buildTimeStructure.next !== undefined &&
              buildTimeStructure.next.isSubflowRoot === true &&
              buildTimeStructure.next.subflowId === subflowId &&
              // Wrapper node has mount name, not subflow's internal name
              buildTimeStructure.next.name === subflowId &&
              // Internal structure is preserved in subflowStructure
              buildTimeStructure.next.subflowStructure !== undefined &&
              buildTimeStructure.next.subflowStructure.name === subflowRootName
            );
          },
        ),
        { numRuns: 100 },
      );
    });

    it('DeciderList.addSubFlowChartBranch preserves subflow structure', () => {
      fc.assert(
        fc.property(
          stageNameArb,
          subflowIdArb,
          stageNameArb,
          (rootName, subflowId, subflowRootName) => {
            const subflow = new FlowChartBuilder()
              .start(subflowRootName, undefined, `${subflowId}_root`)
              .build();

            const { buildTimeStructure } = new FlowChartBuilder()
              .start(rootName)
              .addDeciderFunction('Decider', () => subflowId)
              .addSubFlowChartBranch(subflowId, subflow)
              .end()
              .build();

            // addDeciderFunction creates a new decider node as next of root
            const deciderSpec = buildTimeStructure.next;
            // Find the mounted subflow in children of the decider node
            const mountedSubflow = deciderSpec?.children?.find((c) => c.subflowId === subflowId);

            // Should have subflow metadata on the WRAPPER node
            // Internal structure is preserved in subflowStructure property
            return (
              mountedSubflow !== undefined &&
              mountedSubflow.isSubflowRoot === true &&
              mountedSubflow.subflowId === subflowId &&
              // Internal structure is preserved in subflowStructure
              mountedSubflow.subflowStructure !== undefined &&
              mountedSubflow.subflowStructure.name === subflowRootName
            );
          },
        ),
        { numRuns: 100 },
      );
    });

    it('SelectorList.addSubFlowChartBranch preserves subflow structure', () => {
      fc.assert(
        fc.property(
          stageNameArb,
          subflowIdArb,
          stageNameArb,
          (rootName, subflowId, subflowRootName) => {
            const subflow = new FlowChartBuilder()
              .start(subflowRootName, undefined, `${subflowId}_root`)
              .build();

            const { buildTimeStructure } = new FlowChartBuilder()
              .start(rootName)
              .addSelector(() => [subflowId])
              .addSubFlowChartBranch(subflowId, subflow)
              .end()
              .build();

            // Find the mounted subflow in children - the branch id is subflowId
            const mountedSubflow = buildTimeStructure.children?.find((c) => c.subflowId === subflowId);

            // Should have subflow metadata on the WRAPPER node
            // Internal structure is preserved in subflowStructure property
            return (
              mountedSubflow !== undefined &&
              mountedSubflow.isSubflowRoot === true &&
              mountedSubflow.subflowId === subflowId &&
              // Internal structure is preserved in subflowStructure
              mountedSubflow.subflowStructure !== undefined &&
              mountedSubflow.subflowStructure.name === subflowRootName
            );
          },
        ),
        { numRuns: 100 },
      );
    });
  });

  /**
   * **Property 5: flowChart Factory with Extractor**
   *
   * The flowChart() factory function should accept a buildTimeExtractor
   * as the 5th parameter and apply it to all nodes.
   *
   * **Validates: Requirements 3.2**
   */
  describe('Property 5: flowChart Factory with Extractor', () => {
    it('flowChart() applies extractor to all nodes', () => {
      fc.assert(
        fc.property(stageNameArb, stageNameArb, (rootName, nextName) => {
          const extractor: BuildTimeExtractor = (metadata) => ({
            ...metadata,
            factoryExtracted: true,
          });

          const { buildTimeStructure } = flowChart(rootName, undefined, undefined, undefined, extractor)
            .addFunction(nextName)
            .build();

          const allSpecs = collectAllSpecs(buildTimeStructure);

          // Every node should have the custom field
          return allSpecs.every((spec: any) => spec.factoryExtracted === true);
        }),
        { numRuns: 100 },
      );
    });
  });
});
