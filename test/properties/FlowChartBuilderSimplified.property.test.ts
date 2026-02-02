/**
 * Property-based tests for FlowChartBuilderSimplified.
 * 
 * These tests verify universal properties that should hold across all valid inputs.
 * 
 * Feature: flowchart-builder-simplification
 */

import * as fc from 'fast-check';
import {
  FlowChartBuilder,
  flowChart,
  FlowChartSpec,
} from '../../src/core/builder/FlowChartBuilder';
import type { StageNode } from '../../src/core/executor/Pipeline';

/**
 * Helper to collect all nodes from a StageNode tree.
 */
function collectAllNodes<TOut, TScope>(root: StageNode<TOut, TScope>): StageNode<TOut, TScope>[] {
  const nodes: StageNode<TOut, TScope>[] = [];
  const visit = (node: StageNode<TOut, TScope>) => {
    nodes.push(node);
    if (node.children) {
      for (const child of node.children) {
        visit(child);
      }
    }
    if (node.next) {
      visit(node.next);
    }
  };
  visit(root);
  return nodes;
}

/**
 * Helper to collect all specs from a FlowChartSpec tree.
 */
function collectAllSpecs(root: FlowChartSpec): FlowChartSpec[] {
  const specs: FlowChartSpec[] = [];
  const visit = (spec: FlowChartSpec) => {
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

/**
 * Arbitrary for valid stage names (non-empty strings without special chars).
 */
const arbStageName = fc.string({ minLength: 1, maxLength: 20 })
  .filter(s => /^[a-zA-Z][a-zA-Z0-9_]*$/.test(s));

/**
 * Arbitrary for optional stage IDs.
 */
const arbStageId = fc.option(arbStageName, { nil: undefined });

describe('FlowChartBuilderSimplified Property Tests', () => {
  /**
   * Property 1: StageNode Structure Validity
   * 
   * For any flow built with the simplified builder, every node in the resulting
   * StageNode tree should be a valid StageNode without any _N-specific properties
   * (like `parent` pointer) and should have the required `name` property.
   * 
   * **Validates: Requirements 1.1, 3.1**
   */
  describe('Property 1: StageNode Structure Validity', () => {
    it('all nodes have required name property and no parent pointer', () => {
      fc.assert(
        fc.property(
          fc.array(fc.record({ name: arbStageName, id: arbStageId }), { minLength: 1, maxLength: 10 }),
          (nodeSpecs) => {
            // Build a linear chain
            let builder = new FlowChartBuilder().start(nodeSpecs[0].name, undefined, nodeSpecs[0].id);
            for (let i = 1; i < nodeSpecs.length; i++) {
              builder = builder.addFunction(nodeSpecs[i].name, undefined, nodeSpecs[i].id);
            }
            
            const { root } = builder.build();
            const allNodes = collectAllNodes(root);
            
            // Verify each node
            for (const node of allNodes) {
              // Must have name property
              expect(node).toHaveProperty('name');
              expect(typeof node.name).toBe('string');
              expect(node.name.length).toBeGreaterThan(0);
              
              // Must NOT have parent pointer (removed in simplified builder)
              expect(node).not.toHaveProperty('parent');
              
              // Must NOT have _N-specific properties
              expect(node).not.toHaveProperty('spec');
              expect(node).not.toHaveProperty('decider'); // decider is stored as nextNodeDecider
              expect(node).not.toHaveProperty('selector'); // selector is stored as nextNodeSelector
            }
          }
        ),
        { numRuns: 100 }
      );
    });

    it('nodes with streaming flag have valid streaming properties', () => {
      fc.assert(
        fc.property(
          arbStageName,
          fc.option(arbStageName, { nil: undefined }),
          (name, streamId) => {
            const builder = new FlowChartBuilder()
              .start('entry')
              .addStreamingFunction(name, streamId);
            
            const { root } = builder.build();
            const streamingNode = root.next!;
            
            expect(streamingNode.isStreaming).toBe(true);
            expect(streamingNode.streamId).toBe(streamId ?? name);
          }
        ),
        { numRuns: 50 }
      );
    });
  });

  /**
   * Property 2: Incremental Structure Consistency
   * 
   * For any sequence of addFunction() calls on a builder, the StageNode.next chain
   * and FlowChartSpec.next chain should be parallel—meaning for each node in the
   * StageNode chain, there exists a corresponding node in the FlowChartSpec chain
   * with the same name, id, and displayName.
   * 
   * **Validates: Requirements 4.2**
   */
  describe('Property 2: Incremental Structure Consistency', () => {
    it('StageNode and FlowChartSpec chains are parallel', () => {
      fc.assert(
        fc.property(
          fc.array(
            fc.record({
              name: arbStageName,
              id: arbStageId,
              displayName: fc.option(fc.string({ minLength: 1, maxLength: 30 }), { nil: undefined }),
            }),
            { minLength: 1, maxLength: 10 }
          ),
          (nodeSpecs) => {
            // Build a linear chain
            let builder = new FlowChartBuilder().start(
              nodeSpecs[0].name,
              undefined,
              nodeSpecs[0].id,
              nodeSpecs[0].displayName
            );
            for (let i = 1; i < nodeSpecs.length; i++) {
              builder = builder.addFunction(
                nodeSpecs[i].name,
                undefined,
                nodeSpecs[i].id,
                nodeSpecs[i].displayName
              );
            }
            
            const { root, buildTimeStructure } = builder.build();
            
            // Walk both chains and compare
            let stageNode: StageNode | undefined = root;
            let specNode: any = buildTimeStructure;
            let count = 0;
            
            while (stageNode && specNode) {
              expect(specNode.name).toBe(stageNode.name);
              expect(specNode.id).toBe(stageNode.id);
              expect(specNode.displayName).toBe(stageNode.displayName);
              
              stageNode = stageNode.next;
              specNode = specNode.next;
              count++;
            }
            
            // Both chains should end at the same time
            expect(stageNode).toBeUndefined();
            expect(specNode).toBeUndefined();
            
            // Should have visited all nodes
            expect(count).toBe(nodeSpecs.length);
          }
        ),
        { numRuns: 100 }
      );
    });
  });

  /**
   * Property 3: Build Returns Pre-Built Structures
   * 
   * For any flow built with the simplified builder, calling build() should return
   * a FlowChart where the root StageNode is the same object that was incrementally
   * constructed (not a converted copy).
   * 
   * **Validates: Requirements 4.4**
   */
  describe('Property 3: Build Returns Pre-Built Structures', () => {
    it('build() returns the incrementally constructed root', () => {
      fc.assert(
        fc.property(
          arbStageName,
          arbStageId,
          (name, id) => {
            const builder = new FlowChartBuilder().start(name, undefined, id);
            
            // Build twice - should return same root object
            const result1 = builder.build();
            const result2 = builder.build();
            
            // Root should be the same object (not a copy)
            expect(result1.root).toBe(result2.root);
            
            // Properties should match what we specified
            expect(result1.root.name).toBe(name);
            if (id) {
              expect(result1.root.id).toBe(id);
            }
          }
        ),
        { numRuns: 50 }
      );
    });
  });

  /**
   * Property 4: toSpec Returns Consistent Structure
   * 
   * For any flow built with the simplified builder, calling toSpec() should return
   * a FlowChartSpec that is structurally equivalent to the incrementally built spec.
   * 
   * **Validates: Requirements 4.5**
   */
  describe('Property 4: toSpec Returns Consistent Structure', () => {
    it('toSpec() returns consistent structure', () => {
      fc.assert(
        fc.property(
          fc.array(fc.record({ name: arbStageName, id: arbStageId }), { minLength: 1, maxLength: 5 }),
          (nodeSpecs) => {
            let builder = new FlowChartBuilder().start(nodeSpecs[0].name, undefined, nodeSpecs[0].id);
            for (let i = 1; i < nodeSpecs.length; i++) {
              builder = builder.addFunction(nodeSpecs[i].name, undefined, nodeSpecs[i].id);
            }
            
            const spec = builder.toSpec();
            const allSpecs = collectAllSpecs(spec);
            
            // Should have same number of nodes as input
            expect(allSpecs.length).toBe(nodeSpecs.length);
            
            // Each spec should have the correct name
            for (let i = 0; i < nodeSpecs.length; i++) {
              expect(allSpecs[i].name).toBe(nodeSpecs[i].name);
              if (nodeSpecs[i].id) {
                expect(allSpecs[i].id).toBe(nodeSpecs[i].id);
              }
            }
          }
        ),
        { numRuns: 100 }
      );
    });
  });

  /**
   * Property 6: Factory Function Initializes Builder
   * 
   * For any call to flowChart(name, fn), the returned builder should have a root
   * node with the given name, and if fn is provided, it should be registered in
   * the stageMap under that name.
   * 
   * **Validates: Requirements 7.1**
   */
  describe('Property 6: Factory Function Initializes Builder', () => {
    it('flowChart() creates builder with correct root', () => {
      fc.assert(
        fc.property(
          arbStageName,
          arbStageId,
          (name, id) => {
            const builder = flowChart(name, undefined, id);
            const { root } = builder.build();
            
            expect(root.name).toBe(name);
            if (id) {
              expect(root.id).toBe(id);
            }
          }
        ),
        { numRuns: 50 }
      );
    });

    it('flowChart() with function registers in stageMap', () => {
      fc.assert(
        fc.property(
          arbStageName,
          (name) => {
            const fn = async () => ({ result: 'test' });
            const builder = flowChart(name, fn);
            const { stageMap } = builder.build();
            
            expect(stageMap.has(name)).toBe(true);
            expect(stageMap.get(name)).toBe(fn);
          }
        ),
        { numRuns: 50 }
      );
    });
  });
});


describe('Property 5: Subflow Mounting Creates Reference Nodes', () => {
  /**
   * Property 5: Subflow Mounting Creates Reference Nodes
   * 
   * For any subflow mounted via addSubFlowChartBranch(), the resulting child node
   * should be a reference node with isSubflowRoot: true, subflowId set to the mount id,
   * and the subflow definition should be registered in _subflowDefs exactly once.
   * 
   * **Validates: Requirements 6.2**
   */
  it('subflow mounting creates reference nodes with correct metadata', () => {
    fc.assert(
      fc.property(
        fc.uniqueArray(
          fc.record({
            id: arbStageName,
            name: arbStageName,
          }),
          { minLength: 1, maxLength: 5, selector: (spec) => spec.id }
        ),
        (subflowSpecs) => {
          // Build subflows
          const subflows = subflowSpecs.map((spec) =>
            new FlowChartBuilder().start(spec.name).build()
          );

          // Mount all subflows as decider branches
          let builder = new FlowChartBuilder()
            .start('root')
            .addDecider(() => subflowSpecs[0].id);

          for (let i = 0; i < subflows.length; i++) {
            builder = builder.addSubFlowChartBranch(subflowSpecs[i].id, subflows[i]) as any;
          }

          const { root, subflows: defs } = (builder as any).end().build();

          // Verify reference nodes
          expect(root.children).toBeDefined();
          expect(root.children!.length).toBe(subflows.length);

          for (const child of root.children!) {
            expect(child.isSubflowRoot).toBe(true);
            expect(child.subflowId).toBeDefined();
            expect(defs).toBeDefined();
            expect(defs![child.subflowId!]).toBeDefined();
          }

          // Verify no duplicates in defs
          const defKeys = Object.keys(defs || {});
          expect(new Set(defKeys).size).toBe(defKeys.length);
        }
      ),
      { numRuns: 50 }
    );
  });

  it('subflow mounting via addSubFlowChart creates fork children', () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.record({
            id: arbStageName,
            name: arbStageName,
          }),
          { minLength: 1, maxLength: 3 }
        ).filter((specs) => {
          // Ensure unique IDs
          const ids = specs.map((s) => s.id);
          return new Set(ids).size === ids.length;
        }),
        (subflowSpecs) => {
          // Build subflows
          const subflows = subflowSpecs.map((spec) =>
            new FlowChartBuilder().start(spec.name).build()
          );

          // Mount all subflows as fork children
          let builder = new FlowChartBuilder().start('root');

          for (let i = 0; i < subflows.length; i++) {
            builder = builder.addSubFlowChart(subflowSpecs[i].id, subflows[i]);
          }

          const { root, subflows: defs } = builder.build();

          // Verify fork children
          expect(root.children).toBeDefined();
          expect(root.children!.length).toBe(subflows.length);

          for (const child of root.children!) {
            expect(child.isSubflowRoot).toBe(true);
            expect(child.subflowId).toBeDefined();
          }

          // Verify subflow definitions
          expect(defs).toBeDefined();
          expect(Object.keys(defs!).length).toBe(subflows.length);
        }
      ),
      { numRuns: 50 }
    );
  });

  it('subflow mounting via addSubFlowChartNext creates linear continuation', () => {
    fc.assert(
      fc.property(
        arbStageName,
        arbStageName,
        (subflowId, subflowName) => {
          // Build a subflow
          const subflow = new FlowChartBuilder().start(subflowName).build();

          // Mount as next
          const builder = new FlowChartBuilder()
            .start('root')
            .addSubFlowChartNext(subflowId, subflow);

          const { root, subflows: defs } = builder.build();

          // Verify next is the subflow reference
          expect(root.next).toBeDefined();
          expect(root.next!.isSubflowRoot).toBe(true);
          expect(root.next!.subflowId).toBe(subflowId);

          // Verify subflow definition
          expect(defs).toBeDefined();
          expect(defs![subflowId]).toBeDefined();
        }
      ),
      { numRuns: 50 }
    );
  });
});
