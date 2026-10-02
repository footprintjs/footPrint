/**
 * @deprecated Moved (F0, the fence and the leaves). This path re-exports for one minor
 * and then goes away; import from the new homes:
 *
 *   - `enableDevMode` / `disableDevMode` / `isDevMode`  →  `lib/devMode.ts`
 *   - `hasCircularReference`                            →  `lib/capture/circular.ts`
 *
 * Both are leaves that imported nothing but sat inside `scope/`, which made `memory/`,
 * `recorder/`, `decide/`, `engine/` and `runner/` import upward for them. Same functions,
 * same module state — the flag lives in `devMode.ts` and is shared, never copied.
 */
export { hasCircularReference } from '../capture/circular.js';
export { disableDevMode, enableDevMode, isDevMode } from '../devMode.js';
