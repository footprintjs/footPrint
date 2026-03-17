import { EventLog, SharedMemory, StageContext } from '../../../../src/lib/memory';
import { DebugRecorder } from '../../../../src/lib/scope/recorders/DebugRecorder';
import { MetricRecorder } from '../../../../src/lib/scope/recorders/MetricRecorder';
import { NarrativeRecorder } from '../../../../src/lib/scope/recorders/NarrativeRecorder';
import { ScopeFacade } from '../../../../src/lib/scope/ScopeFacade';
import type { RedactionPolicy } from '../../../../src/lib/scope/types';

function makeCtx(runId = 'p1', stageName = 's1') {
  const mem = new SharedMemory();
  const log = new EventLog();
  return new StageContext(runId, stageName, stageName, mem, '', log);
}

describe('RedactionPolicy — scenario (end-to-end with real recorders)', () => {
  const policy: RedactionPolicy = {
    keys: ['ssn'],
    patterns: [/password|secret/i],
    fields: { patient: ['dob', 'ssn'] },
  };

  it('NarrativeRecorder sees redacted values from policy.keys', () => {
    const ctx = makeCtx();
    const scope = new ScopeFacade(ctx, 'Intake');
    const narrative = new NarrativeRecorder({ id: 'n1' });
    scope.attachRecorder(narrative);
    scope.useRedactionPolicy(policy);

    scope.setValue('ssn', '123-45-6789');
    scope.setValue('name', 'Alice');

    const sentences = narrative.toSentences();
    const lines = sentences.get('Intake')!;

    expect(lines.some((l) => l.includes('[REDACTED]'))).toBe(true);
    expect(lines.some((l) => l.includes('123-45-6789'))).toBe(false);
    expect(lines.some((l) => l.includes('Alice'))).toBe(true);
  });

  it('NarrativeRecorder sees redacted values from policy.patterns', () => {
    const ctx = makeCtx();
    const scope = new ScopeFacade(ctx, 'Auth');
    const narrative = new NarrativeRecorder({ id: 'n1' });
    scope.attachRecorder(narrative);
    scope.useRedactionPolicy(policy);

    scope.setValue('dbPassword', 'p@ssw0rd');
    scope.setValue('username', 'bob');

    const sentences = narrative.toSentences();
    const lines = sentences.get('Auth')!;

    expect(lines.some((l) => l.includes('p@ssw0rd'))).toBe(false);
    expect(lines.some((l) => l.includes('[REDACTED]'))).toBe(true);
    expect(lines.some((l) => l.includes('bob'))).toBe(true);
  });

  it('DebugRecorder sees redacted values from policy', () => {
    const ctx = makeCtx();
    const scope = new ScopeFacade(ctx, 'Intake');
    const debug = new DebugRecorder({ id: 'd1', verbosity: 'verbose' });
    scope.attachRecorder(debug);
    scope.useRedactionPolicy(policy);

    scope.notifyStageStart();
    scope.setValue('apiSecret', 'sk-xxx-123');
    scope.setValue('name', 'Alice');
    scope.notifyStageEnd(5);

    const entries = debug.getEntries();
    const secretEntry = entries.find((e) => e.type === 'write' && (e.data as any).key === 'apiSecret');
    const nameEntry = entries.find((e) => e.type === 'write' && (e.data as any).key === 'name');

    expect((secretEntry!.data as any).value).toBe('[REDACTED]');
    expect((nameEntry!.data as any).value).toBe('Alice');
  });

  it('MetricRecorder counts redacted writes', () => {
    const ctx = makeCtx();
    const scope = new ScopeFacade(ctx, 'Intake');
    const metric = new MetricRecorder();
    scope.attachRecorder(metric);
    scope.useRedactionPolicy(policy);

    scope.notifyStageStart();
    scope.setValue('ssn', '123-45-6789');
    scope.setValue('name', 'Alice');
    scope.notifyStageEnd(5);

    const stageMetrics = metric.getStageMetrics('Intake');
    expect(stageMetrics!.writeCount).toBe(2);
  });

  it('field-level redaction: NarrativeRecorder never sees raw secret values', () => {
    const ctx = makeCtx();
    const scope = new ScopeFacade(ctx, 'Intake');
    const narrative = new NarrativeRecorder({ id: 'n1' });
    scope.attachRecorder(narrative);
    scope.useRedactionPolicy(policy);

    scope.setValue('patient', { name: 'Bob', ssn: '999-99-9999', dob: '1985-03-15', bloodType: 'O+' });

    const sentences = narrative.toSentences();
    const lines = sentences.get('Intake')!;

    // NarrativeRecorder summarizes objects by key names, so raw values should never leak
    expect(lines.some((l) => l.includes('999-99-9999'))).toBe(false);
    expect(lines.some((l) => l.includes('1985-03-15'))).toBe(false);
  });

  it('field-level redaction works with DebugRecorder', () => {
    const ctx = makeCtx();
    const scope = new ScopeFacade(ctx, 'Intake');
    const debug = new DebugRecorder({ id: 'd1', verbosity: 'verbose' });
    scope.attachRecorder(debug);
    scope.useRedactionPolicy(policy);

    scope.notifyStageStart();
    scope.setValue('patient', { name: 'Bob', ssn: '999-99-9999', dob: '1985-03-15', bloodType: 'O+' });
    scope.notifyStageEnd(5);

    const entries = debug.getEntries();
    const patientEntry = entries.find((e) => e.type === 'write' && (e.data as any).key === 'patient');
    const val = (patientEntry!.data as any).value as Record<string, unknown>;

    expect(val.name).toBe('Bob');
    expect(val.ssn).toBe('[REDACTED]');
    expect(val.dob).toBe('[REDACTED]');
    expect(val.bloodType).toBe('O+');
  });

  it('cross-stage: policy redaction persists via shared keys', () => {
    const sharedSet = new Set<string>();
    const ctx1 = makeCtx('p1', 'stage1');
    const scope1 = new ScopeFacade(ctx1, 'stage1');
    scope1.useSharedRedactedKeys(sharedSet);
    scope1.useRedactionPolicy(policy);

    // Stage 1 writes ssn (policy auto-redacts → adds to sharedSet)
    scope1.setValue('ssn', '123-45-6789');
    ctx1.commit();

    // Stage 2 — new scope, same shared set
    const ctx2 = makeCtx('p1', 'stage2');
    ctx2.setObject([], 'ssn', '123-45-6789');
    ctx2.commit();
    const scope2 = new ScopeFacade(ctx2, 'stage2');
    scope2.useSharedRedactedKeys(sharedSet);

    const narrative = new NarrativeRecorder({ id: 'n2' });
    scope2.attachRecorder(narrative);
    const val = scope2.getValue('ssn');

    expect(val).toBe('123-45-6789'); // runtime gets real value
    const sentences = narrative.toSentences();
    const lines = sentences.get('stage2')!;
    expect(lines.some((l) => l.includes('[REDACTED]'))).toBe(true);
    expect(lines.some((l) => l.includes('123-45-6789'))).toBe(false);
  });

  it('runtime always returns real values despite policy', () => {
    const ctx = makeCtx();
    const scope = new ScopeFacade(ctx, 'test');
    scope.useRedactionPolicy(policy);

    scope.setValue('ssn', '123-45-6789');
    scope.setValue('patient', { name: 'Alice', ssn: '999', dob: '1990-01-01' });
    ctx.commit();

    expect(scope.getValue('ssn')).toBe('123-45-6789');
    const patient = scope.getValue('patient') as any;
    expect(patient.ssn).toBe('999');
    expect(patient.dob).toBe('1990-01-01');
  });

  // ── Dot-notation (nested field) with real recorders ─────────────────

  it('dot-notation: DebugRecorder sees nested fields scrubbed', () => {
    const ctx = makeCtx();
    const scope = new ScopeFacade(ctx, 'Intake');
    const debug = new DebugRecorder({ id: 'd1', verbosity: 'verbose' });
    scope.attachRecorder(debug);
    scope.useRedactionPolicy({
      fields: { patient: ['address.zip', 'insurance.memberId'] },
    });

    scope.notifyStageStart();
    scope.setValue('patient', {
      name: 'Bob',
      address: { street: '123 Main', city: 'LA', zip: '90210' },
      insurance: { provider: 'Aetna', memberId: 'XYZ-123' },
    });
    scope.notifyStageEnd(5);

    const entries = debug.getEntries();
    const patientEntry = entries.find((e) => e.type === 'write' && (e.data as any).key === 'patient');
    const val = (patientEntry!.data as any).value as any;

    expect(val.name).toBe('Bob');
    expect(val.address.street).toBe('123 Main');
    expect(val.address.zip).toBe('[REDACTED]');
    expect(val.insurance.provider).toBe('Aetna');
    expect(val.insurance.memberId).toBe('[REDACTED]');
  });

  it('dot-notation: NarrativeRecorder never sees raw nested values', () => {
    const ctx = makeCtx();
    const scope = new ScopeFacade(ctx, 'Intake');
    const narrative = new NarrativeRecorder({ id: 'n1' });
    scope.attachRecorder(narrative);
    scope.useRedactionPolicy({
      fields: { patient: ['address.zip'] },
    });

    scope.setValue('patient', {
      name: 'Alice',
      address: { street: '123 Main', zip: '90210' },
    });

    const sentences = narrative.toSentences();
    const lines = sentences.get('Intake')!;

    // NarrativeRecorder summarizes objects by key names, not values
    // Verify raw zip never leaks
    expect(lines.some((l) => l.includes('90210'))).toBe(false);
  });

  it('dot-notation: runtime returns real nested values', () => {
    const ctx = makeCtx();
    const scope = new ScopeFacade(ctx, 'test');
    scope.useRedactionPolicy({
      fields: { patient: ['address.zip'] },
    });

    scope.setValue('patient', { name: 'Alice', address: { zip: '90210' } });
    ctx.commit();

    const patient = scope.getValue('patient') as any;
    expect(patient.address.zip).toBe('90210');
  });
});
