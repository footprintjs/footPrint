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
import { deepEqual, deepSmartMerge, DELIM, normalisePath, supersededByNextSet } from './utils.js';

/** Op-level verbs staged into `opTrace`. `'delete'` is staged distinctly so
 *  delta-mode commits (#13c-B) can emit a real `delete` trace entry; under
 *  the default `'full'` mode it commits as `'set'` (of `undefined`) —
 *  byte-identical to the historical flattening. */
type OpVerb = 'set' | 'merge' | 'delete';

/** A path that passed the net-change filter, with everything the delta
 *  encoder needs to decide its verb — resolved once, then reused by the
 *  overlap-family grouping (`toDeltaPayload` rule 3). */
type Survivor = {
  path: string;
  segments: string[];
  verbs: OpVerb[];
  readKeys?: string[];
  /** Value at this path when the stage began (the append/diff base). */
  before: unknown;
  /** Value at this path after every staged op (read-your-writes view). */
  after: unknown;
};

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
   *
   * The net-change filter reads that staged own `undefined` as ABSENT
   * (`deepEqual`, 9.19.1) — so under `'delta'`, whose committed state really
   * lacks the key, deleting an absent key inside a container the stage also
   * re-wrote is the no-op it is, not a `set` of the whole container.
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

  /**
   * Field-level redaction (9.19.0): mark dot-paths INSIDE the value staged at
   * `path` as secret, so `redactPatch` scrubs them in the commit log and the
   * mirror the same way a whole-key redaction is scrubbed. A field is
   * registered as a literal key AND, when dotted, as the nested path it
   * names — whichever exists in the patch is the one `redactPatch` finds.
   * Marked paths survive commit only while the op path they sit under does
   * (see {@link survivingRedactedPaths}).
   */
  markRedactedFields(path: (string | number)[], fields: readonly string[]): void {
    for (const field of fields) {
      this.redactedPaths.add(normalisePath([...path, field]));
      if (field.includes('.')) this.redactedPaths.add(normalisePath([...path, ...field.split('.')]));
    }
  }

  /**
   * The redacted paths that survive the net-change filter: a path survives
   * when it IS a surviving op path (a whole-key redaction) or sits UNDER one
   * (a field inside a surviving write). A dropped op takes its fields with it.
   */
  private survivingRedactedPaths(survivingPaths: Set<string>): Set<string> {
    const out = new Set<string>();
    for (const path of this.redactedPaths) {
      if (survivingPaths.has(path)) {
        out.add(path);
        continue;
      }
      for (const op of survivingPaths) {
        if (path.startsWith(op + DELIM)) {
          out.add(path);
          break;
        }
      }
    }
    return out;
  }

  /** Read current value at path (includes uncommitted changes). */
  get(path: (string | number)[], defaultValue?: any) {
    return _get(this.workingCopy, path, defaultValue);
  }

  /**
   * Did any staged op touch `path`, or a path above or below it?
   *
   * The dev-mode borrowed-read check (`StageContext.commit`) asks this before
   * accusing a stage of mutating a value in place: a key the stage legitimately
   * WROTE is expected to differ from what it read, and writes reach the buffer
   * from paths that bypass user-level write tracking too (the subflow seed,
   * `outputMapper` merge-back, the resume re-seed). Dev-mode only — nothing on
   * the hot path calls it.
   */
  wasStaged(path: (string | number)[]): boolean {
    const target = normalisePath(path);
    for (const op of this.opTrace) {
      if (op.path === target || op.path.startsWith(target + DELIM) || target.startsWith(op.path + DELIM)) return true;
    }
    return false;
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
   *
   * Work, not bytes (9.22.1): the net-change verdict is paid once per PATH
   * and the clone once per CONSECUTIVE run of ops on a path, not once per op
   * — see the two memos inside. Pinned by
   * test/lib/memory/scenario/repeated-path-byte-identity.test.ts against the
   * 9.22.0 bytes.
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
    // Per PATH, decided once (9.22.1): base and final value are fixed at
    // commit, so every later op on a path gets the verdict its first op got.
    // `undefined` = not yet decided; the surviving paths are the `true` keys.
    const survives = new Map<string, boolean>();
    // The path the LAST surviving op copied into each patch tree (9.22.1).
    // The value at a path is fixed at commit, so an op whose predecessor on
    // the SAME tree already copied that path would write the same bytes over
    // the same key — it keeps its trace row (the log is byte-identical) and
    // pays no second clone. The 9.22.0 element-write funnel stages N
    // whole-array sets on ONE path; this is what makes that commit O(N)
    // instead of O(N × ops). CONSECUTIVE only — an op on another path in
    // between may have coerced or grown this one's container (a descendant
    // `nativeSet` through a primitive, a `key: undefined` shell) and the
    // re-copy is what repairs it; a `merge` between two sets touches the
    // other tree and does not count. Same law as `supersededByNextSet`.
    let lastSetPath: string | undefined;
    let lastMergePath: string | undefined;

    for (const op of this.opTrace) {
      let keep = survives.get(op.path);
      if (keep === undefined) {
        const segments = op.path.split(DELIM);
        keep = !deepEqual(_get(this.baseSnapshot, segments), _get(this.workingCopy, segments));
        survives.set(op.path, keep);
      }
      if (!keep) continue; // no-op or write-then-revert → no net change

      // Historical flattening: an explicit delete commits as set-of-undefined.
      // Per-write provenance (#P1) rides each surviving entry untouched.
      trace.push(
        op.verb === 'delete'
          ? { path: op.path, verb: 'set' as const, ...(op.readKeys !== undefined && { readKeys: op.readKeys }) }
          : op,
      );
      if (op.verb === 'merge') {
        if (lastMergePath === op.path) continue;
        lastMergePath = op.path;
        const segments = op.path.split(DELIM);
        _set(updates, segments, structuredClone(_get(this.updatePatch, segments)));
      } else {
        if (lastSetPath === op.path) continue;
        lastSetPath = op.path;
        const segments = op.path.split(DELIM);
        _set(overwrite, segments, structuredClone(_get(this.overwritePatch, segments)));
      }
    }

    const survivingPaths = new Set<string>();
    for (const [path, keep] of survives) if (keep) survivingPaths.add(path);

    const redactedPaths = this.survivingRedactedPaths(survivingPaths);
    return { overwrite, updates, redactedPaths, trace };
  }

  /**
   * Delta-encoded payload (`commitValues: 'delta'`, #13c-B) — same net-change
   * filter as {@link toChangeOnlyPayload}, three encoding differences:
   *
   * 1. **One trace entry per surviving path** (the §2.5 dedup rule — `append`
   *    is NOT idempotent on replay, so duplicate entries would multiply
   *    tails). The verb is resolved from the path's op mix + base→final
   *    relationship; entries are ordered by each path's LAST touch,
   *    preserving last-writer-wins for nested/overlapping paths.
   * 2. **Verb resolution per path** — for a path with NO surviving relative
   *    (see 3):
   *    - last op `'delete'` AND final value gone → `delete` (the path stays
   *      enumerated in `overwrite` with `undefined` for key-set consumers).
   *      Requires the parent to be a real container in the base — replay uses
   *      `nativeDelete`, which is inert on a primitive/absent parent, whereas
   *      the `'full'` flattening (`_set` of `undefined`) COERCES that parent
   *      into an object; when they would disagree we keep the flattening;
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
   * 3. **OVERLAP FAMILIES take the full-value fallback.** `overwrite` /
   *    `updates` are nested path TREES, so two surviving paths where one is
   *    an ancestor of the other (`a` and `a.p`) share storage. The `'full'`
   *    payload survives that because every entry stores the FULL value at its
   *    path, drawn from one coherent tree — nested entries agree with their
   *    ancestor by construction. Delta's per-path encodings do NOT: an
   *    `append` ancestor stores only a TAIL (whose indices are shifted
   *    relative to the whole array) and a `delete` ancestor stores
   *    `undefined`, so whichever entry is written second silently destroys or
   *    corrupts the other — the recorded write is LOST at replay. Therefore
   *    every path that has a surviving ancestor/descendant is committed as a
   *    plain `set` of the value it holds in the family's replayed value
   *    ({@link replayFamilyVerbs}), and the family's shallowest path (whose
   *    set covers the whole subtree) is emitted LAST. One coherent tree in,
   *    one coherent tree out: entries can no longer clobber each other and
   *    the replayed value is exact regardless of order.
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

    // Net-change filter — identical to 'full'. Survivors keep last-touch order.
    const survivors: Survivor[] = [];
    for (const [path, { verbs, readKeys }] of byPath) {
      const segments = path.split(DELIM);
      const before = _get(this.baseSnapshot, segments);
      const after = _get(this.workingCopy, segments);
      if (deepEqual(before, after)) continue; // no-op or write-then-revert → no net change (same filter as 'full')
      survivors.push({ path, segments, verbs, readKeys, before, after });
    }
    const survivingPaths = new Set(survivors.map((s) => s.path));

    // Group survivors into OVERLAP FAMILIES (rule 3): each path's family is
    // keyed by its SHALLOWEST surviving ancestor — walking prefixes shallow
    // first means the first hit is that root, and a depth-1 path (the common
    // case) never enters the loop at all. Any two paths sharing a root are
    // exactly the paths whose patch storage overlaps.
    const rootOf = new Map<string, string>();
    const byRoot = new Map<string, Survivor[]>();
    for (const s of survivors) {
      let root = s.path;
      for (let i = 1; i < s.segments.length; i++) {
        const ancestor = s.segments.slice(0, i).join(DELIM);
        if (survivingPaths.has(ancestor)) {
          root = ancestor;
          break;
        }
      }
      rootOf.set(s.path, root);
      const family = byRoot.get(root);
      if (family) family.push(s);
      else byRoot.set(root, [s]);
    }

    // Replay each overlapping family ONCE (lazily — most commits have none).
    const familyOps = this.opsByFamily(rootOf, byRoot);
    const familyValues = new Map<string, unknown>();
    const familyValue = (root: string): unknown => {
      if (!familyValues.has(root)) {
        familyValues.set(root, this.replayFamilyVerbs(root.split(DELIM), familyOps.get(root) ?? []));
      }
      return familyValues.get(root);
    };

    const emit = (s: Survivor): void => {
      const { path, segments, verbs, before } = s;
      const prov = s.readKeys !== undefined ? { readKeys: s.readKeys } : undefined;
      const root = rootOf.get(path) as string;
      const family = byRoot.get(root) as Survivor[];

      if (family.length > 1) {
        // Rule 3 — full-value fallback from ONE coherent family value.
        const relative = ['v', ...segments.slice(root.split(DELIM).length)];
        trace.push({ path, verb: 'set', ...prov });
        _set(overwrite, segments, structuredClone(_get({ v: familyValue(root) }, relative)));
        return;
      }

      const lastVerb = verbs[verbs.length - 1];
      if (lastVerb === 'delete' && s.after === undefined && this.deleteReplaysAsFlattening(segments)) {
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
    };

    for (const s of survivors) {
      const root = rootOf.get(s.path) as string;
      const family = byRoot.get(root) as Survivor[];
      if (family.length === 1) {
        emit(s);
        continue;
      }
      // Overlapping family: members in last-touch order, the ROOT emitted
      // LAST — its whole-subtree set is what makes the replayed subtree
      // exactly the family value (a descendant applied afterwards could only
      // re-state a value already inside it, but would also leave behind the
      // `key: undefined` shells 'full' mode never has).
      if (s.path !== root) emit(s);
      if (family[family.length - 1] === s) emit(family.find((m) => m.path === root) as Survivor);
    }

    const redactedPaths = this.survivingRedactedPaths(survivingPaths);
    return { overwrite, updates, redactedPaths, trace };
  }

  /**
   * Bucket the staged ops of every OVERLAPPING family by family root, in op
   * order — the input {@link replayFamilyVerbs} folds. Ops on paths the
   * net-change filter dropped are skipped (they are absent from `rootOf`),
   * exactly as the `'full'` payload drops them from its trace. One pass over
   * `opTrace`, and only when at least one family actually overlaps — commits
   * that write no nested path pay nothing.
   */
  private opsByFamily(
    rootOf: Map<string, string>,
    byRoot: Map<string, Survivor[]>,
  ): Map<string, { path: string; verb: OpVerb }[]> {
    const buckets = new Map<string, { path: string; verb: OpVerb }[]>();
    for (const [root, family] of byRoot) if (family.length > 1) buckets.set(root, []);
    if (buckets.size === 0) return buckets;
    for (const op of this.opTrace) {
      const bucket = buckets.get(rootOf.get(op.path) as string);
      if (bucket) bucket.push(op);
    }
    return buckets;
  }

  /**
   * Replay ONE overlapping family's staged ops onto the family root's base
   * value — the multi-path generalisation of {@link replayPathVerbs}, and
   * byte-for-byte what `applySmartMerge` produces for the corresponding
   * `'full'`-mode entries: each `set`/`delete` position writes that path's
   * `overwritePatch` value, each `merge` position deep-merges that path's
   * accumulated `updatePatch` delta into the value replayed so far.
   *
   * (Both patches are single coherent trees, so a full-mode bundle's stored
   * value at any recorded path always reads back as its `overwritePatch` /
   * `updatePatch` value — which is why sourcing from them here reproduces the
   * full-mode replay exactly, including its intermediate-coercion quirks.)
   *
   * The value is held in a `{ v }` box so the root itself (relative path `[]`)
   * can be REPLACED by `_set` the same way `applySmartMerge` replaces it
   * inside the state tree — including `nativeSet`'s coercion of primitive
   * intermediates.
   *
   * A `set` op the next op sets again is skipped on the same law as
   * `applySmartMerge` ({@link supersededByNextSet}) — this is the delta
   * encoder's own replay loop, and it clones per op just as the fold does.
   */
  private replayFamilyVerbs(rootSegments: string[], ops: { path: string; verb: OpVerb }[]): unknown {
    const box: { v: unknown } = { v: structuredClone(_get(this.baseSnapshot, rootSegments)) };
    for (let i = 0; i < ops.length; i++) {
      if (supersededByNextSet(ops, i)) continue;
      const op = ops[i];
      const segments = op.path.split(DELIM);
      const at = ['v', ...segments.slice(rootSegments.length)];
      if (op.verb === 'merge') {
        _set(box, at, deepSmartMerge(_get(box, at) ?? {}, structuredClone(_get(this.updatePatch, segments))));
      } else {
        _set(box, at, structuredClone(_get(this.overwritePatch, segments)));
      }
    }
    return box.v;
  }

  /**
   * May a staged `delete` at this path commit as the `'delete'` verb?
   *
   * Only when removing the key and the `'full'` mode's flattening (`_set` of
   * `undefined`) land in the same place. They diverge when the parent is not
   * a container: `nativeDelete` walks away untouched, while `nativeSet`
   * COERCES the primitive parent into an object to hold the key. Committing
   * `delete` there would silently drop a state change the stage really made,
   * so those (pathological) deletes keep the historical flattening.
   */
  private deleteReplaysAsFlattening(segments: string[]): boolean {
    if (segments.length === 1) return true; // parent is the state root — always a container
    const parent = _get(this.baseSnapshot, segments.slice(0, -1));
    return parent !== null && typeof parent === 'object';
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
 *
 * BOTH arrays must also be plain and dense ({@link isIndexOnly}): replay
 * reconstructs an append as `[...current, ...tail]`, and that spread carries
 * ONLY indexed elements — a named property parked on an array (a nested write
 * like `set(['history','note'], …)`, which `nativeSet` happily hangs off the
 * array object) or a hole would be silently dropped, where `'full'` mode
 * stores the value whole and keeps it.
 */
function isStrictArrayPrefix(before: unknown, after: unknown): before is unknown[] {
  if (!Array.isArray(before) || !Array.isArray(after)) return false;
  if (after.length <= before.length) return false;
  for (let i = 0; i < before.length; i++) {
    if (!deepEqual(before[i], after[i])) return false;
  }
  return isIndexOnly(before) && isIndexOnly(after);
}

/** True when an array's own enumerable keys are exactly its indices — no
 *  extra named properties and no holes, i.e. the array survives a spread
 *  intact. One `Object.keys` pass, same order as the prefix compare above
 *  and paid only after it succeeds. */
function isIndexOnly(arr: unknown[]): boolean {
  return Object.keys(arr).length === arr.length;
}
