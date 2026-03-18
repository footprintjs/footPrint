/**
 * Unit test: lazy subflow resolution mechanics.
 *
 * When a node has `subflowResolver`, the engine must:
 *   1. Call the resolver on first execution (not at build time).
 *   2. Register the resolved subflow (prefix node tree, merge stageMap).
 *   3. Execute the subflow normally after resolution.
 *   4. Update runtime structure with the resolved spec.
 *   5. Clear the resolver after resolution (call at most once).
 */

import { flowChart, FlowChartExecutor } from '../../../../src/index';

// ---------------------------------------------------------------------------
// Helpers — track execution via closure side effects (subflows are isolated)
// ---------------------------------------------------------------------------

const noop = async () => {};

function buildTrackedSubflow(name: string, id: string, order: string[]) {
  return flowChart(
    `${name}-Start`,
    async () => {
      order.push(`${id}-start`);
    },
    `${id}-start`,
  )
    .addFunction(
      `${name}-End`,
      async () => {
        order.push(`${id}-end`);
      },
      `${id}-end`,
    )
    .build();
}

// ---------------------------------------------------------------------------
// Unit: addLazySubFlowChartBranch on DeciderList
// ---------------------------------------------------------------------------

describe('Unit: lazy subflow — decider branch', () => {
  it('resolves and executes lazy subflow on selected branch', async () => {
    let resolverCalled = 0;
    const order: string[] = [];

    const chart = flowChart(
      'Start',
      async () => {
        order.push('start');
      },
      'start',
    )
      .addDeciderFunction(
        'Route',
        async () => {
          order.push('route');
          return 'auth';
        },
        'route',
      )
      .addFunctionBranch('standard', 'Standard', async () => {
        order.push('standard');
      })
      .addLazySubFlowChartBranch(
        'auth',
        () => {
          resolverCalled++;
          return buildTrackedSubflow('Auth', 'auth', order);
        },
        'Auth Service',
      )
      .setDefault('standard')
      .end()
      .build();

    const executor = new FlowChartExecutor(chart);
    await executor.run();

    expect(order).toEqual(['start', 'route', 'auth-start', 'auth-end']);
    expect(resolverCalled).toBe(1);

    const subResults = executor.getSubflowResults();
    expect(subResults.size).toBeGreaterThan(0);
  });

  it('does not call resolver when branch is not selected', async () => {
    let resolverCalled = 0;
    const order: string[] = [];

    const chart = flowChart(
      'Start',
      async () => {
        order.push('start');
      },
      'start',
    )
      .addDeciderFunction(
        'Route',
        async () => {
          return 'standard';
        },
        'route',
      )
      .addFunctionBranch('standard', 'Standard', async () => {
        order.push('standard');
      })
      .addLazySubFlowChartBranch(
        'auth',
        () => {
          resolverCalled++;
          return buildTrackedSubflow('Auth', 'auth', order);
        },
        'Auth Service',
      )
      .setDefault('standard')
      .end()
      .build();

    const executor = new FlowChartExecutor(chart);
    await executor.run();

    expect(order).toContain('standard');
    expect(order).not.toContain('auth-start');
    expect(resolverCalled).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Unit: addLazySubFlowChartBranch on SelectorFnList
// ---------------------------------------------------------------------------

describe('Unit: lazy subflow — selector branch', () => {
  it('resolves only selected lazy branches', async () => {
    let authResolved = 0;
    let paymentResolved = 0;
    let notifResolved = 0;
    const order: string[] = [];

    const chart = flowChart(
      'Start',
      async () => {
        order.push('start');
      },
      'start',
    )
      .addSelectorFunction(
        'Route',
        async () => {
          return ['auth', 'payment'];
        },
        'route',
      )
      .addLazySubFlowChartBranch(
        'auth',
        () => {
          authResolved++;
          return buildTrackedSubflow('Auth', 'auth', order);
        },
        'Auth',
      )
      .addLazySubFlowChartBranch(
        'payment',
        () => {
          paymentResolved++;
          return buildTrackedSubflow('Payment', 'payment', order);
        },
        'Payment',
      )
      .addLazySubFlowChartBranch(
        'notif',
        () => {
          notifResolved++;
          return buildTrackedSubflow('Notif', 'notif', order);
        },
        'Notification',
      )
      .end()
      .build();

    const executor = new FlowChartExecutor(chart);
    await executor.run();

    expect(order).toContain('auth-start');
    expect(order).toContain('payment-start');
    expect(order).not.toContain('notif-start');

    expect(authResolved).toBe(1);
    expect(paymentResolved).toBe(1);
    expect(notifResolved).toBe(0);
  });

  it('skips all when selector returns empty array', async () => {
    let resolved = 0;
    const order: string[] = [];

    const chart = flowChart('Start', noop, 'start')
      .addSelectorFunction('Route', async () => [], 'route')
      .addLazySubFlowChartBranch('svc', () => {
        resolved++;
        return buildTrackedSubflow('Svc', 'svc', order);
      })
      .end()
      .addFunction(
        'After',
        async () => {
          order.push('after');
        },
        'after',
      )
      .build();

    const executor = new FlowChartExecutor(chart);
    await executor.run();

    expect(order).toContain('after');
    expect(order).not.toContain('svc-start');
    expect(resolved).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Unit: addLazySubFlowChartNext (linear chain)
// ---------------------------------------------------------------------------

describe('Unit: lazy subflow — linear next', () => {
  it('resolves and executes lazy subflow in linear chain', async () => {
    let resolved = 0;
    const order: string[] = [];

    const chart = flowChart(
      'Start',
      async () => {
        order.push('start');
      },
      'start',
    )
      .addLazySubFlowChartNext(
        'sf-inner',
        () => {
          resolved++;
          return buildTrackedSubflow('Inner', 'inner', order);
        },
        'Inner Flow',
      )
      .build();

    const executor = new FlowChartExecutor(chart);
    await executor.run();

    expect(order).toEqual(['start', 'inner-start', 'inner-end']);
    expect(resolved).toBe(1);

    const subResults = executor.getSubflowResults();
    expect(subResults.size).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// Unit: addLazySubFlowChart (parallel child)
// ---------------------------------------------------------------------------

describe('Unit: lazy subflow — parallel child', () => {
  it('resolves and executes lazy subflow as parallel child', async () => {
    let resolved = 0;
    const order: string[] = [];

    const chart = flowChart(
      'Fork',
      async () => {
        order.push('fork');
      },
      'fork',
    )
      .addLazySubFlowChart(
        'sf-worker',
        () => {
          resolved++;
          return buildTrackedSubflow('Worker', 'worker', order);
        },
        'Worker',
      )
      .build();

    const executor = new FlowChartExecutor(chart);
    await executor.run();

    expect(order).toContain('fork');
    expect(order).toContain('worker-start');
    expect(order).toContain('worker-end');
    expect(resolved).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Unit: isLazy flag in spec
// ---------------------------------------------------------------------------

describe('Unit: lazy subflow — spec isLazy flag', () => {
  it('marks lazy branches with isLazy: true in spec', () => {
    const chart = flowChart('Start', noop, 'start')
      .addSelectorFunction('Route', async () => [], 'route')
      .addFunctionBranch('eager', 'Eager', noop)
      .addLazySubFlowChartBranch('lazy', () => buildTrackedSubflow('X', 'x', []), 'Lazy Svc')
      .end()
      .build();

    const spec = chart.buildTimeStructure;
    const routeSpec = spec.next!;
    const children = routeSpec.children!;

    const eagerChild = children.find((c) => c.id === 'eager');
    const lazyChild = children.find((c) => c.id === 'lazy');

    expect(eagerChild?.isLazy).toBeUndefined();
    expect(lazyChild?.isLazy).toBe(true);
    expect(lazyChild?.subflowStructure).toBeUndefined(); // no eager expansion
    expect(lazyChild?.isSubflowRoot).toBe(true);
  });

  it('does NOT eagerly clone subflow tree for lazy branches', () => {
    const chart = flowChart('Start', noop, 'start')
      .addSelectorFunction('Route', async () => [], 'route')
      .addLazySubFlowChartBranch('svc', () => buildTrackedSubflow('Svc', 'svc', []))
      .end()
      .build();

    // Subflows dict should be empty — no eager registration
    expect(chart.subflows).toBeUndefined();
  });

  it('addLazySubFlowChartNext marks spec with isLazy', () => {
    const chart = flowChart('Start', noop, 'start')
      .addLazySubFlowChartNext('sf-x', () => buildTrackedSubflow('X', 'x', []), 'X Flow')
      .build();

    const spec = chart.buildTimeStructure;
    expect(spec.next?.isLazy).toBe(true);
    expect(spec.next?.isSubflowRoot).toBe(true);
    expect(spec.next?.subflowStructure).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Unit: resolver called at most once
// ---------------------------------------------------------------------------

describe('Unit: lazy subflow — resolver idempotency', () => {
  it('calls resolver exactly once per execution', async () => {
    let resolverCount = 0;
    const order: string[] = [];

    const chart = flowChart(
      'Start',
      async () => {
        order.push('start');
      },
      'start',
    )
      .addLazySubFlowChartNext(
        'sf-inner',
        () => {
          resolverCount++;
          return buildTrackedSubflow('Inner', 'inner', order);
        },
        'Inner',
      )
      .build();

    const executor = new FlowChartExecutor(chart);
    await executor.run();

    expect(resolverCount).toBe(1);
    expect(order).toContain('inner-start');
  });
});
