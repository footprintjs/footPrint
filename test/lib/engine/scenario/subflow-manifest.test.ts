/**
 * Scenario: Subflow manifest collection during traversal.
 *
 * Verifies that ManifestFlowRecorder builds a correct manifest tree
 * when attached to a real FlowChartExecutor executing subflows.
 * Also verifies that StageSnapshot includes description and subflowId.
 */

import type { ScopeFacade } from '../../../../src';
import { FlowChartBuilder, FlowChartExecutor, ManifestFlowRecorder } from '../../../../src';

const noop = async () => {};

describe('Scenario: Subflow manifest collection', () => {
  it('collects manifest entries for build-time subflows', async () => {
    const subChart = new FlowChartBuilder()
      .start('SubEntry', noop, 'sub-entry', 'Subflow entry point')
      .addFunction('SubProcess', noop, 'sub-process', 'Process inside subflow')
      .build();

    const chart = new FlowChartBuilder()
      .start('Main', noop, 'main', 'Main entry')
      .addSubFlowChartNext('sf-sub', subChart, 'MySubflow')
      .build();

    const executor = new FlowChartExecutor(chart);
    const manifest = new ManifestFlowRecorder();
    executor.attachFlowRecorder(manifest);

    await executor.run();

    const entries = manifest.getManifest();
    expect(entries).toHaveLength(1);
    expect(entries[0].subflowId).toBe('sf-sub');
    expect(entries[0].name).toBe('MySubflow');
    expect(entries[0].children).toEqual([]);
  });

  it('collects nested manifest for subflow within decider branch', async () => {
    const innerSub = new FlowChartBuilder().start('InnerEntry', noop, 'inner-entry', 'Inner subflow start').build();

    const outerSub = new FlowChartBuilder()
      .start('OuterEntry', noop, 'outer-entry', 'Outer subflow start')
      .addSubFlowChartNext('sf-inner', innerSub, 'InnerFlow')
      .build();

    const chart = new FlowChartBuilder()
      .start('Root', noop, 'root', 'Root stage')
      .addDeciderFunction('Router', async () => 'go', 'router', 'Route to subflow')
      .addSubFlowChartBranch('go', outerSub, 'OuterFlow')
      .end()
      .build();

    const executor = new FlowChartExecutor(chart);
    const manifest = new ManifestFlowRecorder();
    executor.attachFlowRecorder(manifest);

    await executor.run();

    const entries = manifest.getManifest();
    expect(entries.length).toBeGreaterThanOrEqual(1);

    // Find the outer subflow and verify nested structure
    const outer = entries.find((e) => e.name === 'OuterFlow');
    expect(outer).toBeDefined();
    expect(outer!.subflowId).toBe('go');

    // Verify the nested inner subflow appears as a child
    const inner = outer!.children.find((e) => e.name === 'InnerFlow');
    expect(inner).toBeDefined();
    expect(inner!.subflowId).toBe('go/sf-inner');
  });

  it('StageSnapshot includes description from builder', async () => {
    const chart = new FlowChartBuilder()
      .start('Receive', noop, 'receive', 'Receive and validate input')
      .addFunction('Process', noop, 'process', 'Process the data')
      .build();

    const executor = new FlowChartExecutor(chart);
    await executor.run();

    const snapshot = executor.getSnapshot();
    const tree = snapshot.executionTree;

    expect(tree.description).toBe('Receive and validate input');
    expect(tree.next?.description).toBe('Process the data');
  });

  it('StageSnapshot includes subflowId for subflow entry points', async () => {
    const subChart = new FlowChartBuilder().start('SubStage', noop, 'sub-stage', 'Subflow stage').build();

    const chart = new FlowChartBuilder()
      .start('Main', noop, 'main')
      .addSubFlowChartNext('sf-test', subChart, 'TestSub')
      .build();

    const executor = new FlowChartExecutor(chart);
    await executor.run();

    const snapshot = executor.getSnapshot();
    // The subflow entry point should have subflowId
    const subflowNode = snapshot.executionTree.next;
    expect(subflowNode?.subflowId).toBe('sf-test');
  });

  it('executor convenience methods work with ManifestFlowRecorder', async () => {
    const subChart = new FlowChartBuilder().start('Sub', noop, 'sub').build();

    const chart = new FlowChartBuilder()
      .start('Main', noop, 'main')
      .addSubFlowChartNext('sf-1', subChart, 'SubA')
      .build();

    const executor = new FlowChartExecutor(chart);
    const manifest = new ManifestFlowRecorder();
    executor.attachFlowRecorder(manifest);

    await executor.run();

    // Convenience methods on executor
    const entries = executor.getSubflowManifest();
    expect(entries.length).toBeGreaterThanOrEqual(1);
  });

  it('returns empty manifest when no ManifestFlowRecorder attached', async () => {
    const chart = new FlowChartBuilder().start('Main', noop, 'main').build();

    const executor = new FlowChartExecutor(chart);
    await executor.run();

    expect(executor.getSubflowManifest()).toEqual([]);
    expect(executor.getSubflowSpec('any')).toBeUndefined();
  });
});
