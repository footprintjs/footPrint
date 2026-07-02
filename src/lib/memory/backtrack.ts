/**
 * backtrack.ts — Backward causal chain analysis on the commit log.
 *
 * Implements **backward program slicing** (Weiser 1984, thin-slice variant):
 * given a starting execution step, walk backwards through read→write
 * dependencies to build the causal DAG that produced the data at that step.
 *
 * ## Algorithm
 *
 * BFS on the implicit dependency graph where edges run from reader → writer.
 *
 * 1. Locate startId in commitLog → root node
 * 2. Get keysRead for root via `getKeysRead` callback
 * 3. For each key read, find who last wrote it before this step → parent commit
 * 4. Create parent CausalNode, link to root.parents
 * 5. Enqueue parent. Repeat until queue empty or limits hit.
 *
 * Output is a **DAG** (not a linked list): a stage reading `creditScore` AND `dti`
 * from different writers has two parents.
 *
 * ## Staged Optimization
 *
 * Two writer-lookup strategies, chosen automatically by commit log size:
 *
 * | Strategy | When | Complexity per lookup |
 * |----------|------|----------------------|
 * | Linear scan | N ≤ 256 | O(N) — simple backward scan |
 * | Reverse index | N > 256 | O(K log N) — prebuilt key→[indices], binary search |
 *
 * The threshold (256) is chosen so the O(N) build cost of the reverse index
 * is amortized over the BFS traversal. Below 256, linear scan wins because
 * there's no index build overhead. The consumer never sees this — `causalChain()`
 * picks the right strategy internally (like a query optimizer choosing between
 * sequential scan vs index scan based on table size).
 *
 * ## Complexity
 *
 * - **Small logs (N ≤ 256):** O(V × K × N) total. V=visited, K=avg keys/node.
 * - **Large logs (N > 256):** O(N × U) index build + O(V × K × log N) lookups.
 *   U = unique keys. Amortized over all BFS hops.
 *
 * ## References
 *
 * - Weiser, M. (1984). "Program Slicing." IEEE TSE.
 * - Sridharan, M. et al. (2007). "Thin Slicing." PLDI.
 *
 * @example
 * ```typescript
 * import { causalChain, flattenCausalDAG, formatCausalChain } from 'footprintjs/trace';
 *
 * const dag = causalChain(commitLog, 'decide#2', (id) => recorder.getKeysRead(id));
 * const flat = flattenCausalDAG(dag);     // BFS-ordered flat list
 * console.log(formatCausalChain(dag));     // human-readable
 * ```
 */

import { isDevMode } from '../scope/detectCircular.js';
import { findLastWriter } from './commitLogUtils.js';
import type { CommitBundle, UntrackedSource } from './types.js';

// ── Types ──────────────────────────────────────────────────────────────

/** A single node in the causal DAG. */
export interface CausalNode {
  /** Unique execution step identifier. */
  runtimeStageId: string;
  /** Stable stage identifier. */
  stageId: string;
  /** Human-readable stage name. */
  stageName: string;
  /** Keys this stage wrote (from its CommitBundle.trace). */
  keysWritten: string[];
  /** The key whose read→write dependency linked this node to its child. Empty for the root. */
  linkedBy: string;
  /** BFS depth from the starting node (0 = start). */
  depth: number;
  /**
   * Parent nodes — stages this node depends on. DAG: multiple parents
   * possible. KEPT for compatibility; with the `controlDeps` option
   * (RFC-003 D3) governing deciders appear here too. For typed/keyed/
   * weighted detail use {@link parentEdges}.
   */
  parents: CausalNode[];
  /**
   * RFC-003 D3 — one edge per dependency LINK (not per parent): a node
   * reading two keys from the same writer has ONE entry in {@link parents}
   * but TWO `'data'` edges here. Control dependencies (via the
   * `controlDeps` option) add a `'control'` edge to the governing decider.
   */
  parentEdges: CausalEdge[];
  /**
   * RFC-003 D2 honesty marker — stamped from the stage's
   * `CommitBundle.untrackedSources`. Present when this stage ALSO consumed
   * untracked read paths (`args` / `env` / unshadowed `silent` reads): the
   * backward slice through this node may be incomplete, because those reads
   * produce no read→write edge to follow. `formatCausalChain` renders this
   * as a `⚠ … slice may be incomplete here` line. Absent when the stage's
   * reads were fully tracked.
   */
  incompleteSources?: ReadonlyArray<UntrackedSource>;
  /**
   * RFC-003 D4 truncation visibility — set on the ROOT node only, and only
   * when a limit actually cut the slice: `byDepth` when a node at the
   * `maxDepth` horizon still had edges to expand, `byNodes` when the
   * `maxNodes` budget blocked creating a discovered parent. Absent when the
   * slice is complete. Dev mode (`enableDevMode()`) also warns on
   * truncation, and `formatCausalChain` appends a `⚠ slice truncated …`
   * line — a consumer must never mistake a truncated slice for a full one.
   */
  truncated?: { byDepth: boolean; byNodes: boolean };
}

/**
 * RFC-003 D3 — a typed dependency edge from a child node to one parent.
 *
 * - `kind: 'data'`    — read→write dependency; `key` is the state key.
 * - `kind: 'control'` — the parent is the decider/selector whose decision
 *   allowed the child to run; `key` is the decide() rule label when present.
 *
 * `weight` defaults to 1.0; the `weigh` hook (RFC-003 D4) can override it.
 * The engine itself NEVER computes weights — semantics belong to the
 * consumer-injected weigher.
 */
export interface CausalEdge {
  parent: CausalNode;
  kind: 'data' | 'control';
  key?: string;
  weight: number;
}

/**
 * RFC-003 D3 — a control dependency resolved for one execution step:
 * which decider/selector execution allowed this stage to run.
 */
export interface ControlDependency {
  /** runtimeStageId of the governing decider/selector execution step. */
  deciderId: string;
  /** The decide() rule label for the chosen branch, when present. */
  label?: string;
}

/**
 * RFC-003 D3 — callback resolving the governing decider for an execution
 * step. Return `undefined` when the step is not control-dependent on any
 * recorded decision. Build one with `controlDepRecorder()` from
 * `footprintjs/trace`, or supply your own.
 */
export type ControlDepLookup = (runtimeStageId: string) => ControlDependency | undefined;

/**
 * RFC-003 D4 — consumer-injected edge weigher. Called once per created
 * edge; return a weight, or `undefined` to keep the default 1.0. The
 * ENGINE never computes weights (zero new dependencies — semantics like
 * embedding similarity or FDL influence belong to downstream libraries,
 * the same plug-in pattern as `NarrativeFormatter`). Weights render in
 * `formatCausalChain` as `← via systemPrompt (0.18)`.
 */
export type EdgeWeigher = (
  child: CausalNode,
  parent: CausalNode,
  key: string | undefined,
  kind: 'data' | 'control',
) => number | undefined;

/** Options for causalChain(). */
export interface CausalChainOptions {
  /** Maximum BFS depth (default: 20). Prevents runaway traversal. */
  maxDepth?: number;
  /** Maximum total nodes to visit (default: 100). Hard cap for safety. */
  maxNodes?: number;
  /**
   * RFC-003 D3 — control-dependence lookup. When provided, expanding a node
   * ALSO links a `'control'` edge to its governing decider (labeled by the
   * decide() rule label when present); the decider node then expands
   * normally through its own data reads, so chains like
   * `status ← [control] ClassifyRisk ← [data: creditScore] PullBureau`
   * resolve end-to-end. Without this option behavior is unchanged.
   */
  controlDeps?: ControlDepLookup;
  /**
   * RFC-003 D4 — edge weigher. Stamps `CausalEdge.weight` at edge creation;
   * `undefined` (or no weigher) → 1.0. See {@link EdgeWeigher}.
   */
  weigh?: EdgeWeigher;
  /**
   * #P1 — how a node's expansion read-set is derived:
   *
   * - `'stage'` (default, historical) — every visited node expands through
   *   ALL of its stage's reads (`getKeysRead`). A stage reading `a,b` and
   *   writing `x,y` links both reads as causes of both writes — a sound but
   *   coarse over-approximation.
   * - `'per-write'` — when the commit log carries per-write read provenance
   *   (`TraceEntry.readKeys`, recorded under the executor's
   *   `writeProvenance: 'reads-prefix'` dial), a node reached via key `k`
   *   expands through ONLY the reads that preceded its write of `k`
   *   (temporal prefix). Nodes linked later via additional keys are
   *   incrementally re-expanded with just the new reads (worklist — the
   *   slice only ever GROWS toward the stage-level ceiling). HONEST
   *   FALLBACK: any link whose trace entry lacks `readKeys` expands that
   *   node at stage level — mixed or dial-off logs degrade to `'stage'`
   *   behavior exactly, never to silence.
   */
  edgeAttribution?: 'stage' | 'per-write';
  /**
   * #P1 — the written keys that anchor the ROOT's expansion under
   * `'per-write'` (e.g. `sliceForKey` passes the sliced key, so the root
   * expands through the reads that fed THAT write, not the whole stage).
   * Ignored under `'stage'`. Unset → root expands at stage level.
   */
  rootLinkKeys?: string[];
}

/**
 * Callback that returns the keys a stage read during execution.
 * The backtracker calls this for each visited node to determine
 * which read→write edges to follow.
 *
 * Implementors: QualityRecorder tracks keysRead per step,
 * or build a Map<runtimeStageId, string[]> from ScopeRecorder.onRead events.
 */
export type KeysReadLookup = (runtimeStageId: string) => string[];

// ── Staged optimization: writer lookup strategies ──────────────────────

/**
 * Threshold for switching from linear scan to reverse index.
 * Below this, O(N) scan is faster (no index build cost).
 * Above this, O(log N) binary search wins.
 */
const REVERSE_INDEX_THRESHOLD = 256;

/**
 * Writer lookup function signature.
 * Returns the CommitBundle that last wrote `key` before position `beforeIdx`.
 */
type WriterLookup = (key: string, beforeIdx: number) => CommitBundle | undefined;

/** Strategy 1: Linear scan — O(N) per lookup, zero setup cost. */
function linearScanLookup(commitLog: CommitBundle[]): WriterLookup {
  return (key, beforeIdx) => findLastWriter(commitLog, key, beforeIdx);
}

/**
 * Strategy 2: Reverse index — O(N×U) build, O(log N) per lookup.
 * Builds a Map<key, sortedIndices[]> where indices are commit positions
 * that wrote that key. Lookup uses binary search to find the last writer
 * before a given position.
 */
function reverseIndexLookup(commitLog: CommitBundle[]): WriterLookup {
  // Build: key → sorted array of commit indices that wrote this key
  const index = new Map<string, number[]>();
  for (let i = 0; i < commitLog.length; i++) {
    for (const t of commitLog[i].trace) {
      let arr = index.get(t.path);
      if (!arr) {
        arr = [];
        index.set(t.path, arr);
      }
      arr.push(i); // already sorted (we iterate in order)
    }
  }

  return (key: string, beforeIdx: number): CommitBundle | undefined => {
    const indices = index.get(key);
    if (!indices || indices.length === 0) return undefined;

    // Binary search: find largest index < beforeIdx
    let lo = 0;
    let hi = indices.length - 1;
    let result = -1;

    while (lo <= hi) {
      const mid = (lo + hi) >>> 1;
      if (indices[mid] < beforeIdx) {
        result = indices[mid];
        lo = mid + 1;
      } else {
        hi = mid - 1;
      }
    }

    return result >= 0 ? commitLog[result] : undefined;
  };
}

/**
 * Staged optimization: pick the right writer-lookup strategy based on data size.
 *
 * Like a database query optimizer choosing between sequential scan and index scan:
 *
 * - **Small log (≤ 256):** Linear scan wins. Zero setup cost, good cache locality.
 *   The overhead of building a reverse index isn't worth it for short logs.
 *
 * - **Large log (> 256):** Reverse index wins. O(N×U) upfront build cost is amortized
 *   across all BFS hops. Each lookup becomes O(log N) via binary search instead of O(N).
 *   For an agent loop with 500 iterations and 5 keys per hop, this is 500×5×log(500)≈22K ops
 *   vs 500×5×500=1.25M ops with linear scan.
 *
 * The caller never sees this — `causalChain()` picks automatically.
 */
function createWriterLookup(commitLog: CommitBundle[]): WriterLookup {
  if (commitLog.length <= REVERSE_INDEX_THRESHOLD) {
    return linearScanLookup(commitLog);
  }
  return reverseIndexLookup(commitLog);
}

// ── Core algorithm ─────────────────────────────────────────────────────

/**
 * RFC-003 D2: the `incompleteSources` node fragment for a commit — `{}`
 * when the stage consumed no untracked read paths, keeping the field
 * ABSENT (not empty-array-valued) for fully-tracked stages.
 */
function incompleteSourcesFragment(commit: CommitBundle): { incompleteSources?: ReadonlyArray<UntrackedSource> } {
  if (!commit.untrackedSources || commit.untrackedSources.length === 0) return {};
  return { incompleteSources: commit.untrackedSources };
}

/**
 * Build the causal DAG rooted at `startId` by walking backwards
 * through read→write dependencies in the commit log.
 *
 * Automatically selects the optimal writer lookup strategy:
 * - Linear scan for small logs (≤ 256 commits)
 * - Reverse index with binary search for large logs (> 256 commits)
 *
 * Produces a DAG (not a tree): if two children both read from the same
 * parent, the parent node is shared (deduped by runtimeStageId).
 *
 * @param commitLog   Ordered commit bundles from executor.getSnapshot().commitLog
 * @param startId     runtimeStageId to start backtracking from
 * @param getKeysRead Callback returning keys read by a given execution step
 * @param options     Depth and node limits
 * @returns Root CausalNode with .parents forming the DAG, or undefined if startId not found
 */
export function causalChain(
  commitLog: CommitBundle[],
  startId: string,
  getKeysRead: KeysReadLookup,
  options?: CausalChainOptions,
): CausalNode | undefined {
  const maxDepth = options?.maxDepth ?? 20;
  const maxNodes = options?.maxNodes ?? 100;
  const controlDeps = options?.controlDeps;
  const weigh = options?.weigh;
  const perWrite = options?.edgeAttribution === 'per-write';

  // RFC-003 D4 — truncation visibility. Set only when a limit actually
  // cuts the slice; surfaced on the root as `truncated` so a consumer can
  // never mistake a truncated slice for a complete one.
  let truncatedByDepth = false;
  let truncatedByNodes = false;

  // Build position index: runtimeStageId → array position (O(n) once)
  const idxMap = new Map<string, number>();
  for (let i = 0; i < commitLog.length; i++) {
    idxMap.set(commitLog[i].runtimeStageId, i);
  }

  const startIdx = idxMap.get(startId);
  if (startIdx === undefined) return undefined;

  const startCommit = commitLog[startIdx];

  // Pick writer lookup strategy based on log size
  const findWriter = createWriterLookup(commitLog);

  // Node dedup map: runtimeStageId → CausalNode (ensures DAG, not tree)
  const nodeMap = new Map<string, CausalNode>();

  const root: CausalNode = {
    runtimeStageId: startId,
    stageId: startCommit.stageId,
    stageName: startCommit.stage,
    keysWritten: startCommit.trace.map((t) => t.path),
    linkedBy: '',
    depth: 0,
    parents: [],
    parentEdges: [],
    ...incompleteSourcesFragment(startCommit),
  };
  nodeMap.set(startId, root);

  // ── #P1 per-write attribution machinery (inert under 'stage') ──────────
  // expandedReads: per node, the reads already queued for expansion — late
  // links via additional keys re-enqueue only the DELTA, so the slice grows
  // monotonically toward the stage-level ceiling and terminates (each key
  // expands at most once per node). fullyExpanded: nodes that fell back to
  // stage level (no readKeys on a linking entry) — nothing left to add.
  const expandedReads = new Map<string, Set<string>>();
  const fullyExpanded = new Set<string>();

  /**
   * Resolve a node's expansion read-set for the given linking WRITTEN keys.
   * Per-write mode with provenance present → union of the linking writes'
   * temporal-prefix `readKeys`. Any linking entry WITHOUT `readKeys` (or no
   * linkKeys at all) → honest stage-level fallback, flagged via the second
   * tuple member so the caller marks the node fully expanded.
   */
  function readsForLinks(commit: CommitBundle, linkKeys: string[] | undefined): [string[], boolean] {
    if (!perWrite || !linkKeys || linkKeys.length === 0) {
      return [getKeysRead(commit.runtimeStageId), true];
    }
    const union = new Set<string>();
    for (const linkKey of linkKeys) {
      const entry = commit.trace.find((t) => t.path === linkKey);
      if (!entry || entry.readKeys === undefined) {
        // Mixed/dial-off log — degrade THIS node to stage level, honestly.
        return [getKeysRead(commit.runtimeStageId), true];
      }
      for (const rk of entry.readKeys) union.add(rk);
    }
    return [[...union], false];
  }

  // BFS/worklist queue: [node, commitIdx, depth, keysToExpand]
  const [rootReads, rootIsFull] = perWrite
    ? readsForLinks(startCommit, options?.rootLinkKeys)
    : [getKeysRead(startId), true];
  expandedReads.set(startId, new Set(rootReads));
  if (rootIsFull) fullyExpanded.add(startId);
  const queue: Array<[CausalNode, number, number, string[]]> = [[root, startIdx, 0, rootReads]];
  let visited = 1;

  /**
   * Link `node → parent` (creating + enqueueing the parent when new).
   * Shared by data-edge expansion (read→write) and control-edge expansion
   * (D3). One CausalEdge per distinct (parent, kind, key) link; `parents`
   * keeps its historical one-entry-per-parent dedup.
   */
  function linkParent(
    node: CausalNode,
    parentCommit: CommitBundle,
    kind: 'data' | 'control',
    key: string | undefined,
    depth: number,
  ): void {
    const parentId = parentCommit.runtimeStageId;
    // #P1: the parent's expansion reads, resolved LAZILY (only for new nodes
    // or per-write re-expansion — duplicate links under 'stage' pay nothing).
    // Data links expand through the reads that fed the parent's write of
    // `key`; control links expand the decider at stage level (a decision
    // depends on everything it read).
    const resolveLinkReads = (): [string[], boolean] =>
      kind === 'data'
        ? readsForLinks(parentCommit, key !== undefined ? [key] : undefined)
        : [getKeysRead(parentId), true];

    let parentNode = nodeMap.get(parentId);
    if (!parentNode) {
      // New node — create and enqueue (respecting the node budget)
      if (visited >= maxNodes) {
        truncatedByNodes = true; // D4: a discovered parent was dropped
        return;
      }

      const parentIdx = idxMap.get(parentId);
      if (parentIdx === undefined) return;

      parentNode = {
        runtimeStageId: parentId,
        stageId: parentCommit.stageId,
        stageName: parentCommit.stage,
        keysWritten: parentCommit.trace.map((t) => t.path),
        // linkedBy stays a DATA-key concept (back-compat) — control-linked
        // nodes carry their label on the edge instead.
        linkedBy: kind === 'data' ? key ?? '' : '',
        depth: depth + 1,
        parents: [],
        parentEdges: [],
        ...incompleteSourcesFragment(parentCommit),
      };
      nodeMap.set(parentId, parentNode);
      visited++;
      const [linkReads, linkIsFull] = resolveLinkReads();
      expandedReads.set(parentId, new Set(linkReads));
      if (linkIsFull) fullyExpanded.add(parentId);
      queue.push([parentNode, parentIdx, depth + 1, linkReads]);
    } else if (perWrite && !fullyExpanded.has(parentId)) {
      // #P1 worklist: an EXISTING node linked via another key may owe more
      // expansion — enqueue only the reads not yet expanded (monotone; the
      // node budget is untouched, no node is created). Re-expansion keeps
      // the node's ORIGINAL depth so its parents get a consistent depth+1.
      const [linkReads, linkIsFull] = resolveLinkReads();
      const expanded = expandedReads.get(parentId)!;
      const delta = linkReads.filter((k) => !expanded.has(k));
      if (linkIsFull) fullyExpanded.add(parentId);
      if (delta.length > 0) {
        for (const k of delta) expanded.add(k);
        const parentIdx = idxMap.get(parentId);
        if (parentIdx !== undefined) queue.push([parentNode, parentIdx, parentNode.depth, delta]);
      }
    }

    // DAG merge: one parents[] entry per distinct parent (historical shape)
    if (!node.parents.some((p) => p.runtimeStageId === parentId)) {
      node.parents.push(parentNode);
    }
    // One edge per distinct (parent, kind, key) link. The weigher (D4)
    // stamps the weight at creation; `undefined` → 1.0 — the engine never
    // computes weights itself.
    if (!node.parentEdges.some((e) => e.parent.runtimeStageId === parentId && e.kind === kind && e.key === key)) {
      // Error isolation (review finding): a consumer weigher that throws
      // must degrade to the default weight, never crash the slice — the
      // same contract every other consumer callback in the library gets.
      let weight = 1.0;
      if (weigh) {
        try {
          weight = weigh(node, parentNode, key, kind) ?? 1.0;
        } catch {
          /* weigher threw — keep 1.0, the slice stays usable */
        }
      }
      node.parentEdges.push({ parent: parentNode, kind, key, weight });
    }
  }

  while (queue.length > 0) {
    const [node, commitIdx, depth, keysToExpand] = queue.shift()!;

    if (depth >= maxDepth) {
      // D4: only a node that still HAD something to expand counts as a cut
      // (a leaf at the horizon truncates nothing).
      if (keysToExpand.length > 0 || controlDeps?.(node.runtimeStageId) !== undefined) {
        truncatedByDepth = true;
      }
      continue;
    }

    // Data edges: for each key in this expansion's read-set, find who wrote
    // it. Under 'stage' this is the node's full read-set (historical
    // behavior); under 'per-write' it is the linking writes' temporal prefix
    // (or a worklist delta on re-expansion).
    const keysRead = keysToExpand;
    for (const key of keysRead) {
      const writer = findWriter(key, commitIdx);
      if (!writer) continue;
      linkParent(node, writer, 'data', key, depth);
    }

    // Control edge (RFC-003 D3): link the governing decider, labeled by the
    // decide() rule label when present. The decider node then expands
    // normally through its own data reads (and its own control parent).
    if (controlDeps) {
      const dep = controlDeps(node.runtimeStageId);
      if (dep) {
        const deciderIdx = idxMap.get(dep.deciderId);
        if (deciderIdx !== undefined) {
          linkParent(node, commitLog[deciderIdx], 'control', dep.label, depth);
        }
      }
    }
  }

  // RFC-003 D4 — truncation visibility on the root (absent when complete).
  if (truncatedByDepth || truncatedByNodes) {
    root.truncated = { byDepth: truncatedByDepth, byNodes: truncatedByNodes };
    if (isDevMode()) {
      // eslint-disable-next-line no-console
      console.warn(
        `[footprint] causalChain('${startId}') truncated by ` +
          `${[truncatedByDepth && `maxDepth (${maxDepth})`, truncatedByNodes && `maxNodes (${maxNodes})`]
            .filter(Boolean)
            .join(' + ')} — the slice is incomplete. Raise the limits or narrow keysRead.`,
      );
    }
  }

  return root;
}

// ── Utilities ──────────────────────────────────────────────────────────

/**
 * Flatten the causal DAG into a BFS-ordered list of nodes.
 * Each node appears exactly once (first occurrence by BFS order).
 * Useful for linear display or iteration.
 */
export function flattenCausalDAG(root: CausalNode): CausalNode[] {
  const result: CausalNode[] = [];
  const visited = new Set<string>();
  const queue: CausalNode[] = [root];

  while (queue.length > 0) {
    const node = queue.shift()!;
    if (visited.has(node.runtimeStageId)) continue;
    visited.add(node.runtimeStageId);
    result.push(node);

    for (const parent of node.parents) {
      if (!visited.has(parent.runtimeStageId)) {
        queue.push(parent);
      }
    }
  }

  return result;
}

/**
 * Format a causal DAG as human-readable indented text.
 * Shows the dependency chain with depth indentation and linked-by keys.
 *
 * RFC-003 D2: nodes that consumed untracked read paths render an extra
 * `⚠ also consumed … — slice may be incomplete here` line, so a consumer
 * (human or LLM) debugging from the slice is TOLD when it is incomplete.
 *
 * RFC-003 D3: control edges render as `← [control: <rule label>]`
 * (label omitted when the decision carried none). Data rendering is
 * byte-identical to the pre-D3 output — `← via <key>` from the node's
 * discovery-time `linkedBy`.
 *
 * RFC-003 D4: edge weights from the `weigh` hook render as a suffix —
 * `← via systemPrompt (0.18)` — only when ≠ 1.0, so unweighted output is
 * unchanged. A truncated slice (root.truncated) appends a final
 * `⚠ slice truncated …` line.
 */
export function formatCausalChain(root: CausalNode): string {
  const lines: string[] = [];
  const visited = new Set<string>();

  const weightSuffix = (edge: CausalEdge | undefined): string =>
    edge !== undefined && edge.weight !== 1 ? ` (${edge.weight})` : '';

  function walk(node: CausalNode, indent: number, edgesFromChild?: CausalEdge[]): void {
    if (visited.has(node.runtimeStageId)) {
      lines.push(`${'  '.repeat(indent)}↳ ${node.runtimeStageId} (see above)`);
      return;
    }
    visited.add(node.runtimeStageId);

    const linkParts: string[] = [];
    if (node.linkedBy) {
      const dataEdge = edgesFromChild?.find((e) => e.kind === 'data');
      linkParts.push(`via ${node.linkedBy}${weightSuffix(dataEdge)}`);
    }
    const controlEdge = edgesFromChild?.find((e) => e.kind === 'control');
    if (controlEdge) {
      linkParts.push(`[control${controlEdge.key ? `: ${controlEdge.key}` : ''}]${weightSuffix(controlEdge)}`);
    }
    const link = linkParts.length > 0 ? ` ← ${linkParts.join(' ← ')}` : '';

    const writes = node.keysWritten.length > 0 ? ` [wrote: ${node.keysWritten.join(', ')}]` : '';
    lines.push(`${'  '.repeat(indent)}${node.stageName} (${node.runtimeStageId})${link}${writes}`);

    if (node.incompleteSources && node.incompleteSources.length > 0) {
      lines.push(
        `${'  '.repeat(indent + 1)}⚠ also consumed ${node.incompleteSources.join('/')} — slice may be incomplete here`,
      );
    }

    for (const parent of node.parents) {
      walk(
        parent,
        indent + 1,
        node.parentEdges.filter((e) => e.parent === parent),
      );
    }
  }

  walk(root, 0);

  if (root.truncated) {
    const causes = [root.truncated.byDepth && 'maxDepth reached', root.truncated.byNodes && 'maxNodes reached']
      .filter(Boolean)
      .join(', ');
    lines.push(`⚠ slice truncated (${causes}) — older causes exist beyond this horizon`);
  }

  return lines.join('\n');
}

// ── Exported for testing (internal) ────────────────────────────────────

/** @internal Exposed for testing the strategy selection. */
export const _REVERSE_INDEX_THRESHOLD = REVERSE_INDEX_THRESHOLD;
