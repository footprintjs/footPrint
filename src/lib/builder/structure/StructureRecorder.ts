/**
 * StructureRecorder — passive observer of BUILD-TIME chart construction events.
 *
 * The build-time twin of `FlowRecorder`. Where `FlowRecorder` observes
 * RUNTIME control-flow transitions (per-execution `runtimeStageId`,
 * iteration counts, errors, pauses), `StructureRecorder` observes
 * STATIC chart shape as it's assembled by the builder — every spec
 * node added, every outgoing edge wired, every decider closed.
 *
 * Why two interfaces, not one
 * ───────────────────────────
 *   Build and runtime events have different INVARIANTS, not just
 *   different timing:
 *
 *     - Runtime events carry `runtimeStageId` (`[subflowPath/]stageId#N`),
 *       `iteration`, `traversalContext` — load-bearing for time-travel
 *       UIs, commit-log indices, and `SequenceRecorder<T>` consumers.
 *       NONE of these exist at build time.
 *
 *     - Build events carry only `stageId` + structural fields. No
 *       execution index, no iteration, no snapshot.
 *
 *     - Some events have no analog across phases: `onPause` /
 *       `onResume` / `onError` / `onRunStart` are runtime-only;
 *       `onDeciderComplete` / `onStageAdded` are build-only.
 *
 *   A single `FlowRecorder` with `phase: 'static' | 'dynamic'`
 *   discriminator would force every consumer to write
 *   `if (e.phase === 'static') ...` branches and would erase the
 *   least-privilege boundary (a static-only consumer should NOT
 *   accidentally observe runtime data — e.g., a public docs site
 *   rendering chart topology must not see scope values).
 *
 *   Two interfaces, same mental model, clean separation. Two
 *   registration sites ship today (pick whichever fits your call
 *   site):
 *
 *     1. **Options-bag** (preferred when the recorder set is known
 *        at construction time — registers BEFORE `start()` so even
 *        the seed event fires through the normal dispatcher fan-out):
 *        ```ts
 *        flowChart('seed', fn, 'seed', { structureRecorders: [rec] })
 *          .addFunction('a', fnA, 'a').build();
 *        ```
 *
 *     2. **Fluent** (preferred when attach is conditional, late, or
 *        in a chain builder — the just-attached recorder gets a
 *        one-time seed replay so it observes the root stage):
 *        ```ts
 *        flowChart('seed', fn, 'seed')
 *          .attachStructureRecorder(rec)
 *          .addFunction('a', fnA, 'a').build();
 *        ```
 *
 *   Both deliver the same event stream to the same recorder. See the
 *   `@example` block below for a fully-fleshed-out implementation.
 *
 * Lifecycle + ordering invariants
 * ───────────────────────────────
 *   - Fires SYNCHRONOUSLY during builder chain calls (and during
 *     `.build()` for the terminal node) at the natural moment each
 *     spec mutation completes.
 *   - `onStageAdded(A)` and `onStageAdded(B)` fire BEFORE any
 *     `onEdgeAdded({from: A, to: B})` — endpoint registration
 *     happens before edge wiring.
 *   - `onDeciderComplete(D)` fires at sub-builder `.end()` time, AFTER
 *     every child's `onStageAdded` and every `onEdgeAdded({from: D,
 *     to: child})`. Marks the decider as no-further-mutation.
 *   - `onSubflowMounted({subflowId})` fires once per mount.
 *     **MOUNT-ONLY**: parent recorders do NOT receive a replay of
 *     the subflow's own internal structure events (those fired
 *     during the subflow's own `.build()`). Matches the runtime
 *     `onSubflowEntry` semantics — composition over replay.
 *
 * Error isolation (matches FlowRecorder contract)
 * ───────────────────────────────────────────────
 *   - A throwing handler is caught, logged via `isDevMode()` warning,
 *     and accumulated on `builder.getStructureBuildErrors()` for
 *     post-hoc inspection.
 *   - Subsequent recorders + subsequent events fire normally; one
 *     misbehaving recorder cannot THROW its way into blocking
 *     construction.
 *   - The errors[] accumulator is soft-capped (~100 entries) with a
 *     `__truncated__` sentinel record once the cap is hit, to prevent
 *     unbounded growth on chatty broken recorders.
 *   - Note: throw isolation does NOT defend against a handler that
 *     succeeds at runtime but mutates `event.spec` to corrupt the
 *     chart. See "Spec mutation" below.
 *
 * Spec mutation — readonly-by-contract (NOT runtime-enforced)
 * ────────────────────────────────────────────────────────────
 *   - Event payloads pass spec references where useful (e.g., `spec`
 *     on `onStageAdded`). Every field on every event payload is
 *     marked `readonly` in TypeScript — the type system signals
 *     consumer intent at author time.
 *   - There is NO runtime freeze. The builder fires `onStageAdded`
 *     IMMEDIATELY when a spec node is added, BEFORE the builder
 *     wires that node's `.next`/`.children`/`.loopTarget` in the
 *     subsequent `addX` call. Freezing here would break the
 *     builder's own subsequent mutation.
 *   - Handler mutation of `event.spec` is DOCUMENTED UNDEFINED
 *     BEHAVIOR — it will succeed at runtime, but is not supported
 *     and downstream consumers may break. Specifically, mutating
 *     `event.spec.fn`, `event.spec.id`, or `event.spec.children`
 *     can corrupt subsequent runtime behavior of the chart.
 *   - **Trust model**: attach ONLY recorders from trusted code paths.
 *     A hostile or buggy recorder can effectively substitute stage
 *     functions or rewire the chart structure. The `readonly`
 *     markers cannot defend against intentional mutation.
 *
 * @example
 * ```ts
 * class TraceStructureRecorder implements StructureRecorder {
 *   readonly id = 'trace-static';
 *   nodes: XyflowNode[] = [];
 *   edges: XyflowEdge[] = [];
 *
 *   onStageAdded(e) {
 *     // Node role: 'stage' is the initial type. If outgoing edges
 *     // arrive with kind 'fork-branch' / 'decision-branch' the node
 *     // is functioning as a fork/decider — derive the visual style
 *     // from those edges, not from `e.type` alone.
 *     this.nodes.push({ id: e.stageId, type: 'lensStage', data: { label: e.name } });
 *   }
 *   onEdgeAdded(e) {
 *     this.edges.push({ id: `${e.from}->${e.to}`, source: e.from, target: e.to });
 *   }
 *   onSubflowMounted(e) {
 *     this.nodes.push({ id: e.subflowId, type: 'subflow', data: { label: e.subflowName } });
 *   }
 *   onDeciderComplete(e) {
 *     // Optional: finalize node styling now that branch list is sealed.
 *   }
 * }
 *
 * // Registration option A — options-bag (preferred when recorders
 * // are known up front; attaches BEFORE the seed event fires):
 * const rec = new TraceStructureRecorder();
 * const builder = flowChart('seed', fn, 'seed', {
 *   structureRecorders: [rec],
 * }).addFunction('a', fnA, 'a');
 * const chart = builder.build();
 *
 * // Registration option B — fluent chain (preferred for conditional
 * // or late attach; the just-attached recorder gets a seed replay):
 * const rec2 = new TraceStructureRecorder();
 * const builder2 = flowChart('seed', fn, 'seed')
 *   .attachStructureRecorder(rec2)
 *   .addFunction('a', fnA, 'a');
 *
 * // Inspect any recorder errors (call on the BUILDER, not the chart):
 * const errors = builder.getStructureBuildErrors();
 *
 * <ReactFlow nodes={rec.nodes} edges={rec.edges} />
 * ```
 */

import type { FlowChartSpec, SerializedPipelineStructure } from '../types.js';

// ─────────────────────────────────────────────────────────────────────────────
// Event payload types
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Event payload for `StructureRecorder.onStageAdded`. Fires for every
 * spec node added to the chart, including the seed (added via
 * `flowChart()` factory) and subflow mount nodes. Excludes synthetic
 * loop-reference nodes (those carry `isLoopReference: true` on the
 * spec; consumers see them via the separate `onLoopEdgeAdded` event
 * instead of as fresh stages).
 */
export interface StructureStageAddedEvent {
  /**
   * Stable identifier for this node. AT EVENT FIRE TIME this is the
   * builder's LOCAL form (no subflow prefix — the prefix is applied
   * later by `_prefixNodeTree` when this builder is mounted as a
   * subflow into a parent).
   *
   * Note: `spec.id` is a LIVE reference. If you read it AFTER this
   * chart has been mounted as a subflow, it may have been rewritten
   * to the FULL prefixed form. Use `splitStageId(spec.id)` from
   * `footprintjs/trace` to decompose it back into local + subflowPath.
   *
   * Correlating with runtime events:
   *   - Same builder (no mount) →
   *     `event.stageId === parseRuntimeStageId(runtime).stageId`
   *   - This builder mounted as subflow → use `splitStageId` on the
   *     prefixed form (or `parseRuntimeStageId` on the full
   *     runtimeStageId) before comparing.
   */
  readonly stageId: string;
  /** Human-readable label for the node. */
  readonly name: string;
  /** Spec node `type`. Lets recorders branch on stage vs decider vs
   *  fork vs subflow without re-deriving from other fields. */
  readonly type: NonNullable<FlowChartSpec['type']>;
  /** True for nodes added via `addPausableFunction()` — useful for
   *  visualisers that want to mark stages that can pause execution. */
  readonly isPausable?: boolean;
  /** Live reference to the full spec node, for handlers that want
   *  details beyond the discriminator fields above. MUST NOT be
   *  mutated by the handler — readonly is type-level intent; no
   *  runtime freeze. See "Spec mutation" in the file header for the
   *  trust-model caveats. */
  readonly spec: FlowChartSpec;
}

/** Edge kinds the builder produces at structural time. Matches the
 *  footprintjs control-flow vocabulary used at runtime.
 *
 *  Why no `subflow-entry` here: subflow mounts use the lifecycle
 *  event `onSubflowMounted` (not an edge event). If a future use case
 *  needs the parent→subflow-root edge as a distinct kind, it'll be
 *  added then — YAGNI now (Panel 3, L7.2 review). */
export type StructureEdgeKind =
  | 'next' // linear chain: prev.next = curr
  | 'fork-branch' // fork parent → parallel child
  | 'decision-branch'; // decider → branch child

/**
 * Event payload for `StructureRecorder.onEdgeAdded`. Fires whenever
 * the builder wires an outgoing edge from one node to another. Both
 * endpoints have already been announced via `onStageAdded` by the
 * time this fires.
 *
 * Loop back-edges have their OWN event (`onLoopEdgeAdded`) so
 * consumers can theme them distinctly and so build-time events stay
 * free of the runtime-only `iteration` field.
 */
export interface StructureEdgeAddedEvent {
  readonly from: string;
  readonly to: string;
  readonly kind: StructureEdgeKind;
  /** Optional human-readable label — used today for decider branch
   *  keys (e.g., `'low'`, `'high'`, `'high (default)'`) and parallel
   *  branch ids. */
  readonly label?: string;
}

/**
 * Event payload for `StructureRecorder.onLoopEdgeAdded`. Fires when
 * `.loopTo(target)` installs a back-edge. Distinct from
 * `onEdgeAdded` so consumers can theme back-edges differently and
 * because runtime `onLoop` carries `iteration: number` which has no
 * build-time meaning — keeping the events separated avoids forcing
 * an `iteration?: number` lie into the structural shape.
 */
export interface StructureLoopEdgeAddedEvent {
  readonly from: string;
  readonly to: string;
}

/**
 * Event payload for `StructureRecorder.onDeciderComplete`. Fires
 * when a decider / selector sub-builder closes via `.end()`. By the
 * time this fires every branch has been announced and the
 * `defaultBranch` (if set via `.setDefault()`) is final. Lets
 * recorders treat the decider as no-further-mutation and snapshot
 * its branch list as final.
 */
export interface StructureDeciderCompleteEvent {
  /** Decider / selector stage id. */
  readonly decider: string;
  /** Spec type (`'decider'` vs `'selector'`) — exposed so consumers
   *  don't need to look up the original `onStageAdded` event. */
  readonly type: 'decider' | 'selector';
  /** Branch member ids in declaration order. */
  readonly branchIds: readonly string[];
  /** Default branch id when set via `.setDefault()`; undefined when
   *  no default is configured (e.g., selectors). */
  readonly defaultBranch?: string;
}

/**
 * Event payload for `StructureRecorder.onSubflowMounted`. Fires once
 * per subflow mount (`addSubFlowChart` / `addSubFlowChartNext` and
 * their lazy variants).
 *
 * **MOUNT-ONLY semantics** — the subflow's OWN structure events
 * (every `onStageAdded` / `onEdgeAdded` inside the subflow) fired
 * during the subflow's own `.build()`, before the mount. Parent
 * recorders do NOT receive a replay. Instead, this event delivers
 * the subflow's full structure via `subflowSpec`, and consumers can
 * walk it via `walkSubflowSpec` from `footprintjs/trace`.
 *
 * This matches `FlowRecorder.onSubflowEntry` semantics at runtime
 * (parents see the boundary, not a replay of internals) and
 * preserves the "one purpose per recorder" convention.
 */
export interface StructureSubflowMountedEvent {
  /** Subflow identifier the parent assigned at mount. */
  readonly subflowId: string;
  /** Human-readable subflow name. */
  readonly subflowName: string;
  /** Mount node id in the parent's chart. */
  readonly rootStageId: string;
  /** True when the mount uses lazy resolution (deferred subflow
   *  resolution until execution). */
  readonly isLazy?: boolean;

  /**
   * The mounted subflow's complete spec — the SAME OBJECT
   * (=== reference equality) reachable via `subflow.buildTimeStructure`
   * for the FlowChart the consumer passed to `addSubFlowChartBranch` /
   * `addSubFlowChart` / `addSubFlowChartNext`.
   *
   * UNDEFINED for lazy mounts at build time (`isLazy: true`) — the
   * subflow's structure hasn't been resolved yet. Consumers waiting on
   * lazy subflows handle the runtime `onSubflowEntry` event instead.
   *
   * Immutable post-build; consumers MUST NOT mutate.
   *
   * @internal `SerializedPipelineStructure` is library-internal.
   *           Use `walkSubflowSpec` from `footprintjs/trace` for the
   *           stable public contract.
   */
  readonly subflowSpec?: SerializedPipelineStructure;

  /**
   * Local mount id of this subflow within its parent — equal to
   * `subflowId` for top-level mounts (e.g. `'auth'`), composed
   * (`'auth/verify'`) for nested mounts whose recorder is attached
   * to the grandparent. Matches runtime `traversalContext.subflowPath`
   * semantics — NEVER prefixed with `__root__/`.
   */
  readonly subflowPath: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// StructureRecorder interface
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Pluggable observer for BUILD-TIME chart construction events.
 *
 * All methods are optional — implement only the hooks you need.
 * Handlers fire SYNCHRONOUSLY during builder operations and `.build()`.
 * A throwing handler is caught (see "Error isolation" in the file
 * header); subsequent dispatch continues.
 *
 * Lifecycle: each `StructureRecorder` instance is registered via
 * EITHER the `flowChart()` options bag (`{ structureRecorders: [rec] }`)
 * OR the fluent `.attachStructureRecorder(rec)` chain — see the file
 * header for the trade-offs. Registration after `.build()` is
 * rejected (chart is sealed).
 */
export interface StructureRecorder {
  /**
   * Stable identifier — used by the dispatcher to scope error
   * messages and to support `detach(id)` lookup.
   *
   * Convention (matches `FlowRecorder.id` from CLAUDE.md):
   *   - domain-prefixed kebab-case (`'lens-structure'`,
   *     `'agentfootprint-composition'`, `'trace-explainable'`)
   *   - same id → multiple recorders coexist (NOT deduplicated by
   *     id; the dispatcher fires every attached recorder regardless)
   *   - `detach(id)` removes EVERY recorder with that id — be
   *     intentional about reuse if you rely on selective detach
   *
   * Choose a stable id at module load and don't randomise it across
   * runs — it lands in `StructureBuildError.recorderId` so debug
   * output is greppable.
   */
  readonly id: string;

  onStageAdded?(event: StructureStageAddedEvent): void;
  onEdgeAdded?(event: StructureEdgeAddedEvent): void;
  onLoopEdgeAdded?(event: StructureLoopEdgeAddedEvent): void;
  onDeciderComplete?(event: StructureDeciderCompleteEvent): void;
  onSubflowMounted?(event: StructureSubflowMountedEvent): void;
}
