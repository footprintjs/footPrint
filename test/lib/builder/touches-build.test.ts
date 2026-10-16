/**
 * `.touches(system, { idempotencyKey })` — the BUILD-TIME half of side-effect safety (design §3.3, packet P3).
 *
 * A stage that touches an outside system and may retry must declare an idempotency key: a retry of a
 * non-idempotent effect without one can apply it twice (a double charge). The builder refuses the combination at
 * the declaration site, whichever of `.retry()` and `.touches()` comes first. A library-made default key was
 * rejected (it changes across a resume and a caller's retry — exactly where a double charge happens), so there is
 * none: the author writes the key rule.
 *
 * Test types: Unit (every declaration site; the spec carries the system name only) · Boundary (`attempts: 1`
 * needs no key; a declaration twice) · Security (the refusal cannot be dodged by order; nodes with no stage
 * function refuse; a constant key is refused — the rule is a function of the execution).
 */
import { describe, expect, it } from 'vitest';

import { flowChart, flowChartSelector } from '../../../src/index.js';

type S = Record<string, unknown>;
const noop = () => undefined;
const key = ({ args }: { args: unknown }) => `order-${(args as { orderId?: string })?.orderId ?? 'x'}`;

describe('.touches() — declaration sites and the spec', () => {
  it('lands on the stage just added; the spec carries the system NAME only', () => {
    const chart = flowChart<S>('Seed', noop, 'seed')
      .addFunction('Charge', noop, 'charge')
      .touches('stripe', { idempotencyKey: key })
      .retry({ attempts: 3 })
      .build();
    expect(chart.root.next?.touches?.system).toBe('stripe');
    expect(chart.root.next?.touches?.idempotencyKey).toBe(key);
    expect(chart.buildTimeStructure.next?.touches).toBe('stripe');
    expect(JSON.stringify(chart.buildTimeStructure)).not.toContain('idempotencyKey');
  });

  it('a touching stage that never retries needs no key', () => {
    const chart = flowChart<S>('Charge', noop, 'charge').touches('stripe').build();
    expect(chart.root.touches).toEqual({ system: 'stripe' });
    expect(chart.buildTimeStructure.touches).toBe('stripe');
    const once = flowChart<S>('Charge', noop, 'charge').touches('stripe').retry({ attempts: 1, timeoutMs: 50 }).build();
    expect(once.root.touches?.system).toBe('stripe');
  });

  it('every option-bag site takes `touches`', () => {
    const touches = { system: 'stripe', idempotencyKey: key };
    const retry = { attempts: 2 };
    const chart = flowChart<S>('Seed', noop, 'seed', { touches, retry })
      .addDeciderFunction('Route', () => 'a', 'route', undefined, { touches, retry })
      .addFunctionBranch('a', 'A', noop, undefined, { touches, retry })
      .addPausableFunctionBranch('p', 'P', { execute: noop, resume: noop }, undefined, { touches, retry })
      .end()
      .addSelectorFunction('Pick', () => ['b'], 'pick', undefined, { touches, retry })
      .addFunctionBranch('b', 'B', noop, undefined, { touches, retry })
      .end()
      .addListOfFunction([{ id: 'c', name: 'C', fn: noop, touches, retry }])
      .build();
    const spec = JSON.stringify(chart.buildTimeStructure);
    expect(spec.match(/"touches":"stripe"/g)?.length).toBe(7);
  });

  it('flowChartSelector takes `touches` for its root selector', () => {
    const chart = flowChartSelector<S>('Pick', () => ['b'], 'pick', {
      touches: { system: 'stripe', idempotencyKey: key },
      retry: { attempts: 2 },
    })
      .addFunctionBranch('b', 'B', noop)
      .end()
      .build();
    expect(chart.root.touches?.system).toBe('stripe');
    expect(chart.buildTimeStructure.touches).toBe('stripe');
    expect(() =>
      flowChartSelector<S>('Pick', () => ['b'], 'pick', { touches: { system: 'stripe' }, retry: { attempts: 2 } }),
    ).toThrow(/idempotencyKey/);
  });

  it('a no-touch chart has no `touches` key anywhere (byte identity)', () => {
    const chart = flowChart<S>('Seed', noop, 'seed').addFunction('Work', noop, 'work').retry({ attempts: 2 }).build();
    expect(JSON.stringify(chart.buildTimeStructure)).not.toContain('touches');
    expect(Object.prototype.hasOwnProperty.call(chart.root, 'touches')).toBe(false);
  });
});

describe('the build law — a retried touch without a key is refused', () => {
  it('.touches() then .retry()', () => {
    expect(() =>
      flowChart<S>('Seed', noop, 'seed').addFunction('Charge', noop, 'charge').touches('stripe').retry({ attempts: 3 }),
    ).toThrow(/touches "stripe".*idempotencyKey/s);
  });

  it('.retry() then .touches()', () => {
    expect(() =>
      flowChart<S>('Seed', noop, 'seed').addFunction('Charge', noop, 'charge').retry({ attempts: 3 }).touches('stripe'),
    ).toThrow(/touches "stripe".*idempotencyKey/s);
  });

  it('in one option bag, at every site', () => {
    const bad = { touches: { system: 'stripe' }, retry: { attempts: 2 } };
    expect(() => flowChart<S>('Seed', noop, 'seed', bad)).toThrow(/idempotencyKey/);
    expect(() =>
      flowChart<S>('Seed', noop, 'seed').addDeciderFunction('Route', () => 'a', 'route', undefined, bad),
    ).toThrow(/idempotencyKey/);
    expect(() =>
      flowChart<S>('Seed', noop, 'seed')
        .addDeciderFunction('Route', () => 'a', 'route')
        .addFunctionBranch('a', 'A', noop, undefined, bad),
    ).toThrow(/idempotencyKey/);
    expect(() =>
      flowChart<S>('Seed', noop, 'seed').addListOfFunction([{ id: 'c', name: 'C', fn: noop, ...bad }]),
    ).toThrow(/idempotencyKey/);
  });

  it('refuses a constant key: the rule is a function of the execution', () => {
    expect(() =>
      flowChart<S>('Charge', noop, 'charge').touches('stripe', { idempotencyKey: 'fixed' as never }),
    ).toThrow(/function/);
  });

  it('refuses a bad system name, a second declaration, and nodes with no function of their own', () => {
    expect(() => flowChart<S>('Charge', noop, 'charge').touches('')).toThrow(/system/);
    expect(() => flowChart<S>('Charge', noop, 'charge').touches('a‮b')).toThrow(/system/);
    expect(() => flowChart<S>('Charge', noop, 'charge').touches('stripe').touches('stripe')).toThrow(/already/);
    const sub = flowChart<S>('Inner', noop, 'inner').build();
    expect(() =>
      flowChart<S>('Seed', noop, 'seed').addSubFlowChartNext('mount', sub, 'Mount').touches('stripe'),
    ).toThrow(/subflow/);
    expect(() =>
      flowChart<S>('Seed', noop, 'seed')
        .addParallelForEach('Fan', 'fan', { items: () => [], branch: () => sub, maxBranches: 2, into: 'out' } as never)
        .touches('stripe'),
    ).toThrow(/parallel/);
  });
});
