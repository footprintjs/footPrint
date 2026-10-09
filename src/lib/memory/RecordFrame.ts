/**
 * RecordFrame — the record half of one stage's frame (C3, L3).
 *
 * What a stage's frame needs to READ and WRITE the record, and nothing about the stage inside a run:
 * where it writes (its address), what it read first (the first-touch base), what it staged (the lazy
 * transaction buffer), which keys it read (the readKeys list), and where a commit lands (live state,
 * the redacted mirror, the log — through `recordCommit`). The engine's frame (`StageContext`, L4)
 * composes one and keeps the rest: retention, diagnostics, the dev-mode warnings, the commit observer
 * and the redaction verdict.
 *
 * THE LAW:
 *   1. ADDRESS. The frame reads and writes at its address, a path prefix the engine computed and hands
 *      over as data (C2: `['runs', <id>]` or `[]`, the root). It moves only while nothing is staged.
 *   2. FIRST TOUCH. The committed generation the frame first touched — its first read OR first write —
 *      is held by reference, never cloned: the read view before the first write and the buffer's
 *      net-change diff base after it.
 *   3. TWO TIERS. A read is served from the stage's own view (the buffer's working copy once the stage
 *      wrote, else the first-touch base); a key absent there is served from LIVE state (at the
 *      address, then the root). After the first write the buffer's diff base is first given a private
 *      copy at that path (`TransactionBuffer · detachBase`).
 *   4. LAZY BUFFER. The buffer is built at the first write — on the first-touch base, at the address,
 *      under the encoding. A frame that never writes builds none, and its commit is the empty bundle.
 *   5. READ KEYS. Under `writeProvenance: 'reads-prefix'` every noted read puts its user-level key
 *      (dotted for a nested path) on the frame's list, once, in order; each staged row carries a copy
 *      of the list as it stands when the row is staged.
 *   6. COMMIT, RELEASE, DISCARD. `commit` takes the buffer's payload (none = the empty commit), then
 *      the names, and hands both to `recordCommit`. `release` drops the buffer and the base; a frame
 *      touched again re-anchors on the state as it stands then. The readKeys list survives a release, and goes with `discard`
 *      (a failed attempt never happened).
 */

import type { EventLog } from './EventLog.js';
import { nativeGet } from './pathOps.js';
import { type CommitStamp, recordCommit } from './recordCommit.js';
import type { SharedMemory } from './SharedMemory.js';
import { TransactionBuffer } from './TransactionBuffer.js';
import type { CommitValuesMode, WriteProvenanceMode } from './types.js';

/**
 * The two dials that shape a frame's bytes: the log's value encoding and the per-row read prefix.
 * Held by reference and swapped whole (`useEncoding`), never edited — the engine hands the run's
 * frozen policy itself. Absent: `'full'` values and no read prefix.
 */
export interface RecordEncoding {
  readonly commitValues: CommitValuesMode;
  readonly writeProvenance: WriteProvenanceMode;
}

export class RecordFrame {
  /** Live committed state — the heap every frame of the run shares. */
  readonly state: SharedMemory;
  /** The log the frame's commits land on, when the run keeps one. */
  readonly log?: EventLog;
  /** The redacted mirror the frame's commits land on, when the run keeps one ({@link useMirror}). */
  private _mirror?: SharedMemory;
  /** Where the frame reads and writes (law 1). */
  private _address: readonly string[];
  /** The two dials (law 4, 5); absent → the record's defaults. */
  private encoding?: RecordEncoding;
  /**
   * The committed generation at the frame's FIRST touch (law 2) — held by REFERENCE, never cloned.
   * See {@link firstTouch} for the algorithm and the immutability invariant that makes a bare
   * reference safe.
   */
  private base?: Record<string, unknown>;
  /** The stage's staged writes — built at its first write (law 4), released at commit. */
  private buffer?: TransactionBuffer;
  /**
   * Keys tracked-read so far, in order (law 5) — the source of each staged row's `readKeys`. Only
   * allocated under `'reads-prefix'`; insertion-ordered (a Set) and monotonic, which is what makes
   * "last write's prefix == union" hold in delta mode.
   */
  private readKeys?: Set<string>;

  constructor(state: SharedMemory, log?: EventLog, address: readonly string[] = []) {
    this.state = state;
    this.log = log;
    this._address = address;
  }

  /** Where the frame reads and writes (law 1). */
  get address(): readonly string[] {
    return this._address;
  }

  /**
   * Read and write at `address` from now on. Returns `false` — and moves nothing — once the frame has
   * staged a write at another address: its buffer was built there (law 1).
   */
  useAddress(address: readonly string[]): boolean {
    if (this.buffer && !sameAddress(address, this._address)) return false;
    this._address = address;
    return true;
  }

  /** The two dials the frame encodes under from its next buffer and its next read on (law 4, 5). */
  useEncoding(encoding: RecordEncoding): void {
    this.encoding = encoding;
  }

  /** The redacted mirror, if the run keeps one. */
  get mirror(): SharedMemory | undefined {
    return this._mirror;
  }

  /** Land every commit from now on on `mirror` too, with the scrubbed rows the log takes (`recordCommit`). */
  useMirror(mirror: SharedMemory | undefined): void {
    this._mirror = mirror;
  }

  /** The absolute path of `key` under `path`: the frame's address, then the path, then the key. */
  at(path: readonly string[], key: string): string[] {
    // Every read and write builds one. The root's is the path and the key; under an address, an
    // index loop — the double spread `[...address, ...path, key]` costs a third more per call
    // (as `utils · pathUnder` found for the address and the path).
    const address = this._address;
    if (address.length === 0) return [...path, key];
    const out = new Array<string>(address.length + path.length + 1);
    for (let i = 0; i < address.length; i++) out[i] = address[i];
    for (let i = 0; i < path.length; i++) out[address.length + i] = path[i];
    out[out.length - 1] = key;
    return out;
  }

  /**
   * ── The first-touch base (#13) ───────────────────────────────────────────
   *
   * WHAT: returns the committed shared state as it was at this frame's FIRST touch (first read or
   * first write), capturing the reference on first call. Serves two consumers: reads before the first
   * write ({@link read}) and the transaction buffer's diff base ({@link getTransactionBuffer}).
   *
   * WHY A BARE REFERENCE IS SAFE — the invariant this rests on: committed state is
   * immutable-after-swap. Every write to `SharedMemory` builds the NEXT generation and swaps it in
   * (copy-on-write, 9.29.0: `applyPatch` via `nextGeneration`, and `setValue`/`updateValue` too) — it
   * copies the root and the containers on each written path, shares the rest, and never edits a
   * container of the generation a stage captured here. Holding the reference therefore gives this
   * stage a stable snapshot at zero cost — no clone, which is the entire point of #13. The transaction
   * buffer's net-change diff base rests on the same guarantee: it IS this view.
   *
   * WHY FIRST TOUCH, not first write: the pre-#13 eager engine cloned the state into the buffer at
   * the stage's first ACCESS, anchoring both its snapshot reads and its commit baseline (the
   * net-change diff base) there. #13's first cut anchored the lazy buffer at first WRITE — observably
   * different when something else commits in the gap between this stage's first read and its first
   * write. That gap is REACHABLE: fork siblings are namespace-isolated for run-scoped keys (each child
   * writes under `runs/<childId>/`), but ROOT-level keys are shared — written via `setGlobal` from
   * consumer scope code and, critically, by `SubflowInputMapper`'s output mapping
   * (`parentContext.setGlobal`), which is exactly what runs when a subflow is a fork branch. A
   * sibling's root-key commit landing in the gap would shift this stage's diff base, making its
   * CommitBundle record a phantom change (or swallow a real one) relative to the eager engine.
   * Anchoring the view at first touch restores the EXACT eager semantics — sequential AND parallel —
   * at zero clone cost.
   *
   * Read visibility is two-tier, matching eager byte-for-byte: keys present in the view at first
   * touch read repeatably from it; keys ABSENT from it fall back to LIVE state (the eager engine's
   * exact fallback — a mid-flight sibling root-key write was always visible to reads, and stays
   * visible; only the DIFF BASE is pinned).
   */
  private firstTouch(): Record<string, unknown> {
    if (!this.base) {
      this.base = this.state.getState();
    }
    return this.base;
  }

  /**
   * The transaction buffer, created lazily on the frame's FIRST WRITE (#13).
   *
   * Reads NEVER construct it: read-your-writes only matters once a staged write exists, so before that
   * {@link read} serves from the first-touch base and {@link commit} records an empty bundle — all with
   * ZERO `structuredClone`s of the shared state.
   *
   * The buffer's base is the FIRST-TOUCH view, NOT the live state at write time: under parallel forks
   * a sibling may have committed between this frame's first read and this write, and the net-change
   * diff base must stay anchored at first touch to match the eager engine — see {@link firstTouch}.
   */
  getTransactionBuffer(): TransactionBuffer {
    if (!this.buffer) {
      // Per-write provenance (#P1): hand the buffer a live view of this frame's read prefix —
      // evaluated AT EACH WRITE, so each staged op captures exactly the reads that preceded it.
      const readKeysProvider =
        this.encoding?.writeProvenance === 'reads-prefix' ? () => [...(this.readKeys ?? [])] : undefined;
      // The frame's address (9.30.0: the admitted record reads the containers there as where the
      // stage writes, never as a value it read).
      this.buffer = new TransactionBuffer(
        this.firstTouch(),
        this.encoding?.commitValues,
        readKeysProvider,
        this._address,
      );
    }
    return this.buffer;
  }

  /** Has the frame staged a write since its last release — does its buffer exist? */
  get hasStaged(): boolean {
    return this.buffer !== undefined;
  }

  /**
   * The frame's read, mirroring the eager engine's read order byte-for-byte (law 3):
   *
   *    1. staged writes + first-touch snapshot — `buffer.get` over its workingCopy when the buffer
   *       exists, else `nativeGet` over the zero-clone first-touch base (the buffer's base IS that
   *       view, so the two tiers agree on content);
   *    2. LIVE state via `SharedMemory · getValue` for keys absent from the snapshot — including its
   *       address→root fallback. The eager engine had this exact live fallback for snapshot-missing
   *       keys; byte-identity over purity. After the frame's first write such a value can be the very
   *       container the buffer's diff base holds at the path (the stage deleted or unset it, or
   *       replaced a container above it), so the base is detached there first
   *       (`TransactionBuffer · detachBase`): an in-place edit of the value (out of contract) written
   *       back is recorded, as on 9.28.0, whose base was a clone taken at the first write.
   *
   * Reads never construct the buffer (#13): a frame that never writes performs zero clones of the
   * shared state.
   */
  read(path: string[], key?: string): unknown {
    const at = this.at(path, key as string);
    const fromSnapshot = this.buffer ? this.buffer.get(at) : nativeGet(this.firstTouch(), at);
    if (typeof fromSnapshot !== 'undefined') return fromSnapshot;
    const live = this.state.getValue(this._address, path, key);
    // Tier 2 after the first write: keep the diff base exact (see above).
    if (this.buffer && live !== null && typeof live === 'object') this.buffer.detachBase(at);
    return live;
  }

  /** Put a tracked read's user-level key on the readKeys list (law 5) — a no-op unless the frame keeps one. */
  noteRead(path: readonly string[], key: string): void {
    if (this.encoding?.writeProvenance === 'reads-prefix') {
      (this.readKeys ??= new Set()).add(path.length > 0 ? [...path, key].join('.') : key);
    }
  }

  /** Live committed state at `key`: at the frame's address, else at the root — never the stage's own view. */
  readLive(key: string): unknown {
    return this.state.getValue(this._address, [], key);
  }

  /** Live committed state at `key` at the root. */
  readGlobal(key: string): unknown {
    return this.state.getValue([], [], key);
  }

  /** Did a staged op touch `path` — on it, above it or below it? (A report's question; never the hot path.) */
  wasStaged(path: (string | number)[]): boolean {
    return this.buffer !== undefined && this.buffer.wasStaged(path);
  }

  /**
   * The value at `path` in what the stage has seen — its working copy once it wrote, else its
   * first-touch base — WITHOUT taking a private copy: for a report that only compares.
   */
  peek(path: (string | number)[]): unknown {
    return this.buffer ? this.buffer.peek(path) : nativeGet(this.firstTouch(), path);
  }

  /** The value at `path` in the first-touch base — committed state as the frame first touched it. */
  baseAt(path: (string | number)[]): unknown {
    return nativeGet(this.firstTouch(), path);
  }

  /**
   * Record what the frame staged (law 6): the buffer's payload first — none, the empty commit, when
   * it staged nothing (#13: zero clones) — then the names (`stampOf()`), read once the payload is
   * built, and both to `recordCommit`. User code can run while the payload is built (a getter on a
   * staged value, which the net-change compare and the clone invoke); what it adds to the names —
   * an untracked read, say — is on the bundle.
   */
  commit(stampOf: () => CommitStamp): void {
    const payload = this.buffer?.commit();
    recordCommit(payload, stampOf(), { state: this.state, mirror: this._mirror, log: this.log });
  }

  /**
   * End the frame's hold on state (#13b, law 6): drop the buffer (its working copy and whatever private
   * copies its reads took) and the first-touch base (a reference that pins one committed-state
   * GENERATION). Both re-create lazily: a later read re-anchors on the CURRENT committed state, and a
   * later write builds a fresh buffer on it — so a second commit diffs against the state after the
   * first. Without the release, the execution tree — which retains every frame for the lifetime of
   * the run — retains one state generation per executed stage (measured O(N²) before copy-on-write;
   * a 500-iteration agent OOMed a default Node heap, backlog #18).
   */
  release(): void {
    this.buffer = undefined;
    this.base = undefined;
  }

  /**
   * Throw away everything the frame staged and read (law 6): the buffer, the first-touch base (the next
   * attempt re-anchors on committed state as it stands NOW) and the readKeys list — a discarded
   * attempt's reads must never reach the next attempt's `TraceEntry.readKeys`, or a backward slice
   * would follow an edge that no committed write ever had. Nothing is recorded.
   */
  discard(): void {
    this.release();
    this.readKeys = undefined;
  }
}

/** Two addresses name the same place when they hold the same segments. */
function sameAddress(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}
