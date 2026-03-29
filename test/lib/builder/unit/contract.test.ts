/**
 * Tests: .contract() — unified input/output/mapper declaration.
 * Unit + Scenario + Boundary + Security + Property + ML.
 */
import { describe, expect, it } from 'vitest';

import { flowChart } from '../../../../src/lib/builder';

interface State {
  amount: number;
  status?: string;
}

// -- Unit ------------------------------------------------------------------

describe('.contract() — Unit', () => {
  it('contract sets inputSchema on built chart', () => {
    const inputSchema = { type: 'object', properties: { amount: { type: 'number' } } };
    const chart = flowChart<State>(
      'Start',
      async (scope) => {
        scope.amount = 10;
      },
      'start',
    )
      .contract({ input: inputSchema })
      .build();

    expect(chart.inputSchema).toBe(inputSchema);
  });

  it('contract sets outputSchema on built chart', () => {
    const outputSchema = { type: 'object', properties: { status: { type: 'string' } } };
    const chart = flowChart<State>(
      'Start',
      async (scope) => {
        scope.amount = 10;
      },
      'start',
    )
      .contract({ output: outputSchema })
      .build();

    expect(chart.outputSchema).toBe(outputSchema);
  });

  it('contract sets outputMapper on built chart', () => {
    const mapper = (state: Record<string, unknown>) => ({ result: state.status });
    const chart = flowChart<State>(
      'Start',
      async (scope) => {
        scope.amount = 10;
      },
      'start',
    )
      .contract({ mapper })
      .build();

    expect(chart.outputMapper).toBe(mapper);
  });

  it('contract sets all three at once', () => {
    const chart = flowChart<State>(
      'Start',
      async (scope) => {
        scope.amount = 10;
      },
      'start',
    )
      .contract({
        input: { type: 'object' },
        output: { type: 'object' },
        mapper: (s) => ({ result: s.status }),
      })
      .build();

    expect(chart.inputSchema).toBeDefined();
    expect(chart.outputSchema).toBeDefined();
    expect(chart.outputMapper).toBeDefined();
  });

  it('contract is chainable', () => {
    const chart = flowChart<State>(
      'Start',
      async (scope) => {
        scope.amount = 10;
      },
      'start',
    )
      .contract({ input: { type: 'object' } })
      .build();

    expect(chart.inputSchema).toBeDefined();
  });
});

// -- Scenario --------------------------------------------------------------

describe('.contract() — Scenario', () => {
  it('contract with mapper: result.output uses mapper', async () => {
    const chart = flowChart<State>(
      'Start',
      async (scope) => {
        scope.amount = 99;
        scope.status = 'approved';
      },
      'start',
    )
      .contract({
        mapper: (s) => ({ decision: s.status, total: s.amount }),
      })
      .build();

    const result = await chart.run();
    expect(result.output).toEqual({ decision: 'approved', total: 99 });
    expect(result.state.amount).toBe(99);
    expect(result.state.status).toBe('approved');
  });

  it('contract with input: input accessible via $getArgs', async () => {
    const chart = flowChart<State>(
      'Start',
      async (scope) => {
        const args = scope.$getArgs<{ initialAmount: number }>();
        scope.amount = args.initialAmount;
      },
      'start',
    )
      .contract({ input: { type: 'object' } })
      .build();

    const result = await chart.run({ input: { initialAmount: 50 } });
    expect(result.state.amount).toBe(50);
  });

  it('contract sets both input and output when chained', () => {
    const chart = flowChart<State>(
      'Start',
      async (scope) => {
        scope.amount = 10;
      },
      'start',
    )
      .contract({ input: { old: true } })
      .contract({ output: { new: true } })
      .build();

    // Both set
    expect(chart.inputSchema).toEqual({ old: true });
    expect(chart.outputSchema).toEqual({ new: true });
  });
});

// -- Boundary --------------------------------------------------------------

describe('.contract() — Boundary', () => {
  it('empty contract is valid (no-op)', () => {
    const chart = flowChart<State>(
      'Start',
      async (scope) => {
        scope.amount = 10;
      },
      'start',
    )
      .contract({})
      .build();

    expect(chart.inputSchema).toBeUndefined();
    expect(chart.outputSchema).toBeUndefined();
    expect(chart.outputMapper).toBeUndefined();
  });

  it('contract with only mapper', () => {
    const chart = flowChart<State>(
      'Start',
      async (scope) => {
        scope.amount = 10;
      },
      'start',
    )
      .contract({ mapper: (s) => s.amount })
      .build();

    expect(chart.outputMapper).toBeDefined();
    expect(chart.inputSchema).toBeUndefined();
  });
});

// -- Security --------------------------------------------------------------

describe('.contract() — Security', () => {
  it('mapper cannot access scope methods, only state keys', async () => {
    const chart = flowChart<State>(
      'Start',
      async (scope) => {
        scope.amount = 42;
      },
      'start',
    )
      .contract({
        mapper: (state) => {
          // state is plain object, not scope — no methods
          expect(typeof (state as any).setValue).toBe('undefined');
          return { amount: state.amount };
        },
      })
      .build();

    const result = await chart.run();
    expect(result.output).toEqual({ amount: 42 });
  });
});

// -- ML/AI -----------------------------------------------------------------

describe('.contract() — ML/AI', () => {
  it('contract enables OpenAPI generation from chart metadata', () => {
    const chart = flowChart<State>(
      'Process',
      async (scope) => {
        scope.amount = 10;
      },
      'process',
    )
      .contract({
        input: { type: 'object', properties: { amount: { type: 'number' } } },
        output: { type: 'object', properties: { status: { type: 'string' } } },
      })
      .build();

    // Both schemas available for toOpenAPI()
    expect(chart.inputSchema).toBeDefined();
    expect(chart.outputSchema).toBeDefined();
  });
});
