/** The engine serves its real fold base through the current state rule. */
import { stateAt } from 'foottrace';
import { describe, expect, it } from 'vitest';

import type { PausableHandler, TypedScope } from '../../../src/index.js';
import { flowChart, FlowChartExecutor } from '../../../src/index.js';
import { RedactionRule } from '../../../src/lib/memory/redaction.js';
import { RUN_NAMESPACE } from '../../../src/lib/memory/runAddress.js';
import { runPolicy } from '../../../src/lib/memory/runPolicy.js';
import { ExecutionRuntime } from '../../../src/lib/runner/ExecutionRuntime.js';

describe('redacted fold base', () => {
  it('keeps public default/initial values and masks seeded secrets that no stage rewrites', async () => {
    const chart = flowChart(
      'Touch',
      (scope) => {
        scope.done = true;
      },
      'touch',
    ).build();
    const executor = new FlowChartExecutor(chart, {
      defaultValuesForContext: { region: 'west', token: 'DEFAULT-SECRET' },
      initialContext: {
        tenant: 'owner',
        password: 'INITIAL-SECRET',
        profile: { private: 'FIELD-SECRET', city: 'NYC' },
      },
    });
    executor.setRedactionPolicy({ keys: ['token'], patterns: [/password/], fields: { profile: ['private'] } });
    await executor.run();
    const safe = executor.getSnapshot({ redact: true });
    const expected = {
      region: 'west',
      tenant: 'owner',
      token: 'REDACTED',
      password: 'REDACTED',
      profile: { private: 'REDACTED', city: 'NYC' },
    };
    expect(safe.initialState).toEqual(expected);
    expect(stateAt(safe, -1)).toMatchObject({ basis: 'initial+log', state: expected });
    expect(JSON.stringify(safe)).not.toMatch(/DEFAULT-SECRET|INITIAL-SECRET|FIELD-SECRET/);
    expect(executor.getSnapshot().initialState).toMatchObject({ token: 'DEFAULT-SECRET', password: 'INITIAL-SECRET' });
  });

  it('folds the inherited public reading before a fresh resumed leg without exposing its private checkpoint', async () => {
    type State = { reading?: string; secret?: string; answer?: string };
    const handler: PausableHandler<TypedScope<State>, string> = {
      execute: async () => ({ question: 'Confirm?' }),
      resume: async (scope, value) => {
        scope.answer = value;
      },
    };
    const chart = flowChart<State>(
      'Read',
      (scope) => {
        scope.reading = 'last 2 hours';
        scope.secret = 'PRIVATE-CHECKPOINT';
      },
      'read',
    )
      .addPausableFunction('Confirm', handler, 'confirm')
      .build();
    const paused = new FlowChartExecutor(chart);
    paused.setRedactionPolicy({ keys: ['secret'] });
    await paused.run();
    const checkpoint = paused.getCheckpoint()!;
    expect(checkpoint.sharedState.secret).toBe('PRIVATE-CHECKPOINT');
    const resumed = new FlowChartExecutor(chart);
    resumed.setRedactionPolicy({ keys: ['secret'] });
    await resumed.resume(checkpoint, 'confirmed');
    const safe = resumed.getSnapshot({ redact: true });
    expect(stateAt(safe, -1).state).toMatchObject({ reading: 'last 2 hours', secret: 'REDACTED' });
    expect(stateAt(safe, -1).state.answer).toBeUndefined();
    expect(stateAt(safe, 0).state.answer).toBe('confirmed');
    expect(JSON.stringify(safe)).not.toContain('PRIVATE-CHECKPOINT');
    expect(checkpoint.sharedState.secret).toBe('PRIVATE-CHECKPOINT');
    expect(resumed.getSnapshot().initialState?.secret).toBe('PRIVATE-CHECKPOINT');
  });

  it('applies later whole-key and inherited field marks rather than caching an earlier served base', () => {
    const rule = new RedactionRule();
    const runtime = new ExecutionRuntime(
      'Fixture',
      'fixture',
      undefined,
      { token: 'LATE-KEY', profile: { secret: 'LATE-FIELD', public: 'kept' } },
      runPolicy({}, rule, true),
    );
    const before = runtime.getSnapshot({ redact: true });
    expect(before.initialState).toEqual({ token: 'LATE-KEY', profile: { secret: 'LATE-FIELD', public: 'kept' } });
    rule.mark('token');
    rule.inheritFields('profile', ['secret']);
    const after = runtime.getSnapshot({ redact: true });
    expect(after.initialState).toEqual({ token: 'REDACTED', profile: { secret: 'REDACTED', public: 'kept' } });
    expect(runtime.getSnapshot().initialState?.token).toBe('LATE-KEY');
    expect(before.initialState?.token).toBe('LATE-KEY', 'a previously served value remains its own frozen snapshot');
  });

  it('keeps a per-call private checkpoint mark on a fresh resume with an otherwise empty policy', async () => {
    type State = { reading?: string; secret?: string; answer?: string };
    const handler: PausableHandler<TypedScope<State>, string> = {
      execute: async () => ({ question: 'Confirm?' }),
      resume: async (scope, value) => {
        scope.answer = value;
      },
    };
    const chart = flowChart<State>(
      'Read',
      (scope) => {
        scope.reading = 'public inherited reading';
        scope.$setValue('secret', 'MARKED-CHECKPOINT', true);
      },
      'read',
    )
      .addPausableFunction('Confirm', handler, 'confirm')
      .build();
    const paused = new FlowChartExecutor(chart);
    paused.setRedactionPolicy({});
    await paused.run();
    const checkpoint = paused.getCheckpoint()!;
    expect(checkpoint.redactionMarks?.keys).toContain('secret');
    expect(checkpoint.sharedState.secret).toBe('MARKED-CHECKPOINT');
    const resumed = new FlowChartExecutor(chart);
    resumed.setRedactionPolicy({});
    await resumed.resume(checkpoint, 'confirmed');
    const safe = resumed.getSnapshot({ redact: true });
    expect(stateAt(safe, -1).state).toMatchObject({ reading: 'public inherited reading', secret: 'REDACTED' });
    expect(JSON.stringify(safe)).not.toContain('MARKED-CHECKPOINT');
    expect(resumed.getSnapshot().initialState?.secret).toBe('MARKED-CHECKPOINT');
  });

  it('keeps a restored pause mark on the fold base after a committed delete and later rewrite', async () => {
    type State = { reading?: string; secret?: string };
    const handler: PausableHandler<TypedScope<State>, string> = {
      execute: async () => ({ question: 'Confirm?' }),
      resume: async (scope) => {
        scope.$delete('secret');
      },
    };
    let valueAfterDelete: unknown = 'not reached';
    const chart = flowChart<State>(
      'Read',
      (scope) => {
        scope.reading = 'inherited public reading';
        scope.$setValue('secret', 'PRIVATE-RESTORED-SEED', true);
      },
      'read',
    )
      .addPausableFunction('Delete on confirmation', handler, 'confirm')
      .addFunction(
        'Rewrite',
        (scope) => {
          valueAfterDelete = scope.secret;
          scope.secret = 'replacement after resume';
        },
        'rewrite',
      )
      .build();
    const paused = new FlowChartExecutor(chart);
    paused.setRedactionPolicy({});
    await paused.run();
    const checkpoint = JSON.parse(JSON.stringify(paused.getCheckpoint()!));
    expect(checkpoint.redactionMarks.keys).toContain('secret');
    expect(checkpoint.sharedState.secret).toBe('PRIVATE-RESTORED-SEED');

    const resumed = new FlowChartExecutor(chart);
    resumed.setRedactionPolicy({});
    await resumed.resume(checkpoint, 'confirmed');
    expect(valueAfterDelete).toBeUndefined(); // The delete committed before the rewrite.
    // A pause carries names, not their places. Its inherited mark stays private
    // even after this leg deletes its own value; it cannot prove every old place gone.
    expect(resumed.getRedactionReport().redactedKeys).toContain('secret');
    const safe = resumed.getSnapshot({ redact: true });
    expect(safe.initialState).toMatchObject({ reading: 'inherited public reading', secret: 'REDACTED' });
    expect(stateAt(safe, -1).state).toMatchObject({ reading: 'inherited public reading', secret: 'REDACTED' });
    expect(safe.sharedState.secret).toBe('REDACTED');
    expect(JSON.stringify(safe)).not.toMatch(/PRIVATE-RESTORED-SEED|replacement after resume/);
    expect(resumed.getSnapshot().initialState?.secret).toBe('PRIVATE-RESTORED-SEED');
    expect(resumed.getSnapshot().sharedState.secret).toBe('replacement after resume');
    expect(checkpoint.sharedState.secret).toBe('PRIVATE-RESTORED-SEED');
  });

  it('uses the current rule after an ordinary last-place committed delete ends a per-call mark', async () => {
    type State = { secret?: string };
    let valueAfterDelete: unknown = 'not reached';
    const chart = flowChart<State>(
      'Mark',
      (scope) => {
        scope.$setValue('secret', 'PRIVATE-INTERIM-VALUE', true);
      },
      'mark',
    )
      .addFunction('Delete', (scope) => scope.$delete('secret'), 'delete')
      .addFunction(
        'Rewrite',
        (scope) => {
          valueAfterDelete = scope.secret;
          scope.secret = 'public replacement';
        },
        'rewrite',
      )
      .build();
    const executor = new FlowChartExecutor(chart, { initialContext: { secret: 'public entry seed' } });
    executor.setRedactionPolicy({});
    await executor.run();
    expect(valueAfterDelete).toBeUndefined(); // A later stage, not a staged delete-and-rewrite.
    // Without a pause or another held place, the committed delete ends this
    // dynamic mark. The base's originally public seed follows that current rule.
    expect(executor.getRedactionReport().redactedKeys).not.toContain('secret');
    const safe = executor.getSnapshot({ redact: true });
    expect(safe.initialState).toEqual({ secret: 'public entry seed' });
    expect(stateAt(safe, -1).state).toEqual({ secret: 'public entry seed' });
    expect(safe.sharedState.secret).toBe('public replacement');
    expect(stateAt(safe, safe.commitLog!.length - 1).state.secret).toBe('public replacement');
    expect(JSON.stringify(safe)).not.toContain('PRIVATE-INTERIM-VALUE');
  });

  it('uses the namespace-aware state rule for the starting state', () => {
    const rule = new RedactionRule({ keys: ['token'] });
    const runtime = new ExecutionRuntime(
      'Fixture',
      'fixture',
      undefined,
      { [RUN_NAMESPACE]: { child: { token: 'NAMESPACE-SECRET', public: 'kept' } } },
      runPolicy({}, rule, true),
    );
    expect(runtime.getSnapshot({ redact: true }).initialState).toEqual({
      [RUN_NAMESPACE]: { child: { token: 'REDACTED', public: 'kept' } },
    });
    expect(runtime.getSnapshot().initialState?.[RUN_NAMESPACE]).toEqual({
      child: { token: 'NAMESPACE-SECRET', public: 'kept' },
    });
  });

  it('freezes masked bases and isolates mutable clear values through the existing public record door', async () => {
    const chart = flowChart('Touch', () => {}, 'touch').build();
    const executor = new FlowChartExecutor(chart, {
      initialContext: {
        token: 'SECRET',
        profile: { token: 'PRIVATE', public: 'kept' },
        when: new Date(123),
        bag: new Map([['n', 1]]),
      },
    });
    executor.setRedactionPolicy({ keys: ['token'], fields: { profile: ['token'] } });
    await executor.run();
    const base = executor.getSnapshot({ redact: true }).initialState!;
    expect(Object.isFrozen(base)).toBe(true);
    expect(Object.isFrozen(base.profile)).toBe(true);
    expect(() => {
      (base.profile as { public: string }).public = 'changed';
    }).toThrow();
    (base.when as Date).setTime(999);
    (base.bag as Map<string, number>).set('n', 9);
    const again = executor.getSnapshot({ redact: true }).initialState!;
    expect((again.when as Date).getTime()).toBe(123);
    expect((again.bag as Map<string, number>).get('n')).toBe(1);
    expect(executor.getSnapshot().initialState?.token).toBe('SECRET');
  });
});
