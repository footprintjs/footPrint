/** Security/scenario controls for stage-authored error text and its actual retained surfaces. */
import { memorySink } from 'foottrace/write';
import { describe, expect, it } from 'vitest';

import { createTypedScopeFactory, registerScopeRuntime } from '../../../../src/advanced.js';
import { flowChart, FlowChartExecutor } from '../../../../src/index.js';
import { stageErrorSurfaces } from '../../../helpers/stageErrorSurfaces.js';

const SECRET = 'SYNTHETIC-STAGE-ERROR-SECRET-731';

describe('stage error text is selected by its sources', () => {
  it.each([false, true])('retains one safe form, native retry=%s', async (retry) => {
    let thrown: Error | undefined;
    let calls = 0;
    const builder = flowChart<any>(
      'Seed',
      (scope) => {
        scope.secret = SECRET;
      },
      'seed',
    ).addFunction(
      'Fail',
      (scope) => {
        calls += 1;
        thrown = new Error(`lookup ${scope.secret}`);
        throw thrown;
      },
      'fail',
    );
    if (retry) builder.retry({ attempts: 2 });
    const result = await stageErrorSurfaces(builder.build(), { keys: ['secret'] });
    expect(result.rejected).toBe(thrown);
    expect(calls).toBe(retry ? 2 : 1);
    expect(result.events.some((row) => row.kind === 'error')).toBe(true);
    expect(result.retained.narrative).toContain('[Error]');
    expect(result.retained.tree).toContain('stageExecutionError');
    expect(result.retained.disk).toContain('"closed"');
    expect(result.retained.disk).toContain('capture-history');
    expect(result.events.filter((row) => row.kind === 'attempt')).toHaveLength(retry ? 2 : 0);
    for (const [name, text] of Object.entries(result.retained)) {
      expect(text, name).not.toContain(SECRET);
    }
  });

  it('keeps public body error text with an unrelated selector', async () => {
    const error = new Error('public lookup failed');
    const result = await stageErrorSurfaces(
      flowChart(
        'Fail',
        () => {
          throw error;
        },
        'fail',
      ).build(),
      { keys: ['secret'] },
    );
    expect(result.rejected).toBe(error);
    expect(result.retained.narrative).toContain('public lookup failed');
    expect(result.retained.tree).toContain('public lookup failed');
  });

  it('covers selected input and arbitrary derived structured fields', async () => {
    let thrown: Error | undefined;
    const chart = flowChart<any>(
      'Fail',
      (scope) => {
        const secret = scope.$getArgs().secret;
        thrown = Object.assign(new Error(`lookup ${secret}`), {
          name: secret,
          code: secret,
          cause: { detail: secret },
        });
        throw thrown;
      },
      'fail',
    ).build();
    const result = await stageErrorSurfaces(chart, { keys: ['secret'] }, { secret: SECRET });
    expect(result.rejected).toBe(thrown);
    expect(thrown?.message).toBe(`lookup ${SECRET}`);
    expect(thrown?.name).toBe(SECRET);
    expect((thrown as any).code).toBe(SECRET);
    expect(thrown?.cause).toEqual({ detail: SECRET });
    for (const text of Object.values(result.retained)) expect(text).not.toContain(SECRET);
    const error = result.events.find((row) => row.kind === 'error').event.structuredError;
    expect(error).toEqual({ message: '[REDACTED]', raw: undefined });
  });

  it.each(['message', 'name'])('never serves an opaque structured %s as a string', async (field) => {
    const error = new Error('public');
    Object.defineProperty(error, field, {
      get: () => ({ secret: SECRET }),
      enumerable: true,
      configurable: true,
    });
    error.toString = () => 'public error text';
    const result = await stageErrorSurfaces(
      flowChart(
        'Fail',
        () => {
          throw error;
        },
        'fail',
      ).build(),
      { keys: ['secret'] },
    );
    expect(result.rejected).toBe(error);
    expect(result.events.some((row) => row.kind === 'error')).toBe(true);
    expect(result.retained.disk).toContain('"closed"');
    for (const [surface, text] of Object.entries(result.retained)) expect(text, surface).not.toContain(SECRET);
  });

  it('strengthens a partially masked call error when the same stage later reads selected state', async () => {
    const error = Object.assign(new Error('public error'), { secret: 'private-field', code: 'PUBLIC_CODE' });
    const chart = flowChart<any>(
      'Seed',
      (scope) => {
        scope.secret = SECRET;
      },
      'seed',
    )
      .addFunction(
        'Fail',
        async (scope) => {
          await scope
            .$call('public.operation', () => {
              throw error;
            })
            .catch(() => undefined);
          void scope.secret;
          throw error;
        },
        'fail',
      )
      .build();
    const result = await stageErrorSurfaces(chart, { keys: ['secret'] });
    expect(result.rejected).toBe(error);
    expect(error.message).toBe('public error');
    expect(error.code).toBe('PUBLIC_CODE');
    expect(error.secret).toBe('private-field');
    expect(result.events.find((row) => row.kind === 'error').event.structuredError).toEqual({
      message: '[REDACTED]',
      raw: undefined,
    });
  });
});

describe('pre-invocation errors have unknown sources', () => {
  it.each(['state', 'input', 'public'] as const)('key callback failure: %s, no body or attempt', async (source) => {
    let bodies = 0;
    const error = new Error(source === 'public' ? 'public callback failure' : SECRET);
    const chart = flowChart<any>(
      'Seed',
      (scope) => {
        if (source !== 'input') scope.secret = SECRET;
      },
      'seed',
    )
      .addFunction(
        'Fail',
        () => {
          bodies += 1;
        },
        'fail',
      )
      .touches('test-system', {
        idempotencyKey: ({ getState, args }: any) => {
          if (source === 'state') expect(getState('secret')).toBe(SECRET);
          if (source === 'input') expect(args.secret).toBe(SECRET);
          throw error;
        },
      })
      .retry({ attempts: 2 })
      .build();
    const result = await stageErrorSurfaces(
      chart,
      { keys: ['secret'] },
      source === 'input' ? { secret: SECRET } : undefined,
    );
    expect(result.rejected).toBe(error);
    expect(bodies).toBe(0);
    expect(result.events.filter((row) => row.kind === 'attempt')).toHaveLength(0);
    expect(result.retained.disk).toContain('"closed"');
    expect(result.retained.tree).toContain('stageExecutionError');
    expect(result.retained.narrative).toContain('[REDACTED]');
    for (const text of Object.values(result.retained)) expect(text).not.toContain(SECRET);
    if (source === 'public') expect(result.retained.narrative).not.toContain(error.message);
  });

  it.each([false, true])('scope factory stays pending, native retry=%s', async (retry) => {
    let bodies = 0;
    let constructions = 0;
    const error = new Error(SECRET);
    const native = createTypedScopeFactory<any>();
    const builder = flowChart<any>(
      'Seed',
      (scope) => {
        scope.secret = SECRET;
      },
      'seed',
    ).addFunction(
      'Fail',
      () => {
        bodies += 1;
      },
      'fail',
    );
    if (retry) builder.retry({ attempts: 2 });
    const factory = (context: any, name: string, input: unknown, env: any) => {
      if (context.stageId === 'fail') {
        constructions += 1;
        expect(context.getValueDirect([], 'secret')).toBe(SECRET);
        throw error;
      }
      return native(context, name, input, env);
    };
    const result = await stageErrorSurfaces(builder.build(), { keys: ['secret'] }, undefined, factory);
    expect(result.rejected).toBe(error);
    expect(bodies).toBe(0);
    expect(constructions).toBe(retry ? 2 : 1);
    expect(result.events.filter((row) => row.kind === 'attempt')).toHaveLength(retry ? 2 : 0);
    expect(result.retained.tree).toContain('stageExecutionError');
    for (const text of Object.values(result.retained)) expect(text).not.toContain(SECRET);
  });

  it.each([undefined, { keys: ['unrelated'] }, { diagnostics: { keys: ['errors.other'] } }])(
    'public factory-error control with policy %j',
    async (policy) => {
      let bodies = 0;
      const error = new Error('public setup failure');
      const result = await stageErrorSurfaces(
        flowChart(
          'Fail',
          () => {
            bodies += 1;
          },
          'fail',
        ).build(),
        policy,
        undefined,
        () => {
          throw error;
        },
      );
      expect(result.rejected).toBe(error);
      expect(bodies).toBe(0);
      expect(result.retained.narrative.includes(error.message)).toBe(!policy?.keys);
    },
  );

  it('a registered runtime setup hook also stays pending', async () => {
    let bodies = 0;
    const error = new Error(SECRET);
    const factory = () =>
      registerScopeRuntime(
        {},
        {
          handlesAssignments: true,
          target: {
            notifyStageStart: () => {
              throw error;
            },
          },
        },
      );
    const result = await stageErrorSurfaces(
      flowChart(
        'Fail',
        () => {
          bodies += 1;
        },
        'fail',
      ).build(),
      { keys: ['secret'] },
      undefined,
      factory,
    );
    expect(result.rejected).toBe(error);
    expect(bodies).toBe(0);
    for (const text of Object.values(result.retained)) expect(text).not.toContain(SECRET);
  });
});

describe('error origin stays with the actual execution', () => {
  it('a prior selected call does not hide a later public body failure', async () => {
    const error = new Error('later public failure');
    const chart = flowChart<any>(
      'Seed',
      (s) => {
        s.secret = SECRET;
      },
      'seed',
    )
      .addFunction(
        'Selected',
        async (s) => {
          const selected = new Error(s.secret);
          await s
            .$call('test.selected', () => {
              throw selected;
            })
            .catch(() => undefined);
        },
        'selected',
      )
      .addFunction(
        'Public',
        () => {
          throw error;
        },
        'public',
      )
      .build();
    const result = await stageErrorSurfaces(chart, { keys: ['secret'] });
    expect(result.rejected).toBe(error);
    expect(result.retained.narrative).toContain(error.message);
    for (const text of Object.values(result.retained)) expect(text).not.toContain(SECRET);
  });

  it('a subflow error is not unmasked by its parent wrapper', async () => {
    const error = new Error(SECRET);
    const inner = flowChart<any>(
      'Seed',
      (s) => {
        s.secret = SECRET;
      },
      'seed',
    )
      .addFunction(
        'Inner failure',
        (s) => {
          expect(s.secret).toBe(SECRET);
          throw error;
        },
        'inner-failure',
      )
      .build();
    const outer = flowChart('Start', () => undefined, 'start')
      .addSubFlowChartNext('inner', inner, 'Inner')
      .build();
    const result = await stageErrorSurfaces(outer, { keys: ['secret'] });
    expect(result.rejected).toBe(error);
    expect(result.retained.disk).toContain('"closed"');
    for (const text of Object.values(result.retained)) expect(text).not.toContain(SECRET);
  });

  it('an adapter failure does not borrow the selected sources of the committing stage', async () => {
    const sink = memorySink();
    const failures: any[] = [];
    let selected = false;
    const error = new Error('public adapter failure');
    const adapter = {
      ...sink,
      commit: (entry: Parameters<typeof sink.commit>[0]) => {
        if (selected) throw error;
        sink.commit(entry);
      },
      onFailure: (failure: any) => failures.push(failure.error),
    };
    const chart = flowChart<any>(
      'Seed',
      (s) => {
        s.secret = SECRET;
      },
      'seed',
    )
      .addFunction(
        'Read',
        (s) => {
          expect(s.secret).toBe(SECRET);
          selected = true;
        },
        'read',
      )
      .build();
    const executor = new FlowChartExecutor(chart, { sink: adapter });
    executor.setRedactionPolicy({ keys: ['secret'] });
    await executor.run();
    expect(failures.length).toBeGreaterThan(0);
    expect(JSON.stringify(failures)).toContain(error.message);
    expect(JSON.stringify(failures)).not.toContain(SECRET);
  });

  it('a clear child stays public in parent diagnostics and logger', async () => {
    const error = new Error('public child failure');
    const inner = flowChart(
      'Inner failure',
      () => {
        throw error;
      },
      'inner-failure',
    ).build();
    const outer = flowChart('Start', () => undefined, 'start')
      .addSubFlowChartNext('inner', inner, 'Inner')
      .build();
    const result = await stageErrorSurfaces(outer, { keys: ['unrelated'] });
    expect(result.rejected).toBe(error);
    expect(result.retained.tree).toContain(error.message);
    const parentLogs = JSON.parse(result.retained.logger).filter((parts: any[]) =>
      String(parts[0]).startsWith('Error in subflow'),
    );
    expect(parentLogs.length).toBeGreaterThan(0);
    for (const parts of parentLogs) expect(parts[1].error.message).toBe(error.message);
  });
});
