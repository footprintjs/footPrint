/**
 * resume — how `FlowChartExecutor.resume()` plans and announces a re-entry (F9).
 *
 * Three steps, in the order the executor takes them:
 *
 *   1. {@link planResume} — decode the checkpoint (the ONE codec,
 *      `pause/record.ts`), find the paused stage in the chart as built, build
 *      the resume half and the paused stage's stand-in, and plan the one-shot
 *      re-entry (`ResumeEntry.plan`). Every refusal happens HERE, before any
 *      executor state is touched.
 *   2. {@link seedCounters} — carry the pause-time execution counter and visit
 *      counts into the run's shared counters (mutated, never replaced).
 *   3. {@link announceResume} — fire the executor-made `onResume` on the flow
 *      and scope channels (and capture it for the deferred tier), BEFORE the
 *      traversal so it precedes `onRunStart`.
 *
 * The executor owns the per-run state between the steps (the runId, the
 * runtime, the traverser); this module never holds any.
 */

import type { FlowChart } from '../builder/types.js';
import { ResumeEntry } from '../engine/handlers/ResumeEntry.js';
import type { ResumeLink } from '../engine/narrative/types.js';
import { resumeTraversalContext } from '../engine/traversalContext.js';
import type { StageFunction, StageNode } from '../engine/types.js';
import { buildRuntimeStageId } from '../ids/runtimeStageId.js';
import { provideInterruptAnswer } from '../pause/interrupt.js';
import { decodeCheckpoint } from '../pause/record.js';
import type { FlowchartCheckpoint } from '../pause/types.js';
import { isPausedExecution } from '../pause/types.js';
import { fire, recorderFailureEvent, warnInDevMode } from '../recorder/hooks.js';
import type { RunObservers } from './attach.js';

/** Everything a resume decided before any executor state was touched. */
export interface ResumePlan<TOut, TScope> {
  /** The decoded checkpoint (upcast and checked). */
  readonly checkpoint: FlowchartCheckpoint;
  /** The paused stage's REAL node in the chart. */
  readonly pausedNode: StageNode<TOut, TScope>;
  /** Where the resumed traversal starts, and what each subflow on the path takes on its first entry. */
  readonly entry: ResumeEntry<TOut, TScope>;
}

/** The flow channel's isolation for the executor-made `onResume` (dev-mode warning, then skip). */
const RESUME_FLOW_FAILURE = warnInDevMode('FlowChartExecutor');

/**
 * Plan the resume against the chart as built. Throws — leaving the executor
 * untouched — when the checkpoint is malformed, the paused stage is gone, it
 * cannot be resumed, or its path does not fit this chart.
 */
export function planResume<TOut, TScope>(
  fc: FlowChart<TOut, TScope>,
  stored: FlowchartCheckpoint,
  resumeInput: unknown,
): ResumePlan<TOut, TScope> {
  // Decode the checkpoint (may come from untrusted external storage, from
  // any release) — the ONE codec: upcast, then check every pause record.
  const checkpoint = decodeCheckpoint(stored);

  const pausedNode = findNodeInGraph(fc, checkpoint.pausedStageId, checkpoint.subflowPath);
  if (!pausedNode) {
    throw new Error(
      `Cannot resume: stage '${checkpoint.pausedStageId}' not found in flowchart. ` +
        'The chart may have changed since the checkpoint was created.',
    );
  }
  // Two re-entry shapes, chosen by HOW the pause was raised:
  //
  //   • interrupt()      → RE-RUN THE STAGE'S OWN FUNCTION FROM ITS TOP.
  //     Stages are atomic (the same law `resumeOnError` states): a stage that
  //     stopped mid-body has no half to resume into, so the whole body runs
  //     again and the answer comes back out of the `interrupt()` call itself.
  //     Everything the body did before the interrupt is re-done — which is
  //     why the docs tell you to keep that half idempotent.
  //   • addPausableFunction → run the declared `resumeFn`.
  //
  // The discriminant is on the checkpoint, so this works cross-executor
  // (a checkpoint restored from Redis on a fresh process resumes the same way).
  const isInterruptResume = checkpoint.pausedBy === 'interrupt';
  if (!pausedNode.resumeFn && !isInterruptResume) {
    throw new Error(
      `Cannot resume: stage '${pausedNode.name}' (${pausedNode.id}) has no resumeFn. ` +
        'Only stages created with addPausableFunction(), or stages that paused via interrupt(), can be resumed.',
    );
  }
  const resumeStageFn = resumeHalfOf(fc, pausedNode, isInterruptResume, resumeInput);

  // The paused stage's STAND-IN: the stage's OWN node — id, name,
  // description, tags, and its shape (a decider's branches, a selector's, a
  // fork parent's children, its `next`) — with its function swapped for the
  // resume half. Built from the whole node so an `interrupt()` raised inside
  // a decider, selector or fork-parent function DISPATCHES on resume, as the
  // stage did on the run (before 9.28.0 only fn/next/tags/retry were copied
  // and the dispatch was silently skipped). It is where the resumed
  // traversal starts — and nothing else: it is never in a node map or the
  // subflow dictionary, so a loop back to the paused id finds the REAL
  // stage, which pauses again (see ResumeEntry). What runs after it — its
  // own `next`, else its dispatcher's continuation — is attached by
  // `ResumeEntry.plan`, from the chart.
  const standIn = standInFor(pausedNode, resumeStageFn, isInterruptResume);

  // Where the resume re-enters, planned against the chart as built:
  //
  //   • TOP-LEVEL PAUSE (subflowPath empty): the resumed traversal starts
  //     at the stand-in.
  //   • PAUSE INSIDE SUBFLOWS: it starts at the mount of the first subflow
  //     on the path, so the outputMappers and the parent's continuation
  //     run. Each subflow on the path is entered ONCE through its hop: its
  //     nested runtime is seeded from its capture (in place of the
  //     inputMapper's values) and its traversal starts at the mount of the
  //     next subflow — or, at the leaf, at the stand-in. An outer subflow's
  //     stages before that mount do not run again.
  //   • AT EVERY LEVEL the entry carries what its dispatcher would have run
  //     after it — a decider's `next`, a selector's, a fork's join — so a
  //     subflow mounted as a branch or a fork child hands control back to
  //     its parent's continuation at the parent's level.
  //   • Parallel siblings that paused in the same fan-out wait in
  //     `checkpoint.pendingPauses`: each is raised again in turn, and the
  //     join runs only once the last one is resumed.
  //
  // Everything else walks the REAL chart: `fc.root` and `fc.subflows` are
  // untouched, so every later loop target and every later subflow entry
  // (real root, inputMapper) resolves as it would on a run. Refused HERE —
  // before any state is touched — when the checkpoint's path does not fit
  // this chart.
  //
  // Clone-in: the captures seed nested runtimes (shallow-merged into each
  // nested SharedMemory), so without a copy the engine would hold live
  // references into the caller's checkpoint object — caller mutations would
  // bleed into the resumed run and engine writes would reach a checkpoint
  // the caller may have already persisted. The same for the waiting
  // siblings' captures.
  const entry = ResumeEntry.plan<TOut, TScope>({
    root: fc.root,
    subflows: fc.subflows,
    path: checkpoint.subflowPath,
    captures: structuredClone(checkpoint.subflowStates),
    standIn,
    ...(checkpoint.pendingPauses !== undefined && { pendingPauses: structuredClone(checkpoint.pendingPauses) }),
  });
  return { checkpoint, pausedNode, entry };
}

/**
 * Seed the run's shared execution counter + per-stage visit counts from the
 * checkpoint, so runtimeStageIds stay unique and loopIteration monotonic
 * across a CROSS-executor resume (a fresh executor starts both at 0/empty).
 *
 * MUTATE, never REPLACE: both are shared by reference into the traverser
 * (and, transitively, every subflow traverser). Both fields are optional on
 * the checkpoint (older persisted checkpoints omit them) — seeding is skipped
 * when absent. Same-executor resume is idempotent: at pause the values
 * already equal the checkpoint's.
 */
export function seedCounters(
  checkpoint: FlowchartCheckpoint,
  executionCounter: { value: number },
  visitCounts: Map<string, number>,
): void {
  if (checkpoint.executionCount !== undefined) {
    executionCounter.value = checkpoint.executionCount;
  }
  if (checkpoint.visitCounts) {
    visitCounts.clear();
    for (const [stageId, count] of Object.entries(checkpoint.visitCounts)) {
      visitCounts.set(stageId, count);
    }
  }
}

/**
 * Fire the executor-made `onResume` on every recorder (flow + scope), stamped
 * with the resumed leg's NEW runId — consumers detect "a fresh logical run"
 * by the same runId change they use for `onRunStart`. The stamp is built by
 * the one constructor (`engine/traversalContext.ts`): it names the REAL
 * subflow the stand-in runs in and its depth, and LINKS to the paused
 * execution (`resumedFrom`, read off `checkpoint.pausedExecution`) — 9.37.0.
 *
 * The runtimeStageId is the STAND-IN's own: it runs after one mount per
 * subflow on the path (each entered at its mount), so its execution index is
 * the counter plus the path's length — the event and the stand-in's commit
 * name the same execution. The one shape where the index cannot be known up
 * front — a degraded checkpoint missing an OUTER subflow's capture, whose
 * opening stages then re-run — names the planned position.
 */
export function announceResume<TOut, TScope>(
  plan: ResumePlan<TOut, TScope>,
  resumeInput: unknown,
  run: { readonly runId: string; readonly executionCount: number; readonly observers: RunObservers },
): void {
  const { checkpoint, pausedNode, entry } = plan;
  const { observers } = run;
  const hasInput = resumeInput !== undefined;
  const stepsBeforeStandIn = entry.stepsBeforeStandIn ?? checkpoint.subflowPath.length;
  const resumeRuntimeStageId = buildRuntimeStageId(pausedNode.id, run.executionCount + stepsBeforeStandIn);
  const resumedFrom = resumeLinkOf(checkpoint);
  const flowResumeEvent = {
    stageName: pausedNode.name,
    stageId: pausedNode.id,
    hasInput,
    traversalContext: resumeTraversalContext({
      runId: run.runId,
      stageId: pausedNode.id,
      stageName: pausedNode.name,
      runtimeStageId: resumeRuntimeStageId,
      subflowPath: checkpoint.subflowPath,
      resumedFrom,
    }),
    channel: 'flow' as const,
  };
  // Executor-made (`HOOKS.onResume.executorMade`): fired through the same `fire` loop as every
  // engine event, so a throwing recorder is isolated instead of rejecting `resume()` (R10).
  fire(observers.inlineFlowListeners(), 'onResume', flowResumeEvent, RESUME_FLOW_FAILURE);

  const scopeResumeEvent = {
    stageName: pausedNode.name,
    stageId: pausedNode.id,
    runtimeStageId: resumeRuntimeStageId,
    hasInput,
    ...(resumedFrom && { resumedFrom }),
    pipelineId: '',
    timestamp: Date.now(),
    channel: 'scope' as const,
  };
  fire(observers.scopeRecorders, 'onResume', scopeResumeEvent, (error, _recorder, hook) =>
    // The scope channel's policy (as `ScopeFacade` routes a stage's hook failure): the throw
    // becomes an `onError` on every scope recorder, whose own throw is dropped.
    fire(observers.scopeRecorders, 'onError', recorderFailureEvent(scopeResumeEvent, error, hook)),
  );

  // Deferred tier (RFC-001): these executor-synthesized onResume events
  // bypass the per-stage dispatch sites, so capture them directly.
  if (observers.deferredTier) {
    observers.deferredTier.capture('flow', 'onResume', resumeRuntimeStageId, run.runId, flowResumeEvent);
    observers.deferredTier.capture(
      'scope',
      'onResume',
      scopeResumeEvent.runtimeStageId,
      scopeResumeEvent.pipelineId,
      scopeResumeEvent,
    );
  }
}

/**
 * The resume half — what the paused stage's stand-in runs. `interrupt()`:
 * the stage's own function, with the answer deposited for THIS scope first
 * (keyed by scope identity — safe when several branches resume at once).
 * `addPausableFunction`: the declared `resumeFn(scope, input)`, wrapped to
 * the `StageFunction` shape.
 */
function resumeHalfOf<TOut, TScope>(
  fc: FlowChart<TOut, TScope>,
  pausedNode: StageNode<TOut, TScope>,
  isInterruptResume: boolean,
  resumeInput: unknown,
): StageFunction<TOut, TScope> {
  if (isInterruptResume) {
    const originalFn = pausedNode.fn ?? fc.stageMap.get(pausedNode.id) ?? fc.stageMap.get(pausedNode.name);
    if (!originalFn) {
      throw new Error(
        `Cannot resume: stage '${pausedNode.name}' (${pausedNode.id}) paused via interrupt() but its ` +
          'stage function is no longer in the chart. The chart may have changed since the checkpoint ' +
          'was created.',
      );
    }
    return (scope, breakFn, streamCallback) => {
      provideInterruptAnswer(scope, resumeInput);
      return originalFn(scope, breakFn, streamCallback);
    };
  }
  const resumeFn = pausedNode.resumeFn!;
  return (scope: TScope) => {
    return resumeFn(scope, resumeInput) as TOut | Promise<TOut>;
  };
}

/**
 * The paused stage's stand-in for a resume: the stage's OWN node — so it keeps
 * its shape (a decider's or selector's branches, a fork parent's children,
 * its `next`) and its name, description and declared tags — with `fn` swapped
 * for the resume half.
 *
 * Dropped: `resumeFn` and `isPausable` (the resume half must not pause
 * because it returned a value — the original pausable contract); and, on the
 * `addPausableFunction` re-entry, the policies declared for the stage's OWN
 * function (`retry`, streaming) — that re-entry runs a different function
 * (`resumeFn`) under a different contract. The `interrupt()` re-entry re-runs
 * the stage's own function, so it keeps them.
 *
 * Tags follow the stage on BOTH re-entries (9.21.0): a tag is the stage's
 * NAME, not a policy over its function, and the resumed execution is that
 * stage running again — its bundle must carry it, or a chained axis would
 * show the paused leg tagged and the resumed leg silently not.
 */
function standInFor<TOut, TScope>(
  pausedNode: StageNode<TOut, TScope>,
  fn: StageFunction<TOut, TScope>,
  isInterruptResume: boolean,
): StageNode<TOut, TScope> {
  const standIn: StageNode<TOut, TScope> = { ...pausedNode, fn };
  delete standIn.resumeFn;
  delete standIn.isPausable;
  if (!isInterruptResume) {
    delete standIn.retry;
    delete standIn.isStreaming;
    delete standIn.streamId;
  }
  return standIn;
}

/**
 * The resume event's link, read off the checkpoint itself — so a resume records
 * the same wherever its checkpoint came from. `undefined` for a checkpoint
 * without `pausedExecution` (made before 9.37.0) or with a malformed one: the
 * link is a record, never used to plan the re-entry, so it is left out rather
 * than guessed.
 */
function resumeLinkOf(checkpoint: FlowchartCheckpoint): ResumeLink | undefined {
  const paused: unknown = checkpoint.pausedExecution;
  return isPausedExecution(paused) ? { runId: paused.runId, runtimeStageId: paused.runtimeStageId } : undefined;
}

/**
 * Find a StageNode in the compiled graph by ID, drilling into registered
 * subflows along `subflowPath` and searching from the last subflow's root.
 */
function findNodeInGraph<TOut, TScope>(
  fc: FlowChart<TOut, TScope>,
  stageId: string,
  subflowPath: readonly string[],
): StageNode<TOut, TScope> | undefined {
  if (subflowPath.length === 0) return dfsFind(fc.root, stageId);
  let subflowRoot: StageNode<TOut, TScope> | undefined;
  for (const sfId of subflowPath) {
    const subflow = fc.subflows?.[sfId];
    if (!subflow) return undefined;
    subflowRoot = subflow.root;
  }
  if (!subflowRoot) return undefined;
  return dfsFind(subflowRoot, stageId);
}

/** DFS search for a node by ID in the StageNode graph. Cycle-safe via visited set. */
function dfsFind<TOut, TScope>(
  node: StageNode<TOut, TScope>,
  targetId: string,
  visited = new Set<string>(),
): StageNode<TOut, TScope> | undefined {
  // Skip loop back-edge references (they share the target's ID but have no fn/resumeFn)
  if (node.isLoopRef) return undefined;
  if (visited.has(node.id)) return undefined;
  visited.add(node.id);
  if (node.id === targetId) return node;
  if (node.children) {
    for (const child of node.children) {
      const found = dfsFind(child, targetId, visited);
      if (found) return found;
    }
  }
  if (node.next) return dfsFind(node.next, targetId, visited);
  return undefined;
}
