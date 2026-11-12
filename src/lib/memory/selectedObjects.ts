/**
 * selectedObjects.ts — the objects a stage read under a hidden name, and where it puts them.
 *
 * Redaction selects by NAME (`docs/guides/scope.md`, "The one law"). A value copied under another name
 * is selected by that other name only. There is one case a library can keep without guessing: the
 * SAME OBJECT. An object a stage read under a hidden name is still that object when the stage writes
 * it somewhere else, so it keeps its rule there.
 *
 * WHY THIS FILE EXISTS. Until 12.0.0 that held for exactly one shape: the whole value of a hidden key
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
 * path down to the change and the new value itself.
 *
 * WHY A LIST IS HIDDEN WHOLE. A hidden object found in a list has an index today and another one
 * after the next `unshift`. A rule by index would then hide the wrong item. So the list is hidden.
 * The same holds for a `Map` and a `Set`, whose entries a path cannot name.
 *
 * WHAT IS NOT FOLLOWED, and cannot be: a text or a number has no identity, so a copy of one is hidden
 * by its own name only (`{ ...scope.profile }` copies the profile's texts). Nor is a copy made by the
 * stage's own code (`structuredClone`, a JSON round trip): it is a new value. An object carried from
 * one stage to the next in a closure is outside this stage's memory.
 *
 * WHAT IT COSTS (`bench/hidden-object-writes.ts`, 12 Nov 2026, lists of 10,000 records, read tracking
 * off). Nothing for a stage that read nothing hidden. After a hidden read, each write through the
 * typed scope pays one comparison for each item of the list it writes: 10,000 pushes went from 68 to
 * 142 ms, one field set on each of 10,000 records from 86 to 226 ms. The first read of a hidden list of
 * 10,000 records pays about 2 ms to remember them. The list traps know exactly what they put in; if this
 * ever matters, they can say so and the comparison goes away.
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

/** Is this a container whose entries a path cannot name: a list, a `Map` or a `Set`? */
function isUnnamed(node: object): node is unknown[] | Map<unknown, unknown> | Set<unknown> {
  return Array.isArray(node) || node instanceof Map || node instanceof Set;
}

/** The own value under `key` of a plain object, never an inherited one. */
function ownMember(node: unknown, key: string): unknown {
  if (node === null || typeof node !== 'object' || isUnnamed(node)) return undefined;
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
      if (node instanceof Map || node instanceof Set) {
        // A path cannot name an entry, so only a container hidden whole hides its entries.
        if (its.kind === 'whole') for (const entry of node.values()) pushObject(todo, entry, its);
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
   * ```ts
   * selected.findIn({ x: 1, b: secret }, { x: 1 }); // [{ path: ['b'], rule: …, whole: true }]
   * selected.findIn([...list, secret], list);       // [{ path: [], rule: …, whole: true }]  the list
   * ```
   */
  findIn(value: unknown, base: unknown): FoundSelected[] {
    const found: FoundSelected[] = [];
    const seen = new Set<object>();
    // `list`: the path of the nearest list, Map or Set above the node, when there is one.
    const todo: [unknown, unknown, readonly string[], readonly string[] | undefined][] = [[value, base, [], undefined]];
    for (let next = todo.pop(); next !== undefined; next = todo.pop()) {
      const [node, was, path, list] = next;
      if (node === null || typeof node !== 'object' || node === was) continue;
      const rule = this.rules.get(node);
      if (rule !== undefined) {
        found.push({ path: list ?? path, rule, whole: list !== undefined || rule.kind === 'whole' });
        continue;
      }
      if (seen.has(node)) continue;
      seen.add(node);
      if (Array.isArray(node)) {
        for (const [item, old] of newItems(node, was)) todo.push([item, old, path, list ?? path]);
      } else if (node instanceof Map) {
        const old = was instanceof Map ? was : undefined;
        for (const [name, entry] of node) todo.push([entry, old?.get(name), path, list ?? path]);
      } else if (node instanceof Set) {
        const old = was instanceof Set ? was : undefined;
        for (const entry of node) if (!old?.has(entry)) todo.push([entry, undefined, path, list ?? path]);
      } else {
        for (const key of Object.keys(node)) {
          todo.push([(node as Record<string, unknown>)[key], ownMember(was, key), [...path, key], list]);
        }
      }
    }
    return found;
  }
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
 * the same object as an item of the old list. The stepping decides the cost, never the answer.
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

function isObject(value: unknown): value is object {
  return value !== null && typeof value === 'object';
}
