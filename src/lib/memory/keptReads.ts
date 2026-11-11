/**
 * keptReads.ts — which reads a frame has already kept, so that a read is kept ONCE for each object a
 * root key holds, and not once for each read of it.
 *
 * WHY THIS FILE EXISTS. Keeping a read copies the value (`readTracking: 'full'`, the default) or
 * measures it (`'summary'`). Done at EVERY read, a step that walks a list by index (`items[0]`,
 * `items[1]`, …) copied the whole list once per element: 1,000 reads of a list of 1,000 records took
 * 226 ms, and 1.9 ms with the list taken once into a variable; 3,000 took 2.0 s. The cost grew with the
 * square of the list, under the default setting (measured on 11.2.0; `bench/repeat-reads.ts`).
 *
 * THE RULE. The same OBJECT, read again under a root this frame has not written, holds what it held
 * the first time. Such a read is served from committed state, or from this frame's private copy of it,
 * and neither is changed by anything the record sees: a committed generation is never edited (the
 * copy-on-write law), and every engine write goes through one funnel (`StageContext · stageWrite`),
 * which tells this file the root it writes under ({@link KeptReads.wrote}). From then on that root is
 * kept at every read, as before: what the frame wrote may be an object the caller still holds and
 * rightly changes (`s.k = o; o.x = 1`), or a private copy the buffer edits in place, so the same object
 * can hold something new.
 *
 * NOT COVERED, and kept at every read as before:
 *   - a root the frame has written, from that write on. So a stage that WRITES the key it walks
 *     (`for (…) s.items[i].done = true`) still pays at every read: what it reads is its own working
 *     copy, a new list after each write (1,000 elements: 243 ms; with the list taken into a variable
 *     first, 3.7 ms; `bench/repeat-reads.ts`);
 *   - a read at a nested path (the engine reads that way, and so do the `/zod` scope and a direct
 *     `StageContext.getValue(path, key)`);
 *   - a read under a redaction verdict (what is kept is not the value);
 *   - a value that is not an object (a text or a number is kept without a copy, `retainedValue ·
 *     retainedForm`).
 * The caller decides the last three ({@link KeptReads.kept}, `standsForNext`); this file holds objects
 * by the slot a read was kept in.
 *
 * ONE THING MOVES, outside the contract: a stage that edits IN PLACE a value it only read (which the
 * record never sees, and dev mode warns about) used to leave that edit in `stageReads` if it read the
 * key again afterwards. `stageReads` now keeps the value as it was first read, and the dev-mode check,
 * which holds that copy against the value at commit, reports such an edit even then. The byte tests
 * against older engines name this law (`test/lib/engine/scenario/read-kept-once-law.ts`).
 *
 * WHAT IS HELD is a reference to a committed value, so it must not outlive the step: the frame
 * releases it with its staging state, at commit and when an attempt is dropped ({@link KeptReads.release}).
 */

/** This frame has written at or under the root key: each read of it is kept anew. */
const WRITTEN = Symbol('written');

export class KeptReads {
  /**
   * By the slot of `stageReads` a read was kept in (a root key): the object whose retained form the
   * frame holds there, or {@link WRITTEN} for a root it has written under.
   */
  private byRoot?: Map<string, unknown>;

  /** The frame wrote at or under `root`. */
  wrote(root: string): void {
    (this.byRoot ??= new Map()).set(root, WRITTEN);
  }

  /** Does the frame already hold what a read of the object `value` under root `key` would keep? */
  holds(key: string, value: object): boolean {
    return this.byRoot?.get(key) === value;
  }

  /**
   * The frame has just kept a read in `slot` of its `stageReads`: a root key, or the dotted name of a
   * path, which a root key may bear too (`'a.b'` is a key, and the path a → b). `standsForNext`: what
   * it kept is the retained form of the object `value` read at the root, and stands for the next read
   * of the same object. Anything else kept in the slot ends what stood there. Called only once the
   * retained form is there, so a value that could not be kept is asked again next time.
   */
  kept(slot: string, value: unknown, standsForNext: boolean): void {
    const now = this.byRoot?.get(slot);
    if (now === WRITTEN) return;
    if (standsForNext) (this.byRoot ??= new Map()).set(slot, value);
    else if (now !== undefined) this.byRoot?.delete(slot);
  }

  /** The step committed, or its attempt was dropped: hold no object of it. */
  release(): void {
    this.byRoot = undefined;
  }
}
