/**
 * TransactionBuffer — Per-stage STAGING buffer for state mutations
 *
 * What it IS: a staging buffer with read-your-writes and net-change commits.
 * - Changes are staged here during stage execution and flushed to
 *   SharedMemory in ONE batch per stage (`commit()`) — other stages and
 *   parallel siblings never observe a stage's half-finished writes.
 * - Read-after-write consistency within a stage — a stage sees its own
 *   staged writes immediately.
 * - `commit()` records the stage's NET change (see {@link commit}), plus an
 *   operation trace for deterministic replay.
 *
 * What it is NOT: a rollback mechanism. Despite the name, there is no
 * abort/rollback path — when a stage THROWS, the engine still commits
 * everything staged so far before re-throwing (commit-on-error in
 * `FlowchartTraverser`). That is deliberate: the audit trail must record
 * what the failing stage changed. Do not rely on "stage failed → its
 * writes vanished".
 */

import { nativeGet as _get, nativeSet as _set } from './pathOps.js';
import type { MemoryPatch } from './types.js';
import { deepEqual, deepSmartMerge, DELIM, normalisePath } from './utils.js';

export class TransactionBuffer {
  private readonly baseSnapshot: any;
  private workingCopy: any;

  private overwritePatch: MemoryPatch = {};
  private updatePatch: MemoryPatch = {};
  private opTrace: { path: string; verb: 'set' | 'merge' }[] = [];
  private redactedPaths = new Set<string>();

  constructor(base: any) {
    this.baseSnapshot = structuredClone(base);
    this.workingCopy = structuredClone(base);
  }

  /** Hard overwrite at the specified path. */
  set(path: (string | number)[], value: any, shouldRedact = false): void {
    _set(this.workingCopy, path, value);
    _set(this.overwritePatch, path, structuredClone(value));
    if (shouldRedact) {
      this.redactedPaths.add(normalisePath(path));
    }
    this.opTrace.push({ path: normalisePath(path), verb: 'set' });
  }

  /** Deep union merge at the specified path. */
  merge(path: (string | number)[], value: any, shouldRedact = false): void {
    const existing = _get(this.workingCopy, path) ?? {};
    const merged = deepSmartMerge(existing, value);
    _set(this.workingCopy, path, merged);
    _set(this.updatePatch, path, deepSmartMerge(_get(this.updatePatch, path) ?? {}, value));
    if (shouldRedact) {
      this.redactedPaths.add(normalisePath(path));
    }
    this.opTrace.push({ path: normalisePath(path), verb: 'merge' });
  }

  /** Read current value at path (includes uncommitted changes). */
  get(path: (string | number)[], defaultValue?: any) {
    return _get(this.workingCopy, path, defaultValue);
  }

  /**
   * Flush all staged mutations and return the commit bundle — recording the
   * stage's NET CHANGE, not its raw write log.
   *
   * ── WHY (the defect this fixes) ─────────────────────────────────────────
   * Previously every `set`/`merge` was recorded verbatim, so the commit bundle
   * was a log of *operations* rather than *changes*. Two operations produce no
   * net change yet were still committed as "mutations":
   *
   *   1. No-op write   — writing a key the value it already holds (e.g. an
   *                      agent context slot re-emitting identical content every
   *                      turn). base K=1, stage writes K=1.
   *   2. Write-revert  — changing then restoring a key within one stage.
   *                      base K=1, stage writes K=2 then K=1.
   *
   * Recording these as mutations (a) bloated causal slicing / backtracking with
   * spurious dependencies on intermediate values that never reach final state,
   * and (b) made downstream "what changed here?" consumers light up stages that
   * changed nothing — most visibly the lens highlight flagging every slot.
   *
   * ── HOW ─────────────────────────────────────────────────────────────────
   * At commit we hold BOTH `baseSnapshot` (state when the stage began) and
   * `workingCopy` (state after all its writes). For each path the stage touched
   * we keep it in the bundle ONLY if its final value differs from the base
   * value ({@link deepEqual}). No-op AND write-revert paths drop out, because
   * both compare equal to base. This is a single net-delta diff at commit time
   * — one deep compare per touched path, O(changed state), paid once per stage
   * (NOT per write). A naive per-write deep-equal skip would be more expensive
   * and would still miss write-revert (the intermediate write differs from the
   * value present at the moment of writing).
   *
   * ── TWO HONEST TIERS (by design — do not "unify" them) ──────────────────
   *   • commit (here)   = CHANGE-level — truthful net delta. Feeds the commit
   *                       log, causal chain, narrative, and the lens highlight.
   *   • `onWrite` event = OP-level — fires on EVERY write attempt regardless of
   *                       net change. Feeds metrics / behavioural observability
   *                       (a debugger wants to see "wrote 2, then reverted").
   * `onWrite` is unchanged by this method; only the COMMIT becomes change-only.
   *
   * ── EMPTY COMMITS ARE INTENTIONAL ───────────────────────────────────────
   * A stage that nets no change commits an EMPTY patch — NOT nothing.
   * {@link StageContext.commit} still records the bundle unconditionally, so
   * every executed stage remains a time-travel cursor stop (its `runtimeStageId`
   * marker is preserved); only its PATCH is empty. This is what keeps the
   * commit-indexed slider stable while making the highlight truthful.
   *
   * ── KNOWN LIMITATIONS / FUTURE ──────────────────────────────────────────
   *   • Explicit key DELETION is still unrepresentable in MemoryPatch (a removed
   *     key cannot be expressed). Setting a key to `undefined` is treated as a
   *     change (value differs from base), not a deletion. Tracked for a future
   *     `delete` verb.
   *   • Array-merge dedup in {@link deepSmartMerge} still uses reference equality
   *     (`new Set`), so deep-equal *objects* in a merged array are not deduped.
   *     Orthogonal to this change; tracked separately.
   *
   * Resets the buffer to empty state after commit.
   */
  commit(): {
    overwrite: MemoryPatch;
    updates: MemoryPatch;
    redactedPaths: Set<string>;
    trace: { path: string; verb: 'set' | 'merge' }[];
  } {
    const payload = this.toChangeOnlyPayload();

    this.overwritePatch = {};
    this.updatePatch = {};
    this.opTrace.length = 0;
    this.redactedPaths.clear();
    this.workingCopy = {};

    return payload;
  }

  /**
   * Rebuild overwrite / updates / trace keeping ONLY paths whose final value
   * differs from the base value — i.e. the stage's net change. See
   * {@link TransactionBuffer.commit} for the rationale.
   *
   * Paths are compared at the exact granularity they were written (each trace
   * entry's path), against `workingCopy` (final) vs `baseSnapshot` (start).
   * Surviving `set` paths copy their final value from `overwritePatch`;
   * surviving `merge` paths copy their accumulated delta from `updatePatch` —
   * preserving the set-vs-merge verb so replay ({@link applySmartMerge}) is
   * byte-for-byte identical to recording only the real changes.
   */
  private toChangeOnlyPayload(): {
    overwrite: MemoryPatch;
    updates: MemoryPatch;
    redactedPaths: Set<string>;
    trace: { path: string; verb: 'set' | 'merge' }[];
  } {
    const overwrite: MemoryPatch = {};
    const updates: MemoryPatch = {};
    const trace: { path: string; verb: 'set' | 'merge' }[] = [];
    const survivingPaths = new Set<string>();

    for (const op of this.opTrace) {
      const segments = op.path.split(DELIM);
      const before = _get(this.baseSnapshot, segments);
      const after = _get(this.workingCopy, segments);
      if (deepEqual(before, after)) continue; // no-op or write-then-revert → no net change

      trace.push(op);
      survivingPaths.add(op.path);
      if (op.verb === 'set') {
        _set(overwrite, segments, structuredClone(_get(this.overwritePatch, segments)));
      } else {
        _set(updates, segments, structuredClone(_get(this.updatePatch, segments)));
      }
    }

    const redactedPaths = new Set([...this.redactedPaths].filter((path) => survivingPaths.has(path)));
    return { overwrite, updates, redactedPaths, trace };
  }
}
