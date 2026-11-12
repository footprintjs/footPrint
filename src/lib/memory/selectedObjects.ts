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
 *      (Read from state by any door, or taken from the stage's input: `StageContext · noteInputRead`.)
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
 * WHY EVERY WRITTEN KEY IS SEARCHED ONCE MORE AT COMMIT (`hiddenObjectTrail.ts`). The record takes a
 * value as it stands when the stage commits, not when it was written: `s.box = o; o.p = s.secret`
 * records `p`, and no write ever showed it. So each key a stage wrote is searched again then, against
 * the committed value the stage started from. That search has one job: to find a hidden object the
 * stage put in AFTER the write. So it passes over three things, each for its own reason:
 *
 *   - a place its own name hides already (`named`): nothing can be added there;
 *   - an object that sat at a public place of that key when the stage wrote it, and was not hidden
 *     then (`shown`): `s.public = h; s.hidden = h` is one object at two places of the stage's own
 *     making. The write judged it by what was known then, and the search at commit does not go back
 *     in time. Put anywhere else after it was read back, it is found;
 *   - a place that holds what the committed state held there when the stage began (`same`): a read
 *     after the stage's first write hands out a private copy, so the object is new and its content is
 *     not. Nothing shows there that did not show before.
 *
 * WHY A PLACE CARRIES WHAT ITS NAME HIDES (`named`). The search walks a value together with the rule
 * its key has by name (the policy's fields, and the fields earlier writes handed it). Below a place
 * hidden whole nothing is searched. A remembered object is reported only where it adds to what the
 * name hides already, so a record written back to its own key reports nothing, and a second search of
 * the same value reports nothing new. And only an object at a place where the name hides nothing, at
 * it or below it, counts as shown.
 *
 * WHY THE KEY'S OWN OLD VALUE IS NOT WALKED WHEN IT MOVES (`history = { prev: history }`). It would
 * be walked again at every write, and the cost would be the square of the chain. What it hides is
 * known without a walk: what the key's name hides in it. And the place it moved to is hidden WHOLE,
 * not field by field: it moves one step down again at the next write, and a field path that follows
 * it would grow by one at every step, in every record of the key. (The same reason as for a list.)
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
 * one stage to the next in a closure is outside this stage's memory.
 *
 * WHAT A RECORDER MAY STILL SEE. The record is searched at commit; an event is made at its write. So
 * what a recorder is handed at a write is the value as it stood then, and a recorder that keeps the
 * reference sees what the stage puts into it later (the borrowed-reference rule of every event; a
 * narrative entry's `rawValue` is such a reference). One more case follows from searching only what
 * is new: a stage that changes a written object in place and then writes the same key again, with
 * that object still at its place, is not searched there at that second write. Its event shows the
 * object as it stands. The commit search finds it, so the record does not show it, and neither does
 * what the stage keeps of its writes for the execution tree (`hiddenObjectTrail.ts · keep`).
 *
 * WHY A VALUE THAT HOLDS ITSELF IS HIDDEN WHOLE (`w.self = w`). A field is hidden by writing over it
 * in a copy of the value, and the edge back still leads to the value the copy was made of. So a
 * hidden object inside such a container cannot be hidden as a field: the container's place is hidden
 * whole. What this file does NOT cover is a field the POLICY names inside such a value, with no hidden
 * object in it: that scrub is the record's (foottrace), and it shows the field through the edge today.
 *
 * WHAT IT COSTS (`bench/hidden-object-writes.ts`, 12 Nov 2026, lists of 10,000 records, read tracking
 * off). Nothing for a stage that read nothing hidden. After a hidden read, each write through the
 * typed scope pays one comparison for each item of the list it writes: 10,000 pushes went from 72 to
 * 156 ms, one field set on each of 10,000 records from 91 to 286 ms. A whole new list of 10,000
 * records, assigned 100 times, went from 103 to 259 ms: every record in it is new, so each is looked
 * at and noted. A key that nests its old value 1,000 times costs what it did (50 ms). Remembering a
 * hidden list of 10,000 records at its first read did not show above the noise. The list traps know
 * exactly what they put in; if this ever matters, they can say so and the comparison goes away.
 *
 * The idea is plain taint tracking by object identity, kept for one stage. No outside source.
 *
 * A leaf: it imports nothing. The frame owns one for each stage (`hiddenObjectTrail.ts`), and the
 * write decision asks it (`redaction.ts · inheritByIdentity`).
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
 * A remembered object found in a searched value. `path` is where to hide, inside that value. `whole`
 * says to hide everything at `path`: the object sits in a list, a `Map` or a `Set` there, or is
 * hidden whole itself. Otherwise `rule.paths` are the fields to hide below `path`.
 */
export interface FoundSelected {
  readonly path: readonly string[];
  readonly rule: SelectedRule;
  readonly whole: boolean;
}

/** What a search knows of the key it searches (file header, why each). */
export interface Search {
  /** What the NAME of the searched place hides in its value already: the key's own fields. */
  readonly named?: SelectedRule;
  /**
   * The objects that sat at a public place of this key when the stage wrote it, and were not hidden
   * then. A search at a write adds to it; the search at commit passes them over.
   */
  readonly shown?: ShownObjects;
  /** The value is a merge patch: a list in it is added to the one there, so its indexes name no place. */
  readonly patch?: boolean;
  /** The value is the key's whole new value (a `set` of the key itself, not of a path below it). */
  readonly replaces?: boolean;
}

/** What one key showed when the stage wrote it ({@link Search.shown}; file header, why it is kept). */
export class ShownObjects {
  private objects = new WeakSet<object>();

  has(value: object): boolean {
    return this.objects.has(value);
  }

  /** `more` showed too. */
  add(more: readonly object[]): void {
    for (const one of more) this.objects.add(one);
  }

  /**
   * The key's whole value was replaced and nothing of the old one was kept: `all` is what it shows now.
   * WHY not `add`: a weak set that only grows, while most of what it holds is garbage, slows every
   * collection (`bench/hidden-object-writes.ts`, a whole list assigned 100 times: 590 ms against 230).
   */
  replace(all: readonly object[]): void {
    this.objects = new WeakSet(all);
  }
}

/** Do two objects hold the same content? Asked by the search at commit, of an object and the committed one at its place. */
export type SameContent = (now: object, before: object) => boolean;

/**
 * What a list of field paths says, read ONCE and kept for the list: the rule of each member a path
 * starts with, and the paths as a set. WHY: a rule is asked once for every member of the value it is
 * walked with, and scanning all its paths each time made a record with N hidden places cost N × N
 * (20,000 records with one hidden field each: 2.6 s to remember, against 30 ms for 2,000; found by
 * the second reader). Read once, the cost is the number of paths.
 *
 * WHY IT IS KEPT FOR THE LIST WHEN THE LIST IS FROZEN: a key's verdict is a new rule object every
 * time it is asked for, over the same list (`RedactionRule · verdictOfKey`), and every stage makes a
 * new rule for the input over the one list `servedPlaces.ts` keeps. Kept for the rule object only, a
 * key with 8,000 hidden fields was read again at every write of it. The key is kept beside it,
 * because the rules of the members carry it: the same list under another key is read again.
 *
 * WHY ONLY THEN: what is kept must not outlive a change of the list. A frozen list cannot change, and
 * every list the library makes for a rule is frozen (`RedactionRule · inheritFields`, the fields a key
 * took; `servedPlaces.ts`, the places of an input). A policy's own `fields` entry is the caller's
 * list. A caller may add a field to it between two runs, and the next run must see that. So for a
 * list that can change, the reading is kept for the rule object: that lives for one search, or for
 * one stage when an object is remembered under it.
 */
interface ReadOnce {
  /** The key of the rule the list was read for. */
  readonly key: string;
  readonly members: ReadonlyMap<string, SelectedRule>;
  /** The paths as a set, made when first asked for: most rules are only asked for their members. */
  paths(): ReadonlySet<string>;
}

/** By the list of paths when it is frozen, else by the rule object. */
const readOnce = new WeakMap<object, ReadOnce>();

function read(rule: Extract<SelectedRule, { kind: 'fields' }>): ReadOnce {
  const at: object = Object.isFrozen(rule.paths) ? rule.paths : rule;
  const known = readOnce.get(at);
  if (known !== undefined && known.key === rule.key) return known;
  /** For each first key: the paths below it, or `null` when a path names the member itself (all of it). */
  const below = new Map<string, string[] | null>();
  for (const path of rule.paths) {
    const dot = path.indexOf('.');
    if (dot < 0) below.set(path, null);
    else {
      const first = path.slice(0, dot);
      const rest = below.get(first);
      if (rest === undefined) below.set(first, [path.slice(dot + 1)]);
      else rest?.push(path.slice(dot + 1));
    }
  }
  const members = new Map<string, SelectedRule>();
  for (const [first, rest] of below) {
    members.set(
      first,
      rest === null ? { kind: 'whole', key: rule.key } : { kind: 'fields', key: rule.key, paths: rest },
    );
  }
  let set: Set<string> | undefined;
  const once: ReadOnce = { key: rule.key, members, paths: () => (set ??= new Set(rule.paths)) };
  readOnce.set(at, once);
  return once;
}

/** The rule of the member under `key` of an object with `rule`, or `undefined` when nothing in it is hidden. */
function ruleOfMember(rule: SelectedRule, key: string): SelectedRule | undefined {
  if (rule.kind === 'whole') return rule;
  if (!key.includes('.')) return read(rule).members.get(key);
  // A key with a dot in it is no first part of a path: a path names it as it is spelled (rare, so scanned).
  const below: string[] = [];
  for (const path of rule.paths) {
    if (path === key) return { kind: 'whole', key: rule.key };
    if (path.startsWith(`${key}.`)) below.push(path.slice(key.length + 1));
  }
  return below.length > 0 ? { kind: 'fields', key: rule.key, paths: below } : undefined;
}

/**
 * The name of a place a path cannot spell: an entry of a `Map`, a `Set` or an `Error`, or an item of a
 * list in a merge patch (its index there is not its index in the list it is added to), below a place
 * whose name hides something. What the name hides THERE is not known, so it counts as neither hidden
 * already nor public. Everything below such a place is the same.
 */
const UNNAMED: SelectedRule = Object.freeze({ kind: 'fields', key: '', paths: Object.freeze([]) as readonly string[] });

/** What the name of the place under `key` hides, given what the name of the place above it hides. */
function nameBelow(named: SelectedRule | undefined, key: string): SelectedRule | undefined {
  return named === undefined || named === UNNAMED ? named : ruleOfMember(named, key);
}

/**
 * Does `value` hold something at one of the places `named` hides? A path is read as the record reads
 * it: as one key with dots in it, or as keys from the top down.
 */
function holdsAny(value: object, named: SelectedRule): boolean {
  if (named.kind === 'whole') return true;
  return named.paths.some((path) => {
    if (ownMember(value, path) !== undefined) return true;
    let at: unknown = value;
    for (const key of path.split('.')) {
      at = Array.isArray(at) ? at[Number(key)] : ownMember(at, key);
      if (at === undefined) return false;
    }
    return true;
  });
}

/** Does the name of a place hide there everything `rule` hides? Then a remembered object adds nothing to it. */
function covers(named: SelectedRule | undefined, rule: SelectedRule): boolean {
  if (named === undefined || rule.kind === 'whole') return false;
  if (named.kind === 'whole') return true;
  const known = read(named).paths();
  return rule.paths.every((path) => {
    // Hidden by name when the path, or a path above it, is one the name hides.
    if (known.has(path)) return true;
    for (let dot = path.indexOf('.'); dot >= 0; dot = path.indexOf('.', dot + 1)) {
      if (known.has(path.slice(0, dot))) return true;
    }
    return false;
  });
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
    if (rule !== undefined) this.remember(copy, rule);
  }

  /**
   * Remember `value`, read under a hidden name, and every object inside it. Once for each object: a
   * second read of the same value costs one lookup. No recursion, so a long chain cannot overflow.
   *
   * ```ts
   * selected.remember(profile, { kind: 'fields', key: 'profile', paths: ['contact.email'] });
   * selected.get(profile.contact); // { kind: 'fields', key: 'profile', paths: ['email'] }
   * ```
   */
  remember(value: object, rule: SelectedRule): void {
    // The common call: the same value read again. One lookup, nothing allocated.
    if (widest(this.rules.get(value), rule) === undefined) return;
    const todo: [object, SelectedRule][] = [[value, rule]];
    for (let next = todo.pop(); next !== undefined; next = todo.pop()) {
      const [node, asked] = next;
      const its = widest(this.rules.get(node), asked);
      if (its === undefined) continue; // known already, with nothing to add
      this.rules.set(node, its);
      const entries = entriesOf(node);
      if (entries !== undefined) {
        // A path cannot name an entry, so only a container hidden whole hides its entries.
        if (its.kind === 'whole') for (const entry of entries) pushObject(todo, entry, its);
      } else if (Array.isArray(node)) {
        // Hidden whole: every item. By fields: only the items a path names by index, however long the list.
        if (its.kind === 'whole') for (const item of node) pushObject(todo, item, its);
        else
          for (const [first, rule] of read(its).members)
            if (isIndex(first)) pushObject(todo, node[Number(first)], rule);
      } else {
        for (const key of Object.keys(node)) {
          pushObject(todo, (node as Record<string, unknown>)[key], ruleOfMember(its, key));
        }
      }
    }
  }

  /**
   * AT A WRITE: the remembered objects in `value`, about to be written over `base` (what the key holds
   * now, or what a merge adds to). A part that is the same object as in `base` is not searched: it
   * was there before this write. Empty when the value is, or holds, no remembered object that adds to
   * what the key's name hides already. Every other new object at a public place is added to
   * `search.shown`.
   *
   * ```ts
   * selected.findIn({ x: 1, b: secret }, { x: 1 }); // [{ path: ['b'], rule: …, whole: true }]
   * selected.findIn([...list, secret], list);       // [{ path: [], rule: …, whole: true }]  the list
   * ```
   */
  findIn(value: unknown, base: unknown, search: Search = {}): FoundSelected[] {
    return this.walk(value, base, search, false, undefined);
  }

  /**
   * What `value` shows, with nothing reported: every object in it that is new against `base`, sits at
   * a public place and is not remembered goes into `search.shown`. For a value the stage wrote that no
   * search at a write walked: a key written before the stage's first hidden read, and the containers a
   * merge makes (the record builds them; the patch that was searched is not what the key then holds).
   */
  noteShown(value: unknown, base: unknown, search: Search): void {
    this.walk(value, base, search, true, undefined);
  }

  /**
   * AT COMMIT: the remembered objects the stage put into `value` after it wrote it. `base` is the
   * committed value the stage started from. Passed over: what `search.shown` holds, and an object
   * that `same` says holds what the committed one at its place held (file header, why).
   */
  findPlanted(value: unknown, base: unknown, search: Search, same: SameContent): FoundSelected[] {
    return this.walk(value, base, search, false, same);
  }

  /** The one walk behind the three searches. `quiet` reports nothing; `same` makes it the search at commit. */
  private walk(
    value: unknown,
    base: unknown,
    { named, shown, patch, replaces }: Search,
    quiet: boolean,
    same: SameContent | undefined,
  ): FoundSelected[] {
    const found: FoundSelected[] = [];
    /** What this value shows, for `shown`. Not asked at commit: nothing is written then. */
    const noted: object[] | undefined = shown !== undefined && same === undefined ? [] : undefined;
    /** Was a part of the old value passed over? Then the old `shown` still counts. */
    let kept = false;
    const entered = new Map<object, Entered>();
    /** Report one place to hide. */
    const hide = (rule: SelectedRule, at: Place, whole: boolean): void => {
      if (quiet) return;
      found.push({ path: pathOf(at.list ?? at), rule, whole: whole || at.list !== undefined || rule.kind === 'whole' });
    };
    /** Tell every container above a place that it holds a remembered object. */
    const holds = (rule: SelectedRule, at: Place): void => {
      for (let up = at.within; up !== undefined && up.holds === undefined; up = up.above) up.holds = rule;
    };
    /** The containers that hold themselves (file header, why they matter). Rare, so made when one turns up. */
    let loops: Set<Entered> | undefined;
    const todo: [unknown, unknown, Place][] = [[value, base, { named }]];
    for (let next = todo.pop(); next !== undefined; next = todo.pop()) {
      const [node, was, at] = next;
      if (node === CLOSED) {
        (was as Entered).open = false; // everything inside this container has been searched
        continue;
      }
      // The same object as before at this place is not new. A place its own name hides whole needs no search.
      if (!isObject(node) || at.named?.kind === 'whole') continue;
      if (node === was || (node === base && at.up !== undefined)) kept = true;
      if (node === was) continue;
      if (node === base && at.up !== undefined) {
        // The key's own old value, moved below the new one. Not walked: what it hides is what the
        // key's name hides in it, and then the place it moved to is hidden whole (file header, why).
        if (named !== undefined && holdsAny(node, named)) {
          hide(named, at, true);
          holds(named, at);
        }
        continue;
      }
      let rule = this.rules.get(node);
      // At commit: an object the stage itself wrote here before it was hidden stays as its name has it.
      if (rule !== undefined && same !== undefined && shown?.has(node)) rule = undefined;
      const its = at.named;
      if (rule === undefined) {
        if (its === undefined) noted?.push(node);
      } else if (covers(its, rule)) {
        holds(rule, at); // nothing to add here; a second place of a container above may differ
      } else {
        // At commit: what the committed state held at this place. Nothing new shows, and nothing is in it.
        if (same !== undefined && isObject(was) && same(node, was)) continue;
        // A list whose fields are named by index (`0.ssn`): handed on, an index would hide the wrong
        // item after the next `unshift`. So such a list goes whole, like a list that holds one.
        const list = rule.kind === 'fields' && Array.isArray(node) && rule.paths.some(namesAnIndex);
        hide(rule, at, list);
        holds(rule, at);
        // Hidden whole, or in a list (which goes whole): nothing inside can add to that. Hidden by its
        // fields: the rest of it may hold another remembered object, so it is searched like any other.
        // (Its own fields are NOT taken as names below it: a list in it that is named by index must
        // still be found, and go whole, at this new place.)
        if (rule.kind === 'whole' || list || at.list !== undefined) continue;
      }
      let old = was;
      const before = entered.get(node);
      if (before?.open) {
        (loops ??= new Set()).add(before); // an edge back to a container the search is still inside: it holds itself
        continue;
      }
      if (before !== undefined) {
        // The same container at a second place. A search that saw every part of it answers for this
        // place too: what it holds is here as well, and where exactly is not worth a second walk, so
        // this place is hidden whole. A search that passed over parts of it (the same as in an old
        // value there, or hidden by the name of that place) says nothing of them HERE, and a place
        // whose own name hides a part needs no more than the rest: both are searched once more, whole.
        if (before.whole && its === undefined) {
          if (before.holds !== undefined) {
            hide(before.holds, at, true);
            holds(before.holds, at);
          }
          continue;
        }
        old = undefined;
      }
      // Searched whole only where nothing was passed over: no old value to compare against, and no
      // part that the name of THIS place hides (at a second place the name may hide nothing).
      const here: Entered = { above: at.within, at, whole: old === undefined && its === undefined, open: true };
      entered.set(node, here);
      const closes = todo.push([CLOSED, here, at]); // under its parts on the stack: reached once they are all done
      const entries = entriesOf(node);
      if (entries !== undefined) {
        // A Map, a Set and an Error are small and rare in state: what they hold is searched whole.
        const inside: Place = { up: at, list: at.list ?? at, within: here, named: its && UNNAMED };
        for (const entry of entries) todo.push([entry, undefined, inside]);
      } else if (Array.isArray(node)) {
        // A list is walked in step with the one it replaces. Its items share one place, unless the
        // name hides something below the list: then each item has a name of its own, by its index.
        const list = at.list ?? at;
        const inside: Place | undefined = its === undefined ? { up: at, list, within: here } : undefined;
        const fresh = newItems(node as unknown[], old);
        if (fresh.passedOver) kept = true;
        for (const [item, itsOld, index] of fresh.items) {
          const place = inside ?? {
            up: at,
            list,
            within: here,
            named: patch ? UNNAMED : nameBelow(its, String(index)),
          };
          // At commit an item that is no item of the old list by identity is compared with the committed
          // item at its index: a private copy of a list is new objects all through, in the same order.
          const partner = itsOld ?? (same !== undefined && Array.isArray(old) ? old[index] : undefined);
          todo.push([item, partner, place]);
        }
      } else {
        for (const key of Object.keys(node)) {
          const member = (node as Record<string, unknown>)[key];
          if (isObject(member)) {
            const place: Place = { up: at, key, list: at.list, within: here, named: nameBelow(its, key) };
            todo.push([member, ownMember(old, key), place]);
          }
        }
      }
      if (todo.length === closes) {
        todo.pop(); // no part of it is an object: nothing to wait for
        here.open = false;
      }
    }
    if (loops !== undefined) for (const one of loops) if (one.holds !== undefined) hide(one.holds, one.at, true);
    if (noted !== undefined && replaces && !kept) shown?.replace(noted);
    else if (noted !== undefined) shown?.add(noted);
    return found;
  }
}

/** On the search's stack below the parts of a container: its turn comes when they are all searched. */
const CLOSED = Symbol('closed');

/** Where the search stands. A chain, so that a path is spelled only for a place that is reported. */
interface Place {
  /** The place of the container it is in. None: the searched value itself. */
  readonly up?: Place;
  /** Its key in that container. None for an item or an entry: a rule cannot name one. */
  readonly key?: string;
  /** The place of the OUTERMOST list (Map, Set, Error) above it, when there is one. */
  readonly list?: Place;
  /** The container it was reached through. */
  readonly within?: Entered;
  /** What the name of this place hides here already. */
  readonly named?: SelectedRule;
}

/** The keys from the searched value down to `place`. */
function pathOf(place: Place): string[] {
  const path: string[] = [];
  for (let at = place; at.up !== undefined; at = at.up) path.push(at.key as string);
  return path.reverse();
}

/** What one search knows of a container it entered. */
interface Entered {
  /** The container it was reached through. */
  readonly above?: Entered;
  /** The place it was entered at. */
  readonly at: Place;
  /** The search is still inside it: meeting it again now means it holds itself. */
  open: boolean;
  /** Every part of it was searched: it was not compared against an old value, and its place's name hid no part of it. */
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
  // The same list adds nothing. WHY ask first: a key is read again at every member a stage looks up
  // through it, each time under a new rule object over the key's one list of fields, and comparing
  // the two lists each time made a lookup table of N hidden records cost N × N to read. (A policy
  // list its caller edits in place in the middle of a stage is read again by the next stage.)
  if (known.paths === asked.paths) return undefined;
  const have = read(known).paths();
  const more = asked.paths.filter((path) => !have.has(path));
  return more.length > 0 ? { kind: 'fields', key: known.key, paths: [...known.paths, ...more] } : undefined;
}

/**
 * The object items of `list` that are not items of the list it replaces, each with the item it took
 * the place of (when it took one: a changed record is a copy that shares most of the old one) and its
 * index.
 *
 * Walked in step with the old list, so the common writes cost one comparison for each item: an item
 * added at the end or at the front, one item replaced, put in or taken out. Anything else (a sort, a
 * reverse) falls back to a set of the old items, built once. An item is passed over ONLY when it is
 * the same object as an item of the old list. So the stepping decides the cost, never the answer,
 * as long as an old item is what it was: an item the stage changed in place is caught by the search
 * at commit, which compares against committed state.
 */
function newItems(list: readonly unknown[], was: unknown): NewItems {
  const items: NewItems['items'] = [];
  if (!Array.isArray(was)) {
    for (let i = 0; i < list.length; i++) if (isObject(list[i])) items.push([list[i], undefined, i]);
    return { items, passedOver: false };
  }
  let passedOver = false;
  let old = 0;
  let lookup: Set<unknown> | undefined;
  for (let i = 0; i < list.length; i++) {
    const item = list[i];
    if (lookup !== undefined) {
      if (!isObject(item)) continue;
      if (lookup.has(item)) passedOver = true;
      else items.push([item, undefined, i]);
    } else if (was[old] === item) {
      old++;
      passedOver ||= isObject(item);
    } else if (!isObject(item)) continue;
    else if (old >= was.length) items.push([item, undefined, i]);
    else if (list[i + 1] === was[old + 1]) items.push([item, was[old++], i]); // replaced
    else if (list[i + 1] === was[old]) items.push([item, undefined, i]); // put in
    else if (was[old + 1] === item) {
      old += 2; // the one before it was taken out
      passedOver = true;
    } else {
      lookup = new Set(was);
      if (lookup.has(item)) passedOver = true;
      else items.push([item, undefined, i]);
    }
  }
  return { items, passedOver };
}

/** What {@link newItems} found: the new object items, and whether an object item of the old list was passed over. */
interface NewItems {
  readonly items: [item: unknown, was: unknown, index: number][];
  readonly passedOver: boolean;
}

/** Is this first part of a path the index of a list item (`0`, `12`)? */
function isIndex(first: string): boolean {
  return /^\d+$/.test(first);
}

/** Does a field path start at an item of a list, named by its index (`0.ssn`, `12`)? */
function namesAnIndex(path: string): boolean {
  return /^\d+(\.|$)/.test(path);
}

function isObject(value: unknown): value is object {
  return value !== null && typeof value === 'object';
}
