/**
 * walkSubflowSpec — yield the structural shape of a subflow spec as a
 * flat ordered stream of items, with `subflowPath` already composed
 * for nested subflows.
 *
 * This is the public contract for traversing the structure delivered
 * via `StructureSubflowMountedEvent.subflowSpec`. Item shapes mirror
 * the corresponding Structure event payloads so consumers can route
 * walker items through the same handlers they use for live events.
 *
 * Walker contract (LOCKED):
 *   1. AUTO-RECURSE by default into nested subflows, with composed
 *      paths (`parent/child/...`). Pass `{ recurse: false }` to walk
 *      only one level.
 *   2. ENTRY-STAGE MARKER FIRST: for each subflow (top-level and
 *      nested), yields a `{ kind: 'subflow-start', ... }` item BEFORE
 *      any stage/edge items from that subflow. Lets consumers draw the
 *      boundary edge from the mount node to the entry stage.
 *   3. COMPOSED PATHS: nested subflows get `parentPath + '/' + localId`.
 *      Top-level mount paths are local-only (`'auth'`, NOT `'__root__/auth'`).
 *   4. SHAPE MIRRORING: stage/edge/loop items have the same payload
 *      shape as Structure events, with `subflowPath` added.
 *   5. SOURCE DISCRIMINATOR: every walker item carries `source: 'walker'`
 *      (Structure events do NOT). Lets consumers distinguish event vs
 *      walker in logs/debuggers while still sharing handler code paths.
 *   6. STAGE-ID PREFIXING: stage IDs in nested subflows are already
 *      prefixed by the spec (e.g. `'auth/verify/check'`). Walker
 *      preserves this; `subflowPath` field is redundant-but-explicit.
 */

import type { SerializedPipelineStructure } from '../builder/types.js';

export interface WalkerOptions {
  /** Auto-recurse into nested subflows (default: true). When false,
   *  nested subflow items are yielded but their internals are not
   *  traversed. */
  recurse?: boolean;
}

export type WalkerItem =
  | {
      kind: 'subflow-start';
      stageId: string;
      subflowPath: string;
      source: 'walker';
    }
  | {
      kind: 'stage';
      stageId: string;
      name: string;
      type: NonNullable<SerializedPipelineStructure['type']>;
      isPausable?: boolean;
      spec: SerializedPipelineStructure;
      subflowPath: string;
      source: 'walker';
    }
  | {
      kind: 'edge';
      from: string;
      to: string;
      edgeKind: 'next' | 'fork-branch' | 'decision-branch';
      label?: string;
      subflowPath: string;
      source: 'walker';
    }
  | {
      kind: 'loop';
      from: string;
      to: string;
      subflowPath: string;
      source: 'walker';
    }
  | {
      kind: 'subflow';
      mountStageId: string;
      subflowId: string;
      subflowName: string;
      subflowSpec: SerializedPipelineStructure;
      subflowPath: string;
      source: 'walker';
    };

/**
 * Walk a subflow spec, yielding its structure as flat ordered items.
 *
 * @example
 * ```ts
 * import { walkSubflowSpec } from 'footprintjs/trace';
 *
 * onSubflowMounted(event) {
 *   if (!event.subflowSpec) return; // lazy mount — no spec yet
 *   for (const item of walkSubflowSpec(event.subflowSpec, event.subflowPath)) {
 *     switch (item.kind) {
 *       case 'subflow-start': break;        // entry boundary
 *       case 'stage':         break;        // inner stage
 *       case 'edge':          break;        // inner edge
 *       case 'loop':          break;        // inner loop back-edge
 *       case 'subflow':       break;        // nested mount marker
 *     }
 *   }
 * }
 * ```
 */
export function* walkSubflowSpec(
  spec: SerializedPipelineStructure,
  subflowPath: string,
  options: WalkerOptions = {},
): Generator<WalkerItem, void, void> {
  const recurse = options.recurse !== false;

  // Entry marker first — consumer draws the boundary edge from this.
  yield {
    kind: 'subflow-start',
    stageId: spec.id,
    subflowPath,
    source: 'walker',
  };

  yield* walkNode(spec, subflowPath, recurse, new Set<string>());
}

function* walkNode(
  node: SerializedPipelineStructure,
  subflowPath: string,
  recurse: boolean,
  visited: Set<string>,
): Generator<WalkerItem, void, void> {
  if (visited.has(node.id)) return;
  visited.add(node.id);

  // Loop reference — yield as a loop edge from previous-in-context to
  // the target; the caller (caller of walkNode for the parent) is
  // responsible for emitting the loop edge with the correct `from`.
  // We never re-yield a stage for a loop reference.
  if (node.isLoopReference) return;

  // Nested subflow mount — yield the marker, optionally recurse.
  if (node.isSubflowRoot && node.subflowId !== undefined) {
    const nestedPath = `${subflowPath}/${node.subflowId}`;
    const nestedSpec = node.subflowStructure;
    if (nestedSpec) {
      yield {
        kind: 'subflow',
        mountStageId: node.id,
        subflowId: node.subflowId,
        subflowName: node.subflowName ?? node.subflowId,
        subflowSpec: nestedSpec,
        subflowPath: nestedPath,
        source: 'walker',
      };
      if (recurse) {
        yield* walkSubflowSpec(nestedSpec, nestedPath, { recurse });
      }
      // Fall through to next/children — the mount node still has a
      // mount-side stage representation that may have outgoing edges.
    }
  }

  // Yield the stage itself.
  yield {
    kind: 'stage',
    stageId: node.id,
    name: node.name,
    type: node.type,
    ...(node.isPausable === true && { isPausable: true }),
    spec: node,
    subflowPath,
    source: 'walker',
  };

  // A FAN-OUT (selector/fork) — every branch runs, then the node's `next`
  // runs (the join). This is engine semantics, so we always render the true
  // topology: each branch → that join, and the node's own direct → next
  // "skip" edge suppressed (flow goes fork → branches → join, never fork →
  // join directly). Deciders (ONE branch chosen, branches genuinely diverge)
  // are NOT fan-outs and are left alone. `next` must be a real stage (not a
  // loop back-edge).
  const isFanOut = node.type === 'fork' || node.hasSelector === true;
  const fanOutJoinId = isFanOut && node.next && node.next.isLoopReference !== true ? node.next.id : undefined;

  // Children (decider/selector/fork branches).
  if (node.children && node.children.length > 0) {
    const edgeKind: 'fork-branch' | 'decision-branch' = node.type === 'fork' ? 'fork-branch' : 'decision-branch';
    for (const child of node.children) {
      yield {
        kind: 'edge',
        from: node.id,
        to: child.id,
        edgeKind,
        ...(edgeKind === 'decision-branch' && child.id !== undefined && { label: child.id }),
        subflowPath,
        source: 'walker',
      };
      // Convergence edge: this branch merges into the fan-out's join stage.
      if (fanOutJoinId !== undefined) {
        yield {
          kind: 'edge',
          from: child.id,
          to: fanOutJoinId,
          edgeKind: 'next',
          subflowPath,
          source: 'walker',
        };
      }
      yield* walkNode(child, subflowPath, recurse, visited);
    }
  }

  // Linear next.
  if (node.next) {
    if (node.next.isLoopReference && node.loopTarget) {
      yield {
        kind: 'loop',
        from: node.id,
        to: node.loopTarget,
        subflowPath,
        source: 'walker',
      };
    } else {
      // Suppress the direct node → next edge when the branches already carry
      // the convergence to it (fanOutJoinId); still walk next so it's emitted.
      if (fanOutJoinId === undefined) {
        yield {
          kind: 'edge',
          from: node.id,
          to: node.next.id,
          edgeKind: 'next',
          subflowPath,
          source: 'walker',
        };
      }
      yield* walkNode(node.next, subflowPath, recurse, visited);
    }
  }
}
