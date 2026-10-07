/**
 * SubflowExecutor — Isolation boundary for subflow execution.
 *
 * Responsibilities:
 * - Create isolated ExecutionRuntime for each subflow
 * - Apply input/output mapping via SubflowInputMapper
 * - Delegate traversal to a factory-created FlowchartTraverser
 * - Track subflow results for debugging/visualization
 *
 * Each subflow gets its own GlobalStore for isolation.
 * Traversal uses the SAME 7-phase algorithm as the top-level traverser
 * (via SubflowTraverserFactory), so deciders, selectors, loops, lazy subflows,
 * and abort signals all work inside subflows automatically.
 */

import { thrownText } from '../../errors/errorInfo.js';
import { LOG_PLACEHOLDER } from '../../memory/placeholders.js';
import type { RunPolicy } from '../../memory/runPolicy.js';
import type { StageContext } from '../../memory/StageContext.js';
import { isPauseSignal } from '../../pause/types.js';
import type { StageNode } from '../graph/StageNode.js';
import type { TraversalContext } from '../narrative/types.js';
import type {
  HandlerDeps,
  IExecutionRuntime,
  SubflowResult,
  SubflowTraverserFactory,
  SubflowTraverserHandle,
} from '../types.js';
import { ResumeEntry } from './ResumeEntry.js';
import { rememberRedactedSubflowState } from './servedSubflowResults.js';
import { loggableStageError } from './stageError.js';
import { applyOutputMapping, getInitialScopeValues, seedSubflowGlobalStore } from './SubflowInputMapper.js';
import type { BreakFlag } from './types.js';

/**
 * The mapped input, detached from the parent's state ONCE per mount (D1,
 * 9.29.0 — docs/design/2026-10-copy-on-write-commit.md).
 *
 * The inputMapper reads the parent's LIVE state (`getScope()`), so a value it
 * passes through (`(p) => ({ cfg: p.cfg })`) is the parent's committed
 * object — and the subflow's args are deep-FROZEN in place
 * (`readonlyInput · createFrozenArgs`). The typed scope does not proxy a
 * frozen value (`allowlist · shouldWrapWithProxy`), so a later
 * `scope.cfg.x = 1` in the parent met the raw frozen object: a TypeError in
 * strict code. Before 9.29.0 the parent's next whole-state clone replaced the
 * frozen object (a mount that committed nothing left it in place — the bug
 * existed, it was only short-lived); under copy-on-write nothing re-clones,
 * so the freeze would last until the key is rewritten. A mount must never
 * edit — or freeze — the parent's committed objects: every plain object,
 * array, `Date`, `Map` and `Set` the mapper returns is cloned here, before it
 * becomes the args. A class instance passes by reference, as before (it
 * cannot come from committed state, and a clone would drop its prototype).
 * The seed is cloned again at its commit, so the subflow's state is
 * unchanged.
 */
function detachMappedInput(input: Record<string, unknown>): Record<string, unknown> {
  let out: Record<string, unknown> | undefined;
  for (const [key, value] of Object.entries(input)) {
    if (!isDetachable(value)) continue;
    (out ??= { ...input })[key] = structuredClone(value);
  }
  return out ?? input;
}

/** A value `structuredClone` reproduces with its own type: plain object, array, `Date`, `Map`, `Set`. */
function isDetachable(value: unknown): boolean {
  if (value === null || typeof value !== 'object') return false;
  if (Array.isArray(value) || value instanceof Date || value instanceof Map || value instanceof Set) return true;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

export class SubflowExecutor<TOut = any, TScope = any> {
  /**
   * The resume's one-shot re-entry (`deps.resume`), or a seed-only one built
   * from the deprecated `deps.subflowStatesForResume`. Undefined on a normal
   * run. Asked once per subflow entry — see {@link ResumeEntry}.
   */
  private readonly resume: ResumeEntry<TOut, TScope> | undefined;

  constructor(
    private deps: HandlerDeps<TOut, TScope>,
    private traverserFactory: SubflowTraverserFactory<TOut, TScope>,
  ) {
    this.resume =
      deps.resume ??
      (deps.subflowStatesForResume ? ResumeEntry.fromCaptures<TOut, TScope>(deps.subflowStatesForResume) : undefined);
  }

  /**
   * Execute a subflow with isolated context.
   *
   * 1. Creates a fresh ExecutionRuntime for the subflow
   * 2. Applies input mapping to seed the subflow's GlobalStore
   * 3. Delegates traversal to a factory-created FlowchartTraverser
   * 4. Applies output mapping to write results back to parent scope
   * 5. Stores execution data for debugging/visualization
   */
  async executeSubflow(
    node: StageNode<TOut, TScope>,
    parentContext: StageContext,
    breakFlag: BreakFlag,
    branchPath: string | undefined,
    subflowResultsMap: Map<string, SubflowResult>,
    parentTraversalContext?: TraversalContext,
  ): Promise<any> {
    const subflowId = node.subflowId!;
    const subflowName = node.subflowName ?? node.name;

    parentContext.addFlowDebugMessage('subflow', `Entering ${subflowName} subflow`, {
      targetStage: subflowId,
    });

    // ─── Resume re-entry (one-shot) ───
    //
    // When this entry is the resume's way back into a paused subflow, the
    // hop names where the subflow's traversal starts (the next mount on the
    // pause path, or the paused stage's stand-in), carries the subflow's
    // captured pre-pause state, and any sibling pauses waiting in it. Taken
    // ONCE: any later entry into this subflow — a loop passing its mount
    // again — gets `undefined` and runs the real subflow from its real root,
    // inputMapper and all.
    const resumeHop = this.resume?.enterSubflow(subflowId);

    // ─── Input Mapping ───
    //
    // The mapper runs on EVERY entry: its result is the stages' read-only
    // args (`$getArgs()`), and a re-entered subflow's stages read the same
    // args they read before the pause (the parent's view is the same one —
    // it was blocked in this mount). What a resume changes is only the SEED:
    // when the hop carries a capture, the nested memory is seeded from the
    // capture, not from the mapper — the capture is the post-input pre-pause
    // memory, and seeding the mapper's values would clobber post-input
    // writes (history, pausedToolCallId, etc.) with the start-of-subflow view.
    const mountOptions = node.subflowMountOptions;
    let mappedInput: Record<string, unknown> = {};
    const resumeCapture = resumeHop?.seed;
    const isResumeForThisSubflow = resumeCapture !== undefined;

    // The run's policy (F5) — the four dials, the redaction rule, the mirror
    // flag — read off the parent-mount frame, which holds it by reference.
    // The nested runtime is constructed WITH it, so the seed commit below
    // (`history[0]`) and every later commit of the subflow run under the same
    // object, and the nested runtime keeps a mirror of its own exactly when
    // the run does (its SERVED state is then the fold of its own scrubbed
    // log, never a second scrub).
    const policy: RunPolicy = parentContext.getPolicy();
    const redactionRule = policy.redaction;

    if (mountOptions) {
      try {
        const parentScope = parentContext.getScope();
        // The rule rides along: a key the mapper copies a selected value into
        // inherits its redaction before the seed is written (the taint rule).
        mappedInput = detachMappedInput(getInitialScopeValues(parentScope, mountOptions, redactionRule));
        if (Object.keys(mappedInput).length > 0) {
          // mappedInput is captured in SubflowResult.treeContext for debugging
        }
      } catch (error: any) {
        parentContext.addError('inputMapperError', thrownText(error));
        this.deps.logger.error(`Error in inputMapper for subflow (${subflowId}):`, {
          error: loggableStageError(parentContext, error),
        });
        throw error;
      }
    }

    // Narrative receives the RETAINED form of the mapped input — an
    // inputMapper may inject values from anywhere, so the seed is scrubbed
    // under the policy before any recorder sees it. Same object when nothing
    // in it is redacted (the no-policy path allocates nothing).
    const narrativeInput = redactionRule ? redactionRule.retainBoundary(mappedInput) : mappedInput;
    // `FlowSubflowEvent.description` is semantically "what this subflow does" — sourced from
    // the subflow's own root stage, not the parent mount point. The mount node never carries
    // a description (builders don't copy it), so reading `node.description` here returns
    // `undefined` and taxonomy markers set on the subflow root (e.g. agentfootprint's
    // `'Agent: ReAct loop'` / `'LLMCall: one-shot'`) never reach downstream consumers.
    const rootDescription = this.deps.subflows?.[subflowId]?.root?.description;
    this.deps.narrativeGenerator.onSubflowEntry(
      subflowName,
      subflowId,
      rootDescription ?? node.description,
      parentTraversalContext,
      narrativeInput,
    );
    // Proposal #003: fire onStageExecuted for the mount node AFTER
    // onSubflowEntry so consumers tracking "did this stage run" work
    // uniformly across linear / decider / fork / selector / subflow-mount.
    // Fires on ENTRY (not exit) — entry = "this mount ran"; the
    // subflow's children execute after as separate stages.
    this.deps.narrativeGenerator.onStageExecuted(
      node.name,
      rootDescription ?? node.description,
      parentTraversalContext,
      'subflow-mount',
    );

    // Create isolated runtime via dynamic construction (avoids circular import).
    // Its root context is the first stage the subflow traversal runs — the
    // resume hop's entry on a re-entry, the subflow's root otherwise.
    const ExecutionRuntimeClass = this.deps.executionRuntime.constructor as new (
      name: string,
      id: string,
      defaultValues: undefined,
      initialState: undefined,
      policy: RunPolicy,
    ) => IExecutionRuntime;
    const firstNode = resumeHop?.entry ?? node;
    const nestedRuntime = new ExecutionRuntimeClass(firstNode.name, firstNode.id, undefined, undefined, policy);

    // Seed GlobalStore with the right shape for the path:
    //   • Resume into THIS subflow → seed from the captured pre-pause
    //     scope so resume handlers see history, pausedToolCallId, etc.
    //     (`mappedInput` still reaches the stages, as their read-only args.)
    //   • Normal entry → seed from the inputMapper's mappedInput.
    const seedValues: Record<string, unknown> = isResumeForThisSubflow ? resumeCapture! : mappedInput;
    if (Object.keys(seedValues).length > 0) {
      // The seed is committed as the subflow's `history[0]` by its root
      // context, not by a facade — that frame already holds the run's policy
      // (the runtime was constructed with it), so the seed retains under the
      // rule, lands in the mirror as the placeholder, and commits under the
      // run's dials like every other write (C-F5: under `writeProvenance:
      // 'reads-prefix'` its rows carry `readKeys: []`).
      // The seed is the mount's act too: its bundle — `history[0]` of the
      // subflow's own log — carries the mount's stage, stageId and
      // runtimeStageId (R13; through 9.33.0 it carried runtimeStageId '' and
      // the first stage's names, which on a resume was the re-entry point).
      seedSubflowGlobalStore(nestedRuntime, seedValues, parentContext);
      // Refresh rootStageContext so WriteBuffer sees committed data. Named
      // after the first node again — the seed context now carries the mount's
      // names (R13), which belong to the seed bundle only. `newRoot` gives it
      // the same policy and mirror.
      nestedRuntime.rootStageContext = nestedRuntime.newRoot(firstNode.name, firstNode.id);
    }

    // Prepare subflow root node — strip isSubflowRoot to prevent re-delegation.
    //
    // PRESERVE `next`. Earlier revisions stripped `next` whenever the
    // subflow root had children, on the assumption that `next` was
    // always the OUTER mount's continuation leaking into the inner
    // tree. That assumption was wrong: the resolved subflow root's
    // `next` is the INNER join stage (e.g., Parallel's Merge after a
    // fan-out, ToT's Pruner). Stripping it broke composite subflows —
    // the join stage never ran, so the subflow returned partial state.
    //
    // The outer mount's post-subflow continuation is handled separately
    // by the parent traverser via `parentContext.nextNode` and is never
    // conflated with the inner subflow's `next` chain.
    const subflowNode: StageNode<TOut, TScope> = {
      ...node,
      isSubflowRoot: false,
    };

    // ─── Execute via factory traverser ───
    // The factory creates a full FlowchartTraverser with the same 7-phase algorithm,
    // sharing the parent's stageMap, subflows dict, and narrative generator.
    let subflowOutput: any;
    // Boxed: a stage may throw ANY value, `null` and `undefined` included —
    // a falsy thrown value must still fail the mount.
    let subflowError: { error: unknown } | undefined;
    let traverserHandle: SubflowTraverserHandle<TOut, TScope> | undefined;

    try {
      traverserHandle = this.traverserFactory({
        // The REAL subflow graph — every id inside the subflow (loop targets,
        // a re-visit of the paused stage) resolves against it, re-entry or not.
        root: subflowNode,
        // Where this traversal starts on a resume re-entry; visited once —
        // and the sibling pauses it raises once that entry's chain ends.
        ...(resumeHop?.entry && { entry: resumeHop.entry }),
        ...(resumeHop?.pendingPauses && { pendingPauses: resumeHop.pendingPauses }),
        executionRuntime: nestedRuntime,
        readOnlyContext: mappedInput,
        subflowId,
        // RFC-003 D1: the mount stage's runtimeStageId — the subflow root
        // stage's `parentRuntimeStageId` so ancestor chains cross the mount.
        parentMountRuntimeStageId: parentTraversalContext?.runtimeStageId,
      });

      subflowOutput = await traverserHandle.execute();
    } catch (error: any) {
      // PauseSignal is not an error — prepend subflow ID and re-throw
      // immediately. No error logging, no subflowResult recording —
      // the pause is control flow.
      //
      // BEFORE re-throw, capture the nested runtime's state onto the
      // signal. This is the only chance — once we re-throw, the outer
      // traverser unwinds and the nested runtime is GC'd. On resume, we'll
      // re-seed a fresh nested runtime from this capture so resume handlers
      // can read the pre-pause subflow scope.
      //
      // The STATE only — the subflow's working memory at pause time (every
      // committed write up to the pause), read straight off its store. No
      // snapshot is built: a snapshot would also build the subflow's
      // execution tree and copy its commit log — work proportional to how
      // long the subflow ran — that the lean checkpoint never carries
      // (`runner/checkpoint.ts`).
      //
      // Capture is keyed by the SAME path-prefixed `subflowId` used in
      // `subflowPath`, so resume can look up "scope for sf-foo" by id.
      if (isPauseSignal(error)) {
        error.captureSubflowScope(subflowId, nestedRuntime.globalStore.getState());
        error.prependSubflow(subflowId);
        throw error;
      }
      subflowError = { error };
      parentContext.addError('subflowError', thrownText(error));
      this.deps.logger.error(`Error in subflow (${subflowId}):`, { error: loggableStageError(parentContext, error) });
    }

    // Always merge nested subflow results (even on error — partial results aid debugging)
    if (traverserHandle) {
      for (const [key, value] of traverserHandle.getSubflowResults()) {
        subflowResultsMap.set(key, value);
      }
    }

    // ─── Break propagation (opt-in via SubflowMountOptions.propagateBreak) ──
    //
    // If the subflow's inner traversal broke (because a stage called
    // `scope.$break(reason)`) AND the mount declared `propagateBreak: true`,
    // forward the break state to the PARENT's breakFlag. The parent
    // traverser will see `shouldBreak` on its next step and stop.
    //
    // Without this, inner breaks are locally scoped to the subflow — the
    // parent continues as if the subflow returned normally.
    //
    // IMPORTANT: this runs BEFORE `outputMapping` below, intentionally. The
    // outputMapper still executes, so the subflow's partial result still
    // lands in the parent scope. Consumers who need to suppress output on
    // break check the break state inside their outputMapper and early-return.
    // See `SubflowMountOptions.propagateBreak` JSDoc for rationale.
    if (traverserHandle && mountOptions?.propagateBreak === true) {
      const innerBreak = traverserHandle.getBreakState();
      if (innerBreak.shouldBreak) {
        breakFlag.shouldBreak = true;
        if (innerBreak.reason !== undefined && breakFlag.reason === undefined) {
          breakFlag.reason = innerBreak.reason;
        }
        // Raise a parent-level onBreak event so recorders can distinguish
        // the inner originating break (fired inside the subflow) from this
        // propagated one (fired at the mount level on the parent).
        this.deps.narrativeGenerator.onBreak(subflowName, parentTraversalContext, innerBreak.reason, subflowId);
      }
    }

    const subflowTreeContext = nestedRuntime.getSnapshot();

    // ─── Output Mapping ───
    if (!subflowError && mountOptions?.outputMapper) {
      try {
        // The merge-back is the MOUNT's act, so the mount's frame stages and
        // commits it — its bundle carries the mount's runtimeStageId (R13).
        // A branch or fork-child mount still lands its values where its
        // parent writes (the parent's run namespace), as before; until 9.33.0
        // it committed ON the parent's frame, so the bundle named the stage
        // before the mount, or the branching decider.
        const outputContext = parentContext;
        if (parentContext.branchId && parentContext.parent) {
          outputContext.useAddressOf(parentContext.parent);
        }

        const parentScope = outputContext.getScope();
        // For TypedScope subflows, stage functions return void — fall back to a shallow clone
        // of the subflow's shared state so outputMapper can access all scope values written
        // during the subflow. We shallow-clone to avoid aliasing the live SharedMemory context.
        // NOTE: the full scope is passed (not just declared outputs) — outputMapper must
        // explicitly select what to propagate to the parent.
        // Redaction: `applyOutputMapping` writes through `outputContext` (a
        // StageContext, not a facade). The context's write funnel asks the
        // run's redaction rule — shared with the subflow's contexts, so a key
        // the policy names OR a key marked per-call inside the subflow is
        // scrubbed in the PARENT's log and mirror too (9.19.0; before, this
        // merge-back retained plaintext).
        const effectiveOutput = subflowOutput ?? { ...subflowTreeContext.sharedState };
        const mappedOutput = applyOutputMapping(
          effectiveOutput,
          parentScope,
          outputContext,
          mountOptions,
          redactionRule,
        );

        outputContext.commit();
      } catch (error: any) {
        // A merge-back that failed to commit (an uncloneable value) leaves its
        // writes staged on the mount's frame; the mount's exit commit below
        // would throw them again, outside this catch. Through 9.33.0 they
        // were staged on the parent's frame, which was not committed again,
        // so the run went on — drop them, as it did. A linear mount's frame
        // is left as it always was.
        if (parentContext.branchId && parentContext.parent) parentContext.discardStaged();
        parentContext.addError('outputMapperError', thrownText(error));
        this.deps.logger.error(`Error in outputMapper for subflow (${subflowId}):`, {
          error: loggableStageError(parentContext, error),
        });
      }
    }

    const subflowResult: SubflowResult = {
      subflowId,
      subflowName,
      treeContext: {
        globalContext: subflowTreeContext.sharedState,
        stageContexts: subflowTreeContext.executionTree as unknown as Record<string, unknown>,
        history: subflowTreeContext.commitLog,
        ...(subflowTreeContext.logAddress === undefined ? {} : { logAddress: subflowTreeContext.logAddress }),
        // The subflow's own fold base travels with its own log — same
        // contract as the run-level `RuntimeSnapshot.initialState`.
        initialState: subflowTreeContext.initialState,
      },
      parentStageId: parentContext.getStageId(),
    };

    const subflowDef = this.deps.subflows?.[subflowId];
    if (subflowDef && (subflowDef as any).buildTimeStructure) {
      subflowResult.pipelineStructure = (subflowDef as any).buildTimeStructure;
    }

    // The served state (9.20.0): the nested mirror's final state, remembered
    // BESIDE the result — `treeContext.globalContext` stays the live heap for
    // the plain snapshot and the checkpoint; `getSnapshot({ redact: true })`
    // substitutes the mirror through `servedSubflowResults`. Absent without
    // a policy. The exit event below carries the same served view; without a
    // mirror it carries the heap retained under the rule (per-call marks
    // alone keep no mirror) — the same object when nothing is redacted.
    const rawState = subflowResult.treeContext.globalContext;
    const mirrorState = nestedRuntime.redactedStore?.getState();
    if (mirrorState !== undefined) rememberRedactedSubflowState(subflowResult, mirrorState);
    // Handed out whole, so it is a boundary record: nested policy keys are scrubbed too
    // (the mirror's own placeholder, so its top keys keep their bytes).
    const exitState = !redactionRule
      ? mirrorState ?? rawState
      : mirrorState !== undefined
      ? redactionRule.retainBoundary(mirrorState, LOG_PLACEHOLDER)
      : redactionRule.retainBoundary(rawState);

    subflowResultsMap.set(subflowId, subflowResult);
    // Additive per-execution key (design: docs/design/subflow-commit-visibility.md). A LOOPING
    // subflow re-enters with the SAME subflowId, so the path key above is OVERWRITTEN each
    // iteration (back-compat: it holds the LAST iteration — what getSubtreeSnapshot/listSubflowPaths
    // and the eui fallback see, unchanged). ALSO key by the mount's UNIQUE runtimeStageId so EVERY
    // iteration's result is retained and addressable (eui per-loop drill-down, per-scope localization).
    // runtimeStageId always contains '#'; subflowId never does — so they never collide, and
    // listSubflowPaths filters '#' keys to keep its path-only contract. The pause checkpoint filters
    // these out (buildPauseCheckpoint) so it stays lean.
    const mountRuntimeStageId = parentTraversalContext?.runtimeStageId;
    if (mountRuntimeStageId && mountRuntimeStageId !== subflowId) {
      subflowResultsMap.set(mountRuntimeStageId, subflowResult);
    }

    parentContext.addFlowDebugMessage('subflow', `Exiting ${subflowName} subflow`, {
      targetStage: subflowId,
    });
    this.deps.narrativeGenerator.onSubflowExit(subflowName, subflowId, parentTraversalContext, exitState);

    // The mount's EXIT — a continuation of the mount's execution, named as one
    // on the record (9.39.0) so no reader infers it from the log's shape.
    parentContext.commit('exit');

    if (subflowError) {
      throw subflowError.error;
    }

    return subflowOutput;
  }
}
