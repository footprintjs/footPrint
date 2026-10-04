import { describe, expect, it } from 'vitest';

import type { StageContext, StageNode } from '../../../../src/advanced.js';
import { ScopeFacade } from '../../../../src/advanced.js';
import { flowChart, FlowChartExecutor } from '../../../../src/index.js';
import { DiagnosticCollector } from '../../../../src/lib/memory/DiagnosticCollector.js';
import { RedactionRule } from '../../../../src/lib/memory/redaction.js';

type Mode = 'first-only' | 'always' | 'static-plus-next' | 'static-only';

async function runRepeated(mode: Mode, masked: boolean, spoof?: boolean) {
  let visits = 0;
  let childRuns = 0;
  const child: StageNode = {
    name: 'Child',
    id: 'child',
    fn: (scope) => {
      childRuns++;
      scope.$debug('visit', visits);
    },
  };
  const chart = flowChart<object>(
    'Producer',
    (scope) => {
      visits++;
      if (spoof !== undefined) scope.$debug('isDynamic', spoof);
      if (mode === 'always' || (mode === 'first-only' && visits === 1)) {
        return { name: 'Dynamic', children: [child] };
      }
      if (mode === 'static-plus-next' && visits === 1) {
        return { name: 'Dynamic', next: { name: 'Check', id: 'check' } };
      }
    },
    'producer',
  )
    .addFunction(
      'Check',
      (scope) => {
        if (visits >= 2) scope.$break();
      },
      'check',
    )
    .loopTo('producer')
    .build();
  if (mode.startsWith('static')) chart.root.children = [child];
  const executor = new FlowChartExecutor(chart);
  if (masked) executor.setRedactionPolicy({ diagnostics: { keys: ['logs.isDynamic'] } });
  await executor.run();
  return { visits, childRuns, snapshot: executor.getSnapshot() };
}

describe.each([false, true])('dynamic result capture with diagnostic flag masked=%s', (masked) => {
  it.each([
    ['first-only', 1],
    ['always', 2],
    ['static-plus-next', 1],
    ['static-only', undefined],
  ] as const)('captures only qualifying visits for %s', async (mode, capturedVisit) => {
    const { visits, childRuns, snapshot } = await runRepeated(mode, masked);
    expect(visits).toBe(2);
    expect(childRuns).toBe(2);
    if (capturedVisit === undefined) {
      expect(snapshot.subflowResults?.producer).toBeUndefined();
    } else {
      expect(snapshot.subflowResults?.producer).toMatchObject({
        subflowId: 'producer',
        treeContext: {
          stageContexts: { Child: { output: { visit: capturedVisit }, status: 'success' } },
        },
        pipelineStructure: { children: [{ id: 'child', name: 'Child', type: 'stage' }] },
      });
    }
  });

  it.each([false, true])('does not let a user log isDynamic=%s manufacture dynamic capture', async (spoof) => {
    // Named correction: the old engine trusted a public diagnostic entry as
    // control state. A mask is truthy regardless of the logged boolean.
    const { visits, childRuns, snapshot } = await runRepeated('static-only', masked, spoof);
    expect(visits).toBe(2);
    expect(childRuns).toBe(2);
    expect(snapshot.executionTree.logs.isDynamic).toBe(masked ? '[REDACTED]' : spoof);
    expect(snapshot.subflowResults?.producer).toBeUndefined();
  });
});

describe('diagnostic writer return compatibility without a policy', () => {
  it.each([
    ['absent', undefined],
    ['state-only', new RedactionRule({ keys: ['secret'] })],
    ['empty diagnostics', new RedactionRule({ diagnostics: {} })],
  ] as const)('keeps flow messages borrowed without reading getters for %s policy', (_name, rule) => {
    const collector = new DiagnosticCollector(() => rule);
    const message = { type: 'next' as const, description: 'unused' };
    let reads = 0;
    Object.defineProperty(message, 'description', {
      enumerable: true,
      get() {
        reads++;
        throw new Error('An inert diagnostic policy must not read this payload');
      },
    });
    expect(() => collector.addFlowMessage(message)).not.toThrow();
    expect(reads).toBe(0);
    expect(collector.flowMessages[0]).toBe(message);
  });

  it.each(['context', 'collector'] as const)('keeps scalar-returning %s calls void', async (door) => {
    let context: StageContext;
    const executor = new FlowChartExecutor(
      flowChart<void, ScopeFacade>(
        'Log',
        () => (door === 'context' ? context : context.debug).addLog('value', 42),
        'log',
      ).build(),
      {
        scopeFactory: (ctx, name, args, env) => {
          context = ctx;
          return new ScopeFacade(ctx, name, args, env);
        },
      },
    );
    expect(await executor.run()).toBeUndefined();
    expect(executor.getSnapshot().executionTree.logs.value).toBe(42);
  });

  it.each(['context', 'collector'] as const)(
    'does not execute a StageNode-shaped %s diagnostic value',
    async (door) => {
      let context: StageContext;
      let unexpectedChildRuns = 0;
      const diagnostic = {
        name: 'Diagnostic, not a stage return',
        children: [
          {
            name: 'Must not run',
            id: 'must-not-run',
            fn: () => {
              unexpectedChildRuns++;
            },
          },
        ],
      };
      const executor = new FlowChartExecutor(
        flowChart<void, ScopeFacade>(
          'Log',
          () => (door === 'context' ? context : context.debug).addLog('value', diagnostic),
          'log',
        ).build(),
        {
          scopeFactory: (ctx, name, args, env) => {
            context = ctx;
            return new ScopeFacade(ctx, name, args, env);
          },
        },
      );
      expect(await executor.run()).toBeUndefined();
      expect(unexpectedChildRuns).toBe(0);
      expect(executor.getSnapshot().executionTree.logs.value).toBe(diagnostic);
      expect(executor.getSnapshot().subflowResults).toBeUndefined();
    },
  );
});
