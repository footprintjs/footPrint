/**
 * TopologyRecorder — composition graph built during traversal.
 *
 * The gap this fills:
 *   footprintjs fires atomic flow events (onSubflowEntry, onFork, onDecision,
 *   onLoop) but the accumulated *shape* of a run — who nests inside whom,
 *   which nodes are parallel siblings vs branches of a decision — is only
 *   visible post-run via `executor.getSnapshot()` tree-walking.
 *
 *   Streaming consumers (live UIs, in-flight debuggers) see only the event
 *   stream. Every such consumer has to rebuild subflow-stack + fork-map +
 *   decision-tracker from scratch, usually slightly wrong in different ways.
 *
 *   TopologyRecorder is the standard accumulator: one subscription to the
 *   three primitive channels, one live graph, queryable at any moment during
 *   or after a run.
 *
 * What it records — THREE node kinds for complete composition coverage:
 *   1. 'subflow'          — via onSubflowEntry (a mounted subflow boundary)
 *   2. 'fork-branch'      — via onFork (one node per child, synthesized)
 *   3. 'decision-branch'  — via onDecision (the chosen branch, synthesized)
 *
 *   When a fork-branch or decision-branch target IS ALSO a subflow, the
 *   subsequent onSubflowEntry creates a subflow CHILD of the synthetic node.
 *   The layered shape preserves both "who branched" and "what the branch ran."
 *
 *   Plain sequential stages are NOT nodes — that's StageContext's job.
 *   Topology is a graph of control-flow branching, not a full execution tree.
 *
 * Edges:
 *   One edge per traversal transition — `kind` matches the child's
 *   `incomingKind`. A consumer rendering "parallel columns" filters edges
 *   where `kind === 'fork-branch'` sharing the same `from`.
 *
 * @example
 * ```typescript
 * import { topologyRecorder } from 'footprintjs/trace';
 *
 * const topo = topologyRecorder();
 * executor.attachCombinedRecorder(topo);  // auto-routes to FlowRecorder channel
 *
 * await executor.run();
 *
 * const { nodes, edges, activeNodeId, rootId } = topo.getTopology();
 * // Consumer queries:
 * topo.getChildren('sf-parent');              // direct children (any kind)
 * topo.getByKind('fork-branch');              // all parallel branches
 * topo.getSubflowNodes();                     // only mounted subflows
 * ```
 */

import type {
  FlowDecisionEvent,
  FlowForkEvent,
  FlowLoopEvent,
  FlowRecorder,
  FlowSubflowEvent,
} from '../engine/narrative/types.js';

/** The kind of composition unit a node represents. */
export type TopologyNodeKind = 'subflow' | 'fork-branch' | 'decision-branch';

/** How the traversal reached this node — drives consumer layout decisions. */
export type TopologyIncomingKind = 'root' | 'next' | 'fork-branch' | 'decision-branch' | 'loop-iteration';

/** A composition-significant point in the graph. */
export interface TopologyNode {
  /** Unique id. Subflows use their subflowId (with `#n` suffix on re-entry).
   *  Synthetic nodes (fork-branch / decision-branch) use
   *  `fork-${runtimeStageId}-${i}` / `decision-${runtimeStageId}` form. */
  readonly id: string;
  /** What this node represents. */
  readonly kind: TopologyNodeKind;
  /** Display name. For subflows: `FlowSubflowEvent.name`. For fork-branches:
   *  the child name from `FlowForkEvent.children`. For decision-branches:
   *  the chosen name from `FlowDecisionEvent.chosen`. */
  readonly name: string;
  /** Parent node id. Undefined when this node sits at the run's top level. */
  readonly parentId?: string;
  /** Depth in the topology tree (0 = top-level). */
  readonly depth: number;
  /** How the traversal reached this node. */
  readonly incomingKind: TopologyIncomingKind;
  /** runtimeStageId at the moment the node was created. */
  readonly enteredAt: string;
  /** runtimeStageId when the corresponding subflow exited. Only meaningful
   *  for kind='subflow'; fork/decision-branch nodes are instantaneous. */
  exitedAt?: string;
  /** Kind-specific extras: forkParent, decider, rationale, description. */
  readonly metadata?: Readonly<Record<string, unknown>>;
}

/** A traversal transition between two nodes. */
export interface TopologyEdge {
  readonly from: string;
  readonly to: string;
  readonly kind: Exclude<TopologyIncomingKind, 'root'>;
  readonly at: string;
}

/** Snapshot of the composition graph. */
export interface Topology {
  readonly nodes: ReadonlyArray<TopologyNode>;
  readonly edges: ReadonlyArray<TopologyEdge>;
  /** Currently-active subflow (top of the subflow stack). Fork-branch and
   *  decision-branch nodes are instantaneous — they don't affect activeNodeId. */
  readonly activeNodeId: string | null;
  /** First node inserted. null before any composition event fires. */
  readonly rootId: string | null;
}

export interface TopologyRecorderOptions {
  /** Recorder id. Defaults to `topology-N` (auto-incremented). */
  id?: string;
}

// Correlation state: maps a pending fork/decision child name to its synthetic
// node id, so a subsequent onSubflowEntry matching that name can be nested
// under the synthetic node (rather than creating a peer).
interface PendingChild {
  nodeId: string;
  at: string;
}

let _counter = 0;

/**
 * Factory — matches the `narrative()` / `metrics()` style.
 */
export function topologyRecorder(options: TopologyRecorderOptions = {}): TopologyRecorder {
  return new TopologyRecorder(options);
}

/**
 * Stateful accumulator that watches FlowRecorder events and maintains a live
 * composition graph. Attach via `executor.attachCombinedRecorder(recorder)` —
 * footprintjs detects the `FlowRecorder` method shape and routes events.
 */
export class TopologyRecorder implements FlowRecorder {
  readonly id: string;

  private readonly nodesById = new Map<string, TopologyNode>();
  private readonly nodeOrder: string[] = [];
  private readonly edges: TopologyEdge[] = [];
  /** Stack of active SUBFLOW node ids. Fork/decision-branch nodes never push. */
  private readonly subflowStack: string[] = [];

  /** Map of childName → pending fork-branch synthetic node, consumed by
   *  the next matching `onSubflowEntry`. */
  private readonly pendingForkByName = new Map<string, PendingChild>();
  /** Pending decision-branch synthetic node, consumed by a matching entry. */
  private pendingDecision?: { name: string } & PendingChild;
  /**
   * The previous subflow that just finished, keyed by scope (parentId,
   * or '' for root). When a new subflow enters in the same scope via
   * the normal next-chained path (not fork/decision), we emit a `next`
   * edge from the previous subflow to the new one — matching how the
   * builder actually wired them: `.addSubFlowChartNext(A).addSubFlowChartNext(B)`
   * means A → B, one after the other.
   *
   * Without this, consumers only see parent→child edges (A, B, C all
   * children of their common ancestor) with no record of the actual
   * A → B → C sequential chain that ran — which is exactly what
   * TopologyRecorder is supposed to expose.
   */
  private readonly previousSubflowInScope = new Map<string, { nodeId: string; exitedAt: string }>();

  constructor(options: TopologyRecorderOptions = {}) {
    this.id = options.id ?? `topology-${++_counter}`;
  }

  // ── FlowRecorder hooks ────────────────────────────────────────────────

  onSubflowEntry(event: FlowSubflowEvent): void {
    const subflowId = event.subflowId;
    if (!subflowId) return; // Need a stable id to track.

    const enteredAt = event.traversalContext?.runtimeStageId ?? '';

    // Determine the parent: prefer a pending fork/decision match by name,
    // otherwise the current top-of-subflow-stack.
    let parentId: string | undefined;
    let incomingKind: TopologyIncomingKind;

    const pendingFork = this.pendingForkByName.get(event.name);
    if (pendingFork) {
      parentId = pendingFork.nodeId;
      incomingKind = 'next'; // Child OF a fork-branch node; the fork semantic
      // is captured by the fork-branch's own incomingKind.
      this.pendingForkByName.delete(event.name);
    } else if (this.pendingDecision && this.pendingDecision.name === event.name) {
      parentId = this.pendingDecision.nodeId;
      incomingKind = 'next';
      this.pendingDecision = undefined;
    } else {
      parentId = this.subflowStack[this.subflowStack.length - 1];
      incomingKind = parentId ? 'next' : 'root';
    }

    // Disambiguate re-entry (e.g., loop body re-enters the same subflow).
    let nodeId = subflowId;
    if (this.nodesById.has(nodeId)) {
      let n = 1;
      while (this.nodesById.has(`${subflowId}#${n}`)) n++;
      nodeId = `${subflowId}#${n}`;
    }

    const depth = parentId ? this.nodesById.get(parentId)!.depth + 1 : 0;
    const metadata = event.description ? { description: event.description } : undefined;

    const node: TopologyNode = {
      id: nodeId,
      kind: 'subflow',
      name: event.name,
      parentId,
      depth,
      incomingKind,
      enteredAt,
      metadata,
    };
    this.nodesById.set(nodeId, node);
    this.nodeOrder.push(nodeId);

    if (parentId && incomingKind !== 'root') {
      this.edges.push({
        from: parentId,
        to: nodeId,
        kind: incomingKind,
        at: enteredAt,
      });
    }

    // Next-chained edge from the PREVIOUS subflow in this scope.
    //
    // `.addSubFlowChartNext(A).addSubFlowChartNext(B).addSubFlowChartNext(C)`
    // runs as: A enters → A exits → B enters → B exits → C enters. At
    // B's entry the stack has returned to the scope it was in before A
    // entered (root, or the shared ancestor). Without this edge we'd
    // see nodes {A, B, C} but no record that A ran BEFORE B which ran
    // BEFORE C — and downstream consumers would have to reconstruct
    // sequential ordering themselves.
    //
    // Only emit on the regular-entry path. Fork/decision entries have
    // their own edge mechanics (parent→fork-branch, parent→decision-
    // branch) that carry the branching semantics.
    if (incomingKind === 'next' || incomingKind === 'root') {
      const scopeKey = parentId ?? '';
      const previous = this.previousSubflowInScope.get(scopeKey);
      if (previous) {
        this.edges.push({
          from: previous.nodeId,
          to: nodeId,
          kind: 'next',
          at: enteredAt,
        });
        this.previousSubflowInScope.delete(scopeKey);
      }
    }

    this.subflowStack.push(nodeId);
  }

  onSubflowExit(event: FlowSubflowEvent): void {
    const nodeId = this.subflowStack.pop();
    if (!nodeId) return;
    const node = this.nodesById.get(nodeId);
    const exitedAt = event.traversalContext?.runtimeStageId ?? '';
    if (node) {
      node.exitedAt = exitedAt;
      // Remember this node as the "previous subflow" in its scope.
      // Whatever subflow enters NEXT in the same scope (normal-entry
      // path, not fork/decision) gets a `next` edge drawn from here
      // — this is the real sequential A → B transition that the
      // `.addSubFlowChartNext()` builder produced.
      const scopeKey = node.parentId ?? '';
      this.previousSubflowInScope.set(scopeKey, { nodeId, exitedAt });
    }
    // Clear pendingDecision on exit — a decision identifies exactly ONE
    // target. If the chosen goes to a plain stage (not a subflow), the
    // pending entry would otherwise linger and falsely match an
    // unrelated subflow later in a different scope.
    this.pendingDecision = undefined;
    // Deliberately NOT clearing pendingForkByName — fork siblings need
    // their pending entries to survive scope exits of earlier siblings
    // (e.g. Alpha's inner sf-messages exits before Beta enters). Fork
    // pending entries are cleared on new `onFork` or consumed on match.
  }

  onFork(event: FlowForkEvent): void {
    const activeId = this.subflowStack[this.subflowStack.length - 1];
    const at = event.traversalContext?.runtimeStageId ?? '';
    const depth = activeId ? this.nodesById.get(activeId)!.depth + 1 : 0;

    // Reset any prior pending fork state — a new fork starts fresh.
    this.pendingForkByName.clear();

    event.children.forEach((childName, i) => {
      const nodeId = `fork-${at || event.parent}-${i}-${childName}`;
      const node: TopologyNode = {
        id: nodeId,
        kind: 'fork-branch',
        name: childName,
        parentId: activeId,
        depth,
        incomingKind: 'fork-branch',
        enteredAt: at,
        metadata: { forkParent: event.parent },
      };
      this.nodesById.set(nodeId, node);
      this.nodeOrder.push(nodeId);
      if (activeId) {
        this.edges.push({ from: activeId, to: nodeId, kind: 'fork-branch', at });
      }
      this.pendingForkByName.set(childName, { nodeId, at });
    });
  }

  onDecision(event: FlowDecisionEvent): void {
    const activeId = this.subflowStack[this.subflowStack.length - 1];
    const at = event.traversalContext?.runtimeStageId ?? '';
    const depth = activeId ? this.nodesById.get(activeId)!.depth + 1 : 0;

    // A new decision supersedes any prior unresolved pending one.
    this.pendingDecision = undefined;

    const nodeId = `decision-${at || event.decider}-${event.chosen}`;
    const metadata: Record<string, unknown> = { decider: event.decider };
    if (event.rationale) metadata.rationale = event.rationale;
    if (event.description) metadata.description = event.description;

    const node: TopologyNode = {
      id: nodeId,
      kind: 'decision-branch',
      name: event.chosen,
      parentId: activeId,
      depth,
      incomingKind: 'decision-branch',
      enteredAt: at,
      metadata,
    };
    this.nodesById.set(nodeId, node);
    this.nodeOrder.push(nodeId);
    if (activeId) {
      this.edges.push({ from: activeId, to: nodeId, kind: 'decision-branch', at });
    }
    this.pendingDecision = { name: event.chosen, nodeId, at };
  }

  onLoop(event: FlowLoopEvent): void {
    // loopTo jumps back inside the CURRENT subflow. Record a self-edge on the
    // active subflow — synthetic fork/decision nodes don't participate in loops.
    const activeId = this.subflowStack[this.subflowStack.length - 1];
    if (!activeId) return;
    this.edges.push({
      from: activeId,
      to: activeId,
      kind: 'loop-iteration',
      at: event.traversalContext?.runtimeStageId ?? '',
    });
  }

  /** Called by the executor before each `run()` — resets all state. */
  clear(): void {
    this.nodesById.clear();
    this.nodeOrder.length = 0;
    this.edges.length = 0;
    this.subflowStack.length = 0;
    this.pendingForkByName.clear();
    this.previousSubflowInScope.clear();
    this.pendingDecision = undefined;
  }

  // ── Query API ─────────────────────────────────────────────────────────

  /** Live snapshot of the composition graph. Safe during or after a run. */
  getTopology(): Topology {
    const nodes = this.nodeOrder.map((id) => this.nodesById.get(id)!);
    return {
      nodes,
      edges: [...this.edges],
      activeNodeId: this.subflowStack[this.subflowStack.length - 1] ?? null,
      rootId: this.nodeOrder[0] ?? null,
    };
  }

  /** Direct children of a node — insertion-ordered. */
  getChildren(nodeId: string): TopologyNode[] {
    return this.nodeOrder.map((id) => this.nodesById.get(id)!).filter((n) => n.parentId === nodeId);
  }

  /** All nodes of a given kind. */
  getByKind(kind: TopologyNodeKind): TopologyNode[] {
    return this.nodeOrder.map((id) => this.nodesById.get(id)!).filter((n) => n.kind === kind);
  }

  /** All mounted subflow nodes. Convenience for agent-centric views. */
  getSubflowNodes(): TopologyNode[] {
    return this.getByKind('subflow');
  }

  /** All fork-branch nodes sharing the same parent as `nodeId` — i.e.,
   *  parallel siblings of a parallel branch. Empty if `nodeId` isn't a
   *  fork-branch or has no parent. */
  getParallelSiblings(nodeId: string): TopologyNode[] {
    const node = this.nodesById.get(nodeId);
    if (!node || node.kind !== 'fork-branch' || !node.parentId) return [];
    return this.getChildren(node.parentId).filter((n) => n.kind === 'fork-branch');
  }

  /** Emit a snapshot bundle for inclusion in `executor.getSnapshot()`. */
  toSnapshot() {
    return {
      name: 'Topology',
      description: 'Composition graph: subflow boundaries, fork branches, decision branches',
      preferredOperation: 'translate' as const,
      data: this.getTopology(),
    };
  }
}
