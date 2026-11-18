import { SharedMemory } from 'foottrace/write';
import { describe, expect, it } from 'vitest';
import { ScopeFacade } from '../../scope/ScopeFacade.js';
import { RedactionRule, SCOPE_PLACEHOLDER } from '../redaction.js';
import { runPolicy } from '../runPolicy.js';
import { StageContext } from '../StageContext.js';

describe('public/default parity without any live authority observation', () => {
  it('keeps observer shape, privacy and borrowed values', () => {
    const ctx = new StageContext('run', 'stage', 'stage', new SharedMemory());
    ctx.usePolicy(runPolicy({ readTracking: 'off' }, new RedactionRule({ keys: ['secret'] })));
    const facade = new ScopeFacade(ctx, 'stage');
    const events = [];
    facade.attachScopeRecorder({ id: 'witness', onRead: (event) => events.push(event) });
    const value = { count: 2 };
    facade.setValue('public', value);
    facade.setValue('secret', value);
    expect(facade.getValue('public')).toBe(value);
    expect(facade.getValue('secret')).toBe(value);
    expect(events.map((event) => event.value)).toEqual([value, SCOPE_PLACEHOLDER]);
    for (const event of events) {
      expect(Object.keys(event)).toEqual([
        'stageName',
        'stageId',
        'runtimeStageId',
        'pipelineId',
        'timestamp',
        'key',
        'value',
        'redacted',
      ]);
      expect(Object.hasOwn(event, 'path')).toBe(false);
    }
    expect(Object.isFrozen(value)).toBe(false);
  });

  it('keeps once-only recorder invocation and isolates its original error', () => {
    const ctx = new StageContext('run', 'stage', 'stage', new SharedMemory());
    const facade = new ScopeFacade(ctx, 'stage');
    const original = new Error('observer');
    const calls = [];
    facade.attachScopeRecorder({
      id: 'thrower',
      onRead() {
        calls.push('read');
        throw original;
      },
      onError(event) {
        calls.push(event.error.raw);
      },
    });
    facade.setValue('public', 7);
    expect(facade.getValue('public')).toBe(7);
    expect(calls).toEqual(['read', original]);
  });
});
