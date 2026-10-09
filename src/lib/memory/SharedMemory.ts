/**
 * SharedMemory — The shared state container for all flowchart execution
 *
 * Like a runtime heap with namespace isolation:
 * - A value is written at an ADDRESS — a path prefix the caller computed
 *   (C2: the engine's frame decides it, `runAddress.ts · runAddress`) — and read
 *   there first, then at the root
 * - Default values seed the root, and the container at an address when a
 *   write creates it
 * - Accepts commit bundles from TransactionBuffer
 *
 * COPY-ON-WRITE (9.29.0 — docs/design/2026-10-copy-on-write-commit.md):
 * `context` is a GENERATION, and a generation is never edited. Every write —
 * `applyPatch` (a stage commit), `setValue`, `updateValue` — builds the next
 * generation by copying the root and the containers on each written path,
 * shares every other subtree with the generation before it, and swaps. So a
 * generation a stage captured (its first-touch view, its transaction
 * buffer's diff base) stays exactly what it was, and a write costs O(what it
 * wrote), not O(state).
 */

import { mergeContextWins, ownedRootOf, ownSpine } from './pathOps.js';
import type { MemoryPatch, TraceEntry } from './types.js';
import {
  getNestedValue,
  getRunAndGlobalPaths,
  isDeniedWritePath,
  nextGeneration,
  setNestedValue,
  updateNestedValue,
} from './utils.js';

export class SharedMemory {
  private context: { [key: string]: any } = {};
  private _defaultValues?: unknown;

  constructor(defaultValues?: unknown, initialContext?: unknown) {
    this._defaultValues = defaultValues;
    const seed = mergeContextWins(initialContext || {}, defaultValues || {});
    // Detached ONCE, here: `mergeContextWins` copies only the top level, so
    // the seed's nested values are the caller's own objects. Before 9.29.0
    // the first commit's whole-state clone detached them (and until then a
    // caller mutating its `initialContext` changed live state with no row);
    // nothing re-clones the state any more, so the seed is detached at
    // construction — one clone per runtime, not one per commit.
    this.context = Object.keys(seed).length > 0 ? structuredClone(seed) : seed;
  }

  /** Gets a clone of the default values. */
  getDefaultValues() {
    return this._defaultValues ? structuredClone(this._defaultValues) : undefined;
  }

  /** Updates a value at `address` + `path` using merge semantics, as a new generation (path copy + swap). */
  updateValue(address: readonly string[], path: string[], key: string, value: unknown) {
    const next = this.ownedPathTo(address, path, key);
    if (next === undefined) return;
    updateNestedValue(next, address, path, key, value, this.getDefaultValues());
    this.context = next;
  }

  /** Sets a value at `address` + `path` using overwrite semantics, as a new generation (path copy + swap). */
  setValue(address: readonly string[], path: string[], key: string, value: unknown) {
    const next = this.ownedPathTo(address, path, key);
    if (next === undefined) return;
    setNestedValue(next, address, path, key, value, this.getDefaultValues());
    this.context = next;
  }

  /**
   * A copy of the current generation's root whose containers on the way to
   * `key` are owned — the in-place helpers above then edit only copies.
   */
  private ownedPathTo(address: readonly string[], path: string[], key: string): { [key: string]: any } | undefined {
    if (isDeniedWritePath(address, path, key)) return undefined;
    const owned = new WeakSet<object>();
    const root = ownedRootOf(this.context, owned);
    const { runPath, globalPath } = getRunAndGlobalPaths(address, path);
    ownSpine(root, [...(runPath || globalPath), key], owned);
    return root;
  }

  /**
   * Reads a value from the store.
   * Looks up at `address` first, falls back to the root.
   */
  getValue(address?: readonly string[], path?: string[], key?: string): any {
    const { globalPath, runPath } = getRunAndGlobalPaths(address, path);
    const value = runPath ? getNestedValue(this.context, runPath, key) : undefined;
    return typeof value !== 'undefined' ? value : getNestedValue(this.context, globalPath, key);
  }

  /** Gets the entire state as a JSON object — the current generation, by reference. Never mutate it. */
  getState(): Record<string, unknown> {
    return this.context;
  }

  /** Applies a commit bundle from TransactionBuffer: builds the next generation and swaps it in. */
  applyPatch(overwrite: MemoryPatch, updates: MemoryPatch, trace: TraceEntry[]): void {
    this.context = nextGeneration(this.context, updates, overwrite, trace);
  }
}
