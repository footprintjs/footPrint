/**
 * checkpointSanitize — clone-resilience helpers for `buildPauseCheckpoint`.
 *
 * The pause checkpoint is detached via one `structuredClone` of the assembled
 * checkpoint. The JSON-safe contract governs what CONSUMERS put into a
 * checkpoint (pauseData, shared state) — but the execution tree's diagnostic
 * bags (`logs`/`errors`/`metrics`/`evals`) accept ANY value at write time
 * without cloning (`$debug`/`$error`/`$metric`/`$eval` route through
 * `DiagnosticCollector`, which stores raw references). A `$debug`'d function
 * in any stage of a pausing run would make the whole-checkpoint clone throw
 * `DataCloneError` — swallowing the pause.
 *
 * That violates the library's error-isolation grain: observability side-bags
 * never abort traversal anywhere else. These helpers restore the grain:
 *
 *   - `sanitizeDiagnosticBags` — replace non-cloneable diagnostic values with
 *     marker strings (`'[non-serializable: function]'`) so the pause survives.
 *   - `describeCheckpointCloneFailure` — when the clone STILL fails after
 *     sanitization (the non-cloneable lives in consumer-owned data, e.g.
 *     `pauseData`), name the offending checkpoint field(s) and point at the
 *     JSON-safe contract instead of letting a naked `DataCloneError` escape.
 *
 * Both run ONLY on the clone-failure path of a pause — never on the hot path.
 */

import type { StageSnapshot } from '../memory/types.js';

/** The StageSnapshot fields written by `$debug`/`$error`/`$metric`/`$eval`. */
const DIAGNOSTIC_BAGS = ['logs', 'errors', 'metrics', 'evals'] as const;

/** `true` when `structuredClone` accepts the value as-is. */
function isCloneable(value: unknown): boolean {
  try {
    structuredClone(value);
    return true;
  } catch {
    return false;
  }
}

/** Human-readable kind for the `[non-serializable: …]` marker. */
function describeKind(value: unknown): string {
  if (value === null) return 'null';
  if (typeof value !== 'object') return typeof value;
  return value.constructor?.name ?? 'object';
}

/** Plain data container we can rebuild entry-by-entry without lying about the type. */
function isPlainObject(value: object): boolean {
  const proto = Object.getPrototypeOf(value) as object | null;
  return proto === Object.prototype || proto === null;
}

/**
 * Deep-replace non-cloneable values with `'[non-serializable: <kind>]'`
 * marker strings, preserving everything `structuredClone` accepts.
 *
 * Fast path: a cloneable value is returned AS-IS (no copy — the caller
 * clones the whole checkpoint right after). Only containers that actually
 * hold a non-cloneable leaf are rebuilt, and only KNOWN container shapes
 * (array / Map / Set / plain object) are rebuilt entry-by-entry — exotic
 * non-cloneables (Promise, WeakMap, class instances holding a function, …)
 * become a typed marker rather than a misleading empty shell. Pure cycles
 * pass the fast path untouched (`structuredClone` supports them); a cycle
 * is only broken — with a marker — when it shares a container with a
 * non-cloneable value.
 */
function sanitizeValue(value: unknown, seen: WeakSet<object>): unknown {
  if (isCloneable(value)) return value;
  if (value !== null && typeof value === 'object') {
    if (seen.has(value)) return '[non-serializable: circular]';
    seen.add(value);
    if (Array.isArray(value)) {
      return value.map((v) => sanitizeValue(v, seen));
    }
    if (value instanceof Map) {
      return new Map([...value].map(([k, v]) => [sanitizeValue(k, seen), sanitizeValue(v, seen)]));
    }
    if (value instanceof Set) {
      return new Set([...value].map((v) => sanitizeValue(v, seen)));
    }
    if (isPlainObject(value)) {
      return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, sanitizeValue(v, seen)]));
    }
  }
  return `[non-serializable: ${describeKind(value)}]`;
}

/**
 * Walk a `StageSnapshot` tree (via `next` + `children`) and sanitize the four
 * diagnostic bags on every node IN PLACE.
 *
 * In-place is safe and intentional: `StageContext.getSnapshot()` builds fresh
 * node objects on every call, but the bag fields on those fresh nodes ALIAS
 * the live `DiagnosticCollector` bags. We replace the node's bag REFERENCE
 * with a sanitized copy — the live engine bags are never mutated, so a
 * same-executor resume keeps the original diagnostic values.
 */
export function sanitizeDiagnosticBags(tree: StageSnapshot): StageSnapshot {
  const seen = new WeakSet<object>();
  const visit = (node: StageSnapshot): void => {
    for (const bag of DIAGNOSTIC_BAGS) {
      const bagValue = node[bag];
      if (bagValue !== undefined && !isCloneable(bagValue)) {
        node[bag] = sanitizeValue(bagValue, seen) as Record<string, unknown>;
      }
    }
    if (node.next) visit(node.next);
    if (node.children) for (const child of node.children) visit(child);
  };
  visit(tree);
  return tree;
}

/**
 * Build the DESCRIPTIVE error for a checkpoint that still cannot be cloned
 * after diagnostic-bag sanitization — i.e. the non-cloneable value lives in
 * consumer-owned data (a genuine JSON-safe contract violation). Probes each
 * top-level checkpoint field individually so the message names the offending
 * field family. Never lets a naked `DataCloneError` escape.
 */
export function describeCheckpointCloneFailure(checkpoint: Record<string, unknown>, cause: unknown): Error {
  const failing = Object.entries(checkpoint)
    .filter(([, value]) => !isCloneable(value))
    .map(([field]) => field);
  const fields = failing.length > 0 ? failing.join(', ') : 'unknown';
  return new Error(
    'FlowChartExecutor: cannot build the pause checkpoint — non-serializable value(s) in ' +
      `checkpoint field(s): ${fields}. The checkpoint contract is JSON-safe (no functions, no ` +
      "class instances). Check the pauseData returned by the pausable stage's execute(), and any " +
      'subflow state captured at the pause. Diagnostic values from $debug/$metric/$error/$eval ' +
      'are sanitized automatically and never cause this error. ' +
      'See docs/guides/execution-model.md ("Pause / resume — what a checkpoint captures").',
    { cause },
  );
}
