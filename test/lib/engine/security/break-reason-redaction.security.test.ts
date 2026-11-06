/**
 * A `$break(reason)` reason is a value the stage's own code made, so a redaction policy covers it. It is served once,
 * where the reason is taken (`handlers/breakFlag.ts · createBreakHandler`), so every `onBreak` event — linear, selector,
 * fork child, fan-out branch, and the parent's propagated event — carries one form. The reason travels nowhere else.
 *
 * Test types: Security (each selection route, each placement) · Boundary (the first reason wins, no reason) ·
 * Scenario (propagation) · byte identity without a policy.
 */
import { describe, expect, it } from 'vitest';

import type { RedactionPolicy } from '../../../../src/index.js';
import { flowChart, select } from '../../../../src/index.js';
import { evidenceSurfaces, surfacesHolding } from '../../decide/helpers/evidenceSurfaces.js';

const SECRET = 'SEKRET-2187-BREAK';

/** A stage that breaks, after a seed stage. `pw` holds the value only where the route's policy selects it. */
function breaking(stage: (s: any) => void, pw?: string) {
  return flowChart<any>(
    'Seed',
    (s: any) => {
      s.plain = 'visible';
      if (pw !== undefined) s.pw = pw;
    },
    'seed',
  )
    .addFunction('Stop', stage, 'stop')
    .addFunction('Never', () => undefined, 'never')
    .build();
}

describe('a break reason is served', () => {
  const ROUTES: ReadonlyArray<readonly [string, RedactionPolicy, unknown, string | undefined, (s: any) => void]> = [
    ['quoting a selected value the stage read', { keys: ['pw'] }, undefined, SECRET, (s) => s.$break(`stop ${s.pw}`)],
    ['selected by a pattern', { patterns: [/^pw$/] }, undefined, SECRET, (s) => s.$break(`stop ${s.pw}`)],
    [
      'selected by a run-time mark',
      {},
      undefined,
      undefined,
      (s) => {
        s.$setValue('marked', SECRET, true);
        s.$break(`stop ${s.marked}`);
      },
    ],
    [
      'selected by `fields`',
      { fields: { patient: ['ssn'] } },
      undefined,
      undefined,
      (s) => {
        s.patient = { ssn: SECRET };
        s.$break(`stop ${s.patient.ssn}`);
      },
    ],
    [
      'quoting args that hold a selected key',
      { keys: ['ssn'] },
      { ssn: SECRET },
      undefined,
      (s) => s.$break(`stop ${s.$getArgs().ssn}`),
    ],
    [
      'selected by name through a state rule',
      { keys: ['breakReason'] },
      undefined,
      undefined,
      (s) => s.$break(`stop ${SECRET}`),
    ],
    [
      'selected by name through a diagnostic selector',
      { diagnostics: { keys: ['logs.breakReason'] } },
      undefined,
      undefined,
      (s) => s.$break(`stop ${SECRET}`),
    ],
  ];

  it.each(ROUTES)('%s', async (_name, policy, input, pw, stage) => {
    const surfaces = await evidenceSurfaces(breaking(stage, pw), policy, input);
    expect(surfaces.reasons).toEqual(['[REDACTED]']);
    expect(surfacesHolding(surfaces, SECRET)).toEqual([]);
  });

  it('through the stage function break argument', async () => {
    const chart = flowChart<any>(
      'Seed',
      (s: any) => {
        s.pw = SECRET;
      },
      'seed',
    )
      .addFunction(
        'Stop',
        (s: any, breakFn: (reason?: string) => void) => {
          breakFn(`stop ${s.pw}`);
        },
        'stop',
      )
      .build();
    const surfaces = await evidenceSurfaces(chart, { keys: ['pw'] });
    expect(surfaces.reasons).toEqual(['[REDACTED]']);
  });

  it('the first reason wins, and it is the served one', async () => {
    const surfaces = await evidenceSurfaces(
      breaking((s) => {
        s.$break('first, clear');
        s.$break(`second ${s.pw}`);
      }, SECRET),
      { keys: ['pw'] },
    );
    expect(surfaces.reasons).toEqual(['first, clear']);
  });

  it('a stage that read nothing selected keeps its reason under an active policy', async () => {
    const surfaces = await evidenceSurfaces(
      breaking((s) => s.$break(`stop ${s.plain}`), SECRET),
      { keys: ['pw'] },
    );
    expect(surfaces.reasons).toEqual(['stop visible']);
  });

  it('no reason stays no reason', async () => {
    const surfaces = await evidenceSurfaces(
      breaking((s) => s.$break()),
      { keys: ['pw'] },
    );
    expect(surfaces.reasons).toEqual([undefined]);
  });

  it.each([
    ['no policy', undefined],
    ['a policy that selects nothing here', { keys: ['absent'] }],
  ] as const)('byte identity: %s', async (_name, policy) => {
    const surfaces = await evidenceSurfaces(
      breaking((s) => s.$break(`stop ${s.plain}`)),
      policy as RedactionPolicy | undefined,
    );
    expect(surfaces.reasons).toEqual(['stop visible']);
  });
});

describe('every event site of a break reason', () => {
  const policy = { keys: ['pw'] };
  const seed = (s: any) => {
    s.pw = SECRET;
  };

  it('a selector that breaks', async () => {
    const chart = flowChart<any>('Seed', seed, 'seed')
      .addSelectorFunction(
        'Pick',
        (s: any) => {
          s.$break(`stop ${s.pw}`);
          return select(s, []);
        },
        'pick',
      )
      .addFunctionBranch('a', 'A', () => undefined)
      .end()
      .build();
    const surfaces = await evidenceSurfaces(chart, policy);
    expect(surfaces.reasons).toEqual(['[REDACTED]']);
    expect(surfacesHolding(surfaces, SECRET)).toEqual([]);
  });

  it('a fork child that breaks', async () => {
    const chart = flowChart<any>('Seed', seed, 'seed')
      .addListOfFunction([
        {
          id: 'child',
          name: 'Child',
          fn: (s: any) => {
            s.$break(`stop ${s.pw}`);
          },
        },
      ])
      .addFunction('Join', () => undefined, 'join')
      .build();
    const surfaces = await evidenceSurfaces(chart, policy);
    expect(surfaces.reasons).toEqual(['[REDACTED]']);
    expect(surfacesHolding(surfaces, SECRET)).toEqual([]);
  });

  it('a fan-out branch that breaks, quoting the selected item', async () => {
    const branch = flowChart<any>(
      'Each',
      (s: any) => {
        s.$break(`stop ${s.item}`);
      },
      'each',
    ).build();
    const chart = flowChart<any>('Seed', seed, 'seed')
      .addParallelForEach('Fan', 'fan', {
        items: (s: any) => [s.pw],
        branch: () => branch,
        maxBranches: 2,
        into: 'done',
      })
      .build();
    const surfaces = await evidenceSurfaces(chart, policy);
    expect(surfaces.reasons).toContain('[REDACTED]');
    expect(surfacesHolding(surfaces, SECRET)).toEqual([]);
  });

  it('a subflow break propagated to the parent: both events carry the served form', async () => {
    const inner = flowChart<any>(
      'Inner',
      (s: any) => {
        s.$break(`stop ${s.$getArgs().pw}`);
      },
      'inner',
    ).build();
    const chart = flowChart<any>('Seed', seed, 'seed')
      .addSubFlowChartNext('sf', inner, 'Sub', {
        inputMapper: (p: any) => ({ pw: p.pw }),
        propagateBreak: true,
      })
      .addFunction('Never', () => undefined, 'never')
      .build();
    const surfaces = await evidenceSurfaces(chart, policy);
    expect(surfaces.reasons).toEqual(['[REDACTED]', '[REDACTED]']);
    expect(surfacesHolding(surfaces, SECRET)).toEqual([]);
  });

  it('a decider that breaks takes no reason at all, so it can leak none', async () => {
    const chart = flowChart<any>('Seed', seed, 'seed')
      .addDeciderFunction(
        'Route',
        (s: any) => {
          s.$break(`stop ${s.pw}`);
          return 'a';
        },
        'route',
      )
      .addFunctionBranch('a', 'A', () => undefined)
      .setDefault('a')
      .end()
      .build();
    const surfaces = await evidenceSurfaces(chart, policy);
    expect(surfacesHolding(surfaces, SECRET)).toEqual([]);
  });
});
