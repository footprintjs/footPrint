/**
 * budget/timeBudget.ts — `timeBudget(chart)`: the slowest a chart can take, from what it declares (design
 * docs/design/2026-10-time-and-failure-evidence.md §3.2, packet P5).
 *
 * WHY: a retry policy is a promise about time. `{ attempts: 4, timeoutMs: 40_000, backoffMs: 1_000 }` can take
 * 4 × 40 000 + 3 × 1 000 = 163 000 ms, and a caller who gave the chart 120 s is not served by it — which is
 * knowable before a single stage runs. `.budget(ms)` declares the caller's contract on the chart; `build()` refuses
 * a chart whose declared policies can already take longer (owner ruling Q2) and warns, by name, about every stage it
 * cannot bound. An unbounded stage is never guessed around: it is counted as 0 and named.
 *
 * THE RULES (one walk of the built StageNode graph; each chain of `next` pointers is computed ONCE):
 *   - a stage with a function: `attempts × timeoutMs` plus the waits between its attempts (a function `backoffMs` is
 *     asked here, with the failed attempt and no error, under `resolveBackoffMs`'s law: a throw or a non-finite /
 *     negative wait is 0). No `timeoutMs` → unbounded `'no-timeout'`. More than `MAX_BACKOFF_ASKS` waits from a
 *     function → unbounded `'backoff'` (the waits it did read are kept as a floor);
 *   - a sequence: the sum. A decider, a selector, a fork: the node's own stage plus its slowest child (a fork's
 *     children, and a selector's picks, run at once);
 *   - a mounted subflow: its chart, walked the same way, under the ids the run gives its stages (`pay/charge`);
 *     a lazy one is unbounded `'lazy-subflow'` unless `assume.lazy[subflowId]` names the chart it resolves to;
 *   - `parallelForEach`: ONE branch — the branches run at once and `maxBranches` truncates, so the item count never
 *     adds time. The branch chart is built at run time, so it is unbounded `'items'` unless
 *     `assume.branches[stageId]` names it (its stages are reported under the first branch, `review~0/score`);
 *   - a loop is NEVER iterated. With no assumption it is unbounded `'loop'`, named by its target, and counted once.
 *     `assume.loops[targetId] = n` bounds it: each time the chart reaches the loop, every stage from the target to
 *     the loop's furthest source runs at most `n` times, each at its slowest. Nested loops multiply; two loops that
 *     overlap without nesting are one region bounded by the product of their passes (each can re-enter the other).
 *
 * TWO NUMBERS. `knownMs` counts what is bounded (an unbounded stage as 0, an unassumed loop once). Without
 * assumptions it is a time some run CAN take, so a budget below it cannot be kept — `over` and the build refusal
 * read it, on an unbounded path too. `worstCaseMs` is `knownMs` when every path is bounded, `null` otherwise; with an
 * assumed loop it is an upper bound (every pass is counted at its slowest branch).
 *
 * THREAT MODEL. The walk terminates on any graph: a chain is walked with a visited set (a `next` that closes on
 * itself is a loop), nesting is an explicit stack (no recursion — a 5 000-deep subflow nesting walks), a chain that
 * reaches itself through its children or a subflow is a loop, and every chain is computed once however often it is
 * mounted (memoised per node). Sums and products saturate at `Number.MAX_SAFE_INTEGER` — never `Infinity` or `NaN`.
 * Assumptions are read as own properties only, so a prototype member is never an assumption.
 *
 * What it does NOT count: the engine's own work between stages, a stage function that blocks the thread (a timeout
 * stops the WAITING, see the attempt runner), and a StageNode a stage returns at run time — any stage may grow the
 * graph that way, so the budget is of the graph the chart DECLARES.
 */

import { joinPath } from 'foottrace';

import { attemptCeiling, attemptTimeoutMs } from '../attempt/policy.js';
import { resolveBackoffMs } from '../attempt/runner.js';
import type { RetryPolicy } from '../attempt/types.js';
import type { FlowChart } from '../builder/types.js';
import { isDevMode } from '../devMode.js';
import type { StageNode } from '../engine/graph/StageNode.js';
import { buildBranchSegment } from '../ids/branchSegment.js';

// ─────────────────────────────────────────────────────────────────────────────
// Public shapes
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Why a stage keeps a path unbounded: no per-attempt cap (`'no-timeout'`); more waits from a function backoff than
 * the check asks (`'backoff'`); a loop with no assumed passes (`'loop'`, named by its target); a lazy subflow whose
 * chart is unknown at build (`'lazy-subflow'`); a `parallelForEach` whose branch chart is built at run time
 * (`'items'`).
 */
export type UnboundedReason = 'no-timeout' | 'backoff' | 'loop' | 'lazy-subflow' | 'items';

/** A stage on the slowest path, with what it declares and how many times the path runs it. */
export interface BudgetStep {
  /** The stage id as the run names it — a subflow's stages under their mount (`pay/charge`). */
  readonly stageId: string;
  /** How many attempts its policy allows (1 without one). */
  readonly attempts: number;
  /** The cap on one attempt; absent when the stage declares none (then `worstMs` is `null`). */
  readonly timeoutMs?: number;
  /** The waits between its attempts, in total. */
  readonly backoffMs: number;
  /** `attempts × timeoutMs + backoffMs` — `null` when the stage is unbounded. */
  readonly worstMs: number | null;
  /** How many times the path runs it — more than 1 only inside an assumed loop. */
  readonly passes: number;
}

/** A stage the check cannot bound, and why. */
export interface UnboundedStage {
  readonly stageId: string;
  readonly why: UnboundedReason;
}

/** What the caller knows that the chart does not declare. Keys are ids as the run names them. */
export interface BudgetAssumptions {
  /** A loop's TARGET id (what `loopTo` names) → the most passes through it each time the chart reaches it (≥ 1). */
  readonly loops?: Readonly<Record<string, number>>;
  /** A lazy mount's subflow id → the chart it resolves to. */
  readonly lazy?: Readonly<Record<string, FlowChart>>;
  /** A `parallelForEach` stage id → the chart one branch runs. */
  readonly branches?: Readonly<Record<string, FlowChart>>;
}

export interface TimeBudgetOptions {
  /** The budget to check against. Defaults to the chart's declared `.budget(ms)`. A finite number > 0. */
  readonly budgetMs?: number;
  readonly assume?: BudgetAssumptions;
}

/** What `timeBudget(chart)` reports. JSON-safe and frozen. */
export interface TimeBudgetReport {
  /** The worst case of the slowest path — `null` when any path is unbounded (see `unbounded`). */
  readonly worstCaseMs: number | null;
  /** The worst case of what IS bounded: an unbounded stage counts 0, an unassumed loop one pass. */
  readonly knownMs: number;
  /** The stages of the slowest path, in the order a run first reaches them — the path that makes `worstCaseMs`,
   *  or `knownMs` when a path is unbounded. `knownMs = Σ passes × (attempts × (timeoutMs ?? 0) + backoffMs)`. */
  readonly criticalPath: readonly BudgetStep[];
  /** Every stage that keeps a path unbounded, each named once, in chart order. */
  readonly unbounded: readonly UnboundedStage[];
  /** The budget checked against — absent when there is none. */
  readonly budgetMs?: number;
  /** `knownMs > budgetMs`: the chart can take longer than its budget. Always `false` without one. */
  readonly over: boolean;
}

/** The most times the check asks a function `backoffMs` for one stage; past it the stage is unbounded `'backoff'`. */
export const MAX_BACKOFF_ASKS = 1_000;

// ─────────────────────────────────────────────────────────────────────────────
// The entry points
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The slowest the chart can take, computed from its declared retry policies — and every stage that makes a path
 * unbounded, by name. See the module header for the rules.
 *
 * @example
 * ```ts
 * const report = timeBudget(chart, { budgetMs: 120_000, assume: { loops: { 'ask-again': 3 } } });
 * report.worstCaseMs;  // number, or null when a path is unbounded
 * report.criticalPath; // [{ stageId, attempts, timeoutMs, backoffMs, worstMs, passes }]
 * report.unbounded;    // [{ stageId, why: 'no-timeout' | 'backoff' | 'loop' | 'lazy-subflow' | 'items' }]
 * report.over;         // true when the chart can take longer than budgetMs
 * ```
 */
export function timeBudget(chart: FlowChart, options?: TimeBudgetOptions): TimeBudgetReport {
  if (!isChart(chart)) {
    throw new TypeError('timeBudget(chart): pass a built chart — the result of flowChart(...).build().');
  }
  if (options?.budgetMs !== undefined && !isPositiveMs(options.budgetMs)) {
    throw new TypeError(
      `timeBudget: budgetMs must be a finite number of milliseconds > 0 (got ${shown(options.budgetMs)}).`,
    );
  }
  const budgetMs = options?.budgetMs ?? declaredBudget(chart);
  const walk = new BudgetWalk(admitAssumptions(options?.assume));
  const ctx = walk.ctxOf(chart, '');
  const root = walk.evaluate({ ctx, start: chart.root });

  // A loop whose target the chart does not hold cannot be bounded by any assumption.
  const rootFlags = [...root.open].map((target) => ({ stageId: reported(ctx, target), why: 'loop' as const }));
  const bounded = root.bounded && root.open.size === 0;
  return Object.freeze({
    worstCaseMs: bounded ? root.known : null,
    knownMs: root.known,
    criticalPath: Object.freeze(criticalPathOf(root, walk.computed)),
    unbounded: Object.freeze(unboundedOf(root, rootFlags)),
    ...(budgetMs !== undefined && { budgetMs }),
    over: budgetMs !== undefined && root.known > budgetMs,
  });
}

/** The chart's declared budget (`.budget(ms)`, the spec root's `budgetMs`), or `undefined`. */
export function declaredBudget(chart: FlowChart): number | undefined {
  const budgetMs = chart.buildTimeStructure?.budgetMs;
  return isPositiveMs(budgetMs) ? budgetMs : undefined;
}

/** `build()`'s refusal for a declared budget the chart can already exceed, or `undefined` when it can keep it. */
export function budgetRefusal(report: TimeBudgetReport): string | undefined {
  if (!report.over || report.budgetMs === undefined) return undefined;
  const counted = report.criticalPath.filter((step) => contribution(step) > 0);
  const shownSteps = slowestInPathOrder(counted, 5).map(stepText);
  const more = counted.length > shownSteps.length ? `, and ${counted.length - shownSteps.length} more` : '';
  const uncounted =
    report.unbounded.length > 0 ? ` Not counted, having no bound: ${unboundedText(report.unbounded)}.` : '';
  return (
    `budget(${report.budgetMs}): the chart can take ${report.knownMs} ms, over its budget by ` +
    `${report.knownMs - report.budgetMs} ms. Slowest path: ${shownSteps.join('; ')}${more}. Lower attempts or ` +
    `timeoutMs on these stages, or raise the budget.${uncounted}`
  );
}

/** `build()`'s dev-mode warning for a declared budget it cannot check on every path, or `undefined`. */
export function budgetWarning(report: TimeBudgetReport, chartName: string): string | undefined {
  if (report.budgetMs === undefined || report.unbounded.length === 0) return undefined;
  return (
    `[footprint] chart '${chartName}' declares a budget of ${report.budgetMs} ms, but the check cannot bound ` +
    `every path: ${unboundedText(report.unbounded)}. Give a stage a retry({ timeoutMs }); bound a loop, a lazy ` +
    'subflow or a parallelForEach with timeBudget(chart, { assume }).'
  );
}

/** Charts already warned at run start — the warning is said once per chart. */
const warnedAtRunStart = new WeakSet<object>();

/**
 * The run-start warning (dev mode, once per chart): the run's deadline leaves the chart less time than its declared
 * budget, so a run that takes the time the chart declares will be cut short. `startedAt` is read BEFORE the run's
 * deadline is armed, so `timeoutMs` equal to the budget never warns.
 */
export function warnDeadlineUnderBudget(chart: FlowChart, deadline: number | undefined, startedAt: number): void {
  if (deadline === undefined || !isDevMode()) return;
  const budgetMs = declaredBudget(chart);
  if (budgetMs === undefined) return;
  const leftMs = deadline - startedAt;
  if (leftMs >= budgetMs || warnedAtRunStart.has(chart)) return;
  warnedAtRunStart.add(chart);
  // eslint-disable-next-line no-console
  console.warn(
    `[footprint] this run's deadline leaves ${Math.max(0, leftMs)} ms, less than the chart's declared budget of ` +
      `${budgetMs} ms ('${chart.root.name}'): a run that takes the time the chart declares will be cut short. Give ` +
      'the run its budget, or declare a smaller one.',
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// The walk
// ─────────────────────────────────────────────────────────────────────────────

const IN_PROGRESS = Symbol('in-progress');

/** Where a chain's ids live: its chart's subflow dictionary and stage map, and the prefix the run gives them. */
interface Ctx {
  readonly subflows: Readonly<Record<string, { root: StageNode }>> | undefined;
  readonly stageMap: ReadonlyMap<string, unknown> | undefined;
  readonly prefix: string;
  readonly memo: Map<StageNode, Chain | typeof IN_PROGRESS>;
}

interface ChainRef {
  readonly ctx: Ctx;
  readonly start: StageNode;
}

/** What a node runs inside itself, besides its own function. */
type Inside =
  | { readonly kind: 'none' }
  | { readonly kind: 'unbounded'; readonly why: UnboundedReason; readonly stageId: string }
  /** `boundary`: the chains are another chart (a subflow) — a loop cannot leave them. */
  | { readonly kind: 'chains'; readonly refs: readonly ChainRef[]; readonly boundary: boolean };

interface StageCost {
  readonly attempts: number;
  readonly timeoutMs?: number;
  readonly backoffMs: number;
  readonly knownMs: number;
  readonly worstMs: number | null;
  readonly why?: UnboundedReason;
}

/** One node of a chain. `multiplier` is how many times the chain runs it per pass of the chain. */
interface Position {
  readonly stageId: string;
  readonly cost: StageCost | undefined;
  readonly innerKnown: number;
  /** The slowest chain it runs inside itself — the critical path goes through it. */
  readonly via: Chain | undefined;
  /** Every chain it runs inside itself, in order. */
  readonly deps: readonly Chain[];
  readonly flags: UnboundedStage[];
  multiplier: number;
}

/** A computed chain: a run of `next` pointers, and what the nodes on it run inside themselves. */
interface Chain {
  readonly known: number;
  readonly bounded: boolean;
  /** Loop targets (raw ids) this chain jumps back to and does not hold — the enclosing chain resolves them. */
  readonly open: ReadonlySet<string>;
  readonly positions: readonly Position[];
}

interface Loop {
  readonly start: number;
  readonly end: number;
  readonly passes: number;
}

const NONE: Inside = { kind: 'none' };
const EMPTY: ReadonlySet<string> = new Set();

class BudgetWalk {
  /** Every chain, in the order computed: each one after every chain it runs inside itself. */
  readonly computed: Chain[] = [];
  private readonly ctxs = new Map<object, Map<string, Ctx>>();

  constructor(private readonly assume: BudgetAssumptions) {}

  ctxOf(
    owner: {
      readonly subflows?: Record<string, { root: StageNode }>;
      readonly stageMap?: ReadonlyMap<string, unknown>;
    },
    prefix: string,
  ): Ctx {
    let byPrefix = this.ctxs.get(owner);
    if (byPrefix === undefined) {
      byPrefix = new Map();
      this.ctxs.set(owner, byPrefix);
    }
    let ctx = byPrefix.get(prefix);
    if (ctx === undefined) {
      ctx = { subflows: owner.subflows, stageMap: owner.stageMap, prefix, memo: new Map() };
      byPrefix.set(prefix, ctx);
    }
    return ctx;
  }

  /**
   * Compute `root` and every chain it runs — an explicit stack, never recursion. A chain is marked in progress on
   * its first visit and pushes the chains it needs; it is computed on its second, when they are done. A chain that
   * needs one still in progress needs itself: an object cycle, counted as a loop.
   */
  evaluate(root: ChainRef): Chain {
    const stack: ChainRef[] = [root];
    while (stack.length > 0) {
      const ref = stack[stack.length - 1];
      const state = ref.ctx.memo.get(ref.start);
      if (state !== undefined && state !== IN_PROGRESS) {
        stack.pop();
        continue;
      }
      const nodes = chainOf(ref.start);
      const insides = nodes.nodes.map((node) => this.insideOf(node, ref.ctx));
      if (state === undefined) {
        ref.ctx.memo.set(ref.start, IN_PROGRESS);
        const before = stack.length;
        for (const inside of insides) {
          if (inside.kind !== 'chains') continue;
          for (const dep of inside.refs) if (!dep.ctx.memo.has(dep.start)) stack.push(dep);
        }
        if (stack.length > before) continue;
      }
      stack.pop();
      const chain = this.chainResult(ref.ctx, nodes, insides);
      ref.ctx.memo.set(ref.start, chain);
      this.computed.push(chain);
    }
    return root.ctx.memo.get(root.start) as Chain;
  }

  private insideOf(node: StageNode, ctx: Ctx): Inside {
    if (node.isDynamicParallel) {
      const stageId = reported(ctx, node.id);
      const chart = own(this.assume.branches, stageId);
      if (chart === undefined) return { kind: 'unbounded', why: 'items', stageId };
      const branch = buildBranchSegment(stageId, 0);
      return { kind: 'chains', refs: [{ ctx: this.ctxOf(chart, branch), start: chart.root }], boundary: true };
    }
    const children = node.children !== undefined && node.children.length > 0 ? node.children : undefined;
    if (node.isSubflowRoot && children === undefined && !hasFunction(node, ctx)) return this.mountOf(node, ctx);
    if (children !== undefined) {
      return { kind: 'chains', refs: children.map((start) => ({ ctx, start })), boundary: false };
    }
    return NONE;
  }

  /** A subflow mount — resolved the way the engine resolves it (`NodeResolver · resolveSubflowReference`). */
  private mountOf(node: StageNode, ctx: Ctx): Inside {
    const subflowId = reported(ctx, node.subflowId ?? node.id);
    if (node.subflowResolver !== undefined) {
      const chart = own(this.assume.lazy, subflowId);
      if (chart === undefined) return { kind: 'unbounded', why: 'lazy-subflow', stageId: subflowId };
      return { kind: 'chains', refs: [{ ctx: this.ctxOf(chart, subflowId), start: chart.root }], boundary: true };
    }
    const inline = node.subflowDef;
    if (inline?.root !== undefined) {
      return {
        kind: 'chains',
        refs: [{ ctx: this.ctxOf(inline as Parameters<BudgetWalk['ctxOf']>[0], ctx.prefix), start: inline.root }],
        boundary: true,
      };
    }
    const def = subflowDefOf(ctx.subflows, node);
    return def === undefined ? NONE : { kind: 'chains', refs: [{ ctx, start: def.root }], boundary: true };
  }

  private chainResult(ctx: Ctx, shape: ChainShape, insides: readonly Inside[]): Chain {
    const { nodes } = shape;
    const at = new Map<string, number>();
    nodes.forEach((node, i) => {
      if (!at.has(node.id)) at.set(node.id, i);
    });
    const backEdges: Array<readonly [number, number]> = [];
    const open = new Set<string>();
    // A jump to a target this chain holds at or before `from` is a loop over [target, from]; a forward jump repeats
    // nothing; a target the chain does not hold is the enclosing chain's to resolve.
    const jump = (target: string, from: number) => {
      const j = at.get(target);
      if (j === undefined) open.add(target);
      else if (j <= from) backEdges.push([j, from]);
    };

    let bounded = true;
    const positions: Position[] = nodes.map((node, q) => {
      const stageId = reported(ctx, node.id);
      const flags: UnboundedStage[] = [];
      const cost = hasFunction(node, ctx) ? stageCost(node.retry) : undefined;
      if (cost?.why !== undefined) flags.push({ stageId, why: cost.why });
      const inner = this.innerOf(insides[q], flags);
      for (const target of inner.open) jump(target, q);
      if (cost?.worstMs === null || !inner.bounded) bounded = false;
      return { stageId, cost, innerKnown: inner.known, via: inner.via, deps: inner.deps, flags, multiplier: 1 };
    });
    if (shape.backTo !== undefined) backEdges.push([nodes.indexOf(shape.backTo), nodes.length - 1]);
    if (shape.backId !== undefined) jump(shape.backId, nodes.length - 1);

    if (!this.applyLoops(positions, backEdges)) bounded = false;
    let known = 0;
    for (const p of positions) known = add(known, mul(p.multiplier, add(p.cost?.knownMs ?? 0, p.innerKnown)));
    return { known, bounded, open, positions };
  }

  /** The slowest of the chains a node runs inside itself (they are alternatives, or run at once). */
  private innerOf(
    inside: Inside,
    flags: UnboundedStage[],
  ): { known: number; bounded: boolean; via?: Chain; deps: Chain[]; open: ReadonlySet<string> } {
    if (inside.kind === 'none') return { known: 0, bounded: true, deps: [], open: EMPTY };
    if (inside.kind === 'unbounded') {
      flags.push({ stageId: inside.stageId, why: inside.why });
      return { known: 0, bounded: false, deps: [], open: EMPTY };
    }
    let via: Chain | undefined;
    let bounded = true;
    const deps: Chain[] = [];
    const open = new Set<string>();
    for (const ref of inside.refs) {
      const chain = ref.ctx.memo.get(ref.start);
      if (chain === undefined || chain === IN_PROGRESS) {
        flags.push({ stageId: reported(ref.ctx, ref.start.id), why: 'loop' });
        bounded = false;
        continue;
      }
      deps.push(chain);
      if (!chain.bounded) bounded = false;
      for (const target of chain.open) {
        if (!inside.boundary) {
          open.add(target);
          continue;
        }
        // A subflow's own traverser looks its loop targets up in its own chart: one it does not hold never resolves.
        flags.push({ stageId: reported(ref.ctx, target), why: 'loop' });
        bounded = false;
      }
      if (via === undefined || chain.known > via.known) via = chain;
    }
    return { known: via?.known ?? 0, bounded, ...(via !== undefined && { via }), deps, open };
  }

  /**
   * Turn a chain's back-edges into each position's multiplier. One loop per target, spanning to its furthest
   * source. Loops are taken in start order on a stack of nested ones; a loop that overlaps the one it starts inside
   * without nesting merges with it (the product of their passes — each can re-enter the other), so what is left is
   * laminar, and one sweep multiplies every position by the loops around it. Returns false when a loop has no
   * assumed passes (it is flagged on its target and counted once).
   */
  private applyLoops(positions: Position[], backEdges: ReadonlyArray<readonly [number, number]>): boolean {
    if (backEdges.length === 0) return true;
    const ends = new Map<number, number>();
    for (const [target, source] of backEdges) ends.set(target, Math.max(ends.get(target) ?? target, source));

    let bounded = true;
    const done: Loop[] = [];
    const active: Loop[] = [];
    for (const [start, end] of [...ends].sort((a, b) => a[0] - b[0])) {
      const target = positions[start];
      const passes = own(this.assume.loops, target.stageId);
      if (passes === undefined) {
        target.flags.push({ stageId: target.stageId, why: 'loop' });
        bounded = false;
      }
      // The active loops nest (each inside the one below it): the innermost ends first.
      let top = lastOf(active);
      while (top !== undefined && top.end < start) {
        done.push(top);
        active.pop();
        top = lastOf(active);
      }
      // Starts inside `top` and ends past it: they overlap without nesting — one region, the product of passes.
      let loop: Loop = { start, end, passes: passes ?? 1 };
      while (top !== undefined && top.end < loop.end) {
        active.pop();
        loop = { start: top.start, end: loop.end, passes: mul(top.passes, loop.passes) };
        top = lastOf(active);
      }
      active.push(loop);
    }
    done.push(...active);

    done.sort((a, b) => a.start - b.start || b.end - a.end);
    const around: Array<{ readonly end: number; readonly product: number }> = [];
    let next = 0;
    for (let q = 0; q < positions.length; q++) {
      while (around.length > 0 && around[around.length - 1].end < q) around.pop();
      while (next < done.length && done[next].start === q) {
        const outer = around.length > 0 ? around[around.length - 1].product : 1;
        around.push({ end: done[next].end, product: mul(outer, done[next].passes) });
        next++;
      }
      positions[q].multiplier = around.length > 0 ? around[around.length - 1].product : 1;
    }
    return bounded;
  }
}

/** A run of `next` pointers from `start`: its nodes, and where it jumps back to (a loop stub's id, or a cycle). */
interface ChainShape {
  readonly nodes: readonly StageNode[];
  readonly backId?: string;
  readonly backTo?: StageNode;
}

function chainOf(start: StageNode): ChainShape {
  const nodes: StageNode[] = [];
  const seen = new Set<StageNode>();
  let cur: StageNode | undefined = start;
  while (cur !== undefined) {
    if (cur.isLoopRef) return { nodes, backId: String(cur.id) };
    if (seen.has(cur)) return { nodes, backTo: cur };
    seen.add(cur);
    nodes.push(cur);
    cur = cur.next;
  }
  return { nodes };
}

// ─────────────────────────────────────────────────────────────────────────────
// One stage
// ─────────────────────────────────────────────────────────────────────────────

/** The engine's lookup (`FlowchartTraverser · getStageFn`): the node's own function, else the map's by id or name. */
function hasFunction(node: StageNode, ctx: Ctx): boolean {
  if (typeof node.fn === 'function') return true;
  const map = ctx.stageMap;
  return map !== undefined && (map.get(node.id) !== undefined || map.get(node.name) !== undefined);
}

/** A stage's worst case under its policy — read by the engine's own readings of it (`attempt/policy.ts`). */
function stageCost(policy: RetryPolicy | undefined): StageCost {
  const attempts = policy === undefined ? 1 : attemptCeiling(policy.attempts);
  const timeoutMs = policy === undefined ? undefined : attemptTimeoutMs(policy.timeoutMs);
  const waits = waitsOf(policy?.backoffMs, attempts);
  const knownMs = add(timeoutMs === undefined ? 0 : mul(attempts, timeoutMs), waits.ms);
  const why: UnboundedReason | undefined =
    timeoutMs === undefined ? 'no-timeout' : waits.complete ? undefined : 'backoff';
  return {
    attempts,
    ...(timeoutMs !== undefined && { timeoutMs }),
    backoffMs: waits.ms,
    knownMs,
    worstMs: why === undefined ? knownMs : null,
    ...(why !== undefined && { why }),
  };
}

/** The waits between `attempts` attempts — a number by arithmetic, a function asked at most `MAX_BACKOFF_ASKS` times. */
function waitsOf(backoffMs: RetryPolicy['backoffMs'], attempts: number): { ms: number; complete: boolean } {
  const waits = attempts - 1;
  if (waits <= 0 || backoffMs === undefined) return { ms: 0, complete: true };
  if (typeof backoffMs !== 'function') return { ms: mul(waits, resolveBackoffMs(backoffMs, 1)), complete: true };
  const asks = Math.min(waits, MAX_BACKOFF_ASKS);
  let ms = 0;
  for (let n = 1; n <= asks; n++) ms = add(ms, resolveBackoffMs(backoffMs, n));
  return { ms, complete: asks === waits };
}

// ─────────────────────────────────────────────────────────────────────────────
// The report
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The slowest path: how many times each chain on it runs (parents before children — the reverse of the order they
 * were computed in), then its stages in the order a run first reaches them. Each chain is visited once, so a
 * definition mounted twice at every level of a deep nesting is one step with its passes multiplied.
 */
function criticalPathOf(root: Chain, computed: readonly Chain[]): BudgetStep[] {
  const runs = new Map<Chain, number>([[root, 1]]);
  for (let i = computed.length - 1; i >= 0; i--) {
    const chain = computed[i];
    const count = runs.get(chain);
    if (count === undefined) continue;
    for (const p of chain.positions) {
      if (p.via !== undefined) runs.set(p.via, add(runs.get(p.via) ?? 0, mul(count, p.multiplier)));
    }
  }

  const steps = new Map<string, { -readonly [K in keyof BudgetStep]: BudgetStep[K] }>();
  walkPositions(
    root,
    (p) => p.via,
    (chain, p) => {
      if (p.cost === undefined) return;
      const passes = mul(runs.get(chain) ?? 0, p.multiplier);
      const step = steps.get(p.stageId);
      if (step !== undefined) {
        step.passes = add(step.passes, passes);
        return;
      }
      steps.set(p.stageId, {
        stageId: p.stageId,
        attempts: p.cost.attempts,
        ...(p.cost.timeoutMs !== undefined && { timeoutMs: p.cost.timeoutMs }),
        backoffMs: p.cost.backoffMs,
        worstMs: p.cost.worstMs,
        passes,
      });
    },
  );
  return [...steps.values()].map((step) => Object.freeze(step));
}

/** Every unbounded stage, once, in the order a walk of the whole chart reaches it. */
function unboundedOf(root: Chain, rootFlags: readonly UnboundedStage[]): UnboundedStage[] {
  const out: UnboundedStage[] = [];
  const seen = new Set<string>();
  const note = (flag: UnboundedStage) => {
    const key = `${flag.why}\u0000${flag.stageId}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push(Object.freeze({ stageId: flag.stageId, why: flag.why }));
  };
  walkPositions(
    root,
    (p) => p.deps,
    (_chain, p) => p.flags.forEach(note),
  );
  rootFlags.forEach(note);
  return out;
}

/** A preorder walk of positions, descending into each chain `next` names the first time it is reached. */
function walkPositions(
  root: Chain,
  next: (p: Position) => Chain | readonly Chain[] | undefined,
  visit: (chain: Chain, p: Position) => void,
): void {
  const visited = new Set<Chain>([root]);
  const stack: Array<{ chain: Chain; q: number }> = [{ chain: root, q: 0 }];
  while (stack.length > 0) {
    const top = stack[stack.length - 1];
    if (top.q >= top.chain.positions.length) {
      stack.pop();
      continue;
    }
    const p = top.chain.positions[top.q++];
    visit(top.chain, p);
    const inner = next(p);
    const chains = inner === undefined ? [] : Array.isArray(inner) ? inner : [inner as Chain];
    for (let i = chains.length - 1; i >= 0; i--) {
      if (visited.has(chains[i])) continue;
      visited.add(chains[i]);
      stack.push({ chain: chains[i], q: 0 });
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Words
// ─────────────────────────────────────────────────────────────────────────────

const contribution = (s: BudgetStep) => mul(s.passes, add(mul(s.attempts, s.timeoutMs ?? 0), s.backoffMs));

/** The `limit` largest contributors, kept in path order. */
function slowestInPathOrder(steps: readonly BudgetStep[], limit: number): BudgetStep[] {
  const keep = new Set(
    [...steps]
      .sort((a, b) => contribution(b) - contribution(a))
      .slice(0, limit)
      .map((s) => s.stageId),
  );
  return steps.filter((s) => keep.has(s.stageId));
}

function stepText(s: BudgetStep): string {
  const own =
    s.timeoutMs === undefined
      ? `${s.backoffMs} ms of waits (no timeoutMs)`
      : `${s.attempts} × ${s.timeoutMs} ms + ${s.backoffMs} ms of waits = ${add(
          mul(s.attempts, s.timeoutMs),
          s.backoffMs,
        )} ms`;
  return `${s.stageId}: ${own}${s.passes > 1 ? `, ${s.passes} passes` : ''}`;
}

function unboundedText(stages: readonly UnboundedStage[]): string {
  const listed = stages.slice(0, 10).map((s) => `${s.stageId} (${s.why})`);
  return stages.length > listed.length
    ? `${listed.join(', ')}, and ${stages.length - listed.length} more`
    : listed.join(', ');
}

// ─────────────────────────────────────────────────────────────────────────────
// Small laws
// ─────────────────────────────────────────────────────────────────────────────

/** Saturating arithmetic on non-negative milliseconds: never past `Number.MAX_SAFE_INTEGER`, never `NaN`. */
const CEILING = Number.MAX_SAFE_INTEGER;
const add = (a: number, b: number): number => Math.min(a + b, CEILING);
const mul = (a: number, b: number): number => (a === 0 || b === 0 ? 0 : Math.min(a * b, CEILING));

const lastOf = <T>(items: readonly T[]): T | undefined => items[items.length - 1];

const isPositiveMs = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value) && value > 0;

const shown = (value: unknown): string => (typeof value === 'number' ? String(value) : typeof value);

/** An id as the run names it: under the prefix of the chart it lives in (a lazy or branch chart's mount path). */
const reported = (ctx: Ctx, id: string): string => (ctx.prefix === '' ? id : joinPath(ctx.prefix, id));

function isChart(value: unknown): value is FlowChart {
  if (value === null || typeof value !== 'object') return false;
  const root = (value as { root?: unknown }).root;
  return root !== null && typeof root === 'object';
}

/** An own property only — a prototype member is never an assumption or a subflow. */
function own<T>(record: Readonly<Record<string, T>> | undefined, key: string): T | undefined {
  return record !== undefined && Object.prototype.hasOwnProperty.call(record, key) ? record[key] : undefined;
}

/** The engine's subflow lookup: by subflow id, then subflow name, then node name. */
function subflowDefOf(
  subflows: Readonly<Record<string, { root: StageNode }>> | undefined,
  node: StageNode,
): { root: StageNode } | undefined {
  for (const key of [node.subflowId, node.subflowName, node.name]) {
    if (key === undefined || key === '') continue;
    const def = own(subflows, key);
    if (def !== undefined && def !== null && typeof def.root === 'object' && def.root !== null) return def;
  }
  return undefined;
}

function admitAssumptions(assume: BudgetAssumptions | undefined): BudgetAssumptions {
  if (assume === undefined) return {};
  for (const [key, passes] of ownEntries(assume.loops, 'loops')) {
    if (!(typeof passes === 'number' && Number.isInteger(passes) && passes >= 1)) {
      throw new TypeError(
        `timeBudget: assume.loops['${key}'] must be a whole number of passes >= 1 (got ${shown(passes)}).`,
      );
    }
  }
  for (const field of ['lazy', 'branches'] as const) {
    for (const [key, chart] of ownEntries(assume[field], field)) {
      if (!isChart(chart)) {
        throw new TypeError(`timeBudget: assume.${field}['${key}'] must be a built chart (flowChart(...).build()).`);
      }
    }
  }
  return assume;
}

function ownEntries(record: unknown, field: string): Array<[string, unknown]> {
  if (record === undefined) return [];
  if (record === null || typeof record !== 'object') {
    throw new TypeError(`timeBudget: assume.${field} must be an object keyed by id.`);
  }
  return Object.keys(record).map((key) => [key, (record as Record<string, unknown>)[key]]);
}
