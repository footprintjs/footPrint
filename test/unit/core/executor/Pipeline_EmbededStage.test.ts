import { BaseState } from '../../../../src';
import { StageContext } from '../../../../src/core/memory/StageContext';
import { ScopeFactory } from '../../../../src/core/memory/types';
import { PipelineStageFunction, StageNode, Pipeline } from '../../../../src/core/executor';

class PipelineScope extends BaseState {}

const scopeFactory: ScopeFactory<PipelineScope> = (ctx: StageContext, stage: string) =>
  new PipelineScope(ctx as any, stage);

describe('Pipeline – Embedded Stage Functions', () => {
  it('executes a linear pipeline with embedded fn', async () => {
    const calls: string[] = [];

    const root: StageNode<any, PipelineScope> = {
      name: 'A',
      fn: jest.fn((scope: PipelineScope) => {
        calls.push('A');
        scope.setObject('a', 1);
      }),
      next: {
        name: 'B',
        fn: jest.fn((scope: PipelineScope) => {
          calls.push('B');
          scope.setObject('b', 2);
        }),
      },
    };

    const p = new Pipeline(root, new Map(), scopeFactory);
    await p.execute();

    expect(calls).toEqual(['A', 'B']);
    const tree = p.getContextTree();
    // @ts-ignore (shape depends on your context impl)
    expect(tree.globalContext?.a).toBe(1);
    // @ts-ignore
    expect(tree.globalContext?.b).toBe(2);
  });

  it('honors breakFn with embedded fn', async () => {
    const calls: string[] = [];
    const root: StageNode<any, PipelineScope> = {
      name: 'A',
      fn: jest.fn((_s: PipelineScope, breakFn: () => void) => {
        calls.push('A');
        breakFn();
      }),
      next: {
        name: 'B',
        fn: jest.fn(() => {
          calls.push('B'); // should NOT be called
        }),
      },
    };
    const p = new Pipeline(root, new Map(), scopeFactory);
    await p.execute();
    expect(calls).toEqual(['A']);
  });

  it('aggregates results from parallel children (embedded fns)', async () => {
    const root: StageNode<any, PipelineScope> = {
      name: 'PARENT',
      children: [
        { id: 'x', name: 'X', fn: jest.fn(() => 10) },
        { id: 'y', name: 'Y', fn: jest.fn(() => 20) },
      ],
    };
    const p = new Pipeline(root, new Map(), scopeFactory);
    const out = await p.execute();
    // fan-in shape: { x:{result,isError}, y:{result,isError} }
    // @ts-ignore
    expect(out.x.result).toBe(10);
    // @ts-ignore
    expect(out.y.result).toBe(20);
  });

  it('decider picks the correct child (embedded fns)', async () => {
    const root: StageNode<any, PipelineScope> = {
      name: 'DECIDE',
      fn: jest.fn(() => 'goRight'),
      children: [
        { id: 'goLeft', name: 'LEFT', fn: jest.fn(() => 'L') },
        { id: 'goRight', name: 'RIGHT', fn: jest.fn(() => 'R') },
      ],
      nextNodeDecider: (stageOutput) => stageOutput as string, // must return child *id*
    };
    const p = new Pipeline(root, new Map(), scopeFactory);
    const out = await p.execute();
    expect(out).toBe('R');
    expect((root.children![0].fn as jest.Mock).mock.calls.length).toBe(0); // LEFT not executed
  });

  it('supports mixed mode (embedded fn + stageMap)', async () => {
    const map = new Map<string, PipelineStageFunction<any, PipelineScope>>();
    map.set(
      'B',
      jest.fn(() => 42),
    );

    const root: StageNode<any, PipelineScope> = {
      name: 'A',
      fn: jest.fn(() => 'ok'),
      next: { name: 'B' }, // resolved via map
    };
    const p = new Pipeline(root, map, scopeFactory);
    const out = await p.execute();
    expect(out).toBe(42);
    expect((root.fn as jest.Mock).mock.calls.length).toBe(1);
    expect((map.get('B') as jest.Mock).mock.calls.length).toBe(1);
  });

  it('throws when node has neither fn nor map entry nor children/decider', async () => {
    const bad: StageNode<any, PipelineScope> = { name: 'EMPTY' };
    const p = new Pipeline(bad, new Map(), scopeFactory);
    await expect(p.execute()).rejects.toThrow(
      /must define: embedded fn OR a stageMap entry OR have children\/decider/i,
    );
  });

  /**
   * NEW (for unified order): When a node has children *and* next (fork+next),
   * the engine now runs: stage → children (parallel) → next.
   * We assert: 'parent' appears before any 'child*', and 'next' is last.
   */
  it('fork+next (embedded fns) runs parent BEFORE children and children BEFORE next', async () => {
    const calls: string[] = [];

    const root: StageNode<any, PipelineScope> = {
      name: 'PARENT',
      fn: jest.fn(() => {
        calls.push('parent');
      }),
      children: [
        {
          id: 'x',
          name: 'X',
          fn: jest.fn(() => {
            calls.push('childX');
          }),
        },
        {
          id: 'y',
          name: 'Y',
          fn: jest.fn(() => {
            calls.push('childY');
          }),
        },
      ],
      next: {
        name: 'NEXT',
        fn: jest.fn(() => {
          calls.push('next');
        }),
      },
    };

    const p = new Pipeline(root, new Map(), scopeFactory);
    await p.execute();

    // parent must be first
    expect(calls[0]).toBe('parent');
    // next must be last
    expect(calls[calls.length - 1]).toBe('next');

    // children can run in any order, but both must have run between parent and next
    const iParent = calls.indexOf('parent');
    const iNext = calls.indexOf('next');
    const iChildX = calls.indexOf('childX');
    const iChildY = calls.indexOf('childY');

    expect(iChildX).toBeGreaterThan(iParent);
    expect(iChildY).toBeGreaterThan(iParent);
    expect(iChildX).toBeLessThan(iNext);
    expect(iChildY).toBeLessThan(iNext);
  });
});
