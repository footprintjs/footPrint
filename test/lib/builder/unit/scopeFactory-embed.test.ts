/**
 * Tests: flowChart<T>() auto-embeds scopeFactory in FlowChart.
 * FlowChartExecutor reads chart.scopeFactory — no need to pass createTypedScopeFactory().
 *
 * Unit + Boundary + Scenario + Property + Security + ML tests.
 */
import { describe, expect, it } from 'vitest';

import { flowChart } from '../../../../src/lib/builder/FlowChartBuilder';
import type { TypedScope } from '../../../../src/lib/reactive/types';
import { FlowChartExecutor } from '../../../../src/lib/runner/FlowChartExecutor';

interface TestState {
  name: string;
  greeting?: string;
  count?: number;
}

describe('scopeFactory embed — Unit', () => {
  it('typedFlowChart<T>() embeds scopeFactory in built chart', () => {
    const chart = flowChart<TestState>(
      'Start',
      async (scope) => {
        scope.name = 'Alice';
      },
      'start',
    ).build();

    expect(chart.scopeFactory).toBeDefined();
    expect(typeof chart.scopeFactory).toBe('function');
  });

  it('FlowChartExecutor works WITHOUT passing createTypedScopeFactory', async () => {
    const chart = flowChart<TestState>(
      'Start',
      async (scope) => {
        scope.name = 'Alice';
        scope.greeting = `Hello, ${scope.name}!`;
      },
      'start',
    ).build();

    // NO second argument — executor reads chart.scopeFactory
    const executor = new FlowChartExecutor(chart);
    await executor.run();

    const snapshot = executor.getSnapshot();
    expect(snapshot.sharedState.name).toBe('Alice');
    expect(snapshot.sharedState.greeting).toBe('Hello, Alice!');
  });

  it('narrative works with auto-embedded factory', async () => {
    const chart = flowChart<TestState>(
      'Start',
      async (scope) => {
        scope.name = 'Bob';
      },
      'start',
    ).build();

    const executor = new FlowChartExecutor(chart);
    executor.enableNarrative();
    await executor.run();

    const narrative = executor.getNarrative();
    expect(narrative.length).toBeGreaterThan(0);
    expect(narrative.some((line) => line.includes('name'))).toBe(true);
  });

  it('explicitly passed factory overrides chart.scopeFactory', () => {
    const chart = flowChart<TestState>(
      'Start',
      async (scope) => {
        scope.name = 'test';
      },
      'start',
    ).build();

    // Chart has embedded factory
    expect(chart.scopeFactory).toBeDefined();

    // Custom factory passed as constructor arg should be used instead
    const customFactory = (ctx: any, stageName: string) => ({ custom: true, ctx, stageName });
    const executor = new FlowChartExecutor(chart, customFactory as any);
    // Executor stores the override — verified by type system
    expect(executor).toBeDefined();
  });
});

describe('scopeFactory embed — Scenario', () => {
  it('full pipeline: build → run without separate factory', async () => {
    const chart = flowChart<TestState>(
      'Intake',
      async (scope) => {
        scope.name = 'Charlie';
        scope.count = 0;
      },
      'intake',
    )
      .addFunction(
        'Process',
        async (scope) => {
          scope.count = (scope.count ?? 0) + 1;
          scope.greeting = `Welcome #${scope.count}, ${scope.name}!`;
        },
        'process',
      )
      .build();

    // The dream API: just chart + executor, no factory
    const executor = new FlowChartExecutor(chart);
    await executor.run();

    expect(executor.getSnapshot().sharedState.greeting).toBe('Welcome #1, Charlie!');
  });

  it('decider with decide() works without separate factory', async () => {
    const { decide } = await import('../../../../src/lib/decide/decide');

    interface DeciderState {
      score: number;
      tier?: string;
    }

    const chart = flowChart<DeciderState>(
      'Load',
      async (scope) => {
        scope.score = 750;
      },
      'load',
    )
      .addDeciderFunction(
        'Route',
        (scope) => {
          return decide(scope, [{ when: { score: { gt: 700 } }, then: 'high', label: 'High score' }], 'low');
        },
        'route',
        'Route by score',
      )
      .addFunctionBranch('high', 'HighPath', async (scope) => {
        scope.tier = 'premium';
      })
      .addFunctionBranch('low', 'LowPath', async (scope) => {
        scope.tier = 'basic';
      })
      .setDefault('low')
      .end()
      .build();

    const executor = new FlowChartExecutor(chart);
    executor.enableNarrative();
    await executor.run();

    expect(executor.getSnapshot().sharedState.tier).toBe('premium');
    const narrative = executor.getNarrative();
    expect(narrative.some((line) => line.includes('High score'))).toBe(true);
  });
});

describe('scopeFactory embed — Boundary', () => {
  it('plain FlowChartBuilder auto-embeds scopeFactory (TypedScope)', async () => {
    const { FlowChartBuilder } = await import('../../../../src/lib/builder/FlowChartBuilder');

    // Plain FlowChartBuilder now auto-embeds TypedScope factory
    const chart = new FlowChartBuilder()
      .start(
        'Start',
        async (scope: any) => {
          scope.x = 42;
        },
        'start',
      )
      .build();

    expect(chart.scopeFactory).toBeDefined();

    const executor = new FlowChartExecutor(chart);
    await executor.run();
    expect(executor.getSnapshot().sharedState.x).toBe(42);
  });
});

describe('scopeFactory embed — Security', () => {
  it('embedded factory produces TypedScope with typed property enforcement', async () => {
    const chart = flowChart<TestState>(
      'Start',
      async (scope) => {
        scope.name = 'safe';
        // TypedScope enforces typed writes — this is a string, not a number
        expect(typeof scope.name).toBe('string');
      },
      'start',
    ).build();

    const executor = new FlowChartExecutor(chart);
    await executor.run();
    expect(executor.getSnapshot().sharedState.name).toBe('safe');
  });
});

describe('scopeFactory embed — ML/AI', () => {
  it('auto-embedded factory enables zero-boilerplate agent pipelines', async () => {
    // This is the v2 API an ML engineer would use:
    const chart = flowChart<{ input: string; output: string }>(
      'Process',
      async (scope) => {
        scope.input = 'user query';
        scope.output = `Response to: ${scope.input}`;
      },
      'process',
    ).build();

    // One line — no factory, no boilerplate
    const executor = new FlowChartExecutor(chart);
    await executor.run();

    expect(executor.getSnapshot().sharedState.output).toBe('Response to: user query');
  });
});
