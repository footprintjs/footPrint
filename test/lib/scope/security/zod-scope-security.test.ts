import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { flowChart, FlowChartExecutor } from '../../../../src/index.js';
import { defineScopeFromZod } from '../../../../src/zod.js';

describe('Zod scopes preserve the executor security boundaries', () => {
  const shape = {
    locked: z.number(),
    object: z.object({ value: z.number() }),
    array: z.array(z.number()),
    record: z.record(z.string(), z.number()),
  };
  const mutations = [
    { name: 'scalar set', key: 'locked', mutate: (scope: any) => scope.locked.set(2) },
    { name: 'nested field set', key: 'object', mutate: (scope: any) => scope.object.value.set(2) },
    { name: 'array push', key: 'array', mutate: (scope: any) => scope.array.push(2) },
    { name: 'record merge', key: 'record', mutate: (scope: any) => scope.record.merge({ value: 2 }) },
    { name: 'record entry set', key: 'record', mutate: (scope: any) => scope.record.at('value').set(2) },
  ];

  it.each(mutations)('refuses readonly input through $name before any write event', async ({ key, mutate }) => {
    const writes: string[] = [];
    let reached = false;
    const chart = flowChart<any>(
      'Protected',
      (scope) => {
        reached = true;
        expect(() => mutate(scope)).toThrow(`Cannot write to readonly input key "${key}"`);
      },
      'protected',
    ).build();
    const executor = new FlowChartExecutor(chart, {
      scopeFactory: defineScopeFromZod(z.object(shape), { strict: 'deny' }),
    });
    executor.attachScopeRecorder({
      id: 'writes',
      onWrite: (event) => {
        writes.push(event.key);
      },
    });
    const input = { locked: 1, object: { value: 1 }, array: [1], record: { value: 1 } };
    await executor.run({ input });
    expect(reached).toBe(true);
    expect(writes).toEqual([]);
    expect(input).toEqual({ locked: 1, object: { value: 1 }, array: [1], record: { value: 1 } });
  });

  it('exposes ro and getArgs as frozen owned views without freezing the caller', async () => {
    const input = { nested: { value: 1 }, list: [1] };
    let checked = false;
    const chart = flowChart<any>(
      'Args',
      (scope) => {
        const args = scope.getArgs();
        expect(scope.ro).toEqual(args);
        expect(Object.isFrozen(scope.ro)).toBe(true);
        expect(Object.isFrozen(scope.ro.nested)).toBe(true);
        expect(Object.isFrozen(scope.ro.list)).toBe(true);
        expect(() => {
          scope.ro.nested.value = 2;
        }).toThrow(TypeError);
        expect(() => {
          args.list.push(2);
        }).toThrow(TypeError);
        checked = true;
      },
      'args',
    ).build();
    const executor = new FlowChartExecutor(chart, { scopeFactory: defineScopeFromZod(z.object({})) });
    await executor.run({ input });
    expect(checked).toBe(true);
    expect(input).toEqual({ nested: { value: 1 }, list: [1] });
    expect(Object.isFrozen(input)).toBe(false);
    expect(Object.isFrozen(input.nested)).toBe(false);
  });

  it('rejects retained scalar, nested and collection handles after their stage commits', async () => {
    let retained: any;
    const chart = flowChart<any>(
      'Capture',
      (scope) => {
        retained = scope;
        scope.locked.set(1);
      },
      'capture',
    )
      .addFunction(
        'Later',
        () => {
          for (const { mutate } of mutations)
            expect(() => mutate(retained)).toThrow(/committed|finished|no longer|past its stage/i);
        },
        'later',
      )
      .build();
    const executor = new FlowChartExecutor(chart, {
      scopeFactory: defineScopeFromZod(z.object(shape), { strict: 'deny' }),
    });
    await executor.run();
    expect(executor.getSnapshot().sharedState).toMatchObject({ locked: 1 });
    expect(executor.getSnapshot().sharedState.object).toBeUndefined();
  });

  it.each(['inline', 'deferred'] as const)(
    'scrubs scope and emit recordings under %s delivery without changing live values',
    async (delivery) => {
      const events: unknown[] = [];
      const live: unknown[] = [];
      const chart = flowChart<any>(
        'Write',
        (scope) => {
          scope.secret.set('sensitive-token');
          scope.patient.ssn.set('sensitive-ssn');
          scope.patient.name.set('Ada');
        },
        'write',
      )
        .addFunction(
          'Read',
          (scope) => {
            live.push(scope.secret.get(), scope.patient.ssn.get(), scope.patient.get());
            scope.emitEvent('private.result', { secret: scope.secret.get() });
          },
          'read',
        )
        .build();
      const executor = new FlowChartExecutor(chart, {
        scopeFactory: defineScopeFromZod(
          z.object({ secret: z.string(), patient: z.object({ ssn: z.string(), name: z.string() }) }),
        ),
      });
      executor.setRedactionPolicy({ keys: ['secret'], fields: { patient: ['ssn'] }, emitPatterns: [/^private\./] });
      executor.attachCombinedRecorder(
        {
          id: 'security',
          onRead: (event) => {
            events.push({ kind: 'read', key: event.key, value: event.value });
          },
          onWrite: (event) => {
            events.push({ kind: 'write', key: event.key, value: event.value });
          },
          onCommit: (event) => {
            events.push({ kind: 'commit', mutations: event.mutations });
          },
          onEmit: (event) => {
            events.push({ kind: 'emit', payload: event.payload });
          },
        },
        { delivery },
      );
      await executor.run();
      expect(live).toEqual(['sensitive-token', 'sensitive-ssn', { ssn: 'sensitive-ssn', name: 'Ada' }]);
      expect(events).toContainEqual({ kind: 'write', key: 'secret', value: '[REDACTED]' });
      expect(events).toContainEqual({ kind: 'read', key: 'patient.ssn', value: '[REDACTED]' });
      expect(events).toContainEqual({ kind: 'emit', payload: '[REDACTED]' });
      expect(events.filter((event) => (event as { kind: string }).kind === 'commit')).toHaveLength(2);
      expect(JSON.stringify(events)).not.toContain('sensitive-');
      expect(JSON.stringify(executor.getSnapshot().commitLog)).not.toContain('sensitive-');
    },
  );

  it.each(['getArgs', 'setValue', 'emitEvent'])(
    'rejects reserved root convenience name %s when constructing the schema factory',
    (key) => {
      expect(() => defineScopeFromZod(z.object({ [key]: z.string() }))).toThrow(
        new RegExp(`reserved.*${key}|${key}.*reserved`, 'i'),
      );
    },
  );
});

describe('Zod unsafe path admission', () => {
  const denied = ['__proto__', 'constructor', 'prototype'];

  describe.each(['root', 'nested'] as const)('%s schema fields', (location) => {
    it.each(denied)('refuses %s during factory construction, before a write can be reported', (key) => {
      const fields = Object.fromEntries([[key, z.string()]]);
      const schema = z.object(location === 'root' ? fields : { account: z.object(fields) });
      expect(() => defineScopeFromZod(schema)).toThrow(
        new RegExp(`(?:reserved|unsafe|denied).*${key}|${key}.*(?:reserved|unsafe|denied)`, 'i'),
      );
    });
  });

  it.each(denied)('refuses record.at(%s) at accessor admission, before reads or writes', async (key) => {
    const events: string[] = [];
    let reached = false;
    const chart = flowChart<any>(
      'Record',
      (scope) => {
        reached = true;
        expect(() => scope.values.at(key)).toThrow(
          new RegExp(`(?:reserved|unsafe|denied).*${key}|${key}.*(?:reserved|unsafe|denied)`, 'i'),
        );
      },
      'record',
    ).build();
    const executor = new FlowChartExecutor(chart, {
      scopeFactory: defineScopeFromZod(z.object({ values: z.record(z.string(), z.string()) })),
    });
    executor.attachScopeRecorder({
      id: 'no-unsafe-events',
      onRead: () => {
        events.push('read');
      },
      onWrite: () => {
        events.push('write');
      },
    });
    await executor.run();
    expect(reached).toBe(true);
    expect(events).toEqual([]);
    expect(executor.getSnapshot().sharedState.values).toBeUndefined();
    expect((Object.prototype as Record<string, unknown>).polluted).toBeUndefined();
  });

  it.each(['stateful object', 'number', 'null'] as const)(
    'refuses a non-string %s record key before coercion, reads or writes',
    async (kind) => {
      let coercions = 0;
      const key =
        kind === 'stateful object'
          ? { toString: () => (++coercions === 1 ? 'safe' : '__proto__') }
          : kind === 'number'
          ? 7
          : null;
      const events: string[] = [];
      let reached = false;
      const chart = flowChart<any>(
        'Record',
        (scope) => {
          reached = true;
          expect(() => scope.values.at(key)).toThrow(/record key.*string/i);
        },
        'record',
      ).build();
      const executor = new FlowChartExecutor(chart, {
        scopeFactory: defineScopeFromZod(z.object({ values: z.record(z.string(), z.string()) })),
      });
      executor.attachScopeRecorder({
        id: 'non-string-keys',
        onRead: () => {
          events.push('read');
        },
        onWrite: () => {
          events.push('write');
        },
      });
      await executor.run();
      expect(reached).toBe(true);
      expect(coercions).toBe(0);
      expect(events).toEqual([]);
      expect(executor.getSnapshot().sharedState.values).toBeUndefined();
    },
  );

  it('keeps safe own-looking, dotted and empty record keys distinct and observable', async () => {
    const keys = ['hasOwnProperty', 'toString', 'a.b', ''];
    const read: unknown[] = [];
    const writes: string[] = [];
    const chart = flowChart<any>(
      'Write',
      (scope) => {
        for (const key of keys) scope.values.at(key).set(`value:${key}`);
      },
      'write',
    )
      .addFunction(
        'Read',
        (scope) => {
          for (const key of keys) read.push(scope.values.at(key).get());
        },
        'read',
      )
      .build();
    const executor = new FlowChartExecutor(chart, {
      scopeFactory: defineScopeFromZod(z.object({ values: z.record(z.string(), z.string()) })),
    });
    executor.attachScopeRecorder({
      id: 'safe-keys',
      onWrite: (event) => {
        writes.push(event.key);
      },
    });
    await executor.run();
    expect(read).toEqual(keys.map((key) => `value:${key}`));
    expect(writes).toEqual(keys.map((key) => `values.${key}`));
    expect(executor.getSnapshot().sharedState.values).toEqual(
      Object.fromEntries(keys.map((key) => [key, `value:${key}`])),
    );
  });
});
