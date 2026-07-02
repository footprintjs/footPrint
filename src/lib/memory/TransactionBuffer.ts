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
import type { CommitValuesMode, MemoryPatch, TraceEntry } from './types.js';
import { deepEqual, deepSmartMerge, DELIM, normalisePath } from './utils.js';

/** Op-level verbs staged into `opTrace`. `'delete'` is staged distinctly so
 *  delta-mode commits (#13c-B) can emit a real `delete` trace entry; under
 *  the default `'full'` mode it commits as `'set'` (of `undefined`) —
 *  byte-identical to the historical flattening. */
type OpVerb = 'set' | 'merge' | 'delete';

export class TransactionBuffer {
  private readonly baseSnapshot: any;
  private workingCopy: any;

  private overwritePatch: MemoryPatch = {};
  private updatePatch: MemoryPatch = {};
  private opTrace: { path: string; verb: OpVerb; readKeys?: string[] }[] = [];
  private redactedPaths = new Set<string>();
  /** Commit-value encoding policy (#13c-B). `'full'` = historical bytes. */
  private readonly commitValues: CommitValuesMode;

  /** Per-write read-provenance source (#P1). When set (the
   *  `writeProvenance: 'reads-prefix'` dial), every staged op snapshots the
   *  keys tracked-read so far — the temporal-prefix attribution consumed by
   *  causal slicing. Undefined (default) = zero cost, byte-identical ops. */
  private readonly readKeysProvider?: () => string[];

  constructor(base: any, commitValues: CommitValuesMode = 'full', readKeysProvider?: () => string[]) {
    this.baseSnapshot = structuredClone(base);
    this.workingCopy = structuredClone(base);
    this.commitValues = commitValues;
    this.readKeysProvider = readKeysProvider;
  }

  /** Stamp the current read prefix onto a staged op — only when the
   *  provenance dial is on (provider present), so the default path allocates
   *  nothing and commit bundles stay byte-identical. */
  private stampReadKeys(op: { path: string; verb: OpVerb; readKeys?: string[] }): typeof op {
    if (this.readKeysProvider) op.readKeys = this.readKeysProvider();
    return op;
  }

  /** Hard overwrite at the specified path. */
  set(path: (string | number)[], value: any, shouldRedact = false): void {
    _set(this.workingCopy, path, value);
    _set(this.overwritePatch, path, structuredClone(value));
    if (shouldRedact) {
      this.redactedPaths.add(normalisePath(path));
    }
    this.opTrace.push(this.stampReadKeys({ path: normalisePath(path), verb: 'set' }));
  }

  /**
   * Explicit key deletion at the specified path (#13c-B; absorbs backlog B8).
   *
   * Stages EXACTLY the same buffer mutations as `set(path, undefined)` —
   * `workingCopy`/`overwritePatch` get an own `undefined` at the path (the
   * historical flattening, preserving read behavior and the dedup diff base
   * across modes) — but records the op verb as `'delete'`. At commit:
   * `'full'` mode maps it back to a `'set'` trace entry (byte-identical to
   * today); `'delta'` mode emits a real `'delete'` entry whose replay
   * REMOVES the key instead of leaving `key: undefined` behind.
   */
  delete(path: (string | number)[], shouldRedact = false): void {
    _set(this.workingCopy, path, undefined);
    _set(this.overwritePatch, path, undefined);
    if (shouldRedact) {
      this.redactedPaths.add(normalisePath(path));
    }
    this.opTrace.push(this.stampReadKeys({ path: normalisePath(path), verb: 'delete' }));
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
    this.opTrace.push(this.stampReadKeys({ path: normalisePath(path), verb: 'merge' }));
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
   *   • Explicit key DELETION under the default 'full' mode is still
   *     flattened to set-of-`undefined` (a removed key cannot be expressed
   *     in MemoryPatch alone). CLOSED under `commitValues: 'delta'` (#13c-B):
   *     {@link delete} stages a distinct op and the bundle carries a real
   *     `delete` trace verb whose replay removes the key.
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
    trace: TraceEntry[];
  } {
    const payload = this.commitValues === 'delta' ? this.toDeltaPayload() : this.toChangeOnlyPayload();

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
   *
   * This is the DEFAULT (`commitValues: 'full'`) payload — byte-identical to
   * the historical behavior, including flattening staged `delete` ops into
   * `set`-of-`undefined` trace entries. The delta encoding lives in
   * {@link toDeltaPayload}.
   */
  private toChangeOnlyPayload(): {
    overwrite: MemoryPatch;
    updates: MemoryPatch;
    redactedPaths: Set<string>;
    trace: TraceEntry[];
  } {
    const overwrite: MemoryPatch = {};
    const updates: MemoryPatch = {};
    const trace: TraceEntry[] = [];
    const survivingPaths = new Set<string>();

    for (const op of this.opTrace) {
      const segments = op.path.split(DELIM);
      const before = _get(this.baseSnapshot, segments);
      const after = _get(this.workingCopy, segments);
      if (deepEqual(before, after)) continue; // no-op or write-then-revert → no net change

      // Historical flattening: an explicit delete commits as set-of-undefined.
      // Per-write provenance (#P1) rides each surviving entry untouched.
      trace.push(
        op.verb === 'delete'
          ? { path: op.path, verb: 'set' as const, ...(op.readKeys !== undefined && { readKeys: op.readKeys }) }
          : op,
      );
      survivingPaths.add(op.path);
      if (op.verb === 'merge') {
        _set(updates, segments, structuredClone(_get(this.updatePatch, segments)));
      } else {
        _set(overwrite, segments, structuredClone(_get(this.overwritePatch, segments)));
      }
    }

    const redactedPaths = new Set([...this.redactedPaths].filter((path) => survivingPaths.has(path)));
    return { overwrite, updates, redactedPaths, trace };
  }

  /**
   * Delta-encoded payload (`commitValues: 'delta'`, #13c-B) — same net-change
   * filter as {@link toChangeOnlyPayload}, two encoding differences:
   *
   * 1. **One trace entry per surviving path** (the §2.5 dedup rule — `append`
   *    is NOT idempotent on replay, so duplicate entries would multiply
   *    tails). The verb is resolved from the path's op mix + base→final
   *    relationship; entries are ordered by each path's LAST touch,
   *    preserving last-writer-wins for nested/overlapping paths.
   * 2. **Verb resolution per path**:
   *    - last op `'delete'` AND final value gone → `delete` (the path stays
   *      enumerated in `overwrite` with `undefined` for key-set consumers);
   *    - ONLY `'merge'` ops → `merge` with the accumulated `updatePatch`
   *      delta (replaying the accumulated delta once ≡ the full mode's
   *      k sequential replays — `deepSmartMerge` is reference-idempotent
   *      within one replay pass);
   *    - otherwise (`set`/mixed): the committed value is computed by
   *      replaying the path's op sequence EXACTLY the way `applySmartMerge`
   *      replays the full-mode bundle ({@link replayPathVerbs}) — for
   *      pure-set paths that is simply the last set value; for mixed
   *      set+merge interleavings it reproduces the full mode's quirk of
   *      applying the ACCUMULATED merge delta at every merge position
   *      (which can differ from the buffer's read-your-writes view; parity
   *      with the `'full'` mode's committed state is the contract). If base
   *      and that value are arrays and base is a STRICT PREFIX → `append`
   *      storing only the tail; else `set` storing the full value.
   *
   * Losslessness never depends on detection succeeding — every fallback is
   * today's full-value `set`.
   */
  private toDeltaPayload(): {
    overwrite: MemoryPatch;
    updates: MemoryPatch;
    redactedPaths: Set<string>;
    trace: TraceEntry[];
  } {
    const overwrite: MemoryPatch = {};
    const updates: MemoryPatch = {};
    const trace: TraceEntry[] = [];
    const survivingPaths = new Set<string>();

    // Path → its op-verb sequence, ordered by LAST touch (delete +
    // re-insert moves a re-touched path to the end of the Map's insertion
    // order — preserving last-writer-wins for nested/overlapping paths).
    // Per-write provenance (#P1): the LAST op's readKeys is kept — read
    // prefixes only grow within a stage, so last == union across the path.
    const byPath = new Map<string, { verbs: OpVerb[]; readKeys?: string[] }>();
    for (const op of this.opTrace) {
      const prev = byPath.get(op.path);
      if (prev) {
        prev.verbs.push(op.verb);
        if (op.readKeys !== undefined) prev.readKeys = op.readKeys;
        byPath.delete(op.path);
        byPath.set(op.path, prev);
      } else {
        byPath.set(op.path, { verbs: [op.verb], ...(op.readKeys !== undefined && { readKeys: op.readKeys }) });
      }
    }

    for (const [path, { verbs, readKeys }] of byPath) {
      const prov = readKeys !== undefined ? { readKeys } : undefined;
      const segments = path.split(DELIM);
      const before = _get(this.baseSnapshot, segments);
      const after = _get(this.workingCopy, segments);
      if (deepEqual(before, after)) continue; // no-op or write-then-revert → no net change (same filter as 'full')

      survivingPaths.add(path);
      const lastVerb = verbs[verbs.length - 1];
      if (lastVerb === 'delete' && after === undefined) {
        // Real deletion — replay removes the key. Keep the path enumerated
        // in `overwrite` (undefined) so Object.keys consumers see it.
        trace.push({ path, verb: 'delete', ...prov });
        _set(overwrite, segments, undefined);
      } else if (verbs.every((v) => v === 'merge')) {
        trace.push({ path, verb: 'merge', ...prov });
        _set(updates, segments, structuredClone(_get(this.updatePatch, segments)));
      } else {
        // Committed-equivalent value: replay this path's op sequence the way
        // applySmartMerge replays the FULL-mode bundle, so both modes commit
        // byte-identical state (see the method JSDoc).
        const committed = this.replayPathVerbs(before, segments, verbs);
        if (isStrictArrayPrefix(before, committed)) {
          trace.push({ path, verb: 'append', ...prov });
          _set(overwrite, segments, structuredClone((committed as unknown[]).slice((before as unknown[]).length)));
        } else {
          trace.push({ path, verb: 'set', ...prov });
          _set(overwrite, segments, structuredClone(committed));
        }
      }
    }

    const redactedPaths = new Set([...this.redactedPaths].filter((path) => survivingPaths.has(path)));
    return { overwrite, updates, redactedPaths, trace };
  }

  /**
   * Replay ONE path's op-verb sequence against its base value, exactly the
   * way `applySmartMerge` replays the corresponding full-mode bundle: every
   * `set`/`delete` position applies the LAST staged overwrite value (the
   * bag holds one value per path — last writer wins), every `merge`
   * position applies the ACCUMULATED `updatePatch` delta. This reproduces
   * the full mode's committed value for any interleaving — including the
   * mixed set+merge quirk where the accumulated delta re-applies pre-set
   * merge keys (full-mode replay semantics, kept for byte-parity across
   * modes; property-tested in delta-replay-equivalence).
   */
  private replayPathVerbs(before: unknown, segments: string[], verbs: OpVerb[]): unknown {
    const setValue = _get(this.overwritePatch, segments);
    const mergeDelta = _get(this.updatePatch, segments);
    let value: unknown = before;
    for (const verb of verbs) {
      value = verb === 'merge' ? deepSmartMerge(value ?? {}, mergeDelta) : setValue;
    }
    return value;
  }
}

/**
 * Append-detection predicate (#13c-B §2.2): both values are arrays, the
 * final is strictly longer, and the base is a structural prefix of the
 * final. Element compares short-circuit on reference identity (`deepEqual`'s
 * `===` fast path) before walking structure, and bail at the first mismatch
 * — worst case one structural compare of the base array, strictly cheaper
 * than the full-value `structuredClone` the fallback pays.
 *
 * `before === undefined` (first write) fails `Array.isArray` → `set`, which
 * keeps the first write as the causal anchor for "who initialized this key".
 */
function isStrictArrayPrefix(before: unknown, after: unknown): before is unknown[] {
  if (!Array.isArray(before) || !Array.isArray(after)) return false;
  if (after.length <= before.length) return false;
  for (let i = 0; i < before.length; i++) {
    if (!deepEqual(before[i], after[i])) return false;
  }
  return true;
}
