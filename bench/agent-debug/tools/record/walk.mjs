/**
 * The walk back from a key's final value, through the published readers:
 * `findLastWriter` finds the step that wrote it last, `causalChain` follows
 * the reads (and the control edges of `controlDepRecorder`) back to their
 * writers, and `flattenCausalDAG` lists each step once, nearest first.
 *
 * Example: `walkBack(record, 'grandTotal')` → `{ writer: 'grand-total#17',
 * nodes: [{ id: 'grand-total#17', depth: 0, … }, { id: 'net-amount#11', depth: 1, … }, …] }`.
 */
import { causalChain, findLastWriter, flattenCausalDAG, keysReadFromExecutionTree, parseRuntimeStageId } from 'foottrace';

/** Generous limits for a program this size; a cut walk says so. */
const WALK_LIMITS = { maxDepth: 200, maxNodes: 400 };

/**
 * @typedef {object} WalkNode
 * @property {string} id runtime stage id
 * @property {string} stageId
 * @property {number} depth  fewest hops from the writer, over every edge the reader returned
 * @property {{ parent: string, kind: string, key?: string }[]} parents
 * @property {string[]} wrote keys this execution wrote
 */

/**
 * @param {import('./run-record.mjs').RunRecord} record
 * @param {string} key
 * @returns {{ writer: string, nodes: WalkNode[], truncated: boolean } | undefined}
 */
export function walkBack(record, key) {
  const { commitLog, executionTree } = record.snapshot;
  const writer = findLastWriter(commitLog, key);
  if (!writer) return undefined;
  const reads = keysReadFromExecutionTree(executionTree);
  const root = causalChain(commitLog, writer.runtimeStageId, reads.lookup, {
    controlDeps: record.control.asLookup(),
    ...WALK_LIMITS,
  });
  if (!root) return undefined;
  const flat = flattenCausalDAG(root);
  /** @type {Map<string, WalkNode>} */
  const byId = new Map();
  for (const n of flat) {
    byId.set(n.runtimeStageId, {
      id: n.runtimeStageId,
      stageId: n.stageId,
      depth: Number.POSITIVE_INFINITY,
      parents: n.parentEdges.map((e) => ({ parent: e.parent.runtimeStageId, kind: e.kind, ...(e.key !== undefined ? { key: e.key } : {}) })),
      wrote: [...(n.keysWritten ?? [])],
    });
  }
  depthsFrom(byId, writer.runtimeStageId, () => true);
  const nodes = [...byId.values()].sort((a, b) => a.depth - b.depth);
  return { writer: writer.runtimeStageId, nodes, truncated: root.truncated !== undefined };
}

/** Breadth-first hop counts from `start`, over the edges `keep` accepts. */
function depthsFrom(byId, start, keep) {
  const startNode = byId.get(start);
  if (!startNode) return;
  startNode.depth = 0;
  const queue = [startNode];
  while (queue.length > 0) {
    const node = /** @type {WalkNode} */ (queue.shift());
    for (const edge of node.parents) {
      if (!keep(node, edge)) continue;
      const parent = byId.get(edge.parent);
      if (parent && parent.depth > node.depth + 1) {
        parent.depth = node.depth + 1;
        queue.push(parent);
      }
    }
  }
}

/**
 * A control edge from a branch to the decision that chose it: the decision
 * ran immediately before the branch. Other control edges the reader returns
 * (a loop's decision under every later step) are not counted by `distance`.
 */
function isChoosingDecision(child, edge) {
  const c = parseRuntimeStageId(child.id);
  const p = parseRuntimeStageId(edge.parent);
  return c.executionIndex === p.executionIndex + 1;
}

/**
 * The fault's distance: the fewest steps on the walk back from the step that
 * wrote `key` to a run of `stepAddress`, following data reads and the
 * decision that chose a branch. 0 = the faulty step wrote the key itself.
 * @param {import('./run-record.mjs').RunRecord} record
 * @param {string} key
 * @param {string} stepAddress
 * @returns {number | undefined}
 */
export function distance(record, key, stepAddress) {
  const walk = walkBack(record, key);
  if (!walk) return undefined;
  const byId = new Map(walk.nodes.map((n) => [n.id, { ...n, depth: Number.POSITIVE_INFINITY }]));
  depthsFrom(byId, walk.writer, (child, edge) => edge.kind === 'data' || isChoosingDecision(child, edge));
  const hits = [...byId.values()].filter((n) => n.stageId === stepAddress).map((n) => n.depth);
  const best = Math.min(...hits);
  return Number.isFinite(best) ? best : undefined;
}
