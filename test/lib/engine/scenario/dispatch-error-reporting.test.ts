/**
 * A decider or selector whose answer names no branch is a failed stage, and is
 * reported like one: `onError` for the stage, then the run rejects.
 *
 * Before the fix a decider that returned an unknown branch with no default,
 * and a selector that returned unknown ids, rejected `run()` with no `onError`
 * — only `onRunFailed` fired, unlike every other thrown stage error.
 */
import { describe, expect, it } from 'vitest';

import type { FlowChart } from '../../../../src/index';
import { flowChart, FlowChartExecutor } from '../../../../src/index';

async function events(chart: FlowChart): Promise<{ events: string[]; message?: string }> {
  const executor = new FlowChartExecutor(chart);
  const seen: string[] = [];
  executor.attachFlowRecorder({
    id: 'errors',
    onError: (e) => seen.push(`onError:${e.stageName}:${e.message}`),
    onRunFailed: () => seen.push('onRunFailed'),
  });
  let message: string | undefined;
  try {
    await executor.run();
  } catch (error) {
    message = (error as Error).message;
  }
  return { events: seen, message };
}

const silent = { info() {}, log() {}, debug() {}, error() {}, warn() {} };

describe('a decider or selector that names no branch reports onError', () => {
  it('a decider with no matching branch and no default', async () => {
    const chart = flowChart<any>('Start', () => {}, 'start')
      .setLogger(silent)
      .addDeciderFunction('Route', () => 'zzz', 'route')
      .addFunctionBranch('a', 'A', () => {})
      .end()
      .build();
    const { events: seen, message } = await events(chart);

    expect(message).toMatch(/returned branch ID 'zzz' which doesn't match any child/);
    expect(seen).toEqual([`onError:Route:Error: ${message}`, 'onRunFailed']);
  });

  it('a selector that returns an unknown id', async () => {
    const chart = flowChart<any>('Start', () => {}, 'start')
      .setLogger(silent)
      .addSelectorFunction('Pick', () => ['zzz'], 'pick')
      .addFunctionBranch('a', 'A', () => {})
      .end()
      .build();
    const { events: seen, message } = await events(chart);

    expect(message).toMatch(/returned unknown child IDs: zzz/);
    expect(seen).toEqual([`onError:Pick:Error: ${message}`, 'onRunFailed']);
  });
});
