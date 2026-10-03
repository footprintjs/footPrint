/**
 * ResumeEntry — the resume's ONE-SHOT re-entry (M2, pause/resume).
 *
 * A resume has to get back to a stage in the middle of a chart. It does that
 * with a small synthetic structure: a stand-in for the paused stage (the
 * stage's own node with its function swapped for the resume half — or, for an
 * `interrupt()` pause, for its own function with the answer deposited), and,
 * for a pause inside subflows, the checkpoint's capture of each subflow's
 * state on the way down.
 *
 * THE LAW: that structure is used EXACTLY ONCE, for the re-entry. The stand-in
 * is where the resumed traversal STARTS (or where the leaf subflow's traversal
 * starts) — it is never a node any id can resolve to. Each subflow on the pause
 * path takes its seed and its entry point on its FIRST entry and never again.
 * After that the run belongs to the real chart: every loop target, every later
 * subflow entry (real root, inputMapper runs), every re-visit of the paused
 * stage (which pauses again) resolves against the chart as built.
 *
 * ONE RULE AT EVERY LEVEL — what runs after the entry. On the original run,
 * whatever DISPATCHED the paused stage (or the mount of the next subflow on
 * the path) — a decider, a selector, a fork — ran its own continuation once
 * that child's chain ended: the decider's `next`, the fork's join. A resume
 * enters AT the child, so that continuation must be carried: the entry is
 * the child with the enclosing dispatcher's continuation attached at the end
 * of its own chain (`{ ...child, next: dispatcher.next }` for a chart the
 * builder made). It is read from the CHART, level by level — never from the
 * checkpoint, so an edited checkpoint cannot redirect a run — and it lands
 * at the level it belongs to: a top-level decider's `next` runs at the top
 * level, after the subflow's outputMapper, not inside the subflow.
 *
 * PARALLEL SIBLINGS THAT PAUSED TOO (9.28.0). When two children of one
 * fan-out paused, the checkpoint asks the first and carries the others
 * (`FlowchartCheckpoint.pendingPauses`). At that fan-out's level the entry is
 * the child's own chain only — no join — and once it ends, the next sibling's
 * pause is raised again as it was (its question, its captured state), without
 * re-running anything. The join runs only when the last sibling is resumed.
 *
 * Before 9.28.0 the structure stayed in force for the whole resumed run — the
 * traversal was ROOTED at the stand-in (so a loop back to the paused id re-ran
 * the resume half, and a loop target upstream of the resume point was
 * unreachable: one stage ran, then the run ended silently), and the leaf
 * subflow's root was SWAPPED for the stand-in in the subflow dictionary (so a
 * later entry into it would re-run the resume half on a stale seed).
 *
 * @example
 * ```typescript
 * // What FlowChartExecutor.resume() builds for a pause at 'sf-a/sf-b/ask'
 * // (subflowPath ['sf-a', 'sf-a/sf-b']), 'sf-a/sf-b' mounted as a decider
 * // branch inside sf-a whose decider continues to 'sf-a/after':
 * const entry = ResumeEntry.plan({ root, subflows, path, captures, standIn });
 * entry.start;                     // the top-level mount of 'sf-a'
 * entry.enterSubflow('sf-a');      // { seed: sf-a's capture, entry: { ...mount of 'sf-a/sf-b', next: sf-a/after } }
 * entry.enterSubflow('sf-a/sf-b'); // { seed: sf-b's capture, entry: the stand-in }
 * entry.enterSubflow('sf-a/sf-b'); // undefined — a later entry is an ordinary one
 * ```
 *
 * A pause two (or more) subflows deep therefore re-enters each outer subflow
 * AT the mount of the next one — the outer subflow's stages before that mount
 * do not run again (they did before 9.28.0). The one exception is a degraded
 * checkpoint missing an outer subflow's capture: that subflow re-runs from its
 * root with its inputMapper (its earlier stages recompute what the capture
 * would have held), exactly as 9.27.0 did.
 */

import type { PendingPause } from '../../pause/types.js';
import { isPausedExecution, PauseSignal } from '../../pause/types.js';
import type { StageNode } from '../graph/StageNode.js';

/**
 * A parallel sibling's pause, queued at the level of its fan-out: raised
 * again there once the resumed child's chain ends (see {@link raiseQueuedPause}).
 */
export interface QueuedPause {
  /** The sibling's pause as the checkpoint carries it — its path from the top. */
  readonly pause: PendingPause;
  /** How many subflows deep the fan-out sits (0 = the top level). */
  readonly level: number;
  /** The sibling's paused stage's name, for the `onPause` event. */
  readonly stageName: string;
}

/** One subflow boundary on the way back to a paused stage. */
export interface ResumeHop<TOut = any, TScope = any> {
  /** The path-prefixed subflow id (a `FlowchartCheckpoint.subflowPath` entry). */
  readonly subflowId: string;
  /**
   * The subflow's state at the pause (`checkpoint.subflowStates[subflowId]`).
   * Seeds the nested runtime INSTEAD of the inputMapper's values — the capture
   * already holds the post-input, pre-pause memory (the inputMapper still
   * runs, for the stages' read-only args only). Absent when the checkpoint
   * holds no capture for this subflow; the inputMapper then seeds it, as on
   * any entry.
   */
  readonly seed?: Record<string, unknown>;
  /**
   * Where this subflow's traversal starts on the re-entry: the mount of the
   * next subflow on the path, or — on the last hop — the paused stage's
   * stand-in, each with its dispatcher's continuation attached (see the
   * module doc). Absent: the subflow's own root — a seed-only hop (see
   * {@link ResumeEntry.fromCaptures}), or an outer subflow whose capture the
   * checkpoint lacks.
   */
  readonly entry?: StageNode<TOut, TScope>;
  /**
   * Pauses of parallel siblings whose fan-out sits in THIS subflow, raised in
   * order once `entry`'s chain ends (the first is raised, the rest wait
   * behind it). Absent when no sibling is waiting here.
   */
  readonly pendingPauses?: readonly QueuedPause[];
}

export class ResumeEntry<TOut = any, TScope = any> {
  /**
   * Where the resumed TOP-LEVEL traversal starts: the stand-in (a top-level
   * pause) or the mount of the first subflow on the path — each with its
   * dispatcher's continuation attached. `undefined` for a seed-only entry —
   * the traversal starts at its root.
   */
  readonly start: StageNode<TOut, TScope> | undefined;
  /** Sibling pauses whose fan-out sits at the TOP level — raised once `start`'s chain ends. */
  readonly startPendingPauses: readonly QueuedPause[] | undefined;
  /**
   * How many stage executions the resumed run makes before the stand-in runs
   * — one per subflow on the path, each entered at its mount — so the
   * executor's `onResume` names the stand-in's own `runtimeStageId`.
   * `undefined` when it cannot be known before the run: an outer subflow
   * missing its capture re-runs from its root.
   */
  readonly stepsBeforeStandIn: number | undefined;
  /** Hops not taken yet, by subflow id. A hop leaves this map when it is taken. */
  private readonly pending: Map<string, ResumeHop<TOut, TScope>>;

  private constructor(
    start: StageNode<TOut, TScope> | undefined,
    hops: readonly ResumeHop<TOut, TScope>[],
    startPendingPauses?: readonly QueuedPause[],
    stepsBeforeStandIn?: number,
  ) {
    this.start = start;
    this.startPendingPauses = startPendingPauses;
    this.stepsBeforeStandIn = stepsBeforeStandIn;
    this.pending = new Map(hops.map((hop) => [hop.subflowId, hop]));
  }

  /**
   * Plan the re-entry of a paused chart. Every mount on the path, every
   * dispatcher continuation and every waiting sibling is resolved HERE,
   * against the chart as built, before a single stage runs — so a checkpoint
   * whose path the chart cannot walk is refused up front instead of resuming
   * into the wrong shape.
   *
   * @param args - `root` and `subflows`: the chart as built
   *   (`FlowChart.root`, `FlowChart.subflows`); `path`:
   *   `checkpoint.subflowPath`, outermost first; `captures`:
   *   `checkpoint.subflowStates` (a detached copy); `standIn`: the node that
   *   runs the resume half — the paused stage's own node, function swapped
   *   (its continuation is attached here); `pendingPauses`:
   *   `checkpoint.pendingPauses` (a detached copy).
   * @throws when a subflow on the path is missing, mounted more than once, or
   *   its mount cannot be reached from the enclosing graph; or when a pending
   *   pause is malformed or is not a parallel sibling of the paused stage
   */
  static plan<TOut, TScope>(args: {
    root: StageNode<TOut, TScope>;
    subflows: Record<string, { root: StageNode<TOut, TScope> }> | undefined;
    path: readonly string[];
    captures: Record<string, Record<string, unknown>> | undefined;
    standIn: StageNode<TOut, TScope>;
    pendingPauses?: readonly PendingPause[];
  }): ResumeEntry<TOut, TScope> {
    const { root, subflows, path, captures, standIn } = args;
    const chart = new ChartIndex<TOut, TScope>();

    // 1. Walk the path: the graph of every level, the mount of every subflow.
    const graphs: StageNode<TOut, TScope>[] = [root];
    const mounts: StageNode<TOut, TScope>[] = [];
    for (let i = 0; i < path.length; i++) {
      const subflowId = path[i];
      mounts.push(chart.onlyMount(graphs[i], subflowId, i === 0 ? 'the flowchart' : `subflow '${path[i - 1]}'`));
      // Own entries only: a path segment is data from a stored checkpoint,
      // and `'__proto__'` must not resolve through the prototype chain.
      const definition = ownEntry(subflows, subflowId);
      if (!definition) {
        throw new Error(
          `Cannot resume: subflow '${subflowId}' is not registered in the flowchart. ` +
            'The chart may have changed since the checkpoint was created.',
        );
      }
      graphs.push(definition.root);
    }
    const leafLevel = path.length;
    // The paused stage's REAL node — whose dispatcher the stand-in's
    // continuation comes from. (The executor already found it; a direct
    // caller's stand-in that is not in the leaf graph simply has none.)
    const paused = chart.stage(graphs[leafLevel], standIn.id);

    // 2. Queue every waiting sibling pause at the level of its fan-out.
    const queues = queueSiblingPauses(args.pendingPauses, { chart, subflows, root, path, graphs, mounts, paused });

    // 3. The one-shot entry of every level: the child, then its dispatcher's
    //    continuation — up to the fan-out when siblings wait there.
    const childAt = (level: number) => (level < leafLevel ? mounts[level] : paused);
    const entryAt = (level: number): StageNode<TOut, TScope> => {
      const child = childAt(level);
      const replacement = level < leafLevel ? mounts[level] : standIn;
      if (!child) return replacement;
      return chart.entry(graphs[level], child, replacement, queues[level]?.fanOut);
    };
    // 4. The hops. A subflow with no capture is entered at its ROOT with its
    //    inputMapper (its earlier stages recompute what the capture held) —
    //    except the leaf, whose entry is always the stand-in: re-running it
    //    from its root would ask again and lose the answer.
    const hops: ResumeHop<TOut, TScope>[] = [];
    let everyLevelAtItsEntry = true;
    for (let i = 0; i < path.length; i++) {
      const subflowId = path[i];
      const seed = ownEntry(captures, subflowId);
      const isLeafHop = i === path.length - 1;
      if (seed === undefined && !isLeafHop) {
        everyLevelAtItsEntry = false;
        hops.push({ subflowId });
        continue;
      }
      const waiting = queues[i + 1]?.pauses;
      hops.push({
        subflowId,
        ...(seed !== undefined && { seed }),
        entry: entryAt(i + 1),
        ...(waiting && { pendingPauses: waiting }),
      });
    }
    // Every level entered at its entry: one execution (the mount) per level
    // runs before the stand-in.
    return new ResumeEntry(entryAt(0), hops, queues[0]?.pauses, everyLevelAtItsEntry ? path.length : undefined);
  }

  /**
   * A seed-only entry: each capture seeds the FIRST entry into its subflow,
   * which then starts at its own root. What the deprecated
   * `subflowStatesForResume` option (TraverserOptions / HandlerDeps) means
   * since 9.28.0 — the same one-shot law, without a stand-in or a path.
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

// ── Raising a waiting sibling's pause ────────────────────────────────────────

/**
 * Queue `queue` behind a pause passing through its level: a pause raised
 * while siblings still wait must carry them to its checkpoint. Each path is
 * cut to that level — the bubble-up prepends the levels above.
 */
export function queueBehind(signal: PauseSignal, queue: readonly QueuedPause[]): void {
  for (const { pause, level } of queue) {
    signal.addPendingPause({ ...pause, subflowPath: pause.subflowPath.slice(level) });
  }
}

/**
 * The first waiting sibling's pause, raised again at its fan-out's level —
 * exactly as it bubbled up to that level the first time (its stage, its
 * question, its own subflow captures), nothing re-run; the rest of the queue
 * waits behind it. The subflows ABOVE the fan-out capture themselves afresh
 * as it bubbles up, so they carry what the resumed child wrote.
 */
export function raiseQueuedPause(queue: readonly QueuedPause[]): PauseSignal {
  const [first, ...rest] = queue;
  const { pause, level } = first;
  const signal = new PauseSignal(pause.pauseData, pause.pausedStageId, pause.pausedBy);
  // The sibling paused in an EARLIER run: its own execution, not this run's.
  if (isPausedExecution(pause.pausedExecution)) {
    signal.stampExecution(pause.pausedExecution.runtimeStageId, pause.pausedExecution.runId);
  }
  const below = pause.subflowPath.slice(level);
  for (let i = below.length - 1; i >= 0; i--) {
    const state = ownEntry(pause.subflowStates, below[i]);
    if (state !== undefined) signal.captureSubflowScope(below[i], state);
    signal.prependSubflow(below[i]);
  }
  queueBehind(signal, rest);
  return signal;
}

// ── Reading the chart ────────────────────────────────────────────────────────

/**
 * The node that mounts `subflowId`, found by DFS from `start` over `next` and
 * `children` (loop-ref stubs skipped — they share their target's id and carry
 * nothing). Cycle-safe (visited by identity, so an absent id terminates too);
 * first match in DFS pre-order (children before `next`, like the builder).
 */
export function findMount<TOut, TScope>(
  start: StageNode<TOut, TScope>,
  subflowId: string,
): StageNode<TOut, TScope> | undefined {
  for (const node of dispatcherIndex(start).keys()) {
    if (node.subflowId === subflowId) return node;
  }
  return undefined;
}

/**
 * Every real node of one level's graph, in DFS pre-order, mapped to the
 * DISPATCHER whose child-chain holds it — the node whose `children` it
 * descends from (a decider, a selector, a fork) — or `undefined` for a node
 * on the level's own spine. Loop stubs are skipped; visited by identity, so
 * two mounts sharing an id are both indexed and a cycle terminates.
 */
function dispatcherIndex<TOut, TScope>(
  root: StageNode<TOut, TScope>,
): Map<StageNode<TOut, TScope>, StageNode<TOut, TScope> | undefined> {
  const index = new Map<StageNode<TOut, TScope>, StageNode<TOut, TScope> | undefined>();
  const stack: Array<[StageNode<TOut, TScope>, StageNode<TOut, TScope> | undefined]> = [[root, undefined]];
  for (let top = stack.pop(); top !== undefined; top = stack.pop()) {
    const [node, dispatcher] = top;
    if (node.isLoopRef || index.has(node)) continue;
    index.set(node, dispatcher);
    // LIFO: push `next` first and children reversed, so children are visited
    // before `next` and the first child first — pre-order, like the builder.
    if (node.next) stack.push([node.next, dispatcher]);
    if (node.children) {
      for (let i = node.children.length - 1; i >= 0; i--) stack.push([node.children[i], node]);
    }
  }
  return index;
}

/** One plan's view of the chart: each level's index built once. */
class ChartIndex<TOut, TScope> {
  private readonly indexes = new Map<
    StageNode<TOut, TScope>,
    Map<StageNode<TOut, TScope>, StageNode<TOut, TScope> | undefined>
  >();

  private of(root: StageNode<TOut, TScope>) {
    let index = this.indexes.get(root);
    if (!index) {
      index = dispatcherIndex(root);
      this.indexes.set(root, index);
    }
    return index;
  }

  /** Every mount of `subflowId` in `root`'s graph, in DFS pre-order. */
  mountsOf(root: StageNode<TOut, TScope>, subflowId: string): StageNode<TOut, TScope>[] {
    return [...this.of(root).keys()].filter((node) => node.subflowId === subflowId);
  }

  /** The one mount of `subflowId` in `root`'s graph — refused when absent or ambiguous. */
  onlyMount(root: StageNode<TOut, TScope>, subflowId: string, graphName: string): StageNode<TOut, TScope> {
    const found = this.mountsOf(root, subflowId);
    if (found.length === 0) {
      throw new Error(
        `Cannot resume: the mount of subflow '${subflowId}' is not reachable from ${graphName}. ` +
          "The checkpoint's subflowPath does not match this chart — it may have changed since the checkpoint was created.",
      );
    }
    if (found.length > 1) {
      throw new Error(
        `Cannot resume: subflow '${subflowId}' is mounted more than once in ${graphName} ` +
          `(${found.map((node) => `'${node.name}'`).join(', ')}), and a checkpoint's subflowPath cannot say which ` +
          'mount paused. Give each mount its own subflow id to make a pause inside it resumable.',
      );
    }
    return found[0];
  }

  /** The real stage `id` in `root`'s graph (first in DFS pre-order), if any. */
  stage(root: StageNode<TOut, TScope>, id: string): StageNode<TOut, TScope> | undefined {
    for (const node of this.of(root).keys()) if (node.id === id) return node;
    return undefined;
  }

  /** The dispatcher whose child-chain holds `node` in `root`'s graph (`undefined` on the spine). */
  dispatcherOf(root: StageNode<TOut, TScope>, node: StageNode<TOut, TScope>): StageNode<TOut, TScope> | undefined {
    return this.of(root).get(node);
  }

  /**
   * The one-shot entry for `child` (a mount on the path, or the paused stage)
   * in `root`'s graph: `replacement` (the node that runs — the mount itself,
   * or the stand-in) with what ran after `child`'s chain on the original run
   * attached where that chain ends — `{ ...child, next: dispatcher.next }` for
   * a chart the builder made:
   *
   *   • on the level's spine: nothing to attach — the spine goes on by itself;
   *   • a DECIDER's or SELECTOR's branch: the dispatcher's `next`;
   *   • a FORK child: the fork's `next` — its join.
   *
   * Past a dispatcher with no `next`, the walk goes on OUTWARD to the one
   * enclosing it. It stops at `stopAt` — the fan-out where siblings still
   * wait, whose join must not run yet. Nothing to attach: `replacement`
   * itself.
   */
  entry(
    root: StageNode<TOut, TScope>,
    child: StageNode<TOut, TScope>,
    replacement: StageNode<TOut, TScope>,
    stopAt: StageNode<TOut, TScope> | undefined,
  ): StageNode<TOut, TScope> {
    return appendAtChainEnd(replacement, this.after(root, child, stopAt));
  }

  /**
   * What runs once `node`'s chain ends: its dispatcher's `next` chain, then —
   * where THAT ends — the continuation of the dispatcher enclosing it, outward,
   * up to `stopAt` (exclusive). `undefined` on the spine.
   */
  private after(
    root: StageNode<TOut, TScope>,
    node: StageNode<TOut, TScope>,
    stopAt: StageNode<TOut, TScope> | undefined,
  ): StageNode<TOut, TScope> | undefined {
    const dispatcher = this.dispatcherOf(root, node);
    if (dispatcher === undefined || dispatcher === stopAt) return undefined;
    const outer = this.after(root, dispatcher, stopAt);
    return dispatcher.next ? appendAtChainEnd(dispatcher.next, outer) : outer;
  }
}

/**
 * `start`'s chain with `after` attached where it ends — the chain's nodes
 * copied on the way (never registered anywhere: ids still resolve to the real
 * nodes). A chain that ends in a loop stub (or loops back on itself) is
 * returned as is: control leaves it through the loop, never "after" it.
 */
function appendAtChainEnd<TOut, TScope>(
  start: StageNode<TOut, TScope>,
  after: StageNode<TOut, TScope> | undefined,
): StageNode<TOut, TScope> {
  if (after === undefined) return start;
  const chain: StageNode<TOut, TScope>[] = [];
  const seen = new Set<StageNode<TOut, TScope>>();
  for (let node: StageNode<TOut, TScope> | undefined = start; node !== undefined; node = node.next) {
    if (node.isLoopRef || seen.has(node)) return start;
    seen.add(node);
    chain.push(node);
  }
  let next = after;
  for (let i = chain.length - 1; i >= 0; i--) next = { ...chain[i], next };
  return next;
}

// ── Waiting siblings ─────────────────────────────────────────────────────────

/** The sibling pauses waiting at one level, and the fan-out they wait in. */
interface LevelQueue<TOut, TScope> {
  readonly fanOut: StageNode<TOut, TScope>;
  readonly pauses: QueuedPause[];
}

/**
 * Validate `checkpoint.pendingPauses` (untrusted input) and queue each at the
 * level of its fan-out: the depth where its path parts from the paused
 * stage's. There, the paused stage's child (a mount on the path, or the stage
 * itself) and the sibling's must both hang off ONE parallel dispatcher — a
 * fork or a selector — or the record is not a sibling and the resume is
 * refused rather than asked a question the chart could not have raised.
 */
function queueSiblingPauses<TOut, TScope>(
  pending: readonly PendingPause[] | undefined,
  at: {
    chart: ChartIndex<TOut, TScope>;
    subflows: Record<string, { root: StageNode<TOut, TScope> }> | undefined;
    root: StageNode<TOut, TScope>;
    path: readonly string[];
    graphs: readonly StageNode<TOut, TScope>[];
    mounts: readonly StageNode<TOut, TScope>[];
    paused: StageNode<TOut, TScope> | undefined;
  },
): Array<LevelQueue<TOut, TScope> | undefined> {
  const queues: Array<LevelQueue<TOut, TScope> | undefined> = [];
  if (pending === undefined) return queues;
  if (!Array.isArray(pending)) throw new Error('Invalid checkpoint: pendingPauses must be an array.');
  const { chart, subflows, root, path, graphs, mounts, paused } = at;
  const seen = new Set<string>();

  pending.forEach((raw: unknown, n) => {
    const pause = validPendingPause(raw, n);
    // One record per paused sibling: a repeat would ask the same question twice.
    const key = JSON.stringify([pause.subflowPath, pause.pausedStageId]);
    if (seen.has(key)) {
      throw new Error(
        `Cannot resume: checkpoint.pendingPauses[${n}] ('${pause.pausedStageId}') repeats an earlier entry.`,
      );
    }
    seen.add(key);
    let level = 0;
    while (level < path.length && level < pause.subflowPath.length && path[level] === pause.subflowPath[level]) level++;
    const graph = graphs[level];
    const ours = level < path.length ? mounts[level] : paused;
    const theirMounts = level < pause.subflowPath.length ? chart.mountsOf(graph, pause.subflowPath[level]) : [];
    const theirs =
      level < pause.subflowPath.length
        ? theirMounts.length === 1
          ? theirMounts[0]
          : undefined
        : chart.stage(graph, pause.pausedStageId);
    const fanOut = ours ? chart.dispatcherOf(graph, ours) : undefined;
    const isSibling =
      ours !== undefined &&
      theirs !== undefined &&
      ours !== theirs &&
      fanOut !== undefined &&
      chart.dispatcherOf(graph, theirs) === fanOut &&
      !fanOut.deciderFn &&
      (queues[level] === undefined || queues[level]!.fanOut === fanOut);
    if (!isSibling || !walksToItsStage(chart, subflows, graph, pause, level)) {
      throw new Error(
        `Cannot resume: checkpoint.pendingPauses[${n}] ('${pause.pausedStageId}') is not a parallel sibling of ` +
          `the paused stage '${paused?.id ?? '?'}' in this chart — no fork or selector runs them both, or its ` +
          'path does not lead to that stage. The chart may have changed since the checkpoint was created.',
      );
    }
    const leafRoot =
      pause.subflowPath.length === 0 ? root : ownEntry(subflows, pause.subflowPath[pause.subflowPath.length - 1])?.root;
    const stageName = (leafRoot && chart.stage(leafRoot, pause.pausedStageId)?.name) ?? pause.pausedStageId;
    const queue = (queues[level] ??= { fanOut: fanOut!, pauses: [] });
    queue.pauses.push({ pause, level, stageName });
  });
  return queues;
}

/**
 * Whether a waiting sibling's WHOLE path below its fan-out walks this chart:
 * every segment the only mount of its subflow in the enclosing graph, every
 * subflow registered, and the paused stage in the last graph — checked at
 * the FIRST resume, so a tampered record is refused up front, not when its
 * turn comes.
 */
function walksToItsStage<TOut, TScope>(
  chart: ChartIndex<TOut, TScope>,
  subflows: Record<string, { root: StageNode<TOut, TScope> }> | undefined,
  fanOutGraph: StageNode<TOut, TScope>,
  pause: PendingPause,
  level: number,
): boolean {
  let graph = fanOutGraph;
  for (let i = level; i < pause.subflowPath.length; i++) {
    if (chart.mountsOf(graph, pause.subflowPath[i]).length !== 1) return false;
    const definition = ownEntry(subflows, pause.subflowPath[i]);
    if (!definition) return false;
    graph = definition.root;
  }
  return chart.stage(graph, pause.pausedStageId) !== undefined;
}

/** One `pendingPauses` entry, checked field by field — it comes from stored, untrusted data. */
function validPendingPause(raw: unknown, n: number): PendingPause {
  const refuse = (what: string): never => {
    throw new Error(`Invalid checkpoint: pendingPauses[${n}] ${what}.`);
  };
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) refuse('must be an object');
  const record = raw as Record<string, unknown>;
  if (typeof record.pausedStageId !== 'string' || record.pausedStageId === '') {
    refuse('must name its paused stage (pausedStageId, a non-empty string)');
  }
  const subflowPath = record.subflowPath;
  if (!Array.isArray(subflowPath) || !subflowPath.every((s) => typeof s === 'string')) {
    refuse('must carry its subflowPath (an array of strings)');
  }
  const states = record.subflowStates;
  if (states !== undefined && (states === null || typeof states !== 'object' || Array.isArray(states))) {
    refuse('must carry its subflowStates as an object');
  }
  if (record.pausedBy !== undefined && record.pausedBy !== 'interrupt')
    refuse("has an unknown pausedBy (only 'interrupt')");
  return {
    pausedStageId: record.pausedStageId as string,
    subflowPath: subflowPath as string[],
    subflowStates: (states as Record<string, Record<string, unknown>> | undefined) ?? {},
    ...(record.pauseData !== undefined && { pauseData: record.pauseData }),
    ...(record.pausedBy === 'interrupt' && { pausedBy: 'interrupt' as const }),
    // A record, never a plan input: kept only when well-formed (an older or
    // hand-edited entry simply resumes without a link).
    ...(isPausedExecution(record.pausedExecution) && {
      pausedExecution: { runId: record.pausedExecution.runId, runtimeStageId: record.pausedExecution.runtimeStageId },
    }),
  };
}

/** `record[key]` only when it is the record's OWN property — never through the prototype chain. */
function ownEntry<T>(record: Record<string, T> | undefined, key: string): T | undefined {
  return record && Object.prototype.hasOwnProperty.call(record, key) ? record[key] : undefined;
}
