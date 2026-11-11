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
 * replaced by a plain record of its keys, every one of them read. What stays out of reach is user
 * code that clones the view itself (`structuredClone(parent)`): that throws, as it does for every
 * handle of a typed scope. `{ ...parent }` copies it.
 *
 * THE VIEW IS OPEN WHILE ITS MAPPER'S RESULT IS BEING TAKEN, and closed after (`close`). A view kept
 * past that point would hand a later stage live state with no tracked read behind it, and record
 * the read on a mount that committed long before (the second reader showed both). A closed view
 * refuses a read with a message that says what to do.
 *
 * WHAT IS NOT RECORDED. A key listing (`Object.keys`, `in`) reads no value, so it records nothing;
 * neither does a key the state does not hold (it reads `undefined`, as before). A read inside a value
 * (`parent.profile.name`) is a read of the root key `profile`, as for any stage. An assignment, a
 * definition or a deletion lands on the view, never on the state behind it.
 */
import type { StageContext } from '../../memory/StageContext.js';
import { rememberHandle } from '../../reactive/handles.js';

/** The view a mapper of one mount is handed, and the end of its life. */
export interface MapperScope<TParentScope> {
  /** What the mapper is handed: the parent's root keys, each read tracked as the mount's. */
  readonly scope: TParentScope;
  /** The mapper's result has been taken: from now on a read of the parent's state is refused. */
  close(): void;
}

/** How a debugger prints the view (`console.log(parent)` in a mapper): its values, not an empty proxy. */
const INSPECT = Symbol.for('nodejs.util.inspect.custom');
const CLOSED = '[parent state: readable only while the mapper runs]';

/** Open the view of the parent's state for one mapper call of `mount`. */
export function mapperScope<TParentScope>(mount: StageContext): MapperScope<TParentScope> {
  let open = true;
  // What the mapper itself did to the view lands on `own` (assignments, definitions) and in `hidden`
  // (root keys it deleted). Committed state is never touched.
  const own: Record<string | symbol, unknown> = {};
  let hidden: Set<string> | undefined;
  const fromState = (key: string | symbol): key is string =>
    typeof key === 'string' && !hidden?.has(key) && mount.hasRootKey(key);
  const read = (key: string): unknown => {
    if (!open) throw new Error(closedMessage(mount.stageName, key));
    return mount.readLiveRoot(key);
  };
  const scope = new Proxy(own, {
    get(target, key, receiver) {
      if (Object.hasOwn(target, key)) return Reflect.get(target, key, receiver);
      if (fromState(key)) return read(key);
      return Reflect.get(target, key, receiver);
    },
    has: (target, key) => Object.hasOwn(target, key) || fromState(key) || Reflect.has(target, key),
    ownKeys(target) {
      const keys: (string | symbol)[] = mount.rootKeys().filter((key) => !hidden?.has(key));
      const seen = new Set<string | symbol>(keys).add(INSPECT);
      for (const key of Reflect.ownKeys(target)) if (!seen.has(key)) keys.push(key);
      return keys;
    },
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
  function assign(key: string | symbol, value: unknown): boolean {
    if (typeof key === 'string') hidden?.delete(key);
    // A key the view does not hold yet becomes its own data property, whatever its name: `__proto__`
    // assigned through `own[key] = value` would re-parent the view instead.
    if (Object.hasOwn(own, key)) return Reflect.set(own, key, value, own);
    return Reflect.defineProperty(own, key, { value, writable: true, enumerable: true, configurable: true });
  }
  // Handed on whole, the view is taken as a plain record of its keys: each one read (see the header).
  rememberHandle(scope, () => ({ ...scope }));
  // A debugger prints a proxy's TARGET, which holds only what the mapper put there. So the target says
  // how to print the view: its values, each a read like any other (printing a typed scope reads too).
  // A closed view prints what it is, and never throws inside a debugger. Not listed among its keys.
  Object.defineProperty(own, INSPECT, { value: () => (open ? { ...scope } : CLOSED), configurable: true });
  return {
    scope: scope as TParentScope,
    close: () => {
      open = false;
    },
  };
}

function closedMessage(mount: string, key: string): string {
  return (
    `[footprint] Subflow mount "${mount}": the parent state handed to its mapper was read ` +
    `('${key}') after the mapper returned. That state can be read only while the mapper runs: ` +
    "a later read would be on no step's record. Return what is needed from the mapper instead of keeping the object."
  );
}
