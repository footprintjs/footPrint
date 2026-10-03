/**
 * prefixNodeTree — the ONE subflow-id prefixer (F7, 9.37.0).
 *
 * A mounted subflow's node tree is re-addressed under its mount: every `name`,
 * `id` and nested `subflowId` gains `<prefix>/`. The builder does it at MOUNT
 * time (`FlowChartBuilder · _prefixNodeTree`); the traverser at RUN time (lazy
 * subflows, and the generated branches of `addParallelForEach`). Both call
 * this function, so a chart comes out identical either way — until 9.36.0 they
 * were two byte-twin copies, pinned against drift by
 * `test/lib/engine/branch-segment-prefixer-equivalence.test.ts`, which now
 * guards the one implementation.
 *
 * Generated branch segments (`<stageId>~<index>`, see `ids/branchSegment.ts`)
 * ride this exact path with no special case: a segment is just a prefix, so a
 * branch's inner ids become `<segment>/<id>` and its stages address as
 * `<segment>/<id>#<n>`.
 *
 * Never refuses: the ids it writes carry `/` on purpose. The refusal of
 * reserved characters is the builder's, at its id doors (`refuseReservedId`).
 *
 * `branchId` is left UNPREFIXED — decider/selector matching reads
 * `child.branchId ?? child.id`. The input is never mutated (each node is a
 * shallow clone).
 */

import { joinPath } from '../../ids/runtimeStageId.js';
import type { StageNode } from './StageNode.js';

export function prefixNodeTree<N extends StageNode<any, any>>(node: N, prefix: string): N {
  if (!node) return node;
  const clone: N = { ...node };
  clone.name = joinPath(prefix, node.name);
  clone.id = joinPath(prefix, node.id);
  if (clone.subflowId) clone.subflowId = joinPath(prefix, clone.subflowId);
  if (clone.next) clone.next = prefixNodeTree(clone.next, prefix);
  if (clone.children) clone.children = clone.children.map((c) => prefixNodeTree(c, prefix));
  return clone;
}
