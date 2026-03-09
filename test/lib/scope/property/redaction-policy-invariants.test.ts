import fc from 'fast-check';

import { EventLog, SharedMemory, StageContext } from '../../../../src/lib/memory';
import { ScopeFacade } from '../../../../src/lib/scope/ScopeFacade';
import type { WriteEvent } from '../../../../src/lib/scope/types';

function makeCtx(runId = 'p1', stageName = 's1') {
  const mem = new SharedMemory();
  const log = new EventLog();
  return new StageContext(runId, stageName, mem, '', log);
}

describe('RedactionPolicy — property-based invariants', () => {
  it('policy.keys: matched keys never leak to any recorder', () => {
    fc.assert(
      fc.property(fc.string({ minLength: 1 }), fc.string(), (key, value) => {
        const scope = new ScopeFacade(makeCtx(), 'test');
        const writes: WriteEvent[] = [];
        scope.attachRecorder({ id: 'r1', onWrite: (e) => writes.push(e) });
        scope.attachRecorder({ id: 'r2', onWrite: (e) => writes.push(e) });

        scope.useRedactionPolicy({ keys: [key] });
        scope.setValue(key, value);

        return writes.every((w) => w.value === '[REDACTED]' && w.redacted === true);
      }),
      { numRuns: 100 },
    );
  });

  it('policy.patterns: matched keys never leak to any recorder', () => {
    fc.assert(
      fc.property(fc.string({ minLength: 1 }), fc.string(), (key, value) => {
        const scope = new ScopeFacade(makeCtx(), 'test');
        const writes: WriteEvent[] = [];
        scope.attachRecorder({ id: 'r', onWrite: (e) => writes.push(e) });

        // Use exact string match as pattern
        const pattern = new RegExp(`^${key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`);
        scope.useRedactionPolicy({ patterns: [pattern] });
        scope.setValue(key, value);

        return writes.every((w) => w.value === '[REDACTED]');
      }),
      { numRuns: 100 },
    );
  });

  it('non-matching keys are never redacted by policy', () => {
    fc.assert(
      fc.property(
        fc.string({ minLength: 1 }).filter((s) => s !== 'ssn'),
        fc.string(),
        (key, value) => {
          const scope = new ScopeFacade(makeCtx(), 'test');
          const writes: WriteEvent[] = [];
          scope.attachRecorder({ id: 'r', onWrite: (e) => writes.push(e) });

          scope.useRedactionPolicy({ keys: ['ssn'] });
          scope.setValue(key, value);

          return writes.every((w) => w.value === value && w.redacted === undefined);
        },
      ),
      { numRuns: 100 },
    );
  });

  it('runtime always returns real value regardless of policy', () => {
    fc.assert(
      fc.property(fc.string({ minLength: 1 }), fc.string(), (key, value) => {
        const ctx = makeCtx();
        const scope = new ScopeFacade(ctx, 'test');
        scope.useRedactionPolicy({ keys: [key], patterns: [/./] });
        scope.setValue(key, value);
        ctx.commit();
        return scope.getValue(key) === value;
      }),
      { numRuns: 100 },
    );
  });

  it('field-level scrubbing preserves non-redacted fields', () => {
    fc.assert(
      fc.property(fc.string({ minLength: 1 }), fc.string(), fc.string(), (safeField, secretField, secretValue) => {
        // Ensure different field names
        const safe = `safe_${safeField}`;
        const secret = `secret_${secretField}`;
        const scope = new ScopeFacade(makeCtx(), 'test');
        const writes: WriteEvent[] = [];
        scope.attachRecorder({ id: 'r', onWrite: (e) => writes.push(e) });

        scope.useRedactionPolicy({ fields: { data: [secret] } });
        scope.setValue('data', { [safe]: 'visible', [secret]: secretValue });

        const val = writes[0].value as Record<string, unknown>;
        return val[safe] === 'visible' && val[secret] === '[REDACTED]';
      }),
      { numRuns: 50 },
    );
  });

  it('getRedactionReport only contains key names, field names, and pattern sources', () => {
    fc.assert(
      fc.property(fc.string({ minLength: 1 }), (key) => {
        const scope = new ScopeFacade(makeCtx(), 'test');
        const secretValue = `SECRET_${Math.random()}_VALUE`;
        scope.useRedactionPolicy({ keys: [key] });
        scope.setValue(key, secretValue);

        const report = scope.getRedactionReport();
        const reportStr = JSON.stringify(report);
        // The unique secret value should never appear in the report
        return !reportStr.includes(secretValue);
      }),
      { numRuns: 100 },
    );
  });
});
