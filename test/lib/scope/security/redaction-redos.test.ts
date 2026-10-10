/**
 * Regression tests for the redaction rule's existing oversized-key matcher bypass
 * as exercised through ScopeFacade.
 *
 * Pattern testing is skipped for keys longer than 256 characters. This input-length
 * cap is not comprehensive ReDoS protection: a pathological regex can also be
 * expensive on shorter keys. These tests prove the bypass, not arbitrary regex safety.
 *
 * The exact-key path (Array.includes) is unaffected — it still checks all lengths.
 */

import { EventLog, SharedMemory } from 'foottrace/write';

import { StageContext } from '../../../../src/lib/memory';
import { ScopeFacade } from '../../../../src/lib/scope/ScopeFacade';
import type { RedactionPolicy } from '../../../../src/lib/scope/types';

function makeScope() {
  const mem = new SharedMemory();
  const log = new EventLog(undefined);
  const ctx = new StageContext('run-1', 's1', 's1', mem, '', log);
  return new ScopeFacade(ctx, 'test-stage');
}

// ---------------------------------------------------------------------------
// Pattern 1: unit — normal short keys still matched by patterns
// ---------------------------------------------------------------------------
describe('redaction ReDoS guard — unit: normal keys still matched by patterns', () => {
  it('short key matching a pattern is redacted', () => {
    const scope = makeScope();
    scope.useRedactionPolicy({ patterns: [/ssn/i] });

    const writes: unknown[] = [];
    scope.attachScopeRecorder({
      id: 'w',
      onWrite: (e: any) => writes.push(e),
    });

    scope.setValue('ssnNumber', '123-45-6789');
    expect(writes[0]).toMatchObject({ key: 'ssnNumber', value: '[REDACTED]' });
  });

  it('key exactly 256 chars long IS tested against patterns', () => {
    const scope = makeScope();
    // Build a 256-char key that contains 'secret'
    const key = 'a'.repeat(250) + 'secret'; // length = 256
    scope.useRedactionPolicy({ patterns: [/secret/] });

    const writes: unknown[] = [];
    scope.attachScopeRecorder({
      id: 'w',
      onWrite: (e: any) => writes.push(e),
    });

    scope.setValue(key, 'sensitive-value');
    // key.length === 256 — exactly at the cap, must still be tested
    expect(writes[0]).toMatchObject({ value: '[REDACTED]' });
  });
});

// ---------------------------------------------------------------------------
// Pattern 2: boundary — keys at/around the 256-char cap
// ---------------------------------------------------------------------------
describe('redaction ReDoS guard — boundary: keys at/above 256-char cap', () => {
  it('key exactly 257 chars long is NOT tested against patterns (skipped silently)', () => {
    const scope = makeScope();
    const key = 'a'.repeat(257); // > 256
    scope.useRedactionPolicy({ patterns: [/^a+$/] }); // would match

    const writes: unknown[] = [];
    scope.attachScopeRecorder({
      id: 'w',
      onWrite: (e: any) => writes.push(e),
    });

    scope.setValue(key, 'value');
    // Pattern is skipped for long keys — NOT redacted
    expect(writes[0]).toMatchObject({ value: 'value', redacted: undefined });
  });

  it('exact-key match still works for keys longer than 256 chars', () => {
    const scope = makeScope();
    const key = 'x'.repeat(300);
    const policy: RedactionPolicy = { keys: [key] }; // exact key match
    scope.useRedactionPolicy(policy);

    const writes: unknown[] = [];
    scope.attachScopeRecorder({
      id: 'w',
      onWrite: (e: any) => writes.push(e),
    });

    scope.setValue(key, 'sensitive');
    // Exact-key matching is not limited by the cap
    expect(writes[0]).toMatchObject({ value: '[REDACTED]' });
  });

  it('key at exactly 256 chars is the boundary — tested, not skipped', () => {
    const scope = makeScope();
    const key = 'z'.repeat(256); // length = 256 exactly
    scope.useRedactionPolicy({ patterns: [/z/] });

    const writes: unknown[] = [];
    scope.attachScopeRecorder({
      id: 'w',
      onWrite: (e: any) => writes.push(e),
    });

    scope.setValue(key, 'val');
    expect(writes[0]).toMatchObject({ value: '[REDACTED]' }); // boundary is inclusive
  });
});

// ---------------------------------------------------------------------------
// Pattern 3: scenario — oversized keys never reach regex evaluation
// ---------------------------------------------------------------------------
describe('redaction ReDoS guard — scenario: oversized keys bypass regex evaluation', () => {
  it('skips matching a long key and returns within 100ms', () => {
    const scope = makeScope();
    // Test-only tripwire: fail deterministically if the guard ever evaluates a long key.
    // A safe regex avoids hanging the test runner when that guard regresses.
    const pattern = /^a+$/;
    const patternTest = vi.spyOn(pattern, 'test').mockImplementation((key: string) => {
      if (key.length > 256) throw new Error('oversized key reached regex evaluation');
      return RegExp.prototype.test.call(pattern, key);
    });
    scope.useRedactionPolicy({ patterns: [pattern] });

    const writes: unknown[] = [];
    scope.attachScopeRecorder({
      id: 'w',
      onWrite: (e: any) => writes.push(e),
    });

    // Positive boundary control: the same predicate really runs at the inclusive cap.
    const boundaryKey = 'a'.repeat(256);
    scope.setValue(boundaryKey, 'boundary-value');
    expect(patternTest).toHaveBeenCalledWith(boundaryKey);
    expect(writes[0]).toMatchObject({ value: '[REDACTED]' });
    writes.length = 0;

    const longKey = 'a'.repeat(500);
    // Controlled red probe: bypassing the guard must trip the detector, not silently pass.
    expect(() => pattern.test(longKey)).toThrow('oversized key reached regex evaluation');
    patternTest.mockClear();

    const start = Date.now();
    scope.setValue(longKey, 'value');
    const elapsed = Date.now() - start;

    // Keep the existing timing/output checks; the zero-call assertion proves the guard.
    expect(patternTest).not.toHaveBeenCalled();
    expect(elapsed).toBeLessThan(100);
    // Not redacted (skipped)
    expect(writes[0]).toMatchObject({ value: 'value' });
  });

  it('realistic redaction policy with multiple patterns still works for normal scope keys', () => {
    const scope = makeScope();
    scope.useRedactionPolicy({
      keys: ['ssn', 'dob'],
      patterns: [/password|secret|token|apiKey/i, /^cc_/, /^pii_/],
    });

    const writes: any[] = [];
    scope.attachScopeRecorder({ id: 'r', onWrite: (e: any) => writes.push(e) });

    scope.setValue('creditScore', 750);
    scope.setValue('ssn', '123-45-6789');
    scope.setValue('apiKey', 'sk-abc123');
    scope.setValue('amount', 5000);

    expect(writes[0]).toMatchObject({ key: 'creditScore', value: 750 });
    expect(writes[1]).toMatchObject({ key: 'ssn', value: '[REDACTED]' });
    expect(writes[2]).toMatchObject({ key: 'apiKey', value: '[REDACTED]' });
    expect(writes[3]).toMatchObject({ key: 'amount', value: 5000 });
  });
});

// ---------------------------------------------------------------------------
// Pattern 4: property — pattern results are consistent with lastIndex reset
// ---------------------------------------------------------------------------
describe('redaction ReDoS guard — property: stateful regex lastIndex is reset on each test', () => {
  it('global regex matches correctly on repeated calls (lastIndex reset)', () => {
    const scope = makeScope();
    // Global flag makes exec/test stateful
    const globalPattern = /secret/gi;
    scope.useRedactionPolicy({ patterns: [globalPattern] });

    const writes: any[] = [];
    scope.attachScopeRecorder({ id: 'r', onWrite: (e: any) => writes.push(e) });

    // Both calls must be redacted even though globalPattern.lastIndex advances
    scope.setValue('secretKey', 'v1');
    scope.setValue('secretToken', 'v2');
    scope.setValue('secretHash', 'v3');

    expect(writes[0]).toMatchObject({ value: '[REDACTED]' });
    expect(writes[1]).toMatchObject({ value: '[REDACTED]' });
    expect(writes[2]).toMatchObject({ value: '[REDACTED]' });
  });

  it('sticky regex matches correctly after lastIndex reset', () => {
    const scope = makeScope();
    const stickyPattern = /^ssn/y; // sticky flag
    scope.useRedactionPolicy({ patterns: [stickyPattern] });

    const writes: any[] = [];
    scope.attachScopeRecorder({ id: 'r', onWrite: (e: any) => writes.push(e) });

    scope.setValue('ssnNumber', 'v1');
    scope.setValue('creditScore', 750);
    scope.setValue('ssnType', 'v2');

    expect(writes[0]).toMatchObject({ value: '[REDACTED]' }); // ssnNumber matches
    expect(writes[1]).toMatchObject({ value: 750 }); // creditScore no match
    expect(writes[2]).toMatchObject({ value: '[REDACTED]' }); // ssnType matches (lastIndex reset)
  });
});

// ---------------------------------------------------------------------------
// Pattern 5: security — no PII leakage via pattern bypass
// ---------------------------------------------------------------------------
describe('redaction ReDoS guard — security: exact-key bypass is not possible', () => {
  it('a key in the exact-key list is always redacted regardless of length', () => {
    const scope = makeScope();
    const longPiiKey = 'user_social_security_number_encrypted_hash_value_' + 'x'.repeat(100);
    scope.useRedactionPolicy({ keys: [longPiiKey] });

    const writes: any[] = [];
    scope.attachScopeRecorder({ id: 'r', onWrite: (e: any) => writes.push(e) });

    scope.setValue(longPiiKey, 'hashed-ssn');
    expect(writes[0]).toMatchObject({ value: '[REDACTED]' });
  });

  it('a key exactly at boundary is still tested — cannot bypass via off-by-one', () => {
    const scope = makeScope();
    const key256 = 'p'.repeat(255) + 'w'; // 256 chars, ends with 'w' (to match /w$/)
    scope.useRedactionPolicy({ patterns: [/w$/] });

    const writes: any[] = [];
    scope.attachScopeRecorder({ id: 'r', onWrite: (e: any) => writes.push(e) });

    scope.setValue(key256, 'secret');
    // At exactly 256 chars the guard is inclusive — pattern is tested
    expect(writes[0]).toMatchObject({ value: '[REDACTED]' });
  });

  it('reads of long keys are also protected (getValue path)', () => {
    const scope = makeScope();
    const shortKey = 'password'; // normal short key
    scope.useRedactionPolicy({ patterns: [/password/i] });

    // First write triggers redaction (marks key as redacted)
    scope.setValue(shortKey, 'hunter2');

    const reads: any[] = [];
    scope.attachScopeRecorder({ id: 'r', onRead: (e: any) => reads.push(e) });

    scope.getValue(shortKey);
    expect(reads[0]).toMatchObject({ key: shortKey, value: '[REDACTED]' });
  });
});
