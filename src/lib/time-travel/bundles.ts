/**
 * bundles.ts — reading a log whose rows are not typed yet.
 *
 * WHY THIS FILE EXISTS. A LIVE snapshot hands time travel real
 * {@link CommitBundle}s. A STORED recording hands it parsed JSON, and a
 * careful consumer will not claim that what came back off disk is a
 * `CommitBundle` — so it either casts (a lie with a comment on it) or cannot
 * call the library at all. Since 9.18.0 the source takes `readonly unknown[]`
 * and the narrowing happens here, per row, at the one place that actually
 * reads one.
 *
 * A row that is not a bundle becomes a GAP rather than an exception: it KEEPS
 * ITS INDEX — so every `commitIdx` in the axis still addresses the same
 * position — contributes no state, gets no stop, and is reported with its
 * index and a reason. One corrupt row in a stored recording loses that row,
 * not the recording.
 */

import type { CommitBundle, StageSnapshot } from '../memory/types.js';
import type { LogGap } from './types.js';

/**
 * The stand-in a gap leaves at its index: a commit that belongs to no stage
 * and carries nothing.
 *
 * It is NOT invented evidence — every field is the empty value, and an id-less
 * bundle is a shape the log already has (a root-context commit made before any
 * stage ran). `commitStops` gives it no stop for exactly that reason, the fold
 * folds nothing from it, and `changedSince` reads no keys off it. What it does
 * is hold the index, so the arithmetic downstream never has to know.
 */
const GAP_BUNDLE: CommitBundle = Object.freeze({
  stage: '',
  stageId: '',
  runtimeStageId: '',
  trace: Object.freeze([]) as unknown as CommitBundle['trace'],
  redactedPaths: Object.freeze([]) as unknown as string[],
  overwrite: Object.freeze({}),
  updates: Object.freeze({}),
});

/** A plain object — not null, not an array, not a primitive. */
export function isPlainish(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Read a source's `executionTree` as a {@link StageSnapshot}, or as absent.
 *
 * The tree is only ever WALKED for mount ids (`subflowId` + `runtimeStageId`
 * on each node), so the honest narrowing a reader can do is "a plain object";
 * anything else — a stored field that came back as a string, a number, an
 * array — is read as no tree at all, which sends `commitStops` down the same
 * shape-heuristic path a log handed over without its tree already takes.
 */
export function readTree(value: unknown): StageSnapshot | undefined {
  return isPlainish(value) ? (value as unknown as StageSnapshot) : undefined;
}

/**
 * Why `row` cannot be read as a commit bundle, or `undefined` when it can.
 *
 * DELIBERATELY LENIENT — but exactly as lenient as the readers are. It checks
 * what the fold, the axis and `changedSince` actually touch:
 *
 * - `runtimeStageId` must be a string — the axis keys on it.
 * - `trace` must be an ARRAY, and it must be PRESENT. It is the one field
 *   every reader WALKS (`applySmartMerge` iterates it verb by verb;
 *   `changedSince` reads its paths), so a row without one is not a bundle the
 *   fold can survive — it is the crash a gap exists to prevent. `CommitBundle`
 *   declares it required, so no live log is affected.
 * - `updates` / `overwrite`, when present, must be plain objects. They are
 *   read only AT THE PATHS THE TRACE NAMES, so an absent one is harmless and
 *   is tolerated, exactly as the fold tolerates an absent `redactedPaths`.
 *
 * Being stricter than that — demanding `stage`, `stageId`, `idx` — would
 * reject hand-built logs that have folded correctly since 9.17.0, which is a
 * compatibility break dressed up as validation.
 */
export function bundleRefusal(row: unknown): string | undefined {
  if (!isPlainish(row)) {
    return `not an object (${row === null ? 'null' : Array.isArray(row) ? 'array' : typeof row})`;
  }
  if (typeof row.runtimeStageId !== 'string') {
    return `runtimeStageId is ${
      row.runtimeStageId === undefined ? 'missing' : `a ${typeof row.runtimeStageId}`
    }, not a string`;
  }
  if (!Array.isArray(row.trace)) {
    return `trace is ${row.trace === undefined ? 'missing' : `a ${typeof row.trace}`}, not an array`;
  }
  if (row.updates !== undefined && !isPlainish(row.updates)) return 'updates is not a plain object';
  if (row.overwrite !== undefined && !isPlainish(row.overwrite)) return 'overwrite is not a plain object';
  return undefined;
}

/** `true` when `row` can be read as a {@link CommitBundle}. */
export function isCommitBundle(row: unknown): row is CommitBundle {
  return bundleRefusal(row) === undefined;
}

/** A log read row by row: the bundles, index-aligned, plus what was refused. */
export interface ReadLog {
  /** Same length and order as the input; a refused row holds a GAP stand-in. */
  readonly log: readonly CommitBundle[];
  /** The refused rows, in index order. Empty when the log was clean. */
  readonly gaps: readonly LogGap[];
}

/** Nothing to read — shared, so the clean path allocates nothing extra. */
const NO_GAPS: readonly LogGap[] = Object.freeze([]);

/**
 * Read an unvalidated array as a commit log.
 *
 * The clean case (a live snapshot, or a stored recording that round-tripped
 * intact) returns the SAME array reference and no gaps: nothing is copied,
 * nothing is allocated, and the fold behaves byte for byte as it did in
 * 9.17.0. Only a log with a refused row is rebuilt, and only to keep the
 * indices aligned.
 *
 * @example
 * ```typescript
 * const { log, gaps } = readLog(JSON.parse(stored).commitLog);
 * gaps; // [{ index: 3, reason: 'not an object (null)' }]
 * ```
 */
export function readLog(raw: readonly unknown[] | undefined): ReadLog {
  if (!raw || raw.length === 0) return { log: [], gaps: NO_GAPS };

  let gaps: LogGap[] | undefined;
  for (let i = 0; i < raw.length; i++) {
    const reason = bundleRefusal(raw[i]);
    if (reason !== undefined) (gaps ??= []).push({ index: i, reason });
  }
  if (!gaps) return { log: raw as readonly CommitBundle[], gaps: NO_GAPS };

  const log = raw.map((row) => (isCommitBundle(row) ? row : GAP_BUNDLE));
  return { log, gaps: Object.freeze(gaps) };
}
