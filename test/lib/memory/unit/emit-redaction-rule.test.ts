import * as fc from 'fast-check';

import { RedactionRule } from '../../../../src/lib/memory/redaction.js';

describe('RedactionRule — emitted payload retention', () => {
  it('preserves clear payload identity and keeps emit policy separate from state policy', () => {
    const payload = { secret: 'kept-live' };
    for (const policy of [undefined, {}, { emitPatterns: [] }, { keys: ['secret'], patterns: [/secret/] }]) {
      expect(new RedactionRule(policy).retainEmit('secret', payload)).toBe(payload);
    }
    const rule = new RedactionRule({ emitPatterns: [/secret/] });
    expect(rule.isInert()).toBe(true);
    expect(rule.isKeyRedacted('secret')).toBe(false);
    expect(rule.retainEmit('public', payload)).toBe(payload);
    expect(rule.retainEmit('secret', payload)).toBe('[REDACTED]');
    expect(payload.secret).toBe('kept-live');
    expect(rule.report()).toEqual({ redactedKeys: [], fieldRedactions: {}, patterns: [] });
  });

  it.each(['g', 'y', 'gy'])('resets /%s on every name, including misses and external cursor changes', (flags) => {
    const pattern = new RegExp('secret', flags);
    const rule = new RedactionRule({ emitPatterns: [pattern] });
    for (let n = 0; n < 5; n++) {
      pattern.lastIndex = 100;
      expect(rule.retainEmit('secret.event', n)).toBe('[REDACTED]');
      expect(rule.retainEmit('secret.event', n)).toBe('[REDACTED]');
      expect(rule.retainEmit('public', n)).toBe(n);
    }
  });

  it('keeps sticky anchoring and ordinary global search semantics', () => {
    expect(new RedactionRule({ emitPatterns: [/secret/y] }).retainEmit('prefix.secret', 1)).toBe(1);
    expect(new RedactionRule({ emitPatterns: [/secret/g] }).retainEmit('prefix.secret', 1)).toBe('[REDACTED]');
  });

  it('matches long event names without importing the state-key length cap', () => {
    const name = `${'x'.repeat(300)}.secret`;
    const rule = new RedactionRule({ patterns: [/secret/g], emitPatterns: [/secret/g] });
    expect(rule.isKeyRedacted(name)).toBe(false);
    expect(rule.retainEmit(name, 42)).toBe('[REDACTED]');
    expect(rule.retainEmit(name, 43)).toBe('[REDACTED]');
  });

  it('uses the current policy, including policy removal', () => {
    const rule = new RedactionRule({ emitPatterns: [/old/g] });
    expect(rule.retainEmit('old', 1)).toBe('[REDACTED]');
    rule.setPolicy({ emitPatterns: [/new/y] });
    expect(rule.retainEmit('old', 1)).toBe(1);
    expect(rule.retainEmit('new', 2)).toBe('[REDACTED]');
    rule.setPolicy(undefined);
    expect(rule.retainEmit('new', 2)).toBe(2);
  });

  it('shares one stateful pattern safely between state keys and emitted names', () => {
    const shared = /secret/g;
    const rule = new RedactionRule({ patterns: [shared], emitPatterns: [shared] });
    for (let n = 0; n < 5; n++) {
      expect(rule.isKeyRedacted('secret')).toBe(true);
      expect(rule.retainEmit('secret', n)).toBe('[REDACTED]');
    }
  });

  it('matches independently of prior names and caller cursor positions', () => {
    fc.assert(
      fc.property(
        fc.constantFrom('g', 'y', 'gy', 'gi', 'yi', 'giy'),
        fc.array(
          fc.record({
            name: fc.constantFrom('secret', 'SECRET', 'prefix.secret', 'public', '', 'secret.secret'),
            cursor: fc.integer({ min: 0, max: 100 }),
          }),
          { minLength: 1, maxLength: 30 },
        ),
        (flags, events) => {
          const pattern = new RegExp('secret', flags);
          const rule = new RedactionRule({ emitPatterns: [pattern] });
          for (const [index, { name, cursor }] of events.entries()) {
            pattern.lastIndex = cursor;
            const matches = new RegExp('secret', flags).test(name);
            expect(rule.retainEmit(name, index)).toBe(matches ? '[REDACTED]' : index);
          }
        },
      ),
      { seed: 20261004, numRuns: 150 },
    );
  });

  it.each([0, 7])('does not write a non-stateful cursor (frozen pattern, lastIndex %s)', (lastIndex) => {
    const pattern = /secret/i;
    pattern.lastIndex = lastIndex;
    Object.freeze(pattern);
    const rule = new RedactionRule({ patterns: [pattern], emitPatterns: [pattern] });
    expect(rule.isKeyRedacted('SECRET')).toBe(true);
    expect(rule.retainEmit('SECRET', 1)).toBe('[REDACTED]');
    expect(pattern.lastIndex).toBe(lastIndex);
  });

  it('leaves writable non-stateful cursors untouched too', () => {
    const pattern = /secret/;
    pattern.lastIndex = 17;
    const rule = new RedactionRule({ patterns: [pattern], emitPatterns: [pattern] });
    expect(rule.isKeyRedacted('secret')).toBe(true);
    expect(pattern.lastIndex).toBe(17);
    expect(rule.retainEmit('secret', 1)).toBe('[REDACTED]');
    expect(pattern.lastIndex).toBe(17);
  });

  it('short-circuits in declared order without testing later patterns', () => {
    const later = /secret/g;
    const test = vi.spyOn(later, 'test');
    const rule = new RedactionRule({ emitPatterns: [/secret/, later] });
    expect(rule.retainEmit('secret', 1)).toBe('[REDACTED]');
    expect(test).not.toHaveBeenCalled();
  });

  it.each(['g', 'y', 'gy'])('refuses a frozen /%s cursor rather than returning a raw payload', (flags) => {
    const pattern = Object.freeze(new RegExp('secret', flags));
    const rule = new RedactionRule({ patterns: [pattern], emitPatterns: [pattern] });
    expect(() => rule.isKeyRedacted('secret')).toThrow(/lastIndex/);
    expect(() => rule.retainEmit('secret', 'private')).toThrow(/lastIndex/);
  });
});
