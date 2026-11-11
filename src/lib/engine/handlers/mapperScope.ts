/**
 * mapperScope.ts — what a subflow mapper is handed in place of the parent's state.
 *
 * WHY THIS FILE EXISTS. A subflow's `inputMapper` and `outputMapper` are user code that reads the
 * parent's state. They used to be handed the state object itself, so what they read left no trace:
 * the mount had no reads in the execution tree, and with per-write provenance its merge-back rows
 * said they read nothing. A walk back from a value a subflow produced named the mount and stopped
 * there, with no warning. Every stage before the mount was missing.
 *
 * WHAT IS HANDED NOW. A view of the parent's root keys. Reading a key gives the same live committed
 * value as before, and is recorded as a read of the MOUNT through the one tracked-read funnel
 * (`StageContext · readLiveRoot`): the read prefix, the rule's verdict, the taint count and
 * `stageReads`. So the mount is a step like any other: it read these keys and then wrote its
 * merge-back, and the walk back goes on through it.
 *
 * WHY A PROXY. The view must cost what the mapper READS, not what the state HOLDS. The first cut of
 * this file defined one accessor per root key for every mapper call; a mount in a loop over a state
 * of 500 keys ran 9 times slower although its mapper read one key (measured by the second reader of
 * the change: 9.8 ms became 89 ms for 200 passes). A proxy is built in constant time and does work
 * only for the keys that are asked for.
 *
 * WHAT A PROXY COSTS, AND HOW IT IS PAID. A proxy cannot be cloned, and a mapper may hand the view
 * itself on (`(parent) => parent`, `{ everything: parent }`). So the view is registered as a HANDLE
 * (`reactive/handles.ts`), the library's one law for its own proxies: wherever a mapper's result
 * enters the record (`SubflowInputMapper` asks `unwrapHandles` for both mappers) the view is
 * replaced by a plain record of its keys, every one of them read. Two things stay out of reach, and
 * both fail loudly with a clone error, as they do for every handle of a typed scope: user code that
 * clones the view itself (`structuredClone(parent)`), and a result that holds the view inside a
 * `Map`, a `Set` or a class instance (the unwrapping walks plain objects and arrays only; walking
 * every Map a run records would cost what the Map holds, at every boundary). `{ ...parent }` copies
 * the view, and can be put anywhere.
 *
 * THE VIEW IS OPEN WHILE ITS MAPPER'S RESULT IS BEING TAKEN, and closed after (`close`). A view kept
 * past that point would hand a later stage live state with no tracked read behind it, and record
 * the read on a mount that committed long before (the second reader showed both). A closed view
 * refuses a read with a message that says what to do.
 *
 * WHAT IS NOT RECORDED. A key listing (`Object.keys`, `in`) reads no value, so it records nothing;
 * neither does a key the state does not hold (it reads `undefined`, as before), nor printing the view
 * (`console.log(parent)` shows its key names). A read inside a value (`parent.profile.name`) is a read
 * of the root key `profile`, as for any stage. An assignment, a definition or a deletion lands on the
 * view, never on the state behind it.
 *
 * WHAT THE VIEW CANNOT STOP. The values it hands out are the live committed ones, so a change INSIDE a
 * value (`parent.profile.name = 'x'`, `parent.list.push(1)`) edits committed state itself, and no row
 * records it. Stopping that would mean wrapping every value a mapper reads. As for a stage, it is
 * reported instead: development mode names the mount, the mapper, the key and the path. The view tells
 * the watch what it hands out and when the call is over (`mapperEdits.ts`, which says why the judging
 * is done per call).
 */
import type { StageContext } from '../../memory/StageContext.js';
import { rememberHandle } from '../../reactive/handles.js';
import { type MapperRole, watchForEdits } from './mapperEdits.js';

/** The view a mapper of one mount is handed, and the end of its life. */
export interface MapperScope<TParentScope> {
  /** What the mapper is handed: the parent's root keys, each read tracked as the mount's. */
  readonly scope: TParentScope;
  /**
   * The mapper's result has been taken: from now on a read of the parent's state is refused. In
   * development mode this is also when the call is judged for a change it made in place.
   */
  close(): void;
}

/**
 * What sees each read of a view, and hands the mapper its value: the redaction rule's taint
 * (`memory/redaction.ts · MapperTaint · reads`), which may hand out a view of a record whose fields
 * are selected in place of the record.
 */
export type MapperReadWatcher = (key: string, value: unknown) => unknown;

/** Each view, by the object the mapper holds: how a watcher is put on it ({@link watchMapperReads}). */
const WATCH = new WeakMap<object, (watcher: MapperReadWatcher) => void>();

/** Is `scope` a view made by {@link mapperScope}? (The mapping helpers are also handed plain records.) */
export function isMapperView(scope: unknown): scope is object {
  return scope !== null && typeof scope === 'object' && WATCH.has(scope);
}

/**
 * Have `watcher` see every read of the view `scope` from now on.
 *
 * WHY THE VIEW REPORTS ITS OWN READS. The taint used to learn what a mapper read by wrapping what it
 * was handed in a second record with one accessor per key, for every mapper call. That is the cost
 * this file exists to avoid: under a redaction policy a mount in a loop over a state of 500 keys paid
 * for 500 accessors per mapper call to watch the one key that was read.
 */
export function watchMapperReads(scope: object, watcher: MapperReadWatcher): void {
  WATCH.get(scope)?.(watcher);
}

/** How a debugger prints the view (`console.log(parent)` in a mapper): see where it is defined below. */
const INSPECT = Symbol.for('nodejs.util.inspect.custom');
const CLOSED = '[parent state: readable only while the mapper runs]';

/** A whole-number key, which an object lists before its other keys. */
const isIndexKey = (key: string | symbol): key is string =>
  typeof key === 'string' && /^(0|[1-9]\d*)$/.test(key) && Number(key) < 2 ** 32 - 1;

/** `keys` in the order an object lists its own: whole-number keys ascending, the other names as given, symbols last. */
function inObjectOrder(keys: (string | symbol)[]): (string | symbol)[] {
  const numbered = keys.filter(isIndexKey).sort((a, b) => Number(a) - Number(b));
  const named = keys.filter((key) => typeof key === 'string' && !isIndexKey(key));
  return [...numbered, ...named, ...keys.filter((key) => typeof key === 'symbol')];
}

/** Open the view of the parent's state for one call of `mapper` on `mount`. */
export function mapperScope<TParentScope>(mount: StageContext, mapper: MapperRole): MapperScope<TParentScope> {
  let open = true;
  // Development mode only: what this call is handed, to be held against what it leaves (`mapperEdits.ts`).
  const edits = watchForEdits(mount.stageName, mapper);
  const rule = edits === undefined ? undefined : mount.getPolicy().redaction;
  // What the mapper itself did to the view lands on `own` (assignments, definitions) and in `hidden`
  // (root keys it deleted). Committed state is never touched.
  const own: Record<string | symbol, unknown> = {};
  let hidden: Set<string> | undefined;
  const fromState = (key: string | symbol): key is string =>
    typeof key === 'string' && !hidden?.has(key) && mount.hasRootKey(key);
  let watcher: MapperReadWatcher | undefined;
  const read = (key: string): unknown => {
    if (!open) throw new Error(closedMessage(mount.stageName, key));
    const value = mount.readLiveRoot(key);
    // A key under a redaction rule is reported by its name only: a place inside it is part of its value.
    if (edits !== undefined) edits.saw(key, value, rule === undefined || rule.verdictAt([], key).kind === 'clear');
    if (watcher === undefined) return value;
    const handed = watcher(key, value);
    // The rule may hand the mapper a view of a record in place of the record (the record's selected
    // fields are watched through it). The mount knows the record it read; it must know the view as the
    // same thing, or a copy the mapper carries on would lose the record's rule.
    if (handed !== value) mount.sameRuleFor(handed, value);
    return handed;
  };
  const scope = new Proxy(own, {
    get(target, key, receiver) {
      if (Object.hasOwn(target, key)) return Reflect.get(target, key, receiver);
      if (fromState(key)) return read(key);
      return Reflect.get(target, key, receiver);
    },
    has: (target, key) => Object.hasOwn(target, key) || fromState(key) || Reflect.has(target, key),
    ownKeys: () => keysOf(),
    getOwnPropertyDescriptor(target, key) {
      if (Object.hasOwn(target, key)) return Reflect.getOwnPropertyDescriptor(target, key);
      if (!fromState(key)) return undefined;
      // An accessor, so that listing the keys (which asks for every descriptor) reads no value.
      return { enumerable: true, configurable: true, get: () => read(key), set: (value) => assign(key, value) };
    },
    set: (_target, key, value) => assign(key, value),
    defineProperty(target, key, descriptor) {
      if (typeof key === 'string') hidden?.delete(key);
      return Reflect.defineProperty(target, key, descriptor);
    },
    deleteProperty(target, key) {
      if (typeof key === 'string' && mount.hasRootKey(key)) (hidden ??= new Set()).add(key);
      return Reflect.deleteProperty(target, key);
    },
    // The view's keys are the state's, which a frozen or sealed object could not follow.
    preventExtensions: () => false,
  });
  // The view's keys: the state's, in its order, without the ones the mapper deleted; then what the
  // mapper added, each put where an object would list it. (The print hook is the target's one own key
  // that is never listed.)
  function keysOf(): (string | symbol)[] {
    const fromRoot = mount.rootKeys();
    const keys: (string | symbol)[] = hidden === undefined ? fromRoot : fromRoot.filter((key) => !hidden?.has(key));
    const mine = Reflect.ownKeys(own);
    if (mine.length === 1) return keys;
    const seen = new Set<string | symbol>(keys).add(INSPECT);
    const added = mine.filter((key) => !seen.has(key));
    return added.length === 0 ? keys : inObjectOrder([...keys, ...added]);
  }
  // The view as a plain record: what a spread of it gives, without going through its own traps (a
  // spread of a proxy asks for every key's descriptor on the way; measured, that is more than half of it).
  function whole(): Record<string | symbol, unknown> {
    const record: Record<string | symbol, unknown> = {};
    for (const key of keysOf()) {
      if (!Object.hasOwn(own, key)) record[key] = read(key as string);
      else if (Object.getOwnPropertyDescriptor(own, key)?.enumerable) record[key] = Reflect.get(own, key, scope);
    }
    return record;
  }
  // An assignment does what it does on any object, to the view's own record: a new key is added, a key
  // the mapper defined as read-only refuses, and `__proto__` re-parents (the view, never the state).
  function assign(key: string | symbol, value: unknown): boolean {
    if (typeof key === 'string') hidden?.delete(key);
    return Reflect.set(own, key, value, own);
  }
  // Handed on whole, the view is taken as a plain record of its keys: each one read (see the header).
  rememberHandle(scope, whole);
  WATCH.set(scope, (seenBy) => {
    watcher = seenBy;
  });
  // A debugger prints a proxy's TARGET, which holds only what the mapper put there. So the target says
  // how to print the view: the NAMES of its keys, and how to see a value. Never the values. Printing is
  // not reading: it must leave no read on the record, and under a redaction policy it must not put a
  // selected value on a console. (The first cut printed `{ ...scope }`. The second reader showed a
  // token printed in clear, and an unrelated output masked because the print "read a secret".)
  // A closed view says what it is, and never throws inside a debugger. Not listed among its keys.
  Object.defineProperty(own, INSPECT, { value: () => (open ? printed(scope) : CLOSED), configurable: true });
  return {
    scope: scope as TParentScope,
    close: () => {
      open = false;
      edits?.report();
    },
  };
}

/** What a debugger shows for an open view: its key names (asking for them reads no value). */
function printed(scope: object): string {
  const names = Reflect.ownKeys(scope).filter((key) => typeof key === 'string');
  return `[parent state, keys: ${names.join(', ')}. Read a key, or spread it, to see values.]`;
}

function closedMessage(mount: string, key: string): string {
  return (
    `[footprint] Subflow mount "${mount}": the parent state handed to its mapper was read ` +
    `('${key}') after the mapper returned. That state can be read only while the mapper runs: ` +
    "a later read would be on no step's record. Return what is needed from the mapper instead of keeping the object."
  );
}
