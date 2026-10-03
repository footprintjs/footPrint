/**
 * A stage may throw ANY value — `null`, a null-prototype object, a Proxy
 * whose traps throw — and the error law still holds:
 *
 *   - the stage's writes land (commit-on-error),
 *   - `onError` fires with a `StructuredErrorInfo` whose `raw` is the value,
 *   - `run()` rejects with the ORIGINAL thrown value, never a secondary
 *     TypeError raised while describing it.
 *
 * Before the fix the traverser's catch called `error.toString()` before
 * `onError`, so `throw null` skipped `onError` and rejected with
 * "Cannot read properties of null (reading 'toString')"; a Proxy with a
 * throwing `getPrototypeOf` escaped `extractErrorInfo` and the engine's
 * signal guards.
 */

import type { FlowErrorEvent } from '../../../../src/index';
import { extractErrorInfo, flowChart, FlowChartExecutor } from '../../../../src/index';

const nullProto = Object.assign(Object.create(null), { message: 'np' });
const hostileProxy = new Proxy(
  {},
  {
    getPrototypeOf() {
      throw new Error('trap: getPrototypeOf');
    },
    get() {
      throw new Error('trap: get');
    },
  },
);

const CASES: Array<[string, unknown]> = [
  ['null', null],
  ['undefined', undefined],
  ['a null-prototype object', nullProto],
  ['a Proxy whose traps throw', hostileProxy],
];

async function runThrowing(value: unknown, shape: 'linear' | 'decider' | 'selector' | 'fork' | 'subflow') {
  const thrower = async (scope: any) => {
    scope.$setValue('wrote', true);
    throw value;
  };
  let chart;
  if (shape === 'linear') {
    chart = flowChart<any>('Seed', async () => {}, 'seed')
      .addFunction('Boom', thrower, 'boom')
      .build();
  } else if (shape === 'decider') {
    chart = flowChart<any>('Seed', async () => {}, 'seed')
      .addDeciderFunction('Boom', thrower as any, 'boom')
      .addFunctionBranch('a', 'A', async () => {})
      .end()
      .build();
  } else if (shape === 'selector') {
    chart = flowChart<any>('Seed', async () => {}, 'seed')
      .addSelectorFunction('Boom', thrower as any, 'boom')
      .addFunctionBranch('a', 'A', async () => {})
      .end()
      .build();
  } else if (shape === 'fork') {
    chart = flowChart<any>('Seed', async () => {}, 'seed')
      .addListOfFunction([{ id: 'boom', name: 'Boom', fn: thrower }], { failFast: true })
      .build();
  } else {
    const inner = flowChart<any>('Boom', thrower, 'boom').build();
    chart = flowChart<any>('Seed', async () => {}, 'seed')
      .addSubFlowChartNext('sf', inner, 'Sub', { outputMapper: (s: any) => ({ wrote: s.wrote }) })
      .build();
  }
  const ex = new FlowChartExecutor(chart);
  const errors: FlowErrorEvent[] = [];
  ex.attachFlowRecorder({ id: 'errors', onError: (e) => errors.push(e) });
  let rejected: { value: unknown } | undefined;
  try {
    await ex.run();
  } catch (e) {
    rejected = { value: e };
  }
  return { ex, errors, rejected };
}

describe('a stage that throws a hostile value', () => {
  for (const [label, value] of CASES) {
    for (const shape of ['linear', 'decider', 'selector', 'fork'] as const) {
      it(`${label} (${shape}): onError fires, run() rejects with the original value, writes land`, async () => {
        const { ex, errors, rejected } = await runThrowing(value, shape);
        expect(rejected).toBeDefined();
        expect(rejected!.value).toBe(value);
        expect(errors).toHaveLength(1);
        expect(errors[0].stageName).toBe('Boom');
        expect(errors[0].structuredError.raw).toBe(value);
        expect(typeof errors[0].structuredError.message).toBe('string');
        expect(typeof errors[0].message).toBe('string');
        // A fork child writes under its own `runs/<id>` namespace.
        const state = ex.getSnapshot().sharedState as any;
        expect(shape === 'fork' ? state.runs.boom.wrote : state.wrote).toBe(true);
      });
    }

    it(`${label} (subflow): onError fires and run() rejects with the original value`, async () => {
      const { errors, rejected } = await runThrowing(value, 'subflow');
      expect(rejected).toBeDefined();
      expect(rejected!.value).toBe(value);
      expect(errors.length).toBeGreaterThanOrEqual(1);
      expect(errors[0].structuredError.raw).toBe(value);
    });
  }

  it('throw null narrates "null"', async () => {
    const { errors } = await runThrowing(null, 'linear');
    expect(errors[0].message).toBe('null');
    expect(errors[0].structuredError.message).toBe('null');
  });
});

describe('extractErrorInfo never throws', () => {
  it('returns an info object for a Proxy whose getPrototypeOf trap throws', () => {
    const info = extractErrorInfo(hostileProxy);
    expect(info.raw).toBe(hostileProxy);
    expect(typeof info.message).toBe('string');
  });

  it('returns an info object for a revoked Proxy', () => {
    const { proxy, revoke } = Proxy.revocable(new Error('x'), {});
    revoke();
    const info = extractErrorInfo(proxy);
    expect(info.raw).toBe(proxy);
    expect(typeof info.message).toBe('string');
  });
});

describe('a write nothing can clone fails at the commit — with onError', () => {
  async function run(chart: any) {
    const ex = new FlowChartExecutor(chart);
    const errors: FlowErrorEvent[] = [];
    ex.attachFlowRecorder({ id: 'errors', onError: (e) => errors.push(e) });
    let rejected: unknown;
    await ex.run().catch((e) => {
      rejected = e;
    });
    return { errors, rejected };
  }

  it('a fork child: onError fires for the child and run() rejects (9.39.0 dropped it)', async () => {
    const { errors, rejected } = await run(
      flowChart<any>('Seed', async () => {}, 'seed')
        .addListOfFunction([
          { id: 'f1', name: 'F1', fn: async (s: any) => s.$setValue('f', () => 1) },
          { id: 'f2', name: 'F2', fn: async () => {} },
        ])
        .build(),
    );
    expect((rejected as Error).name).toBe('DataCloneError');
    expect(errors.map((e) => e.stageName)).toEqual(['F1']);
  });

  it('a linear stage: onError fires and run() rejects', async () => {
    const { errors, rejected } = await run(
      flowChart<any>('Seed', async () => {}, 'seed')
        .addFunction('L', async (s: any) => s.$setValue('f', () => 1), 'l')
        .build(),
    );
    expect((rejected as Error).name).toBe('DataCloneError');
    expect(errors.map((e) => e.stageName)).toEqual(['L']);
  });
});
