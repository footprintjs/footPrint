import type { ControlDependency } from 'foottrace';
import { causalChain, formatCausalChain, keysReadFromExecutionTree } from 'foottrace';
import { memorySink } from 'foottrace/write';
import { expect, it } from 'vitest';

import { decide, flowChart, FlowChartExecutor } from '../../../src/index.js';
import { controlDepRecorder, readStoredCapture } from '../../../src/trace.js';

it('replays the selected failed invocation back through the recorded comparison and source, without model calls', async () => {
  const adapter = memorySink();
  const original = new Error('no rate');
  const chart = flowChart<{ rateCount: number }>(
    'Load rates',
    (s) => {
      s.rateCount = 0;
    },
    'load',
  )
    .addDeciderFunction(
      'Rates found?',
      (s) => decide(s, [{ when: { rateCount: { gt: 0 } }, then: 'yes', label: 'At least one rate' }], 'no'),
      'found',
    )
    .addFunctionBranch('yes', 'Use rate', () => undefined)
    .addFunctionBranch('no', 'Reject order', () => {
      throw original;
    })
    .end()
    .setLogger({ info() {}, log() {}, debug() {}, warn() {}, error() {} })
    .build();
  const ex = new FlowChartExecutor(chart, {
    captureCoverage: true,
    captureExtent: true,
    captureClosure: true,
    readSources: true,
    writeProvenance: 'reads-prefix',
    sink: { adapter, capture: { acknowledge: async (t) => ({ ...t, durability: 'durable' }) } },
  });
  const control = controlDepRecorder({ captureCoverage: true });
  ex.attachFlowRecorder(control);
  await expect(ex.run()).rejects.toBe(original);
  const cut = ex.getClosedCapture();
  expect(cut.status).toBe('closed');
  if (cut.status !== 'closed') throw new Error('expected a supported native prefix');
  const reopened = await readStoredCapture(JSON.parse(JSON.stringify(adapter.entries)), {
    runId: cut.record.closure.runId,
  });
  expect(reopened.status).toBe('acknowledged');
  const history = reopened.history!;
  expect(history.closure).toEqual(cut.record.closure);
  const id = history.closure!.selectedFailure!.runtimeStageId;
  expect(id).toMatch(/^no#/);
  const bundle = history.recorders!.find((r) => r.name === 'control-dependencies')!;
  const data = bundle.data as { decisions: { evidence?: unknown }[]; controlDeps: Record<string, ControlDependency> };
  const reads = keysReadFromExecutionTree(history.executionTree);
  const chain = causalChain([...history.commitLog], id, reads.lookup, { controlDeps: (key) => data.controlDeps[key] });
  expect(chain).toBeDefined();
  if (!chain) throw new Error('recorded control/data path missing');
  const text = formatCausalChain(chain);
  expect(text).toContain('Reject order');
  expect(text).toContain('Rates found?');
  expect(text).toContain('Load rates');
  expect(text).toContain('[control]');
  expect(text).toContain('rateCount');
  expect(JSON.stringify(data.decisions)).toContain('"op":"gt"');
  expect(JSON.stringify(data.decisions)).toContain('"result":false');
  const first = JSON.stringify(history);
  control.clear();
  expect(JSON.stringify(history)).toBe(first);
  // This is a recorded context path, not proof that zero rates was an infrastructure defect.
  expect(history.capture.boundary.status).toBe('failed');
});
