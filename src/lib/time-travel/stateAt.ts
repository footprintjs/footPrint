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
import { readLog } from './bundles.js';
import type { FoldBasis, FoldedState, FoldSource, LogGap } from './types.js';

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

/** One source, read: its log (gaps held in place) and its fold base. */
export interface ReadSource {
  readonly log: readonly CommitBundle[];
  readonly gaps: readonly LogGap[];
  readonly base: Record<string, unknown> | undefined;
}

/**
 * Read whichever shape the caller handed us — `commitLog` (a run snapshot) or
 * `history` (a subflow's own log) — narrowing the rows to commit bundles as it
 * goes (see `bundles.ts`: a row that is not one becomes an index-holding gap).
 */
export function readSource(source: FoldSource | undefined): ReadSource {
  const base = (source as { initialState?: Record<string, unknown> } | undefined)?.initialState;
  if (!source) return { log: [], gaps: [], base };
  const withLog = source as { commitLog?: readonly unknown[] };
  const raw = Array.isArray(withLog.commitLog)
    ? withLog.commitLog
    : Array.isArray((source as { history?: readonly unknown[] }).history)
    ? (source as { history: readonly unknown[] }).history
    : undefined;
  const { log, gaps } = readLog(raw);
  return { log, gaps, base };
}

/**
 * Fold one chain of legs: every leg BEFORE `legIdx` in full, then `legIdx`
 * through `through`.
 *
 * THE LEG RULE. A leg that carries its own `initialState` RESTARTS the
 * accumulation from it — on a pause/resume that base IS the state at the
 * pause, recorded by the engine, and is authoritative over anything the
 * previous leg's log rebuilt. A leg with no base (a pre-9.17 snapshot, a
 * hand-built log) CONTINUES from what the earlier legs folded, which is the
 * best honest answer available and is exactly what `basis` then reports.
 *
 * With a single leg this is the 9.17.0 fold, unchanged.
 */
export function foldLegs(legs: readonly ReadSource[], legIdx: number, through: number): FoldedState {
  let based = false;
  let out: Record<string, unknown> = {};
  const redactedPaths = new Set<string>();
  let skipped: LogGap[] | undefined;
  let lastThrough = -1;

  for (let leg = 0; leg <= legIdx && leg < legs.length; leg++) {
    const { log, gaps, base } = legs[leg];
    if (base && typeof base === 'object') {
      out = structuredClone(base);
      based = true;
    }
    const end = leg === legIdx ? Math.min(through, log.length - 1) : log.length - 1;
    if (leg === legIdx) lastThrough = end < -1 ? -1 : end;
    for (const gap of gaps) {
      if (gap.index <= end) (skipped ??= []).push(gap);
    }
    for (let i = 0; i <= end; i++) {
      const bundle = log[i];
      if (!bundle) continue;
      for (const path of bundle.redactedPaths ?? []) redactedPaths.add(path);
      out = applySmartMerge(out, bundle.updates as MemoryPatch, bundle.overwrite as MemoryPatch, bundle.trace);
    }
  }

  const basis: FoldBasis = based ? 'initial+log' : 'log-only';
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
    throughCommitIdx: lastThrough,
    // ABSENT when clean: a fold over a live snapshot keeps the 9.17.0 shape.
    ...(skipped ? { skipped: Object.freeze(skipped) } : {}),
  };
}

/**
 * Fold `source`'s log from its base up to and including `commitIdx`.
 *
 * @param source    A run snapshot (`commitLog` + `initialState`) or a subflow
 *                  subtree (`history` + `initialState`). Both spellings work,
 *                  and the rows may be unvalidated (`unknown[]`) — a row that
 *                  is not a commit bundle is skipped and REPORTED, by index,
 *                  in {@link FoldedState.skipped}, never crashed on.
 * @param commitIdx ARRAY INDEX of the last bundle to fold, inclusive. `-1`
 *                  (or any negative) folds nothing and returns the base —
 *                  the state before the run's first commit. Past the end
 *                  clamps to the end; the result's `throughCommitIdx` reports
 *                  where the fold actually stopped.
 *
 * @returns A detached, deeply frozen state plus how it was derived: `basis`
 *   says whether the real fold base was available, `redacted` /
 *   `redactedPaths` say where the log was scrubbed at write time, and
 *   `skipped` says which rows could not be read. The engine redacts values as
 *   it records them, so a replay of a redacted run yields `'REDACTED'` in
 *   those places — correct, and said out loud rather than presented as the
 *   real value.
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
 *
 * // A STORED recording needs no cast — its rows are `unknown[]`:
 * const stored = JSON.parse(await fs.readFile(path, 'utf8'));
 * stateAt(stored, 3).skipped;                       // undefined, or the bad rows
 * ```
 */
export function stateAt(source: FoldSource | undefined, commitIdx: number): FoldedState {
  // `NaN` is out of contract; treat it as "fold nothing" rather than letting
  // it flow through the arithmetic into `throughCommitIdx`, where it would
  // serialize as `null` and tell a consumer nothing about where the fold
  // stopped. (±Infinity needs no special case: it clamps like any index past
  // either end.)
  const asked = Number.isNaN(commitIdx) ? -1 : Math.floor(commitIdx);
  return foldLegs([readSource(source)], 0, asked);
}
