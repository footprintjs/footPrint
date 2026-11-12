/**
 * CompositeRecorder — fan-out a single recorder attachment to multiple child recorders.
 *
 * Implements both ScopeRecorder (scope data ops) and FlowRecorder (control flow events)
 * so it works with both `executor.attachScopeRecorder()` and `executor.attachFlowRecorder()`.
 *
 * The composite has a single ID for idempotent attach/detach. Child recorders
 * keep their own IDs internally but are not individually visible to the executor.
 *
 * Domain libraries (e.g., agentfootprint) use this to bundle multiple recorders
 * into a single preset — the consumer calls one function, gets full observability.
 *
 * @example
 * ```typescript
 * import { CompositeRecorder, MetricRecorder, DebugRecorder } from 'footprintjs';
 *
 * // Bundle metrics + debug into a single recorder
 * const observability = new CompositeRecorder('observability', [
 *   new MetricRecorder({ stageFilter: (name) => name === 'CallLLM' }),
 *   new DebugRecorder({ verbosity: 'minimal' }),
 * ]);
 *
 * executor.attachScopeRecorder(observability);
 *
 * // Access child recorders by type
 * const metrics = observability.get(MetricRecorder);
 * metrics?.getMetrics(); // timing data
 * ```
 *
 * @example
 * ```typescript
 * // Domain library preset (e.g., agentfootprint)
 * export function agentObservability(options?: AgentObservabilityOptions) {
 *   return new CompositeRecorder('agent-observability', [
 *     new MetricRecorder(options?.stageFilter ? { stageFilter: options.stageFilter } : undefined),
 *     new TokenRecorder(),
 *     new ToolUsageRecorder(),
 *   ]);
 * }
 *
 * // Consumer
 * executor.attachScopeRecorder(agentObservability());
 * ```
 */

import type { FlowRecorder } from '../engine/narrative/types.js';
import type { RecorderSnapshot } from '../runner/ExecutionRuntime.js';
import type { ScopeRecorder } from '../scope/types.js';
import type { CaptureSnapshotContext } from './captureSnapshot/index.js';
import { captureRecorderSnapshot, registerCaptureSnapshot } from './captureSnapshot/index.js';
import type { HookName, HookPayload } from './hooks.js';
import { fire, HOOK_NAMES } from './hooks.js';
import { copyBundle } from './snapshot.js';

/** Snapshot format for composite recorders — wraps child snapshots, each copied by the one
 *  bundle copier (`recorder/snapshot.ts`), so a child keeps `description`/`preferredOperation`/`meta`. */
export interface CompositeSnapshot {
  name: string;
  data: {
    children: RecorderSnapshot[];
  };
}

/** One fan-out method per registry hook (`recorder/hooks.ts · HOOKS`) — 25 names, 28 channel slots. */
type HookMethods = { [K in HookName]: (event: HookPayload<K>) => void };

// Declaration merge: the methods below are installed on the prototype from the registry, so
// the class TYPE gets them here — a hook added to the registry is on the composite in both.
// eslint-disable-next-line @typescript-eslint/no-unsafe-declaration-merging, @typescript-eslint/no-empty-interface
export interface CompositeRecorder extends HookMethods {}

// eslint-disable-next-line @typescript-eslint/no-unsafe-declaration-merging
export class CompositeRecorder implements ScopeRecorder, FlowRecorder {
  static {
    registerCaptureSnapshot(CompositeRecorder.prototype.toSnapshot, (owner, context) =>
      compositeSnapshot((owner as CompositeRecorder).children, context),
    );
  }

  readonly id: string;
  private readonly children: Array<ScopeRecorder | FlowRecorder>;

  constructor(id: string, children: Array<ScopeRecorder | FlowRecorder>) {
    this.id = id;
    this.children = [...children];
  }

  // ── Child access ──────────────────────────────────────────────────────

  /**
   * Get a child recorder by class type.
   *
   * @example
   * ```typescript
   * const metrics = composite.get(MetricRecorder);
   * ```
   */
  get<T>(type: new (...args: any[]) => T): T | undefined {
    return this.children.find((c) => c instanceof type) as T | undefined;
  }

  /** Get all child recorders. */
  getChildren(): ReadonlyArray<ScopeRecorder | FlowRecorder> {
    return this.children;
  }

  // ── Lifecycle ─────────────────────────────────────────────────────────

  clear(): void {
    for (const c of this.children) if (c.clear) c.clear();
  }

  /**
   * Snapshot merges all child snapshots into a single composite entry.
   * Each child's bundle is copied by the one copier, under the child's own id.
   */
  toSnapshot(): CompositeSnapshot {
    return compositeSnapshot(this.children);
  }
}

/** One child collector for explicit snapshots and private automatic capture. */
function compositeSnapshot(
  recorders: ReadonlyArray<ScopeRecorder | FlowRecorder>,
  context?: CaptureSnapshotContext,
): CompositeSnapshot {
  const children: RecorderSnapshot[] = [];
  for (const child of recorders) {
    if (!child.toSnapshot) continue;
    const bundle = context ? captureRecorderSnapshot(child, context) : child.toSnapshot();
    children.push(copyBundle(child.id, bundle, false, context !== undefined));
  }
  return { name: 'Composite', data: { children } };
}

// ── The generated fan-out ────────────────────────────────────────────────
// One prototype method per registry hook. Each child is called through `fire`, so a child that
// throws never stops its siblings: every child that implements the hook receives the event.
// The throw is then handed to the CHANNEL's own policy — the composite cannot apply it itself
// (the scope channel's `onError` goes to every recorder on the facade, with the stage's names,
// which only the facade has) — by rethrowing it once the fan-out is done: one child's error as
// itself (exactly what the channel saw before), several as one `AggregateError`.
for (const hook of HOOK_NAMES) {
  Object.defineProperty(CompositeRecorder.prototype, hook, {
    value: function fanOut(this: CompositeRecorder, event: never): void {
      const errors: unknown[] = [];
      fire(this.getChildren(), hook, event, (error) => errors.push(error));
      if (errors.length === 1) throw errors[0];
      if (errors.length > 1) {
        throw new AggregateError(
          errors,
          `${errors.length} children of CompositeRecorder "${this.id}" threw in ${hook}`,
        );
      }
    },
    writable: true,
    configurable: true,
    enumerable: false,
  });
}
