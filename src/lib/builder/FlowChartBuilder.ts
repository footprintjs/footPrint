/**
 * FlowChartBuilder — Fluent API for constructing flowchart execution graphs.
 *
 * Builds StageNode trees and SerializedPipelineStructure (JSON) in tandem.
 * Zero dependencies on old code — only imports from local types.
 *
 * The builder creates two parallel structures:
 * 1. StageNode tree — runtime graph with embedded functions
 * 2. SerializedPipelineStructure — JSON-safe structure for visualization
 *
 * The execute() convenience method is intentionally omitted —
 * it belongs in the runner layer (Phase 5).
 */

import { joinPath } from 'foottrace';

import { isDevMode } from '../devMode.js';
import { prefixNodeTree } from '../engine/graph/prefixNodeTree.js';
import type { ParallelForEachConfig, RetryPolicy, ScopeFactory } from '../engine/types.js';
import { BRANCH_SEGMENT_MARKER, hasBranchSegmentMarker } from '../ids/branchSegment.js';
import { type IdPosition, refuseReservedId } from '../ids/reservedIds.js';
import type { PausableHandler } from '../pause/types.js';
import type { TypedScope } from '../reactive/types.js';
import { type RunnableFlowChart, makeRunnable } from '../runner/RunnableChart.js';
import type { StructureEdgeKind, StructureRecorder } from './structure/StructureRecorder.js';
import { StructureRecorderDispatcher } from './structure/StructureRecorderDispatcher.js';
import { type TypedStageFunction, createTypedScopeFactory } from './typedFlowChart.js';
import type {
  FlowChart,
  FlowChartOptions,
  FlowChartSpec,
  ILogger,
  SerializedPipelineStructure,
  SimplifiedParallelSpec,
  StageFunction,
  StageNode,
  StreamHandlers,
  StreamLifecycleHandler,
  StreamTokenHandler,
  SubflowMountOptions,
} from './types.js';

// ─────────────────────────────────────────────────────────────────────────────
// Internal helpers
// ─────────────────────────────────────────────────────────────────────────────

const fail = (msg: string): never => {
  throw new Error(`[FlowChartBuilder] ${msg}`);
};

/**
 * Attach a declarative retry policy to a stage node + its spec node.
 *
 * The ONE place a policy lands on a node, shared by the `.retry()` cursor
 * modifier and by every `options.retry` declaration site, so validation and the
 * spec's `retryAttempts` mirror can never drift between them.
 *
 * `attempts` is validated at BUILD time rather than defended at runtime: a
 * typo'd `attempts: 0` should fail while you are writing the chart, not
 * silently turn a stage into a no-op run three months later. `attempts: 1` is
 * accepted on purpose — it means "policy declared, currently off", so a policy
 * can be dialled down without deleting the declaration.
 */
function applyRetryPolicy(
  node: StageNode<any, any>,
  spec: SerializedPipelineStructure,
  retry: RetryPolicy | undefined,
  where: string,
): void {
  if (!retry) return;
  if (typeof retry.attempts !== 'number' || !Number.isInteger(retry.attempts) || retry.attempts < 1) {
    fail(
      `${where}: retry.attempts must be a whole number >= 1 (got ${String(retry.attempts)}). ` +
        'It counts TOTAL runs including the first, so `attempts: 3` means one run plus up to two retries; ' +
        '`attempts: 1` means the policy is declared but currently off.',
    );
  }
  node.retry = retry;
  spec.retryAttempts = retry.attempts;
}

/**
 * Attach declared tags to a stage node + its spec node.
 *
 * The ONE place tags land on a node — the twin of {@link applyRetryPolicy} —
 * shared by the `.tag()` cursor modifier and every `options.tags` declaration
 * site, so the refusals and the spec's mirror can never drift between them.
 *
 * A tag is a NAME declared at build time, never a value, so every refusal is
 * about the name's shape: an empty string names nothing; a non-string is a
 * value, and a value on a stage would ride the commit log past every
 * redaction point; the branch-segment marker is the runtimeStageId grammar's
 * one reserved byte, and a consumer that puts a tag into a path (a URL, a
 * store key) would inherit exactly the ambiguity the reservation exists to
 * prevent; a name declared twice is the typo it usually is. Refused at BUILD
 * time, like `retry.attempts`, so the mistake fails while the chart is being
 * written. An EMPTY list lands nothing: "absent when empty" is the law the
 * commit bundle keeps, and the spec keeps it too.
 */
function applyTags(
  node: StageNode<any, any>,
  spec: SerializedPipelineStructure,
  tags: readonly string[] | undefined,
  where: string,
): void {
  if (tags === undefined) return;
  if (!Array.isArray(tags)) fail(`${where}: tags must be an array of names (got ${typeof tags})`);
  if (tags.length === 0) return;
  const seen = new Set<string>();
  for (const tag of tags) {
    if (typeof tag !== 'string') {
      fail(
        `${where}: a tag must be a string name (got ${tag === null ? 'null' : typeof tag}). A tag is a NAME ` +
          'declared at build time — a value belongs in state or in $emit, never on the stage.',
      );
    }
    if (tag.trim().length === 0) fail(`${where}: a tag cannot be an empty string`);
    if (hasBranchSegmentMarker(tag)) {
      fail(
        `${where}: tag '${tag}' contains the reserved character '${BRANCH_SEGMENT_MARKER}'. ` +
          `'${BRANCH_SEGMENT_MARKER}' is reserved for the subflow path segments addParallelForEach() generates, ` +
          'and a tag that a consumer puts into a path or a key would inherit that ambiguity. Rename the tag ' +
          '(a dash or a colon reads the same). See docs/design/2026-09-declared-tags.md.',
      );
    }
    if (seen.has(tag)) fail(`${where}: tag '${tag}' is declared twice`);
    seen.add(tag);
  }
  if (node.tags) {
    fail(
      `${where}: tags already declared at '${node.name}' (${node.tags.join(', ')}) — declare every tag for a ` +
        'stage in ONE place, so the Map advertises the whole vocabulary from a single site.',
    );
  }
  // The node's copy is frozen: commit bundles share it by reference and the
  // library's reads are borrowed, never mutated. The spec's copy is its own
  // plain array, JSON-safe like the rest of the spec.
  node.tags = Object.freeze([...tags]);
  spec.tags = [...tags];
}

/**
 * The builder's ONE id refusal (F7, R5): every id door calls it once, before
 * the id lands anywhere. The rule lives beside the grammar —
 * `ids/reservedIds.ts · refuseReservedId`: `#` and `/` are refused in
 * every id (they are the runtimeStageId grammar's delimiters), `~` in a
 * `'segment'` id (a subflow id or a `parallelForEach` id — see below).
 *
 * Doors (one call each): `start`, `startSelector`, `addFunction`,
 * `addStreamingFunction`, `addPausableFunction`, `addDeciderFunction`,
 * `addSelectorFunction`, `addListOfFunction` (each child), `addParallelForEach`,
 * every subflow mount (`assertSubflowIdAllowed`) and every decider/selector
 * branch (`BranchCursor · admit`). `addDetachAndForget` /
 * `addDetachAndJoinLater` and `addBranchList` delegate to one of these.
 * Never called by the prefixer or a store — those hold ids that carry the
 * delimiters on purpose.
 */
const admitId = (what: string, id: string, position: IdPosition): void => {
  const refusal = refuseReservedId(what, id, position);
  if (refusal !== undefined) fail(refusal);
};

/**
 * Refuse the reserved characters in a user-authored SUBFLOW id.
 *
 * A subflow id IS a path segment in `runtimeStageId`, which is the same
 * position `addParallelForEach` generates its branch segments into. A
 * hand-authored id carrying the marker could therefore collide with a
 * generated branch — and, because this codebase deliberately tolerates
 * id-collision classes (loop-ref stubs), such a collision would not crash. It
 * would silently mis-attribute a trace, which is worse. So the marker is
 * refused at BUILD time, on NEW charts only: a chart that was legal before
 * 9.14.0 and does not use the marker behaves byte-identically.
 *
 * Called at every user-authored subflow-id entry point. Stage ids elsewhere
 * keep `~` (they occupy the `stageId` position, never the `subflowPath`
 * position, so they cannot collide with a segment) but, since 9.37.0, not `#`
 * or `/` — see `admitId`. (`addParallelForEach`'s own id is the one other
 * `'segment'` id, refused at that method.) Design: docs/design/execution-control.md.
 */
const assertSubflowIdAllowed = (id: string): void => admitId('subflow id', id, 'segment');

// ─────────────────────────────────────────────────────────────────────────────
// BranchCursor — what DeciderList and SelectorFnList share (F7)
// ─────────────────────────────────────────────────────────────────────────────

/** Which dispatcher a {@link BranchCursor} adds branches under. */
type BranchKind = 'decider' | 'selector';

/**
 * The branch-adding mechanics of a decider or a selector — ONE implementation,
 * composed by {@link DeciderList} and {@link SelectorFnList} (until 9.36.0 each
 * list carried its own copy of all four branch kinds and `end()`).
 *
 * Owns: the branch-id ledger (duplicate + reserved-character refusal in one
 * `admit`), the node/spec pair each branch kind builds, the structure events,
 * and the closing `finish`. The lists keep only what differs: a decider's
 * `{ loopTo }` / `loopTo()` / `setDefault`, and the type each method returns.
 */
class BranchCursor<TOut, TScope> {
  readonly branchIds = new Set<string>();
  private readonly branchDescInfo: Array<{ id: string; description?: string }> = [];

  constructor(
    private readonly kind: BranchKind,
    readonly b: FlowChartBuilder<TOut, TScope>,
    readonly curNode: StageNode<TOut, TScope>,
    readonly curSpec: SerializedPipelineStructure,
    readonly parentDescriptionParts: string[],
    private readonly parentStageDescriptions: Map<string, string>,
    private readonly reservedStepNumber: number,
    private readonly description?: string,
  ) {}

  /** The one branch-id door: duplicate refusal, then the reserved characters (R5). */
  private admit(id: string, position: IdPosition): void {
    if (this.branchIds.has(id)) fail(`duplicate ${this.kind} branch id '${id}' under '${this.curNode.name}'`);
    if (position === 'segment') assertSubflowIdAllowed(id);
    else admitId('branch id', id, 'stage');
    this.branchIds.add(id);
  }

  /** Append the branch's node + spec and fire its stage and decision-branch edge. */
  private attach(node: StageNode<TOut, TScope>, spec: SerializedPipelineStructure, id: string): void {
    this.curNode.children = this.curNode.children || [];
    this.curNode.children.push(node);
    this.curSpec.children = this.curSpec.children || [];
    this.curSpec.children.push(spec);
    // L7.3 — branch: stage + decision-branch edge keyed by id.
    this.b._fireStageAddedFromSubBuilder(spec);
    this.b._fireEdgeAddedFromSubBuilder(this.curSpec.id, spec.id, 'decision-branch', id);
  }

  functionBranch(
    id: string,
    name: string,
    fn: StageFunction<TOut, TScope> | undefined,
    description: string | undefined,
    options: { readonly retry?: RetryPolicy; readonly tags?: readonly string[] } | undefined,
  ): { node: StageNode<TOut, TScope>; spec: SerializedPipelineStructure } {
    this.admit(id, 'stage');

    const node: StageNode<TOut, TScope> = { name: name ?? id, id, branchId: id };
    if (description) node.description = description;
    if (fn) {
      node.fn = fn;
    }
    this.b._registerStage(id, fn);

    const spec: SerializedPipelineStructure = { name: name ?? id, id, type: 'stage' };
    if (description) spec.description = description;
    applyRetryPolicy(node, spec, options?.retry, `addFunctionBranch('${id}')`);
    applyTags(node, spec, options?.tags, `addFunctionBranch('${id}')`);

    this.attach(node, spec, id);
    this.branchDescInfo.push({ id, description });
    return { node, spec };
  }

  pausableBranch(
    id: string,
    name: string,
    handler: PausableHandler<TScope>,
    description: string | undefined,
    options: { readonly retry?: RetryPolicy; readonly tags?: readonly string[] } | undefined,
  ): { node: StageNode<TOut, TScope>; spec: SerializedPipelineStructure } {
    this.admit(id, 'stage');

    const node: StageNode<TOut, TScope> = {
      name: name ?? id,
      id,
      branchId: id,
      fn: handler.execute as StageFunction<TOut, TScope>,
      isPausable: true,
      resumeFn: handler.resume,
    };
    if (description) node.description = description;
    this.b._addToMap(id, handler.execute as StageFunction<TOut, TScope>);

    const spec: SerializedPipelineStructure = { name: name ?? id, id, type: 'stage', isPausable: true };
    if (description) spec.description = description;
    applyRetryPolicy(node, spec, options?.retry, `addPausableFunctionBranch('${id}')`);
    applyTags(node, spec, options?.tags, `addPausableFunctionBranch('${id}')`);

    this.attach(node, spec, id);
    this.branchDescInfo.push({ id, description });
    return { node, spec };
  }

  subflowBranch(
    id: string,
    subflow: FlowChart<any, any>,
    mountName: string | undefined,
    options: SubflowMountOptions | undefined,
  ): void {
    this.admit(id, 'segment');

    const subflowName = mountName || id;
    this.b._mountSubflow(id, subflow, () => this.placeSubflowBranch(id, subflow, subflowName, options));
  }

  /** The branch mount's own node + spec, placed under the decider/selector (see `_mountSubflow`). */
  private placeSubflowBranch(
    id: string,
    subflow: FlowChart<any, any>,
    subflowName: string,
    options: SubflowMountOptions | undefined,
  ): void {
    const node: StageNode<TOut, TScope> = {
      name: subflowName,
      id,
      branchId: id,
      isSubflowRoot: true,
      subflowId: id,
      subflowName,
    };
    if (options) node.subflowMountOptions = options;

    const spec: SerializedPipelineStructure = {
      name: subflowName,
      type: 'stage',
      id,
      isSubflowRoot: true,
      subflowId: id,
      subflowName,
      subflowStructure: subflow.buildTimeStructure,
    };
    // STRUCTURE-ONLY convergence override (see `_fireNextEdgeFromParent` +
    // `SubflowMountOptions.convergeAt`): this branch's convergence edge points at
    // `convergeAt` (a DOWNSTREAM stage) instead of the shared next stage — e.g. a
    // `tools` slot that bypasses `messageAPI` to pair with its output at
    // `call-llm`. Visualization-only: NO runtime join barrier (data rides scope).
    // Carried on the spec so the edge-firing chokepoint can read it.
    if (options?.convergeAt) spec.convergeAt = options.convergeAt;

    applyTags(node, spec, options?.tags, `addSubFlowChartBranch('${id}')`);

    this.attach(node, spec, id);
    this.b._fireSubflowMountedFromSubBuilder(id, subflowName, id, false, subflow.buildTimeStructure);
  }

  lazySubflowBranch(
    id: string,
    resolver: () => FlowChart<any, any>,
    mountName: string | undefined,
    options: SubflowMountOptions | undefined,
  ): void {
    this.admit(id, 'segment');
    this.b._claimFreshId(id, `addLazySubFlowChartBranch('${id}')`);

    const subflowName = mountName || id;

    // Store resolver on the node — NO eager tree cloning
    const node: StageNode<TOut, TScope> = {
      name: subflowName,
      id,
      branchId: id,
      isSubflowRoot: true,
      subflowId: id,
      subflowName,
      subflowResolver: resolver as any,
    };
    if (options) node.subflowMountOptions = options;

    // Spec stub — no subflowStructure (lazy). The lazy subflow's
    // internals will be shaped at resolution time.
    const spec: SerializedPipelineStructure = {
      name: subflowName,
      type: 'stage',
      id,
      isSubflowRoot: true,
      subflowId: id,
      subflowName,
      isLazy: true,
    };

    applyTags(node, spec, options?.tags, `addLazySubFlowChartBranch('${id}')`);

    this.attach(node, spec, id);
    this.b._fireSubflowMountedFromSubBuilder(id, subflowName, id, true);
  }

  /**
   * Close the dispatcher: validate the branches, flag the node, describe it,
   * and fire `onDeciderComplete`. A decider passes its `setDefault` id (the
   * synthetic `'default'` clone is appended AFTER `branchIds` is taken, so only
   * user-specified branches are listed); a selector has no default.
   */
  finish(defaultId?: string): FlowChartBuilder<TOut, TScope> {
    const kind = this.kind;
    const children = this.curNode.children;
    if (!children || children.length === 0) {
      throw new Error(`[FlowChartBuilder] ${kind} at '${this.curNode.name}' requires at least one branch`);
    }

    // Validate that every branch with no embedded fn is resolvable from the stageMap
    for (const child of children) {
      if (!child.fn && child.id && !child.isSubflowRoot && !child.subflowResolver) {
        const hasInMap = this.b._stageMapHas(child.id) || this.b._stageMapHas(child.name);
        if (!hasInMap) {
          throw new Error(
            `[FlowChartBuilder] ${kind} branch '${child.id}' under '${this.curNode.name}' has no function — ` +
              `provide a fn argument to addFunctionBranch('${child.id}', ...)`,
          );
        }
      }
    }

    if (kind === 'decider') this.curNode.deciderFn = true;
    else this.curNode.selectorFn = true;

    this.curSpec.branchIds = children
      .map((c) => c.id)
      .filter((id): id is string => typeof id === 'string' && id.length > 0);
    this.curSpec.type = kind;
    if (kind === 'selector') this.curSpec.hasSelector = true;

    if (defaultId) {
      const defaultChild = children.find((c) => c.id === defaultId);
      if (defaultChild) {
        children.push({ ...defaultChild, id: 'default', branchId: 'default' });
      }
    }

    if (this.reservedStepNumber > 0) {
      const label = this.curNode.name;
      const branchIdList = this.branchDescInfo.map((b) => b.id).join(', ');
      const mainLine =
        kind === 'decider'
          ? this.description
            ? `${this.reservedStepNumber}. ${label} — ${this.description} (branches: ${branchIdList})`
            : `${this.reservedStepNumber}. ${label} — Decides between: ${branchIdList}`
          : this.description
          ? `${this.reservedStepNumber}. ${label} — ${this.description}`
          : `${this.reservedStepNumber}. ${label} — Selects from: ${branchIdList}`;
      this.parentDescriptionParts.push(mainLine);

      if (this.description) {
        this.parentStageDescriptions.set(this.curNode.name, this.description);
      }

      for (const branch of this.branchDescInfo) {
        if (branch.description) this.parentDescriptionParts.push(`   → ${branch.id}: ${branch.description}`);
        if (branch.description) this.parentStageDescriptions.set(branch.id, branch.description);
      }
    }

    // L7.3 — fire `onDeciderComplete` so consumers can trust no more
    // branches will arrive. Branch iteration order = addition order = Set
    // insertion order. Selectors have no default branch.
    if (kind === 'decider') {
      this.b._fireDeciderCompleteFromSubBuilder(this.curSpec.id, 'decider', [...this.branchIds], defaultId);
    } else {
      this.b._fireDeciderCompleteFromSubBuilder(this.curSpec.id, 'selector', [...this.branchIds]);
    }
    return this.b;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// DeciderList
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Fluent helper returned by addDeciderFunction to add branches.
 * `end()` sets `deciderFn = true` — the fn IS the decider.
 */
export class DeciderList<TOut = any, TScope = any> {
  private readonly cursor: BranchCursor<TOut, TScope>;
  private defaultId?: string;

  constructor(
    builder: FlowChartBuilder<TOut, TScope>,
    curNode: StageNode<TOut, TScope>,
    curSpec: SerializedPipelineStructure,
    parentDescriptionParts: string[] = [],
    parentStageDescriptions: Map<string, string> = new Map(),
    reservedStepNumber = 0,
    deciderDescription?: string,
  ) {
    this.cursor = new BranchCursor(
      'decider',
      builder,
      curNode,
      curSpec,
      parentDescriptionParts,
      parentStageDescriptions,
      reservedStepNumber,
      deciderDescription,
    );
  }

  addFunctionBranch(
    id: string,
    name: string,
    fn?: StageFunction<TOut, TScope>,
    description?: string,
    /** `{ loopTo }` declares this branch loops back to an already-declared
     *  stage — the loop is SOURCED FROM THIS BRANCH (not the decider).
     *  `{ retry }` gives THIS BRANCH's stage a declarative retry policy;
     *  `{ tags }` puts declared tags on it (see `FlowChartBuilder.tag`). */
    options?: { readonly loopTo?: string; readonly retry?: RetryPolicy; readonly tags?: readonly string[] },
  ): DeciderList<TOut, TScope> {
    const { node, spec } = this.cursor.functionBranch(id, name, fn, description, options);
    if (options?.loopTo) this._applyBranchLoop(node, spec, options.loopTo);
    return this;
  }

  /**
   * Add a pausable stage as a decider branch.
   *
   * When this branch is chosen, the handler's `execute` runs. If it returns
   * data, the pipeline pauses. On resume, `handler.resume` runs with the
   * human's input. If `execute` returns void, the stage continues normally
   * (conditional pause).
   */
  addPausableFunctionBranch(
    id: string,
    name: string,
    handler: PausableHandler<TScope>,
    description?: string,
    /** `{ loopTo }` declares this branch loops back to an already-declared
     *  stage — the loop is SOURCED FROM THIS BRANCH (not the decider).
     *  `{ retry }` gives THIS BRANCH's `execute` half a retry policy (the
     *  `resume` half runs without it — a different function, a different
     *  contract); `{ tags }` puts declared tags on it. */
    options?: { readonly loopTo?: string; readonly retry?: RetryPolicy; readonly tags?: readonly string[] },
  ): DeciderList<TOut, TScope> {
    const { node, spec } = this.cursor.pausableBranch(id, name, handler, description, options);
    if (options?.loopTo) this._applyBranchLoop(node, spec, options.loopTo);
    return this;
  }

  addSubFlowChartBranch(
    id: string,
    subflow: FlowChart<any, any>,
    mountName?: string,
    options?: SubflowMountOptions,
  ): DeciderList<TOut, TScope> {
    this.cursor.subflowBranch(id, subflow, mountName, options);
    return this;
  }

  addLazySubFlowChartBranch(
    id: string,
    resolver: () => FlowChart<any, any>,
    mountName?: string,
    options?: SubflowMountOptions,
  ): DeciderList<TOut, TScope> {
    this.cursor.lazySubflowBranch(id, resolver, mountName, options);
    return this;
  }

  addBranchList(
    branches: Array<{
      id: string;
      name: string;
      fn?: StageFunction<TOut, TScope>;
    }>,
  ): DeciderList<TOut, TScope> {
    for (const { id, name, fn } of branches) {
      this.addFunctionBranch(id, name, fn);
    }
    return this;
  }

  setDefault(id: string): DeciderList<TOut, TScope> {
    this.defaultId = id;
    return this;
  }

  /**
   * Attach a loop-back edge to the LAST-added branch, so the loop is sourced
   * from THAT branch node (e.g. `'tool-calls' → loopTo('context')`) rather than
   * from the decider. The chart then reads honestly: the decider splits into a
   * looping branch `[ToolCalls → back to Context]` and a terminating branch
   * `[Final → end]`, instead of a single loop hanging off the decider.
   *
   * No engine change is needed: the runtime runs the chosen branch and then
   * follows that branch node's OWN `next` — and a `next` flagged `isLoopRef`
   * routes back to the target exactly like the decider's own loop does. This
   * method just lets the builder express what the engine already supports.
   *
   * Targets the branch added immediately before this call (chain it right after
   * the branch's `addFunctionBranch`/`addPausableFunctionBranch`/
   * `addSubFlowChartBranch`). Mirrors `FlowChartBuilder.loopTo` validation.
   *
   * Works on a SUBFLOW branch too: the branch node carries both its subflow
   * resolver AND the loop-back `next` — they coexist safely (the runtime runs
   * the subflow, then follows the loop ref). The target must be a stage already
   * declared BEFORE the decider (e.g. an upstream `context`); branch ids and the
   * synthetic `'default'` clone are NOT valid loop targets.
   */
  loopTo(stageId: string): DeciderList<TOut, TScope> {
    const children = this.cursor.curNode.children;
    const specChildren = this.cursor.curSpec.children;
    if (!children || children.length === 0 || !specChildren || specChildren.length === 0) {
      fail(`loopTo('${stageId}') called before any branch was added under '${this.cursor.curNode.name}'`);
    }
    // fail() throws, so children/specChildren are non-empty here.
    this._applyBranchLoop(children![children!.length - 1]!, specChildren![specChildren!.length - 1]!, stageId);
    return this;
  }

  /**
   * Decorate ONE branch node/spec with a loop-back edge to `stageId`. Shared by
   * the positional `loopTo()` (which targets the last-added branch) AND the
   * per-branch `{ loopTo }` option on `addFunctionBranch` /
   * `addPausableFunctionBranch` / `addSubFlowChartBranch`. Either way the loop
   * SOURCE is the branch — so visualizers read `tool-calls → context`, never
   * `Route → context`. Validates the target is a stage declared BEFORE the
   * decider (branch ids / the synthetic 'default' clone are not valid targets).
   */
  private _applyBranchLoop(
    branchNode: StageNode<TOut, TScope>,
    branchSpec: SerializedPipelineStructure,
    stageId: string,
  ): void {
    if (branchSpec.loopTarget) fail(`loopTo already defined on branch '${branchSpec.id}'`);
    if (branchNode.next) {
      fail(`cannot set loopTo on branch '${branchSpec.id}' — it already has a continuation`);
    }
    if (!this.cursor.b._knownStageIdsHas(stageId)) {
      fail(
        `loopTo('${stageId}') target not found — a branch loop must target a stage ` +
          "declared BEFORE the decider (branch ids and the synthetic 'default' branch " +
          'are not valid loop targets; did you pass a stage name instead of an id?)',
      );
    }

    branchNode.next = { name: stageId, id: stageId, isLoopRef: true };
    branchSpec.loopTarget = stageId;
    branchSpec.next = { name: stageId, id: stageId, type: 'loop', isLoopReference: true };

    // Branch-scoped description — attribute the loop to the branch, not the
    // decider (parentDescriptionParts is the decider's description context).
    this.cursor.parentDescriptionParts.push(`   → branch '${branchSpec.id}' loops back to ${stageId}`);

    // Fire the loop back-edge SOURCED FROM THE BRANCH so visualizers read
    // `tool-calls → context`, not `Route → context`.
    this.cursor.b._fireLoopEdgeAddedFromSubBuilder(branchSpec.id, stageId);
  }

  end(): FlowChartBuilder<TOut, TScope> {
    return this.cursor.finish(this.defaultId);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// SelectorFnList (scope-based selector — mirrors DeciderList)
// ─────────────────────────────────────────────────────────────────────────────

export class SelectorFnList<TOut = any, TScope = any> {
  private readonly cursor: BranchCursor<TOut, TScope>;

  constructor(
    builder: FlowChartBuilder<TOut, TScope>,
    curNode: StageNode<TOut, TScope>,
    curSpec: SerializedPipelineStructure,
    parentDescriptionParts: string[] = [],
    parentStageDescriptions: Map<string, string> = new Map(),
    reservedStepNumber = 0,
    selectorDescription?: string,
  ) {
    this.cursor = new BranchCursor(
      'selector',
      builder,
      curNode,
      curSpec,
      parentDescriptionParts,
      parentStageDescriptions,
      reservedStepNumber,
      selectorDescription,
    );
  }

  addFunctionBranch(
    id: string,
    name: string,
    fn?: StageFunction<TOut, TScope>,
    description?: string,
    /** `{ retry }` gives THIS BRANCH's stage a declarative retry policy;
     *  `{ tags }` puts declared tags on it (see `FlowChartBuilder.tag`). */
    options?: { readonly retry?: RetryPolicy; readonly tags?: readonly string[] },
  ): SelectorFnList<TOut, TScope> {
    this.cursor.functionBranch(id, name, fn, description, options);
    return this;
  }

  /**
   * Add a pausable stage as a selector branch.
   *
   * When this branch is selected, the handler's `execute` runs. If it returns
   * data, the pipeline pauses. On resume, `handler.resume` runs with the
   * human's input. If `execute` returns void, the stage continues normally.
   */
  addPausableFunctionBranch(
    id: string,
    name: string,
    handler: PausableHandler<TScope>,
    description?: string,
    /** `{ retry }` gives THIS BRANCH's `execute` half a retry policy (the
     *  `resume` half runs without it — a different function, a different
     *  contract); `{ tags }` puts declared tags on it. */
    options?: { readonly retry?: RetryPolicy; readonly tags?: readonly string[] },
  ): SelectorFnList<TOut, TScope> {
    this.cursor.pausableBranch(id, name, handler, description, options);
    return this;
  }

  addSubFlowChartBranch(
    id: string,
    subflow: FlowChart<any, any>,
    mountName?: string,
    options?: SubflowMountOptions,
  ): SelectorFnList<TOut, TScope> {
    this.cursor.subflowBranch(id, subflow, mountName, options);
    return this;
  }

  addLazySubFlowChartBranch(
    id: string,
    resolver: () => FlowChart<any, any>,
    mountName?: string,
    options?: SubflowMountOptions,
  ): SelectorFnList<TOut, TScope> {
    this.cursor.lazySubflowBranch(id, resolver, mountName, options);
    return this;
  }

  addBranchList(
    branches: Array<{
      id: string;
      name: string;
      fn?: StageFunction<TOut, TScope>;
    }>,
  ): SelectorFnList<TOut, TScope> {
    for (const { id, name, fn } of branches) {
      this.addFunctionBranch(id, name, fn);
    }
    return this;
  }

  end(): FlowChartBuilder<TOut, TScope> {
    return this.cursor.finish();
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// FlowChartBuilder
// ─────────────────────────────────────────────────────────────────────────────

export class FlowChartBuilder<TOut = any, TScope = any> {
  private _root?: StageNode<TOut, TScope>;
  private _rootSpec?: SerializedPipelineStructure;
  private _cursor?: StageNode<TOut, TScope>;
  private _cursorSpec?: SerializedPipelineStructure;
  private _stageMap = new Map<string, StageFunction<TOut, TScope>>();
  _subflowDefs = new Map<string, { root: StageNode<TOut, TScope> }>();
  private _streamHandlers: StreamHandlers = {};
  /**
   * L7.3 — Build-time observer fan-out. Owned by the builder so every
   * `addX()` method can fire `StructureRecorder` events at the natural
   * moment of the corresponding mutation. Dispatcher is allocated
   * lazily on first attach to keep the zero-recorder path allocation-
   * free.
   */
  private _structureDispatcher?: StructureRecorderDispatcher;
  /**
   * L7.3 — Sealed-after-build flag (Panel 2 phase invariant). Flips
   * to `true` when `.build()` returns; subsequent `attachStructureRecorder`
   * throws. Prevents the footgun where a consumer attaches a recorder
   * mid-execution and gets partial structure data (missed every event
   * already fired during construction).
   */
  private _sealed = false;
  private _enableNarrative = false;
  private _logger?: ILogger;
  private _descriptionParts: string[] = [];
  private _stepCounter = 0;
  // NOTE: keyed by stage name (for human-readable descriptions), while stageMap
  // and knownStageIds use id (stable identifier). These are intentionally different
  // namespaces — descriptions are presentational, lookups are structural.
  private _stageDescriptions = new Map<string, string>();
  private _stageStepMap = new Map<string, number>();
  private _knownStageIds = new Set<string>();
  private _inputSchema?: unknown;
  private _outputSchema?: unknown;
  private _outputMapper?: (finalScope: Record<string, unknown>) => unknown;
  private _scopeFactory?: ScopeFactory<TScope>;

  // ── L7.3 — StructureRecorder attach + dispatch helpers ──────────────────

  /**
   * Attach a `StructureRecorder` for build-phase observation. Multiple
   * recorders coexist (same id allowed; iteration order = attach
   * order). Throws if called after `.build()` — the chart is sealed at
   * that point and any recorder attached late would miss every event
   * fired during construction.
   *
   * **Seed replay**: when this is called AFTER `start()` has already
   * fired (i.e., after the `flowChart()` factory returns), the
   * just-attached recorder receives a one-time `onStageAdded` for the
   * root stage so it observes the seed. Only the new recorder sees
   * the replay; already-attached recorders are not re-fired.
   *
   * **Mid-chain attach caveat**: a recorder attached AFTER one or more
   * `addX()` calls receives the seed replay but MISSES every
   * intermediate event. Attach BEFORE the first `addX()` for complete
   * capture.
   *
   * Public for now to enable direct attach in tests + early consumers.
   * L7.4 will wire `flowChart(..., { structureRecorders: [...] })` as
   * an additional registration site; this method will remain.
   */
  attachStructureRecorder(recorder: StructureRecorder): this {
    if (this._sealed) {
      throw new Error(
        `[FlowChartBuilder] attachStructureRecorder('${recorder.id}') called after .build() — chart is sealed; ` +
          'the recorder would miss every structure event from construction. Attach BEFORE .build().',
      );
    }
    if (!this._structureDispatcher) {
      this._structureDispatcher = new StructureRecorderDispatcher();
    }
    this._structureDispatcher.attach(recorder);
    // The seed fires inside `start()` — that runs BEFORE the consumer
    // can post-construct attach. Replay the seed event ONLY into the
    // just-attached recorder so other already-attached recorders don't
    // see a duplicate. Errors are routed through the dispatcher's
    // accumulator so the contract stays uniform.
    if (this._rootSpec) {
      try {
        recorder.onStageAdded?.({
          stageId: this._rootSpec.id,
          name: this._rootSpec.name,
          type: this._rootSpec.type ?? 'stage',
          ...(this._rootSpec.isPausable === true && { isPausable: true }),
          ...(this._rootSpec.tags !== undefined && { tags: [...this._rootSpec.tags] }),
          spec: this._rootSpec as unknown as FlowChartSpec,
        });
      } catch (err) {
        this._structureDispatcher.recordErrorForReplay(recorder.id, 'onStageAdded', err);
      }
    }
    return this;
  }

  /**
   * Inspect accumulated `StructureBuildError`s. Returns empty array
   * when no recorders attached OR no errors occurred. Returns a
   * defensive copy — caller mutations do not affect subsequent calls.
   *
   * **Call on the BUILDER, not the chart returned by `.build()`.**
   * Capture the builder reference before `.build()` if you need
   * post-build access:
   * ```ts
   * const builder = flowChart(...).attachStructureRecorder(rec);
   * const chart = builder.build();
   * const errors = builder.getStructureBuildErrors();
   * ```
   */
  getStructureBuildErrors(): ReturnType<StructureRecorderDispatcher['getErrors']> {
    return this._structureDispatcher?.getErrors() ?? [];
  }

  // Convenience fire helpers — no-op when no dispatcher attached. Keeps
  // every call site a one-liner without the `if (this._structureDispatcher)`
  // boilerplate everywhere.
  private _fireStageAdded(spec: SerializedPipelineStructure): void {
    if (!this._structureDispatcher) return;
    // Read `isPausable` directly from the spec — single source of truth.
    // The previous `extras` argument was a sub-builder footgun: branch
    // helpers in DeciderList/SelectorFnList went through
    // `_fireStageAddedFromSubBuilder` which dropped the extras, silently
    // losing `isPausable: true` on pausable decider/selector branches.
    const isPausable = spec.isPausable === true;
    this._structureDispatcher.fireStageAdded({
      stageId: spec.id,
      name: spec.name,
      type: spec.type ?? 'stage',
      ...(isPausable && { isPausable: true }),
      ...(spec.tags !== undefined && { tags: [...spec.tags] }),
      spec: spec as unknown as FlowChartSpec,
    });
  }

  private _fireStageTagged(spec: SerializedPipelineStructure): void {
    if (!this._structureDispatcher || spec.tags === undefined) return;
    this._structureDispatcher.fireStageTagged({
      stageId: spec.id,
      name: spec.name,
      tags: [...spec.tags],
      spec: spec as unknown as FlowChartSpec,
    });
  }

  private _fireEdgeAdded(from: string, to: string, kind: StructureEdgeKind, label?: string): void {
    if (!this._structureDispatcher) return;
    this._structureDispatcher.fireEdgeAdded({
      from,
      to,
      kind,
      ...(label !== undefined && { label }),
    });
  }

  private _fireLoopEdgeAdded(from: string, to: string): void {
    if (!this._structureDispatcher) return;
    this._structureDispatcher.fireLoopEdgeAdded({ from, to });
  }

  /**
   * Fire the `next` edge(s) from a parent spec to a freshly-added
   * node — with convergence expansion when the parent is a
   * fork / decider / selector with branches.
   *
   * A fork at `parent` is semantically `parent ──fork-branch──► child[i]`
   * for each child, and the chained `.addFunction(X)` continues
   * AFTER the fork converges. The runtime semantics are that each
   * child INDEPENDENTLY feeds `X` (parallel completion → join). The
   * literal "edge from parent to X" would misrepresent this —
   * visualizers and topological algorithms would see one edge where
   * there should be N convergence edges.
   *
   * Fix: when `parentSpec` has branch children (fork or branched
   * decider/selector), fire one `next` edge from EACH child to the
   * target. Otherwise fire the single edge from `parentSpec` itself.
   *
   * Loop-reference children (synthetic spec nodes created by
   * `.loopTo()`) are excluded — they're back-edge markers, not
   * convergence sources. A branch that carries an OWN loop-back `next`
   * (a branch-sourced `loopTo`) is likewise skipped — it loops, it does
   * not converge at the linear next stage.
   *
   * A branch carrying `convergeAt` is REDIRECTED: its single convergence
   * edge fires to its named target instead of `targetId` — expressing an
   * unequal-depth merge (e.g. `tools → call-llm`, bypassing `message-api`).
   * The named target is a forward stage, so it is NOT validated here.
   *
   * Call ORDER constraint: must be called BEFORE the cursor advances
   * to the new target. The caller passes the PRE-ADVANCE parent spec.
   */
  private _fireNextEdgeFromParent(parentSpec: SerializedPipelineStructure, targetId: string, label?: string): void {
    if (!this._structureDispatcher) return;
    const childSpecs = parentSpec.children;
    const isBranchingParent =
      (parentSpec.type === 'fork' || parentSpec.type === 'decider' || parentSpec.type === 'selector') &&
      Array.isArray(childSpecs) &&
      childSpecs.length > 0;
    if (!isBranchingParent) {
      this._fireEdgeAdded(parentSpec.id, targetId, 'next', label);
      return;
    }
    for (const child of childSpecs!) {
      if (child.isLoopReference) continue;
      // A branch with its own loop-back next (branch-sourced loopTo) loops —
      // it does not converge at the linear next stage.
      if (child.next?.isLoopReference) continue;
      if (child.convergeAt) {
        // Redirected convergence: this branch rejoins at its named target.
        this._fireEdgeAdded(child.id, child.convergeAt, 'next');
        continue;
      }
      this._fireEdgeAdded(child.id, targetId, 'next', label);
    }
  }

  private _fireDeciderComplete(
    decider: string,
    type: 'decider' | 'selector',
    branchIds: string[],
    defaultBranch?: string,
  ): void {
    if (!this._structureDispatcher) return;
    this._structureDispatcher.fireDeciderComplete({
      decider,
      type,
      branchIds,
      ...(defaultBranch !== undefined && { defaultBranch }),
    });
  }

  private _fireSubflowMounted(
    subflowId: string,
    subflowName: string,
    rootStageId: string,
    isLazy?: boolean,
    subflowSpec?: SerializedPipelineStructure,
    subflowPath?: string,
  ): void {
    if (!this._structureDispatcher) return;
    // subflowPath defaults to subflowId when the recorder is attached
    // to the immediate parent (top-level mount); composed paths apply
    // only when this builder is itself a nested subflow being
    // observed by the grandparent's recorder.
    const path = subflowPath ?? subflowId;
    this._structureDispatcher.fireSubflowMounted({
      subflowId,
      subflowName,
      rootStageId,
      ...(isLazy === true && { isLazy }),
      ...(subflowSpec !== undefined && { subflowSpec }),
      subflowPath: path,
    });
  }

  /** Sub-builder access (`.b._fireXxx`) is needed by DeciderList /
   *  SelectorFnList; expose the dispatcher through internal helpers
   *  that go through the same no-op-when-absent guard.
   *
   *  @internal — these methods are exposed because TypeScript `private`
   *  doesn't traverse class boundaries. Consumer code MUST NOT call
   *  them; calling them post-construction lets a hostile caller
   *  fabricate structure events and corrupt downstream visualizations
   *  or audit trails. The `_` prefix is intentional convention. */
  _fireEdgeAddedFromSubBuilder(from: string, to: string, kind: StructureEdgeKind, label?: string): void {
    this._fireEdgeAdded(from, to, kind, label);
  }

  /** @internal — see `_fireEdgeAddedFromSubBuilder`. */
  _fireStageAddedFromSubBuilder(spec: SerializedPipelineStructure): void {
    this._fireStageAdded(spec);
  }

  /** @internal — see `_fireEdgeAddedFromSubBuilder`. */
  _fireDeciderCompleteFromSubBuilder(
    decider: string,
    type: 'decider' | 'selector',
    branchIds: string[],
    defaultBranch?: string,
  ): void {
    this._fireDeciderComplete(decider, type, branchIds, defaultBranch);
  }

  /** @internal — see `_fireEdgeAddedFromSubBuilder`. */
  _fireSubflowMountedFromSubBuilder(
    subflowId: string,
    subflowName: string,
    rootStageId: string,
    isLazy?: boolean,
    subflowSpec?: SerializedPipelineStructure,
    subflowPath?: string,
  ): void {
    this._fireSubflowMounted(subflowId, subflowName, rootStageId, isLazy, subflowSpec, subflowPath);
  }

  /** @internal — see `_fireEdgeAddedFromSubBuilder`. Used by `DeciderList.loopTo`
   *  to validate a branch-sourced loop target against the known stage ids
   *  (mirrors `FlowChartBuilder.loopTo`'s `_knownStageIds.has` guard). */
  _knownStageIdsHas(id: string): boolean {
    return this._knownStageIds.has(id);
  }

  /** @internal — see `_fireEdgeAddedFromSubBuilder`. Used by `DeciderList.loopTo`
   *  to fire a loop back-edge SOURCED FROM A BRANCH node (not the decider). */
  _fireLoopEdgeAddedFromSubBuilder(from: string, to: string): void {
    this._fireLoopEdgeAdded(from, to);
  }

  // ── Description helpers ──

  private _appendDescriptionLine(name: string, description?: string): void {
    this._stepCounter++;
    this._stageStepMap.set(name, this._stepCounter);
    const line = description ? `${this._stepCounter}. ${name} — ${description}` : `${this._stepCounter}. ${name}`;
    this._descriptionParts.push(line);
    if (description) {
      this._stageDescriptions.set(name, description);
    }
  }

  private _appendSubflowDescription(id: string, name: string, subflow: FlowChart<any, any>): void {
    this._stepCounter++;
    this._stageStepMap.set(id, this._stepCounter);
    if (subflow.description) {
      const lines = subflow.description.split('\n');
      const stepsIdx = lines.findIndex((l) => l.startsWith('Steps:'));
      if (stepsIdx >= 0) {
        // Builder-composed description (`FlowChart: X\nSteps:\n...`).
        // Inline ONLY the summary above `Steps:` on the mount line, then
        // re-list the step lines once, indented. Embedding the FULL inner
        // description here AND re-listing its steps doubled the text per
        // nesting level — exponential growth, RangeError ("Invalid string
        // length") at ~22 nesting levels of nested build().
        const summary = lines.slice(0, stepsIdx).join(' ').trim();
        this._descriptionParts.push(
          summary
            ? `${this._stepCounter}. [Sub-Execution: ${name}] — ${summary}`
            : `${this._stepCounter}. [Sub-Execution: ${name}]`,
        );
        for (let i = stepsIdx + 1; i < lines.length; i++) {
          if (lines[i].trim()) this._descriptionParts.push(`   ${lines[i]}`);
        }
      } else {
        // Free-form (single-block) description — inline it whole, unchanged.
        this._descriptionParts.push(`${this._stepCounter}. [Sub-Execution: ${name}] — ${subflow.description}`);
      }
    } else {
      this._descriptionParts.push(`${this._stepCounter}. [Sub-Execution: ${name}]`);
    }
  }

  // ── Configuration ──

  setLogger(logger: ILogger): this {
    this._logger = logger;
    return this;
  }

  /**
   * Declare the API contract — input validation, output shape, and output mapper.
   * Replaces setInputSchema() + setOutputSchema() + setOutputMapper() in a single call.
   *
   * If a contract with input schema is declared, chart.run() validates input automatically.
   * Contract data is used by chart.toOpenAPI() and chart.toMCPTool().
   */
  contract(opts: {
    input?: unknown;
    output?: unknown;
    mapper?: (finalScope: Record<string, unknown>) => unknown;
  }): this {
    if (opts.input) this._inputSchema = opts.input;
    if (opts.output) this._outputSchema = opts.output;
    if (opts.mapper) this._outputMapper = opts.mapper;
    return this;
  }

  // ── Linear Chaining ──

  start(
    name: string,
    fn: StageFunction<TOut, TScope> | PausableHandler<TScope>,
    id: string,
    description?: string,
    options?: { retry?: RetryPolicy; tags?: readonly string[] },
  ): this {
    admitId('stage id', id, 'stage');
    if (this._root) fail('root already defined; create a new builder');

    // Detect PausableHandler by duck-typing (has .execute property)
    // eslint-disable-next-line no-restricted-syntax
    const isPausable = typeof fn === 'object' && fn !== null && 'execute' in fn;
    const stageFn = isPausable
      ? ((fn as PausableHandler<TScope>).execute as StageFunction<TOut, TScope>)
      : (fn as StageFunction<TOut, TScope>);

    const node: StageNode<TOut, TScope> = { name, id, fn: stageFn };
    if (isPausable) {
      node.isPausable = true;
      node.resumeFn = (fn as PausableHandler<TScope>).resume;
    }
    if (description) node.description = description;
    this._addToMap(id, stageFn);

    const spec: SerializedPipelineStructure = { name, id, type: 'stage' };
    if (isPausable) spec.isPausable = true;
    if (description) spec.description = description;
    applyRetryPolicy(node, spec, options?.retry, `start('${id}')`);
    applyTags(node, spec, options?.tags, `start('${id}')`);

    this._root = node;
    this._rootSpec = spec;
    this._cursor = node;
    this._advanceCursorSpec(spec);
    this._knownStageIds.add(id);

    // L7.3 — Seed node fires `onStageAdded` (no edge — no predecessor).
    // `isPausable` is read directly from the spec by `_fireStageAdded`.
    this._fireStageAdded(spec);

    this._appendDescriptionLine(name, description);
    return this;
  }

  /**
   * Start a chart whose ROOT stage IS a selector — it runs first (reading
   * args, seeding state, returning the chosen branch ids via `select()`),
   * and its branches attach directly to the root. Mirrors `start()` for the
   * root-node setup, then returns a `SelectorFnList` bound to the root so
   * `.addFunctionBranch()` / `.addSubFlowChartBranch()` / `.end()` work
   * exactly as they do after `addSelectorFunction()`.
   *
   * Use when the first thing a chart does is choose among branches — e.g. a
   * `Context` selector that inits + picks which context slots to engineer,
   * with no separate seed stage before it.
   */
  startSelector(
    name: string,
    fn: StageFunction<any, TScope>,
    id: string,
    description?: string,
    options?: { failFast?: boolean; retry?: RetryPolicy; tags?: readonly string[] },
  ): SelectorFnList<TOut, TScope> {
    admitId('stage id', id, 'stage');
    if (this._root) fail('root already defined; create a new builder');

    const node: StageNode<TOut, TScope> = { name, id, fn: fn as StageFunction<TOut, TScope> };
    if (description) node.description = description;
    // See `addSelectorFunction` — `failFast: true` makes a multi-branch
    // selection fan out via `Promise.all` (first error aborts) instead of the
    // default `Promise.allSettled` (best-effort).
    if (options?.failFast) node.failFast = true;
    this._addToMap(id, fn as StageFunction<TOut, TScope>);

    const spec: SerializedPipelineStructure = { name, id, type: 'stage', hasSelector: true };
    if (description) spec.description = description;
    applyRetryPolicy(node, spec, options?.retry, `startSelector('${id}')`);
    applyTags(node, spec, options?.tags, `startSelector('${id}')`);

    this._root = node;
    this._rootSpec = spec;
    this._cursor = node;
    this._advanceCursorSpec(spec);
    this._knownStageIds.add(id);

    // Root selector node fires onStageAdded with NO predecessor edge (it's
    // the root). Branches + onDeciderComplete come from the SelectorFnList.
    this._fireStageAdded(spec);

    this._stepCounter++;
    this._stageStepMap.set(name, this._stepCounter);
    this._appendDescriptionLine(name, description);

    return new SelectorFnList<TOut, TScope>(
      this,
      node,
      spec,
      this._descriptionParts,
      this._stageDescriptions,
      this._stepCounter,
      description,
    );
  }

  addFunction(name: string, fn: StageFunction<TOut, TScope>, id: string, description?: string): this {
    admitId('stage id', id, 'stage');
    const cur = this._needCursor();
    const curSpec = this._needCursorSpec();
    // Capture the parent SPEC reference (not just id) BEFORE the
    // cursor advances — we need its `children` + `type` to decide
    // whether the `next` edge is a fork convergence (N edges from
    // each branch child) vs a plain linear chain (1 edge from parent).
    const parentSpec = curSpec;

    const node: StageNode<TOut, TScope> = { name, id, fn };
    if (description) node.description = description;
    this._addToMap(id, fn);

    const spec: SerializedPipelineStructure = { name, id, type: 'stage' };
    if (description) spec.description = description;

    cur.next = node;
    curSpec.next = spec;
    this._cursor = node;
    this._advanceCursorSpec(spec);
    this._knownStageIds.add(id);

    // L7.3 — Linear node: announce the node first, then the edge
    // from the prior cursor. Order matters: endpoints announced
    // before any edge referencing them (StructureRecorder contract).
    this._fireStageAdded(spec);
    this._fireNextEdgeFromParent(parentSpec, id);

    this._appendDescriptionLine(name, description);
    return this;
  }

  addStreamingFunction(
    name: string,
    fn: StageFunction<TOut, TScope>,
    id: string,
    streamId?: string,
    description?: string,
  ): this {
    admitId('stage id', id, 'stage');
    const cur = this._needCursor();
    const curSpec = this._needCursorSpec();
    const parentSpec = curSpec;

    const node: StageNode<TOut, TScope> = {
      name,
      id,
      fn,
      isStreaming: true,
      streamId: streamId ?? name,
    };
    if (description) node.description = description;
    this._addToMap(id, fn);

    const spec: SerializedPipelineStructure = {
      name,
      id,
      type: 'streaming',
      isStreaming: true,
      streamId: streamId ?? name,
    };
    if (description) spec.description = description;

    cur.next = node;
    curSpec.next = spec;
    this._cursor = node;
    this._advanceCursorSpec(spec);
    this._knownStageIds.add(id);

    // L7.3 — Streaming stage: same shape as linear addFunction.
    this._fireStageAdded(spec);
    this._fireNextEdgeFromParent(parentSpec, id);

    this._appendDescriptionLine(name, description);
    return this;
  }

  /**
   * Add a pausable stage — can pause execution and resume later with input.
   *
   * The handler has two phases:
   * - `execute`: runs first time. Return any non-void value to pause (it becomes
   *   the checkpoint's `pauseData`); return void/undefined to continue normally.
   * - `resume`: runs when the flowchart is resumed with input.
   *
   * @example
   * ```typescript
   * .addPausableFunction('ApproveOrder', {
   *   execute: async (scope) => {
   *     scope.orderId = '123';
   *     return { question: 'Approve?' };
   *   },
   *   resume: async (scope, input) => {
   *     scope.approved = input.approved;
   *   },
   * }, 'approve-order', 'Manager approval gate')
   * ```
   */
  addPausableFunction(name: string, handler: PausableHandler<TScope>, id: string, description?: string): this {
    admitId('stage id', id, 'stage');
    const cur = this._needCursor();
    const curSpec = this._needCursorSpec();
    const parentSpec = curSpec;

    const node: StageNode<TOut, TScope> = {
      name,
      id,
      fn: handler.execute as StageFunction<TOut, TScope>,
      isPausable: true,
      resumeFn: handler.resume,
    };
    if (description) node.description = description;
    this._addToMap(id, handler.execute as StageFunction<TOut, TScope>);

    const spec: SerializedPipelineStructure = {
      name,
      id,
      type: 'stage',
      isPausable: true,
    };
    if (description) spec.description = description;

    cur.next = node;
    curSpec.next = spec;
    this._cursor = node;
    this._advanceCursorSpec(spec);
    this._knownStageIds.add(id);

    // L7.3 — Pausable stage: `_fireStageAdded` reads `isPausable`
    // directly from `spec.isPausable` (set above), so visualisers
    // see it on the event payload without a separate threading arg.
    this._fireStageAdded(spec);
    this._fireNextEdgeFromParent(parentSpec, id);

    this._appendDescriptionLine(name, description);
    return this;
  }

  // ── Detach (builder-native composition) ──
  //
  // Sugar over `addFunction` that generates a stage which calls
  // `scope.$detachAndForget(...)` or `scope.$detachAndJoinLater(...)`
  // at runtime. ZERO engine changes — pure composition over the
  // existing scope-method primitives.
  //
  // For `addDetachAndJoinLater`, the returned handle is stored in
  // shared state via `$setValue` (which bypasses the typed-proxy
  // unwrap that would otherwise strip the handle's class methods).
  // Downstream stages read it via `scope[options.handleKey]` or
  // `scope.$getValue(options.handleKey)` — both preserve methods
  // because the value was stored raw.

  /**
   * Add a stage that fires a child flowchart on the given driver and
   * DISCARDS the handle. Pure fire-and-forget — useful for telemetry
   * exports, audit log shipping, cache warm-up.
   *
   * @param id Stable id for this stage (also the stageMap key).
   * @param child The child flowchart to detach.
   * @param options.driver The driver to schedule on (e.g. `microtaskBatchDriver`).
   * @param options.inputMapper Maps the parent's scope to the child's input.
   *   Defaults to passing `undefined`.
   * @param options.mountName Display name; defaults to `id`.
   * @param options.description Stage description for narrative + tools.
   *
   * @example
   * ```ts
   * import { microtaskBatchDriver } from 'footprintjs/detach';
   *
   * flowChart('process', processFn, 'process')
   *   .addDetachAndForget('telemetry', telemetryChart, {
   *     driver: microtaskBatchDriver,
   *     inputMapper: (scope) => ({ event: 'processed', orderId: scope.orderId }),
   *   })
   *   .addFunction('next', nextFn, 'next')
   *   .build();
   * ```
   */
  addDetachAndForget(
    id: string,
    child: import('./types.js').FlowChart<any, any>,
    options: {
      driver: import('../detach/types.js').DetachDriver;
      inputMapper?: (scope: TScope) => unknown;
      mountName?: string;
      description?: string;
    },
  ): this {
    const name = options.mountName ?? id;
    return this.addFunction(
      name,
      ((scope: any) => {
        const input = options.inputMapper ? options.inputMapper(scope as TScope) : undefined;
        scope.$detachAndForget(options.driver, child, input);
      }) as StageFunction<TOut, TScope>,
      id,
      options.description,
    );
  }

  /**
   * Add a stage that fires a child flowchart on the given driver and
   * delivers the resulting `DetachHandle` to a consumer-supplied
   * `onHandle` callback. The handle CANNOT be stored in shared state
   * — `StageContext.setValue` calls `structuredClone` which drops
   * class prototypes (and therefore the handle's `.wait()` method).
   *
   * The callback pattern is the explicit alternative: keep handles in
   * a closure-local array (or whatever shape suits) and have a
   * downstream stage `await Promise.all(...)` over them.
   *
   * @example
   * ```ts
   * import { microtaskBatchDriver } from 'footprintjs/detach';
   * import type { DetachHandle } from 'footprintjs/detach';
   *
   * const handles: DetachHandle[] = [];
   *
   * const chart = flowChart('seed', seedFn, 'seed')
   *   .addDetachAndJoinLater('eval-a', evalChart, {
   *     driver: microtaskBatchDriver,
   *     inputMapper: (scope) => scope.configA,
   *     onHandle: (h) => handles.push(h),
   *   })
   *   .addDetachAndJoinLater('eval-b', evalChart, {
   *     driver: microtaskBatchDriver,
   *     inputMapper: (scope) => scope.configB,
   *     onHandle: (h) => handles.push(h),
   *   })
   *   .addFunction('join', async (scope) => {
   *     const settled = await Promise.all(handles.map((h) => h.wait()));
   *     scope.results = settled;
   *   }, 'join')
   *   .build();
   * ```
   *
   * Note: putting `handles` in a module-level closure is fine for
   * single-run scripts. For server code that runs the same chart
   * concurrently across requests, allocate a new closure per run
   * (e.g., wrap chart construction in a factory function) so handles
   * from different runs don't bleed into each other.
   */
  addDetachAndJoinLater(
    id: string,
    child: import('./types.js').FlowChart<any, any>,
    options: {
      driver: import('../detach/types.js').DetachDriver;
      onHandle: (handle: import('../detach/types.js').DetachHandle) => void;
      inputMapper?: (scope: TScope) => unknown;
      mountName?: string;
      description?: string;
    },
  ): this {
    const name = options.mountName ?? id;
    return this.addFunction(
      name,
      ((scope: any) => {
        const input = options.inputMapper ? options.inputMapper(scope as TScope) : undefined;
        const handle = scope.$detachAndJoinLater(options.driver, child, input);
        options.onHandle(handle);
      }) as StageFunction<TOut, TScope>,
      id,
      options.description,
    );
  }

  // ── Branching ──

  addDeciderFunction(
    name: string,
    fn: StageFunction<any, TScope>,
    id: string,
    description?: string,
    /** `{ retry }` gives the DECIDER STAGE a retry policy. Declared here rather
     *  than via `.retry()` because this method returns a `DeciderList`, where a
     *  chained modifier could mean the decider OR the branch just added;
     *  `{ tags }` likewise. */
    options?: { retry?: RetryPolicy; tags?: readonly string[] },
  ): DeciderList<TOut, TScope> {
    admitId('stage id', id, 'stage');
    const cur = this._needCursor();
    const curSpec = this._needCursorSpec();
    const parentSpec = curSpec;

    if (cur.deciderFn) fail(`decider already defined at '${cur.name}'`);

    const node: StageNode<TOut, TScope> = { name, id, fn };
    if (description) node.description = description;
    this._addToMap(id, fn);

    const spec: SerializedPipelineStructure = { name, id, type: 'stage', hasDecider: true };
    if (description) spec.description = description;
    applyRetryPolicy(node, spec, options?.retry, `addDeciderFunction('${id}')`);
    applyTags(node, spec, options?.tags, `addDeciderFunction('${id}')`);

    cur.next = node;
    curSpec.next = spec;
    this._cursor = node;
    this._advanceCursorSpec(spec);
    this._knownStageIds.add(id);

    // L7.3 — Decider node is reached via a `next` edge from the prior
    // cursor. Branches themselves fire via `addFunctionBranch` etc.
    // `onDeciderComplete` fires from sub-builder `.end()`.
    this._fireStageAdded(spec);
    this._fireNextEdgeFromParent(parentSpec, id);

    this._stepCounter++;
    this._stageStepMap.set(name, this._stepCounter);

    return new DeciderList<TOut, TScope>(
      this,
      node,
      spec,
      this._descriptionParts,
      this._stageDescriptions,
      this._stepCounter,
      description,
    );
  }

  addSelectorFunction(
    name: string,
    fn: StageFunction<any, TScope>,
    id: string,
    description?: string,
    /** `{ retry }` gives the SELECTOR STAGE a retry policy — same reasoning as
     *  `addDeciderFunction`: this method returns a sub-builder, so a chained
     *  `.retry()` would be ambiguous; `{ tags }` likewise. */
    options?: { failFast?: boolean; retry?: RetryPolicy; tags?: readonly string[] },
  ): SelectorFnList<TOut, TScope> {
    admitId('stage id', id, 'stage');
    const cur = this._needCursor();
    const curSpec = this._needCursorSpec();
    const parentSpec = curSpec;

    if (cur.selectorFn) fail(`selector already defined at '${cur.name}'`);
    if (cur.deciderFn) fail(`decider and selector are mutually exclusive at '${cur.name}'`);

    const node: StageNode<TOut, TScope> = { name, id, fn };
    if (description) node.description = description;
    // `failFast`: when the selector picks ≥2 branches they fan out in parallel
    // via ChildrenExecutor. Default = `Promise.allSettled` (best-effort: every
    // branch runs to completion even if some fail). `failFast: true` = `Promise.all`
    // (the first branch error rejects + aborts) — use when ALL selected branches
    // are REQUIRED (e.g. assembling a request from independent-but-required parts),
    // not best-effort fan-out. Same flag `addListOfFunction` exposes.
    if (options?.failFast) node.failFast = true;
    this._addToMap(id, fn);

    const spec: SerializedPipelineStructure = { name, id, type: 'stage', hasSelector: true };
    if (description) spec.description = description;
    applyRetryPolicy(node, spec, options?.retry, `addSelectorFunction('${id}')`);
    applyTags(node, spec, options?.tags, `addSelectorFunction('${id}')`);

    cur.next = node;
    curSpec.next = spec;
    this._cursor = node;
    this._advanceCursorSpec(spec);
    this._knownStageIds.add(id);

    // L7.3 — Selector node: same as decider. Branches + complete event
    // come from the SelectorFnList sub-builder.
    this._fireStageAdded(spec);
    this._fireNextEdgeFromParent(parentSpec, id);

    this._stepCounter++;
    this._stageStepMap.set(name, this._stepCounter);

    return new SelectorFnList<TOut, TScope>(
      this,
      node,
      spec,
      this._descriptionParts,
      this._stageDescriptions,
      this._stepCounter,
      description,
    );
  }

  // ── Parallel (Fork) ──

  addListOfFunction(children: SimplifiedParallelSpec<TOut, TScope>[], options?: { failFast?: boolean }): this {
    const { cur, curSpec } = this._needForkParent();
    const forkId = cur.id;

    curSpec.type = 'fork';
    if (options?.failFast) cur.failFast = true;

    for (const { id, name, fn, retry, tags } of children) {
      if (!id) fail(`child id required under '${cur.name}'`);
      admitId('fork child id', id, 'stage');
      if (cur.children?.some((c) => c.id === id)) {
        fail(`duplicate child id '${id}' under '${cur.name}'`);
      }

      const node: StageNode<TOut, TScope> = { name: name ?? id, id };
      if (fn) {
        node.fn = fn;
      }
      this._registerStage(id, fn);

      const spec: SerializedPipelineStructure = {
        name: name ?? id,
        id,
        type: 'stage',
        isParallelChild: true,
        parallelGroupId: forkId,
      };
      applyRetryPolicy(node, spec, retry, `addListOfFunction child '${id}'`);
      applyTags(node, spec, tags, `addListOfFunction child '${id}'`);

      cur.children = cur.children || [];
      cur.children.push(node);
      curSpec.children = curSpec.children || [];
      curSpec.children.push(spec);
      // L7.3 — fire structure events for the child + the fork edge.
      this._fireStageAdded(spec);
      this._fireEdgeAdded(curSpec.id, spec.id, 'fork-branch');
    }

    const childNames = children.map((c) => c.name || c.id).join(', ');
    this._stepCounter++;
    this._descriptionParts.push(`${this._stepCounter}. Runs in parallel: ${childNames}`);

    this._cursorTail = `the parallel children (${childNames})`;
    return this;
  }

  /**
   * Run ONE BRANCH PER ITEM, in parallel — with the number of branches decided
   * at RUN time from the payload rather than at build time.
   *
   * `addListOfFunction` fans out a fixed set of branches you name in the chart.
   * This fans out over data the chart has not seen yet: three chunks make three
   * branches, ten make ten. Each branch runs as its own isolated subflow — its
   * own memory, its own commit log, addressable in every trace query at
   * `<stageId>~<index>` — so branches cannot corrupt each other's in-flight
   * state, and a backward slice through a branch result works with no special
   * handling. Design: docs/design/execution-control.md.
   *
   * @param name   Display label for the fan-out stage.
   * @param id     Stable stage id. May not contain `~` (reserved — the branch
   *               segments are built from this id).
   * @param config `{ items, branch, maxBranches, into, failFast? }`:
   *   - `items(scope)` picks what to fan out over (reads are tracked);
   *   - `branch(item, index)` builds the chart for ONE item (each branch's
   *     scope is also seeded with `item` and `index`, so the input is in the
   *     trace rather than hidden in a closure);
   *   - `maxBranches` is REQUIRED — an unbounded fan-out driven by model output
   *     is a resource attack, so there is no default to forget. Extra items do
   *     not run and the truncation is recorded;
   *   - `into` is REQUIRED — the state key the ordered results array is written
   *     to. `into[i]` is branch `i`'s result, in ITEMS order, whatever order
   *     the branches finished in;
   *   - `failFast` is the same policy the rest of the library's parallelism
   *     uses: `true` rejects on the first failing branch, omitted runs them all
   *     best-effort (a failed branch's slot is `undefined`).
   *
   * @example
   * ```ts
   * flowChart<State>('Split', splitFn, 'split')
   *   .addParallelForEach('Review each chunk', 'review-chunks', {
   *     items: (scope) => scope.chunks,
   *     branch: (chunk, i) => buildReviewChart(chunk, i),
   *     maxBranches: 8,
   *     into: 'reviews',
   *   })
   *   .addFunction('Merge', mergeFn, 'merge')   // reads scope.reviews
   *   .build();
   * ```
   */
  addParallelForEach<TItem = any>(
    name: string,
    id: string,
    config: ParallelForEachConfig<TItem, TScope>,
    description?: string,
  ): this {
    const cur = this._needCursor();
    const curSpec = this._needCursorSpec();
    const parentSpec = curSpec;

    // The generated branch segments embed this id verbatim
    // (`<id>~<index>`), so a marker inside it would make the segment
    // ambiguous to parse. Refusing it here — on a brand-new method, at zero
    // back-compat cost — kills the ambiguity class outright and keeps
    // `parseBranchSegment` a split at the last marker instead of a heuristic.
    admitId('parallelForEach stage id', id, 'segment');
    this._claimFreshId(id, `addParallelForEach('${id}')`);
    if (!config || typeof config.items !== 'function' || typeof config.branch !== 'function') {
      fail(`addParallelForEach('${id}') requires items(scope) and branch(item, index) functions.`);
    }
    // REQUIRED, both of them — see docs/design/execution-control.md (D2).
    if (typeof config.maxBranches !== 'number' || !Number.isInteger(config.maxBranches) || config.maxBranches < 1) {
      fail(
        `addParallelForEach('${id}') requires maxBranches — a positive integer ceiling on how many ` +
          'branches one execution may start. There is deliberately no default: an unbounded fan-out ' +
          'driven by runtime data (model output, an upstream API) is a resource attack. Pick the ' +
          'largest number this flow can afford. See docs/design/execution-control.md.',
      );
    }
    if (typeof config.into !== 'string' || config.into === '') {
      fail(
        `addParallelForEach('${id}') requires into — the state key its ordered results array is ` +
          'written to. There is deliberately no default derived from the stage id: a derived key ' +
          'could silently overwrite state the chart already owns. See docs/design/execution-control.md.',
      );
    }

    const node: StageNode<TOut, TScope> = {
      name,
      id,
      isDynamicParallel: true,
      parallelForEach: config as ParallelForEachConfig<any, TScope>,
    };
    if (description) node.description = description;
    if (config.failFast !== undefined) node.failFast = config.failFast;

    // `type: 'fork'` — a fan-out is what this is, and every existing consumer
    // already knows how to draw one. The "branches are decided at runtime"
    // detail rides `isDynamicParallel` rather than a new node type, so nothing
    // downstream has to learn a new word to keep working.
    const spec: SerializedPipelineStructure = { name, id, type: 'fork', isDynamicParallel: true };
    if (description) spec.description = description;

    cur.next = node;
    curSpec.next = spec;
    this._cursor = node;
    this._advanceCursorSpec(spec);
    this._knownStageIds.add(id);

    this._fireStageAdded(spec);
    this._fireNextEdgeFromParent(parentSpec, id);

    this._appendDescriptionLine(name, description ?? `Runs one branch per item into '${config.into}'`);
    return this;
  }

  // ── Subflow Mounting ──

  addSubFlowChart(id: string, subflow: FlowChart<any, any>, mountName?: string, options?: SubflowMountOptions): this {
    const { cur, curSpec } = this._needForkParent();

    if (cur.children?.some((c) => c.id === id)) {
      fail(`duplicate child id '${id}' under '${cur.name}'`);
    }
    assertSubflowIdAllowed(id);

    const subflowName = mountName || id;
    const forkId = cur.id;
    this._mountSubflow(id, subflow, () => {
      const node: StageNode<TOut, TScope> = {
        name: subflowName,
        id,
        isSubflowRoot: true,
        subflowId: id,
        subflowName,
      };
      if (options) node.subflowMountOptions = options;

      const spec: SerializedPipelineStructure = {
        name: subflowName,
        type: 'stage',
        id,
        isSubflowRoot: true,
        subflowId: id,
        subflowName,
        isParallelChild: true,
        parallelGroupId: forkId,
        subflowStructure: subflow.buildTimeStructure,
      };

      // The mount's ONLY tag site: the cursor stays on the parent (see
      // `_cursorTail`), so `.tag()` after this call refuses.
      applyTags(node, spec, options?.tags, `addSubFlowChart('${id}')`);

      curSpec.type = 'fork';
      cur.children = cur.children || [];
      cur.children.push(node);
      curSpec.children = curSpec.children || [];
      curSpec.children.push(spec);
      this._knownStageIds.add(id);
      // L7.3 — Subflow mount: stage event + fork edge + mount lifecycle
      // event. Mount-only semantics: parent recorders do NOT replay the
      // subflow's own internal structure events.
      this._fireStageAdded(spec);
      this._fireEdgeAdded(curSpec.id, id, 'fork-branch');
      this._fireSubflowMounted(id, subflowName, id, false, subflow.buildTimeStructure);
    });
    this._appendSubflowDescription(id, subflowName, subflow);

    this._cursorTail = `the subflow mount '${subflowName}'`;
    return this;
  }

  addLazySubFlowChart(
    id: string,
    resolver: () => FlowChart<TOut, TScope>,
    mountName?: string,
    options?: SubflowMountOptions,
  ): this {
    const { cur, curSpec } = this._needForkParent();

    if (cur.children?.some((c) => c.id === id)) {
      fail(`duplicate child id '${id}' under '${cur.name}'`);
    }
    assertSubflowIdAllowed(id);
    this._claimFreshId(id, `addLazySubFlowChart('${id}')`);

    const subflowName = mountName || id;
    const forkId = cur.id;

    const node: StageNode<TOut, TScope> = {
      name: subflowName,
      id,
      isSubflowRoot: true,
      subflowId: id,
      subflowName,
      subflowResolver: resolver as any,
    };
    if (options) node.subflowMountOptions = options;

    // Lazy mount stub. The lazy subflow's internals will be shaped at
    // resolution time.
    const spec: SerializedPipelineStructure = {
      name: subflowName,
      type: 'stage',
      id,
      isSubflowRoot: true,
      subflowId: id,
      subflowName,
      isParallelChild: true,
      parallelGroupId: forkId,
      isLazy: true,
    };

    applyTags(node, spec, options?.tags, `addLazySubFlowChart('${id}')`);

    curSpec.type = 'fork';
    cur.children = cur.children || [];
    cur.children.push(node);
    curSpec.children = curSpec.children || [];
    curSpec.children.push(spec);
    // L7.3 — Lazy subflow parallel mount.
    this._fireStageAdded(spec);
    this._fireEdgeAdded(curSpec.id, id, 'fork-branch');
    this._fireSubflowMounted(id, subflowName, id, true);

    this._stepCounter++;
    this._stageStepMap.set(id, this._stepCounter);
    this._descriptionParts.push(`${this._stepCounter}. [Lazy Sub-Execution: ${subflowName}]`);

    this._cursorTail = `the lazy subflow mount '${subflowName}'`;
    return this;
  }

  addLazySubFlowChartNext(
    id: string,
    resolver: () => FlowChart<TOut, TScope>,
    mountName?: string,
    options?: SubflowMountOptions,
  ): this {
    const cur = this._needCursor();
    const curSpec = this._needCursorSpec();

    if (cur.next) {
      fail(`cannot add subflow as next when next is already defined at '${cur.name}'`);
    }
    assertSubflowIdAllowed(id);
    this._claimFreshId(id, `addLazySubFlowChartNext('${id}')`);

    const subflowName = mountName || id;

    const node: StageNode<TOut, TScope> = {
      name: subflowName,
      id,
      isSubflowRoot: true,
      subflowId: id,
      subflowName,
      subflowResolver: resolver as any,
    };
    if (options) node.subflowMountOptions = options;

    // Lazy mount stub. The lazy subflow's internals will be shaped at
    // resolution time.
    const spec: SerializedPipelineStructure = {
      name: subflowName,
      type: 'stage',
      id,
      isSubflowRoot: true,
      subflowId: id,
      subflowName,
      isLazy: true,
    };

    applyTags(node, spec, options?.tags, `addLazySubFlowChartNext('${id}')`);

    const parentSpec = curSpec;
    cur.next = node;
    curSpec.next = spec;
    this._cursor = node;
    this._advanceCursorSpec(spec);
    // L7.3 — Lazy linear-mount subflow.
    this._fireStageAdded(spec);
    this._fireNextEdgeFromParent(parentSpec, id);
    this._fireSubflowMounted(id, subflowName, id, true);

    this._stepCounter++;
    this._stageStepMap.set(id, this._stepCounter);
    this._descriptionParts.push(`${this._stepCounter}. [Lazy Sub-Execution: ${subflowName}]`);

    return this;
  }

  addSubFlowChartNext(
    id: string,
    subflow: FlowChart<any, any>,
    mountName?: string,
    options?: SubflowMountOptions,
  ): this {
    const cur = this._needCursor();
    const curSpec = this._needCursorSpec();

    if (cur.next) {
      fail(`cannot add subflow as next when next is already defined at '${cur.name}'`);
    }
    assertSubflowIdAllowed(id);

    const subflowName = mountName || id;
    this._mountSubflow(id, subflow, () => {
      const node: StageNode<TOut, TScope> = {
        name: subflowName,
        id,
        isSubflowRoot: true,
        subflowId: id,
        subflowName,
      };
      if (options) node.subflowMountOptions = options;

      const attachedSpec: SerializedPipelineStructure = {
        name: subflowName,
        type: 'stage',
        id,
        isSubflowRoot: true,
        subflowId: id,
        subflowName,
        subflowStructure: subflow.buildTimeStructure,
      };

      // A linear mount moves the cursor, so `.tag()` after it also works —
      // `applyTags` refuses a second declaration if both sites are used.
      applyTags(node, attachedSpec, options?.tags, `addSubFlowChartNext('${id}')`);

      const parentSpec = curSpec;
      cur.next = node;
      curSpec.next = attachedSpec;
      this._cursor = node;
      this._advanceCursorSpec(attachedSpec);
      this._knownStageIds.add(id);
      // L7.3 — Linear-mount subflow.
      this._fireStageAdded(attachedSpec);
      this._fireNextEdgeFromParent(parentSpec, id);
      this._fireSubflowMounted(id, subflowName, id, false, subflow.buildTimeStructure);
    });
    this._appendSubflowDescription(id, subflowName, subflow);

    return this;
  }

  // ── Retry ──

  /**
   * Give the stage you JUST added a declarative retry policy.
   *
   * ## Why declare it instead of writing a loop inside the stage
   *
   * A retry hand-rolled inside a stage function is invisible to the trace. The
   * narrative shows one stage, the commit log shows one entry, and the two
   * failed calls that came before the successful one left no mark anywhere —
   * an unexplained behaviour in a library whose whole point is that nothing
   * invisible happens. Declared here, every attempt is part of the record: each
   * failed attempt fires `FlowRecorder.onStageRetry` and appears in the
   * narrative, in order, between the attempts' own reads and writes.
   *
   * ## What an attempt is
   *
   * A failed attempt's staged writes are DISCARDED — the next attempt starts
   * from committed state, never from the wreckage of the last try. The final
   * attempt behaves exactly as a stage with no policy does: on success it
   * commits; on failure it commits what it wrote and rethrows (footprint has
   * never had rollback, and retry does not introduce one).
   *
   * A pause is not a failure: neither `addPausableFunction`'s pause nor
   * `interrupt()` is ever retried. Nor is a cancelled run.
   *
   * @example
   * ```ts
   * flowChart<State>('Fetch user', fetchFn, 'fetch-user')
   *   .addFunction('Charge card', chargeFn, 'charge')
   *   .retry({ attempts: 3, backoffMs: (n) => 100 * 2 ** (n - 1) })
   *   .addFunction('Confirm', confirmFn, 'confirm')
   * ```
   *
   * Applies to the CURRENT cursor — the stage added by the immediately
   * preceding `start()` / `addFunction()` / `addStreamingFunction()` /
   * `addPausableFunction()`. Where the cursor would be ambiguous (a decider,
   * selector, branch, or fork child), declare the policy in that method's own
   * `retry` option instead.
   */
  retry(policy: RetryPolicy): this {
    const cur = this._needCursor();
    const curSpec = this._needCursorSpec();

    // A subflow mount / parallel fork hangs CHILDREN off the current stage and
    // leaves the cursor on that stage. Attaching the policy to the cursor here
    // would silently retry the stage BEFORE the thing you just wrote.
    if (this._cursorTail) {
      fail(
        `retry() cannot follow ${this._cursorTail} — that attaches to '${cur.name}' without moving the cursor, so ` +
          `the policy would land on '${cur.name}' rather than on what you just added. Declare the policy at its own ` +
          'site instead: on the stages INSIDE a subflow chart, or via the `retry` field on an addListOfFunction child.',
      );
    }
    if (cur.retry) fail(`retry already defined at '${cur.name}'`);
    if (cur.isSubflowRoot) {
      fail(
        `retry() cannot be applied to the subflow mount '${cur.name}' — a mount has no stage function of its own. ` +
          'Declare the policy on the stages INSIDE the subflow chart instead.',
      );
    }
    if (cur.isDynamicParallel) {
      fail(
        `retry() cannot be applied to the parallel-for-each stage '${cur.name}' — it has no stage function of its ` +
          'own. Declare the policy on the stages inside the branch chart its `branch` factory returns.',
      );
    }
    if (cur.isLoopRef) fail(`retry() cannot be applied to the loop reference '${cur.name}'`);

    applyRetryPolicy(cur, curSpec, policy, `retry() at '${cur.name}'`);
    return this;
  }

  // ── Declared tags ──

  /**
   * Put NAMES on the stage you JUST added. The first commit bundle of each
   * execution of that stage carries them (`CommitBundle.tags` — the bundle
   * `commitStops` keys on), and the built spec advertises them
   * (`SerializedPipelineStructure.tags`).
   *
   * ## Why declare it instead of deriving it from ids
   *
   * A reader that wants "the LLM turns" of a stored recording had to classify
   * stages from their ids — a switch over `runtimeStageId` that parses `#` and
   * `/`, lives in the consumer, and silently goes stale when a stage is
   * renamed. Declared here, the name travels WITH the commit: a recording from
   * any chart carries its own milestones, and `tagStops` (foottrace)
   * scrubs them with no id conventions at all.
   *
   * ## What a tag is, and is not
   *
   * A tag is a NAME declared at build time — never a value. There is no
   * run-time `$tag()`: a runtime string could carry data (`'user:' + email`)
   * past every redaction point. Data-dependent marks are a keep rule over
   * the fold at read time, or telemetry via `$emit`. Free strings: footprintjs
   * owns no vocabulary; a consumer declares its own (`'milestone:<kind>'`).
   *
   * Stamped ONCE per execution of the stage: retry attempts share one stamp,
   * a failed stage keeps its tag (the error path commits before it rethrows),
   * a stage that `interrupt()`s and is resumed is two tagged stops on a chain
   * because it ran twice, and an EMPTY commit is a tagged stop too. A subflow
   * mount or a parallel-for-each stage can be tagged; the tag lands on the
   * bundle that records its result — for a mount, its FIRST bundle in the
   * parent log (the exit bundle carries none), while the subflow's own log
   * is untouched: its inner stages declare their own.
   *
   * @example
   * ```ts
   * flowChart<State>('Seed', seedFn, 'seed')
   *   .addFunction('Call model', callFn, 'call-llm')
   *   .tag('milestone:llm-turn')
   *   .addFunction('Route', routeFn, 'route')
   *   .tag('milestone:decision', 'audit')
   * ```
   *
   * Applies to the CURRENT cursor — the stage added by the immediately
   * preceding `start()` / `addFunction()` / `addStreamingFunction()` /
   * `addPausableFunction()` / `addSubFlowChartNext()` / `addParallelForEach()`.
   * Where the cursor would be ambiguous (a decider, selector, branch, or fork
   * child), declare the tags in that method's own `tags` option instead. A
   * subflow MOUNT has that option too (`SubflowMountOptions.tags`, 9.21.1)
   * — and for a fork-child mount (`addSubFlowChart`) or a branch mount
   * (`addSubFlowChartBranch`) it is the ONLY site: those leave the cursor on
   * the parent, so `.tag()` after them refuses rather than mis-attribute.
   *
   * Refused at build time: an empty name, a non-string, the reserved
   * branch-segment marker `~` inside a name, a name declared twice, and a
   * second declaration on the same stage.
   */
  tag(...names: readonly string[]): this {
    const cur = this._needCursor();
    const curSpec = this._needCursorSpec();

    // Same mis-attribution guard as `.retry()`: after a mount or a fork the
    // cursor still points at the stage BEFORE what you just wrote.
    if (this._cursorTail) {
      fail(
        `tag() cannot follow ${this._cursorTail} — that attaches to '${cur.name}' without moving the cursor, so ` +
          `the names would land on '${cur.name}' rather than on what you just added. Declare the tags at their own ` +
          "site instead: via the `tags` field in the mount's own options (`SubflowMountOptions.tags`, 9.21.1), or " +
          'via the `tags` field on an addListOfFunction child. The stages INSIDE a subflow chart declare their own.',
      );
    }
    if (cur.isLoopRef) fail(`tag() cannot be applied to the loop reference '${cur.name}'`);
    if (names.length === 0) fail(`tag() at '${cur.name}': at least one name is required`);

    applyTags(cur, curSpec, names, `tag() at '${cur.name}'`);
    // The stage's `onStageAdded` has already fired (the door comes after
    // the add), so the names go out as their own event — a recorder that
    // copied fields at add time would otherwise never see them (9.24.0).
    this._fireStageTagged(curSpec);
    return this;
  }

  // ── Loop ──

  loopTo(stageId: string): this {
    const cur = this._needCursor();
    const curSpec = this._needCursorSpec();

    if (curSpec.loopTarget) fail(`loopTo already defined at '${cur.name}'`);
    if (cur.next) fail(`cannot set loopTo when next is already defined at '${cur.name}'`);

    if (!this._knownStageIds.has(stageId)) {
      fail(`loopTo('${stageId}') target not found — did you pass a stage name instead of id?`);
    }

    cur.next = { name: stageId, id: stageId, isLoopRef: true };
    curSpec.loopTarget = stageId;
    curSpec.next = { name: stageId, id: stageId, type: 'loop', isLoopReference: true };

    const targetStep = this._stageStepMap.get(stageId);
    if (targetStep !== undefined) {
      this._descriptionParts.push(`→ loops back to step ${targetStep}`);
    } else {
      this._descriptionParts.push(`→ loops back to ${stageId}`);
    }

    // L7.3 — Fire the loop back-edge event. Distinct from `onEdgeAdded`
    // because runtime `onLoop` carries `iteration: number` which has no
    // build meaning — separate event keeps payloads honest.
    this._fireLoopEdgeAdded(cur.id, stageId);
    return this;
  }

  // ── Streaming ──

  onStream(handler: StreamTokenHandler): this {
    this._streamHandlers.onToken = handler;
    return this;
  }

  onStreamStart(handler: StreamLifecycleHandler): this {
    this._streamHandlers.onStart = handler;
    return this;
  }

  onStreamEnd(handler: StreamLifecycleHandler): this {
    this._streamHandlers.onEnd = handler;
    return this;
  }

  // ── Output ──

  build(): RunnableFlowChart<TOut, TScope> {
    // L7.3 — seal the chart so post-build attaches throw. Prevents
    // recorders attached mid-execution from getting partial data.
    this._sealed = true;

    const root = this._root ?? fail('empty tree; call start() first');
    const rootSpec = this._rootSpec ?? fail('empty spec; call start() first');

    const subflows: Record<string, { root: StageNode<TOut, TScope> }> = {};
    for (const [key, def] of this._subflowDefs) {
      subflows[key] = def;
    }

    const rootName = this._root?.name ?? 'FlowChart';
    const description =
      this._descriptionParts.length > 0 ? `FlowChart: ${rootName}\nSteps:\n${this._descriptionParts.join('\n')}` : '';

    const chart: FlowChart<TOut, TScope> = {
      root,
      stageMap: this._stageMap,
      buildTimeStructure: rootSpec,
      ...(Object.keys(subflows).length > 0 ? { subflows } : {}),
      ...(this._enableNarrative ? { enableNarrative: true } : {}),
      ...(this._logger ? { logger: this._logger } : {}),
      description,
      stageDescriptions: new Map(this._stageDescriptions),
      ...(this._inputSchema ? { inputSchema: this._inputSchema } : {}),
      ...(this._outputSchema ? { outputSchema: this._outputSchema } : {}),
      ...(this._outputMapper ? { outputMapper: this._outputMapper } : {}),
      // Auto-embed TypedScope factory if none was explicitly set.
      // This means ANY way of creating a FlowChartBuilder (flowChart(), new FlowChartBuilder(),
      // or any subclass) automatically gets TypedScope — no manual setScopeFactory needed.
      scopeFactory: this._scopeFactory ?? (createTypedScopeFactory() as unknown as ScopeFactory<TScope>),
    };

    return makeRunnable(chart);
  }

  /** Override the scope factory. Rarely needed — auto-embeds TypedScope by default. */
  setScopeFactory(factory: ScopeFactory<TScope>): this {
    this._scopeFactory = factory;
    return this;
  }

  toSpec<TResult = SerializedPipelineStructure>(): TResult {
    const rootSpec = this._rootSpec ?? fail('empty tree; call start() first');
    return rootSpec as TResult;
  }

  toMermaid(): string {
    const lines: string[] = ['flowchart TD'];
    const idOf = (k: string) => (k || '').replace(/[^a-zA-Z0-9_]/g, '_') || '_';
    const root = this._root ?? fail('empty tree; call start() first');

    const walk = (n: StageNode<TOut, TScope>) => {
      const nid = idOf(n.id);
      lines.push(`${nid}["${n.name}"]`);
      for (const c of n.children || []) {
        const cid = idOf(c.id);
        lines.push(`${nid} --> ${cid}`);
        walk(c);
      }
      if (n.next) {
        const mid = idOf(n.next.id);
        lines.push(`${nid} --> ${mid}`);
        walk(n.next);
      }
    };
    walk(root);
    return lines.join('\n');
  }

  // ── Internals (exposed for helper classes) ──

  private _needCursor(): StageNode<TOut, TScope> {
    return this._cursor ?? fail('cursor undefined; call start() first');
  }

  private _needCursorSpec(): SerializedPipelineStructure {
    return this._cursorSpec ?? fail('cursor undefined; call start() first');
  }

  /**
   * The node a fan-out (`addListOfFunction`, `addSubFlowChart`,
   * `addLazySubFlowChart`) hangs its children on — the cursor, unless the
   * cursor's `children` already MEAN something else:
   *
   * - a subflow MOUNT — the engine reads a mount that carries children as the
   *   mounted chart's OWN content (`NodeResolver · resolveSubflowReference`),
   *   so a fork hung there ran INSIDE the subflow: the subflow's real chart
   *   never ran, everything after the fork ran twice, and a pause after it was
   *   checkpointed under the wrong subflow path (and refused on resume);
   * - a DECIDER or a SELECTOR (the cursor after `.end()`) — its children are
   *   its branches, so a fork child became a branch nobody picks;
   * - a `parallelForEach` — its branches come from `items` at run time and
   *   built children are never dispatched, so the fork never ran.
   *
   * Through 9.37.0 the builder hung the fork there anyway. So after such a
   * node the fork continues AFTER it: a function-less fork node
   * `<nodeId>-fork` becomes the node's `next` and the new cursor — the shape
   * `addFunction(...).addListOfFunction(...)` already builds, which every
   * reader (engine, resume, structure, spec) handles. A second fan-out call
   * reuses that node, as it would any cursor. The id is reserved both ways:
   * refused here when a stage already has it, and by stage admission /
   * `_registerSubflowDef` when a later stage or mount asks for it.
   */
  private _needForkParent(): { cur: StageNode<TOut, TScope>; curSpec: SerializedPipelineStructure } {
    const owner = this._needCursor();
    const ownerSpec = this._needCursorSpec();
    const childrenMeanSomethingElse =
      owner.isSubflowRoot || owner.isDynamicParallel || owner.deciderFn || owner.selectorFn;
    if (!childrenMeanSomethingElse) return { cur: owner, curSpec: ownerSpec };

    const id = `${owner.id}-fork`;
    if (this._idTaken(id)) {
      fail(
        `cannot fan out after '${owner.name}': the fork node it needs, '${id}', ` +
          `is already a stage id. Add a stage after '${owner.name}' and fan out from it.`,
      );
    }
    const node: StageNode<TOut, TScope> = { name: id, id };
    const spec: SerializedPipelineStructure = { name: id, id, type: 'fork' };
    owner.next = node;
    ownerSpec.next = spec;
    this._cursor = node;
    this._advanceCursorSpec(spec);
    this._knownStageIds.add(id);
    this._forkNodeIds.add(id);
    this._fireStageAdded(spec);
    this._fireNextEdgeFromParent(ownerSpec, id);
    return { cur: node, curSpec: spec };
  }

  /** Ids `_needForkParent` generated — no later stage or mount may take one. */
  private _forkNodeIds = new Set<string>();

  /** Shared by stage admission and subflow registration: reserved structural ids cannot be reused. */
  private _refuseForkNodeId(id: string): void {
    if (this._claimedIds.has(id)) {
      fail(`id '${id}' is already used by a lazy subflow mount or a parallelForEach in this chart. Rename the stage.`);
    }
    if (!this._forkNodeIds.has(id)) return;
    fail(
      `id '${id}' is taken: it is the fork node the builder placed after '${id.slice(0, -'-fork'.length)}' ` +
        '(a fan-out right after a subflow mount, decider, selector or parallelForEach continues on it). ' +
        'Rename the stage.',
    );
  }

  /** Ids the lazy-mount and parallelForEach doors claimed (they register in no map). */
  private _claimedIds = new Set<string>();

  /** Structural declarations without an embedded function; not function entries or loop targets. */
  private _functionlessStageIds = new Set<string>();

  /** True when an earlier stage, branch, fork child, mount or generated fork node holds `id`. */
  private _idTaken(id: string): boolean {
    return (
      this._knownStageIds.has(id) ||
      this._stageMap.has(id) ||
      this._functionlessStageIds.has(id) ||
      this._subflowDefs.has(id) ||
      this._claimedIds.has(id) ||
      this._forkNodeIds.has(id)
    );
  }

  /**
   * @internal The lazy-mount doors and `addParallelForEach` register their id
   * in no map, so through 9.37.0 they accepted an id another stage or mount
   * already had (and a later stage could take theirs). They claim it here:
   * refused when taken, recorded when fresh. Loop-ref stubs reference an
   * existing stage rather than claiming a new id. Reusable function stages
   * retain their separate `_addToMap` rule.
   */
  _claimFreshId(id: string, door: string): void {
    if (this._idTaken(id)) {
      fail(`${door}: id '${id}' is already used by another stage or mount in this chart. Give it its own id.`);
    }
    this._claimedIds.add(id);
  }

  /**
   * Advance the spec cursor. Retained as a method so call sites stay
   * one-liners and future cursor-related side effects have a hook.
   */
  /**
   * What was attached to the CURSOR without advancing it — a subflow mount, a
   * parallel fork's children. Cleared by {@link _advanceCursorSpec}, the single
   * choke point every cursor-advancing method already goes through, so this
   * marker cannot drift as new builder methods are added.
   *
   * Exists for `.retry()`. Those methods hang children off the current stage
   * and leave the cursor pointing at that stage, so a chained `.retry()` would
   * silently attach the policy to the stage BEFORE the thing you just wrote —
   * exactly the silent mis-attribution this codebase refuses elsewhere (see
   * the branch-segment marker rules). Naming what was last added lets the
   * refusal say something useful.
   */
  private _cursorTail?: string;

  private _advanceCursorSpec(newSpec: SerializedPipelineStructure | undefined): void {
    this._cursorTail = undefined;
    this._cursorSpec = newSpec;
  }

  _stageMapHas(key: string): boolean {
    return this._stageMap.has(key);
  }

  /**
   * @internal Register a mounted subflow's definition — first mount wins,
   * at every eager mount site (linear, fork child, decider and selector
   * branch). A SECOND mount under the same id is allowed (existing charts do
   * it) and shares the first one's definition — but a pause inside either
   * cannot be resumed: a checkpoint's `subflowPath` names the subflow id, not
   * the mount, so `resume()` refuses the ambiguous path. Dev mode says so
   * here, at build time, where the id can still be changed.
   */
  _registerSubflowDef(id: string, root: StageNode<TOut, TScope>): void {
    this._refuseForkNodeId(id);
    if (!this._subflowDefs.has(id)) {
      this._subflowDefs.set(id, { root });
      return;
    }
    if (isDevMode()) {
      // eslint-disable-next-line no-console
      console.warn(
        `[footprint] subflow id '${id}' is mounted more than once in this chart. The mounts share one ` +
          'definition, and a pause inside either cannot be resumed — the checkpoint cannot say which mount ' +
          'paused. Give each mount its own id.',
      );
    }
  }

  /**
   * @internal One admission path for optional-function children and branches.
   * A missing function does not erase the graph identity: check reservations
   * and record it for future fresh-id claims, without adding a function or a
   * loop target. Existing function references by id/name remain legal.
   */
  _registerStage(id: string, fn: StageFunction<TOut, TScope> | undefined): void {
    if (fn) {
      this._addToMap(id, fn);
      return;
    }
    this._refuseForkNodeId(id);
    this._functionlessStageIds.add(id);
  }

  _addToMap(id: string, fn: StageFunction<TOut, TScope>) {
    this._refuseForkNodeId(id);
    if (this._stageMap.has(id)) {
      const existing = this._stageMap.get(id);
      if (existing !== fn) fail(`stageMap collision for id '${id}'`);
    }
    this._stageMap.set(id, fn);
  }

  _mergeStageMap(other: Map<string, StageFunction<TOut, TScope>>, prefix?: string) {
    for (const [k, v] of other) {
      const key = prefix ? joinPath(prefix, k) : k;
      if (this._stageMap.has(key)) {
        const existing = this._stageMap.get(key);
        if (existing !== v) fail(`stageMap collision while mounting flowchart at '${key}'`);
      } else {
        this._stageMap.set(key, v);
      }
    }
  }

  /**
   * Prefix a node tree with a subflow path segment at MOUNT time — the one
   * prefixer, `engine/graph/prefixNodeTree.ts` (the traverser calls the same
   * function at RUN time). Kept as the builder's door for its mount sites.
   */
  _prefixNodeTree(node: StageNode<TOut, TScope>, prefix: string): StageNode<TOut, TScope> {
    return prefixNodeTree(node, prefix);
  }

  /**
   * THE mount of a subflow chart under `id` (F10) — every eager mount site
   * (`addSubFlowChart`, `addSubFlowChartNext`, a decider/selector
   * `addSubFlowChartBranch`) goes through it, and it is the one caller of the
   * prefixer. In order: register the chart's prefixed root under `id`;
   * `place` the mount's own node + spec and fire its structure events; merge
   * the chart's stage map under `id`; register its nested subflows under
   * `id/<key>` (a key already registered is kept).
   */
  _mountSubflow(id: string, subflow: FlowChart<any, any>, place: () => void): void {
    const prefixed = (root: StageNode<TOut, TScope>) => this._prefixNodeTree(root, id);
    this._registerSubflowDef(id, prefixed(subflow.root));
    place();
    this._mergeStageMap(subflow.stageMap, id);
    if (!subflow.subflows) return;
    for (const [key, def] of Object.entries(subflow.subflows)) {
      const prefixedKey = joinPath(id, key);
      if (!this._subflowDefs.has(prefixedKey)) {
        this._subflowDefs.set(prefixedKey, { root: prefixed(def.root as StageNode<TOut, TScope>) });
      }
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Factory Function
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Start a flowchart with its first stage; returns a fluent builder.
 *
 * Chain `.addFunction()` / `.addDeciderFunction()` / `.addSelectorFunction()` /
 * `.addSubFlowChart()` etc. to add more stages, then finish with `.build()`.
 *
 * @param name    Human-readable display label for the stage (shown in the narrative/trace).
 * @param fn      The stage's work — a `(scope) => …` function, or a `PausableHandler` for human-in-the-loop pauses.
 * @param id      Stable stage id used in traces, the commit log, and `runtimeStageId`. Keep it unique within the chart.
 * @param options Optional `{ description?, structureRecorders? }`.
 *
 * @example
 * const chart = flowChart<State>('FetchUser', async (scope) => {
 *   scope.user = await getUser();
 * }, 'fetch-user')
 *   .addFunction('Process', processFn, 'process')
 *   .build();
 *
 * const trace = narrative();
 * const result = await chart.recorder(trace).run();
 * console.log(trace.getEntries().map((e) => e.text).join('\n'));
 */
// Overload 1: typed state with options object.
export function flowChart<TState extends object>(
  name: string,
  fn: TypedStageFunction<TState> | PausableHandler<TypedScope<TState>>,
  id: string,
  options?: FlowChartOptions,
): FlowChartBuilder<any, TypedScope<TState>>;

// Overload 2: explicit generics with options object.
export function flowChart<TOut = any, TScope = any>(
  name: string,
  fn: StageFunction<TOut, TScope> | PausableHandler<TScope>,
  id: string,
  options?: FlowChartOptions,
): FlowChartBuilder<TOut, TScope>;

// Single implementation — accepts the options bag (or undefined).
export function flowChart<TOut = any, TScope = any>(
  name: string,
  fn: StageFunction<TOut, TScope> | PausableHandler<TScope>,
  id: string,
  options?: FlowChartOptions,
): FlowChartBuilder<TOut, TScope> {
  const builder = new FlowChartBuilder<TOut, TScope>();
  // Attach StructureRecorders BEFORE start() so the seed event fires through
  // the normal dispatcher path (no replay needed). Iteration order matches
  // array order, matching the fluent `.attachStructureRecorder()` chain
  // semantics.
  if (options?.structureRecorders) {
    for (const rec of options.structureRecorders) {
      builder.attachStructureRecorder(rec);
    }
  }
  return builder.start(name, fn as any, id, options?.description, {
    ...(options?.retry && { retry: options.retry }),
    ...(options?.tags && { tags: options.tags }),
  });
}

/**
 * Like `flowChart()`, but the ROOT stage is a SELECTOR — it runs first and
 * its branches attach directly to it (no separate seed stage). Returns a
 * `SelectorFnList`; declare branches then call `.end()` to get the builder
 * back for any subsequent stages.
 *
 * @example
 *   flowChartSelector<MyState>('Context', contextSelectorFn, 'context')
 *     .addSubFlowChartBranch('sf-system-prompt', sysSlot, 'System Prompt', {...})
 *     .addSubFlowChartBranch('sf-messages', msgSlot, 'Messages', {...})
 *     .end()
 *     .addFunction('messageAPI', assembleFn, 'message-api')
 *     .build();
 */
export function flowChartSelector<TOut = any, TScope = any>(
  name: string,
  fn: StageFunction<any, TScope>,
  id: string,
  options?: FlowChartOptions,
): SelectorFnList<TOut, TScope> {
  const builder = new FlowChartBuilder<TOut, TScope>();
  if (options?.structureRecorders) {
    for (const rec of options.structureRecorders) {
      builder.attachStructureRecorder(rec);
    }
  }
  return builder.startSelector(name, fn, id, options?.description, {
    ...(options?.failFast !== undefined && { failFast: options.failFast }),
    ...(options?.retry && { retry: options.retry }),
    ...(options?.tags && { tags: options.tags }),
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Spec to StageNode Converter
// ─────────────────────────────────────────────────────────────────────────────

export function specToStageNode(spec: FlowChartSpec): StageNode<any, any> {
  const inflate = (s: FlowChartSpec): StageNode<any, any> => ({
    name: s.name,
    id: s.id,
    children: s.children?.length ? s.children.map(inflate) : undefined,
    next: s.next ? inflate(s.next) : undefined,
  });
  return inflate(spec);
}
