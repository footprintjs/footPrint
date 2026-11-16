/** Actual native/call/observed records, including recovered work and late source selection. */
import { describe, expect, it } from 'vitest';

import { createTypedScopeFactory } from '../../../../src/advanced.js';
import { flowChart } from '../../../../src/index.js';
import { stageErrorSurfaces } from '../../../helpers/stageErrorSurfaces.js';

const SECRET = 'SYNTHETIC-ATTEMPT-SOURCE-943';

function noLeak(result: Awaited<ReturnType<typeof stageErrorSurfaces>>) {
  expect(result.events.some((row) => row.kind === 'attempt')).toBe(true);
  expect(result.retained.disk).toContain('"attempt"');
  expect(result.retained.disk).toContain('"closed"');
  for (const [name, text] of Object.entries(result.retained)) expect(text, name).not.toContain(SECRET);
}

describe('the existing late serve hook asks current stage sources', () => {
  it('keeps a recovered attempt without its selected message', async () => {
    let calls = 0;
    const chart = flowChart<any>(
      'Seed',
      (s) => {
        s.secret = SECRET;
      },
      'seed',
    )
      .addFunction(
        'Try',
        (s) => {
          calls += 1;
          if (calls === 1) throw new Error(s.secret);
        },
        'try',
      )
      .retry({ attempts: 2 })
      .build();
    const result = await stageErrorSurfaces(chart, { keys: ['secret'] });
    expect(result.rejected).toBeUndefined();
    expect(calls).toBe(2);
    expect(result.events.filter((row) => row.kind === 'attempt').map((row) => row.event.record.outcome)).toEqual([
      'failed',
      'ok',
    ]);
    noLeak(result);
  });

  it.each(['call', 'observed'] as const)('covers a %s error inside the stage', async (door) => {
    const chart = flowChart<any>(
      'Seed',
      (s) => {
        s.secret = SECRET;
      },
      'seed',
    )
      .addFunction(
        'Work',
        async (s) => {
          const error = new Error(s.secret);
          if (door === 'call') {
            await s
              .$call('test.lookup', () => {
                throw error;
              })
              .catch(() => undefined);
          } else {
            s.$attempt().observed({ target: 'test.lookup', outcome: 'failed', durationMs: 1, error });
          }
        },
        'work',
      )
      .retry({ attempts: 2 })
      .build();
    const result = await stageErrorSurfaces(chart, { keys: ['secret'] });
    expect(result.rejected).toBeUndefined();
    expect(result.events.some((row) => row.event.record?.kind === door)).toBe(true);
    noLeak(result);
  });

  it.each(['retryOn', 'backoff', 'message', 'code'] as const)(
    'samples after %s code reads a selected value',
    async (door) => {
      let context: any;
      const native = createTypedScopeFactory<any>();
      const factory = (ctx: any, name: string, input: unknown, env: any) => {
        if (ctx.stageId === 'fail') context = ctx;
        return native(ctx, name, input, env);
      };
      const read = () => context.getValue([], 'secret');
      const error = new Error(SECRET);
      if (door === 'message' || door === 'code') Object.defineProperty(error, door, { get: read });
      const chart = flowChart<any>(
        'Seed',
        (s) => {
          s.secret = SECRET;
        },
        'seed',
      )
        .addFunction(
          'Fail',
          () => {
            throw error;
          },
          'fail',
        )
        .retry({
          attempts: 2,
          ...(door === 'retryOn'
            ? {
                retryOn: () => {
                  read();
                  return true;
                },
              }
            : {}),
          ...(door === 'backoff'
            ? {
                backoffMs: () => {
                  read();
                  return 0;
                },
              }
            : {}),
        })
        .build();
      const result = await stageErrorSurfaces(chart, { keys: ['secret'] }, undefined, factory);
      expect(result.rejected).toBe(error);
      noLeak(result);
    },
  );
});
