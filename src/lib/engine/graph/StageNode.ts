/**
 * StageNode — The graph node type for flowchart traversal.
 *
 * Defines the shape of each node in the flowchart DAG:
 * - Linear continuation via `next` (linked list traversal)
 * - Parallel fan-out via `children` (fork)
 * - Conditional branching via `deciderFn` (single-choice) or `selectorFn` (multi-choice)
 * - Back-edges via dynamic next (loop)
 * - Isolated sub-traversals via `isSubflowRoot` (subflow)
 */

import type { StageFunction, SubflowMountOptions } from '../types.js';

// ---------------------------------------------------------------------------
// Decider + Selector
// ---------------------------------------------------------------------------

/** Picks exactly ONE child by ID. Conditional branch (if/switch). */
export type Decider = (nodeArgs: any) => string | Promise<string>;

/**
 * Picks ONE OR MORE children by ID. Filtered fan-out.
 * - Single string: behaves like Decider
 * - Array: selected children execute in parallel
 * - Empty array: skip all children
 */
export type Selector = (nodeArgs: any) => string | string[] | Promise<string | string[]>;

// ---------------------------------------------------------------------------
// StageNode
// ---------------------------------------------------------------------------

export type StageNode<TOut = any, TScope = any> = {
  /** Human-readable stage name; also used as the stageMap key */
  name: string;
  /** Stable identifier for visualization matching and branch aggregation. */
  id: string;
  /** Description of what this stage does. Used for narrative and tool descriptions. */
  description?: string;

  // ── Continuation pointers ──

  /** Linear continuation (linked list next pointer) */
  next?: StageNode<TOut, TScope>;
  /** Parallel children (fork fan-out) */
  children?: StageNode<TOut, TScope>[];

  // ── Branching ──

  /** Output-based selector: picks subset of children */
  nextNodeSelector?: Selector;
  /** When true, fn IS a scope-based decider that returns a branch ID string */
  deciderFn?: boolean;
  /** When true, fn IS a scope-based selector that returns branch ID(s) */
  selectorFn?: boolean;

  // ── Stage function ──

  /** Embedded function; otherwise resolved from stageMap by `name` */
  fn?: StageFunction<TOut, TScope>;

  // ── Streaming ──

  /** When true, Pipeline injects a streamCallback as 3rd parameter */
  isStreaming?: boolean;
  /** Unique stream identifier for routing tokens */
  streamId?: string;

  // ── Subflow ──

  /** True if this is the root node of a mounted subflow */
  isSubflowRoot?: boolean;
  /** Mount id of the subflow (e.g., "llm-core") */
  subflowId?: string;
  /** Display name of the subflow */
  subflowName?: string;
  /** Reference key into the subflows dictionary */
  $ref?: string;
  /** Unique identifier for this mount instance */
  mountId?: string;
  /** Input/output mapping options for subflows */
  subflowMountOptions?: SubflowMountOptions;
  /** When true, parallel children use fail-fast semantics (reject on first error) */
  failFast?: boolean;

  /** True if this node is a back-edge reference created by loopTo() */
  isLoopRef?: boolean;

  /** Inline subflow definition for dynamic subflow attachment.
   *  When `root` is omitted, the subflow is structural-only:
   *  the engine attaches `buildTimeStructure` for visualization
   *  without executing any subflow stages (pre-executed subflow pattern). */
  subflowDef?: {
    root?: StageNode;
    stageMap?: Map<string, StageFunction<TOut, TScope>>;
    buildTimeStructure?: unknown;
    subflows?: Record<string, { root: StageNode }>;
  };

  /** Lazy subflow resolver — called on first execution to obtain the FlowChart.
   *  Used by `addLazySubFlowChartBranch()` to defer tree cloning until needed.
   *  The resolver is called at most once per execution; the result replaces this field. */
  subflowResolver?: () => {
    root: StageNode;
    stageMap: Map<string, StageFunction>;
    buildTimeStructure?: unknown;
    subflows?: Record<string, { root: StageNode }>;
  };
};

// ---------------------------------------------------------------------------
// isStageNodeReturn — duck-typing detection for dynamic continuation
// ---------------------------------------------------------------------------

/**
 * Detects if a stage output is a StageNode for dynamic continuation.
 *
 * Uses duck-typing: must have `name` (string) AND at least one continuation
 * property (non-empty children, next, nextNodeSelector, or isSubflowRoot).
 *
 * `isSubflowRoot` counts as continuation because subflow execution (or
 * structural annotation for pre-executed subflows) is a form of continuation.
 *
 * Safely handles proxy objects (e.g., Zod scope) that may throw on property access.
 */
export function isStageNodeReturn(output: unknown): output is StageNode {
  if (!output || typeof output !== 'object') return false;

  try {
    const obj = output as Record<string, unknown>;
    if (typeof obj.name !== 'string') return false;

    const hasContinuation =
      (Array.isArray(obj.children) && obj.children.length > 0) ||
      obj.next !== undefined ||
      typeof obj.nextNodeSelector === 'function' ||
      obj.isSubflowRoot === true;

    return hasContinuation;
  } catch {
    return false;
  }
}
