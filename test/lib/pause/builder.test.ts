/**
 * addPausableFunction — 5-pattern tests.
 *
 * Tests the builder method for adding pausable stages.
 */
import { describe, expect, it } from 'vitest';

import type { PausableHandler } from '../../../src';
import { flowChart } from '../../../src';

// ── Helpers ─────────────────────────────────────────────────

interface TestState {
  value: string;
  approved?: boolean;
  [key: string]: unknown;
}

const approvalHandler: PausableHandler<any> = {
  execute: async (scope) => {
    scope.setValue('value', 'prepared');
    return { pause: true, data: { question: 'Approve?' } };
  },
  resume: async (scope, input: { approved: boolean }) => {
    scope.setValue('approved', input.approved);
  },
};

// ── Unit ────────────────────────────────────────────────────

describe('addPausableFunction — unit', () => {
  it('builds a chart with a pausable stage', () => {
    const chart = flowChart<TestState>(
      'Start',
      (scope) => {
        scope.value = 'init';
      },
      'start',
    )
      .addPausableFunction('Approve', approvalHandler, 'approve', 'Approval gate')
      .build();

    expect(chart).toBeDefined();
    expect(chart.root).toBeDefined();
  });

  it('pausable stage has isPausable flag on the node', () => {
    const chart = flowChart<TestState>(
      'Start',
      (scope) => {
        scope.value = 'init';
      },
      'start',
    )
      .addPausableFunction('Approve', approvalHandler, 'approve')
      .build();

    // Walk to the pausable node
    const approveNode = chart.root.next;
    expect(approveNode).toBeDefined();
    expect(approveNode!.isPausable).toBe(true);
    expect(approveNode!.resumeFn).toBeDefined();
    expect(approveNode!.fn).toBeDefined();
  });

  it('spec shows isPausable flag', () => {
    const builder = flowChart<TestState>(
      'Start',
      (scope) => {
        scope.value = 'init';
      },
      'start',
    ).addPausableFunction('Approve', approvalHandler, 'approve', 'Approval gate');

    const spec = builder.toSpec();
    const specStr = JSON.stringify(spec);
    expect(specStr).toContain('"isPausable":true');
    expect(specStr).toContain('Approve');
  });

  it('pausable stage appears in stageMap', () => {
    const chart = flowChart<TestState>(
      'Start',
      (scope) => {
        scope.value = 'init';
      },
      'start',
    )
      .addPausableFunction('Approve', approvalHandler, 'approve')
      .build();

    expect(chart.stageMap.has('approve')).toBe(true);
  });
});

// ── Boundary ────────────────────────────────────────────────

describe('addPausableFunction — boundary', () => {
  it('pausable stage can be followed by regular stages', () => {
    const chart = flowChart<TestState>(
      'Start',
      (scope) => {
        scope.value = 'init';
      },
      'start',
    )
      .addPausableFunction('Approve', approvalHandler, 'approve')
      .addFunction(
        'Process',
        (scope) => {
          scope.value = 'processed';
        },
        'process',
      )
      .build();

    expect(chart.root.next?.next).toBeDefined();
    expect(chart.root.next?.next?.id).toBe('process');
  });

  it('pausable stage can follow other pausable stages', () => {
    const chart = flowChart<TestState>(
      'Start',
      (scope) => {
        scope.value = 'init';
      },
      'start',
    )
      .addPausableFunction('Approve1', approvalHandler, 'approve-1')
      .addPausableFunction('Approve2', approvalHandler, 'approve-2')
      .build();

    const node1 = chart.root.next;
    const node2 = node1?.next;
    expect(node1?.isPausable).toBe(true);
    expect(node2?.isPausable).toBe(true);
  });

  it('pausable stage with description', () => {
    const builder = flowChart<TestState>(
      'Start',
      (scope) => {
        scope.value = 'init';
      },
      'start',
    ).addPausableFunction('Approve', approvalHandler, 'approve', 'Manager must approve');

    const spec = builder.toSpec();
    const specStr = JSON.stringify(spec);
    expect(specStr).toContain('Manager must approve');
  });
});

// ── Scenario ────────────────────────────────────────────────

describe('addPausableFunction — scenario', () => {
  it('approval gate in a pipeline: prepare → approve → process → notify', () => {
    const chart = flowChart<TestState>(
      'Prepare',
      (scope) => {
        scope.value = 'order-123';
      },
      'prepare',
    )
      .addPausableFunction(
        'Approve',
        {
          execute: async (scope) => {
            return { pause: true, data: { question: `Approve order ${scope.$getValue('value')}?` } };
          },
          resume: async (scope, input: { yes: boolean }) => {
            scope.setValue('approved', input.yes);
          },
        },
        'approve',
        'Manager approval',
      )
      .addFunction(
        'Process',
        (scope) => {
          scope.setValue('value', 'processed');
        },
        'process',
      )
      .addFunction(
        'Notify',
        (scope) => {
          scope.setValue('value', 'notified');
        },
        'notify',
      )
      .build();

    // Verify graph structure
    expect(chart.root.id).toBe('prepare');
    expect(chart.root.next?.id).toBe('approve');
    expect(chart.root.next?.isPausable).toBe(true);
    expect(chart.root.next?.next?.id).toBe('process');
    expect(chart.root.next?.next?.next?.id).toBe('notify');
  });
});

// ── Property ────────────────────────────────────────────────

describe('addPausableFunction — property', () => {
  it('execute function is stored as fn, resume function as resumeFn', () => {
    const handler: PausableHandler<any> = {
      execute: async () => {},
      resume: async () => {},
    };

    const chart = flowChart<TestState>(
      'Start',
      (scope) => {
        scope.value = 'init';
      },
      'start',
    )
      .addPausableFunction('Gate', handler, 'gate')
      .build();

    const gateNode = chart.root.next!;
    expect(gateNode.fn).toBe(handler.execute);
    expect(gateNode.resumeFn).toBe(handler.resume);
  });

  it('loopTo works with pausable stages', () => {
    const chart = flowChart<TestState>(
      'Start',
      (scope) => {
        scope.value = 'init';
      },
      'start',
    )
      .addPausableFunction('Gate', approvalHandler, 'gate')
      .addFunction(
        'Process',
        (scope) => {
          scope.value = 'done';
        },
        'process',
      )
      .loopTo('start')
      .build();

    expect(chart).toBeDefined();
  });
});

// ── Security ────────────────────────────────────────────────

describe('addPausableFunction — security', () => {
  it('resume function is not serialized in spec (functions are not JSON-safe)', () => {
    const builder = flowChart<TestState>(
      'Start',
      (scope) => {
        scope.value = 'init';
      },
      'start',
    ).addPausableFunction('Gate', approvalHandler, 'gate');

    const spec = builder.toSpec();
    const json = JSON.stringify(spec);
    // Spec is JSON-safe — no functions
    expect(json).not.toContain('function');
    // But isPausable flag IS in spec for visualization
    expect(json).toContain('"isPausable":true');
  });
});

// ── Pausable Root Stage ───────────────────────────────────────

describe('flowChart() with PausableHandler as root stage', () => {
  it('creates a single-stage pausable flowchart', () => {
    const handler: PausableHandler<any> = {
      execute: async (scope) => {
        scope.value = 'executed';
        return { question: 'Continue?' };
      },
      resume: async (scope, input: { answer: string }) => {
        scope.value = input.answer;
      },
    };

    const chart = flowChart('PausableRoot', handler, 'pausable-root').build();
    expect(chart.root.isPausable).toBe(true);
    expect(chart.root.resumeFn).toBeDefined();
  });

  it('spec includes isPausable for root stage', () => {
    const handler: PausableHandler<any> = {
      execute: async () => ({ question: 'Approve?' }),
      resume: async () => {},
    };

    const builder = flowChart('Gate', handler, 'gate');
    const spec = builder.toSpec();
    expect(JSON.stringify(spec)).toContain('"isPausable":true');
  });

  it('pausable root can be chained with addFunction', () => {
    const handler: PausableHandler<any> = {
      execute: async (scope) => {
        scope.value = 'paused';
        return { question: 'Approve?' };
      },
      resume: async (scope, input: { ok: boolean }) => {
        scope.approved = input.ok;
      },
    };

    const chart = flowChart('Gate', handler, 'gate')
      .addFunction(
        'Process',
        (scope: any) => {
          scope.result = scope.approved ? 'approved' : 'denied';
        },
        'process',
      )
      .build();

    expect(chart.root.isPausable).toBe(true);
    expect(chart.stageMap.has('process')).toBe(true);
  });
});
