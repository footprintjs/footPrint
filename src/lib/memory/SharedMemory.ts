/**
 * SharedMemory — The shared state container for all flowchart execution
 *
 * Like a runtime heap with namespace isolation:
 * - Each run gets its own namespace (runs/{id}/)
 * - Default values can be initialised and preserved
 * - Accepts commit bundles from TransactionBuffer
 *
 * COPY-ON-WRITE (design 2026-10): `context` is a GENERATION. A commit never
 * edits it — `applyPatch` builds the next generation by copying the root and
 * the containers on each written path, shares every other subtree with the
 * generation before it, and swaps. So a generation a stage captured (its
 * first-touch view, its buffer's diff base) stays exactly what it was, and a
 * commit costs O(what it wrote), not O(state).
 */

import { isDevMode } from '../scope/detectCircular.js';
import { freezeNew, mergeContextWins, ownedRootOf, ownSpine } from './pathOps.js';
import type { MemoryPatch, TraceEntry } from './types.js';
import { applySmartMerge, getNestedValue, getRunAndGlobalPaths, setNestedValue, updateNestedValue } from './utils.js';

/** PROTOTYPE switches (design 2026-10) — read once; not part of the design's API. */
const env: Record<string, string | undefined> =
  (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env ?? {};
/** '1' = freeze every generation (the census run); 'dev' = only under enableDevMode(); unset = never. */
const FREEZE = env.FP_COW_FREEZE;
/** '0' = do NOT detach the seed at construction (attribution runs). */
const DETACH = env.FP_COW_DETACH !== '0';

function shouldFreeze(): boolean {
  return FREEZE === '1' || (FREEZE === 'dev' && isDevMode());
}

export class SharedMemory {
  private context: { [key: string]: any } = {};
  private _defaultValues?: unknown;

  constructor(defaultValues?: unknown, initialContext?: unknown) {
    this._defaultValues = defaultValues;
    const seed = mergeContextWins(initialContext || {}, defaultValues || {});
    // Detached ONCE: `mergeContextWins` copies only the top level, so its
    // nested values are the caller's own objects. Before copy-on-write the
    // first commit's whole-state clone detached them; now nothing would, so
    // the seed is detached here — one clone per runtime, not one per commit.
    this.context = DETACH && Object.keys(seed).length > 0 ? structuredClone(seed) : seed;
    if (shouldFreeze()) freezeNew(this.context);
  }

  /** Gets a clone of the default values. */
  getDefaultValues() {
    return this._defaultValues ? structuredClone(this._defaultValues) : undefined;
  }

  /** Gets all run namespaces. */
  getRuns() {
    return this.context.runs;
  }

  /** Updates a value using merge semantics. Builds a new generation (path copy). */
  updateValue(runId: string, path: string[], key: string, value: unknown) {
    const next = this.ownedPathTo(runId, path, key);
    updateNestedValue(next, runId, path, key, value, this.getDefaultValues());
    this.swap(next);
  }

  /** Sets a value using overwrite semantics. Builds a new generation (path copy). */
  setValue(runId: string, path: string[], key: string, value: unknown) {
    const next = this.ownedPathTo(runId, path, key);
    setNestedValue(next, runId, path, key, value, this.getDefaultValues());
    this.swap(next);
  }

  /**
   * A copy of the current generation's root whose containers on the way to
   * `key` are owned — the in-place helpers below then edit only copies.
   */
  private ownedPathTo(runId: string, path: string[], key: string): { [key: string]: any } {
    const owned = new WeakSet<object>();
    const root = ownedRootOf(this.context, owned);
    const { runPath, globalPath } = getRunAndGlobalPaths(runId, path);
    ownSpine(root, [...(runPath || globalPath), key], owned);
    return root;
  }

  private swap(next: { [key: string]: any }): void {
    this.context = next;
    if (shouldFreeze()) freezeNew(this.context);
  }

  /**
   * Reads a value from the store.
   * Looks up in run namespace first, falls back to global.
   */
  getValue(runId?: string, path?: string[], key?: string): any {
    const { globalPath, runPath } = getRunAndGlobalPaths(runId, path);
    const value = runPath ? getNestedValue(this.context, runPath, key) : undefined;
    return typeof value !== 'undefined' ? value : getNestedValue(this.context, globalPath, key);
  }

  /** Gets the entire state as a JSON object. */
  getState(): Record<string, unknown> {
    return this.context;
  }

  /** Applies a commit bundle from TransactionBuffer. */
  applyPatch(overwrite: MemoryPatch, updates: MemoryPatch, trace: TraceEntry[]): void {
    this.swap(applySmartMerge(this.context, updates, overwrite, trace));
  }
}
