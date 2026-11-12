/**
 * hiddenObjectTrail.ts — one frame's side of "a hidden object keeps its rule wherever the stage puts it".
 *
 * `selectedObjects.ts` knows objects: which ones a stage read under a hidden name, and how to find
 * them in a value. This file knows the frame: which keys it wrote, what each of them showed when it
 * was written, and the two moments a written value is searched.
 *
 *   1. AT THE WRITE (`stage`). The new value is searched before its bytes are staged, because the
 *      verdict decides those bytes and the write event.
 *   2. AT COMMIT (`followAtCommit`). The record takes a value as it stands when the stage commits. A
 *      stage that writes an object and then puts a hidden one into it (`s.box = o; o.p = s.secret`)
 *      records `p`, and no write ever showed it. So each written key is searched once more, and a key
 *      that gains a hidden place is staged again as a `set` of its value, so that the record hides it.
 *      That changes the key's row in this case only.
 *
 * WHY A WRITTEN KEY KEEPS WHAT IT SHOWED (`shown`). The search at commit must find what was put in
 * AFTER the write and nothing else: a record must not change because a stage read a key. One case
 * needs help. An object the stage wrote under a public name and then hid (`s.public = h; s.hidden =
 * h`) is a remembered object in `public` by the time of the commit, and nothing was put in. So each
 * key keeps the objects that sat at its public places when it was written and were not hidden then.
 * They come from three walks, each of what the stage wrote and nothing more:
 *
 *   - the search at the write itself (`selectedObjects.ts · findIn` adds them as it goes);
 *   - after a merge, the containers the record made for it: the patch was searched, and the key now
 *     holds the record's own copies of it;
 *   - once, when the stage reads its first hidden object: the keys it wrote before that were never
 *     searched, because there was nothing to look for.
 *
 * Anything else that turns up at commit counts as put in: when in doubt, it is hidden. (One such case
 * is known and harmless: a write BELOW a key through the frame's path API copies the containers above
 * it, and those copies are not noted. One of them copied under a hidden name and read back is then
 * hidden at its own place too.)
 *
 * WHY WHAT THE FRAME KEEPS OF A WRITE IS LOOKED AT TOO (`keep`). A frame keeps each write for its
 * snapshot (the execution tree, the commit event) and takes the kept form at commit. For a `set` the
 * kept value is what the record holds, so it takes the key's rule as the search left it. For a MERGE
 * it is not: the record copied the patch when it merged it, and the frame still holds the caller's
 * patch. A hidden object put into that patch afterwards never reaches the record, and it did reach
 * the kept form. So the kept patch is searched as it stands, and what is found is hidden in the kept
 * form only: the record does not hold it, so no rule of the run changes.
 *
 * WHY THIS IS NOT IN `StageContext`. It is one rule with its own state (the remembered objects, the
 * written keys), and the frame already holds too much. The frame keeps the write funnel and the marks;
 * it asks this file at a hidden read, at a write, at commit and when a try is thrown away.
 *
 * No outside source: it is the bookkeeping of `selectedObjects.ts`, which says where the idea is from.
 */

import { deepEqual } from 'foottrace';
import type { RecordFrame, WriteVerb } from 'foottrace/write';

import {
  type RedactionRule,
  type RedactionVerdict,
  inheritByIdentity,
  keptUnder,
  sameVerdict,
  scrubOf,
  userKeyOf,
} from './redaction.js';
import { type SameContent, type SelectedRule, SelectedObjects, ShownObjects } from './selectedObjects.js';
import { placesHiddenIn } from './servedPlaces.js';

/** One top key this frame wrote, at the absolute path it lands at. */
interface WrittenKey {
  readonly root: string;
  readonly at: string[];
  /** The objects that sat at a public place of its value when the frame wrote it, not hidden then. */
  shown?: ShownObjects;
}

/**
 * What a frame keeps of one write for its snapshot (`StageContext · _pendingWrites`): the value by
 * reference, the verdict it will be retained under, and where it was written.
 */
export interface KeptWrite {
  readonly value: unknown;
  verdict: RedactionVerdict;
  readonly operation: 'set' | 'update' | 'delete';
  readonly path: readonly string[];
  readonly key: string;
}

/** Separates the segments of a written key's path: one frame can write a key of one name at two places. */
const SEGMENT = '\u001f';

/**
 * Does an object hold what the committed one at its place held? A read after the stage's first write
 * hands out a private copy of committed state: a new object with the same content. Content the library
 * cannot read (a `Blob`) is equal only to itself here: the object asked about may be a hidden one put
 * in place, not a copy, so nothing may be assumed of it.
 */
const sameAsBefore: SameContent = (now, before) => deepEqual(now, before);

/** The name a rule of the stage's input carries (`SelectedRule.key`): it has no key of its own. */
const INPUT = '$getArgs';

/** A verdict as the rule its name gives a value: `undefined` when it hides nothing. */
function namedBy(verdict: RedactionVerdict): SelectedRule | undefined {
  return verdict.kind === 'clear' ? undefined : verdict;
}

export class HiddenObjectTrail {
  private selected?: SelectedObjects;
  private written?: Map<string, WrittenKey>;
  /** The input that was last looked at for selected objects ({@link rememberInput}). */
  private inputSeen?: unknown;

  /** `record` is the frame's record; `rule` gives the redaction rule that is active when it is asked. */
  constructor(private readonly record: RecordFrame, private readonly rule: () => RedactionRule | undefined) {}

  /** The objects read under a hidden name so far. None: there is nothing to follow yet. */
  get objects(): SelectedObjects | undefined {
    return this.selected;
  }

  /**
   * `value` was read under a hidden name: it, and every object inside it, keeps `rule` from now on.
   * At the first one, the keys the frame wrote before are noted for what they show (file header, why).
   */
  remember(value: unknown, rule: SelectedRule): void {
    if (value === null || typeof value !== 'object') return;
    if (this.selected === undefined) {
      this.selected = new SelectedObjects();
      this.noteWhatWasWritten(this.selected);
    }
    this.selected.remember(value, rule);
  }

  /**
   * The stage's input was handed out (`$getArgs()`): `input` is what the stage holds, `source` the
   * record it was made from (the same for every stage of a run). Inside a sub-flowchart the input IS
   * the parent's values. What the library hides when it SERVES that input is what the stage must not
   * pass on: so the one rule that serves it is asked (`servedPlaces.ts`), and every place it hides is
   * remembered, as fields of the input.
   *
   * An input the rule cannot serve (its keys cannot be read) is remembered whole: the safe side, and
   * `$getArgs()` does not fail.
   */
  rememberInput(input: unknown, source: unknown = input): void {
    if (this.inputSeen === input) return;
    this.inputSeen = input;
    const active = this.rule();
    if (active === undefined || input === null || typeof input !== 'object') return;
    const hidden = placesHiddenIn(active, source !== null && typeof source === 'object' ? source : input);
    if (hidden === undefined) this.remember(input, { kind: 'whole', key: INPUT });
    else if (hidden.length > 0) this.remember(input, { kind: 'fields', key: INPUT, paths: hidden });
  }

  /**
   * Steps 2 and 3 of a staged write (`StageContext · stageWrite`): search the value for hidden objects,
   * then stage its bytes under the verdict that comes of it. Returns that verdict.
   *
   * `asked` is step 1's verdict, by name. `nsPath` is the absolute path of the write, `path` and `key`
   * its user-level spelling.
   */
  stage(
    active: RedactionRule | undefined,
    asked: RedactionVerdict,
    nsPath: string[],
    path: readonly string[],
    key: string,
    value: unknown,
    verb: WriteVerb,
  ): RedactionVerdict {
    const wrote = verb === 'delete' ? undefined : this.keyOf(nsPath, path, key);
    const selected = this.selected;
    if (active === undefined || selected === undefined || wrote === undefined || asked.kind === 'whole') {
      this.record.write(nsPath, value, verb, scrubOf(asked));
      return asked;
    }
    const shown = (wrote.shown ??= new ShownObjects());
    const base = this.heldNow(nsPath, value);
    const how = { base, shown, patch: verb === 'merge', replaces: verb === 'set' && path.length === 0 };
    const verdict = inheritByIdentity(active, asked, selected, path, key, value, how);
    this.record.write(nsPath, value, verb, scrubOf(verdict));
    // A merge: the key now holds containers the record made, not the patch that was searched.
    if (verb === 'merge') selected.noteShown(this.record.peek(nsPath), base, { named: namedBy(verdict), shown });
    return verdict;
  }

  /**
   * Search every key this frame wrote once more, as it stands now, before it is recorded. `restaged`
   * is told of each key that gained a hidden place: its bytes are staged again here, as a `set` of
   * its value under the new verdict; the marks are the frame's. Then each write the frame KEPT
   * (`kept`) gets the verdict its kept form is taken under.
   */
  followAtCommit(
    restaged: (root: string, at: string[], verdict: RedactionVerdict) => void,
    kept?: Iterable<KeptWrite>,
  ): void {
    const written = this.written;
    this.written = undefined;
    const selected = this.selected;
    const active = this.rule();
    if (selected === undefined || active === undefined) return;
    for (const { root, at, shown } of written?.values() ?? []) {
      const before = active.verdictAt([], root);
      const value = this.record.peek(at);
      const base = this.record.baseAt(at);
      const after = inheritByIdentity(active, before, selected, [], root, value, { base, shown, sameAsBefore });
      if (sameVerdict(before, after)) continue;
      this.record.write(at, value, 'set', scrubOf(after));
      restaged(root, at, after);
    }
    if (kept !== undefined) for (const one of kept) this.keep(active, selected, written, one);
  }

  /** Give one kept write the verdict it is retained under, as its value stands now (file header, why). */
  private keep(
    active: RedactionRule,
    selected: SelectedObjects,
    written: Map<string, WrittenKey> | undefined,
    one: KeptWrite,
  ): void {
    if (one.operation === 'delete' || one.value === null || typeof one.value !== 'object') return;
    const named = active.verdictAt(one.path, one.key);
    const nsPath = this.record.at(one.path, one.key);
    // What the record holds at that path: the search above has seen it, and its key's rule says the rest.
    if (named.kind === 'whole' || this.record.peek(nsPath) === one.value) {
      one.verdict = named;
      return;
    }
    const shown = written?.get(nsPath.slice(0, nsPath.length - one.path.length).join(SEGMENT))?.shown;
    const search = { named: namedBy(named), shown };
    const found = selected.findPlanted(one.value, this.record.baseAt(nsPath), search, sameAsBefore);
    one.verdict = keptUnder(named, found, userKeyOf(one.path, one.key));
  }

  /** A try was thrown away: what it wrote was never written. What it READ stays (`StageContext · discardStaged`, why). */
  discard(): void {
    this.written = undefined;
  }

  /** The record of the top key a write at `nsPath` lands in. */
  private keyOf(nsPath: string[], path: readonly string[], key: string): WrittenKey {
    const at = nsPath.slice(0, nsPath.length - path.length);
    const id = at.join(SEGMENT);
    let wrote = this.written?.get(id);
    if (wrote === undefined) (this.written ??= new Map()).set(id, (wrote = { root: path[0] ?? key, at }));
    return wrote;
  }

  /**
   * What the frame's view holds at `at` now, for the search of a write: a part of the new value that is
   * the same object there is not new, and is not searched again. With one exception: the SAME object
   * written back. A stage does that after changing it in place, so nothing of it can be passed over.
   */
  private heldNow(at: string[], value: unknown): unknown {
    const now = this.record.peek(at);
    return now === value ? undefined : now;
  }

  /** The stage's first hidden read: note what each key written before it shows. Nothing is remembered yet, so nothing in them is hidden. */
  private noteWhatWasWritten(selected: SelectedObjects): void {
    const active = this.rule();
    if (active === undefined || this.written === undefined) return;
    for (const wrote of this.written.values()) {
      const named = namedBy(active.verdictAt([], wrote.root));
      selected.noteShown(this.record.peek(wrote.at), undefined, { named, shown: (wrote.shown ??= new ShownObjects()) });
    }
  }
}
