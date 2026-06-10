/**
 * recorder/invokeHook.ts — the ONE per-listener invoke helper (RFC-001 §9 mitigation).
 *
 * Pattern:  Single shared "look up the hook, bind `this`, call it" primitive
 *           used by BOTH delivery tiers:
 *             - inline:   `ScopeFacade._invokeHook` / `ScopeFacade.emitEvent`
 *               call it per recorder per event (the historical direct call);
 *             - deferred: `DeferredObserverTier`'s dispatcher listener calls
 *               it per envelope at the flush checkpoint.
 *           Because both tiers route through the SAME lookup + `.call(this)`
 *           semantics, the two paths cannot drift: a recorder that works
 *           inline is invoked identically one beat behind.
 * Role:     Invocation primitive only. NO error handling here — the two
 *           tiers isolate failures differently by design (inline routes a
 *           throw to sibling recorders' `onError` at the dispatch site;
 *           deferred routes sync throws AND async rejections through
 *           `DeferredDispatcher`'s injected error callback).
 *
 * Lookup semantics: NORMAL property lookup (prototype chain included), the
 * same as the historical `recorder[hook]` read in `ScopeFacade._invokeHook` —
 * class-based recorders declare hooks on their prototype. (The own-property
 * restriction in `hasRecorderMethods` applies only to CHANNEL ROUTING
 * detection, not to invocation.)
 */

/**
 * Invoke `recorder[method](event)` with `this` bound to the recorder, iff
 * `method` resolves to a function. Returns the hook's return value (a
 * deferred listener may return a Promise the dispatcher tracks); returns
 * `undefined` when the hook is absent. Throws whatever the hook throws —
 * callers own error isolation.
 */
export function invokeRecorderHook(recorder: object, method: string, event: unknown): unknown {
  const hook = (recorder as Record<string, unknown>)[method];
  if (typeof hook !== 'function') return undefined;
  return (hook as (e: unknown) => unknown).call(recorder, event);
}
