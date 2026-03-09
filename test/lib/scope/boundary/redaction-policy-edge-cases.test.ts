import { EventLog, SharedMemory, StageContext } from '../../../../src/lib/memory';
import { ScopeFacade } from '../../../../src/lib/scope/ScopeFacade';
import type { WriteEvent } from '../../../../src/lib/scope/types';

function makeCtx(runId = 'p1', stageName = 's1') {
  const mem = new SharedMemory();
  const log = new EventLog();
  return new StageContext(runId, stageName, mem, '', log);
}

describe('RedactionPolicy — boundary / edge cases', () => {
  it('empty policy has no effect', () => {
    const scope = new ScopeFacade(makeCtx(), 'test');
    const writes: WriteEvent[] = [];
    scope.attachRecorder({ id: 'r', onWrite: (e) => writes.push(e) });

    scope.useRedactionPolicy({});
    scope.setValue('name', 'Alice');

    expect(writes[0].value).toBe('Alice');
    expect(writes[0].redacted).toBeUndefined();
  });

  it('policy with empty arrays has no effect', () => {
    const scope = new ScopeFacade(makeCtx(), 'test');
    const writes: WriteEvent[] = [];
    scope.attachRecorder({ id: 'r', onWrite: (e) => writes.push(e) });

    scope.useRedactionPolicy({ keys: [], patterns: [], fields: {} });
    scope.setValue('name', 'Alice');

    expect(writes[0].value).toBe('Alice');
  });

  it('field-level: fields not present in object are ignored', () => {
    const scope = new ScopeFacade(makeCtx(), 'test');
    const writes: WriteEvent[] = [];
    scope.attachRecorder({ id: 'r', onWrite: (e) => writes.push(e) });

    scope.useRedactionPolicy({ fields: { user: ['nonExistent'] } });
    scope.setValue('user', { name: 'Alice' });

    const val = writes[0].value as Record<string, unknown>;
    expect(val.name).toBe('Alice');
    expect(Object.prototype.hasOwnProperty.call(val, 'nonExistent')).toBe(false);
  });

  it('field-level: null value in object is scrubbed', () => {
    const scope = new ScopeFacade(makeCtx(), 'test');
    const writes: WriteEvent[] = [];
    scope.attachRecorder({ id: 'r', onWrite: (e) => writes.push(e) });

    scope.useRedactionPolicy({ fields: { data: ['secret'] } });
    scope.setValue('data', { secret: null, other: 'ok' });

    const val = writes[0].value as Record<string, unknown>;
    expect(val.secret).toBe('[REDACTED]');
    expect(val.other).toBe('ok');
  });

  it('field-level: original object is NOT mutated', () => {
    const scope = new ScopeFacade(makeCtx(), 'test');
    scope.attachRecorder({ id: 'r', onWrite: () => {} });

    scope.useRedactionPolicy({ fields: { user: ['ssn'] } });
    const original = { name: 'Alice', ssn: '123' };
    scope.setValue('user', original);

    expect(original.ssn).toBe('123'); // original untouched
  });

  it('pattern with global flag does not cause stateful issues', () => {
    const scope = new ScopeFacade(makeCtx(), 'test');
    const writes: WriteEvent[] = [];
    scope.attachRecorder({ id: 'r', onWrite: (e) => writes.push(e) });

    // Global regex has lastIndex state — make sure we handle it
    scope.useRedactionPolicy({ patterns: [/secret/gi] });
    scope.setValue('secret1', 'a');
    scope.setValue('secret2', 'b');
    scope.setValue('secret3', 'c');

    expect(writes.every((w) => w.value === '[REDACTED]')).toBe(true);
  });

  it('key that matches both policy.keys and policy.patterns is redacted (no double-processing)', () => {
    const scope = new ScopeFacade(makeCtx(), 'test');
    const writes: WriteEvent[] = [];
    scope.attachRecorder({ id: 'r', onWrite: (e) => writes.push(e) });

    scope.useRedactionPolicy({ keys: ['ssn'], patterns: [/ssn/] });
    scope.setValue('ssn', '123');

    expect(writes).toHaveLength(1);
    expect(writes[0].value).toBe('[REDACTED]');
  });

  it('key with field-level policy AND exact key policy: exact wins (fully redacted)', () => {
    const scope = new ScopeFacade(makeCtx(), 'test');
    const writes: WriteEvent[] = [];
    scope.attachRecorder({ id: 'r', onWrite: (e) => writes.push(e) });

    scope.useRedactionPolicy({ keys: ['user'], fields: { user: ['ssn'] } });
    scope.setValue('user', { name: 'Alice', ssn: '123' });

    // Exact key match takes precedence → entire value is '[REDACTED]'
    expect(writes[0].value).toBe('[REDACTED]');
  });

  it('deleteValue clears key from redactedKeys even if policy would match', () => {
    const ctx = makeCtx();
    const scope = new ScopeFacade(ctx, 'test');
    scope.useRedactionPolicy({ keys: ['token'] });
    scope.setValue('token', 'xyz');
    ctx.commit();
    expect(scope.getRedactedKeys().has('token')).toBe(true);

    scope.deleteValue('token');
    expect(scope.getRedactedKeys().has('token')).toBe(false);

    // But setting it again should re-trigger policy
    scope.setValue('token', 'new-xyz');
    expect(scope.getRedactedKeys().has('token')).toBe(true);
  });

  it('useRedactionPolicy can be called multiple times (last wins)', () => {
    const scope = new ScopeFacade(makeCtx(), 'test');
    const writes: WriteEvent[] = [];
    scope.attachRecorder({ id: 'r', onWrite: (e) => writes.push(e) });

    scope.useRedactionPolicy({ keys: ['a'] });
    scope.useRedactionPolicy({ keys: ['b'] });

    scope.setValue('a', '1');
    scope.setValue('b', '2');

    // After second call, only 'b' is in policy.keys
    expect(writes[0].value).toBe('1'); // 'a' no longer in policy
    expect(writes[1].value).toBe('[REDACTED]'); // 'b' is in policy
  });

  it('getRedactionReport includes both policy-redacted and manually-redacted keys', () => {
    const scope = new ScopeFacade(makeCtx(), 'test');
    scope.useRedactionPolicy({ keys: ['ssn'], patterns: [/token/i] });
    scope.setValue('ssn', '123');
    scope.setValue('authToken', 'xyz');
    scope.setValue('manual', 'val', true); // manual redaction

    const report = scope.getRedactionReport();
    expect(report.redactedKeys).toContain('ssn');
    expect(report.redactedKeys).toContain('authToken');
    expect(report.redactedKeys).toContain('manual');
  });

  it('no recorders attached: policy still tracks redacted keys', () => {
    const scope = new ScopeFacade(makeCtx(), 'test');
    scope.useRedactionPolicy({ keys: ['ssn'] });
    scope.setValue('ssn', '123');
    expect(scope.getRedactedKeys().has('ssn')).toBe(true);
  });
});
