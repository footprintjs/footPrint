/**
 * stateAt — the fold at a stop.
 *
 * The commit log stores DIFFS. Replaying them onto the run's fold base
 * reproduces the state as it stood after any commit — byte-for-byte the state
 * the next stage saw, in both `commitValues` encodings, because the replay
 * runs through `applySmartMerge`, the one verb switch the live commit itself
 * uses. There is deliberately no second implementation of the verbs here.
 */

import type { CommitBundle, MemoryPatch } from '../memory/types.js';
import { applySmartMerge } from '../memory/utils.js';
import type { FoldBasis, FoldedState, FoldSource } from './types.js';

/** Deeply freeze a POJO tree so a fold result cannot be mutated by its holder. */
function freezeDeep<T>(value: T): T {
  if (value === null || typeof value !== 'object') return value;
  Object.freeze(value);
  for (const key of Object.getOwnPropertyNames(value)) {
    const inner = (value as Record<string, unknown>)[key];
    if (inner && typeof inner === 'object' && !Object.isFrozen(inner)) freezeDeep(inner);
  }
  return value;
}

/**
 * Pull the commit bundles out of whichever shape the caller handed us:
 * `commitLog` (a run snapshot) or `history` (a subflow's own log).
 */
export function commitsOf(source: FoldSource | undefined): readonly CommitBundle[] {
  if (!source) return [];
  const withLog = source as { commitLog?: readonly CommitBundle[] };
  if (Array.isArray(withLog.commitLog)) return withLog.commitLog;
  const withHistory = source as { history?: readonly unknown[] };
  if (Array.isArray(withHistory.history)) return withHistory.history as readonly CommitBundle[];
  return [];
}

/**
 * Fold `source`'s log from its base up to and including `commitIdx`.
 *
 * @param source    A run snapshot (`commitLog` + `initialState`) or a subflow
 *                  subtree (`history` + `initialState`). Both spellings work.
 * @param commitIdx ARRAY INDEX of the last bundle to fold, inclusive. `-1`
 *                  (or any negative) folds nothing and returns the base —
 *                  the state before the run's first commit. Past the end
 *                  clamps to the end; the result's `throughCommitIdx` reports
 *                  where the fold actually stopped.
 *
 * @returns A detached, deeply frozen state plus how it was derived: `basis`
 *   says whether the real fold base was available, and `redacted` /
 *   `redactedPaths` say where the log was scrubbed at write time. The engine
 *   redacts values as it records them, so a replay of a redacted run yields
 *   `'REDACTED'` in those places — correct, and said out loud rather than
 *   presented as the real value.
 *
 * @example
 * ```typescript
 * const snapshot = executor.getSnapshot();
 * const { state, basis } = stateAt(snapshot, 3);   // after the 4th commit
 * console.log(basis, state);                        // 'initial+log' { ... }
 *
 * // A subflow's own log folds identically:
 * const inner = getSubtreeSnapshot(snapshot, 'sf-payment')!;
 * stateAt(inner, 0).state;                          // after the subflow's first commit
 * ```
 */
export function stateAt(source: FoldSource | undefined, commitIdx: number): FoldedState {
  const log = commitsOf(source);
  const base = (source as { initialState?: Record<string, unknown> } | undefined)?.initialState;
  const basis: FoldBasis = base && typeof base === 'object' ? 'initial+log' : 'log-only';

  // `NaN` is out of contract; treat it as "fold nothing" rather than letting
  // it flow through the arithmetic into `throughCommitIdx`, where it would
  // serialize as `null` and tell a consumer nothing about where the fold
  // stopped. (±Infinity needs no special case: it clamps like any index past
  // either end.)
  const asked = Number.isNaN(commitIdx) ? -1 : Math.floor(commitIdx);
  const through = Math.min(asked, log.length - 1);
  let out: Record<string, unknown> = structuredClone(basis === 'initial+log' ? base! : {});

  const redactedPaths = new Set<string>();
  for (let i = 0; i <= through; i++) {
    const bundle = log[i];
    if (!bundle) continue;
    for (const path of bundle.redactedPaths ?? []) redactedPaths.add(path);
    out = applySmartMerge(out, bundle.updates as MemoryPatch, bundle.overwrite as MemoryPatch, bundle.trace);
  }

  return {
    // Law 3, both halves. `applySmartMerge` clones what it OVERWRITES, but the
    // merge arm's array union (`deepSmartMerge`) carries source element
    // REFERENCES out of `bundle.updates`. Freezing that directly would freeze
    // the engine's own recorded bundle — a read-only query mutating the
    // record. Cloning first detaches those leaves, and costs one clone of the
    // final state, not one per bundle.
    state: freezeDeep(structuredClone(out)),
    basis,
    redacted: redactedPaths.size > 0,
    redactedPaths: Object.freeze([...redactedPaths].sort()),
    throughCommitIdx: through < -1 ? -1 : through,
  };
}
