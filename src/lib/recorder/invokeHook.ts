/**
 * @deprecated Moved (F0, the fence and the leaves). This path re-exports for one minor
 * and then goes away; import `invokeRecorderHook` from `lib/capture/invokeHook.ts`.
 *
 * It imported nothing but sat inside `recorder/`, so `scope/` (the inline tier) had to
 * import `recorder/` for it — one edge of the memory ⇄ scope ⇄ recorder cycle.
 */
export { invokeRecorderHook } from '../capture/invokeHook.js';
