/**
 * mapperScope.ts — what a subflow mapper is handed in place of the parent's state.
 *
 * WHY THIS FILE EXISTS. A subflow's `inputMapper` and `outputMapper` are user code that reads the
 * parent's state. They used to be handed the state object itself, so what they read left no trace:
 * the mount had no reads in the execution tree, and with per-write provenance its merge-back rows
 * said they read nothing. A walk back from a value a subflow produced named the mount and stopped
 * there, with no warning. Every stage before the mount was missing.
 *
 * WHAT IS HANDED NOW. A plain record with the parent's root keys. Reading a key gives the same live
 * committed value as before, and is recorded as a read of the MOUNT through the one tracked-read
 * funnel (`StageContext · readForMapper`): the read prefix, the rule's verdict, the taint count and
 * `stageReads`. So the mount is a step like any other: it read these keys and then wrote its
 * merge-back, and the walk back goes on through it.
 *
 * WHY ACCESSORS, NOT A PROXY. A mapper may spread, clone or serialize what it is handed
 * (`{ ...parent }`, `structuredClone`, `JSON.stringify`); each of those reads every key, and each
 * works on a record of accessors. A Proxy cannot be cloned. The redaction view made for a mapper
 * (`memory/redaction.ts · MapperTaint · watch`) is built the same way and wraps this one.
 *
 * WHAT IS NOT RECORDED. A key listing (`Object.keys`) reads no value, so it records nothing. A read
 * inside a value (`parent.profile.name`) is a read of the root key `profile`, as for any stage. An
 * assignment lands on this record, never on the state behind it.
 */
import type { StageContext } from '../../memory/StageContext.js';

/** The record a mapper of `mount` is handed: the parent's root keys, each read tracked as the mount's. */
export function mapperScope<TParentScope>(mount: StageContext): TParentScope {
  const scope: Record<string, unknown> = {};
  for (const key of mount.rootKeys()) {
    Object.defineProperty(scope, key, {
      enumerable: true,
      configurable: true,
      get: () => mount.readForMapper(key),
      set: (value: unknown) => {
        Object.defineProperty(scope, key, { value, writable: true, enumerable: true, configurable: true });
      },
    });
  }
  return scope as TParentScope;
}
