/**
 * The redaction rule's memory of masked thrown values (P2 security review): held WEAKLY for objects — a run whose
 * calls fail thousands of times must not keep every thrown value alive — by value for scalars, with the `Map`
 * reading (`has`) consumers' isolation tests rely on (agentfootprint · agent-redaction.isolation.test.ts).
 *
 * Test types: Unit.
 */
import { describe, expect, it } from 'vitest';

import { RedactionRule, SCOPE_PLACEHOLDER } from '../../../../src/lib/memory/redaction.js';

type Store = { has(value: unknown): boolean; get(value: unknown): unknown };
const store = (rule: RedactionRule) => (rule as unknown as { maskedErrors?: Store }).maskedErrors;

describe('RedactionRule · masked thrown values', () => {
  it('remembers a masked thrown object by identity, and answers `has` like a Map', () => {
    const rule = new RedactionRule({ keys: ['ssn'] });
    const thrown = Object.assign(new Error('lookup failed'), { ssn: 'SSN-1' });
    rule.retainStageError(thrown, 'lookup failed', 'lookup failed');
    expect(store(rule)?.has(thrown)).toBe(true);
    expect(store(rule)?.has(new Error('lookup failed'))).toBe(false);
    expect(rule.servedError(thrown)).toMatchObject({ message: 'lookup failed', raw: undefined });
  });

  it('remembers a masked thrown scalar by value', () => {
    const rule = new RedactionRule({ diagnostics: { keys: ['errors.stageExecutionError'] } });
    const kept = rule.retainDiagnostic(['errors', 'stageExecutionError'], 'card 4111');
    rule.retainStageError('card 4111', 'card 4111', kept);
    expect(store(rule)?.has('card 4111')).toBe(true);
    expect(rule.servedError('card 4111').message).not.toContain('4111');
  });

  it('an unmasked rule remembers nothing', () => {
    expect(store(new RedactionRule())).toBeUndefined();
  });

  it.each(['cause', 'errors'] as const)(
    'an inert rule still masks a wrapper whose %s holds a remembered masked error',
    (key) => {
      const rule = new RedactionRule();
      const cause = new Error('SYNTHETIC-MASKED-CAUSE');
      rule.retainStageError(cause, cause.message, SCOPE_PLACEHOLDER);
      const wrapper = new Error('safe wrapper');
      Object.defineProperty(wrapper, key, { value: key === 'cause' ? cause : [cause] });
      expect(rule.isDiagnosticInert()).toBe(true);
      expect(rule.servedError(wrapper).raw).toBeUndefined();
      expect((wrapper as Error & { cause?: unknown }).cause).toBe(key === 'cause' ? cause : undefined);
    },
  );
});
