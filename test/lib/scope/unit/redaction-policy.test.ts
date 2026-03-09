import { EventLog, SharedMemory, StageContext } from '../../../../src/lib/memory';
import { ScopeFacade } from '../../../../src/lib/scope/ScopeFacade';
import type { ReadEvent, RedactionPolicy, WriteEvent } from '../../../../src/lib/scope/types';

function makeCtx(runId = 'p1', stageName = 's1') {
  const mem = new SharedMemory();
  const log = new EventLog();
  return new StageContext(runId, stageName, mem, '', log);
}

describe('RedactionPolicy — unit', () => {
  // ── Exact key matching ──────────────────────────────────────────────

  it('policy.keys auto-redacts matching keys on setValue', () => {
    const scope = new ScopeFacade(makeCtx(), 'test');
    const writes: WriteEvent[] = [];
    scope.attachRecorder({ id: 'r', onWrite: (e) => writes.push(e) });

    scope.useRedactionPolicy({ keys: ['ssn', 'creditCard'] });
    scope.setValue('ssn', '123-45-6789');

    expect(writes[0].value).toBe('[REDACTED]');
    expect(writes[0].redacted).toBe(true);
  });

  it('policy.keys does not redact non-matching keys', () => {
    const scope = new ScopeFacade(makeCtx(), 'test');
    const writes: WriteEvent[] = [];
    scope.attachRecorder({ id: 'r', onWrite: (e) => writes.push(e) });

    scope.useRedactionPolicy({ keys: ['ssn'] });
    scope.setValue('name', 'Alice');

    expect(writes[0].value).toBe('Alice');
    expect(writes[0].redacted).toBeUndefined();
  });

  it('policy.keys adds key to shared redactedKeys set', () => {
    const scope = new ScopeFacade(makeCtx(), 'test');
    scope.useRedactionPolicy({ keys: ['token'] });
    scope.setValue('token', 'bearer-xyz');
    expect(scope.getRedactedKeys().has('token')).toBe(true);
  });

  // ── Pattern matching ────────────────────────────────────────────────

  it('policy.patterns auto-redacts keys matching a regex', () => {
    const scope = new ScopeFacade(makeCtx(), 'test');
    const writes: WriteEvent[] = [];
    scope.attachRecorder({ id: 'r', onWrite: (e) => writes.push(e) });

    scope.useRedactionPolicy({ patterns: [/password|secret|apiKey/i] });
    scope.setValue('userPassword', 'hunter2');
    scope.setValue('API_SECRET', 'sk-xxx');
    scope.setValue('name', 'Alice');

    expect(writes[0].value).toBe('[REDACTED]');
    expect(writes[1].value).toBe('[REDACTED]');
    expect(writes[2].value).toBe('Alice');
  });

  it('multiple patterns are checked (any match triggers redaction)', () => {
    const scope = new ScopeFacade(makeCtx(), 'test');
    const writes: WriteEvent[] = [];
    scope.attachRecorder({ id: 'r', onWrite: (e) => writes.push(e) });

    scope.useRedactionPolicy({ patterns: [/^cc_/, /^ssn$/] });
    scope.setValue('cc_number', '4111...');
    scope.setValue('ssn', '123-45-6789');

    expect(writes[0].value).toBe('[REDACTED]');
    expect(writes[1].value).toBe('[REDACTED]');
  });

  // ── Field-level redaction ───────────────────────────────────────────

  it('policy.fields scrubs specific fields in object values on setValue', () => {
    const scope = new ScopeFacade(makeCtx(), 'test');
    const writes: WriteEvent[] = [];
    scope.attachRecorder({ id: 'r', onWrite: (e) => writes.push(e) });

    scope.useRedactionPolicy({ fields: { user: ['ssn', 'dob'] } });
    scope.setValue('user', { name: 'Alice', ssn: '123-45-6789', dob: '1990-01-01', role: 'admin' });

    const scrubbed = writes[0].value as Record<string, unknown>;
    expect(scrubbed.name).toBe('Alice');
    expect(scrubbed.ssn).toBe('[REDACTED]');
    expect(scrubbed.dob).toBe('[REDACTED]');
    expect(scrubbed.role).toBe('admin');
    expect(writes[0].redacted).toBe(true);
  });

  it('policy.fields scrubs on getValue too', () => {
    const ctx = makeCtx();
    const scope = new ScopeFacade(ctx, 'test');
    scope.useRedactionPolicy({ fields: { user: ['ssn'] } });
    scope.setValue('user', { name: 'Bob', ssn: '999-99-9999' });
    ctx.commit();

    const reads: ReadEvent[] = [];
    scope.attachRecorder({ id: 'r', onRead: (e) => reads.push(e) });
    const value = scope.getValue('user') as any;

    // Runtime gets real value
    expect(value.ssn).toBe('999-99-9999');
    // Recorder gets scrubbed
    expect((reads[0].value as any).ssn).toBe('[REDACTED]');
    expect(reads[0].redacted).toBe(true);
  });

  it('policy.fields scrubs on updateValue', () => {
    const ctx = makeCtx();
    const scope = new ScopeFacade(ctx, 'test');
    const writes: WriteEvent[] = [];
    scope.attachRecorder({ id: 'r', onWrite: (e) => writes.push(e) });

    scope.useRedactionPolicy({ fields: { patient: ['ssn'] } });
    scope.setValue('patient', { name: 'Alice', ssn: '111' });
    ctx.commit();
    scope.updateValue('patient', { name: 'Alice', ssn: '222', extra: true });

    const update = writes[1];
    expect((update.value as any).ssn).toBe('[REDACTED]');
    expect((update.value as any).extra).toBe(true);
  });

  it('field-level redaction ignores non-object values gracefully', () => {
    const scope = new ScopeFacade(makeCtx(), 'test');
    const writes: WriteEvent[] = [];
    scope.attachRecorder({ id: 'r', onWrite: (e) => writes.push(e) });

    scope.useRedactionPolicy({ fields: { user: ['ssn'] } });
    scope.setValue('user', 'not-an-object');

    // Non-object: no scrubbing, value passed through
    expect(writes[0].value).toBe('not-an-object');
  });

  // ── Combined policy ─────────────────────────────────────────────────

  it('exact keys + patterns + fields work together', () => {
    const scope = new ScopeFacade(makeCtx(), 'test');
    const writes: WriteEvent[] = [];
    scope.attachRecorder({ id: 'r', onWrite: (e) => writes.push(e) });

    scope.useRedactionPolicy({
      keys: ['creditCard'],
      patterns: [/token/i],
      fields: { user: ['dob'] },
    });

    scope.setValue('creditCard', '4111-1111-1111-1111');
    scope.setValue('authToken', 'bearer-xyz');
    scope.setValue('user', { name: 'Alice', dob: '1990-01-01' });
    scope.setValue('name', 'Bob');

    expect(writes[0].value).toBe('[REDACTED]'); // exact key
    expect(writes[1].value).toBe('[REDACTED]'); // pattern
    expect((writes[2].value as any).dob).toBe('[REDACTED]'); // field
    expect((writes[2].value as any).name).toBe('Alice');
    expect(writes[3].value).toBe('Bob'); // not matched
  });

  // ── Policy + manual shouldRedact coexistence ────────────────────────

  it('manual shouldRedact=true works alongside policy', () => {
    const scope = new ScopeFacade(makeCtx(), 'test');
    const writes: WriteEvent[] = [];
    scope.attachRecorder({ id: 'r', onWrite: (e) => writes.push(e) });

    scope.useRedactionPolicy({ keys: ['ssn'] });
    scope.setValue('ssn', '123'); // policy redacts
    scope.setValue('custom', 'val', true); // manual redacts

    expect(writes[0].value).toBe('[REDACTED]');
    expect(writes[1].value).toBe('[REDACTED]');
  });

  // ── getRedactionReport ──────────────────────────────────────────────

  it('getRedactionReport returns correct data', () => {
    const scope = new ScopeFacade(makeCtx(), 'test');
    scope.useRedactionPolicy({
      keys: ['ssn'],
      patterns: [/password/i],
      fields: { user: ['dob', 'ssn'] },
    });
    scope.setValue('ssn', '123');
    scope.setValue('myPassword', 'secret');

    const report = scope.getRedactionReport();
    expect(report.redactedKeys).toContain('ssn');
    expect(report.redactedKeys).toContain('myPassword');
    expect(report.fieldRedactions).toEqual({ user: ['dob', 'ssn'] });
    expect(report.patterns).toEqual(['password']);
  });

  it('getRedactionReport with no policy returns empty', () => {
    const scope = new ScopeFacade(makeCtx(), 'test');
    const report = scope.getRedactionReport();
    expect(report.redactedKeys).toEqual([]);
    expect(report.fieldRedactions).toEqual({});
    expect(report.patterns).toEqual([]);
  });

  // ── getRedactionPolicy ──────────────────────────────────────────────

  it('getRedactionPolicy returns undefined before useRedactionPolicy', () => {
    const scope = new ScopeFacade(makeCtx(), 'test');
    expect(scope.getRedactionPolicy()).toBeUndefined();
  });

  it('getRedactionPolicy returns the policy after setting it', () => {
    const scope = new ScopeFacade(makeCtx(), 'test');
    const policy: RedactionPolicy = { keys: ['ssn'], patterns: [/token/] };
    scope.useRedactionPolicy(policy);
    expect(scope.getRedactionPolicy()).toBe(policy);
  });
});
