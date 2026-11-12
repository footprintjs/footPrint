/**
 * selectedObjects.ts — the objects a stage read under a hidden name, and where it puts them.
 *
 * Redaction selects by NAME (`docs/guides/scope.md`, "The one law"). A value copied under another name
 * is selected by that other name only. There is one case a library can keep without guessing: the
 * SAME OBJECT. An object a stage read under a hidden name is still that object when the stage writes
 * it somewhere else, so it keeps its rule there.
 *
 * WHY THIS FILE EXISTS. Before it, that held for exactly one shape: the whole value of a hidden key
 * written as the whole value of a top key (`scope.copy = scope.secret`). Every other way of passing
 * the object on went into the commit log in the clear:
 *
 *   - an object INSIDE the hidden value: `scope.copy = scope.secret.inner`, an element of a hidden
 *     list, a record below a hidden field;
 *   - the object put INSIDE another value: `scope.a.b = scope.secret`,
 *     `scope.box = { p: scope.secret }`, `scope.list.push(scope.secret)`, `$update('a', { b: … })`.
 *
 * So this file keeps two things for one stage:
 *
 *   1. REMEMBER. A value read under a hidden name is remembered together with every object inside
 *      it, each with the rule its place gives it: hidden whole, or the fields below it that are.
 *   2. FIND. A value about to be written is searched for remembered objects, and each one found is
 *      reported with the path it sits at. The caller hides those paths under the key being written.
 *
 * WHY ONLY WHAT IS NEW IS SEARCHED. A write through the typed scope hands the frame the whole next
 * value of a key: a list with one more item is the whole list. Searching all of it at every write
 * costs the square of the list. A part that is the SAME OBJECT as in the value it replaces was there
 * before this write, so this write did not put it there: it is skipped. What is left is the copied
 * path down to the change and the new value itself. Two cases are searched whole all the same: the
 * same object written back (a stage does that after changing it in place), and a container that was
 * compared at one place and turns up at a second one, where everything in it is new.
 *
 * WHY EVERY WRITTEN KEY IS SEARCHED ONCE MORE AT COMMIT (`StageContext · followLateEdits`). The record
 * takes a value as it stands when the stage commits, not when it was written: `s.box = o; o.p =
 * s.secret` records `p`, and no write ever showed it. So each key a stage wrote is searched again
 * then, against the committed value the stage started from. That second search follows only an object
 * that came from committed state. An object the stage itself put under a hidden name in this same
 * stage (`s.public = h; s.hidden = h`) is one object at two places of the stage's own making: it is
 * followed in what the stage writes after reading it back, never back in time to where it already sat.
 *
 * WHY A LIST IS HIDDEN WHOLE. A hidden object found in a list has an index today and another one
 * after the next `unshift`. A rule by index would then hide the wrong item. So the list is hidden: in
 * a list of lists, the outermost one. The same holds for a `Map` and a `Set`, whose entries a path
 * cannot name, and for an `Error` that carries one as its cause.
 *
 * HOW LONG A PLACE STAYS HIDDEN. Until its top key is deleted (`markPlaces.ts`), like every rule the
 * library keeps by name. Taking the hidden object out again does not end it: `a.b` stays hidden after
 * `a.b = 'plain'` and after `delete a.b`, and a list stays hidden after its hidden item is removed.
 * The library knows that a hidden object went in. It does not prove that all of it came out.
 *
 * WHY THE SECOND PLACE OF ONE CONTAINER IS HIDDEN WHOLE. A new object can sit at two places of the
 * value a stage writes (`{ first: part, second: part }`). It is searched once. At the second place it
 * is known to hold a hidden object, and where exactly is not worth a second walk: with enough shared
 * parts the number of paths doubles at every level.
 *
 * WHAT IS NOT FOLLOWED, and cannot be: a text or a number has no identity, so a copy of one is hidden
 * by its own name only (`{ ...scope.profile }` copies the profile's texts). Nor is a copy made by the
 * stage's own code (`structuredClone`, a JSON round trip): it is a new value. An object carried from
 * one stage to the next in a closure is outside this stage's memory. And what a recorder is handed at
 * a write is the value as it stood then: a recorder that keeps the reference sees what the stage puts
 * into it later (the borrowed-reference rule of every event). One more, narrow: an object the stage
 * itself wrote under a hidden name in this stage, read back, and then put IN PLACE into a value it had
 * already written. Write that value again and it is found.
 *
 * WHAT IT COSTS (`bench/hidden-object-writes.ts`, 12 Nov 2026, lists of 10,000 records, read tracking
 * off). Nothing for a stage that read nothing hidden. After a hidden read, each write through the
 * typed scope pays one comparison for each item of the list it writes: 10,000 pushes went from 68 to
 * 142 ms, one field set on each of 10,000 records from 83 to 246 ms. Remembering a hidden list of
 * 10,000 records at its first read did not show above the noise. The list traps know exactly what they
 * put in; if this ever matters, they can say so and the comparison goes away.
 *
 * The idea is plain taint tracking by object identity, kept for one stage. No outside source.
 *
 * A leaf: it imports nothing. The frame owns one for each stage (`StageContext`), and the write
 * decision asks it (`redaction.ts · inheritByIdentity`).
 */

/**
 * The rule a remembered object carries: hidden whole, or the dot-paths inside it that are. `key` is
 * the name that decided it. (The two hiding arms of `redaction.ts · RedactionVerdict`, spelled here
 * so that this file stays a leaf.)
 */
export type SelectedRule =
  | { readonly kind: 'whole'; readonly key: string }
  | { readonly kind: 'fields'; readonly key: string; readonly paths: readonly string[] };

/**
 * A remembered object found in a value about to be written. `path` is where to hide, inside that
 * value. `whole` says to hide everything at `path`: the object sits in a list, a `Map` or a `Set`
 * there, or is hidden whole itself. Otherwise `rule.paths` are the fields to hide below `path`.
 */
export interface FoundSelected {
  readonly path: readonly string[];
  readonly rule: SelectedRule;
  readonly whole: boolean;
}

/** The rule of the member under `key` of an object with `rule`, or `undefined` when nothing in it is hidden. */
function ruleOfMember(rule: SelectedRule, key: string): SelectedRule | undefined {
  if (rule.kind === 'whole') return rule;
  const below: string[] = [];
  for (const path of rule.paths) {
    if (path === key) return { kind: 'whole', key: rule.key };
    if (path.startsWith(`${key}.`)) below.push(path.slice(key.length + 1));
  }
  return below.length > 0 ? { kind: 'fields', key: rule.key, paths: below } : undefined;
}

/**
 * What a container holds when a path cannot name its entries: a `Map` (keys and values), a `Set`, an
 * `Error` (its cause, its `errors`, its own fields: a copy of the record keeps all three). `undefined`
 * for a list and for any other object. Bytes hold no objects, so a buffer or a view holds nothing.
 */
function entriesOf(node: object): unknown[] | undefined {
  if (node instanceof Map) return [...node.keys(), ...node.values()];
  if (node instanceof Set) return [...node];
  if (node instanceof Error) return [node.cause, (node as { errors?: unknown }).errors, ...Object.values(node)];
  if (ArrayBuffer.isView(node) || node instanceof ArrayBuffer) return [];
  return undefined;
}

/** The own value under `key` of a plain object, never an inherited one. */
function ownMember(node: unknown, key: string): unknown {
  if (!isObject(node) || Array.isArray(node)) return undefined;
  return Object.prototype.hasOwnProperty.call(node, key) ? (node as Record<string, unknown>)[key] : undefined;
}

export class SelectedObjects {
  private readonly rules = new WeakMap<object, SelectedRule>();
  /** The remembered objects that came from COMMITTED state: read under a hidden name the stage had not written. */
  private readonly committed = new WeakSet<object>();

  /** The rule `value` carries, when the stage read it under a hidden name (or inside such a value). */
  get(value: object): SelectedRule | undefined {
    return this.rules.get(value);
  }

  /**
   * `handed` stands in for `value` (a view handed to user code in its place): it carries the same rule.
   * The view alone: its members are read on demand, and reading them here would count as reads.
   */
  sameRuleFor(handed: object, value: object): void {
    const rule = this.rules.get(value);
    if (rule !== undefined) this.rules.set(handed, rule);
  }

  /**
   * `copy` is a full copy the scope itself made of `value` (`$batchArray` hands a stage one): the copy
   * and every object inside it carry what `value` carries.
   */
  copyOf(copy: object, value: object): void {
    const rule = this.rules.get(value);
    if (rule !== undefined) this.remember(copy, rule, this.committed.has(value));
  }

  /**
   * Remember `value`, read under a hidden name, and every object inside it. Once for each object: a
   * second read of the same value costs one lookup. No recursion, so a long chain cannot overflow.
   *
   * `fromCommitted` says the value was read from committed state: the stage had not written that hidden
   * key itself. Only such an object is followed back in time, by the search at commit ({@link findIn}).
   *
   * ```ts
   * selected.remember(profile, { kind: 'fields', key: 'profile', paths: ['contact.email'] });
   * selected.get(profile.contact); // { kind: 'fields', key: 'profile', paths: ['email'] }
   * ```
   */
  remember(value: object, rule: SelectedRule, fromCommitted = false): void {
    // The common call: the same value read again. One lookup, nothing allocated.
    if (widest(this.rules.get(value), rule) === undefined) return;
    const todo: [object, SelectedRule][] = [[value, rule]];
    for (let next = todo.pop(); next !== undefined; next = todo.pop()) {
      const [node, asked] = next;
      const its = widest(this.rules.get(node), asked);
      if (its === undefined) continue; // known already, with nothing to add
      this.rules.set(node, its);
      if (fromCommitted) this.committed.add(node);
      const entries = entriesOf(node);
      if (entries !== undefined) {
        // A path cannot name an entry, so only a container hidden whole hides its entries.
        if (its.kind === 'whole') for (const entry of entries) pushObject(todo, entry, its);
      } else if (Array.isArray(node)) {
        for (let i = 0; i < node.length; i++) pushObject(todo, node[i], ruleOfMember(its, String(i)));
      } else {
        for (const key of Object.keys(node)) {
          pushObject(todo, (node as Record<string, unknown>)[key], ruleOfMember(its, key));
        }
      }
    }
  }

  /**
   * The remembered objects in `value`, a value about to be written over `base` (what the key holds
   * now, or what a merge adds to). A part that is the same object as in `base` is not searched: it
   * was there before this write. Empty when the value is, or holds, no remembered object.
   *
   * `late` is the search at commit: only an object that came from committed state counts (see
   * {@link remember}), and any other is searched like a plain container.
   *
   * ```ts
   * selected.findIn({ x: 1, b: secret }, { x: 1 }); // [{ path: ['b'], rule: …, whole: true }]
   * selected.findIn([...list, secret], list);       // [{ path: [], rule: …, whole: true }]  the list
   * ```
   */
  findIn(value: unknown, base: unknown, late = false): FoundSelected[] {
    const found: FoundSelected[] = [];
    const entered = new Map<object, Entered>();
    /** Report one place, and tell every container above it that it holds a remembered object. */
    const report = (rule: SelectedRule, at: Place, whole: boolean): void => {
      found.push({ path: at.list ?? at.path, rule, whole: whole || at.list !== undefined || rule.kind === 'whole' });
      for (let up = at.above; up !== undefined && up.holds === undefined; up = up.above) up.holds = rule;
    };
    const todo: [unknown, unknown, Place][] = [[value, base, { path: [] }]];
    for (let next = todo.pop(); next !== undefined; next = todo.pop()) {
      const [node, was, at] = next;
      // The same object as before at this place, or the key's whole old value at ANY place (a stage
      // that nests the old value under the new one, `history = { prev: history }`): not new.
      if (!isObject(node) || node === was || node === base) continue;
      const rule = late && !this.committed.has(node) ? undefined : this.rules.get(node);
      if (rule !== undefined) {
        // A list whose fields are named by index (`0.ssn`): handed on, an index would hide the wrong
        // item after the next `unshift`. So such a list goes whole, like a list that holds one.
        const list = rule.kind === 'fields' && Array.isArray(node) && rule.paths.some(namesAnIndex);
        report(rule, at, list);
        // Hidden whole, or in a list (which goes whole): nothing inside can add to that. Hidden by its
        // fields: the rest of it may hold another remembered object, so it is searched like any other.
        if (rule.kind === 'whole' || list || at.list !== undefined) continue;
      }
      let old = was;
      const before = entered.get(node);
      if (before !== undefined) {
        // The same container at a second place. A search that saw every part of it answers for this
        // place too: what it holds is here as well, and where exactly is not worth a second walk, so
        // this place is hidden whole. A search that compared it against an old value passed over parts
        // that may be new HERE: it is searched once more, whole.
        if (before.whole) {
          if (before.holds !== undefined) report(before.holds, at, true);
          continue;
        }
        old = undefined;
      }
      const here: Entered = { above: at.above, whole: old === undefined };
      entered.set(node, here);
      const entries = entriesOf(node);
      if (entries !== undefined || Array.isArray(node)) {
        // A list is walked in step with the one it replaces. A Map, a Set and an Error are small and
        // rare in state: what they hold is searched whole.
        const inside: Place = { path: at.path, list: at.list ?? at.path, above: here };
        if (entries !== undefined) for (const entry of entries) todo.push([entry, undefined, inside]);
        else for (const [item, its] of newItems(node as unknown[], old)) todo.push([item, its, inside]);
      } else {
        for (const key of Object.keys(node)) {
          const member = (node as Record<string, unknown>)[key];
          if (isObject(member)) {
            todo.push([member, ownMember(old, key), { path: [...at.path, key], list: at.list, above: here }]);
          }
        }
      }
    }
    return found;
  }
}

/** Where the search stands: the path below the written value, the OUTERMOST list (Map, Set, Error) above it when there is one, and the container it came through. */
interface Place {
  readonly path: readonly string[];
  readonly list?: readonly string[];
  readonly above?: Entered;
}

/** What one search knows of a container it entered. */
interface Entered {
  /** The container it was reached through. */
  readonly above?: Entered;
  /** Every part of it was searched (it was not compared against an old value). */
  readonly whole: boolean;
  /** A remembered object was found inside: its rule. Set on every container above a find. */
  holds?: SelectedRule;
}

function pushObject(todo: [object, SelectedRule][], value: unknown, rule: SelectedRule | undefined): void {
  if (rule !== undefined && isObject(value)) todo.push([value, rule]);
}

/**
 * What to remember for an object that may be known already: `undefined` when `asked` adds nothing.
 * Hidden whole is the widest rule. Two field rules add up.
 */
function widest(known: SelectedRule | undefined, asked: SelectedRule): SelectedRule | undefined {
  if (known === undefined) return asked;
  if (known.kind === 'whole') return undefined;
  if (asked.kind === 'whole') return asked;
  const more = asked.paths.filter((path) => !known.paths.includes(path));
  return more.length > 0 ? { kind: 'fields', key: known.key, paths: [...known.paths, ...more] } : undefined;
}

/**
 * The object items of `list` that are not items of the list it replaces, each with the item it took
 * the place of (when it took one: a changed record is a copy that shares most of the old one).
 *
 * Walked in step with the old list, so the common writes cost one comparison for each item: an item
 * added at the end or at the front, one item replaced, put in or taken out. Anything else (a sort, a
 * reverse) falls back to a set of the old items, built once. An item is passed over ONLY when it is
 * the same object as an item of the old list. So the stepping decides the cost, never the answer,
 * as long as an old item is what it was: an item the stage changed in place is caught by the search
 * at commit, which compares against committed state.
 */
function newItems(list: readonly unknown[], was: unknown): [unknown, unknown][] {
  const fresh: [unknown, unknown][] = [];
  if (!Array.isArray(was)) {
    for (const item of list) if (isObject(item)) fresh.push([item, undefined]);
    return fresh;
  }
  let old = 0;
  let lookup: Set<unknown> | undefined;
  for (let i = 0; i < list.length; i++) {
    const item = list[i];
    if (lookup !== undefined) {
      if (isObject(item) && !lookup.has(item)) fresh.push([item, undefined]);
    } else if (was[old] === item) old++;
    else if (!isObject(item)) continue;
    else if (old >= was.length) fresh.push([item, undefined]);
    else if (list[i + 1] === was[old + 1]) fresh.push([item, was[old++]]); // replaced
    else if (list[i + 1] === was[old]) fresh.push([item, undefined]); // put in
    else if (was[old + 1] === item) old += 2; // the one before it was taken out
    else {
      lookup = new Set(was);
      if (!lookup.has(item)) fresh.push([item, undefined]);
    }
  }
  return fresh;
}

/** Does a field path start at an item of a list, named by its index (`0.ssn`, `12`)? */
function namesAnIndex(path: string): boolean {
  return /^\d+(\.|$)/.test(path);
}

function isObject(value: unknown): value is object {
  return value !== null && typeof value === 'object';
}
