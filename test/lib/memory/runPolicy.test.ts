/**
 * RunPolicy (F5) — the four dials, the redaction rule and the mirror flag as ONE frozen object,
 * held by reference by every frame of a run.
 *
 * Test types: Unit (defaults, freezing, picking) · Integration (a runtime installs it on its root;
 * createNext/createChild pass the SAME reference; the mirror store follows the flag) · Scenario
 * (an executor's subflow runs under its run's dials — the seed included, C-F5).
 */
import { describe, expect, it } from 'vitest';

import { flowChart, FlowChartExecutor, getSubtreeSnapshot } from '../../../src';
import { RedactionRule } from '../../../src/lib/memory/redaction';
import {
  DEFAULT_RUN_POLICY,
  DIAL_DEFAULTS,
  pickDials,
  runPolicy,
  withRedaction,
} from '../../../src/lib/memory/runPolicy';
import { ExecutionRuntime } from '../../../src/lib/runner/ExecutionRuntime';

describe('runPolicy — one frozen object', () => {
  it('an absent dial is its default; the result is frozen', () => {
    const policy = runPolicy({ commitValues: 'delta' });
    expect(policy).toEqual({ ...DIAL_DEFAULTS, commitValues: 'delta', mirror: false });
    expect(Object.isFrozen(policy)).toBe(true);
    expect(Object.isFrozen(DEFAULT_RUN_POLICY)).toBe(true);
  });

  it('pickDials takes the four dials off an options object and nothing else', () => {
    const options = { readTracking: 'off', scopeFactory: () => ({}), initialContext: { a: 1 } } as const;
    expect(pickDials(options as never)).toEqual({ readTracking: 'off' });
    expect(pickDials({ writeTracking: undefined })).toEqual({});
  });

  it('withRedaction is a NEW policy; the shared one is never edited', () => {
    const policy = runPolicy({ readTracking: 'summary' });
    const rule = new RedactionRule();
    const next = withRedaction(policy, rule);
    expect(next).not.toBe(policy);
    expect(next.redaction).toBe(rule);
    expect(next.readTracking).toBe('summary');
    expect(policy.redaction).toBeUndefined();
  });
});

describe('every frame holds the run policy by reference', () => {
  it('the runtime installs it on its root; createNext and createChild pass the same object', () => {
    const policy = runPolicy({ writeProvenance: 'reads-prefix' }, new RedactionRule());
    const runtime = new ExecutionRuntime('root', 'root', undefined, undefined, policy);
    const root = runtime.rootStageContext;
    expect(root.getPolicy()).toBe(policy);
    expect(root.createNext('', 'n', 'n').getPolicy()).toBe(policy);
    expect(root.createChild('', 'b', 'c', 'c').getPolicy()).toBe(policy);
    expect(runtime.newRoot('fresh', 'fresh').getPolicy()).toBe(policy);
  });

  it('a mirror store exists exactly when the policy keeps one, and every frame shares it', () => {
    expect(new ExecutionRuntime('r', 'r').redactedStore).toBeUndefined();
    const runtime = new ExecutionRuntime('r', 'r', undefined, { k: 1 }, runPolicy({}, new RedactionRule(), true));
    const store = runtime.redactedStore;
    expect(store?.getState()).toEqual({ k: 1 });
    expect(runtime.rootStageContext.createNext('', 'n', 'n').getRedactedSharedMemory()).toBe(store);
  });

  it('usePolicy (a same-executor resume) installs the new policy on the current root', () => {
    const runtime = new ExecutionRuntime('r', 'r');
    const policy = runPolicy({ readTracking: 'off' });
    runtime.rootStageContext = runtime.rootStageContext.createNext('', 'c', 'c');
    runtime.usePolicy(policy);
    expect(runtime.rootStageContext.getPolicy()).toBe(policy);
    expect(runtime.getSnapshot().commitValues).toBe('full');
  });
});

describe('a subflow runs under the run policy — its seed included (C-F5)', () => {
  it('under reads-prefix the seed rows carry readKeys: [] and the stage rows their reads', async () => {
    const inner = flowChart<Record<string, unknown>>(
      'Inner',
      (scope: any) => {
        scope.out = (scope.$getValue('n') as number) + 1;
      },
      'inner',
    ).build();
    const chart = flowChart<Record<string, unknown>>(
      'Outer',
      (scope: any) => {
        scope.n = 1;
      },
      'outer',
    )
      .addSubFlowChartNext('sf', inner, 'Mount', { inputMapper: (s: any) => ({ n: s.n }) })
      .build();
    const executor = new FlowChartExecutor(chart, { writeProvenance: 'reads-prefix', commitValues: 'delta' });
    await executor.run();
    const sub = getSubtreeSnapshot(executor.getSnapshot(), 'sf') as any;
    expect(sub.history[0].trace).toEqual([{ path: 'n', verb: 'set', readKeys: [] }]);
    expect(sub.history[1].trace).toEqual([{ path: 'out', verb: 'set', readKeys: ['n'] }]);
  });
});
