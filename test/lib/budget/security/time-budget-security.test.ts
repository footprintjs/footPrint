/**
 * The static time budget against hostile input (design §3.2, packet P5 — threat model: the computation must
 * terminate on huge or looping charts; loops count as unbounded, never iterated; the work stays bounded, memoised
 * per node).
 *
 * `timeBudget` reads a chart and a caller's assumptions. A hand-built chart may carry real object cycles the builder
 * never makes; assumptions may come from a parsed request. Neither may hang the walk, blow its work up, or reach a
 * value through the prototype chain.
 *
 * Test types: Security (prototype keys are never assumptions; assumptions are read ONCE — a getter that changes, a
 * Proxy, a non-enumerable key cannot hand the walk an unvalidated value; object cycles through `next`, `children` and
 * a subflow that mounts itself terminate as `loop`; a definition shared at every level of a 40-deep nesting is walked
 * once, and its passes multiply without the path growing; a user backoff is never called by the check, so its side
 * effects and its error-dependent answers cannot reach the budget).
 */
import { describe, expect, it } from 'vitest';

import type { FlowChart, StageNode } from '../../../../src/index.js';
import { flowChart, timeBudget } from '../../../../src/index.js';

const noop = () => undefined;
const capped = (id: string, timeoutMs = 1): StageNode => ({
  name: id,
  id,
  fn: noop,
  retry: { attempts: 1, timeoutMs },
});
const chartOf = (root: StageNode, subflows?: Record<string, { root: StageNode }>): FlowChart =>
  ({
    root,
    stageMap: new Map(),
    ...(subflows && { subflows }),
    buildTimeStructure: { name: root.name, id: root.id, type: 'stage' },
    description: '',
    stageDescriptions: new Map(),
  } as unknown as FlowChart);

describe('assumptions are own properties only', () => {
  it('an inherited assumption is not an assumption', () => {
    const chart = flowChart('Ask', noop, 'ask', { retry: { attempts: 1, timeoutMs: 5 } })
      .loopTo('ask')
      .build();
    const loops = Object.create({ ask: 3 }) as Record<string, number>;
    expect(timeBudget(chart, { assume: { loops } }).unbounded).toEqual([{ stageId: 'ask', why: 'loop' }]);
  });

  it("loop targets named after Object.prototype's members find nothing there", () => {
    for (const id of ['constructor', 'toString', 'hasOwnProperty', 'valueOf']) {
      const chart = flowChart('S', noop, id, { retry: { attempts: 1, timeoutMs: 5 } })
        .loopTo(id)
        .build();
      const report = timeBudget(chart, { assume: { loops: {}, lazy: {}, branches: {} } });
      expect(report.unbounded).toEqual([{ stageId: id, why: 'loop' }]);
    }
  });

  it('a parsed "__proto__" key is an own key like any other — and changes no prototype', () => {
    const loops = JSON.parse('{"__proto__": 2, "ask": 2}') as Record<string, number>;
    const chart = flowChart('Ask', noop, 'ask', { retry: { attempts: 1, timeoutMs: 5 } })
      .loopTo('ask')
      .build();
    expect(timeBudget(chart, { assume: { loops } }).worstCaseMs).toBe(10);
    expect(({} as Record<string, unknown>).ask).toBeUndefined();
  });
});

describe('assumptions are read once, from a validated copy', () => {
  const looping = () =>
    flowChart('Ask', noop, 'ask', { retry: { attempts: 1, timeoutMs: 5 } })
      .loopTo('ask')
      .build();

  it('a getter that answers 2 when validated and NaN afterwards is read once — the walk sees 2', () => {
    let reads = 0;
    const loops = {
      get ask() {
        reads += 1;
        return reads === 1 ? 2 : Number.NaN;
      },
    };
    const report = timeBudget(looping(), { assume: { loops } });
    expect(report.worstCaseMs).toBe(10);
    expect(reads).toBe(1);
  });

  it('a Proxy that lies on its second read cannot reach the walk', () => {
    let reads = 0;
    const loops = new Proxy({ ask: 3 } as Record<string, number>, {
      get: (target, key) => (++reads > 1 ? -1 : target[key as string]),
    });
    expect(timeBudget(looping(), { assume: { loops } }).worstCaseMs).toBe(15);
  });

  it('a non-enumerable own key is not an assumption (it was never validated)', () => {
    const loops = {};
    Object.defineProperty(loops, 'ask', { value: Number.NaN, enumerable: false });
    const report = timeBudget(looping(), { assume: { loops } });
    expect(report.unbounded).toEqual([{ stageId: 'ask', why: 'loop' }]);
    expect(Number.isNaN(report.knownMs)).toBe(false);
  });
});

describe('object cycles terminate as loops', () => {
  it('a next chain that closes on itself (no loop stub)', () => {
    const a = capped('a', 3);
    const b = capped('b', 4);
    a.next = b;
    b.next = a;
    const report = timeBudget(chartOf(a));
    expect(report.unbounded).toEqual([{ stageId: 'a', why: 'loop' }]);
    expect(report.knownMs).toBe(7);
    expect(timeBudget(chartOf(a), { assume: { loops: { a: 2 } } }).worstCaseMs).toBe(14);
  });

  it('a node that is its own child', () => {
    const a = capped('a', 3);
    a.children = [a];
    const report = timeBudget(chartOf(a));
    expect(report.worstCaseMs).toBeNull();
    expect(report.unbounded).toEqual([{ stageId: 'a', why: 'loop' }]);
  });

  it('a subflow whose definition mounts itself', () => {
    const mount: StageNode = { name: 's', id: 's', isSubflowRoot: true, subflowId: 's' };
    const report = timeBudget(chartOf(mount, { s: { root: mount } }));
    expect(report.worstCaseMs).toBeNull();
    expect(report.unbounded).toEqual([{ stageId: 's', why: 'loop' }]);
  });
});

describe('the work is bounded: memoised per node', () => {
  it('one definition mounted twice at each of 40 levels: walked once per node, passes multiply, the path stays short', () => {
    const subflows: Record<string, { root: StageNode }> = {};
    let def: StageNode = capped('leaf', 1);
    for (let level = 1; level <= 40; level++) {
      subflows[`l${level}`] = { root: def };
      const first: StageNode = { name: `l${level}`, id: `l${level}`, isSubflowRoot: true, subflowId: `l${level}` };
      first.next = { name: `l${level}`, id: `l${level}-again`, isSubflowRoot: true, subflowId: `l${level}` };
      def = first;
    }

    const started = Date.now();
    const report = timeBudget(chartOf(def, subflows));

    expect(Date.now() - started).toBeLessThan(2_000);
    expect(report.worstCaseMs).toBe(2 ** 40);
    expect(report.criticalPath).toEqual([
      { stageId: 'leaf', attempts: 1, timeoutMs: 1, backoffMs: 0, worstMs: 1, passes: 2 ** 40 },
    ]);
  });

  it('a user backoff is never called by the check, however many times its subflow is mounted', () => {
    let asked = 0;
    const pay = flowChart('Charge', noop, 'charge', {
      retry: {
        attempts: 3,
        timeoutMs: 10,
        backoffMs: () => {
          asked += 1;
          return 1;
        },
        maxBackoffMs: 1,
      },
    }).build();
    let builder = flowChart('Seed', noop, 'seed', { retry: { attempts: 1, timeoutMs: 1 } }).addSubFlowChartNext(
      'pay',
      pay,
    );
    for (let i = 0; i < 20; i++) builder = builder.addFunction(`S${i}`, noop, `s${i}`).addSubFlowChartNext('pay', pay);

    const report = timeBudget(builder.build());

    expect(asked).toBe(0);
    expect(report.knownMs).toBe(1 + 21 * (3 * 10 + 2 * 1)); // the s<i> stages have no timeoutMs: counted 0
  });
});
