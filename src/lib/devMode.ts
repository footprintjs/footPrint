/**
 * devMode — the library-wide developer-diagnostics flag.
 *
 * A leaf: this module imports nothing, so every layer may import it. It lives at the
 * bottom of `src/lib/` (it used to sit in `scope/detectCircular.ts`) because memory/,
 * recorder/, decide/, engine/ and runner/ all gate their developer-only checks on it —
 * and a leaf inside a mid-layer module made each of them import upward, which closed the
 * one value-level module cycle (memory ⇄ scope ⇄ recorder). `footprintjs` re-exports
 * `enableDevMode` / `disableDevMode` / `isDevMode` from here (src/index.ts).
 *
 * The circular-reference check that used to share this file is `capture/circular.ts`.
 */

/**
 * Global dev-mode flag for the whole `footprintjs` library.
 *
 * ## What it gates
 *
 * Multiple library subsystems use `isDevMode()` to decide whether to run
 * expensive or noisy developer-only checks. Production leaves it OFF (the
 * default) to avoid the cost and keep logs clean. Turning it ON enables:
 *
 *   - Circular-reference detection in `ScopeFacade.setValue()` (O(n) per write).
 *   - Warnings when `attachCombinedRecorder()` receives a recorder with no
 *     observer methods (likely mistake — easy to forget an `on*` handler).
 *   - Warnings from `decide()` / `select()` when a predicate or rule shape
 *     looks suspicious.
 *   - Structural-integrity warnings in `getSubtreeSnapshot()`.
 *   - Any future developer-only diagnostic added to the library.
 *
 * ## How to enable
 *
 * Call `enableDevMode()` once at application startup (typically near your
 * executor construction):
 *
 * ```ts
 * import { enableDevMode } from 'footprintjs';
 *
 * if (process.env.NODE_ENV !== 'production') {
 *   enableDevMode();
 * }
 * ```
 *
 * Alternatively, gate on your own flag — the point is that production stays
 * silent and fast, development is loud and helpful.
 *
 * ## Contract
 *
 * - Default: OFF. A library import does NOT enable dev-mode automatically.
 * - Global: one flag controls all library dev diagnostics. A consumer who
 *   calls `disableDevMode()` silences every dev warning at once.
 * - Process-wide: not per-executor. Enabling mid-run affects subsequent
 *   operations but does not retroactively replay missed checks.
 * - Safe in production: when OFF, every gated check is a cheap `!flag`
 *   branch and adds negligible overhead.
 */
let devModeEnabled = false;

/**
 * Enable dev-mode diagnostics across the whole library.
 *
 * When on, the library performs developer-only checks (circular references,
 * empty recorder detection, suspicious predicate shapes, etc.) and emits
 * `console.warn` messages to help you catch mistakes early.
 *
 * Call once at application startup. See the module header for the full
 * list of what dev-mode gates.
 *
 * @example
 * ```ts
 * import { enableDevMode } from 'footprintjs';
 * if (process.env.NODE_ENV !== 'production') enableDevMode();
 * ```
 */
export function enableDevMode(): void {
  devModeEnabled = true;
}

/**
 * Disable dev-mode diagnostics across the whole library (default state).
 *
 * All dev-only checks become no-ops. Safe to call in production paths —
 * typically the default never needs to be re-asserted, but this is the
 * documented way to turn the flag off if your code enabled it earlier.
 */
export function disableDevMode(): void {
  devModeEnabled = false;
}

/**
 * Returns whether dev-mode diagnostics are currently enabled.
 *
 * Library internals call this before running any dev-only check. Consumers
 * rarely need to call it directly — prefer `enableDevMode()` at startup and
 * let the library gate its own diagnostics internally.
 */
export function isDevMode(): boolean {
  return devModeEnabled;
}
