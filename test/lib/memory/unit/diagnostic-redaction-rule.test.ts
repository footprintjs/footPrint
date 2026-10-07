import { describe, expect, it } from 'vitest';

import { DiagnosticCollector } from '../../../../src/lib/memory/DiagnosticCollector.js';
import { RedactionRule } from '../../../../src/lib/memory/redaction.js';

describe('diagnostic retention at its writer', () => {
  it('keeps diagnostic-only selectors out of state', () => {
    const rule = new RedactionRule({ diagnostics: { keys: ['logs.secret'] } });
    expect(rule.isInert()).toBe(true);
    expect(rule.retain(['logs', 'secret'], 1)).toBe(1);
    expect(rule.retainDiagnostic(['logs', 'secret'], 1)).toBe('[REDACTED]');
    // A mark is a STATE name: `logs.public` names no diagnostic entry (the channel takes no part).
    rule.mark('logs.public');
    expect(rule.retainDiagnostic(['logs', 'public'], 2)).toBe(2);
    expect(rule.report()).toEqual({ redactedKeys: ['logs.public'], fieldRedactions: {}, patterns: [] });
  });

  it('maps a diagnostic entry to the state key of its NAME — keys, patterns, marks, fields, nested keys', () => {
    const rule = new RedactionRule({ keys: ['token'], patterns: [/secret$/i], fields: { profile: ['ssn'] } });
    for (const channel of ['logs', 'errors', 'metrics', 'evals']) {
      expect(rule.retainDiagnostic([channel, 'token'], 'raw')).toBe('[REDACTED]');
      expect(rule.retainDiagnostic([channel, 'apiSecret'], 'raw')).toBe('[REDACTED]');
    }
    const profile = { name: 'Ada', ssn: '123' };
    expect(rule.retainDiagnostic(['logs', 'profile'], profile)).toEqual({ name: 'Ada', ssn: '[REDACTED]' });
    expect(profile.ssn).toBe('123');
    // A record handed out whole: a selected name at any depth, a declared field under a key of its name.
    const message = [{ request: { token: 't', profile: { ssn: '1', name: 'B' } } }];
    expect(rule.retainDiagnostic(['logs', 'messages'], message)).toEqual([
      { request: { token: '[REDACTED]', profile: { ssn: '[REDACTED]', name: 'B' } } },
    ]);
    expect(message[0].request.token).toBe('t');
    // The name at the end of a nested path is a key too; clear values keep their identity.
    expect(rule.retainDiagnostic(['logs', 'auth', 'token'], 'raw')).toBe('[REDACTED]');
    const clear = { ok: true };
    expect(rule.retainDiagnostic(['logs', 'status'], clear)).toBe(clear);
    rule.mark('session');
    expect(rule.retainDiagnostic(['metrics', 'session'], 1)).toBe('[REDACTED]');
    // Flow-message text has no name of its own: only diagnostic selectors reach it.
    expect(rule.retainFlowText(['flowMessages', 'description'], 'token')).toBe('token');
    expect(rule.isFlowTextInert()).toBe(true);
    expect(rule.isDiagnosticInert()).toBe(false);
  });

  it('uses the same ancestor, field and stateless pattern semantics', () => {
    const rule = new RedactionRule({
      diagnostics: { keys: ['errors'], patterns: [/^metrics\.secret$/g], fields: { logs: ['profile.token'] } },
    });
    const profile = { token: 'private', name: 'public' };
    expect(rule.retainDiagnostic(['logs', 'profile'], profile)).toEqual({ token: '[REDACTED]', name: 'public' });
    expect(profile.token).toBe('private');
    expect(rule.retainDiagnostic(['logs', 'profile', 'token'], 'private')).toBe('[REDACTED]');
    expect(rule.retainDiagnostic(['errors', 'nested', 'failure'], 1)).toBe('[REDACTED]');
    for (let n = 0; n < 10; n++) {
      expect(rule.retainDiagnostic(['metrics', 'secret'], n)).toBe('[REDACTED]');
    }
  });

  it('keeps clear identity and replaces or clears diagnostic policy without touching state marks', () => {
    const value = { secret: 'private' };
    const rule = new RedactionRule();
    expect(rule.retainDiagnostic(['logs', 'value'], value)).toBe(value);
    rule.mark('state');
    rule.setPolicy({ diagnostics: { keys: ['logs.value'] } });
    expect(rule.retainDiagnostic(['logs', 'value'], value)).toBe('[REDACTED]');
    rule.setPolicy({ diagnostics: { keys: ['errors.value'] } });
    expect(rule.retainDiagnostic(['logs', 'value'], value)).toBe(value);
    rule.setPolicy(undefined);
    expect(rule.retainDiagnostic(['errors', 'value'], value)).toBe(value);
    expect(rule.retain(['state'], value)).toBe('[REDACTED]');
  });

  it('reads the current rule at every collector write, before merge or replacement', () => {
    let rule = new RedactionRule();
    const collector = new DiagnosticCollector(() => rule);
    const clear = { name: 'first' };
    expect(collector.add('logs', 'profile', clear)).toBe(clear);
    rule = new RedactionRule({ diagnostics: { fields: { logs: ['profile.token'] } } });
    const input = { token: 'private' };
    expect(collector.add('logs', 'profile', input)).toEqual({ token: '[REDACTED]' });
    expect(collector.logContext.profile).toEqual({ name: 'first', token: '[REDACTED]' });
    expect(input).toEqual({ token: 'private' });
    expect(collector.setLog('profile', input)).toBeUndefined();
    expect(collector.logContext.profile).toEqual({ token: '[REDACTED]' });
  });

  it('funnels every bag writer through the same retained-value owner', () => {
    const rule = new RedactionRule({ diagnostics: { keys: ['logs', 'errors', 'metrics', 'evals'] } });
    const collector = new DiagnosticCollector(() => rule);
    for (const method of ['addLog', 'setLog', 'addError', 'addMetric', 'setMetric', 'addEval', 'setEval'] as const) {
      expect(collector[method]('secret', 'private', ['nested'])).toBeUndefined();
    }
    for (const bag of [collector.logContext, collector.errorContext, collector.metricContext, collector.evalContext]) {
      expect(bag).toEqual({ nested: { secret: '[REDACTED]' } });
    }
  });

  it('keeps flow metadata and only retains its text payloads', () => {
    const collector = new DiagnosticCollector(() => new RedactionRule({ diagnostics: { keys: ['flowMessages'] } }));
    const message = {
      type: 'branch' as const,
      description: 'private',
      rationale: 'private',
      targetStage: ['next'],
      timestamp: 5,
      count: 1,
      iteration: 2,
    };
    collector.addFlowMessage(message);
    expect(collector.flowMessages[0]).toEqual({ ...message, description: '[REDACTED]', rationale: '[REDACTED]' });
    expect(message.description).toBe('private');
    const clear = new DiagnosticCollector();
    clear.addFlowMessage(message);
    expect(clear.flowMessages[0]).toBe(message);
    const noRationale = { type: 'next' as const, description: 'private' };
    collector.addFlowMessage(noRationale);
    expect(collector.flowMessages[1]).toEqual({ type: 'next', description: '[REDACTED]' });
  });

  it('refuses an uncloneable field-scrub value before it can enter the bag', () => {
    const collector = new DiagnosticCollector(
      () => new RedactionRule({ diagnostics: { fields: { logs: ['profile.token'] } } }),
    );
    expect(() => collector.addLog('profile', { token: 'private', fn: () => 1 })).toThrow();
    expect(collector.logContext).toEqual({});
  });
});
