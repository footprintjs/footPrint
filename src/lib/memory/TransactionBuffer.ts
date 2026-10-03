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
 *
 * The patch trees hold REFERENCES until commit (9.23.0). A `set` stores the
 * caller's own value in `overwritePatch` exactly as it always did in
 * `workingCopy`; the copy the record needs is taken ONCE per surviving path
 * when the payload leaves the buffer (`toChangeOnlyPayload` /
 * `toDeltaPayload` — every value they emit passes through `structuredClone`
 * there). The law "the record never aliases a caller's object" is kept at
 * the commit boundary instead of at every write, which is what makes N
 * writes to one path O(N) instead of O(N × size). Consequence, by design: a
 * caller who mutates its own object AFTER the write and BEFORE the stage
 * ends commits the value as the stage read it back — the record agrees with
 * the stage (CLAUDE.md landmine 3's first bite, closed). The one place the
 * engine itself edits THROUGH a staged value — a later nested op under a
 * `set` path — detaches that value first ({@link detachHeldAncestors}), so
 * `workingCopy` and `overwritePatch` never share a container the engine
 * mutates on one side only.
 *
 * COPY-ON-WRITE (9.29.0 — docs/design/2026-10-copy-on-write-commit.md). The
 * buffer no longer clones the committed state it starts from. `baseSnapshot`
 * IS the committed generation the stage first touched (held by reference —
 * committed state is immutable-after-swap), and `workingCopy` starts as a
 * copy of its ROOT only: each write copies the containers on its own path
 * ({@link ownSpine}), and the first READ after the stage's first write of a
 * container still shared with committed state takes a private deep copy of
 * it ({@link privatise}) — what the whole-state clone used to give every
 * read, so an in-place edit of a read value stays private exactly as it did.
 * A read the working copy cannot answer is served from live state by the
 * caller, as before; the buffer then replaces that path of its diff base
 * with a private copy ({@link detachBase}), as the clone had it.
 *
 * THE ADMITTED RECORD (9.30.0 — docs/design/2026-10-admitted-record.md). A
 * commit is admitted only if its bundle folds back to the stage's
 * read-your-writes view at every path the stage touched (and at every
 * container its writes created on the way there, below the stage's address).
 * Both encoders commit the value the stage read: a compact row — a `merge`
 * delta, an `append` tail — is kept where it provably folds back; a family of
 * rows that does not is recorded as `set` rows of the values the stage read
 * ({@link admit}). Before 9.30.0 the one accumulated merge delta per path was
 * replayed at every `merge` row of that path, which lied across a hard write
 * (`$update(k,{x}); k = {y}; $update(k,{z})` committed `{y, x, z}` for a
 * read-back of `{y, z}`), an `[]` clear, a kind change or an array union
 * deduplicated by reference. Verified when the stage staged a `merge` or a
 * nested op; a stage that staged only `set` / `delete` of keys directly under
 * its address is coherent by construction — both trees receive the same
 * write — and is admitted without the fold.
 */

import { type Family, type Lossy, type Member, type Rows, addressDepthOf, lossyFamilies } from './admission.js';
import { type OpVerb, type Survivor, emitInFamilyOrder, groupIntoFamilies, pushValueRow } from './deltaEncoding.js';
import { relation } from './keyPaths.js';
import {
  adopt,
  isContainer,
  nativeGet as _get,
  nativeSet as _set,
  own,
  ownChild,
  ownedRootOf,
  ownSpine,
  shallowCopy,
} from './pathOps.js';
import type { CommitValuesMode, MemoryPatch, TraceEntry } from './types.js';
import { deepEqual, deepSmartMerge, DELIM, dryFold, normalisePath } from './utils.js';

export class TransactionBuffer {
  /**
   * The net-change diff base: the committed generation the stage first
   * touched, by reference — except where {@link detachBase} replaced a path
   * of it with a private copy (its root and the containers on the way are
   * then copies too, owned by {@link baseOwned}).
   */
  private baseSnapshot: any;
  private workingCopy: any;

  private overwritePatch: MemoryPatch = {};
  private updatePatch: MemoryPatch = {};
  private opTrace: { path: string; verb: OpVerb; readKeys?: string[] }[] = [];
  private redactedPaths = new Set<string>();
  /**
   * Paths whose `overwritePatch` value is the caller's own object (9.23.0):
   * a `set` of a container stores the reference, and this is the ledger of
   * which ones are still shared with the caller (and with `workingCopy`).
   * Consulted only by the engine's nested ops — see
   * {@link detachHeldAncestors}; the commit payload clones every surviving
   * value anyway and never asks. Cleared with the rest at `commit()`.
   */
  private heldRefs = new Set<string>();
  /** Commit-value encoding policy (#13c-B). `'full'` = historical bytes. */
  private readonly commitValues: CommitValuesMode;

  /** Per-write read-provenance source (#P1). When set (the
   *  `writeProvenance: 'reads-prefix'` dial), every staged op snapshots the
   *  keys tracked-read so far — the temporal-prefix attribution consumed by
   *  causal slicing. Undefined (default) = zero cost, byte-identical ops. */
  private readonly readKeysProvider?: () => string[];

  /**
   * The containers in `workingCopy` this buffer CREATED: its root copy, the
   * path copies its writes made, the merge results it built, and every
   * container of the private copies its reads took. A write edits these in
   * place. Everything else in `workingCopy` is SHARED — with the committed
   * generation the stage first touched, or with a value the stage staged —
   * and is copied before a write passes through it ({@link ownSpine}).
   */
  private owned = new WeakSet<object>();

  /**
   * Container values the stage staged with {@link set} — its own objects,
   * held by reference (9.23.0). A read hands them back as they are, exactly
   * as the private working copy always did, and never privatises them: a
   * private copy of a staged value would leave `workingCopy` and
   * `overwritePatch` disagreeing about a value the stage wrote.
   */
  private staged = new WeakSet<object>();

  /**
   * Owned containers with no container still shared with committed state
   * anywhere below them (a private deep copy, a merge result built on a
   * private base, a path copy whose shared children were privatised). A read
   * that lands on one needs no walk — see {@link privatiseBelow}.
   */
  private privateTrees = new WeakSet<object>();

  /**
   * The containers of {@link baseSnapshot} that {@link detachBase} created:
   * its root copy and the copies on the way to a detached path. Allocated
   * only by the first detach — the in-contract stage never pays for it.
   */
  private baseOwned?: WeakSet<object>;

  /**
   * The private deep copies {@link detachBase} put into the diff base: nothing
   * at or below one is committed state, so a later detach inside it is a no-op.
   */
  private detachedBase?: WeakSet<object>;

  /**
   * Where the stage writes (9.30.0): `['runs', runId]` for a run-namespaced
   * stage, `[]` otherwise. Its containers are the stage's ADDRESS, not a value
   * the stage reads (every read it makes is a key below it), so a shell a
   * write leaves there is no part of the read-back the record must hold.
   */
  private readonly address: readonly string[];

  /** `merge` ops staged since the last commit — see {@link admit}. */
  private stagedMerges = 0;
  /** Ops staged deeper than one key below the stage's address — see {@link admit}. */
  private nestedOps = 0;

  constructor(
    base: any,
    commitValues: CommitValuesMode = 'full',
    readKeysProvider?: () => string[],
    address: readonly string[] = [],
  ) {
    // `base` is the committed generation the stage first touched —
    // immutable-after-swap, the invariant the first-touch view already rests
    // on — so the diff base is held by REFERENCE, and the working copy starts
    // as a copy of its ROOT only. Before 9.29.0 these two lines were two
    // `structuredClone`s of the whole state, paid by every stage that wrote.
    this.baseSnapshot = base;
    this.workingCopy = ownedRootOf(base, this.owned);
    this.commitValues = commitValues;
    this.readKeysProvider = readKeysProvider;
    this.address = address;
  }

  /** Stamp the current read prefix onto a staged op — only when the
   *  provenance dial is on (provider present), so the default path allocates
   *  nothing and commit bundles stay byte-identical. */
  private stampReadKeys(op: { path: string; verb: OpVerb; readKeys?: string[] }): typeof op {
    if (this.readKeysProvider) op.readKeys = this.readKeysProvider();
    return op;
  }

  /** Stage an op into `opTrace`, counting what decides whether {@link admit} must fold. */
  private stage(path: (string | number)[], key: string, verb: OpVerb): void {
    if (verb === 'merge') this.stagedMerges++;
    if (path.length - addressDepthOf(path, this.address) > 1) this.nestedOps++;
    this.opTrace.push(this.stampReadKeys({ path: key, verb }));
  }

  /**
   * Hard overwrite at the specified path. Stores the REFERENCE in both trees
   * (9.23.0) — the record's copy is taken once, at commit; see the header.
   */
  set(path: (string | number)[], value: any, shouldRedact = false): void {
    const key = normalisePath(path);
    this.detachHeldAncestors(path);
    ownSpine(this.workingCopy, path, this.owned);
    _set(this.workingCopy, path, value);
    _set(this.overwritePatch, path, value);
    if (isContainer(value)) {
      this.heldRefs.add(key);
      this.staged.add(value);
    } else {
      this.heldRefs.delete(key);
    }
    if (shouldRedact) {
      this.redactedPaths.add(key);
    }
    this.stage(path, key, 'set');
  }

  /**
   * A nested op is about to write THROUGH a path whose `overwritePatch`
   * value is a held reference (9.23.0). Today's law is that the two trees
   * receive the same nested `set`/`delete` mutations but ONLY `workingCopy`
   * receives a nested `merge`'s result (`updatePatch` gets the delta) — so a
   * container shared between the trees would leak the merged value into the
   * overwrite payload, and a shared container is also the caller's own
   * object, which the engine must not edit on the record's behalf. Replacing
   * the held ancestor with its clone in `overwritePatch` restores exactly
   * the private tree the per-write clone used to give it, paid once per
   * ancestor and only on the nested-op path the public surface never takes
   * (the scope proxy writes ROOT keys). `workingCopy` keeps the reference,
   * as it always did.
   */
  private detachHeldAncestors(path: (string | number)[]): void {
    if (this.heldRefs.size === 0) return;
    for (let i = 1; i < path.length; i++) {
      const ancestor = path.slice(0, i);
      const key = normalisePath(ancestor);
      if (!this.heldRefs.has(key)) continue;
      const held = _get(this.overwritePatch, ancestor);
      if (held !== null && typeof held === 'object') _set(this.overwritePatch, ancestor, structuredClone(held));
      this.heldRefs.delete(key);
    }
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
    const key = normalisePath(path);
    this.detachHeldAncestors(path);
    ownSpine(this.workingCopy, path, this.owned);
    _set(this.workingCopy, path, undefined);
    _set(this.overwritePatch, path, undefined);
    this.heldRefs.delete(key);
    if (shouldRedact) {
      this.redactedPaths.add(key);
    }
    this.stage(path, key, 'delete');
  }

  /** Deep union merge at the specified path. `deepSmartMerge` builds fresh
   *  containers, so neither tree ever holds the merge INPUT by reference;
   *  the nested-op detach guards the ancestor it writes INTO.
   *
   *  The value merged INTO is made private first (`privatise`), as the
   *  whole-state clone made it before 9.29.0. Not only for the reads that
   *  follow: `deepSmartMerge` unions arrays BY REFERENCE, so whether an
   *  element the stage passes in is "already there" depends on which objects
   *  the base holds — a committed array would dedup an element the stage
   *  read from it before its first write, where the private copy (and
   *  9.28.0) appends it. */
  merge(path: (string | number)[], value: any, shouldRedact = false): void {
    const key = normalisePath(path);
    this.detachHeldAncestors(path);
    this.privatise(path);
    const existing = _get(this.workingCopy, path) ?? {};
    const merged = deepSmartMerge(existing, value);
    ownSpine(this.workingCopy, path, this.owned);
    own(merged, this.owned);
    if (isContainer(merged)) this.privateTrees.add(merged);
    _set(this.workingCopy, path, merged);
    _set(this.updatePatch, path, deepSmartMerge(_get(this.updatePatch, path) ?? {}, value));
    if (shouldRedact) {
      this.redactedPaths.add(key);
    }
    this.stage(path, key, 'merge');
  }

  /**
   * Field-level redaction (9.19.0): mark dot-paths INSIDE the value staged at
   * `path` as secret, so `scrubPatch` scrubs them in the commit log and the
   * mirror the same way a whole-key redaction is scrubbed. A field is
   * registered as a literal key AND, when dotted, as the nested path it
   * names — whichever exists in the patch is the one `scrubPatch` finds.
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
   * Does a redaction mark address an array ELEMENT right below `path`
   * (`list.1.token`)? An `append` row re-bases the indices onto the tail, so
   * such a path takes the whole-value `set` (`deltaEncoding · pushValueRow`).
   * A mark by NAME below an array (`obj.y`) means the same thing on the tail
   * as on the whole value, so the compact row stays (byte-identical).
   */
  private markedBelow(path: string): boolean {
    const prefix = path + DELIM;
    for (const marked of this.redactedPaths) {
      if (!marked.startsWith(prefix)) continue;
      const next = marked.slice(prefix.length).split(DELIM)[0];
      if (/^(0|[1-9]\d*)$/.test(next)) return true;
    }
    return false;
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

  /**
   * Read current value at path (includes uncommitted changes). The value is
   * the stage's own — private to it, as the whole-state clone made every read
   * after the first write before 9.29.0 (`privatise`).
   */
  get(path: (string | number)[], defaultValue?: any) {
    this.privatise(path);
    return _get(this.workingCopy, path, defaultValue);
  }

  /**
   * Read the working copy at `path` WITHOUT taking a private copy — for a
   * reader that only compares (the dev-mode borrowed-mutation report in
   * `StageContext.commit`), never for a value handed to a stage.
   */
  peek(path: (string | number)[]): unknown {
    return _get(this.workingCopy, path);
  }

  /**
   * Keep the diff base exact under a read the working copy cannot answer.
   *
   * When `workingCopy` holds nothing at `path` — the stage deleted or unset
   * it, or a write replaced a container above it — `StageContext ·
   * readState` serves the read from LIVE committed state, exactly as 9.28.0
   * did, so the value it hands out is committed state itself. On 9.28.0 the
   * diff base was a whole-state clone taken at the stage's first write, and
   * an in-place edit of that value (out of contract — reads are borrowed)
   * could not move it: written back, the edit was recorded. Here the diff
   * base IS a committed generation, and it very often holds that same
   * container at `path` — the edit would move the base with it, and the
   * write-back would commit no change. So before the value goes out, the
   * base's value at `path` is replaced by a private deep copy (the base's
   * root and the containers on the way copied shallowly) — what 9.28.0's
   * base held there. The commit's net-change test compares against it and
   * the delta encoder replays from it; the value handed out stays the live
   * one, so whatever else an edit of it reaches (live state, the next
   * generation) behaves as on 9.28.0 too.
   *
   * Not `privatise`: a private copy handed to the stage would also keep the
   * edit out of live state, where 9.28.0 let it in — a run-namespaced read
   * that falls back to a global key would then end differently (the
   * differential's NESTED family fails within 100 programs that way).
   *
   * Copies nothing when the base holds no container at `path`, and nothing
   * twice: a path at or below an earlier detach is already private. O(path)
   * otherwise, plus O(value) once per detached path.
   */
  detachBase(path: (string | number)[]): void {
    if (path.length === 0 || !isContainer(this.baseSnapshot)) return;
    let at: object = this.baseSnapshot;
    for (const k of path) {
      if (this.detachedBase?.has(at)) return;
      const child = ownChild(at, k);
      if (!isContainer(child)) return;
      at = child;
    }
    if (this.detachedBase?.has(at)) return;
    const owned = (this.baseOwned ??= new WeakSet<object>());
    if (!owned.has(this.baseSnapshot)) this.baseSnapshot = ownedRootOf(this.baseSnapshot, owned);
    ownSpine(this.baseSnapshot, path, owned);
    const copy: object = structuredClone(at);
    (this.detachedBase ??= new WeakSet<object>()).add(copy);
    _set(this.baseSnapshot, path, copy);
  }

  /**
   * Private reads (9.29.0): make the value at `path` the stage's own before
   * a read hands it out — so a read after the stage's first write behaves
   * exactly as it did when the buffer began with a deep clone of the whole
   * state. An in-place edit of what the read returned (out of contract —
   * reads are borrowed) stays inside the buffer, and committed state is never
   * touched. Whether the RECORD keeps it is the admitted record's law
   * (9.30.0, owner ruling R1 — the record keeps what the stage read back): it
   * is kept when the edited value lies at or below a path the stage wrote in
   * this stage — set, merged or written back alike — and lost otherwise.
   *
   * Walking the path from the (owned) root:
   *  - a container still SHARED with committed state at the same position is
   *    replaced by a private deep copy when it is the value read, or by a
   *    shallow copy when it is a container on the way to it (so a read of
   *    `runs/<id>/k` copies `k`, not every run's namespace);
   *  - a container the stage STAGED (or anything else the buffer did not
   *    take from committed state) is handed back by reference, as before;
   *  - a container the buffer owns is walked on — and when it is the value
   *    read, its still-shared descendants are privatised
   *    ({@link privatiseBelow}).
   *
   * Cost: O(path) per read, plus O(value) ONCE per shared container a stage
   * reads after its first write. A stage that never reads after writing pays
   * nothing; a read before the first write never reaches the buffer.
   */
  private privatise(path: (string | number)[]): void {
    if (path.length === 0) return;
    // Resolve first: a read that lands on nothing (a missing key, a refused
    // segment, a primitive) returns nothing and must copy nothing.
    const chain: object[] = [];
    let at: unknown = this.workingCopy;
    for (const k of path) {
      at = ownChild(at, k);
      if (!isContainer(at)) return;
      chain.push(at);
    }
    let parent: any = this.workingCopy;
    let base: unknown = this.baseSnapshot;
    for (let i = 0; i < path.length; i++) {
      const k = path[i];
      const atBase = ownChild(base, k);
      let value = chain[i];
      if (!this.owned.has(value)) {
        if (value !== atBase || this.staged.has(value)) return;
        if (i === path.length - 1) {
          parent[k] = this.privateCopyOf(value);
          return;
        }
        value = shallowCopy(value);
        this.owned.add(value);
        parent[k] = value;
      }
      parent = value;
      base = atBase;
    }
    this.privatiseBelow(parent, base);
  }

  /**
   * An OWNED container is about to be read whole (a path copy a nested write
   * made, say): its descendants still shared with committed state are
   * replaced by private deep copies, so nothing the read hands out is
   * committed state. Walks owned containers only; marks each one finished
   * ({@link privateTrees}), so a container is scanned once per stage.
   */
  private privatiseBelow(container: object, base: unknown): void {
    const work: Array<[object, unknown]> = [[container, base]];
    while (work.length > 0) {
      const [node, nodeBase] = work.pop()!;
      if (this.privateTrees.has(node)) continue;
      for (const key of Object.keys(node)) {
        const child = ownChild(node, key);
        if (!isContainer(child)) continue;
        const atBase = ownChild(nodeBase, key);
        if (this.owned.has(child)) work.push([child, atBase]);
        else if (child === atBase && !this.staged.has(child)) {
          (node as Record<string, unknown>)[key] = this.privateCopyOf(child);
        }
      }
      this.privateTrees.add(node);
    }
  }

  /** A private deep copy of a committed container — owned through and through. */
  private privateCopyOf(value: object): object {
    const copy = structuredClone(value);
    adopt(copy, this.owned);
    this.privateTrees.add(copy);
    return copy;
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
      // On the path, below it or above it — the one path relation every key query asks.
      if (relation(op.path, target) !== undefined) return true;
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
    const rows = this.commitValues === 'delta' ? this.toDeltaPayload() : this.toChangeOnlyPayload();
    const redactedPaths = this.survivingRedactedPaths(new Set(rows.trace.map((t) => t.path)));
    // The key order is part of the bytes a consumer keeps.
    const payload = { overwrite: rows.overwrite, updates: rows.updates, redactedPaths, trace: rows.trace };

    this.overwritePatch = {};
    this.updatePatch = {};
    this.opTrace.length = 0;
    this.redactedPaths.clear();
    this.heldRefs.clear();
    this.workingCopy = {};
    this.owned = new WeakSet();
    this.owned.add(this.workingCopy);
    this.staged = new WeakSet();
    this.privateTrees = new WeakSet();
    this.stagedMerges = 0;
    this.nestedOps = 0;

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
   * surviving `merge` paths copy their accumulated delta from `updatePatch`,
   * keeping the set-vs-merge verb — and the result is ADMITTED ({@link admit}):
   * a family of rows whose replay does not give back what the stage read is
   * recorded as `set` rows of the read-back instead (9.30.0).
   *
   * This is the DEFAULT (`commitValues: 'full'`) payload, including the
   * historical flattening of staged `delete` ops into `set`-of-`undefined`
   * trace entries. The delta encoding lives in {@link toDeltaPayload}.
   *
   * Work, not bytes (9.22.1): the net-change verdict is paid once per PATH
   * and the clone once per CONSECUTIVE run of ops on a path, not once per op
   * — see the two memos inside. Pinned by
   * test/lib/memory/scenario/repeated-path-byte-identity.test.ts against the
   * 9.22.0 bytes. Since 9.23.0 that clone is THE clone: the patch trees hold
   * the caller's references (see the class header), so this loop is the one
   * place the record is detached from them.
   */
  private toChangeOnlyPayload(): Rows {
    return this.admit((lossy) => this.changeOnlyRows(lossy));
  }

  /** The 'full' rows; a family in `lossy` is written as its read-back, at its last touch ({@link emitReadBack}). */
  private changeOnlyRows(lossy: Lossy | undefined): Rows {
    const rows: Rows = { overwrite: {}, updates: {}, trace: [] };
    const { overwrite, updates, trace } = rows;
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

    for (let i = 0; i < this.opTrace.length; i++) {
      const op = this.opTrace[i];
      const family = lossy?.families.get(lossy.rootOf.get(op.path) as string);
      if (family !== undefined) {
        if (i === family.slot) {
          this.emitReadBack(family, rows, 'full');
          lastSetPath = lastMergePath = undefined;
        }
        continue;
      }
      let keep = survives.get(op.path);
      if (keep === undefined) {
        keep = this.changedSinceBase(op.path.split(DELIM));
        survives.set(op.path, keep);
      }
      if (!keep) continue; // no-op or write-then-revert → no net change

      trace.push(flattenedTraceRow(op));
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
    return rows;
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
   *      delta;
   *    - otherwise (`set`/mixed): the value the stage's 'full' rows give the
   *      path ({@link fullRowsValue}). If base and that value are arrays and
   *      base is a STRICT PREFIX → `append` storing only the tail; else `set`
   *      storing the full value.
   * 3. **OVERLAP FAMILIES take the full-value fallback.** `overwrite` /
   *    `updates` are nested path TREES, so two surviving paths where one is
   *    an ancestor of the other (`a` and `a.p`) share storage. Delta's
   *    per-path encodings would clobber each other there (an `append`
   *    ancestor stores only a TAIL, a `delete` ancestor `undefined`), so every
   *    path that has a surviving ancestor/descendant is committed as a plain
   *    `set` of the value the 'full' rows give it, and the family's
   *    shallowest path (whose set covers the whole subtree) is emitted LAST.
   *
   * The result is ADMITTED ({@link admit}) like the 'full' payload: a compact
   * row is kept only where the bundle provably folds back, and a family that
   * does not is recorded as what the stage read. So both encodings commit the
   * value the stage read; before 9.30.0 they shared a replay that did not
   * (`replayPathVerbs` / `replayFamilyVerbs`, deleted).
   */
  private toDeltaPayload(): Rows {
    const fullValueAt = this.fullRowsValue();
    return this.admit((lossy) => this.deltaRows(lossy, fullValueAt));
  }

  /** The delta rows; a family in `lossy` is written as its read-back, at its last touch ({@link emitReadBack}). */
  private deltaRows(lossy: Lossy | undefined, fullValueAt: (segments: string[]) => unknown): Rows {
    const rows: Rows = { overwrite: {}, updates: {}, trace: [] };
    const { overwrite, updates, trace } = rows;
    const inLossy = (path: string) => lossy?.families.has(lossy.rootOf.get(path) as string) === true;
    const survivors = this.netChangeSurvivors(this.opsByPath()).filter((s) => !inLossy(s.path));
    const { rootOf, byRoot } = groupIntoFamilies(survivors, new Set(survivors.map((s) => s.path)));

    // THE VERB CHOICE — the delta encoder picks a verb per path; the VALUES
    // it encodes come from the one replay (`fullValueAt`), never a replica of
    // the verb law (9.30.0: CLAUDE.md's verb-switch replicas lost two here).
    const emit = (s: Survivor): void => {
      const { path, segments, verbs, before } = s;
      const prov = provenance(s.readKeys);
      if ((byRoot.get(rootOf.get(path) as string) as Survivor[]).length > 1) {
        // Rule 3 — one coherent tree: every member a set of its value.
        trace.push({ path, verb: 'set', ...prov });
        _set(overwrite, segments, structuredClone(fullValueAt(segments)));
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
        pushValueRow(rows, path, segments, before, fullValueAt(segments), prov, this.markedBelow(path));
      }
    };

    // A family that did not fold back takes its place by its last touch.
    const pending = lossy === undefined ? [] : [...lossy.families.values()].sort((a, b) => a.slot - b.slot);
    let next = 0;
    const flushBefore = (touch: number): void => {
      while (next < pending.length && pending[next].slot < touch) this.emitReadBack(pending[next++], rows, 'delta');
    };
    emitInFamilyOrder(survivors, rootOf, byRoot, emit, flushBefore);
    flushBefore(Infinity);
    return rows;
  }

  // ── The admitted record (9.30.0) ───────────────────────────────────────

  /**
   * THE ADMISSION — a commit is admitted only if its bundle folds back to the
   * stage's read-your-writes view at every path the stage touched. `build`
   * lays the rows out (one encoder: `'full'` or `'delta'`); the candidate is
   * checked ({@link lossyFamilies}), and when some family's rows do not fold
   * back the rows are laid out again with those families written as what the
   * stage read ({@link emitReadBack}) — every other family's bytes exactly as
   * the first layout made them.
   */
  private admit(build: (lossy: Lossy | undefined) => Rows): Rows {
    const candidate = build(undefined);
    const lossy = this.lossyFamilies(candidate);
    return lossy === undefined ? candidate : build(lossy);
  }

  /**
   * The families whose rows do not fold back to what the stage read —
   * `undefined` when there are none (`admission.ts · lossyFamilies`: the
   * candidate replayed onto the diff base by `dryFold`, every family of
   * touched paths compared with the working copy at its root and on the way
   * down to it).
   *
   * Without a fold, when the stage staged no `merge` and no nested op: its
   * rows are `set` / `delete` of keys directly under its address, each
   * writing the SAME value into `workingCopy` and `overwritePatch` — the
   * record is the read-back by construction (the property's ROOT-ONLY arm
   * pins this). That keeps the commit of the typed scope's root-key writes
   * exactly as cheap as it was.
   */
  private lossyFamilies(candidate: Rows): Lossy | undefined {
    if (this.stagedMerges === 0 && this.nestedOps === 0) return undefined;
    return lossyFamilies(candidate, this.baseSnapshot, this.workingCopy, this.opTrace, this.address);
  }

  /**
   * A family whose rows did not fold back, written as what the stage read:
   * one `set` row per member that changed (descendants by last touch, each
   * with its own read prefix), the ROOT last, and the root's read-back value
   * in `overwrite` — one coherent tree, so no row can clobber another. The
   * root's row is written even when the root itself did not change: it is the
   * row that carries the family's read-back (and the containers L-1's dropped
   * op left). A lone root under `'delta'` keeps the compact `append` when the
   * value it read is its base plus a tail.
   */
  private emitReadBack(family: Family, rows: Rows, encoding: CommitValuesMode): void {
    let root: Member = family.members[0];
    let changed = 0;
    for (const m of family.members) {
      if (m.path === family.root) {
        root = m;
        continue;
      }
      if (!this.changedSinceBase(m.path.split(DELIM))) continue;
      rows.trace.push({ path: m.path, verb: 'set', ...provenance(m.readKeys) });
      changed++;
    }
    const after = _get(this.workingCopy, family.rootSegments);
    if (encoding === 'delta' && changed === 0 && after !== undefined) {
      const before = _get(this.baseSnapshot, family.rootSegments);
      pushValueRow(
        rows,
        family.root,
        family.rootSegments,
        before,
        after,
        provenance(root.readKeys),
        this.markedBelow(family.root),
      );
      return;
    }
    rows.trace.push({ path: family.root, verb: 'set', ...provenance(root.readKeys) });
    // The clone the check took (`admission.ts · foldsBack`), when it took one.
    _set(rows.overwrite, family.rootSegments, family.held !== undefined ? family.held.value : structuredClone(after));
  }

  /**
   * The value the stage's 'full' rows give a path — what the delta encoder
   * commits for a family member or a path with a `set` — read from ONE
   * {@link dryFold} of those rows over the patch trees themselves, taken the
   * first time it is asked. By reference, as the stage held them: an element
   * a `set` and a `merge` of one path share stays one element. A stage that
   * staged no `merge` and no nested op needs no fold — a path's value is its
   * last staged value. (Before 9.30.0: two replicas of the verb law,
   * `replayPathVerbs` and `replayFamilyVerbs`.)
   */
  private fullRowsValue(): (segments: string[]) => unknown {
    if (this.stagedMerges === 0 && this.nestedOps === 0) return (segments) => _get(this.overwritePatch, segments);
    let fold: unknown;
    return (segments) => {
      fold ??= dryFold(this.baseSnapshot, this.updatePatch, this.overwritePatch, this.fullRows());
      return _get(fold, segments);
    };
  }

  /** The stage's 'full' rows: every op on a path the net-change filter keeps, a `delete` spelled `set`. */
  private fullRows(): TraceEntry[] {
    const keep = new Map<string, boolean>();
    const rows: TraceEntry[] = [];
    for (const op of this.opTrace) {
      let k = keep.get(op.path);
      if (k === undefined) keep.set(op.path, (k = this.changedSinceBase(op.path.split(DELIM))));
      if (k) rows.push({ path: op.path, verb: op.verb === 'merge' ? 'merge' : 'set' });
    }
    return rows;
  }

  /**
   * Did the stage change the value at `segments`? Base and final value are
   * fixed at commit, so this is the ONE net-change verdict both payload
   * encodings apply (a no-op write and a write-then-revert both fail it).
   */
  private changedSinceBase(segments: string[]): boolean {
    return !deepEqual(_get(this.baseSnapshot, segments), _get(this.workingCopy, segments));
  }

  /**
   * Path → its op-verb sequence, ordered by LAST touch (delete + re-insert
   * moves a re-touched path to the end of the Map's insertion order —
   * preserving last-writer-wins for nested/overlapping paths). Per-write
   * provenance (#P1): the LAST op's readKeys is kept — read prefixes only grow
   * within a stage, so last == union across the path.
   */
  private opsByPath(): Map<string, { verbs: OpVerb[]; readKeys?: string[]; last: number }> {
    const byPath = new Map<string, { verbs: OpVerb[]; readKeys?: string[]; last: number }>();
    for (let i = 0; i < this.opTrace.length; i++) {
      const op = this.opTrace[i];
      const prev = byPath.get(op.path);
      if (prev) {
        prev.verbs.push(op.verb);
        prev.last = i;
        if (op.readKeys !== undefined) prev.readKeys = op.readKeys;
        byPath.delete(op.path);
        byPath.set(op.path, prev);
      } else {
        byPath.set(op.path, {
          verbs: [op.verb],
          last: i,
          ...(op.readKeys !== undefined && { readKeys: op.readKeys }),
        });
      }
    }
    return byPath;
  }

  /** The net-change filter — identical to 'full' ({@link changedSinceBase}). Survivors keep last-touch order. */
  private netChangeSurvivors(byPath: Map<string, { verbs: OpVerb[]; readKeys?: string[]; last: number }>): Survivor[] {
    const survivors: Survivor[] = [];
    for (const [path, { verbs, readKeys, last }] of byPath) {
      const segments = path.split(DELIM);
      if (!this.changedSinceBase(segments)) continue; // no-op or write-then-revert → no net change
      const before = _get(this.baseSnapshot, segments);
      const after = _get(this.workingCopy, segments);
      survivors.push({ path, segments, verbs, readKeys, last, before, after });
    }
    return survivors;
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
}

/**
 * Historical flattening for the `'full'` payload: an explicit delete commits
 * as set-of-undefined. Per-write provenance (#P1) rides each surviving entry
 * untouched.
 */
function flattenedTraceRow(op: { path: string; verb: OpVerb; readKeys?: string[] }): TraceEntry {
  return op.verb === 'delete'
    ? { path: op.path, verb: 'set' as const, ...(op.readKeys !== undefined && { readKeys: op.readKeys }) }
    : op;
}

/** A row's `readKeys` fragment — absent unless the provenance dial recorded one (#P1). */
function provenance(readKeys: string[] | undefined): { readKeys: string[] } | undefined {
  return readKeys !== undefined ? { readKeys } : undefined;
}
