/**
 * ParallelForEachHandler — dynamic fan-out: one branch per item, branch COUNT
 * decided at runtime from the payload.
 *
 * Design: docs/design/execution-control.md (D1 + D2). Round B builds exactly
 * that document.
 *
 * ## What this handler does NOT invent
 *
 * Almost everything here is existing machinery, wired together:
 *
 * - **Each branch is a generated SUBFLOW.** Its path segment is
 *   `<parentStageId>~<index>` (see `engine/branchSegment.ts`) — a subflowPath
 *   segment in the grammar that already ships, NOT a new delimiter class. So a
 *   branch gets, for free: a fresh isolated `ExecutionRuntime` (branches cannot
 *   corrupt each other's in-flight state), the inputMapper seam for feeding the
 *   item in, and — the point of the whole design — `parseRuntimeStageId`,
 *   `causalChain`, `sliceForKey` and `forwardSliceForKey` reading branch
 *   commits with ZERO changes, because the id shape IS the shipped shape.
 * - **The fan-out itself is `ChildrenExecutor`.** That is what makes the
 *   failure policy "Parallel's existing failure policy" rather than a second
 *   one: `failFast` → `Promise.all`, otherwise best-effort `Promise.allSettled`.
 *   It also fires `onFork` + `onStageExecuted('fork')` and bubbles a
 *   `PauseSignal` out of a branch, all unchanged.
 *
 * ## The laws this handler owns
 *
 * **Order is items order.** Results are assembled by index from the fan-out's
 * keyed results, never by completion order, and land as ONE array write on the
 * parent — so `into[i]` is always branch `i`'s result no matter which branch
 * finished first. A failed branch (best-effort mode) leaves `undefined` in its
 * slot; which branch failed is not reported here, because that gap is
 * pre-existing in the parallel fan-out and not this feature's to widen.
 *
 * **maxBranches truncates, and says so.** Items past the ceiling do not run.
 * The truncation is recorded in the stage's own commit-visible log and as a
 * flow message — bounded execution, stated, never silent.
 *
 * **Branch charts are re-registered on EVERY visit.** The generated segments
 * are stable across loop iterations, and subflow registration is normally
 * first-write-wins — which would mean a looping fan-out silently re-executing
 * iteration 1's branch charts forever, even when the factory returns different
 * charts. This handler overwrites instead. Per-iteration results stay
 * addressable through the mount's `runtimeStageId` key, exactly as they do for
 * a hand-authored looping subflow.
 *
 * **Event order.** `onStageStart` → the `items` read → `onFork` → branches →
 * the ordered-array write → `onStageEnd` → `onCommit`. The stage's own commit
 * therefore lands AFTER its `onFork`, which is the one place a stage's commit
 * follows its fan-out event — unavoidable and honest: the result is not
 * knowable until the branches settle.
 */

import type { StageContext } from '../../memory/StageContext.js';
import { unwrapHandles } from '../../reactive/handles.js';
import { IS_TYPED_SCOPE } from '../../reactive/types.js';
import { createProtectedScope } from '../../scope/protection/createProtectedScope.js';
import { buildBranchSegment } from '../branchSegment.js';
import type { StageNode } from '../graph/StageNode.js';
import type { TraversalContext } from '../narrative/types.js';
import type { BranchChart, HandlerDeps, NodeResultType, ParallelForEachConfig } from '../types.js';
import type { ChildrenExecutor } from './ChildrenExecutor.js';

/**
 * Traverser-owned operations the handler needs. Passed as functions (not the
 * traverser) so the handler keeps the same no-back-reference shape as every
 * other handler in this directory.
 */
export interface ParallelForEachHooks<TOut = any, TScope = any> {
  /** The traverser's `prefixNodeTree` — byte-twin of the builder's `_prefixNodeTree`. */
  prefixNodeTree(node: StageNode<TOut, TScope>, prefix: string): StageNode<TOut, TScope>;
  /** Register (OVERWRITING) a generated branch subflow + its stage functions. */
  registerBranchSubflow(subflowId: string, root: StageNode<TOut, TScope>, chart: BranchChart): void;
  /** Read a completed branch's final shared state, for the `subflowOutput ?? state` fallback. */
  branchSharedState(subflowId: string): Record<string, unknown> | undefined;
  /** Mirror the generated branches into the runtime structure, for visualization. */
  recordBranchStructure(nodeId: string, branches: StageNode<TOut, TScope>[]): void;
}

export class ParallelForEachHandler<TOut = any, TScope = any> {
  constructor(
    private deps: HandlerDeps<TOut, TScope>,
    private childrenExecutor: ChildrenExecutor<TOut, TScope>,
    private hooks: ParallelForEachHooks<TOut, TScope>,
  ) {}

  /**
   * Run the fan-out to completion and commit the ordered results.
   * Returns the results array (the stage's output).
   */
  async run(
    node: StageNode<TOut, TScope>,
    context: StageContext,
    branchPath: string | undefined,
    traversalContext: TraversalContext,
  ): Promise<unknown[]> {
    const config = node.parallelForEach as ParallelForEachConfig<unknown, TScope>;

    // Same scope construction StageRunner performs, protection included: this
    // stage has no user function, but `items(scope)` IS user code, so its reads
    // are tracked and a stray assignment inside it is caught by the same
    // protection every other stage gets. (TypedScope brings its own proxy.)
    const rawScope = this.deps.scopeFactory(context, node.name, this.deps.readOnlyContext, this.deps.executionEnv);
    const isTypedScope = rawScope && (rawScope as any)[IS_TYPED_SCOPE] === true;
    const scope = isTypedScope
      ? rawScope
      : (createProtectedScope(rawScope as object, {
          mode: this.deps.scopeProtectionMode,
          stageName: node.name,
        }) as TScope);
    notify(rawScope, 'notifyStageStart');

    const items = this.resolveItems(config, scope, node);
    const total = items.length;
    const branchCount = Math.min(total, config.maxBranches);
    const truncated = total > branchCount;

    context.addLog('parallelForEach', {
      items: total,
      branches: branchCount,
      maxBranches: config.maxBranches,
      truncated,
      into: config.into,
    });
    if (truncated) {
      // Stated, not silent — in the stage's own flow messages AND its logs above.
      context.addFlowDebugMessage(
        'children',
        `maxBranches reached: running ${branchCount} of ${total} items (${total - branchCount} not run)`,
        { count: branchCount },
      );
    }

    let results: unknown[];
    if (branchCount === 0) {
      // Zero items = zero branches: no fan-out event, an empty ordered array.
      results = [];
    } else {
      const branches = this.buildBranches(node, items, branchCount);
      this.hooks.recordBranchStructure(node.id, branches);

      // The fan-out node handed to ChildrenExecutor is a temp view carrying the
      // generated branches (same shape `executeSelectedChildren` uses for its
      // selected subset) — the shared graph node is never mutated, so a loop
      // revisit regenerates cleanly.
      const forkView: StageNode<TOut, TScope> = {
        ...node,
        children: branches,
        ...(config.failFast !== undefined && { failFast: config.failFast }),
      };

      const childResults = await this.childrenExecutor.executeNodeChildren(
        forkView,
        context,
        undefined,
        branchPath,
        traversalContext,
      );

      results = this.collectOrdered(node, branchCount, childResults);
    }

    this.writeResults(rawScope, context, config.into, results);
    notify(rawScope, 'notifyStageEnd');
    context.commit();

    return results;
  }

  /**
   * Evaluate the items selector against the live scope. A non-array return is
   * a chart bug, not a runtime condition — it fails loudly, naming the stage.
   *
   * The selector reads the typed scope, so what it returns is usually the
   * scope's own array HANDLE (a Proxy bound to the parent stage) and every
   * `items[index]` an element handle. The items are about to cross into
   * branch runtimes — closed over by `branch(item, index)` and seeded as the
   * branch's `item` — so they are taken as VALUES here (`unwrapHandles`,
   * reactive/handles.ts). 9.22.0–9.23.2 seeded the handle itself and every
   * branch over an object item failed at its seed commit (DataCloneError).
   */
  private resolveItems(
    config: ParallelForEachConfig<unknown, TScope>,
    scope: TScope,
    node: StageNode<TOut, TScope>,
  ): readonly unknown[] {
    const items = unwrapHandles(config.items(scope));
    if (items === undefined || items === null) return [];
    if (!Array.isArray(items)) {
      throw new Error(
        `parallelForEach '${node.id}': items() must return an array (got ${typeof items}). ` +
          'Return [] to run zero branches.',
      );
    }
    return items;
  }

  /** Generate one subflow-mount node per branch, registering each branch chart. */
  private buildBranches(
    node: StageNode<TOut, TScope>,
    items: readonly unknown[],
    branchCount: number,
  ): StageNode<TOut, TScope>[] {
    const config = node.parallelForEach as ParallelForEachConfig<unknown, TScope>;
    const branches: StageNode<TOut, TScope>[] = [];

    for (let index = 0; index < branchCount; index++) {
      const item = items[index];
      const subflowId = buildBranchSegment(node.id, index);
      const chart = config.branch(item, index);
      if (!chart || !chart.root) {
        throw new Error(
          `parallelForEach '${node.id}': branch(item, ${index}) must return a built chart ` +
            '(the result of flowChart(...).build()).',
        );
      }

      // Same prefixing a lazy subflow gets — the branch's inner ids become
      // `<segment>/<id>`, so its stages address as `<segment>/<id>#<n>`.
      const prefixedRoot = this.hooks.prefixNodeTree(chart.root as StageNode<TOut, TScope>, subflowId);
      this.hooks.registerBranchSubflow(subflowId, prefixedRoot, chart);

      branches.push({
        name: `${node.name} [${index}]`,
        id: subflowId,
        isSubflowRoot: true,
        subflowId,
        subflowName: `${node.name} [${index}]`,
        subflowMountOptions: {
          // D1's "inputMapper seam for feeding the item in": the item is
          // visible IN the branch's scope (and so in its commit log) as well as
          // closed over by the factory — provenance beats a hidden closure.
          inputMapper: () => ({ item, index }),
        },
      });
    }

    return branches;
  }

  /**
   * Assemble results in ITEMS order — never completion order.
   *
   * The branch's value is its subflow output, falling back to the branch's
   * final shared state (the TypedScope case, where stage functions return
   * void) — the same `subflowOutput ?? sharedState` rule `SubflowExecutor`
   * applies to an outputMapper.
   */
  private collectOrdered(
    node: StageNode<TOut, TScope>,
    branchCount: number,
    childResults: Record<string, NodeResultType>,
  ): unknown[] {
    const ordered: unknown[] = [];
    for (let index = 0; index < branchCount; index++) {
      const subflowId = buildBranchSegment(node.id, index);
      const entry = childResults[subflowId];
      if (entry === undefined || entry.isError) {
        // Best-effort mode: a failed branch keeps its SLOT (order is items
        // order) with an undefined value. failFast mode never reaches here —
        // the error already rejected the whole stage.
        ordered.push(undefined);
        continue;
      }
      ordered.push(entry.result ?? this.hooks.branchSharedState(subflowId));
    }
    return ordered;
  }

  /**
   * Write the ordered array as ONE value on the parent scope.
   *
   * `$setValue` deliberately, where available: the TypedScope set trap
   * JSON-round-trips every object write (Date→string, Map→{}), and branch
   * results are exactly the kind of payload that would silently degrade.
   */
  private writeResults(rawScope: TScope, context: StageContext, into: string, results: unknown[]): void {
    const s = rawScope as unknown as Record<string, unknown>;
    if (typeof s?.$setValue === 'function') {
      (s.$setValue as (key: string, value: unknown) => void)(into, results);
      return;
    }
    if (typeof s?.setValue === 'function') {
      (s.setValue as (key: string, value: unknown) => void)(into, results);
      return;
    }
    // No facade (hand-rolled scope factory) — write straight to the frame.
    context.setGlobal(into, results);
  }
}

/** Fire a scope lifecycle notification if the scope supports it. */
function notify(scope: unknown, method: 'notifyStageStart' | 'notifyStageEnd'): void {
  const s = scope as Record<string, unknown> | undefined;
  if (s && typeof s[method] === 'function') (s[method] as () => void)();
}
