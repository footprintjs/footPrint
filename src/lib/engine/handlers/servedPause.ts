/**
 * servedPause — the ONE place a pause payload's SERVED form is decided.
 *
 * A pause payload (a pausable stage's return, an `interrupt()` payload) is a
 * record handed out whole, so every observer is served it under the run's
 * redaction rule (`RedactionRule.retainBoundary`: its keys at every depth) —
 * the scope and flow `onPause` events, inline and deferred, and with them the
 * narrative and every recorder row. The CHECKPOINT keeps the real payload:
 * resume hands it back to the caller, who asked the question.
 *
 * Total: a payload whose scrub fails (an uncloneable value under a selected
 * field) is served as the placeholder — never raw, and never a failed pause.
 */

import { SCOPE_PLACEHOLDER } from '../../memory/redaction.js';
import type { StageContext } from '../../memory/StageContext.js';

export function servedPause(context: StageContext, pauseData: unknown): unknown {
  const rule = context.getRedactionRule();
  if (!rule) return pauseData;
  try {
    return rule.retainBoundary(pauseData);
  } catch {
    return SCOPE_PLACEHOLDER;
  }
}
