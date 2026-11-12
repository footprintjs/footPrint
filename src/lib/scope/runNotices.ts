/**
 * scope/runNotices -- "tell the developer this once per run", for a dev-mode warning raised where only a
 * stage's scope is at hand.
 *
 * WHY. A decision inside a loop runs once per pass, and a stage's scope lives for one pass: a flag on the
 * scope, or on the call site, would warn again on every pass and flood the console. What outlives a stage and
 * dies with the run is the run's redaction rule: the executor builds ONE per run (and per resume) and every
 * stage's scope reads that same object (`ScopeFacade · rule`). The rule already carries the precedent
 * (`RedactionRule · walkLimitWarned`: one dev-mode warning per rule). A WeakMap keyed by it keeps the
 * memory off the rule, so the redaction owner learns nothing about notices, and it goes with the run.
 *
 * ```ts
 * firstTimeThisRun(rule, 'runs.a.b'); // true: say it
 * firstTimeThisRun(rule, 'runs.a.b'); // false: said already, in this run
 * ```
 *
 * Bounded: a run that makes up its own notice texts is told at most {@link MAX_NOTICES_PER_RUN} of them.
 */

const MAX_NOTICES_PER_RUN = 256;

const told = new WeakMap<object, Set<string>>();

/** True the first time `notice` is asked for `run`, false after; false for everything past the bound. */
export function firstTimeThisRun(run: object, notice: string): boolean {
  // Set again on every ask: the same entry each time, and a shorter body than "only when new" in every door that bundles a scope.
  const set = told.get(run) ?? new Set<string>();
  told.set(run, set);
  if (set.has(notice) || set.size >= MAX_NOTICES_PER_RUN) return false;
  set.add(notice);
  return true;
}
