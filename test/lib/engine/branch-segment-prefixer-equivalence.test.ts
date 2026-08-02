/**
 * THE LOCKSTEP PIN — `FlowChartBuilder._prefixNodeTree` and
 * `FlowchartTraverser.prefixNodeTree` are byte-twins.
 *
 * Design: docs/design/execution-control.md — Round B test 1.
 *
 * WHY THIS EXISTS. Two functions in two files prefix a node tree with a
 * subflow path segment: the builder's at MOUNT time, the traverser's at RUN
 * time (lazy subflows, and the generated branches of `addParallelForEach`).
 * They are byte-identical today and nothing in the type system says they must
 * stay that way. A chart that comes out differently depending on WHICH one
 * prefixed it would not crash — it would mis-address stages in the trace, and
 * `parseRuntimeStageId`, `causalChain` and the slice layer would all agree on
 * the wrong answer. The design doc names this the audit's one true lockstep
 * edit and asks for a pin rather than hope. This is the pin.
 *
 * If you change one prefixer, this test fails until you change the other.
 *
 * Test types: Unit (both twins on the same input) · Functional (generated
 * branch segment specifically) · Property (equivalence over random trees).
 */
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { FlowChartBuilder } from '../../../src/lib/builder/FlowChartBuilder.js';
import { buildBranchSegment } from '../../../src/lib/engine/branchSegment.js';
import type { StageNode } from '../../../src/lib/engine/graph/StageNode.js';
import { FlowchartTraverser } from '../../../src/lib/engine/traversal/FlowchartTraverser.js';

/**
 * Reach both prefixers.
 *
 * Both are non-public (`_prefixNodeTree` is builder-internal, `prefixNodeTree`
 * is private) — casting is the point: this test asserts on the INTERNAL twins,
 * because that is where the drift would happen. A traverser needs no working
 * runtime for this: `prefixNodeTree` is a pure tree transform.
 */
function builderPrefix(node: StageNode, prefix: string): StageNode {
  return (new FlowChartBuilder() as any)._prefixNodeTree(node, prefix);
}
function traverserPrefix(node: StageNode, prefix: string): StageNode {
  const traverser = Object.create(FlowchartTraverser.prototype) as any;
  return traverser.prefixNodeTree(node, prefix);
}

/** A tree that exercises every field the prefixers touch. */
function representativeTree(): StageNode {
  return {
    name: 'Root',
    id: 'root',
    children: [
      { name: 'Branch A', id: 'branch-a', branchId: 'branch-a' },
      {
        name: 'Mount',
        id: 'mount',
        isSubflowRoot: true,
        subflowId: 'sf-inner',
        subflowName: 'Inner',
        next: { name: 'After Mount', id: 'after-mount' },
      },
    ],
    next: {
      name: 'Second',
      id: 'second',
      next: { name: 'Loop back', id: 'root', isLoopRef: true },
    },
  };
}

describe('prefixer byte-equivalence (builder ↔ traverser)', () => {
  const segment = buildBranchSegment('review-chunks', 3);

  it('produces IDENTICAL trees for a generated branch segment', () => {
    const fromBuilder = builderPrefix(representativeTree(), segment);
    const fromTraverser = traverserPrefix(representativeTree(), segment);
    expect(fromTraverser).toEqual(fromBuilder);
  });

  it('produces the exact expected shape (so drift that keeps the twins equal still fails)', () => {
    expect(builderPrefix(representativeTree(), segment)).toEqual({
      name: 'review-chunks~3/Root',
      id: 'review-chunks~3/root',
      children: [
        { name: 'review-chunks~3/Branch A', id: 'review-chunks~3/branch-a', branchId: 'branch-a' },
        {
          name: 'review-chunks~3/Mount',
          id: 'review-chunks~3/mount',
          isSubflowRoot: true,
          subflowId: 'review-chunks~3/sf-inner',
          subflowName: 'Inner',
          next: { name: 'review-chunks~3/After Mount', id: 'review-chunks~3/after-mount' },
        },
      ],
      next: {
        name: 'review-chunks~3/Second',
        id: 'review-chunks~3/second',
        next: { name: 'review-chunks~3/Loop back', id: 'review-chunks~3/root', isLoopRef: true },
      },
    });
  });

  it('leaves `branchId` UNPREFIXED in both — decider/selector matching depends on it', () => {
    const fromBuilder = builderPrefix(representativeTree(), segment);
    const fromTraverser = traverserPrefix(representativeTree(), segment);
    expect(fromBuilder.children![0].branchId).toBe('branch-a');
    expect(fromTraverser.children![0].branchId).toBe('branch-a');
  });

  it('agrees on a hand-authored subflow id too — a generated segment is not a special case', () => {
    expect(traverserPrefix(representativeTree(), 'sf-tools')).toEqual(builderPrefix(representativeTree(), 'sf-tools'));
  });

  it('does not mutate its input (both twins clone)', () => {
    const input = representativeTree();
    builderPrefix(input, segment);
    traverserPrefix(input, segment);
    expect(input.id).toBe('root');
    expect(input.children![1].subflowId).toBe('sf-inner');
  });

  // ── Property ────────────────────────────────────────────────
  it('property: the twins agree for any tree and any segment', () => {
    const nodeArb: fc.Arbitrary<StageNode> = fc.letrec<{ node: StageNode }>((tie) => ({
      node: fc.record(
        {
          name: fc.string({ minLength: 1, maxLength: 8 }),
          id: fc.string({ minLength: 1, maxLength: 8 }),
          subflowId: fc.option(fc.string({ minLength: 1, maxLength: 6 }), { nil: undefined }),
          next: fc.option(fc.oneof({ maxDepth: 2 }, tie('node')), { nil: undefined }),
          children: fc.option(fc.array(tie('node'), { maxLength: 2 }), { nil: undefined }),
        },
        { requiredKeys: ['name', 'id'] },
      ) as fc.Arbitrary<StageNode>,
    })).node;

    fc.assert(
      fc.property(nodeArb, fc.string({ minLength: 1, maxLength: 10 }), fc.nat({ max: 50 }), (tree, parentId, index) => {
        const seg = buildBranchSegment(parentId, index);
        expect(traverserPrefix(structuredClone(tree), seg)).toEqual(builderPrefix(structuredClone(tree), seg));
      }),
      { numRuns: 150 },
    );
  });
});
