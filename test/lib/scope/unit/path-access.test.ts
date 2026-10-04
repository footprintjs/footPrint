import { describe, expect, it } from 'vitest';

import { EventLog, SharedMemory, StageContext } from '../../../../src/lib/memory/index.js';
import { ScopeFacade } from '../../../../src/lib/scope/ScopeFacade.js';

function fixture(input?: unknown) {
  const context = new StageContext('paths', 'step', 'step', new SharedMemory(), '', new EventLog({}));
  return { context, scope: new ScopeFacade(context, 'step', input) };
}

describe('Facade path access shares the flat read/write policy', () => {
  it('keeps literal dotted keys separate from nested paths, including an empty child key', () => {
    const { scope } = fixture();
    scope.setValue('a.b', 1);
    scope.setValueAt(['a'], 'b', 2);
    scope.setValueAt(['a'], '', 3);
    expect(scope.getValue('a.b')).toBe(1);
    expect(scope.getValueAt(['a'], 'b')).toBe(2);
    expect(scope.getValueAt(['a'], '')).toBe(3);
    expect(scope.getValue('a')).toEqual({ b: 2, '': 3 });
  });

  it('emits nested reads and writes with the same rule used by retained state', () => {
    const { scope } = fixture();
    const events: unknown[] = [];
    scope.useRedactionPolicy({ fields: { account: ['secret'] } });
    scope.attachScopeRecorder({ id: 'paths', onRead: (e) => events.push(e), onWrite: (e) => events.push(e) });
    scope.setValueAt(['account'], 'secret', 'hidden-value');
    expect(scope.getValueAt(['account'], 'secret')).toBe('hidden-value');
    expect(events).toHaveLength(2);
    expect(events).toEqual([
      expect.objectContaining({ key: 'account.secret', value: '[REDACTED]', operation: 'set' }),
      expect.objectContaining({ key: 'account.secret', value: '[REDACTED]' }),
    ]);
    expect(JSON.stringify(events)).not.toContain('hidden-value');
  });

  it.each(['set', 'update'] as const)('refuses a nested %s under an input root', (method) => {
    const { scope } = fixture({ account: { value: 1 } });
    expect(() => {
      if (method === 'set') scope.setValueAt(['account'], 'value', 2);
      else scope.updateValueAt(['account'], 'value', 2);
    }).toThrow(/readonly input key "account"/);
    expect(scope.getValue('account')).toBeUndefined();
  });

  it.each(['set', 'update'] as const)('refuses a nested %s through a committed handle', (method) => {
    const { scope, context } = fixture();
    scope.setValueAt(['account'], 'value', 1);
    context.commit();
    expect(() => {
      if (method === 'set') scope.setValueAt(['account'], 'value', 2);
      else scope.updateValueAt(['account'], 'value', 2);
    }).toThrow(/committed/);
    expect(scope.getValueAt(['account'], 'value')).toBe(1);
  });
});
