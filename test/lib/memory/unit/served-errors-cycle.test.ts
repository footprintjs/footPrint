/**
 * A circular result never exposes a masked error (review finding 2).
 *
 * A record handed out whole (a fork envelope, a run's output) that holds a
 * thrown value the policy masked is served with the masked form in its place
 * (`RedactionRule · retainBoundary` → `withServedErrors`). The copy used to be
 * registered as the ORIGINAL before its children were walked, so a cycle back
 * to it returned the original — whose edge still led to the raw error. Now the
 * copy is allocated first and every edge of the served graph stays served;
 * a container that holds no masked error keeps its identity.
 */
import { describe, expect, it } from 'vitest';

import { RedactionRule } from '../../../../src/lib/memory/redaction.js';

const MASK = '[REDACTED]';

/** A rule that has masked `error` (its text selected through the diagnostic selector). */
function maskedRule(error: unknown): RedactionRule {
  const rule = new RedactionRule({ diagnostics: { keys: ['errors.stageExecutionError'] } });
  const text = String(error);
  rule.retainStageError(error, text, rule.retainDiagnostic(['errors', 'stageExecutionError'], text));
  return rule;
}

/** Every object reachable from `root`, through every own enumerable edge. */
function reachable(root: unknown): Set<unknown> {
  const seen = new Set<unknown>();
  const stack = [root];
  while (stack.length > 0) {
    const node = stack.pop();
    if (node === null || typeof node !== 'object' || seen.has(node)) continue;
    seen.add(node);
    stack.push(...Object.values(node));
  }
  return seen;
}

describe('a circular result never exposes a masked error', () => {
  it('a cycle back to the result lands on the served copy', () => {
    const error = new Error('private failure text');
    const rule = maskedRule(error);
    const result: any = { child: { isError: true, result: error } };
    result.self = result;
    const served = rule.retainBoundary(result) as any;
    expect(served.child.result.message).toBe(MASK);
    expect(served.self).toBe(served);
    expect(served.self.child.result.message).toBe(MASK);
    expect(reachable(served).has(error)).toBe(false);
    expect(result.child.result).toBe(error); // the live record is never edited
  });

  it('a cycle through a nested container, and a masked error reached by two paths', () => {
    const error = new Error('private failure text');
    const rule = maskedRule(error);
    const inner: any = { error };
    const result: any = { a: { inner }, b: { inner } };
    inner.up = result;
    const served = rule.retainBoundary(result) as any;
    for (const path of [served.a.inner, served.b.inner, served.a.inner.up.b.inner]) {
      expect(path.error.message).toBe(MASK);
    }
    expect(reachable(served).has(error)).toBe(false);
  });

  it('a container without a masked error keeps its identity, cycle or not', () => {
    const error = new Error('private failure text');
    const rule = maskedRule(error);
    const clean: any = { note: 'n' };
    clean.self = clean;
    const result = { failed: { result: error }, clean };
    const served = rule.retainBoundary(result) as any;
    expect(served).not.toBe(result);
    expect(served.clean).toBe(clean);
    const untouched = { only: clean };
    expect(rule.retainBoundary(untouched)).toBe(untouched);
  });

  it('a thrown string is matched by value inside a cycle too', () => {
    const rule = maskedRule('private thrown text');
    const result: any = { failed: { result: 'private thrown text' } };
    result.failed.back = result;
    const served = rule.retainBoundary(result) as any;
    expect(served.failed.result).toBe(MASK);
    expect(served.failed.back.failed.result).toBe(MASK);
  });
});
