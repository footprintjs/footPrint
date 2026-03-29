import { EventLog, SharedMemory, StageContext } from '../../../../src/lib/memory';
import { DebugRecorder } from '../../../../src/lib/scope/recorders/DebugRecorder';
import { MetricRecorder } from '../../../../src/lib/scope/recorders/MetricRecorder';
import { ScopeFacade } from '../../../../src/lib/scope/ScopeFacade';

function makeCtx(runId = 'p1', stageName = 's1') {
  return new StageContext(runId, stageName, stageName, new SharedMemory(), '', new EventLog());
}

describe('Scenario: redaction across recorders', () => {
  it('DebugRecorder stores [REDACTED] value in entries for redacted keys', () => {
    const ctx = makeCtx();
    const scope = new ScopeFacade(ctx, 'ProcessPayment');
    const debug = new DebugRecorder({ id: 'd1', verbosity: 'verbose' });
    scope.attachRecorder(debug);

    scope.setValue('cardNumber', '4111-1111-1111-1111', true);
    scope.setValue('amount', 99.99);

    const entries = debug.getEntries();
    expect(entries).toHaveLength(2);

    // Card number entry should have redacted value
    const cardEntry = entries[0].data as { key: string; value: unknown };
    expect(cardEntry.key).toBe('cardNumber');
    expect(cardEntry.value).toBe('[REDACTED]');

    // Amount should be normal
    const amountEntry = entries[1].data as { key: string; value: unknown };
    expect(amountEntry.key).toBe('amount');
    expect(amountEntry.value).toBe(99.99);
  });

  it('DebugRecorder read entries show [REDACTED] for redacted keys', () => {
    const ctx = makeCtx();
    const scope = new ScopeFacade(ctx, 'Verify');
    const debug = new DebugRecorder({ id: 'd1', verbosity: 'verbose' });

    scope.setValue('ssn', '123-45-6789', true);
    ctx.commit();

    scope.attachRecorder(debug);
    scope.getValue('ssn');
    scope.getValue('name');

    const entries = debug.getEntries();
    const ssnRead = entries[0].data as { key: string; value: unknown };
    expect(ssnRead.key).toBe('ssn');
    expect(ssnRead.value).toBe('[REDACTED]');

    const nameRead = entries[1].data as { key: string; value: unknown };
    expect(nameRead.key).toBe('name');
    expect(nameRead.value).toBeUndefined();
  });

  it('MetricRecorder still counts redacted operations normally', () => {
    const ctx = makeCtx();
    const scope = new ScopeFacade(ctx, 'Ingest');
    const metrics = new MetricRecorder('m1');
    scope.attachRecorder(metrics);

    scope.setValue('apiKey', 'sk-secret', true);
    scope.setValue('endpoint', '/api/data');
    ctx.commit();
    scope.getValue('apiKey');
    scope.getValue('endpoint');

    const m = metrics.getMetrics();
    expect(m.totalWrites).toBe(2);
    expect(m.totalReads).toBe(2);
  });

  it('DebugRecorder sees consistent redaction for the same operation', () => {
    const ctx = makeCtx();
    const scope = new ScopeFacade(ctx, 'Sync');
    const debug = new DebugRecorder({ id: 'd1', verbosity: 'verbose' });
    const metrics = new MetricRecorder('m1');

    scope.attachRecorder(debug);
    scope.attachRecorder(metrics);

    scope.setValue('token', 'bearer-xyz', true);
    scope.setValue('userId', 'user-42');
    ctx.commit();
    scope.getValue('token');

    // Debug: token entries redacted
    const debugEntries = debug.getEntries();
    const tokenWrite = debugEntries[0].data as { key: string; value: unknown };
    expect(tokenWrite.value).toBe('[REDACTED]');
    const tokenRead = debugEntries[2].data as { key: string; value: unknown };
    expect(tokenRead.value).toBe('[REDACTED]');

    // Metrics: counts are correct regardless
    expect(metrics.getMetrics().totalWrites).toBe(2);
    expect(metrics.getMetrics().totalReads).toBe(1);
  });

  it('runtime getValue still returns real value despite recorder redaction', () => {
    const ctx = makeCtx();
    const scope = new ScopeFacade(ctx, 'Runtime');
    const debug = new DebugRecorder({ id: 'd1', verbosity: 'verbose' });
    scope.attachRecorder(debug);

    scope.setValue('apiSecret', 'real-secret-value', true);
    ctx.commit();
    const runtimeValue = scope.getValue('apiSecret');

    // Runtime gets the real value
    expect(runtimeValue).toBe('real-secret-value');

    // Debug recorder got redacted value
    const readEntry = debug.getEntries().find((e) => e.type === 'read');
    expect((readEntry!.data as { value: unknown }).value).toBe('[REDACTED]');
  });

  it('shared redacted keys persist across stages with different scope instances', () => {
    const sharedSet = new Set<string>();
    const debug = new DebugRecorder({ id: 'd1', verbosity: 'verbose' });

    // Stage 1: set redacted value
    const ctx1 = makeCtx('p1', 'Collect');
    const scope1 = new ScopeFacade(ctx1, 'Collect');
    scope1.useSharedRedactedKeys(sharedSet);
    scope1.attachRecorder(debug);
    scope1.setValue('apiKey', 'sk-live-secret', true);
    scope1.setValue('region', 'us-east-1');
    ctx1.commit();

    // Stage 2: read the redacted value in a new scope
    const ctx2 = makeCtx('p1', 'Use');
    ctx2.setObject([], 'apiKey', 'sk-live-secret');
    ctx2.setObject([], 'region', 'us-east-1');
    ctx2.commit();
    const scope2 = new ScopeFacade(ctx2, 'Use');
    scope2.useSharedRedactedKeys(sharedSet);
    scope2.attachRecorder(debug);
    scope2.getValue('apiKey');
    scope2.getValue('region');

    // Debug: read of apiKey in stage 2 is redacted
    const useEntries = debug.getEntriesForStage('Use');
    const apiKeyRead = useEntries.find((e) => e.type === 'read' && (e.data as { key: string }).key === 'apiKey');
    expect((apiKeyRead!.data as { value: unknown }).value).toBe('[REDACTED]');

    const regionRead = useEntries.find((e) => e.type === 'read' && (e.data as { key: string }).key === 'region');
    expect((regionRead!.data as { value: unknown }).value).toBe('us-east-1');
  });
});
