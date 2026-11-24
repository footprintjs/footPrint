import { describe, expect, it, vi } from 'vitest';

import { describeChart, flowChart, listMounts } from '../../../../src/index';

const noop = () => {};

describe('describeChart', () => {
  it('renders declared stage details, decisions, and loop edges without calling stage functions', () => {
    const run = vi.fn();
    const decide = vi.fn(() => 'try-again');
    const chart = flowChart<{ count: number }>('Receive Order', run, 'receive', {
      description: 'Accepts an order.',
    })
      .addFunction('Get Quote', run, 'quote', 'Quotes the order.')
      .tag('pricing', ' reviewed ')
      .retry({ attempts: 3, timeoutMs: 120 })
      .addDeciderFunction('Route Order', decide, 'route', 'Selects the next step.')
      .addFunctionBranch('try-again', 'Try Again', run, undefined, { loopTo: 'quote' })
      .addFunctionBranch('accept', 'Accept', run, 'Accepts the quote.')
      .end()
      .addFunction('Finish', run, 'finish')
      .build();

    const spec = chart.buildTimeStructure;
    const quote = spec.next;
    if (!quote) throw new Error('Expected the quote stage');
    const documented = {
      ...chart,
      buildTimeStructure: { ...spec, next: { ...quote, outsideInputs: ['clock', 'rates.read'] } },
    };
    const readme = describeChart(documented);
    expect(readme).toBe(describeChart(documented));
    expect(readme).toContain('```mermaid\n' + chart.toMermaid() + '\n```');
    expect(readme.split('## Stages\n\n')[1].split('\n\n')[0].split('\n')).toEqual([
      '- **Receive Order** (`receive`, stage) — Accepts an order.',
      '- **Get Quote** (`quote`, stage) — Quotes the order. Tags `pricing`, `" reviewed "`. Outside inputs `clock`, `rates.read`. Retry policy allows 3 total attempts. Timeout 120 ms per attempt.',
      '- **Route Order** (`route`, decision) — Selects the next step.',
      '- **Try Again** (`try-again`, stage) — No description.',
      '- **Accept** (`accept`, stage) — Accepts the quote.',
      '- **Finish** (`finish`, stage) — No description.',
    ]);
    expect(readme).toContain('## Loops\n\n- `try-again` → `quote`\n');
    expect(readme.match(/Quotes the order\./g)).toHaveLength(1);
    expect(run).not.toHaveBeenCalled();
    expect(decide).not.toHaveBeenCalled();
  });

  it('keeps repeated stage placements and Markdown text readable', () => {
    const chart = flowChart('A ``` [literal]', noop, 'a')
      .addFunction('First', noop, 'repeat', 'First <token> & quote.\nSecond line.')
      .addFunction('Second', noop, 'repeat', 'Second placement.')
      .build();
    chart.description = 'A separately supplied description.';

    const readme = describeChart(chart);
    expect(readme).toContain('# A \\`\\`\\` \\[literal\\]\n\nA separately supplied description.');
    expect(readme).toContain('````mermaid\n' + chart.toMermaid() + '\n````');
    expect(readme).toContain('- **First** (`repeat`, stage) — First &lt;token&gt; &amp; quote. Second line.');
    expect(readme).toContain('- **Second** (`repeat`, stage) — Second placement.');
  });
});

describe('listMounts', () => {
  it('lists nested static placements in order and leaves runtime branches unresolved', () => {
    const leaf = flowChart('Check', noop, 'check', { description: 'Checks a quote.' }).build();
    const lazy = vi.fn(() => leaf);
    const items = vi.fn(() => [1]);
    const branch = vi.fn(() => leaf);
    const child = flowChart('Child Entry', noop, 'entry', { description: 'Handles audit.' })
      .addSubFlowChartNext('nested', leaf, 'Quote Check')
      .build();
    const chart = flowChart('Start', noop, 'start')
      .addSubFlowChartNext('first', child, 'First Audit')
      .addSubFlowChartNext('second', child, 'Second Audit')
      .addLazySubFlowChartNext('lazy', lazy, 'Load Workflow')
      .addParallelForEach('Process Items', 'each', { items, branch, into: 'results', maxBranches: 1 })
      .build();

    const originalSpec = JSON.stringify(chart.buildTimeStructure);
    expect(listMounts(chart)).toEqual([
      {
        subflowId: 'first',
        subflowName: 'First Audit',
        subflowPath: 'first',
        isLazy: false,
        entryStageId: 'entry',
        description: 'Handles audit.',
      },
      {
        subflowId: 'nested',
        subflowName: 'Quote Check',
        subflowPath: 'first/nested',
        isLazy: false,
        entryStageId: 'check',
        description: 'Checks a quote.',
      },
      {
        subflowId: 'second',
        subflowName: 'Second Audit',
        subflowPath: 'second',
        isLazy: false,
        entryStageId: 'entry',
        description: 'Handles audit.',
      },
      {
        subflowId: 'nested',
        subflowName: 'Quote Check',
        subflowPath: 'second/nested',
        isLazy: false,
        entryStageId: 'check',
        description: 'Checks a quote.',
      },
      { subflowId: 'lazy', subflowName: 'Load Workflow', subflowPath: 'lazy', isLazy: true },
    ]);
    const readme = describeChart(chart);
    expect(readme).toContain('- **First Audit** (`first`, eager, entry `entry`) — Handles audit.');
    expect(readme).toContain('- **Load Workflow** (`lazy`, lazy)');
    expect(readme).toContain('- **Process Items** (`each`, parallelForEach)');
    expect(readme).not.toContain('Quote Check');
    expect(lazy).not.toHaveBeenCalled();
    expect(items).not.toHaveBeenCalled();
    expect(branch).not.toHaveBeenCalled();
    expect(JSON.stringify(chart.buildTimeStructure)).toBe(originalSpec);
  });

  it('omits synthetic default aliases and terminates on cycles in the exposed spec', () => {
    const child = flowChart('Child', noop, 'child').build();
    const chart = flowChart('Start', noop, 'start')
      .addDeciderFunction('Route', () => 'default', 'route')
      .addSubFlowChartBranch('default', child, 'Audit')
      .setDefault('default')
      .end()
      .build();
    const route = chart.buildTimeStructure.next;
    const mount = route?.children?.[0];
    if (!route || !mount) throw new Error('Expected a declared branch mount');
    mount.subflowStructure = chart.buildTimeStructure;
    route.next = route;

    expect(listMounts(chart).map(({ subflowPath }) => subflowPath)).toEqual(['default']);
    expect(describeChart(chart).match(/\*\*Audit\*\*/g)).toHaveLength(1);
  });

  it('retains two placements of one mount ID', () => {
    const child = flowChart('Child', noop, 'child').build();
    const chart = flowChart('Start', noop, 'start')
      .addSubFlowChartNext('audit', child, 'First Audit')
      .addSubFlowChartNext('audit', child, 'Second Audit')
      .build();

    expect(listMounts(chart).map(({ subflowPath, subflowName }) => [subflowPath, subflowName])).toEqual([
      ['audit', 'First Audit'],
      ['audit', 'Second Audit'],
    ]);
  });
});
