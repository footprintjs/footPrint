/**
 * ResumeEntry — the resume's ONE-SHOT re-entry (M2, pause/resume).
 *
 * A resume has to get back to a stage in the middle of a chart. It does that
 * with a small synthetic structure: a stand-in for the paused stage (same id,
 * name, tags; its function is the resume half — or, for an `interrupt()`
 * pause, the stage's own function with the answer deposited), and, for a pause
 * inside subflows, the checkpoint's capture of each subflow's state on the way
 * down.
 *
 * THE LAW: that structure is used EXACTLY ONCE, for the re-entry. The stand-in
 * is where the resumed traversal STARTS (or where the leaf subflow's traversal
 * starts) — it is never a node any id can resolve to. Each subflow on the pause
 * path takes its seed and its entry point on its FIRST entry and never again.
 * After that the run belongs to the real chart: every loop target, every later
 * subflow entry (real root, inputMapper runs), every re-visit of the paused
 * stage (which pauses again) resolves against the chart as built.
 *
 * Before 9.27.1 the structure stayed in force for the whole resumed run — the
 * traversal was ROOTED at the stand-in (so a loop back to the paused id re-ran
 * the resume half, and a loop target upstream of the resume point was
 * unreachable: one stage ran, then the run ended silently), and the leaf
 * subflow's root was SWAPPED for the stand-in in the subflow dictionary (so a
 * later entry into it would re-run the resume half on a stale seed).
 *
 * @example
 * ```typescript
 * // What FlowChartExecutor.resume() builds for a pause at 'sf-a/sf-b/ask'
 * // (subflowPath ['sf-a', 'sf-a/sf-b']):
 * const entry = ResumeEntry.plan({ root, subflows, path, captures, standIn });
 * entry.start;                       // the top-level mount of 'sf-a'
 * entry.enterSubflow('sf-a');        // { seed: sf-a's capture, entry: the mount of 'sf-a/sf-b' }
 * entry.enterSubflow('sf-a/sf-b');   // { seed: sf-b's capture, entry: standIn }
 * entry.enterSubflow('sf-a/sf-b');   // undefined — a later entry is an ordinary one
 * ```
 *
 * A pause two (or more) subflows deep therefore re-enters each outer subflow
 * AT the mount of the next one — the outer subflow's stages before that mount
 * do not run again (they did before 9.27.1).
 */

import type { StageNode } from '../graph/StageNode.js';

/** One subflow boundary on the way back to a paused stage. */
export interface ResumeHop<TOut = any, TScope = any> {
  /** The path-prefixed subflow id (a `FlowchartCheckpoint.subflowPath` entry). */
  readonly subflowId: string;
  /**
   * The subflow's state at the pause (`checkpoint.subflowStates[subflowId]`).
   * Seeds the nested runtime INSTEAD of the inputMapper — the capture already
   * holds the post-input, pre-pause memory. Absent when the checkpoint holds
   * no capture for this subflow; the inputMapper then runs, as on any entry.
   */
  readonly seed?: Record<string, unknown>;
  /**
   * Where this subflow's traversal starts on the re-entry: the mount of the
   * next subflow on the path, or — on the last hop — the paused stage's
   * stand-in. Absent: the subflow's own root (a seed-only hop, see
   * {@link ResumeEntry.fromCaptures}).
   */
  readonly entry?: StageNode<TOut, TScope>;
}

export class ResumeEntry<TOut = any, TScope = any> {
  /**
   * Where the resumed TOP-LEVEL traversal starts: the stand-in (a top-level
   * pause) or the mount of the first subflow on the path. `undefined` for a
   * seed-only entry — the traversal starts at its root.
   */
  readonly start: StageNode<TOut, TScope> | undefined;
  /** Hops not taken yet, by subflow id. A hop leaves this map when it is taken. */
  private readonly pending: Map<string, ResumeHop<TOut, TScope>>;

  private constructor(start: StageNode<TOut, TScope> | undefined, hops: readonly ResumeHop<TOut, TScope>[]) {
    this.start = start;
    this.pending = new Map(hops.map((hop) => [hop.subflowId, hop]));
  }

  /**
   * Plan the re-entry of a paused chart. Every mount on the path is resolved
   * HERE, against the chart as built, before a single stage runs — so a
   * checkpoint whose path the chart cannot walk is refused up front instead of
   * resuming into the wrong shape.
   *
   * @param root      the chart's root (`FlowChart.root`)
   * @param subflows  the chart's subflow dictionary (`FlowChart.subflows`)
   * @param path      `checkpoint.subflowPath` — outermost first
   * @param captures  `checkpoint.subflowStates` (a detached copy)
   * @param standIn   the node that runs the resume half, then the paused
   *                  stage's continuation (real nodes)
   * @throws when a subflow on the path is missing, or its mount cannot be
   *         reached from the enclosing graph
   */
  static plan<TOut, TScope>(args: {
    root: StageNode<TOut, TScope>;
    subflows: Record<string, { root: StageNode<TOut, TScope> }> | undefined;
    path: readonly string[];
    captures: Record<string, Record<string, unknown>> | undefined;
    standIn: StageNode<TOut, TScope>;
  }): ResumeEntry<TOut, TScope> {
    const { root, subflows, path, captures, standIn } = args;
    if (path.length === 0) return new ResumeEntry(standIn, []);

    const hops: ResumeHop<TOut, TScope>[] = [];
    let enclosing = root;
    let enclosingName = 'the flowchart';
    let start: StageNode<TOut, TScope> | undefined;
    for (let i = 0; i < path.length; i++) {
      const subflowId = path[i];
      const mount = findMount(enclosing, subflowId);
      if (!mount) {
        throw new Error(
          `Cannot resume: the mount of subflow '${subflowId}' is not reachable from ${enclosingName}. ` +
            "The checkpoint's subflowPath does not match this chart — it may have changed since the checkpoint was created.",
        );
      }
      if (i === 0) start = mount;
      else hops[i - 1] = { ...hops[i - 1], entry: mount };

      // Own entries only: a path segment is data from a stored checkpoint,
      // and `'__proto__'` must not resolve through the prototype chain.
      const definition =
        subflows && Object.prototype.hasOwnProperty.call(subflows, subflowId) ? subflows[subflowId] : undefined;
      if (!definition) {
        throw new Error(
          `Cannot resume: subflow '${subflowId}' is not registered in the flowchart. ` +
            'The chart may have changed since the checkpoint was created.',
        );
      }
      const seed =
        captures && Object.prototype.hasOwnProperty.call(captures, subflowId) ? captures[subflowId] : undefined;
      hops.push({ subflowId, ...(seed !== undefined && { seed }), entry: standIn });
      enclosing = definition.root;
      enclosingName = `subflow '${subflowId}'`;
    }
    return new ResumeEntry(start, hops);
  }

  /**
   * A seed-only entry: each capture seeds the FIRST entry into its subflow,
   * which then starts at its own root. What the deprecated
   * `subflowStatesForResume` option (TraverserOptions / HandlerDeps) means
   * since 9.27.1 — the same one-shot law, without a stand-in or a path.
   */
  static fromCaptures<TOut, TScope>(captures: Record<string, Record<string, unknown>>): ResumeEntry<TOut, TScope> {
    return new ResumeEntry<TOut, TScope>(
      undefined,
      Object.entries(captures).map(([subflowId, seed]) => ({ subflowId, seed })),
    );
  }

  /**
   * The re-entry into `subflowId`, taken — or `undefined` when this entry is
   * an ordinary one (the subflow is off the pause path, or its hop was already
   * taken). ONE-SHOT: a hop is returned at most once, so a second entry into
   * the same subflow (a loop passing its mount again) runs the real subflow
   * from its real root with its inputMapper.
   */
  enterSubflow(subflowId: string): ResumeHop<TOut, TScope> | undefined {
    const hop = this.pending.get(subflowId);
    if (hop !== undefined) this.pending.delete(subflowId);
    return hop;
  }

  /** `true` once every hop has been taken — the rest of the run is ordinary. */
  get spent(): boolean {
    return this.pending.size === 0;
  }
}

/**
 * The node that mounts `subflowId`, found by DFS from `start` over `next` and
 * `children` (loop-ref stubs skipped — they share their target's id and carry
 * nothing). Cycle-safe; first match in DFS order.
 */
export function findMount<TOut, TScope>(
  start: StageNode<TOut, TScope>,
  subflowId: string,
): StageNode<TOut, TScope> | undefined {
  const visited = new Set<string>();
  const stack: StageNode<TOut, TScope>[] = [start];
  for (let node = stack.pop(); node !== undefined; node = stack.pop()) {
    if (node.isLoopRef || visited.has(node.id)) continue;
    visited.add(node.id);
    if (node.subflowId === subflowId) return node;
    // LIFO: push `next` first and children reversed, so children are visited
    // before `next` and the first child first — pre-order, like the builder.
    if (node.next) stack.push(node.next);
    if (node.children) {
      for (let i = node.children.length - 1; i >= 0; i--) stack.push(node.children[i]);
    }
  }
  return undefined;
}
