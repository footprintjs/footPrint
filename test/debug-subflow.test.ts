import { FlowChartBuilder } from '../src/builder/FlowChartBuilder';

describe('Debug Subflow Structure', () => {
  it('should show the structure of reference-based subflows', () => {
    const subflow = new FlowChartBuilder()
      .start('subEntry', () => 'sub-output')
      .build();

    console.log('Subflow root:', JSON.stringify(subflow.root, (k, v) => typeof v === 'function' ? '[Function]' : v, 2));
    console.log('Subflow subflows:', subflow.subflows);

    const chart = new FlowChartBuilder()
      .start('entry', () => 'output')
      .addSubFlowChart('sub', subflow, 'Subflow')
      .build();

    console.log('\nMain chart root:', JSON.stringify(chart.root, (k, v) => typeof v === 'function' ? '[Function]' : v, 2));
    console.log('\nMain chart subflows:', JSON.stringify(chart.subflows, (k, v) => typeof v === 'function' ? '[Function]' : v, 2));

    // Check the reference node
    const refNode = chart.root.children?.[0];
    console.log('\nReference node:', JSON.stringify(refNode, (k, v) => typeof v === 'function' ? '[Function]' : v, 2));
    
    expect(true).toBe(true);
  });
});
